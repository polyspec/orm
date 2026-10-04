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
#   test-servers.sh tls <mysql-port> <mysql-replica-port>
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
MYSQL_SOCKET="$DIR/mysql.sock"
MYSQL_REPLICA_SOCKET="$DIR/mysql-replica.sock"
PROXYSQL_ADMIN_SOCKET="$DIR/proxysql-admin.sock"
PROXYSQL_ADMIN_PGSQL_SOCKET="$DIR/proxysql-admin-pgsql.sock"
PROXYSQL_PGSQL_SOCKET="$DIR/proxysql-pgsql.sock"

usage() {
  echo "usage: test-servers.sh start <mysql-port> <postgres-port> <mysql-replica-port> <postgres-replica-port> <proxysql-port> <pgbouncer-port> | tls <mysql-port> <mysql-replica-port> | stop" >&2
  exit 2
}

# check_socket_paths는 서버를 시작하기 전에 Unix socket 경로마다 platform 한도를 확인한다. socket
# 경로는 sockaddr_un의 sun_path에 NUL과 함께 들어가므로 Linux는 107 byte, macOS는 103 byte까지다.
# 깊은 checkout(예: 긴 worktree 경로)은 서버 log 줄 대신 이 경로와 한도로 실패한다.
check_socket_paths() {
  case "$(uname -s)" in
    Linux) system=Linux limit=107 ;;
    Darwin) system=macOS limit=103 ;;
    *) echo "test-servers: no Unix socket path limit is declared for $(uname -s)" >&2; exit 1 ;;
  esac
  for socket in "$MYSQL_SOCKET" "$MYSQL_REPLICA_SOCKET" "$PROXYSQL_ADMIN_SOCKET" "$PROXYSQL_ADMIN_PGSQL_SOCKET" "$PROXYSQL_PGSQL_SOCKET"; do
    bytes=$(printf %s "$socket" | wc -c | tr -d ' ')
    if [ "$bytes" -gt "$limit" ]; then
      echo "test-servers: socket path $socket is $bytes bytes; $system allows at most $limit" >&2
      exit 1
    fi
  done
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
    mysqladmin --no-defaults --socket="$MYSQL_REPLICA_SOCKET" -u root shutdown
    echo "test-servers: stopped the MySQL replica"
  fi
  if pid_running "$MYSQL_PID"; then
    mysqladmin --no-defaults --socket="$MYSQL_SOCKET" -u root shutdown
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

# MYSQLD_FILES는 모든 mysqld 실행에 주는 secure_file_priv다. NULL은 파일 import·export를 끈다.
# build마다 compile된 기본값이 다르므로(Homebrew는 NULL, Ubuntu package는 mysql-server package가
# 만드는 /var/lib/mysql-files) 명시해 같은 서버를 만든다: 그 directory가 없으면 mysqld가 시작하지 않는다.
MYSQLD_FILES=--secure-file-priv=NULL

start_mysql() {
  mysqld --no-defaults --initialize-insecure "$MYSQLD_FILES" --datadir="$DIR/mysql" --log-error="$DIR/mysql-init.log"
  # --daemonize returns after the server accepts connections or fails.
  mysqld --no-defaults --daemonize "$MYSQLD_FILES" --datadir="$DIR/mysql" --pid-file="$MYSQL_PID" \
    --log-error="$DIR/mysql.log" --bind-address=127.0.0.1 --port="$MYSQL_PORT" \
    --socket="$MYSQL_SOCKET" --mysqlx=OFF --server-id=1
  echo "test-servers: MySQL on 127.0.0.1:$MYSQL_PORT"

  # The replica starts before the primary holds data and reads the binary log
  # of the primary from its first file, so it applies every later change.
  mysqld --no-defaults --initialize-insecure "$MYSQLD_FILES" --datadir="$DIR/mysql-replica" --log-error="$DIR/mysql-replica-init.log"
  mysqld --no-defaults --daemonize "$MYSQLD_FILES" --datadir="$DIR/mysql-replica" --pid-file="$MYSQL_REPLICA_PID" \
    --log-error="$DIR/mysql-replica.log" --bind-address=127.0.0.1 --port="$MYSQL_REPLICA_PORT" \
    --socket="$MYSQL_REPLICA_SOCKET" --mysqlx=OFF --server-id=2 --skip-replica-start
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

  # -R writes the standby configuration with the application_name that
  # synchronous_standby_names of the primary lists.
  pg_basebackup -D "$POSTGRES_REPLICA_DATA" -R -X stream \
    -d "host=127.0.0.1 port=$POSTGRES_PORT user=orm application_name=orm_replica"
  pg_ctl -D "$POSTGRES_REPLICA_DATA" -l "$DIR/postgres-replica.log" -w \
    -o "-p $POSTGRES_REPLICA_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
  echo "test-servers: PostgreSQL replica on 127.0.0.1:$POSTGRES_REPLICA_PORT"
}

