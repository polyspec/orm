.PHONY: split-read-plan-check split-read-plan-check/go split-read-plan-check/ts split-read-plan-check/python split-read-plan-check/rust
.PHONY: dbspec-lock-go-check dbspec-lock-php-check dbspec-lock-php-extension-check dbspec-lock-python-check dbspec-lock-rust-check dbspec-lock-ts-check
.PHONY: paged-read-rust-check
.PHONY: orm-check check-run databases-create ci-group-needs feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check runner-check comment-language-check repo-check ts-min-check php-min-check client-unit-check php-without-mysql-check client-db-check client-pooler-check case-database-check conformance-check dialect-facts-check conformance-result-check unselected-column-physical-check decimal-bench-sqlite decimal-physical-check run-databases perf-check interface-check go-model-check ts-model-check ts-check ts-aes-auth-check ts-codec-errors-check scripts-typecheck typescript-build rust-check rust-fmt-check rust-150-check rust-driver-check example-check timing-check fuzz-check docs-dev docs-build docs-check docs-parse-check docs-site-check docs-site-parse-check docs-verify-idempotent docs-rules-check docs-implementation-count-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check orm-install-cli-check feature-unit-check feature-check feature-coverage feature-verify-rust feature-verify-other feature-docs package-check orm-test-servers orm-test-servers-tls orm-test-servers-stop orm-test-servers-leases orm-test-servers-leases-clear orm-test-mysql-privilege-start sqlite-version-ts-check sqlite-version-rust-check relation-parent-bind-rust-check php-extension-context-prepare php-extension-context-cleanup orm-install-php-extension-runtime orm-install-typescript-runtime
.PHONY: client-db-go-check client-db-php-check client-db-php-extension-check client-db-typescript-check client-db-python-check client-db-rust-check
# It is an independent part of the target that does not stop at a failure (scripts/check/run.mts runs it with make -k).
.PHONY: comment-language-check/unit comment-language-check/run repo-check/unit repo-check/run rust-fmt-check/clients rust-fmt-check/bench rust-fmt-check/interfaces fuzz-check/engine-ir fuzz-check/clients-go-orm feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select testcase-check/go testcase-check/node testcase-check/runners testcase-check/rust rust-check/check rust-check/clippy rust-check/clippy-live-db rust-check/clippy-test-faults ts-check/hold ts-check/types ts-check/test feature-check/build client-unit-check/dsn client-unit-check/markdown client-unit-check/relation-keys client-unit-check/code-catalog client-unit-check/insert-parts client-unit-check/engine client-unit-check/runtime-model php-gen-unit-check client-unit-check/orm-gen client-unit-check/model-methods client-unit-check/client-generics client-unit-check/perf-extensions client-unit-check/dbspec-runners
.PHONY: php-ext-memory-check
.PHONY: request-hook-php-extension-check
.PHONY: t182-php-extension-model-check t182-php-extension-schema-check
.PHONY: rust-causes-check rust-closed-executor-check
.PHONY: php-go-text-check
.PHONY: go-catalog-session-error-check
.PHONY: catalog-described-temporal-go-check
.PHONY: catalog-value-go-check
.PHONY: go-sqlite-version-check
.PHONY: catalog-php-extension-surface-check
.PHONY: transaction-failure-php-extension-check
.PHONY: mysql-session-php-extension-check
.PHONY: pgsql-pdo-adapter-php-check pgsql-pdo-adapter-php-extension-check parent-slot-expansion-php-extension-check
.PHONY: transaction-failure-go-check
.PHONY: transaction-failure-php-check
.PHONY: transaction-failure-typescript-check
.PHONY: transaction-failure-python-check
.PHONY: transaction-failure-rust-check
.PHONY: connection-timeout-php-extension-check
.PHONY: connection-pool-resource-bounds-typescript-check
.PHONY: connection-utc-php-extension-check
.PHONY: go-package-entry-check
.PHONY: php-package-entry-check
.PHONY: php-extension-package-entry-check
.PHONY: rust-package-entry-check
.PHONY: typescript-package-entry-check
.PHONY: complex-query-typescript-unit-check
.PHONY: complex-query-typescript-request-check
.PHONY: python-package-entry-check
.PHONY: native-arginfo-php-extension-check
.NOTPARALLEL: check check-run docs-check docs-verify-idempotent

.PHONY:

WORKTREE_STOP = orm-test-servers-stop



# git runs the tracked hooks (.githooks/commit-msg, .githooks/pre-commit) only when core.hooksPath is .githooks, a setting of
# each clone, which every make run of orm sets while it differs (below the tools of orm). Each hook runs a make target: the
# commit-msg hook runs commit-msg-hook, which checks the message being committed against the commit rules (P28) and refuses
# a commit that breaks it. make hooks sets the setting and hooks-check checks it.

# make orm-test-servers starts the MySQL and PostgreSQL primaries, their replicas,
# and the ProxySQL and PgBouncer poolers of the database checks on free ports that it chooses
# and writes TEST_ENV; the database checks read TEST_ENV and fail when it is
# missing.
TEST_ENV ?= .runtime/servers/env
# ORM_TEST_ENV is the absolute path of the TEST_ENV that this make reads, and like DECIMAL_ENV it is
# passed to the process that the recipe starts. A make variable changes a Makefile value only on the command line, so the commands that start a sub-make (the helper check of contracts/
# features.json) pass it as TEST_ENV="$$ORM_TEST_ENV". make owner-check
# (scripts/features/owners.mts) changes it to the environment file of its own run.
export ORM_TEST_ENV = $(abspath $(TEST_ENV))
# make orm-test-mariadb starts the MariaDB primary and its replica, a set of servers of their own (scripts/test-servers-mariadb.mts),
# and writes MARIADB_ENV; the recipe entries of the database mariadb read it through WITH_MARIADB_ENV. MARIADB_BIN holds the
# folders of the MariaDB that make orm-install-mariadb builds (scripts/mariadb-build.mts), bin and scripts, the folder of
# mariadb-install-db; the MariaDB targets put them first on PATH, and on the CI runner, where they do not exist, the programs are
# those of the Ubuntu packages.
MARIADB_ENV ?= .runtime/servers/mariadb.env
MARIADB_VERSION := $(shell sed -n "s/^export const MARIADB_VERSION = '\(.*\)';$$/\1/p" scripts/mariadb-build.mts)
MARIADB_BIN := $(CURDIR)/var/mariadb/$(MARIADB_VERSION)/bin:$(CURDIR)/var/mariadb/$(MARIADB_VERSION)/scripts
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
# to 3.3 GB), while panic and assertion locations keep file:line. The value is recursive, so it expands after the section of the
# kit utilities below sets KIT_WORKTREE. Main keeps line-tables-only; its packages/rust/target is regenerable, so a worktree does not share it.
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
# ---- The tools and the recipes of orm that run the utilities of kit (T391) ----------------------------------------------
# kit ships utilities and no recipes (kit docs/spec/utilities-and-recipes.md): each target of this section is orm's own and
# runs one utility of the installed package @polyspec/kit with the arguments that orm gives it. A packed release holds the
# utilities as dist/<name>.mjs; the development link of a kit checkout (P30, .links) holds their sources as
# scripts/kit/<name>.mts. A step of a recursive make reads the installed package again, so a step after the npm ci of
# install-packages runs the kit that npm ci put in place.
KIT_PACKAGE := $(realpath node_modules/@polyspec/kit)
KIT_SOURCES := $(wildcard $(KIT_PACKAGE)/scripts/kit/link.mts)
KIT := $(if $(KIT_SOURCES),$(KIT_PACKAGE)/scripts/kit,$(KIT_PACKAGE)/dist)
KIT_EXT := $(if $(KIT_SOURCES),mts,mjs)
# The tools of mise.toml live in the checkout's own var/tools, a worktree's too (kit K858). The installer of mise puts them
# there, and its shims find them through these directories and the mise.toml of the checkout; every recipe runs with them
# and with var/tools/bin (node, npm, mise and the PHP lint tools) and the shims first on PATH.
KIT_TOOLS := $(CURDIR)/var/tools
export MISE_DATA_DIR := $(KIT_TOOLS)/mise
export MISE_CACHE_DIR := $(KIT_TOOLS)/mise/cache
export MISE_STATE_DIR := $(KIT_TOOLS)/mise/state
export MISE_CONFIG_DIR := $(KIT_TOOLS)/mise/config
export MISE_GLOBAL_CONFIG_FILE := $(CURDIR)/mise.toml
export MISE_GLOBAL_CONFIG_ROOT := $(CURDIR)
MISE_ENVIRONMENT := MISE_DATA_DIR MISE_CACHE_DIR MISE_STATE_DIR MISE_CONFIG_DIR MISE_GLOBAL_CONFIG_FILE MISE_GLOBAL_CONFIG_ROOT
# kit 0.0.98's run-tests dropped NODE_TEST_CONTEXT, so a node --test that a recipe starts from inside a node test runs as
# its own run, not as a child of that test (kit K1094); no recipe passes it on.
unexport NODE_TEST_CONTEXT
export PATH := $(KIT_TOOLS)/bin:$(KIT_TOOLS)/mise/shims:$(PATH)
# KIT_WORKTREE is set in a linked worktree, whose main checkout is another folder; CARGO_PROFILE_DEV_DEBUG reads it.
KIT_GIT_COMMON := $(abspath $(shell git rev-parse --git-common-dir 2>/dev/null))
KIT_MAIN_CHECKOUT := $(realpath $(patsubst %/.git,%,$(filter %/.git,$(KIT_GIT_COMMON))))
KIT_WORKTREE := $(if $(KIT_MAIN_CHECKOUT),$(filter-out $(realpath $(CURDIR)),$(KIT_MAIN_CHECKOUT)))
# A recipe starts the tools of the checkout by their absolute paths (kit K171): make 3.81, the make of macOS, looks a recipe line
# without shell syntax up on the PATH that make started with, not on the PATH above. Only the bootstrap runs the Node.js of the
# machine, which installs the node of mise.toml (BOOTSTRAP_NODE).
NODE := $(KIT_TOOLS)/bin/node
NPM := $(KIT_TOOLS)/bin/npm
BOOTSTRAP_NODE := node
ALINT := $(KIT_TOOLS)/mise/shims/alint
GO := $(KIT_TOOLS)/mise/shims/go
COMPOSER := $(KIT_TOOLS)/mise/shims/composer
PYTHON3 := $(KIT_TOOLS)/mise/shims/python3
UV := $(KIT_TOOLS)/mise/shims/uv
RUFF := $(KIT_TOOLS)/mise/shims/ruff
# The PHP lint tools are not tools of mise.toml; install-tools puts them into var/tools/bin.
PHPCS := $(KIT_TOOLS)/bin/phpcs
PHPSTAN := $(KIT_TOOLS)/bin/phpstan

# git runs the tracked hooks of .githooks only when core.hooksPath names that folder, a setting of each clone, which every make
# run sets while it differs.
ifneq ($(shell git config core.hooksPath),.githooks)
$(shell git config core.hooksPath .githooks)
endif

# Install: the bootstrap of mise, the node and the npm of mise.toml (TOOLS=npm, which imports only Node.js built-ins), the
# packages of package-lock.json, every tool of mise.toml at the digests of mise.lock, the symbol extractors that
# config/toolchain.json declares, then the install steps of orm (the prerequisites of install below) and the links of .links
# last. Each step is a make of its own, so it reads the kit that the step before installed. ONLINE.
.PHONY: install install-kit install-tools install-packages install-link kit-install-declared kit-install-symbols toolchain-lock
install: install-kit ## Install the tools, the packages, the steps of orm and the links of .links, in that order; ONLINE
	$(MAKE) --no-print-directory install-link
install-kit: ## Install mise, the node and npm of mise.toml, the packages, the tools and the declared symbol extractors; ONLINE
	$(MAKE) --no-print-directory install-tools TOOLS=npm
	$(MAKE) --no-print-directory install-packages
	$(MAKE) --no-print-directory install-tools
	$(MAKE) --no-print-directory kit-install-declared
# The home and the cache of the Composer that install-tools and install-symbols run, the folders of var/tools that kit 0.0.98
# set (kit K1095).
COMPOSER_TOOL_ENV = COMPOSER_HOME=$(CURDIR)/var/tools/composer/home COMPOSER_CACHE_DIR=$(CURDIR)/var/tools/composer/cache
install-tools: ## Install every locked tool of mise.toml, or the tools that TOOLS names; TOOLS=npm runs the bootstrap; ONLINE
ifeq ($(TOOLS),npm)
	$(ONLINE) $(BOOTSTRAP_NODE) $(KIT)/bootstrap/bootstrap.$(KIT_EXT)
else
	$(COMPOSER_TOOL_ENV) $(ONLINE) $(NODE) $(KIT)/install-tools.$(KIT_EXT) --no-self-update $(TOOLS)
endif
# npm reads allow-remote from the .npmrc of the checkout, since package.json pins packages by the URL of their release asset.
install-packages: ## Install the packages of package-lock.json with the npm of var/tools; ONLINE
	$(ONLINE) $(NPM) ci
install-link: ## Link the packages to the checkouts of the link declaration .links; no Claude Code hook is written
	$(NODE) $(KIT)/link.$(KIT_EXT) link
kit-install-declared: ## Install the symbol extractors that config/toolchain.json declares; ONLINE
	$(COMPOSER_TOOL_ENV) $(ONLINE) $(NODE) $(KIT)/install-symbols.$(KIT_EXT) --declared
kit-install-symbols: ## Install the symbol extractors that EXTRACTORS="go php" names; their tools must be installed first; ONLINE
	$(COMPOSER_TOOL_ENV) $(ONLINE) $(NODE) $(KIT)/install-symbols.$(KIT_EXT) $(EXTRACTORS)
# toolchain-lock writes mise.lock with the mise that the bootstrap installed. mise locks a pypi: tool with uv, which takes the
# first uv of PATH, so mise first locks and installs uv and python, then locks every tool with that Python as UV_PYTHON.
TOOLCHAIN_LOCK_PLATFORMS := linux-x64,linux-arm64,macos-arm64,macos-x64,windows-x64,windows-arm64
toolchain-lock: ## Write mise.lock: the digests of the tools of mise.toml for each platform that has their archive; ONLINE
	@test -x $(KIT_TOOLS)/bin/mise || { echo "toolchain-lock: $(KIT_TOOLS)/bin/mise is missing; run make install-tools TOOLS=npm, the bootstrap that installs it" >&2; exit 1; }
	$(ONLINE) $(KIT_TOOLS)/bin/mise lock uv python --global --platform $(TOOLCHAIN_LOCK_PLATFORMS)
	$(ONLINE) $(KIT_TOOLS)/bin/mise install --locked uv python
	UV_PYTHON="$$($(KIT_TOOLS)/bin/mise which python3)" $(ONLINE) $(KIT_TOOLS)/bin/mise lock --global --platform $(TOOLCHAIN_LOCK_PLATFORMS)

# The links of 0.0.x development (P30): the git-ignored .links of the main checkout names the checkouts that provide the
# packages; link connects them through the native package managers, link-check fails while the links differ from it, and
# unlink removes them (make install restores the locked installs).
.PHONY: link link-check unlink
link: ## Link the packages to the checkouts of .links (PROJECT names one consumer); offline
	$(NODE) $(KIT)/link.$(KIT_EXT) link $(if $(PROJECT),--project $(PROJECT))
link-check: ## Fail while the links differ from the link declaration .links; offline
	$(NODE) $(KIT)/link-check.$(KIT_EXT) $(if $(PROJECT),--project $(PROJECT))
unlink: ## Remove the links of .links, of PROJECT when given; offline
	$(NODE) $(KIT)/link.$(KIT_EXT) unlink $(if $(PROJECT),--project $(PROJECT))

# The Python of orm-install-python: a venv of the python3 of mise.toml, and uv sync --locked of a declared package.
.PHONY: python-venv uv-install
python-venv: ## Make the virtual environment DIR from the python3 of mise.toml with uv venv; offline
	@test -n "$(DIR)" || { echo "python-venv: DIR is required; run make python-venv DIR=<folder>, which names the venv to make" >&2; exit 1; }
	$(NODE) $(KIT)/python-venv.$(KIT_EXT) $(DIR)
uv-install: ## Install the Python package of DIR with uv sync --locked and the flags of SYNC; ONLINE
	UV_SYNC="--locked $(SYNC)" $(ONLINE) $(NODE) $(KIT)/uv-install.$(KIT_EXT) $(DIR)

# The gates of orm. kit-gates holds all of them; CI runs them as the partitions below in the jobs of ci-pipeline.yml, and land
# runs those that the changed paths select. kit-gates-static runs every gate past a failure, so one run names each failing gate.
.PHONY: kit-gates kit-gates-static kit-gates-runtime-ts kit-gates-runtime-php kit-gates-runtime-python kit-gates-runtime-go kit-gates-runtime-rust kit-gates-runtime-php-ext
KIT_GATES_STATIC := layout-check docs-check rules-check owner-validate rebuild-check language-check duplication-check suppression-check
# kit-gates runs the gates one at a time in the order below, its prerequisites, which land reads as the gates of orm: lint-ts
# comes first, since its make then holds the exclusive lease of the TypeScript build output for its life, which the shared lease of
# a later reader reuses; a shared lease taken first would block that exclusive one.
.NOTPARALLEL: kit-gates
kit-gates: lint-ts $(KIT_GATES_STATIC) lint-php lint-python lint-go lint-rust lint-php-ext test-php-ext ## Run every gate; CI runs its partitions
ifneq ($(filter kit-gates-static,$(MAKECMDGOALS)),)
MAKEFLAGS += -k
endif
kit-gates-static: $(KIT_GATES_STATIC) ## Run the static gates past failures
	@echo "[kit-gates-static] every static gate passed"
kit-gates-runtime-ts: lint-ts ## Run the TypeScript gate
kit-gates-runtime-php: lint-php ## Run the PHP gate
kit-gates-runtime-python: lint-python ## Run the Python gate
kit-gates-runtime-go: lint-go ## Run the Go gate
kit-gates-runtime-rust: lint-rust ## Run the Rust gate
kit-gates-runtime-php-ext: lint-php-ext test-php-ext ## Run the PHP extension gates

.PHONY: layout-check docs-check rules-check owner-check owner-validate rebuild-check language-check duplication-check suppression-check
layout-check: ## Check the folder layout against config/layout.yml with alint, that Git ignores each install folder and that no generated file is tracked; offline
	@test -x $(ALINT) || { echo "layout-check: $(ALINT) is missing; run make install-tools, which installs the alint of mise.toml" >&2; exit 1; }
	$(ALINT) check --config config/layout.yml --color never --compact .
	$(NODE) $(KIT)/generated-files.$(KIT_EXT) installs var package.json=node_modules pyproject.toml=.venv composer.json=vendor
	$(NODE) $(KIT)/generated-files.$(KIT_EXT) tracked --binary ELF --binary Mach-O --binary PE
docs-check: ## Check the documents of config/documents.json and the checklists of config/checklist.json; offline
	$(NODE) $(KIT)/check-documents.$(KIT_EXT) --checklist-place --private-path /Users/ --private-path /home/ --kit-rows
rules-check: ## Check that every rule of PRINCIPLES.md and AGENTS.md names a check that a workflow or a Git hook reaches; offline
	$(NODE) $(KIT)/check-rules.$(KIT_EXT)
owner-check: ## Run the checks that own the changed paths (config/owner-checks.json); PATHS="a b" or BASE=<revision> selects the paths
	$(NODE) $(KIT)/owner-check.$(KIT_EXT) --every-path $(if $(PATHS),--paths "$(PATHS)") $(if $(BASE),--base $(BASE))
owner-validate: ## Check that config/owner-checks.json owns every tracked path and names only existing checks; offline
	$(NODE) $(KIT)/owner-check.$(KIT_EXT) --every-path --validate
# The tool sources of rebuild-check, the values that kit 0.0.98 fixed (kit K1080): the scripts and generators, each glob quoted.
REBUILD_SOURCES := --source 'scripts/**/*.{mts,mjs,cjs,js,ts,py,php,sh,mk}' --source 'packages/*/{scripts,tools,bin}/**/*.{mts,mjs,cjs,js,ts,py,php,sh,mk}' --source 'packages/*/*/{scripts,tools,bin}/**/*.{mts,mjs,cjs,js,ts,py,php,sh,mk}' --source '**/*_generate.go' --source '**/*.generate.{mts,mjs,cjs,js,ts,py,php,sh,mk}' --source 'benchmarks/**/*.{mts,mjs,cjs,js,ts,py,php,sh,mk}' --source 'examples/**/*.{mts,mjs,cjs,js,ts,py,php,sh,mk}' --source 'tests/fixtures/*/generate.*'
# The files among the sources that are no tool source (kit K1080): the .d.ts declarations and the tests.
REBUILD_EXCLUDES := --exclude '**/*.d.ts' --exclude '*/**/{test,tests}/**' --exclude 'test/**' --exclude 'tests/**/{*_generate.go,*.generate.*}' --exclude '**/*.{test,spec}.{js,jsx,ts,tsx,cjs,cts,mjs,mts}' --exclude '**/{*_test.go,test_*.py,*_test.py,*Test.php}'
rebuild-check: ## Check that every tool that config/rebuild.json selects has its class (S1); offline
	$(NODE) $(KIT)/rebuild-check.$(KIT_EXT) $(REBUILD_SOURCES) $(REBUILD_EXCLUDES)
language-check: ## Fail on Hangul in a comment, an identifier, a message or a test name of the code; offline
	$(NODE) $(KIT)/language-check.$(KIT_EXT) --forbid '\p{Script=Hangul}'
duplication-check: ## Fail while a piece of 6 lines or more of code exists twice outside the folders of config/duplication.json; offline
	$(NODE) $(KIT)/duplication-check.$(KIT_EXT)
suppression-check: ## Fail on a suppression of a lint finding that states no reason in the form of its tool; offline
	$(NODE) $(KIT)/suppression-check.$(KIT_EXT)

# The lint of each language, by the configuration files of the root (ruff.toml, phpcs.xml.dist, phpstan.dist.neon,
# .golangci.yml, clippy.toml, .oxlintrc.json, knip.json) and the lints of each Cargo workspace, which each tool reads itself.
.PHONY: lint-ts lint-js lint-php lint-python lint-go lint-rust
# catch-check refuses a catch without a statement, which the no-empty rule of oxlint passes when it holds a comment (kit K537).
lint-ts: ## Lint the TypeScript: oxlint, knip, the type check of each project, API Extractor and catch-check; offline
	$(NODE) $(KIT)/lint-ts.$(KIT_EXT)
	$(NODE) $(KIT)/catch-check.$(KIT_EXT)
lint-js: lint-ts
lint-php: ## Lint the PHP: phpcs, and PHPStan on each Composer package; offline
	$(NODE) $(KIT)/lint-php.$(KIT_EXT) --memory-limit=-1
lint-python: ## Lint the Python: ruff, and vulture on each package; offline
	$(NODE) $(KIT)/lint-python.$(KIT_EXT)
lint-go: ## Lint the Go: golangci-lint and deadcode -test in each Go module; offline once the modules are downloaded
	$(NODE) $(KIT)/lint-go.$(KIT_EXT)
lint-rust: ## Lint the Rust: cargo clippy in each Cargo workspace
	$(NODE) $(KIT)/lint-rust.$(KIT_EXT) --locked

# The PHP extension of packages/php-ext (S10): its build with phpize, the check of its names, its stub and its arginfo, and the
# comparison of its declarations with the PHP library before its unit tests.
.PHONY: build-php-ext lint-php-ext test-php-ext
build-php-ext: ## Build packages/php-ext into var/php-ext/polyspec_orm.so after the arginfo check; ONLINE (gen_stub.php may fetch its PHP-Parser once)
	$(ONLINE) $(NODE) $(KIT)/php-extension.$(KIT_EXT) build --extension packages/php-ext --build-dir var/php-ext --skip vendor --skip node_modules --library packages/php
lint-php-ext: ## Check the names, the stub and the stub hash of the arginfo header of the extension; offline
	$(NODE) $(KIT)/php-extension.$(KIT_EXT) check --extension packages/php-ext --build-dir var/php-ext --skip vendor --skip node_modules --library packages/php
test-php-ext: build-php-ext ## Compare the declarations of the built extension with the PHP library, then run its unit tests with CASES=<pattern>; offline
	$(NODE) $(KIT)/php-extension.$(KIT_EXT) test --extension packages/php-ext --build-dir var/php-ext --skip vendor --skip node_modules --library packages/php -- --roots packages/php packages/php-ext

# The tasks of P29: each runs its target for every runtime of packages/ (go, php, php-ext, python, rust, ts) (kit K1106).
.PHONY: build test lint build-go build-php build-python build-rust build-ts test-go test-php test-python test-rust test-ts
build: ## Run build-<runtime> for every runtime of packages/; offline
	$(MAKE) --no-print-directory build-go build-php build-php-ext build-python build-rust build-ts
test: ## Run test-<runtime> for every runtime of packages/; offline
	$(MAKE) --no-print-directory test-go test-php test-php-ext test-python test-rust test-ts
lint: ## Run lint-<runtime> for every runtime of packages/; offline
	$(MAKE) --no-print-directory lint-go lint-php lint-php-ext lint-python lint-rust lint-ts
# The build of each package of a runtime with the build of its ecosystem; a PHP library has none (kit K1106). Each build is
# long-running work under run-long; go and uv are the tools of the checkout (K393-1), and cargo builds into the shared target
# directory under its lease.
build-go: ## Build the Go modules with go build; offline
	$(RUN_LONG) go-build/runtime -- $(NODE) $(KIT)/runtime-targets.$(KIT_EXT) build --roots examples packages/go tests -- $(GO) build ./...
build-php: ## A PHP library has no build step; offline
build-python: ## Build the Python package with uv build; offline
	$(RUN_LONG) python-build/runtime -- $(NODE) $(KIT)/runtime-targets.$(KIT_EXT) build --roots packages/python -- $(UV) build
build-rust: lease-tool ## Build the Rust workspace with cargo build; offline
	$(RUN_LONG) rust-build/runtime -- $(NODE) $(KIT)/runtime-targets.$(KIT_EXT) build --roots packages/rust -- $(CARGO_LEASED) cargo build --locked
build-ts: ## Build the TypeScript package with tsc; offline
	$(RUN_LONG) typescript-build/runtime -- $(NODE) $(KIT)/runtime-targets.$(KIT_EXT) build --roots packages/ts -- node_modules/.bin/tsc -p tsconfig.build.json
# The unit tests of a runtime with the name filter CASES=<pattern>, with the runner arguments that kit 0.0.98 passed (kit K1094,
# K1106): one go test over the Go modules, one test at a time in cargo and node, and the 30 s test timeout of node.
test-go: ## Run the unit tests of the Go modules with CASES=<pattern>; offline
	$(NODE) $(KIT)/runtime-targets.$(KIT_EXT) test --runner go --roots examples packages/go tests -- -count=1 -timeout=0
test-php: ## Run the unit tests of the PHP package with CASES=<pattern>; offline
	$(NODE) $(KIT)/runtime-targets.$(KIT_EXT) test --runner php --roots packages/php
test-python: ## Run the unit tests of the Python package with CASES=<pattern>; offline
	PYTHONUNBUFFERED=1 NO_COLOR=1 PYTHON_COLORS=0 $(NODE) $(KIT)/runtime-targets.$(KIT_EXT) test --runner python --roots packages/python --venv .venv
test-rust: ## Run the unit tests of the Rust workspace with CASES=<pattern>; offline
	$(NODE) $(KIT)/runtime-targets.$(KIT_EXT) test --runner cargo --roots packages/rust -- -- --test-threads=1
test-ts: ## Run the unit tests of the TypeScript package with CASES=<pattern>; offline
	$(NODE) $(KIT)/runtime-targets.$(KIT_EXT) test --runner node --roots packages/ts -- --test-timeout=30000 --test-concurrency=1

# The CI pipeline of orm (.github/workflows/ci-pipeline.yml): the plan of its jobs from config/ci.json, the setup and context
# targets that config/ci.json names, the targets of a job past failures with their report, and the closing check of ci.yml.
.PHONY: kit-ci-plan kit-ci-setup kit-ci-context-prepare kit-ci-context-cleanup ci-targets ci-passed
CI_REPORT ?= var/report/ci-targets
kit-ci-plan: ## Validate config/ci.json and write the runtime, tool and target plan to GITHUB_OUTPUT
	$(NODE) $(KIT)/ci-setup.$(KIT_EXT) --plan
kit-ci-setup: ## Run the setup targets of config/ci.json for GROUP=shared|runtime, with RUNTIME
	$(NODE) $(KIT)/ci-setup.$(KIT_EXT) --setup $(GROUP) $(RUNTIME)
kit-ci-context-prepare: ## Run the context preparation target of config/ci.json for GROUP and RUNTIME
	$(NODE) $(KIT)/ci-setup.$(KIT_EXT) --context-prepare $(GROUP) $(RUNTIME)
kit-ci-context-cleanup: ## Run the context cleanup target of config/ci.json for GROUP and RUNTIME
	$(NODE) $(KIT)/ci-setup.$(KIT_EXT) --context-cleanup $(GROUP) $(RUNTIME)
ci-targets: ## Run TARGETS past failures and write CI_REPORT (logs, record.json, summary.md)
	$(NODE) $(KIT)/ci-targets.$(KIT_EXT) -k $(CI_REPORT) $(TARGETS)
ci-passed: ## Fail unless every job of RESULTS, the JSON of toJSON(needs), has the result success
	$(NODE) $(KIT)/ci-passed.$(KIT_EXT)

# The Git hooks and merges: make hooks points core.hooksPath at .githooks, makes the hooks of config/checklist.json executable
# and declares the merge drivers of the changelogs and checklists, which git runs as twin-merge with MERGE="%O %A %B %P". The
# hooks of .githooks are orm's own and run the two targets after twin-merge.
.PHONY: hooks hooks-check twin-merge staged-generated-hook commit-msg-hook
# The declaration of make hooks (kit K1099): the hooks pre-commit and commit-msg of .githooks,
# the merges of the changelogs and checklists (kit K354) and their drivers, which run twin-merge of this checkout.
TWIN_MERGE_DRIVER := make --no-print-directory twin-merge MERGE="%O %A %B %P"
HOOK_DECLARATION := --hooks-path .githooks --hook pre-commit --hook commit-msg --merge 'CHANGELOG.md=kit-changelog' --merge 'CHANGELOG.ko.md=kit-twin' \
	--merge 'docs/plans/*/checklist.md=kit-checklist' --merge 'docs/plans/*/checklist.ko.md=kit-twin' \
	--driver 'kit-twin=$(TWIN_MERGE_DRIVER)' --driver 'kit-changelog=$(TWIN_MERGE_DRIVER)' --driver 'kit-checklist=$(TWIN_MERGE_DRIVER)'
hooks: ## Point core.hooksPath at .githooks, make its hooks executable and declare the merge drivers
	$(NODE) $(KIT)/git-hooks.$(KIT_EXT) install $(HOOK_DECLARATION)
hooks-check: ## Fail while core.hooksPath is not .githooks, a hook of config/checklist.json is missing or not executable, or a merge driver is missing
	$(NODE) $(KIT)/git-hooks.$(KIT_EXT) check $(HOOK_DECLARATION)
twin-merge: ## The merge drivers of a Korean twin, a changelog and a checklist; git runs it with MERGE="<base> <ours> <theirs> <path>"; offline
	@$(NODE) $(KIT)/twin-merge.$(KIT_EXT) $(MERGE)
staged-generated-hook: ## Fail while a staged path has a generated segment that config/generated.json does not declare; .githooks/pre-commit runs it
	$(NODE) $(KIT)/generated-files.$(KIT_EXT) staged --binary ELF --binary Mach-O --binary PE
commit-msg-hook: ## Check the message MESSAGE being committed by the commit rules (P28); .githooks/commit-msg runs it
	$(NODE) $(KIT)/check-commits.$(KIT_EXT) --message $(MESSAGE) --rules commit-ai-footer,commit-ai-identity

