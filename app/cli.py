"""
Comandos administrativos:  flask --app run iris <comando>

    promover <email>          Dá o papel "pesquisador" (vê e exporta as métricas de todos, pseudonimizadas).
    rebaixar <email>          Volta ao papel "professor".
    atribuir-orfaos <email>   Passa a este usuário os registros criados antes da autenticação.
    supabase-diagnostico      Confere URL, DNS, chave e configuração do Supabase Auth.
"""

import click
from flask import current_app
from flask.cli import AppGroup

iris_cli = AppGroup("iris", help="Administração da Plataforma Íris.")


def _repo():
    return current_app.extensions["usuarios_repo"]


@iris_cli.command("promover")
@click.argument("email")
def promover(email: str) -> None:
    if _repo().definir_papel(email, "pesquisador"):
        click.echo(f"{email} agora é pesquisador.")
    else:
        raise click.ClickException(f"Usuário {email} não encontrado.")


@iris_cli.command("rebaixar")
@click.argument("email")
def rebaixar(email: str) -> None:
    if _repo().definir_papel(email, "professor"):
        click.echo(f"{email} agora é professor.")
    else:
        raise click.ClickException(f"Usuário {email} não encontrado.")


@iris_cli.command("atribuir-orfaos")
@click.argument("email")
def atribuir_orfaos(email: str) -> None:
    usuario = _repo().obter_por_email(email)
    if usuario is None:
        raise click.ClickException(f"Usuário {email} não encontrado.")
    for tabela, total in _repo().atribuir_orfaos(usuario.id).items():
        click.echo(f"{tabela}: {total} registro(s) atribuído(s) a {email}.")


@iris_cli.command("supabase-diagnostico")
def supabase_diagnostico() -> None:
    from app.services.supabase_service import diagnosticar

    etapas = diagnosticar()
    for etapa, ok, detalhe in etapas:
        click.echo(f"[{'OK' if ok else 'ERRO'}] {etapa}: {detalhe}")
    if not all(ok for _, ok, _ in etapas):
        raise click.ClickException("Configuração do Supabase com problemas (veja acima).")

