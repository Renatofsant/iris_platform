"""
Rotas do módulo de inclusão: adaptação de conteúdos científicos por perfil de acessibilidade.

TODAS as rotas exigem login (before_request abaixo) e cada professor só acessa os
próprios registros: alunos, materiais, histórico e métricas são filtrados por professor_id
nos repositórios. Registro de outro professor responde 404, sem confirmar que existe.

Páginas (prefixo /inclusao):
    GET  /                    Interface de adaptação de conteúdos.
    GET  /imprimir/<id>       Versão de impressão de uma prova/atividade adaptada.
                              Aceita ?fonte_pt=&contraste=&tipografia=&entrelinhas=&colunas=&linhas_resposta=&incluir_guia=
    POST /relatorio-aee       Relatório pedagógico BNCC & AEE, pronto para imprimir/salvar em PDF
                              (formulário: csrf_token + dados=<JSON>; nada é gravado).

Endpoints (prefixo /api/inclusao):
    GET  /perfis              Lista os perfis e as recomendações de apresentação.
    POST /adaptar             Adapta um texto para um perfil.
    POST /adaptar/multiplos   Adapta um texto para vários perfis em paralelo.
    GET  /saude               Estado do serviço de IA (simulação ou provedores ativos).
    POST /extrair-texto       Importa PDF/DOCX/TXT (multipart, campo "arquivo") e devolve o texto.
    POST /imagem              Lê imagem de Física (multipart, campo "imagem"): LaTeX + audiodescrição.
    POST /voz/perguntar       Íris Voice: responde a uma pergunta sobre o conteúdo da tela.
    GET|POST /materiais       Histórico do professor / salva material para impressão.
    DELETE /materiais/<id>    Remove um material salvo.
    POST /materiais/<id>/docx Gera o Word (.docx) com o cabeçalho escolar enviado no corpo.
    GET|POST /alunos          Lista / cria perfis de alunos atípicos (?turma= filtra).
    GET|PUT|DELETE /alunos/<id>
    PATCH /metricas/<id>      Avaliação do professor (nota 1–5 e tempo manual estimado).
    GET  /metricas/resumo     Agregados por perfil (?escopo=todos: só pesquisador).
    GET  /metricas/exportar.csv  Professor: os próprios; pesquisador: todos, pseudonimizados.
    POST /braille             Texto adaptado → Braille (.brf para impressora/linha braille, ou Unicode .txt).
    POST /aee/eventos         Registra (em lote) o uso de recursos de acessibilidade — anônimo.
    GET  /aee/resumo          Histórico e Trajetória AEE (?dias=7|30|90|365&perfil=&escopo=todos).
"""

from __future__ import annotations

import io
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any

from flask import Blueprint, Response, abort, current_app, jsonify, render_template, request, send_file, url_for
from flask_login import current_user

from app.services.ai_service import (
    TAMANHO_MAXIMO_IMAGEM,
    TAMANHO_MAXIMO_TEXTO,
    TAMANHO_MINIMO_TEXTO,
    AIService,
    EntradaInvalidaError,
    ErroServicoIA,
)
from app.routes.auth import _csrf_valido
from app.services.aee_analytics_service import DIAS_PERMITIDOS, EventoInvalidoError, RepositorioAcessibilidade
from app.services.alunos_service import AlunoInvalidoError, RepositorioAlunos
from app.services.braille_service import TAMANHO_MAXIMO_TEXTO as TAMANHO_MAXIMO_BRAILLE
from app.services.braille_service import gerar_braille, nome_arquivo_braille
from app.services.bncc_service import FUNDAMENTACAO_LEGAL, normalizar_relatorio
from app.services.docx_service import gerar_docx, nome_arquivo
from app.services.importacao_service import ImportacaoInvalidaError, extrair_texto
from app.services.impressao_service import (
    FONTE_PT_MAX,
    FONTE_PT_MAX_DUAS_COLUNAS,
    FONTE_PT_MIN,
    LINHAS_RESPOSTA_MAX,
    MaterialInvalidoError,
    RepositorioImpressao,
    normalizar_preferencias,
)
from app.services.metricas_service import AvaliacaoInvalidaError, RepositorioMetricas

