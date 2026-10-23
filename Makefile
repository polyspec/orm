.PHONY: orm-check check-run databases-create ci-group-needs feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check runner-check version-check comment-language-check repo-check ts-min-check php-min-check client-unit-check php-without-mysql-check client-db-check client-pooler-check case-database-check conformance-check dialect-facts-check conformance-counter-check conformance-result-check conformance-result-physical-check conformance-rust-group-check group-rows-physical-check unselected-column-physical-check decimal-bench-sqlite decimal-physical-check run-databases perf-check interface-check go-model-check ts-model-check ts-check ts-save-key-check ts-aes-auth-check ts-codec-errors-check scripts-typecheck typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check example-check timing-check fuzz-check docs-dev docs-build docs-check docs-parse-check docs-site-check docs-site-parse-check docs-verify-idempotent docs-rules-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check orm-install-cli-check feature-unit-check feature-check feature-coverage feature-verify-rust feature-verify-other feature-docs package-check orm-test-servers orm-test-servers-tls orm-test-servers-stop orm-test-servers-leases orm-test-servers-leases-clear
# It is an independent part of the target that does not stop at a failure (scripts/check/run.mts runs it with make -k).
.PHONY: version-check/unit version-check/run comment-language-check/unit comment-language-check/run repo-check/unit repo-check/run rust-fmt-check/clients rust-fmt-check/bench rust-fmt-check/interfaces fuzz-check/engine-ir fuzz-check/clients-go-orm dialect-facts-check/probes dialect-facts-check/facts feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select testcase-check/go testcase-check/node testcase-check/runners testcase-check/rust rust-check/check rust-check/clippy rust-check/clippy-live-db rust-check/clippy-test-faults ts-check/hold ts-check/types ts-check/test feature-check/build client-unit-check/dsn client-unit-check/markdown client-unit-check/relation-keys client-unit-check/code-catalog client-unit-check/hostcodec client-unit-check/codec-aes client-unit-check/insert-parts client-unit-check/engine client-unit-check/runtime-model client-unit-check/orm-gen client-unit-check/model-methods client-unit-check/orm-gen-scan client-unit-check/orm-gen-scan-parity client-unit-check/client-generics client-unit-check/perf-extensions
.NOTPARALLEL: check check-run docs-check docs-verify-idempotent

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
CHECK_TARGETS = runner-check scripts-typecheck docs-check docs-parse-check docs-site-check docs-site-parse-check commits-check release-coverage kit-check owner-validate dependency-policy-check dependency-policy-mutation-check version-check comment-language-check testcase-check repo-check orm-test-servers-check docs-rules-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check orm-install-cli-check markdown-table-check docs-verify-idempotent go-model-check php-model-check client-unit-check php-min-check ts-check ts-save-key-check ts-aes-auth-check ts-codec-errors-check interface-typescript-extractor-check ts-min-check rust-check go-fmt-check go-vet-check rust-fmt-check rust-150-check rust-driver-check example-check client-db-check codec-check bind-check ir-answers-check fuzz-check client-pooler-check case-database-check dialect-facts-check conformance-check conformance-ts-suite-check markdown-conformance-check package-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-introspect-python-check dbspec-introspect-compare-check dbspec-plan-check dbspec-apply-check dbspec-plan-ts-check dbspec-plan-rust-check ts-model-check dbspec-language-check dbspec-plan-php-check dbspec-go-check/engine dbspec-php-check/set perf-check dbspec-php-extension-check dbspec-apply-php-check dbspec-apply-php-extension-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check collection-php-extension-check model-types-php-extension-check feature-unit-check feature-coverage feature-verify-rust feature-verify-other feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check go-test-check python-check parity-declarations-check parity-check generated-lint-check group-rows-db-go group-rows-db-python group-rows-db-typescript group-rows-db-php group-rows-db-php-extension group-rows-db-rust toolchain-check layout-check rules-check rebuild-check language-check test-markers-check duplication-check link-state-check polyspec-lock-check bypass-check suppression-check divergence-check lint-ts lint-php lint-python lint-go lint-rust lint-php-ext test-php-ext collection-get-phpstan-check
# CI splits make orm-check into one job per CI group and runs them at the same time (the job test, matrix group in .github/workflows/ci.yml).
# Each job runs `make check-run GROUP=<group>`, which runs CI_TARGETS_<group>; together the groups run every target of CHECK_TARGETS
# once each (make repo-check verifies it). The groups are split so that each job, with its setup, finishes within 10 minutes, using the target times measured in CI runs.
# One MySQL application of the 2000-table plan takes longer than that, so only stress-mysql is excluded. A local make orm-check runs
# every target without GROUP.
#   static: targets that need no database
#   clients_db: database tests of clients, Rust driver, examples, dialect facts, and Go tests
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
CI_TARGETS_static = runner-check docs-check docs-parse-check commits-check release-coverage kit-check owner-validate dependency-policy-check dependency-policy-mutation-check version-check comment-language-check testcase-check repo-check orm-test-servers-check docs-rules-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check orm-install-cli-check markdown-table-check docs-verify-idempotent go-model-check php-model-check client-unit-check php-min-check rust-check go-fmt-check go-vet-check rust-fmt-check rust-150-check codec-check bind-check ir-answers-check fuzz-check package-check ts-model-check ts-save-key-check ts-aes-auth-check ts-codec-errors-check interface-typescript-extractor-check dbspec-language-check collection-php-extension-check model-types-php-extension-check feature-unit-check parity-declarations-check generated-lint-check toolchain-check layout-check rules-check rebuild-check language-check test-markers-check duplication-check link-state-check polyspec-lock-check bypass-check suppression-check divergence-check lint-ts lint-php lint-python lint-go lint-rust lint-php-ext test-php-ext collection-get-phpstan-check
CI_TARGETS_clients_db = perf-check rust-driver-check example-check client-db-check dialect-facts-check go-test-check group-rows-db-go group-rows-db-typescript group-rows-db-php group-rows-db-php-extension group-rows-db-rust
CI_TARGETS_clients_pooler = client-pooler-check
CI_TARGETS_conformance = ts-check scripts-typecheck ts-min-check conformance-check conformance-ts-suite-check markdown-conformance-check parity-check
CI_TARGETS_feature_helpers = feature-helper-check
CI_TARGETS_python = python-check group-rows-db-python
CI_TARGETS_dbspec = dbspec-go-check/engine dbspec-php-check/set case-database-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-introspect-python-check dbspec-introspect-compare-check dbspec-plan-check dbspec-plan-ts-check dbspec-plan-rust-check dbspec-plan-php-check dbspec-php-extension-check
CI_TARGETS_dbspec_apply = dbspec-apply-check dbspec-apply-php-check dbspec-apply-php-extension-check dbspec-apply-rust-check dbspec-apply-ts-check dbspec-apply-pairs-check
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
# builds the TypeScript client, whose decimal model installs the decimal database, and holds its shared lease while
# scripts/check/databases.mts reads it.
databases-create: typescript-build
	$(READ_TYPESCRIPT)
	$(NODE) scripts/check/databases.mts create '$(SERVERS)' '$(DIRECTORY)' '$(NAME)'

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
.PHONY: dbspec-rust-check
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
# client's polyspec_orm::dbspec::introspect, and confirms catalog queries 8, 7, and 3 for every set.
.PHONY: dbspec-introspect-rust-check
dbspec-introspect-rust-check: cargo-downloads-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-introspect-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_introspect -- --nocapture

