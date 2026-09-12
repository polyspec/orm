#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/.runtime/typescript-sqlite"
DB_PATH=${ORM_SQLITE_PATH:-/tmp/orm_bench.sqlite}
mkdir -p "$OUT"

go build -o "$OUT/ormd" ./cmd/ormd
npm run typescript:build >/dev/null
ready_pipe="$OUT/ready.pipe"
rm -f "$ready_pipe"
mkfifo "$ready_pipe"
exec 3<>"$ready_pipe"
rm -f "$ready_pipe"
"$OUT/ormd" -listen 127.0.0.1:0 -schema schema/schema.json -dialect sqlite -ready-fd 4 4>&3 >"$OUT/server.out" 2>"$OUT/server.log" &
server_pid=$!
cleanup() { exec 3>&-; kill "$server_pid" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
IFS= read -r endpoint <&3
test -n "$endpoint"
node tests/typescript/sqlite-integration.mjs "$endpoint" "$DB_PATH"
