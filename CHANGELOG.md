# Changelog

## Unreleased

- The Go ORM client exposes ORM-owned pool statistics and opaque connection leases through `DB.Stats` and `DB.Acquire`, without exposing `database/sql` query access.
- The Go ORM client exposes `IsTransactionFinished`, allowing callers to recognize completed transactions without comparing driver-specific errors.
- Go generated `Get` methods now return `NO_ROWS` for an empty result; generated `GetOrNil` methods provide the explicit optional-row contract.
- AES version columns can be declared with `%% aes_version`; generators consume the resolved manifest metadata instead of assuming a column name.
- Audit redaction preserves values when a declared JSON path is absent and avoids materializing missing PostgreSQL parent objects.

## 0.0.1

- Initial development version.
- Added the shared IR, compiler, generated clients, database executors, migrations, authenticated versioned encryption, relations, batches, keyset pagination, and conformance checks.
- Added transaction-scoped PostgreSQL advisory locks to the Go ORM.
- Added ordered DDL installation through the Go ORM transaction boundary.
