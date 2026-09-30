# Schema

Physical identities are separate from logical model identifiers. Preserve exact
optional catalog/schema/column components and a required table, never lowercase
or split a component at dots. Each present component is nonempty valid UTF-8,
at most 1024 bytes, without ASCII controls (U+0000–001F or U+007F). Reject invalid
components with SCHEMA_INVALID and a value-free message. An immutable identity
key is `p1:` plus four dot-separated tokens: `-` for absent, otherwise lowercase
UTF-8 hex, in catalog/schema/table/column order. This distinguishes namespace
boundaries without SQL quoting or name normalization. This key identifies a
name, not a stable document ID across renames. These primitives do not yet
implement physical schema import, annotations, DDL or migration execution.

Public APIs: Go `orm.NewPhysicalIdentity`, PHP `Orm\PhysicalIdentity`, Rust
`orm_schema::physical::PhysicalIdentity::new`, TypeScript
`createPhysicalIdentity` (exported from the package root). Components are returned
as detached values or immutable borrows. `make physical-identity-check` executes
the ten shared vectors twice per client and checks byte limits/invalid encodings.

Physical column records have exactly `id`, `name`, `typeSql`, `nullable`,
`default`, `generation`, `comment` and `options`. IDs match `[A-Za-z0-9_-]{1,128}`;
names follow the physical identity component rules. Preserve nonempty typeSql
up to 4096 UTF-8 bytes and comments up to 8192 bytes. nullable is a boolean.
Defaults are `{kind:"absent"}` or `{kind:"null"}`, or literal/expression kinds
with a nonempty `sql` up to 16384 bytes. Generation is `{kind:"none"}`, identity
with `sql`, or computed with `sql` and `storage` (stored/virtual/unspecified).
Generation SQL has the same 16384-byte limit. Ordered options contain at most 64
exact `{name,value}` string objects; name is nonempty up to 128 bytes, value up
to 4096 bytes. Every string is valid UTF-8 without NUL; a record contains at most
65536 bytes across string values. Unknown fields and wrong types fail with
value-free SCHEMA_INVALID. Return detached values or deeply immutable objects.
These APIs accept already decoded records, not JSON text; strict text parsing is
the input producer's responsibility. Classification and SQL semantics belong to
the dialect-aware importer/planner; structural acceptance does not permit DDL
or establish that an expression, literal or type is executable.

Column APIs: Go `orm.PhysicalColumnFromValue`, PHP
`Orm\PhysicalColumn::fromValue`, Rust
`orm_schema::physical_column::PhysicalColumn::from_value`, TypeScript package
export `createPhysicalColumn`. `make physical-column-check` runs the 25 shared
vectors twice per client, plus aggregate/field/option limits, invalid encodings
and alias checks. `PHYSICAL_NODE` explicitly selects its TypeScript tool runtime.

Physical FK records have exactly `id`, `name`, `tableId`, `columns`, `target`,
`onDelete`, `onUpdate`, `match`, `deferrable`, `initiallyDeferred`, `comment` and
`options`. Stable IDs use the column ID rules; name is null for unnamed, otherwise
an exact physical name. target is exactly `{tableId,columns}`. Local and target
column ID lists each contain 1–64 distinct IDs, with equal length and preserved
pair order. Self references and shared columns across independent FKs are valid.
Actions distinguish noAction/restrict/cascade/setNull/setDefault/unspecified;
match is simple/full/partial/unspecified. Deferral flags are boolean or null for
unspecified; initiallyDeferred true requires deferrable true. Comments/options
and whole-record string limits match physical columns. Unknown fields, invalid
IDs, duplicate columns, unequal arity and contradictory deferral fail safely.
This validates individual records, not graph membership or dialect support.

