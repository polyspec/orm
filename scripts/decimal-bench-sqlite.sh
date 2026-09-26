#!/bin/sh
# Prepare a separate SQLite bench database with exact decimal storage.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUNTIME="$ROOT/.runtime"
DB="$RUNTIME/decimal-bench.sqlite"
LOCK="$RUNTIME/decimal-bench.lock"
mkdir -p "$RUNTIME"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "decimal SQLite bench preparation is already running" >&2
  exit 1
fi
TMP=""
cleanup() {
  if [ -n "$TMP" ]; then rm -f -- "$TMP"; fi
  rmdir "$LOCK"
}
trap cleanup EXIT HUP INT TERM

if [ ! -f "$DB" ]; then
  TMP=$(mktemp "$RUNTIME/decimal-bench.XXXXXXXX")
  sqlite3 "$TMP" < "$ROOT/bench/sql/author.sqlite.sql"
  sqlite3 "$TMP" < "$ROOT/bench/sql/seed.sqlite.sql"
  (cd "$ROOT" && go run ./bench/seedaes -driver sqlite -dsn "file:$TMP")
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
