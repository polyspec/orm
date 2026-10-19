<!-- doc-id: tests-markdown-readme -->
# Markdown executor conformance

The markdown IR executor ([protocol](../../docs/spec/protocol.md#_5-ir-executors)) runs on a flowmark server, not on
a database, so its conformance has no SQL text and no bind list to compare. Each client runs the cases of
`cases.json` on one corpus that a flowmark server serves and compares the result of each case with its `expect`.

| file | role |
|---|---|
| `cases.json` | the case IDs in their order and the expected result of each, the only place a case is declared |
| `corpus/dbspec/conformance.dbs` | the catalog of the corpus: `people` (a `document` table with `key_prefix`, a soft delete column, an update time column and a unique key), `tasks` (with a foreign key to `people`) and `logs` (with an `identity` key) |
| `flowmark.version` | the Go module version of `github.com/polyspec/flowmark` whose `flowmark` the cases run on |
| `packages/go/markdownmodel` | the Go models generated from the catalog and the Go runner, `TestMarkdownConformance` |
| `packages/php/markdownmodel` | the PHP models generated from the catalog; the PHP runner is the PHPUnit test `packages/php/tests/MarkdownConformanceTest.php`, which runs each case as a data set named by its id |
| `packages/python/tests/markdown_conformance.py` | the Python runner, which generates the Python models from the catalog into its temporary directory |
| `packages/rust/tests/tests/markdown_conformance.rs` | the Rust runner, `markdown_conformance`; the `build.rs` of its crate generates the models from the catalog |
| `packages/ts/src/models/markdown_fixture` | the TypeScript models generated from the catalog, which the TypeScript runner `packages/ts/tests/markdown_conformance.mjs` checks against the generator before its cases and reports each case as `markdown-conformance/<id>` |

## Run

```sh
make orm-install-flowmark
make markdown-conformance-check
```

`make orm-install-flowmark` installs the pinned `flowmark` at `.runtime/bin/flowmark`, and
`make markdown-conformance-check` passes that path as `FLOWMARK` to each runner, each on a server and a corpus of its
own (`make markdown-conformance-check/<client>` runs one; the TypeScript one builds the package first). A runner
reads the build information of `FLOWMARK` (the PHP runner and the Python runner with `go version -m`) and fails unless its main module is `github.com/polyspec/flowmark` at the version of
`flowmark.version`; a missing or other build fails the run and is never skipped. A build of a flowmark checkout
at the pinned revision carries the same version, so `make markdown-conformance-check FLOWMARK=<its path>` runs
the cases on it.

The runner copies the catalog into a new directory named `conformance`, runs `flowmark install` on it, starts
`flowmark serve <corpus> --port 0`, reads the port from its listening line and the token from
`.flowmark/server.json`, and connects with `markdown://127.0.0.1:<port>/conformance?token=<token>`. It then
runs every case of `cases.json` in order on that one corpus, so a case reads the rows the cases before it
wrote, and it stops at the first failure. The set of cases the runner implements must equal the set of
`cases.json`; a missing or extra case fails before any case runs. At its end the runner closes the connection
and stops the server.

## Results

A case's result is a JSON value compared with `expect` after both are read as JSON:

- a model is its array form (`toArray`), a collection the list of the array forms in collection order, and a
  grouped count the list of its group rows;
- a `date` value is its runtime value model text `YYYY-MM-DD` ([protocol](../../docs/spec/protocol.md#_5-ir-executors)),
  whatever type the client holds it in: a client whose array form writes a date as a datetime writes it as that text;
- a count, a sum, an average and the row count of a write are numbers, and `paginate` is
  `{"items", "total_count", "total_pages"}`;
- a failed case is `{"error": <code>}`, the orm code of the error, and `write_conflict` is
  `{"error": <code>, "name": <name>}`: the code of the commit and the name of `P1` read after it;
- a case that writes and reads back answers what it read back, as `cases.json` gives it.

Each case covers one surface of the capability table: every IR kind (`one`, `all`, `count`, `group_count`,
`sum`, `avg`, `paginate`, `insert` with one row, several rows, an `identity` key and `on_duplicate`, `update`
with and without `optimistic`, `delete` with its foreign key refusal and the soft delete, `restore`), joins and
relations, transactions with their commit, rollback and savepoint rollback, a read-only transaction, the row lock
`update` and the refused `update_nowait`, the refused `getQuery()` and `isolation`, a commit that meets an edit
outside the engine (`WRITE_CONFLICT`, not retried), a transaction with retry options that commits (`transaction_retry_commit`, `{"error", "runs"}`: the commit's code or null and how many times its callback ran, which `contracts/fixtures/ir_answers.json` also runs with a commit answered `WRITE_CONFLICT` and `DEADLOCK`), and a connection whose corpus or token differs (`CONFIG`).
