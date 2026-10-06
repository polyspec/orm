# Development rules

[Korean](AGENTS.ko.md)

- The user's instructions take precedence. Develop locally; the GitHub remote receives a push only
  as the push rule below allows.
- Work on `main` directly by default; use a branch and worktree when agents or parallel work need
  one. A branch or worktree left after its merge takes disk space, scatters folders and makes the
  merge state unclear.
- Name branches `{type}/{shortname}-{checklist ID}` and worktrees
  `{project}-{shortname}-{checklist ID}`. After integrating a branch into `main`, verify its commits
  or equivalent changes are present and its worktree is clean. Before removal, preserve any files
  excluded by `.gitignore` that exist only in that worktree and are still needed. Then remove the
  worktree and local branch immediately.
  Preserve unintegrated or active work.
- Each checkout builds Rust into its own target directory, `clients/rust/target` of that checkout,
  and no checkout points `CARGO_TARGET_DIR` at the target directory of another; `make` stops when a
  command line names one outside the checkout. Cargo decides that an artifact is fresh from the
  paths of its sources relative to the package and their modification times, and records no
  checkout that built it, so a checkout whose sources are older than another checkout's build
  would test that other checkout's code. Not sharing removes that cause instead of detecting it.
  The leases of the target directory still order the builds of the runs of one checkout. A
  worktree's target directory goes with the worktree when it is removed; check free disk before a
  worktree build.
- Before committing the related feature, cherry-pick useful commits from a test-only branch that
  cannot be integrated into `main`, discard the remaining test-only changes, and remove its worktree
  and branch. If removal is impossible, first add a numbered sub-item to the owning checklist with
  the cause and exact removal condition.
- `docs/checklist.md` is the only task list. Its Korean pair has the same item IDs and states. Run `make checklist-check` before changing an item state. The checklist holds only items: a state marker appears only as the state at the start of an item or sub-item, never in a legend, a heading or item text, and `make checklist-check` fails on any other with its file, line and column.
- Use `[ ]` for waiting, `[~]` for work in progress, `[o]` only when implementation, tests, and records are committed together, and `[!]` only when an unfinished item must be bypassed to advance. An `[!]` item states `Cause:` and `Retry:`. Resume it when the retry condition is met; a bypass is not completion.
- Marking an item `[o]` also writes its changelog entry in the same commit, and uncommitted
  changes cover one item only. A received instruction is triaged first: finish the item in
  progress unless the instruction is explicit and urgent, then place the new work by priority
  before starting it.
- The repository's full test suite (`make check`) runs on GitHub CI after a push. One CI run must
  collect enough information to fix every failure it found before the next CI run. The run never
  stops at a failure: every target runs unless a setup step it needs failed, which records the
  target as `not-run` with that step and its first failure lines; the independent parts of a
  target run after a failed part; and the run completes the whole suite. The setup steps of CI
  (installs, toolchains, servers) are setup steps too: each runs after a failed earlier one, and a
  target that needs what a failed step installs is recorded as `not-run` with that step, so a
  failed install never stops the suite. Each failure records its
  inputs, the exact command, its output, the expected against the actual value and the environment
  facts relevant to it, so that it can be diagnosed without running it again locally; a failing
  case states what failed, where and why. The run ends with a summary of every target's status,
  time and first failure lines, which CI publishes as the job summary and uploads with the report
  of that run id, and the job fails when a target failed or did not run.
- A test step leaves nothing behind. The check runner and `make owner-check` run each step with a
  temporary directory of its own (`TMPDIR`) and in a process group of its own; a passed step that
  leaves an entry in that directory, a run directory under `.runtime/run`, or a process in its
  group fails and names what it left, and a failed step's leftovers go into the report. Either way
  the runner then removes them and ends the processes. Code removes its own temporary files on
  every path, failure included: a Go `main` ends with `os.Exit(run())` and calls no `os.Exit` after
  a `defer` (`make repo-check`), and a Rust test holds its temporary directory in a value that
  removes it on drop. A process that starts a session of its own leaves the group and is not seen,
  so only the setup steps start servers that outlive a step.
- Performance is measured and reported; it never fails a test. A test prints its measurements (CPU and wall-clock
  time, the reference, the ratio and the machine), and a measurement above its documented reference value prints a
  `WARNING` line with the measurement, the reference and the machine, which the check runner keeps in the run record
  and the summary and writes as a GitHub `::warning::` annotation; the test still passes. A test fails only on
  correctness, and a deadline only ends a case that does not stop. `make repo-check` refuses a test that fails on a
  measured time above a bound. A reference value is never raised to remove a warning; a change needs new evidence of
  the same kind from the CI runner.
