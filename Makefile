.PHONY: check checklist-check ts-min-check client-unit-check client-db-check client-pooler-check conformance-check dialect-facts-check conformance-counter-check conformance-result-check conformance-result-physical-check conformance-rust-group-check group-rows-physical-check unselected-column-physical-check decimal-bench-sqlite decimal-db-setup decimal-physical-check perf-check interface-check go-model-check ts-model-check ts-check typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check fuzz-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check feature-check feature-docs package-check git-check test-servers test-servers-stop
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
SEND_SQLITE_DSN = sqlite://$(dir $(abspath $(TEST_ENV)))send-savepoint.sqlite
WITH_TEST_ENV = test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make test-servers" >&2; exit 1; }; . $(abspath $(TEST_ENV)) && export ORM_SEND_SQLITE_DSN="$(SEND_SQLITE_DSN)" &&

check: checklist-check feature-check git-check docs-rules-check docs-check docs-verify-idempotent interface-check go-model-check client-unit-check ts-check ts-min-check rust-check go-fmt-check rust-fmt-check rust-150-check rust-driver-check client-db-check client-pooler-check dialect-facts-check conformance-check perf-check package-check dbspec-go-check dbspec-php-check dbspec-ts-check dbspec-rust-check dbspec-compare-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-rust-check dbspec-introspect-compare-check dbspec-plan-check dbspec-apply-check dbspec-plan-ts-check dbspec-plan-rust-check ts-model-check dbspec-plan-php-check dbspec-apply-php-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check
	$(WITH_TEST_ENV) go test ./...

# client-pooler-check runs the client database tests through the PgBouncer
# pooler in transaction mode for PostgreSQL and the ProxySQL pooler for MySQL.
client-pooler-check:
	$(WITH_TEST_ENV) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" ./scripts/client-db-test.sh

checklist-check:
	node --test scripts/checklist/check.test.mjs
	node scripts/checklist/check.mjs

PHYSICAL_RUST_TOOLCHAIN ?= 1.98.1

# dbspec-rust-check는 공유 dbspec vector, Rust rule case, plan과 Mermaid case, 감싼 SQLite
# connection으로 주입한 apply 정리 error를 두 번 실행하고, tests/dbspec/stress.mjs의 stress
# 문서를 release mode에서 두 번 잰다: parse는 300 ms 안, emit(parse(doc)) == doc, 두
# emission이 같다.
DBSPEC_STRESS_DOCUMENT = clients/rust/target/dbspec/stress.dbspec
.PHONY: dbspec-rust-check
# dbspec-ddl-check는 tests/dbspec/ddl.json의 모든 vector를 TEST_ENV의 MySQL, PostgreSQL,
# SQLite에 적용해 behavior step을 실행하고, 모든 schema/*.dbspec과 contracts/fixtures/*.dbspec의
# 렌더링한 statement를 적용한다.
.PHONY: dbspec-ddl-check
dbspec-ddl-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^(TestDDLVectors|TestSchemaDocumentsApply)$$' -count=1 -timeout 10m -v

# dbspec-introspect-check는 tests/dbspec/ddl.json과 모든 schema 문서를 MySQL, PostgreSQL,
# SQLite에 렌더링해 적용하고, 각 database를 introspect해 source schema text를 요구하며,
# tests/dbspec/introspect.json을 실행한다.
.PHONY: dbspec-introspect-check
dbspec-introspect-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^(TestIntrospectRoundTrip|TestIntrospectUnsupported)$$' -count=1 -timeout 10m -v

# dbspec-introspect-ts-check는 TypeScript client를 build하고 dbspec-introspect-check의 round
# trip과 미지원 case를 그 introspectDbspec으로 MySQL, PostgreSQL, SQLite에서 실행한다.
.PHONY: dbspec-introspect-ts-check
dbspec-introspect-ts-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(WITH_TEST_ENV) node --test clients/typescript/tests/dbspec-introspect.mjs

# dbspec-introspect-php-check는 같은 round trip과 미지원 case를 PHP client의
# Orm\Dbspec\Dbspec::introspect로 실행한다.
.PHONY: dbspec-introspect-php-check
dbspec-introspect-php-check:
	$(WITH_TEST_ENV) php clients/php/tests/dbspec_introspect_test.php
	php clients/php/tests/dbspec_introspect_stress_test.php

