"""
Exportação e impressão de provas e atividades adaptadas.

Guarda o material adaptado (HTML sanitizado + preferências de impressão) em
SQLite, sob um identificador aleatório, para que a versão de impressão possa ser
aberta em /inclusao/imprimir/<id>, reimpressa ou compartilhada entre professores.

Privacidade (LGPD): o cabeçalho escolar — em especial o nome do aluno — NÃO é
enviado ao servidor. Ele é preenchido na própria página de impressão e trafega
apenas no fragmento da URL (#...), que o navegador não envia na requisição.

Variáveis de ambiente:
    IRIS_DB_PATH                   Caminho do banco SQLite (padrão: instance/iris.db).
    IRIS_IMPRESSAO_RETENCAO_DIAS   Dias até o material expirar (padrão: 30).
"""

from __future__ import annotations

import json
import os
import re
import secrets
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import nh3

from app.db import conectar, migrar

TAMANHO_MAXIMO_HTML = 200_000
TAMANHO_MAXIMO_TITULO = 200
PADRAO_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

FONTE_PT_MIN, FONTE_PT_MAX = 12, 60
FONTE_PT_MAX_DUAS_COLUNAS = 16  # acima disso, duas colunas deixam poucas palavras por linha
CONTRASTES = ("pb-alto", "padrao")
TIPOGRAFIAS = ("padrao", "atkinson", "dyslexic")
ENTRELINHAS = (1.5, 1.8, 2.0)
LINHAS_RESPOSTA_MAX = 30

PREFERENCIAS_PADRAO: dict[str, Any] = {
    "fonte_pt": 14,
    "contraste": "pb-alto",
    "tipografia": "padrao",
    "entrelinhas": 1.5,
    "colunas": 1,
    "linhas_resposta": 0,
    "incluir_guia": 0,  # 1 = acrescenta a página de orientações ao mediador (nunca por padrão)
}

# Somente a estrutura produzida pela tela de adaptação; tudo o mais é descartado.
TAGS_PERMITIDAS = {
    "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "div", "section", "header", "span",
    "ul", "ol", "li", "dl", "dt", "dd", "strong", "b", "em", "i", "u", "sub", "sup",
    "code", "pre", "blockquote", "a", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "caption", "figure", "figcaption", "img",
}
ATRIBUTOS_PERMITIDOS = {
    "*": {"class"},
    "a": {"href"},
    "th": {"colspan", "rowspan", "scope"},
    "td": {"colspan", "rowspan"},
    "ol": {"start"},
    "img": {"src", "alt", "width", "height"},
}
# Imagens: somente pictogramas do ARASAAC (glossário ilustrado do TEA). Qualquer outra origem é removida.
ORIGEM_IMAGENS_PERMITIDA = "https://static.arasaac.org/pictograms/"


def _filtrar_atributo(elemento: str, atributo: str, valor: str) -> str | None:
    if elemento == "img" and atributo == "src" and not valor.startswith(ORIGEM_IMAGENS_PERMITIDA):
        return None
    return valor


class MaterialInvalidoError(ValueError):
    def __init__(self, mensagem: str, campo: str | None = None):
        super().__init__(mensagem)
        self.mensagem = mensagem
        self.campo = campo


@dataclass(frozen=True)
class MaterialImpressao:
    id: str
    professor_id: int
    titulo: str
    perfil_codigo: str
    perfil_nome: str
    conteudo_html: str
    preferencias: dict[str, Any]
    criado_em: datetime
    expira_em: datetime
    guia_mediador: dict[str, Any] | None = None


def sanitizar_html(html: str) -> str:
    return nh3.clean(
        html,
        tags=TAGS_PERMITIDAS,
        attributes=ATRIBUTOS_PERMITIDOS,
        url_schemes={"http", "https", "mailto"},
        link_rel="noopener noreferrer",
        strip_comments=True,
        attribute_filter=_filtrar_atributo,
    )


