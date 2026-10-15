<!-- doc-id: protocol -->
# IR and Plan protocol

A client renders the model built with the [DSL](dsl.md) into the request below, plans it in the calling process, and caches the plan by the request shape. The type definitions in `packages/go/engine/ir/ir.go` and `packages/go/engine/plan/plan.go` are authoritative; every client implements the same fields.

## 1. Request

```json
{
  "ir_version": 1,
  "manifest_hash": "sha256:6b243f5910037ab61aca570f15bcb9c94461a80690ec6ed9546fecaf51e5af29",
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

A request is decoded strictly in every client. A member that its object does not define, at the top level or inside any object (`ref`, `pred`, an item, a group, an order item, `limit`, a join, a relation, an assignment), is `IR_INVALID`, and so is a member of the wrong JSON type: a `column`, `agg`, `entity` or `op` that is not a string, a parameter index or count that is not an integer (also a number written as `0.0` or `1e1`, whose literal is not an integer; TypeScript reads a request text through ordered-json, which keeps the literal), a list member that is not an array, or an object member that is not an object. A `column` on a `sum` request is such an unknown member, since `sum` and `avg` name their column in `agg`. The shape check comes before every other rule, so the request fails with `IR_INVALID`, not with `COLUMN_UNKNOWN` or `ENTITY_UNKNOWN` for a name of the wrong type. A null member is absent. `tests/ir/validate.json` (the `shape-*` cases) holds these cases, which Go, PHP, Rust, TypeScript and Python run.

| Field | Rule |
|---|---|
| `manifest_hash` | the `manifestHash` of the document set the generated code carries: `sha256:` followed by 64 lower-case hexadecimal digits ([manifest and hashes](dbspec.md#manifest-and-hashes)). A request whose hash differs from the model the client loaded fails with `SCHEMA_HASH_MISMATCH`. The field replaces `schema_hash`; the error code keeps its name |
| `kind` | `one` and `all` read rows, `count` counts rows or groups, `group_count` returns grouped rows with `row_count`, `sum` and `avg` aggregate `agg`, `paginate` returns the page statement and a count statement, `insert`, `update`, and `delete` write rows, `restore` clears the soft delete column of one deleted row ([restore](#_1-5-restore)), and `restart_identity` restarts the identity of a table past its largest key ([load](#_1-6-load)) |
| `load` | `insert` writes rows with their stored keys: it takes a value for the identity column ([load](#_1-6-load)) |
| `set` | assignments of `insert` and `update` |
| `rows` | parameters of each additional inserted row in the column order of `set`; every `set` item is then a value assignment and `on_duplicate` is not allowed |
| `on_duplicate` | assignments applied when an inserted row meets an existing key; an insert with `on_duplicate` has exactly one key that can meet the inserted row (the primary key, unless the insert leaves it out, and each unique key) and assigns every column of it, else `IR_INVALID` "on_duplicate needs exactly one conflict key; %s can meet the row", because MySQL updates the row met on any unique key while PostgreSQL and SQLite name one target |
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
- A relation runs as a separate statement. `limit_per_parent` limits child rows per parent key, `if_parent` loads the child only for parents whose column equals the parameter (compared as the column's logical type, so a bool column stored as 0 or 1 equals a bool parameter), `flatten` merges a `one` child into the parent as stated below, `key_by` keys the child collection by a non-null column of the child (a nullable column is `IR_INVALID`, since a NULL key has no answer that every language shares; an empty `key_by` is absent, as an omitted one is), and `no_cascade_delete` excludes the relation from recursive delete.
- `flatten` merges a `one` child into the parent's array and JSON forms: after the parent's own members, the members of the child's array form — its outputs, its relations, and a flattened grandchild merged likewise; a name the parent holds keeps the parent's value, and an absent child adds nothing. The rows a plan assembles and an IR executor answers hold the child under `rel`; the merge is the client model's. The conformance vector `relations_flatten` pins a shared name, an absent child and a flattened grandchild.

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
- The shared cases of `tests/ir/validate.json` pin the validation rules: every client reads the file from its own package (Go from `packages/go/engine/ir`) and passes each request to its validator alone. The PHP extension `orm_dbspec` implements only the dbspec surface (`packages/php-ext/stubs/orm_dbspec.stub.php`) and has no request validator; a PHP program validates and plans requests through `Polyspec\Orm\Validator` of the PHP client.
- `fn` applies a column function to `column` before the comparison with `p`. `value` compares `column` with a value function; a relative time function outside 0001-01-01 to 9999-12-31 23:59:59.999999, or with an interval past that span, is NULL, so neither the comparison nor its negation matches a row ([dialects](dialects.md)). Functions are structure only; each dialect renders them as described in [dialects](dialects.md), and an unknown name returns `FUNCTION_UNKNOWN`.
- The two columns of a column comparison, of a column `in` or `not_in` a subquery column, of a join's `left` and `right` and of each relation key pair meet as dbspec check operands do ([dbspec](dbspec.md)): integers with integers, `decimal` of one scale, `f64`, `bool`, `varchar` and `text` together, `uuid`, `date`, `time` or `datetime` of one precision, and `bytes` with `bytes`; any other pair fails with `OPERATOR_NOT_ALLOWED`, because the databases then disagree (PostgreSQL refuses `integer = varchar`, MySQL coerces, SQLite compares by affinity). The validator reads the table of dbspec's check validation, and the conformance vector `column_pairs` runs both kinds of pair.
- A scalar column subquery (`columns.sub` with no `agg`) has `limit` with count 1 (any `offset`) and an `order` that includes every primary key column and no `random` item, so it yields at most one row on every database and is NULL when none matches; without them the request is `IR_INVALID`, because MySQL answers 1242 and PostgreSQL 21000 for several rows and SQLite returns the first. `limit` stays `IR_INVALID` in an `in` subquery (MySQL 1235) and in an aggregate subquery.
- A column comparison (`eq_col` and the others) is allowed when its base operator (`eq` for `eq_col`) is one of the left column's type and neither column has a codec, so `bool gt_col`, `bytes gt_col` and an `aes` column's `eq_col` fail with `OPERATOR_NOT_ALLOWED`; two columns whose only codec is `ip` take `eq_col` and `not_eq_col`, because both sides are the dialect's same stored form.
- `not` negates a nested group, which renders `NOT (…)`; a top-level `where` or `on` group with `not` fails with `IR_INVALID`.
- The request carries no SQL text: every condition, output, order, grouping and assignment is one of the forms above, and every bind slot of the plan has a dbspec type.
- `contains` and `contains_binary` bind the value between wildcards; `contains` compares the ASCII letters without regard to case and every other character by code point, and `contains_binary` compares by code point ([dialects](dialects.md)).

### 1.4 Order and assignments

```json
Order  = {"column": "seq", "desc": true} | {"column": "start_dt", "fn": Func} | {"random": true}
Assign = {"column", "p"} | {"column", "null": true} | {"column", "plus_p"} | {"column", "minus_p"}
```

An order item sorts NULL before every value ascending and after every value descending: MySQL and SQLite do so natively, and PostgreSQL, which sorts NULL last ascending, renders `ASC NULLS FIRST` and `DESC NULLS LAST` on an order expression that can be NULL (a nullable column or a column function of one); a NOT NULL column keeps its btree order. This holds in the root order, in the `ROW_NUMBER()` order of `limit_per_parent` and in the `group_count` order.

With `group_by`, an order item names a group column, a function of one, or `random`; any other column fails with `IR_INVALID` ("order by %s, which is not a group column"), because a group has no single value for it (MySQL 1055, PostgreSQL 42803, an arbitrary row on SQLite).

`minus_p` never stores a negative value.

An `update` that assigns a primary key or identity column fails with `IR_INVALID` ("cannot update %s"), and so does a `restore` that assigns one or the soft delete column, which it clears itself; the validator refuses it, not only the planner, so an IR executor that does not plan sees the same rule.

An `insert` assigns by `p` or `null`: `plus_p` and `minus_p` are `IR_INVALID` in its `set` and valid in `on_duplicate` and in `update`, because a `VALUES` list has no current row to read, and MySQL reads the column's default there (3 + 5 = 8) while PostgreSQL and SQLite refuse the statement.

An `insert` that omits a column with a default leaves it to the database default; the planner adds no value for it. An `insert` that omits a non-null column without a default fails with `IR_INVALID`. The planner assigns the columns the executor owns: the AES key version, the `updated` column on every `update`, and on a table with an `audit` setting the audit column of every `insert`, `update`, soft delete, restore and duplicate update; a request that assigns the AES key version or the audit column fails with `IR_INVALID`.

### 1.5 Restore

A `restore` request names one soft-deleted row of a table with a `soft_delete` setting ([dbspec](dbspec.md#settings)). Its `set` holds the values of the row, under the rules of an `update` assignment, and its `where` holds conditions joined by `and`; an `or` between two items of the `where` fails with `IR_INVALID`. The planner picks the key after the request hook: the `set` values with a parameter (`p`) and the `eq` predicates of a column with a parameter, without a function, value function, ref or subquery, in the items of the `where` give columns their values, and the key is the primary key when they cover every column of it, otherwise the first unique key, in name order, whose columns they cover. A `set` value of a key column becomes an `eq` condition on that column, after the `where` and in the order of the `set`; every other `set` value is a new value written with the restore. The other conditions of the `where` narrow the restore further, and the key still matches at most one row, so a request hook adds a condition to a restore as it does to an `update`. A request whose values cover no key fails with `IR_INVALID`, and so does a new value of a primary key, identity or soft delete column. It has no `optimistic`. The plan is one `main` step; for a `set` of `team_id`, `member_id` and `note` on the unique key (`team_id`, `member_id`):

```sql
UPDATE `link` SET `note` = ?, `deleted_at` = NULL, `audit_seq` = ? WHERE `link`.`team_id` = ? AND `link`.`member_id` = ? AND `link`.`deleted_at` IS NOT NULL
```

The step writes the new values, clears the soft delete column and, on a table with an `audit` setting, writes the audit column; like a soft delete it does not assign the `updated` column. A row that is not deleted and a missing row match no row, so the statement changes nothing, the new values included. A request on a table without `soft_delete` fails with `IR_INVALID`. Reads always exclude soft-deleted rows: the root and each subquery in their `WHERE`, each join child in its `ON` condition, so that a left join gives a null child, and each relation in its own statement; `restore` is the only request that matches one (the conformance vector `joins_soft_deleted`). The model method `restore` sends its set values as the `set` and no `where`, runs the step and then reads the row by the values of the key the planner picked from the request as the hook left it ([usage](usage.md#restore-a-soft-deleted-row)).

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
- `bind_slots.from` is `param` (a request parameter, with `transform` for contains values and `host_styles` for AES, hex, and IP stages), `secret` (the AES key), `config` (the AES key version), `parent` (relation key values), `now` (the client clock in UTC), or `audit` (the primary key of the transaction's audit record, with `name` the audit record table). A `param` slot of a column carries the column's size: `precision` and `scale` for `decimal(p,s)`, `precision` for `time(p)` and `datetime(p)` (six for the argument or result of a function), and `length` for `varchar(n)`; the planner case `planner_bind_types_insert` and the others of `contracts/fixtures/planner.json` pin them. The bind path checks each parameter against these sizes before any statement (§5 "Parameters"). A `transform` slot binds its text transformed (`like_contains` escapes `\`, `%` and `_` and wraps the text in `%`); SQL NULL binds NULL, also through a condition builder, so `col LIKE NULL` matches no row on the three databases (the conformance vector `contains_null`), and a value other than text is `CODEC_ENCODE` "%s requires a string value" (the `contains-*` cases of `tests/bind/vectors.json`). A write that has an `audit` slot and runs outside a transaction with audit values, or in one whose audit record is a row of another table than `name`, fails with `CONFIG` before it reaches the database.
- **Clock.** This is the one clock rule; [dialects](dialects.md) and [plans](plans.md) refer to it. Every connection reads and writes `datetime(p)` in UTC. The `now` slot is the client wall clock in UTC with microsecond resolution, truncated to six fraction digits, in the `datetime` text form; a statement reads the clock once, so its `now` slots are equal and the statement has one clock value. A clock that the ORM writes is truncated to the declared fraction digits of the column, and a clock that it compares keeps six digits. On MySQL the update time and soft deletion assign `CURRENT_TIMESTAMP(p)` (`CURRENT_TIMESTAMP` for p = 0), which truncates the statement clock (`mysql.now.precision_truncates`), an insert leaves a `default now` column to its database default, and the `now` value function and its relative forms use `NOW(6)`; a `datetime(p)` column compares with `NOW(6)` as its value (`mysql.now.compare_six_digits`). PostgreSQL rounds a clock into `timestamp(p < 6)` (`postgres.now.precision_rounds`) and its `now()` is the transaction start, not the statement start (`postgres.now.transaction_start`), so the PostgreSQL dialect binds the `now` slot, truncated to p, for the update time, soft deletion and every `default now` column that an insert omits, and binds the `now` slot at six digits, as `CAST(<slot> AS timestamp(6))`, for the `now` value function and its relative forms; a `timestamp(p)` column compares with it as its value (`postgres.now.compare_six_digits`). The DDL default `statement_timestamp()` stays for raw SQL. SQLite has no clock with microseconds, so the SQLite dialect binds the `now` slot, truncated to p, for the update time, soft deletion and every `default now` column that an insert omits, binds it at six digits for the `now` function, and renders a relative form as `datetime` of a `now` slot with the interval followed by the six fraction digits of a second `now` slot; SQLite compares text, so a `datetime(p < 6)` column that compares with a clock is extended to six digits, `col || '.000000'` for p = 0 and `col` followed by 6 − p zeros otherwise. The conformance vectors `clock_truncate_write` and `clock_compare_six_digits` run under a clock fixed by the test entry point ([3.3](#_3-3-test-clock)). The plan history keeps the tool clock with six fraction digits ([plans](plans.md#apply)).
- Rows are read by position. `assemble.columns[].styles` lists the codec stages the client decodes; SQL-side stages are already applied.
- `assemble.key` is the collection identity: every primary-key component, or the group columns of a `group_count` row.
- A `group_count` row retains the declared types of its selected group columns; a boolean group value is a JSON boolean, and an invalid database boolean fails decoding.
- `children[].kind` is `join` for a child in the same row, and `one` or `many` for a relation step matched by `parent_keys` and `child_keys`.

### 2.1 Relation steps

- Each relation has one `relation` step after its parent step; nested relations follow the same rule, and `paginate` orders the steps as main, relations, count.
- The client reads the parent keys of every parent row in order, removes rows with a null key, removes duplicates, and skips the statement when no key remains. With `if_parent`, only parents whose column equals the parameter are used.
- The `parent` slot is one placeholder that the client expands to the key list. The list is padded to a power of two by repeating the last key, so one prepared statement serves each size class. A list longer than the driver bind limit is split into chunks.
- A multi-row insert (`creates`) follows the same size classes. Its rows run as parts in the given order, each the largest power of two that is at most the rows left and at most the bind-limit chunk, floor(bind limit / columns) and at least 1, where the bind limit is 999 on SQLite and 65535 on MySQL and PostgreSQL. 1000 rows of two columns on SQLite run as 256, 256, 256, 128, 64, 32 and 8 rows. Rows are never padded, since a repeated row would be inserted. All parts run in one transaction, so a failing part leaves no row of the call, and the inserted rows, their generated keys and the statement events keep the order of the given rows. The shared cases are `contracts/fixtures/insert_parts.json`.
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

The statement fault is armed on a `Db` and counts the statements that the `Db` runs. The dbspec apply, recover, rollback, finalize and introspection of every implementation run on the driver connection that the caller passes, outside the `Db`, so they do not consume it: Go `packages/go/engine/dbspec/apply.go:138,159,200,282` (`Execer`) and `packages/go/engine/dbspec/introspect.go:37` (`Querier`); Rust `packages/rust/orm/src/dbspec/apply.rs:296,313,331,347` (`ApplyConnection`) and `packages/rust/orm/src/dbspec.rs:52` (`CatalogQuerier`); TypeScript `packages/ts/src/dbspec/apply.ts:720,737,768,820` (`Connection`) and `packages/ts/src/dbspec/introspect.ts:33`; Python `packages/python/src/polyspec/orm/dbspec/apply.py:703,718,743,802` and `packages/python/src/polyspec/orm/dbspec/introspect.py:16` (`Connection`); PHP `packages/php/src/Dbspec/PlanApply.php:102,118,149,212` and `packages/php/src/Dbspec/Dbspec.php:161,588` (`\PDO`); the PHP extension `orm_dbspec` `packages/php-ext/stubs/orm_dbspec.stub.php:553,591,594,597,600` (`\PDO`), implemented in `packages/php-ext/src/apply.c` and `introspect.c`.

### 3.3 Test clock

A test fixes the executor clock of a connection through the test entry point of its client, the same entry point as the faults of 3.1 and 3.2. The entry point takes the database and a clock, the UTC text `YYYY-MM-DD HH:MM:SS.ffffff`; a clock of another form is refused with the programmer-error signal of the client (3.2) and fixes nothing. From then on every `now` slot of the connection and every handle of it, and the `now` of an IR executor message, is that clock instead of the wall clock; the connection keeps it until it closes. A database clock (MySQL `CURRENT_TIMESTAMP(p)`, `NOW(6)`) is not fixed. No DSN, configuration value, or environment variable fixes it.

| Client | Entry point | How a production build excludes it |
|---|---|---|
| Go | `orm.FixClock(db, clock)` | The same file as `FailNextRollback`, compiled only with the build tag `ormtest` |
| Rust | `polyspec_orm::testing::fix_clock(&db, clock)` | The same module as `fail_next_rollback`, compiled only with the cargo feature `test-faults` |
| TypeScript | `fixClock(db, clock)` of `@polyspec/orm/testing` | The same subpath as `failNextRollback`, exported only under the condition `orm-test` |
| PHP | `Polyspec\Orm\Testing\Faults::fixClock($db, $clock)` | The same class as `failNextRollback`, in `testing/Faults.php`, which the package autoloader does not map |
| Python | `polyspec.orm.testing.fix_clock(db, clock)` | The same package as `fail_next_rollback`, which no module of `polyspec.orm` imports |

The conformance runners take it from the same place: the Go runner is built with `-tags ormtest`, the Rust runner with the feature `polyspec-orm/test-faults`, the TypeScript runner imports `dist/testing.js` by its path, the PHP runner requires `testing/Faults.php` and the Python runner imports `polyspec.orm.testing`.

### 3.4 Test write result

A test reads the write result of a connection through the test entry point of its client, the same entry point as 3.1 to 3.3. The entry point takes the database and returns the `affected` of the last write of the connection and every handle of it that succeeded (an insert, update, delete or restore, [5](#_5-ir-executors) "Write"), or none before the first such write. A write that fails leaves the value as it was. Every client keeps the value only to answer this entry point. The conformance vector `affected_counts` reads it after an upsert that inserts, an upsert that updates, an update of a row that already holds the value and an update that changes it.

| Client | Entry point | How a production build excludes it |
|---|---|---|
| Go | `orm.LastAffected(db)`, which returns `(affected, ok)` | The same file as `FailNextRollback`, compiled only with the build tag `ormtest` |
| Rust | `polyspec_orm::testing::last_affected(&db)`, an `Option<u64>` | The same module as `fail_next_rollback`, compiled only with the cargo feature `test-faults` |
| TypeScript | `lastAffected(db)` of `@polyspec/orm/testing`, a `number` or `null` | The same subpath as `failNextRollback`, exported only under the condition `orm-test` |
| PHP | `Polyspec\Orm\Testing\Faults::lastAffected($db)`, an `?int` | The same class as `failNextRollback`, in `testing/Faults.php`, which the package autoloader does not map |
| Python | `polyspec.orm.testing.last_affected(db)`, an `int` or `None` | The same package as `fail_next_rollback`, which no module of `polyspec.orm` imports |

## 4. Planning in the client

Every client validates and plans requests in the calling process. No compiler service, daemon, or extension is involved.

| Client | Validation, planning, dialects, and DDL |
|---|---|
| Go | `packages/go/engine/ir`, `packages/go/engine/planner`, `packages/go/engine/dialect`, `packages/go/engine/dbspec` DDL |
| PHP | `packages/php/src/Validator.php`, `Planner.php`, `Dialect.php`, `Dbspec/Renderer.php` DDL |
| Rust | `packages/rust/orm/src/engine/`, `packages/rust/schema/src/dbspec/` DDL |
| TypeScript | `packages/ts/src/engine/`, `packages/ts/src/dbspec/` DDL |

Generated code carries the manifest text of its document set and its `manifestHash`. The client builds the runtime model from that text once and rejects text whose hash differs from the declared one (`SCHEMA_HASH_MISMATCH`). The plan cache key is the manifest hash and the request shape. Parameter values are not part of the key.

A process can load the generated code of several document sets, and one connection can serve several of them. A connection plans a request only with a set registered on that connection, because what a request can run against is decided by the database the connection uses, not by the code the process loaded. A set is registered on a connection in three ways. `utils().schema().register(schema)` registers the set on the connection. The connect helper of generated code (Go `model.Connect(dsn, config)`, PHP `Polyspec\Orm\Tests\Model\connect($dsn, $config)`, Rust `model::connect(dsn, pool_size, config)`, TypeScript `connect(dsn, options)` of the generated module, Python `connect(dsn, **options)` of the generated module) opens the connection and registers its own set the same way through `connectSchema` (Go `orm.ConnectSchema`, PHP `Orm::connectSchema`, Rust `Db::connect_schema`, TypeScript `Db.connectSchema`, Python `Db.connect_schema`). `utils().schema().install(schema)` creates the tables of the set, verifies the database and registers the set on the same connection. All three take the generated schema value, the manifest text with its declared `manifestHash` (Go `model.Schema`, PHP `Polyspec\Orm\Tests\Model\schema()`, Rust `model::SCHEMA`, TypeScript `SCHEMA`, Python `SCHEMA`), and fail with `CONFIG` before any statement when the text does not hash to the declared hash. Registering reads and writes nothing in the database, for sets with external documents too: the database is verified when the set is installed or upgraded (`install`, `addTablesAndColumns`), not on each connection, so a connection opened per request registers its sets without a statement ([schema](schema.md#_6-schema-registration)). A raw connection (`connect(dsn, …)` of the client) registers no set, and loading generated code registers nothing on a connection. A request whose manifest is not registered on its connection fails with `SCHEMA_HASH_MISMATCH` before execution, also when a plan of the same shape is cached, and so does a request of generated code whose manifest text does not hash to its declared `manifestHash`. No other registration call exists. Every client follows this rule.

The five planners produce the same SQL and bind slots for the same request. `tests/conformance` runs the same vectors in the five clients on MySQL, PostgreSQL, and SQLite and compares the statements, binds, and results with the recorded expectations.

## 5. IR executors

A DSN scheme may select an IR executor instead of a SQL dialect. The scheme `markdown://` selects the flowmark executor, which runs requests on a markdown corpus served by a flowmark server ([capability table](dialects.md#markdown-ir-executor)). Section 4 applies to SQL dialects only.