logger = logging.getLogger(__name__)

inclusao_bp = Blueprint("inclusao", __name__, url_prefix="/api/inclusao")
inclusao_pagina_bp = Blueprint("inclusao_pagina", __name__, url_prefix="/inclusao")

CAMPOS_CONTEXTO = ("disciplina", "tema", "nivel_ensino", "ano_serie")
CAMPOS_CABECALHO = ("escola", "aluno", "turma", "data", "disciplina", "professor")
MAX_PERFIS_POR_REQUISICAO = 5
STATUS_ERRO_IA = {"IA_CONFIGURACAO": 503, "IA_RECUSA": 422, "IA_REQUISICAO_INVALIDA": 422}


# ---------------------------------------------------------------------------
# Autenticação obrigatória em todo o módulo
# ---------------------------------------------------------------------------

@inclusao_bp.before_request
@inclusao_pagina_bp.before_request
def _exigir_login():
    if not current_user.is_authenticated:
        return current_app.login_manager.unauthorized()
    return None


@inclusao_bp.after_request
def _sem_cache_dados_pessoais(resposta):
    # Respostas da API trazem dados de alunos e do professor: nunca em cache compartilhado.
    resposta.headers["Cache-Control"] = "no-store"
    return resposta


# ---------------------------------------------------------------------------
# Auxiliares
# ---------------------------------------------------------------------------

def _extensao(nome: str):
    objeto = current_app.extensions.get(nome)
    if objeto is None:
        abort(503)
    return objeto


def _repositorio() -> RepositorioImpressao:
    return _extensao("impressao_repo")


def _repo_alunos() -> RepositorioAlunos:
    return _extensao("alunos_repo")


def _repo_metricas() -> RepositorioMetricas | None:
    return current_app.extensions.get("metricas_repo")


def _servico() -> AIService:
    servico = current_app.extensions.get("ai_service")
    if servico is None:
        servico = AIService()
        current_app.extensions["ai_service"] = servico
    return servico


def _registrar_metrica(
    repositorio: RepositorioMetricas | None,
    resultado: dict[str, Any],
    caracteres: int,
    professor_id: int,
    tipo_entrada: str = "texto",
) -> None:
    """
    Registra a métrica de uso. Respostas do modo simulação NÃO entram (não são dados reais).
    Uma falha aqui nunca derruba a adaptação.
    """
    if repositorio is None or not resultado.get("sucesso") or resultado.get("origem") not in ("ia", "fallback"):
        return
    try:
        meta = resultado.setdefault("meta", {})
        meta["metrica_id"] = repositorio.registrar(
            perfil_usado=resultado["perfil"]["codigo"] if tipo_entrada == "texto" else "IMAGEM_EQUACAO",
            caracteres_originais=caracteres,
            tempo_processamento_ms=meta.get("tempo_ms") or 0,
            origem=resultado["origem"],
            modelo=meta.get("modelo"),
            tipo_entrada=tipo_entrada,
            professor_id=professor_id,
        )
    except Exception:
        logger.exception("Falha ao registrar métrica de uso")


def _erro(status: int, codigo: str, mensagem: str, campo: str | None = None):
    return jsonify({
        "sucesso": False,
        "dados": None,
        "erro": {"codigo": codigo, "mensagem": mensagem, "campo": campo},
    }), status


def _corpo_json() -> dict[str, Any] | None:
    corpo = request.get_json(silent=True)
    return corpo if isinstance(corpo, dict) else None


def _contexto(corpo: dict[str, Any]) -> dict[str, str]:
    return {c: corpo[c] for c in CAMPOS_CONTEXTO if isinstance(corpo.get(c), str)}


def _limites_impressao() -> dict[str, int]:
    return {
        "fonte_min": FONTE_PT_MIN,
        "fonte_max": FONTE_PT_MAX,
        "fonte_max_duas_colunas": FONTE_PT_MAX_DUAS_COLUNAS,
        "linhas_max": LINHAS_RESPOSTA_MAX,
    }


# ---------------------------------------------------------------------------
# Páginas
# ---------------------------------------------------------------------------

