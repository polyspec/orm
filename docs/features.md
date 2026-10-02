# Feature definitions

The executable source is the repository feature manifest. Read the manifest, then its `source.read_order` paths and every path listed by the selected feature. Each entry defines inputs, outputs, state transitions, errors, client support, fixtures, tests, paired documentation, and executable verification commands.

| ID | Feature | Status | Client support |
|---|---|---|---|
| dsn_connection | DSN URI connection | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| model_queries | Model queries | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| model_writes | Model writes | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| transactions | Transactions | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| model_generation | Model generation | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| schema_definition | Schema definition and migration | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| schema_install | Schema installation | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| planner | In-process planner | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| composite_keys | Composite keys | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| authenticated_encryption | Authenticated encryption | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| parameter_chunking | Parameter chunking | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| constraints_and_relations | Constraints and relations | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| audit_triggers | Audit triggers | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| interface_contract | Common interface verification | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| performance_gate | Hot-path performance standard | partial | go: pass<br>php: pass<br>rust: partial<br>typescript: planned |
| conformance_verification | Conformance verification | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |

## Current behavior

- `dsn_connection`: Open a database from one URI DSN. The URI scheme selects the driver, the timezone parameter sets the connection time zone, and the client plans statements in its own process.
- `model_queries`: Build conditions, joins, relations, columns, subqueries, aggregates, and pages with the generated model methods and read the rows as models and collections.
- `model_writes`: Create, create many, update with optional optimistic locking, save, and delete with optional recursive relation deletion, including the duplication assignments of an upsert.
- `transactions`: Run a callback in a transaction shared by the current execution flow, with savepoints for nested calls, deadlock retry, isolation, read-only mode, timeoutMs, row locks, named locks, and transaction-local values. A SQLite write transaction takes the write lock at its start and waits for it up to busy_timeout. A test entry point of each client arms a rollback fault: the next rollback of a transaction whose callback failed runs and is reported as FAULT, so the transaction returns ROLLBACK.
- `model_generation`: Generate the models from the dbspec document set with the generator of each language. Go and Rust scan the sources and generate the chain methods they call; PHP resolves chains at run time and TypeScript types the scanned chains. With `--check`, the Go, PHP, and TypeScript generators compare the models with the output directory without writing.
- `schema_definition`: Parse and emit dbspec documents, compute the manifest and schema hashes of a document set, render the DDL of each dialect, introspect a database into a document, diff two schemas into plans and apply them with verification and recovery, and export and import Mermaid diagrams.
- `schema_install`: Install a dbspec document set through a connection: every client renders the statements of its dialect and creates the tables when none of them exists. A process loads the generated code of several document sets, and one connection serves all of them, each request with the model of its manifest hash.
- `planner`: Validate a value-free request against the manifest and render the dialect SQL, bind slots, and assembly metadata in the client process. The four planners produce identical statements.
- `composite_keys`: Preserve every declared primary and foreign key component in identity, writes, relations, tuple conditions, and pages.
- `authenticated_encryption`: Encode authenticated versioned AES values and blind indexes, read mixed key versions, and rotate every encrypted column of a table in batches.
- `parameter_chunking`: Pad relation key lists to size classes, split relation keys and oversized root IN lists at the driver bind limit, merge the results, and reject root shapes that a merge would change.
- `constraints_and_relations`: Keep CHECK constraints, indexes, internal and external foreign keys, soft delete, immutable tables, and relation delete actions in the planner and the migration system.
- `audit_triggers`: The audit setting of a table installs row triggers that copy every inserted, updated and deleted row into the declared history table with the operation id that the transaction sets.
- `interface_contract`: Every client exposes the public symbols declared in contracts/interfaces.json. Each language extracts its declarations from real syntax trees without running model code, and the comparator fails when a symbol, field, return, or error differs from the common interface.
- `performance_gate`: The Go and PHP clients keep hot-path latency within a measured ratio of the raw driver on the seeded MySQL bench database, and make perf-check fails when a workload exceeds its recorded bound. The Rust bench harness measures without an enforced bound, and the TypeScript standard is not built.
- `conformance_verification`: Run the same model chains in Go, PHP, Rust, and TypeScript on MySQL, PostgreSQL, and SQLite and compare the statements and results with the recorded vectors.

Run make feature-check to validate paths and execute every verification command declared for non-planned features. An implemented feature requires tests and paired documentation; partial and planned are incomplete.
