<!-- doc-id: agents -->
# Development rules

[Korean](AGENTS.ko.md)

The working principles and standards of every polyspec repository are in [PRINCIPLES.md](PRINCIPLES.md), which orm took
from kit and holds as its own; this file states only the rules of orm.

- Own: The user's instructions take precedence. Develop locally; the GitHub remote receives a push only
  as the push rule below allows.
  Enforced by: none, a judgement at review
- Own: The 0.x workflow has no pull request, merge queue or ruleset. Work locally item by item: an item
  becomes `[o]` when its declared unit tests pass on the committed tree. `main` receives one push,
  when no item is `[~]` and the work of the push is complete. The CI of that candidate must succeed
  before the tag. The release version and all CI improvements are included before that push; a release does not
  require another full CI run. Only the maintainer starts a release, by a dispatch of the
  release workflow with the id of a `ci.yml` run whose conclusion is success, which tags its commit; a
  pushed tag starts no run. A release asset keeps the file name its packer gives (P39), for example
  `polyspec-orm-X.Y.Z.tgz` for `@polyspec/orm`; the Python wheel keeps its PEP 427 name,
  `polyspec_orm-X.Y.Z-py3-none-any.whl`.
  Enforced by: `make release-tag`
- Own: The shared tools are the npm package `@polyspec/kit`, a devDependency of `package.json` pinned to
  the asset of its release with its integrity, which `.npmrc` allows (`allow-remote=root`). kit ships utilities
  and no recipes (kit `docs/spec/utilities-and-recipes.md`): the `Makefile` of orm defines every target that orm,
  its workflows and its documents call, and each runs one utility of the installed package with the arguments
  that orm gives it. CI installs the package through `.github/actions/kit-bootstrap` (K992), and
  `make install-tools TOOLS=npm` installs the pinned npm before the packages (K938). The settings of the tools
  are in their own files: `.npmrc`, the `[settings]` and `[env]` of `mise.toml`, the `[workspace.lints]` of each
  `Cargo.toml`, the `[tool.vulture]` of `legacy/packages/python/pyproject.toml` and the lint configurations of the root
  (`ruff.toml`, `phpcs.xml.dist`, `phpstan.dist.neon`, `.golangci.yml`, `clippy.toml`, `.oxlintrc.json`,
  `knip.json`). The files that orm took from the examples of kit and keeps in kit's form are listed in
  `scripts/repo/kit-copies.mts`; the rules of this repository do not read them, and orm adopts a change of
  kit's example in its own commit. A tool that kit lacks or gets wrong is reported to kit, never copied here.
  While polyspec versions are 0.0.x, development checkouts link installed polyspec packages to
  their source as kit `docs/plans/local-links.md` describes; links are never committed.
  Enforced by: `make repo-check`
- Refines S5: The client packages are `packages/<runtime>` with the runtime `go`, `ts` (the TypeScript client),
  `php`, `php-ext` (the PHP-extension), `python` and `rust` (S5 of PRINCIPLES.md): a folder name
  carries no repository prefix, and the distribution names (`@polyspec/orm`, `polyspec/orm`,
  `polyspec-orm`) keep it. The legacy Go module is `github.com/polyspec/orm/legacy/packages/go`
  (`legacy/packages/go/go.mod`), the path of its directory: it holds the client (`orm`, `model` and the other generated models), the
  engine (`engine/`), the generator (`generator/`), `cmd/orm-gen`, the case harness `testcase` and
  the process events `procevent`, which the Go programs of `tests/` import and so are public
  packages, and `internal/testdb`. The Go runners, physical tests and tool programs of `tests/`
  are the module `github.com/polyspec/orm/tests` (`tests/go.mod`), the examples are
  `github.com/polyspec/orm/examples` (`examples/go.mod`), and the root `go.work` joins the three,
  so they resolve `legacy/packages/go` from the checkout with no replace directive. `tests/` and `examples/` find it
  only through the root `go.work`, so a Go command of theirs does not find it with `GOWORK=off`.
  Enforced by: `make layout-check`