@inclusao_pagina_bp.get("/")
def pagina():
    return render_template(
        "inclusao/index.html",
        perfis=AIService.listar_perfis(),
        minimo_texto=TAMANHO_MINIMO_TEXTO,
        limite_texto=TAMANHO_MAXIMO_TEXTO,
        limite_imagem=TAMANHO_MAXIMO_IMAGEM,
        modo_ia=_servico().descricao_modo,
    )


@inclusao_pagina_bp.get("/imprimir/<id_material>")
def imprimir(id_material: str):
    material = _repositorio().obter(id_material, current_user.id)
    if material is None:
        return render_template("inclusao/imprimir_indisponivel.html"), 404

    # Preferências salvas + ajustes rápidos via query string (valores inválidos são ignorados).
    ajustes = {k: v for k, v in request.args.items() if k in material.preferencias}
    preferencias, avisos = normalizar_preferencias(ajustes, estrito=False, base=material.preferencias)

    resposta = current_app.make_response(render_template(
        "inclusao/imprimir.html",
        material=material,
        preferencias=preferencias,
        avisos=avisos,
        limites=_limites_impressao(),
    ))
    return _pagina_privada(resposta)


def _pagina_privada(resposta):
    resposta.headers["Referrer-Policy"] = "no-referrer"
    resposta.headers["Cache-Control"] = "private, no-store"
    resposta.headers["X-Robots-Tag"] = "noindex, nofollow"
    return resposta


CAMPOS_RELATORIO = ("escola", "professor", "aluno", "turma", "disciplina", "titulo", "perfil", "observacoes")


@inclusao_pagina_bp.post("/relatorio-aee")
def relatorio_aee():
    """
    Relatório BNCC & AEE para impressão/PDF. Os dados vêm do material já adaptado no navegador
    e são validados de novo aqui (códigos BNCC conferidos contra o catálogo). Nada é gravado.
    """
    if not _csrf_valido():
        abort(400, "O formulário expirou. Recarregue a página e tente novamente.")
    try:
        corpo = json.loads(request.form.get("dados", ""))
    except ValueError:
        corpo = None
    if not isinstance(corpo, dict):
        abort(400, "Dados do relatório inválidos.")
    relatorio = normalizar_relatorio(corpo.get("relatorio_aee"))
    if relatorio is None:
        abort(400, "Este material não tem dados de relatório BNCC/AEE. Adapte o conteúdo novamente.")
    campos = {c: str(corpo.get(c) or "").strip()[:2000 if c == "observacoes" else 200] for c in CAMPOS_RELATORIO}
    resposta = current_app.make_response(render_template(
        "inclusao/relatorio_aee.html",
        relatorio=relatorio,
        campos=campos,
        fundamentacao=FUNDAMENTACAO_LEGAL,
        data_emissao=date.today().strftime("%d/%m/%Y"),
    ))
    return _pagina_privada(resposta)


# ---------------------------------------------------------------------------
# Adaptação de textos
# ---------------------------------------------------------------------------

@inclusao_bp.get("/perfis")
def listar_perfis():
    return jsonify({"sucesso": True, "dados": AIService.listar_perfis(), "erro": None})


@inclusao_bp.post("/adaptar")
def adaptar():
    """
    Corpo: {"texto": str, "perfil": str, "disciplina"?: str, "tema"?: str,
            "nivel_ensino"?: str, "ano_serie"?: str}
    """
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com 'texto' e 'perfil'.")

    try:
        resultado = _servico().adaptar(corpo.get("texto"), corpo.get("perfil"), _contexto(corpo))
    except EntradaInvalidaError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)
    except Exception:
        logger.exception("Erro inesperado ao adaptar conteúdo")
        return _erro(500, "ERRO_INTERNO", "Erro interno ao processar a adaptação.")

    _registrar_metrica(_repo_metricas(), resultado, len(str(corpo.get("texto")).strip()), current_user.id)
    return jsonify(resultado), 200


