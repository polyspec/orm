#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOCKET="/tmp/ormd-perf-$$.sock"
BIN="$ROOT/.runtime/ormd-perf"
mkdir -p "$ROOT/.runtime"

cd "$ROOT"
go build -o "$BIN" ./cmd/ormd
"$BIN" -socket "$SOCKET" -schema "$ROOT/schema/schema.json" -dialect mysql >"$ROOT/.runtime/ormd-perf.log" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
  wait "$PID" >/dev/null 2>&1 || true
  rm -f "$SOCKET"
}
trap cleanup EXIT INT TERM

i=0
while [ ! -S "$SOCKET" ]; do
  i=$((i + 1))
  if [ "$i" -ge 100 ]; then
    cat "$ROOT/.runtime/ormd-perf.log" >&2
    exit 1
  fi
  sleep 0.05
done

ORM_RUN_PERF_GATE=1 go test ./bench/go -run TestHotPathGate -count=1 -v
php clients/php/tests/perf_gate.php "$SOCKET" "$ROOT/schema/schema.json"