- Own: The core crate `polyspec-orm` is `packages/rust`, beside its contract `packages/rust/interface.json`, and the
  binding packages that `binding scaffold` writes sit beside it: `packages/ts` (Node), `packages/ts/wasm` (WASM),
  `packages/python`, `packages/php-ext` and `packages/go` (binding design L-1). The root `Cargo.toml` is the one
  workspace of the core, its test crates under `packages/rust` and the binding crates, and the root `Cargo.lock` pins
  them all, the commit of `polyspec-binding-core` included (GN-4, CK-20), because a scaffolded binding crate takes the
  core at `../rust` and the generator checks that the root workspace holds every binding crate. A binding crate builds
  only after `make bindings` writes its generated folder, so a cargo command over the whole workspace leaves the
  binding crates out (`ORM_RUST_EXCLUDE_BINDINGS` of the Makefile), and `make lint-bindings` and `make test-bindings`
  build them. The binding Go module `packages/go` is `github.com/polyspec/orm/packages/go`, which the root `go.work`
  does not join, so its commands run with `GOWORK=off`. The npm workspaces of the root are the four dbspec editor packages by name, because
  `packages/ts` is the package `@polyspec/orm`, a name that `legacy/packages/ts` also holds.
  Enforced by: `make bindings-check`, which compares the binding packages with what binding scaffold writes (CK-19)
- Own: The editor packages of dbspec are `packages/dbspec-language` (the language service and the `dbspec-fmt`
  command), `packages/dbspec-lsp` (the language server), `packages/dbspec-codemirror` (the CodeMirror
  extension) and `packages/dbspec-vscode` (the VS Code extension). The first three are released as the
  npm archives `@polyspec/dbspec-language`, `@polyspec/dbspec-lsp` and `@polyspec/dbspec-codemirror`
  with the clients; the VS Code extension keeps the release version and is built as a `.vsix`
  (docs/spec/editor.md).
  Enforced by: none, no check compares the editor package list with the packages
- Refines P10: After integrating a branch into `main`, verify its commits
  or equivalent changes are present and its worktree is clean. Before removal, preserve any files
  excluded by `.gitignore` that exist only in that worktree and are still needed. Then remove
  the worktree with `make worktree-remove WORKTREE=<path>`, which first stops the servers of its
  `.runtime/servers` (a server whose data directory is removed under it never exits) and then
  runs `git worktree remove`, and delete the local branch immediately.
  Preserve unintegrated or active work.
  Enforced by: none, no check sees the worktrees or their removal
- Own: Each checkout builds Rust into its own target directory, `packages/rust/target` of that checkout,
  and no checkout points `CARGO_TARGET_DIR` at the target directory of another; `make` stops when a
  command line names one outside the checkout. Cargo decides that an artifact is fresh from the
  paths of its sources relative to the package and their modification times, and records no
  checkout that built it, so a checkout whose sources are older than another checkout's build
  would test that other checkout's code. Not sharing removes that cause instead of detecting it.
  The leases of the target directory still order the builds of the runs of one checkout. A
  worktree's target directory goes with the worktree when it is removed; check free disk before a
  worktree build.
  Enforced by: `make rust-check`
- Refines P24: `docs/plans/execution/checklist.md` is the only task list. Its Korean pair has the same item IDs and states. Run `make docs-check` before changing an item state. The checklist holds only items: a state marker appears only as the state at the start of an item or sub-item, never in a legend, a heading or item text, and `make docs-check` fails on any other with its file, line and column.
  Enforced by: `make docs-check`
- Own: A received instruction is triaged first: finish the item in progress unless the instruction is explicit and urgent, then place the new work by priority before starting it.
  Enforced by: none, the order of the work is a judgement of the agent
- Own: The repository's full test suite runs on GitHub CI after a push to `main` and on a manual run.
  CI splits it into the CI groups of the
  Makefile (`CI_GROUPS`, `CI_TARGETS_<group>`): one job per group, all at once, each running
  `make check-run GROUP=<group>` after only the setup steps that its targets need; the groups together
  run every target of `CHECK_TARGETS` but the gates (`CI_KIT_GATES`, the prerequisites of
  `kit-gates`, which `ci-pipeline.yml` runs in its own parallel jobs) exactly once (`make repo-check`),
  and a local `make orm-check` runs every target after its guard. One CI run must
  collect enough information to fix every failure it found before the next CI run. The run never
  stops at a failure: every target runs unless a setup step it needs failed, which records the
  target as `not-run` with that step and its first failure lines; the independent parts of a
  target run after a failed part; and the run completes the whole suite. The setup steps of CI
  (installs, toolchains, servers) are setup steps too: each runs after a failed earlier one, and a
  target that needs what a failed step installs is recorded as `not-run` with that step, so a
  failed install never stops the suite. What a target needs includes what the setup steps of its
  needs need (`SETUP_NEEDS` of scripts/check/ci-setup.mts: `databases/create` installs the decimal
  database through the TypeScript client), and `make repo-check` requires that every CI group
  runs the setup steps of all of it. Each failure records its
  inputs, the exact command, its output, the expected against the actual value and the environment
  facts relevant to it, so that it can be diagnosed without running it again locally; a failing
  case states what failed, where and why. The run ends with a summary of every target's status,
  time and first failure lines, which CI publishes as the job summary and uploads with the report
  of that run id, and the job fails when a target failed or did not run.
  Enforced by: `make repo-check`