@inclusao_bp.post("/adaptar/multiplos")
def adaptar_multiplos():
    """
    Corpo: {"texto": str, "perfis": [str, ...], ...campos de contexto}
    Cada perfil é processado de forma independente: a falha de um não afeta os demais.
    """
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com 'texto' e 'perfis'.")

    perfis_brutos = corpo.get("perfis")
    if not isinstance(perfis_brutos, list) or not perfis_brutos:
        return _erro(400, "ENTRADA_INVALIDA", "O campo 'perfis' deve ser uma lista não vazia.", "perfis")
    if len(perfis_brutos) > MAX_PERFIS_POR_REQUISICAO:
        return _erro(
            400, "ENTRADA_INVALIDA",
            f"Envie no máximo {MAX_PERFIS_POR_REQUISICAO} perfis por requisição.", "perfis",
        )

    servico = _servico()
    try:
        # Valida tudo antes de chamar a IA, para não gastar requisições com entrada inválida.
        texto, _ = servico.validar_entrada(corpo.get("texto"), perfis_brutos[0])
        perfis = list(dict.fromkeys(servico.normalizar_perfil(p) for p in perfis_brutos))
    except EntradaInvalidaError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)

    contexto = _contexto(corpo)
    # Capturados aqui: as threads abaixo não têm contexto do Flask (nem current_user).
    metricas, professor_id = _repo_metricas(), current_user.id

    def processar(perfil):
        try:
            resultado = servico.adaptar(texto, perfil, contexto)
            _registrar_metrica(metricas, resultado, len(texto), professor_id)
            return resultado
        except Exception:
            logger.exception("Erro inesperado ao adaptar perfil %s", perfil.value)
            return {
                "sucesso": False,
                "perfil": {"codigo": perfil.value},
                "dados": None,
                "erro": {"codigo": "ERRO_INTERNO", "mensagem": "Erro interno neste perfil."},
            }

    with ThreadPoolExecutor(max_workers=len(perfis)) as executor:
        resultados = list(executor.map(processar, perfis))

    return jsonify({
        "sucesso": any(r.get("sucesso") for r in resultados),
        "dados": {r["perfil"]["codigo"]: r for r in resultados},
        "erro": None,
    }), 200


@inclusao_bp.get("/saude")
def saude():
    servico = _servico()
    return jsonify({
        "sucesso": True,
        "dados": {
            "ia_disponivel": servico.ia_disponivel,
            "modelo": servico.modelo,
            **servico.descricao_modo,
            "fallback_local_ativo": True,
        },
        "erro": None,
    })


# ---------------------------------------------------------------------------
# Importação de arquivos (PDF, DOCX, TXT)
# ---------------------------------------------------------------------------

@inclusao_bp.post("/extrair-texto")
def importar_arquivo():
    """multipart/form-data: arquivo=<PDF|DOCX|TXT>. O arquivo não é armazenado."""
    arquivo = request.files.get("arquivo")
    if arquivo is None:
        return _erro(400, "ENTRADA_INVALIDA", "Envie o arquivo no campo 'arquivo'.", "arquivo")
    try:
        resultado = extrair_texto(arquivo.filename or "", arquivo.read())
    except ImportacaoInvalidaError as exc:
        return _erro(exc.status, "ARQUIVO_INVALIDO", exc.mensagem, "arquivo")
    return jsonify({"sucesso": True, "dados": resultado, "erro": None})


# ---------------------------------------------------------------------------
# Imagens e equações (visão)
# ---------------------------------------------------------------------------

@inclusao_bp.post("/imagem")
def analisar_imagem():
    """
    multipart/form-data: imagem=<arquivo PNG|JPEG|GIF|WEBP>, disciplina?, tema?, nivel_ensino?, ano_serie?
    A imagem é processada em memória e não é armazenada.
    """
    arquivo = request.files.get("imagem")
    if arquivo is None:
        return _erro(400, "ENTRADA_INVALIDA", "Envie a imagem no campo 'imagem' (multipart/form-data).", "imagem")
    conteudo = arquivo.read(TAMANHO_MAXIMO_IMAGEM + 1)  # +1 para detectar excesso sem ler tudo
    contexto = {c: request.form[c] for c in CAMPOS_CONTEXTO if request.form.get(c)}

    try:
        resultado = _servico().analisar_imagem(conteudo, contexto)
    except EntradaInvalidaError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)
    except ErroServicoIA as exc:
        status = STATUS_ERRO_IA.get(exc.codigo, 503 if exc.retentavel else 502)
        return jsonify({
            "sucesso": False,
            "dados": None,
            "erro": {"codigo": exc.codigo, "mensagem": exc.mensagem_publica, "retentavel": exc.retentavel},
        }), status
    except Exception:
        logger.exception("Erro inesperado ao analisar imagem")
        return _erro(500, "ERRO_INTERNO", "Erro interno ao analisar a imagem.")

    _registrar_metrica(_repo_metricas(), resultado, 0, current_user.id, tipo_entrada="imagem")
    return jsonify(resultado), 200


