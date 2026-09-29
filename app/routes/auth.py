"""
Página inicial (/) e autenticação de professores: /login, /register, /logout e
/redefinir-senha (pedido) → /redefinir-senha/nova (nova senha, a partir do link do e-mail).

Com SUPABASE_URL/SUPABASE_KEY definidas, e-mail e senha são conferidos pelo Supabase Auth
(app/services/supabase_service.py) e o professor é espelhado na tabela local `usuarios`;
sem elas (ou com IRIS_AUTH=local), vale a autenticação local em SQLite. A redefinição de
senha só existe com o Supabase (é ele quem envia o e-mail).

Proteções:
  • token CSRF de sessão em todos os formulários (comparação em tempo constante);
  • limite de 5 tentativas de login falhas por IP + e-mail a cada 15 minutos;
  • "next" aceita somente caminhos internos (evita redirecionamento aberto);
  • cadastro pode exigir um código de convite (IRIS_CODIGO_CONVITE).
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
import threading
import time
from collections import defaultdict, deque

from flask import Blueprint, abort, current_app, redirect, render_template, request, session, url_for
from flask_login import current_user, login_required, login_user, logout_user

from app.services import supabase_service
from app.services.supabase_service import AutenticacaoError, SupabaseIndisponivelError
from app.services.usuarios_service import (
    SENHA_MINIMA,
    CadastroInvalidoError,
    RepositorioUsuarios,
    validar_cadastro,
)

logger = logging.getLogger(__name__)
auth_bp = Blueprint("auth", __name__)

JANELA_BLOQUEIO_S = 15 * 60
MAX_FALHAS = 5
_falhas: dict[tuple[str, str], deque] = defaultdict(deque)
_trava = threading.Lock()


def token_csrf() -> str:
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


def _csrf_valido() -> bool:
    enviado = request.form.get("csrf_token", "")
    esperado = session.get("csrf", "")
    return bool(enviado and esperado) and hmac.compare_digest(enviado, esperado)


def _destino_seguro(destino: str | None) -> str:
    if destino and destino.startswith("/") and not destino.startswith("//") and "\\" not in destino:
        return destino
    return url_for("inclusao_pagina.pagina")


def _repo() -> RepositorioUsuarios:
    return current_app.extensions["usuarios_repo"]


def _bloqueado(chave: tuple[str, str]) -> bool:
    limite = time.monotonic() - JANELA_BLOQUEIO_S
    with _trava:
        tentativas = _falhas[chave]
        while tentativas and tentativas[0] < limite:
            tentativas.popleft()
        return len(tentativas) >= MAX_FALHAS


def _registrar_falha(chave: tuple[str, str]) -> None:
    with _trava:
        _falhas[chave].append(time.monotonic())


def _url_publica(endpoint: str, **valores) -> str:
    """URL absoluta para links de e-mail (IRIS_URL_PUBLICA atrás de proxy; senão, o host da requisição)."""
    base = os.getenv("IRIS_URL_PUBLICA", "").rstrip("/")
    return base + url_for(endpoint, **valores) if base else url_for(endpoint, _external=True, **valores)


def _validar_senha_nova(senha: str, confirmacao: str) -> None:
    if len(senha or "") < SENHA_MINIMA:
        raise CadastroInvalidoError(f"A senha deve ter pelo menos {SENHA_MINIMA} caracteres.", "senha")
    if len(senha) > 256:
        raise CadastroInvalidoError("A senha é longa demais.", "senha")
    if senha != confirmacao:
        raise CadastroInvalidoError("As senhas não conferem.", "confirmacao")


def _entrar(usuario, lembrar: bool) -> None:
    session.clear()  # nova sessão (e novo token CSRF) a cada login
    login_user(usuario, remember=lembrar)
    session["csrf"] = secrets.token_urlsafe(32)


@auth_bp.get("/")
def home():
    """Landing page institucional; professor já autenticado vai direto ao painel."""
    if current_user.is_authenticated:
        return redirect(url_for("inclusao_pagina.pagina"))
    return render_template(
        "home.html", convite_exigido=bool(os.getenv("IRIS_CODIGO_CONVITE")),
        saiu=request.args.get("saiu") == "1",
    )


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    destino = request.values.get("next", "")
    if current_user.is_authenticated:
        return redirect(_destino_seguro(destino))

    erro, email, status = None, "", 200
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        chave = (request.remote_addr or "?", email)
        if not _csrf_valido():
            erro, status = "O formulário expirou. Tente novamente.", 400
        elif _bloqueado(chave):
            erro, status = "Muitas tentativas sem sucesso. Aguarde 15 minutos e tente de novo.", 429
        else:
            senha = request.form.get("senha", "")
            try:
                if supabase_service.auth_supabase_ativo():
                    conta = supabase_service.entrar(email, senha)
                    usuario = _repo().sincronizar_supabase(conta.uid, conta.email, conta.nome)
                else:
                    usuario = _repo().autenticar(email, senha)
                    if usuario is None:
                        raise AutenticacaoError("E-mail ou senha incorretos.")
            except AutenticacaoError as exc:
                _registrar_falha(chave)
                logger.warning("Login falhou para %s (%s)", email, request.remote_addr)
                erro, status = exc.mensagem, 401
            except SupabaseIndisponivelError as exc:
                erro, status = str(exc), 503
            else:
                _entrar(usuario, lembrar=bool(request.form.get("lembrar")))
                return redirect(_destino_seguro(destino))

    return render_template(
        "auth/login.html", erro=erro, email=email, destino=destino,
        saiu=request.args.get("saiu") == "1", expirou=request.args.get("expirou") == "1",
        confirmado=request.args.get("confirmado") == "1", senha_redefinida=request.args.get("senha") == "redefinida",
        redefinicao_disponivel=supabase_service.configurado(),
    ), status


@auth_bp.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("inclusao_pagina.pagina"))

    convite_exigido = bool(os.getenv("IRIS_CODIGO_CONVITE"))
    erro, campo, status, aviso = None, None, 200, None
    valores = {"nome": "", "email": ""}
    if request.method == "POST":
        valores = {"nome": request.form.get("nome", ""), "email": request.form.get("email", "")}
        if not _csrf_valido():
            erro, status = "O formulário expirou. Tente novamente.", 400
        elif convite_exigido and not hmac.compare_digest(
            request.form.get("codigo_convite", "").strip(), os.environ["IRIS_CODIGO_CONVITE"]
        ):
            erro, campo, status = "Código de convite inválido.", "codigo_convite", 400
        else:
            senha, confirmacao = request.form.get("senha", ""), request.form.get("confirmacao", "")
            try:
                if supabase_service.auth_supabase_ativo():
                    nome, email = validar_cadastro(valores["nome"], valores["email"], senha, confirmacao)
                    conta, sessao_ativa = supabase_service.cadastrar(
                        nome, email, senha, _url_publica("auth.login", confirmado=1),
                    )
                    if not sessao_ativa:
                        # O projeto exige confirmação por e-mail: o login fica para depois do link.
                        aviso = f"Enviamos um link de confirmação para {email}. Abra-o e depois entre com sua senha."
                        return render_template(
                            "auth/register.html", erro=None, campo_erro=None, valores={"nome": "", "email": ""},
                            aviso=aviso, convite_exigido=convite_exigido, senha_minima=SENHA_MINIMA,
                        ), 200
                    usuario = _repo().sincronizar_supabase(conta.uid, conta.email, conta.nome)
                else:
                    usuario = _repo().criar(valores["nome"], valores["email"], senha, confirmacao)
            except (CadastroInvalidoError, AutenticacaoError) as exc:
                erro, campo, status = exc.mensagem, exc.campo, 400
            except SupabaseIndisponivelError as exc:
                erro, status = str(exc), 503
            else:
                _entrar(usuario, lembrar=False)
                return redirect(url_for("inclusao_pagina.pagina"))

    return render_template(
        "auth/register.html", erro=erro, campo_erro=campo, valores=valores, aviso=aviso,
        convite_exigido=convite_exigido, senha_minima=SENHA_MINIMA,
    ), status


@auth_bp.route("/redefinir-senha", methods=["GET", "POST"])
def redefinir_senha():
    """Pede o e-mail e manda o link do Supabase. A resposta é a mesma exista ou não a conta."""
    if not supabase_service.configurado():
        abort(404)
    erro, enviado, email, status = None, False, "", 200
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        chave = (request.remote_addr or "?", f"redefinir:{email}")
        if not _csrf_valido():
            erro, status = "O formulário expirou. Tente novamente.", 400
        elif _bloqueado(chave):
            erro, status = "Muitos pedidos. Aguarde 15 minutos e tente de novo.", 429
        elif not email or "@" not in email:
            erro, status = "Informe um e-mail válido.", 400
        else:
            _registrar_falha(chave)  # conta todo pedido: limita o envio de e-mails
            try:
                supabase_service.enviar_redefinicao(email, _url_publica("auth.nova_senha"))
                enviado = True
            except (AutenticacaoError, SupabaseIndisponivelError) as exc:
                erro, status = getattr(exc, "mensagem", str(exc)), 503
    return render_template("auth/redefinir_senha.html", erro=erro, enviado=enviado, email=email), status


@auth_bp.route("/redefinir-senha/nova", methods=["GET", "POST"])
def nova_senha():
    """
    Destino do link do e-mail. GET mostra o formulário (os tokens chegam no fragmento #… e um
    script os copia para campos ocultos, ou chegam como ?token_hash=…). POST troca a senha.
    """
    if not supabase_service.configurado():
        abort(404)
    erro, campo, status = None, None, 200
    token_hash = request.values.get("token_hash", "")
    if request.method == "POST":
        if not _csrf_valido():
            erro, status = "O formulário expirou. Abra o link do e-mail novamente.", 400
        else:
            try:
                _validar_senha_nova(request.form.get("senha", ""), request.form.get("confirmacao", ""))
                supabase_service.redefinir_senha(
                    request.form["senha"],
                    access_token=request.form.get("access_token", ""),
                    refresh_token=request.form.get("refresh_token", ""),
                    token_hash=token_hash,
                )
            except (CadastroInvalidoError, AutenticacaoError) as exc:
                erro, campo, status = exc.mensagem, exc.campo, 400
            except SupabaseIndisponivelError as exc:
                erro, status = str(exc), 503
            else:
                logout_user()
                session.clear()
                return redirect(url_for("auth.login", senha="redefinida"))
    resposta = current_app.make_response((render_template(
        "auth/nova_senha.html", erro=erro, campo_erro=campo, token_hash=token_hash, senha_minima=SENHA_MINIMA,
    ), status))
    # Tokens de recuperação na página: sem cache e sem vazar pela referência.
    resposta.headers["Cache-Control"] = "no-store"
    resposta.headers["Referrer-Policy"] = "no-referrer"
    return resposta


@auth_bp.post("/logout")
@login_required
def logout():
    if not _csrf_valido():
        return redirect(url_for("inclusao_pagina.pagina"))
    logout_user()
    session.clear()
    return redirect(url_for("auth.home", saiu=1))
