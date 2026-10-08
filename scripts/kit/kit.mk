# The targets of kit that every repository includes (`include scripts/kit/kit.mk`). This file is vendored: it is copied by
# `make kit-sync`, so a change is made in kit, never in a checkout (.kit/kit.lock.json records its sha256).
KIT_REPOSITORY ?= https://github.com/polyspec/kit
ONLINE ?=

.PHONY: kit-sync kit-check kit-test

kit-sync: ## Copy the vendored files of kit at KIT_TAG into this checkout; ONLINE, it clones KIT_REPOSITORY
	@test -n "$(KIT_TAG)" || { echo "kit-sync: KIT_TAG is required, for example make kit-sync KIT_TAG=v0.0.1"; exit 1; }
	$(ONLINE) node scripts/kit/kit-sync.mjs --tag $(KIT_TAG) --repository $(KIT_REPOSITORY)

kit-check: ## Check the vendored files against .kit/kit.lock.json and the configuration against its schemas; offline
	node scripts/kit/kit-check.mjs

kit-test: ## Run the tests of the vendored tools (tests/kit); offline
	node --test tests/kit/

# --- cargo downloads: the crates of every Cargo.lock are downloaded before a check runs cargo offline.
.PHONY: cargo-downloads-check cargo-downloads-fetch
cargo-downloads-check: ## Check that the crates of every Cargo.lock are in the registry of CARGO_HOME; offline
	node scripts/kit/check-cargo-downloads.mjs

cargo-downloads-fetch: ## Download the crates of every Cargo.lock
	$(ONLINE) node scripts/kit/check-cargo-downloads.mjs --fetch
# Toolchains (K8.2): install-tools installs the declared npm, Go, ruff, Composer (with a sha256), cargo-audit and
# govulncheck into var/tools; ONLINE, because it downloads. Nothing on the machine changes. Put var/tools/bin first on PATH.
# toolchain-check compares the running tools with the declarations and fails with the expected and the running version.
.PHONY: install-tools toolchain-check

install-tools: ## Install the toolchains that the checkout declares into var/tools; ONLINE
	$(ONLINE) node scripts/kit/install-tools.mjs

toolchain-check: ## Check that the running tools are the declared versions; TOOLS limits the tools; offline
	node scripts/kit/check-toolchain.mjs $(TOOLS)
# ---- The gates: Git hooks, push gate and guard of the full run ------------------------------------------------------
# scripts/kit/git-hooks.mjs, push-gate.mjs and full-run.mjs read config/checklist.json. The target that runs the full suite
# is the repository's own: it calls `node scripts/kit/full-run.mjs run <target>...` with the targets of its suite.
COMMIT ?= HEAD
FULL_RUN_KEYS ?=

.PHONY: hooks hooks-check push-gate-commit rerun-failed

# Git runs the hooks of core.hooksPath. A checkout that tracks .githooks/pre-push sets it on every make invocation.
ifneq ($(wildcard .githooks/pre-push),)
ifneq ($(shell git config core.hooksPath),.githooks)
$(shell git config core.hooksPath .githooks)
endif
endif

hooks: ## Set core.hooksPath to .githooks, write the pre-push hook of the push gate and check the hooks
	node scripts/kit/git-hooks.mjs install

hooks-check: ## Fail while core.hooksPath is not .githooks or a hook of config/checklist.json is missing, not executable or changed
	node scripts/kit/git-hooks.mjs check

push-gate-commit: ## The push gate on COMMIT (HEAD): fail while it has an item in an active state or does not track an executable hook
	node scripts/kit/push-gate.mjs commit $(COMMIT)

rerun-failed: ## Rerun the targets of the last full run of this tree that did not pass; FULL_RUN_KEYS repeats the keys of that run
	node scripts/kit/full-run.mjs rerun-failed$(if $(FULL_RUN_KEYS), $(FULL_RUN_KEYS))
# --- Document, owner and CI report tools (rows K7 and K8.1) ---------------------------------------------------------------
.PHONY: documents-check

documents-check: ## Check the documents declared in config/documents.json: translation pairs, revisions, links, and the checklists of config/checklist.json; offline
	node scripts/kit/check-documents.mjs

.PHONY: owner-check owner-validate

owner-check: ## Run the checks that own the changed paths (config/owner-checks.json); PATHS="a b" or BASE=<revision> selects the paths
	node scripts/kit/owner-check.mjs $(if $(PATHS),--paths "$(PATHS)") $(if $(BASE),--base $(BASE))

owner-validate: ## Check that config/owner-checks.json owns every tracked path and names only existing checks; offline
	node scripts/kit/owner-check.mjs --validate

.PHONY: ci-targets ci-summary ci-passed

CI_REPORT ?= var/report/ci-targets

ci-targets: ## Run the make targets of TARGETS past failures and write the report to CI_REPORT (logs, record.json, summary.md)
	node scripts/kit/ci-targets.mjs $(CI_REPORT) $(TARGETS)

ci-summary: ## Write summary.md of CI_REPORT again from its record, also for a run that stopped; never judges the targets
	node scripts/kit/ci-targets.mjs --summary $(CI_REPORT)

