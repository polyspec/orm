# Changelog

## Unreleased

- Go generated `Get` methods now return `NO_ROWS` for an empty result; generated `GetOrNil` methods provide the explicit optional-row contract.

## 0.0.1

- Initial development version.
- Added the shared IR, compiler, generated clients, database executors, migrations, authenticated versioned encryption, relations, batches, keyset pagination, and conformance checks.
- Added transaction-scoped PostgreSQL advisory locks to the Go ORM.
- Added ordered DDL installation through the Go ORM transaction boundary.
