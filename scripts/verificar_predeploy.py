"""
Verificação pré-deploy da Plataforma Íris. Também é a FONTE ÚNICA da lista de arquivos que
vão para o servidor (scripts/deploy_hostinger.sh usa `--listar`).

    python scripts/verificar_predeploy.py            roda todas as checagens (código de saída 1 se falhar)
    python scripts/verificar_predeploy.py --listar   imprime os arquivos do pacote de deploy, um por linha
    python scripts/verificar_predeploy.py --estrito  avisos também reprovam (útil em CI)

Checagens:
  1. Git (se houver repositório): árvore limpa, .env / banco / chaves não versionados.
  2. Pacote: nenhum SQLite, backup, .env, instance/, chave privada ou arquivo pesado demais.
  3. Segredos: varre o texto de cada arquivo do pacote atrás de chaves de API e credenciais.
  4. .gitignore protege .env e instance/.
  5. .env.example documenta todas as variáveis que o código lê e não contém segredos reais.
  6. Código: compila, passenger_wsgi.py expõe `application`, requirements.txt completo.
"""

from __future__ import annotations

import argparse
import base64
import fnmatch
import json
import py_compile
import re
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent

# O que entra no servidor: só o necessário para rodar o app.
INCLUIR = ["passenger_wsgi.py", "run.py", "requirements.txt", ".env.example", "app/**/*"]
# Nunca entra, mesmo que case com INCLUIR.
EXCLUIR = [
    "**/__pycache__/**", "*.pyc", "*.pyo",
    ".env", ".env.*", "**/.env", "**/.env.*",
    "instance/**", "**/*.db", "**/*.db-*", "**/*.sqlite", "**/*.sqlite3", "**/*.bak*",
    "**/*.pem", "**/*.key", "**/id_rsa*", "**/*.p12", "**/*.pfx",
    "**/.DS_Store", "**/Thumbs.db", "**/*.log", "**/*.tmp", "**/*~",
]
EXCECOES_EXCLUIR = {".env.example"}
TAMANHO_MAXIMO = 5 * 1024 * 1024  # arquivos maiores que isso quase sempre são engano

