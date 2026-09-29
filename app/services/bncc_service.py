"""
Relatório pedagógico BNCC & AEE (Plano de Atendimento Educacional Especializado).

Anti-alucinação: a IA só ESCOLHE códigos de habilidades; a descrição exibida no relatório
vem sempre do catálogo abaixo (Ciências da Natureza e suas Tecnologias — Ensino Médio,
habilidades ligadas à Física). Códigos fora do catálogo são descartados, exceto códigos do
Ensino Fundamental (EF06CI01…EF09CI17), aceitos sem descrição e marcados "a conferir".
A fundamentação legal também é fixa, nunca gerada pela IA.

Revise periodicamente as descrições com o texto oficial da BNCC (basenacionalcomum.mec.gov.br).
"""

from __future__ import annotations

import re
from typing import Any

HABILIDADES_EM: dict[str, str] = {
    "EM13CNT101": "Analisar e representar, com ou sem o uso de dispositivos e de aplicativos digitais específicos, as transformações e conservações em sistemas que envolvam quantidade de matéria, de energia e de movimento para realizar previsões sobre seus comportamentos em situações cotidianas e em processos produtivos que priorizem o desenvolvimento sustentável, o uso consciente dos recursos naturais e a preservação da vida em todas as suas formas.",
    "EM13CNT102": "Realizar previsões, avaliar intervenções e/ou construir protótipos de sistemas térmicos que visem à sustentabilidade, considerando sua composição e os efeitos das variáveis termodinâmicas sobre seu funcionamento, considerando também o uso de tecnologias digitais que auxiliem no cálculo de estimativas e no apoio à construção dos protótipos.",
    "EM13CNT103": "Utilizar o conhecimento sobre as radiações e suas origens para avaliar as potencialidades e os riscos de sua aplicação em equipamentos de uso cotidiano, na saúde, no ambiente, na indústria, na agricultura e na geração de energia elétrica.",
    "EM13CNT106": "Avaliar, com ou sem o uso de dispositivos e aplicativos digitais, tecnologias e possíveis soluções para as demandas que envolvem a geração, o transporte, a distribuição e o consumo de energia elétrica, considerando a disponibilidade de recursos, a eficiência energética, a relação custo/benefício, as características geográficas e ambientais, a produção de resíduos e os impactos socioambientais e culturais.",
    "EM13CNT107": "Realizar previsões qualitativas e quantitativas sobre o funcionamento de geradores, motores elétricos e seus componentes, bobinas, transformadores, pilhas, baterias e dispositivos eletrônicos, com base na análise dos processos de transformação e condução de energia envolvidos – com ou sem o uso de dispositivos e aplicativos digitais –, para propor ações que visem a sustentabilidade.",
    "EM13CNT204": "Elaborar explicações, previsões e cálculos a respeito dos movimentos de objetos na Terra, no Sistema Solar e no Universo com base na análise das interações gravitacionais, com ou sem o uso de dispositivos e aplicativos digitais (como softwares de simulação e de realidade virtual, entre outros).",
    "EM13CNT205": "Interpretar resultados e realizar previsões sobre atividades experimentais, fenômenos naturais e processos tecnológicos, com base nas noções de probabilidade e incerteza, reconhecendo os limites explicativos das ciências.",
    "EM13CNT209": "Analisar a evolução estelar associando-a aos modelos de origem e distribuição dos elementos químicos no Universo, compreendendo suas relações com as condições necessárias ao surgimento de sistemas solares e planetários, suas estruturas e composições e as possibilidades de existência de vida, utilizando representações e simulações, com ou sem o uso de dispositivos e aplicativos digitais (como softwares de simulação e de realidade virtual, entre outros).",
    "EM13CNT301": "Construir questões, elaborar hipóteses, previsões e estimativas, empregar instrumentos de medição e representar e interpretar modelos explicativos, dados e/ou resultados experimentais para construir, avaliar e justificar conclusões no enfrentamento de situações-problema sob uma perspectiva científica.",
    "EM13CNT302": "Comunicar, para públicos variados, em diversos contextos, resultados de análises, pesquisas e/ou experimentos, elaborando e/ou interpretando textos, gráficos, tabelas, símbolos, códigos, sistemas de classificação e equações, por meio de diferentes linguagens, mídias, tecnologias digitais de informação e comunicação (TDIC), de modo a participar e/ou promover debates em torno de temas científicos e/ou tecnológicos de relevância sociocultural e ambiental.",
    "EM13CNT303": "Interpretar textos de divulgação científica que tratem de temáticas das Ciências da Natureza, disponíveis em diferentes mídias, considerando a apresentação dos dados, tanto na forma de textos como em equações, gráficos e/ou tabelas, a consistência dos argumentos e a coerência das conclusões, visando construir estratégias de seleção de fontes confiáveis de informações.",
    "EM13CNT306": "Avaliar os riscos envolvidos em atividades cotidianas, aplicando conhecimentos das Ciências da Natureza, para justificar o uso de equipamentos e recursos, bem como comportamentos de segurança, visando à integridade física, individual e coletiva, e socioambiental, podendo fazer uso de dispositivos e aplicativos digitais que viabilizem a estruturação de simulações de tais riscos.",
    "EM13CNT307": "Analisar as propriedades dos materiais para avaliar a adequação de seu uso em diferentes aplicações (industriais, cotidianas, arquitetônicas ou tecnológicas) e/ou propor soluções seguras e sustentáveis considerando seu contexto local e cotidiano.",
    "EM13CNT308": "Investigar e analisar o funcionamento de equipamentos elétricos e/ou eletrônicos e sistemas de automação para compreender as tecnologias contemporâneas e avaliar seus impactos sociais, culturais e ambientais.",
    "EM13CNT309": "Analisar questões socioambientais, políticas e econômicas relativas à dependência do mundo atual em relação aos recursos não renováveis e discutir a necessidade de introdução de alternativas e novas tecnologias energéticas e de materiais, comparando diferentes tipos de motores e processos de produção de novos materiais.",
}

