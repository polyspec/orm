# Project checklist (0.0.1 completion)

Legend: `[ ]` not started, `[~]` in progress, `[x]` complete. **P** marks parallel work. **→ T#** marks a prerequisite. Every item has a completion condition.
Rules: no polling or timers, no symlinks, one execution path, Mermaid is the source for diagrams, generated artifacts are stored separately, and version 0.0.1 is fixed.

## Current status (2026-09-12)

- **S0 complete:** measurements and decisions R1–R3 and F1–F3 are recorded in `docs/perf.md`.
- **S1 complete:** engine, generators, four clients, conformance harness, `ormgen tokens`, and the demo are implemented.
- **S2 complete:** relation, codec, type, 58-vector, and 150-table Rust fixture checks pass.
- **S3–S6 complete:** writes, joins, PHP compatibility, deployment, PostgreSQL, and SQLite support are implemented. Fixed-cost optimization continues in T7.11.
- Current conformance coverage is **59 vectors × 4 clients × 3 databases**. Codec coverage is 96 vectors across Go, PHP, Rust, and TypeScript.

## Common interface verification

- [x] I1 Define common structure, ownership, and state transitions in `interfaces.md`, `contracts/interfaces.json`, and Mermaid diagrams.
- [x] I2 Generate and compare Go, PHP, Rust, and TypeScript Query and Row interfaces.
- [x] I3 Compare 25 Request and Plan records. Check AST, reflection, and source-change counterexamples.
- [x] I4 Verify binding, query reuse, child copies, error preservation, dirty state, original versions, typed keys, and pagination in all four clients.
- [x] I5 Run generated-artifact, structure, state, document, and example checks in CI.
- [x] I6 Verify identity after direct native primary-key changes and reject nested collection key collisions.

## Online documentation

- [x] D1 Build the Markdown pages with VitePress and provide implementation status and local search.
- [x] D2 Render Mermaid diagrams to SVG and verify the no-JavaScript page content.
- [x] D3 Check `/orm/` links, anchors, direct HTML paths, search, mobile navigation, and repeated builds.
- [x] D4 Verify the GitHub Pages deployment at https://polyspec.github.io/orm/.

## Work lanes

| Lane | Scope | Completion condition |
|---|---|---|
| **E Engine** | `engine/*`, `cmd/ormgen`, protocol documents | Shared IR, Plan, token, and error rules are defined before client work. |
| **G Go** | `clients/go/*` | Go uses the shared schema and executor rules. |
| **P PHP** | `clients/php/*` | PHP uses the shared schema and executor rules. |
| **R Rust** | `clients/rust/*` | Rust uses the shared schema and executor rules. |
| **T TypeScript** | `clients/typescript/*` | TypeScript uses the same request, result, and state rules. |
| **V Verification** | `tests/*`, `schema/*`, `scripts/*` | All supported clients produce the same checked results. |

Lane order is E → G/P/R/T → V. A client-specific feature remains incomplete until the same logical feature exists in every supported client.

## Stage 0 — S0 baseline [complete]

- [x] Record toolchain, transport, database, PHP runtime, and baseline measurements.
- [x] Select Rust execution, PHP wire format, PDO policy, prepared statements, and performance gates.

## Stage 1 — S1 thin slice [complete]

- [x] Implement Mermaid parsing, schema build, IR v1, planner v1, MySQL dialect, FFI/WASM entry points, and the four clients.
- [x] Add conformance runners, token comparison, generated errors, and the thin-slice example.

## Stage 2 — S2 relations and codecs [complete; T2.15 pending]

- [x] Implement relation planning, relation pagination, keying, flattening, typed values, column references, codecs, and operator validation.
- [x] T2.15 Generate and compile a deterministic 150-table Rust fixture with `make rust-150-check`.
- [x] Run the current relation, codec, type, and database vectors.

## Stage 3 — S3 writes [complete]

- [x] Implement upsert, duplicate updates, save, update, delete, cascade delete, optimistic locking, and SQL hooks.
- [x] Run the write and cascade conformance vectors for Go, PHP, and Rust.

## Stage 4 — S4 joins and compatibility [complete]

- [x] Implement joins, aliases, aggregates, raw statements, named predicates, and relation result namespaces.
- [x] Implement the PHP compatibility parser and reject model-crossing parenthesis patterns.
- [x] Implement `getBy`, `getsBy`, and `getCountBy` finder generation with value-only terminals.

## Stage 5 — S5 hardening and deployment [complete]

- [x] Implement schema import and validation, schema-hash checks, generated errors, query hooks, packages, deployment units, and CI.
- [~] T5.3b Fixed-cost optimization: Go and PHP remain above the documented target and require typed direct-scan work.

