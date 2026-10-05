#!/bin/sh
# Recreates the bench databases named by BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and
# BENCH_SQLITE_DSN: installs schema/bench.dbs through the generated Go model,
# runs the seed of each dialect and fills the AES and blind-index columns.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
: "${BENCH_MYSQL_DSN:?BENCH_MYSQL_DSN is required; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run}"
: "${BENCH_POSTGRES_DSN:?BENCH_POSTGRES_DSN is required; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run}"
: "${BENCH_SQLITE_DSN:?BENCH_SQLITE_DSN is required; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run}"

# mysql://user@host:port/db?query -> user, host, port, db
mysql_rest=${BENCH_MYSQL_DSN#mysql://}
mysql_user=${mysql_rest%%@*}
mysql_addr=${mysql_rest#*@}; mysql_addr=${mysql_addr%%/*}
mysql_host=${mysql_addr%:*}
mysql_port=${mysql_addr##*:}
mysql_db=${mysql_rest#*/}; mysql_db=${mysql_db%%\?*}
# postgres://user@host:port/db?query -> the server URI without the database
pg_rest=${BENCH_POSTGRES_DSN#postgres://}
pg_server=${pg_rest%%/*}
pg_db=${pg_rest#*/}; pg_db=${pg_db%%\?*}
sqlite_path=${BENCH_SQLITE_DSN#sqlite://}; sqlite_path=${sqlite_path%%\?*}

mysql_cli() {
  mysql --no-defaults --protocol=TCP -h "$mysql_host" -P "$mysql_port" -u "$mysql_user" "$@"
}

mysql_cli -e "DROP DATABASE IF EXISTS \`$mysql_db\`; CREATE DATABASE \`$mysql_db\`"
node "$ROOT/tests/go-run.mjs" bench-install ./bench/install -dsn "$BENCH_MYSQL_DSN"
mysql_cli --init-command="SET time_zone='+00:00'" "$mysql_db" < bench/sql/seed.mysql.sql
node "$ROOT/tests/go-run.mjs" bench-seedaes ./bench/seedaes -driver mysql -dsn "$mysql_user@tcp($mysql_host:$mysql_port)/$mysql_db?parseTime=true"

PGTZ=UTC psql -X -q -v ON_ERROR_STOP=1 "postgres://$pg_server/postgres?sslmode=disable" \
  -c "DROP DATABASE IF EXISTS \"$pg_db\"" -c "CREATE DATABASE \"$pg_db\""
node "$ROOT/tests/go-run.mjs" bench-install ./bench/install -dsn "$BENCH_POSTGRES_DSN"
PGTZ=UTC PGOPTIONS='-c client_min_messages=warning' psql -X -q -o /dev/null -v ON_ERROR_STOP=1 \
  "postgres://$pg_server/$pg_db?sslmode=disable" -f bench/sql/seed.pg.sql
node "$ROOT/tests/go-run.mjs" bench-seedaes ./bench/seedaes -driver postgres -dsn "postgres://$pg_server/$pg_db?sslmode=disable"

rm -f "$sqlite_path" "$sqlite_path-wal" "$sqlite_path-shm"
node "$ROOT/tests/go-run.mjs" bench-install ./bench/install -dsn "$BENCH_SQLITE_DSN"
sqlite3 "$sqlite_path" < bench/sql/seed.sqlite.sql
node "$ROOT/tests/go-run.mjs" bench-seedaes ./bench/seedaes -driver sqlite -dsn "file:$sqlite_path"
echo "bench-db: $mysql_db, $pg_db and $sqlite_path installed from schema/bench.dbs and seeded"
