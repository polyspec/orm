# orm 0.0.1

A schema-driven model query grammar for **Go, PHP, Rust, and TypeScript**. Version 0.0.1. The target syntax is specified in [docs/dsl.md](docs/dsl.md) and the work order in [docs/plan.md](docs/plan.md).

```php
$battles = (new Battle)->connect($slave1)->serviceSeq(7)->andIsClose(false)
    ->and(fn (Battle $q) => $q->isDisplay(true)->or()->isAllday(true))
    ->relation((new User)->matchUserSeqWithSeq())->orderBySeqDesc()->limit(0, 20)->gets();
```
```go
battles, err := model.Battle().Connect(slave1).ServiceSeq(7).AndIsClose(false).
    And(func(q *model.BattleModel) { q.IsDisplay(true).Or().IsAllday(true) }).
    Relation(model.User().MatchUserSeqWithSeq()).OrderBySeqDesc().Limit(0, 20).Gets()
```
```rust
let battles = Battle::new().connect(&slave1).service_seq(7).and_is_close(false)
    .and(|q| q.is_display(true).or().is_allday(true))
    .relation(User::new().match_user_seq_with_seq()).order_by_seq_desc().limit(0, 20).gets().await?;
```
```typescript
const battles = await new Battle().connect(slave1).serviceSeq(7).andIsClose(false)
    .and(q => q.isDisplay(true).or().isAllday(true))
    .relation(new User().matchUserSeqWithSeq()).orderBySeqDesc().limit(0, 20).gets();
```
The four chains produce the same SQL, binds, and results. `tests/conformance` checks the common vectors on MySQL, PostgreSQL, and SQLite.

Finders accept any column chain after `By`:

```php
$battles = (new Battle)->connect($slave1)->getsByServiceSeqAndIsClose(7, false);
```
```go
battles, err := model.Battle().Connect(slave1).GetsByServiceSeqAndIsClose(7, false)
```
```rust
let battles = Battle::new().connect(&slave1).gets_by_service_seq_and_is_close(7, false).await?;
```
```typescript
const battles = await new Battle().connect(slave1).getsByServiceSeqAndIsClose(7, false);
```
`get` returns one row and returns `NO_ROWS` when no row matches, `gets` returns a collection, and `getCount` returns a count. A model receives its database connection through `connect`; inside `connection.transaction(fn)`, a model without `connect` uses the active transaction. Relation children use the parent connection unless they call `connect`. A model without a connection outside a transaction returns `CONFIG`.

## How it works
- **Schema**: one hand-written Mermaid `erDiagram` (`schema/*.mmd`) → `ormgen build` → `schema.json` (manifest with `schema_hash`).
- **Models**: each language generates its models with its own build tool: `go generate` (Go), `vendor/bin/orm-gen` (PHP), the `orm-gen` npm bin in `npm run build` (TypeScript), and the `orm-build` crate in `build.rs` (Rust).
- **Runtime**: the client library validates each statement shape against `schema.json`, assembles the SQL in the application process, caches the plan, and executes it through the language-native driver. No service, daemon, or extension runs beside the application.
- **Databases**: MySQL 8, PostgreSQL 12+, and SQLite 3.46+ use the same request and result rules (`docs/dialects.md`).
- **Equality**: `tests/conformance` runs the same vectors in the four clients and compares the SQL, binds, and results.

## Quick start (MySQL 8.x, local socket)
```sh
mysql -uroot orm_bench < bench/sql/battle.sql
mysql -uroot orm_bench < bench/sql/seed.mysql.sql                  # schema + 100k rows
go run ./bench/seedaes -driver mysql -dsn 'root@unix(/tmp/mysql.sock)/orm_bench'
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
(cd clients/go/model && go generate)                                # Go models
php clients/php/bin/orm-gen gen --schema schema/schema.json --out clients/php/gen --namespace 'App\Orm'
(cd clients/typescript && npm run build)                            # TypeScript models and library
(cd clients/rust && cargo build --release)                          # build.rs generates the Rust models
go test ./...
npm run typescript:test
(cd clients/rust && cargo test --workspace)
go run ./tests/conformance/check run -driver mysql                  # compares the four clients
```

## Documents
[**Online documentation**](https://polyspec.github.io/orm/) — static guides, interface diagrams and implementation status, built from `docs/` and deployed through GitHub Pages.

[**한국어 README**](README.ko.md)

[**공통 인터페이스**](docs/interfaces.md) · [구현 대조표](docs/interface-implementation.md) · [자동 검사](tests/interfaces/README.md) — 자료구조·수명·공개 API와 검증 상태.

[**docs/usage.md**](docs/usage.md) — start here: schema, generation, connecting, querying, writing, relations, the three databases, operations.

[**Security**](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md)

`examples/thin-slice` · `examples/complex` · `docs/dsl.md` grammar · `docs/schema.md` Mermaid dialect, import, validate · `docs/protocol.md` IR/Plan ·
`docs/codec.md` column styles · `docs/dialects.md` MySQL/PostgreSQL/SQLite ·
`docs/errors.yaml` codes · `docs/perf.md` measurements and gates · `docs/checklist.md` work plan.

## Tooling
`ormgen build | gen --lang go | import --dsn | validate --dsn | ddl --dialect | diff | errors --lang`,
`vendor/bin/orm-gen gen | build | import | validate | ddl | diff | migrate` (PHP), `orm-gen` (TypeScript), `orm-build` (Rust),
`tests/conformance/check run|compare|record`.

## License
MIT — see [LICENSE](LICENSE).
