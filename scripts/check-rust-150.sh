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
  print "dbspec 1 rust_150"
  for (i = 1; i <= 150; i++) {
    name = sprintf("entity_%03d", i)
    print ""
    print "table " name " {"
    print "  seq i64 identity"
    print "  name varchar(64)"
    print "  revision i32 default 0"
    print "  created_ts datetime(6) default now"
    print "  primary key (seq)"
    print "}"
  }
}' > "$WORK/rust-150.dbs"

cd "$ROOT"
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
    orm_build::Builder::new(["../rust-150.dbs"]).scan("src").generate();
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
# 생성한 crate는 workspace의 target을 함께 써서 orm과 의존성을 다시 compile하지 않는다.
CARGO_TARGET_DIR="$ROOT/clients/rust/target" cargo check --manifest-path "$WORK/crate/Cargo.toml"
printf '%s\n' "rust-150: 150 generated entities compiled"
