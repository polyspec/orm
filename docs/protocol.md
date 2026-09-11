# protocol.md — IR(JSON) → Plan(JSON)

클라이언트는 `docs/dsl.md`의 체인을 아래 IR로 렌더해 엔진에 넘기고, Plan을 형태 해시로 캐시한다. 타입 정의는 `engine/ir/ir.go`, `engine/plan/plan.go`가 기준이다.

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
  "distinct":  false,
  "force_index": "ik",
  "agg": "amount",                                  // sum/avg
  "set": [{"column","value"} | {"column","expr","binds"} | {"column","plus"} | {"column","minus"}],   // insert/update
  "optimistic": {"column": "updated_ts", "value": "…"},                                                 // update
  "debug": false
}
```
`Query`(루트·조인 자식·관계 자식 공통) = `entity columns on where joins relations order group_by group_by_expr limit distinct force_index` + 관계 옵션.

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
- `bind_slots.from`: `param`(IR의 값; `host_styles`가 있으면 실행기가 aes/hex/ip를 적용해 바인드, `col_type`이 date/time/datetime이면 그 언어의 날짜 표현으로 정규화) · `secret`(실행기 설정의 AES 키) · `parent`(관계 IN — 단계의 `parent`가 가리키는 부모 행 값, N개로 확장. 아래 "관계 단계") · `now`(실행기의 UTC 마이크로초 타임스탬프 텍스트; SQLite처럼 초 이하 시계 함수가 없는 방언의 `updated_ts`).
- 결과 매핑은 위치(`index`)로. SELECT 별칭 `alias__col`은 디버그 가독성용이며 실행기는 이름을 보지 않는다.
- `assemble.columns[].styles`는 앱측 디코드 단계(gz/json/serialize 등). SQL측(aes/hex/ip)은 이미 SQL에 들어가 있다.
- `children[].kind`: `join`(같은 행의 조각, `assemble` 있음) · `one`/`many`(다른 단계 `step`의 행을 `parent_index`/`child_index` 값으로 부착, 조립은 `steps[step].assemble`).

### 관계 단계 (S2)
- 관계마다 step 하나(`role: relation`), 부모 step 뒤에 온다(중첩·조인 하위 관계도 같은 규칙, paginate는 main → 관계… → `count`).
- `step.parent = {step, column, index, if_parent?{column, index, param}}`: 실행기는 부모 step의 행에서 `index` 위치 값을 **null 제외·처음 본 순서로 dedup**하고, `if_parent`가 있으면 `params[param]`과 같은 부모 행만 쓴다. 값이 0개면 **질의하지 않고** 빈 결과로 둔다.
- SQL의 `parent` 슬롯은 `?` 하나다. 실행기가 그 자리를 N개 `?`로 바꾼다. N은 값 개수를 **2의 거듭제곱으로 올림**(마지막 값 반복으로 패딩) — prepared statement 캐시가 크기 등급당 하나만 갖도록. 세 언어 동일.
- **사용자 IN 목록도 같은 규칙**: `in`/`not_in` 술어의 값은 빌더가 IR을 만들기 전에 2의 거듭제곱으로 패딩한다(마지막 값 반복 — 중복은 IN/NOT IN 결과를 바꾸지 않는다). 패딩이 없으면 목록 길이마다 플랜과 서버측 prepared statement가 따로 생겨 개수가 길이에 비례해 늘어난다(MySQL `max_prepared_stmt_count` 기본 16382). 세 언어의 빌더가 같은 자리에서 같은 규칙으로 패딩하므로 문장·바인드가 동일하다.
- 부착: `children[]`의 `kind one` = 자식 행 중 첫 행(자식 ORDER가 있으면 planner가 per-parent 1 window로 이미 잘라 옴), `many` = `key_index` 값으로 키 맵(행 순서 유지, 중복 키는 last-wins). `if_parent`를 통과 못한 부모는 null/빈 컬렉션.
- `limit_per_parent n`: `SELECT <출력 컬럼> FROM (… , ROW_NUMBER() OVER (PARTITION BY right ORDER BY …) AS orm_rn …) AS orm_w WHERE orm_w.orm_rn <= n ORDER BY orm_w.right, orm_w.orm_rn`. 출력 컬럼 순서는 window 없는 경우와 같다.
- `flatten`(one 전용): 배열/JSON 형태(PHP `toArray`/`['x']`, Go/Rust의 배열 변환)에서 자식 컬럼을 부모에 병합한다. 부모에 같은 이름이 있으면 부모가 이긴다. typed 접근자(`GetUser()`/`user()`)는 그대로 있다.
- `drop_child_key`: 자식의 매치 컬럼이 `columns[].hidden = true`. 바인딩·키에는 쓰이고 배열/JSON 형태에서만 빠진다.
- `columns[].styles`(실행기 코덱 단계, 쓰기 순서): 실행기는 행을 읽은 직후 역순으로 디코드한다(`docs/codec.md`). `aes`/`hex`/`ip`는 여기 오지 않는다(SQL 식으로 이미 처리). MySQL `JSON` 타입 컬럼은 드라이버가 파싱해 주기도 하므로 `json` 단일 스타일은 파싱된 값을 그대로 받아들인다.
- `key_by`는 many 전용, `flatten`은 one 전용, `if_parent.column`은 **부모** 엔티티의 컬럼(`COLUMN_UNKNOWN`) — 위반은 `IR_INVALID`.

## 3. 에러
`{"error": {"code": "…", "msg": "…"}}` — 코드: `IR_INVALID VERSION_MISMATCH SCHEMA_HASH_MISMATCH SCHEMA_INVALID SCHEMA_NOT_LOADED ENTITY_UNKNOWN COLUMN_UNKNOWN RELATION_UNKNOWN INDEX_UNKNOWN OPERATOR_UNKNOWN OPERATOR_NOT_ALLOWED OR_AT_GROUP_START EMPTY_IN ENTITY_NOT_JOINED LIMIT_IN_RELATION COLUMN_ALIAS_CONFLICT DIALECT_UNKNOWN FRAME_INVALID OP_UNKNOWN INTERNAL`. 실행기 측: `OPTIMISTIC_LOCK DEADLOCK DUPLICATE_KEY JOIN_PREDICATE_PLACEMENT PAREN_ACROSS_MODELS`.

## 4. 전송
- Go: `engine.New(manifest, "mysql").Compile(ir)` 함수 호출.
- Rust: `ormengine.wasm` — `orm_alloc/orm_load/orm_compile/orm_free`(결과 `[u32 status][u32 len][bytes]`).
- PHP: `ormd -socket /abs/path.sock -schema /abs/schema.json` — 길이 접두 프레임, `{"op":"compile","ir":…}` → `{"plan":…}`, `{"op":"hash"}` → `{"schema_hash":…}`.
- 캐시 키 = xxh3(IR에서 값(`value/values/binds`)을 제거한 형태 JSON + IN 카디널리티) + schema_hash.

### 쓰기 확장 (S3)
- `on_duplicate: [Assign]`(insert 전용, PK/auto 금지): planner가 `INSERT … ON DUPLICATE KEY UPDATE a = ?, b = b + ?[, pk = LAST_INSERT_ID(pk)]`를 만든다. auto PK가 있으면 마지막 항목을 항상 붙여 갱신 시에도 last insert id가 기존 행을 가리키게 한다(MySQL 관용구). 실행기의 `insert`는 이 id로 행을 다시 읽어 돌려준다.
- `no_cascade_delete: true`(관계 자식 옵션) → `children[].cascade = false`. `cascade`는 "대상 행이 이 행의 FK를 갖는다"(관계 left = 부모 PK, right ≠ 대상 PK)일 때만 true. 실행기의 `deleteCascade`는 cascade=true인 로드된 관계를 깊이 우선으로 지우고 자기 행을 지운다(행마다 `DELETE … WHERE pk = ?`, Db를 받으면 트랜잭션으로 감싼다). 부모 방향(one, FK가 이 행에 있음)은 절대 지우지 않는다.
- `save`·쿼리 `update`/`delete`·`sql`은 IR 추가 없이 실행기 규칙이다(`docs/lanes/s3.md`).

### 집계 확장 (S4)
- `kind`: `count_distinct`·`min`·`max`(`agg` = 컬럼; 스타일 컬럼·json·bytes 불가). `count` + `group_by`는 **그룹 수**: `SELECT COUNT(*) FROM (SELECT 1 … GROUP BY …[ HAVING …]) AS orm_g`.
- `group_by_expr`: `{expr, as}` 목록. `expr`는 백틱 컬럼을 현재 엔티티로 해석하는 신뢰된 SQL 조각이고, `as`는 `getsCount` 행에서 사용할 출력 이름이다. `?` 바인드는 지원하지 않는다.
- `having: Group`(루트 전용, `group_by` 또는 `group_by_expr` 필수): where와 같은 그룹 문법; 집계식은 `expr` 항목(`COUNT(*) > ?`)으로 쓴다. 행 select(`one/all`)와 그룹 수에 붙고 스칼라 집계에는 무시된다.

### 방언 (S6)
플랜 형식은 방언과 무관하다. 방언은 `docs/dialects.md`에 따라 식별자·플레이스홀더·LIKE·upsert·fulltext·스타일의 SQL측/앱측 분담만 바꾼다. `columns[].styles`는 "실행기가 처리할 나머지"이므로 PostgreSQL/SQLite에서는 `aes`/`hex`(그리고 SQLite의 `ip`)도 여기 나타난다. 방언이 지원하지 않는 연산자는 컴파일 시 `OPERATOR_NOT_ALLOWED`.
