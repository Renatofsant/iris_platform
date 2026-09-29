"""
Provedores de IA da Plataforma Íris, todos com a mesma interface:

    gerar_json(sistema, texto, esquema, imagem=None) -> (dados: dict, meta: dict)

Qualquer falha vira ErroServicoIA, com código padronizado, para que o AIService possa
tentar o próximo provedor da cadeia (Claude → Gemini → Groq → regras locais).

Variáveis de ambiente:
    ANTHROPIC_API_KEY   Claude (Anthropic) — provedor principal.
    GEMINI_API_KEY      Google Gemini (Google AI Studio; há cota gratuita).
    GROQ_API_KEY        Groq (há cota gratuita).
    IRIS_GEMINI_MODELO  Padrão: gemini-flash-latest (apelido que acompanha o Flash mais recente).
    IRIS_GROQ_MODELO    Padrão: openai/gpt-oss-20b (saída JSON com esquema estrito).
    IRIS_GROQ_MODELO_VISAO  Padrão: qwen/qwen3.6-27b (imagens; modo JSON simples).
Os nomes de modelo de Gemini e Groq mudam com frequência: confira-os nos painéis dos provedores.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

BETA_FALLBACK_SERVIDOR = "server-side-fallback-2026-07-01"


class ErroServicoIA(Exception):
    """Falha ao obter uma resposta válida da IA. Dispara o próximo provedor ou o fallback local."""

    def __init__(self, codigo: str, mensagem_publica: str, retentavel: bool = False):
        super().__init__(f"{codigo}: {mensagem_publica}")
        self.codigo = codigo
        self.mensagem_publica = mensagem_publica
        self.retentavel = retentavel


def _erro_por_status(status: int | None, provedor: str, exc: Exception) -> ErroServicoIA:
    """Mapeamento comum de status HTTP → erro padronizado."""
    logger.warning("Erro %s no provedor %s: %s", status, provedor, exc)
    if status in (401, 403):
        return ErroServicoIA("IA_CONFIGURACAO", "Credenciais da IA inválidas ou sem permissão.")
    if status == 404:
        return ErroServicoIA("IA_MODELO_INDISPONIVEL", "Modelo de IA indisponível.")
    if status == 429:
        return ErroServicoIA("IA_LIMITE_TAXA", "Muitas requisições à IA. Tente novamente em instantes.", True)
    if status is not None and status >= 500:
        return ErroServicoIA("IA_INDISPONIVEL", "O serviço de IA está temporariamente indisponível.", True)
    if status is not None and 400 <= status < 500:
        return ErroServicoIA("IA_REQUISICAO_INVALIDA", "A IA rejeitou a requisição.")
    return ErroServicoIA("IA_ERRO", "Erro inesperado da IA.")


def _json_ou_erro(texto: str | None) -> dict[str, Any]:
    if not texto:
        raise ErroServicoIA("IA_RESPOSTA_INVALIDA", "A IA retornou uma resposta vazia.")
    try:
        dados = json.loads(texto)
    except json.JSONDecodeError as exc:
        raise ErroServicoIA("IA_RESPOSTA_INVALIDA", "A IA retornou uma resposta em formato inválido.") from exc
    if not isinstance(dados, dict):
        raise ErroServicoIA("IA_RESPOSTA_INVALIDA", "A IA retornou uma resposta em formato inválido.")
    return dados


TRUNCADA = ErroServicoIA(
    "IA_RESPOSTA_TRUNCADA",
    "O conteúdo é longo demais para uma única adaptação. Divida-o em partes menores.",
)


# ---------------------------------------------------------------------------
# Claude (Anthropic)
# ---------------------------------------------------------------------------

class ProvedorAnthropic:
    nome = "anthropic"

    def __init__(self, cliente, modelo: str, esforco: str, max_tokens: int, usar_fallback_servidor: bool):
        self._cliente = cliente
        self.modelo = modelo
        self.esforco = esforco
        self.max_tokens = max_tokens
        self.usar_fallback_servidor = usar_fallback_servidor

    def gerar_json(self, sistema, texto, esquema, imagem=None):
        import anthropic

        conteudo: str | list[dict[str, Any]] = texto
        if imagem is not None:
            dados_imagem, tipo_midia = imagem
            conteudo = [
                {"type": "image", "source": {
                    "type": "base64", "media_type": tipo_midia,
                    "data": base64.standard_b64encode(dados_imagem).decode("ascii"),
                }},
                {"type": "text", "text": texto},
            ]
        parametros: dict[str, Any] = {
            "model": self.modelo,
            "max_tokens": self.max_tokens,
            "system": sistema,
            "messages": [{"role": "user", "content": conteudo}],
            "output_config": {"effort": self.esforco, "format": {"type": "json_schema", "schema": esquema}},
        }
        try:
            if self.usar_fallback_servidor:
                # Em caso de recusa, a própria API reexecuta com o modelo recomendado.
                resposta = self._cliente.beta.messages.create(
                    **parametros, betas=[BETA_FALLBACK_SERVIDOR], fallbacks="default"
                )
            else:
                resposta = self._cliente.messages.create(**parametros)
        except anthropic.APIStatusError as exc:
            raise _erro_por_status(exc.status_code, self.nome, exc) from exc
        except anthropic.APITimeoutError as exc:  # subclasse de APIConnectionError
            raise ErroServicoIA("IA_TEMPO_ESGOTADO", "A IA demorou demais para responder.", True) from exc
        except anthropic.APIConnectionError as exc:
            raise ErroServicoIA("IA_CONEXAO", "Não foi possível conectar ao serviço de IA.", True) from exc
        except TypeError as exc:
            # O SDK lança TypeError na requisição quando não há credenciais.
            raise ErroServicoIA("IA_CONFIGURACAO", "O serviço de IA não está configurado no servidor.") from exc
        except Exception as exc:
            logger.exception("Falha inesperada no provedor anthropic")
            raise ErroServicoIA("IA_ERRO", "Erro inesperado da IA.") from exc

        motivo = getattr(resposta, "stop_reason", None)
        if motivo == "refusal":
            raise ErroServicoIA("IA_RECUSA", "A IA não pôde processar este conteúdo.")
        if motivo == "max_tokens":
            raise TRUNCADA
        texto_resposta = next(
            (b.text for b in resposta.content if getattr(b, "type", None) == "text"), None
        )
        uso = getattr(resposta, "usage", None)
        return _json_ou_erro(texto_resposta), {
            "provedor": self.nome,
            "modelo": getattr(resposta, "model", self.modelo),
            "id_mensagem": getattr(resposta, "id", None),
            "tokens_entrada": getattr(uso, "input_tokens", None),
            "tokens_saida": getattr(uso, "output_tokens", None),
        }


# ---------------------------------------------------------------------------
# Google Gemini (Google AI Studio)
# ---------------------------------------------------------------------------

class ProvedorGemini:
    nome = "gemini"

    def __init__(self, api_key: str, modelo: str, max_tokens: int, timeout_s: float):
        from google import genai
        from google.genai import types

        self._types = types
        self._cliente = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=int(timeout_s * 1000)))
        self.modelo = modelo
        self.max_tokens = max_tokens

    def gerar_json(self, sistema, texto, esquema, imagem=None):
        from google.genai import errors

        types = self._types
        partes: list[Any] = []
        if imagem is not None:
            partes.append(types.Part.from_bytes(data=imagem[0], mime_type=imagem[1]))
        partes.append(texto)
        try:
            resposta = self._cliente.models.generate_content(
                model=self.modelo,
                contents=partes,
                config=types.GenerateContentConfig(
                    system_instruction=sistema,
                    response_mime_type="application/json",
                    response_json_schema=esquema,
                    max_output_tokens=self.max_tokens,
                    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                ),
            )
        except errors.APIError as exc:  # ClientError (4xx) e ServerError (5xx)
            if "API_KEY_INVALID" in str(exc):  # o Gemini responde 400 (e não 401) para chave inválida
                raise ErroServicoIA("IA_CONFIGURACAO", "Credenciais da IA inválidas ou sem permissão.") from exc
            raise _erro_por_status(getattr(exc, "code", None), self.nome, exc) from exc
        except Exception as exc:  # rede, timeout do httpx etc.
            logger.warning("Falha de conexão no provedor gemini: %s", exc)
            raise ErroServicoIA("IA_CONEXAO", "Não foi possível conectar ao serviço de IA.", True) from exc

        candidato = (resposta.candidates or [None])[0]
        motivo = getattr(candidato, "finish_reason", None)
        if motivo == types.FinishReason.MAX_TOKENS:
            raise TRUNCADA
        if motivo in (types.FinishReason.SAFETY, types.FinishReason.PROHIBITED_CONTENT):
            raise ErroServicoIA("IA_RECUSA", "A IA não pôde processar este conteúdo.")
        uso = getattr(resposta, "usage_metadata", None)
        return _json_ou_erro(resposta.text), {
            "provedor": self.nome,
            "modelo": getattr(resposta, "model_version", None) or self.modelo,
            "tokens_entrada": getattr(uso, "prompt_token_count", None),
            "tokens_saida": getattr(uso, "candidates_token_count", None),
        }


# ---------------------------------------------------------------------------
# Groq
# ---------------------------------------------------------------------------

class ProvedorGroq:
    nome = "groq"

    def __init__(self, api_key: str, modelo: str, modelo_visao: str, max_tokens: int, timeout_s: float):
        from groq import Groq

        self._cliente = Groq(api_key=api_key, timeout=timeout_s, max_retries=2)
        self.modelo = modelo
        self.modelo_visao = modelo_visao
        self.max_tokens = max_tokens

    def gerar_json(self, sistema, texto, esquema, imagem=None):
        import groq

        if imagem is None:
            modelo = self.modelo
            mensagens = [{"role": "system", "content": sistema}, {"role": "user", "content": texto}]
            formato = {"type": "json_schema", "json_schema": {"name": "resposta_iris", "strict": True, "schema": esquema}}
        else:
            # Modelos de visão do Groq aceitam só o modo JSON simples: o esquema vai nas instruções.
            modelo = self.modelo_visao
            url = f"data:{imagem[1]};base64,{base64.standard_b64encode(imagem[0]).decode('ascii')}"
            instrucoes = (
                f"{sistema}\n\n{texto}\n\nResponda SOMENTE com um objeto JSON válido que siga "
                f"exatamente este JSON Schema:\n{json.dumps(esquema, ensure_ascii=False)}"
            )
            mensagens = [{"role": "user", "content": [
                {"type": "text", "text": instrucoes},
                {"type": "image_url", "image_url": {"url": url}},
            ]}]
            formato = {"type": "json_object"}
        try:
            resposta = self._cliente.chat.completions.create(
                model=modelo, messages=mensagens, response_format=formato,
                max_completion_tokens=self.max_tokens,
            )
        except groq.APIStatusError as exc:
            raise _erro_por_status(exc.status_code, self.nome, exc) from exc
        except groq.APITimeoutError as exc:
            raise ErroServicoIA("IA_TEMPO_ESGOTADO", "A IA demorou demais para responder.", True) from exc
        except groq.APIConnectionError as exc:
            raise ErroServicoIA("IA_CONEXAO", "Não foi possível conectar ao serviço de IA.", True) from exc
        except Exception as exc:
            logger.exception("Falha inesperada no provedor groq")
            raise ErroServicoIA("IA_ERRO", "Erro inesperado da IA.") from exc

        escolha = resposta.choices[0]
        if escolha.finish_reason == "length":
            raise TRUNCADA
        uso = getattr(resposta, "usage", None)
        return _json_ou_erro(escolha.message.content), {
            "provedor": self.nome,
            "modelo": getattr(resposta, "model", modelo),
            "tokens_entrada": getattr(uso, "prompt_tokens", None),
            "tokens_saida": getattr(uso, "completion_tokens", None),
        }
