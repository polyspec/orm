#!/bin/sh
# 실행 하나(make check, make owner-check, make run-databases) 동안 쓰는 자기 database를 만들고 지운다.
# 함께 쓰는 bench database나 decimal database는 없다: 다른 실행이나 session이 쓰고 바꾸면 결과가 그것에
# 기대게 되므로, 실행마다 이름이 겹치지 않는 bench database와 decimal database를 만들어 seed하고 끝날 때
# 지운다. server의 환경 file은 그 database의 DSN을 정하지 않고, 이름만 바꿔 쓸 DSN(ORM_RUN_*)을 준다.
#
#   databases.sh create <servers env> <directory> <name>
#   databases.sh drop <servers env> <directory> <name>
#
# create는 <servers env>(make test-servers가 쓴 file)의 server에 MySQL과 PostgreSQL database
# <name>_bench와 <name>_decimal, <directory>의 SQLite file을 만들어 scripts/bench-db.sh와
# scripts/decimal-db-setup.php로 설치하고, <directory>/env(<servers env>에 이 database의 BENCH_*,
# ORM_BENCH_MYSQL_DSN, 이 directory의 send-savepoint SQLite file인 ORM_SEND_SQLITE_DSN을 더한 것)와
# <directory>/decimal-env를 쓴다.
# drop은 그 database들을 지운다. <name>은 소문자, 숫자와 밑줄로 된 이름이다.
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

mysql_bench=$(with_database "${ORM_RUN_MYSQL_DSN:?$servers names no ORM_RUN_MYSQL_DSN; run make test-servers to rewrite it}" "${name}_bench")
postgres_bench=$(with_database "$ORM_RUN_POSTGRES_DSN" "${name}_bench")
sqlite_bench="sqlite://$dir/bench.sqlite?$ORM_RUN_SQLITE_QUERY"
# ORM_BENCH_MYSQL_DSN은 같은 database의 query 없는 DSN이다.
orm_bench=${mysql_bench%%\?*}

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
    # rust-send-savepoint와 client-db-check의 Rust test(tx::send_tests)가 쓰는 SQLite file도 이 실행의 것이다.
    printf "export ORM_SEND_SQLITE_DSN='sqlite://%s/send-savepoint.sqlite'\n" "$dir"
  } > "$dir/env.tmp"
  mv "$dir/env.tmp" "$dir/env"
  echo "databases: ${name}_bench and ${name}_decimal created and seeded"
  ;;
drop)
  # MySQL, PostgreSQL, 실행 directory를 지우는 일은 서로 독립이다. 하나가 실패해도 나머지를 지우고, 끝에 실패한
  # 것을 모두 적고 1로 끝난다.
  FAILED=
  keep() {
    "$@" || FAILED="$FAILED
  $* (exit $?)"
  }
  rest=${ORM_RUN_MYSQL_DSN#mysql://}
  user=${rest%%@*}
  address=${rest#*@}; address=${address%%/*}
  keep mysql --no-defaults --protocol=TCP -h "${address%:*}" -P "${address##*:}" -u "$user" \
    -e "DROP DATABASE IF EXISTS \`${name}_bench\`; DROP DATABASE IF EXISTS \`${name}_decimal\`"
  server=${ORM_RUN_POSTGRES_DSN#postgres://}; server=${server%%/*}
  keep psql -X -q -v ON_ERROR_STOP=1 "postgres://$server/postgres?sslmode=disable" \
    -c "DROP DATABASE IF EXISTS \"${name}_bench\" WITH (FORCE)" -c "DROP DATABASE IF EXISTS \"${name}_decimal\" WITH (FORCE)"
  keep rm -rf "$dir"
  if [ -n "$FAILED" ]; then
    printf 'databases: drop failed:%s\n' "$FAILED" >&2
    exit 1
  fi
  echo "databases: ${name}_bench and ${name}_decimal dropped"
  ;;
*)
  echo "usage: databases.sh create|drop <servers env> <directory> <name>" >&2
  exit 2
  ;;
esac
