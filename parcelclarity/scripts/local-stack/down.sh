#!/usr/bin/env bash
# Stops everything started by up.sh. Data is kept; use `up.sh --reset` to wipe it.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
RUN="$PC_STACK_DIR/run"
for name in gateway postgrest gotrue smtp; do
  if [ -f "$RUN/$name.pid" ]; then
    kill "$(cat "$RUN/$name.pid")" 2>/dev/null || true
    rm -f "$RUN/$name.pid"
  fi
done
if [ -d "$PC_STACK_DIR/pgdata" ] && "$PC_PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PC_PG_PORT"; then
  as_pg "$PC_PG_BIN/pg_ctl" -D "$PC_STACK_DIR/pgdata" -m fast -w stop >/dev/null
fi
echo "Local stack stopped."
