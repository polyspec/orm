.PHONY: check db-test perf-check interface-check ts-check ts-db-check schema-check proto-check typescript-build rust-check rust-150-check rust-driver-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check
.NOTPARALLEL: check docs-check docs-verify-idempotent

check: docs-rules-check docs-check docs-verify-idempotent interface-check ts-check schema-check proto-check rust-check rust-driver-check db-test perf-check
	go test ./...

interface-check:
	PATH="$(HOME)/.cargo/bin:$(PATH)" go run ./tests/interfaces/check --self-test

db-test:
	./scripts/db-test.sh

perf-check:
	ORM_RUN_PERF_GATE=1 go test ./bench/go -run TestHotPathGate -count=1 -v

ts-check:
	npm run typescript:check && npm run typescript:build && node tests/typescript/check.mjs && node tests/typescript/common-vector.mjs && node tests/typescript/compiler-bridge.mjs && node tests/typescript/driver.mjs && node tests/typescript/database.mjs && node tests/typescript/codec-vector.mjs

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
