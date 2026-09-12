#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/.runtime/proto-connect"
mkdir -p "$OUT"

go build -o "$OUT/ormd" ./cmd/ormd
npm run typescript:build >/dev/null
(cd clients/rust && PATH="$HOME/.cargo/bin:$PATH" cargo build -p orm-tests --bin compiler_connect >/dev/null)

ready_pipe="$OUT/ready.pipe"
rm -f "$ready_pipe"
mkfifo "$ready_pipe"
exec 3<>"$ready_pipe"
rm -f "$ready_pipe"

"$OUT/ormd" -listen 127.0.0.1:0 -schema schema/schema.json -ready-fd 4 4>&3 >"$OUT/server.out" 2>"$OUT/server.log" &
server_pid=$!
cleanup() { exec 3>&-; kill "$server_pid" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

IFS= read -r endpoint <&3
test -n "$endpoint"

go run ./tests/proto/runner_go "$endpoint" >"$OUT/go.json"
php tests/proto/runner.php "$endpoint" >"$OUT/php.json"
php clients/php/tests/compiler_bridge.php
node tests/proto/runner.mjs "$endpoint" >"$OUT/typescript.json"
clients/rust/target/debug/compiler_connect "$endpoint" >"$OUT/rust.json"
node tests/proto/compare.mjs "$OUT/go.json" "$OUT/php.json" "$OUT/rust.json" "$OUT/typescript.json"