- Own: A test step leaves nothing behind. The check runner and `make feature-owner-check` run each step with a
  temporary directory of its own (`TMPDIR`) and in a process group of its own; a passed step that
  leaves an entry in that directory, a run directory under `.runtime/run`, or a process in its
  group fails and names what it left, and a failed step's leftovers go into the report. Either way
  the runner then removes them and ends the processes. Code removes its own temporary files on
  every path, failure included: a Go `main` ends with `os.Exit(run())` and calls no `os.Exit` after
  a `defer` (`make go-vet-check`), and a Rust test holds its temporary directory in a value that
  removes it on drop. A process that starts a session of its own leaves the group and is not seen,
  so only the setup steps start servers that outlive a step.
  Enforced by: `make repo-check`
- Own: A test's result does not depend on the environment of whoever runs it. A JavaScript test starts a
  child process (make, a check script, a fake tool) with `isolatedEnvironment` of
  tests/environment.mts: `PATH`, `HOME` and `TMPDIR`, and the variables the case gives, so the
  `GROUP`, `GITHUB_ACTIONS` and `ORM_CHECK_RUN_ID` of a CI job, the `MAKEFLAGS` of a calling make
  and the variables the Makefile exports do not reach it (`make repo-check`).
  Enforced by: `make repo-check`
- Own: A behaviour that more than one runtime has is the cases of a recipe (FCV-2 of
  docs/spec/feature-coverage.md), and a native test of such a behaviour stays only where a line of FCV-2 names its file and
  test and states its reason after a colon. A native test is a test of the inventory of contracts/implementations.json that a
  feature of contracts/features.json lists and that runs no recipe (scripts/features/recipe-runners.mts); its behaviour is shared
  when the feature lists the tests of more than one implementation. An internal test with its reason is no native test.
  Enforced by: `make repo-check`, which runs scripts/repo/native-tests.mts
- Own: Performance is measured and reported; it never fails a test. A test prints its measurements (CPU and wall-clock
  time, the reference, the ratio and the machine), and a measurement above its documented reference value prints a
  `WARNING` line with the measurement, the reference and the machine, which the check runner keeps in the run record
  and the summary and writes as a GitHub `::warning::` annotation; the test still passes. A test fails only on
  correctness, and a deadline only ends a case that does not stop. `make repo-check` (and `make go-vet-check` for Go) refuses a
  test that fails on a measured time above a bound. A reference value is never raised to remove a warning; a change needs new evidence of
  the same kind from the CI runner.
  Enforced by: `make repo-check`
- Own: A check makes no registry query whose result depends on time: no latest lookup, no resolution of a
  version range, no query about outdated packages or new releases. Downloading a package that a lock
  pins by exact version and integrity is installation and is allowed. `make install` downloads what the
  checks read, the Makefile runs cargo, go, npm and Composer offline (`CARGO_NET_OFFLINE`,
  `GOPROXY=off`, `npm_config_offline`, `COMPOSER_DISABLE_NETWORK`), only the install targets and the
  targets whose help declares ONLINE (the release, the worktree setup, the PHP extension build) reach
  the network, through `$(ONLINE)`, and a missing download fails with `run make install`, never with a
  retry online.
  Enforced by: none, a judgement at review.
