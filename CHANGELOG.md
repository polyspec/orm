# Changelog

Borrow the erased Send callback directly in nested savepoints (N9.2.1),
instead of requiring a reference to its Box allocation. Reproduce the
strict borrowed-Box lint and a tracked callback-reference compile failure;
both are Green without suppression. Add separate owning transaction tests
and the reusable rust-send-savepoint-check. Rust 1.98.1 strict Clippy and
all three MySQL/PostgreSQL/SQLite cases pass twice, preserving Send futures,
nested and outer rollback, exact fixture rows, callback errors, frame
restoration and connection reuse. Connection-local temporary tables avoid
user-table writes and persisted fixture cleanup. The shared Make test
environment declares the SQLite URI so existing test entry points inherit
it. Owner library/tests Clippy, scoped formatting and paired documentation
checks pass on macOS arm64. This does not change public transaction
semantics or claim four-client database conformance.

Resolve immutable physical graphs in four clients (T7.17.2.4). Preserve
ordered tables/columns/FKs, exact identities and independent constraints;
reject duplicate IDs/names, dangling or wrong-owner links and bounded count/
string excess with value-free JSON-pointer errors. Missing-API Reds in all
clients and native Go integer-version rejection are Green. PHP exhausted its
128M limit in the established connected stress case; share reference-free
copy-on-write arrays while explicitly detaching references instead of raising
that limit. The same case now peaks at 62 MiB of PHP process allocation.
The reusable physical-graph-check passes 28 graph and five limit vectors
twice per client, plus 25 column and 26 FK regressions. Each client retains
2000 tables, 60000 columns and 10000 connected FKs. Owner Rust 1.98.1 Clippy,
TypeScript compilation on declared Node 26.10.0 and paired-record checks
pass on macOS arm64. Correct the byte-limit fixture's initially miscalculated
location using a separate string-byte sum. This does not prove rendered
performance, complete physical schemas, imports, DDL or DB conformance.

Preserve exact physical foreign keys in four clients (T7.17.2.3). Retain
constraint names, ordered column pairs, independent actions, match and deferral;
reject malformed/contradictory records without value exposure. Extract shared
bounded validators for columns/FKs and replace Rust ColumnError with RecordError.
Missing API Reds are Green. The exposed physical-fk-check passes all 26 FK and
25 column vectors twice per client, plus immutable/sparse/arity limits and 2000
retained FK records. Rust 1.98.1 Clippy, TypeScript compilation on declared Node
26.10.0, PHP syntax and paired documentation checks pass on macOS arm64.
Record-retention timing does not prove connected-graph or rendered performance;
graph resolution, imports, physical DDL and execution remain incomplete.

Preserve immutable physical column records in all four clients (T7.17.2.2).
Keep native SQL, absent/NULL/literal/expression defaults, identity/computed
generation, exact names/comments and ordered options without coercion.
Reject unknown fields, malformed types, invalid UTF-8 and bounded payload excess.
Missing APIs and PHP referenced-input alias Reds are Green; TypeScript compile
narrowing is corrected. The tracked physical-column-check passes 25 common
vectors twice per client plus byte/count/encoding/alias guards. TypeScript
compilation, owner Rust Clippy, PHP syntax and paired documentation checks pass.
Structural acceptance is not SQL validation, physical import or execution.

Preserve exact physical catalog/schema/table/column identities separately from
logical model identifiers (T7.17.2.1). Immutable components and explicit UTF-8
hex keys distinguish case and namespace composition without normalization.
Reject empty/control/invalid/oversized components with value-free errors.
Missing APIs in Go/PHP/Rust/TypeScript and accepted TypeScript sparse arrays
are Red-to-Green. The reusable physical-identity-check passes ten common
vectors twice in every client, plus byte/encoding/alias checks. Owner Clippy,
TypeScript compilation, PHP syntax, checklist and documentation rules pass.
This is not physical import, annotation parsing, DDL or DB conformance.

Correct prohibited wording in the final Korean mutation-permit records after
the documentation check failed and the prior commit continued. The unchanged
rule is Green for all 21 bilingual pairs; paired checklist and fresh static
documentation checks pass (42 pages, 437 targets, 26 diagrams). Native code
and acceptance criteria are unchanged.

Require explicit fallible pre-commit permission for native Rust row mutations.
After transactional write verification, a rejected permit rolls back before
commit-start publication or detached ownership. Preserve the permit failure;
invalid assignments never reach permission. Required-argument API compile Red
is Green; actual MySQL/PostgreSQL/SQLite insert/update/delete rejection and
accepted commits pass. All 20 focused owner tests and owner Clippy --no-deps
pass. Existing callers provide explicit permits without compatibility defaults.
Changed Rust formatting, checklist/rules and fresh docs build/static checks
pass: 42 pages, 437 targets, 26 diagrams. Durable journal/authorization/recovery, other platforms and four-client conformance remain incomplete.

Return MySQL expression-default identities with a bounded, explicitly selected
transactional input locator. Prove no existing match, exact one-row post-write
values and actual keys before commit; reject ambiguous locators without writing.
Do not reevaluate defaults, alter user schemas or add triggers. Fix unheld MySQL
target metadata locking before engine/descriptor checks. UUID identity and real
table-lock Reds are Green; other added cases are regressions. Actual three-DB
volatile text keys, NULL selectors, cancellation/coercion rollback and indexed
concurrent identities pass in 21 focused tests; owning Clippy passes. Split
validation, RETURNING and locator responsibilities. Native key-insertion work is
verified; durable authority/recovery, other OS and four-client work remain.
Checklist/rules and modified Rust formatting checks pass. Fresh docs build and
static checks pass 42 pages, 437 internal targets and 26 diagrams.

Return generated and literal-default keys with authoritative metadata, bounded
RETURNING or MySQL statement acknowledgement/server DEFAULT. Generated-key
and MySQL literal-default Reds are Green; 21 focused tests pass on actual local
three-database fixtures, including concurrency, defaults, constraint/coercion
rejection and cancellation rollback. Owning Clippy --no-deps passes; the existing
dependency borrowed-Box lint fails (N9.2.1). Omitted MySQL expression-default
keys remain unresolved (T7.17.1.13.2.2), rejected before writing, not completed.
Full insertion/editing, four-client and other-platform requirements remain open.

