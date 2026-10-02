.PHONY: check checklist-check ts-min-check client-unit-check php-without-mysql-check client-db-check client-pooler-check conformance-check dialect-facts-check conformance-counter-check conformance-result-check conformance-result-physical-check conformance-rust-group-check group-rows-physical-check unselected-column-physical-check decimal-bench-sqlite decimal-db-setup decimal-physical-check perf-check interface-check go-model-check ts-model-check ts-check typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check example-check timing-check fuzz-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check feature-check feature-docs package-check git-check test-servers test-servers-stop
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

check: checklist-check feature-check git-check docs-rules-check docs-check docs-verify-idempotent interface-check go-model-check client-unit-check php-without-mysql-check ts-check ts-min-check rust-check go-fmt-check rust-fmt-check rust-150-check rust-driver-check example-check timing-check client-db-check client-pooler-check dialect-facts-check conformance-check perf-check package-check dbspec-go-check dbspec-php-check dbspec-ts-check dbspec-rust-check dbspec-compare-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-rust-check dbspec-introspect-compare-check dbspec-plan-check dbspec-apply-check dbspec-plan-ts-check dbspec-plan-rust-check ts-model-check dbspec-plan-php-check dbspec-apply-php-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check
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
DBSPEC_STRESS_DOCUMENT = clients/rust/target/dbspec/stress.dbs
.PHONY: dbspec-rust-check
# dbspec-ddl-check는 tests/dbspec/ddl.json의 모든 vector를 TEST_ENV의 MySQL, PostgreSQL,
# SQLite에 적용해 behavior step을 실행하고, 모든 schema/*.dbs와 contracts/fixtures/*.dbs의
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

# dbspec-plan-check는 tests/dbspec/plans.json의 모든 case의 step을 MySQL, PostgreSQL, SQLite에
# 적용해 plan의 target을, rollback statement로 source를, 다시 적용해 target을, finalize 뒤 target과
# 숨긴 이름 없음을 요구한다(docs/plans.md "Verification").
.PHONY: dbspec-plan-check
dbspec-plan-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^TestPlanApply$$' -count=1 -timeout 10m -v

# dbspec-apply-check는 plan chain을 MySQL, PostgreSQL, SQLite에 history, 두 번째 apply, drift,
# lock, 아무것도 풀지 않은 unlock, 검증, representative plan의 모든 step 뒤 중단에서 recover와
# rollback, 그사이 쓴 row, null 검사, finalize와 함께 적용하고, 2000 table 문서를 첫 plan으로
# 세 database에 적용한다(docs/plans.md "Apply", "Verification"). 2000 table plan은 MySQL에서
# statement와 history step 22000개씩을 따로 commit하므로 기한이 길다.
.PHONY: dbspec-apply-check
dbspec-apply-check:
	$(WITH_TEST_ENV) go test -tags physical ./tests/dialects -run '^(TestApplyChain|TestApplyStressPlan)$$' -count=1 -timeout 70m -v

# dbspec-apply-pairs-check는 TypeScript client와 Rust apply runner를 build하고,
# tests/dbspec/apply의 Go, PHP, TypeScript, Rust runner의 모든 순서쌍마다 MySQL, PostgreSQL,
# SQLite에서 chain의 첫 plan을 한 client로, 나머지를 다른 client로 적용하고, 첫 client가 멈춘
# plan을 둘째 client가 recover로 마치며, 다시 멈춘 plan을 둘째 client가 rollback한다. history
# row와 introspect한 schema text가 chain의 것과 같아야 한다.
.PHONY: dbspec-apply-pairs-check
dbspec-apply-pairs-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p orm --example dbspec_apply
	$(WITH_TEST_ENV) DBSPEC_APPLY_RUST=clients/rust/target/release/examples/dbspec_apply go test -tags physical ./tests/dialects -run '^TestApplyChainAcrossClients$$' -count=1 -timeout 10m -v

# dbspec-apply-rust-check는 2000 table plan을 뺀 dbspec-apply-check의 scenario를 Rust client의
# orm::dbspec::apply, recover, rollback, finalize로 실행한다.
.PHONY: dbspec-apply-rust-check
dbspec-apply-rust-check:
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --test dbspec_apply -- --nocapture

# dbspec-plan-ts-check는 TypeScript client를 build하고 tests/dbspec/plans.json의 모든 case를
# 그 renderDbspec, planSteps, introspectDbspec으로 MySQL, PostgreSQL, SQLite에 적용한다.
.PHONY: dbspec-plan-ts-check
dbspec-plan-ts-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(WITH_TEST_ENV) node --test clients/typescript/tests/dbspec-plan-physical.mjs

