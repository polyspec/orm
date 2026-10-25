.PHONY: split-null-check/ts split-null-check/php split-null-check/python split-null-check/rust split-null-check/go split-null-check/php-extension
.PHONY: split-read-plan-check split-read-plan-check/go split-read-plan-check/ts split-read-plan-check/python split-read-plan-check/rust
.PHONY: dbspec-lock-go-check dbspec-lock-php-check dbspec-lock-php-extension-check dbspec-lock-python-check dbspec-lock-rust-check dbspec-lock-ts-check
.PHONY: paged-read-rust-check
.PHONY: complex-query-rust-check
.PHONY: orm-check check-run databases-create ci-group-needs feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check runner-check version-check comment-language-check repo-check ts-min-check php-min-check client-unit-check php-without-mysql-check client-db-check client-pooler-check case-database-check conformance-check dialect-facts-check conformance-counter-check conformance-result-check conformance-result-physical-check conformance-rust-group-check group-rows-physical-check unselected-column-physical-check decimal-bench-sqlite decimal-physical-check run-databases perf-check interface-check go-model-check ts-model-check ts-check ts-save-key-check ts-aes-auth-check ts-codec-errors-check scripts-typecheck typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check example-check timing-check fuzz-check docs-dev docs-build docs-check docs-parse-check docs-site-check docs-site-parse-check docs-verify-idempotent docs-rules-check docs-implementation-count-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check orm-install-cli-check feature-unit-check feature-check feature-coverage feature-verify-rust feature-verify-other feature-docs package-check orm-test-servers orm-test-servers-tls orm-test-servers-stop orm-test-servers-leases orm-test-servers-leases-clear sqlite-version-ts-check sqlite-version-rust-check relation-parent-bind-rust-check split-null-check
# It is an independent part of the target that does not stop at a failure (scripts/check/run.mts runs it with make -k).
.PHONY: version-check/unit version-check/run comment-language-check/unit comment-language-check/run repo-check/unit repo-check/run rust-fmt-check/clients rust-fmt-check/bench rust-fmt-check/interfaces fuzz-check/engine-ir fuzz-check/clients-go-orm dialect-facts-check/probes dialect-facts-check/facts feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select testcase-check/go testcase-check/node testcase-check/runners testcase-check/rust rust-check/check rust-check/clippy rust-check/clippy-live-db rust-check/clippy-test-faults ts-check/hold ts-check/types ts-check/test feature-check/build client-unit-check/dsn client-unit-check/markdown client-unit-check/relation-keys client-unit-check/code-catalog client-unit-check/hostcodec client-unit-check/codec-aes client-unit-check/insert-parts client-unit-check/engine client-unit-check/runtime-model php-gen-unit-check client-unit-check/orm-gen client-unit-check/model-methods client-unit-check/client-generics client-unit-check/perf-extensions client-unit-check/dbspec-runners
.PHONY: aes-rotation-php-extension-check
.PHONY: request-hook-php-extension-check
.PHONY: t182-php-extension-model-check t182-php-extension-schema-check
.PHONY: request-hook-rust-check
.PHONY: rust-causes-check rust-closed-executor-check
.PHONY: go-catalog-session-error-check
.PHONY: catalog-php-extension-surface-check
.PHONY: transaction-failure-php-extension-check
.PHONY: mysql-session-php-extension-check
.PHONY: listen-notify-php-extension-check
.PHONY: transaction-failure-go-check
.PHONY: transaction-failure-php-check
.PHONY: transaction-failure-typescript-check
.PHONY: transaction-failure-python-check
.PHONY: transaction-failure-rust-check
.PHONY: connection-timeout-php-extension-check connection-busy-timeout-php-extension-check connection-statement-timeout-php-extension-check connection-sqlite-concurrent-writers-python-check connection-sqlite-read-during-write-python-check connection-sqlite-read-during-write-php-extension-check
.PHONY: connection-statement-timeout-typescript-check
.PHONY: connection-pool-resource-bounds-typescript-check
.PHONY: connection-utc-typescript-check
.PHONY: connection-utc-php-extension-check
.PHONY: connection-utc-php-check
.PHONY: connection-utc-rust-check
.PHONY: go-package-entry-check
.PHONY: php-package-entry-check
.PHONY: php-extension-package-entry-check
.PHONY: rust-package-entry-check
.PHONY: typescript-package-entry-check
.PHONY: complex-query-typescript-unit-check
.PHONY: complex-query-typescript-check
.PHONY: complex-query-typescript-request-check
.PHONY: complex-query-php-db-check
.PHONY: complex-query-php-extension-db-check
.PHONY: python-package-entry-check
.PHONY: native-arginfo-php-extension-check
.NOTPARALLEL: check check-run docs-check docs-verify-idempotent

.PHONY: blind-index-source-go-check blind-index-source-php-check blind-index-source-php-extension-check blind-index-source-ts-check blind-index-source-python-check blind-index-source-rust-check
.PHONY: complex-query-go-plan-check complex-query-rust-plan-check

WORKTREE_STOP = orm-test-servers-stop



# git runs the tracked hooks (.githooks/commit-msg, .githooks/pre-push) only when core.hooksPath is .githooks, a setting of
# each clone, which the kit.mk of @polyspec/kit sets at parse time on every make run. Each hook runs a make target: the
# commit-msg hook runs commit-msg-check, which checks the message being committed against the commit rules of @polyspec/kit and refuses
# a commit that breaks it, and the pre-push hook runs push-gate-hook, the push gate of kit, which refuses a push while a
# checklist item is [~] (AGENTS.md). make hooks sets the setting and hooks-check checks it.

# make orm-test-servers starts the MySQL and PostgreSQL primaries, their replicas,
# and the ProxySQL and PgBouncer poolers of the database checks on free ports that it chooses
# and writes TEST_ENV; the database checks read TEST_ENV and fail when it is
# missing.
TEST_ENV = .runtime/servers/env
# ORM_TEST_ENV is the absolute path of the TEST_ENV that this make reads, and like DECIMAL_ENV it is
# passed to the process that the recipe starts. A make variable changes a Makefile value only on the command line, so the commands that start a sub-make (the helper check of contracts/
# features.json) pass it as TEST_ENV="$$ORM_TEST_ENV". make owner-check
# (scripts/features/owners.mts) changes it to the environment file of its own run.
export ORM_TEST_ENV = $(abspath $(TEST_ENV))
# DECIMAL_ENV is the file that holds the DSN of the decimal database. The decimal check and the decimal command of feature-check
# read it. No decimal database is shared: make orm-check, make owner-check, and make run-databases
# create their own databases and files for each run (scripts/check/databases.mts) and pass them with this variable and TEST_ENV. The bench
# database DSNs (BENCH_*, ORM_BENCH_MYSQL_DSN) are also in the TEST_ENV of that run only.
DECIMAL_ENV =
export DECIMAL_ENV

# All cargo commands (cargo +$(PHYSICAL_RUST_TOOLCHAIN), the cargo on PATH, and the cargo that the feature coverage and conformance
# check runs) use one toolchain and one target directory. With two toolchains or two targets, the same crate is
# compiled again and the target grows (T27 measurement: 10.4 GiB for packages/rust/target
# and 1.4 GiB for benchmarks/rust/target).
# check runs the artifacts that one build made, so it leaves no intermediate results of incremental compilation (T27 measurement: 1.6 GiB of the
# 7.9 GiB debug target), and the debug information of a debug build is limited, for panics and backtraces, to
# line numbers only.
# That toolchain is the single channel in rust-toolchain.toml, and CI installs from that file too.
PHYSICAL_RUST_TOOLCHAIN := $(shell sed -n 's/^channel = "\(.*\)"$$/\1/p' rust-toolchain.toml)
export RUSTUP_TOOLCHAIN := $(PHYSICAL_RUST_TOOLCHAIN)
export CARGO_TARGET_DIR := $(abspath packages/rust/target)
# The target directory is inside this checkout (AGENTS.md). cargo decides whether an artifact is fresh
# only from the path (relative to the package root) and mtime of each source file, and does not record which checkout built it,
# so a target directory from another checkout tests that checkout's build as if it were this checkout's. If the CARGO_TARGET_DIR on a command
# line points outside this checkout, make stops without running anything.
ifeq ($(filter $(abspath .)/%,$(abspath $(CARGO_TARGET_DIR))),)
$(error CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) is outside this checkout $(abspath .); each checkout builds Rust into its own target directory (AGENTS.md), because cargo would reuse what another checkout built as fresh)
endif
export CARGO_INCREMENTAL := 0
# A worktree builds its Rust tests with debug = 0: the line tables are dropped, which makes the test build about 27% smaller (4.5 GB
# to 3.3 GB), while panic and assertion locations keep file:line. The value is recursive, so it expands after kit's include sets
# KIT_WORKTREE. Main keeps line-tables-only; its packages/rust/target is regenerable, so a worktree does not share it.
export CARGO_PROFILE_DEV_DEBUG = $(if $(KIT_WORKTREE),0,line-tables-only)
# ORM_RUST_TEST_FEATURES is the feature used by Rust tests. All cargo test commands (client DB tests,
# feature coverage and verification commands, dbspec Rust check) use `--workspace --features
# $(ORM_RUST_TEST_FEATURES)` to fix the dependency features the same way, share one test build, and run only their own tests with `--test` and a
# name filter. Choosing a package with `-p` changes the features, so the same crate is
# compiled again. test-faults adds only the fault-injection module, and live-db is a feature that
# the dev-dependency of polyspec-orm-tests already turns on.
export ORM_RUST_TEST_FEATURES := polyspec-orm/test-faults,polyspec-orm-build/live-db
# check does not read the network: make install downloads what check reads, and every recipe and the
# script it starts runs cargo, go, npm, and Composer offline. So a missing download
# fails at once, without the results depending on whether a run reaches a registry, and scripts/check/downloads.mts lists it with `run make install`.
# Only the targets that download (install and its parts) run their commands with $(ONLINE).
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
# The tools of mise.toml that a recipe starts by its absolute path (kit K171): make 3.81, the make of macOS, looks a
# recipe line without shell syntax up on the PATH that make started with, not on the PATH that kit.mk exports.
GO := $(KIT_TOOLS)/mise/shims/go
# The lint configurations that kit reads from its package (kit K514), the folder above the dist of KIT.
KIT_PACKAGE := $(abspath $(KIT)/..)
COMPOSER := $(KIT_TOOLS)/mise/shims/composer
PYTHON3 := $(KIT_TOOLS)/mise/shims/python3
RUFF := $(KIT_TOOLS)/mise/shims/ruff
# The PHP lint wrappers of kit (scripts/kit/install-php-lint.mts) are not tools of mise.toml, so their recipes start them by these paths too.
PHPCS := $(KIT_TOOLS)/bin/phpcs
PHPSTAN := $(KIT_TOOLS)/bin/phpstan

# commit-msg-check is the commit-msg hook: it checks the message file MESSAGE that git is about to commit.
.PHONY: commit-msg-check
commit-msg-check:
	@test -n "$(MESSAGE)" || { echo "commit-msg-check: MESSAGE is missing; git gives the hook .githooks/commit-msg the message file, which passes it as MESSAGE"; exit 2; }
	$(NODE) $(KIT)/check-commits.$(KIT_EXT) --message "$(MESSAGE)"
# WITH_TEST_ENV reads TEST_ENV. The server DSN ORM_TEST_MYSQL_SERVER_DSN, which bypasses the pooler,
# and ORM_TEST_POSTGRES_SERVER_DSN are also defined by TEST_ENV (go test outside make reads the same file too).
# Even if client-pooler-check changes ORM_TEST_*_DSN to pooler DSNs, the rollback-failure case still ends the transaction's session on the
# server with this DSN, because ProxySQL intercepts the text-protocol KILL of its own client session
# as a command.
# WITH_TEST_ENV also holds the server's shared lease (tests/lease) until the shell of this line ends. The lease
# directory is ORM_TEST_SERVERS_LEASES of TEST_ENV. Stopping a server, starting one, and MySQL migration require an exclusive
# lease, so they are refused while this line runs; this line is recorded as the holder.
# WITH_TEST_ENV sets, through TEST_TZ, the time zone of the process that runs the database client last: it exports TZ and,
# for PHP, which does not read TZ, adds tests/timezone/date.ini (which sets date.timezone to ${TZ}) to the front of PHP_INI_SCAN_DIR
# after the separator (PHP's default scan directory is still read).
WITH_TEST_ENV = test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make orm-test-servers" >&2; exit 1; }; . $(abspath $(TEST_ENV)) && $(BUILD_LEASE) && "$(LEASE)" hold "$${ORM_TEST_SERVERS_LEASES:?$(abspath $(TEST_ENV)) names no lease directory; run make orm-test-servers to rewrite it}" shared --pid $$$$ && export TZ=$(TEST_TZ) PHP_INI_SCAN_DIR=:$(abspath tests/timezone) &&
# TEST_TZ is the process time zone of the checks that run database clients. It must be a non-UTC zone so that a defect where a client reads a database's
# zone-less datetime as the process's local time shows up even on a UTC CI runner. Every client reads and writes with the
# time zone of the connection (+00:00), so the results must not depend on this value (docs/spec/dialects.md).
TEST_TZ = Asia/Seoul

# GO_TEST runs Go tests so that each case is reported. tests/go-test.mts first runs the build of the same package and build
# tag as a long-running task with no deadline, `go-build/<packages>`, and then runs go test. -v shows the RUN, STEP, PASS, and FAIL lines that each
# case emits in packages/go/testcase during the run, and each case has its own deadline,
# so -timeout 0 turns off the deadline of the whole test binary (default 10 minutes).
# GO_TEST_FLAGS adds flags to every Go test of the repo (empty by default). A parity binding names GO_TEST_FLAGS=-json to read the
# go test -json stream of a make target that runs Go tests.
GO_TEST_FLAGS ?=
GO_TEST = node tests/go-test.mts -v -timeout 0 $(GO_TEST_FLAGS)

# RUN_LONG runs one long-running task that reports no case of its own (build, install, format, lint, package checks, and
# similar tool runs) with no deadline (tests/run-long.mts): it prints `RUN <name> no-deadline`, the command's output lines as STEP,
# the exit code, and PASS or FAIL. Success and failure are decided by the command's exit code and errors, not by a clock.
# The deadline exists only inside a test case.
RUN_LONG = node tests/run-long.mts
# PUBLISH writes a build output file that other runs or later steps read to a temporary file in the same directory and renames it
# (scripts/publish-output.mts). In `$(PUBLISH) <output> <command>`, the command's @OUT@ argument is the temporary file,
# and if there is no @OUT@, the command's standard output is the temporary file. The reader sees only files of a finished build.
PUBLISH = node $(abspath scripts/publish-output.mts)
# LEASE is the program that handles holding a test resource shared by several runs (tests/lease). Its build is a long-running
# task, so it runs with no deadline under RUN_LONG.
LEASE = $(abspath .runtime/bin/lease)
BUILD_LEASE = $(RUN_LONG) go-build/lease -- $(PUBLISH) $(LEASE) go build -o @OUT@ ./tests/lease
# CARGO_LEASED runs cargo's build of the Rust target directory (CARGO_TARGET_DIR, which the concurrent runs of this checkout share)
# under an exclusive lease. If a build of another run in this checkout holds the lease, it waits for the directory change notice
# (--wait). Builds run one at a time anyway, because of cargo's own lock.
CARGO_LEASES = $(CARGO_TARGET_DIR)/.leases
CARGO_LEASED = $(LEASE) run $(CARGO_LEASES) exclusive --wait --
# The scripts and the feature verification commands also use the same lease program and lease directory.
export LEASE CARGO_LEASES
# CARGO_TEST runs cargo test as one run's test binary, copied under the lease, not as the test binary of the shared target directory
# (tests/cargo-test.mts: build and copy, then run).
CARGO_TEST = node $(abspath tests/cargo-test.mts)
# RUN_DIR is the directory of one target run ($@ and the make process id). It holds the stress document that the run uses and a copy
# of the built program (RUN_TARGET, placed as CARGO_TARGET_DIR is). The run executes that copy, not the program in the shared target directory,
# CARGO_COPY does the build and the copy under one lease
# (scripts/cargo-build-copy.mts). The target removes RUN_DIR at its end.
RUN_DIR = $(abspath .runtime/run)/$@-$$PPID
RUN_TARGET = $(RUN_DIR)/target
CARGO_COPY = $(CARGO_LEASED) node $(abspath scripts/cargo-build-copy.mts) $(RUN_TARGET)
# CARGO_SIBLINGS runs cargo in packages/rust through kit's cargo link, as make cargo-fetch does (K448-5): the polyspec crates that a
# sibling checkout provides are patched to their paths, so a build never resolves them from their git tag. A recipe that builds the
# crates runs it in place of a bare cargo build, which link-state-check refuses.
CARGO_SIBLINGS = $(NODE) $(abspath $(KIT))/link.$(KIT_EXT) cargo --siblings $(abspath packages/rust)
# HOLD_TYPESCRIPT holds the TypeScript build output of this checkout (the dist of packages/ts and the generated models) as one holder for the
# lifetime of the make process. Targets that build and write that output get it on their first line,
# so they do not change output that another run's build is still writing. If another run holds it, it waits for the directory change notice. If an ancestor
# process (make feature-check) holds it, it is acquired inside that holding, so the builds of feature steps that run together also run one at a time.
TYPESCRIPT_LEASES = $(abspath .runtime/typescript.leases)
HOLD_TYPESCRIPT = $(LEASE) hold $(TYPESCRIPT_LEASES) exclusive --wait --pid $$PPID
# READ_TYPESCRIPT is held as a shared lease for the make process by targets that only read the build output. Read targets run
# together, and the build target (HOLD_TYPESCRIPT) waits until the read targets finish. If an ancestor process (the make that runs a sub-make, or the feature step of make owner-check)
# holds it exclusively, it is acquired inside that holding, so the sub-targets that the ancestor runs at the same time
# also wait for each other by the same rule.
READ_TYPESCRIPT = $(LEASE) hold $(TYPESCRIPT_LEASES) shared --wait --pid $$PPID
export TYPESCRIPT_LEASES
# SEND_SQLITE_DSN is the SQLite file of rust-send-savepoint-check. It is placed in the RUN_DIR of one run.
SEND_SQLITE_DSN = sqlite://$(RUN_DIR)/send-savepoint.sqlite

.PHONY: lease-tool
lease-tool:
	$(BUILD_LEASE)
TSC_BUILD = $(RUN_LONG) typescript-build -- node scripts/typescript/build.mts

# check runs CHECK_TARGETS one at a time with scripts/check/run.mts. The runner creates its own bench
# database and decimal database for each run, passes them as TEST_ENV and DECIMAL_ENV, and deletes them at the end, and for each target
# reports the RUN, the output lines (STEP), PASS or FAIL, and the elapsed time. The verification commands that run
# target(interface-check, php-without-mysql-check, perf-check, dbspec-go-check, dbspec-php-check,
# dbspec-rust-check, dbspec-ts-check, and dbspec-compare-check run once inside feature-verify-rust or feature-verify-other, so they are not listed again.
# contracts/check-inputs.json declares a scope for each target: owner targets
# are also selected by make owner-check, and suite targets run only in the whole suite.
CHECK_TARGETS = styled-column-states-unit-check group-count-boolean-unit-check model-json-ordered-number-text-unit-check runner-check scripts-typecheck docs-check docs-parse-check docs-site-check docs-site-parse-check commits-check release-coverage kit-check owner-validate dependency-policy-check dependency-policy-mutation-check version-check comment-language-check testcase-check repo-check orm-test-servers-check docs-rules-check docs-implementation-count-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check orm-install-cli-check markdown-table-check docs-verify-idempotent go-model-check php-model-check client-unit-check php-gen-unit-check phpstan-test-runner-helper-check php-orm-gen-scan-failure-case-check dbspec-sqlite-literal-rows-helper-check php-test-assertions-helper-check dbspec-php-interface-program-helper-check generator-consumer-check php-min-check ts-check ts-save-key-check ts-aes-auth-check ts-codec-errors-check sqlite-version-ts-check sqlite-version-rust-check relation-parent-bind-rust-check split-null-check collection-composite-key-check interface-typescript-extractor-check ts-min-check rust-check rust-build-environment-check rust-build-outdir-check rust-duplicate-catalog-check rust-time-precision-check rust-upsert-conflict-check go-fmt-check go-vet-check rust-fmt-check rust-150-check rust-driver-check example-check client-db-check codec-check bind-check ir-answers-check fuzz-check client-pooler-check case-database-check dialect-facts-check conformance-check conformance-ts-suite-check markdown-conformance-check package-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-stress-rust-check dbspec-introspect-python-check dbspec-introspect-compare-check dbspec-plan-check dbspec-apply-check dbspec-plan-ts-check dbspec-plan-rust-check ts-model-check dbspec-language-check dbspec-plan-php-check dbspec-go-check/engine dbspec-php-check/set perf-check dbspec-php-extension-check dbspec-php-extension-check/ir dbspec-apply-php-check dbspec-apply-php-extension-check dbspec-apply-python-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check dbspec-verify-errors-check collection-php-extension-check model-types-php-extension-check model-native-php-extension-check feature-unit-check feature-coverage feature-verify-rust feature-verify-other feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check go-test-check python-check parity-declarations-check parity-check generated-lint-check group-rows-db-go group-rows-db-python group-rows-db-typescript group-rows-db-php group-rows-db-php-extension group-rows-db-rust toolchain-check layout-check rules-check rebuild-check language-check test-markers-check duplication-check link-state-check polyspec-lock-check bypass-check suppression-check divergence-check lint-ts lint-php lint-python lint-go lint-rust lint-php-ext test-php-ext collection-get-phpstan-check blind-index-source-go-check blind-index-source-php-check blind-index-source-php-extension-check blind-index-source-ts-check blind-index-source-python-check blind-index-source-rust-check dbspec-lock-go-check dbspec-lock-php-check dbspec-lock-php-extension-check dbspec-lock-python-check dbspec-lock-rust-check dbspec-lock-ts-check php-codec-causes-check scalar-subquery-column-check nowait-restore-check mermaid-error-ts-check mermaid-error-python-check mermaid-error-php-check mermaid-error-php-extension-check php-extension-build-logs-check php-catalog-bounds-check column-function-metadata-check paged-read-rust-check page-cache-unit-check rust-compiler-fixtures-check native-error-cause-check request-hook-php-extension-check request-hook-rust-check rust-causes-check go-catalog-session-error-check catalog-php-extension-surface-check transaction-failure-php-extension-check transaction-failure-go-check transaction-failure-php-check php-query-cancellation-check php-query-cancellation-extension-check transaction-failure-typescript-check transaction-failure-python-check transaction-failure-rust-check connection-timeout-php-extension-check mysql-tls-php-extension-check mysql-session-php-extension-check go-package-entry-check native-arginfo-php-extension-check request-hook-audit-native-binding-check native-api-equivalence-check php-package-entry-check php-extension-package-entry-check rust-package-entry-check typescript-package-entry-check python-package-entry-check interface-api-binding-unit-check dbspec-introspect-python-helper-check catalog-mutation-helper-ts-check catalog-mutation-helper-python-check model-chunk-composite-native-php-extension-check model-query-write-php-extension-unit-check php-lifecycle-extension-native-check dbspec-introspect-query-count-unit-check connection-statement-timeout-typescript-check connection-statement-timeout-php-extension-check connection-pool-resource-bounds-typescript-check connection-utc-typescript-check connection-utc-php-extension-check connection-utc-php-check connection-utc-rust-check complex-query-typescript-unit-check python-complex-query-check complex-query-typescript-check complex-query-typescript-request-check complex-query-rust-check complex-query-python-mysql-check complex-query-python-postgres-check complex-query-python-sqlite-check complex-query-php-db-check complex-query-php-extension-db-check makefile-pinned-node-recipes-check complex-query-go-plan-check complex-query-rust-plan-check connection-busy-timeout-php-extension-check connection-sqlite-concurrent-writers-python-check connection-sqlite-read-during-write-python-check connection-sqlite-read-during-write-php-extension-check audit-native-method-assertions-helper-check rust-closed-executor-check typescript-internal-column-error-helper-check typescript-dbspec-plan-fixture-check physical-command-case-helper-check typescript-audit-history-rows-helper-check typescript-capture-error-helper-check typescript-check-state-helper-check typescript-performance-gate-unit-check mysql-test-options-helper-check database-case-tests-helper-check dbspec-physical-database-helper-check typescript-conditional-entry-helper-check typescript-database-case-fixture-helper-check php-plan-cache-memory-check split-read-plan-check cpx5-duplicate-relation-helper-check temp-sqlite-fixture-rust-helper-check aes-rotation-php-extension-check listen-notify-php-extension-check typescript-test-exact-keys-check
# CI splits make orm-check into one job per CI group and runs them at the same time (the job test, matrix group in .github/workflows/ci.yml).
# Each job runs `make check-run GROUP=<group>`, which runs CI_TARGETS_<group>; together the groups run every target of CHECK_TARGETS
# once each (make repo-check verifies it). The groups are split so that each job, with its setup, finishes within 10 minutes, using the target times measured in CI runs.
# One MySQL application of the 2000-table plan takes longer than that, so only stress-mysql is excluded. A local make orm-check runs
# every target without GROUP.
#   static: targets that need no database
#   clients_db: database tests of clients, the CPX-2 Rust fixture, Rust driver, examples, dialect facts, and Go tests
#   clients_pooler: database tests of clients through the pooler. Its test build is redone in its own job
#   conformance: database targets of the TypeScript client and the conformance runner
#   dbspec: database targets of case databases, dbspec DDL, introspection, and plans
#   dbspec_apply: database targets of dbspec plan application
#   feature_coverage, feature_verify_rust, feature_verify_other: the three parts of feature-check (feature coverage, the verification commands of shard rust and
#     the verification commands of shard other)
#   feature_helpers: the helper checks without the stress helpers and FEATURE_SUITE_HELPERS (feature-helper-check)
#   stress_mysql: MySQL application of the 2000-table plan (feature-stress-mysql-check)
#   stress_pg_sqlite: bench of the stress document and PostgreSQL and SQLite application (feature-stress-pg-sqlite-check)
CI_GROUPS = static clients_db clients_pooler conformance dbspec dbspec_apply feature_coverage feature_verify_rust feature_verify_other feature_helpers stress_mysql stress_pg_sqlite python
CI_TARGETS_static = styled-column-states-unit-check group-count-boolean-unit-check model-json-ordered-number-text-unit-check runner-check docs-check docs-parse-check commits-check release-coverage kit-check owner-validate dependency-policy-check dependency-policy-mutation-check version-check comment-language-check testcase-check repo-check orm-test-servers-check docs-rules-check docs-implementation-count-check docs-dbs-check dbspec-codemirror-check dbspec-lsp-check orm-install-cli-check markdown-table-check docs-verify-idempotent go-model-check php-model-check client-unit-check php-gen-unit-check phpstan-test-runner-helper-check php-orm-gen-scan-failure-case-check php-test-assertions-helper-check dbspec-sqlite-literal-rows-helper-check php-min-check rust-check go-fmt-check go-vet-check rust-fmt-check codec-check bind-check ir-answers-check fuzz-check package-check ts-model-check ts-save-key-check ts-aes-auth-check ts-codec-errors-check sqlite-version-ts-check sqlite-version-rust-check relation-parent-bind-rust-check split-null-check collection-composite-key-check interface-typescript-extractor-check collection-php-extension-check model-types-php-extension-check model-native-php-extension-check model-chunk-composite-native-php-extension-check feature-unit-check parity-declarations-check generated-lint-check toolchain-check layout-check rules-check rebuild-check language-check test-markers-check duplication-check link-state-check polyspec-lock-check bypass-check suppression-check divergence-check lint-ts lint-php lint-python lint-go lint-rust lint-php-ext test-php-ext collection-get-phpstan-check blind-index-source-go-check blind-index-source-php-check blind-index-source-php-extension-check blind-index-source-ts-check blind-index-source-python-check blind-index-source-rust-check rust-build-environment-check rust-build-outdir-check rust-duplicate-catalog-check php-catalog-bounds-check rust-time-precision-check rust-upsert-conflict-check php-codec-causes-check scalar-subquery-column-check nowait-restore-check dbspec-language-check docs-site-check docs-site-parse-check rust-150-check dbspec-verify-errors-check php-extension-build-logs-check column-function-metadata-check paged-read-rust-check page-cache-unit-check rust-compiler-fixtures-check native-error-cause-check request-hook-php-extension-check request-hook-rust-check rust-causes-check go-catalog-session-error-check catalog-php-extension-surface-check connection-timeout-php-extension-check go-package-entry-check native-arginfo-php-extension-check request-hook-audit-native-binding-check transaction-failure-php-extension-check transaction-failure-go-check transaction-failure-php-check transaction-failure-typescript-check transaction-failure-python-check transaction-failure-rust-check php-package-entry-check php-extension-package-entry-check rust-package-entry-check typescript-package-entry-check python-package-entry-check interface-api-binding-unit-check native-api-equivalence-check model-query-write-php-extension-unit-check php-lifecycle-extension-native-check dbspec-introspect-query-count-unit-check complex-query-typescript-unit-check python-complex-query-check complex-query-typescript-request-check dbspec-vscode-check makefile-pinned-node-recipes-check complex-query-go-plan-check complex-query-rust-plan-check connection-busy-timeout-php-extension-check connection-sqlite-concurrent-writers-python-check connection-sqlite-read-during-write-python-check connection-sqlite-read-during-write-php-extension-check audit-native-method-assertions-helper-check rust-closed-executor-check physical-command-case-helper-check dbspec-physical-database-helper-check typescript-conditional-entry-helper-check typescript-database-case-fixture-helper-check php-plan-cache-memory-check split-read-plan-check cpx5-duplicate-relation-helper-check temp-sqlite-fixture-rust-helper-check typescript-performance-gate-unit-check typescript-test-exact-keys-check
CI_TARGETS_clients_db = perf-check rust-driver-check example-check client-db-check dialect-facts-check go-test-check mysql-tls-php-extension-check mysql-session-php-extension-check php-query-cancellation-check php-query-cancellation-extension-check group-rows-db-go group-rows-db-typescript group-rows-db-php group-rows-db-php-extension group-rows-db-rust connection-statement-timeout-typescript-check connection-pool-resource-bounds-typescript-check connection-utc-typescript-check connection-utc-php-extension-check connection-utc-php-check connection-utc-rust-check complex-query-typescript-check complex-query-rust-check complex-query-python-mysql-check complex-query-python-postgres-check complex-query-python-sqlite-check complex-query-php-db-check complex-query-php-extension-db-check connection-statement-timeout-php-extension-check aes-rotation-php-extension-check listen-notify-php-extension-check
CI_TARGETS_clients_pooler = client-pooler-check
CI_TARGETS_conformance = ts-check scripts-typecheck ts-min-check conformance-check conformance-ts-suite-check markdown-conformance-check parity-check mermaid-error-ts-check catalog-mutation-helper-ts-check typescript-internal-column-error-helper-check typescript-audit-history-rows-helper-check typescript-capture-error-helper-check typescript-check-state-helper-check mysql-test-options-helper-check database-case-tests-helper-check
CI_TARGETS_feature_helpers = feature-helper-check
CI_TARGETS_python = python-check group-rows-db-python mermaid-error-python-check generator-consumer-check dbspec-introspect-python-helper-check catalog-mutation-helper-python-check
CI_TARGETS_dbspec = dbspec-go-check/engine dbspec-php-check/set case-database-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-stress-rust-check dbspec-introspect-python-check dbspec-introspect-compare-check dbspec-plan-check dbspec-plan-ts-check dbspec-plan-rust-check dbspec-plan-php-check dbspec-php-extension-check dbspec-php-extension-check/ir dbspec-php-interface-program-helper-check mermaid-error-php-check mermaid-error-php-extension-check
CI_TARGETS_dbspec_apply = dbspec-apply-check dbspec-apply-php-check dbspec-apply-php-extension-check dbspec-apply-python-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check dbspec-lock-go-check dbspec-lock-php-check dbspec-lock-php-extension-check dbspec-lock-python-check dbspec-lock-rust-check dbspec-lock-ts-check typescript-dbspec-plan-fixture-check
CI_TARGETS_feature_coverage = feature-coverage
CI_TARGETS_feature_verify_rust = feature-verify-rust
CI_TARGETS_feature_verify_other = feature-verify-other
CI_TARGETS_stress_mysql = feature-stress-mysql-check
CI_TARGETS_stress_pg_sqlite = feature-stress-pg-sqlite-check
# run-databases runs the make target(s) in TARGETS as a single run with its own bench database and decimal database
# (scripts/check/run.mts, the same runner as make check-run). Use it when running a target directly that uses the bench or decimal database:
# the server environment of TEST_ENV has no such database. The runner does not pass MAKEFLAGS, so the VECTOR and RECORD of conformance-check
# are passed as environment variables.
# databases-create is the setup step databases/create of the runner (scripts/check/run.mts) and of make owner-check: it
# builds the TypeScript client, creates the run-owned bench and decimal databases, with COMPLEX_QUERY=1 also the 18 owner-specific
# complex-query fixture databases, and writes every DSN to the run environment before coverage reads database state. A run passes
# COMPLEX_QUERY=1 only when a target needs complex-query (contracts/check-inputs.json) or an owner part reads a COMPLEX_QUERY_*_DSN.
databases-create: typescript-build
	$(READ_TYPESCRIPT)
	$(NODE) scripts/check/databases.mts create '$(SERVERS)' '$(DIRECTORY)' '$(NAME)'$(if $(COMPLEX_QUERY), --complex-query)

