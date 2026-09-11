# Complex statement demo

One statement with everything the grammar has to offer, in three languages, printing the **same JSON**:

- a join carrying its own `on()` and `where()`,
- a root group mixing a predicate with `or()` and navigation into the joined entity,
- three levels of relations with options (`limitPerParent`, `dropChildKey`, `keyBy<Col>`),
- a projection (`selectNone()` + `select<Col>()`) and the row's array form,
- aggregates on the same data: a grouped count with `having`, `min`/`max`, `countDistinct`.

```sh
go run ./examples/complex/go schema/schema.json > go.json
bin/ormd -socket /tmp/ormd.sock -schema schema/schema.json &         # PHP needs the compile daemon
php examples/complex/php/main.php /tmp/ormd.sock "$PWD/schema/schema.json" > php.json
clients/rust/target/release/complex bin/ormengine.wasm schema/schema.json > rust.json
diff go.json php.json && diff go.json rust.json                      # identical
go run ./cmd/ormgen tokens --schema schema/schema.json \
  examples/complex/go/main.go examples/complex/php/main.php examples/complex/rust/main.rs   # 49 tokens, identical
```

`docs/examples/complex-query.md` show the same shapes
against the example schema; they stay illustrative until that schema is imported
(`ormgen import --dsn …`), because the tables are not in this repository.
