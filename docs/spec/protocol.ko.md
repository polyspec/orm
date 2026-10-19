<!-- doc-id: protocol -->
<!-- source-sha256: d9cc2ed04b62faaed3bb77d9dc043d77328aa25a3d130780309bc4b805752307 -->
# IR과 Plan 프로토콜

클라이언트는 [DSL](dsl.md)로 만든 모델을 아래 요청으로 변환하고, 호출한 프로세스 안에서 요청을 plan으로 계획한 뒤 요청 형태를 키로 plan을 캐시한다. 타입 정의는 `packages/go/engine/ir/ir.go`와 `packages/go/engine/plan/plan.go`를 기준으로 하며, 모든 클라이언트가 같은 필드를 구현한다.

## 1. 요청 {#_1-request}

```json
{
  "ir_version": 1,
  "manifest_hash": "sha256:e82672f09b5852725e8b4d17ad0500b3d8ef5fbeeeee1c04c7e2b1ec0b9bb785",
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

요청에는 값이 들어가지 않는다. 모든 값은 클라이언트가 가진 매개변수 목록의 위치이며, `n_params`는 그 목록의 길이다. 따라서 plan은 값과 무관하다.

모든 클라이언트는 요청을 엄격하게 decode한다. 최상위나 어떤 객체(`ref`, `pred`, item, group, order item, `limit`, join, relation, 할당) 안에서든 그 객체가 정의하지 않은 member는 `IR_INVALID`이고, JSON type이 틀린 member도 그렇다: 문자열이 아닌 `column`, `agg`, `entity`, `op`, 정수가 아닌 매개변수 위치나 개수(`0.0`이나 `1e1`처럼 literal이 정수가 아닌 수도 포함한다. TypeScript는 literal을 지키는 ordered-json으로 요청 text를 읽는다), 배열이 아닌 목록 member, 객체가 아닌 객체 member가 그 예다. `sum`과 `avg`는 column을 `agg`에 적으므로 `sum` 요청의 `column`은 정의되지 않은 member다. 이 형태 검사는 다른 모든 규칙보다 먼저 하므로, type이 틀린 이름의 요청은 `COLUMN_UNKNOWN`이나 `ENTITY_UNKNOWN`이 아니라 `IR_INVALID`로 실패한다. null인 member는 없는 것과 같다. `tests/ir/validate.json`(`shape-*` case)이 이 사례를 담고, Go, PHP, Rust, TypeScript, Python이 이를 실행한다.

| 필드 | 규칙 |
|---|---|
| `manifest_hash` | generated code가 가진 document set의 `manifestHash`다. `sha256:` 뒤에 소문자 16진수 64자리가 온다([manifest와 hash](dbspec.ko.md#manifest-and-hashes)). 클라이언트가 읽은 모델과 hash가 다른 요청은 `SCHEMA_HASH_MISMATCH`로 실패한다. 이 필드는 `schema_hash`를 대신하며 오류 코드 이름은 그대로다 |
| `kind` | `one`과 `all`은 행을 읽고, `count`는 행이나 그룹 수를 계산하며, `group_count`는 `row_count`를 가진 그룹 행을 반환한다. `sum`과 `avg`는 `agg`를 집계하고, `paginate`는 페이지 문장과 개수 문장을 반환하며, `insert`, `update`, `delete`는 행을 쓰고, `restore`는 지워진 행 하나의 soft delete 컬럼을 비우며([restore](#_1-5-restore)), `restart_identity`는 테이블의 identity를 가장 큰 key 다음에서 다시 시작한다([적재](#_1-6-load)) |
| `load` | `insert`가 행을 저장된 key 그대로 쓴다. identity 컬럼의 값을 받는다([적재](#_1-6-load)) |
| `set` | `insert`와 `update`의 할당 |
| `rows` | 추가로 삽입할 각 행의 매개변수를 `set` 컬럼 순서로 나열한다. 이때 `set`의 모든 항목은 값 할당이어야 하며 `on_duplicate`는 사용할 수 없다 |
| `on_duplicate` | 삽입한 행이 기존 key와 겹칠 때 적용하는 할당. `on_duplicate`가 있는 insert에는 삽입 행을 만날 수 있는 key(primary key는 insert가 빼먹지 않았을 때만, 그리고 모든 unique key)가 정확히 하나여야 하고 insert가 그 모든 컬럼을 할당해야 하며, 아니면 `IR_INVALID` "on_duplicate needs exactly one conflict key; %s can meet the row"이다. MySQL은 만난 아무 unique key의 행을 갱신하지만 PostgreSQL과 SQLite는 대상 하나를 지정하기 때문이다 |
| `optimistic` | `update`는 컬럼 값이 매개변수와 같을 때만 일치한다. 일치하는 행이 없으면 `OPTIMISTIC_LOCK`을 반환한다 |
| `lock` | 루트 행 조회에만 사용하며 클라이언트는 트랜잭션 안에서만 허용한다 |

`Query`는 루트, 조인 자식, 관계 자식, 서브쿼리가 함께 쓰는 형태로 `entity`, `columns`, `on`(조인 자식 전용), `where`, `joins`, `relations`, `order`, `group_by`, `limit`, `force_index`, `lock`, 관계 옵션으로 이루어진다.

`group_by`는 `count`(group 수)와 `group_count`의 루트에서만 유효하다. 다른 kind, 조인 자식, 관계 자식, 서브쿼리에서는 요청이 `IR_INVALID`로 실패한다. group된 행은 group 밖의 컬럼 값이 없어서, 다른 kind는 세 database 모두에서 출력을 정할 수 없다.

### 1.1 컬럼

```json
Columns = {
  "mode": "" | "all" | "none",
  "add": ["name"],
  "remove": ["description"],
  "fn": {"created_date": {"column": "created_ts", "fn": Func}},
  "sub": {"read_total": Sub}
}
```

- `mode`가 `""`이면 default select set, 즉 `select explicit`의 컬럼을 뺀 모든 컬럼을 선택한다([runtime model](dbspec.ko.md#runtime-model)). `all`이면 모든 컬럼을 선택하고, `none`이면 기본 키와 외래 키만 남긴다.
- `fn`, `sub`는 이름이 있는 출력을 추가한다. 출력 명칭은 엔티티의 컬럼 명칭과 같을 수 없다.
- 기본 키와 관계가 바인드하는 키는 항상 선택한다.

### 1.2 조인과 관계

```json
Join = {"rel": "service_model", "kind": "inner | left", "left": "service_seq", "right": "seq", "query": Query}
Relation = {"rel": "writer", "kind": "one | many", "keys": [{"left": "user_seq", "right": "seq"}], "query": Query,
            "key_by": "user_seq", "flatten": false, "limit_per_parent": 2,
            "if_parent": {"column": "is_close", "p": 4}, "no_cascade_delete": false}