# Resumo curto de cada habilidade, para orientar a escolha feita pela IA (entra no prompt).
TEMAS_HABILIDADES: dict[str, str] = {
    "EM13CNT101": "transformação e conservação de energia, matéria e movimento",
    "EM13CNT102": "sistemas térmicos, calor e termodinâmica",
    "EM13CNT103": "radiações, ondas eletromagnéticas e suas aplicações",
    "EM13CNT106": "geração, transmissão e consumo de energia elétrica",
    "EM13CNT107": "circuitos, geradores, motores, pilhas e dispositivos eletrônicos",
    "EM13CNT204": "movimentos, forças e interações gravitacionais",
    "EM13CNT205": "atividades experimentais, medidas, probabilidade e incerteza",
    "EM13CNT209": "astronomia e evolução estelar",
    "EM13CNT301": "investigação científica: hipóteses, medições, modelos e dados experimentais",
    "EM13CNT302": "comunicação científica por textos, gráficos, tabelas, símbolos e equações",
    "EM13CNT303": "leitura e interpretação de textos de divulgação científica",
    "EM13CNT306": "riscos e segurança em atividades cotidianas",
    "EM13CNT307": "propriedades dos materiais",
    "EM13CNT308": "equipamentos elétricos e eletrônicos, automação",
    "EM13CNT309": "recursos energéticos, motores e sustentabilidade",
}

PADRAO_EF = re.compile(r"^EF0[6-9]CI(0[1-9]|1[0-9])$")
MAX_HABILIDADES = 5
MAX_ITENS = 6
MAX_LINHAS_MATRIZ = 6

# Matriz de impacto pedagógico: a IA escolhe o CÓDIGO da dimensão e do princípio; os nomes
# exibidos vêm daqui. Dimensões neurocognitivas e, para os perfis sensoriais, perceptivas.
DIMENSOES_BARREIRA: dict[str, str] = {
    "memoria_de_trabalho": "Memória de trabalho",
    "abstracao": "Abstração e raciocínio conceitual",
    "atencao_sustentada": "Atenção sustentada",
    "funcoes_executivas": "Funções executivas (planejamento e organização)",
    "processamento_linguistico": "Processamento linguístico e sintático",
    "processamento_sensorial": "Processamento sensorial",
    "percepcao_visual": "Percepção visual",
    "percepcao_auditiva": "Percepção auditiva",
}
PRINCIPIOS_DUA: dict[str, str] = {
    "representacao": "Múltiplos meios de representação",
    "acao_expressao": "Múltiplos meios de ação e expressão",
    "engajamento": "Múltiplos meios de engajamento",
}