# The plans and the row procedure (P24 to P28): the plan utility reads its values from the environment, where make puts its
# command-line variables. The texts of a row reach it as their raw values (`$(value)`), in single quotes, so a text that names
# a make or shell variable keeps its dollar signs, and an unset text stays unset.
.PHONY: plan-new plan-split item-new item-edit item-state item-test commit documents-stamp text-absent worktree-setup land
raw_text = $(foreach v,$(1),$(if $(filter undefined,$(origin $(v))),,$(v)='$(subst ','\'',$(value $(v)))'))
plan-new: ## Write the plan NAME=<slug> into docs/plans/<slug>/ with TITLE and TITLE_KO; offline
	NAME_PATTERN='^[a-z][a-z0-9-]*$$' $(NODE) $(KIT)/plan.$(KIT_EXT) plan-new
plan-split: ## Move the items IDS with their sub-items from the plan FROM to the plan TO, in both languages; offline
	$(NODE) $(KIT)/plan.$(KIT_EXT) plan-split
item-new: ## Add the item ID to the checklist of PLAN with TASK, TASK_KO, DELIVERABLES and VERIFICATION; on main it commits it with BODY_FILE; offline
	$(call raw_text,TASK TASK_KO DELIVERABLES VERIFICATION) $(NODE) $(KIT)/plan.$(KIT_EXT) item-new
item-edit: ## Replace the cells of the item ID with TASK, TASK_KO, DELIVERABLES, VERIFICATION, CAUSE, RETRY, CAUSE_KO or RETRY_KO; offline
	$(call raw_text,TASK TASK_KO DELIVERABLES VERIFICATION CAUSE RETRY CAUSE_KO RETRY_KO) DONE_STAYS=1 $(NODE) $(KIT)/plan.$(KIT_EXT) item-edit
item-state: ## Move the item ID to STATE in both languages along an allowed transition; offline
	$(NODE) $(KIT)/plan.$(KIT_EXT) item-state
item-test: ## Run the commands of the Verification cell of the item ID in order; offline
	$(NODE) $(KIT)/plan.$(KIT_EXT) item-test
commit: ## Commit the index for the item ID as TYPE(SCOPE): SUBJECT (#ID) with the body of BODY_FILE; offline
	$(NODE) $(KIT)/plan.$(KIT_EXT) commit
documents-stamp: ## Write the source-sha256 of each English document into the Korean twins that PATHS names; offline
	$(NODE) $(KIT)/documents-stamp.$(KIT_EXT) $(PATHS)
# FILE and TEXT reach the tool through its environment unexpanded: a stale text may hold a backquote, a $ or a quote.
unexport TEXT
text-absent: export KIT_TEXT_ABSENT_FILE = $(value FILE)
text-absent: export KIT_TEXT_ABSENT_TEXT = $(value TEXT)
text-absent: ## Fail while the tracked file FILE holds the stale text TEXT, naming each line (P19); offline
	$(NODE) $(KIT)/text-absent.$(KIT_EXT)
# The worktree of a row (kit K1107), as kit 0.0.98 made it: ../<main checkout>-<NAME>-<ID> on <TYPE or fix>/<NAME>-<ID> from main;
# a worktree without node_modules first gets npm ci of the npm of var/tools, then make install and make link-check run in it. The
# worktree runs its own tools in a make of its own (kit K858): the recipe drops the flags of this make and this var/tools from PATH.
WORKTREE_MAIN = $(patsubst %/.git,%,$(shell git rev-parse --path-format=absolute --git-common-dir))
WORKTREE_DECLARATION = --folder $(WORKTREE_MAIN)-$(NAME)-$(ID) --branch $(or $(TYPE),fix)/$(NAME)-$(ID) --base main --prepare 'test -d node_modules || PATH="$(KIT_TOOLS)/bin:$$PATH" $(NPM) ci --ignore-scripts' --make install --make link-check
WORKTREE_ENVIRONMENT = env -u MAKEFLAGS -u MFLAGS -u MAKELEVEL PATH="$$(printf '%s' "$$PATH" | awk -v RS=: -v ORS=: -v tools='$(KIT_TOOLS)' 'index($$0, tools) != 1' | sed 's/:$$//')"
worktree-setup: ## Create or reuse the worktree of the row NAME and ID from main, run make install and make link-check in it; ONLINE
	$(ONLINE) $(WORKTREE_ENVIRONMENT) $(NODE) $(KIT)/worktree-setup.$(KIT_EXT) $(WORKTREE_DECLARATION)
# land runs the WORKTREE_STOP target of the worktree before it removes the worktree.
land: ## Land the branch BRANCH on main by a fast-forward after the gates that its changed paths select, then remove its worktree; offline
	$(NODE) $(KIT)/land.$(KIT_EXT) $(BRANCH) main

# The release (config/release.json): release.yml tags the commit of the successful CI run RUN, then builds, publishes and
# undrafts the GitHub Release of the tag TAG; release-candidate prepares the archives of the committed candidate before CI.
.PHONY: release-candidate release-prepare release-tools release-tools-path release-tag release-assets release-candidate-assets release-publish release-undraft release-coverage
release-candidate: ## Prepare the VERSION archives of the committed candidate before CI
	RELEASE_ASSETS=var/release/assets $(NODE) $(KIT)/release-run.$(KIT_EXT) prepare "$(VERSION)"
release-prepare:: ## The preparation of the release before release-tools; orm needs none
	@:
release-tools: ## Install the tools that config/release.json needs for the release; ONLINE
	$(ONLINE) $(NODE) $(KIT)/release-tools.$(KIT_EXT)
release-tools-path: ## Append var/tools/bin and the shims of mise to GITHUB_PATH and the environment of mise to GITHUB_ENV
	@test -n "$$GITHUB_PATH" || { echo 'release-tools-path: GITHUB_PATH is not set; run it in the release workflow, which sets it between steps' >&2; exit 1; }
	@test -n "$$GITHUB_ENV" || { echo 'release-tools-path: GITHUB_ENV is not set; run it in the release workflow, which sets it between steps' >&2; exit 1; }
	@echo "$(KIT_TOOLS)/mise/shims" >> "$$GITHUB_PATH"
	@echo "$(KIT_TOOLS)/bin" >> "$$GITHUB_PATH"
	@for name in $(MISE_ENVIRONMENT); do echo "$$name=$$(printenv $$name)"; done >> "$$GITHUB_ENV"
release-tag: ## Tag the commit of the successful CI run RUN with vX.Y.Z of its change log and the Go module tags; AUTO for a workflow_run; reads the run with gh
	@test -n "$$RUN" || { echo "release-tag: RUN is required; run make release-tag RUN=<id of a successful ci.yml run>" >&2; exit 1; }
	RELEASE_MAIN=origin/main $(NODE) $(KIT)/release-run.$(KIT_EXT) tag "$$RUN"$(if $(AUTO), --auto)
release-assets: ## Build the archive of every package of TAG and packages.json into var/release/assets; ONLINE
	@test -n "$$TAG" || { echo "release-assets: TAG is required; run make release-assets TAG=v<version>" >&2; exit 1; }
	RELEASE_ASSETS=var/release/assets $(ONLINE) $(NODE) $(KIT)/release.$(KIT_EXT) assets "$$TAG"
release-candidate-assets: ## Build the archive of every package from the committed HEAD for VERSION into var/release/assets; ONLINE
	@test -n "$$VERSION" || { echo "release-candidate-assets: VERSION is required; run make release-candidate-assets VERSION=<version>" >&2; exit 1; }
	RELEASE_ASSETS=var/release/assets $(ONLINE) $(NODE) $(KIT)/release.$(KIT_EXT) candidate-assets "$$VERSION"
release-publish: ## Create the GitHub Release of TAG as a draft with its notes and the files of release-assets
	@test -n "$$TAG" || { echo "release-publish: TAG is required; run make release-publish TAG=v<version>" >&2; exit 1; }
	RELEASE_ASSETS=var/release/assets RELEASE_RECORDS=var/release $(NODE) $(KIT)/release.$(KIT_EXT) publish "$$TAG"
release-undraft: ## Make the draft release of TAG public
	@test -n "$$TAG" || { echo "release-undraft: TAG is required; run make release-undraft TAG=v<version>" >&2; exit 1; }
	RELEASE_RECORDS=var/release $(NODE) $(KIT)/release.$(KIT_EXT) undraft "$$TAG"
release-coverage: ## Require every package file of the checkout to be classified in config/release.json; offline
	$(NODE) $(KIT)/release.$(KIT_EXT) coverage
# The release uses the released versions, so its Go runs without the go.work of the links; the archive builds build the tree
# with the go.work that orm tracks, its own workspace.
release-prepare release-tools release-tag release-publish release-undraft release-coverage: export GOWORK := off
release-assets release-candidate-assets: export GOWORK = $(CURDIR)/go.work

# commit-msg-check is the commit-msg hook: it checks the message file MESSAGE that git is about to commit.
.PHONY: commit-msg-check
commit-msg-check:
	@test -n "$(MESSAGE)" || { echo "commit-msg-check: MESSAGE is missing; git gives the hook .githooks/commit-msg the message file, which passes it as MESSAGE"; exit 2; }
	$(NODE) $(KIT)/check-commits.$(KIT_EXT) --message "$(MESSAGE)" --rules commit-ai-footer,commit-ai-identity
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
WITH_TEST_ENV = test -f $(abspath $(TEST_ENV)) || { echo "$(abspath $(TEST_ENV)) is missing; run make orm-test-servers" >&2; exit 1; }; . $(abspath $(TEST_ENV)) && ( $(LEASE_READY) ) && "$(LEASE)" hold "$${ORM_TEST_SERVERS_LEASES:?$(abspath $(TEST_ENV)) names no lease directory; run make orm-test-servers to rewrite it}" shared --pid $$$$ && export TZ=$(TEST_TZ) PHP_INI_SCAN_DIR=:$(abspath tests/timezone) FLOWMARK=$(FLOWMARK) &&
# WITH_MARIADB_ENV is WITH_TEST_ENV for the entries of the database mariadb: it reads MARIADB_ENV and holds the shared lease of the
# MariaDB servers, ORM_TEST_MARIADB_LEASES of that file.
WITH_MARIADB_ENV = test -f $(abspath $(MARIADB_ENV)) || { echo "$(abspath $(MARIADB_ENV)) is missing; run make orm-test-mariadb" >&2; exit 1; }; . $(abspath $(MARIADB_ENV)) && ( $(LEASE_READY) ) && "$(LEASE)" hold "$${ORM_TEST_MARIADB_LEASES:?$(abspath $(MARIADB_ENV)) names no lease directory; run make orm-test-mariadb to rewrite it}" shared --pid $$$$ && export TZ=$(TEST_TZ) PHP_INI_SCAN_DIR=:$(abspath tests/timezone) &&
# TEST_TZ is the process time zone of the checks that run database clients. It must be a non-UTC zone so that a defect where a client reads a database's
# zone-less datetime as the process's local time shows up even on a UTC CI runner. Every client reads and writes with the
# time zone of the connection (+00:00), so the results must not depend on this value (docs/spec/dialects.md).
TEST_TZ = Asia/Seoul

# GO_TEST runs Go tests so that each case is reported. tests/go-test.mts first runs the build of the same package and build
# tag as a long-running task with no deadline, `go-build/<packages>`, and then runs go test. -v shows the RUN, STEP, PASS, and FAIL lines that each
# case emits in packages/go/testcase during the run, and each case has its own deadline,
# so -timeout 0 turns off the deadline of the whole test binary (default 10 minutes).
# GO_TEST_FLAGS adds flags to every Go test of the repo (empty by default), such as -json for the go test -json stream of a make
# target that runs Go tests.
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
# GENERATE_ONCE runs a generator only when the key of its tracked inputs differs from its stamp (scripts/generate/once.mts, B3-2). A generated
# output is ignored by git, so the key does not depend on it. Each stamp is a file beside the output it guards (gitignored, as the output is),
# so a stamp is never a fixed file of .runtime shared by runs. GO_VERSION is the Go toolchain's version.
GENERATE_ONCE = node $(abspath scripts/generate/once.mts)
GO_VERSION = $(shell $(GO) version)
# LEASE is the program that handles holding a test resource shared by several runs (tests/lease). Its build is a long-running
# task, so it runs with no deadline under RUN_LONG.
LEASE = $(abspath .runtime/bin/lease)
BUILD_LEASE = $(RUN_LONG) go-build/lease -- $(PUBLISH) $(LEASE) go build -o @OUT@ ./tests/lease >&2
# LEASE_READY builds the lease program unless the program is present and no source of tests/lease is newer than it. It is a shell
# step, not a $(MAKE) call: GNU make runs a recipe line that calls $(MAKE) even under make -n, so the recipes that hold a lease
# (WITH_TEST_ENV, check-run, run-databases) would run their checks in a dry run.
LEASE_READY = { test -x "$(LEASE)" && test -z "$$(find tests/lease -name '*.go' -newer "$(LEASE)")"; } || $(BUILD_LEASE)
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
# CARGO_SIBLINGS runs cargo in packages/rust through kit's cargo link (K448-5). A recipe that builds the crates runs it in place
# of a bare cargo build, which link-check refuses. It names no checkout: cargo builds the polyspec crates of the checkouts that the
# link declaration (.links, K869) names, and of their released tags without one.
CARGO_SIBLINGS = $(NODE) $(abspath $(KIT))/link.$(KIT_EXT) cargo $(abspath packages/rust)
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

# The lease program is a file target of its sources, so a job builds it once: the publish of the build runs only while the file
# is missing or older than a source; the recipes that need it reach the same condition through LEASE_READY, which builds nothing once it holds.
LEASE_SOURCES = $(wildcard tests/lease/*.go)
$(LEASE): $(LEASE_SOURCES)
	$(BUILD_LEASE)

.PHONY: lease-tool
lease-tool: $(LEASE)
TSC_BUILD = $(RUN_LONG) typescript-build -- node scripts/typescript/build.mts >&2

# check runs CHECK_TARGETS one at a time with scripts/check/run.mts. The runner creates its own bench
# database and decimal database for each run, passes them as TEST_ENV and DECIMAL_ENV, and deletes them at the end, and for each target
# reports the RUN, the output lines (STEP), PASS or FAIL, and the elapsed time. The verification commands that run
# target(interface-check, php-without-mysql-check, perf-check, dbspec-go-check, dbspec-php-check,
# dbspec-rust-check, dbspec-ts-check, and dbspec-compare-check run once inside feature-verify-rust or feature-verify-other, so they are not listed again.
# contracts/check-inputs.json declares a scope for each target: owner targets
# are also selected by make owner-check, and suite targets run only in the whole suite.
CHECK_TARGETS = connection-sqlite-several-processes-python-check public-interface-typescript-check styled-column-states-unit-check recipe-runners-check group-count-boolean-unit-check runner-check typescript-build-unit-check scripts-typecheck docs-check docs-parse-check docs-site-check docs-site-parse-check release-coverage owner-validate comment-language-check testcase-check repo-check orm-test-servers-check docs-rules-check docs-implementation-count-check docs-dbs-check dbspec-codemirror-check dbspec-vscode-check dbspec-lsp-check orm-install-cli-check docs-verify-idempotent go-model-check go-sqlite-version-check php-model-check client-unit-check php-gen-unit-check phpstan-test-runner-helper-check dbspec-sqlite-literal-rows-helper-check php-test-assertions-helper-check dbspec-php-interface-program-helper-check generator-consumer-check php-min-check ts-check ts-aes-auth-check ts-codec-errors-check sqlite-version-ts-check sqlite-version-rust-check relation-parent-bind-rust-check collection-composite-key-check interface-typescript-extractor-check ts-min-check rust-check rust-build-environment-check rust-build-outdir-check rust-duplicate-catalog-check rust-time-precision-check go-fmt-check go-vet-check rust-fmt-check rust-150-check rust-driver-check example-check client-db-go-check client-db-php-check client-db-php-extension-check client-db-typescript-check client-db-python-check client-db-rust-check codec-check ir-validate-check recipe-unknown-key-check conformance-refusal-check bind-check bind-models-check fuzz-check client-pooler-go-check client-pooler-php-check client-pooler-php-extension-check client-pooler-typescript-check client-pooler-python-check client-pooler-rust-check case-database-check dialect-facts-check dialect-facts-mariadb-check conformance-check markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/php-extension markdown-conformance-check/typescript markdown-conformance-check/python markdown-conformance-check/rust mariadb-recipes-check/go mariadb-recipes-check/php mariadb-recipes-check/php-extension mariadb-recipes-check/typescript mariadb-recipes-check/python mariadb-recipes-check/rust package-check dbspec-ddl-check dbspec-introspect-check dbspec-introspect-ts-check dbspec-introspect-php-check dbspec-introspect-php-extension-check dbspec-introspect-rust-check dbspec-introspect-python-check dbspec-introspect-compare-check ts-model-check dbspec-language-check dbspec-plan-php-check dbspec-go-check/engine dbspec-php-check/set dbspec-php-check/render perf-check dbspec-php-extension-check dbspec-apply-pairs-check dbspec-verify-errors-check collection-php-extension-check model-types-php-extension-check model-native-php-extension-check feature-unit-check feature-verify-rust feature-verify-other feature-helper-check feature-stress-mysql-check feature-stress-pg-sqlite-check go-test-check python-check python-native-host-api-check generated-lint-check layout-check rules-check rebuild-check language-check duplication-check link-check suppression-check lint-ts lint-php lint-python lint-go lint-rust lint-php-ext test-php-ext collection-get-phpstan-check dbspec-lock-go-check dbspec-lock-php-check dbspec-lock-php-extension-check dbspec-lock-python-check dbspec-lock-rust-check dbspec-lock-ts-check php-codec-causes-check scalar-subquery-column-check nowait-restore-check mermaid-error-ts-check mermaid-error-python-check mermaid-error-php-check mermaid-error-php-extension-check php-extension-build-logs-check php-catalog-bounds-check column-function-metadata-check paged-read-rust-check page-cache-unit-check rust-compiler-fixtures-check native-error-cause-check request-hook-php-extension-check rust-causes-check go-catalog-session-error-check catalog-php-extension-surface-check transaction-failure-php-extension-check transaction-failure-go-check transaction-failure-php-check php-query-cancellation-check php-query-cancellation-extension-check transaction-failure-typescript-check transaction-failure-python-check transaction-failure-rust-check connection-timeout-php-extension-check mysql-tls-php-extension-check mysql-session-php-extension-check go-package-entry-check native-arginfo-php-extension-check request-hook-audit-native-binding-check native-api-equivalence-check php-package-entry-check php-extension-package-entry-check rust-package-entry-check typescript-package-entry-check python-package-entry-check interface-api-binding-unit-check catalog-mutation-helper-ts-check catalog-mutation-helper-python-check model-chunk-composite-native-php-extension-check model-query-write-php-extension-unit-check php-lifecycle-extension-native-check connection-pool-resource-bounds-typescript-check connection-utc-php-extension-check complex-query-typescript-unit-check python-complex-query-check complex-query-typescript-request-check makefile-pinned-node-recipes-check audit-native-method-assertions-helper-check rust-closed-executor-check typescript-internal-column-error-helper-check typescript-dbspec-plan-fixture-check physical-command-case-helper-check typescript-capture-error-helper-check typescript-check-state-helper-check typescript-performance-gate-unit-check mysql-test-options-helper-check database-case-tests-helper-check typescript-conditional-entry-helper-check typescript-database-case-fixture-helper-check php-plan-cache-memory-check split-read-plan-check typescript-test-exact-keys-check pgsql-pdo-adapter-php-check pgsql-pdo-adapter-php-extension-check parent-slot-expansion-php-extension-check feature-performance-check php-go-text-check catalog-connection-check/go catalog-connection-check/rust catalog-connection-check/typescript catalog-connection-check/python catalog-connection-check/php catalog-connection-check/php-extension dsn-connection-check/go dsn-connection-check/rust dsn-connection-check/typescript dsn-connection-check/python dsn-connection-check/php dsn-connection-check/php-extension connection-pool-check/go connection-pool-check/rust connection-pool-check/typescript connection-pool-check/python raw-text-check/go raw-text-check/php raw-text-check/php-extension catalog-value-rust-check statement-events-check/go statement-events-check/rust statement-events-check/typescript statement-events-check/python statement-events-check/php statement-events-check/php-extension catalog-tool-errors-rust-check request-hook-check/go request-hook-check/typescript request-hook-check/python request-hook-check/php request-hook-check/php-extension request-hook-check/rust conformance-verification-check/go complex-query-check/go conformance-verification-check/typescript complex-query-check/typescript conformance-verification-check/python complex-query-check/python conformance-verification-check/php complex-query-check/php conformance-verification-check/php-extension complex-query-check/php-extension conformance-verification-check/rust complex-query-check/rust parameter-chunking-check/go aes-rotation-check/go parameter-chunking-check/rust aes-rotation-check/rust parameter-chunking-check/typescript aes-rotation-check/typescript parameter-chunking-check/python aes-rotation-check/python parameter-chunking-check/php aes-rotation-check/php parameter-chunking-check/php-extension aes-rotation-check/php-extension php-ext-memory-check audit-triggers-check/go audit-triggers-check/rust audit-triggers-check/typescript audit-triggers-check/python audit-triggers-check/php audit-triggers-check/php-extension collection-recipe-check  conformance-generated-methods-check/go conformance-fixed-clock-check/go conformance-generated-methods-check/typescript conformance-fixed-clock-check/typescript conformance-generated-methods-check/python conformance-fixed-clock-check/python conformance-generated-methods-check/php conformance-fixed-clock-check/php conformance-generated-methods-check/php-extension conformance-fixed-clock-check/php-extension conformance-generated-methods-check/rust conformance-fixed-clock-check/rust suite-php-check suite-typescript-check suite-python-check suite-test-unit-check
# CI splits make orm-check into one job per CI group and runs them at the same time (the job test, matrix group in .github/workflows/ci.yml).
# Each job runs `make check-run GROUP=<group>`, which runs CI_TARGETS_<group>; together the groups run every target of CHECK_TARGETS
# once each, without the gates of kit, CI_KIT_GATES (make repo-check verifies it). The gates of kit are the prerequisites of
# kit-gates, which the gates workflow of kit runs in its own parallel jobs, so ci does not run them again (KSTD-5-115); a local
# make orm-check runs them with the rest.
# One MySQL application of the stress plan takes longer than that, so only stress-mysql is excluded. A local make orm-check runs
# every target without GROUP.
#   static: targets that need no database
#   clients_db: cross-client database checks whose runners are shared
#   performance: the standalone performance check
#   client_db_<language>: one runtime's native client database tests, selected by ORM_CLIENT_DB_LANGS
#   suite_<runtime>: every test file of PHP, TypeScript or Python in contracts/implementations.json (scripts/suite-test.mts)
#   clients_pooler_<language>: one runtime through job-owned poolers; each job builds its own tests
#   conformance: cross-runtime conformance and TypeScript-only checks
#   dbspec: the case-database and cross-runtime dbspec comparison targets
#   dbspec_<language>: one runtime's native dbspec targets; dbspec_apply holds the cross-client apply pairs
#   markdown_<runtime>: one runtime's native markdown cases against flowmark
#   feature_performance: the six-runtime, three-database performance measurement, one measurement at a time
#   feature_verify_rust, feature_verify_other: verification commands of shard rust and shard other
#   feature_helpers: the helper checks without the stress helpers and FEATURE_SUITE_HELPERS (feature-helper-check)
#   stress_mysql: MySQL application of the stress plan (feature-stress-mysql-check)
#   stress_pg_sqlite: bench of the stress document and PostgreSQL and SQLite application (feature-stress-pg-sqlite-check)
CI_KIT_GATES = layout-check docs-check rules-check owner-validate rebuild-check language-check duplication-check suppression-check lint-ts lint-php lint-python lint-go lint-rust lint-php-ext test-php-ext
CI_GROUPS = static clients_db performance client_db_go client_db_php client_db_php_extension client_db_typescript client_db_python client_db_rust suite_php suite_typescript suite_python clients_pooler_go clients_pooler_php clients_pooler_php_extension clients_pooler_typescript clients_pooler_python clients_pooler_rust conformance dbspec dbspec_apply dbspec_go dbspec_php dbspec_php_extension dbspec_typescript dbspec_python dbspec_rust markdown_go markdown_php markdown_php_extension markdown_typescript markdown_python markdown_rust mariadb_go mariadb_php mariadb_php_extension mariadb_typescript mariadb_python mariadb_rust feature_performance feature_verify_rust feature_verify_other feature_helpers stress_mysql stress_pg_sqlite python
CI_TARGETS_suite_php = suite-php-check
CI_TARGETS_suite_typescript = suite-typescript-check
CI_TARGETS_suite_python = suite-python-check
CI_TARGETS_static = connection-sqlite-several-processes-python-check styled-column-states-unit-check recipe-runners-check group-count-boolean-unit-check runner-check typescript-build-unit-check docs-parse-check release-coverage comment-language-check testcase-check repo-check orm-test-servers-check docs-rules-check docs-implementation-count-check docs-dbs-check dbspec-codemirror-check dbspec-lsp-check orm-install-cli-check go-model-check go-sqlite-version-check php-model-check client-unit-check php-gen-unit-check phpstan-test-runner-helper-check php-test-assertions-helper-check dbspec-sqlite-literal-rows-helper-check php-min-check rust-check go-fmt-check go-vet-check rust-fmt-check codec-check ir-validate-check recipe-unknown-key-check conformance-refusal-check bind-check bind-models-check fuzz-check package-check ts-model-check ts-aes-auth-check ts-codec-errors-check sqlite-version-ts-check sqlite-version-rust-check relation-parent-bind-rust-check collection-composite-key-check interface-typescript-extractor-check collection-php-extension-check model-types-php-extension-check model-native-php-extension-check model-chunk-composite-native-php-extension-check feature-unit-check generated-lint-check link-check collection-get-phpstan-check rust-build-environment-check rust-build-outdir-check rust-duplicate-catalog-check php-catalog-bounds-check rust-time-precision-check php-codec-causes-check scalar-subquery-column-check nowait-restore-check dbspec-language-check rust-150-check dbspec-verify-errors-check php-extension-build-logs-check column-function-metadata-check paged-read-rust-check page-cache-unit-check rust-compiler-fixtures-check native-error-cause-check request-hook-php-extension-check rust-causes-check go-catalog-session-error-check catalog-php-extension-surface-check go-package-entry-check native-arginfo-php-extension-check request-hook-audit-native-binding-check transaction-failure-php-extension-check transaction-failure-go-check transaction-failure-php-check transaction-failure-typescript-check transaction-failure-python-check transaction-failure-rust-check php-package-entry-check php-extension-package-entry-check rust-package-entry-check typescript-package-entry-check python-package-entry-check interface-api-binding-unit-check native-api-equivalence-check model-query-write-php-extension-unit-check php-lifecycle-extension-native-check complex-query-typescript-unit-check python-complex-query-check complex-query-typescript-request-check makefile-pinned-node-recipes-check audit-native-method-assertions-helper-check rust-closed-executor-check physical-command-case-helper-check typescript-conditional-entry-helper-check typescript-database-case-fixture-helper-check php-plan-cache-memory-check split-read-plan-check typescript-performance-gate-unit-check typescript-test-exact-keys-check php-go-text-check catalog-value-rust-check catalog-tool-errors-rust-check collection-recipe-check suite-test-unit-check
CI_TARGETS_clients_db = example-check
CI_TARGETS_performance = perf-check
CI_TARGETS_client_db_go = client-db-go-check dialect-facts-check go-test-check catalog-connection-check/go dsn-connection-check/go connection-pool-check/go statement-events-check/go model-queries-check/go constraints-and-relations-check/go request-hook-check/go parameter-chunking-check/go aes-rotation-check/go audit-triggers-check/go conformance-verification-check/go complex-query-check/go conformance-generated-methods-check/go conformance-fixed-clock-check/go raw-text-check/go
CI_TARGETS_client_db_php = client-db-php-check php-query-cancellation-check pgsql-pdo-adapter-php-check catalog-connection-check/php dsn-connection-check/php statement-events-check/php model-queries-check/php constraints-and-relations-check/php request-hook-check/php parameter-chunking-check/php aes-rotation-check/php audit-triggers-check/php conformance-verification-check/php complex-query-check/php conformance-generated-methods-check/php conformance-fixed-clock-check/php raw-text-check/php
CI_TARGETS_client_db_php_extension = client-db-php-extension-check mysql-tls-php-extension-check mysql-session-php-extension-check php-query-cancellation-extension-check connection-utc-php-extension-check connection-timeout-php-extension-check pgsql-pdo-adapter-php-extension-check catalog-connection-check/php-extension dsn-connection-check/php-extension statement-events-check/php-extension model-queries-check/php-extension constraints-and-relations-check/php-extension php-ext-memory-check request-hook-check/php-extension parameter-chunking-check/php-extension aes-rotation-check/php-extension audit-triggers-check/php-extension conformance-verification-check/php-extension complex-query-check/php-extension conformance-generated-methods-check/php-extension conformance-fixed-clock-check/php-extension raw-text-check/php-extension
CI_TARGETS_client_db_typescript = client-db-typescript-check connection-pool-resource-bounds-typescript-check public-interface-typescript-check catalog-connection-check/typescript dsn-connection-check/typescript connection-pool-check/typescript statement-events-check/typescript model-queries-check/typescript constraints-and-relations-check/typescript request-hook-check/typescript parameter-chunking-check/typescript aes-rotation-check/typescript audit-triggers-check/typescript conformance-verification-check/typescript complex-query-check/typescript conformance-generated-methods-check/typescript conformance-fixed-clock-check/typescript
CI_TARGETS_client_db_python = client-db-python-check catalog-connection-check/python dsn-connection-check/python connection-pool-check/python statement-events-check/python model-queries-check/python constraints-and-relations-check/python request-hook-check/python parameter-chunking-check/python aes-rotation-check/python audit-triggers-check/python conformance-verification-check/python complex-query-check/python conformance-generated-methods-check/python conformance-fixed-clock-check/python
CI_TARGETS_client_db_rust = client-db-rust-check rust-driver-check catalog-connection-check/rust dsn-connection-check/rust connection-pool-check/rust statement-events-check/rust model-queries-check/rust constraints-and-relations-check/rust request-hook-check/rust parameter-chunking-check/rust aes-rotation-check/rust audit-triggers-check/rust conformance-verification-check/rust complex-query-check/rust conformance-generated-methods-check/rust conformance-fixed-clock-check/rust
CI_TARGETS_clients_pooler_go = client-pooler-go-check
CI_TARGETS_clients_pooler_php = client-pooler-php-check
CI_TARGETS_clients_pooler_php_extension = client-pooler-php-extension-check
CI_TARGETS_clients_pooler_typescript = client-pooler-typescript-check
CI_TARGETS_clients_pooler_python = client-pooler-python-check
CI_TARGETS_clients_pooler_rust = client-pooler-rust-check
CI_TARGETS_conformance = ts-check scripts-typecheck ts-min-check conformance-check mermaid-error-ts-check catalog-mutation-helper-ts-check typescript-internal-column-error-helper-check typescript-capture-error-helper-check typescript-check-state-helper-check mysql-test-options-helper-check database-case-tests-helper-check
CI_TARGETS_feature_helpers = feature-helper-check
CI_TARGETS_python = python-check python-native-host-api-check mermaid-error-python-check generator-consumer-check catalog-mutation-helper-python-check
CI_TARGETS_dbspec = case-database-check dbspec-introspect-compare-check
CI_TARGETS_dbspec_apply = dbspec-apply-pairs-check
CI_TARGETS_dbspec_go = dbspec-go-check/engine dbspec-ddl-check dbspec-introspect-check dbspec-lock-go-check
CI_TARGETS_dbspec_php = dbspec-php-check/set dbspec-php-check/render dbspec-introspect-php-check dbspec-plan-php-check dbspec-lock-php-check dbspec-php-interface-program-helper-check mermaid-error-php-check
CI_TARGETS_dbspec_php_extension = dbspec-introspect-php-extension-check dbspec-php-extension-check dbspec-lock-php-extension-check mermaid-error-php-extension-check parent-slot-expansion-php-extension-check
CI_TARGETS_dbspec_typescript = dbspec-introspect-ts-check dbspec-lock-ts-check typescript-dbspec-plan-fixture-check
CI_TARGETS_dbspec_python = dbspec-introspect-python-check dbspec-lock-python-check
CI_TARGETS_dbspec_rust = dbspec-introspect-rust-check dbspec-lock-rust-check
CI_TARGETS_markdown_go = markdown-conformance-check/go
CI_TARGETS_markdown_php = markdown-conformance-check/php
CI_TARGETS_markdown_php_extension = markdown-conformance-check/php-extension
CI_TARGETS_markdown_typescript = markdown-conformance-check/typescript
CI_TARGETS_markdown_python = markdown-conformance-check/python
CI_TARGETS_markdown_rust = markdown-conformance-check/rust
CI_TARGETS_mariadb_go = mariadb-recipes-check/go dialect-facts-mariadb-check
CI_TARGETS_mariadb_php = mariadb-recipes-check/php
CI_TARGETS_mariadb_php_extension = mariadb-recipes-check/php-extension
CI_TARGETS_mariadb_typescript = mariadb-recipes-check/typescript
CI_TARGETS_mariadb_python = mariadb-recipes-check/python
CI_TARGETS_mariadb_rust = mariadb-recipes-check/rust
CI_TARGETS_feature_performance = feature-performance-check
CI_TARGETS_feature_verify_rust = feature-verify-rust
CI_TARGETS_feature_verify_other = feature-verify-other
CI_TARGETS_stress_mysql = feature-stress-mysql-check
CI_TARGETS_stress_pg_sqlite = feature-stress-pg-sqlite-check
# run-databases runs the make target(s) in TARGETS as a single run with its own bench database and decimal database
# (scripts/check/run.mts, the same runner as make check-run). Use it when running a target directly that uses the bench or decimal database:
# the server environment of TEST_ENV has no such database.
# databases-create is the setup step databases/create of the runner (scripts/check/run.mts) and of make owner-check: it
# builds the TypeScript client, creates the run-owned bench and decimal databases, and writes every DSN to the run environment before coverage reads database state.
databases-create: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) scripts/check/databases.mts create '$(SERVERS)' '$(DIRECTORY)' '$(NAME)'

run-databases:
	( $(LEASE_READY) ) && $(NODE) scripts/check/run.mts --job-summary $(abspath $(TEST_ENV)) $(TARGETS)

# orm-check runs check-run through ci-targets, which runs it past failures and records its report under CI_REPORT. The
# full suite runs on GitHub CI after a push (.github/workflows/ci.yml), and a local check is no step required before a push. check-run runs the runner
# (scripts/check/run.mts): each run creates its own bench and decimal databases, runs the targets one by one and writes the
# record of the run to .runtime/check/<id>/record.json. The runner reads TEST_ENV as the setup step servers and holds the
# shared lease of those servers: when the file is missing (make orm-test-servers failed), it records only the targets that need
# a database as not-run and runs the rest.
# GROUP runs only one CI group (CI_TARGETS_<group>). That run is one part of the whole suite that one GitHub Actions job runs,
# so it is accepted only when GITHUB_ACTIONS is true.
CHECK_RUN_TARGETS = $(if $(GROUP),$(CI_TARGETS_$(GROUP)),$(CHECK_TARGETS))
orm-check:
	$(MAKE) ci-targets TARGETS=check-run
check-run:
	$(if $(GROUP),$(if $(filter $(GROUP),$(CI_GROUPS)),,$(error GROUP $(GROUP) names no CI group; give one of CI_GROUPS: $(CI_GROUPS))))
	$(if $(GROUP),$(if $(filter true,$(GITHUB_ACTIONS)),,$(error GROUP runs one CI group of make check-run on GitHub Actions only; run make orm-check without GROUP, which runs every target of CHECK_TARGETS)))
	( $(LEASE_READY) ) && $(NODE) scripts/check/run.mts $(abspath $(TEST_ENV)) $(CHECK_RUN_TARGETS)

# ci-group-needs writes the setup steps that the job of CI group GROUP runs as step output lines (`<output>=true|false`): it decides them from the need
# that each target of the group declares in contracts/check-inputs.json (scripts/check/ci-setup.mts). The workflow adds those lines
# to $GITHUB_OUTPUT, and a setup step runs only when its own output is true.
ci-group-needs:
	$(if $(filter $(GROUP),$(CI_GROUPS)),,$(error GROUP $(GROUP) names no CI group; give one of CI_GROUPS: $(CI_GROUPS)))
	@$(NODE) scripts/check/ci-setup.mts outputs $(CI_TARGETS_$(GROUP))

# bench measures performance (parse, introspection, and comparison of the 2000-table stress document, application of the stress plan, and CPU time) per target with the same
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
# generator by generation-go), and packages/go/testcase is run by testcase-check with the same commands. The examples
# package tests, including the DSN refusal and output comparisons, run once in example-check with their PHP, Python and database setup.
GO_TEST_CHECK_PACKAGES = $$(go list ./packages/go/cmd/... ./packages/go/procevent/... ./packages/go/internal/... ./tests/...)
.PHONY: go-test-check
# go-test-check runs every go test of the check packages. The cross-runtime tests of packages/go/internal/dialects (apply clients,
# introspect compare, dialect facts) need the runner binaries, the PHP extension, the Python runtime, the stress document and the
# MySQL privilege fixture, which go-test-check builds or declares and exports (T334-3-6-3); without them those tests fail.
# The entries of mariadb, Test<Name>Mariadb, need the MariaDB servers, which a runner of the MySQL servers cannot hold:
# dialect-facts-mariadb-check runs the MariaDB probes (TestDialectFactsMariadb), and mariadb-recipes-check/go the others.
go-test-check: RUN_DIR = $(abspath .runtime/run)/go-test-check-$$PPID
go-test-check: lease-tool python-venv-check php-vendor-check orm-codes-typescript flowmark-check go-test-check/cross-runtime
	$(WITH_TEST_ENV) DBSPEC_APPLY_RUST=$(RUN_TARGET)/debug/examples/dbspec_apply POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PYTHON=$(PYTHON_VENV)/bin/python DBSPEC_STRESS_DOCUMENT=$(DBSPEC_INTROSPECT_DOCUMENT) DBSPEC_INTROSPECT_RUST=$(RUN_TARGET)/$(DBSPEC_INTROSPECT_DIR)/examples/dbspec_introspect DBSPEC_INTROSPECT_PYTHON=$(PYTHON_VENV)/bin/python $(GO_TEST) -skip '^Test[A-Za-z]*Mariadb$$' $(GO_TEST_CHECK_PACKAGES)
	rm -rf $(RUN_DIR)

go-test-check/cross-runtime: typescript-current python-venv-check php-vendor-check
	$(READ_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_INTROSPECT_DOCUMENT))
	$(PUBLISH) $(DBSPEC_INTROSPECT_DOCUMENT) node tests/dbspec/stress.mts $(DBSPEC_INTROSPECT_TABLES)
	$(RUN_LONG) rust-build/dbspec_apply --cwd packages/rust -- $(CARGO_COPY) debug/examples/dbspec_apply -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm --example dbspec_apply
	$(RUN_LONG) rust-build/dbspec_introspect --cwd packages/rust -- $(CARGO_COPY) $(DBSPEC_INTROSPECT_DIR)/examples/dbspec_introspect -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --profile $(DBSPEC_INTROSPECT_PROFILE) --locked --offline -p polyspec-orm --example dbspec_introspect
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)

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
testcase-check/rust:
	cd packages/rust && $(CARGO_TEST) testcase-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-testcase

# client-pooler-check runs the client database tests through the PgBouncer
# pooler in transaction mode for PostgreSQL and the ProxySQL pooler for MySQL. Its php-extension lane builds the
# extension, so it installs the PHP extension tools (T272), and its lanes run the recipe units with a database (T343-12).
client-pooler-check: client-pooler-go-check client-pooler-php-check client-pooler-php-extension-check client-pooler-typescript-check client-pooler-python-check client-pooler-rust-check

.PHONY: client-pooler-go-check
client-pooler-go-check: lease-tool orm-codes flowmark-check
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=go ORM_CLIENT_DB_POOLER=1 ORM_PYTHON=$(PYTHON_VENV)/bin/python FLOWMARK=$(FLOWMARK) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" node scripts/client-db-test.mts

.PHONY: client-pooler-php-check
client-pooler-php-check: php-vendor-check php-models orm-codes flowmark-check
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=php ORM_CLIENT_DB_POOLER=1 ORM_PYTHON=$(PYTHON_VENV)/bin/python FLOWMARK=$(FLOWMARK) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" node scripts/client-db-test.mts

.PHONY: client-pooler-php-extension-check
client-pooler-php-extension-check: lease-tool php-vendor-check php-models orm-install-php-extension-tools orm-codes flowmark-check
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=php-extension ORM_CLIENT_DB_POOLER=1 ORM_PYTHON=$(PYTHON_VENV)/bin/python FLOWMARK=$(FLOWMARK) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" node scripts/client-db-test.mts

.PHONY: client-pooler-typescript-check
client-pooler-typescript-check: typescript-current orm-codes flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=typescript ORM_CLIENT_DB_POOLER=1 ORM_PYTHON=$(PYTHON_VENV)/bin/python FLOWMARK=$(FLOWMARK) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" node scripts/client-db-test.mts

.PHONY: client-pooler-python-check
client-pooler-python-check: python-venv-check orm-codes flowmark-check
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=python ORM_CLIENT_DB_POOLER=1 ORM_PYTHON=$(PYTHON_VENV)/bin/python FLOWMARK=$(FLOWMARK) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" node scripts/client-db-test.mts

.PHONY: client-pooler-rust-check
client-pooler-rust-check: lease-tool orm-codes flowmark-check
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=rust ORM_CLIENT_DB_POOLER=1 ORM_PYTHON=$(PYTHON_VENV)/bin/python FLOWMARK=$(FLOWMARK) ORM_TEST_POSTGRES_DSN="$$ORM_TEST_PGBOUNCER_DSN" ORM_TEST_MYSQL_DSN="$$ORM_TEST_PROXYSQL_DSN" node scripts/client-db-test.mts

# runner-check checks the check runner (scripts/check/run.mts) and its run record (scripts/check/record.mts) with a temporary git checkout and stub steps.
# It does not run the actual targets or databases.
runner-check:
	$(NODE) --test scripts/check/run.test.mts scripts/check/continue.test.mts scripts/check/step.test.mts scripts/check/downloads.test.mts scripts/check/job-context.test.mts scripts/json/schema.test.mts

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

# dbspec-introspect-check names the Go entries of the recipe contracts/fixtures/dbspec_introspect/dbspec_introspect.json,
# which the Go test suite runs (docs/spec/feature-coverage.md FCV-3).
.PHONY: dbspec-introspect-check
dbspec-introspect-check:

# dbspec-introspect-ts-check builds the TypeScript client and runs the recipe of dbspec-introspect-check on MySQL, PostgreSQL and
# SQLite.
.PHONY: dbspec-introspect-ts-check
dbspec-introspect-ts-check: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) --conditions=orm-test packages/ts/tests/dbspec_introspect-mysql.test.mjs packages/ts/tests/dbspec_introspect-postgres.test.mjs packages/ts/tests/dbspec_introspect-sqlite.test.mjs packages/ts/tests/dbspec_introspect-markdown.test.mjs

# dbspec-introspect-php-check runs the recipe and the failing query in PDO's silent error mode with the PHP client's
# Polyspec\Orm\Dbspec\Dbspec::introspect.
.PHONY: dbspec-introspect-php-check
dbspec-introspect-php-check: php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecIntrospectRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecIntrospectTest.php packages/php/tests/DbspecCatalogChecksTest.php

# dbspec-introspect-php-extension-check runs the recipe and the failing query in PDO's silent error mode with the PHP
# extension polyspec_orm loaded, whose Polyspec\Orm\Dbspec\Dbspec::introspect takes the place of the client's. The extension is built in
# this run's directory.
.PHONY: dbspec-introspect-php-extension-check
dbspec-introspect-php-extension-check: php-vendor-check flowmark-check
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)
	$(WITH_TEST_ENV) $(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecIntrospectRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) $(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecIntrospectExtensionTest.php
	$(WITH_TEST_ENV) $(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecIntrospectNativeTest.php
	rm -rf $(RUN_DIR)

# dbspec-introspect-rust-check runs the recipe with the Rust client's polyspec_orm::dbspec::introspect.
.PHONY: dbspec-introspect-rust-check
dbspec-introspect-rust-check: flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-introspect-rust-check -- $(RECIPE_RUST_TEST) --test all -- dbspec_introspect_mysql:: dbspec_introspect_postgres:: dbspec_introspect_sqlite:: dbspec_introspect_markdown:: --nocapture

.PHONY: dbspec-sqlite-literal-rows-helper-check
dbspec-sqlite-literal-rows-helper-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecShowCreateIntrospectTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecBehaviourTest.php

# dbspec-introspect-python-check runs the recipe with the Python client's polyspec.orm.dbspec.introspect.introspect_dbspec.
.PHONY: dbspec-introspect-python-check
dbspec-introspect-python-check: python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_dbspec_introspect_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_dbspec_introspect_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_dbspec_introspect_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_dbspec_introspect_markdown


catalog-mutation-helper-python-check: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_catalog_mutation_helper
	$(PYTHON_TESTS) -- packages.python.tests.test_catalog_described_temporal

catalog-mutation-helper-ts-check: typescript-read
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/catalog-mutation-helper.test.mjs

typescript-internal-column-error-helper-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/internal-column-error.test.mjs

typescript-dbspec-plan-fixture-check: typescript-read
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/dbspec-plan-fixture.test.mjs

physical-command-case-helper-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test scripts/physical-command-case.test.mts

typescript-capture-error-helper-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/capture-error.test.mjs

typescript-check-state-helper-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/check-state.test.mjs

.PHONY: typescript-test-exact-keys-check
typescript-test-exact-keys-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/assertions.test.mjs

mysql-test-options-helper-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/mysql-test-options.test.mjs

database-case-tests-helper-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/database-case-tests.test.mjs

typescript-conditional-entry-helper-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/conditional-entry.test.mjs

typescript-database-case-fixture-helper-check: typescript-read
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/database-case-fixture.test.mjs

# The six dbspec SQLite lock/session checks execute focused fake-driver cases; none starts or opens a database.
dbspec-lock-go-check:
	$(GO_TEST) ./packages/go/engine/dbspec -run '^TestSqlite(LockResult|SessionClassifiesBeginErrorAndRestoresState)$$' -count=1

dbspec-lock-php-check: php-vendor-check php-models
	$(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter DbspecSqliteLockTest packages/php/tests/DbspecSqliteLockTest.php

dbspec-lock-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/dbspec-lock-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSqliteLockTest.php; env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecSqliteLockNativeTest.php

dbspec-lock-python-check: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_dbspec_sqlite_lock

dbspec-lock-rust-check:
	cd packages/rust && $(CARGO_TEST) dbspec-lock-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib sqlite_lock_result_tests -- --nocapture

dbspec-lock-ts-check: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/dbspec-begin-exclusive-lock.mjs

# dbspec-apply-stress-bench runs the case stress_plan_commits_each_step of the dbspec_apply recipe in Go: it applies the 100-table
# stress plan as the first plan to the databases in APPLY_STRESS_DIALECTS (make bench runs all three). MySQL commits its statements and its 1100 history steps separately.
# APPLY_STRESS_DIALECTS is the list of databases separated by `|` (mysql, postgres, sqlite) and selects the database tests of that recipe. So
# CI runs the longest MySQL application in a different group from PostgreSQL and SQLite (feature-stress-mysql-check,
# feature-stress-pg-sqlite-check). A name that is not a database, or an empty value, passes while selecting no subtest, so make stops before the
# command.
APPLY_STRESS_DIALECTS = mysql|postgres|sqlite
.PHONY: dbspec-apply-stress-bench
dbspec-apply-stress-bench: go-models
	$(if $(APPLY_STRESS_DIALECTS),,$(error APPLY_STRESS_DIALECTS is empty; give mysql, postgres or sqlite separated by |))$(foreach dialect,$(subst |, ,$(APPLY_STRESS_DIALECTS)),$(if $(filter $(dialect),mysql postgres sqlite),,$(error APPLY_STRESS_DIALECTS names $(dialect), which is no database; give mysql, postgres or sqlite separated by |)))
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeDbspecApply($(subst mysql,Mysql,$(subst postgres,Postgres,$(subst sqlite,Sqlite,$(APPLY_STRESS_DIALECTS)))))$$/^stress_plan_commits_each_step$$' -count=1

# dbspec-apply-pairs-check builds the TypeScript client and the Rust apply runner,
# the Go, PHP, TypeScript, and Rust runners in tests/dbspec/apply, the PHP extension polyspec_orm runner (built in this run's directory), and the Python runner
# packages/python/tests/dbspec_apply_runner.py: for every ordered pair, on MySQL, PostgreSQL,
# and SQLite, the first plan of the chain is applied by one client and the rest by another, where the first client stops
# in the middle, the second client finishes the plan with recover, and the second client rolls back the plan that stopped again. The history
# rows and the introspected schema text must match those of the chain. Python also runs the
# representative finalize and lock-wait scenarios on each database.
.PHONY: dbspec-apply-pairs-check
dbspec-apply-pairs-check: go-test-check

# dbspec-plan-php-check runs the drift refusals of the PHP client's Polyspec\Orm\Dbspec\Dbspec::apply and rollback.
.PHONY: dbspec-plan-php-check
dbspec-plan-php-check: php-vendor-check php-models
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanApplyTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanReaderTest.php

# dbspec-introspect-compare-check applies the stress document (DBSPEC_INTROSPECT_TABLES tables) to MySQL,
# PostgreSQL, and SQLite, and for each database runs the introspection runners of tests/dbspec/introspect in Go, PHP, TypeScript, Rust, and
# the PHP extension polyspec_orm (built in this run's directory), requiring the same output, source schema text, and no unsupported objects, and each
# prints the introspection time and warns when it exceeds the reference value. dbspec-introspect-compare-bench runs the same target with the 2000
# table document and the release runners.
.PHONY: dbspec-introspect-compare-check dbspec-introspect-compare-bench
dbspec-introspect-compare-check: go-test-check

dbspec-introspect-compare-bench:
	$(MAKE) --no-print-directory dbspec-introspect-compare-check DBSPEC_INTROSPECT_TABLES=2000 DBSPEC_INTROSPECT_PROFILE=release

# dbspec-compare-check runs the Go, PHP, TypeScript, Python, and Rust dbspec runners and the PHP extension polyspec_orm runner over the directory tests/dbspec
# (its recipe files), the stress document (DBSPEC_COMPARE_TABLES tables), tests/dbspec/ddl.json, tests/dbspec/plan-cases.json and tests/dbspec/mermaid.json,
# each twice; the two runs' outputs fail at the first differing case. The runs also print the declaration positions of
# the positions cases of positions.json and, for each analysis of hashes.json and sets.json, the tokens and the format of its text and set.
# The document cases are the recipes (canonical, normalize, invalid, positions, files, hashes and sets .json), which every runner reads through the recipe schema. The PHP extension is built in this run's directory
# (PHP_EXTENSION_LIBRARY). Before that, every runner must
# reject, with an error that gives the position, a vector that omits a section or field or changes a type, and compare,
# apply, and the Rust stress runner must reject a missing or directory input, with its path. A runner also refuses a section
# or field of a recipe file that the format does not name: every runner reads its vector files through the JSON Schemas of
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
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 tests/dbspec/compare/check.test.mts
# PYTHON_VENV is the virtual environment that orm-install-python makes. It holds the Python client installed editable,
# with the pinned dependencies of its pyproject.toml (ordered-json, cryptography, PyMySQL, psycopg, ruamel.yaml) and
# of its extra test (jsonschema-rs); the checks
# take this interpreter as ORM_PYTHON and import the package through that install.
PYTHON_VENV = $(abspath packages/python/.venv)
# orm-install-python installs the Python tool and its declared venv backend from mise.toml, and makes the
# venv of that interpreter with kit's python-venv; no other python3 of PATH is used. uv sync installs the client into that venv
# from packages/python/uv.lock with its group test, editable, as uv sync does by default (T259): the install imports
# packages/python/src, so a source change needs no reinstall. The fixture models that python-models writes are no part of the client: they live in
# packages/python/tests/models, the tests' own package, outside the source package whose python symbols kit reads (K855, K977).
# orm-python-lock writes the lock of the Python client with uv alone (KSTD-5-102): uv lock records packages/python/uv.lock from
# pyproject.toml, the lock that uv sync of orm-install-python installs.
.PHONY: orm-python-lock
orm-python-lock:
	cd packages/python && $(ONLINE) $(UV) lock

.PHONY: orm-install-python
orm-install-python: orm-codes-python
	$(MAKE) --no-print-directory install-tools TOOLS="python uv"
	$(MAKE) --no-print-directory python-venv DIR=$(PYTHON_VENV)
	$(MAKE) --no-print-directory uv-install DIR=packages/python SYNC='--quiet --group test'
	$(MAKE) --no-print-directory install-link
	$(MAKE) --no-print-directory python-models
# python-venv-check checks that the venv of orm-install-python exists and runs the Python release of mise.toml. A missing venv
# or another release fails without a download or a repair, and names the fix: remove the venv and run make install. Every target
# that runs that venv reads codes.py, which polyspec.orm imports, so its prerequisite orm-codes-python writes the file first.
.PHONY: python-venv-check
python-venv-check: orm-codes-python
	@test -x $(PYTHON_VENV)/bin/python || { echo "python-venv-check: $(PYTHON_VENV)/bin/python is missing; run make install, which creates it"; exit 1; }
	@got=$$($(PYTHON_VENV)/bin/python -c 'import platform; print(platform.python_version())') || { echo "python-venv-check: $(PYTHON_VENV)/bin/python does not run; remove $(PYTHON_VENV) and run make install, which builds it from the Python of mise.toml"; exit 1; }; \
	want=$$(mise current python) || { echo "python-venv-check: mise does not name the Python of mise.toml; run make install-tools"; exit 1; }; \
	test "$$got" = "$$want" || { echo "python-venv-check: $(PYTHON_VENV) runs Python $$got, but mise.toml declares $$want; remove $(PYTHON_VENV) and run make install, which builds it from the Python of mise.toml"; exit 1; }

# php-vendor-check fails when vendor-php/autoload.php or the PHPUnit of packages/php or packages/php-ext, which orm-install-php
# creates with Composer, is missing, and names the make step that creates it; it installs nothing. A target that runs PHP
# through packages/php/tests/autoload.php or a package's PHPUnit takes it as a prerequisite. Such a target reads Code.php of
# packages/php/src, so its prerequisite orm-codes-php writes the file first.
.PHONY: php-vendor-check
php-vendor-check: orm-codes-php
	@for file in vendor-php/autoload.php vendor-php/bin/phpunit; do test -f $$file || { echo "php-vendor-check: $$file is missing; run make orm-install-php, which installs it with Composer"; exit 1; }; done
	@$(NODE) scripts/php/vendor-autoload-check.mjs

# python-check runs the Python client's unit tests, the interface tests of the Python extractor, the generated-model check and
# the Python conformance result check. The tests import the client and ordered-json installed into the venv (orm-install-python).
.PHONY: python-check python-unit-check python-interface-unit-check
# These DB-free units pin the Python wall-clock source, native SQL dialect hooks and test-fault entrypoints.
.PHONY: python-native-host-api-check
python-native-host-api-check: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_clock_source.WallMicrosTest.test_estimate_inside_wall_millisecond_is_used packages.python.tests.test_clock_source.WallMicrosTest.test_estimate_below_wall_clamps_and_reanchors packages.python.tests.test_clock_source.WallMicrosTest.test_estimate_above_wall_millisecond_clamps_and_reanchors packages.python.tests.test_clock_source.NativeDialectHookTest.test_python_dialect_hooks_keep_their_native_forms packages.python.tests.test_rollback_fault.NativeFaultEntryUnitTest.test_test_fault_facade_sets_only_the_requested_connection_state

python-check: python-unit-check python-interface-unit-check python-model-check conformance-result-check/python
# tests/bind/messages.json imports the slot models that ORM_PYTHON_BIND_MODELS names, as its other runs do.
python-unit-check: export ORM_PYTHON_BIND_MODELS = $(BIND_PY_MODELS)
python-unit-check: python-venv-check bind-python-models
	$(PYTHON_TESTS) -- discover -s packages/python/tests -t . -p 'test_*.py'

# The DB-free complex query cases cover Python's fluent full-text chains and paginate statement order.
.PHONY: python-complex-query-check
python-complex-query-check: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_complex_query.ComplexQueryTest.test_public_fulltext_boolean_chain_builds_typed_ir

python-interface-unit-check: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_python_extractor packages.python.tests.test_python_natives
# python-coverage-case-check is the check of the helper coverage-runner-python (contracts/features.json): the unit test of
# the case runner that the Python coverage tests share.
.PHONY: python-coverage-case-check
python-coverage-case-check: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.coverage_case_test
# dbspec-python-check is the Python verification of schema_definition (contracts/features.json schema-python): the shared
# vectors of tests/dbspec (the recipe files, ddl.json, plan-cases.json and its SQLite apply chain, mermaid.json, show-create.json and
# set-files.json), the hashes and sets recipes, and the unit tests of syntax analysis, formatting and the set reader.
.PHONY: dbspec-python-check
dbspec-python-check: python-venv-check flowmark-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_dbspec_render_statements_none
	$(PYTHON_VENV)/bin/python -m packages.python.tests.dbspec_apply
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_render_physical_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_render_physical_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_render_physical_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_render_physical_markdown
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_set_decimal_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_set_decimal_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_set_decimal_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_set_decimal_markdown
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s packages/python/tests -t . -p 'test_dbspec_*.py'
dbspec-compare-check/prepare: typescript-current python-venv-check php-vendor-check
	$(READ_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_COMPARE_DOCUMENT))
	$(PUBLISH) $(DBSPEC_COMPARE_DOCUMENT) node tests/dbspec/stress.mts $(DBSPEC_COMPARE_TABLES)
	$(RUN_LONG) rust-build/dbspec_compare --cwd packages/rust -- $(CARGO_COPY) debug/examples/dbspec_compare debug/examples/dbspec_stress -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm-schema --example dbspec_compare --example dbspec_stress
	$(RUN_LONG) rust-build/dbspec_apply --cwd packages/rust -- $(CARGO_COPY) debug/examples/dbspec_apply -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --locked --offline -p polyspec-orm --example dbspec_apply
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)
dbspec-compare-check/runners: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PHP_MODE=extension ORM_PYTHON=$(PYTHON_VENV)/bin/python DBSPEC_STRESS_DOCUMENT=$(DBSPEC_COMPARE_DOCUMENT) $(NODE) --test tests/dbspec/compare/runners.test.mts
dbspec-compare-check/inputs: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PHP_MODE=extension ORM_PYTHON=$(PYTHON_VENV)/bin/python DBSPEC_STRESS_DOCUMENT=$(DBSPEC_COMPARE_DOCUMENT) $(NODE) --test tests/dbspec/inputs.test.mts
dbspec-compare-check/compare: dbspec-compare-check/prepare
	CARGO_TARGET_DIR=$(RUN_TARGET) POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) ORM_PHP_MODE=extension ORM_PYTHON=$(PYTHON_VENV)/bin/python $(NODE) tests/dbspec/compare/check.mts tests/dbspec $(DBSPEC_COMPARE_DOCUMENT) tests/dbspec/ddl.json tests/dbspec/plan-cases.json tests/dbspec/mermaid.json

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
	$(GO_TEST) ./packages/go/engine/dbspec -run '^TestStressDocument$$' -count=1
	$(GO_TEST) ./packages/go/engine/dbspec -run '^TestStressDocument$$' -count=1
dbspec-stress-bench/php: php-vendor-check dbspec-stress-bench/prepare php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecStressTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecStressTest.php
dbspec-stress-bench/php-introspect: php-vendor-check dbspec-stress-bench/prepare php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecIntrospectStressTest.php
dbspec-stress-bench/typescript: dbspec-stress-bench/prepare typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/dbspec-stress.mjs
	$(NODE) --test packages/ts/tests/dbspec-stress.mjs
dbspec-stress-bench/rust: dbspec-stress-bench/prepare
	$(RUN_LONG) rust-build/dbspec_stress --cwd packages/rust -- $(CARGO_COPY) release/examples/dbspec_stress -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) build --release --locked --offline -p polyspec-orm-schema --example dbspec_stress
	$(RUN_TARGET)/release/examples/dbspec_stress $(abspath $(DBSPEC_STRESS_DOCUMENT))
	$(RUN_TARGET)/release/examples/dbspec_stress $(abspath $(DBSPEC_STRESS_DOCUMENT))

.PHONY: dbspec-rust-check/documents dbspec-rust-check/set dbspec-rust-check/apply-cleanup dbspec-rust-check/unicode dbspec-rust-check/show-create dbspec-rust-check/render-physical
dbspec-rust-check: dbspec-rust-check/documents dbspec-rust-check/set dbspec-rust-check/apply-cleanup dbspec-rust-check/unicode dbspec-rust-check/show-create dbspec-rust-check/render-physical
dbspec-rust-check/documents: dbspec-rust-check/documents/runtime dbspec-rust-check/documents/recipes
.PHONY: dbspec-rust-check/documents/runtime dbspec-rust-check/documents/recipes
dbspec-rust-check/documents/runtime:
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- dbspec_runtime:: dbspec_model:: --nocapture
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- dbspec_runtime:: dbspec_model:: --nocapture
dbspec-rust-check/documents/recipes:
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- dbspec_render_statements_none:: dbspec_mermaid_none:: dbspec_dialect_refusal_none:: --nocapture
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- dbspec_render_statements_none:: dbspec_mermaid_none:: dbspec_dialect_refusal_none:: --nocapture
# dbspec-rust-check/set runs every file tree case of the recipe tests/dbspec/set-files.json through the set reader
# dbspec::read_set, every case of tests/dbspec/set-parse.json through dbspec::parse_set, and its unit cases of the normal form, the nested JSON and the schema value.
dbspec-rust-check/set: dbspec-rust-check/set/vectors dbspec-rust-check/set/unit
.PHONY: dbspec-rust-check/set/vectors dbspec-rust-check/set/unit
dbspec-rust-check/set/vectors: dbspec-rust-check/set/vectors/working-directory dbspec-rust-check/set/vectors/read
.PHONY: dbspec-rust-check/set/vectors/working-directory dbspec-rust-check/set/vectors/read
dbspec-rust-check/set/vectors/working-directory:
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test all -- dbspec_set_working_directory:: --nocapture
dbspec-rust-check/set/vectors/read:
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test all -- dbspec_read_set_none:: --nocapture
dbspec-rust-check/set/unit:
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-schema --lib dbspec::set -- --test-threads=1
# dbspec-rust-check/unicode checks that the Unicode word rune table written by Go (unicode_word.rs) matches the ranges at every code point.
dbspec-rust-check/unicode:
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-schema --lib dbspec::unicode_word -- --nocapture
dbspec-rust-check/apply-cleanup:
dbspec-rust-check/render-physical: flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- $(RECIPE_RUST_TEST) -p polyspec-orm-tests --test all -- dbspec_render_physical_mysql:: dbspec_render_physical_postgres:: dbspec_render_physical_sqlite:: dbspec_render_physical_markdown:: dbspec_set_decimal_mysql:: dbspec_set_decimal_postgres:: dbspec_set_decimal_sqlite:: dbspec_set_decimal_markdown::

.PHONY: dbspec-verify-errors-rust-check
dbspec-verify-errors-rust-check: lease-tool
	$(LEASE) hold $(CARGO_LEASES) exclusive --wait --pid $$PPID
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm-tests --test all -- --test-threads=1 dbspec_apply_verification_errors_none:: --nocapture

.PHONY: dbspec-verify-errors-check dbspec-verify-errors-php-extension-check
dbspec-verify-errors-check: dbspec-verify-errors-rust-check dbspec-verify-errors-php-extension-check php-vendor-check python-venv-check typescript-current
	$(READ_TYPESCRIPT)
	$(GO_TEST) ./packages/go/orm -run '^TestRecipeDbspecApplyVerificationErrorsNone$$' -count=1
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyVerificationErrorsRecipeTest.php
	$(PYTHON_TESTS) -- packages.python.tests.test_dbspec_apply_verification_errors_none
	$(NODE) --test packages/ts/tests/dbspec_apply_verification_errors-none.test.mjs
dbspec-verify-errors-php-extension-check: php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/dbspec-verify-errors-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecReleaseHooksTest.php; env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecApplyVerificationErrorsRecipeTestExtensionTest.php
# dbspec-rust-check/show-create checks that shown_checks (mysql.rs) reads every case of tests/dbspec/show-create.json with the expected body,
# and that the public MySQL introspection (read_catalog) reports, for each case of that catalog, the expected check, unsupported objects, and error.
dbspec-rust-check/show-create: dbspec-rust-check/show-create/unit dbspec-rust-check/show-create/vectors
.PHONY: dbspec-rust-check/show-create/unit dbspec-rust-check/show-create/vectors
dbspec-rust-check/show-create/unit:
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-schema --lib show_create_tests -- --test-threads=1
dbspec-rust-check/show-create/vectors:
	cd packages/rust && $(CARGO_TEST) dbspec-rust-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test all -- dbspec_show_create_introspect_none:: --nocapture

.PHONY: rust-send-savepoint-check
# The run directory of a part is that of the top target (if $@ contains a /, the directory gets one more level).
rust-send-savepoint-check/%: RUN_DIR = $(abspath .runtime/run)/rust-send-savepoint-check-$$PPID
rust-send-savepoint-check: rust-send-savepoint-check/clippy rust-send-savepoint-check/test
.PHONY: rust-send-savepoint-check/clippy rust-send-savepoint-check/test
rust-send-savepoint-check/clippy:
	$(RUN_LONG) rust-clippy/orm-lib --cwd packages/rust -- $(CARGO_LEASED) cargo +$(PHYSICAL_RUST_TOOLCHAIN) clippy --locked --offline -p polyspec-orm --lib -- -D warnings
rust-send-savepoint-check/test:
	mkdir -p $(RUN_DIR)
	$(WITH_TEST_ENV) cd packages/rust && ORM_SEND_SQLITE_DSN=$(SEND_SQLITE_DSN) $(CARGO_TEST) rust-send-savepoint-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib tx::send_tests:: -- --nocapture
	$(WITH_TEST_ENV) cd packages/rust && ORM_SEND_SQLITE_DSN=$(SEND_SQLITE_DSN) $(CARGO_TEST) rust-send-savepoint-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib tx::send_tests:: -- --nocapture
	rm -rf $(RUN_DIR)

.PHONY: dbspec-php-check
# dbspec-php-check runs twice each: the shared dbspec vectors, the PHP rules, the statement vectors of tests/dbspec/ddl.json,
# the plan vectors of tests/dbspec/plan-cases.json, the Mermaid vectors of tests/dbspec/mermaid.json, and the apply cleanup errors injected through a wrapped SQLite
# connection, each twice. The stress document is run by make
# bench.
dbspec-php-check: dbspec-php-check/documents dbspec-php-check/graph dbspec-php-check/behaviour dbspec-php-check/show-create-introspect dbspec-php-check/rules dbspec-php-check/manifest dbspec-php-check/render dbspec-php-check/plan dbspec-php-check/mermaid dbspec-php-check/apply-cleanup dbspec-php-check/unicode dbspec-php-check/show-create dbspec-php-check/analyze dbspec-php-check/set dbspec-php-check/set-parse
.PHONY: dbspec-php-check/documents dbspec-php-check/graph dbspec-php-check/behaviour dbspec-php-check/show-create-introspect dbspec-php-check/rules dbspec-php-check/manifest dbspec-php-check/render dbspec-php-check/plan dbspec-php-check/mermaid dbspec-php-check/apply-cleanup dbspec-php-check/unicode dbspec-php-check/show-create dbspec-php-check/analyze dbspec-php-check/set dbspec-php-check/set-parse
dbspec-php-check/documents: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecCatalogRowsTest.php
# dbspec-php-check/graph checks that a document, document set, plan list or unsupported list whose array holds another type is a TypeError.
dbspec-php-check/graph: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecGraphTest.php
# dbspec-php-check/behaviour checks the PHP behaviours that no shared vector fixes against fixtures/dbspec-behaviour.json, which
# php packages/php/testing/dbspec/behaviour.php records from the PHP library.
dbspec-php-check/behaviour: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecBehaviourTest.php
# dbspec-php-check/show-create-introspect reads the canned MySQL catalog of tests/dbspec/show-create.json through introspect.
dbspec-php-check/show-create-introspect: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecShowCreateIntrospectTest.php
dbspec-php-check/rules: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRulesTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRulesTest.php
dbspec-php-check/manifest: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/HashesRecipeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SetsRecipeTest.php
dbspec-php-check/render: php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRenderStatementsRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRenderPhysicalRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSetDecimalRecipeTest.php
dbspec-php-check/plan: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanTest.php
dbspec-php-check/mermaid: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecMermaidRecipeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecMermaidRecipeTest.php
dbspec-php-check/apply-cleanup: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyCleanupTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecApplyCleanupTest.php
# dbspec-php-check/unicode checks that the PHP UnicodeWord table matches its ranges at every code point (the table itself is matched to Go by dbspec-go-check/unicode).
dbspec-php-check/unicode: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecUnicodeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecUnicodeTest.php
# dbspec-php-check/show-create checks that MysqlCatalog::createChecks reads every case of tests/dbspec/show-create.json with the expected body.
# dbspec-php-check/analyze checks syntax analysis and format with focused cases and the analyze steps of the recipes (docs/spec/dbspec.md "Syntax analysis", "Formatting").
dbspec-php-check/analyze: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecAnalyzeTest.php
dbspec-php-check/show-create: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecShowCreateTest.php
# dbspec-php-check/set runs Dbspec::readSet on every case of the recipe tests/dbspec/set-files.json, each
# a temporary file tree with real symbolic and hard links (docs/spec/dbspec.md "Document sets").
dbspec-php-check/set: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecReadSetRecipeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSetTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SetReaderDiagnosticsTest.php
# dbspec-php-check/set-parse runs DbspecSetParseRecipeTest: every case of tests/dbspec/set-parse.json through Dbspec::parseSet
# (docs/spec/dbspec.md "Parsing a set").
dbspec-php-check/set-parse: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecSetParseRecipeTest.php

.PHONY: dbspec-php-extension-check
# dbspec-php-extension-check checks the PHP extension polyspec_orm (packages/php-ext), which implements the PHP client's dbspec surface and
# error codes in C under the client's own class names (Polyspec\Orm\Dbspec\*, Polyspec\Orm\Code; docs/spec/dbspec.md, DBS-172): it checks
# the names, the one stub and the stub hash of src/polyspec_orm_arginfo.h (make lint-php-ext), builds the extension with phpize in this
# run's directory, checks that its Reflection matches src/polyspec_orm.stub.php and the PHP client's public classes (DeclarationsTest), and
# runs the PHP client's tests (packages/php/tests) with the extension loaded; the test bootstrap fails a run that loaded any file of
# packages/php/src, so no fallback class stands in for the extension (packages/php/tests/extension_run_guard.php). A run that holds results of a whole document set runs twice. The build uses the phpize and
# php-config on PATH, which make orm-install-php-extension-tools checks; make packages/php-ext/src/polyspec_orm_arginfo.h rewrites the header from the stub.
PHP_EXTENSION_LIBRARY = $(RUN_DIR)/php-extension/polyspec_orm.so
# Kit's test-php-ext runner starts PHP children outside the invoking make recipe; expose the same built module to those children.
test-php-ext: export ORM_PHP_MODE = extension
test-php-ext: export POLYSPEC_ORM_EXTENSION ?= $(CURDIR)/var/php-ext/polyspec_orm.so
test-php-ext: export ORM_PHP_DYNAMIC_MODULES = $(PHP_EXTENSION_DYNAMIC_MODULES)
# The extension target owns the native package tests, less the classes of the database mariadb, which need the MariaDB servers
# and which mariadb-recipes-check/php-extension runs.
PHP_EXTENSION_NATIVE_CASES = ^Polyspec\\Orm\\Extension\\Tests\\(?!(?:MermaidErrorBoundaryTest::|ParentSlotExpansionNativeTest::|MarkdownConformanceNativeTest::|\w*Mariadb\w*::))
test-php-ext: export CASES ?= $(PHP_EXTENSION_NATIVE_CASES)
# PHP_EXTENSION_TESTS runs PHPUnit files of packages/php with the extension loaded, through kit's run-tests, which gives each test
# its own timeout (K436); the test bootstrap fails either extension PHPUnit command that loads a userland fallback (T182-6-19).
PHP_EXTENSION_TESTS = env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) -- --configuration packages/php/phpunit.xml.dist
PHP_EXTENSION_NATIVE_TESTS = env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) -- --configuration packages/php-ext/phpunit.xml.dist
PHP_CODEC_CAUSE_TEST_FILTER = testCodecExpectedExceptionCause|testYamlParseKeepsThePositionOfTheReader|testCodecUnexpectedThrowableIdentity
PHP_CODEC_CAUSE_NATIVE_FILTER = testCodecExpectedExceptionCause|testYamlParseKeepsThePositionOfTheReader|testCodecUnexpectedThrowableIdentity
PHP_CODEC_CAUSE_NATIVE_YAML_FILTER = testYamlExpectedCauseIdentity|testYamlEveryLibraryThrowableIsItsRule
.PHONY: php-codec-causes-check
php-codec-causes-check: php-models build-php-ext
	@set -eu; \
	status=0; \
	if env ORM_PHP_MODE=library $(RUN_TESTS) phpunit --timeout 300 -- --configuration packages/php/phpunit.xml.dist --filter '$(PHP_CODEC_CAUSE_TEST_FILTER)' packages/php/tests/CodecErrorCauseTest.php; then :; else status=1; fi; \
	if env ORM_PHP_MODE=library $(RUN_TESTS) phpunit --timeout 300 -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecYamlCauseTest.php; then :; else status=1; fi; \
	if env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --timeout 300 --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php/phpunit.xml.dist --filter '$(PHP_CODEC_CAUSE_NATIVE_FILTER)' packages/php/tests/CodecErrorCauseTest.php; then :; else status=1; fi; \
	if env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --timeout 300 --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist --filter '$(PHP_CODEC_CAUSE_NATIVE_YAML_FILTER)' packages/php-ext/tests/CodecCauseTest.php; then :; else status=1; fi; \
	exit "$$status"
dbspec-php-extension-check/%: RUN_DIR = $(if $(DBSPEC_PHP_EXTENSION_CHILD_RUN_DIR),$(DBSPEC_PHP_EXTENSION_CHILD_RUN_DIR),$(abspath .runtime/run)/dbspec-php-extension-check-$$PPID)
dbspec-php-extension-check/analyze: DBSPEC_PHP_EXTENSION_CHILD_RUN_DIR = $(abspath .runtime/run)/dbspec-php-extension-check-analyze-$$PPID
.PHONY: dbspec-php-extension-check/arginfo dbspec-php-extension-check/prepare dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/sets dbspec-php-extension-check/render dbspec-php-extension-check/graph dbspec-php-extension-check/behaviour dbspec-php-extension-check/schema-definition dbspec-php-extension-check/analyze dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup dbspec-php-extension-check/plan-apply dbspec-php-extension-check/show-create dbspec-php-extension-check/set dbspec-php-extension-check/set-parse dbspec-php-extension-check/codec dbspec-php-extension-check/code-catalog dbspec-php-extension-check/aes dbspec-php-extension-check/planner dbspec-php-extension-check/executor
DBSPEC_PHP_EXTENSION_PARTS = dbspec-php-extension-check/arginfo dbspec-php-extension-check/introspect-messages-recipe dbspec-php-extension-check/declarations dbspec-php-extension-check/vectors dbspec-php-extension-check/sets dbspec-php-extension-check/render dbspec-php-extension-check/graph dbspec-php-extension-check/behaviour dbspec-php-extension-check/schema-definition dbspec-php-extension-check/limits dbspec-php-extension-check/rules-recipe dbspec-php-extension-check/dialect-refusal dbspec-php-extension-check/load-set dbspec-php-extension-check/default-select-set dbspec-php-extension-check/runtime-model-plans dbspec-php-extension-check/runtime-model-entities dbspec-php-extension-check/analyze dbspec-php-extension-check/plan dbspec-php-extension-check/mermaid dbspec-php-extension-check/apply-cleanup dbspec-php-extension-check/plan-apply dbspec-php-extension-check/show-create dbspec-php-extension-check/set dbspec-php-extension-check/set-parse dbspec-php-extension-check/codec dbspec-php-extension-check/code-catalog dbspec-php-extension-check/aes dbspec-php-extension-check/planner dbspec-php-extension-check/executor
.PHONY: dbspec-php-extension-check
dbspec-php-extension-check:
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	status=0; \
	if $(MAKE) --no-print-directory -k RUN_DIR="$$run_dir" DBSPEC_PHP_EXTENSION_SHARED_RUN=1 $(DBSPEC_PHP_EXTENSION_PARTS); then :; else status=$$?; fi; \
	exit "$$status"
dbspec-php-extension-check/arginfo:
	$(NODE) $(KIT)/php-extension.$(KIT_EXT) check --extension packages/php-ext --build-dir var/php-ext --skip vendor --skip node_modules --library packages/php
dbspec-php-extension-check/prepare:
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)
# Builds the extension in an isolated run directory and executes only its native Collection unit cases.
collection-php-extension-check: RUN_DIR = $(abspath .runtime/run)/collection-php-extension-check-$$PPID php-models
COLLECTION_TEST_FILTER ?=
.PHONY: collection-php-extension-check
collection-php-extension-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CollectionTest.php $(if $(COLLECTION_TEST_FILTER),--filter '$(COLLECTION_TEST_FILTER)',); \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(PHP_EXTENSION_DYNAMIC_MODULES)' POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testDeclarations|testClient|testRequiredModules' packages/php-ext/tests/DeclarationsTest.php; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CollectionIdentityTest.php

# Runs the native Model helper surface cases against a fresh extension build; the source-library comparison is a separate PHPUnit run.
model-types-php-extension-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-types-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelTypesSurfaceTest.php packages/php-ext/tests/PlanCacheBoundNativeTest.php packages/php-ext/tests/PlanCacheMemoryNativeTest.php; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testPlanCacheRetainsAtMostTheBoundOfPlaceholders|testPlanCacheRetainsAtMostAFewMibOfPlans|testPlanCachePromotesHitsAndEvictsTheLeastRecentlyUsedPlan|testStatementCacheRetainsAtMostTheBoundOfPlaceholders|testStatementCacheRetainsAtMostAFewMibOfStatements' packages/php/tests/PlanCacheMemoryTest.php; \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(PHP_EXTENSION_DYNAMIC_MODULES)' POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DeclarationsTest.php; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelTypesSourceTest.php packages/php/tests/FuncSourceAdapterTest.php

# Exercises native model query assembly and write round trips on an owned SQLite in-memory database.
.PHONY: model-query-write-php-extension-unit-check
MODEL_QUERY_WRITE_TEST_FILTER ?= testNativeModel|testConformanceChildLoadsTheNativeModelEntrypoint
model-query-write-php-extension-unit-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-query-write-php-extension-unit-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelQueriesWritesNativeTest.php --filter '$(MODEL_QUERY_WRITE_TEST_FILTER)'

# Runs the extension-mode model fixtures required by T182-6, using the same fixture cases as the PHP owner tests.
T182_MODEL_TEST_FILTER ?=
t182-php-extension-model-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/t182-php-extension-model-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageNativeFixtureExtensionTest.php $(if $(T182_MODEL_TEST_FILTER),--filter '$(T182_MODEL_TEST_FILTER)',)

# Runs the changed-database installation fixture through the native extension on each configured database.
t182-php-extension-schema-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/t182-php-extension-schema-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testSchemaSetEditedManifest' packages/php-ext/tests/CoverageSchemaInstallNativeTest.php

# Runs the complete native Model surface and its native helper classes against a fresh extension; generated PHP models use their normal bootstrap.
# MODEL_NATIVE_TEST_FILTER=testNativeSqliteRoundTrip selects only the server-free decimal native SQLite owner case.
.PHONY: model-native-php-extension-check
MODEL_NATIVE_TEST_FILTER ?=
model-native-php-extension-check: php-vendor-check php-model-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-native-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelNativeTest.php packages/php-ext/tests/MarkdownNativeTest.php packages/php-ext/tests/AuditLazyFakePdoTest.php packages/php-ext/tests/ModelDslNativeTest.php packages/php-ext/tests/ModelReadNativeTest.php packages/php-ext/tests/ModelWriteSurfaceTest.php packages/php-ext/tests/ModelAssemblyTest.php packages/php-ext/tests/ModelStreamReadTest.php packages/php-ext/tests/RuntimeModelTest.php packages/php-ext/tests/ChainNativeSurfaceTest.php packages/php-ext/tests/RegistrySchemaNativeTest.php packages/php-ext/tests/PlanCacheMemoryNativeTest.php packages/php-ext/tests/DecimalModelSqliteNativeTest.php $(if $(MODEL_NATIVE_TEST_FILTER),packages/php/tests/PlanCacheMemoryTest.php,) $(if $(MODEL_NATIVE_TEST_FILTER),--filter '$(MODEL_NATIVE_TEST_FILTER)',); \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(PHP_EXTENSION_DYNAMIC_MODULES)' POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testDeclarations|testClient|testRequiredModules' packages/php-ext/tests/DeclarationsTest.php; \
	if [ -z '$(MODEL_NATIVE_TEST_FILTER)' ]; then env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php packages/php/tests/ModelTypesSourceTest.php; fi

# Runs the native root-IN chunking and composite-key probes against in-memory SQLite.
.PHONY: model-chunk-composite-native-php-extension-check
model-chunk-composite-native-php-extension-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/model-chunk-composite-native-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'test_root_in_chunks_use_native_model_queries_and_reject_unmergeable_pages|testSplitRootInCountPlansNoStatementOverTheBindLimit|test_composite_relation_keys_split_and_pad_to_bind_safe_size_classes' packages/php-ext/tests/ParameterChunkingNativeTest.php

# Runs focused grouped-result decoder and native GroupRow count units through the PHP extension.
.PHONY: group-count-boolean-php-extension-unit-check
group-count-boolean-php-extension-unit-check: php-vendor-check php-model-check
	@set -eu; \
	run_dir="$(abspath .runtime/run)/group-count-boolean-php-extension-unit-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelAssemblyTest.php --filter 'testGroupRowPreservesTypedValuesAndChecksItsCount|testGroupRowDriverCellForms'

# Runs the exact i64 grouped result decode and assembly test with the checkout's target lease.
# Runs the GroupRow count decoder unit with the checkout's target lease.
.PHONY: group-row-count-rust-unit-check
group-row-count-rust-unit-check:
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) group-row-count-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --manifest-path packages/rust/Cargo.toml --locked --offline --workspace --features "$(ORM_RUST_TEST_FEATURES)" -p polyspec-orm --lib collection::group_tests::driver_cell_forms -- --test-threads=1 --exact

# Runs grouped-boolean, exact i64, and row-count contract cases through each native result path.
group-count-boolean-unit-check: lease-tool php-vendor-check php-model-check python-venv-check typescript-read php-models
	@set +e; status=0; last_result=0; \
	run_case() { label=$$1; shift; printf '[group-result] %s\n' "$$label"; "$$@"; last_result=$$?; printf '[group-result] %s exit %s\n' "$$label" "$$last_result"; if [ "$$last_result" -ne 0 ]; then status=1; fi; return 0; }; \
	run_case go $(GO_TEST) ./packages/go/orm -run '^(TestGroupRowDriverCellForms)$$' -count=1; \
	run_case php env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/GroupRowsTest.php --filter 'testGroupRowPreservesTypedValuesAndChecksItsCount|testGroupRowDriverCellForms'; \
	run_case php-extension $(MAKE) --no-print-directory group-count-boolean-php-extension-unit-check; \
	run_case typescript $(NODE) --test --test-name-pattern='group_rows/driver_cell_forms' packages/ts/tests/group_rows.mjs; \
	run_case python-count $(PYTHON_VENV)/bin/python -m packages.python.tests.test_group_rows GroupRowDriverCellFormsTest.test_driver_cell_forms; \
	run_case rust-count $(MAKE) --no-print-directory group-row-count-rust-unit-check; \
	exit "$$status"

# dbspec-php-extension-check/declarations runs the extension's own checks (packages/php-ext/tests): its declarations against the stub and the
# PHP client, its required modules and its PIE package.
# dbspec-php-extension-check/silent-paths runs silent_paths.php with the extension alone (php -n, no library class): a call that must fail with an OrmException must throw, not return silently (T182-2-4).
dbspec-php-extension-check/silent-paths: dbspec-php-extension-check/prepare
	$(CURDIR)/var/tools/bin/php -n -d extension=$(PHP_EXTENSION_LIBRARY) packages/php-ext/tests/silent_paths.php
# dbspec-php-extension-check/statement-event runs StatementEventSurfaceTest with the extension loaded: the class is the extension's own (KSTD-7-1).
dbspec-php-extension-check/statement-event: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php-ext/tests/StatementEventSurfaceTest.php
# PHP_EXTENSION_DYNAMIC_MODULES, passed as ORM_PHP_DYNAMIC_MODULES, lists the modules that php -n loads from extension_dir, comma separated: pdo, which the extension requires,
# when the PHP that the recipes and test-php-ext run ($(KIT_TOOLS)/bin/php, which toolCommand finds first) has it only as a shared module, as on Ubuntu; empty when
# it is built in. DeclarationsTest reads it, and adds pdo_pgsql itself (T296).
PHP_EXTENSION_DYNAMIC_MODULES = $(shell $(KIT_TOOLS)/bin/php -n -r 'echo extension_loaded("pdo") ? "" : "pdo";')
dbspec-php-extension-check/declarations: php-vendor-check dbspec-php-extension-check/prepare
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(PHP_EXTENSION_DYNAMIC_MODULES)' POLYSPEC_ORM_EXTENSION="$(PHP_EXTENSION_LIBRARY)" $(RUN_TESTS) phpunit --php-extension "$(PHP_EXTENSION_LIBRARY)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DeclarationsTest.php
# dbspec-php-extension-check/vectors runs DbspecTest with the extension: the canonical, normalize, invalid, files, positions, bytes and arguments cases of the recipes (tests/dbspec/canonical.json, normalize.json, invalid.json, files.json, positions.json), introspection and apply on SQLite.
dbspec-php-extension-check/vectors: php-vendor-check dbspec-php-extension-check/prepare
# dbspec-php-extension-check/sets runs the hashes and sets recipes with the extension: tests/dbspec/hashes.json and sets.json.
dbspec-php-extension-check/sets: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/HashesRecipeTestExtensionTest.php
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/SetsRecipeTestExtensionTest.php
# dbspec-php-extension-check/render runs the rendered statements recipe with the extension: the statements of tests/dbspec/ddl.json.
dbspec-php-extension-check/render: php-vendor-check dbspec-php-extension-check/prepare flowmark-check
	$(WITH_TEST_ENV) $(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecRenderStatementsRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) $(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecRenderPhysicalRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) $(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecSetDecimalRecipeTestExtensionTest.php
# dbspec-php-extension-check/graph runs DbspecGraphTest with the extension: the TypeError of a document or plan whose array holds another type.
dbspec-php-extension-check/graph: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecGraphTest.php
# dbspec-php-extension-check/behaviour runs DbspecBehaviourTest with the extension: the PHP behaviours of fixtures/dbspec-behaviour.json, Names among them.
dbspec-php-extension-check/behaviour: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecBehaviourTest.php
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecBehaviourNativeTest.php
# dbspec-php-extension-check/schema-definition runs SchemaDefinitionRecipeTestExtensionTest with the extension: the cases of tests/dbspec/schema-definition.json.
dbspec-php-extension-check/schema-definition: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/SchemaDefinitionRecipeTestExtensionTest.php

# dbspec-php-extension-check/limits runs DbspecLimitsRecipeTestExtensionTest with the extension: the cases of tests/dbspec/limits.json.
dbspec-php-extension-check/limits: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecLimitsRecipeTestExtensionTest.php

# dbspec-php-extension-check/introspect-messages-recipe runs DbspecIntrospectMessagesRecipeTestExtensionTest with the extension: the cases of tests/dbspec/introspect-messages.json.
dbspec-php-extension-check/introspect-messages-recipe: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecIntrospectMessagesRecipeTestExtensionTest.php

# dbspec-php-extension-check/rules-recipe runs DbspecRulesRecipeTestExtensionTest with the extension: the cases of tests/dbspec/rules.json.
dbspec-php-extension-check/rules-recipe: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecRulesRecipeTestExtensionTest.php

# dbspec-php-extension-check/dialect-refusal runs DbspecDialectRefusalRecipeTestExtensionTest with the extension: the cases of tests/dbspec/dialect-refusal.json.
dbspec-php-extension-check/dialect-refusal: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecDialectRefusalRecipeTestExtensionTest.php

# dbspec-php-extension-check/load-set runs DbspecLoadSetRecipeTestExtensionTest with the extension: the cases of tests/dbspec/load-set.json.
dbspec-php-extension-check/load-set: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecLoadSetRecipeTestExtensionTest.php

# dbspec-php-extension-check/default-select-set runs DefaultSelectSetRecipeTestExtensionTest with the extension: the cases of tests/planner/default-select-set.json.
dbspec-php-extension-check/default-select-set: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DefaultSelectSetRecipeTestExtensionTest.php

# dbspec-php-extension-check/runtime-model-plans runs RuntimeModelPlansRecipeTestExtensionTest with the extension: the cases of tests/planner/runtime-model.json.
dbspec-php-extension-check/runtime-model-plans: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/RuntimeModelPlansRecipeTestExtensionTest.php

# dbspec-php-extension-check/runtime-model-entities runs RuntimeModelEntitiesRecipeTestExtensionTest with the extension: the cases of tests/dbspec/runtime-model.json.
dbspec-php-extension-check/runtime-model-entities: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/RuntimeModelEntitiesRecipeTestExtensionTest.php

# dbspec-php-extension-check/analyze runs DbspecAnalyzeTest with the extension: the syntax analysis and format of the focused cases and of the limit errors, the analyze steps of the recipes (hashes.json, sets.json) run in their own recipe tests; DbspecRulesNativeTest checks the global column and foreign-key limits through the native parser.
dbspec-php-extension-check/analyze: php-vendor-check dbspec-php-extension-check/prepare
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	if [ -z '$(DBSPEC_PHP_EXTENSION_SHARED_RUN)' ]; then trap 'rm -rf "$$run_dir"' EXIT; fi; \
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecAnalyzeTest.php; \
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecAnalyzeTest.php; \
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecRulesNativeTest.php
# dbspec-php-extension-check/plan runs DbspecPlanTest with the extension: the plan vectors of tests/dbspec/plan-cases.json.
dbspec-php-extension-check/plan: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecPlanTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecPlanTest.php
# dbspec-php-extension-check/mermaid runs DbspecMermaidRecipeExtensionTest with the extension: the Mermaid recipe.
dbspec-php-extension-check/mermaid: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecMermaidRecipeExtensionTest.php
# dbspec-php-extension-check/apply-cleanup runs DbspecApplyCleanupTest with the extension: the cleanup errors of apply after a failing PDO.
dbspec-php-extension-check/apply-cleanup: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecApplyCleanupTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecApplyCleanupTest.php
# dbspec-php-extension-check/plan-apply runs DbspecPlanApplyTest with the extension: every plan case of tests/dbspec/plan-cases.json applied to MySQL, PostgreSQL and SQLite.
dbspec-php-extension-check/plan-apply: php-vendor-check dbspec-php-extension-check/prepare
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/DbspecPlanApplyTest.php
# dbspec-php-extension-check/show-create runs DbspecShowCreateIntrospectTest with the extension: introspection of the canned MySQL catalog of tests/dbspec/show-create.json.
dbspec-php-extension-check/show-create: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecShowCreateIntrospectTest.php
# dbspec-php-extension-check/set runs the recipe tests/dbspec/set-files.json and DbspecSetTest with the extension: Dbspec::readSet on every case.
dbspec-php-extension-check/set: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecReadSetRecipeTestExtensionTest.php
	$(PHP_EXTENSION_TESTS) packages/php/tests/DbspecSetTest.php
# dbspec-php-extension-check/codec runs the codec recipe tests/codec/codec.json through the extension's codec (docs/spec/codec.md COD-40).
dbspec-php-extension-check/codec: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/CodecRecipeTestExtensionTest.php
# dbspec-php-extension-check/code-catalog runs CodeCatalogTest with the extension: the codes of docs/spec/errors.yaml against Code.php, and the
# class that the extension registers as Polyspec\Orm\Code, which must hold the same codes.
dbspec-php-extension-check/code-catalog: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_TESTS) packages/php/tests/CodeCatalogTest.php
# dbspec-php-extension-check/aes runs CodecErrorCauseTest with the extension: a codec error keeps the native error as its cause.
dbspec-php-extension-check/aes: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/CodecErrorCauseTestExtensionTest.php
# dbspec-php-extension-check/set-parse runs DbspecSetParseRecipeTestExtensionTest with the extension: every case of tests/dbspec/set-parse.json.
dbspec-php-extension-check/set-parse: php-vendor-check dbspec-php-extension-check/prepare
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/DbspecSetParseRecipeTestExtensionTest.php
# dbspec-php-extension-check/planner runs the planner suites with the extension: PlannerCompileTestExtensionTest
# (the compile recipe tests/planner/compile.json) and InsertPartsTest (contracts/fixtures/insert_parts.json).
# It first checks that the extension registers Polyspec\Orm\Planner: its class is internal, so the planner the suites run is C.
dbspec-php-extension-check/planner: dbspec-php-extension-check/planner/compile dbspec-php-extension-check/planner/insert-parts

# The planner parts are independent: each runs as its own target after the class check, so make -j runs them together.
dbspec-php-extension-check/planner/internal: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) -r 'exit((new ReflectionClass("Polyspec\\Orm\\Planner"))->isInternal() ? 0 : 1);'
dbspec-php-extension-check/planner/compile: php-vendor-check dbspec-php-extension-check/planner/internal
	$(PHP_EXTENSION_NATIVE_TESTS) packages/php-ext/tests/PlannerCompileTestExtensionTest.php
dbspec-php-extension-check/planner/insert-parts: php-vendor-check dbspec-php-extension-check/planner/internal
	$(PHP_EXTENSION_TESTS) packages/php/tests/InsertPartsTest.php

# Runs only the native PHP extension TLS handshake and rejection cases on the configured MySQL TLS server.
mysql-tls-php-extension-check: RUN_DIR = $(abspath .runtime/run)/mysql-tls-php-extension-check-$$PPID
mysql-tls-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DsnConnectionRecipeTestExtensionTest.php --filter mysql_tls

# Runs the native PHP extension MySQL session test file, whose case is the PostgreSQL session startup parameters (CFG-7).
mysql-session-php-extension-check: RUN_DIR = $(abspath .runtime/run)/mysql-session-php-extension-check-$$PPID
mysql-session-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/MysqlSessionNativeTest.php

# Runs the TypeScript CFG-4/CFG-5 live pool-bound cases on SQLite, MySQL and PostgreSQL.
connection-pool-resource-bounds-typescript-check: typescript-read
	$(WITH_TEST_ENV) $(NODE) --test packages/ts/tests/pool_bounds.mjs

# Runs CFG-2 through the PHP extension's native Orm::connect with generated model fixtures.
connection-utc-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/connection-utc-php-extension-check-$$$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testNativeStyledSqlNullIsPreservedOnDatabaseRead|testNativeI16ValuesAndDefaults' packages/php-ext/tests/ConnectionUtcNativeTest.php

# dbspec-php-extension-check/executor runs the suites of the connection, the statement path and the transactions with the extension
# loaded: StatementFaultTest (statement-fault), DsnTest::testSqlitePath (sqlite-paths) and DsnTest::testParse, which holds the tuples and refusal texts of the C parser. It first checks that the extension registers Polyspec\Orm\Db: its class is
# internal, so the connection the suites open is C. The database suites need make orm-test-servers first (WITH_TEST_ENV).
dbspec-php-extension-check/executor: php-vendor-check dbspec-php-extension-check/prepare
	php -d extension=$(PHP_EXTENSION_LIBRARY) -r 'require "vendor-php/autoload.php"; exit((new ReflectionClass("Polyspec\\Orm\\Db"))->isInternal() ? 0 : 1);'
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/StatementFaultTest.php
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/DsnTest.php --filter 'testSqlitePath|testParse'
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/ModelTest.php --filter 'testTransactions'

# repo-check checks that the paths that the root npm script uses are tracked files or
# directories, that the CI workflow starts servers with make orm-test-servers, and that every variable of that environment file is given
# to the check steps (scripts/repo/ci.mts).

# comment-language-check fails on a Hangul character in a comment of a tracked code file, naming the file and
# line. Each language's comments come from its own lexer (scripts/comments/check.mts), and strings are not comments.
comment-language-check: comment-language-check/unit comment-language-check/run
comment-language-check/unit:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 scripts/comments/check.test.mts
comment-language-check/run:
	$(NODE) scripts/comments/check.mts

repo-check: repo-check/unit repo-check/run
repo-check/unit:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 scripts/repo/check.test.mts scripts/repo/python-venv.test.mts scripts/repo/worktree-stop.test.mts
repo-check/run:
	$(NODE) scripts/repo/check.mts

makefile-pinned-node-recipes-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 tests/repo/pinned-node-recipes.test.mts

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
	$(MAKE) -s $(LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) $(NODE) --test scripts/test-servers.test.mts scripts/test-servers-mysql.test.mts

orm-test-servers:
	$(BUILD_STOP_PROCESS)
	$(MAKE) -s $(LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) $(NODE) scripts/test-servers.mts start

# make orm-install-mariadb builds the MariaDB of the test servers from its pinned source release into var/mariadb (scripts/mariadb-build.mts).
.PHONY: orm-install-mariadb orm-test-mariadb
orm-install-mariadb:
	$(ONLINE) $(NODE) scripts/mariadb-build.mts
orm-test-mariadb:
	$(BUILD_STOP_PROCESS)
	$(MAKE) -s $(LEASE)
	PATH="$(MARIADB_BIN):$$PATH" LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) $(NODE) scripts/test-servers.mts mariadb-start

# The recipe targets of every database run one case at a time in every runtime (docs/spec/dialects.md DIA-212): the cases of
# a recipe create and drop databases, and DDL of two cases at once on MariaDB can leave a trigger backup that fails a later
# DROP DATABASE, so no database runs two cases of a recipe target at once. Go, Python and PHP run the cases of a target in
# order; RECIPE_TS_TEST runs the files of a TypeScript target one at a time, each group of a recipe of the Rust programs
# runs its trials one at a time (Group::recipe), and RECIPE_RUST_TEST runs every test target of a Rust recipe target to its
# end (--no-fail-fast); the suites run the files of a recipe one at a time after their other files (scripts/suite-test.mts).
# A case whose subject is concurrency, such as concurrent sessions or a lock wait, makes its concurrency inside the case.
RECIPE_TS_TEST = $(NODE) --test --test-concurrency=1
RECIPE_RUST_TEST = cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --no-fail-fast

# mariadb-recipes-check/<runtime> runs every recipe entry of the database mariadb of one runtime on the MariaDB servers of make
# orm-test-mariadb (FCV-3, DIA-200), each the target of the CI group mariadb_<runtime>; a runner of the MySQL servers cannot hold
# them (scripts/ci/server-programs.mts), so no target of those servers runs an entry of mariadb. An entry is a test of its own:
# Test<Name>Mariadb of packages/go/orm and packages/go/internal/testdb, the recipe entries TestRecipe<Name>Mariadb among them,
# which the Go lane of client-db (GO_LANE_SKIP) and go-test-check skip; <recipe>-mariadb.test.mjs and the PHP class
# <Name>Mariadb..., which the suites leave to these targets (scripts/suite-test.mts) and the extension's unit run does not
# select (PHP_EXTENSION_NATIVE_CASES); the Python module <recipe>_mariadb, which no test_*.py discovery finds; and the module
# <recipe>_mariadb of the Rust program mariadb, which a plain cargo test does not run (test = false). Each target fails when one
# of its entries fails. They run their cases one at a time, as the recipe targets of every database do (RECIPE_TS_TEST).
# The recipe list of a runtime is its entries of the database mysql, and its entries of mariadb are the same recipes on mariadb:
# a recipe that runs on mysql runs on mariadb, a server of the MySQL dialect (DIA-200), so an entry of mysql without its
# entry of mariadb fails the target rather than leaving the recipe out. node --test takes a path that matches no file as a
# pattern that matches nothing and passes, so the TypeScript target looks for each entry before it runs them.
MARIADB_TS_ENTRIES = $(patsubst %-mysql.test.mjs,%-mariadb.test.mjs,$(sort $(wildcard packages/ts/tests/*-mysql.test.mjs)))
MARIADB_PY_ENTRIES = $(patsubst packages/python/tests/test_%_mysql.py,packages.python.tests.%_mariadb,$(sort $(wildcard packages/python/tests/test_*_mysql.py)))
.PHONY: mariadb-recipes-check/go mariadb-recipes-check/rust mariadb-recipes-check/typescript mariadb-recipes-check/python mariadb-recipes-check/php mariadb-recipes-check/php-extension
mariadb-recipes-check/go: lease-tool
	$(WITH_MARIADB_ENV) $(GO_TEST) ./packages/go/orm ./packages/go/internal/testdb -run '^Test[A-Za-z]*Mariadb$$' -count=1
mariadb-recipes-check/rust: lease-tool
	$(WITH_MARIADB_ENV) cd packages/rust && $(CARGO_TEST) mariadb-recipes-check -- $(RECIPE_RUST_TEST) --test mariadb
mariadb-recipes-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	missing=0; for entry in $(MARIADB_TS_ENTRIES); do test -f $$entry || { echo "$$entry is missing: a recipe of mysql runs on mariadb (DIA-200)" >&2; missing=1; }; done; exit $$missing
	$(WITH_MARIADB_ENV) $(RECIPE_TS_TEST) $(MARIADB_TS_ENTRIES)
mariadb-recipes-check/python: lease-tool python-venv-check
	$(WITH_MARIADB_ENV) { status=0; for entry in $(MARIADB_PY_ENTRIES); do $(PYTHON_VENV)/bin/python -m $$entry || status=1; done; exit $$status; }
mariadb-recipes-check/php: lease-tool php-vendor-check php-models
	$(WITH_MARIADB_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter '::testMariadb'
mariadb-recipes-check/php-extension: lease-tool php-vendor-check build-php-ext
	$(WITH_MARIADB_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist --filter '::testMariadb'

# The dialect-facts probe needs its own writable MySQL server with binary logging and trust-function-creators disabled.
.PHONY: orm-test-mysql-privilege-start
orm-test-mysql-privilege-start:
	$(BUILD_STOP_PROCESS)
	$(MAKE) -s $(LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) $(NODE) scripts/test-servers.mts mysql-privilege-start

# make orm-test-servers-tls loads the TLS files of the MySQL TLS cases into running
# servers and writes their DSNs into TEST_ENV; make orm-test-servers does it at the
# start.
orm-test-servers-tls:
	$(NODE) scripts/test-servers.mts tls

orm-test-servers-stop:
	$(BUILD_STOP_PROCESS)
	$(MAKE) -s $(LEASE)
	LEASE=$(LEASE) STOP_PROCESS=$(STOP_PROCESS) $(NODE) scripts/test-servers.mts stop

# worktree-remove WORKTREE=<path> removes a worktree of this repository: it first stops the servers that run from the
# .runtime/servers of that worktree (its make orm-test-servers-stop, which knows them by their pid files), since a server
# whose data directory is removed under it never exits, and then runs git worktree remove.
.PHONY: worktree-remove
worktree-remove:
	@test -n "$(WORKTREE)" || { echo "usage: make worktree-remove WORKTREE=<path>" >&2; exit 2; }
	@if test -d "$(WORKTREE)/.runtime/servers"; then $(MAKE) -C "$(WORKTREE)" orm-test-servers-stop; fi
	git worktree remove "$(WORKTREE)"

# orm-test-servers-leases lists the lease holders of the servers, and orm-test-servers-leases-clear, when a holder process is gone,
# deletes dead leases (those whose holder and releaser have both ended) and records what it deleted. A dead lease may also be taken by the next request (tests/lease).
SERVERS_LEASES = $(abspath .runtime/servers.leases)
orm-test-servers-leases:
	$(MAKE) -s $(LEASE)
	$(LEASE) list $(SERVERS_LEASES)

orm-test-servers-leases-clear:
	$(MAKE) -s $(LEASE)
	$(LEASE) clear-dead $(SERVERS_LEASES)

# feature-unit-check checks that the feature documents match the manifest, and runs the unit tests of coverage and owner selection.
# feature-check (feature-performance-check, feature-verify-rust, feature-verify-other) builds the TypeScript client once and then runs
# the performance measurement and the verification commands, which use the built client. The recipe tests of the features run in
# the suites of their runtimes (suite-<runtime>-check and the whole runs of Go, Rust and the PHP extension); feature-coverage-of/<id>
# runs those of one feature.
# The helper checks
# are run by feature-helper-check and the stress targets (feature-stress-mysql-check, feature-stress-pg-sqlite-check). One feature
# is run with `node scripts/features/coverage.mts --feature <id>` and `node scripts/features/check.mts --run --feature <id>`
# under the test environment, as owner-check does.
# feature-owner-check takes the changed files (PATHS, or else the files changed from HEAD and the untracked files) as input, and runs only
# the verification commands and coverage of the features that declare those files, and only the targets that contracts/check-inputs.json declares as scope owners
# (AGENTS.md "Owner checks"). The run uses its own test server environment and databases.
# make owner-check, which runs the owner-check utility of @polyspec/kit, passes this target the paths that changed under the rules of
# config/owner-checks.json.
# The Python owners import the slot models that ORM_PYTHON_BIND_MODELS names (the markdown.builder and bind steps), as the
# coverage of a feature does.
.PHONY: feature-owner-check
feature-owner-check: orm-codes bind-python-models
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_PYTHON_BIND_MODELS=$(BIND_PY_MODELS) node scripts/features/owners.mts $(PATHS)

feature-unit-check: feature-unit-check/docs feature-unit-check/coverage feature-unit-check/owners feature-unit-check/select
feature-unit-check/docs:
	$(NODE) scripts/features/build.mts --check
feature-unit-check/coverage:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 scripts/features/coverage.test.mts scripts/features/languages.test.mts scripts/features/performance-reference.test.mts scripts/features/recipes.test.mts
feature-unit-check/owners:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 scripts/features/owners.test.mts scripts/features/manifest.test.mts
feature-unit-check/select: lease-tool
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 scripts/features/select.test.mts scripts/features/typescript-lease.test.mts

# recipe-keys-check checks that the key table of the recipe format is the one its schema makes, and runs the unit tests of the
# generator (T334-3-5-6). recipe-unknown-key-check runs the refusal test of every runner's loader, which must run at least one test.
.PHONY: recipe-keys-check recipe-unknown-key-check recipe-unknown-key-check/go recipe-unknown-key-check/typescript recipe-unknown-key-check/python recipe-unknown-key-check/php recipe-unknown-key-check/rust recipe-unknown-key-check/php-extension
recipe-keys-check:
	$(NODE) scripts/features/recipe-keys.mts --check
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 scripts/features/recipe-keys.test.mts
# recipe-runners-check checks that each runtime has one recipe runner (FCV-15), and runs the unit tests of the check.
.PHONY: recipe-runners-check
recipe-runners-check:
	$(NODE) scripts/features/recipe-runners.mts
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 scripts/features/recipe-runners.test.mts
recipe-unknown-key-check: recipe-unknown-key-check/go recipe-unknown-key-check/typescript recipe-unknown-key-check/python recipe-unknown-key-check/php recipe-unknown-key-check/rust recipe-unknown-key-check/php-extension
recipe-unknown-key-check/go: recipe-keys-check
	$(GO_TEST) ./packages/go/internal/recipe -run '^(TestCheckKeysAcceptsAndRefusesByName|TestLoadKeyTableNamesTheSchemaTable)$$' -count=1
recipe-unknown-key-check/typescript: recipe-keys-check
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 packages/ts/tests/recipe_keys.test.mjs
recipe-unknown-key-check/python: recipe-keys-check python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_recipe_keys
recipe-unknown-key-check/php: recipe-keys-check php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RecipeKeysTest.php
recipe-unknown-key-check/rust: recipe-keys-check lease-tool
	cd packages/rust && $(CARGO_TEST) recipe-unknown-key-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test all -- recipe_keys::
recipe-unknown-key-check/php-extension: recipe-keys-check php-vendor-check
	@set -eu; run_dir="$(abspath .runtime/run)/recipe-unknown-key-php-extension-check-$$PPID"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/RecipeKeysExtensionTest.php

# conformance-refusal-check runs the type check of each compiled runtime that accepts each refusal of the case errors of the
# recipe conformance_verification with its error and refuses a use that drops the error: Go, TypeScript and Rust. The refusals
# themselves run in the recipe.
.PHONY: conformance-refusal-check conformance-refusal-check/go conformance-refusal-check/typescript conformance-refusal-check/rust-fixtures
conformance-refusal-check: conformance-refusal-check/go conformance-refusal-check/typescript conformance-refusal-check/rust-fixtures
conformance-refusal-check/go:
	$(GO_TEST) ./packages/go/model -run '^TestRefusalIsATypedError$$' -count=1
conformance-refusal-check/typescript: typescript-read
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 packages/ts/tests/refusal-before-request.mjs
conformance-refusal-check/rust-fixtures: lease-tool
	cd packages/rust && $(CARGO_TEST) conformance-refusal-rust-fixtures -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace -p polyspec-orm-tests --features $(ORM_RUST_TEST_FEATURES) --test all -- --test-threads=1 compiler_fixtures::refusal-

# conformance-generated-methods-check runs the conformance bodies that call generated methods on a database that holds the
# fixture and seed of the recipe conformance_verification, and compares them with the expects of its cases (T334-3-5-1).
# conformance-fixed-clock-check runs the fixed-clock bodies against tests/conformance/check/fixed_clock.json
# (T334-3-5-3). Each runs one target per runtime on the three databases of the test servers.
RECIPE_VECTORS_LANGUAGES = go typescript python php php-extension rust
RECIPE_VECTORS_RUN = for database in sqlite mysql postgres; do node tests/conformance/check/recipe_vectors.mts $(1) --language $(2) --database $$database || exit 1; done
.PHONY: conformance-generated-methods-check conformance-fixed-clock-check conformance-recipe-vectors-unit
conformance-generated-methods-check: conformance-recipe-vectors-unit $(addprefix conformance-generated-methods-check/,$(RECIPE_VECTORS_LANGUAGES))
conformance-fixed-clock-check: conformance-recipe-vectors-unit $(addprefix conformance-fixed-clock-check/,$(RECIPE_VECTORS_LANGUAGES))
conformance-recipe-vectors-unit:
	$(NODE) --test tests/conformance/check/recipe_vectors.test.mts
define RECIPE_VECTORS_TARGETS
.PHONY: conformance-$(1)-check/go conformance-$(1)-check/typescript conformance-$(1)-check/python conformance-$(1)-check/php conformance-$(1)-check/php-extension conformance-$(1)-check/rust
conformance-$(1)-check/go: typescript-read
	@$$(WITH_TEST_ENV) $$(call RECIPE_VECTORS_RUN,$(2),go)
conformance-$(1)-check/typescript: typescript-read
	@$$(WITH_TEST_ENV) $$(call RECIPE_VECTORS_RUN,$(2),typescript)
conformance-$(1)-check/python: typescript-read conformance-python-models
	@$$(WITH_TEST_ENV) export ORM_PYTHON=$$(PYTHON_VENV)/bin/python ORM_PYTHON_MODELS=$$(CONFORMANCE_PY_MODELS); $$(call RECIPE_VECTORS_RUN,$(2),python)
conformance-$(1)-check/php: typescript-read php-vendor-check php-models
	@$$(WITH_TEST_ENV) $$(call RECIPE_VECTORS_RUN,$(2),php)
conformance-$(1)-check/php-extension: typescript-read php-vendor-check php-models build-php-ext
	@$$(WITH_TEST_ENV) export POLYSPEC_ORM_EXTENSION="$$(abspath var/php-ext/polyspec_orm.so)"; $$(call RECIPE_VECTORS_RUN,$(2),php-extension)
conformance-$(1)-check/rust: typescript-read lease-tool
	@$$(WITH_TEST_ENV) $$(call RECIPE_VECTORS_RUN,$(2),rust)
endef
$(eval $(call RECIPE_VECTORS_TARGETS,generated-methods,generated))
$(eval $(call RECIPE_VECTORS_TARGETS,fixed-clock,fixed-clock))

# feature-rust-unit runs one Rust test of a feature: the make variables FEATURE_CRATE (the directory of the crate's Cargo.toml,
# from the checkout root), FEATURE_CARGO_TARGET (the cargo target option, such as `--test all` or
# `--bin conformance`) and FEATURE_TEST (the exact name of the test) are passed by its caller, the PERF-1 measurement of
# scripts/features/performance-reference.mts. The test is selected by its exact name. It runs through tests/cargo-test.mts,
# the runner of every Rust test, which gives the test binaries the copied programs they read (polyspec_orm_testcase::program).
.PHONY: feature-rust-unit
feature-rust-unit:
	$(WITH_TEST_ENV) cd $(FEATURE_CRATE) && $(CARGO_TEST) feature-rust-unit -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline $(FEATURE_CARGO_TARGET) -- --test-threads=1 --exact $(FEATURE_TEST)

# feature-check is the performance measurement and all verification commands; CI runs each runtime's Markdown target and performance
# in separate groups.
# feature-verify-rust runs the verification commands of shard rust, and feature-verify-other runs shard other. Commands shared by features
# execute once in their shard (scripts/features/check.mts).
feature-check: feature-performance-check feature-verify-rust feature-verify-other
feature-check/build: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build
feature-performance-check: RUN_DIR = $(abspath .runtime/run)/feature-performance-$$PPID
feature-performance-check: feature-check/build php-vendor-check php-models orm-install-php-extension-tools python-venv-check
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) node scripts/features/performance-reference.mts measure
	rm -rf $(RUN_DIR)
# typescript-current publishes the TypeScript client only when its sources changed, and holds the exclusive lease for that build alone, so the targets
# that read the client ($(READ_TYPESCRIPT)) run together. A target that reads the editor packages too has typescript-build, whose build includes them.
.PHONY: typescript-current typescript-read
typescript-read: typescript-current
	$(READ_TYPESCRIPT)
typescript-current: lease-tool orm-codes-typescript
	$(NODE) scripts/typescript/build.mts --current || $(LEASE) run $(TYPESCRIPT_LEASES) exclusive --wait -- $(RUN_LONG) typescript-build -- npm run typescript:build
# feature-coverage-of/<id> runs the coverage of one feature on every runtime and database (FCV-6), the Verification of a row of that feature.
# The Python owners run on the client's venv (ORM_PYTHON) with the slot models generated into the run directory (ORM_PYTHON_BIND_MODELS), and the php-extension owners on a PHP that loads the extension built into its run directory.
feature-coverage-of/%: RUN_DIR = $(abspath .runtime/run)/feature-coverage-of-$$PPID
feature-coverage-of/%: typescript-current php-vendor-check php-models orm-install-php-extension-tools python-venv-check
	$(READ_TYPESCRIPT)
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)
	$(PYTHON_VENV)/bin/orm-gen gen --set tests/bind/dbspec-set.json --out $(RUN_DIR)/bind-python-models
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_PYTHON_BIND_MODELS=$(RUN_DIR)/bind-python-models POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) node scripts/features/coverage.mts --feature $*
	rm -rf $(RUN_DIR)
feature-verify-rust: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run --features --shard rust
feature-verify-other: feature-check/build
	$(WITH_TEST_ENV) node scripts/features/check.mts --run --features --shard other
# feature-helper-check, feature-stress-mysql-check, and feature-stress-pg-sqlite-check run the helper checks of contracts/features.json.
# FEATURE_STRESS_HELPERS is the helper of the stress bench that takes the longest time: the MySQL application of the stress plan
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
FEATURE_SUITE_HELPERS = bench-database case-database conformance-result conformance-runners native-query-probe python-test-harness phpstan-test-runner audit-native-method-assertions dbspec-sqlite-literal-rows typescript-catalog-mutation-lock python-catalog-mutation-lock php-group-rows-test-cases php-model-types-test-cases php-dbspec-interface-program php-database-test-assertions php-extension-model-assembly-test-support typescript-internal-column-error typescript-dbspec-plan-fixture physical-command-output typescript-captured-error typescript-check-state typescript-mysql-test-options typescript-database-case-tests typescript-conditional-entry typescript-database-case-fixture
feature-helper-check: RUN_DIR = $(abspath .runtime/run)/feature-helper-check-$$PPID
feature-helper-check: feature-check/build php-vendor-check python-venv-check
	@set -eu; run_dir="$(RUN_DIR)"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$(PHP_EXTENSION_LIBRARY)",release); \
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python POLYSPEC_ORM_EXTENSION="$(PHP_EXTENSION_LIBRARY)" node scripts/features/check.mts --run --helpers $(addprefix --without-helper ,$(FEATURE_STRESS_HELPERS) $(FEATURE_SUITE_HELPERS))
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
# PYTHON_TESTS runs Python tests through the harness of packages/python/tests/testcase.py, which keeps the deadline of each
# case by its class and ends the process GRACE after it. run-tests gives every case of a --module harness one timeout, so
# PYTHON_TESTS gives it the longest class, PROCESS (300 s), with GRACE (5 s), and the class of a case decides when it fails.
PYTHON_TESTS = PYTHONUNBUFFERED=1 NO_COLOR=1 PYTHON_COLORS=0 $(RUN_TESTS) python --timeout 305 --venv $(PYTHON_VENV) --module packages.python.tests.testcase
client-unit-check: client-unit-check/dsn client-unit-check/markdown client-unit-check/relation-keys client-unit-check/code-catalog client-unit-check/insert-parts client-unit-check/engine client-unit-check/runtime-model client-unit-check/orm-gen client-unit-check/orm-gen-python client-unit-check/orm-gen-typescript client-unit-check/model-methods client-unit-check/client-generics client-unit-check/perf-extensions client-unit-check/dbspec-runners
client-unit-check/dbspec-runners: php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRunnerTest.php
client-unit-check/dsn: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DsnTest.php
client-unit-check/markdown: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/MarkdownTest.php
client-unit-check/relation-keys: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RelationKeysTest.php
# client-unit-check/code-catalog compares the generated Code.php with docs/spec/errors.yaml.
client-unit-check/code-catalog: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodeCatalogTest.php
# client-unit-check/insert-parts runs the cases of contracts/fixtures/insert_parts.json in PHP and TypeScript.
client-unit-check/insert-parts: php-vendor-check php-models typescript-current
	$(READ_TYPESCRIPT)
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/InsertPartsTest.php
	$(NODE) --conditions=orm-test --test packages/ts/tests/insert-parts.mjs
client-unit-check/engine: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/EngineTest.php

# The six SQLite NOWAIT callers restore busy_timeout without hiding the lock error or either failure cause.
.PHONY: nowait-restore-check
nowait-restore-check: lease-tool typescript-read php-vendor-check php-models python-venv-check orm-install-php-extension-tools
	@set +e; status=0; \
	$(GO_TEST) ./packages/go/orm -run '^TestAcquireSQLiteRowLock' -count=1 || status=1; \
	$(RUN_TESTS) node --timeout 30 --test-concurrency=1 --conditions=orm-test --test packages/ts/tests/sqlite-row-lock-restore.mjs || status=1; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SqliteRowLockRestoreTest.php || status=1; \
	$(PYTHON_TESTS) -- packages.python.tests.test_sqlite_row_lock_restore || status=1; \
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib db::sqlite_row_lock_restore_tests -- --test-threads=1 || status=1; \
	run_dir="$(abspath .runtime/run)/nowait-restore-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	if $(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); then \
		env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SqliteRowLockRestoreTest.php || status=1; \
	else status=1; fi; \
	exit "$$status"
client-unit-check/runtime-model: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RuntimeModelTest.php
client-unit-check/orm-gen-python: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_orm_gen.WriteTextIfChangedTest

client-unit-check/orm-gen-typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test --test-name-pattern='writeTextIfChanged' packages/ts/tests/generate.mjs

client-unit-check/orm-gen: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenTest.php

php-go-text-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/GoSerializationTest.php

php-gen-unit-check: typescript-current php-vendor-check php-models
	$(READ_TYPESCRIPT)
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenCliTest.php packages/php/tests/OrmGenScanTest.php packages/php/tests/OrmGenPackageTest.php packages/php/tests/OrmGenParsedModelTest.php packages/php/tests/OrmGenLazyModelTest.php

# generator-consumer-check runs the consumer tests of each generator as a part of its own, so a failed part does not stop the others.
.PHONY: generator-consumer-check/go generator-consumer-check/php generator-consumer-check/php-extension generator-consumer-check/typescript generator-consumer-check/python generator-consumer-check/rust-field-types generator-consumer-check/rust-field-types/generated-field-types generator-consumer-check/rust-field-types/fixed-method-list generator-consumer-check/rust-emission generator-consumer-check/rust-chain-scan generator-consumer-check/rust-chain-scan/generates-called-methods generator-consumer-check/rust-integration
generator-consumer-check:
	+$(MAKE) --no-print-directory -k generator-consumer-check/go generator-consumer-check/php generator-consumer-check/php-extension generator-consumer-check/typescript generator-consumer-check/python generator-consumer-check/rust-field-types generator-consumer-check/rust-emission generator-consumer-check/rust-chain-scan generator-consumer-check/rust-integration
generator-consumer-check/go:
	cd packages/go && $(NODE) $(abspath tests/go-test.mts) -v -timeout 0 ./generator -run '^(TestGoGeneratedScalarGetterRejectsUnselectedRead|TestGoGeneratedScalarGetterCompilesAtItsDeclaredType|TestGoGeneratedNonnullStyledSetterRejectsSqlNull|TestScanGeneratesUsedMethods)$$' -count=1
generator-consumer-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenTest.php --filter testGeneratedTypedGetterUsesPrivateModelStorageAndRejectsUnselectedRead
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenScanTest.php packages/php/tests/ModelMethodsTest.php --filter 'testTheReceiverIsResolvedFromTheSource|testADeclaredMethodBuildsTheQueryOfItsChain'
generator-consumer-check/php-extension: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/generator-consumer-check-$$$$"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelNativeTest.php packages/php-ext/tests/ModelDslNativeTest.php --filter 'testPhpGeneratedTypedGetterUsesInternalModelStorage|testDynamicConditionsAndBuilderCallsReturnTheNativeModel'
generator-consumer-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/generate.mjs
	$(NODE) --test --test-name-pattern='generate-scan/model_calls' packages/ts/tests/generate-scan.mjs
generator-consumer-check/python: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_orm_gen.OrmGenTest.test_generated_typed_getter_is_the_public_column_api
	$(PYTHON_TESTS) -- packages.python.tests.test_orm_gen.OrmGenTest.test_chain_conditions packages.python.tests.test_query_methods.QueryMethodsTest.test_a_declared_method_builds_the_query_of_its_chain
generator-consumer-check/rust-field-types: generator-consumer-check/rust-field-types/generated-field-types generator-consumer-check/rust-field-types/fixed-method-list
generator-consumer-check/rust-field-types/generated-field-types: lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust-field-types -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm-build --lib generate::field_type_tests::generated_field_types_follow_the_runtime_model -- --test-threads=1 --exact
generator-consumer-check/rust-field-types/fixed-method-list: lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust-fixed-method-list -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-build --lib generate::fixed_method_tests::fixed_list_names_the_public_methods_of_the_fixed_impl -- --test-threads=1 --exact
generator-consumer-check/rust-emission: lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust-emission -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace -p polyspec-orm-tests --features $(ORM_RUST_TEST_FEATURES) --test all -- generate::generated_rows_reject_unselected_fields_and_separate_group_results --test-threads=1 --exact
generator-consumer-check/rust-chain-scan: generator-consumer-check/rust-chain-scan/generates-called-methods
generator-consumer-check/rust-chain-scan/generates-called-methods: lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust-chain-scan -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace -p polyspec-orm-tests --features $(ORM_RUST_TEST_FEATURES) --test all -- generate::generates_called_methods --test-threads=1 --exact
generator-consumer-check/rust-integration: lease-tool
	cd packages/rust && $(CARGO_TEST) generator-consumer-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm-tests --test all integration_program::generated_typed_getter_is_a_checked_public_consumer_api -- --test-threads=1 --exact

# rust-compiler-fixtures-check runs its two suites as parts that make -j runs together (KSTD-5-23): the native compiler fixtures, and the test of their runner.
.PHONY: rust-compiler-fixtures-check rust-compiler-fixtures-check/native rust-compiler-fixtures-check/unit
rust-compiler-fixtures-check: rust-compiler-fixtures-check/native rust-compiler-fixtures-check/unit

rust-compiler-fixtures-check/native: lease-tool
	cd packages/rust && $(CARGO_TEST) rust-compiler-fixtures-native -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace -p polyspec-orm-tests --features $(ORM_RUST_TEST_FEATURES) --test all -- compiler_fixtures:: --test-threads=1

rust-compiler-fixtures-check/unit: lease-tool
	$(NODE) --test scripts/rust/compiler-fixtures.test.mts

# Native no-database cases bind driver errors, cells and the Markdown wire handshake to each runtime's native call path.
.PHONY: native-error-cause-check
.PHONY: native-error-cause-check/typescript-driver native-error-cause-check/typescript-markdown native-error-cause-check/python-driver native-error-cause-check/php
native-error-cause-check: php-models native-error-cause-check/php-extension native-error-cause-check/rust native-error-cause-check/typescript-driver native-error-cause-check/typescript-markdown native-error-cause-check/python-driver native-error-cause-check/php
native-error-cause-check/typescript-driver: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/driver-error-lock-wait.mjs packages/ts/tests/driver-integer-param.mjs
native-error-cause-check/typescript-markdown: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) packages/ts/tests/markdown.mjs
native-error-cause-check/python-driver: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s packages/python/tests -t . -p test_driver_errors.py
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s packages/python/tests -t . -p test_driver_cells.py
native-error-cause-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmExceptionLockWaitTest.php packages/php/tests/MarkdownTest.php packages/php/tests/NativeCellReadTest.php
.PHONY: native-error-cause-check/rust
native-error-cause-check/rust:
	cd packages/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) native-error-cause-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib --features test-faults native -- --nocapture
.PHONY: native-error-cause-check/php-extension
native-error-cause-check/php-extension: php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/native-error-cause-check-php-ext-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir"; \
	$(call php_ext_build,"$$run_dir/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testColumnValuePreservesOriginalWarningThrowable|testDriverFactoryKeepsItsCodeAndOriginalThrowable|testNativeSqliteConnectionFailurePreservesThePdoCause' packages/php-ext/tests/ModelStreamReadTest.php packages/php-ext/tests/OrmExceptionNativeTest.php
client-unit-check/model-methods: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php
client-unit-check/client-generics: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ClientGenericsTest.php

.PHONY: dbspec-php-interface-program-helper-check
dbspec-php-interface-program-helper-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecRunnerTest.php --filter testCompareRunnerUsesOneSharedOutputSequence
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecPlanTest.php --filter testComparisonHarnessParsesPlanVectorsAndWritesDiagnostics

# Runs the shared PHP source scanner failure case with the PHP extension loaded.
.PHONY: phpstan-test-runner-helper-check
phpstan-test-runner-helper-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ClientGenericsTest.php --filter testPhpstanTypesTheTransactionResultAndTheRowsOfAModel
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelMethodsTest.php --filter testPhpstanFindsEveryQueryMethodOfAGeneratedModel
.PHONY: audit-native-method-assertions-helper-check
audit-native-method-assertions-helper-check: php-vendor-check php-model-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/audit-native-method-assertions-helper-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/AuditNativeMethodsTest.php --filter testNativeMethodsAreInternal

client-unit-check/perf-extensions: php-vendor-check php-models
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

client-db-check: client-db-go-check client-db-php-check client-db-php-extension-check client-db-typescript-check client-db-python-check client-db-rust-check

client-db-go-check: lease-tool orm-codes
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=go node scripts/client-db-test.mts

client-db-php-check: php-vendor-check php-models orm-codes
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=php node scripts/client-db-test.mts

client-db-php-extension-check: lease-tool php-vendor-check php-models orm-install-php-extension-tools orm-codes
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=php-extension node scripts/client-db-test.mts

client-db-typescript-check: typescript-current orm-codes
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=typescript node scripts/client-db-test.mts

client-db-python-check: python-venv-check orm-codes
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_statement_fault_entry
	$(WITH_TEST_ENV) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_CLIENT_DB_LANGS=python node scripts/client-db-test.mts

client-db-rust-check: lease-tool orm-codes
	$(WITH_TEST_ENV) ORM_CLIENT_DB_LANGS=rust node scripts/client-db-test.mts

# The suites of PHP, TypeScript and Python run every test file of their runtime in contracts/implementations.json, each as its own
# process (scripts/suite-test.mts); Go, Rust and the PHP extension run theirs whole in client-db-go-check, client-db-rust-check
# and test-php-ext. Each suite reads the servers and databases of TEST_ENV and the flowmark build of FLOWMARK, and the Python one the
# bind models (ORM_PYTHON_BIND_MODELS) that its recipe helper imports for tests/bind/messages.json.
.PHONY: suite-php-check suite-typescript-check suite-python-check suite-test-unit-check
suite-php-check: flowmark-check php-vendor-check php-models orm-codes
	$(WITH_TEST_ENV) FLOWMARK=$(FLOWMARK) $(NODE) scripts/suite-test.mts php
suite-typescript-check: flowmark-check typescript-current orm-codes
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) FLOWMARK=$(FLOWMARK) $(NODE) scripts/suite-test.mts typescript
suite-python-check: flowmark-check python-venv-check bind-python-models orm-codes
	$(WITH_TEST_ENV) FLOWMARK=$(FLOWMARK) ORM_PYTHON=$(PYTHON_VENV)/bin/python ORM_PYTHON_BIND_MODELS=$(BIND_PY_MODELS) $(NODE) scripts/suite-test.mts python
# suite-test-unit-check runs the unit tests of the suites: what each suite runs and leaves to another check.
suite-test-unit-check:
	$(NODE) --test scripts/suite-test.test.mts

# The php-ext unit tests that run before the AES rotation stress test, the stress test and root_in_chunking, in one process at the
# memory_limit of the gate (the php default, 128M). The stress test exhausts it after these classes (T334-3-4-7).
PHP_EXT_MEMORY_CASES = ^(Polyspec\\Orm\\Extension\\Tests\\CoverageNativeFixtureExtensionTest::|Polyspec\\Orm\\Tests\\CoveragePerformanceGateExtensionTest::|Polyspec\\Orm\\Extension\\Tests\\RequestHookTestExtensionTest::|Polyspec\\Orm\\Extension\\Tests\\CoverageSchemaDefinitionExtensionTest::|Polyspec\\Orm\\Extension\\Tests\\CoverageSchemaInstallNativeTest::|Polyspec\\Orm\\Extension\\Tests\\StatementEventsRecipeTestExtensionTest::|Polyspec\\Orm\\Extension\\Tests\\StatementRunnerRecipeTestExtensionTest::|Polyspec\\Orm\\Tests\\CoverageTransactionsExtensionTest::|Polyspec\\Orm\\Tests\\Cpx5DuplicateRelationNativeTest::|Polyspec\\Orm\\Extension\\Tests\\DbspecAnalyzeTestExtensionTest::|Polyspec\\Orm\\Extension\\Tests\\DbspecApplyCleanupTestExtensionTest::|Polyspec\\Orm\\Extension\\Tests\\ParameterChunkingMysqlRecipeExtensionTest::testMysql with data set "root_in_chunking")
PHP_EXT_MEMORY_GATE_POSTGRES = ^(Polyspec\\Orm\\Tests\\CoveragePerformanceGateExtensionPostgresTest::)
PHP_EXT_MEMORY_GATE_SQLITE = ^(Polyspec\\Orm\\Tests\\CoveragePerformanceGateExtensionSqliteTest::)
PHP_EXT_MEMORY_CATALOG = ^(Polyspec\\Orm\\Extension\\Tests\\CatalogConnectionRecipeTestExtensionTest::|Polyspec\\Orm\\Extension\\Tests\\CatalogConnectionSqliteOnlyRecipeTestExtensionTest::)

# The memory check of T334-3-4-7 runs the group of PHP_EXT_MEMORY_CASES in one php-ext process, so its memory accumulates as the 128M
# memory_limit of the gate. Each gate class names its database and reads its BENCH_<DATABASE>_DSN from the TEST_ENV of this run: the
# mysql gate runs with the group, and the Postgres and SQLite gates run in one process each. The catalog cases run in their own
# process, so they do not change what the group accumulates.
.PHONY: php-ext-memory-check
php-ext-memory-check: php-vendor-check orm-install-php-extension-tools
	$(WITH_TEST_ENV) $(MAKE) --no-print-directory test-php-ext CASES='$(PHP_EXT_MEMORY_CASES)'
	$(WITH_TEST_ENV) $(MAKE) --no-print-directory test-php-ext CASES='$(PHP_EXT_MEMORY_GATE_POSTGRES)'
	$(WITH_TEST_ENV) $(MAKE) --no-print-directory test-php-ext CASES='$(PHP_EXT_MEMORY_GATE_SQLITE)'
	$(WITH_TEST_ENV) $(MAKE) --no-print-directory test-php-ext CASES='$(PHP_EXT_MEMORY_CATALOG)'

# python-mysql-session-check checks the session startup parameters of a Python PostgreSQL connection
# (packages/python/tests/mysql_session.py); it needs the database variables of make orm-test-servers (WITH_TEST_ENV).
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

# dialect-facts-check runs the citation tests of the schema dialect probes of packages/go/internal/dialects: each probe has an ID
# and cites the dialect spec. The probes themselves (TestDialectFacts), which run against the MySQL and PostgreSQL servers of
# TEST_ENV and a SQLite file per probe, are go tests of go-test-check, which builds what they need (T334-3-6-3).
dialect-facts-check:
	$(GO_TEST) ./packages/go/internal/dialects -run '^(TestProbeIDs|TestProbeCitations)$$' -count=1
# dialect-facts-mariadb-check runs the MariaDB probes (TestDialectFactsMariadb) on the MariaDB servers of make orm-test-mariadb,
# the primary and the privilege server (DIA-200); go-test-check, which runs on the MySQL servers, leaves them to it.
.PHONY: dialect-facts-mariadb-check
dialect-facts-mariadb-check: lease-tool
	$(WITH_MARIADB_ENV) $(GO_TEST) ./packages/go/internal/dialects -run '^TestDialectFactsMariadb$$' -count=1

# conformance-result-check builds the TypeScript client and runs the PHP, TypeScript, and Go conformance result
# tests. Each runner reports its cases with their deadlines.
conformance-result-check: conformance-result-check/php conformance-result-check/typescript conformance-result-check/go conformance-result-check/python
.PHONY: conformance-result-check/php conformance-result-check/typescript conformance-result-check/go conformance-result-check/python
conformance-result-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceResultTest.php
conformance-result-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test tests/conformance/check/result_typescript.test.mts
conformance-result-check/go:
	$(GO_TEST) ./packages/go/internal/conformance -count=1
conformance-result-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.conformance_result

# Runs the selected model getter/setter styled states in each native client. Each runtime reports independently.
.PHONY: styled-column-states-unit-check
styled-column-states-unit-check: typescript-current php-vendor-check php-model-check python-venv-check php-models
	$(READ_TYPESCRIPT)
	@set +e; status=0; last_result=0; \
	run_case() { label=$$1; shift; printf '[styled-column-states] %s\n' "$$label"; "$$@"; last_result=$$?; printf '[styled-column-states] %s exit %s\n' "$$label" "$$last_result"; if [ "$$last_result" -ne 0 ]; then status=1; fi; return 0; }; \
	run_case go $(GO_TEST) ./packages/go/orm -run '^TestStyledColumnStateFixture$$' -count=1; \
	run_case php env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/StyledValueTest.php --filter 'testStyledValue|testModelStates'; \
	run_dir="$(abspath .runtime/run)/styled-column-states-unit-check-$$PPID"; extension="$$run_dir/php-extension/polyspec_orm.so"; \
	trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	run_case php-extension-build $(call php_ext_build,"$$extension",release); \
	if [ "$$last_result" -eq 0 ]; then run_case php-extension env ORM_PHP_MODE=extension POLYSPEC_ORM_EXTENSION="$$extension" $(RUN_TESTS) phpunit --php-extension "$$extension" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelNativeTest.php --filter 'testStyledColumnDistinguishesUnselectedSqlNullAndEncodedNull|testStyledColumnStateVector'; fi; \
	run_case typescript $(NODE) --test --test-name-pattern='^(sql_null|json_null|json_object_with_kind|empty_text|serialize_sql_null|serialize_value_null|yaml_sql_null|yaml_value_null|unselected|nonnull_sql_null|jsons_sql_null|jsons_value_null|nonnull_value_null|setter_json_nesting_beyond_256_levels|setter_serialize_nesting_beyond_256_levels|setter_yaml_nesting_beyond_256_levels|setter_json_nesting_of_256_levels)$$' packages/ts/tests/styled-value.mjs; \
	run_case python $(PYTHON_VENV)/bin/python -m packages.python.tests.test_styled_column_states; \
	run_case rust env PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) styled-column-states-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --manifest-path packages/rust/Cargo.toml --locked --offline -p polyspec-orm-tests --test all -- 'styled_column_states::styled_column_state_fixture::' --test-threads=1; \
	exit "$$status"


unselected-column-physical-check: php-vendor-check
	$(WITH_TEST_ENV) node scripts/unselected-column-physical-check.mts

# case-database-check runs the model case of four clients on two shared test databases, leaving one table in each,
# and checks that the cases pass without changing the shared database or the PostgreSQL schema, and leave no
# `orm_case_` database or `orm-case-` SQLite file of their own (T25).
case-database-check: typescript-current php-vendor-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) PATH="$(HOME)/.cargo/bin:$(PATH)" node scripts/case-database-check.mts

# conformance-check runs the native conformance bodies that remain, each compared with data outside the vector files
# (tests/conformance/check/recipe_vectors.mts), and the result helpers of the runners. The vectors are the cases of the recipe
# conformance_verification, which each runtime runs (FCV-3).
# PYTHON_MODELS_* is the one declared entry of the Python models that orm-gen generates (P34: generated output is never tracked): the
# document set, the output directory and the source scanned for model calls. python-models writes them, and it is the last step of
# orm-install-python, so every reader of the venv finds them. python-model-check runs orm-gen gen --check against the same entry (no network).
PYTHON_MODELS_SET = contracts/fixtures/bench/dbspec-set.json
PYTHON_MODELS_OUT = packages/python/tests/models
PYTHON_MODELS_SCAN = packages/python/examples/thin_slice/main.py
.PHONY: python-models
PYTHON_MODELS_STAMP = $(CURDIR)/packages/python/tests/models/python-models.key
python-models: python-venv-check
	$(GENERATE_ONCE) $(PYTHON_MODELS_STAMP) "" packages/python/uv.lock packages/python/src $(PYTHON_MODELS_SET) $(PYTHON_MODELS_SCAN) -- $(PYTHON_VENV)/bin/orm-gen gen --set $(PYTHON_MODELS_SET) --out $(PYTHON_MODELS_OUT) --scan $(PYTHON_MODELS_SCAN)
.PHONY: python-model-check
python-model-check: python-venv-check
	$(PYTHON_VENV)/bin/orm-gen gen --check --set $(PYTHON_MODELS_SET) --out $(PYTHON_MODELS_OUT) --scan $(PYTHON_MODELS_SCAN)

# bind-models-check generates the models of the slot fixture tests/bind/dbspec-set.json in each runtime that uses them (FCV-3):
# Go and PHP check their declared entries (go-model-check, php-model-check), the Python directory and the TypeScript build write
# theirs, and the Rust tests crate generates its own in its build script. No database runs.
.PHONY: bind-models-check
bind-models-check: go-model-check php-model-check bind-python-models typescript-read

# bind-message-check runs the markdown message and control recipe, tests/bind/messages.json, in each runtime (FCV-3, FCV-4): each part
# runs the entry of its runtime that calls the recipe helper, without a database. Each markdown.send step runs one public call on a
# listener that answers the setup statements of the SQLite dialect and records the first other message (docs/spec/feature-coverage.md).
# Its raw-text parts run tests/bind/messages-raw-text.json, the text that is not UTF-8, in the runtimes whose host string holds it (PRT-67).
.PHONY: bind-message-check bind-message-check/go bind-message-check/rust bind-message-check/typescript bind-message-check/python bind-message-check/php bind-message-check/php-extension bind-message-check/raw-text-go bind-message-check/raw-text-php bind-message-check/raw-text-php-extension
bind-message-check: bind-message-check/go bind-message-check/rust bind-message-check/typescript bind-message-check/python bind-message-check/php bind-message-check/php-extension bind-message-check/raw-text-go bind-message-check/raw-text-php bind-message-check/raw-text-php-extension
bind-message-check/raw-text-go:
	$(GO_TEST) ./packages/go/bindmessages -run '^TestRecipeBindMessagesRawTextNone$$' -count=1
bind-message-check/raw-text-php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/BindMessagesRawTextRecipeTest.php
bind-message-check/raw-text-php-extension: php-vendor-check php-models build-php-ext
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/BindMessagesRawTextRecipeTestExtensionTest.php
bind-message-check/go:
	$(GO_TEST) ./packages/go/bindmessages -run '^TestRecipeBindMessagesNone$$' -count=1
bind-message-check/rust: lease-tool
	cd packages/rust && $(CARGO_TEST) bind-message-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- bind_messages::
bind-message-check/python: python-venv-check bind-python-models
	ORM_PYTHON_BIND_MODELS=$(BIND_PY_MODELS) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_bind_messages_none
bind-message-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/BindMessagesRecipeTest.php
bind-message-check/php-extension: php-vendor-check php-models build-php-ext
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/BindMessagesRecipeTestExtensionTest.php
bind-message-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --conditions=orm-test packages/ts/tests/bind_messages.mjs

# markdown-session-check runs the session recipe, tests/markdown/session.json, in each runtime (FCV-3, FCV-4): each part runs the
# entry of its runtime that calls the recipe helper, without a database. Each markdown.session step runs reads of the bind fixture
# model on a listener that answers from its replies and checks the messages it received (PRT-66), which no database shows.
.PHONY: markdown-session-check markdown-session-check/go markdown-session-check/rust markdown-session-check/typescript markdown-session-check/python markdown-session-check/php markdown-session-check/php-extension
markdown-session-check: markdown-session-check/go markdown-session-check/rust markdown-session-check/typescript markdown-session-check/python markdown-session-check/php markdown-session-check/php-extension
markdown-session-check/go:
	$(GO_TEST) ./packages/go/bindmessages -run '^TestRecipeMarkdownSessionNone$$' -count=1
markdown-session-check/rust: lease-tool
	cd packages/rust && $(CARGO_TEST) markdown-session-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- markdown_session::
markdown-session-check/python: python-venv-check bind-python-models
	ORM_PYTHON_BIND_MODELS=$(BIND_PY_MODELS) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_markdown_session_none
markdown-session-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/MarkdownSessionRecipeTest.php
markdown-session-check/php-extension: php-vendor-check php-models build-php-ext
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/MarkdownSessionRecipeTestExtensionTest.php
markdown-session-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --conditions=orm-test packages/ts/tests/markdown_session.mjs

CHECK_TARGETS += markdown-session-check/go
CI_TARGETS_markdown_go += markdown-session-check/go
CHECK_TARGETS += markdown-session-check/rust
CI_TARGETS_markdown_rust += markdown-session-check/rust
CHECK_TARGETS += markdown-session-check/typescript
CI_TARGETS_markdown_typescript += markdown-session-check/typescript
CHECK_TARGETS += markdown-session-check/python
CI_TARGETS_markdown_python += markdown-session-check/python
CHECK_TARGETS += markdown-session-check/php
CI_TARGETS_markdown_php += markdown-session-check/php
CHECK_TARGETS += markdown-session-check/php-extension
CI_TARGETS_markdown_php_extension += markdown-session-check/php-extension

# BIND_PY_MODELS is the model directory of the slot fixture tests/bind/dbspec-set.json that the Python recipe helper imports (FCV-4,
# markdown.send). The venv orm-gen writes it into a temporary directory and renames it into place, as conformance-python-models does.
BIND_PY_MODELS = $(abspath .runtime/run)/bind-python-models
# Runs read a model directory together, so one lease holds its publish, and a key of its inputs leaves a current directory in place while they read it.
PY_MODELS_LEASES = $(abspath .runtime/python-models.leases)
py_models_publish = $(LEASE) run $(PY_MODELS_LEASES) exclusive --wait -- $(GENERATE_ONCE) $(1).key "" packages/python/uv.lock packages/python/src $(dir $(2)) -- sh -c 'rm -rf $(1).tmp && $(PYTHON_VENV)/bin/orm-gen gen --set $(2) --out $(1).tmp && rm -rf $(1) && mv $(1).tmp $(1)'
.PHONY: bind-python-models
bind-python-models: lease-tool python-venv-check
	$(call py_models_publish,$(BIND_PY_MODELS),tests/bind/dbspec-set.json)

# CONFORMANCE_PY_MODELS is the model directory that the Python conformance runner imports. The venv orm-gen writes it from
# contracts/fixtures/bench/bench.dbs into a temporary directory and renames it into place (an atomic publish of build output).
CONFORMANCE_PY_MODELS = $(abspath .runtime/run)/conformance-python-models
.PHONY: conformance-python-models
conformance-python-models: lease-tool python-venv-check
	$(call py_models_publish,$(CONFORMANCE_PY_MODELS),contracts/fixtures/bench/dbspec-set.json)

conformance-check: conformance-result-check conformance-generated-methods-check conformance-fixed-clock-check

# markdown-conformance-check runs the cases of tests/markdown/cases.json for each client against the flowmark server of FLOWMARK
# (tests/markdown/README.md). FLOWMARK is the build that tests/markdown/flowmark.version pins, and make
# orm-install-flowmark installs it here. The test fails unless the version matches what the build information pins, so a flowmark checkout
# built at the pinned revision can be given as FLOWMARK=<that path>.
FLOWMARK ?= $(abspath .runtime/bin/flowmark)
# The native tests of the extension and the Python tests that python-unit-check discovers hold markdown units, which run on the
# flowmark server of FLOWMARK. The export follows the definition of FLOWMARK, since a simple assignment takes the value that
# FLOWMARK has where make reads it.
test-php-ext: export FLOWMARK := $(FLOWMARK)
test-php-ext: flowmark-check
python-unit-check: export FLOWMARK := $(FLOWMARK)
python-unit-check: flowmark-check
.PHONY: markdown-conformance-check markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/php-extension markdown-conformance-check/python markdown-conformance-check/rust markdown-conformance-check/typescript orm-install-flowmark
# Kit's gates workflow runs the context preparation and cleanup of the php-ext job in separate job steps. This context gives that
# job the same run-owned servers, benchmark fixtures and build-output directory as run-databases, while GITHUB_ENV carries the two
# paths to the gate.
.PHONY: php-extension-context-prepare php-extension-context-cleanup
php-extension-context-prepare:
	$(NODE) scripts/check/job-context.mts prepare php-ext
php-extension-context-cleanup:
	$(NODE) scripts/check/job-context.mts cleanup php-ext
# The servers and bench DSNs of a run are in its TEST_ENV file (run-databases writes it; its lines are export NAME='value',
# scripts/check/databases.mts environmentFile). Export every variable of it into make itself, as the CI contexts export the run env
# (scripts/check/job-context.mts), so the tests that kit starts from make, such as the native suite of test-php-ext,
# inherit the run (T299). The guard below names a missing DSN.
ifneq ($(wildcard $(abspath $(TEST_ENV))),)
TEST_ENV_NAMES := $(shell sed -n "s/^export \([A-Z_][A-Z0-9_]*\)=.*/\1/p" $(abspath $(TEST_ENV)))
$(foreach v,$(TEST_ENV_NAMES),$(eval export $(v) := $(shell . $(abspath $(TEST_ENV)) >/dev/null 2>&1 && printf "%s" "$$$(v)")))
endif
# The decimal DSNs of a run are in its DECIMAL_ENV file (run-databases writes them), read by the python decimal unit.
DECIMAL_DSN_NAMES := DECIMAL_MYSQL_DSN DECIMAL_POSTGRES_DSN DECIMAL_SQLITE_DSN
ifneq ($(DECIMAL_ENV),)
ifneq ($(wildcard $(abspath $(DECIMAL_ENV))),)
$(foreach v,$(DECIMAL_DSN_NAMES),$(eval export $(v) := $(shell . $(abspath $(DECIMAL_ENV)) >/dev/null 2>&1 && printf "%s" "$$$(v)")))
endif
endif

# flowmark-check names the flowmark binary that the markdown tests read (FLOWMARK) before a suite runs them;
# orm-install-flowmark builds it from the version pinned in tests/markdown/flowmark.version.
flowmark-check:
	test -n "$(FLOWMARK)" && test -x "$(FLOWMARK)" || { echo "flowmark-check: $(FLOWMARK) is missing; run make orm-install-flowmark, which builds the version pinned in tests/markdown/flowmark.version"; exit 1; }

# CI provides the declared group needs as booleans; static checks need every tool,
# while the other groups install only the shared Go runner and the runtimes their targets use.
.PHONY: ci-install-tools
ifeq ($(GROUP),static)
ci-install-tools:
	$(MAKE) --no-print-directory install-tools
else
ci-install-tools:
	$(MAKE) --no-print-directory install-tools TOOLS="go$(if $(filter true,$(CI_GROUP_PHP)), php composer)$(if $(filter true,$(CI_GROUP_PYTHON)), python uv)"
endif
markdown-conformance-check: markdown-conformance-check/go markdown-conformance-check/php markdown-conformance-check/php-extension markdown-conformance-check/python markdown-conformance-check/rust markdown-conformance-check/typescript
markdown-conformance-check/go:
	FLOWMARK=$(FLOWMARK) $(GO_TEST) ./packages/go/markdownmodel -run '^TestMarkdownConformance$$' -count=1
markdown-conformance-check/php: php-vendor-check php-models
	FLOWMARK=$(FLOWMARK) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --stop-on-defect packages/php/tests/MarkdownConformanceTest.php
markdown-conformance-check/php-extension: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/markdown-conformance-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); FLOWMARK=$(FLOWMARK) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --stop-on-defect packages/php-ext/tests/MarkdownConformanceNativeTest.php
# The Python runner reads the build information with go version -m.
markdown-conformance-check/python: python-venv-check
	FLOWMARK=$(FLOWMARK) $(PYTHON_VENV)/bin/python -m packages.python.tests.markdown_conformance
markdown-conformance-check/rust: lease-tool
	cd packages/rust && FLOWMARK=$(FLOWMARK) PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) markdown-conformance-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- markdown_conformance:: --nocapture
