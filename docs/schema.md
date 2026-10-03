# Schema

The schema source is a set of dbspec documents (`.dbs`). [dbspec.md](dbspec.md) defines the language, its validation rules, the manifest text and the two hashes; `schema/bench.dbs` is the schema of the tests and benchmarks. No other schema file exists: every generator, runtime and schema operation reads the document set.

## 1. Model generation

Each language generates its models from the document set with its own tool ([usage](usage.md#_3-code-generation)):

| Language | Tool |
|---|---|
| Go | `orm-gen gen --document <file.dbs>... --lang go --out <directory> --scan <package pattern>...` |
| PHP | `vendor/bin/orm-gen gen --out <directory> --namespace <namespace> <files.dbs...>` |
| TypeScript | `orm-gen gen --schema <file.dbs> --out <directory> --scan <path>` of `@polyspec/orm-typescript` |
| Rust | `orm_build::Builder::new([<files.dbs>]).scan("src").generate()` in `build.rs` |

Each tool reads every document file with the file reader of its client, which rejects a file that does not start with the dbspec signature as a `signature` error before parsing ([files](dbspec.md#files)); the tool then fails with `SCHEMA_INVALID` and writes no model.

The `github.com/polyspec/orm/generator` package exposes Go generation to other programs. `generator.Generate` takes the runtime model of the document set, the output directory, `PackageName` (the directory name by default) and `Scan`, the package patterns whose calls are generated. Naming, field mapping and output stay in the ORM generator.

## 2. Schema operations

The schema operations are functions of each client library. They take parsed documents and a dialect (`mysql`, `postgres` or `sqlite`) and return statements or located diagnostics.

| Operation | Go `engine/dbspec` | PHP `Orm\Dbspec\Dbspec` | TypeScript | Rust |
|---|---|---|---|---|
| Render the statements of a document set ([dialects](dialects.md#rendered-statements)) | `Render` | `render` | `renderDbspec` | `orm_schema::dbspec::render` |
| Introspect a database into a document ([dialects](dialects.md#introspection)) | `Introspect` | `introspect` | `introspectDbspec` | `orm::dbspec::introspect` |
| Diff a plan against its source ([plans](plans.md)) | `Diff` | `diff` | `diffPlan` | `orm_schema::dbspec::diff` |
| Write the steps of a plan with their rollback statements ([plans](plans.md#steps)) | `PlanSteps` | `planSteps` | `planSteps` | `orm_schema::dbspec::plan_steps` |
| Apply a plan chain ([plans](plans.md#apply)) | `Apply` | `apply` | `applyPlans` | `orm::dbspec::apply` |
| Continue an interrupted plan ([plans](plans.md#apply)) | `Recover` | `recover` | `recoverPlans` | `orm::dbspec::recover` |
| Roll back the last plan ([plans](plans.md#apply)) | `Rollback` | `rollback` | `rollbackPlans` | `orm::dbspec::rollback` |
| Finalize the applied plans ([plans](plans.md#apply)) | `Finalize` | `finalize` | `finalizePlans` | `orm::dbspec::finalize` |

[mermaid.md](mermaid.md) specifies the export of a document to a Mermaid `erDiagram` and the import of a diagram into a document.

## 3. Rust catalog connections

Tool cell decoding preserves actual SQL NULL and supported integer/text/boolean values (grid cells also decimal, binary, date, time and datetime values; see [interfaces](interfaces.md)), but rejects unsupported types, invalid UTF-8 and unsigned integers beyond signed 64-bit range. It must not substitute SQL NULL, replacement text or wrapped integers. These checks do not make the catalog tool a general query-result decoder.

Tool `Val::int()`, `opt_int()` and `bool()` return checked results. Required integer/boolean conversions reject SQL NULL. Optional integers preserve NULL as `None`. Booleans accept only native booleans, integer 0/1 and text `t`, `f`, `true`, `false`, `1`, `0`; malformed values never become defaults. Errors omit the input value and propagate through catalog operations, including transaction cleanup.

The `live-db` feature exposes `orm_build::catalog::CatalogConnection::connect(dsn)`. The DSN selects the database without a driver argument. Catalog connections preserve SQLite foreign-key settings. A catalog connection reads table metadata and pages and changes rows; `orm::dbspec::introspect` reads the schema of a database.

SQLite catalog connections require an existing regular database file and disable automatic file creation. `close(self)` releases the reserved connection before closing its pool. Native decoding limitations require owning corrections before arbitrary SQL/data access is enabled.

## 4. Schema installation

`connection.utils().schema().install(schema)` renders the document set of a generated schema value with the dialect of the connection, applies the statements, triggers included, and registers the set on the connection ([protocol](protocol.md)). A manifest text that does not hash to its declared `manifestHash` fails with `CONFIG` before any statement. It creates every table when no table of the set exists, changes nothing when every table exists, and fails with `CONFIG` when only some exist. A set with a diagnostic fails with `SCHEMA_INVALID`. PostgreSQL and SQLite apply the statements in the active transaction of the connection or in a new one. MySQL commits each schema statement implicitly, so it applies them outside a transaction, and a call inside a transaction returns `CONFIG`.

| Language | Call | Input |
|---|---|---|
| Go | `Utils().Schema().Install(model.Schema)` | the schema value of the generated package (`*orm.Schema`) |
| PHP | `utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema())` | the schema value of the generated models (`Orm\Schema`) |
| TypeScript | `utils().schema().install(SCHEMA)` | the schema value of the generated module (`{ manifestText, manifestHash }`) |
| Rust | `utils().schema().install(&model::SCHEMA).await` | the schema value of the generated models (`orm::Schema`) |

## 5. Adding tables and columns

`connection.utils().schema().addTablesAndColumns(schema)` upgrades an installed document set to a new version of it that only adds: it creates every table of the set that the database lacks and adds the missing columns of the existing tables, when each of them is `null` or has a default. It returns a created table as `table` and an added column as `table.column`, in table name order and then column order. It introspects the database of the connection ([dialects](dialects.md#introspection)) and compares the tables of the set that exist with the set, as a [comparison](plans.md#comparison) of their schema texts; every table outside the set is neither compared nor changed, so one database can hold the tables of several sets. When every difference is a `create_table` or an `add_column` of such a column, it runs the [steps](plans.md#steps) of one plan from those tables to the set: a created table comes with its indexes, foreign keys, checks and `immutable` and `audit` triggers; an added column is an `ADD COLUMN` with the renderer CHECK of the column on MySQL and PostgreSQL and a rebuild of the table on SQLite, and for an audited table the replacement of its triggers, which then copy the new columns into the history table. A repeated call adds nothing and returns an empty list. It records no plan history and registers no set; the connect helper of generated code registers the set.

Every other difference returns `SCHEMA_DIFFERS`, which names each difference as `<kind> <table>[.<name>]`, before any statement, also when the version adds tables: a missing column that is non-null without a default, a column that the set does not declare, a changed type, `null`, default or identity, a missing column before an existing one (`reorder_columns`, because PostgreSQL appends a column), a changed primary key, unique key, index, foreign key, check or setting of an existing table, and an object of a table of the set that introspection cannot read. A manifest text that does not hash to its declared `manifestHash` fails with `CONFIG` first, and a set with a diagnostic with `SCHEMA_INVALID`. PostgreSQL applies the steps in the active transaction of the connection or in a new one. MySQL commits each schema statement implicitly and SQLite rebuilds a table with foreign keys off, which a transaction cannot change, so both apply the steps outside a transaction and return `CONFIG` inside one; SQLite runs them in one `BEGIN IMMEDIATE` transaction on one connection, requires `PRAGMA foreign_key_check` to return no row before it commits, and turns foreign keys on again.

| Language | Call | Steps |
|---|---|---|
| Go | `Utils().Schema().AddTablesAndColumns(model.Schema)` | `dbspec.AddTablesAndColumnsSteps` |
| PHP | `utils()->schema()->addTablesAndColumns(\Polyspec\Orm\Tests\Model\schema())` | `Dbspec::addTablesAndColumnsSteps` |
| TypeScript | `utils().schema().addTablesAndColumns(SCHEMA)` | `addTablesAndColumnsSteps` |
| Rust | `utils().schema().add_tables_and_columns(&model::SCHEMA).await` | `orm_schema::dbspec::add_tables_and_columns_steps` |

`install` creates a set only whole and returns `CONFIG` for a set of which only some tables exist; `addTablesAndColumns` brings such a set to its new version, after which `install` changes nothing.