# ---------------------------------------------------------------------------
# Íris Voice
# ---------------------------------------------------------------------------

@inclusao_bp.post("/voz/perguntar")
def perguntar_voz():
    """
    Corpo: {"pergunta": str, "contexto"?: str (texto da tela), "secao"?: str,
            "historico"?: [{"papel": "estudante"|"iris", "texto": str}, ...] (memória da sessão, até 8 turnos)}
    Resposta (dados): resposta, fundamentacao, area, referencias (catálogo fixo), ilustracao | null.
    """
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com a 'pergunta'.")
    try:
        resultado = _servico().responder_voz(
            corpo.get("pergunta"), corpo.get("contexto"), corpo.get("secao"), corpo.get("historico"),
        )
    except EntradaInvalidaError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)
    except Exception:
        logger.exception("Erro inesperado no Íris Voice")
        return _erro(500, "ERRO_INTERNO", "Não consegui responder agora.")
    return jsonify(resultado), 200


# ---------------------------------------------------------------------------
# Materiais (impressão, histórico e Word)
# ---------------------------------------------------------------------------

@inclusao_bp.get("/materiais")
def listar_materiais():
    materiais = _repositorio().listar(current_user.id)
    for material in materiais:
        material["url_impressao"] = url_for("inclusao_pagina.imprimir", id_material=material["id"])
    return jsonify({"sucesso": True, "dados": materiais, "erro": None})


@inclusao_bp.post("/materiais")
def criar_material():
    """
    Corpo: {"titulo": str, "perfil": {"codigo": str, "nome": str}, "conteudo_html": str,
            "guia_mediador"?: {...}, "preferencias": {"fonte_pt", "contraste", "tipografia",
            "entrelinhas", "colunas", "linhas_resposta", "incluir_guia"}}
    O HTML é sanitizado no servidor. O cabeçalho escolar (nome do aluno) não é enviado.
    """
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com o material.")
    try:
        material, avisos = _repositorio().criar(corpo, current_user.id)
    except MaterialInvalidoError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)
    except Exception:
        logger.exception("Erro ao salvar material para impressão")
        return _erro(500, "ERRO_INTERNO", "Não foi possível salvar o material para impressão.")

    return jsonify({
        "sucesso": True,
        "dados": {
            "id": material.id,
            "url_impressao": url_for("inclusao_pagina.imprimir", id_material=material.id),
            "url_docx": url_for("inclusao.baixar_docx", id_material=material.id),
            "preferencias": material.preferencias,
            "expira_em": material.expira_em.isoformat(),
        },
        "avisos": avisos,
        "erro": None,
    }), 201


@inclusao_bp.delete("/materiais/<id_material>")
def excluir_material(id_material: str):
    if not _repositorio().excluir(id_material, current_user.id):
        return _erro(404, "NAO_ENCONTRADO", "Material não encontrado ou já expirado.")
    return jsonify({"sucesso": True, "dados": None, "erro": None})


