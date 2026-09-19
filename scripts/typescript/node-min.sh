#!/bin/sh
# Prints the bin directory of the lowest Node release that package.json
# declares in engines.node (">=x.y.z"), downloading the official build into
# ${ORM_NODE_CACHE:-$HOME/.cache/orm-node} on first use.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
VERSION=$(sed -n 's/.*"node": *">=\([0-9.]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
[ -n "$VERSION" ] || { echo "package.json declares no engines.node >=x.y.z" >&2; exit 2; }

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "unsupported OS $(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 2 ;;
esac

CACHE=${ORM_NODE_CACHE:-$HOME/.cache/orm-node}
NAME=node-v$VERSION-$OS-$ARCH
if [ ! -x "$CACHE/$NAME/bin/node" ]; then
  mkdir -p "$CACHE"
  curl -fsSL "https://nodejs.org/dist/v$VERSION/$NAME.tar.gz" | tar -xz -C "$CACHE"
fi
echo "$CACHE/$NAME/bin"