Correct prohibited prose in checklist, interface and performance documents
without changing technical requirements, measurements or validation rules.
The existing documentation-rules Red is Green for all 21 language pairs.
Fresh documentation build and static checks pass 42 pages, 437 internal
targets and 26 diagrams, including no-JS reading and interactive navigation.
Checklist validation also passes (T7.D8.2).

Add caller-authorized native Rust update/delete and explicit-key insertion in
fresh discard-on-drop transactions. Lock original keys, compare descriptors and
exact baselines, bind typed values and verify stored values/affected rows before
commit. Reject generated-column assignment, coercion and unsafe MySQL engine or
unverified trigger visibility. Publish value-free phases and retain commit
ownership after caller cancellation; distinguish confirmed PostgreSQL rejection
from missing acknowledgement without automatic retries.
Public API/verification compile Reds, INTEGER-key preparation and explicit
commit-rejection Reds are Green. Eighteen focused library/baseline/page/bind/
mutation tests pass on macOS, including actual MySQL/PostgreSQL/SQLite writes,
quoted composite keys, key changes, schema conflicts, FK/unique preservation,
generated/default/NULL values, cancellation rollback, lock contention and abort
cleanup. PostgreSQL owned connection termination verifies an indeterminate
commit; detached successful commit remains observable. Other new cases are
regressions, not claimed Reds. Prepare PostgreSQL queries with declared bind
codec types and validate borrowed inputs before value cloning.
Test-owned resources, including failed-Red fixtures, are removed. Automatic
primary-key insertion, durable operation identity/authorization,
four-client conformance and other-platform gates remain incomplete.
The checklist checker passes. The documentation rules check still fails on
existing prohibited prose; track correction separately as T7.D8.2.


Extend native Rust tool binds with explicit typed NULLs, binary, bool, native
float bits, exact decimal and MySQL unsigned values through SQLx driver codecs.
Share bind paths across bounded queries and affected-row execution. Reject
unsupported dialect kinds, malformed/nonrepresentable inputs and parameter
count/value budgets before prepare/execute; do not format values into SQL.
Missing API compile Red is Green. Three added validation/physical use-path
cases and all 40 focused native/library/CLI tests pass. Actual three-database
fixtures verify stored values, all supported NULL kinds, affected rows, native
constraint errors, rejected-write preservation and rollback; PostgreSQL float
NaN/infinity/negative-zero and SQLite infinity bindings also pass. Other cases
are added regressions. Correct the SQLite boolean expectation using measured
INTEGER storage, not a codec change, and avoid premature per-dialect pass logs.
Owned tables/files are removed. Native binds do not prevent column/server
coercion: locked row mutation/post-verification and four-client
conformance remain pending.

Capture immutable Rust RowSnapshot baselines from qualified table pages with
checked non-null primary-key identity, exact typed original cells and an 8 MiB
bounded SHA-256 descriptor/value revision. Distinguish descriptor changes,
missing/changed rows and ambiguous identity; avoid values in Debug/errors.
Missing API compile Red is Green. Three baseline cases and 13 focused tests
pass; actual MySQL/PostgreSQL/SQLite owned rows detect changes and accept exact
restoration. Validation/type/budget/live additions are regression tests.
This is a pure comparison API, not database locking, writes or authorization.
Typed binds, locked mutations and four-client conformance remain pending.

Add explicit qualified Rust table-page reads with native typed values,
descriptor column provenance and declared primary-key ordering. Quote native
identifiers, enforce a fresh read-only scope, bound limit/offset and row encoding,
and use one sentinel row for continuation. Reject changed descriptors or prepared
column mismatches instead of returning ambiguous metadata. Missing API compile
Red is Green on MySQL, PostgreSQL and SQLite. Empty/view, quoted-name, bounds,
8 MiB overflow/recovery and assembly regressions pass; ten focused tests pass.
Offset pages remain independent snapshots, not edit authorization.
Four-client conformance remains pending.

Classify native MySQL SYSTEM VIEW relations as views in the Rust qualified
table descriptor. An actual-MySQL test first confirmed the native kind and
reproduced the rejected descriptor, then passes without primary-key identity
or database writes. Six focused metadata/catalog tests pass, retaining ordinary
table/view coverage on MySQL, PostgreSQL and SQLite. Unknown kinds still fail;
no write authorization or four-client conformance is implied.

Verify styled-setter Result handling with generation cases, unknown-method
rejection and a compiled controller use case.

Recognize Rust Result handling immediately after styled setters without
generating column methods for `expect` or `unwrap`. Preserve subsequent
model-call validation.

Expose qualified Rust table descriptors with bound catalog names, native
column types, generated flags and constraint-ordered primary keys. Distinguish
SQLite nullable legacy keys, DESC keys, INTEGER rowid aliases and WITHOUT
ROWID keys before declaring reliable row identity. Missing public API compile
Red is Green on MySQL, PostgreSQL and SQLite. Added view, invalid-name,
unsupported-namespace and untyped-column regressions pass; twelve focused
library/catalog/read-only/column/metadata tests pass. Descriptors do not
authorize mutations or complete physical imports or four-client conformance.

Preserve finite Rust grid decimals as exact plain strings using pinned
BigDecimal 0.4.11 rather than binary floats or fixed-precision model codecs.
Restore PostgreSQL result scale from public driver bytes and reject any
value-changing adjustment. Missing decimal variant compile Red is Green
on actual MySQL 65-digit decimals and PostgreSQL scale-preserving results;
SQLite retains its actual storage classes. Added 200-digit/exponent, NULL,
budget and nonfinite-rejection regressions pass. Fourteen integration,
eleven CLI and five library tests pass. Nonfinite numeric support and
temporal values remain pending.

