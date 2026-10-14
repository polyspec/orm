<!-- doc-id: usage -->
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
go build ./packages/go/... ./tests/... ./examples/...
```

---

## 2. Schema

The human-maintained definition is a set of dbspec documents ([dbspec.md](dbspec.md)); `contracts/fixtures/bench/bench.dbs` is an example.

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

Every generator takes the document set as its [set file](dbspec.md#document-sets), here `contracts/fixtures/bench/dbspec-set.json` beside the documents it lists, and no other form:

```json
{"schema": 1, "documents": ["example.dbs"]}
```

```sh
go run github.com/polyspec/orm/packages/go/cmd/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --lang go --out model --scan ./...
vendor/bin/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out src/Model --namespace 'Example\Model' --scan src
npx orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out src/models --scan src
orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out model --scan src
```

```rust
// build.rs
fn main() {
    polyspec_orm_build::Builder::set("contracts/fixtures/bench/dbspec-set.json").scan("src").generate();
}
```

| Language | Tool | When it runs |
|---|---|---|
| Go | `orm-gen gen --lang go` in a `//go:generate` line | `go generate` before `go build` |
| PHP | `vendor/bin/orm-gen gen` | a Composer script after the schema changes |
| TypeScript | `orm-gen gen` of `@polyspec/orm` | the `build` script before `tsc` |
| Python | `orm-gen gen` (Python package) | after the schema or a scanned source changes |
| Rust | the `polyspec-orm-build` crate | `build.rs` on every `cargo build`; `polyspec_orm::models!()` includes the models as the module `model` |

- Every generator declares a typed method for every prefix of every key of a model (the primary key, the unique keys and the indexes), from the schema, whether or not the source named by `--scan` calls it: a single column is its column method, such as `auditSeq` of the index on `audit_seq`, and several columns are the tuple method, such as `tupleAccountSeqWithProjectSeq`. Go, Rust, TypeScript, PHP and Python declare these methods in the generated models; Python and PHP also declare the condition method of every column and the column methods, each typed to return the model, and resolve every other chain name at run time. The scan adds the chain methods that the source calls, and a name that the chain grammar does not accept stops the build. PHP declares in each generated model the methods that the schema enumerates, so that a static analyser such as PHPStan finds them: the condition method of every column, the tuple method of every key prefix of two or more columns, `addColumn<Col>`, `removeColumn<Col>`, `groupBy<Col>`, `keyName<Col>`, `orderBy<Col>Asc` and `orderBy<Col>Desc` of every column, `plus<Col>`, `minus<Col>`, `sum<Col>` and `avg<Col>` of every numeric column, and `forceIndex<Index>` of every index. Each runs the chain of its name, so it builds the query that the chain builds. With `--scan`, PHP also declares as `@method` tags the chain methods that the scanned sources call, and a name that the chain grammar does not accept stops the build ([dsl.md](dsl.md)). Without `--scan`, PHP resolves every other chain name at call time through `__call`, because the schema does not enumerate it: an operator chain such as `lbName` or `gtSeq`, a chain of several columns such as `seqAndName`, a condition with `and` or `or`, a finder `getBy<Chain>`, `getsBy<Chain>` or `getCountBy<Chain>`, an order of several columns, `join<Pair>`, `leftJoin<Pair>`, `match<Pair>`, `alias<Name>`, `new<Name>`, `possible<Col>`, `addColumn<Name>` of an added column, and `get<Name>` of an added value or relation.
- The generated models depend only on the documents and the scanned sources, not on how a path is written: a scan or output path written relative or absolute, with a `./` component or with a trailing `/` gives the same files, and so does a PHP set file path written relative, absolute or with `./`. Rust `include_str!` names the manifest file by the canonical path of the output directory.
- The TypeScript scan declares a method only for a call whose receiver resolves to a generated model, and declares it on that model. A receiver resolves to a model when it is `new C()` of a generated class `C` (also through an import alias or a namespace import), a variable or parameter bound to a model or typed with a model class, a function or arrow function whose declared return type is a model or, without a declared type, whose expression body or only `return` statement is a model, a chain method of a model, the untyped first parameter of a callback given to `and`, `or`, `on`, `fetchKey`, `fetchValue`, or `addColumn…` of a model, an expression asserted `as C`, or a row of a model: the awaited result of `get` or `getBy…`, or an element of a collection of models (the awaited result of `gets` or `getsBy…`, its `values()` or `filter(…)`, a spread copy, or a value typed `Collection<C>` or `C[]`) reached through `for … of`, an index, `first`, `get`, `at`, `find`, or the callback of `map`, `forEach`, `filter`, `find`, `some`, or `every`. A call on any other receiver, such as `this.enabled()` of a class that is not a model, adds no method; give such a receiver a model type when its calls must be typed.
- `orm-gen gen --lang go` writes each scan round into a temporary directory beside `--out` and replaces the generated files of `--out` only after the scan converges; files without the generated header stay. A generation failure leaves `--out` unchanged, and `orm-gen` exits with status 1; the failures include an invalid chain call, a scan that does not converge, a scanned package that cannot be loaded, and generated code that does not compile. When the scan converges but the scanned packages do not compile for another reason, `--out` holds the complete models, and `orm-gen` exits with status 3.
- `--check` compares the output with the existing files without writing: `gen` of the Go, PHP, TypeScript and Python `orm-gen`. The command prints `differs: <path>` for a file whose content differs, `missing: <path>` for a file that does not exist, and `extra: <path>` for a file of the output directory that holds the generated-code comment and that the generation no longer writes, ordered by path, and exits with status 1 when it prints a line. Current files print nothing and exit with status 0. Python writes one file, `models.py`, so its check prints `missing` or `differs` for it and has no `extra` line. Go `gen --check` runs the same scan as `gen` in a directory under the system temporary directory, so the model package keeps the name and import path of `--out`; its generation failures and status 3 are the same as those of `gen`. Rust generates its models in `build.rs` and has no `gen` command.

