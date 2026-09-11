# orm — one grammar, three languages, one compiler

A compatibility-style fluent query grammar for **Go, PHP and Rust** that compiles through a single Go engine
into database plans and executes on each language's native driver. Version 0.0.1.

```php
$battles = (new Battle)->serviceSeqEq(7)->isCloseEq(false)
    ->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->isAlldayEq(true))
    ->relationUser(new User)->orderBySeqDesc()->limit(0, 20)->all($db);
```
```go
battles, err := gen.NewBattle().ServiceSeqEq(7).IsCloseEq(false).
    And(func(w *gen.BattleWhere) { w.IsDisplayEq(true).Or().IsAlldayEq(true) }).
    RelationUser(gen.NewUser()).OrderBySeqDesc().Limit(0, 20).All(ctx, db)
```
```rust
let battles = Battle::new().service_seq_eq(7).is_close_eq(false)
    .and(|w| w.is_display_eq(true).or().is_allday_eq(true))
    .relation_user(User::new()).order_by_seq_desc().limit(0, 20).all(&db).await?;
```
The three chains produce the same SQL, the same binds and the same results — checked byte for byte by
`tests/conformance` (40 vectors) and `ormgen tokens`.

## How it works
- **Schema**: one hand-written Mermaid `erDiagram` (`schema/*.mmd`) → `ormgen build` → `schema.json` (manifest with `schema_hash`).
- **Engine** (`engine/`, Go, compiler only): JSON IR → Plan (SQL text + bind slots + positional assembly). Never executes. Plans are value-free and cached per statement shape in every client.
- **Executors**: Go `database/sql` in-process; PHP `PDO` + `ormd` (compile daemon over a unix socket, plans cached in APCu); Rust `sqlx` + the engine as wasm (wasmtime on a dedicated thread). Row data never crosses a language boundary.
- **Databases**: MySQL 8 / MariaDB first; PostgreSQL 12+ and SQLite 3.35+ through the same plans (`docs/dialects.md`) — the conformance vectors produce identical results on all three.
- **Generated code**: `ormgen gen --lang go|php|rust` emits typed builders, rows and relation accessors per entity.

## Quick start (MySQL 8.x, local socket)
```sh
mysql -uroot orm_bench < bench/sql/battle.sql                       # bench schema + 100k rows
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
for l in go php rust; do go run ./cmd/ormgen gen --schema schema/schema.json --lang $l --out clients/$l/gen; done
go build -o bin/ormd ./cmd/ormd
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o bin/ormengine.wasm ./engine/wasm
go test ./...                                                       # engine + Go client
bin/ormd -socket /abs/ormd.sock -schema schema/schema.json &        # PHP compile daemon
php clients/php/tests/integration.php /abs/ormd.sock /abs/schema/schema.json
(cd clients/rust && cargo build --release) && clients/rust/target/release/integration bin/ormengine.wasm schema/schema.json
go run ./tests/conformance/check run                                # 3 languages, identical output
```

## Documents
[**docs/usage.md**](docs/usage.md) — start here: schema, generation, connecting, querying, writing, relations, the three databases, operations.

`examples/thin-slice` (same statement in three languages) · `examples/complex` (joins, groups, three relation levels, aggregates — identical JSON in three languages) · `docs/dsl.md` grammar · `docs/schema.md` Mermaid dialect, import, validate · `docs/protocol.md` IR/Plan ·
`docs/codec.md` column styles · `docs/dialects.md` MySQL/PostgreSQL/SQLite · `docs/config.md` orm.toml ·
`docs/errors.yaml` codes · `docs/perf.md` measurements and gates · `docs/checklist.md` work plan · `docs/lanes/` parallel lane specs.

## Tooling
`ormgen build | gen | import --dsn | validate --dsn | ddl --dialect | errors --lang | tokens | check --lang php`,
`tests/conformance/check run|compare|record`, `scripts/build-artifacts.sh`, `deploy/` service units.
