#!/bin/sh
# Runs the TypeScript model and schema set integration tests on SQLite, MySQL
# and PostgreSQL, and the SQLite locking test; ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN
# must name test databases.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
npm run typescript:build >/dev/null
node clients/typescript/tests/model.mjs
node clients/typescript/tests/sqlite-concurrency.mjs
node clients/typescript/tests/schema-set.mjs