- A check reads no network. `make install` downloads what the checks read, the Makefile runs cargo,
  go, npm and Composer offline (`CARGO_NET_OFFLINE`, `GOPROXY=off`, `npm_config_offline`,
  `COMPOSER_DISABLE_NETWORK`), only the install targets download, through `$(ONLINE)`, and a missing
  download fails with `run make install`, never with a retry online.
- Every toolchain the checks use is pinned in one declaration and checked: `.node-version`,
  `.go-version`, `.composer-version` and `rust-toolchain.toml` hold exact releases, `.php-version`
  and the PostgreSQL major release are as exact as their installers allow, CI installs what they
  declare, and `make repo-check` fails when a running tool differs. A new release is adopted by
  changing its declaration with the CI evidence of that release.
- A build output that another run or a later step reads is published atomically: it is built into a
  temporary file or directory beside it and renamed into place (`$(PUBLISH)`,
  scripts/typescript/build.mjs), so a stopped build never leaves half an output.
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
  (real database servers, conformance across languages, browsers, containers, full builds),
  `make owner-check` and the full suite run in CI after the push, and no local check is required
  before a push; read each CI report and fix what it finds. A push happens only when no checklist
  item is `[~]`: the pre-push hook
  `.githooks/pre-push` runs the push gate (scripts/check/push-gate.mjs), which refuses a push while
  an item is `[~]` in a pushed commit or the working tree, and the CI workflow `push-gate` checks
  the pushed commit again (`make push-gate-commit`). `make hooks` sets `core.hooksPath`, and `make
  owner-check` and the full suite's guard refuse a checkout without the hook. A CI failure is
  fixed as a checklist item; while a CI run is in progress, do not push again to react to it.
- Every change reaches `main` through a pull request and the merge queue; no command of this
  repository pushes `main`. Publish a branch with the standard commands of GitHub or the GitHub UI:
  `git push origin HEAD:refs/heads/<branch>`, `gh pr create --base main --head <branch> --fill`,
  `gh pr merge <branch> --auto --rebase`. The GitHub ruleset `main` of `.github/ruleset.json`
  requires a pull request (no approval), the merge queue with the merge method `REBASE`, a linear
  history and the GitHub Actions checks `gate` (`.github/workflows/push-gate.yml`), `test`
  (`.github/workflows/ci.yml`) and `build` (`.github/workflows/docs-pages.yml`), which run on every
  merge group; it refuses a force-push and the deletion of `main` and has no bypass actor, so
  GitHub refuses a direct push to `main`, also by an administrator. `make github-ruleset` applies
  the ruleset and the declared repository settings (`allow_rebase_merge`, `allow_auto_merge`,
  `delete_branch_on_merge`); `make github-ruleset-check` fails when they differ from the
  declaration, naming each field.
- `make check` refuses before any step while a checklist item, sub-items included, is `[~]`,
  while tracked files have uncommitted changes, and when `.runtime/full-run.json` records a full
  run of the same tree. `make rerun-failed` reruns, on the recorded commit or a
  commit that descends from it, only the targets that did not pass and the owner targets that the
  paths changed since that commit select: for a failure whose cause lies outside the tree (an
  environment or a machine resource), and for a failure of the code fixed as a checklist item
  after the full run. A commit that does not descend from the recorded one gets a new full suite,
  which runs once when every active item is complete. Do not delete or edit the record to run
  again. A fresh checkout has no record, so CI runs `make check` after every push.
- Write commit messages in English as `type(scope): subject (#issue)`: a subject of at most 50
  characters, capitalized, imperative, without a trailing period; a blank line; a body wrapped
  near 72 characters explaining what changed and why; an optional footer for references. The
  type is one of feat, fix, docs, style, refactor, test or chore. A merge commit keeps the
  subject git writes. The tracked `commit-msg` hook (`.githooks/commit-msg`, installed by `make`
  through `core.hooksPath`) refuses a commit whose subject breaks this rule, because a pushed
  commit cannot be changed. In CI `git-check` reads the subjects of the pushed range or the
  pull request, which the workflow gives make check as `ORM_GIT_RANGE`; without it the check
  reads HEAD. No tracked file records a commit id.