# dbspec-introspect-python-check runs the same round trip and unsupported cases with the Python client's
# polyspec.orm.dbspec.introspect.introspect_dbspec on MySQL and PostgreSQL servers (packages/python/tests/dbspec_introspect.py),
# Run the same cases on a SQLite file too. It imports the client installed into the venv, as python-unit-check does.
.PHONY: dbspec-introspect-python-check
dbspec-introspect-python-check: python-venv-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_introspect
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_introspect_queries

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
# rows and the introspected schema text must match those of the chain.
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
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test dbspec_apply_cleanup -- --nocapture
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
# runs the PHP client's own tests (packages/php/tests) with the extension loaded: Composer's autoloader loads a class of the client only
# when the extension has not registered it, so the extension's classes take the place of the client's. A run that holds results of a
# whole document set runs twice. The build uses the phpize and php-config on PATH, which make orm-install-php-extension-tools checks;
# make php-ext-arginfo rewrites the header from the stub.
PHP_EXTENSION_LIBRARY = $(RUN_DIR)/php-extension/polyspec_orm.so
# PHP_EXTENSION_TESTS runs PHPUnit files of packages/php with the extension loaded, through kit's run-tests, which gives each test
# its own timeout (K436).
PHP_EXTENSION_TESTS = env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) -- --configuration packages/php/phpunit.xml.dist
dbspec-php-extension-check/%: RUN_DIR = $(abspath .runtime/run)/dbspec-php-extension-check-$$PPID
.PHONY: dbspec-php-extension-check/arginfo dbspec-php-extension-check/prepare dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/sets dbspec-php-extension-check/render dbspec-php-extension-check/graph dbspec-php-extension-check/behaviour dbspec-php-extension-check/schema-definition dbspec-php-extension-check/analyze dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup dbspec-php-extension-check/plan-apply dbspec-php-extension-check/show-create dbspec-php-extension-check/set dbspec-php-extension-check/set-parse dbspec-php-extension-check/codec dbspec-php-extension-check/code-catalog dbspec-php-extension-check/decode dbspec-php-extension-check/aes dbspec-php-extension-check/hostcodec dbspec-php-extension-check/ir dbspec-php-extension-check/planner dbspec-php-extension-check/executor
dbspec-php-extension-check: dbspec-php-extension-check/arginfo dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/sets dbspec-php-extension-check/render dbspec-php-extension-check/graph dbspec-php-extension-check/behaviour dbspec-php-extension-check/schema-definition dbspec-php-extension-check/analyze dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup dbspec-php-extension-check/plan-apply dbspec-php-extension-check/show-create dbspec-php-extension-check/set dbspec-php-extension-check/set-parse dbspec-php-extension-check/codec dbspec-php-extension-check/code-catalog dbspec-php-extension-check/decode dbspec-php-extension-check/aes dbspec-php-extension-check/hostcodec dbspec-php-extension-check/ir dbspec-php-extension-check/planner dbspec-php-extension-check/executor
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
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CollectionTest.php $(if $(COLLECTION_TEST_FILTER),--filter '$(COLLECTION_TEST_FILTER)',); \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(ORM_PHP_DYNAMIC_MODULES)' $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testDeclarations|testClient|testRequiredModules' packages/php-ext/tests/DeclarationsTest.php; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CollectionIdentityTest.php

