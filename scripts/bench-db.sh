#!/bin/sh
# Recreates the bench databases named by BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and
# BENCH_SQLITE_DSN: installs schema/bench.dbs through the generated Go model,
# runs the seed of each dialect and fills the AES and blind-index columns.
#
# Usage: scripts/bench-db.sh [mysql] [postgres] [sqlite]
# With no argument every dialect is seeded. A named dialect is seeded alone, and
# its DSN is required; the other DSNs are not read.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if [ "$#" -eq 0 ]; then
  set -- mysql postgres sqlite
fi
for dialect in "$@"; do
  case "$dialect" in
    mysql|postgres|sqlite) ;;
    *) echo "bench-db: unknown dialect $dialect; use mysql, postgres or sqlite" >&2; exit 2 ;;
  esac
done

# seed_mysql는 BENCH_MYSQL_DSN의 database를 다시 만들고 seed한다.
seed_mysql() {
  : "${BENCH_MYSQL_DSN:?BENCH_MYSQL_DSN is required; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run}"
  # mysql://user@host:port/db?query -> user, host, port, db
  mysql_rest=${BENCH_MYSQL_DSN#mysql://}
  mysql_user=${mysql_rest%%@*}
  mysql_addr=${mysql_rest#*@}; mysql_addr=${mysql_addr%%/*}
  mysql_host=${mysql_addr%:*}
  mysql_port=${mysql_addr##*:}
  mysql_db=${mysql_rest#*/}; mysql_db=${mysql_db%%\?*}

  mysql_cli() {
    mysql --no-defaults --protocol=TCP -h "$mysql_host" -P "$mysql_port" -u "$mysql_user" "$@"
  }

  mysql_cli -e "DROP DATABASE IF EXISTS \`$mysql_db\`; CREATE DATABASE \`$mysql_db\`"
  node "$ROOT/tests/go-run.mjs" bench-install ./bench/install -dsn "$BENCH_MYSQL_DSN"
  mysql_cli --init-command="SET time_zone='+00:00'" "$mysql_db" < bench/sql/seed.mysql.sql
  node "$ROOT/tests/go-run.mjs" bench-seedaes ./bench/seedaes -driver mysql -dsn "$mysql_user@tcp($mysql_host:$mysql_port)/$mysql_db?parseTime=true"
  echo "bench-db: $mysql_db installed from schema/bench.dbs and seeded"
}

# seed_postgres는 BENCH_POSTGRES_DSN의 database를 다시 만들고 seed한다.
seed_postgres() {
  : "${BENCH_POSTGRES_DSN:?BENCH_POSTGRES_DSN is required; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run}"
  # postgres://user@host:port/db?query -> the server URI without the database
  pg_rest=${BENCH_POSTGRES_DSN#postgres://}
  pg_server=${pg_rest%%/*}
  pg_db=${pg_rest#*/}; pg_db=${pg_db%%\?*}

  PGTZ=UTC psql -X -q -v ON_ERROR_STOP=1 "postgres://$pg_server/postgres?sslmode=disable" \
    -c "DROP DATABASE IF EXISTS \"$pg_db\"" -c "CREATE DATABASE \"$pg_db\""
  node "$ROOT/tests/go-run.mjs" bench-install ./bench/install -dsn "$BENCH_POSTGRES_DSN"
  PGTZ=UTC PGOPTIONS='-c client_min_messages=warning' psql -X -q -o /dev/null -v ON_ERROR_STOP=1 \
    "postgres://$pg_server/$pg_db?sslmode=disable" -f bench/sql/seed.pg.sql
  node "$ROOT/tests/go-run.mjs" bench-seedaes ./bench/seedaes -driver postgres -dsn "postgres://$pg_server/$pg_db?sslmode=disable"
  echo "bench-db: $pg_db installed from schema/bench.dbs and seeded"
}

# seed_sqlite는 BENCH_SQLITE_DSN의 file을 다시 만들고 seed한다. MySQL과 PostgreSQL 서버를 쓰지 않는다.
seed_sqlite() {
  : "${BENCH_SQLITE_DSN:?BENCH_SQLITE_DSN is required; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run}"
  sqlite_path=${BENCH_SQLITE_DSN#sqlite://}; sqlite_path=${sqlite_path%%\?*}

  rm -f "$sqlite_path" "$sqlite_path-wal" "$sqlite_path-shm"
  node "$ROOT/tests/go-run.mjs" bench-install ./bench/install -dsn "$BENCH_SQLITE_DSN"
  sqlite3 "$sqlite_path" < bench/sql/seed.sqlite.sql
  node "$ROOT/tests/go-run.mjs" bench-seedaes ./bench/seedaes -driver sqlite -dsn "file:$sqlite_path"
  echo "bench-db: $sqlite_path installed from schema/bench.dbs and seeded"
}

for dialect in "$@"; do
  "seed_$dialect"
done
