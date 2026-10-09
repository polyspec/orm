<!-- doc-id: dbspec -->
# dbspec

[Korean](dbspec.ko.md)

dbspec is the schema language of this repository. One dbspec document defines the tables of one database or schema, the settings that give the ORM and the database their behavior, and the diagrams that show the tables. The same document renders to MySQL 8.4, PostgreSQL 17 and SQLite 3.46 or later with the same meaning, and introspection of any of them restores the same document.

The [schema definitions](dialects.md#schema-definitions) record decides which database features dbspec supports. A feature is supported only when one common definition exists for it, it renders with the same meaning on the three databases, and introspection restores the same definition without hidden markers. Everything else is rejected with a located error, never dropped or approximated.

## Document

```text
dbspec 1 shop

use core { users }

table orders {
  id i64 identity
  user_id i64
  status varchar(32) default 'pending'
  total decimal(13,2)
  coupon_code varchar(32) null
  placed_at datetime(6) default now
  primary key (id)
  unique uq_orders_coupon (coupon_code)
  index ix_orders_user (user_id)
  index ix_orders_status (status, placed_at desc)
  foreign key fk_orders_user (user_id) references users (id) on delete restrict on update restrict
  check ck_orders_total (total >= 0)
  settings {
    updated placed_at
    select explicit coupon_code
  }
}

diagram main {
  orders at 120 340
  users at 520 340
}
```

A document is UTF-8 text without a byte order mark. Lines end with LF or CRLF, both may appear in one document, and the last line may lack a line end; a bare CR is an `encoding` error. Parsing takes text: a tool that reads a file reports bytes that are not UTF-8 as an `encoding` error before parsing. Only the space character separates tokens; a tab is a `syntax` error. Its first line is the header `dbspec 1 <document>`: the language version and the document name; no blank or comment line comes before it. After the header, blank lines are allowed anywhere. A line whose first non-space character is `#` is a comment; a comment never changes the meaning and canonical emission keeps it in place (see [Canonical form](#canonical-form)).

After the header come `use` lines, then `table` blocks, then `diagram` blocks, in that order.

## Files

A dbspec document file has the extension `.dbs`. Its first line, the header `dbspec 1 <document>`, is the file signature: a tool that reads a document file checks that the file starts with the bytes `dbspec ` (`dbspec` and one space) before parsing it. A file of another format that uses the same extension, such as a DbSchema project file (XML), and an empty file are therefore told apart from a dbspec document without being parsed. A file that does not start with these bytes is one `signature` error at line 1, column 1 whose message names the file, `<path> is not a dbspec document`, and nothing else is reported for it; a byte order mark before the header also makes it a `signature` error, while text given to the parser with a byte order mark is an `encoding` error. A file that starts with these bytes is parsed, so a header that departs from `dbspec 1 <document>` after them, such as `dbspec 2 shop`, is a `header` error. A file that starts with these bytes but is not UTF-8 is one `encoding` error at the line and column of its first invalid byte, `<path> is not valid UTF-8`, and is not parsed. Each client has one byte check, which takes the bytes of a file and the name that its messages use and gives these diagnostics or the text: Go `dbspec.ReadBytes`, PHP `Dbspec::readBytes`, TypeScript `readDbspecBytes` and Rust `dbspec::read_bytes`; a tool that must read files under its own rules, for example without following symbolic links, reads the bytes once and passes them with the name it shows. Each client also has one file reader, which reads the file at a path and gives its bytes to the byte check with the path as name, and every other tool that reads a document file uses it: Go `dbspec.ReadFile`, PHP `Dbspec::readFile`, TypeScript `readDbspecFile` and Rust `dbspec::read_file`. A file that cannot be read is the read error of the platform, not a diagnostic.

## Names

Every name of a document, table, column, index, key, foreign key, check, setting target and diagram matches `[a-z][a-z0-9_]*` and has at most 63 bytes. A longer name is an error; it is never shortened. Upper case is an error, so every database's case folding gives the same name.

The words `dbspec`, `use`, `table`, `diagram`, `primary`, `unique`, `index`, `foreign`, `check`, `settings`, `null`, `identity`, `default`, `true`, `false`, `and`, `or`, `not`, `in`, `between` and `is` are reserved and are not valid names; the last six read as check predicate keywords.

Index, unique key, foreign key and check names are unique in the whole schema, across all four kinds, against every table name, and across this document and every table and constraint of the documents it uses directly, because MySQL, PostgreSQL and SQLite scope these names differently and PostgreSQL keeps index and table names in one namespace. `primary` is not a valid name. Names are physical names: the renderer writes them unchanged and adds no prefix or suffix. The renderer also writes names of its own ([rendered statements](dialects.md#rendered-statements)): `<table>$<column>` for the type CHECK of every column other than a `text`, a `bytes` or the identity column, `<table>$immutable_update` and `<table>$immutable_delete` for `immutable`, and `<table>$audit_insert`, `<table>$audit_update` and `<table>$audit_delete` for `audit`. A dbspec name never contains `$`, so these never meet a declared name. Each of them has at most 63 bytes; a longer one is a `name.length` error at the column name or at the setting keyword.

## Documents and `use`

`use <document> { <table>, ... }` makes tables of another document available as foreign key targets. The other document is found by its name in the declared document set that the tool receives (a configuration file or command arguments list each document file of the set); a document never names a file path. A used table is not rendered by this document; a diagram may place it. A used document is itself parsed and validated with its own `use` lines. Using a table that the named document does not define, a document that is not in the set, the document itself, or a document whose header name differs from the used name, and any use cycle, are `use` errors; a used document that fails reports one `use` error at its name with its first error in the message. A document or table repeated in `use` lines, and a table named like a used table, are `name.duplicate` errors. `use` lines are sorted by document name; the tables inside one line keep their written order.

## Tables

`table <name> { ... }` holds column lines, then key, index, foreign key and check lines in any order among themselves, then at most one `settings` block. A column line after a constraint line, a constraint line after `settings`, or a second `settings` block is an `order` error. A block that the document leaves open is a `syntax` error at its `{`. A table has at least one column and exactly one primary key, and at most 1000 columns.

### Columns

`<name> <type> [null] [identity] [default <value>]`

- Columns are NOT NULL unless the line says `null`. Primary key columns cannot be `null`.
- `identity` makes the column the automatic key: it must be the only primary key column and its type `i64`. The database generates a key when the insert omits it; clients reject an explicit value. A table has at most one identity column.
- The modifiers come in this order: `null`, `identity`, `default`. A `null` column without a default reads as SQL NULL when an insert omits it; `default null` is a `column` error.
- `default <value>` gives a literal of the column's type, or `now` for a `datetime(p)` column, which writes the UTC statement time. `null` and `default` cannot be combined with `identity`. A `text` or `bytes` column has no default. A decimal default with more fraction digits than the scale is a `column` error, even when the extra digits are zeros; fewer digits are padded in canonical form.

### Types

| dbspec | Values | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- | --- |
| `i16` | −32768 to 32767 | `SMALLINT` | `smallint` | `smallint` + range CHECK |
| `i32` | −2147483648 to 2147483647 | `INT` | `integer` | `integer` + range CHECK |
| `i64` | signed 64-bit | `BIGINT` | `bigint` | `bigint` + type CHECK |
| `bool` | `true`, `false` | `tinyint(1)` + `(0,1)` CHECK | `boolean` | `BOOLEAN` + `(0,1)` CHECK |
| `decimal(p,s)` | 1 ≤ p ≤ 18, 0 ≤ s ≤ p | `DECIMAL(p,s)` | `numeric(p,s)` | `DECIMALINT(p,s)` + range CHECK (value × 10^s) |
| `f64` | finite doubles | `DOUBLE` | `double precision` | `REAL` |
| `varchar(n)` | 1 ≤ n ≤ 16383 characters, no U+0000 | `varchar(n)` | `varchar(n)` | `varchar(n)` + length CHECK |
| `text` | any length, no U+0000 | `LONGTEXT` | `text` | `TEXT` |
| `bytes` | any length | `LONGBLOB` | `bytea` | `BLOB` |
| `uuid` | lower-case canonical text | `char(36)` ascii_bin + pattern CHECK | `uuid` | `TEXT` + pattern CHECK |
| `date` | 0001-01-01 to 9999-12-31 | `DATE` | `date` | `DATE` + CHECK |
| `time(p)` | time of day below 24:00:00, 0 ≤ p ≤ 6 | `TIME(p)` + day CHECK | `time(p)` + day CHECK | `TIME` + CHECK |
| `datetime(p)` | local date-time, 0 ≤ p ≤ 6 | `DATETIME(p)` | `timestamp(p)` | `DATETIME` + CHECK |

Every character column uses one binary collation: MySQL `utf8mb4_0900_bin`, PostgreSQL `COLLATE "C"`, SQLite `BINARY`. Every connection reads and writes `datetime` in UTC. SQLite tables are not STRICT, and every SQLite connection enables `foreign_keys`. The exact CHECK texts belong to the renderer version and are listed in [dialects](dialects.md#schema-definitions).

Not supported: 8-bit and 24-bit integers, unsigned types, `f32`, `char(n)`, `binary(n)`, `varbinary(n)`, native enums (use `varchar(n)` with an `in` check), native JSON (use `text` with the `ordered_json` codec), time zone instants, generated columns, and expression defaults other than `now`.

### Keys and indexes

- `primary key (<column>, ...)`: exactly one per table, unnamed.
- `unique <name> (<column>, ...)`: NULLs are distinct.
- `index <name> (<column> [asc|desc], ...)`: ascending is the default and is not written in canonical form.

A key or index lists 1 to 16 distinct columns of its table. A `text` or `bytes` column cannot be part of one. The declared lengths of the `varchar` columns of one primary key, unique key or index total at most 640. Prefix, partial, expression and full-text indexes are not supported.

### Foreign keys

`foreign key <name> (<column>, ...) references <table> (<column>, ...) [on delete <action>] [on update <action>]`

- `<action>` is `restrict`, `cascade` or `set_null`; an omitted action is `restrict` and canonical form writes both actions.
- The referenced columns are exactly the columns of the referenced table's primary key or of one of its unique keys, in the key's column order.
- `on delete` comes before `on update` when both are written.
- Child column types equal the referenced column types.
- The table declares an index or key whose leading columns are the foreign key's columns.
- `set_null` requires every child column to be `null`.
- The target is a table of this document or a used table. `NO ACTION`, `SET DEFAULT`, deferrable constraints and `MATCH FULL` are not supported.

### Checks

`check <name> (<predicate>)`

A predicate is one of:

- `<operand> <comparison> <operand>` with `=`, `<>`, `<`, `<=`, `>` or `>=`, where at least one operand is a column;
- `<column> [not] in (<literal>, ...)`;
- `<column> is [not] null`;
- `<predicate> and <predicate>`, `<predicate> or <predicate>`, `(<predicate>)`, where `and` binds tighter than `or`.

An operand is a column of the same table or a literal. The three databases evaluate these predicates alike only when both sides have the same kind of value, so the types decide which operands meet. A literal that meets a column is a valid `default` literal of the column's type (a `text` column takes the `varchar` form), and canonical form writes it as that default, so `0` against `decimal(13,2)` is `0.00`. Two columns meet when:

| Column type | Other column |
| --- | --- |
| `i16`, `i32`, `i64` | another integer column |
| `decimal(p,s)` | a `decimal` column of the same scale s |
| `f64` | an `f64` column |
| `bool` | a `bool` column |
| `varchar(n)`, `text` | a `varchar` or `text` column |
| `uuid` | a `uuid` column |
| `date` | a `date` column |
| `time(p)` | a `time` column of the same p |
| `datetime(p)` | a `datetime` column of the same p |

A `bool` operand takes only `=`, `<>` and `in`.

A `bytes` column, arithmetic, functions and the `null` literal are not part of a predicate: integer division, overflow and the scaled SQLite decimal give different results on the three databases. A unary minus applies only to a number literal. A check cannot use a column of a foreign key with `cascade` or `set_null`, because MySQL rejects it (3823).

There is no `not` operator, no `between` and no `bool` column alone: MySQL writes `not` into the comparisons it negates and rejects a column alone, and PostgreSQL writes `between` as two comparisons, so introspection could not restore them ([dialects](dialects.md#check-constraints)). Write `a <= 3` for `not (a > 3)`, `a >= 1 and a <= 9` for `a between 1 and 9`, and `active = true` for `active`.

## Settings

`settings { ... }` holds one setting per line. A setting names the columns it applies to; a column's name never selects a behavior. `codec` repeats once per column, `navigation` once per foreign key and `blind_index` once per AES column; every other setting appears at most once, and a repeat is a `setting` error. An empty `settings {}` block has no meaning, and canonical form omits it; a comment inside it moves before the table's closing `}` with the indentation of the table's lines.

Codec stages run in the written order on write. The storage type follows the last stage: `hex`, `base64`, `ordered_json`, `yaml` and `serialize` produce text and need a `varchar` or `text` column; `aes`, `gz` and `ip` produce bytes and need a `bytes` column. `ordered_json` is the first stage when it appears. `aes_version` is required when a column uses `aes`, and an `aes_version` setting without such a column is a `setting` error. The `blind_index` index column is a `varchar(n)` with n ≥ 64 (a `bytes` column cannot be indexed), has the same nullability as the AES column, is not itself AES-encoded, and is the only column of a declared index or unique key.

| Setting | Meaning | Hash |
| --- | --- | --- |
| `entity <name>` | The model name that generated code uses for the table. Without it the model name is the table name | manifest |
| `updated <column>` | The executor assigns the UTC statement time to the `datetime` column on every `UPDATE` it plans. Nothing is rendered in the database; raw SQL is not stamped | manifest |
| `soft_delete <column>` | Reads exclude rows whose nullable `datetime` column is not null; delete sets it to the UTC statement time, and `restore` clears it for the one row that a primary key or unique key value names ([restore](protocol.md#_1-5-restore)) | manifest |
| `select explicit <column> ...` | The columns are left out of the default select set; reading one that was not selected fails with `COLUMN_UNSELECTED` | manifest |
| `codec <column> <stage> ...` | The value is encoded by the stages in order on write and decoded in reverse on read: `ordered_json`, `aes`, `hex`, `gz`, `base64`, `serialize`, `yaml`, `ip` ([codecs](codec.md)) | manifest |
| `aes_version <column>` | The non-null integer column that stores the AES key version of the row; required when a column uses `aes` | manifest |
| `blind_index <aes column> <index column>` | The executor writes an HMAC of the AES column's plaintext to the indexed column and uses it for equality conditions | manifest |
| `navigation <foreign key> <child name> <parent name>` | The relation names that tools show for the foreign key, from the child and from the parent; generated code joins through its match methods and does not read them | manifest |
| `state_machine <column> <from> -> <to> [require (<column>, ...)]`, `state_machine <column> terminal <state> [require (<column>, ...)]` | The row state machine of one non-null varchar or text column: each line is one transition or one terminal state, in any mix and order, on one column per table; `require` names the columns a transition or a terminal records, and a transition that leaves a terminal state is rejected. The database does not enforce the machine; the executor that owns the rows does | manifest |
| `immutable` | The database rejects `UPDATE` and `DELETE` of the table's rows with generated row triggers. `TRUNCATE` is not covered. Rejected on a child of a `cascade` or `set_null` foreign key | schema |
| `audit into <history table> column <column> references <table> action <history column> previous <history column> [exclude (<column>, ...) \| include (<column>, ...)]` | Generated row triggers copy the recorded columns of every `INSERT` and `UPDATE` into the history table; see [Audit](#audit) | schema |

`schemaHash` covers the tables' definitions and the settings marked schema; it changes exactly when the database must change. `manifestHash` covers the definitions and every setting; generated code checks it. Diagrams and comments belong to neither; [Manifest and hashes](#manifest-and-hashes) defines both.

### Audit

An audited table keeps the key of its audit record in its own audit column, and a history table keeps every version of its rows. An audit record is a row of a declared table, written once for each unit of work (a transaction) before its changes; every audited row that the unit of work inserts or updates refers to it. The trigger reads everything it records from the row it receives, `OLD` and `NEW`, so the three databases need no other channel between the executor and the trigger.

```text
table service {
  id i64 identity
  name varchar(191)
  audit_seq i64
  deleted_at datetime(6) null
  primary key (id)
  index ix_service_audit (audit_seq)
  foreign key fk_service_audit (audit_seq) references audit (seq) on delete restrict on update restrict
  settings {
    soft_delete deleted_at
    audit into service_history column audit_seq references audit action change previous previous_audit_seq
  }
}

table service_history {
  history_id i64 identity
  change varchar(8)
  previous_audit_seq i64 null
  id i64
  name varchar(191)
  audit_seq i64
  deleted_at datetime(6) null
  primary key (history_id)
  index ix_service_history_row (id)
}

table audit {
  seq i64 identity
  account_seq i64
  request_id varchar(64)
  action varchar(64) null
  primary key (seq)
}
```

- **Audit column.** `column <column>` names a non-null column of the audited table. The executor writes the key of the transaction's audit record into it on every `INSERT` and `UPDATE` of the table ([usage](usage.md#audited-writes)). `NEW.<column>` is the audit record of the change and `OLD.<column>` the audit record of the previous version.
- **Audit record table.** `references <table>` names a table of the document or a used table: another table than the audited and the history table, not audited itself, with a primary key of one column whose type is the audit column's type. The audited table declares the foreign key `(<column>) references <table> (<key>) on delete restrict on update restrict`, with the leading index that every foreign key needs, so the database rejects an audit column value that names no audit record and the deletion of an audit record that a row refers to; the foreign key is rendered and introspected like any other. An unknown table, the audited or the history table, an audited table, a key of another shape or type, and a missing foreign key are `setting` errors at the table name or the audit column.
- **Recorded columns.** Without a list the triggers record every column of the audited table. `exclude (<column>, ...)` records every column except the listed ones, and `include (<column>, ...)` records only the listed ones. The audit column is always recorded, so neither list names it. A setting has at most one list, and a listed column is a column of the audited table that appears once. Naming an unknown column, listing a column twice, writing both lists and listing the audit column are `setting` errors at the listed column or at the keyword of the second list. A column added to the table later is recorded under `exclude` and not under `include`.
- **History table.** `into <history table>` names a table of the document or a used table. It is another table than the audited one. It has an `i64 identity` primary key, the `action` column (a non-null `varchar(8)`), the `previous` column (nullable, the type of the audit column) and one column for every recorded column of the audited table, with the same name and type; it has no other column. A history table that lacks a copy of a recorded column, has a column of another type, or has any other column, an unrecorded column of the audited table included, is a `setting` error at the history table name, one for each mismatch. The history columns may be nullable. The history table is not audited itself.
- **Triggers.** An `AFTER INSERT` row trigger writes `action = 'insert'`, `previous = NULL` and the `NEW` value of every recorded column. An `AFTER UPDATE` row trigger writes `action = 'update'`, `previous = OLD.<audit column>` and the `NEW` value of every recorded column. A `BEFORE DELETE` row trigger rejects the delete. Values are copied column to column, so the history row is equal on the three databases; no row is serialized as JSON.
- **Schema text and introspection.** The database holds only the recorded columns, which the triggers list. The schema text therefore writes the setting with `exclude` and the columns that it does not record, in column order, or without a list when it records every column; `include (title)` and the `exclude` list of the other columns give the same `schemaHash`, and the manifest text keeps the list as written. Introspection reads the recorded columns from the `audit_insert` trigger, the audit record table from the foreign key of the audit column, and restores the setting in the schema text form; nothing else is stored in the database.
- **Encrypted values.** A value that needs encryption has a codec with the `aes` stage, and the executor encodes it before the write ([codecs](codec.md)), so the row holds the ciphertext and the triggers copy that ciphertext into the history table; the triggers never see a plaintext. Its history column has the same storage type. Exclude such a column to keep it out of the history.
- **Deleting.** The `BEFORE DELETE` trigger makes a physical `DELETE` fail. A table that declares `soft_delete` deletes with an `UPDATE` of the soft delete column, which the history records with its audit record, and a restore of a soft-deleted row is an `UPDATE` that the history records in the same way. `audit` does not require `soft_delete`: a schema setting is read back from the database and a manifest setting is not, so a schema setting never depends on a manifest setting.
- **Limits.** The setting is rejected on a child of a `cascade` or `set_null` foreign key, because MySQL triggers do not fire for rows changed by a foreign key action. `TRUNCATE` is not covered. Raw SQL must name an existing audit record in the audit column, which the foreign key checks; an `UPDATE` that does not write the column records the previous audit record again, and the executor always writes it. Creating the triggers on MySQL with binary logging needs `SUPER` or `log_bin_trust_function_creators=ON`, which apply checks first.

## Manifest and hashes

The declared document set is the only schema source. Generators, schema tools and schema installation read dbspec documents; no other manifest file exists.

The manifest and the [rendered statements](dialects.md#rendered-statements) take the parsed documents of one set. The set holds each document once and every document that its documents use. A document name that repeats is a `name.duplicate` diagnostic and a used document missing from the set is a `use` diagnostic, both at the header name (line 1, column 10) of the later or the using document, with the document named in the message; the documents are checked in name order, and the used names of a document in name order. A set with a diagnostic has no manifest and no statements.

- The **manifest text** of a document is its canonical emission with every comment and every diagram removed. The manifest text of a document set is the manifest texts of its owned documents in document name order, concatenated; each starts with its header and ends with a line end, so the concatenation is unambiguous.
- The **external text** is empty for a set without external documents. Otherwise it holds, for each external document in name order that has a used table, the manifest text of that document reduced to the tables that owned documents name in their `use` lines, in document order, each with its columns, its primary key and its unique keys and nothing else.
- The **schema text** is the canonical emission of one document named `schema` that holds every owned table of the set in table name order and one `use` line for each external document with a used table, its tables in name order, with every setting removed except `immutable` and `audit`, and an `audit` setting written with the `exclude` list of the columns it does not record, in column order, or without a list when it records every column ([Audit](#audit)); a `settings` block left empty is omitted, as in canonical form. Its only `use` lines name the [external documents](#external-documents) whose tables the owned tables use, and it has no comment or diagram, so it depends only on the tables: moving a table to another document, or renaming or splitting a document, keeps it, and so does introspecting the database the set renders.
- `manifestHash` is `sha256:` followed by the lower-case hexadecimal SHA-256 of the UTF-8 bytes of the manifest text followed by the external text; `schemaHash` is the same over the schema text.

Generated code carries the manifest text and the external text of the document set it was generated from and its `manifestHash`, and every request it sends carries that hash. A runtime builds its model from the embedded text once, when the process starts; the PHP generator writes that model as PHP arrays instead, so the opcode cache keeps it and no request parses the text. `schemaHash` identifies the database state that migration plans and their history record.

## External documents {#external-documents}

A document set owns the documents that its tool lists as its documents. A document of another set whose tables it uses is an **external document** of the set and is listed separately: Go `orm-gen gen --use <file.dbs>`, PHP `--use <file.dbs>`, TypeScript `--use <file.dbs>`, Rust `Builder::uses([<files.dbs>])`. Several sets can then share one database: each set creates and changes only its own tables, and the set that owns a table is the only one that renders it. An external document is parsed and validated with the set, so a foreign key or an `audit` setting of an owned table checks its target table there, but it is never rendered, installed, altered, compared or generated. An external document that no owned document reaches through `use` is a `use` error at its header name, as is a used document that is neither owned nor external.

- **Hashes.** The manifest text holds the owned documents and the external text the used tables of the external documents, so `manifestHash` changes when a used table changes and stays when another table of an external document changes. The schema text holds the owned tables and names the used tables in its `use` lines.
- **Verification.** Installing the set and adding its tables and columns introspect the database ([dialects](dialects.md#introspection)) and require each used table with every column of its external definition, of the same type and `null`, its primary key and each of its unique keys; the database may hold more columns. A difference fails with `CONFIG` before any statement, naming each difference: `table <t> does not exist`, `column <t>.<c> does not exist`, `column <t>.<c> is <type>, not <type>`, `column <t>.<c> is null, not not null` (or the reverse), `table <t> has the primary key (<columns>), not (<columns>)` and `table <t> has no unique key (<columns>)`. Registering the set, also through the connect helper, reads nothing from the database ([schema](schema.md#_6-schema-registration)).
- **Installation.** Install creates the owned tables when none of them exists, changes nothing when all exist and fails with `CONFIG` when only some exist, and then requires the owned tables to equal the set; addTablesAndColumns compares and changes the owned tables only ([schema](schema.md#_4-schema-installation)).
- **Plans.** A plan changes a whole database ([plans](plans.md#apply)), so a plan whose target schema text has a `use` line is a `plan` error; a set with external documents is installed and upgraded with install and addTablesAndColumns.
- **Runtime.** The runtime model has no entity for an external table. The audit record table of an owned table may be an external table: a transaction with audit values inserts the record into it when the set that owns it is registered on the same connection ([Audit](#audit)).

## Runtime model

A client builds one runtime model from the document set, and generated code is produced from the same model:

- **Entities.** One entity per table of every document of the set, documents in name order and tables in document order. The entity name is the `entity` setting or the table name; generated type names are its snake_case segments with their first letters in upper case (`service_member` → `ServiceMember`).
- **Fields.** One field per column, named as the column, in column order, with the value type of the table below. A `null` column takes the language's absent value: Go a pointer (`[]byte` and styled values stay unwrapped), PHP `?T`, TypeScript `T | null`, Rust `Option<T>`.
- **Keys.** The primary key columns identify a row; the identity column is never written by an insert and its generated key is returned. An upsert conflicts on the primary key or a unique key, which the call names.
- **Default select set.** Every column except those of `select explicit`; reading a column that was not selected fails with `COLUMN_UNSELECTED`. No type or codec leaves a column out by itself.
- **Defaults.** An insert that omits a column with a default takes the database default; the executor does not fill it, except that on SQLite, whose clock has millisecond resolution, it binds the client clock for an omitted `default now` column ([protocol](protocol.md)). An insert that omits a non-null column without a default fails with `IR_INVALID` before reaching the database.
- **Codecs.** A column with a `codec` setting holds the value that the first stage encodes. When a stage is `ordered_json`, `serialize`, `yaml`, `gz` or `base64`, that is a styled value of the common value model ([codecs](codec.md)), which distinguishes SQL NULL from a stored null; when every stage is `aes`, `hex` or `ip`, it is a string (`ip` takes the address text).
- **Settings.** `updated` is assigned the UTC statement time on every `UPDATE` the executor plans; `soft_delete` filters reads and turns deletes into updates, and `restore` is the only call that matches a soft-deleted row; `aes_version` stores the key version of the row; `blind_index` writes the HMAC column and rewrites equality conditions on the AES column. For `audit`, a transaction with audit values inserts one audit record before its callback, from the values of the connection's audit source and its own values, and the executor writes the record's key into the audit column of every audited row it inserts or updates; an insert or update of an audited table without an audit fails with `CONFIG`. `immutable` has no runtime behavior: the database rejects the change. `navigation` has none either.
- **Relations.** Generated code joins two entities through the match methods of their columns, as before; a joined result is reached under the alias the call gives or under `<entity>_model` and `<entity>_models`.
- **Connection.** A raw connection takes the DSN URI and its configuration and registers no set; it never takes a schema path. Generated code carries the manifest text and `manifestHash`, and its connect helper opens a connection and registers that set on it; `utils().schema().register(schema)` registers a set on an open connection and `install` registers the set it installs. Registering reads nothing from the database. A set registered by its schema value has its runtime model from its manifest text and external text, so it needs no loaded generated code; PHP uses the arrays of the generated classes once their bootstrap has run. A request carries `manifestHash` and runs only on a connection where its set is registered ([protocol](protocol.md)).

| dbspec | Go | PHP | TypeScript | Rust |
| --- | --- | --- | --- | --- |
| `i16` | `int16` | `int` | `number` | `i16` |
| `i32` | `int32` | `int` | `number` | `i32` |
| `i64` | `int64` | `int` | `number` (a safe integer) | `i64` |
| `bool` | `bool` | `bool` | `boolean` | `bool` |
| `decimal(p,s)` | `string` with exactly s fraction digits | `string` | `string` | `String` |
| `f64` | `float64` | `float` | `number` | `f64` |
| `varchar(n)`, `text`, `uuid` | `string` | `string` | `string` | `String` |
| `bytes` | `[]byte` | `string` | `Uint8Array` | `Vec<u8>` |
| `date` | `time.Time` | `\DateTimeImmutable` | `string` `YYYY-MM-DD` | `NaiveDate` |
| `time(p)` | `string` `HH:MM:SS` with p fraction digits | `string` | `string` | `String` |
| `datetime(p)` | `time.Time` in UTC | `\DateTimeImmutable` in UTC | `string` `YYYY-MM-DD HH:MM:SS` with p fraction digits | `NaiveDateTime` |

## Diagrams

`diagram <name> { <table> at <x> <y> ... }` places tables for a view. Coordinates are integers from −2147483648 to 2147483647 in diagram units; a table appears in a diagram at most once, and a diagram may leave tables out. Diagrams change no hash and no rendering. A document may hold several diagrams.

## Canonical form

Emission writes a parsed document in one canonical text, so `emit(parse(s)) == s` for canonical input and `emit(parse(emit(d))) == emit(d)` for any valid input:

- two-space indentation, one space between tokens, LF line ends, one final newline;
- the header, a blank line, the `use` lines sorted by document name, a blank line before each block;
- within a table: columns in declared order, `primary key`, then `unique`, `index`, `foreign key` and `check` lines each sorted by name, then `settings` with its lines in the order of the table above (`codec`, `blind_index` and `navigation` lines sorted by column or key name);
- defaults and actions written in full (`on delete restrict on update restrict`), `asc` omitted;
- literals in one form: integers without a sign for zero or leading zeros, decimals with exactly the column scale (`0.00` for `decimal(13,2)`), strings in single quotes with `''` for a quote, `true` and `false`, `date` as `'YYYY-MM-DD'`, `time(p)` and `datetime(p)` with exactly p fraction digits (`'2026-01-01 00:00:00.000000'` for `datetime(6)`), `uuid` in lower case;
- tables and diagrams in document order; diagram lines in document order;
- `select explicit` columns, the columns of an `audit` `exclude` or `include` list and the tables of a `use` line in their written order, a list written as `exclude (a, b)`;
- `f64` literals as the shortest decimal without exponent that reads back as the same value, without a point for an integral value, and `0` for negative zero; a check literal takes the canonical default form of the column it meets, and a predicate keeps only the parentheses that an `or` inside an `and` needs;
- a comment line stays attached to the line that follows it and takes that line's indentation; a comment before a closing `}` takes the indentation of the block's lines; comments after the last block follow one blank line; a comment keeps its text from `#` to the line end unchanged.

## Limits and errors

A document has at most 32 MiB, 4096 tables, 120000 columns and 20000 foreign keys; the check happens before allocation. An error is `SCHEMA_INVALID` with the 1-based line and column of the offending token, the rule below and a message. Columns count Unicode code points. A stopping error (`encoding`, `header`, `limit`) is reported after the diagnostics found before it. Diagnostics are ordered by line, then column, then the order of the rule table below. A header name that does not match the name rule is `name.format` and parsing continues. A rule about a whole table, constraint or setting points at its name or keyword token; any other rule points at the token that breaks it:

- foreign key: the index, `set_null`, type, arity and key-target rules at the constraint name; an unknown column or target at that token;
- key: the 16-column and 640-character limits at the key name, or at `primary`;
- setting: whole-setting and companion rules at the setting keyword, column type rules at the column, the history table shape at the history table name;
- a table without columns reports `column` and `key` at the table name; `null identity` reports `column` at `identity` and `key` at the primary key;
- a used document that fails reports one `use` diagnostic at its name with its first error in the message; two used documents that repeat a constraint name report `name.duplicate` at the later document name; a document or table repeated in `use` lines is `name.duplicate`; a use cycle or a header name that differs from the used name is `use`;
- a `header` error points at the first character where the line departs from `dbspec 1 <name>`, `<name>` being a run of ASCII letters, digits and `_`, or one past the line end when a part is missing;
- the 32 MiB limit points at line 1, column 1; a table with more than 1000 columns is a `limit` error at its 1001st column name;
- check: a predicate is read first. Reading reports, at the token, an arithmetic operator, a function, a `null` literal or any other token outside the predicate forms, a literal where the forms need a column: the subject of `in` or `is` and the first literal of a comparison of two literals, and an operand that no comparison, `in` or `is` follows: at the operand when `and`, `or`, `)` or the end follows it, and at the following token otherwise. A predicate with a reading diagnostic is not checked further. A predicate that reads completely then has its columns and types checked, and the first of these diagnostics in source order is reported: an unknown column, a column of a `cascade` or `set_null` foreign key and a `bytes` column at the column; a column that does not meet the other column of its comparison at the later column; a literal that is not a default of the column it meets at the literal; `<`, `<=`, `>` or `>=` with a `bool` operand, column or `true` or `false`, at the operator;
- a line has at most one `syntax` diagnostic; a check expression reports only its first diagnostic; a malformed name in a reference reports `name.format` and is not resolved further; a reference to a column or table whose own line failed reports nothing more; a failed line keeps the kind that its first word gives and the name it would declare, reading a tab as a space only to learn them; a failed key or index line therefore still declares a key or index whose columns are unknown, so no rule that depends on them is reported: a failed `primary key` line hides the missing primary key and the identity rule of its table, and a failed `primary key`, `unique` or `index` line hides the leading-index rule of its table's foreign keys and the key-target rule of foreign keys that reference its table;
- a header that is not the first line, including a comment or blank line before it, and a header line that is not exactly `dbspec`, a space, `1`, a space and a name (for example one with a tab) is a `header` error. Parsing reports every error of a document in source order, not only the first; an `encoding`, `header` or `limit` error stops parsing.

| Rule | Meaning |
| --- | --- |
| `signature` | A document file does not start with the bytes `dbspec ` ([Files](#files)); the byte check and the file reader report it before parsing |
| `header` | The first line is not `dbspec 1 <document>`, or the version is not 1 |
| `syntax` | A token is not allowed at its position |
| `order` | `use`, `table` and `diagram` are out of order, or a table line is out of order |
| `name.format` | A name does not match `[a-z][a-z0-9_]*` or is `primary` |
| `name.length` | A name is longer than 63 bytes |
| `name.duplicate` | A table, column, constraint, index or diagram name repeats in its scope |
| `type` | A type is unknown or its parameters are out of range |
| `column` | A column combines `null`, `identity` and `default` in a way the rules reject, or a default does not fit its type |
| `key` | A table has no primary key or more than one, a key column is nullable, or a key or index lists an unknown, repeated, `text` or `bytes` column, more than 16 columns, or more than 640 `varchar` characters |
| `foreign_key` | A foreign key target, column types, index, arity or `set_null` nullability breaks the rules |
| `check` | A check predicate uses something outside the predicate forms, an unknown column, operands whose types do not meet, a literal outside its column's type, or a column of a `cascade` or `set_null` foreign key |
| `setting` | A setting is unknown, repeats, names an unknown column, or its column type or companion settings are wrong |
| `use` | A used document is not in the declared set, or a used table is not defined there |
| `diagram` | A diagram names an unknown table, repeats a table, or has a coordinate that is not an integer |
| `limit` | A document exceeds a size or count limit |
| `encoding` | The text is not valid UTF-8, has a byte order mark, or has a bare CR; the bytes of a file that are not UTF-8 are reported by the byte check and the file reader before parsing |

## Naming changes from the Mermaid language

| Mermaid language | dbspec | Reason |
| --- | --- | --- |
| `auto` | `identity` | The SQL term for a generated key |
| `lazy` | `select explicit` | The column is left out of the default select; it is not loaded on access |
| `?` / `=v` / `=now` | `null` / `default v` / `default now` | Keywords that state their meaning |
| `onupdate` | `settings { updated <column> }` | An executor setting, not a database clause |
| `jsontext` | `text` + `codec <column> ordered_json` | Ordered JSON is a codec; the database stores text |
| name conventions (`is_*`, `created_ts`, `aes_hex_*`, `ip`, `_seq`) | settings | A column name never selects behavior |
| `rename_table`, `rename_column` | migration plans | A rename is a change, not a state |
| `orm:route`, `orm:permission` and other API directives | removed | Not a schema concern |
| `schema_hash` | `schemaHash`, `manifestHash` | Two different coverages |
| `ormgen`, `orm-gen` | one CLI name in every language | One tool, one name |

## Keep, move or remove

Every feature of the Mermaid language and its manifest:

| Feature | Decision |
| --- | --- |
| Entities, columns, PK, relations as FK constraints | Kept as tables, columns, primary keys and named foreign keys |
| Type vocabulary (`tinyint`, `int`, `bigint`, `varchar`, `decimal`, `datetime`, `uuid`, `jsontext`, `enum`, `point`, `unsigned`) | Replaced by the dbspec types; `tinyint`, `unsigned`, `enum`, `point` and native JSON are removed |
| `unique`, `index` directives | Kept as named lines; generated names are removed |
| `fulltext` | Removed (no neutral form) |
| `check` with MySQL rewriting and prefixes | Kept with the neutral expression set; rewriting and prefixes are removed |
| `timestamps` and name conventions | Replaced by `default now` and the `updated` setting |
| `soft_delete`, `aes_version`, `blind_index`, styles | Kept as settings |
| `lazy`, relation names | Kept as `select explicit` and `navigation` settings |
| `table_comment`, `column_comment` | Removed as physical objects; `#` comments stay in the document |
| `rename_*` | Moved to migration plans |
| `orm:table` schema-qualified names | Removed (one document is one database or schema) |
| `orm:foreign` | Replaced by `use` and foreign keys to used tables |
| `orm:immutable` | Kept as the `immutable` setting with row triggers |
| `orm:audit`, `orm:audit_log` | Replaced by the `audit` setting with an audit record table and history tables; the separate change tables, the context setting and the JSON row values are removed |
| `orm:field`, `route`, `scope`, `filter`, `operation`, `permission` and other pass-through directives | Removed |
| `-- orm:` trigger markers and `-- orm-schema-v1` SQL sources | Removed; restoration compares renderer output |
| PhysicalGraph records with dialect SQL text (`typeSql`, `predicateSql`, `expressionSql`, `collationSql`, `operatorClassSql`) and the annotated Markdown document | Removed; the dbspec model replaces them |

## PHP extension

The PHP extension `orm_dbspec` (`packages/orm-php-extension`) implements the dbspec surface of the PHP client in C, as an independent fifth implementation of the same interface. The namespace `Polyspec\Orm\Dbspec\Native` has every class of `Polyspec\Orm\Dbspec` that a dbspec call takes or returns: the document classes (`Document`, `UseLine`, `Table`, `Column`, `ColumnType`, `PrimaryKey`, `UniqueKey`, `Index`, `IndexColumn`, `ForeignKey`, `Check`, `Settings`, `Setting`, `Diagram`, `Placement`) with the same public mutable properties, and the result and value classes with the same readonly properties, each in the order of the PHP client, with the same constructors, methods and constants. `Polyspec\Orm\Dbspec\Native\Dbspec` has `readFile`, `readBytes`, `parse`, `emit`, `manifest`, `render`, `introspect`, `externalDifferences`, `parsePlan`, `emitPlan`, `chain`, `diff`, `compareSchemas`, `installedDifferences`, `addTablesAndColumnsSteps`, `planSteps`, `apply`, `recover`, `rollback`, `finalize`, `exportMermaid` and `importMermaid` with the arguments, results, diagnostic messages and exceptions of `Polyspec\Orm\Dbspec\Dbspec`, including the `ApplyEvent`s, `ApplyError`s and `ApplyCleanupError`s of the apply commands. `introspect` and the apply commands use the given `PDO` object by calling its methods (`query`, `prepare`, `exec`, `getAttribute`, and `execute`, `fetch`, `fetchAll`, `closeCursor`, `errorCode` and `errorInfo` of its statements), as the PHP client does, so a `PDO` subclass sees the same calls; the apply commands call the clock and event closures and format the clock with `DateTimeImmutable` as the PHP client does. A document that PHP code built or changed is given to these methods like a document of the PHP client. PHP code selects the extension by that namespace; nothing switches between the PHP client and the extension, and a document of one given to the other is a `TypeError`.

The extension is built with `phpize` for the PHP whose `phpize` and `php-config` are on `PATH`; `packages/orm-php-extension/composer.json` declares it as a PIE package whose build path is `src`:

```sh
cd packages/orm-php-extension/src && phpize && ./configure && make
php -d extension=packages/orm-php-extension/src/modules/orm_dbspec.so your-script.php
```

Its declarations are in `packages/orm-php-extension/stubs/orm_dbspec.stub.php`, which the interface check reads (`extensions` of `contracts/interfaces.json`); `gen_stub.php` of the PHP installation writes `src/orm_dbspec_arginfo.h` from it (`make php-extension-arginfo`), and `src/orm_dbspec.c` registers the array constants, which `gen_stub.php` cannot write. `make dbspec-php-extension-check` checks that the header is generated from the stub, builds the extension into its run directory, and checks that the loaded extension declares exactly what the stub declares and that it gives the results, messages and exceptions of the PHP client on the shared document, statement, plan and Mermaid vectors, on changed documents and on introspections of in-memory SQLite databases and failing catalog queries, and on apply, recover, rollback and finalize scripts on SQLite files, and that its public classes declare what the PHP client's public dbspec classes declare; `make dbspec-compare-check`, `make dbspec-introspect-compare-check` and `make dbspec-apply-pairs-check` run it as the fifth runner, and `make dbspec-introspect-php-extension-check` and `make dbspec-apply-php-extension-check` run the introspection and apply tests of the PHP client on MySQL, PostgreSQL and SQLite.

## Verification

Shared vectors live in `tests/dbspec/`: canonical documents with their emission, non-canonical documents with their canonical emission, and invalid documents with every expected diagnostic, and document files under `tests/dbspec/files/`: a DbSchema project file (XML) and an empty file, which every client rejects with the `signature` error, a file with a byte that is not UTF-8, which it rejects with the `encoding` error, and a `.dbs` document, which it reads unchanged; each client reads every file through its file reader and through its byte check, and `make dbspec-compare-check` compares both results of the four clients and of the PHP extension. Every client and the extension parse and emit them identically. The 2000-table, 60000-column, 10000-foreign-key case is a performance measurement, and a measurement never fails a test (AGENTS.md). Each client's stress test parses the case five times and prints the CPU and wall-clock time of each parse; the shortest, median and longest CPU time; the median CPU time of a reference work, one pass over the same document computing h = h·31 + b (mod 2^32), timed by the same clock in the same process; the ratio of the median parse to it; and the machine. When the ratio exceeds the client's reference value, the test prints a warning, a `WARNING` line with the measurement, the reference and the machine, which the check runner keeps in the run record and the summary and writes as a GitHub warning annotation; the test still passes. The reference ratios are 11 for the PHP client (within a 128 MiB memory limit), 34 for the Rust client (release mode), 63 for the Go client and 185 for the TypeScript client on Node. Each is 1.5 times the highest ratio measured on the CI runner (PHP 7.16, Rust 22.5, Go 41.7–43.0, TypeScript 122.5), so a warning marks a regression of about 50% or more, not normal variance. The CI runner (`.github/runner`) is the machine whose numbers count: its cores are alike, while Apple silicon has performance and efficiency cores and the core a process runs on changes both times, so macOS gave PHP ratios from 6.35 to 10.1 and Rust ratios from 17.3 to 24.0 across runs; there the measurements are only printed. A reference value is never raised to remove a warning; a change needs new CI evidence of the same kind. Each measurement is the CPU time of the thread that parses: the Rust main thread, the locked OS thread of the Go test, the Node main thread and the single-threaded PHP process. Wall-clock time on a shared machine includes the time other processes hold the processors, and the process CPU time of Go and Node includes garbage collector threads that run on other cores. `make bench` runs the four stress tests (`make dbspec-stress-bench`) and `make timing-check`, which runs the four stress tests, the Rust orm-schema vector tests and the PHP dbspec tests while their process group receives one tenth of wall-clock time, and requires every test to pass and print its measurements.