Preserve Rust grid float32/float64 IEEE-754 bits and full-range unsigned
integers without changing strict catalog scalar decoding. Missing typed
variants compile Red is Green on actual three-database float64 results,
PostgreSQL float32/signed-zero/NaN and MySQL u64::MAX. Added numeric NULL
and byte-budget regressions pass. Thirteen integration tests, eleven CLI
tests and five library tests pass. Decimal/temporal types remain
pending.

Expose Rust typed read-only grid results with byte-preserving binary cells,
distinct from text, empty text and NULL. Share streaming/metadata budgets
and the enforced read-only connection scope with catalog tooling rather
than duplicating transaction policy. Keep strict catalog value semantics.
Missing typed API compile Red is Green on MySQL, PostgreSQL and SQLite;
post-implementation budget, mutation, empty metadata and bind regressions
pass. Twelve owning integration tests, eleven CLI tests and five library
tests pass. Additional query types and other-client grid APIs remain
pending; no complete SQL-grid claim is made.

Add bounded read-only catalog queries with dialect AST validation and
database-enforced scopes on dedicated discard-on-drop connections. Reject
write CTEs, mutation/transaction statements, SELECT INTO, locks and executable
comments; retain original SQL and explicitly reject unsupported grammar.
Bound SQL/parser/visitor depth. Validate actual read-only state on PostgreSQL
and SQLite, MySQL function-write rejection, unchanged rows and recovery after
errors. Event-driven aborted-scope tests verify no pool reuse on all three DBs;
this is not measured cancellation latency or an external-function sandbox.
Missing API compile Red is Green; eleven owning integration tests, two owning
policy/disposal unit regressions and eleven CLI tests pass. Correct the initial
MySQL session-variable test assumption, without changing server configuration.
Keep additional SQL result types pending.

Expose ordered prepared column names/native type names with bounded query
rows, including empty results and duplicate aliases. Catalog connections
provide the same public query operation. Bound metadata to 2,048 columns
and 64 KiB of name/type bytes without logging values. The missing result
API compile Red is Green; the three-database query case, ten owning
integration tests, one metadata-budget unit case and eleven CLI tests pass.
Metadata budget tests are post-implementation regressions, not pre-fix Red.
Read-only execution policy and additional SQL types remain
incomplete; this API executes only statements authorized by its caller.

Accumulate Rust tool/catalog query rows from driver streams with validated
row and JSON-result budgets (100,000 rows / 64 MiB ceilings). Reject budget
overflow without partial success or value exposure, and reject multiple
statements instead of merging their result sets. Preserve checked unsigned
decoding in MySQL prepared results; its existing overflow test exposed a
regression during this change and is Green after type-directed decoding.
Missing-budget API compile Red and multiple-statement runtime Red are Green.
Nine owning query/catalog/accessor tests and all eleven CLI tests pass;
budget/connection reuse and scalar checks execute on all three databases.
These limits bound accumulated results, not driver packets or DB execution;
arbitrary SQL types and read-only isolation remain separate work.

Return checked Rust tool integer, optional-integer and boolean conversions
instead of zero/false defaults. Preserve optional SQL NULL and reject
invalid required values without exposing contents. Propagate failures
through catalog and migration readers while retaining transaction cleanup.
The missing Result API compile Red is Green; two accessor tests (including
all three databases), four catalog tests, one cell test and five CLI
regressions pass. Invalid SQLite history remains unchanged after rejection;
plan/apply/rollback/recovery passes on MySQL, PostgreSQL and SQLite.

Reject unsupported Rust tool/catalog cells, invalid UTF-8 and unsigned
integer overflow instead of substituting NULL, replacement text or wrapped
integers. Propagate decoding errors without including cell values. Seven
lossy cases fail before correction and pass on SQLite, MySQL and PostgreSQL
afterward; four catalog owner tests and the SQLite CLI rowid case pass.
Numeric and boolean accessor validation remains a separate pending item.

Expose Rust DSN-only catalog connections under `live-db`; move the existing
reader into the library and make the CLI use the same implementation. Reject
missing SQLite database files without creating them and release connections
before pool closure. Missing-API and SQLite-creation Red cases are Green.
Four public API owner tests execute SQLite, MySQL and PostgreSQL; the existing
SQLite CLI automatic-rowid import case passes. Lossless physical import and
checked arbitrary-cell decoding remain incomplete.

Document the Rust ORM mapping for engine selection, schema validation and
installation, transaction options, cancellation, encrypted columns, and audit directives.

Update the Rust styled-value model JSON test to verify the explicit value wrapper while
retaining ordered JSON members and number text.

Close the checked-out Rust connection immediately when a statement or transaction
future is dropped. This rolls back an interrupted transaction and releases a
single-slot pool connection without returning an active server operation to the
pool. The Rust zone tests cover SQLite, MySQL and PostgreSQL.


Add Rust `Db::transaction_once` for a callback that runs once and returns its own error type.
It uses a savepoint inside an active transaction and reports both the callback and rollback
failures when both fail. Database errors remain distinct from callback errors.

## Unreleased — MySQL CHECK constraint namespace

Keep persistent development rules in `AGENTS.md` and concrete work in the project checklist. The checklist checker now rejects unnumbered policy and status prose, so dated progress claims cannot replace item states and executable evidence. The waiting generated-interface check must verify the `multi_statement` exclusion in each public client API.

Add the connection options `poolIdleSize`, the maximum idle connections of the pool, and `poolLifetimeMs`, the lifetime of a pool connection in milliseconds, to the Go (`PoolIdleSize`, `PoolLifetimeMs`), TypeScript (`poolIdleSize`, `poolLifetimeMs`) and Rust (`pool_idle_size`, `pool_lifetime_ms`) clients. A connection released while the pool already keeps `poolIdleSize` idle connections is closed, and a connection whose lifetime has passed is closed while it is idle or when it is released. Zero or unset keeps the previous behavior: up to the pool size of idle connections, no lifetime in Go and TypeScript, and the 30-minute pool lifetime in Rust. A negative value or an idle size above the pool size returns `CONFIG`. The PHP client has no pool and returns `CONFIG` when either option is not zero.

