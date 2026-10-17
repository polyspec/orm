<!-- doc-id: agents -->
# Development rules

[Korean](AGENTS.ko.md)

The working principles and standards of every polyspec repository are in [PRINCIPLES.md](PRINCIPLES.md), which kit
vendors; this file states only the rules of orm.

- The user's instructions take precedence. Develop locally; the GitHub remote receives a push only
  as the push rule below allows.
- Work on `main` directly by default; use a branch and worktree when agents or parallel work need
  one. A branch or worktree left after its merge takes disk space, scatters folders and makes the
  merge state unclear.
- The 0.x workflow has no pull request, merge queue or ruleset. Work locally item by item: an item
  becomes `[o]` when its unit tests pass on the committed tree. `main` receives one push, when no
  item is `[~]` and the work of the push is complete; the CI of that push must succeed (`push-gate`
  and the job `ci-passed` of `.github/workflows/ci.yml`) before the version-bump commit and the tag.
  Only the maintainer creates, moves or pushes a tag, and the push of a tag runs the release
  workflow. A release asset is named `<package>-<language>-<version>.<ext>`, for example
  `polyspec-orm-npm-X.Y.Z.tgz`; the Python wheel keeps its PEP 427 name,
  `polyspec_orm-X.Y.Z-py3-none-any.whl`.
- The shared tools are the npm package `@polyspec/kit`, a devDependency of `package.json` pinned to
  the asset of its release with its integrity. A checkout installs it with `make install-tools
  TOOLS=npm` (the npm of `packageManager`) and `make install-packages`, and the Makefile includes
  `scripts/kit/kit-bootstrap.mk`, which includes the `kit.mk` of the installed package. The files of
  `kit.copies` of its `package.json` (the bootstrap under `scripts/kit/`, PRINCIPLES.md (+ko),
  `.github/workflows/release.yml`, `config/layout.kit.yml` and the lint configurations) are copies
  that `make kit-sync` writes from the installed package and `make kit-check` compares with it; they
  change only in kit. This repository differs from the other repositories only in `config/*.json`
  and in its own product code (`scripts/check`, `scripts/features`, `scripts/repo`, the clients and
  the checks of the database servers); a tool that kit lacks or gets wrong is reported to kit, never
  copied or edited here. The rules of this repository do not read the copies.
  While polyspec versions are 0.0.x, development checkouts link installed polyspec packages to
  their source as kit `docs/plans/local-links.md` describes; links are never committed.
- The client packages are `packages/<runtime>` with the runtime `go`, `ts` (the TypeScript client),
  `php`, `php-ext` (the PHP extension), `python` and `rust` (S5 of PRINCIPLES.md): a folder name
  carries no repository prefix, and the distribution names (`@polyspec/orm`, `polyspec/orm`,
  `polyspec-orm`) keep it. The Go module is `github.com/polyspec/orm/packages/go`
  (`packages/go/go.mod`): it holds the client (`orm`, `model` and the other generated models), the
  engine (`engine/`), the generator (`generator/`), `cmd/orm-gen`, the case harness `testcase` and
  the process events `procevent`, which the Go programs of `tests/` import and so are public
  packages, and `internal/testdb`. The Go runners, physical tests and tool programs of `tests/`
  are the module `github.com/polyspec/orm/tests` (`tests/go.mod`), the examples are
  `github.com/polyspec/orm/examples` (`examples/go.mod`), and the root `go.work` joins the three,
  so they resolve `packages/go` from the checkout with no replace directive.
- The editor packages of dbspec are `packages/dbspec-language` (the language service and the `dbspec-fmt`
  command), `packages/dbspec-lsp` (the language server), `packages/dbspec-codemirror` (the CodeMirror
  extension) and `packages/dbspec-vscode` (the VS Code extension). The first three are released as the
  npm archives `@polyspec/dbspec-language`, `@polyspec/dbspec-lsp` and `@polyspec/dbspec-codemirror`
  with the clients; the VS Code extension keeps the release version and is built as a `.vsix`
  (docs/editor.md).
