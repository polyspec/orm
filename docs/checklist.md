# Project checklist (0.0.1 completion)

Legend: `[ ]` waiting, `[~]` in progress, `[o]` complete, `[!]` temporarily bypassed.

## Common interface verification

- [o] I1 Define common structure, ownership, and state transitions in `interfaces.md` and Mermaid diagrams.
- [ ] I2 Regenerate `contracts/interfaces.json`, the generated component page, and the symbol checks for the model syntax.
- [ ] I3 Rewrite the implementation matrix for the model syntax and the in-process planners.
- [o] I4 Verify connections, transactions, relations, writes, and time zones on physical databases in all four clients.
- [o] I4.1 Compare all 20 PHP request record declarations with the shared field and nested-type definitions. Source mutations must fail the checker, and the PHP-only declaration check must pass.
- [o] I4.2 Check every interface error label and each recorded error result against `docs/errors.yaml`. Unknown or repeated labels and malformed error results must fail.

## Online documentation

- [o] D1 Build the Markdown pages with VitePress and provide implementation status and local search.
- [o] D2 Render Mermaid diagrams to SVG and verify the no-JavaScript page content.
- [o] D3 Check `/orm/` links, anchors, direct HTML paths, search, mobile navigation, and repeated builds.
- [ ] D4 Deploy the current pages to https://polyspec.github.io/orm/ and verify them.

## Stage 1 — Model syntax

- [o] M1 Implement model creation and `connect`, chains, connectors, groups, operators, value shapes, column comparisons, tuples, and subqueries in the four clients.
- [o] M2 Implement relations, joins, column selection, order, group, limit, finders, aggregates, and pages.
- [o] M3 Implement writes: `set`, `setRaw`, `new<Name>`, `plus`, `minus`, `create`, `creates`, `duplication`, `update`, `update(true)`, `save`, and `delete`.
- [o] M4 Implement flow-scoped transactions, savepoints, retry, options, row locks, and `connection.utils()`.
- [o] M5 Reject reserved column names and names that collide with generated methods.

## Stage 2 — In-process planning and generators

