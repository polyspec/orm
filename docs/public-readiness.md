# Public source readiness plan

Status: in progress. Version 0.0.1 remains fixed. The work ends at commits and an `origin/main` push; package publication and release creation are excluded.

## Development rule

Every predicted or observed defect requires a reproducing test before the implementation changes. The test must fail for the expected reason. The implementation is complete only when the same test passes and the existing suite still passes. If direct failure would damage a database, the test first uses an isolated fixture and then repeats on containerctl-managed MySQL, PostgreSQL, and SQLite where applicable.

Each item requires:

1. A unit or model test that reproduces the defect or missing invariant.
2. Implementation in the common specification, engine, generators, and all affected clients.
3. Cross-language structure and token checks when the public interface changes.
4. Physical database tests for database behavior.
5. English and Korean documentation with the same headings, examples, tables, and links.
6. A clean full check before the item is marked complete.

## P8: correctness and safety

- [x] P8.1 Schema migration diff covers indexes, unique constraints, full-text indexes, foreign keys, delete actions, nullability, defaults, types, and comments. PostgreSQL emits every required `ALTER COLUMN` operation.
- [ ] P8.2 Explicit table and column rename declarations preserve data and produce deterministic forward and rollback plans.
- [ ] P8.3 SQLite performs verified table rebuilds for supported structural changes and rejects unsafe rebuilds before execution.
- [ ] P8.4 Composite primary and foreign keys work through schema import, planning, generated APIs, identity, CRUD, relations, pagination, and AES rotation. Unsupported declarations fail during schema build.
- [ ] P8.5 Public encryption uses authenticated, versioned ciphertext in every client. Reads select the hidden row key version, mixed-version reads work, tampering fails, and rotation processes bounded resumable batches for every AES column in a row.
- [ ] P8.6 Equality search on encrypted data requires an explicit blind-index column. Legacy ECB data has an explicit conversion path and is not generated for new schemas.
- [ ] P8.7 Relation and `IN` parameters respect each database limit through deterministic chunking and preserve row order, key types, relation attachment, and errors.
- [ ] P8.8 Plan and prepared-statement caches have configurable bounds, deterministic eviction, close behavior, and pressure tests in all clients.

## P9: common ORM operations

- [ ] P9.1 Batch insert, upsert, update by primary key, and delete by primary key use typed inputs, bounded chunks, one transaction, and deterministic affected-row results.
- [ ] P9.2 Keyset pagination uses generated typed cursors, a total composite order, versioned cursor encoding, validation, forward/backward traversal, and duplicate-page tests.
- [ ] P9.3 Transaction callbacks do not retry by default. An explicit retry policy controls deadlock retries and documents callback requirements.
- [ ] P9.4 Transaction options cover isolation, read-only mode, nested savepoints, query timeout/cancellation, and supported row locks. Unsupported database modes return exact capability errors.
- [ ] P9.5 All clients load validated precompiled plan bundles and use them without a compiler request on a matching cache hit.
- [ ] P9.6 CHECK constraints and complete index/foreign-key metadata survive Mermaid, manifest, SQL, live database import, diff, migration, and verification.
- [ ] P9.7 Many-to-many traversal uses an explicit through entity and typed relation metadata in every client.
- [ ] P9.8 Relation existence/count predicates and declarative soft-delete policy use planner-enforced predicates in reads and writes.

## P10: verification

- [ ] P10.1 Model and property tests cover schema round trips, migration operation order, cursor round trips, query cloning, and codec round trips.
- [ ] P10.2 Fuzz tests cover Mermaid, manifest, IR, SQL migration statement, cursor, and ciphertext decoders without panics or unbounded allocation.
- [ ] P10.3 Failure-injection tests cover compiler failure, driver failure, cancellation, transaction failure, cache eviction, migration interruption, and rotation interruption.
- [ ] P10.4 Concurrency tests cover optimistic updates, deadlocks, savepoints, migration locks, AES rotation, and cache access.
- [ ] P10.5 Physical MySQL, PostgreSQL, and SQLite tests cover parameter limits, all migration operations, batch writes, keyset pagination, transaction modes, and encryption changes through containerctl without `-state`.
- [ ] P10.6 Go, PHP, Rust, and TypeScript produce identical common-vector results and compatible public structures for every added operation.

## P11: public repository files and package verification

- [ ] P11.1 Correct stale or false README and manual statements and add `README.ko.md`.
- [ ] P11.2 Add security reporting, contribution, conduct, and change-history documents with paired Korean files where the content is user-facing.
- [ ] P11.3 Complete package names, descriptions, licenses, repository links, runtime requirements, included files, and generated-artifact rules.
- [ ] P11.4 Verify `npm pack`, Composer validation and package contents, `cargo package`, and an external temporary Go module without publishing.
- [ ] P11.5 CI runs document rules, generated drift, interface checks, red-test regressions, physical database tests, package checks, and the full test suite.

## Completion

- [ ] G8 Every P8-P11 item passes its stated tests; `make check` passes; the working tree is clean; local `HEAD` equals `origin/main`; and final GitHub CI succeeds.
