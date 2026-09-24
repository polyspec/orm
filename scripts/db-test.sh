#!/bin/sh
# Runs the physical migration tests on the MySQL and PostgreSQL databases named
# by ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN, and on SQLite. The tests
# fail when a variable is unset.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
go test -tags physical ./internal/ormgen -run 'TestPhysicalMigration|TestSQLite(Diff|Rebuild)' -count=1 -v