# start_logged <name> <deadline> <line> <command> [<argument>...] runs a server in
# the foreground and writes its process id to $DIR/<name>.pid. A shell reader
# copies each line of the output of the server to $DIR/<name>.log as it
# arrives, until the server exits. The reader reports through the FIFO
# $DIR/<name>.ready when the server logs a line that contains <line>, or when
# the server exits first; a timer reports when <deadline> seconds pass first.
# The start fails in the last two cases, naming the server, the deadline and
# the last lines of its log.
start_logged() {
  name=$1
  deadline=$2
  line=$3
  shift 3
  mkfifo "$DIR/$name.ready"
  # 읽는 쪽은 sh의 read다: read는 pipe에서 한 줄씩 읽어 그 줄이 쓰인 즉시 본다. awk는 쓰지
  # 않는다. Ubuntu의 awk(mawk)는 pipe 입력을 큰 block으로 읽어 서버가 끝날 때까지 줄을 넘기지 않는다.
  sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$DIR/$name.pid" "$@" </dev/null 2>&1 | {
    reported=
    while IFS= read -r output || [ -n "$output" ]; do
      printf '%s\n' "$output" >> "$DIR/$name.log"
      if [ -z "$reported" ]; then
        case $output in
          *"$line"*) [ -p "$DIR/$name.ready" ] && echo ready > "$DIR/$name.ready"; reported=1 ;;
        esac
      fi
    done
    # 기한이 먼저 지나 FIFO가 지워졌으면 reader는 서버가 끝날 때까지 log만 복사하고 알리지 않는다.
    [ -n "$reported" ] || { [ -p "$DIR/$name.ready" ] && echo exited > "$DIR/$name.ready"; } || true
  } >/dev/null &
  # 선언한 기한은 timer가 지킨다: 기한이 먼저 지나면 timer가 FIFO에 timeout을 쓴다.
  # 기한 전에 끝나면 timer의 sleep만 멈춘다: sleep이 실패하면 timer는 FIFO에 쓰지 않고 스스로
  # 끝나므로, shell이 signal로 멈춘 job을 보고하지 않는다. timer의 stderr는 버린다.
  ( exec 2>/dev/null; sleep "$deadline" && [ -p "$DIR/$name.ready" ] && echo timeout > "$DIR/$name.ready" ) &
  timer=$!
  # FIFO를 여는 open은 reader가 끝날 때 오는 SIGCHLD에 끊길 수 있다(EINTR). 끊긴 open에는 writer가
  # 짝지어지지 않았으므로 FIFO가 있는 동안 다시 열어 처음 보고된 한 줄을 읽는다.
  state=
  while [ -z "$state" ] && [ -p "$DIR/$name.ready" ]; do
    read -r state 2>/dev/null < "$DIR/$name.ready" || state=
  done
  rm "$DIR/$name.ready"
  # 끝난 쪽이 아닌 보고자를 멈춘다: timer의 sleep이다. reader는 서버가 끝나면 스스로 끝나며, 실패한
  # start의 stop_servers가 서버를 멈춘다.
  pkill -P "$timer" sleep 2>/dev/null || true
  case $state in
    ready) ;;
    exited)
      echo "test-servers: $name exited before it logged '$line'; last lines of $DIR/$name.log:" >&2
      tail -n 20 "$DIR/$name.log" >&2
      exit 1 ;;
    *)
      echo "test-servers: $name logged no line with '$line' within its deadline of $deadline s; last lines of $DIR/$name.log:" >&2
      tail -n 20 "$DIR/$name.log" >&2
      exit 1 ;;
  esac
}