ci-passed: ## Fail unless every job of RESULTS, the JSON of toJSON(needs), has the result success
	node scripts/kit/ci-passed.mjs

.PHONY: commits-check

commits-check: ## Check the commit messages of RANGE (<base>..<head>, default HEAD) against config/commits.json; offline
	node scripts/kit/check-commits.mjs $(if $(RANGE),--range $(RANGE))
# The steps of a release (scripts/kit/release.mjs, config/release.json). TAG is the pushed tag, vX.Y.Z or <Go module
# directory>/vX.Y.Z; release-verify reads the check runs of GITHUB_REPOSITORY. The release workflow runs the steps in this order.
.PHONY: release-verify release-versions release-assets release-publish release-coverage release-go-tags

release-verify: ## Require the commit of TAG on origin/main with its check runs succeeded; reads GITHUB_REPOSITORY
	@test -n "$(TAG)" || { echo "release-verify: TAG is required, for example make release-verify TAG=v0.0.1"; exit 1; }
	node scripts/kit/release.mjs verify $(TAG)

release-versions: ## Require the version of TAG in every manifest, the Go module path and the change log section; offline
	@test -n "$(TAG)" || { echo "release-versions: TAG is required, for example make release-versions TAG=v0.0.1"; exit 1; }
	node scripts/kit/release.mjs versions $(TAG)

release-assets: ## Build the archive of every package of TAG into var/release/assets
	@test -n "$(TAG)" || { echo "release-assets: TAG is required, for example make release-assets TAG=v0.0.1"; exit 1; }
	node scripts/kit/release.mjs assets $(TAG)

release-publish: ## Create the GitHub Release of TAG with the notes and the archives of release-assets
	@test -n "$(TAG)" || { echo "release-publish: TAG is required, for example make release-publish TAG=v0.0.1"; exit 1; }
	node scripts/kit/release.mjs publish $(TAG)

release-coverage: ## Require every package file of the checkout to be classified in config/release.json; offline
	node scripts/kit/release.mjs coverage

release-go-tags: ## Require the tag <directory>/vX.Y.Z of every Go module at the commit of TAG; offline
	@test -n "$(TAG)" || { echo "release-go-tags: TAG is required, for example make release-go-tags TAG=v0.0.1"; exit 1; }
	node scripts/kit/release.mjs go-tags $(TAG)

# --- lint-python: ruff check and ruff format --check of the Python package that config/toolchain.json ruff.pyproject names.
.PHONY: lint-python
lint-python: ## Lint and format-check the Python package with the ruff of var/tools; offline
	node scripts/kit/lint-python.mjs
# ---- Consumer install of the release archives (K5.4) ------------------------------------------------------------
# ---- Consumer install and proof of a release (K5.4, K5.5) ------------------------------------------------------------
# scripts/kit/release-consumer.mjs installs the archives of TAG from var/release/assets (make release-assets) in clean npm and
# Composer projects outside the checkout, from the manifests and locks that config/release.json `consumers` names, and runs a
# smoke command for each package. A lock pins registry packages by version and integrity, so the install downloads them: that is
# installation, and the target is no offline check. release-consumer-lock resolves versions and runs ONLINE.
# scripts/kit/release-proof.mjs proves a released TAG from outside the repository (GitHub Release, consumer installs, git-tag
# installs, Go modules); it runs after the release exists and belongs to no check.
.PHONY: release-consumer release-consumer-lock release-proof

release-consumer: ## Install the archives of TAG in var/release/assets in clean npm and Composer projects and run the smoke commands
	@test -n "$(TAG)" || { echo "release-consumer: TAG is required, for example make release-consumer TAG=v0.0.1"; exit 1; }
	node scripts/kit/release-consumer.mjs install $(TAG)

release-consumer-lock: ## Write the consumer manifests and locks of TAG from the archives in var/release/assets; ONLINE
	@test -n "$(TAG)" || { echo "release-consumer-lock: TAG is required, for example make release-consumer-lock TAG=v0.0.1"; exit 1; }
	$(ONLINE) node scripts/kit/release-consumer.mjs lock $(TAG)

release-proof: ## Prove the released TAG from outside the checkout: release assets, consumer installs, git-tag installs, Go modules; ONLINE
	@test -n "$(TAG)" || { echo "release-proof: TAG is required, for example make release-proof TAG=v0.0.1"; exit 1; }
	$(ONLINE) node scripts/kit/release-proof.mjs $(TAG)

# --- dependencies: the gate reads the manifests, the locks and the review record; the review asks the registries.
.PHONY: dependency-policy-check dependency-policy-mutation-check dependency-review
dependency-policy-check: ## Check the manifests and locks against config/dependency-policy.json and the review record; offline
	node scripts/kit/check-dependency-policy.mjs

dependency-policy-mutation-check: ## Check that the dependency gate rejects each known mutation of the checkout; offline
	node scripts/kit/check-dependency-policy-mutation.mjs

dependency-review: ## Ask the registries for newer stable releases and advisories; RECORD=1 records the review, UPDATE=1 updates first; ONLINE
	$(ONLINE) node scripts/kit/dependency-review.mjs $(if $(RECORD),--record) $(if $(UPDATE),--update)
