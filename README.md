# orm — one grammar, three languages, one compiler

A schema-driven fluent query grammar for **Go, PHP and Rust** that compiles through a single Go engine
into database plans and executes on each language's native driver. Version 0.0.1.

```php
$battles = (new Battle)->bind($db)->serviceSeq(7)->isClose(false)
    ->and(fn(BattleWhere $w) => $w->isDisplay(true)->or()->isAllday(true))
    ->relationUser(new User)->orderBySeqDesc()->limit(0, 20)->gets();
```
```go
battles, err := gen.Battle().Bind(ctx, db).ServiceSeq(7).IsClose(false).
    And(func(w *gen.BattleWhere) { w.IsDisplay(true).Or().IsAllday(true) }).
    RelationUser(gen.User()).OrderBySeqDesc().Limit(0, 20).Gets()
```
```rust
let battles = Battle::new().bind(&db).service_seq(7).is_close(false)
    .and(|w| w.is_display(true).or().is_allday(true))
    .relation_user(User::new()).order_by_seq_desc().limit(0, 20).gets().await?;
```
The three chains produce the same SQL, the same binds and the same results — checked byte for byte by
`tests/conformance` (58 vectors) and `ormgen tokens`.

For a direct finder, the same `getsBy` token is generated in all three clients:

```php
$battles = (new Battle)->bind($db)->getsByServiceSeq(7);
```
```go
battles, err := gen.Battle().Bind(ctx, db).GetsByServiceSeq(7)
```
```rust
let battles = Battle::new().bind(&db).gets_by_service_seq(7).await?;
```
`getBy` is the one-row form for a primary or unique key; `getCountBy` is the scalar count form.
`getsBy<Field>` and `getCountBy<Field>` are root-table equality shortcuts; index declarations affect the database plan, not whether the shortcut exists. For multiple predicates, keep the same root query and chain the columns before `gets` or `getCount`.

`gen.Battle()` is Go's query factory and returns `*gen.BattleQuery`. PHP and Rust use `new Battle` and `Battle::new()` for the same query head. Creation, ownership and asynchronous execution follow each language; the query operations and semantics are shared. `get` returns one row, `gets` returns a collection. `one/all` remain compatibility aliases. Bind the executor to the root query before execution; terminals receive only values. The root binding runs every join and relation step, and loaded rows inherit it. A new `bind` selects another database or transaction without changing the query predicates. Go binds its context with the executor. Unbound queries and finished transactions return `CONFIG`.

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
[**Online documentation**](https://polyspec.github.io/orm/) — static guides, interface diagrams and implementation status, built from `docs/` and deployed through GitHub Pages.

[**공통 인터페이스**](docs/interfaces.md) · [구현 대조표](docs/interface-implementation.md) · [자동 검사](tests/interfaces/README.md) — 자료구조·수명·공개 API와 검증 상태.

[**docs/usage.md**](docs/usage.md) — start here: schema, generation, connecting, querying, writing, relations, the three databases, operations.

`examples/thin-slice` (same statement in three languages) · `examples/complex` (joins, groups, three relation levels, aggregates — identical JSON in three languages) · `docs/dsl.md` grammar · `docs/schema.md` Mermaid dialect, import, validate · `docs/protocol.md` IR/Plan ·
`docs/codec.md` column styles · `docs/dialects.md` MySQL/PostgreSQL/SQLite · `docs/config.md` orm.toml ·
`docs/errors.yaml` codes · `docs/perf.md` measurements and gates · `docs/checklist.md` work plan · `docs/lanes/` parallel lane specs.

## Tooling
`ormgen build | gen | import --dsn | validate --dsn | ddl --dialect | errors --lang | tokens | check --lang php`,
`tests/conformance/check run|compare|record`, `scripts/build-artifacts.sh`, `deploy/` service units.

## License
MIT — see [LICENSE](LICENSE).
