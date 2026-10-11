<!-- doc-id: dialects -->
<!-- source-sha256: 755935765da56a0467afe19ae3fdece9640e533d8dfc01b3777eef682147a9ad -->
# SQL dialect

SQL dialect는 하나의 데이터베이스 시스템이 사용하는 SQL 문법과 실행 규칙이다. 이 프로젝트에서 `mysql`, `postgres`, `sqlite`는 identifier quoting, placeholder, 타입 변환, write 문법, 지원 SQL 함수를 선택한다. Planner는 database별 SQL 요소를 선택한 SQL dialect에 요청한다. IR과 plan 형식은 변경하지 않는다.

| | MySQL 8.0.2+ / MariaDB 10.2+ | PostgreSQL 12+ | SQLite 3.46+ |
|---|---|---|---|
| identifiers | `` `x` `` | `"x"` | `"x"` |
| placeholders | `?` | `$n` (the executor renumbers when it expands a `parent` slot to N values) | `?` |
| LIMIT | `LIMIT off, n` | `LIMIT n OFFSET off` | `LIMIT n OFFSET off` |
| `Lk` | `LIKE` (정렬 규칙에 따라 대소문자 구분 없음) | `ILIKE` | `LIKE … ESCAPE '\'` (ASCII 대소문자 구분 없음) |
| `Lb` | `LIKE BINARY` | `LIKE` | `instr(col, ?) > 0` |
| `Fulltext` / `FulltextBoolean` | `MATCH … AGAINST (… IN NATURAL LANGUAGE/BOOLEAN MODE)`, boolean value normalized (`+a +b*`) | `to_tsvector('simple', coalesce(a,'') || ' ' || …) @@ plainto_tsquery / websearch_to_tsquery('simple', ?)`, value trimmed only | **rejected** (FTS5 needs virtual tables) |
| `forceIndex<Name>` | `FORCE INDEX (name)` | ignored (no hints) | `INDEXED BY "name"` |
| insert id | `LAST_INSERT_ID()` (upsert adds `pk = LAST_INSERT_ID(pk)`) | `RETURNING pk` | `RETURNING pk` |
| `duplication(model)` | `ON DUPLICATE KEY UPDATE` (any unique key) | `ON CONFLICT (cols) DO UPDATE SET` — conflict target = the first declared unique key fully covered by the inserted columns, else the PK | same as PostgreSQL |
| `groupLimit(n)` | `ROW_NUMBER() OVER (…)` | same | same |
| `tuple<ColA>With<ColB>` | `(a, b) IN ((?, ?), …)` | same | `(a, b) IN (VALUES (?, ?), …)` |
| `orderByRandom()` | `RAND()` | `random()` | `random()` |
| ORM 함수 | [DSL](dsl.ko.md) 10절 참고 | | |
| `aes`/`hex` styles | 실행기에서 인증된 AES-256-GCM v2 처리 후 `hex`가 있으면 hex text로 변환 | 실행기에서 인증된 AES-256-GCM v2 처리 후 `hex`가 있으면 hex text로 변환 | 실행기에서 인증된 AES-256-GCM v2 처리 후 `hex`가 있으면 hex text로 변환 |
| `ip` style | `INET6_ATON` / `INET6_NTOA` | `(?)::inet` / `host(col)` | client-side (16-byte packed) |
| `point` type | `POINT(x y)` bind; `ST_PointFromText(?)` / `ST_AsText(col)` | `(x,y)` bind; `CAST(? AS text)::point` / `(col)::text` | `POINT(x y)` text |
| update 시각과 soft delete가 쓰는 clock | `p > 0`인 `datetime(p)` column은 `CURRENT_TIMESTAMP(p)`, 그 밖에는 `CURRENT_TIMESTAMP` | `CURRENT_TIMESTAMP` | executor가 bind한 마이크로초 텍스트(`now` bind slot) |

Executor 결과는 PostgreSQL parent IN list 확장 후 `$n` 재번호화, client-side AES/inet codec, database별 DSN/driver 선택이다.

**Go driver package.** `packages/orm-go/orm`은 MySQL만 연결한다. PostgreSQL 또는 SQLite를 열려면 해당 package를 side effect import한다.

```go
import (
    _ "github.com/polyspec/orm/packages/orm-go/orm/pg"      // driver "postgres"
    _ "github.com/polyspec/orm/packages/orm-go/orm/sqlite"  // driver "sqlite"
)
```

import하지 않으면 `orm.Open`은 필요한 import를 포함한 `CONFIG`를 반환한다. Rust는 sqlx feature를 사용하고 PHP는 설치된 PDO extension을 사용한다.

## 세 database의 같은 결과를 유지하는 규칙
- `UPDATE`는 updated timestamp를 항상 명시한다(MySQL `updated_ts = CURRENT_TIMESTAMP(6)`, PostgreSQL `CURRENT_TIMESTAMP`, SQLite는 `now` bind slot으로 executor가 bind한 마이크로초 텍스트). soft delete도 같은 방식으로 column에 clock을 대입한다. MySQL의 `ON UPDATE`는 다른 database에 대응하지 않는다.
- `plus`와 `minus`는 column을 table-qualified로 작성한다.
- SQLite datetime은 UTC 기준 여섯 자리 소수의 text다. 삽입이 생략한 `default now` 컬럼 값은 실행기가 UTC 시각으로 채운다. datetime 컬럼과 비교하거나 대입하는 문자열도 같은 형식으로 바꾼다. `YYYY-MM-DD[ T]HH:MM:SS[.f]`는 소수 여섯 자리로 채우고, `Z`나 `±HH:MM`을 포함한 문자열은 UTC로 변환한다. date 컬럼은 `YYYY-MM-DD`를 받는다. 그 밖의 문자열은 `CODEC_ENCODE`를 반환한다.
- `decimal(P,S)` 컬럼은 MySQL에서 `DECIMAL(P,S)`, PostgreSQL에서 `NUMERIC(P,S)`, SQLite에서 `DECIMALINT(P,S)`를 사용한다. SQLite는 정확한 값을 10^S배 한 부호 있는 정수로 저장하고, 실행기는 읽을 때 생성 모델의 고정 소수부 자릿수 십진 문자열로 변환한다. 선언은 `1 ≤ P ≤ 18`, `0 ≤ S ≤ P`를 요구하므로 배율 정수가 부호 있는 64비트 정수 범위에 들어간다. 정수 decimal의 매니페스트에도 `scale: 0`을 명시한다. 잘못된 텍스트, 초과 자릿수, 소수부 손실, 맞지 않는 저장 셀은 `CODEC_ENCODE` 또는 `CODEC_DECODE`로 실패한다.
- `jsontext` 컬럼은 모든 방언에서 텍스트다. PostgreSQL은 `text`, MySQL은 `LONGTEXT`, SQLite는 TEXT다. 저장한 텍스트를 그대로 반환하므로 멤버 순서, 중복 키, 빈 객체와 빈 배열의 구분이 유지된다. ORM에는 JSON 경로 조건과 JSON 인덱스가 없으며, 데이터베이스 안에서 질의하는 데이터는 컬럼이나 자식 테이블로 만든다.
- `uuid` 컬럼은 PostgreSQL에서 네이티브 `uuid`, MySQL에서 `char(36)`, SQLite에서 TEXT다. 클라이언트는 uuid 값을 텍스트로 bind한다.
- MySQL은 TEXT, BLOB, JSON, geometry 컬럼의 리터럴 기본값을 식 형식 `DEFAULT ('value')`로 기록하며 MySQL 8.0.13 이상이 필요하다. import는 이를 리터럴로 다시 읽는다.
- Boolean은 PostgreSQL `boolean`, MySQL `BOOLEAN`/`TINYINT(1)`의 숫자 `0`/`1` 기본값, SQLite INTEGER 0/1을 사용한다. 정수가 아니라 boolean을 bind한다.
- CHECK 표현식은 PostgreSQL과 SQLite에서 선언한 표현식을 그대로 생성한다. MySQL은 predicate를 반환하는 `CASE` CHECK 정의를 거부하므로 명시적인 boolean 비교로 감싼다. `NULL`은 `UNKNOWN`으로 유지되어 표준 CHECK 의미를 보존한다. MySQL CHECK 이름은 table이 아니라 database 범위이므로 물리 이름에 table 이름을 접두어로 붙여 `ck_<table>_<name>`으로 만들고, import는 접두어를 제거해 논리 MMD 이름을 반환한다. 생성되는 제약·인덱스 이름이 엔진 식별자 길이를 넘으면 hash 접미사를 사용해 결정적으로 줄인다.
- `bind_slots[].col_type`은 placeholder가 받는 값의 dbspec type이다: 비교하거나 할당하는 column의 type(host style이 encode한 값도 저장되는 값이므로 column의 type이다), SQL 쪽 style 함수의 입력 type(`HEX`는 `bytes`, `INET6_ATON`은 `text`), 비교하는 column 함수의 결과 type, 상대 시각 함수의 간격은 `i32`나 `f64`, secret은 `text`, config 값과 audit key는 그 column의 type, `now` slot은 `datetime`이다. `parent` slot은 비교하는 key column의 type인 `key_types`를 가진다. 모든 slot에 type이 있고, type 없는 slot은 `IR_INVALID`다. PostgreSQL에서 Rust client는 각 값을 그 slot의 dbspec type에 해당하는 PostgreSQL type으로 bind하고 server에 parameter나 column 정보를 묻지 않는다. 실행기는 SQLite 시간 값을 정규화하고 typed point를 bind 전에 `POINT(x y)`로 변환한다.
- `bind_slots[].host_styles`와 `columns[].styles`는 실행기가 처리할 host stage를 기록한다. AES는 `docs/codec.md`에 정의한 `ORM-AES2\0` authenticated ciphertext format, 12바이트 random nonce, AES-256-GCM, version key derivation을 사용한다.
- AES column이 있는 entity는 `aes_version` setting으로 key version column을 선언한다. 읽기는 그 column을 한 번만 고른다. request가 고른 column이면 그것을, 아니면 숨은 column을 쓰며, 저장된 version으로 설정된 key version에서 key를 선택한다. key가 없거나 ciphertext가 유효하지 않으면 `CONFIG` 또는 `CODEC_DECODE`를 반환하며 이전 version에 current key를 사용하지 않는다.
- bench database는 `scripts/bench-db.sh`가 만든다. `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`의 database를 다시 만들고, `go run ./bench/install`로 `schema/bench.dbs`를 설치하고, `bench/sql/seed.mysql.sql`, `bench/sql/seed.pg.sql`, `bench/sql/seed.sqlite.sql`을 실행한 뒤 `go run ./bench/seedaes`로 인증된 host 형식의 AES와 blind-index 값을 채운다.
- conformance vector의 결과는 세 database에서 같아야 한다. `get_query`는 방언 SQL을 반환한다.

## Schema definitions

이 절은 MySQL, PostgreSQL, SQLite가 스키마 객체를 정의하고 적용하고 catalog에 기록하는 방식을 정리하고, 중립 스키마 언어 dbspec이 각 기능을 지원하는지 결정한다. 기능은 (1) dbspec에 공통 정의가 하나 있고, (2) 그 정의가 MySQL, PostgreSQL, SQLite에서 같은 의미로 생성되며, (3) introspection이 숨은 표식 없이 catalog에서 같은 정의를 복원할 때만 지원한다. Renderer가 setting에서 생성하는 CHECK나 trigger 같은 동작은 catalog 텍스트가 선언한 renderer version의 출력과 같을 때만 복원한다.

모든 사실은 `tests/dialects`의 공통 probe ID(`make dialect-facts-check`)를 인용한다. Probe는 자기 전용 일회용 database, schema, file에서 DDL, DML, catalog 질의를 실행하며 데이터베이스가 다르게 동작하면 실패한다. `render.*` probe는 제안한 rendering을 검사한다. Probe ID가 없는 사실은 공식 manual을 인용한다. 각 행은 **Decision:**으로 끝난다. **T8.1 review**는 이 기록이 결정하지 않는 정의다.

표기: "renderer CHECK"는 renderer가 타입이나 setting을 위해 생성하는 CHECK 제약이다. 정확한 텍스트와 이름은 T8.1에서 정하며, introspection은 catalog 텍스트가 해당 서버의 renderer 출력과 같을 때만 받아들인다.

### Probe environment

| 항목 | 값 |
|---|---|
| MySQL | 8.4.11, `sql_mode`에 `STRICT_TRANS_TABLES` 포함, `lower_case_table_names=1`, `log_bin=1`, `log_bin_trust_function_creators=0`, `explicit_defaults_for_timestamp=1`, 서버 시간대 `SYSTEM`(KST) (`mysql.env.server`) |
| PostgreSQL | 17.11, `TimeZone=Asia/Seoul`, database collation `C`, `max_identifier_length=63` (`postgres.env.server`) |
| SQLite (probe) | `modernc.org/sqlite` v1.58.0의 3.53.4 (`sqlite.env.library`) |
| SQLite, Go client | `modernc.org/sqlite` v1.58.0(`go.mod`), `select sqlite_version()` 결과 3.53.4 |
| SQLite, PHP client | PHP 8.5.10의 `pdo_sqlite`, `select sqlite_version()` 결과 3.53.4 |
| SQLite, TypeScript client | Node 26.8.1의 `node:sqlite`, `select sqlite_version()` 결과 3.53.4. `package.json`은 Node 22.16.0 이상을 허용하며 그 bundled version은 측정하지 않았다 |
| SQLite 파일 이름 | DSN query가 남아 있는 파일 이름은 PHP PDO, `node:sqlite`, `sqlite3` shell이 그대로 열어 `bench.sqlite?_pragma=…`를 만든다. `modernc.org/sqlite`는 query를 해석한다(`TestSQLiteFileNameWithQuery`의 `sqlite.filename.*` case). 클라이언트는 파일 이름을 정하기 전에 query를 제거한다 |
| SQLite, Rust client | sqlx 0.9 `sqlite` feature가 `sqlite-bundled`를 켠다. `libsqlite3-sys` 0.37.0(`packages/orm-rust/Cargo.lock`)은 3.51.3을 포함하며, 같은 crate와 feature로 build한 프로그램의 `sqlite3_libversion()`으로 확인했다. Probe는 3.51.3에서 실행하지 않았다 |

