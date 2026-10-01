.PHONY: check checklist-check ts-min-check client-unit-check client-db-check client-pooler-check conformance-check dialect-facts-check conformance-counter-check conformance-result-check conformance-result-physical-check conformance-rust-group-check group-rows-physical-check unselected-column-physical-check decimal-bench-sqlite decimal-db-setup decimal-physical-check db-test perf-check interface-check go-model-check ts-check schema-check schema-cross-language-check typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check fuzz-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check feature-check feature-docs package-check git-check test-servers test-servers-stop
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
SEND_SQLITE_DSN = sqlite://$(abspath .runtime/servers/send-savepoint.sqlite)
WITH_TEST_ENV = test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make test-servers" >&2; exit 1; }; . $(abspath $(TEST_ENV)) && export ORM_SEND_SQLITE_DSN="$(SEND_SQLITE_DSN)" &&

check: checklist-check feature-check git-check docs-rules-check docs-check docs-verify-idempotent interface-check go-model-check client-unit-check ts-check ts-min-check schema-check rust-check go-fmt-check rust-fmt-check rust-150-check rust-driver-check client-db-check client-pooler-check dialect-facts-check conformance-check db-test perf-check package-check dbspec-go-check dbspec-php-check dbspec-ts-check dbspec-rust-check dbspec-compare-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-php-check
	$(WITH_TEST_ENV) go test ./...

# client-pooler-check runs the client database tests through the PgBouncer
# pooler in transaction mode for PostgreSQL and the ProxySQL pooler for MySQL.
client-pooler-check:
	$(WITH_TEST_ENV) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" ./scripts/client-db-test.sh

checklist-check:
	node --test scripts/checklist/check.test.mjs
	node scripts/checklist/check.mjs

.PHONY: physical-identity-check
physical-identity-check:
	go test ./clients/go/orm -run '^TestPhysicalIdentityVectors$$' -count=2 -v
	php clients/php/tests/physical_identity_test.php
	php clients/php/tests/physical_identity_test.php
	cd clients/rust && cargo test --locked --offline -p orm-schema --test physical_identity -- --nocapture
	cd clients/rust && cargo test --locked --offline -p orm-schema --test physical_identity -- --nocapture
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	node --test clients/typescript/tests/physical-identity.mjs
	node --test clients/typescript/tests/physical-identity.mjs

PHYSICAL_NODE ?= node
PHYSICAL_RUST_TOOLCHAIN ?= 1.98.1
.PHONY: physical-check-check
.PHONY: physical-index-check
.PHONY: physical-key-check
physical-key-check: physical-index-check physical-fk-check
	go test ./clients/go/orm -run '^TestPhysicalKeyVectors$$' -count=2 -v
	php clients/php/tests/physical_key_test.php
	php clients/php/tests/physical_key_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_key -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_key -- --nocapture
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-key.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-key.mjs

physical-index-check: physical-check-check
	go test ./clients/go/orm -run '^TestPhysicalIndexVectors$$' -count=2 -v
	php clients/php/tests/physical_index_test.php
	php clients/php/tests/physical_index_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_index -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_index -- --nocapture
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-index.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-index.mjs

physical-check-check: physical-column-check
	go test ./clients/go/orm -run '^TestPhysicalCheck(Vectors|Bounds)$$' -count=2 -v
	php clients/php/tests/physical_check_test.php
	php clients/php/tests/physical_check_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_check -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_check -- --nocapture
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-check.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-check.mjs

# dbspec-rust-check runs the shared dbspec vectors and the Rust rule cases
# twice, then measures the stress document of tests/dbspec/stress.mjs in
# release mode twice: parse within 300 ms, emit(parse(doc)) == doc and two
# equal emissions.
DBSPEC_STRESS_DOCUMENT = clients/rust/target/dbspec/stress.dbspec
.PHONY: dbspec-rust-check
# dbspec-ddl-check applies every vector of tests/dbspec/ddl.json to MySQL,
# PostgreSQL and SQLite of TEST_ENV and runs its behavior steps, and applies
# the rendered statements of every schema/*.dbspec and contracts/fixtures/*.dbspec.
.PHONY: dbspec-ddl-check
dbspec-ddl-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^(TestDDLVectors|TestSchemaDocumentsApply)$$' -count=1 -timeout 10m -v

