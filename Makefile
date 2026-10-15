.PHONY: check check-run databases-create ci-group-needs feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check runner-check version-check repo-check ts-min-check php-min-check client-unit-check php-without-mysql-check client-db-check client-pooler-check case-database-check conformance-check dialect-facts-check conformance-counter-check conformance-result-check conformance-result-physical-check conformance-rust-group-check group-rows-physical-check unselected-column-physical-check decimal-bench-sqlite decimal-physical-check run-databases perf-check interface-check go-model-check ts-model-check ts-check scripts-typecheck typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check example-check timing-check fuzz-check docs-dev docs-build docs-check docs-verify-idempotent docs-rules-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check install-cli-check feature-unit-check feature-check feature-coverage feature-verify-rust feature-verify-other feature-docs package-check test-servers test-servers-tls test-servers-stop test-servers-leases test-servers-leases-clear
# 실패에서 멈추지 않는 target의 독립된 부분이다(scripts/check/run.mts가 make -k로 실행한다).
.PHONY: version-check/unit version-check/run repo-check/unit repo-check/run rust-fmt-check/clients rust-fmt-check/bench rust-fmt-check/interfaces fuzz-check/engine-ir fuzz-check/clients-go-orm dialect-facts-check/probes dialect-facts-check/facts feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select testcase-check/go testcase-check/node testcase-check/runners testcase-check/rust rust-check/check rust-check/clippy rust-check/clippy-live-db rust-check/clippy-test-faults ts-check/hold ts-check/types ts-check/test feature-check/build client-unit-check/dsn client-unit-check/markdown client-unit-check/relation-keys client-unit-check/hostcodec client-unit-check/codec-aes client-unit-check/engine client-unit-check/runtime-model client-unit-check/orm-gen client-unit-check/model-methods client-unit-check/orm-gen-scan client-unit-check/orm-gen-scan-parity client-unit-check/client-generics client-unit-check/perf-extensions
.NOTPARALLEL: check check-run docs-check docs-verify-idempotent

# git runs the tracked hooks (.githooks/commit-msg, .githooks/pre-push) only when core.hooksPath is .githooks, a setting of
# each clone, which the kit.mk of @polyspec/kit sets at parse time on every make run. Each hook runs a make target: the
# commit-msg hook runs commit-msg-check, which checks the message being committed against config/commits.json and refuses
# a commit that breaks it, and the pre-push hook runs push-gate-hook, the push gate of kit, which refuses a push while a
# checklist item is [~] (AGENTS.md). make hooks sets the setting and hooks-check checks it.

# make test-servers starts the MySQL and PostgreSQL primaries, their replicas,
# and the ProxySQL and PgBouncer poolers of the database checks on free ports that it chooses
# and writes TEST_ENV; the database checks read TEST_ENV and fail when it is
# missing.
TEST_ENV = .runtime/servers/env
# ORM_TEST_ENV는 이 make가 읽는 TEST_ENV의 절대 경로이며, DECIMAL_ENV처럼 recipe가 시작하는 process에
# 넘긴다. make 변수는 command line으로만 Makefile의 값을 바꾸므로, 하위 make를 시작하는 명령(contracts/
# features.json의 helper check)은 이것을 TEST_ENV="$$ORM_TEST_ENV"로 준다. make owner-check
# (scripts/features/owners.mts)는 자기 실행의 환경 file로 이것을 바꾼다.
export ORM_TEST_ENV = $(abspath $(TEST_ENV))
# DECIMAL_ENV는 decimal database의 DSN을 담은 file이다. decimal 검사와 feature-check의 decimal 명령이
# 그것을 읽는다. 함께 쓰는 decimal database는 없다: make check, make owner-check, make run-databases가
# 실행마다 자기 database와 file을 만들어(scripts/check/databases.mts) 이 변수와 TEST_ENV로 준다. bench
# database의 DSN(BENCH_*, ORM_BENCH_MYSQL_DSN)도 그 실행의 TEST_ENV에만 있다.
DECIMAL_ENV =
export DECIMAL_ENV

# 모든 cargo 명령(cargo +$(PHYSICAL_RUST_TOOLCHAIN), PATH의 cargo, feature coverage와 conformance
# check가 실행하는 cargo)은 한 toolchain과 한 target directory를 쓴다. toolchain이나 target이
# 둘이면 같은 crate를 다시 compile하고 target이 커진다(T27 측정: check 한 번에 packages/rust/target
# 10.4 GiB와 benchmarks/rust/target 1.4 GiB).
# check는 한 번 build한 artifact를 실행하므로 incremental compile의 중간 결과(T27 측정: debug
# target 7.9 GiB 가운데 1.6 GiB)를 남기지 않고, debug build의 debug 정보는 panic과 backtrace의
# 줄 번호만 둔다.
# 그 toolchain은 rust-toolchain.toml의 channel 하나이고, CI도 그 file로 설치한다.
PHYSICAL_RUST_TOOLCHAIN := $(shell sed -n 's/^channel = "\(.*\)"$$/\1/p' rust-toolchain.toml)
export RUSTUP_TOOLCHAIN := $(PHYSICAL_RUST_TOOLCHAIN)
export CARGO_TARGET_DIR := $(abspath packages/rust/target)
# target directory는 이 checkout 안에 있다(AGENTS.md). cargo는 artifact가 fresh인지를
# source file의 경로(package root 기준)와 mtime으로만 판단하고 어느 checkout이 build했는지는 기록하지 않으므로,
# 다른 checkout의 target directory를 쓰면 그 checkout이 build한 code를 이 checkout의 것으로 test한다. command
# line의 CARGO_TARGET_DIR이 이 checkout 밖을 가리키면 make는 아무것도 실행하지 않고 멈춘다.
ifeq ($(filter $(abspath .)/%,$(abspath $(CARGO_TARGET_DIR))),)
$(error CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) is outside this checkout $(abspath .); each checkout builds Rust into its own target directory (AGENTS.md), because cargo would reuse what another checkout built as fresh)
endif
export CARGO_INCREMENTAL := 0
export CARGO_PROFILE_DEV_DEBUG := line-tables-only
# ORM_RUST_TEST_FEATURES는 Rust test가 쓰는 feature다. 모든 cargo test 명령(client DB test,
# feature coverage와 검증 명령, dbspec Rust check)은 `--workspace --features
# $(ORM_RUST_TEST_FEATURES)`로 의존성 feature를 같게 정해 test build 하나를 함께 쓰고, `--test`와
# 이름 filter로 자기 test만 실행한다. `-p`로 package를 고르면 feature가 달라져 같은 crate를 다시
# compile한다. test-faults는 fault 주입 module만 더하고, live-db는 polyspec-orm-tests의 dev-dependency가
# 이미 켜는 feature다.
export ORM_RUST_TEST_FEATURES := polyspec-orm/test-faults,polyspec-orm-build/live-db
# check는 network를 읽지 않는다: make install이 check가 읽는 것을 download하고, 모든 recipe와 그것이 시작하는
# script는 cargo, go, npm, Composer를 offline으로 실행한다. 그래서 빠진 download는 registry에 닿는 실행과 닿지 않는
# 실행으로 결과가 갈리지 않고 곧바로 실패하며, scripts/check/downloads.mts가 그것을 `run make install`과 함께 적는다.
# download하는 target(install과 그 부분)만 $(ONLINE)으로 명령을 실행한다.
export CARGO_NET_OFFLINE := true
export GOPROXY := off
export npm_config_offline := true
export COMPOSER_DISABLE_NETWORK := 1
ONLINE := env -u CARGO_NET_OFFLINE -u GOPROXY -u npm_config_offline -u COMPOSER_DISABLE_NETWORK
# The targets of the shared tools come from the npm package @polyspec/kit: scripts/kit/kit-bootstrap.mk, a copy that make
# kit-sync writes, includes the kit.mk of the installed package, whose tools run as node $(KIT)/<tool>.$(KIT_EXT). A fresh
# checkout first runs make install-tools TOOLS=npm and make install-packages, the two targets that run before the package
# is installed.
include scripts/kit/kit-bootstrap.mk

# commit-msg-check is the commit-msg hook: it checks the message file MESSAGE that git is about to commit.
.PHONY: commit-msg-check
commit-msg-check:
	@test -n "$(MESSAGE)" || { echo "commit-msg-check: MESSAGE is missing; git gives the hook .githooks/commit-msg the message file, which passes it as MESSAGE"; exit 2; }
	node $(KIT)/check-commits.$(KIT_EXT) --message "$(MESSAGE)"
# WITH_TEST_ENV는 TEST_ENV를 읽는다. pooler를 거치지 않는 server DSN ORM_TEST_MYSQL_SERVER_DSN과
# ORM_TEST_POSTGRES_SERVER_DSN도 TEST_ENV가 정의한다(make 밖의 go test도 같은 file을 읽는다).
# client-pooler-check가 ORM_TEST_*_DSN을 pooler DSN으로 바꾸어도 rollback 실패 case는 이 DSN으로
# server에서 transaction의 session을 끝낸다. ProxySQL은 text protocol의 KILL을 자기 client session의
# 명령으로 가로채기 때문이다.
# WITH_TEST_ENV는 또 이 줄의 shell이 끝날 때까지 server의 shared lease(tests/lease)를 가진다. lease
# directory는 TEST_ENV의 ORM_TEST_SERVERS_LEASES다. 서버의 정지, 새 시작, MySQL migration은 exclusive
# lease를 요구하므로 이 줄이 실행되는 동안 거부되고, 보유자로 이 줄을 적는다.
# WITH_TEST_ENV는 마지막으로 database client를 실행하는 process의 시간대를 TEST_TZ로 정한다: TZ를 export하고,
# TZ를 읽지 않는 PHP에는 date.timezone을 ${TZ}로 정하는 tests/timezone/date.ini를 PHP_INI_SCAN_DIR의 앞
# 구분자 뒤에 더한다(PHP의 기본 scan directory는 그대로 읽힌다).
WITH_TEST_ENV = test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make test-servers" >&2; exit 1; }; . $(abspath $(TEST_ENV)) && $(BUILD_LEASE) && "$(LEASE)" hold "$${ORM_TEST_SERVERS_LEASES:?$(abspath $(TEST_ENV)) names no lease directory; run make test-servers to rewrite it}" shared --pid $$$$ && export TZ=$(TEST_TZ) PHP_INI_SCAN_DIR=:$(abspath tests/timezone) &&
# TEST_TZ는 database client를 실행하는 검사의 process 시간대다. UTC가 아닌 시간대로 실행해야 client가 database의
# 시간대 없는 datetime을 process의 지역 시각으로 읽는 결함이 UTC인 CI runner에서도 드러난다. 모든 client는 연결의
# 시간대(+00:00)로 읽고 쓰므로 결과는 이 값과 무관해야 한다(docs/dialects.md).
TEST_TZ = Asia/Seoul

# GO_TEST는 Go test를 case마다 보고하게 실행한다. tests/go-test.mts는 먼저 같은 package와 build
# tag의 build를 기한 없는 장기 작업 `go-build/<packages>`로 실행하고 그 뒤 go test를 실행한다. -v는 각
# case가 packages/go/testcase로 내는 RUN, STEP, PASS, FAIL 줄을 실행 중에 보이고, 각 case가 자기 기한을
# 가지므로 -timeout 0이 test binary 전체의 기한(기본 10분)을 끈다.
GO_TEST = node tests/go-test.mts -v -timeout 0

# RUN_LONG은 자기 case를 보고하지 않는 장기 작업(build, 설치, format, lint, package 검사 같은 도구 실행)
# 하나를 기한 없이 실행한다(tests/run-long.mts): `RUN <name> no-deadline`, 명령의 출력 줄을 STEP으로,
# 종료 코드와 PASS나 FAIL을 출력한다. 성공과 실패는 시계가 아니라 명령의 종료 코드와 오류로 정한다.
# 기한은 test case 안에만 있다.
RUN_LONG = node tests/run-long.mts
# PUBLISH는 다른 실행이나 뒤의 단계가 읽는 build 출력 file을 같은 directory의 임시 file에 쓰고 rename으로
# 바꾼다(scripts/publish-output.mts): `$(PUBLISH) <output> <command>`에서 명령의 인자 @OUT@이 임시 file이고,
# @OUT@이 없으면 명령의 표준 출력이 임시 file이다. 읽는 쪽은 끝난 build의 file만 본다.
PUBLISH = node $(abspath scripts/publish-output.mts)
# LEASE는 여러 실행이 함께 쓰는 test 자원의 보유를 다루는 program이다(tests/lease). 그 build는 장기
# 작업이므로 RUN_LONG으로 기한 없이 실행한다.
LEASE = $(abspath .runtime/bin/lease)
BUILD_LEASE = $(RUN_LONG) go-build/lease -- $(PUBLISH) $(LEASE) go build -o @OUT@ ./tests/lease
# CARGO_LEASED는 cargo의 build를 Rust target directory(CARGO_TARGET_DIR, 이 checkout의 동시 실행이 함께 쓴다)의
# exclusive lease 아래에서 실행한다. 이 checkout의 다른 실행의 build가 lease를 가지면 directory 변경 알림을
# 기다린다(--wait). build는 cargo의 자기 lock 때문에 어차피 하나씩 실행된다.
CARGO_LEASES = $(CARGO_TARGET_DIR)/.leases
CARGO_LEASED = $(LEASE) run $(CARGO_LEASES) exclusive --wait --
# script와 기능 검증 명령도 같은 lease program과 lease directory를 쓴다.
export LEASE CARGO_LEASES
# CARGO_TEST는 cargo test를 공유 target directory의 test binary가 아니라 lease 아래에서 복사한 실행 하나의
# binary로 실행한다(tests/cargo-test.mts: build와 복사, 그 다음 실행).
CARGO_TEST = node $(abspath tests/cargo-test.mts)
# RUN_DIR은 target 실행 하나의 directory다($@와 make process id). 그 실행이 쓰는 stress 문서와 build한
# program의 복사본(RUN_TARGET, CARGO_TARGET_DIR과 같은 배치)을 둔다. 실행은 공유 target directory의
# program이 아니라 이 복사본을 실행한다. CARGO_COPY는 build와 복사를 한 lease 아래에서 한다
# (scripts/cargo-build-copy.mts). target은 끝에 RUN_DIR을 지운다.
RUN_DIR = $(abspath .runtime/run)/$@-$$PPID
RUN_TARGET = $(RUN_DIR)/target
CARGO_COPY = $(CARGO_LEASED) node $(abspath scripts/cargo-build-copy.mts) $(RUN_TARGET)
# HOLD_TYPESCRIPT은 이 checkout의 TypeScript build 출력(packages/ts의 dist와 생성한 model)을 make
# process가 끝날 때까지 하나의 보유자로 가진다. 그 출력을 build하고 쓰는 target은 첫 줄에서 그것을 얻으므로,
# 다른 실행의 build가 쓰는 도중의 출력을 바꾸지 않는다. 다른 실행이 가지면 directory 변경 알림을 기다린다. 조상
# process(make feature-check)가 가지면 그 보유 안에서 얻으므로, 함께 실행되는 기능 단계의 build도 한 번에 하나다.
TYPESCRIPT_LEASES = $(abspath .runtime/typescript.leases)
HOLD_TYPESCRIPT = $(LEASE) hold $(TYPESCRIPT_LEASES) exclusive --wait --pid $$PPID
# READ_TYPESCRIPT은 build 출력을 쓰기만 하는 target이 make process 동안 shared lease로 가진다. 읽는 target끼리는
# 함께 실행되고, build하는 target(HOLD_TYPESCRIPT)은 읽는 target이 끝날 때까지 기다린다. 조상 process(하위 make를
# 실행한 make, make owner-check의 기능 단계)가 exclusive를 가지면 그 보유 안에서 얻으므로, 그 조상이 동시에 실행하는
# 하위 target끼리도 같은 규칙으로 서로를 기다린다.
READ_TYPESCRIPT = $(LEASE) hold $(TYPESCRIPT_LEASES) shared --wait --pid $$PPID
export TYPESCRIPT_LEASES
# SEND_SQLITE_DSN은 rust-send-savepoint-check의 SQLite file이다. 실행 하나의 RUN_DIR에 둔다.
SEND_SQLITE_DSN = sqlite://$(RUN_DIR)/send-savepoint.sqlite

