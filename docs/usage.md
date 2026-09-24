# Usage

Generate Go, PHP, Rust, and TypeScript clients from one Mermaid schema and execute the same statement as the same SQL in each client.
Supported databases are MySQL 8 by default, PostgreSQL 12+, and SQLite 3.46+.

A query starts with a generated model and receives an opened database connection through `connect`. Inside a transaction callback, a model without `connect` uses the active transaction.

The complete syntax is in [dsl.md](dsl.md), diagram syntax is in [schema.md](schema.md), and the IR/Plan format is in [protocol.md](protocol.md).
Dialect differences are in [dialects.md](dialects.md), configuration is in [config.md](config.md), and error codes are in [errors.yaml](errors.yaml).

---

## 1. Requirements

| Requirement | Notes |
|---|---|
| Go 1.27+ | Engine, generator, and Go client |
| MySQL 8.0.2+ / MariaDB 10.2+ | Primary target; PostgreSQL 12+ and SQLite 3.46+ use the same plan |
| PHP 8.4+ (`pdo_mysql`) | Required for PHP; add `pdo_pgsql`/`pdo_sqlite` for those databases |
| Rust 1.98+ | Required for Rust |
| Node.js 22.16+ | Required for TypeScript |

```sh
git clone https://github.com/polyspec/orm && cd orm
go build ./...
```

---

## 2. Schema to manifest

The human-maintained definition is one Mermaid `erDiagram` (`schema/bench.mmd` is an example).

```mermaid
erDiagram
  battle {
    bigint        seq            PK  "auto unsigned"
    varchar(191)  name
    text          description        "?"
    datetime(6)   created_ts         "=now"
    datetime(6)   updated_ts         "=now onupdate"
    tinyint       is_close           "=0"
    bigint        user_seq       FK  "unsigned"
    varchar(255)  aes_hex_email      "?"
  }
  user { bigint seq PK "auto unsigned"  varchar(191) name }

  user ||--o{ battle : user_seq

  %% index battle (user_seq, is_close) ix_user
```

- Comment attributes define nullability, defaults, update timestamps, auto increment, unsigned values, lazy loading, and booleans.
- Column names can imply styles: `aes_hex_*`, `gz_*`, `json_*`, `jsons_*`, `base64_*`, `serialize_*`, and `ip` ([codec.md](codec.md)).
- A relation line `parent ||--o{ child : fk_column` declares the foreign key; queries name relation keys with `match<L>With<R>`.

```sh
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
```

When starting from an existing database, import creates the same file deterministically and preserves declared attributes:

```sh
go run ./cmd/ormgen import --dsn "root@unix(/tmp/mysql.sock)/mydb" --out schema/app.mmd
go run ./cmd/ormgen import --dsn "postgres://user@localhost:5432/mydb" --out schema/app.mmd   # PostgreSQL도 동일
```

## 2.1 Create tables and generate migrations

Generate database-specific `CREATE TABLE` statements from the manifest:

```sh
go run ./cmd/ormgen ddl --schema schema/schema.json --dialect mysql --out create.mysql.sql
go run ./cmd/ormgen ddl --schema schema/schema.json --dialect postgres --out create.postgres.sql
go run ./cmd/ormgen ddl --schema schema/schema.json --dialect sqlite --out create.sqlite.sql
```

Apply the selected SQL file with the database's migration tool or client. `ormgen ddl` writes SQL and does not connect to a database. For idempotent database execution, use `ormgen migrate` against a physical database.

To create a migration, keep the previous manifest, update the Mermaid schema, build the new manifest, and generate a diff:

```sh
cp schema/schema.json schema/schema.previous.json
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
go run ./cmd/ormgen diff --from schema/schema.previous.json --to schema/schema.json \
  --dialect mysql --out migration.mysql.sql
```

Review the generated SQL before applying it. Table removal, column removal, and column definition changes require `--allow-destructive` with `ormgen diff`; the migration command rejects these changes. Renames require an explicit migration because the tool cannot infer whether a rename is safe.

