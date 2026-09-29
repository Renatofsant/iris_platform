# Deploy da Plataforma Íris na Hostinger (Passenger WSGI)

Guia para publicar e atualizar a Plataforma Íris numa hospedagem Hostinger com suporte a
aplicativos Python via **Phusion Passenger**.

> **Antes de tudo:** confirme no hPanel que o seu plano oferece aplicativos Python com
> Passenger (e acesso SSH). Se o plano não tiver essa opção, use um **VPS** da Hostinger. Nesse
> caso o `passenger_wsgi.py` continua servindo: rode com `gunicorn passenger_wsgi:application`
> atrás do Nginx.

## Arquivos envolvidos

| Arquivo | Para que serve |
|---|---|
| `passenger_wsgi.py` | Entrada WSGI: carrega o `.env`, chama `create_app()` e expõe `application`. |
| `.env.example` | Todas as variáveis do app, com as obrigatórias em produção marcadas. |
| `scripts/verificar_predeploy.py` | Checagens de segurança e a lista de arquivos que vão para o servidor. |
| `scripts/deploy_hostinger.sh` | Envio por SSH, backup, instalação, teste, reinício e rollback. |
| `scripts/deploy.conf.example` | Modelo dos dados de acesso ao servidor (a cópia `deploy.conf` não é versionada). |

## 1. Preparação (uma vez)

### 1.1 Supabase
1. Em **Project Settings → API**, copie a **Project URL** e a chave **publicável**.
2. Crie as tabelas, **na sua máquina** e não no servidor:
   ```bash
   python scripts/setup_supabase.py --sql   # cole o resultado no SQL Editor do Supabase
   python scripts/setup_supabase.py --verificar
   ```
3. Em **Authentication → URL Configuration**:
   - **Site URL:** `https://seu-dominio.com.br`
   - **Redirect URLs:** `https://seu-dominio.com.br/login` e `https://seu-dominio.com.br/redefinir-senha/nova`

### 1.2 Aplicativo Python no hPanel
1. Abra **Avançado → Python** (ou "Setup Python App") e crie o aplicativo:
   - **Versão do Python:** 3.12, ou a maior disponível ≥ 3.10.
   - **Application root:** por exemplo `domains/seu-dominio.com.br/iris`. Deve ficar **fora** de `public_html`.
   - **Application URL:** o domínio.
   - **Startup file:** `passenger_wsgi.py` · **Entry point:** `application`.
2. O painel mostra o comando `source …/bin/activate` do virtualenv. Esse caminho é o `HOSTINGER_VENV`.
3. Se você configurar o Passenger manualmente, o `.htaccess` da pasta pública fica assim:
   ```apache
   PassengerAppRoot /home/u123456789/domains/seu-dominio.com.br/iris
   PassengerBaseURI /
   PassengerPython /home/u123456789/virtualenv/domains/seu-dominio.com.br/iris/3.12/bin/python
   ```

### 1.3 Acesso SSH por chave
Na seção **Avançado → Acesso SSH** do hPanel, habilite o SSH e anote usuário, IP e porta (normalmente `65002`). Depois:
```bash
ssh-keygen -t ed25519 -C "deploy-iris"
ssh-copy-id -p 65002 u123456789@IP     # ou cole a chave pública no hPanel
ssh -p 65002 u123456789@IP             # deve entrar sem pedir senha
```

### 1.4 `.env` de produção (direto no servidor)
Monte o arquivo a partir do `.env.example` e envie **uma vez**. O deploy nunca envia nem sobrescreve o `.env`.
```bash
scp -P 65002 .env.producao u123456789@IP:domains/seu-dominio.com.br/iris/.env
```

Obrigatórias em produção (o deploy confere e **para** se faltar alguma):

| Variável | Valor |
|---|---|
| `IRIS_SECRET_KEY` | `python -c "import secrets; print(secrets.token_hex(32))"` |
| `SUPABASE_URL` / `SUPABASE_KEY` | Project URL e chave **publicável** |
| `IRIS_URL_PUBLICA` | `https://seu-dominio.com.br` |
| `IRIS_DB_PATH` | `/home/u123456789/iris-dados/iris.db`, **fora** de `public_html` |

Para a IA, preencha `ANTHROPIC_API_KEY` (ou `GEMINI_API_KEY` / `GROQ_API_KEY`) e use `USE_MOCK_AI="0"`.

