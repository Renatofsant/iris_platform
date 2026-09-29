"""
Métricas de uso e avaliação docente — base para a evolução da plataforma.

Cada adaptação gera um registro sem aluno, sem texto e sem IP — ligado apenas ao professor
(para que ele veja o próprio histórico). Na exportação para a pesquisa, o professor vira um
pseudônimo estável (HMAC), permitindo análises por docente sem identificá-lo. Registro:
tamanho da entrada, tempo de processamento e origem (IA ou regras locais). O
professor pode depois avaliar a utilidade (1–5) e estimar quanto tempo levaria
para adaptar manualmente.

tempo_estimado_poupado_min = tempo_manual_estimado_min − tempo_processamento (em min).
Limitação metodológica: não desconta o tempo que o professor gasta revisando o material.
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import re
import secrets
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from app.db import conectar, migrar

PADRAO_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
COLUNAS_EXPORTACAO = (
    "id", "perfil_usado", "tipo_entrada", "origem", "modelo", "caracteres_originais",
    "tempo_processamento_ms", "nota_avaliacao_professor", "tempo_manual_estimado_min",
    "tempo_estimado_poupado_min", "data_registro", "avaliado_em",
)


def pseudonimo_professor(professor_id: int | None, segredo: str) -> str:
    if professor_id is None:
        return ""
    return "P-" + hmac.new(segredo.encode(), str(professor_id).encode(), hashlib.sha256).hexdigest()[:10]


class AvaliacaoInvalidaError(ValueError):
    def __init__(self, mensagem: str, campo: str | None = None):
        super().__init__(mensagem)
        self.mensagem = mensagem
        self.campo = campo


class RepositorioMetricas:
    def __init__(self, caminho_db: str):
        self.caminho_db = caminho_db
        migrar(caminho_db)

    def registrar(
        self,
        perfil_usado: str,
        caracteres_originais: int,
        tempo_processamento_ms: int,
        origem: str,
        modelo: str | None = None,
        tipo_entrada: str = "texto",
        professor_id: int | None = None,
    ) -> str:
        id_metrica = secrets.token_urlsafe(16)  # aleatório: impede avaliar registros de terceiros
        with closing(conectar(self.caminho_db)) as c, c:
            c.execute(
                """
                INSERT INTO metricas_uso (id, perfil_usado, tipo_entrada, origem, modelo,
                    caracteres_originais, tempo_processamento_ms, data_registro, professor_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    id_metrica, perfil_usado, tipo_entrada, origem, modelo,
                    int(caracteres_originais), int(tempo_processamento_ms),
                    datetime.now(timezone.utc).isoformat(), professor_id,
                ),
            )
        return id_metrica

    def avaliar(self, id_metrica: str, corpo: dict[str, Any], professor_id: int) -> dict[str, Any] | None:
        if not PADRAO_ID.match(id_metrica or ""):
            return None

        nota = corpo.get("nota_avaliacao_professor")
        if isinstance(nota, bool) or not isinstance(nota, int) or not 1 <= nota <= 5:
            raise AvaliacaoInvalidaError("A nota deve ser um número inteiro de 1 a 5.", "nota_avaliacao_professor")

        minutos = corpo.get("tempo_manual_estimado_min")
        if minutos is not None:
            if isinstance(minutos, bool) or not isinstance(minutos, (int, float)) or not 0 <= minutos <= 1440:
                raise AvaliacaoInvalidaError(
                    "O tempo manual deve estar entre 0 e 1440 minutos.", "tempo_manual_estimado_min"
                )
            minutos = int(round(minutos))

        with closing(conectar(self.caminho_db)) as c, c:
            linha = c.execute(
                "SELECT tempo_processamento_ms FROM metricas_uso WHERE id = ? AND professor_id = ?",
                (id_metrica, professor_id),
            ).fetchone()
            if linha is None:
                return None
            poupado = (
                round(max(minutos - linha["tempo_processamento_ms"] / 60000, 0), 2)
                if minutos is not None else None
            )
            # Reavaliar sobrescreve: vale a última opinião do professor.
            c.execute(
                """
                UPDATE metricas_uso
                   SET nota_avaliacao_professor = ?, tempo_manual_estimado_min = ?,
                       tempo_estimado_poupado_min = ?, avaliado_em = ?
                 WHERE id = ?
                """,
                (nota, minutos, poupado, datetime.now(timezone.utc).isoformat(), id_metrica),
            )
        return {
            "id": id_metrica,
            "nota_avaliacao_professor": nota,
            "tempo_manual_estimado_min": minutos,
            "tempo_estimado_poupado_min": poupado,
        }

    def resumo(self, professor_id: int | None = None) -> dict[str, Any]:
        """professor_id=None: todos os professores (somente para o papel pesquisador)."""
        filtro, parametros = ("WHERE professor_id = ?", (professor_id,)) if professor_id is not None else ("", ())
        with closing(conectar(self.caminho_db)) as c:
            por_perfil = [
                dict(l) for l in c.execute(
                    """
                    SELECT perfil_usado,
                           COUNT(*)                                   AS adaptacoes,
                           SUM(origem = 'ia')                         AS via_ia,
                           SUM(origem = 'fallback')                   AS via_fallback,
                           COUNT(nota_avaliacao_professor)            AS avaliadas,
                           ROUND(AVG(nota_avaliacao_professor), 2)    AS nota_media,
                           ROUND(AVG(tempo_processamento_ms))         AS tempo_medio_ms,
                           ROUND(SUM(tempo_estimado_poupado_min), 1)  AS minutos_poupados
                      FROM metricas_uso
                      {filtro}
                  GROUP BY perfil_usado
                  ORDER BY adaptacoes DESC
                    """.format(filtro=filtro),
                    parametros,
                )
            ]
            distribuicao = {
                l["nota_avaliacao_professor"]: l["total"] for l in c.execute(
                    """
                    SELECT nota_avaliacao_professor, COUNT(*) AS total FROM metricas_uso
                     WHERE nota_avaliacao_professor IS NOT NULL {e_filtro} GROUP BY 1
                    """.format(e_filtro="AND professor_id = ?" if professor_id is not None else ""),
                    parametros,
                )
            }
        return {
            "por_perfil": por_perfil,
            "distribuicao_notas": {str(n): distribuicao.get(n, 0) for n in range(1, 6)},
            "total_adaptacoes": sum(p["adaptacoes"] for p in por_perfil),
            "total_avaliadas": sum(p["avaliadas"] for p in por_perfil),
            "minutos_poupados_total": round(sum(p["minutos_poupados"] or 0 for p in por_perfil), 1),
        }

    def exportar_csv(self, segredo: str, professor_id: int | None = None) -> str:
        """professor_id=None exporta todos (pesquisador); o docente sai como pseudônimo."""
        filtro, parametros = ("WHERE professor_id = ?", (professor_id,)) if professor_id is not None else ("", ())
        with closing(conectar(self.caminho_db)) as c:
            linhas = c.execute(
                f"SELECT {', '.join(COLUNAS_EXPORTACAO)}, professor_id FROM metricas_uso {filtro} ORDER BY data_registro",
                parametros,
            ).fetchall()
        saida = io.StringIO()
        escritor = csv.writer(saida, delimiter=";", lineterminator="\n")  # ";" abre direto no Excel pt-BR
        escritor.writerow((*COLUNAS_EXPORTACAO, "professor_pseudonimo"))
        for linha in linhas:
            *valores, dono = tuple(linha)
            escritor.writerow((*valores, pseudonimo_professor(dono, segredo)))
        return saida.getvalue()