- Name branches `{type}/{shortname}-{checklist ID}` and worktrees
  `{project}-{shortname}-{checklist ID}`. After integrating a branch into `main`, verify its commits
  or equivalent changes are present and its worktree is clean. Before removal, preserve any files
  excluded by `.gitignore` that exist only in that worktree and are still needed, and run
  `make test-servers-stop` there: its servers run from its `.runtime/servers`, and a server whose
  data directory is removed under it never exits. Then remove the worktree and local branch
  immediately.
  Preserve unintegrated or active work.
- Each checkout builds Rust into its own target directory, `packages/rust/target` of that checkout,
  and no checkout points `CARGO_TARGET_DIR` at the target directory of another; `make` stops when a
  command line names one outside the checkout. Cargo decides that an artifact is fresh from the
  paths of its sources relative to the package and their modification times, and records no
  checkout that built it, so a checkout whose sources are older than another checkout's build
  would test that other checkout's code. Not sharing removes that cause instead of detecting it.
  The leases of the target directory still order the builds of the runs of one checkout. A
  worktree's target directory goes with the worktree when it is removed; check free disk before a
  worktree build.
- `docs/plans/execution-checklist.md` is the only task list. Its Korean pair has the same item IDs and states. Run `make documents-check` before changing an item state. The checklist holds only items: a state marker appears only as the state at the start of an item or sub-item, never in a legend, a heading or item text, and `make documents-check` fails on any other with its file, line and column.
- Use `[ ]` for waiting, `[~]` for work in progress, `[o]` only when implementation, tests, and records are committed together, `[!]` only when an unfinished item must be bypassed to advance, and `[-]` when the item is impossible: it can never complete, so nothing resumes and it is no bypass. An `[!]` item states `Cause:` and `Retry:`; resume it when the retry condition is met, for a bypass is not completion. A `[-]` item states `Cause:` and is terminal, as `[o]` is.
- Marking an item `[o]` also writes its changelog entry under `## Unreleased` at the top of
  CHANGELOG.md and CHANGELOG.ko.md in the same commit (`make version-check`), and uncommitted
  changes cover one item only. A received instruction is triaged first: finish the item in
  progress unless the instruction is explicit and urgent, then place the new work by priority
  before starting it.
- The repository's full test suite runs on GitHub CI after a push to `main` and on a manual run.
  CI splits it into the CI groups of the
  Makefile (`CI_GROUPS`, `CI_TARGETS_<group>`): one job per group, all at once, each running
  `make check-run GROUP=<group>` after only the setup steps that its targets need; the groups together
  run every target of `CHECK_TARGETS` exactly once (`make repo-check`), and a local `make check`
  runs every target after its guard. One CI run must
  collect enough information to fix every failure it found before the next CI run. The run never
  stops at a failure: every target runs unless a setup step it needs failed, which records the
  target as `not-run` with that step and its first failure lines; the independent parts of a
  target run after a failed part; and the run completes the whole suite. The setup steps of CI
  (installs, toolchains, servers) are setup steps too: each runs after a failed earlier one, and a
  target that needs what a failed step installs is recorded as `not-run` with that step, so a
  failed install never stops the suite. What a target needs includes what the setup steps of its
  needs need (`SETUP_NEEDS` of scripts/check/ci-setup.mts: `databases/create` installs the decimal
  database with PHP and the Composer autoload), and `make repo-check` requires that every CI group
  runs the setup steps of all of it. Each failure records its
  inputs, the exact command, its output, the expected against the actual value and the environment
  facts relevant to it, so that it can be diagnosed without running it again locally; a failing
  case states what failed, where and why. The run ends with a summary of every target's status,
  time and first failure lines, which CI publishes as the job summary and uploads with the report
  of that run id, and the job fails when a target failed or did not run.
- A test step leaves nothing behind. The check runner and `make feature-owner-check` run each step with a
  temporary directory of its own (`TMPDIR`) and in a process group of its own; a passed step that
  leaves an entry in that directory, a run directory under `.runtime/run`, or a process in its
  group fails and names what it left, and a failed step's leftovers go into the report. Either way
  the runner then removes them and ends the processes. Code removes its own temporary files on
  every path, failure included: a Go `main` ends with `os.Exit(run())` and calls no `os.Exit` after
  a `defer` (`make go-vet-check`), and a Rust test holds its temporary directory in a value that
  removes it on drop. A process that starts a session of its own leaves the group and is not seen,
  so only the setup steps start servers that outlive a step.
