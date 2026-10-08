#!/bin/sh
# 확장 orm_dbspec을 phpize, configure, make로 build하고 그 library를 $1에 rename으로 게시한다. build는 $1 옆의
# 임시 directory에서 하고 끝나면 지운다. PATH의 phpize와 php-config가 build할 PHP를 정한다.
# Usage: sh packages/orm-php-extension/scripts/build.sh <published orm_dbspec.so>
set -eu
out=${1:?usage: sh packages/orm-php-extension/scripts/build.sh <published orm_dbspec.so>}
src=$(cd "$(dirname "$0")/../src" && pwd)
command -v phpize >/dev/null || { echo "build.sh: phpize is not on PATH; install the PHP development files of .php-version (setup-php gives them in CI)" >&2; exit 1; }
command -v php-config >/dev/null || { echo "build.sh: php-config is not on PATH; install the PHP development files of .php-version" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
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
# 경고는 컴파일러의 source 경고만 본다(macOS libtool의 링커 경고는 이 확장의 것이 아니다).
if grep -E '\.[ch]:[0-9]+:[0-9]+: warning:' make.log >&2; then
  echo "build.sh: the build has compiler warnings" >&2
  exit 1
fi
cp modules/orm_dbspec.so "$out.tmp.$$"
mv "$out.tmp.$$" "$out"
echo "build.sh: published $out"
