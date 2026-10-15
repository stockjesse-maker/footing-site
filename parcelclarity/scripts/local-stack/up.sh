#!/usr/bin/env bash
# Starts a Docker-free local stack that mirrors the Supabase pieces ParcelClarity
# uses: PostgreSQL, Supabase Auth (GoTrue), PostgREST, a gateway that exposes
# /auth/v1 and /rest/v1 on one port, and an SMTP sink that captures outgoing mail.
#
# Prefer `supabase start` (Docker) when Docker is available. This stack exists so
# the app and its RLS policies can be tested in environments without Docker.
# Usage: scripts/local-stack/up.sh [--reset]
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

PGDATA="$PC_STACK_DIR/pgdata"
LOGS="$PC_STACK_DIR/logs"
RUN="$PC_STACK_DIR/run"
MAIL="$PC_STACK_DIR/mail"

for bin in "$PC_GOTRUE_BIN" "$PC_POSTGREST_BIN"; do
  [ -x "$bin" ] || { echo "Missing $bin. Run scripts/local-stack/install.sh first." >&2; exit 1; }
done

if [ "${1:-}" = "--reset" ]; then
  bash "$PC_SCRIPT_DIR/down.sh" || true
  rm -rf "$PGDATA" "$MAIL"
fi

mkdir -p "$PC_STACK_DIR" "$LOGS" "$RUN" "$MAIL"
if [ "$(id -u)" = "0" ]; then chown postgres:postgres "$PC_STACK_DIR"; fi

if [ ! -d "$PGDATA" ]; then
  echo "Initialising PostgreSQL cluster in $PGDATA"
  as_pg "$PC_PG_BIN/initdb" -D "$PGDATA" -U postgres -E UTF8 --auth-host=trust --auth-local=trust >/dev/null
fi

if ! "$PC_PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PC_PG_PORT"; then
  echo "Starting PostgreSQL on $PC_PG_PORT"
  as_pg "$PC_PG_BIN/pg_ctl" -D "$PGDATA" -l "$PC_STACK_DIR/postgres.log" -w \
    -o "-p $PC_PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c max_connections=200" start >/dev/null
fi

echo "Bootstrapping roles and schemas"
psql_su postgres -f "$PC_SCRIPT_DIR/bootstrap.sql"

export DATABASE_URL="postgres://supabase_auth_admin:$PC_DB_PASSWORD@127.0.0.1:$PC_PG_PORT/postgres"
export GOTRUE_API_HOST=127.0.0.1 GOTRUE_API_PORT="$PC_GOTRUE_PORT"
export API_EXTERNAL_URL="http://127.0.0.1:$PC_GATEWAY_PORT"
# Hosted Supabase serves Auth under /auth/v1, so emailed links must include that prefix.
export GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify
export GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify
export GOTRUE_DB_DRIVER=postgres GOTRUE_DB_DATABASE_URL="$DATABASE_URL" GOTRUE_DB_NAMESPACE=auth
export GOTRUE_SITE_URL="$PC_SITE_URL" GOTRUE_URI_ALLOW_LIST="$PC_SITE_URL/**,http://localhost:3100/**"
export GOTRUE_JWT_SECRET="$PC_JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
export GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=false
export GOTRUE_SMTP_HOST=127.0.0.1 GOTRUE_SMTP_PORT="$PC_SMTP_PORT" GOTRUE_SMTP_USER= GOTRUE_SMTP_PASS=
export GOTRUE_SMTP_ADMIN_EMAIL=no-reply@parcelclarity.local GOTRUE_SMTP_SENDER_NAME=ParcelClarity
export GOTRUE_PASSWORD_MIN_LENGTH=10 GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true
export GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_RATE_LIMIT_HEADER=X-Forwarded-For
export GOTRUE_LOG_LEVEL=warn

echo "Running Supabase Auth migrations"
"$PC_GOTRUE_BIN" migrate >"$LOGS/gotrue-migrate.log" 2>&1 || { tail -30 "$LOGS/gotrue-migrate.log"; exit 1; }

echo "Applying application migrations"
psql_su postgres -c "create schema if not exists local_stack; create table if not exists local_stack.applied_migrations (name text primary key, applied_at timestamptz not null default now());"
for f in "$PC_REPO_DIR"/supabase/migrations/*.sql; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  done_already="$(psql_su postgres -tA -c "select 1 from local_stack.applied_migrations where name = '$name'")"
  if [ -z "$done_already" ]; then
    echo "  applying $name"
    psql_su postgres -1 -f "$f"
    psql_su postgres -c "insert into local_stack.applied_migrations(name) values ('$name')"
  fi
done

start_bg() { # name, command...
  local name="$1"; shift
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then return; fi
  nohup "$@" >"$LOGS/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
}

export PC_MAIL_DIR="$MAIL"
start_bg smtp node "$PC_SCRIPT_DIR/smtp-sink.mjs"
start_bg gotrue "$PC_GOTRUE_BIN" serve
PGRST_DB_URI="postgres://authenticator:$PC_DB_PASSWORD@127.0.0.1:$PC_PG_PORT/postgres" \
PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$PC_JWT_SECRET" \
PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT="$PC_POSTGREST_PORT" PGRST_DB_EXTRA_SEARCH_PATH=extensions \
PGRST_DB_MAX_ROWS=1000 \
  start_bg postgrest "$PC_POSTGREST_BIN"
start_bg gateway node "$PC_SCRIPT_DIR/gateway.mjs"

psql_su postgres -c "notify pgrst, 'reload schema'" >/dev/null

echo "Waiting for services"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PC_GATEWAY_PORT/auth/v1/health" >/dev/null 2>&1 \
     && curl -sS -o /dev/null "http://127.0.0.1:$PC_GATEWAY_PORT/rest/v1/" 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "${ready:-}" = "1" ] || { echo "Services did not become ready; see $LOGS" >&2; exit 1; }

ANON="$(node "$PC_SCRIPT_DIR/keys.mjs" anon)"
SERVICE="$(node "$PC_SCRIPT_DIR/keys.mjs" service)"
cat >"$PC_STACK_DIR/env" <<ENVEOF
NEXT_PUBLIC_SITE_URL=$PC_SITE_URL
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:$PC_GATEWAY_PORT
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON
SUPABASE_SERVICE_ROLE_KEY=$SERVICE
PC_DATABASE_URL=postgres://postgres@127.0.0.1:$PC_PG_PORT/postgres
PC_MAIL_DIR=$MAIL
ENVEOF
echo
echo "Local stack is up. Environment written to $PC_STACK_DIR/env :"
echo "  API URL  : http://127.0.0.1:$PC_GATEWAY_PORT"
echo "  Postgres : postgres://postgres@127.0.0.1:$PC_PG_PORT/postgres"
echo "  Mail dir : $MAIL"
echo "Copy the env file:  cp $PC_STACK_DIR/env .env.local"