- A test's result does not depend on the environment of whoever runs it. A JavaScript test starts a
  child process (make, a check script, a fake tool) with `isolatedEnvironment` of
  tests/environment.mts: `PATH`, `HOME` and `TMPDIR`, and the variables the case gives, so the
  `GROUP`, `GITHUB_ACTIONS` and `ORM_CHECK_RUN_ID` of a CI job, the `MAKEFLAGS` of a calling make
  and the variables the Makefile exports do not reach it (`make repo-check`).
- Performance is measured and reported; it never fails a test. A test prints its measurements (CPU and wall-clock
  time, the reference, the ratio and the machine), and a measurement above its documented reference value prints a
  `WARNING` line with the measurement, the reference and the machine, which the check runner keeps in the run record
  and the summary and writes as a GitHub `::warning::` annotation; the test still passes. A test fails only on
  correctness, and a deadline only ends a case that does not stop. `make repo-check` (and `make go-vet-check` for Go) refuses a
  test that fails on a measured time above a bound. A reference value is never raised to remove a warning; a change needs new evidence of
  the same kind from the CI runner.
- A check makes no registry query whose result depends on time: no latest lookup, no resolution of a
  version range, no query about outdated packages or new releases. Downloading a package that a lock
  pins by exact version and integrity is installation and is allowed. `make install` downloads what the
  checks read, the Makefile runs cargo, go, npm and Composer offline (`CARGO_NET_OFFLINE`,
  `GOPROXY=off`, `npm_config_offline`, `COMPOSER_DISABLE_NETWORK`), only the install targets resolve
  versions, through `$(ONLINE)`, and a missing download fails with `run make install`, never with a
  retry online.
- A dependency is raised to its latest stable release, or kept by an exception of
  `config/dependency-policy.json` that states a reproducible reason, the condition that removes it and
  the commands that verify it. `make dependency-review UPDATE=1 RECORD=1` (online; it needs
  `cargoAudit` and `govulncheck` of `config/toolchain.json`, which `make install-tools` installs)
  asks the registries and the advisory databases and writes `config/dependency-review.json`;
  `make dependency-policy-check` and `make dependency-policy-mutation-check` read that record and
  the manifests and locks and query no registry.
- Every toolchain the checks use is pinned in one declaration and checked: the node of `mise.toml`, the
  `go` line of `packages/go/go.mod`, the Composer of `mise.toml` and `rust-toolchain.toml` hold exact releases,
  `.php-version` and the PostgreSQL major release are as exact as their installers allow, CI
  installs what they declare, and `make toolchain-check` and `make repo-check` fail when a running
  tool differs. A new release is adopted by
  changing its declaration with the CI evidence of that release.
- A build output that another run or a later step reads is published atomically: it is built into a
  temporary file or directory beside it and renamed into place (`$(PUBLISH)`,
  scripts/typescript/build.mts), so a stopped build never leaves half an output.
- A failure message names the cause and the fix: a missing variable, argument, file or tool says what
  is missing and then how to provide it (`; run make <target>, which ...`). `make repo-check`
  refuses a missing-condition message without a fix.
- A port or database that runs share is held by a lease or owned by one run: the servers of a
  checkout listen on free ports that `make test-servers` chooses, each run creates its own bench and
  decimal databases, each database case its own database, and a test names what it creates in a
  shared database after its process. No code fixes a TCP port.
- Code finds its files from the working directory or from paths the Makefile gives it, never from
  the path a binary was compiled at (`runtime.Caller` in Go): that path names the checkout that
  built the binary, not the one that runs it.
- During development run unit tests only: the Red/Green unit cases of what changed. End-to-end runs
  (real database servers, conformance across languages, containers, full builds),
  `make owner-check` and the full suite run in CI after the push, and no local check is required
  before a push; read each CI report and fix what it finds. A push happens only when no checklist
  item is `[~]`: the pre-push hook
  `.githooks/pre-push` runs the push gate of kit through `make push-gate-hook`, which refuses a push while
  an item is `[~]` in a pushed commit or the working tree, and the CI workflow `push-gate` checks
  the commit again on every push (`make push-gate-commit`). `make hooks` sets `core.hooksPath`, and
  `make hooks-check` and the full suite's guard refuse a checkout without the hook. A CI failure is
  fixed as a checklist item; while a CI run is in progress, do not push again to react to it.
