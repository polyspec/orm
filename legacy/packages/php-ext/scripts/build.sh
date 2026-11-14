#!/bin/sh
# Delegate extension builds to the canonical Kit builder, which stages the tracked source-copy declarations for each run; the
# extension is the directory of this package and library the PHP library beside it, each relative to the repository, so the build
# follows the place of the packages (legacy/packages/php-ext and legacy/packages/php); var/php-ext is the build directory, and vendor
# and node_modules are skipped.
# Usage: sh legacy/packages/php-ext/scripts/build.sh <published polyspec_orm.so> [release|native-test]
set -eu
out=${1:?usage: sh legacy/packages/php-ext/scripts/build.sh <published polyspec_orm.so> [release|native-test]}
mode=${2:-release}
package=$(cd "$(dirname "$0")/.." && pwd -P)
repository=$(cd "$(git -C "$package" rev-parse --show-toplevel)" && pwd -P)
extension=${package#"$repository"/}
library=$(dirname "$extension")/php
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
# The build compiles the copy of the SQLite cancel callback that make writes from the PHP library's one source; a missing or
# different copy is refused, so no build compiles another revision of it.
if ! cmp -s "$library/src/native/sqlite_cancel.c" "$extension/src/native/sqlite_cancel.c"; then
  echo "build.sh: $extension/src/native/sqlite_cancel.c is missing or differs from $library/src/native/sqlite_cancel.c; run make $extension/src/native/sqlite_cancel.c" >&2
  exit 1
fi
set -- "$builder" build --extension "$extension" --build-dir var/php-ext --skip vendor --skip node_modules --library "$library" --output "$out" --configure-arg
case "$mode" in
  release) set -- "$@" --disable-polyspec-orm-native-test ;;
  native-test)
    set -- "$@" --enable-polyspec-orm-native-test --source-copy \
      "$extension/testing/native/module.c" src/native_test.c ;;
  *) echo "build.sh: unknown build mode $mode (expected release or native-test)" >&2; exit 2 ;;
esac
exec "$node" "$@"
