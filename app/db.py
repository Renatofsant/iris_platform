"""
Banco de dados SQLite da Plataforma Íris e suas migrações.

As migrações são aplicadas em ordem e registradas em `PRAGMA user_version`, então
rodar `migrar()` várias vezes é seguro. Para alterar o esquema, acrescente uma nova
função ao final de MIGRACOES — nunca edite uma migração que já foi publicada.

Tabelas:
    materiais_impressao  Provas/atividades salvas para impressão (expiram).
    alunos_atipicos      Preferências de acessibilidade por aluno (DADO PESSOAL SENSÍVEL — LGPD art. 11 e 14).
    metricas_uso         Métricas de uso e avaliação docente (exportadas pseudonimizadas).
    usuarios             Professores e pesquisadores (senhas com hash scrypt).
    eventos_acessibilidade  Uso dos recursos de acessibilidade (anônimo: sem aluno, sem texto) — painel AEE.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from contextlib import closing
from typing import Callable

logger = logging.getLogger(__name__)
_trava = threading.Lock()


def conectar(caminho_db: str) -> sqlite3.Connection:
    conexao = sqlite3.connect(caminho_db, timeout=10)
    conexao.row_factory = sqlite3.Row
    conexao.execute("PRAGMA foreign_keys = ON")
    return conexao


def _v1_materiais_impressao(c: sqlite3.Connection) -> None:
    # IF NOT EXISTS: bancos criados antes do controle de versão já têm esta tabela.
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS materiais_impressao (
            id             TEXT PRIMARY KEY,
            titulo         TEXT NOT NULL,
            perfil_codigo  TEXT NOT NULL,
            perfil_nome    TEXT NOT NULL,
            conteudo_html  TEXT NOT NULL,
            preferencias   TEXT NOT NULL,
            criado_em      TEXT NOT NULL,
            expira_em      TEXT NOT NULL
        )
        """
    )
    c.execute("CREATE INDEX IF NOT EXISTS ix_materiais_expira ON materiais_impressao (expira_em)")


def _v2_alunos_atipicos(c: sqlite3.Connection) -> None:
    c.execute(
        """
        CREATE TABLE alunos_atipicos (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_aluno               TEXT    NOT NULL,
            turma                    TEXT    NOT NULL DEFAULT '',
            perfil_acessibilidade    TEXT    NOT NULL,
            tamanho_fonte_pref       INTEGER NOT NULL DEFAULT 14 CHECK (tamanho_fonte_pref BETWEEN 12 AND 60),
            contraste_pref           TEXT    NOT NULL DEFAULT 'padrao'
                                     CHECK (contraste_pref IN ('padrao', 'alto-escuro', 'alto-azul', 'sepia')),
            observacoes_pedagogicas  TEXT    NOT NULL DEFAULT '',
            criado_em                TEXT    NOT NULL,
            atualizado_em            TEXT    NOT NULL
        )
        """
    )
    c.execute("CREATE INDEX ix_alunos_turma_nome ON alunos_atipicos (turma, nome_aluno)")


def _v3_metricas_uso(c: sqlite3.Connection) -> None:
    # Sem vínculo com alunos_atipicos: as métricas são anônimas por construção.
    c.execute(
        """
        CREATE TABLE metricas_uso (
            id                          TEXT    PRIMARY KEY,
            perfil_usado                TEXT    NOT NULL,
            tipo_entrada                TEXT    NOT NULL DEFAULT 'texto' CHECK (tipo_entrada IN ('texto', 'imagem')),
            origem                      TEXT    NOT NULL CHECK (origem IN ('ia', 'fallback')),
            modelo                      TEXT,
            caracteres_originais        INTEGER NOT NULL,
            tempo_processamento_ms      INTEGER NOT NULL,
            nota_avaliacao_professor    INTEGER CHECK (nota_avaliacao_professor BETWEEN 1 AND 5),
            tempo_manual_estimado_min   INTEGER CHECK (tempo_manual_estimado_min BETWEEN 0 AND 1440),
            tempo_estimado_poupado_min  REAL,
            data_registro               TEXT    NOT NULL,
            avaliado_em                 TEXT
        )
        """
    )
    c.execute("CREATE INDEX ix_metricas_perfil_data ON metricas_uso (perfil_usado, data_registro)")