markdown-conformance-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	FLOWMARK=$(FLOWMARK) $(NODE) --conditions=orm-test packages/ts/tests/markdown_conformance.mjs

decimal-bench-sqlite: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) scripts/decimal-bench-sqlite.mts

# The cases of decimal-physical-check have a deadline per owner process (TIMEOUT_MS of scripts/physical.mts). The build that the process
# uses (the Rust test binary decimal_physical and the Go decimalmodel test) is a long-running
# task, so it runs first under RUN_LONG with no deadline before the case (the Go build publishes into .runtime/bin and fills the build cache), and the case
# Run what was built.
# The case runs the copy of the Rust test binary (tests/cargo-test.mts --copy): a cargo test in its deadline would wait for and rebuild
# what the other helpers of this run build in the shared target directory.
decimal-physical-check: DECIMAL_RUST_RUN = $(abspath .runtime/run)/decimal-physical-$PPID
decimal-physical-check: php-vendor-check lease-tool python-venv-check orm-install-php-extension-tools
	$(READ_TYPESCRIPT)
	test -n "$(DECIMAL_ENV)" -a -f "$(DECIMAL_ENV)" || { echo 'DECIMAL_ENV names no decimal database of this run; run make run-databases TARGETS=feature-helper-check, whose helper decimal-physical runs $@' >&2; exit 1; }
	mkdir -p $(DECIMAL_RUST_RUN)
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/decimal-physical -- $(CARGO_LEASED) $(NODE) $(abspath tests/cargo-test.mts) --copy $(DECIMAL_RUST_RUN) -- cargo test --no-run --message-format=json-render-diagnostics --offline --locked --manifest-path packages/rust/Cargo.toml -p polyspec-orm-tests --test all
	$(RUN_LONG) go-build/decimal-physical -- $(PUBLISH) $(abspath .runtime/bin/decimalmodel.test) go test -c -o @OUT@ ./packages/go/decimalmodel
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)
	. $(DECIMAL_ENV) && ORM_DECIMAL_RUST_RUN=$(DECIMAL_RUST_RUN) ORM_PYTHON=$(PYTHON_VENV)/bin/python POLYSPEC_ORM_EXTENSION=$(PHP_EXTENSION_LIBRARY) $(NODE) scripts/decimal-physical-check.mts
	rm -rf $(DECIMAL_RUST_RUN)

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
# public-interface-typescript-check runs the TypeScript recipe of public_interface (packages/ts/tests/public_interface-none.test.mjs),
# whose interface.symbols step reads the declarations with the TypeScript extractor that interface-typescript-check requires.
.PHONY: public-interface-typescript-check
public-interface-typescript-check: interface-typescript-check typescript-read
	$(NODE) --conditions=orm-test --test packages/ts/tests/public_interface-none.test.mjs
