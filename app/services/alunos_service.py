"""
Perfis de alunos atípicos: preferências de acessibilidade reutilizáveis.

ATENÇÃO (LGPD): perfil de acessibilidade/deficiência de um aluno é dado pessoal
sensível (art. 11) de criança ou adolescente (art. 14). Recomendações:
  • use iniciais ou um código no lugar do nome completo;
  • cada professor só enxerga os próprios alunos (professor_id em todas as consultas);
  • estes dados nunca são enviados à IA — só as preferências de leitura são usadas.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from app.db import conectar, migrar
from app.services.ai_service import PerfilAcessibilidade

CONTRASTES_ALUNO = ("padrao", "alto-escuro", "alto-azul", "sepia")
FONTE_PT_MIN, FONTE_PT_MAX = 12, 60
CAMPOS = (
    "nome_aluno", "turma", "perfil_acessibilidade", "tamanho_fonte_pref",
    "contraste_pref", "observacoes_pedagogicas",
)


class AlunoInvalidoError(ValueError):
    def __init__(self, mensagem: str, campo: str | None = None):
        super().__init__(mensagem)
        self.mensagem = mensagem
        self.campo = campo


def validar_aluno(corpo: dict[str, Any], parcial: bool = False) -> dict[str, Any]:
    """Valida e normaliza os campos. parcial=True (PATCH/PUT parcial) aceita campos ausentes."""
    dados: dict[str, Any] = {}

    def texto(campo: str, maximo: int, obrigatorio: bool = False) -> None:
        if campo not in corpo:
            if obrigatorio and not parcial:
                raise AlunoInvalidoError(f"O campo '{campo}' é obrigatório.", campo)
            return
        valor = corpo[campo]
        if valor is None:
            valor = ""
        if not isinstance(valor, str):
            raise AlunoInvalidoError(f"O campo '{campo}' deve ser texto.", campo)
        valor = " ".join(valor.split()) if campo != "observacoes_pedagogicas" else valor.strip()
        if obrigatorio and not valor:
            raise AlunoInvalidoError(f"O campo '{campo}' é obrigatório.", campo)
        if len(valor) > maximo:
            raise AlunoInvalidoError(f"O campo '{campo}' aceita até {maximo} caracteres.", campo)
        dados[campo] = valor

    texto("nome_aluno", 120, obrigatorio=True)
    texto("turma", 40)
    texto("observacoes_pedagogicas", 2000)

    if "perfil_acessibilidade" in corpo or not parcial:
        valor = corpo.get("perfil_acessibilidade")
        try:
            dados["perfil_acessibilidade"] = PerfilAcessibilidade(str(valor).strip().upper()).value
        except ValueError:
            validos = ", ".join(p.value for p in PerfilAcessibilidade)
            raise AlunoInvalidoError(f"Perfil inválido. Use: {validos}.", "perfil_acessibilidade") from None

    if "tamanho_fonte_pref" in corpo:
        valor = corpo["tamanho_fonte_pref"]
        if isinstance(valor, bool) or not isinstance(valor, (int, float)) or int(valor) != valor \
                or not FONTE_PT_MIN <= valor <= FONTE_PT_MAX:
            raise AlunoInvalidoError(
                f"O tamanho de fonte deve ser um inteiro entre {FONTE_PT_MIN} e {FONTE_PT_MAX} pt.",
                "tamanho_fonte_pref",
            )
        dados["tamanho_fonte_pref"] = int(valor)

    if "contraste_pref" in corpo:
        if corpo["contraste_pref"] not in CONTRASTES_ALUNO:
            raise AlunoInvalidoError(f"Contraste inválido. Use: {', '.join(CONTRASTES_ALUNO)}.", "contraste_pref")
        dados["contraste_pref"] = corpo["contraste_pref"]

    return dados


class RepositorioAlunos:
    def __init__(self, caminho_db: str):
        self.caminho_db = caminho_db
        migrar(caminho_db)

    @staticmethod
    def _para_dict(linha) -> dict[str, Any]:
        return {chave: linha[chave] for chave in linha.keys()}

    def listar(self, professor_id: int, turma: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM alunos_atipicos WHERE professor_id = ?"
        parametros: tuple = (professor_id,)
        if turma:
            sql += " AND turma = ?"
            parametros += (turma,)
        sql += " ORDER BY turma COLLATE NOCASE, nome_aluno COLLATE NOCASE"
        with closing(conectar(self.caminho_db)) as c:
            return [self._para_dict(l) for l in c.execute(sql, parametros).fetchall()]

    def obter(self, id_aluno: int, professor_id: int) -> dict[str, Any] | None:
        with closing(conectar(self.caminho_db)) as c:
            linha = c.execute(
                "SELECT * FROM alunos_atipicos WHERE id = ? AND professor_id = ?", (id_aluno, professor_id)
            ).fetchone()
        return self._para_dict(linha) if linha else None

    def criar(self, corpo: dict[str, Any], professor_id: int) -> dict[str, Any]:
        dados = validar_aluno(corpo)
        agora = datetime.now(timezone.utc).isoformat()
        registro = {
            "turma": "", "tamanho_fonte_pref": 14, "contraste_pref": "padrao",
            "observacoes_pedagogicas": "", **dados, "criado_em": agora, "atualizado_em": agora,
            "professor_id": professor_id,
        }
        colunas = ", ".join(registro)
        marcadores = ", ".join("?" for _ in registro)
        with closing(conectar(self.caminho_db)) as c, c:
            cursor = c.execute(f"INSERT INTO alunos_atipicos ({colunas}) VALUES ({marcadores})", tuple(registro.values()))
            novo_id = cursor.lastrowid
        return self.obter(novo_id, professor_id)

    def atualizar(self, id_aluno: int, corpo: dict[str, Any], professor_id: int) -> dict[str, Any] | None:
        dados = validar_aluno(corpo, parcial=True)
        if not dados:
            raise AlunoInvalidoError("Nenhum campo para atualizar.")
        dados["atualizado_em"] = datetime.now(timezone.utc).isoformat()
        atribuicoes = ", ".join(f"{coluna} = ?" for coluna in dados)  # colunas vêm da validação, não do cliente
        with closing(conectar(self.caminho_db)) as c, c:
            cursor = c.execute(
                f"UPDATE alunos_atipicos SET {atribuicoes} WHERE id = ? AND professor_id = ?",
                (*dados.values(), id_aluno, professor_id),
            )
            if cursor.rowcount == 0:
                return None
        return self.obter(id_aluno, professor_id)

    def excluir(self, id_aluno: int, professor_id: int) -> bool:
        with closing(conectar(self.caminho_db)) as c, c:
            return c.execute(
                "DELETE FROM alunos_atipicos WHERE id = ? AND professor_id = ?", (id_aluno, professor_id)
            ).rowcount > 0
