#!/bin/sh
# Hot-path gates against the seeded MySQL bench database named by
# ORM_BENCH_MYSQL_DSN; each gate fails when the variable is unset.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
go test -v -timeout 0 ./clients/go/bench -run '^TestNative' -count=1
ORM_RUN_PERF_GATE=1 go test -v -timeout 0 ./clients/go/bench -run '^TestHotPathGate(UnderLoad)?$' -count=1
php clients/php/tests/perf_gate.php
ORM_PERF_CPU_LOAD=1 php clients/php/tests/perf_gate.php