# dbspec-introspect-check renders and applies tests/dbspec/ddl.json and every
# schema document on MySQL, PostgreSQL and SQLite, introspects each database
# and requires the source schema text, and runs tests/dbspec/introspect.json.
.PHONY: dbspec-introspect-check
dbspec-introspect-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^(TestIntrospectRoundTrip|TestIntrospectUnsupported)$$' -count=1 -timeout 10m -v

# dbspec-introspect-php-check runs the same round trips and unsupported cases
# through the PHP client's Orm\Dbspec\Dbspec::introspect.
.PHONY: dbspec-introspect-php-check
dbspec-introspect-php-check:
	$(WITH_TEST_ENV) php clients/php/tests/dbspec_introspect_test.php

# dbspec-compare-check runs the Go, PHP, TypeScript and Rust dbspec runners
# twice each on tests/dbspec/cases.json and the stress document and fails on
# the first case whose emission or diagnostics differ between any two runs.
.PHONY: dbspec-compare-check
dbspec-compare-check:
	node --test tests/dbspec/compare/check.test.mjs
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT))
	node tests/dbspec/stress.mjs > $(DBSPEC_STRESS_DOCUMENT)
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p orm-schema --example dbspec_compare
	node tests/dbspec/compare/check.mjs tests/dbspec/cases.json $(DBSPEC_STRESS_DOCUMENT) tests/dbspec/ddl.json

dbspec-rust-check:
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT))
	node tests/dbspec/stress.mjs > $(DBSPEC_STRESS_DOCUMENT)
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test dbspec --test dbspec_rules --test dbspec_manifest --test dbspec_render -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test dbspec --test dbspec_rules --test dbspec_manifest --test dbspec_render -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) run --release --locked --offline -p orm-schema --example dbspec_stress -- $(abspath $(DBSPEC_STRESS_DOCUMENT))
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) run --release --locked --offline -p orm-schema --example dbspec_stress -- $(abspath $(DBSPEC_STRESS_DOCUMENT))

.PHONY: rust-send-savepoint-check
rust-send-savepoint-check:
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) clippy --locked --offline -p orm --lib -- -D warnings
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --lib tx::send_tests:: -- --nocapture
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --lib tx::send_tests:: -- --nocapture

.PHONY: physical-column-check
physical-column-check:
	go test ./clients/go/orm -run '^TestPhysicalColumnVectors$$' -count=2 -v
	php clients/php/tests/physical_column_test.php
	php clients/php/tests/physical_column_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_column -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_column -- --nocapture
	$(PHYSICAL_NODE) clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-column.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-column.mjs

.PHONY: physical-fk-check
physical-fk-check: physical-column-check
	go test ./clients/go/orm -run '^TestPhysicalForeignKeyVectors$$' -count=2 -v
	php clients/php/tests/physical_foreign_key_test.php
	php clients/php/tests/physical_foreign_key_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_foreign_key -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_foreign_key -- --nocapture
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-foreign-key.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-foreign-key.mjs

.PHONY: physical-graph-check
.PHONY: physical-json-check
.PHONY: physical-envelope-check
.PHONY: physical-document-typescript-check
.PHONY: physical-document-check
.PHONY: physical-document-php-limits-check
.PHONY: physical-document-limits-check
physical-document-limits-check: physical-document-php-limits-check
	go test ./clients/go/orm -run '^TestPhysicalDocumentLimits$$' -count=2 -v
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_document_limits -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_document_limits -- --nocapture
	$(PHYSICAL_NODE) node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-document-limits.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-document-limits.mjs