def _v4_usuarios_e_propriedade(c: sqlite3.Connection) -> None:
    c.execute(
        """
        CREATE TABLE usuarios (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            nome           TEXT NOT NULL,
            email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
            senha_hash     TEXT NOT NULL,
            papel          TEXT NOT NULL DEFAULT 'professor' CHECK (papel IN ('professor', 'pesquisador')),
            criado_em      TEXT NOT NULL,
            ultimo_acesso  TEXT
        )
        """
    )
    # Dono de cada registro. Linhas antigas ficam com NULL (invisíveis a todos) até serem
    # atribuídas com: flask --app run iris atribuir-orfaos <email>
    for tabela in ("alunos_atipicos", "materiais_impressao", "metricas_uso"):
        c.execute(
            f"ALTER TABLE {tabela} ADD COLUMN professor_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE"
        )
        c.execute(f"CREATE INDEX ix_{tabela}_professor ON {tabela} (professor_id)")


def _v5_guia_no_material(c: sqlite3.Connection) -> None:
    # "Orientações para o Mediador/Professor" (JSON) guardadas junto do material impresso.
    c.execute("ALTER TABLE materiais_impressao ADD COLUMN guia_mediador TEXT")


def _v6_eventos_acessibilidade(c: sqlite3.Connection) -> None:
    # Anônimo por construção: nenhum vínculo com alunos_atipicos, nenhum texto livre.
    # O perfil é o de acessibilidade do material em uso (agrupamento para o PEI), não do aluno.
    c.execute(
        """
        CREATE TABLE eventos_acessibilidade (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            professor_id  INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
            perfil        TEXT    NOT NULL DEFAULT '',
            recurso       TEXT    NOT NULL,
            valor         TEXT    NOT NULL DEFAULT '',
            data_registro TEXT    NOT NULL
        )
        """
    )
    c.execute("CREATE INDEX ix_eventos_professor_data ON eventos_acessibilidade (professor_id, data_registro)")


def _v7_usuarios_supabase(c: sqlite3.Connection) -> None:
    # Vínculo com o Supabase Auth (auth.users.id). Contas locais antigas ficam com NULL até o
    # primeiro login pelo Supabase com o mesmo e-mail, quando são vinculadas (dados preservados).
    c.execute("ALTER TABLE usuarios ADD COLUMN supabase_uid TEXT")
    c.execute("CREATE UNIQUE INDEX ux_usuarios_supabase_uid ON usuarios (supabase_uid) WHERE supabase_uid IS NOT NULL")


MIGRACOES: list[Callable[[sqlite3.Connection], None]] = [
    _v1_materiais_impressao,
    _v2_alunos_atipicos,
    _v3_metricas_uso,
    _v4_usuarios_e_propriedade,
    _v5_guia_no_material,
    _v6_eventos_acessibilidade,
    _v7_usuarios_supabase,
]


def migrar(caminho_db: str) -> int:
    """Aplica as migrações pendentes. Retorna a versão final do esquema."""
    os.makedirs(os.path.dirname(os.path.abspath(caminho_db)), exist_ok=True)
    with _trava, closing(conectar(caminho_db)) as conexao:
        # Transação explícita: no modo padrão do sqlite3, DDL não abre transação sozinho.
        conexao.isolation_level = None
        versao = conexao.execute("PRAGMA user_version").fetchone()[0]
        for numero, migracao in enumerate(MIGRACOES[versao:], start=versao + 1):
            conexao.execute("BEGIN")
            try:
                migracao(conexao)
                conexao.execute(f"PRAGMA user_version = {numero}")
                conexao.execute("COMMIT")
            except Exception:
                conexao.execute("ROLLBACK")
                raise
            logger.info("Migração %s aplicada em %s", migracao.__name__, caminho_db)
        return max(versao, len(MIGRACOES))
