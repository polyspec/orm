#!/bin/sh
# Delegate extension builds to the canonical Kit builder, which stages the tracked source-copy declarations for each run.
# Usage: sh packages/php-ext/scripts/build.sh <published polyspec_orm.so> [release|native-test]
set -eu
out=${1:?usage: sh packages/php-ext/scripts/build.sh <published polyspec_orm.so> [release|native-test]}
mode=${2:-release}
package=$(cd "$(dirname "$0")/.." && pwd)
repository=$(git -C "$package" rev-parse --show-toplevel)
node=$(command -v node || true)
if [ -z "$node" ]; then
  echo "build.sh: the pinned Node runtime is not on PATH; run the build through make, which sets up the toolchain" >&2
  exit 1
fi
# The builder is the source of the kit checkout beside the repository, which node runs as it is (kit K613).
builder="$repository/../kit/scripts/kit/php-extension.mts"
if [ ! -f "$builder" ]; then
  echo "build.sh: the Kit PHP extension builder $builder is missing; clone kit beside the repository" >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
out=$(cd "$(dirname "$out")" && pwd)/$(basename "$out")
cd "$repository"
set -- "$builder" build --output "$out" --configure-arg
case "$mode" in
  release) set -- "$@" --disable-polyspec-orm-native-test ;;
  native-test)
    set -- "$@" --enable-polyspec-orm-native-test --source-copy \
      packages/php-ext/testing/native/module.c src/native_test.c ;;
  *) echo "build.sh: unknown build mode $mode (expected release or native-test)" >&2; exit 2 ;;
esac
exec "$node" "$@"
