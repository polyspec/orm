#!/bin/sh
# make install-php-extension-tools installs, on the Linux runner of CI, what the build of the PHP extension orm_dbspec
# (clients/php-extension) needs besides Rust and PHP: libclang, which the bindgen of ext-php-rs loads to read the PHP
# headers. setup-php installs php-config and the headers of the PHP on PATH; the script checks that php-config reports
# that PHP, because the extension is built for the PHP whose php-config the build finds.
set -eu
sudo apt-get update -q >/dev/null
sudo apt-get install -y -q libclang-dev >/dev/null
library=$(ls /usr/lib/llvm-*/lib/libclang.so* 2>/dev/null | head -n 1)
test -n "$library" || { echo "php-extension-tools: no libclang.so under /usr/lib/llvm-*/lib after installing libclang-dev" >&2; exit 1; }
echo "php-extension-tools: libclang $library"
command -v php-config >/dev/null || { echo "php-extension-tools: php-config is not on PATH; the setup-php step installs it with the PHP of .php-version" >&2; exit 1; }
test "$(php-config --version)" = "$(php -r 'echo PHP_VERSION;')" || { echo "php-extension-tools: php-config reports PHP $(php-config --version), but php is PHP $(php -r 'echo PHP_VERSION;')" >&2; exit 1; }
echo "php-extension-tools: php-config $(php-config --version)"