.PHONY: lease-tool
lease-tool:
	$(BUILD_LEASE)
TSC_BUILD = $(RUN_LONG) typescript-build -- node scripts/typescript/build.mts

# check는 CHECK_TARGETS를 scripts/check/run.mts로 하나씩 실행한다. runner는 실행마다 자기 bench
# database와 decimal database를 만들어 TEST_ENV와 DECIMAL_ENV로 넘기고 끝에 지우며, target마다
# RUN, 출력 줄(STEP), PASS나 FAIL과 경과 시간을 보고한다. 검증 명령이 실행하는
# target(interface-check, php-without-mysql-check, perf-check, dbspec-go-check, dbspec-php-check,
# dbspec-rust-check, dbspec-ts-check, dbspec-compare-check)은 feature-verify-rust나 feature-verify-other 안에서 한 번
# 실행되므로 목록에 다시 넣지 않는다. contracts/check-inputs.json은 target마다 scope를 선언한다: owner target은
# make owner-check도 고르고, suite target은 이 전체 suite에서만 실행한다.
CHECK_TARGETS = runner-check scripts-typecheck documents-check commits-check release-coverage kit-check owner-validate dependency-policy-check dependency-policy-mutation-check version-check testcase-check repo-check test-servers-check docs-rules-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check install-cli-check markdown-table-check docs-check docs-verify-idempotent go-model-check client-unit-check php-min-check ts-check ts-min-check rust-check go-fmt-check go-vet-check rust-fmt-check rust-150-check rust-driver-check example-check client-db-check codec-check fuzz-check client-pooler-check case-database-check dialect-facts-check conformance-check markdown-conformance-check package-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-introspect-python-check dbspec-introspect-compare-check dbspec-plan-check dbspec-apply-check dbspec-plan-ts-check dbspec-plan-rust-check ts-model-check dbspec-language-check dbspec-plan-php-check dbspec-apply-php-check dbspec-apply-php-extension-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check feature-unit-check feature-coverage feature-verify-rust feature-verify-other feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check go-test-check python-check
# CI는 make check를 CI group마다 job 하나로 나눠 동시에 실행한다(.github/workflows/ci.yml의 job test, matrix group).
# job마다 `make check GROUP=<group>`이 CI_TARGETS_<group>을 실행하고, group은 함께 CHECK_TARGETS의 모든 target을 한
# 번씩 실행한다(make repo-check가 확인한다). group은 CI 실행에서 잰 target의 시간으로 job마다 setup과 함께 10분 안에
# 끝나도록 나눈다. 2000 table plan의 MySQL 적용 하나가 그보다 길므로 stress-mysql만 넘는다. 로컬 make check는 GROUP 없이
# 모든 target을 실행한다.
#   static: database가 필요 없는 target
#   clients_db: client의 database test, Rust driver, example, dialect fact와 Go test
#   clients_pooler: pooler를 거친 client의 database test. 그 test build를 자기 job에서 다시 한다
#   conformance: TypeScript client와 conformance runner의 database target
#   dbspec: case database, dbspec DDL, introspection과 plan의 database target
#   dbspec_apply: dbspec plan 적용의 database target
#   feature_coverage, feature_verify_rust, feature_verify_other: feature-check의 세 부분(기능의 coverage, shard rust와
#     other의 검증 명령)
#   feature_helpers: stress helper와 FEATURE_SUITE_HELPERS를 뺀 helper check(feature-helper-check)
#   stress_mysql: 2000 table plan의 MySQL 적용(feature-stress-mysql-check)
#   stress_pg_sqlite: stress 문서의 bench와 PostgreSQL, SQLite 적용(feature-stress-pg-sqlite-check)
CI_GROUPS = static clients_db clients_pooler conformance dbspec dbspec_apply feature_coverage feature_verify_rust feature_verify_other feature_helpers stress_mysql stress_pg_sqlite python
CI_TARGETS_static = runner-check documents-check commits-check release-coverage kit-check owner-validate dependency-policy-check dependency-policy-mutation-check version-check testcase-check repo-check test-servers-check docs-rules-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check install-cli-check markdown-table-check docs-check docs-verify-idempotent go-model-check client-unit-check php-min-check rust-check go-fmt-check go-vet-check rust-fmt-check rust-150-check codec-check fuzz-check package-check ts-model-check dbspec-language-check feature-unit-check
CI_TARGETS_clients_db = rust-driver-check example-check client-db-check dialect-facts-check go-test-check
CI_TARGETS_clients_pooler = client-pooler-check
CI_TARGETS_conformance = ts-check scripts-typecheck ts-min-check conformance-check markdown-conformance-check
CI_TARGETS_feature_helpers = feature-helper-check
CI_TARGETS_python = python-check
CI_TARGETS_dbspec = case-database-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-introspect-python-check dbspec-introspect-compare-check dbspec-plan-check dbspec-plan-ts-check dbspec-plan-rust-check dbspec-plan-php-check
CI_TARGETS_dbspec_apply = dbspec-apply-check dbspec-apply-php-check dbspec-apply-php-extension-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check
CI_TARGETS_feature_coverage = feature-coverage
CI_TARGETS_feature_verify_rust = feature-verify-rust
CI_TARGETS_feature_verify_other = feature-verify-other
CI_TARGETS_stress_mysql = feature-stress-mysql-check
CI_TARGETS_stress_pg_sqlite = feature-stress-pg-sqlite-check
# run-databases는 TARGETS의 make target을 실행 하나의 자기 bench database와 decimal database로 실행한다
# (scripts/check/run.mts, make check-run과 같은 runner). bench나 decimal database를 쓰는 target을 직접 실행할 때
# 쓴다: TEST_ENV의 server 환경에는 그 database가 없다. runner는 MAKEFLAGS를 넘기지 않으므로 conformance-check의
# VECTOR와 RECORD는 환경으로 넘긴다.
# databases-create is the setup step databases/create of the runner (scripts/check/run.mts) and of make owner-check: it
# builds the TypeScript client, whose decimal model installs the decimal database, and holds its shared lease while
# scripts/check/databases.mts reads it.
databases-create: typescript-build
	$(READ_TYPESCRIPT)
	node scripts/check/databases.mts create '$(SERVERS)' '$(DIRECTORY)' '$(NAME)'

run-databases:
	$(BUILD_LEASE) && VECTOR='$(VECTOR)' RECORD='$(RECORD)' node scripts/check/run.mts --job-summary $(abspath $(TEST_ENV)) $(TARGETS)

# check is the guard of the full suite, the full-run tool of @polyspec/kit: it prints the reason and refuses while a checklist
# item is [~], while tracked files have uncommitted changes, or when var/full-run.json records a full run of the same tree;
# otherwise it runs the target check-run with `make -k` and records the result. make rerun-failed (the kit.mk of
# @polyspec/kit) reruns on the same tree the targets that did not pass. The full suite runs on GitHub CI after a push
# (.github/workflows/ci.yml), and a local check is no step required before a push. check-run runs the runner
# (scripts/check/run.mts): each run creates its own bench and decimal databases, runs the targets one by one and writes the
# record of the run to .runtime/check/<id>/record.json. The runner reads TEST_ENV as the setup step servers and holds the
# shared lease of those servers: when the file is missing (make test-servers failed), it records only the targets that need
# a database as not-run and runs the rest.
# GROUP은 CI group 하나(CI_TARGETS_<group>)만 실행한다. 그 실행은 GitHub Actions의 job 하나가 하는 전체 suite의 한
# 부분이므로 GITHUB_ACTIONS가 true일 때만 받는다.
CHECK_RUN_TARGETS = $(if $(GROUP),$(CI_TARGETS_$(GROUP)),$(CHECK_TARGETS))
check:
	node $(KIT)/full-run.$(KIT_EXT) run check-run
check-run:
	$(if $(GROUP),$(if $(filter $(GROUP),$(CI_GROUPS)),,$(error GROUP $(GROUP) names no CI group; give one of CI_GROUPS: $(CI_GROUPS))))
	$(if $(GROUP),$(if $(filter true,$(GITHUB_ACTIONS)),,$(error GROUP runs one CI group of make check-run on GitHub Actions only; run make check without GROUP, which runs every target of CHECK_TARGETS)))
	$(BUILD_LEASE) && node scripts/check/run.mts $(abspath $(TEST_ENV)) $(CHECK_RUN_TARGETS)

# ci-group-needs는 CI group GROUP의 job이 실행할 setup step을 step output 줄(`<output>=true|false`)로 쓴다: group의
# target이 contracts/check-inputs.json에 선언한 need에서 정한다(scripts/check/ci-setup.mts). workflow는 그 줄을
# $GITHUB_OUTPUT에 더하고, setup step은 자기 output이 true일 때만 실행한다.
ci-group-needs:
	$(if $(filter $(GROUP),$(CI_GROUPS)),,$(error GROUP $(GROUP) names no CI group; give one of CI_GROUPS: $(CI_GROUPS)))
	@node scripts/check/ci-setup.mts outputs $(CI_TARGETS_$(GROUP))

# bench는 성능 측정(2000 table stress 문서의 parse, 적용, introspection과 비교, CPU 시간)을 check와 같은
# runner로 target마다 실행한다. 측정은 출력하고 기준값을 넘으면 경고할 뿐 실패시키지 않는다(AGENTS.md).
BENCH_TARGETS = dbspec-stress-bench dbspec-apply-stress-bench dbspec-introspect-compare-bench dbspec-compare-bench timing-check
.PHONY: bench
bench:
	test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make test-servers" >&2; exit 1; }
	node scripts/check/run.mts --job-summary $(abspath $(TEST_ENV)) $(BENCH_TARGETS)

# GO_PACKAGES는 go.work의 세 module(packages/go, tests, examples)의 모든 package다. root는 module이
# 아니므로 root의 ./...는 아무 package도 가리키지 않는다.
GO_PACKAGES = ./packages/go/... ./tests/... ./examples/...

# go-test-check는 다른 target이 실행하지 않는 Go package의 test를 실행한다. packages/go의 client
# package는 client-db-check(scripts/client-db-test.mts), engine과 generator는 feature-check의
# 검증 명령(engine package마다 planner-go-*, packages/go/engine/dbspec은 schema-go의 dbspec-go-check,
# generator는 generation-go), packages/go/testcase는 testcase-check가 같은 명령으로 실행한다.
GO_TEST_CHECK_PACKAGES = $$(go list ./packages/go/cmd/... ./packages/go/procevent/... ./packages/go/internal/... ./tests/... ./examples/...)
.PHONY: go-test-check
go-test-check:
	$(WITH_TEST_ENV) $(GO_TEST) $(GO_TEST_CHECK_PACKAGES)

# testcase-check는 각 언어의 공유 case 보고 형식이 case마다 시작(RUN, 기한), 단계(STEP),
# 결과(PASS, FAIL과 이유)와 경과 시간을 이 순서로 출력하고, 기한이 지난 case를 FAIL로
# 보고하는지 하위 process의 출력으로 확인한다.
.PHONY: testcase-check
testcase-check: testcase-check/go testcase-check/node testcase-check/runners testcase-check/rust
testcase-check/go:
	$(GO_TEST) ./packages/go/testcase -count=1
testcase-check/node:
	node --test tests/testcase.test.mts
testcase-check/runners:
	node --test tests/go-test.test.mts tests/cargo-test.test.mts
testcase-check/rust: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) testcase-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-testcase

# client-pooler-check runs the client database tests through the PgBouncer
# pooler in transaction mode for PostgreSQL and the ProxySQL pooler for MySQL.
client-pooler-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" node scripts/client-db-test.mts

