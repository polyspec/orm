# protocol.md — IR(JSON) → Plan(JSON)

클라이언트는 `docs/dsl.md`의 체인을 아래 IR로 렌더해 엔진에 넘기고, Plan을 형태 해시로 캐시한다. 타입 정의는 `engine/ir/ir.go`, `engine/plan/plan.go`가 기준이다.

## 1. Request
```json
{
  "ir_version": 1,
  "schema_hash": "cd21c76a45bcb2dd",
  "kind": "one | all | count | sum | avg | paginate | insert | update | delete",
  "entity": "battle",
  "columns": {"mode": "" | "all" | "none", "add": [], "remove": [], "as": {"out": "col"}, "expr": {"out": "ST_Y(`location`)"}},
  "joins":     [{"rel": "campaign", "kind": "inner|left", "query": { …Query…, "on": Group }}],
  "where":     Group,
  "relations": [{"rel": "items", "query": { …Query…, "key_by": "col", "flatten": true, "limit_per_parent": 3, "if_parent": {"column","value"}, "drop_child_key": true }}],
  "order":     [{"column": "seq", "desc": true} | {"expr": "…"}],
  "group_by":  ["seq"],
  "limit":     {"offset": 0, "count": 20},
  "distinct":  false,
  "force_index": "ik",
  "agg": "amount",                                  // sum/avg
  "set": [{"column","value"} | {"column","expr","binds"} | {"column","plus"} | {"column","minus"}],   // insert/update
  "optimistic": {"column": "updated_ts", "value": "…"},                                                 // update
  "debug": false
}
```
`Query`(루트·조인 자식·관계 자식 공통) = `entity columns on where joins relations order group_by limit distinct force_index` + 관계 옵션.

### Group / Item
```json
Group = {"conn": "and|or", "items": [Item…]}          // conn = 앞 형제와의 연결자, 첫 항목은 없음
Item  = {"pred": Pred} | {"group": Group} | {"nav": {"conn", "rel": "campaign", "group": Group}}
Pred  = {"conn", "column", "op", "value"}                       // eq not_eq gt gte lt lte like like_binary contains starts_with ends_with
      | {"conn", "column", "op": "in|not_in|between", "values": [...]}
      | {"conn", "column", "op": "is_null|is_not_null"}
      | {"conn", "column", "op": "eq_col|…", "ref": {"path": "campaign/service", "column": "seq"}}
      | {"conn", "op": "match|match_boolean", "match": ["name","description"], "value": "kw"}
      | {"conn", "expr": "DAYOFWEEK(`created_ts`) = ?", "binds": [1]}
```
- 술어 연속 = AND. `or()` 토큰은 다음 항목의 `conn: "or"`. `and(fn)/or(fn)` = `group`. `<rel>(fn)` = `nav`(그 관계가 이 문장에서 조인되어 있어야 함).
- 조인 자식의 `on` = ON, `where` = 부모 WHERE에 `(…)`로 AND. 조인 자식 체인의 맨 술어는 클라이언트가 만들지 않는다(`JOIN_PREDICATE_PLACEMENT`).
- `expr`의 백틱 컬럼은 현재 엔티티로 검사·alias 치환. `?`는 `binds` 순서.

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
- `bind_slots.from`: `param`(IR의 값) · `secret`(실행기 설정의 AES 키) · `parent`(S2: 관계 IN — 부모 단계 컬럼값 dedup, N개로 확장).
- 결과 매핑은 위치(`index`)로. SELECT 별칭 `alias__col`은 디버그 가독성용이며 실행기는 이름을 보지 않는다.
- `assemble.columns[].styles`는 앱측 디코드 단계(gz/json/serialize 등). SQL측(aes/hex/ip)은 이미 SQL에 들어가 있다.
- `children[].kind`: `join`(같은 행의 조각) · `one`/`many`(S2: 다른 단계의 행을 `parent_column`/`child_column`으로 부착).

## 3. 에러
`{"error": {"code": "…", "msg": "…"}}` — 코드: `IR_INVALID VERSION_MISMATCH SCHEMA_HASH_MISMATCH SCHEMA_INVALID SCHEMA_NOT_LOADED ENTITY_UNKNOWN COLUMN_UNKNOWN RELATION_UNKNOWN INDEX_UNKNOWN OPERATOR_UNKNOWN OPERATOR_NOT_ALLOWED OR_AT_GROUP_START EMPTY_IN ENTITY_NOT_JOINED LIMIT_IN_RELATION COLUMN_ALIAS_CONFLICT DIALECT_UNKNOWN FRAME_INVALID OP_UNKNOWN INTERNAL`. 실행기 측: `OPTIMISTIC_LOCK DEADLOCK DUPLICATE_KEY JOIN_PREDICATE_PLACEMENT PAREN_ACROSS_MODELS`.

## 4. 전송
- Go: `engine.New(manifest, "mysql").Compile(ir)` 함수 호출.
- Rust: `ormengine.wasm` — `orm_alloc/orm_load/orm_compile/orm_free`(결과 `[u32 status][u32 len][bytes]`).
- PHP: `ormd -socket /abs/path.sock -schema /abs/schema.json` — 길이 접두 프레임, `{"op":"compile","ir":…}` → `{"plan":…}`, `{"op":"hash"}` → `{"schema_hash":…}`.
- 캐시 키 = xxh3(IR에서 값(`value/values/binds`)을 제거한 형태 JSON + IN 카디널리티) + schema_hash.
