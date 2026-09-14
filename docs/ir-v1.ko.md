# IR v1 스펙

현행 구현 기준은 [공통 인터페이스](interfaces.md), [DSL](dsl.md), [프로토콜](protocol.md), [스키마](schema.md)다.

목표: **스키마 1개 → 파서 1개 → spec.json(IR) → 렌더러 4개(PHP/Go/Rust/TypeScript)**.
렌더러는 파싱을 하지 않는다. IR을 읽어 이름을 조합만 한다.

```
schema/*.sql  ──파서──▶  spec/*.json  ──▶ php.tmpl / go.tmpl / rust.tmpl
```

## 0. 불변 규칙

1. **연산자는 위치로 고정한다.** IR에는 항상 `{op, column}` 쌍으로만 존재한다.
   문자열 `gt_created_ts`는 IR 어디에도 나타나지 않는다. 렌더 시점에 조합될 뿐이다.
2. **정규 토큰(canonical token)** 은 `op:column` 이다. 네 렌더러의 토큰 집합은 항상 같아야 한다.
3. 케이싱은 렌더러가 언어 관례대로 변환한다.
   `{op:"gt", column:"created_ts"}` → `gtCreatedTs` / `GtCreatedTs` / `gt_created_ts`

## 1. 파일 단위

테이블 하나 = spec 파일 하나.

```json
{
  "ir_version": 1,
  "table": "user",
  "entity": "user",
  "primary_key": "user_seq",
  "timestamps": { "created": "created_ts", "updated": "updated_ts" },
  "columns": [ ... ],
  "relations": [ ... ],
  "unique_keys": [ ["email"] ]
}
```

`entity`는 snake_case 단수. 렌더러가 `User` / `user` / `user::` 로 변환한다.

## 2. 컬럼

```json
{
  "name": "created_ts",
  "type": "timestamp",
  "nullable": false,
  "auto_increment": false,
  "default": null,
  "db_type": "int(11) unsigned",
  "style": [],
  "ops": ["eq","ne","gt","ge","lt","le","in","between","is_null"]
}
```

`ops`는 파서가 타입과 스타일로 계산해 기록한다. 렌더러는 판단하지 않는다.

### 2.1 정규 타입

| IR type | PHP | Go | Rust | TypeScript |
|---|---|---|---|
| `i32` | `int` | `int32` | `i32` | `number` |
| `i64` | `int` | `int64` | `i64` | `number` |
| `f64` | `float` | `float64` | `f64` | `number` |
| `decimal` | `string` | `decimal.Decimal` | `rust_decimal::Decimal` | `string` |
| `bool` | `bool` | `bool` | `bool` | `boolean` |
| `string` | `string` | `string` | `String` | `string` |
| `text` | `string` | `string` | `String` | `string` |
| `bytes` | `string` | `[]byte` | `Vec<u8>` | `Uint8Array` |
| `date` | `string` | `time.Time` | `chrono::NaiveDate` | `string` |
| `datetime` | `string` | `time.Time` | `chrono::NaiveDateTime` | `string` |
| `timestamp` | `int` | `int64` | `i64` | `number` |
| `json` | `array` | `json.RawMessage` | `serde_json::Value` | `unknown` |
| `point` | `array{float,float}` | `orm.Point` (`[2]float64`) | `orm::Point` (`(f64, f64)`) | `Point` (`readonly [number, number]`) |
| `inet` | `string` | `netip.Addr` | `std::net::IpAddr` | `string` |
| `enum` | `string` | `string` + const | `enum` | string union |

`timestamp`는 unix epoch **정수**다. MySQL `TIMESTAMP` 컬럼은 `datetime`으로 매핑한다.

nullable은 PHP `?T`, Go `*T`, Rust `Option<T>`, TypeScript `T | null`을 사용한다. Go는 `sql.NullX`를 사용하지 않는다.

### 2.2 dataStyle

파이프라인 배열이다. **쓰기는 배열 순서대로, 읽기는 역순.**

```json
"style": ["json"]              // json_encode
"style": ["serialize","gz"]    // serialize → gzcompress
"style": ["aes","hex"]         // authenticated AES ciphertext → HEX
"style": ["ip"]                // INET6_ATON / INET6_NTOA
```

단일 문자열 스타일(`aes_serialize`, `aes_hex`)을 단계별 목록으로 분해한 것이다. 조합이 생길 때마다 새 이름을 만들지 않아도 된다.

| stage | 인코드 | 디코드 | 위치 |
|---|---|---|---|
| `json` | `json_encode` | `json_decode` | app |
| `yaml` | yaml dump | yaml parse | app |
| `serialize` | 언어별 직렬화 | 〃 | app |
| `gz` | gzip | gunzip | app |
| `base64` | b64 | 〃 | app |
| `hex` | hex | unhex | app |
| `aes` | host AES-256-GCM v2 ciphertext | host AES-256-GCM v2 ciphertext decode | **host** |
| `ip` | `INET6_ATON(?)` | `INET6_NTOA(col)` | **SQL** |
| `point` | `ST_PointFromText(?)` | `ST_AsText(col)` | **MySQL은 SQL, PostgreSQL·SQLite는 typed text 변환** |