# interface-typescript-check names the missing TypeScript checker dependency before the self-test runs it, so a fresh
# checkout fails with the install step instead of a module resolution error.
interface-typescript-check:
	test -f packages/ts/testing/interfaces/typescript/node_modules/typescript/lib/typescript.js || { echo "interface-typescript-check: packages/ts/testing/interfaces/typescript/node_modules/typescript is missing; run make orm-install-interfaces-typescript"; exit 1; }

interface-check/self-test: php-vendor-check lease-tool typescript-current interface-typescript-check python-venv-check
	$(READ_TYPESCRIPT)
	ORM_PYTHON=$(PYTHON_VENV)/bin/python PATH="$(HOME)/.cargo/bin:$(PATH)" $(NODE) tests/interfaces/check/main.mts --self-test

# go-model-check fails when the Go models that orm-install-go wrote differ from what the entries of GO_MODELS_FILE generate (orm-gen gen --check).
go-model-check:
	$(RUN_LONG) go-model -- sh -c 'cd packages/go && $(GO) run ./cmd/orm-gen sets --check $(CURDIR)/$(GO_MODELS_FILE)'

# ts-model-check builds the TypeScript client, then fails when the models
# script scans a source that does not call models or misses one that does,
# or when a generated model set differs from the output of orm-gen gen --check.
ts-model-check: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/models-scan.mjs

