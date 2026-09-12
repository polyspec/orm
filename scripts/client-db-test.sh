#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$HOME/.cargo/bin:$PATH"
export PATH
DRIVER=${1:-}
if [ "$DRIVER" != mysql ] && [ "$DRIVER" != postgres ] && [ "$DRIVER" != sqlite ]; then
  echo "usage: client-db-test.sh mysql|postgres|sqlite" >&2
  exit 2
fi

: "${ORM_GO_DSN:?ORM_GO_DSN is required}"
: "${ORM_PHP_DSN:?ORM_PHP_DSN is required}"
: "${ORM_RUST_DSN:?ORM_RUST_DSN is required}"
: "${ORM_TYPESCRIPT_DSN:?ORM_TYPESCRIPT_DSN is required}"

OUT="$ROOT/.runtime/client-db-$DRIVER"
mkdir -p "$OUT" "$ROOT/bin"
if [ "${ORM_CLIENT_DB_SKIP_BUILD:-0}" != 1 ]; then
  (cd "$ROOT" && go build -o bin/ormd ./cmd/ormd)
  (cd "$ROOT" && GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o bin/ormengine.wasm ./engine/wasm)
  (cd "$ROOT" && npm run typescript:build >/dev/null)
  (cd "$ROOT/clients/rust" && cargo build --locked --release -p orm-tests --bin integration)
fi

SOCKET="$OUT/ormd.sock"
READY="$OUT/ready.pipe"
rm -f "$SOCKET" "$READY"
mkfifo "$READY"
exec 3<>"$READY"
rm -f "$READY"
"$ROOT/bin/ormd" -listen 127.0.0.1:0 -socket "$SOCKET" -schema "$ROOT/schema/schema.json" -dialect "$DRIVER" -ready-fd 4 4>&3 >"$OUT/server.out" 2>"$OUT/server.log" &
SERVER_PID=$!
cleanup() {
  exec 3>&-
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
IFS= read -r ENDPOINT <&3
test -n "$ENDPOINT"

cd "$ROOT"
LANGS=,${ORM_CLIENT_DB_LANGS:-go,php,rust,typescript},
case "$LANGS" in *,go,*) ORM_TEST_DRIVER="$DRIVER" ORM_TEST_DSN="$ORM_GO_DSN" go test ./clients/go/gen -count=1;; esac
case "$LANGS" in *,php,*) ORM_TEST_DRIVER="$DRIVER" ORM_TEST_DSN="$ORM_PHP_DSN" php clients/php/tests/integration.php "$SOCKET" "$ROOT/schema/schema.json";; esac
case "$LANGS" in *,rust,*) ORM_TEST_DRIVER="$DRIVER" ORM_TEST_DSN="$ORM_RUST_DSN" "$ROOT/clients/rust/target/release/integration" "$ROOT/bin/ormengine.wasm" "$ROOT/schema/schema.json";; esac
case "$LANGS" in *,typescript,*) ORM_TEST_DRIVER="$DRIVER" ORM_TEST_DSN="$ORM_TYPESCRIPT_DSN" node tests/typescript/sqlite-integration.mjs "$ENDPOINT" "$ORM_TYPESCRIPT_DSN";; esac
