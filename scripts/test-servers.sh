#!/bin/sh
# Starts and stops the servers of the database checks under .runtime/servers:
# a MySQL 8.4 primary and its replica, a PostgreSQL 17 primary and its
# replica, a ProxySQL pooler in front of the MySQL primary, and a PgBouncer
# pooler in transaction mode in front of the PostgreSQL primary. The servers
# listen on 127.0.0.1 over TCP; the other endpoints are Unix sockets in
# .runtime/servers, which stop and the ProxySQL admin interface use.
#
#   test-servers.sh start <mysql-port> <postgres-port> <mysql-replica-port> \
#       <postgres-replica-port> <proxysql-port> <pgbouncer-port>
#   test-servers.sh stop
#
# start initializes the primaries and replicas, creates the databases
# orm_test, orm_tools and orm_bench, seeds orm_bench and the SQLite bench file,
# starts the poolers, and writes the environment file .runtime/servers/env
# last. When that file exists, start prints it and changes nothing. A failed
# start stops the servers it started and keeps the logs in .runtime/servers.
# stop stops the servers that start started and removes .runtime/servers.
#
# Each replica applies every change of its primary. The PostgreSQL primary
# names the replica in synchronous_standby_names with synchronous_commit=local,
# so a transaction that sets synchronous_commit=remote_apply and writes WAL
# commits after the replica has applied it, and the other transactions do not
# wait. A transaction that writes no WAL besides its commit record does not
# wait either.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIR="$ROOT/.runtime/servers"
ENV_FILE="$DIR/env"
MYSQL_PID="$DIR/mysql.pid"
MYSQL_REPLICA_PID="$DIR/mysql-replica.pid"
POSTGRES_DATA="$DIR/postgres"
POSTGRES_REPLICA_DATA="$DIR/postgres-replica"
PROXYSQL_DATA="$DIR/proxysql"
PROXYSQL_PID="$DIR/proxysql.pid"
PGBOUNCER_PID="$DIR/pgbouncer.pid"

