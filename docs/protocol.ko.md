# IR과 Plan 프로토콜

클라이언트는 [DSL](dsl.md)로 만든 모델을 아래 요청으로 변환하고, 애플리케이션 프로세스 안에서 요청을 plan으로 계획한 뒤 요청 형태를 키로 plan을 캐시한다. 타입 정의는 `engine/ir/ir.go`와 `engine/plan/plan.go`를 기준으로 하며, 모든 클라이언트가 같은 필드를 구현한다.

## 1. 요청

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

요청에는 값이 들어가지 않는다. 모든 값은 클라이언트가 가진 매개변수 목록의 위치이며, `n_params`는 그 목록의 길이다. 따라서 plan은 값과 무관하다.

| 필드 | 규칙 |
|---|---|
| `kind` | `one`과 `all`은 행을 읽고, `count`는 행이나 그룹 수를 계산하며, `group_count`는 `row_count`를 가진 그룹 행을 반환한다. `sum`과 `avg`는 `agg`를 집계하고, `paginate`는 페이지 문장과 개수 문장을 반환하며, `insert`, `update`, `delete`는 행을 쓴다 |
| `set` | `insert`와 `update`의 할당 |
| `rows` | 추가로 삽입할 각 행의 매개변수를 `set` 컬럼 순서로 나열한다. 이때 `set`의 모든 항목은 값 할당이어야 하며 `on_duplicate`는 사용할 수 없다 |
| `on_duplicate` | 삽입한 행이 기존 고유 키와 겹칠 때 적용하는 할당 |
| `optimistic` | `update`는 컬럼 값이 매개변수와 같을 때만 일치한다. 일치하는 행이 없으면 `OPTIMISTIC_LOCK`을 반환한다 |
| `lock` | 루트 행 조회에만 사용하며 클라이언트는 트랜잭션 안에서만 허용한다 |

`Query`는 루트, 조인 자식, 관계 자식, 서브쿼리가 함께 쓰는 형태로 `entity`, `columns`, `on`(조인 자식 전용), `where`, `joins`, `relations`, `order`, `group_by`, `group_by_expr`, `limit`, `force_index`, `lock`, 관계 옵션으로 이루어진다.

### 1.1 컬럼

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

- `mode`가 `""`이면 지연 로딩이 아닌 컬럼을, `all`이면 모든 컬럼을 선택하고, `none`이면 기본 키와 외래 키만 남긴다.
- `expr`, `fn`, `sub`는 이름이 있는 출력을 추가한다. 출력 명칭은 엔티티의 컬럼 명칭과 같을 수 없다.
- 기본 키와 관계가 바인드하는 키는 항상 선택한다.

### 1.2 조인과 관계

```json
Join = {"rel": "service_model", "kind": "inner | left", "left": "service_seq", "right": "seq", "query": Query}
Relation = {"rel": "writer", "kind": "one | many", "left": "user_seq", "right": "seq", "query": Query,
            "key_by": "user_seq", "flatten": false, "limit_per_parent": 2,
            "if_parent": {"column": "is_close", "p": 4}, "no_cascade_delete": false}
```

- `rel`은 결과 명칭이다. `left`는 부모의 컬럼이고 `right`는 자식의 컬럼이다.
- 조인 자식의 `on` 그룹은 `ON` 절에 추가한다. `where` 그룹은 `joined` 항목이 지정한 위치에 두며, 지정하지 않으면 부모 `WHERE`에 `AND`로 붙인다.
- 관계는 별도 문장으로 실행한다. `limit_per_parent`는 부모 키마다 자식 행 수를 제한하고, `if_parent`는 컬럼 값이 매개변수와 같은 부모에 대해서만 자식을 읽는다. `flatten`은 자식 컬럼을 부모 행에 합치고, `key_by`는 자식 컬렉션의 키를 정하며, `no_cascade_delete`는 재귀 삭제에서 관계를 제외한다.

### 1.3 그룹과 조건

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

- `conn`은 항목을 같은 그룹의 이전 항목에 연결한다. 첫 항목에는 연결자가 없다.
- `ref.path`는 SQL 문장 루트에서 시작하는 조인 경로(`""`는 루트, `a/b`는 중첩 조인)이거나, 서브쿼리를 소유한 모델을 뜻하는 `^`다.
- `fn`은 `p`와 비교하기 전에 `column`에 컬럼 함수를 적용한다. `value`는 `column`을 값 함수와 비교한다. 함수는 구조만 전달하며 각 dialect가 [dialect](dialects.md)의 설명대로 SQL을 만든다. 알 수 없는 함수는 `FUNCTION_UNKNOWN`을 반환한다.
- `expr` 조각은 소유 모델의 컬럼을 `{column}`으로 참조하고 `?` 값을 `ps` 순서로 바인드한다. 자리표시자 수는 바인드 수와 같아야 한다.
- `contains`와 `contains_binary`는 값을 와일드카드 사이에 바인드한다. `contains_binary`는 대소문자를 구분한다.