- **Connection.** The DSN is `markdown://127.0.0.1:<port>/<corpus>?token=<token>`: the port that `flowmark serve` listens on, on loopback TCP only; the corpus root's directory name; and the token that the server keeps in `.flowmark/server.json` of the corpus. The DSN takes no other parameter, and another host, a missing port, a path that is not one name or a missing token is `CONFIG` before any connection opens. A connection of the client is one TCP connection to the server, and the client keeps them as it keeps database connections ([configuration](config.md)): a pool of them, or, in the PHP client, which keeps no pool, the one connection of each `Db`.
- **Wire.** A message is one JSON object on one line, and the server answers the messages of a connection in order, each with one line. A message with `op` is a control message, any other a request message. The first message of a connection is `{"op": "connect", "corpus": <corpus>, "token": <token>}` with the DSN's corpus and token, answered `{"ok": true}`; the server answers a corpus or token that differs, or any other first message, `CONFIG` and closes the connection, so connecting fails with that `CONFIG`.
- **Validation.** The client validates each request with `ir.Validate` and does not plan it. It sends no SQL and reads no plan; the executor plans and runs the request.
- **Message.** Each request is one message `{ir_version, manifest_hash, request, params, now}`. `request` is the request of section 1 with the same fields and values as parameter indexes, `manifest_hash` is checked as in section 1, and `now` is the request clock of section 2 in the `datetime` text form.
- **Parameters.** `params` uses the runtime value model JSON: a decimal is a string, bytes are base64, a datetime is `YYYY-MM-DD HH:MM:SS.ffffff` in UTC, a date is `YYYY-MM-DD` and a time is `HH:MM:SS.ffffff`; a value of `datetime(p)` or `time(p)` has zeros past p, and a time text of the client (`10:00:00`, `2024-01-02T03:04:05.5`, or a datetime with an offset, converted to UTC) is written in that six-digit form, while a text of another form is `CODEC_ENCODE`. The shared cases are the `message` cases of `tests/bind/vectors.json`. The slot a parameter fills decides its form: `ir.ParamUses` lists each parameter's slots with their logical type (the compared or assigned column with its precision, scale, length and nullability, a column function's result, `i32` or `f64` for the interval of a relative time function, `text` for `contains` and `contains_binary`, the parent column for `if_parent`, the column for `optimistic`), the type before any SQL-side style; the `param_uses` cases of `contracts/fixtures/planner.json` pin them in the five validators. A time text of the client is written in the form of that type. A `hex` or `ip` column's slot receives the encoded value, as on a SQL database. Every client checks each parameter against its slot's logical type before any statement, and a value outside it is `CODEC_ENCODE`; an IR executor answers the same. A value is outside it when it is another host kind (an integer for `i16`, `i32` and `i64`, a number for `f64`, a boolean for `bool`, text for `decimal`, `varchar`, `text` and `uuid`, bytes or text for `bytes`, text for `date`, `time` and `datetime`), an integer past its range, a non-finite `f64`, a decimal with more than p digits or s fraction digits, a date outside 0001-01-01 to 9999-12-31, a time or datetime with a non-zero digit past p (a zero there is accepted), a `varchar(n)` value of more than n characters with trailing spaces counted, U+0000 in `text` or `varchar`, or a `uuid` other than lower-case canonical text. A parameter of a `date`, `time` or `datetime` slot takes its canonical text form only: a native time value (a `Date`, a `DateTime` or a PHP `DateTimeInterface`, a Python `datetime.date`, `datetime.time` or `datetime.datetime`, a Go `time.Time`, a chrono `NaiveDate` or `NaiveDateTime`) is `CODEC_ENCODE` naming the parameter and the slot, in every client. The `now` slot and the `now` of a message are the client clock, not parameters, and no check applies to them. SQL NULL is accepted, except by an assignment slot (`set`, `rows`, `on_duplicate`, the `restore` set) of a non-null column, which carries `not_null` and the `column`: before any statement such a NULL parameter is `CODEC_ENCODE` "parameter %d assigns NULL to the non-null %s", in an IR executor too (the `null-into-not-null` case and the conformance vector `null_into_not_null`), while raw SQL keeps the driver codes 1048, 23502 and 1299 as `DRIVER`. A `varchar` slot without a `length`, such as a slot of a utils statement, has no length to check. A column with codec stages checks the value against the input of its first stage. The shared cases are the `bind` cases of `tests/bind/vectors.json` (`make bind-check`) and the conformance vectors `datetime_precision_rejected`, `varchar_length_rejected`, `text_nul_rejected` and `uuid_form_rejected`.
- **Codec.** The client applies the codec stages itself, as for SQL: it encodes the values of a write before it sends them and decodes the values of a read after it receives them.
- **Read.** A read answers the rows assembled to the request's shape: joins, relations, `key_by` and `flatten` as section 1.2 defines them. A read answers `{"rows": [...]}` for `one`, `all` and `group_count`, `{"count": n}` for `count`, `{"value": v}` for `sum` and `avg`, and `{"rows": [...], "count": n}` for `paginate`, `n` counting every matching row. A row is a JSON object of its outputs in projection order, then each join (an object, or null for a left join without a match) and each relation (a `one` relation an object or null, a `many` relation an array, or an object keyed by `key_by`); a `flatten` relation is answered as `one` (section 1.2). Values use the parameter value model: a datetime `YYYY-MM-DD HH:MM:SS.ffffff`, a time `HH:MM:SS.ffffff`, a decimal and bytes (base64) as strings, an integer or `f64` a JSON number, a `bool` a JSON bool, a date and a uuid their text. The shared answers are `contracts/fixtures/ir_answers.json` (`make ir-answers-check`), which each client decodes into the model array form.
- **Write.** A write answers `{affected, keys}`, where `keys` lists the primary key of each inserted row in insert order. `affected` counts each written row once: an insert with `on_duplicate` is 1 on every database, whether it inserted or updated (MySQL alone counts 2 for the update), and an `update` counts the rows it matched, not only the rows it changed (the MySQL clients ask for found rows). The conformance vector `affected_counts` reads these counts through the test entry point ([3.4](#_3-4-test-write-result)) on the three databases.
- **Errors.** A failed message is answered `{"error": {"code": <code>, "message": <text>}}`, whose code is one code of [errors.yaml](errors.yaml) and which the client returns as that code with that message. A hash mismatch is `SCHEMA_HASH_MISMATCH`. A write whose target changed since it was read is `WRITE_CONFLICT`, and so is a `commit` that finds a change since the transaction read, such as a row that now matches or no longer matches its read, that makes the transaction's writes other writes; it names the file and line. The client never retries it, even with retry options, since running the callback again over a changed read is never safe: unlike `DEADLOCK`, which the transaction retries, the commit returns `WRITE_CONFLICT` after one run of the callback (the cases `commit_write_conflict` and `commit_deadlock` of `contracts/fixtures/ir_answers.json`). A lock wait that ends is `CANCELED`. A line that is not a JSON object, an `op` that names no control message and a field that a control message does not take are `IR_INVALID`. A connection that breaks is `CONNECTION_LOST`, and so is the answer the server writes before it closes the connection of a transaction idle longer than its bound. When the context or signal of a call ends, the client closes the connection and the call is `CANCELED`; the server rolls back the transaction of a closed connection.
- **Session.** A connection is a session. Control messages `{"op": "begin", "read_only"?}`, `{"op": "commit"}`, `{"op": "rollback"}` and `{"op": "savepoint" | "release" | "rollback_to", "name"}` begin, end and nest a transaction; `name` names the savepoint of `savepoint`, `release` and `rollback_to`. The client sends `read_only` true for a transaction with the `readOnly` option and leaves it out otherwise; the executor then takes no write lock for that transaction and answers every write in it `READ_ONLY`, as a SQL database refuses a write in a read-only transaction (the `control` cases of `tests/bind/vectors.json` and the case `read_only_write` of `contracts/fixtures/ir_answers.json`). Each control message is answered `{"ok": true}` or with an error. A transaction holds one connection from `begin` to its end, and a request outside a transaction runs as its own transaction on any connection of the pool.
- **Executor-assigned columns.** The `identity`, `key_prefix` and `order` columns are assigned by the executor, so an insert may omit them. Section 1.4 defines the columns that the planner assigns; these are assigned by the executor instead.