- `.github/workflows/ci.yml` holds every check of the repository and runs on a push to `main` and on
  a manual run; its last job `ci-passed` runs after the jobs `test` (one job per CI group) and `docs`,
  also after a failed one, and passes only when every one of them succeeded (`make ci-passed`).
  `.github/workflows/push-gate.yml` runs the push gate on every push, and
  `.github/workflows/docs-pages.yml` only builds and deploys the site of `main`.
- `make check` runs the guard of kit (`full-run`) before any step: it refuses while a
  checklist item, sub-items included, is `[~]`, while tracked files have uncommitted changes, while the
  Git hooks are not installed, and when `var/full-run.json` records a full run of the same tree; it
  then runs the target `check-run` and records the result. `make rerun-failed` reruns, on the same
  tree, the targets of that record that did not pass, for a failure whose cause lies outside the tree
  (an environment or a machine resource). Do not delete or edit the record to run again. A fresh
  checkout has no record, so CI runs `make check-run GROUP=<group>`, which has no guard.
- Write commit messages in English as `type(scope): subject (#issue)`: a subject of at most 50
  characters, capitalized, imperative, without a trailing period; a blank line; a body wrapped
  near 72 characters explaining what changed and why; an optional footer for references. The
  type is one of feat, fix, docs, style, refactor, test or chore. A merge commit keeps the
  subject git writes. The tracked `commit-msg` hook (`.githooks/commit-msg`, installed by `make`
  through `core.hooksPath`) runs `make commit-msg-check` and refuses a commit whose subject breaks this rule, because a pushed
  commit cannot be changed. `make commits-check` (kit's `check-commits`, `config/commits.json`)
  checks the messages of `RANGE` (`<base>..<head>`) and the message of HEAD without it; the types
  and the limits are the data of `config/commits.json`. No tracked file records a commit id.
- Owner checks: `make owner-check` (or `make owner-check PATHS="<paths>"`) is a tool that runs the
  checks owning the changed files (`config/owner-checks.json` hands the paths to
  `make feature-owner-check`, which selects them with `scripts/features/owners.mts`); no rule requires it before a commit or a push, because CI runs
  the full suite after the push.
  Every verification command of `contracts/features.json` declares `inputs`, and every coverage
  part (an owner client or a dependent part) declares its `tests` and optional `inputs`. The command runs
  only the commands and parts whose inputs are a changed file or whose declared fixture data names
  one, and the commands and parts of a feature whose entry in `contracts/features.json` changed. A
  helper that several features use is declared under `helpers` with its own check and is an input
  of nothing: its change runs only that check, and `make check` runs every feature that uses it.
  `make check` runs each helper check once: in `make feature-helper-check`, in a stress target, or,
  for a helper whose check is a target or a setup step of `make check` (`FEATURE_SUITE_HELPERS`),
  there (`make repo-check`).
  The declaration check fails on a verification command without inputs, an input that matches no
  tracked file and a helper declared as an input. It also runs every make target that `contracts/check-inputs.json`
  declares with scope `owner` and whose inputs match a changed path, such as `docs-check` and
  `docs-verify-idempotent` for a changed document. An owner target is a per-file check: a format,
  checklist, document or checker unit test. A target that runs a whole client, database or
  conformance suite has scope `suite` and runs only in `make check`. Every target of
  `CHECK_TARGETS` declares its scope; `make owner-check` and `make repo-check` fail on a target
  without one. Do not choose owner checks by hand. A changed file that is no input selects nothing,
  and `make owner-check` prints that; declare it as an input of the command that runs it, and
  declare a new make target's scope. Before a commit, also search the tests and scripts for the name of every changed file and
  run the unit tests among those that read it. State the commands and their pass counts in the item's evidence.
- A verification that `contracts/features.json` declares with `environment: linux-runner`, such as
  `make php-without-mysql-check`, runs on the Linux runner of `.github/runner`; `make check` on
  another machine prints it as a RUNNER line and does not count it. CI runs it.
- During an item run only the Red/Green unit tests of what changed; never rerun
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
- Complete work in progress before increasing the number of unfinished items without completed results. Keep persistent development rules in this file and concrete deliverables with their evidence in the checklist. The checklist checker rejects unnumbered policy and status prose.
- Go, PHP, Rust, TypeScript, and Python share one specified behavior. A database-dependent feature requires executable evidence on MySQL, PostgreSQL, and SQLite in every client. A database-independent feature requires equivalent executable cases in every client. Missing environment or a case that did not execute is a failure.
- Record a conformance expectation only when the Go, PHP, Rust, TypeScript, and Python outputs contain exactly the declared vectors and agree on each result. A rejected recording leaves the expectation file unchanged.
- Conformance comparison and recording require nonempty, unique vector names and exactly the same vector names in each database expectation file; an omitted or extra name is an error.
- Define common planner, dialect, schema, and error behavior in `packages/go/engine/*`, `packages/go/cmd/orm-gen`, and the protocol documents. Implement client behavior in its owning `packages/<runtime>/*` directory; shared verification belongs in `tests/*`, `schema/*`, and `scripts/*`. A feature remains incomplete until every supported client has its required executable cases.
- Feature coverage evidence comes from commands executed in the current check, with exact case IDs and two equal result and database-state runs. A named test file or saved output is not execution evidence. The coverage checker runs in `make feature-coverage`, and its mutation tests run in `make feature-unit-check`. `make check` runs the verification commands in `make feature-verify-rust` and `make feature-verify-other`, as the `shard` of each command declares (`rust` for a command that builds and runs Rust with cargo), and `make feature-check` runs the three.
- The coverage checker invokes declared native test files and exact case filters itself, and derives success from process exit and observed test events. Test output cannot supply a success report or database-state digest. For database cases the checker reads the declared database state before and after each run with its own state reader.
- A coverage case ID names shared behavior. Go and Rust commands map that ID to the exact native test symbol in their owning file; the checker accepts the ID only after that symbol passes. The checker supplies the selected database and DSN to the native process for database cases.
- An owning client executes its own behavior cases from tests located under `packages/<runtime>`. Each declared dependent part executes separate integration cases from tests in its own directory. The feature contract names both parts, test paths, and commands; missing owner or dependent-part evidence or a test path outside its part fails the coverage check. Central conformance compares client results and does not replace owner tests.
- Use an event instead of polling or a timer to observe it. A declared deadline may use a timer. Do not use symbolic links in what this repository creates, and do not use alternate execution paths. Mermaid definitions are the source for diagrams; store generated artifacts separately from their source definitions.
- Do not rebuild what an existing outside tool or library already does. Use the standard tool of its ecosystem as it is (for example uv for Python interpreters, environments and locks, Composer for PHP dependencies), and accept its own behavior, such as the symbolic links that it creates; our rules govern what we create.
- A path is resolved declaratively, by a name in a tracked file, or by discovery, by a discovery rule that a document or a script states, never as a relative path.
- Develop one `0.0.18` version. A public client accepts one DSN URI, whose scheme selects the database, without a separate driver argument. At runtime orm is only its client library; planning and execution run in the process that calls it.
- Each dbspec parser rejects an `identity` column unless it is the only primary key column and its type is `i64`. Every dbspec implementation (Go, PHP, the PHP extension, TypeScript, Python, and Rust) executes the same accepted and rejected schema cases.
- SQLite live import maps only `INTEGER PRIMARY KEY AUTOINCREMENT` to the signed `i64` automatic key; an ordinary `INTEGER` remains `i32`.
- Every transformation is idempotent: emitting a parsed canonical source reproduces it byte for byte, and repeating an operation with the same input yields the same result and state.
- Names state what the thing does, and one concept has one name in every client. A name, prefix or suffix never selects behavior; behavior is declared explicitly.
- The Korean code comments that remain are translated to English under T131; a new or changed comment is English (PRINCIPLES.md).
- Go value conversion, host encoding, and generated model assignment return errors for invalid values. Validate insert field assignment before writing a row, and propagate row assembly errors to the caller.
- Go collection identities and scalar comparisons preserve supported value types; unsupported or lossy keys fail, and collection, relation, and split-query callers propagate the error.
- Styled column setters and getters distinguish SQL NULL, an encoded null value, and an unselected column with an explicit value type. A setter rejects invalid input before changing the model; a requested unselected column reports `COLUMN_UNSELECTED`.
- Generated typed model fields are private. Access to a field that was neither selected nor assigned fails with `COLUMN_UNSELECTED`; grouped counts use a dedicated result instead of a partial model.
- A grouped result preserves each selected column's declared value type. A boolean group column returns a boolean on every database; an invalid stored boolean fails instead of becoming a number or a default.
- Keep English and Korean documentation aligned. Commit locally as `min-0-max <max@blue.tools>` without additional author trailers. Records describe this repository's behavior and contain no external origin history.

## Generated files

- A generated file is never tracked in git. This covers dependency installs (`node_modules/`, `vendor/`, `vendor-php/`, `.venv/`, `venv/`), build output (`dist/`, `target/`, `*.egg-info/`, `*.vsix`), caches (`__pycache__/`, `*.pyc`, `docs/.vitepress/cache/`), test run artifacts (`.runtime/`, `var/`, `*.test`), and tool downloads (`var/tools/`).
- The only exceptions are files the repository deliberately needs, and they are named here: the committed lock `.kit/kit.lock.json` and the test fixtures under `tests/*/fixtures/`.
- Each covered path has a `.gitignore` entry. The kit pre-commit hook refuses a staged generated path, and the repository declares its own patterns and named exceptions in `config/generated.json`.

## Releases

- A release starts with a version-bump commit `chore(release): Release X.Y.Z (#<checklist ID>)` on
  `main`, after the CI of the commit that carries the work succeeded: it sets VERSION and every
  package file that `config/release.json` names in `manifests` to X.Y.Z (`make version-check`),
  re-locks each such composer.json that has a `composer.lock` (`packages/php-ext`) with
  `composer update --lock` in its directory, since the content-hash of the lock covers `version`,
  then runs `make dependency-review RECORD=1` (`make dependency-policy-check` fails a stale lock), and
  renames `## Unreleased` to `## X.Y.Z` in CHANGELOG.md and CHANGELOG.ko.md, below a new empty
  `## Unreleased`.
- After the CI of that commit succeeded (`push-gate` and `ci-passed`), the maintainer tags it
  `vX.Y.Z` and pushes it with the Go module tag `packages/go/vX.Y.Z` at the same commit, which
  releases the Go module `github.com/polyspec/orm/packages/go`. Only the maintainer creates, moves or pushes a tag.
- The push of the tag runs `.github/workflows/release.yml`, which publishes the GitHub Release:
  `make release-verify` (the commit is on `main` and its checks `push-gate` and `ci-passed`
  succeeded), `make release-versions` (every released manifest carries X.Y.Z, the module path of
  `packages/go/go.mod` is `github.com/polyspec/orm/packages/go` and the changelogs have its section), `make release-assets`
  (`polyspec-orm-npm-X.Y.Z.tgz` of `@polyspec/orm`, `polyspec-orm-php-X.Y.Z.zip` of `polyspec/orm`,
  `polyspec-orm-dbspec-php-X.Y.Z.zip` of `polyspec/orm-dbspec` and `polyspec_orm-X.Y.Z-py3-none-any.whl` of
  `polyspec-orm`) and `make release-publish` (the release
  with the notes of that section; a section over 125000 characters, the limit of a GitHub release
  body, becomes one line that links the section of CHANGELOG.md at the tag). The tests do not run
  again; `make release-coverage` requires every manifest of the checkout to be classified in
  `config/release.json`.
- The Python client (`packages/python/pyproject.toml`) is released as the wheel
  `polyspec_orm-X.Y.Z-py3-none-any.whl` (`wheel` in `config/release.json`, with the pinned `buildBackend`).
  The Rust crates `polyspec-orm`, `polyspec-orm-schema` and `polyspec-orm-build` are consumed by their git tag and have no release
  archive (`git-tag` in `config/release.json`); the version-bump commit sets the `version` of all of them
  with the other manifests.
