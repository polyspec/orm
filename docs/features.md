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
| point_type | Point type | partial | go: pass<br>php: partial<br>rust: partial<br>typescript: partial |
| interface_contract | Common interface verification | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| performance_gate | Hot-path performance standard | partial | go: pass<br>php: pass<br>rust: partial<br>typescript: planned |
| conformance_verification | Conformance verification | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |

## Current behavior

- `dsn_connection`: Open a database from one URI DSN. The URI scheme selects the driver, the timezone parameter sets the connection time zone, and the client plans statements in its own process.
- `model_queries`: Build conditions, joins, relations, columns, subqueries, aggregates, and pages with the generated model methods and read the rows as models and collections.
- `model_writes`: Create, create many, update with optional optimistic locking, save, and delete with optional recursive relation deletion, including the duplication assignments of an upsert.
- `transactions`: Run a callback in a transaction shared by the current execution flow, with savepoints for nested calls, deadlock retry, isolation, read-only mode, timeoutMs, row locks, named locks, and transaction-local values.
- `model_generation`: Generate the models from schema.json with the generator of each language. Go and Rust scan the sources and generate the chain methods they call; PHP resolves chains at run time and TypeScript types the scanned chains. With `--check`, the Go, PHP, and TypeScript generators compare the models with the output directory without writing.
- `schema_definition`: Build schema.json from Mermaid diagrams, render DDL for each dialect, import a database into a diagram, and compare two manifests into forward and rollback migrations.
- `schema_install`: Install a manifest through a connection: every client renders the create DDL of its dialect, creates the missing tables, and registers the manifest.
- `planner`: Validate a value-free request against the manifest and render the dialect SQL, bind slots, and assembly metadata in the client process. The four planners produce identical statements.
- `composite_keys`: Preserve every declared primary and foreign key component in identity, writes, relations, tuple conditions, and pages.
- `authenticated_encryption`: Encode authenticated versioned AES values and blind indexes, read mixed key versions, and rotate every encrypted column of a table in batches.
- `parameter_chunking`: Pad relation key lists to size classes, split relation keys and oversized root IN lists at the driver bind limit, merge the results, and reject root shapes that a merge would change.
- `constraints_and_relations`: Keep CHECK constraints, indexes, internal and external foreign keys, soft delete, immutable tables, and relation delete actions in the planner and the migration system.
- `audit_triggers`: Write an audit trail from schema directives. orm:audit_log declares the operation and change tables of another manifest installed on the same connection, and orm:audit attaches triggers that record every insert, update, and delete against the current operation.
- `point_type`: A point column stores a coordinate pair. Every dialect renders the point literal and its text conversion, and the Go model client binds and reads typed point values. The PHP, Rust, and TypeScript schema tools render the same DDL without typed client values.
- `interface_contract`: Every client exposes the public symbols declared in contracts/interfaces.json. Each language extracts its declarations from real syntax trees without running model code, and the comparator fails when a symbol, field, return, or error differs from the common interface.
- `performance_gate`: The Go and PHP clients keep hot-path latency within a measured ratio of the raw driver on the seeded MySQL bench database, and make perf-check fails when a workload exceeds its recorded bound. The Rust bench harness measures without an enforced bound, and the TypeScript standard is not built.
- `conformance_verification`: Run the same model chains in Go, PHP, Rust, and TypeScript on MySQL, PostgreSQL, and SQLite and compare the statements and results with the recorded vectors.

Run make feature-check to validate paths and execute every verification command declared for non-planned features. An implemented feature requires tests and paired documentation; partial and planned are incomplete.