The diff orders foreign-key removal before dependent index removal, applies column changes next, and creates indexes before foreign keys. It compares named indexes, unique constraints, full-text indexes, foreign-key targets and delete actions, column types, nullability, defaults, and comments. PostgreSQL emits separate `TYPE`, `SET|DROP NOT NULL`, and `SET|DROP DEFAULT` operations. Foreign keys use deterministic `fk_<table>_<column>` names and explicitly use `RESTRICT`, `CASCADE`, or `SET NULL`.

SQLite rebuilds a table for column removal or definition changes and for primary-key, unique, or foreign-key changes. The transaction creates a reserved temporary table, copies matching and explicitly renamed columns, replaces the source table, recreates indexes and comments, and verifies foreign keys. Every rebuild requires `--allow-destructive`. A new required column without a default, an existing temporary object, an existing foreign-key violation, or a dependent trigger or view fails before the first rebuild operation. Copy, constraint, or verification failure rolls back the transaction. SQLite evaluates full-text conditions without an index, so full-text declarations create no SQLite objects and do not trigger a rebuild. Adding a nullable column or a column with a default is an `ADD COLUMN` without a rebuild.

`ormgen migrate` reads the live schema, creates `orm_schema_migrations`, computes a plan, applies supported non-destructive changes, verifies the live schema, and records the result. Verification compares tables and columns by name; column order is not a schema property, and a database appends an added column wherever the declaration places it. A column added with a comment receives the comment in the same migration.

The update-time attribute (`onupdate`) is a column property only on MySQL; PostgreSQL and SQLite have no such property, and the ORM assigns the column in each update, so the attribute alone is no PostgreSQL or SQLite change. MySQL and PostgreSQL store CHECK expressions in their own normalized form. The comparison creates the declared expression on a temporary table in the same database, reads it back, and treats equal forms as unchanged. Repeating the same `migration-id` is a no-op only when the recorded migration and live schema match. Use `--dry-run` to print the plan without changing the database.

### 2.2 Schema source matrix

The commands below use one schema source loader. `<source>` accepts `schema.mmd`, `schema.json`, an SQL file created by `ormgen ddl` or `ormgen diff`, or `db:<dsn>`. `--dialect` selects the SQL of `ddl`, `diff`, and `plan`; a `db:` source must use the same dialect.

Every DSN is the URI the clients accept: `mysql://`, `postgres://`, or `sqlite:///<absolute path>`. The scheme selects the database; the tools have no driver option. `import` and `validate` read MySQL, PostgreSQL, and SQLite.

| Input | DDL | diff SQL | structured plan | database migration |
|---|---|---|---|---|
| Mermaid `.mmd` | `ddl --schema` | `diff --from/--to` | `plan --from/--to` | `migrate --schema` |
| manifest `.json` | `ddl --schema` | `diff --from/--to` | `plan --from/--to` | `migrate --schema` |
| ORM `.sql` | `ddl --schema` | `diff --from/--to` | `plan --from/--to` | `migrate --schema` |
| live `db:<dsn>` | `ddl --schema` | `diff --from/--to` | `plan --from/--to` | `migrate --schema` |

```sh
go run ./cmd/ormgen diff --from 'db:sqlite:///var/lib/app.sqlite' --to schema/app.mmd \
  --dialect sqlite --out migrations/20260912-app.sql
go run ./cmd/ormgen plan --from schema/previous.json --to migrations/20260912-app.sql \
  --dialect sqlite --migration-id 20260912-app --out migrations/20260912-app.json
go run ./cmd/ormgen migrate --dsn sqlite:///var/lib/app.sqlite \
  --schema migrations/20260912-app.sql --migration-id 20260912-app
```

`ormgen ddl` and `ormgen diff` include `orm-schema-v1` metadata with the target manifest and hash. This metadata preserves codec styles and relation options when SQL is used as a later schema source. SQL without this metadata fails with `MIGRATION_SOURCE_LOSS`; the command does not infer missing ORM metadata. A `db:<dsn>` source is read-only. Database writes still require `migrate` or `apply` and use migration locks, history records, file logs, source checks, and post-apply verification.

Create a structured plan and apply that exact plan after review:

