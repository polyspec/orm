#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RESULT="$ROOT/.runtime/db-tests"
mkdir -p "$RESULT"
rm -f "$RESULT/go.exit" "$RESULT/go.log"

if command -v containerctl >/dev/null 2>&1; then
  containerctl -f "$ROOT/tests/compose.yaml" down >/dev/null 2>&1 || true
  cleanup() {
    containerctl -f "$ROOT/tests/compose.yaml" down >/dev/null 2>&1 || true
  }
  trap cleanup EXIT INT TERM
  containerctl -f "$ROOT/tests/compose.yaml" up
  end=$(( $(date +%s) + 900 ))
  while [ ! -f "$RESULT/go.exit" ]; do
    if [ "$(date +%s)" -ge "$end" ]; then
      echo "physical DB test timed out" >&2
      containerctl -f "$ROOT/tests/compose.yaml" logs go-physical >&2 || true
      exit 1
    fi
    sleep 2
  done
  code=$(cat "$RESULT/go.exit")
  cat "$RESULT/go.log"
  exit "$code"
fi

if [ "${CI:-}" = "true" ] && [ -n "${ORM_TOOLS_MYSQL_DSN:-}" ] && [ -n "${ORM_TOOLS_POSTGRES_DSN:-}" ]; then
  cd "$ROOT"
  exec go test -tags physical ./internal/ormgen -run 'TestPhysicalMigration|TestSQLite(Diff|Rebuild)' -count=1
fi

echo "containerctl is required for local physical DB tests" >&2
exit 2
