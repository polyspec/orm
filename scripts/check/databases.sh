#!/bin/sh
# make check가 실행 하나 동안 쓰는 자기 database를 만들고 지운다. 공유 bench database(orm_bench)와
# decimal database(orm_decimal_case)는 다른 실행이나 session이 쓰고 바꿀 수 있으므로, check는
# 실행마다 이름이 겹치지 않는 bench database와 decimal database를 만들어 seed하고 끝날 때 지운다.
#
#   databases.sh create <servers env> <directory> <name>
#   databases.sh drop <servers env> <directory> <name>
#
# create는 <servers env>(make test-servers가 쓴 file)의 server에 MySQL과 PostgreSQL database
# <name>_bench와 <name>_decimal, <directory>의 SQLite file을 만들어 scripts/bench-db.sh와
# scripts/decimal-db-setup.php로 설치하고, <directory>/env(<servers env>에 BENCH_*와
# ORM_BENCH_MYSQL_DSN을 이 database로 바꾼 것)와 <directory>/decimal-env를 쓴다. drop은 그
# database들을 지운다. <name>은 소문자, 숫자와 밑줄로 된 이름이다.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
[ $# -eq 4 ] || { echo "usage: databases.sh create|drop <servers env> <directory> <name>" >&2; exit 2; }
action=$1
servers=$2
dir=$3
name=$4
case "$name" in *[!a-z0-9_]* | '') echo "databases.sh: invalid name $name" >&2; exit 2 ;; esac
. "$servers"

# with_database는 DSN의 database(path)를 바꾸고 scheme, 계정, host와 query는 그대로 둔다.
with_database() {
  scheme=${1%%://*}
  rest=${1#*://}
  authority=${rest%%/*}
  path=${rest#*/}
  query=
  case "$path" in *\?*) query="?${path#*\?}" ;; esac
  printf '%s://%s/%s%s' "$scheme" "$authority" "$2" "$query"
}

mysql_bench=$(with_database "$BENCH_MYSQL_DSN" "${name}_bench")
postgres_bench=$(with_database "$BENCH_POSTGRES_DSN" "${name}_bench")
sqlite_query=
case "$BENCH_SQLITE_DSN" in *\?*) sqlite_query="?${BENCH_SQLITE_DSN#*\?}" ;; esac
sqlite_bench="sqlite://$dir/bench.sqlite$sqlite_query"
orm_bench=$(with_database "$ORM_BENCH_MYSQL_DSN" "${name}_bench")

case "$action" in
create)
  mkdir -p "$dir"
  BENCH_MYSQL_DSN=$mysql_bench BENCH_POSTGRES_DSN=$postgres_bench BENCH_SQLITE_DSN=$sqlite_bench "$ROOT/scripts/bench-db.sh"
  BENCH_MYSQL_DSN=$mysql_bench BENCH_POSTGRES_DSN=$postgres_bench DECIMAL_ENV="$dir/decimal-env" \
    ORM_DECIMAL_DATABASE="${name}_decimal" php "$ROOT/scripts/decimal-db-setup.php"
  {
    cat "$servers"
    printf "export ORM_BENCH_MYSQL_DSN='%s'\n" "$orm_bench"
    printf "export BENCH_MYSQL_DSN='%s'\n" "$mysql_bench"
    printf "export BENCH_POSTGRES_DSN='%s'\n" "$postgres_bench"
    printf "export BENCH_SQLITE_DSN='%s'\n" "$sqlite_bench"
  } > "$dir/env.tmp"
  mv "$dir/env.tmp" "$dir/env"
  echo "databases: ${name}_bench and ${name}_decimal created and seeded"
  ;;
drop)
  rest=${BENCH_MYSQL_DSN#mysql://}
  user=${rest%%@*}
  address=${rest#*@}; address=${address%%/*}
  mysql --no-defaults --protocol=TCP -h "${address%:*}" -P "${address##*:}" -u "$user" \
    -e "DROP DATABASE IF EXISTS \`${name}_bench\`; DROP DATABASE IF EXISTS \`${name}_decimal\`"
  server=${BENCH_POSTGRES_DSN#postgres://}; server=${server%%/*}
  psql -X -q -v ON_ERROR_STOP=1 "postgres://$server/postgres?sslmode=disable" \
    -c "DROP DATABASE IF EXISTS \"${name}_bench\" WITH (FORCE)" -c "DROP DATABASE IF EXISTS \"${name}_decimal\" WITH (FORCE)"
  rm -rf "$dir"
  echo "databases: ${name}_bench and ${name}_decimal dropped"
  ;;
*)
  echo "usage: databases.sh create|drop <servers env> <directory> <name>" >&2
  exit 2
  ;;
esac
