#!/bin/sh
# Runs the database tests of every client on SQLite, MySQL and PostgreSQL.
# ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name empty test databases, and
# ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name dedicated databases for the
# schema tools; a test fails when one it needs is unset. ORM_CLIENT_DB_LANGS selects
# clients (default: all).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$HOME/.cargo/bin:$PATH"
export PATH
cd "$ROOT"
LANGS=,${ORM_CLIENT_DB_LANGS:-go,php,rust,typescript},

case "$LANGS" in *,go,*)
  go test -count=1 ./clients/go/...
esac
case "$LANGS" in *,php,*)
  php clients/php/tests/model_test.php
  php clients/php/tests/aes_json_test.php
  php clients/php/tests/audit_service_test.php
  php clients/php/tests/schema_db_test.php
esac
case "$LANGS" in *,typescript,*)
  ./scripts/typescript/sqlite-test.sh
esac
case "$LANGS" in *,rust,*)
  (cd clients/rust && cargo test --locked --workspace)
  (cd clients/rust && cargo test --locked -p orm-build --features cli)
  (cd clients/rust && cargo build --locked --release -p orm-tests --bin integration)
  clients/rust/target/release/integration "$ROOT/schema/schema.json"
esac