Migration plan files use `YYYYMMDD-name.json`. The filename without `.json` is the migration ID. If `--migration-id` is present, it must match that value. An invalid date, a missing name, or a different ID returns `MIGRATION_FILE_NAME`.

```sh
go run ./cmd/ormgen plan --from schema/previous.json --to schema/schema.json \
  --dialect postgres --out migrations/20260912-schema.json
go run ./cmd/ormgen apply --plan migrations/20260912-schema.json \
  --dsn "$ORM_DSN" --schema schema/schema.json
go run ./cmd/ormgen verify --dsn "$ORM_DSN" --schema schema/schema.json
go run ./cmd/ormgen rollback --plan migrations/20260912-schema.json \
  --dsn "$ORM_DSN" --allow-destructive
```

The plan stores the source and target manifests, ordered forward and rollback operations, destructive flags, and separate checksums. `apply` checks the live source schema before execution and rejects destructive operations unless `--allow-destructive` is explicit. `rollback` requires the same reviewed plan, an `applied` history row, and a live schema that matches the plan target. It executes the stored rollback operations, verifies the source schema, and changes the history status to `rolled_back`. Repeating the command returns `noop` only when the source schema and rollback file log match.

Rollback restores the schema structure described by the source manifest. It does not restore rows removed by a forward operation or values removed by a rollback operation. A plan containing a destructive operation in either direction sets `rollback_data_loss_risk`; `rollback` then requires `--allow-destructive`. The command rejects modified SQL, checksums, destructive flags, and risk flags before opening the database.

Rollback changes the history state from `applied` to `rolling_back`, then to `rolled_back` after schema verification. An operation or verification failure changes the claimed migration to `rollback_failed` and records the operation number, SQL statement, driver error, and final schema mismatch. A state-claim failure does not replace a state written by another migration process.

Comments are included in the manifest and migration comparison. Use `%% table_comment` and `%% column_comment` in the Mermaid source. The importer reads database comments, and the DDL generator emits dialect-specific comment statements.

Migration statements execute inside one database transaction. On statement failure,
the runner records the statement number, SQL text, driver error, and whether rollback was issued.
Database engines that implicitly commit DDL retain their engine-specific DDL behavior.

Migration execution uses one reserved database connection. MySQL acquires a database-specific
`GET_LOCK`, PostgreSQL acquires a transaction advisory lock, and SQLite starts with
`BEGIN IMMEDIATE`. A competing migration fails with `MIGRATION_LOCK_BUSY` before executing
the first planned statement. Locks are released on commit, rollback, or connection close.

The SQL statement parser recognizes single-quoted strings, quoted identifiers, line comments,
block comments, and PostgreSQL dollar-quoted blocks. Semicolons inside these regions do not end
a statement. Execution errors report the one-based operation number and complete statement text.

Each apply, recovery, and rollback execution also writes a JSON audit file under `migrations/logs` by default. The filename is `<UTC timestamp>__<migration-id>.json`; it contains the driver, schema hashes, plan checksum, status, operation count, start time, finish time, and error detail. Use `--log-dir` to select another directory. An applied or rolled-back migration fails repeat verification if no file log matches its database record and direction.

If execution stops while the database history status is `applying` or `failed`, run an explicit
recovery before retrying. Use the exact reviewed plan for `ormgen apply`, or use the recorded
migration ID for `ormgen migrate`:

```sh
go run ./cmd/ormgen recover --plan migrations/20260912-schema.json \
  --dsn "$ORM_DSN" --schema schema/schema.json
go run ./cmd/ormgen recover --migration-id 20260912-initial \
  --dsn "$ORM_DSN" --schema schema/schema.json
```

Recovery acquires the same database migration lock and compares the live schema with the recorded
source and target. A target match changes the history status to `applied`. A source match changes it
to `retryable`; the same `apply` or `migrate` command can then execute the verified plan. An
`applied` or `retryable` record with a matching file log returns `noop`. Any other schema state fails
with `MIGRATION_RECOVERY_UNSAFE` and reports the migration ID, prior status, source hash, target
hash, and live hash. This failure does not update database history or create a file log.