FUNDAMENTACAO_LEGAL = [
    "Lei nº 13.146/2015 — Lei Brasileira de Inclusão da Pessoa com Deficiência (arts. 27 e 28): "
    "sistema educacional inclusivo e adaptações razoáveis.",
    "Decreto nº 7.611/2011 — dispõe sobre a educação especial e o Atendimento Educacional Especializado (AEE).",
    "Resolução CNE/CEB nº 4/2009 — Diretrizes Operacionais para o AEE na Educação Básica.",
    "Política Nacional de Educação Especial na Perspectiva da Educação Inclusiva (MEC, 2008).",
    "Lei nº 12.764/2012 — Política Nacional de Proteção dos Direitos da Pessoa com Transtorno do Espectro Autista.",
]


def instrucoes_prompt() -> str:
    linhas = "\n".join(f"  {codigo}: {tema}" for codigo, tema in TEMAS_HABILIDADES.items())
    return f"""\
Relatório pedagógico BNCC & AEE ("relatorio_aee"), para o professor anexar ao Plano de AEE:
- habilidades_bncc: 2 a 4 habilidades da BNCC realmente mobilizadas pelo conteúdo. Para o Ensino \
Médio, use SOMENTE códigos desta lista:
{linhas}
  Para o Ensino Fundamental, só indique códigos EF06CI01 a EF09CI17 se tiver certeza do código. \
Em "relacao", explique em 1 frase como o conteúdo adaptado desenvolve a habilidade.
- justificativa_pedagogica: 3 a 5 frases técnicas justificando as adaptações feitas para este \
perfil (barreiras removidas, princípios do DUA aplicados, preservação do rigor científico).
- barreiras_identificadas: 2 a 4 barreiras de acesso ao currículo que o material original impunha a este perfil.
- estrategias_aee: 3 a 5 estratégias concretas para a sala comum e para a sala de recursos multifuncionais.
- recursos_acessibilidade: recursos e tecnologias assistivas usados ou recomendados.
- criterios_avaliacao: 2 a 4 critérios observáveis para acompanhar a aprendizagem do estudante.
- matriz_impacto (Matriz de Impacto Pedagógico e Mapeamento de Barreiras): 3 a 5 linhas, uma por \
barreira. Em cada linha:
  • dimensao: a função mais afetada, um destes códigos: {", ".join(DIMENSOES_BARREIRA)};
  • barreira: a barreira concreta que o texto ORIGINAL impunha (ex.: "frases com três orações \
subordinadas sobrecarregam a memória de trabalho");
  • estrategia_dua: o que foi feito NESTE texto adaptado para removê-la (ex.: "uma ideia por frase, \
com passos numerados");
  • principio_dua: o princípio do Desenho Universal para a Aprendizagem atendido: {", ".join(PRINCIPIOS_DUA)};
  • habilidades_bncc: códigos de "habilidades_bncc" (acima) que a estratégia torna acessíveis; \
só códigos já listados lá.
- Não cite leis, normas ou documentos: a fundamentação legal é incluída pelo sistema."""


def _texto(valor: Any, limite: int = 1200) -> str:
    return valor.strip()[:limite] if isinstance(valor, str) else ""


def _lista(valor: Any) -> list[str]:
    if not isinstance(valor, list):
        return []
    return [v.strip()[:400] for v in valor if isinstance(v, str) and v.strip()][:MAX_ITENS]


