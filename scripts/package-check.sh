#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$HOME/.cargo/bin:$PATH"
export PATH
VERSION=$(cat "$ROOT/VERSION")

PACK_JSON=$(mktemp)
TMP_GO=$(mktemp -d)
TMP_RUST=$(mktemp -d)
trap 'rm -f "$PACK_JSON"; rm -rf "$TMP_GO" "$TMP_RUST"' EXIT

# 네 package 검사는 서로 독립이다. 검사마다 자기 subshell(set -e)에서 실행하고, 실패한 검사 뒤에도 나머지를
# 실행하며, 끝에 실패한 검사를 모두 적고 1로 끝난다.
FAILED=
keep() {
  name=$1
  shift
  ( set -e; "$@" ) || FAILED="$FAILED
  $name (exit $?)"
}

typescript_package() {
(
  cd "$ROOT/clients/typescript"
  npm pack --dry-run --json > "$PACK_JSON"
)
node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[0]; if (p.name !== "@polyspec/orm" || p.version !== process.argv[2] || !p.files.some(f => f.path === "dist/index.js")) process.exit(1); console.log(`typescript package: ${p.name}@${p.version}, ${p.files.length} files`)' "$PACK_JSON" "$VERSION"
}

php_package() {
composer validate --working-dir="$ROOT/clients/php" --no-check-publish
}

rust_package() {
# The Rust client depends on git crates that are not on a registry, so it is
# checked as a path dependency of an external crate instead of `cargo package`.
mkdir -p "$TMP_RUST/src"
cat > "$TMP_RUST/Cargo.toml" <<EOF
[package]
name = "orm-external-check"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
polyspec-orm = { path = "$ROOT/clients/rust/orm" }

[workspace]
EOF
cat > "$TMP_RUST/src/lib.rs" <<'EOF'
pub fn config_code() -> &'static str {
    polyspec_orm::codes::CONFIG
}
EOF
# 공유 Rust target directory에 build하므로 그 lease(make가 export하는 LEASE, CARGO_LEASES) 아래에서 실행한다.
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:?CARGO_TARGET_DIR is unset; run this through make, which exports it}" "${LEASE:?LEASE is unset; run this through make}" run "${CARGO_LEASES:?CARGO_LEASES is unset; run this through make}" exclusive --wait -- cargo check --manifest-path "$TMP_RUST/Cargo.toml" --quiet
echo "rust package: polyspec-orm builds as an external path dependency"
}

go_package() {

(
  cd "$TMP_GO"
  go mod init example.com/orm-external-check >/dev/null
  go mod edit -replace "github.com/polyspec/orm=$ROOT"
  cat > external_test.go <<'EOF'
package external_test

import (
    "testing"

    "github.com/polyspec/orm/clients/go/orm"
)

func TestExternalModuleCanImportClient(t *testing.T) {
    if orm.IsDeadlock(nil) { t.Fatal("nil error reported as deadlock") }
}
EOF
  go get "github.com/polyspec/orm@v$VERSION" >/dev/null
  go mod tidy >/dev/null
  go test -timeout 0 ./...
)
}

keep 'typescript package' typescript_package
keep 'php package' php_package
keep 'rust package' rust_package
keep 'go package' go_package
if [ -n "$FAILED" ]; then
  printf 'package-check: failed:%s\n' "$FAILED" >&2
  exit 1
fi
