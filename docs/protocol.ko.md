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
                  "key": [{"column": "seq", "index": 0}],
                  "children": [{"rel": "campaign", "kind": "join", "assemble": {…}}]}},
    {"id": 1, "role": "count", "sql": "SELECT COUNT(*) FROM …", "bind_slots": […]}
  ]
}
```
- `bind_slots.from`: `param`은 IR 값이며 실행기가 `host_styles`의 aes/hex/ip 처리와 date/time/datetime 정규화를 적용한다. `secret`은 실행기 AES 키, `parent`는 부모 행에서 읽어 확장한 관계 값, `now`는 SQLite `updated_ts` 등에 사용하는 실행기 UTC 마이크로초 문자열이다.
- 결과는 `index`로 매핑한다. `alias__col` 같은 SELECT 별칭은 디버그 출력에만 사용하며 실행기는 별칭을 해석하지 않는다.
- `assemble.columns[].styles`는 gz/json/serialize 같은 애플리케이션 디코딩 단계다. aes/hex/ip 같은 SQL 단계는 SQL에 포함된다.
- `assemble.key`는 순서가 있는 collection 식별자다. 일반 행은 모든 primary key 구성요소를 사용한다. `group_count` 행은 각 `group_by` 컬럼 다음에 각 `group_by_expr` 별칭을 사용한다.
- `children[].kind`: `join`은 같은 행의 `assemble`을 저장한다. `one`과 `many`는 순서가 있는 `parent_keys`와 `child_keys` 배열로 다른 단계의 행을 연결한다.

### 관계 단계 (S2)
- 각 관계는 부모 단계 다음에 `role: relation`인 단계 하나를 사용한다. 중첩 관계와 join 하위 관계에도 같은 규칙을 적용한다. paginate 단계 순서는 main, relations, `count`다.
- `step.parent = {step, keys:[{column,index},...], if_parent?{column,index,param}}`: 실행기는 배열 순서대로 각 부모 키 튜플을 읽고, null을 포함한 튜플을 제거하며, 처음 확인한 순서대로 중복을 제거한다. `if_parent`가 있으면 `params[param]`과 같은 부모 행만 사용한다. 남은 튜플이 없으면 쿼리를 실행하지 않는다.
- SQL `parent` 슬롯은 플레이스홀더 하나다. 실행기는 단일 키를 N개 스칼라 플레이스홀더로 확장하고 복합 키를 N개 괄호 튜플로 확장한다. N은 마지막 완전한 튜플을 반복해 2의 거듭제곱으로 맞춘다. Go, PHP, Rust, TypeScript에 같은 규칙을 적용한다.
- 사용자가 지정한 `IN` 목록도 빌더가 IR을 생성하기 전에 같은 패딩 규칙을 적용한다. 목록 길이별로 prepared statement가 생성되는 것을 제한한다.
- `children[].kind = one`은 첫 번째 자식 행을 연결한다. `many`는 순서가 있는 `key` 참조로 키 맵을 생성하고 행 순서를 유지하며 중복 키에는 마지막 행을 사용한다. `if_parent`에서 제외된 부모에는 null 또는 빈 collection을 설정한다.
- `limit_per_parent n`은 `ROW_NUMBER() OVER (PARTITION BY right ORDER BY …)` 하위 쿼리를 사용한다. 출력 컬럼 순서는 바뀌지 않는다.
- `flatten`은 one 관계에만 사용할 수 있다. 자식 컬럼을 배열 또는 JSON 결과에 병합하고 이름이 같으면 부모 컬럼을 유지한다. 타입 accessor는 계속 사용할 수 있다.
- `drop_child_key`는 `columns[].hidden = true`를 설정한다. 연결 컬럼은 바인딩과 키 생성에 사용되며 배열 또는 JSON 결과에서만 제외된다.
- `columns[].styles`는 행을 읽은 직후 역순으로 디코딩한다(`docs/codec.ko.md`). MySQL 드라이버가 JSON 값을 먼저 파싱할 수 있다.
- `key_by`는 many 관계에만, `flatten`은 one 관계에만 사용할 수 있다. `if_parent.column`은 부모 엔터티에 포함되어야 한다. 위반하면 `IR_INVALID`를 반환한다.

## 3. 오류
`{"error": {"code": "…", "msg": "…"}}` — codes: `IR_INVALID CAPABILITY_UNSUPPORTED VERSION_MISMATCH SCHEMA_HASH_MISMATCH SCHEMA_INVALID SCHEMA_NOT_LOADED ENTITY_UNKNOWN COLUMN_UNKNOWN RELATION_UNKNOWN INDEX_UNKNOWN OPERATOR_UNKNOWN OPERATOR_NOT_ALLOWED OR_AT_GROUP_START EMPTY_IN ENTITY_NOT_JOINED LIMIT_IN_RELATION COLUMN_ALIAS_CONFLICT DIALECT_UNKNOWN FRAME_INVALID OP_UNKNOWN INTERNAL`. Executor codes include `OPTIMISTIC_LOCK DEADLOCK DUPLICATE_KEY`.

## 4. 전송

공통 compiler service는 `proto/orm/compiler/v1/compiler.proto`의 `orm.compiler.v1.CompilerService`다.

| RPC | Connect 경로 | 입력 | 출력 |
|---|---|---|---|
| Compile | `/orm.compiler.v1.CompilerService/Compile` | `CompileRequest` | `CompileResponse.plan` 또는 `CompileResponse.error` |
| GetMetadata | `/orm.compiler.v1.CompilerService/GetMetadata` | `GetMetadataRequest` | schema hash, dialect, IR version |

`ormd -listen 127.0.0.1:8080 -schema schema/schema.json`은 binary Protobuf를 사용하는 Connect unary request를 처리한다. Go·PHP·Rust·TypeScript는 같은 두 작업을 가진 `CompilerTransport`와 `ConnectCompiler`를 제공한다. `make proto-check`는 scope를 포함한 request를 네 구현으로 실행하고 정규화한 전체 결과를 비교한다.

`contracts/interfaces.json`은 네 전송 구현의 service 경로, 작업 이름, request·response type, 오류, 언어별 symbol을 정의한다. Protobuf 검사는 interface method나 구현 선언이 누락되면 실패한다. Runtime symbol snapshot은 생성된 Protobuf 파일을 제외하며, 해당 파일은 `proto/generated.sha256.json`이 모두 검사한다.

Go·PHP·Rust·TypeScript database executor는 설정된 `CompilerTransport`로 plan cache miss를 compile한다. 시작 단계에서 schema hash, dialect, IR version metadata 불일치를 거부한다. 기본 compiler 경로는 Go in-process, Rust WASM, PHP Unix socket, TypeScript Connect/Protobuf다. Connect는 네 client가 구현하는 공통 compiler service 경로이기도 하다. 네 executor는 각자 선언된 compiler 구현으로 MySQL·PostgreSQL·SQLite 벡터 59개를 통과한다.

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
