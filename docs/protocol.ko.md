# IR과 Plan 프로토콜

클라이언트는 [DSL](dsl.md)로 만든 모델을 아래 요청으로 변환하고, 호출한 프로세스 안에서 요청을 plan으로 계획한 뒤 요청 형태를 키로 plan을 캐시한다. 타입 정의는 `engine/ir/ir.go`와 `engine/plan/plan.go`를 기준으로 하며, 모든 클라이언트가 같은 필드를 구현한다.

## 1. 요청

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
| `manifest_hash` | generated code가 가진 document set의 `manifestHash`다. `sha256:` 뒤에 소문자 16진수 64자리가 온다([manifest와 hash](dbspec.ko.md#manifest-and-hashes)). 클라이언트가 읽은 모델과 hash가 다른 요청은 `SCHEMA_HASH_MISMATCH`로 실패한다. 이 필드는 `schema_hash`를 대신하며 오류 코드 이름은 그대로다 |
| `kind` | `one`과 `all`은 행을 읽고, `count`는 행이나 그룹 수를 계산하며, `group_count`는 `row_count`를 가진 그룹 행을 반환한다. `sum`과 `avg`는 `agg`를 집계하고, `paginate`는 페이지 문장과 개수 문장을 반환하며, `insert`, `update`, `delete`는 행을 쓰고, `restore`는 지워진 행 하나의 soft delete 컬럼을 비운다([restore](#_1-5-restore)) |
| `set` | `insert`와 `update`의 할당 |
| `rows` | 추가로 삽입할 각 행의 매개변수를 `set` 컬럼 순서로 나열한다. 이때 `set`의 모든 항목은 값 할당이어야 하며 `on_duplicate`는 사용할 수 없다 |
| `on_duplicate` | 삽입한 행이 기존 고유 키와 겹칠 때 적용하는 할당 |
| `optimistic` | `update`는 컬럼 값이 매개변수와 같을 때만 일치한다. 일치하는 행이 없으면 `OPTIMISTIC_LOCK`을 반환한다 |
| `lock` | 루트 행 조회에만 사용하며 클라이언트는 트랜잭션 안에서만 허용한다 |

`Query`는 루트, 조인 자식, 관계 자식, 서브쿼리가 함께 쓰는 형태로 `entity`, `columns`, `on`(조인 자식 전용), `where`, `joins`, `relations`, `order`, `group_by`, `limit`, `force_index`, `lock`, 관계 옵션으로 이루어진다.

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
- 관계는 별도 문장으로 실행한다. `limit_per_parent`는 부모 키마다 자식 행 수를 제한하고, `if_parent`는 컬럼 값이 매개변수와 같은 부모에 대해서만 자식을 읽는다. `flatten`은 자식 컬럼을 부모 행에 합치고, `key_by`는 자식 컬렉션의 키를 정하며, `no_cascade_delete`는 재귀 삭제에서 관계를 제외한다.

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

- `conn`은 항목을 같은 그룹의 이전 항목에 연결한다. 첫 항목에는 연결자가 없다.
- `ref.path`는 SQL 문장 루트에서 시작하는 조인 경로(`""`는 루트, `a/b`는 중첩 조인)이거나, 서브쿼리를 소유한 모델을 뜻하는 `^`다.
- `fn`은 `p`와 비교하기 전에 `column`에 컬럼 함수를 적용한다. `value`는 `column`을 값 함수와 비교한다. 함수는 구조만 전달하며 각 dialect가 [dialect](dialects.md)의 설명대로 SQL을 만든다. 알 수 없는 함수는 `FUNCTION_UNKNOWN`을 반환한다.
- `not`은 하위 묶음을 부정하며 `NOT (…)`로 렌더링된다. `not`을 가진 top-level `where`나 `on` 묶음은 `IR_INVALID`다.
- 요청은 SQL text를 싣지 않는다. 모든 조건, 출력, 정렬, 그룹, 할당은 위 형식 중 하나이며 plan의 모든 bind slot은 dbspec type을 가진다.
- `contains`와 `contains_binary`는 값을 와일드카드 사이에 바인드한다. `contains_binary`는 대소문자를 구분한다.

### 1.4 정렬과 할당

```json
Order  = {"column": "seq", "desc": true} | {"column": "start_dt", "fn": Func} | {"random": true}
Assign = {"column", "p"} | {"column", "null": true} | {"column", "plus_p"} | {"column", "minus_p"}
```

`minus_p`는 음수 값을 저장하지 않는다.

default가 있는 컬럼을 빼먹은 `insert`는 database default를 받으며 planner는 값을 더하지 않는다. default가 없는 non-null 컬럼을 빼먹은 `insert`는 `IR_INVALID`로 실패한다. planner는 실행기가 소유한 컬럼을 할당한다. AES 키 버전, 모든 `update`의 `updated` 컬럼, 그리고 `audit` setting이 있는 테이블에서는 모든 `insert`, `update`, soft delete, restore, duplicate update의 audit 컬럼이다. AES 키 버전이나 audit 컬럼을 할당하는 요청은 `IR_INVALID`로 실패한다.

### 1.5 Restore

`restore` 요청은 `soft_delete` setting이 있는 테이블([dbspec](dbspec.ko.md#settings))에서 soft delete한 행 하나를 지정한다. `where`에는 매개변수를 가진 `eq` predicate만 `and`로 이어지며, 이 predicate들은 primary key나 unique key 하나의 모든 컬럼을 순서와 상관없이 한 번씩 지정한다. `set`은 restore와 함께 쓰는 새 값이며 `update` 할당과 같은 규칙을 따른다. primary key, identity, soft delete 컬럼의 할당은 `IR_INVALID`로 실패한다. `optimistic`은 없다. plan은 `main` step 하나다:

```sql
UPDATE `link` SET `note` = ?, `deleted_at` = NULL, `audit_seq` = ? WHERE `link`.`team_id` = ? AND `link`.`member_id` = ? AND `link`.`deleted_at` IS NOT NULL
```

이 step은 새 값을 쓰고, soft delete 컬럼을 비우며, `audit` setting이 있는 테이블에서는 audit 컬럼을 쓴다. soft delete처럼 `updated` 컬럼은 할당하지 않는다. 지워지지 않은 행과 없는 행은 어떤 행과도 맞지 않으므로 문장은 새 값을 포함해 아무것도 바꾸지 않는다. `soft_delete`가 없는 테이블의 요청, 다른 형태의 predicate, key 밖의 컬럼, key의 일부만 지정한 요청은 `IR_INVALID`로 실패한다. 읽기는 언제나 soft delete한 행을 빼며, soft delete한 행과 맞는 요청은 `restore`뿐이다. 모델 메서드 `restore`는 이 step을 실행한 뒤 같은 key로 행을 읽는다([사용법](usage.ko.md#restore-a-soft-deleted-row)).

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
- `bind_slots.from`은 `param`(요청 매개변수. 포함 검색 값에는 `transform`, AES·hex·IP 단계에는 `host_styles`가 있다), `secret`(AES 키), `config`(AES 키 버전), `parent`(관계 키 값), `now`(UTC의 클라이언트 시각), `audit`(트랜잭션 audit 기록의 primary key. `name`은 audit 기록 테이블이다) 중 하나다. `audit` 슬롯이 있는 쓰기를 audit 값을 가진 트랜잭션 밖에서 실행하거나 audit 기록이 `name`과 다른 테이블의 행이면 데이터베이스에 닿기 전에 `CONFIG`로 실패한다.
- **Clock.** 이것이 유일한 clock 규칙이며 [dialects](dialects.ko.md)와 [plans](plans.ko.md)는 이 규칙을 따른다. 모든 연결은 `datetime(p)`를 UTC로 읽고 쓴다. `now` slot은 마이크로초 해상도의 UTC 클라이언트 wall clock을 소수 여섯 자리로 자른 `datetime` 텍스트이며, statement는 clock을 한 번 읽으므로 그 statement의 `now` slot은 모두 같다. ORM이 쓰거나 비교하는 clock은 마이크로초를 유지한다. update 시각과 soft delete는 column이 선언한 소수 자릿수로 clock을 대입한다: MySQL은 `p > 0`이면 `CURRENT_TIMESTAMP(p)`, PostgreSQL은 `CURRENT_TIMESTAMP`, SQLite는 `now` slot이다. MySQL `now` value function과 그 상대 형식은 `NOW(6)`, PostgreSQL은 `now()`를 쓴다. SQLite에는 마이크로초 clock이 없으므로 SQLite dialect는 update 시각, soft delete, `now` 함수에 `now` slot을 bind하고, 상대 형식을 `now` slot에 간격을 적용한 `datetime` 뒤에 두 번째 `now` slot의 소수 여섯 자리를 붙인 형태로 render하며, insert가 빼먹은 `default now` 컬럼마다 `now` slot을 bind한다. MySQL과 PostgreSQL의 insert는 그런 컬럼을 database default에 맡긴다. plan history는 tool clock을 소수 여섯 자리로 유지한다([plans](plans.ko.md#apply)).
- 행은 위치로 읽는다. `assemble.columns[].styles`는 클라이언트가 디코딩할 코덱 단계이며, SQL 단계는 이미 적용되어 있다.
- `assemble.key`는 컬렉션 식별자다. 기본 키의 모든 구성 요소이거나 `group_count` 행의 그룹 컬럼이다.
- `group_count` 행은 선택한 그룹 컬럼의 선언된 타입을 보존한다. 불리언 그룹 값은 JSON 불리언이며 데이터베이스 불리언 값이 잘못되면 디코딩에 실패한다.
- `children[].kind`는 같은 행의 자식이면 `join`, `parent_keys`와 `child_keys`로 연결되는 관계 단계면 `one` 또는 `many`다.

### 2.1 관계 단계

- 관계마다 부모 단계 뒤에 `relation` 단계가 하나 있다. 중첩 관계도 같은 규칙을 따르며, `paginate`의 단계 순서는 본문, 관계, 개수다.
- 클라이언트는 모든 부모 행의 키를 순서대로 읽고, 키가 null인 행과 중복을 제거한다. 남은 키가 없으면 문장을 실행하지 않는다. `if_parent`가 있으면 컬럼 값이 매개변수와 같은 부모만 사용한다.
- `parent` 슬롯은 클라이언트가 키 목록으로 확장하는 자리표시자 하나다. 목록은 마지막 키를 반복해 2의 거듭제곱 길이로 맞추므로 크기 구간마다 준비된 문장 하나를 사용한다. 드라이버 바인드 한도보다 긴 목록은 나누어 실행한다.
- `one`은 첫 자식 행을, `many`는 자식 순서의 컬렉션을 붙인다. 컬렉션 키가 겹치면 마지막 행을 유지한다.

## 3. 오류

오류는 [errors.yaml](errors.yaml)의 코드와 메시지를 가진다. 예를 들어 `IR_INVALID`, `SCHEMA_HASH_MISMATCH`, `COLUMN_UNKNOWN`, `OPERATOR_NOT_ALLOWED`, `FUNCTION_UNKNOWN`, `EMPTY_IN`, `LIMIT_IN_RELATION`, `COLUMN_ALIAS_CONFLICT`가 있다. 실행기는 `CONFIG`, `OPTIMISTIC_LOCK`, `LOCK_NOT_AVAILABLE`, `DEADLOCK`, `DUPLICATE_KEY`, `FOREIGN_KEY`, `CONSTRAINT`, `READ_ONLY`, `DRIVER`를 추가한다. 클라이언트는 모든 드라이버 오류를 ORM 오류로 반환한다. catalog에 있는 조건은 그 코드를, 그 밖의 드라이버 오류는 `DRIVER`를 가지며, 모두 드라이버 메시지와 원인인 드라이버 오류를 유지한다. `audit`이나 `immutable` trigger가 거부한 쓰기는 `DRIVER`다. 트랜잭션이나 savepoint의 callback이 실패하고 rollback도 실패하면 클라이언트는 code `ROLLBACK`을 가진 오류 하나를 반환한다. 그 메시지는 두 오류를 적고, 오류는 callback 오류와 rollback 오류를 유지한다(PHP: previous exception과 `rollback`, TypeScript: `cause`와 `rollback`, Go: 두 오류를 이 순서로 담은 `errors.Join`, Rust: `Error::Rollback { callback, rollback }`). `ROLLBACK` 오류는 재시도하지 않는다. NOWAIT lock 실패는 항상 `LOCK_NOT_AVAILABLE`이며 transaction conflict로 재시도하지 않는다.

### 3.1 Test faults

test는 자기 클라이언트의 test entry point로 모든 데이터베이스에서 트랜잭션의 rollback을 결정적으로 실패시킨다. production process는 이 fault를 설정할 수 없다. entry point는 handle의 연결에 rollback fault를 설정하고, 그 연결의 모든 handle이 이를 공유한다. callback이 실패한 다음 트랜잭션의 rollback은 평소대로 실행되어 데이터베이스가 트랜잭션을 버리고, 그 뒤 클라이언트는 rollback을 `FAULT` 오류로 실패했다고 보고한다. 트랜잭션은 callback 오류와 `FAULT` 오류를 유지한 `ROLLBACK` 오류 하나를 반환한다. commit, savepoint rollback, 실패한 begin이나 commit 뒤의 rollback은 fault를 소비하지 않는다. fault는 callback 실패 뒤의 트랜잭션 rollback이 소비할 때까지 설정된 채로 남고, 그다음 callback이 실패한 트랜잭션은 callback 오류만 반환한다.

fault는 각 클라이언트의 test entry point에만 있다. DSN, 설정 값, 환경 변수는 fault를 설정하지 않는다.

| 클라이언트 | Entry point | production build가 제외하는 방법 |
|---|---|---|
| Go | `orm.FailNextRollback(db)` | build tag `ormtest`가 있을 때만 파일을 compile한다(`go test -tags ormtest`). tag가 없으면 함수가 없어 호출이 compile되지 않는다 |
| Rust | `orm::testing::fail_next_rollback(&db)` | cargo feature `test-faults`가 있을 때만 module을 compile하며, 어떤 default feature도 이를 켜지 않는다. `[dev-dependencies]`에서 켠다 |
| TypeScript | `@polyspec/orm-typescript/testing`의 `failNextRollback(db)` | package는 condition `orm-test`에서만 이 subpath를 export한다. `node --conditions=orm-test`가 없으면 import가 `ERR_PACKAGE_PATH_NOT_EXPORTED`로 실패하고, package entry point는 이 함수를 export하지 않는다. test의 type check는 `customConditions: ["orm-test"]`로 subpath를 찾는다 |
| PHP | `Orm\Testing\Faults::failNextRollback($db)` | class는 package의 `testing/Faults.php`에 있고 package autoloader는 이 파일을 연결하지 않는다. process는 그 파일을 경로로 require한 뒤에만 class를 가진다 |

## 4. 클라이언트 안의 계획

모든 클라이언트는 호출한 프로세스 안에서 요청을 검증하고 계획한다. 컴파일러 서비스, 데몬, 확장은 사용하지 않는다.

| 클라이언트 | 검증, 계획, 방언, DDL |
|---|---|
| Go | `engine/ir`, `engine/planner`, `engine/dialect`, `engine/dbspec` DDL |
| PHP | `clients/php/src/Validator.php`, `Planner.php`, `Dialect.php`, `Dbspec/Renderer.php` DDL |
| Rust | `clients/rust/orm/src/engine/`, `clients/rust/orm-schema/src/dbspec/` DDL |
| TypeScript | `clients/typescript/src/engine/`, `clients/typescript/src/dbspec/` DDL |

generated code는 document set의 manifest text와 `manifestHash`를 가진다. 클라이언트는 그 text로 runtime model을 한 번 만들고, 선언한 hash와 text의 hash가 다르면 거부한다(`SCHEMA_HASH_MISMATCH`). plan 캐시 키는 manifest hash와 요청 형태다. 매개변수 값은 키에 포함하지 않는다.

한 프로세스는 여러 document set의 generated code를 읽을 수 있고, 연결 하나가 그중 여러 set을 처리할 수 있다. 연결은 자기에게 등록된 set으로만 요청을 계획한다. 요청이 실행될 수 있는 대상은 프로세스가 읽은 code가 아니라 연결이 쓰는 데이터베이스가 정하기 때문이다. set은 세 방법으로 연결에 등록된다. `utils().schema().register(schema)`는 set을 연결에 등록한다. generated code의 connect helper(Go `model.Connect(dsn, config)`, PHP `Polyspec\Orm\Tests\Model\connect($dsn, $config)`, Rust `model::connect(dsn, pool_size, config)`, TypeScript generated module의 `connect(dsn, options)`)는 연결을 열고 `connectSchema`(Go `orm.ConnectSchema`, PHP `Orm::connectSchema`, Rust `Db::connect_schema`, TypeScript `Db.connectSchema`)로 같은 방법으로 자기 set을 등록한다. `utils().schema().install(schema)`는 set의 테이블을 만들고 데이터베이스를 확인한 뒤 같은 연결에 그 set을 등록한다. 셋 다 generated schema 값, 곧 manifest text와 선언한 `manifestHash`(Go `model.Schema`, PHP `Polyspec\Orm\Tests\Model\schema()`, Rust `model::SCHEMA`, TypeScript `SCHEMA`)를 받고, text가 선언한 hash로 hash되지 않으면 어떤 statement보다 먼저 `CONFIG`로 실패한다. 등록은 외부 문서를 쓰는 set도 데이터베이스를 읽거나 쓰지 않는다. 데이터베이스는 연결마다가 아니라 set을 설치하거나 올릴 때(`install`, `addTablesAndColumns`) 확인하므로, 요청마다 연 연결은 statement 없이 set을 등록한다([schema](schema.ko.md#_6-schema-registration)). raw 연결(클라이언트의 `connect(dsn, …)`)은 set을 등록하지 않고, generated code를 읽는 것도 연결에 아무것도 등록하지 않는다. 연결에 등록되지 않은 manifest의 요청은 같은 형태의 plan이 캐시되어 있어도 실행 전에 `SCHEMA_HASH_MISMATCH`로 실패하고, manifest text가 선언한 `manifestHash`로 hash되지 않는 generated code의 요청도 그렇다. 다른 등록 호출은 없다. 모든 클라이언트가 이 규칙을 따른다.

네 플래너는 같은 요청에서 같은 SQL과 bind slot을 만든다. `tests/conformance`는 MySQL, PostgreSQL, SQLite에서 같은 벡터를 네 클라이언트로 실행하고 문장, bind, 결과를 기록된 기대값과 비교한다.
