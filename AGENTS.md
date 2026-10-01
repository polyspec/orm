# Development rules

[Korean](AGENTS.ko.md)

- The user's instructions take precedence. Develop locally; do not add a remote or push.
- Work on `main` directly by default; use a branch and worktree when agents or parallel work need
  one. A branch or worktree left after its merge takes disk space, scatters folders and makes the
  merge state unclear.
- Name branches `{type}/{shortname}-{checklist ID}` and worktrees
  `{project}-{shortname}-{checklist ID}`. After integrating a branch into `main`, verify its commits
  or equivalent changes are present and its worktree is clean. Before removal, preserve any files
  excluded by `.gitignore` that exist only in that worktree and are still needed. Then remove the
  worktree and local branch immediately.
  Preserve unintegrated or active work.
- Before committing the related feature, cherry-pick useful commits from a test-only branch that
  cannot be integrated into `main`, discard the remaining test-only changes, and remove its worktree
  and branch. If removal is impossible, first add a numbered sub-item to the owning checklist with
  the cause and exact removal condition.
- `docs/checklist.md` is the only task list. Its Korean pair has the same item IDs and states. Run `make checklist-check` before changing an item state.
- Use `[ ]` for waiting, `[~]` for work in progress, `[o]` only when implementation, tests, and records are committed together, and `[!]` only when an unfinished item must be bypassed to advance. An `[!]` item states `Cause:` and `Retry:`. Resume it when the retry condition is met; a bypass is not completion.
- Marking an item `[o]` also writes its changelog entry in the same commit, and uncommitted
  changes cover one item only. A received instruction is triaged first: finish the item in
  progress unless the instruction is explicit and urgent, then place the new work by priority
  before starting it.
- The repository's full test suite runs once, when every checklist item is complete.
- Write commit messages in English as `type(scope): subject (#issue)`: a subject of at most 50
  characters, capitalized, imperative, without a trailing period; a blank line; a body wrapped
  near 72 characters explaining what changed and why; an optional footer for references. The
  type is one of feat, fix, docs, style, refactor, test or chore. A merge commit keeps the
  subject git writes.
- During development run only the tests of the modified area; run the full suite once, when the
  item is marked `[o]`. Every test reports its own running, completion, success or failure with
  its elapsed time and has its own timeout; a whole-suite timeout is not used. A long
  operation gets detailed step logs instead of a timeout, so its process and result stay
  observable. A time limit on a test's own computation measures the CPU time of the thread or
  process that runs it, because wall-clock time on a shared machine includes the time other
  processes hold the processors; a timer that stops a stuck case, a limit on work that a database
  or another process does, and a test of timing behavior measure wall-clock time.
- Complete work in progress before increasing the number of unfinished items without completed results. Keep persistent development rules in this file and concrete deliverables with their evidence in the checklist. The checklist checker rejects unnumbered policy and status prose.
- Define a criterion. Reproduce an observed defect with a tracked RED test, or first write a deterministic RED case whose input and required result would expose a plausible defect. Confirm failure for the intended reason before implementation, correct the cause, and run the same case and relevant use-path tests to GREEN. Investigate a case that cannot expose the problem; do not weaken a correct criterion to pass a test.
- Go, PHP, Rust, and TypeScript share one behavior contract. A database-dependent feature requires executable evidence on MySQL, PostgreSQL, and SQLite in every client. A database-independent feature requires equivalent executable cases in every client. Missing environment or a case that did not execute is a failure.
- Record a conformance expectation only when the Go, PHP, Rust, and TypeScript outputs contain exactly the declared vectors and agree on each result. A rejected recording leaves the expectation file unchanged.
- Conformance comparison and recording require nonempty, unique vector names and exactly the same vector names in each database expectation file; an omitted or extra name is an error.
- Define common planner, dialect, schema, and error behavior in `engine/*`, `cmd/orm-gen`, and the protocol documents. Implement client behavior in its owning `clients/<language>/*` directory; shared verification belongs in `tests/*`, `schema/*`, and `scripts/*`. A feature remains incomplete until every supported client has its required executable cases.
- Feature coverage evidence comes from commands executed in the current check, with exact case IDs and two equal result and database-state runs. A named test file or saved output is not execution evidence. The coverage checker and its mutation tests run in `make feature-check`.
- The coverage checker invokes declared native test files and exact case filters itself, and derives success from process exit and observed test events. Test output cannot supply a success report or database-state digest. For database cases the checker reads the declared database state before and after each run with its own state reader.
- A coverage case ID names shared behavior. Go and Rust commands map that ID to the exact native test symbol in their owning file; the checker accepts the ID only after that symbol passes. The checker supplies the selected database and DSN to the native process for database cases.
- An owning client executes its own behavior cases from tests located under `clients/<language>`. Each declared dependent part executes separate integration cases from tests in its own directory. The feature contract names both parts, test paths, and commands; missing owner or dependent-part evidence or a test path outside its part fails the coverage check. Central conformance compares client results and does not replace owner tests.
- Use an event instead of polling or a timer to observe it. A declared deadline may use a timer. Do not use symbolic links or alternate execution paths. Mermaid definitions are the source for diagrams; store generated artifacts separately from their source definitions.
- Develop one `0.0.1` version. A public client accepts one DSN URI, whose scheme selects the database, without a separate driver argument. At runtime orm is only its client library; planning and execution stay in the calling process.
- Each schema builder rejects an `auto` column unless it is a non-null signed `i64` primary key. The four clients execute the same accepted and rejected schema cases.
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
