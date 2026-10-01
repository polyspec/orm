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

## Names

Every name of a document, table, column, index, key, foreign key, check, setting target and diagram matches `[a-z][a-z0-9_]*` and has at most 63 bytes. A longer name is an error; it is never shortened. Upper case is an error, so every database's case folding gives the same name.

The words `dbspec`, `use`, `table`, `diagram`, `primary`, `unique`, `index`, `foreign`, `check`, `settings`, `null`, `identity`, `default`, `true` and `false` are reserved and are not valid names.

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
- `<column> [not] between <literal> and <literal>`;
- `<column> is [not] null`;
- a `bool` column alone, which holds when the column is true;
- `not <predicate>`, `<predicate> and <predicate>`, `<predicate> or <predicate>`, `(<predicate>)`.

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

## Settings

`settings { ... }` holds one setting per line. A setting names the columns it applies to; a column's name never selects a behavior. `codec` repeats once per column, `navigation` once per foreign key and `blind_index` once per AES column; every other setting appears at most once, and a repeat is a `setting` error. An empty `settings {}` block has no meaning, and canonical form omits it; a comment inside it moves before the table's closing `}` with the indentation of the table's lines.

Codec stages run in the written order on write. The storage type follows the last stage: `hex`, `base64`, `ordered_json`, `yaml` and `serialize` produce text and need a `varchar` or `text` column; `aes`, `gz` and `ip` produce bytes and need a `bytes` column. `ordered_json` is the first stage when it appears. `aes_version` is required when a column uses `aes`, and an `aes_version` setting without such a column is a `setting` error. The `blind_index` index column is a `varchar(n)` with n ≥ 64 (a `bytes` column cannot be indexed), has the same nullability as the AES column, is not itself AES-encoded, and is the only column of a declared index or unique key.

