# protocol.md — IR(JSON) to Plan(JSON)

The client renders the chain from [docs/dsl.md](dsl.md) into the IR below and caches plans by shape hash. The type definitions in `engine/ir/ir.go` and `engine/plan/plan.go` are authoritative.

## 1. Request
```json
{
  "ir_version": 1,
  "schema_hash": "cd21c76a45bcb2dd",
  "kind": "one | all | count | group_count | count_distinct | sum | avg | min | max | paginate | insert | update | delete",
  "entity": "battle",
  "columns": {"mode": "" | "all" | "none", "add": [], "remove": [], "as": {"out": "col"}, "expr": {"out": "ST_Y(`location`)"}},
  "joins":     [{"rel": "campaign", "kind": "inner|left", "query": { …Query…, "on": Group }}],
  "where":     Group,
  "relations": [{"rel": "items", "query": { …Query…, "key_by": "col", "flatten": true, "limit_per_parent": 3, "if_parent": {"column","value"}, "drop_child_key": true }}],
  "order":     [{"column": "seq", "desc": true} | {"expr": "…"}],
  "group_by":  ["seq"],
  "group_by_expr": [{"expr": "ROUND(`score`)", "as": "score_bucket"}],
  "limit":     {"offset": 0, "count": 20},
  "keyset":    {"direction": "after|before", "values": [parameter indexes]},
  "distinct":  false,
  "force_index": "ik",
  "agg": "amount",                                  // sum/avg
  "set": [{"column","value"} | {"column","expr","binds"} | {"column","plus"} | {"column","minus"}],   // insert/update
  "optimistic": {"column": "updated_ts", "value": "…"},                                                 // update
  "debug": false
}
```
`Query` (shared by root, join child, and relation child) = `entity columns on where joins relations order group_by group_by_expr limit distinct force_index` plus relation options. A root keyset request adds `keyset: {"direction":"after|before","values":[parameter indexes]}`; values follow the normalized order, including missing primary-key columns. Keyset requires a positive limit with offset zero and rejects joins or relations as cursor order sources.

### Group / Item
```json
Group = {"conn": "and|or", "items": [Item…]}          // conn = connector to the preceding sibling; absent for the first item
Item = {"pred": Pred} | {"group": Group} | {"nav": {"conn", "rel": "campaign", "group": Group}}
Pred  = {"conn", "column", "op", "value"}                       // eq not_eq gt gte lt lte like like_binary contains starts_with ends_with
      | {"conn", "column", "op": "in|not_in|between", "values": [...]}
      | {"conn", "column", "op": "is_null|is_not_null"}
      | {"conn", "column", "op": "eq_col|…", "ref": {"path": "campaign/service", "column": "seq"}}
      | {"conn", "op": "match|match_boolean", "match": ["name","description"], "value": "kw"}
      | {"conn", "expr": "DAYOFWEEK(`created_ts`) = ?", "binds": [1]}
```
- Consecutive predicates use AND. The `or()` token sets `conn: "or"` on the next item. `and(fn)`/`or(fn)` creates a `group`. `<rel>(fn)` creates `nav`; that relation must be joined in the current statement.
- A join child's `on` is ON. Its `where` is added to the parent WHERE in parentheses. The client does not create the terminal predicate for a join child chain (`JOIN_PREDICATE_PLACEMENT`).
- Backtick columns in `expr` are checked and aliases are substituted for the current entity. `?` values use `binds` order.

## 2. Plan
```json
{
  "schema_hash": "…", "kind": "all",
  "steps": [
    {"id": 0, "role": "main", "sql": "SELECT `a`.`seq` AS `a__seq`, … FROM `battle` AS `a` … LIMIT 0, 20",
     "bind_slots": [{"from": "secret", "name": "aes"}, {"from": "param", "value": 5}, …],
     "assemble": {"entity": "battle", "alias": "a",
                  "columns": [{"index": 0, "name": "seq", "column": "seq", "type": "i64"}, {"index": 23, "name": "aes_hex_email", "column": "aes_hex_email", "type": "string"}],
                  "key": [{"column": "seq", "index": 0}],
                  "children": [{"rel": "campaign", "kind": "join", "assemble": {…}}]}},
    {"id": 1, "role": "count", "sql": "SELECT COUNT(*) FROM …", "bind_slots": […]}
  ]
}
```
- `bind_slots.from`: `param` (IR values; the executor applies aes/hex/ip when `host_styles` exists, and normalizes date/time/datetime values using the client representation) · `secret` (the executor AES key) · `parent` (relation IN values from the parent rows, expanded to N values) · `now` (executor UTC microsecond text for timestamps such as SQLite `updated_ts`).
- Result mapping uses `index`. SELECT aliases such as `alias__col` are for debug output; the executor does not inspect their names.
- `assemble.columns[].styles` are application decode stages such as gz/json/serialize. SQL stages such as aes/hex/ip are already in SQL.
- `assemble.key` is the ordered collection identity. A regular row uses every primary-key component. A `group_count` row uses each `group_by` column followed by each `group_by_expr` alias.
- `children[].kind`: `join` stores a same-row `assemble`; `one` and `many` attach rows from another step by ordered `parent_keys` and `child_keys` arrays.