perf-check:
	$(WITH_TEST_ENV) $(NODE) scripts/perf-test.mts

# scripts-typecheck checks the repository's TypeScript-based scripts (the .mts files of scripts/ and tests/, tsconfig.json) with tsc.
# Some scripts import the build output of packages/ts and packages/dbspec-language (through docs/.vitepress/dbs.ts), so
# they are checked after that build.
scripts-typecheck: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(RUN_LONG) scripts-typecheck -- node_modules/.bin/tsc -p tsconfig.json

ts-check: ts-check/hold ts-check/types ts-check/test
ts-check/hold: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
ts-check/types: ts-check/hold
	$(TSC_BUILD)
	$(RUN_LONG) typescript-check -- npm run typescript:check
ts-check/test: ts-check/hold
	$(WITH_TEST_ENV) npm run typescript:test

# ts-aes-auth-check builds the TypeScript client and runs only the AES authentication error cases.
ts-aes-auth-check: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/codec-aes-errors.test.mjs

# ts-codec-errors-check builds the TypeScript client and runs only codec error propagation cases.
ts-codec-errors-check: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/codec-errors.test.mjs

# sqlite-version-ts-check runs only the TypeScript SQLite native-version unit cases.
sqlite-version-ts-check: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/sqlite-version.test.mjs

