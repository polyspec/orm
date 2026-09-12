# protocol.md — IR(JSON)에서 Plan(JSON)으로

클라이언트는 [docs/dsl.md](dsl.md)의 호출 체인을 아래 IR로 변환하고 형태 해시로 Plan을 캐시한다. 타입 정의는 `engine/ir/ir.go`와 `engine/plan/plan.go`를 기준으로 한다.

## 1. 요청
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
  "distinct":  false,
  "force_index": "ik",
  "agg": "amount",                                  // sum/avg
  "set": [{"column","value"} | {"column","expr","binds"} | {"column","plus"} | {"column","minus"}],   // insert/update
  "optimistic": {"column": "updated_ts", "value": "…"},                                                 // update
  "debug": false
}
```
`Query` (shared by root, join child, and relation child) = `entity columns on where joins relations order group_by group_by_expr limit distinct force_index` plus relation options.

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
- 연속 술어는 AND를 사용한다. `or()` 토큰은 다음 항목에 `conn: "or"`를 설정한다. `and(fn)`/`or(fn)` creates a `group`. `<rel>(fn)` creates `nav`; that relation must be joined in the current statement.
- A join child's `on` is ON. Its `where` is added to the parent WHERE in parentheses. The client does not create the terminal predicate for a join child chain (`JOIN_PREDICATE_PLACEMENT`).
- `expr`의 백틱 컬럼을 검사하고 현재 엔티티 기준으로 별칭을 치환한다. `?` values use `binds` order.

## 2. Plan
```json
{
  "schema_hash": "…", "kind": "all",
  "steps": [
    {"id": 0, "role": "main", "sql": "SELECT `a`.`seq` AS `a__seq`, … FROM `battle` AS `a` … LIMIT 0, 20",
     "bind_slots": [{"from": "secret", "name": "aes"}, {"from": "param", "value": 5}, …],
     "assemble": {"entity": "battle", "alias": "a",
                  "columns": [{"index": 0, "name": "seq", "column": "seq", "type": "i64"}, {"index": 23, "name": "aes_hex_email", "column": "aes_hex_email", "type": "string"}],
                  "children": [{"rel": "campaign", "kind": "join", "assemble": {…}}]}},
    {"id": 1, "role": "count", "sql": "SELECT COUNT(*) FROM …", "bind_slots": […]}
  ]
}
```
- `bind_slots.from`: `param` (IR values; the executor applies aes/hex/ip when `host_styles` exists, and normalizes date/time/datetime values using the client representation) · `secret` (the executor AES key) · `parent` (relation IN values from the parent rows, expanded to N values) · `now` (executor UTC microsecond text for timestamps such as SQLite `updated_ts`).
- 결과는 `index`로 매핑한다. SELECT aliases such as `alias__col` are for debug output; the executor does not inspect their names.
- `assemble.columns[].styles` are application decode stages such as gz/json/serialize. SQL stages such as aes/hex/ip are already in SQL.
- `children[].kind`: `join` (a fragment of the same row with `assemble`) · `one`/`many` (rows from another step attached through `parent_index`/`child_index`, assembled from `steps[step].assemble`).

### 관계 단계 (S2)
- Each relation has one step with `role: relation`, after its parent step. Nested and join-child relations follow the same rule; paginate is main → relations → `count`.
- `step.parent = {step, column, index, if_parent?{column, index, param}}`: the executor reads the parent step's `index`, removes nulls, and deduplicates in first-seen order. With `if_parent`, only parent rows equal to `params[param]` are used. No query is issued when the value set is empty.
- A SQL `parent` slot is one `?`; the executor expands it to N placeholders. N is rounded up to a power of two by repeating the last value. All clients use the same rule.
- User `IN` lists use the same padding rule before the builder creates IR. This keeps one prepared statement per size class instead of one per list length.
- `children[].kind = one` attaches the first child row; `many` creates a key map using `key_index`, retaining row order and using the last row for duplicate keys. Parents excluded by `if_parent` receive null or an empty collection.
- `limit_per_parent n` uses a `ROW_NUMBER() OVER (PARTITION BY right ORDER BY …)` subquery. Output column order is unchanged.
- `flatten` is one-only. It merges child columns into array/JSON output; a parent column wins on name collision. Typed accessors remain available.
- `drop_child_key` sets `columns[].hidden = true`; the match column remains available to binding and key construction and is omitted only from array/JSON output.
- `columns[].styles` are decoded in reverse order immediately after reading a row (`docs/codec.md`). MySQL JSON values may already be parsed by the driver.
- `key_by` is many-only, `flatten` is one-only, and `if_parent.column` must belong to the parent entity. Violations return `IR_INVALID`.

## 3. 오류
`{"error": {"code": "…", "msg": "…"}}` — codes: `IR_INVALID VERSION_MISMATCH SCHEMA_HASH_MISMATCH SCHEMA_INVALID SCHEMA_NOT_LOADED ENTITY_UNKNOWN COLUMN_UNKNOWN RELATION_UNKNOWN INDEX_UNKNOWN OPERATOR_UNKNOWN OPERATOR_NOT_ALLOWED OR_AT_GROUP_START EMPTY_IN ENTITY_NOT_JOINED LIMIT_IN_RELATION COLUMN_ALIAS_CONFLICT DIALECT_UNKNOWN FRAME_INVALID OP_UNKNOWN INTERNAL`. Executor codes include `OPTIMISTIC_LOCK DEADLOCK DUPLICATE_KEY JOIN_PREDICATE_PLACEMENT PAREN_ACROSS_MODELS`.

## 4. 전송

공통 compiler service는 `proto/orm/compiler/v1/compiler.proto`의 `orm.compiler.v1.CompilerService`다.

| RPC | Connect 경로 | 입력 | 출력 |
|---|---|---|---|
| Compile | `/orm.compiler.v1.CompilerService/Compile` | `CompileRequest` | `CompileResponse.plan` 또는 `CompileResponse.error` |
| GetMetadata | `/orm.compiler.v1.CompilerService/GetMetadata` | `GetMetadataRequest` | schema hash, dialect, IR version |

`ormd -listen 127.0.0.1:8080 -schema schema/schema.json`은 binary Protobuf를 사용하는 Connect unary request를 처리한다. Go·PHP·Rust·TypeScript는 같은 두 작업을 가진 `CompilerTransport`와 `ConnectCompiler`를 제공한다. `make proto-check`는 scope를 포함한 request를 네 구현으로 실행하고 정규화한 전체 결과를 비교한다.

`contracts/interfaces.json`은 네 전송 구현의 service 경로, 작업 이름, request·response type, 오류, 언어별 symbol을 정의한다. Protobuf 검사는 interface method나 구현 선언이 누락되면 실패한다. Runtime symbol snapshot은 생성된 Protobuf 파일을 제외하며, 해당 파일은 `proto/generated.sha256.json`이 모두 검사한다.

Go와 Rust database executor는 plan cache miss를 모두 `CompilerTransport`로 compile한다. 시작 단계에서 schema hash, dialect, IR version metadata 불일치를 거부한다. 두 executor의 SQLite DB vector 58개가 Connect 경로를 통과했다. PHP는 길이 prefix Unix socket을 사용하고 TypeScript에는 database executor가 없다. 이 미완료 경로는 전송 완료 조건을 충족하지 않는다. 네 executor가 Connect를 사용하고 네 언어에서 DB vector 58개가 통과하면 T7.1이 완료된다.

Cache key는 schema hash, request 형태, IN cardinality로 구성한다. Parameter 값은 제외한다.

### 쓰기 확장 (S3)
- `on_duplicate: [Assign]` is insert-only and excludes PK/auto. The planner creates `INSERT … ON DUPLICATE KEY UPDATE a = ?, b = b + ?[, pk = LAST_INSERT_ID(pk)]`. The executor reads the row again by that id.
- `no_cascade_delete: true` sets `children[].cascade = false`. Cascade applies only when the related row has the foreign key to the current row. `deleteCascade` removes loaded cascade relations depth first, then removes the current row. A parent-side relation is never removed.
- `save`, query `update`/`delete`, and `sql` are executor rules without additional IR (`docs/lanes/s3.md`).

### 집계 확장 (S4)
- `kind`: `count_distinct`, `min`, and `max` with `agg` as the column. `count` with `group_by` returns the number of groups.
- `group_by_expr`: `{expr, as}` entries. Backtick columns use the current entity; `as` is the output name for `getsCount`. Bind values are unsupported.
- `having: Group` is root-only and requires `group_by` or `group_by_expr`. It uses the same group syntax and aggregate `expr` items.

### 방언 (S6)
Plan 형태는 방언과 무관하다. Dialect handling changes identifier quoting, placeholders, LIKE, upsert, fulltext, and SQL-side versus application-side style stages according to `docs/dialects.md`. 지원하지 않는 연산자는 컴파일 시 `OPERATOR_NOT_ALLOWED`로 실패한다.