```sh
go run github.com/polyspec/orm/packages/go/cmd/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --lang go --out model --scan ./... --check
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

`orm-gen gen --set <dbspec-set.json>` reads the dbspec document set from its set file with `dbspec.ReadSet` and writes `ManifestText`, `ManifestHash` and the schema value `Schema` into the generated `orm.go`; each path of the set file's `external` names an [external document](dbspec.md#external-documents), whose used tables the generated code carries as `ExternalText` and `Install` checks in the database, without generating their models. `model.Connect(dsn, config)` calls `orm.ConnectSchema(dsn, model.Schema, config)`: it opens the connection and registers the set of the models on it, and a text whose hash differs from `ManifestHash` fails with `CONFIG`. A request of a set that is not registered on its connection fails with `SCHEMA_HASH_MISMATCH` ([protocol](protocol.md)); `orm.Connect(dsn, config)` opens a connection without any set. `master.Utils().Schema().Install(model.Schema)` registers the set on the connection and renders the document set with the dialect of the connection and applies the statements, triggers included: it creates every table when none of the set exists, changes nothing when all exist, and fails with `CONFIG` when only some exist; then it fails with `CONFIG` naming each difference when the tables of the set in the database differ from the set.

### PHP

```php
$master = \Polyspec\Orm\Tests\Model\connect($masterDsn, new Config(aesKey: $aesKey));
$master->utils()->schema()->register(\Module\Orm\schema());
```

`bootstrap.php` of the generated models defines `MANIFEST_TEXT`, `MANIFEST_HASH`, the schema value `schema()` and the connect helper `connect()`, which opens the connection with `Orm::connectSchema` and registers the set of the models on it; every request carries `manifestHash`. `Orm::connect` opens a connection without any set. `$db->utils()->schema()->register(\Module\Orm\schema())` registers the set of other generated models, here a module set, on the same connection without a statement, so a server that opens a connection per request registers every set it uses on it. `$db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema())` installs the set at deployment, verifies the database and registers the set on the connection. `new Config(poolSize: 1)` keeps one connection per php-fpm worker across its requests instead of connecting in every request ([config](config.md)); the connection keeps its session settings, and a transaction that an ended request left open is rolled back with its locks and local values.

### Rust

```rust
let master = model::connect(&master_dsn, pool_size, polyspec_orm::Config { aes_key, ..Default::default() }).await?;
master.utils().schema().install(&model::SCHEMA).await?;
```

`polyspec_orm_build::Builder::set(path)` reads the dbspec document set from its set file with `dbspec::read_set` and writes the models and the manifest text into `OUT_DIR`. The generated module embeds the manifest text with `include_str!` as `model::SCHEMA` and its `manifestHash` as `model::MANIFEST_HASH`; its `model::connect` calls `polyspec_orm::Db::connect_schema(dsn, &model::SCHEMA, pool_size, config)`, which opens the connection and registers the set on it. `polyspec_orm::Db::connect` opens a connection without any set. The runtime model is built from the embedded text on first use, and every request carries `manifestHash`. `utils().schema().install(&model::SCHEMA)` registers the set on the connection and renders the document set for the connection's database and applies the statements. It creates nothing when every table of the set exists and returns `CONFIG` when only some exist, and then returns `CONFIG` naming each difference when the tables of the set differ from the set; MySQL applies the statements outside a transaction and returns `CONFIG` inside one.

### TypeScript

```typescript
import { Item, SCHEMA, connect } from './models/models.js';