### 1.4 정렬과 할당

```json
Order  = {"column": "seq", "desc": true} | {"column": "start_dt", "fn": Func} | {"random": true} | {"expr": "{seq} DESC"}
Assign = {"column", "p"} | {"column", "null": true} | {"column", "expr", "ps"} | {"column", "plus_p"} | {"column", "minus_p"}
```

원시 정렬 표현식은 방향을 직접 포함한다. `minus_p`는 음수 값을 저장하지 않는다.

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

- `bind_slots.from`은 `param`(요청 매개변수. 전문 검색과 포함 검색 값에는 `transform`, AES·hex·IP 단계에는 `host_styles`가 있다), `secret`(AES 키), `config`(AES 키 버전), `parent`(관계 키 값), `now`(연결 시간대의 클라이언트 시각) 중 하나다.
- 행은 위치로 읽는다. `assemble.columns[].styles`는 클라이언트가 디코딩할 코덱 단계이며, SQL 단계는 이미 적용되어 있다.
- `assemble.key`는 컬렉션 식별자다. 기본 키의 모든 구성 요소이거나 `group_count` 행의 그룹 컬럼이다.
- `children[].kind`는 같은 행의 자식이면 `join`, `parent_keys`와 `child_keys`로 연결되는 관계 단계면 `one` 또는 `many`다.

### 2.1 관계 단계

- 관계마다 부모 단계 뒤에 `relation` 단계가 하나 있다. 중첩 관계도 같은 규칙을 따르며, `paginate`의 단계 순서는 본문, 관계, 개수다.
- 클라이언트는 모든 부모 행의 키를 순서대로 읽고, 키가 null인 행과 중복을 제거한다. 남은 키가 없으면 문장을 실행하지 않는다. `if_parent`가 있으면 컬럼 값이 매개변수와 같은 부모만 사용한다.
- `parent` 슬롯은 클라이언트가 키 목록으로 확장하는 자리표시자 하나다. 목록은 마지막 키를 반복해 2의 거듭제곱 길이로 맞추므로 크기 구간마다 준비된 문장 하나를 사용한다. 드라이버 바인드 한도보다 긴 목록은 나누어 실행한다.
- `one`은 첫 자식 행을, `many`는 자식 순서의 컬렉션을 붙인다. 컬렉션 키가 겹치면 마지막 행을 유지한다.

## 3. 오류

오류는 [errors.yaml](errors.yaml)의 코드와 메시지를 가진다. 예를 들어 `IR_INVALID`, `SCHEMA_HASH_MISMATCH`, `COLUMN_UNKNOWN`, `OPERATOR_NOT_ALLOWED`, `FUNCTION_UNKNOWN`, `EMPTY_IN`, `LIMIT_IN_RELATION`, `COLUMN_ALIAS_CONFLICT`가 있다. 실행기는 `CONFIG`, `OPTIMISTIC_LOCK`, `LOCK_NOT_AVAILABLE`, `DEADLOCK`, `DUPLICATE_KEY`, `FOREIGN_KEY`, `CONSTRAINT`를 추가한다. NOWAIT lock 실패는 항상 `LOCK_NOT_AVAILABLE`이며 transaction conflict로 재시도하지 않는다.

## 4. 클라이언트 안의 계획

모든 클라이언트는 애플리케이션 프로세스 안에서 요청을 검증하고 계획한다. 컴파일러 서비스, 데몬, 확장은 사용하지 않는다.

| 클라이언트 | 검증, 계획, 방언, DDL |
|---|---|
| Go | `engine/ir`, `engine/planner`, `engine/dialect`, `internal/ormgen` DDL |
| PHP | `clients/php/src/Validator.php`, `Planner.php`, `Dialect.php`, `Ddl.php` |
| Rust | `clients/rust/orm/src/engine/` |
| TypeScript | `clients/typescript/src/engine/` |

연결은 `schema.json`을 읽어 내용으로 `schema_hash`를 확인하고, 해시가 다른 생성 모델을 거부한다(`SCHEMA_HASH_MISMATCH`). plan 캐시 키는 스키마 해시와 요청 형태다. 매개변수 값은 키에 포함하지 않는다.

네 플래너는 같은 요청에서 같은 SQL과 bind slot을 만든다. `tests/conformance`는 MySQL, PostgreSQL, SQLite에서 같은 벡터를 네 클라이언트로 실행하고 문장, bind, 결과를 기록된 기대값과 비교한다.
