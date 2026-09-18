#!/bin/sh
# Generates 150 entities with orm-build and compiles a crate that calls a
# getter, a setter, and a chain on every model.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$HOME/.cargo/bin:$PATH"
export PATH
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
mkdir -p "$WORK/crate/src"
cat > "$WORK/crate/Cargo.toml" <<TOML
[package]
name = "rust-150"
version = "0.0.1"
edition = "2021"
publish = false

[dependencies]
orm = { path = "$ROOT/clients/rust/orm" }

[build-dependencies]
orm-build = { path = "$ROOT/clients/rust/orm-build" }

[workspace]
TOML
cat > "$WORK/crate/build.rs" <<'RS'
fn main() {
    orm_build::Builder::new("../schema.json").scan("src").generate();
}
RS
{
  echo 'orm::models!();'
  echo 'pub fn touch() {'
  i=1
  while [ "$i" -le 150 ]; do
    model=$(printf 'Entity%03d' "$i")
    echo "    let m = model::$model::new().set_name(\"x\").revision(1).and_gt_seq(0);"
    echo "    let _ = m.get_name();"
    i=$((i + 1))
  done
  echo '}'
} > "$WORK/crate/src/lib.rs"
cp clients/rust/Cargo.lock "$WORK/crate/Cargo.lock"
CARGO_TARGET_DIR="$ROOT/clients/rust/target/rust-150" cargo check --manifest-path "$WORK/crate/Cargo.toml"
printf '%s\n' "rust-150: 150 generated entities compiled"