Add the error code `READ_ONLY` for a write that a read-only server or connection rejects: PostgreSQL SQLSTATE 25006, MySQL errors 1290 and 1792, and SQLite `SQLITE_READONLY` (8) with its extended codes. The Go, PHP, Rust and TypeScript clients return `READ_ONLY` with the driver message instead of the unmapped driver error. The database tests check the code for a write through the PostgreSQL standby and the MySQL read-only replica and for a write to a SQLite database file that the process may only read.

Make a pool size of zero or unset open at most 10 connections in the Go, TypeScript and Rust clients. The Go client opened an unlimited number of connections, TypeScript `{ poolSize: 0 }` opened an unlimited number on MySQL, and Rust `Db::connect(dsn, 0, config)` panicked. Tests run six concurrent transactions on a pool of two and check that at most two run and at most two connections are open.

Document in `docs/config.md` how a primary and its replicas are used: one connection per server, selected per model or row with `connect`; the ORM does not route statements, and SQLite is single-node only. The database tests of the four clients open a primary and a replica connection side by side on MySQL and PostgreSQL and check that a replica reads committed rows, rejects a write, and is not used by a model connected to the primary or by a model inside a transaction of the primary.

Make the four clients work through PgBouncer in transaction mode. The PHP and Rust clients send the PostgreSQL `statement_timeout` of `statementTimeoutMs` as a startup parameter, as Go and TypeScript do, instead of `SET SESSION statement_timeout`, which stayed on the pooled server connection and bounded the statements of other client connections. The Rust client no longer sends the startup parameter `extra_float_digits`, which PgBouncer rejected; float8 values stay exact. The TypeScript client cancels a PostgreSQL statement with the protocol cancel request (process id and secret key) instead of `pg_cancel_backend`, whose process id is not a server process behind a pooler. `make client-pooler-check`, part of `make check`, runs the client database tests through PgBouncer and ProxySQL, and `docs/config.md` lists the pooler settings and states that the schema tools connect to the primary directly.

Make `make test-servers` also start a read-only MySQL replica and a PostgreSQL standby of the primaries, ProxySQL in front of the MySQL primary, and PgBouncer in transaction mode in front of the PostgreSQL primary, on `TEST_MYSQL_REPLICA_PORT` (33181), `TEST_POSTGRES_REPLICA_PORT` (55481), `TEST_PROXYSQL_PORT` (33182) and `TEST_PGBOUNCER_PORT` (55482). The start returns after ProxySQL and PgBouncer log the line they write once they listen. The environment file adds `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN` and `ORM_TEST_PGBOUNCER_SINGLE_DSN`; the last names a PgBouncer database that reaches `orm_test` through one server connection.
Make SQLite write transactions in the Go, PHP, Rust and TypeScript clients begin with `BEGIN IMMEDIATE` and hold the write lock from their start; a read-only transaction begins with `BEGIN`. Every SQLite connection waits up to 5000 milliseconds for a lock, and the DSN parameter `_pragma=busy_timeout(ms)` sets another time in all four clients; the Go and TypeScript clients waited for no lock unless the DSN set one. A lock that another connection still holds when the wait ends returns `CANCELED` instead of `DEADLOCK`, so a transaction does not run again after the wait; SQLite `LOCKED` remains `DEADLOCK`. A transaction that read and then wrote failed with `DEADLOCK` when another connection wrote at the same time: 8 connections of one Go process committed 20 of 80 such transactions without retries, and after the change several connections and several processes of each client commit all of them. The PHP client runs the `_pragma=name(value)` parameters of a SQLite DSN, which it ignored before, and every client rejects `_txlock` with `CONFIG`. The TypeScript client sets a zero wait for a NOWAIT row lock, as the other clients do. The Go row lock no longer repeats a statement that returned `SQLITE_BUSY`.

Add `--check` to `build` and `gen` of Go `ormgen` and of the PHP and TypeScript `orm-gen`, and to `build` of the Rust `orm-gen`. The command generates its output without writing it, prints `differs: <path>`, `missing: <path>` or `extra: <path>` for each output file, ordered by path, and exits with status 1 when it prints a line. `extra` names a file of the output directory that holds the generated-code comment and that the generation no longer writes. Go `gen --check` runs the same scan as `gen`, in a directory under the system temporary directory, and compares its result with `--out`.

Make an insert that omits a required column (NOT NULL, no default, not `auto`, not the AES key version) fail with `IR_INVALID: required column <entity>.<column> is not set` before the statement runs, in the Go, PHP, Rust and TypeScript clients on MySQL, PostgreSQL and SQLite. MySQL stored the first value of an omitted NOT NULL `enum` column, and PostgreSQL and SQLite returned their own driver errors. The bench schema adds the entity `task` with a NOT NULL `enum` column, and the conformance vector `required_columns` records the error for an omitted `enum` column and an omitted text column.

Make schema diff, `validate` and migration verification in the Go, PHP, Rust and TypeScript tools compare a PostgreSQL `enum` column with the live text column as equal. A migration of a schema with an `enum` column failed verification on PostgreSQL with `MIGRATION_VERIFY_FAILED`.