def normalizar_relatorio(bruto: Any) -> dict[str, Any] | None:
    """Valida os códigos contra o catálogo e troca a descrição pela oficial do catálogo."""
    if not isinstance(bruto, dict):
        return None
    habilidades: list[dict[str, Any]] = []
    vistos: set[str] = set()
    for item in bruto.get("habilidades_bncc") or []:
        if not isinstance(item, dict):
            continue
        codigo = _texto(item.get("codigo"), 20).upper().replace(" ", "")
        if codigo in vistos:
            continue
        if codigo in HABILIDADES_EM:
            descricao, conferida = HABILIDADES_EM[codigo], True
        elif PADRAO_EF.match(codigo):
            descricao, conferida = "", False
        else:
            continue
        vistos.add(codigo)
        habilidades.append({
            "codigo": codigo,
            "descricao": descricao,
            "relacao": _texto(item.get("relacao"), 400),
            "conferida": conferida,
        })
    habilidades = habilidades[:MAX_HABILIDADES]
    relatorio = {
        "habilidades_bncc": habilidades,
        "matriz_impacto": normalizar_matriz(bruto.get("matriz_impacto"), [h["codigo"] for h in habilidades]),
        "justificativa_pedagogica": _texto(bruto.get("justificativa_pedagogica"), 2000),
        "barreiras_identificadas": _lista(bruto.get("barreiras_identificadas")),
        "estrategias_aee": _lista(bruto.get("estrategias_aee")),
        "recursos_acessibilidade": _lista(bruto.get("recursos_acessibilidade")),
        "criterios_avaliacao": _lista(bruto.get("criterios_avaliacao")),
    }
    return relatorio if relatorio["habilidades_bncc"] or relatorio["justificativa_pedagogica"] else None


def normalizar_matriz(bruto: Any, codigos_validos: list[str]) -> list[dict[str, Any]]:
    """Linhas da matriz com dimensão e princípio do catálogo; códigos BNCC só entre os já validados."""
    if not isinstance(bruto, list):
        return []
    linhas: list[dict[str, Any]] = []
    for item in bruto:
        if not isinstance(item, dict):
            continue
        dimensao = _texto(item.get("dimensao"), 40)
        principio = _texto(item.get("principio_dua"), 40)
        barreira = _texto(item.get("barreira"), 400)
        estrategia = _texto(item.get("estrategia_dua"), 400)
        if dimensao not in DIMENSOES_BARREIRA or principio not in PRINCIPIOS_DUA or not (barreira and estrategia):
            continue
        codigos = item.get("habilidades_bncc") if isinstance(item.get("habilidades_bncc"), list) else []
        pedidos = {c.strip().upper() for c in codigos if isinstance(c, str)}
        linhas.append({
            "dimensao": dimensao,
            "dimensao_nome": DIMENSOES_BARREIRA[dimensao],
            "barreira": barreira,
            "estrategia_dua": estrategia,
            "principio_dua": principio,
            "principio_nome": PRINCIPIOS_DUA[principio],
            "habilidades_bncc": [c for c in codigos_validos if c in pedidos],  # ordem do relatório
        })
    return linhas[:MAX_LINHAS_MATRIZ]


# ---------------------------------------------------------------------------
# Relatório por regras (modo simulação e fallback)
# ---------------------------------------------------------------------------

# Palavra-chave no texto → habilidades. A ordem define a prioridade.
MAPA_CONCEITOS: list[tuple[str, tuple[str, ...]]] = [
    (r"gravita|queda|órbita|orbita|planeta|força|forca|newton|inércia|inercia|aceleração|aceleracao|movimento|velocidade",
     ("EM13CNT204",)),
    (r"energia|trabalho|potência|potencia|conservação|conservacao", ("EM13CNT101",)),
    (r"calor|temperatura|térmic|termic|termodinâm|termodinam", ("EM13CNT102",)),
    (r"radiação|radiacao|eletromagnétic|eletromagnetic|luz|onda|frequência|frequencia", ("EM13CNT103",)),
    (r"circuito|corrente|tensão|tensao|resistor|pilha|bateria|gerador|motor", ("EM13CNT107", "EM13CNT308")),
    (r"estrela|galáxia|galaxia|universo", ("EM13CNT209",)),
]

