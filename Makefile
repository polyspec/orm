.PHONY: check ci-group-needs ci-passed release-verify release-versions release-assets release-publish release-check feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check rerun-failed full-run-check version-check repo-check checklist-check ts-min-check php-min-check client-unit-check php-without-mysql-check client-db-check client-pooler-check case-database-check conformance-check dialect-facts-check conformance-counter-check conformance-result-check conformance-result-physical-check conformance-rust-group-check group-rows-physical-check unselected-column-physical-check decimal-bench-sqlite decimal-physical-check run-databases perf-check interface-check go-model-check ts-model-check ts-check typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check example-check timing-check fuzz-check docs-dev docs-build docs-check docs-verify-idempotent docs-rules-check feature-unit-check feature-check feature-docs package-check git-check github-ruleset github-ruleset-check github-check test-servers test-servers-tls test-servers-stop test-servers-leases test-servers-leases-clear
# 실패에서 멈추지 않는 target의 독립된 부분이다(scripts/check/run.mjs가 make -k로 실행한다).
.PHONY: checklist-check/unit checklist-check/run version-check/unit version-check/run repo-check/unit repo-check/run git-check/unit git-check/run rust-fmt-check/clients rust-fmt-check/bench rust-fmt-check/interfaces fuzz-check/engine-ir fuzz-check/clients-go-orm dialect-facts-check/probes dialect-facts-check/facts feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select testcase-check/go testcase-check/node testcase-check/runners testcase-check/php testcase-check/rust rust-check/check rust-check/clippy rust-check/clippy-live-db rust-check/clippy-test-faults ts-check/hold ts-check/types ts-check/test feature-check/build feature-check/coverage feature-check/verification client-unit-check/dsn client-unit-check/relation-keys client-unit-check/hostcodec client-unit-check/engine client-unit-check/runtime-model client-unit-check/orm-gen client-unit-check/perf-extensions
.NOTPARALLEL: check rerun-failed docs-check docs-verify-idempotent

# git은 core.hooksPath가 `.githooks`일 때만 추적하는 hook(`.githooks/commit-msg`, `.githooks/pre-push`)을 실행하고, 그
# 설정은 clone마다 따로 있다. 그래서 make는 실행마다 parse 때 그 설정을 둔다(값이 다를 때만 쓴다). CI의 make도 같다.
# commit-msg hook은 커밋하려는 subject를 git.subject-format(contracts/rules.json)으로 검사하고 어기면 커밋을 거부한다.
# pre-push hook은 push gate(scripts/check/push-gate.mjs)를 실행하고, gate는 checklist 항목이 `[~]`인 push를 거부한다
# (AGENTS.md). make hooks는 설정을 두고 hooks-check로 확인하며, hooks-check는 make owner-check의 첫 단계이고 전체
# suite의 guard도 같은 검사를 한다.
ifneq ($(shell git -C $(CURDIR) config core.hooksPath),.githooks)
$(shell git -C $(CURDIR) config core.hooksPath .githooks)
endif

# make test-servers starts the MySQL and PostgreSQL primaries, their replicas,
# and the ProxySQL and PgBouncer poolers of the database checks on free ports that it chooses
# and writes TEST_ENV; the database checks read TEST_ENV and fail when it is
# missing.
TEST_ENV = .runtime/servers/env
# DECIMAL_ENV는 decimal database의 DSN을 담은 file이다. decimal 검사와 feature-check의 decimal 명령이
# 그것을 읽는다. 함께 쓰는 decimal database는 없다: make check, make owner-check, make run-databases가
# 실행마다 자기 database와 file을 만들어(scripts/check/databases.sh) 이 변수와 TEST_ENV로 준다. bench
# database의 DSN(BENCH_*, ORM_BENCH_MYSQL_DSN)도 그 실행의 TEST_ENV에만 있다.
DECIMAL_ENV =
export DECIMAL_ENV

# 모든 cargo 명령(cargo +$(PHYSICAL_RUST_TOOLCHAIN), PATH의 cargo, feature coverage와 conformance
# check가 실행하는 cargo)은 한 toolchain과 한 target directory를 쓴다. toolchain이나 target이
# 둘이면 같은 crate를 다시 compile하고 target이 커진다(T27 측정: check 한 번에 clients/rust/target
# 10.4 GiB와 bench/rust/target 1.4 GiB).
# check는 한 번 build한 artifact를 실행하므로 incremental compile의 중간 결과(T27 측정: debug
# target 7.9 GiB 가운데 1.6 GiB)를 남기지 않고, debug build의 debug 정보는 panic과 backtrace의
# 줄 번호만 둔다.
# 그 toolchain은 rust-toolchain.toml의 channel 하나이고, CI도 그 file로 설치한다.
PHYSICAL_RUST_TOOLCHAIN := $(shell sed -n 's/^channel = "\(.*\)"$$/\1/p' rust-toolchain.toml)
export RUSTUP_TOOLCHAIN := $(PHYSICAL_RUST_TOOLCHAIN)
export CARGO_TARGET_DIR := $(abspath clients/rust/target)
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
# 실행으로 결과가 갈리지 않고 곧바로 실패하며, scripts/check/downloads.mjs가 그것을 `run make install`과 함께 적는다.
# download하는 target(install과 그 부분)만 $(ONLINE)으로 명령을 실행한다.
export CARGO_NET_OFFLINE := true
export GOPROXY := off
export npm_config_offline := true
export COMPOSER_DISABLE_NETWORK := 1
ONLINE := env -u CARGO_NET_OFFLINE -u GOPROXY -u npm_config_offline -u COMPOSER_DISABLE_NETWORK
# WITH_TEST_ENV는 TEST_ENV를 읽는다. pooler를 거치지 않는 server DSN ORM_TEST_MYSQL_SERVER_DSN과
# ORM_TEST_POSTGRES_SERVER_DSN도 TEST_ENV가 정의한다(make 밖의 go test도 같은 file을 읽는다).
# client-pooler-check가 ORM_TEST_*_DSN을 pooler DSN으로 바꾸어도 rollback 실패 case는 이 DSN으로
# server에서 transaction의 session을 끝낸다. ProxySQL은 text protocol의 KILL을 자기 client session의
# 명령으로 가로채기 때문이다.
# WITH_TEST_ENV는 또 이 줄의 shell이 끝날 때까지 server의 shared lease(tests/lease)를 가진다. lease
# directory는 TEST_ENV의 ORM_TEST_SERVERS_LEASES다. 서버의 정지, 새 시작, MySQL migration은 exclusive
# lease를 요구하므로 이 줄이 실행되는 동안 거부되고, 보유자로 이 줄을 적는다.
WITH_TEST_ENV = test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make test-servers" >&2; exit 1; }; . $(abspath $(TEST_ENV)) && $(BUILD_LEASE) && "$(LEASE)" hold "$${ORM_TEST_SERVERS_LEASES:?$(abspath $(TEST_ENV)) names no lease directory; run make test-servers to rewrite it}" shared --pid $$$$ &&

# GO_TEST는 Go test를 case마다 보고하게 실행한다. tests/go-test.mjs는 먼저 같은 package와 build
# tag의 build를 기한 없는 장기 작업 `go-build/<packages>`로 실행하고 그 뒤 go test를 실행한다. -v는 각
# case가 internal/testcase로 내는 RUN, STEP, PASS, FAIL 줄을 실행 중에 보이고, 각 case가 자기 기한을
# 가지므로 -timeout 0이 test binary 전체의 기한(기본 10분)을 끈다.
GO_TEST = node tests/go-test.mjs -v -timeout 0

# RUN_LONG은 자기 case를 보고하지 않는 장기 작업(build, 설치, format, lint, package 검사 같은 도구 실행)
# 하나를 기한 없이 실행한다(tests/run-long.mjs): `RUN <name> no-deadline`, 명령의 출력 줄을 STEP으로,
# 종료 코드와 PASS나 FAIL을 출력한다. 성공과 실패는 시계가 아니라 명령의 종료 코드와 오류로 정한다.
# 기한은 test case 안에만 있다.
RUN_LONG = node tests/run-long.mjs
# PUBLISH는 다른 실행이나 뒤의 단계가 읽는 build 출력 file을 같은 directory의 임시 file에 쓰고 rename으로
# 바꾼다(scripts/publish-output.sh): `$(PUBLISH) <output> <command>`에서 명령의 인자 @OUT@이 임시 file이고,
# @OUT@이 없으면 명령의 표준 출력이 임시 file이다. 읽는 쪽은 끝난 build의 file만 본다.
PUBLISH = sh $(abspath scripts/publish-output.sh)
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
# binary로 실행한다(tests/cargo-test.mjs: build와 복사, 그 다음 실행).
CARGO_TEST = node $(abspath tests/cargo-test.mjs)
# RUN_DIR은 target 실행 하나의 directory다($@와 make process id). 그 실행이 쓰는 stress 문서와 build한
# program의 복사본(RUN_TARGET, CARGO_TARGET_DIR과 같은 배치)을 둔다. 실행은 공유 target directory의
# program이 아니라 이 복사본을 실행한다. CARGO_COPY는 build와 복사를 한 lease 아래에서 한다
# (scripts/cargo-build-copy.sh). target은 끝에 RUN_DIR을 지운다.
RUN_DIR = $(abspath .runtime/run)/$@-$$PPID
RUN_TARGET = $(RUN_DIR)/target
CARGO_COPY = $(CARGO_LEASED) sh $(abspath scripts/cargo-build-copy.sh) $(RUN_TARGET)
# HOLD_TYPESCRIPT은 이 checkout의 TypeScript build 출력(clients/typescript의 dist와 생성한 model)을 make
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
TSC_BUILD = $(RUN_LONG) typescript-build -- node scripts/typescript/build.mjs

