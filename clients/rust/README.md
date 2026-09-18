# orm — Rust client

| Crate | Contents |
|---|---|
| `orm` (`clients/rust/orm`) | the runtime: model builder, request validation, SQL planner for MySQL, PostgreSQL, and SQLite, plan cache, sqlx executor, codecs, DSN parser, transactions, utilities, error codes |
| `orm-schema` (`clients/rust/orm-schema`) | schema definitions: Mermaid → `schema.json`, the DDL and migration renderer, and SQL statement splitting; the runtime installs schemas with it, and `orm-build` re-exports it as `orm_build::schema` and `orm_build::ddl` |
| `orm-build` (`clients/rust/orm-build`) | the build-time generator: reads `schema.json`, scans the crate's source, and writes the models it calls into `OUT_DIR`; with the `cli` feature, the `orm-gen` schema tool |
| `orm-tests` (`clients/rust/tests`) | `integration`, `conformance`, `client_bench`, `complex`, and `demo` |

Adopting the client needs only these crates. Statements are planned in the process; there is no service to run.

## Models

`build.rs` generates the models; `orm::models!()` includes them as the module `model`.

```toml
[dependencies]
orm = { path = "…/clients/rust/orm" }

[build-dependencies]
orm-build = { path = "…/clients/rust/orm-build" }
```

```rust
// build.rs
fn main() {
    orm_build::Builder::new("schema/schema.json").scan("src").generate();
}
```

```rust
// src/main.rs
orm::models!();

use model::Battle;

let db = orm::Db::connect(&dsn, 8, orm::Config::default()).await?;
let rows = Battle::new().connect(&db).service_seq(7).and_is_close(false).order_by_seq_desc().gets().await?;
```

Every model has its fixed methods (`connect`, `get`, `gets`, `set_<col>`, `order_by_<col>_asc`, …). The chain, join, relation, column, and getter methods of the [DSL](../../docs/dsl.md) are generated for the calls the scanned source makes. An unknown column, operator, or argument count on a model the source names stops the build with the file position. The generated module embeds its schema, so one connection serves models of any schema.

## Connection

`Db::connect(dsn, pool_size, config)` takes a DSN URI; the scheme selects `mysql`, `postgres`, or `sqlite`, and the `timezone` parameter sets the connection time zone. Credentials and AES keys come from the environment or a secret manager.

`db.utils().schema().install(schema_json)` creates the tables and indexes of a manifest in one transaction and keeps existing ones.

## Errors

`orm::codes` is generated from `docs/errors.yaml` (`ormgen errors --lang rust --out clients/rust/orm/src/codes.rs`). Request errors are `Error::Engine { code, msg }`; the executor raises `Error::Config` (`CONFIG`) and `Error::OptimisticLock`. Driver errors stay `Error::Sqlx` except deadlocks, duplicate keys, and foreign keys, which become `Error::Engine` with the shared code and the driver's message. `Db::transaction` runs the callback again on `DEADLOCK` (three retries by default).

## The statement hook

`Config.on_query` receives `(sql, binds, duration, plan_id, err)` for each model statement. Secret binds are shown as `$SECRET` and executor clock binds as `$NOW`. `plan_id` is the plan-cache key, FNV-1a 64 of the request shape.

## Build and test

```sh
cd clients/rust
cargo clippy --workspace --all-targets -- -D warnings
ORM_TEST_MYSQL_DSN=… ORM_TEST_POSTGRES_DSN=… cargo test --workspace
cargo build --release -p orm-tests
ORM_TEST_MYSQL_DSN=… ORM_TEST_POSTGRES_DSN=… ./target/release/integration ../../schema/schema.json
./target/release/conformance --driver mysql --dsn "mysql://…" ../../schema/schema.json
```

`integration` and the `zone` test always run on SQLite, and on MySQL and PostgreSQL when `ORM_TEST_MYSQL_DSN` and `ORM_TEST_POSTGRES_DSN` name test databases; they drop and install their tables there. `conformance`, `complex`, and `demo` read the seeded bench database.
