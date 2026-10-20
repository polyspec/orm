<!-- doc-id: dbspec -->
# dbspec

[Korean](dbspec.ko.md)

dbspec is the schema language of this repository. One dbspec document defines the tables of one database or schema, the settings that give the ORM and the database their behavior, and the diagrams that show the tables. The same document renders to MySQL 8.4, PostgreSQL 17 and SQLite 3.46 or later with the same meaning, and introspection of any of them restores the same document.

The [schema definitions](dialects.md#schema-definitions) record decides which database features dbspec supports. A feature is supported only when one common definition exists for it, it renders with the same meaning on the three databases, and introspection restores the same definition without hidden markers. Everything else is rejected with a located error, never dropped or approximated.

## Document

```dbs set=shop document=shop
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

The document `core` that it uses:

```dbs set=shop document=core
dbspec 1 core

table users {
  id i64 identity
  primary key (id)
}
```

A document is UTF-8 text without a byte order mark. Lines end with LF or CRLF, both may appear in one document, and the last line may lack a line end; a bare CR is an `encoding` error. Parsing takes text: a tool that reads a file reports bytes that are not UTF-8 as an `encoding` error before parsing. Only the space character separates tokens; a tab is a `syntax` error. A word is a run of ASCII letters, digits, `_` and `.` and of other characters that Go's `unicode.IsLetter` or `unicode.IsDigit` accepts (Unicode 17.0.0); any other character that is not a space, such as `€` or a combining mark, is a `syntax` error where it stands. Its first line is the header `dbspec 1 <document>`: the language version and the document name; no blank or comment line comes before it. After the header, blank lines are allowed anywhere. A line whose first non-space character is `#` is a comment; a comment never changes the meaning and canonical emission keeps it in place (see [Canonical form](#canonical-form)).

After the header come `use` lines, then `table` blocks, then `diagram` blocks, in that order.

## Files

A dbspec document file has the extension `.dbs`. Its first line, the header `dbspec 1 <document>`, is the file signature: a tool that reads a document file checks that the file starts with the bytes `dbspec ` (`dbspec` and one space) before parsing it. A file of another format that uses the same extension, such as a DbSchema project file (XML), and an empty file are therefore told apart from a dbspec document without being parsed. A file that does not start with these bytes is one `signature` error at line 1, column 1 whose message names the file, `<path> is not a dbspec document`, and nothing else is reported for it; a byte order mark before the header also makes it a `signature` error, while text given to the parser with a byte order mark is an `encoding` error. A file that starts with these bytes is parsed, so a header that departs from `dbspec 1 <document>` after them, such as `dbspec 2 shop`, is a `header` error. A file that starts with these bytes but is not UTF-8 is one `encoding` error at the line and column of its first invalid byte, `<path> is not valid UTF-8`, and is not parsed. Each client has one byte check, which takes the bytes of a file and the name that its messages use and gives these diagnostics or the text: Go `dbspec.ReadBytes`, PHP `Dbspec::readBytes`, TypeScript `readDbspecBytes`, Python `read_dbspec_bytes` and Rust `dbspec::read_bytes`; a tool that must read files under its own rules, for example without following symbolic links, reads the bytes once and passes them with the name it shows. Each client also has one file reader, which reads the file at a path and gives its bytes to the byte check with the path as name, and every other tool that reads a document file uses it: Go `dbspec.ReadFile`, PHP `Dbspec::readFile`, TypeScript `readDbspecFile`, Python `read_dbspec_file` and Rust `dbspec::read_file`. A file that cannot be read is the read error of the platform, not a diagnostic.

## Document sets {#document-sets}

A document set is declared once, in a set file named `dbspec-set.json`, and every tool that takes a set reads that file: the generators of every client and the editor tools ([editor](editor.md)). A set declared a second time, by command arguments or a list in code, drifts from the first, so no tool takes the documents of a set in any other form.

```json
{"schema": 1, "documents": ["shop.dbs", "billing/invoices.dbs"], "external": ["../core/core.dbs"]}
```

The file is one JSON object with the keys `schema`, `documents` and `external`. `schema` is the number 1. `documents` lists the document files that the set owns and is not empty; `external` lists its [external documents](#external-documents) and may be left out, which is the empty list. A path is relative to the directory of the set file, which is the root of the set; it is never relative to the working directory of a process. A path is written in one normal form so that every platform reads it alike:

- segments joined by `/`, the last ending in `.dbs`;
- each segment a non-empty run of characters other than `/`, `\`, `:`, `<`, `>`, `"`, `|`, `?`, `*`, NUL and U+0001 to U+001F, not `.`, not ending in `.` or a space, and not a segment whose part before its first `.`, with trailing spaces removed, is, ignoring ASCII case, `CON`, `PRN`, `AUX`, `NUL`, `COM0` to `COM9`, `LPT0` to `LPT9`, or `COM` or `LPT` followed by `¹`, `²` or `³`: the device names of Windows;
- a `documents` path has no `..` segment, so an owned document lies under the root; an `external` path may begin with `..` segments and has none after its first other segment.

An absolute path, a drive, a backslash, an empty segment and a trailing `/` therefore have no normal form, nor has a name that Windows cannot hold.

Each client has one set reader: Go `dbspec.ReadSet`, PHP `Dbspec::readSet`, TypeScript `readDbspecSet`, Python `read_dbspec_set` and Rust `dbspec::read_set`. TypeScript applies the rules that read no file (step 2, the normal form, and the name `dbspec-set.json` of the last segment of `path`) through the pure `parseSet(bytes, path)` of `@polyspec/orm/dbspec`, which takes the bytes as a `Uint8Array`, decodes them with `TextDecoder('utf-8', {fatal: true, ignoreBOM: true})` so that invalid UTF-8 and a byte order mark stay visible, and which `readDbspecSet` and the editor tools call. The reader takes the path of a set file and checks, in this order:

1. The set file. The prefix is the given path with its last segment removed, a segment ending at `/` or, on Windows, at `/` or `\`; it may be empty, `/`, `a/` or `C:`. The root is the prefix, or `.` when the prefix is empty. The last segment is `dbspec-set.json` and equals a name that the root lists (the comparison of step 3). The root, without its trailing separator (a root of `/` stays `/`), and the file are examined without following a symbolic link (`lstat`), since `lstat` of a path that ends in a separator follows a link on POSIX: neither is a symbolic link, the root is a directory and the file is a regular file. The reader opens the file once and reads it from that handle. The directories above the root belong to the caller and are not examined; a symbolic link among them is resolved by the platform.
2. The JSON, in this order: the bytes are valid UTF-8 with no byte order mark, checked before parsing; they hold one JSON object (RFC 8259) nested at most 64 levels deep, the object counting as one, in which no string escapes a lone surrogate and no key appears twice in any object, at any depth; the object has no key other than the three, an error naming every unknown key in code-point order; `schema` is a JSON number whose value, read as an IEEE 754 double as RFC 8259 advises for interoperability, is 1 (`1`, `1.0` and `1e0` are all 1), and any other number, one beyond the range of a double included, is not; `documents` is a non-empty array of strings; `external`, when present, is an array of strings, and `null` is not.
3. Each path, `documents` first and then `external`, in written order. First its normal form. Then its joined path: the prefix of step 1 followed by the written path unchanged. It is never cleaned, so the platform resolves each `..` from the root; because the root is not a symbolic link, `..` from it names the same directory whether the platform resolves it physically (POSIX) or lexically (Windows). Each prefix of the joined path that ends after a segment of the written path is examined with `lstat`: for `../core/core.dbs` these are `<root>/..`, `<root>/../core` and `<root>/../core/core.dbs`. Every prefix but the last is a directory and the last a regular file. None is a symbolic link, except that a prefix but the last of an `external` path may be one: the reader follows it (`stat`) and it must name a directory, and the platform resolves it as written. A symbolic link at the last prefix, and one at any prefix of a `documents` path, is an error. Each segment other than `..` equals a name that its directory lists: on POSIX the UTF-8 bytes of the segment equal the listed bytes (Node lists with `{encoding: 'buffer'}`), on Windows its UTF-16 code units equal the listed ones; a `..` segment is examined as a directory and its name is not compared. A spelling that only a case-folding file system, a short name or a name normalization resolves is therefore an error on every platform. On Windows a symbolic link is any reparse point whose tag is a name surrogate (`IsReparseTagNameSurrogate`): a symbolic link or a junction. Go, Rust, Python and the PHP extension read the tag and apply that rule to every name-surrogate tag, while Node's `lstat` (libuv) and PHP's `lstat` expose no reparse tag, only the symbolic link and junction tags as links, so the TypeScript and PHP readers detect those two; another name-surrogate tag (such as a WSL symbolic link) reads there as the entry itself, never its target, and Win32 refuses to open a tag that no file system filter handles, so the read fails instead of following it.
4. The read and the file identity. The reader opens each file that passed step 3 once, reads its bytes from that handle and takes its identity from the same handle: the device and inode of POSIX `fstat`, or on Windows the volume serial number and the 64-bit file index that the handle gives (Go `File.Stat` with `os.SameFile`, Node `fstat` with `bigint`, Python the low 64 bits of `os.fstat().st_ino`, PHP `fstat`, Rust `same_file::Handle::from_file`). A file system whose 64-bit file index is not unique, such as ReFS, is not supported, as a file system without symbolic links is not. Two paths whose files have the same identity, in one list or across both, are a `set.duplicate` error at the later path.

The reader reads a file tree that does not change while it runs. It examines each component once and does not detect a file or directory replaced between its examination and its open, so an open may then follow a symbolic link that appeared in between; a tree changed by another process during a read is outside what the reader decides, and a later read of the unchanged tree gives the result.

The first two steps stop at their first error, since nothing after them can be read, and report one error. Steps 3 and 4 report every path that breaks them, each with its first error; step 4 judges only the paths that passed step 3. The errors are listed by step, then by path, `documents` first and then `external`, in written order, and the later path of `set.duplicate` is the later in that order. In a tree that does not change while the reader runs, a symbolic link is never followed except a prefix but the last of an `external` path (step 3): one found at the set file, the root, a document file, or any prefix of a `documents` path is an error.

On success the reader returns `documents` and `external`, each a list in written order of the files with their joined path and their bytes. It does not check the bytes: the tool gives each file's bytes to the [byte check](#files) with that path, which reports `signature` and `encoding` for that file, and then parses the set ([Documents and `use`](#documents-and-use)). On failure it returns the errors, each with its rule, the path it concerns and a message that names the path and, for a failed read, the platform's error. The path is the set file's path for steps 1 and 2 and for `set.path`, whose message quotes the written path as JSON, and the joined path of the entry otherwise.

| Rule | Meaning |
| --- | --- |
| `set.file` | The set file is not named `dbspec-set.json`, or it or a listed file is missing, cannot be read or is not a regular file; the root or a component of a path is not a directory; or a segment is not a name that its directory lists |
| `set.symlink` | The set file, the root, the last component of a path or a prefix but the last of a `documents` path is a symbolic link |
| `set.json` | The set file is not UTF-8 without a byte order mark, is not one JSON object nested at most 64 levels deep, or escapes a lone surrogate |
| `set.schema` | `schema` is missing or is not a number whose value is 1 |
| `set.key` | A key other than `schema`, `documents` and `external`; a key that appears twice; `documents` missing; or `documents` or `external` not an array of strings |
| `set.empty` | `documents` is empty |
| `set.path` | A path has no normal form, a `documents` path has a `..` segment, or an `external` path has one after another segment |
| `set.duplicate` | A path names a file that an earlier path names |

A generator that gets a set file with an error, or a listed file with a diagnostic, exits with its error status, prints every error and diagnostic, and writes nothing. The shared vectors `tests/dbspec/set-files.json` hold each rule with accepting and rejecting cases as file trees (regular files, directories, symbolic links and hard links), which every client's set reader runs; TypeScript's `parseSet` also runs the cases that need no file tree. The file-tree cases need a file system with symbolic and hard links: on Windows, NTFS and the privilege to create symbolic links.

### Parsing a set {#parsing-a-set}

A tool parses the texts of a set with the set parse, never by keying the texts itself: Go `dbspec.ParseSet`, PHP `Dbspec::parseSet`, TypeScript `parseDbspecSet`, Python `parse_dbspec_set` and Rust `dbspec::parse_set`. It takes the owned texts and the external texts, each in set order, and returns one result per text in that order, owned first.

- The name of a document is the name that the parser reads from its header line; no tool reads it otherwise. A text has no name when its header fails (a `header` diagnostic) or when its parse stops before its header line is read: the 32 MiB `limit`, a byte order mark, or an `encoding` error in the header line. A defect after the header line leaves the name.
- A text whose name an earlier text has is not parsed; its result carries the one diagnostic `name.duplicate` at line 1, column 10, `document <name> appears twice in the document set`.
- Every other text is parsed with the texts of all other named documents of the set as the documents its `use` lines name, and its result carries its document, its [declaration positions](#declaration-positions) and its diagnostics, as one parse of that text returns them. An external text's document is marked external.

The shared vectors `tests/dbspec/set-parse.json` hold sets with their names, the duplicate and a failed header, and every client runs them.

## Names {#names}

Every name of a document, table, column, index, key, foreign key, check, setting target and diagram matches `[a-z][a-z0-9_]*` and has at most 63 bytes. A longer name is an error; it is never shortened. Upper case is an error, so every database's case folding gives the same name.

The words `dbspec`, `use`, `table`, `diagram`, `primary`, `unique`, `index`, `foreign`, `check`, `settings`, `null`, `identity`, `default`, `true`, `false`, `and`, `or`, `not`, `in`, `between` and `is` are reserved and are not valid names; the last six read as check predicate keywords.

Index, unique key, foreign key and check names are unique in the whole schema, across all four kinds, against every table name, and across this document and every table and constraint of the documents it uses directly, because MySQL, PostgreSQL and SQLite scope these names differently and PostgreSQL keeps index and table names in one namespace. `primary` is not a valid name. Names are physical names: the renderer writes them unchanged and adds no prefix or suffix. The renderer also writes names of its own ([rendered statements](dialects.md#rendered-statements)): `<table>$<column>` for the type CHECK of every column other than a `text`, a `bytes` or the identity column, `<table>$immutable_update` and `<table>$immutable_delete` for `immutable`, and `<table>$audit_insert`, `<table>$audit_update` and `<table>$audit_delete` for `audit`. A dbspec name never contains `$`, so these never meet a declared name. Every such renderer name is written by one rule, so it always fits in 63 bytes. Let the plain form be the name the renderer would write without a limit: `<table>$<suffix>`, where the suffix is the column name or the event name (`immutable_update`, `immutable_delete`, `audit_insert`, `audit_update`, `audit_delete`). When the plain form has at most 63 bytes, it is the name. Otherwise the name is the first 54 bytes of the plain form, a `$`, and the first 8 lowercase hexadecimal digits of the SHA-256 of the plain form's UTF-8 bytes: 54 + 1 + 8 = 63 bytes in all. Names are ASCII (`[a-z0-9_$]`), so bytes are characters and no code point is cut. Introspection maps a name read from a database back to its table and suffix by recomputing the name of every table and suffix of the document set and comparing; it never splits a name on `$`. The hash covers the whole plain form, and it separates only plain forms that share the same 54-byte prefix. A generated name is unique in the schema together with the declared names: a generated name equal to another generated name, or to a declared name, is a `name.duplicate` error at the later name that names both sources (the table and the column or the setting of each). Declared names never contain `$`, so only two generated names can meet, one as a plain form and one as a hashed form, or two hashed forms; every such collision is refused and never resolved silently. The renderer shortens only its own names this way; a declared name is never shortened, and a declared name longer than 63 bytes stays a `name.length` error.

## Documents and `use`

`use <document> { <table>, ... }` makes tables of another document available as foreign key targets. The other document is found by its name in the document set that the tool reads from its [set file](#document-sets); a document never names a file path. A used table is not rendered by this document; a diagram may place it. A used document is itself parsed and validated with its own `use` lines. Using a table that the named document does not define, a document that is not in the set, the document itself, or a document whose header name differs from the used name, and any use cycle, are `use` errors; a used document that fails reports one `use` error at its name with its first error in the message. A document or table repeated in `use` lines, and a table named like a used table, are `name.duplicate` errors. `use` lines are sorted by document name; the tables inside one line keep their written order.

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

Not supported: 8-bit and 24-bit integers, unsigned types, `f32`, `char(n)`, `binary(n)`, `varbinary(n)`, native enums (use `varchar(n)` with an `in` check), native JSON (use `text` with the `ordered_json` codec), time zone instants, generated columns, and expression defaults other than `now`. A column line takes only `name type [null] [identity] [default value]` (`packages/go/engine/dbspec/parse.go`), so no document produces a generated column. Introspection reports a column that has a generation expression as unsupported, with the reason of its type, and no client reads the expression text; the MySQL double encoding of a non-ASCII literal in `GENERATION_EXPRESSION` therefore reaches no client (see [dialects](dialects.md)).

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
| `bytes` | a `bytes` column |

Each implementation keeps this table once, and the IR validator reads it too, for the two columns of a column comparison, a subquery, a join and a relation ([protocol](protocol.md)), so the two cannot drift. A check refuses a `bytes` column before its types are compared, so the `bytes` row serves only a request. The conformance vector `column_pairs` runs pairs that meet and pairs that do not on the three databases.

A `bool` operand takes only `=`, `<>` and `in`.

A `bytes` column, arithmetic, functions and the `null` literal are not part of a predicate: integer division, overflow and the scaled SQLite decimal give different results on the three databases. A unary minus applies only to a number literal. A check cannot use a column of a foreign key with `cascade` or `set_null`, because MySQL rejects it (3823).

There is no `not` operator, no `between` and no `bool` column alone: MySQL writes `not` into the comparisons it negates and rejects a column alone, and PostgreSQL writes `between` as two comparisons, so introspection could not restore them ([dialects](dialects.md#check-constraints)). Write `a <= 3` for `not (a > 3)`, `a >= 1 and a <= 9` for `a between 1 and 9`, and `active = true` for `active`.

## Settings

`settings { ... }` holds one setting per line. A setting names the columns it applies to; a column's name never selects a behavior. `codec` repeats once per column, `navigation` once per foreign key, `blind_index` once per AES column, `markdown` once per column, `checkbox` once per state, and `state_machine` once per line identity: one `initial` line per state, one `terminal` line per state, one transition line per `<from> -> <to>` pair whatever its `require` list, one `history` line and one `limit` line per state; every other setting appears at most once, and a repeat is a `setting` error at the later line. A repeated line adds no meaning, and a repeated transition or terminal line with another `require` list contradicts the first. An empty `settings {}` block has no meaning, and canonical form omits it; a comment inside it moves before the table's closing `}` with the indentation of the table's lines.

Codec stages run in the written order on write. The storage type follows the last stage: `hex`, `base64`, `ordered_json`, `yaml` and `serialize` produce text and need a `varchar` or `text` column; `aes`, `gz` and `ip` produce bytes and need a `bytes` column. `ordered_json` is the first stage when it appears. `aes_version` is required when a column uses `aes`, and an `aes_version` setting without such a column is a `setting` error. The `blind_index` index column is a `varchar(n)` with n ≥ 64 (a `bytes` column cannot be indexed), has the same nullability as the AES column, is not itself AES-encoded, and is the only column of a declared index or unique key.

| Setting | Meaning | Hash |
| --- | --- | --- |
| `entity <name>` | The model name that generated code uses for the table. Without it the model name is the table name | manifest |
| `updated <column>` | The executor assigns the UTC statement time to the `datetime` column on every `UPDATE` it plans. Nothing is rendered in the database; raw SQL is not stamped | manifest |
| `soft_delete <column>` | Reads exclude rows whose nullable `datetime` column is not null, in the root, each join child (in its `ON` condition), each relation and each subquery; delete sets it to the UTC statement time, and `restore` clears it for the one row that a primary key or unique key value names ([restore](protocol.md#_1-5-restore)) | manifest |
| `select explicit <column> ...` | The columns are left out of the default select set; reading one that was not selected fails with `COLUMN_UNSELECTED` | manifest |
| `codec <column> <stage> ...` | The value is encoded by the stages in order on write and decoded in reverse on read: `ordered_json`, `aes`, `hex`, `gz`, `base64`, `serialize`, `yaml`, `ip` ([codecs](codec.md)) | manifest |
| `aes_version <column>` | The non-null integer column that stores the AES key version of the row; required when a column uses `aes` | manifest |
| `blind_index <aes column> <index column>` | The executor writes an HMAC of the AES column's plaintext to the indexed column and uses it for equality conditions | manifest |
| `navigation <foreign key> <child name> <parent name>` | The relation names that tools show for the foreign key, from the child and from the parent; generated code joins through its match methods and does not read them | manifest |
| `state_machine <column> <from> -> <to> [require (<column>, ...)]`, `state_machine <column> terminal <state> [require (<column>, ...)]` | The row state machine of one non-null varchar or text column: each line is one transition or one terminal state, in any mix and order, on one column per table; `require` names the columns a transition or a terminal records, and a transition that leaves a terminal state is rejected. The database does not enforce the machine; the executor that owns the rows does | manifest |
| `markdown <column>` | The column holds markdown prose; repeatable per column, on a varchar or text column of any nullability. The database renders nothing for it; the tools that own the documents read it | manifest |
| `store files`, `store document list\|table`, `store block <foreign key> list\|table` | The table's storage in a markdown corpus: `files` writes one file per row, `document` writes every row into one document, and `block` writes the rows inside the parent row that the named foreign key references; `list` or `table` is the shape. Exactly one per table | manifest |
| `store files shard <column> <period>`, `store document list\|table shard <column> <period>` | A time shard of the storage: the corpus keeps the rows of each period of the column apart, where the column is a non-null `date` or `datetime` column and the period is `year`, `month` or `day`. A `store block` table, a table with a self foreign key and a table with `order` reject it. SQL backends ignore it: nothing is rendered, and introspection does not restore it | manifest |
| `key_prefix '<p>'` | The executor allocates the varchar primary key as `<p><n + 1>`, where n is the largest decimal suffix among the keys of that form; the primary key is one varchar column | manifest |
| `title <column>`, `body <column>` | The row's title and body, each a non-null varchar or text column | manifest |
| `order <column>` | The row's position among its siblings, assigned by the executor: a non-null `i32` or `i64` column with no default, in no key, index or check | manifest |
| `checkbox <column> <state> '<glyph>'` | The list glyph of one state of the state machine's column. The lines cover the state set exactly, and each glyph is one character and distinct | manifest |
| `state_machine <column> initial <state>` | An initial state of the machine, repeatable. The states of the machine are the states that its initial, transition and terminal lines name; the default of the state column is an initial state, and an initial state is not terminal | manifest |
| `state_machine <column> history <table> row <foreign key column> from <column> to <column> at <column>` | The history table of the machine's transitions: the foreign key column refers to this table, `from` and `to` have the state column's type, `at` is `datetime(6)`, each required column has a nullable column of its type, and no column exists besides the key and these | manifest |
| `state_machine <column> limit <state> <count>` | At most `count` rows may be in the state; the count is a positive integer and the state belongs to the state set | manifest |
| `immutable` | The database rejects `UPDATE` and `DELETE` of the table's rows with generated row triggers. `TRUNCATE` is not covered. Rejected on a child of a `cascade` or `set_null` foreign key | schema |
| `audit into <history table> column <column> references <table> action <history column> previous <history column> [tables <table> (<record column>, <name column>)] [exclude (<column>, ...) \| include (<column>, ...)]` | Generated row triggers copy the recorded columns of every `INSERT` and `UPDATE` into the history table and, with `tables`, record the audited table of each audit record; see [Audit](#audit) | schema |

`schemaHash` covers the tables' definitions and the settings marked schema; it changes exactly when the database must change. `manifestHash` covers the definitions and every setting; generated code checks it. Diagrams and comments belong to neither; [Manifest and hashes](#manifest-and-hashes) defines both.

### Audit

An audited table keeps the key of its audit record in its own audit column, and a history table keeps every version of its rows. An audit record is a row of a declared table, written once for each unit of work (a transaction) before its changes; every audited row that the unit of work inserts or updates refers to it. The executor inserts the record in the same transaction right before the unit of work's first write of an audited table, so a unit of work that writes no audited row writes no audit record. A first update, delete or restore that matches no row writes no audited row, and its record is undone with it; a savepoint or a transaction that rolls back undoes the record together with the write that inserted it, and the next audited write inserts it again. The trigger reads everything it records from the row it receives, `OLD` and `NEW`, so the three databases need no other channel between the executor and the trigger.

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
    audit into service_history column audit_seq references audit action change previous previous_audit_seq tables audit_table (audit_seq, table_name)
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

table audit_table {
  audit_seq i64
  table_name varchar(64)
  primary key (audit_seq, table_name)
  foreign key fk_audit_table_audit (audit_seq) references audit (seq) on delete restrict on update restrict
}
```

- **Audit column.** `column <column>` names a non-null column of the audited table. The executor writes the key of the transaction's audit record into it on every `INSERT` and `UPDATE` of the table ([usage](../operations/usage.md#audited-writes)). `NEW.<column>` is the audit record of the change and `OLD.<column>` the audit record of the previous version.
- **Audit record table.** `references <table>` names a table of the document or a used table: another table than the audited and the history table, not audited itself, with a primary key of one column whose type is the audit column's type. The audited table declares the foreign key `(<column>) references <table> (<key>) on delete restrict on update restrict`, with the leading index that every foreign key needs, so the database rejects an audit column value that names no audit record and the deletion of an audit record that a row refers to; the foreign key is rendered and introspected like any other. An unknown table, the audited or the history table, an audited table, a key of another shape or type, and a missing foreign key are `setting` errors at the table name or the audit column.
- **Recorded columns.** Without a list the triggers record every column of the audited table. `exclude (<column>, ...)` records every column except the listed ones, and `include (<column>, ...)` records only the listed ones. The audit column is always recorded, so neither list names it. A setting has at most one list, and a listed column is a column of the audited table that appears once. Naming an unknown column, listing a column twice, writing both lists and listing the audit column are `setting` errors at the listed column or at the keyword of the second list. A column added to the table later is recorded under `exclude` and not under `include`.
- **History table.** `into <history table>` names a table of the document or a used table. It is another table than the audited one. It has an `i64 identity` primary key, the `action` column (a non-null `varchar(8)`), the `previous` column (nullable, the type of the audit column) and one column for every recorded column of the audited table, with the same name and type; it has no other column. A history table that lacks a copy of a recorded column, has a column of another type, or has any other column, an unrecorded column of the audited table included, is a `setting` error at the history table name, one for each mismatch. The history columns may be nullable. The history table is not audited itself.
- **Audited tables.** `tables <table> (<record column>, <name column>)` names the tables table, a table of the document or a used table in which the triggers record which audited tables each audit record changed. It is another table than the audited, the history and the audit record table, and it is not audited itself. It has exactly the two named columns, the record column and the name column, a `varchar(n)` with n >= 63 that holds a table name ([names](#names)). Its primary key is `(<record column>, <name column>)`, so both columns are non-null, and it declares the foreign key `(<record column>) references <audit record table> (<key>) on delete restrict on update restrict`, which the primary key leads, so the record column has the type of the audit record key. The table so holds one row for each audit record and audited table, every row names an existing audit record, and an audit record that a row names is not deleted. Several audited tables may name the same tables table. An unknown table, the audited, the history or the audit record table, an audited table, an unknown column, a name column of another type, an extra column, another primary key and a missing foreign key are `setting` errors at the table name or at the column. A setting without `tables` records no table. The tables table is an ordinary table of its document: the generated models read it, and a join of the audit record table with it filters and pages the audit records of a table ([usage](../operations/usage.md#audited-writes)).
- **Triggers.** An `AFTER INSERT` row trigger writes `action = 'insert'`, `previous = NULL` and the `NEW` value of every recorded column. An `AFTER UPDATE` row trigger writes `action = 'update'`, `previous = OLD.<audit column>` and the `NEW` value of every recorded column. A `BEFORE DELETE` row trigger rejects the delete. With `tables`, the insert and the update trigger then insert `(NEW.<audit column>, '<audited table>')` into the record column and the name column of the tables table unless that row exists, so a transaction that changes several rows of a table writes one row for the table and a transaction that changes no row of it writes none. Values are copied column to column, so the history row is equal on the three databases; no row is serialized as JSON.
- **Schema text and introspection.** The database holds only the recorded columns, which the triggers list. The schema text therefore writes the setting with `exclude` and the columns that it does not record, in column order, or without a list when it records every column; `include (title)` and the `exclude` list of the other columns give the same `schemaHash`, and the manifest text keeps the list as written. Introspection reads the recorded columns and the `tables` clause from the `audit_insert` trigger, the audit record table from the foreign key of the audit column, and restores the setting in the schema text form; nothing else is stored in the database.
- **Encrypted values.** A value that needs encryption has a codec with the `aes` stage, and the executor encodes it before the write ([codecs](codec.md)), so the row holds the ciphertext and the triggers copy that ciphertext into the history table; the triggers never see a plaintext. Its history column has the same storage type. Exclude such a column to keep it out of the history.
- **Deleting.** The `BEFORE DELETE` trigger makes a physical `DELETE` fail. A table that declares `soft_delete` deletes with an `UPDATE` of the soft delete column, which the history records with its audit record, and a restore of a soft-deleted row is an `UPDATE` that the history records in the same way. `audit` does not require `soft_delete`: a schema setting is read back from the database and a manifest setting is not, so a schema setting never depends on a manifest setting.
- **Limits.** The setting is rejected on a child of a `cascade` or `set_null` foreign key, because MySQL triggers do not fire for rows changed by a foreign key action. `TRUNCATE` is not covered. Raw SQL must name an existing audit record in the audit column, which the foreign key checks; an `UPDATE` that does not write the column records the previous audit record again, and the executor always writes it. Creating the triggers on MySQL with binary logging needs `SUPER` or `log_bin_trust_function_creators=ON`, which apply checks first.

## Manifest and hashes

The declared document set is the only schema source. Generators, schema tools and schema installation read dbspec documents; no other manifest file exists.

The manifest and the [rendered statements](dialects.md#rendered-statements) take the parsed documents of one set. The set holds each document once and every document that its documents use. A document name that repeats is a `name.duplicate` diagnostic and a used document missing from the set is a `use` diagnostic, both at the header name (line 1, column 10) of the later or the using document, with the document named in the message; the documents are checked in name order, and the used names of a document in name order. A set with a diagnostic has no manifest and no statements.

- The **manifest text** of a document is its canonical emission with every comment and every diagram removed. The manifest text of a document set is the manifest texts of its owned documents in document name order, concatenated; each starts with its header and ends with a line end, so the concatenation is unambiguous.
- The **external text** is empty for a set without external documents. Otherwise it holds, for each external document in name order that has a used table, the manifest text of that document reduced to the tables that owned documents name in their `use` lines, in document order, each with its columns, its primary key, its unique keys, the foreign keys whose referenced table is also a used table of the same external document, and the indexes whose leading columns are the columns of such a foreign key, and nothing else, in canonical emission. The reduced text therefore satisfies the same validation as the full document: a rule over used tables, such as the foreign key that an [audit](#audit) `tables` table declares to the audit record table, holds in the runtime model that is built from the manifest text and the external text. A foreign key between two used tables, and the index that leads it, is thus part of the external text and of `manifestHash`; a foreign key to a table that no owned document uses is not, and changing it keeps the hash.
- The **schema text** is the canonical emission of one document named `schema` that holds every owned table of the set in table name order and one `use` line for each external document with a used table, its tables in name order, with every setting removed except `immutable` and `audit`, and an `audit` setting written with the `exclude` list of the columns it does not record, in column order, or without a list when it records every column ([Audit](#audit)); a `settings` block left empty is omitted, as in canonical form. Its only `use` lines name the [external documents](#external-documents) whose tables the owned tables use, and it has no comment or diagram, so it depends only on the tables: moving a table to another document, or renaming or splitting a document, keeps it, and so does introspecting the database the set renders.
- `manifestHash` is `sha256:` followed by the lower-case hexadecimal SHA-256 of the UTF-8 bytes of the manifest text followed by the external text; `schemaHash` is the same over the schema text.

Generated code carries the manifest text and the external text of the document set it was generated from and its `manifestHash`, and every request it sends carries that hash. A runtime builds its model from the embedded text once, when the process starts; the PHP generator writes that model as PHP arrays instead, so the opcode cache keeps it and no request parses the text. `schemaHash` identifies the database state that migration plans and their history record.

## External documents {#external-documents}

A document set owns the documents that its tool lists as its documents. A document of another set whose tables it uses is an **external document** of the set and is listed in the `external` list of the [set file](#document-sets). Several sets can then share one database: each set creates and changes only its own tables, and the set that owns a table is the only one that renders it. An external document is parsed and validated with the set, so a foreign key or an `audit` setting of an owned table checks its target table there, but it is never rendered, installed, altered, compared or generated. An external document that no owned document reaches through `use` is a `use` error at its header name, as is a used document that is neither owned nor external.

- **Hashes.** The manifest text holds the owned documents and the external text the used tables of the external documents, so `manifestHash` changes when a used table changes and stays when another table of an external document changes. The schema text holds the owned tables and names the used tables in its `use` lines.
- **Verification.** Installing the set and adding its tables and columns introspect the database ([dialects](dialects.md#introspection)) and require each used table with every column of its external definition, of the same type and `null`, its primary key and each of its unique keys; the database may hold more columns. A difference fails with `CONFIG` before any statement, naming each difference: `table <t> does not exist`, `column <t>.<c> does not exist`, `column <t>.<c> is <type>, not <type>`, `column <t>.<c> is null, not not null` (or the reverse), `table <t> has the primary key (<columns>), not (<columns>)` and `table <t> has no unique key (<columns>)`. Registering the set, also through the connect helper, reads nothing from the database ([schema](schema.md#_6-schema-registration)).
- **Installation.** Install creates the owned tables when none of them exists, changes nothing when all exist and fails with `CONFIG` when only some exist, and then requires the owned tables to equal the set; addTablesAndColumns compares and changes the owned tables only ([schema](schema.md#_4-schema-installation)).
- **Plans.** A plan changes a whole database ([plans](plans.md#apply)), so a plan whose target schema text has a `use` line is a `plan` error; a set with external documents is installed and upgraded with install and addTablesAndColumns.
- **Runtime.** Each used table of an external document is an **external entity** of the using set's runtime model, in the place of its document, named as its table and built from its external definition alone: its columns, its primary key and its unique keys, with no setting, index or foreign key. Generated code gives it a model like any entity, so it is selected, joined, used in subqueries and relations, related through the relation getters of the generators and given conditions; a model built from the documents and one built from the manifest text and the external text are equal. An external entity whose name repeats an entity of the set is a `name.duplicate` diagnostic. Its owner alone writes it: every write of an external entity (create, creates, update, save, delete, restore, restoreOrCreate, upsert, restartIdentity) fails with `CONFIG` `<table> is owned by another document set` before any statement. The audit record table of an owned table may be an external table: a transaction with audit values inserts the record into it when the set that owns it is registered on the same connection ([Audit](#audit)).

## Runtime model

A client builds one runtime model from the document set, and generated code is produced from the same model:

- **Entities.** One entity per table of every owned document of the set and per used table of every external document ([External documents](#external-documents)), documents in name order and tables in document order. The entity name is the `entity` setting or the table name; generated type names are its snake_case segments with their first letters in upper case (`service_member` → `ServiceMember`).
- **Fields.** One field per column, named as the column, in column order, with the value type of the table below. A `null` column takes the language's absent value: Go a pointer (`[]byte` and styled values stay unwrapped), PHP `?T`, TypeScript `T | null`, Rust `Option<T>`, Python `T | None`; a styled column takes the `StyledValue` of its language, TypeScript `StyledValue<T>` and Python `polyspec.orm.StyledValue`, each with the SQL NULL and value variants; a Python getter whose value has another type raises `TypeError`.
- **Keys.** The primary key columns identify a row; the identity column is never written by an insert and its generated key is returned. An upsert conflicts on the primary key or a unique key, which the call names.
- **Default select set.** Every column except those of `select explicit`; reading a column that was not selected fails with `COLUMN_UNSELECTED`. No type or codec leaves a column out by itself.
- **Defaults.** An insert that omits a column with a default takes the database default; the executor does not fill it, except that on SQLite, whose clock has millisecond resolution, it binds the client clock for an omitted `default now` column ([protocol](protocol.md)). An insert that omits a non-null column without a default fails with `IR_INVALID` before reaching the database.
- **Codecs.** A column with a `codec` setting holds the value that the first stage encodes. When a stage is `ordered_json`, `serialize`, `yaml`, `gz` or `base64`, that is a styled value of the common value model ([codecs](codec.md)), which distinguishes SQL NULL from a stored null; when every stage is `aes`, `hex` or `ip`, it is a string (`ip` takes the address text).
- **Settings.** `updated` is assigned the UTC statement time on every `UPDATE` the executor plans; `soft_delete` filters reads (the root, each join child in its `ON` condition, each relation and each subquery) and turns deletes into updates, and `restore` is the only call that matches a soft-deleted row; `aes_version` stores the key version of the row; `blind_index` writes the HMAC column and rewrites equality conditions on the AES column. For `audit`, a transaction with audit values inserts one audit record before its callback, from the values of the connection's audit source and its own values, and the executor writes the record's key into the audit column of every audited row it inserts or updates; an insert or update of an audited table without an audit fails with `CONFIG`. `immutable` has no runtime behavior: the database rejects the change. `navigation` has none either.
- **Relations.** Generated code joins two entities through the match methods of their columns, as before; a joined result is reached under the alias the call gives or under `<entity>_model` and `<entity>_models`.
- **Connection.** A raw connection takes the DSN URI and its configuration and registers no set; it never takes a schema path. Generated code carries the manifest text and `manifestHash`, and its connect helper opens a connection and registers that set on it; `utils().schema().register(schema)` registers a set on an open connection and `install` registers the set it installs. Registering reads nothing from the database. A set registered by its schema value has its runtime model from its manifest text and external text, so it needs no loaded generated code; PHP uses the arrays of the generated classes once their bootstrap has run. A request carries `manifestHash` and runs only on a connection where its set is registered ([protocol](protocol.md)).
- **Generated metadata.** The manifest is the source of the runtime model; generated code never contradicts it. Every client other than PHP builds the runtime model from the manifest text and external text that the generated code carries, and its generated entity holds only its name and its set, so that generated code carries no metadata that could differ (a Rust model is also generated again by its build script). PHP takes the `meta()` array of each generated class: building the runtime model compares each array, without its `manifest_hash`, with the entity that the manifest text and external text give, and a difference, including an entity that the manifest lacks, fails with `CONFIG` before any statement, naming the class, the entity, the first differing field path (`columns.name.length`) and the regeneration command `orm-gen gen`.

| dbspec | Go | PHP | TypeScript | Rust | Python |
| --- | --- | --- | --- | --- | --- |
| `i16` | `int16` | `int` | `number` | `i16` | `int` |
| `i32` | `int32` | `int` | `number` | `i32` | `int` |
| `i64` | `int64` | `int` | `number` (a safe integer) | `i64` | `int` |
| `bool` | `bool` | `bool` | `boolean` | `bool` | `bool` |
| `decimal(p,s)` | `string` with exactly s fraction digits | `string` | `string` | `String` | `str` |
| `f64` | `float64` | `float` | `number` | `f64` | `float` |
| `varchar(n)`, `text`, `uuid` | `string` | `string` | `string` | `String` | `str` |
| `bytes` | `[]byte` | `string` | `Uint8Array` | `Vec<u8>` | `bytes` |
| `date` | `time.Time` | `\DateTimeImmutable` | `string` `YYYY-MM-DD` | `NaiveDate` | `str` `YYYY-MM-DD` |
| `time(p)` | `string` `HH:MM:SS` with p fraction digits | `string` | `string` | `String` | `str` |
| `datetime(p)` | `time.Time` in UTC | `\DateTimeImmutable` in UTC | `string` `YYYY-MM-DD HH:MM:SS` with p fraction digits | `NaiveDateTime` | `str` `YYYY-MM-DD HH:MM:SS` with p fraction digits, in UTC |

A generated setter of a `date`, `time(p)` or `datetime(p)` column takes the text form in every language: `string` in Go and TypeScript, `str` in Python, `string` in PHP and `String` in Rust. A native date or time value is not accepted by the setter, so the type check reports it before the statement; the text is checked when the setter runs and the bind layer checks it again.

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

## Syntax analysis

Each implementation has one dbspec lexer and one parser, and syntax analysis is an output of that parser: no editor layer, generated file or regular expression holds a rule of the grammar. A regular-expression grammar such as TextMate's has no parser context, and a name may be a keyword word that is not reserved (`key`, `text` and `references` are valid column names), so it would classify tokens differently from the parser.

`analyze(text, set)` returns the parse result, unchanged, and the tokens of the text. A token is `{line, start, end, class}`: `line` is 1-based, `start` is the number of Unicode code points before the token on its line, and `end` the number before the code point after it.

A line is read into words, strings, punctuation marks (`{`, `}`, `(`, `)`, `,`) and operators (`=`, `<>`, `<`, `<=`, `>`, `>=`, `+`, `-`, `*`, `/`); a word of digits with an optional fraction (`12`, `0.50`) is a number, and a comment is a whole line. The parser gives each token its class:

| Class | Tokens |
| --- | --- |
| `keyword` | A word that the grammar fixes at its position, a member of the set of words the position accepts: the header's `dbspec`; `use`, `table`, `diagram`, `settings`; `primary`, `key`, `unique`, `index`, `foreign`, `references`, `on`, `delete`, `update`, `check`; the actions `restrict`, `cascade` and `set_null`; `null`, `identity`, `default`, `asc`, `desc`; the value words `true`, `false`, `null` and `now`; the option and form words of a setting (`explicit`, `files`, `document`, `block`, `list`, `table`, `shard`, `year`, `month`, `day`, `require`, `exclude`, `include`, `row`, `from`, `to`, `at`, `into`, `column`, `action`, `previous`, `initial`, `terminal`, `history`, `limit`) and the codec stages; the predicate words `and`, `or`, `not`, `in`, `is`, and `null` where a predicate reads it. A word in such a position that is not a member is `word` |
| `type` | The word that names a column's type |
| `name` | A word that the grammar takes freely at its position: a document, table, column, constraint, index, diagram or state name, or a relation name of `navigation`, where it is declared and where it is referenced |
| `setting` | The first word of a line of a `settings` block; the other words of the line take the classes above |
| `number` | A number |
| `string` | A string |
| `operator` | An operator, the `-` and `>` of `->` included |
| `punctuation` | A punctuation mark |
| `comment` | A comment line, from `#` to the line end |
| `word` | A word that the parser does not classify |

The cases that the parse does not complete are defined:

- a `limit` error yields no tokens, since the check precedes allocation ([Limits and errors](#limits-and-errors));
- after an `encoding` or `header` stop, the stop line and every later line yield lexical tokens only: a word is `word`, and a number, a string, an operator, a punctuation mark and a comment line keep their class; for `encoding`, a bare CR is not a line end, and lexing goes on after it;
- an invalid character yields no token;
- on a line the parser abandoned with a `syntax` diagnostic, a word is `word`; a line that carries only a semantic diagnostic keeps the classes the parser gave it.

Comment positions exist only in the tokens, never in the document model. Tokens serve highlighting; a tool that needs the position of a declaration reads the declaration positions of the parse result, never the tokens or the text.

The vectors are `tests/dbspec/syntax.json`: the tokens of the canonical, normalize, invalid, sets and hashes cases of `cases.json`; the `files` cases stay with the file and byte readers. The vectors are generated once from the TypeScript implementation, reviewed, then fixed, and every implementation matches them exactly.

## Formatting

`format(text, set)` is `emit(parse(text, set))` in every implementation. A document with a diagnostic is refused and never rewritten. Formatting holds three invariants: `emit(parse(format(x))) == emit(parse(x))`, the manifest and schema hashes of `format(x)` equal those of `x`, and `format(format(x)) == format(x)`. Model equality is not one of them, since emission sorts constraints and `use` lines ([Canonical form](#canonical-form)). The text of a canonical document is its own format, so an editor that formats it changes nothing. The vectors are those of `cases.json`: a canonical or normalize case formats to its canonical text, and an invalid case is refused.

## Declaration positions

A successful parse returns, beside the document, the positions of its declarations: a list in source order of `{kind, path, line, column}`, where `line` and `column` are 1-based and `column` counts Unicode code points, as a diagnostic's do. The positions are never part of the document model, because a document is also built without source text (by introspection and by Mermaid import) and the same model is compared, diffed, rendered, emitted and hashed; introspection, Mermaid import, emit, comparison, diff, render and the hashes neither take nor produce positions. A tool that needs the place of a declaration reads these positions, never the tokens of [syntax analysis](#syntax-analysis) or the text.

| Kind | Path | Position |
| --- | --- | --- |
| `document` | `[<document>]` | the name of the header |
| `use` | `[<used document>]` | the document name of the `use` line |
| `use_table` | `[<used document>, <table>]` | each table name of the `use` line |
| `table` | `[<table>]` | the table name |
| `column` | `[<table>, <column>]` | the column name |
| `constraint` | `[<table>, <name>]` | the name of a `unique`, `index`, `foreign key` or `check` line |
| `constraint` | `[<table>, "primary key"]` | the `primary` keyword: the primary key is the one unnamed declaration |
| `setting` | `[<table>, <keyword>, ...<identity>]` | the keyword of the setting line |
| `diagram` | `[<diagram>]` | the diagram name |
| `diagram_entry` | `[<diagram>, <table>]` | the table name of the entry |

The identity of a setting is what the repeat rule of [Settings](#settings) makes unique, so every path is unique and a setting that repeats has one position per line:

| Setting | Identity |
| --- | --- |
| `codec`, `markdown` | the column |
| `navigation` | the foreign key |
| `blind_index` | the AES column |
| `checkbox` | the column and the state |
| `state_machine` | `transition <from> <to>`, `terminal <state>`, `initial <state>`, `history` or `limit <state>`; the column is left out, since a table holds one machine |
| every other setting | nothing: it appears at most once |

A reference that a tool needs to place beyond these kinds (the target table of a foreign key, the columns of a key, the operands of a check) is added to this list first, in every implementation with its vectors. The vectors are the `positions` cases of `cases.json`.

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

The PHP extension `orm_dbspec` (`packages/php-ext`) implements the dbspec surface of the PHP client in C, as an independent fifth implementation of the same interface. The namespace `Polyspec\Orm\Dbspec\Native` has every class of `Polyspec\Orm\Dbspec` that a dbspec call takes or returns: the document classes (`Document`, `UseLine`, `Table`, `Column`, `ColumnType`, `PrimaryKey`, `UniqueKey`, `Index`, `IndexColumn`, `ForeignKey`, `Check`, `Settings`, `Setting`, `Diagram`, `Placement`) with the same public mutable properties, and the result and value classes with the same readonly properties, each in the order of the PHP client, with the same constructors, methods and constants. `Polyspec\Orm\Dbspec\Native\Dbspec` has `readFile`, `readBytes`, `readSet`, `parse`, `analyze`, `format`, `emit`, `manifest`, `render`, `introspect`, `externalDifferences`, `parsePlan`, `emitPlan`, `chain`, `diff`, `compareSchemas`, `installedDifferences`, `addTablesAndColumnsSteps`, `planSteps`, `apply`, `recover`, `rollback`, `finalize`, `exportMermaid` and `importMermaid` with the arguments, results, diagnostic messages and exceptions of `Polyspec\Orm\Dbspec\Dbspec`, including the `ApplyEvent`s, `ApplyError`s and `ApplyCleanupError`s of the apply commands. `introspect` and the apply commands use the given `PDO` object by calling its methods (`query`, `prepare`, `exec`, `getAttribute`, and `execute`, `fetch`, `fetchAll`, `closeCursor`, `errorCode` and `errorInfo` of its statements), as the PHP client does, so a `PDO` subclass sees the same calls; the apply commands call the clock and event closures and format the clock with `DateTimeImmutable` as the PHP client does. A document that PHP code built or changed is given to these methods like a document of the PHP client. PHP code selects the extension by that namespace; nothing switches between the PHP client and the extension, and a document of one given to the other is a `TypeError`. The extension also carries the error codes of `docs/spec/errors.yaml` as `Polyspec\Orm\Native\Code`, with the constants of the PHP client's `Polyspec\Orm\Code`; `orm-gen errors --lang php-extension` writes its stub. A native class name is the PHP client's name with `Native` as its last namespace segment: `Polyspec\Orm\Dbspec\Dbspec` is `Polyspec\Orm\Dbspec\Native\Dbspec`, and `Polyspec\Orm\Code` is `Polyspec\Orm\Native\Code`.

The extension is built with `phpize` for the PHP whose `phpize` and `php-config` are on `PATH`; `packages/php-ext/composer.json` declares it as a PIE package whose build path is `src`:

```sh
cd packages/php-ext/src && phpize && ./configure && make
php -d extension=packages/php-ext/src/modules/orm_dbspec.so your-script.php
```

Its declarations are in `packages/php-ext/stubs/orm_dbspec.stub.php`, which the interface check reads (`extensions` of `contracts/interfaces.json`); `gen_stub.php` of the PHP installation writes `src/orm_dbspec_arginfo.h` from it (`make php-extension-arginfo`), and `src/orm_dbspec.c` registers the array constants, which `gen_stub.php` cannot write. `make dbspec-php-extension-check` checks that the header is generated from the stub, builds the extension into its run directory, and checks that the loaded extension declares exactly what the stub declares and that it gives the results, messages and exceptions of the PHP client on the shared document, syntax, statement, plan and Mermaid vectors, on changed documents and on introspections of in-memory SQLite databases and failing catalog queries, and on apply, recover, rollback and finalize scripts on SQLite files, and that its public classes declare what the PHP client's public dbspec classes declare; `make dbspec-compare-check`, `make dbspec-introspect-compare-check` and `make dbspec-apply-pairs-check` run it as the fifth runner, and `make dbspec-introspect-php-extension-check` and `make dbspec-apply-php-extension-check` run the introspection and apply tests of the PHP client on MySQL, PostgreSQL and SQLite.

## Verification

Shared vectors live in `tests/dbspec/`: canonical documents with their emission, non-canonical documents with their canonical emission, and invalid documents with every expected diagnostic, and document files under `tests/dbspec/files/`: a DbSchema project file (XML) and an empty file, which every client rejects with the `signature` error, a file with a byte that is not UTF-8, which it rejects with the `encoding` error, and a `.dbs` document, which it reads unchanged; each client reads every file through its file reader and through its byte check, and `make dbspec-compare-check` compares both results of the five clients and of the PHP extension. Every client and the extension parse and emit them identically. Each vector file has a JSON Schema (draft 2020-12) in `tests/dbspec/schema/`, and every compare runner reads its vector files through those schemas with a validator of its ecosystem, ajv for TypeScript, santhosh-tekuri/jsonschema for Go, opis/json-schema for PHP and the PHP extension (from the fork min-0-max/json-schema, whose release 2.6.0-p1 reports every refusal of a file), jsonschema-rs for Python and the jsonschema crate for Rust, and reports a refused file in one form, a `<file>: <location> <problem>` line per problem (`tests/dbspec/compare/runners.test.mts`); a runner checks by itself only what a schema cannot state, such as a main document that is one of the documents of its case. The 2000-table, 60000-column, 10000-foreign-key case is a performance measurement, and a measurement never fails a test (AGENTS.md). Each client's stress test parses the case five times and prints the CPU and wall-clock time of each parse; the shortest, median and longest CPU time; the median CPU time of a reference work, one pass over the same document computing h = h·31 + b (mod 2^32), timed by the same clock in the same process; the ratio of the median parse to it; and the machine. When the ratio exceeds the client's reference value, the test prints a warning, a `WARNING` line with the measurement, the reference and the machine, which the check runner keeps in the run record and the summary and writes as a GitHub warning annotation; the test still passes. The reference ratios are 11 for the PHP client (within a 128 MiB memory limit), 34 for the Rust client (release mode), 63 for the Go client and 185 for the TypeScript client on Node. Each is 1.5 times the highest ratio measured on the CI runner (PHP 7.16, Rust 22.5, Go 41.7–43.0, TypeScript 122.5), so a warning marks a regression of about 50% or more, not normal variance. The CI runner (`.github/runner`) is the machine whose numbers count: its cores are alike, while Apple silicon has performance and efficiency cores and the core a process runs on changes both times, so macOS gave PHP ratios from 6.35 to 10.1 and Rust ratios from 17.3 to 24.0 across runs; there the measurements are only printed. A reference value is never raised to remove a warning; a change needs new CI evidence of the same kind. Each measurement is the CPU time of the thread that parses: the Rust main thread, the locked OS thread of the Go test, the Node main thread and the single-threaded PHP process. Wall-clock time on a shared machine includes the time other processes hold the processors, and the process CPU time of Go and Node includes garbage collector threads that run on other cores. `make bench` runs the four stress tests (`make dbspec-stress-bench`) and `make timing-check`, which runs the four stress tests, the Rust orm-schema vector tests and the PHP dbspec tests while their process group receives one tenth of wall-clock time, and requires every test to pass and print its measurements.