| Input | Required verification | Result |
|---|---|---|
| Structured plan | Plan checksum, ID, source hash, target hash, operation count, target manifest | `applied`, `retryable`, or `noop` |
| Migration ID | Recorded source hash, recorded target hash, target manifest | `applied`, `retryable`, or `noop` |
| Partial or externally changed schema | Neither source nor target matches | `MIGRATION_RECOVERY_UNSAFE`; no state change |

```sh
go run ./cmd/ormgen migrate --dsn "$ORM_DSN" \
  --schema schema/schema.json --migration-id 20260912-initial --dry-run
go run ./cmd/ormgen migrate --dsn "$ORM_DSN" \
  --schema schema/schema.json --migration-id 20260912-initial
```

---

## 3. Code generation

Each language generates its models with its own build tool. The generator reads `schema.json`, verifies its hash, and writes one model per entity with typed column getters and setters.

```sh
go run github.com/polyspec/orm/cmd/ormgen gen --schema schema/schema.json --lang go --out model --scan ./...
vendor/bin/orm-gen gen --schema schema/schema.json --out src/Model --namespace 'App\Model'
npx orm-gen gen --schema schema/schema.json --out src/models --scan src
```

```rust
// build.rs
fn main() {
    orm_build::Builder::new("schema/schema.json").scan("src").generate();
}
```

| Language | Tool | When it runs |
|---|---|---|
| Go | `ormgen gen --lang go` in a `//go:generate` line | `go generate` before `go build` |
| PHP | `vendor/bin/orm-gen gen` | a Composer script after the schema changes |
| TypeScript | `orm-gen gen` of `@polyspec/orm-typescript` | the `build` script before `tsc` |
| Rust | the `orm-build` crate | `build.rs` on every `cargo build`; `orm::models!()` includes the models as the module `model` |

- Go, Rust, and TypeScript generation reads the consumer source named by `--scan` (Rust: `scan`) and generates the chain methods that the source calls, so a wrong method name stops the build. PHP resolves chain names at call time.
- `ormgen gen --lang go` writes each scan round into a temporary directory beside `--out` and replaces the generated files of `--out` only after the scan converges; files without the generated header stay. A generation failure leaves `--out` unchanged, and `ormgen` exits with status 1; the failures include an invalid chain call, a scan that does not converge, a scanned package that cannot be loaded, and generated code that does not compile. When the scan converges but the scanned packages do not compile for another reason, `--out` holds the complete models, and `ormgen` exits with status 3.
- The scan generates a called method when an argument of the call has an unresolved type, such as a value computed with a method that another model package does not have yet; a join or relation argument must resolve to a model of the generated package. One `go generate` run over several model packages therefore writes the final models of each package. A generation that runs before another package's methods exist still exits with status 3 for the calls of that package.
- After changing the schema or adding a chain call, **regenerate and deploy the models with the schema**. A mismatch between the generated `schema_hash` and the loaded `schema.json` stops startup with `SCHEMA_HASH_MISMATCH`.

The Rust `build.rs` can also build `schema.json` from the diagrams before it generates the models:

```rust
// build.rs
fn main() {
    let files = vec!["schema/app.mmd".into()];
    let manifest = orm_build::schema::build_files(&files).expect("schema");
    std::fs::write("schema/schema.json", manifest.marshal_indent() + "\n").unwrap();
    println!("cargo:rerun-if-changed=schema/app.mmd");
    orm_build::Builder::new("schema/schema.json").scan("src").generate();
}
```

---

## 4. Connections

The application injects one DSN URI from its environment or Secret Manager. The URI scheme selects the database; callers do not pass a second driver value.

```text
mysql://user:password@host:3306/app?timezone=%2B09:00
postgres://user:password@host:5432/app?sslmode=disable
sqlite:///var/lib/app.sqlite
```

Each client accepts the DSN and creates the matching native driver and pool. The client plans every statement in the application process from the loaded schema; no service runs beside the application. An application opens one connection per database, such as `master` and `slave1`, and passes the selected connection to each model with `connect`.

### Go

```go
master, err := model.Connect(masterDSN, schemaPath, orm.Config{AESKey: aesKey})
```

`model.Connect` loads `schemaPath`, checks it against the generated models, and calls `orm.Open(dsn, engine, config)`.

