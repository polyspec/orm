#!/bin/sh
# Prepare a separate SQLite bench database with exact decimal storage.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUNTIME="$ROOT/.runtime"
DB="$RUNTIME/decimal-bench.sqlite"
LEASES="$RUNTIME/decimal-bench.leases"
mkdir -p "$RUNTIME"
# 준비는 exclusive lease(tests/lease) 아래에서 한다. lease는 보유자가 어떻게 끝나든 막지 않는다: 끝난 보유자의
# lease는 releaser가 지우거나 다음 exclusive 보유자가 가져가므로, kill된 준비가 다음 준비를 막지 않는다.
if [ -z "${DECIMAL_BENCH_LEASED:-}" ]; then
  exec "${LEASE:?LEASE is unset; run this through make, which exports it}" run "$LEASES" exclusive --wait -- \
    env DECIMAL_BENCH_LEASED=1 sh "$0" "$@"
fi
TMP=""
cleanup() {
  if [ -n "$TMP" ]; then rm -f -- "$TMP"; fi
}
trap cleanup EXIT HUP INT TERM

if [ ! -f "$DB" ]; then
  TMP=$(mktemp "$RUNTIME/decimal-bench.XXXXXXXX")
  (cd "$ROOT" && node tests/go-run.mjs bench-install ./bench/install -dsn "sqlite://$TMP")
  sqlite3 "$TMP" < "$ROOT/bench/sql/seed.sqlite.sql"
  (cd "$ROOT" && node tests/go-run.mjs bench-seedaes ./bench/seedaes -driver sqlite -dsn "file:$TMP")
  mv -n -- "$TMP" "$DB"
  TMP=""
fi

TYPE=$(sqlite3 "$DB" "SELECT type FROM pragma_table_info('author') WHERE name='price'")
if [ "$TYPE" != 'DECIMALINT(13,3)' ]; then
  echo "decimal SQLite bench price type is $TYPE, expected DECIMALINT(13,3)" >&2
  exit 1
fi
ROWS=$(sqlite3 "$DB" 'SELECT count(*) FROM author')
if [ "$ROWS" != 100000 ]; then
  echo "decimal SQLite bench has $ROWS rows, expected 100000" >&2
  exit 1
fi
printf 'sqlite://%s?_pragma=busy_timeout(5000)&timezone=%%2B00:00\n' "$DB"
