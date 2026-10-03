# IR and Plan protocol

A client renders the model built with the [DSL](dsl.md) into the request below, plans it in the calling process, and caches the plan by the request shape. The type definitions in `engine/ir/ir.go` and `engine/plan/plan.go` are authoritative; every client implements the same fields.

## 1. Request

```json
{
  "ir_version": 1,
  "manifest_hash": "sha256:74501d5f3aa5050f7af67198114fa4a56292d725e7a244d5901750271b2c41fa",
  "kind": "one | all | count | group_count | sum | avg | paginate | insert | update | delete | restore",
  "entity": "author",
  "columns": Columns,
  "where": Group,
  "joins": [Join],
  "relations": [Relation],
  "order": [Order],
  "group_by": ["user_seq"],
  "group_by_expr": [{"expr": "DATE({created_ts})", "as": "group_1"}],
  "limit": {"offset": 0, "count": 20},
  "force_index": "ix_service",
  "lock": "update | share | update_nowait | share_nowait",
  "agg": "read_count",
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
| `kind` | `one` and `all` read rows, `count` counts rows or groups, `group_count` returns grouped rows with `row_count`, `sum` and `avg` aggregate `agg`, `paginate` returns the page statement and a count statement, `insert`, `update`, and `delete` write rows, and `restore` clears the soft delete column of one deleted row ([restore](#_1-5-restore)) |
| `set` | assignments of `insert` and `update` |
| `rows` | parameters of each additional inserted row in the column order of `set`; every `set` item is then a value assignment and `on_duplicate` is not allowed |
| `on_duplicate` | assignments applied when an inserted row meets an existing unique key |
| `optimistic` | `update` matches only when the column still equals the parameter; no match returns `OPTIMISTIC_LOCK` |
| `lock` | root row selection only; the client allows it only inside a transaction |

`Query` is the shape shared by the root, a join child, a relation child, and a subquery: `entity`, `columns`, `on` (join child only), `where`, `joins`, `relations`, `order`, `group_by`, `group_by_expr`, `limit`, `force_index`, `lock`, and the relation options.

### 1.1 Columns

```json
Columns = {
  "mode": "" | "all" | "none",
  "add": ["name"],
  "remove": ["description"],
  "expr": {"doubled": {"sql": "({read_count} * ?)", "ps": [0]}},
  "fn": {"created_date": {"column": "created_ts", "fn": Func}},
  "sub": {"read_total": Sub}
}
```

- `mode` `""` selects the default select set, every column except those of `select explicit` ([runtime model](dbspec.md#runtime-model)); `all` selects every column, and `none` keeps primary and foreign keys.
- `expr`, `fn`, and `sub` add named outputs. An output name must not be a column of the entity.
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
- A relation runs as a separate statement. `limit_per_parent` limits child rows per parent key, `if_parent` loads the child only for parents whose column equals the parameter, `flatten` merges the child columns into the parent row, `key_by` keys the child collection, and `no_cascade_delete` excludes the relation from recursive delete.

### 1.3 Groups and predicates

```json
Group = {"conn": "and | or", "items": [Item]}
Item  = {"pred": Pred} | {"group": Group} | {"joined": {"conn": "and | or", "join": "service_model"}}
Pred  = {"conn", "column", "op", "p"}                                   // eq not_eq gt gte lt lte contains contains_binary
      | {"conn", "column", "op": "in | not_in | between", "ps": [...]}
      | {"conn", "column", "op": "is_null | is_not_null"}
      | {"conn", "column", "op": "eq_col | not_eq_col | gt_col | gte_col | lt_col | lte_col", "ref": {"path": "service_model", "column": "seq"}}
      | {"conn", "op": "tuple_in | tuple_not_in", "cols": ["tenant_id", "account_id"], "ps": [0, 1, 2, 3]}
      | {"conn", "column", "op": "in | not_in", "sub": Sub}
      | {"conn", "column", "op", "p", "fn": Func}
      | {"conn", "column", "op", "value": Func}
      | {"conn", "expr": "{read_count} > ?", "ps": [0]}