# Runs the native Model helper surface cases against a fresh extension build; the source-library comparison is a separate PHPUnit run.
model-types-php-extension-check: php-vendor-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-types-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(RUN_LONG) php-extension-build -- sh packages/php-ext/scripts/build.sh "$$run_dir/php-extension/polyspec_orm.so"; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelTypesSurfaceTest.php; \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(ORM_PHP_DYNAMIC_MODULES)' $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DeclarationsTest.php; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelTypesSourceTest.php
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
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES=$(ORM_PHP_DYNAMIC_MODULES) $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DeclarationsTest.php
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
	$(PHP_EXTENSION_TESTS) packages/php/tests/CoverageSchemaDefinitionTest.php
# dbspec-php-extension-check/analyze runs DbspecAnalyzeTest with the extension: the syntax analysis and format of the focused cases, of tests/dbspec/syntax.json and of the limit errors.
dbspec-php-extension-check/analyze: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecAnalyzeTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecAnalyzeTest.php
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
# dbspec-php-extension-check/ir runs EngineTest::testValidate with the extension: each case of tests/ir/validate.json is given to
# Polyspec\Orm\Validator, which the extension implements, and checks its result (valid, or the error code the case names).
dbspec-php-extension-check/ir: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/EngineTest.php --filter testValidate
# dbspec-php-extension-check/set-parse runs DbspecSetParseTest with the extension: Dbspec::parseSet on every case of tests/dbspec/set-parse.json.
dbspec-php-extension-check/set-parse: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecSetParseTest.php
# dbspec-php-extension-check/planner runs the planner suites with the extension: CoveragePlannerTest (the compile vectors of
# contracts/fixtures/planner.json), InsertPartsTest (contracts/fixtures/insert_parts.json) and IrAnswersTest (contracts/fixtures/ir_answers.json).
# It first checks that the extension registers Polyspec\Orm\Planner: its class is internal, so the planner the suites run is C.
dbspec-php-extension-check/planner: dbspec-php-extension-check/planner/coverage dbspec-php-extension-check/planner/insert-parts dbspec-php-extension-check/planner/ir-answers

# The planner parts are independent: each runs as its own target after the class check, so make -j runs them together.
dbspec-php-extension-check/planner/internal: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) -r 'exit((new ReflectionClass("Polyspec\\Orm\\Planner"))->isInternal() ? 0 : 1);'
dbspec-php-extension-check/planner/coverage: php-vendor-check dbspec-php-extension-check/planner/internal
	$(PHP_EXTENSION_TESTS) packages/php/tests/CoveragePlannerTest.php
