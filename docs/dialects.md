# Dialects (S6)

The planner asks the dialect for every database-specific piece; the IR and the plan format never change.
Executors still see the same plan shape: steps, bind slots, assemble.

| | MySQL 8.0.2+ / MariaDB 10.2+ | PostgreSQL 12+ | SQLite 3.35+ |
|---|---|---|---|
| identifiers | `` `x` `` | `"x"` | `"x"` |
| placeholders | `?` | `$n` (the executor renumbers when it expands a `parent` slot to N values) | `?` |
| LIMIT | `LIMIT off, n` | `LIMIT n OFFSET off` | `LIMIT n OFFSET off` |
| `like`/`contains`/`startsWith`/`endsWith` | `LIKE` (collation-driven case-insensitivity) | `ILIKE` | `LIKE … ESCAPE '\'` (ASCII case-insensitive) |
| `likeBinary` | `LIKE BINARY` | `LIKE` | **rejected** (`OPERATOR_NOT_ALLOWED`) |
| fulltext `…Match` / `…MatchBoolean` | `MATCH … AGAINST (… IN NATURAL LANGUAGE/BOOLEAN MODE)`, boolean value mangled compatibility-style (`+a +b*`) | `to_tsvector('simple', coalesce(a,'') || ' ' || …) @@ plainto_tsquery / websearch_to_tsquery('simple', ?)`, value trimmed only | **rejected** (FTS5 needs virtual tables) |
| `forceIndex<Name>` | `FORCE INDEX (name)` | ignored (no hints) | `INDEXED BY "name"` |
| insert id | `LAST_INSERT_ID()` (upsert adds `pk = LAST_INSERT_ID(pk)`) | `RETURNING pk` | `RETURNING pk` |
| upsert (`onDuplicate…`) | `ON DUPLICATE KEY UPDATE` (any unique key) | `ON CONFLICT (cols) DO UPDATE SET` — conflict target = the first declared unique key fully covered by the inserted columns, else the PK | same as PostgreSQL |
| `limitPerParent` | `ROW_NUMBER() OVER (…)` | same | same (3.25+) |
| `aes`/`hex` styles | in SQL: `HEX(AES_ENCRYPT(?, ?))` / `AES_DECRYPT(UNHEX(col), ?)` (compatibility bytes) | app-side (executor: host AES — MySQL key folding, AES-128-ECB, PKCS7; bytes identical to MySQL's) | app-side |
| `ip` style | `INET6_ATON` / `INET6_NTOA` | `(?)::inet` / `host(col)` | app-side (16-byte packed) |
| `NOW` | `CURRENT_TIMESTAMP` | same | same |

Executor consequences (docs/lanes/s6.md): a `$n` renumbering step when expanding relation IN lists on
PostgreSQL, host-side AES/inet codecs where the table says "app-side", one DSN/driver per database
(Go: `pgx` stdlib / `modernc.org/sqlite`; Rust: sqlx features; PHP: `pdo_pgsql` / `pdo_sqlite`).