run-databases:
	$(BUILD_LEASE) && VECTOR='$(VECTOR)' RECORD='$(RECORD)' $(NODE) scripts/check/run.mts --job-summary $(abspath $(TEST_ENV)) $(TARGETS)

# check is the guard of the full suite, the full-run tool of @polyspec/kit: it prints the reason and refuses while a checklist
# item is [~], while tracked files have uncommitted changes, or when var/full-run.json records a full run of the same tree;
# otherwise it runs the target check-run with `make -k` and records the result. make rerun-failed (the kit.mk of
# @polyspec/kit) reruns on the same tree the targets that did not pass. The full suite runs on GitHub CI after a push
# (.github/workflows/ci.yml), and a local check is no step required before a push. check-run runs the runner
# (scripts/check/run.mts): each run creates its own bench and decimal databases, runs the targets one by one and writes the
# record of the run to .runtime/check/<id>/record.json. The runner reads TEST_ENV as the setup step servers and holds the
# shared lease of those servers: when the file is missing (make orm-test-servers failed), it records only the targets that need
# a database as not-run and runs the rest.
# GROUP runs only one CI group (CI_TARGETS_<group>). That run is one part of the whole suite that one GitHub Actions job runs,
# so it is accepted only when GITHUB_ACTIONS is true.
CHECK_RUN_TARGETS = $(if $(GROUP),$(CI_TARGETS_$(GROUP)),$(CHECK_TARGETS))
orm-check:
	$(NODE) $(KIT)/full-run.$(KIT_EXT) run check-run
check-run:
	$(if $(GROUP),$(if $(filter $(GROUP),$(CI_GROUPS)),,$(error GROUP $(GROUP) names no CI group; give one of CI_GROUPS: $(CI_GROUPS))))
	$(if $(GROUP),$(if $(filter true,$(GITHUB_ACTIONS)),,$(error GROUP runs one CI group of make check-run on GitHub Actions only; run make orm-check without GROUP, which runs every target of CHECK_TARGETS)))
	$(BUILD_LEASE) && $(NODE) scripts/check/run.mts $(abspath $(TEST_ENV)) $(CHECK_RUN_TARGETS)

# ci-group-needs writes the setup steps that the job of CI group GROUP runs as step output lines (`<output>=true|false`): it decides them from the need
# that each target of the group declares in contracts/check-inputs.json (scripts/check/ci-setup.mts). The workflow adds those lines
# to $GITHUB_OUTPUT, and a setup step runs only when its own output is true.
ci-group-needs:
	$(if $(filter $(GROUP),$(CI_GROUPS)),,$(error GROUP $(GROUP) names no CI group; give one of CI_GROUPS: $(CI_GROUPS)))
	@$(NODE) scripts/check/ci-setup.mts outputs $(CI_TARGETS_$(GROUP))

# bench measures performance (parse, application, introspection, and comparison of the 2000-table stress document, and CPU time) per target with the same
# runner as check. It prints the measurements and only warns, not fails, when they exceed the reference values (AGENTS.md).
BENCH_TARGETS = dbspec-stress-bench dbspec-apply-stress-bench dbspec-introspect-compare-bench dbspec-compare-bench timing-check
.PHONY: bench
bench:
	test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make orm-test-servers" >&2; exit 1; }
	$(NODE) scripts/check/run.mts --job-summary $(abspath $(TEST_ENV)) $(BENCH_TARGETS)

# GO_PACKAGES is every package of the three modules of go.work (packages/go, tests, examples). The root is not a module,
# so ./... at the root points to no package.
GO_PACKAGES = ./packages/go/... ./tests/... ./examples/...

# go-test-check runs the Go package tests that no other target runs. The client package of packages/go
# is run by client-db-check (scripts/client-db-test.mts), and the engine and generator are run by the verification commands of feature-check
# (planner-go-* for each engine package, packages/go/engine/dbspec by dbspec-go-check of schema-go,
# generator by generation-go), and packages/go/testcase is run by testcase-check with the same commands.
GO_TEST_CHECK_PACKAGES = $$(go list ./packages/go/cmd/... ./packages/go/procevent/... ./packages/go/internal/... ./tests/... ./examples/...)
.PHONY: go-test-check
go-test-check:
	$(WITH_TEST_ENV) $(GO_TEST) $(GO_TEST_CHECK_PACKAGES)

# The DB-independent Go public-plan case exercises the generated Product query and rejects SQLite before execution.
complex-query-go-plan-check:
	$(GO_TEST) ./packages/go/complexquery -run '^TestComplexQueryPublicPlan$$' -count=1

# The assignment expansion regression is a pure planner unit, separate from the Go database suite.
blind-index-source-go-check:
	cd packages/go && $(GO) test ./engine/planner -run '^(TestMultiRowBlindIndexUsesAssignedSourceAndOriginalRowOffsets|TestBlindIndexDerivationRejectsDistinctSourcesRegardlessOfValues|TestExplicitBlindIndexAssignmentWinsOverMultipleSources|TestInsertAndOnDuplicateBlindIndexAssignmentsAreIndependent|TestOnDuplicateRejectsDistinctSourcesWithoutExplicitTarget|TestOrdinaryInsertHasNoBlindIndexAssignments)$$' -count=1

# testcase-check checks that each language's shared case report prints, in this order, the start of each case (RUN, deadline), its steps (STEP),
# its results (PASS, FAIL and reason), and the elapsed time, and that it reports a case past its deadline as FAIL,
# using the output of the child processes.
.PHONY: testcase-check
testcase-check: testcase-check/go testcase-check/node testcase-check/runners testcase-check/rust
testcase-check/go:
	$(GO_TEST) ./packages/go/testcase -count=1
testcase-check/node:
	$(NODE) --test scripts/harness/testcase.test.mts scripts/harness/debug-mode.test.mts
testcase-check/runners:
	$(NODE) --test scripts/harness/go-test.test.mts scripts/harness/cargo-test.test.mts
testcase-check/rust: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) testcase-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-testcase

# Runs only the two Rust cases that share the private SQLite fixture helper.
.PHONY: temp-sqlite-fixture-rust-helper-check
temp-sqlite-fixture-rust-helper-check: cargo-downloads-check lease-tool
	cd packages/rust && $(CARGO_TEST) temp-sqlite-fixture-hot-path -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test coverage_hot_path_read_correctness hot_path_read_correctness -- --test-threads=1 --exact
	cd packages/rust && $(CARGO_TEST) temp-sqlite-fixture-cpx5 -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test integration coverage_model_queries::duplicate_relation_name_reports_config_alias_hint -- --test-threads=1 --exact

# client-pooler-check runs the client database tests through the PgBouncer
# pooler in transaction mode for PostgreSQL and the ProxySQL pooler for MySQL.
client-pooler-check: lease-tool python-venv-check
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" node scripts/client-db-test.mts

# runner-check checks the check runner (scripts/check/run.mts) and its run record (scripts/check/record.mts) with a temporary git checkout and stub steps.
# It does not run the actual targets or databases.
runner-check:
	$(NODE) --test scripts/check/run.test.mts scripts/check/continue.test.mts scripts/check/step.test.mts scripts/check/downloads.test.mts scripts/json/schema.test.mts

# dbspec-rust-check runs twice each the shared dbspec vectors, the Rust rule cases, the plan and Mermaid cases, and the apply cleanup errors injected through a wrapped SQLite
# connection.
#
# DBSPEC_STRESS_DOCUMENT is the 2000-table document of tests/dbspec/stress.mts. The parse time of that document,
# application, introspection, and comparison are performance measurements, so make bench runs them. make orm-check's
# dbspec-compare-check and dbspec-introspect-compare-check run the same code path with small documents of the same shape
# (DBSPEC_COMPARE_TABLES and DBSPEC_INTROSPECT_TABLES tables), and make
# bench runs the same targets with 2000 tables.
DBSPEC_STRESS_DOCUMENT = $(RUN_DIR)/stress.dbs
DBSPEC_COMPARE_TABLES ?= 20
DBSPEC_COMPARE_DOCUMENT = $(RUN_DIR)/stress-$(DBSPEC_COMPARE_TABLES).dbs
DBSPEC_INTROSPECT_TABLES ?= 20
DBSPEC_INTROSPECT_DOCUMENT = $(RUN_DIR)/stress-$(DBSPEC_INTROSPECT_TABLES).dbs
# DBSPEC_INTROSPECT_PROFILE is the cargo profile of the Rust introspection runner. make orm-check uses dev, which shares the test
# build and its dependencies, and make bench uses release, which measures the introspection time.
DBSPEC_INTROSPECT_PROFILE ?= dev
DBSPEC_INTROSPECT_DIR = $(if $(filter dev,$(DBSPEC_INTROSPECT_PROFILE)),debug,$(DBSPEC_INTROSPECT_PROFILE))
.PHONY: dbspec-rust-check dbspec-stress-rust-check
dbspec-stress-rust-check: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-stress-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --test dbspec_stress stress_document_round_trips_canonically -- --test-threads=1 --exact

# dbspec-ddl-check applies every vector of tests/dbspec/ddl.json to MySQL, PostgreSQL, and
# SQLite of TEST_ENV, runs the behavior steps, and applies the rendered statements of all contracts/fixtures/bench/*.dbs and contracts/fixtures/*.dbs
# applies the rendered statements.
.PHONY: dbspec-ddl-check
dbspec-ddl-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./packages/go/internal/dialects -run '^(TestDDLVectors|TestSchemaDocumentsApply)$$' -count=1

# dbspec-introspect-check renders tests/dbspec/ddl.json and every schema document into MySQL, PostgreSQL,
# and SQLite and applies them, introspects each database and requires the source schema text,
# and runs tests/dbspec/introspect.json.
.PHONY: dbspec-introspect-check
dbspec-introspect-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./packages/go/internal/dialects -run '^(TestIntrospectRoundTrip|TestIntrospectUnsupported)$$' -count=1

# dbspec-introspect-ts-check builds the TypeScript client and runs the round trip of dbspec-introspect-check and its unsupported cases
# against MySQL, PostgreSQL, and SQLite with that introspectDbspec.
.PHONY: dbspec-introspect-ts-check
# conformance-ts-suite-check runs the conformance vectors of each dialect as node:test tests named by their vectors, the
# TypeScript bindings of the conformance units of config/parity.json, each on a bench database it seeds and drops itself.
.PHONY: conformance-ts-suite-check
conformance-ts-suite-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test --conditions=orm-test packages/ts/tests/coverage_conformance_mysql.mjs packages/ts/tests/coverage_conformance_postgres.mjs packages/ts/tests/coverage_conformance_sqlite.mjs packages/ts/tests/conformance_vector_count.test.mts
dbspec-introspect-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test packages/ts/tests/dbspec-introspect.mjs packages/ts/tests/dbspec-introspect-round-trip.mjs

# dbspec-introspect-php-check runs the same round trip and unsupported cases with the PHP client's
# Polyspec\Orm\Dbspec\Dbspec::introspect.
.PHONY: dbspec-introspect-php-check
dbspec-introspect-php-check: php-vendor-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecIntrospectTest.php

# dbspec-introspect-php-extension-check runs the same round trip and unsupported cases, the PHP client's DbspecIntrospectTest, with the PHP
# extension polyspec_orm loaded, whose Polyspec\Orm\Dbspec\Dbspec::introspect takes the place of the client's. The extension is built in
# this run's directory.
.PHONY: dbspec-introspect-php-extension-check
dbspec-introspect-php-extension-check: php-vendor-check
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/DbspecIntrospectTest.php
	rm -rf $(RUN_DIR)

# dbspec-introspect-rust-check runs the same round trip and the cases of tests/dbspec/introspect.json with the Rust
# client's polyspec_orm::dbspec::introspect, and confirms catalog queries 9, 7, and 3 for every set.
.PHONY: dbspec-introspect-rust-check
dbspec-introspect-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-introspect-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_introspect -- --nocapture

dbspec-introspect-query-count-rust-check: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-introspect-query-count-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm --test dbspec_introspect_query_count sqlite_memory_query_count_is_independent_of_table_count -- --exact --nocapture

# Observes the SQLite-memory catalog queries through each native client's introspection entry point; the round-trip cases retain the three-database count checks.
.PHONY: dbspec-sqlite-literal-rows-helper-check
dbspec-sqlite-literal-rows-helper-check: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecShowCreateIntrospectTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecBehaviourTest.php

.PHONY: dbspec-introspect-query-count-unit-check dbspec-introspect-php-extension-query-count-check dbspec-introspect-query-count-rust-check
dbspec-introspect-php-extension-query-count-check: php-vendor-check php-models
	@set -eu; run_dir="$(abspath .runtime/run)/dbspec-introspect-php-extension-query-count-check-$$PPID"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecIntrospectNativeTest.php

dbspec-introspect-query-count-unit-check: php-vendor-check python-venv-check dbspec-introspect-query-count-rust-check dbspec-introspect-php-extension-query-count-check
	$(HOLD_TYPESCRIPT)
	$(GO_TEST) ./packages/go/engine/dbspec -run '^TestQueryCountIsIndependentOfSQLiteTableCount$$' -count=1
	$(TSC_BUILD)
	$(NODE) --test --test-name-pattern='SQLite memory catalog query count is independent of table count' packages/ts/tests/dbspec-introspect-query-count.mjs
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_dbspec_introspect_query_count
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecIntrospectQueryCountTest.php

# dbspec-introspect-python-check runs the same round trip and unsupported cases with the Python client's
# polyspec.orm.dbspec.introspect.introspect_dbspec on MySQL and PostgreSQL servers (packages/python/tests/dbspec_introspect.py),
# Run the same cases on a SQLite file too. It imports the client installed into the venv, as python-unit-check does.
.PHONY: dbspec-introspect-python-check
dbspec-introspect-python-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_introspect
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_introspect_queries

dbspec-introspect-python-helper-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_dbspec_introspect_support

catalog-mutation-helper-python-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_catalog_mutation_helper

catalog-mutation-helper-ts-check: typescript-build
	$(RUN_TESTS) node -- --test packages/ts/tests/catalog-mutation-helper.test.mjs

typescript-internal-column-error-helper-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/internal-column-error.test.mjs packages/ts/tests/markdown-read-db.test.mjs

typescript-dbspec-plan-fixture-check: typescript-build
	$(RUN_TESTS) node -- --test packages/ts/tests/dbspec-plan-fixture.test.mjs

physical-command-case-helper-check:
	$(RUN_TESTS) node -- --test scripts/physical-command-case.test.mts

typescript-audit-history-rows-helper-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/audit-history-rows.test.mjs

typescript-capture-error-helper-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/capture-error.test.mjs

typescript-check-state-helper-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/check-state.test.mjs

.PHONY: typescript-test-exact-keys-check
typescript-test-exact-keys-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/assertions.test.mjs

mysql-test-options-helper-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/mysql-test-options.test.mjs

database-case-tests-helper-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/database-case-tests.test.mjs

dbspec-physical-database-helper-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/dbspec-physical-database.test.mjs

typescript-conditional-entry-helper-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/conditional-entry.test.mjs

typescript-database-case-fixture-helper-check: typescript-build
	$(RUN_TESTS) node -- --test packages/ts/tests/database-case-fixture.test.mjs

# dbspec-plan-check applies the steps of every case of tests/dbspec/plans.json to MySQL, PostgreSQL, and SQLite,
# and requires the plan's target, the source via rollback statements, the target after applying again, and the target after finalize, and
# no hidden names (docs/spec/plans.md "Verification").
.PHONY: dbspec-plan-check
dbspec-plan-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./packages/go/internal/dialects -run '^TestPlanApply$$' -count=1

# dbspec-plan-python-check applies every case of tests/dbspec/plans.json to MySQL, PostgreSQL and SQLite with the Python client (packages/python/tests/dbspec_plan_physical.py).
.PHONY: dbspec-plan-python-check
dbspec-plan-python-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_plan_physical

# dbspec-apply-check applies the plan chain to MySQL, PostgreSQL, and SQLite with history, a second apply, drift,
# lock, an unlock that releases nothing, verification, recover and rollback at an interruption after every step of a representative plan, row writes between,
# null checks, and finalize; and it applies the 2000-table document as the first plan
# to the three databases (docs/spec/plans.md "Apply", "Verification"). The 2000-table plan on MySQL
# commits its statements and its 22000 history steps separately, so the deadline of that case is long.
.PHONY: dbspec-apply-check
dbspec-apply-check:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./packages/go/internal/dialects -run '^(TestApplyChain|TestApplyThroughTransactionPooler)$$' -count=1

# Runs only Python's native PLN-90 lock-wait case on each configured database.
.PHONY: dbspec-apply-python-check
dbspec-apply-python-check: python-venv-check
	$(WITH_TEST_ENV) PYTHONPATH=$(CURDIR)/packages/python/src $(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.dbspec_apply.DbspecApplyTest.test_lock_wait_mysql packages.python.tests.dbspec_apply.DbspecApplyTest.test_lock_wait_postgres packages.python.tests.dbspec_apply.DbspecApplyTest.test_lock_wait_sqlite

# The six dbspec SQLite lock/session checks execute focused fake-driver cases; none starts or opens a database.
dbspec-lock-go-check:
	$(GO_TEST) ./packages/go/engine/dbspec -run '^TestSqlite(LockResult|SessionClassifiesBeginErrorAndRestoresState)$$' -count=1

dbspec-lock-php-check: php-vendor-check php-models
	$(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter DbspecSqliteLockTest packages/php/tests/DbspecSqliteLockTest.php

dbspec-lock-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/dbspec-lock-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSqliteLockTest.php; env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecSqliteLockNativeTest.php

dbspec-lock-python-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_dbspec_sqlite_lock

dbspec-lock-rust-check: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-lock-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib sqlite_lock_result_tests -- --nocapture

dbspec-lock-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/dbspec-begin-exclusive-lock.mjs

# dbspec-apply-stress-bench applies the 2000-table document as the first plan to the databases in APPLY_STRESS_DIALECTS
# (make bench runs all three). MySQL commits its statements and its 22000 history steps separately.
# APPLY_STRESS_DIALECTS is the list of databases separated by `|` (mysql, postgres, sqlite) and selects the subtests of TestApplyStressPlan. So
# CI runs the longest MySQL application in a different group from PostgreSQL and SQLite (feature-stress-mysql-check,
# feature-stress-pg-sqlite-check). A name that is not a database, or an empty value, passes while selecting no subtest, so make stops before the
# command.
APPLY_STRESS_DIALECTS = mysql|postgres|sqlite
.PHONY: dbspec-apply-stress-bench
dbspec-apply-stress-bench:
	$(if $(APPLY_STRESS_DIALECTS),,$(error APPLY_STRESS_DIALECTS is empty; give mysql, postgres or sqlite separated by |))$(foreach dialect,$(subst |, ,$(APPLY_STRESS_DIALECTS)),$(if $(filter $(dialect),mysql postgres sqlite),,$(error APPLY_STRESS_DIALECTS names $(dialect), which is no database; give mysql, postgres or sqlite separated by |)))
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./packages/go/internal/dialects -run '^TestApplyStressPlan$$/^($(APPLY_STRESS_DIALECTS))$$' -count=1

# dbspec-apply-pairs-check builds the TypeScript client and the Rust apply runner,
# the Go, PHP, TypeScript, and Rust runners in tests/dbspec/apply, the PHP extension polyspec_orm runner (built in this run's directory), and the Python runner
# packages/python/tests/dbspec_apply_runner.py: for every ordered pair, on MySQL, PostgreSQL,
# and SQLite, the first plan of the chain is applied by one client and the rest by another, where the first client stops
# in the middle, the second client finishes the plan with recover, and the second client rolls back the plan that stopped again. The history
# rows and the introspected schema text must match those of the chain. Python also runs the
# representative finalize and lock-wait scenarios on each database.
.PHONY: dbspec-apply-pairs-check
dbspec-apply-pairs-check: cargo-downloads-check lease-tool python-venv-check
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(RUN_LONG) rust-build/dbspec_apply --cwd packages/rust -- $(CARGO_COPY) debug/examples/dbspec_apply -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm --example dbspec_apply
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) DBSPEC_APPLY_RUST=$(RUN_TARGET)/debug/examples/dbspec_apply POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python $(GO_TEST) -tags physical ./packages/go/internal/dialects -run '^TestApplyChainAcrossClients$$' -count=1
	rm -rf $(RUN_DIR)

# dbspec-apply-rust-check runs the scenario of dbspec-apply-check, minus the 2000-table plan, with the Rust client's
# polyspec_orm::dbspec::apply, recover, rollback, and finalize.
.PHONY: dbspec-apply-rust-check
dbspec-apply-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-apply-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply -- --nocapture

# dbspec-plan-ts-check builds the TypeScript client and applies every case of tests/dbspec/plans.json to MySQL, PostgreSQL, and SQLite
# with its renderDbspec, planSteps, and introspectDbspec.
.PHONY: dbspec-plan-ts-check
dbspec-plan-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test packages/ts/tests/dbspec-plan-physical.mjs

# dbspec-apply-ts-check builds the TypeScript client and runs the scenario of dbspec-apply-check, minus the 2000-table plan,
# with its applyPlans, recoverPlans, rollbackPlans, and finalizePlans.
.PHONY: dbspec-apply-ts-check
dbspec-apply-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(WITH_TEST_ENV) node --test packages/ts/tests/dbspec-apply-physical.mjs

# dbspec-plan-rust-check applies the same cases with the Rust client's plan steps, renderer,
# and polyspec_orm::dbspec::introspect.
.PHONY: dbspec-plan-rust-check
dbspec-plan-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-plan-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_plan_apply -- --nocapture

# dbspec-plan-php-check applies the same cases with the PHP client's Polyspec\Orm\Dbspec\Dbspec::planSteps and
# Dbspec::introspect.
.PHONY: dbspec-plan-php-check
dbspec-plan-php-check: php-vendor-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanApplyTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanReaderTest.php

# dbspec-apply-php-check runs the scenario of dbspec-apply-check, minus the 2000-table plan, with the PHP client's
# Polyspec\Orm\Dbspec\Dbspec::apply, recover, rollback, and finalize on MySQL, PostgreSQL, and SQLite.
.PHONY: dbspec-apply-php-check
dbspec-apply-php-check: php-vendor-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyTest.php

# dbspec-apply-php-extension-check runs the same scenario, the PHP client's DbspecApplyTest, with the PHP extension polyspec_orm loaded,
# whose Polyspec\Orm\Dbspec\Dbspec::apply, recover, rollback, and finalize take the place of the client's. The extension is built in this
# run's directory.
.PHONY: dbspec-apply-php-extension-check
dbspec-apply-php-extension-check: php-vendor-check
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/DbspecApplyTest.php
	rm -rf $(RUN_DIR)

# dbspec-introspect-compare-check applies the stress document (DBSPEC_INTROSPECT_TABLES tables) to MySQL,
# PostgreSQL, and SQLite, and for each database runs the introspection runners of tests/dbspec/introspect in Go, PHP, TypeScript, Rust, and
# the PHP extension polyspec_orm (built in this run's directory), requiring the same output, source schema text, and no unsupported objects, and each
# prints the introspection time and warns when it exceeds the reference value. dbspec-introspect-compare-bench runs the same target with the 2000
# table document and the release runners.
.PHONY: dbspec-introspect-compare-check dbspec-introspect-compare-bench
dbspec-introspect-compare-check: cargo-downloads-check lease-tool python-venv-check
	$(HOLD_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_INTROSPECT_DOCUMENT))
	$(PUBLISH) $(DBSPEC_INTROSPECT_DOCUMENT) node tests/dbspec/stress.mts $(DBSPEC_INTROSPECT_TABLES)
	$(TSC_BUILD)
	$(RUN_LONG) rust-build/dbspec_introspect --cwd packages/rust -- $(CARGO_COPY) $(DBSPEC_INTROSPECT_DIR)/examples/dbspec_introspect -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --profile $(DBSPEC_INTROSPECT_PROFILE) --locked --offline -p polyspec-orm --example dbspec_introspect
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) DBSPEC_STRESS_DOCUMENT=$(DBSPEC_INTROSPECT_DOCUMENT) DBSPEC_INTROSPECT_RUST=$(RUN_TARGET)/$(DBSPEC_INTROSPECT_DIR)/examples/dbspec_introspect POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) DBSPEC_INTROSPECT_PYTHON=$(PYTHON_VENV)/bin/python $(GO_TEST) -tags physical ./packages/go/internal/dialects -run '^TestIntrospectCompare$$' -count=1
	rm -rf $(RUN_DIR)