# check는 CHECK_TARGETS를 scripts/check/run.mjs로 하나씩 실행한다. runner는 실행마다 자기 bench
# database와 decimal database를 만들어 TEST_ENV와 DECIMAL_ENV로 넘기고 끝에 지우며, target마다
# RUN, 출력 줄(STEP), PASS나 FAIL과 경과 시간을 보고한다. feature-check의 검증 명령이 실행하는
# target(interface-check, php-without-mysql-check, perf-check, dbspec-go-check, dbspec-php-check,
# dbspec-rust-check, dbspec-ts-check, dbspec-compare-check)은 feature-check 안에서 한 번 실행되므로
# 목록에 다시 넣지 않는다. contracts/check-inputs.json은 target마다 scope를 선언한다: owner target은
# make owner-check도 고르고, suite target은 이 전체 suite에서만 실행한다.
CHECK_TARGETS = checklist-check full-run-check version-check testcase-check repo-check test-servers-check git-check github-check docs-rules-check docs-check docs-verify-idempotent go-model-check client-unit-check php-min-check ts-check ts-min-check rust-check go-fmt-check go-vet-check rust-fmt-check rust-150-check rust-driver-check example-check client-db-check codec-check fuzz-check client-pooler-check case-database-check dialect-facts-check conformance-check package-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-introspect-compare-check dbspec-plan-check dbspec-apply-check dbspec-plan-ts-check dbspec-plan-rust-check ts-model-check dbspec-plan-php-check dbspec-apply-php-check dbspec-apply-php-extension-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check feature-unit-check release-check feature-check feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check go-test-check
# CI는 make check를 CI group마다 job 하나로 나눠 동시에 실행한다(.github/workflows/ci.yml의 job test, matrix group).
# job마다 `make check GROUP=<group>`이 CI_TARGETS_<group>을 실행하고, group은 함께 CHECK_TARGETS의 모든 target을 한
# 번씩 실행한다(make repo-check가 확인한다). group은 CI 실행 하나에서 잰 target의 시간으로 가장 긴 group이 짧도록 나눈다:
# static은 database가 필요 없는 target, clients, conformance, dbspec은 database target, features는 feature-check(기능의
# coverage와 검증 명령), stress-mysql은 2000 table plan의 MySQL 적용(feature-stress-mysql-check), stress-pg-sqlite는 stress
# 문서의 bench와 PostgreSQL, SQLite 적용(feature-stress-pg-sqlite-check)이다. 로컬 make check는 GROUP 없이 모든 target을
# 실행한다.
CI_GROUPS = static clients conformance dbspec features stress-mysql stress-pg-sqlite
CI_TARGETS_static = checklist-check full-run-check version-check testcase-check repo-check test-servers-check git-check github-check docs-rules-check docs-check docs-verify-idempotent go-model-check client-unit-check php-min-check rust-check go-fmt-check go-vet-check rust-fmt-check rust-150-check codec-check fuzz-check package-check ts-model-check feature-unit-check release-check
CI_TARGETS_clients = rust-driver-check example-check client-db-check client-pooler-check dialect-facts-check go-test-check
CI_TARGETS_conformance = ts-check ts-min-check conformance-check feature-helper-check
CI_TARGETS_dbspec = case-database-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-introspect-compare-check dbspec-plan-check dbspec-apply-check dbspec-plan-ts-check dbspec-plan-rust-check dbspec-plan-php-check dbspec-apply-php-check dbspec-apply-php-extension-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check
CI_TARGETS_features = feature-check
CI_TARGETS_stress-mysql = feature-stress-mysql-check
CI_TARGETS_stress-pg-sqlite = feature-stress-pg-sqlite-check
# run-databases는 TARGETS의 make target을 실행 하나의 자기 bench database와 decimal database로 실행한다
# (scripts/check/run.mjs, make check와 같은 runner). bench나 decimal database를 쓰는 target을 직접 실행할 때
# 쓴다: TEST_ENV의 server 환경에는 그 database가 없다.
run-databases:
	$(BUILD_LEASE) && node scripts/check/run.mjs $(abspath $(TEST_ENV)) $(TARGETS)

# check는 전체 suite이고 rerun-failed는 그 suite에서 통과하지 못한 target만 다시 실행한다. 전체 suite는 push 뒤
# GitHub CI에서 실행되고(.github/workflows/ci.yml), 로컬 check는 push 전에 필요한 단계가 아니다. 두 진입점의 첫 줄은
# 전체 suite의 guard(scripts/check/full-run.mjs)다: 어떤 단계보다 먼저, test server 환경을 읽고 lease program을
# build하기 전에, docs/checklist.md의 항목(하위 항목 포함)이 [~]인 동안, 추적하는 file에 commit하지 않은 변경이
# 있는 동안, 그리고 check이면 .runtime/full-run.json이 같은 tree의 전체 실행을 기록하고 있을 때 이유를 출력하고
# 거부한다. runner(--full-run, --rerun-failed)는 실행을 기록하기 직전에 다시 결정하고, 첫 단계 전과 각 단계의
# 시작과 끝마다 기록을 쓴다. rerun-failed는 현재 commit이 기록된 commit(전체 실행이나 마지막 재실행)의 tree도
# 후손도 아니면 거부되고, 통과하지 못한 target과 그 commit 뒤에 바뀐 path가 고르는 owner target을 실행한다. 새
# checkout(GitHub CI)에는 기록이 없다. runner는 TEST_ENV를 setup 단계 servers로 읽고 그 server의 shared lease를
# 잡는다: file이 없으면(make test-servers가 실패했다) database가 필요한 target만 not-run으로 기록하고 나머지는
# 실행한다.
# GROUP은 CI group 하나(CI_TARGETS_<group>)만 실행한다. 그 실행은 GitHub Actions의 job 하나가 하는 전체 suite의 한
# 부분이므로 GITHUB_ACTIONS가 true일 때만 받는다: 로컬 checkout의 기록(.runtime/full-run.json)은 전체 실행이다.
CHECK_RUN_TARGETS = $(if $(GROUP),$(CI_TARGETS_$(GROUP)),$(CHECK_TARGETS))
check:
	$(if $(GROUP),$(if $(filter $(GROUP),$(CI_GROUPS)),,$(error GROUP $(GROUP) names no CI group; give one of CI_GROUPS: $(CI_GROUPS))))
	$(if $(GROUP),$(if $(filter true,$(GITHUB_ACTIONS)),,$(error GROUP runs one CI group of make check on GitHub Actions only; run make check without GROUP, which runs every target of CHECK_TARGETS)))
	node scripts/check/full-run.mjs decide check
	$(BUILD_LEASE) && node scripts/check/run.mjs --full-run $(abspath $(TEST_ENV)) $(CHECK_RUN_TARGETS)

# release-verify, release-versions, release-assets, release-publish는 release workflow(.github/workflows/release.yml)가 tag의
# push에서 이 순서로 실행하는 네 단계다(scripts/release/release.mjs). tag는 환경 변수 TAG로 받는다(release.yml이
# github.ref_name을 준다). verify는 tag한 commit이 main에 있고 그 check push-gate와 ci-passed가 성공했는지, versions는 tag의
# version이 release하는 모든 manifest와 변경 이력의 section과 같은지 확인하고, assets는 npm과 Composer의 asset을
# .runtime/release/assets에 만들며, publish는 그것과 변경 이력의 section으로 GitHub Release를 만든다. release-check는 그
# unit case다.
release-verify:
	node scripts/release/release.mjs verify "$$TAG"
release-versions:
	node scripts/release/release.mjs versions "$$TAG"
release-assets:
	node scripts/release/release.mjs assets "$$TAG"
release-publish:
	node scripts/release/release.mjs publish "$$TAG"
release-check:
	node --test scripts/release/release.test.mjs

