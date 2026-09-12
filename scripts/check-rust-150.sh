#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/orm-rust-150.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

awk 'BEGIN {
  print "erDiagram"
  for (i = 1; i <= 150; i++) {
    name = sprintf("entity_%03d", i)
    print "  " name " {"
    print "    bigint seq PK \"auto\""
    print "    varchar(64) name"
    print "    int revision \"=0\""
    print "    datetime(6) created_ts \"=now\""
    print "  }"
  }
}' > "$WORK/rust-150.mmd"

cd "$ROOT"
go run ./cmd/ormgen build "$WORK/rust-150.mmd" --out "$WORK/schema.json"
go run ./cmd/ormgen gen --schema "$WORK/schema.json" --lang rust --out "$WORK/gen"
sed "s|path = \"../orm\"|path = \"$ROOT/clients/rust/orm\"|" "$WORK/gen/Cargo.toml" > "$WORK/Cargo.toml"
mv "$WORK/Cargo.toml" "$WORK/gen/Cargo.toml"
cp clients/rust/Cargo.lock "$WORK/gen/Cargo.lock"
CARGO_TARGET_DIR="$ROOT/clients/rust/target/rust-150" cargo check --locked --manifest-path "$WORK/gen/Cargo.toml"
printf '%s\n' "rust-150: 150 generated entities compiled"
