# Changelog

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
