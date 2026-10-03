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
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$HOME/.cargo/bin:$PATH"
export PATH
cd "$ROOT"
LANGS=,${ORM_CLIENT_DB_LANGS:-go,php,rust,typescript},

case "$LANGS" in *,go,*)
  go test -v -timeout 0 -count=1 ./clients/go/...
  go test -v -timeout 0 -count=1 -tags ormtest -run '^TestRollbackFault' ./clients/go/orm
esac
case "$LANGS" in *,php,*)
  php clients/php/tests/model_test.php
  php clients/php/tests/aes_json_test.php
  php clients/php/tests/runtime_db_test.php
  php clients/php/tests/sqlite_concurrency_test.php
  php clients/php/tests/schema_set_test.php
  php clients/php/tests/clock_test.php
  php clients/php/tests/driver_error_test.php
  php clients/php/tests/rollback_test.php
esac
case "$LANGS" in *,typescript,*)
  ./scripts/typescript/sqlite-test.sh
esac
case "$LANGS" in *,rust,*)
  (cd clients/rust && cargo test --locked --workspace)
  (cd clients/rust && cargo test --locked -p orm --features test-faults --test rollback)
  (cd clients/rust && cargo test --locked -p orm-build --features live-db)
  # release build는 자기 case를 보고하지 않으므로 tests/run-case.mjs로 감싼다. 기한 8분의 기준은
  # Makefile의 BUILD_DEADLINE과 같다.
  node tests/run-case.mjs rust-build/integration 8m --cwd clients/rust -- cargo build --locked --release -p orm-tests --bin integration
  clients/rust/target/release/integration "$ROOT/schema/bench.dbs"
esac