dbspec-introspect-compare-bench:
	$(MAKE) --no-print-directory dbspec-introspect-compare-check DBSPEC_INTROSPECT_TABLES=2000 DBSPEC_INTROSPECT_PROFILE=release

# dbspec-compare-check runs the Go, PHP, TypeScript, and Rust dbspec runners and the PHP extension polyspec_orm runner over tests/dbspec/cases.json,
# the stress document (DBSPEC_COMPARE_TABLES tables), tests/dbspec/ddl.json, tests/dbspec/plans.json, tests/dbspec/mermaid.json,
# and tests/dbspec/syntax.json,
# each twice; the two runs' outputs fail at the first differing case. The runs also print the declaration positions of
# the positions cases of cases.json and, for each case of syntax.json, the tokens and the format of the input of
# cases.json that its id names. The PHP extension is built in this run's directory
# (PHP_EXTENSION_LIBRARY). Before that, every runner must
# reject, with an error that gives the position, a vector that omits a section or field or changes a type, and compare,
# apply, and the Rust stress runner must reject a missing or directory input, with its path. A runner also refuses a section
# or field of cases.json that the format does not name: every runner reads its vector files through the JSON Schemas of
# tests/dbspec/schema with a validator of its ecosystem and reports a refusal in one form. The runner
# is a debug build that shares the test build and its dependencies. dbspec-compare-bench runs the same target with a 2000-table
# document.
.PHONY: dbspec-compare-check dbspec-compare-bench
# The parts share one directory (the RUN_DIR of the top target): prepare creates the stress document and the runners, and the three independent
# checks read it; the top target deletes it after all pass. If a part fails, the directory remains and the runner
# moves it into the report.
dbspec-compare-check/%: RUN_DIR = $(abspath .runtime/run)/dbspec-compare-check-$$PPID
.PHONY: dbspec-compare-check/unit dbspec-compare-check/prepare dbspec-compare-check/runners dbspec-compare-check/inputs dbspec-compare-check/compare
dbspec-compare-check: dbspec-compare-check/unit dbspec-compare-check/runners dbspec-compare-check/inputs dbspec-compare-check/compare
	rm -rf $(RUN_DIR)
dbspec-compare-check/unit:
	$(RUN_TESTS) node -- tests/dbspec/compare/check.test.mts
# PYTHON_VENV is the virtual environment that orm-install-python makes. It holds the Python client installed in editable mode,
# with the pinned dependencies of its pyproject.toml (ordered-json, cryptography, PyMySQL, psycopg, rapidyaml, ruamel.yaml) and
# of its extra test (jsonschema-rs); the checks
# take this interpreter as ORM_PYTHON and import the installed package, never a source path.
PYTHON_VENV = $(abspath packages/python/.venv)
# orm-install-python installs the tools of mise.toml (install-tools), among them the Python that mise.lock pins, and makes the
# venv of that interpreter with kit's python-venv; no other python3 of PATH is used. The client is installed with that pip as
# an editable package (pip install --editable) with its extra test, so the tests import the installed package and a source
# change needs no reinstall. The dependencies come from the wheel lock packages/python/pylock.toml with --require-hashes (kit
# K54): every file is checked by its sha256, and the editable install adds the package itself with --no-deps, since pip
# refuses an editable requirement in hash-checking mode. The extra test is installed after it, as before.
.PHONY: orm-install-python
orm-install-python:
	$(MAKE) --no-print-directory install-tools
	$(MAKE) --no-print-directory python-venv DIR=$(PYTHON_VENV)
	$(ONLINE) $(PYTHON3) -m pip --python $(PYTHON_VENV)/bin/python install --quiet --require-hashes -r packages/python/pylock.toml
	$(PYTHON3) -m pip --python $(PYTHON_VENV)/bin/python install --quiet --no-deps --editable packages/python
	$(ONLINE) $(PYTHON3) -m pip --python $(PYTHON_VENV)/bin/python install --quiet --group packages/python/pyproject.toml:test
	$(MAKE) --no-print-directory python-models
# python-venv-check checks that the venv of orm-install-python exists and runs the Python release of mise.toml. A missing venv
# or another release fails without a download or a repair, and names the fix: remove the venv and run make install.
.PHONY: python-venv-check
python-venv-check:
	@test -x $(PYTHON_VENV)/bin/python || { echo "python-venv-check: $(PYTHON_VENV)/bin/python is missing; run make install, which creates it"; exit 1; }
	@got=$$($(PYTHON_VENV)/bin/python -c 'import platform; print(platform.python_version())') || { echo "python-venv-check: $(PYTHON_VENV)/bin/python does not run; remove $(PYTHON_VENV) and run make install, which builds it from the Python of mise.toml"; exit 1; }; \
	want=$$(mise current python) || { echo "python-venv-check: mise does not name the Python of mise.toml; run make install-tools"; exit 1; }; \
	test "$$got" = "$$want" || { echo "python-venv-check: $(PYTHON_VENV) runs Python $$got, but mise.toml declares $$want; remove $(PYTHON_VENV) and run make install, which builds it from the Python of mise.toml"; exit 1; }

# php-vendor-check fails when vendor-php/autoload.php or the PHPUnit of packages/php or packages/php-ext, which orm-install-php
# creates with Composer, is missing, and names the make step that creates it; it installs nothing. A target that runs PHP
# through packages/php/tests/autoload.php or a package's PHPUnit takes it as a prerequisite.
.PHONY: php-vendor-check
php-vendor-check:
	@for file in vendor-php/autoload.php vendor-php/bin/phpunit; do test -f $$file || { echo "php-vendor-check: $$file is missing; run make orm-install-php, which installs it with Composer"; exit 1; }; done
	@$(NODE) scripts/php/vendor-autoload-check.mjs

# python-check runs the Python client's unit tests, the interface tests of the Python extractor, the generated-model check and
# the Python conformance result check. The tests import the client and ordered-json installed into the venv (orm-install-python).
.PHONY: python-check python-unit-check python-interface-unit-check
python-check: python-unit-check python-interface-unit-check python-model-check conformance-result-check/python
python-unit-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- discover -s packages/python/tests -t . -p 'test_*.py'

# The DB-free complex query cases cover Python's fluent full-text chains and paginate statement order.
.PHONY: python-complex-query-check
python-complex-query-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_complex_query.ComplexQueryTest.test_public_fulltext_boolean_chain_builds_typed_ir packages.python.tests.test_complex_query.ComplexQueryTest.test_public_semijoin_product_search_builds_page_plan

# The shared CPX-2 fixture's generated Product API runs once on each database in the CI database group.
.PHONY: complex-query-python-mysql-check complex-query-python-postgres-check complex-query-python-sqlite-check
complex-query-python-mysql-check: python-venv-check
	$(WITH_TEST_ENV) ORM_FEATURE_DATABASE=mysql ORM_FEATURE_DSN="$${COMPLEX_QUERY_PYTHON_MYSQL_DSN:?COMPLEX_QUERY_PYTHON_MYSQL_DSN is missing; run make databases-create COMPLEX_QUERY=1, which prepares the CPX-2 owner fixture}" $(PYTHON_VENV)/bin/python -m packages.python.tests.coverage_complex_query complex_query_product_search
complex-query-python-postgres-check: python-venv-check
	$(WITH_TEST_ENV) ORM_FEATURE_DATABASE=postgres ORM_FEATURE_DSN="$${COMPLEX_QUERY_PYTHON_POSTGRES_DSN:?COMPLEX_QUERY_PYTHON_POSTGRES_DSN is missing; run make databases-create COMPLEX_QUERY=1, which prepares the CPX-2 owner fixture}" $(PYTHON_VENV)/bin/python -m packages.python.tests.coverage_complex_query complex_query_product_search
complex-query-python-sqlite-check: python-venv-check
	$(WITH_TEST_ENV) ORM_FEATURE_DATABASE=sqlite ORM_FEATURE_DSN="$${COMPLEX_QUERY_PYTHON_SQLITE_DSN:?COMPLEX_QUERY_PYTHON_SQLITE_DSN is missing; run make databases-create COMPLEX_QUERY=1, which prepares the CPX-2 owner fixture}" $(PYTHON_VENV)/bin/python -m packages.python.tests.coverage_complex_query complex_query_product_search

# The shared blind-index target regression runs only the Python client's pure planner tests.
blind-index-source-python-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_blind_index_source
python-interface-unit-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- discover -s packages/python/tests -t . -p 'test_python_[en]*.py'
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
	CARGO_TARGET_DIR=$(RUN_TARGET) POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python DBSPEC_STRESS_DOCUMENT=$(DBSPEC_COMPARE_DOCUMENT) $(NODE) --test tests/dbspec/compare/runners.test.mts
dbspec-compare-check/inputs: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python DBSPEC_STRESS_DOCUMENT=$(DBSPEC_COMPARE_DOCUMENT) $(NODE) --test tests/dbspec/inputs.test.mts
dbspec-compare-check/compare: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python $(NODE) tests/dbspec/compare/check.mts tests/dbspec/cases.json $(DBSPEC_COMPARE_DOCUMENT) tests/dbspec/ddl.json tests/dbspec/plans.json tests/dbspec/mermaid.json tests/dbspec/syntax.json

dbspec-compare-bench:
	$(MAKE) --no-print-directory dbspec-compare-check DBSPEC_COMPARE_TABLES=2000

# dbspec-stress-bench parses and emits the 2000-table stress document twice each in Go, PHP, TypeScript, and Rust,
# prints the parse time as a ratio to the reference workload (docs/spec/dbspec.md "Verification"), and checks that emit(parse(doc)) == doc and that the two
# emissions match (Rust uses a release build), and it measures PHP introspection on SQLite.
.PHONY: dbspec-stress-bench
# The parts read the stress document in the RUN_DIR of the top target together, and each language's part is independent.
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
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecStressTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecStressTest.php
dbspec-stress-bench/php-introspect: php-vendor-check dbspec-stress-bench/prepare
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecIntrospectStressTest.php
dbspec-stress-bench/typescript: dbspec-stress-bench/prepare lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/dbspec-stress.mjs
	$(NODE) --test packages/ts/tests/dbspec-stress.mjs
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
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-schema --lib dbspec::set
# dbspec-rust-check/unicode checks that the Unicode word rune table written by Go (unicode_word.rs) matches the ranges at every code point.
dbspec-rust-check/unicode: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --lib dbspec::unicode_word -- --nocapture
dbspec-rust-check/apply-cleanup: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply_cleanup -- --nocapture

.PHONY: dbspec-verify-errors-rust-check
dbspec-verify-errors-rust-check: cargo-downloads-check lease-tool
	$(LEASE) hold $(CARGO_LEASES) exclusive --wait --pid $$PPID
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply_cleanup apply_reports_verify_errors_separately_from_drift -- --nocapture

.PHONY: dbspec-verify-errors-check dbspec-verify-errors-php-extension-check
dbspec-verify-errors-check: dbspec-verify-errors-rust-check dbspec-verify-errors-php-extension-check php-vendor-check python-venv-check lease-tool
	$(HOLD_TYPESCRIPT)
	$(GO_TEST) ./packages/go/engine/dbspec -run '^TestSettledVerifyPreservesIntrospectionErrors$$' -count=1
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter testVerifyErrorsAreNotDriftAndPreserveCause packages/php/tests/DbspecApplyCleanupTest.php
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_dbspec_verify_errors
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/dbspec-apply-verify-errors.mjs
dbspec-verify-errors-php-extension-check: php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/dbspec-verify-errors-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so" release; env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecVerifyErrorsTest.php
# dbspec-rust-check/show-create checks that shown_checks (mysql.rs) reads every case of tests/dbspec/show-create.json with the expected body,
# and that the public MySQL introspection (read_catalog) reports, for each case of that catalog, the expected check, unsupported objects, and error.
dbspec-rust-check/show-create: dbspec-rust-check/show-create/unit dbspec-rust-check/show-create/vectors
.PHONY: dbspec-rust-check/show-create/unit dbspec-rust-check/show-create/vectors
dbspec-rust-check/show-create/unit: cargo-downloads-check
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-schema --lib show_create_tests
dbspec-rust-check/show-create/vectors: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --test dbspec_show_create -- --nocapture

.PHONY: rust-send-savepoint-check
# The run directory of a part is that of the top target (if $@ contains a /, the directory gets one more level).
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
# dbspec-php-check runs twice each: the shared dbspec vectors, the PHP rules, the statement vectors of tests/dbspec/ddl.json,
# the plan vectors of tests/dbspec/plans.json, the Mermaid vectors of tests/dbspec/mermaid.json, and the apply cleanup errors injected through a wrapped SQLite
# connection, each twice. The stress document is run by make
# bench.
dbspec-php-check: dbspec-php-check/documents dbspec-php-check/graph dbspec-php-check/behaviour dbspec-php-check/show-create-introspect dbspec-php-check/rules dbspec-php-check/manifest dbspec-php-check/render dbspec-php-check/plan dbspec-php-check/mermaid dbspec-php-check/apply-cleanup dbspec-php-check/unicode dbspec-php-check/show-create dbspec-php-check/analyze dbspec-php-check/set dbspec-php-check/set-parse
.PHONY: dbspec-php-check/documents dbspec-php-check/graph dbspec-php-check/behaviour dbspec-php-check/show-create-introspect dbspec-php-check/rules dbspec-php-check/manifest dbspec-php-check/render dbspec-php-check/plan dbspec-php-check/mermaid dbspec-php-check/apply-cleanup dbspec-php-check/unicode dbspec-php-check/show-create dbspec-php-check/analyze dbspec-php-check/set dbspec-php-check/set-parse
dbspec-php-check/documents: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecTest.php
# dbspec-php-check/graph checks that a document, document set, plan list or unsupported list whose array holds another type is a TypeError.
dbspec-php-check/graph: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecGraphTest.php
# dbspec-php-check/behaviour checks the PHP behaviours that no shared vector fixes against fixtures/dbspec-behaviour.json, which
# php packages/php/testing/dbspec/behaviour.php records from the PHP library.
dbspec-php-check/behaviour: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecBehaviourTest.php
# dbspec-php-check/show-create-introspect reads the canned MySQL catalog of tests/dbspec/show-create.json through introspect.
dbspec-php-check/show-create-introspect: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecShowCreateIntrospectTest.php
dbspec-php-check/rules: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRulesTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRulesTest.php
dbspec-php-check/manifest: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecManifestTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecManifestTest.php
dbspec-php-check/render: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRenderTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRenderTest.php
dbspec-php-check/plan: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanTest.php
dbspec-php-check/mermaid: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecMermaidTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecMermaidTest.php
dbspec-php-check/apply-cleanup: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyCleanupTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyCleanupTest.php
# dbspec-php-check/unicode checks that the PHP UnicodeWord table matches its ranges at every code point (the table itself is matched to Go by dbspec-go-check/unicode).
dbspec-php-check/unicode: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecUnicodeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecUnicodeTest.php
# dbspec-php-check/show-create checks that MysqlCatalog::createChecks reads every case of tests/dbspec/show-create.json with the expected body.
# dbspec-php-check/analyze checks syntax analysis and format with focused cases and every case of cases.json (docs/spec/dbspec.md "Syntax analysis", "Formatting").
dbspec-php-check/analyze: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecAnalyzeTest.php
dbspec-php-check/show-create: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecShowCreateTest.php
# dbspec-php-check/set runs Dbspec::readSet on every case of tests/dbspec/set-files.json and the focused cases, each
# a temporary file tree with real symbolic and hard links (docs/spec/dbspec.md "Document sets").
dbspec-php-check/set: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSetTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SetReaderDiagnosticsTest.php
# dbspec-php-check/set-parse runs Dbspec::parseSet on every case of tests/dbspec/set-parse.json (docs/spec/dbspec.md
# "Parsing a set").
dbspec-php-check/set-parse: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSetParseTest.php

.PHONY: dbspec-php-extension-check
# dbspec-php-extension-check checks the PHP extension polyspec_orm (packages/php-ext), which implements the PHP client's dbspec surface and
# error codes in C under the client's own class names (Polyspec\Orm\Dbspec\*, Polyspec\Orm\Code; docs/spec/dbspec.md, DBS-172): it checks
# the names, the one stub and the stub hash of src/polyspec_orm_arginfo.h (make lint-php-ext), builds the extension with phpize in this
# run's directory, checks that its Reflection matches src/polyspec_orm.stub.php and the PHP client's public classes (DeclarationsTest), and
# runs the PHP client's tests (packages/php/tests) with the extension loaded and `--without-library packages/php`, so no fallback
# class from packages/php/src can load. A run that holds results of a whole document set runs twice. The build uses the phpize and
# php-config on PATH, which make orm-install-php-extension-tools checks; make php-ext-arginfo rewrites the header from the stub.
PHP_EXTENSION_LIBRARY = $(RUN_DIR)/php-extension/polyspec_orm.so
# PHP_EXTENSION_TESTS runs PHPUnit files of packages/php with the extension loaded, through kit's run-tests, which gives each test
# its own timeout (K436); both extension PHPUnit commands exclude userland fallbacks (T182-6-19).
PHP_EXTENSION_TESTS = env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) --without-library packages/php -- --configuration packages/php/phpunit.xml.dist
PHP_EXTENSION_NATIVE_TESTS = env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist
PHP_CODEC_CAUSE_TEST_FILTER = testCodecExpectedExceptionCause|testCodecUnexpectedThrowableIdentity
PHP_CODEC_CAUSE_NATIVE_FILTER = testCodecExpectedExceptionCause|testCodecUnexpectedThrowableIdentity
PHP_CODEC_CAUSE_NATIVE_YAML_FILTER = testYamlExpectedCauseIdentity|testYamlUnexpectedThrowableIdentity
.PHONY: php-codec-causes-check
php-codec-causes-check: php-models build-php-ext
	@set -eu; \
	status=0; \
	if env ORM_PHP_MODE=library $(RUN_TESTS) phpunit --timeout 300 -- --configuration packages/php/phpunit.xml.dist --filter '$(PHP_CODEC_CAUSE_TEST_FILTER)' packages/php/tests/CodecVectorsTest.php; then :; else status=1; fi; \
	if env ORM_PHP_MODE=library $(RUN_TESTS) phpunit --timeout 300 -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecYamlCauseTest.php; then :; else status=1; fi; \
	if env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --timeout 300 --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php/phpunit.xml.dist --filter '$(PHP_CODEC_CAUSE_NATIVE_FILTER)' packages/php/tests/CodecVectorsTest.php; then :; else status=1; fi; \
	if env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --timeout 300 --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist --filter '$(PHP_CODEC_CAUSE_NATIVE_YAML_FILTER)' packages/php-ext/tests/CodecCauseTest.php; then :; else status=1; fi; \
	exit "$$status"
dbspec-php-extension-check/%: RUN_DIR = $(abspath .runtime/run)/dbspec-php-extension-check-$$PPID
.PHONY: dbspec-php-extension-check/arginfo dbspec-php-extension-check/prepare dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/sets dbspec-php-extension-check/render dbspec-php-extension-check/graph dbspec-php-extension-check/behaviour dbspec-php-extension-check/schema-definition dbspec-php-extension-check/analyze dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup dbspec-php-extension-check/plan-apply dbspec-php-extension-check/show-create dbspec-php-extension-check/set dbspec-php-extension-check/set-parse dbspec-php-extension-check/codec dbspec-php-extension-check/code-catalog dbspec-php-extension-check/decode dbspec-php-extension-check/aes dbspec-php-extension-check/hostcodec dbspec-php-extension-check/ir dbspec-php-extension-check/planner dbspec-php-extension-check/executor
dbspec-php-extension-check: dbspec-php-extension-check/arginfo dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/sets dbspec-php-extension-check/render dbspec-php-extension-check/graph dbspec-php-extension-check/behaviour dbspec-php-extension-check/schema-definition dbspec-php-extension-check/stress-canonical dbspec-php-extension-check/analyze dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup dbspec-php-extension-check/plan-apply dbspec-php-extension-check/show-create dbspec-php-extension-check/set dbspec-php-extension-check/set-parse dbspec-php-extension-check/codec dbspec-php-extension-check/code-catalog dbspec-php-extension-check/decode dbspec-php-extension-check/aes dbspec-php-extension-check/hostcodec dbspec-php-extension-check/planner dbspec-php-extension-check/executor
	rm -rf $(RUN_DIR)
dbspec-php-extension-check/arginfo:
	$(NODE) $(KIT)/php-extension.$(KIT_EXT) check
dbspec-php-extension-check/prepare:
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
# Builds the extension in an isolated run directory and executes only its native Collection unit cases.
collection-php-extension-check: RUN_DIR = $(abspath .runtime/run)/collection-php-extension-check-$$PPID
COLLECTION_TEST_FILTER ?=
.PHONY: collection-php-extension-check
collection-php-extension-check: php-vendor-check
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CollectionTest.php $(if $(COLLECTION_TEST_FILTER),--filter '$(COLLECTION_TEST_FILTER)',); \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(ORM_PHP_DYNAMIC_MODULES)' $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testDeclarations|testClient|testRequiredModules' packages/php-ext/tests/DeclarationsTest.php; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CollectionIdentityTest.php

# The native PHP extension planner runs the same blind-index source cases as the PHP client.
blind-index-source-php-extension-check: php-vendor-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/blind-index-source-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/BlindIndexSourceNativeTest.php

# Runs the native Model helper surface cases against a fresh extension build; the source-library comparison is a separate PHPUnit run.
model-types-php-extension-check: php-vendor-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-types-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelTypesSurfaceTest.php packages/php-ext/tests/PlanCacheBoundNativeTest.php packages/php-ext/tests/PlanCacheMemoryNativeTest.php; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testPlanCacheRetainsAtMostTheBoundOfPlaceholders|testPlanCachePromotesHitsAndEvictsTheLeastRecentlyUsedPlan|testStatementCacheRetainsAtMostTheBoundOfPlaceholders' packages/php/tests/PlanCacheMemoryTest.php; \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(ORM_PHP_DYNAMIC_MODULES)' $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DeclarationsTest.php; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelTypesSourceTest.php

# Exercises native model query assembly and write round trips on an owned SQLite in-memory database.
.PHONY: model-query-write-php-extension-unit-check
MODEL_QUERY_WRITE_TEST_FILTER ?= testNativeModel|testConformanceChildLoadsTheNativeModelEntrypoint
model-query-write-php-extension-unit-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-query-write-php-extension-unit-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelQueriesWritesNativeTest.php packages/php-ext/tests/CoverageConformanceVerificationExtensionTest.php --filter '$(MODEL_QUERY_WRITE_TEST_FILTER)'

# Runs the extension-mode model fixtures required by T182-6, using the same fixture cases as the PHP owner tests.
T182_MODEL_TEST_FILTER ?=
t182-php-extension-model-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/t182-php-extension-model-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageNativeFixtureExtensionTest.php $(if $(T182_MODEL_TEST_FILTER),--filter '$(T182_MODEL_TEST_FILTER)',)

# Runs the changed-database installation fixture through the native extension on each configured database.
t182-php-extension-schema-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/t182-php-extension-schema-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageNativeChangedDatabaseExtensionTest.php

