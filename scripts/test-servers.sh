#!/bin/sh
# Starts and stops the MySQL 8.4 and PostgreSQL 17 servers of the database
# checks under .runtime/servers. The servers listen on 127.0.0.1 over TCP; the
# only other endpoint is the MySQL socket in .runtime/servers, which stop uses.
#
#   test-servers.sh start <mysql-port> <postgres-port>
#   test-servers.sh stop
#
# start initializes both servers, creates the databases orm_test, orm_tools
# and orm_bench, seeds orm_bench and the SQLite bench file, and writes the
# environment file .runtime/servers/env last. When that file exists, start
# prints it and changes nothing. A failed start stops the servers it started
# and keeps the logs in .runtime/servers. stop stops the servers that start
# started and removes .runtime/servers.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIR="$ROOT/.runtime/servers"
ENV_FILE="$DIR/env"
MYSQL_PID="$DIR/mysql.pid"
POSTGRES_DATA="$DIR/postgres"

usage() {
  echo "usage: test-servers.sh start <mysql-port> <postgres-port> | stop" >&2
  exit 2
}

port() {
  case "$1" in
    ''|*[!0-9]*) echo "test-servers: invalid port '$1'" >&2; exit 2 ;;
  esac
  if [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then
    echo "test-servers: invalid port '$1'" >&2
    exit 2
  fi
}

mysql_running() {
  [ -f "$MYSQL_PID" ] && kill -0 "$(cat "$MYSQL_PID")" 2>/dev/null
}

postgres_running() {
  [ -f "$POSTGRES_DATA/postmaster.pid" ] && pg_ctl -D "$POSTGRES_DATA" status >/dev/null 2>&1
}

stop_servers() {
  if mysql_running; then
    # Through the server socket, shutdown returns after the server removes its
    # pid file; through TCP it returns at once.
    mysqladmin --no-defaults --socket="$DIR/mysql.sock" -u root shutdown
    echo "test-servers: stopped MySQL"
  fi
  if postgres_running; then
    pg_ctl -D "$POSTGRES_DATA" -m fast -w stop >/dev/null
    echo "test-servers: stopped PostgreSQL"
  fi
}

mysql_cli() {
  mysql --no-defaults --protocol=TCP -h 127.0.0.1 -P "$MYSQL_PORT" -u root "$@"
}

psql_cli() {
  PGTZ=UTC PGOPTIONS='-c client_min_messages=warning' psql -X -q -o /dev/null -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$POSTGRES_PORT" -U orm "$@"
}

start() {
  if [ -f "$ENV_FILE" ]; then
    if ! mysql_running || ! postgres_running; then
      echo "test-servers: $ENV_FILE exists but a server is not running; run make test-servers-stop" >&2
      exit 1
    fi
    echo "test-servers: running; environment $ENV_FILE"
    cat "$ENV_FILE"
    return
  fi
  if [ -e "$DIR" ]; then
    echo "test-servers: $DIR holds an incomplete start; run make test-servers-stop" >&2
    exit 1
  fi
  mkdir -p "$DIR"
  trap 'status=$?; if [ "$status" -ne 0 ]; then echo "test-servers: start failed; logs are in $DIR" >&2; stop_servers; fi' EXIT

  mysqld --no-defaults --initialize-insecure --datadir="$DIR/mysql" --log-error="$DIR/mysql-init.log"
  # --daemonize returns after the server accepts connections or fails.
  mysqld --no-defaults --daemonize --datadir="$DIR/mysql" --pid-file="$MYSQL_PID" \
    --log-error="$DIR/mysql.log" --bind-address=127.0.0.1 --port="$MYSQL_PORT" \
    --socket="$DIR/mysql.sock" --mysqlx=OFF
  echo "test-servers: MySQL on 127.0.0.1:$MYSQL_PORT"

  initdb -D "$POSTGRES_DATA" -U orm --auth=trust --encoding=UTF8 --locale=C >"$DIR/postgres-init.log"
  # -w returns after the server reports that it accepts connections.
  pg_ctl -D "$POSTGRES_DATA" -l "$DIR/postgres.log" -w \
    -o "-p $POSTGRES_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
  echo "test-servers: PostgreSQL on 127.0.0.1:$POSTGRES_PORT"

  mysql_tzinfo_to_sql /usr/share/zoneinfo 2>"$DIR/mysql-tzinfo.log" | mysql_cli mysql
  mysql_cli -e 'CREATE DATABASE orm_test; CREATE DATABASE orm_tools; CREATE DATABASE orm_bench'
  psql_cli postgres -c 'CREATE DATABASE orm_test' -c 'CREATE DATABASE orm_tools' -c 'CREATE DATABASE orm_bench'

  mysql_cli --init-command="SET time_zone='+00:00'" orm_bench < "$ROOT/bench/sql/battle.sql"
  mysql_cli --init-command="SET time_zone='+00:00'" orm_bench < "$ROOT/bench/sql/seed.mysql.sql"
  psql_cli orm_bench -f "$ROOT/bench/sql/battle.pg.sql"
  psql_cli orm_bench -f "$ROOT/bench/sql/seed.pg.sql"
  sqlite3 "$DIR/orm_bench.sqlite" < "$ROOT/bench/sql/battle.sqlite.sql"
  sqlite3 "$DIR/orm_bench.sqlite" < "$ROOT/bench/sql/seed.sqlite.sql"
  (cd "$ROOT" && go run ./bench/seedaes -driver mysql -dsn "root@tcp(127.0.0.1:$MYSQL_PORT)/orm_bench?parseTime=true")
  (cd "$ROOT" && go run ./bench/seedaes -driver postgres -dsn "postgres://orm@127.0.0.1:$POSTGRES_PORT/orm_bench?sslmode=disable")
  (cd "$ROOT" && go run ./bench/seedaes -driver sqlite -dsn "file:$DIR/orm_bench.sqlite")

  mysql="mysql://root@127.0.0.1:$MYSQL_PORT"
  postgres="postgres://orm@127.0.0.1:$POSTGRES_PORT"
  cat > "$ENV_FILE.tmp" <<EOF
export ORM_TEST_MYSQL_DSN='$mysql/orm_test'
export ORM_TEST_POSTGRES_DSN='$postgres/orm_test?sslmode=disable'
export ORM_TOOLS_MYSQL_DSN='$mysql/orm_tools'
export ORM_TOOLS_POSTGRES_DSN='$postgres/orm_tools?sslmode=disable'
export ORM_BENCH_MYSQL_DSN='$mysql/orm_bench'
export BENCH_MYSQL_DSN='$mysql/orm_bench?timezone=%2B00:00'
export BENCH_POSTGRES_DSN='$postgres/orm_bench?sslmode=disable&timezone=%2B00:00'
export BENCH_SQLITE_DSN='sqlite://$DIR/orm_bench.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00'
EOF
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  trap - EXIT
  echo "test-servers: started; environment $ENV_FILE"
}

[ $# -ge 1 ] || usage
case "$1" in
  start)
    [ $# -eq 3 ] || usage
    port "$2"
    port "$3"
    MYSQL_PORT=$2
    POSTGRES_PORT=$3
    start
    ;;
  stop)
    [ $# -eq 1 ] || usage
    if [ ! -e "$DIR" ]; then
      echo "test-servers: no servers under $DIR"
      exit 0
    fi
    stop_servers
    rm -rf "$DIR"
    echo "test-servers: removed $DIR"
    ;;
  *) usage ;;
esac
