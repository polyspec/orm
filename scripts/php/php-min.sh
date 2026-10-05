#!/bin/sh
# Prints the program path of the lowest PHP release that clients/php/composer.json
# declares in require.php (">=x.y"), or that release with --version. The
# program is php<x.y> on PATH, as the Debian packages install it, or the
# Homebrew php@<x.y> keg; its PHP_MAJOR_VERSION.PHP_MINOR_VERSION must be x.y.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
VERSION=$(sed -n 's/.*"php": *">=\([0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$ROOT/clients/php/composer.json" | head -n 1)
[ -n "$VERSION" ] || { echo "clients/php/composer.json declares no require.php >=x.y" >&2; exit 2; }
if [ "${1:-}" = --version ]; then echo "$VERSION"; exit 0; fi

PROGRAM=$(command -v "php$VERSION" || true)
if [ -z "$PROGRAM" ] && command -v brew >/dev/null; then
  PROGRAM="$(brew --prefix)/opt/php@$VERSION/bin/php"
fi
[ -n "$PROGRAM" ] && [ -x "$PROGRAM" ] || { echo "PHP $VERSION is not installed: no php$VERSION on PATH and no Homebrew php@$VERSION; install it (Debian php$VERSION-cli or Homebrew php@$VERSION)" >&2; exit 2; }
ACTUAL=$("$PROGRAM" -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')
[ "$ACTUAL" = "$VERSION" ] || { echo "$PROGRAM is PHP $ACTUAL, not $VERSION" >&2; exit 2; }
echo "$PROGRAM"
