.PHONY: check ts-min-check client-unit-check client-db-check conformance-check db-test perf-check interface-check go-model-check ts-check schema-check typescript-build rust-check rust-150-check rust-driver-check fuzz-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check feature-check feature-docs package-check
.NOTPARALLEL: check docs-check docs-verify-idempotent

check: feature-check docs-rules-check docs-check docs-verify-idempotent interface-check go-model-check client-unit-check ts-check ts-min-check schema-check rust-check rust-150-check rust-driver-check client-db-check conformance-check db-test perf-check package-check
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
	go test ./internal/ormgen -run '^$$' -fuzz FuzzSplitSQL -fuzztime=1s
	go test ./clients/go/orm -run '^$$' -fuzz FuzzDecodeCiphertext -fuzztime=1s

client-unit-check:
	php clients/php/tests/dsn.php && php clients/php/tests/relation_keys.php && php clients/php/tests/hostcodec.php && php clients/php/tests/engine_test.php && php clients/php/tests/schema_test.php && php clients/php/tests/schema_tool_test.php

client-db-check:
	ORM_CLIENT_DB_LANGS=go,php,rust ./scripts/client-db-test.sh

conformance-check:
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo build --locked --release -p orm-tests --bin conformance
	npm run typescript:build
	go run ./tests/conformance/check run -driver mysql
	go run ./tests/conformance/check run -driver postgres
	go run ./tests/conformance/check run -driver sqlite

interface-check:
	PATH="$(HOME)/.cargo/bin:$(PATH)" go run ./tests/interfaces/check --self-test

go-model-check:
	cd clients/go/model && go generate ./ && git diff --exit-code -- .

db-test:
	./scripts/db-test.sh

perf-check:
	./scripts/perf-test.sh

ts-check:
	npm run typescript:check && npm run typescript:test

# ts-min-check runs the TypeScript tests on the lowest Node release that
# package.json supports.
ts-min-check:
	PATH="$$(./scripts/typescript/node-min.sh):$$PATH" && export PATH && node --version && npm run typescript:test

schema-check:
	npm run schema:check
	go run ./tests/schema/record -check

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
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo check --locked && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo clippy --locked --workspace --all-targets -- -D warnings
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo clippy --locked -p orm-build --all-targets --features cli -- -D warnings

rust-driver-check:
	cd bench/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo check --locked --bin driver_compare

typescript-build:
	npm run typescript:build
