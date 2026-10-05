#!/bin/sh
# Runs the TypeScript model, dbspec runtime, schema set, add columns, clock,
# driver error and rollback integration tests on SQLite, MySQL and PostgreSQL,
# the SQLite locking test and the MySQL TLS test; ORM_TEST_MYSQL_DSN and
# ORM_TEST_POSTGRES_DSN must name test databases, and ORM_TEST_MYSQL_TLS_* the
# TLS server of make test-servers.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
# build는 자기 case를 보고하지 않는 장기 작업이므로 tests/run-long.mjs로 기한 없이 실행하고,
# build 출력과 종료 코드는 STEP 줄로 보인다.
node tests/run-long.mjs typescript-build -- npm run typescript:build
# test는 서로의 결과를 읽지 않으므로 실패한 test 뒤에도 다음 test를 실행하고, 끝에 실패한 test를 모두 적는다.
FAILED=
keep() {
  "$@" || FAILED="$FAILED
  $* (exit $?)"
}
keep node clients/typescript/tests/model.mjs
keep node --test clients/typescript/tests/dbspec_runtime_db.mjs
keep node clients/typescript/tests/sqlite-concurrency.mjs
keep node clients/typescript/tests/schema-set.mjs
keep node clients/typescript/tests/add-tables-and-columns.mjs
keep node clients/typescript/tests/clock.mjs
keep node clients/typescript/tests/driver-error.mjs
keep node --conditions=orm-test clients/typescript/tests/rollback.mjs
keep node clients/typescript/tests/mysql_tls.mjs
if [ -n "$FAILED" ]; then
  printf 'sqlite-test: failed:%s\n' "$FAILED" >&2
  exit 1
fi