# runner-check는 check runner(scripts/check/run.mts)와 그 실행 기록(scripts/check/record.mts)을 임시 git checkout과 stub 단계로
# 검사한다. 실제 target과 database는 실행하지 않는다.
runner-check:
	node --test scripts/check/run.test.mts scripts/check/continue.test.mts scripts/check/step.test.mts scripts/check/downloads.test.mts scripts/json/schema.test.mts

# dbspec-rust-check는 공유 dbspec vector, Rust rule case, plan과 Mermaid case, 감싼 SQLite
# connection으로 주입한 apply 정리 error를 두 번 실행한다.
#
# DBSPEC_STRESS_DOCUMENT는 tests/dbspec/stress.mts의 2000 table 문서다. 그 문서의 parse 시간,
# 적용, introspection과 비교는 성능 측정이므로 make bench가 실행한다. make check의
# dbspec-compare-check와 dbspec-introspect-compare-check는 같은 모양의 작은 문서
# (DBSPEC_COMPARE_TABLES, DBSPEC_INTROSPECT_TABLES개 table)로 같은 code path를 실행하고, make
# bench는 같은 target을 2000 table로 실행한다.
DBSPEC_STRESS_DOCUMENT = $(RUN_DIR)/stress.dbs
DBSPEC_COMPARE_TABLES ?= 20
DBSPEC_COMPARE_DOCUMENT = $(RUN_DIR)/stress-$(DBSPEC_COMPARE_TABLES).dbs
DBSPEC_INTROSPECT_TABLES ?= 20
DBSPEC_INTROSPECT_DOCUMENT = $(RUN_DIR)/stress-$(DBSPEC_INTROSPECT_TABLES).dbs
# DBSPEC_INTROSPECT_PROFILE은 Rust introspection runner의 cargo profile이다. make check는 test
# build와 의존성을 함께 쓰는 dev, make bench는 introspection 시간을 재는 release다.
DBSPEC_INTROSPECT_PROFILE ?= dev
DBSPEC_INTROSPECT_DIR = $(if $(filter dev,$(DBSPEC_INTROSPECT_PROFILE)),debug,$(DBSPEC_INTROSPECT_PROFILE))
.PHONY: dbspec-rust-check
# dbspec-ddl-check는 tests/dbspec/ddl.json의 모든 vector를 TEST_ENV의 MySQL, PostgreSQL,
# SQLite에 적용해 behavior step을 실행하고, 모든 contracts/fixtures/bench/*.dbs와 contracts/fixtures/*.dbs의
# 렌더링한 statement를 적용한다.
.PHONY: dbspec-ddl-check
dbspec-ddl-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/dialects -run '^(TestDDLVectors|TestSchemaDocumentsApply)$$' -count=1

# dbspec-introspect-check는 tests/dbspec/ddl.json과 모든 schema 문서를 MySQL, PostgreSQL,
# SQLite에 렌더링해 적용하고, 각 database를 introspect해 source schema text를 요구하며,
# tests/dbspec/introspect.json을 실행한다.
.PHONY: dbspec-introspect-check
dbspec-introspect-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/dialects -run '^(TestIntrospectRoundTrip|TestIntrospectUnsupported)$$' -count=1

# dbspec-introspect-ts-check는 TypeScript client를 build하고 dbspec-introspect-check의 round
# trip과 미지원 case를 그 introspectDbspec으로 MySQL, PostgreSQL, SQLite에서 실행한다.
.PHONY: dbspec-introspect-ts-check
dbspec-introspect-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test packages/ts/tests/dbspec-introspect.mjs

# dbspec-introspect-php-check는 같은 round trip과 미지원 case를 PHP client의
# Polyspec\Orm\Dbspec\Dbspec::introspect로 실행한다.
.PHONY: dbspec-introspect-php-check
dbspec-introspect-php-check: php-vendor-check
	$(WITH_TEST_ENV) php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecIntrospectTest.php

# dbspec-introspect-php-extension-check는 같은 round trip과 미지원 case를 PHP 확장 orm_dbspec의
# Polyspec\Orm\Dbspec\Native\Dbspec::introspect로 실행한다. 확장은 이 실행의 directory에 build한다.
.PHONY: dbspec-introspect-php-extension-check
dbspec-introspect-php-extension-check: php-vendor-check
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecIntrospectTest.php
	rm -rf $(RUN_DIR)

# dbspec-introspect-rust-check는 같은 round trip과 tests/dbspec/introspect.json의 case를 Rust
# client의 polyspec_orm::dbspec::introspect로 실행하고, 모든 집합에서 catalog query 8, 7, 3개를 확인한다.
.PHONY: dbspec-introspect-rust-check
dbspec-introspect-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-introspect-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_introspect -- --nocapture

# dbspec-introspect-python-check는 같은 round trip과 미지원 case를 Python client의
# polyspec.orm.dbspec.introspect.introspect_dbspec로 MySQL과 PostgreSQL 서버에서 실행하고(packages/python/tests/dbspec_introspect.py),
# 같은 case를 SQLite file에서도 실행한다. It imports the client installed into the venv, as python-unit-check does.
.PHONY: dbspec-introspect-python-check
dbspec-introspect-python-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_introspect

# dbspec-plan-check는 tests/dbspec/plans.json의 모든 case의 step을 MySQL, PostgreSQL, SQLite에
# 적용해 plan의 target을, rollback statement로 source를, 다시 적용해 target을, finalize 뒤 target과
# 숨긴 이름 없음을 요구한다(docs/plans.md "Verification").
.PHONY: dbspec-plan-check
dbspec-plan-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/dialects -run '^TestPlanApply$$' -count=1

# dbspec-apply-check는 plan chain을 MySQL, PostgreSQL, SQLite에 history, 두 번째 apply, drift,
# lock, 아무것도 풀지 않은 unlock, 검증, representative plan의 모든 step 뒤 중단에서 recover와
# rollback, 그사이 쓴 row, null 검사, finalize와 함께 적용하고, 2000 table 문서를 첫 plan으로
# 세 database에 적용한다(docs/plans.md "Apply", "Verification"). 2000 table plan은 MySQL에서
# statement와 history step 22000개씩을 따로 commit하므로 그 case의 기한이 길다.
.PHONY: dbspec-apply-check
dbspec-apply-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/dialects -run '^(TestApplyChain|TestApplyThroughTransactionPooler)$$' -count=1

# dbspec-apply-stress-bench는 2000 table 문서를 첫 plan으로 APPLY_STRESS_DIALECTS의 database에
# 적용한다(make bench는 셋 모두). MySQL은 statement와 history step 22000개씩을 따로 commit한다.
# APPLY_STRESS_DIALECTS는 `|`로 나눈 database(mysql, postgres, sqlite)이고 TestApplyStressPlan의 subtest를 고른다. 그래서
# CI는 가장 긴 MySQL 적용을 PostgreSQL, SQLite와 다른 group에서 실행한다(feature-stress-mysql-check,
# feature-stress-pg-sqlite-check). database가 아닌 이름이나 빈 값은 subtest를 하나도 고르지 않고 통과하므로 make가 명령
# 전에 멈춘다.
APPLY_STRESS_DIALECTS = mysql|postgres|sqlite
.PHONY: dbspec-apply-stress-bench
dbspec-apply-stress-bench:
	$(if $(APPLY_STRESS_DIALECTS),,$(error APPLY_STRESS_DIALECTS is empty; give mysql, postgres or sqlite separated by |))$(foreach dialect,$(subst |, ,$(APPLY_STRESS_DIALECTS)),$(if $(filter $(dialect),mysql postgres sqlite),,$(error APPLY_STRESS_DIALECTS names $(dialect), which is no database; give mysql, postgres or sqlite separated by |)))
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/dialects -run '^TestApplyStressPlan$$/^($(APPLY_STRESS_DIALECTS))$$' -count=1

# dbspec-apply-pairs-check는 TypeScript client와 Rust apply runner를 build하고,
# tests/dbspec/apply의 Go, PHP, TypeScript, Rust와 PHP 확장 orm_dbspec(이 실행의 directory에 build한다) runner와 Python runner
# packages/python/tests/dbspec_apply_runner.py의 모든 순서쌍마다 MySQL, PostgreSQL,
# SQLite에서 chain의 첫 plan을 한 client로, 나머지를 다른 client로 적용하고, 첫 client가 멈춘
# plan을 둘째 client가 recover로 마치며, 다시 멈춘 plan을 둘째 client가 rollback한다. history
# row와 introspect한 schema text가 chain의 것과 같아야 한다.
.PHONY: dbspec-apply-pairs-check
dbspec-apply-pairs-check: cargo-downloads-check lease-tool python-venv-check
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(RUN_LONG) rust-build/dbspec_apply --cwd packages/rust -- $(CARGO_COPY) debug/examples/dbspec_apply -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm --example dbspec_apply
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) DBSPEC_APPLY_RUST=$(RUN_TARGET)/debug/examples/dbspec_apply ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python $(GO_TEST) -tags physical ./tests/dialects -run '^TestApplyChainAcrossClients$$' -count=1
	rm -rf $(RUN_DIR)

# dbspec-apply-rust-check는 2000 table plan을 뺀 dbspec-apply-check의 scenario를 Rust client의
# polyspec_orm::dbspec::apply, recover, rollback, finalize로 실행한다.
.PHONY: dbspec-apply-rust-check
dbspec-apply-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-apply-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply -- --nocapture

# dbspec-plan-ts-check는 TypeScript client를 build하고 tests/dbspec/plans.json의 모든 case를
# 그 renderDbspec, planSteps, introspectDbspec으로 MySQL, PostgreSQL, SQLite에 적용한다.
.PHONY: dbspec-plan-ts-check
dbspec-plan-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test packages/ts/tests/dbspec-plan-physical.mjs

# dbspec-apply-ts-check는 TypeScript client를 build하고 2000 table plan을 뺀 dbspec-apply-check의
# scenario를 그 applyPlans, recoverPlans, rollbackPlans, finalizePlans로 실행한다.
.PHONY: dbspec-apply-ts-check
dbspec-apply-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test packages/ts/tests/dbspec-apply-physical.mjs

# dbspec-plan-rust-check는 같은 case를 Rust client의 plan step, renderer,
# polyspec_orm::dbspec::introspect로 적용한다.
.PHONY: dbspec-plan-rust-check
dbspec-plan-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-plan-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_plan_apply -- --nocapture

# dbspec-plan-php-check는 같은 case를 PHP client의 Polyspec\Orm\Dbspec\Dbspec::planSteps와
# Dbspec::introspect로 적용한다.
.PHONY: dbspec-plan-php-check
dbspec-plan-php-check: php-vendor-check
	$(WITH_TEST_ENV) php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanApplyTest.php

# dbspec-apply-php-check는 2000 table plan을 뺀 dbspec-apply-check의 scenario를 PHP client의
# Polyspec\Orm\Dbspec\Dbspec::apply, recover, rollback, finalize로 MySQL, PostgreSQL, SQLite에서 실행한다.
.PHONY: dbspec-apply-php-check
dbspec-apply-php-check: php-vendor-check
	$(WITH_TEST_ENV) php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyTest.php

# dbspec-apply-php-extension-check는 같은 scenario를 PHP 확장 orm_dbspec의 Polyspec\Orm\Dbspec\Native\Dbspec::apply,
# recover, rollback, finalize로 실행한다. 확장은 이 실행의 directory에 build한다.
.PHONY: dbspec-apply-php-extension-check
dbspec-apply-php-extension-check: php-vendor-check
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecApplyTest.php
	rm -rf $(RUN_DIR)

# dbspec-introspect-compare-check는 stress 문서(DBSPEC_INTROSPECT_TABLES개 table)를 MySQL,
# PostgreSQL, SQLite에 적용하고, database마다 tests/dbspec/introspect의 Go, PHP, TypeScript, Rust와
# PHP 확장 orm_dbspec(이 실행의 directory에 build한다) introspection runner를 실행해 같은 출력, source schema text, 미지원 객체 없음을 요구하고, 각
# introspection의 시간을 출력하며 기준값을 넘으면 경고한다. dbspec-introspect-compare-bench는 같은 target을 2000
# table 문서와 release runner로 실행한다.
.PHONY: dbspec-introspect-compare-check dbspec-introspect-compare-bench
dbspec-introspect-compare-check: cargo-downloads-check lease-tool python-venv-check
	$(HOLD_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_INTROSPECT_DOCUMENT))
	$(PUBLISH) $(DBSPEC_INTROSPECT_DOCUMENT) node tests/dbspec/stress.mts $(DBSPEC_INTROSPECT_TABLES)
	$(TSC_BUILD)
	$(RUN_LONG) rust-build/dbspec_introspect --cwd packages/rust -- $(CARGO_COPY) $(DBSPEC_INTROSPECT_DIR)/examples/dbspec_introspect -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --profile $(DBSPEC_INTROSPECT_PROFILE) --locked --offline -p polyspec-orm --example dbspec_introspect
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) DBSPEC_STRESS_DOCUMENT=$(DBSPEC_INTROSPECT_DOCUMENT) DBSPEC_INTROSPECT_RUST=$(RUN_TARGET)/$(DBSPEC_INTROSPECT_DIR)/examples/dbspec_introspect ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) DBSPEC_INTROSPECT_PYTHON=$(PYTHON_VENV)/bin/python $(GO_TEST) -tags physical ./tests/dialects -run '^TestIntrospectCompare$$' -count=1
	rm -rf $(RUN_DIR)

dbspec-introspect-compare-bench:
	$(MAKE) --no-print-directory dbspec-introspect-compare-check DBSPEC_INTROSPECT_TABLES=2000 DBSPEC_INTROSPECT_PROFILE=release

