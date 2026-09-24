# Conformance vectors

One document, four runners. Every vector is the same chain written in Go,
PHP, Rust, and TypeScript; each runner executes it against the seeded bench database
`orm_bench` and prints

```json
{"<vector>": {"statements": [{"sql": "...", "binds": [...]}], "result": ...}}
```

`check` canonicalizes the JSON (sorted keys, shortest numbers) and compares
every language against `vectors.json`, byte for byte: same SQL, same binds in
the same order, same typed results (ints as numbers, bools as booleans,
datetimes as `YYYY-MM-DD HH:MM:SS[.ffffff]`, nulls as null).

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
`check run` requires `-dsn` and passes the same DSN URI to every runner; each
DSN selects the time zone `+00:00`. `-langs go,php` limits which runners
execute. `check record -driver <db> out/<db>/go.json` refreshes that database's
expectations after a deliberate change.

Every client plans its statements in its own process. `check run` holds the
directory lock `/tmp/orm-conformance.lock` while the runners use the bench
database; a second run fails instead of waiting.

## Adding a vector

1. Declare `{"name", "chain", "expect": null}` in `vectors.json`.
2. Implement the same chain in all four runners (keep the statement order).
3. `go run ./tests/conformance/check record -driver <db> tests/conformance/out/<db>/go.json` for each database (MySQL output is `out/go.json`),
   review the recorded SQL/binds/result, commit.

Write vectors leave the database as they found it. The keys and update times of
the rows they create are masked as `$SEQ` and `$TS`, and AES ciphertexts, which
carry a random nonce, as `$AES`, so the recording stays deterministic.