### Relation stages (S2)
- Each relation has one step with `role: relation`, after its parent step. Nested and join-child relations follow the same rule; paginate is main → relations → `count`.
- `step.parent = {step, keys:[{column,index},...], if_parent?{column,index,param}}`: the executor reads each key tuple in array order, removes tuples containing null, and deduplicates tuples in first-seen order. With `if_parent`, only parent rows equal to `params[param]` are used. No query is issued when the tuple set is empty.
- A SQL `parent` slot is one placeholder. The executor expands it to N scalar placeholders for one key component or N parenthesized tuples for multiple components. N is rounded up to a power of two by repeating the last complete tuple. Go, PHP, Rust, and TypeScript use the same rule.
- User `IN` lists use the same padding rule before the builder creates IR. This keeps one prepared statement per size class instead of one per list length.
- When a root positive `IN` request exceeds the driver parameter limit, Go, PHP, Rust, and TypeScript split the list into power-of-two chunks, preserve the other parameters, merge row results, and sum count results. Queries with ordering, limits, distinct, grouping, having, keyset, or `NOT IN` are rejected with `IR_INVALID` when splitting would change their meaning.
- `children[].kind = one` attaches the first child row. `many` creates a key map from the ordered `key` references, retains row order, and uses the last row for a duplicate key. Parents excluded by `if_parent` receive null or an empty collection.
- `limit_per_parent n` uses a `ROW_NUMBER() OVER (PARTITION BY right ORDER BY …)` subquery. Output column order is unchanged.
- `flatten` is one-only. It merges child columns into array/JSON output; a parent column wins on name collision. Typed accessors remain available.
- `drop_child_key` sets `columns[].hidden = true`; the match column remains available to binding and key construction and is omitted only from array/JSON output.
- `columns[].styles` are decoded in reverse order immediately after reading a row (`docs/codec.md`). MySQL JSON values may already be parsed by the driver.
- `key_by` is many-only, `flatten` is one-only, and `if_parent.column` must belong to the parent entity. Violations return `IR_INVALID`.

## 3. Errors
`{"error": {"code": "…", "msg": "…"}}` — codes: `IR_INVALID CAPABILITY_UNSUPPORTED VERSION_MISMATCH SCHEMA_HASH_MISMATCH SCHEMA_INVALID SCHEMA_NOT_LOADED ENTITY_UNKNOWN COLUMN_UNKNOWN RELATION_UNKNOWN INDEX_UNKNOWN OPERATOR_UNKNOWN OPERATOR_NOT_ALLOWED OR_AT_GROUP_START EMPTY_IN ENTITY_NOT_JOINED LIMIT_IN_RELATION COLUMN_ALIAS_CONFLICT DIALECT_UNKNOWN FRAME_INVALID OP_UNKNOWN INTERNAL`. Executor codes include `OPTIMISTIC_LOCK DEADLOCK DUPLICATE_KEY`.

## 4. Transport

The common compiler service is `orm.compiler.v1.CompilerService` from `proto/orm/compiler/v1/compiler.proto`.

| RPC | Connect path | Input | Output |
|---|---|---|---|
| Compile | `/orm.compiler.v1.CompilerService/Compile` | `CompileRequest` | `CompileResponse.plan` or `CompileResponse.error` |
| GetMetadata | `/orm.compiler.v1.CompilerService/GetMetadata` | `GetMetadataRequest` | schema hash, dialect, IR version |

`ormd -listen 127.0.0.1:8080 -schema schema/schema.json` accepts Connect unary requests with binary Protobuf. Go, PHP, Rust, and TypeScript provide `CompilerTransport` and `ConnectCompiler` with the same two operations. `make proto-check` executes one scope-sensitive request through all four implementations and compares the complete normalized result.

`contracts/interfaces.json` defines the service path, operation names, request and response types, errors, and native symbols for all four transports. The Protobuf check rejects missing interface methods or implementation declarations. Runtime symbol snapshots exclude generated Protobuf files; `proto/generated.sha256.json` checks every generated file instead.

The Go, PHP, Rust, and TypeScript database executors compile every plan-cache miss through the configured `CompilerTransport`; startup rejects mismatched schema hash, dialect, and IR version metadata. The default compiler paths are Go in-process, Rust WASM, PHP Unix socket, and TypeScript Connect/Protobuf. Connect is also the shared compiler service implementation for all four clients. All four executors pass 63 vectors on MySQL, PostgreSQL, and SQLite through their declared compiler implementation.

The cache key is the schema hash plus the request shape and IN cardinality. Parameter values are excluded.

### Write extension (S3)
- `on_duplicate: [Assign]` is insert-only and excludes PK/auto. The planner creates `INSERT … ON DUPLICATE KEY UPDATE a = ?, b = b + ?[, pk = LAST_INSERT_ID(pk)]`. The executor reads the row again by that id.
- `no_cascade_delete: true` sets `children[].cascade = false`. Cascade applies only when the related row has the foreign key to the current row. `deleteCascade` removes loaded cascade relations depth first, then removes the current row. A parent-side relation is never removed.
- `save`, query `update`/`delete`, and `sql` are executor rules without additional IR (`docs/lanes/s3.md`).

### Aggregate extension (S4)
- `kind`: `count_distinct`, `min`, and `max` with `agg` as the column. `count` with `group_by` returns the number of groups.
- `group_by_expr`: `{expr, as}` entries. Backtick columns use the current entity; `as` is the output name for `getsCount`. Bind values are unsupported.
- `having: Group` is root-only and requires `group_by` or `group_by_expr`. It uses the same group syntax and aggregate `expr` items.

### Dialects (S6)
The plan shape is independent of dialect. Dialect handling changes identifier quoting, placeholders, LIKE, upsert, fulltext, and SQL-side versus application-side style stages according to `docs/dialects.md`. Unsupported operators fail at compile time with `OPERATOR_NOT_ALLOWED`.
