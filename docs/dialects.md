# SQL dialects

A SQL dialect is the SQL syntax and execution rule set for one database system. In this project, `mysql`, `postgres`, and `sqlite` select identifier quoting, placeholders, type mapping, write syntax, and supported SQL functions. The planner asks the selected SQL dialect for every database-specific part; the IR and plan format do not change.
Executors still see the same plan shape: steps, bind slots, assemble.

| | MySQL 8.0.2+ / MariaDB 10.2+ | PostgreSQL 12+ | SQLite 3.46+ |
|---|---|---|---|
| identifiers | `` `x` `` | `"x"` | `"x"` |
| placeholders | `?` | `$n` (the executor renumbers when it expands a `parent` slot to N values) | `?` |
| LIMIT | `LIMIT off, n` | `LIMIT n OFFSET off` | `LIMIT n OFFSET off` |
| `Lk` | `LIKE` (collation-driven case-insensitivity) | `ILIKE` | `LIKE … ESCAPE '\'` (ASCII case-insensitive) |
| `Lb` | `LIKE BINARY` | `LIKE` | `instr(col, ?) > 0` |
| `Fulltext` / `FulltextBoolean` | `MATCH … AGAINST (… IN NATURAL LANGUAGE/BOOLEAN MODE)`, boolean value normalized (`+a +b*`) | `to_tsvector('simple', coalesce(a,'') || ' ' || …) @@ plainto_tsquery / websearch_to_tsquery('simple', ?)`, value trimmed only | **rejected** (FTS5 needs virtual tables) |
| `forceIndex<Name>` | `FORCE INDEX (name)` | ignored (no hints) | `INDEXED BY "name"` |
| insert id | `LAST_INSERT_ID()` (upsert adds `pk = LAST_INSERT_ID(pk)`) | `RETURNING pk` | `RETURNING pk` |
| `duplication(model)` | `ON DUPLICATE KEY UPDATE` (any unique key) | `ON CONFLICT (cols) DO UPDATE SET` — conflict target = the first declared unique key fully covered by the inserted columns, else the PK | same as PostgreSQL |
| `groupLimit(n)` | `ROW_NUMBER() OVER (…)` | same | same |
| `tuple<ColA>With<ColB>` | `(a, b) IN ((?, ?), …)` | same | `(a, b) IN (VALUES (?, ?), …)` |
| `orderByRandom()` | `RAND()` | `random()` | `random()` |
| ORM functions | see [DSL](dsl.md#_10-orm-functions) | | |
| `aes`/`hex` styles | app-side authenticated AES-256-GCM v2 ciphertext, then hex text when `hex` is present | app-side authenticated AES-256-GCM v2 ciphertext, then hex text when `hex` is present | app-side authenticated AES-256-GCM v2 ciphertext, then hex text when `hex` is present |
| `ip` style | `INET6_ATON` / `INET6_NTOA` | `(?)::inet` / `host(col)` | app-side (16-byte packed) |
| `point` type | `POINT(x y)` bind; `ST_PointFromText(?)` / `ST_AsText(col)` | `(x,y)` bind; `CAST(? AS text)::point` / `(col)::text` | `POINT(x y)` text |
| `NOW` | `CURRENT_TIMESTAMP` | same | same |

Executor consequences: a `$n` renumbering step when expanding relation IN lists on
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

## Rules that keep the three databases identical
- `UPDATE` always assigns the entity's updated timestamp explicitly (`updated_ts = CURRENT_TIMESTAMP(6)` on MySQL, `CURRENT_TIMESTAMP` on PostgreSQL, an executor-bound microsecond text on SQLite via a `now` bind slot) — MySQL's `ON UPDATE` has no counterpart elsewhere and optimistic locking relies on it.
- `plus`/`minus` reference the column table-qualified (`"battle"."read_count" + $9`): inside `ON CONFLICT DO UPDATE` a bare name is ambiguous on PostgreSQL.
- `?` in raw fragments (`raw`, `setRaw<Col>`, `addRawColumn<Alias>`) is rewritten to the dialect placeholder in bind order; the count must equal the binds (`IR_INVALID` otherwise). Fragments are otherwise raw SQL: write them portably (`LENGTH(x)`, `TRUE`/`FALSE`, not `DAYOFMONTH` or `= 0` against booleans).
- SQLite datetimes are text with six fraction digits (`YYYY-MM-DD HH:MM:SS.ffffff`) in the connection time zone; the executor binds `time` values in that form and supplies the clock for `=now` columns on insert, so a value read back compares equal. A string compared with or assigned to a datetime column is written in the same form: `YYYY-MM-DD[ T]HH:MM:SS[.f]` gets six fraction digits, and a string with `Z` or `±HH:MM` is converted to the connection time zone. A date column takes `YYYY-MM-DD`. Any other string returns `CODEC_ENCODE`.
- A `jsontext` column is text on every dialect: `text` on PostgreSQL, `LONGTEXT` on MySQL, and TEXT on SQLite. The stored text is returned as written, so member order, duplicate keys, and an empty object against an empty array survive. The ORM has no JSON path conditions and no JSON indexes; data queried inside the database is modeled as columns or a child table.
- A `uuid` column is a native `uuid` on PostgreSQL, `char(36)` on MySQL, and TEXT on SQLite; clients bind uuid values as text.
- MySQL writes a literal default of a TEXT, BLOB, JSON, or geometry column in the expression form `DEFAULT ('value')`, which needs MySQL 8.0.13 or later; import reads it back as the literal.
- Booleans: PostgreSQL `boolean`, MySQL `BOOLEAN`/`TINYINT(1)` with numeric `0`/`1` defaults, and SQLite INTEGER 0/1 (read back as bool by column type); bind bools, not integers, in fragments/raw.
- CHECK expressions are rendered unchanged on PostgreSQL and SQLite. MySQL wraps the declared expression in an explicit boolean comparison because MySQL rejects predicate-valued `CASE` expressions as CHECK definitions; `NULL` remains `UNKNOWN` and therefore retains standard CHECK semantics. MySQL CHECK names are physically prefixed with the table name because MySQL scopes them to the database rather than the table; the logical MMD name remains unchanged. Generated constraint and index names are deterministically shortened to the engine's identifier limit with a hash suffix when required.
- `bind_slots[].col_type` names a `date`, `time`, `datetime`, or `point` target. Executors normalize SQLite time values and convert typed points to `POINT(x y)` before binding.
- aes/hex/ip host stages: `bind_slots[].host_styles` names the stages the executor applies to a bound value; `columns[].styles` carries them on read. AES uses the `ORM-AES2\0` authenticated ciphertext format, a random 12-byte nonce, AES-256-GCM, and the versioned key derivation defined in `docs/codec.md`.
- `aes_key_version` is required for AES columns. Reads select the key from the configured key versions using that stored version. A missing key or invalid ciphertext fails with `CONFIG` or `CODEC_DECODE`; the current key is never tried for an older version.
- Seeds: `bench/sql/seed.mysql.sql`, `bench/sql/seed.pg.sql`, and `bench/sql/seed.sqlite.sql`, then `go run ./bench/seedaes` fills the AES and blind-index columns using the authenticated host format.
- Conformance: `tests/conformance/vectors.postgres.json` / `vectors.sqlite.json` are recorded per dialect; every vector's **result** is identical to MySQL except `get_query`, whose result is the dialect's own SQL text.