- Refines S4: Every toolchain the checks use is pinned in one declaration and checked: the node of `mise.toml`, the
  `go` line of `legacy/packages/go/go.mod`, the Composer of `mise.toml` and `rust-toolchain.toml` hold exact releases,
  `.php-version` and the PostgreSQL major release are as exact as their installers allow, CI
  installs what they declare, and `make repo-check` fails when a running tool differs. A new release is adopted by
  changing its declaration with the CI evidence of that release.
  Enforced by: `make repo-check`
- Own: A build output that another run or a later step reads is published atomically: it is built into a
  temporary file or directory beside it and renamed into place (`$(PUBLISH)`,
  scripts/typescript/build.mts), so a stopped build never leaves half an output.
  Enforced by: none, no check sees how a build writes its output
- Own: A failure message names the cause and the fix: a missing variable, argument, file or tool says what
  is missing and then how to provide it (`; run make <target>, which ...`). `make repo-check`
  refuses a missing-condition message without a fix.
  Enforced by: `make repo-check`
- Own: A port or database that runs share is held by a lease or owned by one run: the servers of a
  checkout listen on free ports that `make orm-test-servers` chooses, each run creates its own bench and
  decimal databases, each database case its own database, and a test names what it creates in a
  shared database after its process. No code fixes a TCP port.
  Enforced by: `make orm-test-servers-check`
- Own: Code finds its files from the working directory or from paths the Makefile gives it, never from
  the path a binary was compiled at (`runtime.Caller` in Go): that path names the checkout that
  built the binary, not the one that runs it.
  Enforced by: none, no check reads how the code finds its files
- Refines P20: During development run unit tests only: the unit cases of what changed. End-to-end runs
  (real database servers, conformance across languages, containers, full builds),
  `make owner-check` and the full suite run in CI after the push, and no local check is required
  before a push; read each CI report and fix what it finds. A CI failure is fixed as a checklist
  item; while a CI run is in progress, do not push again to react to it.
  Enforced by: none, a judgement at review
- Own: `.github/workflows/ci.yml` holds every check of the repository and runs on a push to `main` and on
  a manual run; its last job `ci-passed` runs after the jobs `test` (one job per CI group) and `docs`,
  also after a failed one, and passes only when every one of them succeeded (`make ci-passed`).
  A push whose every changed path is a document of its `paths-ignore` (`DOCUMENT_PATHS` of `scripts/repo/ci.mts`) starts
  no run of it; `.github/workflows/documents.yml` runs the checks of `DOCUMENT_CHECKS` of the Makefile on every push to
  `main` and fails a push of more than 3000 files, past which GitHub does not evaluate a path filter. A document that a
  check outside `DOCUMENT_CHECKS` reads is never ignored, and a version commit changes VERSION, so it runs every job and
  its run is the one that a release takes; `[skip ci]` is not used, since it reads the head commit of a push alone.
  `.github/workflows/docs-pages.yml` only builds and deploys the site of `main`.
  Enforced by: `make repo-check`
- Own: `make orm-check` runs the guard of kit (`full-run`) before any step: it refuses while a
  checklist item, sub-items included, is `[~]`, while tracked files have uncommitted changes, while the
  Git hooks are not installed, and when `var/full-run.json` records a full run of the same tree; it
  then runs the target `check-run` and records the result. `make rerun-failed` reruns, on the same
  tree, the targets of that record that did not pass, for a failure whose cause lies outside the tree
  (an environment or a machine resource). Do not delete or edit the record to run again. A fresh
  checkout has no record, so CI runs `make check-run GROUP=<group>`, which has no guard.
  Enforced by: none, the guard runs only in a local `make orm-check`, and no check runs that
