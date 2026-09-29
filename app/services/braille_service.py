"""
Transcrição do texto adaptado para Braille (Grafia Braille para a Língua Portuguesa, grau 1).

Duas saídas a partir da mesma sequência de celas:
    • Braille Unicode (U+2800–U+283F): para linhas braille / leitores de tela e conferência visual.
    • BRF (Braille Ready Format): cada cela vira um caractere do "North American Braille ASCII",
      o formato aceito por impressoras braille (Index, ViewPlus, Juliet…) e por editores como
      Braille Fácil, Duxbury e o bloco de notas das linhas braille.

Formatação BRF: 40 celas por linha, 25 linhas por página, quebra por palavra, CRLF entre linhas e
form feed (\\f) entre páginas — o padrão de papel braille 11" × 11,5".

Escopo (conscientemente simples): braille integral (grau 1), sem abreviaturas, com sinais de
maiúscula, de número, pontuação, letras acentuadas do português e alguns símbolos de Física no
Código Matemático Unificado (CMU). Letras gregas e símbolos sem cela própria são escritos por
extenso ("delta", "graus"). O arquivo é um PONTO DE PARTIDA: a revisão de um transcritor/revisor
braille do AEE continua recomendada antes da impressão definitiva.
"""

from __future__ import annotations

import re
import unicodedata

CELAS_POR_LINHA = 40
LINHAS_POR_PAGINA = 25
TAMANHO_MAXIMO_TEXTO = 60_000

# Pontos → cela. Cada cela é representada pelo seu deslocamento Unicode (bit 0 = ponto 1 … bit 5 = ponto 6).
def _cela(pontos: str) -> int:
    return sum(1 << (int(p) - 1) for p in pontos)


# Tabela North American Braille ASCII, indexada pelo mesmo deslocamento (0x00–0x3F).
_BRF_ASCII = " A1B'K2L@CIF/MSP\"E3H9O6R^DJG>NTQ,*5<-U8V.%[$+X!&;:4\\0Z7(_?W]#Y)="

LETRAS = {
    "a": "1", "b": "12", "c": "14", "d": "145", "e": "15", "f": "124", "g": "1245", "h": "125",
    "i": "24", "j": "245", "k": "13", "l": "123", "m": "134", "n": "1345", "o": "135", "p": "1234",
    "q": "12345", "r": "1235", "s": "234", "t": "2345", "u": "136", "v": "1236", "w": "2456",
    "x": "1346", "y": "13456", "z": "1356",
    # Letras acentuadas (Grafia Braille para a Língua Portuguesa)
    "á": "12356", "à": "1246", "â": "16", "ã": "345", "é": "123456", "ê": "126", "í": "34",
    "ó": "346", "ô": "1456", "õ": "246", "ú": "23456", "ü": "1256", "ç": "12346",
}
DIGITOS = {str(n): LETRAS[l] for n, l in zip("1234567890", "abcdefghij")}

SINAL_MAIUSCULA = "46"
SINAL_NUMERO = "3456"
SINAL_EXPOENTE = "16"      # CMU: expoente (ex.: m/s²)
SINAL_INDICE = "34"        # CMU: índice inferior (ex.: v₀)

PONTUACAO = {
    ",": ["2"], ";": ["23"], ":": ["25"], ".": ["3"], "?": ["26"], "!": ["235"],
    "-": ["36"], "–": ["36", "36"], "—": ["36", "36"], "'": ["3"], "’": ["3"],
    "\"": ["236"], "“": ["236"], "”": ["236"], "«": ["236"], "»": ["236"],
    "(": ["126", "3"], ")": ["6", "345"], "[": ["12356", "3"], "]": ["6", "23456"],
    "/": ["6", "2"], "*": ["35"], "§": ["234", "3"], "…": ["3", "3", "3"],
    # Operadores (CMU)
    "+": ["235"], "=": ["2356"], "×": ["236"], "·": ["3"], "÷": ["256"], "<": ["246"], ">": ["135"],
    "%": ["456", "356"], "°": ["356"], "≈": ["5", "2356"], "≠": ["2356", "4"], "±": ["235", "36"],
    "√": ["146"], "→": ["25", "135"], "@": ["156"], "&": ["12346"], "#": ["3456"], "$": ["56"],
    "_": ["36"], "|": ["456"], "~": ["5"],
}

# Símbolos sem cela própria no braille literário: escritos por extenso.
POR_EXTENSO = {
    "α": "alfa", "β": "beta", "γ": "gama", "δ": "delta", "Δ": "Delta", "ε": "épsilon", "θ": "teta",
    "λ": "lambda", "μ": "mi", "π": "pi", "ρ": "rô", "σ": "sigma", "Σ": "Sigma", "τ": "tau",
    "φ": "fi", "ω": "ômega", "Ω": "Ômega", "∞": "infinito", "≤": "menor ou igual a",
    "≥": "maior ou igual a", "∝": "proporcional a", "⇒": "implica", "∆": "Delta", "•": "-",
}
SOBRESCRITOS = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789")
SUBSCRITOS = str.maketrans("₀₁₂₃₄₅₆₇₈₉", "0123456789")


