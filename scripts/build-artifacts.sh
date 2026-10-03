#!/bin/sh
# Builds the Go orm-gen release binaries. Version comes from VERSION and
# part of every file name — no "latest" symlinks. Output: dist/<name>-<version>-<os>-<arch>[.ext] + SHA256SUMS.
set -eu
cd "$(dirname "$0")/.."
VERSION=$(cat "$(dirname "$0")/../VERSION")
OUT=dist
rm -rf "$OUT" && mkdir -p "$OUT"

# orm-gen for developers' machines
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
  os=${target%/*}; arch=${target#*/}
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$OUT/orm-gen-$VERSION-$os-$arch" ./cmd/orm-gen
done

(cd "$OUT" && shasum -a 256 -- * > SHA256SUMS)
ls -la "$OUT"