### PHP

```php
$master = Orm::connect($masterDsn, new Config(schemaPath: $schemaPath, aesKey: $aesKey));
```

### Rust

```rust
let master = orm::Db::connect(&master_dsn, pool_size, orm::Config { aes_key, ..Default::default() }).await?;
```

The generated module embeds its schema, so the connection does not take a schema path.

### TypeScript

```typescript
import { Db } from '@polyspec/orm-typescript';

const master = await Db.connect(masterDsn, schemaPath, { aesKey });
```

Each client caches plans by request shape. `connection.utils().schema().install(manifestJson)` creates the missing tables, keys, indexes, comments, and triggers of a manifest on every database; existing tables are kept.

---

## 5. Reading

Method names are shared; only spelling differs (PHP and TypeScript `camelCase` / Go `PascalCase` / Rust `snake_case`).

```php
$rows = (new Battle)->connect($slave1)
    ->serviceSeq(7)->andIsClose(false)
    ->and(fn (Battle $q) => $q->isDisplay(true)->or()->isAllday(true))
    ->andSeq([6, 106, 206])
    ->orderBySeqDesc()->limit(0, 20)
    ->gets();
```
```go
rows, err := model.Battle().Connect(slave1).
    ServiceSeq(7).AndIsClose(false).
    And(func(q *model.BattleModel) { q.IsDisplay(true).Or().IsAllday(true) }).
    AndSeq([]int{6, 106, 206}).
    OrderBySeqDesc().Limit(0, 20).
    Gets()
```
```rust
let rows = Battle::new().connect(&slave1)
    .service_seq(7).and_is_close(false)
    .and(|q| q.is_display(true).or().is_allday(true))
    .and_seq(vec![6, 106, 206])
    .order_by_seq_desc().limit(0, 20)
    .gets().await?;
```
```typescript
const rows = await new Battle().connect(slave1)
    .serviceSeq(7).andIsClose(false)
    .and(q => q.isDisplay(true).or().isAllday(true))
    .andSeq([6, 106, 206])
    .orderBySeqDesc().limit(0, 20)
    .gets();
```

- Conditions: the first condition has no prefix, following conditions use `and<Chain>`, `or<Chain>`, or `and()` and `or()`, and groups use `and(fn)` and `or(fn)`. Operator prefixes, value shapes, and chain rules are in [dsl.md](dsl.md).
- Finders: `getBy<Chain>`, `getsBy<Chain>`, and `getCountBy<Chain>` accept any column chain, such as `getsByServiceSeqAndIsClose(7, false)`.
- Columns: `addColumn<Col>()`, `removeColumn<Col>()`, `removeAllColumns()`, and `addAllColumns()`. `text`, `blob`, and styled columns are excluded from the default SELECT and added with `addColumn<Col>()`.
- Terminals: `get` returns one row and `NO_ROWS` when no row matches. `gets` returns a collection, which is empty when no row matches. `getCount` returns a count.
- A collection is an ordered map keyed by PK or `keyName<Col>()`: `first()`, `count()`, and `toArray()` are available, and iteration yields `key => row`.
- `toArray()` returns the rows as a list of maps in collection order: Go `rows.ToArray()`, Rust `rows.to_array()`, PHP `$rows->toArray()`, and TypeScript `rows.toArray()`. Iteration keeps the keys and their types.

### Aggregates and groups

```php
(new Battle)->connect($slave1)->serviceSeq(7)->groupByUserSeq()->getsCount();   // rows per user with row_count
(new Battle)->connect($slave1)->serviceSeq(7)->sumLikeCount()->getSum();       // sum of like_count
(new Battle)->connect($slave1)->serviceSeq(7)->avgPrice()->getAvg();           // average price
```
Raw condition, order, group, and column forms, subquery columns, and ORM function values are specified in [dsl.md](dsl.md).

---

## 6. Relations and joins

A **relation** uses a separate statement. It batches parent values into `IN` and attaches the child rows.
A **join** is part of the same statement.

