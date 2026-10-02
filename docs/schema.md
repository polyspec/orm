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

`connection.utils().schema().install(...)` renders the document set with the dialect of the connection and applies the statements, triggers included. It creates every table when no table of the set exists, changes nothing when every table exists, and fails with `CONFIG` when only some exist. A set with a diagnostic fails with `SCHEMA_INVALID`. PostgreSQL and SQLite apply the statements in the active transaction of the connection or in a new one. MySQL commits each schema statement implicitly, so it applies them outside a transaction, and a call inside a transaction returns `CONFIG`.

| Language | Call | Input |
|---|---|---|
| Go | `Utils().Schema().Install(model.ManifestText)` | the manifest text of the generated models |
| PHP | `utils()->schema()->install($documents)` | the text of every document of the set |
| TypeScript | `utils().schema().install(texts)` | the text of every document of the set |
| Rust | `utils().schema().install(&schema).await` | the schema of the generated models |