# Runs the complete native Model surface and its native helper classes against a fresh extension; generated PHP models use their normal bootstrap.
# MODEL_NATIVE_TEST_FILTER=testNativeSqliteRoundTrip selects only the server-free decimal native SQLite owner case.
.PHONY: model-native-php-extension-check
MODEL_NATIVE_TEST_FILTER ?=
model-native-php-extension-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-native-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelNativeTest.php packages/php-ext/tests/MarkdownNativeTest.php packages/php-ext/tests/AuditLazyFakePdoTest.php packages/php-ext/tests/RequestHookNativeTest.php packages/php-ext/tests/ModelDslNativeTest.php packages/php-ext/tests/ModelReadNativeTest.php packages/php-ext/tests/ModelWriteSurfaceTest.php packages/php-ext/tests/ModelAssemblyTest.php packages/php-ext/tests/ModelStreamReadTest.php packages/php-ext/tests/RuntimeModelTest.php packages/php-ext/tests/ChainNativeSurfaceTest.php packages/php-ext/tests/RegistrySchemaNativeTest.php packages/php-ext/tests/PlanCacheMemoryNativeTest.php packages/php-ext/tests/DecimalModelSqliteNativeTest.php $(if $(MODEL_NATIVE_TEST_FILTER),packages/php/tests/PlanCacheMemoryTest.php,) $(if $(MODEL_NATIVE_TEST_FILTER),--filter '$(MODEL_NATIVE_TEST_FILTER)',); \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(ORM_PHP_DYNAMIC_MODULES)' $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testDeclarations|testClient|testRequiredModules' packages/php-ext/tests/DeclarationsTest.php; \
	if [ -z '$(MODEL_NATIVE_TEST_FILTER)' ]; then env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php packages/php/tests/ModelTypesSourceTest.php; fi

# Runs the native root-IN chunking and composite-key probes against in-memory SQLite.
.PHONY: model-chunk-composite-native-php-extension-check
model-chunk-composite-native-php-extension-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-chunk-composite-native-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'test_native_fixture_populates_all_composite_key_columns|test_root_in_chunks_use_native_model_queries_and_reject_unmergeable_pages|testSplitRootInCountPlansNoStatementOverTheBindLimit|test_composite_relation_keys_split_and_pad_to_bind_safe_size_classes|test_composite_relation_binds_and_assembles_both_key_components|test_tuple_predicates_and_pages_keep_the_full_composite_key' packages/php-ext/tests/ParameterChunkingNativeTest.php packages/php-ext/tests/CompositeKeysNativeTest.php

# Runs focused grouped-result decoder and native GroupRow count units through the PHP extension.
.PHONY: group-count-boolean-php-extension-unit-check
group-count-boolean-php-extension-unit-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/group-count-boolean-php-extension-unit-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelAssemblyTest.php --filter 'testGroupValueRejectsInvalidStoredBoolean|testGroupRowPreservesTypedValuesAndChecksItsCount|testGroupValuePreservesExactI64|testGroupRowCountEnforcesExactness'

# Runs the database-independent Rust group boolean decoder test with the checkout's target lease.
.PHONY: group-count-boolean-rust-unit-check
group-count-boolean-rust-unit-check:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) group-count-boolean-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --manifest-path packages/rust/Cargo.toml --locked --offline --workspace --features "$(ORM_RUST_TEST_FEATURES)" -p polyspec-orm --lib row::declared_boolean_tests::invalid_stored_boolean_is_codec_decode -- --test-threads=1 --exact

# Runs the exact i64 grouped result decode and assembly test with the checkout's target lease.
.PHONY: group-result-exact-i64-rust-unit-check
group-result-exact-i64-rust-unit-check:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) group-result-exact-i64-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --manifest-path packages/rust/Cargo.toml --locked --offline --workspace --features "$(ORM_RUST_TEST_FEATURES)" -p polyspec-orm --lib row::exact_i64_tests::grouped_result_preserves_exact_i64_value -- --test-threads=1 --exact

# Runs the GroupRow count decoder unit with the checkout's target lease.
.PHONY: group-row-count-rust-unit-check
group-row-count-rust-unit-check:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) group-row-count-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --manifest-path packages/rust/Cargo.toml --locked --offline --workspace --features "$(ORM_RUST_TEST_FEATURES)" -p polyspec-orm --lib collection::group_count_exactness_tests::count_exactness_matches_the_safe_integer_contract -- --test-threads=1 --exact

# Runs grouped-boolean, exact i64, and row-count contract cases through each native result path.
group-count-boolean-unit-check: lease-tool php-vendor-check php-model-check python-venv-check typescript-build
	@set +e; status=0; last_result=0; \
	run_case() { label=$$1; shift; printf '[group-result] %s\n' "$$label"; "$$@"; last_result=$$?; printf '[group-result] %s exit %s\n' "$$label" "$$last_result"; if [ "$$last_result" -ne 0 ]; then status=1; fi; return 0; }; \
	run_case go $(GO_TEST) ./packages/go/orm -run '^(TestGroupCountRejectsInvalidStoredBoolean|TestGroupCountPreservesExactI64Value|TestGroupRowCountEnforcesExactness)$$' -count=1; \
	run_case php env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/GroupRowsTest.php --filter 'testGroupValueRejectsInvalidStoredBoolean|testGroupRowPreservesTypedValuesAndChecksItsCount|testGroupResultPreservesExactI64Value|testGroupRowCountEnforcesExactness'; \
	run_case php-extension $(MAKE) --no-print-directory group-count-boolean-php-extension-unit-check; \
	run_case typescript $(NODE) --test --test-name-pattern='group_rows/(boolean_invalid_stored_value|exact_i64_preserved|count_exactness)' packages/ts/tests/group_rows.mjs; \
	run_case python-boolean $(PYTHON_VENV)/bin/python -m packages.python.tests.test_group_rows GroupBooleanValueTest.test_group_boolean_rejects_non_boolean_float; \
	run_case python-i64 $(PYTHON_VENV)/bin/python -m packages.python.tests.test_group_rows GroupExactI64ValueTest.test_group_result_preserves_exact_i64_value; \
	run_case python-count $(PYTHON_VENV)/bin/python -m packages.python.tests.test_group_rows GroupRowCountTest.test_count_exactness; \
	run_case rust-boolean $(MAKE) --no-print-directory group-count-boolean-rust-unit-check; \
	run_case rust-i64 $(MAKE) --no-print-directory group-result-exact-i64-rust-unit-check; \
	run_case rust-count $(MAKE) --no-print-directory group-row-count-rust-unit-check; \
	exit "$$status"

# Exercises ordered-json result text through each client's actual model output serializer.
.PHONY: model-json-ordered-number-text-unit-check
model-json-ordered-number-text-unit-check: lease-tool php-vendor-check php-model-check python-venv-check typescript-build
	@set +e; status=0; last_result=0; \
	run_case() { label=$$1; shift; printf '[model-json-text] %s\n' "$$label"; "$$@"; last_result=$$?; printf '[model-json-text] %s exit %s\n' "$$label" "$$last_result"; if [ "$$last_result" -ne 0 ]; then status=1; fi; return 0; }; \
	run_case go $(GO_TEST) ./packages/go/model -run '^TestModelOrderedJSONOutputPreservesExactText$$' -count=1; \
	run_case php env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelJsonTextTest.php; \
	run_dir="$(abspath .runtime/run)/model-json-ordered-number-text-unit-check-$$PPID"; extension="$$run_dir/php-extension/polyspec_orm.so"; \
	trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	run_case php-extension-build $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$extension"; \
	if [ "$$last_result" -eq 0 ]; then run_case php-extension env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$extension" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelNativeTest.php --filter testNativeModelJsonPreservesOrderedJsonNumberText; else printf '[model-json-text] php-extension native case not run because extension build failed\n'; fi; \
	run_case typescript $(NODE) --test packages/ts/tests/model_json_output.test.mts; \
	run_case python $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_json_text ModelJsonTextTest.test_model_output_preserves_ordered_json_number_text; \
	run_case rust env PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) model-json-ordered-number-text-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --manifest-path packages/rust/Cargo.toml --locked --offline --workspace --features "$(ORM_RUST_TEST_FEATURES)" -p polyspec-orm --test model_output json_output_keeps_the_ordered_json_text -- --test-threads=1 --exact; \
	exit "$$status"

# dbspec-php-extension-check/declarations runs the extension's own checks (packages/php-ext/tests): its declarations against the stub and the
# PHP client, its required modules and its PIE package.
# dbspec-php-extension-check/silent-paths runs silent_paths.php with the extension alone (php -n, no library class): a call that must fail with an OrmException must throw, not return silently (T182-2-4).
dbspec-php-extension-check/silent-paths: dbspec-php-extension-check/prepare
	$(CURDIR)/var/tools/bin/php -n -d extension=$(PHP_EXTENSION_LIBRARY) packages/php-ext/tests/silent_paths.php
# dbspec-php-extension-check/statement-event runs StatementEventSurfaceTest with the extension loaded: the class is the extension's own (KSTD-7-1).
dbspec-php-extension-check/statement-event: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php-ext/tests/StatementEventSurfaceTest.php
# ORM_PHP_DYNAMIC_MODULES lists the modules that php -n loads from extension_dir, comma separated. empty: the local PHP has pdo built in;
# CI sets pdo for Ubuntu, where pdo is a shared module.
ORM_PHP_DYNAMIC_MODULES ?=
dbspec-php-extension-check/declarations: php-vendor-check dbspec-php-extension-check/prepare
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES=$(ORM_PHP_DYNAMIC_MODULES) $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DeclarationsTest.php
# dbspec-php-extension-check/vectors runs DbspecTest with the extension: the canonical, normalize, invalid, files, positions, bytes and arguments cases of tests/dbspec/cases.json, introspection and apply on SQLite.
dbspec-php-extension-check/vectors: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecTest.php
# dbspec-php-extension-check/sets runs DbspecManifestTest with the extension: the hashes and sets cases of tests/dbspec/cases.json.
dbspec-php-extension-check/sets: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecManifestTest.php
# dbspec-php-extension-check/render runs DbspecRenderTest with the extension: the statements of tests/dbspec/ddl.json.
dbspec-php-extension-check/render: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecRenderTest.php
# dbspec-php-extension-check/graph runs DbspecGraphTest with the extension: the TypeError of a document or plan whose array holds another type.
dbspec-php-extension-check/graph: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecGraphTest.php
# dbspec-php-extension-check/behaviour runs DbspecBehaviourTest with the extension: the PHP behaviours of fixtures/dbspec-behaviour.json, Names among them.
dbspec-php-extension-check/behaviour: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecBehaviourTest.php
# dbspec-php-extension-check/schema-definition runs CoverageSchemaDefinitionTest with the extension: the cases of contracts/fixtures/schema_definition.json.
dbspec-php-extension-check/schema-definition: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/CoverageSchemaDefinitionExtensionTest.php

# dbspec-php-extension-check/stress-canonical runs the exact large canonical round-trip owner with the native parser.
dbspec-php-extension-check/stress-canonical: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecStressCanonicalNativeTest.php
# dbspec-php-extension-check/analyze runs DbspecAnalyzeTest with the extension: the syntax analysis and format of the focused cases, of tests/dbspec/syntax.json and of the limit errors; DbspecRulesNativeTest checks the global column and foreign-key limits through the native parser.
dbspec-php-extension-check/analyze: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecAnalyzeTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecAnalyzeTest.php
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecRulesNativeTest.php
# dbspec-php-extension-check/plan runs DbspecPlanTest with the extension: the plan vectors of tests/dbspec/plans.json.
dbspec-php-extension-check/plan: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecPlanTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecPlanTest.php
# dbspec-php-extension-check/mermaid runs DbspecMermaidTest with the extension: the Mermaid vectors.
dbspec-php-extension-check/mermaid: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecMermaidTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecMermaidTest.php
# dbspec-php-extension-check/apply-cleanup runs DbspecApplyCleanupTest with the extension: the cleanup errors of apply after a failing PDO.
dbspec-php-extension-check/apply-cleanup: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecApplyCleanupTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecApplyCleanupTest.php
# dbspec-php-extension-check/plan-apply runs DbspecPlanApplyTest with the extension: every plan case of tests/dbspec/plans.json applied to MySQL, PostgreSQL and SQLite.
dbspec-php-extension-check/plan-apply: php-vendor-check dbspec-php-extension-check/prepare
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/DbspecPlanApplyTest.php
# dbspec-php-extension-check/show-create runs DbspecShowCreateIntrospectTest with the extension: introspection of the canned MySQL catalog of tests/dbspec/show-create.json.
dbspec-php-extension-check/show-create: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecShowCreateIntrospectTest.php
# dbspec-php-extension-check/set runs DbspecSetTest with the extension: Dbspec::readSet on every case of tests/dbspec/set-files.json and the focused cases.
dbspec-php-extension-check/set: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecSetTest.php
# dbspec-php-extension-check/codec runs CodecVectorsTest with the extension: the PHP side of tests/codec/vectors.json (each vector decodes
# to its value and encodes as the file says, with the YAML and error cases of the test). The outputs of the other languages are read by
# codec-check/compare, which runs them; this target does not read them.
dbspec-php-extension-check/codec: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/CodecVectorsTest.php --filter 'testPhpVector|test_yaml_core|testPhpError|testPhpYamlIntegerMapKey'
# dbspec-php-extension-check/code-catalog runs CodeCatalogTest with the extension: the codes of docs/spec/errors.yaml against Code.php, and the
# class that the extension registers as Polyspec\Orm\Code, which must hold the same codes.
dbspec-php-extension-check/code-catalog: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/CodeCatalogTest.php
# dbspec-php-extension-check/aes runs CodecAesVectorsTest with the extension: the AES v2 vectors of tests/codec/aes-vectors.json (the aes
# and hex host stages round-trip, the fixed envelope decodes, and the empty-key and tampered cases give their codes).
dbspec-php-extension-check/aes: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/CodecAesVectorsTest.php
# dbspec-php-extension-check/hostcodec runs the whole HostcodecTest with the extension: the host stages (aes, hex, ip), the blind index
# and the shared decode vectors.
dbspec-php-extension-check/hostcodec: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/HostcodecTest.php
# dbspec-php-extension-check/decode runs the codec-decode suite (tests/codec/decode-vectors.json) with the extension: the test_decode_vector
# data sets of HostcodecTest, which decode each stored cell through Codec::hostDecode (hex, ip) or Codec::decode.
dbspec-php-extension-check/decode: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/HostcodecTest.php --filter testDecodeVector
# dbspec-php-extension-check/ir runs only the native Validator owner over shared tests/ir/validate.json, without the PHP fallback.
PHP_EXTENSION_IR_TEST_FILTER ?= testValidate
dbspec-php-extension-check/ir: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) --filter '$(PHP_EXTENSION_IR_TEST_FILTER)' packages/php-ext/tests/ValidatorNativeTest.php
# dbspec-php-extension-check/set-parse runs DbspecSetParseTest with the extension: Dbspec::parseSet on every case of tests/dbspec/set-parse.json.
dbspec-php-extension-check/set-parse: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecSetParseTest.php
# dbspec-php-extension-check/planner runs the planner suites with the extension: the native-owner CoveragePlannerExtensionTest
# (the compile vectors of contracts/fixtures/planner.json), InsertPartsTest (contracts/fixtures/insert_parts.json) and IrAnswersTest
# (contracts/fixtures/ir_answers.json).
# It first checks that the extension registers Polyspec\Orm\Planner: its class is internal, so the planner the suites run is C.
dbspec-php-extension-check/planner: dbspec-php-extension-check/planner/coverage dbspec-php-extension-check/planner/insert-parts dbspec-php-extension-check/planner/ir-answers

# The planner parts are independent: each runs as its own target after the class check, so make -j runs them together.
dbspec-php-extension-check/planner/internal: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) -r 'exit((new ReflectionClass("Polyspec\\Orm\\Planner"))->isInternal() ? 0 : 1);'
PHP_EXTENSION_PLANNER_TEST_FILTER ?= test_
dbspec-php-extension-check/planner/coverage: php-vendor-check dbspec-php-extension-check/planner/internal
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/CoveragePlannerExtensionTest.php --filter '$(PHP_EXTENSION_PLANNER_TEST_FILTER)'
dbspec-php-extension-check/planner/insert-parts: php-vendor-check dbspec-php-extension-check/planner/internal
	$(PHP_EXTENSION_TESTS) packages/php/tests/InsertPartsTest.php
dbspec-php-extension-check/planner/ir-answers: php-vendor-check dbspec-php-extension-check/planner/internal
	$(PHP_EXTENSION_TESTS) packages/php/tests/IrAnswersTest.php

# Runs only the native PHP extension TLS handshake and rejection cases on the configured MySQL TLS server.
mysql-tls-php-extension-check: RUN_DIR = $(abspath .runtime/run)/mysql-tls-php-extension-check-$$PPID
mysql-tls-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/MysqlTlsNativeTest.php

# Runs the native PHP extension MySQL session initialization case against the declared sql_mode vector.
mysql-session-php-extension-check: RUN_DIR = $(abspath .runtime/run)/mysql-session-php-extension-check-$$PPID
mysql-session-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/MysqlSessionNativeTest.php

# Runs the extracted CFG-6 TypeScript lock-wait timeout case on MySQL and PostgreSQL.
connection-statement-timeout-typescript-check: typescript-build
	$(WITH_TEST_ENV) $(NODE) --test packages/ts/tests/statement_timeout.mjs

# Runs the TypeScript CFG-4/CFG-5 live pool-bound cases on SQLite, MySQL and PostgreSQL.
connection-pool-resource-bounds-typescript-check: typescript-build
	$(WITH_TEST_ENV) $(NODE) --test packages/ts/tests/pool_bounds.mjs

# Runs the six-way CFG-2 UTC connection behavior as exact TypeScript database cases.
connection-utc-typescript-check: typescript-build
	$(WITH_TEST_ENV) $(NODE) --test packages/ts/tests/connection_utc.mjs

# Runs CFG-2 through the PHP extension's native Orm::connect with generated model fixtures.
connection-utc-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/connection-utc-php-extension-check-$$$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testNativeConnectionsUseUtc' packages/php-ext/tests/ConnectionUtcNativeTest.php

# Runs the existing PHP library CFG-2 date cases by exact method and data provider.
connection-utc-php-check: php-vendor-check php-models
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter 'testConnectionTimeZone' packages/php/tests/ModelTest.php

# Runs the existing Rust CFG-2 connection test by exact integration test symbol.
connection-utc-rust-check: cargo-downloads-check lease-tool
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) connection-utc-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --test zone connections_use_utc -- --exact --test-threads=1 --nocapture

# dbspec-php-extension-check/executor runs the suites of the connection, the statement path and the transactions with the extension
# loaded: StatementEventsTest (statement-events), StatementFaultTest (statement-fault), DsnTest::testSqlitePath (sqlite-paths) and
# MysqlTlsTest::testSessionSqlMode (mysql-session). It first checks that the extension registers Polyspec\Orm\Db: its class is
# internal, so the connection the suites open is C. The database suites need make orm-test-servers first (WITH_TEST_ENV).
dbspec-php-extension-check/executor: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) -r 'require "vendor-php/autoload.php"; exit((new ReflectionClass("Polyspec\\Orm\\Db"))->isInternal() ? 0 : 1);'
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/StatementEventsTest.php
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/StatementFaultTest.php
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/DsnTest.php --filter testSqlitePath
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/MysqlTlsTest.php --filter testSessionSqlMode
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/ModelTest.php --filter 'test(Transactions|StatementTimeout)'

# repo-check checks that the paths that the root npm script uses are tracked files or
# directories, that the CI workflow starts servers with make orm-test-servers, and that every variable of that environment file is given
# to the check steps (scripts/repo/ci.mts).
# version-check checks that the VERSION file and all of orm's version declarations (the Rust manifests and lockfile, PHP composer,
# TypeScript packages and lockfiles, feature contract, documents) agree.
version-check: version-check/unit version-check/run
version-check/unit:
	$(RUN_TESTS) node -- scripts/version/check.test.mts
version-check/run:
	$(NODE) scripts/version/check.mts

# comment-language-check fails on a Hangul character in a comment of a tracked code file, naming the file and
# line. Each language's comments come from its own lexer (scripts/comments/check.mts), and strings are not comments.
comment-language-check: comment-language-check/unit comment-language-check/run
comment-language-check/unit:
	$(RUN_TESTS) node -- scripts/comments/check.test.mts
comment-language-check/run:
	$(NODE) scripts/comments/check.mts

repo-check: repo-check/unit repo-check/run
repo-check/unit:
	$(RUN_TESTS) node -- scripts/repo/check.test.mts scripts/repo/python-venv.test.mts scripts/repo/worktree-stop.test.mts
repo-check/run:
	$(NODE) scripts/repo/check.mts

makefile-pinned-node-recipes-check:
	$(RUN_TESTS) node -- tests/repo/pinned-node-recipes.test.mts

# orm-test-servers-check checks the MySQL configuration migration of test-servers.mts (scripts/test-servers-mysql.mts) with a temporary
# root server: it moves other configurations in the same count, does nothing for identical configurations, and refuses colliding names
# before changing anything.
.PHONY: orm-test-servers-check
# STOP_PROCESS is the program that waits, when stopping a test server, for the process exit as an operating-system notification
# (tests/stop-process). Its build is a long-running task, so it runs with no deadline under RUN_LONG.
STOP_PROCESS = $(abspath .runtime/bin/stop-process)
BUILD_STOP_PROCESS = $(RUN_LONG) go-build/stop-process -- $(PUBLISH) $(STOP_PROCESS) go build -o @OUT@ ./tests/stop-process

orm-test-servers-check:
	$(BUILD_STOP_PROCESS)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) $(NODE) --test scripts/test-servers.test.mts scripts/test-servers-mysql.test.mts

orm-test-servers:
	$(BUILD_STOP_PROCESS)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) $(NODE) scripts/test-servers.mts start

# make orm-test-servers-tls loads the TLS files of the MySQL TLS cases into running
# servers and writes their DSNs into TEST_ENV; make orm-test-servers does it at the
# start.
orm-test-servers-tls:
	$(NODE) scripts/test-servers.mts tls

orm-test-servers-stop:
	$(BUILD_STOP_PROCESS)
	$(BUILD_LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) $(NODE) scripts/test-servers.mts stop

# worktree-remove WORKTREE=<path> removes a worktree of this repository: it first stops the servers that run from the
# .runtime/servers of that worktree (its make orm-test-servers-stop, which knows them by their pid files), since a server
# whose data directory is removed under it never exits, and then runs git worktree remove.
.PHONY: worktree-remove
worktree-remove:
	@test -n "$(WORKTREE)" || { echo "usage: make worktree-remove WORKTREE=<path>" >&2; exit 2; }
	$(MAKE) -C "$(WORKTREE)" orm-test-servers-stop
	git worktree remove "$(WORKTREE)"

# orm-test-servers-leases lists the lease holders of the servers, and orm-test-servers-leases-clear, when a holder process is gone,
# deletes dead leases (those whose holder and releaser have both ended) and records what it deleted. A dead lease may also be taken by the next request (tests/lease).
SERVERS_LEASES = $(abspath .runtime/servers.leases)
orm-test-servers-leases:
	$(BUILD_LEASE)
	$(LEASE) list $(SERVERS_LEASES)

orm-test-servers-leases-clear:
	$(BUILD_LEASE)
	$(LEASE) clear-dead $(SERVERS_LEASES)

# feature-unit-check checks that the feature documents match the manifest, and runs the unit tests of coverage and owner selection.
# feature-check (feature-coverage, feature-verify-rust, feature-verify-other) builds the TypeScript client once and then runs all
# feature coverage (one native test binary, built once and used by all runs) and the verification commands. The verification commands use the built client.
# The helper checks
# are run by feature-helper-check and the stress targets (feature-stress-mysql-check, feature-stress-pg-sqlite-check). One feature
# is run with `node scripts/features/coverage.mts --feature <id>` and `node scripts/features/check.mts --run --feature <id>`
# under the test environment, as owner-check does.
# feature-owner-check takes the changed files (PATHS, or else the files changed from HEAD and the untracked files) as input, and runs only
# the verification commands and coverage of the features that declare those files, and only the targets that contracts/check-inputs.json declares as scope owners
# (AGENTS.md "Owner checks"). The run uses its own test server environment and databases.
# make owner-check, a target of the kit.mk of @polyspec/kit, passes this target the paths that changed under the rules of
# config/owner-checks.json; hooks-check first checks that the pre-push hook is installed.
.PHONY: feature-owner-check
feature-owner-check: hooks-check
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python node scripts/features/owners.mts $(PATHS)

feature-unit-check: feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select
feature-unit-check/docs:
	$(NODE) scripts/features/build.mts --check
feature-unit-check/coverage:
	$(RUN_TESTS) node -- scripts/features/coverage.test.mts scripts/features/languages.test.mts scripts/features/performance-reference.test.mts
feature-unit-check/owners:
	$(RUN_TESTS) node -- scripts/features/owners.test.mts scripts/features/manifest.test.mts
feature-unit-check/select:
	$(RUN_TESTS) node -- scripts/features/select.test.mts

# feature-go-unit runs one native Go test of a feature for one database, as a parity binding names it: the make variables
# FEATURE_DATABASE, FEATURE_DSN_ENV, FEATURE_TEST and FEATURE_PACKAGE are passed by config/parity.json. The binding runs from
# the package that holds the test and names this target through the checkout root, so the path does not depend on that directory.
.PHONY: feature-go-unit
feature-go-unit:
	$(NODE) packages/go/testing/feature-json.mts --database $(FEATURE_DATABASE) --dsn-env $(FEATURE_DSN_ENV) --test $(FEATURE_TEST) $(FEATURE_PACKAGE)

# feature-rust-unit runs one Rust test of a feature, as a parity binding names it: the make variables FEATURE_CRATE
# (the directory of the crate's Cargo.toml, from the checkout root), FEATURE_CARGO_TARGET (the cargo target option, such as
# `--test client_bench_dsn` or `--bin conformance`) and FEATURE_TEST (the exact name of the test) are passed by
# config/parity.json. The test is selected by its exact name, since a target also holds the database tests that
# feature-rust-database runs. It runs through tests/cargo-test.mts,
# the runner of every Rust test, which gives the test binaries the copied programs they read (polyspec_orm_testcase::program).
.PHONY: feature-rust-unit
feature-rust-unit:
	$(WITH_TEST_ENV) cd $(FEATURE_CRATE) && $(CARGO_TEST) feature-rust-unit -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline $(FEATURE_CARGO_TARGET) -- --test-threads=1 --exact $(FEATURE_TEST)

# feature-rust-database runs one Rust database test of a feature against one database, as a parity binding names it:
# FEATURE_CRATE, FEATURE_CARGO_TARGET and FEATURE_TEST as feature-rust-unit, and FEATURE_DATABASE with FEATURE_DSN_ENV (the
# database, and the variable that holds its DSN). The test needs that database, so it is selected by its exact name only where
# the database is given: the feature checker runs it with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN set for each database of its
# coverage item (scripts/features/coverage.mts), and this target does the same for the one database that the binding names.
.PHONY: feature-rust-database
feature-rust-database:
	$(WITH_TEST_ENV) cd $(FEATURE_CRATE) && ORM_FEATURE_DATABASE=$(FEATURE_DATABASE) ORM_FEATURE_DSN="$$$(FEATURE_DSN_ENV)" $(CARGO_TEST) feature-rust-database -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline $(FEATURE_CARGO_TARGET) -- --test-threads=1 --exact $(FEATURE_TEST)

