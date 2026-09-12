# 방언 (S6)

Planner는 database별 SQL 요소를 방언에 요청한다. IR과 plan 형식은 변경하지 않는다. Executor가 받는 plan 구조도 step, bind slot, assemble로 같다.

| | MySQL 8.0.2+ / MariaDB 10.2+ | PostgreSQL 12+ | SQLite 3.35+ |
|---|---|---|---|
| identifiers | `` `x` `` | `"x"` | `"x"` |
| placeholders | `?` | `$n` (the executor renumbers when it expands a `parent` slot to N values) | `?` |
| LIMIT | `LIMIT off, n` | `LIMIT n OFFSET off` | `LIMIT n OFFSET off` |
| `like`/`contains`/`startsWith`/`endsWith` | `LIKE` (collation-driven case-insensitivity) | `ILIKE` | `LIKE … ESCAPE '\'` (ASCII case-insensitive) |
| `likeBinary` | `LIKE BINARY` | `LIKE` | **rejected** (`OPERATOR_NOT_ALLOWED`) |
| fulltext `…Match` / `…MatchBoolean` | `MATCH … AGAINST (… IN NATURAL LANGUAGE/BOOLEAN MODE)`, boolean value normalized (`+a +b*`) | `to_tsvector('simple', coalesce(a,'') || ' ' || …) @@ plainto_tsquery / websearch_to_tsquery('simple', ?)`, value trimmed only | **rejected** (FTS5 needs virtual tables) |
| `forceIndex<Name>` | `FORCE INDEX (name)` | ignored (no hints) | `INDEXED BY "name"` |
| insert id | `LAST_INSERT_ID()` (upsert adds `pk = LAST_INSERT_ID(pk)`) | `RETURNING pk` | `RETURNING pk` |
| upsert (`onDuplicate…`) | `ON DUPLICATE KEY UPDATE` (any unique key) | `ON CONFLICT (cols) DO UPDATE SET` — conflict target = the first declared unique key fully covered by the inserted columns, else the PK | same as PostgreSQL |
| `limitPerParent` | `ROW_NUMBER() OVER (…)` | same | same (3.25+) |
| `aes`/`hex` styles | in SQL: `HEX(AES_ENCRYPT(?, ?))` / `AES_DECRYPT(UNHEX(col), ?)` | app-side (executor: host AES — MySQL key folding, AES-128-ECB, PKCS7; bytes identical to MySQL's) | app-side |
| `ip` style | `INET6_ATON` / `INET6_NTOA` | `(?)::inet` / `host(col)` | app-side (16-byte packed) |
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

## 세 database의 같은 결과를 유지하는 규칙 (S6)
- `UPDATE`는 updated timestamp를 항상 명시한다. MySQL의 `ON UPDATE`는 다른 database에 대응하지 않는다.
- `plus`와 `minus`는 column을 table-qualified로 작성한다.
- 사용자 fragment의 `?`는 bind 순서에 따라 방언 placeholder로 변경한다. 개수와 bind 개수가 다르면 `IR_INVALID`다.
- SQLite datetime은 UTC 기준 여섯 자리 소수의 text다.
- Boolean은 PostgreSQL `boolean`, SQLite INTEGER 0/1이다. fragment와 raw에는 boolean을 bind한다.
- `bind_slots[].col_type`은 date/time/datetime 대상의 type을 기록한다.
- `bind_slots[].host_styles`와 `columns[].styles`는 executor가 처리할 host stage를 기록한다.
- seed는 database별 SQL을 실행한 후 `go run ./bench/seedaes`로 AES 값을 채운다.
- conformance vector의 결과는 세 database에서 같아야 한다. `sql_dump`는 방언 SQL을 반환한다.