# ci-passed는 ci.yml의 마지막 job ci-passed가 실행한다: 그 job이 needs로 받은 다른 모든 job의 결과(CI_NEEDS, `${{
# toJSON(needs) }}`)가 success일 때만 통과한다(scripts/check/ci-passed.mjs). ruleset은 이 check와 push-gate를 요구한다.
ci-passed:
	node scripts/check/ci-passed.mjs

# ci-group-needs는 CI group GROUP의 job이 실행할 setup step을 step output 줄(`<output>=true|false`)로 쓴다: group의
# target이 contracts/check-inputs.json에 선언한 need에서 정한다(scripts/check/ci-setup.mjs). workflow는 그 줄을
# $GITHUB_OUTPUT에 더하고, setup step은 자기 output이 true일 때만 실행한다.
ci-group-needs:
	$(if $(filter $(GROUP),$(CI_GROUPS)),,$(error GROUP $(GROUP) names no CI group; give one of CI_GROUPS: $(CI_GROUPS)))
	@node scripts/check/ci-setup.mjs outputs $(CI_TARGETS_$(GROUP))

rerun-failed:
	node scripts/check/full-run.mjs decide rerun-failed
	$(BUILD_LEASE) && node scripts/check/run.mjs --rerun-failed $(abspath $(TEST_ENV))

# bench는 성능 측정(2000 table stress 문서의 parse, 적용, introspection과 비교, CPU 시간)을 check와 같은
# runner로 target마다 실행한다. 측정은 출력하고 기준값을 넘으면 경고할 뿐 실패시키지 않는다(AGENTS.md).
BENCH_TARGETS = dbspec-stress-bench dbspec-apply-stress-bench dbspec-introspect-compare-bench dbspec-compare-bench timing-check
.PHONY: bench
bench:
	test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make test-servers" >&2; exit 1; }
	node scripts/check/run.mjs $(abspath $(TEST_ENV)) $(BENCH_TARGETS)

# go-test-check는 다른 target이 실행하지 않는 Go package의 test를 실행한다. clients/go의
# package는 client-db-check(scripts/client-db-test.sh), engine과 generator는 feature-check의
# 검증 명령(engine package마다 planner-go-*, engine/dbspec은 schema-go의 dbspec-go-check,
# generator는 generation-go), internal/testcase는 testcase-check가 같은 명령으로 실행한다.
GO_TEST_CHECK_PACKAGES = $$(go list ./... | grep -v -e '/clients/go/' -e '/engine$$' -e '/engine/' -e '/generator$$' -e '/internal/testcase$$')
.PHONY: go-test-check
go-test-check:
	$(WITH_TEST_ENV) $(GO_TEST) $(GO_TEST_CHECK_PACKAGES)

# testcase-check는 각 언어의 공유 case 보고 형식이 case마다 시작(RUN, 기한), 단계(STEP),
# 결과(PASS, FAIL과 이유)와 경과 시간을 이 순서로 출력하고, 기한이 지난 case를 FAIL로
# 보고하는지 하위 process의 출력으로 확인한다.
.PHONY: testcase-check
testcase-check: testcase-check/go testcase-check/node testcase-check/runners testcase-check/php testcase-check/rust
testcase-check/go:
	$(GO_TEST) ./internal/testcase -count=1
testcase-check/node:
	node --test tests/testcase.test.mjs
testcase-check/runners:
	node --test tests/go-test.test.mjs tests/cargo-test.test.mjs
testcase-check/php:
	php tests/testcase_test.php
testcase-check/rust: cargo-downloads-check
	cd clients/rust && $(CARGO_TEST) testcase-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-testcase

# client-pooler-check runs the client database tests through the PgBouncer
# pooler in transaction mode for PostgreSQL and the ProxySQL pooler for MySQL.
client-pooler-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" ./scripts/client-db-test.sh

checklist-check: checklist-check/unit checklist-check/run
checklist-check/unit:
	node --test scripts/checklist/check.test.mjs
checklist-check/run:
	node scripts/checklist/check.mjs

# full-run-check는 전체 suite의 guard와 runner(scripts/check/full-run.mjs, scripts/check/run.mjs)를 임시 git
# checkout과 stub 단계로 검사한다. 실제 target과 database는 실행하지 않는다.
full-run-check:
	node --test scripts/check/full-run.test.mjs scripts/check/continue.test.mjs scripts/check/step.test.mjs scripts/check/downloads.test.mjs scripts/check/push-gate.test.mjs scripts/check/ci-passed.test.mjs

# dbspec-rust-check는 공유 dbspec vector, Rust rule case, plan과 Mermaid case, 감싼 SQLite
# connection으로 주입한 apply 정리 error를 두 번 실행한다.
#
# DBSPEC_STRESS_DOCUMENT는 tests/dbspec/stress.mjs의 2000 table 문서다. 그 문서의 parse 시간,
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
# SQLite에 적용해 behavior step을 실행하고, 모든 schema/*.dbs와 contracts/fixtures/*.dbs의
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
	$(WITH_TEST_ENV) node --test clients/typescript/tests/dbspec-introspect.mjs

# dbspec-introspect-php-check는 같은 round trip과 미지원 case를 PHP client의
# Polyspec\Orm\Dbspec\Dbspec::introspect로 실행한다.
.PHONY: dbspec-introspect-php-check
dbspec-introspect-php-check:
	$(WITH_TEST_ENV) php clients/php/tests/dbspec_introspect_test.php

# dbspec-introspect-php-extension-check는 같은 round trip과 미지원 case를 PHP 확장 orm_dbspec의
# Polyspec\Orm\Dbspec\Native\Dbspec::introspect로 실행한다. 확장은 이 실행의 directory에 build한다.
.PHONY: dbspec-introspect-php-extension-check
dbspec-introspect-php-extension-check:
	$(RUN_LONG) php-extension-build -- sh clients/php-extension/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_introspect_test.php
	rm -rf $(RUN_DIR)

# dbspec-introspect-rust-check는 같은 round trip과 tests/dbspec/introspect.json의 case를 Rust
# client의 polyspec_orm::dbspec::introspect로 실행하고, 모든 집합에서 catalog query 8, 7, 3개를 확인한다.
.PHONY: dbspec-introspect-rust-check
dbspec-introspect-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd clients/rust && $(CARGO_TEST) dbspec-introspect-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_introspect -- --nocapture

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
# tests/dbspec/apply의 Go, PHP, TypeScript, Rust와 PHP 확장 orm_dbspec(이 실행의 directory에 build한다) runner의 모든 순서쌍마다 MySQL, PostgreSQL,
# SQLite에서 chain의 첫 plan을 한 client로, 나머지를 다른 client로 적용하고, 첫 client가 멈춘
# plan을 둘째 client가 recover로 마치며, 다시 멈춘 plan을 둘째 client가 rollback한다. history
# row와 introspect한 schema text가 chain의 것과 같아야 한다.
.PHONY: dbspec-apply-pairs-check
dbspec-apply-pairs-check: cargo-downloads-check lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(RUN_LONG) rust-build/dbspec_apply --cwd clients/rust -- $(CARGO_COPY) debug/examples/dbspec_apply -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm --example dbspec_apply
	$(RUN_LONG) php-extension-build -- sh clients/php-extension/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) DBSPEC_APPLY_RUST=$(RUN_TARGET)/debug/examples/dbspec_apply ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) $(GO_TEST) -tags physical ./tests/dialects -run '^TestApplyChainAcrossClients$$' -count=1
	rm -rf $(RUN_DIR)

# dbspec-apply-rust-check는 2000 table plan을 뺀 dbspec-apply-check의 scenario를 Rust client의
# polyspec_orm::dbspec::apply, recover, rollback, finalize로 실행한다.
.PHONY: dbspec-apply-rust-check
dbspec-apply-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd clients/rust && $(CARGO_TEST) dbspec-apply-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply -- --nocapture

# dbspec-plan-ts-check는 TypeScript client를 build하고 tests/dbspec/plans.json의 모든 case를
# 그 renderDbspec, planSteps, introspectDbspec으로 MySQL, PostgreSQL, SQLite에 적용한다.
.PHONY: dbspec-plan-ts-check
dbspec-plan-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test clients/typescript/tests/dbspec-plan-physical.mjs

# dbspec-apply-ts-check는 TypeScript client를 build하고 2000 table plan을 뺀 dbspec-apply-check의
# scenario를 그 applyPlans, recoverPlans, rollbackPlans, finalizePlans로 실행한다.
.PHONY: dbspec-apply-ts-check
dbspec-apply-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test clients/typescript/tests/dbspec-apply-physical.mjs

# dbspec-plan-rust-check는 같은 case를 Rust client의 plan step, renderer,
# polyspec_orm::dbspec::introspect로 적용한다.
.PHONY: dbspec-plan-rust-check
dbspec-plan-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd clients/rust && $(CARGO_TEST) dbspec-plan-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_plan_apply -- --nocapture

