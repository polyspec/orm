#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/orm-schema-cross.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

MMD="$ROOT/schema/bench.mmd"
GO_OUT="$WORK/go.json"
PHP_OUT="$WORK/php.json"
RUST_OUT="$WORK/rust.json"
TS_OUT="$WORK/typescript.json"

cd "$ROOT"
go run ./cmd/ormgen build "$MMD" --out "$GO_OUT"
php clients/php/bin/orm-gen build "$MMD" --out "$PHP_OUT"
npm run typescript:build >/dev/null
node clients/typescript/dist/bin/orm-gen.js build "$MMD" --out "$TS_OUT"
(cd clients/rust && cargo run --offline --locked -p orm-build --features cli -- build "$MMD" --out "$RUST_OUT")

python3 - "$GO_OUT" "$PHP_OUT" "$RUST_OUT" "$TS_OUT" <<'PY'
import json
import sys
from pathlib import Path

paths = [Path(p) for p in sys.argv[1:]]
values = [json.loads(p.read_text()) for p in paths]
if any(value != values[0] for value in values[1:]):
    for path, value in zip(paths, values):
        print(f"{path}: schema_hash={value.get('schema_hash')} entities={len(value.get('order', []))}", file=sys.stderr)
    raise SystemExit("schema manifests differ between language builders")
print(f"schema: four language builders agree ({len(values[0].get('order', []))} entities, {values[0]['schema_hash']})")
PY
