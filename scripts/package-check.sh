#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PATH="$HOME/.cargo/bin:$PATH"
export PATH

PACK_JSON=$(mktemp)
TMP_GO=$(mktemp -d)
trap 'rm -f "$PACK_JSON"; rm -rf "$TMP_GO"' EXIT

(
  cd "$ROOT/clients/typescript"
  npm pack --dry-run --json > "$PACK_JSON"
)
node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[0]; if (p.name !== "@polyspec/orm-typescript" || p.version !== "0.0.1" || !p.files.some(f => f.path === "dist/index.js")) process.exit(1); console.log(`typescript package: ${p.name}@${p.version}, ${p.files.length} files`)' "$PACK_JSON"

composer validate --working-dir="$ROOT/clients/php" --no-check-publish
cargo package --manifest-path "$ROOT/clients/rust/orm/Cargo.toml" --locked --allow-dirty --no-verify

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
  go get github.com/polyspec/orm@v0.0.1 >/dev/null
  go mod tidy >/dev/null
  go test ./...
)