# feature-check is the feature coverage and all verification commands, and make orm-check runs them as three targets: feature-coverage is
# coverage, feature-verify-rust runs the verification commands of shard rust (the commands that build and run Rust with cargo), and feature-verify-other
# runs the verification commands of shard other (`shard` in contracts/features.json). CI runs the three in different groups at the same time. Features that declare the same
# command are in the same shard, and that command runs once (scripts/features/check.mts).
# feature-check is the feature coverage and all verification commands, and make orm-check runs them as three targets: feature-coverage is
# coverage, feature-verify-rust runs the verification commands of shard rust (the commands that build and run Rust with cargo), and feature-verify-other
# runs the verification commands of shard other (`shard` in contracts/features.json). CI runs the three in different groups at the same time. Features that declare the same
# command are in the same shard, and that command runs once (scripts/features/check.mts).
feature-check: feature-coverage feature-verify-rust feature-verify-other
feature-check/build: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
# The Python owners of the coverage run on the client's venv (ORM_PYTHON), which imports the installed client (scripts/features/coverage.mts).
# The php-extension owners run on a PHP that loads the extension polyspec_orm built into the run directory of this target
# (POLYSPEC_ORM_EXTENSION).
feature-coverage: RUN_DIR = $(abspath .runtime/run)/feature-coverage-$$PPID
feature-coverage: feature-check/build python-venv-check
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) node scripts/features/coverage.mts
	rm -rf $(RUN_DIR)
feature-verify-rust: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run --features --shard rust
feature-verify-other: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run --features --shard other
# feature-helper-check, feature-stress-mysql-check, and feature-stress-pg-sqlite-check run the helper checks of contracts/features.json.
# FEATURE_STRESS_HELPERS is the helper of the stress bench that takes the longest time: the MySQL application of the 2000-table plan
# (FEATURE_STRESS_MYSQL_HELPERS) is run by feature-stress-mysql-check, and the bench of the stress document and PostgreSQL and SQLite application
# (FEATURE_STRESS_PG_SQLITE_HELPERS) by feature-stress-pg-sqlite-check, and the other helpers by feature-helper-check. So
# the CI groups run the feature verification commands, helpers, and stress benches at the same time.
# FEATURE_SUITE_HELPERS is the helper that check runs elsewhere in make orm-check: conformance-runners runs conformance-check,
# conformance-result runs its predecessor target conformance-result-check, and case-database runs case-database-check, and bench-database
# (scripts/bench-db.mts) is run by the setup step databases/create of the runner (scripts/check/databases.mts). feature-helper-check
# leaves out that helper, so make orm-check runs it once per helper check (make repo-check verifies this). make owner-check runs the helper check as is whenever a helper
# file changes.
FEATURE_STRESS_MYSQL_HELPERS = dbspec-apply-stress-mysql
FEATURE_STRESS_PG_SQLITE_HELPERS = dbspec-stress dbspec-apply-stress-pg-sqlite
FEATURE_STRESS_HELPERS = $(FEATURE_STRESS_MYSQL_HELPERS) $(FEATURE_STRESS_PG_SQLITE_HELPERS)
FEATURE_SUITE_HELPERS = bench-database case-database conformance-result conformance-runners native-query-probe python-test-harness phpstan-test-runner php-orm-gen-scan-failure-case audit-native-method-assertions dbspec-sqlite-literal-rows dbspec-introspect-case-rendering-python typescript-catalog-mutation-lock python-catalog-mutation-lock php-group-rows-test-cases php-model-types-test-cases php-dbspec-interface-program php-database-test-assertions php-extension-model-assembly-test-support typescript-internal-column-error typescript-dbspec-plan-fixture physical-command-output typescript-audit-history-rows typescript-captured-error typescript-check-state typescript-mysql-test-options typescript-database-case-tests typescript-dbspec-physical-database typescript-conditional-entry typescript-database-case-fixture
feature-helper-check: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run --helpers $(addprefix --without-helper ,$(FEATURE_STRESS_HELPERS) $(FEATURE_SUITE_HELPERS))
feature-stress-mysql-check:
	$(WITH_TEST_ENV) node scripts/features/check.mts --run $(addprefix --helper ,$(FEATURE_STRESS_MYSQL_HELPERS))
feature-stress-pg-sqlite-check: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run $(addprefix --helper ,$(FEATURE_STRESS_PG_SQLITE_HELPERS))

feature-docs:
	$(NODE) scripts/features/build.mts

package-check: lease-tool
	$(RUN_LONG) package -- node scripts/package-check.mts

# fuzz-check is a long-running task that runs the fuzzing-instrumented build and one second of fuzzing (-fuzztime), so
# it runs each command with no deadline under RUN_LONG. -fuzztime sets the length of fuzzing.
fuzz-check: fuzz-check/engine-ir fuzz-check/clients-go-orm
fuzz-check/engine-ir:
	$(RUN_LONG) fuzz/engine-ir -- go test -v -timeout 0 ./packages/go/engine/ir -run '^$$' -fuzz FuzzDecodeRequest -fuzztime=1s
fuzz-check/clients-go-orm:
	$(RUN_LONG) fuzz/clients-go-orm -- go test -v -timeout 0 ./packages/go/orm -run '^$$' -fuzz FuzzDecodeCiphertext -fuzztime=1s

# PHP is the PHP program that client-unit-check runs. The check uses the PHP of .php-version as the php on PATH,
# and php-min-check gives the lowest supported release of composer.json.
PHP = php
# RUN_TESTS is kit's run-tests: it runs a unit tool with its reader and fails when no test ran (kit package, ./run-tests).
RUN_TESTS = $(NODE) $(KIT)/run-tests.$(KIT_EXT)
client-unit-check: client-unit-check/dsn client-unit-check/markdown client-unit-check/relation-keys client-unit-check/code-catalog client-unit-check/hostcodec client-unit-check/codec-aes client-unit-check/insert-parts client-unit-check/engine client-unit-check/runtime-model client-unit-check/orm-gen client-unit-check/model-methods client-unit-check/client-generics client-unit-check/perf-extensions client-unit-check/dbspec-runners
client-unit-check/dbspec-runners: php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRunnerTest.php
client-unit-check/dsn: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DsnTest.php
client-unit-check/markdown: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/MarkdownTest.php
client-unit-check/relation-keys: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RelationKeysTest.php
# client-unit-check/code-catalog compares the generated Code.php with docs/spec/errors.yaml.
client-unit-check/code-catalog: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodeCatalogTest.php
client-unit-check/hostcodec: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/HostcodecTest.php
# client-unit-check/codec-aes runs the AES v2 vectors of tests/codec/aes-vectors.json, one data set per name.
client-unit-check/codec-aes: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecAesVectorsTest.php
# client-unit-check/insert-parts runs the cases of contracts/fixtures/insert_parts.json in PHP and TypeScript.
client-unit-check/insert-parts: php-vendor-check lease-tool
	$(HOLD_TYPESCRIPT)
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/InsertPartsTest.php
	$(TSC_BUILD)
	$(NODE) --conditions=orm-test --test packages/ts/tests/insert-parts.mjs
client-unit-check/engine: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/EngineTest.php

# Shared-target derivation is checked independently in the PHP and TypeScript planners.
blind-index-source-php-check: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/BlindIndexSourcePlannerTest.php

blind-index-source-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --conditions=orm-test --test packages/ts/tests/engine.mjs

# The six SQLite NOWAIT callers restore busy_timeout without hiding the lock error or either failure cause.
.PHONY: nowait-restore-check
nowait-restore-check: lease-tool typescript-build php-vendor-check php-models python-venv-check cargo-downloads-check orm-install-php-extension-tools
	@set +e; status=0; \
	$(GO_TEST) ./packages/go/orm -run '^TestAcquireSQLiteRowLock' -count=1 || status=1; \
	$(RUN_TESTS) node --conditions=orm-test --test packages/ts/tests/sqlite-row-lock-restore.mjs || status=1; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SqliteRowLockRestoreTest.php || status=1; \
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_sqlite_row_lock_restore || status=1; \
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib db::sqlite_row_lock_restore_tests || status=1; \
	run_dir="$(abspath .runtime/run)/nowait-restore-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	if $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; then \
		env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SqliteRowLockRestoreTest.php || status=1; \
	else status=1; fi; \
	exit "$$status"
client-unit-check/runtime-model: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RuntimeModelTest.php
client-unit-check/orm-gen: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenTest.php

php-gen-unit-check: php-vendor-check lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php-gen/tests/OrmGenCliTest.php packages/php-gen/tests/OrmGenScanTest.php packages/php-gen/tests/OrmGenScanParityTest.php

# generator-consumer-check runs the consumer tests of each generator as a part of its own, so a failed part does not stop the others.
.PHONY: generator-consumer-check/go generator-consumer-check/php generator-consumer-check/php-extension generator-consumer-check/typescript generator-consumer-check/python generator-consumer-check/rust-field-types generator-consumer-check/rust-emission generator-consumer-check/rust-chain-scan generator-consumer-check/rust-integration
generator-consumer-check: generator-consumer-check/go generator-consumer-check/php generator-consumer-check/php-extension generator-consumer-check/typescript generator-consumer-check/python generator-consumer-check/rust-field-types generator-consumer-check/rust-emission generator-consumer-check/rust-chain-scan generator-consumer-check/rust-integration
generator-consumer-check/go:
	cd packages/go && $(NODE) $(abspath tests/go-test.mts) -v -timeout 0 ./generator -run '^(TestGoGeneratedScalarGetterRejectsUnselectedRead|TestGoGeneratedScalarGetterCompilesAtItsDeclaredType|TestScanGeneratesUsedMethods)$$' -count=1
generator-consumer-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenTest.php --filter testGeneratedTypedGetterUsesPrivateModelStorageAndRejectsUnselectedRead
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php-gen/tests/OrmGenScanTest.php packages/php/tests/ModelMethodsTest.php --filter 'testTheReceiverIsResolvedFromTheSource|testADeclaredMethodBuildsTheQueryOfItsChain'
generator-consumer-check/php-extension: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/generator-consumer-check-$$$$"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelNativeTest.php packages/php-ext/tests/ModelDslNativeTest.php --filter 'testPhpGeneratedTypedGetterUsesInternalModelStorage|testDynamicConditionsAndBuilderCallsReturnTheNativeModel'
generator-consumer-check/typescript:
	$(NODE) --test packages/ts/tests/generate.mjs
	$(NODE) --test --test-name-pattern='generate-scan/model_calls' packages/ts/tests/generate-scan.mjs
generator-consumer-check/python: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_orm_gen.OrmGenTest.test_generated_typed_getter_is_the_public_column_api
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_orm_gen.OrmGenTest.test_chain_conditions packages.python.tests.test_orm_gen.OrmGenTest.test_scan_reports_unknown_model_methods packages.python.tests.test_query_methods.QueryMethodsTest.test_a_declared_method_builds_the_query_of_its_chain
generator-consumer-check/rust-field-types: cargo-downloads-check lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust-field-types -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm-build --lib generate::field_type_tests::generated_field_types_follow_the_runtime_model -- --test-threads=1 --exact
generator-consumer-check/rust-emission: cargo-downloads-check lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust-emission -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm-build --test generate generated_rows_reject_unselected_fields_and_separate_group_results -- --test-threads=1 --exact
generator-consumer-check/rust-chain-scan: cargo-downloads-check lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust-chain-scan -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm-build --test generate generates_called_methods -- --test-threads=1 --exact
generator-consumer-check/rust-integration: cargo-downloads-check lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm-tests --bin integration generated_typed_getter_is_a_checked_public_consumer_api -- --test-threads=1 --exact

rust-compiler-fixtures-check: cargo-downloads-check lease-tool
	cd packages/rust && $(CARGO_TEST) rust-compiler-fixtures-native -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm --test compiler_fixtures -- --test-threads=1
	$(RUN_LONG) rust-build/compiler-fixtures -- $(CARGO_LEASED) $(NODE) $(abspath scripts/rust/compiler-fixtures.mts) $(PHYSICAL_RUST_TOOLCHAIN) --exclude-case dsl124-db-begin-e0599 --exclude-case dsl124-db-commit-e0599 --exclude-case dsl124-db-rollback-e0599 --exclude-case dsl50-ordering-list-e0277

# Native no-database cases bind driver errors, cells and the Markdown wire handshake to each runtime's native call path.
.PHONY: native-error-cause-check
.PHONY: native-error-cause-check/go native-error-cause-check/typescript-driver native-error-cause-check/typescript-markdown native-error-cause-check/python-driver native-error-cause-check/python-markdown native-error-cause-check/php native-error-cause-check/rust-markdown
native-error-cause-check: php-models native-error-cause-check/php-extension native-error-cause-check/rust native-error-cause-check/go native-error-cause-check/typescript-driver native-error-cause-check/typescript-markdown native-error-cause-check/python-driver native-error-cause-check/python-markdown native-error-cause-check/php native-error-cause-check/rust-markdown
native-error-cause-check/go:
	$(GO_TEST) -v -timeout 0 ./packages/go/orm -run '^(TestMapDriverErrorPreservesNativeCause|TestCellScanCopiesLosslessNativeBytes|TestMarkdownConnectRefused)$$' -count=1
native-error-cause-check/typescript-driver:
	$(NODE) --test packages/ts/tests/driver-error-lock-wait.mjs packages/ts/tests/driver-cell-bytes.mjs
native-error-cause-check/typescript-markdown:
	$(NODE) packages/ts/tests/markdown.mjs
native-error-cause-check/python-driver:
	packages/python/.venv/bin/python -m unittest -v packages.python.tests.test_driver_errors.ServerDriverErrorTest packages.python.tests.test_driver_cells
native-error-cause-check/python-markdown:
	packages/python/.venv/bin/python -m unittest -v packages.python.tests.test_markdown.MarkdownTest.test_markdown_connect_refused
native-error-cause-check/php:
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmExceptionLockWaitTest.php packages/php/tests/MarkdownTest.php packages/php/tests/NativeCellReadTest.php
native-error-cause-check/rust-markdown:
	cd packages/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) native-error-cause-markdown-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --test markdown --features test-faults markdown_connect_refused -- --nocapture
.PHONY: native-error-cause-check/rust
native-error-cause-check/rust:
	cd packages/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) native-error-cause-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib --features test-faults native -- --nocapture
.PHONY: native-error-cause-check/php-extension
native-error-cause-check/php-extension: php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/native-error-cause-check-php-ext-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'DriverErrorTest|testNativeRowAssemblyPreservesBinaryDriverCellBytes|testNativeMarkdownConnectionRefusesConnectError' packages/php-ext/tests/DriverErrorTest.php packages/php-ext/tests/ModelStreamReadTest.php packages/php-ext/tests/OrmExceptionNativeTest.php
client-unit-check/model-methods: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php
client-unit-check/client-generics: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ClientGenericsTest.php

.PHONY: dbspec-php-interface-program-helper-check
dbspec-php-interface-program-helper-check: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRunnerTest.php --filter testCompareRunnerUsesOneSharedOutputSequence
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanTest.php --filter testComparisonHarnessParsesPlanVectorsAndWritesDiagnostics

# Runs the shared PHP source scanner failure case with the PHP extension loaded.
.PHONY: php-orm-gen-scan-failure-case-check
php-orm-gen-scan-failure-case-check: php-vendor-check php-model-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/php-orm-gen-scan-failure-case-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php-gen/tests/OrmGenScanTest.php --filter testAFileThatDoesNotParseStopsTheGenerationAndNamesItsPosition; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/OrmGenScanNativeTest.php --filter testAFileThatDoesNotParseStopsTheGenerationAndNamesItsPosition
.PHONY: phpstan-test-runner-helper-check
phpstan-test-runner-helper-check: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ClientGenericsTest.php --filter testPhpstanTypesTheTransactionResultAndTheRowsOfAModel
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php --filter testPhpstanFindsEveryQueryMethodOfAGeneratedModel
.PHONY: audit-native-method-assertions-helper-check
audit-native-method-assertions-helper-check: php-vendor-check php-model-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/audit-native-method-assertions-helper-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageAuditTriggersExtensionTest.php packages/php-ext/tests/CoverageAuditColumnsExtensionTest.php --filter test_native_methods_are_internal

client-unit-check/perf-extensions: php-vendor-check
	env ORM_PHP_MODE=library ORM_PERF_REFUSED_LOADED= $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/PerfExtensionsTest.php

# php-min-check runs the PHP client unit tests on the lowest PHP release that
# packages/php/composer.json supports.
php-min-check:
	PHP="$$(node scripts/php/php-min.mts)" && "$$PHP" --version && $(MAKE) --no-print-directory client-unit-check PHP="$$PHP"

# php-without-mysql-check runs the PHP client on SQLite, on a PHP without the MySQL drivers (mysqlnd, pdo_mysql, mysqli) loaded,
# naming only the extensions the client uses with `php -n` (N17). The check is one of the declared Linux runner (.github/runner), where the driver is a
# shared module, and fails for that reason on a PHP with the driver compiled in (macOS
# Homebrew). feature-check in make orm-check, when not on Linux, does not run this check
# and prints that it runs on the Linux runner.
php-without-mysql-check:
	$(RUN_LONG) php-without-mysql -- node scripts/php-without-mysql.mts

client-db-check: lease-tool python-venv-check php-vendor-check php-models
	$(HOLD_TYPESCRIPT)
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_statement_fault_entry
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_CLIENT_DB_LANES=parallel node scripts/client-db-test.mts

# Runs only the three-dialect AES rotation case with the PHP extension loaded and the PHP library excluded.
aes-rotation-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/aes-rotation-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php/phpunit.xml.dist --filter testAesRotation packages/php/tests/ModelTest.php

# complex-query-rust-check runs the shared CPX-2 fixture against its preseeded MySQL, PostgreSQL, and SQLite owner databases.
.PHONY: complex-query-rust-check/mysql complex-query-rust-check/postgres complex-query-rust-check/sqlite
complex-query-rust-check: lease-tool complex-query-rust-check/mysql complex-query-rust-check/postgres complex-query-rust-check/sqlite
complex-query-rust-check/mysql:
	$(WITH_TEST_ENV) cd packages/rust && ORM_FEATURE_DATABASE=mysql ORM_FEATURE_DSN="$$COMPLEX_QUERY_RUST_MYSQL_DSN" $(CARGO_TEST) complex-query-rust-mysql -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test integration -- --test-threads=1 --exact coverage_complex_query::coverage_complex_query_product_search
complex-query-rust-check/postgres:
	$(WITH_TEST_ENV) cd packages/rust && ORM_FEATURE_DATABASE=postgres ORM_FEATURE_DSN="$$COMPLEX_QUERY_RUST_POSTGRES_DSN" $(CARGO_TEST) complex-query-rust-postgres -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test integration -- --test-threads=1 --exact coverage_complex_query::coverage_complex_query_product_search
complex-query-rust-check/sqlite:
	$(WITH_TEST_ENV) cd packages/rust && ORM_FEATURE_DATABASE=sqlite ORM_FEATURE_DSN="$$COMPLEX_QUERY_RUST_SQLITE_DSN" $(CARGO_TEST) complex-query-rust-sqlite -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test integration -- --test-threads=1 --exact coverage_complex_query::coverage_complex_query_product_search

# python-install-changed-database-check runs every case of contracts/fixtures/install/changed_database.json with the
# Python client on SQLite, MySQL and PostgreSQL (packages/python/tests/install_changed_database.py).
.PHONY: python-install-changed-database-check
python-install-changed-database-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.install_changed_database
# python-statement-events-check runs every case of tests/events/vectors.json with the Python client on SQLite, MySQL and
# PostgreSQL (packages/python/tests/statement_events.py).
.PHONY: python-statement-events-check
python-statement-events-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.statement_events
# python-mysql-session-check reads the session sql_mode of a Python MySQL connection and compares it with
# tests/dsn/mysql-session.json (packages/python/tests/mysql_session.py); it needs the database variables of make
# orm-test-servers (WITH_TEST_ENV).
.PHONY: python-mysql-session-check
python-mysql-session-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.mysql_session
# python-statement-fault-check runs the Python statement fault cases on SQLite, MySQL and PostgreSQL; it
# needs the database variables of make orm-test-servers (WITH_TEST_ENV).
.PHONY: python-statement-fault-check
python-statement-fault-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.statement_fault
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_statement_fault_entry

# python-clock-check runs the Python clock cases of the update time, the soft deletion and the now condition on SQLite,
# MySQL and PostgreSQL (packages/python/tests/clock.py); it needs the database variables of make orm-test-servers
# (WITH_TEST_ENV).
.PHONY: python-clock-check
python-clock-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.clock

# replica-check runs the primary and replica cases (CFG-21, CFG-22, CFG-23, CFG-24, CFG-25) of every client: a connection to the primary
# and one to its replica on MySQL and PostgreSQL, and a SQLite file opened read-only. It needs the primary and replica
# servers of make orm-test-servers (WITH_TEST_ENV).
.PHONY: replica-check
replica-check: RUN_DIR = $(abspath .runtime/run)/replica-check-$$PPID
replica-check: php-vendor-check php-models python-venv-check lease-tool
	$(WITH_TEST_ENV) $(NODE) tests/go-test.mts -v -timeout 0 ./packages/go/model -run '^Test(PrimaryAndReplica|ReadOnlySQLite)$$' -count=1
	$(WITH_TEST_ENV) $(NODE) packages/ts/tests/replica.mjs
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.replica
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter 'testPrimaryAndReplica|testReadOnly' packages/php/tests/ModelTest.php
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) --filter 'testPrimaryAndReplica|testReadOnly' packages/php/tests/ModelTest.php; status=$$?; rm -rf $(RUN_DIR); exit $$status
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) replica-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --test replica -- --test-threads=1

# session-state-check runs the case of every client that the session state of a transaction ends with the transaction
# (docs/spec/config.md CFG-30) on SQLite, MySQL and PostgreSQL; it needs the database variables of make orm-test-servers
# (WITH_TEST_ENV).
.PHONY: session-state-check
session-state-check: RUN_DIR = $(abspath .runtime/run)/session-state-check-$$PPID
session-state-check: php-vendor-check php-models python-venv-check lease-tool
	$(WITH_TEST_ENV) $(NODE) tests/go-test.mts -v -timeout 0 ./packages/go/orm -run '^TestCancelledTransactionClearsSessionState$$' -count=1
	$(WITH_TEST_ENV) $(NODE) packages/ts/tests/session_state.mjs
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.session_state
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SessionStateTest.php
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/SessionStateTest.php; status=$$?; rm -rf $(RUN_DIR); exit $$status
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) session-state-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --test session_state -- --test-threads=1

# python-rollback-check runs the Python cases of a transaction or savepoint whose callback and rollback both fail on
# SQLite, MySQL and PostgreSQL (packages/python/tests/rollback.py); it needs the database variables of make
# orm-test-servers (WITH_TEST_ENV).
.PHONY: python-rollback-check
python-rollback-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.rollback

# python-identity-load-check runs the shared identity load cases (contracts/fixtures/identity_load.json)
# with the Python client on SQLite, MySQL and PostgreSQL; it needs the database variables of make
# orm-test-servers (WITH_TEST_ENV).
.PHONY: python-identity-load-check
python-identity-load-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.identity_load

# python-schema-inspection-check runs schema().empty(), exists and installed, the table privileges and stats
# of the Python client on SQLite, MySQL and PostgreSQL case databases; it needs the database variables of make
# orm-test-servers (WITH_TEST_ENV).
.PHONY: python-schema-inspection-check
python-schema-inspection-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.schema_inspection

# dialect-facts-check runs the schema dialect probes of packages/go/internal/dialects against
# the MySQL and PostgreSQL servers of TEST_ENV and a SQLite file per probe,
# and records which SQLite openers keep a DSN query in the file name.
dialect-facts-check: dialect-facts-check/probes dialect-facts-check/facts
dialect-facts-check/probes:
	$(GO_TEST) ./packages/go/internal/dialects -run '^(TestProbeIDs|TestProbeCitations)$$' -count=1
dialect-facts-check/facts:
	$(WITH_TEST_ENV) $(GO_TEST) -tags physical ./packages/go/internal/dialects -run '^(TestDialectFacts|TestSQLiteFileNameWithQuery)$$' -count=1

conformance-counter-check:
	$(WITH_TEST_ENV) node --test tests/conformance/check/counters.physical.test.mts

# conformance-result-check builds the TypeScript client and runs the PHP, TypeScript, and Go conformance result
# tests. Each runner reports its cases with their deadlines.
conformance-result-check: conformance-result-check/php conformance-result-check/typescript conformance-result-check/go conformance-result-check/python
.PHONY: conformance-result-check/php conformance-result-check/typescript conformance-result-check/go conformance-result-check/python
conformance-result-check/php: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceResultTest.php
conformance-result-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
	$(NODE) --test packages/ts/tests/result_typescript.test.mts
conformance-result-check/go:
	$(GO_TEST) ./packages/go/internal/conformance -count=1
conformance-result-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.conformance_result

conformance-result-physical-check: RUN_DIR = $(abspath .runtime/run)/conformance-result-physical-check-$$PPID
conformance-result-physical-check: lease-tool conformance-python-models
	$(HOLD_TYPESCRIPT)
	rm -rf $(RUN_DIR)
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_PYTHON_MODELS=$(CONFORMANCE_PY_MODELS) POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) node --test tests/conformance/check/result.physical.test.mts

conformance-rust-group-check: lease-tool
	$(WITH_TEST_ENV) node --test tests/conformance/check/rust-group.physical.test.mts

group-rows-physical-check: php-vendor-check
	$(WITH_TEST_ENV) node scripts/group-rows-physical-check.mts

# group-rows-db-python runs tests/test_group_rows_db.py on the bench database of BENCH_SQLITE_DSN (make run-databases sets it).
.PHONY: group-rows-db-python group-rows-db-typescript
group-rows-db-python:
	cd packages/python && $(PYTHON_VENV)/bin/python -m unittest tests.test_group_rows_db
# group-rows-db-typescript runs packages/ts/tests/group_rows_db.mjs on the bench database of BENCH_SQLITE_DSN; the script throws on a failed check.
group-rows-db-typescript: typescript-build
	$(READ_TYPESCRIPT)
	ORM_GROUP_DATABASE=sqlite ORM_GROUP_DSN="$$BENCH_SQLITE_DSN" $(NODE) packages/ts/tests/group_rows_db.mjs
# Runs the selected model getter/setter styled states in each native client. Each runtime reports independently.
.PHONY: styled-column-states-unit-check
styled-column-states-unit-check: lease-tool php-vendor-check php-model-check python-venv-check cargo-downloads-check
	$(HOLD_TYPESCRIPT)
	@set +e; status=0; last_result=0; \
	run_case() { label=$$1; shift; printf '[styled-column-states] %s\n' "$$label"; "$$@"; last_result=$$?; printf '[styled-column-states] %s exit %s\n' "$$label" "$$last_result"; if [ "$$last_result" -ne 0 ]; then status=1; fi; return 0; }; \
	run_case go $(GO_TEST) ./packages/go/orm -run '^TestStyledColumnStateFixture$$' -count=1; \
	run_case php env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/StyledValueTest.php --filter 'testStyledValue|testModelStates'; \
	run_dir="$(abspath .runtime/run)/styled-column-states-unit-check-$$PPID"; extension="$$run_dir/php-extension/polyspec_orm.so"; \
	trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	run_case php-extension-build $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$extension"; \
	if [ "$$last_result" -eq 0 ]; then run_case php-extension env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$extension" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelNativeTest.php --filter testStyledColumnDistinguishesUnselectedSqlNullAndEncodedNull; fi; \
	run_case typescript-build $(TSC_BUILD); \
	if [ "$$last_result" -eq 0 ]; then run_case typescript $(NODE) --test --test-name-pattern='^(sql_null|json_null|json_object_with_kind|empty_text|serialize_sql_null|serialize_value_null|yaml_sql_null|yaml_value_null|unselected|nonnull_sql_null|jsons_sql_null|jsons_value_null|nonnull_value_null)$$' packages/ts/tests/styled-value.mjs; fi; \
	run_case python $(PYTHON_VENV)/bin/python -m packages.python.tests.test_styled_column_states; \
	run_case rust env PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) styled-column-states-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --manifest-path packages/rust/Cargo.toml --locked --offline -p polyspec-orm --test codec_vectors 'styled_column_state_fixture::' -- --test-threads=1; \
	exit "$$status"