# dbspec-plan-php-check는 같은 case를 PHP client의 Polyspec\Orm\Dbspec\Dbspec::planSteps와
# Dbspec::introspect로 적용한다.
.PHONY: dbspec-plan-php-check
dbspec-plan-php-check:
	$(WITH_TEST_ENV) php clients/php/tests/dbspec_plan_apply_test.php

# dbspec-apply-php-check는 2000 table plan을 뺀 dbspec-apply-check의 scenario를 PHP client의
# Polyspec\Orm\Dbspec\Dbspec::apply, recover, rollback, finalize로 MySQL, PostgreSQL, SQLite에서 실행한다.
.PHONY: dbspec-apply-php-check
dbspec-apply-php-check:
	$(WITH_TEST_ENV) php clients/php/tests/dbspec_apply_test.php

# dbspec-apply-php-extension-check는 같은 scenario를 PHP 확장 orm_dbspec의 Polyspec\Orm\Dbspec\Native\Dbspec::apply,
# recover, rollback, finalize로 실행한다. 확장은 이 실행의 directory에 build한다.
.PHONY: dbspec-apply-php-extension-check
dbspec-apply-php-extension-check:
	$(RUN_LONG) php-extension-build -- sh clients/php-extension/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_apply_test.php
	rm -rf $(RUN_DIR)

# dbspec-introspect-compare-check는 stress 문서(DBSPEC_INTROSPECT_TABLES개 table)를 MySQL,
# PostgreSQL, SQLite에 적용하고, database마다 tests/dbspec/introspect의 Go, PHP, TypeScript, Rust와
# PHP 확장 orm_dbspec(이 실행의 directory에 build한다) introspection runner를 실행해 같은 출력, source schema text, 미지원 객체 없음을 요구하고, 각
# introspection의 시간을 출력하며 기준값을 넘으면 경고한다. dbspec-introspect-compare-bench는 같은 target을 2000
# table 문서와 release runner로 실행한다.
.PHONY: dbspec-introspect-compare-check dbspec-introspect-compare-bench
dbspec-introspect-compare-check: cargo-downloads-check lease-tool
	$(HOLD_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_INTROSPECT_DOCUMENT))
	$(PUBLISH) $(DBSPEC_INTROSPECT_DOCUMENT) node tests/dbspec/stress.mjs $(DBSPEC_INTROSPECT_TABLES)
	$(TSC_BUILD)
	$(RUN_LONG) rust-build/dbspec_introspect --cwd clients/rust -- $(CARGO_COPY) $(DBSPEC_INTROSPECT_DIR)/examples/dbspec_introspect -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --profile $(DBSPEC_INTROSPECT_PROFILE) --locked --offline -p polyspec-orm --example dbspec_introspect
	$(RUN_LONG) php-extension-build -- sh clients/php-extension/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) DBSPEC_STRESS_DOCUMENT=$(DBSPEC_INTROSPECT_DOCUMENT) DBSPEC_INTROSPECT_RUST=$(RUN_TARGET)/$(DBSPEC_INTROSPECT_DIR)/examples/dbspec_introspect ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) $(GO_TEST) -tags physical ./tests/dialects -run '^TestIntrospectCompare$$' -count=1
	rm -rf $(RUN_DIR)

dbspec-introspect-compare-bench:
	$(MAKE) --no-print-directory dbspec-introspect-compare-check DBSPEC_INTROSPECT_TABLES=2000 DBSPEC_INTROSPECT_PROFILE=release

# dbspec-compare-check는 Go, PHP, TypeScript, Rust dbspec runner와 PHP 확장 orm_dbspec의 runner를 tests/dbspec/cases.json,
# stress 문서(DBSPEC_COMPARE_TABLES개 table), tests/dbspec/ddl.json, tests/dbspec/plans.json, tests/dbspec/mermaid.json으로
# 각각 두 번 실행하고, 두 run의 출력이 처음 다른 case에서 실패한다. PHP 확장은 이 실행의 directory에
# build한다(PHP_EXTENSION_LIBRARY). 그 전에 모든 runner가
# section이나 field를 빼거나 type을 바꾼 vector를 위치를 밝힌 error로 거부해야 하고, compare,
# apply, Rust stress runner가 없거나 directory인 input을 그 경로와 함께 거부해야 한다. runner는
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
	node --test tests/dbspec/compare/check.test.mjs
dbspec-compare-check/prepare: cargo-downloads-check lease-tool
	$(HOLD_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_COMPARE_DOCUMENT))
	$(PUBLISH) $(DBSPEC_COMPARE_DOCUMENT) node tests/dbspec/stress.mjs $(DBSPEC_COMPARE_TABLES)
	$(TSC_BUILD)
	$(RUN_LONG) rust-build/dbspec_compare --cwd clients/rust -- $(CARGO_COPY) debug/examples/dbspec_compare debug/examples/dbspec_stress -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm-schema --example dbspec_compare --example dbspec_stress
	$(RUN_LONG) rust-build/dbspec_apply --cwd clients/rust -- $(CARGO_COPY) debug/examples/dbspec_apply -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm --example dbspec_apply
	$(RUN_LONG) php-extension-build -- sh clients/php-extension/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
dbspec-compare-check/runners: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) DBSPEC_STRESS_DOCUMENT=$(DBSPEC_COMPARE_DOCUMENT) node --test tests/dbspec/compare/runners.test.mjs
dbspec-compare-check/inputs: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) DBSPEC_STRESS_DOCUMENT=$(DBSPEC_COMPARE_DOCUMENT) node --test tests/dbspec/inputs.test.mjs
dbspec-compare-check/compare: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) node tests/dbspec/compare/check.mjs tests/dbspec/cases.json $(DBSPEC_COMPARE_DOCUMENT) tests/dbspec/ddl.json tests/dbspec/plans.json tests/dbspec/mermaid.json

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
	$(PUBLISH) $(DBSPEC_STRESS_DOCUMENT) node tests/dbspec/stress.mjs
dbspec-stress-bench/go: dbspec-stress-bench/prepare
	$(GO_TEST) -tags bench ./engine/dbspec -run '^TestStressDocument$$' -count=1
	$(GO_TEST) -tags bench ./engine/dbspec -run '^TestStressDocument$$' -count=1
dbspec-stress-bench/php: dbspec-stress-bench/prepare
	php clients/php/tests/dbspec_stress_test.php
	php clients/php/tests/dbspec_stress_test.php
dbspec-stress-bench/php-introspect: dbspec-stress-bench/prepare
	php clients/php/tests/dbspec_introspect_stress_test.php
dbspec-stress-bench/typescript: dbspec-stress-bench/prepare lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	node --test clients/typescript/tests/dbspec-stress.mjs
	node --test clients/typescript/tests/dbspec-stress.mjs
dbspec-stress-bench/rust: dbspec-stress-bench/prepare cargo-downloads-check
	$(RUN_LONG) rust-build/dbspec_stress --cwd clients/rust -- $(CARGO_COPY) release/examples/dbspec_stress -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p polyspec-orm-schema --example dbspec_stress
	$(RUN_TARGET)/release/examples/dbspec_stress $(abspath $(DBSPEC_STRESS_DOCUMENT))
	$(RUN_TARGET)/release/examples/dbspec_stress $(abspath $(DBSPEC_STRESS_DOCUMENT))

.PHONY: dbspec-rust-check/documents dbspec-rust-check/apply-cleanup
dbspec-rust-check: dbspec-rust-check/documents dbspec-rust-check/apply-cleanup
dbspec-rust-check/documents: cargo-downloads-check
	cd clients/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec --test dbspec_rules --test dbspec_manifest --test dbspec_render --test dbspec_runtime --test dbspec_plan --test dbspec_model --test dbspec_mermaid -- --nocapture
	cd clients/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec --test dbspec_rules --test dbspec_manifest --test dbspec_render --test dbspec_runtime --test dbspec_plan --test dbspec_model --test dbspec_mermaid -- --nocapture
dbspec-rust-check/apply-cleanup: cargo-downloads-check
	cd clients/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply_cleanup -- --nocapture
	cd clients/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply_cleanup -- --nocapture

.PHONY: rust-send-savepoint-check
# 부분의 실행 directory는 top target의 것이다($@에 /가 있으면 directory가 한 단계 더 생긴다).
rust-send-savepoint-check/%: RUN_DIR = $(abspath .runtime/run)/rust-send-savepoint-check-$$PPID
rust-send-savepoint-check: rust-send-savepoint-check/clippy rust-send-savepoint-check/test
.PHONY: rust-send-savepoint-check/clippy rust-send-savepoint-check/test
rust-send-savepoint-check/clippy: cargo-downloads-check
	$(RUN_LONG) rust-clippy/orm-lib --cwd clients/rust -- $(CARGO_LEASED) cargo +$(PHYSICAL_RUST_TOOLCHAIN) clippy --locked --offline -p polyspec-orm --lib -- -D warnings