def _simplificar_latex(texto: str) -> str:
    """Fórmulas LaTeX vindas da tela (\\( … \\), \\[ … \\]) viram notação linear legível."""
    def converter(m: re.Match) -> str:
        f = m.group(1) or m.group(2) or ""
        for _ in range(3):  # frações aninhadas
            f = re.sub(r"\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}", r"(\1)/(\2)", f)
        f = re.sub(r"\\sqrt\{([^{}]*)\}", r"√(\1)", f)
        substituicoes = {
            r"\cdot": "·", r"\times": "×", r"\div": "÷", r"\Delta": "Δ", r"\approx": "≈", r"\neq": "≠",
            r"\leq": "≤", r"\geq": "≥", r"\pm": "±", r"\rightarrow": "→", r"\to": "→", r"\infty": "∞",
            r"\degree": "°", r"^\circ": "°", r"\,": " ", r"\;": " ", r"\ ": " ", r"\left": "", r"\right": "",
        }
        for de, para in substituicoes.items():
            f = f.replace(de, para)
        f = re.sub(r"\\text(?:rm|bf)?\{([^{}]*)\}", r"\1", f)
        f = re.sub(r"\\vec\{([^{}]*)\}", r"\1", f)
        f = re.sub(r"\\([a-zA-Z]+)", lambda g: POR_EXTENSO_LATEX.get(g.group(1), g.group(1)), f)
        f = re.sub(r"\^\{([^{}]*)\}", r"^\1", f)
        f = re.sub(r"_\{([^{}]*)\}", r"_\1", f)
        return f.replace("{", "").replace("}", "")

    return re.sub(r"\\\((.+?)\\\)|\\\[(.+?)\\\]", converter, texto, flags=re.S)


POR_EXTENSO_LATEX = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "theta": "θ",
    "lambda": "λ", "mu": "μ", "pi": "π", "rho": "ρ", "sigma": "σ", "Sigma": "Σ", "tau": "τ",
    "phi": "φ", "omega": "ω", "Omega": "Ω",
}


def _normalizar(texto: str) -> str:
    texto = unicodedata.normalize("NFC", _simplificar_latex(texto))
    texto = texto.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ").replace("\u00a0", " ")
    for simbolo, extenso in POR_EXTENSO.items():
        texto = texto.replace(simbolo, f" {extenso} " if len(extenso) > 1 else extenso)
    # Expoentes e índices: ² → ^2, ₀ → _0 (tratados abaixo com os sinais do CMU).
    texto = re.sub(r"[⁰¹²³⁴⁵⁶⁷⁸⁹]+", lambda m: "^" + m.group(0).translate(SOBRESCRITOS), texto)
    texto = re.sub(r"[₀₁₂₃₄₅₆₇₈₉]+", lambda m: "_" + m.group(0).translate(SUBSCRITOS), texto)
    return re.sub(r"[ ]{2,}", " ", texto)


def _transcrever_palavra(palavra: str) -> list[int]:
    """Uma "palavra" (sem espaços) → lista de celas."""
    celas: list[int] = []
    em_numero = False
    i = 0
    # Palavra toda em maiúsculas (2+ letras): sinal duplo de maiúscula no início.
    letras = [c for c in palavra if c.isalpha()]
    caixa_alta = len(letras) >= 2 and all(c.isupper() for c in letras)
    sinal_caixa_alta_pendente = caixa_alta

    while i < len(palavra):
        c = palavra[i]
        proximo = palavra[i + 1] if i + 1 < len(palavra) else ""

        if c.isdigit():
            if not em_numero:
                celas.append(_cela(SINAL_NUMERO))
                em_numero = True
            celas.append(_cela(DIGITOS[c]))
        elif c in ",." and em_numero and proximo.isdigit():
            # Vírgula decimal / ponto de milhar dentro do número: o sinal de número continua valendo.
            celas.append(_cela("2" if c == "," else "3"))
        elif c in "^_" and proximo.isalnum():
            celas.append(_cela(SINAL_EXPOENTE if c == "^" else SINAL_INDICE))
            em_numero = False
        elif c.lower() in LETRAS:
            minuscula = c.lower()
            if sinal_caixa_alta_pendente:
                celas += [_cela(SINAL_MAIUSCULA)] * 2  # antes da 1ª letra, depois de "(" ou aspas
                sinal_caixa_alta_pendente = False
            elif c.isupper() and not caixa_alta:
                celas.append(_cela(SINAL_MAIUSCULA))
            elif em_numero and minuscula in "abcdefghij":
                celas.append(_cela("56"))  # separa a letra do número (ex.: 5a não vira 51)
            em_numero = False
            celas.append(_cela(LETRAS[minuscula]))
        elif c in PONTUACAO:
            celas += [_cela(p) for p in PONTUACAO[c]]
            em_numero = False
        else:
            # Letra sem cela própria (ex.: ñ, è): tenta a letra base; símbolos desconhecidos são omitidos.
            base = unicodedata.normalize("NFD", c)[0]
            if base.lower() in LETRAS:
                if base.isupper() and not caixa_alta:
                    celas.append(_cela(SINAL_MAIUSCULA))
                celas.append(_cela(LETRAS[base.lower()]))
            em_numero = False
        i += 1
    return celas


