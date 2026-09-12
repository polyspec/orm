# SQL dialects (S6)

A SQL dialect is the SQL syntax and execution rule set for one database system. In this project, `mysql`, `postgres`, and `sqlite` select identifier quoting, placeholders, type mapping, write syntax, and supported SQL functions. The planner asks the selected SQL dialect for every database-specific part; the IR and plan format do not change.
Executors still see the same plan shape: steps, bind slots, assemble.

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
| `point` type | `POINT(x y)` bind; `ST_PointFromText(?)` / `ST_AsText(col)` | `(x,y)` bind; `CAST(? AS text)::point` / `(col)::text` | `POINT(x y)` text |
| `NOW` | `CURRENT_TIMESTAMP` | same | same |

Executor consequences (docs/lanes/s6.md): a `$n` renumbering step when expanding relation IN lists on
PostgreSQL, host-side AES/inet codecs where the table says "app-side", one DSN/driver per database
(Go: `pgx` stdlib / `modernc.org/sqlite`; Rust: sqlx features; PHP: `pdo_pgsql` / `pdo_sqlite`).

**Go driver packages.** `clients/go/orm` links MySQL only. A program that opens PostgreSQL or SQLite
imports the matching package for its side effect, as it would a `database/sql` driver:

```go
import (
    _ "github.com/polyspec/orm/clients/go/orm/pg"      // driver "postgres"
    _ "github.com/polyspec/orm/clients/go/orm/sqlite"  // driver "sqlite"
)
```

Without it `orm.Open` returns `CONFIG` naming the import. The split keeps a MySQL-only binary at
4.6MB instead of 11MB and avoids SQLite's package init (it parses `/etc/services`). Rust does the
same with sqlx features, PHP with the PDO extension that is installed.

## Rules that keep the three databases identical (S6)
- `UPDATE` always assigns the entity's updated timestamp explicitly (`updated_ts = CURRENT_TIMESTAMP(6)` on MySQL, `CURRENT_TIMESTAMP` on PostgreSQL, an executor-bound microsecond text on SQLite via a `now` bind slot) — MySQL's `ON UPDATE` has no counterpart elsewhere and optimistic locking relies on it.
- `plus`/`minus` reference the column table-qualified (`"battle"."read_count" + $9`): inside `ON CONFLICT DO UPDATE` a bare name is ambiguous on PostgreSQL.
- `?` in user fragments (`expr`, `setXExpr`, named predicates, `raw`) is rewritten to the dialect placeholder in bind order; the count must equal the binds (`IR_INVALID` otherwise). Fragments are otherwise raw SQL: write them portably (`LENGTH(x)`, `TRUE`/`FALSE`, not `DAYOFMONTH` or `= 0` against booleans).
- SQLite datetimes are text with six fraction digits (`YYYY-MM-DD HH:MM:SS.ffffff`, UTC); the executor binds `time` values in that form and the DDL defaults produce it, so a value read back compares equal.
- Booleans: PostgreSQL `boolean`, SQLite INTEGER 0/1 (read back as bool by column type); bind bools, not integers, in fragments/raw.
- `bind_slots[].col_type` names a `date`, `time`, `datetime`, or `point` target. Executors normalize SQLite time values and convert typed points to `POINT(x y)` before binding.
- aes/hex/ip host stages: `bind_slots[].host_styles` names the stages the executor applies to a bound value; `columns[].styles` carries them on read. Host AES = MySQL key folding + AES-128-ECB/PKCS7 (byte-identical, `tests/codec/aes-vectors.json`).
- Seeds: `bench/sql/seed.pg.sql`, `bench/sql/seed.sqlite.sql`, then `go run ./bench/seedaes` fills the aes columns with the same bytes MySQL's `AES_ENCRYPT` produced.
- Conformance: `tests/conformance/vectors.postgres.json` / `vectors.sqlite.json` are recorded per dialect; every vector's **result** is identical to MySQL except `sql_dump`, whose result is the dialect's own SQL text.