# dbspec-introspect-rust-check는 같은 round trip과 tests/dbspec/introspect.json의 case를 Rust
# client의 orm::dbspec::introspect로 실행하고, 모든 집합에서 catalog query 8, 7, 3개를 확인한다.
.PHONY: dbspec-introspect-rust-check
dbspec-introspect-rust-check:
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --test dbspec_introspect -- --nocapture

# dbspec-plan-check는 tests/dbspec/plans.json의 모든 case를 MySQL, PostgreSQL, SQLite에
# 적용하고 introspect한 schema text가 plan의 target과 같기를 요구한다(docs/plans.md
# "Verification").
.PHONY: dbspec-plan-check
dbspec-plan-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^TestPlanApply$$' -count=1 -timeout 10m -v

# dbspec-apply-check는 plan chain을 MySQL, PostgreSQL, SQLite에 history, 두 번째 apply, drift,
# lock, rollback, 아무것도 풀지 않은 unlock, 검증, MySQL recovery와 함께 적용한다
# (docs/plans.md "Apply").
.PHONY: dbspec-apply-check
dbspec-apply-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^TestApplyChain$$' -count=1 -timeout 10m -v

# dbspec-apply-pairs-check는 TypeScript client와 Rust apply runner를 build하고,
# tests/dbspec/apply의 Go, PHP, TypeScript, Rust runner의 모든 순서쌍마다 MySQL, PostgreSQL,
# SQLite에서 chain의 첫 plan을 한 client로, 나머지를 다른 client로 적용하며, MySQL에서는 첫
# client가 멈춘 plan을 둘째 client가 마친다. history row와 introspect한 schema text가 chain의
# 것과 같아야 한다.
.PHONY: dbspec-apply-pairs-check
dbspec-apply-pairs-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p orm --example dbspec_apply
	$(WITH_TEST_ENV) DBSPEC_APPLY_RUST=clients/rust/target/release/examples/dbspec_apply go test -tags physical ./tests/dialects -run '^TestApplyChainAcrossClients$$' -count=1 -timeout 10m -v

# dbspec-apply-rust-check는 같은 chain scenario를 Rust client의 orm::dbspec::apply와
# orm::dbspec::recover로 적용한다.
.PHONY: dbspec-apply-rust-check
dbspec-apply-rust-check:
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --test dbspec_apply -- --nocapture

# dbspec-plan-ts-check는 TypeScript client를 build하고 tests/dbspec/plans.json의 모든 case를
# 그 renderDbspec, planStatements, introspectDbspec으로 MySQL, PostgreSQL, SQLite에 적용한다.
.PHONY: dbspec-plan-ts-check
dbspec-plan-ts-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(WITH_TEST_ENV) node --test clients/typescript/tests/dbspec-plan-physical.mjs

# dbspec-apply-ts-check는 TypeScript client를 build하고 dbspec-apply-check의 plan chain을 그
# applyPlans와 recoverPlans로 같은 history, drift, lock, rollback, 검증, MySQL recovery run과
# 함께 적용한다.
.PHONY: dbspec-apply-ts-check
dbspec-apply-ts-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(WITH_TEST_ENV) node --test clients/typescript/tests/dbspec-apply-physical.mjs

# dbspec-plan-rust-check는 같은 case를 Rust client의 plan statement, renderer,
# orm::dbspec::introspect로 적용한다.
.PHONY: dbspec-plan-rust-check
dbspec-plan-rust-check:
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --test dbspec_plan_apply -- --nocapture

# dbspec-plan-php-check는 같은 case를 PHP client의 Orm\Dbspec\Dbspec::planStatements와
# Dbspec::introspect로 적용한다.
.PHONY: dbspec-plan-php-check
dbspec-plan-php-check:
	$(WITH_TEST_ENV) php clients/php/tests/dbspec_plan_apply_test.php

# dbspec-apply-php-check는 dbspec-apply-check의 scenario를 PHP client의
# Orm\Dbspec\Dbspec::apply와 Dbspec::recover로 MySQL, PostgreSQL, SQLite에서 실행한다.
.PHONY: dbspec-apply-php-check
dbspec-apply-php-check:
	$(WITH_TEST_ENV) php clients/php/tests/dbspec_apply_test.php

