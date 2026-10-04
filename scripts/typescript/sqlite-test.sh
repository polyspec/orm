#!/bin/sh
# Runs the TypeScript model, dbspec runtime, schema set, add columns, clock,
# driver error and rollback integration tests on SQLite, MySQL and PostgreSQL,
# the SQLite locking test and the MySQL TLS test; ORM_TEST_MYSQL_DSN and
# ORM_TEST_POSTGRES_DSN must name test databases, and ORM_TEST_MYSQL_TLS_* the
# TLS server of make test-servers.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
# build는 자기 case를 보고하지 않으므로 tests/run-case.mjs로 감싼다. 기한 5분은 Makefile의
# TOOL_DEADLINE과 같고, build 출력은 STEP 줄로 보인다.
node tests/run-case.mjs typescript-build 5m -- npm run typescript:build
node clients/typescript/tests/model.mjs
node --test clients/typescript/tests/dbspec_runtime_db.mjs
node clients/typescript/tests/sqlite-concurrency.mjs
node clients/typescript/tests/schema-set.mjs
node clients/typescript/tests/add-tables-and-columns.mjs
node clients/typescript/tests/clock.mjs
node clients/typescript/tests/driver-error.mjs
node --conditions=orm-test clients/typescript/tests/rollback.mjs
node clients/typescript/tests/mysql_tls.mjs
