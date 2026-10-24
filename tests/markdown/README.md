<!-- doc-id: tests-markdown-readme -->
# Markdown executor conformance

The markdown IR executor ([protocol](../../docs/spec/protocol.md#_5-ir-executors)) runs on a flowmark server, not on
a database, so its conformance has no SQL text and no bind list to compare. Each client runs the cases of
`cases.json` on one corpus that a flowmark server serves and compares the result of each case with its `expect`.

| file | role |
|---|---|
| `cases.json` | the case IDs in their order and the expected result of each, the only place a case is declared |
| `corpus/dbspec/dbspec-set.json`, `corpus/dbspec/conformance.dbs` | the catalog set and its corpus: `people` (a `document` table with `key_prefix`, a soft delete column, an update time column and a unique key), `tasks` (with a foreign key to `people`), `logs` (with an `identity` key) and `codec_rows` (with a base64 codec and an explicit-select payload) |
| `refused/aes.dbs`, `refused/audit.dbs` | catalogs that a corpus refuses: an `aes` column and an `audit` setting, which `install_refuses_aes` and `install_refuses_audit` install as a new corpus of their own and answer the code that `flowmark install` prints, `{"error": <code>}` |
| `flowmark.version` | the Go module version of `github.com/polyspec/flowmark/packages/go` whose `flowmark` the cases run on |
| `packages/go/markdownmodel` | the Go models generated from the catalog and the Go runner, `TestMarkdownConformance` |
| `packages/php/markdownmodel` | the PHP models generated from the catalog; the PHP runner is the PHPUnit test `packages/php/tests/MarkdownConformanceTest.php`, which runs each case as a data set named by its id |
| `packages/php-ext/tests/MarkdownConformanceNativeTest.php` | the same cases with the PHP extension loaded, plus a check that generated model operations enter the extension's internal `Model` methods |
| `packages/python/tests/markdown_conformance.py` | the Python runner, which generates the Python models from the catalog into its temporary directory |
| `packages/rust/tests/tests/markdown_conformance.rs` | the Rust runner, `markdown_conformance`; the `build.rs` of its crate generates the models from the catalog |
| `packages/ts/src/models/markdown_fixture` | the TypeScript models generated from the catalog, which the TypeScript runner `packages/ts/tests/markdown_conformance.mjs` checks against the generator before its cases and reports each case as `markdown-conformance/<id>` |

## Run

```sh
make orm-install-flowmark
make markdown-conformance-check
```

`make orm-install-flowmark` installs the pinned `flowmark` at `.runtime/bin/flowmark` and checks out its clean source at the pinned revision for the documentation table, and
`make markdown-conformance-check` passes that path as `FLOWMARK` to each runner, each on a server and a corpus of its
own (`make markdown-conformance-check/<client>` runs one; the TypeScript one builds the package first). A runner
reads the build information of `FLOWMARK` and fails unless its main module is `github.com/polyspec/flowmark/packages/go` at the version of
`flowmark.version`, or it is a clean checkout whose VCS revision matches that pin; a missing or other build fails the run and is never skipped. This lets a local checkout run before its revision is published.

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
outside the engine (`WRITE_CONFLICT`, not retried), a transaction with retry options that commits (`transaction_retry_commit`, `{"error", "runs"}`: the commit's code or null and how many times its callback ran, which `contracts/fixtures/ir_answers.json` also runs with a commit answered `WRITE_CONFLICT` and `DEADLOCK`), a connection whose corpus or token differs (`CONFIG`), the order of NULL ascending and descending and `orderByRandom`,
a primary key that equals another without regard to case (`DUPLICATE_KEY`, and the row an `on_duplicate` insert
meets), tuple conditions, a scalar `Sub` aggregate and an `IN` subquery, a scalar column subquery with and without
its limit (`IR_INVALID`), a column comparison that meets and one that does not (`OPERATOR_NOT_ALLOWED`), `contains`
and `contains_binary`, the `default now` of a `datetime(0)` column and a relative time function past 9999-12-31, a
read through an indexed column, the refused `force_index` (`CAPABILITY_UNSUPPORTED`), a table made unavailable by an
edit of its file (`CONSTRAINT`, naming the file, until the file is restored), a base64 codec write and decoded read,
the `COLUMN_UNSELECTED` default read of an explicit-select column, an explicit read of that value, a codec update,
and an omitted explicit-select value that remains SQL NULL, and the catalogs of `refused/` (`SCHEMA_INVALID`). A result
that holds a code next to other members writes the code alone, such as
`{"broken": "CONSTRAINT", "names_file": true, "restored": 2}`.