Add `make test-servers` and `make test-servers-stop`. `make test-servers` starts MySQL 8.4 and PostgreSQL 17 under `.runtime/servers` with TCP listeners on 127.0.0.1, creates the databases `orm_test`, `orm_tools` and `orm_bench`, seeds the MySQL, PostgreSQL and SQLite bench databases, and writes the environment file `.runtime/servers/env`; a second start prints the file and changes nothing. `make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `conformance-check`, `db-test` and `perf-check` read that file and fail when it is missing. `make db-test` runs the physical migration tests on the databases named by `ORM_TOOLS_MYSQL_DSN` and `ORM_TOOLS_POSTGRES_DSN` and no longer starts containers; `tests/compose.yaml` is removed. The conformance check and runners require a DSN and no longer connect to a local socket; the PHP, Rust and TypeScript runners take only `--dsn`.

Make the Go and PHP hot-path checks compare the median of 1,000 per-pair client/native ratios, measured after 100 warm-up pairs in alternating order, with the unchanged bounds (1.35 and 1.25), and run each check a second time beside one busy process per CPU (`TestHotPathGateUnderLoad`, `ORM_PERF_CPU_LOAD=1`). `make perf-check` runs both.

Reduce the allocations of the Go client when it reads rows: row models hold no statement builder until they are used as one, row cores and row states are allocated in one block per result, the loaded key values are a slice instead of a map, and the MySQL driver reads datetime cells in the connection time zone, so the client does not convert them again. The 100-row list of the bench allocates 270,611 B and 4,336 objects per query instead of 358,386 B and 5,233; results are unchanged.

Make the Rust `orm-gen` command tests fail when `ORM_TOOLS_MYSQL_DSN` or `ORM_TOOLS_POSTGRES_DSN` is unset instead of leaving out that database.

Make the JSON output of a model keep each ordered-json value as its stored text, with the member order and number text unchanged, as the Go client does. PHP adds `Model::toJson()` and `Collection::toJson()`, and `json_encode` of a row that holds an ordered-json value fails with `CODEC_ENCODE`. TypeScript `JSON.stringify` of a model or collection writes the stored text through `JSON.rawJSON` and fails with `CODEC_ENCODE` when JavaScript would reorder a member key; `toJSONText()` writes the exact text in every case. Rust adds `to_json()` on models and collections, and serde serialization writes the same text as a serde_json raw value.

Make the Go and PHP hot-path gates and the Go bench fail when `ORM_BENCH_MYSQL_DSN` is unset instead of connecting to a local socket, and make the Go client tests `TestAuditLargeTextChangeStaysWithinBudget`, `TestPoolSize` and `TestStatementTimeout` fail when `ORM_TEST_MYSQL_DSN` or `ORM_TEST_POSTGRES_DSN` is unset instead of leaving out that database.

Make the Rust array output return an error instead of stopping the process: `to_array` of a model or collection, `Val::to_json`, and the getters of attached values return `orm::Result`, and a value that serde_json cannot represent, such as the number `1e400`, returns `CODEC_ENCODE`. Serde serialization of a model reports the same error through the serializer.

Add `make rust-fmt-check`, which runs `cargo fmt --all --check` on the Rust workspace with `clients/rust/rustfmt.toml`; `make check` and CI run it.

Make AES writes in the Go, PHP, Rust and TypeScript clients encrypt with the key of the current version, `AESKeys[AESVersion]`, when only the key list and the version are configured; such a write failed with `secret aes not configured`. A configured `AESKey` that differs from `AESKeys[AESVersion]` fails the connection with `CONFIG`.

Make the PHP, Rust and TypeScript clients return the ordered-json value of a `json` or `jsons` stage, including `jsontext` and `json aes` columns, as the Go client does: PHP `OrderedJson\Value`, Rust `orm::ordered_json::Value`, and TypeScript `Value` of `ordered-json`. The value keeps the member order, the number text, and an empty object apart from an empty array. A write takes that value and stores its text unchanged; PHP and TypeScript also take the common value model, and Rust generated setters take only the ordered-json value. `toArray` keeps the value, and the JSON output of a model writes the decoded value. Values outside the JSON model, such as non-finite numbers, fail with `CODEC_ENCODE`.

Make the Go generator scan generate a called model method when an argument of the call has an unresolved type, such as a value computed with a method that another model package does not have yet. One `go generate` run over several model packages writes the final models of each package; a join or relation argument must still resolve to a model of the generated package.

Make `get` and the generated `getBy…` terminals of the PHP, Rust and TypeScript clients fail with `NO_ROWS` when no row matches, as the Go client does, instead of returning `null` or `None`. PHP `get()` returns `static`, TypeScript `get()` returns `Promise<this>`, and Rust `get()` returns `orm::Result<Self>`. The conformance vectors `terminal_by`, `write_cycle` and `delete_recursive` record the `NO_ROWS` code of a missing row.

Make the PHP, Rust and TypeScript schema generators write the MySQL DDL that the Go generator writes: CHECK constraint names `ck_<table>_<name>`, CHECK expressions in the form `(expr) <> 0`, boolean defaults `0`/`1` on MySQL and SQLite and `false`/`true` on PostgreSQL, and constraint and index names shortened to 64 bytes on MySQL and 63 bytes on PostgreSQL with a SHA-256 suffix. MySQL import in all four generators removes the `ck_<table>_` prefix and returns the declared check name, so an unchanged MySQL table with a CHECK constraint has no diff.

Add the encrypted JSON value: a blob column with the stages `json aes`, such as `longblob config "json aes"`, stores the ordered-json text of a value encrypted with AES v2 and the row's `aes_key_version`. The Go, PHP, Rust and TypeScript clients write, read, update and rotate it on SQLite, MySQL and PostgreSQL. Go reads back the ordered-json value with its member order and number text; PHP, Rust and TypeScript read back their JSON value model, as for a `json` column. An `aes` stage may follow another stage, and a `jsontext` column rejects every stage other than `json` or `jsons`. Audit change rows record every AES column as `{"redacted": true, "present": true}` instead of its ciphertext. The PHP, Rust and TypeScript schema builders read the audit `service=` option, as the Go builder does.

Render a MySQL `enum(a_b)` column as `enum('a','b')` in every schema generator; the unquoted value list was rejected by MySQL. PostgreSQL audit triggers insert the `service` column value with its own type, or NULL for an entity without `service=`, so a change table with an integer service column accepts the change rows.

Make `schema().empty()` on PostgreSQL treat a schema other than `public`, `information_schema` and the `pg_` schemas as content, with or without objects, in the Go, PHP, Rust and TypeScript clients. A database whose only content is an empty schema is no longer reported empty; tables, partitioned tables, views, materialized views and foreign tables in `public` remain content, and the MySQL and SQLite meaning is unchanged. The Rust `integration` test fails when `ORM_TEST_MYSQL_DSN` or `ORM_TEST_POSTGRES_DSN` is unset, as the other client tests do, instead of running on SQLite alone.

Make `ormgen gen --lang go` write each scan round into a temporary directory beside the output directory, which the scan reads through a package overlay, and replace the generated files of the output directory only after the scan converges. A generation failure, including an invalid chain call, a scan that does not converge, a scanned package that cannot be loaded, and generated code that does not compile, leaves the output directory byte-identical and exits with status 1. Scanned packages that do not compile for another reason leave the complete models in the output directory and exit with status 3.

Correct the receiver resolution of the Go generator scan. A method called on the result of a `Get` method, such as `Len` on a relation collection, is not requested as a model method; a call that has the name of a model constructor but belongs to another package does not start a model chain; and the hand-written files of the output package, including its tests, are scanned while its generated files are not.

Make Go `get` return the adapter-neutral `NO_ROWS` error when no row matches instead of returning `(nil, nil)`. Update the Go generator, generated model comments, examples and the SQLite contract test so callers cannot accidentally dereference a missing model; the API remains identical across database adapters.

Expose the adapter-neutral Go transaction write fact `Utils().WasInserted(entity, sequence)`. Generated inserts record their auto-sequence rows, and savepoint rollback restores the write set. It tells whether the current transaction wrote a row without PostgreSQL `xmin` or other driver SQL.

Expose the ORM-owned Go `DB.BackendWaitingForLock` inspection for bounded PostgreSQL concurrency orchestration. MySQL and SQLite return `false` through the same API; callers do not inspect `pg_stat_activity` or a driver connection.

Make `DB.BackendWaitingForLock` detect ungranted PostgreSQL `pg_locks` rows joined to their backend activity, including table-lock waits that do not appear reliably through `wait_event_type` alone. The adapter boundary remains unchanged for callers.

Add the adapter-neutral `LOCK_NOT_AVAILABLE` error for every `*_nowait` row-lock request that cannot acquire its lock. Go exposes `orm.IsLockNotAvailable`; PostgreSQL `55P03`, MySQL `3572`, and SQLite ORM row-lock contention are mapped without caller driver inspection. The condition is not a transaction retry signal.

Prefix generated MySQL CHECK constraint names with their table name so distinct entities may declare the same logical check name without a database-level collision. PostgreSQL and SQLite retain the declared physical name.

- Configure the CI bench database for every step: the workflow sets `ORM_BENCH_MYSQL_DSN` at the job level, so the performance-gate verification inside `make feature-check` reaches the seeded MySQL instead of failing on the local socket default.

- Enforce the declared commit-subject rule: `make git-check` checks every subject after a baseline recorded in `contracts/rules.json` for the `type: concise English description` format and the recorded length limit, and runs with the contract checks in CI. The rule registry names the target that actually runs the AES version-column check.

- Run the TypeScript client database tests in `make client-db-check`: the check drops the language selection that ran only Go, PHP, and Rust, so one check runs every language's client tests against MySQL, PostgreSQL, and SQLite.

- Enforce test-language parity in the feature check: it scans the test roots of Go, PHP, Rust, and TypeScript, fails when a client `pass` or `partial` claim names no test of that language, fails when an `implemented` feature is not `pass` in every client, and fails when a language test file belongs to no feature. The feature manifest adds `audit_triggers`, `point_type`, `interface_contract`, and `performance_gate`, and every client claim names a test of that language or a shared conformance or schema-case record.

- Test soft delete in the PHP, TypeScript, and Rust clients: a read filters rows whose `deleted_at` holds a value, and a delete rewrites to a guarded update that sets the timestamp on rows without one. The Rust test runs the model client on SQLite and checks every executed statement.

- The PHP performance gate runs its native baseline through the same typed row conversion as the client's assembly: the baseline decodes the cells and converts them into row values, so the client/native ratio measures the client machinery and not the typed conversion itself. The 100-row bound moves from 1.50 to 1.25 on the measured ratios (PHP 8.4.25, local socket: PK 1.20–1.31, 100 rows 1.06–1.12).

- The TypeScript client requires Node.js 22.16 or later, the first release whose `node:sqlite` provides every statement option the driver uses (`setReturnArrays`); `orm-gen` no longer prints the Node 22 experimental warning for `node:sqlite`, so its output is the same on every supported Node release. `make ts-min-check` runs the TypeScript tests on the lowest supported release.

- Require MySQL and PostgreSQL in the client database tests: the Go, PHP, Rust and TypeScript tests fail and name the variable when `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TOOLS_MYSQL_DSN` or `ORM_TOOLS_POSTGRES_DSN` is unset, instead of running on SQLite alone. SQLite audit updates compare stored bytes, so a change in case only is recorded in a `NOCASE` column.

- Bound and cancel statements: the connection configuration takes `poolSize` and `statementTimeoutMs`, and a flow cancels through a connection handle — Go `db.WithContext(ctx)`, TypeScript `db.withSignal(signal)`, and in Rust dropping the future of a statement. A statement stopped by a cancellation or a timeout returns the new error code `CANCELED`. PHP cancellation is not implemented yet.

- Add the column type `jsontext`, JSON stored as its exact text: `text` on PostgreSQL, `LONGTEXT` on MySQL, and TEXT on SQLite, so member order, duplicate keys, and an empty object against an empty array survive on the three databases. The type `json` is rejected and names `jsontext`; `import` maps PostgreSQL `json`/`jsonb`, MySQL `JSON`, and text columns carrying the json codec to it. Audit rows record JSON text columns as JSON on every dialect.

- Drop a connector at the start of a model or a group: a leading `and(fn)`, `or(fn)`, `and()`, `or()`, or prefixed chain reads as the first condition. A missing connector between two conditions and a connector without a following condition still return `CONFIG`.

- Add audit triggers as schema directives: `%% orm:audit_log` names the operation and change tables and the transaction setting that carries the operation id, and `%% orm:audit` requires an operation for every write to an entity and, in `changes` mode, records the old and new row with redacted JSON paths. DDL, `install()`, `diff`, `migrate`, `import`, and `validate` handle them on MySQL, PostgreSQL, and SQLite. `%% orm:immutable` renders on MySQL (updates and deletes). MySQL stores `uuid` columns as `char(36)`, writes TEXT, BLOB, JSON, and geometry literal defaults as expressions, and creates the database of a schema-qualified table. The SQL splitter keeps trigger bodies whole. `ormgen gen --lang go` also scans files excluded by `//go:build` constraints.