def normalizar_preferencias(
    bruto: dict[str, Any] | None,
    estrito: bool = True,
    base: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """
    Valida as preferências de impressão.

    estrito=True  → valor inválido lança MaterialInvalidoError (uso na API).
    estrito=False → valor inválido é ignorado e o padrão é mantido (uso em ?query da página).
    base          → preferências de partida (ex.: as salvas com o material); padrão se None.
    Retorna (preferências, avisos).
    """
    bruto = bruto or {}
    prefs = {**PREFERENCIAS_PADRAO, **(base or {})}
    avisos: list[str] = []

    def invalido(campo: str, mensagem: str) -> None:
        if estrito:
            raise MaterialInvalidoError(mensagem, campo=f"preferencias.{campo}")

    def inteiro(valor: Any) -> int | None:
        try:
            numero = float(valor)
        except (TypeError, ValueError):
            return None
        return int(numero) if numero.is_integer() else None

    if "fonte_pt" in bruto:
        fonte = inteiro(bruto["fonte_pt"])
        if fonte is None or not FONTE_PT_MIN <= fonte <= FONTE_PT_MAX:
            invalido("fonte_pt", f"O tamanho da fonte deve ser um número inteiro entre {FONTE_PT_MIN} e {FONTE_PT_MAX} pt.")
        else:
            prefs["fonte_pt"] = fonte

    if "contraste" in bruto:
        if bruto["contraste"] in CONTRASTES:
            prefs["contraste"] = bruto["contraste"]
        else:
            invalido("contraste", f"Contraste inválido. Use: {', '.join(CONTRASTES)}.")

    if "tipografia" in bruto:
        if bruto["tipografia"] in TIPOGRAFIAS:
            prefs["tipografia"] = bruto["tipografia"]
        else:
            invalido("tipografia", f"Tipografia inválida. Use: {', '.join(TIPOGRAFIAS)}.")

    if "entrelinhas" in bruto:
        try:
            entrelinhas = float(bruto["entrelinhas"])
        except (TypeError, ValueError):
            entrelinhas = None
        if entrelinhas in ENTRELINHAS:
            prefs["entrelinhas"] = entrelinhas
        else:
            invalido("entrelinhas", "Entrelinhas inválidas. Use 1.5, 1.8 ou 2.0.")

    if "colunas" in bruto:
        colunas = inteiro(bruto["colunas"])
        if colunas in (1, 2):
            prefs["colunas"] = colunas
        else:
            invalido("colunas", "O layout deve ter 1 ou 2 colunas.")

    if "linhas_resposta" in bruto:
        linhas = inteiro(bruto["linhas_resposta"])
        if linhas is None or not 0 <= linhas <= LINHAS_RESPOSTA_MAX:
            invalido("linhas_resposta", f"Linhas para resposta: de 0 a {LINHAS_RESPOSTA_MAX}.")
        else:
            prefs["linhas_resposta"] = linhas

    if "incluir_guia" in bruto:
        valor = inteiro(bruto["incluir_guia"]) if not isinstance(bruto["incluir_guia"], bool) else int(bruto["incluir_guia"])
        if valor in (0, 1):
            prefs["incluir_guia"] = valor
        else:
            invalido("incluir_guia", "incluir_guia deve ser 0 ou 1.")

    if prefs["colunas"] == 2 and prefs["fonte_pt"] > FONTE_PT_MAX_DUAS_COLUNAS:
        prefs["colunas"] = 1
        avisos.append(
            f"Com fonte acima de {FONTE_PT_MAX_DUAS_COLUNAS} pt o layout foi ajustado para coluna única."
        )
    return prefs, avisos


class RepositorioImpressao:
    """Persistência simples em SQLite; uma conexão por operação (seguro entre threads)."""

    def __init__(self, caminho_db: str, retencao_dias: int | None = None):
        self.caminho_db = caminho_db
        self.retencao = timedelta(
            days=retencao_dias
            if retencao_dias is not None
            else int(os.getenv("IRIS_IMPRESSAO_RETENCAO_DIAS", "30"))
        )
        migrar(caminho_db)

    def _conectar(self):
        return conectar(self.caminho_db)

    def criar(self, corpo: dict[str, Any], professor_id: int) -> tuple[MaterialImpressao, list[str]]:
        titulo = corpo.get("titulo")
        if not isinstance(titulo, str) or not titulo.strip():
            raise MaterialInvalidoError("O campo 'titulo' é obrigatório.", campo="titulo")
        titulo = titulo.strip()[:TAMANHO_MAXIMO_TITULO]

        perfil = corpo.get("perfil") or {}
        if not isinstance(perfil, dict) or not isinstance(perfil.get("codigo"), str):
            raise MaterialInvalidoError("O campo 'perfil' é obrigatório.", campo="perfil")

        html = corpo.get("conteudo_html")
        if not isinstance(html, str) or not html.strip():
            raise MaterialInvalidoError("O conteúdo do material está vazio.", campo="conteudo_html")
        if len(html) > TAMANHO_MAXIMO_HTML:
            raise MaterialInvalidoError("O material é grande demais para impressão.", campo="conteudo_html")
        html_limpo = sanitizar_html(html)
        if not html_limpo.strip():
            raise MaterialInvalidoError("O conteúdo do material está vazio.", campo="conteudo_html")

        preferencias, avisos = normalizar_preferencias(corpo.get("preferencias"), estrito=True)
        from app.services.ai_service import normalizar_guia  # import tardio: evita ciclo na carga
        guia = normalizar_guia(corpo.get("guia_mediador"))

        agora = datetime.now(timezone.utc)
        material = MaterialImpressao(
            id=secrets.token_urlsafe(18),  # aleatório: não dá para adivinhar outros materiais
            professor_id=professor_id,
            titulo=titulo,
            perfil_codigo=perfil["codigo"][:40],
            perfil_nome=str(perfil.get("nome") or perfil["codigo"])[:80],
            conteudo_html=html_limpo,
            preferencias=preferencias,
            criado_em=agora,
            expira_em=agora + self.retencao,
            guia_mediador=guia,
        )
        with closing(self._conectar()) as conexao, conexao:
            conexao.execute("DELETE FROM materiais_impressao WHERE expira_em < ?", (agora.isoformat(),))
            conexao.execute(
                """
                INSERT INTO materiais_impressao (id, titulo, perfil_codigo, perfil_nome, conteudo_html,
                    preferencias, criado_em, expira_em, professor_id, guia_mediador)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    material.id, material.titulo, material.perfil_codigo, material.perfil_nome,
                    material.conteudo_html, json.dumps(material.preferencias),
                    material.criado_em.isoformat(), material.expira_em.isoformat(), professor_id,
                    json.dumps(guia, ensure_ascii=False) if guia else None,
                ),
            )
        return material, avisos

    def obter(self, id_material: str, professor_id: int) -> MaterialImpressao | None:
        if not PADRAO_ID.match(id_material or ""):
            return None
        with closing(self._conectar()) as conexao:
            linha = conexao.execute(
                "SELECT * FROM materiais_impressao WHERE id = ? AND professor_id = ? AND expira_em >= ?",
                (id_material, professor_id, datetime.now(timezone.utc).isoformat()),
            ).fetchone()
        if linha is None:
            return None
        return MaterialImpressao(
            id=linha["id"],
            professor_id=linha["professor_id"],
            titulo=linha["titulo"],
            perfil_codigo=linha["perfil_codigo"],
            perfil_nome=linha["perfil_nome"],
            conteudo_html=linha["conteudo_html"],
            preferencias=json.loads(linha["preferencias"]),
            criado_em=datetime.fromisoformat(linha["criado_em"]),
            expira_em=datetime.fromisoformat(linha["expira_em"]),
            guia_mediador=json.loads(linha["guia_mediador"]) if linha["guia_mediador"] else None,
        )

    def excluir(self, id_material: str, professor_id: int) -> bool:
        if not PADRAO_ID.match(id_material or ""):
            return False
        with closing(self._conectar()) as conexao, conexao:
            return conexao.execute(
                "DELETE FROM materiais_impressao WHERE id = ? AND professor_id = ?", (id_material, professor_id)
            ).rowcount > 0

    def listar(self, professor_id: int, limite: int = 50) -> list[dict[str, Any]]:
        """Histórico do professor: materiais ainda válidos, do mais recente ao mais antigo."""
        with closing(self._conectar()) as conexao:
            linhas = conexao.execute(
                """
                SELECT id, titulo, perfil_codigo, perfil_nome, criado_em, expira_em
                  FROM materiais_impressao
                 WHERE professor_id = ? AND expira_em >= ?
                 ORDER BY criado_em DESC LIMIT ?
                """,
                (professor_id, datetime.now(timezone.utc).isoformat(), limite),
            ).fetchall()
        return [dict(l) for l in linhas]
