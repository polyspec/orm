#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/.runtime/proto-connect"
mkdir -p "$OUT"

go build -o "$OUT/ormd" ./cmd/ormd
npm run typescript:build >/dev/null
(cd clients/rust && PATH="$HOME/.cargo/bin:$PATH" cargo build -p orm-tests --bin compiler_connect >/dev/null)

"$OUT/ormd" -listen 127.0.0.1:0 -schema schema/schema.json >"$OUT/server.out" 2>"$OUT/server.log" &
server_pid=$!
cleanup() { kill "$server_pid" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

attempt=0
while ! grep -q 'Connect listening on http://' "$OUT/server.log"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    cat "$OUT/server.log" >&2
    exit 1
  fi
  sleep 0.05
done
endpoint=$(sed -n 's|.*Connect listening on \(http://[^/]*\)/.*|\1|p' "$OUT/server.log")
test -n "$endpoint"

go run ./tests/proto/runner_go "$endpoint" >"$OUT/go.json"
php tests/proto/runner.php "$endpoint" >"$OUT/php.json"
node tests/proto/runner.mjs "$endpoint" >"$OUT/typescript.json"
clients/rust/target/debug/compiler_connect "$endpoint" >"$OUT/rust.json"
node tests/proto/compare.mjs "$OUT/go.json" "$OUT/php.json" "$OUT/rust.json" "$OUT/typescript.json"