```php
$rows = (new Battle)->connect($slave1)->serviceSeq(7)->limit(0, 20)
    ->relation((new User)->matchUserSeqWithSeq())                          // $b->getUser()
    ->relation((new Service)->matchServiceSeqWithSeq()
        ->relations((new ServiceMember)->matchSeqWithServiceSeq()          // ->getServiceMembers()
            ->orderBySeqDesc()->groupLimit(3)
            ->keyNameUserSeq()))
    ->relation((new User)->connect($userReplica)->matchUserSeqWithSeq()->aliasWriter())
    ->joinServiceSeqWithSeq((new Service)->on(fn (Service $s) => $s->name('service-7')))
    ->gets();
```

| Child option | Meaning |
|---|---|
| `match<L>With<R>()` | Parent column `L` equals child column `R` |
| `alias<Name>()` | Result name of the relation |
| `keyName<Col>()` | Key column for a many collection; the last duplicate wins |
| `parentNode()` | Merge one-relation columns into the parent row; parent values win |
| `groupLimit(n)` | n rows per parent using `ROW_NUMBER() OVER (PARTITION BY …)` |
| `possible<Col>(v)` | Load only when the parent row matches |
| `deleteLock()` | Stop point for `delete(true)` |

A relation child with `connect` runs its statement on that connection. A join child sets `ON` conditions with `on(fn)` and `WHERE` conditions directly; `and(child)` or `or(child)` places the child conditions in a group. `connect` on a join child returns `CONFIG`.
Column comparisons with a joined model use `<ColA><Op><ColB>(model)`, such as `priceGtMinPrice($brand)`.

---

## 7. Writes

```php
$row = (new Battle)->connect($master)->setName('x')->setUserSeq(1)->…->create();   // returns the row with its generated key
$row->setName('y')->update();                                                     // updates changed columns only
$row->setName('z')->update(true);                                                 // updated_ts mismatch → OPTIMISTIC_LOCK
$row->delete();
$row->delete(true);                                                               // loaded relations first, except deleteLock()

$replicaRow->connect($master)->plusReadCount(1)->update();                        // read on a replica, write on the primary

(new Battle)->connect($master)->setUuid($u)->setName('x')->…
    ->duplication((new Battle)->setName('x')->plusReadCount(1))->create();        // UPSERT
$row->newIsMember(true);                                                          // attached value, not part of SQL
```

- `update` always writes `updated_ts` explicitly so the value is consistent across dialects.
- `minus<Col>` never stores a negative value. `setRaw<Col>` writes a schema-checked SQL expression.
- `save()` updates when the primary key is set and creates the row otherwise.
- Transactions use `connection.transaction(fn)`. A callback error or exception rolls back the transaction, and deadlocks are retried.
- Calling `transaction` on the same connection inside an active transaction creates a savepoint. An inner failure rolls back only the inner work unless the outer callback returns it.
- Transaction options select `isolation`, `readOnly`, and `timeoutMs`. The supported isolation names are `default`, `read_uncommitted`, `read_committed`, `repeatable_read`, and `serializable`. PostgreSQL applies transaction settings after `BEGIN`; MySQL applies them before `START TRANSACTION` on the retained connection. SQLite applies `readOnly` through `PRAGMA query_only` and maps portable isolation modes to its transaction connection; the ORM restores connection state before commit or rollback. A positive `timeoutMs` applies PostgreSQL `statement_timeout`; MySQL and SQLite return `CAPABILITY_UNSUPPORTED`.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, and `forShareNoWait()` are allowed only inside a transaction. MySQL and PostgreSQL execute the selected row lock; `NoWait` fails immediately when the row is unavailable. SQLite emits no lock suffix and uses an ORM transaction-scoped database lock row for all four modes.
- There is no common in-flight cancellation method. `timeoutMs` limits PostgreSQL statements.

```go
err := master.Transaction(func() error {
    row, err := model.Battle().SetName("x").….Create()
    if err != nil {
        return err
    }
    _, err = model.BattleLog().SetBattleSeq(row.GetSeq()).Create()
    return err
})
```
```php
$row = $master->transaction(fn () => (new Battle)->setName('x')->…->create());
```
```rust
let row = master.transaction(async || Battle::new().set_name("x")./*…*/.create().await).await?;
```

---