- A plan written from a `db:` source whose CHECK expressions were aligned with the declaration stores the schema hash of the aligned content, so `apply`, `recover`, and `rollback` accept it, in every language. `tests/schema/cases.json` also records the Mermaid schemas of the Go client and engine tests.

- Fix the Go schema tools against live databases: SQLite introspection reads `AUTOINCREMENT` keys and the generated clock default, so adding a nullable column is an `ADD COLUMN` instead of a rebuild and rollback SQL keeps valid defaults; SQLite full-text declarations create no objects and no longer block a rebuild; the update-time attribute is a column change only on MySQL; MySQL and PostgreSQL CHECK expressions are compared in the database's normalized form; an added column carries its comment, and MySQL `MODIFY COLUMN` keeps it; verification compares columns by name. Every tool DSN, including `db:` sources, is the client URI (`mysql://`, `postgres://`, `sqlite:///path`), the `--driver` options are removed, and `import` and `validate` read SQLite. Tool tests of every language use `ORM_TOOLS_MYSQL_DSN` and `ORM_TOOLS_POSTGRES_DSN`. `tests/schema/cases.json` also records the `ormgen plan` file of each manifest pair.

- Apply one schema install rule in every client: PostgreSQL and SQLite install in the active transaction or a new one, and MySQL installs outside a transaction and returns `CONFIG` inside one. On SQLite, a string compared with or assigned to a datetime or date column is written in the stored text form, so `startDt('2026-01-02 00:00:00')` matches the stored value; any other form returns `CODEC_ENCODE`. The Rust client binds datetime text with a `T` separator and RFC 3339 offsets on PostgreSQL.

