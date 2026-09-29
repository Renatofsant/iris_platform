"""
Cria no Supabase as tabelas da Plataforma Íris (usuarios, relatorios_aee, eventos_acessibilidade),
com RLS, a partir de scripts/supabase_schema.sql. Pode ser executado várias vezes.

    python scripts/setup_supabase.py              aplica o esquema e confere o resultado
    python scripts/setup_supabase.py --verificar  só confere (usa a chave publicável)
    python scripts/setup_supabase.py --sql        imprime o SQL (para colar no SQL Editor)

A chave publicável (SUPABASE_KEY) NÃO tem permissão para criar tabelas — de propósito. Para
aplicar o esquema, defina no .env UMA destas credenciais administrativas:
    SUPABASE_DB_URL        string de conexão Postgres (Project Settings → Database → Connection string)
    SUPABASE_ACCESS_TOKEN  token pessoal da Management API (Account → Access Tokens)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
ARQUIVO_SQL = Path(__file__).with_name("supabase_schema.sql")
sys.path.insert(0, str(RAIZ))


def carregar_env() -> None:
    from dotenv import load_dotenv

    load_dotenv(RAIZ / ".env")


def ref_do_projeto() -> str:
    url = os.getenv("SUPABASE_URL", "")
    achado = re.match(r"^https://([a-z0-9]+)\.supabase\.co/?$", url.strip())
    if not achado:
        sys.exit(f"SUPABASE_URL inválida: {url!r} (esperado https://<ref>.supabase.co)")
    return achado.group(1)


def aplicar_via_postgres(sql: str, url_banco: str) -> None:
    import psycopg

    with psycopg.connect(url_banco, connect_timeout=15, autocommit=False) as conexao:
        with conexao.cursor() as cursor:
            cursor.execute(sql)
        conexao.commit()


def aplicar_via_management_api(sql: str, ref: str, token: str) -> None:
    requisicao = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(requisicao, timeout=60) as resposta:
            resposta.read()
    except urllib.error.HTTPError as exc:
        sys.exit(f"Management API respondeu {exc.code}: {exc.read().decode(errors='replace')[:500]}")


def verificar() -> bool:
    from app.services.supabase_service import diagnosticar, verificar_conexao

    etapas = diagnosticar()
    for etapa, ok, detalhe in etapas:
        print(f"  [{'OK' if ok else 'ERRO'}] {etapa}: {detalhe}")
    if not all(ok for etapa, ok, _ in etapas if etapa != "tipo de chave"):
        return False

    try:
        resultado = verificar_conexao()
    except Exception as exc:  # DNS, chave inválida, projeto pausado…
        print(f"  Não foi possível conectar ao Supabase: {exc}")
        return False
    tudo_ok = True
    for tabela, estado in resultado.items():
        print(f"  {tabela:<24} {estado}")
        tudo_ok &= estado == "ok"
    return tudo_ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    grupo = parser.add_mutually_exclusive_group()
    grupo.add_argument("--verificar", action="store_true", help="só confere a conexão e as tabelas")
    grupo.add_argument("--sql", action="store_true", help="imprime o SQL do esquema")
    args = parser.parse_args()

    sql = ARQUIVO_SQL.read_text(encoding="utf-8")
    if args.sql:
        print(sql)
        return

    carregar_env()
    if not (os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_KEY")):
        sys.exit("Defina SUPABASE_URL e SUPABASE_KEY no .env.")
    ref = ref_do_projeto()

    if not args.verificar:
        url_banco = os.getenv("SUPABASE_DB_URL", "").strip()
        token = os.getenv("SUPABASE_ACCESS_TOKEN", "").strip()
        if url_banco:
            print("Aplicando o esquema via conexão Postgres (SUPABASE_DB_URL)…")
            aplicar_via_postgres(sql, url_banco)
        elif token:
            print(f"Aplicando o esquema via Management API (projeto {ref})…")
            aplicar_via_management_api(sql, ref, token)
        else:
            sys.exit(
                "Nenhuma credencial administrativa encontrada.\n"
                "A chave publicável não pode criar tabelas. Defina no .env SUPABASE_DB_URL ou\n"
                "SUPABASE_ACCESS_TOKEN — ou rode `python scripts/setup_supabase.py --sql` e cole\n"
                "o resultado no SQL Editor do Supabase."
            )
        print("Esquema aplicado.")

    print(f"Conferindo o projeto {ref} com a chave publicável:")
    if not verificar():
        sys.exit(1)
    print("Tudo pronto.")


if __name__ == "__main__":
    main()
