# Development rules

[Korean](AGENTS.ko.md)

- The user's instructions take precedence. Develop locally; do not add a remote or push.
- `docs/checklist.md` is the only task list. Its Korean pair has the same item IDs and states. Run `make checklist-check` before changing an item state.
- Use `[ ]` for waiting, `[~]` for work in progress, `[o]` only when implementation, tests, and records are committed together, and `[!]` only when an unfinished item must be bypassed to advance. An `[!]` item states `Cause:` and `Retry:`. Resume it when the retry condition is met; a bypass is not completion.
- Complete work in progress before increasing the number of unfinished items without completed results. Keep persistent development rules in this file and concrete deliverables with their evidence in the checklist. The checklist checker rejects unnumbered policy and status prose.
- Define a criterion, reproduce missing behavior with a failing test, implement the correction, and verify a passing test. Do not weaken a correct criterion to pass a test.
- Go, PHP, Rust, and TypeScript share one behavior contract. A database-dependent feature requires executable evidence on MySQL, PostgreSQL, and SQLite in every client. A database-independent feature requires equivalent executable cases in every client. Missing environment or a case that did not execute is a failure.
- Define common planner, dialect, schema, and error behavior in `engine/*`, `cmd/ormgen`, and the protocol documents. Implement client behavior in its owning `clients/<language>/*` directory; shared verification belongs in `tests/*`, `schema/*`, and `scripts/*`. A feature remains incomplete until every supported client has its required executable cases.
- Feature coverage evidence comes from commands executed in the current check, with exact case IDs and two equal result and database-state runs. A named test file or saved output is not execution evidence. The coverage checker and its mutation tests run in `make feature-check`.
- An owning client executes its own behavior cases from tests located under `clients/<language>`. Each declared dependent part executes separate integration cases from tests in its own directory. The feature contract names both parts, test paths, and commands; missing owner or dependent-part evidence or a test path outside its part fails the coverage check. Central conformance compares client results and does not replace owner tests.
- Use an event instead of polling or a timer to observe it. A declared deadline may use a timer. Do not use symbolic links or alternate execution paths. Mermaid definitions are the source for diagrams; store generated artifacts separately from their source definitions.
- Develop one `0.0.1` version. A public client accepts one DSN URI, whose scheme selects the database, without a separate driver argument. At runtime orm is only its client library; planning and execution stay in the calling process.
- Each schema builder rejects an `auto` column unless it is a non-null signed `i64` primary key. The four clients execute the same accepted and rejected schema cases.
- SQLite live import maps only `INTEGER PRIMARY KEY AUTOINCREMENT` to the signed `i64` automatic key; an ordinary `INTEGER` remains `i32`.
- Preserve errors and input values. Do not add silent fallbacks or compatibility layers.
- Go value conversion, host encoding, and generated model assignment return errors for invalid values. Validate insert field assignment before writing a row, and propagate row assembly errors to the caller.
- Keep English and Korean documentation aligned. Commit locally as `min-median-max <max@blue.tools>` without additional author trailers. Records describe this repository's behavior and contain no external origin history.
