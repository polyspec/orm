#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
GO_BIN="$ROOT/.runtime/proto-bin"
RUST_ROOT="$ROOT/.runtime/protoc-gen-prost"
mkdir -p "$GO_BIN" "$RUST_ROOT" "$ROOT/clients/typescript/src/gen" "$ROOT/clients/php/src/Proto" "$ROOT/clients/rust/orm/src/gen"

if [ ! -x "$GO_BIN/protoc-gen-go" ]; then
  GOBIN="$GO_BIN" go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
fi
if [ ! -x "$GO_BIN/protoc-gen-connect-go" ]; then
  GOBIN="$GO_BIN" go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.21.0
fi
if [ ! -x "$RUST_ROOT/bin/protoc-gen-prost" ]; then
  PATH="$HOME/.cargo/bin:$PATH" cargo install protoc-gen-prost --version 0.5.0 --locked --root "$RUST_ROOT"
fi

cd "$ROOT"
PATH="$GO_BIN:$ROOT/node_modules/.bin:$RUST_ROOT/bin:$PATH" protoc -I . \
  --go_out=. --go_opt=paths=source_relative \
  --connect-go_out=. --connect-go_opt=paths=source_relative \
  --es_out=clients/typescript/src/gen --es_opt=target=ts \
  --php_out=clients/php/src/Proto \
  --prost_out=clients/rust/orm/src/gen \
  proto/orm/compiler/v1/compiler.proto

gofmt -w proto/orm/compiler/v1/compiler.pb.go proto/orm/compiler/v1/compilerv1connect/compiler.connect.go
node scripts/proto/normalize-generated.mjs
composer dump-autoload --working-dir=clients/php --optimize --no-interaction >/dev/null
node scripts/proto/write-manifest.mjs