# dbspec-compare-check는 Go, PHP, TypeScript, Rust dbspec runner와 PHP 확장 orm_dbspec의 runner를 tests/dbspec/cases.json,
# stress 문서(DBSPEC_COMPARE_TABLES개 table), tests/dbspec/ddl.json, tests/dbspec/plans.json, tests/dbspec/mermaid.json,
# tests/dbspec/syntax.json으로
# 각각 두 번 실행하고, 두 run의 출력이 처음 다른 case에서 실패한다. The runs also print the declaration positions of
# the positions cases of cases.json and, for each case of syntax.json, the tokens and the format of the input of
# cases.json that its id names. PHP 확장은 이 실행의 directory에
# build한다(PHP_EXTENSION_LIBRARY). 그 전에 모든 runner가
# section이나 field를 빼거나 type을 바꾼 vector를 위치를 밝힌 error로 거부해야 하고, compare,
# apply, Rust stress runner가 없거나 directory인 input을 그 경로와 함께 거부해야 한다. A runner also refuses a section
# or field of cases.json that the format does not name: every runner reads its vector files through the JSON Schemas of
# tests/dbspec/schema with a validator of its ecosystem and reports a refusal in one form. runner는
# test build와 의존성을 함께 쓰는 debug build다. dbspec-compare-bench는 같은 target을 2000 table
# 문서로 실행한다.
.PHONY: dbspec-compare-check dbspec-compare-bench
# 부분들은 한 directory(top target의 RUN_DIR)를 함께 쓴다: prepare가 stress 문서와 runner를 만들고, 독립된 세
# 검사가 그것을 읽으며, top target이 모두 통과한 뒤 지운다. 실패한 부분이 있으면 directory는 남고 runner가 보고서로
# 옮긴다.
dbspec-compare-check/%: RUN_DIR = $(abspath .runtime/run)/dbspec-compare-check-$$PPID
.PHONY: dbspec-compare-check/unit dbspec-compare-check/prepare dbspec-compare-check/runners dbspec-compare-check/inputs dbspec-compare-check/compare
dbspec-compare-check: dbspec-compare-check/unit dbspec-compare-check/runners dbspec-compare-check/inputs dbspec-compare-check/compare
	rm -rf $(RUN_DIR)
dbspec-compare-check/unit:
	node --test tests/dbspec/compare/check.test.mts
# PYTHON_VENV is the virtual environment that install-python makes. It holds the Python client installed in editable mode,
# with the pinned dependencies of its pyproject.toml (ordered-json, cryptography, PyMySQL, psycopg, rapidyaml, ruamel.yaml) and
# of its extra test (jsonschema-rs); the checks
# take this interpreter as ORM_PYTHON and import the installed package, never a source path.
PYTHON_VENV = $(abspath packages/python/.venv)
# install-python installs the tools of mise.toml (install-tools), among them the Python that mise.lock pins, and makes the
# venv of that interpreter with kit's python-venv; no other python3 of PATH is used. The client is installed with that pip as
# an editable package (pip install --editable) with its extra test, so the tests import the installed package and a source
# change needs no reinstall.
.PHONY: install-python
install-python:
	$(MAKE) --no-print-directory install-tools
	$(MAKE) --no-print-directory python-venv DIR=$(PYTHON_VENV)
	$(ONLINE) python3 -m pip --python $(PYTHON_VENV)/bin/python install --quiet --editable packages/python --group packages/python/pyproject.toml:test
# python-venv-check checks that the venv of install-python exists and runs the Python release of mise.toml. A missing venv
# or another release fails without a download or a repair, and names the fix: remove the venv and run make install.
.PHONY: python-venv-check
python-venv-check:
	@test -x $(PYTHON_VENV)/bin/python || { echo "python-venv-check: $(PYTHON_VENV)/bin/python is missing; run make install, which creates it"; exit 1; }
	@got=$$($(PYTHON_VENV)/bin/python -c 'import platform; print(platform.python_version())') || { echo "python-venv-check: $(PYTHON_VENV)/bin/python does not run; remove $(PYTHON_VENV) and run make install, which builds it from the Python of mise.toml"; exit 1; }; \
	want=$$(mise current python) || { echo "python-venv-check: mise does not name the Python of mise.toml; run make install-tools"; exit 1; }; \
	test "$$got" = "$$want" || { echo "python-venv-check: $(PYTHON_VENV) runs Python $$got, but mise.toml declares $$want; remove $(PYTHON_VENV) and run make install, which builds it from the Python of mise.toml"; exit 1; }

# php-vendor-check fails when vendor-php/autoload.php or the PHPUnit of packages/php or packages/php-ext, which install-php
# creates with Composer, is missing, and names the make step that creates it; it installs nothing. A target that runs PHP
# through packages/php/tests/autoload.php or a package's PHPUnit takes it as a prerequisite.
.PHONY: php-vendor-check
php-vendor-check:
	@for file in vendor-php/autoload.php vendor-php/bin/phpunit; do test -f $$file || { echo "php-vendor-check: $$file is missing; run make install-php, which installs it with Composer"; exit 1; }; done