`serialize`는 언어 간 호환되지 않는다. 여러 언어가 같은 테이블을 조회하면 파서가 **경고**를 반환한다. 공통 데이터에는 `json`을 사용한다.

SQL 위치 stage가 있으면 SELECT 목록과 바인드가 같이 바뀌므로, 렌더러는 컬럼 표현식을 항상 `select_expr` / `bind_expr` 로 받는다.

### 2.3 ops 결정 규칙

기본 매트릭스:

| type | ops |
|---|---|
| `i32 i64 f64 decimal date datetime timestamp` | `eq ne gt ge lt le in between is_null` |
| `string text` | `eq ne gt ge lt le in lk lb is_null` |
| `enum` | `eq ne in is_null` |
| `bool` | `eq ne is_null` |
| `inet` | `eq ne in is_null` |
| `json bytes point` | `is_null` |

스타일 보정 — **인코딩된 컬럼에 순서 비교는 무의미하다.**

- `["aes"]`, `["aes","hex"]` : 인증된 버전 ciphertext이므로 `eq ne in is_null` 유지, 나머지 제거
- `["gz"]`, `["base64"]`, `["serialize"]`, `["json"]` : `is_null` 만
- `["ip"]` : `eq ne in is_null` (`INET6_ATON` 결과는 정렬 가능하므로 `gt/lt`는 v2에서 검토)
- `nullable: false` 면 `is_null` 제거

`lk`=LIKE, `lb`=LIKE BINARY. `fulltext`는 v2.

## 3. 관계

```json
{
  "name": "profile",
  "kind": "one",
  "table": "user_profile",
  "entity": "user_profile",
  "local": "user_seq",
  "foreign": "user_seq"
}
```

`kind`: `one` | `many`. 메서드는 `withProfile()` / `WithProfile()` / `with_profile()`.

로딩은 부모 행들의 `local` 값을 모아 dedup 후
`IN (...)` 한 번. 관계당 쿼리 1개. `kind:"many"`는 foreign이 유니크하지 않으므로
자식 PK 기준으로 전량 조회 후 앱에서 그룹핑한다.

navigation predicate는 `IRNav` item에서 `mode:"exists"`, `mode:"not_exists"`, `mode:"count"`를 사용한다. count mode에는 `count_op`(`eq`, `not_eq`, `gt`, `gte`, `lt`, `lte`)와 parameter index `p`가 필요하다. planner는 correlated subquery를 생성하고 대상 soft-delete 조건을 적용한다.

관계 로딩은 **별도 쿼리 + 배치 로딩**을 사용한다. 조인은 query IR에서 별도로 표현한다.

## 4. 검증 (파서가 빌드를 깨뜨린다)

1. 컬럼명에 `_and_` / `_or_` 포함 → **에러**. PHP `__call` 파서가 두 조건으로 쪼갠다.
2. 컬럼명이 op 토큰 + `_` 로 시작(`gt_`, `eq_`, `lk_`, `in_`, `between_` …) → **에러**.
3. 컬럼명이 예약 접두어(`get`, `gets`, `set`, `order`, `with`, `match`)와 충돌 → **에러**.
4. `style`에 `serialize` + 다중 언어 타깃 → **경고**.
5. `primary_key`가 `columns`에 없음 → **에러**.

1·2는 런타임의 조용한 실패를 빌드 타임 검증으로 끌어올린 것이다.

## 5. 패리티 테스트

각 렌더러는 `--dump-tokens` 로 정규 토큰 집합을 출력한다.

```
predicate  gt:created_ts
predicate  eq:status
predicate  in:status
order      asc:created_ts
order      desc:created_ts
relation   with:profile
terminal   get
terminal   gets
```

CI에서 4-way diff를 실행한다. 하나라도 다르면 실패한다. 케이싱이 달라 문자열 비교가 안 되므로
**생성된 소스가 아니라 토큰을 비교한다.**

## 6. Tenant scope

`Query.scope_p`는 request parameter 목록의 optional index다. `Query.where`와 분리되며 entity manifest가 scope 컬럼을 선언한 경우에만 사용할 수 있다. compiler는 사용자 predicate group 외부에 scope를 적용하고, join entity에는 JOIN ON으로 추가하며, 각 relation 단계에도 포함한다. insert는 scope 컬럼에 해당 parameter를 사용한다. update와 upsert는 scope 컬럼을 설정할 수 없다. raw SQL은 `scope_p`를 사용할 수 없다.

## 7. v1 범위

포함: 단일 테이블 술어, order/limit/offset, CRUD, dataStyle, 배치 로딩 관계, `raw()` 1개.
제외: 조인, 서브쿼리, 괄호 중첩, 집계, 트랜잭션 헬퍼(v2), fulltext.
