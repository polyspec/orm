#!/bin/sh
# Builds the ormgen release binaries. Version is fixed at 0.0.1 and
# part of every file name — no "latest" symlinks. Output: dist/<name>-0.0.1-<os>-<arch>[.ext] + SHA256SUMS.
set -eu
cd "$(dirname "$0")/.."
VERSION=0.0.1
OUT=dist
rm -rf "$OUT" && mkdir -p "$OUT"

# ormgen for developers' machines
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
  os=${target%/*}; arch=${target#*/}
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$OUT/ormgen-$VERSION-$os-$arch" ./cmd/ormgen
done

(cd "$OUT" && shasum -a 256 -- * > SHA256SUMS)
ls -la "$OUT"
