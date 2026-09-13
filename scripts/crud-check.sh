#!/bin/sh
set -eu
PATH="/Users/maxkwon/.cargo/bin:$PATH"
export PATH
first=$(mktemp)
second=$(mktemp)
trap 'rm -f "$first" "$second"' EXIT
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --out "$first"
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --out "$second"
cmp "$first" "$second"
goOne=$(mktemp)
goTwo=$(mktemp)
tsBase=$(mktemp)
phpBase=$(mktemp)
rustBase=$(mktemp)
tsOut="$tsBase.ts"
phpOut="$phpBase.php"
rustOut="$rustBase.rs"
trap 'rm -f "$first" "$second" "$goOne" "$goTwo" "$tsBase" "$tsOut" "$phpBase" "$phpOut" "$rustBase" "$rustOut"' EXIT
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --lang go --out "$goOne"
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --lang go --out "$goTwo"
cmp "$goOne" "$goTwo"
test -z "$(gofmt -d "$goOne")"
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --lang typescript --out "$tsOut"
npx tsc --noEmit --skipLibCheck --target ES2022 --module ESNext "$tsOut"
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --lang php --out "$phpOut"
php -l "$phpOut" >/dev/null
go run ./cmd/platformgen build --schema tests/fixtures/crud/schema.mmd --lang rust --out "$rustOut"
rustc --crate-name crud_contract --crate-type lib "$rustOut" -o /tmp/crud_contract.rlib
echo "crud metadata: validation, Go transaction contract, TypeScript contract, and deterministic output passed"