# python-check runs the Python client's unit tests, the interface tests of the Python extractor, the generated-model check and
# the Python conformance result check. The tests import the client and ordered-json installed into the venv (install-python).
.PHONY: python-check python-unit-check python-interface-unit-check
python-check: python-unit-check python-interface-unit-check python-model-check conformance-result-check/python
python-unit-check: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s packages/python/tests -t . -p 'test_*.py'
python-interface-unit-check: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s tests/interfaces -t tests/interfaces -p 'test_*.py'
# python-coverage-case-check is the check of the helper coverage-runner-python (contracts/features.json): the unit test of
# the case runner that the Python coverage tests share.
.PHONY: python-coverage-case-check
python-coverage-case-check: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.coverage_case_test
# dbspec-python-check is the Python verification of schema_definition (contracts/features.json schema-python): the shared
# vectors of tests/dbspec (cases.json and its files, ddl.json, plans.json and its SQLite apply chain, mermaid.json, syntax.json, show-create.json and
# set-files.json) and the unit tests of syntax analysis, formatting and the set reader.
.PHONY: dbspec-python-check
dbspec-python-check: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_cases
	$(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_ddl
	$(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_plans
	$(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_mermaid
	$(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_apply
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s packages/python/tests -t . -p 'test_dbspec_*.py'
dbspec-compare-check/prepare: cargo-downloads-check lease-tool python-venv-check
	$(HOLD_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_COMPARE_DOCUMENT))
	$(PUBLISH) $(DBSPEC_COMPARE_DOCUMENT) node tests/dbspec/stress.mts $(DBSPEC_COMPARE_TABLES)
	$(TSC_BUILD)
	$(RUN_LONG) rust-build/dbspec_compare --cwd packages/rust -- $(CARGO_COPY) debug/examples/dbspec_compare debug/examples/dbspec_stress -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm-schema --example dbspec_compare --example dbspec_stress
	$(RUN_LONG) rust-build/dbspec_apply --cwd packages/rust -- $(CARGO_COPY) debug/examples/dbspec_apply -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm --example dbspec_apply
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
dbspec-compare-check/runners: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python DBSPEC_STRESS_DOCUMENT=$(DBSPEC_COMPARE_DOCUMENT) node --test tests/dbspec/compare/runners.test.mts
dbspec-compare-check/inputs: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python DBSPEC_STRESS_DOCUMENT=$(DBSPEC_COMPARE_DOCUMENT) node --test tests/dbspec/inputs.test.mts
dbspec-compare-check/compare: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python node tests/dbspec/compare/check.mts tests/dbspec/cases.json $(DBSPEC_COMPARE_DOCUMENT) tests/dbspec/ddl.json tests/dbspec/plans.json tests/dbspec/mermaid.json tests/dbspec/syntax.json

dbspec-compare-bench:
	$(MAKE) --no-print-directory dbspec-compare-check DBSPEC_COMPARE_TABLES=2000

# dbspec-stress-bench는 2000 table stress 문서를 Go, PHP, TypeScript, Rust에서 두 번씩 parse하고
# emit해 parse 시간과 기준 작업에 대한 비율을 출력하고(docs/dbspec.md "Verification"), emit(parse(doc)) == doc, 두
# emission이 같음을 확인하며(Rust는 release build), PHP introspection을 SQLite에서 잰다.
.PHONY: dbspec-stress-bench
# 부분들은 top target의 RUN_DIR에 있는 stress 문서를 함께 읽고, 언어마다 독립된 부분이다.
dbspec-stress-bench/%: RUN_DIR = $(abspath .runtime/run)/dbspec-stress-bench-$$PPID
.PHONY: dbspec-stress-bench/prepare dbspec-stress-bench/go dbspec-stress-bench/php dbspec-stress-bench/php-introspect dbspec-stress-bench/typescript dbspec-stress-bench/rust
dbspec-stress-bench: dbspec-stress-bench/go dbspec-stress-bench/php dbspec-stress-bench/php-introspect dbspec-stress-bench/typescript dbspec-stress-bench/rust
	rm -rf $(RUN_DIR)
dbspec-stress-bench/prepare:
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT))
	$(PUBLISH) $(DBSPEC_STRESS_DOCUMENT) node tests/dbspec/stress.mts
dbspec-stress-bench/go: dbspec-stress-bench/prepare
	$(GO_TEST) -tags bench ./packages/go/engine/dbspec -run '^TestStressDocument$$' -count=1
	$(GO_TEST) -tags bench ./packages/go/engine/dbspec -run '^TestStressDocument$$' -count=1
dbspec-stress-bench/php: php-vendor-check dbspec-stress-bench/prepare
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecStressTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecStressTest.php
dbspec-stress-bench/php-introspect: php-vendor-check dbspec-stress-bench/prepare
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecIntrospectStressTest.php
dbspec-stress-bench/typescript: dbspec-stress-bench/prepare lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	node --test packages/ts/tests/dbspec-stress.mjs
	node --test packages/ts/tests/dbspec-stress.mjs
dbspec-stress-bench/rust: dbspec-stress-bench/prepare cargo-downloads-check
	$(RUN_LONG) rust-build/dbspec_stress --cwd packages/rust -- $(CARGO_COPY) release/examples/dbspec_stress -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p polyspec-orm-schema --example dbspec_stress
	$(RUN_TARGET)/release/examples/dbspec_stress $(abspath $(DBSPEC_STRESS_DOCUMENT))
	$(RUN_TARGET)/release/examples/dbspec_stress $(abspath $(DBSPEC_STRESS_DOCUMENT))

.PHONY: dbspec-rust-check/documents dbspec-rust-check/set dbspec-rust-check/apply-cleanup dbspec-rust-check/unicode dbspec-rust-check/show-create
dbspec-rust-check: dbspec-rust-check/documents dbspec-rust-check/set dbspec-rust-check/apply-cleanup dbspec-rust-check/unicode dbspec-rust-check/show-create
dbspec-rust-check/documents: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec --test dbspec_analyze --test dbspec_rules --test dbspec_manifest --test dbspec_render --test dbspec_runtime --test dbspec_plan --test dbspec_model --test dbspec_mermaid -- --nocapture
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec --test dbspec_analyze --test dbspec_rules --test dbspec_manifest --test dbspec_render --test dbspec_runtime --test dbspec_plan --test dbspec_model --test dbspec_mermaid -- --nocapture
# dbspec-rust-check/set runs every file tree case of tests/dbspec/set-files.json through the set reader
# dbspec::read_set, every case of tests/dbspec/set-parse.json through dbspec::parse_set, and its unit cases of the normal form, the nested JSON and the schema value.
dbspec-rust-check/set: dbspec-rust-check/set/vectors dbspec-rust-check/set/unit
.PHONY: dbspec-rust-check/set/vectors dbspec-rust-check/set/unit
dbspec-rust-check/set/vectors: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --test dbspec_set --test dbspec_set_parse -- --nocapture
dbspec-rust-check/set/unit: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --lib dbspec::set -- --nocapture
# dbspec-rust-check/unicode는 Go가 쓴 Unicode word rune 표(unicode_word.rs)가 모든 code point에서 구간과 같은지 본다.
dbspec-rust-check/unicode: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --lib dbspec::unicode_word -- --nocapture
dbspec-rust-check/apply-cleanup: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply_cleanup -- --nocapture
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply_cleanup -- --nocapture
# dbspec-rust-check/show-create는 shown_checks(mysql.rs)가 tests/dbspec/show-create.json의 모든 case를 기대한 본문으로 읽는지,
# 그리고 공개 MySQL introspection(read_catalog)이 그 catalog에서 case마다 기대한 check, 미지원 객체, error를 내는지 본다.
dbspec-rust-check/show-create: dbspec-rust-check/show-create/unit dbspec-rust-check/show-create/vectors
.PHONY: dbspec-rust-check/show-create/unit dbspec-rust-check/show-create/vectors
dbspec-rust-check/show-create/unit: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --lib show_create_tests -- --nocapture
dbspec-rust-check/show-create/vectors: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --test dbspec_show_create -- --nocapture

.PHONY: rust-send-savepoint-check
# 부분의 실행 directory는 top target의 것이다($@에 /가 있으면 directory가 한 단계 더 생긴다).
rust-send-savepoint-check/%: RUN_DIR = $(abspath .runtime/run)/rust-send-savepoint-check-$$PPID
rust-send-savepoint-check: rust-send-savepoint-check/clippy rust-send-savepoint-check/test
.PHONY: rust-send-savepoint-check/clippy rust-send-savepoint-check/test
rust-send-savepoint-check/clippy: cargo-downloads-check
	$(RUN_LONG) rust-clippy/orm-lib --cwd packages/rust -- $(CARGO_LEASED) cargo +$(PHYSICAL_RUST_TOOLCHAIN) clippy --locked --offline -p polyspec-orm --lib -- -D warnings
rust-send-savepoint-check/test: cargo-downloads-check
	mkdir -p $(RUN_DIR)
	$(WITH_TEST_ENV) cd packages/rust && ORM_SEND_SQLITE_DSN=$(SEND_SQLITE_DSN) $(CARGO_TEST) rust-send-savepoint-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib tx::send_tests:: -- --nocapture
	$(WITH_TEST_ENV) cd packages/rust && ORM_SEND_SQLITE_DSN=$(SEND_SQLITE_DSN) $(CARGO_TEST) rust-send-savepoint-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib tx::send_tests:: -- --nocapture
	rm -rf $(RUN_DIR)

.PHONY: dbspec-php-check
# dbspec-php-check는 공유 dbspec vector, PHP rule, tests/dbspec/ddl.json의 statement vector,
# tests/dbspec/plans.json의 plan vector, tests/dbspec/mermaid.json의 Mermaid vector, 감싼 SQLite
# connection으로 주입한 apply 정리 error를 각각 두 번 실행한다. stress 문서는 make bench가
# 실행한다.
dbspec-php-check: dbspec-php-check/documents dbspec-php-check/rules dbspec-php-check/manifest dbspec-php-check/render dbspec-php-check/plan dbspec-php-check/mermaid dbspec-php-check/apply-cleanup dbspec-php-check/unicode dbspec-php-check/show-create dbspec-php-check/analyze dbspec-php-check/set dbspec-php-check/set-parse
.PHONY: dbspec-php-check/documents dbspec-php-check/rules dbspec-php-check/manifest dbspec-php-check/render dbspec-php-check/plan dbspec-php-check/mermaid dbspec-php-check/apply-cleanup dbspec-php-check/unicode dbspec-php-check/show-create dbspec-php-check/analyze dbspec-php-check/set dbspec-php-check/set-parse
dbspec-php-check/documents: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecTest.php
dbspec-php-check/rules: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRulesTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRulesTest.php
dbspec-php-check/manifest: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecManifestTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecManifestTest.php
dbspec-php-check/render: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRenderTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRenderTest.php
dbspec-php-check/plan: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanTest.php
dbspec-php-check/mermaid: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecMermaidTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecMermaidTest.php
dbspec-php-check/apply-cleanup: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyCleanupTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyCleanupTest.php
# dbspec-php-check/unicode는 PHP UnicodeWord의 표가 모든 code point에서 그 구간과 같은지 본다(표 자체는 dbspec-go-check/unicode가 Go와 맞춘다).
dbspec-php-check/unicode: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecUnicodeTest.php
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecUnicodeTest.php
# dbspec-php-check/show-create는 MysqlCatalog::createChecks가 tests/dbspec/show-create.json의 모든 case를 기대한 본문으로 읽는지 본다.
# dbspec-php-check/analyze는 syntax analysis와 format을 focused case와 cases.json의 모든 case로 본다(docs/dbspec.md "Syntax analysis", "Formatting").
dbspec-php-check/analyze: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecAnalyzeTest.php
dbspec-php-check/show-create: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecShowCreateTest.php
# dbspec-php-check/set runs Dbspec::readSet on every case of tests/dbspec/set-files.json and the focused cases, each
# a temporary file tree with real symbolic and hard links (docs/dbspec.md "Document sets").
dbspec-php-check/set: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSetTest.php
# dbspec-php-check/set-parse runs Dbspec::parseSet on every case of tests/dbspec/set-parse.json (docs/dbspec.md
# "Parsing a set").
dbspec-php-check/set-parse: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSetParseTest.php

.PHONY: dbspec-php-extension-check php-extension-arginfo
# dbspec-php-extension-check는 PHP 확장 orm_dbspec(packages/php-ext, PHP client의 dbspec 표면을 C로 구현한
# Polyspec\Orm\Dbspec\Native)을 검사한다: src/orm_dbspec_arginfo.h가 stub에서 gen_stub.php로 만든 것과 같은지 확인하고, 확장을
# phpize로 이 실행의 directory에 build해 load한 뒤 Reflection이 stubs/orm_dbspec.stub.php와 PHP client의 public dbspec
# class와 같은지와, 공유 dbspec vector, statement vector, plan vector, Mermaid vector, apply 정리 error(PHP client의 plan,
# Mermaid, apply 정리 test와 같은 case), SQLite의 introspection과 apply에서 순수 PHP client에 대해 같은 결과를 내는지
# 각각 두 번 확인한다. build는 PATH의 phpize와
# php-config를 쓰고, gen_stub.php는 make install-php-extension-tools가 둔 것을 쓴다. php-extension-arginfo는 stub에서
# header를 다시 쓴다.
PHP_EXTENSION_LIBRARY = $(RUN_DIR)/php-extension/orm_dbspec.so
GEN_STUB = $(abspath .runtime/bin/gen-stub/gen_stub.php)
dbspec-php-extension-check/%: RUN_DIR = $(abspath .runtime/run)/dbspec-php-extension-check-$$PPID
.PHONY: dbspec-php-extension-check/arginfo dbspec-php-extension-check/prepare dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/analyze dbspec-php-extension-check/names dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup dbspec-php-extension-check/show-create dbspec-php-extension-check/set dbspec-php-extension-check/set-parse dbspec-php-extension-check/sets dbspec-php-extension-check/schema-definition
dbspec-php-extension-check: dbspec-php-extension-check/arginfo dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/analyze dbspec-php-extension-check/names dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup dbspec-php-extension-check/show-create dbspec-php-extension-check/set dbspec-php-extension-check/set-parse dbspec-php-extension-check/sets dbspec-php-extension-check/schema-definition
	rm -rf $(RUN_DIR)
dbspec-php-extension-check/arginfo:
	php packages/php-ext/scripts/arginfo.php $(GEN_STUB) check
dbspec-php-extension-check/prepare:
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
dbspec-php-extension-check/declarations: php-vendor-check dbspec-php-extension-check/prepare
	ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DeclarationsTest.php
	ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DeclarationsTest.php
dbspec-php-extension-check/vectors: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecTest.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecTest.php
# dbspec-php-extension-check/sets runs the sets cases of tests/dbspec/cases.json on the extension, one data set per id.
dbspec-php-extension-check/sets: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecSetsTest.php
# dbspec-php-extension-check/schema-definition runs the cases of contracts/fixtures/schema_definition.json on the extension.
dbspec-php-extension-check/schema-definition: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageSchemaDefinitionTest.php
# dbspec-php-extension-check/analyze는 확장의 syntax analysis와 format이 PHP client와 같은 token, 위치, diagnostic, emission과
# formatted text를 내는지 focused case, cases.json의 모든 case와 한도 error로 본다.
dbspec-php-extension-check/analyze: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecAnalyzeTest.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecAnalyzeTest.php
# dbspec-php-extension-check/names는 확장의 Names(render, ofTable, column)이 PHP client의 Names와 같은 결과와 예외를 내는지 본다.
dbspec-php-extension-check/names: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecNamesTest.php
dbspec-php-extension-check/plan: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecPlanTest.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecPlanTest.php
dbspec-php-extension-check/mermaid: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecMermaidTest.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecMermaidTest.php
dbspec-php-extension-check/apply-cleanup: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecApplyCleanupTest.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecApplyCleanupTest.php
# dbspec-php-extension-check/show-create는 shown_check(introspect.c)가 canned MySQL catalog에서 tests/dbspec/show-create.json의
# 모든 case를 Go의 introspection과 같은 check와 미지원 객체로 읽는지, 없는 CHECK를 Go와 같은 error로 거부하는지 본다.
dbspec-php-extension-check/show-create: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecShowCreateTest.php
# dbspec-php-extension-check/set runs the extension's Dbspec::readSet on every case of tests/dbspec/set-files.json and
# the focused cases and requires each result to equal the PHP client's, messages included.
dbspec-php-extension-check/set: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecSetTest.php
# dbspec-php-extension-check/set-parse runs the extension's Dbspec::parseSet on every case of
# tests/dbspec/set-parse.json and requires each result to equal the PHP client's.
dbspec-php-extension-check/set-parse: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecSetParseTest.php
php-extension-arginfo:
	php packages/php-ext/scripts/arginfo.php $(GEN_STUB) write

# repo-check는 root npm script가 쓰는 path가 tracked file이나
# directory인지, CI workflow가 make test-servers로 서버를 시작하고 그 환경 파일의 모든 변수를
# 검사 단계에 주는지(scripts/repo/ci.mts) 확인한다.
# version-check는 VERSION 파일과 orm의 모든 version 선언(Rust manifest와 lockfile, PHP composer,
# TypeScript package와 lockfile, feature contract, 문서)이 같은지 확인한다.
version-check: version-check/unit version-check/run
version-check/unit:
	node --test scripts/version/check.test.mts
version-check/run:
	node scripts/version/check.mts

repo-check: repo-check/unit repo-check/run
repo-check/unit:
	node --test scripts/repo/check.test.mts scripts/repo/python-venv.test.mts
repo-check/run:
	node scripts/repo/check.mts

# test-servers-check는 test-servers.mts의 MySQL 설정 migration(scripts/test-servers-mysql.mts)을 임시
# root의 서버로 검사한다: 다른 설정은 같은 수로 옮기고, 같은 설정은 아무것도 하지 않으며, 겹칠 이름은
# 바꾸기 전에 거부한다.
.PHONY: test-servers-check
# STOP_PROCESS는 test server를 멈출 때 process 종료를 운영체제의 알림으로 기다리는 program이다
# (tests/stop-process). 그 build는 장기 작업이므로 RUN_LONG으로 기한 없이 실행한다.
STOP_PROCESS = $(abspath .runtime/bin/stop-process)
BUILD_STOP_PROCESS = $(RUN_LONG) go-build/stop-process -- $(PUBLISH) $(STOP_PROCESS) go build -o @OUT@ ./tests/stop-process

test-servers-check:
	$(BUILD_STOP_PROCESS)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) node --test scripts/test-servers.test.mts scripts/test-servers-mysql.test.mts

test-servers:
	$(BUILD_STOP_PROCESS)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) node scripts/test-servers.mts start

# make test-servers-tls loads the TLS files of the MySQL TLS cases into running
# servers and writes their DSNs into TEST_ENV; make test-servers does it at the
# start.
test-servers-tls:
	node scripts/test-servers.mts tls

test-servers-stop:
	$(BUILD_STOP_PROCESS)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) node scripts/test-servers.mts stop

# test-servers-leases는 server의 lease 보유자를 적고, test-servers-leases-clear는 보유자 process가 없어진
# 죽은 lease(보유자와 releaser가 모두 끝난 것)를 지우며 지운 것을 적는다. 죽은 lease는 다음 요청이 가져가기도 한다(tests/lease).
SERVERS_LEASES = $(abspath .runtime/servers.leases)
test-servers-leases:
	$(BUILD_LEASE)
	$(LEASE) list $(SERVERS_LEASES)

test-servers-leases-clear:
	$(BUILD_LEASE)
	$(LEASE) clear-dead $(SERVERS_LEASES)

# feature-unit-check는 feature 문서가 manifest와 같은지와 coverage, owner 선택의 unit test를 실행한다.
# feature-check(feature-coverage, feature-verify-rust, feature-verify-other)는 TypeScript client를 한 번 build한 뒤 모든
# 기능의 coverage(native test binary를 한 번 build해 모든 실행이 쓴다)와 검증 명령을 실행한다. 검증 명령은 build된 client를
# 쓴다. helper check는
# feature-helper-check와 stress target(feature-stress-mysql-check, feature-stress-pg-sqlite-check)이 실행한다. 기능 하나는
# `node scripts/features/coverage.mts --feature <id>`와 `node scripts/features/check.mts --run --feature <id>`로
# 실행한다(test 환경 아래에서, owner-check가 하듯이).
# feature-owner-check는 바뀐 file(PATHS, 없으면 HEAD에서 바뀐 file과 추적하지 않는 file)을 입력으로 선언한
# 기능의 검증 명령과 coverage만, 그리고 contracts/check-inputs.json이 scope owner로 선언한 target만
# 실행한다(AGENTS.md "Owner checks"). 실행은 자기 test server 환경과 database를 쓴다.
# make owner-check, a target of the kit.mk of @polyspec/kit, passes this target the paths that changed under the rules of
# config/owner-checks.json; hooks-check first checks that the pre-push hook is installed.
.PHONY: feature-owner-check
feature-owner-check: hooks-check
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python node scripts/features/owners.mts $(PATHS)

feature-unit-check: feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select
feature-unit-check/docs:
	node scripts/features/build.mts --check
feature-unit-check/coverage:
	node --test scripts/features/coverage.test.mts
feature-unit-check/owners:
	node --test scripts/features/owners.test.mts scripts/features/manifest.test.mts
feature-unit-check/select:
	node --test scripts/features/select.test.mts