dbspec-php-extension-check/planner/insert-parts: php-vendor-check dbspec-php-extension-check/planner/internal
	$(PHP_EXTENSION_TESTS) packages/php/tests/InsertPartsTest.php
dbspec-php-extension-check/planner/ir-answers: php-vendor-check dbspec-php-extension-check/planner/internal
	$(PHP_EXTENSION_TESTS) packages/php/tests/IrAnswersTest.php

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
	$(RUN_TESTS) node -- scripts/features/coverage.test.mts scripts/features/languages.test.mts
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
FEATURE_SUITE_HELPERS = bench-database case-database conformance-result conformance-runners python-test-harness
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
RUN_TESTS = $(NODE) node_modules/@polyspec/kit/dist/run-tests.mjs
client-unit-check: client-unit-check/dsn client-unit-check/markdown client-unit-check/relation-keys client-unit-check/code-catalog client-unit-check/hostcodec client-unit-check/codec-aes client-unit-check/insert-parts client-unit-check/engine client-unit-check/runtime-model client-unit-check/orm-gen client-unit-check/model-methods client-unit-check/orm-gen-scan client-unit-check/orm-gen-scan-parity client-unit-check/client-generics client-unit-check/perf-extensions
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
client-unit-check/runtime-model: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RuntimeModelTest.php
client-unit-check/orm-gen: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenTest.php
client-unit-check/model-methods: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php
client-unit-check/orm-gen-scan: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenScanTest.php
# orm-gen-scan-parity compares the PHP scan with the node scan, which runs from the built packages/ts.
client-unit-check/orm-gen-scan-parity: php-vendor-check lease-tool
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenScanParityTest.php
client-unit-check/client-generics: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ClientGenericsTest.php
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

client-db-check: lease-tool python-venv-check
	$(HOLD_TYPESCRIPT)
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_statement_fault_entry
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_CLIENT_DB_LANES=parallel node scripts/client-db-test.mts

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
# group-rows-db-go runs TestGroupRowsDatabase (packages/go/model/group_rows_db_test.go) on BENCH_SQLITE_DSN.
group-rows-db-go:
	$(GO_TEST) ./packages/go/model -run '^TestGroupRowsDatabase$$' -count=1
# group-rows-db-php runs GroupRowsDbTest, which reads BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and BENCH_SQLITE_DSN.
group-rows-db-php: php-vendor-check
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/GroupRowsDbTest.php
# group-rows-db-php-extension runs GroupRowsDbTest with the PHP extension loaded, on BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and BENCH_SQLITE_DSN.
group-rows-db-php-extension: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/GroupRowsDbTest.php
# group-rows-db-rust runs coverage_group_rows_db on BENCH_SQLITE_DSN.
group-rows-db-rust:
	$(MAKE) -s feature-rust-database FEATURE_CRATE=packages/rust/tests FEATURE_CARGO_TARGET='--test integration' FEATURE_DATABASE=sqlite FEATURE_DSN_ENV=BENCH_SQLITE_DSN FEATURE_TEST=coverage_group_rows_db::coverage_group_rows_db

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
# for the vectors that VECTOR names or, without VECTOR, for every vector. A vector that makes a connection's first use of a statement that an earlier
# vector makes in a full run (SQLite's orm__row_lock table) records it too when run alone; its expectation drops that statement (tests/conformance/README.md).
# record writes only when all five outputs match, and fails if it cannot record, or if the runner fails and leaves no diagnostic output.
# After recording, the same vector runs again and is compared with the new expected value. The state contracts of contracts/interfaces.json
# are checked for the vectors the run made: with VECTOR, the contracts of the named vectors only.
CONFORMANCE_VECTORS = $(foreach name,$(VECTOR),--vector $(name))
CONFORMANCE_RUN = node tests/conformance/check/main.mts run --out $(RUN_DIR)/out $(CONFORMANCE_VECTORS) --driver mysql --dsn "$$BENCH_MYSQL_DSN" --driver postgres --dsn "$$BENCH_POSTGRES_DSN" --driver sqlite --dsn "$$BENCH_SQLITE_DSN"
.PHONY: conformance-check/run
conformance-check: conformance-counter-check conformance-result-check conformance-result-physical-check conformance-check/run conformance-check/python
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
	      $(NODE) tests/conformance/check/main.mts record --driver $$db $(CONFORMANCE_VECTORS) $$pending/go.json $$pending/php.json $$pending/rust.json $$pending/typescript.json $$pending/python.json || exit 1; \
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
.PHONY: markdown-conformance-check markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/python markdown-conformance-check/rust markdown-conformance-check/typescript orm-install-flowmark
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
markdown-conformance-check: markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/python markdown-conformance-check/rust markdown-conformance-check/typescript
markdown-conformance-check/go:
	FLOWMARK=$(FLOWMARK) $(GO_TEST) -tags markdown ./packages/go/markdownmodel -run '^TestMarkdownConformance$$' -count=1
