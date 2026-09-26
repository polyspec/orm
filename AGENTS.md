# Development rules

[Korean](AGENTS.ko.md)

- The user's instructions take precedence. Develop locally; do not add a remote or push.
- `docs/checklist.md` is the only task list. Its Korean pair has the same item IDs and states. Run `make checklist-check` before changing an item state.
- Use `[ ]` for waiting, `[~]` for work in progress, `[o]` only when implementation, tests, and records are committed together, and `[!]` only when an unfinished item must be bypassed to advance. An `[!]` item states `Cause:` and `Retry:`. Resume it when the retry condition is met; a bypass is not completion.
- Define a criterion, reproduce missing behavior with a failing test, implement the correction, and verify a passing test. Do not weaken a correct criterion to pass a test.
- Go, PHP, Rust, and TypeScript share one behavior contract. A database-dependent feature requires executable evidence on MySQL, PostgreSQL, and SQLite in every client. A database-independent feature requires equivalent executable cases in every client. Missing environment or a case that did not execute is a failure.
- Feature coverage evidence comes from commands executed in the current check, with exact case IDs and two equal result and database-state runs. A named test file or saved output is not execution evidence. The coverage checker and its mutation tests run in `make feature-check`.
- Each schema builder rejects an `auto` column unless it is a non-null signed `i64` primary key. The four clients execute the same accepted and rejected schema cases.
- Preserve errors and input values. Do not add silent fallbacks or compatibility layers.
- Go value conversion, host encoding, and generated model assignment return errors for invalid values. Validate insert field assignment before writing a row, and propagate row assembly errors to the caller.
- Keep English and Korean documentation aligned. Commit locally as `min-median-max <max@blue.tools>` without additional author trailers. Records describe this repository's behavior and contain no external origin history.