def transcrever_linha(texto: str) -> list[list[int]]:
    """Uma linha de texto → lista de palavras, cada uma como lista de celas."""
    return [celas for palavra in texto.split(" ") if palavra and (celas := _transcrever_palavra(palavra))]


def _quebrar(palavras: list[list[int]], largura: int, recuo: int = 0) -> list[list[int]]:
    """Quebra por palavra; o recuo vale só na 1ª linha; palavra maior que a linha é cortada com hífen (ponto 36)."""
    linhas: list[list[int]] = []
    atual: list[int] = [0] * recuo
    inicio = recuo  # celas de recuo da linha atual (0 depois da primeira)
    for palavra in palavras:
        while len(palavra) > largura - inicio:
            if len(atual) > inicio:
                linhas.append(atual)
                atual, inicio = [], 0
            corte = largura - inicio - 1
            linhas.append(atual + palavra[:corte] + [_cela("36")])
            atual, inicio, palavra = [], 0, palavra[corte:]
        espaco = 1 if len(atual) > inicio else 0
        if len(atual) + espaco + len(palavra) > largura:
            linhas.append(atual)
            atual, inicio, espaco = [], 0, 0
        atual += [0] * espaco + palavra
    if len(atual) > inicio or not linhas:
        linhas.append(atual)
    return linhas


def transcrever(texto: str, titulo: str | None = None, largura: int = CELAS_POR_LINHA) -> list[list[int]]:
    """
    Texto completo → linhas de celas já formatadas (sem paginação).
    Parágrafos começam com recuo de 2 celas; linha em branco vira linha em branco;
    o título sai centralizado, seguido de uma linha em branco.
    """
    linhas: list[list[int]] = []
    if titulo and titulo.strip():
        for linha in _quebrar(transcrever_linha(_normalizar(titulo.strip())), largura):
            margem = (largura - len(linha)) // 2
            linhas.append([0] * margem + linha)
        linhas.append([])

    anterior_vazia = True
    for bruta in _normalizar(texto).split("\n"):
        bruta = bruta.strip()
        if not bruta:
            if not anterior_vazia:
                linhas.append([])
            anterior_vazia = True
            continue
        # Itens de lista ("- ", "1. ") ficam sem recuo; parágrafos, com recuo de 2 celas.
        recuo = 0 if re.match(r"^(-|\d+[.)])\s", bruta) else 2
        linhas += _quebrar(transcrever_linha(bruta), largura, recuo)
        anterior_vazia = False
    while linhas and not linhas[-1]:
        linhas.pop()
    return linhas


def paginar(linhas: list[list[int]], linhas_por_pagina: int = LINHAS_POR_PAGINA) -> list[list[list[int]]]:
    """Divide em páginas; a última linha de cada página traz o número da página à direita."""
    utilizaveis = linhas_por_pagina - 1
    paginas = [linhas[i:i + utilizaveis] for i in range(0, len(linhas), utilizaveis)] or [[]]
    resultado = []
    for numero, pagina in enumerate(paginas, start=1):
        pagina = pagina + [[] for _ in range(utilizaveis - len(pagina))]
        rotulo = _transcrever_palavra(str(numero))
        pagina.append([0] * (CELAS_POR_LINHA - len(rotulo)) + rotulo)
        resultado.append(pagina)
    return resultado


def para_unicode(linhas: list[list[int]]) -> str:
    return "\n".join("".join(chr(0x2800 + c) for c in linha).rstrip("\u2800") for linha in linhas)


def para_brf(linhas: list[list[int]]) -> str:
    """BRF paginado: CRLF entre linhas, form feed entre páginas."""
    paginas = paginar(linhas)
    return "\f".join(
        "\r\n".join("".join(_BRF_ASCII[c] for c in linha).rstrip() for linha in pagina) + "\r\n"
        for pagina in paginas
    )


def gerar_braille(texto: str, titulo: str | None = None, formato: str = "brf") -> str:
    """formato "brf" (impressora braille / linha braille) ou "unicode" (texto com celas U+28xx)."""
    linhas = transcrever(texto[:TAMANHO_MAXIMO_TEXTO], titulo)
    return para_brf(linhas) if formato == "brf" else para_unicode(linhas)


def nome_arquivo_braille(titulo: str, formato: str = "brf") -> str:
    base = unicodedata.normalize("NFKD", titulo or "material").encode("ascii", "ignore").decode()
    base = re.sub(r"[^A-Za-z0-9]+", "-", base).strip("-").lower()[:60] or "material"
    return f"{base}-braille.{'brf' if formato == 'brf' else 'txt'}"
