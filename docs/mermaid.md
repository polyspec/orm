<!-- doc-id: mermaid -->
# Mermaid diagrams

dbspec documents are the schema source; a Mermaid `erDiagram` is a view for other tools. Export writes a standard `erDiagram` from a dbspec document; import reads a standard `erDiagram` into a dbspec document and lists everything it does not carry over. `tests/dbspec/mermaid.json` holds the shared cases.

## Export

Export writes one diagram for one document, tables in name order, columns in document order:

```
erDiagram
    orders {
        i64 id PK "identity"
        i64 user_id FK
        decimal(10-2) total "default 0.00"
    }
    users {
        i64 id PK "identity"
        varchar(64) mail UK
        i32 age "null"
    }
    users ||--o{ orders : "fk_orders_user (user_id) references (id)"
```

- The first line is `erDiagram`; every other line is indented by four spaces per level, and the text ends with a line end.
- A column is `<type> <name>` followed by its keys and, when it has any, a comment. The type is the dbspec type with `decimal(p,s)` written `decimal(p-s)`, because a Mermaid type has no comma. The keys are `PK` for a primary key column, `FK` for a column of a foreign key and `UK` for a column of a unique key, in that order and separated by `, `. The comment holds the column suffix of the dbspec column line — `null`, `identity` and `default <literal>` as dbspec writes them — and is left out when the suffix is empty. A default that contains `"` cannot be written in a Mermaid comment; export writes the column without it and reports the default.
- A foreign key is a relationship from the referenced table to the table, in table and then foreign key name order: `<parent> ||--o{ <child>` when every column of the key is non-null and `<parent> |o--o{ <child>` otherwise, labelled `"<name> (<columns>) references (<referenced columns>)"`.
- Export leaves out comments, unique keys (only their columns are marked), indexes, checks, foreign key actions other than `restrict`, settings, diagrams and `use` lines, and reports each: export returns the text and the list of what it left out, as `[kind, table, name]` in table, kind and name order.
- A comment is reported as `comment` with the object whose lines carry it: `[comment, <table>, <column>]` for a column line and `[comment, <table>, <key name>]` for a unique key, index, foreign key or check line; `[comment, <table>, <table>]` once for the table's own lines — the table line, its primary key line, its settings block with its setting lines and the closing braces; `[comment, "", <document>]` for a `use` line of that document, `[comment, "", <diagram>]` once for the lines of a diagram, and `[comment, "", <name of the exported document>]` for the comments after the last block.

## Import

Import reads a standard `erDiagram` into a document named by the caller. It accepts the Mermaid syntax of entities, attributes and relationships: entity names of letters, digits, `_` and `-` or in double quotes; attributes `<type> <name> [keys] ["comment"]`; relationships with the cardinalities `|o`, `||`, `}o`, `}|` on the left and `o|`, `||`, `o{`, `|{` on the right, `--` or `..` between them, and a word or quoted label. `%%` comment lines and blank lines are skipped; any other line is a `mermaid` diagnostic at its line, and so is a line that does not follow the grammar.

What import carries over and what it reports, as `[kind, entity, name, reason]`:

- **Tables.** An entity becomes a table when its name is a dbspec name and it has a primary key; otherwise it is reported as `table` and left out with its relationships.
- **Columns.** An attribute becomes a column when its name is a dbspec name and its type is a dbspec type (with `decimal(p-s)`) whose parameters are in the dbspec ranges; otherwise it is reported as `column` and left out before keys are read, so a key attribute with such a type is not a key column. A comment of the form `[null] [identity] [default <literal>]`, its parts separated by single spaces, gives those parts; another comment is reported as `comment` and the column is non-null without a default.
- **Keys.** The `PK` attributes, in attribute order, are the primary key. `UK` attributes are reported as `unique`: Mermaid does not say which of them form one key.
- **Foreign keys.** A relationship whose label is `"<name> (<columns>) references (<referenced columns>)"` with as many columns as referenced columns, whose columns are `FK` attributes of the many side and whose referenced columns exist on the one side, becomes the foreign key `<name>` with the actions `restrict`; any other relationship is reported as `relationship` with its two entities and its label. A column marked `FK` that no relationship uses is reported as `foreign_key`. When the table's primary key does not begin with the foreign key's columns, import adds the index `ix_<table>_<columns joined by _>` that dbspec requires and reports it as `index`, because Mermaid has none; foreign keys over the same columns share one such index, added and reported once.
- **Cardinality.** dbspec derives cardinality from the foreign key; a relationship whose cardinalities differ from the ones export writes for its nullability is reported as `cardinality`.

The imported document is parsed; a line it rejects is reported with the dbspec diagnostic and its object left out, as introspection does, until the document parses. Import of an export gives back the exported document without what export reported, plus the reported indexes.

## Verification

Each client runs the cases of `tests/dbspec/mermaid.json` in its own check: `make dbspec-go-check`, `make dbspec-php-check`, `make dbspec-ts-check` and `make dbspec-rust-check`. `make dbspec-compare-check` runs every case through the Go, PHP, TypeScript and Rust clients twice each and requires every output to equal the first Go output: the Mermaid text and dropped `[kind, table, name]` of every export case, the emitted document and dropped objects or the `[rule, line, column]` diagnostics of every import and invalid case, and the export and its import of every round trip case. Reasons are not compared.