PADROES_SEGREDO = [
    ("chave secreta do Supabase", re.compile(r"sb_secret_[A-Za-z0-9_\-]{10,}")),
    ("token da Management API do Supabase", re.compile(r"sbp_[a-f0-9]{30,}")),
    ("chave da Anthropic", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("chave do Google/Gemini", re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    ("chave da Groq", re.compile(r"gsk_[A-Za-z0-9]{20,}")),
    ("chave da OpenAI", re.compile(r"sk-(?:proj-)?[A-Za-z0-9]{32,}")),
    ("URL Postgres com senha", re.compile(r"postgres(?:ql)?://[^:\s/]+:(?!<)[^@\s]{6,}@")),
    ("chave privada", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("token do GitHub", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
]
JWT = re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")
CHAVE_PUBLICAVEL = re.compile(r"sb_publishable_[A-Za-z0-9_\-]{10,}")

VARIAVEL_NO_CODIGO = re.compile(r"""os\.(?:getenv|environ\.get|environ\.setdefault)\(\s*["']([A-Z][A-Z0-9_]+)["']|os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]""")
# Lidas pelos SDKs ou só por ferramentas locais: não precisam estar no .env.example.
VARIAVEIS_IGNORADAS = {"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"}

IMPORTS_REQUERIDOS = {  # módulo importado → nome no requirements.txt
    "flask": "flask", "flask_login": "flask-login", "anthropic": "anthropic", "nh3": "nh3",
    "docx": "python-docx", "pypdf": "pypdf", "supabase": "supabase", "dotenv": "python-dotenv",
}


class Relatorio:
    def __init__(self) -> None:
        self.falhas: list[str] = []
        self.avisos: list[str] = []

    def secao(self, titulo: str) -> None:
        print(f"\n== {titulo}")

    def ok(self, texto: str) -> None:
        print(f"  [OK]    {texto}")

    def aviso(self, texto: str) -> None:
        self.avisos.append(texto)
        print(f"  [AVISO] {texto}")

    def falha(self, texto: str) -> None:
        self.falhas.append(texto)
        print(f"  [FALHA] {texto}")


def _casa(caminho: str, padroes: list[str]) -> bool:
    nome = caminho.rsplit("/", 1)[-1]
    return any(fnmatch.fnmatch(caminho, p) or fnmatch.fnmatch(nome, p) for p in padroes)


def arquivos_do_pacote() -> list[str]:
    encontrados: set[str] = set()
    for padrao in INCLUIR:
        for caminho in RAIZ.glob(padrao):
            if caminho.is_file():
                encontrados.add(caminho.relative_to(RAIZ).as_posix())
    return sorted(
        c for c in encontrados
        if c in EXCECOES_EXCLUIR or not _casa(c, EXCLUIR)
    )


def _git(*args: str) -> str | None:
    try:
        resultado = subprocess.run(["git", *args], cwd=RAIZ, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return resultado.stdout if resultado.returncode == 0 else None


def checar_git(r: Relatorio) -> None:
    r.secao("1. Repositório Git")
    if _git("rev-parse", "--is-inside-work-tree") is None:
        r.aviso("Pasta sem Git: não dá para garantir que o deploy corresponde a uma versão registrada. "
                "Recomendado: git init + commit antes de publicar.")
        return
    pendentes = (_git("status", "--porcelain") or "").strip()
    if pendentes:
        linhas = pendentes.splitlines()
        r.falha(f"Árvore de trabalho com {len(linhas)} alteração(ões) não commitada(s): "
                + ", ".join(l[3:] for l in linhas[:8]) + (" …" if len(linhas) > 8 else ""))
    else:
        r.ok("Árvore de trabalho limpa")
    versionados = (_git("ls-files") or "").splitlines()
    proibidos = [c for c in versionados if c not in EXCECOES_EXCLUIR and _casa(c, [p for p in EXCLUIR if "pycache" not in p])]
    if proibidos:
        r.falha("Arquivos sensíveis VERSIONADOS (remova com `git rm --cached` e troque as chaves se já houve push): "
                + ", ".join(proibidos[:10]))
    else:
        r.ok("Nenhum .env, banco ou chave versionado")


def checar_pacote(r: Relatorio, arquivos: list[str]) -> None:
    r.secao("2. Conteúdo do pacote de deploy")
    r.ok(f"{len(arquivos)} arquivos serão enviados")
    for c in arquivos:
        tamanho = (RAIZ / c).stat().st_size
        if tamanho > TAMANHO_MAXIMO:
            r.aviso(f"{c} tem {tamanho / 1_048_576:.1f} MB — é mesmo necessário no servidor?")
    locais = [p.relative_to(RAIZ).as_posix() for p in RAIZ.rglob("*")
              if p.is_file() and _casa(p.relative_to(RAIZ).as_posix(), ["**/*.db", "**/*.sqlite*", "**/*.bak*", "instance/**"])]
    if locais:
        r.ok("Bancos/backups locais ficam de fora do pacote: " + ", ".join(locais))
    for obrigatorio in ("passenger_wsgi.py", "requirements.txt", "app/__init__.py"):
        if obrigatorio not in arquivos:
            r.falha(f"{obrigatorio} ausente do pacote")


def checar_segredos(r: Relatorio, arquivos: list[str]) -> None:
    r.secao("3. Segredos no código")
    achados = 0
    for c in arquivos:
        try:
            texto = (RAIZ / c).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binário (imagens)
        for numero, linha in enumerate(texto.splitlines(), start=1):
            for nome, padrao in PADROES_SEGREDO:
                if padrao.search(linha):
                    r.falha(f"{c}:{numero}: possível {nome}")
                    achados += 1
            for token in JWT.findall(linha):
                try:
                    carga = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
                except ValueError:
                    continue
                if carga.get("role") == "service_role":
                    r.falha(f"{c}:{numero}: JWT service_role do Supabase (acesso total ao banco)")
                    achados += 1
            if CHAVE_PUBLICAVEL.search(linha):
                r.aviso(f"{c}:{numero}: chave publicável do Supabase no código — prefira o .env")
    if not achados:
        r.ok("Nenhuma chave ou credencial encontrada nos arquivos do pacote")


def checar_gitignore(r: Relatorio) -> None:
    r.secao("4. .gitignore")
    arquivo = RAIZ / ".gitignore"
    regras = arquivo.read_text(encoding="utf-8").split() if arquivo.exists() else []
    for necessario in (".env", "instance/"):
        if necessario in regras:
            r.ok(f"ignora {necessario}")
        else:
            r.falha(f".gitignore não ignora {necessario}")
    if not any(re.fullmatch(r"\*?\.(db|sqlite3?)", x) for x in regras):
        r.aviso("Considere ignorar também *.db e *.sqlite3 (bancos fora de instance/).")


def checar_env_example(r: Relatorio) -> None:
    r.secao("5. .env.example")
    arquivo = RAIZ / ".env.example"
    if not arquivo.exists():
        r.falha(".env.example não existe")
        return
    texto = arquivo.read_text(encoding="utf-8")
    documentadas = set(re.findall(r"^\s*#?\s*([A-Z][A-Z0-9_]+)=", texto, flags=re.M))
    usadas: set[str] = set()
    for fonte in list((RAIZ / "app").rglob("*.py")) + [RAIZ / "passenger_wsgi.py", *(RAIZ / "scripts").glob("*.py")]:
        if fonte.exists():
            for a, b in VARIAVEL_NO_CODIGO.findall(fonte.read_text(encoding="utf-8")):
                usadas.add(a or b)
    faltando = sorted(usadas - documentadas - VARIAVEIS_IGNORADAS)
    if faltando:
        r.falha("Variáveis usadas no código mas não documentadas: " + ", ".join(faltando))
    else:
        r.ok(f"Todas as {len(usadas - VARIAVEIS_IGNORADAS)} variáveis do código estão documentadas")
    reais = [nome for nome, padrao in PADROES_SEGREDO if padrao.search(texto)]
    if CHAVE_PUBLICAVEL.search(texto):
        reais.append("chave publicável real")
    if reais:
        r.falha(".env.example contém valores reais: " + ", ".join(reais) + " (use marcadores como sb_publishable_...)")
    else:
        r.ok("Sem valores reais no .env.example")


def checar_codigo(r: Relatorio, arquivos: list[str]) -> None:
    r.secao("6. Código e dependências")
    erros = 0
    for c in (a for a in arquivos if a.endswith(".py")):
        try:
            py_compile.compile(str(RAIZ / c), doraise=True, cfile=None, optimize=-1)
        except py_compile.PyCompileError as exc:
            r.falha(f"Erro de sintaxe: {exc.msg.strip()}")
            erros += 1
    if not erros:
        r.ok("Todos os .py compilam")
    wsgi = (RAIZ / "passenger_wsgi.py")
    if wsgi.exists() and re.search(r"^application\s*=", wsgi.read_text(encoding="utf-8"), flags=re.M):
        r.ok("passenger_wsgi.py define `application`")
    else:
        r.falha("passenger_wsgi.py ausente ou sem `application = ...`")
    if re.search(r"debug\s*=\s*True", wsgi.read_text(encoding="utf-8") if wsgi.exists() else ""):
        r.falha("passenger_wsgi.py liga o modo debug")

    requisitos = (RAIZ / "requirements.txt").read_text(encoding="utf-8").lower()
    nomes = {re.split(r"[<>=\[;\s]", l.strip(), maxsplit=1)[0] for l in requisitos.splitlines() if l.strip() and not l.startswith("#")}
    importados: set[str] = set()
    for c in (a for a in arquivos if a.endswith(".py")):
        importados |= set(re.findall(r"^\s*(?:from|import)\s+([a-z_][a-z0-9_]*)", (RAIZ / c).read_text(encoding="utf-8"), flags=re.M))
    faltando = sorted(pacote for modulo, pacote in IMPORTS_REQUERIDOS.items() if modulo in importados and pacote not in nomes)
    if faltando:
        r.falha("requirements.txt sem: " + ", ".join(faltando))
    else:
        r.ok("requirements.txt cobre as bibliotecas importadas")


def main() -> int:
    parser = argparse.ArgumentParser(description="Verificação pré-deploy da Plataforma Íris.")
    parser.add_argument("--listar", action="store_true", help="imprime os arquivos do pacote e sai")
    parser.add_argument("--estrito", action="store_true", help="avisos também reprovam")
    args = parser.parse_args()

    arquivos = arquivos_do_pacote()
    if args.listar:
        print("\n".join(arquivos))
        return 0

    r = Relatorio()
    print(f"Verificação pré-deploy — {RAIZ}")
    checar_git(r)
    checar_pacote(r, arquivos)
    checar_segredos(r, arquivos)
    checar_gitignore(r)
    checar_env_example(r)
    checar_codigo(r, arquivos)

    print(f"\nResultado: {len(r.falhas)} falha(s), {len(r.avisos)} aviso(s).")
    if r.falhas or (args.estrito and r.avisos):
        print("DEPLOY BLOQUEADO — corrija os itens acima.")
        return 1
    print("Pronto para o deploy.")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # acentos no terminal do Windows
    sys.exit(main())
