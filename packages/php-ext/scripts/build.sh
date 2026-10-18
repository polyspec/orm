#!/bin/sh
# Builds the extension orm_dbspec with phpize, configure and make, and publishes its library to $1 by rename. The build is done
# in a temporary directory beside $1 and removed when finished. The phpize and php-config on PATH decide which PHP is built.
# Usage: sh packages/php-ext/scripts/build.sh <published orm_dbspec.so>
set -eu
out=${1:?usage: sh packages/php-ext/scripts/build.sh <published orm_dbspec.so>}
src=$(cd "$(dirname "$0")/../src" && pwd)
command -v phpize >/dev/null || { echo "build.sh: phpize is not on PATH; install the PHP development files of .php-version (setup-php gives them in CI)" >&2; exit 1; }
command -v php-config >/dev/null || { echo "build.sh: php-config is not on PATH; install the PHP development files of .php-version" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
# The build changes into its directory, so a relative path is made absolute first.
out=$(cd "$(dirname "$out")" && pwd)/$(basename "$out")
work="$out.build.$$"
rm -rf "$work"
trap 'rm -rf "$work"' EXIT
mkdir "$work"
cp "$src"/config.m4 "$src"/*.c "$src"/*.h "$work"/
cd "$work"
echo "build.sh: phpize ($(php-config --version))"
phpize >phpize.log 2>&1 || { cat phpize.log >&2; exit 1; }
echo "build.sh: configure"
./configure --enable-orm-dbspec >configure.log 2>&1 || { tail -n 40 configure.log >&2; exit 1; }
echo "build.sh: make"
make >make.log 2>&1 || { grep -E 'error|warning' make.log >&2 || tail -n 60 make.log >&2; exit 1; }
# Warnings only look at the compiler's source warnings (macOS libtool linker warnings are not from this extension).
if grep -E '\.[ch]:[0-9]+:[0-9]+: warning:' make.log >&2; then
  echo "build.sh: the build has compiler warnings" >&2
  exit 1
fi
cp modules/orm_dbspec.so "$out.tmp.$$"
mv "$out.tmp.$$" "$out"
echo "build.sh: published $out"