POR_PERFIL: dict[str, dict[str, list[str]]] = {
    "BAIXA_VISAO": {
        "barreiras": ["Texto com fonte pequena e baixo contraste.", "Tabelas, gráficos e fórmulas que perdem legibilidade quando ampliados."],
        "estrategias": ["Oferecer o material ampliado (fonte mínima de 24 pt) e a versão digital com zoom.", "Descrever oralmente figuras e gráficos durante a explicação.", "Posicionar o estudante próximo ao quadro, com boa iluminação e sem reflexos.", "Na sala de recursos, treinar o uso de lupa e de ampliadores de tela."],
        "recursos": ["Material ampliado em alto contraste", "Ampliador de tela e lupa", "Leitura em voz alta", "Fonte Atkinson Hyperlegible"],
        "criterios": ["Localiza informações no material ampliado com autonomia.", "Interpreta fórmulas e unidades apresentadas em formato linear."],
    },
    "DEFICIENCIA_VISUAL_CEGO": {
        "barreiras": ["Conteúdo dependente de figuras, gráficos e da leitura visual de fórmulas.", "Tabelas sem estrutura acessível para leitores de tela."],
        "estrategias": ["Disponibilizar o material digital compatível com leitor de tela e a audiodescrição.", "Usar recursos táteis (barbante, EVA, massinha, papel em relevo) para gráficos, vetores e trajetórias.", "Ler fórmulas por extenso, termo a termo, antes de discuti-las.", "Na sala de recursos, apoiar o uso do leitor de tela e, quando indicado, a transcrição em Braille."],
        "recursos": ["Leitor de tela (NVDA/TalkBack)", "Audiodescrição pedagógica", "Materiais táteis de baixo custo", "Síntese de voz"],
        "criterios": ["Explica oralmente o fenômeno estudado usando os termos científicos corretos.", "Reconhece pelo tato as representações de grandezas e trajetórias."],
    },
    "SURDEZ_LIBRAS": {
        "barreiras": ["Texto longo em português com estruturas sintáticas complexas (segunda língua do estudante).", "Termos técnicos sem sinal-termo em Libras."],
        "estrategias": ["Combinar previamente com o intérprete os sinais dos termos do glossário.", "Apoiar a explicação com imagens, esquemas e demonstrações visuais.", "Verificar a compreensão pedindo reconto em Libras ou por desenho.", "Na sala de recursos, trabalhar o português escrito como segunda língua a partir do vocabulário da aula."],
        "recursos": ["Intérprete de Libras", "VLibras", "Glossário visual de termos científicos", "Legendas em vídeos"],
        "criterios": ["Explica o conceito em Libras usando os sinais combinados.", "Relaciona os termos do glossário a situações concretas."],
    },
    "TEA_SUPORTE_1_2": {
        "barreiras": ["Linguagem figurada e ambígua no texto original.", "Excesso de informação por bloco e ausência de sequência previsível."],
        "estrategias": ["Apresentar a rotina da aula e os passos da atividade no início.", "Usar o glossário ilustrado como apoio visual antes da leitura.", "Antecipar mudanças de atividade e oferecer pausas.", "Na sala de recursos, trabalhar os conceitos abstratos com material concreto e pictogramas."],
        "recursos": ["Passos numerados", "Glossário ilustrado com pictogramas (ARASAAC)", "Agenda visual", "Ambiente com poucos estímulos sensoriais"],
        "criterios": ["Segue a sequência de passos com autonomia crescente.", "Define os conceitos abstratos com exemplos concretos."],
    },
    "TDAH": {
        "barreiras": ["Textos longos, sem destaques e com informações periféricas.", "Atividades extensas sem pausas nem retorno imediato."],
        "estrategias": ["Dividir a atividade em blocos curtos, com pausas programadas.", "Usar o checklist de resolução para acompanhar cada etapa.", "Dar retorno imediato ao final de cada bloco (quiz interativo).", "Na sala de recursos, desenvolver estratégias de organização e automonitoramento."],
        "recursos": ["Resumo executivo e destaques", "Checklist interativo", "Quiz com retorno imediato", "Temporizador de foco"],
        "criterios": ["Conclui as etapas do checklist sem perder a sequência.", "Mantém a atenção durante os blocos de atividade propostos."],
    },
}