# rust-build-environment-check runs the Rust build library path-resolution unit cases.
.PHONY: rust-build-environment-check
rust-build-environment-check: lease-tool
	ORM_BUILD_TEST_ROOT=$(abspath packages/rust/build) $(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-build --lib tests::build_environment::environment_subprocess -- --test-threads=1
	cd packages/rust && $(CARGO_TEST) rust-build-rerun-inputs -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-build --lib tests::rerun_inputs_name_the_set_file_and_every_document -- --test-threads=1 --exact

# rust-build-outdir-check runs the missing OUT_DIR propagation unit case.
.PHONY: rust-build-outdir-check
rust-build-outdir-check: lease-tool
	ORM_BUILD_TEST_ROOT=$(abspath packages/rust/build) $(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-build --lib tests::out_dir::load_requires_out_dir -- --test-threads=1

# rust-time-precision-check runs the Rust temporal precision bind cases without a database.
.PHONY: rust-time-precision-check
rust-time-precision-check: lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib db::time_precision_tests -- --test-threads=1

# rust-temporal-args-check runs the pure Rust temporal argument conversion cases without a database.
.PHONY: rust-temporal-args-check
rust-temporal-args-check: lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib args::temporal_args::temporal_arguments_become_canonical_text_before_binding -- --test-threads=1

# Compile the public Product request for MySQL/PostgreSQL and reject SQLite without a live database.
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
column-function-metadata-check/rust: lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib column_function_metadata -- --test-threads=1
column-function-metadata-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(RUN_LONG) column-function-metadata-typescript -- $(NODE) --test packages/ts/tests/column_function_metadata.mjs
column-function-metadata-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CoveragePlannerTest.php --filter 'ColumnFunction.*MissingPostValidationFieldIsInternal'
column-function-metadata-check/python: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_column_function_internal
column-function-metadata-check/php-extension: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(RUN_DIR)"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CoveragePlannerTest.php --filter 'ColumnFunction.*MissingPostValidationFieldIsInternal'; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ColumnFunctionMetadataTest.php
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
scalar-subquery-column-check/rust: lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib scalar_subquery_ -- --test-threads=1
scalar-subquery-column-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(RUN_LONG) scalar-subquery-column-typescript -- $(NODE) packages/ts/tests/scalar_subquery_type.mjs
scalar-subquery-column-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CoveragePlannerTest.php --filter ScalarSubquery
scalar-subquery-column-check/python: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_scalar_subquery_type
scalar-subquery-column-check/php-extension: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(RUN_DIR)"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CoveragePlannerTest.php --filter ScalarSubquery
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
page-cache-unit-check: lease-tool php-vendor-check php-models python-venv-check typescript-read model-types-php-extension-check page-cache-unit-check/go page-cache-unit-check/php page-cache-unit-check/typescript page-cache-unit-check/python page-cache-unit-check/rust
page-cache-unit-check/go:
	$(GO_TEST) ./packages/go/orm -run '^(TestPlanCachePagedReadBindsPageValues|TestCanonicalizeCompositeRequestParameterWalk)$$' -count=1
page-cache-unit-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/PlanCacheBoundTest.php
page-cache-unit-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/plan-cache-in.mjs
page-cache-unit-check/python: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.test_plan_cache_bound
page-cache-unit-check/rust:
	cd packages/rust && $(CARGO_TEST) page-cache-unit-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib paged_ -- --test-threads=1 --nocapture

# The PHP plan cache and statement cache retain at most 65535 placeholders in all (KSTD-7-3-4, limepie P-97).
.PHONY: php-plan-cache-memory-check
php-plan-cache-memory-check: lease-tool php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/PlanCacheMemoryTest.php

# Focused split-merge NULL boundary cases in each native client.

# A root IN list over the bind limit is split before it is planned (PRT-76): the count of 70300 values on SQLite stays
# within a memory bound in Go, TypeScript and Python, and Rust plans no statement over the bind limit, since no plan
# holds a bind slot per value of the list.
split-read-plan-check: split-read-plan-check/go split-read-plan-check/ts split-read-plan-check/python split-read-plan-check/rust

split-read-plan-check/go: lease-tool
	$(GO_TEST) ./packages/go/orm -run '^TestSplitRootInCountPlansNoStatementOverTheBindLimit$$' -count=1

split-read-plan-check/ts: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/split-plan.test.mjs

split-read-plan-check/python: python-venv-check python-models
	$(PYTHON_TESTS) -- packages.python.tests.test_split_plan

split-read-plan-check/rust:
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib model::split_plan_tests::split_root_in_count_plans_no_statement_over_the_bind_limit -- --test-threads=1

# The six native clients preserve typed composite collection components and the shared opaque encoding.
collection-composite-key-check: typescript-read php-vendor-check python-venv-check orm-install-php-extension-tools php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/collection-composite-key-check-$$$$"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	status=0; \
	$(RUN_TESTS) node --timeout 30 --test-concurrency=1 --test --test-name-pattern='collection-key/(composite-typed-components|nullable-composite-row-has-no-key)' packages/ts/tests/collection_identity.mjs || status=1; \
	$(GO_TEST) ./packages/go/orm -run '^(TestCompositeCollectionKeyTypedComponentsFromFixture|TestNullableCompositeRowHasNoCollectionKey)$$' -count=1 || status=1; \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CollectionIdentityTest.php --filter 'testCompositeComponentsPreserveTypedIdentityAndSharedEncoding|testNullCompositeRowHasNoCollectionKey' || status=1; \
	$(PYTHON_TESTS) -- packages.python.tests.test_collection_identity.CollectionIdentityTest.test_a_key_outside_the_python_key_type_is_refused packages.python.tests.test_collection_identity.CollectionIdentityTest.test_composite_components_preserve_typed_identity_and_shared_encoding packages.python.tests.test_collection_identity.CollectionIdentityTest.test_a_null_composite_row_has_no_collection_key || status=1; \
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm-tests --test all -- collection_identity::composite --test-threads=1 || status=1; \
	if $(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); then \
	  env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelAssemblyTest.php packages/php-ext/tests/CollectionTest.php --filter 'testTypedIdentityOrderedReplacementAndArrayViews|testCompositeComponentsPreserveTypedIdentityAndSharedEncoding|testNullCompositeRowHasNoCollectionKey' || status=1; \
	else status=1; fi; \
	test $$status -eq 0

# sqlite-version-rust-check runs only the Rust SQLite native-version unit cases.
sqlite-version-rust-check: lease-tool
	$(RUN_TESTS) cargo --cwd packages/rust -- --locked --offline -p polyspec-orm --lib db::sqlite_version_tests -- --test-threads=1

# ts-min-check runs the TypeScript tests on the lowest Node release that
# package.json supports. The npm of that release refuses the checkout, whose devEngines names the npm of mise.toml
# (EBADDEVENGINES), so the lowest Node runs the npm-cli.js of the npm of mise.toml; the .bin folder of that npm and then the
# lowest Node come first on PATH, so an npm that a script starts, such as npm run typescript:build in typescript:test, is the
# npm of mise.toml on the lowest Node.
ts-min-check: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(WITH_TEST_ENV) NODE_MIN="$$($(NODE) scripts/typescript/node-min.mts)" && NPM_DIR="$$($(KIT_TOOLS)/bin/mise where npm:npm)/node_modules" && NPM_CLI="$$NPM_DIR/npm/bin/npm-cli.js" && PATH="$$NPM_DIR/.bin:$$NODE_MIN:$$PATH" && export PATH && "$$NODE_MIN/node" --version && "$$NODE_MIN/node" "$$NPM_CLI" --version && "$$NODE_MIN/node" "$$NPM_CLI" run typescript:test

# dbspec-ts-check builds the TypeScript client and runs the shared dbspec vectors, set file vectors, plan vectors, Mermaid
# vectors, apply cleanup errors, the rules they do not yet cover, and the check that the Unicode word table matches its ranges at every code point.
# The stress document is run by make bench.
.PHONY: dbspec-ts-check
dbspec-ts-check: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/browser-entry.mjs packages/ts/tests/recipe_canonical.mjs packages/ts/tests/recipe_normalize.mjs packages/ts/tests/recipe_positions.mjs packages/ts/tests/recipe_invalid.mjs packages/ts/tests/recipe_files.mjs packages/ts/tests/dbspec_read_set-none.test.mjs packages/ts/tests/dbspec-set-edges.mjs packages/ts/tests/recipe_set_parse.mjs packages/ts/tests/recipe_hashes.mjs packages/ts/tests/recipe_sets.mjs packages/ts/tests/dbspec_show_create_introspect-none.test.mjs packages/ts/tests/dbspec-rules.mjs packages/ts/tests/dbspec_render_statements-none.test.mjs packages/ts/tests/dbspec_dialect_refusal-none.test.mjs packages/ts/tests/dbspec-plan-cases.mjs packages/ts/tests/dbspec-plan-invalid.mjs packages/ts/tests/dbspec-plan-chains.mjs packages/ts/tests/dbspec-plan-parse.mjs packages/ts/tests/dbspec-plan-comparisons.mjs packages/ts/tests/dbspec-add-tables-steps.mjs packages/ts/tests/dbspec-mermaid-none.test.mjs packages/ts/tests/dbspec-unicode.mjs packages/ts/tests/dbspec-show-create.mjs
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/dbspec_render_physical-mysql.test.mjs packages/ts/tests/dbspec_render_physical-postgres.test.mjs packages/ts/tests/dbspec_render_physical-sqlite.test.mjs packages/ts/tests/dbspec_render_physical-markdown.test.mjs packages/ts/tests/dbspec_set_decimal-mysql.test.mjs packages/ts/tests/dbspec_set_decimal-postgres.test.mjs packages/ts/tests/dbspec_set_decimal-sqlite.test.mjs packages/ts/tests/dbspec_set_decimal-markdown.test.mjs

# dbspec-language-check builds the TypeScript client and @polyspec/dbspec-language, and checks that the language service's module graph does not reach
# node modules, Node globals, or drivers, the format and hash of shared vectors, tokens and UTF-16 ranges, and the tests/editor
# fixtures.
# It also runs resolveSet with the node:fs host over the set-files.json vectors and set resolution, and dbspec-fmt over
# its modes, exit codes, stderr lines and the --write and --check of the editor fixtures.
.PHONY: dbspec-language-check
# dbspec-lsp-check builds the language server and runs its stdio sessions over the editor fixtures and file trees.
dbspec-lsp-check: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(NPM) run --workspace @polyspec/dbspec-lsp build
	$(NODE) --test packages/dbspec-lsp/tests/session.test.mjs

# dbspec-codemirror-check builds the CodeMirror adapter and runs the editor fixtures through an EditorState.
dbspec-codemirror-check: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(NPM) run --workspace @polyspec/dbspec-codemirror build
	$(NODE) --test packages/dbspec-codemirror/tests/fixtures.test.mjs

# dbspec-vscode-check builds the VS Code extension (the type check and the esbuild bundles of the extension and the
# bundled language server) and checks its manifest and bundles without VS Code.
dbspec-vscode-check: lease-tool orm-codes-typescript
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

dbspec-language-check: lease-tool orm-codes-typescript
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
orm-install-cli: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(ONLINE) $(NODE) scripts/install-cli.mts install --prefix $(CLI_PREFIX)

uninstall-cli:
	$(NODE) scripts/install-cli.mts uninstall --prefix $(CLI_PREFIX)

# orm-install-cli-check installs dbspec-fmt into a temporary prefix with scripts/install-cli.mts, runs it and uninstalls it
# (tests/cli/install-cli.test.mts); the install reads the registry.
orm-install-cli-check: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(ONLINE) $(NODE) --test tests/cli/install-cli.test.mts

# dbspec-go-check runs all tests of the Go dbspec engine package (packages/go/engine/dbspec): the shared vectors of the recipes of tests/dbspec (hashes.json and sets.json),
# its own rule cases, manifest, statements, plans, comparisons, Mermaid vectors, apply cleanup errors,
# the case harness, and that it rejects, with the position, every missing or wrongly typed field of every vector file. The stress
# document (TestStressDocument, build tag bench) is run by make bench.
.PHONY: dbspec-go-check dbspec-go-check/engine dbspec-go-check/unicode
dbspec-go-check: dbspec-go-check/engine dbspec-go-check/unicode dbspec-go-check/render-physical
dbspec-go-check/engine:
	$(RUN_TESTS) go --cwd packages/go -- -count=1 -timeout=0 ./engine/dbspec -count=1
# dbspec-go-check/render-physical runs the rendered statements of tests/dbspec/ddl.json with their behavior steps on MySQL, PostgreSQL and
# SQLite, through the recipe tests/dbspec/render-physical.json; an unset ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN fails it by name.
dbspec-go-check/render-physical: flowmark-check
	$(WITH_TEST_ENV) $(RUN_TESTS) go --cwd packages/go -- -count=1 -timeout=0 ./orm -run '^TestRecipeDbspec(RenderPhysical|SetDecimal)(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
# dbspec-go-check/unicode checks that the three table files written by the generator of tests/dbspec/unicode match the current Go tables, and that the C extension and the Python module
# give the same classification as Go at every code point.
dbspec-go-check/unicode:
	$(RUN_TESTS) go --cwd . -- -count=1 -timeout=0 ./tests/dbspec/unicode -count=1

docs-dev:
	$(NPM) run docs:dev

# docs-build compiles the TypeScript client (npm run typescript:build), which imports the generated codes.ts.
docs-build: orm-codes-typescript
	$(NPM) run docs:build

# docs-ci runs, as the make orm-check runner, the document checks (docs-verify-idempotent, docs-site-check) that the docs job of CI (ci.yml) runs;
# docs-check is a gate of kit, which the kit job runs (CI_KIT_GATES), so the docs job does not run it again (CR9)
# without a test server (scripts/check/run.mts `-`). It runs the next target even when one fails, and keeps a log and summary for each target
# in .runtime/check/<run id>/report, which the workflow uploads as the job summary and an artifact.
docs-ci:
	$(NODE) scripts/check/run.mts --job-summary - docs-verify-idempotent docs-site-check

orm-docs-check: orm-codes-typescript
	$(NPM) run docs:check

# docs-check is the kit task of the documents (config/documents.json): the pairs, the stamps and the Markdown checks of the documents.
# It runs no site build, so a land does not pay for docs:build; the site build and the checks that read the built site run in
# docs-site-check (KSTD-5-48).
docs-check: docs-parse-check

# docs-parse-check runs the unit cases of the Markdown table reader (scripts/docs/tables.mts), each on a fixture that
# tests/docs/fixture.mts writes into var/.
docs-parse-check:
	$(NODE) --test tests/docs/tables.test.mts

# docs-site-check runs the VitePress site build (orm-docs-check) and the checks that read the built site (scripts/docs/check.mts). The
# unit cases of that reader (html.test.mts) run first and fail before the build when the reader is wrong. The owner rules
# (config/owner-checks.json) select it for the changed paths under docs/.
docs-site-check: docs-site-parse-check orm-docs-check

docs-site-parse-check:
	$(NODE) --test tests/docs/html.test.mts

docs-verify-idempotent: orm-codes-typescript
	$(NPM) run docs:verify-idempotent

docs-rules-check:
	$(NPM) run docs:rules-check

docs-implementation-count-check:
	$(NODE) --test scripts/docs/rules-filter.test.mts
	$(NPM) run docs:rules-check -- --only docs.implementation-count

# docs-dbs-check runs the unit cases of the dbs fence (docs/.vitepress/dbs.ts) after building the packages it reads, and
# type-checks the site's TypeScript with docs/.vitepress/tsconfig.json, the project that make lint-ts also judges it by.
docs-dbs-check: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(TSC_BUILD)
	$(NPM) run --workspace @polyspec/dbspec-language build
	$(RUN_LONG) docs-typecheck -- node_modules/.bin/tsc -p docs/.vitepress/tsconfig.json
	$(NODE) --test tests/docs/dbs-fence.test.mts

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

# codec-check runs the codec recipes of tests/codec without a database in the clients that bind them (docs/spec/feature-coverage.md
# FCV-3), and the test of each client that writes an ordered-json value, which no recipe value is (COD-16; the TypeScript one is
# in ts-codec-errors-check): each part runs its client's entries, so one that fails names its client while the others still
# run (make -k).
.PHONY: codec-check codec-check/go codec-check/rust codec-check/typescript codec-check/python codec-check/php codec-check/php-extension
codec-check: codec-check/go codec-check/rust codec-check/typescript codec-check/python codec-check/php codec-check/php-extension
codec-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_none
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_integer_beyond_i64_none
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_bytes_value_none
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_non_finite_value_none
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_json_depth_none
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_stack_depth
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_yaml_reader_cause
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_lone_surrogate_none
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_map_keys_none
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_codec_styled_unset_none
codec-check/go:
	$(GO_TEST) ./packages/go/orm -run '^(TestRecipeCodecNone|TestRecipeCodecIntegerBeyondI64None|TestRecipeCodecBytesValueNone|TestRecipeCodecNonFiniteValueNone|TestRecipeCodecJsonDepthNone|TestRecipeCodecRawTextNone|TestRecipeCodecMapKeysNone|TestRecipeCodecStyledUnsetNone)$$' -count=1
codec-check/rust: lease-tool
	cd packages/rust && $(CARGO_TEST) codec-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- codec_none:: codec_integer_beyond_i64_none:: codec_json_depth_none::
codec-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/codec-none.test.mjs packages/ts/tests/codec-integer-beyond-i64-none.test.mjs packages/ts/tests/codec-bytes-value-none.test.mjs packages/ts/tests/codec-non-finite-value-none.test.mjs packages/ts/tests/codec-json-depth-none.test.mjs packages/ts/tests/codec-lone-surrogate-none.test.mjs packages/ts/tests/codec-undefined-member-none.test.mjs
codec-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecRecipeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecBytesValueRecipeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecNonFiniteValueRecipeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecJsonDepthRecipeTest.php
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecRawTextRecipeTest.php
codec-check/php-extension: php-vendor-check build-php-ext
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CodecRecipeTestExtensionTest.php
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CodecBytesValueRecipeExtensionTest.php
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CodecNonFiniteValueRecipeExtensionTest.php
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CodecJsonDepthRecipeExtensionTest.php
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CodecRawTextRecipeExtensionTest.php

# ir-validate-check runs the request validation recipe, tests/ir/validate.json, in each runtime (FCV-3): each part runs the entry of its
# runtime that calls the recipe helper, without a database; the ir.validate steps check every request with the validator (FCV-4).
.PHONY: ir-validate-check ir-validate-check/go ir-validate-check/rust ir-validate-check/rust/recipe ir-validate-check/typescript ir-validate-check/python ir-validate-check/php ir-validate-check/php-extension
ir-validate-check: ir-validate-check/go ir-validate-check/rust ir-validate-check/typescript ir-validate-check/python ir-validate-check/php ir-validate-check/php-extension
ir-validate-check/go:
	$(GO_TEST) ./packages/go/engine/ir -run 'TestRecipeIRValidateNone' -count=1
ir-validate-check/rust: ir-validate-check/rust/recipe
ir-validate-check/rust/recipe: lease-tool
	cd packages/rust && $(CARGO_TEST) ir-validate-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) -p polyspec-orm-tests --test all -- ir_validate_none::
ir-validate-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/engine.mjs
ir-validate-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_ir_validate_none
ir-validate-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/IrValidateRecipeTest.php
ir-validate-check/php-extension: php-vendor-check build-php-ext
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/IrValidateRecipeTestExtensionTest.php

# catalog-connection-check runs the recipe contracts/fixtures/catalog_connection/catalog_connection.json on the three databases
# in the six clients (docs/spec/feature-coverage.md FCV-3): each part runs its client's three entries on the servers of TEST_ENV,
# so one that fails names its client while the others still run (make -k).
.PHONY: catalog-connection-check catalog-connection-check/go catalog-connection-check/rust catalog-connection-check/typescript catalog-connection-check/python catalog-connection-check/php catalog-connection-check/php-extension
catalog-connection-check: catalog-connection-check/go catalog-connection-check/rust catalog-connection-check/typescript catalog-connection-check/python catalog-connection-check/php catalog-connection-check/php-extension
catalog-connection-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeCatalogConnection(Mysql|Postgres|Sqlite|Markdown|SqliteOnly|SqliteOnlyMarkdown)$$' -count=1
catalog-connection-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) catalog-connection-check -- $(RECIPE_RUST_TEST) --test all -- catalog_connection_mysql:: catalog_connection_postgres:: catalog_connection_sqlite:: catalog_connection_markdown:: catalog_connection_sqlite_only:: catalog_connection_sqlite_only_markdown::
# statement-events-check runs the recipe contracts/fixtures/statement_events/statement_events.json on the three databases
# in the six clients (docs/spec/feature-coverage.md FCV-3), as catalog-connection-check does. Each part runs its client's
# three entries on the servers of TEST_ENV, so one that fails names its client while the others still run (make -k).
.PHONY: statement-events-check statement-events-check/go statement-events-check/rust statement-events-check/typescript statement-events-check/python statement-events-check/php statement-events-check/php-extension
statement-events-check: statement-events-check/go statement-events-check/rust statement-events-check/typescript statement-events-check/python statement-events-check/php statement-events-check/php-extension
statement-events-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeStatementEvents(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
statement-events-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) statement-events-check -- $(RECIPE_RUST_TEST) --test all -- statement_events_mysql:: statement_events_postgres:: statement_events_sqlite:: statement_events_markdown::
statement-events-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/statement_events-mysql.test.mjs packages/ts/tests/statement_events-postgres.test.mjs packages/ts/tests/statement_events-sqlite.test.mjs packages/ts/tests/statement_events-markdown.test.mjs
statement-events-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_statement_events_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_statement_events_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_statement_events_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_statement_events_markdown
statement-events-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/StatementEventsRecipeTest.php
statement-events-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/StatementEventsRecipeTestExtensionTest.php
catalog-connection-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/catalog_connection-mysql.test.mjs packages/ts/tests/catalog_connection-postgres.test.mjs packages/ts/tests/catalog_connection-sqlite.test.mjs packages/ts/tests/catalog_connection-markdown.test.mjs packages/ts/tests/catalog_connection-sqlite-only.test.mjs packages/ts/tests/catalog_connection-sqlite-only-markdown.test.mjs
catalog-connection-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_catalog_connection_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_catalog_connection_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_catalog_connection_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_catalog_connection_markdown
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_catalog_connection_sqlite_only
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_catalog_connection_sqlite_only_markdown
catalog-connection-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CatalogConnectionRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CatalogConnectionSqliteOnlyRecipeTest.php
catalog-connection-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CatalogConnectionRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CatalogConnectionSqliteOnlyRecipeTestExtensionTest.php