FK APIs: Go `orm.PhysicalForeignKeyFromValue`, PHP
`Orm\PhysicalForeignKey::fromValue`, Rust
`orm_schema::physical_foreign_key::PhysicalForeignKey::from_value`, TypeScript
package export `createPhysicalForeignKey`. Columns and FKs share bounded record
validation; Rust returns `physical_record::RecordError`, whose safe code is
SCHEMA_INVALID. `make physical-fk-check` executes all 26 shared FK vectors and
existing 25 column vectors twice in each client. It also checks 64/65-column
limits and measures creation/retention of 2000 independent FK records. This is
not connected-graph resolution, archive import or memory proof.
PHYSICAL_RUST_TOOLCHAIN selects Rust explicitly (default 1.98.1); the command
does not replace the user's global toolchain.

Physical graphs have exactly `version` (numeric value 1, never a boolean),
`dialect` (mysql/postgres/sqlite), nonempty UTF-8 `dialectVersion` up to 128 bytes,
`tables` and `foreignKeys`. Each table has exactly `id`, `identity` (the four
physical identity components, with column null), ordered `columns`, `comment`
and `options`. Validate metadata with the record limits; require 1–4096 columns
per table, at most 4096 tables, 120000 total columns, 20000 FKs and 16 MiB of
string values in the graph. Empty graphs are valid; null lists are not.
Table, column and FK IDs are globally unique. Exact qualified table identities,
column names within each table and named FKs within each source table are unique.
Build table/column-owner maps once before resolving FK pairs. Every local and
target ID must belong to its declared table; preserve order and allow cycles,
self references and multiple independent constraints on shared columns.
Graph errors expose SCHEMA_INVALID and a JSON-pointer path of fixed field names
and numeric positions, never input names/SQL. Component errors locate their
record; ownership/duplicate errors locate the invalid field. Results are
detached/deeply immutable. These graphs represent physical nodes and FK links,
not yet indices/checks, complete physical schemas, SQL dialect validation or
execution authority. The dialect version is preserved, not inferred or verified.

Public entry points are Go `orm.PhysicalGraphFromValue` (decoded JSON values,
with version also accepting native int 1), PHP `Orm\PhysicalGraph::fromValue`,
Rust `orm_schema::physical_graph::PhysicalGraph::from_value` and TypeScript
`createPhysicalGraph`. Go/PHP return detached snapshots through Value()/value();
Rust exposes an immutable borrowed Value and TypeScript deeply freezes output.
The located error types are PhysicalGraphError in Go/PHP/TypeScript and
GraphError in Rust. Root-shape errors have the empty JSON pointer.

Run `make physical-graph-check PHYSICAL_NODE=/absolute/path/to/node` for
28 shared graph vectors, five generated count/byte-limit vectors, the connected
2000-table/60000-column/10000-FK scenario and column/FK regressions, twice in
each client. Each owner reports its elapsed time and a 15-second graph-test
deadline. Generation and validation timing are separate; Rust tests use debug
builds. PHP reports process peak allocated bytes and its unmodified memory
limit, not resident memory or the memory of another runtime. These are
structural graph tests, not SQL dialect validation or DB proof.






The human-maintained schema files are `schema/*.mmd` (Mermaid `erDiagram`). GitHub, IDEs, and build artifacts render them as diagrams, and `ormgen` parses them into a generated **manifest** (`schema.json`) with columns, keys, relations, indexes, and styles. Do not edit the manifest.
For an existing database, `ormgen import --dsn … --out schema/service.mmd` creates the diagram; foreign keys become relation lines and indexes become `%%` directives.

## 1. Example

