# Schema plans

A plan changes a database from one schema to the next. It holds the target schema and the decisions that a schema cannot express: renames and the permission to drop. Plans form a chain from an empty database; every client diffs the two schemas of a plan the same way and writes the same statements for each dialect. `tests/dbspec/plans.json` holds the shared cases.

## Plan document

A plan is a text file, conventionally `<name>.dbplan`, in UTF-8 with LF line ends:

```
dbplan 1 add_clients
from sha256:3b1f…
rename table users clients
rename column clients.mail email
allow drop table legacy
allow drop column clients.fax

dbspec 1 schema

table clients {
  …
}
```

- The first line is exactly `dbplan 1 <name>`, with a name of the [name rules](dbspec.md#names).
- The second line is `from empty` for the first plan of a chain, or `from <schemaHash>` of the schema the plan starts from.
- Then, one per line: `rename table <old> <new>`; `rename column <table>.<old> <new>`, where `<table>` is the table's name in the target; `allow drop table <name>`; and `allow drop column <table>.<name>`, with the names of the source.
- A blank line ends the header. The rest is the target: a [schema text](dbspec.md#manifest-and-hashes), one document named `schema` in canonical form. The plan's `to` hash is the `schemaHash` of that text.

The canonical plan writes the header lines in the order `rename table`, `rename column`, `allow drop table`, `allow drop column`, each in name order. A plan is invalid, with a `plan` diagnostic at its line, when a line has another form, a name breaks the name rules, a line repeats, two renames give one name, or the target is not a schema text; a target diagnostic is located in the plan. A plan whose target hash equals its `from` is invalid too.

## Chain

The plans of a directory form one chain: the plan `from empty` comes first and each next plan starts from the `to` hash of the one before. A missing `from empty` plan, two plans with the same `from`, a plan that the chain does not reach, and a cycle are `chain` diagnostics that name the plans.

## Diff

The diff of a plan compares its source, which is the target of the plan before it or the empty schema, with its target. The source must have the plan's `from` hash. Tables match by name, a renamed table by its new name; columns of matched tables likewise. A rename whose old name the source lacks, whose new name the source already has, or whose new name the target lacks is a `plan` diagnostic.

| Change | When | Permission |
| --- | --- | --- |
| `create_table` | a table only in the target | |
| `drop_table` | a table only in the source | `allow drop table` |
| `rename_table`, `rename_column` | a rename | |
| `add_column` | a column only in the target | |
| `drop_column` | a column only in the source | `allow drop column` |
| `alter_column` | a matched column whose type widens, or whose `null` or default changes | |
| `drop_*`, `add_*` of `unique`, `index`, `foreign_key` and `check` | an object only on one side, or whose definition differs after the renames | |
| `drop_triggers`, `create_triggers` | the rendered `immutable` or `audit` statements of a table differ in a dialect | |

A widening keeps every value on the three databases: `i16` to `i32` or `i64`, `i32` to `i64`, `varchar(n)` to `varchar(m)` with `m ≥ n` or to `text`, `decimal(p,s)` to `decimal(q,s)` with `q ≥ p`, and `time(p)` or `datetime(p)` to the same type with a larger precision. These are `plan` diagnostics, because they need a new column or table filled between two plans or cannot keep the column order PostgreSQL gives:

- a non-null column without a default added to a table;
- any other type change, a change of `identity` and a change of the primary key;
- matched columns in another order, and an added column before a matched one;
- a drop without its permission, and a permission that drops nothing.

An object is dropped and added again even when its definition stays: a check that names a renamed or altered column, a foreign key one of whose columns, on either side, is altered, and a foreign key whose columns begin a dropped index or unique key, which MySQL would otherwise not drop. A renderer CHECK, named `<table>$<column>`, is dropped and added when its name or text changes. The diff of a schema with itself is empty.

## Statements

The statements come in this order, tables and objects in name order within each step:

1. drop the triggers that change and those of the dropped tables, with their PostgreSQL functions;
2. drop the foreign keys that change, and those of the dropped tables;
3. drop the checks, renderer CHECKs, unique keys and indexes that change;
4. rename tables, then columns;
5. drop columns, then tables;
6. create tables as the [renderer](dialects.md#rendered-statements) writes them;
7. add and alter columns;
8. add unique keys, indexes, checks and renderer CHECKs;
9. add the foreign keys of the created tables and those that change;
10. create the triggers of the created tables and those that change.

MySQL alters a column with `MODIFY COLUMN` and its full rendered definition; PostgreSQL with `ALTER COLUMN` `TYPE`, `SET NOT NULL`, `DROP NOT NULL`, `SET DEFAULT` and `DROP DEFAULT`, in that order.

SQLite rebuilds a matched table when its name, a column, a foreign key or a check changes: it creates the target table as `"$rebuild"`, copies the matched columns with one `INSERT … SELECT`, drops the table, renames `"$rebuild"` to the table's name, creates its indexes and recreates its triggers. Renames run first, so other tables' foreign keys follow them. A `time(p)` or `datetime(p)` column whose precision grows is copied with zero fraction digits appended. Index and unique key changes alone, and trigger changes alone, do not rebuild. SQLite runs a plan with foreign keys off and checks them afterwards (`PRAGMA foreign_key_check` returns no row).

## Verification

`make dbspec-go-check` runs the cases of `tests/dbspec/plans.json` through the Go engine; `make dbspec-plan-check` applies every case to MySQL, PostgreSQL and SQLite: it renders the source, runs the `before` steps, applies the statements, runs the `after` steps, and requires the introspected schema text to equal the plan's target.
