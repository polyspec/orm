# IR v1 스펙

목표: **스키마 1개 → 파서 1개 → spec.json(IR) → 렌더러 3개(PHP/Go/Rust)**.
렌더러는 파싱을 하지 않는다. IR을 읽어 이름을 조합만 한다.

```
schema/*.sql  ──파서──▶  spec/*.json  ──▶ php.tmpl / go.tmpl / rust.tmpl
```

## 0. 불변 규칙

1. **연산자는 위치로 고정한다.** IR에는 항상 `{op, column}` 쌍으로만 존재한다.
   문자열 `gt_created_ts`는 IR 어디에도 나타나지 않는다. 렌더 시점에 조합될 뿐이다.
2. **정규 토큰(canonical token)** 은 `op:column` 이다. 세 렌더러의 토큰 집합은 항상 같아야 한다.
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

`ops`는 파서가 타입/스타일로부터 **계산해서 박아 넣는다.** 렌더러는 판단하지 않는다.

### 2.1 정규 타입

| IR type | PHP | Go | Rust |
|---|---|---|---|
| `i32` | `int` | `int32` | `i32` |
| `i64` | `int` | `int64` | `i64` |
| `f64` | `float` | `float64` | `f64` |
| `decimal` | `string` | `decimal.Decimal` | `rust_decimal::Decimal` |
| `bool` | `bool` | `bool` | `bool` |
| `string` | `string` | `string` | `String` |
| `text` | `string` | `string` | `String` |
| `bytes` | `string` | `[]byte` | `Vec<u8>` |
| `date` | `string` | `time.Time` | `chrono::NaiveDate` |
| `datetime` | `string` | `time.Time` | `chrono::NaiveDateTime` |
| `timestamp` | `int` | `int64` | `i64` |
| `json` | `array` | `json.RawMessage` | `serde_json::Value` |
| `point` | `array{float,float}` | `[2]float64` | `(f64, f64)` |
| `inet` | `string` | `netip.Addr` | `std::net::IpAddr` |
| `enum` | `string` | `string` + const | `enum` |

`timestamp`는 compatibility 관례대로 unix epoch **정수**다. MySQL `TIMESTAMP` 컬럼은 `datetime`으로 매핑한다.

nullable: PHP `?T` / Go `*T` / Rust `Option<T>`. Go는 `sql.NullX`를 쓰지 않는다 — 세 언어의 모양이 갈라진다.

### 2.2 dataStyle (compatibility 계승)

파이프라인 배열이다. **쓰기는 배열 순서대로, 읽기는 역순.**

```json
"style": ["json"]              // json_encode
"style": ["serialize","gz"]    // serialize → gzcompress
"style": ["aes","hex"]         // AES_ENCRYPT → HEX
"style": ["ip"]                // INET6_ATON / INET6_NTOA
```

compatibility의 단일 문자열(`aes_serialize`, `aes_hex`)을 분해한 것이다. 조합이 생길 때마다 새 이름을 만들지 않아도 된다.

| stage | 인코드 | 디코드 | 위치 |
|---|---|---|---|
| `json` | `json_encode` | `json_decode` | app |
| `yaml` | yaml dump | yaml parse | app |
| `serialize` | 언어별 직렬화 | 〃 | app |
| `gz` | gzip | gunzip | app |
| `base64` | b64 | 〃 | app |
| `hex` | hex | unhex | app |
| `aes` | `AES_ENCRYPT(?, :__key)` | `AES_DECRYPT(col, :__key)` | **SQL** |
| `ip` | `INET6_ATON(?)` | `INET6_NTOA(col)` | **SQL** |
| `point` | `ST_PointFromText(?)` | `ST_AsText(col)` | **SQL** |

`serialize`는 언어 간 호환이 안 된다(PHP `serialize()` ↔ Go/Rust). 세 언어가 같은 테이블을 읽는다면 파서가 **경고**를 낸다. `json`을 쓰라는 뜻이다.

SQL 위치 stage가 있으면 SELECT 목록과 바인드가 같이 바뀌므로, 렌더러는 컬럼 표현식을 항상 `select_expr` / `bind_expr` 로 받는다.

### 2.3 ops 결정 규칙

기본 매트릭스:

| type | ops |
|---|---|
| `i32 i64 f64 decimal date datetime timestamp` | `eq ne gt ge lt le in between is_null` |
| `string text` | `eq ne in lk lb is_null` (+ 인덱스가 있으면 `gt ge lt le`) |
| `enum` | `eq ne in is_null` |
| `bool` | `eq ne is_null` |
| `inet` | `eq ne in is_null` |
| `json bytes point` | `is_null` |

스타일 보정 — **인코딩된 컬럼에 순서 비교는 무의미하다.**

- `["aes"]`, `["aes","hex"]` : deterministic(MySQL 기본 ECB)이라 `eq ne in is_null` 유지, 나머지 제거
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

로딩은 compatibility의 `getRelationsData`와 동일하다 — 부모 행들의 `local` 값을 모아 dedup 후
`IN (...)` 한 번. 관계당 쿼리 1개. `kind:"many"`는 foreign이 유니크하지 않으므로
자식 PK 기준으로 전량 조회 후 앱에서 그룹핑한다.

조인은 v1에 없다. 관계는 **별도 쿼리 + 배치 로딩**만이다.

## 4. 검증 (파서가 빌드를 깨뜨린다)

1. 컬럼명에 `_and_` / `_or_` 포함 → **에러**. PHP `__call` 파서가 두 조건으로 쪼갠다.
2. 컬럼명이 op 토큰 + `_` 로 시작(`gt_`, `eq_`, `lk_`, `in_`, `between_` …) → **에러**.
3. 컬럼명이 예약 접두어(`get`, `gets`, `set`, `order`, `with`, `match`)와 충돌 → **에러**.
4. `style`에 `serialize` + 다중 언어 타깃 → **경고**.
5. `primary_key`가 `columns`에 없음 → **에러**.

1·2는 compatibility 런타임에서 조용히 깨지던 것을 빌드 타임으로 끌어올린 것이다.

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

CI에서 3-way diff. 하나라도 다르면 실패. 케이싱이 달라 문자열 비교가 안 되므로
**생성된 소스가 아니라 토큰을 비교한다.**

## 6. v1 범위

포함: 단일 테이블 술어, order/limit/offset, CRUD, dataStyle, 배치 로딩 관계, `raw()` 1개.
제외: 조인, 서브쿼리, 괄호 중첩, 집계, 트랜잭션 헬퍼(v2), fulltext.