# feature-check는 기능의 coverage와 모든 검증 명령이고, make check는 그것을 세 target으로 실행한다: feature-coverage는
# coverage, feature-verify-rust는 shard rust(cargo로 Rust를 build하고 실행하는 명령)의 검증 명령, feature-verify-other는
# shard other의 검증 명령이다(contracts/features.json의 `shard`). CI는 셋을 서로 다른 group에서 동시에 실행한다. 같은
# 명령을 선언한 기능들은 같은 shard에 있고 그 명령은 한 번 실행된다(scripts/features/check.mts).
feature-check: feature-coverage feature-verify-rust feature-verify-other
feature-check/build: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
# The Python owners of the coverage run on the client's venv (ORM_PYTHON), which imports the installed client (scripts/features/coverage.mts).
feature-coverage: feature-check/build python-venv-check
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python node scripts/features/coverage.mts
feature-verify-rust: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run --features --shard rust
feature-verify-other: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run --features --shard other
# feature-helper-check, feature-stress-mysql-check와 feature-stress-pg-sqlite-check는 contracts/features.json의 helper check를
# 실행한다. FEATURE_STRESS_HELPERS는 시간이 가장 긴 stress bench의 helper다: 2000 table plan의 MySQL 적용
# (FEATURE_STRESS_MYSQL_HELPERS)은 feature-stress-mysql-check가, stress 문서의 bench와 PostgreSQL, SQLite 적용
# (FEATURE_STRESS_PG_SQLITE_HELPERS)은 feature-stress-pg-sqlite-check가, 나머지 helper는 feature-helper-check가 실행한다. 그래서
# CI group들이 기능의 검증 명령, helper, stress bench를 동시에 실행한다.
# FEATURE_SUITE_HELPERS는 check가 make check의 다른 곳에서 실행되는 helper다: conformance-runners는 conformance-check,
# conformance-result는 그 선행 target conformance-result-check, case-database는 case-database-check, bench-database
# (scripts/bench-db.mts)는 runner의 setup 단계 databases/create(scripts/check/databases.mts)가 실행한다. feature-helper-check는
# 그 helper를 빼므로 make check는 helper check마다 한 번 실행한다(make repo-check가 확인한다). make owner-check는 helper의
# file이 바뀌면 그 helper check를 그대로 실행한다.
FEATURE_STRESS_MYSQL_HELPERS = dbspec-apply-stress-mysql
FEATURE_STRESS_PG_SQLITE_HELPERS = dbspec-stress dbspec-apply-stress-pg-sqlite
FEATURE_STRESS_HELPERS = $(FEATURE_STRESS_MYSQL_HELPERS) $(FEATURE_STRESS_PG_SQLITE_HELPERS)
FEATURE_SUITE_HELPERS = bench-database case-database conformance-result conformance-runners
feature-helper-check: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run --helpers $(addprefix --without-helper ,$(FEATURE_STRESS_HELPERS) $(FEATURE_SUITE_HELPERS))
feature-stress-mysql-check:
	$(WITH_TEST_ENV) node scripts/features/check.mts --run $(addprefix --helper ,$(FEATURE_STRESS_MYSQL_HELPERS))
feature-stress-pg-sqlite-check: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run $(addprefix --helper ,$(FEATURE_STRESS_PG_SQLITE_HELPERS))

feature-docs:
	node scripts/features/build.mts

package-check: lease-tool
	$(RUN_LONG) package -- node scripts/package-check.mts

# fuzz-check는 fuzzing용으로 instrument한 build와 1초의 fuzzing(-fuzztime)을 함께 하는 장기 작업이므로
# 각 명령을 RUN_LONG으로 기한 없이 실행한다. fuzzing의 길이는 -fuzztime이 정한다.
fuzz-check: fuzz-check/engine-ir fuzz-check/clients-go-orm
fuzz-check/engine-ir:
	$(RUN_LONG) fuzz/engine-ir -- go test -v -timeout 0 ./packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s
fuzz-check/clients-go-orm:
	$(RUN_LONG) fuzz/clients-go-orm -- go test -v -timeout 0 ./packages/go/orm -run '^$$' -fuzz FuzzDecodeCiphertext -fuzztime=1s

# PHP는 client-unit-check가 실행하는 PHP program이다. 검사는 .php-version의 PHP를 PATH의 php로
# 쓰고, php-min-check는 composer.json이 지원하는 최저 release를 준다.
PHP = php
client-unit-check: client-unit-check/dsn client-unit-check/markdown client-unit-check/relation-keys client-unit-check/hostcodec client-unit-check/codec-aes client-unit-check/engine client-unit-check/runtime-model client-unit-check/orm-gen client-unit-check/model-methods client-unit-check/orm-gen-scan client-unit-check/orm-gen-scan-parity client-unit-check/client-generics client-unit-check/perf-extensions
client-unit-check/dsn: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DsnTest.php
client-unit-check/markdown: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/MarkdownTest.php
client-unit-check/relation-keys: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RelationKeysTest.php
client-unit-check/hostcodec: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/HostcodecTest.php
# client-unit-check/codec-aes runs the AES v2 vectors of tests/codec/aes-vectors.json, one data set per key.
client-unit-check/codec-aes: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecAesVectorsTest.php
client-unit-check/engine: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/EngineTest.php
client-unit-check/runtime-model: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RuntimeModelTest.php
client-unit-check/orm-gen: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenTest.php
client-unit-check/model-methods: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php
client-unit-check/orm-gen-scan: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenScanTest.php
# orm-gen-scan-parity compares the PHP scan with the node scan, which runs from the built packages/ts.
client-unit-check/orm-gen-scan-parity: php-vendor-check lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenScanParityTest.php
client-unit-check/client-generics: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ClientGenericsTest.php
client-unit-check/perf-extensions: php-vendor-check
	$(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/PerfExtensionsTest.php

# php-min-check runs the PHP client unit tests on the lowest PHP release that
# packages/php/composer.json supports.
php-min-check:
	PHP="$$(node scripts/php/php-min.mts)" && "$$PHP" --version && $(MAKE) --no-print-directory client-unit-check PHP="$$PHP"

# php-without-mysql-check는 MySQL driver(mysqlnd, pdo_mysql, mysqli)를 load하지 않은 PHP에서
# PHP client를 SQLite로 실행한다(N17): `php -n`에 client가 쓰는 확장만 명시한다. driver가
# shared module인 선언된 Linux runner(.github/runner)의 검사이며, driver가 compile된 PHP(macOS
# Homebrew)에서는 그 이유로 실패한다. make check의 feature-check는 Linux가 아니면 이 검사를
# 실행하지 않고 Linux runner에서 실행한다고 출력한다.
php-without-mysql-check:
	$(RUN_LONG) php-without-mysql -- node scripts/php-without-mysql.mts

client-db-check: lease-tool python-statement-fault-check python-identity-load-check python-schema-inspection-check
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANES=parallel node scripts/client-db-test.mts

# python-statement-fault-check runs the Python statement fault cases on SQLite, MySQL and PostgreSQL; it
# needs the database variables of make test-servers (WITH_TEST_ENV).
.PHONY: python-statement-fault-check
python-statement-fault-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.statement_fault

# python-identity-load-check runs the shared identity load cases (contracts/fixtures/identity_load.json)
# with the Python client on SQLite, MySQL and PostgreSQL; it needs the database variables of make
# test-servers (WITH_TEST_ENV).
.PHONY: python-identity-load-check
python-identity-load-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.identity_load

# python-schema-inspection-check runs schema().empty(), exists and installed, the table privileges and stats
# of the Python client on SQLite, MySQL and PostgreSQL case databases; it needs the database variables of make
# test-servers (WITH_TEST_ENV).
.PHONY: python-schema-inspection-check
python-schema-inspection-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.schema_inspection

# dialect-facts-check runs the schema dialect probes of tests/dialects against
# the MySQL and PostgreSQL servers of TEST_ENV and a SQLite file per probe,
# and records which SQLite openers keep a DSN query in the file name.
dialect-facts-check: dialect-facts-check/probes dialect-facts-check/facts
dialect-facts-check/probes:
	$(GO_TEST) ./tests/dialects -run '^TestProbeIDs$$' -count=1
dialect-facts-check/facts:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/dialects -run '^(TestDialectFacts|TestSQLiteFileNameWithQuery)$$' -count=1

conformance-counter-check:
	$(WITH_TEST_ENV) node --test tests/conformance/check/counters.physical.test.mts

# conformance-result-check는 TypeScript client를 build하고 PHP, TypeScript, Go conformance result
# test를 실행한다. 각 runner가 자기 case를 기한과 함께 보고한다.
conformance-result-check: conformance-result-check/php conformance-result-check/typescript conformance-result-check/go conformance-result-check/python
.PHONY: conformance-result-check/php conformance-result-check/typescript conformance-result-check/go conformance-result-check/python
conformance-result-check/php: php-vendor-check
	php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceResultTest.php
conformance-result-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
	node --test tests/conformance/result_typescript.test.mts
conformance-result-check/go:
	$(GO_TEST) ./tests/conformance/runner_go -count=1
conformance-result-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python tests/conformance/result_python.py

conformance-result-physical-check: lease-tool conformance-python-models
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_PYTHON_MODELS=$(CONFORMANCE_PY_MODELS) node --test tests/conformance/check/result.physical.test.mts

conformance-rust-group-check: lease-tool
	$(WITH_TEST_ENV) node --test tests/conformance/check/rust-group.physical.test.mts

group-rows-physical-check: php-vendor-check
	$(WITH_TEST_ENV) node scripts/group-rows-physical-check.mts

unselected-column-physical-check: php-vendor-check
	$(WITH_TEST_ENV) node scripts/unselected-column-physical-check.mts

# case-database-check는 공유 test database 두 곳에 table 하나를 남겨 둔 채 네 client의 model
# case를 실행하고, case가 통과하며 공유 database와 PostgreSQL schema를 바꾸지 않고 자기
# `orm_case_` database와 `orm-case-` SQLite file을 남기지 않는지 확인한다(T25).
case-database-check: php-vendor-check lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/integration --cwd packages/rust -- $(CARGO_COPY) debug/integration -- cargo build --locked -p polyspec-orm-tests --bin integration
	$(WITH_TEST_ENV) CARGO_TARGET_DIR=$(RUN_TARGET) node scripts/case-database-check.mts
	rm -rf $(RUN_DIR)

# conformance-check는 네 client의 conformance runner를 MySQL, PostgreSQL, SQLite의 bench database에서 실행해
# output을 vector 기대값과 비교하고, 그 실행의 output을 공통 state contract(contracts/interfaces.json의
# sequences)와 비교한다. output은 이 실행의 RUN_DIR에만 쓰고 끝에 지우므로, 결과는 tree에만 달렸고 이전
# 실행이 남긴 output을 읽지 않는다. interfaces checker는 Rust 추출기를 target lease 아래에서 build한다.
# conformance-check의 부분은 서로 독립이다: counter, result, physical result 검사가 실패해도 conformance 실행(run)은
# 실행된다(make -k).
# PYTHON_MODELS_DIR는 contracts/fixtures/bench/bench.dbs에서 orm-gen이 쓰고 커밋하는 Python model directory다.
# python-model-check는 orm-gen gen --check로 그 directory가 생성 결과와 같은지 확인한다(network 없음).
PYTHON_MODELS_DIR = packages/python/src/polyspec/orm/models
.PHONY: python-model-check
python-model-check: python-venv-check
	$(PYTHON_VENV)/bin/orm-gen gen --check --set contracts/fixtures/bench/dbspec-set.json --out $(PYTHON_MODELS_DIR)

# CONFORMANCE_PY_MODELS is the model directory that the Python conformance runner imports. The venv orm-gen writes it from
# contracts/fixtures/bench/bench.dbs into a temporary directory and renames it into place (an atomic publish of build output).
CONFORMANCE_PY_MODELS = $(abspath .runtime/run)/conformance-python-models
.PHONY: conformance-python-models
conformance-python-models: python-venv-check
	rm -rf $(CONFORMANCE_PY_MODELS).tmp
	$(PYTHON_VENV)/bin/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out $(CONFORMANCE_PY_MODELS).tmp
	rm -rf $(CONFORMANCE_PY_MODELS) && mv $(CONFORMANCE_PY_MODELS).tmp $(CONFORMANCE_PY_MODELS)

conformance-check/%: RUN_DIR = $(abspath .runtime/run)/conformance-check-$$PPID
# VECTOR는 실행할 vector 이름을 공백으로 나눈 목록이며, 이름마다 check run에 --vector를 준다(비면 모든 vector).
# RECORD=1이면 VECTOR 없는 전체 실행에서 비교가 실패한 database의 진단 output(.run-*)을 check record로 그 database의 기대값에 기록한다
# (VECTOR와 함께면 거부한다: 선택한 vector만의 실행은 전체 실행이라면 앞의 vector가 만든 각 연결의 첫 사용 statement도 기록한다):
# record는 다섯 output이 일치할 때만 기록하고, 기록하지 못하거나 runner가 실패해 진단 output이 없으면 실패한다.
# 기록한 뒤에는 같은 vector를 다시 실행해 새 기대값과 비교한다. contracts/interfaces.json의 state contract는
# 모든 vector의 output을 읽으므로 VECTOR가 있으면 검사하지 않고 그렇다고 출력한다.
CONFORMANCE_VECTORS = $(foreach name,$(VECTOR),--vector $(name))
CONFORMANCE_RUN = node tests/conformance/check/main.mts run --out $(RUN_DIR)/out $(CONFORMANCE_VECTORS) --driver mysql --dsn "$$BENCH_MYSQL_DSN" --driver postgres --dsn "$$BENCH_POSTGRES_DSN" --driver sqlite --dsn "$$BENCH_SQLITE_DSN"
.PHONY: conformance-check/run
conformance-check: conformance-counter-check conformance-result-check conformance-result-physical-check conformance-check/run
conformance-check/run: lease-tool conformance-python-models
	$(if $(and $(VECTOR),$(RECORD)),@echo "conformance-check: RECORD=1 records only a full run; a run of selected vectors also records the first-use statements of each connection that the full run makes in an earlier vector" >&2; exit 2)
	$(HOLD_TYPESCRIPT)
	rm -rf $(RUN_DIR)
	$(WITH_TEST_ENV) export ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_PYTHON_MODELS=$(CONFORMANCE_PY_MODELS) && if $(CONFORMANCE_RUN); then :; \
	elif [ -n "$(RECORD)" ]; then \
	  recorded=0; \
	  for db in mysql postgres sqlite; do \
	    dir=$(RUN_DIR)/out; [ $$db = mysql ] || dir=$$dir/$$db; \
	    for pending in $$dir/.run-*; do \
	      [ -d "$$pending" ] || continue; \
	      node tests/conformance/check/main.mts record --driver $$db $(CONFORMANCE_VECTORS) $$pending/go.json $$pending/php.json $$pending/rust.json $$pending/typescript.json $$pending/python.json || exit 1; \
	      recorded=1; \
	    done; \
	  done; \
	  [ $$recorded = 1 ] || { echo "conformance-check: the run failed before any comparison, so RECORD=1 has nothing to record" >&2; exit 1; }; \
	  rm -rf $(RUN_DIR)/out && $(CONFORMANCE_RUN); \
	else exit 1; fi
	$(if $(VECTOR),@echo "conformance-check: the state contracts of contracts/interfaces.json are not checked because VECTOR selects only some of their vectors",PATH="$(HOME)/.cargo/bin:$(PATH)" node tests/interfaces/check/main.mts --results $(RUN_DIR)/out --results $(RUN_DIR)/out/postgres --results $(RUN_DIR)/out/sqlite)
	rm -rf $(RUN_DIR)

# markdown-conformance-check는 tests/markdown/cases.json의 case를 client마다 FLOWMARK의 flowmark server에서
# 실행한다(tests/markdown/README.md). FLOWMARK는 tests/markdown/flowmark.version이 고정한 build이며 make
# install-flowmark가 여기에 설치한다. test는 그 build 정보가 고정한 판이 아니면 실패하므로, 고정한 revision의 flowmark
# checkout을 build한 binary는 FLOWMARK=<그 경로>로 줄 수 있다.
FLOWMARK ?= $(abspath .runtime/bin/flowmark)
.PHONY: markdown-conformance-check markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/python markdown-conformance-check/rust markdown-conformance-check/typescript install-flowmark
markdown-conformance-check: markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/python markdown-conformance-check/rust markdown-conformance-check/typescript
markdown-conformance-check/go:
	FLOWMARK=$(FLOWMARK) $(GO_TEST) -tags markdown ./packages/go/markdownmodel -run '^TestMarkdownConformance$$' -count=1
markdown-conformance-check/php: php-vendor-check
	FLOWMARK=$(FLOWMARK) $(PHP) vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist --stop-on-defect packages/php/tests/MarkdownConformanceTest.php
# Python runner는 build 정보를 go version -m으로 읽는다.
markdown-conformance-check/python: python-venv-check
	FLOWMARK=$(FLOWMARK) $(PYTHON_VENV)/bin/python -m packages.python.tests.markdown_conformance
markdown-conformance-check/rust: lease-tool cargo-downloads-check
	cd packages/rust && FLOWMARK=$(FLOWMARK) PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) markdown-conformance-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test markdown_conformance -- --nocapture