.PHONY: dbspec-php-check
# dbspec-php-check runs the shared dbspec vectors, the focused PHP rules, the
# statement vectors of tests/dbspec/ddl.json and the stress document of
# tests/dbspec/stress.mjs twice each; the stress test prints its parse and
# emit times and peak memory.
dbspec-php-check:
	php clients/php/tests/dbspec_test.php
	php clients/php/tests/dbspec_test.php
	php clients/php/tests/dbspec_rules_test.php
	php clients/php/tests/dbspec_rules_test.php
	php clients/php/tests/dbspec_manifest_test.php
	php clients/php/tests/dbspec_manifest_test.php
	php clients/php/tests/dbspec_render_test.php
	php clients/php/tests/dbspec_render_test.php
	php clients/php/tests/dbspec_stress_test.php
	php clients/php/tests/dbspec_stress_test.php

physical-document-php-limits-check:
	php clients/php/tests/physical_document_limits_test.php
	php clients/php/tests/physical_document_limits_test.php

physical-document-check: physical-document-typescript-check physical-document-limits-check
	go test ./clients/go/orm -run '^TestPhysical(Document|GraphVectors)$$' -count=2 -v
	php clients/php/tests/physical_document_test.php
	php clients/php/tests/physical_document_test.php
	php clients/php/tests/physical_graph_test.php
	php clients/php/tests/physical_graph_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_document --test physical_graph -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_document --test physical_graph -- --nocapture
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-graph.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-graph.mjs

physical-document-typescript-check:
	$(PHYSICAL_NODE) node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-document.mjs clients/typescript/tests/physical-document-render.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-document.mjs clients/typescript/tests/physical-document-render.mjs

physical-envelope-check:
	go test ./clients/go/orm -run '^TestPhysicalEnvelope$$' -count=2 -v
	php clients/php/tests/physical_envelope_test.php
	php clients/php/tests/physical_envelope_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_envelope -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_envelope -- --nocapture
	$(PHYSICAL_NODE) node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-envelope.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-envelope.mjs

physical-json-check: physical-graph-check
	go test ./engine/schema -run '^TestPhysicalJSONPreflightBounds$$' -count=2 -v
	go test ./clients/go/orm -run '^TestPhysicalGraphJSON(Output)?$$' -count=2 -v
	php clients/php/tests/physical_graph_json_test.php
	php clients/php/tests/physical_graph_json_test.php
	php clients/php/tests/physical_graph_json_output_test.php
	php clients/php/tests/physical_graph_json_output_test.php
	php clients/php/tests/physical_json_limits_test.php
	php clients/php/tests/physical_json_limits_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --lib physical_json::tests::preflight_bounds -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --lib physical_json::tests::preflight_bounds -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_graph_json -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_graph_json -- --nocapture
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-graph-json.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-graph-json.mjs

physical-graph-check: physical-key-check
	go test ./clients/go/orm -run '^TestPhysicalGraph(Vectors|Limits|Records)$$' -count=2 -v
	php clients/php/tests/physical_graph_test.php
	php clients/php/tests/physical_graph_test.php
	php clients/php/tests/physical_graph_records_test.php
	php clients/php/tests/physical_graph_records_test.php
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_graph --test physical_graph_limits --test physical_graph_records -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test physical_graph --test physical_graph_limits --test physical_graph_records -- --nocapture
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-graph.mjs clients/typescript/tests/physical-graph-records.mjs
	$(PHYSICAL_NODE) --test clients/typescript/tests/physical-graph.mjs clients/typescript/tests/physical-graph-records.mjs

test-servers:
	./scripts/test-servers.sh start $(TEST_MYSQL_PORT) $(TEST_POSTGRES_PORT) $(TEST_MYSQL_REPLICA_PORT) $(TEST_POSTGRES_REPLICA_PORT) $(TEST_PROXYSQL_PORT) $(TEST_PGBOUNCER_PORT)

test-servers-stop:
	./scripts/test-servers.sh stop

feature-check:
	node scripts/features/build.mjs --check
	node --test scripts/features/coverage.test.mjs
	npm run typescript:build
	$(WITH_TEST_ENV) node scripts/features/coverage.mjs
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

