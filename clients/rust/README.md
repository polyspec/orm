[Korean](README.ko.md)

# orm — Rust client

| Crate | Contents |
|---|---|
| `orm` (`clients/rust/orm`) | the runtime: model builder, request validation, SQL planner for MySQL, PostgreSQL, and SQLite, plan cache, sqlx executor, codecs, DSN parser, transactions, utilities, error codes |
| `orm-schema` (`clients/rust/orm-schema`) | schema definitions: the dbspec parser, emitter, manifest, renderer, plans, Mermaid export and import, and runtime model, which the runtime and `orm-build` share, and SQL statement splitting |
| `orm-build` (`clients/rust/orm-build`) | the build-time generator: reads a dbspec document set, scans the crate's source, and writes the models it calls and the manifest text into `OUT_DIR`; with the `live-db` feature, the catalog and tool database connections |
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
    orm_build::Builder::new(["schema/example.dbs"]).scan("src").generate();
}
```

```rust
// src/main.rs
orm::models!();

use model::Author;

let db = model::connect(&dsn, 8, orm::Config::default()).await?;
let rows = Author::new().connect(&db).service_seq(7).and_is_close(false).order_by_seq_desc().gets().await?;
```

Every model has its fixed methods (`connect`, `get`, `gets`, `set_<col>`, `order_by_<col>_asc`, …). The chain, join, relation, column, and getter methods of the [DSL](../../docs/dsl.md) are generated for the calls the scanned source makes. An unknown column, operator, or argument count on a model the source names stops the build with the file position. The generated module embeds the manifest text of its document set and its `manifestHash` (`model::SCHEMA`, `model::MANIFEST_HASH`) and its connect helper `model::connect`, which opens a connection with `Db::connect_schema` and registers the set on it. A connection plans only the sets registered on it ([protocol](../../docs/protocol.md)).

## Connection

`model::connect(dsn, pool_size, config)` and `Db::connect(dsn, pool_size, config)` take a DSN URI; `Db::connect` opens a connection without any registered set. the scheme selects `mysql`, `postgres`, or `sqlite`, and the `timezone` parameter sets the connection time zone. Supply credentials in the DSN and AES keys in `Config`. MySQL connections that use `caching_sha2_password` require TLS; set `ssl-mode=verify_ca` and `ssl-ca` in the DSN. The client does not enable RSA authentication over an unencrypted connection.

`db.utils().schema().install(&model::SCHEMA)` renders the document set for the connection's database, applies the statements and registers the set on the connection; a manifest text that does not hash to its `manifestHash` returns `CONFIG`. It creates nothing when every table of the set exists and returns `CONFIG` when only some exist.
`db.utils().schema().add_columns(&model::SCHEMA).await` adds the missing columns of the existing tables of the set that are null or have a default with the plan steps of the dialect (`orm_schema::dbspec::add_column_steps`), which also replace the audit triggers of each changed table, and returns them as `table.column`; every other difference returns `SCHEMA_DIFFERS` before any statement (docs/schema.md, "Adding columns"). MySQL and SQLite add them outside a transaction.

## Required calls

| Operation | Rust API |
|---|---|
| Validate a generated manifest hash | `Schema::manifest()` builds the runtime model from the embedded manifest text and checks its `manifestHash`; `Manifest::load(text, hash)` does the same for another manifest text |
| Select an engine and expose models | `model::connect` selects the dialect from the DSN and registers the set of the generated models on the connection; a request of a set that is not registered on its connection returns `SCHEMA_HASH_MISMATCH` |
| Install schema objects | `db.utils().schema().install(&model::SCHEMA)` |
| Add the missing columns of existing tables | `db.utils().schema().add_columns(&model::SCHEMA)` |
| Run with isolation or read-only access | `db.transaction(callback).isolation(Isolation::…).read_only().await` |
| Run a callback with a `Send` future | `db.transaction_send(callback).await` |
| Preserve a one-time callback's own error | `db.transaction_once(callback).await`; returns `TransactionOnceError::Callback(error)` after rollback |
| Bound a transaction callback | `db.transaction(callback).timeout_ms(milliseconds).await` |
| Set a deadlock retry count, including zero | `db.transaction(callback).retry(count).await` |
| Cancel a statement or transaction callback | Drop its future; `timeout_ms` cancels the callback on expiry and awaits rollback |
| Encrypt model columns | Declare the `aes` codec stage and the `aes_version` setting in the schema, and pass `Config::aes_key` or `Config::aes_keys` with `Config::aes_version` |

For Rust connections, `aes_version` must be positive. Every declared key version must be positive
and have a nonempty key. If `aes_keys` is present, it must contain the current version; an
`aes_key` supplied alongside it must equal that version's key. `Db::connect` returns `CONFIG`
before opening a connection for invalid key configuration. A connection without AES columns may
leave both key fields empty.
| Record audited writes | Declare the `audit` setting in the schema and name the operation of the unit of work with `db.transaction(callback).operation(id).await` ([usage](../../docs/usage.md#rust)) |

`timeout_ms(0)` disables the callback deadline. A positive deadline covers callback execution,
including statements it starts. Expiry returns `CANCELED` only after rollback succeeds; if
rollback fails, the returned error reports both the timeout and rollback failure. Commit runs
after a successful callback and is not subject to this deadline. Each transaction retains its
own connection; a later transaction can use the connection after a cancelled statement.

Nested `transaction_send` calls borrow the erased callback directly when using
a savepoint, without requiring a reference to its Box allocation. Owner tests
must preserve Send futures and nested commit/rollback on all three databases.
`make rust-send-savepoint-check` runs the owning lint and behavior checks using
the declared test environment, never a user's database. The shared Make test
environment exports ORM_SEND_SQLITE_DSN from SEND_SQLITE_DSN; direct Cargo
invocations must explicitly provide this URI alongside the MySQL/PostgreSQL
test DSNs. Fixtures are connection-local temporary tables, removed on close.

`transaction_once` accepts a callback that may run only once and does not retry it. A nested call
uses a savepoint. Database setup and commit failures return `TransactionOnceError::Orm`; a failed
callback returns its original error after rollback. If rollback also fails, the error contains
both the callback and rollback failures. This call has no callback deadline option.

## Row values

Generated model fields are private. A `get_<column>` call returns `Result` and reports
`COLUMN_UNSELECTED` when its column was neither selected nor assigned; a missing value cannot
appear as SQL NULL or a default. Explicit projection changes the SQL selection and row output.
`gets_count` returns `GroupRows` with selected grouping values and a checked `row_count`, so a
group result does not contain partially populated model fields.
`GroupRow::value(name)` returns `Result<&Val>` and reports `COLUMN_UNSELECTED` for a name that
was not selected. A selected SQL NULL remains `Val::Null`.

Generated setters for columns with an `ordered_json`, `serialize`, `yaml`, `gz`, or `base64` codec stage take
`StyledValue<T>` and return `Result<Self>`. `StyledValue::SqlNull` writes SQL NULL;
`StyledValue::Value(v)` stores the encoded value, including a JSON or other encoded null.
A non-null column rejects `SqlNull` with `CODEC_ENCODE` at the setter. Getters return
`Result<StyledValue<T>>` and report `COLUMN_UNSELECTED` before a column is read or
assigned. Row arrays and model JSON use `{"kind":"sql-null"}` or
`{"kind":"value","value":...}` for each styled column. Invalid stored text
returns `CODEC_DECODE` with the entity and column name.

`Val` numeric, boolean, date, time, text, byte and JSON conversions return `Result`.
An incompatible kind, invalid text, integer overflow, non-finite float, invalid UTF-8 or
precision-losing decimal conversion returns `CODEC_DECODE`. A non-finite float also fails JSON
output. Generated model `assign` returns `Result<bool>`: `Ok(false)` means the column name is
unknown, while an invalid value is an error. Unsigned values beyond `i64` fail on read and
`Param::try_from(u64)` fails with `CODEC_ENCODE` on write. SQL NULL remains distinct from empty
text or bytes. Database decimal values remain exact text until a caller requests a checked
numeric conversion.

`get_sum` and `get_avg` return approximate `f64` scalars. They convert a numeric database
aggregate to the nearest finite binary64 value, using ties-to-even at an equal distance.
Invalid numeric text, SQL NULL, NaN, infinity and values above the finite binary64 range
return `CODEC_DECODE`. This aggregate conversion does not change the exactness requirement
of `Val::as_f64` for ordinary values.

## Errors

`orm::codes` is generated from `docs/errors.yaml` (`orm-gen errors --lang rust --out clients/rust/orm/src/codes.rs`). Request errors are `Error::Engine { code, msg }`; the executor raises `Error::Config` (`CONFIG`) and `Error::OptimisticLock`. Every driver error becomes `Error::Driver { code, msg, source }`: a condition that `docs/errors.yaml` lists, such as a deadlock, a duplicate key, a foreign key, or a CHECK violation, has its shared code, every other driver error, such as a write that a trigger refuses, has `DRIVER`, and `source` is the driver error. A SQLite lock that another connection still holds when `busy_timeout` ends becomes `CANCELED`. `Db::transaction` runs the callback again on `DEADLOCK` (three retries by default). A callback that failed and whose transaction or savepoint rollback failed too returns `Error::Rollback { callback, rollback }` (`ROLLBACK`) with the message `transaction failed (<callback error>) and rollback failed (<rollback error>)`; it keeps both errors and is never retried.

## The statement hook

`Config.on_query` receives `(sql, binds, duration, plan_id, err)` for each model statement. Secret binds are shown as `$SECRET` and executor clock binds as `$NOW`. `plan_id` is the plan-cache key, FNV-1a 64 of the request shape.

## Build and test

`CatalogConnection::read_only_query` accepts one dialect-parsed query, not
mutation/transaction statements, write CTEs, SELECT INTO, locking queries or
executable comments. It executes original SQL in a DB-enforced read-only scope
using a dedicated discard-on-drop pooled connection and rolls back afterward.
SQL is limited to 256 KiB and parser recursion to 64. Unsupported grammar fails
explicitly. This protects database writes, not arbitrary external effects of
privileged database functions; use a least-privilege database role.

Rust tool/catalog queries accumulate streamed rows with validated budgets:
100,000 rows and 64 MiB of JSON-encoded values by default. Each query accepts
one statement; multiple result sets are not silently merged. Explicit
`QueryLimits` may lower these limits. Exceeding either budget rejects the result
without returning a truncated success or including values in the budget error.
This bounds accumulated output, not database execution or driver packet memory.
`query_result_bounded` also returns ordered column names and native type names
from prepared metadata, even when no rows are returned. Duplicate names stay
distinct by their array position. Metadata is limited to 2,048 columns and
64 KiB of name/type UTF-8 bytes. Catalog connections expose the same operation
through `query`; callers must separately enforce their execution policy.
Supported tool cells remain NULL, signed integers, text and booleans; unsupported
types fail rather than being converted. This is not a read-only SQL sandbox.

```sh
cd clients/rust
cargo clippy --workspace --all-targets -- -D warnings
ORM_TEST_MYSQL_DSN=… ORM_TEST_POSTGRES_DSN=… ORM_TEST_MYSQL_SERVER_DSN=… ORM_TEST_POSTGRES_SERVER_DSN=… cargo test --workspace
cargo build -p orm-tests
ORM_TEST_MYSQL_DSN=… ORM_TEST_POSTGRES_DSN=… ./target/debug/integration ../../schema/bench.dbs
./target/debug/conformance --dsn "mysql://…" ../../schema/bench.dbs
```

`integration` and the `zone` test run on SQLite, MySQL and PostgreSQL; `ORM_TEST_MYSQL_DSN` and `ORM_TEST_POSTGRES_DSN` must name test databases, and a test fails when either is unset. A case that installs a schema or checks an empty database creates a database of its own through them and drops it when it ends. The rollback tests end the server session of a transaction through `ORM_TEST_MYSQL_SERVER_DSN` and `ORM_TEST_POSTGRES_SERVER_DSN`, which name the servers without a pooler, and the dbspec tests (`dbspec_*`) create and change their databases through them; `dbspec_apply` also requires `ORM_TEST_PGBOUNCER_DSN` for its transaction pooler case; the make targets set both from `.runtime/servers/env`. `conformance`, `complex`, and `demo` read the seeded bench database.
The Rust conformance output fails when a bind cannot be represented without loss, a requested
selected field or relation is absent, or a derived integer is invalid or out of range. It never
substitutes null, zero, or replacement text for those errors.

The Rust source scanner recognizes `expect` and `unwrap` immediately after a styled setter
as Result handling. It retains the model for following calls and rejects unknown model methods.