- Own: Owner checks: `make owner-check` (or `make owner-check PATHS="<paths>"`) is a tool that runs the
  checks owning the changed files (`config/owner-checks.json` hands the paths to
  `make feature-owner-check`, which selects them with `scripts/features/owners.mts`); no rule requires it before a commit or a push, because CI runs
  the full suite after the push.
  Every verification command of `contracts/features.json` declares `inputs`, and every coverage
  part (an owner client or a dependent part) declares its `tests` and optional `inputs`. The command runs
  only the commands and parts whose inputs are a changed file or whose declared fixture data names
  one, and the commands and parts of a feature whose entry in `contracts/features.json` changed. A
  helper that several features use is declared under `helpers` with its own check and is an input
  of nothing: its change runs only that check, and `make orm-check` runs every feature that uses it.
  `make orm-check` runs each helper check once: in `make feature-helper-check`, in a stress target, or,
  for a helper whose check is a target or a setup step of `make orm-check` (`FEATURE_SUITE_HELPERS`),
  there (`make repo-check`).
  The declaration check fails on a verification command without inputs, an input that matches no
  tracked file and a helper declared as an input. It also runs every make target that `contracts/check-inputs.json`
  declares with scope `owner` and whose inputs match a changed path, such as `docs-check` and
  `docs-verify-idempotent` for a changed document. An owner target is a per-file check: a format,
  checklist, document or checker unit test. A target that runs a whole client, database or
  conformance suite has scope `suite` and runs only in `make orm-check`. Every target of
  `CHECK_TARGETS` declares its scope; `make owner-check` and `make repo-check` fail on a target
  without one. Do not choose owner checks by hand. A changed file that is no input selects nothing,
  and `make owner-check` prints that; declare it as an input of the command that runs it, and
  declare a new make target's scope. Before a commit, also search the tests and scripts for the name of every changed file and
  run the unit tests among those that read it. State the commands and their pass counts in the item's evidence.
  Enforced by: `make owner-validate`
- Own: A test file is selected by an owner target whose recipe runs it, through `paths` or `inputs` in `contracts/check-inputs.json`. A `scope` declaration (`suite` or `lint`) is only for a helper or tool that no owner target runs. It is never for a test file: declaring a test file's scope makes the check pass while the test does not run, which is the shortcut this rule forbids. Every target declared in `contracts/check-inputs.json` is listed in `CHECK_TARGETS`.
  Enforced by: `make owner-validate`
- Own: A verification that `contracts/features.json` declares with `environment: linux-runner`, such as
  `make php-without-mysql-check`, runs on the Linux runner of `.github/runner`; `make orm-check` on
  another machine prints it as a RUNNER line and does not count it. CI runs it.
  Enforced by: `make repo-check`
- Own: During an item run only the unit tests of what changed; never rerun
  tests mechanically after each fix. Every test case, a short verification unit, reports its own
  running, completion, success or failure with its elapsed time and has its own timeout; a
  whole-suite timeout is not used. A long operation (a build, an install, `tsc`, `go build`,
  `go generate`, `go vet`, `cargo build`, `cargo test --no-run`, a whole suite, a server or a tool
  run) gets detailed step logs instead of a timeout, with no deadline at all, a no-output deadline
  included, so its process and result stay observable; its success or failure comes from its
  observed result and errors, never from a clock. A time limit on a test's own computation measures the CPU time of the thread or
  process that runs it, because wall-clock time on a shared machine includes the time other
  processes hold the processors; a timer that stops a stuck case, a limit on work that a database
  or another process does, and a test of timing behavior measure wall-clock time.
  Enforced by: none, the rule governs the work of an agent; no tool sees which tests run
- Own: Complete work in progress before increasing the number of unfinished items without completed results. Keep persistent development rules in this file and concrete deliverables with their evidence in the checklist. The checklist checker rejects unnumbered policy and status prose.
  Enforced by: `make docs-check`
- Own: Go, PHP, the PHP-extension, Rust, TypeScript, and Python share one specified behavior. A database-dependent feature requires executable evidence on MySQL, PostgreSQL, and SQLite in every client. A database-independent feature requires equivalent executable cases in every client. Missing environment or a case that did not execute is a failure.
  Enforced by: `make conformance-check`
- Own: Record a conformance expectation only when every required conformance output contains exactly the declared vectors and agrees on each result. A rejected recording leaves the expectation file unchanged.
  Enforced by: `make conformance-check`
- Own: Conformance comparison and recording require nonempty, unique vector names and exactly the same vector names in each database expectation file; an omitted or extra name is an error.
  Enforced by: `make conformance-check`
- Own: Define common planner, dialect, schema, and error behavior in `legacy/packages/go/engine/*`, `legacy/packages/go/cmd/orm-gen`, and the protocol documents. Implement client behavior in its owning `packages/<runtime>/*` directory; shared verification belongs in `tests/*`, `schema/*`, and `scripts/*`. A feature remains incomplete until every supported client has its required executable cases.
  Enforced by: `make feature-verify-other`