# dbspec-introspect-compare-check는 2000 table stress 문서를 MySQL, PostgreSQL, SQLite에
# 적용하고, database마다 tests/dbspec/introspect의 Go, PHP, TypeScript, Rust introspection
# runner를 실행해 같은 출력, source schema text, 미지원 객체 없음, 각 introspection의 budget
# 준수를 요구한다.
.PHONY: dbspec-introspect-compare-check
dbspec-introspect-compare-check:
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT))
	node tests/dbspec/stress.mjs > $(DBSPEC_STRESS_DOCUMENT)
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p orm --example dbspec_introspect
	$(WITH_TEST_ENV) DBSPEC_STRESS_DOCUMENT=$(DBSPEC_STRESS_DOCUMENT) DBSPEC_INTROSPECT_RUST=clients/rust/target/release/examples/dbspec_introspect go test -tags physical ./tests/dialects -run '^TestIntrospectCompare$$' -count=1 -timeout 30m -v

# dbspec-compare-check는 Go, PHP, TypeScript, Rust dbspec runner를 tests/dbspec/cases.json,
# stress 문서, tests/dbspec/ddl.json, tests/dbspec/plans.json, tests/dbspec/mermaid.json으로
# 각각 두 번 실행하고, 두 run의 출력이 처음 다른 case에서 실패한다. 그 전에 모든 runner가
# section이나 field를 빼거나 type을 바꾼 vector를 위치를 밝힌 error로 거부해야 하고, compare,
# apply, Rust stress runner가 없거나 directory인 input을 그 경로와 함께 거부해야 한다.
.PHONY: dbspec-compare-check
dbspec-compare-check:
	node --test tests/dbspec/compare/check.test.mjs
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT))
	node tests/dbspec/stress.mjs > $(DBSPEC_STRESS_DOCUMENT)
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p orm-schema --example dbspec_compare --example dbspec_stress
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p orm --example dbspec_apply
	DBSPEC_STRESS_DOCUMENT=$(DBSPEC_STRESS_DOCUMENT) node --test tests/dbspec/compare/runners.test.mjs
	DBSPEC_STRESS_DOCUMENT=$(DBSPEC_STRESS_DOCUMENT) node --test tests/dbspec/inputs.test.mjs
	node tests/dbspec/compare/check.mjs tests/dbspec/cases.json $(DBSPEC_STRESS_DOCUMENT) tests/dbspec/ddl.json tests/dbspec/plans.json tests/dbspec/mermaid.json

dbspec-rust-check:
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT))
	node tests/dbspec/stress.mjs > $(DBSPEC_STRESS_DOCUMENT)
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test dbspec --test dbspec_rules --test dbspec_manifest --test dbspec_render --test dbspec_runtime --test dbspec_plan --test dbspec_model --test dbspec_mermaid -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm-schema --test dbspec --test dbspec_rules --test dbspec_manifest --test dbspec_render --test dbspec_runtime --test dbspec_plan --test dbspec_model --test dbspec_mermaid -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --test dbspec_apply_cleanup -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --test dbspec_apply_cleanup -- --nocapture
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) run --release --locked --offline -p orm-schema --example dbspec_stress -- $(abspath $(DBSPEC_STRESS_DOCUMENT))
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) run --release --locked --offline -p orm-schema --example dbspec_stress -- $(abspath $(DBSPEC_STRESS_DOCUMENT))

.PHONY: rust-send-savepoint-check
rust-send-savepoint-check:
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) clippy --locked --offline -p orm --lib -- -D warnings
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --lib tx::send_tests:: -- --nocapture
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --lib tx::send_tests:: -- --nocapture