### Types

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| 정수 | `TINYINT`/`SMALLINT`/`MEDIUMINT`/`INT`/`BIGINT`, strict mode에서 범위 검사(1264). `tinyint(1)`을 제외하면 display width를 제거한다 | `smallint`/`integer`/`bigint`만 있으며 범위를 검사한다(22003). `tinyint`/`mediumint`는 없다(42704) | 선언한 이름은 affinity만 정한다. STRICT가 아닌 table은 어떤 값과 범위도 저장한다 | `mysql.int.tinyint_range`, `mysql.int.display_width_dropped`, `postgres.int.smallint_range`, `postgres.int.no_tinyint`, `sqlite.type.affinity_unenforced`, `sqlite.render.integer_check` | **Decision:** `i16`, `i32`, `i64`로 지원한다. MySQL `SMALLINT`/`INT`/`BIGINT`, PostgreSQL `smallint`/`integer`/`bigint`, SQLite `smallint`/`integer`/`bigint`와 renderer CHECK `typeof(c) IN ('integer','null') AND c BETWEEN min AND max`(`i64`는 범위 없음). 8비트·24비트 정수는 PostgreSQL에 해당 타입이 없으므로 지원하지 않는다 | MySQL `COLUMNS.COLUMN_TYPE`, PostgreSQL `pg_attribute.atttypid`/`format_type`, SQLite `pragma_table_info.type`과 `sqlite_master.sql`의 CHECK 텍스트 |
| Unsigned | `UNSIGNED`는 음수를 거부하고 `BIGINT UNSIGNED`는 18446744073709551615까지 저장한다 | 수식어가 없다(42601) | 이름의 일부로 받아들이고 무시한다 | `mysql.int.unsigned_rejects_negative`, `mysql.int.bigint_unsigned_exceeds_signed`, `postgres.int.no_unsigned`, `sqlite.type.affinity_unenforced` | **Decision:** 지원하지 않는다. PostgreSQL과 SQLite에는 부호 없는 64비트 범위를 담는 타입이 없다. 음수 금지 규칙은 명시적인 CHECK 정의다 | MySQL `COLUMN_TYPE`의 ` unsigned` 접미사는 미지원으로 보고한다 |
| Boolean | `BOOLEAN`은 `tinyint(1)`이며 2와 -1을 저장한다 | `boolean`은 정수를 거부한다(42804) | `TRUE`/`FALSE`는 1/0이다. `BOOLEAN`은 NUMERIC affinity이며 어떤 값도 저장한다 | `mysql.bool.alias_tinyint`, `postgres.bool.rejects_integer`, `sqlite.bool.literals`, `mysql.render.bool_check`, `sqlite.render.bool_check` | **Decision:** `bool`로 지원한다. MySQL `tinyint(1)`과 renderer CHECK `b IN (0,1)`, PostgreSQL `boolean`, SQLite `BOOLEAN`과 renderer CHECK `b IN (0,1)`. 필드 이름은 boolean을 선택하지 않는다 | MySQL `COLUMN_TYPE` `tinyint(1)`과 CHECK, PostgreSQL `boolean`, SQLite 타입과 CHECK 텍스트 |
| Decimal | `DECIMAL(p,s)`, p ≤ 65(1426), s ≤ 30(1425). 초과 소수는 0에서 먼 쪽으로 반올림하고 overflow는 실패한다(1264) | `numeric(p,s)`, p ≤ 1000(22023), 음수 scale 허용. 반올림은 같고 overflow는 실패한다(22003) | Decimal 저장이 없다. `DECIMAL(4,2)`는 NUMERIC affinity이며 1.235를 real로 저장한다. `DECIMALINT(p,s)`는 INTEGER affinity다 | `mysql.decimal.scale_rounds`, `mysql.decimal.overflow_rejected`, `mysql.decimal.precision_limits`, `postgres.numeric.scale_rounds`, `postgres.numeric.overflow_rejected`, `postgres.numeric.precision_limits`, `sqlite.type.affinity_from_name`, `sqlite.render.decimal_check` | **Decision:** 1 ≤ p ≤ 18, 0 ≤ s ≤ p인 `decimal(p,s)`로 지원한다. MySQL `DECIMAL(p,s)`, PostgreSQL `numeric(p,s)`, SQLite는 값 × 10^s를 저장하는 `DECIMALINT(p,s)`와 renderer CHECK `typeof(d) IN ('integer','null') AND d BETWEEN -(10^p-1) AND 10^p-1`. 클라이언트가 소수 s자리를 넘는 값을 거부하므로 데이터베이스 반올림은 쓰지 않는다 | MySQL `NUMERIC_PRECISION`/`NUMERIC_SCALE`, PostgreSQL `numeric_precision`/`numeric_scale`, SQLite 선언 타입 텍스트 |
| 부동소수점 | `FLOAT`는 4바이트, `DOUBLE`은 8바이트. NaN과 무한대 값이 없다(1367) | `real` 4바이트, `double precision` 8바이트. NaN과 Infinity를 저장한다 | `REAL`은 8바이트이며 무한대를 저장한다 | `mysql.float.single_precision`, `mysql.float.no_infinity`, `postgres.float.real_single_precision`, `postgres.float.nan_infinity`, `sqlite.float.infinity` | **Decision:** `f64`를 지원한다. MySQL `DOUBLE`, PostgreSQL `double precision`, SQLite `REAL`. 값은 유한하며 클라이언트가 NaN과 무한대를 거부한다. SQLite에 4바이트 float가 없으므로 `f32`는 지원하지 않는다 | MySQL `DATA_TYPE`, PostgreSQL `atttypid`, SQLite 선언 타입 |
| `varchar(n)` | 길이는 문자 수다(1406). 초과한 뒤쪽 공백은 제거한다. utf8mb4 n ≤ 16383(1074) | 길이는 문자 수다(22001). 초과한 뒤쪽 공백은 제거한다. n ≤ 10485760(22023) | 길이를 검사하지 않는다 | `mysql.varchar.length_in_characters`, `mysql.varchar.trailing_spaces_truncated`, `mysql.varchar.max_length`, `postgres.varchar.length_in_characters`, `postgres.varchar.trailing_spaces_truncated`, `postgres.varchar.max_length`, `sqlite.varchar.length_unenforced`, `sqlite.render.varchar_check` | **Decision:** 1 ≤ n ≤ 16383인 `varchar(n)`으로 지원한다. MySQL과 PostgreSQL `varchar(n)`, SQLite `varchar(n)`과 renderer CHECK `length(v) <= n`. 클라이언트는 뒤쪽 공백을 포함해 n자를 넘는 값을 거부하므로 데이터베이스의 공백 제거는 쓰지 않는다 | MySQL `CHARACTER_MAXIMUM_LENGTH`, PostgreSQL `atttypmod`/`character_maximum_length`, SQLite 선언 타입과 CHECK 텍스트 |
| `char(n)` | 읽을 때 뒤쪽 공백을 제거한다 | 공백을 채운 값을 반환한다 | 채우지 않는다 | `mysql.char.trailing_spaces_removed`, `postgres.char.padded` | **Decision:** 지원하지 않는다. MySQL과 PostgreSQL의 저장·반환 값이 다르다 | 미지원으로 보고한다 |
| `text` | `TEXT`는 65535바이트 이하(1406), `LONGTEXT`는 4 GiB 이하. 리터럴 기본값은 `DEFAULT ('x')`가 필요하고(1101) index는 prefix가 필요하다(1170) | 길이 없는 `text`. Probe에서 1 MiB를 저장했다. 필드 한도는 1 GB | `TEXT`, `SQLITE_MAX_LENGTH`(기본 10^9바이트) 한도 | `mysql.text.max_bytes`, `mysql.text.literal_default_needs_expression`, `mysql.text.index_needs_prefix`, `postgres.text.unlimited` | **Decision:** `text`로 지원한다. MySQL `LONGTEXT`, PostgreSQL `text`, SQLite `TEXT`. `text` 컬럼은 key나 index에 포함할 수 없다. 최대 값은 PostgreSQL 1 GB 필드 한도, SQLite `SQLITE_MAX_LENGTH`, MySQL `max_allowed_packet` 중 가장 작은 값이다. Ordered JSON은 codec setting을 가진 `text`다 | MySQL `DATA_TYPE`, PostgreSQL `atttypid`, SQLite 선언 타입 |
| text의 U+0000 | 저장한다 | 거부한다(22021) | 저장하며 `length()`는 그 앞에서 멈춘다 | `mysql.text.nul_preserved`, `postgres.text.nul_rejected`, `sqlite.text.nul_preserved` | **Decision:** U+0000은 중립 text 값이 아니다. 모든 데이터베이스에서 클라이언트가 쓰기 전에 거부한다 | 해당 없음 |
| Bytes | `BINARY(n)`은 0바이트로 채우고 `VARBINARY(n)`은 길이를 검사한다(1406). `LONGBLOB` | `bytea`는 길이가 없다(42601) | `BLOB`은 길이가 없다 | `mysql.binary.zero_padded`, `mysql.varbinary.length_enforced`, `postgres.bytea.no_length` | **Decision:** 길이 없는 `bytes`를 지원한다. MySQL `LONGBLOB`, PostgreSQL `bytea`, SQLite `BLOB`. 채움과 길이는 MySQL에만 있으므로 `binary(n)`과 `varbinary(n)`은 지원하지 않는다 | MySQL `DATA_TYPE`, PostgreSQL `atttypid`, SQLite 선언 타입 |
| UUID | 타입이 없다(1064) | `uuid`는 중괄호와 대문자를 받고 소문자를 반환한다 | 타입이 없다 | `mysql.uuid.no_type`, `postgres.uuid.native_normalized`, `mysql.render.uuid_check`, `sqlite.render.uuid_check` | **Decision:** 소문자 표준 텍스트를 담는 `uuid`로 지원한다. PostgreSQL `uuid`, MySQL `char(36) CHARACTER SET ascii COLLATE ascii_bin`과 renderer CHECK `REGEXP_LIKE(u, '^[0-9a-f]{8}-…$', 'c')`, SQLite `TEXT`와 문자 class 36개의 renderer CHECK `u GLOB`. 클라이언트는 소문자 표준 텍스트를 쓰며 PostgreSQL은 다른 입력 형식도 변환한다 | PostgreSQL `uuid`, MySQL과 SQLite 타입과 CHECK 텍스트 |
| Enum | `ENUM`은 목록 밖의 값을 거부하고(1265), 생략한 NOT NULL 컬럼에 첫 값을 저장하며, 목록 위치로 정렬한다 | `CREATE TYPE … AS ENUM`은 별도 타입 객체(`USER-DEFINED`, `pg_enum`)이며 목록 밖의 값을 거부하고(22P02) 목록 위치로 정렬한다 | `enum('a','b')`는 문법 오류다 | `mysql.enum.rejects_unknown`, `mysql.enum.not_null_first_value_default`, `mysql.enum.sorts_by_position`, `postgres.enum.type_object`, `sqlite.enum.type_name_rejected` | **Decision:** native enum은 지원하지 않는다. 값 목록은 `in` CHECK 정의를 가진 `varchar(n)` 컬럼이며 모든 데이터베이스에서 텍스트로 정렬한다 | MySQL `ENUM` 컬럼과 PostgreSQL enum 타입은 미지원으로 보고한다 |
| JSON | `JSON`은 마지막 중복 키를 남기고 멤버 순서를 바꾼다 | `json`은 텍스트를 유지하고 `jsonb`는 마지막 중복 키를 남기며 순서를 바꾼다 | 텍스트다. `json()`은 중복 키를 유지한다 | `mysql.json.normalizes`, `postgres.json.text_jsonb_normalized`, `sqlite.json.text_kept` | **Decision:** native JSON 타입은 지원하지 않는다. Ordered JSON은 ordered-json codec setting을 가진 `text` 컬럼이다 | MySQL `JSON`, PostgreSQL `json`/`jsonb` 컬럼은 미지원으로 보고한다 |