const master = await connect(masterDsn, { aesKey });
await master.utils().schema().install(SCHEMA);
```

`orm-gen gen --set <dbspec-set.json>` reads the dbspec document set from its set file with `readDbspecSet`, and the generated `models.ts` exports the manifest text as `MANIFEST_TEXT`, its hash as `MANIFEST_HASH`, the schema value `SCHEMA` and the connect helper `connect(dsn, options)`, which opens the connection with `Db.connectSchema` and registers the set of the models on it. `Db.connect(dsn, options)` opens a connection without any set, and a request of a set that is not registered on its connection fails with `SCHEMA_HASH_MISMATCH`. `utils().schema().install(SCHEMA)` takes the schema value of one document set, registers it on the connection and applies their rendered statements when none of their tables exists; when every table exists it changes nothing, and when only some exist it fails with `CONFIG`; then it fails with `CONFIG` naming each difference when the tables of the set differ from the set.

Each client caches plans by request shape. `connection.utils().schema().install(schema)` installs the document set ([schema.md](schema.md#_4-schema-installation)), and `connection.utils().schema().addTablesAndColumns(schema)` upgrades an installed set to a version that only adds: it creates the tables the database lacks, adds the missing columns of its existing tables that are null or have a default, creates their missing indexes, and returns `SCHEMA_DIFFERS` before any change for every other difference, a missing unique key included, because it can fail on the existing rows and belongs to a plan ([schema.md](schema.md#_5-adding-tables-and-columns)). Both verify the database when they run; `connection.utils().schema().register(schema)` and the connect helper register a set on each connection without reading the database ([schema.md](schema.md#_6-schema-registration)).

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

- Conditions: the first condition has no prefix, following conditions use `and<Chain>`, `or<Chain>`, or `and()` and `or()`, groups use `and(fn)` and `or(fn)`, and negated groups `not(fn)`, `andNot(fn)` and `orNot(fn)`. Operator prefixes, value shapes, and chain rules are in [dsl.md](dsl.md).
- Finders: `getBy<Chain>`, `getsBy<Chain>`, and `getCountBy<Chain>` apply a column chain, such as `getsByServiceSeqAndIsClose(7, false)`. Go, Rust and TypeScript declare the chains that model generation finds in the scanned code, PHP declares them as `@method` tags when `--scan` is given and otherwise resolves a chain when the call runs, and Python resolves a chain when the call runs; the rule is in [finder chains](interfaces.md#finder-chains).
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
Negated groups, column function outputs, subquery columns, and ORM function values are specified in [dsl.md](dsl.md).
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
- `minus<Col>` never stores a negative value.
- `save()` updates when the primary key is set and creates the row otherwise.
- Transactions use `connection.transaction(fn)`. A callback error or exception rolls back the transaction, and deadlocks are retried.
- Calling `transaction` on the same connection inside an active transaction creates a savepoint. An inner failure rolls back only the inner work unless the outer callback returns it.
- Transaction options select `isolation`, `readOnly`, and `timeoutMs`. The supported isolation names are `default`, `read_uncommitted`, `read_committed`, `repeatable_read`, and `serializable`. PostgreSQL applies transaction settings after `BEGIN`; MySQL applies them before `START TRANSACTION` on the retained connection. SQLite applies `readOnly` through `PRAGMA query_only` and maps portable isolation modes to its transaction connection; the ORM restores connection state before commit or rollback. A positive `timeoutMs` applies PostgreSQL `statement_timeout`; MySQL and SQLite return `CAPABILITY_UNSUPPORTED`.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, and `forShareNoWait()` are allowed only inside a transaction. MySQL and PostgreSQL execute the selected row lock; `NoWait` fails immediately when the row is unavailable. SQLite emits no lock suffix and uses an ORM transaction-scoped database lock row for all four modes. A SQLite write transaction takes the database write lock when it begins, so a lock request inside it succeeds without waiting, and the lock wait happens when the transaction begins ([runtime connection](config.md)).
- There is no common in-flight cancellation method. `timeoutMs` limits PostgreSQL statements.
- A test makes the rollback of a transaction fail on every database with the test fault of its client, which a production build does not contain or load ([protocol §3.1](protocol.md#_3-1-test-faults)): Go `orm.FailNextRollback(db)` with `-tags ormtest`, Rust `polyspec_orm::testing::fail_next_rollback(&db)` with the feature `test-faults`, TypeScript `failNextRollback(db)` of `@polyspec/orm/testing` under `node --conditions=orm-test`, and PHP `Polyspec\Orm\Testing\Faults::failNextRollback($db)` after `require 'vendor/polyspec/orm/testing/Faults.php'`. The next transaction whose callback fails is rolled back and returns `ROLLBACK` with the callback error and a `FAULT` error.
- A test makes the next statement of a connection fail with a given code and message on every database with the statement fault of its client ([protocol §3.2](protocol.md#_3-2-test-statement-fault)): Go `orm.FailNextStatement(db, code, message)` with `-tags ormtest`, Rust `polyspec_orm::testing::fail_next_statement(&db, code, message)` with the feature `test-faults`, TypeScript `failNextStatement(db, code, message)` of `@polyspec/orm/testing` under `node --conditions=orm-test`, PHP `Polyspec\Orm\Testing\Faults::failNextStatement($db, $code, $message)`, and Python `polyspec.orm.testing.fail_next_statement(db, code, message)`. The statement is not sent; the client reports it as `OrmException` with that code and message, and the fault is consumed by that statement.

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

### Audited writes

A table with an `audit` setting ([audit](dbspec.md#audit)) is written only inside a transaction that records its unit of work in the audit record table, the table that the setting names with `references`. Two places give the record its values:

- The connection configuration takes `auditSource` once per process ([configuration](config.md)): a function that returns the audit values of the current request, a map from column name to value of the audit record table, such as the account and the request id. The ORM writes no audit value of its own.
- The `audit` option of a transaction holds the values of this change, a map from column name to value (Go `orm.Audit(map[string]any)`, PHP `audit:` array, Rust `.audit(pairs)` on `transaction`, `transaction_send` and `transaction_once`, TypeScript `{ audit: {...} }`). An empty map records the source's values alone.

```go
master, err := model.Connect(dsn, orm.Config{AuditSource: func(ctx context.Context) (map[string]any, error) {
    r := requestOf(ctx) // the request context of the calling code
    return map[string]any{"account_seq": r.AccountSeq, "request_id": r.ID}, nil
}})
err = master.WithContext(ctx).Transaction(func() error {
    _, err := model.Service().SetName("renamed").Create()
    return err
}, orm.Audit(map[string]any{"action": "service.rename", "reason": reason}))
```
```php
$master = \Polyspec\Orm\Tests\Model\connect($dsn, new Config(auditSource: fn (): array => ['account_seq' => $request->accountSeq(), 'request_id' => $request->id()]));
$master->transaction(function (): void {
    (new Service)->setName('renamed')->create();
}, audit: ['action' => 'service.rename', 'reason' => $reason]);
```
```rust
let master = model::connect(&dsn, pool_size, polyspec_orm::Config {
    audit_source: Some(Arc::new(|| Ok(vec![("account_seq".into(), Param::I64(current_account()?)), ("request_id".into(), Param::from(current_request_id()?))]))),
    ..Default::default()
}).await?;
master.transaction(async || Service::new().set_name("renamed").create().await.map(|_| ()))
    .audit([("action", "service.rename"), ("reason", reason.as_str())])
    .await?;