@inclusao_bp.post("/materiais/<id_material>/docx")
def baixar_docx(id_material: str):
    """
    Corpo: {"cabecalho": {"escola", "aluno", "turma", "data", "disciplina", "professor"},
            "preferencias"?: {...ajustes sobre as preferências salvas}}
    O cabeçalho (com o nome do aluno) é usado só para montar o arquivo: não é gravado nem registrado.
    """
    material = _repositorio().obter(id_material, current_user.id)
    if material is None:
        return _erro(404, "NAO_ENCONTRADO", "Material não encontrado ou já expirado.")
    corpo = _corpo_json() or {}
    cabecalho_bruto = corpo.get("cabecalho") if isinstance(corpo.get("cabecalho"), dict) else {}
    cabecalho = {c: str(cabecalho_bruto.get(c) or "")[:120] for c in CAMPOS_CABECALHO}
    ajustes = corpo.get("preferencias") if isinstance(corpo.get("preferencias"), dict) else {}
    preferencias, _ = normalizar_preferencias(ajustes, estrito=False, base=material.preferencias)

    try:
        conteudo = gerar_docx(
            material.titulo, material.conteudo_html, preferencias, cabecalho,
            guia=material.guia_mediador if preferencias.get("incluir_guia") else None,
        )
    except Exception:
        logger.exception("Erro ao gerar DOCX do material %s", id_material)
        return _erro(500, "ERRO_INTERNO", "Não foi possível gerar o arquivo Word.")

    return send_file(
        io.BytesIO(conteudo),
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        as_attachment=True,
        download_name=nome_arquivo(material.titulo),
        max_age=0,
    )


# ---------------------------------------------------------------------------
# Alunos atípicos (dados pessoais sensíveis — ver alunos_service.py)
# ---------------------------------------------------------------------------

@inclusao_bp.get("/alunos")
def listar_alunos():
    turma = request.args.get("turma", "").strip() or None
    return jsonify({"sucesso": True, "dados": _repo_alunos().listar(current_user.id, turma), "erro": None})


@inclusao_bp.post("/alunos")
def criar_aluno():
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com os dados do aluno.")
    try:
        aluno = _repo_alunos().criar(corpo, current_user.id)
    except AlunoInvalidoError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)
    return jsonify({"sucesso": True, "dados": aluno, "erro": None}), 201


@inclusao_bp.get("/alunos/<int:id_aluno>")
def obter_aluno(id_aluno: int):
    aluno = _repo_alunos().obter(id_aluno, current_user.id)
    if aluno is None:
        return _erro(404, "NAO_ENCONTRADO", "Aluno não encontrado.")
    return jsonify({"sucesso": True, "dados": aluno, "erro": None})


@inclusao_bp.put("/alunos/<int:id_aluno>")
def atualizar_aluno(id_aluno: int):
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com os campos a atualizar.")
    try:
        aluno = _repo_alunos().atualizar(id_aluno, corpo, current_user.id)
    except AlunoInvalidoError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)
    if aluno is None:
        return _erro(404, "NAO_ENCONTRADO", "Aluno não encontrado.")
    return jsonify({"sucesso": True, "dados": aluno, "erro": None})


@inclusao_bp.delete("/alunos/<int:id_aluno>")
def excluir_aluno(id_aluno: int):
    if not _repo_alunos().excluir(id_aluno, current_user.id):
        return _erro(404, "NAO_ENCONTRADO", "Aluno não encontrado.")
    return jsonify({"sucesso": True, "dados": None, "erro": None})


# ---------------------------------------------------------------------------
# Métricas de uso e avaliação
# ---------------------------------------------------------------------------

def _repo_metricas_obrigatorio() -> RepositorioMetricas:
    return _extensao("metricas_repo")


@inclusao_bp.patch("/metricas/<id_metrica>")
def avaliar_metrica(id_metrica: str):
    """Corpo: {"nota_avaliacao_professor": 1..5, "tempo_manual_estimado_min"?: 0..1440}"""
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com a avaliação.")
    try:
        avaliacao = _repo_metricas_obrigatorio().avaliar(id_metrica, corpo, current_user.id)
    except AvaliacaoInvalidaError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)
    if avaliacao is None:
        return _erro(404, "NAO_ENCONTRADO", "Registro de uso não encontrado.")
    return jsonify({"sucesso": True, "dados": avaliacao, "erro": None})


def _escopo_metricas() -> int | None:
    """None = todos os professores; permitido só ao papel pesquisador."""
    if request.args.get("escopo") == "todos":
        if not current_user.pesquisador:
            abort(403)
        return None
    return current_user.id