markdown-conformance-check/php: php-vendor-check
	FLOWMARK=$(FLOWMARK) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --stop-on-defect packages/php/tests/MarkdownConformanceTest.php
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
decimal-physical-check: php-vendor-check cargo-downloads-check lease-tool python-venv-check
	$(READ_TYPESCRIPT)
	test -n "$(DECIMAL_ENV)" -a -f "$(DECIMAL_ENV)" || { echo 'DECIMAL_ENV names no decimal database of this run; run make run-databases TARGETS=$@' >&2; exit 1; }
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/decimal-physical -- $(CARGO_LEASED) cargo test --no-run --offline --locked --manifest-path packages/rust/Cargo.toml -p polyspec-orm-tests --test decimal_physical
	$(RUN_LONG) go-build/decimal-physical -- $(PUBLISH) $(abspath .runtime/bin/decimalmodel.test) go test -c -o @OUT@ -tags decimalphysical ./packages/go/decimalmodel
	. $(DECIMAL_ENV) && ORM_PYTHON=$(PYTHON_VENV)/bin/python $(NODE) scripts/decimal-physical-check.mts

# interface-check runs the tests of the interface checker (tests/interfaces/check) and the checker itself with --self-test. The checker expands the entity
# unit rules into the dbspec entity order that the TypeScript client build (packages/ts/dist) reads.
.PHONY: interface-check/tests interface-check/self-test interface-typescript-extractor-check
interface-check: interface-check/tests interface-check/self-test
interface-check/tests: php-vendor-check
	$(NODE) --test tests/interfaces/check/*.test.mts
interface-typescript-extractor-check: interface-typescript-check
	$(NODE) packages/ts/testing/interfaces/typescript/node_modules/typescript/bin/tsc --project packages/ts/testing/interfaces/tsconfig.json
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
	$(NODE) scripts/docs/markdown-table.mts

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
orm-install-go:
	$(ONLINE) $(GO) mod download
	$(MAKE) --no-print-directory go-models
# orm-install-flowmark installs, in the FLOWMARK directory, the flowmark that markdown-conformance-check runs, at the module
# version that tests/markdown/flowmark.version pins.
orm-install-flowmark:
	$(ONLINE) GOBIN=$(dir $(FLOWMARK)) $(GO) install github.com/polyspec/flowmark/cmd/flowmark@$$(cat tests/markdown/flowmark.version)
	$(ONLINE) $(GO) mod download github.com/polyspec/flowmark@$$(cat tests/markdown/flowmark.version)
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
clippy-crate: ## Clippy of the package CRATE with the lint-rust flags, in the Cargo workspace WORKSPACE; offline once the crates are downloaded
	test -n "$(CRATE)" || { echo "clippy-crate: CRATE is required" >&2; exit 2; }
	cd $(WORKSPACE) && CLIPPY_CONF_DIR=$(abspath $(KIT)/..) cargo clippy -p $(CRATE) --all-targets --locked -- -D warnings -D unused_must_use -D clippy::let_underscore_must_use -D clippy::let_underscore_untyped -D clippy::map_err_ignore -D clippy::allow_attributes_without_reason

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
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) -- --configuration packages/php/phpunit.xml.dist packages/php/tests/MarkdownTest.php

# print-CARGO_PROFILE_DEV_DEBUG prints the debug setting of the Rust test build of this checkout (KSTD-5-85). It sits at the end so that
# it never becomes the default goal of the Makefile.
.PHONY: print-CARGO_PROFILE_DEV_DEBUG
print-CARGO_PROFILE_DEV_DEBUG:
	@echo $(CARGO_PROFILE_DEV_DEBUG)

# Collection lookups retain the caller's model type and their nullable result.
.PHONY: collection-get-phpstan-check
collection-get-phpstan-check:
	cd packages/php && $(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --level=9 --configuration=$(KIT_PACKAGE)/phpstan.dist.neon --autoload-file=../../vendor-php/autoload.php tests/phpstan/CollectionGet.php
