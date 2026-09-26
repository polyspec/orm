# Conformance vectors

One document, four runners. Every vector is the same chain written in Go,
PHP, Rust, and TypeScript; each runner executes it against the seeded bench database
`orm_bench` and prints

```json
{"<vector>": {"statements": [{"sql": "...", "binds": [...]}], "result": ...}}
```

`check` compares JSON numbers as exact rational values and records their original
decimal representation. It sorts object keys for readable output and compares
every language against `vectors.json`: same SQL, same binds in
the same order, same typed results (ints as numbers, bools as booleans,
datetimes as `YYYY-MM-DD HH:MM:SS[.ffffff]`, nulls as null). Distinct integers
beyond 2^53 remain distinct; equivalent decimal forms compare equal.
Duplicate object keys at any depth and a missing database expectation file are errors.
The `write_cycle` expectation uses tagged styled-column values for
`json_setting` and `serialize_data` in both its created and updated rows.

| file | role |
|---|---|
| `vectors.json` | vector names, canonical chains, MySQL expectations — **the only place a vector is declared** |
| `vectors.postgres.json`, `vectors.sqlite.json` | the same vectors' expectations on the other databases (`check … -driver postgres`); results equal MySQL's except where the dialect differs (`sql_dump` text, fulltext semantics, operators SQLite rejects) |
| `runner_go/main.go` | Go runner (generated models in `clients/go/model`) |
| `runner.php` | PHP runner (PDO) |
| `clients/rust/tests/src/conformance.rs` | Rust runner (models from `orm-build`, sqlx) |
| `runner_typescript.mjs` | TypeScript runner (native database drivers) |
| `check/main.go` | orchestrator + comparator |

## Run

```sh
make test-servers
make conformance-check
```
`make conformance-check` reads `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN` and
`BENCH_SQLITE_DSN` from the environment file of `make test-servers` and runs

```sh
go run ./tests/conformance/check run -driver mysql -dsn "$BENCH_MYSQL_DSN"
go run ./tests/conformance/check run -driver postgres -dsn "$BENCH_POSTGRES_DSN"
go run ./tests/conformance/check run -driver sqlite -dsn "$BENCH_SQLITE_DSN"
```
`check run` requires `-dsn` and passes the same DSN URI to all four runners;
each DSN selects the time zone `+00:00`. Each runner executes twice. The
checker requires identical JSON on both executions and an unchanged database
state after declared sequence cleanup. It reads every table row and observes
MySQL auto-increment values, PostgreSQL sequence values, and SQLite's
`sqlite_sequence` table when it exists. SQLite databases without an
`AUTOINCREMENT` table have no sequence counters; the checker still reads all
rows and reports any other query error. Only counters of the four tables that the write vectors
insert into may be restored. Each restoration is reported; a missing table,
unreadable sequence, undeclared counter change, cleanup failure, or remaining
state change fails. The bench database must have no external writer during the run.

`check compare` compares recorded files and does not establish that a runner
executed now. It requires exactly one output from each of the four clients.
`check run` removes earlier generated outputs when it starts and publishes its
four output files only after the repeated executions, state checks, and
expectation comparison pass. On failure it retains the current diagnostic files
under an `.run-*` directory without treating them as verified outputs.
`check record -driver <db> out/<db>/go.json` refreshes that database's
expectations after a deliberate change.

Every client plans its statements in its own process. `check run` holds the
directory lock `/tmp/orm-conformance.lock` while the runners use the bench
database; a second run fails instead of waiting.

## Adding a vector

1. Declare `{"name", "chain", "expect": null}` in `vectors.json`.
2. Implement the same chain in all four runners (keep the statement order).
3. `go run ./tests/conformance/check record -driver <db> tests/conformance/out/<db>/go.json` for each database (MySQL output is `out/go.json`),
   review the recorded SQL/binds/result, commit.

Write vectors remove their rows; the checker restores their declared sequence
counters and verifies the original state after every execution. Keys and update times in the output are masked
as `$SEQ` and `$TS`, and AES ciphertexts with random nonces as `$AES`; masking
does not exempt a database state change.

The PHP and TypeScript runners execute write vectors in transactions and return
unexpected vector errors to the checker. They reject invalid derived integers,
missing selected result fields, invalid query binds, and result values that
cannot be represented exactly. Ordered JSON numbers remain exact in the output.
The TypeScript result case checks the `CODEC_ENCODE` code when a styled value
contains an undefined member; diagnostic wording is not part of the contract.
`make conformance-result-check` runs their result cases. The Go runner applies
the same error, integer, bind, field, and transaction checks. `make
conformance-result-physical-check` runs Go, PHP, Rust, and TypeScript twice on each
database and checks identical output and unchanged rows and counters.

The Rust runner rejects malformed bind values and derived integers, compares
the aggregate average by its binary64 bits, and returns an unexpected vector
error as a process failure. Its write vectors use transactions so a failed
write does not leave rows. The state checker inspects rows and counters after
that failure on every database.

`make conformance-rust-group-check` runs the Rust runner twice on each database,
checks rows and counters before and after both runs, and compares the `aggregates`
vector with the recorded expectation. A selected boolean group column remains
a boolean in the result.
