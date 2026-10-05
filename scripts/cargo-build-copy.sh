#!/bin/sh
# cargo-build-copy.sh <run target> <artifact>... -- <cargo command> [args...]
#
# 실행 하나가 쓸 Rust program을 공유 target directory(CARGO_TARGET_DIR)에서 build하고, 그 artifact를 실행의
# directory <run target>의 같은 상대 경로로 복사한다. 실행은 복사본을 실행하므로, build 뒤에 다른 checkout이
# 같은 target directory를 다시 build해도 이 실행의 program은 바뀌지 않는다. Makefile은 이 script를 target
# directory의 exclusive lease(tests/lease, CARGO_LEASED) 아래에서 실행하므로 build와 복사 사이에 다른
# build가 끼지 않는다. <artifact>는 CARGO_TARGET_DIR에 대한 상대 경로다(예: debug/examples/dbspec_apply).
set -eu

[ $# -ge 4 ] || { echo "usage: cargo-build-copy.sh <run target> <artifact>... -- <cargo command> [args...]" >&2; exit 2; }
target=${CARGO_TARGET_DIR:?CARGO_TARGET_DIR is unset; run this through make, which exports it}
run=$1
shift
artifacts=
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  artifacts="$artifacts $1"
  shift
done
[ "${1:-}" = -- ] && [ $# -ge 2 ] || { echo "cargo-build-copy.sh: no -- before the cargo command" >&2; exit 2; }
shift
"$@"
for artifact in $artifacts; do
  mkdir -p "$(dirname "$run/$artifact")"
  cp -p "$target/$artifact" "$run/$artifact"
  echo "cargo-build-copy: $target/$artifact copied to $run/$artifact"
done
