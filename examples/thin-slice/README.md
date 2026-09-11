# Thin-slice demo (S1)

The same statement in three files; the same JSON on stdout.

```
go run ./examples/thin-slice/go schema/schema.json
php examples/thin-slice/php/main.php /abs/ormd.sock /abs/schema.json     # ormd must be listening
clients/rust/target/release/demo bin/ormengine.wasm schema/schema.json
```

Each prints one timing line on stderr: p50 of the generated client vs the
plan's SQL re-run through the native driver (`database/sql` / PDO / sqlx) in the
same process — the client's fixed per-statement cost on a 3-row query.

`ormgen tokens --schema schema/schema.json examples/thin-slice/go/main.go examples/thin-slice/php/main.php examples/thin-slice/rust/main.rs`
confirms the three files carry the same 13 statement tokens.
