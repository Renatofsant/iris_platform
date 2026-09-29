"""
Usuários da Plataforma Íris (professores e pesquisadores) para o Flask-Login.

Senhas: hash scrypt do Werkzeug (sal aleatório por senha). O login leva o mesmo
tempo para e-mail inexistente e senha errada, para não revelar quem tem conta.
"""

from __future__ import annotations

import re
import secrets
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone

from flask_login import UserMixin
from werkzeug.security import check_password_hash, generate_password_hash

from app.db import conectar, migrar

SENHA_MINIMA = 10
PADRAO_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
# Hash de uma senha qualquer: usado para gastar o mesmo tempo quando o e-mail não existe.
_HASH_FICTICIO = generate_password_hash("iris-senha-inexistente")


class CadastroInvalidoError(ValueError):
    def __init__(self, mensagem: str, campo: str | None = None):
        super().__init__(mensagem)
        self.mensagem = mensagem
        self.campo = campo


@dataclass
class Usuario(UserMixin):
    id: int
    nome: str
    email: str
    papel: str

    @property
    def pesquisador(self) -> bool:
        return self.papel == "pesquisador"

    def get_id(self) -> str:
        return str(self.id)


def validar_cadastro(nome: str, email: str, senha: str, confirmacao: str) -> tuple[str, str]:
    nome = " ".join((nome or "").split())
    email = (email or "").strip().lower()
    if not 2 <= len(nome) <= 120:
        raise CadastroInvalidoError("Informe seu nome (2 a 120 caracteres).", "nome")
    if len(email) > 254 or not PADRAO_EMAIL.match(email):
        raise CadastroInvalidoError("Informe um e-mail válido.", "email")
    if len(senha or "") < SENHA_MINIMA:
        raise CadastroInvalidoError(f"A senha deve ter pelo menos {SENHA_MINIMA} caracteres.", "senha")
    if len(senha) > 256:
        raise CadastroInvalidoError("A senha é longa demais.", "senha")
    if senha.lower() in email or (nome and senha.lower() == nome.lower()):
        raise CadastroInvalidoError("A senha não pode ser igual ao seu nome ou e-mail.", "senha")
    if senha != confirmacao:
        raise CadastroInvalidoError("As senhas não conferem.", "confirmacao")
    return nome, email


class RepositorioUsuarios:
    def __init__(self, caminho_db: str):
        self.caminho_db = caminho_db
        migrar(caminho_db)

    @staticmethod
    def _usuario(linha) -> Usuario:
        return Usuario(id=linha["id"], nome=linha["nome"], email=linha["email"], papel=linha["papel"])

    def criar(self, nome: str, email: str, senha: str, confirmacao: str) -> Usuario:
        nome, email = validar_cadastro(nome, email, senha, confirmacao)
        agora = datetime.now(timezone.utc).isoformat()
        try:
            with closing(conectar(self.caminho_db)) as c, c:
                cursor = c.execute(
                    "INSERT INTO usuarios (nome, email, senha_hash, criado_em) VALUES (?, ?, ?, ?)",
                    (nome, email, generate_password_hash(senha), agora),
                )
                novo_id = cursor.lastrowid
        except Exception as exc:  # sqlite3.IntegrityError: e-mail já cadastrado
            if "UNIQUE" in str(exc):
                raise CadastroInvalidoError("Já existe uma conta com este e-mail.", "email") from None
            raise
        return self.obter(novo_id)

    def obter(self, id_usuario: int | str) -> Usuario | None:
        try:
            id_usuario = int(id_usuario)
        except (TypeError, ValueError):
            return None
        with closing(conectar(self.caminho_db)) as c:
            linha = c.execute("SELECT * FROM usuarios WHERE id = ?", (id_usuario,)).fetchone()
        return self._usuario(linha) if linha else None

    def obter_por_email(self, email: str) -> Usuario | None:
        with closing(conectar(self.caminho_db)) as c:
            linha = c.execute("SELECT * FROM usuarios WHERE email = ?", ((email or "").strip().lower(),)).fetchone()
        return self._usuario(linha) if linha else None

    def autenticar(self, email: str, senha: str) -> Usuario | None:
        with closing(conectar(self.caminho_db)) as c:
            linha = c.execute(
                "SELECT * FROM usuarios WHERE email = ?", ((email or "").strip().lower(),)
            ).fetchone()
        if linha is None:
            check_password_hash(_HASH_FICTICIO, senha or "")  # tempo constante
            return None
        if not check_password_hash(linha["senha_hash"], senha or ""):
            return None
        with closing(conectar(self.caminho_db)) as c, c:
            c.execute(
                "UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?",
                (datetime.now(timezone.utc).isoformat(), linha["id"]),
            )
        return self._usuario(linha)

    def sincronizar_supabase(self, uid: str, email: str, nome: str) -> Usuario:
        """
        Espelho local de um professor autenticado pelo Supabase Auth: acha pelo uid; senão, vincula
        a conta local com o mesmo e-mail (mantém alunos, materiais e métricas); senão, cria.
        A senha local vira um hash aleatório: com o Supabase ativo, ela nunca é usada.
        """
        email = (email or "").strip().lower()
        agora = datetime.now(timezone.utc).isoformat()
        with closing(conectar(self.caminho_db)) as c, c:
            linha = c.execute("SELECT * FROM usuarios WHERE supabase_uid = ?", (uid,)).fetchone()
            if linha is None:
                linha = c.execute(
                    "SELECT * FROM usuarios WHERE email = ? AND supabase_uid IS NULL", (email,)
                ).fetchone()
                if linha is not None:
                    c.execute("UPDATE usuarios SET supabase_uid = ? WHERE id = ?", (uid, linha["id"]))
            if linha is None:
                cursor = c.execute(
                    "INSERT INTO usuarios (nome, email, senha_hash, criado_em, supabase_uid) VALUES (?, ?, ?, ?, ?)",
                    ((nome or email)[:120], email, generate_password_hash(secrets.token_urlsafe(32)), agora, uid),
                )
                id_usuario = cursor.lastrowid
            else:
                id_usuario = linha["id"]
                # O e-mail pode ter sido trocado no Supabase: o espelho acompanha.
                if linha["email"] != email:
                    c.execute("UPDATE usuarios SET email = ? WHERE id = ?", (email, id_usuario))
            c.execute("UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?", (agora, id_usuario))
        return self.obter(id_usuario)

    def definir_papel(self, email: str, papel: str) -> bool:
        with closing(conectar(self.caminho_db)) as c, c:
            return c.execute(
                "UPDATE usuarios SET papel = ? WHERE email = ?", (papel, email.strip().lower())
            ).rowcount > 0

    def atribuir_orfaos(self, id_usuario: int) -> dict[str, int]:
        """Registros criados antes da autenticação (professor_id NULL) passam a este usuário."""
        totais = {}
        with closing(conectar(self.caminho_db)) as c, c:
            for tabela in ("alunos_atipicos", "materiais_impressao", "metricas_uso"):
                totais[tabela] = c.execute(
                    f"UPDATE {tabela} SET professor_id = ? WHERE professor_id IS NULL", (id_usuario,)
                ).rowcount
        return totais