```mermaid
erDiagram
  author {
    bigint       seq                 PK  "auto"
    varchar(191) name
    text         description             "? lazy"
    datetime(6)  created_ts              "=now"
    datetime(6)  updated_ts              "=now onupdate"
    tinyint      is_close                "=0 bool"
    tinyint      is_display              "=0 bool"
    datetime(6)  display_start_dt        "?"
    datetime(6)  display_end_dt          "?"
    int          reader_count            "=0"
    varchar(191) photo_url               "?"
    varchar(255) aes_hex_email           "? aes,hex"
    varbinary(16) ip                     "ip"
    varchar(36)  uuid                UK  "?"
    bigint       user_seq            FK
    bigint       updated_user_seq    FK  "?"
    bigint       service_seq         FK
    bigint       game_group_seq      FK
    int          game_group_number       "=1"
  }
  author_item {
    bigint  seq          PK "auto"
    bigint  author_seq   FK
    int     order_number    "=0"
    varchar(191) name
  }

  service       ||--o{ author        : service_seq
  user          ||--o{ author        : user_seq
  user          ||--o{ author        : "updated_user_seq (updater / updated_authors)"
  game_group    ||--o{ author        : game_group_seq
  author        ||--o{ author_item   : "author_seq (author / items)"

  %% unique   author (game_group_seq, game_group_number)
  %% index    author (service_seq, is_close)              ix_service
  %% fulltext author (name, description)
```

## 2. Rules

### 2.1 Column lines — `type name [PK|FK|UK] ["attributes"]`

Column lines follow Mermaid syntax; `PK`, `FK`, and `UK` are Mermaid keywords. Mark every primary-key column with `PK`; the declaration order is the composite-key order. A primary key may use any valid name and may contain several columns; `seq` is a naming convention for automatic keys.
Write the database type directly (`bigint`, `uuid`, `varchar(191)`, `datetime(6)`, `decimal(13_3)`, `enum(a_b)`, `jsontext`). The manifest normalizes it to types such as `i64`, `string`, and `datetime`; PostgreSQL DDL keeps a native `uuid`. `varchar` and `char` require a positive length.
- A `jsontext` column holds JSON as its exact text: `text` on PostgreSQL, `LONGTEXT` on MySQL, and TEXT on SQLite. The ordered-json codec keeps the member order, the duplicate keys as written, and an empty object apart from an empty array, so the value reads back identically on the three databases. Every client returns the ordered-json value of the column and writes that value's text unchanged ([value model](codec.md#value-model)). The type `json` is rejected; write `jsontext`. A `jsontext` column takes only the `json` or `jsons` stage.
- An encrypted JSON value is a blob column with the stages `json aes`, such as `longblob config "json aes"`, in an entity with a non-null integer `aes_key_version` column. The connection's AES key configuration supplies the keys ([encrypted JSON value](codec.md#encrypted-json-value)).
- An `enum(a_b)` column is `enum('a','b')` on MySQL and text on PostgreSQL and SQLite. `ormgen diff`, `validate`, and migration verification compare a PostgreSQL `enum` column with a live text column as equal, because the live schema holds no value list.
- Data that is filtered, sorted, or indexed inside the database is modeled as columns or a child table, never as a path into a `jsontext` column: the ORM has no JSON path conditions and no JSON indexes, and the native document types (MySQL `JSON`, PostgreSQL `jsonb`) normalize the document, so they cannot keep the stored text. A queryable document type would be a separate column type with its own condition and index syntax; it does not exist.

The quoted string is a space-separated attribute list. Without it the column is NOT NULL, has no default, and has no style.

A required column is NOT NULL, has no default, is not `auto`, and is not the `aes_key_version` column that the ORM writes with AES values. Every insert (`create()`, `creates()`, `duplication()` with `create()`, and `save()` without a primary key) sets every required column; otherwise the client fails with `IR_INVALID: required column <entity>.<column> is not set` before the statement runs, in all four clients and on MySQL, PostgreSQL, and SQLite. MySQL would otherwise store the first value of an omitted NOT NULL `enum` column.

| Attribute | Meaning |
|---|---|
| `?` | nullable |
| `=value` | default, such as `=0`, `='ko'`, `=now`, or `=null` |
| `onupdate` | updated to the current time on every update |
| `auto` | automatic key; the column must be a non-null signed primary key whose type normalizes to `i64`, otherwise schema build fails at the column's source line |
| `unsigned` | unsigned integer (written by import; optional by hand) |
| `bool` | expose a `tinyint` column as a boolean |
| `lazy` | excluded from the default column set; select it with `addColumn<Col>()`. Text and blob columns are lazy by default |
| `aes` `hex` `gz` `json` `jsons` `base64` `serialize` `ip` `yaml` | codec stages, applied in order on write and in reverse on read ([codecs](codec.md)); usually inferred from name prefixes such as `aes_hex_`, `gz_`, `json_`, and the column name `ip` |
| `-> table.column` | explicit foreign-key target when no relation line exists |