# schema-install-check runs the recipe contracts/fixtures/schema_install/schema_install.json on the three databases in the six
# clients (docs/spec/feature-coverage.md FCV-3): each part runs its client's three entries on the servers of TEST_ENV.
.PHONY: schema-install-check schema-install-check/go schema-install-check/typescript schema-install-check/python schema-install-check/php schema-install-check/php-extension schema-install-check/rust
schema-install-check: schema-install-check/go schema-install-check/typescript schema-install-check/python schema-install-check/php schema-install-check/php-extension schema-install-check/rust
schema-install-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeSchemaInstall(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
schema-install-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/schema_install-mysql.test.mjs packages/ts/tests/schema_install-postgres.test.mjs packages/ts/tests/schema_install-sqlite.test.mjs packages/ts/tests/schema_install-markdown.test.mjs
schema-install-check/python: python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_schema_install_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_schema_install_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_schema_install_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_schema_install_markdown
schema-install-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/SchemaInstallRecipeTest.php
schema-install-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/SchemaInstallRecipeTestExtensionTest.php
schema-install-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) schema-install-check -- $(RECIPE_RUST_TEST) --test all -- schema_install_mysql:: schema_install_postgres:: schema_install_sqlite:: schema_install_markdown::

CHECK_TARGETS += schema-install-check/go
CI_TARGETS_client_db_go += schema-install-check/go
CHECK_TARGETS += schema-install-check/typescript
CI_TARGETS_client_db_typescript += schema-install-check/typescript
CHECK_TARGETS += schema-install-check/python
CI_TARGETS_client_db_python += schema-install-check/python
CHECK_TARGETS += schema-install-check/php
CI_TARGETS_client_db_php += schema-install-check/php
CHECK_TARGETS += schema-install-check/php-extension
CI_TARGETS_client_db_php_extension += schema-install-check/php-extension
CHECK_TARGETS += schema-install-check/rust
CI_TARGETS_client_db_rust += schema-install-check/rust

# dsn-connection-check runs the recipe contracts/fixtures/dsn_connection/dsn_connection.json on the three databases in the
# six clients (docs/spec/feature-coverage.md FCV-3), each part on the servers of TEST_ENV, as catalog-connection-check does.
.PHONY: dsn-connection-check dsn-connection-check/go dsn-connection-check/rust dsn-connection-check/typescript dsn-connection-check/python dsn-connection-check/php dsn-connection-check/php-extension
dsn-connection-check: dsn-connection-check/go dsn-connection-check/rust dsn-connection-check/typescript dsn-connection-check/python dsn-connection-check/php dsn-connection-check/php-extension
dsn-connection-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeDsnConnection(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
dsn-connection-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) dsn-connection-check -- $(RECIPE_RUST_TEST) --test all -- dsn_connection_mysql:: dsn_connection_postgres:: dsn_connection_sqlite:: dsn_connection_markdown::
dsn-connection-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/dsn_connection-mysql.test.mjs packages/ts/tests/dsn_connection-postgres.test.mjs packages/ts/tests/dsn_connection-sqlite.test.mjs packages/ts/tests/dsn_connection-markdown.test.mjs
dsn-connection-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_dsn_connection_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_dsn_connection_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_dsn_connection_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_dsn_connection_markdown
dsn-connection-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DsnConnectionRecipeTest.php
dsn-connection-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DsnConnectionRecipeTestExtensionTest.php
# raw-text-check runs the recipe contracts/fixtures/raw_text/raw_text.json on the four databases in the three clients whose host
# string holds a text that is not UTF-8 (PRT-67); a TypeScript, Python or Rust string holds only Unicode text.
.PHONY: raw-text-check raw-text-check/go raw-text-check/php raw-text-check/php-extension
raw-text-check: raw-text-check/go raw-text-check/php raw-text-check/php-extension
raw-text-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeRawText(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
raw-text-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RawTextRecipeTest.php
raw-text-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/RawTextRecipeTestExtensionTest.php
# connection-pool-check runs the recipe contracts/fixtures/connection_pool/connection_pool.json on the four databases in the four
# clients that keep a pool (CFG-4, CFG-5, DIA-199); PHP and the PHP extension keep none.
.PHONY: connection-pool-check connection-pool-check/go connection-pool-check/rust connection-pool-check/typescript connection-pool-check/python
connection-pool-check: connection-pool-check/go connection-pool-check/rust connection-pool-check/typescript connection-pool-check/python
connection-pool-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeConnectionPool(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
connection-pool-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) connection-pool-check -- $(RECIPE_RUST_TEST) --test all -- connection_pool_mysql:: connection_pool_postgres:: connection_pool_sqlite:: connection_pool_markdown::
connection-pool-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/connection_pool-mysql.test.mjs packages/ts/tests/connection_pool-postgres.test.mjs packages/ts/tests/connection_pool-sqlite.test.mjs packages/ts/tests/connection_pool-markdown.test.mjs
connection-pool-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_connection_pool_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_connection_pool_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_connection_pool_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_connection_pool_markdown
# model-queries-check runs the recipe contracts/fixtures/model_queries/model_queries.json on the three databases in the six
# clients (docs/spec/feature-coverage.md FCV-3), with the same split and the same servers as catalog-connection-check.
.PHONY: model-queries-check model-queries-check/go model-queries-check/rust model-queries-check/typescript model-queries-check/python model-queries-check/php model-queries-check/php-extension
model-queries-check: model-queries-check/go model-queries-check/rust model-queries-check/typescript model-queries-check/python model-queries-check/php model-queries-check/php-extension
model-queries-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeModelQueries(Chain)?(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
model-queries-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) model-queries-check -- $(RECIPE_RUST_TEST) --test all -- model_queries_mysql:: model_queries_postgres:: model_queries_sqlite:: model_queries_markdown:: model_queries_chain_mysql:: model_queries_chain_postgres:: model_queries_chain_sqlite:: model_queries_chain_markdown::
model-queries-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/model_queries-mysql.test.mjs packages/ts/tests/model_queries-postgres.test.mjs packages/ts/tests/model_queries-sqlite.test.mjs packages/ts/tests/model_queries-markdown.test.mjs packages/ts/tests/model_queries_chain-mysql.test.mjs packages/ts/tests/model_queries_chain-postgres.test.mjs packages/ts/tests/model_queries_chain-sqlite.test.mjs packages/ts/tests/model_queries_chain-markdown.test.mjs
model-queries-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_queries_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_queries_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_queries_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_queries_markdown
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_queries_chain_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_queries_chain_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_queries_chain_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_model_queries_chain_markdown
model-queries-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelQueriesRecipeTest.php packages/php/tests/ModelQueriesChainRecipeTest.php
model-queries-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ModelQueriesRecipeTestExtensionTest.php packages/php-ext/tests/ModelQueriesChainRecipeTestExtensionTest.php
CHECK_TARGETS += model-queries-check/go model-queries-check/rust model-queries-check/typescript model-queries-check/python model-queries-check/php model-queries-check/php-extension

# constraints-and-relations-check runs the recipe contracts/fixtures/constraints_and_relations/constraints_and_relations.json on the three databases in the six
# clients (docs/spec/feature-coverage.md FCV-3), with the same split and the same servers as catalog-connection-check.
.PHONY: constraints-and-relations-check constraints-and-relations-check/go constraints-and-relations-check/rust constraints-and-relations-check/typescript constraints-and-relations-check/python constraints-and-relations-check/php constraints-and-relations-check/php-extension
constraints-and-relations-check: constraints-and-relations-check/go constraints-and-relations-check/rust constraints-and-relations-check/typescript constraints-and-relations-check/python constraints-and-relations-check/php constraints-and-relations-check/php-extension
constraints-and-relations-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipe(ConstraintsAndRelations|ImmutableWrite)(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
constraints-and-relations-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) constraints-and-relations-check -- $(RECIPE_RUST_TEST) --test all -- constraints_and_relations_mysql:: constraints_and_relations_postgres:: constraints_and_relations_sqlite:: constraints_and_relations_markdown:: immutable_write_mysql:: immutable_write_postgres:: immutable_write_sqlite:: immutable_write_markdown::
constraints-and-relations-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/constraints_and_relations-mysql.test.mjs packages/ts/tests/constraints_and_relations-postgres.test.mjs packages/ts/tests/constraints_and_relations-sqlite.test.mjs packages/ts/tests/constraints_and_relations-markdown.test.mjs packages/ts/tests/immutable_write-mysql.test.mjs packages/ts/tests/immutable_write-postgres.test.mjs packages/ts/tests/immutable_write-sqlite.test.mjs packages/ts/tests/immutable_write-markdown.test.mjs
constraints-and-relations-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_constraints_and_relations_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_constraints_and_relations_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_constraints_and_relations_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_constraints_and_relations_markdown
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_immutable_write_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_immutable_write_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_immutable_write_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_immutable_write_markdown
constraints-and-relations-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ConstraintsAndRelationsRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ImmutableWriteRecipeTest.php
constraints-and-relations-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConstraintsAndRelationsRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ImmutableWriteRecipeTestExtensionTest.php
CHECK_TARGETS += constraints-and-relations-check/go constraints-and-relations-check/rust constraints-and-relations-check/typescript constraints-and-relations-check/python constraints-and-relations-check/php constraints-and-relations-check/php-extension


# parameter-chunking-check/go runs the recipe contracts/fixtures/parameter_chunking/parameter_chunking.json on the three
# databases in Go (docs/spec/feature-coverage.md FCV-3 and FCV-4): the entries TestRecipeParameterChunking<Db> of packages/go/orm.
.PHONY: parameter-chunking-check/go
parameter-chunking-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeParameterChunking(Mysql|Postgres|Sqlite|Markdown)$$' -count=1

# aes-rotation-check/go runs the recipe contracts/fixtures/aes_rotation/aes_rotation.json on the three databases in Go
# (docs/spec/feature-coverage.md FCV-3 and FCV-4): the entries TestRecipeAesRotation<Db> of packages/go/orm.
.PHONY: aes-rotation-check/go
aes-rotation-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeAesRotation(Mysql|Postgres|Sqlite|Markdown)$$' -count=1

# aes-rotation-check/typescript runs the recipe contracts/fixtures/aes_rotation/aes_rotation.json on the three databases in
# TypeScript (docs/spec/feature-coverage.md FCV-3 and FCV-4): the entries aes_rotation-<database>.test.mjs.
.PHONY: aes-rotation-check/typescript
aes-rotation-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/aes_rotation-mysql.test.mjs packages/ts/tests/aes_rotation-postgres.test.mjs packages/ts/tests/aes_rotation-sqlite.test.mjs packages/ts/tests/aes_rotation-markdown.test.mjs

# aes-rotation-check/python runs the recipe contracts/fixtures/aes_rotation/aes_rotation.json on the three databases in Python
# (docs/spec/feature-coverage.md FCV-3 and FCV-4): the entries test_aes_rotation_<database>.py of packages/python/tests.
.PHONY: aes-rotation-check/python
aes-rotation-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_aes_rotation_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_aes_rotation_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_aes_rotation_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_aes_rotation_markdown

# audit-triggers-check runs the recipes contracts/fixtures/audit_triggers/audit_triggers.json and contracts/fixtures/external_audit/external_audit.json on the three databases in the six
# clients (docs/spec/feature-coverage.md FCV-3 and FCV-4), as request-hook-check does.
.PHONY: audit-triggers-check/go audit-triggers-check/rust audit-triggers-check/typescript audit-triggers-check/python audit-triggers-check/php audit-triggers-check/php-extension
audit-triggers-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipe(AuditTriggers|ExternalAudit)(Mysql|Postgres|Sqlite|Markdown)$$' -count=1
audit-triggers-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) audit-triggers-check -- $(RECIPE_RUST_TEST) --test all -- audit_triggers_mysql:: audit_triggers_postgres:: audit_triggers_sqlite:: audit_triggers_markdown:: external_audit_mysql:: external_audit_postgres:: external_audit_sqlite:: external_audit_markdown::
audit-triggers-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/audit_triggers-mysql.test.mjs packages/ts/tests/audit_triggers-postgres.test.mjs packages/ts/tests/audit_triggers-sqlite.test.mjs packages/ts/tests/audit_triggers-markdown.test.mjs packages/ts/tests/external_audit-mysql.test.mjs packages/ts/tests/external_audit-postgres.test.mjs packages/ts/tests/external_audit-sqlite.test.mjs packages/ts/tests/external_audit-markdown.test.mjs
audit-triggers-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_audit_triggers_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_audit_triggers_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_audit_triggers_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_audit_triggers_markdown
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_external_audit_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_external_audit_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_external_audit_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_external_audit_markdown
audit-triggers-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/AuditTriggersRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ExternalAuditRecipeTest.php
audit-triggers-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/AuditTriggersRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ExternalAuditRecipeTestExtensionTest.php

# request-hook-check/go runs the recipe contracts/fixtures/request_hook/request_hook.json on the three databases in Go
# (docs/spec/feature-coverage.md FCV-3 and FCV-4): the entries TestRecipeRequestHook<Db> of packages/go/orm.
.PHONY: request-hook-check/go
request-hook-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) FLOWMARK=$(FLOWMARK) $(GO_TEST) ./packages/go/orm -run '^TestRecipeRequestHook(Mysql|Postgres|Sqlite|Markdown)$$' -count=1

# parameter-chunking-check/rust runs the recipe contracts/fixtures/parameter_chunking/parameter_chunking.json on the three
# databases in Rust (docs/spec/feature-coverage.md FCV-3 and FCV-4), each database as one test target of packages/rust/tests.
.PHONY: parameter-chunking-check/rust
parameter-chunking-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) parameter-chunking-check -- $(RECIPE_RUST_TEST) --test all -- parameter_chunking_mysql:: parameter_chunking_postgres:: parameter_chunking_sqlite:: parameter_chunking_markdown::

# aes-rotation-check/rust runs the recipe contracts/fixtures/aes_rotation/aes_rotation.json on the three databases in Rust
# (docs/spec/feature-coverage.md FCV-3 and FCV-4), each database as one test target of packages/rust/tests.
.PHONY: aes-rotation-check/rust
aes-rotation-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) aes-rotation-check -- $(RECIPE_RUST_TEST) --test all -- aes_rotation_mysql:: aes_rotation_postgres:: aes_rotation_sqlite:: aes_rotation_markdown::

# request-hook-check/rust runs the recipe contracts/fixtures/request_hook/request_hook.json on the three databases in Rust
# (docs/spec/feature-coverage.md FCV-3 and FCV-4), each database as one test target of packages/rust/tests.
.PHONY: request-hook-check/rust
request-hook-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && FLOWMARK=$(FLOWMARK) $(CARGO_TEST) request-hook-check -- $(RECIPE_RUST_TEST) --test all -- request_hook_markdown:: request_hook_mysql:: request_hook_postgres:: request_hook_sqlite::

# request-hook-check/typescript runs the recipe contracts/fixtures/request_hook/request_hook.json on the three databases in
# TypeScript (docs/spec/feature-coverage.md FCV-3 and FCV-4), with the native cases that a declarative step cannot observe.
.PHONY: request-hook-check/typescript
request-hook-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) FLOWMARK=$(FLOWMARK) $(RECIPE_TS_TEST) packages/ts/tests/request_hook-markdown.test.mjs packages/ts/tests/request_hook-mysql.test.mjs packages/ts/tests/request_hook-postgres.test.mjs packages/ts/tests/request_hook-sqlite.test.mjs

# parameter-chunking-check/typescript runs the recipe contracts/fixtures/parameter_chunking/parameter_chunking.json on the
# three databases in TypeScript (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: parameter-chunking-check/typescript
parameter-chunking-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/parameter_chunking-mysql.test.mjs packages/ts/tests/parameter_chunking-postgres.test.mjs packages/ts/tests/parameter_chunking-sqlite.test.mjs packages/ts/tests/parameter_chunking-markdown.test.mjs

# request-hook-check/python runs the recipe contracts/fixtures/request_hook/request_hook.json on the three databases in Python
# (docs/spec/feature-coverage.md FCV-3 and FCV-4), with the native cases that a declarative step cannot observe in
# test_request_hook.py (a native owner, not this check).
.PHONY: request-hook-check/python
request-hook-check/python: lease-tool python-venv-check flowmark-check
	FLOWMARK=$(FLOWMARK) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_request_hook_markdown
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_request_hook_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_request_hook_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_request_hook_sqlite

# parameter-chunking-check/python runs the recipe contracts/fixtures/parameter_chunking/parameter_chunking.json on the three
# databases in Python (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: parameter-chunking-check/python
parameter-chunking-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_parameter_chunking_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_parameter_chunking_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_parameter_chunking_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_parameter_chunking_markdown

# request-hook-check/php runs the recipe contracts/fixtures/request_hook/request_hook.json on the three databases in PHP
# (docs/spec/feature-coverage.md FCV-3 and FCV-4), one entry per database, with the native cases that a declarative step
# cannot observe in request_hook_cases.php (feature coverage, not this check).
.PHONY: request-hook-check/php
request-hook-check/php: lease-tool php-vendor-check php-models flowmark-check
	FLOWMARK=$(FLOWMARK) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RequestHookMarkdownRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RequestHookMysqlRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RequestHookPostgresRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/RequestHookSqliteRecipeTest.php

# parameter-chunking-check/php runs the recipe contracts/fixtures/parameter_chunking/parameter_chunking.json on the three
# databases in PHP (docs/spec/feature-coverage.md FCV-3 and FCV-4), one entry per database.
.PHONY: parameter-chunking-check/php
parameter-chunking-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ParameterChunkingMysqlTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ParameterChunkingPostgresTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ParameterChunkingSqliteTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ParameterChunkingMarkdownTest.php

# parameter-chunking-check/php-extension runs the recipe contracts/fixtures/parameter_chunking/parameter_chunking.json on the
# three databases in the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4), one entry per database.
.PHONY: parameter-chunking-check/php-extension
parameter-chunking-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ParameterChunkingMysqlRecipeExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ParameterChunkingPostgresRecipeExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ParameterChunkingSqliteRecipeExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ParameterChunkingMarkdownRecipeExtensionTest.php

# aes-rotation-check/php runs the recipe contracts/fixtures/aes_rotation/aes_rotation.json on the three databases in PHP
# (docs/spec/feature-coverage.md FCV-3 and FCV-4), one entry per database.
.PHONY: aes-rotation-check/php
aes-rotation-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/AesRotationMysqlTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/AesRotationPostgresTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/AesRotationSqliteTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/AesRotationMarkdownTest.php

# aes-rotation-check/php-extension runs the recipe contracts/fixtures/aes_rotation/aes_rotation.json on the three databases in
# the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4), one entry per database.
.PHONY: aes-rotation-check/php-extension
aes-rotation-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/AesRotationMysqlRecipeExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/AesRotationPostgresRecipeExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/AesRotationSqliteRecipeExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/AesRotationMarkdownRecipeExtensionTest.php

# request-hook-check/php-extension runs the recipe contracts/fixtures/request_hook/request_hook.json on the three databases in
# the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4), one entry per database, with the native cases that a
# declarative step cannot observe in RequestHookTestExtensionTest.php (not this check).
.PHONY: request-hook-check/php-extension
request-hook-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	FLOWMARK=$(FLOWMARK) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/RequestHookMarkdownRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/RequestHookMysqlRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/RequestHookPostgresRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/RequestHookSqliteRecipeTestExtensionTest.php

# conformance-verification-check/go runs the recipe contracts/fixtures/conformance_verification/conformance_verification.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: conformance-verification-check/go
conformance-verification-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeConformanceVerification(Mysql|Postgres|Sqlite|Markdown)$$' -count=1

# conformance-verification-check/rust runs the recipe contracts/fixtures/conformance_verification/conformance_verification.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: conformance-verification-check/rust
conformance-verification-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) conformance-verification-check -- $(RECIPE_RUST_TEST) --test all -- conformance_verification_mysql:: conformance_verification_postgres:: conformance_verification_sqlite:: conformance_verification_markdown::

# conformance-verification-check/typescript runs the recipe contracts/fixtures/conformance_verification/conformance_verification.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4), and conformance_verification_dynamic.json, which Go and Rust type at compile time.
.PHONY: conformance-verification-check/typescript
conformance-verification-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/conformance_verification-mysql.test.mjs packages/ts/tests/conformance_verification-postgres.test.mjs packages/ts/tests/conformance_verification-sqlite.test.mjs packages/ts/tests/conformance_verification-markdown.test.mjs packages/ts/tests/conformance_verification_dynamic-mysql.test.mjs packages/ts/tests/conformance_verification_dynamic-postgres.test.mjs packages/ts/tests/conformance_verification_dynamic-sqlite.test.mjs packages/ts/tests/conformance_verification_dynamic-markdown.test.mjs

# conformance-verification-check/python runs the recipe contracts/fixtures/conformance_verification/conformance_verification.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4), and conformance_verification_dynamic.json, which Go and Rust type at compile time.
.PHONY: conformance-verification-check/python
conformance-verification-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_conformance_verification_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_conformance_verification_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_conformance_verification_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_conformance_verification_markdown
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_conformance_verification_dynamic_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_conformance_verification_dynamic_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_conformance_verification_dynamic_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_conformance_verification_dynamic_markdown

# conformance-verification-check/php runs the recipe contracts/fixtures/conformance_verification/conformance_verification.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4), and conformance_verification_dynamic.json, which Go and Rust type at compile time.
.PHONY: conformance-verification-check/php
conformance-verification-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceVerificationMysqlRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceVerificationPostgresRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceVerificationSqliteRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceVerificationMarkdownRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceVerificationDynamicRecipeTest.php

# conformance-verification-check/php-extension runs the recipe contracts/fixtures/conformance_verification/conformance_verification.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4), and conformance_verification_dynamic.json, which Go and Rust type at compile time.
.PHONY: conformance-verification-check/php-extension
conformance-verification-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConformanceVerificationMysqlRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConformanceVerificationPostgresRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConformanceVerificationSqliteRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConformanceVerificationMarkdownRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConformanceVerificationDynamicRecipeTestExtensionTest.php

# complex-query-check/go runs the recipe contracts/fixtures/complex_query/complex_query.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: complex-query-check/go
complex-query-check/go: lease-tool flowmark-check
	$(WITH_TEST_ENV) $(GO_TEST) ./packages/go/orm -run '^TestRecipeComplexQuery(Mysql|Postgres|Sqlite|Markdown)$$' -count=1

# complex-query-check/rust runs the recipe contracts/fixtures/complex_query/complex_query.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: complex-query-check/rust
complex-query-check/rust: lease-tool flowmark-check
	$(WITH_TEST_ENV) cd packages/rust && $(CARGO_TEST) complex-query-check -- $(RECIPE_RUST_TEST) --test all -- complex_query_mysql:: complex_query_postgres:: complex_query_sqlite:: complex_query_markdown::

# complex-query-check/typescript runs the recipe contracts/fixtures/complex_query/complex_query.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: complex-query-check/typescript
complex-query-check/typescript: typescript-current flowmark-check
	$(READ_TYPESCRIPT)
	$(WITH_TEST_ENV) $(RECIPE_TS_TEST) packages/ts/tests/complex_query-mysql.test.mjs packages/ts/tests/complex_query-postgres.test.mjs packages/ts/tests/complex_query-sqlite.test.mjs packages/ts/tests/complex_query-markdown.test.mjs

# complex-query-check/python runs the recipe contracts/fixtures/complex_query/complex_query.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: complex-query-check/python
complex-query-check/python: lease-tool python-venv-check flowmark-check
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_complex_query_mysql
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_complex_query_postgres
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_complex_query_sqlite
	$(WITH_TEST_ENV) $(PYTHON_VENV)/bin/python -m packages.python.tests.test_complex_query_markdown

# complex-query-check/php runs the recipe contracts/fixtures/complex_query/complex_query.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: complex-query-check/php
complex-query-check/php: lease-tool php-vendor-check php-models flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ComplexQueryMysqlRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ComplexQueryPostgresRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ComplexQuerySqliteRecipeTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ComplexQueryMarkdownRecipeTest.php

# complex-query-check/php-extension runs the recipe contracts/fixtures/complex_query/complex_query.json on the three
# databases (docs/spec/feature-coverage.md FCV-3 and FCV-4).
.PHONY: complex-query-check/php-extension
complex-query-check/php-extension: lease-tool php-vendor-check build-php-ext flowmark-check
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ComplexQueryMysqlRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ComplexQueryPostgresRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ComplexQuerySqliteRecipeTestExtensionTest.php
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ComplexQueryMarkdownRecipeTestExtensionTest.php

# complex-query-check runs the recipe of the complex product search in all six runtimes (docs/spec/complex-query.md CPX-1 and CPX-2).
.PHONY: complex-query-check
complex-query-check: complex-query-check/go complex-query-check/rust complex-query-check/typescript complex-query-check/python complex-query-check/php complex-query-check/php-extension

# bind-check runs the cases of tests/bind/vectors.json that no recipe holds in the five clients (tests/bind/README.md):
# each checks a parameter against the logical type of its slot. Each runner compares its answers with the file; the
# runners are independent parts, so one that fails leaves the others to run (make -k).
.PHONY: bind-check bind-check/go bind-check/rust bind-check/typescript bind-check/python bind-check/php
bind-check: bind-check/go bind-check/rust bind-check/typescript bind-check/python bind-check/php
bind-check/go:
	$(GO_TEST) ./packages/go/orm -run '^TestBindVectors$$' -count=1
bind-check/rust: lease-tool
	cd packages/rust && $(CARGO_TEST) bind-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib bind_
bind-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) packages/ts/tests/markdown.mjs
bind-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase packages.python.tests.test_markdown.BindVectors
bind-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter 'testBindVectors' packages/php/tests/MarkdownTest.php

# collection-recipe-check runs the collection recipe, tests/collection/collection.json, in each runtime (FCV-3, FCV-4): each part runs the entry of
# its runtime that calls the recipe helper, without a database: its collection.key steps take each key through the public key of a
# collection (INT-11, INT-63, PRT-35).
.PHONY: collection-recipe-check collection-recipe-check/go collection-recipe-check/rust collection-recipe-check/typescript collection-recipe-check/python collection-recipe-check/php collection-recipe-check/php-extension
collection-recipe-check: collection-recipe-check/go collection-recipe-check/rust collection-recipe-check/typescript collection-recipe-check/python collection-recipe-check/php collection-recipe-check/php-extension
collection-recipe-check/go:
	$(GO_TEST) ./packages/go/markdownmodel -run '^TestRecipeCollectionNone$$' -count=1
collection-recipe-check/rust: lease-tool
	cd packages/rust && $(CARGO_TEST) collection-recipe-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- collection_none::
collection-recipe-check/typescript: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --conditions=orm-test packages/ts/tests/collection-none.test.mjs
collection-recipe-check/python: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.test_collection_none
collection-recipe-check/php: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CollectionRecipeTest.php
collection-recipe-check/php-extension: php-vendor-check build-php-ext
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CollectionRecipeTestExtensionTest.php

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
# Go modules, the lowest Node of ts-min-check, and the error code files of orm-codes. CI bootstraps
# the root npm dependencies and @polyspec/kit before make runs a utility of the installed kit; orm-install-interfaces-typescript adds the separate
# TypeScript 6 checker used only by the interface extractor. Independent install parts run with make -k.

.PHONY: docs-ci
.PHONY: install orm-install-interfaces-typescript orm-install-php orm-install-rust orm-install-rust-toolchain orm-install-rust-crates orm-install-go orm-install-go-lease orm-install-server-programs orm-install-php-extension-tools orm-install-php-extension-runtime orm-install-typescript-runtime ci-php-min-version downloads-check
install: orm-codes orm-install-php orm-install-rust orm-install-go orm-install-php-extension-tools orm-install-python orm-install-flowmark orm-install-interfaces-typescript
# orm-codes writes the error code constants of TypeScript, PHP and Python from docs/spec/errors.yaml with orm-gen errors; they are
# build output and never tracked (P34). Go and Rust keep theirs tracked, since a go.mod or Cargo.toml consumer installs the tagged tree
# (config/generated.json, tracked). The PHP and Python packages declare their file as a make entry of config/release.json, and the
# install of each runtime writes its file. Every target that reads a file has orm-codes-<lang> among its prerequisites, directly or
# through php-vendor-check or python-venv-check, so make writes it before the recipe reads it (make repo-check). The file is published
# by a rename ($(PUBLISH)), since the make processes of several runs write it while others read it. orm-gen runs offline, as every check
# does: its prerequisite orm-install-go-codes downloads the Go modules that go.sum pins, since a job that installs only one
# runtime has not downloaded them. The same recipe writes the SQLite result code names of each runtime from
# docs/spec/sqlite-result-codes.yaml with orm-gen sqlite-codes (ORM_SQLITE_CODES_<lang>, INT-154); orm-codes-php-extension
# writes those of the PHP extension.
ORM_CODES_typescript = packages/ts/src/codes.ts
ORM_SQLITE_CODES_typescript = packages/ts/src/sqlite-codes.ts
ORM_SQLITE_CODES_php = packages/php/src/SqliteCodes.php
ORM_SQLITE_CODES_python = packages/python/src/polyspec/orm/_sqlite_codes.py
ORM_SQLITE_CODES_php-extension = packages/php-ext/src/sqlite_codes.h
PHP_EXT_SQLITE_CANCEL = packages/php-ext/src/native/sqlite_cancel.c
ORM_CODES_php = packages/php/src/Code.php
ORM_CODES_python = packages/python/src/polyspec/orm/codes.py
.PHONY: orm-codes orm-codes-typescript orm-codes-php orm-codes-python orm-codes-php-extension orm-install-go-codes
orm-install-go-codes:
	cd packages/go && $(ONLINE) $(GO) mod download
orm-codes: orm-codes-typescript orm-codes-php orm-codes-python
orm-codes-typescript orm-codes-php orm-codes-python: orm-codes-%: orm-install-go-codes
	$(GENERATE_ONCE) $(CURDIR)/$(dir $(ORM_CODES_$*))orm-codes.key "$(GO_VERSION)" packages/go docs/spec/errors.yaml docs/spec/sqlite-result-codes.yaml -- sh -c 'cd packages/go && $(PUBLISH) $(CURDIR)/$(ORM_CODES_$*) $(GO) run ./cmd/orm-gen errors --lang $* --yaml $(CURDIR)/docs/spec/errors.yaml --out @OUT@ && $(PUBLISH) $(CURDIR)/$(ORM_SQLITE_CODES_$*) $(GO) run ./cmd/orm-gen sqlite-codes --lang $* --yaml $(CURDIR)/docs/spec/sqlite-result-codes.yaml --out @OUT@'
orm-codes-php-extension: orm-install-go-codes
	$(GENERATE_ONCE) $(CURDIR)/packages/php-ext/src/orm-codes.key "$(GO_VERSION)" packages/go docs/spec/sqlite-result-codes.yaml -- sh -c 'cd packages/go && $(PUBLISH) $(CURDIR)/$(ORM_SQLITE_CODES_php-extension) $(GO) run ./cmd/orm-gen sqlite-codes --lang php-extension --yaml $(CURDIR)/docs/spec/sqlite-result-codes.yaml --out @OUT@'
# orm-install-interfaces-typescript installs the TypeScript 6.0.3 that packages/ts/testing/interfaces/typescript.mts reads declarations with
# (config/toolchain.json exceptions): TypeScript 7.0 ships no JavaScript API of its compiler.
# install-packages installs the TypeScript of tests/interfaces from its lock, so a fresh make install leaves the extractor with its checker.
orm-install-interfaces-typescript:
	$(ONLINE) $(NPM) ci --prefix packages/ts/testing/interfaces/typescript --no-audit --no-fund
# lint-ts reads packages/ts/testing/interfaces/typescript.mts, which imports the TypeScript that this target installs, so the
# prerequisite is added here.
lint-ts: typescript-build
# lint-php analyses packages/php/src, which holds the generated Code.php, and test-php-ext compares the extension with that library
# and runs its tests.
lint-php: orm-codes-php
# The interface_symbols case of test-php-ext runs interfaces/error-catalogs, which reads the error file of every implementation.
test-php-ext: orm-codes
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
orm-install-php: orm-codes-php
	$(ONLINE) $(COMPOSER) install --no-interaction --no-progress
	$(COMPOSER) dump-autoload --no-interaction --quiet
	$(MAKE) --no-print-directory php-models
PHP_MODELS_STAMP = $(CURDIR)/packages/php/gen/php-models.key
# Each entry generates into <dir>.tmp, which replaces <dir> by a rename after the generator succeeds (B1-4), so a stopped run leaves the
# previous directory whole and never a directory with some files new and some old.
php-models: php-vendor-check
	$(GENERATE_ONCE) $(PHP_MODELS_STAMP) "" composer.lock packages/php/src packages/php/bin $(PHP_MODELS_FILE) tests/bind -- sh -c 'while IFS= read -r entry; do case "$$entry" in ""|"#"*) continue ;; esac; out=$$(printf "%s\n" "$$entry" | sed "s/.*--out \([^ ]*\).*/\1/"); rm -rf "$$out.tmp"; vendor-php/bin/orm-gen gen $$(printf "%s\n" "$$entry" | sed "s|--out [^ ]*|--out $$out.tmp|") || exit 1; rm -rf "$$out" && mv "$$out.tmp" "$$out"; done < $(CURDIR)/$(PHP_MODELS_FILE)'
# php-cancel-helper-build publishes the SQLite loadable callback as an explicit product build; PHP queries only load its platform artifact.
.PHONY: php-cancel-helper-build
php-cancel-helper-build: php-vendor-check
	$(RUN_LONG) php-cancel-helper-build -- env POLYSPEC_ORM_PACKAGE_ROOT=$(CURDIR)/packages/php $(PHP) packages/php/bin/orm-sqlite-cancel-build.php
# php-model-check fails when the PHP models that orm-install-php wrote differ from what the entries of PHP_MODELS_FILE generate (orm-gen gen --check).
php-model-check: php-vendor-check
	while IFS= read -r entry; do case "$$entry" in ""|"#"*) continue ;; esac; vendor-php/bin/orm-gen gen --check $$entry || exit 1; done < $(CURDIR)/$(PHP_MODELS_FILE)
# orm-install-rust installs the toolchain of rust-toolchain.toml, then downloads the crates of every Cargo.lock. CI runs the two
# halves apart, orm-install-rust-toolchain before its crate cache is restored and orm-install-rust-crates after it, since a
# restored registry replaces the crates downloaded before it.
orm-install-rust: orm-install-rust-toolchain orm-install-rust-crates
# deps-rust is the default CI setup of the rust runtime, which setup.runtimes.rust of config/ci.json leaves empty (kit K859).
.PHONY: deps-rust
deps-rust: orm-install-rust
orm-install-rust-toolchain:
	PATH="$(HOME)/.cargo/bin:$(PATH)" rustup toolchain install
	PATH="$(HOME)/.cargo/bin:$(PATH)" rustc --version
# RUST_CRATE_MANIFESTS lists the workspace manifests of the tracked Cargo.lock files; cargo fetch --locked downloads each workspace's crates.
RUST_CRATE_MANIFESTS = benchmarks/rust/Cargo.toml packages/rust/Cargo.toml packages/rust/testing/interfaces/Cargo.toml
orm-install-rust-crates:
	$(ONLINE) sh -c 'set -e; for m in $(RUST_CRATE_MANIFESTS); do PATH="$(HOME)/.cargo/bin:$(PATH)" cargo +$(PHYSICAL_RUST_TOOLCHAIN) fetch --locked --manifest-path "$$m"; done'