markdown-conformance-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	FLOWMARK=$(FLOWMARK) node --conditions=orm-test packages/ts/tests/markdown_conformance.mjs

decimal-bench-sqlite: typescript-build
	$(READ_TYPESCRIPT)
	node scripts/decimal-bench-sqlite.mts

# decimal-physical-check의 case는 owner process마다 기한(scripts/physical.mts의 TIMEOUT_MS)을 가진다. 그 process가
# 쓰는 build(Rust test binary decimal_physical, Go decimalmodel test)는 장기
# 작업이므로 case 앞에서 기한 없이 RUN_LONG으로 먼저 하고(Go build는 .runtime/bin에 publish하며 build cache를 채운다), case는
# build된 것을 실행한다.
decimal-physical-check: php-vendor-check cargo-downloads-check lease-tool
	$(READ_TYPESCRIPT)
	test -n "$(DECIMAL_ENV)" -a -f "$(DECIMAL_ENV)" || { echo 'DECIMAL_ENV names no decimal database of this run; run make run-databases TARGETS=$@' >&2; exit 1; }
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/decimal-physical -- $(CARGO_LEASED) cargo test --no-run --offline --locked --manifest-path packages/rust/Cargo.toml -p polyspec-orm-tests --bin decimal_physical
	$(RUN_LONG) go-build/decimal-physical -- $(PUBLISH) $(abspath .runtime/bin/decimalmodel.test) go test -c -o @OUT@ -tags decimalphysical ./packages/go/decimalmodel
	. $(DECIMAL_ENV) && node scripts/decimal-physical-check.mts

