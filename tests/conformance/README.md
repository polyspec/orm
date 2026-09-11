# Conformance vectors

One document, three runners. Every vector is the same chain written in Go,
PHP and Rust; each runner executes it against the local MySQL (`orm_bench`,
`/tmp/mysql.sock`) and prints

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
| `runner_go/main.go` | Go runner (in-process engine) |
| `runner.php` | PHP runner (ormd compile, PDO execute) |
| `clients/rust/tests/src/conformance.rs` | Rust runner (wasmtime engine, sqlx) |
| `check/main.go` | orchestrator + comparator |

## Run

```sh
go build -o bin/ormd ./cmd/ormd                       # once
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o bin/ormengine.wasm ./engine/wasm
(cd clients/rust && cargo build --release)            # once
go run ./tests/conformance/check run                  # MySQL: runs all three, compares
go run ./tests/conformance/check run -driver postgres -dsn 'postgres://…'   # same on PostgreSQL
go run ./tests/conformance/check run -driver sqlite  -dsn 'file:/abs.sqlite' # and SQLite
```
`-langs go,php` limits which runners execute; `check record -driver <db> out/<db>/go.json` refreshes
that database's expectations after a deliberate change.

`check run` starts `ormd` on `tests/conformance/out/ormd.sock` for the PHP
runner and blocks on its "listening" line before proceeding — no polling.

## Adding a vector

1. Declare `{"name", "chain", "expect": null}` in `vectors.json`.
2. Implement the same chain in all three runners (keep the statement order).
3. `go run ./tests/conformance/check record tests/conformance/out/go.json`,
   review the recorded SQL/binds/result, commit.

Write vectors leave the database as they found it. Their row identity is
masked in binds (`$SEQ` for the inserted PK, `$TS` for the `updated_ts` read
with it) so the recording stays deterministic.
