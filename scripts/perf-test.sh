#!/bin/sh
# Hot-path gates against the seeded MySQL bench database named by
# ORM_BENCH_MYSQL_DSN; each gate fails when the variable is unset.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
# 네 측정은 서로 독립이다. 실패한 측정 뒤에도 나머지를 실행하고, 끝에 실패한 측정을 모두 적고 1로 끝난다.
FAILED=
keep() {
  "$@" || FAILED="$FAILED
  $* (exit $?)"
}
keep node tests/go-test.mjs -v -timeout 0 ./packages/orm-go/bench -run '^TestNative' -count=1
keep env ORM_RUN_PERF_GATE=1 node tests/go-test.mjs -v -timeout 0 ./packages/orm-go/bench -run '^TestHotPathGate(UnderLoad)?$' -count=1
keep php packages/orm-php/tests/perf_gate.php
keep env ORM_PERF_CPU_LOAD=1 php packages/orm-php/tests/perf_gate.php
if [ -n "$FAILED" ]; then
  printf 'perf-test: failed:%s\n' "$FAILED" >&2
  exit 1
fi