| Setting | Meaning | Hash |
| --- | --- | --- |
| `entity <name>` | The model name that generated code uses for the table. Without it the model name is the table name | manifest |
| `updated <column>` | The executor assigns the UTC statement time to the `datetime` column on every `UPDATE` it plans. Nothing is rendered in the database; raw SQL is not stamped | manifest |
| `soft_delete <column>` | Reads exclude rows whose nullable `datetime` column is not null; delete sets it to the UTC statement time | manifest |
| `select explicit <column> ...` | The columns are left out of the default select set; reading one that was not selected fails with `COLUMN_UNSELECTED` | manifest |
| `codec <column> <stage> ...` | The value is encoded by the stages in order on write and decoded in reverse on read: `ordered_json`, `aes`, `hex`, `gz`, `base64`, `serialize`, `yaml`, `ip` ([codecs](codec.md)) | manifest |
| `aes_version <column>` | The non-null integer column that stores the AES key version of the row; required when a column uses `aes` | manifest |
| `blind_index <aes column> <index column>` | The executor writes an HMAC of the AES column's plaintext to the indexed column and uses it for equality conditions | manifest |
| `navigation <foreign key> <child name> <parent name>` | The relation names that generated code uses for the foreign key, from the child and from the parent | manifest |
| `immutable` | The database rejects `UPDATE` and `DELETE` of the table's rows with generated row triggers. `TRUNCATE` is not covered. Rejected on a child of a `cascade` or `set_null` foreign key | schema |
| `audit into <history table> operation <column> action <history column> previous <history column>` | Generated row triggers copy every `INSERT` and `UPDATE` into the history table; see [Audit](#audit) | schema |

`schemaHash` covers the tables' definitions and the settings marked schema; it changes exactly when the database must change. `manifestHash` covers the definitions and every setting; generated code checks it. Diagrams and comments belong to neither; [Manifest and hashes](#manifest-and-hashes) defines both.

### Audit

An audited table keeps its own operation column, and a history table keeps every version of its rows. The trigger reads everything it records from the row it receives, `OLD` and `NEW`, so the three databases need no other channel between the executor and the trigger.

```text
table service {
  id i64 identity
  name varchar(191)
  operation_id i64
  deleted_at datetime(6) null
  primary key (id)
  index ix_service_operation (operation_id)
  settings {
    soft_delete deleted_at
    audit into service_history operation operation_id action change previous previous_operation_id
  }
}

table service_history {
  history_id i64 identity
  change varchar(8)
  previous_operation_id i64 null
  id i64
  name varchar(191)
  operation_id i64
  deleted_at datetime(6) null
  primary key (history_id)
  index ix_service_history_row (id)
}
```

- **Operation column.** `operation <column>` names a non-null `i64` or `uuid` column of the audited table. The executor writes the current operation's id into it on every `INSERT` and `UPDATE` of the table. `NEW.<column>` is the operation that makes the change and `OLD.<column>` the operation that made the previous version.
- **History table.** `into <history table>` names a table of the document or a used table. It is another table than the audited one. It has an `i64 identity` primary key, the `action` column (a non-null `varchar(8)`), the `previous` column (nullable, the type of the operation column) and one column for every column of the audited table, with the same name and type; it has no other column. The history columns may be nullable. The history table is not audited itself.
- **Triggers.** An `AFTER INSERT` row trigger writes `action = 'insert'`, `previous = NULL` and every `NEW` value. An `AFTER UPDATE` row trigger writes `action = 'update'`, `previous = OLD.<operation column>` and every `NEW` value. A `BEFORE DELETE` row trigger rejects the delete. Values are copied column to column, so the history row is equal on the three databases; no row is serialized as JSON.
- **Deleting.** An audited table requires a `soft_delete` setting: a delete is an `UPDATE` of the soft delete column, which the history records with its operation. A physical `DELETE` fails.
- **Limits.** The setting is rejected on a child of a `cascade` or `set_null` foreign key, because MySQL triggers do not fire for rows changed by a foreign key action. `TRUNCATE` is not covered. Raw SQL that does not write the operation column records the previous operation's id again; the executor is the only writer that sets it. Creating the triggers on MySQL with binary logging needs `SUPER` or `log_bin_trust_function_creators=ON`, which apply checks first.

## Manifest and hashes

The declared document set is the only schema source. Generators, schema tools and schema installation read dbspec documents; no other manifest file exists.

The manifest and the [rendered statements](dialects.md#rendered-statements) take the parsed documents of one set. The set holds each document once and every document that its documents use. A document name that repeats is a `name.duplicate` diagnostic and a used document missing from the set is a `use` diagnostic, both at the header name (line 1, column 10) of the later or the using document, with the document named in the message; the documents are checked in name order, and the used names of a document in name order. A set with a diagnostic has no manifest and no statements.

- The **manifest text** of a document is its canonical emission with every comment and every diagram removed. The manifest text of a document set is the manifest texts of its documents in document name order, concatenated; each starts with its header and ends with a line end, so the concatenation is unambiguous.
- The **schema text** is the manifest text with every setting removed except `immutable` and `audit`; a `settings` block left empty is omitted, as in canonical form.
- `manifestHash` is `sha256:` followed by the lower-case hexadecimal SHA-256 of the UTF-8 bytes of the manifest text; `schemaHash` is the same over the schema text.

Generated code carries the manifest text of the document set it was generated from and its `manifestHash`, and every request it sends carries that hash. A runtime builds its model from the embedded text once, when the process starts; the PHP generator writes that model as PHP arrays instead, so the opcode cache keeps it and no request parses the text. `schemaHash` identifies the database state that migration plans and their history record.

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
- `select explicit` columns and the tables of a `use` line in their written order;
- `f64` literals as the shortest decimal without exponent that reads back as the same value, without a point for an integral value, and `0` for negative zero; a check literal takes the canonical default form of the column it meets;
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
- check: a predicate is read first. Reading reports, at the token, an arithmetic operator, a function, a `null` literal or any other token outside the predicate forms, and a literal where the forms need a column: the subject of `in`, `between` or `is`, a literal alone, and the first literal of a comparison of two literals. A predicate with a reading diagnostic is not checked further. A predicate that reads completely then has its columns and types checked, and the first of these diagnostics in source order is reported: an unknown column, a column of a `cascade` or `set_null` foreign key and a `bytes` column at the column; a column that does not meet the other column of its comparison at the later column; a literal that is not a default of the column it meets at the literal; `<`, `<=`, `>`, `>=` or `between` with a `bool` operand at the operator; a column alone that is not `bool` at the column;
- a line has at most one `syntax` diagnostic; a check expression reports only its first diagnostic; a malformed name in a reference reports `name.format` and is not resolved further; a reference to a column or table whose own line failed reports nothing more; a failed line keeps the kind that its first word gives and the name it would declare, reading a tab as a space only to learn them; a failed key or index line therefore still declares a key or index whose columns are unknown, so no rule that depends on them is reported: a failed `primary key` line hides the missing primary key and the identity rule of its table, and a failed `primary key`, `unique` or `index` line hides the leading-index rule of its table's foreign keys and the key-target rule of foreign keys that reference its table;
- a header that is not the first line, including a comment or blank line before it, and a header line that is not exactly `dbspec`, a space, `1`, a space and a name (for example one with a tab) is a `header` error. Parsing reports every error of a document in source order, not only the first; an `encoding`, `header` or `limit` error stops parsing.

| Rule | Meaning |
| --- | --- |
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
| `encoding` | The text is not valid UTF-8, has a byte order mark, or has a bare CR |

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
| `orm:audit`, `orm:audit_log` | Replaced by the `audit` setting with history tables; the operation and change tables, the context setting and the JSON row values are removed |
| `orm:field`, `route`, `scope`, `filter`, `operation`, `permission` and other pass-through directives | Removed |
| `-- orm:` trigger markers and `-- orm-schema-v1` SQL sources | Removed; restoration compares renderer output |
| PhysicalGraph records with dialect SQL text (`typeSql`, `predicateSql`, `expressionSql`, `collationSql`, `operatorClassSql`) and the annotated Markdown document | Removed; the dbspec model replaces them |

## Verification

Shared vectors live in `tests/dbspec/`: canonical documents with their emission, non-canonical documents with their canonical emission, and invalid documents with every expected diagnostic. Every client parses and emits them identically. The parse budget of the 2000-table, 60000-column, 10000-foreign-key case is 300 ms in the Rust client in release mode; the Go client's budget is 100 ms, the TypeScript client's 250 ms on Node and the PHP client's 400 ms within a 128 MiB memory limit. Each client's stress test parses the case five times, prints the shortest, median and longest parse, and fails when the median exceeds its budget, so a parser that is slow fails and a single parse slowed by other load on the machine does not decide the result. The budgets were fixed from the first measurement of each implementation and are never raised.
