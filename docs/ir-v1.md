# IR v1 specification

> Legacy design document. Current implementation references are [common interface](interfaces.md), [DSL](dsl.md), [protocol](protocol.md), and [schema](schema.md).

Goal: **one schema → one parser → spec.json (IR) → four renderers (PHP/Go/Rust/TypeScript)**.
Renderers do not parse. They read the IR and compose names.

```
schema/*.sql  ──파서──▶  spec/*.json  ──▶ php.tmpl / go.tmpl / rust.tmpl
```

## 0. Immutable rules

1. **Operators are positional.** The IR contains operators only as `{op, column}` pairs.
   The string `gt_created_ts` never appears in the IR. It is composed during rendering.
2. The **canonical token** is `op:column`. All four renderers must expose the same token set.
3. Each renderer applies its language casing convention.
   `{op:"gt", column:"created_ts"}` → `gtCreatedTs` / `GtCreatedTs` / `gt_created_ts`

## 1. File units

One table equals one spec file.

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

`entity` is a singular snake_case name. Renderers convert it to `User` / `user` / `user::`.

## 2. Columns

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

The parser **calculates and writes** `ops` from the type and styles. Renderers do not decide it.

### 2.1 Normalized types

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
| `point` | `array{float,float}` | `[2]float64` | `(f64, f64)` | `[number, number]` |
| `inet` | `string` | `netip.Addr` | `std::net::IpAddr` | `string` |
| `enum` | `string` | `string` + const | `enum` | string union |

`timestamp` is a Unix epoch **integer**. A MySQL `TIMESTAMP` column maps to `datetime`.

For nullable values use PHP `?T`, Go `*T`, and Rust `Option<T>`. Go does not use `sql.NullX`; that would make the client shapes differ.

### 2.2 dataStyle

Styles are a pipeline array. **Write in array order and read in reverse order.**

```json
"style": ["json"]              // json_encode
"style": ["serialize","gz"]    // serialize → gzcompress
"style": ["aes","hex"]         // AES_ENCRYPT → HEX
"style": ["ip"]                // INET6_ATON / INET6_NTOA
```

A single style name such as `aes_serialize` or `aes_hex` is represented as a list of stages. New combined names are unnecessary.

| stage | encode | decode | location |
|---|---|---|---|
| `json` | `json_encode` | `json_decode` | app |
| `yaml` | yaml dump | yaml parse | app |
| `serialize` | language serialization | same | app |
| `gz` | gzip | gunzip | app |
| `base64` | b64 | 〃 | app |
| `hex` | hex | unhex | app |
| `aes` | `AES_ENCRYPT(?, :__key)` | `AES_DECRYPT(col, :__key)` | **SQL** |
| `ip` | `INET6_ATON(?)` | `INET6_NTOA(col)` | **SQL** |
| `point` | `ST_PointFromText(?)` | `ST_AsText(col)` | **SQL** |

`serialize` is not portable between languages (PHP `serialize()` and Go/Rust). The parser emits a **warning** when multiple clients read the same table; use `json` instead.

An SQL-side stage changes both the SELECT list and binds, so renderers always receive column expressions as `select_expr` / `bind_expr`.

### 2.3 Operator selection rules

Default matrix:

| type | ops |
|---|---|
| `i32 i64 f64 decimal date datetime timestamp` | `eq ne gt ge lt le in between is_null` |
| `string text` | `eq ne in lk lb is_null` (+ 인덱스가 있으면 `gt ge lt le`) |
| `enum` | `eq ne in is_null` |
| `bool` | `eq ne is_null` |
| `inet` | `eq ne in is_null` |
| `json bytes point` | `is_null` |

Style adjustment — **ordering comparisons have no meaning for encoded columns.**

- `["aes"]`, `["aes","hex"]`: deterministic (MySQL default ECB), so retain `eq ne in is_null` and remove the rest.
- `["gz"]`, `["base64"]`, `["serialize"]`, `["json"]`: retain only `is_null`.
- `["ip"]`: `eq ne in is_null` (`gt/lt` may be considered in v2 because `INET6_ATON` results can be ordered).
- Remove `is_null` when `nullable: false`.

`lk` means LIKE and `lb` means LIKE BINARY. `fulltext` is deferred to v2.

## 3. Relations

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

`kind` is `one` or `many`. Methods are `withProfile()` / `WithProfile()` / `with_profile()`.

Loading collects and deduplicates the parent rows' `local` values, then runs one `IN (...)` query per relation. For `kind:"many"`, `foreign` is not unique, so all matching rows are read by child primary key and grouped in the client.

Joins are absent from v1. Relations use **separate queries and batch loading** only.

## 4. Validation (the parser fails the build)

1. A column name containing `_and_` or `_or_` is an **error** because the PHP `__call` parser splits it into two conditions.
2. A column name beginning with an operator token and `_` (`gt_`, `eq_`, `lk_`, `in_`, `between_`, …) is an **error**.
3. A column name colliding with a reserved prefix (`get`, `gets`, `set`, `order`, `with`, `match`) is an **error**.
4. `serialize` in `style` with multiple language targets is a **warning**.
5. A `primary_key` missing from `columns` is an **error**.

Rules 1 and 2 convert silent runtime failures into build-time validation.

## 5. Parity tests

Each renderer prints its canonical token set with `--dump-tokens`.

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

CI performs a four-way diff and fails on any difference. Casing prevents direct source comparison, so **tokens are compared instead of generated source**.

## 6. v1 scope

Included: single-table predicates, order/limit/offset, CRUD, dataStyle, batch-loaded relations, and one `raw()` operation.
Excluded: joins, subqueries, nested parentheses, aggregates, transaction helpers (v2), and fulltext.
