.PHONY: check ts-min-check client-unit-check client-db-check client-pooler-check conformance-check db-test perf-check interface-check go-model-check ts-check schema-check typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check fuzz-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check feature-check feature-docs package-check git-check test-servers test-servers-stop
.NOTPARALLEL: check docs-check docs-verify-idempotent

# make test-servers starts the MySQL and PostgreSQL primaries, their replicas,
# and the ProxySQL and PgBouncer poolers of the database checks on these ports
# and writes TEST_ENV; the database checks read TEST_ENV and fail when it is
# missing.
TEST_MYSQL_PORT = 33171
TEST_POSTGRES_PORT = 55471
TEST_MYSQL_REPLICA_PORT = 33181
TEST_POSTGRES_REPLICA_PORT = 55481
TEST_PROXYSQL_PORT = 33182
TEST_PGBOUNCER_PORT = 55482
TEST_ENV = .runtime/servers/env
WITH_TEST_ENV = test -f $(TEST_ENV) || { echo "$(TEST_ENV) is missing; run make test-servers" >&2; exit 1; }; . ./$(TEST_ENV) &&

check: feature-check git-check docs-rules-check docs-check docs-verify-idempotent interface-check go-model-check client-unit-check ts-check ts-min-check schema-check rust-check rust-fmt-check rust-150-check rust-driver-check client-db-check client-pooler-check conformance-check db-test perf-check package-check
	$(WITH_TEST_ENV) go test ./...

# client-pooler-check runs the client database tests through the PgBouncer
# pooler in transaction mode for PostgreSQL and the ProxySQL pooler for MySQL.
client-pooler-check:
	$(WITH_TEST_ENV) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" ./scripts/client-db-test.sh

test-servers:
	./scripts/test-servers.sh start $(TEST_MYSQL_PORT) $(TEST_POSTGRES_PORT) $(TEST_MYSQL_REPLICA_PORT) $(TEST_POSTGRES_REPLICA_PORT) $(TEST_PROXYSQL_PORT) $(TEST_PGBOUNCER_PORT)

test-servers-stop:
	./scripts/test-servers.sh stop

feature-check:
	node scripts/features/build.mjs --check
	$(WITH_TEST_ENV) node scripts/features/check.mjs --run

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
	$(WITH_TEST_ENV) ./scripts/client-db-test.sh

conformance-check:
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo build --locked --release -p orm-tests --bin conformance
	npm run typescript:build
	$(WITH_TEST_ENV) go run ./tests/conformance/check run -driver mysql -dsn "$$BENCH_MYSQL_DSN"
	$(WITH_TEST_ENV) go run ./tests/conformance/check run -driver postgres -dsn "$$BENCH_POSTGRES_DSN"
	$(WITH_TEST_ENV) go run ./tests/conformance/check run -driver sqlite -dsn "$$BENCH_SQLITE_DSN"

interface-check:
	PATH="$(HOME)/.cargo/bin:$(PATH)" go run ./tests/interfaces/check --self-test

go-model-check:
	cd clients/go/model && go generate ./ && git diff --exit-code -- .

db-test:
	$(WITH_TEST_ENV) ./scripts/db-test.sh

perf-check:
	$(WITH_TEST_ENV) ./scripts/perf-test.sh

ts-check:
	npm run typescript:check && $(WITH_TEST_ENV) npm run typescript:test

# ts-min-check runs the TypeScript tests on the lowest Node release that
# package.json supports.
ts-min-check:
	$(WITH_TEST_ENV) PATH="$$(./scripts/typescript/node-min.sh):$$PATH" && export PATH && node --version && npm run typescript:test

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

# rust-fmt-check fails when cargo fmt would change a source of the Rust
# workspace (clients/rust/rustfmt.toml).
rust-fmt-check:
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo fmt --all --check

rust-150-check:
	./scripts/check-rust-150.sh

rust-check:
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo check --locked && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo clippy --locked --workspace --all-targets -- -D warnings
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo clippy --locked -p orm-build --all-targets --features cli -- -D warnings

rust-driver-check:
	cd bench/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo check --locked --bin driver_compare

typescript-build:
	npm run typescript:build

git-check:
	node scripts/git/check.mjs