- [o] N1 Port validation, planning, dialects, and DDL to PHP, Rust, and TypeScript; the Go client calls the engine packages directly.
- [o] N2 Provide one generator per language: `ormgen gen --lang go`, `vendor/bin/orm-gen`, the `orm-gen` npm bin, and the `orm-build` crate.
- [o] N3 Implement `utils().schema().install()` on MySQL, PostgreSQL, and SQLite in the four clients.
- [o] N4 Apply connection time zones on the three databases: PostgreSQL offset zones, instant reads, SQLite clock defaults, and the MySQL named-zone error.
- [ ] N5 Run the conformance checker against the in-process runners and record the vectors again.
- [~] N5.1 Run all four clients on MySQL, PostgreSQL, and SQLite, compare every vector with recorded expectations, and confirm repeated execution leaves the observed database state unchanged.
- [o] N5.1.1 Require all four outputs, reject stale and changed repeated results, bound runner execution, verify all table rows and declared counters, restore only declared test counters, and test counter observation and cleanup on MySQL, PostgreSQL, and SQLite.
- [o] N5.1.1.1 Compare and record JSON numbers without float64 rounding; distinguish integers beyond 2^53 while treating equivalent decimal forms as equal.
- [o] N5.1.1.2 Reject duplicate keys in nested JSON evidence and expectations, and fail when a database expectation file is missing.
- [o] N5.1.1.3 Redact database connection strings in runner command logs for both `-dsn` and `--dsn` flags.
- [~] N5.1.2 Make all four conformance runners propagate unexpected errors, clean write state on failure, and enforce the common aggregate scalar rule on all three databases.
- [o] N5.1.2.1 Make Go value conversion, host encoding, and generated model assignment report malformed, null, overflowing, and unsupported values. Verify valid values with executable tests; propagate assignment failures through row assembly and validate insert fields before writing.
- [o] N5.1.2.2 Reject invalid and nonfinite PHP and TypeScript aggregate scalars and verify nearest binary64 conversion with the shared nine-case fixture.
- [ ] N5.1.2.3 Preserve exact decimal column values in generated models in all four clients. A generated decimal field must not accept `48.0450` as an approximated binary64 value; add equivalent RED cases and GREEN database evidence for MySQL, PostgreSQL, and SQLite. Scalar aggregate results follow their separate finite binary64 conversion rule.
- [o] N5.1.2.4 Require an `auto` column to be a non-null signed `i64` primary key in the Go, PHP, Rust, and TypeScript schema builders. Each language executes the same accepted and rejected Mermaid cases and reports the source line for a rejected declaration.
- [o] N5.1.2.4.1 Read a live SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` column as a signed `i64` automatic key in each schema tool, while preserving a non-automatic `INTEGER` column as `i32`. Verify physical SQLite import and schema build in the clients.
- [ ] N5.1.2.5 Replace Go scalar and collection key string fallback with an exact typed key representation. Verify that unsupported values fail, distinct values cannot collide, and relation, split-query, and collection callers propagate errors.
- [~] N5.1.2.6 Distinguish SQL NULL, an encoded null value, and an unselected styled value column in the four clients on all three databases. Verify storage text, getters, row arrays, model JSON output, and errors with one shared fixture.
- [o] N5.1.2.6.1 Make Go styled values explicit in codecs and generated model setters and getters; verify the shared states, row arrays, model JSON, and errors on MySQL, PostgreSQL, and SQLite.
- [o] N5.1.2.6.2 Use `StyledValue` in PHP styled-column setters, getters, codecs, and model output. Verify the shared state cases and physical model behavior on MySQL, PostgreSQL, and SQLite.
- [o] N5.1.2.6.3 Use `StyledValue` in TypeScript styled-column setters, getters, codecs, and model output. Verify the shared state and codec cases and physical model behavior on MySQL, PostgreSQL, and SQLite.
- [o] N5.1.2.6.4 Pass explicit styled values to the Go conformance write runner and return each setter error before writing. Verify model generation, runner compilation, and Go model and runtime tests on MySQL, PostgreSQL, and SQLite.
- [ ] N6 Remove the compiler service, its message definitions, the WASM and FFI entry points, and the deployment units; update the Makefile and CI.
- [ ] N7 Compare SQLite datetime text given as a string in the stored six-digit form.
- [ ] N8 Run the 150-table Rust compile check with `orm-build`.

## Stage 3 — Schema tools per language

- [ ] L1 Build `schema.json` from `.mmd` files in every language.
- [ ] L2 Provide migration and import tools in every language.

## Schema and migration tools

- [o] T7.3 Implement deterministic `ormgen diff` and destructive-change checks.
- [o] T7.5 Implement YAML 1.2 and `point` conversions in Go, PHP, Rust, and TypeScript. Verify `point` DDL and SQL on MySQL, PostgreSQL, and SQLite.
- [o] T7.9 Compare Rust `mysql_async` 0.37.1 with sqlx 0.9 using equal SQL, binds, typed results, connection count, and fixture. Retain sqlx because neither measured workload shows the required 2x improvement.
- [o] T7.10 Exclude `multi_statement` from every public API because the supported databases cannot provide the same safe parameterized execution structure. G4 owns the executable exclusion check for all four clients.
- [o] T7.13 Validate AES version columns, persist the current version on writes, and provide status and transactional rotation APIs in Go, PHP, Rust, and TypeScript.
- [o] T7.14 Include table and column comments in the manifest, schema hash, import, DDL, diff, and SQLite metadata.
- [o] T7.15 Add migration execution locking, transaction boundaries, and detailed recovery states for MySQL, PostgreSQL, and SQLite.
- [o] T7.16 Replace semicolon splitting with a dialect-aware SQL statement parser and preserve statement-level failure locations.
- [o] T7.17 Accept MMD, manifest JSON, metadata-bearing ORM SQL, and live DB schema sources for DDL, diff, structured plans, verification, recovery, idempotent migration, and verified rollback.
- [o] T7.19 Add AES blind-index schema declarations, keyed equality predicates, and write synchronization.
- [o] T7.20 Split oversized root `IN` predicates, preserve non-`IN` parameters, merge rows, sum count results, and reject unsafe query shapes.
- [o] T7.21 Add the `soft_delete` schema directive, apply active-row predicates to reads and updates, and convert deletes to timestamp updates.

## Documentation tasks

- [o] T7.D1 Keep each English page beside its Korean `.ko.md` page.
- [o] T7.D2 Keep headings, code fences, tables, and link targets aligned between paired pages.
- [o] T7.D3 Provide language links and search for both paths.
- [o] T7.D4 Remove informal, figurative, personifying, and ambiguous manual wording.
- [o] T7.D7 Check paired document structure in CI.
- [o] T7.D8 Check configured writing-style rules in CI.
- [o] T7.D8.1 Keep persistent rules in `AGENTS.md` and task deliverables in this checklist. Remove unnumbered procedure, work-lane, and dated status prose; reject its return with the checklist checker while preserving existing item IDs and states. Evidence: a failing checker case before the cleanup, a passing `make checklist-check` and paired document checks, and one local commit containing both language versions and the record.
- [ ] T7.D11 Regenerate the feature pages from the updated feature manifest.

## Verification checks

- [ ] G0 Measure client overhead of the in-process clients and record it in `perf.md`.
- [ ] G1 Compare the conformance output of the four clients with the recorded vectors on the three databases.
- [o] G1.1.2 Require current-run feature coverage reports for every claimed client and database, exact case IDs, and two equal result and state runs. Mutation tests reject missing implementation claims, language tests, database runs, cases, repeats, and undeclared results. The feature check remains red until every feature provides executable coverage commands.
- [o] G1.1.2.1 Enforce the AGENTS.md owner and dependent-part test-location rule in `scripts/features/coverage.mjs`. Mutation tests must reproduce missing owner or dependent-part evidence and central or outside test paths as RED; valid owner and dependent-part execution must be GREEN. `make feature-check` depends on this checker and remains RED while feature contracts lack current execution evidence.
- [o] G1.1.1 Register the Rust row-value decode test under `model_queries` so feature verification includes it; N5.1.2.2 depends on this registration.
- [ ] G4 Run generated symbol, schema, and CI checks. Verify that each exported Go, PHP, Rust, and TypeScript client API omits `multi_statement` and that an attempted call fails compilation or interface validation.
- [ ] G5 Verify the GitHub Actions build.
