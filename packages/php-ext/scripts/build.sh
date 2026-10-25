#!/bin/sh
# Delegate extension builds to the canonical Kit builder, which stages the tracked source-copy declarations for each run.
# Usage: sh packages/php-ext/scripts/build.sh <published polyspec_orm.so> [release|mermaid-test]
set -eu
out=${1:?usage: sh packages/php-ext/scripts/build.sh <published polyspec_orm.so> [release|mermaid-test]}
mode=${2:-release}
package=$(cd "$(dirname "$0")/.." && pwd)
repository=$(git -C "$package" rev-parse --show-toplevel)
node=$(command -v node || true)
if [ -z "$node" ]; then
  echo "build.sh: the pinned Node runtime is not on PATH; run the build through make, which sets up the toolchain" >&2
  exit 1
fi
if [ -f "$repository/../kit/dist/php-extension.mjs" ]; then
  builder="$repository/../kit/dist/php-extension.mjs"
elif [ -f "$repository/node_modules/@polyspec/kit/dist/php-extension.mjs" ]; then
  builder="$repository/node_modules/@polyspec/kit/dist/php-extension.mjs"
else
  echo "build.sh: the Kit PHP extension builder is missing; run make build in ../kit or make install-packages" >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
out=$(cd "$(dirname "$out")" && pwd)/$(basename "$out")
cd "$repository"
set -- "$builder" build --output "$out" --configure-arg
case "$mode" in
  release) set -- "$@" --disable-polyspec-orm-mermaid-test ;;
  mermaid-test)
    set -- "$@" --enable-polyspec-orm-mermaid-test --source-copy \
      packages/php-ext/testing/mermaid/module.c src/mermaid_test.c ;;
  *) echo "build.sh: unknown build mode $mode (expected release or mermaid-test)" >&2; exit 2 ;;
esac
exec "$node" "$@"
