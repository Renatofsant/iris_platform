"""
Conexão com o Supabase (cliente oficial `supabase-py`) e autenticação pelo Supabase Auth.

Variáveis de ambiente (carregadas do .env por app/__init__.py):
    SUPABASE_URL        https://<ref>.supabase.co
    SUPABASE_KEY        chave publicável (sb_publishable_… ou a JWT "anon") — recomendada
                        Também aceitas, nesta ordem, se SUPABASE_KEY não existir:
                        SUPABASE_PUBLISHABLE_KEY, SUPABASE_ANON_KEY, SUPABASE_SECRET_KEY,
                        SUPABASE_SERVICE_ROLE_KEY (as duas últimas ignoram a RLS: evite no app).
    IRIS_AUTH           "supabase" (padrão quando as duas acima existem) ou "local" (SQLite)

Por que um cliente POR REQUISIÇÃO: o cliente guarda a sessão (tokens) do usuário que acabou de
entrar. Um cliente global compartilhado entre threads misturaria sessões de professores
diferentes. `persist_session=False` impede que os tokens fiquem gravados em algum lugar.

A sessão da plataforma continua sendo a do Flask-Login: depois que o Supabase confirma e-mail e
senha, o professor é espelhado na tabela local `usuarios` (coluna supabase_uid), e os demais
dados (alunos, materiais, métricas) seguem ligados ao id local — nada muda para o resto do app.

Redefinição de senha: o e-mail do Supabase leva a /redefinir-senha/nova com os tokens no
fragmento da URL (#access_token=…&type=recovery, fluxo "implicit"). O fragmento não chega ao
servidor: um script da página o copia para o formulário, que é enviado junto com a nova senha.
Se o modelo de e-mail for trocado para usar {{ .TokenHash }}, a página também aceita
?token_hash=…&type=recovery.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


class SupabaseIndisponivelError(RuntimeError):
    """Supabase não configurado, fora do ar ou inacessível."""


class AutenticacaoError(ValueError):
    def __init__(self, mensagem: str, campo: str | None = None):
        super().__init__(mensagem)
        self.mensagem = mensagem
        self.campo = campo


@dataclass(frozen=True)
class UsuarioSupabase:
    uid: str
    email: str
    nome: str


NOMES_CHAVE = (
    "SUPABASE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY",
    "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY",
)
_ASPAS = "\"' "


def _credenciais() -> tuple[str, str, str]:
    """(url, chave, nome da variável de onde a chave veio). Aspas e espaços extras são removidos."""
    url = os.getenv("SUPABASE_URL", "").strip(_ASPAS).rstrip("/")
    for nome in NOMES_CHAVE:
        chave = os.getenv(nome, "").strip(_ASPAS)
        if chave:
            return url, chave, nome
    return url, "", ""


def tipo_chave(chave: str) -> str:
    """publicavel | secreta | anon (JWT) | service_role (JWT) | desconhecida — nunca devolve a chave."""
    if chave.startswith("sb_publishable_"):
        return "publicavel"
    if chave.startswith("sb_secret_"):
        return "secreta"
    partes = chave.split(".")
    if len(partes) == 3:  # chaves antigas: JWT com o papel no payload
        try:
            carga = json.loads(base64.urlsafe_b64decode(partes[1] + "=" * (-len(partes[1]) % 4)))
            return {"anon": "anon", "service_role": "service_role"}.get(carga.get("role"), "desconhecida")
        except ValueError:
            pass
    return "desconhecida"


def configurado() -> bool:
    url, chave, _ = _credenciais()
    return bool(url and chave)


def auth_supabase_ativo() -> bool:
    """Supabase Auth em uso? IRIS_AUTH=local força o login pelo SQLite (testes, uso sem rede)."""
    modo = os.getenv("IRIS_AUTH", "").strip().lower()
    if modo == "local":
        return False
    if modo == "supabase" and not configurado():
        raise SupabaseIndisponivelError("IRIS_AUTH=supabase, mas SUPABASE_URL/SUPABASE_KEY não estão definidas.")
    return configurado()


def novo_cliente():
    """Cliente oficial do Supabase, isolado para esta requisição."""
    if not configurado():
        raise SupabaseIndisponivelError("Defina SUPABASE_URL e SUPABASE_KEY no .env.")
    from supabase import ClientOptions, create_client

    url, chave, _ = _credenciais()
    return create_client(
        url,
        chave,
        options=ClientOptions(
            auto_refresh_token=False,
            persist_session=False,
            flow_type="implicit",  # links de e-mail com tokens no fragmento (ver docstring)
            postgrest_client_timeout=15,
        ),
    )


def _usuario(user) -> UsuarioSupabase:
    metadados = getattr(user, "user_metadata", None) or {}
    email = (user.email or "").strip().lower()
    return UsuarioSupabase(uid=str(user.id), email=email, nome=str(metadados.get("nome") or email.split("@")[0]))


def _registrar_erro(operacao: str, exc: Exception) -> None:
    """Log detalhado no terminal (a tela mostra só a mensagem amigável). Nunca registra senha nem chave."""
    url, chave, nome_chave = _credenciais()
    causa = exc.__cause__ or exc.__context__
    detalhes = {
        "operacao": operacao,
        "erro": type(exc).__name__,
        "mensagem": str(exc)[:500],
        "status_http": getattr(exc, "status", None),
        "codigo_supabase": getattr(exc, "code", None),
        "host": urlparse(url).hostname,
        "chave": f"{nome_chave} ({tipo_chave(chave)})",
        "causa": f"{type(causa).__name__}: {causa}"[:300] if causa is not None else None,
    }
    texto = f"{exc} {causa or ''}"
    if "getaddrinfo" in texto or "Name or service not known" in texto or "nodename nor servname" in texto:
        detalhes["dica"] = "O endereço SUPABASE_URL não existe (DNS). Copie a Project URL em Project Settings → API."
    elif getattr(exc, "status", None) == 401 or "Invalid API key" in texto:
        detalhes["dica"] = "Chave recusada: confira SUPABASE_KEY e se ela é do MESMO projeto da URL."
    elif "timed out" in texto.lower():
        detalhes["dica"] = "Tempo esgotado: projeto pausado (plano gratuito) ou rede bloqueando *.supabase.co."
    logger.error("Supabase falhou: %s", json.dumps(detalhes, ensure_ascii=False, default=str))


def _traduzir(exc: Exception, operacao: str = "auth") -> Exception:
    """Erros do Supabase Auth → mensagens para o professor (sem revelar se o e-mail existe)."""
    from supabase_auth.errors import AuthApiError, AuthRetryableError, AuthWeakPasswordError

    _registrar_erro(operacao, exc)

    if isinstance(exc, AuthWeakPasswordError):
        return AutenticacaoError("Senha fraca: use uma senha mais longa, misturando letras e números.", "senha")
    if isinstance(exc, AuthRetryableError):
        return SupabaseIndisponivelError("Serviço de autenticação indisponível. Tente em instantes.")
    if isinstance(exc, AuthApiError):
        codigo = getattr(exc, "code", "") or ""
        mensagens = {
            "invalid_credentials": ("E-mail ou senha incorretos.", None),
            "email_not_confirmed": ("Confirme seu e-mail pelo link que enviamos antes de entrar.", None),
            "user_already_exists": ("Já existe uma conta com este e-mail.", "email"),
            "email_exists": ("Já existe uma conta com este e-mail.", "email"),
            "weak_password": ("Senha fraca: use uma senha mais longa, misturando letras e números.", "senha"),
            "same_password": ("A nova senha deve ser diferente da anterior.", "senha"),
            "over_email_send_rate_limit": ("Muitos e-mails enviados. Aguarde alguns minutos.", None),
            "over_request_rate_limit": ("Muitas tentativas. Aguarde alguns minutos.", None),
            "otp_expired": ("O link expirou ou já foi usado. Peça um novo.", None),
            "bad_jwt": ("O link expirou ou já foi usado. Peça um novo.", None),
            "session_not_found": ("O link expirou ou já foi usado. Peça um novo.", None),
            "signup_disabled": ("Novos cadastros estão desativados.", None),
        }
        if codigo in mensagens:
            return AutenticacaoError(*mensagens[codigo])
        return AutenticacaoError(f"Não foi possível concluir a operação ({codigo or 'erro do Supabase'}). Tente novamente.")
    return SupabaseIndisponivelError("Serviço de autenticação indisponível. Tente em instantes.")


# ---------------------------------------------------------------------------
# Operações de autenticação
# ---------------------------------------------------------------------------

def entrar(email: str, senha: str) -> UsuarioSupabase:
    try:
        resposta = novo_cliente().auth.sign_in_with_password({"email": email, "password": senha})
    except SupabaseIndisponivelError:
        raise
    except Exception as exc:
        raise _traduzir(exc, "login") from None
    if resposta.user is None:
        raise AutenticacaoError("E-mail ou senha incorretos.")
    return _usuario(resposta.user)


def cadastrar(nome: str, email: str, senha: str, url_confirmacao: str) -> tuple[UsuarioSupabase, bool]:
    """
    Cria a conta no Supabase Auth; o nome vai em user_metadata (o gatilho do schema cria o perfil).
    Retorna (usuário, sessao_ativa). sessao_ativa=False: o projeto exige confirmação por e-mail.
    """
    try:
        resposta = novo_cliente().auth.sign_up({
            "email": email,
            "password": senha,
            "options": {"data": {"nome": nome}, "email_redirect_to": url_confirmacao},
        })
    except SupabaseIndisponivelError:
        raise
    except Exception as exc:
        raise _traduzir(exc, "cadastro") from None
    if resposta.user is None:
        raise AutenticacaoError("Não foi possível criar a conta. Tente novamente.")
    # Com confirmação de e-mail ligada, um e-mail já cadastrado devolve um usuário "falso" sem identidades.
    if resposta.session is None and not (getattr(resposta.user, "identities", None) or []):
        raise AutenticacaoError("Já existe uma conta com este e-mail.", "email")
    return _usuario(resposta.user), resposta.session is not None


def enviar_redefinicao(email: str, url_retorno: str) -> None:
    """Sempre "funciona" para quem chama: não revela se o e-mail tem conta."""
    try:
        novo_cliente().auth.reset_password_for_email(email, {"redirect_to": url_retorno})
    except SupabaseIndisponivelError:
        raise
    except Exception as exc:
        erro = _traduzir(exc, "pedido de redefinição de senha")
        if isinstance(erro, SupabaseIndisponivelError) or "Muitos" in getattr(erro, "mensagem", ""):
            raise erro from None
        logger.info("Redefinição de senha não enviada para %s: %s", email, exc)


def redefinir_senha(
    nova_senha: str,
    *,
    access_token: str = "",
    refresh_token: str = "",
    token_hash: str = "",
) -> UsuarioSupabase:
    """Troca a senha usando a sessão de recuperação vinda do link do e-mail."""
    cliente = novo_cliente()
    try:
        if token_hash:
            cliente.auth.verify_otp({"token_hash": token_hash, "type": "recovery"})
        elif access_token and refresh_token:
            cliente.auth.set_session(access_token, refresh_token)
        else:
            raise AutenticacaoError("Link de redefinição inválido. Peça um novo.")
        resposta = cliente.auth.update_user({"password": nova_senha})
    except (AutenticacaoError, SupabaseIndisponivelError):
        raise
    except Exception as exc:
        raise _traduzir(exc, "nova senha") from None
    finally:
        try:
            cliente.auth.sign_out()  # encerra a sessão de recuperação no Supabase
        except Exception:
            pass
    return _usuario(resposta.user)


def verificar_conexao() -> dict[str, object]:
    """Diagnóstico usado por scripts/setup_supabase.py: o Auth responde? As tabelas existem?"""
    cliente = novo_cliente()
    resultado: dict[str, object] = {}
    for tabela in ("usuarios", "relatorios_aee", "eventos_acessibilidade"):
        try:
            cliente.table(tabela).select("*", count="exact", head=True).limit(1).execute()
            resultado[tabela] = "ok"
        except Exception as exc:
            codigo = getattr(exc, "code", "") or ""
            # 42501 = sem permissão para o papel anônimo: a tabela existe e está protegida (esperado).
            # PGRST205 = tabela inexistente (esquema não aplicado).
            resultado[tabela] = "ok" if codigo == "42501" else f"erro: {codigo or exc}"
    return resultado


def diagnosticar() -> list[tuple[str, bool, str]]:
    """
    Checagem passo a passo da configuração: [(etapa, ok, detalhe)]. Usada por
    `flask --app run iris supabase-diagnostico`, scripts/setup_supabase.py e na inicialização do app.
    """
    import httpx

    url, chave, nome_chave = _credenciais()
    if not url or not chave:
        return [("variáveis no .env", False, "defina SUPABASE_URL e SUPABASE_KEY")]
    etapas: list[tuple[str, bool, str]] = [("chave lida", True, f"{nome_chave} — tipo {tipo_chave(chave)}")]
    if tipo_chave(chave) in ("secreta", "service_role"):
        etapas.append(("tipo de chave", False,
                       "chave de ADMINISTRADOR no app: funciona para login/cadastro, mas ignora a RLS. "
                       "Prefira a publicável (sb_publishable_…) em SUPABASE_KEY"))

    achado = re.match(r"^https://([a-z0-9]+)\.supabase\.co$", url)
    if not achado:
        etapas.append(("formato da URL", False, f"{url!r} — esperado https://<ref>.supabase.co"))
    else:
        ref = achado.group(1)
        etapas.append(("formato da URL", len(ref) == 20,
                       f"ref {ref!r} com {len(ref)} caracteres" + ("" if len(ref) == 20 else " (os do Supabase têm 20)")))
    host = urlparse(url).hostname or ""
    try:
        etapas.append(("DNS", True, f"{host} → {socket.gethostbyname(host)}"))
    except OSError as exc:
        etapas.append(("DNS", False, f"{host} não existe ({exc}). Copie a Project URL em Project Settings → API"))
        return etapas

    try:
        resposta = httpx.get(f"{url}/auth/v1/settings", headers={"apikey": chave}, timeout=10)
    except httpx.HTTPError as exc:
        etapas.append(("Auth API", False, f"{type(exc).__name__}: {exc}"))
        return etapas
    if resposta.status_code != 200:
        etapas.append(("Auth API + chave", False, f"HTTP {resposta.status_code}: {resposta.text[:200]}"))
        return etapas
    config = resposta.json()
    etapas.append(("Auth API + chave", True, "chave aceita pelo projeto"))
    cadastro_ok = not config.get("disable_signup") and config.get("external", {}).get("email", True)
    etapas.append(("cadastro por e-mail", bool(cadastro_ok),
                   "desativado no painel (Authentication → Sign In / Providers)" if not cadastro_ok else
                   "habilitado" + (" · confirmação automática" if config.get("mailer_autoconfirm")
                                   else " · exige confirmação por e-mail")))
    return etapas

