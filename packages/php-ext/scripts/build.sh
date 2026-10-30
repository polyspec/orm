#!/bin/sh
# Delegate extension builds to the canonical Kit builder, which stages the tracked sources that --source-copy names for each run.
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
# Resolve the pinned public Kit CLI from this checkout's installed package.
if ! builder=$(cd "$repository" && "$node" -p 'require.resolve("@polyspec/kit/php-extension")' 2>/dev/null); then
  echo "build.sh: installed @polyspec/kit does not expose php-extension; run make install" >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
out=$(cd "$(dirname "$out")" && pwd)/$(basename "$out")
cd "$repository"
# config.m4 compiles the PHP client's SQLite cancellation helper in every mode (T325).
set -- "$builder" build --output "$out" --source-copy packages/php/src/native/sqlite_cancel.c src/native/sqlite_cancel.c --configure-arg
case "$mode" in
  release) set -- "$@" --disable-polyspec-orm-native-test ;;
  native-test)
    set -- "$@" --enable-polyspec-orm-native-test --source-copy \
      packages/php-ext/testing/native/module.c src/native_test.c ;;
  *) echo "build.sh: unknown build mode $mode (expected release or native-test)" >&2; exit 2 ;;
esac
exec "$node" "$@"
