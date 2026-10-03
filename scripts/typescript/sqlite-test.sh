#!/bin/sh
# Runs the TypeScript model, schema set, add columns, clock, driver error and rollback integration tests on SQLite, MySQL
# and PostgreSQL, the SQLite locking test and the MySQL TLS test; ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN
# must name test databases, and ORM_TEST_MYSQL_TLS_* the TLS server of make test-servers.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
npm run typescript:build >/dev/null
node clients/typescript/tests/model.mjs
node clients/typescript/tests/sqlite-concurrency.mjs
node clients/typescript/tests/schema-set.mjs
node clients/typescript/tests/add-columns.mjs
node clients/typescript/tests/clock.mjs
node clients/typescript/tests/driver-error.mjs
node --conditions=orm-test clients/typescript/tests/rollback.mjs
node clients/typescript/tests/mysql_tls.mjs