```

- `rel`은 결과 명칭이다. join에서 `left`는 부모의 컬럼이고 `right`는 자식의 컬럼이며 둘 다 필수다. 관계는 `kind`와 `keys`가 필수다. `keys`는 key 성분마다 `{"left", "right"}` 한 쌍을 key 순서대로 담으므로, composite foreign key의 관계는 모든 성분을 담는다. `composite_account`에서 `composite_membership`은 `[{"left": "tenant_id", "right": "tenant_id"}, {"left": "account_id", "right": "account_id"}]`로 읽는다. 빈 `keys`, `left`나 `right`가 없는 쌍, 같은 쪽의 두 쌍에 나오는 컬럼은 `IR_INVALID`다. 클라이언트는 이름이나 외래 키에서 키를 추론하지 않는다.
- 조인 자식의 `on` 그룹은 `ON` 절에 추가한다. `where` 그룹은 `joined` 항목이 지정한 위치에 두며, 지정하지 않으면 부모 `WHERE`에 `AND`로 붙인다.
- 관계는 별도 문장으로 실행한다. `limit_per_parent`는 부모 키마다 자식 행 수를 제한하고, `if_parent`는 컬럼 값이 매개변수와 같은 부모에 대해서만 자식을 읽는다(컬럼의 logical type으로 비교하므로 0 또는 1로 저장된 bool 컬럼은 bool 매개변수와 같다). `flatten`은 아래에 적은 대로 `one` 자식을 부모에 합치고, `key_by`는 자식의 non-null 컬럼으로 자식 컬렉션의 키를 정하고(nullable 컬럼은 `IR_INVALID`이다. NULL 키는 모든 언어가 같게 답할 수 없기 때문이다. 빈 `key_by`는 생략한 것과 같이 없는 것이다), `no_cascade_delete`는 재귀 삭제에서 관계를 제외한다.
- `flatten`은 `one` 자식을 부모의 array form과 JSON form에 합친다: 부모 자신의 member 다음에 자식 array form의 member — 자식의 출력, 자식의 관계, 그리고 같은 방식으로 합친 flatten된 손자 — 를 둔다. 부모가 가진 이름은 부모 값을 지키고, 없는 자식은 아무것도 더하지 않는다. plan이 조립하는 row와 IR executor가 답하는 row는 자식을 `rel` 아래에 두며, 병합은 client model이 한다. conformance vector `relations_flatten`이 공유 이름, 없는 자식, flatten된 손자를 고정한다.

### 1.3 그룹과 조건

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

- `conn`은 항목을 같은 그룹의 이전 항목에 연결한다. 첫 항목에는 연결자가 없다. `or`를 가진 첫 항목은 `OR_AT_GROUP_START`로, `and`를 가진 첫 항목은 `IR_INVALID`로 실패한다. top-level `where`나 `on` 그룹은 이전 형제가 없으므로 그 자신의 `conn`은 `IR_INVALID`로 실패한다.
- `ref.path`는 SQL 문장 루트에서 시작하는 조인 경로(`""`는 루트, `a/b`는 중첩 조인)이거나, 서브쿼리를 소유한 모델을 뜻하는 `^`다. relation과 서브쿼리는 자기 문장이므로 그 `""`는 자기 루트다. 검증은 요청 종류가 render하지 않는 relation이나 서브쿼리 안의 ref도 모두 푼다. 조인되지 않은 이름을 지나는 경로는 `ENTITY_NOT_JOINED`, 서브쿼리 밖의 `^`는 `IR_INVALID`, 대상 모델에 없는 column은 `COLUMN_UNKNOWN`으로 실패한다.
- `tests/ir/validate.json`의 공유 case가 검증 규칙을 고정한다. 모든 클라이언트가 각자 자기 패키지에서(Go는 `packages/go/engine/ir`에서) 이 파일을 읽어 각 요청을 자기 검증기에만 준다. PHP 확장 `orm_dbspec`은 dbspec 표면만 구현하고(`packages/php-ext/stubs/orm_dbspec.stub.php`) 요청 검증기가 없다. PHP 프로그램은 PHP 클라이언트의 `Polyspec\Orm\Validator`로 요청을 검증하고 계획한다.
- `fn`은 `p`와 비교하기 전에 `column`에 컬럼 함수를 적용한다. `value`는 `column`을 값 함수와 비교한다. 0001-01-01부터 9999-12-31 23:59:59.999999 밖이거나 그 폭을 넘는 interval의 상대 시간 함수는 NULL이므로 비교도 그 부정도 어떤 행과도 맞지 않는다([dialects](dialects.ko.md)). 함수는 구조만 전달하며 각 dialect가 [dialect](dialects.md)의 설명대로 SQL을 만든다. 알 수 없는 함수는 `FUNCTION_UNKNOWN`을 반환한다.
- 열 비교의 두 컬럼, 컬럼 `in`/`not_in` subquery 컬럼, join의 `left`와 `right`, 각 relation key 쌍은 dbspec check 피연산자가 만나는 대로([dbspec](dbspec.md)) 만난다: 정수는 정수와, `decimal`은 같은 scale의 `decimal`과, `f64`, `bool`, `varchar`와 `text`는 서로, `uuid`, `date`, 같은 precision의 `time` 또는 `datetime`, `bytes`는 `bytes`와 만난다. 그 밖의 쌍은 `OPERATOR_NOT_ALLOWED`로 실패한다. database마다 답이 다르기 때문이다(PostgreSQL은 `integer = varchar`를 거절하고 MySQL은 강제 변환하며 SQLite는 affinity로 비교한다). validator는 dbspec check 검증의 표를 읽으며, conformance vector `column_pairs`가 두 종류의 쌍을 모두 실행한다.
- 스칼라 컬럼 subquery(`agg` 없는 `columns.sub`)는 count가 1인 `limit`(`offset`은 무엇이든)과, 모든 primary key 컬럼을 포함하고 `random` 항목이 없는 `order`를 가지므로 모든 database에서 많아야 한 행을 내고 일치하는 행이 없으면 NULL이다. 그것이 없으면 요청은 `IR_INVALID`이다. 여러 행에 MySQL은 1242, PostgreSQL은 21000으로 답하고 SQLite는 첫 행을 돌려주기 때문이다. `limit`은 `in` subquery(MySQL 1235)와 집계 subquery에서는 계속 `IR_INVALID`이다.
- 열 비교(`eq_col` 등)는 기본 연산자(`eq_col`이면 `eq`)가 왼쪽 컬럼 type의 연산자이고 어느 컬럼도 codec이 없을 때 허용되므로, `bool gt_col`, `bytes gt_col`, `aes` 컬럼의 `eq_col`은 `OPERATOR_NOT_ALLOWED`로 실패한다. codec이 `ip` 하나뿐인 두 컬럼은 양쪽이 dialect의 같은 저장 형태이므로 `eq_col`과 `not_eq_col`을 받는다.
- `not`은 하위 묶음을 부정하며 `NOT (…)`로 렌더링된다. `not`을 가진 top-level `where`나 `on` 묶음은 `IR_INVALID`다.
- 요청은 SQL text를 싣지 않는다. 모든 조건, 출력, 정렬, 그룹, 할당은 위 형식 중 하나이며 plan의 모든 bind slot은 dbspec type을 가진다.
- `contains`와 `contains_binary`는 값을 와일드카드 사이에 바인드한다. `contains`는 ASCII 글자를 대소문자 구분 없이, 다른 모든 문자를 code point로 비교하고, `contains_binary`는 code point로 비교한다([dialects](dialects.md)).

### 1.4 정렬과 할당

```json
Order  = {"column": "seq", "desc": true} | {"column": "start_dt", "fn": Func} | {"random": true}
Assign = {"column", "p"} | {"column", "null": true} | {"column", "plus_p"} | {"column", "minus_p"}
```

order 항목은 오름차순에서 NULL을 모든 값 앞에, 내림차순에서 모든 값 뒤에 놓는다. MySQL과 SQLite는 기본으로 그렇게 하고, 오름차순에서 NULL을 마지막에 놓는 PostgreSQL은 NULL일 수 있는 order 식(nullable 컬럼이나 그 컬럼 함수)에 `ASC NULLS FIRST`와 `DESC NULLS LAST`를 렌더한다. NOT NULL 컬럼은 btree 순서를 그대로 쓴다. 이는 root order, `limit_per_parent`의 `ROW_NUMBER()` order, `group_count` order에 모두 적용된다.

`group_by`가 있으면 order 항목은 group 컬럼, 그 컬럼의 함수, `random` 중 하나여야 하고, 다른 컬럼은 `IR_INVALID`("order by %s, which is not a group column")로 실패한다. group에는 그 컬럼의 단일 값이 없기 때문이다(MySQL 1055, PostgreSQL 42803, SQLite는 임의의 행).

`minus_p`는 음수 값을 저장하지 않는다.

primary key나 identity 컬럼을 할당하는 `update`는 `IR_INVALID`("cannot update %s")로 실패하며, 그것이나 soft delete 컬럼(`restore`가 스스로 지운다)을 할당하는 `restore`도 같다. planner만이 아니라 validator가 거절하므로 계획하지 않는 IR 실행기도 같은 규칙을 본다.

`insert`는 `p` 또는 `null`로 할당한다. `plus_p`와 `minus_p`는 `insert`의 `set`에서 `IR_INVALID`이고 `on_duplicate`와 `update`에서는 유효하다. `VALUES` 목록에는 읽을 현재 행이 없기 때문이며, MySQL은 거기서 컬럼의 default를 읽고(3 + 5 = 8) PostgreSQL과 SQLite는 문장을 거절한다.

default가 있는 컬럼을 빼먹은 `insert`는 database default를 받으며 planner는 값을 더하지 않는다. default가 없는 non-null 컬럼을 빼먹은 `insert`는 `IR_INVALID`로 실패한다. planner는 실행기가 소유한 컬럼을 할당한다. AES 키 버전, 모든 `update`의 `updated` 컬럼, 그리고 `audit` setting이 있는 테이블에서는 모든 `insert`, `update`, soft delete, restore, duplicate update의 audit 컬럼이다. AES 키 버전이나 audit 컬럼을 할당하는 요청은 `IR_INVALID`로 실패한다.

### 1.5 Restore

`restore` 요청은 `soft_delete` setting이 있는 테이블([dbspec](dbspec.ko.md#settings))에서 soft delete한 행 하나를 지정한다. `set`은 그 행의 값이며 `update` 할당과 같은 규칙을 따르고, `where`는 `and`로 이은 조건이다. `where`의 두 item 사이의 `or`는 `IR_INVALID`로 실패한다. planner는 request hook 뒤에 key를 고른다: 매개변수(`p`)를 가진 `set` 값과 `where` item 중 함수, 값 함수, ref, subquery 없이 매개변수를 가진 컬럼의 `eq` predicate가 컬럼의 값을 주며, 그 값들이 primary key의 모든 컬럼을 덮으면 primary key가, 아니면 컬럼을 모두 덮는 첫 unique key(이름 순서)가 key다. key 컬럼의 `set` 값은 `where` 뒤에 `set`의 순서로 그 컬럼의 `eq` 조건이 되고, 다른 `set` 값은 restore와 함께 쓰는 새 값이다. `where`의 다른 조건은 restore를 더 좁히며, key가 여전히 행을 많아야 하나로 정하므로 request hook은 `update`처럼 restore에 조건을 더할 수 있다. 값이 어떤 key도 덮지 않는 요청은 `IR_INVALID`로 실패하며, primary key, identity, soft delete 컬럼의 새 값도 그렇다. `optimistic`은 없다. plan은 `main` step 하나다. unique key (`team_id`, `member_id`)에서 `team_id`, `member_id`, `note`의 `set`이면:

```sql
UPDATE `link` SET `note` = ?, `deleted_at` = NULL, `audit_seq` = ? WHERE `link`.`team_id` = ? AND `link`.`member_id` = ? AND `link`.`deleted_at` IS NOT NULL
```

이 step은 새 값을 쓰고, soft delete 컬럼을 비우며, `audit` setting이 있는 테이블에서는 audit 컬럼을 쓴다. soft delete처럼 `updated` 컬럼은 할당하지 않는다. 지워지지 않은 행과 없는 행은 어떤 행과도 맞지 않으므로 문장은 새 값을 포함해 아무것도 바꾸지 않는다. `soft_delete`가 없는 테이블의 요청은 `IR_INVALID`로 실패한다. 읽기는 언제나 soft delete한 행을 뺀다: root와 각 subquery는 `WHERE`에서, 각 join child는 `ON` 조건에서 빼므로 left join은 null child를 주며, 각 relation은 자기 statement에서 뺀다. soft delete한 행과 맞는 요청은 `restore`뿐이다(conformance vector `joins_soft_deleted`). 모델 메서드 `restore`는 set 값을 `set`으로 보내고 `where`는 보내지 않으며, 이 step을 실행한 뒤 hook이 남긴 요청에서 planner가 고른 key의 값으로 행을 읽는다([사용법](../operations/usage.ko.md#restore-a-soft-deleted-row)).

### 1.6 적재 {#_1-6-load}

다른 곳에 이미 있는 행을 데이터베이스에 적재하는 일(재구성이나 export)은 다른 행이 참조하는 key를 지켜야 한다. 보통의 `insert`는 identity 컬럼의 값을 거부한다. identity key는 모두 데이터베이스가 만들기 때문이다([dsl](dsl.md)). 적재는 key를 직접 쓰고 그 뒤 각 identity를 다시 시작한다:

- `"load": true`인 `insert`는 identity 컬럼의 값을 받는다. identity 컬럼이 있는 테이블에서는 `set`이 그 컬럼에 매개변수(`p`)를 할당한다. 그 컬럼을 빼먹은 적재는 `IR_INVALID` `load of <entity> needs a value for the identity column <column>`으로 실패하고, `null`을 할당한 적재는 non-null 컬럼에 `null`을 할당한 다른 요청처럼 실패한다. 나머지 규칙과 문장은 `rows`를 포함해 `insert`의 것과 같다. identity 컬럼이 없는 테이블의 적재는 보통의 `insert`다. 다른 kind나 `on_duplicate`와 함께 쓴 `load`는 `IR_INVALID` `load is only valid on insert without on_duplicate`로 실패한다. `load` 없이 identity 컬럼을 할당한 요청은 여전히 `cannot set identity column <column>`으로 실패한다.
- `restart_identity` 요청은 엔티티 하나만 지정한다. `set`, `rows`, `on_duplicate`, `where`, `optimistic`이 있으면 `IR_INVALID` `restart_identity takes no set, rows, on_duplicate, where or optimistic`으로, identity 컬럼이 없는 엔티티는 `IR_INVALID` `restart_identity of <entity>, which has no identity column`으로 실패한다. plan은 bind slot이 없는 `main` step 하나이고 `tables`는 그 테이블이다. 이 step 뒤 다음 생성 key는 테이블의 가장 큰 key에 1을 더한 값이며, 빈 테이블이면 1이다. counter가 그보다 앞서 있었어도 같다:

| Dialect | 문장 |
|---|---|
| MySQL | ``ALTER TABLE `load_probe` AUTO_INCREMENT = 1``: InnoDB는 가장 큰 key 이하의 값을 가장 큰 key에 1을 더한 값으로 정한다 |
| PostgreSQL | `SELECT setval(pg_get_serial_sequence('"load_probe"', 'seq'), COALESCE(MAX("seq"), 0) + 1, false) FROM "load_probe"` |
| SQLite | `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX("seq"), 0) FROM "load_probe") WHERE name = 'load_probe'`. 행을 받은 적이 없는 테이블은 `sqlite_sequence` 행이 없고, 그 다음 key는 이미 가장 큰 key 다음이다 |

PostgreSQL identity는 명시한 key를 지나 나아가지 않으므로 다시 시작하지 않으면 다음 생성 key가 적재한 key와 충돌한다. MySQL과 SQLite는 명시한 key를 지나 counter를 옮기며, 다시 시작하면 모든 dialect가 같은 다음 key를 가진다. MySQL 문장은 DDL이라 열린 transaction을 commit하므로, 적재는 행을 commit한 뒤 다시 시작한다. 클라이언트는 둘 다 execute 호출로 실행한다([사용법](../operations/usage.ko.md#execute-a-compiled-statement)). 공유 case `contracts/fixtures/identity_load.json`이 MySQL, PostgreSQL, SQLite에서 문장, 오류, 적재 뒤의 key를 적는다.

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

- `tables`는 statement가 가리키는 table을 정렬하고 중복을 뺀 목록이다: 쓰기의 대상 table, select의 root table, join한 table, subquery의 table이다. relation step은 자기 table을 쓴다.
- `bind_slots.from`은 `param`(요청 매개변수. 포함 검색 값에는 `transform`, AES·hex·IP 단계에는 `host_styles`가 있다), `secret`(AES 키), `config`(AES 키 버전), `parent`(관계 키 값), `now`(UTC의 클라이언트 시각), `audit`(트랜잭션 audit 기록의 primary key. `name`은 audit 기록 테이블이다) 중 하나다. column의 `param` 슬롯에는 column의 크기가 있다: `decimal(p,s)`는 `precision`과 `scale`, `time(p)`와 `datetime(p)`는 `precision`(함수의 인자나 결과는 6), `varchar(n)`은 `length`다. planner case `planner_bind_types_insert`와 `contracts/fixtures/planner.json`의 다른 case가 이 값을 고정한다. bind 경로는 어떤 statement보다 먼저 각 parameter를 이 크기로 검사한다(§5 "매개변수"). `transform` slot은 변환한 text를 bind한다(`like_contains`는 `\`, `%`, `_`를 escape하고 text를 `%`로 감싼다). SQL NULL은 NULL로 bind하므로 세 데이터베이스에서 condition builder를 거친 값도 같으므로 `col LIKE NULL`은 어떤 행과도 맞지 않고(conformance vector `contains_null`), text가 아닌 값은 `CODEC_ENCODE` "%s requires a string value"다(`tests/bind/vectors.json`의 `contains-*` case). `audit` 슬롯이 있는 쓰기를 audit 값을 가진 트랜잭션 밖에서 실행하거나 audit 기록이 `name`과 다른 테이블의 행이면 데이터베이스에 닿기 전에 `CONFIG`로 실패한다.
- **Clock.** 이것이 유일한 clock 규칙이며 [dialects](dialects.ko.md)와 [plans](plans.ko.md)는 이 규칙을 따른다. 모든 연결은 `datetime(p)`를 UTC로 읽고 쓴다. `now` slot은 마이크로초 해상도의 UTC 클라이언트 wall clock을 소수 여섯 자리로 자른 `datetime` 텍스트이며, statement는 clock을 한 번 읽으므로 그 statement의 `now` slot은 모두 같고 statement의 clock 값은 하나다. ORM이 쓰는 clock은 column이 선언한 소수 자릿수로 자르고, 비교하는 clock은 여섯 자리를 유지한다. MySQL에서 update 시각과 soft delete는 statement clock을 자르는 `CURRENT_TIMESTAMP(p)`(p = 0이면 `CURRENT_TIMESTAMP`)를 대입하고(`mysql.now.precision_truncates`), insert는 `default now` 컬럼을 database default에 맡기며, `now` value function과 그 상대 형식은 `NOW(6)`를 쓴다. `datetime(p)` 컬럼은 `NOW(6)`와 값으로 비교한다(`mysql.now.compare_six_digits`). PostgreSQL은 clock을 `timestamp(p < 6)`에 반올림하고(`postgres.now.precision_rounds`) `now()`는 statement 시작이 아니라 transaction 시작이므로(`postgres.now.transaction_start`), PostgreSQL dialect는 update 시각, soft delete, insert가 빼먹은 모든 `default now` 컬럼에 p로 자른 `now` slot을 bind하고, `now` value function과 그 상대 형식에는 여섯 자리 `now` slot을 `CAST(<slot> AS timestamp(6))`로 bind한다. `timestamp(p)` 컬럼은 그것과 값으로 비교한다(`postgres.now.compare_six_digits`). DDL default `statement_timestamp()`는 raw SQL을 위해 남는다. SQLite에는 마이크로초 clock이 없으므로 SQLite dialect는 update 시각, soft delete, insert가 빼먹은 모든 `default now` 컬럼에 p로 자른 `now` slot을 bind하고, `now` 함수에는 여섯 자리로 bind하며, 상대 형식을 `now` slot에 간격을 적용한 `datetime` 뒤에 두 번째 `now` slot의 소수 여섯 자리를 붙인 형태로 render한다. SQLite는 text로 비교하므로 clock과 비교하는 `datetime(p < 6)` 컬럼은 여섯 자리로 늘린다: p = 0이면 `col || '.000000'`, 그 밖에는 `col` 뒤에 0을 6 − p개 붙인다. conformance vector `clock_truncate_write`와 `clock_compare_six_digits`는 test entry point가 고정한 clock으로 실행한다([3.3](#_3-3-test-clock)). plan history는 tool clock을 소수 여섯 자리로 유지한다([plans](plans.ko.md#apply)).
- 행은 위치로 읽는다. `assemble.columns[].styles`는 클라이언트가 디코딩할 코덱 단계이며, SQL 단계는 이미 적용되어 있다.
- `assemble.key`는 컬렉션 식별자다. 기본 키의 모든 구성 요소이거나 `group_count` 행의 그룹 컬럼이다. NULL key 구성 요소는 `CODEC_DECODE`다.
- `group_count` 행은 선택한 그룹 컬럼의 선언된 타입을 보존한다. 불리언 그룹 값은 JSON 불리언이며 데이터베이스 불리언 값이 잘못되면 디코딩에 실패한다.
- `children[].kind`는 같은 행의 자식이면 `join`, `parent_keys`와 `child_keys`로 연결되는 관계 단계면 `one` 또는 `many`다.

### 2.1 관계 단계

- 관계마다 부모 단계 뒤에 `relation` 단계가 하나 있다. 중첩 관계도 같은 규칙을 따르며, `paginate`의 단계 순서는 본문, 관계, 개수다.
- 클라이언트는 모든 부모 행의 키를 순서대로 읽고, 키가 null인 행과 중복을 제거한다. 남은 키가 없으면 문장을 실행하지 않는다. `if_parent`가 있으면 컬럼 값이 매개변수와 같은 부모만 사용한다.
- `parent` 슬롯은 클라이언트가 키 목록으로 확장하는 자리표시자 하나다. 목록은 마지막 키를 반복해 2의 거듭제곱 길이로 맞추므로 크기 구간마다 준비된 문장 하나를 사용한다. 드라이버 바인드 한도보다 긴 목록은 나누어 실행한다.
- 여러 행 insert(`creates(rows, batch)`)는 행을 주어진 순서대로 batch로 나누어 실행한다. 각 batch는 `batch`개 행이고 마지막 batch는 남은 행이 더 적으면 그만큼이며, 각 batch는 하나의 multi-row INSERT다. client는 다른 크기를 고르지 않고 batch를 나누지 않는다. `batch`는 양의 정수이며, 아니면 어떤 statement보다 먼저 `CONFIG`다. 바인드 수(행 수 × 컬럼 수)가 바인드 한도(SQLite 999, MySQL과 PostgreSQL 65535)를 넘는 batch는 어떤 statement보다 먼저 `BATCH_TOO_LARGE`로 실패하고, message는 그 batch와 바인드 수와 한도를 밝힌다. 반복된 행은 insert되므로 행은 padding하지 않는다. 모든 batch는 한 transaction(활성 transaction 안에서는 savepoint)에서 실행되므로 실패한 batch는 그 호출의 어떤 행도 남기지 않으며, insert된 행과 생성된 key와 statement event는 주어진 행의 순서를 따른다. 공유 case는 `contracts/fixtures/insert_parts.json`이다.
- `one`은 첫 자식 행을, `many`는 자식 순서의 컬렉션을 붙인다. 컬렉션 키가 겹치면 마지막 행을 유지한다.

## 3. 오류

오류는 [errors.yaml](errors.yaml)의 코드와 메시지를 가진다. 예를 들어 `IR_INVALID`, `SCHEMA_HASH_MISMATCH`, `COLUMN_UNKNOWN`, `OPERATOR_NOT_ALLOWED`, `FUNCTION_UNKNOWN`, `EMPTY_IN`, `LIMIT_IN_RELATION`, `COLUMN_ALIAS_CONFLICT`가 있다. 실행기는 `CONFIG`, `OPTIMISTIC_LOCK`, `LOCK_NOT_AVAILABLE`, `DEADLOCK`, `DUPLICATE_KEY`, `FOREIGN_KEY`, `CONSTRAINT`, `READ_ONLY`, `CONNECTION_LOST`, `DRIVER`를 추가한다. 클라이언트는 모든 드라이버 오류를 ORM 오류로 반환한다. catalog에 있는 조건은 그 코드를, 그 밖의 드라이버 오류는 `DRIVER`를 가지며, 모두 드라이버 메시지와 원인인 드라이버 오류를 유지한다. 서버가 끝냈거나 끊긴 연결은 모든 클라이언트에서 `CONNECTION_LOST`다. 어떤 클라이언트도 그 판단에 메시지 text를 비교하지 않는다([설정](config.ko.md#lost-connections)). `audit`이나 `immutable` trigger가 거부한 쓰기는 `DRIVER`다. 트랜잭션이나 savepoint의 callback이 실패하고 rollback도 실패하면 클라이언트는 code `ROLLBACK`을 가진 오류 하나를 반환한다. 그 메시지는 두 오류를 적고, 오류는 callback 오류와 rollback 오류를 유지한다(PHP: previous exception과 `rollback`, TypeScript: `cause`와 `rollback`, Go: 두 오류를 이 순서로 담은 `errors.Join`, Rust: `Error::Rollback { callback, rollback }`, Python: `cause`와 `rollback`). `ROLLBACK` 오류는 재시도하지 않는다. NOWAIT lock 실패는 항상 `LOCK_NOT_AVAILABLE`이며 transaction conflict로 재시도하지 않는다.

### 3.1 Test faults

test는 자기 클라이언트의 test entry point로 모든 데이터베이스에서 트랜잭션의 rollback을 결정적으로 실패시킨다. production process는 이 fault를 설정할 수 없다. entry point는 handle의 연결에 rollback fault를 설정하고, 그 연결의 모든 handle이 이를 공유한다. callback이 실패한 다음 트랜잭션의 rollback은 평소대로 실행되어 데이터베이스가 트랜잭션을 버리고, 그 뒤 클라이언트는 rollback을 `FAULT` 오류로 실패했다고 보고한다. 트랜잭션은 callback 오류와 `FAULT` 오류를 유지한 `ROLLBACK` 오류 하나를 반환한다. commit, savepoint rollback, 실패한 begin이나 commit 뒤의 rollback은 fault를 소비하지 않는다. fault는 callback 실패 뒤의 트랜잭션 rollback이 소비할 때까지 설정된 채로 남고, 그다음 callback이 실패한 트랜잭션은 callback 오류만 반환한다.

fault는 각 클라이언트의 test entry point에만 있다. DSN, 설정 값, 환경 변수는 fault를 설정하지 않는다.

| 클라이언트 | Entry point | production build가 제외하는 방법 |
|---|---|---|
| Go | `orm.FailNextRollback(db)` | build tag `ormtest`가 있을 때만 파일을 compile한다(`go test -tags ormtest`). tag가 없으면 함수가 없어 호출이 compile되지 않는다 |
| Rust | `polyspec_orm::testing::fail_next_rollback(&db)` | cargo feature `test-faults`가 있을 때만 module을 compile하며, 어떤 default feature도 이를 켜지 않는다. `[dev-dependencies]`에서 켠다 |
| TypeScript | `@polyspec/orm/testing`의 `failNextRollback(db)` | package는 condition `orm-test`에서만 이 subpath를 export한다. `node --conditions=orm-test`가 없으면 import가 `ERR_PACKAGE_PATH_NOT_EXPORTED`로 실패하고, package entry point는 이 함수를 export하지 않는다. test의 type check는 `customConditions: ["orm-test"]`로 subpath를 찾는다 |
| PHP | `Polyspec\Orm\Testing\Faults::failNextRollback($db)` | class는 package의 `testing/Faults.php`에 있고 package autoloader는 이 파일을 연결하지 않는다. process는 그 파일을 경로로 require한 뒤에만 class를 가진다 |
| Python | `polyspec.orm.testing.fail_next_rollback(db)` | PHP class가 package에 있듯 package `polyspec.orm.testing`은 배포에 있고, `polyspec.orm`의 어느 module도 이것을 import하지 않는다. process는 `polyspec.orm.testing`을 직접 import한 뒤에만 이것을 가지며, package entry point `polyspec.orm`은 이 함수를 export하지 않는다 |

### 3.2 Test statement fault

test는 자기 클라이언트의 test entry point로 연결의 다음 statement가 주어진 오류 code와 message로 결정적으로 실패하게 한다. entry point는 3.1의 rollback fault와 같은 entry point다([3.1](#_3-1-test-faults)). entry point는 handle의 연결에 fault를 설정하고, 그 연결의 모든 handle이 이를 공유한다. 인자는 database, `code`([errors.yaml](errors.yaml)의 code)와 `message`(빈 값이 아닌 text)다. 빈 `code`나 `message`는 클라이언트의 프로그래머 오류 신호로 거절되며 fault를 설정하지 않는다. Go와 Rust는 panic, TypeScript는 `TypeError`, PHP는 `InvalidArgumentException`, Python은 `ValueError`다.

연결이 호출자를 위해 실행하는 다음 statement(model 읽기나 쓰기, query, schema statement(table 재구성이 자기 statement 앞뒤로 설정하고 복원하는 SQLite `foreign_keys` pragma를 포함한다), session 값, named lock의 획득이나 해제)는 데이터베이스로 보내지 않는다. 클라이언트는 그 statement를 주어진 code와 message의 `OrmException`으로 보고하며, driver 오류가 가는 것과 같은 statement 종료 지점을 거치므로 그 statement의 event에 오류가 실린다. 거절된 statement는 데이터베이스를 바꾸지 않고, 그 statement가 fault를 소비한다. transaction 장치의 statement는 fault를 소비하지 않는다. 이는 `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`, transaction이 시작할 때 적용하는 설정(격리, 읽기 전용, statement timeout, `read_uncommitted`, `query_only`), transaction이 끝날 때 복원하는 local과 설정, SQLite row lock table의 statement다. 생성, row 삽입, 삽입을 감싸는 `busy_timeout` 변경을 포함한다. statement fault가 이미 설정된 연결에 다시 설정하면 새 fault가 이전 fault를 대체한다. 거절된 statement는 [3.1](#_3-1-test-faults)의 rollback fault를 소비하지 않고, rollback은 statement fault를 소비하지 않는다.

fault는 각 클라이언트의 test entry point에만 있다. DSN, 설정 값, 환경 변수는 fault를 설정하지 않는다.

| 클라이언트 | Entry point | production build가 제외하는 방법 |
|---|---|---|
| Go | `orm.FailNextStatement(db, code, message)` | `FailNextRollback`과 같은 파일이며 build tag `ormtest`가 있을 때만 compile한다 |
| Rust | `polyspec_orm::testing::fail_next_statement(&db, code, message)` | `fail_next_rollback`과 같은 module이며 cargo feature `test-faults`가 있을 때만 compile한다 |
| TypeScript | `@polyspec/orm/testing`의 `failNextStatement(db, code, message)` | `failNextRollback`과 같은 subpath이며 condition `orm-test`에서만 export한다 |
| PHP | `Polyspec\Orm\Testing\Faults::failNextStatement($db, $code, $message)` | `failNextRollback`과 같은 class이며 package autoloader가 연결하지 않는 `testing/Faults.php`에 있다 |
| Python | `polyspec.orm.testing.fail_next_statement(db, code, message)` | `fail_next_rollback`과 같은 package이며 `polyspec.orm`의 어느 module도 import하지 않는다 |

statement fault는 `Db`에 설정되며 `Db`가 실행하는 statement에만 적용된다. 모든 구현의 dbspec apply, recover, rollback, finalize와 introspection은 호출자가 넘긴 driver 연결 위에서 `Db` 밖에서 실행하므로 이를 소비하지 않는다: Go `packages/go/engine/dbspec/apply.go:138,159,200,282`(`Execer`)와 `packages/go/engine/dbspec/introspect.go:37`(`Querier`), Rust `packages/rust/orm/src/dbspec/apply.rs:296,313,331,347`(`ApplyConnection`)와 `packages/rust/orm/src/dbspec.rs:52`(`CatalogQuerier`), TypeScript `packages/ts/src/dbspec/apply.ts:720,737,768,820`(`Connection`)와 `packages/ts/src/dbspec/introspect.ts:33`, Python `packages/python/src/polyspec/orm/dbspec/apply.py:703,718,743,802`와 `packages/python/src/polyspec/orm/dbspec/introspect.py:16`(`Connection`), PHP `packages/php/src/Dbspec/PlanApply.php:102,118,149,212`와 `packages/php/src/Dbspec/Dbspec.php:161,588`(`\PDO`), PHP 확장 `orm_dbspec`은 `packages/php-ext/stubs/orm_dbspec.stub.php:553,591,594,597,600`(`\PDO`)이며 구현은 `packages/php-ext/src/apply.c`와 `introspect.c`에 있다.

### 3.3 Test clock

test는 자기 클라이언트의 test entry point로 연결의 executor clock을 고정한다. entry point는 3.1과 3.2의 fault와 같은 entry point다. entry point는 데이터베이스와 clock, 즉 UTC text `YYYY-MM-DD HH:MM:SS.ffffff`를 받는다. 다른 형식의 clock은 클라이언트의 programmer-error 신호(3.2)로 거부하고 아무것도 고정하지 않는다. 그 뒤로 연결과 그 모든 handle의 `now` slot, 그리고 IR executor message의 `now`는 wall clock 대신 그 clock이며, 연결이 닫힐 때까지 유지된다. 데이터베이스 clock(MySQL `CURRENT_TIMESTAMP(p)`, `NOW(6)`)은 고정되지 않는다. DSN, 설정 값, 환경 변수는 clock을 고정하지 않는다.

| 클라이언트 | Entry point | production build가 제외하는 방법 |
|---|---|---|
| Go | `orm.FixClock(db, clock)` | `FailNextRollback`과 같은 파일이며 build tag `ormtest`가 있을 때만 compile한다 |
| Rust | `polyspec_orm::testing::fix_clock(&db, clock)` | `fail_next_rollback`과 같은 module이며 cargo feature `test-faults`가 있을 때만 compile한다 |
| TypeScript | `@polyspec/orm/testing`의 `fixClock(db, clock)` | `failNextRollback`과 같은 subpath이며 condition `orm-test`에서만 export한다 |
| PHP | `Polyspec\Orm\Testing\Faults::fixClock($db, $clock)` | `failNextRollback`과 같은 class이며 package autoloader가 연결하지 않는 `testing/Faults.php`에 있다 |
| Python | `polyspec.orm.testing.fix_clock(db, clock)` | `fail_next_rollback`과 같은 package이며 `polyspec.orm`의 어느 module도 import하지 않는다 |

conformance runner도 같은 곳에서 가져온다: Go runner는 `-tags ormtest`로, Rust runner는 feature `polyspec-orm/test-faults`로 build하고, TypeScript runner는 `dist/testing.js`를 path로 import하며, PHP runner는 `testing/Faults.php`를 require하고, Python runner는 `polyspec.orm.testing`을 import한다.

### 3.4 Test write result

test는 자기 클라이언트의 test entry point로 연결의 write 결과를 읽는다. entry point는 3.1부터 3.3까지와 같은 entry point다. entry point는 데이터베이스를 받아, 연결과 그 모든 handle에서 마지막으로 성공한 write(insert, update, delete, restore, [5](#_5-ir-executors) "Write")의 `affected`를 돌려주며, 그런 write가 아직 없으면 값이 없다. 실패한 write는 값을 바꾸지 않는다. 모든 클라이언트는 이 entry point에 답하기 위해서만 이 값을 유지한다. conformance vector `affected_counts`는 insert하는 upsert, update하는 upsert, 이미 그 값을 가진 행의 update, 값을 바꾸는 update 뒤에 이 값을 읽는다.

| 클라이언트 | Entry point | production build가 제외하는 방법 |
|---|---|---|
| Go | `(affected, ok)`를 돌려주는 `orm.LastAffected(db)` | `FailNextRollback`과 같은 파일이며 build tag `ormtest`가 있을 때만 compile한다 |
| Rust | `Option<u64>`인 `polyspec_orm::testing::last_affected(&db)` | `fail_next_rollback`과 같은 module이며 cargo feature `test-faults`가 있을 때만 compile한다 |
| TypeScript | `number`나 `null`인 `@polyspec/orm/testing`의 `lastAffected(db)` | `failNextRollback`과 같은 subpath이며 condition `orm-test`에서만 export한다 |
| PHP | `?int`인 `Polyspec\Orm\Testing\Faults::lastAffected($db)` | `failNextRollback`과 같은 class이며 package autoloader가 연결하지 않는 `testing/Faults.php`에 있다 |
| Python | `int`나 `None`인 `polyspec.orm.testing.last_affected(db)` | `fail_next_rollback`과 같은 package이며 `polyspec.orm`의 어느 module도 import하지 않는다 |

## 4. 클라이언트 안의 계획

모든 클라이언트는 호출한 프로세스 안에서 요청을 검증하고 계획한다. 컴파일러 서비스, 데몬, 확장은 사용하지 않는다.

| 클라이언트 | 검증, 계획, 방언, DDL |
|---|---|
| Go | `packages/go/engine/ir`, `packages/go/engine/planner`, `packages/go/engine/dialect`, `packages/go/engine/dbspec` DDL |
| PHP | `packages/php/src/Validator.php`, `Planner.php`, `Dialect.php`, `Dbspec/Renderer.php` DDL |
| Rust | `packages/rust/orm/src/engine/`, `packages/rust/schema/src/dbspec/` DDL |
| TypeScript | `packages/ts/src/engine/`, `packages/ts/src/dbspec/` DDL |
| Python | `packages/python/src/polyspec/orm/engine/`, `packages/python/src/polyspec/orm/dbspec/` DDL |

generated code는 document set의 manifest text와 `manifestHash`를 가진다. 클라이언트는 그 text로 runtime model을 한 번 만들고, 선언한 hash와 text의 hash가 다르면 거부한다(`SCHEMA_HASH_MISMATCH`). plan 캐시 키는 manifest hash와 요청 형태다. 매개변수 값은 키에 포함하지 않는다.

한 프로세스는 여러 document set의 generated code를 읽을 수 있고, 연결 하나가 그중 여러 set을 처리할 수 있다. 연결은 자기에게 등록된 set으로만 요청을 계획한다. 요청이 실행될 수 있는 대상은 프로세스가 읽은 code가 아니라 연결이 쓰는 데이터베이스가 정하기 때문이다. set은 세 방법으로 연결에 등록된다. `utils().schema().register(schema)`는 set을 연결에 등록한다. generated code의 connect helper(Go `model.Connect(dsn, config)`, PHP `Polyspec\Orm\Tests\Model\connect($dsn, $config)`, Rust `model::connect(dsn, pool_size, config)`, TypeScript generated module의 `connect(dsn, options)`, Python generated module의 `connect(dsn, **options)`)는 연결을 열고 `connectSchema`(Go `orm.ConnectSchema`, PHP `Orm::connectSchema`, Rust `Db::connect_schema`, TypeScript `Db.connectSchema`, Python `Db.connect_schema`)로 같은 방법으로 자기 set을 등록한다. `utils().schema().install(schema)`는 set의 테이블을 만들고 데이터베이스를 확인한 뒤 같은 연결에 그 set을 등록한다. 셋 다 generated schema 값, 곧 manifest text와 선언한 `manifestHash`(Go `model.Schema`, PHP `Polyspec\Orm\Tests\Model\schema()`, Rust `model::SCHEMA`, TypeScript `SCHEMA`, Python `SCHEMA`)를 받고, text가 선언한 hash로 hash되지 않으면 어떤 statement보다 먼저 `CONFIG`로 실패한다. 등록은 외부 문서를 쓰는 set도 데이터베이스를 읽거나 쓰지 않는다. 데이터베이스는 연결마다가 아니라 set을 설치하거나 올릴 때(`install`, `addTablesAndColumns`) 확인하므로, 요청마다 연 연결은 statement 없이 set을 등록한다([schema](schema.ko.md#_6-schema-registration)). raw 연결(클라이언트의 `connect(dsn, …)`)은 set을 등록하지 않고, generated code를 읽는 것도 연결에 아무것도 등록하지 않는다. 연결에 등록되지 않은 manifest의 요청은 같은 형태의 plan이 캐시되어 있어도 실행 전에 `SCHEMA_HASH_MISMATCH`로 실패하고, manifest text가 선언한 `manifestHash`로 hash되지 않는 generated code의 요청도 그렇다. 다른 등록 호출은 없다. 모든 클라이언트가 이 규칙을 따른다.

다섯 플래너는 같은 요청에서 같은 SQL과 bind slot을 만든다. `tests/conformance`는 MySQL, PostgreSQL, SQLite에서 같은 벡터를 다섯 클라이언트로 실행하고 문장, bind, 결과를 기록된 기대값과 비교한다.

## 5. IR executors

DSN scheme은 SQL dialect 대신 IR executor를 고를 수 있다. `markdown://` scheme은 flowmark executor를 고르며, 이 executor는 flowmark server가 제공하는 markdown corpus에서 요청을 실행한다([capability 표](dialects.ko.md#markdown-ir-executor)). 4절은 SQL dialect에만 적용된다.

