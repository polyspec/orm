# Changelog

- Require MySQL and PostgreSQL in the client database tests: the Go, PHP, Rust and TypeScript tests fail and name the variable when `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TOOLS_MYSQL_DSN` or `ORM_TOOLS_POSTGRES_DSN` is unset, instead of running on SQLite alone. SQLite audit updates compare stored bytes, so a change in case only is recorded in a `NOCASE` column.

- Bound and cancel statements: the connection configuration takes `poolSize` and `statementTimeoutMs`, and a flow cancels through a connection handle — Go `db.WithContext(ctx)`, TypeScript `db.withSignal(signal)`, and in Rust dropping the future of a statement. A statement stopped by a cancellation or a timeout returns the new error code `CANCELED`. PHP cancellation is not implemented yet.

- Add the column type `jsontext`, JSON stored as its exact text: `text` on PostgreSQL, `LONGTEXT` on MySQL, and TEXT on SQLite, so member order, duplicate keys, and an empty object against an empty array survive on the three databases. The type `json` is rejected and names `jsontext`; `import` maps PostgreSQL `json`/`jsonb`, MySQL `JSON`, and text columns carrying the json codec to it. Audit rows record JSON text columns as JSON on every dialect.

- Drop a connector at the start of a model or a group: a leading `and(fn)`, `or(fn)`, `and()`, `or()`, or prefixed chain reads as the first condition. A missing connector between two conditions and a connector without a following condition still return `CONFIG`.

- Add audit triggers as schema directives: `%% orm:audit_log` names the operation and change tables and the transaction setting that carries the operation id, and `%% orm:audit` requires an operation for every write to an entity and, in `changes` mode, records the old and new row with redacted JSON paths. DDL, `install()`, `diff`, `migrate`, `import`, and `validate` handle them on MySQL, PostgreSQL, and SQLite. `%% orm:immutable` renders on MySQL (updates and deletes). MySQL stores `uuid` columns as `char(36)`, writes TEXT, BLOB, JSON, and geometry literal defaults as expressions, and creates the database of a schema-qualified table. The SQL splitter keeps trigger bodies whole. `ormgen gen --lang go` also scans files excluded by `//go:build` constraints.

- A plan written from a `db:` source whose CHECK expressions were aligned with the declaration stores the schema hash of the aligned content, so `apply`, `recover`, and `rollback` accept it, in every language. `tests/schema/cases.json` also records the Mermaid schemas of the Go client and engine tests.

- Fix the Go schema tools against live databases: SQLite introspection reads `AUTOINCREMENT` keys and the generated clock default, so adding a nullable column is an `ADD COLUMN` instead of a rebuild and rollback SQL keeps valid defaults; SQLite full-text declarations create no objects and no longer block a rebuild; the update-time attribute is a column change only on MySQL; MySQL and PostgreSQL CHECK expressions are compared in the database's normalized form; an added column carries its comment, and MySQL `MODIFY COLUMN` keeps it; verification compares columns by name. Every tool DSN, including `db:` sources, is the client URI (`mysql://`, `postgres://`, `sqlite:///path`), the `--driver` options are removed, and `import` and `validate` read SQLite. Tool tests of every language use `ORM_TOOLS_MYSQL_DSN` and `ORM_TOOLS_POSTGRES_DSN`. `tests/schema/cases.json` also records the `ormgen plan` file of each manifest pair.

- Apply one schema install rule in every client: PostgreSQL and SQLite install in the active transaction or a new one, and MySQL installs outside a transaction and returns `CONFIG` inside one. On SQLite, a string compared with or assigned to a datetime or date column is written in the stored text form, so `startDt('2026-01-02 00:00:00')` matches the stored value; any other form returns `CODEC_ENCODE`. The Rust client binds datetime text with a `T` separator and RFC 3339 offsets on PostgreSQL.

- Assemble SQL in every client: PHP, Rust, and TypeScript validate requests, plan statements, render the MySQL, PostgreSQL, and SQLite dialects, and render schema DDL in the application process, and the Go client calls the engine packages directly. The four clients produce the same statements, binds, and results for the conformance vectors. `utils().schema().install()` works on the three databases in every client.

- Ship one model generator per language: `ormgen gen --lang go` for `go generate`, `vendor/bin/orm-gen` for PHP, the `orm-gen` npm bin for the TypeScript build, and the `orm-build` crate with `orm::models!()` for Rust `build.rs`. TypeScript and Rust generate the chain methods that the scanned source calls. Connections are `model.Connect(dsn, schemaPath, config)` (Go), `Orm::connect(dsn, new Config(schemaPath: …))` (PHP), `Db.connect(dsn, schemaPath, options)` (TypeScript), and `Db::connect(dsn, pool_size, config)` (Rust).