# dbspec-apply-ts-check는 TypeScript client를 build하고 2000 table plan을 뺀 dbspec-apply-check의
# scenario를 그 applyPlans, recoverPlans, rollbackPlans, finalizePlans로 실행한다.
.PHONY: dbspec-apply-ts-check
dbspec-apply-ts-check:
	node clients/typescript/node_modules/typescript/bin/tsc -p clients/typescript/tsconfig.build.json
	$(WITH_TEST_ENV) node --test clients/typescript/tests/dbspec-apply-physical.mjs

# dbspec-plan-rust-check는 같은 case를 Rust client의 plan step, renderer,
# orm::dbspec::introspect로 적용한다.
.PHONY: dbspec-plan-rust-check
dbspec-plan-rust-check:
	$(WITH_TEST_ENV) cd clients/rust && cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p orm --test dbspec_plan_apply -- --nocapture

# dbspec-plan-php-check는 같은 case를 PHP client의 Orm\Dbspec\Dbspec::planSteps와
# Dbspec::introspect로 적용한다.
.PHONY: dbspec-plan-php-check
dbspec-plan-php-check:
	$(WITH_TEST_ENV) php clients/php/tests/dbspec_plan_apply_test.php

# dbspec-apply-php-check는 2000 table plan을 뺀 dbspec-apply-check의 scenario를 PHP client의
# Orm\Dbspec\Dbspec::apply, recover, rollback, finalize로 MySQL, PostgreSQL, SQLite에서 실행한다.
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

# php-without-mysql-check는 pdo_mysql이 없는 공식 PHP image에서 PHP client를 SQLite로 실행한다(N17).
php-without-mysql-check:
	./scripts/php-without-mysql.sh

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
	go test ./engine/dbspec -run '^(TestSharedVectors|TestFileVectors|TestRuleDiagnostics|TestEncodingAndLimitDiagnostics|TestCanonicalForms|TestParseReturnsModel|TestStressDocument|TestManifestVectors|TestManifestRejectsRepeatedDocumentName|TestRenderVectors|TestDocumentSets|TestPlanVectors|TestPlanChains|TestPlanParseErrors|TestCompareSchemas|TestVectorLoadersRejectMalformedVectors|TestMermaidVectors|TestApplyReportsCleanupErrors|TestMySQLEffectRequiresRow|TestCaseHarnessReportsOnlyFailure)$$' -count=1 -v

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
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo clippy --locked -p orm --all-targets --features test-faults -- -D warnings

# rust-driver-check는 bench/rust의 native와 driver_compare를 DSN 없이 실행해 거부를 확인하고,
# 시드된 bench database에서 한 번에 하나씩 실행해 모든 workload가 끝나는지 확인한다.
rust-driver-check:
	$(WITH_TEST_ENV) cd bench/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo test --locked --offline -- --test-threads=1

# example-check는 examples/complex와 examples/thin-slice의 Go, PHP, Rust 프로그램을 시드된
# bench database에서 실행하고 README의 diff처럼 stdout이 byte 단위로 같은지 비교한다.
example-check:
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo build --release --locked --offline -p orm-tests --bin complex --bin demo
	$(WITH_TEST_ENV) EXAMPLE_RUST_COMPLEX=$(abspath clients/rust/target/release/complex) EXAMPLE_RUST_DEMO=$(abspath clients/rust/target/release/demo) go test -tags examples ./examples -run '^TestExampleOutputsAreIdentical$$' -count=1 -timeout 10m -v

# timing-check는 자기 계산에 시간 제한을 두는 Go, Rust, PHP, TypeScript test를 process group이
# 4분의 1만 CPU를 받도록 멈추며 실행하고, 각 제한이 CPU 시간을 재서 그대로 통과하는지 확인한다.
TIMING_GO_DBSPEC_TEST = .runtime/timing/dbspec.test
timing-check:
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT)) $(dir $(TIMING_GO_DBSPEC_TEST))
	node tests/dbspec/stress.mjs > $(DBSPEC_STRESS_DOCUMENT)
	go test -c -o $(TIMING_GO_DBSPEC_TEST) ./engine/dbspec
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo build --release --locked --offline -p orm-schema --example dbspec_stress
	cd clients/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" cargo test --locked --offline -p orm-schema --no-run
	npm run typescript:build
	PATH="$(HOME)/.cargo/bin:$(PATH)" DBSPEC_STRESS_DOCUMENT=$(abspath $(DBSPEC_STRESS_DOCUMENT)) TIMING_GO_DBSPEC_TEST=$(abspath $(TIMING_GO_DBSPEC_TEST)) TIMING_RUST_STRESS=$(abspath clients/rust/target/release/examples/dbspec_stress) node --test --test-concurrency=1 tests/timing/preempted.test.mjs

typescript-build:
	npm run typescript:build

git-check:
	node --test scripts/git/check.test.mjs
	node scripts/git/check.mjs