- **연결.** DSN은 `markdown://127.0.0.1:<port>/<corpus>?token=<token>`이다. port는 `flowmark serve`가 loopback TCP에서만 듣는 port이고, corpus는 corpus root의 directory 이름이며, token은 server가 corpus의 `.flowmark/server.json`에 두는 token이다. DSN은 다른 매개변수를 받지 않으며, 다른 host, 빠진 port, 이름 하나가 아닌 path, 빠진 token은 연결을 열기 전에 `CONFIG`다. 클라이언트의 연결 하나는 server와의 TCP 연결 하나이고, 클라이언트는 데이터베이스 연결과 같은 방식으로 그 연결을 유지한다([설정](config.ko.md)). 그 연결의 풀을 유지하며, 풀이 없는 PHP 클라이언트는 `Db`마다 연결 하나를 유지한다.
- **전송.** 메시지는 한 줄에 JSON object 하나이고, server는 연결의 메시지마다 차례대로 한 줄의 답을 쓴다. `op`가 있는 메시지는 제어 메시지이고 나머지는 요청 메시지다. 연결의 첫 메시지는 DSN의 corpus와 token을 담은 `{"op": "connect", "corpus": <corpus>, "token": <token>}`이며 `{"ok": true}`로 답을 받는다. server는 다른 corpus나 token, 또는 다른 첫 메시지에 `CONFIG`로 답하고 연결을 닫으므로, 연결은 그 `CONFIG`로 실패한다.
- **검증.** 클라이언트는 요청마다 `ir.Validate`로 요청을 검증하고 계획하지 않는다. SQL을 보내지 않고 plan을 읽지도 않는다. 요청을 계획하고 실행하는 것은 executor다.
- **메시지.** 요청마다 메시지 하나 `{ir_version, manifest_hash, request, params, now}`를 executor에 전한다. `request`는 1절의 요청이며 필드와 값(매개변수 index)이 같다. `manifest_hash`는 1절대로 확인하고, `now`는 2절의 요청 시각을 `datetime` text 형식으로 적는다.
- **매개변수.** `params`는 runtime value model JSON을 쓴다. decimal은 문자열, bytes는 base64, datetime은 UTC의 `YYYY-MM-DD HH:MM:SS.ffffff`, date는 `YYYY-MM-DD`, time은 `HH:MM:SS.ffffff`다. `datetime(p)`나 `time(p)`의 값은 p 뒤 자리가 0이고, 클라이언트의 시각 text(`10:00:00`, `2024-01-02T03:04:05.5`, offset이 있는 datetime은 UTC로 바꿔서)도 이 소수 6자리 형식으로 적으며, 다른 형식의 text는 `CODEC_ENCODE`다. 공유 case는 `tests/bind/vectors.json`의 `message` case다. 매개변수가 채우는 slot이 형식을 정한다. `ir.ParamUses`가 매개변수마다 그 slot과 논리 type(precision, scale, length, nullability를 가진 비교하거나 대입하는 column, column 함수의 결과, 상대 시각 함수의 간격인 `i32`나 `f64`, `contains`와 `contains_binary`의 `text`, `if_parent`의 부모 column, `optimistic`의 column)을 나열한다. 이 type은 SQL 쪽 style을 거치기 전의 type이고, `contracts/fixtures/planner.json`의 `param_uses` case가 다섯 validator에서 이를 고정한다. 클라이언트의 시각 text는 그 type의 형식으로 적는다. `hex`나 `ip` column의 slot은 SQL 데이터베이스에서처럼 인코딩한 값을 받는다. 모든 클라이언트는 어떤 statement보다 먼저 각 매개변수를 그 slot의 논리 type으로 검사하고, 그 밖의 값은 `CODEC_ENCODE`다. IR executor의 결과도 같다. 다른 host 종류의 값(`i16`, `i32`, `i64`는 정수, `f64`는 수, `bool`은 boolean, `decimal`, `varchar`, `text`, `uuid`는 text, `bytes`는 bytes나 text, `date`, `time`, `datetime`은 text), 범위를 넘는 정수, 유한하지 않은 `f64`, 전체 p자리나 소수 s자리를 넘는 decimal, 0001-01-01~9999-12-31 밖의 날짜, p 뒤에 0이 아닌 숫자가 있는 time이나 datetime(그 자리의 0은 받는다), 뒤쪽 공백을 포함해 n자를 넘는 `varchar(n)` 값, `text`나 `varchar`의 U+0000, 소문자 표준 text가 아닌 `uuid`가 그 밖의 값이다. `date`, `time`, `datetime` slot의 매개변수는 canonical text 형식만 받는다. 네이티브 시각 값(`Date`, `DateTime`, PHP의 `DateTimeInterface`, Python의 `datetime.date`, `datetime.time`, `datetime.datetime`, Go의 `time.Time`, chrono의 `NaiveDate`와 `NaiveDateTime`)은 모든 클라이언트에서 매개변수와 slot의 이름을 밝힌 `CODEC_ENCODE`다. `now` slot과 메시지의 `now`는 클라이언트 clock이므로 매개변수가 아니며 검사하지 않는다. SQL NULL은 받는다. 다만 non-null column의 할당 slot(`set`, `rows`, `on_duplicate`, `restore`의 set)은 `not_null`과 `column`을 가지며, 그런 slot의 NULL 매개변수는 어떤 statement보다 먼저 `CODEC_ENCODE` "parameter %d assigns NULL to the non-null %s"이고 IR executor에서도 같다(`null-into-not-null` case와 conformance vector `null_into_not_null`). raw SQL은 driver code 1048, 23502, 1299를 `DRIVER`로 유지한다. utils statement의 slot처럼 `length`가 없는 `varchar` slot은 길이를 검사하지 않는다. codec stage가 있는 column은 첫 stage의 입력으로 값을 검사한다. 공유 case는 `tests/bind/vectors.json`의 `bind` case(`make bind-check`)와 conformance vector `datetime_precision_rejected`, `varchar_length_rejected`, `text_nul_rejected`, `uuid_form_rejected`다.
- **Codec.** 클라이언트가 SQL과 같이 codec 단계를 직접 적용한다. 쓰기의 값은 보내기 전에 인코딩하고, 읽기의 값은 받은 뒤에 디코딩한다.
- **읽기.** 읽기는 요청 형태에 맞게 조립된 row를 돌려준다. 조인, 관계, `key_by`, `flatten`은 1.2절이 정의한 대로다. `one`, `all`, `group_count`의 답은 `{"rows": [...]}`, `count`는 `{"count": n}`, `sum`과 `avg`는 `{"value": v}`(남은 값이 없으면 `v`는 null이며, client는 합 0과 평균 null로 읽는다), `paginate`는 `{"rows": [...], "count": n}`이며 `n`은 일치하는 모든 row의 수다. row는 출력을 projection 순서로 담은 JSON object이고, 그 뒤에 각 조인(object, 또는 일치하는 row가 없는 left join이면 null)과 각 관계(`one` 관계는 object나 null, `many` 관계는 array, `key_by`가 있으면 그 key의 object)가 온다. `flatten` 관계의 답은 `one`과 같다(1.2절). 값은 매개변수 value model을 쓴다. datetime은 `YYYY-MM-DD HH:MM:SS.ffffff`, time은 `HH:MM:SS.ffffff`, decimal과 bytes(base64)는 문자열, 정수와 `f64`는 JSON number, `bool`은 JSON bool, date와 uuid는 그 text다. 공유 답은 `contracts/fixtures/ir_answers.json`(`make ir-answers-check`)이며, 클라이언트마다 이를 model array 형식으로 디코딩한다. row의 array 형식(`toArray`)은 temporal column을 type마다 한 form으로 쓰며, 위의 value model text이고 모든 클라이언트가 같다. `date`는 `YYYY-MM-DD`, `datetime`은 `YYYY-MM-DD HH:MM:SS.ffffff`, `time`은 `HH:MM:SS.ffffff`이므로 `date`를 datetime으로 쓰지 않는다. 공유 검사도 같은 파일이다.
- **쓰기.** 쓰기는 `{affected, keys}`를 돌려준다. `keys`는 삽입한 row마다 그 primary key를 삽입 순서대로 담는다. `affected`는 쓴 row를 하나씩 계산한다. `on_duplicate`가 있는 insert는 삽입이든 갱신이든 모든 database에서 1이고(MySQL만 갱신을 2로 계산한다), `update`는 바꾼 row만이 아니라 일치한 row를 계산한다(MySQL client는 found rows를 요청한다). conformance vector `affected_counts`는 세 database에서 test entry point([3.4](#_3-4-test-write-result))로 이 값을 읽는다.
- **오류.** 실패한 메시지는 `{"error": {"code": <code>, "message": <text>}}`로 답을 받는다. code는 [errors.yaml](errors.yaml)의 코드 하나이며, 클라이언트는 그 code와 message의 오류를 돌려준다. hash가 다르면 `SCHEMA_HASH_MISMATCH`다. 읽은 뒤 대상이 바뀐 쓰기는 `WRITE_CONFLICT`이고, transaction이 읽은 뒤의 변경 때문에 transaction의 쓰기가 다른 쓰기가 되는 `commit`도 그렇다. 예를 들어 읽기에 새로 맞거나 더는 맞지 않게 된 행이다. 이 오류는 파일과 줄을 적는다. 바뀐 읽기 위에서 callback을 다시 실행하는 것은 결코 안전하지 않으므로, 클라이언트는 retry option이 있어도 이를 재시도하지 않는다: transaction이 재시도하는 `DEADLOCK`과 달리 commit은 callback을 한 번 실행한 뒤 `WRITE_CONFLICT`를 돌려준다(`contracts/fixtures/ir_answers.json`의 case `commit_write_conflict`와 `commit_deadlock`). 끝난 lock 대기는 `CANCELED`다. JSON object가 아닌 줄, 어떤 제어 메시지도 가리키지 않는 `op`, 제어 메시지가 받지 않는 필드는 `IR_INVALID`다. 끊긴 연결은 `CONNECTION_LOST`이며, server가 한도보다 오래 쉰 트랜잭션의 연결을 닫기 전에 쓰는 답도 그렇다. 호출의 context나 signal이 끝나면 클라이언트는 연결을 닫고 호출은 `CANCELED`다. server는 닫힌 연결의 트랜잭션을 rollback한다.
- **세션.** 연결 하나가 세션이다. 제어 메시지 `{"op": "begin", "read_only"?}`, `{"op": "commit"}`, `{"op": "rollback"}`, `{"op": "savepoint" | "release" | "rollback_to", "name"}`가 트랜잭션을 시작하고, 끝내고, 중첩한다. `name`은 `savepoint`, `release`, `rollback_to`가 가리키는 savepoint의 이름이다. 클라이언트는 `readOnly` 옵션의 트랜잭션이면 `read_only` true를 쓰고, 그 밖에는 `read_only`를 쓰지 않는다. executor는 그 트랜잭션에 쓰기 lock을 잡지 않고, SQL 데이터베이스가 읽기 전용 트랜잭션의 쓰기를 거절하듯 그 안의 모든 쓰기를 `READ_ONLY`로 거절한다(`tests/bind/vectors.json`의 `control` case와 `contracts/fixtures/ir_answers.json`의 case `read_only_write`). 제어 메시지마다 `{"ok": true}` 또는 오류를 돌려준다. 트랜잭션은 `begin`부터 끝까지 연결 하나를 잡고, 트랜잭션 밖의 요청은 풀의 아무 연결에서 자기 트랜잭션으로 실행된다.
- **executor가 정하는 column.** `identity`, `key_prefix`, `order` column은 executor가 값을 정하므로 insert에서 생략할 수 있다. 1.4절은 planner가 정하는 column을 정의하며, 이 column들은 executor가 정한다.