- Remove the compiler service, its client transports and bridges, the WASM and FFI engine entry points, and the service deployment units. Adopting the ORM needs only the client library.

- Fix connection time zones: PostgreSQL receives a fixed-offset `timezone` in POSIX form, datetime values read from PostgreSQL are shown in the connection time zone, SQLite inserts write the executor clock of the connection time zone for `=now` columns, and a MySQL named zone without the server time zone tables returns `CONFIG`.

- Remove keyset pagination, relation existence and count predicates, tenant scopes, `having`, `distinct`, raw requests, `min`/`max`/`countDistinct` aggregates, the `like`, `startsWith`, and `endsWith` operators, request debug output, and the `predicate`, `scope`, and `many_to_many` schema directives. Remove the `CURSOR_INVALID` error code.

- Apply the reserved-name rules of the model syntax in schema validation and allow SQL keywords such as `key` and `order` as table and column names. Remove the `curlfile` codec, the Go configuration-file loader, and the `ormgen check` and `ormgen precompile` commands. Rewrite the schema, protocol, configuration, dialect, codec, and packaging documents for the current design and remove the archived design pages.

- Rewrite the Go client for the model syntax: `model.<Entity>()` models with `Connect`, chain methods generated from the calls of the packages named by `ormgen gen --scan`, goroutine-scoped callback transactions with savepoints and functional options, `Utils()`, `GetsPage`, `Creates`, `GetQuery`, `New<Name>`, cross-connection relations, and connection time zones from the DSN `timezone` parameter. Add bound raw column expressions, binary contains, and multi-row inserts to the compiler, and render `{column}` paths from the statement root. Replace the conformance vectors with the model syntax and record them for MySQL, PostgreSQL, and SQLite.

- Carry explicit join and relation keys, joined-child groups, column and value functions, multi-column list conditions, subqueries, and random ordering through the compiler protocol and the Go, PHP, Rust, and TypeScript IR bridges. `make proto-check` compiles shared query forms through all four bridges and compares the plans.

- Compile explicit key joins and relations, joined-child condition groups, column and value functions, multi-column list conditions, subquery conditions and columns, `{column}` references in raw fragments, and random ordering for MySQL, PostgreSQL, and SQLite. Add the `FUNCTION_UNKNOWN` error code.

- Rewrite the common interface for models with `connect`, callback transactions with isolation, read-only, timeout, and retry options, flow-scoped savepoints, row locks inside transactions, and `connection.utils()` operations; remove public begin/commit/rollback, raw transaction SQL, explicit savepoint calls, and application-specific privilege helpers.

- Rewrite the complex query example with the approved syntax: configured join children, joined-model groups, ORM function values, and `getsPage`.

- Specify ORM function values: value functions `now`, `today`, `…Ago`, and `…Later`, and column functions `dayOfWeek`, `year`, `month`, `date`, `distance`, `pointX`, and `pointY` with MySQL, PostgreSQL, and SQLite renderings. The compared value is the second method argument. Raise the minimum SQLite version to 3.46 and document the SQLite decimal difference.

- Specify relation result names (`get<Table>Model(s)` or `get<Name>` for `alias<Name>`) and reject duplicate names among columns, added columns, relation results, and `new<Name>` values.

- Define `new<Name>` as a value attached under a non-column name that is carried to getters, `toArray()`, and JSON output but never used in SQL, reject real column names in `new<Name>`, and add `orderByRandom()`.

- Specify approved DSL rules: join `ON` conditions with the child `on(fn)`, joined-model condition groups with `and(model)`/`or(model)`, `getsPage`, `getQuery`, unexecuted models as subqueries, raw forms with `{column}`, `<ColA><Op><ColB>(model)` column comparisons, `creates`, `tuple<ColA>With<ColB>`, ORM function values, reserved column name segments, and removal of `curlfile_serialize`.

- Update the guide, README, and documentation home to the model syntax: model creation with `connect`, unprefixed first conditions, `and`/`or` connectors and groups, relation keys with `match<L>With<R>`, `create`/`update(true)`/`delete(true)` writes, and callback transactions without `connect`.

- Rewrite the DSL specification for the model syntax: `connect` binding, unprefixed first conditions, `and`/`or` connectors and groups, chain grammar with operator prefixes, value shapes for one value, lists, and null, fixed two-value `Between` arrays, reads, columns, relations, joins, writes, transactions, and reserved names.

- Replace the initial design, revised design, and DSL v3 notes with one design plan (`docs/plan.md`). The plan defines the model syntax for Go, PHP, Rust, and TypeScript, its rules, and the work order.

- Update the Go dependency `github.com/polyspec/ordered-json/go` from `v0.0.0-20260915123419-26c2aebc9789` to `v0.0.0-20260916062150-40c9f98cde3a` from ordered-json commit `40c9f98`. The ORM version remains `0.0.1`.

