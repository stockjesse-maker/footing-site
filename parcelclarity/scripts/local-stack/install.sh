#!/usr/bin/env bash
# Fetches/builds the two server binaries the Docker-free local stack needs.
# Needs: Go (>=1.24), curl, tar, xz, and outbound access to github.com release
# assets and proxy.golang.org. Installs into /opt/pc-stack/bin (override with PC_BIN_DIR).
#
#  * PostgREST: official static release binary.
#  * Supabase Auth (GoTrue): built from the Go module proxy. The upstream go.mod
#    carries a `replace` for a vendored godotenv fork that is not included in the
#    module zip, so we drop that single line and use upstream godotenv v1.5.1.
#    This binary is for LOCAL TESTING ONLY. Hosted projects run Supabase's build.
set -euo pipefail
BIN="${PC_BIN_DIR:-/opt/pc-stack/bin}"
SRC="${PC_SRC_DIR:-/opt/pc-stack/src}"
POSTGREST_VERSION="${POSTGREST_VERSION:-v12.2.3}"
AUTH_VERSION="${AUTH_VERSION:-v1.11.1-0.20260922104245-ce9a8eee0cc0}"
mkdir -p "$BIN" "$SRC"

if [ ! -x "$BIN/postgrest" ]; then
  curl -fsSL -o "$SRC/postgrest.tar.xz" "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/postgrest-$POSTGREST_VERSION-linux-static-x64.tar.xz"
  tar -xJf "$SRC/postgrest.tar.xz" -C "$BIN"
fi

if [ ! -x "$BIN/gotrue" ]; then
  export GOFLAGS=-mod=mod
  mkdir -p "$SRC/dl" && cd "$SRC/dl"
  [ -f go.mod ] || go mod init dl >/dev/null 2>&1
  DIR="$(go mod download -json "github.com/supabase/auth@$AUTH_VERSION" | grep '"Dir"' | sed 's/.*: "//;s/",*//')"
  rm -rf "$SRC/auth" && cp -r "$DIR" "$SRC/auth" && chmod -R u+w "$SRC/auth"
  cd "$SRC/auth"
  sed -i '/^replace github.com\/joho\/godotenv/d' go.mod
  go build -o "$BIN/gotrue" .
fi
echo "Installed: $BIN/postgrest, $BIN/gotrue"