**Não coloque no servidor:** `SUPABASE_DB_URL`, `SUPABASE_ACCESS_TOKEN` e as chaves secretas / service_role. Elas dão acesso total ao banco e só servem para o `setup_supabase.py`. O deploy avisa se encontrar alguma delas.

### 1.5 `scripts/deploy.conf`
```bash
cp scripts/deploy.conf.example scripts/deploy.conf   # e preencha
```

## 2. Publicar (a cada versão)

```bash
python scripts/verificar_predeploy.py        # opcional: o deploy já roda este passo
bash scripts/deploy_hostinger.sh --simular   # lista o que seria enviado, sem conectar
bash scripts/deploy_hostinger.sh             # deploy de verdade
```

No Windows, rode os comandos no **Git Bash**.

O deploy faz, em ordem:
1. **Verificação pré-deploy.** Se houver falha, nada é enviado.
2. **Empacotamento.** Entram só os arquivos do app: nada de `.env`, `instance/`, `*.db`, backups ou `__pycache__`. O pacote vai por `tar` via SSH, então não precisa de `rsync`.
3. **No servidor:**
   - confere o `.env` e verifica se `IRIS_DB_PATH` está fora de `public_html`;
   - faz backup do código e do SQLite em `~/iris-backups` (guarda os últimos 5);
   - troca a pasta `app/` inteira, para não sobrar arquivo removido;
   - instala o `requirements.txt` no virtualenv;
   - **importa o `passenger_wsgi.py` e testa `/login`, `/sw.js` e `/manifest.webmanifest`**. Essa importação também aplica as migrações do SQLite e roda o diagnóstico do Supabase;
   - se algo falhar, **restaura o código anterior** e o site continua no ar com a versão antiga;
   - reinicia o Passenger com `touch tmp/restart.txt`.
4. **Checagem externa:** abre `URL_SITE/login` e `URL_SITE/sw.js`.

### Voltar à versão anterior
```bash
bash scripts/deploy_hostinger.sh --rollback
```
O rollback restaura só o **código**. As migrações do banco são cumulativas. Se precisar voltar o banco também, restaure manualmente o `~/iris-backups/banco-<data>.db` correspondente para o caminho de `IRIS_DB_PATH`, com o app parado.

## 3. O que o verificador pré-deploy confere

| # | Checagem | Resultado |
|---|---|---|
| 1 | Git: árvore limpa; `.env`, bancos e chaves fora do versionamento | falha (sem Git: aviso) |
| 2 | Pacote sem SQLite, `.bak`, `.env`, `instance/`, chaves privadas e arquivos acima de 5 MB | falha / aviso |
| 3 | Segredos no código: chaves do Supabase (secret, `sbp_`, JWT service_role), Anthropic, Gemini, Groq, OpenAI, GitHub, URLs Postgres com senha, chaves privadas | falha |
| 4 | `.gitignore` cobre `.env` e `instance/` | falha |
| 5 | `.env.example` documenta **todas** as variáveis lidas pelo código e não tem valores reais | falha |
| 6 | Todos os `.py` compilam; `passenger_wsgi.py` define `application` e não liga o modo debug; `requirements.txt` cobre as bibliotecas importadas | falha |

Use `--estrito` para que avisos também bloqueiem (útil em CI).

## 4. Problemas comuns

| Sintoma | Causa provável / solução |
|---|---|
| "Serviço de autenticação indisponível" | Rode `python -m flask --app run iris supabase-diagnostico` no servidor, com o venv ativo. Em geral é a `SUPABASE_URL` errada ou a chave de outro projeto. |
| Links dos e-mails apontam para `http://` | Defina `IRIS_URL_PUBLICA` com `https://`. `IRIS_PROXY_FIX=1` (padrão) também corrige `request.scheme`. |
| Login cai toda hora em redes escolares | Use `IRIS_PROTECAO_SESSAO="basic"`. |
| Erro 500 sem detalhes | Veja o log de erros no hPanel (**Avançado → Logs**). O app registra os erros no stderr e o Passenger grava lá. |
| Mudanças no CSS/JS não aparecem para os alunos | O service worker guarda os arquivos para uso offline. Aumente `VERSAO` em `app/static/sw.js` a cada deploy que mude arquivos estáticos. |
| `database is locked` | O SQLite atende bem uma escola. Com muitos acessos simultâneos, é hora de migrar os dados para o Supabase. |