# GO_MODELS_FILE declares the entries of the Go models that orm-gen generates (P34: generated output is never tracked): one orm-gen
# argument line per package, read by go-models and go-model-check (packages/go/models.txt). go-models writes them, and it is the last
# step of orm-install-go, after the modules are downloaded, so every Go check finds them. go-model-check runs orm-gen gen --check
# against the same entries (no network).
GO_MODELS_FILE = packages/go/models.txt
.PHONY: go-models
GO_MODELS_STAMP = $(CURDIR)/packages/go/go-models.key
go-models:
	$(GENERATE_ONCE) $(GO_MODELS_STAMP) "$(GO_VERSION)" packages/go -- sh -c 'cd packages/go && $(GO) run ./cmd/orm-gen sets $(CURDIR)/$(GO_MODELS_FILE)'

# The runtime build compiles Go packages that import these generated models.
build-go: go-models

# The runtime build compiles TypeScript packages that import generated models.
build-ts: typescript-build

orm-install-go:
	$(ONLINE) $(GO) mod download
	$(MAKE) --no-print-directory go-models
# check-run builds tests/lease in every CI group. Its only external Go module is x/sys through packages/go/procevent; keep the
# shared runner install limited to that pinned module, while Go-owning groups install the full workspace and generated models.
orm-install-go-lease:
	cd packages/go && $(ONLINE) $(GO) mod download golang.org/x/sys
# orm-install-flowmark installs, in the FLOWMARK directory, the flowmark that markdown-conformance-check runs, at the module
# version that tests/markdown/flowmark.version pins.
orm-install-flowmark:
	$(ONLINE) GOBIN=$(dir $(FLOWMARK)) $(GO) install github.com/polyspec/flowmark/packages/go/cmd/flowmark@$$(cat tests/markdown/flowmark.version)
	$(ONLINE) $(GO) mod download github.com/polyspec/flowmark/packages/go@$$(cat tests/markdown/flowmark.version)
# orm-install-server-programs installs, on the CI Linux runner, the server programs that make orm-test-servers starts
# (scripts/ci/server-programs.mts): the MySQL family, or with MARIADB=true, the output mariadb of the group-needs step of a
# group whose targets need the MariaDB servers, the MariaDB family that make orm-test-mariadb starts.
orm-install-server-programs:
	$(ONLINE) $(NODE) scripts/ci/server-programs.mts $(if $(filter true,$(MARIADB)),mariadb,mysql)
# orm-install-php-extension-tools checks that the phpize and php-config used by the build of the PHP extension polyspec_orm are those of the
# PHP on PATH (scripts/ci/php-extension-tools.mts), and writes the copy of the SQLite cancel callback that the build compiles; every
# job that builds the extension runs it (T290). The build runs the gen_stub.php of that PHP itself, so nothing installs the arginfo
# generator (kit K930).
orm-install-php-extension-tools: $(PHP_EXT_SQLITE_CANCEL) orm-codes-php-extension
	$(NODE) scripts/ci/php-extension-tools.mts
# The extension compiles native/sqlite_cancel.c (packages/php-ext/src/config.m4), whose one source is the PHP library's
# packages/php/src/native/sqlite_cancel.c: the copy is build output and never tracked (P34). build-php-ext takes it as a
# prerequisite, packages/php-ext/scripts/build.sh refuses a copy that differs from its source, and the make entry of packages/php-ext in
# config/release.json writes it with the arginfo header (php-ext-sources) for the archive.
$(PHP_EXT_SQLITE_CANCEL): packages/php/src/native/sqlite_cancel.c
	mkdir -p $(@D)
	cp $< $@.tmp.$$ && mv $@.tmp.$$ $@
# build-php-ext builds with the php-extension utility of kit and reads the same sources.
build-php-ext: php-ext-sources
# packages/php-ext/src/polyspec_orm_arginfo.h is the arginfo header of the one stub, written by scripts/php/php-ext-arginfo.mts for the archive;
# the build of the extension writes its own in a temporary copy. The gen_stub.php of the PHP fetches the PHP-Parser release
# that it names itself, as the build of kit does (K941); the offline settings of cargo, Go, npm and Composer do not reach it.
packages/php-ext/src/polyspec_orm_arginfo.h: packages/php-ext/src/polyspec_orm.stub.php
	$(NODE) scripts/php/php-ext-arginfo.mts
.PHONY: php-ext-sources
php-ext-sources: packages/php-ext/src/polyspec_orm_arginfo.h $(PHP_EXT_SQLITE_CANCEL) orm-codes-php-extension
# php-ext-build is the one build of the PHP extension: it writes PHP_EXT_OUT in PHP_EXT_MODE (release or native-test) after php-ext-sources,
# which writes the sources that build.sh reads and refuses when stale or missing. scripts/php/php-ext-build.mts builds each source and mode
# once into var/php-ext/build/<key>/ under a holder lock, and copies that build to PHP_EXT_OUT, so the sites of one run do not compile it again
# (B1-7). A recipe builds the extension with $(call php_ext_build,<output>,<mode>), which runs this target; make repo-check fails any other
# call of build.sh.
.PHONY: php-ext-build
php-ext-build: php-ext-sources
	$(RUN_LONG) php-extension-build -- $(NODE) scripts/php/php-ext-build.mts "$(PHP_EXT_OUT)" "$(PHP_EXT_MODE)"
php_ext_build = $(MAKE) --no-print-directory php-ext-build PHP_EXT_OUT=$(1) PHP_EXT_MODE=$(2)
orm-install-php-extension-runtime:
	$(MAKE) --no-print-directory orm-install-php
	cd packages/php-ext && $(ONLINE) $(COMPOSER) install --no-interaction --no-progress
	$(MAKE) --no-print-directory orm-install-php-extension-tools
orm-install-typescript-runtime: orm-install-go-lease orm-codes-typescript build-ts

# All setup steps of CI run make targets (make repo-check). ci-php-min-version records the lowest
# PHP release of make php-min-check as the input of setup-php (version=x.y). Each client refuses SQLite below 3.46 when it connects.
ci-php-min-version:
	@echo "version=$$(node scripts/php/php-min.mts --version)"

# downloads-check checks, without network, that all downloads that check reads are present, and lists each missing one with
# `run make install` (scripts/check/downloads.mts). The runner (scripts/check/run.mts) runs the same check as the setup step downloads.
downloads-check:
	$(NODE) scripts/check/downloads.mts

# rust-driver-check runs the native and driver_compare of benchmarks/rust without a DSN to confirm refusal,
# and runs each workload once at a time on the seeded bench database to confirm that every workload finishes.
rust-driver-check:
	$(WITH_TEST_ENV) cd benchmarks/rust && PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) rust-driver-check -- cargo test --locked --offline -- --test-threads=1

# example-check runs the examples package's DSN refusal and output tests once. The output test runs the Go, PHP and Rust programs
# of examples/complex and the Go, PHP, Rust, TypeScript and Python programs of examples/thin-slice on the seeded bench database.
# The PHP examples load the Composer autoloader; Python runs on the orm-install-python venv.
example-check: php-vendor-check python-venv-check
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/examples --cwd packages/rust -- $(CARGO_COPY) debug/complex debug/demo -- $(CARGO_SIBLINGS) build --locked --offline -p polyspec-orm-tests --bin complex --bin demo
	$(WITH_TEST_ENV) EXAMPLE_RUST_COMPLEX=$(RUN_TARGET)/debug/complex EXAMPLE_RUST_DEMO=$(RUN_TARGET)/debug/demo $(GO_TEST) ./examples -run '^(TestExampleOutputsAreIdentical|TestExamplesRequireBenchDSN)$$' -count=1
	rm -rf $(RUN_DIR)

# timing-check runs the Go, Rust, PHP, and TypeScript tests that time their own computation, with the process group throttled to a part of the CPU,
# and confirms that each test passes unchanged and prints its measurements. Performance is only measured and does not
# fail the test (AGENTS.md). It uses the 2000-table stress document, so make bench runs it.
TIMING_GO_DBSPEC_TEST = $(RUN_DIR)/dbspec.test
timing-check: typescript-current
	$(READ_TYPESCRIPT)
	mkdir -p $(dir $(DBSPEC_STRESS_DOCUMENT)) $(dir $(TIMING_GO_DBSPEC_TEST))
	$(PUBLISH) $(DBSPEC_STRESS_DOCUMENT) node tests/dbspec/stress.mts
	$(RUN_LONG) go-build/dbspec-test -- $(PUBLISH) $(TIMING_GO_DBSPEC_TEST) go test -c -o @OUT@ ./packages/go/engine/dbspec
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/dbspec_stress --cwd packages/rust -- $(CARGO_COPY) release/examples/dbspec_stress -- $(CARGO_SIBLINGS) build --release --locked --offline -p polyspec-orm-schema --example dbspec_stress
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) rust-build/orm-schema-tests --cwd packages/rust -- $(CARGO_LEASED) cargo test --locked --offline -p polyspec-orm-schema --no-run
	PATH="$(HOME)/.cargo/bin:$(PATH)" DBSPEC_STRESS_DOCUMENT=$(abspath $(DBSPEC_STRESS_DOCUMENT)) TIMING_GO_DBSPEC_TEST=$(abspath $(TIMING_GO_DBSPEC_TEST)) TIMING_RUST_STRESS=$(RUN_TARGET)/release/examples/dbspec_stress $(NODE) --test --test-concurrency=1 tests/timing/preempted.test.mts
	rm -rf $(RUN_DIR)

# typescript-build compiles packages/ts, which imports codes.ts, the output of orm-codes-typescript (config/generated.json). A target
# that compiles it in its own recipe ($(TSC_BUILD), or the holding of the build output) has orm-codes-typescript as well (make repo-check).
typescript-build: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(RUN_LONG) typescript-build -- npm run typescript:build

# typescript-build-unit-check runs the unit test of the build (B3-1): a second build of the same sources starts no compiler.
.PHONY: typescript-build-unit-check
typescript-build-unit-check: lease-tool orm-codes-typescript
	$(HOLD_TYPESCRIPT)
	$(NODE) --test scripts/typescript/build.test.mts

# The archives of the npm packages hold the builds of the TypeScript client and of the editor packages (the release tool of
# @polyspec/kit packs each tree as it is). release-assets builds on the installs it declares, the Go modules of the lease
# tool; the release workflow installs the npm packages of the TypeScript build first with make install-packages. The checks
# run offline (GOPROXY=off).
release-assets: orm-install-go-lease typescript-build editor-build

release-candidate-assets: orm-install-go-lease typescript-build editor-build

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
# of the models in packages/python/pyproject.toml stays as it is. Generated Go source is formatted here; tracked Go tests are
# formatted by go-fmt-check.
GENERATED_PY_MODELS = packages/python/tests/models/models.py
GENERATED_PHP = packages/php/gen
GENERATED_GO = ./model ./markdownmodel ./decimalmodel
GENERATED_TS = packages/ts/src/models/models.ts
.PHONY: generated-lint-check
generated-lint-check: python-models php-models go-models typescript-read
	$(RUFF) check --config ruff.toml --no-respect-gitignore $(GENERATED_PY_MODELS)
	$(RUFF) format --check --config ruff.toml --no-respect-gitignore $(GENERATED_PY_MODELS)
	$(PHPCS) -q -s --report=emacs --standard=phpcs.xml.dist $(GENERATED_PHP)/*.php
	@set -eu; \
	phpstan_tmp=$$(mktemp -d "$${TMPDIR:?}/generated-lint-phpstan.XXXXXX"); \
	trap 'rm -rf "$$phpstan_tmp"' EXIT; \
	$(PUBLISH) "$$phpstan_tmp/phpstan.neon" printf 'includes:\n    - %s\nparameters:\n    tmpDir: %s/cache\n' "$(CURDIR)/phpstan.dist.neon" "$$phpstan_tmp"; \
	cd packages/php; \
	$(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --configuration="$$phpstan_tmp/phpstan.neon" --autoload-file=../../vendor-php/autoload.php gen
	test -z "$$(cd packages/go && find $(GENERATED_GO) -type f -name '*.go' ! -name '*_test.go' -exec gofmt -l {} +)" || { cd packages/go && find $(GENERATED_GO) -type f -name '*.go' ! -name '*_test.go' -exec gofmt -l {} +; exit 1; }
	cd packages/go && $(GO) vet $(GENERATED_GO)
	$(NPM) exec --prefix "$(KIT_PACKAGE)" --offline -- oxlint -c .oxlintrc.json --type-aware --deny-warnings $(GENERATED_TS)

# clippy-crate runs the lints of lint-rust on the one package CRATE: cargo clippy --all-targets of the Cargo workspace WORKSPACE
# holds it, with the root clippy.toml, which clippy finds from the workspace upward, as lint-rust does. packages/rust holds most packages.
WORKSPACE ?= packages/rust
.PHONY: clippy-crate
clippy-crate: lease-tool ## Clippy of the package CRATE with the lint-rust flags, in the Cargo workspace WORKSPACE; offline once the crates are downloaded
	test -n "$(CRATE)" || { echo "clippy-crate: CRATE is required; run make clippy-crate CRATE=<crate>, which selects the package to lint" >&2; exit 2; }
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(RUN_LONG) clippy-crate --cwd $(WORKSPACE) -- $(CARGO_LEASED) cargo clippy -p $(CRATE) --all-targets --locked -- -D warnings -D unused_must_use -D clippy::let_underscore_must_use -D clippy::let_underscore_untyped -D clippy::map_err_ignore -D clippy::allow_attributes_without_reason

# group-rows-phpstan-check runs PHPStan at level 9 over the fixture of KSTD-5-53: a row of GroupRows is typed as GroupRow for its
# caller, so calling its method on each row passes; a mixed row fails it.
.PHONY: group-rows-phpstan-check
group-rows-phpstan-check: php-vendor-check
	cd packages/php && $(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --level=9 --configuration=$(CURDIR)/phpstan.dist.neon --autoload-file=../../vendor-php/autoload.php tests/phpstan/GroupRowsIteration.php

# collection-raw-phpstan-check runs PHPStan at level 5 over the fixture of KSTD-5-54: a raw Collection parameter carries no
# method of the base Model, so calling a column getter on its rows is no false method.notFound.
.PHONY: collection-raw-phpstan-check
collection-raw-phpstan-check: php-vendor-check
	cd packages/php && $(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --level=5 --configuration=$(CURDIR)/phpstan.dist.neon --autoload-file=../../vendor-php/autoload.php tests/phpstan/RawCollection.php

# dbspec-php-extension-check/markdown runs MarkdownTest with the extension loaded: the markdown IR uses of KSTD-5-80.
DBSPEC_MARKDOWN_TEST_FILTER ?=
dbspec-php-extension-check/markdown: php-models dbspec-php-extension-check/prepare
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension $(PHP_EXTENSION_LIBRARY) -- --configuration packages/php/phpunit.xml.dist $(if $(DBSPEC_MARKDOWN_TEST_FILTER),--filter '$(DBSPEC_MARKDOWN_TEST_FILTER)',) packages/php/tests/MarkdownTest.php

# print-CARGO_PROFILE_DEV_DEBUG prints the debug setting of the Rust test build of this checkout (KSTD-5-85). It sits at the end so that
# it never becomes the default goal of the Makefile.
.PHONY: print-CARGO_PROFILE_DEV_DEBUG
print-CARGO_PROFILE_DEV_DEBUG:
	@echo $(CARGO_PROFILE_DEV_DEBUG)

# Collection lookups retain the caller's model type and their nullable result.
.PHONY: collection-get-phpstan-check
collection-get-phpstan-check: php-vendor-check
	@set -eu; \
	phpstan_tmp=$$(mktemp -d "$${TMPDIR:?}/collection-get-phpstan.XXXXXX"); \
	trap 'rm -rf "$$phpstan_tmp"' EXIT; \
	$(PUBLISH) "$$phpstan_tmp/phpstan.neon" printf 'includes:\n    - %s\nparameters:\n    tmpDir: %s/cache\n' "$(CURDIR)/phpstan.dist.neon" "$$phpstan_tmp"; \
	cd packages/php; \
	$(PHPSTAN) analyse --no-progress --error-format=raw --memory-limit=-1 --level=9 --configuration="$$phpstan_tmp/phpstan.neon" --autoload-file=../../vendor-php/autoload.php tests/phpstan/CollectionGet.php

# KSTD-5-62: only the private catalog-document build failure is a Mermaid diagnostic. These owner targets run the
# focused unexpected-error identity cases; the PHP extension variant builds a test-only module around the actual mermaid.c.
.PHONY: mermaid-error-ts-check mermaid-error-python-check mermaid-error-php-check mermaid-error-php-extension-check
mermaid-error-ts-check: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) --test packages/ts/tests/dbspec-mermaid-errors.mjs
mermaid-error-python-check: python-venv-check
	$(PYTHON_TESTS) -- packages.python.tests.mermaid_error_boundary
mermaid-error-php-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DbspecMermaidErrorBoundaryTest.php
mermaid-error-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/mermaid-error-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",native-test); env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/MermaidErrorBoundaryTest.php

.PHONY: parent-slot-expansion-php-extension-check
parent-slot-expansion-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; run_dir="$(abspath .runtime/run)/parent-slot-expansion-php-extension-check-$$$$"; trap 'rm -rf "$$run_dir"' EXIT; mkdir -p "$$run_dir/php-extension"; $(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",native-test); env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ParentSlotExpansionNativeTest.php

# Exercise the PHP extension build failure handler with isolated fake tools.
.PHONY: php-extension-build-logs-check
php-extension-build-logs-check:
	$(NODE) --test tests/php-ext/build-logs.test.mts

# rust-duplicate-catalog-check runs only the catalog transaction and assignment-budget refactor units.
.PHONY: rust-duplicate-catalog-check
rust-duplicate-catalog-check: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) rust-duplicate-catalog -- cargo test --manifest-path packages/rust/Cargo.toml --locked --offline -p polyspec-orm-build --lib rust_duplicate_ -- --test-threads=1

# catalog-value-rust-check runs the units of packages/rust/build/tests/unit/catalog_value.rs: a cell that the catalog cannot
# return fails with CATALOG_VALUE, and the tool errors keep their catalog codes.
.PHONY: catalog-value-rust-check
catalog-value-rust-check: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) catalog-value-rust -- cargo test --manifest-path packages/rust/Cargo.toml --locked --offline -p polyspec-orm-build --lib catalog::value_tests:: -- --test-threads=1

# catalog-tool-errors-rust-check runs the unit of packages/rust/build/tests/unit/catalog_tool_errors.rs: the tool_db statement and
# column errors keep their codes first, as INT-124 and INT-125 state, instead of the text of the driver prefix.
.PHONY: catalog-tool-errors-rust-check
catalog-tool-errors-rust-check: lease-tool
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) catalog-tool-errors-rust -- cargo test --manifest-path packages/rust/Cargo.toml --locked --offline -p polyspec-orm-build --lib catalog::tool_error_tests:: -- --test-threads=1

.PHONY: php-catalog-bounds-check
php-catalog-bounds-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CatalogQueryBoundsTest.php

request-hook-php-extension-check: php-vendor-check php-model-check lease-tool
	@set -eu; \
	run_dir="$(abspath .runtime/run)/request-hook-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testNativeMethodsAreInternal' packages/php-ext/tests/RequestHookTestExtensionTest.php

# request-hook-relation-scope-check runs the relation_scope case of the request hook (relation() and relations() under a
# service scope, T203) on SQLite in every client: Go, TypeScript, Python, the PHP library, the PHP extension and Rust.
.PHONY: request-hook-relation-scope-check
request-hook-relation-scope-check: RUN_DIR = $(abspath .runtime/run)/request-hook-relation-scope-check-$$PPID
request-hook-relation-scope-check: php-vendor-check php-models python-venv-check lease-tool typescript-read
	$(NODE) tests/go-test.mts -v -timeout 0 ./packages/go/orm -run '^TestRecipeRequestHookSqlite$$/^relation_scope$$' -count=1
	$(RECIPE_TS_TEST) --test-name-pattern='relation_scope' packages/ts/tests/request_hook-sqlite.test.mjs
	$(PYTHON_TESTS) -- packages.python.tests.test_request_hook_sqlite
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist --filter relation_scope packages/php/tests/RequestHookSqliteRecipeTest.php
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)
	$(PHP_EXTENSION_TESTS) --filter relation_scope packages/php-ext/tests/RequestHookSqliteRecipeTestExtensionTest.php; status=$$?; rm -rf $(RUN_DIR); exit $$status
	PATH="$(HOME)/.cargo/bin:$(PATH)" $(CARGO_TEST) request-hook-relation-scope-check -- $(RECIPE_RUST_TEST) --manifest-path packages/rust/Cargo.toml --test all -- --exact request_hook_sqlite::relation_scope

# dbspec-php-extension-check/declarations runs the extension's own checks (packages/php-ext/tests): its declarations against the stub and the
# PHP client, its required modules and its PIE package.
# dbspec-php-extension-check/silent-paths runs silent_paths.php with the extension alone (php -n, no library class): a call that must fail with an OrmException must throw, not return silently (T182-2-4).

rust-causes-check: lease-tool
	@status=0; cd packages/rust || exit; \
	$(CARGO_TEST) rust-causes-orm -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib cause_message -- --test-threads=1 --nocapture || status=1; \
	$(CARGO_TEST) rust-causes-build -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-build --lib --features live-db cause_message -- --test-threads=1 --nocapture || status=1; \
	exit $$status

rust-closed-executor-check: lease-tool
	cd packages/rust && $(CARGO_TEST) rust-closed-executor-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm --lib db::executor_route_tests::query_and_execute_share_pool_and_transaction_routing -- --test-threads=1 --exact

# Focused split-merge NULL boundary cases in each native client.

go-catalog-session-error-check:
	$(GO_TEST) ./packages/go/orm -run '^(TestCatalogSessionEndPreservesPrimaryAndRollbackCauses|TestCatalogSessionEndReportsRollbackCauseWithoutPrimary)$$' -count=1

# catalog-described-temporal-go-check runs the unit tests of the dbspec text that a Go read of a described table returns for
# its date, time and datetime cells (INT-103) and of the exact comparison of a catalog write (INT-117, INT-123).
catalog-described-temporal-go-check:
	$(GO_TEST) ./packages/go/orm -run '^(TestCatalogWriteRefusesTimeValueForTemporalColumn|TestCatalogDescribedTemporalText|TestCatalogSameCellComparesWrittenTemporalTextExactly)$$' -count=1

CHECK_TARGETS += catalog-described-temporal-go-check
CI_TARGETS_static += catalog-described-temporal-go-check

# catalog-value-go-check runs the native injection tests of the Go catalog value rules (docs/spec/feature-coverage.md FCV-2),
# which no recipe case reaches: a driver value that is not the host form of its column type fails with INT-171, and a value
# that the driver could not decode with INT-172, which keeps the failure as its cause.
catalog-value-go-check:
	$(GO_TEST) ./packages/go/orm -run '^(TestCatalogValueUnsupportedDriverValue|TestCatalogValueDriverDecodeFailure)$$' -count=1

CHECK_TARGETS += catalog-value-go-check
CI_TARGETS_static += catalog-value-go-check

CHECK_TARGETS += rust-temporal-args-check
CI_TARGETS_static += rust-temporal-args-check

go-sqlite-version-check:
	$(GO_TEST) ./packages/go/orm -run '^TestSQLiteMinimumVersionThroughConnect$$' -count=1

catalog-php-extension-surface-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/CatalogPageValidationTest.php; \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CatalogConnectionSurfaceTest.php
# Builds the extension in an isolated run directory and executes only its native Collection unit cases.

php-lifecycle-extension-native-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/php-lifecycle-extension-native-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageDsnConnectionExtensionTest.php packages/php-ext/tests/CoverageTransactionsExtensionTest.php packages/php-ext/tests/StatementEventsTestExtensionTest.php packages/php-ext/tests/QueryCancellationNativeTest.php --filter 'testNativeMethodsAreInternal|testNativeSqliteConnectionQueriesAndCloses|testNativeSqliteRollbackStatementDiscardsRowsAndPublishesEvent|testStatementEventEntryPointsAreNative|testNativeCancellationStateIsPrivatePersistentAndRemovedWhenReleased|testNativeCancellationDispatchesOnlyToActiveConnectionSlots|testNativeCancellationInterruptsSqliteRollsBackAndKeepsRootConnectionUsable'


# rollback-php-extension-check runs the first-statement-lost case of packages/php/tests/RollbackTest.php
# with the extension loaded, on MySQL and PostgreSQL (WITH_TEST_ENV).
.PHONY: rollback-php-extension-check
rollback-php-extension-check: RUN_DIR = $(abspath .runtime/run)/rollback-php-extension-check-$$PPID
rollback-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	$(call php_ext_build,$(PHP_EXTENSION_LIBRARY),release)
	$(WITH_TEST_ENV) $(PHP_EXTENSION_TESTS) packages/php/tests/RollbackTest.php --filter testFirstStatementLost; status=$$?; rm -rf $(RUN_DIR); exit $$status

transaction-failure-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/transaction-failure-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist $(if $(TRANSACTION_FAILURE_PHP_EXTENSION_TEST_FILTER),--filter '$(TRANSACTION_FAILURE_PHP_EXTENSION_TEST_FILTER)',) packages/php-ext/tests/TransactionFailureNativeTest.php
# dbspec-php-extension-check/declarations runs the extension's own checks (packages/php-ext/tests): its declarations against the stub and the
# PHP client, its required modules and its PIE package.
# dbspec-php-extension-check/silent-paths runs silent_paths.php with the extension alone (php -n, no library class): a call that must fail with an OrmException must throw, not return silently (T182-2-4).

transaction-failure-go-check:
	$(NODE) tests/go-test.mts -v -timeout 0 ./packages/go/orm $(if $(TRANSACTION_FAILURE_GO_TEST_FILTER),-run '$(TRANSACTION_FAILURE_GO_TEST_FILTER)',-run '^TestTransactionFailure(Rollback|SavepointEnd)$$|^TestSavepointReportsFailedEnd$$') -count=1

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
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'testPostgresNoticeCancelsActiveStatementRollsBackAndReusesRoot|testMysqlLockEventCancelsActiveStatementRollsBackAndReconnectsRoot|testMysqlCancellationStopsEveryActiveRootAndReopensEachProcessRoot' packages/php-ext/tests/QueryCancellationNativeTest.php

# The PostgreSQL PDO-compatible adapter has a seven-case library owner and an extension-native owner over the same case bodies.
.PHONY: pgsql-pdo-adapter-php-check pgsql-pdo-adapter-php-extension-check
pgsql-pdo-adapter-php-check: php-vendor-check php-models
	$(WITH_TEST_ENV) env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/PgsqlPdoAdapterTest.php

pgsql-pdo-adapter-php-extension-check: php-vendor-check php-models orm-install-php-extension-tools build-php-ext
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$(abspath var/php-ext/polyspec_orm.so)" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/PgsqlPdoAdapterNativeTest.php

transaction-failure-php-check: php-vendor-check php-models
	env ORM_PHP_MODE=library $(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist $(if $(TRANSACTION_FAILURE_PHP_TEST_FILTER),--filter '$(TRANSACTION_FAILURE_PHP_TEST_FILTER)',) packages/php/tests/TransactionFailureTest.php

# python-check runs the Python client's unit tests, the interface tests of the Python extractor, the generated-model check and
# the Python conformance result check. The tests import the client and ordered-json installed into the venv (orm-install-python).

transaction-failure-typescript-check: typescript-read
	$(NODE) --conditions=orm-test --test $(if $(TRANSACTION_FAILURE_TYPESCRIPT_TEST_FILTER),--test-name-pattern='$(TRANSACTION_FAILURE_TYPESCRIPT_TEST_FILTER)',) packages/ts/tests/transaction-failure.mjs

# The assignment expansion regression is a pure planner unit, separate from the Go database suite.

transaction-failure-python-check: python-venv-check
	$(PYTHON_TESTS) -- \
		$(if $(TRANSACTION_FAILURE_PYTHON_TEST_FILTER),$(TRANSACTION_FAILURE_PYTHON_TEST_FILTER),packages.python.tests.test_rollback_fault.RollbackFaultTest.test_a_failed_rollback_reports_the_callback_error_and_the_rollback_error packages.python.tests.test_rollback_fault.RollbackFaultTest.test_a_failed_savepoint_rollback_and_transaction_rollback_report_both packages.python.tests.test_rollback_fault.RollbackFaultTest.test_lost_rollback_connection_is_closed_before_the_next_transaction packages.python.tests.test_rollback_fault.HandleDisposalTest.test_close_during_transaction_rolls_back_and_closes_connection packages.python.tests.test_rollback_fault.RollbackFaultTest.test_a_failed_begin_closes_its_connection packages.python.tests.test_rollback_fault.RollbackFaultTest.test_a_failed_start_step_after_begin_rolls_back_and_gives_the_connection_back)

# Runs the Rust transaction and savepoint failure cases that use only local SQLite and its authorizer.

.PHONY: transaction-failure-rust-check/lib transaction-failure-rust-check/fault
transaction-failure-rust-check: transaction-failure-rust-check/lib transaction-failure-rust-check/fault
transaction-failure-rust-check/lib:
	$(if $(TRANSACTION_FAILURE_RUST_FAULT_FILTER),:,cd packages/rust && $(CARGO_TEST) transaction-failure-rust -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --lib end_failures_are_reported -- --nocapture)
transaction-failure-rust-check/fault:
	cd packages/rust && $(CARGO_TEST) transaction-failure-rust-fault -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline --workspace --features $(ORM_RUST_TEST_FEATURES) --test all -- $(if $(TRANSACTION_FAILURE_RUST_FAULT_FILTER),$(TRANSACTION_FAILURE_RUST_FAULT_FILTER),rollback::transaction_forms_rollback_fault_sqlite) --nocapture

# The shared blind-index target regression runs only the Python client's pure planner tests.

connection-timeout-php-extension-check: RUN_DIR = $(abspath .runtime/run)/connection-timeout-php-extension-check-$$PPID
connection-timeout-php-extension-check: php-vendor-check orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(RUN_DIR)"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ConnectionTimeoutCleanupTest.php

connection-sqlite-several-processes-python-check: python-models
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s packages/python/tests -t . -p connection_pool.py -k test_sqlite_several_process_writers_commit_every_row

go-package-entry-check:
	$(GO_TEST) ./packages/go/orm -run '^TestExternalModuleCanImportClient$$' -count=1

php-package-entry-check: php-vendor-check php-models
	$(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/PackageEntryPointTest.php
	$(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/ComposerExtensionsTest.php

php-extension-package-entry-check: php-vendor-check php-models
	@set -eu; \
	run_dir="$(abspath .runtime/run)/php-extension-package-entry-check-$$$$"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir"; \
	$(call php_ext_build,"$$run_dir/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(PHP_EXTENSION_DYNAMIC_MODULES)' POLYSPEC_ORM_EXTENSION="$$run_dir/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist --filter 'test(Package|Client)' packages/php-ext/tests/DeclarationsTest.php

rust-package-entry-check:
	cd packages/rust && $(CARGO_TEST) rust-package-entry-check -- cargo +$(PHYSICAL_RUST_TOOLCHAIN) test --locked --offline -p polyspec-orm-tests --test all -- package_entry::public_package_entry --exact --nocapture

typescript-package-entry-check: typescript-read
	$(NODE) --conditions=orm-test --test --test-name-pattern='package-entry/runtime-exports' packages/ts/tests/statement_fault_entry.mjs

complex-query-typescript-unit-check: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) packages/ts/tests/fulltext-chain-types.mjs
	$(NODE) packages/ts/tests/paginate-order.mjs

complex-query-typescript-request-check: typescript-current
	$(READ_TYPESCRIPT)
	$(NODE) packages/ts/tests/complex-query-request-types.mjs

python-package-entry-check: python-venv-check
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s packages/python/tests -t . -p test_rollback_fault.py -k test_the_package_entry_point_does_not_export_the_fault
	$(PYTHON_VENV)/bin/python -m packages.python.tests.testcase discover -s packages/python/tests -t . -p test_package_entry.py

# fuzz-check is a long-running task that runs the fuzzing-instrumented build and one second of fuzzing (-fuzztime), so
# it runs each command with no deadline under RUN_LONG. -fuzztime sets the length of fuzzing.

NATIVE_API_EQUIVALENCE_FILTER ?= testAddTablesAndColumnsRejectsExternalDriftWithoutChangingDatabase|testAddTablesAndColumnsRollsBackWithoutCreatingInternalLockTable|testSchemaMutationMethodsRejectObjectsThatAreNotSchema|testWasInsertedChecksTransactionBeforeArguments|testStatusAndRotateCheckKeyringTypeBeforeModelMetadata|testOrmConnectionFactoryRejectsAConfigThatIsNotConfigBeforeOpeningSqlite|testConnectSchemaChecksSchemaTypeBeforeConfigTypeAndDsn|testBeginSubscriberFailureRollsBackAnOpenedSqliteTransaction|testSqliteRestoreFailureKeepsThePrimaryFailureAsPrevious|testBeginInspectionFailureReplacesThePrimaryAndRestoresForeignKeys
native-api-equivalence-check: php-vendor-check php-models orm-install-php-extension-tools
	@set -eu; \
	run_dir="$(abspath .runtime/run)/schema-utils-equivalence-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/SchemaUtilsNativeTest.php packages/php-ext/tests/UtilsNativeTest.php packages/php-ext/tests/AesUtilsNativeTest.php packages/php-ext/tests/OrmExceptionNativeTest.php --filter '$(NATIVE_API_EQUIVALENCE_FILTER)'

native-arginfo-php-extension-check: php-vendor-check php-models
	@set -eu; \
	$(NODE) --test scripts/php/php-ext-arginfo.test.mts; \
	$(NODE) --test scripts/php/php-ext-build-cache.test.mts; \
	run_dir="$(abspath .runtime/run)/native-arginfo-php-extension-check-$$PPID"; \
	trap 'rm -rf "$$run_dir"' EXIT; \
	mkdir -p "$$run_dir/php-extension"; \
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	$(WITH_TEST_ENV) env ORM_PHP_MODE=extension ORM_PHP_DYNAMIC_MODULES='$(PHP_EXTENSION_DYNAMIC_MODULES)' POLYSPEC_ORM_EXTENSION="$$run_dir/php-extension/polyspec_orm.so" $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/ArginfoBuildTest.php packages/php-ext/tests/DeclarationsTest.php packages/php-ext/tests/ModelNativeTest.php packages/php-ext/tests/CollectionTest.php packages/php-ext/tests/OrmExceptionNativeTest.php packages/php-ext/tests/AesUtilsNativeTest.php packages/php-ext/tests/PrivilegeUtilsNativeTest.php packages/php-ext/tests/UtilsNativeTest.php packages/php-ext/tests/SchemaUtilsNativeTest.php

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
	$(call php_ext_build,"$$run_dir/php-extension/polyspec_orm.so",release); \
	env ORM_PHP_MODE=extension $(RUN_TESTS) phpunit --php-extension "$$run_dir/php-extension/polyspec_orm.so" -- --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/RequestHookTestExtensionTest.php packages/php-ext/tests/AuditNativeMethodsTest.php --filter testNativeMethodsAreInternal

# Runs the database-free tests of shared PHP fixture and assertion helpers.
.PHONY: php-test-assertions-helper-check
php-test-assertions-helper-check: php-vendor-check php-models
	$(RUN_TESTS) phpunit -- --configuration packages/php/phpunit.xml.dist packages/php/tests/DatabaseTestAssertionsTest.php

.PHONY: typescript-performance-gate-unit-check
typescript-performance-gate-unit-check:
	$(RUN_TESTS) node --timeout 30 -- --test-concurrency=1 --test packages/ts/tests/coverage_performance_gate.test.mjs
