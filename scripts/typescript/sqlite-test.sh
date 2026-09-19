#!/bin/sh
# Runs the TypeScript model integration test on SQLite, MySQL and PostgreSQL;
# ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN must name test databases.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
npm run typescript:build >/dev/null
node tests/typescript/model.mjs
