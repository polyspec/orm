# orm 0.0.1

A schema-driven fluent query grammar for **Go, PHP, Rust, and TypeScript** that compiles through a single Go engine
into database plans and executes on each language's native driver. Version 0.0.1.

```php
$battles = Battle::query()->using($db)->serviceSeq(7)->isClose(false)
    ->and(fn(BattleWhere $w) => $w->isDisplay(true)->or()->isAllday(true))
    ->relation(User::query())->orderBySeqDesc()->limit(0, 20)->gets();
```
```go
battles, err := gen.Battle().Using(ctx, db).ServiceSeq(7).IsClose(false).
    And(func(w *gen.BattleWhere) { w.IsDisplay(true).Or().IsAllday(true) }).
    Relation(gen.User()).OrderBySeqDesc().Limit(0, 20).Gets()
```
```rust
let battles = battle::query().using(&db).service_seq(7).is_close(false)
    .and(|w| w.is_display(true).or().is_allday(true))
    .relation(user::query()).order_by_seq_desc().limit(0, 20).gets().await?;
```
```typescript
const battles = await Battle().using(db).serviceSeq(7).isClose(false)
    .and(w => w.isDisplay(true).or().isAllday(true))
    .relation(User()).orderBySeqDesc().limit(0, 20).gets();
```
The four chains produce the same SQL, binds, and results. `tests/conformance` checks 58 vectors on MySQL, PostgreSQL, and SQLite.

For a direct finder, the same `getsBy` token is generated in all four clients:

```php
$battles = Battle::query()->using($db)->getsByServiceSeq(7);
```
```go
battles, err := gen.Battle().Using(ctx, db).GetsByServiceSeq(7)
```
```rust
let battles = battle::query().using(&db).gets_by_service_seq(7).await?;
```
```typescript
const battles = await Battle().using(db).getsByServiceSeq(7);
```
`getBy` is the one-row form for a primary or unique key; `getCountBy` is the scalar count form.
`getsBy<Field>` and `getCountBy<Field>` are root-table equality shortcuts; index declarations affect the database plan, not whether the shortcut exists. For multiple predicates, keep the same root query and chain the columns before `gets` or `getCount`.

`gen.Battle()` is Go's query factory and returns `*gen.BattleQuery`. PHP and Rust use `Battle::query()` and `battle::query()` for the same query head. Creation, ownership and asynchronous execution follow each language; the query operations and semantics are shared. `get` returns one row, `gets` returns a collection. `one/all` remain compatibility aliases. Select the executor with `using` before execution; terminals receive only values. The selected executor runs every join and relation step, and loaded rows inherit it. Calling `using` again selects another database or transaction without changing the query predicates. Go passes its context with the executor. Unbound queries and finished transactions return `CONFIG`.

## How it works
- **Schema**: one hand-written Mermaid `erDiagram` (`schema/*.mmd`) → `ormgen build` → `schema.json` (manifest with `schema_hash`).
- **Engine** (`engine/`, Go, compiler only): JSON IR → Plan (SQL text + bind slots + positional assembly). Never executes. Plans are value-free and cached per statement shape in every client.
- **Executors**: Go `database/sql`, PHP `PDO`, Rust `sqlx`, and TypeScript native drivers execute database plans. All clients use Connect and Protobuf to compile plans. Row data remains in the client process.
- **Databases**: MySQL 8, PostgreSQL 12+, and SQLite 3.35+ use the same request and result rules (`docs/dialects.md`).
- **Generated code**: `ormgen gen --lang go|php|rust|typescript` emits typed builders, rows, and relation accessors per entity.

## Quick start (MySQL 8.x, local socket)
```sh
mysql -uroot orm_bench < bench/sql/battle.sql                       # bench schema + 100k rows
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
for l in go php rust; do go run ./cmd/ormgen gen --schema schema/schema.json --lang $l --out clients/$l/gen; done
go run ./cmd/ormgen gen --schema schema/schema.json --lang typescript --out clients/typescript/src/gen
go build -o bin/ormd ./cmd/ormd
go test ./...
npm run typescript:check && npm run typescript:build
(cd clients/rust && cargo test --release -p orm)
go run ./tests/conformance/check run                                # starts Connect compiler and checks 4 clients
```

## Documents
[**Online documentation**](https://polyspec.github.io/orm/) — static guides, interface diagrams and implementation status, built from `docs/` and deployed through GitHub Pages.

[**공통 인터페이스**](docs/interfaces.md) · [구현 대조표](docs/interface-implementation.md) · [자동 검사](tests/interfaces/README.md) — 자료구조·수명·공개 API와 검증 상태.

[**docs/usage.md**](docs/usage.md) — start here: schema, generation, connecting, querying, writing, relations, the three databases, operations.

`examples/thin-slice` · `examples/complex` · `docs/dsl.md` grammar · `docs/schema.md` Mermaid dialect, import, validate · `docs/protocol.md` IR/Plan ·
`docs/codec.md` column styles · `docs/dialects.md` MySQL/PostgreSQL/SQLite · `docs/config.md` orm.toml ·
`docs/errors.yaml` codes · `docs/perf.md` measurements and gates · `docs/checklist.md` work plan · `docs/lanes/` parallel lane specs.

## Tooling
`ormgen build | gen | import --dsn | validate --dsn | ddl --dialect | errors --lang | tokens | check --lang php`,
`tests/conformance/check run|compare|record`, `scripts/build-artifacts.sh`, `deploy/` service units.

## License
MIT — see [LICENSE](LICENSE).
