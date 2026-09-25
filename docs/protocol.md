# IR and Plan protocol

A client renders the model built with the [DSL](dsl.md) into the request below, plans it in the application process, and caches the plan by the request shape. The type definitions in `engine/ir/ir.go` and `engine/plan/plan.go` are authoritative; every client implements the same fields.

## 1. Request

```json
{
  "ir_version": 1,
  "schema_hash": "cd21c76a45bcb2dd",
  "kind": "one | all | count | group_count | sum | avg | paginate | insert | update | delete",
  "entity": "battle",
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
| `kind` | `one` and `all` read rows, `count` counts rows or groups, `group_count` returns grouped rows with `row_count`, `sum` and `avg` aggregate `agg`, `paginate` returns the page statement and a count statement, `insert`, `update`, and `delete` write rows |
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
  "fn": {"distance": {"column": "location", "fn": Func}},
  "sub": {"read_total": Sub}
}
```

- `mode` `""` selects the non-lazy columns, `all` selects every column, and `none` keeps primary and foreign keys.
- `expr`, `fn`, and `sub` add named outputs. An output name must not be a column of the entity.
- The primary key and the keys that relations bind are always selected.

### 1.2 Joins and relations

```json
Join = {"rel": "service_model", "kind": "inner | left", "left": "service_seq", "right": "seq", "query": Query}
Relation = {"rel": "writer", "kind": "one | many", "left": "user_seq", "right": "seq", "query": Query,
            "key_by": "user_seq", "flatten": false, "limit_per_parent": 2,
            "if_parent": {"column": "is_close", "p": 4}, "no_cascade_delete": false}
```

- `rel` is the result name. `left` is a column of the parent and `right` a column of the child.
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
      | {"conn", "op": "match | match_boolean", "match": ["name", "description"], "p"}
      | {"conn", "op": "tuple_in | tuple_not_in", "cols": ["tenant_id", "account_id"], "ps": [0, 1, 2, 3]}
      | {"conn", "column", "op": "in | not_in", "sub": Sub}
      | {"conn", "column", "op", "p", "fn": Func}
      | {"conn", "column", "op", "value": Func}
      | {"conn", "expr": "{read_count} > ?", "ps": [0]}
Func  = {"name": "day_of_week | year | month | date | distance | point_x | point_y | now | today | days_ago | …", "ps": [0, 1]}
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

## 2. Plan

```json
{
  "schema_hash": "…", "kind": "all",
  "steps": [
    {"id": 0, "role": "main", "sql": "SELECT `a`.`seq` AS `a__seq`, … FROM `battle` AS `a` … LIMIT 0, 20",
     "bind_slots": [{"from": "param", "param": 0}, {"from": "secret", "name": "aes"}],
     "assemble": {"entity": "battle", "alias": "a",
                  "columns": [{"index": 0, "name": "seq", "column": "seq", "type": "i64"}],
                  "key": [{"column": "seq", "index": 0}],
                  "children": [{"rel": "service_model", "kind": "join", "assemble": {…}}]}},
    {"id": 1, "role": "relation", "sql": "…", "bind_slots": [{"from": "parent"}], "parent": {"step": 0, "keys": [{"column": "user_seq", "index": 14}]}}
  ]
}
```

- `bind_slots.from` is `param` (a request parameter, with `transform` for full-text and contains values and `host_styles` for AES, hex, and IP stages), `secret` (the AES key), `config` (the AES key version), `parent` (relation key values), or `now` (the client clock in the connection time zone).
- Rows are read by position. `assemble.columns[].styles` lists the codec stages the client decodes; SQL-side stages are already applied.
- `assemble.key` is the collection identity: every primary-key component, or the group columns of a `group_count` row.
- `children[].kind` is `join` for a child in the same row, and `one` or `many` for a relation step matched by `parent_keys` and `child_keys`.

### 2.1 Relation steps

- Each relation has one `relation` step after its parent step; nested relations follow the same rule, and `paginate` orders the steps as main, relations, count.
- The client reads the parent keys of every parent row in order, removes rows with a null key, removes duplicates, and skips the statement when no key remains. With `if_parent`, only parents whose column equals the parameter are used.
- The `parent` slot is one placeholder that the client expands to the key list. The list is padded to a power of two by repeating the last key, so one prepared statement serves each size class. A list longer than the driver bind limit is split into chunks.
- `one` attaches the first child row and `many` a collection in child order; a duplicate collection key keeps the last row.

## 3. Errors

Errors carry a code from [errors.yaml](errors.yaml) and a message, for example `IR_INVALID`, `SCHEMA_HASH_MISMATCH`, `COLUMN_UNKNOWN`, `OPERATOR_NOT_ALLOWED`, `FUNCTION_UNKNOWN`, `EMPTY_IN`, `LIMIT_IN_RELATION`, and `COLUMN_ALIAS_CONFLICT`. Executors add `CONFIG`, `OPTIMISTIC_LOCK`, `LOCK_NOT_AVAILABLE`, `DEADLOCK`, `DUPLICATE_KEY`, `FOREIGN_KEY`, `CONSTRAINT`, and `READ_ONLY`. A NOWAIT lock failure is always `LOCK_NOT_AVAILABLE` and is not retried as a transaction conflict.

## 4. Planning in the client

Every client validates and plans requests in the application process. No compiler service, daemon, or extension is involved.

| Client | Validation, planning, dialects, and DDL |
|---|---|
| Go | `engine/ir`, `engine/planner`, `engine/dialect`, `internal/ormgen` DDL |
| PHP | `clients/php/src/Validator.php`, `Planner.php`, `Dialect.php`, `Ddl.php` |
| Rust | `clients/rust/orm/src/engine/` |
| TypeScript | `clients/typescript/src/engine/` |

A connection loads `schema.json`, verifies its `schema_hash` against its content, and rejects generated models with a different hash (`SCHEMA_HASH_MISMATCH`). The plan cache key is the schema hash and the request shape. Parameter values are not part of the key.

The four planners produce the same SQL and bind slots for the same request. `tests/conformance` runs the same vectors in the four clients on MySQL, PostgreSQL, and SQLite and compares the statements, binds, and results with the recorded expectations.
