from __future__ import annotations

import logging
import os
import secrets
from datetime import timedelta
from urllib.parse import urlparse

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, send_from_directory, url_for
from flask_login import LoginManager
from werkzeug.exceptions import HTTPException

METODOS_QUE_ALTERAM = {"POST", "PUT", "PATCH", "DELETE"}


def _chave_secreta(app: Flask) -> str:
    """IRIS_SECRET_KEY em produção; em desenvolvimento, gera uma e guarda em instance/secret_key."""
    if os.getenv("IRIS_SECRET_KEY"):
        return os.environ["IRIS_SECRET_KEY"]
    os.makedirs(app.instance_path, exist_ok=True)
    caminho = os.path.join(app.instance_path, "secret_key")
    if not os.path.exists(caminho):
        with open(caminho, "w", encoding="ascii") as arquivo:
            arquivo.write(secrets.token_hex(32))
    with open(caminho, encoding="ascii") as arquivo:
        return arquivo.read().strip()


def _avisar_configuracao_supabase(app: Flask) -> None:
    """Na subida do servidor, confere o Supabase uma vez e loga o que estiver errado (sem derrubar o app)."""
    from app.services import supabase_service

    if app.testing or not supabase_service.configurado() or os.getenv("IRIS_AUTH", "").lower() == "local":
        return
    try:
        problemas = [(e, d) for e, ok, d in supabase_service.diagnosticar() if not ok]
    except Exception as exc:
        problemas = [("diagnóstico", f"{type(exc).__name__}: {exc}")]
    for etapa, detalhe in problemas:
        app.logger.error("Supabase — %s: %s", etapa, detalhe)
    if not problemas:
        app.logger.info("Supabase Auth conectado.")


def create_app(config: dict | None = None) -> Flask:
    # .env na raiz do projeto (SUPABASE_URL, SUPABASE_KEY…); variáveis já definidas no ambiente têm prioridade.
    load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
    app = Flask(__name__)
    cookies_seguros = os.getenv("IRIS_COOKIE_SEGURO", "0") == "1"  # "1" em produção (HTTPS)
    app.config.update(
        MAX_CONTENT_LENGTH=5 * 1024 * 1024,  # 5 MB: comporta o upload de imagens (limite de 3,75 MB no serviço)
        JSON_AS_ASCII=False,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",  # o navegador não envia o cookie em POST vindo de outro site
        SESSION_COOKIE_SECURE=cookies_seguros,
        REMEMBER_COOKIE_HTTPONLY=True,
        REMEMBER_COOKIE_SAMESITE="Lax",
        REMEMBER_COOKIE_SECURE=cookies_seguros,
        REMEMBER_COOKIE_DURATION=timedelta(days=14),
    )
    if config:
        app.config.update(config)
    if not app.config.get("SECRET_KEY"):
        app.config["SECRET_KEY"] = _chave_secreta(app)
    app.json.ensure_ascii = False  # preserva acentuação no JSON

    logging.basicConfig(level=logging.INFO)

    from app.cli import iris_cli
    from app.db import migrar
    from app.routes.auth import auth_bp, token_csrf
    from app.routes.inclusao import inclusao_bp, inclusao_pagina_bp
    from app.services.aee_analytics_service import RepositorioAcessibilidade
    from app.services.ai_service import AIService
    from app.services.alunos_service import RepositorioAlunos
    from app.services.impressao_service import RepositorioImpressao
    from app.services.metricas_service import RepositorioMetricas
    from app.services.usuarios_service import RepositorioUsuarios

    caminho_db = (
        app.config.get("IRIS_DB_PATH")
        or os.getenv("IRIS_DB_PATH")
        or os.path.join(app.instance_path, "iris.db")
    )
    migrar(caminho_db)
    app.extensions["ai_service"] = app.config.get("AI_SERVICE") or AIService()
    app.extensions["usuarios_repo"] = RepositorioUsuarios(caminho_db)
    app.extensions["impressao_repo"] = RepositorioImpressao(caminho_db)
    app.extensions["alunos_repo"] = RepositorioAlunos(caminho_db)
    app.extensions["metricas_repo"] = RepositorioMetricas(caminho_db)
    app.extensions["acessibilidade_repo"] = RepositorioAcessibilidade(caminho_db)

    # ---------------------------------------------------------------- login
    gerenciador = LoginManager(app)
    gerenciador.login_view = "auth.login"
    # "strong": se o IP ou o navegador mudarem, a sessão é descartada (protege contra cookie roubado,
    # mas desconecta quem troca de rede, ex.: Wi-Fi → 4G). "basic" é mais tolerante.
    gerenciador.session_protection = os.getenv("IRIS_PROTECAO_SESSAO", "strong")

    @gerenciador.user_loader
    def carregar_usuario(id_usuario: str):
        return app.extensions["usuarios_repo"].obter(id_usuario)

    @gerenciador.unauthorized_handler
    def nao_autenticado():
        if request.path.startswith("/api/"):
            return jsonify({
                "sucesso": False,
                "dados": None,
                "erro": {"codigo": "NAO_AUTENTICADO", "mensagem": "Sua sessão expirou. Entre novamente."},
            }), 401
        return redirect(url_for("auth.login", next=request.full_path.rstrip("?")))

    app.jinja_env.globals["csrf_token"] = token_csrf

    # ---------------------------------------------------------------- defesas gerais
    @app.before_request
    def verificar_origem():
        """Requisições que alteram dados precisam vir deste mesmo site (defesa extra contra CSRF)."""
        if request.method not in METODOS_QUE_ALTERAM:
            return None
        origem = request.headers.get("Origin")
        if origem and urlparse(origem).netloc != request.host:
            return jsonify({
                "sucesso": False, "dados": None,
                "erro": {"codigo": "ORIGEM_INVALIDA", "mensagem": "Requisição de origem não permitida."},
            }), 403
        return None

    @app.after_request
    def cabecalhos_seguranca(resposta):
        resposta.headers.setdefault("X-Content-Type-Options", "nosniff")
        resposta.headers.setdefault("X-Frame-Options", "DENY")
        resposta.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        return resposta

    # ---------------------------------------------------------------- PWA (uso offline)
    # O service worker fica em static/sw.js, mas é servido na raiz para controlar o site inteiro
    # (um SW em /static/ só alcançaria /static/*). Sem cache HTTP: atualizações chegam na hora.
    @app.get("/sw.js")
    def service_worker():
        resposta = send_from_directory(app.static_folder, "sw.js", mimetype="text/javascript", max_age=0)
        resposta.headers["Cache-Control"] = "no-cache"
        resposta.headers["Service-Worker-Allowed"] = "/"
        return resposta

    @app.get("/manifest.webmanifest")
    def manifesto():
        return send_from_directory(app.static_folder, "manifest.json", mimetype="application/manifest+json", max_age=3600)

    _avisar_configuracao_supabase(app)

    app.register_blueprint(auth_bp)
    app.register_blueprint(inclusao_bp)
    app.register_blueprint(inclusao_pagina_bp)
    app.cli.add_command(iris_cli)

    @app.errorhandler(HTTPException)
    def erro_http(exc: HTTPException):
        # Rotas de API sempre respondem em JSON; páginas mantêm o HTML padrão.
        if not request.path.startswith("/api/"):
            return exc
        return jsonify({
            "sucesso": False,
            "dados": None,
            "erro": {"codigo": exc.name.upper().replace(" ", "_"), "mensagem": exc.description},
        }), exc.code

    return app
