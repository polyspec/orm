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

## Apply

Apply runs, one plan at a time, the plans of a chain that a database has not applied, on one connection.

1. **Lock.** MySQL takes `GET_LOCK('dbspec$plans', 0)` and PostgreSQL `pg_try_advisory_lock(hashtext('dbspec$plans'))`; SQLite turns foreign keys off and runs the whole apply in one `BEGIN IMMEDIATE` transaction. A lock that another session holds is a `locked` error; nothing changes.
2. **History.** The table `dbspec$plans` records one row per plan: `name`, `from_hash`, `to_hash`, `state` (`running` or `done`), `step` (the statements done), `steps` and `applied_at` (UTC, `YYYY-MM-DDTHH:MM:SSZ`). Apply creates it when it is missing. Its name has a `$`, which no dbspec name has, and introspection leaves it out without reporting it.
3. **State.** The database is at the `to_hash` of the last `done` row in chain order, or empty. A `running` row is an `interrupted` error naming the plan and step. Apply introspects the database and requires its `schemaHash` to be that state; otherwise it is a `drift` error naming both hashes. A chain that does not contain the state is a `chain` error.
4. **Statements.** For each later plan, apply writes its `running` row and runs its statements, recording `step` after each. PostgreSQL runs a plan, with its row, in one transaction; SQLite requires `PRAGMA foreign_key_check` to return no row after each plan; MySQL commits every statement on its own.
5. **Verification.** Apply introspects the database; its `schemaHash` must equal the plan's `to` hash, and nothing unsupported; otherwise it is a `verify` error, PostgreSQL rolls the plan back and SQLite the whole apply. Then the row becomes `done`. A state, too, is checked with nothing unsupported, and the empty state has no table.

Apply reports each occurrence as an event: `plan` when a plan starts (with its number of statements), `statement` before and `applied` after each statement (with its index and text), `verified` and `done`. An event handler that returns an error stops apply at that point.

**Recovery.** Only MySQL can leave a `running` row: a statement committed, but the connection ended before the next. Recover reads the row; `step` is `k` when statements before `k` are done and statement `k` may have run. Each MySQL statement of a plan has one effect that the catalog shows: a table, column, index, constraint or trigger that is present or absent, and `MODIFY COLUMN`, which can run again. Recover checks the effect of statement `k`, continues from `k + 1` when it is there and from `k` when it is not, then verifies and marks the row `done`. A failed statement is reported with its index and the database error, and on MySQL its row stays `running`. Recover with no `running` row changes nothing, and apply on a database that has applied the whole chain changes nothing.

## Verification

`make dbspec-go-check` runs the cases of `tests/dbspec/plans.json` through the Go engine; `make dbspec-plan-check` applies every case to MySQL, PostgreSQL and SQLite: it renders the source, runs the `before` steps, applies the statements, runs the `after` steps, and requires the introspected schema text to equal the plan's target. `make dbspec-apply-check` applies chains with history, lock, drift, verification and recovery on the three databases. `make dbspec-ts-check` and `make dbspec-plan-ts-check` do the same through the TypeScript client's `parsePlan`, `emitPlan`, `chainPlans`, `diffPlan` and `planStatements`. `make dbspec-rust-check` runs the same cases through the Rust client, and `make dbspec-plan-rust-check` applies them with the Rust renderer, plan statements and introspection. `make dbspec-php-check` runs the same cases through the PHP client's `Orm\Dbspec\Dbspec` (`parsePlan`, `emitPlan`, `chain`, `diff`, `planStatements`), and `make dbspec-plan-php-check` applies them through it to the three databases. `make dbspec-apply-php-check` runs the scenarios of `make dbspec-apply-check` through its `apply` and `recover`. Each client's plan test also runs the parse cases, whose diagnostics carry rule, line, column and, for a `plan` diagnostic, the message. `make dbspec-compare-check` runs every entry of `tests/dbspec/plans.json` through the Go, PHP, TypeScript and Rust clients twice each and requires every output to equal the first Go output: the emitted plan, the changes and the statements of each dialect of every case, the diagnostics of every invalid and parse case, and the order or diagnostics of every chain, with the message of every `plan` and `chain` diagnostic. `make dbspec-apply-rust-check` applies the chains of `make dbspec-apply-check` through the Rust client's `orm::dbspec::apply` and `orm::dbspec::recover`. `make dbspec-apply-ts-check` applies the chains of `make dbspec-apply-check` through its `applyPlans` and `recoverPlans`. `make dbspec-rust-check` runs the same cases through the Rust client, and `make dbspec-plan-rust-check` applies them with the Rust renderer, plan statements and introspection.