.PHONY: dbspec-php-check
# dbspec-php-check는 공유 dbspec vector, PHP rule, tests/dbspec/ddl.json의 statement vector,
# tests/dbspec/plans.json의 plan vector, tests/dbspec/mermaid.json의 Mermaid vector, 감싼 SQLite
# connection으로 주입한 apply 정리 error, tests/dbspec/stress.mjs의 stress 문서를 각각 두 번
# 실행한다. stress test는 parse와 emit 시간, 최대 memory를 출력한다.
dbspec-php-check:
	php clients/php/tests/dbspec_test.php
	php clients/php/tests/dbspec_test.php
	php clients/php/tests/dbspec_rules_test.php
	php clients/php/tests/dbspec_rules_test.php
	php clients/php/tests/dbspec_manifest_test.php
	php clients/php/tests/dbspec_manifest_test.php
	php clients/php/tests/dbspec_render_test.php
	php clients/php/tests/dbspec_render_test.php
	php clients/php/tests/dbspec_plan_test.php
	php clients/php/tests/dbspec_plan_test.php
	php clients/php/tests/dbspec_mermaid_test.php
	php clients/php/tests/dbspec_mermaid_test.php
	php clients/php/tests/dbspec_apply_cleanup_test.php
	php clients/php/tests/dbspec_apply_cleanup_test.php
	php clients/php/tests/dbspec_stress_test.php
	php clients/php/tests/dbspec_stress_test.php

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
	go test ./engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s
	go test ./clients/go/orm -run '^$$' -fuzz FuzzDecodeCiphertext -fuzztime=1s

client-unit-check:
	php clients/php/tests/dsn.php && php clients/php/tests/relation_keys.php && php clients/php/tests/hostcodec.php && php clients/php/tests/engine_test.php && php clients/php/tests/runtime_model_test.php && php clients/php/tests/orm_gen_test.php

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

# ts-model-check builds the TypeScript client, then fails when the models
# script scans a source that does not call models or misses one that does,
# or when the committed src/models/models.ts differs from its output.
ts-model-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	node --test clients/typescript/tests/models-scan.mjs

perf-check:
	$(WITH_TEST_ENV) ./scripts/perf-test.sh

ts-check:
	npm run typescript:check && $(WITH_TEST_ENV) npm run typescript:test

# ts-min-check runs the TypeScript tests on the lowest Node release that
# package.json supports.
ts-min-check:
	$(WITH_TEST_ENV) PATH="$$(./scripts/typescript/node-min.sh):$$PATH" && export PATH && node --version && npm run typescript:test

# dbspec-ts-check는 TypeScript client를 build하고, 공유 dbspec vector, plan vector, Mermaid
# vector, apply 정리 error, 그것들이 아직 다루지 않는 rule을 실행한 뒤, tests/dbspec/stress.mjs의
# stress 문서를 두 번 parse하고 emit하며 두 시간을 출력한다.
.PHONY: dbspec-ts-check
dbspec-ts-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	node --test clients/typescript/tests/dbspec.mjs clients/typescript/tests/dbspec-rules.mjs clients/typescript/tests/dbspec-render.mjs clients/typescript/tests/dbspec-plan.mjs clients/typescript/tests/dbspec-mermaid.mjs clients/typescript/tests/dbspec-apply-cleanup.mjs
	node --test clients/typescript/tests/dbspec-stress.mjs
	node --test clients/typescript/tests/dbspec-stress.mjs

# dbspec-go-check는 Go dbspec engine으로 tests/dbspec/cases.json의 공유 vector, 자기 rule case,
# node tests/dbspec/stress.mjs가 쓰는 stress 문서, manifest, statement, plan, comparison,
# Mermaid vector, apply 정리 error, case harness를 실행하고, 모든 vector file의 빠지거나 type이
# 틀린 field를 위치와 함께 거부하는지 확인하며, parse와 emit 시간을 기록한다.
.PHONY: dbspec-go-check
dbspec-go-check:
	go test ./engine/dbspec -run '^(TestSharedVectors|TestRuleDiagnostics|TestEncodingAndLimitDiagnostics|TestCanonicalForms|TestParseReturnsModel|TestStressDocument|TestManifestVectors|TestManifestRejectsRepeatedDocumentName|TestRenderVectors|TestDocumentSets|TestPlanVectors|TestPlanChains|TestPlanParseErrors|TestCompareSchemas|TestVectorLoadersRejectMalformedVectors|TestMermaidVectors|TestApplyReportsCleanupErrors|TestMySQLEffectRequiresRow|TestCaseHarnessReportsOnlyFailure)$$' -count=1 -v

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
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo clippy --locked -p orm-build --all-targets --features live-db -- -D warnings

rust-driver-check:
	cd bench/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo check --locked --bin driver_compare
	cd bench/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo test --locked --test dsn

typescript-build:
	npm run typescript:build

git-check:
	node --test scripts/git/check.test.mjs
	node scripts/git/check.mjs