- Own: Feature coverage evidence comes from commands executed in the current check: the exit status of the entry and the `CASE <id> [<database>] PASS` lines that it wrote (docs/spec/feature-coverage.md FCV-12). Named test files or saved output are not execution evidence. the verification commands of the features run their recipes, `make feature-coverage-of/<id>` reads the coverage of one feature, and the mutation tests of the reader run in `make feature-unit-check`. `make orm-check` runs the verification commands in `make feature-verify-rust` and `make feature-verify-other`, as the `shard` of each command declares (`rust` for a command that builds and runs Rust with cargo), and `make feature-check` runs them with `make feature-performance-check`.
  Enforced by: `make feature-unit-check`, `make feature-verify-other`
- Own: The coverage checker invokes each declared entry once and derives success from its exit status and the lines it wrote to the results file of `ORM_RECIPE_RESULTS`. Other test output cannot supply a result, and a case without a line did not pass. The checker reads no database state, since each case has a database of its own.
  Enforced by: `make feature-unit-check`
- Own: A coverage case ID names shared behavior. An entry writes that ID for a case it has passed, and the checker accepts the ID only from that line. For database cases the entry makes a database of its own for each case from the server DSNs of its run.
  Enforced by: `make feature-unit-check`, `make feature-verify-other`
- Own: An owning client executes its own behavior cases from tests located under `packages/<runtime>`. Each declared dependent part executes separate integration cases from tests in its own directory. The feature contract names both parts, test paths, and commands; missing owner or dependent-part evidence or a test path outside its part fails the coverage check. Central conformance compares client results and does not replace owner tests.
  Enforced by: `make feature-unit-check`
- Own: Use an event instead of polling or a timer to observe it. A declared deadline may use a timer. Do not use symbolic links in what this repository creates, and do not use alternate execution paths. Mermaid definitions are the source for diagrams; store generated artifacts separately from their source definitions.
  Enforced by: none, no check reads the code for polling, timers or symbolic links
- Own: A path is resolved declaratively, by a name in a tracked file, or by discovery, by a discovery rule that a document or a script states, never as a relative path.
  Enforced by: none, no check reads how the code resolves its paths
- Own: Develop one `0.0.31` version. A public client accepts one DSN URI, whose scheme selects the database, without a separate driver argument. At runtime orm is only its client library; planning and execution run in the process that calls it.
  Enforced by: none, no check reads the versions since kit K812; the package managers resolve them
- Own: Each dbspec parser rejects an `identity` column unless it is the only primary key column and its type is `i64`. Every dbspec implementation (Go, PHP, the PHP-extension, TypeScript, Python, and Rust) executes the same accepted and rejected schema cases.
  Enforced by: `make conformance-check`
- Own: SQLite live import maps only `INTEGER PRIMARY KEY AUTOINCREMENT` to the signed `i64` automatic key; an ordinary `INTEGER` remains `i32`.
  Enforced by: `make dbspec-introspect-check`
- Own: Every transformation is idempotent: emitting a parsed canonical source reproduces it byte for byte, and repeating an operation with the same input yields the same result and state.
  Enforced by: `make feature-verify-other`
- Own: Names state what the thing does, and one concept has one name in every client. A name, prefix or suffix never selects behavior; behavior is declared explicitly.
  Enforced by: none, a name is a judgement of review; no check compares names across clients
- Refines P11: Code comments and commit messages are English. A comment of a tracked code file holds no Hangul; `make comment-language-check` (T131) fails on one and names its file and line. A commit message holds no Hangul either. A new or changed comment is English (PRINCIPLES.md).
  Enforced by: `make comment-language-check`
- Own: Go value conversion, host encoding, and generated model assignment return errors for invalid values. Validate insert field assignment before writing a row, and propagate row assembly errors to the caller.
  Enforced by: `make go-test-check`
- Own: Go collection identities and scalar comparisons preserve supported value types; unsupported or lossy keys fail, and collection, relation, and split-query callers propagate the error.
  Enforced by: `make go-test-check`
- Own: Styled column setters and getters distinguish SQL NULL, an encoded null value, and an unselected column with an explicit value type. A setter rejects invalid input before changing the model; a requested unselected column reports `COLUMN_UNSELECTED`.
  Enforced by: `make go-test-check`
- Own: Generated typed model fields are private. Access to a field that was neither selected nor assigned fails with `COLUMN_UNSELECTED`; grouped counts use a dedicated result instead of a partial model.
  Enforced by: `make go-model-check`
