#!/bin/sh
# Runs the TypeScript model integration test. SQLite always runs; set
# ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN to include MySQL and PostgreSQL.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
npm run typescript:build >/dev/null
node tests/typescript/model.mjs
