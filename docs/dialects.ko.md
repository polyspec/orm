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
| `ip` style | `INET6_ATON` / `INET6_NTOA` | `(?)::inet` / `host(col)` | app-side (16-byte packed) |
| `point` type | `POINT(x y)` bind; `ST_PointFromText(?)` / `ST_AsText(col)` | `(x,y)` bind; `CAST(? AS text)::point` / `(col)::text` | `POINT(x y)` text |
| `NOW` | `CURRENT_TIMESTAMP` | same | same |

Executor 결과는 PostgreSQL parent IN list 확장 후 `$n` 재번호화, app-side AES/inet codec, database별 DSN/driver 선택이다.

**Go driver package.** `clients/go/orm`은 MySQL만 연결한다. PostgreSQL 또는 SQLite를 열려면 해당 package를 side effect import한다.

```go
import (
    _ "github.com/polyspec/orm/clients/go/orm/pg"      // driver "postgres"
    _ "github.com/polyspec/orm/clients/go/orm/sqlite"  // driver "sqlite"
)
```

import하지 않으면 `orm.Open`은 필요한 import를 포함한 `CONFIG`를 반환한다. Rust는 sqlx feature를 사용하고 PHP는 설치된 PDO extension을 사용한다.

## 세 database의 같은 결과를 유지하는 규칙
- `UPDATE`는 updated timestamp를 항상 명시한다. MySQL의 `ON UPDATE`는 다른 database에 대응하지 않는다.
- `plus`와 `minus`는 column을 table-qualified로 작성한다.
- 원시 조각(`raw`, `setRaw<Col>`, `addRawColumn<Alias>`)의 `?`는 bind 순서에 따라 방언 placeholder로 변경한다. 개수와 bind 개수가 다르면 `IR_INVALID`다.
- SQLite datetime은 연결 시간대 기준 여섯 자리 소수의 text다. 삽입 시 `=now` 컬럼 값은 실행기가 이 시간대의 시각으로 채운다. datetime 컬럼과 비교하거나 대입하는 문자열도 같은 형식으로 바꾼다. `YYYY-MM-DD[ T]HH:MM:SS[.f]`는 소수 여섯 자리로 채우고, `Z`나 `±HH:MM`을 포함한 문자열은 연결 시간대로 변환한다. date 컬럼은 `YYYY-MM-DD`를 받는다. 그 밖의 문자열은 `CODEC_ENCODE`를 반환한다.
- `jsontext` 컬럼은 모든 방언에서 텍스트다. PostgreSQL은 `text`, MySQL은 `LONGTEXT`, SQLite는 TEXT다. 저장한 텍스트를 그대로 반환하므로 멤버 순서, 중복 키, 빈 객체와 빈 배열의 구분이 유지된다. ORM에는 JSON 경로 조건과 JSON 인덱스가 없으며, 데이터베이스 안에서 질의하는 데이터는 컬럼이나 자식 테이블로 만든다.
- `uuid` 컬럼은 PostgreSQL에서 네이티브 `uuid`, MySQL에서 `char(36)`, SQLite에서 TEXT다. 클라이언트는 uuid 값을 텍스트로 bind한다.
- MySQL은 TEXT, BLOB, JSON, geometry 컬럼의 리터럴 기본값을 식 형식 `DEFAULT ('value')`로 기록하며 MySQL 8.0.13 이상이 필요하다. import는 이를 리터럴로 다시 읽는다.
- Boolean은 PostgreSQL `boolean`, SQLite INTEGER 0/1이다. fragment와 raw에는 boolean을 bind한다.
- `bind_slots[].col_type`은 `date`, `time`, `datetime`, `point` 대상을 기록한다. 실행기는 SQLite 시간 값을 정규화하고 typed point를 bind 전에 `POINT(x y)`로 변환한다.
- `bind_slots[].host_styles`와 `columns[].styles`는 실행기가 처리할 host stage를 기록한다. AES는 `docs/codec.md`에 정의한 `ORM-AES2\0` authenticated ciphertext format, 12바이트 random nonce, AES-256-GCM, version key derivation을 사용한다.
- AES column에는 `aes_key_version`이 필요하다. 읽기는 저장된 version으로 설정된 key version에서 key를 선택한다. key가 없거나 ciphertext가 유효하지 않으면 `CONFIG` 또는 `CODEC_DECODE`를 반환하며 이전 version에 current key를 사용하지 않는다.
- seed는 `bench/sql/seed.mysql.sql`, `bench/sql/seed.pg.sql`, `bench/sql/seed.sqlite.sql`을 실행한 후 `go run ./bench/seedaes`로 인증된 host 형식의 AES와 blind-index 값을 채운다.
- conformance vector의 결과는 세 database에서 같아야 한다. `get_query`는 방언 SQL을 반환한다.
