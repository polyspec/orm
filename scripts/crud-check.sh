#!/bin/sh
set -eu
first=$(mktemp)
second=$(mktemp)
trap 'rm -f "$first" "$second"' EXIT
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --out "$first"
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --out "$second"
cmp "$first" "$second"
echo "crud metadata: validation and deterministic manifest passed"
