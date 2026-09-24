#!/bin/sh
# Hot-path gates against the seeded MySQL bench database named by
# ORM_BENCH_MYSQL_DSN; each gate fails when the variable is unset.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
ORM_RUN_PERF_GATE=1 go test ./bench/go -run TestHotPathGate -count=1 -v
php clients/php/tests/perf_gate.php "$ROOT/schema/schema.json"