usage() {
  echo "usage: test-servers.sh start <mysql-port> <postgres-port> <mysql-replica-port> <postgres-replica-port> <proxysql-port> <pgbouncer-port> | stop" >&2
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

pid_running() {
  [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null
}

postgres_running() {
  [ -f "$1/postmaster.pid" ] && pg_ctl -D "$1" status >/dev/null 2>&1
}

# stop_pid sends TERM to the process of a pid file and returns after the
# process has exited.
stop_pid() {
  pid=$(cat "$1")
  kill "$pid"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.1
  done
}

stop_servers() {
  if pid_running "$PGBOUNCER_PID"; then
    stop_pid "$PGBOUNCER_PID"
    echo "test-servers: stopped PgBouncer"
  fi
  if pid_running "$PROXYSQL_PID"; then
    stop_pid "$PROXYSQL_PID"
    echo "test-servers: stopped ProxySQL"
  fi
  # Through the server socket, shutdown returns after the server removes its
  # pid file; through TCP it returns at once.
  if pid_running "$MYSQL_REPLICA_PID"; then
    mysqladmin --no-defaults --socket="$DIR/mysql-replica.sock" -u root shutdown
    echo "test-servers: stopped the MySQL replica"
  fi
  if pid_running "$MYSQL_PID"; then
    mysqladmin --no-defaults --socket="$DIR/mysql.sock" -u root shutdown
    echo "test-servers: stopped MySQL"
  fi
  if postgres_running "$POSTGRES_REPLICA_DATA"; then
    pg_ctl -D "$POSTGRES_REPLICA_DATA" -m fast -w stop >/dev/null
    echo "test-servers: stopped the PostgreSQL replica"
  fi
  if postgres_running "$POSTGRES_DATA"; then
    pg_ctl -D "$POSTGRES_DATA" -m fast -w stop >/dev/null
    echo "test-servers: stopped PostgreSQL"
  fi
}

all_running() {
  pid_running "$MYSQL_PID" && pid_running "$MYSQL_REPLICA_PID" &&
    postgres_running "$POSTGRES_DATA" && postgres_running "$POSTGRES_REPLICA_DATA" &&
    pid_running "$PROXYSQL_PID" && pid_running "$PGBOUNCER_PID"
}

mysql_cli() {
  mysql --no-defaults --protocol=TCP -h 127.0.0.1 -P "$MYSQL_PORT" -u root "$@"
}

psql_cli() {
  PGTZ=UTC PGOPTIONS='-c client_min_messages=warning' psql -X -q -o /dev/null -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$POSTGRES_PORT" -U orm "$@"
}

start_mysql() {
  mysqld --no-defaults --initialize-insecure --datadir="$DIR/mysql" --log-error="$DIR/mysql-init.log"
  # --daemonize returns after the server accepts connections or fails.
  mysqld --no-defaults --daemonize --datadir="$DIR/mysql" --pid-file="$MYSQL_PID" \
    --log-error="$DIR/mysql.log" --bind-address=127.0.0.1 --port="$MYSQL_PORT" \
    --socket="$DIR/mysql.sock" --mysqlx=OFF --server-id=1
  echo "test-servers: MySQL on 127.0.0.1:$MYSQL_PORT"

  # The replica starts before the primary holds data and reads the binary log
  # of the primary from its first file, so it applies every later change.
  mysqld --no-defaults --initialize-insecure --datadir="$DIR/mysql-replica" --log-error="$DIR/mysql-replica-init.log"
  mysqld --no-defaults --daemonize --datadir="$DIR/mysql-replica" --pid-file="$MYSQL_REPLICA_PID" \
    --log-error="$DIR/mysql-replica.log" --bind-address=127.0.0.1 --port="$MYSQL_REPLICA_PORT" \
    --socket="$DIR/mysql-replica.sock" --mysqlx=OFF --server-id=2 --skip-replica-start
  mysql --no-defaults --protocol=TCP -h 127.0.0.1 -P "$MYSQL_REPLICA_PORT" -u root -e "
    CHANGE REPLICATION SOURCE TO SOURCE_HOST='127.0.0.1', SOURCE_PORT=$MYSQL_PORT, SOURCE_USER='root', GET_SOURCE_PUBLIC_KEY=1;
    START REPLICA;
    SET GLOBAL super_read_only = ON;"
  echo "test-servers: MySQL replica on 127.0.0.1:$MYSQL_REPLICA_PORT"
}

start_postgres() {
  initdb -D "$POSTGRES_DATA" -U orm --auth=trust --encoding=UTF8 --locale=C >"$DIR/postgres-init.log"
  # -w returns after the server reports that it accepts connections.
  pg_ctl -D "$POSTGRES_DATA" -l "$DIR/postgres.log" -w \
    -o "-p $POSTGRES_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c synchronous_standby_names=orm_replica -c synchronous_commit=local" start >/dev/null
  echo "test-servers: PostgreSQL on 127.0.0.1:$POSTGRES_PORT"

  # -R writes the standby configuration with the application name that
  # synchronous_standby_names of the primary lists.
  pg_basebackup -D "$POSTGRES_REPLICA_DATA" -R -X stream \
    -d "host=127.0.0.1 port=$POSTGRES_PORT user=orm application_name=orm_replica"
  pg_ctl -D "$POSTGRES_REPLICA_DATA" -l "$DIR/postgres-replica.log" -w \
    -o "-p $POSTGRES_REPLICA_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
  echo "test-servers: PostgreSQL replica on 127.0.0.1:$POSTGRES_REPLICA_PORT"
}

# start_logged <name> <line> <command> [<argument>...] runs a server in the
# foreground and writes its process id to $DIR/<name>.pid. A reader copies the
# output of the server to $DIR/<name>.log until the server exits. The reader
# reports through the FIFO $DIR/<name>.ready when the server logs a line that
# contains <line>, or when the server exits first; the start fails in the
# second case. The read of the FIFO blocks until one of these reports.
start_logged() {
  name=$1
  line=$2
  shift 2
  mkfifo "$DIR/$name.ready"
  sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$DIR/$name.pid" "$@" </dev/null 2>&1 |
    awk -v out="$DIR/$name.log" -v ready="$DIR/$name.ready" -v line="$line" '
      { print > out; fflush(out) }
      !done && index($0, line) { print "ready" > ready; close(ready); done = 1 }
      END { if (!done) { print "exited" > ready; close(ready) } }' >/dev/null &
  read -r state < "$DIR/$name.ready"
  rm "$DIR/$name.ready"
  if [ "$state" != ready ]; then
    echo "test-servers: $name exited before it accepted connections; see $DIR/$name.log" >&2
    exit 1
  fi
}

# start_proxysql pools the connections of the user orm to the MySQL primary
# and multiplexes them over at most four server connections. The admin and
# PostgreSQL interfaces listen on Unix sockets only.
start_proxysql() {
  mysql_cli -e "CREATE USER 'orm'@'127.0.0.1' IDENTIFIED BY 'orm'; GRANT ALL ON *.* TO 'orm'@'127.0.0.1'"
  mkdir -p "$PROXYSQL_DATA"
  cat > "$DIR/proxysql.cnf" <<EOF
datadir="$PROXYSQL_DATA"
admin_variables=
{
  admin_credentials="admin:admin"
  mysql_ifaces="$DIR/proxysql-admin.sock"
  pgsql_ifaces="$DIR/proxysql-admin-pgsql.sock"
  restapi_enabled=false
  web_enabled=false
}
mysql_variables=
{
  interfaces="127.0.0.1:$PROXYSQL_PORT"
  threads=2
  monitor_enabled=false
  server_version="8.4.0"
}
pgsql_variables=
{
  interfaces="$DIR/proxysql-pgsql.sock"
  monitor_enabled=false
}
mysql_servers=
(
  { address="127.0.0.1", port=$MYSQL_PORT, hostgroup=0, max_connections=4 }
)
mysql_users=
(
  { username="orm", password="orm", default_hostgroup=0 }
)
EOF
  # ProxySQL logs the consulting notice after its listeners are bound.
  start_logged proxysql 'For consultancy visit' \
    proxysql --foreground --initial --no-version-check -c "$DIR/proxysql.cnf" -D "$PROXYSQL_DATA"
  echo "test-servers: ProxySQL on 127.0.0.1:$PROXYSQL_PORT"
}

# start_pgbouncer pools the connections to the PostgreSQL primary in
# transaction mode over at most four server connections per database. The
# database orm_test_single reaches orm_test through one server connection, so
# every client of it shares the same server session. PgBouncer keeps the
# protocol-level prepared statements of each client and sets the tracked
# parameters of the client, including statement_timeout sent as a startup
# parameter, on every server connection it assigns to the client.
start_pgbouncer() {
  echo '"orm" ""' > "$DIR/pgbouncer-users.txt"
  cat > "$DIR/pgbouncer.ini" <<EOF
[databases]
orm_test_single = host=127.0.0.1 port=$POSTGRES_PORT dbname=orm_test pool_size=1
* = host=127.0.0.1 port=$POSTGRES_PORT

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = $PGBOUNCER_PORT
unix_socket_dir =
auth_type = trust
auth_file = $DIR/pgbouncer-users.txt
pool_mode = transaction
default_pool_size = 4
max_client_conn = 500
max_prepared_statements = 200
track_extra_parameters = statement_timeout
EOF
  # PgBouncer logs "process up" after it listens on its sockets.
  start_logged pgbouncer 'process up' pgbouncer "$DIR/pgbouncer.ini"
  echo "test-servers: PgBouncer on 127.0.0.1:$PGBOUNCER_PORT"
}

start() {
  if [ -f "$ENV_FILE" ]; then
    if ! all_running; then
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
  for tool in mysqld initdb pg_ctl pg_basebackup proxysql pgbouncer; do
    command -v "$tool" >/dev/null || { echo "test-servers: $tool is not installed" >&2; exit 1; }
  done
  mkdir -p "$DIR"
  trap 'status=$?; if [ "$status" -ne 0 ]; then echo "test-servers: start failed; logs are in $DIR" >&2; stop_servers; fi' EXIT

  start_mysql
  start_postgres

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

  start_proxysql
  start_pgbouncer

  mysql="mysql://root@127.0.0.1:$MYSQL_PORT"
  postgres="postgres://orm@127.0.0.1:$POSTGRES_PORT"
  cat > "$ENV_FILE.tmp" <<EOF
export ORM_TEST_MYSQL_DSN='$mysql/orm_test'
export ORM_TEST_POSTGRES_DSN='$postgres/orm_test?sslmode=disable'
export ORM_TEST_MYSQL_REPLICA_DSN='mysql://root@127.0.0.1:$MYSQL_REPLICA_PORT/orm_test'
export ORM_TEST_POSTGRES_REPLICA_DSN='postgres://orm@127.0.0.1:$POSTGRES_REPLICA_PORT/orm_test?sslmode=disable'
export ORM_TEST_PROXYSQL_DSN='mysql://orm:orm@127.0.0.1:$PROXYSQL_PORT/orm_test'
export ORM_TEST_PGBOUNCER_DSN='postgres://orm@127.0.0.1:$PGBOUNCER_PORT/orm_test?sslmode=disable'
export ORM_TEST_PGBOUNCER_SINGLE_DSN='postgres://orm@127.0.0.1:$PGBOUNCER_PORT/orm_test_single?sslmode=disable'
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
    [ $# -eq 7 ] || usage
    for p in "$2" "$3" "$4" "$5" "$6" "$7"; do
      port "$p"
    done
    MYSQL_PORT=$2
    POSTGRES_PORT=$3
    MYSQL_REPLICA_PORT=$4
    POSTGRES_REPLICA_PORT=$5
    PROXYSQL_PORT=$6
    PGBOUNCER_PORT=$7
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