# interface-check는 interface checker(tests/interfaces/check)의 test와 checker 자신을 --self-test로 실행한다. checker는 entity
# 단위 rule을 TypeScript client의 build(packages/ts/dist)가 읽는 dbspec entity 순서로 펼친다.
.PHONY: interface-check/tests interface-check/self-test
interface-check: interface-check/tests interface-check/self-test
interface-check/tests: php-vendor-check
	node --test tests/interfaces/check/*.test.mts
interface-check/self-test: php-vendor-check lease-tool typescript-build
	$(READ_TYPESCRIPT)
	PATH="$(HOME)/.cargo/bin:$(PATH)" node tests/interfaces/check/main.mts --self-test

go-model-check:
	$(RUN_LONG) go-model -- sh -c 'cd packages/go/model && go generate ./ && git diff --exit-code -- .'

# ts-model-check builds the TypeScript client, then fails when the models
# script scans a source that does not call models or misses one that does,
# or when the committed src/models/models.ts differs from its output.
ts-model-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	node --test packages/ts/tests/models-scan.mjs

perf-check:
	$(WITH_TEST_ENV) node scripts/perf-test.mts

# scripts-typecheck는 저장소의 TypeScript 기반 스크립트(scripts/와 tests/의 .mts, tsconfig.json)를 tsc로 검사한다.
# 스크립트 일부는 packages/ts와 packages/dbspec-language(docs/.vitepress/dbs.ts를 거쳐)의 build 출력을 import하므로
# 그 build 뒤에 검사한다.
scripts-typecheck: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	npm run --workspace @polyspec/dbspec-language build
	$(RUN_LONG) scripts-typecheck -- node_modules/.bin/tsc -p tsconfig.json

ts-check: ts-check/hold ts-check/types ts-check/test
ts-check/hold: lease-tool
	$(HOLD_TYPESCRIPT)
ts-check/types: ts-check/hold
	$(RUN_LONG) typescript-check -- npm run typescript:check
ts-check/test: ts-check/hold
	$(WITH_TEST_ENV) npm run typescript:test

# ts-min-check runs the TypeScript tests on the lowest Node release that
# package.json supports.
ts-min-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) PATH="$$(node scripts/typescript/node-min.mts):$$PATH" && export PATH && node --version && npm run typescript:test

# dbspec-ts-check는 TypeScript client를 build하고, 공유 dbspec vector, set file vector, plan vector, Mermaid
# vector, apply 정리 error, 그것들이 아직 다루지 않는 rule, Unicode word 표가 모든 code point에서 그 구간과
# 같은지를 실행한다. stress 문서는 make bench가 실행한다.
.PHONY: dbspec-ts-check
dbspec-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	node --test packages/ts/tests/browser-entry.mjs packages/ts/tests/dbspec.mjs packages/ts/tests/dbspec-set.mjs packages/ts/tests/dbspec-set-parse.mjs packages/ts/tests/dbspec-analyze.mjs packages/ts/tests/syntax-vectors.mjs packages/ts/tests/dbspec-rules.mjs packages/ts/tests/dbspec-render.mjs packages/ts/tests/dbspec-plan.mjs packages/ts/tests/dbspec-mermaid.mjs packages/ts/tests/dbspec-apply-cleanup.mjs packages/ts/tests/dbspec-unicode.mjs packages/ts/tests/dbspec-show-create.mjs

# dbspec-language-check는 TypeScript client와 @polyspec/dbspec-language를 build하고, 언어 서비스의 module graph가
# node module, Node global과 driver에 닿지 않는지, 공유 vector의 format과 hash, 토큰과 UTF-16 범위, tests/editor의
# fixture를 실행한다.
# It also runs resolveSet with the node:fs host over the set-files.json vectors and set resolution, and dbspec-fmt over
# its modes, exit codes, stderr lines and the --write and --check of the editor fixtures.
.PHONY: dbspec-language-check
# dbspec-lsp-check builds the language server and runs its stdio sessions over the editor fixtures and file trees.
dbspec-lsp-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	npm run --workspace @polyspec/dbspec-language build
	npm run --workspace @polyspec/dbspec-lsp build
	node --test packages/dbspec-lsp/tests/session.test.mjs

# dbspec-codemirror-check builds the CodeMirror adapter and runs the editor fixtures through an EditorState.
dbspec-codemirror-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	npm run --workspace @polyspec/dbspec-language build
	npm run --workspace @polyspec/dbspec-codemirror build
	node --test packages/dbspec-codemirror/tests/fixtures.test.mjs

# dbspec-vscode-check builds the VS Code extension (the type check and the esbuild bundles of the extension and the
# bundled language server) and checks its manifest and bundles without VS Code.
dbspec-vscode-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	npm run --workspace @polyspec/dbspec-language build
	npm run --workspace @polyspec/dbspec-lsp build
	npm run --workspace polyspec-dbspec build
	node --test packages/dbspec-vscode/tests/manifest.test.mjs

# install-vscode installs the VS Code of the integration test into var/tools/vscode with kit's VS Code installer, at the
# minimum release that packages/dbspec-vscode declares (engines.vscode); it downloads once and keeps a complete copy.
.PHONY: install-vscode
install-vscode:
	$(ONLINE) node $(KIT)/install-vscode.$(KIT_EXT) packages/dbspec-vscode $(CURDIR)/var/tools/vscode

# dbspec-vscode-integration runs the editor fixtures through vscode.provideDocumentSemanticTokens inside the VS Code that
# make install-vscode installed; the run reads that copy and never downloads.
.PHONY: dbspec-vscode-integration
dbspec-vscode-integration: dbspec-vscode-check
	node packages/dbspec-vscode/tests/integration/run.mjs --vscode $(CURDIR)/var/tools/vscode

# ci-vscode-integration runs dbspec-vscode-integration on a virtual X server (xvfb-run), since VS Code needs a display; the
# editor job of CI runs it on Linux, and a desktop runs dbspec-vscode-integration itself.
.PHONY: ci-vscode-integration
ci-vscode-integration:
	xvfb-run -a $(MAKE) --no-print-directory dbspec-vscode-integration

dbspec-language-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	npm run --workspace @polyspec/dbspec-language build
	node --test packages/dbspec-language/tests/module-graph.test.mjs packages/dbspec-language/tests/editor.test.mjs packages/dbspec-language/tests/vectors.test.mjs packages/dbspec-language/tests/resolve-set.test.mjs packages/dbspec-language/tests/cli.test.mjs

# The prefix of `make install-cli`: the copy of dbspec-fmt in $(CLI_PREFIX)/lib and its script in $(CLI_PREFIX)/bin.
CLI_PREFIX ?= $(HOME)/.local

# install-cli builds the TypeScript client and @polyspec/dbspec-language and installs the command dbspec-fmt under
# CLI_PREFIX without a symbolic link (scripts/install-cli.mts): a copy of both packages and a script that runs node
# with the copied entry. Put $(CLI_PREFIX)/bin on PATH; uninstall-cli removes the copy and the script.
.PHONY: install-cli uninstall-cli
install-cli: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	npm run --workspace @polyspec/dbspec-language build
	$(ONLINE) node scripts/install-cli.mts install --prefix $(CLI_PREFIX)

uninstall-cli:
	node scripts/install-cli.mts uninstall --prefix $(CLI_PREFIX)

# install-cli-check installs dbspec-fmt into a temporary prefix with scripts/install-cli.mts, runs it and uninstalls it
# (tests/cli/install-cli.test.mts); the install reads the registry.
install-cli-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	npm run --workspace @polyspec/dbspec-language build
	$(ONLINE) node --test tests/cli/install-cli.test.mts

# dbspec-go-check는 Go dbspec engine package(packages/go/engine/dbspec)의 test를 모두 실행한다: tests/dbspec/cases.json의
# 공유 vector, 자기 rule case, manifest, statement, plan, comparison, Mermaid vector, apply 정리 error,
# case harness, 그리고 모든 vector file의 빠지거나 type이 틀린 field를 위치와 함께 거부하는지. stress
# 문서(TestStressDocument, build tag bench)는 make bench가 실행한다.
.PHONY: dbspec-go-check dbspec-go-check/engine dbspec-go-check/unicode
dbspec-go-check: dbspec-go-check/engine dbspec-go-check/unicode
dbspec-go-check/engine:
	$(GO_TEST) ./packages/go/engine/dbspec -count=1
# dbspec-go-check/unicode는 tests/dbspec/unicode의 생성기가 쓴 표 세 파일이 현재 Go 표와 같고, C 확장과 Python 모듈이
# 모든 code point에서 Go와 같은 분류를 내는지 본다.
dbspec-go-check/unicode:
	$(GO_TEST) ./tests/dbspec/unicode -count=1

docs-dev:
	npm run docs:dev

docs-build:
	npm run docs:build

# docs-ci는 CI(ci.yml)의 job docs가 실행하는 문서 검사(docs-verify-idempotent, docs-check)를 make check의 runner로
# test server 없이 실행한다(scripts/check/run.mts `-`). 실패해도 다음 target을 실행하고, target마다의 log와 summary를
# .runtime/check/<실행 id>/report에 남기며, workflow는 그것을 job summary와 artifact로 올린다.
docs-ci:
	node scripts/check/run.mts --job-summary - docs-verify-idempotent docs-check

docs-check:
	npm run docs:check

docs-verify-idempotent:
	npm run docs:verify-idempotent

docs-rules-check:
	npm run docs:rules-check

# docs-dbs-check runs the unit cases of the dbs fence (docs/.vitepress/dbs.ts) after building the packages it reads, and
# type-checks the site's TypeScript with docs/.vitepress/tsconfig.json, the project that make lint-ts also judges it by.
docs-dbs-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	npm run --workspace @polyspec/dbspec-language build
	$(RUN_LONG) docs-typecheck -- node_modules/.bin/tsc -p docs/.vitepress/tsconfig.json
	node --test tests/docs/dbs-fence.test.mts

# markdown-table-check compares the table "Markdown IR executor" of docs/dialects.md and docs/dialects.ko.md with the
# capability table of flowmark's docs/spec/60-dialect.md at the version of tests/markdown/flowmark.version, which it
# downloads as install-flowmark does.
markdown-table-check:
	node scripts/docs/markdown-table.mts

# go-fmt-check fails when gofmt would change a tracked Go source and lists
# the files it would change.
.PHONY: go-fmt-check
go-fmt-check:
	@$(RUN_LONG) go-fmt -- sh -c 'files=$$(gofmt -l $$(git ls-files "*.go")); if [ -n "$$files" ]; then echo "gofmt would change:"; echo "$$files"; exit 1; fi; echo "every tracked Go source is gofmt formatted"'

# go-vet-check runs go vet over every Go package of the modules of go.work, test files
# included: its own analyzers (go-vet-check/std), then the analyzers of the repository's
# rules for Go source (tests/analyzers) through their vet tool orm-vet (go-vet-check/orm).
# The two are independent parts, so a failure of one still runs the other (make -k).
ORM_VET = $(abspath .runtime/bin/orm-vet)
.PHONY: go-vet-check go-vet-check/std go-vet-check/orm
go-vet-check: go-vet-check/std go-vet-check/orm
go-vet-check/std:
	$(RUN_LONG) go-vet -- go vet $(GO_PACKAGES)
go-vet-check/orm:
	$(RUN_LONG) go-build/orm-vet -- $(PUBLISH) $(ORM_VET) go build -o @OUT@ ./tests/analyzers/orm-vet
	$(RUN_LONG) go-vet/orm -- go vet -vettool=$(ORM_VET) $(GO_PACKAGES)

# codec-check는 PHP codec으로 tests/codec/vectors.json을 decode하고 encode한 뒤, 이 target이 실행한 Go, Rust,
# TypeScript, Python codec test가 이 make 실행의 directory(CODEC_OUT, ORM_CODEC_OUT)에 쓴 출력을 decode한다
# (tests/codec/README.md). 다른 target이나 앞선 실행이 쓴 출력은 읽지 않으므로, 그 출력은 언제나 이 checkout의
# 지금 code의 것이다. 네 writer는 서로 독립된 부분이므로 하나가 실패해도 나머지가 실행되고(make -k), 비교는 네
# 출력을 모두 읽으므로 그 뒤에 온다. 실패한 실행의 directory는 runner가 보고서로 옮긴다.
CODEC_OUT = $(abspath .runtime/run)/codec-check-$$PPID
.PHONY: codec-check codec-check/go codec-check/rust codec-check/typescript codec-check/python codec-check/compare
codec-check: codec-check/compare
# codec-check/python runs the shared vectors through the Python codec and writes its encodings to ORM_CODEC_OUT for
# codec-check/compare.
codec-check/python: python-venv-check
	mkdir -p $(CODEC_OUT)
	ORM_CODEC_OUT=$(CODEC_OUT) $(PYTHON_VENV)/bin/python -m packages.python.tests.codec_vector
codec-check/go:
	mkdir -p $(CODEC_OUT)
	ORM_CODEC_OUT=$(CODEC_OUT) $(GO_TEST) ./packages/go/orm -run '^TestCodecVectors$$' -count=1
codec-check/rust: cargo-downloads-check lease-tool
	mkdir -p $(CODEC_OUT)
	cd packages/rust && ORM_CODEC_OUT=$(CODEC_OUT) $(CARGO_TEST) codec-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test codec_vectors
codec-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	mkdir -p $(CODEC_OUT)
	$(TSC_BUILD)
	ORM_CODEC_OUT=$(CODEC_OUT) node packages/ts/tests/codec-vector.mjs
codec-check/compare: php-vendor-check codec-check/go codec-check/rust codec-check/typescript codec-check/python
	ORM_CODEC_OUT=$(CODEC_OUT) php vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecVectorsTest.php
	rm -rf $(CODEC_OUT)

# rust-fmt-check fails when cargo fmt would change a source of the Rust
# workspace (packages/rust/rustfmt.toml).
# rust-fmt-check는 저장소의 모든 Rust workspace(packages/rust, benchmarks/rust, tests/interfaces/rust)가 cargo fmt로
# 정리되어 있는지 확인한다.
rust-fmt-check: rust-fmt-check/clients rust-fmt-check/bench rust-fmt-check/interfaces
rust-fmt-check/clients:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt --cwd packages/rust -- cargo fmt --all --check
rust-fmt-check/bench:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt/bench --cwd benchmarks/rust -- cargo fmt --all --check
rust-fmt-check/interfaces:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt/interfaces --cwd tests/interfaces/rust -- cargo fmt --all --check

rust-150-check: lease-tool
	$(RUN_LONG) rust-150 -- node scripts/check-rust-150.mts

rust-check: rust-check/check rust-check/clippy rust-check/clippy-live-db rust-check/clippy-test-faults
rust-check/check: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-check/check --cwd packages/rust -- $(CARGO_LEASED) cargo check --locked
rust-check/clippy: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-check/clippy --cwd packages/rust -- $(CARGO_LEASED) cargo clippy --locked --workspace --all-targets -- -D warnings
rust-check/clippy-live-db: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-check/clippy-live-db --cwd packages/rust -- $(CARGO_LEASED) cargo clippy --locked -p polyspec-orm-build --all-targets --features live-db -- -D warnings
rust-check/clippy-test-faults: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-check/clippy-test-faults --cwd packages/rust -- $(CARGO_LEASED) cargo clippy --locked -p polyspec-orm --all-targets --features test-faults -- -D warnings

# install downloads what the checks read: the Composer packages, the Rust toolchain and the crates of every Cargo.lock, the
# Go modules, the lowest Node of ts-min-check, and the gen_stub.php and PHP-Parser of the PHP extension. The npm packages
# (the root, the TypeScript client and @polyspec/kit) come first, from make install-tools TOOLS=npm and make
# install-packages, because make reads the kit.mk of the installed package. What is downloaded is not downloaded again,
# and the parts are independent (make -k).

.PHONY: docs-ci
.PHONY: install install-interfaces-typescript install-php install-rust install-rust-toolchain install-rust-crates install-go install-node-min install-server-programs install-php-extension-tools ci-php-min-version downloads-check
install: install-php install-rust install-go install-node-min install-php-extension-tools install-python install-flowmark install-interfaces-typescript
# install-interfaces-typescript installs the TypeScript 6.0.3 that tests/interfaces/typescript.mts reads declarations with
# (config/toolchain.json exceptions): TypeScript 7.0 ships no JavaScript API of its compiler.
install-interfaces-typescript:
	$(ONLINE) npm ci --prefix tests/interfaces/typescript --no-audit --no-fund
# install-php installs the one Composer project of the repository, the development root (vendor-php): it installs packages/php
# from its directory with the runtime dependencies of that package, and PHPUnit, which runs the tests of packages/php and
# packages/php-ext. The released manifests of the two packages declare only what a consumer installs.
install-php:
	$(ONLINE) composer install --no-interaction --no-progress --prefer-dist
# install-rust installs the toolchain of rust-toolchain.toml, then downloads the crates of every Cargo.lock. CI runs the two
# halves apart, install-rust-toolchain before its crate cache is restored and install-rust-crates after it, since a
# restored registry replaces the crates downloaded before it.
install-rust: install-rust-toolchain install-rust-crates
install-rust-toolchain:
	PATH="$(HOME)/.cargo/bin:$(PATH)" rustup toolchain install
	PATH="$(HOME)/.cargo/bin:$(PATH)" rustc --version
install-rust-crates:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path packages/rust/Cargo.toml
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path benchmarks/rust/Cargo.toml
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path tests/interfaces/rust/Cargo.toml
install-go:
	$(ONLINE) go mod download
# install-flowmark은 markdown-conformance-check가 실행하는 flowmark, tests/markdown/flowmark.version이 고정한 module
# 판을 FLOWMARK의 directory에 설치한다.
install-flowmark:
	$(ONLINE) GOBIN=$(dir $(FLOWMARK)) go install github.com/polyspec/flowmark/cmd/flowmark@$$(cat tests/markdown/flowmark.version)
	$(ONLINE) go mod download github.com/polyspec/flowmark@$$(cat tests/markdown/flowmark.version)
install-node-min:
	$(ONLINE) ORM_NODE_MIN_INSTALL=1 node scripts/typescript/node-min.mts
# install-server-programs는 CI의 Linux runner에 make test-servers가 시작하는 server program을 설치한다
# (scripts/ci/server-programs.mts).
install-server-programs:
	$(ONLINE) node scripts/ci/server-programs.mts
# install-php-extension-tools는 PHP 확장 orm_dbspec의 build가 쓰는 phpize와 php-config가 PATH의 PHP 것인지 확인하고,
# 그 PHP의 gen_stub.php와 PHP-Parser를 .runtime/bin/gen-stub에 둔다(scripts/ci/php-extension-tools.mts).
install-php-extension-tools:
	$(ONLINE) node scripts/ci/php-extension-tools.mts

# CI의 setup step은 모두 make target을 실행한다(make repo-check). ci-php-min-version은 make php-min-check의 가장 낮은
# PHP release를 setup-php의 입력(version=x.y)으로 적는다. 각 client는 연결할 때 SQLite 3.46 미만을 거부한다.
ci-php-min-version:
	@echo "version=$$(node scripts/php/php-min.mts --version)"

# downloads-check는 check가 읽는 download가 모두 있는지 network 없이 확인하고, 빠진 것을 `run make install`과
# 함께 적는다(scripts/check/downloads.mts). runner(scripts/check/run.mts)는 같은 확인을 setup 단계 downloads로 실행한다.
# The crates are checked by cargo-downloads-check of the kit.mk of @polyspec/kit, which every target that runs cargo
# --offline runs first, so a missing crate fails with its fix instead of cargo's "retry without --offline".
downloads-check:
	node scripts/check/downloads.mts

# rust-driver-check는 benchmarks/rust의 native와 driver_compare를 DSN 없이 실행해 거부를 확인하고,
# 시드된 bench database에서 한 번에 하나씩 실행해 모든 workload가 끝나는지 확인한다.
rust-driver-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd benchmarks/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) rust-driver-check -- cargo test --locked --offline -- --test-threads=1

# example-check는 examples/complex와 examples/thin-slice의 Go, PHP, Rust 프로그램을 시드된
# bench database에서 실행하고 README의 diff처럼 stdout이 byte 단위로 같은지 비교한다.
example-check: cargo-downloads-check
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/examples --cwd packages/rust -- $(CARGO_COPY) debug/complex debug/demo -- cargo build --locked --offline -p polyspec-orm-tests --bin complex --bin demo
	$(WITH_TEST_ENV) EXAMPLE_RUST_COMPLEX=$(RUN_TARGET)/debug/complex EXAMPLE_RUST_DEMO=$(RUN_TARGET)/debug/demo $(GO_TEST) -tags examples ./examples -run '^TestExampleOutputsAreIdentical$$' -count=1
	rm -rf $(RUN_DIR)

# timing-check는 자기 계산의 시간을 재는 Go, Rust, PHP, TypeScript test를 process group이 CPU를 일부만 받도록
# 멈추며 실행하고, 각 test가 그대로 통과하며 측정을 출력하는지 확인한다. 성능은 측정할 뿐 test를 실패시키지
# 않는다(AGENTS.md). 2000 table stress 문서를 쓰므로 make bench가 실행한다.
TIMING_GO_DBSPEC_TEST = $(RUN_DIR)/dbspec.test
timing-check: cargo-downloads-check lease-tool
	$(HOLD_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT)) $(dir $(TIMING_GO_DBSPEC_TEST))
	$(PUBLISH) $(DBSPEC_STRESS_DOCUMENT) node tests/dbspec/stress.mts
	$(RUN_LONG) go-build/dbspec-test -- $(PUBLISH) $(TIMING_GO_DBSPEC_TEST) go test -c -tags bench -o @OUT@ ./packages/go/engine/dbspec
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/dbspec_stress --cwd packages/rust -- $(CARGO_COPY) release/examples/dbspec_stress -- cargo build --release --locked --offline -p polyspec-orm-schema --example dbspec_stress
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/orm-schema-tests --cwd packages/rust -- $(CARGO_LEASED) cargo test --locked --offline -p polyspec-orm-schema --no-run
	$(RUN_LONG) typescript-build -- npm run typescript:build
	PATH="$(HOME)/.cargo/bin:$(PATH)" DBSPEC_STRESS_DOCUMENT=$(abspath $(DBSPEC_STRESS_DOCUMENT)) TIMING_GO_DBSPEC_TEST=$(abspath $(TIMING_GO_DBSPEC_TEST)) TIMING_RUST_STRESS=$(RUN_TARGET)/release/examples/dbspec_stress node --test --test-concurrency=1 tests/timing/preempted.test.mts
	rm -rf $(RUN_DIR)

typescript-build: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build

# npm 12.2.0 installs no URL dependency by default: the consumer projects of a release read the tarball of
# @polyspec/ordered-json by its URL, which their locks pin, so the consumer install and the proof run with
# allow-remote=root, and so does the lock of a release consumer, which resolves that URL; a lock pins every registry package by its integrity, so the install downloads are
# installation and no remote package enters the tree (the same setting as hyper, H13.5-14 of hyper).
release-consumer release-consumer-lock release-proof: export npm_config_allow_remote := root

# The archives of the npm packages hold the builds of the TypeScript client and of the editor packages (the release tool of
# @polyspec/kit packs each tree as it is). release-assets builds on the installs it declares, the Go modules of the lease
# tool; the release workflow installs the npm packages of the TypeScript build first with make install-packages. The checks
# run offline (GOPROXY=off). The consumer projects install the archives, so their targets build the same trees.
release-assets: install-go typescript-build editor-build
release-consumer release-consumer-lock: typescript-build editor-build

# editor-build builds the editor packages that the release publishes: the language service, the language server and the
# CodeMirror extension, each on the TypeScript build.
.PHONY: editor-build
editor-build: typescript-build
	npm run --workspace @polyspec/dbspec-language build
	npm run --workspace @polyspec/dbspec-lsp build
	npm run --workspace @polyspec/dbspec-codemirror build
