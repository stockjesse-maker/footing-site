#!/usr/bin/env bash
# Shared settings for the Docker-free local Supabase-compatible stack.
# LOCAL DEVELOPMENT AND TESTING ONLY. The credentials below are well-known dev
# values and must never be used in any hosted environment.
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  : "${PC_STACK_DIR:=/var/lib/parcelclarity-stack}"
else
  : "${PC_STACK_DIR:=$HOME/.parcelclarity-stack}"
fi
: "${PC_PG_BIN:=$(pg_config --bindir 2>/dev/null || echo /usr/lib/postgresql/16/bin)}"
: "${PC_GOTRUE_BIN:=/opt/pc-stack/bin/gotrue}"
: "${PC_POSTGREST_BIN:=/opt/pc-stack/bin/postgrest}"

export PC_PG_PORT="${PC_PG_PORT:-54322}"
export PC_GATEWAY_PORT="${PC_GATEWAY_PORT:-54321}"
export PC_GOTRUE_PORT="${PC_GOTRUE_PORT:-9999}"
export PC_POSTGREST_PORT="${PC_POSTGREST_PORT:-54323}"
export PC_SMTP_PORT="${PC_SMTP_PORT:-54325}"
export PC_SITE_URL="${PC_SITE_URL:-http://localhost:3000}"
export PC_JWT_SECRET="${PC_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}"
export PC_DB_PASSWORD="${PC_DB_PASSWORD:-postgres}"

PC_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PC_REPO_DIR="$(cd "$PC_SCRIPT_DIR/../.." && pwd)"

# Run a command as the postgres OS user when we are root (initdb/postgres refuse to run as root).
as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}
psql_su() { # superuser psql against a database ($1), remaining args passed through
  local db="$1"; shift
  "$PC_PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PC_PG_PORT" -U postgres -d "$db" "$@"
}
