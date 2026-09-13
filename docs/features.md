# Feature definitions

The executable source is the repository feature manifest. Read the manifest, then its `source.read_order` paths and every path listed by the selected feature. Each entry defines inputs, outputs, state transitions, errors, client support, fixtures, tests, paired documentation, and executable verification commands.

| ID | Feature | Status | Client support |
|---|---|---|---|
| crud_generation_directives | CRUD generation directives | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| dsn_connection | DSN URI connection | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| schema_migrations | Schema migration | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| composite_keys | Composite keys | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| authenticated_encryption | Versioned authenticated encryption | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| parameter_chunking | IN and relation parameter limits | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| batch_writes | Typed batch writes | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| keyset_pagination | Typed keyset pagination | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| transactions | Transaction options | implemented | go: partial<br>php: partial<br>rust: partial<br>typescript: partial |
| precompiled_plans | Precompiled plan bundles | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| constraints_and_relations | Constraints and relation predicates | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| conformance_verification | Cross-client conformance verification | partial | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |

## Current behavior

- `crud_generation_directives`: The schema parser preserves and validates one-line orm:* metadata, builds a deterministic CRUD manifest, and emits the shared interface for Go, PHP, Rust, and TypeScript.
- `dsn_connection`: Open a database from one URI DSN. The URI scheme selects the database and runtime compiler internals are not part of the caller API.
- `schema_migrations`: Compare modeled schema state and produce validated forward and rollback operations.
- `composite_keys`: Preserve every declared primary and foreign key component in identity, CRUD, relations, pagination, and rotation.
- `authenticated_encryption`: Encode authenticated versioned ciphertext, read mixed key versions, and rotate every encrypted column in bounded resumable batches.
- `parameter_chunking`: Split relation parameter tuples and oversized root IN lists by database limits while preserving result order and relation assembly. Reject unsafe root query shapes with an explicit error.
- `batch_writes`: Execute typed insert, upsert, primary-key update, and primary-key delete requests in one transaction with bounded chunks and deterministic counts.
- `keyset_pagination`: Provide versioned cursors, total composite ordering, validation, and forward and backward traversal.
- `transactions`: Expose opt-in retry, isolation, read-only mode, savepoints, row locks, and timeoutMs with capability errors. PostgreSQL applies timeoutMs as a transaction-local statement timeout; MySQL and SQLite reject it. The common interface declares no in-flight cancellation operation because the four clients cannot provide the same driver behavior.
- `precompiled_plans`: Load a validated plan bundle and execute a matching request without a compiler call.
- `constraints_and_relations`: Preserve CHECK, index, foreign-key, soft-delete, relation existence, relation count, and many-to-many through metadata in the planner and migration system. Generated clients execute the declared operations on MySQL, PostgreSQL, and SQLite.
- `conformance_verification`: Run common input vectors through Go, PHP, Rust, and TypeScript and compare normalized results for each database.

Run make feature-check to validate paths and execute every verification command declared for non-planned features. An implemented feature requires tests and paired documentation; partial and planned are incomplete.
