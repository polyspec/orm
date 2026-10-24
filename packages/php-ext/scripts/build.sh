#!/bin/sh
# Builds the extension polyspec_orm with phpize, configure and make, and publishes its library to $1 by rename. The build is done
# in a temporary copy of the package beside $1, its composer.json beside src/ as in the package (config.m4 reads the version
# from it), and removed when finished. The phpize and php-config on PATH decide which PHP is built.
# Usage: sh packages/php-ext/scripts/build.sh <published polyspec_orm.so> [release|mermaid-test]
set -eu
out=${1:?usage: sh packages/php-ext/scripts/build.sh <published polyspec_orm.so>}
mode=${2:-release}
package=$(cd "$(dirname "$0")/.." && pwd)
command -v phpize >/dev/null || { echo "build.sh: phpize is not on PATH; install the PHP development files of .php-version (setup-php gives them in CI)" >&2; exit 1; }
command -v php-config >/dev/null || { echo "build.sh: php-config is not on PATH; install the PHP development files of .php-version" >&2; exit 1; }
php_config=$(command -v php-config)
arginfo_tools="$(cd "$(dirname "$php_config")/.." && pwd)/php-arginfo"
gen_stub="$arginfo_tools/gen_stub.php"
if [ ! -f "$gen_stub" ]; then
  echo "build.sh: $gen_stub is missing; run make install-tools, which installs the pinned PHP arginfo generator and parser" >&2
  exit 1
fi
parser_version=$(sed -n 's/^[[:space:]]*\$version = "\([0-9][0-9.]*\)";.*/\1/p' "$gen_stub" | head -n 1)
if [ -z "$parser_version" ]; then
  echo "build.sh: cannot read the PHP-Parser version required by $gen_stub; run make install-tools" >&2
  exit 1
fi
parser="$arginfo_tools/PHP-Parser-$parser_version/lib/PhpParser"
if [ ! -d "$parser" ]; then
  echo "build.sh: $parser is missing; run make install-tools, which installs the pinned PHP arginfo generator and parser" >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
# The build changes into its directory, so a relative path is made absolute first.
out=$(cd "$(dirname "$out")" && pwd)/$(basename "$out")
work="$out.build.$$"
rm -rf "$work"
trap 'rm -rf "$work"' EXIT
mkdir "$work" "$work/src"
cp "$package"/composer.json "$work"/
cp "$package"/src/config.m4 "$package"/src/*.c "$package"/src/*.h "$package"/src/*.stub.php "$work"/src/
case "$mode" in
  release) configure_args="--enable-polyspec-orm --disable-polyspec-orm-mermaid-test" ;;
  mermaid-test)
    cp "$package"/testing/mermaid/module.c "$work"/src/mermaid_test.c
    configure_args="--enable-polyspec-orm --enable-polyspec-orm-mermaid-test" ;;
  *) echo "build.sh: unknown build mode $mode (expected release or mermaid-test)" >&2; exit 2 ;;
esac
cd "$work/src"
echo "build.sh: generate PHP arginfo"
php "$gen_stub" polyspec_orm.stub.php >arginfo.log 2>&1 || { cat arginfo.log >&2; exit 1; }
test -f polyspec_orm_arginfo.h || { cat arginfo.log >&2; echo "build.sh: gen_stub.php did not write polyspec_orm_arginfo.h" >&2; exit 1; }
echo "build.sh: phpize ($(php-config --version))"
phpize >phpize.log 2>&1 || { cat phpize.log >&2; exit 1; }
echo "build.sh: configure"
./configure $configure_args >configure.log 2>&1 || { tail -n 40 configure.log >&2; exit 1; }
echo "build.sh: make"
make >make.log 2>&1 || { cat make.log >&2; exit 1; }
# Warnings only look at the compiler's source warnings (macOS libtool linker warnings are not from this extension).
if grep -E '\.[ch]:[0-9]+:[0-9]+: warning:' make.log >&2; then
  echo "build.sh: the build has compiler warnings" >&2
  exit 1
fi
cp modules/polyspec_orm.so "$out.tmp.$$"
mv "$out.tmp.$$" "$out"
echo "build.sh: published $out"
