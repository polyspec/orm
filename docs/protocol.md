<!-- doc-id: protocol -->
# IR and Plan protocol

A client renders the model built with the [DSL](dsl.md) into the request below, plans it in the calling process, and caches the plan by the request shape. The type definitions in `engine/ir/ir.go` and `engine/plan/plan.go` are authoritative; every client implements the same fields.

## 1. Request

```json
{
  "ir_version": 1,
  "manifest_hash": "sha256:27675b7fddd99bfdcb47f88bd4050552b25c1c345d84908a29b1b6d339d91322",
  "kind": "one | all | count | group_count | sum | avg | paginate | insert | update | delete | restore | restart_identity",
  "entity": "author",
  "columns": Columns,
  "where": Group,
  "joins": [Join],
  "relations": [Relation],
  "order": [Order],
  "group_by": ["user_seq"],
  "limit": {"offset": 0, "count": 20},
  "force_index": "ix_service",
  "lock": "update | share | update_nowait | share_nowait",
  "agg": "read_count",
  "load": true,
  "set": [Assign],
  "rows": [[4, 5], [6, 7]],
  "on_duplicate": [Assign],
  "optimistic": {"column": "updated_ts", "p": 3},
  "n_params": 8
}
```

Values never appear in the request. Every value is a parameter index into the client's parameter list, and `n_params` is the length of that list. The plan is therefore independent of values.

