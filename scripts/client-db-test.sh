#!/bin/sh
# Runs the database tests of every client on SQLite, MySQL and PostgreSQL.
# ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name the test servers (each case
# creates its own database there), ORM_TEST_MYSQL_SERVER_DSN and
# ORM_TEST_POSTGRES_SERVER_DSN name the same servers without a pooler, and
# ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name dedicated databases for the
# Rust catalog connection tests; a test fails when one it needs is unset. ORM_CLIENT_DB_LANGS selects
# clients (default: all).
# rollback fault case는 각 client의 test entry point로 실행한다: Go build tag
# ormtest, Rust feature test-faults, Node condition orm-test.
#
# ORM_CLIENT_DB_LANES=parallel이면 client마다 한 줄(lane)로 함께 실행한다. 각 case는 자기
# database를 만들어 쓰므로 client끼리 겹쳐도 같은 database를 쓰지 않는다. 출력 줄 앞에는
# `[<client>]`를 붙이고, 모든 lane이 끝난 뒤 실패한 lane이 있으면 1로 끝난다. pooler를 거치는
# 실행(client-pooler-check)은 pooler의 server connection 한도(ProxySQL 4개, PgBouncer database마다
# 4개) 때문에 client를 차례로 실행한다.
#
# Rust는 workspace test를 ORM_RUST_TEST_FEATURES(Makefile: test-faults와 live-db)로 한 번 build하고
# 실행한다. rollback fault case와 orm-build의 live-db case가 그 실행에 들어 있다.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$HOME/.cargo/bin:$PATH"
export PATH
cd "$ROOT"
: "${ORM_RUST_TEST_FEATURES:?ORM_RUST_TEST_FEATURES is required; run through make}"
LANGS=,${ORM_CLIENT_DB_LANGS:-go,php,rust,typescript},

go_lane() {
  node tests/go-test.mjs -v -timeout 0 -count=1 ./clients/go/...
  node tests/go-test.mjs -v -timeout 0 -count=1 -tags ormtest -run '^TestRollbackFault' ./clients/go/orm
}
php_lane() {
  php clients/php/tests/model_test.php
  php clients/php/tests/aes_json_test.php
  php clients/php/tests/runtime_db_test.php
  php clients/php/tests/audit_external_sets_test.php
  php clients/php/tests/sqlite_concurrency_test.php
  php clients/php/tests/schema_set_test.php
  php clients/php/tests/add_tables_and_columns_test.php
  php clients/php/tests/clock_test.php
  php clients/php/tests/driver_error_test.php
  php clients/php/tests/rollback_test.php
  php clients/php/tests/mysql_tls.php
}
typescript_lane() {
  ./scripts/typescript/sqlite-test.sh
}
rust_lane() {
  # tests/cargo-test.mjs는 test binary를 공유 target directory의 lease 아래에서 기한 없는 장기 작업으로 build해
  # 실행 하나의 directory로 복사하고, 그 복사본을 실행한다.
  (cd clients/rust && node "$ROOT/tests/cargo-test.mjs" workspace-tests -- cargo test --locked --workspace --features "$ORM_RUST_TEST_FEATURES")
  # build는 자기 case를 보고하지 않는 장기 작업이므로 tests/run-long.mjs로 기한 없이 실행한다. 공유 Rust target
  # directory의 lease 아래에서 build하고 program을 이 실행의 directory로 복사해(scripts/cargo-build-copy.sh) 그
  # 복사본을 실행한다.
  run="$ROOT/.runtime/run/client-db-rust-$$"
  node tests/run-long.mjs rust-build/integration --cwd clients/rust -- "${LEASE:?LEASE is unset; run this through make}" run "${CARGO_LEASES:?CARGO_LEASES is unset; run this through make}" exclusive --wait -- sh "$ROOT/scripts/cargo-build-copy.sh" "$run" debug/integration -- cargo build --locked -p orm-tests --bin integration
  "$run/debug/integration" "$ROOT/schema/bench.dbs"
  rm -rf "$run"
}

# `--lane <client>`은 lane 하나를 자기 process에서 실행한다. if 조건 안의 subshell은 set -e를
# 따르지 않으므로 parallel lane은 이 형태로 실행한다.
if [ "${1:-}" = --lane ]; then
  "${2}_lane"
  exit 0
fi

selected=
for lang in go php typescript rust; do
  case "$LANGS" in *,$lang,*) selected="$selected $lang" ;; esac
done

if [ "${ORM_CLIENT_DB_LANES:-}" != parallel ]; then
  for lang in $selected; do "${lang}_lane"; done
  exit 0
fi

STATUS=$(mktemp -d "${TMPDIR:-/tmp}/orm-client-db.XXXXXX")
trap 'rm -rf "$STATUS"' EXIT HUP INT TERM
for lang in $selected; do
  {
    if "$0" --lane "$lang" 2>&1; then echo 0 > "$STATUS/$lang"; else echo 1 > "$STATUS/$lang"; fi
  } | awk -v prefix="[$lang] " '{ print prefix $0; fflush() }' &
done
wait
failed=
for lang in $selected; do
  [ "$(cat "$STATUS/$lang" 2>/dev/null)" = 0 ] || failed="$failed $lang"
done
if [ -n "$failed" ]; then
  echo "client-db-test: failed lanes:$failed" >&2
  exit 1
fi
echo "client-db-test: every lane passed:$selected"
