# Usage

Generate Go, PHP, Rust, and TypeScript clients from one dbspec document set and execute the same statement as the same SQL in each client.
Supported databases are MySQL 8 by default, PostgreSQL 12+, and SQLite 3.46+.

A query starts with a generated model and receives an opened database connection through `connect`. Inside a transaction callback, a model without `connect` uses the active transaction.

The complete syntax is in [dsl.md](dsl.md), the schema language is in [dbspec.md](dbspec.md), schema tools are in [schema.md](schema.md), and the IR/Plan format is in [protocol.md](protocol.md).
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

## 2. Schema

The human-maintained definition is a set of dbspec documents ([dbspec.md](dbspec.md)); `schema/bench.dbspec` is an example.

```text
dbspec 1 example

table users {
  id i64 identity
  name varchar(191)
  email bytes null
  key_version i32
  created_at datetime(6) default now
  updated_at datetime(6) default now
  primary key (id)
  settings {
    updated updated_at
    codec email aes
    aes_version key_version
  }
}

table authors {
  id i64 identity
  user_id i64
  closed bool default false
  primary key (id)
  index ix_authors_user (user_id, closed)
  foreign key fk_authors_user (user_id) references users (id) on delete restrict on update restrict
}
```

- Columns state their type, `null`, `identity` and `default`; keys, indexes, foreign keys and checks are named lines of the table.
- Settings give the ORM and the database their behavior: `updated`, `soft_delete`, `aes_version`, `blind_index`, `codec`, `select explicit`, `immutable` and `audit` ([dbspec.md](dbspec.md#settings), [codec.md](codec.md)). A column name never selects behavior.
- A foreign key is named; queries name relation keys with `match<L>With<R>`.

[mermaid.md](mermaid.md) exports a document to a Mermaid `erDiagram` and imports a diagram into a document with the list of what the diagram cannot express.

## 2.1 Create tables and migrate

Each client renders the `CREATE` statements of a document set for one dialect, introspects a database into a document, and applies a chain of migration plans with a lock, history, verification and MySQL recovery. [schema.md](schema.md#_2-schema-operations) lists the functions of each language, [dialects.md](dialects.md#rendered-statements) the rendered statements, and [plans.md](plans.md) the plan documents, the diff and the apply. A rename and the permission to drop are declared in the plan; the diff never infers them.

## 3. Code generation

Each language generates its models with its own build tool. The generator reads the dbspec document set, embeds its manifest text and `manifestHash`, and writes one model per entity with typed column getters and setters.

```sh
go run github.com/polyspec/orm/cmd/orm-gen gen --document schema/example.dbspec --lang go --out model --scan ./...
vendor/bin/orm-gen gen --out src/Model --namespace 'Example\Model' schema/example.dbspec
npx orm-gen gen --schema schema/example.dbspec --out src/models --scan src
```

```rust
// build.rs
fn main() {
    orm_build::Builder::new(["schema/example.dbspec"]).scan("src").generate();
}
```

| Language | Tool | When it runs |
|---|---|---|
| Go | `orm-gen gen --lang go` in a `//go:generate` line | `go generate` before `go build` |
| PHP | `vendor/bin/orm-gen gen` | a Composer script after the schema changes |
| TypeScript | `orm-gen gen` of `@polyspec/orm-typescript` | the `build` script before `tsc` |
| Rust | the `orm-build` crate | `build.rs` on every `cargo build`; `orm::models!()` includes the models as the module `model` |

- Go, Rust, and TypeScript generation reads the source named by `--scan` (Rust: `scan`) and generates the chain methods that the source calls, so a wrong method name stops the build. PHP resolves chain names at call time.
- The TypeScript scan declares a method only for a call whose receiver resolves to a generated model, and declares it on that model. A receiver resolves to a model when it is `new C()` of a generated class `C` (also through an import alias or a namespace import), a variable or parameter bound to a model or typed with a model class, a function or arrow function whose declared return type is a model or, without a declared type, whose expression body or only `return` statement is a model, a chain method of a model, the untyped first parameter of a callback given to `and`, `or`, `on`, `fetchKey`, `fetchValue`, or `addColumn…` of a model, an expression asserted `as C`, or a row of a model: the awaited result of `get` or `getBy…`, or an element of a collection of models (the awaited result of `gets` or `getsBy…`, its `values()` or `filter(…)`, a spread copy, or a value typed `Collection<C>` or `C[]`) reached through `for … of`, an index, `first`, `get`, `at`, `find`, or the callback of `map`, `forEach`, `filter`, `find`, `some`, or `every`. A call on any other receiver, such as `this.enabled()` of a class that is not a model, adds no method; give such a receiver a model type when its calls must be typed.
- `orm-gen gen --lang go` writes each scan round into a temporary directory beside `--out` and replaces the generated files of `--out` only after the scan converges; files without the generated header stay. A generation failure leaves `--out` unchanged, and `orm-gen` exits with status 1; the failures include an invalid chain call, a scan that does not converge, a scanned package that cannot be loaded, and generated code that does not compile. When the scan converges but the scanned packages do not compile for another reason, `--out` holds the complete models, and `orm-gen` exits with status 3.
- `--check` compares the output with the existing files without writing: `gen` of the Go, PHP, and TypeScript `orm-gen`. The command prints `differs: <path>` for a file whose content differs, `missing: <path>` for a file that does not exist, and `extra: <path>` for a file of the output directory that holds the generated-code comment and that the generation no longer writes, ordered by path, and exits with status 1 when it prints a line. Current files print nothing and exit with status 0. Go `gen --check` runs the same scan as `gen` in a directory under the system temporary directory, so the model package keeps the name and import path of `--out`; its generation failures and status 3 are the same as those of `gen`. Rust generates its models in `build.rs` and has no `gen` command.

```sh
go run github.com/polyspec/orm/cmd/orm-gen gen --document schema/example.dbspec --lang go --out model --scan ./... --check
```
- The scan generates a called method when an argument of the call has an unresolved type, such as a value computed with a method that another model package does not have yet; a join or relation argument must resolve to a model of the generated package. One `go generate` run over several model packages therefore writes the final models of each package. A generation that runs before another package's methods exist still exits with status 3 for the calls of that package.
- After changing the schema or adding a chain call, **regenerate and deploy the models with the schema**. A request whose `manifest_hash` differs from the model the client loaded fails with `SCHEMA_HASH_MISMATCH`.

---

## 4. Connections

A connection takes one DSN URI as an argument; the client reads no environment or secret store of its own. The URI scheme selects the database; callers do not pass a second driver value.

```text
mysql://user:password@host:3306/orm_example
postgres://user:password@host:5432/orm_example?sslmode=disable
sqlite:///var/lib/orm_example.sqlite
```

Each client accepts the DSN and creates the matching native driver and pool. The client plans every statement in the calling process from the loaded schema; no service runs beside it. One connection is opened per database, such as `master` and `slave1`, and `connect` gives each model the selected connection.

### Go

```go
master, err := model.Connect(masterDSN, orm.Config{AESKey: aesKey})
```

`orm-gen gen --document <file.dbspec>...` reads the dbspec document set, one `--document` per document, and writes `ManifestText` and `ManifestHash` into the generated `orm.go`. `model.Connect(dsn, config)` calls `orm.Connect(dsn, schema, config)` with that manifest: the runtime builds its model from the text once per process, rejects text whose hash differs from `ManifestHash` with `SCHEMA_HASH_MISMATCH`, and plans every statement in the process. `master.Utils().Schema().Install(model.ManifestText)` renders the document set with the dialect of the connection and applies the statements, triggers included: it creates every table when none of the set exists, changes nothing when all exist, and fails with `CONFIG` when only some exist.

### PHP

```php
$master = Orm::connect($masterDsn, new Config(aesKey: $aesKey));
```

`Orm::connect` takes no schema path: `bootstrap.php` of the generated models registers the runtime model, the manifest text and `manifestHash`, and every request carries that hash. `$db->utils()->schema()->install($documents)` takes the text of every dbspec document of the set.

An audited table (`audit` setting, [dbspec](dbspec.md#audit)) is written inside a transaction that names its operation id; the executor writes the id into the operation column of every audited row the transaction inserts or updates, a soft delete included:

```php
$master->transaction(function (): void {
    (new Service)->setName('renamed')->create();
    (new Service)->getBySeq(42)->delete();
}, operation: $operationId);
```

The id is an `int` for an `i64` operation column and a lower-case canonical UUID `string` for a `uuid` one. An insert or update of an audited table outside such a transaction, or with an id of the other type, fails with `CONFIG`; assigning the operation column with its setter fails with `IR_INVALID`. A nested transaction uses the id of the outer one and does not take `operation`.

### Rust

```rust
let master = orm::Db::connect(&master_dsn, pool_size, orm::Config { aes_key, ..Default::default() }).await?;
master.utils().schema().install(&model::SCHEMA).await?;
```

`orm_build::Builder::new(documents)` reads the dbspec document set and writes the models and the manifest text into `OUT_DIR`. The generated module embeds the manifest text with `include_str!` as `model::SCHEMA` and its `manifestHash` as `model::MANIFEST_HASH`, so the connection does not take a schema path; the runtime model is built from the embedded text on first use, and every request carries `manifestHash`. `utils().schema().install(&model::SCHEMA)` renders the document set for the connection's database and applies the statements. It does nothing when every table of the set exists and returns `CONFIG` when only some exist; MySQL applies the statements outside a transaction and returns `CONFIG` inside one.

An audited table (`audit` setting) takes the operation id of its unit of work from the transaction. `operation(id)` sets it on the outermost transaction; the executor writes it into the operation column of every audited row the transaction inserts or updates, including the update of a soft delete:

```rust
db.transaction(async || {
    service.set_name("renamed").update(false).await
})
.operation(operation_id) // i64 for an i64 operation column, &str or String for a uuid column
.await?;
```

An insert or update of an audited table without an operation id, outside a transaction or with an id that does not fit the operation column type, fails with `CONFIG`. A nested transaction accepts no `operation`, and a request that assigns the operation column itself fails with `IR_INVALID`.

### TypeScript

```typescript
import { Db } from '@polyspec/orm-typescript';
import { Item } from './models/models.js';

const master = await Db.connect(masterDsn, { aesKey });
await master.utils().schema().install([await readFile('schema/example.dbspec', 'utf8')]);
await master.transaction(async () => {
  await new Item().setTitle('first').create();
}, { operation: 42 });
```

`orm-gen gen` takes each dbspec document of the set with a repeated `--schema`, and the generated `models.ts` exports the manifest text as `MANIFEST_TEXT` and its hash as `MANIFEST_HASH` and registers the model when it is imported; `Db.connect(dsn, options)` takes no schema path, and a request of models that the process did not import fails with `SCHEMA_HASH_MISMATCH`. `utils().schema().install(texts)` takes the dbspec texts of one document set and applies their rendered statements when none of their tables exists; when every table exists it changes nothing, and when only some exist it fails with `CONFIG`. The `operation` option of `transaction` is the operation id of the unit of work: every insert and update of a table with an `audit` setting inside the transaction writes it into the operation column, a soft delete included. It is a safe integer for an `i64` operation column and a string for a `uuid` one; an insert or update of an audited table without it, or with an id of the other type, fails with `CONFIG`, and assigning the operation column yourself fails with `IR_INVALID`. A nested transaction keeps the operation of the outer one.

Each client caches plans by request shape. `connection.utils().schema().install(texts)` installs the document set ([schema.md](schema.md#_4-schema-installation)).

---

## 5. Reading

Method names are shared; only spelling differs (PHP and TypeScript `camelCase` / Go `PascalCase` / Rust `snake_case`).

```php
$rows = (new Author)->connect($slave1)
    ->serviceSeq(7)->andIsClose(false)
    ->and(fn (Author $q) => $q->isDisplay(true)->or()->isAllday(true))
    ->andSeq([6, 106, 206])
    ->orderBySeqDesc()->limit(0, 20)
    ->gets();
```
```go
rows, err := model.Author().Connect(slave1).
    ServiceSeq(7).AndIsClose(false).
    And(func(q *model.AuthorModel) { q.IsDisplay(true).Or().IsAllday(true) }).
    AndSeq([]int{6, 106, 206}).
    OrderBySeqDesc().Limit(0, 20).
    Gets()
```
```rust
let rows = Author::new().connect(&slave1)
    .service_seq(7).and_is_close(false)
    .and(|q| q.is_display(true).or().is_allday(true))
    .and_seq(vec![6, 106, 206])
    .order_by_seq_desc().limit(0, 20)
    .gets().await?;
```
```typescript
const rows = await new Author().connect(slave1)
    .serviceSeq(7).andIsClose(false)
    .and(q => q.isDisplay(true).or().isAllday(true))
    .andSeq([6, 106, 206])
    .orderBySeqDesc().limit(0, 20)
    .gets();
```

- Conditions: the first condition has no prefix, following conditions use `and<Chain>`, `or<Chain>`, or `and()` and `or()`, and groups use `and(fn)` and `or(fn)`. Operator prefixes, value shapes, and chain rules are in [dsl.md](dsl.md).
- Finders: `getBy<Chain>`, `getsBy<Chain>`, and `getCountBy<Chain>` accept any column chain, such as `getsByServiceSeqAndIsClose(7, false)`.
- Columns: `addColumn<Col>()`, `removeColumn<Col>()`, `removeAllColumns()`, and `addAllColumns()`. `text`, `blob`, and styled columns are excluded from the default SELECT and added with `addColumn<Col>()`.
- Rust generated model fields are private. Reading a column that was neither selected nor assigned returns `COLUMN_UNSELECTED`; an omitted value is never presented as SQL NULL or a default.
- PHP generated model getters also return `COLUMN_UNSELECTED` when a non-styled column was neither selected nor assigned; selected SQL NULL and explicitly assigned values remain readable.
- Terminals: `get` returns one row and `NO_ROWS` when no row matches. `gets` returns a collection, which is empty when no row matches. `getCount` returns a count.
- A collection is an ordered map keyed by PK or `keyName<Col>()`: `first()`, `count()`, and `toArray()` are available, and iteration yields `key => row`.
- `toArray()` returns the rows as a list of maps in collection order: Go `rows.ToArray()`, Rust `rows.to_array()`, PHP `$rows->toArray()`, and TypeScript `rows.toArray()`. Iteration keeps the keys and their types.

### Aggregates and groups

```php
(new Author)->connect($slave1)->serviceSeq(7)->groupByUserSeq()->getsCount();   // rows per user with row_count
(new Author)->connect($slave1)->serviceSeq(7)->sumLikeCount()->getSum();       // sum of like_count
(new Author)->connect($slave1)->serviceSeq(7)->avgPrice()->getAvg();           // average price
```
Raw condition, order, group, and column forms, subquery columns, and ORM function values are specified in [dsl.md](dsl.md).
Rust `gets_count()` returns `GroupRows` with only selected grouping values and a checked `row_count`, instead of a partially populated model.
Rust `GroupRow::value(name)` returns `Result<&Val>`: an unselected name reports `COLUMN_UNSELECTED`, while a selected SQL NULL remains `Val::Null`.
Go `GetsCount()` returns `*orm.GroupRows`. Each `GroupRow` exposes its selected values through `Value(name)` and its checked count through `Count()`. `Value(name)` returns `COLUMN_UNSELECTED` for an unselected name and returns nil without an error for a selected SQL NULL.
PHP and TypeScript `getsCount()` also return `GroupRows` with `GroupRow` entries. Use `value(name)` for a selected grouping value and `count()` in PHP or `count` in TypeScript for the checked row count. An unselected name fails with `COLUMN_UNSELECTED`; SQL NULL remains null.

---

## 6. Relations and joins

A **relation** uses a separate statement. It batches parent values into `IN` and attaches the child rows.
A **join** is part of the same statement.

```php
$rows = (new Author)->connect($slave1)->serviceSeq(7)->limit(0, 20)
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
$row = (new Author)->connect($master)->setName('x')->setUserSeq(1)->…->create();   // returns the row with its generated key
$row->setName('y')->update();                                                     // updates changed columns only
$row->setName('z')->update(true);                                                 // updated_ts mismatch → OPTIMISTIC_LOCK
$row->delete();
$row->delete(true);                                                               // loaded relations first, except deleteLock()

$replicaRow->connect($master)->plusReadCount(1)->update();                        // read on a replica, write on the primary

(new Author)->connect($master)->setUuid($u)->setName('x')->…
    ->duplication((new Author)->setName('x')->plusReadCount(1))->create();        // UPSERT
$row->newIsMember(true);                                                          // attached value, not part of SQL
```

- `update` always writes `updated_ts` explicitly so the value is consistent across dialects.
- `minus<Col>` never stores a negative value. `setRaw<Col>` writes a schema-checked SQL expression.
- `save()` updates when the primary key is set and creates the row otherwise.
- Transactions use `connection.transaction(fn)`. A callback error or exception rolls back the transaction, and deadlocks are retried.
- Calling `transaction` on the same connection inside an active transaction creates a savepoint. An inner failure rolls back only the inner work unless the outer callback returns it.
- Transaction options select `isolation`, `readOnly`, and `timeoutMs`. The supported isolation names are `default`, `read_uncommitted`, `read_committed`, `repeatable_read`, and `serializable`. PostgreSQL applies transaction settings after `BEGIN`; MySQL applies them before `START TRANSACTION` on the retained connection. SQLite applies `readOnly` through `PRAGMA query_only` and maps portable isolation modes to its transaction connection; the ORM restores connection state before commit or rollback. A positive `timeoutMs` applies PostgreSQL `statement_timeout`; MySQL and SQLite return `CAPABILITY_UNSUPPORTED`.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, and `forShareNoWait()` are allowed only inside a transaction. MySQL and PostgreSQL execute the selected row lock; `NoWait` fails immediately when the row is unavailable. SQLite emits no lock suffix and uses an ORM transaction-scoped database lock row for all four modes. A SQLite write transaction takes the database write lock when it begins, so a lock request inside it succeeds without waiting, and the lock wait happens when the transaction begins ([runtime connection](config.md)).
- There is no common in-flight cancellation method. `timeoutMs` limits PostgreSQL statements.

```go
err := master.Transaction(func() error {
    row, err := model.Author().SetName("x").….Create()
    if err != nil {
        return err
    }
    _, err = model.AuthorLog().SetAuthorSeq(row.GetSeq()).Create()
    return err
})
```
```php
$row = $master->transaction(fn () => (new Author)->setName('x')->…->create());
```
```rust
let row = master.transaction(async || Author::new().set_name("x")./*…*/.create().await).await?;
```

### Go operation id

A table with an `audit` setting ([audit](dbspec.md#audit)) is written only inside a transaction that names its unit of work with `orm.Operation(id)`. Every insert, update, soft delete and duplicate update of an audited table in the transaction writes `id` into the table's operation column, and the database triggers copy each version into the history table. `id` is an `int64` for an `i64` operation column and a lower-case UUID string for a `uuid` operation column. A nested transaction uses the id of the outer transaction and accepts only `orm.Retry`.

```go
err := master.Transaction(func() error {
    _, err := model.Item().SetTitle("draft").Create()
    return err
}, orm.Operation(int64(42)))
```

A write of an audited table outside such a transaction, or with an id that does not fit the operation column, fails with `CONFIG` before it reaches the database; `orm.Operation` with a value that is neither `int64` nor `string` fails the transaction with `CONFIG` before it begins. A request that assigns the operation column itself fails with `IR_INVALID`.

---

## 8. Styled columns

`gz_*`, `json_*`, `jsons_*`, `base64_*`, and `serialize_*` use **decoded values**, not stored bytes, at the client output
(Go `any`, Rust `serde_json::Value`, PHP `mixed`). MySQL handles `aes_hex_*` and `ip` with SQL functions, while
PostgreSQL and SQLite executors produce the same bytes ([codec.md](codec.md)).

```php
$b->setJsonSetting(['a' => 1])->connect($master)->update();
$b = (new Author)->connect($slave1)->addColumnJsonSetting()->getBySeq(42);   // excluded from the default SELECT
$b->getJsonSetting()['a'];
```

---

## 9. Multiple databases

The same statement produces the same result on all three databases, although statement text differs by dialect. Rules and exceptions are in [dialects.md](dialects.md).

`connection.utils().schema().install(...)` renders the document set with the dialect of the connection ([schema.md](schema.md#_4-schema-installation)).

- Go: `model.Connect(url, config)`; the DSN scheme selects the driver.
- PHP: `Orm::connect(url, config)`; the DSN scheme selects the PDO driver.
- Rust: `orm::Db::connect(url, pool_size, config).await?`; the DSN scheme selects the sqlx driver.
- TypeScript: `Db.connect(url, options)`; the DSN scheme selects the driver package.
- Several connections can be open at once, and `connect` selects one per model, for example reads on `slave1` and writes on `master`.
- SQLite rejects `Lb` and fulltext operators (`OPERATOR_NOT_ALLOWED`).

---

## 10. Operations

| Operation | Command |
|---|---|
| Compare schema with the live database | introspect the database and compare its schema text with the document set ([schema.md](schema.md#_2-schema-operations)) |
| Check generated files | `git diff --exit-code` after the language generator runs |
| Statement log | `Config.OnQuery` / `onQuery` / `Config { on_query }` → `(sql, binds, duration, plan_id, err)`; secrets are masked as `$SECRET` |
| View SQL without executing | `getQuery()` on a connected model ([dsl.md](dsl.md)) |
| Error constants | `orm-gen errors --lang go\|php\|rust --out …` ([errors.yaml](errors.yaml)) |
| Install a schema | `connection.utils().schema().install(...)` ([schema.md](schema.md#_4-schema-installation)) |

---

## 11. Common errors

| Code | Cause and action |
|---|---|
| `SCHEMA_HASH_MISMATCH` | The generated models carry another `manifestHash` than the model the client loaded; regenerate and deploy together |
| `OPERATOR_NOT_ALLOWED` | Operator is unavailable for the type or style, such as styled columns or SQLite fulltext |
| `COLUMN_UNKNOWN` / `RELATION_UNKNOWN` | Name is absent from the schema; correct the document and regenerate |
| `EMPTY_IN` | A condition received an empty list; validate before calling |
| `CONFIG` | Missing `connect` outside a transaction, a missing or misplaced connector, `connect` on a join child, or a configuration, path, or driver mismatch |
| `LIMIT_IN_RELATION` | Relation child uses `limit`; use `groupLimit(n)` |
| `OPTIMISTIC_LOCK` | `update(true)` found a newer `updated_ts`; read again and retry |
| `LOCK_NOT_AVAILABLE` | A `*_nowait` row-lock request could not acquire the lock immediately; do not retry it as a transaction conflict |
| `DUPLICATE_KEY` / `DEADLOCK` | Mapped driver error with original text retained; deadlock follows the transaction retries |
| `CANCELED` | The statement stopped before it finished: a cancellation, a timeout bound, or a SQLite lock that another connection still held when `busy_timeout` ended; it is not retried |
| `READ_ONLY` | A write reached a read-only server or connection: a replica, a read-only transaction, or a SQLite database opened read-only; send the write through the primary connection |
| `CONSTRAINT` | A CHECK constraint refused the row; the error keeps the driver message and the driver error |
| `DRIVER` | Any other driver error, such as a write that an `audit` or `immutable` trigger refuses; the error keeps the driver message and the driver error as its cause |
| `ROLLBACK` | The callback of a transaction or savepoint failed and its rollback failed too, for example because the server ended the session; the error keeps both errors and is not retried |
| `CODEC_DECODE` | Stored bytes do not match the declared column styles |

---

## 12. Verification

```sh
make test-servers                                        # MySQL, PostgreSQL, their replicas, ProxySQL, PgBouncer, and the seeded bench databases
. .runtime/servers/env                                   # the DSN variables of the tests
go test ./...                                            # engine, generator, and Go client
npm run typescript:test                                  # TypeScript client
(cd clients/rust && cargo test --workspace)              # Rust client
go run ./tests/conformance/check run -dsn "$BENCH_MYSQL_DSN"   # four clients, identical results on MySQL
go run ./tests/conformance/check run -driver postgres -dsn "$BENCH_POSTGRES_DSN"
```

Examples: [`examples/thin-slice`](../examples/thin-slice) (Go, PHP, and Rust, the same JSON) and [`examples/complex`](../examples/complex) (joins, groups, two-level relations, and aggregates).

Rust source analysis separates a fallible model setter result from its model. Error mapping and checked extraction preserve the model; success mapping can return another type. Result operations do not create column methods. Unknown calls on a known model still fail generation.
