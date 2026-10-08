#!/bin/sh
# make install-php-extension-tools installs what the build and the checks of the PHP extension orm_dbspec
# (packages/orm-php-extension, C built with phpize) need besides the PHP of .php-version: it checks that phpize and
# php-config belong to the PHP on PATH, and it copies gen_stub.php of that PHP with its PHP-Parser into
# .runtime/bin/gen-stub, which make php-extension-arginfo and the arginfo check of make dbspec-php-extension-check
# run offline. gen_stub.php downloads its PHP-Parser when its directory has none, so this install step does that once.
set -eu
command -v php-config >/dev/null || { echo "php-extension-tools: php-config is not on PATH; install the PHP development files of .php-version (the setup-php step gives them in CI)" >&2; exit 1; }
command -v phpize >/dev/null || { echo "php-extension-tools: phpize is not on PATH; install the PHP development files of .php-version (the setup-php step gives them in CI)" >&2; exit 1; }
test "$(php-config --version)" = "$(php -r 'echo PHP_VERSION;')" || { echo "php-extension-tools: php-config reports PHP $(php-config --version), but php is PHP $(php -r 'echo PHP_VERSION;'); put the development files of the same PHP on PATH" >&2; exit 1; }
echo "php-extension-tools: php-config $(php-config --version)"
# phpize names the build directory of its PHP in the variables prefix, exec_prefix and phpdir.
variables=$(mktemp)
grep -E '^(prefix|datarootdir|exec_prefix|phpdir)=' "$(command -v phpize)" > "$variables"
phpdir=$(. "$variables" && echo "$phpdir")
rm -f "$variables"
test -f "$phpdir/gen_stub.php" || { echo "php-extension-tools: $phpdir/gen_stub.php does not exist; phpize copies it from there, so install the PHP development files of .php-version" >&2; exit 1; }
dest=.runtime/bin/gen-stub
if cmp -s "$phpdir/gen_stub.php" "$dest/gen_stub.php" && ls -d "$dest"/PHP-Parser-* >/dev/null 2>&1; then
  echo "php-extension-tools: $dest/gen_stub.php is the one of this PHP and has its PHP-Parser"
  exit 0
fi
work="$dest.tmp.$$"
rm -rf "$work"
mkdir -p "$work"
cp "$phpdir/gen_stub.php" "$work/"
for parser in "$phpdir"/PHP-Parser-*; do
  if [ -d "$parser" ]; then cp -R "$parser" "$work/"; fi
done
if ! ls -d "$work"/PHP-Parser-* >/dev/null 2>&1; then
  # gen_stub.php installs its PHP-Parser into its own directory when it first parses a stub.
  printf '<?php\nfunction probe(): void {}\n' > "$work/probe.stub.php"
  php "$work/gen_stub.php" "$work/probe.stub.php"
  rm -f "$work/probe.stub.php" "$work/probe_arginfo.h"
fi
ls -d "$work"/PHP-Parser-* >/dev/null 2>&1 || { echo "php-extension-tools: gen_stub.php did not install PHP-Parser into $work" >&2; exit 1; }
rm -rf "$dest"
mv "$work" "$dest"
echo "php-extension-tools: $dest/gen_stub.php with $(basename "$(ls -d "$dest"/PHP-Parser-* | head -n 1)")"