# group-rows-db-go runs TestGroupRowsDatabase (packages/go/model/group_rows_db_test.go) on BENCH_SQLITE_DSN.
group-rows-db-go:
	$(GO_TEST) ./packages/go/model -run '^TestGroupRowsDatabase$$' -count=1
# group-rows-db-php runs GroupRowsDbTest, which reads BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and BENCH_SQLITE_DSN.
group-rows-db-php: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/GroupRowsDbTest.php
# group-rows-db-php-extension runs the extension-owned native group-row case on BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and BENCH_SQLITE_DSN.
group-rows-db-php-extension: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/GroupRowsDbNativeTest.php
# group-rows-db-rust runs coverage_group_rows_db on BENCH_SQLITE_DSN.
group-rows-db-rust:
	$(MAKE) -s feature-rust-database FEATURE_CRATE=packages/rust/tests FEATURE_CARGO_TARGET='--test integration' FEATURE_DATABASE=sqlite FEATURE_DSN_ENV=BENCH_SQLITE_DSN FEATURE_TEST=coverage_group_rows_db::coverage_group_rows_db

# The PHP and native extension owners execute the shared complex product fixture on all three database servers.
complex-query-php-db-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter 'testProductSearch(Page|PublicRequestCompilesAcrossDialects)' packages/php/tests/ComplexQueryDbTest.php
complex-query-php-extension-db-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/complex-query-php-extension-db-check-$$$$"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testProductSearch(PageUsesNativePlannerAndModels|PublicRequestCompilesAcrossDialects)' packages/php-ext/tests/ComplexQueryNativeTest.php

unselected-column-physical-check: php-vendor-check
	$(WITH_TEST_ENV) node scripts/unselected-column-physical-check.mts

# case-database-check runs the model case of four clients on two shared test databases, leaving one table in each,
# and checks that the cases pass without changing the shared database or the PostgreSQL schema, and leave no
# `orm_case_` database or `orm-case-` SQLite file of their own (T25).
case-database-check: php-vendor-check lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/integration --cwd packages/rust -- $(CARGO_COPY) debug/integration -- $(CARGO_SIBLINGS) build --locked -p polyspec-orm-tests --bin integration
	$(WITH_TEST_ENV) CARGO_TARGET_DIR=$(RUN_TARGET) node scripts/case-database-check.mts
	rm -rf $(RUN_DIR)

# conformance-check runs the conformance runners of the four clients on the bench databases of MySQL, PostgreSQL, and SQLite,
# and compares each output with the vector's expected values, and compares the output of that run with the common state contract (the
# sequences of contracts/interfaces.json). The output is written only to this run's RUN_DIR and deleted at the end, so the result depends only on the tree and does not read
# output that an earlier run left. The interfaces checker builds the Rust extractor under the target lease.
# The parts of conformance-check are independent: even if the counter, result, and physical result checks fail, the conformance run still
# executes (make -k).
# PYTHON_MODELS_* is the one declared entry of the Python models that orm-gen generates (P34: generated output is never tracked): the
# document set, the output directory and the source scanned for model calls. python-models writes them, and it is the last step of
# orm-install-python, so every reader of the venv finds them. python-model-check runs orm-gen gen --check against the same entry (no network).
PYTHON_MODELS_SET = contracts/fixtures/bench/dbspec-set.json
PYTHON_MODELS_OUT = packages/python/src/polyspec/orm/models
PYTHON_MODELS_SCAN = packages/python/examples/thin_slice/main.py
.PHONY: python-models
python-models: python-venv-check
	$(PYTHON_VENV)/bin/orm-gen gen --set $(PYTHON_MODELS_SET) --out $(PYTHON_MODELS_OUT) --scan $(PYTHON_MODELS_SCAN)
.PHONY: python-model-check
python-model-check: python-venv-check
	$(PYTHON_VENV)/bin/orm-gen gen --check --set $(PYTHON_MODELS_SET) --out $(PYTHON_MODELS_OUT) --scan $(PYTHON_MODELS_SCAN)

# CONFORMANCE_PY_MODELS is the model directory that the Python conformance runner imports. The venv orm-gen writes it from
# contracts/fixtures/bench/bench.dbs into a temporary directory and renames it into place (an atomic publish of build output).
CONFORMANCE_PY_MODELS = $(abspath .runtime/run)/conformance-python-models
.PHONY: conformance-python-models
conformance-python-models: python-venv-check
	rm -rf $(CONFORMANCE_PY_MODELS).tmp
	$(PYTHON_VENV)/bin/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out $(CONFORMANCE_PY_MODELS).tmp
	rm -rf $(CONFORMANCE_PY_MODELS) && mv $(CONFORMANCE_PY_MODELS).tmp $(CONFORMANCE_PY_MODELS)

conformance-check/%: RUN_DIR = $(abspath .runtime/run)/conformance-check-$$PPID
# VECTOR is a space-separated list of vector names to run; each name is given to the check run as --vector (empty means all vectors).
# If RECORD=1, the diagnostic output (.run-*) of each database whose comparison failed is recorded with check record as that database's expected value,
# for the vectors that VECTOR names or, without VECTOR, for every vector. Each runner commits an empty transaction before subscribing to statement events,
# so connection first-use setup (including SQLite's orm__row_lock table creation) happens before vector recording (tests/conformance/README.md).
# record writes only when all six outputs match, and fails if it cannot record, or if the runner fails and leaves no diagnostic output.
# After recording, the same vector runs again and is compared with the new expected value. The state contracts of contracts/interfaces.json
# are checked for the vectors the run made: with VECTOR, the contracts of the named vectors only.
CONFORMANCE_VECTORS = $(foreach name,$(VECTOR),--vector $(name))
CONFORMANCE_RUN = node tests/conformance/check/main.mts run --out $(RUN_DIR)/out $(CONFORMANCE_VECTORS) --driver mysql --dsn "$$BENCH_MYSQL_DSN" --driver postgres --dsn "$$BENCH_POSTGRES_DSN" --driver sqlite --dsn "$$BENCH_SQLITE_DSN"
.PHONY: conformance-check/run
# With RECORD set, the run records the new vectors before the result checks, which then check the recorded dialect files.
ifneq ($(RECORD),)
conformance-check: conformance-counter-check conformance-check/run conformance-result-check conformance-result-physical-check conformance-check/python
else
conformance-check: conformance-counter-check conformance-result-check conformance-result-physical-check conformance-check/run conformance-check/python
endif
# conformance-check/python runs the vectors of each database as the Python unittest cases of the language-parity check
# (config/parity.json, conformance-mysql, conformance-postgres, conformance-sqlite): one case for each vector, named by the
# vector name, on the bench database of the run (BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN, BENCH_SQLITE_DSN).
.PHONY: conformance-check/python
conformance-check/python: lease-tool python-venv-check conformance-python-models
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.testcase packages.python.tests.conformance_mysql packages.python.tests.conformance_postgres packages.python.tests.conformance_sqlite
conformance-check/run: lease-tool conformance-python-models
	$(HOLD_TYPESCRIPT)
	rm -rf $(RUN_DIR)
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) export ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_PYTHON_MODELS=$(CONFORMANCE_PY_MODELS) POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) && if $(CONFORMANCE_RUN); then :; \
	elif [ -n "$(RECORD)" ]; then \
	  recorded=0; \
	  for db in mysql postgres sqlite; do \
	    dir=$(RUN_DIR)/out; [ $$db = mysql ] || dir=$$dir/$$db; \
	    for pending in $$dir/.run-*; do \
	      [ -d "$$pending" ] || continue; \
	      $(NODE) tests/conformance/check/main.mts record --driver $$db $(CONFORMANCE_VECTORS) $$pending/go.json $$pending/php.json $$pending/php-extension.json $$pending/rust.json $$pending/typescript.json $$pending/python.json || exit 1; \
	      recorded=1; \
	    done; \
	  done; \
	  [ $$recorded = 1 ] || { echo "conformance-check: the run failed before any comparison, so RECORD=1 has nothing to record" >&2; exit 1; }; \
	  rm -rf $(RUN_DIR)/out && $(CONFORMANCE_RUN); \
	else exit 1; fi
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(NODE) tests/interfaces/check/main.mts --results $(RUN_DIR)/out --results $(RUN_DIR)/out/postgres --results $(RUN_DIR)/out/sqlite $(CONFORMANCE_VECTORS)
	rm -rf $(RUN_DIR)

# markdown-conformance-check runs the cases of tests/markdown/cases.json for each client against the flowmark server of FLOWMARK
# (tests/markdown/README.md). FLOWMARK is the build that tests/markdown/flowmark.version pins, and make
# orm-install-flowmark installs it here. The test fails unless the version matches what the build information pins, so a flowmark checkout
# built at the pinned revision can be given as FLOWMARK=<that path>.
FLOWMARK ?= $(abspath .runtime/bin/flowmark)
FLOWMARK_REVISION = $(shell sed 's/.*-//' tests/markdown/flowmark.version)
# FLOWMARK_SOURCE is the flowmark source checkout at that revision that markdown-table-check reads; orm-install-flowmark downloads
# it with the other tools into var/tools, since a check reads it and never writes it.
FLOWMARK_SOURCE ?= $(abspath var/tools/flowmark-source/$(FLOWMARK_REVISION))
.PHONY: markdown-conformance-check markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/php-extension markdown-conformance-check/python markdown-conformance-check/rust markdown-conformance-check/typescript orm-install-flowmark
# parity-prepare builds what the bindings of config/parity.json load before kit's parity-check runs them, into the
# directory of this make run: the PHP extension that the php-extension implementation loads
# (ORM_PARITY_PHP_EXTENSION) and the conformance runner that the Rust conformance bindings start
# (ORM_PROGRAM_CONFORMANCE, polyspec_orm_testcase::program). parity-check also passes FLOWMARK to the
# markdown-conformance bindings. The database bindings read the test servers and the bench databases from the
# environment of the run.
# PARITY_RUN_DIR is the run directory of the parity-check step, which the check runner owns (scripts/check/step.mts) and
# removes when the step ends, pass or fail. parity-prepare refuses to run outside that step.
PARITY_RUN_DIR = $(STEP_RUN_DIR)
.PHONY: parity-prepare
parity-prepare: lease-tool
	test -n "$(STEP_RUN_DIR)" || { echo "parity-prepare: STEP_RUN_DIR is unset; run the parity-check through make run-databases TARGETS=parity-check, whose step owns the directory"; exit 1; }
	mkdir -p $(PARITY_RUN_DIR)
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PARITY_RUN_DIR)/polyspec_orm.so
	$(RUN_LONG) rust-build/parity-conformance --cwd packages/rust -- $(CARGO_LEASED) node $(abspath scripts/cargo-build-copy.mts) $(PARITY_RUN_DIR)/target debug/conformance -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm-tests --bin conformance
parity-check: parity-prepare
# interface-check runs first: it reads the API units of config/parity.json and the symbol snapshots that parity-check reads.
# The bench DSNs of a run are in its TEST_ENV file (run-databases writes them). Export them into make itself, so the parity
# units, which kit starts from make, inherit them. A TEST_ENV without them exports nothing and the guard names what is missing.
BENCH_DSN_NAMES := BENCH_MYSQL_DSN BENCH_POSTGRES_DSN BENCH_SQLITE_DSN ORM_BENCH_MYSQL_DSN
ifneq ($(wildcard $(abspath $(TEST_ENV))),)
$(foreach v,$(BENCH_DSN_NAMES),$(eval export $(v) := $(shell . $(abspath $(TEST_ENV)) >/dev/null 2>&1 && printf "%s" "$$$(v)")))
endif
# The decimal DSNs of a run are in its DECIMAL_ENV file (run-databases writes them), read by the python decimal unit.
DECIMAL_DSN_NAMES := DECIMAL_MYSQL_DSN DECIMAL_POSTGRES_DSN DECIMAL_SQLITE_DSN
ifneq ($(DECIMAL_ENV),)
ifneq ($(wildcard $(abspath $(DECIMAL_ENV))),)
$(foreach v,$(DECIMAL_DSN_NAMES),$(eval export $(v) := $(shell . $(abspath $(DECIMAL_ENV)) >/dev/null 2>&1 && printf "%s" "$$$(v)")))
endif
endif

# parity-bench-env-check names each bench DSN a parity-check run needs that the environment does not set, so a run without the
# bench databases stops at the missing variable instead of failing every unit with the same message. run-databases sets them.
parity-bench-env-check:
	@set -a; test -f $(abspath $(TEST_ENV)) && . $(abspath $(TEST_ENV)); set +a; for v in BENCH_MYSQL_DSN BENCH_POSTGRES_DSN BENCH_SQLITE_DSN; do test -n "$$(printenv $$v)" || { echo "parity-bench-env-check: $$v is not set; run make run-databases TARGETS=parity-check, which creates the bench databases and their DSNs"; exit 1; }; done

# flowmark-check names the flowmark binary that the markdown conformance units read (FLOWMARK) before parity-check runs them;
# orm-install-flowmark builds it from the version pinned in tests/markdown/flowmark.version.
flowmark-check:
	test -x $(FLOWMARK) || { echo "flowmark-check: $(FLOWMARK) is missing; run make orm-install-flowmark, which builds the version pinned in tests/markdown/flowmark.version"; exit 1; }

parity-check: parity-bench-env-check flowmark-check interface-check
parity-check: export FLOWMARK := $(FLOWMARK)
parity-check: export ORM_PARITY_PHP_EXTENSION = $(PARITY_RUN_DIR)/polyspec_orm.so
parity-check: export POLYSPEC_ORM_EXTENSION = $(PARITY_RUN_DIR)/polyspec_orm.so
parity-check: export ORM_SEND_SQLITE_DSN = $(SEND_SQLITE_DSN)
# ORM_SEND_SQLITE_DSN names a file in the run directory of this step: parity-prepare creates it, while the RUN_DIR of
# parity-check (which SEND_SQLITE_DSN names) is never created, so sqlite could not open the file.
parity-check: export ORM_SEND_SQLITE_DSN = sqlite://$(PARITY_RUN_DIR)/send-savepoint.sqlite
# ORM_CHECKOUT is the checkout root: a binding command names it with ${ORM_CHECKOUT}, since kit forbids .. in a command word.
parity-check: export ORM_CHECKOUT = $(CURDIR)
parity-check: export ORM_PROGRAM_CONFORMANCE = $(PARITY_RUN_DIR)/target/debug/conformance
markdown-conformance-check: markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/php-extension markdown-conformance-check/python markdown-conformance-check/rust markdown-conformance-check/typescript
markdown-conformance-check/go:
	FLOWMARK=$(FLOWMARK) $(GO_TEST) -tags markdown ./packages/go/markdownmodel -run '^TestMarkdownConformance$$' -count=1
markdown-conformance-check/php: php-vendor-check
	FLOWMARK=$(FLOWMARK) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --stop-on-defect packages/php/tests/MarkdownConformanceTest.php
markdown-conformance-check/php-extension: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/markdown-conformance-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; FLOWMARK=$(FLOWMARK) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --stop-on-defect packages/php-ext/tests/MarkdownConformanceNativeTest.php
# The Python runner reads the build information with go version -m.
markdown-conformance-check/python: python-venv-check
	FLOWMARK=$(FLOWMARK) $(PYTHON_VENV)/bin/python -m packages.python.tests.markdown_conformance
markdown-conformance-check/rust: lease-tool cargo-downloads-check
	cd packages/rust && FLOWMARK=$(FLOWMARK) PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) markdown-conformance-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test markdown_conformance -- --nocapture
markdown-conformance-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	FLOWMARK=$(FLOWMARK) $(NODE) --conditions=orm-test packages/ts/tests/markdown_conformance.mjs

decimal-bench-sqlite: typescript-build
	$(READ_TYPESCRIPT)
	$(NODE) scripts/decimal-bench-sqlite.mts

# The cases of decimal-physical-check have a deadline per owner process (TIMEOUT_MS of scripts/physical.mts). The build that the process
# uses (the Rust test binary decimal_physical and the Go decimalmodel test) is a long-running
# task, so it runs first under RUN_LONG with no deadline before the case (the Go build publishes into .runtime/bin and fills the build cache), and the case
# Run what was built.
decimal-physical-check: php-vendor-check cargo-downloads-check lease-tool python-venv-check orm-install-php-extension-tools
	$(READ_TYPESCRIPT)
	test -n "$(DECIMAL_ENV)" -a -f "$(DECIMAL_ENV)" || { echo 'DECIMAL_ENV names no decimal database of this run; run make run-databases TARGETS=$@' >&2; exit 1; }
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/decimal-physical -- $(CARGO_LEASED) cargo test --no-run --offline --locked --manifest-path packages/rust/Cargo.toml -p polyspec-orm-tests --test decimal_physical
	$(RUN_LONG) go-build/decimal-physical -- $(PUBLISH) $(abspath .runtime/bin/decimalmodel.test) go test -c -o @OUT@ -tags decimalphysical ./packages/go/decimalmodel
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	. $(DECIMAL_ENV) && ORM_PYTHON=$(PYTHON_VENV)/bin/python POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) $(NODE) scripts/decimal-physical-check.mts