출처: [MySQL numeric types](https://dev.mysql.com/doc/refman/8.4/en/numeric-types.html), [MySQL string types](https://dev.mysql.com/doc/refman/8.4/en/string-types.html), [MySQL storage requirements](https://dev.mysql.com/doc/refman/8.4/en/storage-requirements.html), [MySQL ENUM](https://dev.mysql.com/doc/refman/8.4/en/enum.html), [MySQL JSON](https://dev.mysql.com/doc/refman/8.4/en/json.html), [PostgreSQL numeric types](https://www.postgresql.org/docs/17/datatype-numeric.html), [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html), [PostgreSQL binary data](https://www.postgresql.org/docs/17/datatype-binary.html), [PostgreSQL UUID](https://www.postgresql.org/docs/17/datatype-uuid.html), [PostgreSQL enum](https://www.postgresql.org/docs/17/datatype-enum.html), [PostgreSQL JSON](https://www.postgresql.org/docs/17/datatype-json.html), [SQLite datatypes](https://www.sqlite.org/datatype3.html), [SQLite STRICT tables](https://www.sqlite.org/stricttables.html), [SQLite limits](https://www.sqlite.org/limits.html).

SQLite STRICT table은 storage class를 검사하지만 타입 이름은 `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, `ANY`만 허용한다(`sqlite.strict.enforces_types`, `sqlite.strict.type_names_limited`). 따라서 STRICT table은 catalog에 `varchar(n)`이나 `DECIMALINT(p,s)`를 유지할 수 없고 길이와 scale을 복원할 수 없다. **Decision:** SQLite table은 STRICT로 만들지 않는다. 선언 타입 이름이 중립 타입을 담고 renderer CHECK가 이를 검사한다.

### Date and time

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| `date` | `DATE`. Strict mode는 `0000-00-00`을 거부한다(1292) | `date`, 기원전 4713년부터 5874897년까지 | 타입이 없으며 어떤 텍스트도 저장한다 | `mysql.date.zero_rejected`, `sqlite.datetime.text_unvalidated`, `sqlite.render.date_check` | **Decision:** 0001-01-01부터 9999-12-31까지의 `date`로 지원한다. MySQL `DATE`, PostgreSQL `date`, SQLite `DATE`와 renderer CHECK `d IS date(d)` | MySQL `DATA_TYPE`, PostgreSQL `atttypid`, SQLite 타입과 CHECK 텍스트 |
| `time` | `TIME`은 -838:59:59부터 838:59:59까지의 interval이다(그 밖은 1292) | `time`은 하루 중 시각이며 24:00:00을 받는다. 25:00:00은 실패한다(22008) | 타입이 없다. `time()`은 `24:00:00`과 `24:00:01`을 그대로 반환한다 | `mysql.time.interval_range`, `postgres.time.day_range`, `sqlite.render.time_check`, `mysql.render.time_of_day_check`, `postgres.render.time_of_day_check` | **Decision:** 24:00:00 미만의 하루 중 시각인 `time(p)`로 지원한다. MySQL `TIME(p)`와 renderer CHECK `v >= '00:00:00' AND v < '24:00:00'`, PostgreSQL `time(p)`와 renderer CHECK `v < '24:00:00'`, SQLite `TIME` 텍스트와 p = 0의 renderer CHECK `v IS time(v) AND v < '24:00:00'`(소수 형식은 T8.1에서 정한다). `postgres.render.time_of_day_check`는 아직 실행하지 않았다 | 타입과 CHECK 텍스트 |
| 소수 초 | 0~6자리(그 이상은 1426). 초과 자릿수는 반올림한다. `(6)` 없는 `DATETIME(6) DEFAULT CURRENT_TIMESTAMP`는 실패한다(1067) | 0~6자리. `timestamp(7)`은 6이 된다. 초과 자릿수는 반올림한다 | 텍스트. `strftime('%f')`는 소수 세 자리이며 `CURRENT_TIMESTAMP`는 소수가 없다 | `mysql.datetime.max_precision`, `mysql.datetime.fraction_rounds`, `mysql.datetime.default_precision_must_match`, `postgres.timestamp.precision_capped`, `postgres.timestamp.fraction_rounds`, `sqlite.datetime.now_is_utc` | **Decision:** precision은 0~6이다. 클라이언트가 선언보다 많은 자릿수를 거부하므로 데이터베이스 반올림은 쓰지 않는다 | MySQL `DATETIME_PRECISION`, PostgreSQL `datetime_precision`, SQLite 타입 텍스트 |
| `DATETIME` / `timestamp` | `DATETIME`은 쓴 wall clock 값을 유지하고 offset이 있는 리터럴을 session 시간대로 변환한다. 0001-01-01부터 9999-12-31까지 받는다. `TIMESTAMP`는 session 시간대와 UTC 사이를 변환하며 UTC 1970-01-01 00:00:01부터 2038-01-19 03:14:07까지만 받는다(1292) | `timestamp`는 리터럴의 offset을 버린다. `timestamptz`는 시점을 저장하고 session 시간대로 표시한다. 0001-01-01, 9999-12-31, `infinity`를 받는다 | 타입이 없으며 텍스트다 | `mysql.datetime.no_conversion`, `mysql.datetime.offset_literal_converted`, `mysql.datetime.range`, `mysql.timestamp.range_2038`, `mysql.timestamp.session_time_zone`, `postgres.timestamp.ignores_offset`, `postgres.timestamptz.session_time_zone`, `postgres.timestamp.range`, `mysql.render.datetime_utc_session`, `postgres.render.timestamp_utc_session`, `sqlite.render.datetime_check` | **Decision:** 0001-01-01부터 9999-12-31까지 시간대 없는 local date-time인 `datetime(p)`로 지원한다. MySQL `DATETIME(p)`, PostgreSQL `timestamp(p)`, SQLite는 소수 p자리의 `YYYY-MM-DD HH:MM:SS` 텍스트 `DATETIME`과 renderer CHECK(길이, `datetime()`, 24 미만의 시, 숫자). 모든 연결은 UTC로 읽고 쓴다. 시간대 정보가 있는 시점(MySQL `TIMESTAMP`, PostgreSQL `timestamptz`)은 지원하지 않는다 | MySQL `DATA_TYPE`, PostgreSQL `atttypid`(`timestamp`와 `timestamptz`), SQLite 타입과 CHECK 텍스트 |
| 현재 시각 | `DATETIME`의 `CURRENT_TIMESTAMP`는 session wall clock이다(`+09:00` 값은 `+00:00`보다 9시간 뒤). `NOW()`는 문장 시작 시각이다 | `now()`는 transaction의 모든 문장에서 transaction 시작 시각이다 | `datetime('now')`와 `CURRENT_TIMESTAMP`는 UTC이며 `'now'`는 한 문장 안에서 같다 | `mysql.current_timestamp.session_time_zone`, `postgres.now.transaction_start`, `sqlite.datetime.now_is_utc` | **Decision:** 시각 기본값은 UTC 문장 시각을 쓴다. UTC 연결 규칙에서 MySQL `CURRENT_TIMESTAMP(p)`와 PostgreSQL `statement_timestamp()`, SQLite는 소수 여섯 자리로 채운 `strftime('%Y-%m-%d %H:%M:%f', 'now')` | 기본값 텍스트(기본값 참조) |

시간대 결정(owner: UTC 연결 규칙을 가진 local date-time):

- **정의.** `datetime(p)`는 시간대 정보가 없는 wall clock date-time이다. 실행 규칙은 모든 연결이 UTC로 읽고 쓰는 것이다. 클라이언트는 각 연결에서 MySQL `time_zone='+00:00'`, PostgreSQL `TimeZone='UTC'`를 설정하고, offset이 있는 값은 bind 전에 UTC로 변환하며, offset 리터럴을 보내지 않는다. SQLite는 클라이언트가 쓴 UTC 텍스트 형식을 저장한다.
- **이유.** 모든 catalog에서 타입을 정확히 복원한다. 0001-01-01부터 9999-12-31까지의 범위를 세 데이터베이스가 받는다(`mysql.datetime.range`, `postgres.timestamp.range`). UTC 규칙에서 시각 함수가 일치한다. MySQL `NOW(6)`는 `UTC_TIMESTAMP(6)`와 같고(`mysql.render.datetime_utc_session`), PostgreSQL `CURRENT_TIMESTAMP`를 `timestamp`로 cast한 값은 `now() AT TIME ZONE 'UTC'`와 같으며(`postgres.render.timestamp_utc_session`), SQLite `'now'`는 UTC다(`sqlite.datetime.now_is_utc`). Offset 리터럴은 MySQL이 변환하고 PostgreSQL이 버리므로(`mysql.datetime.offset_literal_converted`, `postgres.timestamp.ignores_offset`) 클라이언트는 이를 보내지 않는다.
- **결과.** 데이터베이스는 UTC 규칙을 검사하지 않는다. 다른 시간대의 session을 쓰는 ORM 밖의 writer는 오류 없이 다른 wall clock을 저장하며 raw SQL도 같은 규칙을 따라야 한다. 시간대 정보가 있는 시점은 지원하지 않으므로 MySQL `TIMESTAMP`의 1970~2038 한도(`mysql.timestamp.range_2038`)는 적용되지 않는다. 채택하지 않은 선택지는 모든 데이터베이스에서 그 범위로 제한한 시점, 그리고 introspection이 복원할 수 없는 MySQL `DATETIME`과 PostgreSQL `timestamptz` rendering이다.
- **기존 컬럼.** dbspec introspection은 PostgreSQL `timestamptz` 컬럼을 미지원으로 보고하므로, schema를 introspect하기 전에 그 컬럼을 변환한다. `ALTER TABLE … ALTER COLUMN c TYPE timestamp(p) USING c AT TIME ZONE 'UTC'`는 각 시점의 UTC wall clock을 유지한다(`postgres.render.timestamptz_conversion`). MySQL `TIMESTAMP` 컬럼은 `+00:00` session에서 `MODIFY`로 `DATETIME(p)`로 변환한다(`mysql.render.timestamp_conversion`). 호환 mapping은 없다. 남아 있는 `timestamptz`나 `TIMESTAMP` 컬럼은 introspection이 미지원으로 보고한다.

출처: [MySQL date and time types](https://dev.mysql.com/doc/refman/8.4/en/date-and-time-types.html), [MySQL DATETIME and TIMESTAMP](https://dev.mysql.com/doc/refman/8.4/en/datetime.html), [MySQL TIME](https://dev.mysql.com/doc/refman/8.4/en/time.html), [MySQL time zone support](https://dev.mysql.com/doc/refman/8.4/en/time-zone-support.html), [PostgreSQL date/time types](https://www.postgresql.org/docs/17/datatype-datetime.html), [PostgreSQL current date/time](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT), [SQLite date and time functions](https://www.sqlite.org/lang_datefunc.html).

### Null, defaults, identity and generated columns

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| NOT NULL | 기본값 없는 NOT NULL 컬럼을 생략하면 실패한다(1364) | 실패한다(23502) | 실패한다. rowid table의 INTEGER가 아닌 PRIMARY KEY 컬럼은 NOT NULL을 선언하지 않으면 NULL을 받는다 | `mysql.not_null.missing_value_rejected`, `postgres.not_null.missing_value_rejected`, `sqlite.not_null.missing_value_rejected`, `sqlite.pk.nullable_non_integer` | **Decision:** 지원한다. Primary key 컬럼은 모든 데이터베이스에서 `NOT NULL`을 명시해 생성한다 | MySQL `IS_NULLABLE`, PostgreSQL `attnotnull`, SQLite `pragma_table_info.notnull` |
| 리터럴 기본값 | `COLUMN_DEFAULT`는 따옴표 없는 리터럴이다. `TEXT`/`BLOB` 기본값은 `DEFAULT ('x')`가 필요하며 `DEFAULT_GENERATED`와 함께 `_utf8mb4\'x\'`로 기록한다 | `pg_get_expr`는 cast를 추가한다: `'x'::character varying`, `'y'::text` | `dflt_value`는 쓴 텍스트다: `'x'`, `0` | `mysql.default.catalog_text`, `mysql.text.literal_default_needs_expression`, `postgres.default.catalog_text`, `sqlite.default.catalog_text` | **Decision:** 컬럼의 중립 타입 리터럴을 지원한다. Introspection은 dialect별 catalog 형식을 리터럴로 정규화한다. MySQL `text` 리터럴은 식 형식을 쓴다 | MySQL `COLUMN_DEFAULT`와 `EXTRA`, PostgreSQL `pg_attrdef`와 `pg_get_expr`, SQLite `pragma_table_info.dflt_value` |
| 식 기본값 | `DEFAULT (expr)`, 예: `(uuid())`, `DEFAULT_GENERATED`로 기록한다 | 모든 식을 정규화한다: `(1 + 1)`, `now()`, `CURRENT_TIMESTAMP` | 괄호가 있는 `DEFAULT (expr)`만 받는다. 바깥 괄호를 뺀 쓴 텍스트를 유지한다 | `mysql.default.catalog_text`, `postgres.default.catalog_text`, `sqlite.default.catalog_text`, `sqlite.default.expression_needs_parentheses` | **Decision:** 시간 결정에 따른 시각 기본값만 지원한다. UUID 생성기(MySQL `uuid()`, PostgreSQL `gen_random_uuid()`, SQLite 없음)를 포함한 다른 식 기본값은 지원하지 않는다 | 리터럴 기본값과 같다 |
| 자동 key | Key 컬럼의 `AUTO_INCREMENT`(아니면 1075). 명시한 더 큰 key는 counter를 올린다. Rollback한 insert는 간격을 남긴다 | `GENERATED BY DEFAULT AS IDENTITY`는 명시한 key 뒤로 진행하지 않아 다음 생성 key가 충돌한다(23505). `ALWAYS`는 명시한 key를 거부한다(428C9). `serial`은 identity가 아닌 sequence 기본값이다. Rollback은 간격을 남긴다 | `INTEGER PRIMARY KEY AUTOINCREMENT`는 `INTEGER PRIMARY KEY`에만 쓸 수 있다. 명시한 key는 counter를 올린다. Rollback은 간격을 남기지 않는다. `AUTOINCREMENT`가 없으면 삭제한 가장 큰 key를 다시 쓴다 | `mysql.auto_increment.explicit_value_advances`, `mysql.auto_increment.rollback_leaves_gap`, `mysql.auto_increment.requires_key`, `postgres.identity.by_default_not_advanced`, `postgres.identity.always_rejects_explicit`, `postgres.identity.rollback_leaves_gap`, `postgres.serial.sequence_default`, `sqlite.autoincrement.explicit_value_advances`, `sqlite.autoincrement.rollback_no_gap`, `sqlite.rowid.reused_without_autoincrement`, `sqlite.autoincrement.integer_only` | **Decision:** 생략하면 생성하는 단일 컬럼 부호 있는 `i64` primary key로 지원한다. MySQL `BIGINT AUTO_INCREMENT`, PostgreSQL `bigint GENERATED BY DEFAULT AS IDENTITY`, SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`. Key는 다시 쓰지 않는다. 클라이언트는 이 컬럼의 명시 값을 거부하며, PostgreSQL에서 명시 key를 쓰는 apply 단계는 identity sequence를 가장 큰 key로 맞춘다. 간격은 의미에 포함하지 않는다 | MySQL `EXTRA` `auto_increment`, PostgreSQL `attidentity`/`identity_generation`, SQLite `sqlite_master.sql`의 `AUTOINCREMENT`와 `sqlite_sequence` |
| 생성 컬럼 | `VIRTUAL`과 `STORED`. 식을 정규화해 기록한다(예: ``(`a` + 1)``). 명시 값은 실패한다(3105) | 17은 `STORED`만 있다(`VIRTUAL`은 42601). `pg_get_expr`는 `(a + 1)`로 정규화한다. 명시 값은 실패한다(428C9) | `VIRTUAL`과 `STORED`. `pragma_table_xinfo.hidden`은 2 또는 3이며 식은 `sqlite_master.sql`에만 있다 | `mysql.generated.catalog_expression`, `mysql.generated.explicit_value_rejected`, `postgres.generated.stored_only`, `postgres.generated.explicit_value_rejected`, `sqlite.generated.virtual_and_stored`, `sqlite.generated.explicit_value_rejected` | **Decision:** 지원하지 않는다. PostgreSQL 17에는 `VIRTUAL`이 없고, `STORED` 식에는 T8.1이 CHECK에만 정의하는 중립 식 집합과 dialect별 catalog 정규화가 필요하다. 어느 client도 MySQL 생성 컬럼의 식 text를 읽지 않는다. `GENERATION_EXPRESSION`은 non-ASCII literal의 UTF-8 byte를 한 번 더 인코딩한 값(`cafÃ©`)을 담고, 모든 client는 그 text를 쓰기 전에 열을 보고한다. 그래서 dbspec은 생성 컬럼을 만들지 않는다 | 미지원으로 보고한다 |

출처: [MySQL data type defaults](https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html), [MySQL AUTO_INCREMENT](https://dev.mysql.com/doc/refman/8.4/en/example-auto-increment.html), [MySQL generated columns](https://dev.mysql.com/doc/refman/8.4/en/create-table-generated-columns.html), [PostgreSQL CREATE TABLE](https://www.postgresql.org/docs/17/sql-createtable.html), [PostgreSQL generated columns](https://www.postgresql.org/docs/17/ddl-generated-columns.html), [SQLite CREATE TABLE](https://www.sqlite.org/lang_createtable.html), [SQLite AUTOINCREMENT](https://www.sqlite.org/autoinc.html), [SQLite generated columns](https://www.sqlite.org/gencol.html).

### Keys and indexes

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| Primary key | 제약 이름을 버리고 key 이름은 `PRIMARY`다 | 제약 이름을 유지한다 | 이름은 `sqlite_master.sql`에만 있고 index는 `sqlite_autoindex_<table>_1`이다 | `mysql.pk.name_is_primary`, `postgres.pk.name_kept`, `sqlite.pk.name_not_reported` | **Decision:** 이름 없이 지원한다. PostgreSQL은 기본 이름 `<table>_pkey`를 쓰고 SQLite는 제약 이름을 쓰지 않는다 | MySQL `STATISTICS` index `PRIMARY`, PostgreSQL `pg_constraint` `contype='p'`, SQLite `pragma_table_info.pk` |
| Unique key | NULL 여러 개 허용 | `NULLS NOT DISTINCT`가 아니면 NULL 여러 개 허용(23505) | NULL 여러 개 허용 | `mysql.unique.nulls_distinct`, `postgres.unique.nulls_not_distinct_option`, `sqlite.unique.nulls_distinct` | **Decision:** 서로 다른 NULL로 지원한다. `NULLS NOT DISTINCT`는 지원하지 않는다 | MySQL `STATISTICS.NON_UNIQUE=0`, PostgreSQL `pg_index.indisunique`와 `pg_constraint`, SQLite `pragma_index_list.unique`/`origin` |
| Key 순서 | `DESC`를 저장한다(`COLLATION` `D`) | `DESC`를 저장한다(`pg_get_indexdef`) | `DESC`를 저장한다(`pragma_index_xinfo.desc`) | `mysql.index.descending`, `postgres.index.descending_partial_expression`, `sqlite.index.descending` | **Decision:** 컬럼별 오름차순·내림차순을 지원한다. NULLS FIRST/LAST 선택지는 없다 | 표에 적은 대로 |
| Prefix key | `v(10)`을 `SUB_PART`로 기록한다 | 해당 문법이 없다(42883) | 해당 문법이 없다 | `mysql.index.prefix`, `postgres.index.prefix_rejected` | **Decision:** 지원하지 않는다 | MySQL `SUB_PART`는 미지원으로 보고한다 |
| Partial index | 없다(1064) | `WHERE` 조건(`pg_index.indpred`) | `WHERE` 조건(`pragma_index_list.partial`, 텍스트는 `sqlite_master.sql`) | `mysql.index.partial_rejected`, `postgres.index.descending_partial_expression`, `sqlite.index.partial_expression` | **Decision:** 지원하지 않는다 | 미지원으로 보고한다 |
| 식 index | Functional key part: `COLUMN_NAME` NULL, 정규화한 `EXPRESSION` | 식 key(`pg_index.indkey` 0) | 식 key(`pragma_index_info.cid` -2, 이름 NULL) | `mysql.index.functional`, `postgres.index.descending_partial_expression`, `sqlite.index.partial_expression` | **Decision:** 생성 컬럼과 같은 이유로 지원하지 않는다 | 미지원으로 보고한다 |
| Full-text index | `FULLTEXT` index | 해당 index가 없고 `to_tsvector` 식에 대한 GIN을 쓴다 | FTS5 virtual table만 있다 | (manual) | **Decision:** 지원하지 않는다. SQLite에는 table의 full-text index가 없고 PostgreSQL 형식은 식 index다 | 미지원으로 보고한다 |
| Key 길이 | Index key는 3072바이트 이하다. utf8mb4 `varchar(768)`은 받고 `varchar(769)`는 거부한다(1071) | 2704바이트를 넘는 B-tree 항목은 insert에서 실패한다(54000). 4바이트 문자 640개는 들어간다 | 한도가 없다 | `mysql.index.max_key_bytes`, `postgres.index.btree_entry_limit`, `postgres.index.varchar_640_four_byte_fits` | **Decision:** 한 index의 `varchar` 컬럼 선언 길이 합은 640자 이하다. utf8mb4로 2560바이트이며 두 한도 안에 있다. `postgres.index.varchar_640_four_byte_fits`는 아직 실행하지 않았다 | 해당 없음 |
| Index와 unique 이름 | Index 이름은 table 범위이고 64자 이하다(1059). `PRIMARY`는 예약어다(1280) | Index와 unique 제약 이름은 schema 이름공간을 공유한다(42P07) | Index 이름은 database에서 고유하다 | `mysql.index.name_table_scope`, `mysql.index.name_max_length`, `mysql.index.primary_name_reserved`, `postgres.index.name_schema_scope`, `postgres.unique.name_schema_scope`, `sqlite.index.name_database_scope` | **Decision:** 이름은 아래 식별자 규칙을 따르고 index와 unique key 전체에서 schema 안에 고유하다. `primary`는 유효한 이름이 아니다 | MySQL `STATISTICS.INDEX_NAME`, PostgreSQL index의 `pg_class`, SQLite `pragma_index_list.name` |

출처: [MySQL CREATE INDEX](https://dev.mysql.com/doc/refman/8.4/en/create-index.html), [MySQL InnoDB limits](https://dev.mysql.com/doc/refman/8.4/en/innodb-limits.html), [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html), [PostgreSQL partial indexes](https://www.postgresql.org/docs/17/indexes-partial.html), [PostgreSQL unique indexes](https://www.postgresql.org/docs/17/indexes-unique.html), [SQLite CREATE INDEX](https://www.sqlite.org/lang_createindex.html), [SQLite partial indexes](https://www.sqlite.org/partialindex.html), [SQLite expression indexes](https://www.sqlite.org/expridx.html), [SQLite FTS5](https://www.sqlite.org/fts5.html).

### Foreign keys

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| 동작 | `RESTRICT`, `NO ACTION`(둘 다 즉시), `CASCADE`, `SET NULL`. Catalog는 생략한 동작을 `NO ACTION`으로, 쓴 동작은 쓴 대로 기록한다 | 모든 동작. `NO ACTION`은 문장 끝에, `RESTRICT`는 즉시 검사한다 | 모든 동작. `NO ACTION`은 문장 끝에, `RESTRICT`는 즉시 검사한다 | `mysql.fk.rule_catalog` | **Decision:** delete와 update에 `restrict`, `cascade`, `set_null`을 지원하며 명시 keyword `RESTRICT`, `CASCADE`, `SET NULL`로 생성한다. MySQL은 `NO ACTION`을 즉시 검사하므로 `NO ACTION`은 지원하지 않는다 | MySQL `REFERENTIAL_CONSTRAINTS.UPDATE_RULE`/`DELETE_RULE`, PostgreSQL `pg_constraint.confupdtype`/`confdeltype`, SQLite `pragma_foreign_key_list.on_update`/`on_delete` |
| `SET DEFAULT` | 받아서 기록하지만 부모 삭제는 실패한다(1451) | 지원한다 | 지원한다 | `mysql.fk.set_default_acts_as_restrict`, `postgres.fk.set_default` | **Decision:** 지원하지 않는다 | 미지원으로 보고한다 |
| Deferrable | 없다(1064) | `DEFERRABLE INITIALLY DEFERRED`는 COMMIT에서 검사한다(23503) | 같다 | `mysql.fk.deferrable_rejected`, `postgres.fk.deferrable`, `sqlite.fk.deferrable` | **Decision:** 지원하지 않는다. 순환은 nullable 컬럼과 이후 update로 만든다 | 미지원으로 보고한다 |
| `MATCH` | `MATCH FULL`은 `MATCH_OPTION FULL`로 기록하지만 `SHOW CREATE TABLE`에서 빠지며 검사하지 않는다 | `MATCH FULL`은 일부가 NULL인 key를 거부한다(23503) | 받지만 `NONE`으로 기록하고 검사하지 않는다 | `mysql.fk.match_full_not_enforced`, `postgres.fk.match_full`, `sqlite.fk.match_not_enforced` | **Decision:** 기본 `MATCH SIMPLE`만 지원한다 | MySQL `MATCH_OPTION`, PostgreSQL `confmatchtype`, SQLite `pragma_foreign_key_list.match` |
| 검사 스위치 | 항상 켜져 있다 | 항상 켜져 있다 | 각 연결에서 `PRAGMA foreign_keys = ON` 전까지 꺼져 있으며 transaction 안에서는 무시한다 | `sqlite.fk.off_by_default`, `sqlite.fk.pragma_ignored_in_transaction` | **Decision:** 모든 SQLite 연결이 첫 transaction 전에 `foreign_keys`를 켠다는 규칙으로 지원한다(Go DSN pragma, PHP `PRAGMA`, Node `node:sqlite`와 sqlx 기본값이 켠다) | 연결별 `PRAGMA foreign_keys` |
| 자식 index | 제약 이름을 따른 index를 자식 컬럼에 만든다 | 없다 | 없다 | `mysql.fk.child_index_created`, `postgres.fk.no_child_index` | **Decision:** foreign key는 자식 컬럼으로 시작하는 index를 명시적으로 선언해야 한다. 그러면 MySQL은 그 index를 쓰고 새로 만들지 않는다 | Index catalog |
| 컬럼 타입 | 자식과 부모 타입이 같아야 한다(3780) | `integer`가 `bigint`를 참조할 수 있다 | 검사하지 않는다 | `mysql.fk.type_mismatch_rejected`, `postgres.fk.type_mismatch_allowed` | **Decision:** 자식 컬럼 타입은 참조 컬럼 타입과 같다 | 컬럼 catalog |
| 이름 | Database에서 고유하다(1826) | Table 범위다 | `pragma_foreign_key_list`에 없고 `sqlite_master.sql`에 남는다 | `mysql.fk.name_schema_scope`, `sqlite.fk.names_not_reported` | **Decision:** 이름을 가지며 schema 전체에서 고유하다. SQLite introspection은 `CREATE TABLE` 텍스트에서 이름을 읽는다 | MySQL `REFERENTIAL_CONSTRAINTS.CONSTRAINT_NAME`, PostgreSQL `pg_constraint.conname`, SQLite `sqlite_master.sql` |
| Cascade 행의 trigger | Cascade로 바뀐 행에서 trigger가 실행되지 않는다 | 실행된다 | 실행된다 | `mysql.fk.cascade_skips_triggers`, `postgres.fk.cascade_fires_triggers`, `sqlite.fk.cascade_fires_triggers` | Trigger 참조 | 해당 없음 |

출처: [MySQL FOREIGN KEY constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html), [PostgreSQL foreign keys](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK), [SQLite foreign key support](https://www.sqlite.org/foreignkeys.html), [SQLite PRAGMA foreign_keys](https://www.sqlite.org/pragma.html#pragma_foreign_keys).

### CHECK constraints

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| 검사 | 검사한다(3819). NULL은 통과한다. `NOT ENFORCED`는 검사하지 않는 제약을 저장한다 | 검사한다(23514). NULL은 통과한다. `NOT VALID`는 위반 행을 유지한다 | 검사하며 NULL은 통과한다 | `mysql.check.enforced_null_passes`, `mysql.check.not_enforced_option`, `postgres.check.enforced_null_passes`, `postgres.check.not_valid`, `sqlite.check.enforced_null_passes` | **Decision:** 검사하고 검증한 제약을 지원한다. `NOT ENFORCED`와 `NOT VALID`는 지원하지 않는다 | MySQL `TABLE_CONSTRAINTS.ENFORCED`, PostgreSQL `convalidated` |
| 식 텍스트 | `CHECK_CLAUSE`는 정규화한다: ``(`a` in (1,2))``, 문자열 리터럴에 `_utf8mb4` introducer와 두 번의 escape, `NOT`은 부정하는 비교로 바꿔 씀(De Morgan), `BETWEEN`은 유지, 음수 literal은 `-(n)`. bool column 하나는 거부한다(3812) | `pg_get_constraintdef`는 `IN`을 cast가 있는 `= ANY (ARRAY[...])`로, `BETWEEN`을 비교 두 개로, `NOT BETWEEN`을 그 부정으로 바꾸고 `NOT`은 유지한다 | `sqlite_master.sql`에 쓴 그대로만 남는다 | `mysql.check.catalog_text`, `mysql.check.alter_rewrites_introducers`, `mysql.check.alter_writes_time_precision`, `mysql.check.not_pushed_down`, `mysql.check.between_kept`, `mysql.check.string_escaped_twice`, `mysql.check.bool_column_rejected`, `postgres.check.normalized_text`, `postgres.check.between_rewritten`, `postgres.check.not_kept`, `sqlite.check.text_verbatim` | **Decision:** [dbspec](dbspec.md#checks)의 predicate 형식에 지원한다. MySQL이나 PostgreSQL이 바꿔 쓰거나 거부하므로 `not`, `between`, column 하나는 형식에서 뺀다. Renderer가 dialect별 텍스트를 쓰고, introspection은 catalog 텍스트가 생성한 식의 해당 dialect 정규형과 같을 때만 제약을 받아들인다. MySQL 8.4는 non-ASCII literal을 가진 `CHECK_CLAUSE`를 UTF-8 bytes를 한 번 더 인코딩해 쓰므로, introspection은 그런 제약의 본문을 바르게 쓰는 `SHOW CREATE TABLE`에서 읽고 `CHECK_CLAUSE`와 같은 형식으로 escape한다 | MySQL `CHECK_CONSTRAINTS.CHECK_CLAUSE`, PostgreSQL `pg_get_constraintdef`, SQLite `sqlite_master.sql` |
| 비결정 함수 | DDL에서 거부한다(3814) | 허용한다 | 평가할 때 거부한다 | `mysql.check.nondeterministic_rejected`, `postgres.check.nondeterministic_allowed`, `sqlite.check.nondeterministic_rejected` | **Decision:** 중립 식 집합에는 시각, 난수, session 함수가 없다 | 해당 없음 |
| FK 동작 컬럼 | 참조 동작이 있는 foreign key 컬럼은 CHECK에 쓸 수 없다(3823) | 허용한다 | 허용한다 | `mysql.check.fk_action_column_rejected` | **Decision:** dbspec은 `cascade`나 `set_null` foreign key의 컬럼을 쓰는 CHECK를 거부한다 | 해당 없음 |
| 이름 | Database에서 고유하다(3822) | Table 범위다 | 검사하지 않으며 한 table의 두 제약이 같은 이름을 쓸 수 있다 | `mysql.check.name_schema_scope`, `postgres.check.name_table_scope`, `sqlite.constraint.duplicate_names_accepted` | **Decision:** 이름을 가지며 schema 전체에서 고유하다 | 식 텍스트와 같다 |

출처: [MySQL CHECK constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html), [PostgreSQL check constraints](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS), [PostgreSQL catalog information functions](https://www.postgresql.org/docs/17/functions-info.html), [SQLite CREATE TABLE CHECK](https://www.sqlite.org/lang_createtable.html#ckconst), [SQLite deterministic functions](https://www.sqlite.org/deterministic.html).

### Comments, collation and identifiers

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| Comment | `COMMENT` 절: 컬럼은 1024자 이하(1629), table은 2048자 이하(1628) | 실질 한도가 없는 `COMMENT ON`(5000자 저장) | Comment 객체가 없다. SQL 주석은 `CREATE TABLE` 텍스트 안에 남는다 | `mysql.comment.column_limit`, `mysql.comment.table_limit`, `postgres.comment.unlimited`, `sqlite.comment.no_object` | **Decision:** 물리 객체로 지원하지 않는다. SQLite는 ORM 소유 table이나 DDL 텍스트 안에만 comment를 둘 수 있으며 둘 다 표식이다. 설명은 dbspec 문서에 남고 생성하지 않는다 | MySQL과 PostgreSQL comment는 미지원으로 보고한다 |
| Collation | 기본 utf8mb4 collation `utf8mb4_0900_ai_ci`는 unique key에서 `a`, `A`, `á`를 같게 본다(1062). `utf8mb4_bin`은 PAD SPACE다(`a` = `a `). `utf8mb4_0900_bin`은 NO PAD이며 code point 순서다 | 여기서는 database collation `C`: 대소문자·악센트·공백을 구분하고 code point 순서다. 컬럼은 `COLLATE "C"`를 선언할 수 있다 | 기본 `BINARY`: byte 순서. `NOCASE`는 ASCII만 접는다 | `mysql.collation.default_accent_case_insensitive`, `mysql.collation.utf8mb4_bin_pads`, `mysql.collation.utf8mb4_0900_bin_codepoint`, `postgres.collation.c_codepoint`, `sqlite.collation.binary_codepoint`, `sqlite.collation.nocase_ascii_only` | **Decision:** binary code point 순서 collation 하나만 지원한다. MySQL `CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`, PostgreSQL은 database 기본값과 관계없이 모든 text 컬럼에 `COLLATE "C"`, SQLite `BINARY`. 다른 collation은 지원하지 않는다. `postgres.collation.c_codepoint`의 `COLLATE "C"` 컬럼 catalog 확인은 아직 실행하지 않았다 | MySQL `COLUMNS.COLLATION_NAME`, PostgreSQL `pg_attribute.attcollation`, SQLite `sqlite_master.sql`의 `COLLATE` |
| 식별자 길이 | 64자 이하(1059) | 더 긴 이름은 notice와 함께 63바이트로 잘리며 63바이트까지 같은 이름은 충돌한다(42P07) | 한도가 없다 | `mysql.ident.max_length`, `mysql.index.name_max_length`, `postgres.ident.truncated_to_63`, `sqlite.ident.no_length_limit` | **Decision:** 이름은 `[a-z][a-z0-9_]*`이며 63바이트 이하다. 더 긴 이름은 줄이거나 바꾸지 않고 거부한다 | 저장한 이름 |
| 식별자 대소문자 | 컬럼 이름은 대소문자를 구분하지 않는다(1060). Table 이름은 `lower_case_table_names`를 따른다(`make test-servers`가 선언한 두 platform의 test 서버는 1: `Foo`는 `foo`로 저장되고 `Foo`와 `foo`가 충돌, 1050) | 따옴표 없는 이름은 소문자로 접는다(42701). 따옴표 있는 이름은 대소문자를 구분한다 | 대소문자를 구분하지 않는다 | `mysql.ident.column_case_insensitive`, `mysql.ident.table_case_server_setting`, `postgres.ident.case_folding`, `sqlite.ident.case_insensitive` | **Decision:** 소문자 이름만 쓰므로 모든 접기 규칙에서 같은 이름이 된다 | 저장한 이름 |
| 이름 범위 | Index: table. CHECK, FK, trigger: database | Index, unique 제약: schema. CHECK, FK, trigger: table | Index, trigger: database. 제약: 검사하지 않음 | `mysql.index.name_table_scope`, `mysql.check.name_schema_scope`, `mysql.fk.name_schema_scope`, `mysql.trigger.name_schema_scope`, `postgres.index.name_schema_scope`, `postgres.check.name_table_scope`, `postgres.trigger.name_table_scope`, `sqlite.index.name_database_scope`, `sqlite.trigger.name_database_scope` | **Decision:** 모든 index, 제약, trigger 이름은 schema 전체에서 고유하다 | 해당 없음 |
| 이름공간 | Schema는 database다 | Database 안의 schema이며 table 이름은 schema마다 고유하다 | 한정 이름은 연결의 attach한 database를 참조한다 | `postgres.namespace.relname_per_schema`, `sqlite.namespace.attached_databases` | **Decision:** schema 한정 이름은 지원하지 않는다. dbspec 문서 하나는 연결의 현재 database나 schema다 | MySQL `DATABASE()`, PostgreSQL `current_schema()`, SQLite `main` |

출처: [MySQL CREATE TABLE](https://dev.mysql.com/doc/refman/8.4/en/create-table.html), [MySQL collations](https://dev.mysql.com/doc/refman/8.4/en/charset-collation-names.html), [MySQL pad attribute](https://dev.mysql.com/doc/refman/8.4/en/charset-binary-collations.html), [MySQL identifier length](https://dev.mysql.com/doc/refman/8.4/en/identifier-length.html), [MySQL identifier case](https://dev.mysql.com/doc/refman/8.4/en/identifier-case-sensitivity.html), [PostgreSQL COMMENT](https://www.postgresql.org/docs/17/sql-comment.html), [PostgreSQL collation](https://www.postgresql.org/docs/17/collation.html), [PostgreSQL identifiers](https://www.postgresql.org/docs/17/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS), [SQLite collating sequences](https://www.sqlite.org/datatype3.html#collation), [SQLite ATTACH](https://www.sqlite.org/lang_attach.html).

### Update-time stamping

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| 컬럼 절 | `ON UPDATE CURRENT_TIMESTAMP`는 다른 컬럼이 바뀌면 실행되고, 값이 바뀌지 않으면 실행되지 않으며, 명시 값이 우선한다 | 해당 절이 없다(42601) | 해당 절이 없다 | `mysql.on_update.fires_on_change`, `mysql.on_update.skipped_when_unchanged`, `mysql.on_update.explicit_value_kept`, `postgres.on_update.unsupported`, `sqlite.on_update.unsupported` | **Decision:** 컬럼 절은 MySQL에만 있으므로 지원하지 않는다 | MySQL `EXTRA` `on update …`는 미지원으로 보고한다 |
| Trigger | `BEFORE UPDATE` row trigger는 `NEW`에 대입할 수 있고 값이 바뀌지 않아도 실행된다 | 함수를 쓰는 `BEFORE UPDATE` row trigger는 `NEW`에 대입할 수 있고 값이 바뀌지 않아도 실행된다 | `NEW`에 대입할 수 없다. `AFTER UPDATE` trigger가 별도 `UPDATE`를 실행하며 값이 바뀌지 않아도 실행된다 | `mysql.trigger.new_assignable`, `mysql.trigger.update_fires_when_unchanged`, `postgres.trigger.update_fires_when_unchanged`, `sqlite.trigger.new_read_only` | **Decision:** 기록용 trigger를 생성하지 않는다. 아래 참조 | 해당 없음 |

수정 시각 기록 결정(owner: 실행기 기록):

- **정의.** 수정 시각 기록은 table 컬럼의 ORM mapping setting이다. 실행기는 계획하는 모든 `UPDATE`에서 UTC 문장 시각으로 컬럼을 명시적으로 대입한다. Trigger, `ON UPDATE` 절, 기본값 변경 같은 물리 객체는 만들지 않는다. 이 setting은 `schemaHash`가 아니라 `manifestHash`에 속하며 introspection은 이를 읽거나 만들지 않는다.
- **이유.** 실행기는 세 데이터베이스에서 같은 값을 쓰고, 컬럼 정의는 introspection이 정확히 복원하는 일반 `datetime(p)`로 남는다. MySQL `ON UPDATE CURRENT_TIMESTAMP`는 MySQL에만 있고 값을 바꾸지 않는 update를 건너뛰므로(`mysql.on_update.skipped_when_unchanged`) 실행기와 다르며 계속 지원하지 않는다.
- **결과.** Raw SQL과 ORM 밖의 writer는 컬럼을 기록하지 않는다. Trigger 기록은 채택하지 않았다. MySQL `SUPER`나 `log_bin_trust_function_creators=ON`(`mysql.trigger.binlog_privilege_1419`), PostgreSQL 함수 객체, SQLite의 행마다 추가 쓰기(`sqlite.trigger.new_read_only`)가 필요하다.

### Triggers and audit context

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| 수준과 event | Row trigger만 있다(`FOR EACH STATEMENT`는 1064). `INSERT`/`UPDATE`/`DELETE` | Row와 statement trigger, `TRUNCATE`도 있다 | Row trigger만 있다 | `mysql.trigger.no_statement_level`, `postgres.trigger.statement_fires_on_zero_rows`, `sqlite.trigger.no_statement_level` | **Decision:** 생성하는 trigger는 `INSERT`, `UPDATE`, `DELETE`의 row trigger다 | MySQL `TRIGGERS.ACTION_TIMING`/`EVENT_MANIPULATION`/`ACTION_ORIENTATION`, PostgreSQL `pg_trigger.tgtype`, SQLite `sqlite_master.sql` |
| 0행 문장 | 실행되지 않는다 | Statement trigger는 일치하는 행이 없는 `UPDATE`에도 실행된다(P0001). Row trigger는 실행되지 않는다 | 실행되지 않는다 | `mysql.trigger.zero_rows_not_fired`, `postgres.trigger.statement_fires_on_zero_rows`, `postgres.trigger.row_skips_zero_rows`, `sqlite.trigger.zero_rows_not_fired` | **Decision:** row trigger만 쓰므로 일치하는 행이 없는 문장은 실패하지 않는다 | 해당 없음 |
| `TRUNCATE` | Trigger event가 없다(1064). `TRUNCATE TABLE`은 `DELETE` trigger를 건너뛴다 | `BEFORE TRUNCATE` statement trigger가 실행된다 | `TRUNCATE`가 없다. `WHERE` 없는 `DELETE`는 row trigger를 실행한다 | `mysql.trigger.no_truncate_event`, `mysql.trigger.truncate_skips_delete_trigger`, `postgres.trigger.truncate_event`, `sqlite.trigger.delete_all_fires_row_triggers` | **Decision:** 생성하는 trigger는 어느 데이터베이스에서도 `TRUNCATE`를 다루지 않는다. `immutable`과 `audit`은 행 `UPDATE`와 `DELETE`만 보장하며 `TRUNCATE`는 보장 밖의 권한 작업이다 | 해당 없음 |
| Cascade 행 | Foreign key 동작으로 바뀐 행에서 trigger가 실행되지 않는다 | 실행된다 | 실행된다 | `mysql.fk.cascade_skips_triggers`, `postgres.fk.cascade_fires_triggers`, `sqlite.fk.cascade_fires_triggers` | **Decision:** `cascade`나 `set_null` foreign key의 자식 table에는 `audit`과 `immutable` setting을 거부한다. 따라서 모든 데이터베이스가 같은 행 변경을 관찰한다 | 해당 없음 |
| 권한 | Binary logging과 `log_bin_trust_function_creators=0`에서 `SUPER`가 없는 login은 trigger를 만들 수 없다(1419) | Table의 `TRIGGER` 권한과 함수의 `EXECUTE` 권한 | 권한이 없다 | `mysql.trigger.binlog_privilege_1419` | **Decision:** apply는 첫 trigger 문장 전에 권한을 확인하고 필요한 설정과 함께 실패한다 | MySQL `@@log_bin`, `@@log_bin_trust_function_creators` |
| Trigger 본문 객체 | 본문이 trigger 안에 있다 | 본문은 `pg_proc`의 별도 함수이며 `DROP TABLE` 후에도 남는다 | 본문이 trigger 안에 있다. `DROP TABLE`은 trigger도 삭제한다 | `postgres.trigger.function_separate_object`, `sqlite.trigger.dropped_with_table` | **Decision:** renderer는 생성하는 PostgreSQL trigger마다 함수 하나를 소유한다. Diff와 apply는 trigger와 함께 함수를 만들고 삭제한다 | PostgreSQL `pg_proc` |
| `NEW` 대입 | `BEFORE` trigger에서 허용 | `BEFORE` row trigger에서 허용 | 허용하지 않는다 | `mysql.trigger.new_assignable`, `postgres.trigger.update_fires_when_unchanged`, `sqlite.trigger.new_read_only` | 수정 시각 기록을 위한 사실 | 해당 없음 |
| Catalog 텍스트 | `ACTION_STATEMENT`는 주석을 포함해 쓴 그대로의 본문이다 | `prosrc`는 쓴 그대로의 함수 본문이다. `pg_get_triggerdef`는 schema로 한정한 table을 포함한 정규화 텍스트를 반환한다 | `sqlite_master.sql`은 쓴 그대로의 `CREATE TRIGGER` 텍스트다 | `mysql.trigger.body_catalog_verbatim`, `postgres.trigger.catalog_text`, `sqlite.trigger.catalog_verbatim` | **Decision:** 생성한 trigger는 catalog 텍스트가 선언한 renderer version의 출력과 같을 때만 복원한다. MySQL은 timing, event, 본문, PostgreSQL은 `pg_get_triggerdef`와 `prosrc`, SQLite는 전체 텍스트다. 주석 표식은 쓰지 않는다 | 표에 적은 대로 |
| 이름 | Database에서 고유하다(1359) | Table 범위다 | Database에서 고유하다 | `mysql.trigger.name_schema_scope`, `postgres.trigger.name_table_scope`, `sqlite.trigger.name_database_scope` | **Decision:** 생성 이름은 schema에서 고유하고 63바이트 이하다. 생성 이름이 이를 넘는 table은 거부한다 | 표에 적은 대로 |

Audit context 선택지. Audit trigger는 클라이언트가 transaction 안에서 설정한 작업 단위의 audit을 읽는다.

- **PostgreSQL** `set_config('<setting>', id, true)`는 transaction 범위다. `COMMIT` 뒤 같은 session에서는 빈 문자열, 설정한 적 없는 session에서는 NULL을 읽는다(`postgres.context.set_config_local`).
- **MySQL** user variable은 session 범위이며 `COMMIT` 뒤에도 남는다(`mysql.context.user_variable_session_scope`). Pool 연결은 클라이언트가 지우지 않으면 값을 유지한다.
- **SQLite**에는 session 변수가 없다. Main table의 trigger는 `TEMP` table을 읽도록 만들 수 있지만 실행할 때 실패한다(`sqlite.context.temp_table_not_visible`). Main table의 행은 `COMMIT` 뒤 모든 연결에 보인다(`sqlite.context.main_table_shared`).

선택지는 (1) 클라이언트가 transaction 안에서 id를 설정하고 MySQL과 SQLite에서는 transaction 끝에서 지운다는 규칙을 가진 위 데이터베이스별 방식, (2) 실행기가 audit 대상 행마다 쓰는 audit 컬럼이며 table 정의가 바뀐다.

**판정:** 두 전달 방식 모두 쓰지 않는다. 감사 대상 row가 audit 기록의 key를 담는 자기 audit column을 갖는다. transaction이 audit 기록을 삽입하고 executor가 모든 `INSERT`와 `UPDATE`에서 그 column을 쓰므로, 모든 database에서 row trigger는 바꾸는 audit 기록을 `NEW`에서, 이전 audit 기록을 `OLD`에서 읽는다. 생성된 trigger는 row를 JSON으로 만들지 않고 column 대 column으로 이력 table에 복사한다. physical `DELETE`의 `OLD`는 지우는 audit 기록이 아니라 이전 audit 기록이므로, 감사 대상 table은 soft delete column으로만 지운다. session 변수, transaction setting, `orm__context` table은 쓰지 않는다. 정의는 [dbspec](dbspec.md#audit)에 있다.

출처: [MySQL trigger syntax](https://dev.mysql.com/doc/refman/8.4/en/trigger-syntax.html), [MySQL stored program binary logging](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html), [MySQL FOREIGN KEY and triggers](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html), [MySQL user variables](https://dev.mysql.com/doc/refman/8.4/en/user-variables.html), [PostgreSQL CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html), [PostgreSQL trigger functions](https://www.postgresql.org/docs/17/plpgsql-trigger.html), [PostgreSQL set_config](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET), [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html), [SQLite DELETE](https://www.sqlite.org/lang_delete.html).

### DDL transactions, views and sequences

| 기능 | MySQL 8.4 | PostgreSQL 17 | SQLite | Probe | 결정과 중립 rendering | Introspection |
|---|---|---|---|---|---|---|
| Transaction 안의 DDL | DDL은 열린 transaction을 commit한다. 문장 하나는 원자적이다(실패한 `DROP TABLE a, missing`은 아무것도 삭제하지 않는다, 1051) | DDL은 transaction에 포함된다. `CREATE INDEX CONCURRENTLY`는 transaction 안에서 실행할 수 없다(25001) | DDL은 transaction에 포함된다. `ALTER TABLE`은 컬럼을 바꿀 수 없고 `ADD COLUMN`은 상수가 아닌 기본값을 거부한다 | `mysql.ddl.implicit_commit`, `mysql.ddl.atomic_statement`, `postgres.ddl.transactional`, `postgres.ddl.concurrent_index_outside_transaction`, `sqlite.ddl.transactional`, `sqlite.alter.limited` | **Decision:** transaction DDL에 의존하는 기능은 없다. Apply는 문장마다 journal을 쓰고 SQLite 컬럼 변경은 table을 다시 만든다 | 해당 없음 |
| View | `VIEW_DEFINITION`은 database로 한정한 이름과 alias로 다시 쓴다 | `pg_get_viewdef`는 정규화 텍스트를 반환한다 | `sqlite_master.sql`은 쓴 그대로 유지한다 | `mysql.view.definition_rewritten`, `postgres.view.definition_normalized`, `sqlite.view.text_verbatim` | **Decision:** 지원하지 않는다. View 본문은 중립 형식이 없는 dialect 질의다 | 미지원으로 보고한다 |
| Sequence | 없다(1064) | `CREATE SEQUENCE` | 없다 | `mysql.sequence.unsupported`, `postgres.sequence.object`, `sqlite.sequence.unsupported` | **Decision:** 지원하지 않는다. 자동 key가 유일한 생성 번호다 | 미지원으로 보고한다 |
| 기타 객체 | Partition, event, procedure, engine | 함수, 타입, extension, partition | Virtual table, `WITHOUT ROWID` | (manual) | **Decision:** renderer가 trigger용으로 소유하는 함수를 제외하고 지원하지 않는다 | 미지원으로 보고한다 |

출처: [MySQL implicit commit](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html), [MySQL atomic DDL](https://dev.mysql.com/doc/refman/8.4/en/atomic-ddl.html), [PostgreSQL CREATE INDEX CONCURRENTLY](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY), [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html), [MySQL CREATE VIEW](https://dev.mysql.com/doc/refman/8.4/en/create-view.html), [PostgreSQL CREATE SEQUENCE](https://www.postgresql.org/docs/17/sql-createsequence.html).

### Catalog sources

| 객체 | MySQL 8.4 | PostgreSQL 17 | SQLite |
|---|---|---|---|
| Table | `information_schema.TABLES`(`TABLE_TYPE='BASE TABLE'`, `TABLE_COLLATION`, `TABLE_COMMENT`) | `relnamespace`로 `pg_namespace`와 join한 `pg_class`(`relkind='r'`) | `sqlite_master`(`type='table'`) |
| 컬럼 | `information_schema.COLUMNS`(`COLUMN_TYPE`, `IS_NULLABLE`, `COLUMN_DEFAULT`, `EXTRA`, `GENERATION_EXPRESSION`, `COLLATION_NAME`) | `pg_attribute`, `format_type`, `pg_get_expr`를 통한 `pg_attrdef`, `attidentity`, `attgenerated`, `attcollation` | `pragma_table_xinfo`와 `AUTOINCREMENT`, `COLLATE`, 제약 이름을 위한 `sqlite_master.sql` |
| Primary·unique key, index | `information_schema.STATISTICS`(`INDEX_NAME`, `NON_UNIQUE`, `SEQ_IN_INDEX`, `COLLATION`, `SUB_PART`, `EXPRESSION`), `TABLE_CONSTRAINTS` | `pg_index`(`indkey`, `indoption`, `indpred`), `pg_get_indexdef`, `pg_constraint` | `pragma_index_list`, `pragma_index_xinfo`, `sqlite_master.sql` |
| Foreign key | `REFERENTIAL_CONSTRAINTS`, `KEY_COLUMN_USAGE` | `pg_constraint`(`contype='f'`, `conkey`, `confkey`, `confupdtype`, `confdeltype`, `confmatchtype`, `condeferrable`) | `pragma_foreign_key_list`, 이름을 위한 `sqlite_master.sql` |
| CHECK | `CHECK_CONSTRAINTS.CHECK_CLAUSE`, `TABLE_CONSTRAINTS.ENFORCED` | `pg_constraint`(`contype='c'`), `pg_get_constraintdef`, `convalidated` | `sqlite_master.sql` |
| Trigger | `information_schema.TRIGGERS`(`ACTION_TIMING`, `EVENT_MANIPULATION`, `ACTION_ORIENTATION`, `ACTION_STATEMENT`) | `pg_trigger`(`tgtype`, `tgfoid`), `pg_get_triggerdef`, `pg_proc.prosrc` | `sqlite_master`(`type='trigger'`) |
| Comment | `COLUMNS.COLUMN_COMMENT`, `TABLES.TABLE_COMMENT` | `pg_description`(`col_description`, `obj_description`) | 없음 |
| Sequence와 counter | `TABLES.AUTO_INCREMENT` | `pg_sequences`, `pg_get_serial_sequence` | `sqlite_sequence` |

## Rendered statements

renderer는 dbspec 문서 집합을 한 dialect의 statement로 바꾼다. 잘못된 집합은 대신 그 diagnostic을 돌려준다([manifest와 hash](dbspec.md#manifest-and-hashes)). `tests/dbspec/ddl.json`이 렌더링되는 모든 형식의 정확한 statement를 나열하며 규범 text다. 이 절은 그 뒤의 규칙을 정한다. 그 파일의 모든 vector는 `make dbspec-ddl-check`가 MySQL 8.4, PostgreSQL 17, SQLite에 적용한다.

### Statement와 순서

- 문서는 `use` 순서로 렌더링한다(쓰이는 문서가 쓰는 문서보다 먼저, 같으면 문서 이름 순). 한 문서의 table은 문서 순서다. 쓰이는 table은 자기 문서가 한 번만 렌더링한다.
- 모든 identifier는 따옴표로 감싼다: MySQL은 backtick, PostgreSQL과 SQLite는 큰따옴표. keyword는 대문자이고 statement마다 끝 semicolon 없는 한 줄이다.
- table마다 `CREATE TABLE` 하나. SQLite는 이어서 unique key마다 `CREATE UNIQUE INDEX` 하나. 그다음 index마다 이름 순으로 `CREATE INDEX` 하나.
- 모든 table 뒤에 MySQL과 PostgreSQL은 foreign key마다 `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` 하나를 table 순서와 key 이름 순으로 쓴다. SQLite는 foreign key를 `CREATE TABLE` 안에 쓰며, 뒤에 오는 table도 참조할 수 있다.
- 마지막으로 `immutable`과 `audit`의 trigger를 table 순서로 쓴다. PostgreSQL trigger는 자신이 실행하는 `CREATE FUNCTION` 뒤에 온다.

### `CREATE TABLE` 안

부분의 순서: 선언 순서의 column, primary key, MySQL과 PostgreSQL은 이름 순의 이름 있는 `UNIQUE` constraint로 쓴 unique key, SQLite는 이름 순의 foreign key, column 순서의 renderer CHECK, 이름 순의 선언된 check. MySQL statement의 끝에는 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`을 붙인다.

column은 이름, type, `NOT NULL`이나 `NULL`, 그다음 default 순으로 쓴다.

| dbspec | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `i16`, `i32`, `i64` | `SMALLINT`, `INT`, `BIGINT` | `smallint`, `integer`, `bigint` | `smallint`, `integer`, `bigint` |
| `bool` | `tinyint(1)` | `boolean` | `BOOLEAN` |
| `decimal(p,s)` | `DECIMAL(p,s)` | `numeric(p,s)` | `DECIMALINT(p,s)` |
| `f64` | `DOUBLE` | `double precision` | `REAL` |
| `varchar(n)` | `varchar(n) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` | `varchar(n) COLLATE "C"` | `varchar(n)` |
| `text` | `LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` | `text COLLATE "C"` | `TEXT` |
| `bytes` | `LONGBLOB` | `bytea` | `BLOB` |
| `uuid` | `char(36) CHARACTER SET ascii COLLATE ascii_bin` | `uuid` | `TEXT` |
| `date` | `DATE` | `date` | `DATE` |
| `time(p)` | `TIME(p)` | `time(p)` | `TIME` |
| `datetime(p)` | `DATETIME(p)` | `timestamp(p)` | `DATETIME` |

- **Identity.** MySQL은 `BIGINT NOT NULL AUTO_INCREMENT`와 table 수준 `PRIMARY KEY`, PostgreSQL은 `bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL`과 table 수준 `PRIMARY KEY`, SQLite는 column에 `INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT`를 쓰고 table 수준 primary key는 없다.
- **Default.** literal default는 literal의 dialect 형식(아래)으로 쓴다. `default now`는 MySQL `CURRENT_TIMESTAMP(p)`, PostgreSQL `statement_timestamp()`, SQLite는 소수 자릿수가 정확히 p인 UTC text다. p = 0이면 `strftime('%Y-%m-%d %H:%M:%S', 'now')`, p ≤ 3이면 `substr(strftime('%Y-%m-%d %H:%M:%f', 'now'), 1, 20 + p)`, p > 3이면 0을 p − 3개 붙인 `(strftime('%Y-%m-%d %H:%M:%f', 'now') || '0…')`이며 모두 괄호로 감싼다.
- **Literal.** 정수, `f64`, 문자열은 문서대로 쓴다. MySQL은 backslash를 escape로 읽으므로 MySQL 문자열은 모든 backslash를 두 번 쓴다. `true`와 `false`는 MySQL과 SQLite에서 `1`과 `0`, PostgreSQL에서 `TRUE`와 `FALSE`다. SQLite decimal literal은 정수 값 × 10^s다. `decimal(13,2)`의 `7.50`은 `750`이다.
- **Key.** `PRIMARY KEY (…)`는 key column을 나열한다. PostgreSQL은 기본 이름 `<table>_pkey`를 유지한다. unique key는 MySQL과 PostgreSQL에서 `CONSTRAINT <name> UNIQUE (…)`, SQLite에서 `CREATE UNIQUE INDEX <name> ON <table> (…)`이며, 그래서 SQLite catalog가 그 이름을 보고한다. 내림차순 index column 뒤에는 `DESC`를 쓴다.
- **Foreign key.** `RESTRICT`, `CASCADE`, `SET NULL`로 `CONSTRAINT <name> FOREIGN KEY (…) REFERENCES <table> (…) ON DELETE <action> ON UPDATE <action>`이다.
- **Check.** 선언된 check는 `CONSTRAINT <name> CHECK (<predicate>)`다. column 이름은 따옴표로 감싸고, `and`, `or`, `not`, `in`, `between`, `is null`, `is not null`은 대문자, literal은 dialect 형식, 괄호는 적힌 대로 쓴다.

### Renderer CHECK

renderer CHECK는 dialect가 강제하지 않는 type을 강제한다. 이름은 `<table>$<column>`이다. dbspec 이름에는 `$`가 없으므로 선언된 이름과 겹치지 않는다. column마다 CHECK 하나가 column type의 모든 조건을 담는다.

| dbspec | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `i16`, `i32` | | | `typeof(c) IN ('integer', 'null') AND c BETWEEN <min> AND <max>` |
| `i64`(identity 아님) | | | `typeof(c) IN ('integer', 'null')` |
| `bool` | `c IN (0, 1)` | | `c IN (0, 1)` |
| `decimal(p,s)` | | | `typeof(c) IN ('integer', 'null') AND c BETWEEN -(10^p − 1) AND 10^p − 1` |
| `f64` | | | `typeof(c) IN ('real', 'null')` |
| `varchar(n)` | | | `length(c) <= n` |
| `uuid` | `REGEXP_LIKE(c, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')` | | `c GLOB` 문자 class 36개 |
| `date` | | | `c IS date(c)` |
| `time(0)` | `c >= '00:00:00' AND c < '24:00:00'` | `c < '24:00:00'` | `c IS time(c) AND c < '24:00:00'` |
| `time(p)`, p > 0 | `time(0)`과 같음 | `time(0)`과 같음 | `length(c) = 9 + p AND substr(c, 1, 8) IS time(substr(c, 1, 8)) AND substr(c, 1, 8) < '24:00:00' AND substr(c, 9, 1) = '.' AND substr(c, 10) GLOB` 숫자 class p개 |
| `datetime(0)` | | | `length(c) = 19 AND c IS datetime(c) AND substr(c, 12, 2) < '24'` |
| `datetime(p)`, p > 0 | | | `length(c) = 20 + p AND substr(c, 1, 19) IS datetime(substr(c, 1, 19)) AND substr(c, 12, 2) < '24' AND substr(c, 20, 1) = '.' AND substr(c, 21) GLOB` 숫자 class p개 |

SQLite `f64` CHECK는 위 schema definitions에 probe가 없다. REAL column은 정수와 숫자 text를 real 값으로 바꾸고 다른 text는 그대로 두는데, 이 CHECK가 그것을 거부한다(`sqlite.ddl.types_and_defaults`). PostgreSQL은 `timestamp` 입력의 24시를 다음 날 자정으로 읽으므로 `'2026-01-01 24:00:00'`은 유효한 date-time인 `2026-01-02 00:00:00`으로 저장된다. MySQL은 그 입력을 거부하고(1292) SQLite는 renderer CHECK가 거부한다. 저장되는 값의 집합이 같으므로 PostgreSQL CHECK는 없다(`postgres.ddl.types_and_defaults`). client는 24시를 보내지 않는다.

### Trigger

생성 trigger 이름은 `<table>$<event>`이다: `immutable_update`, `immutable_delete`, `audit_insert`, `audit_update`, `audit_delete`. PostgreSQL trigger는 renderer가 소유한 같은 이름의 function을 실행한다. 거부는 `table <table> is immutable`이나 `table <table> deletes through its soft delete column` message를 일으킨다: MySQL `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '…'`, PostgreSQL `RAISE EXCEPTION '…'`, SQLite `SELECT RAISE(ABORT, '…')`.

- `immutable`: 거부하는 `BEFORE UPDATE`와 `BEFORE DELETE` row trigger.
- `audit`: `AFTER INSERT` row trigger는 이력 table에 action `'insert'`, NULL 이전 audit 기록, 기록하는 모든 column의 `NEW` 값을 넣는다. `AFTER UPDATE` row trigger는 `'update'`, `OLD.<audit column>`, 기록하는 모든 column의 `NEW` 값을 넣는다. `BEFORE DELETE` row trigger는 거부한다. insert는 action, previous, 기록하는 column 순으로, 기록하는 column은 table의 column 순서로 적고 이력 key는 identity에 맡긴다([audit](dbspec.md#audit)).
- MySQL trigger 본문은 statement 하나다. PostgreSQL function 본문은 `LANGUAGE plpgsql`의 `BEGIN … RETURN NULL; END`다(`BEFORE` 거부는 반환하지 않는다). SQLite 본문은 `BEGIN …; END`다.

## Introspection

introspection은 connection의 현재 database(MySQL), 현재 schema(PostgreSQL), `main` database(SQLite)를 읽어 호출자가 이름을 준 dbspec 문서 하나와 읽지 못한 객체 목록을 돌려준다. 모든 query가 table 전체를 한 번에 읽으므로 query 수는 table 수와 무관하다. `make dbspec-introspect-check`는 `tests/dbspec/ddl.json`의 모든 vector와 모든 schema 문서를 렌더링해 적용하고 database를 introspect한 뒤, 결과의 schema text가 table을 이름 순으로 둔 원본의 schema text와 같고 미지원 객체가 없기를 요구한다. 또 `tests/dbspec/introspect.json`을 실행한다. 각 case는 그 dialect의 빈 database에 문서를 렌더링하고 statement를 실행한 뒤(statement의 `{schema}`는 그 database 또는 schema의 이름 문자열로 치환하며, PostgreSQL case는 함께 지우는 두 번째 schema `{schema}_b`를 만들 수 있다), introspect한 문서의 canonical form과 미지원 객체 `[kind, table, name]`를 기대한다. 이유는 비교하지 않는다. `make dbspec-introspect-<client>-check`는 같은 round trip과 case를 PHP, TypeScript, Rust client로 실행한다. `make dbspec-introspect-compare-check`는 stress 모양의 20 table 문서(`make bench`의 `make dbspec-introspect-compare-bench`는 2000 table stress 문서와 release Rust runner)를 각 dialect에 적용하고 `tests/dbspec/introspect`의 runner 네 개를 실행해, 출력(canonical 문서, 그다음 미지원 객체마다 `! kind<TAB>table<TAB>name` 줄)이 같고, 원본 schema text를 가지며, 미지원 객체가 없기를 요구한다. 각 introspection의 시간을 출력하고 그것이 기준값 5초를 넘으면 경고하며, 시간은 검사를 실패시키지 않는다.

### 문서

- table은 이름 순, column은 catalog 위치 순, constraint와 index는 이름 순이다. 문서에는 diagram과 comment가 없다.
- 이름이 `dbspec$`로 시작하는 table과 column은 모두 빼고 보고하지 않는다: plan history table `dbspec$plans`, plan이 숨긴 table과 column, SQLite 작업 table이다([plans](plans.md#steps)).
- database에 렌더링되는 setting만 읽는다: trigger로 알아보는 `immutable`과 `audit`. manifest setting은 문서에만 있다. 동기화하는 도구는 비교하는 문서에서 이를 유지한다.

### Type과 column

| Catalog | MySQL `COLUMN_TYPE` | PostgreSQL `format_type` | SQLite 선언 type | dbspec |
| --- | --- | --- | --- | --- |
| 16, 32, 64-bit 정수 | `smallint`, `int`, `bigint` | `smallint`, `integer`, `bigint` | renderer CHECK가 있는 `smallint`, `integer`, `bigint` | `i16`, `i32`, `i64` |
| boolean | renderer CHECK가 있는 `tinyint(1)` | `boolean` | renderer CHECK가 있는 `BOOLEAN` | `bool` |
| decimal | `decimal(p,s)` | `numeric(p,s)` | renderer CHECK가 있는 `DECIMALINT(p,s)` | `decimal(p,s)` |
| 실수 | `double` | `double precision` | renderer CHECK가 있는 `REAL` | `f64` |
| 길이 제한 text | `utf8mb4_0900_bin`의 `varchar(n)` | collation `C`의 `character varying(n)` | renderer CHECK가 있는 `varchar(n)` | `varchar(n)` |
| text | `utf8mb4_0900_bin`의 `longtext` | collation `C`의 `text` | CHECK 없는 `TEXT` | `text` |
| bytes | `longblob` | `bytea` | `BLOB` | `bytes` |
| uuid | renderer CHECK가 있는 `ascii_bin`의 `char(36)` | `uuid` | renderer CHECK가 있는 `TEXT` | `uuid` |
| date | `date` | `date` | renderer CHECK가 있는 `DATE` | `date` |
| 하루 중 시각 | renderer CHECK가 있는 `time`이나 `time(p)` | renderer CHECK가 있는 `time(p) without time zone` | p 하나의 renderer CHECK가 있는 `TIME` | `time(p)` |
| date-time | `datetime`이나 `datetime(p)` | `timestamp(p) without time zone` | p 하나의 renderer CHECK가 있는 `DATETIME` | `datetime(p)` |

MySQL은 precision 0을 괄호 없이 쓴다(`time`, `datetime`). type, collation, character set이 이 표에 없는 column, renderer CHECK 없는 MySQL `tinyint(1)`, `char(36)`, `time` column, CHECK가 어떤 dbspec type의 renderer 출력도 아닌 SQLite column은 미지원으로 보고한다.

- **Null.** `IS_NULLABLE`, `attnotnull`, `pragma_table_xinfo.notnull`이 `null`을 준다.
- **Identity.** MySQL `EXTRA` `auto_increment`, PostgreSQL `attidentity` `d`, SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`인 단일 column `bigint` primary key는 `identity`다. PostgreSQL `attidentity` `a`(`ALWAYS`)는 미지원이다.
- **Default.** literal default는 column의 canonical default 형식으로 읽는다. MySQL `COLUMN_DEFAULT`는 escape를 푼 값(문자열, 숫자, `bool`이면 `1`이나 `0`)이다. PostgreSQL `pg_get_expr`는 `'-5'::integer`, `'a''b'::character varying`, `'2026-01-01'::date`처럼 cast를 가진 literal을 주며 cast를 뗀다. SQLite `dflt_value`는 렌더링한 literal이며 decimal은 scale을 곱한 정수다. 시각 default는 renderer 출력과 같을 때 `default now`다: `DEFAULT_GENERATED`인 MySQL `CURRENT_TIMESTAMP`나 `CURRENT_TIMESTAMP(p)`, PostgreSQL `statement_timestamp()`, 그 precision의 SQLite `strftime` 식. 그 밖의 식은 미지원이다.

### Key, index, foreign key

- primary key는 column 순서를 유지한다. MySQL `UNIQUE` index, PostgreSQL `UNIQUE` constraint, origin이 `c`인 SQLite unique index는 unique key이고, 그 밖의 index는 index이며 `DESC`는 `COLLATION`, `indoption`, `pragma_index_xinfo.desc`에서 읽는다.
- prefix, partial, expression, full-text index, constraint 없는 PostgreSQL unique index, primary key가 아닌 SQLite `sqlite_autoindex`, 이름에 `$`가 있는 index는 미지원이다.
- foreign key는 이름, column, 참조 table과 column, 두 action을 읽는다. `NO ACTION`, `SET DEFAULT`, deferrable key, `MATCH FULL`, 참조 table이 다른 schema에 있는 PostgreSQL key는 미지원이다. SQLite foreign key 이름은 `sqlite_master`의 `CREATE TABLE` text에서 온다.

### Check

`<table>$<column>` 이름의 check는 renderer CHECK다. column type에 대한 renderer 출력의 catalog 형식과 같아야 한다: `bool`은 MySQL `` (`c` in (0,1)) ``, `uuid`는 `` regexp_like(`c`,_utf8mb4\'^…$\',_utf8mb4\'c\') ``, `time(p)`는 `` ((`c` >= _utf8mb4\'00:00:00\') and (`c` < _utf8mb4\'24:00:00\')) ``, PostgreSQL은 column 이름을 `quote_ident`가 쓰는 대로 쓴 `CHECK ((c < '24:00:00'::time without time zone))`, SQLite는 렌더링한 text 그대로다. MySQL은 table의 `ALTER TABLE`마다 `CHECK_CLAUSE`를 다시 써서 uuid pattern에 `_ascii` introducer를 주고 time literal의 introducer를 뺀다(`mysql.check.alter_rewrites_introducers`). 또 `time(p)` column과 만나는 time literal을 0으로 된 `p` 자리 소수와 함께 쓴다(`mysql.check.alter_writes_time_precision`). 그래서 MySQL clause는 character set introducer와 time literal의 0인 소수를 뺀 뒤 비교한다. 이 template의 literal은 ASCII이고 0인 소수는 값을 바꾸지 않으므로 비교는 의미를 지킨다. 다른 renderer CHECK와 renderer CHECK가 아닌 `$` 이름은 미지원이다.

그 밖의 check는 [dbspec](dbspec.md#checks)의 predicate로 읽어 canonical form으로 쓴다.

- **MySQL** `CHECK_CLAUSE`: 모두 괄호로 감싸고, keyword는 소문자, column은 backquote, `in (a,b)`는 공백 없음, 음수는 `-(n)`, 문자열은 `_utf8mb4`와 MySQL 문자열 literal이며 그 text는 한 번 더 escape된다(clause 안의 `\'`와 `\\`).
- **PostgreSQL** `pg_get_constraintdef`: 모두 괄호로 감싼 식을 `CHECK (…)`가 감싸고, column은 `quote_ident`가 필요할 때만 따옴표를 쓰며, literal과 column에 cast가 붙고(`'x'::text`, `(s)::text`, `'-1.50'::numeric`, `(1.5)::double precision`), `in`은 `= ANY (ARRAY[…])`, `not in`은 `<> ALL (ARRAY[…])`이고, time과 date-time literal은 끝의 0 소수를 뺀다.
- **SQLite**: `CREATE TABLE` statement의 `CHECK (…)` 안 text이며 렌더링한 text다. decimal literal은 scale을 곱한 정수다.

literal은 만나는 column의 값으로 읽어 canonical default 형식으로 쓴다. 그래서 `datetime(6)` column의 `'2100-01-01 00:00:00'`은 `'2100-01-01 00:00:00.000000'`, `bool` column의 `1`은 `true`가 된다. predicate로 읽히지 않거나 dbspec 규칙을 어기는 check는 미지원이다.

### Trigger

`<table>$immutable_update`와 `<table>$immutable_delete`, 또는 `<table>$audit_insert`, `<table>$audit_update`, `<table>$audit_delete` 이름의 trigger는 모두가 renderer 출력과 같을 때 `immutable`이나 `audit` setting을 준다: MySQL timing, event, `ACTION_STATEMENT`, PostgreSQL은 table의 schema prefix를 뗀 `pg_get_triggerdef`와 그 function의 `prosrc`, SQLite는 `CREATE TRIGGER` text. `audit` parameter는 비교 전에 `audit_insert`의 insert statement와 `audit_update`의 `OLD` column에서 읽는다. insert는 action, previous, 기록하는 column을 적고, 기록하는 column은 audit column을 포함하며, insert가 적지 않은 table의 column은 schema text가 쓰는 대로 column 순서의 `exclude` 목록이 된다. audit 기록 table은 audit column의 유일한 foreign key의 대상 table이다. 빠지거나 다른 집합과 그 밖의 모든 trigger는 미지원이다.

### 미지원 객체

미지원 객체마다 kind, 있으면 table과 이름, 이유를 보고하며 문서에서는 뺀다. 목록은 table, kind, 이름 순이고 table이 없는 객체가 먼저 온다. kind는 `column`, `index`, `unique`, `foreign_key`, `check`, `trigger`(parse되지 않는 `immutable`이나 `audit` setting마다 하나), `view`, `routine`, `sequence`, `event`, `partition`(MySQL이나 PostgreSQL의 partitioned table과 PostgreSQL partition), `table`(SQLite `WITHOUT ROWID`나 virtual table, primary key가 없는 table)이다.

빠진 객체를 참조하는 객체도 보고하고 뺀다. 미지원 column 위의 index나 key, 빠진 table로 가는 foreign key, 미지원 column을 쓰는 check가 그렇다. introspect한 문서는 parse되며, parse가 거부한 줄의 객체는 그 diagnostic을 이유로 보고되고 빠진다. 문서가 parse될 때까지 반복한다. parse가 table을 거부하면 그 table은 모든 객체와 함께 빠지고, 같은 parse에서 거부된 그 table의 객체는 따로 보고하지 않는다. 각 객체는 한 번만 보고한다. catalog row가 column마다 하나인 foreign key도 그렇다.

SQLite는 table 항목을 `CREATE TABLE` text에서 읽는다. column 정의는 renderer 형식, 곧 따옴표 친 이름, 선언 type, `NULL`이나 `NOT NULL`, 있으면 default일 때 읽는다. 다른 clause(`CHECK`, `REFERENCES`, `UNIQUE`, `COLLATE` 등)가 있는 column은 미지원이다. renderer 형식이 아닌 `CHECK`, `UNIQUE`, `FOREIGN KEY` 항목은 그 kind와 constraint 이름을 붙여 보고하며, 이름이 없으면 빈 이름이다. `UNIQUE` 항목이나 clause의 자동 index는 따로 보고하지 않는다. 다른 형식의 primary key 항목과 그 밖의 항목은 table을 빼게 한다.

## Markdown IR executor

DSN scheme `markdown://`은 SQL dialect 대신 flowmark IR executor를 고른다([protocol](protocol.ko.md#_5-ir-executors)). executor는 SQL text를 만들지 않으므로, 이 client의 각 표면은 여기 적은 규칙으로 지원되거나, 그 행의 코드로 거부된다. 판정은 같은 표면에 대한 flowmark capability 표의 것이다.

| 표면 | 결과 | 규칙 |
|---|---|---|
| `one`, `all`, `count`, `group_count`, `sum`, `avg` | 지원 | 행은 메모리 안의 corpus에서 읽는다. `group_count`는 NULL을 한 그룹으로 묶는다 |
| 정렬 | 지원 | IR `order`는 column의 type으로 정렬한다. 정렬이 없는 읽기는 저장 순서를 돌려준다 |
| `paginate` | 지원 | 요청 하나는 일관된 corpus 하나를 읽는다 |
| `insert` (한 행과 여러 행) | 지원 | `identity`, `key_prefix`, `order` column은 executor가 정하며 생략할 수 있다. 기본값은 명시해 쓴다 |
| `update` | 지원 | 읽은 뒤 대상이 바뀌었으면 `WRITE_CONFLICT`로 실패하며, 덮어쓰지 않는다 |
| `delete`, `restore` | 지원 | `restore`는 soft delete column을 비우고, row가 삭제된 동안 unique key를 유지한다. 참조되는 row의 삭제는 `FOREIGN_KEY`다 |
| `optimistic` | 지원 | 맞는 row가 없으면 `OPTIMISTIC_LOCK`이다 |
| `on_duplicate` | 지원 | 충돌 대상은 임의의 unique key다(MySQL 규칙). unique key가 여럿인 table에서는 PostgreSQL과 SQLite의 대상 규칙과 다르다 |
| `lock` `update`, `share` | 지원 | 무동작으로 받아들인다. server 트랜잭션이 이미 corpus lock을 잡고 있다 |
| `lock` `update_nowait`, `share_nowait` | `CAPABILITY_UNSUPPORTED` | |
| 관계(`limit_per_parent`, `if_parent`, `flatten`, `key_by`, `no_cascade_delete`) | 지원 | executor가 조립한다 |
| 부분 질의(`tuple_in`, `tuple_not_in`, scalar `Sub` 집계) | 지원 | |
| `now`, `default now`, `updated`, `soft_delete` | 지원 | 요청의 `now`다([clock](protocol.ko.md#_2-plan)) |
| codec column | 지원 | SQL과 같이 클라이언트가 적용한다([protocol](protocol.ko.md#_5-ir-executors)) |
| index | 지원 | 허용하고 메모리 안에서 파생한다 |
| `select explicit`, `entity`, `navigation` | 지원 | 클라이언트 쪽이며 저장소에 영향이 없다 |
| `aes`, `aes_version`, `blind_index` | `SCHEMA_INVALID` | executor가 corpus catalog를 읽을 때 거부한다. key는 클라이언트를 떠나지 않는다 |
| `audit`, `immutable` setting | `SCHEMA_INVALID` | executor가 corpus catalog를 읽을 때 거부한다. 대신 `state_machine … history`를 쓴다 |
| 트랜잭션 | 지원 | 세션 위에서 `begin`부터 `commit` 또는 `rollback`까지다. `readOnly`는 지키고 lock을 잡는다 |
| savepoint | 지원 | 중첩된 단계다 |
| `orderByRandom` | 지원 | 순서를 seed로 정하지 않는다 |
| audit 값이 있는 트랜잭션 | `CAPABILITY_UNSUPPORTED` | |
| `isolation`, `timeoutMs` 옵션 | `CAPABILITY_UNSUPPORTED` | |
| `getQuery()`, statement event, `subscribe()` | `CAPABILITY_UNSUPPORTED` | SQL text가 없다 |
| `force_index` | `CAPABILITY_UNSUPPORTED` | index는 이름이 아니라 파생된다 |
| `fulltext`, `Lb` 연산자 | `OPERATOR_NOT_ALLOWED` | |
| lock, local 설정, 권한, AES 회전 유틸리티 | `CAPABILITY_UNSUPPORTED` | |
| schema 설치, dbplan 체인 | `CAPABILITY_UNSUPPORTED` | `flowmark install`이 corpus를 만든다. schema 변경은 flowmark 이전 규칙을 따른다 |
