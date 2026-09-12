.PHONY: check client-unit-check db-test perf-check interface-check token-check ts-check ts-db-check typescript-root-in schema-check proto-check typescript-build rust-check rust-150-check rust-driver-check fuzz-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check feature-check feature-docs package-check
.NOTPARALLEL: check docs-check docs-verify-idempotent

check: feature-check docs-rules-check docs-check docs-verify-idempotent interface-check token-check client-unit-check ts-check schema-check proto-check rust-check rust-driver-check db-test perf-check package-check
	go test ./...

feature-check:
	node scripts/features/build.mjs --check
	node scripts/features/check.mjs --run

feature-docs:
	node scripts/features/build.mjs

package-check:
	./scripts/package-check.sh

fuzz-check:
	go test ./engine/schema -run '^$$' -fuzz FuzzParseMermaid -fuzztime=1s
	go test ./engine/schema -run '^$$' -fuzz FuzzLoadManifest -fuzztime=1s
	go test ./engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s
	go test ./cmd/ormgen -run '^$$' -fuzz FuzzSplitSQL -fuzztime=1s
	go test ./clients/go/orm -run '^$$' -fuzz FuzzDecodeKeysetCursor -fuzztime=1s
	go test ./clients/go/orm -run '^$$' -fuzz FuzzDecodeCiphertext -fuzztime=1s

client-unit-check:
	php clients/php/tests/relation_keys.php && php clients/php/tests/keyset.php

interface-check:
	PATH="$(HOME)/.cargo/bin:$(PATH)" go run ./tests/interfaces/check --self-test

token-check:
	go run ./cmd/ormgen tokens --schema schema/schema.json tests/conformance/runner_go/main.go tests/conformance/runner.php clients/rust/tests/src/conformance.rs tests/conformance/runner_typescript.mjs

db-test:
	./scripts/db-test.sh

perf-check:
	./scripts/perf-test.sh

ts-check:
	npm run typescript:check && npm run typescript:build && node tests/typescript/check.mjs && node tests/typescript/common-vector.mjs && node tests/typescript/compiler-bridge.mjs && node tests/typescript/driver.mjs && node tests/typescript/database.mjs && node tests/typescript/root-in.mjs && node tests/typescript/codec-vector.mjs && node tests/typescript/transaction.mjs && node tests/typescript/keyset.mjs

typescript-root-in:
	npm run typescript:build && node tests/typescript/root-in.mjs

ts-db-check:
	./scripts/typescript/sqlite-test.sh

schema-check:
	npm run schema:check

proto-check:
	npm run proto:check
	./scripts/proto/connect-test.sh

docs-dev:
	npm run docs:dev

docs-build:
	npm run docs:build

docs-check:
	npm run docs:check

docs-static-check:
	npm run docs:static-check

docs-verify-idempotent:
	npm run docs:verify-idempotent

docs-rules-check:
	npm run docs:rules-check

rust-150-check:
	./scripts/check-rust-150.sh

rust-check:
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo check --locked

rust-driver-check:
	cd bench/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo check --locked --bin driver_compare

typescript-build:
	npm run typescript:build