rust-send-savepoint-check/test: cargo-downloads-check
	mkdir -p $(RUN_DIR)
	$(WITH_TEST_ENV) cd clients/rust && ORM_SEND_SQLITE_DSN=$(SEND_SQLITE_DSN) $(CARGO_TEST) rust-send-savepoint-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib tx::send_tests:: -- --nocapture
	$(WITH_TEST_ENV) cd clients/rust && ORM_SEND_SQLITE_DSN=$(SEND_SQLITE_DSN) $(CARGO_TEST) rust-send-savepoint-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib tx::send_tests:: -- --nocapture
	rm -rf $(RUN_DIR)

.PHONY: dbspec-php-check
# dbspec-php-check는 공유 dbspec vector, PHP rule, tests/dbspec/ddl.json의 statement vector,
# tests/dbspec/plans.json의 plan vector, tests/dbspec/mermaid.json의 Mermaid vector, 감싼 SQLite
# connection으로 주입한 apply 정리 error를 각각 두 번 실행한다. stress 문서는 make bench가
# 실행한다.
dbspec-php-check: dbspec-php-check/documents dbspec-php-check/rules dbspec-php-check/manifest dbspec-php-check/render dbspec-php-check/plan dbspec-php-check/mermaid dbspec-php-check/apply-cleanup
.PHONY: dbspec-php-check/documents dbspec-php-check/rules dbspec-php-check/manifest dbspec-php-check/render dbspec-php-check/plan dbspec-php-check/mermaid dbspec-php-check/apply-cleanup
dbspec-php-check/documents:
	php clients/php/tests/dbspec_test.php
	php clients/php/tests/dbspec_test.php
dbspec-php-check/rules:
	php clients/php/tests/dbspec_rules_test.php
	php clients/php/tests/dbspec_rules_test.php
dbspec-php-check/manifest:
	php clients/php/tests/dbspec_manifest_test.php
	php clients/php/tests/dbspec_manifest_test.php
dbspec-php-check/render:
	php clients/php/tests/dbspec_render_test.php
	php clients/php/tests/dbspec_render_test.php
dbspec-php-check/plan:
	php clients/php/tests/dbspec_plan_test.php
	php clients/php/tests/dbspec_plan_test.php
dbspec-php-check/mermaid:
	php clients/php/tests/dbspec_mermaid_test.php
	php clients/php/tests/dbspec_mermaid_test.php
dbspec-php-check/apply-cleanup:
	php clients/php/tests/dbspec_apply_cleanup_test.php
	php clients/php/tests/dbspec_apply_cleanup_test.php

.PHONY: dbspec-php-extension-check php-extension-arginfo
# dbspec-php-extension-check는 PHP 확장 orm_dbspec(clients/php-extension, PHP client의 dbspec 표면을 C로 구현한
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
.PHONY: dbspec-php-extension-check/arginfo dbspec-php-extension-check/prepare dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup
dbspec-php-extension-check: dbspec-php-extension-check/arginfo dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup
	rm -rf $(RUN_DIR)
dbspec-php-extension-check/arginfo:
	php clients/php-extension/scripts/arginfo.php $(GEN_STUB) check
dbspec-php-extension-check/prepare:
	$(RUN_LONG) php-extension-build -- sh clients/php-extension/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
dbspec-php-extension-check/declarations: dbspec-php-extension-check/prepare
	ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) php clients/php-extension/tests/declarations_test.php
	ORM_DBSPEC_EXTENSION=$(PHP_EXTENSION_LIBRARY) php clients/php-extension/tests/declarations_test.php
dbspec-php-extension-check/vectors: dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_test.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_test.php
dbspec-php-extension-check/plan: dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_plan_test.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_plan_test.php
dbspec-php-extension-check/mermaid: dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_mermaid_test.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_mermaid_test.php
dbspec-php-extension-check/apply-cleanup: dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_apply_cleanup_test.php
	php -d extension=$(PHP_EXTENSION_LIBRARY) clients/php-extension/tests/dbspec_apply_cleanup_test.php
php-extension-arginfo:
	php clients/php-extension/scripts/arginfo.php $(GEN_STUB) write

# repo-check는 root npm script가 쓰는 path가 tracked file이나
# directory인지, CI workflow가 make test-servers로 서버를 시작하고 그 환경 파일의 모든 변수를
# 검사 단계에 주는지(scripts/repo/ci.mjs) 확인한다.
# version-check는 VERSION 파일과 orm의 모든 version 선언(Rust manifest와 lockfile, PHP composer,
# TypeScript package와 lockfile, feature contract, 문서)이 같은지 확인한다.
version-check: version-check/unit version-check/run
version-check/unit:
	node --test scripts/version/check.test.mjs
version-check/run:
	node scripts/version/check.mjs

repo-check: repo-check/unit repo-check/run
repo-check/unit:
	$(BUILD_NEW_SESSION)
	NEW_SESSION=$(NEW_SESSION) node --test scripts/repo/check.test.mjs
repo-check/run:
	node scripts/repo/check.mjs

# test-servers-check는 test-servers.sh의 MySQL 설정 migration(scripts/test-servers-mysql.mjs)을 임시
# root의 서버로 검사한다: 다른 설정은 같은 수로 옮기고, 같은 설정은 아무것도 하지 않으며, 겹칠 이름은
# 바꾸기 전에 거부한다.
.PHONY: test-servers-check
# STOP_PROCESS는 test server를 멈출 때 process 종료를 운영체제의 알림으로 기다리는 program이다
# (tests/stop-process). 그 build는 장기 작업이므로 RUN_LONG으로 기한 없이 실행한다.
STOP_PROCESS = $(abspath .runtime/bin/stop-process)
BUILD_STOP_PROCESS = $(RUN_LONG) go-build/stop-process -- $(PUBLISH) $(STOP_PROCESS) go build -o @OUT@ ./tests/stop-process
# NEW_SESSION은 test server를 새 session에서 시작하는 program이다(tests/new-session): 시작한 shell의 process group을
# 끝내는 일이 함께 쓰는 server에 닿지 않는다.
NEW_SESSION = $(abspath .runtime/bin/new-session)
BUILD_NEW_SESSION = $(RUN_LONG) go-build/new-session -- $(PUBLISH) $(NEW_SESSION) go build -o @OUT@ ./tests/new-session

test-servers-check:
	$(BUILD_STOP_PROCESS)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) node --test scripts/test-servers.test.mjs scripts/test-servers-mysql.test.mjs

test-servers:
	$(BUILD_STOP_PROCESS)
	$(BUILD_NEW_SESSION)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) NEW_SESSION=$(NEW_SESSION) ./scripts/test-servers.sh start

# make test-servers-tls loads the TLS files of the MySQL TLS cases into running
# servers and writes their DSNs into TEST_ENV; make test-servers does it at the
# start.
test-servers-tls:
	./scripts/test-servers.sh tls

test-servers-stop:
	$(BUILD_STOP_PROCESS)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) ./scripts/test-servers.sh stop

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
# feature-check는 TypeScript client를 한 번 build한 뒤 모든 기능의 coverage(native test binary를 한 번
# build해 모든 실행이 쓴다)와 검증 명령을 실행한다. 검증 명령은 build된 client를 쓴다. helper check는
# feature-helper-check와 stress target(feature-stress-mysql-check, feature-stress-pg-sqlite-check)이 실행한다. 기능 하나는
# `node scripts/features/coverage.mjs --feature <id>`와 `node scripts/features/check.mjs --run --feature <id>`로
# 실행한다(test 환경 아래에서, owner-check가 하듯이).
# owner-check는 바뀐 file(PATHS, 없으면 HEAD에서 바뀐 file과 추적하지 않는 file)을 입력으로 선언한
# 기능의 검증 명령과 coverage만, 그리고 contracts/check-inputs.json이 scope owner로 선언한 target만
# 실행한다(AGENTS.md "Owner checks"). 그 전에 hooks-check가 pre-push hook의 설치를 확인한다.
.PHONY: hooks hooks-check
hooks:
	git config core.hooksPath .githooks
	node scripts/check/push-gate.mjs hooks-check
hooks-check:
	node scripts/check/push-gate.mjs hooks-check
# push-gate-commit은 CI(.github/workflows/push-gate.yml)가 push, pull request, merge group의 commit(COMMIT)에 실행하는 push gate다: 그 commit의
# checklist에 `[~]` 항목이 없고 commit이 .githooks/pre-push를 mode 100755로 추적해야 한다.
.PHONY: push-gate-commit
push-gate-commit:
	node scripts/check/push-gate.mjs commit $(COMMIT)

