"""
Ponto de entrada WSGI da Plataforma Íris para o Phusion Passenger (Hostinger / CloudLinux
"Setup Python App"). O Passenger importa este arquivo e procura o objeto `application`.

Estrutura esperada no servidor (raiz do app = pasta deste arquivo):
    passenger_wsgi.py   ← este arquivo
    app/                ← pacote Flask (create_app)
    .env                ← variáveis de produção (NUNCA versionado; ver .env.example)
    tmp/restart.txt     ← `touch` reinicia o app (feito por scripts/deploy_hostinger.sh)

Variáveis específicas deste arquivo (opcionais):
    IRIS_PYTHON        caminho do Python do virtualenv. Só é preciso quando o Passenger não foi
                       configurado pelo painel e sobe com o Python do sistema: este arquivo então
                       se reexecuta com o interpretador certo.
    IRIS_PROXY_FIX     "1" (padrão) confia nos cabeçalhos X-Forwarded-* de UM proxy (o LiteSpeed/
                       Apache da Hostinger termina o HTTPS): assim request.scheme vira "https" e os
                       links absolutos (e-mails do Supabase) saem corretos. "0" desliga.
"""

import logging
import os
import sys

RAIZ = os.path.dirname(os.path.abspath(__file__))

# 1) Interpretador do virtualenv (apenas se configurado e se não for o atual).
_interpretador = os.environ.get("IRIS_PYTHON", "").strip()
if _interpretador and os.path.realpath(sys.executable) != os.path.realpath(_interpretador):
    os.execl(_interpretador, _interpretador, *sys.argv)

# 2) Raiz do projeto no sys.path e .env carregado ANTES de importar o app
#    (create_app também carrega o .env, mas os módulos de IA leem variáveis ao serem importados).
if RAIZ not in sys.path:
    sys.path.insert(0, RAIZ)
os.chdir(RAIZ)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(RAIZ, ".env"))

# Produção atrás de HTTPS: cookies só por conexão segura (pode ser sobrescrito no .env).
os.environ.setdefault("IRIS_COOKIE_SEGURO", "1")

from app import create_app  # noqa: E402

application = create_app()

if not os.environ.get("IRIS_SECRET_KEY"):
    application.logger.warning(
        "IRIS_SECRET_KEY não definida: usando instance/secret_key. Defina-a no .env de produção "
        "para que as sessões sobrevivam a reinstalações."
    )

if os.environ.get("IRIS_PROXY_FIX", "1") == "1":
    from werkzeug.middleware.proxy_fix import ProxyFix

    application.wsgi_app = ProxyFix(application.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Logs vão para o stderr, que o Passenger grava no log de erros do domínio (hPanel → Logs).
logging.getLogger().setLevel(os.environ.get("IRIS_LOG_NIVEL", "INFO").upper())
