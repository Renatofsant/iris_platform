"""
Histórico e Trajetória AEE — estatísticas de uso dos recursos de acessibilidade.

Cada vez que um recurso é acionado na tela de leitura (contraste, tipografia, velocidade da voz,
régua, Libras…) o navegador envia um evento curto: recurso + valor + perfil do material em uso.
NÃO há aluno, nome, texto nem IP: os dados são anônimos por construção e ficam ligados só ao
professor (para ele ver o próprio histórico). O agrupamento por perfil de acessibilidade ajuda a
fundamentar o PEI (Plano de Ensino Individualizado) sem expor nenhum estudante.

As "sugestões para o PEI" são regras simples sobre as frequências — indícios para o professor e a
equipe do AEE avaliarem, nunca um diagnóstico.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timedelta, timezone
from typing import Any

from app.db import conectar, migrar

MAX_EVENTOS_POR_LOTE = 50
DIAS_PERMITIDOS = (7, 30, 90, 365)
SEMANAS_TRAJETORIA = 12
PADRAO_PERFIL = re.compile(r"^[A-Z0-9_]{0,40}$")

# recurso → (rótulo, categoria, valores aceitos: dict valor → rótulo | "inteiro:min:max")
RECURSOS: dict[str, tuple[str, str, Any]] = {
    "contraste": ("Contraste", "visual", {
        "padrao": "Padrão", "alto-escuro": "Preto/amarelo", "alto-azul": "Azul", "sepia": "Sépia",
    }),
    "tipografia": ("Tipografia", "visual", {
        "padrao": "Inter (padrão)", "atkinson": "Atkinson Hyperlegible", "dyslexic": "OpenDyslexic",
    }),
    "fonte": ("Tamanho da fonte", "visual", "inteiro:14:36"),
    "entrelinhas": ("Entrelinhas", "visual", {"1.5": "Normal (1,5)", "1.8": "Ampliado (1,8)", "2.0": "Máximo (2,0)"}),
    "velocidade_voz": ("Velocidade da voz", "auditivo", {
        "0.75": "0,75×", "1": "1×", "1.25": "1,25×", "1.5": "1,5×",
    }),
    "leitura_voz": ("Leitura em voz alta", "auditivo", {
        "0.75": "0,75×", "1": "1×", "1.25": "1,25×", "1.5": "1,5×",
    }),
    "sonificacao": ("Sonificação de gráficos", "auditivo", {"grave": "Tons graves", "media": "Tons médios", "aguda": "Tons agudos"}),
    "regua": ("Régua de leitura", "cognitivo", {"ativado": "Ativada"}),
    "foco_minimo": ("Foco mínimo", "cognitivo", {"ativado": "Ativado"}),
    "pausa": ("Pausa regulatória", "cognitivo", {"10": "10 min", "15": "15 min", "20": "20 min", "25": "25 min"}),
    "mapa_simples": ("Mapa conceitual simplificado", "cognitivo", {"ativado": "Ativado"}),
    "termos_libras": ("Destaque de termos (Libras)", "linguagem", {"ativado": "Ativado"}),
    "vlibras": ("VLibras", "linguagem", {"ativado": "Ativado"}),
    "exportacao": ("Exportação", "material", {
        "braille": "Braille (.BRF)", "docx": "Word (.docx)", "impressao": "Impressão / PDF",
    }),
}
CATEGORIAS = {
    "visual": "Visual", "auditivo": "Auditivo", "cognitivo": "Atenção e cognição",
    "linguagem": "Libras e linguagem", "material": "Materiais exportados",
}
FAIXAS_FONTE = ((14, 17, "14–17 px"), (18, 23, "18–23 px"), (24, 29, "24–29 px"), (30, 36, "30–36 px"))


class EventoInvalidoError(ValueError):
    def __init__(self, mensagem: str, campo: str | None = None):
        super().__init__(mensagem)
        self.mensagem = mensagem
        self.campo = campo


def _normalizar_valor(recurso: str, valor: Any) -> str | None:
    regra = RECURSOS[recurso][2]
    if isinstance(regra, str):  # "inteiro:min:max"
        _, minimo, maximo = regra.split(":")
        try:
            numero = float(valor)
        except (TypeError, ValueError):
            return None
        if not numero.is_integer() or not int(minimo) <= numero <= int(maximo):
            return None
        return str(int(numero))
    texto = str(valor).strip()
    if texto not in regra and recurso in ("velocidade_voz", "leitura_voz", "entrelinhas"):
        try:  # "1.0" → "1", "2" → "2.0"
            numero = float(texto)
            texto = next((v for v in regra if float(v) == numero), texto)
        except ValueError:
            pass
    return texto if texto in regra else None


def _rotulo_valor(recurso: str, valor: str) -> str:
    regra = RECURSOS[recurso][2]
    return f"{valor} px" if isinstance(regra, str) else regra.get(valor, valor)


def _faixa_fonte(valor: str) -> str:
    numero = int(valor)
    return next((r for a, b, r in FAIXAS_FONTE if a <= numero <= b), f"{numero} px")


def _pct(parte: int, total: int) -> float:
    return round(100 * parte / total, 1) if total else 0.0


class RepositorioAcessibilidade:
    def __init__(self, caminho_db: str):
        self.caminho_db = caminho_db
        migrar(caminho_db)

    # ------------------------------------------------------------------ gravação
    def registrar_lote(self, eventos: Any, professor_id: int, perfis_validos: set[str]) -> int:
        """
        eventos: [{"recurso": str, "valor": str|number, "perfil"?: str, "quando"?: ISO-8601}, ...]
        Eventos inválidos são descartados em silêncio (a telemetria nunca atrapalha a aula);
        "quando" permite enviar depois o que foi usado offline (até 30 dias atrás).
        Retorna quantos eventos foram gravados.
        """
        if not isinstance(eventos, list):
            raise EventoInvalidoError("Envie 'eventos' como lista.", "eventos")
        if len(eventos) > MAX_EVENTOS_POR_LOTE:
            raise EventoInvalidoError(f"No máximo {MAX_EVENTOS_POR_LOTE} eventos por envio.", "eventos")

        agora = datetime.now(timezone.utc)
        linhas = []
        for evento in eventos:
            if not isinstance(evento, dict) or evento.get("recurso") not in RECURSOS:
                continue
            recurso = evento["recurso"]
            valor = _normalizar_valor(recurso, evento.get("valor"))
            if valor is None:
                continue
            perfil = str(evento.get("perfil") or "")
            if not PADRAO_PERFIL.match(perfil) or (perfil and perfil not in perfis_validos):
                perfil = ""
            quando = agora
            if isinstance(evento.get("quando"), str):
                try:
                    lido = datetime.fromisoformat(evento["quando"].replace("Z", "+00:00"))
                    if lido.tzinfo and agora - timedelta(days=30) <= lido <= agora + timedelta(minutes=5):
                        quando = min(lido.astimezone(timezone.utc), agora)
                except ValueError:
                    pass
            linhas.append((professor_id, perfil, recurso, valor, quando.isoformat(timespec="seconds")))

        if linhas:
            with closing(conectar(self.caminho_db)) as c, c:
                c.executemany(
                    "INSERT INTO eventos_acessibilidade (professor_id, perfil, recurso, valor, data_registro)"
                    " VALUES (?, ?, ?, ?, ?)",
                    linhas,
                )
        return len(linhas)

    # ------------------------------------------------------------------ leitura
    def resumo(self, professor_id: int | None, perfil: str | None = None, dias: int = 90) -> dict[str, Any]:
        """
        professor_id=None: todos os professores (somente para o papel pesquisador).
        perfil=None: todos os perfis; "" filtra os eventos sem perfil de material.
        """
        dias = dias if dias in DIAS_PERMITIDOS else 90
        agora = datetime.now(timezone.utc)
        desde = agora - timedelta(days=dias)
        condicoes, parametros = ["data_registro >= ?"], [desde.isoformat(timespec="seconds")]
        if professor_id is not None:
            condicoes.append("professor_id = ?")
            parametros.append(professor_id)
        if perfil is not None:
            condicoes.append("perfil = ?")
            parametros.append(perfil)
        with closing(conectar(self.caminho_db)) as c:
            linhas = c.execute(
                f"SELECT perfil, recurso, valor, data_registro FROM eventos_acessibilidade"
                f" WHERE {' AND '.join(condicoes)} ORDER BY data_registro",
                parametros,
            ).fetchall()

        por_recurso: dict[str, Counter] = defaultdict(Counter)
        por_perfil: Counter = Counter()
        por_categoria: Counter = Counter()
        semanas: dict[str, Counter] = defaultdict(Counter)
        fontes: list[int] = []
        for linha in linhas:
            recurso, valor = linha["recurso"], linha["valor"]
            if recurso not in RECURSOS:
                continue
            categoria = RECURSOS[recurso][1]
            if recurso == "fonte":
                fontes.append(int(valor))
                por_recurso[recurso][_faixa_fonte(valor)] += 1
            else:
                por_recurso[recurso][_rotulo_valor(recurso, valor)] += 1
            por_perfil[linha["perfil"] or "SEM_PERFIL"] += 1
            por_categoria[categoria] += 1
            data = datetime.fromisoformat(linha["data_registro"])
            inicio_semana = (data - timedelta(days=data.weekday())).date().isoformat()
            semanas[inicio_semana][categoria] += 1

        recursos = []
        for chave, (rotulo, categoria, _) in RECURSOS.items():
            contagem = por_recurso.get(chave)
            if not contagem:
                continue
            total = sum(contagem.values())
            recursos.append({
                "recurso": chave,
                "rotulo": rotulo,
                "categoria": categoria,
                "total": total,
                "valores": [
                    {"rotulo": r, "total": n, "pct": _pct(n, total)} for r, n in contagem.most_common()
                ],
            })
        recursos.sort(key=lambda r: r["total"], reverse=True)

        # Trajetória: as últimas semanas, inclusive as sem uso (zeros deixam a tendência honesta).
        segunda_atual = (agora - timedelta(days=agora.weekday())).date()
        n_semanas = min(SEMANAS_TRAJETORIA, max(1, dias // 7 + 1))
        trajetoria = []
        for k in range(n_semanas - 1, -1, -1):
            semana = (segunda_atual - timedelta(weeks=k)).isoformat()
            contagem = semanas.get(semana, Counter())
            trajetoria.append({
                "semana": semana,
                "total": sum(contagem.values()),
                "por_categoria": {cat: contagem.get(cat, 0) for cat in CATEGORIAS},
            })

        total = sum(por_categoria.values())
        return {
            "periodo_dias": dias,
            "perfil": perfil,
            "total_eventos": total,
            "recursos": recursos,
            "por_categoria": [
                {"categoria": cat, "rotulo": nome, "total": por_categoria.get(cat, 0), "pct": _pct(por_categoria.get(cat, 0), total)}
                for cat, nome in CATEGORIAS.items()
            ],
            "por_perfil": [{"perfil": p, "total": n} for p, n in por_perfil.most_common()],
            "trajetoria": trajetoria,
            "fonte_mediana_px": int(statistics.median(fontes)) if fontes else None,
            "sugestoes_pei": self._sugestoes(recursos, fontes),
        }

    @staticmethod
    def _sugestoes(recursos: list[dict[str, Any]], fontes: list[int]) -> list[str]:
        indice = {r["recurso"]: r for r in recursos}
        sugestoes: list[str] = []

        def dominante(recurso: str, ignorar: tuple[str, ...] = ()) -> dict[str, Any] | None:
            dados = indice.get(recurso)
            if not dados or dados["total"] < 3:
                return None
            topo = next((v for v in dados["valores"] if v["rotulo"] not in ignorar), None)
            return topo if topo and topo["pct"] >= 40 else None

        if (topo := dominante("contraste", ("Padrão",))):
            sugestoes.append(
                f"Contraste “{topo['rotulo']}” escolhido em {topo['pct']:.0f}% das mudanças: prever materiais "
                "e slides nesse esquema de cores e verificar a iluminação da sala."
            )
        if (topo := dominante("tipografia", ("Inter (padrão)",))):
            sugestoes.append(
                f"Tipografia {topo['rotulo']} preferida ({topo['pct']:.0f}%): adotá-la também nas avaliações impressas."
            )
        if len(fontes) >= 3 and (mediana := statistics.median(fontes)) >= 24:
            sugestoes.append(
                f"Fonte ampliada recorrente (mediana de {mediana:.0f} px na tela ≈ {round(mediana * 0.75)} pt no papel): "
                "registrar a ampliação como recurso de acessibilidade no PEI."
            )
        leitura = indice.get("leitura_voz", {}).get("total", 0)
        if leitura >= 3:
            velocidade = dominante("velocidade_voz") or dominante("leitura_voz")
            sugestoes.append(
                f"Leitura em voz alta usada {leitura} vezes"
                + (f", com velocidade preferida de {velocidade['rotulo']}" if velocidade else "")
                + ": considerar ledor/áudio nas avaliações e audiodescrição das imagens."
            )
        atencao = sum(indice.get(r, {}).get("total", 0) for r in ("regua", "foco_minimo", "pausa", "mapa_simples"))
        if atencao >= 3:
            sugestoes.append(
                f"Apoios de atenção (régua, foco mínimo, pausas, mapa simplificado) acionados {atencao} vezes: "
                "planejar tarefas fragmentadas, pausas programadas e organizadores visuais."
            )
        libras = sum(indice.get(r, {}).get("total", 0) for r in ("vlibras", "termos_libras"))
        if libras >= 3:
            sugestoes.append(
                f"Recursos de Libras acionados {libras} vezes: garantir glossário bilíngue dos termos de Física "
                "e articulação com o intérprete/instrutor de Libras."
            )
        braille = next((v["total"] for v in indice.get("exportacao", {}).get("valores", []) if v["rotulo"].startswith("Braille")), 0)
        if braille:
            sugestoes.append(
                f"Material exportado em braille {braille} vez(es): articular a revisão com o transcritor do AEE "
                "e prever tempo adicional de leitura tátil."
            )
        return sugestoes