# tls issues the TLS files of the MySQL servers once under $DIR/tls and loads
# them into both servers with ALTER INSTANCE RELOAD TLS, which keeps the
# running sessions: a test CA, a certificate of the primary that names
# localhost, a certificate of the replica, signed by the same CA, that names
# only orm-mismatch.invalid, so that a client that checks the host name refuses
# it, and a second CA that signed neither. It then writes the TLS variables
# into the environment file in place of earlier ones. The MySQL TLS cases of the clients
# connect with ssl-mode=VERIFY_IDENTITY (docs/config.md).
tls() {
  command -v openssl >/dev/null || { echo "test-servers: openssl is not installed" >&2; exit 1; }
  TLS="$DIR/tls"
  if [ ! -f "$TLS/other-ca.pem" ]; then
    rm -rf "$TLS.tmp"
    mkdir -p "$TLS.tmp"
    for ca in ca other-ca; do
      openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=orm test $ca" \
        -keyout "$TLS.tmp/$ca-key.pem" -out "$TLS.tmp/$ca.pem" 2>>"$TLS.tmp/openssl.log"
    done
    for server in mysql:DNS:localhost mysql-replica:DNS:orm-mismatch.invalid; do
      name=${server%%:*}
      san=${server#*:}
      openssl req -newkey rsa:2048 -nodes -subj "/CN=orm test $name" \
        -keyout "$TLS.tmp/$name-key.pem" -out "$TLS.tmp/$name.csr" 2>>"$TLS.tmp/openssl.log"
      printf 'subjectAltName=%s\n' "$san" > "$TLS.tmp/$name.ext"
      openssl x509 -req -in "$TLS.tmp/$name.csr" -CA "$TLS.tmp/ca.pem" -CAkey "$TLS.tmp/ca-key.pem" \
        -CAcreateserial -days 3650 -extfile "$TLS.tmp/$name.ext" -out "$TLS.tmp/$name-cert.pem" 2>>"$TLS.tmp/openssl.log"
    done
    mv "$TLS.tmp" "$TLS"
  fi
  for server in mysql:$MYSQL_PORT mysql-replica:$MYSQL_REPLICA_PORT; do
    name=${server%%:*}
    mysql --no-defaults --protocol=TCP -h 127.0.0.1 -P "${server#*:}" -u root -e "
      SET GLOBAL ssl_ca = '$TLS/ca.pem';
      SET GLOBAL ssl_cert = '$TLS/$name-cert.pem';
      SET GLOBAL ssl_key = '$TLS/$name-key.pem';
      ALTER INSTANCE RELOAD TLS;"
  done
  echo "test-servers: MySQL TLS from $TLS"
  if [ -f "$ENV_FILE" ]; then
    grep -v '^export ORM_TEST_MYSQL_TLS_' "$ENV_FILE" > "$ENV_FILE.tls" || true
    tls_env >> "$ENV_FILE.tls"
    mv "$ENV_FILE.tls" "$ENV_FILE"
  fi
}

# tls_env writes the DSNs of the MySQL TLS cases: the primary with the test CA,
# the primary with the second CA, and the replica, whose certificate names
# another host. They name the host localhost., the fully qualified form of
# localhost, which resolves to 127.0.0.1 over TCP, because ssl-mode=VERIFY_IDENTITY
# checks a host name and the PHP driver connects to localhost through the Unix
# socket.
tls_env() {
  printf "export ORM_TEST_MYSQL_TLS_DSN='mysql://root@localhost.:%s/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=%s/tls/ca.pem'\n" "$MYSQL_PORT" "$DIR"
  printf "export ORM_TEST_MYSQL_TLS_OTHER_CA_DSN='mysql://root@localhost.:%s/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=%s/tls/other-ca.pem'\n" "$MYSQL_PORT" "$DIR"
  printf "export ORM_TEST_MYSQL_TLS_MISMATCH_DSN='mysql://root@localhost.:%s/orm_test?ssl-mode=VERIFY_IDENTITY&ssl-ca=%s/tls/ca.pem'\n" "$MYSQL_REPLICA_PORT" "$DIR"
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
  mysql_ifaces="$PROXYSQL_ADMIN_SOCKET"
  pgsql_ifaces="$PROXYSQL_ADMIN_PGSQL_SOCKET"
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
  interfaces="$PROXYSQL_PGSQL_SOCKET"
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
  start_logged proxysql 60 'For consultancy visit' \
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
  start_logged pgbouncer 60 'process up' pgbouncer "$DIR/pgbouncer.ini"
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
  check_socket_paths
  for tool in mysqld initdb pg_ctl pg_basebackup proxysql pgbouncer; do
    command -v "$tool" >/dev/null || { echo "test-servers: $tool is not installed" >&2; exit 1; }
  done
  mkdir -p "$DIR"
  trap 'status=$?; if [ "$status" -ne 0 ]; then echo "test-servers: start failed; logs are in $DIR" >&2; stop_servers; fi' EXIT

  start_mysql
  tls
  start_postgres

  mysql_tzinfo_to_sql /usr/share/zoneinfo 2>"$DIR/mysql-tzinfo.log" | mysql_cli mysql
  mysql_cli -e 'CREATE DATABASE orm_test; CREATE DATABASE orm_tools'
  psql_cli postgres -c 'CREATE DATABASE orm_test' -c 'CREATE DATABASE orm_tools'

  BENCH_MYSQL_DSN="mysql://root@127.0.0.1:$MYSQL_PORT/orm_bench?timezone=%2B00:00" \
    BENCH_POSTGRES_DSN="postgres://orm@127.0.0.1:$POSTGRES_PORT/orm_bench?sslmode=disable&timezone=%2B00:00" \
    BENCH_SQLITE_DSN="sqlite://$DIR/orm_bench.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00" \
    "$ROOT/scripts/bench-db.sh"

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
  tls_env >> "$ENV_FILE.tmp"
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
  tls)
    # tls <mysql-port> <mysql-replica-port> loads the TLS files into running servers.
    [ $# -eq 3 ] || usage
    port "$2"
    port "$3"
    MYSQL_PORT=$2
    MYSQL_REPLICA_PORT=$3
    tls
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