- Own: A grouped result preserves each selected column's declared value type. A boolean group column returns a boolean on every database; an invalid stored boolean fails instead of becoming a number or a default.
  Enforced by: `make conformance-check`
- Own: Keep English and Korean documentation aligned. Records describe this repository's behavior and contain no external origin history.
  Enforced by: `make docs-check`

## Generated files

- Own: A generated file is never tracked in git. This covers dependency installs (`node_modules/`, `vendor/`, `vendor-php/`, `.venv/`, `venv/`), build output (`dist/`, `target/`, `*.egg-info/`, `*.vsix`), caches (`__pycache__/`, `*.pyc`, `docs/.vitepress/cache/`), test run artifacts (`.runtime/`, `var/`, `*.test`), and tool downloads (`var/tools/`).
  Enforced by: `.githooks/pre-commit`
- Own: The only exceptions are files the repository deliberately needs, and they are named here: the committed lock `.kit/kit.lock.json` and the test fixtures under `tests/*/fixtures/`.
  Enforced by: `.githooks/pre-commit`
- Own: Each covered path has a `.gitignore` entry. The pre-commit hook of `.githooks` refuses a staged generated path, and the repository declares its own patterns and named exceptions in `config/generated.json`.
  Enforced by: `.githooks/pre-commit`

## Releases

- Own: A release starts with a version-bump commit `chore(release): Release X.Y.Z (#<checklist ID>)` on
  `main` together with the completed work and CI improvements, before its single release-candidate CI run: it sets VERSION and every
  package file that `config/release.json` names in `manifests` to X.Y.Z,
  re-locks each such composer.json that has a `composer.lock` (`legacy/packages/php-ext`) with
  `composer update --lock` in its directory, since the content-hash of the lock covers `version`,
  and renames `## Unreleased` to `## X.Y.Z` in CHANGELOG.md and CHANGELOG.ko.md, below a new empty
  `## Unreleased`.
  Enforced by: none, a judgement at review; no check reads the versions since kit K812
- Own: After a push or manual run of `.github/workflows/ci.yml` on that commit succeeded (`ci-passed`), the maintainer
  dispatches the release with the id of that run: `gh workflow run release.yml -f run=<id>`. Its
  `make release-tag` requires that the run succeeded and that its exact commit is on `origin/main`, and creates
  and pushes the annotated tags `vX.Y.Z` and `legacy/packages/go/vX.Y.Z` at that commit, which releases the Go module
  `github.com/polyspec/orm/legacy/packages/go`; it refuses a tag that is elsewhere or lightweight. No one creates, moves or
  pushes a tag by hand. Before it tags, `scripts/repo/release-run.mts` refuses a run of any other workflow, such as
  `documents.yml` or `docs-pages.yml`, of another event, without success or, for a release that the run started, on
  another commit.
  Enforced by: `make release-tag`, `make repo-check`
- Own: `.github/workflows/release.yml` then publishes the GitHub Release from the tagged commit:
  `make release-assets`
  (`polyspec-orm-X.Y.Z.tgz` of `@polyspec/orm`, `polyspec-orm-php-X.Y.Z.zip` of `polyspec/orm`,
  `polyspec-orm-php-ext-X.Y.Z.zip` of `polyspec/orm-php-ext` and `polyspec_orm-X.Y.Z-py3-none-any.whl` of
  `polyspec-orm`), `make release-publish` (the release as a draft
  with the notes of that section; a section over 125000 characters, the limit of a GitHub release
  body, becomes one line that links the section of CHANGELOG.md at the tag) and `make release-undraft`, which makes
  it public. The tests do not run
  again; `make release-coverage` requires every manifest of the checkout to be classified in
  `config/release.json`.
  Enforced by: `make release-coverage`
- Own: The Python client (`legacy/packages/python/pyproject.toml`) is released as the wheel
  `polyspec_orm-X.Y.Z-py3-none-any.whl` (`wheel` in `config/release.json`, built by `uv build` from `build-system.requires`).
  The Rust crates `polyspec-orm`, `polyspec-orm-schema` and `polyspec-orm-build` are consumed by their git tag and have no release
  archive (`git-tag` in `config/release.json`); the version-bump commit sets the `version` of all of them
  with the other manifests.
  Enforced by: `make release-coverage`