.PHONY: owner-check
owner-check: hooks-check
	$(WITH_TEST_ENV) ORM_OWNER_TEST_ENV=$(abspath $(TEST_ENV)) node scripts/features/owners.mjs $(PATHS)

feature-unit-check: feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select
feature-unit-check/docs:
	node scripts/features/build.mjs --check
feature-unit-check/coverage:
	node --test scripts/features/coverage.test.mjs
feature-unit-check/owners:
	node --test scripts/features/owners.test.mjs
feature-unit-check/select:
	node --test scripts/features/select.test.mjs

feature-check: feature-check/build feature-check/coverage feature-check/verification
feature-check/build: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
feature-check/coverage: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/coverage.mjs
feature-check/verification: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mjs --run --features
# feature-helper-check, feature-stress-mysql-check와 feature-stress-pg-sqlite-check는 contracts/features.json의 helper check를
# 실행한다. FEATURE_STRESS_HELPERS는 시간이 가장 긴 stress bench의 helper다: 2000 table plan의 MySQL 적용
# (FEATURE_STRESS_MYSQL_HELPERS)은 feature-stress-mysql-check가, stress 문서의 bench와 PostgreSQL, SQLite 적용
# (FEATURE_STRESS_PG_SQLITE_HELPERS)은 feature-stress-pg-sqlite-check가, 나머지 helper는 feature-helper-check가 실행한다. 그래서
# CI group들이 기능의 검증 명령, helper, stress bench를 동시에 실행한다.
# FEATURE_SUITE_HELPERS는 check가 make check의 다른 곳에서 실행되는 helper다: conformance-runners는 conformance-check,
# conformance-result는 그 선행 target conformance-result-check, case-database는 case-database-check, bench-database
# (scripts/bench-db.sh)는 runner의 setup 단계 databases/create(scripts/check/databases.sh)가 실행한다. feature-helper-check는
# 그 helper를 빼므로 make check는 helper check마다 한 번 실행한다(make repo-check가 확인한다). make owner-check는 helper의
# file이 바뀌면 그 helper check를 그대로 실행한다.
FEATURE_STRESS_MYSQL_HELPERS = dbspec-apply-stress-mysql
FEATURE_STRESS_PG_SQLITE_HELPERS = dbspec-stress dbspec-apply-stress-pg-sqlite
FEATURE_STRESS_HELPERS = $(FEATURE_STRESS_MYSQL_HELPERS) $(FEATURE_STRESS_PG_SQLITE_HELPERS)
FEATURE_SUITE_HELPERS = bench-database case-database conformance-result conformance-runners
feature-helper-check: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mjs --run --helpers $(addprefix --without-helper ,$(FEATURE_STRESS_HELPERS) $(FEATURE_SUITE_HELPERS))
feature-stress-mysql-check:
	$(WITH_TEST_ENV) node scripts/features/check.mjs --run $(addprefix --helper ,$(FEATURE_STRESS_MYSQL_HELPERS))
feature-stress-pg-sqlite-check: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mjs --run $(addprefix --helper ,$(FEATURE_STRESS_PG_SQLITE_HELPERS))

feature-docs:
	node scripts/features/build.mjs

package-check: lease-tool
	$(RUN_LONG) package -- ./scripts/package-check.sh

# fuzz-check는 fuzzing용으로 instrument한 build와 1초의 fuzzing(-fuzztime)을 함께 하는 장기 작업이므로
# 각 명령을 RUN_LONG으로 기한 없이 실행한다. fuzzing의 길이는 -fuzztime이 정한다.
fuzz-check: fuzz-check/engine-ir fuzz-check/clients-go-orm
fuzz-check/engine-ir:
	$(RUN_LONG) fuzz/engine-ir -- go test -v -timeout 0 ./engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s
fuzz-check/clients-go-orm:
	$(RUN_LONG) fuzz/clients-go-orm -- go test -v -timeout 0 ./clients/go/orm -run '^$$' -fuzz FuzzDecodeCiphertext -fuzztime=1s

# PHP는 client-unit-check가 실행하는 PHP program이다. 검사는 .php-version의 PHP를 PATH의 php로
# 쓰고, php-min-check는 composer.json이 지원하는 최저 release를 준다.
PHP = php
client-unit-check: client-unit-check/dsn client-unit-check/relation-keys client-unit-check/hostcodec client-unit-check/engine client-unit-check/runtime-model client-unit-check/orm-gen client-unit-check/perf-extensions
client-unit-check/dsn:
	$(PHP) clients/php/tests/dsn.php
client-unit-check/relation-keys:
	$(PHP) clients/php/tests/relation_keys.php
client-unit-check/hostcodec:
	$(PHP) clients/php/tests/hostcodec.php
client-unit-check/engine:
	$(PHP) clients/php/tests/engine_test.php
client-unit-check/runtime-model:
	$(PHP) clients/php/tests/runtime_model_test.php
client-unit-check/orm-gen:
	$(PHP) clients/php/tests/orm_gen_test.php
client-unit-check/perf-extensions:
	$(PHP) clients/php/tests/perf_extensions_test.php

# php-min-check runs the PHP client unit tests on the lowest PHP release that
# clients/php/composer.json supports.
php-min-check:
	PHP="$$(./scripts/php/php-min.sh)" && "$$PHP" --version && $(MAKE) --no-print-directory client-unit-check PHP="$$PHP"

# php-without-mysql-check는 MySQL driver(mysqlnd, pdo_mysql, mysqli)를 load하지 않은 PHP에서
# PHP client를 SQLite로 실행한다(N17): `php -n`에 client가 쓰는 확장만 명시한다. driver가
# shared module인 선언된 Linux runner(.github/runner)의 검사이며, driver가 compile된 PHP(macOS
# Homebrew)에서는 그 이유로 실패한다. make check의 feature-check는 Linux가 아니면 이 검사를
# 실행하지 않고 Linux runner에서 실행한다고 출력한다.
php-without-mysql-check:
	$(RUN_LONG) php-without-mysql -- ./scripts/php-without-mysql.sh

client-db-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANES=parallel ./scripts/client-db-test.sh

# dialect-facts-check runs the schema dialect probes of tests/dialects against
# the MySQL and PostgreSQL servers of TEST_ENV and a SQLite file per probe,
# and records which SQLite openers keep a DSN query in the file name.
dialect-facts-check: dialect-facts-check/probes dialect-facts-check/facts
dialect-facts-check/probes:
	$(GO_TEST) ./tests/dialects -run '^TestProbeIDs$$' -count=1
dialect-facts-check/facts:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/dialects -run '^(TestDialectFacts|TestSQLiteFileNameWithQuery)$$' -count=1

conformance-counter-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/conformance/check -run '^TestPhysical(CounterCleanup|FailedRunnerStateCheck|PostgresCounterOwner)$$' -count=1

# conformance-result-check는 TypeScript client를 build하고 PHP, TypeScript, Go conformance result
# test를 실행한다. 각 runner가 자기 case를 기한과 함께 보고한다.
conformance-result-check: conformance-result-check/php conformance-result-check/typescript conformance-result-check/go
.PHONY: conformance-result-check/php conformance-result-check/typescript conformance-result-check/go
conformance-result-check/php:
	php tests/conformance/result_php.php
conformance-result-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
	node --test tests/conformance/result_typescript.test.mjs
conformance-result-check/go:
	$(GO_TEST) ./tests/conformance/runner_go -count=1

conformance-result-physical-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/conformance/check -run '^TestPhysicalResultRunners$$' -count=1

conformance-rust-group-check: lease-tool
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./tests/conformance/check -run '^TestPhysicalRustGroupBoolean$$' -count=1

# BUILD_CONFORMANCE_STATE는 physical 검사의 state reader(`go run ./tests/conformance/check state`, case마다 기한이 있다)를
# case 앞에서 기한 없이 build한다: .runtime/bin에 publish하고 Go build cache가 그것을 가지므로 case의 go run은 build된 것을
# 실행한다.
BUILD_CONFORMANCE_STATE = $(RUN_LONG) go-build/conformance-state -- $(PUBLISH) $(abspath .runtime/bin/conformance-state) go build -o @OUT@ ./tests/conformance/check
group-rows-physical-check:
	$(BUILD_CONFORMANCE_STATE)
	$(WITH_TEST_ENV) node scripts/group-rows-physical-check.mjs

unselected-column-physical-check:
	$(BUILD_CONFORMANCE_STATE)
	$(WITH_TEST_ENV) node scripts/unselected-column-physical-check.mjs

# case-database-check는 공유 test database 두 곳에 table 하나를 남겨 둔 채 네 client의 model
# case를 실행하고, case가 통과하며 공유 database와 PostgreSQL schema를 바꾸지 않고 자기
# `orm_case_` database와 `orm-case-` SQLite file을 남기지 않는지 확인한다(T25).
case-database-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/integration --cwd clients/rust -- $(CARGO_COPY) debug/integration -- cargo build --locked -p polyspec-orm-tests --bin integration
	$(WITH_TEST_ENV) CARGO_TARGET_DIR=$(RUN_TARGET) node scripts/case-database-check.mjs
	rm -rf $(RUN_DIR)

