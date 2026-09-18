# Project checklist (0.0.1 completion)

Legend: `[ ]` not started, `[~]` in progress, `[x]` complete. Every item has a completion condition.
Rules: no polling or timers, no symlinks, one execution path, Mermaid is the source for diagrams, generated artifacts are stored separately, version 0.0.1 is fixed, public clients receive one DSN URI without a driver argument, and adopting the ORM needs only the client library.

## Current status (2026-09-17)

- The model syntax of the [DSL](dsl.md) is implemented in Go, PHP, Rust, and TypeScript.
- Every client validates and plans statements in the application process and ships its own model generator. No compiler service, daemon, WASM module, or extension is used.
- The four clients produce the same statements, binds, and results for **21 conformance vectors on MySQL, PostgreSQL, and SQLite**. Codec coverage is 80 vectors across the four clients.
- Open work: the conformance checker and recorded vectors, removal of the old compiler service sources, contracts, per-language schema tools, performance remeasurement, and the final CI and Pages runs.

## Common interface verification

- [x] I1 Define common structure, ownership, and state transitions in `interfaces.md` and Mermaid diagrams.
- [ ] I2 Regenerate `contracts/interfaces.json`, the generated component page, and the symbol checks for the model syntax.
- [ ] I3 Rewrite the implementation matrix for the model syntax and the in-process planners.
- [x] I4 Verify connections, transactions, relations, writes, and time zones on physical databases in all four clients.

## Online documentation

- [x] D1 Build the Markdown pages with VitePress and provide implementation status and local search.
- [x] D2 Render Mermaid diagrams to SVG and verify the no-JavaScript page content.
- [x] D3 Check `/orm/` links, anchors, direct HTML paths, search, mobile navigation, and repeated builds.
- [ ] D4 Deploy the current pages to https://polyspec.github.io/orm/ and verify them.

## Work lanes

| Lane | Scope | Completion condition |
|---|---|---|
| **E Engine** | `engine/*`, `cmd/ormgen`, protocol documents | The Go reference planner, dialects, schema build, and error rules are defined before client work. |
| **G Go** | `clients/go/*` | Go uses the shared schema and executor rules. |
| **P PHP** | `clients/php/*` | PHP plans in process and uses the shared executor rules. |
| **R Rust** | `clients/rust/*` | Rust plans in process and uses the shared executor rules. |
| **T TypeScript** | `clients/typescript/*` | TypeScript plans in process and uses the same request, result, and state rules. |
| **V Verification** | `tests/*`, `schema/*`, `scripts/*` | All supported clients produce the same checked results. |

Lane order is E → G/P/R/T → V. A client-specific feature remains incomplete until the same logical feature exists in every supported client.

## Stage 1 — Model syntax [complete]

- [x] M1 Implement model creation and `connect`, chains, connectors, groups, operators, value shapes, column comparisons, tuples, and subqueries in the four clients.
- [x] M2 Implement relations, joins, column selection, order, group, limit, finders, aggregates, and pages.
- [x] M3 Implement writes: `set`, `setRaw`, `new<Name>`, `plus`, `minus`, `create`, `creates`, `duplication`, `update`, `update(true)`, `save`, and `delete`.
- [x] M4 Implement flow-scoped transactions, savepoints, retry, options, row locks, and `connection.utils()`.
- [x] M5 Reject reserved column names and names that collide with generated methods.

## Stage 2 — In-process planning and generators [in progress]

- [x] N1 Port validation, planning, dialects, and DDL to PHP, Rust, and TypeScript; the Go client calls the engine packages directly.
- [x] N2 Provide one generator per language: `ormgen gen --lang go`, `vendor/bin/orm-gen`, the `orm-gen` npm bin, and the `orm-build` crate.
- [x] N3 Implement `utils().schema().install()` on MySQL, PostgreSQL, and SQLite in the four clients.
- [x] N4 Apply connection time zones on the three databases: PostgreSQL offset zones, instant reads, SQLite clock defaults, and the MySQL named-zone error.
- [ ] N5 Run the conformance checker against the in-process runners and record the vectors again.
- [ ] N6 Remove the compiler service, its message definitions, the WASM and FFI entry points, and the deployment units; update the Makefile and CI.
- [ ] N7 Compare SQLite datetime text given as a string in the stored six-digit form.
- [ ] N8 Run the 150-table Rust compile check with `orm-build`.

## Stage 3 — Schema tools per language [not started]

- [ ] L1 Build `schema.json` from `.mmd` files in every language.
- [ ] L2 Provide migration and import tools in every language.

## Schema and migration tools (Go) [complete]

- [x] T7.3 Implement deterministic `ormgen diff` and destructive-change checks.
- [x] T7.5 Implement YAML 1.2 and `point` conversions in Go, PHP, Rust, and TypeScript. Verify `point` DDL and SQL on MySQL, PostgreSQL, and SQLite.
- [x] T7.9 Compare Rust `mysql_async` 0.37.1 with sqlx 0.9 using equal SQL, binds, typed results, connection count, and fixture. Retain sqlx because neither measured workload shows the required 2x improvement.
- [x] T7.10 Exclude `multi_statement` from every public API because the supported databases cannot provide the same safe parameterized execution structure.
- [x] T7.13 Validate AES version columns, persist the current version on writes, and provide status and transactional rotation APIs in Go, PHP, Rust, and TypeScript.
- [x] T7.14 Include table and column comments in the manifest, schema hash, import, DDL, diff, and SQLite metadata.
- [x] T7.15 Add migration execution locking, transaction boundaries, and detailed recovery states for MySQL, PostgreSQL, and SQLite.
- [x] T7.16 Replace semicolon splitting with a dialect-aware SQL statement parser and preserve statement-level failure locations.
- [x] T7.17 Accept MMD, manifest JSON, metadata-bearing ORM SQL, and live DB schema sources for DDL, diff, structured plans, verification, recovery, idempotent migration, and verified rollback.
- [x] T7.19 Add AES blind-index schema declarations, keyed equality predicates, and write synchronization.
- [x] T7.20 Split oversized root `IN` predicates, preserve non-`IN` parameters, merge rows, sum count results, and reject unsafe query shapes.
- [x] T7.21 Add the `soft_delete` schema directive, apply active-row predicates to reads and updates, and convert deletes to timestamp updates.

## Documentation tasks

- [x] T7.D1 Keep each English page beside its Korean `.ko.md` page.
- [x] T7.D2 Keep headings, code fences, tables, and link targets aligned between paired pages.
- [x] T7.D3 Provide language links and search for both paths.
- [x] T7.D4 Remove informal, figurative, personifying, and ambiguous manual wording.
- [x] T7.D7 Check paired document structure in CI.
- [x] T7.D8 Check configured writing-style rules in CI.
- [ ] T7.D11 Regenerate the feature pages from the updated feature manifest.

## Verification checks

- [ ] G0 Measure client overhead of the in-process clients and record it in `perf.md`.
- [ ] G1 Compare the conformance output of the four clients with the recorded vectors on the three databases.
- [ ] G4 Run generated symbol, schema, and CI checks.
- [ ] G5 Verify the GitHub Actions build.