- Add the ORM-owned `DB.BackendWaitingForLock` inspection API for bounded PostgreSQL integration orchestration; non-PostgreSQL adapters return `false` without exposing driver-specific application paths.

- Add adapter-neutral Go transaction-local context reads through `Tx.Local`; values set through `Tx.SetLocal` can be read without direct SQL, and missing keys return `NO_ROWS`.

- Add adapter-neutral Go `NewTransactionConflict` for deterministic serialization/deadlock error propagation without driver-specific SQL or error types.

- Expose the canonical schema client generator through `github.com/polyspec/orm/generator` for Go, PHP, Rust and TypeScript.
- Allow Go client generation to select an explicit package name while retaining `gen` as the default.

- Specify `Tx.InstallSchema(context.Context, []byte) error` as the ORM-owned canonical schema installation boundary; consumers do not provide SQL or dialect-specific DDL.

- Go caller-owned transactions expose `Tx.Driver()` for canonical adapter selection while keeping query, mutation, and transaction APIs identical across MySQL, PostgreSQL, and SQLite.

- Apply SQLite transaction `readOnly` and isolation options through ORM-owned connection pragmas instead of rejecting them. Expose the logical mode through `Tx.ReadOnly` and `Tx.Isolation`, restore connection state before transaction completion, and verify read-only write rejection and subsequent connection reuse.
- Exclude the ORM-owned SQLite lock table from database-emptiness inspection so starting a transaction does not make a fresh database appear user-owned.

- Add a bounded SQLite ORM lock-cancellation regression alongside serialization, `NoWait` and transaction-release coverage. Waiting lock requests now have tracked evidence that caller context cancellation returns without an unbounded wait.

## Unreleased

- Implement SQLite `forUpdate`, `forShare`, and both `NoWait` modes through an ORM-owned transaction-scoped lock row. SQLite emits no lock suffix; `NoWait` temporarily uses a zero busy timeout. Go, PHP, Rust, and TypeScript carry the same lock mode through the plan contract.
- Preserve logical schema namespaces in SQLite physical table names by mapping `schema.table` to `schema__table`, preventing same-named tables from colliding in one database.
- Namespace generated SQLite index names with their qualified physical table name so module indexes with the same logical name cannot collide.
- Preserve overlapping foreign keys when one child column participates in multiple relation lines, including distinct composite constraints. Generated DDL ordering and migration diffing use relation metadata instead of collapsing those constraints to one column reference.
- Add adapter-neutral Go error classification through `ErrorCode`, `IsDuplicateKey` and `IsForeignKey`; callers do not inspect driver error types.
- The Go ORM client exposes ORM-owned pool statistics and opaque connection leases through `DB.Stats` and `DB.Acquire`, without exposing `database/sql` query access.
- The Go ORM client exposes `IsTransactionFinished`, allowing callers to recognize completed transactions without comparing driver-specific errors.
- Go generated `Get` methods now return `NO_ROWS` for an empty result; generated `GetOrNil` methods provide the explicit optional-row contract.
- AES version columns can be declared with `%% aes_version`; generators consume the resolved manifest metadata instead of assuming a column name.
- Audit redaction preserves values when a declared JSON path is absent and avoids materializing missing PostgreSQL parent objects.
- Go JSON and JSONS codecs use ordered-json values, preserving object member order and distinguishing empty objects from empty arrays.
- Go JSON and JSONS codecs convert tagged Go structs and raw `jsontext.Value` inputs into ordered-json without using the standard JSON encoder as the value boundary.
- The Go client uses the `v0.0.1` package at `github.com/polyspec/ordered-json/go` from the ordered-json monorepo.

## 0.0.1

- Initial development version.
- Added the shared IR, compiler, generated clients, database executors, migrations, authenticated versioned encryption, relations, batches, keyset pagination, and conformance checks.
- Added transaction-scoped PostgreSQL advisory locks to the Go ORM.
- Added ordered DDL installation through the Go ORM transaction boundary.
- Verify SQLite duplicate-key and foreign-key errors are mapped to the adapter-neutral ORM error contract.
- Add SQLite support to the adapter-neutral `SchemaInstalled` transaction operation for namespaced physical table names.
- Add adapter-neutral database-emptiness inspection for safe initial-schema preflight on PostgreSQL and SQLite.
- Exclude PostgreSQL system namespaces such as `pg_toast` from empty-database preflight detection.
- Update all four ORM clients to ordered-json revision `6d23a2a5e7c0c5d501d759b6d32a439661f153f2`. Go uses module `v0.0.0-20260916090424-6d23a2a5e7c0`; Rust, PHP, and TypeScript use the root package. The ORM version remains `0.0.1`.