- Owner checks: `make owner-check` (or `make owner-check PATHS="<paths>"`) is a tool that runs the
  checks owning the changed files; no rule requires it before a commit or a push, because CI runs
  the full suite after the push.
  Every verification command of `contracts/features.json` declares `inputs`, and every coverage
  part (an owner client or a dependent part) declares its `tests` and optional `inputs`. The command runs
  only the commands and parts whose inputs are a changed file or whose declared fixture data names
  one, and the commands and parts of a feature whose entry in `contracts/features.json` changed. A
  helper that several features use is declared under `helpers` with its own check and is an input
  of nothing: its change runs only that check, and `make check` runs every feature that uses it.
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
- Define a criterion. Reproduce an observed defect with a tracked RED test, or first write a deterministic RED case whose input and required result would expose a plausible defect. Confirm failure for the intended reason before implementation, correct the cause, and run the same case and relevant use-path tests to GREEN. Investigate a case that cannot expose the problem; do not weaken a correct criterion to pass a test.
- Go, PHP, Rust, and TypeScript share one behavior contract. A database-dependent feature requires executable evidence on MySQL, PostgreSQL, and SQLite in every client. A database-independent feature requires equivalent executable cases in every client. Missing environment or a case that did not execute is a failure.
- Record a conformance expectation only when the Go, PHP, Rust, and TypeScript outputs contain exactly the declared vectors and agree on each result. A rejected recording leaves the expectation file unchanged.
- Conformance comparison and recording require nonempty, unique vector names and exactly the same vector names in each database expectation file; an omitted or extra name is an error.
- Define common planner, dialect, schema, and error behavior in `engine/*`, `cmd/orm-gen`, and the protocol documents. Implement client behavior in its owning `clients/<language>/*` directory; shared verification belongs in `tests/*`, `schema/*`, and `scripts/*`. A feature remains incomplete until every supported client has its required executable cases.
- Feature coverage evidence comes from commands executed in the current check, with exact case IDs and two equal result and database-state runs. A named test file or saved output is not execution evidence. The coverage checker runs in `make feature-check`, and its mutation tests run in `make feature-unit-check`.
- The coverage checker invokes declared native test files and exact case filters itself, and derives success from process exit and observed test events. Test output cannot supply a success report or database-state digest. For database cases the checker reads the declared database state before and after each run with its own state reader.
- A coverage case ID names shared behavior. Go and Rust commands map that ID to the exact native test symbol in their owning file; the checker accepts the ID only after that symbol passes. The checker supplies the selected database and DSN to the native process for database cases.
- An owning client executes its own behavior cases from tests located under `clients/<language>`. Each declared dependent part executes separate integration cases from tests in its own directory. The feature contract names both parts, test paths, and commands; missing owner or dependent-part evidence or a test path outside its part fails the coverage check. Central conformance compares client results and does not replace owner tests.
- Use an event instead of polling or a timer to observe it. A declared deadline may use a timer. Do not use symbolic links or alternate execution paths. Mermaid definitions are the source for diagrams; store generated artifacts separately from their source definitions.
- Develop one `0.0.2` version. A public client accepts one DSN URI, whose scheme selects the database, without a separate driver argument. At runtime orm is only its client library; planning and execution run in the process that calls it.
- Each dbspec parser rejects an `identity` column unless it is the only primary key column and its type is `i64`. The four clients execute the same accepted and rejected schema cases.
- SQLite live import maps only `INTEGER PRIMARY KEY AUTOINCREMENT` to the signed `i64` automatic key; an ordinary `INTEGER` remains `i32`.
- Preserve errors and input values. Do not add silent fallbacks or compatibility layers.
- Every transformation is idempotent: emitting a parsed canonical source reproduces it byte for byte, and repeating an operation with the same input yields the same result and state.
- Names state what the thing does, and one concept has one name in every client. A name, prefix or suffix never selects behavior; behavior is declared explicitly.
- Code comments are written in Korean, with technical terms in English. Identifiers, logs, error messages and test names are written in English.
- Go value conversion, host encoding, and generated model assignment return errors for invalid values. Validate insert field assignment before writing a row, and propagate row assembly errors to the caller.
- Go collection identities and scalar comparisons preserve supported value types; unsupported or lossy keys fail, and collection, relation, and split-query callers propagate the error.
- Styled column setters and getters distinguish SQL NULL, an encoded null value, and an unselected column with an explicit value type. A setter rejects invalid input before changing the model; a requested unselected column reports `COLUMN_UNSELECTED`.
- Generated typed model fields are private. Access to a field that was neither selected nor assigned fails with `COLUMN_UNSELECTED`; grouped counts use a dedicated result instead of a partial model.
- A grouped result preserves each selected column's declared value type. A boolean group column returns a boolean on every database; an invalid stored boolean fails instead of becoming a number or a default.
- Keep English and Korean documentation aligned. Commit locally as `min-median-max <max@blue.tools>` without additional author trailers. Records describe this repository's behavior and contain no external origin history.
