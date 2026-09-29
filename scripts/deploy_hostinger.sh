#!/usr/bin/env bash
# =============================================================================
# Deploy da Plataforma Íris na Hostinger (Passenger WSGI) via SSH.
#
#   bash scripts/deploy_hostinger.sh              deploy completo
#   bash scripts/deploy_hostinger.sh --simular    mostra o que seria feito (não conecta)
#   bash scripts/deploy_hostinger.sh --rollback   volta ao código do deploy anterior
#
# Configuração: scripts/deploy.conf (NÃO versionado; copie de scripts/deploy.conf.example)
# ou variáveis de ambiente com os mesmos nomes. Guia completo: docs/DEPLOY_HOSTINGER.md
#
# Etapas:
#   1. verificar_predeploy.py (bloqueia se houver segredo, banco local, etc.)
#   2. empacota SÓ os arquivos listados pelo verificador e envia por SSH (tar, sem rsync)
#   3. no servidor: confere o .env de produção, faz backup do código e do SQLite,
#      troca o código, instala dependências, testa a importação do app
#      (se falhar, restaura o código anterior) e reinicia o Passenger
#   4. confere se o site responde
# =============================================================================
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$RAIZ/scripts/deploy.conf"
MODO="deploy"
case "${1:-}" in
  --simular) MODO="simular" ;;
  --rollback) MODO="rollback" ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  "") ;;
  *) echo "Opção desconhecida: $1 (use --simular, --rollback ou --help)" >&2; exit 2 ;;
esac

cor() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
etapa() { cor "1;36" "==> $*"; }
erro() { cor "1;31" "ERRO: $*" >&2; exit 1; }

# shellcheck source=/dev/null
[[ -f "$CONF" ]] && source "$CONF"
: "${HOSTINGER_SSH:?Defina HOSTINGER_SSH (ex.: u123456789@123.45.67.89) em scripts/deploy.conf}"
: "${HOSTINGER_DIR_APP:?Defina HOSTINGER_DIR_APP (raiz do app Python no servidor) em scripts/deploy.conf}"
: "${HOSTINGER_VENV:?Defina HOSTINGER_VENV (caminho do bin/activate do virtualenv) em scripts/deploy.conf}"
HOSTINGER_PORTA="${HOSTINGER_PORTA:-65002}"   # porta SSH padrão da Hostinger
URL_SITE="${URL_SITE:-}"
MANTER_BACKUPS="${MANTER_BACKUPS:-5}"
PYTHON_LOCAL="${PYTHON_LOCAL:-python}"
command -v "$PYTHON_LOCAL" >/dev/null || PYTHON_LOCAL=python3

SSH=(ssh -p "$HOSTINGER_PORTA" -o ServerAliveInterval=30 -o ConnectTimeout=20 "$HOSTINGER_SSH")

# -----------------------------------------------------------------------------
# Script executado NO SERVIDOR (recebe: diretório do app, activate do venv, ação, nº de backups)
# -----------------------------------------------------------------------------
read -r -d '' REMOTO <<'SCRIPT_REMOTO' || true
set -euo pipefail
DIR_APP="$1"; VENV="$2"; ACAO="$3"; MANTER="$4"
BACKUPS="$HOME/iris-backups"
CARIMBO="$(date +%Y%m%d-%H%M%S)"
CODIGO=(app passenger_wsgi.py run.py requirements.txt .env.example)
cd "$DIR_APP"
mkdir -p "$BACKUPS" tmp

reiniciar() { touch tmp/restart.txt; echo "   Passenger reiniciado (tmp/restart.txt)."; }

if [[ "$ACAO" == "rollback" ]]; then
  ULTIMO="$(ls -1t "$BACKUPS"/codigo-*.tgz 2>/dev/null | head -1 || true)"
  [[ -n "$ULTIMO" ]] || { echo "Nenhum backup de código encontrado em $BACKUPS"; exit 1; }
  echo "   Restaurando $ULTIMO"
  rm -rf app && tar -xzf "$ULTIMO"
  reiniciar
  exit 0