- Assemble SQL in every client: PHP, Rust, and TypeScript validate requests, plan statements, render the MySQL, PostgreSQL, and SQLite dialects, and render schema DDL in the calling process, and the Go client calls the engine packages directly. The four clients produce the same statements, binds, and results for the conformance vectors. `utils().schema().install()` works on the three databases in every client.

- Ship one model generator per language: `ormgen gen --lang go` for `go generate`, `vendor/bin/orm-gen` for PHP, the `orm-gen` npm bin for the TypeScript build, and the `orm-build` crate with `orm::models!()` for Rust `build.rs`. TypeScript and Rust generate the chain methods that the scanned source calls. Connections are `model.Connect(dsn, schemaPath, config)` (Go), `Orm::connect(dsn, new Config(schemaPath: …))` (PHP), `Db.connect(dsn, schemaPath, options)` (TypeScript), and `Db::connect(dsn, pool_size, config)` (Rust).

- Remove the compiler service, its client transports and bridges, the WASM and FFI engine entry points, and the service deployment units. Adopting the ORM needs only the client library.

- Fix connection time zones: PostgreSQL receives a fixed-offset `timezone` in POSIX form, datetime values read from PostgreSQL are shown in the connection time zone, SQLite inserts write the executor clock of the connection time zone for `=now` columns, and a MySQL named zone without the server time zone tables returns `CONFIG`.

- Remove keyset pagination, relation existence and count predicates, tenant scopes, `having`, `distinct`, raw requests, `min`/`max`/`countDistinct` aggregates, the `like`, `startsWith`, and `endsWith` operators, request debug output, and the `predicate`, `scope`, and `many_to_many` schema directives. Remove the `CURSOR_INVALID` error code.

- Apply the reserved-name rules of the model syntax in schema validation and allow SQL keywords such as `key` and `order` as table and column names. Remove the `filepart` codec, the Go configuration-file loader, and the `ormgen check` and `ormgen precompile` commands. Rewrite the schema, protocol, configuration, dialect, codec, and packaging documents for the current design and remove the archived design pages.

- Rewrite the Go client for the model syntax: `model.<Entity>()` models with `Connect`, chain methods generated from the calls of the packages named by `ormgen gen --scan`, goroutine-scoped callback transactions with savepoints and functional options, `Utils()`, `GetsPage`, `Creates`, `GetQuery`, `New<Name>`, cross-connection relations, and connection time zones from the DSN `timezone` parameter. Add bound raw column expressions, binary contains, and multi-row inserts to the compiler, and render `{column}` paths from the statement root. Replace the conformance vectors with the model syntax and record them for MySQL, PostgreSQL, and SQLite.

- Carry explicit join and relation keys, joined-child groups, column and value functions, multi-column list conditions, subqueries, and random ordering through the compiler protocol and the Go, PHP, Rust, and TypeScript IR bridges. `make proto-check` compiles shared query forms through all four bridges and compares the plans.

- Compile explicit key joins and relations, joined-child condition groups, column and value functions, multi-column list conditions, subquery conditions and columns, `{column}` references in raw fragments, and random ordering for MySQL, PostgreSQL, and SQLite. Add the `FUNCTION_UNKNOWN` error code.

- Rewrite the common interface for models with `connect`, callback transactions with isolation, read-only, timeout, and retry options, flow-scoped savepoints, row locks inside transactions, and `connection.utils()` operations; remove public begin/commit/rollback, raw transaction SQL, explicit savepoint calls, and privilege helpers.

- Rewrite the complex query example with the specified syntax: configured join children, joined-model groups, ORM function values, and `getsPage`.

- Specify ORM function values: value functions `now`, `today`, `…Ago`, and `…Later`, and column functions `dayOfWeek`, `year`, `month`, `date`, `distance`, `pointX`, and `pointY` with MySQL, PostgreSQL, and SQLite renderings. The compared value is the second method argument. Raise the minimum SQLite version to 3.46 and document the SQLite decimal difference.

