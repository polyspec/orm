<!-- doc-id: usage -->
# Usage

Release v0.0.34 is the first release of the Rust core with bindings generated from its interface contract, `packages/rust/interface.json`: TypeScript and Node (`packages/ts`), Python (`packages/python`), the PHP extension (`packages/php-ext`) and Go (`packages/go`). [Generated bindings](#generated-bindings) states what a user of that release has. The hand-written clients are kept under `legacy/packages` and v0.0.34 does not release them ([CORE-1](../spec/core.md)); the sections 1 to 12 describe them, as [Language implementations under legacy/packages](#language-implementations-under-legacy-packages) states.
Supported databases are MySQL 8 by default, PostgreSQL 12+, and SQLite 3.46+.

The complete syntax is in [dsl.md](../spec/dsl.md), the schema language is in [dbspec.md](../spec/dbspec.md), schema tools are in [schema.md](../spec/schema.md), and the IR/Plan format is in [protocol.md](../spec/protocol.md).
Dialect differences are in [dialects.md](../spec/dialects.md), configuration is in [config.md](../spec/config.md), and error codes are in [errors.yaml](../spec/errors.yaml).

---

## Generated bindings

The generated bindings call the Rust core in the process of the caller. Their public names are those of the contract in the spelling of each language: `camelCase` in TypeScript and PHP, `snake_case` in Python, `PascalCase` in Go. Each example of this section names the generated test that holds its call: `packages/ts/generated/tests/generated.test.mjs`, `packages/python/generated/tests/test_generated.py` (class `GeneratedTest`), `packages/php-ext/generated/tests/GeneratedTest.php` and `packages/go/zz_generated_test.go`, which `make bindings` writes. The examples shorten the schema text and the names of the variables of those tests and keep each call as the test has it.

### What the bindings do not have yet

This release is not a replacement of the hand-written packages. [The table of the public surface against the contract](../spec/feature-coverage.md#legacy-surface-against-the-contract) (FCV-21) holds every public member of the hand-written packages with its status; the bindings of v0.0.34 do not have these:

- Generated typed models and the `orm-gen` command. A binding has the class `Query`, which names an entity, a column, a chain and an order by text on a schema that `Schema.load` reads at run time. No binding package holds `orm-gen`, and the crate `polyspec-orm-build` generates Rust models alone.
- Reads of rows by `get` and `gets`: the contract declares neither `get`, `gets`, `getsBy`, `getQuery` and `toArray` nor `Collection`, `Page` and `LookaheadPage`. The reads of a binding are `getBy`, `getCount`, `getCountBy`, `value`, the relations `related` and `relatedRows`, and `StepRunner.run`, which returns the rows of a `get` or a `gets` step as JSON text.
- `utils()`: the statement runner, the lock and the local values (`lock`, `setLocal`, `local`), the schema utilities `register`, `install` and `addTablesAndColumns`, the privileges and the AES rotation. A connection has one schema, the one that `connectSchema` registers; several schemas on one connection have no member.
- The members of a model that [CORE-84](../spec/core.md) names as not implemented: `creates`, `save`, `join` and `leftJoin`, the groups `and(fn)`, `or(fn)`, `not(fn)`, `andNot(fn)`, `orNot(fn)` and `on(fn)`, `and(model)` and `or(model)`, the comparison of two columns, `getsCount`, `getsPage`, `getsLookaheadPage`, `getSum`, `getAvg`, an added column of a function or of a subquery, and a condition on a function.
- The members of a model that no rule of the core names: `getPagePlanSteps`, `duplication`, the optimistic `update(true)`, the recursive `delete(true)`, `orderByRandom`, `parentNode`, `groupLimit`, `deleteLock`, `fetchKey`, `fetchValue`, `possible<Col>`, `forceIndex<Name>`, the increments `plus<Col>` and `minus<Col>`, `new<Name>` with `get<Name>`, `toJSON`, an order by a column function, and the aggregates `groupBy<Col>`, `sum<Col>` and `avg<Col>`.
- Statement events: the core has `subscribe`, and the contract does not declare it, so no binding has it.
- The request hook: the core has `withRequestHook`, and the contract does not declare it, so no binding has it.
- A hook of `beforeTransaction` that does asynchronous work. In Node and WASM a function that the core keeps and that returns a promise is not awaited: the promise is dropped and its rejection reaches no caller. binding refuses a declaration that allows it (`async_allowed` on a kept function), so a hook that must run a statement on another connection cannot be written with a binding yet.
- The end of a statement in progress at a cancellation. `withCancel` derives a handle, and a statement of a handle whose cancellation has fired fails with `canceled` before it is sent. A statement that is in progress when the cancellation fires is not ended on its server: it runs to its end and returns its own result ([CORE-47](../spec/core.md), "Not implemented").
- `StyledValue`: the value of a column with a style leaves the core as an `orm_value`, the untyped value of the contract, and `decode` returns such a value.

`analyzeRestore` is a member of `Db` in this release ([CORE-141](../spec/core.md)): it takes the restore request as JSON text and returns the JSON text of `key` and `assignments`.

```typescript
const analysis = db.analyzeRestore('{"ir_version":2,"manifest_hash":"sha256:f2bb…040a","kind":"restore","entity":"item","n_params":2,"set":[{"column":"id","p":0},{"column":"meta","p":1}]}');
// '{"assignments":["meta"],"key":["id"]}'
// generated test: GN-13e: Db.analyzeRestore primary_key
```
```python
analysis = db.analyze_restore(
    request
)  # generated test: test_gn13e_db_analyze_restore_primary_key
```
```php
$analysis = $db->analyzeRestore($request); // generated test: testGn13eDbAnalyzeRestorePrimaryKey
```

`beforeTransaction` is a member of `Db` in this release ([CORE-143](../spec/core.md)): its hook is a plain function that the core calls with the read-only flag before each transaction, and the member returns an object whose `remove` removes the hook. The hook must not do asynchronous work.

```typescript
const hook = db.beforeTransaction((readOnly) => { /* runs before each transaction; no await */ });
hook.remove();
// generated tests: GN-13e: Db.beforeTransaction a_hook_is_registered_on_the_connection,
// GN-13e: Db.transaction a_hook_is_called_before_the_transaction, GN-13e: BeforeTransactionHook.remove a_registered_hook_is_removed
```

`requireMatch` is a member of `Query` in this release ([CORE-142](../spec/core.md)): an `update`, a `delete` or a `restore` of the query whose statement matched no row then fails with `no_rows`, and `restoreOrCreate` does not take the option.

```typescript
query.requireMatch(); // generated test: GN-13e: Query.requireMatch the_option
```

### Installation

The packages of v0.0.34 are assets of the GitHub Release and are on no registry. Each binding depends on the json library of polyspec at 0.0.34, which no registry holds either, so a consumer names that sibling by the URL of its release asset.

- Node: the package `@polyspec/orm` (`polyspec-orm-0.0.34.tgz`) depends on `@polyspec/json` `0.0.34` by version, and it loads the native library from the platform package of the machine, `@polyspec/orm-darwin-arm64`, `@polyspec/orm-linux-arm64-gnu` or `@polyspec/orm-linux-x64-gnu`. A consumer lists four packages in its own dependencies, each by the URL of its release asset: the orm package, its platform package, `@polyspec/json` and the platform package of json. npm satisfies the version `0.0.34` of `@polyspec/json` with the package installed beside it.

  ```json
  {
    "dependencies": {
      "@polyspec/orm": "https://github.com/polyspec/orm/releases/download/v0.0.34/polyspec-orm-0.0.34.tgz",
      "@polyspec/orm-darwin-arm64": "https://github.com/polyspec/orm/releases/download/v0.0.34/polyspec-orm-darwin-arm64-0.0.34.tgz",
      "@polyspec/json": "https://github.com/polyspec/json/releases/download/v0.0.34/polyspec-json-0.0.34.tgz",
      "@polyspec/json-darwin-arm64": "https://github.com/polyspec/json/releases/download/v0.0.34/polyspec-json-darwin-arm64-0.0.34.tgz"
    }
  }
  ```

  The platform packages of json are `@polyspec/json-darwin-arm64`, `@polyspec/json-linux-arm64-gnu` and `@polyspec/json-linux-x64-gnu` (`polyspec-json-linux-arm64-gnu-0.0.34.tgz`, `polyspec-json-linux-x64-gnu-0.0.34.tgz`).

- Python: the wheel `polyspec-orm` requires `polyspec-json==0.0.34`, and Python 3.14. A consumer installs the json wheel of its platform from the release asset together with the orm wheel:

  ```sh
  uv pip install \
    https://github.com/polyspec/json/releases/download/v0.0.34/polyspec_json-0.0.34-cp314-abi3-macosx_11_0_arm64.whl \
    https://github.com/polyspec/orm/releases/download/v0.0.34/polyspec_orm-0.0.34-cp314-abi3-macosx_11_0_arm64.whl
  ```

  `pip install` takes the same two URLs. The json wheels of Linux are `polyspec_json-0.0.34-cp314-abi3-manylinux_2_34_aarch64.whl` and `polyspec_json-0.0.34-cp314-abi3-manylinux_2_34_x86_64.whl`. `config/binding-python-siblings.txt` holds the json wheel of each platform as a requirement line with its marker and its sha256, such as `polyspec-json @ https://github.com/polyspec/json/releases/download/v0.0.34/polyspec_json-0.0.34-cp314-abi3-macosx_11_0_arm64.whl --hash=sha256:ba29ddb049a60c499f2b8f2777f257c91fdabef826f22e2e229d8c916ae4a31e`; `uv pip install --verify-hashes -r` with that file checks each hash.

- PHP: the extension `polyspec_orm` is the Composer package `polyspec/orm` of type `php-ext`, which PIE installs from the `packages.json` of the release; PIE downloads the binary of the PHP minor (8.4 or 8.5) and the platform. The extension requires `ext-polyspec_json` and `polyspec/json` `0.0.34`, so a consumer adds the repository of that json release too ([packaging](packaging.md#installing-from-release-assets)):

  ```sh
  pie repository:add composer https://github.com/polyspec/json/releases/download/v0.0.34/packages.json
  pie repository:add composer https://github.com/polyspec/orm/releases/download/v0.0.34/packages.json
  pie install polyspec/orm:0.0.34
  ```

- Go: the module is `github.com/polyspec/orm/packages/go`, and it requires `github.com/polyspec/json/packages/go` `v0.0.34`. The tag of the module names a commit that holds the generated files and the static library of the core for each platform (`darwin_arm64`, `linux_amd64`, `linux_amd64_musl`, `linux_arm64`, `linux_arm64_musl`), and a build links the library of its platform through cgo.

  ```sh
  go get github.com/polyspec/orm/packages/go@v0.0.34
  ```

### Connecting and querying

`Schema.load(manifestText, externalText, manifestHash)` reads a schema at run time: the manifest text of the document set, the text of its external documents, which is empty when it has none, and the hash of the manifest text, `sha256:` and the SHA-256 of the text in hexadecimal. A text that is no manifest fails with `schema_invalid` and a text of another hash with `schema_hash_mismatch`.

`Db.connect(dsn, poolSize, config)` opens a pool of at most `poolSize` connections without a schema, and `Db.connectSchema(dsn, schema, poolSize, config)` opens it and registers the schema on it. The DSN has the forms of [Connections](#_4-connections). Node takes the configuration as an object, Python as keyword arguments and PHP as named parameters after the pool size, each with a default.

`Query.new(schema, entity)` names an entity by text, and `connect(db)` gives the query its connection; `connect` returns nothing, and so do `where`, `orderBy`, `limit` and `set`, so the calls do not chain. `where(chain, values)` takes a chain name of [dsl.md](../spec/dsl.md), such as `Id`, `GtId` or `OrGtId`, with one value per key; a name that starts with `And` or `Or` joins its first condition to the conditions before it. `getCount()` returns the count, a `bigint` in Node. `getBy(chain, values)` returns the row as a `Query` of the same entity, or null when no row matches, and `getCountBy(chain, values)` counts with the conditions of the chain joined by `and`. `value(column)` returns the value of a column of a row.

```typescript
import * as orm from '@polyspec/orm';

const schema = orm.Schema.load(manifestText, '', manifestHash);
const db = await orm.Db.connectSchema('sqlite:///var/lib/shop.db', schema, 1, {});

const items = orm.Query.new(schema, 'item');
items.connect(db);
items.where('Id', [100]);
items.where('OrGtId', [0]);
const count = await items.getCount();
// generated test: GN-13e: Query.getCount a_condition_joined_by_or_reads_no_soft_deleted_row
const others = await items.getCountBy('Id', [2]);
// generated test: GN-13e: Query.getCountBy a_condition_joined_by_or_counts_no_soft_deleted_row

const item = orm.Query.new(schema, 'item');
item.connect(db);
const row = await item.getBy('Id', [3]);
// generated test: B-4: Query.getBy a_stored_cell_that_is_not_json
const meta = row.value('meta');
// generated test: B-4: Query.value a_json_cell_with_a_lone_surrogate
```
```python
import polyspec.orm as orm

schema = orm.Schema.load(manifest_text, "", manifest_hash)
db = orm.Db.connect_schema("sqlite:///var/lib/shop.db", schema, 1)

items = orm.Query.new(schema, "item")
items.connect(db)
items.where("Id", [100])
items.where("OrGtId", [0])
count = items.get_count()
# generated test: test_gn13e_query_get_count_a_condition_joined_by_or_reads_no_soft_deleted_row
others = items.get_count_by("Id", [2])
# generated test: test_gn13e_query_get_count_by_a_condition_joined_by_or_counts_no_soft_deleted_row

item = orm.Query.new(schema, "item")
item.connect(db)
row = item.get_by("Id", [3])
# generated test: test_b4_query_get_by_a_stored_cell_that_is_not_json
meta = row.value("meta")
# generated test: test_b4_query_value_a_json_cell_with_a_lone_surrogate
```
```php
$schema = \Polyspec\Orm\Schema::load($manifestText, "", $manifestHash);
$db = \Polyspec\Orm\Db::connectSchema("sqlite:///var/lib/shop.db", $schema, 1);

$items = \Polyspec\Orm\Query::new($schema, "item");
$items->connect($db);
$items->where("Id", [100]);
$items->where("OrGtId", [0]);
$count = $items->getCount();
// generated test: testGn13eQueryGetCountAConditionJoinedByOrReadsNoSoftDeletedRow
$others = $items->getCountBy("Id", [2]);
// generated test: testGn13eQueryGetCountByAConditionJoinedByOrCountsNoSoftDeletedRow

$item = \Polyspec\Orm\Query::new($schema, "item");
$item->connect($db);
$row = $item->getBy("Id", [3]);
// generated test: testB4QueryGetByAStoredCellThatIsNotJson
$meta = $row->value("meta");
// generated test: testB4QueryValueAJsonCellWithALoneSurrogate
```

Go has the same members as functions and methods that return an error: `SchemaLoad`, `DbConnectSchema`, `QueryNew`, `Connect`, `Where`, `GetCount` (generated test `TestGN13eQueryGetCountAConditionJoinedByOrReadsNoSoftDeletedRow`).

```go
schema, err := orm.SchemaLoad(manifestText, "", manifestHash)
db, err := orm.DbConnectSchema("sqlite:///var/lib/shop.db", schema, 1, orm.Config{})
items, err := orm.QueryNew(schema, "item")
err = items.Connect(db)
err = items.Where("Id", []any{int64(100)})
count, err := items.GetCount()
```

`orderBy(spec)` takes the order as one name such as `SeqDescAndLabelAsc`, each key a column and `Asc` or `Desc`, and `limit(offset, count)` reads at most `count` rows after the first `offset` rows. Both arguments of `limit` are unsigned integers, and a `count` of 0 fails with `config` at the next terminal.

```typescript
const events = orm.Query.new(schema, 'clock_event');
events.orderBy('SeqDescAndLabelAsc'); // generated test: GN-13e: Query.orderBy an_order
events.limit(1, 2);                   // generated test: GN-13e: Query.limit a_range
```
```python
events = orm.Query.new(schema, "clock_event")
events.order_by(
    "SeqDescAndLabelAsc"
)  # generated test: test_gn13e_query_order_by_an_order
events.limit(1, 2)  # generated test: test_gn13e_query_limit_a_range
```
```php
$events = \Polyspec\Orm\Query::new($schema, "clock_event");
$events->orderBy("SeqDescAndLabelAsc"); // generated test: testGn13eQueryOrderByAnOrder
$events->limit(1, 2);                   // generated test: testGn13eQueryLimitARange
```

The arguments of these two examples are those of the contract cases `an_order` of `query.order_by` and `a_range` of `query.limit` in `contracts/interface/core.json`. The generated tests of the two cases hold no call yet, because the generator writes no comparison for a member that returns nothing.

`set(column, value)` assigns a value by the column name. `create()` inserts the row and returns it as a `Query`. `update()` and `delete()` take no argument and write the one row of the key that the assigned values give, under the conditions of the query ([CORE-138](../spec/core.md)); `expectRevision(column, revision)` makes the write fail with `revision_changed` when the row holds another revision.

```typescript
const created = orm.Query.new(schema, 'item');
created.connect(db);
created.set('code', 'live');
created.set('qty', 1);
created.set('rev', 1);
const stored = await created.create(); // generated test: B-4: Query.create a_duplicate_key

const changed = orm.Query.new(schema, 'item');
changed.connect(db);
changed.set('id', 1);
changed.set('qty', 2);
changed.expectRevision('rev', 5);
await changed.update();                // generated test: B-4: Query.update a_changed_revision

const removed = orm.Query.new(schema, 'owner');
removed.connect(db);
removed.set('id', 1);
await removed.delete();                // generated test: B-4: Query.delete a_referenced_parent
```
```python
created = orm.Query.new(schema, "item")
created.connect(db)
created.set("code", "live")
created.set("qty", 1)
created.set("rev", 1)
stored = created.create()  # generated test: test_b4_query_create_a_duplicate_key

changed = orm.Query.new(schema, "item")
changed.connect(db)
changed.set("id", 1)
changed.set("qty", 2)
changed.expect_revision("rev", 5)
changed.update()  # generated test: test_b4_query_update_a_changed_revision

removed = orm.Query.new(schema, "owner")
removed.connect(db)
removed.set("id", 1)
removed.delete()  # generated test: test_b4_query_delete_a_referenced_parent
```
```php
$created = \Polyspec\Orm\Query::new($schema, "item");
$created->connect($db);
$created->set("code", "live");
$created->set("qty", 1);
$created->set("rev", 1);
$stored = $created->create(); // generated test: testB4QueryCreateADuplicateKey

$changed = \Polyspec\Orm\Query::new($schema, "item");
$changed->connect($db);
$changed->set("id", 1);
$changed->set("qty", 2);
$changed->expectRevision("rev", 5);
$changed->update();           // generated test: testB4QueryUpdateAChangedRevision

$removed = \Polyspec\Orm\Query::new($schema, "owner");
$removed->connect($db);
$removed->set("id", 1);
$removed->delete();           // generated test: testB4QueryDeleteAReferencedParent
```

The tests that these write and read examples name are cases of a failure: each makes the call of the example on a fixture in which it fails, such as a code that another row holds. The call has the same form when it succeeds.

### Transactions

`db.transaction(callback, options)` runs the callback in a new transaction on a connection of the pool and passes it a transaction handle, a `Tx` ([CORE-20](../spec/core.md)). The callback that returns commits and its value is the result of `transaction`; the callback that fails rolls back and its failure is returned unchanged. The handle is the only way into the transaction, and there is no active transaction of an execution flow:

- A query runs in the transaction after `query.connect(tx)`. A query that was built before the transaction, and a row that was read before it, run in the transaction after the same call. A query with no connection fails with `config`.
- A statement that the callback sends through the `Db` is outside the transaction. The `Db` is the pool, so the statement takes another connection, commits by itself and stays after the transaction rolls back.
- A `db.transaction` inside a callback opens an independent transaction on another connection of the pool. The inner unit of a transaction is `tx.savepoint(callback)`, which passes its callback a handle of the savepoint, a `Tx`, and takes no options ([CORE-21](../spec/core.md)); a failure of that callback rolls back to the savepoint and is returned unchanged.
- One transaction runs one statement at a time: a second statement through the same `Tx` while one has not ended fails with `busy`, and so does a statement through the outer handle while a savepoint callback runs. After the callback returned, the `Tx` and every query connected to it fail with `transaction_ended`.

The options are `isolation` (`read_uncommitted`, `read_committed`, `repeatable_read`, `serializable`), `read_only`, `timeout_ms`, `retry` and `audit`, in Node and PHP `readOnly` and `timeoutMs`. A null option has the value of the core: the isolation level of the server, a transaction that is not read-only, no bound of time, 3 retries and no audit values. `retry` is how many times a transaction that failed with `deadlock` runs again; through a binding only a `deadlock` of the commit is retried ([CORE-104](../spec/core.md)). `audit` is the map from column name to value of [Audited writes](#audited-writes), a `Map` in Node, a `dict` in Python and an array in PHP, and the audit source of the connection is the field `auditSource` of the configuration (`audit_source` in Python).

Every option is a required argument in the bindings of this release: Node takes two arguments, the second an object that holds the five fields; Python takes five keyword arguments; PHP takes six parameters. Defaults of the options are planned together with the refusal of a callback that takes no `Tx`. In this release Node and PHP call a callback that declares no parameter and drop the handle, so its statements through the `Db` are outside the transaction; declare the parameter.

```typescript
const options = { isolation: null, readOnly: null, timeoutMs: null, retry: null, audit: null };

const result = await db.transaction((tx) => 'done', options);
// generated test: GN-13e: Db.transaction a_callback_commits_its_result

const events = orm.Query.new(schema, 'clock_event');
await db.transaction((tx) => { events.connect(tx); return 'done'; }, options);
await events.getCount(); // fails with transaction_ended
// generated test: GN-13e: Db.transaction a_query_connected_to_a_tx_has_ended_after_the_callback

const step = '{"id":1,"role":"main","sql":"INSERT INTO owner (name) VALUES (\'bo\')","tables":[],"bind_slots":[]}';
await db.transaction(async (tx) => {
  await tx.savepoint(async (inner) => { await inner.execute(step, []); return 'done'; });
  return 'done';
}, options);
// generated test: GN-13e: Db.transaction a_statement_runs_in_a_savepoint

await db.transaction(async (tx) => { await db.execute(step, []); throw raised; }, { isolation: null, readOnly: true, timeoutMs: null, retry: null, audit: null });
// the row of step stays: db.execute is outside the transaction
// generated test: GN-6ae: Db.transaction a_row_written_through_the_db_in_a_callback_that_raises_stays
```
```python
def commits(tx):
    return "done"


result = db.transaction(
    commits, isolation=None, read_only=None, timeout_ms=None, retry=None, audit=None
)
# generated test: test_gn13e_db_transaction_a_callback_commits_its_result

events = orm.Query.new(schema, "clock_event")


def connects(tx):
    events.connect(tx)
    return "done"


db.transaction(
    connects, isolation=None, read_only=None, timeout_ms=None, retry=None, audit=None
)
events.get_count()  # fails with transaction_ended
# generated test: test_gn13e_db_transaction_a_query_connected_to_a_tx_has_ended_after_the_callback

step = '{"id":1,"role":"main","sql":"INSERT INTO owner (name) VALUES (\'bo\')","tables":[],"bind_slots":[]}'


def inner(tx):
    tx.execute(step, [])
    return "done"


def outer(tx):
    tx.savepoint(inner)
    return "done"


db.transaction(
    outer, isolation=None, read_only=None, timeout_ms=None, retry=None, audit=None
)
# generated test: test_gn13e_db_transaction_a_statement_runs_in_a_savepoint


def outside(tx):
    db.execute(step, [])
    raise raised


db.transaction(
    outside, isolation=None, read_only=True, timeout_ms=None, retry=None, audit=None
)
# the row of step stays: db.execute is outside the transaction
# generated test: test_gn6ae_db_transaction_a_row_written_through_the_db_in_a_callback_that_raises_stays
```
```php
$result = $db->transaction(function (\Polyspec\Orm\Tx $tx): mixed { return "done"; }, isolation: null, readOnly: null, timeoutMs: null, retry: null, audit: null);
// generated test: testGn13eDbTransactionACallbackCommitsItsResult

$events = \Polyspec\Orm\Query::new($schema, "clock_event");
$db->transaction(function (\Polyspec\Orm\Tx $tx) use ($events): mixed { $events->connect($tx); return "done"; }, isolation: null, readOnly: null, timeoutMs: null, retry: null, audit: null);
$events->getCount(); // fails with transaction_ended
// generated test: testGn13eDbTransactionAQueryConnectedToATxHasEndedAfterTheCallback

$step = "{\"id\":1,\"role\":\"main\",\"sql\":\"INSERT INTO owner (name) VALUES ('bo')\",\"tables\":[],\"bind_slots\":[]}";
$db->transaction(function (\Polyspec\Orm\Tx $tx) use ($step): mixed {
    $tx->savepoint(function (\Polyspec\Orm\Tx $inner) use ($step): mixed { $inner->execute($step, []); return "done"; });
    return "done";
}, isolation: null, readOnly: null, timeoutMs: null, retry: null, audit: null);
// generated test: testGn13eDbTransactionAStatementRunsInASavepoint

$db->transaction(function (\Polyspec\Orm\Tx $tx) use ($db, $step, $raised): mixed { $db->execute($step, []); throw $raised; }, isolation: null, readOnly: true, timeoutMs: null, retry: null, audit: null);
// the row of $step stays: $db->execute is outside the transaction
// generated test: testGn6aeDbTransactionARowWrittenThroughTheDbInACallbackThatRaisesStays
```

In Go the callback is a `func(*orm.Tx) (any, error)` and the options are the struct `orm.TransactionOptions`, whose zero value leaves every option out (generated test `TestGN13eDbTransactionASavepointInTheCallback`).

```go
result, err := db.Transaction(func(tx *orm.Tx) (any, error) {
	return tx.Savepoint(func(inner *orm.Tx) (any, error) { return "done", nil })
}, orm.TransactionOptions{})
```

`transactionActive()` (`transaction_active()` in Python) says whether a handle is the handle of an open transaction ([CORE-140](../spec/core.md)). On a `Tx` it is true while the callback that received the handle runs, and false after that callback returned. On a `Db` it is always false, also inside the callback of a transaction of that `Db`. Code that asked the connection of a hand-written client whether it runs in a transaction receives the `Tx` as an argument, or asks the `Tx` that it holds.

```typescript
await db.transaction((tx) => {
  tx.transactionActive(); // true
  db.transactionActive(); // false
  return 'done';
}, options);
// generated test: GN-13e: Db.transaction a_db_is_not_active_in_the_callback_of_its_transaction
```
```python
def asks(tx):
    tx.transaction_active()  # True
    db.transaction_active()  # False
    return "done"


db.transaction(
    asks, isolation=None, read_only=None, timeout_ms=None, retry=None, audit=None
)
# generated test: test_gn13e_db_transaction_a_db_is_not_active_in_the_callback_of_its_transaction
```
```php
$db->transaction(function (\Polyspec\Orm\Tx $tx) use ($db): mixed {
    $tx->transactionActive(); // true
    $db->transactionActive(); // false
    return "done";
}, isolation: null, readOnly: null, timeoutMs: null, retry: null, audit: null);
// generated test: testGn13eDbTransactionADbIsNotActiveInTheCallbackOfItsTransaction
```

### Errors

An error of a binding is an instance of the class of its category and has the kind of the core as `kind` ([CORE-10 to CORE-12](../spec/core.md)); these classes take the place of `OrmError` and `OrmException` with `code`. The classes are `OrmValueError`, `OrmTypeError`, `OrmIoError`, `OrmStoreError`, `OrmBusyError` and `OrmInternalError` in Node and PHP, and `ORMValueError`, `ORMTypeError`, `ORMIoError`, `ORMStoreError`, `ORMBusyError` and `ORMInternalError` in Python and in the package `errors` of the Go module. `kind` is a property in Node and Python, the method `kind()` in PHP and `Kind()` in Go.

A kind is the lower-case form of a code of [Common errors](#_11-common-errors): `NO_ROWS` is `no_rows`. Four failures that the hand-written clients report as `CONFIG` have a kind of their own, `busy`, `transaction_ended`, `closed` and `pool_timeout`, and `rollback_failed` takes the place of `ROLLBACK`, with the failure of the callback as `callbackError` and the error of the rollback as `rollbackError`. The message of an error is the kind, a colon and the text.

```typescript
try {
  await created.create();
} catch (error) {
  if (error instanceof orm.OrmStoreError && error.kind === 'duplicate_key') { /* the key exists */ }
}
// generated test: B-4: Query.create a_duplicate_key
```
```python
try:
    created.create()
except orm.ORMStoreError as error:
    if error.kind == "duplicate_key":
        pass  # the key exists
# generated test: test_b4_query_create_a_duplicate_key
```
```php
try {
    $created->create();
} catch (\Polyspec\Orm\OrmStoreError $error) {
    if ($error->kind() === "duplicate_key") { /* the key exists */ }
}
// generated test: testB4QueryCreateADuplicateKey
```

---

## Language implementations under legacy/packages

The sections 1 to 12 describe the language implementations of `legacy/packages`: the hand-written clients, and the PHP extension of `legacy/packages/php-ext`. The repository keeps them for their own tests and as the other side of the differential tests ([CORE-1](../spec/core.md)), and v0.0.34 does not release them: the packages `@polyspec/orm`, `polyspec/orm` and `polyspec-orm` of v0.0.34 are the generated bindings above, which hold no `orm-gen`, no generated model and no `utils()`. A package name in the sections below is the package of `legacy/packages`.

The Rust lines of the sections below describe the core crate `polyspec-orm` with the models of `polyspec-orm-build`. Its transactions follow the rules of [Transactions](#transactions) above: `Db::transaction_async(callback, options)` passes the callback a `Tx`, a model runs in the transaction after `connect(&tx)`, and `Db::transaction_active` is always false.

Generate language clients from one dbspec document set. `contracts/implementations.json` declares Go, PHP, PHP extension, TypeScript, Python and Rust as the six implementations; the PHP extension shares the PHP-facing API surface and its unfinished native scope is tracked separately.

A query starts with a generated model and receives an opened database connection through `connect`. Inside a transaction callback, a model without `connect` uses the active transaction.

---

## 1. Requirements

| Requirement | Notes |
|---|---|
| Go 1.27+ | Engine, generator, and Go client |
| MySQL 8.0.2+ / MariaDB 10.2+ | Primary target; PostgreSQL 12+ and SQLite 3.46+ use the same plan |
| PHP 8.4+ (`pdo_mysql`) | Required for PHP; add `pdo_pgsql` and `ext-pgsql` for PostgreSQL, and `pdo_sqlite` for SQLite. PostgreSQL cancellation uses `ext-pgsql`. |
| Rust 1.99+ | Required for Rust |
| Node.js 26.12+ | Required for TypeScript |

```sh
git clone https://github.com/polyspec/orm && cd orm
go build ./legacy/packages/go/... ./tests/... ./examples/...
```

---

## 2. Schema

The human-maintained definition is a set of dbspec documents ([dbspec.md](../spec/dbspec.md)); `contracts/fixtures/bench/bench.dbs` is an example.

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
- Settings give the ORM and the database their behavior: `updated`, `soft_delete`, `aes_version`, `blind_index`, `codec`, `select explicit`, `immutable` and `audit` ([dbspec.md](../spec/dbspec.md#settings), [codec.md](../spec/codec.md)). A column name never selects behavior.
- A foreign key is named; queries name relation keys with `match<L>With<R>`.

[mermaid.md](../spec/mermaid.md) exports a document to a Mermaid `erDiagram` and imports a diagram into a document with the list of what the diagram cannot express.

## 2.1 Create tables and migrate

Each client renders the `CREATE` statements of a document set for one dialect, introspects a database into a document, and applies a chain of migration plans with a lock, history, verification and MySQL recovery. [schema.md](../spec/schema.md#_2-schema-operations) lists the functions of each language, [dialects.md](../spec/dialects.md#rendered-statements) the rendered statements, and [plans.md](../spec/plans.md) the plan documents, the diff and the apply. A rename and the permission to drop are declared in the plan; the diff never infers them.

## 3. Code generation

Each language generates its models with its own build tool. The commands `orm-gen` are those of the packages of `legacy/packages`; no package of v0.0.34 holds one. The generator reads the dbspec document set, embeds its manifest text and `manifestHash`, and writes one model per entity with typed column getters and setters.

Every generator takes the document set as its [set file](../spec/dbspec.md#document-sets), here `contracts/fixtures/bench/dbspec-set.json` beside the documents it lists, and no other form:

```json
{"schema": 1, "documents": ["example.dbs"]}
```

```sh
go run github.com/polyspec/orm/legacy/packages/go/cmd/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --lang go --out model --scan ./...
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
| TypeScript | `orm-gen gen` of the `@polyspec/orm` of `legacy/packages/ts` | the `build` script before `tsc` |
| Python | `orm-gen gen` (Python package) | after the schema or a scanned source changes |
| Rust | the `polyspec-orm-build` crate | `build.rs` on every `cargo build`; `polyspec_orm::models!()` includes the models as the module `model` |

- Every generator declares a typed method for every prefix of every key of a model (the primary key, the unique keys and the indexes), from the schema, whether or not the source named by `--scan` calls it: a single column is its column method, such as `auditSeq` of the index on `audit_seq`, and several columns are the tuple method, such as `tupleAccountSeqWithProjectSeq`. Go, Rust, TypeScript, PHP and Python declare these methods in the generated models; Python and PHP also declare the condition method of every column and the column methods, each typed to return the model, and resolve every other chain name at run time. The scan adds the chain methods that the source calls, and a name that the chain grammar does not accept stops the build. PHP declares in each generated model the methods that the schema enumerates, so that a static analyser such as PHPStan finds them: the condition method of every column, the tuple method of every key prefix of two or more columns, `addColumn<Col>`, `removeColumn<Col>`, `groupBy<Col>`, `keyName<Col>`, `orderBy<Col>Asc` and `orderBy<Col>Desc` of every column, `plus<Col>`, `minus<Col>`, `sum<Col>` and `avg<Col>` of every numeric column, and `forceIndex<Index>` of every index. Each runs the chain of its name, so it builds the query that the chain builds. With `--scan`, PHP also declares as `@method` tags the chain methods that the scanned sources call, and a name that the chain grammar does not accept stops the build ([dsl.md](../spec/dsl.md)). Without `--scan`, PHP resolves every other chain name at call time through `__call`, because the schema does not enumerate it: an operator chain such as `lbName` or `gtSeq`, a chain of several columns such as `seqAndName`, a condition with `and` or `or`, a finder `getBy<Chain>`, `getsBy<Chain>` or `getCountBy<Chain>`, an order of several columns, `join<Pair>`, `leftJoin<Pair>`, `match<Pair>`, `alias<Name>`, `new<Name>`, `possible<Col>`, `addColumn<Name>` of an added column, and `get<Name>` of an added value or relation.
- The generated models depend only on the documents and the scanned sources, not on how a path is written: a scan or output path written relative or absolute, with a `./` component or with a trailing `/` gives the same files, and so does a PHP set file path written relative, absolute or with `./`. Rust `include_str!` names the manifest file by the canonical path of the output directory.
- The TypeScript scan declares a method only for a call whose receiver resolves to a generated model, and declares it on that model. A receiver resolves to a model when it is `new C()` of a generated class `C` (also through an import alias or a namespace import), a variable or parameter bound to a model or typed with a model class, a function or arrow function whose declared return type is a model or, without a declared type, whose expression body or only `return` statement is a model, a chain method of a model, the untyped first parameter of a callback given to `and`, `or`, `on`, `fetchKey`, `fetchValue`, or `addColumn…` of a model, an expression asserted `as C`, a conditional expression `c ? a : b` or a nullish default `a ?? b` whose operands are models (a variable reassigned from one holds every model its operands may be), or a row of a model: the awaited result of `get` or `getBy…`, or an element of a collection of models (the awaited result of `gets` or `getsBy…`, its `values()` or `filter(…)`, a spread copy, or a value typed `Collection<C>` or `C[]`) reached through `for … of`, an index, `first`, `get`, `at`, `find`, or the callback of `map`, `forEach`, `filter`, `find`, `some`, or `every`. A call on any other receiver, such as `this.enabled()` of a class that is not a model, adds no method; give such a receiver a model type when its calls must be typed.
- `orm-gen gen --lang go` writes each scan round into a temporary directory beside `--out` and replaces the generated files of `--out` only after the scan converges; files without the generated header stay. A generation failure leaves `--out` unchanged, and `orm-gen` exits with status 1; the failures include an invalid chain call, a scan that does not converge, a scanned package that cannot be loaded, and generated code that does not compile. When the scan converges but the scanned packages do not compile for another reason, `--out` holds the complete models, and `orm-gen` exits with status 3.
- `--check` compares the output with the existing files without writing: `gen` of the `orm-gen` of each language that has one. The command prints `differs: <path>` for a file whose content differs, `missing: <path>` for a file that does not exist, and `extra: <path>` for a file of the output directory that holds the generated-code comment and that the generation no longer writes, ordered by path, and exits with status 1 when it prints a line. Current files print nothing and exit with status 0. Python writes one file, `models.py`, so its check prints `missing` or `differs` for it and has no `extra` line. Go `gen --check` runs the same scan as `gen` in a directory under the system temporary directory, so the model package keeps the name and import path of `--out`; its generation failures and status 3 are the same as those of `gen`. Rust generates its models in `build.rs` and has no `gen` command.

```sh
go run github.com/polyspec/orm/legacy/packages/go/cmd/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --lang go --out model --scan ./... --check
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

`orm-gen gen --set <dbspec-set.json>` reads the dbspec document set from its set file with `dbspec.ReadSet` and writes `ManifestText`, `ManifestHash` and the schema value `Schema` into the generated `orm.go`; each path of the set file's `external` names an [external document](../spec/dbspec.md#external-documents), whose used tables the generated code carries as `ExternalText` and `Install` checks in the database, without generating their models. `model.Connect(dsn, config)` calls `orm.ConnectSchema(dsn, model.Schema, config)`: it opens the connection and registers the set of the models on it, and a text whose hash differs from `ManifestHash` fails with `CONFIG`. A request of a set that is not registered on its connection fails with `SCHEMA_HASH_MISMATCH` ([protocol](../spec/protocol.md)); `orm.Connect(dsn, config)` opens a connection without any set. `master.Utils().Schema().Install(model.Schema)` registers the set on the connection and renders the document set with the dialect of the connection and applies the statements, triggers included: it creates every table when none of the set exists, changes nothing when all exist, and fails with `CONFIG` when only some exist; then it fails with `CONFIG` naming each difference when the tables of the set in the database differ from the set.

### PHP

```php
$master = \Polyspec\Orm\Tests\Model\connect($masterDsn, new Config(aesKey: $aesKey));
$master->utils()->schema()->register(\Module\Orm\schema());
```

`bootstrap.php` of the generated models defines `MANIFEST_TEXT`, `MANIFEST_HASH`, the schema value `schema()` and the connect helper `connect()`, which opens the connection with `Orm::connectSchema` and registers the set of the models on it; every request carries `manifestHash`. `Orm::connect` opens a connection without any set. `$db->utils()->schema()->register(\Module\Orm\schema())` registers the set of other generated models, here a module set, on the same connection without a statement, so a server that opens a connection per request registers every set it uses on it. `$db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema())` installs the set at deployment, verifies the database and registers the set on the connection. `new Config(poolSize: 1)` keeps one connection per php-fpm worker across its requests instead of connecting in every request ([config](../spec/config.md)); the connection keeps its session settings, and a transaction that an ended request left open is rolled back with its locks and local values.

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

Each client caches plans by request shape. `connection.utils().schema().install(schema)` installs the document set ([schema.md](../spec/schema.md#_4-schema-installation)), and `connection.utils().schema().addTablesAndColumns(schema)` upgrades an installed set to a version that only adds: it creates the tables the database lacks, adds the missing columns of its existing tables that are null or have a default, creates their missing indexes, and returns `SCHEMA_DIFFERS` before any change for every other difference, a missing unique key included, because it can fail on the existing rows and belongs to a plan ([schema.md](../spec/schema.md#_5-adding-tables-and-columns)). Both verify the database when they run; `connection.utils().schema().register(schema)` and the connect helper register a set on each connection without reading the database ([schema.md](../spec/schema.md#_6-schema-registration)).

---

## 5. Reading

Method names are shared; only spelling differs (PHP and TypeScript `camelCase` / Go `PascalCase` / Rust and Python `snake_case`).

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

- Conditions: the first condition has no prefix, following conditions use `and<Chain>`, `or<Chain>`, or `and()` and `or()`, groups use `and(fn)` and `or(fn)`, and negated groups `not(fn)`, `andNot(fn)` and `orNot(fn)`. Operator prefixes, value shapes, and chain rules are in [dsl.md](../spec/dsl.md).
- Finders: `getBy<Chain>`, `getsBy<Chain>`, and `getCountBy<Chain>` apply a column chain, such as `getsByServiceSeqAndIsClose(7, false)`. Go, Rust and TypeScript declare the chains that model generation finds in the scanned code, PHP declares them as `@method` tags when `--scan` is given and otherwise resolves a chain when the call runs, and Python resolves a chain when the call runs; the rule is in [finder chains](../spec/interfaces.md#finder-chains).
- Columns: `addColumn<Col>()`, `removeColumn<Col>()`, `removeAllColumns()`, and `addAllColumns()`. `text`, `blob`, and styled columns are excluded from the default SELECT and added with `addColumn<Col>()`.
- Rust generated model fields are private. Reading a column that was neither selected nor assigned returns `COLUMN_UNSELECTED`; an omitted value is never presented as SQL NULL or a default.
- PHP generated model getters also return `COLUMN_UNSELECTED` when a non-styled column was neither selected nor assigned; selected SQL NULL and explicitly assigned values remain readable.
- Terminals: `get` returns one row and null when no row matches; no read raises an error for an empty result. `gets` returns a collection, which is empty when no row matches. `getCount` returns a count.
- A collection is an ordered map keyed by PK or `keyName<Col>()`: `first()`, `count()`, and `toArray()` are available, and iteration yields `key => row`.
- `toArray()` returns the rows as a list of maps in collection order: Go `rows.ToArray()`, Rust `rows.to_array()`, PHP `$rows->toArray()`, TypeScript `rows.toArray()`, and Python `rows.to_array()`. Iteration keeps the keys and their types.

### Aggregates and groups

```php
(new Author)->connect($slave1)->serviceSeq(7)->groupByUserSeq()->getsCount();   // rows per user with row_count
(new Author)->connect($slave1)->serviceSeq(7)->sumLikeCount()->getSum();       // sum of like_count
(new Author)->connect($slave1)->serviceSeq(7)->avgPrice()->getAvg();           // average price
```
Negated groups, column function outputs, subquery columns, and ORM function values are specified in [dsl.md](../spec/dsl.md).
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
| `parentNode()` | Merge one-relation columns into the parent row; parent values win ([protocol](../spec/protocol.md#_1-2-joins-and-relations)) |
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
- `creates(rows, batch)` inserts the rows in batches of `batch` rows, each batch one multi-row INSERT, in one transaction, and returns the inserted row count; the caller chooses `batch`, and the client never splits a batch. `batch` is a required positive integer, otherwise `CONFIG`; a batch whose binds (rows times columns) exceed the bind limit, 999 on SQLite and 65535 on MySQL and PostgreSQL, is `BATCH_TOO_LARGE`, whose message names the batch, its bind count and the limit; both fail before any statement.
- Transactions use `connection.transaction(fn)`. A callback error or exception rolls back the transaction, and deadlocks are retried.
- Calling `transaction` on the same connection inside an active transaction creates a savepoint. An inner failure rolls back only the inner work unless the outer callback returns it.
- Two transactions that must be open at the same time need two connections, because a second transaction on one connection becomes a savepoint of the first. Lock contention is written that way: one connection holds the row and another waits for it.
- Transaction options select `isolation`, `readOnly`, and `timeoutMs`. The supported isolation names are `default`, `read_uncommitted`, `read_committed`, `repeatable_read`, and `serializable`. PostgreSQL applies transaction settings after `BEGIN`; MySQL applies them before `START TRANSACTION` on the retained connection. SQLite applies `readOnly` through `PRAGMA query_only` and maps portable isolation modes to its transaction connection; the ORM restores connection state before commit or rollback. A positive `timeoutMs` applies PostgreSQL `statement_timeout`; MySQL and SQLite return `CAPABILITY_UNSUPPORTED`.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, and `forShareNoWait()` are allowed only inside a transaction. MySQL and PostgreSQL execute the selected row lock; `NoWait` fails immediately when the row is unavailable. SQLite emits no lock suffix and uses an ORM transaction-scoped database lock row for all four modes. A SQLite write transaction takes the database write lock when it begins, so a lock request inside it succeeds without waiting, and the lock wait happens when the transaction begins ([runtime connection](../spec/config.md)).
- `Db::withCancellation($source)` derives a PHP cancellation handle. PostgreSQL connections require both `pdo_pgsql` and `ext-pgsql`; the latter sends cancellation through the same connection. `timeoutMs` also limits PostgreSQL statements.
- A test makes the rollback of a transaction fail on every database with the test fault of its client, which a production build does not contain or load ([protocol §3.1](../spec/protocol.md#_3-1-test-faults)): Go `orm.FailNextRollback(db)` with `-tags ormtest`, Rust `polyspec_orm::testing::fail_next_rollback(&db)` with the feature `test-faults`, TypeScript `failNextRollback(db)` of `@polyspec/orm/testing` under `node --conditions=orm-test`, and PHP `Polyspec\Orm\Testing\Faults::failNextRollback($db)` after `require 'vendor/polyspec/orm/testing/Faults.php'`. The next transaction whose callback fails is rolled back and returns `ROLLBACK` with the callback error and a `FAULT` error.
- A test makes the next statement of a connection fail with a given code and message on every database with the statement fault of its client ([protocol §3.2](../spec/protocol.md#_3-2-test-statement-fault)): Go `orm.FailNextStatement(db, code, message)` with `-tags ormtest`, Rust `polyspec_orm::testing::fail_next_statement(&db, kind, message)` with the feature `test-faults`, TypeScript `failNextStatement(db, code, message)` of `@polyspec/orm/testing` under `node --conditions=orm-test`, PHP `Polyspec\Orm\Testing\Faults::failNextStatement($db, $code, $message)`, and Python `polyspec.orm.testing.fail_next_statement(db, code, message)`. The statement is not sent; the client reports it as `OrmException` with that code and message, and the fault is consumed by that statement.

```go
err := master.Transaction(func() error {
    row, err := model.Author().SetName("x").….Create()
    if err != nil {
        return err
    }
    authorSeq, err := row.GetSeq()
    if err != nil {
        return err
    }
    _, err = model.AuthorLog().SetAuthorSeq(authorSeq).Create()
    return err
})
```
```php
$row = $master->transaction(fn () => (new Author)->setName('x')->…->create());
```
```rust
let row = master.transaction_async(|tx| async move { Author::new().connect(&tx).set_name("x")./*…*/.create().await }, Default::default()).await?;
```

### Audited writes

A table with an `audit` setting ([audit](../spec/dbspec.md#audit)) is written only inside a transaction that records its unit of work in the audit record table, the table that the setting names with `references`. Two places give the record its values:

- The connection configuration takes `auditSource` once per process ([configuration](../spec/config.md)): a function that returns the audit values of the current request, a map from column name to value of the audit record table, such as the account and the request id. The ORM writes no audit value of its own.
- The `audit` option of a transaction holds the values of this change, a map from column name to value (Go `orm.Audit(map[string]any)`, PHP `audit:` array, Rust `audit` of the `TransactionOptions` of `Db::transaction_async`, TypeScript `{ audit: {...} }`). An empty map records the source's values alone.

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
```typescript
const master = await connect(dsn, { auditSource: () => ({ account_seq: currentRequest().accountSeq, request_id: currentRequest().id }) });
await master.transaction(async () => {
  await new Service().setName('renamed').create();
}, { audit: { action: 'service.rename', reason } });
```

- A transaction with `audit` calls the source once, before it begins, and right before its first write of an audited table, in every attempt of a retried transaction, inserts one row into the audit record table with the source's values and its own, where a value of the transaction wins over the source's value of the same column. Every insert, update, soft delete and restore of an audited table in the transaction writes that row's primary key (the generated identity, or the given value) into the table's audit column, and the database triggers copy each version into the history table. A transaction that writes no audited row inserts no audit row: reads leave none, and a first update, delete or restore that matches no row rolls its audit row back with a savepoint. A failed callback, or a savepoint that rolls back the first audited write, rolls the audit row back with the changes, and the next audited write inserts it again.
- The audit record table is the one table that the `references` of the audited tables of the sets registered on the connection name, and it is a table of a set registered on the connection; no such table, several of them, or a primary key of more than one column fail with `CONFIG`. The transaction fails with `CONFIG` before it begins when the connection has no audit source, a value of the source or the transaction names a column that the audit record table does not have, or no value is given at all; an error of the source fails the transaction with that error.
- A write of an audited table outside a transaction with `audit` fails with `CONFIG`. A nested transaction uses the audit of the outer one and does not take `audit`; a request that assigns the audit column itself fails with `IR_INVALID`.
- With `tables` on the setting ([audit](../spec/dbspec.md#audit)), the triggers also write one row for each audited table that the transaction changed into the tables table, such as `audit_table (audit_seq, table_name)`. It is an ordinary table of the audit set, so its generated model reads it, and a join from the audit record filters and pages the audits of a table: `(new Audit)->connect($db)->ltSeq($last)->joinSeqWithAuditSeq((new AuditTable)->tableName('service'))->orderBySeqDesc()->limit(0, 20)->gets()`, and `getCount()` of the same chain counts them; the primary key `(audit_seq, table_name)` gives one joined row per audit. A table that no audit changed matches no row: an empty list, a count of 0, and null for a single row, as any read.

### Restore a soft-deleted row

A delete of a table with a `soft_delete` setting keeps the row and its unique key values, and reads never return it, so inserting the same key again fails with `DUPLICATE_KEY`. `restore()` brings such a row back: set the values of the primary key or of one unique key on a new model, and any new values of other columns, and call `restore()`. It sends the set values as the request's `set`; the planner picks the key after the request hook, which may add conditions to the restore as to an `update`. It writes the new values and clears the soft delete column with one `UPDATE` ([protocol](../spec/protocol.md#_1-5-restore)), reads the row by the values of that key with the default select set and returns it as a loaded model.

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


A hook can call `db.analyzeRestore(request)` before it accepts new values
([INT-191](../spec/interfaces.md), [PRT-91](../spec/protocol.md)). The result
contains the selected `key` columns and the new `assignments` columns. PHP
passes `$r->ir` from its request hook. The analysis uses the same classifier
as the planner and changes no request; assignment legality is checked later
by ordinary write validation. It sends no statement and may run in a hook
or an existing transaction. Do not infer the selected key from whichever
set columns happen to be present.

### Restore or create a row

`restoreOrCreate()` gives a key of a table with a `soft_delete` setting its row whatever state the key is in: set the values of the primary key or of one unique key on a new model, and the other values of the row, as for `restore()`.

```go
row, err := model.Membership().Connect(master).SetTeamId(1).SetMemberId(2).SetRole("owner").RestoreOrCreate()
```
```php
$row = (new Membership)->connect($master)->setTeamId(1)->setMemberId(2)->setRole('owner')->restoreOrCreate();
```
```python
row = (
    Membership()
    .connect(master)
    .set_team_id(1)
    .set_member_id(2)
    .set_role("owner")
    .restore_or_create()
)
```
```rust
let row = Membership::new().connect(&master).set_team_id(1).set_member_id(2).set_role("owner").restore_or_create().await?;
```
```typescript
const row = await new Membership().connect(master).setTeamId(1).setMemberId(2).setRole('owner').restoreOrCreate();
```

- It runs in one transaction, and its key is the one `restore()` picks. A soft-deleted row that holds the key is restored with the set values, as `restore()` restores it, audit included, and returned.
- A key that no row holds is created with the set values, as `create()` creates a row, and the created row is returned. Another unique key that an existing row already holds fails with `DUPLICATE_KEY`, as for `create()`.
- A row that holds the key and is not deleted fails with `ROW_NOT_DELETED`, and nothing is written, the set values included: the caller decides whether to update it.
- Its statements are the restore step, the read of the key and, for a key that no row holds, the insert; the conformance vector `restore_or_create` fixes them and their results on MySQL, PostgreSQL and SQLite. A table without `soft_delete` fails with `IR_INVALID`, as for `restore()`.

## 8. Styled columns

`gz_*`, `json_*`, `jsons_*`, `base64_*`, and `serialize_*` use **decoded values**, not stored bytes, at the client output
(Go `any` · Rust `serde_json::Value` · PHP `mixed`). MySQL handles `aes_hex_*` and `ip` with SQL functions, while
PostgreSQL and SQLite executors produce the same bytes ([codec.md](../spec/codec.md)).

```php
$b->setJsonSetting(['a' => 1])->connect($master)->update();
$b = (new Author)->connect($slave1)->addColumnJsonSetting()->getBySeq(42);   // excluded from the default SELECT
$b->getJsonSetting()['a'];
```

---

## 9. Multiple databases

The same statement produces the same result on all three databases, although statement text differs by dialect. Rules and exceptions are in [dialects.md](../spec/dialects.md).

`connection.utils().schema().install(...)` renders the document set with the dialect of the connection ([schema.md](../spec/schema.md#_4-schema-installation)).

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
| Compare schema with the live database | introspect the database and compare its schema text with the document set ([schema.md](../spec/schema.md#_2-schema-operations)) |
| Check generated files | `git diff --exit-code` after the language generator runs |
| Statement events | `subscribe` on the connection; every statement the client sends ([statement events](#statement-events)) |
| Execute a compiled statement, such as a load with its keys | `execute` on the connection ([execute a compiled statement](#execute-a-compiled-statement)) |
| Change every request of a handle before planning | `withRequestHook` on the connection ([request hook](#request-hook)) |
| Refuse an action outside the database while a transaction is active | `transactionActive()` on the connection (Go `TransactionActive`, Python `transaction_active`); true inside a transaction of the connection in the calling flow, sends no statement ([INT-192](../spec/interfaces.md)). The Rust core and the generated bindings answer for the handle ([Transactions](#transactions)) |
| Run code before a transaction begins, such as a write on another connection | `beforeTransaction(hook)` on the connection (Go `BeforeTransaction`, Python `before_transaction`; the Rust core `before_transaction` and `before_transaction_async`, [CORE-143](../spec/core.md)); the hook runs before each outermost transaction of `transaction`, before it takes a connection or sends a statement, and returns a function that removes it ([INT-193](../spec/interfaces.md)) |
| View SQL without executing | `getQuery()` on a connected model ([dsl.md](../spec/dsl.md)) |
| View the statements of a page without executing | `getPagePlanSteps(page, perPage)` on a connected model ([dsl.md](../spec/dsl.md)) |
| Error constants | `orm-gen errors --lang go\|php\|rust\|typescript\|python --out …` ([errors.yaml](../spec/errors.yaml)) |
| Install a schema | `connection.utils().schema().install(...)` ([schema.md](../spec/schema.md#_4-schema-installation)) |
| Add the missing tables, columns and indexes of an installed set | `connection.utils().schema().addTablesAndColumns(...)` ([schema.md](../spec/schema.md#_5-adding-tables-and-columns)) |

---


### Statement events

Every client publishes one event for each statement it sends to the database: the statements of models, transaction control, the statements of schema utilities and every other statement of a utility. Subscribers register on the connection. The recipe `statement_events` runs one sequence on MySQL, PostgreSQL and SQLite and states the events every client publishes.

| Client | Subscribe and unsubscribe | Event |
|---|---|---|
| Go | `unsubscribe, err := db.Subscribe(func(e orm.StatementEvent) error { …; return nil })`; `unsubscribe()` | `orm.StatementEvent{SQL, Binds, Kind, Tables, Elapsed, Transaction, Err}`, `Elapsed` a `time.Duration`, `Transaction` 0 outside a transaction |
| PHP | `$unsubscribe = $db->subscribe(function (Polyspec\Orm\StatementEvent $e): void { … })`; `$unsubscribe()` | `Polyspec\Orm\StatementEvent` with `sql`, `binds`, `kind`, `tables`, `elapsed` (seconds), `transaction` (`?int`), `error` (`?OrmException`) |
| Rust | `let subscription = db.subscribe(\|e: &polyspec_orm::StatementEvent<'_>\| Ok(()))?;`; `subscription.unsubscribe()` | `polyspec_orm::StatementEvent { sql, binds, kind, tables, elapsed, transaction, error }`, `elapsed` a `Duration`, `transaction` an `Option<u64>`, `error` an `Option<&polyspec_orm::Error>` |
| TypeScript | `const unsubscribe = db.subscribe(e => { … })`; `unsubscribe()` | `StatementEvent` with `sql`, `binds`, `kind`, `tables`, `elapsed` (seconds), `transaction` (`number \| null`), `error` (`OrmError \| null`) |

- `sql` is the statement as sent; a relation step carries its expanded `IN` list.
- `binds` are the bound values in order; an executor clock value is `$NOW`.
- `kind` comes from the origin of the statement: `select`, `insert`, `update` or `delete` for a model statement, the verb that its plan step writes (a soft delete is `update`); `begin`, `commit`, `rollback`, `savepoint`, `release` and `rollback_to` for transaction control; `schema` for the statements of schema utilities (the catalog reads and the statements of `install` and `addTablesAndColumns`, and the reads of `exists`, `installed` and `empty`); `utility` for every other statement: named locks and row locks, transaction-local values, transaction settings, privileges, AES status and rotation, and the SQLite row-lock table.
- `tables` are sorted and without duplicates. A model statement has the `tables` of its plan step ([protocol](../spec/protocol.md#_2-plan)); a schema statement that creates or changes a table names that table; a utility statement on a table names it (`orm__row_lock` for the SQLite row lock, the table of a privilege, the table of an AES status or rotation); transaction control, catalog reads and the other statements name none.
- `elapsed` runs from sending the statement until the client has read its result.
- `transaction` is the number of the transaction on the connection: every outermost begin, including a retry after a deadlock and the SQLite transaction that rebuilds tables with foreign keys off, takes the next number from 1, and every statement from its begin to its commit or rollback carries it; a statement outside a transaction has none.
- `error` is the error the statement ended with, with the code the operation reports; none on success. A failure to decode returned rows is not an error of the statement.

The client calls the subscribers synchronously, in registration order, after the statement ends and before the operation continues. Every handle of the connection (Go `WithContext`, TypeScript `withSignal`, a Rust clone, Python `with_request_hook`) shares them. With no subscriber the client only finds the list empty. A subscriber must not fail: when one returns an error (Go, Rust) or throws (PHP, TypeScript, Python), the remaining subscribers do not run and the operation fails with `SUBSCRIBER`, whose cause is that error; the statement keeps its effect, and inside a transaction the callback receives the error.

Every client sends the same transaction control statements:

| Dialect | Begin | End |
|---|---|---|
| MySQL | `SET TRANSACTION ISOLATION LEVEL <level>` (`utility`, with an isolation), then `START TRANSACTION` or `START TRANSACTION READ ONLY` | `COMMIT` or `ROLLBACK` |
| PostgreSQL | `BEGIN`, with ` ISOLATION LEVEL <level>` and ` READ ONLY` as the options ask, then `SET LOCAL statement_timeout = <ms>` (`utility`, with `timeoutMs`) | `COMMIT` or `ROLLBACK` |
| SQLite | `BEGIN IMMEDIATE`, or `BEGIN` for a read-only transaction, then `PRAGMA read_uncommitted = 1` and `PRAGMA query_only = 1` (`utility`, as the options ask) | the same `PRAGMA` with 0, then `COMMIT` or `ROLLBACK` |

`<level>` is `READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ` or `SERIALIZABLE`. Before the first transaction of a SQLite connection the client creates the row-lock table with `CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))` outside the transaction. A nested transaction sends `SAVEPOINT orm_sp_<depth>` and `RELEASE SAVEPOINT orm_sp_<depth>`, or after a failed callback `ROLLBACK TO SAVEPOINT orm_sp_<depth>` and then the `RELEASE`. Before the end of a MySQL transaction the client releases its named locks with `SELECT RELEASE_LOCK(?)` and clears its local values with ``SET @`orm.<key>` = NULL`` in key order. When the context or signal of a MySQL or PostgreSQL transaction is cancelled, the client closes the session instead of sending `ROLLBACK`; a cancelled SQLite transaction still resets its `PRAGMA` modes and ends with `ROLLBACK`.

The statements that open a physical connection (session settings such as the time zone, the SQLite version read), the preparation of a statement and protocol-level cancellation are not events.

### Execute a compiled statement

A program that compiles requests itself, such as a load that writes rows with their identity keys and then restarts each identity ([protocol](../spec/protocol.md#_1-6-load)), runs each statement with `execute` on the connection: one step of a plan that the client's planner compiled, and the request parameters that its bind slots read.

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
- The PHP extension of `legacy/packages/php-ext` implements only the dbspec surface and holds no query connection, so it has no `execute`; the PHP client runs both. The generated PHP extension of `packages/php-ext` has `execute` on `Db` and on `Tx`.

### Request hook

Python SQL connections can derive a cancellation handle with `db.with_future(future)`, where `future` is an `asyncio.Future`. Cancelling that future interrupts the statement in flight on the derived handle and reports `CANCELED`; completing it normally does not affect the connection. Python database calls are synchronous, so run a cancellable call with `asyncio.to_thread`. A cancelled transaction still runs its rollback before the pooled connection is reused. The derived handle remains cancelled; use the root `db` for later work. On a markdown connection, cancelling the future closes the connection of the statement in flight (CFG-9).

`withRequestHook` returns a handle on the same connection whose hook receives each request ([protocol](../spec/protocol.md#_1-request)) of the handle right before the client plans it. The hook may add predicates, assignments and parameters; the client gives the hook no meaning of its own.

| Client | Handle | Hook |
|---|---|---|
| Go | `h := db.WithRequestHook(hook)` | `func(r *ir.Request, addParam func(value any) int, params []any) error` of `orm.RequestHook`, which changes `r` in place and reads the bound values in `params`, a copy; `ir` is `github.com/polyspec/orm/legacy/packages/go/engine/ir` |
| PHP | `$h = $db->withRequestHook($hook)` | `\Closure(Polyspec\Orm\Request $r): void`, which changes `$r->ir` in place, adds a parameter with `$r->param($value)` and reads the bound values in `$r->params` |
| Rust | `let h = db.with_request_hook(hook);` | `for<'a> Fn(&'a mut polyspec_orm::ir::Request, &'a mut polyspec_orm::RequestParams) -> polyspec_orm::HookFuture<'a>`, whose future the client awaits: it changes the request in place, adds a parameter with `params.add(value)` and reads a bound value with `params.get(index)`, as in `\|r, p\| Box::pin(async move { ...; Ok(()) })` |
| TypeScript | `const h = db.withRequestHook(hook)` | `(request: Request, addParam: (value: unknown) => number, params: readonly unknown[]) => Request \| Promise<Request>` of `RequestHook`, which returns the request to plan, or a promise of it that the client awaits, and reads the bound values in `params`, a frozen copy |
| Python | `h = db.with_request_hook(hook)` | `Callable[[IRRequest, Callable[[object], int], tuple], IRRequest]` of `RequestHook`, which returns the request to plan and reads the bound values in the tuple; `IRRequest` is of `polyspec.orm.ir` |

- The handle shares everything of the connection: the pool (the PDO connection in PHP), the plan and statement caches, the statement event subscribers and the active transactions. It keeps the other properties of the handle it was derived from (the Go context, the TypeScript signal), and a handle derived from it with `WithContext` or `withSignal` keeps its hook. A handle carries one hook: `withRequestHook` on a hooked handle returns a handle with the new hook. `Root()` (Go) and `root()` (Python, TypeScript) return the connection.
- The client calls the hook once for each request of a model terminal that runs through the handle: `one` and `all` reads, `count`, `group_count`, `sum` and `avg`, `paginate` (one call for its page and count statements), `insert` with one row or with `rows`, `update`, `delete`, soft delete, `restore`, an insert with `on_duplicate`, and `getQuery`. It also calls it for the requests the client builds for the model: the child deletes of a recursive delete and, in a transaction with audit values that began on the handle, the insert of the audit record. A relation whose child has its own connection runs through that connection. `execute`, the schema utilities and the other utilities send no request and do not call it.
- The hook receives the request after the model built it, the parameters that it binds, read-only, so a hook can check a value that the caller gave, and the means to add a parameter: `addParam(value)` appends value to the request parameters and returns its index. It may change the request in any way the protocol permits, such as a predicate in the `where` of the root, of a join or of a relation, an assignment in `set` with one more parameter in each item of `rows`, or an item of `on_duplicate`. The client then sets `n_params` to the number of parameters and plans the request as any other: the planner validates it, so a parameter index outside the parameters fails with `IR_INVALID` and an unknown column with `COLUMN_UNKNOWN`, before any statement. The plan cache keys on the request, never on values, so two requests that the hook changes alike share one plan whatever values it adds.
- The client plans the request after the hook has returned, and awaits the promise or future of the hook in TypeScript and Rust (INT-78). A hook can so run a statement on another connection, a second `Db`, before the client plans the request, for instance to read inside a transaction the rows that the request will write; in Go, PHP and Python the hook does it as any synchronous call.
- An error of the hook (thrown in PHP, Python and TypeScript, returned in Go and Rust, or the rejection of its promise or the error of its future) fails the operation unchanged, before any statement.
- A dynamic `Query` of the Rust core that a member already failed (a deferred `config`, such as a name that is no column) is refused at its terminal before its request is built, so neither the request hook nor the request log of `Db::with_request_log` receives it ([CORE-190](../spec/core.md)).
- A model runs through the handle it is connected to; inside a transaction, a model without a connection runs through the handle that began the transaction. A row read or created through a hooked handle keeps that handle, so its later `update`, `delete` and `restore` pass the hook. A transaction that begins on a hooked handle keeps the hook for the models of its callback, and a model connected to another handle of the connection inside it runs with the hook of that handle.
- A created row holds the values its caller assigned; a value the hook assigned is written but not read back into the row.
- A handle without a hook plans each request as the model built it, without a copy or a call.
- The shared cases `contracts/fixtures/request_hook/request_hook.dbs` run in every client on SQLite: the hook reads the value of an INSERT assignment without changing the value written; a predicate the hook adds filters a read, a count and a page; an assignment it adds is written by a single and a bulk insert; the update and the delete of a loaded row pass the hook; a parameter index outside the parameters fails with `IR_INVALID` before any statement; a handle without a hook reads every row; a restore takes its key from its set values and the condition the hook adds, a condition the hook adds keeps a restore from a row outside it, and a restore whose values and conditions cover no key fails with `IR_INVALID` before any statement.

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
| `WRITE_CONFLICT` | A `COMMIT` on a markdown connection found a file of the corpus changed outside the engine since the transaction read it; it names the file and line. It is never retried, even with retry options, unlike `DEADLOCK` |
| `CANCELED` | The statement stopped before it finished: a cancellation, a timeout bound, or a SQLite lock that another connection still held when `busy_timeout` ended; it is not retried |
| `READ_ONLY` | A write reached a read-only server or connection: a replica, a read-only transaction, or a SQLite database opened read-only; send the write through the primary connection |
| `CONSTRAINT` | A CHECK constraint refused the row; the error keeps the driver message and the driver error |
| `DRIVER` | Any other driver error, such as a write that an `audit` or `immutable` trigger refuses; the error keeps the driver message and the driver error as its cause |
| `CONNECTION_LOST` | The server ended the connection (a killed session, a restart, an idle limit) or it broke; the statement returns this error and is not sent again ([lost connections](../spec/config.md#lost-connections)) |
| `ROLLBACK` | The callback of a transaction or savepoint failed and its rollback failed too, for example because the server ended the session; the error keeps both errors and is not retried |
| `FAULT` | A test fault armed through the test entry point of the client reported the rollback of a transaction as failed after the rollback ran; it is the rollback error of a `ROLLBACK` error ([protocol §3.1](../spec/protocol.md#_3-1-test-faults)) |
| `CODEC_DECODE` | Stored bytes do not match the declared column styles |

---

## 12. Verification

```sh
make orm-test-servers                                        # MySQL, PostgreSQL, their replicas, ProxySQL, PgBouncer, and the seeded bench databases
# The servers stay up while this shell runs (its owner, ORM_SERVERS_OWNER); in a shell of one command, run make orm-test-servers <targets>
. .runtime/servers/env                                   # the DSN variables of the tests
go test ./legacy/packages/go/... ./tests/... ./examples/...    # engine, generator, Go client, Go runners and examples
npm run typescript:test                                  # TypeScript client
make test-rust                                           # Rust client
make conformance-check                                   # the native conformance bodies
make orm-install-bay                                         # for CI: install the release of bay that config/containers.json pins into var/tools/bay; changes nothing of the machine. A run takes the bay of PATH
make orm-install-bay-machine                                 # bay install and bay check -scope run: the machine setup of bay, which asks for the rights it needs
make orm-install-container-images                            # pull the images of config/containers.json with bay pull; the only target that downloads an image
make orm-test-container KIND=mysql                           # a MySQL primary and its replica as a Compose project of bay, from the image of config/containers.json; needs bay, and the image on this machine
. .runtime/containers/mysql.env                              # its DSN variables; a target that reads TEST_ENV takes TEST_ENV=.runtime/containers/mysql.env, MariaDB MARIADB_ENV
make orm-test-container-stop                                 # remove the projects of this checkout and their data, the project of a killed run included
make orm-test-container-run KIND=mysql RUN='make test-rust'  # start the servers for this run alone, run RUN with their variables on this host, and remove them when RUN ends, fails or gets SIGINT or SIGTERM
make orm-test-container-run KIND=mysql FORM=runner RUN='make test-rust'  # the same as two jobs of bay in the runner, from a clone of the commit; the machine runs one job at a time; KEEP=1 keeps the directory with its tools and its build
make orm-test-container-run KIND=mysql FORM=runner BUILD='<build command>' RUN='make test-rust' CARGO_BUILD_JOBS=<count> RUNNER_MEMORY=<size> SERVER_MEMORY=<size>  # build in the job build, before the servers start; the jobs of cargo and the memory limits are given for the machine
make orm-test-container-remote KIND=mysql,postgres,sqlite RUN='make client-db-check' HOST=<ssh host> REMOTE=<directory>  # several kinds in one run: the servers of each kind and the variables of each in one servers.env
make orm-test-container-remote KIND=mysql RUN='make test-rust' HOST=<ssh host> REMOTE=<directory> CACHE=/srv/polyspec/gate/cache  # the downloads of the tools (rustup, the CARGO_HOME of cargo, Go modules and build cache, npm, Composer) in a directory there that outlives the runs; the clone and the target directory stay in the run
make orm-test-container-remote KIND=mysql RUN='make test-rust' HOST=<ssh host> REMOTE=<directory>  # the run in the runner on another machine, whose host has sh and bay alone: its jobs run there and are waited for there through ssh; a job that has not ended keeps the directory there and ends with 3; started again, it queues nothing twice and waits again; PULL=1 pulls the images there
```

The container servers are a Compose project of `bay` (CONTRIBUTING.md, "Test database servers in containers"). When a start fails, read its output first: it holds the output of `bay up` and the last lines of each service. `bay status` lists the projects that run on the machine; a project of this checkout is named `orm-<checkout>-<run>` and its files are in `.runtime/containers/<project>`. The file `run.sh` of that directory executes the run with `sh` and `bay` alone: `sh run.sh` is the whole run, `sh run.sh up` and `sh run.sh down` start and remove the servers. A run in the runner is two jobs, which `bay job list` lists with their results; a run on another machine leaves its report in `.runtime/containers/reports/<project>` (`job-<part>.json`, `job-<part>.log`, `check.log`, `status`). `bay check -scope run` names a part of the machine setup that is missing, which `bay install` applies; this repository runs neither `bay install` nor a command that changes the machine setup.

Examples: [`examples/thin-slice`](../../examples/thin-slice) (Go · PHP · Rust, the same JSON) and [`examples/complex`](../../examples/complex) (joins, groups, two-level relations, and aggregates).

Rust source analysis separates a fallible model setter result from its model. Error mapping and checked extraction preserve the model; success mapping can return another type. Result operations do not create column methods. Unknown calls on a known model still fail generation.