fi

# --- .env de produção --------------------------------------------------------
[[ -f .env ]] || { echo "   Falta $DIR_APP/.env — envie o de produção (ver docs/DEPLOY_HOSTINGER.md)."; exit 1; }
chmod 600 .env
ler_env() { grep -E "^[[:space:]]*$1=" .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true; }
FALTANDO=()
for var in IRIS_SECRET_KEY SUPABASE_URL SUPABASE_KEY IRIS_URL_PUBLICA IRIS_DB_PATH; do
  [[ -n "$(ler_env "$var")" ]] || FALTANDO+=("$var")
done
((${#FALTANDO[@]} == 0)) || { echo "   .env de produção sem: ${FALTANDO[*]}"; exit 1; }
for var in SUPABASE_DB_URL SUPABASE_ACCESS_TOKEN SUPABASE_SECRET_KEY SUPABASE_SERVICE_ROLE_KEY; do
  [[ -z "$(ler_env "$var")" ]] || echo "   AVISO: $var (credencial de administrador) está no .env do servidor — remova se não for usada."
done
[[ "$(ler_env SUPABASE_KEY)" != sb_secret_* ]] || echo "   AVISO: SUPABASE_KEY é uma chave SECRETA; use a publicável no app."
DB="$(ler_env IRIS_DB_PATH)"
case "$DB" in */public_html/*) echo "   IRIS_DB_PATH dentro de public_html: o banco ficaria baixável pela web."; exit 1 ;; esac
mkdir -p "$(dirname "$DB")"

# --- backups (código atual + banco) ------------------------------------------
EXISTENTES=()
for item in "${CODIGO[@]}"; do [[ -e "$item" ]] && EXISTENTES+=("$item"); done
if ((${#EXISTENTES[@]})); then
  tar -czf "$BACKUPS/codigo-$CARIMBO.tgz" --exclude='__pycache__' "${EXISTENTES[@]}"
  echo "   Backup do código: $BACKUPS/codigo-$CARIMBO.tgz"
fi
if [[ -f "$DB" ]]; then
  # .backup do sqlite3 gera cópia consistente mesmo com o app no ar; sem sqlite3 (ou se falhar), cp.
  if ! { command -v sqlite3 >/dev/null && sqlite3 "$DB" ".backup '$BACKUPS/banco-$CARIMBO.db'" </dev/null 2>/dev/null; }; then
    cp "$DB" "$BACKUPS/banco-$CARIMBO.db"
  fi
  echo "   Backup do banco:  $BACKUPS/banco-$CARIMBO.db"
fi
for padrao in 'codigo-*.tgz' 'banco-*.db'; do
  { ls -1t "$BACKUPS"/$padrao 2>/dev/null || true; } | tail -n +$((MANTER + 1)) | xargs -r rm -f
done

# --- troca do código (app/ inteiro é substituído: arquivos removidos não ficam para trás) ---
[[ -d .deploy-novo/app ]] || { echo "   Pacote não encontrado em .deploy-novo/"; exit 1; }
rm -rf app.anterior
[[ -d app ]] && mv app app.anterior
mv .deploy-novo/app app
for arquivo in passenger_wsgi.py run.py requirements.txt .env.example; do
  [[ -f ".deploy-novo/$arquivo" ]] && mv -f ".deploy-novo/$arquivo" "$arquivo"
done
rm -rf .deploy-novo

restaurar() {
  echo "   FALHOU — restaurando o código anterior."
  rm -rf app && [[ -d app.anterior ]] && mv app.anterior app
  tar -xzf "$BACKUPS/codigo-$CARIMBO.tgz" passenger_wsgi.py 2>/dev/null || true
  exit 1
}

# --- dependências e teste de importação --------------------------------------
# shellcheck source=/dev/null
source "$VENV"
export PYTHONIOENCODING=utf-8
python -m pip install --quiet --disable-pip-version-check -r requirements.txt </dev/null || restaurar
# Importar o passenger_wsgi cria o app de verdade: carrega o .env, aplica migrações do SQLite
# e roda o diagnóstico do Supabase (erros aparecem aqui antes de irem ao ar).
python - <<'PY' || restaurar
import sys
sys.argv = ["passenger_wsgi"]
import passenger_wsgi
cliente = passenger_wsgi.application.test_client()
for rota, esperado in (("/login", 200), ("/sw.js", 200), ("/manifest.webmanifest", 200)):
    status = cliente.get(rota, base_url="https://localhost").status_code
    print(f"   GET {rota} -> {status}")
    if status != esperado:
        sys.exit(f"   {rota} respondeu {status}")
PY
rm -rf app.anterior
reiniciar
SCRIPT_REMOTO

# -----------------------------------------------------------------------------
# Rollback
# -----------------------------------------------------------------------------
if [[ "$MODO" == "rollback" ]]; then
  etapa "Rollback em $HOSTINGER_SSH:$HOSTINGER_DIR_APP"
  "${SSH[@]}" bash -s -- "$HOSTINGER_DIR_APP" "$HOSTINGER_VENV" rollback "$MANTER_BACKUPS" <<<"$REMOTO"
  cor "1;32" "Rollback concluído."
  exit 0
fi

# -----------------------------------------------------------------------------
# 1. Verificação pré-deploy
# -----------------------------------------------------------------------------
etapa "1/4 Verificação pré-deploy"
"$PYTHON_LOCAL" "$RAIZ/scripts/verificar_predeploy.py" || erro "verificação reprovada — deploy cancelado."

LISTA="$(mktemp)"
trap 'rm -f "$LISTA"' EXIT
"$PYTHON_LOCAL" "$RAIZ/scripts/verificar_predeploy.py" --listar | tr -d '\r' >"$LISTA"
TOTAL="$(wc -l <"$LISTA" | tr -d ' ')"

if [[ "$MODO" == "simular" ]]; then
  etapa "Simulação: $TOTAL arquivos iriam para $HOSTINGER_SSH:$HOSTINGER_DIR_APP (porta $HOSTINGER_PORTA)"
  sed 's/^/   /' "$LISTA"
  echo "   virtualenv: $HOSTINGER_VENV"
  exit 0
fi

# -----------------------------------------------------------------------------
# 2. Envio
# -----------------------------------------------------------------------------
etapa "2/4 Enviando $TOTAL arquivos para $HOSTINGER_SSH:$HOSTINGER_DIR_APP"
(cd "$RAIZ" && tar -czf - -T "$LISTA") | "${SSH[@]}" \
  "rm -rf '$HOSTINGER_DIR_APP/.deploy-novo' && mkdir -p '$HOSTINGER_DIR_APP/.deploy-novo' && tar -xzf - -C '$HOSTINGER_DIR_APP/.deploy-novo'"

# -----------------------------------------------------------------------------
# 3. Instalação no servidor
# -----------------------------------------------------------------------------
etapa "3/4 Instalando no servidor"
"${SSH[@]}" bash -s -- "$HOSTINGER_DIR_APP" "$HOSTINGER_VENV" deploy "$MANTER_BACKUPS" <<<"$REMOTO" \
  || erro "instalação falhou no servidor (o código anterior foi mantido/restaurado)."

# -----------------------------------------------------------------------------
# 4. Verificação no ar
# -----------------------------------------------------------------------------
etapa "4/4 Conferindo o site"
if [[ -z "$URL_SITE" ]]; then
  cor "33" "   URL_SITE não definida em deploy.conf — pulei a checagem externa."
else
  sleep 3  # o Passenger sobe o app na primeira requisição
  for rota in /login /sw.js; do
    STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$URL_SITE$rota" || echo 000)"
    echo "   $URL_SITE$rota → $STATUS"
    [[ "$STATUS" == "200" ]] || erro "o site não respondeu 200 em $rota. Veja o log de erros no hPanel; para voltar: bash scripts/deploy_hostinger.sh --rollback"
  done
fi
cor "1;32" "Deploy concluído."
