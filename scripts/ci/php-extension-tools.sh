#!/bin/sh
# make install-php-extension-tools installs, on the Linux runner of CI, what the build of the PHP extension orm_dbspec
# (clients/php-extension) needs besides Rust and PHP: libclang, which the bindgen of ext-php-rs loads to read the PHP
# headers. setup-php installs php-config and the headers of the PHP on PATH; the script checks that php-config reports
# that PHP, because the extension is built for the PHP whose php-config the build finds.
# LLVM is the pinned major release of libclang: Ubuntu 26.04 ships LLVM 21 as its default libclang-dev, and the
# package of that major keeps the bindgen output of one LLVM release.
set -eu
LLVM=21
sudo apt-get update -q >/dev/null
sudo apt-get install -y -q "libclang-$LLVM-dev" >/dev/null
library=$(ls "/usr/lib/llvm-$LLVM/lib/"libclang.so* 2>/dev/null | head -n 1)
test -n "$library" || { echo "php-extension-tools: no libclang.so under /usr/lib/llvm-$LLVM/lib after installing libclang-$LLVM-dev; check the package of the runner image" >&2; exit 1; }
# bindgen (clang-sys) finds the newest libclang on the machine; LIBCLANG_PATH names the pinned one for the steps after.
if [ -n "${GITHUB_ENV:-}" ]; then echo "LIBCLANG_PATH=/usr/lib/llvm-$LLVM/lib" >> "$GITHUB_ENV"; fi
echo "php-extension-tools: libclang $library"
command -v php-config >/dev/null || { echo "php-extension-tools: php-config is not on PATH; the setup-php step installs it with the PHP of .php-version" >&2; exit 1; }
test "$(php-config --version)" = "$(php -r 'echo PHP_VERSION;')" || { echo "php-extension-tools: php-config reports PHP $(php-config --version), but php is PHP $(php -r 'echo PHP_VERSION;')" >&2; exit 1; }
echo "php-extension-tools: php-config $(php-config --version)"
