#!/bin/sh
# Prints the bin directory of the lowest Node release that package.json
# declares in engines.node (">=x.y.z"), from ${ORM_NODE_CACHE:-$HOME/.cache/orm-node}, into which
# make install-node-min downloads the official build.
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
# download는 make install-node-min(ORM_NODE_MIN_INSTALL=1)만 한다. check는 network를 읽지 않으므로 빠진 Node는
# make install을 적고 실패한다.
if [ ! -x "$CACHE/$NAME/bin/node" ]; then
  if [ "${ORM_NODE_MIN_INSTALL:-}" != 1 ]; then
    echo "node-min: Node $VERSION is not in $CACHE; run make install, which downloads it" >&2
    exit 1
  fi
  # 압축은 cache의 임시 directory에 풀고 끝나면 rename으로 publish하므로, 끊긴 download가 반쪽 Node를 남기지 않는다.
  next="$CACHE/$NAME.next-$$"
  rm -rf "$next"
  mkdir -p "$next"
  curl -fsSL "https://nodejs.org/dist/v$VERSION/$NAME.tar.gz" | tar -xz -C "$next"
  rm -rf "${CACHE:?}/$NAME"
  mv "$next/$NAME" "$CACHE/$NAME"
  rmdir "$next"
fi
echo "$CACHE/$NAME/bin"