# Matriz por regras: (dimensão, barreira, estratégia DUA aplicada no texto, princípio DUA).
MATRIZ_POR_PERFIL: dict[str, list[tuple[str, str, str, str]]] = {
    "BAIXA_VISAO": [
        ("percepcao_visual", "Fonte pequena, baixo contraste e fórmulas densas.",
         "Texto reorganizado em blocos curtos, com fonte ampliável, alto contraste e fórmulas em linha.", "representacao"),
        ("atencao_sustentada", "Leitura ampliada é lenta e cansa rapidamente.",
         "Destaques dos conceitos-chave e leitura em voz alta para alternar entre olhar e ouvir.", "engajamento"),
        ("memoria_de_trabalho", "Tabelas e gráficos exigem guardar valores enquanto se procura a legenda.",
         "Dados descritos em texto linear, com grandeza e unidade juntas.", "representacao"),
    ],
    "DEFICIENCIA_VISUAL_CEGO": [
        ("percepcao_visual", "Figuras, gráficos e vetores só existem na forma visual.",
         "Audiodescrição pedagógica e descrição dos gráficos e vetores em texto e som.", "representacao"),
        ("memoria_de_trabalho", "Fórmulas lidas símbolo a símbolo sobrecarregam a memória auditiva.",
         "Fórmulas por extenso, termo a termo, antes da discussão.", "representacao"),
        ("funcoes_executivas", "Navegar em textos longos sem estrutura com leitor de tela.",
         "Títulos hierárquicos e passos numerados que o leitor de tela anuncia.", "acao_expressao"),
    ],
    "SURDEZ_LIBRAS": [
        ("processamento_linguistico", "Português escrito com orações longas e subordinadas (segunda língua).",
         "Frases curtas em ordem direta, uma ideia por frase.", "representacao"),
        ("abstracao", "Termos técnicos sem sinal-termo em Libras.",
         "Glossário com exemplo concreto e atalho para o VLibras em cada termo.", "representacao"),
        ("memoria_de_trabalho", "Explicação apenas verbal, sem apoio visual.",
         "Passos numerados e organizador visual de causa e efeito.", "representacao"),
    ],
    "TEA_SUPORTE_1_2": [
        ("abstracao", "Conceitos abstratos e linguagem figurada.",
         "Glossário ilustrado com pictogramas e linguagem literal, sem metáforas.", "representacao"),
        ("funcoes_executivas", "Sequência da atividade pouco previsível.",
         "Passos numerados e anunciados antes de começar.", "acao_expressao"),
        ("processamento_sensorial", "Excesso de estímulos na página e no texto.",
         "Blocos curtos, modo Foco Mínimo e pausas regulatórias.", "engajamento"),
    ],
    "TDAH": [
        ("atencao_sustentada", "Texto longo, com informações periféricas.",
         "Resumo executivo, destaques e régua de leitura.", "engajamento"),
        ("memoria_de_trabalho", "Várias etapas de resolução sem apoio externo.",
         "Checklist de resolução marcado etapa por etapa.", "acao_expressao"),
        ("funcoes_executivas", "Atividade extensa sem pausas nem retorno.",
         "Blocos curtos com pausas programadas e quiz com retorno imediato.", "engajamento"),
    ],
}


def relatorio_por_regras(texto: str, perfil: str, ajustes: list[str], origem: str) -> dict[str, Any] | None:
    minusculo = texto.lower()
    codigos: list[str] = []
    for padrao, habilidades in MAPA_CONCEITOS:
        if re.search(padrao, minusculo):
            codigos.extend(h for h in habilidades if h not in codigos)
    codigos = [*codigos[:2], "EM13CNT301", "EM13CNT302"]
    base = POR_PERFIL.get(perfil)
    if base is None:
        return None
    relacao = "Relação estimada por regras automáticas (sem IA): revise antes de usar." if origem == "fallback" \
        else "[Simulação] Relação ilustrativa, não calculada a partir do texto."
    return normalizar_relatorio({
        "habilidades_bncc": [{"codigo": c, "relacao": relacao} for c in dict.fromkeys(codigos)],
        "justificativa_pedagogica": " ".join(ajustes) + (
            " O conteúdo científico, as grandezas e as unidades foram preservados, e o material foi "
            "organizado segundo os princípios do Desenho Universal para a Aprendizagem."
        ),
        "barreiras_identificadas": base["barreiras"],
        "estrategias_aee": base["estrategias"],
        "recursos_acessibilidade": base["recursos"],
        "criterios_avaliacao": base["criterios"],
        # Estratégias de representação favorecem a comunicação científica (EM13CNT302); todas, o conteúdo em si.
        "matriz_impacto": [
            {"dimensao": d, "barreira": b, "estrategia_dua": e, "principio_dua": p,
             "habilidades_bncc": [codigos[0], *(["EM13CNT302"] if p == "representacao" else [])]}
            for d, b, e, p in MATRIZ_POR_PERFIL.get(perfil, [])
        ],
    })
