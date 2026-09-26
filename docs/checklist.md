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
- [o] N5.1.1.4 Read SQLite state when no table uses `AUTOINCREMENT` and `sqlite_sequence` does not exist. Treat the verified absence as zero counters, still detect row changes and sequence changes when the table exists, and reject other query errors.
- [o] N5.1.1.4.1 State the SQLite counter rule in both checklist languages: zero counters require a verified missing `sqlite_sequence` table, and other query errors fail. Verify the documentation wording rule and matching item IDs and states.
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
- [o] N5.1.2.6.5 Use `StyledValue` in Rust styled-column codecs and generated setters and getters. Reject `SqlNull` on a non-null column at the setter, report an unselected field, and preserve SQL NULL and encoded null through storage, row arrays, and model JSON. Evidence: the shared 13-case fixture and Rust library and generator tests pass (23/23); a generated non-null styled setter rejects `SqlNull` and accepts encoded JSON null (1/1); `orm-tests integration --case json_values` passes on MySQL, PostgreSQL and SQLite twice and again after the setter test; workspace Clippy, formatting, English/Korean documentation and checklist checks pass.
- [ ] N5.1.2.6.6 Reject an undefined nested member in TypeScript styled-value JSON output instead of omitting the member. Add a RED case for `StyledValue.value({missing: undefined}).toJSON()`, correct the owning codec, and verify model output on MySQL, PostgreSQL, and SQLite.
- [o] N5.1.2.7 Keep generated Rust model fields private and reject access to a field that was neither selected nor assigned with `COLUMN_UNSELECTED`. Preserve SQL projection and return grouping values with checked row counts through `GroupRows` instead of partial models. Evidence: generated model and grouping cases execute on MySQL, PostgreSQL and SQLite, malformed group counts fail, and Rust code compiles against the result types.
- [o] N5.1.2.8 Check all table rows and declared counters after every conformance runner execution, including a failed execution. Report the runner error and any remaining database state change together. SQLite fault cases and MySQL, PostgreSQL, and SQLite physical cases verify failure reporting and cleanup.
- [o] N5.1.2.9 Make PHP and TypeScript conformance runners reject invalid derived integers and invalid result values, preserve exact ordered JSON numbers, propagate unexpected vector errors, and execute write vectors in transactions. Verify result cases and two identical executions with unchanged rows and counters on MySQL, PostgreSQL, and SQLite.
- [o] N5.1.2.10 Make the Go conformance runner reject invalid query binds and missing selected fields, preserve unexpected errors, verify the aggregate binary64 value, and execute write vectors in transactions. Verify its error cases and two identical executions with unchanged rows and counters on MySQL, PostgreSQL, and SQLite.
- [o] N5.1.2.11 Make the Rust conformance runner reject malformed bind and derived integer values, reject an aggregate average with different binary64 bits, propagate unexpected vector errors, and roll back a failed write vector. Verify the malformed encrypted prefix with RED and GREEN cases and the failed write state on MySQL, PostgreSQL, and SQLite. N5.1.2 still requires successful four-client comparison.
- [ ] N6 Remove the compiler service, its message definitions, the WASM and FFI entry points, and the deployment units; update the Makefile and CI.
- [ ] N7 Compare SQLite datetime text given as a string in the stored six-digit form.
- [ ] N8 Run the 150-table Rust compile check with `orm-build`.
- [o] N9 Preserve the callback's error type in a Rust transaction executed once. Verify rollback, commit, nested savepoint behavior, and distinct callback and rollback failures on MySQL, PostgreSQL, and SQLite.

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
- [o] G1.1.2.2 Execute the nine shared aggregate numeric cases from a TypeScript owner test under `clients/typescript/tests`. A coverage mutation must reject the central test path, the owner case must run twice with identical case IDs and results, and the old central path must be removed. The feature test inventory must detect owner `.mjs` files, and `model_queries` verification must invoke the owner test. This is a prerequisite for G1 owner coverage and does not complete the four-language database comparison.
- [o] G1.1.2.3 Put all remaining TypeScript client behavior tests under `clients/typescript/tests` and remove their old central paths. A tracked inventory test must fail before the move and pass after it; every test must use the current owner path in commands, feature declarations, and documentation. Execute owner unit cases and the model, schema tool, and SQLite cases on their required databases with bounded tests. Central conformance comparison stays under `tests/conformance`.
- [o] G1.1.2.4 Reject a test command that prints an invented JSON success report. Invoke the declared native test file and exact case filter, derive the current result from exit status and observed test events, and read database state with the checker before and after each database run. A tracked fake-report mutation must fail before the change and pass after it; owner and dependent-part tests remain in their own parts. Run bounded checker tests and record remaining feature coverage gaps.
- [o] G1.1.1 Register the Rust row-value decode test under `model_queries` so feature verification includes it; N5.1.2.2 depends on this registration.
- [ ] G4 Run generated symbol, schema, and CI checks. Verify that each exported Go, PHP, Rust, and TypeScript client API omits `multi_statement` and that an attempted call fails compilation or interface validation.
- [ ] G5 Verify the GitHub Actions build.