```
```typescript
const master = await connect(dsn, { auditSource: () => ({ account_seq: currentRequest().accountSeq, request_id: currentRequest().id }) });
await master.transaction(async () => {
  await new Service().setName('renamed').create();
}, { audit: { action: 'service.rename', reason } });
```

- A transaction with `audit` calls the source once, before it begins, and before the callback, in every attempt of a retried transaction, inserts one row into the audit record table with the source's values and its own, where a value of the transaction wins over the source's value of the same column. Every insert, update, soft delete and restore of an audited table in the transaction writes that row's primary key (the generated identity, or the given value) into the table's audit column, and the database triggers copy each version into the history table. A failed callback rolls the audit row back with the changes.
- The audit record table is the one table that the `references` of the audited tables of the sets registered on the connection name, and it is a table of a set registered on the connection; no such table, several of them, or a primary key of more than one column fail with `CONFIG`. The transaction fails with `CONFIG` before it begins when the connection has no audit source, a value of the source or the transaction names a column that the audit record table does not have, or no value is given at all; an error of the source fails the transaction with that error.
- A write of an audited table outside a transaction with `audit` fails with `CONFIG`. A nested transaction uses the audit of the outer one and does not take `audit`; a request that assigns the audit column itself fails with `IR_INVALID`.

### Restore a soft-deleted row

A delete of a table with a `soft_delete` setting keeps the row and its unique key values, and reads never return it, so inserting the same key again fails with `DUPLICATE_KEY`. `restore()` brings such a row back: set the values of the primary key or of one unique key on a new model, and any new values of other columns, and call `restore()`. It sends the set values as the request's `set`; the planner picks the key after the request hook, which may add conditions to the restore as to an `update`. It writes the new values and clears the soft delete column with one `UPDATE` ([protocol](protocol.md#_1-5-restore)), reads the row by the values of that key with the default select set and returns it as a loaded model.

```go
row, err := model.Membership().Connect(master).SetTeamId(1).SetMemberId(2).SetRole("owner").Restore()
```
```php
$row = (new Membership)->connect($master)->setTeamId(1)->setMemberId(2)->setRole('owner')->restore();
```
```rust
let row = Membership::new().connect(&master).set_team_id(1).set_member_id(2).set_role("owner").restore().await?;
```
```typescript
const row = await new Membership().connect(master).setTeamId(1).setMemberId(2).setRole('owner').restore();
```

- The key is the primary key when the set values and the `eq` conditions of a column of the request after the hook, without a function, value function, ref or subquery, give every primary key column a value, otherwise the first unique key, in name order, whose columns they all give a value; a key value is a plain value, not null, raw, plus or minus. A set value of a key column is a condition; every other set value is a new value, assigned as in `update`. A condition the hook adds narrows the restore further. Without the values of a key restore fails with `IR_INVALID` before any statement, and so does a new value of a primary key or soft delete column, or a table without `soft_delete`.
- A row that is not deleted is returned unchanged and nothing is written, the new values included. A key that no row has fails with `NO_ROWS`.
- On a table with an `audit` setting the restore is an update like any other: it runs in a transaction with audit values, writes the audit record's key into the audit column, and the triggers record the version in the history table. Without an audit it fails with `CONFIG`.
- Like a soft delete, restore does not assign the `updated` column. The update and the read are two statements; inside a transaction they see one state.

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
- PHP: `\Polyspec\Orm\Tests\Model\connect(url, config)`; the DSN scheme selects the PDO driver.
- Rust: `model::connect(url, pool_size, config).await?`; the DSN scheme selects the sqlx driver.
- TypeScript: `connect(url, options)` of the generated module; the DSN scheme selects the driver package.
- Several connections can be open at once, and `connect` selects one per model, for example reads on `slave1` and writes on `master`.
- SQLite rejects `Lb` and fulltext operators (`OPERATOR_NOT_ALLOWED`).

---

## 10. Operations

| Operation | Command |
|---|---|
| Compare schema with the live database | introspect the database and compare its schema text with the document set ([schema.md](schema.md#_2-schema-operations)) |
| Check generated files | `git diff --exit-code` after the language generator runs |
| Statement events | `subscribe` on the connection; every statement the client sends ([statement events](#statement-events)) |
| Execute a compiled statement, such as a load with its keys | `execute` on the connection ([execute a compiled statement](#execute-a-compiled-statement)) |
| Change every request of a handle before planning | `withRequestHook` on the connection ([request hook](#request-hook)) |
| View SQL without executing | `getQuery()` on a connected model ([dsl.md](dsl.md)) |
| Error constants | `orm-gen errors --lang go\|php\|rust --out …` ([errors.yaml](errors.yaml)) |
| Install a schema | `connection.utils().schema().install(...)` ([schema.md](schema.md#_4-schema-installation)) |
| Add the missing tables, columns and indexes of an installed set | `connection.utils().schema().addTablesAndColumns(...)` ([schema.md](schema.md#_5-adding-tables-and-columns)) |

---


### Statement events

Every client publishes one event for each statement it sends to the database: the statements of models, transaction control, the statements of schema utilities and every other statement of a utility. Subscribers register on the connection. The shared vector `tests/events/vectors.json` runs one sequence on MySQL, PostgreSQL and SQLite and states the events every client publishes.

| Client | Subscribe and unsubscribe | Event |
|---|---|---|
| Go | `unsubscribe, err := db.Subscribe(func(e orm.StatementEvent) error { …; return nil })`; `unsubscribe()` | `orm.StatementEvent{SQL, Binds, Kind, Tables, Elapsed, Transaction, Err}`, `Elapsed` a `time.Duration`, `Transaction` 0 outside a transaction |
| PHP | `$unsubscribe = $db->subscribe(function (Polyspec\Orm\StatementEvent $e): void { … })`; `$unsubscribe()` | `Polyspec\Orm\StatementEvent` with `sql`, `binds`, `kind`, `tables`, `elapsed` (seconds), `transaction` (`?int`), `error` (`?OrmException`) |
| Rust | `let subscription = db.subscribe(\|e: &polyspec_orm::StatementEvent<'_>\| Ok(()))?;`; `subscription.unsubscribe()` | `polyspec_orm::StatementEvent { sql, binds, kind, tables, elapsed, transaction, error }`, `elapsed` a `Duration`, `transaction` an `Option<u64>`, `error` an `Option<&polyspec_orm::Error>` |
| TypeScript | `const unsubscribe = db.subscribe(e => { … })`; `unsubscribe()` | `StatementEvent` with `sql`, `binds`, `kind`, `tables`, `elapsed` (seconds), `transaction` (`number \| null`), `error` (`OrmError \| null`) |

- `sql` is the statement as sent; a relation step carries its expanded `IN` list.
- `binds` are the bound values in order; a secret is `$SECRET` and an executor clock value `$NOW`.
- `kind` comes from the origin of the statement: `select`, `insert`, `update` or `delete` for a model statement, the verb that its plan step writes (a soft delete is `update`); `begin`, `commit`, `rollback`, `savepoint`, `release` and `rollback_to` for transaction control; `schema` for the statements of schema utilities (the catalog reads and the statements of `install` and `addTablesAndColumns`, and the reads of `exists`, `installed` and `empty`); `utility` for every other statement: named locks and row locks, transaction-local values, transaction settings, privileges, AES status and rotation, and the SQLite row-lock table.
- `tables` are sorted and without duplicates. A model statement has the `tables` of its plan step ([protocol](protocol.md#_2-plan)); a schema statement that creates or changes a table names that table; a utility statement on a table names it (`orm__row_lock` for the SQLite row lock, the table of a privilege, the table of an AES status or rotation); transaction control, catalog reads and the other statements name none.
- `elapsed` runs from sending the statement until the client has read its result.
- `transaction` is the number of the transaction on the connection: every outermost begin, including a retry after a deadlock and the SQLite transaction that rebuilds tables with foreign keys off, takes the next number from 1, and every statement from its begin to its commit or rollback carries it; a statement outside a transaction has none.
- `error` is the error the statement ended with, with the code the operation reports; none on success. A failure to decode returned rows is not an error of the statement.

The client calls the subscribers synchronously, in registration order, after the statement ends and before the operation continues. Every handle of the connection (Go `WithContext`, TypeScript `withSignal`, a Rust clone) shares them. With no subscriber the client only finds the list empty. A subscriber must not fail: when one returns an error (Go, Rust) or throws (PHP, TypeScript), the remaining subscribers do not run and the operation fails with `SUBSCRIBER`, whose cause is that error; the statement keeps its effect, and inside a transaction the callback receives the error.

Every client sends the same transaction control statements:

| Dialect | Begin | End |
|---|---|---|
| MySQL | `SET TRANSACTION ISOLATION LEVEL <level>` (`utility`, with an isolation), then `START TRANSACTION` or `START TRANSACTION READ ONLY` | `COMMIT` or `ROLLBACK` |
| PostgreSQL | `BEGIN`, with ` ISOLATION LEVEL <level>` and ` READ ONLY` as the options ask, then `SET LOCAL statement_timeout = <ms>` (`utility`, with `timeoutMs`) | `COMMIT` or `ROLLBACK` |
| SQLite | `BEGIN IMMEDIATE`, or `BEGIN` for a read-only transaction, then `PRAGMA read_uncommitted = 1` and `PRAGMA query_only = 1` (`utility`, as the options ask) | the same `PRAGMA` with 0, then `COMMIT` or `ROLLBACK` |

`<level>` is `READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ` or `SERIALIZABLE`. Before the first transaction of a SQLite connection the client creates the row-lock table with `CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))` outside the transaction. A nested transaction sends `SAVEPOINT orm_sp_<depth>` and `RELEASE SAVEPOINT orm_sp_<depth>`, or after a failed callback `ROLLBACK TO SAVEPOINT orm_sp_<depth>` and then the `RELEASE`. Before the end of a MySQL transaction the client releases its named locks with `SELECT RELEASE_LOCK(?)` and clears its local values with ``SET @`orm.<key>` = NULL`` in key order. When the context or signal of a MySQL or PostgreSQL transaction is cancelled, the client closes the session instead of sending `ROLLBACK`; a cancelled SQLite transaction still resets its `PRAGMA` modes and ends with `ROLLBACK`.

The statements that open a physical connection (session settings such as the time zone, the SQLite version read), the preparation of a statement and protocol-level cancellation are not events.

### Execute a compiled statement

A program that compiles requests itself, such as a load that writes rows with their identity keys and then restarts each identity ([protocol](protocol.md#_1-6-load)), runs each statement with `execute` on the connection: one step of a plan that the client's planner compiled, and the request parameters that its bind slots read.

| Client | Compile | Execute |
|---|---|---|
| Go | `engine.New(model, dialect)` then `Compile(requestJSON)`, or `(&planner.Planner{M: model, D: dialect}).Compile(request)` | `err := db.Execute(&plan.Steps[0], params)` |
| PHP | `(new Polyspec\Orm\Engine($model, $dialect, $cacheSize))->compile($request)` | `$db->execute($plan['steps'][0], $params)` |
| Rust | `polyspec_orm::engine::compile(&manifest, dialect, &request)` | `db.execute(&plan.steps[0], &params).await?` |
| TypeScript | `new Engine(model, dialect).compile(request)` | `await db.execute(plan.steps[0], params)` |
| Python | `Engine(model, dialect).compile(request)` of `polyspec.orm.engine` | `db.execute(plan['steps'][0], params)` |

- The statement runs where a model write runs: on the active transaction of the connection, or on the connection. Its bind slots take their values as a model statement's do: the request parameter with its host styles, a decimal, a SQLite date or time, the AES key and key version from the configuration, the client clock, and the audit of the transaction.
- It publishes its statement event with the kind of its verb, `insert`, `update`, `delete` or `select`, and `schema` for the MySQL `ALTER TABLE` of an identity restart ([statement events](#statement-events)); a driver error has the code a model statement would report.
- A step that reads rows (it has an `assemble`) fails with `IR_INVALID` `execute runs a statement without rows; the statement is a read`, and a `param` slot past the parameters fails with `IR_INVALID` `bind slot <i> reads parameter <p>, but execute has <n> parameters`; neither sends a statement.
- `execute` returns nothing. A load reads back what it needs with a model or a query.
- The PHP extension `orm_dbspec` implements only the dbspec surface and holds no query connection, so it has no `execute`; the PHP client runs both.

### Request hook

`withRequestHook` returns a handle on the same connection whose hook receives each request ([protocol](protocol.md#_1-request)) of the handle right before the client plans it. The hook may add predicates, assignments and parameters; the client gives the hook no meaning of its own.

| Client | Handle | Hook |
|---|---|---|
| Go | `h := db.WithRequestHook(hook)` | `func(r *ir.Request, addParam func(value any) int, params []any) error` of `orm.RequestHook`, which changes `r` in place and reads the bound values in `params`, a copy; `ir` is `github.com/polyspec/orm/packages/go/engine/ir` |
| PHP | `$h = $db->withRequestHook($hook)` | `\Closure(Polyspec\Orm\Request $r): void`, which changes `$r->ir` in place, adds a parameter with `$r->param($value)` and reads the bound values in `$r->params` |
| Rust | `let h = db.with_request_hook(hook);` | `Fn(&mut polyspec_orm::ir::Request, &mut polyspec_orm::RequestParams) -> polyspec_orm::Result<()>`, which changes the request in place, adds a parameter with `params.add(value)` and reads a bound value with `params.get(index)` |
| TypeScript | `const h = db.withRequestHook(hook)` | `(request: Request, addParam: (value: unknown) => number, params: readonly unknown[]) => Request` of `RequestHook`, which returns the request to plan and reads the bound values in `params`, a frozen copy |
| Python | `h = db.with_request_hook(hook)` | `Callable[[IRRequest, Callable[[object], int], tuple], IRRequest]` of `RequestHook`, which returns the request to plan and reads the bound values in the tuple; `IRRequest` is of `polyspec.orm.ir` |

- The handle shares everything of the connection: the pool (the PDO connection in PHP), the plan and statement caches, the statement event subscribers and the active transactions. It keeps the other properties of the handle it was derived from (the Go context, the TypeScript signal), and a handle derived from it with `WithContext` or `withSignal` keeps its hook. A handle carries one hook: `withRequestHook` on a hooked handle returns a handle with the new hook. `Root()` (Go) and `root()` (Python, TypeScript) return the connection.
- The client calls the hook once for each request of a model terminal that runs through the handle: `one` and `all` reads, `count`, `group_count`, `sum` and `avg`, `paginate` (one call for its page and count statements), `insert` with one row or with `rows`, `update`, `delete`, soft delete, `restore`, an insert with `on_duplicate`, and `getQuery`. It also calls it for the requests the client builds for the model: the child deletes of a recursive delete and, in a transaction with audit values that began on the handle, the insert of the audit record. A relation whose child has its own connection runs through that connection. `execute`, the schema utilities and the other utilities send no request and do not call it.
- The hook receives the request after the model built it, the parameters that it binds, read-only, so a hook can check a value that the caller gave, and the means to add a parameter: `addParam(value)` appends value to the request parameters and returns its index. It may change the request in any way the protocol permits, such as a predicate in the `where` of the root, of a join or of a relation, an assignment in `set` with one more parameter in each item of `rows`, or an item of `on_duplicate`. The client then sets `n_params` to the number of parameters and plans the request as any other: the planner validates it, so a parameter index outside the parameters fails with `IR_INVALID` and an unknown column with `COLUMN_UNKNOWN`, before any statement. The plan cache keys on the request, never on values, so two requests that the hook changes alike share one plan whatever values it adds.
- An error of the hook (thrown in PHP, Python and TypeScript, returned in Go and Rust) fails the operation unchanged, before any statement.
- A model runs through the handle it is connected to; inside a transaction, a model without a connection runs through the handle that began the transaction. A row read or created through a hooked handle keeps that handle, so its later `update`, `delete` and `restore` pass the hook. A transaction that begins on a hooked handle keeps the hook for the models of its callback, and a model connected to another handle of the connection inside it runs with the hook of that handle.
- A created row holds the values its caller assigned; a value the hook assigned is written but not read back into the row.
- A handle without a hook plans each request as the model built it, without a copy or a call.
- The shared cases `contracts/fixtures/request_hook.dbs` run in every client on SQLite: a predicate the hook adds filters a read, a count and a page; an assignment it adds is written by a single and a bulk insert; the update and the delete of a loaded row pass the hook; a parameter index outside the parameters fails with `IR_INVALID` before any statement; a handle without a hook reads every row; a restore takes its key from its set values and the condition the hook adds, a condition the hook adds keeps a restore from a row outside it, and a restore whose values and conditions cover no key fails with `IR_INVALID` before any statement.

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
| `CONNECTION_LOST` | The server ended the connection (a killed session, a restart, an idle limit) or it broke; the statement returns this error and is not sent again ([lost connections](config.md#lost-connections)) |
| `ROLLBACK` | The callback of a transaction or savepoint failed and its rollback failed too, for example because the server ended the session; the error keeps both errors and is not retried |
| `FAULT` | A test fault armed through the test entry point of the client reported the rollback of a transaction as failed after the rollback ran; it is the rollback error of a `ROLLBACK` error ([protocol §3.1](protocol.md#_3-1-test-faults)) |
| `CODEC_DECODE` | Stored bytes do not match the declared column styles |

---

## 12. Verification

```sh
make test-servers                                        # MySQL, PostgreSQL, their replicas, ProxySQL, PgBouncer, and the seeded bench databases
. .runtime/servers/env                                   # the DSN variables of the tests
go test ./packages/go/... ./tests/... ./examples/...    # engine, generator, Go client, Go runners and examples
npm run typescript:test                                  # TypeScript client
(cd packages/rust && cargo test --workspace)              # Rust client
node tests/conformance/check/main.mts run --out "$(mktemp -d)/out" --dsn "$BENCH_MYSQL_DSN"   # five clients, identical results on MySQL
node tests/conformance/check/main.mts run --out "$(mktemp -d)/out" --driver postgres --dsn "$BENCH_POSTGRES_DSN"
```

Examples: [`examples/thin-slice`](../examples/thin-slice) (Go, PHP, and Rust, the same JSON) and [`examples/complex`](../examples/complex) (joins, groups, two-level relations, and aggregates).

Rust source analysis separates a fallible model setter result from its model. Error mapping and checked extraction preserve the model; success mapping can return another type. Result operations do not create column methods. Unknown calls on a known model still fail generation.