# dialect-facts-check runs the schema dialect probes of tests/dialects against
# the MySQL and PostgreSQL servers of TEST_ENV and a SQLite file per probe,
# and records which SQLite openers keep a DSN query in the file name.
# Each probe has its own deadline, so the go test binary timeout is off.
dialect-facts-check:
	go test ./tests/dialects -run '^TestProbeIDs$$' -count=1 -v
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^(TestDialectFacts|TestSQLiteFileNameWithQuery)$$' -count=1 -timeout 0 -v

conformance-counter-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/conformance/check -run '^TestPhysical(CounterCleanup|FailedRunnerStateCheck)$$' -count=1 -timeout 3m

conformance-result-check:
	python3 tests/conformance/run_result_tests.py

conformance-result-physical-check:
	$(WITH_TEST_ENV) go test -v -tags physical ./tests/conformance/check -run '^TestPhysicalResultRunners$$' -count=1 -timeout 40m

conformance-rust-group-check:
	$(WITH_TEST_ENV) go test -v -tags physical ./tests/conformance/check -run '^TestPhysicalRustGroupBoolean$$' -count=1 -timeout 35m

group-rows-physical-check:
	$(WITH_TEST_ENV) node scripts/group-rows-physical-check.mjs

unselected-column-physical-check:
	$(WITH_TEST_ENV) node scripts/unselected-column-physical-check.mjs

conformance-check: conformance-counter-check conformance-result-check conformance-result-physical-check
	$(WITH_TEST_ENV) go run ./tests/conformance/check run -driver mysql -dsn "$$BENCH_MYSQL_DSN"
	$(WITH_TEST_ENV) go run ./tests/conformance/check run -driver postgres -dsn "$$BENCH_POSTGRES_DSN"
	$(WITH_TEST_ENV) go run ./tests/conformance/check run -driver sqlite -dsn "$$BENCH_SQLITE_DSN"

decimal-bench-sqlite:
	./scripts/decimal-bench-sqlite.sh

decimal-db-setup:
	$(WITH_TEST_ENV) php scripts/decimal-db-setup.php

decimal-physical-check:
	test -f .runtime/decimal-env || { echo '.runtime/decimal-env is missing; run make decimal-db-setup' >&2; exit 1; }
	. .runtime/decimal-env && node scripts/decimal-physical-check.mjs

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

# dbspec-ts-check builds the TypeScript client, runs the shared dbspec
# vectors and the rules they do not cover yet, then parses and emits the
# stress document of tests/dbspec/stress.mjs twice, printing both timings.
.PHONY: dbspec-ts-check
dbspec-ts-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	node --test clients/typescript/tests/dbspec.mjs clients/typescript/tests/dbspec-rules.mjs clients/typescript/tests/dbspec-render.mjs
	node --test clients/typescript/tests/dbspec-stress.mjs
	node --test clients/typescript/tests/dbspec-stress.mjs

schema-check:
	npm run schema:check
	go run ./tests/schema/record -check

# dbspec-go-check runs the Go dbspec parser on the shared vectors of
# tests/dbspec/cases.json, its own rule cases, and the stress document that
# node tests/dbspec/stress.mjs writes, and logs the parse and emit times.
.PHONY: dbspec-go-check
dbspec-go-check:
	go test ./engine/dbspec -run '^(TestSharedVectors|TestRuleDiagnostics|TestEncodingAndLimitDiagnostics|TestCanonicalForms|TestParseReturnsModel|TestStressDocument|TestManifestVectors|TestManifestRejectsRepeatedDocumentName|TestRenderVectors|TestDocumentSets)$$' -count=1 -v

schema-cross-language-check:
	./scripts/schema/cross-language-check.sh

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

# go-fmt-check fails when gofmt would change a tracked Go source and lists
# the files it would change.
.PHONY: go-fmt-check
go-fmt-check:
	@files=$$(gofmt -l $$(git ls-files '*.go')); if [ -n "$$files" ]; then echo "gofmt would change:"; echo "$$files"; exit 1; fi; echo "go-fmt-check: every tracked Go source is gofmt formatted"

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
	node --test scripts/git/check.test.mjs
	node scripts/git/check.mjs