| Field | Rule |
|---|---|
| `manifest_hash` | the `manifestHash` of the document set the generated code carries: `sha256:` followed by 64 lower-case hexadecimal digits ([manifest and hashes](dbspec.md#manifest-and-hashes)). A request whose hash differs from the model the client loaded fails with `SCHEMA_HASH_MISMATCH`. The field replaces `schema_hash`; the error code keeps its name |
| `kind` | `one` and `all` read rows, `count` counts rows or groups, `group_count` returns grouped rows with `row_count`, `sum` and `avg` aggregate `agg`, `paginate` returns the page statement and a count statement, `insert`, `update`, and `delete` write rows, `restore` clears the soft delete column of one deleted row ([restore](#_1-5-restore)), and `restart_identity` restarts the identity of a table past its largest key ([load](#_1-6-load)) |
| `load` | `insert` writes rows with their stored keys: it takes a value for the identity column ([load](#_1-6-load)) |
| `set` | assignments of `insert` and `update` |
| `rows` | parameters of each additional inserted row in the column order of `set`; every `set` item is then a value assignment and `on_duplicate` is not allowed |
| `on_duplicate` | assignments applied when an inserted row meets an existing unique key |
| `optimistic` | `update` matches only when the column still equals the parameter; no match returns `OPTIMISTIC_LOCK` |
| `lock` | root row selection only; the client allows it only inside a transaction |

`Query` is the shape shared by the root, a join child, a relation child, and a subquery: `entity`, `columns`, `on` (join child only), `where`, `joins`, `relations`, `order`, `group_by`, `limit`, `force_index`, `lock`, and the relation options.

`group_by` is valid only on the root of a `count` (the number of groups) and of a `group_count`; on any other kind, and in a join child, a relation child or a subquery, the request fails with `IR_INVALID`. A grouped row has no value for a column outside the group, so no other kind could name its output in all three databases.

### 1.1 Columns

```json
Columns = {
  "mode": "" | "all" | "none",
  "add": ["name"],
  "remove": ["description"],
  "fn": {"created_date": {"column": "created_ts", "fn": Func}},
  "sub": {"read_total": Sub}
}
```

- `mode` `""` selects the default select set, every column except those of `select explicit` ([runtime model](dbspec.md#runtime-model)); `all` selects every column, and `none` keeps primary and foreign keys.
- `fn` and `sub` add named outputs. An output name must not be a column of the entity.
- The primary key and the keys that relations bind are always selected.

### 1.2 Joins and relations

```json
Join = {"rel": "service_model", "kind": "inner | left", "left": "service_seq", "right": "seq", "query": Query}
Relation = {"rel": "writer", "kind": "one | many", "keys": [{"left": "user_seq", "right": "seq"}], "query": Query,
            "key_by": "user_seq", "flatten": false, "limit_per_parent": 2,
            "if_parent": {"column": "is_close", "p": 4}, "no_cascade_delete": false}
```

- `rel` is the result name. In a join, `left` is a column of the parent and `right` a column of the child; both are required. A relation requires `kind` and `keys`, one `{"left", "right"}` pair per key component in key order, so a relation over a composite foreign key carries every component: `composite_membership` loads from `composite_account` with `[{"left": "tenant_id", "right": "tenant_id"}, {"left": "account_id", "right": "account_id"}]`. An empty `keys`, a pair without `left` or `right`, or a column that appears in two pairs on the same side is `IR_INVALID`. The client never infers keys from names or foreign keys.
- A join child's `on` group is added to the `ON` clause. Its `where` group is placed where a `joined` item names it, otherwise it is appended to the parent `WHERE` with `AND`.
- A relation runs as a separate statement. `limit_per_parent` limits child rows per parent key, `if_parent` loads the child only for parents whose column equals the parameter, `flatten` merges the child columns into the parent row, `key_by` keys the child collection by a non-null column of the child (a nullable column is `IR_INVALID`, since a NULL key has no answer that every language shares), and `no_cascade_delete` excludes the relation from recursive delete.

### 1.3 Groups and predicates

```json
Group = {"conn": "and | or", "not": true, "items": [Item]}
Item  = {"pred": Pred} | {"group": Group} | {"joined": {"conn": "and | or", "join": "service_model"}}
Pred  = {"conn", "column", "op", "p"}                                   // eq not_eq gt gte lt lte contains contains_binary
      | {"conn", "column", "op": "in | not_in | between", "ps": [...]}
      | {"conn", "column", "op": "is_null | is_not_null"}
      | {"conn", "column", "op": "eq_col | not_eq_col | gt_col | gte_col | lt_col | lte_col", "ref": {"path": "service_model", "column": "seq"}}
      | {"conn", "op": "tuple_in | tuple_not_in", "cols": ["tenant_id", "account_id"], "ps": [0, 1, 2, 3]}
      | {"conn", "column", "op": "in | not_in", "sub": Sub}
      | {"conn", "column", "op", "p", "fn": Func}
      | {"conn", "column", "op", "value": Func}
Func  = {"name": "day_of_week | year | month | date | now | today | days_ago | …", "ps": [0]}
Sub   = {"query": Query, "column": "user_seq", "agg": "sum | avg | count"}
```

- `conn` joins an item to the previous item of its group; the first item has none. A first item with `or` fails with `OR_AT_GROUP_START` and with `and` with `IR_INVALID`; a top-level `where` or `on` group has no previous sibling, so its own `conn` fails with `IR_INVALID`.
- `ref.path` is the join path from the statement root (`""` is the root, `a/b` a nested join) or `^`, the model that owns a subquery. A relation and a subquery are statements of their own, so their `""` is their own root. Validation resolves every ref, also in a relation or subquery that the request kind does not render: a path through a name that is not joined fails with `ENTITY_NOT_JOINED`, `^` outside a subquery with `IR_INVALID`, and a column that the target model lacks with `COLUMN_UNKNOWN`.
- The shared cases of `tests/ir/validate.json` pin the validation rules: every client reads the file from its own package (Go from `engine/ir`) and passes each request to its validator alone. The PHP extension `orm_dbspec` implements only the dbspec surface (`packages/orm-php-extension/stubs/orm_dbspec.stub.php`) and has no request validator; a PHP program validates and plans requests through `Polyspec\Orm\Validator` of the PHP client.
- `fn` applies a column function to `column` before the comparison with `p`. `value` compares `column` with a value function. Functions are structure only; each dialect renders them as described in [dialects](dialects.md), and an unknown name returns `FUNCTION_UNKNOWN`.
- The two columns of a column comparison, of a column `in` or `not_in` a subquery column, of a join's `left` and `right` and of each relation key pair meet as dbspec check operands do ([dbspec](dbspec.md)): integers with integers, `decimal` of one scale, `f64`, `bool`, `varchar` and `text` together, `uuid`, `date`, `time` or `datetime` of one precision, and `bytes` with `bytes`; any other pair fails with `OPERATOR_NOT_ALLOWED`, because the databases then disagree (PostgreSQL refuses `integer = varchar`, MySQL coerces, SQLite compares by affinity).
- A column comparison (`eq_col` and the others) is allowed when its base operator (`eq` for `eq_col`) is one of the left column's type and neither column has a codec, so `bool gt_col`, `bytes gt_col` and an `aes` column's `eq_col` fail with `OPERATOR_NOT_ALLOWED`; two columns whose only codec is `ip` take `eq_col` and `not_eq_col`, because both sides are the dialect's same stored form.
- `not` negates a nested group, which renders `NOT (…)`; a top-level `where` or `on` group with `not` fails with `IR_INVALID`.
- The request carries no SQL text: every condition, output, order, grouping and assignment is one of the forms above, and every bind slot of the plan has a dbspec type.
- `contains` and `contains_binary` bind the value between wildcards; `contains_binary` compares case-sensitively.

### 1.4 Order and assignments

```json
Order  = {"column": "seq", "desc": true} | {"column": "start_dt", "fn": Func} | {"random": true}
Assign = {"column", "p"} | {"column", "null": true} | {"column", "plus_p"} | {"column", "minus_p"}
```

With `group_by`, an order item names a group column, a function of one, or `random`; any other column fails with `IR_INVALID` ("order by %s, which is not a group column"), because a group has no single value for it (MySQL 1055, PostgreSQL 42803, an arbitrary row on SQLite).

`minus_p` never stores a negative value.

An `update` that assigns a primary key or identity column fails with `IR_INVALID` ("cannot update %s"), and so does a `restore` that assigns one or the soft delete column, which it clears itself; the validator refuses it, not only the planner, so an IR executor that does not plan sees the same rule.

An `insert` assigns by `p` or `null`: `plus_p` and `minus_p` are `IR_INVALID` in its `set` and valid in `on_duplicate` and in `update`, because a `VALUES` list has no current row to read, and MySQL reads the column's default there (3 + 5 = 8) while PostgreSQL and SQLite refuse the statement.

An `insert` that omits a column with a default leaves it to the database default; the planner adds no value for it. An `insert` that omits a non-null column without a default fails with `IR_INVALID`. The planner assigns the columns the executor owns: the AES key version, the `updated` column on every `update`, and on a table with an `audit` setting the audit column of every `insert`, `update`, soft delete, restore and duplicate update; a request that assigns the AES key version or the audit column fails with `IR_INVALID`.

### 1.5 Restore

A `restore` request names one soft-deleted row of a table with a `soft_delete` setting ([dbspec](dbspec.md#settings)). Its `where` holds only `eq` predicates with a parameter, joined by `and`, that name every column of the primary key or of one unique key once, in any order. Its `set` holds the new values written with the restore, under the rules of an `update` assignment; a primary key, identity or soft delete column assignment fails with `IR_INVALID`. It has no `optimistic`. The plan is one `main` step:

```sql
UPDATE `link` SET `note` = ?, `deleted_at` = NULL, `audit_seq` = ? WHERE `link`.`team_id` = ? AND `link`.`member_id` = ? AND `link`.`deleted_at` IS NOT NULL
```

The step writes the new values, clears the soft delete column and, on a table with an `audit` setting, writes the audit column; like a soft delete it does not assign the `updated` column. A row that is not deleted and a missing row match no row, so the statement changes nothing, the new values included. A request on a table without `soft_delete`, a predicate of another form, a column outside the key or a key that is named only in part fails with `IR_INVALID`. Reads always exclude soft-deleted rows; `restore` is the only request that matches one. The model method `restore` runs the step and then reads the row by the same key ([usage](usage.md#restore-a-soft-deleted-row)).

### 1.6 Load

Loading rows that already exist elsewhere into a database (a rebuild or an export) must keep their keys, which other rows reference. An ordinary `insert` refuses a value for the identity column, because the database generates every identity key ([dsl](dsl.md)). A load writes the keys itself and then restarts each identity:

- An `insert` with `"load": true` takes a value for the identity column. On a table with an identity column, its `set` assigns that column a parameter (`p`); a load that leaves it out fails with `IR_INVALID` `load of <entity> needs a value for the identity column <column>`, and one that assigns it `null` fails as any `null` for a non-null column does. Every other rule and the statement are those of an `insert`, `rows` included; a load of a table without an identity column is an ordinary `insert`. `load` on another kind or with `on_duplicate` fails with `IR_INVALID` `load is only valid on insert without on_duplicate`. A request without `load` that assigns the identity column still fails with `cannot set identity column <column>`.
- A `restart_identity` request names one entity and nothing else: a `set`, `rows`, `on_duplicate`, `where` or `optimistic` fails with `IR_INVALID` `restart_identity takes no set, rows, on_duplicate, where or optimistic`, and an entity without an identity column fails with `IR_INVALID` `restart_identity of <entity>, which has no identity column`. Its plan is one `main` step without bind slots whose `tables` is the table. After it the next generated key is the largest key of the table plus one, or 1 for an empty table, also when the counter stood past it:

| Dialect | Statement |
|---|---|
| MySQL | ``ALTER TABLE `load_probe` AUTO_INCREMENT = 1``: InnoDB sets a value at or below the largest key to the largest key plus one |
| PostgreSQL | `SELECT setval(pg_get_serial_sequence('"load_probe"', 'seq'), COALESCE(MAX("seq"), 0) + 1, false) FROM "load_probe"` |
| SQLite | `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX("seq"), 0) FROM "load_probe") WHERE name = 'load_probe'`; a table that never took a row has no `sqlite_sequence` row, and its next key is already past its largest key |

PostgreSQL identity does not advance past an explicit key, so without the restart the next generated key collides with a loaded one; MySQL and SQLite advance their counters past an explicit key, and the restart gives every dialect the same next key. The MySQL statement is DDL, which commits an open transaction, so a load runs the restart after its rows are committed. A client runs both with its execute call ([usage](usage.md#execute-a-compiled-statement)); the shared cases `contracts/fixtures/identity_load.json` state the statements, the errors and the keys after a load on MySQL, PostgreSQL and SQLite.

## 2. Plan

```json
{
  "manifest_hash": "sha256:…", "kind": "all",
  "steps": [
    {"id": 0, "role": "main", "sql": "SELECT `a`.`seq` AS `a__seq`, … FROM `author` AS `a` … LIMIT 0, 20", "tables": ["author", "service"],
     "bind_slots": [{"from": "param", "param": 0}, {"from": "secret", "name": "aes"}],
     "assemble": {"entity": "author", "alias": "a",
                  "columns": [{"index": 0, "name": "seq", "column": "seq", "type": "i64"}],
                  "key": [{"column": "seq", "index": 0}],
                  "children": [{"rel": "service_model", "kind": "join", "assemble": {…}}]}},
    {"id": 1, "role": "relation", "sql": "…", "tables": ["user"], "bind_slots": [{"from": "parent"}], "parent": {"step": 0, "keys": [{"column": "user_seq", "index": 14}]}}
  ]
}
```

- `tables` lists the tables that the statement names, sorted and without duplicates: the target table of a write, the root table of a select, its joined tables and the tables of its subqueries; a relation step lists its own.
- `bind_slots.from` is `param` (a request parameter, with `transform` for contains values and `host_styles` for AES, hex, and IP stages), `secret` (the AES key), `config` (the AES key version), `parent` (relation key values), `now` (the client clock in UTC), or `audit` (the primary key of the transaction's audit record, with `name` the audit record table). A write that has an `audit` slot and runs outside a transaction with audit values, or in one whose audit record is a row of another table than `name`, fails with `CONFIG` before it reaches the database.
- **Clock.** This is the one clock rule; [dialects](dialects.md) and [plans](plans.md) refer to it. Every connection reads and writes `datetime(p)` in UTC. The `now` slot is the client wall clock in UTC with microsecond resolution, truncated to six fraction digits, in the `datetime` text form; a statement reads the clock once, so its `now` slots are equal. A clock that the ORM writes or compares keeps microseconds: the update time and soft deletion assign the clock with the declared fraction digits of the column, `CURRENT_TIMESTAMP(p)` on MySQL for `p > 0`, `CURRENT_TIMESTAMP` on PostgreSQL and the `now` slot on SQLite; the MySQL `now` value function and its relative forms use `NOW(6)`, and PostgreSQL `now()`. SQLite has no clock with microseconds, so the SQLite dialect binds the `now` slot for the update time, soft deletion and the `now` function, renders a relative form as `datetime` of a `now` slot with the interval followed by the six fraction digits of a second `now` slot, and binds the `now` slot for every column with `default now` that an insert omits; MySQL and PostgreSQL inserts leave such a column to its database default. The plan history keeps the tool clock with six fraction digits ([plans](plans.md#apply)).
- Rows are read by position. `assemble.columns[].styles` lists the codec stages the client decodes; SQL-side stages are already applied.
- `assemble.key` is the collection identity: every primary-key component, or the group columns of a `group_count` row.
- A `group_count` row retains the declared types of its selected group columns; a boolean group value is a JSON boolean, and an invalid database boolean fails decoding.
- `children[].kind` is `join` for a child in the same row, and `one` or `many` for a relation step matched by `parent_keys` and `child_keys`.

### 2.1 Relation steps

- Each relation has one `relation` step after its parent step; nested relations follow the same rule, and `paginate` orders the steps as main, relations, count.
- The client reads the parent keys of every parent row in order, removes rows with a null key, removes duplicates, and skips the statement when no key remains. With `if_parent`, only parents whose column equals the parameter are used.
- The `parent` slot is one placeholder that the client expands to the key list. The list is padded to a power of two by repeating the last key, so one prepared statement serves each size class. A list longer than the driver bind limit is split into chunks.
- `one` attaches the first child row and `many` a collection in child order; a duplicate collection key keeps the last row.

## 3. Errors

Errors carry a code from [errors.yaml](errors.yaml) and a message, for example `IR_INVALID`, `SCHEMA_HASH_MISMATCH`, `COLUMN_UNKNOWN`, `OPERATOR_NOT_ALLOWED`, `FUNCTION_UNKNOWN`, `EMPTY_IN`, `LIMIT_IN_RELATION`, and `COLUMN_ALIAS_CONFLICT`. Executors add `CONFIG`, `OPTIMISTIC_LOCK`, `LOCK_NOT_AVAILABLE`, `DEADLOCK`, `DUPLICATE_KEY`, `FOREIGN_KEY`, `CONSTRAINT`, `READ_ONLY`, `CONNECTION_LOST`, and `DRIVER`. The client returns every driver error as an ORM error: a condition that the catalog lists has its code, every other driver error has `DRIVER`, and each keeps the driver message and the driver error as its cause. A connection that the server ended or that broke is `CONNECTION_LOST` in every client, and no client matches a message text to decide it ([config](config.md#lost-connections)). A write that an `audit` or `immutable` trigger refuses is `DRIVER`. When the callback of a transaction or savepoint fails and its rollback fails too, the client returns one error with the code `ROLLBACK`; its message names both errors, and it keeps the callback error and the rollback error (PHP: the previous exception and `rollback`, TypeScript: `cause` and `rollback`, Go: `errors.Join` of both in that order, Rust: `Error::Rollback { callback, rollback }`, Python: `cause` and `rollback`). A `ROLLBACK` error is not retried. A NOWAIT lock failure is always `LOCK_NOT_AVAILABLE` and is not retried as a transaction conflict.

### 3.1 Test faults

A test makes the rollback of a transaction fail deterministically on every database through the test entry point of its client; a production process cannot arm the fault. The entry point arms a rollback fault on the connection of a handle, and every handle of that connection shares it. The next rollback of a transaction whose callback failed runs as usual, so the database discards the transaction, and the client then reports the rollback as failed with a `FAULT` error: the transaction returns one `ROLLBACK` error that keeps the callback error and the `FAULT` error. A commit, a savepoint rollback, and a rollback after a failed begin or commit do not consume the fault; it stays armed until a transaction rollback after a failed callback consumes it, and the next transaction whose callback fails returns its callback error alone.

The fault exists only in the test entry point of each client. No DSN, configuration value, or environment variable arms it.

| Client | Entry point | How a production build excludes it |
|---|---|---|
| Go | `orm.FailNextRollback(db)` | The file is compiled only with the build tag `ormtest` (`go test -tags ormtest`); without the tag the function does not exist and a call does not compile |
| Rust | `polyspec_orm::testing::fail_next_rollback(&db)` | The module is compiled only with the cargo feature `test-faults`, which no default feature enables; it is enabled in `[dev-dependencies]` |
| TypeScript | `failNextRollback(db)` of `@polyspec/orm/testing` | The package exports the subpath only under the condition `orm-test`; without `node --conditions=orm-test` the import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, and the package entry point does not export the function. A type check of the test resolves the subpath with `customConditions: ["orm-test"]` |
| PHP | `Polyspec\Orm\Testing\Faults::failNextRollback($db)` | The class is in `testing/Faults.php` of the package, which the package autoloader does not map; a process has it only after it requires that file by its path |
| Python | `polyspec.orm.testing.fail_next_rollback(db)` | The package `polyspec.orm.testing` is in the distribution, as the PHP class is in the package, and no module of `polyspec.orm` imports it; a process has it only after it imports `polyspec.orm.testing` by that name, and the package entry point `polyspec.orm` does not export the function |

### 3.2 Test statement fault

A test makes the next statement of a connection fail deterministically with a given error code and message, through the test entry point of each client, which is the same entry point as the rollback fault ([3.1](#_3-1-test-faults)). The entry point arms the fault on the connection of a handle, and every handle of that connection shares it. The arguments are the database, the `code`, a code of [errors.yaml](errors.yaml), and the `message`, a nonempty text. An empty `code` or `message` is refused with the programmer-error signal of the client and arms nothing: a panic in Go and Rust, a `TypeError` in TypeScript, an `InvalidArgumentException` in PHP, and a `ValueError` in Python.

The next statement that the connection runs for the caller, a model read or write, a query, a schema statement (including the SQLite `foreign_keys` pragma that a table rebuild sets and restores around its statements), a session value, or a named-lock acquire or release, is not sent to the database. The client reports it as an `OrmException` with the given code and message, at the same statement end that a driver error takes, so the statement event of that statement carries the error. The database is unchanged by the refused statement, and the fault is consumed by it. The statements of the transaction machinery do not consume it: `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`; the settings that a transaction applies when it begins (isolation, read-only, statement timeout, `read_uncommitted`, `query_only`); the locals and settings that it restores when it ends; and the statements of the SQLite row-lock table: its creation, its row insertion, and the `busy_timeout` change that brackets the insertion. Arming a fault while another statement fault is armed replaces it. A refused statement does not consume the rollback fault of [3.1](#_3-1-test-faults), and a rollback does not consume the statement fault.

The fault exists only in the test entry point of each client. No DSN, configuration value, or environment variable arms it.

| Client | Entry point | How a production build excludes it |
|---|---|---|
| Go | `orm.FailNextStatement(db, code, message)` | The same file as `FailNextRollback`, compiled only with the build tag `ormtest` |
| Rust | `polyspec_orm::testing::fail_next_statement(&db, code, message)` | The same module as `fail_next_rollback`, compiled only with the cargo feature `test-faults` |
| TypeScript | `failNextStatement(db, code, message)` of `@polyspec/orm/testing` | The same subpath as `failNextRollback`, exported only under the condition `orm-test` |
| PHP | `Polyspec\Orm\Testing\Faults::failNextStatement($db, $code, $message)` | The same class as `failNextRollback`, in `testing/Faults.php`, which the package autoloader does not map |
| Python | `polyspec.orm.testing.fail_next_statement(db, code, message)` | The same package as `fail_next_rollback`, which no module of `polyspec.orm` imports |

The statement fault is armed on a `Db` and counts the statements that the `Db` runs. The dbspec apply, recover, rollback, finalize and introspection of every implementation run on the driver connection that the caller passes, outside the `Db`, so they do not consume it: Go `engine/dbspec/apply.go:138,159,200,282` (`Execer`) and `engine/dbspec/introspect.go:37` (`Querier`); Rust `packages/orm-rust/orm/src/dbspec/apply.rs:296,313,331,347` (`ApplyConnection`) and `packages/orm-rust/orm/src/dbspec.rs:52` (`CatalogQuerier`); TypeScript `packages/orm-npm/src/dbspec/apply.ts:720,737,768,820` (`Connection`) and `packages/orm-npm/src/dbspec/introspect.ts:33`; Python `packages/orm-python/src/polyspec/orm/dbspec/apply.py:703,718,743,802` and `packages/orm-python/src/polyspec/orm/dbspec/introspect.py:16` (`Connection`); PHP `packages/orm-php/src/Dbspec/PlanApply.php:102,118,149,212` and `packages/orm-php/src/Dbspec/Dbspec.php:161,588` (`\PDO`); the PHP extension `orm_dbspec` `packages/orm-php-extension/stubs/orm_dbspec.stub.php:553,591,594,597,600` (`\PDO`), implemented in `packages/orm-php-extension/src/apply.c` and `introspect.c`.

## 4. Planning in the client

Every client validates and plans requests in the calling process. No compiler service, daemon, or extension is involved.

| Client | Validation, planning, dialects, and DDL |
|---|---|
| Go | `engine/ir`, `engine/planner`, `engine/dialect`, `engine/dbspec` DDL |
| PHP | `packages/orm-php/src/Validator.php`, `Planner.php`, `Dialect.php`, `Dbspec/Renderer.php` DDL |
| Rust | `packages/orm-rust/orm/src/engine/`, `packages/orm-rust/orm-schema/src/dbspec/` DDL |
| TypeScript | `packages/orm-npm/src/engine/`, `packages/orm-npm/src/dbspec/` DDL |

Generated code carries the manifest text of its document set and its `manifestHash`. The client builds the runtime model from that text once and rejects text whose hash differs from the declared one (`SCHEMA_HASH_MISMATCH`). The plan cache key is the manifest hash and the request shape. Parameter values are not part of the key.

A process can load the generated code of several document sets, and one connection can serve several of them. A connection plans a request only with a set registered on that connection, because what a request can run against is decided by the database the connection uses, not by the code the process loaded. A set is registered on a connection in three ways. `utils().schema().register(schema)` registers the set on the connection. The connect helper of generated code (Go `model.Connect(dsn, config)`, PHP `Polyspec\Orm\Tests\Model\connect($dsn, $config)`, Rust `model::connect(dsn, pool_size, config)`, TypeScript `connect(dsn, options)` of the generated module) opens the connection and registers its own set the same way through `connectSchema` (Go `orm.ConnectSchema`, PHP `Orm::connectSchema`, Rust `Db::connect_schema`, TypeScript `Db.connectSchema`). `utils().schema().install(schema)` creates the tables of the set, verifies the database and registers the set on the same connection. All three take the generated schema value, the manifest text with its declared `manifestHash` (Go `model.Schema`, PHP `Polyspec\Orm\Tests\Model\schema()`, Rust `model::SCHEMA`, TypeScript `SCHEMA`), and fail with `CONFIG` before any statement when the text does not hash to the declared hash. Registering reads and writes nothing in the database, for sets with external documents too: the database is verified when the set is installed or upgraded (`install`, `addTablesAndColumns`), not on each connection, so a connection opened per request registers its sets without a statement ([schema](schema.md#_6-schema-registration)). A raw connection (`connect(dsn, …)` of the client) registers no set, and loading generated code registers nothing on a connection. A request whose manifest is not registered on its connection fails with `SCHEMA_HASH_MISMATCH` before execution, also when a plan of the same shape is cached, and so does a request of generated code whose manifest text does not hash to its declared `manifestHash`. No other registration call exists. Every client follows this rule.

The four planners produce the same SQL and bind slots for the same request. `tests/conformance` runs the same vectors in the four clients on MySQL, PostgreSQL, and SQLite and compares the statements, binds, and results with the recorded expectations.

## 5. IR executors

A DSN scheme may select an IR executor instead of a SQL dialect. The scheme `markdown://` selects the flowmark executor, which runs requests on a markdown corpus served by a flowmark server ([capability table](dialects.md#markdown-ir-executor)). Section 4 applies to SQL dialects only.

- **Connection.** The DSN is `markdown://127.0.0.1:<port>/<corpus>?token=<token>`: the port that `flowmark serve` listens on, on loopback TCP only; the corpus root's directory name; and the token that the server keeps in `.flowmark/server.json` of the corpus. The DSN takes no other parameter, and another host, a missing port, a path that is not one name or a missing token is `CONFIG` before any connection opens. A connection of the client is one TCP connection to the server, and the client keeps them as it keeps database connections ([configuration](config.md)): a pool of them, or, in the PHP client, which keeps no pool, the one connection of each `Db`.
- **Wire.** A message is one JSON object on one line, and the server answers the messages of a connection in order, each with one line. A message with `op` is a control message, any other a request message. The first message of a connection is `{"op": "connect", "corpus": <corpus>, "token": <token>}` with the DSN's corpus and token, answered `{"ok": true}`; the server answers a corpus or token that differs, or any other first message, `CONFIG` and closes the connection, so connecting fails with that `CONFIG`.
- **Validation.** The client validates each request with `ir.Validate` and does not plan it. It sends no SQL and reads no plan; the executor plans and runs the request.
- **Message.** Each request is one message `{ir_version, manifest_hash, request, params, now}`. `request` is the request of section 1 with the same fields and values as parameter indexes, `manifest_hash` is checked as in section 1, and `now` is the request clock of section 2 in the `datetime` text form.
- **Parameters.** `params` uses the runtime value model JSON: a decimal is a string, bytes are base64, a datetime is `YYYY-MM-DD HH:MM:SS.ffffff` in UTC, a date is `YYYY-MM-DD` and a time is `HH:MM:SS.ffffff`. The slot a parameter fills decides its form: `ir.ParamUses` lists each parameter's slots with their logical type (the compared or assigned column, a column function's result, the interval of a relative time function, the text of `contains`), and a time value of the client is written in the form of that type. A `hex` or `ip` column's slot receives the encoded value, as on a SQL database.
- **Codec.** The client applies the codec stages itself, as for SQL: it encodes the values of a write before it sends them and decodes the values of a read after it receives them.
- **Read.** A read answers the rows assembled to the request's shape: joins, relations, `key_by` and `flatten` as section 1.2 defines them.
- **Write.** A write answers `{affected, keys}`, where `keys` lists the primary key of each inserted row in insert order.
- **Errors.** A failed message is answered `{"error": {"code": <code>, "message": <text>}}`, whose code is one code of [errors.yaml](errors.yaml) and which the client returns as that code with that message. A hash mismatch is `SCHEMA_HASH_MISMATCH`. A write whose target changed since it was read is `WRITE_CONFLICT`, which names the file and line; the client never retries it. A lock wait that ends is `CANCELED`. A line that is not a JSON object, an `op` that names no control message and a field that a control message does not take are `IR_INVALID`. A connection that breaks is `CONNECTION_LOST`, and so is the answer the server writes before it closes the connection of a transaction idle longer than its bound. When the context or signal of a call ends, the client closes the connection and the call is `CANCELED`; the server rolls back the transaction of a closed connection.
- **Session.** A connection is a session. Control messages `{"op": "begin", "read_only"?}`, `{"op": "commit"}`, `{"op": "rollback"}` and `{"op": "savepoint" | "release" | "rollback_to", "name"}` begin, end and nest a transaction; `name` names the savepoint of `savepoint`, `release` and `rollback_to`. The client sends `read_only` true for a transaction with the `readOnly` option and leaves it out otherwise; the executor then answers every write of that transaction `READ_ONLY`. Each control message is answered `{"ok": true}` or with an error. A transaction holds one connection from `begin` to its end, and a request outside a transaction runs as its own transaction on any connection of the pool.
- **Executor-assigned columns.** The `identity`, `key_prefix` and `order` columns are assigned by the executor, so an insert may omit them. Section 1.4 defines the columns that the planner assigns; these are assigned by the executor instead.