# interface-check runs the tests of the interface checker (tests/interfaces/check) and the checker itself with --self-test. The checker expands the entity
# unit rules into the dbspec entity order that the TypeScript client build (packages/ts/dist) reads.
.PHONY: interface-check/tests interface-check/self-test interface-api-binding-unit-check interface-typescript-extractor-check native-api-equivalence-check
interface-check: interface-check/tests interface-check/self-test
interface-check/tests: php-vendor-check
	$(NODE) --test tests/interfaces/check/*.test.mts
interface-api-binding-unit-check:
	$(NODE) --test tests/interfaces/check/api.test.mts
interface-typescript-extractor-check: interface-typescript-check lease-tool
	$(READ_TYPESCRIPT)
	$(RUN_LONG) interface-typescript-extractor -- $(NODE) packages/ts/testing/interfaces/typescript/node_modules/typescript/bin/tsc --project packages/ts/testing/interfaces/tsconfig.json --noEmit
	$(NODE) --test tests/interfaces/check/typescript-extractor.test.mts
# interface-typescript-check names the missing TypeScript checker dependency before the self-test runs it, so a fresh
# checkout fails with the install step instead of a module resolution error.
interface-typescript-check:
	test -f packages/ts/testing/interfaces/typescript/node_modules/typescript/lib/typescript.js || { echo "interface-typescript-check: packages/ts/testing/interfaces/typescript/node_modules/typescript is missing; run make orm-install-interfaces-typescript"; exit 1; }

interface-check/self-test: php-vendor-check lease-tool typescript-build interface-typescript-check
	$(READ_TYPESCRIPT)
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(NODE) tests/interfaces/check/main.mts --self-test

# go-model-check fails when the Go models that orm-install-go wrote differ from what the entries of GO_MODELS_FILE generate (orm-gen gen --check).
go-model-check:
	$(RUN_LONG) go-model -- sh -c 'cd packages/go && while IFS= read -r entry; do case "$$entry" in ""|"#"*) continue ;; esac; $(GO) run ./cmd/orm-gen gen --check --lang go $$entry || exit 1; done < $(CURDIR)/$(GO_MODELS_FILE)'

# ts-model-check builds the TypeScript client, then fails when the models
# script scans a source that does not call models or misses one that does,
# or when the committed src/models/models.ts differs from its output.
ts-model-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/models-scan.mjs

perf-check:
	$(WITH_TEST_ENV) node scripts/perf-test.mts

# scripts-typecheck checks the repository's TypeScript-based scripts (the .mts files of scripts/ and tests/, tsconfig.json) with tsc.
# Some scripts import the build output of packages/ts and packages/dbspec-language (through docs/.vitepress/dbs.ts), so
# they are checked after that build.
scripts-typecheck: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(RUN_LONG) scripts-typecheck -- node_modules/.bin/tsc -p tsconfig.json

ts-check: ts-check/hold ts-check/types ts-check/test
ts-check/hold: lease-tool
	$(HOLD_TYPESCRIPT)
ts-check/types: ts-check/hold
	$(TSC_BUILD)
	$(RUN_LONG) typescript-check -- npm run typescript:check
ts-check/test: ts-check/hold
	$(WITH_TEST_ENV) npm run typescript:test

# ts-save-key-check builds the TypeScript client and runs only the save key error cases.
ts-save-key-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/save-key-errors.test.mjs

# ts-aes-auth-check builds the TypeScript client and runs only the AES authentication error cases.
ts-aes-auth-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/codec-aes-errors.test.mjs

# ts-codec-errors-check builds the TypeScript client and runs only codec error propagation cases.
ts-codec-errors-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/codec-errors.test.mjs

# sqlite-version-ts-check runs only the TypeScript SQLite native-version unit cases.
sqlite-version-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/sqlite-version.test.mjs

# rust-build-environment-check runs the Rust build library path-resolution unit cases.
.PHONY: rust-build-environment-check
rust-build-environment-check: cargo-downloads-check lease-tool
	ORM_BUILD_TEST_ROOT=$(abspath packages/rust/build) $(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-build --lib tests::build_environment::environment_subprocess

# rust-build-outdir-check runs the missing OUT_DIR propagation unit case.
.PHONY: rust-build-outdir-check
rust-build-outdir-check: cargo-downloads-check lease-tool
	ORM_BUILD_TEST_ROOT=$(abspath packages/rust/build) $(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-build --lib tests::out_dir::load_requires_out_dir

# rust-time-precision-check runs the Rust temporal precision bind cases without a database.
.PHONY: rust-time-precision-check
rust-time-precision-check: cargo-downloads-check lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib db::time_precision_tests

# Compile the public Product request for MySQL/PostgreSQL and reject SQLite without a live database.
complex-query-rust-plan-check: cargo-downloads-check lease-tool
	cd packages/rust && $(CARGO_TEST) complex-query-rust-plan -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test integration -- --test-threads=1 --exact coverage_complex_query::full_product_search_request_compiles_for_mysql_and_postgres_and_rejects_sqlite

# rust-upsert-conflict-check exercises private planner conflict target success and error paths without a database.
.PHONY: rust-upsert-conflict-check
rust-upsert-conflict-check: cargo-downloads-check lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib engine::planner::upsert_conflict_tests

# Column-function metadata checks run for all six native clients and continue after a failure.
.PHONY: column-function-metadata-check column-function-metadata-check/go column-function-metadata-check/rust column-function-metadata-check/typescript column-function-metadata-check/php column-function-metadata-check/python column-function-metadata-check/php-extension
column-function-metadata-check:
	@status=0; \
	$(MAKE) --no-print-directory column-function-metadata-check/go || status=1; \
	$(MAKE) --no-print-directory column-function-metadata-check/rust || status=1; \
	$(MAKE) --no-print-directory column-function-metadata-check/typescript || status=1; \
	$(MAKE) --no-print-directory column-function-metadata-check/php || status=1; \
	$(MAKE) --no-print-directory column-function-metadata-check/python || status=1; \
	$(MAKE) --no-print-directory column-function-metadata-check/php-extension || status=1; \
	exit $$status
column-function-metadata-check/go:
	@status=0; \
	(cd packages/go && $(GO) test ./engine/planner -run '^TestColumnFunctionMissing' -count=1) || status=1; \
	(cd packages/go && $(GO) test ./engine/ir -run '^TestParamUsesColumnFunction' -count=1) || status=1; \
	exit $$status
column-function-metadata-check/rust: cargo-downloads-check lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib column_function_metadata
column-function-metadata-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(RUN_LONG) column-function-metadata-typescript -- $(NODE) --test packages/ts/tests/column_function_metadata.mjs
column-function-metadata-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CoveragePlannerTest.php --filter 'ColumnFunction.*MissingPostValidationFieldIsInternal'
column-function-metadata-check/python: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_column_function_metadata
column-function-metadata-check/php-extension: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(RUN_DIR)"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CoveragePlannerTest.php --filter 'ColumnFunction.*MissingPostValidationFieldIsInternal'; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ColumnFunctionMetadataTest.php
column-function-metadata-check/php-extension: RUN_DIR = $(abspath .runtime/run)/column-function-metadata-check-php-extension-$$PPID

# Scalar subquery result typing fails internally when post-validation metadata lacks the referenced column.
.PHONY: scalar-subquery-column-check scalar-subquery-column-check/go scalar-subquery-column-check/rust scalar-subquery-column-check/typescript scalar-subquery-column-check/php scalar-subquery-column-check/python scalar-subquery-column-check/php-extension
scalar-subquery-column-check:
	@status=0; \
	$(MAKE) --no-print-directory scalar-subquery-column-check/go || status=1; \
	$(MAKE) --no-print-directory scalar-subquery-column-check/rust || status=1; \
	$(MAKE) --no-print-directory scalar-subquery-column-check/typescript || status=1; \
	$(MAKE) --no-print-directory scalar-subquery-column-check/php || status=1; \
	$(MAKE) --no-print-directory scalar-subquery-column-check/python || status=1; \
	$(MAKE) --no-print-directory scalar-subquery-column-check/php-extension || status=1; \
	exit $$status
scalar-subquery-column-check/go:
	cd packages/go && $(GO) test ./engine/planner -run '^TestScalarSubquery' -count=1
scalar-subquery-column-check/rust: cargo-downloads-check lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib scalar_subquery_
scalar-subquery-column-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(RUN_LONG) scalar-subquery-column-typescript -- $(NODE) packages/ts/tests/scalar_subquery_type.mjs
scalar-subquery-column-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CoveragePlannerTest.php --filter ScalarSubquery
scalar-subquery-column-check/python: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_scalar_subquery_type
scalar-subquery-column-check/php-extension: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(RUN_DIR)"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CoveragePlannerTest.php --filter ScalarSubquery
scalar-subquery-column-check/php-extension: RUN_DIR = $(abspath .runtime/run)/scalar-subquery-column-check-php-extension-$$PPID

# relation-parent-bind-rust-check exercises malformed and valid parent bind slot expansion without a database.
relation-parent-bind-rust-check: lease-tool
	cd packages/rust && $(CARGO_TEST) relation-parent-bind-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib driver::tests::parent_expansion -- --test-threads=1 --nocapture

# Exercises the cached root page shape and dialect-specific bind ordering without a database.
paged-read-rust-check: lease-tool
	cd packages/rust && $(CARGO_TEST) paged-read-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib paged_ -- --test-threads=1 --nocapture

# Runs the database-independent page-cache and exact parameter-walk units in all six implementations.
.PHONY: page-cache-unit-check
.PHONY: page-cache-unit-check/go page-cache-unit-check/php page-cache-unit-check/typescript page-cache-unit-check/python page-cache-unit-check/rust
page-cache-unit-check: lease-tool php-vendor-check php-models python-venv-check typescript-build cargo-downloads-check model-types-php-extension-check page-cache-unit-check/go page-cache-unit-check/php page-cache-unit-check/typescript page-cache-unit-check/python page-cache-unit-check/rust
page-cache-unit-check/go:
	$(GO_TEST) ./packages/go/orm -run '^(TestPlanCachePagedReadBindsPageValues|TestCanonicalizeCompositeRequestParameterWalk)$$' -count=1
page-cache-unit-check/php:
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/PlanCacheBoundTest.php
page-cache-unit-check/typescript:
	$(NODE) --test packages/ts/tests/plan-cache-in.mjs
page-cache-unit-check/python:
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_plan_cache_bound
page-cache-unit-check/rust:
	cd packages/rust && $(CARGO_TEST) page-cache-unit-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib paged_ -- --test-threads=1 --nocapture

# The PHP plan cache and statement cache retain at most 65535 placeholders in all (KSTD-7-3-4, limepie P-97).
.PHONY: php-plan-cache-memory-check
php-plan-cache-memory-check: lease-tool php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/PlanCacheMemoryTest.php

# Focused split-merge NULL boundary cases in each native client.
split-null-check: split-null-check/ts split-null-check/php split-null-check/python split-null-check/rust split-null-check/go split-null-check/php-extension

split-null-check/ts: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --conditions=orm-test --test packages/ts/tests/split-null.test.mjs

split-null-check/php: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CollectionIdentityTest.php --filter testSplitRootMergeRejectsSqlNullIdentity

split-null-check/python: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_split_null

split-null-check/rust: cargo-downloads-check
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib model::related_tests::split_root_merge_rejects_sql_null_identity

split-null-check/go: lease-tool
	$(GO_TEST) ./packages/go/orm -run '^TestSplitQueryRowKeyRejectsSQLNull$$' -count=1

split-null-check/php-extension: php-vendor-check orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/split-null-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelAssemblyTest.php --filter testSplitRootMergeRejectsSqlNullIdentity

# A root IN list over the bind limit is split before it is planned (PRT-76): the count of 70300 values on SQLite stays
# within a memory bound in Go, TypeScript and Python, and Rust plans no statement over the bind limit, since no plan
# holds a bind slot per value of the list.
split-read-plan-check: split-read-plan-check/go split-read-plan-check/ts split-read-plan-check/python split-read-plan-check/rust

split-read-plan-check/go: lease-tool
	$(GO_TEST) ./packages/go/orm -run '^TestSplitRootInCountPlansNoStatementOverTheBindLimit$$' -count=1

split-read-plan-check/ts: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/split-plan.test.mjs

split-read-plan-check/python: python-venv-check python-models
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_split_plan

split-read-plan-check/rust: cargo-downloads-check
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib model::split_plan_tests::split_root_in_count_plans_no_statement_over_the_bind_limit

# The six native clients preserve typed composite collection components and the shared opaque encoding.
collection-composite-key-check: typescript-build php-vendor-check python-venv-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/collection-composite-key-check-$$$$"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	status=0; \
	$(RUN_TESTS) node --test --test-name-pattern='collection/get-fetched-value-use-typed-key|collection-key/(identity-from-fixture|composite-typed-components|nullable-composite-row-has-no-key)' packages/ts/tests/collection_identity.mjs || status=1; \
	$(GO_TEST) ./packages/go/orm -run '^(TestCollectionGetAndFetchedValueUseTypedKey|TestCollectionKeyIdentityFromFixture|TestCompositeCollectionKeyTypedComponentsFromFixture|TestCompositeCollectionKeyMicrosecondPrecisionFromFixture|TestNullableCompositeRowHasNoCollectionKey)$$' -count=1 || status=1; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CollectionIdentityTest.php --filter 'testGetAndFetchedValueUseTheTypedKey|testEveryFixtureKeyHasItsOwnStableIdentity|testCompositeComponentsPreserveTypedIdentityAndSharedEncoding|testCompositeDateTimeMicrosecondsTrimTrailingZeroes|testNullCompositeRowHasNoCollectionKey' || status=1; \
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_collection_identity.CollectionIdentityTest.test_get_and_fetched_value_use_the_typed_key packages.python.tests.test_collection_identity.CollectionIdentityTest.test_every_fixture_key_has_its_own_identity packages.python.tests.test_collection_identity.CollectionIdentityTest.test_native_key_values_keep_their_types_and_reject_unsupported_values packages.python.tests.test_collection_identity.CollectionIdentityTest.test_composite_components_preserve_typed_identity_and_shared_encoding packages.python.tests.test_collection_identity.CollectionIdentityTest.test_composite_datetime_microseconds_trim_trailing_zeroes packages.python.tests.test_collection_identity.CollectionIdentityTest.test_a_null_composite_row_has_no_collection_key || status=1; \
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --test collection_identity composite || status=1; \
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --test collection_identity every_fixture_key_has_its_own_identity || status=1; \
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-tests --test collection_get_fetched || status=1; \
	if $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; then \
	  env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelAssemblyTest.php packages/php-ext/tests/CollectionTest.php --filter 'testGetAndFetchedValueUseTheTypedKey|testFixtureKeysKeepTheirNativeTypesAndLookupValue|testCompositeComponentsPreserveTypedIdentityAndSharedEncoding|testCompositeDateTimeMicrosecondsTrimTrailingZeroes|testNullCompositeRowHasNoCollectionKey' || status=1; \
	else status=1; fi; \
	test $$status -eq 0

# sqlite-version-rust-check runs only the Rust SQLite native-version unit cases.
sqlite-version-rust-check: cargo-downloads-check lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib db::sqlite_version_tests

# ts-min-check runs the TypeScript tests on the lowest Node release that
# package.json supports.
ts-min-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) NODE_MIN="$$($(NODE) scripts/typescript/node-min.mts)" && PATH="$$NODE_MIN:$$PATH" && export PATH && "$$NODE_MIN/node" --version && "$$NODE_MIN/npm" run typescript:test

# dbspec-ts-check builds the TypeScript client and runs the shared dbspec vectors, set file vectors, plan vectors, Mermaid
# vectors, apply cleanup errors, the rules they do not yet cover, and the check that the Unicode word table matches its ranges at every code point.
# The stress document is run by make bench.
.PHONY: dbspec-ts-check
dbspec-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/browser-entry.mjs packages/ts/tests/dbspec.mjs packages/ts/tests/dbspec-canonical.mjs packages/ts/tests/dbspec-normalize.mjs packages/ts/tests/dbspec-positions.mjs packages/ts/tests/dbspec-invalid.mjs packages/ts/tests/dbspec-files.mjs packages/ts/tests/dbspec-hashes.mjs packages/ts/tests/dbspec-sets.mjs packages/ts/tests/dbspec-set.mjs packages/ts/tests/dbspec-set-edges.mjs packages/ts/tests/dbspec-set-parse.mjs packages/ts/tests/dbspec-analyze.mjs packages/ts/tests/dbspec-syntax.mjs packages/ts/tests/syntax-vectors.mjs packages/ts/tests/dbspec-rules.mjs packages/ts/tests/dbspec-render.mjs packages/ts/tests/dbspec-render-dialect.mjs packages/ts/tests/dbspec-plan.mjs packages/ts/tests/dbspec-plan-cases.mjs packages/ts/tests/dbspec-plan-invalid.mjs packages/ts/tests/dbspec-plan-chains.mjs packages/ts/tests/dbspec-plan-parse.mjs packages/ts/tests/dbspec-plan-comparisons.mjs packages/ts/tests/dbspec-mermaid-export.mjs packages/ts/tests/dbspec-mermaid-import.mjs packages/ts/tests/dbspec-mermaid-invalid.mjs packages/ts/tests/dbspec-mermaid-round-trip.mjs packages/ts/tests/dbspec-apply-cleanup.mjs packages/ts/tests/dbspec-unicode.mjs packages/ts/tests/dbspec-show-create.mjs

# dbspec-language-check builds the TypeScript client and @polyspec/dbspec-language, and checks that the language service's module graph does not reach
# node modules, Node globals, or drivers, the format and hash of shared vectors, tokens and UTF-16 ranges, and the tests/editor
# fixtures.
# It also runs resolveSet with the node:fs host over the set-files.json vectors and set resolution, and dbspec-fmt over
# its modes, exit codes, stderr lines and the --write and --check of the editor fixtures.
.PHONY: dbspec-language-check
# dbspec-lsp-check builds the language server and runs its stdio sessions over the editor fixtures and file trees.
dbspec-lsp-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(NPM) run --workspace @polyspec/dbspec-lsp build
	$(NODE) --test packages/dbspec-lsp/tests/session.test.mjs

# dbspec-codemirror-check builds the CodeMirror adapter and runs the editor fixtures through an EditorState.
dbspec-codemirror-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(NPM) run --workspace @polyspec/dbspec-codemirror build
	$(NODE) --test packages/dbspec-codemirror/tests/fixtures.test.mjs

# dbspec-vscode-check builds the VS Code extension (the type check and the esbuild bundles of the extension and the
# bundled language server) and checks its manifest and bundles without VS Code.
dbspec-vscode-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(NPM) run --workspace @polyspec/dbspec-lsp build
	$(NPM) run --workspace polyspec-dbspec build
	$(NODE) --test packages/dbspec-vscode/tests/manifest.test.mjs

# orm-install-vscode installs the VS Code of the integration test into var/tools/vscode with kit's VS Code installer, at the
# minimum release that packages/dbspec-vscode declares (engines.vscode); it downloads once and keeps a complete copy.
.PHONY: orm-install-vscode
orm-install-vscode:
	$(ONLINE) $(NODE) $(KIT)/install-vscode.$(KIT_EXT) packages/dbspec-vscode $(CURDIR)/var/tools/vscode

# dbspec-vscode-integration runs the editor fixtures through vscode.provideDocumentSemanticTokens inside the VS Code that
# make orm-install-vscode installed; the run reads that copy and never downloads.
.PHONY: dbspec-vscode-integration
dbspec-vscode-integration: dbspec-vscode-check
	$(NODE) packages/dbspec-vscode/tests/integration/run.mjs --vscode $(CURDIR)/var/tools/vscode

# ci-vscode-integration runs dbspec-vscode-integration on a virtual X server (xvfb-run), since VS Code needs a display; the
# editor job of CI runs it on Linux, and a desktop runs dbspec-vscode-integration itself.
.PHONY: ci-vscode-integration
ci-vscode-integration:
	xvfb-run -a $(MAKE) --no-print-directory dbspec-vscode-integration

dbspec-language-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(NODE) --test packages/dbspec-language/tests/module-graph.test.mjs packages/dbspec-language/tests/editor.test.mjs packages/dbspec-language/tests/vectors.test.mjs packages/dbspec-language/tests/resolve-set.test.mjs packages/dbspec-language/tests/cli.test.mjs

# The prefix of `make orm-install-cli`: the copy of dbspec-fmt in $(CLI_PREFIX)/lib and its script in $(CLI_PREFIX)/bin.
CLI_PREFIX ?= $(HOME)/.local

# orm-install-cli builds the TypeScript client and @polyspec/dbspec-language and installs the command dbspec-fmt under
# CLI_PREFIX without a symbolic link (scripts/install-cli.mts): a copy of both packages and a script that runs node
# with the copied entry. Put $(CLI_PREFIX)/bin on PATH; uninstall-cli removes the copy and the script.
.PHONY: orm-install-cli uninstall-cli
orm-install-cli: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(ONLINE) $(NODE) scripts/install-cli.mts install --prefix $(CLI_PREFIX)

uninstall-cli:
	$(NODE) scripts/install-cli.mts uninstall --prefix $(CLI_PREFIX)

# orm-install-cli-check installs dbspec-fmt into a temporary prefix with scripts/install-cli.mts, runs it and uninstalls it
# (tests/cli/install-cli.test.mts); the install reads the registry.
orm-install-cli-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(ONLINE) $(NODE) --test tests/cli/install-cli.test.mts

# dbspec-go-check runs all tests of the Go dbspec engine package (packages/go/engine/dbspec): the shared vectors of tests/dbspec/cases.json,
# its own rule cases, manifest, statements, plans, comparisons, Mermaid vectors, apply cleanup errors,
# the case harness, and that it rejects, with the position, every missing or wrongly typed field of every vector file. The stress
# document (TestStressDocument, build tag bench) is run by make bench.
.PHONY: dbspec-go-check dbspec-go-check/engine dbspec-go-check/unicode
dbspec-go-check: dbspec-go-check/engine dbspec-go-check/unicode
dbspec-go-check/engine:
	$(RUN_TESTS) go --cwd packages/go -- ./engine/dbspec -count=1
# dbspec-go-check/unicode checks that the three table files written by the generator of tests/dbspec/unicode match the current Go tables, and that the C extension and the Python module
# give the same classification as Go at every code point.
dbspec-go-check/unicode:
	$(RUN_TESTS) go --cwd . -- ./tests/dbspec/unicode -count=1

docs-dev:
	$(NPM) run docs:dev

docs-build:
	$(NPM) run docs:build

# docs-ci runs, as the make orm-check runner, the document checks (docs-verify-idempotent, docs-check) that the docs job of CI (ci.yml) runs
# without a test server (scripts/check/run.mts `-`). It runs the next target even when one fails, and keeps a log and summary for each target
# in .runtime/check/<run id>/report, which the workflow uploads as the job summary and an artifact.
docs-ci:
	$(NODE) scripts/check/run.mts --job-summary - docs-verify-idempotent docs-check docs-site-check

orm-docs-check:
	$(NPM) run docs:check

# docs-check is the kit task of the documents (config/documents.json): the pairs, the stamps and the Markdown checks of the documents.
# It runs no site build, so a land does not pay for docs:build; the site build and the checks that read the built site run in
# docs-site-check (KSTD-5-48).
docs-check: docs-parse-check

# docs-parse-check runs the unit cases of the Markdown tables (scripts/docs/markdown-table.mts and tests/docs/tables.mts), each on a
# fixture that tests/docs/fixture.mts writes into var/.
docs-parse-check:
	$(NODE) --test tests/docs/markdown-table.test.mts tests/docs/tables.test.mts

# docs-site-check runs the VitePress site build (orm-docs-check) and the checks that read the built site (scripts/docs/check.mts). The
# unit cases of that reader (html.test.mts) run first and fail before the build when the reader is wrong. The owner rules
# (config/owner-checks.json) select it for the changed paths under docs/.
docs-site-check: docs-site-parse-check orm-docs-check

docs-site-parse-check:
	$(NODE) --test tests/docs/html.test.mts

docs-verify-idempotent:
	$(NPM) run docs:verify-idempotent

docs-rules-check:
	$(NPM) run docs:rules-check

docs-implementation-count-check:
	$(NODE) --test scripts/docs/rules-filter.test.mts
	$(NPM) run docs:rules-check -- --only docs.implementation-count

# docs-dbs-check runs the unit cases of the dbs fence (docs/.vitepress/dbs.ts) after building the packages it reads, and
# type-checks the site's TypeScript with docs/.vitepress/tsconfig.json, the project that make lint-ts also judges it by.
docs-dbs-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(RUN_LONG) docs-typecheck -- node_modules/.bin/tsc -p docs/.vitepress/tsconfig.json
	$(NODE) --test tests/docs/dbs-fence.test.mts

# markdown-table-check compares the table "Markdown IR executor" of docs/spec/dialects.md and docs/spec/dialects.ko.md with the
# capability table of flowmark's docs/spec/60-dialect.md at the version of tests/markdown/flowmark.version, which it
# downloads as orm-install-flowmark does.
markdown-table-check:
	FLOWMARK_SOURCE=$(FLOWMARK_SOURCE) $(NODE) scripts/docs/markdown-table.mts

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

# codec-check decodes tests/codec/vectors.json with the PHP codec and encodes it, then decodes the output that the Go, Rust,
# TypeScript, and Python codec tests run by this target wrote to this make run's directory (CODEC_OUT, ORM_CODEC_OUT)
# (tests/codec/README.md). It does not read output written by other targets or earlier runs, so that output always comes from the current code of this checkout.
# The four writers are independent parts, so if one fails the others still run (make -k), and the comparison, which reads all four
# outputs, comes after them. The run directory of a failed run is moved into the report by the runner.
CODEC_OUT = $(abspath .runtime/run)/codec-check-$$PPID
.PHONY: codec-check codec-check/go codec-check/rust codec-check/typescript codec-check/python codec-check/compare
codec-check: codec-check/compare
# codec-check/python runs the shared vectors through the Python codec and writes its encodings to ORM_CODEC_OUT for
# codec-check/compare.
codec-check/python: python-venv-check
	mkdir -p $(CODEC_OUT)
	ORM_CODEC_OUT=$(CODEC_OUT) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_vectors
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_aes_vectors
	$(PYTHON_VENV)/bin/python -m packages.python.tests.codec_vector
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
	ORM_CODEC_OUT=$(CODEC_OUT) $(NODE) packages/ts/tests/codec-vector.mjs
codec-check/compare: php-vendor-check codec-check/go codec-check/rust codec-check/typescript codec-check/python
	ORM_CODEC_OUT=$(CODEC_OUT) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecVectorsTest.php
	rm -rf $(CODEC_OUT)

# bind-check runs the shared cases of tests/bind/vectors.json in the five clients (tests/bind/README.md): the bind
# cases check a parameter against the logical type of its slot, and the message cases write it as an IR executor
# message value. Each runner compares its answers with the file, so the clients agree when every runner passes; the
# runners are independent parts, so one that fails leaves the others to run (make -k).
.PHONY: bind-check bind-check/go bind-check/rust bind-check/typescript bind-check/python bind-check/php
bind-check: bind-check/go bind-check/rust bind-check/typescript bind-check/python bind-check/php
bind-check/go:
	$(GO_TEST) ./packages/go/orm -run '^(TestBindVectors|TestBindMessageVectors)$$' -count=1
bind-check/rust: cargo-downloads-check lease-tool
	cd packages/rust && $(CARGO_TEST) bind-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib bind_
bind-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) packages/ts/tests/markdown.mjs
bind-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase packages.python.tests.test_markdown.BindMessageVectors packages.python.tests.test_markdown.BindVectors
bind-check/php: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter 'test_bind_(message_)?vectors' packages/php/tests/MarkdownTest.php

# ir-answers-check runs the read answers of contracts/fixtures/ir_answers.json in the five clients (docs/spec/protocol.md
# section 5, Read): each runner runs the chain of the markdown conformance case that a case names on a listener that
# answers with the case's answer, and compares the result with its expect. No flowmark server runs.
.PHONY: ir-answers-check ir-answers-check/go ir-answers-check/rust ir-answers-check/typescript ir-answers-check/python ir-answers-check/php
ir-answers-check: ir-answers-check/go ir-answers-check/rust ir-answers-check/typescript ir-answers-check/python ir-answers-check/php
ir-answers-check/go:
	$(GO_TEST) -tags markdown ./packages/go/markdownmodel -run '^TestIRAnswers$$' -count=1
ir-answers-check/rust: cargo-downloads-check lease-tool
	cd packages/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) ir-answers-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test markdown_conformance -- ir_answers::
ir-answers-check/typescript: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --conditions=orm-test packages/ts/tests/ir_answers.mjs
ir-answers-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.ir_answers
ir-answers-check/php: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/IrAnswersTest.php

# rust-fmt-check fails when cargo fmt would change a source of the Rust
# workspace (packages/rust/rustfmt.toml).
# rust-fmt-check checks that every Rust workspace of the repository (packages/rust, benchmarks/rust, packages/rust/testing/interfaces) is
# formatted by cargo fmt.
rust-fmt-check: rust-fmt-check/clients rust-fmt-check/bench rust-fmt-check/interfaces
rust-fmt-check/clients:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt --cwd packages/rust -- cargo fmt --all --check
rust-fmt-check/bench:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt/bench --cwd benchmarks/rust -- cargo fmt --all --check
rust-fmt-check/interfaces:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-fmt/interfaces --cwd packages/rust/testing/interfaces -- cargo fmt --all --check

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

# This filter runs only the Rust planner's database-independent assignment-expansion units.
blind-index-source-rust-check: lease-tool
	cd packages/rust && $(CARGO_TEST) blind-index-source-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib blind_index_source

# install downloads what the checks read: the Composer packages, the Rust toolchain and the crates of every Cargo.lock, the
# Go modules, the lowest Node of ts-min-check, and the gen_stub.php and PHP-Parser of the PHP extension. The npm packages
# (the root, the TypeScript client and @polyspec/kit) come first, from make install-tools TOOLS=npm and make
# install-packages, because make reads the kit.mk of the installed package. What is downloaded is not downloaded again,
# and the parts are independent (make -k).

.PHONY: docs-ci
.PHONY: install orm-install-interfaces-typescript orm-install-php orm-install-rust orm-install-rust-toolchain orm-install-rust-crates orm-install-go orm-install-server-programs orm-install-php-extension-tools ci-php-min-version downloads-check
install: orm-install-php orm-install-rust orm-install-go orm-install-php-extension-tools orm-install-python orm-install-flowmark orm-install-interfaces-typescript
# orm-install-interfaces-typescript installs the TypeScript 6.0.3 that packages/ts/testing/interfaces/typescript.mts reads declarations with
# (config/toolchain.json exceptions): TypeScript 7.0 ships no JavaScript API of its compiler.
# install-packages also installs the TypeScript of tests/interfaces from its lock, so a fresh install leaves lint-ts with what it reads.
install-packages: orm-install-interfaces-typescript

orm-install-interfaces-typescript:
	$(ONLINE) $(NPM) ci --prefix packages/ts/testing/interfaces/typescript --no-audit --no-fund
# lint-ts reads packages/ts/testing/interfaces/typescript.mts, which imports the TypeScript that this target installs: the recipe of
# lint-ts is the kit.mk of @polyspec/kit, so the prerequisite is added here.
lint-ts: typescript-build
# The staged commit gate has no ignored generated models; recreate them before linting Go modules.
lint-go: go-models
# orm-install-php installs the one Composer project of the repository, the development root (vendor-php): it installs packages/php
# from its directory with the runtime dependencies of that package, and PHPUnit, which runs the tests of packages/php and
# packages/php-ext. The released manifests of the two packages declare only what a consumer installs.
# PHP_MODELS_FILE declares the entries of the PHP models that orm-gen generates (P34: generated output is never tracked): one orm-gen
# argument line per directory, read by php-models and php-model-check (packages/php/models.txt). php-models writes them, and it is the
# last step of orm-install-php, after Composer has installed the autoloader that bin/orm-gen runs under. php-model-check runs
# orm-gen gen --check against the same entries (no network).
PHP_MODELS_FILE = packages/php/models.txt
.PHONY: php-models php-model-check
orm-install-php:
	$(ONLINE) $(COMPOSER) install --no-interaction --no-progress --prefer-dist
	$(COMPOSER) dump-autoload --no-interaction --quiet
	$(MAKE) --no-print-directory php-models
php-models: php-vendor-check
	while IFS= read -r entry; do case "$$entry" in ""|"#"*) continue ;; esac; vendor-php/bin/orm-gen gen $$entry || exit 1; done < $(CURDIR)/$(PHP_MODELS_FILE)
# php-cancel-helper-build publishes the SQLite loadable callback as an explicit product build; PHP queries only load its platform artifact.
.PHONY: php-cancel-helper-build
php-cancel-helper-build:
	$(RUN_LONG) php-cancel-helper-build -- env POLYSPEC_ORM_PACKAGE_ROOT=$(CURDIR)/packages/php $(PHP) packages/php/bin/orm-sqlite-cancel-build.php
# php-model-check fails when the PHP models that orm-install-php wrote differ from what the entries of PHP_MODELS_FILE generate (orm-gen gen --check).
php-model-check: php-vendor-check
	while IFS= read -r entry; do case "$$entry" in ""|"#"*) continue ;; esac; vendor-php/bin/orm-gen gen --check $$entry || exit 1; done < $(CURDIR)/$(PHP_MODELS_FILE)
# orm-install-rust installs the toolchain of rust-toolchain.toml, then downloads the crates of every Cargo.lock. CI runs the two
# halves apart, orm-install-rust-toolchain before its crate cache is restored and orm-install-rust-crates after it, since a
# restored registry replaces the crates downloaded before it.
orm-install-rust: orm-install-rust-toolchain orm-install-rust-crates
orm-install-rust-toolchain:
	PATH="$(HOME)/.cargo/bin:$(PATH)" rustup toolchain install
	PATH="$(HOME)/.cargo/bin:$(PATH)" rustc --version
orm-install-rust-crates:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path packages/rust/Cargo.toml
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path benchmarks/rust/Cargo.toml
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(ONLINE) cargo fetch --locked --manifest-path packages/rust/testing/interfaces/Cargo.toml
# GO_MODELS_FILE declares the entries of the Go models that orm-gen generates (P34: generated output is never tracked): one orm-gen
# argument line per package, read by go-models and go-model-check (packages/go/models.txt). go-models writes them, and it is the last
# step of orm-install-go, after the modules are downloaded, so every Go check finds them. go-model-check runs orm-gen gen --check
# against the same entries (no network).
GO_MODELS_FILE = packages/go/models.txt
.PHONY: go-models
go-models:
	cd packages/go && while IFS= read -r entry; do case "$$entry" in ''|'#'*) continue ;; esac; $(GO) run ./cmd/orm-gen gen --lang go $$entry || exit 1; done < $(CURDIR)/$(GO_MODELS_FILE)

# The runtime build compiles Go packages that import these generated models.
build-go: go-models

# The runtime build compiles TypeScript packages that import generated models.
build-ts: typescript-build

orm-install-go:
	$(ONLINE) $(GO) mod download
	$(MAKE) --no-print-directory go-models
# orm-install-flowmark installs, in the FLOWMARK directory, the flowmark that markdown-conformance-check runs, at the module
# version that tests/markdown/flowmark.version pins.
orm-install-flowmark:
	$(ONLINE) GOBIN=$(dir $(FLOWMARK)) $(GO) install github.com/polyspec/flowmark/packages/go/cmd/flowmark@$$(cat tests/markdown/flowmark.version)
	$(ONLINE) $(GO) mod download github.com/polyspec/flowmark/packages/go@$$(cat tests/markdown/flowmark.version)
	$(ONLINE) $(RUN_LONG) flowmark-source-install -- $(NODE) scripts/docs/flowmark-source.mts install "$(FLOWMARK_SOURCE)" "$(FLOWMARK_REVISION)"
# orm-install-server-programs installs, on the CI Linux runner, the server programs that make orm-test-servers starts
# (scripts/ci/server-programs.mts).
orm-install-server-programs:
	$(ONLINE) $(NODE) scripts/ci/server-programs.mts
# orm-install-php-extension-tools checks that the phpize and php-config used by the build of the PHP extension polyspec_orm are those of the
# PHP on PATH (scripts/ci/php-extension-tools.mts).
orm-install-php-extension-tools:
	$(NODE) scripts/ci/php-extension-tools.mts

# All setup steps of CI run make targets (make repo-check). ci-php-min-version records the lowest
# PHP release of make php-min-check as the input of setup-php (version=x.y). Each client refuses SQLite below 3.46 when it connects.
ci-php-min-version:
	@echo "version=$$(node scripts/php/php-min.mts --version)"

# downloads-check checks, without network, that all downloads that check reads are present, and lists each missing one with
# `run make install` (scripts/check/downloads.mts). The runner (scripts/check/run.mts) runs the same check as the setup step downloads.
# The crates are checked by cargo-downloads-check of the kit.mk of @polyspec/kit, which every target that runs cargo
# --offline runs first, so a missing crate fails with its fix instead of cargo's "retry without --offline".
downloads-check:
	$(NODE) scripts/check/downloads.mts

# rust-driver-check runs the native and driver_compare of benchmarks/rust without a DSN to confirm refusal,
# and runs each workload once at a time on the seeded bench database to confirm that every workload finishes.
rust-driver-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd benchmarks/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) rust-driver-check -- cargo test --locked --offline -- --test-threads=1

# example-check runs the Go, PHP and Rust programs of examples/complex and the Go, PHP, Rust, TypeScript and Python programs of
# examples/thin-slice on the seeded bench database, and compares their stdout byte for byte as the README diff does. The Python
# program runs on the venv of orm-install-python, so the target requires that venv.
example-check: cargo-downloads-check python-venv-check
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/examples --cwd packages/rust -- $(CARGO_COPY) debug/complex debug/demo -- $(CARGO_SIBLINGS) build --locked --offline -p polyspec-orm-tests --bin complex --bin demo
	$(WITH_TEST_ENV) EXAMPLE_RUST_COMPLEX=$(RUN_TARGET)/debug/complex EXAMPLE_RUST_DEMO=$(RUN_TARGET)/debug/demo $(GO_TEST) -tags examples ./examples -run '^TestExampleOutputsAreIdentical$$' -count=1
	rm -rf $(RUN_DIR)

# timing-check runs the Go, Rust, PHP, and TypeScript tests that time their own computation, with the process group throttled to a part of the CPU,
# and confirms that each test passes unchanged and prints its measurements. Performance is only measured and does not
# fail the test (AGENTS.md). It uses the 2000-table stress document, so make bench runs it.
TIMING_GO_DBSPEC_TEST = $(RUN_DIR)/dbspec.test
timing-check: cargo-downloads-check lease-tool
	$(HOLD_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT)) $(dir $(TIMING_GO_DBSPEC_TEST))
	$(PUBLISH) $(DBSPEC_STRESS_DOCUMENT) node tests/dbspec/stress.mts
	$(RUN_LONG) go-build/dbspec-test -- $(PUBLISH) $(TIMING_GO_DBSPEC_TEST) go test -c -tags bench -o @OUT@ ./packages/go/engine/dbspec
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/dbspec_stress --cwd packages/rust -- $(CARGO_COPY) release/examples/dbspec_stress -- $(CARGO_SIBLINGS) build --release --locked --offline -p polyspec-orm-schema --example dbspec_stress
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/orm-schema-tests --cwd packages/rust -- $(CARGO_LEASED) cargo test --locked --offline -p polyspec-orm-schema --no-run
	$(RUN_LONG) typescript-build -- npm run typescript:build
	PATH="$(HOME)/.cargo/bin:$(PATH)" DBSPEC_STRESS_DOCUMENT=$(abspath $(DBSPEC_STRESS_DOCUMENT)) TIMING_GO_DBSPEC_TEST=$(abspath $(TIMING_GO_DBSPEC_TEST)) TIMING_RUST_STRESS=$(RUN_TARGET)/release/examples/dbspec_stress $(NODE) --test --test-concurrency=1 tests/timing/preempted.test.mts
	rm -rf $(RUN_DIR)

typescript-build: lease-tool
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build

# npm 12.2.0 installs no URL dependency by default: the consumer projects of a release read the tarball of
# @polyspec/ordered-json by its URL, which their locks pin, so the consumer install and the proof run with
# allow-remote=root, and so does the lock of a release consumer, which resolves that URL; a lock pins every registry package by its integrity, so the install downloads are
# installation and no remote package enters the tree.
release-consumer release-consumer-lock release-proof: export npm_config_allow_remote := root

# The archives of the npm packages hold the builds of the TypeScript client and of the editor packages (the release tool of
# @polyspec/kit packs each tree as it is). release-assets builds on the installs it declares, the Go modules of the lease
# tool; the release workflow installs the npm packages of the TypeScript build first with make install-packages. The checks
# run offline (GOPROXY=off). The consumer projects install the archives, so their targets build the same trees.
release-assets: orm-install-go typescript-build editor-build
release-consumer release-consumer-lock: typescript-build editor-build

# editor-build builds the editor packages that the release publishes: the language service, the language server and the
# CodeMirror extension, each on the TypeScript build.
.PHONY: editor-build
editor-build: typescript-build
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(NPM) run --workspace @polyspec/dbspec-lsp build
	$(NPM) run --workspace @polyspec/dbspec-codemirror build

# generated-lint-check runs the formatter and linter of each ecosystem on the output that the generators write now, with the
# pinned tools of the checkout and the configuration of the repository (KSTD-3). The output is gitignored, so the lint of kit
# (which reads only the files Git does not ignore) never reads it: the paths here are passed explicitly, and ruff is told not to
# skip ignored paths. Each step fails on its first finding; the generated Python is linted without vulture, whose exclusion
# of the models in packages/python/pyproject.toml stays as it is.
GENERATED_PY_MODELS = packages/python/src/polyspec/orm/models/models.py
GENERATED_PHP = packages/php/gen
GENERATED_GO = ./model ./markdownmodel ./decimalmodel
GENERATED_TS = packages/ts/src/models/models.ts
.PHONY: generated-lint-check
generated-lint-check: python-models php-models go-models typescript-build
	$(RUFF) check --config $(KIT_PACKAGE)/ruff.toml --no-respect-gitignore $(GENERATED_PY_MODELS)
	$(RUFF) format --check --config $(KIT_PACKAGE)/ruff.toml --no-respect-gitignore $(GENERATED_PY_MODELS)
	$(PHPCS) -q -s --report=emacs --standard=$(KIT_PACKAGE)/phpcs.xml.dist $(GENERATED_PHP)/*.php
	cd packages/php && $(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --configuration=$(KIT_PACKAGE)/phpstan.dist.neon --autoload-file=../../vendor-php/autoload.php gen
	test -z "$$(cd packages/go && gofmt -l $(GENERATED_GO))" || { cd packages/go && gofmt -l $(GENERATED_GO); exit 1; }
	cd packages/go && $(GO) vet $(GENERATED_GO)
	node_modules/.bin/oxlint -c $(KIT_PACKAGE)/.oxlintrc.json --type-aware --deny-warnings $(GENERATED_TS)

# clippy-crate runs the lint-rust flags on the one package CRATE: cargo clippy --all-targets of the Cargo workspace WORKSPACE
# holds it, with the clippy.toml of kit (CLIPPY_CONF_DIR), as lint-rust does. packages/rust holds most packages.
WORKSPACE ?= packages/rust
.PHONY: clippy-crate
clippy-crate: lease-tool ## Clippy of the package CRATE with the lint-rust flags, in the Cargo workspace WORKSPACE; offline once the crates are downloaded
	test -n "$(CRATE)" || { echo "clippy-crate: CRATE is required" >&2; exit 2; }
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) clippy-crate --cwd $(WORKSPACE) -- $(CARGO_LEASED) env CLIPPY_CONF_DIR=$(abspath $(KIT)/..) cargo clippy -p $(CRATE) --all-targets --locked -- -D warnings -D unused_must_use -D clippy::let_underscore_must_use -D clippy::let_underscore_untyped -D clippy::map_err_ignore -D clippy::allow_attributes_without_reason

# group-rows-phpstan-check runs PHPStan at level 9 over the fixture of KSTD-5-53: a row of GroupRows is typed as GroupRow for its
# caller, so calling its method on each row passes; a mixed row fails it.
.PHONY: group-rows-phpstan-check
group-rows-phpstan-check:
	cd packages/php && $(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --level=9 --configuration=$(KIT_PACKAGE)/phpstan.dist.neon --autoload-file=../../vendor-php/autoload.php tests/phpstan/GroupRowsIteration.php

# collection-raw-phpstan-check runs PHPStan at level 5 over the fixture of KSTD-5-54: a raw Collection parameter carries no
# method of the base Model, so calling a column getter on its rows is no false method.notFound.
.PHONY: collection-raw-phpstan-check
collection-raw-phpstan-check:
	cd packages/php && $(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --level=5 --configuration=$(KIT_PACKAGE)/phpstan.dist.neon --autoload-file=../../vendor-php/autoload.php tests/phpstan/RawCollection.php

# dbspec-php-extension-check/markdown runs MarkdownTest with the extension loaded: the markdown IR uses of KSTD-5-80.
dbspec-php-extension-check/markdown: php-vendor-check dbspec-php-extension-check/prepare
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) --without-library packages/php -- --configuration packages/php/phpunit.xml.dist packages/php/tests/MarkdownTest.php

# print-CARGO_PROFILE_DEV_DEBUG prints the debug setting of the Rust test build of this checkout (KSTD-5-85). It sits at the end so that
# it never becomes the default goal of the Makefile.
.PHONY: print-CARGO_PROFILE_DEV_DEBUG
print-CARGO_PROFILE_DEV_DEBUG:
	@echo $(CARGO_PROFILE_DEV_DEBUG)

# Collection lookups retain the caller's model type and their nullable result.
.PHONY: collection-get-phpstan-check
collection-get-phpstan-check:
	cd packages/php && $(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --level=9 --configuration=$(KIT_PACKAGE)/phpstan.dist.neon --autoload-file=../../vendor-php/autoload.php tests/phpstan/CollectionGet.php

# KSTD-5-62: only the private catalog-document build failure is a Mermaid diagnostic. These owner targets run the
# focused unexpected-error identity cases; the PHP extension variant builds a test-only module around the actual mermaid.c.
.PHONY: mermaid-error-ts-check mermaid-error-python-check mermaid-error-php-check mermaid-error-php-extension-check
mermaid-error-ts-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) --test packages/ts/tests/dbspec-mermaid-errors.mjs
mermaid-error-python-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.mermaid_error_boundary
mermaid-error-php-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecMermaidErrorBoundaryTest.php
mermaid-error-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/mermaid-error-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so" mermaid-test; env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/MermaidErrorBoundaryTest.php

# Exercise the PHP extension build failure handler with isolated fake tools.
.PHONY: php-extension-build-logs-check
php-extension-build-logs-check:
	$(NODE) --test tests/php-ext/build-logs.test.mts

# rust-duplicate-catalog-check runs only the catalog transaction and assignment-budget refactor units.
.PHONY: rust-duplicate-catalog-check
rust-duplicate-catalog-check: cargo-downloads-check lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) rust-duplicate-catalog -- cargo test --manifest-path packages/rust/Cargo.toml --locked --offline -p polyspec-orm-build --lib rust_duplicate_ -- --test-threads=1

.PHONY: php-catalog-bounds-check
php-catalog-bounds-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CatalogQueryBoundsTest.php

request-hook-php-extension-check: php-vendor-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/request-hook-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/RequestHookNativeTest.php

# Runs the exact Rust same-handle child request-hook case on its SQLite case database.

# request-hook-relation-scope-check runs the relation_scope case of the request hook (relation() and relations() under a
# service scope, T203) on SQLite in every client: Go, TypeScript, Python, the PHP library, the PHP extension and Rust.
.PHONY: request-hook-relation-scope-check
request-hook-relation-scope-check: RUN_DIR = $(abspath .runtime/run)/request-hook-relation-scope-check-$$PPID
request-hook-relation-scope-check: php-vendor-check php-models python-venv-check lease-tool
	$(NODE) tests/go-test.mts -v -timeout 0 ./packages/go/orm -run '^TestRequestHook$$/^relation_scope$$' -count=1
	$(NODE) --test-name-pattern='^request-hook/relation_scope$$' packages/ts/tests/request_hook.mjs
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- packages.python.tests.test_request_hook.RequestHookTest.test_relation_scope
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter relation_scope packages/php/tests/RequestHookTest.php
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(PHP_EXTENSION_TESTS) --filter relation_scope packages/php/tests/RequestHookTest.php; status=$$?; rm -rf $(RUN_DIR); exit $$status
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) request-hook-relation-scope-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --manifest-path packages/rust/Cargo.toml --workspace --features $(ORM_RUST_TEST_FEATURES) --test request_hook relation_scope -- --exact

request-hook-rust-check: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) request-hook-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --manifest-path packages/rust/Cargo.toml --workspace --features $(ORM_RUST_TEST_FEATURES) --test request_hook same_handle_child_hook_once -- --exact
# dbspec-php-extension-check/declarations runs the extension's own checks (packages/php-ext/tests): its declarations against the stub and the
# PHP client, its required modules and its PIE package.
# dbspec-php-extension-check/silent-paths runs silent_paths.php with the extension alone (php -n, no library class): a call that must fail with an OrmException must throw, not return silently (T182-2-4).

rust-causes-check: cargo-downloads-check lease-tool
	@status=0; cd packages/rust || exit; \
	$(CARGO_TEST) rust-causes-orm -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib cause_message -- --test-threads=1 --nocapture || status=1; \
	$(CARGO_TEST) rust-causes-build -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-build --lib --features live-db cause_message -- --test-threads=1 --nocapture || status=1; \
	exit $$status

rust-closed-executor-check: lease-tool
	cd packages/rust && $(CARGO_TEST) rust-closed-executor-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib db::executor_route_tests::query_and_execute_share_pool_and_transaction_routing -- --test-threads=1 --exact

# Focused split-merge NULL boundary cases in each native client.

go-catalog-session-error-check:
	$(GO_TEST) ./packages/go/orm -run '^TestCatalogSessionEnd' -count=1

catalog-php-extension-surface-check: php-vendor-check php-models
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CatalogConnectionSurfaceTest.php
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CatalogConnectionCoverageSurfaceTest.php
# Builds the extension in an isolated run directory and executes only its native Collection unit cases.

php-lifecycle-extension-native-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/php-lifecycle-extension-native-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageDsnConnectionExtensionTest.php packages/php-ext/tests/CoverageTransactionsExtensionTest.php packages/php-ext/tests/CoverageConstraintsAndRelationsExtensionTest.php packages/php-ext/tests/CoverageStatementEventsTest.php packages/php-ext/tests/QueryCancellationNativeTest.php --filter 'testNativeMethodsAreInternal|testNativeSqliteConnectionQueriesAndCloses|testNativeSqliteTransactionCommitsAndPublishesOneTransactionId|testNativeSqliteRollbackStatementDiscardsRowsAndPublishesEvent|testStatementEventEntryPointsAreNative|testNativeCancellationStateIsPrivatePersistentAndRemovedWhenReleased|testNativeCancellationDispatchesOnlyToActiveConnectionSlots|testNativeCancellationInterruptsSqliteRollsBackAndKeepsRootConnectionUsable'


# rollback-php-extension-check runs the rollback-failed and savepoint-rollback-failed cases of packages/php/tests/RollbackTest.php
# with the extension loaded, on SQLite, MySQL and PostgreSQL (WITH_TEST_ENV).
.PHONY: rollback-php-extension-check
rollback-php-extension-check: RUN_DIR = $(abspath .runtime/run)/rollback-php-extension-check-$$PPID
rollback-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh $(PHP_EXTENSION_LIBRARY)
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/RollbackTest.php --filter 'testRollbackFailed|testSavepointRollbackFailed'; status=$$?; rm -rf $(RUN_DIR); exit $$status

transaction-failure-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/transaction-failure-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist $(if $(TRANSACTION_FAILURE_PHP_EXTENSION_TEST_FILTER),--filter '$(TRANSACTION_FAILURE_PHP_EXTENSION_TEST_FILTER)',) packages/php-ext/tests/TransactionFailureNativeTest.php
# dbspec-php-extension-check/declarations runs the extension's own checks (packages/php-ext/tests): its declarations against the stub and the
# PHP client, its required modules and its PIE package.
# dbspec-php-extension-check/silent-paths runs silent_paths.php with the extension alone (php -n, no library class): a call that must fail with an OrmException must throw, not return silently (T182-2-4).

transaction-failure-go-check:
	$(NODE) tests/go-test.mts -v -timeout 0 -tags=ormtest ./packages/go/orm $(if $(TRANSACTION_FAILURE_GO_TEST_FILTER),-run '$(TRANSACTION_FAILURE_GO_TEST_FILTER)',-run '^TestTransactionFailure(Rollback|SavepointEnd)$$|^TestRollbackFaultSQLite$$|^TestSavepointReportsFailedEnd$$') -count=1

# Runs the TypeScript transaction and savepoint cleanup failure cases against a temporary SQLite database.

# php-query-cancellation-check runs the PHP CFG-9 token, SQLite, MySQL and PostgreSQL cancellation cases.
.PHONY: php-query-cancellation-check
php-query-cancellation-check: php-vendor-check php-models php-cancel-helper-build
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/QueryCancellationTest.php

# Runs the native PHP-extension in-flight cancellation cases against the provisioned MySQL and PostgreSQL servers.
.PHONY: php-query-cancellation-extension-check
php-query-cancellation-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/php-query-cancellation-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testPostgresNoticeCancelsActiveStatementRollsBackAndReconnectsRoot|testMysqlLockEventCancelsActiveStatementRollsBackAndReconnectsRoot|testMysqlCancellationStopsEveryActiveRootAndReopensEachProcessRoot' packages/php-ext/tests/QueryCancellationNativeTest.php

transaction-failure-php-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist $(if $(TRANSACTION_FAILURE_PHP_TEST_FILTER),--filter '$(TRANSACTION_FAILURE_PHP_TEST_FILTER)',) packages/php/tests/TransactionFailureTest.php

# python-check runs the Python client's unit tests, the interface tests of the Python extractor, the generated-model check and
# the Python conformance result check. The tests import the client and ordered-json installed into the venv (orm-install-python).

transaction-failure-typescript-check: typescript-build
	$(NODE) --conditions=orm-test --test $(if $(TRANSACTION_FAILURE_TYPESCRIPT_TEST_FILTER),--test-name-pattern='$(TRANSACTION_FAILURE_TYPESCRIPT_TEST_FILTER)',) packages/ts/tests/transaction-failure.mjs

# The assignment expansion regression is a pure planner unit, separate from the Go database suite.

transaction-failure-python-check: python-venv-check
	$(RUN_TESTS) python --venv $(PYTHON_VENV) --module packages.python.tests.testcase -- \
		$(if $(TRANSACTION_FAILURE_PYTHON_TEST_FILTER),$(TRANSACTION_FAILURE_PYTHON_TEST_FILTER),packages.python.tests.test_rollback_fault.RollbackFaultTest.test_a_failed_rollback_reports_the_callback_error_and_the_rollback_error packages.python.tests.test_rollback_fault.RollbackFaultTest.test_a_failed_savepoint_rollback_and_transaction_rollback_report_both packages.python.tests.test_rollback_fault.RollbackFaultTest.test_lost_rollback_connection_is_closed_before_the_next_transaction packages.python.tests.test_rollback_fault.RollbackFaultTest.test_the_fault_reports_the_next_failed_rollback packages.python.tests.test_rollback_fault.HandleDisposalTest.test_close_during_transaction_rolls_back_and_closes_connection)

# Runs the Rust transaction and savepoint failure cases that use only local SQLite and its authorizer.

.PHONY: transaction-failure-rust-check/lib transaction-failure-rust-check/fault
transaction-failure-rust-check: cargo-downloads-check transaction-failure-rust-check/lib transaction-failure-rust-check/fault
transaction-failure-rust-check/lib:
	$(if $(TRANSACTION_FAILURE_RUST_FAULT_FILTER),:,cd packages/rust && $(CARGO_TEST) transaction-failure-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --lib end_failures_are_reported -- --nocapture)
transaction-failure-rust-check/fault:
	cd packages/rust && $(CARGO_TEST) transaction-failure-rust-fault -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test rollback $(if $(TRANSACTION_FAILURE_RUST_FAULT_FILTER),$(TRANSACTION_FAILURE_RUST_FAULT_FILTER),rollback_fault_sqlite) -- --nocapture

# The shared blind-index target regression runs only the Python client's pure planner tests.

connection-timeout-php-extension-check: RUN_DIR = $(abspath .runtime/run)/connection-timeout-php-extension-check-$$PPID
connection-timeout-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConnectionTimeoutCleanupTest.php

listen-notify-php-extension-check: RUN_DIR = $(abspath .runtime/run)/listen-notify-php-extension-check-$$PPID
listen-notify-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ListenNotifyNativeTest.php

connection-sqlite-read-during-write-python-check: python-models
	$(PYTHON_VENV)/bin/python -m unittest packages.python.tests.connection_pool.ConnectionPoolTest.test_sqlite_read_during_write_sees_only_committed_rows

connection-sqlite-read-during-write-php-extension-check: RUN_DIR = $(abspath .runtime/run)/connection-sqlite-read-during-write-php-extension-check-$$PPID
connection-sqlite-read-during-write-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter testNativeSqliteReadDuringWriteSeesOnlyCommittedRows packages/php-ext/tests/ConnectionBusyTimeoutNativeTest.php

connection-statement-timeout-php-extension-check: RUN_DIR = $(abspath .runtime/run)/connection-statement-timeout-php-extension-check-$$PPID
connection-statement-timeout-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConnectionStatementTimeoutNativeTest.php

connection-busy-timeout-php-extension-check: RUN_DIR = $(abspath .runtime/run)/connection-busy-timeout-php-extension-check-$$PPID
connection-busy-timeout-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testNativeConnectionsCommitConcurrentSqliteWriters|testNativeSqliteBusyTimeoutCancelsWrite' packages/php-ext/tests/ConnectionBusyTimeoutNativeTest.php

go-package-entry-check:
	$(GO_TEST) ./packages/go/orm -run '^TestExternalModuleCanImportClient$$' -count=1

php-package-entry-check: php-vendor-check php-models
	$(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/PackageEntryPointTest.php

php-extension-package-entry-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/php-extension-package-entry-check-$$$$"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(ORM_PHP_DYNAMIC_MODULES)' $(RUN_TESTS) phpunit --php-extension "$$run_dir/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist --filter 'test(Package|Client)' packages/php-ext/tests/DeclarationsTest.php

rust-package-entry-check: cargo-downloads-check
	cd packages/rust && $(CARGO_TEST) rust-package-entry-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --test package_entry public_package_entry -- --exact --nocapture

typescript-package-entry-check: typescript-build
	$(NODE) --conditions=orm-test --test --test-name-pattern='package-entry/runtime-exports' packages/ts/tests/statement_fault_entry.mjs

complex-query-typescript-unit-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) packages/ts/tests/fulltext-search.mjs
	$(NODE) packages/ts/tests/fulltext-chain-types.mjs
	$(NODE) packages/ts/tests/paginate-order.mjs

complex-query-typescript-request-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NODE) packages/ts/tests/complex-query-request.mjs
	$(NODE) packages/ts/tests/complex-query-request-types.mjs

complex-query-typescript-check: lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(NODE) --test packages/ts/tests/complex-query.mjs

python-package-entry-check: python-venv-check
	$(PYTHON_VENV)/bin/python -m unittest packages.python.tests.test_rollback_fault.RollbackFaultEntryTest.test_the_package_entry_point_does_not_export_the_fault
	$(PYTHON_VENV)/bin/python -m unittest packages.python.tests.test_package_entry.PackageEntryTest.test_public_entry_point_exports_are_unique_and_importable

# fuzz-check is a long-running task that runs the fuzzing-instrumented build and one second of fuzzing (-fuzztime), so
# it runs each command with no deadline under RUN_LONG. -fuzztime sets the length of fuzzing.

NATIVE_API_EQUIVALENCE_FILTER ?= testAddTablesAndColumnsRejectsExternalDriftWithoutChangingDatabase|testExistsEscapesUnderscoreInSqliteSchemaName|testAddTablesAndColumnsRollsBackWithoutCreatingInternalLockTable|testSchemaMutationMethodsRejectObjectsThatAreNotSchema|testWasInsertedChecksTransactionBeforeArguments|testWasInsertedTracksGeneratedRowsThroughNativeUtils|testRotateChecksKeyringTypeBeforeModelMetadata|testOrmConnectionFactoryRejectsAConfigThatIsNotConfigBeforeOpeningSqlite|testConnectSchemaChecksSchemaTypeBeforeConfigTypeAndDsn|testBeginSubscriberFailureRollsBackAnOpenedSqliteTransaction|testSqliteRestoreFailureKeepsThePrimaryFailureAsPrevious|testBeginInspectionFailureReplacesThePrimaryAndRestoresForeignKeys
native-api-equivalence-check: php-vendor-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/schema-utils-equivalence-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/SchemaUtilsNativeTest.php packages/php-ext/tests/UtilsNativeTest.php packages/php-ext/tests/AesUtilsNativeTest.php packages/php-ext/tests/OrmExceptionNativeTest.php --filter '$(NATIVE_API_EQUIVALENCE_FILTER)'

native-arginfo-php-extension-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/native-arginfo-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(ORM_PHP_DYNAMIC_MODULES)' $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ArginfoBuildTest.php packages/php-ext/tests/DeclarationsTest.php packages/php-ext/tests/ModelNativeTest.php packages/php-ext/tests/CollectionTest.php packages/php-ext/tests/OrmExceptionNativeTest.php packages/php-ext/tests/AesUtilsNativeTest.php packages/php-ext/tests/PrivilegeUtilsNativeTest.php packages/php-ext/tests/UtilsNativeTest.php packages/php-ext/tests/SchemaUtilsNativeTest.php

# dbspec-php-extension-check/declarations runs the extension's own checks (packages/php-ext/tests): its declarations against the stub and the
# PHP client, its required modules and its PIE package.
# dbspec-php-extension-check/silent-paths runs silent_paths.php with the extension alone (php -n, no library class): a call that must fail with an OrmException must throw, not return silently (T182-2-4).

# Checks native request-hook and audit coverage classes without running database cases.
.PHONY: request-hook-audit-native-binding-check
.PHONY: php-lifecycle-extension-native-check
request-hook-audit-native-binding-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/request-hook-audit-native-binding-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" --without-library packages/php -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageRequestHookExtensionTest.php packages/php-ext/tests/CoverageAuditTriggersExtensionTest.php packages/php-ext/tests/CoverageAuditColumnsExtensionTest.php --filter test_native_methods_are_internal

# Runs the database-free tests of shared PHP fixture and assertion helpers.
.PHONY: php-test-assertions-helper-check
php-test-assertions-helper-check: php-vendor-check
	$(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DatabaseTestAssertionsTest.php

# Runs the shared PHP and native-extension duplicate-relation cases on private SQLite fixtures.
.PHONY: cpx5-duplicate-relation-helper-check
cpx5-duplicate-relation-helper-check: php-vendor-check php-model-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/cpx5-duplicate-relation-helper-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/Cpx5DuplicateRelationTest.php; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/Cpx5DuplicateRelationNativeTest.php

.PHONY: typescript-performance-gate-unit-check
typescript-performance-gate-unit-check:
	$(RUN_TESTS) node -- --test packages/ts/tests/coverage_performance_gate.test.mjs