# conformance-check는 네 client의 conformance runner를 MySQL, PostgreSQL, SQLite의 bench database에서 실행해
# output을 vector 기대값과 비교하고, 그 실행의 output을 공통 state contract(contracts/interfaces.json의
# sequences)와 비교한다. output은 이 실행의 RUN_DIR에만 쓰고 끝에 지우므로, 결과는 tree에만 달렸고 이전
# 실행이 남긴 output을 읽지 않는다. interfaces checker는 Rust 추출기를 target lease 아래에서 build한다.
# conformance-check의 부분은 서로 독립이다: counter, result, physical result 검사가 실패해도 conformance 실행(run)은
# 실행된다(make -k).
conformance-check/%: RUN_DIR = $(abspath .runtime/run)/conformance-check-$$PPID
.PHONY: conformance-check/run
conformance-check: conformance-counter-check conformance-result-check conformance-result-physical-check conformance-check/run
conformance-check/run: lease-tool
	$(HOLD_TYPESCRIPT)
	rm -rf $(RUN_DIR)
	$(WITH_TEST_ENV) node tests/go-run.mjs conformance-check ./tests/conformance/check run -out $(RUN_DIR)/out -driver mysql -dsn "$$BENCH_MYSQL_DSN" -driver postgres -dsn "$$BENCH_POSTGRES_DSN" -driver sqlite -dsn "$$BENCH_SQLITE_DSN"
	PATH="$(HOME)/.cargo/bin:$(PATH)" node tests/go-run.mjs interfaces-check ./tests/interfaces/check --results $(RUN_DIR)/out --results $(RUN_DIR)/out/postgres --results $(RUN_DIR)/out/sqlite
	rm -rf $(RUN_DIR)

decimal-bench-sqlite: lease-tool
	./scripts/decimal-bench-sqlite.sh

# decimal-physical-check의 case는 owner process마다 기한(scripts/decimal-physical-check.mjs의 timeoutMs)을 가진다. 그 process가
# 쓰는 build(Rust test binary decimal_physical, Go decimalmodel test, Go state reader BUILD_CONFORMANCE_STATE)는 장기
# 작업이므로 case 앞에서 기한 없이 RUN_LONG으로 먼저 하고(Go build는 .runtime/bin에 publish하며 build cache를 채운다), case는
# build된 것을 실행한다.
decimal-physical-check: cargo-downloads-check lease-tool
	$(READ_TYPESCRIPT)
	test -n "$(DECIMAL_ENV)" -a -f "$(DECIMAL_ENV)" || { echo 'DECIMAL_ENV names no decimal database of this run; run make run-databases TARGETS=$@' >&2; exit 1; }
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/decimal-physical -- $(CARGO_LEASED) cargo test --no-run --offline --locked --manifest-path clients/rust/Cargo.toml -p polyspec-orm-tests --bin decimal_physical
	$(RUN_LONG) go-build/decimal-physical -- $(PUBLISH) $(abspath .runtime/bin/decimalmodel.test) go test -c -o @OUT@ -tags decimalphysical ./clients/go/decimalmodel
	$(BUILD_CONFORMANCE_STATE)
	. $(DECIMAL_ENV) && node scripts/decimal-physical-check.mjs

interface-check: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" node tests/go-run.mjs interfaces-check ./tests/interfaces/check --self-test

go-model-check:
	$(RUN_LONG) go-model -- sh -c 'cd clients/go/model && go generate ./ && git diff --exit-code -- .'

# ts-model-check builds the TypeScript client, then fails when the models
# script scans a source that does not call models or misses one that does,
# or when the committed src/models/models.ts differs from its output.
ts-model-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	node --test clients/typescript/tests/models-scan.mjs

perf-check:
	$(WITH_TEST_ENV) ./scripts/perf-test.sh

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
	$(WITH_TEST_ENV) PATH="$$(./scripts/typescript/node-min.sh):$$PATH" && export PATH && node --version && npm run typescript:test

# dbspec-ts-check는 TypeScript client를 build하고, 공유 dbspec vector, plan vector, Mermaid
# vector, apply 정리 error, 그것들이 아직 다루지 않는 rule을 실행한다. stress 문서는 make bench가
# 실행한다.
.PHONY: dbspec-ts-check
dbspec-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	node --test clients/typescript/tests/dbspec.mjs clients/typescript/tests/dbspec-rules.mjs clients/typescript/tests/dbspec-render.mjs clients/typescript/tests/dbspec-plan.mjs clients/typescript/tests/dbspec-mermaid.mjs clients/typescript/tests/dbspec-apply-cleanup.mjs

# dbspec-go-check는 Go dbspec engine package(engine/dbspec)의 test를 모두 실행한다: tests/dbspec/cases.json의
# 공유 vector, 자기 rule case, manifest, statement, plan, comparison, Mermaid vector, apply 정리 error,
# case harness, 그리고 모든 vector file의 빠지거나 type이 틀린 field를 위치와 함께 거부하는지. stress
# 문서(TestStressDocument, build tag bench)는 make bench가 실행한다.
.PHONY: dbspec-go-check
dbspec-go-check:
	$(GO_TEST) ./engine/dbspec -count=1

docs-dev:
	npm run docs:dev

docs-build:
	npm run docs:build

# docs-ci는 CI(ci.yml)의 job docs가 실행하는 문서 검사(docs-verify-idempotent, docs-check)를 make check의 runner로
# test server 없이 실행한다(scripts/check/run.mjs `-`). 실패해도 다음 target을 실행하고, target마다의 log와 summary를
# .runtime/check/<실행 id>/report에 남기며, workflow는 그것을 job summary와 artifact로 올린다.
docs-ci:
	node scripts/check/run.mjs - docs-verify-idempotent docs-check

docs-check:
	npm run docs:check

docs-verify-idempotent:
	npm run docs:verify-idempotent

docs-rules-check:
	npm run docs:rules-check

# go-fmt-check fails when gofmt would change a tracked Go source and lists
# the files it would change.
.PHONY: go-fmt-check
go-fmt-check:
	@$(RUN_LONG) go-fmt -- sh -c 'files=$$(gofmt -l $$(git ls-files "*.go")); if [ -n "$$files" ]; then echo "gofmt would change:"; echo "$$files"; exit 1; fi; echo "every tracked Go source is gofmt formatted"'

# go-vet-check runs go vet over every Go package of the module, test files
# included.
.PHONY: go-vet-check
go-vet-check:
	$(RUN_LONG) go-vet -- go vet ./...

# codec-check는 PHP codec으로 tests/codec/vectors.json을 decode하고 encode한 뒤, 이 target이 실행한 Go, Rust,
# TypeScript codec test가 이 make 실행의 directory(CODEC_OUT, ORM_CODEC_OUT)에 쓴 출력을 decode한다
# (tests/codec/README.md). 다른 target이나 앞선 실행이 쓴 출력은 읽지 않으므로, 그 출력은 언제나 이 checkout의
# 지금 code의 것이다. 세 writer는 서로 독립된 부분이므로 하나가 실패해도 나머지가 실행되고(make -k), 비교는 세
# 출력을 모두 읽으므로 그 뒤에 온다. 실패한 실행의 directory는 runner가 보고서로 옮긴다.
CODEC_OUT = $(abspath .runtime/run)/codec-check-$$PPID
.PHONY: codec-check codec-check/go codec-check/rust codec-check/typescript codec-check/compare
codec-check: codec-check/compare
codec-check/go:
	mkdir -p $(CODEC_OUT)
	ORM_CODEC_OUT=$(CODEC_OUT) $(GO_TEST) ./clients/go/orm -run '^TestCodecVectors$$' -count=1
codec-check/rust: cargo-downloads-check
	mkdir -p $(CODEC_OUT)
	cd clients/rust && ORM_CODEC_OUT=$(CODEC_OUT) $(CARGO_TEST) codec-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --lib codec::tests::vectors -- --exact
codec-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	mkdir -p $(CODEC_OUT)
	$(TSC_BUILD)
	ORM_CODEC_OUT=$(CODEC_OUT) node clients/typescript/tests/codec-vector.mjs
codec-check/compare: codec-check/go codec-check/rust codec-check/typescript
	ORM_CODEC_OUT=$(CODEC_OUT) php tests/codec/check.php
	rm -rf $(CODEC_OUT)