## 8. Styled columns

`gz_*`, `json_*`, `jsons_*`, `base64_*`, and `serialize_*` use **decoded values**, not stored bytes, at the client output
(Go `any`, Rust `serde_json::Value`, PHP `mixed`). MySQL handles `aes_hex_*` and `ip` with SQL functions, while
PostgreSQL and SQLite executors produce the same bytes ([codec.md](codec.md)).

```php
$b->setJsonSetting(['a' => 1])->connect($master)->update();
$b = (new Battle)->connect($slave1)->addColumnJsonSetting()->getBySeq(42);   // excluded from the default SELECT
$b->getJsonSetting()['a'];
```

---

## 9. Multiple databases

The same statement produces the same result on all three databases, although statement text differs by dialect. Rules and exceptions are in [dialects.md](dialects.md).

```sh
go run ./cmd/ormgen ddl --schema schema/schema.json --dialect postgres --out app.pg.sql
psql … -f app.pg.sql
```
- Go: `model.Connect(url, schemaPath, config)`; the DSN scheme selects the driver.
- PHP: `Orm::connect(url, config)`; the DSN scheme selects the PDO driver.
- Rust: `orm::Db::connect(url, pool_size, config).await?`; the DSN scheme selects the sqlx driver.
- TypeScript: `Db.connect(url, schemaPath, options)`; the DSN scheme selects the driver package.
- One application can open several connections and select one per model with `connect`, for example reads on `slave1` and writes on `master`.
- SQLite rejects `Lb` and fulltext operators (`OPERATOR_NOT_ALLOWED`).

---

## 10. Operations

| Operation | Command |
|---|---|
| Compare schema with the live database | `ormgen validate --dsn … --schema schema/schema.json` (exit 1 when different) |
| Check generated files | `git diff --exit-code` after the language generator runs |
| Statement log | `Config.OnQuery` / `onQuery` / `Config { on_query }` → `(sql, binds, duration, plan_id, err)`; secrets are masked as `$SECRET` |
| View SQL without executing | `getQuery()` on a connected model ([dsl.md](dsl.md)) |
| Error constants | `ormgen errors --lang go\|php\|rust --out …` ([errors.yaml](errors.yaml)) |
| Install a schema | `connection.utils().schema().install(manifestJson)` |

---

## 11. Common errors

| Code | Cause and action |
|---|---|
| `SCHEMA_HASH_MISMATCH` | Generated files and the engine read different `schema.json` files; regenerate and deploy together |
| `OPERATOR_NOT_ALLOWED` | Operator is unavailable for the type or style, such as styled columns or SQLite fulltext |
| `COLUMN_UNKNOWN` / `RELATION_UNKNOWN` | Name is absent from the schema; correct the diagram and regenerate |
| `EMPTY_IN` | A condition received an empty list; validate before calling |
| `CONFIG` | Missing `connect` outside a transaction, a missing or misplaced connector, `connect` on a join child, or a configuration, path, or driver mismatch |
| `LIMIT_IN_RELATION` | Relation child uses `limit`; use `groupLimit(n)` |
| `OPTIMISTIC_LOCK` | `update(true)` found a newer `updated_ts`; read again and retry |
| `LOCK_NOT_AVAILABLE` | A `*_nowait` row-lock request could not acquire the lock immediately; do not retry it as a transaction conflict |
| `DUPLICATE_KEY` / `DEADLOCK` | Mapped driver error with original text retained; deadlock follows the transaction retries |
| `CODEC_DECODE` | Stored bytes do not match the declared column styles |

---

## 12. Verification

```sh
go test ./...                                            # engine, generator, and Go client
npm run typescript:test                                  # TypeScript client
(cd clients/rust && cargo test --workspace)              # Rust client
go run ./tests/conformance/check run                     # four clients, identical results on MySQL
go run ./tests/conformance/check run -driver postgres -dsn 'postgres:///orm_bench?host=/tmp&timezone=%2B00:00'
```

Examples: [`examples/thin-slice`](../examples/thin-slice) (Go, PHP, and Rust, the same JSON) and [`examples/complex`](../examples/complex) (joins, groups, two-level relations, and aggregates).