## Stage 6 — S6 PostgreSQL and SQLite [complete]

- [x] Implement both dialects, their placeholders, quoting, returning clauses, full-text rules, AES/HEX/IP handling, and database configuration.
- [x] Run the four-client database vectors on MySQL, PostgreSQL, and SQLite.

## Stage 7 — S7 additional features [in progress]

Every S7 item requires implementation, tests, documentation, and static publication. A feature stays open if the same logical structure cannot be provided in Go, PHP, Rust, and TypeScript.

- [x] T7.1 Generate typed Protobuf messages for Go, PHP, Rust, and TypeScript; provide the Connect compiler server and `CompilerTransport` implementations; and pass 59 database vectors on MySQL, PostgreSQL, and SQLite in all four clients.
- [x] T7.3 Implement deterministic `ormgen diff` and destructive-change checks.
- [x] T7.4 Implement query-level `scope_p`, planner enforcement, generated methods, and tenant-isolation tests on MySQL, PostgreSQL, and SQLite in all four clients.
- [x] T7.5 Implement `curlfile`, YAML 1.2, and `point` conversions in Go, PHP, Rust, and TypeScript. Verify `point` DDL and SQL on MySQL, PostgreSQL, and SQLite.
- [x] T7.6 Implement database row streaming, cancellation, errors, and row ownership checks.
- [x] T7.7 Implement deterministic static query precompilation and schema-hash checks.
- [x] T7.8 Implement the TypeScript module, generated entity APIs and schema hash, `orm.toml` loader, native database drivers, structure and AST checks, and the 59-vector database runner for all three databases.
- [x] T7.9 Compare Rust `mysql_async` 0.37.1 with sqlx 0.9 using equal SQL, binds, typed results, connection count, and fixture. Retain sqlx because neither measured workload shows the required 2x improvement.
- [ ] T7.10 Implement and verify the `multi_statement` relation plan.
- [ ] T7.11 Implement typed direct scans for Go and PHP and rerun the performance gates.
- [x] T7.12 Generate and compile the deterministic 150-table Rust fixture with the locked Rust dependency set.
- [x] T7.13 Validate AES version columns, persist the current version on writes, and provide equivalent status and transactional row-rotation APIs in Go, PHP, Rust, and TypeScript. Verify repeat execution and all AES columns on physical databases.
- [x] T7.14 Include table and column comments in the manifest, schema hash, import, DDL, diff, and SQLite metadata. Unit and containerctl MySQL/PostgreSQL tests pass.
- [x] T7.15 Add migration execution locking, transaction boundaries, and detailed recovery states for MySQL, PostgreSQL, and SQLite. Recovery classifies target, source, and unsafe live states under the migration lock.
- [x] T7.16 Replace semicolon splitting with a dialect-aware SQL statement parser and preserve statement-level failure locations.
- [x] T7.17 Accept MMD, manifest JSON, metadata-bearing ORM SQL, and live DB schema sources for DDL, diff, structured plans, verification, recovery, idempotent database migration, and verified rollback execution.
- [x] T7.18 Run physical comment, migration-plan apply, repeat, drift, failure, lock contention, recovery, rollback, and rollback no-op tests through containerctl for MySQL and PostgreSQL.

## Documentation tasks

- [x] T7.D1 Keep each English page beside its Korean `.ko.md` page.
- [x] T7.D2 Keep headings, code fences, tables, and link targets aligned between paired pages.
- [x] T7.D3 Provide language links and search for both paths.
- [x] T7.D4 Remove informal, figurative, personifying, and ambiguous manual wording.
- [x] T7.D5 Document inputs, outputs, errors, state changes, and supported clients for each feature.
- [x] T7.D6 Mark unfinished features as not started or partial.
- [x] T7.D7 Check paired document structure in CI.
- [x] T7.D8 Check configured writing-style rules in CI.
- [x] T7.D9 Add examples and reproducible commands for completed S7 features.
- [x] T7.D10 Publish both language paths on GitHub Pages and run static checks.

## Verification gates

- [x] G0 Measure client overhead against the documented limits.
- [x] G1 Compare shared JSON and token streams.
- [x] G2 Complete the 150-table Rust compile check and run it in CI.
- [x] G3 Verify write and relation vectors for all implemented clients.
- [x] G4 Run generated symbol, schema, and CI checks.
- [x] G5 Verify the GitHub Actions build.
- [ ] G7 Close only after T7.1–T7.18 and T7.D1–T7.D10 meet their completion conditions.