Column names follow the reserved-name rules of the [DSL](dsl.md#_9-reserved-names).

### 2.2 Relation lines — `parent ||--o{ child : "fk_column (child_name / parent_name)"`

| Notation | Meaning |
|---|---|
| `\|\|--o{` (1 : 0..N) | the child row has a foreign key to one parent row |
| `\|\|--\|\|`, `\|\|--o\|` (1 : 0..1) | one row on each side |
| `}o--o{` (N : M) | not supported; model the join table as an entity |

Relation lines declare foreign keys: generated DDL, import, and migration diff use them, and recursive delete uses their direction. Queries name their keys with `match<L>With<R>` and `join<L>With<R>`.

The label starts with the child foreign-key column. A composite relation lists the ordered foreign-key columns and names both sides: `(tenant_id, account_id) (account / memberships)`. The number of foreign-key columns equals the number of parent primary-key columns, matched by position. `(child / parent)` names are optional for a single-column relation; without them the child side removes `_seq` or `_id` from the column and the parent side pluralizes the child table name without the parent-table prefix. Name collisions are build errors.
A column may take part in more than one foreign key; every relation line keeps its own key pairs.

### 2.3 `%%` directives

Mermaid treats these lines as comments; only `ormgen` reads them.

```text
%% unique   <table> (<col>, …)                 # composite unique key; a single column uses UK on its line
%% index    <table> (<col>, …) [name]          # composite index or single-column index on a non-FK column
%% fulltext <table> (<col>, …)                 # full-text index used by fulltext<Col>With<Col> conditions
%% check    <table> <name> : <expression>      # database CHECK constraint; backtick columns are validated
%% timestamps <table> <created> <updated>      # timestamp columns (default: created_ts and updated_ts)
%% aes_version <table> <column>                # non-null integer key version written with AES values
%% soft_delete <table> <column>                # nullable datetime; reads exclude non-NULL rows
%% table_comment <table> "comment"
%% column_comment <table> <column> "comment"
%% rename_table <new_table> <old_table>        # migration rename
%% rename_column <table> <new_col> <old_col>   # migration rename
%% orm:table entity=<entity> name=<schema.table>
%% orm:foreign entity=<entity> columns=<col>[,<col>…] references=<schema.table>(<col>[,<col>…]) [name=<constraint>] [on_delete=<action>] [deferred=true]
%% orm:immutable entity=<entity>
%% orm:audit_log operation=<table>(<seq>, <uuid>) context=<setting> change=<table>(<operation_seq>, <operation>, <service>, <table_name>, <entity_key>, <old_value>, <new_value>)
%% orm:audit entity=<entity> mode=changes|operations [service=<column>] [redact=<column.path>[,<column.path>…]]
```

- `orm:table` is the only declaration of a qualified physical table. PostgreSQL treats the schema and the table as separate identifiers; SQLite maps `schema.table` to the physical name `schema__table`, including generated index names, so two schemas with the same table name do not collide.
- `orm:foreign` declares a physical foreign key to a table outside the manifest or with explicit constraint options. `deferred=true` creates a deferrable, initially deferred constraint on PostgreSQL and SQLite.
- `orm:table` on MySQL places the table in the database named by the schema; DDL creates that database first.
- `orm:immutable` creates database triggers that reject updates, deletes, and truncation of the entity's table. MySQL has no truncate trigger, so its guard rejects updates and deletes only.
- `orm:audit_log` names the operation table (its sequence and id columns), the transaction setting that carries the current operation id, and the change table with its seven columns in the order shown. Like the target of `orm:foreign`, the two tables may belong to another manifest installed on the same connection, so only their names and column counts are checked; a schema declares at most one audit log.
- `orm:audit` creates triggers on the entity's table that require an operation: a write fails with `audit operation context is required` when the setting is empty and `audit operation does not exist` when no operation row has that id. `mode=changes` also writes one change row per inserted, updated, or deleted row: the operation sequence, `INSERT`/`UPDATE`/`DELETE`, the `service` column value, the table name, the primary key as a JSON object, and the old and new row as JSON objects. An update records only the changed columns and writes no row when nothing changed. `redact` replaces each named JSON path with `{"redacted": true, "present": true}`; a redacted column must exist, must not be a key column, and a dotted path requires a column that can hold JSON. A column with the `aes` stage is always recorded as `{"redacted": true, "present": true}`, never as its plaintext or ciphertext. The `service` value keeps the audited column's type, so the change table's service column may be text or an integer; an entity without `service` records NULL. `mode=operations` records nothing. The audit log tables cannot be audited.
- The calling code sets the operation id with `utils().setLocal(<setting>, id)` inside the transaction. PostgreSQL reads the transaction setting, MySQL the user variable `` @`orm.<setting>` `` that `setLocal` sets and clears at the end of the transaction, and SQLite the `orm__context` table. On PostgreSQL a truncate also requires an operation; MySQL and SQLite have no truncate trigger.
- On MySQL with binary logging on (the default), the login that installs the manifest creates the triggers only when the server runs with `log_bin_trust_function_creators=ON` or the login has the `SUPER` privilege; otherwise installation fails with MySQL error 1419.
- JSON row values: PostgreSQL uses `to_jsonb`. MySQL and SQLite list the columns by name; binary values are written as `\x` and lowercase hex, SQLite reads valid JSON text in text columns as JSON, and MySQL writes points as WKT.
- The triggers carry a `-- orm:` comment with their directive, so `ormgen import`, `validate`, `migrate`, and `db:` sources read the directives back from the current schema. `ormgen diff` drops a changed trigger before the table changes and creates it after them, and creates the triggers of a rebuilt SQLite table again.
- Rename directives are migration metadata. `ormgen diff` never infers a rename from similar names; keep the directive in later schema versions. Missing, duplicate, self-referencing, and ambiguous rename sources fail validation.
- Table and column comments are schema data. `ormgen ddl` writes MySQL comments, PostgreSQL `COMMENT ON` statements, and SQLite rows in `orm_schema_comments`; `ormgen import` reads them back. A changed comment changes the schema hash.

### 2.4 Defaults

- `bigint seq PK "auto"` is the conventional automatic key. Other key names and composite keys are valid.
- `created_ts` and `updated_ts` are timestamp columns by name.
- `is_*` tinyint columns are booleans without `bool`.
- Text, blob, and styled columns are lazy, except `aes_hex_*`.
- Commas are invalid in Mermaid type strings; write `decimal(13_3)` and `enum(a_b_c)`. [Dialects](dialects.md) maps the normalized types to DDL.

### 2.5 What the diagram stores

| Element | Location |
|---|---|
| tables, columns, types, keys, relations | Mermaid syntax |
| nullability, defaults, automatic keys, update time, lazy, styles, explicit targets | column attribute string |
| composite keys, index order, full-text indexes, timestamps, soft delete, checks, comments, renames | `%%` directives |
| foreign-key delete actions | `cascade` or `setnull` in the relation label (RESTRICT by default) |
| dialect differences | not stored; `ormgen ddl --dialect mysql\|postgres\|sqlite` renders each dialect |
| partitions, collation and engine options, views, functions, sequences, extensions | not supported; write them in migration SQL |

## 3. Manifest

```json
{
  "schema_hash": "…",
  "entities": {
    "author": {
      "table": "author", "pk": ["seq"], "auto": "seq",
      "columns": [{"name": "seq", "type": "i64", "pk": true, "auto": true}, {"name": "description", "type": "text", "nullable": true, "lazy": true}],
      "relations": {"service": {"kind": "one", "target": "service", "keys": [{"local": "service_seq", "target": "seq"}]}},
      "unique": [["uuid"], ["game_group_seq", "game_group_number"]],
      "indexes": {"ix_service": ["service_seq", "is_close"]},
      "fulltext": [["name", "description"]],
      "timestamps": {"created": "created_ts", "updated": "updated_ts"}
    }
  }
}
```

Commit the manifest and do not edit it. `ormgen validate` reports differences among the diagrams, the manifest, and a live database.

### 3.1 Namespaced extensions

The parser keeps `%% orm:<kind>` lines in `Manifest.ORM` and validates the kind, identifiers, key/value syntax, and duplicates. It does not interpret routes, permissions, public keys, or CRUD meaning; a higher-level generator owns those rules.

```text
%% orm:field product.company_seq relation=company fk=company.seq public=company.uuid required=true order=1
```

## 4. Commands

```sh
ormgen import   --dsn mysql://… --out schema/service.mmd        # database → Mermaid
ormgen build    schema/*.mmd --out schema/schema.json            # Mermaid → manifest, with validation
ormgen validate --dsn … --schema schema/schema.json              # manifest ↔ live database
ormgen ddl      --schema schema/schema.json --dialect mysql --out schema.sql   # manifest → CREATE statements
ormgen diff     --from old.json --to schema/schema.json --dialect postgres --out migration.sql
ormgen gen      --schema schema/schema.json --lang go --out model --scan ./...
```

`build` and `gen` with `--check` compare their output with the existing files, print `differs:`, `missing:`, or `extra:` with each path, write nothing, and exit with status 1 when a file differs ([usage](usage.md#_3-code-generation)).

Every `--dsn` and `db:` source is the client DSN URI (`mysql://`, `postgres://`, or `sqlite:///<absolute path>`), and the scheme selects the database. `ormgen import` and `ormgen validate` read MySQL, PostgreSQL, and SQLite.

`tests/schema/cases.json` records the manifest, the DDL of each dialect, the diff of each manifest pair, and the `ormgen plan` file of each pair for the Mermaid fixtures of the Go tests and the bench schema (`go run ./tests/schema/record`; `make schema-check` fails when it is stale). The schema tools of every language are compared with this file.

`ormgen gen --lang go` writes the Go models; it reads the packages named by `--scan` and generates the chain methods they call. PHP, TypeScript, and Rust generate their models with their own tools: `vendor/bin/orm-gen`, the `orm-gen` npm bin, and the `orm-build` crate ([usage](usage.md)).

The PHP tool runs the schema commands with the same flags and output: `vendor/bin/orm-gen build | import | validate | ddl | diff | migrate`. Its DSN is a `mysql://`, `postgres://`, or `sqlite://` URI, which selects the database.

The TypeScript tool does the same with `npx orm-gen build | import | validate | ddl | diff | migrate | plan | apply | verify | recover | rollback`: the flags, the written files, the plan files, and the migration history match the Go tool, and the DSN is a `mysql://`, `postgres://`, or `sqlite://` URI, which selects the database.

The Rust tool is the `orm-gen` binary of the `orm-build` crate, built with its `cli` feature (`cargo install --path clients/rust/orm-build --features cli`). It runs `orm-gen build | import | validate | ddl | diff | migrate | plan | apply | verify | recover | rollback` with the flags, written files, plan files, and migration history of the Go tool; the DSN is a URI. The library side needs no feature: `orm_build::schema::build_files` builds the manifest from `.mmd` files in `build.rs`, and `orm_build::ddl` renders DDL and migrations.

## 5. Validation

`ormgen build` fails on reserved column names, relation name collisions, missing child foreign-key columns, missing index columns, duplicate unique keys, and missing `-> table.column` targets. A foreign-key column without a relation line or target is a warning.

## 6. Import

`ormgen import --dsn … --out schema/example.mmd [--tables a,b]` reads the database catalog and writes the diagram. The output is deterministic (tables alphabetically, columns by position), so an unchanged database produces no diff.

- MySQL types come from `COLUMN_TYPE`: `unsigned` becomes an attribute, `is_*` tinyint columns become booleans, `decimal(13,3)` becomes `decimal(13_3)`, and `enum('a','b')` becomes `enum(a_b)`.
- Attributes include `?`, `=value` (`CURRENT_TIMESTAMP` becomes `=now`), `onupdate`, and `auto`.
- Relation lines use the foreign-key constraints of the catalog; without a constraint, a column named `<role>_<table>_seq` is matched to `<table>`.
- Indexes become `%% unique`, `%% fulltext`, and `%% index` directives, `UK` for single-column unique keys, and nothing for single foreign-key indexes, which are automatic.
- PostgreSQL (`postgres://` DSN) reads `information_schema.columns`, `pg_index`, and `pg_constraint`, normalizes types (`character varying(191)` → `varchar(191)`, `boolean` → `tinyint`, `numeric(p,s)` → `decimal(p_s)`, `timestamp(6) with time zone` → `datetime(6)`, `inet` → `varbinary(16)`, `json` and `jsonb` → `json`), maps identity columns to `auto`, and reconstructs generated full-text indexes. SQLite reads `PRAGMA table_info`, `index_list`, and `foreign_key_list`; an `INTEGER PRIMARY KEY AUTOINCREMENT` column becomes `auto`, and the clock default of the generated DDL becomes `=now`.
- SQLite reports an automatic rowid column as `INTEGER`, although that value is a signed 64-bit integer. Live import writes the column as `bigint PK "auto"`, which builds as a signed `i64` key; other SQLite `INTEGER` columns remain `int`.
- When `--out` exists, the importer keeps what the database cannot express: relation name overrides, `lazy`, `bool`, `int`, and explicit styles.

## 7. Client generation API

### Rust catalog connections

Tool cell decoding preserves actual SQL NULL and supported integer/text/boolean values, but rejects unsupported types, invalid UTF-8 and unsigned integers beyond signed 64-bit range. It must not substitute SQL NULL, replacement text or wrapped integers. These checks do not make the catalog tool a general query-result decoder.

Tool `Val::int()`, `opt_int()` and `bool()` return checked results. Required integer/boolean conversions reject SQL NULL. Optional integers preserve NULL as `None`. Booleans accept only native booleans, integer 0/1 and text `t`, `f`, `true`, `false`, `1`, `0`; malformed values never become defaults. Errors omit the input value and propagate through catalog and migration operations, including transaction cleanup.

The `live-db` feature exposes `orm_build::catalog::CatalogConnection::connect(dsn)`. The DSN selects the database without a driver argument. `dialect()`, `tables(only)` and `manifest()` reuse the CLI-owned catalog reader and logical conversion. Catalog connections preserve SQLite foreign-key settings instead of applying migration-rebuild settings.

SQLite catalog connections require an existing regular database file and disable automatic file creation. `close(self)` releases the reserved connection before closing its pool. Four owner cases verify invalid DSNs, missing SQLite file rejection, SQLite FK/content preservation and repeatable MySQL/PostgreSQL catalog reads; this evidence does not establish lossless physical import.

This extraction does not claim lossless physical import. The existing reader scopes PostgreSQL to the current schema and does not preserve every expression index or physical option. Native decoding limitations require owning corrections before arbitrary SQL/data access is enabled.

The `github.com/polyspec/orm/generator` package exposes generation to other programs. `generator.Generate` takes a manifest, the language `Go`, and an output directory. Go generation also takes `PackageName` (the directory name by default) and `Scan`, the package patterns whose calls are generated. Naming, field mapping, and output stay in the ORM generator.

## 8. Schema installation

`connection.utils().schema().install(manifestJson)` creates the missing tables, keys, indexes, comments, and triggers of the manifest on the connection's dialect, keeps existing tables, and registers the manifest with the connection. PostgreSQL and SQLite apply the statements in the active transaction of the connection or in a new one. MySQL commits each schema statement implicitly, so it applies them outside a transaction, and a call inside a transaction returns `CONFIG`. The manifest is the only input; callers do not pass SQL or select a dialect.