# rust-fmt-check fails when cargo fmt would change a source of the Rust
# workspace (clients/rust/rustfmt.toml).
# rust-fmt-check는 저장소의 모든 Rust workspace(clients/rust, bench/rust, tests/interfaces/rust)가 cargo fmt로
# 정리되어 있는지 확인한다.
rust-fmt-check: rust-fmt-check/clients rust-fmt-check/bench rust-fmt-check/interfaces
rust-fmt-check/clients:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt --cwd clients/rust -- cargo fmt --all --check
rust-fmt-check/bench:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt/bench --cwd bench/rust -- cargo fmt --all --check
rust-fmt-check/interfaces:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt/interfaces --cwd tests/interfaces/rust -- cargo fmt --all --check

rust-150-check: lease-tool
	$(RUN_LONG) rust-150 -- ./scripts/check-rust-150.sh

rust-check: rust-check/check rust-check/clippy rust-check/clippy-live-db rust-check/clippy-test-faults
rust-check/check: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-check/check --cwd clients/rust -- $(CARGO_LEASED) cargo check --locked
rust-check/clippy: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-check/clippy --cwd clients/rust -- $(CARGO_LEASED) cargo clippy --locked --workspace --all-targets -- -D warnings
rust-check/clippy-live-db: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-check/clippy-live-db --cwd clients/rust -- $(CARGO_LEASED) cargo clippy --locked -p polyspec-orm-build --all-targets --features live-db -- -D warnings
rust-check/clippy-test-faults: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-check/clippy-test-faults --cwd clients/rust -- $(CARGO_LEASED) cargo clippy --locked -p polyspec-orm --all-targets --features test-faults -- -D warnings

# install은 check가 읽는 것을 download한다: npm package(root와 TypeScript client), Composer package, Rust
# toolchain과 Cargo.lock마다의 crate, Go module, ts-min-check의 가장 낮은 Node, PHP 확장의 gen_stub.php와 PHP-Parser.
# 이미 받은 것은 다시 받지 않는다.
# 부분은 서로 독립이다(make -k).

.PHONY: docs-ci
.PHONY: install install-node install-php install-rust install-go install-node-min install-server-programs install-php-extension-tools ci-php-min-version ci-php-sqlite downloads-check cargo-downloads-check
install: install-node install-php install-rust install-go install-node-min install-php-extension-tools
install-node:
	$(ONLINE) npm ci
	$(ONLINE) npm ci --prefix clients/typescript
install-php:
	$(ONLINE) composer install --working-dir=clients/php --no-interaction --no-progress --prefer-dist
install-rust:
	PATH="$(HOME)/.cargo/bin:$(PATH)" rustup toolchain install
	PATH="$(HOME)/.cargo/bin:$(PATH)" rustc --version
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path clients/rust/Cargo.toml
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path bench/rust/Cargo.toml
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path tests/interfaces/rust/Cargo.toml
install-go:
	$(ONLINE) go mod download
install-node-min:
	$(ONLINE) ORM_NODE_MIN_INSTALL=1 ./scripts/typescript/node-min.sh
# install-server-programs는 CI의 Linux runner에 make test-servers가 시작하는 server program을 설치한다
# (scripts/ci/server-programs.sh).
install-server-programs:
	$(ONLINE) ./scripts/ci/server-programs.sh
# install-php-extension-tools는 PHP 확장 orm_dbspec의 build가 쓰는 phpize와 php-config가 PATH의 PHP 것인지 확인하고,
# 그 PHP의 gen_stub.php와 PHP-Parser를 .runtime/bin/gen-stub에 둔다(scripts/ci/php-extension-tools.sh).
install-php-extension-tools:
	$(ONLINE) ./scripts/ci/php-extension-tools.sh

# CI의 setup step은 모두 make target을 실행한다(make repo-check). ci-php-min-version은 make php-min-check의 가장 낮은
# PHP release를 setup-php의 입력(version=x.y)으로 적고, ci-php-sqlite는 PATH의 두 PHP와 그것이 link한 SQLite를
# 확인한다.
ci-php-min-version:
	@echo "version=$$(./scripts/php/php-min.sh --version)"
ci-php-sqlite:
	"$$(./scripts/php/php-min.sh)" --version
	php scripts/ci/php-sqlite.php

# downloads-check는 check가 읽는 download가 모두 있는지 network 없이 확인하고, 빠진 것을 `run make install`과
# 함께 적는다(scripts/check/downloads.mjs). cargo-downloads-check는 그 가운데 crate만 본다: cargo를 --offline으로
# 실행하는 target은 그것을 먼저 실행하므로, 빠진 crate는 cargo의 "retry without --offline" 대신 make install을 적고
# 실패한다.
downloads-check:
	node scripts/check/downloads.mjs
cargo-downloads-check:
	node scripts/check/downloads.mjs --need rust

# rust-driver-check는 bench/rust의 native와 driver_compare를 DSN 없이 실행해 거부를 확인하고,
# 시드된 bench database에서 한 번에 하나씩 실행해 모든 workload가 끝나는지 확인한다.
rust-driver-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd bench/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) rust-driver-check -- cargo test --locked --offline -- --test-threads=1

# example-check는 examples/complex와 examples/thin-slice의 Go, PHP, Rust 프로그램을 시드된
# bench database에서 실행하고 README의 diff처럼 stdout이 byte 단위로 같은지 비교한다.
example-check: cargo-downloads-check
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/examples --cwd clients/rust -- $(CARGO_COPY) debug/complex debug/demo -- cargo build --locked --offline -p polyspec-orm-tests --bin complex --bin demo
	$(WITH_TEST_ENV) EXAMPLE_RUST_COMPLEX=$(RUN_TARGET)/debug/complex EXAMPLE_RUST_DEMO=$(RUN_TARGET)/debug/demo $(GO_TEST) -tags examples ./examples -run '^TestExampleOutputsAreIdentical$$' -count=1
	rm -rf $(RUN_DIR)

# timing-check는 자기 계산의 시간을 재는 Go, Rust, PHP, TypeScript test를 process group이 CPU를 일부만 받도록
# 멈추며 실행하고, 각 test가 그대로 통과하며 측정을 출력하는지 확인한다. 성능은 측정할 뿐 test를 실패시키지
# 않는다(AGENTS.md). 2000 table stress 문서를 쓰므로 make bench가 실행한다.
TIMING_GO_DBSPEC_TEST = $(RUN_DIR)/dbspec.test
timing-check: cargo-downloads-check lease-tool
	$(HOLD_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT)) $(dir $(TIMING_GO_DBSPEC_TEST))
	$(PUBLISH) $(DBSPEC_STRESS_DOCUMENT) node tests/dbspec/stress.mjs
	$(RUN_LONG) go-build/dbspec-test -- $(PUBLISH) $(TIMING_GO_DBSPEC_TEST) go test -c -tags bench -o @OUT@ ./engine/dbspec
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/dbspec_stress --cwd clients/rust -- $(CARGO_COPY) release/examples/dbspec_stress -- cargo build --release --locked --offline -p polyspec-orm-schema --example dbspec_stress
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/orm-schema-tests --cwd clients/rust -- $(CARGO_LEASED) cargo test --locked --offline -p polyspec-orm-schema --no-run
	$(RUN_LONG) typescript-build -- npm run typescript:build
	PATH="$(HOME)/.cargo/bin:$(PATH)" DBSPEC_STRESS_DOCUMENT=$(abspath $(DBSPEC_STRESS_DOCUMENT)) TIMING_GO_DBSPEC_TEST=$(abspath $(TIMING_GO_DBSPEC_TEST)) TIMING_RUST_STRESS=$(RUN_TARGET)/release/examples/dbspec_stress node --test --test-concurrency=1 tests/timing/preempted.test.mjs
	rm -rf $(RUN_DIR)

typescript-build: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build

git-check: git-check/unit git-check/run
git-check/unit:
	node --test scripts/git/check.test.mjs
git-check/run:
	node scripts/git/check.mjs

# GH는 저장소 관리 권한으로 인증된 개발 machine의 GitHub CLI이며, github-ruleset과 github-ruleset-check만 이를 실행한다.
GH := gh
# .github/ruleset.json의 GitHub ruleset main과 저장소 설정(scripts/github/ruleset.mjs): main은 pull request와 merge
# queue로만 변경을 받고, merge group에서 check push-gate와 ci.yml의 job test, docs가 통과한 뒤에 받으며, 이 저장소의 어떤 target도 main을
# push하지 않는다. 두 target은 GitHub API에 닿으므로 full suite의 어떤 target도 실행하지 않고, github-check가 가짜
# GitHub CLI로 script를 검사한다.
github-ruleset: ## Change the repository settings and create or update the ruleset of .github/ruleset.json where they differ, then compare again
	node scripts/github/ruleset.mjs apply --gh $(GH)
github-ruleset-check: ## Fail when the live repository settings or ruleset differ from .github/ruleset.json, naming each field
	node scripts/github/ruleset.mjs check --gh $(GH)
github-check:
	node --test scripts/github/ruleset.test.mjs