Func  = {"name": "day_of_week | year | month | date | now | today | days_ago | …", "ps": [0]}
Sub   = {"query": Query, "column": "user_seq", "agg": "sum | avg | count"}
```

- `conn` joins an item to the previous item of its group; the first item has none.
- `ref.path` is the join path from the statement root (`""` is the root, `a/b` a nested join) or `^`, the model that owns a subquery.
- `fn` applies a column function to `column` before the comparison with `p`. `value` compares `column` with a value function. Functions are structure only; each dialect renders them as described in [dialects](dialects.md), and an unknown name returns `FUNCTION_UNKNOWN`.
- `expr` fragments reference columns of the owning model as `{column}` and bind `?` values in `ps` order; the placeholder count must equal the bind count.
- `contains` and `contains_binary` bind the value between wildcards; `contains_binary` compares case-sensitively.

### 1.4 Order and assignments

```json
Order  = {"column": "seq", "desc": true} | {"column": "start_dt", "fn": Func} | {"random": true} | {"expr": "{seq} DESC"}
Assign = {"column", "p"} | {"column", "null": true} | {"column", "expr", "ps"} | {"column", "plus_p"} | {"column", "minus_p"}
```

A raw order expression carries its own direction. `minus_p` never stores a negative value.

An `insert` that omits a column with a default leaves it to the database default; the planner adds no value for it. An `insert` that omits a non-null column without a default fails with `IR_INVALID`. The planner assigns the columns the executor owns: the AES key version, the `updated` column on every `update`, and on a table with an `audit` setting the audit column of every `insert`, `update`, soft delete, restore and duplicate update; a request that assigns the AES key version or the audit column fails with `IR_INVALID`.

### 1.5 Restore

A `restore` request names one soft-deleted row of a table with a `soft_delete` setting ([dbspec](dbspec.md#settings)). Its `where` holds only `eq` predicates with a parameter, joined by `and`, that name every column of the primary key or of one unique key once, in any order. Its `set` holds the new values written with the restore, under the rules of an `update` assignment; a primary key, identity or soft delete column assignment fails with `IR_INVALID`. It has no `optimistic`. The plan is one `main` step:

```sql
UPDATE `link` SET `note` = ?, `deleted_at` = NULL, `audit_seq` = ? WHERE `link`.`team_id` = ? AND `link`.`member_id` = ? AND `link`.`deleted_at` IS NOT NULL
```

The step writes the new values, clears the soft delete column and, on a table with an `audit` setting, writes the audit column; like a soft delete it does not assign the `updated` column. A row that is not deleted and a missing row match no row, so the statement changes nothing, the new values included. A request on a table without `soft_delete`, a predicate of another form, a column outside the key or a key that is named only in part fails with `IR_INVALID`. Reads always exclude soft-deleted rows; `restore` is the only request that matches one. The model method `restore` runs the step and then reads the row by the same key ([usage](usage.md#restore-a-soft-deleted-row)).

## 2. Plan

```json
{
  "manifest_hash": "sha256:…", "kind": "all",
  "steps": [
    {"id": 0, "role": "main", "sql": "SELECT `a`.`seq` AS `a__seq`, … FROM `author` AS `a` … LIMIT 0, 20",
     "bind_slots": [{"from": "param", "param": 0}, {"from": "secret", "name": "aes"}],
     "assemble": {"entity": "author", "alias": "a",
                  "columns": [{"index": 0, "name": "seq", "column": "seq", "type": "i64"}],
                  "key": [{"column": "seq", "index": 0}],
                  "children": [{"rel": "service_model", "kind": "join", "assemble": {…}}]}},
    {"id": 1, "role": "relation", "sql": "…", "bind_slots": [{"from": "parent"}], "parent": {"step": 0, "keys": [{"column": "user_seq", "index": 14}]}}
  ]
}
```

- `bind_slots.from` is `param` (a request parameter, with `transform` for contains values and `host_styles` for AES, hex, and IP stages), `secret` (the AES key), `config` (the AES key version), `parent` (relation key values), `now` (the client clock in UTC), or `audit` (the primary key of the transaction's audit record, with `name` the entity of the audit record table). A write that has an `audit` slot and runs outside a transaction with audit values, or in one whose audit record is a row of another entity than `name`, fails with `CONFIG` before it reaches the database.
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

Errors carry a code from [errors.yaml](errors.yaml) and a message, for example `IR_INVALID`, `SCHEMA_HASH_MISMATCH`, `COLUMN_UNKNOWN`, `OPERATOR_NOT_ALLOWED`, `FUNCTION_UNKNOWN`, `EMPTY_IN`, `LIMIT_IN_RELATION`, and `COLUMN_ALIAS_CONFLICT`. Executors add `CONFIG`, `OPTIMISTIC_LOCK`, `LOCK_NOT_AVAILABLE`, `DEADLOCK`, `DUPLICATE_KEY`, `FOREIGN_KEY`, `CONSTRAINT`, `READ_ONLY`, and `DRIVER`. The client returns every driver error as an ORM error: a condition that the catalog lists has its code, every other driver error has `DRIVER`, and each keeps the driver message and the driver error as its cause. A write that an `audit` or `immutable` trigger refuses is `DRIVER`. When the callback of a transaction or savepoint fails and its rollback fails too, the client returns one error with the code `ROLLBACK`; its message names both errors, and it keeps the callback error and the rollback error (PHP: the previous exception and `rollback`, TypeScript: `cause` and `rollback`, Go: `errors.Join` of both in that order, Rust: `Error::Rollback { callback, rollback }`). A `ROLLBACK` error is not retried. A NOWAIT lock failure is always `LOCK_NOT_AVAILABLE` and is not retried as a transaction conflict.

### 3.1 Test faults

A test makes the rollback of a transaction fail deterministically on every database through the test entry point of its client; a production process cannot arm the fault. The entry point arms a rollback fault on the connection of a handle, and every handle of that connection shares it. The next rollback of a transaction whose callback failed runs as usual, so the database discards the transaction, and the client then reports the rollback as failed with a `FAULT` error: the transaction returns one `ROLLBACK` error that keeps the callback error and the `FAULT` error. A commit, a savepoint rollback, and a rollback after a failed begin or commit do not consume the fault; it stays armed until a transaction rollback after a failed callback consumes it, and the next transaction whose callback fails returns its callback error alone.

The fault exists only in the test entry point of each client. No DSN, configuration value, or environment variable arms it.

| Client | Entry point | How a production build excludes it |
|---|---|---|
| Go | `orm.FailNextRollback(db)` | The file is compiled only with the build tag `ormtest` (`go test -tags ormtest`); without the tag the function does not exist and a call does not compile |
| Rust | `orm::testing::fail_next_rollback(&db)` | The module is compiled only with the cargo feature `test-faults`, which no default feature enables; it is enabled in `[dev-dependencies]` |
| TypeScript | `failNextRollback(db)` of `@polyspec/orm-typescript/testing` | The package exports the subpath only under the condition `orm-test`; without `node --conditions=orm-test` the import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, and the package entry point does not export the function. A type check of the test resolves the subpath with `customConditions: ["orm-test"]` |
| PHP | `Orm\Testing\Faults::failNextRollback($db)` | The class is in `testing/Faults.php` of the package, which the package autoloader does not map; a process has it only after it requires that file by its path |

## 4. Planning in the client

Every client validates and plans requests in the calling process. No compiler service, daemon, or extension is involved.

| Client | Validation, planning, dialects, and DDL |
|---|---|
| Go | `engine/ir`, `engine/planner`, `engine/dialect`, `engine/dbspec` DDL |
| PHP | `clients/php/src/Validator.php`, `Planner.php`, `Dialect.php`, `Dbspec/Renderer.php` DDL |
| Rust | `clients/rust/orm/src/engine/`, `clients/rust/orm-schema/src/dbspec/` DDL |
| TypeScript | `clients/typescript/src/engine/`, `clients/typescript/src/dbspec/` DDL |

Generated code carries the manifest text of its document set and its `manifestHash`. The client builds the runtime model from that text once and rejects text whose hash differs from the declared one (`SCHEMA_HASH_MISMATCH`). The plan cache key is the manifest hash and the request shape. Parameter values are not part of the key.

A process can load the generated code of several document sets, and one connection can serve several of them. A connection plans a request only with a set registered on that connection, because what a request can run against is decided by the database the connection uses, not by the code the process loaded. A set is registered on a connection in two ways. The connect helper of generated code (Go `model.Connect(dsn, config)`, PHP `Polyspec\Orm\Tests\Model\connect($dsn, $config)`, Rust `model::connect(dsn, pool_size, config)`, TypeScript `connect(dsn, options)` of the generated module) opens the connection and registers its own set through `connectSchema` (Go `orm.ConnectSchema`, PHP `Orm::connectSchema`, Rust `Db::connect_schema`, TypeScript `Db.connectSchema`). `utils().schema().install(schema)` creates the tables of the set and registers it on the same connection. Both take the generated schema value, the manifest text with its declared `manifestHash` (Go `model.Schema`, PHP `Polyspec\Orm\Tests\Model\schema()`, Rust `model::SCHEMA`, TypeScript `SCHEMA`), and fail with `CONFIG` before any statement when the text does not hash to the declared hash. A raw connection (`connect(dsn, …)` of the client) registers no set, and loading generated code registers nothing on a connection. A request whose manifest is not registered on its connection fails with `SCHEMA_HASH_MISMATCH` before execution, also when a plan of the same shape is cached, and so does a request of generated code whose manifest text does not hash to its declared `manifestHash`. No other registration call exists. Every client follows this rule.

The four planners produce the same SQL and bind slots for the same request. `tests/conformance` runs the same vectors in the four clients on MySQL, PostgreSQL, and SQLite and compares the statements, binds, and results with the recorded expectations.