@inclusao_bp.get("/metricas/resumo")
def resumo_metricas():
    return jsonify({"sucesso": True, "dados": _repo_metricas_obrigatorio().resumo(_escopo_metricas()), "erro": None})


@inclusao_bp.get("/metricas/exportar.csv")
def exportar_metricas():
    csv = _repo_metricas_obrigatorio().exportar_csv(current_app.config["SECRET_KEY"], _escopo_metricas())
    return Response(
        "﻿" + csv,  # BOM: acentos corretos no Excel
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=iris_metricas_uso.csv"},
    )


# ---------------------------------------------------------------------------
# Braille (.BRF)
# ---------------------------------------------------------------------------

@inclusao_bp.post("/braille")
def exportar_braille():
    """
    Corpo: {"titulo": str, "texto": str, "formato"?: "brf" | "unicode"}
    O texto é o material já adaptado (e revisado) na tela. Nada é gravado.
    """
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com 'titulo' e 'texto'.")
    texto = corpo.get("texto")
    if not isinstance(texto, str) or not texto.strip():
        return _erro(400, "ENTRADA_INVALIDA", "Não há texto para transcrever em braille.", "texto")
    if len(texto) > TAMANHO_MAXIMO_BRAILLE:
        return _erro(400, "ENTRADA_INVALIDA", "O material é grande demais para um único arquivo braille.", "texto")
    formato = "unicode" if corpo.get("formato") == "unicode" else "brf"
    titulo = str(corpo.get("titulo") or "Material adaptado").strip()[:200]

    try:
        conteudo = gerar_braille(texto, titulo, formato)
    except Exception:
        logger.exception("Erro ao gerar braille")
        return _erro(500, "ERRO_INTERNO", "Não foi possível gerar o arquivo braille.")

    # BRF é ASCII puro; o Unicode vai em UTF-8 com BOM (o Bloco de Notas reconhece as celas).
    dados = conteudo.encode("ascii") if formato == "brf" else ("﻿" + conteudo).encode("utf-8")
    return send_file(
        io.BytesIO(dados),
        mimetype="text/plain" if formato == "unicode" else "application/octet-stream",
        as_attachment=True,
        download_name=nome_arquivo_braille(titulo, formato),
        max_age=0,
    )


# ---------------------------------------------------------------------------
# Histórico e Trajetória AEE (uso anônimo dos recursos de acessibilidade)
# ---------------------------------------------------------------------------

def _repo_acessibilidade() -> RepositorioAcessibilidade:
    return _extensao("acessibilidade_repo")


@inclusao_bp.post("/aee/eventos")
def registrar_eventos_aee():
    """Corpo: {"eventos": [{"recurso": str, "valor": str, "perfil"?: str, "quando"?: ISO-8601}, ...]}"""
    corpo = _corpo_json()
    if corpo is None:
        return _erro(400, "JSON_INVALIDO", "Envie um corpo JSON com 'eventos'.")
    perfis = {p["codigo"] for p in AIService.listar_perfis()} | {"IMAGEM_EQUACAO"}
    try:
        gravados = _repo_acessibilidade().registrar_lote(corpo.get("eventos"), current_user.id, perfis)
    except EventoInvalidoError as exc:
        return _erro(400, "ENTRADA_INVALIDA", exc.mensagem, exc.campo)
    return jsonify({"sucesso": True, "dados": {"gravados": gravados}, "erro": None})


@inclusao_bp.get("/aee/resumo")
def resumo_aee():
    try:
        dias = int(request.args.get("dias", 90))
    except ValueError:
        dias = 90
    if dias not in DIAS_PERMITIDOS:
        dias = 90
    perfil = request.args.get("perfil", "").strip() or None
    if perfil and perfil not in {p["codigo"] for p in AIService.listar_perfis()} | {"IMAGEM_EQUACAO", "SEM_PERFIL"}:
        return _erro(400, "ENTRADA_INVALIDA", "Perfil desconhecido.", "perfil")
    dados = _repo_acessibilidade().resumo(_escopo_metricas(), "" if perfil == "SEM_PERFIL" else perfil, dias)
    return jsonify({"sucesso": True, "dados": dados, "erro": None})