- Specify relation result names (`get<Table>Model(s)` or `get<Name>` for `alias<Name>`) and reject duplicate names among columns, added columns, relation results, and `new<Name>` values.

- Define `new<Name>` as a value attached under a non-column name that is carried to getters, `toArray()`, and JSON output but never used in SQL, reject real column names in `new<Name>`, and add `orderByRandom()`.

- Specify the DSL rules: join `ON` conditions with the child `on(fn)`, joined-model condition groups with `and(model)`/`or(model)`, `getsPage`, `getQuery`, unexecuted models as subqueries, raw forms with `{column}`, `<ColA><Op><ColB>(model)` column comparisons, `creates`, `tuple<ColA>With<ColB>`, ORM function values, reserved column name segments, and removal of `filepart_serialize`.

- Update the guide, README, and documentation home to the model syntax: model creation with `connect`, unprefixed first conditions, `and`/`or` connectors and groups, relation keys with `match<L>With<R>`, `create`/`update(true)`/`delete(true)` writes, and callback transactions without `connect`.

- Rewrite the DSL specification for the model syntax: `connect` binding, unprefixed first conditions, `and`/`or` connectors and groups, chain grammar with operator prefixes, value shapes for one value, lists, and null, fixed two-value `Between` arrays, reads, columns, relations, joins, writes, transactions, and reserved names.

- Replace the initial design, revised design, and DSL v3 notes with one design plan (`docs/plan.md`). The plan defines the model syntax for Go, PHP, Rust, and TypeScript, its rules, and the work order.

- Add the ORM-owned `DB.BackendWaitingForLock` inspection API for bounded PostgreSQL integration orchestration; non-PostgreSQL adapters return `false` without exposing driver-specific paths.

- Add adapter-neutral Go transaction-local context reads through `Tx.Local`; values set through `Tx.SetLocal` can be read without direct SQL, and missing keys return `NO_ROWS`.

- Add adapter-neutral Go `NewTransactionConflict` for deterministic serialization/deadlock error propagation without driver-specific SQL or error types.

- Expose the canonical schema client generator through `github.com/polyspec/orm/generator` for Go, PHP, Rust and TypeScript.
- Allow Go client generation to select an explicit package name while retaining `gen` as the default.

- Specify `Tx.InstallSchema(context.Context, []byte) error` as the ORM-owned canonical schema installation call; it takes no SQL or dialect-specific DDL.

- Go caller-owned transactions expose `Tx.Driver()` for canonical adapter selection while keeping query, mutation, and transaction APIs identical across MySQL, PostgreSQL, and SQLite.

- Apply SQLite transaction `readOnly` and isolation options through ORM-owned connection pragmas instead of rejecting them. Expose the logical mode through `Tx.ReadOnly` and `Tx.Isolation`, restore connection state before transaction completion, and verify read-only write rejection and subsequent connection reuse.
- Exclude the ORM-owned SQLite lock table from database-emptiness inspection so starting a transaction does not make a fresh database appear user-owned.

- Add a bounded SQLite ORM lock-cancellation regression alongside serialization, `NoWait` and transaction-release coverage. Waiting lock requests now have tracked evidence that caller context cancellation returns without an unbounded wait.

## Unreleased

- Implement SQLite `forUpdate`, `forShare`, and both `NoWait` modes through an ORM-owned transaction-scoped lock row. SQLite emits no lock suffix; `NoWait` temporarily uses a zero busy timeout. Go, PHP, Rust, and TypeScript carry the same lock mode through the plan contract.
- Preserve logical schema namespaces in SQLite physical table names by mapping `schema.table` to `schema__table`, preventing same-named tables from colliding in one database.
- Namespace generated SQLite index names with their qualified physical table name so module indexes with the same logical name cannot collide.
- Preserve overlapping foreign keys when one child column participates in multiple relation lines, including distinct composite constraints. Generated DDL ordering and migration diffing use relation metadata instead of collapsing those constraints to one column reference.
- Add adapter-neutral Go error classification through `ErrorCode`, `IsDuplicateKey` and `IsForeignKey`; callers do not inspect driver error types.
- The Go ORM client exposes ORM-owned pool statistics and opaque connection leases through `DB.Stats` and `DB.Acquire`, without exposing `database/sql` query access.
- The Go ORM client exposes `IsTransactionFinished`, allowing callers to recognize completed transactions without comparing driver-specific errors.
- Go generated `Get` methods now return `NO_ROWS` for an empty result; generated `GetOrNil` methods provide the explicit optional-row contract.
- AES version columns can be declared with `%% aes_version`; generators consume the resolved manifest metadata instead of assuming a column name.
- Audit redaction preserves values when a declared JSON path is absent and avoids materializing missing PostgreSQL parent objects.
- Go JSON and JSONS codecs use ordered-json values, preserving object member order and distinguishing empty objects from empty arrays.
- Go JSON and JSONS codecs convert tagged Go structs and raw `jsontext.Value` inputs into ordered-json without using the standard JSON encoder as the value boundary.
- The Go client uses the `v0.0.1` package at `github.com/polyspec/ordered-json/go` from the ordered-json monorepo.

## 0.0.1

- Initial development version.
- Added the shared IR, compiler, generated clients, database executors, migrations, authenticated versioned encryption, relations, batches, keyset pagination, and conformance checks.
- Added transaction-scoped PostgreSQL advisory locks to the Go ORM.
- Added ordered DDL installation through the Go ORM transaction boundary.
- Verify SQLite duplicate-key and foreign-key errors are mapped to the adapter-neutral ORM error contract.
- Add SQLite support to the adapter-neutral `SchemaInstalled` transaction operation for namespaced physical table names.
- Add adapter-neutral database-emptiness inspection for safe initial-schema preflight on PostgreSQL and SQLite.
- Exclude PostgreSQL system namespaces such as `pg_toast` from empty-database preflight detection.
