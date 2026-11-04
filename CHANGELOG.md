<!-- doc-id: changelog -->
# Changelog

## Unreleased

- Tests: what the native Python SQLite tests held is in recipes that every runtime runs: the case `sqlite_driver_error_ends_with_its_result_code` of `constraints_and_relations` (a missing parent, a restricted delete, a check, a trigger and a read-only write, each with its code, the extended result code of INT-154 and the driver cause) and `audit_values_need_an_audit_source` of `audit_triggers` (CFG-8). Those natives, the ten of `test_sqlite.py` that `model_queries_chain`, `model_writes`, `transactions`, `utils`, `statement_events`, `conformance_verification`, `audit_triggers` and `constraints_and_relations` already held, and the PHP `testStatementFailureKeepsItsDriverCause` that `immutable_write` holds are gone (T334-3-12).
- The Rust `CatalogConnection::query` runs a statement again after a schema change on PostgreSQL alone (INT-125a): on MySQL an out-of-range value failed with the syntax error of `DEALLOCATE ALL` and left a transaction open, and in a transaction of the caller the error of the statement is what reaches the caller. The recipe case `model_write_parameter_after_schema_change` holds a model write after its column changed type, in every runtime (T343-14).
- The Rust catalog closes the socket of every read that a budget stopped, a table page included, where only `read_only_query` and `read_only_grid_query` did (T343-11).
- PHP and the PHP extension try a connect that `max_user_connections` refuses again for 2 s after a close by that catalog (CFG-35), as the other runtimes do: a budget stop on a user allowed two connections no longer finds the place of its previous kill still held and waits 66 s (T343-13-1).
- Tests: the case `styled_integer_json_output` of the recipe conformance_verification holds an integer past the safe range inside a styled value in the JSON output of a model (#T334-3-5-13)
- COD-45 is the rule of the added-column read of TypeScript at the safe integers: the conformance helper derivedInteger, which no runner calls since the vector bodies went, is gone with its test, and the native case `added_column/driver_cell_forms` of the product code holds the rule (#T334-3-5-16)
- An added column reads by its plan type in all six runtimes for the forms the first cut left open: Go and Rust refuse a text with a plus sign or a leading zero, Go refuses a text that is no time, Rust decodes an added date and datetime, and an added date writes the text of a date in the JSON of Go, PHP and the PHP extension; the cases added_column_types, added_text_not_exact and added_text_not_a_time hold them (#T334-3-5-15)
- A failed `COMMIT` in Python reports its own code and leaves the rollback fault of protocol 3.1 armed, as INT-72 now states: it was reported as a `ROLLBACK` error that named the same failure twice, and a SQLite transaction that the failed `COMMIT` left open was not rolled back. The cases `a_failed_commit_does_not_consume_the_rollback_fault` (PostgreSQL and SQLite, whose deferred key fails the `COMMIT`) and `a_failed_begin_does_not_consume_the_rollback_fault` (SQLite, whose held write lock fails the `BEGIN IMMEDIATE`) of the recipe `transactions` hold the clause in every runtime (T334-3-12).
- Tests: the refusal of an install of a set with a diagnostic (SCH-7), the lock utility outside a transaction (INT-50) and a zero transaction timeout (INT-42) are cases of the recipes `schema_install`, `utils` and `transactions` in all six runtimes, and the native tests that the recipes hold are gone: the transaction and utility bodies of the TypeScript, Rust and PHP model tests, the PHP deadlock test and its child script, the Rust transaction timeout test and the Python pool limit, schema tools and tuple padding tests. The `schema` argument of a recipe takes `manifest`, and INT-42 states that `0` is the same as omitting the timeout.
- Tests: the physical run of a plan (PLN-102) is the op `dbspec.plan_physical` and the 13 cases `plan_physical_*` of the recipe `dbspec_introspect`, on every database in every runtime; the native tests, their make targets and the helpers that only they used are gone. Go and the others read the plan steps from the public `planSteps`, and every runtime now holds the foreign key check after finalize that only Go held.
- Tests: a database changed outside the ORM and installed again (DBS-108, SCH-7, SCH-13) is the cases `install_renamed_column` and `install_unsupported_column_without_check` of the recipe `schema_install` on every database in every runtime, with the whole message; the native tests and `contracts/fixtures/install/changed_database.json` are gone.
- Tests: the recipe schema takes the `where` of a `relation`, and the case `relation_condition_follows_the_padded_composite_parent_keys` of `model_queries_chain` is valid against it (T334-3-12).
- Tests: that a savepoint rollback does not consume the rollback fault (protocol 3.1) is a case of the recipe `transactions` in every runtime, in place of the Python native, and the native Python tests of a lost rollback, a failed `BEGIN` and a failed start step belong to the unit `transaction-failure-rollback` (T334-3-12-3-7, T334-3-12-3-8).
- Tests: the padding of the parent keys of a relation and the number of the placeholder after them are a case of the `model_queries_chain` recipe, the native tests of the collection keys that the recipes hold are gone, and feature-coverage names each one that stays native with its reason.
- A key of a `datetime` column is a date and time in every runtime, as INT-11 states, also when it is the only key column: PHP, TypeScript and Python returned the text of the column. A TypeScript key is a `Date` whose `toJSON()` holds the microseconds, so two microseconds of one millisecond stay two keys. The cases `single_key_of_a_datetime_keeps_its_type` and `single_key_of_a_microsecond_datetime_keeps_its_instant` of the `model_queries_chain` recipe hold it.
- The catalog of every runtime refuses a table page whose descriptor changes during the read (INT-121): a MySQL read scope now reads committed data, since at REPEATABLE READ the second read of the descriptor answered from the snapshot and saw no change, and a column that goes away during the read is `TABLE_PAGE_METADATA_CHANGED` instead of a driver error. A row change on a server with partial revokes is refused before it locks anything (INT-119). The recipe `catalog_connection` holds these and the direct and role-only TRIGGER grants on a real server, in place of the native tests with a fake driver; the MySQL replica of the test servers has `partial_revokes` on.
- The interface checker ends what it started when it ends, whichever way it ends: each program leads a process group, the abort of a run kills the group, and a process that reads the end of the checker's pipe kills the groups still running, so a hung extractor and its children do not outlive a checker that a deadline killed.
- Tests: the decimal physical runs and the commands of `contracts/features.json` and `config/parity.json` no longer name the removed tags `decimalphysical`, `markdown` and `physical`, and the row T334-3-6 states that `ormtest` stays, as PRT-43 requires.
- Tests: the case `catalog_session_after_a_schema_change_through_a_pooler` compares the `pg_backend_pid()` of its read with that of the held statement, so it fails when the read reaches another server connection. The PHP runner of `sql.hold_statement` bound no value to its `$1`, as PDO binds none to that placeholder, and now writes it as `?`.
- Tests: the test servers no longer serve the PgBouncer database `orm_test_single` and no longer write `ORM_TEST_PGBOUNCER_SINGLE_DSN`, and the Rust case helper `CaseTable` goes: no test used them since the catalog session through a pooler runs on a case database.
- A recipe `interface.symbols` that reaches its deadline kills the interface check in every runtime and fails its case, so no hung check is left running.
- A Rust integration case that fails names what it waited on for a connection: the pool acquire timeout and, through ProxySQL, the hostgroup and its connect timeout.
- The interface check of each runtime (INT-17, INT-18, INT-19, INT-57, INT-61, INT-64) is the case `interface_symbols` of the recipe `public-interface` through the new op `interface.symbols`; the six native wrappers and their parity unit are gone.
- A transaction reads its own write and publishes one transaction number on each of its statements in the recipe case `transaction_reads_its_own_write` of every runtime; the PHP extension test that held it alone is gone.
- The composite keys whose texts concatenate to one value are rows of the recipe `composite_keys` alone, and the case reads the statements and binds of their relation in every runtime; the fixture `composite_key_collision.json` and its exclusion from the parity suites are gone.
- The feature `transactions` runs the recipe `utils` in its owners too, as its parity list already named: `make feature-coverage-of/transactions` holds the lock release of INT-72 in every runtime (#T334-3-12-3-8)
- The per-database feature coverage cells are gone from the check and the CI matrix: `make parity-check` runs every recipe unit of them, and `make feature-coverage-of/<id>` still runs the coverage of one feature for a row (#T334-3-12)
- The feature checker runs each test entry once and reads only the `CASE` lines of its results file (FCV-12): its second run, its database state digest, its bench DSNs and its readers of test2json, libtest and TeamCity output are gone. The native `interface_symbols` entries write that line too. The timing of `performance_gate` is `make feature-performance-check`, which runs the hot-path measurements of the parity units twice, one at a time; the coverage of the feature is its recipe, and `execution` is gone from the manifest. The Rust lane runs the recipe programs in its workspace run instead of skipping them.
- The two PHP stress benchmarks no longer carry a `bench` group: nothing selected or excluded by it, and `make dbspec-stress-bench` names their files.
- A collection key keeps the declared type of its components on every database, as PRT-35 and INT-11 state: a `bool` column read as an integer on MySQL and SQLite, so `(true, 1)` and `(1, true)` had the same key text, and a `datetime` component of a composite key read as text in TypeScript and PHP, and in Python on SQLite. The encoding is now the `composite_key_*` cases of the `model_queries_chain` recipe; the forms that no key column can hold stay in `tests/collection/keys.json`.
- Python refuses `new_<name>` of a real column with `CONFIG`, as the other dynamic runtimes do (DSL-160), and the refusal is still an `AttributeError`, so `hasattr` holds. The refusal is the case `new_of_a_stored_column_is_refused_at_call_time` of the recipe `dsl-dynamic` in PHP, the PHP extension, TypeScript and Python, in place of a native test in each. The recipe `dsl-dynamic` runs again in Python, where a second helper of the same name had replaced the one it calls. The units of the generator and of the schema boundary that stay native have their reasons in FCV-2.
- The TypeScript and Python generators refuse a scanned `join<L>With<R>` or `leftJoin<L>With<R>` without its child, the argument count of DSL-37, as the other generators do. The chain names of the PHP scan vectors are `scanned-` cases of the `generator` recipe in every runtime, in place of the comparison of the PHP and the TypeScript scans.
- Tests: the set reader cases of `tests/dbspec/set-files.json` are the recipe `dbspec-set-files`, through the op `dbspec.read_set`, in every runtime, with the edge cases that TypeScript, Go and PHP each held alone; the native tests are removed (FCV-2, DBS-11).
- Python `read_dbspec_set` reports a set path with a NUL byte as `set.file`, as DBS-19 states; it raised `ValueError`.
- Tests: the rendered statements of `tests/dbspec/ddl.json` are the cases of the recipe `tests/dbspec/render-statements.json`, through the op `dbspec.render_statements`, in every runtime, for the documents in the order given and reversed; the native tests of the six runtimes are removed (FCV-2, DIA-113).
- Tests: a catalog session through a transaction pooler after a schema change (CFG-28, CFG-41) is the case `catalog_session_after_a_schema_change_through_a_pooler` of the `catalog_connection` recipe in every runtime, in place of the Python test `connection_config`, through the new op `sql.hold_statement` and a `dsn` on `catalog.reconnect`.
- Tests: the conformance runners keep only the bodies that a check reaches, the generated-method and the fixed-clock bodies; the other 50 vectors are cases of the `conformance_verification` recipe, and a test holds each runner to the reached names.
- The pool of Python closes an idle connection when its lifetime passes, as CFG-5 states; it closed one only when the next caller would take it. The pool bounds of MySQL and PostgreSQL, the lifetime and the refused pool values are cases of the recipes `connection_pool` and `dsn_reject_checked`, and the refusal of a pool option in PHP is the recipe `dsn_reject_php_pool`.
- The TypeScript integer parameter test is named `driver-integer-param.mjs`, and the reasons of its internal test entries state what each test does.
- `make dbspec-apply-stress-bench` applies the stress plan again: it had no command since the native test became a recipe case, so `make bench` and the stress CI groups passed without applying anything.
- The message of a manifest with several diagnostics is held word for word by one recipe case in every runtime (SCH-12).
- An AES configuration with no usable current key fails the connection with `CONFIG` in every runtime and opens no database: Go took it at its first use and opened first, TypeScript opened the file before it refused, PHP and the PHP extension took a key list without the current version, and Python took a current version below 1. The recipe `aes_rotation` holds these forms and the rollback of a failed rotation.
- The feature checker no longer sets `ORM_FEATURE_DATABASE` or `ORM_FEATURE_DSN`, and no test reads them: an owner takes its database from its manifest entry or its recipe.
- Tests: the exact bytes of a driver cell (PRT-69, INT-5) are the case `driver_bytes_cells_are_exact` of the `conformance_verification` recipe in every runtime, through the new `model.query` key `bytes_hex_of`; the natives that built the cell are gone, and Rust keeps its private row decoding test under INT-142.
- Collection views and connect on every model now come from the recipes in every client; the native extension surface has its own unit under INT-62a.
- The generated full-text method of the Python package has its own unit under DSL-33a.
- Schema inspection reads inside a transaction and its statement event now come from the recipe schema_install; the Python files that repeated it are gone.
- Table privileges on PostgreSQL and their refusal on MySQL and SQLite now come from one recipe in every client; the native extension keeps its own unit under INT-59a.
- Every message of the dbspec rule `type` has the words DBS-162 states, in all six runtimes: Go, PHP, the PHP extension and Rust no longer word a parameter error their own way, and the generator cases hold each whole message. Targets of CHECK_TARGETS with no make rule are gone, and `catalog-rust` no longer names test files that do not exist (#T334-3-12-6)
- A connection with an AES key that differs from the key of its current version is the case `an_aes_key_that_differs_from_the_current_version_is_refused` of the recipe `aes_rotation` in all six runtimes, through `aes_key`, `aes_version` and `aes_keys` in the `config` of `dsn.connect`, and the Go test `TestAESKeyMustMatchKeyOfCurrentVersion` is gone (#T334-3-12-2)
- CR15-F: the TypeScript and Python tests of the MySQL insert statements return from c55a726cf as owner units (INT-123b, INT-123c), which hold only the statements a fake driver observes.
- CR15-F: `generated_key_lifecycle` inserts beside a trigger that adds a row with a higher key on PostgreSQL and SQLite, so a key read from the table fails it; INT-123 states where a generated key comes from.
- The expected fields of the conformance vector files are gone with their chains and calls: `tests/conformance/vectors.json` keeps the vector names and requirements, and `vectors.postgres.json` and `vectors.sqlite.json` fold into the expects of the recipe `conformance_verification`.
- The whole-run conformance checker is gone: `make conformance-check` runs the native bodies that remain and the result helpers, the state contracts of `contracts/interfaces.json` compare with their recipe cases in a test, and the database state reader is `tests/conformance/check/state.mts`.
- `clock_microseconds`, `clock_soft_delete_microseconds` and `now_defaults` hold a stored clock value between a wall-clock read before the write and one after it, through the new step `clock.read`, where they allowed one minute of the database clock.
- Tests: a stored cell outside its declared type (INT-98) is three cases of the `conformance_verification` recipe in every runtime; the natives that wrote the same cells are gone.
- Tests: a driver error and its native cause (PRT-79) are the case `immutable_write` in every runtime, raised by each database; the natives that built the error are gone.
- Tests: a MySQL lock wait timeout (CFG-6) is the case `mysql_lock_wait_expiry_is_canceled` of the `transactions` recipe, against a real 1205 from the server, in every runtime; the natives that built the driver error are gone.
- CR15-F: the rows of a stored table in descending order, with a NULL, are steps of `grid_column_and_row_order`; the Go test keeps the plan of its wrapper (SCH-6b), the Rust helper test is removed, and the Rust commit classifier is a single-owner unit (INT-118a).
- `performance_gate` reads the `BENCH_<DATABASE>_DSN` of the database that each class names, and no gate, `perf-check` or `php-ext-memory-check` reads a feature variable; one unknown type has one message in every runtime, `type "<word>" is not a dbspec type` (#T334-3-12-6)
- A read of a described table returns a value that is not valid UTF-8 as its bytes in all six runtimes, and TypeScript takes the whole answer of such a read from one execution.
- A value of a read-only query that is not valid UTF-8 is its bytes in all six runtimes, and a binary cell in a grid query, including a SQLite text.
- A read-only query of any length or nesting answers in all six runtimes, and Rust reads a query by its tokens as the others do.
- Recipe runs record the keys they read in each runtime, and a key that a run leaves unread fails the case by name.
- CR15-F: generated keys are held by the recipe cases `generated_keys` and `generated_key_lifecycle`; the TypeScript and Python natives that repeated them over fake drivers are removed, and the Rust test keeps the phases, cancellation and joined inserts of INT-123a.
- CR15-F: a SQLite statement of TypeScript that failed while reading its rows is reset; left unreset in the cache, its next run reported the same error whatever it bound.
- CR15-F: An insert with no assignment returns its generated key: TypeScript on MySQL kept the insert id of a statement without binds, and PHP and the extension on PostgreSQL no longer declare a cursor for it.
- Tests: the MySQL session settings of CFG-3 are the case `mysql_session_settings` of the `dsn_connection` recipe in every runtime, through the new `session_read` key of `dsn.connect`; the `sql_mode` natives and `tests/dsn/mysql-session.json` are gone.
- Recipe runs record the keys they read in each runtime, and a key that a run leaves unread fails the case by name.
- The connection pool of CFG-4 and CFG-5 on MySQL and PostgreSQL runs as the new recipe `connection_pool` in Go, TypeScript, Python and Rust, through the new op `pool.transactions` and `pool_idle_size` of `model.connect`; the native tests keep the SQLite pool and the lifetime expiry, which `docs/spec/feature-coverage.md` lists (#T334-3-12-2)
- The pool statistics of INT-79 run as the case `stats_report_the_pool_of_the_connection` of the recipe utils in all six runtimes, through the new op `utils.stats` (#T334-3-12-2)
- The Go lane and the parity roots no longer name `packages/go/complexquery`, which has no Go file left (#T334-3-12-2)
- `performance_gate` reads the BENCH_<DATABASE>_DSN of the database that each class names, and no gate, `perf-check` or `php-ext-memory-check` reads a feature variable; one unknown type has one message in every runtime, `type "<word>" is not a dbspec type` (#T334-3-12-6)
- The native tests of `orm-gen gen --check` in Go, PHP and TypeScript are gone: the case `check_reports_differences_without_writing` of the recipe `generator` holds them, and `go-model-check`, `php-model-check` and `ts-model-check` hold the generated models; `ts-model-check` holds each of the five TypeScript model sets, and its scan list names the sources that call models.
- The connection pool of CFG-4 and CFG-5 on MySQL and PostgreSQL runs as the new recipe `connection_pool` in Go, TypeScript, Python and Rust, through the new op `pool.transactions` and `pool_idle_size` of `model.connect`; the native tests keep the SQLite pool and the lifetime expiry, which `docs/spec/feature-coverage.md` lists (#T334-3-12-2)
- The pool statistics of INT-79 run as the case `stats_report_the_pool_of_the_connection` of the recipe utils in all six runtimes, through the new op `utils.stats` (#T334-3-12-2)
- The Go lane and the parity roots no longer name `packages/go/complexquery`, which has no Go file left (#T334-3-12-2)
- Recipe runs record the keys they read in each runtime, and a key that a run leaves unread fails the case by name.
- Tests: the MySQL session settings of CFG-3 are the case `mysql_session_settings` of the `dsn_connection` recipe in every runtime, through the new `session_read` key of `dsn.connect`; the `sql_mode` natives and `tests/dsn/mysql-session.json` are gone.
- A lock released before the end of its transaction is `CONFIG` in Go and Python, as INT-72 states: Go reported `ROLLBACK` because it counted its own close of the discarded connection as a failed rollback, and Python raised a TypeError on the NULL of `RELEASE_LOCK`. The case `a_lock_released_early_is_reported_at_the_end_of_its_transaction` of the recipe utils states it, and the failing-driver natives of the transaction end are named in FCV-2.
- The Rust test `coverage_conformance_verification`, which read the vector files, is gone; the bindings of its units name the recipe test `conformance_verification` of each database. The binary `conformance` stays: the `generated` and `fixed-clock` checks run it.
- The PHP and PHP extension tests that read the vector files are gone, with the coverage helpers only they used; the bindings of their units name the recipe test `conformance_verification` of each database.
- The Python conformance modules that read the vector files are gone with the target `conformance-check/python`: the bindings of their units name the recipe test `conformance_verification` of each database.
- The TypeScript conformance tests that read the vector files are gone: each vector is a case of the recipe `conformance_verification`, and the TypeScript bindings of its units name that recipe test.
- The connection pool of CFG-4 and CFG-5 on MySQL and PostgreSQL runs as the new recipe `connection_pool` in Go, TypeScript, Python and Rust, through the new op `pool.transactions` and `pool_idle_size` of `model.connect`; the native tests keep the SQLite pool and the lifetime expiry, which `docs/spec/feature-coverage.md` lists (#T334-3-12-2)
- The pool statistics of INT-79 run as the case `stats_report_the_pool_of_the_connection` of the recipe utils in all six runtimes, through the new op `utils.stats` (#T334-3-12-2)
- The Go lane and the parity roots no longer name `packages/go/complexquery`, which has no Go file left (#T334-3-12-2)
- Docs: FCV-2 states the Rust compile fixtures of `ts-dbspec-plan` and `ts-dbspec-render-dialect` in the form the native-binding rule reads.
- PHP and the PHP extension refuse a number stored in a SQLite TIME or DATETIME column of a described read with GRID_TEMPORAL_VALUE, as the other runtimes do, and temporal_write_and_limits holds the temporal writes, keys and limits.
- A Rust page of exactly its byte budget answers, and all runtimes state a budget refusal in the same message, which INT-115 states.
- A plain read-only query returns a binary value as its bytes in all six runtimes, and INT-153 states the form.
- The catalog no longer refuses a PostgreSQL read for 200 UNION ALL operands or + terms, and Rust no longer bounds the depth of a read on the other dialects; catalog_read asserts that these reads answer.
- The apply chain, its history and state, the lock scope, finalize, the stress plan and the pooler are the recipe `dbspec_apply` in the six runtimes, each command one call of the public apply API on a named connection, and their native tests are removed.
- CR15-F: the shared row mutation outcomes (conflict, unique, coercion, generated column, schema change, foreign key, insert forms) are the recipe case `row_mutation_lifecycle`; the Rust test keeps only the phases, cancellation and dropped commit of INT-106a.
- Introspection is the recipe dbspec_introspect in all six runtimes: the round trips, the cases of tests/dbspec/introspect.json with the reasons of a PostgreSQL loose sequence and routine, the catalog query count and a failing catalog query; dialect-refusal holds its unknown dialect in five runtimes. Only the silent PDO error mode (DIA-133a) and the method of the PHP extension (DIA-133b) stay native (#T334-3-12-5)
- A model write of a text that no time form reads returns `CODEC_ENCODE` in PHP and the PHP extension, as PRT-67 states; it returned `CODEC_DECODE`. The stored form of a temporal column and that refusal run in the recipe `conformance_verification`; PRT-67a names the setter form that only Go has.
- The microseconds of the update time and of a soft deletion and the now condition run in the recipe `conformance_verification` in every runtime, on `clock_cell` and `soft_record`; their native tests are gone, and the recipe function `seconds_later` is new. TypeScript keeps the test of `wallMicros`, its own clock source.
- Introspection is the recipe dbspec_introspect in all six runtimes: the round trips, the cases of tests/dbspec/introspect.json with the reasons of a PostgreSQL loose sequence and routine, the catalog query count and a failing catalog query; dialect-refusal holds its unknown dialect in five runtimes. Only the silent PDO error mode (DIA-133a) and the method of the PHP extension (DIA-133b) stay native (#T334-3-12-5)
- Introspection is the recipe dbspec_introspect in all six runtimes: the round trips, the cases of tests/dbspec/introspect.json with the reasons of a PostgreSQL loose sequence and routine, the catalog query count and a failing catalog query; dialect-refusal holds its unknown dialect in five runtimes. Only the silent PDO error mode (DIA-133a) and the method of the PHP extension (DIA-133b) stay native (#T334-3-12-5)
- The natives of the rollback fault are gone from all runtimes: the case of the recipe transactions states them, with the new expect key `keeps_callback` for the callback error that a ROLLBACK keeps. `packages/ts/tests/rollback.mjs` and `packages/go/orm/rollback_fault_test.go` are removed, and the two Rust forms stay native as INT-72a.
- Tests: the finalization of a chain is held by the `dbspec_apply` recipe in every runtime, with a new case for a plan that hides nothing: its finalize event comes while the row is `applied`, no statement runs and the row becomes `done`; the Go `TestFinalizeMarksPlanDone` is gone.
- Docs: FCV-2 states each public-surface unit of `interface_contract` with its own native reason, in the form the native-binding rule reads.
- The generators print a diagnostic of a parsed document in the form of SCH-12, `<line>:<column> <rule>: document <name>: <message>`: PHP and its extension and the Rust builder printed their own (#T334-3-20)
- A PHP catalog whose commit lost its connection reads over a new connection at its next call instead of failing with `CONNECTION_LOST` from then on (INT-118). The recipe case `row_commit_outcomes` of `catalog_connection` holds it, with a PostgreSQL deferred trigger that rejects the commit and one that ends the backend during it.
- The natives of the rollback fault are gone from all runtimes: the case of the recipe transactions states them, with the new expect key `keeps_callback` for the callback error that a ROLLBACK keeps. `packages/ts/tests/rollback.mjs` and `packages/go/orm/rollback_fault_test.go` are removed, and the two Rust forms stay native as INT-72a.
- The set errors, the file diagnostics and the `differs:` and `missing:` lines of the generated file check are cases of the `generator` recipe in all six runtimes through `generator.refused` and `generator.check`, and their natives are gone (#T334-3-20)
- `read_only_query` of a MySQL unsigned value beyond the signed 64-bit range returns its exact digits in every runtime (INT-102): Go, Rust, the PHP library and the PHP extension refused it. The recipe case `grid_number_values` holds it.
- The decimal and number cells of a read-only grid query are the recipe cases `grid_decimal_values` and `grid_number_values` of `catalog_connection`; the Rust tests `grid_decimals` and `grid_numbers` are gone.
- Python and PHP, library and extension, refuse a nonfinite PostgreSQL numeric grid cell with `CATALOG_VALUE`, as the catalog grid section of `docs/spec/interfaces.md` states; they returned `NaN` as a decimal cell. The recipe case `grid_decimal_values` holds it.
- The row baseline and the verification of a native update are the recipe cases `row_update_verification`, `row_baseline_key_order` and `row_baseline_rejected` of `catalog_connection` in all six runtimes on the three databases, with the op `catalog.revision_compare` and more replacements of `page_with`; the Rust tests of them are gone, except what only the forms of Rust hold (`rust-row-snapshot-cell-forms`). TypeScript no longer refuses a SQLite view as a table without one definition text.
- TypeScript describes a SQLite view: it read the view's definition from `sqlite_master` with `type = 'table'`, found no row and refused the view with `TABLE_METADATA_INVALID`; the recipe case `view_table_page` of `catalog_connection` holds it (INT-113).
- The recipe form F16 `within` is removed: no runner or fixture used it.
- A test states that every conformance vector equals its recipe case on each database, field by field for statements, until the vector files lose their expect.
- The constraint errors and the immutable write are held by the recipes in Rust, Go and Python too: the recipes compare the check name, the unique key, the SQLite code name and the driver cause, and `refusal.rs` is gone (#T334-3-18).

Docs: FCV-2 states each public-surface unit of `interface_contract` with its own native reason, in the form the native-binding rule reads.

- A shared parity unit bound natively is a finding of `make repo-check`: FCV-2 makes it the cases of a recipe, and only a unit that FCV-2 states to stay native, with its reason, is excepted
- The native tests of `orm-gen gen --check` in Go, PHP and TypeScript are gone: the case `check_reports_differences_without_writing` of the recipe `generator` holds them, and `go-model-check` and `php-model-check` hold the generated models; the TypeScript build writes its own.
- The native refusal tests of vector 17 give way to the case `errors` of the recipe conformance_verification; Go, TypeScript and Rust keep only their compile fixtures for a use that drops a refusal, and the private SQLite fixture helper of Rust goes with its one test (#T334-3-12-2)
- The native tests of `orm-gen gen --check` in Go, PHP and TypeScript are gone: the case `check_reports_differences_without_writing` of the recipe `generator` holds them, and `go-model-check`, `php-model-check` and `ts-model-check` hold the generated models; `ts-model-check` holds each of the five TypeScript model sets, and its scan list names the sources that call models.
- The native tests of `orm-gen gen --check` in Go, PHP and TypeScript are gone: the case `check_reports_differences_without_writing` of the recipe `generator` holds them, and `go-model-check` and `php-model-check` hold the generated models; the TypeScript build writes its own.
- A connection that the server refuses is `DRIVER` in every client; PHP and its extension reported `CONFIG`, and the Rust catalog an uncoded text.
- A catalog retries a connection that `max_user_connections` refuses only within 2 s of closing one of its own, and a budget stop in Go reports `CATALOG_LIMIT` alone, with no rollback attempted.
- The case `a_rollback_fault_is_consumed_by_the_next_failed_rollback` of the recipe transactions states INT-72 in every runtime through the new op `fault.next_rollback`: the fault outlives a committed transaction, the next failed callback reports ROLLBACK carrying FAULT, and the transaction after it reports only the callback error.
- The query forms of the Go physical test are recipe cases on every database: `{"random": true}` orders a `model.query` by `orderByRandom` and the case `query_now_and_random_order` holds it with `now`; the tuple and the date functions were cases already (#T334-3-18).
- The recipe `statement_events` holds the server transactions of a statement event, and the vector `tests/events/vectors.json` with its native runners is gone.
- The conformance vectors begin to move into the `conformance_verification` recipe, run on the three databases by all six runtimes: its fifty-nine cases cover connectors, groups, chain reuse, expressions, columns, joins, relations, subqueries, aggregates, empty reads, functions, AES and hex values, a write cycle, batch creates, restores, audits, transactions and getQuery. Model ops of a fixture that generates no models now reach the public builder through one path in every helper, including `statement_events`. Rust reads an integer column that MySQL returns as text bytes after an `ALTER`.
- - The compile case of an output name conflict holds the exact text of the error in every dialect, by the optional message of a planner.compile expect (#T334-3-6-2)
- The catalog natives a recipe cannot reach stay as internal tests, and generated_identity_sqlite, read_only_grid_shapes and temporal_text_row_cycle_sqlite hold the random key, the refused grid write and the temporal row cycle.
- Go, PHP and the PHP extension read a MySQL `BIGINT UNSIGNED` past the signed range instead of refusing it, and the row baseline tells the two largest values apart.
- The catalog read shapes, grid binary row, row baseline, byte capacity, described temporal matrix and SQLite identity natives are cases of the catalog_connection recipe. A catalog insert of a key of defaults alone takes no assignment in TypeScript, Python, PHP and the extension as in Go and Rust, and PHP reads a PostgreSQL bytea of a page and takes a snapshot of a binary cell instead of refusing them.
- The conformance vectors begin to move into the `conformance_verification` recipe, run on the three databases by all six runtimes: its cases cover connectors, groups, chain reuse, expressions, columns, joins, relations, subqueries, aggregates, empty reads, functions, AES and hex values, a write cycle, batch creates, restores, audits, transactions and getQuery. Model ops of a fixture that generates no models now reach the public builder through one path in every helper, including `statement_events`. Rust reads an integer column that MySQL returns as text bytes after an `ALTER`.
- Go runs the conformance vectors through the recipe conformance_verification and its fixed-clock bodies only: the tagged test `coverage_conformance_verification_test.go`, its helper, `testdb.FeatureDatabase`, the runner `packages/go/testing/feature-json.mts`, the target `feature-go-unit` and the build tag `featurecoverage` are gone (#T334-3-12-2)
- The nine refusals of the vector `errors` (a missing or dangling connector, an empty list, no connection, a lock outside a transaction, a join child with a connection, a page with a limit, a relation with a limit and an unjoined model placement) run as the case `errors` of the recipe conformance_verification in all six runtimes, with an empty event list as the proof that no request left; the recipe takes `connect` on a join, `limit` on a relation, `{"placed": {"model": <name>}}`, and `plan_page` without `plan` for `getsPage` (#T334-3-12-2)
- INT-78a states that the `root` of a hooked handle is the connection in Go, TypeScript and Python, the runtimes that have one; a Rust compiler fixture states that a request hook cannot write a bound value.
- - The session messages and the refused surfaces of a markdown connection are cases of the recipe tests/bind/messages.json in all six runtimes, by the new op markdown.session and the markdown.send form surface; the natives that held them are gone (#T334-3-6-2)
- The statement event bind of a secret and the secret bind slot are gone: no statement has bound a secret since AES moved to the client, so `$SECRET` left INT-91, DSL-68, PRT-32 and every client.
- The statement event bind of a secret and the secret bind slot are gone: no statement has bound a secret since AES moved to the client, so `$SECRET` left INT-91, DSL-68, PRT-32 and every client.
- The constraint errors and the immutable write are held by the recipes in Rust, Go and Python too: the recipes compare the check name, the unique key, the SQLite code name and the driver cause, and `refusal.rs` is gone (#T334-3-18).
- The manifest, analysis and format units of the schema definition bind only their recipe: Go `TestFormat` is gone, the invalid byte joins the stated native unit `dbspec-encoding-and-limit-natives`, and the test of the origin of the extension classes is internal (#T334-3-18).
- An effect query without a row is `<query> returned no row` in every runtime (Rust said `returned 0 rows; want one`), and the `dbspec.apply_fault` recipe holds it; the native tests are gone (#T334-3-18).
- A catalog budget stop whose kill fails no longer reads the rest of the result: PHP waits for the server to end the stream and reopens, and Python closes its socket.
- A catalog budget stop whose kill fails no longer reads the rest of the result: PHP waits for the server to end the stream and reopens, and Python closes its socket.
- A catalog budget stop whose kill fails no longer reads the rest of the result: PHP waits for the server to end the stream and reopens, and Python closes its socket.
- The statement event bind of a secret and the secret bind slot are gone: no statement has bound a secret since AES moved to the client, so `$SECRET` left INT-91, DSL-68, PRT-32 and every client.
- A catalog budget stop whose kill fails no longer reads the rest of the result: PHP waits for the server to end the stream and reopens, and Python closes its socket.
- The constraint errors and the immutable write are held by the recipes in Rust, Go and Python too: the recipes compare the check name, the unique key, the SQLite code name and the driver cause, and `refusal.rs` is gone (#T334-3-18).
- The manifest, analysis and format units of the schema definition bind only their recipe: Go `TestFormat` is gone, the invalid byte joins the stated native unit `dbspec-encoding-and-limit-natives`, and the test of the origin of the extension classes is internal (#T334-3-18).
- An effect query without a row is `<query> returned no row` in every runtime (Rust said `returned 0 rows; want one`), and the `dbspec.apply_fault` recipe holds it; the native tests are gone (#T334-3-18).
- The Python test of a Future abandoning a query in a transaction (CFG-9) stays native in `test_query_cancel.py`, on its own empty database per dialect, and the Python feature runner `feature_items`, `each_item` and `run_cases` is removed, so Python reads neither `ORM_FEATURE_DATABASE` nor `ORM_FEATURE_DSN`.
- The four expected revision natives are gone from all six runtimes: the case `expect_revision` of the recipe conformance_verification holds a match, a mismatch, an update and a delete on every database (#T334-3-6-2)
- The parity units of the catalog temporal text and the grid order read their Go tests from the normal run, with no bench database (#T334-3-6-2)
- The feature checker builds a Go owner with the tags of the normal go test, so it reads by exact name a test that the normal run holds (#T334-3-6-2)
- `conformance-generated-methods-check` also compares the bodies `now_defaults`, `delete_recursive` and `affected_counts` with the expects of their recipe cases.
- The group_rows_db natives and the physical check are gone; the recipe holds the values and the exact read-only statements (#T334-3-4-25)
- `active_frame()` of Python is a stated requirement (INT-161) with its native test, the recipe `utils` refuses `setLocal` outside a transaction, and the recipe `aes_rotation` holds the status counts of several key versions.
- The recipe `statement_events` holds the failure of a subscriber with an ORM error, and the native statement event tests of Go and Python are gone.
- The Python owner of `conformance_verification` is the recipe of that name on each database; the Python coverage file of it is removed, and the requirements it was bound to are bound to the cases `conditions_values`, `creates_and_save`, `functions` and `relations`.
- The recipe `statement_events` holds the failure of a subscriber with an ORM error, and the native statement event tests of Go and Python are gone.
- Three Python natives of column functions and subqueries are gone; the recipe holds their values (#T334-3-4-24)
- The recipe `statement_events` holds the failure of a subscriber with an ORM error, and the native statement event tests of Go and Python are gone.
- A function and a subquery on one output name answer COLUMN_ALIAS_CONFLICT as the compile case `planner_function_and_subquery_share_an_output_name` on every runtime; the scalar aggregate type copies and the extension's native planner test are gone, and the extension's planner target runs the compile recipe (#T334-3-6-2)
- PRT-38 states the order of the page steps as they are, main, count, relations, and what the count step holds; PRT-9 states the select list; `planner_page_steps` of the compile recipe holds those statements (DSL-159).
- `make perf-check` runs the Go measurement of PERF-1 on MySQL, PostgreSQL and SQLite, and the Go lane of `client-db-check` skips those tests, which assert no client result.
- The Go coverage files of `request_hook` and `statement_events` are gone: their cases are the recipes of those names, and `config/parity.json` binds them there. The Go measurement of PERF-1 is `packages/go/bench/performance_measurement_test.go`, without the feature build tag, since a recipe states results and not time; `make perf-check` runs its MySQL test.
- The statement event bind of a secret and the secret bind slot are gone: no statement has bound a secret since AES moved to the client, so `$SECRET` left INT-91, DSL-68, PRT-32 and every client.
- The JSON form of a row writes a `time` or `datetime` column with six fraction digits in every client, as the array form does: TypeScript, Python and Rust wrote the column precision, Go and PHP six digits.
- Nine more write cases of the conformance vectors run in the recipe conformance_verification (#T334-3-4-23)
- The Go request hook natives that the recipe holds are gone; the read of a failing hook also states that no statement runs. The units that stay native are stated in FCV-2 with their reasons.
- The AES envelope and blind index cases and the param_uses cases are their recipes in all six runtimes: the suites authenticated-encryption and planner-params and their fixtures are removed, the owners of authenticated_encryption and planner name tests/codec/codec.json and tests/planner/compile.json, and a native test on its own case database states `case_database` in place of a bench DSN.
- `make perf-check` runs the Go measurement of PERF-1 on MySQL, PostgreSQL and SQLite, and the Go lane of `client-db-check` skips those tests, which assert no client result.
- The AES envelope and blind index cases and the param_uses cases are their recipes in all six runtimes: the suites authenticated-encryption and planner-params and their fixtures are removed, the owners of authenticated_encryption and planner name tests/codec/codec.json and tests/planner/compile.json, and a native test on its own case database states `case_database` in place of a bench DSN.
- The Go coverage files of `request_hook` and `statement_events` are gone: their cases are the recipes of those names, and `config/parity.json` binds them there. The Go measurement of PERF-1 is `packages/go/bench/performance_measurement_test.go`, without the feature build tag, since a recipe states results and not time; `make perf-check` runs its MySQL test.
- The AES envelope and blind index cases and the param_uses cases are their recipes in all six runtimes: the suites authenticated-encryption and planner-params and their fixtures are removed, the owners of authenticated_encryption and planner name tests/codec/codec.json and tests/planner/compile.json, and a native test on its own case database states `case_database` in place of a bench DSN.
- The recipe `statement_events` holds the failure of a subscriber with an ORM error, and the native statement event tests of Go and Python are gone.
- A catalog budget stop whose kill fails no longer reads the rest of the result: PHP waits for the server to end the stream and reopens, and Python closes its socket.
- Go reports a statement on a connection that database/sql already closed as `CONNECTION_LOST`, as CFG-15 states, where it reported `DRIVER`; the outer rollback of a lost savepoint hit this.
- The refusal of a markdown connect (PRT-64) is a recipe case, `markdown.connect`, on a listener each runtime runs, and the native tests it replaces are gone. A refused TLS connection in Rust names no database in its message (CFG-16).
- A MySQL TLS connection that a certificate refuses returns `CONFIG` with `TLS connection failed` in every client: Go, TypeScript and Rust returned `DRIVER` (CFG-16). The TLS connection and its refusals are recipe cases.
- Go, PHP and the PHP extension refuse a SQLite `busy_timeout` that is not a whole number, and Go refuses a malformed `_pragma` and the SQLite path `/`, each with `CONFIG` (CFG-11, CFG-12), and PHP names the path in that refusal. An unreadable MySQL `ssl-ca` reads `is not a readable file` in every client that checks it, and the Python refusal of a negative timeout reads `statement timeout must not be negative`. A DSN that returns `CONFIG` creates no file. The refused DSN and configuration forms of CFG-36 and CFG-37 are recipe cases, with their messages, and the native tests they replace are gone.
- The recipe `statement_events` holds the failure of a subscriber with an ORM error, and the native statement event tests of Go and Python are gone.
- The plan steps of a page hold in the recipe case `page_plan_steps` of `complex_query` on every runtime: the steps are the statements that the page sends, and a bad page, a bad size, a limited chain and an unconnected model are refused (DSL-159).
- The plan steps of a page hold in the recipe case `page_plan_steps` of `complex_query` on every runtime: the steps are the statements that the page sends, and a bad page, a bad size, a limited chain and an unconnected model are refused (DSL-159).
- The plan steps of a page hold in the recipe case `page_plan_steps` of `complex_query` on every runtime: the steps are the statements that the page sends, and a bad page, a bad size, a limited chain and an unconnected model are refused (DSL-159).
- The plan steps of a page hold in the recipe case `page_plan_steps` of `complex_query` on every runtime: the steps are the statements that the page sends, and a bad page, a bad size, a limited chain and an unconnected model are refused (DSL-159).
- The plan steps of a page hold in the recipe case `page_plan_steps` of `complex_query` on every runtime: the steps are the statements that the page sends, and a bad page, a bad size, a limited chain and an unconnected model are refused (DSL-159).
- The plan steps of a page hold in the recipe case `page_plan_steps` of `complex_query` on every runtime: the steps are the statements that the page sends, and a bad page, a bad size, a limited chain and an unconnected model are refused (DSL-159).
- A recipe owner of `contracts/features.json` holds no list of cases: reading the manifest takes them from the recipe, so a case added to a recipe cannot leave an owner list stale.
- `gen --check` (DBS-175) is the case `check_reports_differences_without_writing` of the recipe `generator`, through the new op `generator.check` in every runtime; the Python coverage file of it is removed.
- A recipe owner of `contracts/features.json` holds no list of cases: reading the manifest takes them from the recipe, so a case added to a recipe cannot leave an owner list stale.
- `gen --check` (DBS-175) is the case `check_reports_differences_without_writing` of the recipe `generator`, through the new op `generator.check` in every runtime; the Python coverage file of it is removed.
- A recipe owner of `contracts/features.json` holds no list of cases: reading the manifest takes them from the recipe, so a case added to a recipe cannot leave an owner list stale.
- `gen --check` (DBS-175) is the case `check_reports_differences_without_writing` of the recipe `generator`, through the new op `generator.check` in every runtime; the Python coverage file of it is removed.
- `gen --check` (DBS-175) is the case `check_reports_differences_without_writing` of the recipe `generator`, through the new op `generator.check` in every runtime; the Python coverage file of it is removed.
- The plan steps of a page hold in the recipe case `page_plan_steps` of `complex_query` on every runtime: the steps are the statements that the page sends, and a bad page, a bad size, a limited chain and an unconnected model are refused (DSL-159).
- A recipe owner of `contracts/features.json` holds no list of cases: reading the manifest takes them from the recipe, so a case added to a recipe cannot leave an owner list stale.
- `gen --check` (DBS-175) is the case `check_reports_differences_without_writing` of the recipe `generator`, through the new op `generator.check` in every runtime; the Python coverage file of it is removed.
- `gen --check` (DBS-175) is the case `check_reports_differences_without_writing` of the recipe `generator`, through the new op `generator.check` in every runtime; the Python coverage file of it is removed.
- The catalog connection, read-only refusal, describe and table page tests of Rust are cases of the catalog_connection recipe in all six runtimes, and TypeScript describes a SQLite view instead of failing with TABLE_METADATA_INVALID.
- The cleanup errors of apply (PLN-97 to PLN-101, PLN-106) and a rollback of a recorded step outside the plan are cases of the `dbspec.apply_fault` recipe in every runtime, through injected statements; the native tests are gone (#T334-3-18).
- A load of a schema value (SCH-12) reports every diagnostic in one form in every runtime, `<line>:<column> <rule>: <message>` joined by `; `, with lines counted from the document, and the `dbspec.load_set` recipe compares them (#T334-3-18).
- Tests: `make repo-check` passes again: the check `schema-set.mjs` reports through `caseTest`, the `param-uses-typescript` row runs the tracked `coverage_planner.mjs`, the two conformance targets of T334-3-5 are in `CHECK_TARGETS` and the `conformance` CI group, and two failure messages state their fix (#T334-3-18).
- The refusal of a markdown connect (PRT-64) is a recipe case, `markdown.connect`, on a listener each runtime runs, and the native tests it replaces are gone. A refused TLS connection in Rust names no database in its message (CFG-16).
- A MySQL TLS connection that a certificate refuses returns `CONFIG` with `TLS connection failed` in every client: Go, TypeScript and Rust returned `DRIVER` (CFG-16). The TLS connection and its refusals are recipe cases.
- Go, PHP and the PHP extension refuse a SQLite `busy_timeout` that is not a whole number, and Go refuses a malformed `_pragma` and the SQLite path `/`, each with `CONFIG` (CFG-11, CFG-12), and PHP names the path in that refusal. An unreadable MySQL `ssl-ca` reads `is not a readable file` in every client that checks it, and the Python refusal of a negative timeout reads `statement timeout must not be negative`. A DSN that returns `CONFIG` creates no file. The refused DSN and configuration forms of CFG-36 and CFG-37 are recipe cases, with their messages, and the native tests they replace are gone.
- The refusal of a markdown connect (PRT-64) is a recipe case, `markdown.connect`, on a listener each runtime runs, and the native tests it replaces are gone. A refused TLS connection in Rust names no database in its message (CFG-16).
- A MySQL TLS connection that a certificate refuses returns `CONFIG` with `TLS connection failed` in every client: Go, TypeScript and Rust returned `DRIVER` (CFG-16). The TLS connection and its refusals are recipe cases.
- Go, PHP and the PHP extension refuse a SQLite `busy_timeout` that is not a whole number, and Go refuses a malformed `_pragma` and the SQLite path `/`, each with `CONFIG` (CFG-11, CFG-12), and PHP names the path in that refusal. An unreadable MySQL `ssl-ca` reads `is not a readable file` in every client that checks it, and the Python refusal of a negative timeout reads `statement timeout must not be negative`. A DSN that returns `CONFIG` creates no file. The refused DSN and configuration forms of CFG-36 and CFG-37 are recipe cases, with their messages, and the native tests they replace are gone.
- PRT-82 states the order in which a statement writes its columns, and DBS-67 that an `update` and a delete of a soft-deleted table match only rows whose column is null; `tests/planner/runtime-model.json` holds them in all dialects.
- PRT-82 states the order in which a statement writes its columns, and DBS-67 that an `update` and a delete of a soft-deleted table match only rows whose column is null; `tests/planner/runtime-model.json` holds them in all dialects.
- PRT-82 states the order in which a statement writes its columns, and DBS-67 that an `update` and a delete of a soft-deleted table match only rows whose column is null; `tests/planner/runtime-model.json` holds them in all dialects.
- PRT-82 states the order in which a statement writes its columns, and DBS-67 that an `update` and a delete of a soft-deleted table match only rows whose column is null; `tests/planner/runtime-model.json` holds them in all dialects.
- The refusal of a markdown connect (PRT-64) is a recipe case, `markdown.connect`, on a listener each runtime runs, and the native tests it replaces are gone. A refused TLS connection in Rust names no database in its message (CFG-16).
- A MySQL TLS connection that a certificate refuses returns `CONFIG` with `TLS connection failed` in every client: Go, TypeScript and Rust returned `DRIVER` (CFG-16). The TLS connection and its refusals are recipe cases.
- Go, PHP and the PHP extension refuse a SQLite `busy_timeout` that is not a whole number, and Go refuses a malformed `_pragma` and the SQLite path `/`, each with `CONFIG` (CFG-11, CFG-12), and PHP names the path in that refusal. An unreadable MySQL `ssl-ca` reads `is not a readable file` in every client that checks it, and the Python refusal of a negative timeout reads `statement timeout must not be negative`. A DSN that returns `CONFIG` creates no file. The refused DSN and configuration forms of CFG-36 and CFG-37 are recipe cases, with their messages, and the native tests they replace are gone.
- The round trip and rotation of an ordered-json AES column (COD-7) are a case of the aes_rotation recipe in all six runtimes, with the stored cell read past the codec; the native tests are gone.
- A process deadline reports a process that has ended, and its case holds that the pid is gone (#T334-3-4-22)
- The refusal of a markdown connect (PRT-64) is a recipe case, `markdown.connect`, on a listener each runtime runs, and the native tests it replaces are gone. A refused TLS connection in Rust names no database in its message (CFG-16).
- A MySQL TLS connection that a certificate refuses returns `CONFIG` with `TLS connection failed` in every client: Go, TypeScript and Rust returned `DRIVER` (CFG-16). The TLS connection and its refusals are recipe cases.
- Go, PHP and the PHP extension refuse a SQLite `busy_timeout` that is not a whole number, and Go refuses a malformed `_pragma` and the SQLite path `/`, each with `CONFIG` (CFG-11, CFG-12), and PHP names the path in that refusal. An unreadable MySQL `ssl-ca` reads `is not a readable file` in every client that checks it, and the Python refusal of a negative timeout reads `statement timeout must not be negative`. A DSN that returns `CONFIG` creates no file. The refused DSN and configuration forms of CFG-36 and CFG-37 are recipe cases, with their messages, and the native tests they replace are gone.
- The refusal of a markdown connect (PRT-64) is a recipe case, `markdown.connect`, on a listener each runtime runs, and the native tests it replaces are gone. A refused TLS connection in Rust names no database in its message (CFG-16).
- A MySQL TLS connection that a certificate refuses returns `CONFIG` with `TLS connection failed` in every client: Go, TypeScript and Rust returned `DRIVER` (CFG-16). The TLS connection and its refusals are recipe cases.
- Go, PHP and the PHP extension refuse a SQLite `busy_timeout` that is not a whole number, and Go refuses a malformed `_pragma` and the SQLite path `/`, each with `CONFIG` (CFG-11, CFG-12), and PHP names the path in that refusal. An unreadable MySQL `ssl-ca` reads `is not a readable file` in every client that checks it, and the Python refusal of a negative timeout reads `statement timeout must not be negative`. A DSN that returns `CONFIG` creates no file. The refused DSN and configuration forms of CFG-36 and CFG-37 are recipe cases, with their messages, and the native tests they replace are gone.
- The round trip and rotation of an ordered-json AES column (COD-7) are a case of the aes_rotation recipe in all six runtimes, with the stored cell read past the codec; the native tests are gone.
- The conformance bodies with generated methods and the fixed-clock bodies are compared with the recipe conformance_verification and fixed_clock.json, and the fixed-clock bodies now state the exact clock.
- The round trip and rotation of an ordered-json AES column (COD-7) are a case of the aes_rotation recipe in all six runtimes, with the stored cell read past the codec; the native tests are gone.
- `docs/spec/interfaces.md` states the savepoint of the `transaction_send` form of the Rust crate as INT-46a, and the native transactions coverage of Go, PHP and Rust is gone; the recipe `transactions` holds it.
- The recipe `transactions` holds what the native transaction tests held: a model on no connection, the four row locks, every isolation level, a read-only write, `timeoutMs`, retry attempts, the default retry, a retry of 0, a real two-flow deadlock and the SQLite busy writer.
- The recipe `parameter_chunking` holds that a limit on a split list fails with `IR_INVALID` before any statement (PRT-76), not only its code.
- The recipe `statement_events` holds the failure of a subscriber as INT-96 states it, in all six runtimes on the three databases: the exact message and the error of the subscriber as its cause, which a `{"error": <code>}` outcome may now name with `message` and `cause`.
- The PHP, TypeScript and Go natives of the runtime model are compared value by value and gone: the recipes add the bench set with its external document, the manifest text without a comment or diagram, the select-explicit flag, an i16 condition, the clock per inserted row, an assigned `default now` column, and a repeated document or an empty text refused by rule. PRT-81 states the `default now` exception of PRT-33.
- The verification errors of apply and rollback are the recipe `tests/dbspec/apply-verification-errors.json` in all six runtimes, through the op `dbspec.apply_fault`, in place of a native test in each runtime; the cases of a rollback on real drift now run in every runtime (PLN-92, PLN-93, PLN-96).
- The decimal document set of `contracts/fixtures/dbspec-set.json` is the recipe `tests/dbspec/set-decimal.json` on the three databases in all six runtimes: it installs the set and creates and reads its two amounts exactly, in place of a native test in each runtime (DBS-108, SCH-7).
- The physical run of the rendered statements of `tests/dbspec/ddl.json` is the recipe `tests/dbspec/render-physical.json` on the three databases in all six runtimes, through the op `dbspec.ddl_behavior`, in place of a native test in each runtime (DIA-113).
- The MySQL introspection of the checks of SHOW CREATE TABLE is the recipe `tests/dbspec/show-create-introspect.json` in all six runtimes, through the op `dbspec.introspect_shown`, which holds what each case of `tests/dbspec/show-create.json` expects
- The SQLite unsupported column reason of DIA-191 is the recipe `tests/dbspec/introspect-messages.json` in all six runtimes, through the op `dbspec.introspect_sqlite`, and each compares the whole list of unsupported objects; a test of it in a single runtime is gone
- A recipe's expect names exactly the databases that run its step, so a case with `only` no longer states outcomes on databases that never run it (FCV-4, FCV-10).
- The PHP, TypeScript and Go natives of the runtime model are compared value by value and gone: the recipes add the bench set with its external document, the manifest text without a comment or diagram, the select-explicit flag, an i16 condition, the clock per inserted row, an assigned `default now` column, and a repeated document or an empty text refused by rule. PRT-81 states the `default now` exception of PRT-33.
- The parameter indexes of a value function are a case of the conformance_verification recipe, read from the statement events, and the rejections of an ordered-json AES column are cases of the invalid recipe, in all six runtimes.
- CR32 gives the times that rule out a harness stop of the tool call.
- The owners of parameter_chunking declare model_parameter_after_schema_change.
- catalog_read_budgets names its wait for all three databases, as a recipe's sql must.
- The Python and Rust native tests of constraints_and_relations are gone; the recipes hold their cases (#T334-3-4-21)
- The PHP, TypeScript and Go natives of the runtime model are compared value by value and gone: the recipes add the bench set with its external document, the manifest text without a comment or diagram, the select-explicit flag, an i16 condition, the clock per inserted row, an assigned `default now` column, and a repeated document or an empty text refused by rule. PRT-81 states the `default now` exception of PRT-33.
- TypeScript exports `transactionConflict(message)` and Python exports `transaction_conflict(message)`, the retryable `DEADLOCK` error of INT-48, which only the other runtimes had; the utilities of both use it and the recipe helpers call it. The recipe `model_queries_chain` reads the scalar SUM of a joined child as the integer of INT-160 and compares the message of the NULL collection key.
- The recipe `tests/dbspec/runtime-model.json` with the new op `dbspec.runtime_model` holds what Rust `dbspec_runtime.rs` asserted of entity names, tables, keys, settings and field values, and all six runtimes run it (DBS-65, DBS-85, DBS-111, DBS-112). `dbspec.load_set` also checks that a manifest text reads back to its hash (DBS-100, DBS-103). What only Rust exposes stays native, named in FCV-2.
- The recipe `tests/planner/runtime-model.json` holds what Go `runtime_model_test.go` held and all six runtimes run it: i16 read and plus, the insert of a default or a missing required column (PRT-81), and the audit slot of audited writes (PRT-32, PRT-82). `planner.compile` compares an audit slot with its `name` and, with `assemble_types`, the output types.
- AES rotation of every AES column, of the rows not at the current version, its status, and the write with the key of the current version are cases of the aes_rotation recipe in all six runtimes, and the native rotation tests are gone.
- The refusal of a markdown connect (PRT-64) is a recipe case, `markdown.connect`, on a listener each runtime runs, and the native tests it replaces are gone. A refused TLS connection in Rust names no database in its message (CFG-16).
- A MySQL TLS connection that a certificate refuses returns `CONFIG` with `TLS connection failed` in every client: Go, TypeScript and Rust returned `DRIVER` (CFG-16). The TLS connection and its refusals are recipe cases.
- Go, PHP and the PHP extension refuse a SQLite `busy_timeout` that is not a whole number, and Go refuses a malformed `_pragma` and the SQLite path `/`, each with `CONFIG` (CFG-11, CFG-12), and PHP names the path in that refusal. An unreadable MySQL `ssl-ca` reads `is not a readable file` in every client that checks it, and the Python refusal of a negative timeout reads `statement timeout must not be negative`. A DSN that returns `CONFIG` creates no file. The refused DSN and configuration forms of CFG-36 and CFG-37 are recipe cases, with their messages, and the native tests they replace are gone.
- The coverage of `model_queries` and `model_writes` names its recipes as FCV-12 writes (`recipe`, `symbol`, and `cases` without a case that `only` leaves out on that database). The Rust workspace run skips the program of a Rust recipe owner, where the skip list threw on the first owner with no case symbols.
- The recipe case of a builder error compares the whole message, as the native tests it replaced did, and Rust gives `limit` the same text as the other runtimes
- The cases of tests/bind/vectors.json that a recipe already holds are gone from it: the file keeps the native host values and the cases that Go and Rust refuse at compile time, and no runtime reads its removed `message` and `control` sections (T334-3-24).
- The binding-value units of docs/spec/interfaces.md (INT-1 to INT-11, INT-87, INT-88) that more than one runtime binds were read per runtime, and none both reads no database and has one public call in all six runtimes: group-result-exact-i64 and collection-identity-from-fixture test internal decodes and keys, so they stay native under FCV-2; native-row-cell-bytes, model-read-null-and-empty-text and coverage-composite-keys-composite-key-rows read a database, so they belong to the database recipes; query-terminal-first-builder-error reads no database, and T334-3-24 moved it into the recipe public-interface; generated-field-types-follow-runtime-model is the generator output of T334-3-17. No recipe is converted under this row (T334-3-19).
- The TypeScript, PHP and PHP extension immutable write coverage files are gone: the recipe immutable_write holds their assertions on each database, and constraints_and_relations owners read the two recipes.
- The TypeScript, PHP and PHP extension request hook coverage files are gone: the recipe request_hook holds their cases on each database.
- The cases of the request hook that only native tests held are cases of the recipe `request_hook` in all six runtimes, through the new hook actions `rebind` and `bad_param` and `first` on `assign`: a hook that rewrites a restore key, a parameter index outside the request, no statement on a refused restore, and the bound value of a hooked `getQuery`. The native tests of TypeScript and PHP keep only what a recipe cannot state: the handle sharing its connection, and a hook that reads the bound parameters.
- The statement event coverage files of TypeScript, PHP and the PHP extension are removed: the eight vectors they ran are the eight cases of the recipe `statement_events`, event by event on the three databases. The TypeScript helper also refuses an event error that is not an `OrmError`, and the check that the PHP extension publishes events natively moves to `StatementEventsTestExtensionTest`.
- The statement runner coverage files of TypeScript, PHP and the PHP extension are removed: their two reads of `SELECT 1`, outside and inside a transaction, are cases of the recipe `statement_runner`, which also names their feature owners.
- make group-rows-db-rust passes no DSN to a test that creates its own SQLite case database (#T334-3-4-20)
- A notify publishes its statement event in Go, Python, PHP and the PHP extension, as a case of the recipe `statement_events` requires (INT-91).
- The uses of each parameter, the output columns of a plan, blind index sources, a composite upsert key, the operators of each column type and a request of another manifest are recipe cases of all six runtimes, through the new ops `ir.param_uses` and `planner.columns`; TypeScript and Python now refuse an order comparison on `uuid`, as the others did.
- The AES envelope, its tampering, a wrong key and the blind index vector are cases of the codec recipe in all six runtimes, with the form of an envelope as an expect, and the hostcodec tests of Go, PHP and the PHP extension are gone.
- The immutable write of Go is its recipe, and the Go coverage tests of the generated connection, the bench manifest install, the model generation check and the hot-path read run in the normal go test: the first two take case databases in place of the seeded bench database.
- CR32 records what the exit 137 of catalog_read_budgets on the PHP extension is not; its sender stays unknown and no fix is made.
- CR31 states what holds: the PHP extension already computes and declares CatalogColumn::$checkPrecision.
- The coverage test binds no healthy run by a number of its own, and a process that never ends tests the process deadline (#T334-3-4-19)
- orm pins kit 0.0.93 and takes its `ci-pipeline.yml`, where the install of the PHP symbol extractor moved into `ci-setup`. (#T334-3-4-18)
- The ordered-json, codec-column and batch-create writes are the cases of the recipe `model_writes_chain` on the builder of every runtime: member order and number text, a repeated member name, codec columns in the stored text, an IP with whitespace, a stale optimistic update, and `creates` (refused before any statement, over the SQLite bind limit, rows in order across batches, every batch rolled back); the coverage tests of the feature are gone. `contracts/features.json` declares the empty `dependents` of the `model_writes` and `model_queries` coverage, which the schema requires.
- The chains of the generated-model queries are the cases of the recipe `model_queries_chain` on the builder of every runtime: page and total, sum, function column, removed columns, join with its index and subquery, relation, a NULL collection key and group rows; the coverage tests of the feature are removed, and PRT-35 fixes the code of a NULL key, not its message
- AES rotation of every AES column, of the rows not at the current version, its status, and the write with the key of the current version are cases of the aes_rotation recipe in all six runtimes, and the native rotation tests are gone.
- The uses of each parameter, the output columns of a plan, blind index sources, a composite upsert key, the operators of each column type and a request of another manifest are recipe cases of all six runtimes, through the new ops `ir.param_uses` and `planner.columns`; TypeScript and Python now refuse an order comparison on `uuid`, as the others did.
- The AES envelope, its tampering, a wrong key and the blind index vector are cases of the codec recipe in all six runtimes, with the form of an envelope as an expect, and the hostcodec tests of Go, PHP and the PHP extension are gone.
- The refusal of two unaliased relations with one result name (CPX-5) is the case `duplicate_relation_name` of the recipe `complex_query` in every runtime; the Python test of it is removed, and the Python interface_contract coverage stays native without reading the feature environment.
- The feature checker reads a recipe owner from the results its runner writes (FCV-12): every recipe runner appends a `CASE` line to the file of `ORM_RECIPE_RESULTS` when a case passes, the owner names its recipe, and the recipe is its list of cases, so request_hook lists its sixteen cases rather than fourteen.
- The statement runner runs in the recipe `statement_runner` alone in the six runtimes: its native and coverage tests are gone, except the refusals of FCV-2.
- The utility groups, the local value of a transaction, `wasInserted` and the report with no waiter are the recipe `utils` in the six runtimes; the flow and disposal units and the waiter stay native, as FCV-2 states.
- An added column reads by the type of its plan column in every runtime (INT-160): an added MySQL SUM is the integer 906 in all of them, not the text "906"; a text that is not exactly an integer of the type fails with `CODEC_DECODE`, where PHP cast it; and a SUM of an `i16` or `i32` column has the plan type `i64`.
- The Rust retry after a schema change parses the statement with the types the server infers and binds each value as that type, so a parameter whose column changed type holds as in the other clients.
- A Go statement on the pool outside a transaction takes the same retry as a model statement after a schema change, so `Aes().Status` holds through it.
- A model statement from before a schema change runs again once outside a transaction in Go, Rust, TypeScript and Python, in one transaction that opens with `DEALLOCATE ALL`, for a changed result type and for a parameter that keeps its old type; CFG-28 states it. The Rust catalog `query` retries the same way, and `current_namespace` and `describe_table` run in a read-only session.
- A client that stops reading a result can no longer take ProxySQL down: the test servers set `mysql-threshold_resultset_size` to 65536, CFG-34 and CFG-35 state the ProxySQL settings for users, and `catalog_read_budgets` reads on another connection that a statement a budget stopped is gone. The Rust catalog closes the socket of a stopped read at once.
- Every lane of `client-pooler-check` runs the recipe units with a database through the poolers: the PHP, PHP extension, TypeScript and Python lanes take them from `config/parity.json`, one command per unit.
- A budget stop of a read of the Rust catalog returns `CATALOG_LIMIT` at once, through ProxySQL too: on MySQL and PostgreSQL the read returns without a `ROLLBACK` and its connection closes.
- `composite_keys` is held by its recipe alone: its six native coverage tests are gone after their assertions were compared with the recipe in every runtime. The Rust test of group rows takes its own SQLite case database and writes its rows. (#T334-3-4-17)
- A Go test of `packages/go/internal/buildconstraints` reads every Go file of the modules of `go.work` and fails on a build tag other than a platform constraint or a tag of `GO_TEST_TAGS`; the failing dbspec harness fixture moved to `packages/go/engine/dbspec/testdata/fixture` without a tag.
- The inline form of the recipe op `dbspec.analyze` checks that the analysis holds the document, positions and diagnostics of `parse` (DBS-134), so Go, TypeScript, Python and PHP check it as Rust did, and Go `TestAnalyzeIsParse` is gone.
- Go `runtimemodel.LoadSet` fails with the code `SCHEMA_INVALID` that SCH-12 states, as a `*SetLoadError`, and the recipe helper reads that code instead of translating diagnostics.
- The canonical forms, state machine rules and markdown storage rules of the Go `rules_test.go` are cases of `tests/dbspec/rules.json`, so all six runtimes run them.
- The token and format cases of Go `TestAnalyzeClasses` and Python `test_dbspec_analyze.py` are cases of `tests/dbspec/rules.json`, so all six runtimes run them; only a text that a JSON line cannot hold stays native.
- The load of a document set of SCH-12 is the recipe `tests/dbspec/load-set.json` in all six runtimes, through the new op `dbspec.load_set`, and its native tests go.
- The default select set of PRT-9 is the recipe `tests/planner/default-select-set.json` in all six runtimes, and its native tests go.
- The worked token example of the Go analysis test is the case `analyze-worked-example` of `tests/dbspec/rules.json`, and the native header token tests of TypeScript and Python go, because `analyze-header` holds them.
- The complex product search is one recipe, `complex_query`, in all six runtimes on the three databases: its full-text OR filters, plan steps through `getPagePlanSteps`, page, six relations and statement events. The 18 pre-seeded complex query databases are gone: `make complex-query-check` runs the recipe, and each runtime keeps only its native test of `getPagePlanSteps` refusals.
- The complex product search is one recipe, `complex_query`, in all six runtimes on the three databases: its full-text OR filters, plan steps through `getPagePlanSteps`, page, six relations and statement events. The 18 pre-seeded complex query databases are gone: `make complex-query-check` runs the recipe, and each runtime keeps only its native test of `getPagePlanSteps` refusals.
- The complex product search is one recipe, `complex_query`, in all six runtimes on the three databases: its full-text OR filters, plan steps through `getPagePlanSteps`, page, six relations and statement events. The 18 pre-seeded complex query databases are gone: `make complex-query-check` runs the recipe, and each runtime keeps only its native test of `getPagePlanSteps` refusals.
- A generated model of a set that uses an external document connects and reads a row of the used external table in a native test of every runtime, which fails when the generated schema value drops the external text; Go also compiles that output, and the PHPStan check of the query methods is bound in both PHP modes again.
- A Python model read of a cell that its codec refuses raises `OrmError` with the code, as a write does, in place of `CodecError`; a direct codec call keeps `CodecError`.
- TypeScript `toJSONText()` and `JSON.stringify(row)` no longer throw on a row that holds a bigint: both write the exact integer as a JSON number, also inside a styled value.
- The Python coverage files of request_hook and statement_events and the statement runner are removed: their cases are the recipes, which take their databases from their run (FCV-9), so nothing in those files reads `ORM_FEATURE_DATABASE` or `ORM_FEATURE_DSN`. The Python performance gate reads `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN` and `BENCH_SQLITE_DSN`.
- The request_hook recipe holds what the native tests held in every runtime: the hooked handle shares the subscribers of its connection and leaves the original handle unhooked, the hook reads a bound parameter, a planned read binds the value the hook added, an invalid parameter index and a restore with no key run no statement, a child with no handle reads under the scope of its parent, and the three restore key rewrites. `hook.install` with `as` and the hook actions `assign_first`, `rewrite`, `invalid_param` and `record_param` are in all six runtimes.
- The refusal of an immutable table is the recipe `immutable_write` (DBS-84): an update and a delete fail with `DRIVER`, the message holds `table refused_row is immutable`, the driver cause stays, and a later read gives the stored value. The outcome of an op takes `message_holds` and `driver_cause`. The delete was not checked in any runtime before. (#T334-3-4-16)
- The merge of a split root `in` list is tested through the public query on a table without its primary key, in the recipe `parameter_chunking`.
- Key identity, typed lookup, the exact group value and the configured key of a collection are cases of the recipe `collection`, through the new op `collection.key` and the markdown chains `group_count_i64`, `collection_typed_key` and `collection_key_name`.
- The merge of a split root `in` list is tested through the public query on a table without its primary key, in the recipe `parameter_chunking`.
- Key identity, typed lookup, the exact group value and the configured key of a collection are cases of the recipe `collection`, through the new op `collection.key` and the markdown chains `group_count_i64`, `collection_typed_key` and `collection_key_name`.
- The Python coverage files of request_hook and statement_events and the statement runner are removed: their cases are the recipes, which take their databases from their run (FCV-9), so nothing in those files reads `ORM_FEATURE_DATABASE` or `ORM_FEATURE_DSN`. The Python performance gate reads `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN` and `BENCH_SQLITE_DSN`.
- The request_hook recipe holds what the native tests held in every runtime: the hooked handle shares the subscribers of its connection and leaves the original handle unhooked, the hook reads a bound parameter, a planned read binds the value the hook added, an invalid parameter index and a restore with no key run no statement, a child with no handle reads under the scope of its parent, and the three restore key rewrites. `hook.install` with `as` and the hook actions `assign_first`, `rewrite`, `invalid_param` and `record_param` are in all six runtimes.
- Key prefix methods, scanned chain methods, used external tables, the absence of lint suppressions and the manifest hash of generated code are cases of the `generator` recipe in all six runtimes, and their native tests are gone; the command line of the generator, the type of a generated member and the loading of a generated module stay native, each with its reason in docs/spec/feature-coverage.md.
- The recipe `schema_install` holds the difference an install names: the outcome of every op takes `message_suffix`, and `install_external_drift` expects the message to end with `column user.coverage_missing does not exist`. The three tests of `CoverageSchemaInstallNativeTest` that read `coverageItemsOf` are gone; that recipe and `SchemaSetTest` hold them. (#T334-3-4-15)
- An integer of a markdown answer is a JSON number with no fraction or exponent (PRT-69): `3.0` in an integer column is `CODEC_DECODE`
- The statement runner is the recipe `statement_runner`, whose cases all six runtimes run on MySQL, PostgreSQL and SQLite through the new op `utils.run`. The Go `TxFrame.Run` and the Rust `TxFrame::run` return a MySQL text column as text, where they returned bytes. A frame used after its transaction ended now fails with `CONFIG` in Go, TypeScript, PHP and the PHP extension: Go returned `DRIVER`, and TypeScript and PHP ran the statement. A statement that is not text fails with `CONFIG` in TypeScript, where it returned `DRIVER` (INT-150a, INT-150b).
- The refusal of an unknown dialect by `planSteps` and `render` is the two cases of the recipe `tests/dbspec/dialect-refusal.json` in Go, PHP, the PHP extension, TypeScript and Python; Rust keeps its compile fixtures, because it takes a dialect by an enum type.
- A `sql` field of a recipe is a text or an object with all three databases, as FCV-4 states: a partial map made a missing database run nothing, which FCV-10 forbids. The fulltext index steps are a text with `only`. (#T334-3-4-14)
- The recipe schema names `query.search_chain` in its step union, declares `message_suffix` on the catalog errors, and every recipe of the parity suites is valid against it. The audit recipe finds a restored row by the actor of its audit record, not by a key number. The feature tests hold again after the tests and owners that other rows removed. (#T334-3-4-13)
- The keyring versions of INT-74 and INT-130 and the first builder error of INT-88 and INT-89 are the cases of the recipes `public-interface` and `public-interface-signed`, which every runtime runs through the new ops `keyring.versions` and `markdown.builder`; PHP and the PHP extension now record the refusal of a condition value at the chain call, as Go, TypeScript, Python and Rust do, so the terminal returns the first error (T334-3-24).
- The recipe `performance_gate` holds the planned statement of the primary-key and descending 100-row reads (the 27-column projection in order, and the limit binds of each database) by `pk_statement` and `list_statement`, and the AES key version and decoded cells by `aes_cells`, so the TypeScript timing file asserts no correctness. It reads its seeded database from `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN` or `BENCH_SQLITE_DSN` and no longer from the feature environment.
- `getPagePlanSteps(page, perPage)` is a public terminal in all six runtimes (DSL-159): the role, tables and statement of each step of the plan that `getsPage` runs, without running it. It shares its request and plan call with `getsPage`.
- The `dsn.connect` recipe op runs `SELECT 1` through `utils().run` on the connection that it opens, in all six runtimes, so that a DSN connects to a database that answers; the PHP `CoverageDsnTest` keeps only the SQLite minimum version check, which stays native (DSL-150), and reads no feature environment.
- The refusals of vector 17 (`errors`) have a test before any request in each runtime, `make conformance-refusal-check`: a run on a SQLite file with no table and a statement subscriber in all six, and in Go, TypeScript and Rust a type check that accepts each chain with its error and refuses a use that drops the error. A statement whose prepare fails in Go publishes its statement event with the error, as INT-91 states and the other runtimes do; before, it published none.
- The last catalog_connection coverage tests of the six runtimes are gone: the recipe cases temporal_precision_limit, row_character_capacity, descriptor_column_name, missing_row_conflict, catalog_close_twice and deferred_foreign_key_at_commit hold what they asserted on the three databases. A descriptor with an invalid column name now fails with ROW_SNAPSHOT_INVALID and the cause in its message in Python and the PHP extension, and a second close of a TypeScript catalog does nothing.
- The column name and chain name refusals of the generator are the cases of the `generator` recipe in all six runtimes, each with the code `CONFIG`. The TypeScript scan now refuses a name that no column, chain or operator accepts and a call with the wrong count of values (it declared nothing and let the type checker report it), Go refuses that count during generation, Python refuses an operator that the column does not take and that count, and TypeScript and PHP reserve `fulltext` in a column name (DSL-37, DSL-130).
- The rule diagnostics and canonical forms that only native tables held are the cases of the recipe `tests/dbspec/rules.json`, and running them in all six runtimes corrected the parsers where they disagreed with the spec: a used document or `use` line that fails reports one diagnostic and its tables report nothing more (DBS-149, DBS-153); a repeated `primary key` line reports only that it repeats; the key, action and previous columns of a history table are not copies of recorded columns (DBS-91); a type position takes a word; a diagram coordinate `-0x1` is a `diagram` error; `use` of a document twice reports once; a line after an unknown top-level block reports its own `syntax`; and an `encoding` stop skips the rules of the whole document.
- The statement runner is the recipe `statement_runner`, whose cases all six runtimes run on MySQL, PostgreSQL and SQLite through the new op `utils.run`. The Go `TxFrame.Run` and the Rust `TxFrame::run` return a MySQL text column as text, where they returned bytes. A frame used after its transaction ended now fails with `CONFIG` in Go, TypeScript, PHP and the PHP extension: Go returned `DRIVER`, and TypeScript and PHP ran the statement. A statement that is not text fails with `CONFIG` in TypeScript, where it returned `DRIVER` (INT-150a, INT-150b).
- A catalog session on PostgreSQL sends `DEALLOCATE ALL` right after its `BEGIN` in Go, Rust, TypeScript and Python, so through PgBouncer it reads and writes a table after a schema change changed a statement's types (CFG-28).
- The group row units of the collection are the cases of the recipe `tests/collection/collection.json`, which all six runtimes run through `ir.answer`; the chain `group_count_views` reads the length, the order, the values and `COLUMN_UNSELECTED` of a group result. The forms of a count that only a driver cell holds stay native as `group-row-driver-cell-forms`
- The PHP extension answers a markdown value of the wrong type with `CODEC_DECODE`, as the other runtimes do, not `INTERNAL`
- Rust refuses SQL NULL in a selected group column that is not nullable with `CODEC_DECODE`, as the other runtimes do
- A group row count of text must be the canonical decimal in Go and Rust, which took `00` and `+1`, and PHP and the PHP extension take a whole float count, as INT-90 states
- The audit foreign key is held in both directions: the recipe `audit_triggers` refuses a raw insert with a missing parent and the delete of a referenced parent. The case `soft_delete_statements` holds the guarded update of a soft delete and the filter of each read. A `sql.exec` step takes `refused`, and `events.captured` takes the compare mode `statements`. (#T334-3-4-12)
- A catalog session on PostgreSQL sends `DEALLOCATE ALL` right after its `BEGIN` in Go, Rust, TypeScript and Python, so through PgBouncer it reads and writes a table after a schema change changed a statement's types (CFG-28).
- `make lint-ts` passes: the Rust lane skip list reads its JSON through validated readers, and `config/parity.json` declares the `command` of a binding in its schema.
- The MySQL test server has the account `'orm'@'localhost'` next to `'orm'@'127.0.0.1'`, on a new start and on a server that already runs, so the `case-socket` DSN connects when the case DSN carries the user `orm` of ProxySQL.
- The limit and stress units of dbspec are the cases of the recipe `tests/dbspec/limits.json`, whose documents are written by the `repeat` and `fill` line forms of `dbspec.format`; the native limit tests and the round-trip-only stress tests are gone, and the parse time measurements of `make dbspec-stress-bench` stay.
- The audit transactions, the selected audit columns and the restore of a soft-deleted row are the cases of the recipe `audit_triggers`, which all six runtimes run on MySQL, PostgreSQL and SQLite; their hand-written tests are gone, and the Go context of the audit source (CFG-8a) and the Rust transaction forms (INT-44a) stay native (T334-3-4-11).
- The Rust stress apply of three databases gets each database's deadline from its step count, 250 ms a step plus one minute (testcase `step_budget`), and its apply is stopped by a stall guard that a step restarts, after 30 s with no step (testcase `StallGuard`), as the Go stress test does. Under 11 CPU-bound processes with three runs at once, the old 60 s probe deadline failed each run with `mysql.apply.stress_plan: exceeded 60s` (63.6 to 64 s); with the step budgets, the same load passes in 79.5 to 82.3 s, and alone it takes 22.7 s (T343-5).
- The compiler fixtures wait for the cargo target lease outside their deadline: the Rust trial of each case has no deadline for that wait, as the build of tests/cargo-test.mts has none, and scripts/rust/compiler-fixtures.mts gives its own compile under the lease the PROCESS deadline, so a case that waits behind another run's build passes instead of failing with `deadline 5m0s exceeded` (T343-6).
- The chain values of DSL-49 and DSL-50 are the cases of the recipes `dsl` and `dsl-dynamic`; `markdown.send` takes the chain methods of Eq, Ne and Gt and a list parameter, and the PHP extension and Python native tests are gone. The uses that a compiler refuses stay native in Go, TypeScript and Rust.
- The eight generator scan units are the cases of the `generator-scan` recipe, and their native tests are gone from the five runtimes; TypeScript keeps its test of a parse error on the first line, the one position rule of its own.
- The Go tests that assert only Go mechanics lie in internal test files with their reasons in `config/parity.json`, and `TestGenerateUsesRequestedGoPackageName` is bound to the Go-only generator unit.
- `make client-db-rust-check` runs only the cases that no other target owns, the crate's public connection test needs no outside variable, the compiler fixtures run in order, and generate.mjs leaves no temporary directory.
- The eight cases of the generator scan recipe run in all six runtimes: `generator.generate` is implemented by every recipe runner, each case holds the sources of each language in the forms that its native test used, and the option `before` generates another set first, so the imported-set case needs no native test (T334-3-22-2). The TypeScript test of a non-model call no longer names column methods, which DSL-154 declares for every column.
- The generator refusals of the scan have codes of docs/spec/errors.yaml: `GENERATOR_SCAN_UNATTACHED` for a getter call that nothing attaches (DSL-44) and `GENERATOR_SCAN_PARSE` for a source that does not parse (DSL-152). TypeScript, PHP and Python raise them as their coded errors, Go returns `generator.ScanRefusedError`, and the Rust generator, which returns text, starts its message with the code. A refused Rust generation no longer leaves the output directory and its manifest behind (T334-3-22-1-1).
- `make client-db-go-check` runs the Go packages that `go-test-check` does not run, and leaves `TestMarkdownConformance` to `markdown-conformance-check/go`, so it no longer fails on tests whose runners and servers another target provides (T334-3-27).
- The Go test table of the described catalog read expects `CATALOG_VALUE` for a zoned value, the rule of INT-103 that T334-3-3-8 implemented (T334-3-3-16).
- A PHP process loads the file of a generated model only when it uses that model: `bootstrap.php` names the classes with `Registry::classes`, the runtime model and chain column lookups read the parsed entities, and `Registry::verify` compares a class with its entity at its first use, so an edited class still fails with `CONFIG` before its first statement. Regenerate the models to take this (T358).
- `make recipe-runners-check` enforces one recipe runner per runtime (FCV-15). The PHP runner names its model ops in place of dispatching by the prefix `model.`, and the schema no longer holds `utils.set_local`, `utils.local` and `utils.lock`, which no recipe and no runner used (T334-3-25).
- The generated fulltext methods of the Author model, `fulltextBooleanNameWithDescription` and `fulltextNameWithDescription`, are recipe cases that every runtime runs on the three databases through the new op `query.search_chain`; before, no recipe reached them (T334-3-17-9).
- The refused DSNs of CFG-17 are recipe cases that every runtime runs, three more than before, and two Rust recipe tests that never ran, `dsn_reject_none` and `dbspec_plan_comparisons_none`, now run: their Cargo entries lacked `harness = false`, so the recipe of each had zero tests in Rust (T334-3-23-1).
- The PHP code that orm-gen generates holds the parsed runtime model of its set, so a request of a new PHP process does not parse the manifest: a php-fpm request that reads the model of the bench set takes 0.53 ms instead of 5.04 ms with the opcode cache. Data of another manifest hash or another runtime model format is ignored and the process parses as before; the check of `meta()` holds (DBS-177, DBS-178, T357).
- `CONTRIBUTING.md` states the bootstrap of a fresh checkout in an order that works: `npm ci` with the npm of `devEngines` first, since the Makefile includes kit.
- The MySQL catalog of PHP and the PHP extension holds one connection, PDO, and uses no mysqli (INT-157): `ext-mysqli` and `OrmException::fromMysqli` are gone. A grid query reads the UNSIGNED flag and the charset of every result column from the server, through a temporary table of the query on that connection, so expressions and aliases are typed as in the other runtimes.
- A described catalog read refuses a non-NULL value of a MySQL TIMESTAMP or a PostgreSQL timestamptz or timetz column with `CATALOG_VALUE` in every runtime, reads a CHECK-less SQLite TIME at precision 0 as a CHECK-less DATETIME reads, and returns the stored text of a SQLite TIMESTAMP (INT-103).
- A transaction or savepoint that SQLite rolled back by itself, after `RAISE(ROLLBACK)`, an I/O error or a full disk, reports the error that ended it, in every runtime and in the catalog connection. The client no longer sends a ROLLBACK, ROLLBACK TO SAVEPOINT or RELEASE SAVEPOINT that SQLite answers with `cannot rollback - no transaction is active`, so limepie no longer logs a rollback failure stacked on a disk I/O error (INT-155, T356). The Rust catalog connection also reports a driver error of a row write with its code, as the other runtimes do.
- A SQLite driver error message ends with the name of its extended result code in every runtime, for example `no such collation sequence: nosuch (SQLITE_ERROR_MISSING_COLLSEQ)` (INT-154). A disk I/O error now tells SQLITE_IOERR_SHMLOCK from _FSYNC or _SHORT_READ, where the message named only the primary meaning (limepie S-908). The names are the table of docs/spec/sqlite-result-codes.yaml, which `orm-gen sqlite-codes` writes into each runtime. The PHP client and the PHP extension turn on the extended result codes of pdo_sqlite, and a Rust catalog query error carries its error code (T355).
- The PHP dbspec parser reads an ASCII character of a word without the Unicode table, as the Go reference does: one parse of the bench document takes 6.1 ms instead of 14.7 ms, which php-fpm pays on every request that builds its runtime model (T354).
- catalog read_only_query returns a MySQL or PostgreSQL date, time or datetime as the text of its grid cell in every runtime (INT-153): SELECT 12:34:56.5::time gives 12:34:56.500000, where Go, TypeScript, PHP and the PHP extension gave 12:34:56.5, Python failed on a MySQL datetime and Rust refused TIME with CATALOG_VALUE; the byte budget counts that text (T334-3-3-12).
- packages/php/composer.json declares every PHP extension that the library uses: ext-ctype, ext-filter and ext-mbstring are required, and ext-mysqli (MySQL catalog grid queries) and ext-pcntl are suggested; ComposerExtensionsTest resolves each class and function of packages/php/src to its extension and fails on one that composer.json does not name (T334-3-3-14).
- The byte budget of a grid query counts its converted cells in Go, PHP, the PHP extension and Python, as TypeScript and Rust do (INT-115): the 15 bytes of the time cell 12:34:56.500000, not the driver value it came from (T334-3-3-9).
- `make dialect-facts-check` runs the citation tests of the dialect probes; the probes themselves are go tests of `go-test-check`, which builds and declares what they need, so the target no longer forwards to it with an empty part (T334-3-6-3).
- DBS-121a states that a Python generated setter takes `None` for a column that is not nullable and that the insert of that row refuses it with `CODEC_ENCODE`. Its case, `tests/bind/messages-python-null.json`, is the parity unit markdown-message-python-null-vectors, and PRT-67 cites DBS-121a in place of DSL-29, the `LIKE` operator (T334-3-15).
- The unknown recipe key check runs each runtime as a part of its own through the shared Go and Cargo test runners, the Rust and TypeScript refusal tests report each case, and the check runs in CI as a target of the static group (T334-3-5-6).
- The request builder of the IR fixture cases is `polyspec_orm::testing::ir_request` (feature `test-faults`): the engine unit tests, the manifest hash test and the Rust recipe helper import it, so no crate names a file of another crate by `#[path]`, and `ir-validate-check/rust` runs its two test binaries as two parts (T334-3-25-1).
- The PHP extension stub declares the insertRow parameter with a PHPDoc type that the arginfo generator parses (CR47).
- The php-ext memory check runs the 14 test classes of the AES stress group with the stress test and root_in_chunking in one process under the 128M memory_limit, and it fails when the extension keeps memory across calls (T334-3-4-7).
- A php-ext Validator releases the class-name string it looks up when it is constructed, so 1000 Validators keep no memory (T334-3-4-7-2).
- The php-ext build of a RuntimeModel releases its entity tree, its column, unique and index key strings and its entity names when the model is released, so repeated builds keep no memory (T334-3-4-7-1).
- The AES version and rotation codes COD-44, COD-47, COD-49 to COD-54 and COD-57 to COD-60 run as the recipe `contracts/fixtures/aes_rotation/aes_rotation.json` in all six runtimes on MySQL, PostgreSQL and SQLite; the hand-written tests that the recipe replaces are removed, and COD-48, COD-55 and COD-56 stay native with an FCV-2 reason (T334-3-4-6).
- The TypeScript read of a stored AES version written as text of digits takes that number as the version, as the Go read path does; other text is `CODEC_DECODE` (COD-53, T334-3-4-1).
- The Python read of a stored AES version written as text of digits takes that number as the version, as the Go read path does; other text is `CODEC_DECODE` (COD-53, T334-3-4-2).
- The PHP client and the PHP extension read a SQLite text stored in an INTEGER or REAL column as that text, not as a `CATALOG_VALUE` failure (INT-152, T334-3-4-3).
- make lint-rust passes again on the integration branch: 16 calls of the catalog code, the recipe and markdown helpers and the markdown conformance trials that turned an error into a fallback (Result::ok, unwrap_or, unwrap_or_default, unwrap_or_else, let _) handle the error, and a read limit that does not fit usize is refused with QUERY_LIMIT_INVALID (T334-3-26).
- DIA-6 said that PostgreSQL trims the full-text value; the planners of all six runtimes bind it as it is, which plainto_tsquery and websearch_to_tsquery read the same, and DIA-6 now says so (T334-3-17-2-3).
- The fulltext search behaviour (DSL-32, DSL-33, DIA-6, DIA-187, PRT-75) is one recipe, contracts/fixtures/fulltext_search/fulltext_search.json, run on MySQL, PostgreSQL and SQLite by the recipe helper of each runtime through the op query.search, which compiles the count of a fulltext_boolean predicate on the dialect of the connection and reports the statement and the value it binds: the fulltext_boolean transform on MySQL, the text as it is on PostgreSQL, and OPERATOR_NOT_ALLOWED on SQLite. The six native fulltext tests and their parity unit are removed (T334-3-17-2).
- The dbspec Mermaid vectors (tests/dbspec/mermaid.json) are one recipe: each runtime runs it through its recipe helper in one entry, the compare runners read it, and the native vector tests are removed (T334-3-21).
- composite_keys is a recipe that the six recipe runners run on the three databases: each runtime runs its model ops (model.creates and model.count of CompositeMembership, the tuples of model.query, and a relation with connect, many and alias) through the generated CompositeAccount and CompositeMembership methods, and the recipe reads the memberships relation as the coverage tests read it, a collection of relations(child) under its alias (T334-3-5-12).
- Rust has one recipe runner, packages/rust/tests/src/recipe.rs: the planner.compile, ir.validate and dbspec plan ops that a second runner under packages/rust/orm/tests ran are ops of that runner, the planner, request validation and dbspec plan recipes run as trials of packages/rust/tests/tests, and the second runner is removed; the manifest hash check that is no recipe case is the native test packages/rust/orm/tests/ir_manifest_hash.rs (T334-3-25-1).
- make install generates the Go models in a checkout that has none: packages/go/models.txt generates bindmodel before markdownmodel, whose scanned test imports it (T334-3-15-3c-11).
- The analyze cases of tests/dbspec/canonical.json and tests/dbspec/invalid.json have the dbspec.format step that the compare runners require, and the four whose text has a table without a primary key are invalid cases. After a stopping error no runtime reports a diagnostic of a rule judged on the whole document (DBS-144): the PHP library and the PHP extension no longer report the key and column rules of the tables read before a limit stop. The Rust parser reports an invalid character on a top-level line as the one syntax diagnostic of that line, as Go does (T334-3-18-6-2).
- The native analyze tests that the recipes did not cover are recipe cases: the eight analyze cases of tests/dbspec/canonical.json and the seventeen of tests/dbspec/invalid.json hold the token cases of packages/rust/schema/tests/dbspec_analyze.rs and the focused cases of the PHP DbspecAnalyzeTest, which run in all six runtimes; the Rust file and the PHP limit test are removed, and the PHP test keeps the one case whose text holds an invalid UTF-8 byte, which a recipe text cannot hold (T334-3-18-6).
- The Rust dbspec analyzer classes a word on a line abandoned with a syntax diagnostic as `word`, as DBS-139 and the other runtimes do; a diagram line inside an open diagram block is read as an entry, not as a new block (T334-3-18-6-1).
- The target markdown_conformance of packages/rust/tests/Cargo.toml no longer has test = false, so the rust lane's workspace cargo test runs its 56 markdown trials, and make client-pooler-check passes FLOWMARK to that lane as the markdown runners do (T334-3-13).
- make lint-ts passes again: the recipe key table script narrows its schema with guards, and the owner test iterates the declared owners (T334-3-17-10)
- The Rust build crate tests the column name rules of the model syntax through Builder: a reserved method name and an operator or connector segment are rejected by the generator, and the parity units bind that test instead of the in-module tests of the private manifest module (T334-3-17-7).
- The Go generator test of the stored column name rule calls the exported Generate, the public path that orm-gen uses, instead of the unexported generateGo, and the unit model-new-output-name-rejects-stored-column binds it (T334-3-17-8).
- The PHP library and the PHP extension read the datetime text with a T separator that PRT-67 accepts, and the PHP tests autoload the bind models (T334-3-15-3c-10)
- The Rust client reads the datetime text with a T separator that PRT-67 accepts (T334-3-15-3c-9)
- The ir.answer expect of the recipe takes a params form, `{"none": {"params": [...]}}`, which compares the params of the one request that the listener received (PRT-66, PRT-67), so a chain's bound and wire values can be recipe cases; the six runtimes implement it in their recipe helpers (T334-3-15-5).
- The slot fixture `tests/bind/slots.dbs` has the time4, time5, datetime3, datetime4 and datetime5 columns that the bind chain names, and the generated Go model of each new column has its setter (#T334-3-15-3c-1).
- The Go client accepts the PRT-67 client datetime text with a `T` separator and no offset, such as `2024-01-02T03:04:05.5` (`AsTime` in `packages/go/orm/collection.go`), so a datetime bind of that text no longer fails with CODEC_ENCODE (#T334-3-15-3c-2).
- The stale `unloaded-update-state-go` entry of the `model_writes` feature in `contracts/features.json` is taken from the integration branch, which takes the same fix as `T334-3-17-6` (`8828d675d`) (T326-18).
- The parity check of the TypeScript `getReadCount` members is run on a fresh build: a stale `packages/ts/dist` kept by `var/typescript/dist.key` had reported 25 R11 undeclared-public findings for the models other than Author, and after a rebuild `parity --phase api` reports none, the Author declaration staying as it is (T326-17).
- The Rust tests crate passes clippy with `-D warnings`: its seed reader and its connect step no longer call the disallowed `unwrap_or_default` or `ok` (T326-16).
- The Rust client renumbers the parameters of a request in the walk order of the Go client before it takes the plan cache key, so a request whose parameters were built in another order gets the Go plan cache slots; the composite and predicate vectors of `contracts/fixtures/plan_cache_composite.json` are tested in `canonical.rs` (T326-15-1).
- The PHP extension walks the parameters of a predicate in Go's order, the same as the PHP library, so a predicate with both `p` and `fn` gets the plan cache slots of the Go client (T326-15-3).
- The plan cache key vector of the composite parameter renumbering, `contracts/fixtures/plan_cache_composite.json`, runs in all six runtimes through one parity unit, `plan-cache-composite-parameter-order`, so each runtime's plan cache slots are checked against the same vector (T326-15).
- The five native plan cache tests of the composite vector, in Go, PHP, the PHP extension, Python and Rust, report one named test for each case ID of `contracts/fixtures/plan_cache_composite.json`, the form of the TypeScript test, so the parity check runs both cases in all six runtimes (T326-15-4).
- The PHP library walks the parameters of a predicate in Go's order (p, plus_p, minus_p, ps, fn, value, sub) instead of sorted key order, so a predicate with both `p` and `fn` gets the plan cache slots of the Go and TypeScript clients (T326-15-2).
- Every recipe loader of the six runtimes refuses an unknown file, case, op or step key by name before any case runs, from the key table that scripts/features/schema/recipe-keys.json holds (generated from the recipe schema by scripts/features/recipe-keys.mts); a recipe key that the table does not hold no longer passes silently (T334-3-5-6).
- The stale unloaded-update-state-go check, whose Go test 55fd126fa had moved into the model_writes recipe, is removed from contracts/features.json; the save_updates_the_row_of_its_key case of that recipe covers its DSL-109 keyed update (T334-3-5-8).
- The owner selection of packages/php/tests/CoverageDsnTest.php again names the php and php-extension coverage parts of dsn_connection, since 4a669db8a left the file's SQLite minimum-version test with no owner (contracts/features.json, the php owner inputs and the php-extension owner inputs) (T334-3-5-9).
- The four-client owner test expects the statement-events-check/<runtime> owner targets, which the recipe fixture's owner rule selects for a change of the four-client set; the test also asserts that none of them is a full-suite target (T334-3-5-10).
- The codec test files of T334-3-14 and T334-3-14b are off the coverage owners of authenticated_encryption (commit 13f388644); their owner check now selects no coverage part, and their feature verifications remain (T334-3-14b-3).
- The owner test cases of scripts/features/owners.test.mts match the current owner declarations: the DSN case reads packages/php/tests/DsnConnectionRecipeTest.php, which T334-3-4 made the PHP owner test (CoverageDsnTest.php left the owners), and the four-client case lists the six statement-events-check owner targets that the manifest selects (T334-3-14b-3-2).
- `owners.mts --list` exits 0 at HEAD: fixed by T334-3-17-6 (8828d675d), taken with cherry-pick -x (T334-3-14b-3-1).
- The owner declarations of contracts/features.json name files that exist: the deleted schema test packages/rust/schema/tests/dbspec_plan.rs is removed from its owners, which the recipe runner packages/rust/orm/tests/dbspec_plan_cases.rs replaces, and the Go test TestUnloadedUpdateKeepsAssignedValuesSelectedAndKeyed is restored in packages/go/orm/model_update_state_test.go (T334-3-17-6).
- The plan vectors file tests/dbspec/plans.json is deleted: its version and note move into the recipe tests/dbspec/plan-cases.json, which the readers and tests/dbspec/schema/plans.schema.json now read directly. The empty php-ext subclass DbspecPlanTestExtensionTest is deleted; its six methods still run with the extension in dbspec-php-extension-check/plan (T334-3-17-3).
- The TypeScript recipe test drops the unused import `readDbspecFile`, so the lint step of the TypeScript gate passes (T334-3-17-4).
- The TypeScript package exports the bind-check transforms `fulltextBoolean` and `transformParam` from its entry, as the other runtimes do, so the fulltext_boolean transform has a public call in all six runtimes (T334-3-17-1).
- The timing gates of packages/go/bench (TestHotPathGate) and the stress document test of packages/go/engine/dbspec (TestStressDocument) carried the build tags perfgate and bench, so the normal `go test` left them out. They carry no tag now, the stress test builds only on unix, which its CPU clock needs, and the `-tags bench` runs of the Makefile and the `-tags perfgate` run of perf-test are gone (T334-3-6-5).
- The Go tests of packages/go/markdownmodel, packages/go/decimalmodel and examples carried the build tags markdown, decimalphysical and examples, so the normal go test left them out. Their files carry no tag now, and the targets that run them (markdown-conformance-check, ir-answers-check, decimal-physical-check, example-check) keep their -run lists without the -tags flag (T334-3-6-4).
- The physical Go tests of packages/go/internal/dialects and packages/go/engine ran only under the build tag `physical`, which the hand-kept `-run` lists of the Makefile selected, so the normal `go test` left them out. They carry no tag now and run in go-test-check, which builds and exports what they need; `servers.go` is `servers_test.go`, and the MySQL DSN helper moved to probes_mysql.go, because a production package cannot import a `_test.go` file (T334-3-6-3).
- The format refusal of a dbspec text (DBS-141, ORES-14) ran through six native bindings of the feature coverage-schema-definition-dbspec-format-refusal, each the same function as the suite case dbspec_format_refusal of schema-definition; the bindings are removed and the suite case stands alone, and the set-file generator rule (ORES-21) stays native in each runtime as an FCV-2 runtime-specific entry (T334-3-21-1)
- The constraint_errors and external_relation cases of the constraints_and_relations database feature are the recipe contracts/fixtures/constraints_and_relations/constraints_and_relations.json on mysql, postgres and sqlite, run by the six runtimes' helpers. A foreign key violation on delete leaves the user rows unchanged, CHECK and unique violations fail with CONSTRAINT and DUPLICATE_KEY, and a NoteReader relation reads its SharedNote rows, so those assertions leave the native tests. The native tests keep immutable_write, which is asserted through the driver error chain (runtime-specific; the catalog refuses triggered tables on MySQL by design, ROW_MUTATION_UNSUPPORTED), and soft_delete_restore stays native until audit_triggers converts it on the integration branch, since it needs audited transactions and generated restore entities. The composite key rows stay native (T334-3-4)
- The model_queries database feature is the recipe contracts/fixtures/model_queries/model_queries.json on mysql, postgres and sqlite, run by the six runtimes' helpers. The counts, the missing key and the ordered limit that each coverage test asserted are its cases, so those assertions leave the native tests of the feature, and the native tests keep the aggregate, page total, relation, join, column removal, group rows and collection identity behaviour that no FCV-4 op expresses (T334-3-4).
- The refused DSN cases of CFG-1, CFG-2, CFG-11, CFG-17, CFG-19 and CFG-26 (a non-UTC timezone, an unknown scheme, a missing database name, a relative SQLite path, an address host with VERIFY_IDENTITY, a malformed SQLite path) are one recipe, contracts/fixtures/dsn_reject/dsn_reject.json, which every runtime runs without a database through the new op dsn.connect (FCV-4) (T334-3-23).
- The correctness cases of `performance_gate` (the primary-key read and the list of 100 rows) are a recipe, contracts/fixtures/performance_gate/performance_gate.json, that the six runtimes run on MySQL, PostgreSQL and SQLite; the timing gates stay in make perf-check, because their timing depends on the load of the tests beside them (FCV-2, FCV-14) (T334-3-11).
- The recipe schema refused the model.get_by steps of the model_writes fixture, because both forms took the generic expect instead of the rows outcome that FCV-4 gives model.get_by; both forms now take the rows outcome (T334-3-4-9).
- The recipe schema refused the schema.install step of the schema_install fixture, because its {schema} form had no expect although FCV-4 gives it one; the schema now takes that expect (T334-3-4-8).
- The catalog read returned the driver's integer for a boolean column, so a bool written to a MySQL `tinyint(1)` or SQLite `BOOLEAN` column failed its write check (ROW_WRITE_MISMATCH), and the PHP catalog bound a PHP false as the empty string, which MySQL and SQLite refuse. Every runtime now reads a boolean column as a bool by its column type, and PHP and the PHP extension bind a bool as a bool (DIA-29) (T334-3-11-1).
- The 13 cases of tests/dbspec/plans.json run as the recipe tests/dbspec/plan-cases.json through the ops dbspec.parse, dbspec.parse_plan, dbspec.emit_plan, dbspec.diff and dbspec.plan_steps in the six runtimes, in place of the native plan tests; the before and after physical records moved to tests/dbspec/plans-physical.json, keyed by case id (T334-3-16-2-2).
- The four validation suites of tests/dbspec/plans.json (invalid, chains, parse, comparisons) run as four recipes of the T334-3-2 format in the six runtimes, through the ops dbspec.parse, dbspec.parse_plan, dbspec.diff, dbspec.chain and dbspec.compare, in place of the native plan tests; the compare tools read the recipes beside plans.json (T334-3-16-2-1).
- The planner compile cases (86) run as the recipe tests/planner/compile.json through the op `planner.compile` in the six runtimes, in place of the native compile tests; the five param_uses cases stay in contracts/fixtures/planner.json (T334-3-16-1).
- The statement events of `tests/events/vectors.json` run as the recipe `contracts/fixtures/statement_events/statement_events.json` in all six clients on MySQL, PostgreSQL and SQLite. The native statement-event suite is removed; the server-transaction tests and the coverage owners stay native (T334-3-5).
- The model_writes recipe, contracts/fixtures/model_writes/model_writes.json, runs its six cases on MySQL, PostgreSQL and SQLite in the six runtimes (T334-3-4): config/parity.json binds the units model_writes-<database>. The native save-key, arithmetic, CRUD write-cycle and round-trip tests that the recipe covers are removed. The write cycle keeps its ordered JSON and codec assertions (COD-11, COD-12, COD-15, COD-38, DIA-26), and the create_parts native test stays for its StatementEvent batch assertions. The PHP extension's native write layer is documented as INT-151 and bound to its eight tests (T334-3-4).
- The `dsn.connect` op of FCV-4 runs the DSN connection recipe `contracts/fixtures/dsn_connection/dsn_connection.json` on all six runtimes and the three databases; the native DSN coverage tests are removed, and the parity units bind the six recipe entries (T334-3-4).
- The schema installation cases of the six runtimes are one recipe (`contracts/fixtures/schema_install/schema_install.json`) that runs on MySQL, PostgreSQL and SQLite. The native tests of the same behaviour are removed, the register tests are split into a refusal test and an engine-per-hash test, and SCH-14 to SCH-17 state the cases that stay native under FCV-2: the audit transaction, the hash check at load, the bench model and the engine per hash (T334-3-4).
- The spec states how a database feature runs as a recipe on the run databases: FCV-8 to FCV-14 of docs/spec/feature-coverage.md give the conversion, the databases from the `databases` need and TEST_ENV, the three databases with no exclusion, the failure of a missing DSN, the per-case result, the seed ownership and the native tests (T334-3-4-0).
- The per-target runtime and database cells of check-recipes (CR17 to CR20) are held: they would duplicate kit's CI plan (config/ci.json targets.runtimes and kit-ci-plan). CR17-1 (aaa576d45) is not landed; it is held with CR17 (CR17).
- The DDL behaviour tests of tests/dbspec/ddl.json ran only in the Go runner against a database; the PHP, php-extension, TypeScript, Python and Rust runners now run their behaviour steps on MySQL, PostgreSQL and SQLite, and each fails by name when a DSN is unset (CR16-1).
- A leftover source of a compiler fixture case, from an interrupted run, made the next run fail with EEXIST and left its directory in the tree. The run now overwrites a stale source and removes its scratch directory at the end (CR25).
- The Python and TypeScript generators write models.py and models.ts atomically: a file that already holds the text is left as it is, and a changed file is written to a temporary file of its directory and renamed over the old one, so a test that reads it during a generation never reads a partial file. The targets client-unit-check/orm-gen-python and client-unit-check/orm-gen-typescript test this (T341-2).
- The sixty make targets that run PHPUnit with packages/php/phpunit.xml.dist have php-models among their prerequisites, since its bootstrap requires the generated models that php-vendor-check does not write, and repo-check refuses such a reader without it (T341-1).
- The seven make targets that run the compiled TypeScript client without building it (replica-check, session-state-check, native-error-cause-check/typescript-driver and /typescript-markdown, page-cache-unit-check/typescript, generator-consumer-check/typescript, request-hook-relation-scope-check) have typescript-build as a prerequisite, and repo-check refuses a target that reads the build output without it (T339-5).
- The Makefile and scripts name no kit-install-php-arginfo, so make install no longer calls a target that kit K930 removed; make install, make repo-check/unit and make native-arginfo-php-extension-check exit 0 on PHP 8.4 (T328).
- orm takes kit 0.0.92 (T348): the pin names the release asset of kit 0.0.92 with its integrity, the kit-sync copies are that release's, and make orm-install-rust-crates downloads the crates of every tracked Cargo.lock with cargo fetch --locked, since kit 0.0.92 deletes the cargo-downloads-fetch target that it called.
- The row's premise does not hold: kit's parity-symbols.mts:229-230 reads the Rust nightly from the exceptions of config/toolchain.json, never from a rustNightly key, and orm's config/toolchain.json:16-22 holds exactly that exception (KSTD-5-121).
- The deps-<runtime> targets are not needed: kit's ci-setup.mts:130-133 calls deps-<runtime> only for a runtime that config/ci.json does not set up, and orm declares setup.runtimes for go, php, php-ext, python, rust and ts (KSTD-5-120).
- config/release.json:38-44 declares the generated sources of the PHP extension package as one make entry, php-ext-sources, with both outputs, which the release schema of kit K930 accepts, so the row closes on make kit-check (T325-1).
- divergence-check exits 0 on main 6ff320c72: no implementation diverges through a branch, a narrowing, a feature state or an exception without a kind, since KSTD-7-6 recorded the fixed references of performance_gate (KSTD-5-12).
- orm names none of toolchain-check, cargo-downloads-check or link-state-check, and kit.mk:425 provides link-check, so the row closes on make kit-check repo-check; the one call of the deleted cargo-downloads-fetch (Makefile:2936) is replaced by T348 with the kit 0.0.92 adoption (KSTD-5-117).
- CARGO_SIBLINGS no longer passes `--siblings` (Makefile:215), and kit's link.mts has no such option; the link declaration `.links` is read by kit's link-providers.mts:136, so the row closes on make link-check (KSTD-5-119).
- make uv-install already routes the Python install: Makefile:768 calls `$(MAKE) uv-install DIR=packages/python`, and no raw uv sync remains, so the row closes on its Verification (KSTD-5-118).
- Cancellation of a statement through PgBouncer is best effort, not guaranteed (CFG-31): the PgBouncer cancel race (BUG #14891) was fixed only in 1.18 with a hang side effect, cancels were lost in multi-process setups until peering in 1.19, and SQLx 0.9 has no CancelRequest API, so KSTD-2-11-16-3 closes as impossible (KSTD-2-11-16-3).
- AGENTS.md states the item states of kit P25: an item is `[v]` when it is committed and its unit tests pass, which permits the push, and `[o]` after the push run of `ci.yml` concludes with success; a release takes the id of a `ci.yml` run whose conclusion is success (T309).
- The Rust crates share their test helpers through packages/rust/test-support, and no crate includes another crate's source by `#[path]`: the cross-crate `#[path]` attributes are removed, and a repo test fails on any of them (T349).
- orm pins ordered-json at 0.0.20 in every ecosystem, and each lock is refreshed by its own package manager (T350).
- orm pins kit 0.0.92, whose targets match the crate fetch of orm-install-rust-crates, and takes the principles it ships (T353).
- contracts/check-inputs.json declared no dbspec-php-check/render, so make run-databases refused the target that runs the physical DDL cases and CI's database run did not cover them. The target is declared like its sibling dbspec-plan-php-check (CR55-1).
- The check runner reads the process table with a 256 MiB buffer and names the error code of a failed listing, so a large table no longer fails a step with SIGTERM (T351).
- The parity units of the statement runner (INT-150) name `Utils.run` and the frame `run` in all six runtimes, and bind the statement_runner tests on every database (T345-7).
- The Python runtime makes `utils().run(fn)` public, calling `fn` with the transaction frame of the connection (INT-150, T345-6).
- orm-install-rust-crates fetches the crates of each tracked Cargo.lock with `cargo fetch --locked` itself, since kit deleted cargo-downloads-fetch, so `make install` no longer stops with `No rule to make target` (T352).

A SQLite lock wait between two connections that write the same row ends with `CANCELED` after the busy timeout and is not retried, because SQLite reports no row-lock deadlock: SQLITE_LOCKED (6, 262) is `DRIVER` in every runtime, and transaction_deadlock_retry runs the sqlite case in all six runtimes (PLN-24, CFG-12) (T343-3)

- The statement timeout (CFG-6) and its isolation through a transaction pooler (CFG-27, CFG-28, CFG-29) run as cases of the `dsn_connection` recipe in every client, and `model.connect` takes `statement_timeout_ms` and the DSN `case-pooler`. The Python catalog session through a pooler is a requirement of its own (CFG-41).
- The SQLite lock wait, read during a write and concurrent writers run as recipe cases in the six runtimes; the native tests of those behaviours are gone.
- A failed SQLite BEGIN in Go reports only its error, and a SQLite message names its result code once.
- Several processes writing one SQLite file are a requirement (CFG-42), tested in the six runtimes.
- The model JSON output of an ordered-json value is the recipe case `ordered_json_keeps_its_text_in_the_model_json_output` in six runtimes, with the new step key `json_output`, and its native tests leave; the read of a SQL NULL and an empty text is the recipe `catalog_connection` alone. `to_json_text` of Python alone is COD-68.
- A PHP test run no longer holds a copy of each recipe in its data sets: at PHP's default memory limit it no longer dies while it builds the suite.
- The UTC connection behaviour (CFG-2, DIA-57, DSL-141) runs as cases of the `dsn_connection` recipe in every client, and `model.connect` takes `case?<query>`. A TypeScript MySQL connection whose TLS handshake refuses the certificate now returns `CONFIG`, as CFG-16 states, instead of `DRIVER`.
- Go `DriverFromDSN` is a requirement of its own (CFG-40), and the generated model connections of Go and Rust no longer have tests beside the recipes that connect them.
- A condition value of an `ip` column with white space fails with `CODEC_ENCODE` when the condition is built in PHP, the PHP extension, Python and Rust, as it does in Go and TypeScript (COD-38): on MySQL, which encodes it in SQL with `INET6_ATON`, it read as NULL and matched no row, and on SQLite and PostgreSQL Python raised a `CodecError` that is not an `OrmError`.
- The native tests of `model-ip-input-rejects-whitespace`, `model-codec-columns` and `coverage-model-create-parts` leave: the recipe `model_writes_chain` holds their values, with the refused count, the SQL NULL write and the `IS NULL` condition added.
- The native tests of the value types, the styled SQL NULL read and the decimal round trip keep only what a typed getter returns: the stored values, refusals, conditions and row output move to the `conformance_verification` cases `core_value_types`, `core_styled_null`, `core_styled_states` and `core_decimal_values`, and the fraction into an `i16` to the bind vector `i16-fraction`.
- CR15-2: `scripts/features/recipes.test.mts` refuses a key of the recipe schema that a helper does not read; Go, Python and Rust compare `file_created`, and PHP connects with the `corpus` and `token` of `markdown.connect`.
- Typed, styled null and decimal values are the new cases `core_value_types`, `core_styled_null` and `core_decimal_values` on the new tables `typed_value` and `decimal_value`, and a nested ordered JSON value is a case of `model_writes_chain`. The native ordered JSON test of Go went. FCV-2 states why the three native value units stay. The temporal cell of a Go recipe read is the value model text, as in the other runtimes, and an `i16` past the range reaches the write, which refuses it with `CODEC_ENCODE`.
- CR15-2: the recipe schema takes `model.create` and `model.count` without `connection`, which FCV-4 runs on the case connection, and the owner lists of schema_install and statement_events hold every case of their recipes.
- FCV-2 states why `recipe-unknown-keys` and the three `hot-path-performance-measurement` units stay native: a loader refusal comes before any case, and a time is no value that a case can expect
- The markdown DSN refusals of PRT-63 are cases of `dsn_reject`; DSL-60, DSL-115, DSL-155, CPX-5 and DSL-128 are held by `conformance_verification`, with the new cases `core_conditions`, `core_columns_and_pages`, `core_writes` and `core_duplicate_relation`, and their native units went. FCV-2 states why the four model core units stay native.
- The padding of an `IN` list (CPX-4) is the case `core_in_list_padding`, which reads the statements of one to five values on three databases, and the padded tuples of `composite_key_rows`. The native padding tests of the runtimes went. The native `Request::padIn` of the PHP extension is CPX-6.
- The projection, binds and rows of the hot path reads (PRT-2, PRT-34) are the case `core_projected_reads` of `conformance_verification` on three databases, and their native tests went.
- CR15-2: several sets on a connection, an unregistered set and an edited manifest are cases of the statement_events recipe, and a model op with no connection runs on the case connection in every runtime.
- CR15-2: `sqlite-row-lock-restoration` stays native as an FCV-2 entry, since no public call makes `PRAGMA busy_timeout` fail.
- CR15-2: `schema.empty`, `schema.exists` and `schema.installed` are recipe ops, schema emptiness, existence and the rendered install are cases of schema_install, and PERF-1 states the `BENCH_*` variables of the timing.
- CR15-2: `install` over some tables of a set has one message in every runtime: Go, PHP, the PHP extension and Rust each had their own text, and SCH-10 states it and that of a differing database.
- CR15-2: the add tables and columns behaviour is five cases of the schema_install recipe, `dbspec.add_tables_steps` is a recipe of its own, the native tests are gone, and a refusal case can check its message with `message_contains`.
- The Rust restore reads the key of the request as the request hook left it, before the planner renumbers its parameters, so a hook that sets the key after the label restores the row again (T326-15-1-1).
- Every dbspec compare runner refuses a missing recipes directory with its own path before it reads any recipe file of it; an empty directory is still refused with the recipe file it lacks (T334-3-18-3-1).
- Every dbspec compare and apply runner refuses an unreadable input with its path again: the PHP runners refuse an unreadable plans file instead of ending in a fatal error, the Rust apply runner reads the plans file it is given, and the recipes directory cases expect the recipe file the runner names in it (CR58).
- The TypeScript dbspec compare runner writes its whole refusal to a slow reader of its stderr: it ends on its own once stderr has taken every line, not through process.exit, which dropped the end of a 160 KiB refusal in the full dbspec compare check (CR57).
- The duplication check reports no clone again: the recipe, coverage and compare helpers that the merges of integ/recipes copied are shared in each runtime, one database test class for the PHP recipe tests, one dispatcher of the model ops for the Rust recipes, and the Mermaid skeleton and the where narrowing in one place of Go, Python, TypeScript and Rust (CR56).
- The spec requires the Go generator to generate sets in the order their scans need, refusing a cycle (DSL-157); the parity units bind its tests, the Go test roots hold the moved markdown message test, and the generated condition methods are declared as public API (CR46).
- The parity unit markdown-message-vectors names the Go test at its moved path, packages/go/bindmessages (CR46).
- The duplication check no longer reports the two GenerateSets test setups of the generator, and the Rust orm test probe defines parse_set once again (CR45).
- The repo check test "the Go model build regenerates models" asserts the orm-gen sets call that make go-models runs since the Go model sets were ordered (CR44).
- The Python recipe tests format the case filter of the chain path as ruff format writes it (CR43).
- The TypeScript client no longer exports markdownParam, which only markdown.ts uses; knip reported it as an unused export (CR42).
- The interface snapshot of the landed recipe rows is recorded again: the Go, PHP extension, PHP, Rust and TypeScript symbol snapshots and the manifest hashes follow the tree (CR41).
- The plan and spec words that the docs rules of kit 0.0.92 refuse are reworded in the Task and Deliverables cells of the check-recipes, execution and kit-standard rows and in docs/spec/schema.ko.md, with the same meaning in both languages (CR40).
- The uuid, date, time and datetime bind cases of `tests/bind/vectors.json` (precisions 0 to 6) are cases of the message recipe `tests/bind/messages.json` in all six runtimes (T334-3-15-4h). The precision 1 and 2 columns get typed filters in every helper, and a bool wrapper of a datetime column is refused by the public path (CODEC_ENCODE, PRT-67).
- The contains cases of `tests/bind/vectors.json` (`like_contains`, five cases) are cases of the message recipe `tests/bind/messages.json` in all six runtimes (T334-3-15-4g). The message of a contains step is the request value (PRT-66, PRT-67): the escaping and wrapping is the SQL-side transform (PRT-32), so the expected message is the value. The Go and Rust contains cases exclude the null case, since the typed method takes no null. The bind message test moved to `packages/go/bindmessages`, so the markdown set does not import the bind set output.
- Go model generation orders the sets of `packages/go/models.txt` by their scans: a set whose scanned packages import another set's output is generated after it, and a cycle between sets is refused, naming both (`orm-gen sets`, T334-3-15-4g-1). The order of the lines no longer matters; before, the `bindmodel` set failed when it was listed after `markdownmodel`. Fix.
- The varchar, text and bytes bind cases of `tests/bind/vectors.json` without the `like_contains` transform (17 cases) are cases of the message recipe `tests/bind/messages.json`. A nil compared with `eq` is `IS NULL` and binds no parameter (DSL-48), so the statement's message is the empty list `[]`, which the schema and FCV now state. A nil into a not-null column is `CONFIG` in PHP and Python (DSL-49), and Go, Rust and TypeScript exclude it as refused at compile time. A text into a bytes column is its base64 form in the message (PRT-67) (T334-3-15-4f).
- The markdown message and control vectors of `tests/bind/vectors.json` are one recipe, `tests/bind/messages.json`, of `markdown.send` steps (`column`, `operator`, `params`, `begin`, `process_zone`, `expect`). Each of the six recipe helpers runs it through its public markdown connection with a listener that records the first message; the native message tests and their parity bindings are removed, and the offset-less datetime case in the DST gap runs under its `process_zone` (T334-3-15-3c).
- A recipe case may name, in `exclude`, the runtimes that do not run it, each with a reason. An excluded runtime prints one `EXCLUDED <case id> <runtime>: <reason>` line and drops the case from its list, so it counts as neither pass nor skip; a case that excludes every runtime is refused by the schema. The no-database expectation of the recipe schema exempts `markdown.send` steps, and `tests/bind/messages.json` is a validated suite file (T334-3-15-4a).
- The integer bind cases of `tests/bind/vectors.json` (i16, i32 and i64 slots) are cases of the message recipe `tests/bind/messages.json`: each is a `markdown.send` step on its slot column with one parameter wrapper and its expect, the bound value or the error code. The six runtimes run them through their public filters; a value the typed API refuses is excluded for go and rust with the reason that the typed public API refuses this host value at compile time (T334-3-15-4b).
- The floating and boolean bind cases of `tests/bind/vectors.json` (f64 and bool slots) are cases of the message recipe `tests/bind/messages.json`. A non-finite f64 is refused by the public call with CODEC_ENCODE. A text or bool value for an f64 slot is refused by the untyped public path and excluded for go and rust with the typed-API reason. The Rust message compare is exact for integers, so an i64 off by one fails (T334-3-15-4c).
- The lint findings in the files of the message recipe rows are fixed in place (Go errorlint and Close, Rust Option::map, and the PHP, Python and recipe-helper formatting). The findings that remain for the PHP, Python and TypeScript gates and for the Rust kit link are in files this branch does not change; CR34 fixes them (T334-3-15-4d).
- The decimal bind cases of `tests/bind/vectors.json` (the decimal slot) are cases of the message recipe `tests/bind/messages.json`: a `markdown.send` step on `decimal_value` with a decimal wrapper and its expect. Fix: the TypeScript and Python recipe helpers passed a float wrapper of a decimal column as its text, which hid the float from the public filter; they now pass the host value, so the public decimal filter refuses a float with CODEC_ENCODE as it does in PHP. No product code changed; the existing check already refuses it (T334-3-15-4e).
- Generated models declare the condition method of every column (DSL-154). The Go, TypeScript and Rust generators declared it only for the columns of a key or an index, so `text_value`, `bytes_value` and `varchar_long_value` had no condition method; each now declares one for every column, as the PHP and Python generators already do (T334-3-15-4f-1). Fix.
- The recipe op `model.assign` (FCV-4) sets a column of a new row through the public setter and builds its insert without a database. The Python public write path refuses NULL assigned to a not-null column at the codec, before the engine validator, as the other runtimes do (T334-3-15-4k, T334-3-15-4j).
- A database feature becomes a recipe in its own commit: request_hook runs its 11 cases on MySQL, PostgreSQL and SQLite in the six clients through make request-hook-check/<client>, bound in config/parity.json. The hand-written tests of the converted cases are removed; the four sub-assertions a step cannot observe stay native, and the unused fail action has its own case (T334-3-4).
- The parameter chunking runs as a recipe in six clients: `contracts/fixtures/parameter_chunking/parameter_chunking.json`, an IN list of 70300 values written with `sequence` values (FCV-4), runs on MySQL, PostgreSQL and SQLite through `make parameter-chunking-check/<client>`, bound as the suite units `parameter_chunking-mysql`, `-postgres` and `-sqlite`; a `limit` on a split list fails with `IR_INVALID` (PRT-76), and the native probe of the PHP extension stays as PRT-80 (FCV-2) (#T334-3-4).
- The Rust AES key status and rotation of a recipe model read the entity of the model core, not the static entity of a model type, so a recipe row no longer panics with unreachable code (T334-3-4-4).
- Rust reads a stored AES version written as text of digits as its number, as COD-53 requires and as the Go read path does; MySQL delivers that text as bytes, which the version read refused with CODEC_DECODE (T334-3-4-5).
- The Go query.search of the fulltext recipe loaded the case schema without its external documents and passed the model name Author as the entity, so the four Go cases failed. engine.Load takes the external text and loads it with runtimemodel.LoadSet, and the recipe passes the external documents of the schema and the entity author (T334-3-17-2-1).
- The php-extension bootstrap did not load the fulltext recipe test that its extension test extends, so every php-extension fulltext recipe case exited 255. The bootstrap now requires packages/php/tests/FulltextSearchRecipeTest.php (T334-3-17-2-2).
- The transactions recipe, contracts/fixtures/transactions/transactions.json, runs the model writes and reads, the callback commit and rollback, the savepoint, the row lock and the nested option errors on mysql, postgres and sqlite in all six runtimes, through the model ops and the transaction op of FCV-4, with the parity units transactions-mysql, transactions-postgres and transactions-sqlite (T334-3-4).
- The Go described read refuses the MySQL zero date 0000-00-00 as INT-103 states, as its grid read does: a DATE or DATETIME zero date fails with GRID_TEMPORAL_VALUE instead of reading as 0001-01-01 (T334-3-3-6-1)
- The PHP and PHP extension described reads check their temporal text as INT-103 states: a text that is not in the dbspec form fails with GRID_TEMPORAL_VALUE, and an SQLite text must have the fraction digits that its dbspec CHECK fixes; Go, TypeScript, Python and Rust cut the described page before the sentinel row is converted (T334-3-3-7)
- The Rust described read of a SQLite DATETIME column with no CHECK takes precision 0 as INT-103 states, so a non-zero fraction fails GRID_TEMPORAL_PRECISION instead of being read (T334-3-3-7-3)
- The Go, TypeScript and Python described read of a SQLite DATETIME column with no CHECK takes precision 0 as INT-103 states, so a whole-second text reads as its dbspec text and a non-zero fraction fails with GRID_TEMPORAL_PRECISION (T334-3-3-7-2)
- The PHP described read of a page cuts the sentinel row (the row past the limit of the LIMIT limit+1 read) before it converts the rows, so a page of one row no longer fails GRID_TEMPORAL_VALUE on the next row, which is never read: the catalog_connection recipe case described_temporal_text reads its SQLite pages in every runtime (T334-3-3-7-1).
- A MySQL zero date 0000-00-00 that a grid query reads fails with GRID_TEMPORAL_VALUE in every runtime, as INT-103 states for a date outside 0001-01-01 to 9999-12-31: Go returned 0001-01-01, Rust returned NULL (sqlx-mysql treats a zero date as NULL), and Python returned its text (T334-3-3-4).
- The catalog_connection recipe states the cell of a MySQL YEAR grid value as INT-103 does: YEAR is an integer-valued type with no temporal meaning that orm declares, so every runtime refuses its grid read with CATALOG_VALUE, and the spec sentence names it (T334-3-3-3).
- - The catalog_connection recipe's native checks are stated for the six runtimes: the TypeScript and Rust integer and duplicate-key errors keep their codes (INT-123, CFG-33), the Rust grid of a temporal column without a CHECK keeps only the declared precision (DIA-24), and the coverage expectations name the recipe entry methods and bind SCH-3 (T334-3-3-2).
- The catalog_connection recipe holds the other assertions of the old runtime tests as cases, the old coverage tests of the six runtimes are removed, and the python recipe removes its bench model directory at exit (T334-3-3-2).
- The PHP extension stub declares the values parameter of Catalog::insertRow and updateRow as `array` with its description, because the stub generator refuses a generic type with a space (gen_stub) and the php-extension lane failed to build on it; the PHP 8.4 build passes again (T334-3-3-2-10).
- checkPrecision is public in all six runtimes (INT-117): the Go CatalogColumn field and the Rust TableColumnMetadata field that the SQLite CHECK precision fills are exported under their public names, and config/parity.json declares them with every other public symbol the catalog connection exports (T334-3-3-2-9).
- PostgreSQL describe reports no default for a generated column: the generation expression of a generated column is kept in pg_attrdef where a default is, so every runtime reads no default expression and a false default flag for it, as SCH-6a states (T334-3-3-2-8).
- The lint and duplication findings of the catalog_connection runners are fixed in place: the Go errcheck of Close, the TypeScript unused variables and duplicated helper, the Python ruff findings, the PHP phpcs findings and empty catches (a catch handles or rethrows its error), the Rust unreachable grid arm and the dead helpers of the shared probe, and the duplicated PHP fetchAll (T334-3-3-2-7).
- The Rust runner of the shared catalog_connection recipe runs every op and field of the recipe on MySQL, PostgreSQL and SQLite. A PostgreSQL statement with 200 or more UNION ALL operands or + terms refuses with CATALOG_LIMIT (INT-136), and a negative row or byte count refuses with QUERY_LIMIT_INVALID before the query runs. A PostgreSQL real reads as its float32 value, and a MySQL YEAR() grid value refuses with CATALOG_VALUE (T334-3-3-2-6).
- The Python runner of the shared catalog_connection recipe runs every op and field of the recipe on MySQL, PostgreSQL and SQLite. A budgeted read streams its rows: a MySQL result is unbuffered and a budget stop kills the running statement by its thread id, and a PostgreSQL read with no parameter is a cursor that the stop closes, so a stop no longer waits for the whole statement (the catalog_read_budgets case stopped at its 2-minute deadline before). A PostgreSQL real is read as its float32 value, a MySQL YEAR() grid value and a PostgreSQL infinity refuse as their codes, and a write whose temporal value has more fraction digits than its column refuses with CODEC_ENCODE before the statement runs (T334-3-3-2-5).
- The PHP extension runner of the shared catalog_connection recipe runs every op and field of the recipe on MySQL, PostgreSQL and SQLite. A catalog read streams a MySQL result unbuffered and a budget stop kills the query by its thread id through a connection of its own; a PostgreSQL read without parameters goes through a cursor. A repeated column in a write is refused with ROW_UPDATE_INVALID or ROW_INSERT_INVALID before any write (INT-111). A write that names more fraction digits than its temporal column refuses with CODEC_ENCODE, and a SQLite CHECK fixes the precision of its TIME or DATETIME column (T334-3-3-2-4).
- The TypeScript catalog_connection tests asserted the connect, describe, close, reconnect, revision, snapshot, bind and grid cell values that the shared recipe did not express: the recipe now holds them as cases, with the ops catalog.connect, catalog.close, catalog.reconnect and catalog.revision, the describe fields of native types, nullability, generated columns, automatic keys and defaults, the row_snapshot fields keys and key_indexes, the page_with input, assignments as lists of pairs, the read_only_query binds, and the float, unsigned and binary cell wrappers. The TypeScript runner runs them on MySQL, PostgreSQL and SQLite, and the native assertions they own are removed (T334-3-3-2-1).
- The TypeScript catalog_connection tests still asserted the stream budgets over the 5000-row cross join, the byte budgets, the float4 bits, the temporal precision and SQLite temporal rules, the grid rejects, the unsupported DSN, the MySQL SYSTEM VIEW, the captured cells and the null and empty text read natively. The recipe now holds these as cases, through the ops catalog.row_cells and model.read_bind_cell and the fields only, row_count, columns, kind and columns_present, and a write beyond the declared precision fails with CODEC_ENCODE before any statement, a read scope that refuses a routine that writes fails with QUERY_READ_ONLY, and the TypeScript catalog maps the driver read-only refusal to that code (T334-3-3-2-1).
- The PHP runner of the shared catalog_connection recipe runs every op and field of the recipe on MySQL, PostgreSQL and SQLite. A catalog updateRow or insertRow takes its values as a list of [name, value] pairs as well as a map, so a repeated column reaches the catalog and is refused with ROW_UPDATE_INVALID or ROW_INSERT_INVALID before any write, as INT-111 states; a MySQL read budget stops by killing the server query by its connection id, and a PostgreSQL read streams through a cursor, so a budget stop does not read the rest of the result (T334-3-3-2-3).
- The Go runner of the shared catalog_connection recipe runs every op and field of the recipe on MySQL, PostgreSQL and SQLite. Its row snapshot exports the keys, key indexes and captured cells that the spec now states; a read-only budget stops the query instead of reading the rest of a result; a driver read-only refusal is QUERY_READ_ONLY; a time outside its day is GRID_TEMPORAL_VALUE; a MySQL YEAR has no grid cell; and a time beyond its declared precision fails with CODEC_ENCODE before any statement (T334-3-3-2-2).
- The API surface of the catalog recipe rows was not declared: the Go accessors Keys, KeyIndexes and CapturedCells of CatalogRowSnapshot, and the PHP property CatalogColumn::$checkPrecision. The catalog API unit now declares them under INT-108 and INT-117 (CR30).
- The Rust catalog keeps the codes of the tool's statement and column errors at the head of its error text, as INT-124 and INT-125 state: TOOL_QUERY_STATEMENT and TOOL_QUERY_COLUMNS no longer follow the driver prefix error occurred while decoding (T334-3-3-5)
- The schema_definition vectors moved into the recipe tests/dbspec/schema-definition.json with one copy of each datum; six ops of FCV-4 (dbspec.parse_emit, dbspec.manifest, dbspec.render, dbspec.analyze, dbspec.parse_positions, dbspec.format) run them in every runtime, and the native vector tests were removed. The manifest case moved in this row, not in T334-3-18-3, because splitting one vector file across two rows would leave two copies (T334-3-18-1)
- The parse vectors of the dbspec suites that read no database (canonical, normalize, invalid, positions, set-parse and the byte-order-mark) are cases of the recipes in tests/dbspec, run by every runtime through the FCV-4 ops format, parse_positions, analyze and parse_set; the native vector tests they replaced are removed, and each datum of cases.json and syntax.json has one copy (T334-3-18-2).
- The header comments of the 18 recipe test files of dbspec-canonical, dbspec-normalize and dbspec-invalid name the requirements their units cite (DBS-133, ORES-1, ORES-3, ORES-13, DBS-136 to DBS-139, ORES-4 to ORES-11 and ORES-13), so the R15 check of parity --phase api passes for those units (T334-3-18-5).
- The manifest, hash and set units that read no database (dbspec-hashes, dbspec-sets, dbspec-repeated-document-name) are the recipe cases of tests/dbspec/hashes.json and tests/dbspec/sets.json, and six runtimes run them through the FCV-4 ops dbspec.set and the manifest and hash ops. The native manifest, hash and set vector tests they replaced are removed, and each datum of the vector files that several consumers read has one copy. The refusal of a repeated document name is possible only in TypeScript, which resolves a set from the file tree, so it stays a TypeScript native test (FCV-2) (T334-3-18-3)
- Fix the TypeScript compare runner so that join takes the mixed form of the recipe documents, and the packages/ts type check passes (T334-3-18-3-3).
- Make the title of the repeated-document-name refusal vector a literal, so that the parity binding finds it in the TypeScript vectors file (T334-3-18-3-2)
- The six native tests of the physical plan cases did not report one result per case, and the physical records of tests/dbspec/plans-physical.json belonged to no suite unit, so the parity check did not declare them. The unit is now a suite on its cases, and each runtime reports every case (T334-3-17-5).
- The model_writes feature declares the repeated member name of the ordered-json text on every owner (Go, PHP, php-extension, Rust, TypeScript and Python) and on MySQL, PostgreSQL and SQLite, so the generic Rust run skips it by its declared symbol instead of failing without ORM_FEATURE_DATABASE (T343-2)
- The model_writes feature declares the repeated member name of the ordered-json text on the Go owner (MySQL, PostgreSQL and SQLite): the Go case stores `{"a":1,"b":2,"a":3}` through the Author json setting and reads it back, so the owner runs the case that the other owners run (T343-2-1)
- The generated Go model keeps a repeated member name of a jsontext value: the ordered-json value is taken as its source text before the json.Marshaler branch, which re-serialised the parsed member map, so `{"a":1,"b":2,"a":3}` no longer comes back as `{"a":3,"b":2}` on SQLite (DIA-26) (T343-2-1-1)
- The pooler lane of the Rust tests runs no more test threads than the server connections that ProxySQL keeps for its backend: the count is one declaration (PROXYSQL_BACKEND_CONNECTIONS), and the lane passes `--test-threads` of backends divided by the pool size, so a pinned pool no longer waits past the 10000 ms connect timeout (T343-1)
- A jsontext value keeps the member order and the repeated member names of its source text: a write stores the compacted source text instead of re-serialising the parsed member map, and a read returns the text it holds (DIA-26). Go, TypeScript and Python collapsed a repeated name before this on SQLite, MySQL and PostgreSQL (T332)
- The transaction-retry-on-deadlock parity unit now runs a driver-level deadlock in the Go, Rust, TypeScript and Python bindings: two connections lock two rows in opposite order on MySQL, one flow's first attempt fails with DEADLOCK, the transaction retries, and both commit, so the retry of a driver deadlock is tested in four runtimes, not only PHP (T303).
- The Python parity bindings of the complex query and the hot-path performance gates no longer name an unloadable test: on 6ff320c72 the run of their units passes under PHP 8.4 (25 bindings, 27 cases), so the Cause of T269 does not reproduce and the row now runs those units as its Verification (T269).
- `make interface-record` records the interface symbol snapshots and manifest hashes with the checker and lease environment of `make interface-check`; `LANGUAGE=<name>` records one language, so the Rust DbInner snapshot changed by the transaction statement gate is regenerated through make and no longer outside it (#T343-4-1)
- The overlapping-statements test of a transaction holds its first statement inside the transaction connection with `testing::hold_next_statement`, and attempts the second only after the first has reached the hold, so the second statement is refused with CONFIG on every schedule, instead of depending on whether the two futures happened to overlap (#T343-4)
- orm no longer copies the capability table of flowmark: the table "Markdown IR executor" of dialects.md is replaced by a link to the pinned flowmark spec 60, and the markdown-table check that read a flowmark source checkout is removed (T347).
- The check-recipes work of two branches lands on main as one integration: the Korean checklists hold every row of the English ones, the change logs hold the entries of those commits, the Makefile starts node through `$(NODE)` in `rust-compiler-fixtures-check/unit`, and `config/rebuild.json` classifies `scripts/generate/once.mts` and `scripts/php/php-ext-build.mts` (CR26).
- The check runner printed no `::error` line for a failed target, so on GitHub Actions a failure was visible only when the job ended. A failed target now prints its `::error` line when it ends (CR1).
- The docs build rendered the site into the published folder in place, so an interrupted build left half of the site behind. It now renders into a staging folder and publishes it by one rename (CR2).
- The recipe schema accepted a database op (`sql.exec`, `model.connect`) in a recipe without a fixture, so such a behaviour could run without the three databases. It now refuses that op (CR13).
- Every target that needed the lease tool rebuilt it, so a job with several targets ran the build of the same program again and again. The lease program is now a file target of its sources, built once and then found up to date (CR11). The docs build test (CR2) also declared its case with node:test directly, which the repo rule forbids; it now uses caseTest.
- Some CI targets ran in two jobs in one run: the static group, the docs job and the editor job each ran docs-verify-idempotent, docs-site-check, dbspec-vscode-check, and docs-check ran in both the kit job and the docs job. Each target now runs in one job, and a case of the repo check fails when two CI jobs run the same target (CR9).
- CI jobs installed the npm, composer, uv, Go and mise.toml packages again on every run, although their lock files did not change. Each job now restores the npm, Go module, composer, uv and tool caches keyed by the hash of their lock files, before the install (CR8).
- The Go, PHP and Python models and the orm-codes files were regenerated by every target that needed them, although their inputs did not change (1451 generator calls in one CI run). Each generator now runs only when the key of its tracked inputs changes, and its stamp is written atomically beside its output (CR6).
- Every kit parity job created the 18 complex-query fixture databases, although none of its targets reads them: about 60 s per job of the databases step. A context now creates them only when one of its targets needs them, by its check inputs or its recipe (CR7).
- The arginfo header was copied in place, so a copy that was stopped left the previous header partial, and the PHP extension build read it. The header is now written to a temporary file and renamed over the previous one, so an interrupted write leaves the previous header whole (CR3).
- Recipes that hold the lease (WITH_TEST_ENV, check-run and run-databases) called make recursively, which GNU make runs even under make -n, so a dry run of check-run ran the whole check. They now build the lease program through a shell step, only when it is missing or older than a source of tests/lease (CR11).
- The docs build test gave its build the environment of the test process and used a non-null assertion, which repo-check and lint-ts refuse. It now runs the build with isolatedEnvironment and checks the process group id instead of asserting it (CR11).
- The workflow cache check had an empty loop and read the step values with String(), which lint-ts refuses. It reads only the values that are strings (CR8).
- The complex-query context check cast the parsed check inputs to a type, which lint-ts refuses. It reads them through type guards (CR7).
- The recipe test cast its JSON values to types, which lint-ts refuses. It narrows them with checks of shape (CR13).
- publish-output checked the output file of a command's standard output as soon as the command exited, before the copy had created it, so a fast command failed with "wrote no": under parallel load 2 of 640 runs failed, in the phpstan owner of the CR3 owner check. The check now waits for the copy to finish (CR22).
- The owner check ran python-check for a touched Python test, whose recipe runs an unselected discovery that kit refuses outside CI, and ran the php-extension coverage outside make, where POLYSPEC_ORM_EXTENSION was unset. A touched test now selects its own command: python-check owns the Python sources, not the tests; the interface tests name their modules; the php-extension coverage builds the extension through make first (CR24).
- The statement event vector named MySQL and PostgreSQL for the server-transaction check and gave SQLite neither an entry nor a reason. It now states SQLite as excluded with its reason, and every runtime's test checks that each database is named once (CR16-2).
- The interfaces spec states the public statement runner (INT-150) in every runtime: `utils().run(fn)` and the frame call `run(kind, tables, sql, params)`, with the frame-call ruling of CR21. The runtimes implement it in the CR21 rows that follow (CR21).
- The interfaces CI test refused docs-site-check and docs-verify-idempotent, which CR9 moved to the docs job, because it counted only the CI groups and the kit-run targets. It now also counts the targets of make docs-ci and make ci-vscode-integration, read from the Makefile, and refuses a target that runs in neither (CR9-1).
- The PHP 8.5 owners failed on two causes: the no-op setAccessible of a model test, which PHP 8.5 reports as deprecated, and a large-object write that pg_lo_write refused for its NUL bytes. The test drops setAccessible, and the stream and the native extension write large objects through lo_put in chunks, on every PHP composer.json allows (CR23).
- CR21 and its sub-rows (CR21-1) (CR21-2) (CR21-3) (CR21-4) (CR21-5) (CR21-6) (CR21-7) moved to T345 on main, which landed the public statement runner for the consumer (#CR21).
- The TypeScript and Python runners of the shared DDL vectors now run their behavior steps on MySQL, PostgreSQL and SQLite, and fail naming any unset server DSN, where they only compared rendered statements before (CR16-1-1).
- The compiler fixtures of the Rust runner failed with EEXIST after an interrupted run left a stale source in packages/rust/tests/examples, and kept the empty directory in the tree. The script now overwrites a stale source and removes its scratch directory at the end (CR25).
- Every PHP extension site of a run no longer compiles the extension again: `php-ext-build` builds each source and mode once into `var/php-ext/build/<key>/`, keyed by the sources, the arginfo header, the PHP version, the mode, the compiler settings and the kit builder, under a holder lock, and copies that build into each site (CR4).
- The TypeScript client is built once per source: `scripts/typescript/build.mts` publishes `packages/ts/dist` keyed by the hash of the tracked client sources, the build and model scripts, the fixtures and the tool versions, under a holder lock, and a run whose key is recorded starts no compiler, so `TSC_BUILD` and `typescript-build` share one build (CR5).
- The compiler fixtures test runs as a caseTest, and `rust-compiler-fixtures-check` runs its native suite and the test of its runner as two parts that make -j runs together, so no recipe runs two independent tests (CR25-1).
- A Makefile build output that the PHP client generator writes in place is refused by the repository check: `php-models` now generates each models directory into `<dir>.tmp` and replaces the directory by a rename, so a stopped run leaves the previous directory whole (CR12).
- The owner test that a change across the four clients selects no full-suite target expects typescript-build-unit-check, which CR5 declared and the TypeScript client build (packages/ts/**) selects (#CR5-1).
- The one-build check of the PHP extension (CR4) is a build-system test, not a behaviour under a spec requirement, so it moved from packages/php-ext/tests to scripts/php/php-ext-build-cache.test.mts, the harness root of scripts, where parity-declarations-check needs no requirement for it (#CR4-1).
- The request validation cases of `tests/ir/validate.json` are a recipe (`ir.validate` op, FCV-4) that all six runtimes run without a database: the Go, TypeScript, PHP, PHP extension, Python and Rust native vector tests are removed, and the parity unit ir-validate binds its six recipe entries (#T334-3-15-1).
- The read answer cases of `contracts/fixtures/ir_answers.json` move to `tests/ir/answers.json`, a recipe of the `ir.answer` op (FCV-4) that all six runtimes run without a database: each case runs its markdown chain on a listener that answers with the case answer. The native answer tests they replace are removed, the parity unit ir-answers binds its six recipe entries, and the Rust chain runner is a library module shared with the recipe helper (#T334-3-15-2).
- The slot fixture of the bind vectors, `tests/bind/slots.dbs` with its set `tests/bind/dbspec-set.json`, has one table with a column for each parameter slot of `tests/bind/vectors.json`. Its models are generated by the make targets that write test models (Go and PHP through their model lists, TypeScript through its build, Python through `bind-python-models`, Rust through the tests crate build script), and `make bind-models-check` checks them (T334-3-15-3a).
- The recipe schema has the non-finite binary64 wrapper `{"f64": "NaN" | "Infinity" | "-Infinity"}`, which each of the six recipe helpers converts to the host value of that number; a finite number keeps its `float` wrapper (T334-3-15-3b).
- The Rust runner of the shared DDL vectors runs their behavior steps on MySQL, PostgreSQL and SQLite, and fails naming any unset server DSN, where it only rendered the statements before (CR16-1-2).
- The TypeScript, Python and Rust physical DDL behavior tests had no binding in config/parity.json, so parity-declarations-check reported each as the test of no binding. They are declared as the feature unit dbspec-render-physical, which cites DIA-113, and each test names that requirement (CR16-1-5).
- The duplication check found three clones of shared test code. The PHP fetchAll of PgsqlStatementAdapter and CatalogAnswerStatement is now the trait FetchesAllRows, the parse_set of the Rust dbspec tests is in the probe module tests/common/dbspec_probe.rs, and the TypeScript within helper is in tests/deadline.mjs, which both use (CR27).
- The PHP render test checked the statements of tests/dbspec/ddl.json but not their behaviour steps. It now runs the steps on MySQL, PostgreSQL and SQLite, and fails naming the server DSN that is unset (CR16-1-3).
- The PHP extension render test checked the statements of tests/dbspec/ddl.json but not their behaviour steps. Its make target now runs the steps on MySQL, PostgreSQL and SQLite with the extension, and fails naming the server DSN that is unset (CR16-1-4).
- The Go runner of the DDL behaviour ran the steps of tests/dbspec/ddl.json on the three databases only in its internal package, so the client package had no test of them. A client test now runs the statements and steps through the client database driver, its make target dbspec-go-check/render-physical fails naming an unset server DSN, and parity binds it as the Go test of dbspec-render-physical (CR16-1-6).
- The interface snapshot of the integrated check-recipes tree was stale, so the interface self-test failed on the go, php and typescript symbols. contracts/interfaces.json and the symbol snapshots of php and typescript are regenerated from the integrated tree (CR28).
- The Go client test of the DDL behaviour and the external oracle of the same vectors each decoded tests/dbspec/ddl.json with their own copy of the decode and the version check, a clone of the duplication check. Both now read it through the shared loader internal/dbspec/ddlcases (CR29).
- The integration carried catalog recipe ops that only the TypeScript and PHP helpers implement, so catalog-connection-check failed in Go, Python, Rust and the PHP extension. Those catalog rows and their parity declaration are reverted, to land with the other runtimes, and the TypeScript deadline helper they alone used is removed. (CR33)
- The compiler fixtures test of CR25 failed repo-check: it declared its cases with node:test directly, and ran beside the cargo test in one recipe. It now uses caseTest and runs as its own part of rust-compiler-fixtures-check (CR25-1).
- The change log of the integration had 18 entries of the integration under its 0.0.21 section, so the section had 53 list items against 35 in the Korean twin, and docs.translation-shape failed. The 0.0.21 section is restored to its text at commit 874946330, and the CR25 entry that no Unreleased section held moves to Unreleased (CR36).
- The interface snapshot of the integrated tree was stale: the go and typescript symbol hashes recorded in contracts/interfaces.json differed from the tree, and the php snapshot listed four private Catalog methods that packages/php/src/Catalog.php no longer declares, so make interface-check/self-test failed. The documented record run regenerates the snapshots and the manifest hashes (CR35).
- The kit parity jobs ran parity-bench-env-check without the complex-query databases: since CR7 the parity context named no target (PARITY_CONTEXT_TARGETS was empty), and complexQueryNeeded did not read the need complex-query that parity-check declares. The context now names the parity gates, and a context whose target declares the need gets the complex-query fixtures (CR37).
- The runtime lint gates of Go, PHP, TypeScript and Python failed on the integrated tree: a Go errorlint finding and an unused Go alias, 13 PHP lines over 120 characters, an unsafe any and a template literal in two TypeScript scripts, and five Python tests that ruff check and ruff format refused. Each is fixed at its source, and no noqa is added (CR34).
- Every parity job built the PHP extension and the Rust conformance program, so the python, go, typescript, php and API jobs fetched PHP-Parser and compiled both for bindings that load neither. A parity gate now builds only what its bindings load: the extension for php-extension, the program for rust, and both for the full parity-check. (CR39)
- A Task row of the check recipes used a word that the docs rule forbids in English, so docs-rules-check failed in test (static). The Task of CR39 now says parity check in both languages (CR50).
- The Rust test helper of the answer chain was not formatted, so rust-fmt-check failed for the clients, bench and interfaces programs in test (static). The file is now formatted with the pinned toolchain (CR51).
- The GroupRows PHP extension test faked the build of the older php-ext-build form, so its module was not found and makefile-pinned-node-recipes-check failed in test (static). The fake now follows the form that the build-once refactor (CR4) gave php-ext-build (CR52).
- The shared-module test of the dbspec PHP extension aggregate asserted a child that T334-3-15-1 had removed, so makefile-pinned-node-recipes-check failed in test (static). The test now follows the move of request validation to ir-validate-check (CR53).
- Six test files of the physical DDL behaviour and the IR validate recipe belonged to no feature, so the features check failed in six CI jobs. The physical DDL tests now belong to schema_definition and the IR validate tests to planner (CR54).
- The preempted test of DbspecRenderTest failed in test (feature_verify_other) of main CI run 41324077414 with nine DSN errors, because it ran the whole file without the database DSNs. testBehaviourPhysical (CR16-1-3) now carries the group database, which the preempted run excludes; the physical cases still run in dbspec-php-check/render (CR55).
- The drop step refuses a binary log purge that the replica did not apply, and names the replica SQL thread state and its last error; the start of the test servers no longer reuses a MySQL replica whose SQL thread stopped, and reports it with its last error (G5.55-2).
- A primary and its replica connections run as a recipe case in the six runtimes, with the DSN `case-replica` and the ops `replica.await` and `row.connect`.
- A write through a replica and to a read-only SQLite file run as recipe cases in the six runtimes, with the op `database.read_only`; the native replica tests are gone.
- LISTEN and NOTIFY run as recipe cases in the six runtimes, with the DSN `case-server` and the ops `db.listen`, `subscription.receive`, `subscription.unlisten`, `subscription.close` and `session.end_listener`; the native tests are gone.
- A process that ends inside a SQLite write transaction leaves no lock holder (CFG-43), tested in Go.

## 0.0.21

- client-statement-runner declares each Rust symbol of the statement runner at both public paths, the crate-root re-export and the module of its definition: `polyspec_orm::Utils::run` and `polyspec_orm::utils::Utils::run`, `polyspec_orm::TxFrame::run` and `polyspec_orm::tx::TxFrame::run` (T346-11).
- client-statement-runner declares the Rust symbols of the statement runner at their definition paths, `polyspec_orm::utils::Utils::run`, `polyspec_orm::tx::TxFrame` and `polyspec_orm::tx::TxFrame::run`, beside the crate-root `polyspec_orm::TxFrame`, as Transaction is declared (T346-10).
- The composer lock of packages/php-ext is current with its composer.json (T346-9).
- The pypi:vulture uv lock of the mise tools is current with the pinned uv 0.13.0, and the digest of mise.lock names it (T346-8).
- The feature check declares its TypeScript lease tool, scripts/features/typescript-lease.mts, as a policy in config/rebuild.json, so make rebuild-check accepts it (T346-7-1).
- A verification command that reads the TypeScript build output holds the shared lease of READ_TYPESCRIPT, and a command that builds it holds the exclusive lease, so a reader never overlaps a build in make feature-verify-other (T346-7).
- orm takes ordered-json 0.0.20 (T346-6) in every ecosystem: the npm, Composer, Go, Python and Rust pins name its release assets and tag, and packaging.md names its 0.0.20 assets.
- The Korean Task of T346-5 no longer names an expression that the writing-style rule forbids (T346-5-1).
- orm requires the maintained fork `min-0-max/json-schema` at its branch `dev-polyspec-origin-2.6.0` in require-dev, in place of the upstream package opis/json-schema (S14) (T346-5).
- orm takes kit 0.0.88 (T346-1): the pin names the release asset of kit 0.0.88 with its integrity, and the kit-sync copies are that release's, with the link, pipeline and manifest-path rules S11, S12 and P30 (K997, K998).
- orm bootstraps kit only through the shared action `.github/actions/kit-bootstrap` in every CI job (T346-2): the inline steps that ran `make install-tools TOOLS=npm` are removed from ci.yml and docs-pages.yml.
- Every job of .github/workflows/ci.yml other than kit follows the job kit with `needs: kit` (S12) (T346-3).
- AGENTS.md names the kit bootstrap at its installed package path, `node_modules/@polyspec/kit/scripts/kit/kit-bootstrap.mk`, and states the layout check as enforced by `make layout-check` (T346-4).
- Every job of .github/workflows/ci.yml other than kit follows the job kit with `needs: kit` (S12) (T346-3).
- orm bootstraps kit only through the shared action `.github/actions/kit-bootstrap` in every CI job (T346-2): the inline steps that ran `make install-tools TOOLS=npm` are removed from ci.yml and docs-pages.yml.
- orm takes kit 0.0.88 (T346-1): the pin names the release asset of kit 0.0.88 with its integrity, and the kit-sync copies are that release's, with the link, pipeline and manifest-path rules S11, S12 and P30 (K997, K998).
- orm takes ordered-json 0.0.17 (T346) in every ecosystem: the npm, Composer, Go, Python and Rust pins name its release assets and tag, and packaging.md names its assets `polyspec-ordered-json-0.0.17.tgz` and the Composer zip and wheel of that release.
- orm takes kit 0.0.87 (T346). Every CI job of .github/workflows bootstraps kit through the shared local action `.github/actions/kit-bootstrap` that kit-sync provides (K992), in place of the inline copy of the bootstrap that each job carried: ci.yml had four and docs-pages.yml one. The action sets up the Node.js of mise.toml, installs the locked kit package, then the npm of var/tools and the packages of package-lock.json. ci-pipeline.yml and release.yml take the same action from kit-sync.
- The interfaces spec states the public statement runner in every runtime (INT-150): `utils().run(fn)` and the frame call `run(kind, tables, sql, params)` in TypeScript order, with a parity unit that binds it on every database (T345).
- The TypeScript runtime makes `utils().run(fn)` public in its declarations, and `TxFrame.run` returns the rows of its statement (T345-1).
- The Go runtime exports `Utils.Run` and the transaction frame whose `Run(kind, tables, sql, params)` returns the rows (T345-2).
- The Rust runtime makes `Utils::run` and the transaction frame's `run(kind, tables, sql, params)` public (T345-3).
- The PHP runtime passes the transaction frame to `Utils::run`, and `TxFrame::run(kind, tables, sql, params)` returns the rows (T345-4).
- The PHP extension makes `Utils::run` and `TxFrame::run` native public methods with the PHP runtime's meaning (T345-5).
- The Python runtime makes `utils().run(fn)` public, and a non-text statement of the frame fails with CONFIG (T345-6).
- The interface contract records the statement runner symbols of every runtime and the API unit count is 178 (T345-8).
- The TypeScript codec API breaks (T334-3-14b). Every integer of the codec value model is a bigint and every float is a number, as Python holds an integer as an int checked against the i64 range and Go, PHP and Rust hold it in their integer types: `codec.encode` takes an integer as a bigint (`2n`, not `2`), `codec.decode` returns every integer as a bigint, including an integer beyond 2^53 that failed before, and an integral float is written as `d:N;` in serialize, as in every other client, since the COD-3 exception for TypeScript is removed. The reason: TypeScript refused valid i64 data that the other runtimes write (`codec_integers_of_i64`, `CODEC_DECODE: serialize: bad or unsafe int`), and wrote an integral float as `i:4;` where the other runtimes write `d:4;` (`serialize_integral_float`), so a float round trip changed its type. A bigint only beyond 2^53 would fix the first and not the second. The old number path for integers is removed. Consumers: write an integer column value as `BigInt(n)`, compare decoded integers as bigints, and call `Number(...)` only where the value is known to be a safe integer.
  - Consumers: fsm, flowmark, hyper, template and crudui import none of `decode`, `encode`, `hostDecode`, `hostEncode`, `blindIndex`, `CodecValue`, `CodecError` or `EncodedValue` from @polyspec/orm, and none has a column with a codec style prefix (`serialize_`, `gz_`, `yaml_`, `base64_`), so none changes. limepie's hyper node generated models import `CodecValue` only in `setPayload(value: StyledValue<JsonValue | CodecValue>)`; widening `CodecValue` with `bigint` widens that setter input and breaks nothing, and its `payload` is a json column with no serialize, yaml, gz or base64 column, so none changes.
- `ordered_json` refuses a text that is not a sequence of Unicode scalar values, such as a lone surrogate, with CODEC_ENCODE (COD-64, RFC 8259, 8.1): TypeScript used to escape it with `JSON.stringify`, and Go used to return a non-code error. PHP, the PHP extension and Python already refused it, so they do not change.
- TypeScript refuses the same inputs as the other runtimes in these rules: a host stage binds a value by its kind and refuses a number, a bigint or a bool (COD-1); an ip zone and the IPv4-mapped form follow COD-38; a value stage outside the first position, or an unknown style, returns CODEC_UNSUPPORTED (COD-35); an empty stage list is CODEC_ENCODE for a write (COD-14). A consumer that writes a lone surrogate into a json column now gets CODEC_ENCODE; limepie's payload writes are the only json writers among the consumers.
- The codec rules COD-65 to COD-67 are now in docs/spec/codec.md: a float under `serialize` writes `d:4;` for `4.0` and the PHP float notation (COD-65); `yaml` writes `2.0` for a float with no fraction, double-quotes and escapes a character outside c-printable and a byte order mark, and refuses such a character on a read (COD-66); a `serialize` array key that is an i64 integer writes as an integer key (COD-67).
- The coverage owners of `authenticated_encryption` hold only the test files that run an AES case: the codec test files of T334-3-14 and T334-3-14b are bound by their parity units and stay in the feature tests, so the feature coverage run no longer refuses the owner with `invalid native test command` in any runtime (T334-3-14b-3).
- The feature `statement_runner` has its coverage block of kind database, as the other database features have: one owner per runtime with a command for SQLite, MySQL and PostgreSQL, bound in the parity unit `coverage-statement-runner-statement-runner`, so the feature coverage run checks the statement runner in every runtime and database, and the feature is `implemented`, which the divergence check accepts (T345-9).
- The coverage owners of `statement_runner` share their helpers instead of copying them: the Go owner reads the selected database through `featureDatabase`, and the PHP and PHP-extension owners call `coverStatementRunner` of `StatementRunnerCases`, so the duplication check of the shared gates passes (T345-10).
- The statement runner passes the runtime gates and the parity checks: its Python test is formatted, the PHP trait `StatementRunnerCases` has its own file loaded by the test bootstrap, the TypeScript bindings name each database case, the Go coverage binding runs through `feature-go-unit` and the Rust one binds the trial that runs, and the frame of INT-150 is public in every runtime with only its `run` and its result type, its state and constructor internal (T345-11).

## 0.0.20

- orm takes kit 0.0.86 (T344). Each package of config/release.json declares its product and runtime, as the release schema of kit 0.0.86 requires (P39): the asset label is `<vendor>-<product>-<runtime>-<version>`, and a release asset keeps the file name its packer gives, `polyspec-orm-X.Y.Z.tgz` for `@polyspec/orm` in place of `polyspec-orm-npm-X.Y.Z.tgz`. make kit-sync wrote P39 into PRINCIPLES.md and PRINCIPLES.ko.md. orm takes ordered-json 0.0.15 in every ecosystem, through its npm, Composer, Go, Python and Rust pins, and packaging.md names its assets `polyspec-ordered-json-0.0.15.tgz` and the Composer and wheel names of that release.
- orm-gen gen of the PHP client removed every generated file of its output directory and then wrote each file in place, so a PHP test that started while another make process of the same run ran make php-models failed with "Failed opening required packages/php/gen/bootstrap.php" (T341). The generator now leaves a file that already holds its content as it is, writes a changed file to a temporary file of the same directory and renames it over the old one, and removes a generated file that the model no longer makes only after the new files are in place.

## 0.0.19

- make docs-rules-check and make makefile-pinned-node-recipes-check failed in test (static) (T339-20). Two T339 rows used expressions that the writing style forbids, and the GroupRows PHP extension test still expected the build.sh call that T339-9 replaced with the one build path; the rows are reworded, and the test expects $(call php_ext_build,...) and reads the module and the mode of that call.
- make example-check failed with ModuleNotFoundError: No module named 'packages': T339-14 made the Python thin-slice example import its models as packages.python.tests.models.models, and the tests ran it as a script from examples (T339-19). The tests and the README now run it from the root of the checkout as the module packages.python.examples.thin_slice.main, as every Python test of orm runs.
- The Python conformance and model-generation tests failed with FileNotFoundError: three of them built the old models path packages/python/src/polyspec/orm/models from path components, which the search of T339-14 did not find (T339-18). They read packages/python/tests/models.
- test (feature_verify_rust) and test (feature_verify_other) failed: the feature check walked the implementation roots on disk and named the fixture models that make python-models generates into packages/python/tests/models, which Git ignores, a python test file of no feature (T339-17). The feature check now classifies kit's checked files of those roots, the set that kit's parity declaration check classifies.
- make parity-declarations-check found packages/python/tests/models/__init__.py undeclared, an R5 finding, because T339-14 added the package file of the moved fixture models without declaring it (T339-16). config/parity.json declares it as a support file of the Python implementation.
- make parity-api-check found 1254 public symbols of polyspec.orm.models that no API unit declares (T339-14). The fixture models that make python-models generates were written into the source package of the client, which the wheel excluded, while the extractor of kit 0.0.84 reads every .py file on disk under the entry (K977). The models now live in packages/python/tests/models, the tests' own package, and the setuptools and vulture excludes of them are gone.
- make lint-php failed on a comment that T339-9 added to the fixture of ArginfoBuildTest: the line was 125 characters, over the phpcs limit of 120 (T339-15). The comment is two lines.
- make runner-check failed because its parts case still expected client-unit-check/codec-aes, which T334-3-14 removed when the AES vectors moved into the codec recipe (T339-13). The case expects the parts the Makefile declares.
- make runner-check failed on two expectations that T339 broke (T339-12). The error code targets ran orm-gen with $(ONLINE) outside an install target: they now run offline after the install target orm-install-go-codes, which downloads the Go modules that go.sum pins. The arginfo header recipe carried $(ONLINE), which none of its tools reads, and lost it. The test of the parity jobs now expects Go in every job whose checks generate the error code files, and orm-codes-typescript among the prerequisites of orm-install-typescript-runtime.
- make ts-min-check failed with EBADDEVENGINES again: T339-8 started the outer npm by its path, but npm run typescript:build inside typescript:test found the npm 11 of the lowest Node release first on PATH (T339-11). The .bin folder of the npm of mise.toml now comes before the lowest Node on PATH.
- make parity-api-check found the python error codes missing, 99 findings, because the python symbol extractor of kit 0.0.83 read only the files git lists and codes.py is untracked build output (T339-10). The pinned kit release is 0.0.84, whose extractor reads the .py files on disk (K977).
- kit / runtime (php-ext) failed because packages/php-ext/scripts/build.sh refuses a missing or stale arginfo header or copy of the SQLite cancel callback, while 68 recipes, scripts/client-db-test.mts and the fixture of ArginfoBuildTest ran it without them (T339-9). Every build of the PHP extension now runs make php-ext-build, which writes those sources first (php-ext-sources, formerly php-ext-release-sources); a recipe builds with $(call php_ext_build,<output>,<mode>), and make repo-check fails any other call of build.sh. native-arginfo-php-extension-check runs its database cases with the server environment it lacked.
- make kit-check failed with three findings because make ts-min-check started node and npm by their bare names, and make duplication-check failed on a repeated list of expected findings in the test of generatedCodesErrors (T339-8). ts-min-check now runs the npm-cli.js of the npm of mise.toml with the node of the lowest Node release by their paths, and the test names the shared findings once.


- The recipe contracts/fixtures/catalog_connection/catalog_connection.json runs its eight cases on MySQL, PostgreSQL and SQLite in the six clients (T334-3-3-1): make catalog-connection-check/<client> runs the entries catalog_connection-<database>, config/parity.json binds them, and a recipe with a database fixture names a dbspec-set.json and a table_page expect names every column of the page (FCV-4). The recipe found three defects, each fixed with a unit test first. A Python date or uuid cell of a described table was refused; it is its dbspec text. A Rust cell that the catalog cannot return, such as a MySQL TIMESTAMP or a PostgreSQL NaN numeric, failed with a decode error that carried no code; it fails with CATALOG_VALUE, which make catalog-value-rust-check checks. A PostgreSQL time(p) or timestamp(p) cell of a PHP or PHP extension described read lost its zero fraction digits, so every insert into such a column failed with ROW_WRITE_MISMATCH; it has exactly p digits. The MySQL dialect probe records that time(7) fails with error 1426. INT-101, INT-103, INT-104 and INT-115 state the behaviors that the recipe asserts: the read-only scope of a plain query, CATALOG_LIMIT and its byte rule, and the grid cells of SQLite temporal text and of zoned types.
- A Python read of a described table returned the raw driver value of each date, time and datetime cell (T334-3-3-10): a MySQL or PostgreSQL DATE cell failed with CATALOG_VALUE, a MySQL DATETIME and a PostgreSQL timestamp cell read as a datetime and a PostgreSQL time cell as a time, so the cell carried no declared precision, and a SQLite cell was returned with no check of its form. table_page and the rows that insert_row, update_row and delete_row read (lookup, RETURNING and the generated-key re-read) now return a str, the dbspec text of each date, time and datetime cell with exactly the declared precision p, as INT-103 states: MySQL and PostgreSQL take p from the native type or the default of INT-101, and SQLite keeps the stored text, whose fraction digits must be the p that the dbspec CHECK of the column fixes, which describe_table reports as CatalogColumn.check_precision. A non-zero digit past p, or a SQLite column without such a CHECK, fails with GRID_TEMPORAL_PRECISION, and a value outside the dbspec form with GRID_TEMPORAL_VALUE. A catalog write compares each written value exactly with the cell it reads back, and refuses a datetime for a date, time or datetime column with ROW_INSERT_INVALID or ROW_UPDATE_INVALID. The descriptor that a Python row revision hashes now holds check_precision for every column, so the revision of every row differs from the one an earlier version computed. MySQL TIMESTAMP, PostgreSQL timestamptz and timetz, read_only_query and read_only_grid_query are unchanged. make catalog-mutation-helper-python-check runs the unit tests of packages/python/tests/test_catalog_described_temporal.py.
- make lint-go failed with errcheck on packages/go/orm/catalog_temporal.go, whose precision of a temporal native type discarded the error of strconv.Atoi (T334-3-3-11). The pattern of each type captures the precision as one digit from 0 to 6, so the precision is that digit, with no conversion that can fail.
- make ts-min-check ran npm run typescript:test with the npm of the lowest Node release, npm 11, which refuses a checkout whose devEngines names npm 12.2.0 with EBADDEVENGINES (T339-7). The recipe puts the bin directory of the npm of mise.toml, whose npm runs the node on PATH, before the lowest Node, so the tests run on that Node with the declared npm.
- After T339-4 removed the error-codes steps of ci.yml, the docs job and the feature-coverage and client-db jobs failed in a fresh checkout (T339-6): make docs-verify-idempotent and make orm-docs-check build the TypeScript client inside their npm scripts, and the coverage tests that scripts/features/coverage.mts, scripts/features/owners.mts and scripts/client-db-test.mts start run the interface checker, whose API units read the error code files of every implementation, so they failed with TS2307 for ./codes.js or ENOENT for packages/php/src/Code.php. Those targets now have orm-codes-typescript or orm-codes as a prerequisite, and generatedCodesErrors finds such readers by the npm scripts and the runners that their recipes name.
- In a checkout without the error code files, a target that reads one ran before anything wrote it: make ts-codec-errors-check failed with TS2307 for ./codes.js, make client-unit-check/code-catalog with "Code.php has no constant for VERSION_MISMATCH" and make mermaid-error-python-check with "cannot import name 'codes' from partially initialized module 'polyspec.orm'" (T339-4). Only the install targets and a make orm-codes step of three CI jobs and of the shared and parity setups of kit wrote them. Every target that reads one now has orm-codes-typescript, orm-codes-php or orm-codes-python among its prerequisites: php-vendor-check and python-venv-check have the file of their runtime, the targets that compile the TypeScript client in their own recipe, lint-php and test-php-ext have theirs, and the parity gates of kit have orm-codes. orm-codes-<lang> publishes its file by a rename, since the make processes of several runs write it while others read it. The CI steps error-codes, the orm-codes setups of config/ci.json and the repo-check rule that required those steps are removed; repo-check fails a target whose recipe reads an error code file without the prerequisite that writes it. docs/operations/packaging.md describes the three files as untracked build output.
- A Go read of a described table returned a time.Time with no fraction digits for a date or datetime cell and the text of the driver for a time cell, so a PostgreSQL time(3) cell read as 12:34:56.5 and an insert into a SQLite DATETIME column failed with ROW_WRITE_MISMATCH (T334-3-3-6). TablePage and the rows that InsertRow, UpdateRow and DeleteRow read now return the dbspec text of each date, time and datetime cell with exactly the declared precision p, as INT-103 states: MySQL and PostgreSQL take p from the native type or the default of INT-101, and SQLite keeps the stored text, whose fraction digits must be the p that the dbspec CHECK of the column fixes (GRID_TEMPORAL_PRECISION otherwise, GRID_TEMPORAL_VALUE for a text outside the dbspec form). A catalog write compares each written value exactly with the cell it reads back, and refuses a time.Time for a date, time or datetime column with ROW_INSERT_INVALID or ROW_UPDATE_INVALID. make catalog-described-temporal-go-check runs the unit tests.
- In a checkout without packages/ts/src/codes.ts, which T339 made untracked output of orm-codes, make docs-build and make typescript-build failed with TS2307 for ./codes.js, so every docs-pages run on main failed (T339-3). Both targets now have orm-codes-typescript as a prerequisite, and docs-pages.yml installs the Go of mise.toml that orm-gen errors runs with.
- Kit 0.0.83 is the pinned release (T339-2); the integrity of the lock equals the sha512 of polyspec-kit-npm-0.0.83.tgz, and make kit-sync changes no copy. Its checkParity returns a promise, so the API declaration test of tests/interfaces/check/api.test.mts compared the findings of a pending promise and failed; the test awaits it. Kit 0.0.83 reads a generated error file that .gitignore ignores, such as packages/ts/src/codes.ts, as present (K968), so parity-declarations-check no longer reports the generated codes files of T339 as missing.
- layout-check of CI failed with ".mise/locks/npm-npm/12.2.0/node_modules/ is not ignored by Git (K372)" (T339): the sidecar folder of the npm of mise.toml had no .gitignore. Its .gitignore ignores node_modules/.
- rules-check of kit 0.0.82 reaches a target only through a make call or the arguments of a repository file (K941), and no CI job runs the aggregate make feature-coverage, so three rules of AGENTS.md that named it failed (T339). They name the eighteen targets feature-coverage/<runtime>/<database> that the CI groups run.
- The jobs test, docs and editor of CI built the TypeScript client without packages/ts/src/codes.ts and failed with TS2307 (T339): the error code files are build output, and only the install targets wrote them. Each of these jobs now runs make orm-codes in a step error-codes before its checks, and docs installs the Go of mise.toml for it; repo-check fails a job of ci.yml that runs check-run, docs-ci or ci-vscode-integration without that step.
- The PHP jobs of CI failed at install-link with "uv workspace dir could not start: spawnSync uv ENOENT" (T339): the link of kit reads the uv project of orm, and those jobs install no uv. orm-install-php and orm-install-php-extension-runtime no longer link; orm-install-python and make install link, and repo-check fails a PHP install recipe that links. .gitignore ignores the ruff cache, which layout-check reported at the root.
- With kit 0.0.82 every CI job failed in two places (T339). The npm cache of actions/setup-node ran the npm 11 of the runner in the checkout, which devEngines refuses with EBADDEVENGINES. Every setup-node step now sets package-manager-cache: false, and repo-check refuses a step that caches npm. The link of orm-install-python, orm-install-php and orm-install-php-extension-runtime ran make link, whose Claude Code hook needs a kit checkout that CI does not have. They now run make install-link, the link of kit without the hook.
- Kit 0.0.82 is the pinned release (T339), with the npm of mise.toml (K938): package.json declares npm 12.2.0 in devEngines in place of packageManager, mise.toml declares "npm:npm" with its digests in mise.lock and .mise/locks/npm-npm/12.2.0, and the bootstrap step of ci.yml and docs-pages.yml runs the npm of devEngines outside the checkout. The generated files follow the configuration of kit 0.0.82: packages/ts/src/codes.ts, packages/php/src/Code.php and packages/python/src/polyspec/orm/codes.py are no longer tracked, and `make orm-codes` writes them from docs/spec/errors.yaml at install; config/generated.json declares packages/go/orm/codes.go and packages/rust/orm/src/codes.rs as `tracked` with their reasons; the PHP, Python and PHP extension packages of config/release.json declare make entries (`orm-codes-php`, `orm-codes-python`, `php-ext-release-sources`) in place of php-arginfo and source-copy; packages/php-ext/src/native/sqlite_cancel.c is an ignored copy that a make rule writes from packages/php/src/native/sqlite_cancel.c, and packages/php-ext/scripts/build.sh refuses a missing or different copy; `make orm-install-php-extension-tools` no longer runs kit-install-php-arginfo.

- The PHP extension checks UTF-8 with one function: the YAML stream reads its bytes with the check of the text stages, in place of a copy of it. (#T334-3-14-1)
- The codec suites are one recipe, tests/codec/codec.json (FCV-2 to FCV-4, COD-40): its cases call codec.decode, codec.encode, codec.host_encode, codec.host_decode and codec.blind_index with no database and state the bytes or the value each step gives; Go TestRecipeCodecNone, PHP CodecRecipeTest, the PHP extension CodecRecipeTestExtensionTest, TypeScript codec-none.test.mjs, Python test_codec_none.py and the Rust test codec_none run it through the recipe helper of each runtime, and make codec-check runs the six. tests/codec/vectors.json, decode-vectors.json, aes-vectors.json, the PHP generator gen.php and the per-runtime vector runners are removed, with the parity units codec-aes, codec-decode and the feature units whose cases the recipe holds; the PHP cause tests move to CodecErrorCauseTest. COD-40 now states that the PHP extension implements `Polyspec\Orm\Codec` in C (T334-3-14).
- The codecs read as docs/spec/codec.md states in every runtime: Go reads a YAML stream that starts with a byte order mark, refuses a stream that is not UTF-8, the serialize bool other than b:0; and b:1; and the non-finite floats d:NAN;, d:INF; and d:-INF;; PHP and the PHP extension refuse a YAML stream that is not UTF-8, a plain YAML integer outside i64 and the non-finite serialize floats; TypeScript reads an integral YAML key in every core-schema form as its decimal string and refuses two keys of one decimal string; Go and Python write a YAML string that holds U+0085, U+2028 or U+2029 double-quoted, so it reads back as written, and Go reads an explicit scalar key. COD-16 states that a float of the common value model is finite (T334-3-14).
- The helper error-codes of contracts/features.json names docs/spec/errors.yaml, the orm-gen errors command and the generated files that Git tracks (codes.go, polyspec_orm.stub.php, codes.rs), and its command compares only those; it named the TypeScript, PHP and Python code files that T339 made build output, so make feature-unit-check failed with "matches no tracked file" (T339-1).
- packages/rust/orm/tests/statement_events.rs is in the form of rustfmt again: the closure page_of that T323 wrote on one line is a block, so make rust-fmt-check passes (T323-1).
- Every case of packages/rust/testing/compiler-fixtures/cases.json is one trial `compiler_fixtures::<id>` of packages/rust/orm/tests/compiler_fixtures.rs, which reads the file, so a new case runs with no edit; each case declares its requirements there, and make rust-compiler-fixtures-check runs that test alone. Before, the native file ran 7 of the 12 cases and a full run of compiler-fixtures.mts excluded 4 of them by name, so 3 cases ran twice and 5 had no native test (T334-3-10). The runner takes only --case.
- Every go test of the repository carries the tag ormtest of the test entry point: tests/go-test.mts merges GO_TEST_TAGS into each run, so the rollback and statement fault tests of the package orm run in the plain go lane of client-db-test.mts, which ran ./packages/go/... without them and a second, separately tagged command for them; the per-target copies of -tags ormtest are gone (T334-3-6-1).
- scripts/features/schema/recipe.schema.json closes the recipe format of FCV-2 to FCV-4: the keys of a recipe and a case, the recipe wrappers, the SQL of one or all three databases, the outcomes and the ops model.connect, codec.decode and sql.exec with their fields; a recipe with a fixture expects exactly mysql, postgres and sqlite and one without expects exactly none. scripts/features/recipes.test.mts, run by make feature-unit-check, validates every recipe of the parity suites against it with ajv and checks that the schema refuses each break of the format; its inputs are declared in contracts/check-inputs.json.
- docs/spec/feature-coverage.md states that one spec holds every orm test and the recipe format in place of FCV-2 to FCV-4: a recipe is a parity suite file whose `$schema` names scripts/features/schema/recipe.schema.json, with requirements, a .dbs fixture, seed rows inserted through the generated model create, and cases of steps whose ops are each one public API call of all six runtimes; a recipe with a fixture is one suite unit per database, each bound to one entry of the ecosystem test pattern of a runtime that calls a shared helper with no command line; every step that compares its result expects exactly mysql, postgres and sqlite, or none; values are recipe wrappers, an int a decimal string. The ops model.connect, codec.decode and sql.exec are the first of the list. FCV-2 to FCV-4 described a second run of the coverage tests against a database that the checker selected from outside.
- The PHP extension lane of scripts/client-db-test.mts runs ModelTest once, as it runs every PHP test file, with no --timeout, --filter or --exclude-filter: each test keeps the 120-second limit of #[Medium], which kit applies when no --timeout is given; before, the lane ran testPrimaryAndReplica alone with --timeout 120 and the other ModelTest tests with --exclude-filter (T334-3-9).
- config/toolchain.json no longer declares an exception for typescript 6.0.3 of packages/ts/testing/interfaces/typescript, since kit does not judge a declared version (S4); the package keeps its pin 6.0.3 in its package.json, for the JavaScript API of the compiler that packages/ts/testing/interfaces/typescript.mts reads (T340).
- Each TypeScript vector-suite file holds only its fixture cases and runs whole: the feature cases moved to value_function_ir.mjs (from coverage_planner.mjs), styled-value-features.mjs (from styled-value.mjs) and dbspec-show-create-introspect.mjs (from dbspec-show-create.mjs), their bindings name the new files, and config/parity.json passes no --test-skip-pattern and no --test-name-pattern to them; before, the suite bindings skipped the feature cases of their files and two feature bindings narrowed the file to one case (T334-3-8).
- The fixture tests of the Go testcase harness, which fail, skip or stall by design, are the package packages/go/testcase/testdata/fixture without a build tag: testdata is the place Go keeps fixtures, which go test ./... never matches, and runFixture runs them with go test ./testdata/fixture; before, testcase_fixture_test.go built only under the tag testcasefixture, so the plain build of packages/go/testcase ignored the file (T334-3-7).
- The types-and-defaults case of tests/dbspec/ddl.json declares a scale-4 SQLite decimal column, `amount decimal(13,4) null`, with its statements on MySQL, PostgreSQL and SQLite and two SQLite steps that insert 9999999999999 and refuse 10000000000000 by its CHECK, so the dbspec-ddl suite of all six runtimes asserts its scaled integer storage; the typescript `decimal_model/sqlite_decimal_ddl` case, which sat in the decimal-model suite file outside the suite, and the python test_decimal_model_sqlite_ddl.py, which was declared a repeat of a vector that held no scale-4 column, are deleted (T327).
- The ten section trials of the Rust integration program carry no #[ignore] and run in the workspace cargo test of the rust lane of client-db-check and client-pooler-check, each in case databases of its own, so they run in parallel; the separate --ignored run of the sections is removed, and case-database-check runs the target integration_program. coverage_generated_model_connection is three tests, coverage_generated_model_connection_mysql, _postgres and _sqlite, each on a case database of its driver with the bench set installed, so it reads ORM_FEATURE_DATABASE and ORM_FEATURE_DSN no more (T334-3-1).
- The TypeScript binding of the parity unit request-hook-reads-params is request_hook.mjs request-hook/reads_params alone: packages/ts/tests/coverage_request_hook_reads_params.mjs is deleted, since it ran the same case of request_hook_run.mjs with no assertion of its own through runCase, registered no node:test test, and made the parity run report the unit as not executed (T322).
- packages/rust/tests/bench_model.rs, the bench model list that build.rs and coverage_model_generation.rs share, is declared where build.rs is: a rust support file of config/parity.json, a test file of its feature and an input of each check that names build.rs; before, the parity declarations reported it as an undeclared test and the feature check as a rust test file of no feature (T334-2).
- Each section trial of the Rust integration program (conditions, joins_and_relations, columns_and_subqueries, writes, transactions, aes_rotation, json_values, bind_limit_splitting) starts its case per driver in its own body, as schema_empty does; the case started inside the installed_section helper, where the repository check that every Rust test starts its case found none (T334-1).
- make install installs the PHP arginfo generator and parser of the locked kit 0.0.79 again: orm-install-php-extension-tools runs make kit-install-php-arginfo, which T328 had removed for the unreleased kit K930; without it every extension build of a fresh checkout stopped on the missing var/tools/php-arginfo/PHP-Parser-5.6.1 (T338).
- The coverage case "coverage runs without cargo proceed while the Rust test build runs" writes and builds its fixture crate in a setup of @polyspec/kit/test-hooks, a long operation without a deadline, so the cargo test --no-run of the case finds it built and only the FIFO decides the overlap; before, the case compiled the crate inside the 30000 ms budget of its run and failed under a load average of 83 (T335).
- Each TypeScript test file that a feature of contracts/features.json verifies is its own verification command: dsn, statement-events and planner each split their pair of files into two commands with the inputs each file reads; T319 and T323 had chained each pair with &&, so the first failure stopped the next and make repo-check/unit refused the three commands (T337).
- packages/php-ext/scripts/build.sh builds the extension as the locked kit 0.0.79 expects again: it no longer passes --source-copy for packages/php/src/native/sqlite_cancel.c, which the 0.0.79 builder stages itself from the source-copy entry of config/release.json, so the build no longer fails with "source-copy output src/native/sqlite_cancel.c collides with a file already in packages/php-ext/src". The K930 form returns with the adoption of a kit release that carries it (T325-2).
- The PHP and extension bindings of the PostgreSQL and SQLite hot path gates run PHPUnit with --teamcity and the per-database environment from their own command, as the other PHP feature bindings do, and feature-php-database is removed: it started vendor-php/bin/phpunit outside run-tests, which the repository check refuses (T316).
- The PHP and extension bindings of the PostgreSQL and SQLite hot path gates run PHPUnit with --teamcity and the per-database environment from their own command, as the other PHP feature bindings do, and feature-php-database is removed: it started vendor-php/bin/phpunit outside run-tests, which the repository check refuses. The extension bindings also set POLYSPEC_ORM_EXTENSION, which PerformanceGateCoverageCase requires (T316).
- The client test that a SQLite DSN with a query creates the file named by its path alone is bound to connection-sqlite-absolute-path (CFG-26) in all six runtimes, with a python test_sqlite_file_name_is_the_path beside test_sqlite_dsn_requires_absolute_path and the inherited php-extension DsnTestExtensionTest::testSqliteFileName, and each test names CFG-26; go TestSQLiteFileNameIsThePath was declared an internal test of an external service, which it is not (T324).
- orm takes its npm from mise.toml, as kit K938-1 requires: package.json declares devEngines.packageManager npm 12.2.0 instead of packageManager, mise.toml declares npm:npm 12.2.0 with its lock and sidecar, and the CI bootstrap reads devEngines.packageManager.version and runs npm ci outside the checkout with --prefix; before, make worktree-setup refused orm's package.json and created no worktree (T336).
- The rust lane of client-db-check and client-pooler-check and the rust command of case-database-check run only the ignored section trials of the Rust integration program, with libtest --ignored: with --include-ignored they also ran coverage_generated_model_connection, which fails without the variables of feature-check, and the generated getter tests a second time. build.rs and coverage_model_generation_check read the set and the scan paths of the bench model from one list, packages/rust/tests/bench_model.rs; the check kept its own copy of the scan paths, which lacked tests/integration_program, so its model lacked the chain methods the program calls (T334).
- build.rs and coverage_model_generation_check read the set and the scan paths of the bench model from one list, packages/rust/tests/bench_model.rs; the check kept its own copy of the scan paths, which lacked tests/integration_program, so its model lacked the chain methods the program calls (T334).
- A TypeScript suite test file holds only the cases of its suite: the engine and load-set tests move to packages/ts/tests/engine_features.mjs and the DSN feature tests to packages/ts/tests/dsn_features.mjs, the markdown-conformance orm-gen gen --check precondition becomes the file's before hook, dsn/pool-options, a duplicate of connection/pool-invalid-options-refused, is deleted with its one new input moved into pool_bounds.mjs, and dsn/invalid is bound to connection-dsn-utc and connection-dsn-supported-parameters; before, the parity check of ir-validate, sqlite-paths and markdown-conformance on typescript reported each of those tests as a case not in the suite (T319).
- 48 Go tests that assert a requirement of an existing parity unit are bound to that unit, and each test file names every requirement of the unit: tests of the dbspec analysis, format, apply, introspection, manifest and SQLite lock result, the runtime model loader, join placement, generation check, generated getter types, grouped rows, duplicate relations, SQLite writers, styled states, the MySQL and PostgreSQL add-tables-and-columns cases, cancellation inside a transaction, database value conversion, the catalog grid, DSN selection, the host codec, install, IN padding, native time refusal and transaction end failures. A featurecoverage test is bound with the feature-go-unit command on SQLite, and the go CFG-9 adapter of contracts/interfaces.json and docs/spec/interfaces-model.md name TestWithContextCancelsInsideTransaction (T326-2).
- The 91 case functions of the Go planner coverage run only as subtests of `TestCoveragePlanner`, which runs each case of contracts/fixtures/planner.json by its id: they are unexported, and the feature coverage and the go bindings of planner-param-uses and planner-upsert-conflict-key-validation name each as `TestCoveragePlanner/<case>`, where go test ran each case twice, once as an exported test that no parity binding named. The feature coverage selects a go symbol `<parent>/<case>` with one run pattern per parent and does not count the pass of the parent (T326-1).
- The Python PostgreSQL connection prepares a statement text on its first execution and reuses it (psycopg prepare_threshold=0), as the Go and Rust clients do, instead of sending a text unprepared four times and preparing it on the fifth in a round trip of its own, which spent a server transaction more than its statement event (INT-149; docs/operations/perf.md F1, docs/spec/config.md CFG-28) (T329).
- The server_transactions vector of tests/events/vectors.json has one entry per database, PostgreSQL and MySQL, and the feature unit statement-events-server-transactions binds it in go, php, php-extension, python, rust and typescript. Before, only go, php, rust and typescript ran it, on PostgreSQL alone, and no unit bound them. MySQL counts the transactions of the connection's thread in performance_schema; a test fails when the transaction instrument or its consumers are off, and when the probe's own cost differs from probe_cost. docs/spec/interfaces.md states the rule as INT-149 (T323).
- make install no longer calls the kit target kit-install-php-arginfo, which kit K930 removed because arginfo comes from PHP's gen_stub.php, which the kit builder runs; every make install of a checkout linked to kit main stopped there before the python venv, flowmark and the interfaces TypeScript were installed. ArginfoBuildTest checks what build.sh does now: it passes the kit builder the arguments of each mode and returns its status and output without running a tool itself (T328).
- Each section of the Rust integration program is a test of the test target integration_program (packages/rust/tests/tests/integration_program), so the 19 rust parity bindings that name a section run it through make feature-rust-database and the parity run credits them, where the program ran its sections through its own main with --case, which printed no libtest result line, so cargo test selected no test. chunking-rust runs bind_limit_splitting through cargo test; the generated models are unchanged (T311).
- The rust binding of go-internal-packages-go-engine-functions-physical runs coverage_conformance_vector through make feature-rust-database with the SQLite database, as coverage-conformance-verification-conformance-vector runs it, so the parity run executes the ignored trial with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN. Before, the binding had no command, cargo reported the trial ignored, and the run read it as skipped (T314).
- The PHP extension build stages packages/php/src/native/sqlite_cancel.c as src/native/sqlite_cancel.c with --source-copy in both build modes, as kit K930 requires, since the kit builder no longer reads the source-copy declarations of config/release.json. Before, every release build of the extension failed with No rule to make target src/native/sqlite_cancel.c (T325).
- The php bindings of group-count-boolean-decode and group-rows-negative-count name the GroupRowsTest methods that the shared GroupRows cases define, testGroupValueRejectsInvalidStoredBoolean and testGroupRowCountEnforcesExactness, where they named two methods that the move of the cases into GroupRowsCases deleted, so the parity run reported them as not executed; the invalid row counts include -1.5 again, which that move dropped (T320).
- The typescript binding of statement-subscriber-failure-preserves-error names the test subscriber_error, which statement-events.mjs registers for that case over all three dialects, where it kept the name statement_events/subscriber_error/sqlite from before the file registered one test per case, which matched no test, so the parity run reported it as not executed (T321).
- The rust binding of group-row-owner names collection::group_tests::grouped_rows_contain_only_group_values_and_checked_counts, the test that owns INT-68 to INT-71, so the parity run executes it. Before, it named a test that never existed, which selected no test, and the binding was reported as not executed (T312).
- The TypeScript model test registers each case with node:test under its parity id and runs it on the dialects it declares, so the parity run credits its TypeScript bindings, where model.mjs ran its sections outside node:test and every binding of the file was reported as not executed; its cancellation, transaction-end failure, MySQL install-inside-transaction and styled-state cases are bound to the units that test the same behaviour in the other runtimes, Go TestMySQLInstallInsideTransaction among them, and a case selected with --test-name-pattern replaces the --case and --dialect arguments (T318).
- The python hot path measurement writes its PERF lines to standard output, so the unittest result line of `test_hot_path_gate` holds only its outcome and the parity run credits the three hot path units, where the lines written to standard error inside that result line hid it (T310).
- Python `Db.connect_schema` checks the schema before it opens the connection, as the other runtimes do, so a schema that fails the check, such as a changed manifest, leaves no open connection, where the connection stayed open and was reported as a ResourceWarning; with both an invalid schema and an invalid DSN, the CONFIG error of the schema is now reported first (T317).
- The rust binding of complex-query-public-semijoin-plan names its test with the module path, coverage_complex_query::full_product_search_request_compiles_for_mysql_and_postgres_and_rejects_sqlite, as cargo reports it in the integration target; the parity run selects it with --exact. Before, the id without the module path selected no test, and the binding was reported as not executed (T313).
- The python bindings of dbspec-apply-chain and dbspec-apply-stress run under the parity runner's own unittest run, as their sibling bindings of the same file do, so the parity run credits them, where make dbspec-apply-python-check reported them in a form that the python reader does not read (T308).
- The runner check asserts the loop that exports every variable of the TEST_ENV file into make (T299), where it asserted the export loop over the complex-query DSN names that T299 removed, so runner-check passes again (T315).
- The python bindings of the pool idle and lifetime units name test_idle_size_and_lifetime, the method of the pool test, so the parity run credits them, where they named a method that the file never held (T307).
- The Python introspect runner imports its helper from the test package and runs as `python -m packages.python.tests.dbspec_introspect_runner`, like the apply runner, so the parity run of the support file imports it and reports no case, where its import failed and was reported as an undeclared test (T306).
- Nine python bindings of config/parity.json name their test by its method, the form that the unittest run reports, so the parity run credits them, where their `<Class>.<method>` ids were reported not executed (T305).
- The php-extension binding of schema-existence-and-installation names SchemaUtilsNativeTest::testExistsEscapesUnderscoreInSqliteSchemaName in its class form, so the parity run credits it, where the bare spelling of a test that another unit binds with its class was reported not executed (T304).
- Kit 0.0.79 is adopted (KSTD-5-125): CI calls the shared, parity and runtime checks of `.github/workflows/ci-pipeline.yml` as its job `kit`, whose success `ci-passed` requires, and a release is a dispatch of `release.yml` with the id of a successful `ci.yml` run, whose `make release-tag` tags its commit; `make release-verify` and the release by a pushed tag are gone.
- A native read of an invalid date or datetime throws the CODEC_DECODE OrmException "invalid date value <text>" with its native cause, where a row read or a grouped value ended without an error, and the extension reads the fallback forms and the end offsets that the PHP library reads (T293).
- The DECIMAL_ENV message of decimal-physical-check names make run-databases TARGETS=feature-helper-check, the declared target that runs it, and conformance-rust-group-check is removed, since conformance-check runs a superset of its cases (T288-1).
- The extension run guard fails a run only for a loaded library file whose class the extension declares, so a run that loads the generator, which the extension does not provide, passes, and a forked worker no longer inherits a false failure (T302).
- make run-databases refuses, naming it, a target that contracts/check-inputs.json does not declare, where it ran the target as one that needs nothing (T288).
- The parity targets export ORM_PHP_DYNAMIC_MODULES, so the DeclarationsTest of the php-extension bindings reads the modules that the extension loads dynamically (T301).
- orm takes kit 0.0.78: the restamped PRINCIPLES.ko.md of K909, and the make link --project of an installed kit that writes no Claude Code hook in CI (K916, K918) (KSTD-5-124).
- Breaking: the generated Go getter of a plain column is `Get<X>() (T, error)` and returns `COLUMN_UNSELECTED` for a column that the read did not select (DBS-112); 0.0.18 generated `Get<X>() T`, so a caller takes the error. The generated date, time and datetime setters take the text form since T189, which also breaks a caller that passed a native value (T300).
- make exports every variable of its TEST_ENV, as the CI contexts export the run env, so a unit that kit starts from make, such as the native suite of test-php-ext, finds the server DSNs under make run-databases (T299).
- An exit() inside a native Db::transaction or its savepoint ends the request as it does under the PHP library: the extension runs no rollback for it and passes it on, and the lost connection rolls the writes back and releases the named lock (T297).
- The peak child of DeclarationsTest runs with -n and the extension's modules, so the extension that the run ini already loads is not loaded twice (T298).
- The Makefile derives the dynamic PHP modules that the extension declarations load under php -n from the PHP that kit runs, and test-php-ext passes them, so the native suite runs DeclarationsTest without a workflow value (T296).
- The native Decimal::decode of the PHP extension keeps the CODEC_ENCODE normalization failure as the previous of its CODEC_DECODE OrmException, as the PHP library does (T295).
- The parity and runtime contexts of the gates export the decimal DSNs of their run beside its TEST_ENV, so the decimal parity cases and the native decimal database test find their databases (T294).
- The parity bindings whose test requires ORM_FEATURE_DATABASE and ORM_FEATURE_DSN run through the per-database make wrappers, and the new feature-php-database runs the PHP library and extension cases so, which the 15 bindings of the hot path gates and the Go and Rust database cases that ran directly lacked; the TypeScript SQLite hot path measurement and group rows bindings name their database in their command, the three TypeScript decimal bindings pass their dialect, the Go conformance vector binding runs through feature-go-unit, the Go decimal bindings pass the decimalphysical build tag, and feature-rust-database includes ignored tests, so the Rust conformance vector runs (T282).
- orm requires the released ordered-json 0.0.14 in npm, Composer, Python, Go and Cargo, the version of the development source; the root composer.json reads it from the packages.json repository of the release, as packaging.md shows (T286).
- The PHP extension keeps the native exception as the previous of the OrmException of an invalid date and of a JSON encode failure, as the PHP library does (T292).
- The Python case of the decimal physical check writes its unittest report on stdout, the stream the check reads, so a passing run is observed (T289).
- make orm-install-python runs make link after uv-install, as orm-install-php does after composer install, so the CI venv holds the own link of polyspec-orm that link-check compares (T291).
- make orm-install-php-extension-tools installs the pinned arginfo generator and parser again: no CI job runs install-kit, so the extension builds of ci and the parity jobs of gates found no PHP-Parser after KSTD-5-123 (T290).
- A physical case whose output does not hold its exact pass event fails with that output, its DSN redacted, so the failure shows what the predicate read (T287).
- repo-check compares no running PHP with .php-version: a wrong PHP fails the target that runs it, as kit K854 rules for every tool (T285).
- The Python thin-slice example binds its datetime as text, as the TypeScript one does, and its native timing runs the statement with the %s markers of PyMySQL through for_mysql (T271).
- orm takes the released kit 0.0.77 in place of 0.0.75 (KSTD-5-123): the development links follow the link declaration .links, which link-check compares (K869), and the prepare-commit-msg hook is gone (K892); the Python client installs through uv-install (K850), Composer runs as composer install followed by make link, and deps-rust is the CI setup of the rust runtime (K859); toolchain-check is gone, since a missing tool fails the target that runs it (K854); install-kit installs the arginfo generator (K861) and the crates of every Cargo.lock, so no target checks the downloaded crates (K864); a PHP child of an extension run inherits the extension through PHP_INI_SCAN_DIR, so the test helper names none (K900); and the Composer example of packaging.md reads the packages.json of a release (K865).
- The SQLite fact sqlite.render.time_check and DIA-53 record that the pinned SQLite 3.54.1 time() returns 00:00:00 for 24:00:00 and NULL for 24:00:01 and 25:00:00 (T280).
- feature-verify-rust and feature-verify-other declare the interfaces-typescript need, so CI installs the TypeScript that the interface check of their feature verification reads declarations with (T278).
- A drift ApplyError of the PHP library names the schema mismatch in its detail again and carries no previous, as the PHP extension does; KSTD-5-94 had passed the internal PlanSchemaMismatch as its cause (T277).
- orm requires the released ordered-json 0.0.13 in npm, Composer, Python, Go and Cargo, the version of the development source, so cargo resolves the source that the link provides (T276).
- Public API: no public signature names an internal type (T274). TypeScript: Core where, joins, relations, columns, order, on, row and build, Db plan and args, and the constructors of CatalogConnection, Subscription, ValueFunction and ColumnFunction leave the declarations, which strip @internal; Subscription, Notification, ModelLike, SetSpec and DriverName are exported; the IR interface ColumnFunction is ColumnFunctionIR. Python: the dialect base is the public Dialect, and register_model returns the public RegisteredModel. In both, ValueFunction and ColumnFunction share no base class and have no ir method.
- CARGO_SIBLINGS runs the kit cargo link without --siblings, which the link declaration file of kit K869 replaces; until orm adopts it, cargo builds the polyspec crates of their released tags (T275).
- The TypeScript thin-slice example binds its datetime as text, as the Go and PHP examples do and as a datetime slot requires since T89-3 (T271).
- The TypeScript MySQL driver sends an integral number parameter as a bigint, a LONGLONG, since mysql2 sends a number as a DOUBLE and ProxySQL refuses a DOUBLE LIMIT (T273).
- client-pooler-check declares and installs the PHP extension tools, since its php-extension lane builds the extension (T272).
- The PHP test helpers generate their models with orm-gen in a process of their own, through one helper generateModels, so a test that runs against the extension loads no file of the PHP library; every PHP test that an extension run executes uses it, and none names Generator (T270).
- The Python parity bindings of the complex query and the hot-path gate name their test class, and the postgres and sqlite hot-path bindings give the database and its DSN, as the mysql binding does (T269).
- The Python symbols of config/parity.json carry the import-root prefix polyspec.orm that the kit Python extractor reads since kit K788 (T268).
- The PHP extension declarations test counts ModelMetadata among the classes of the PHP client, as T258 made it public (T267).
- The bench vectors follow the ip_hex_cell table of the bench fixture: the Mermaid round trip lists its settings as dropped, and the Python generator test expects its manifest hash and 26 entities (T266).
- The feature php-extension-run-guard owns the PHP extension run guard and ExtensionRunGuardTest.php, so the features contract passes (T264).
- docs/features.md shows performance_gate as implemented, as contracts/features.json has stated since KSTD-7-6 (T265).
- feature-coverage/typescript/mysql declares the interfaces-typescript need, so CI installs the TypeScript that its interface case reads declarations with (T262).
- The shared gates job installs the Go module that tests/lease builds with (make orm-install-go-lease), since parity-declarations-check builds the TypeScript client through lease-tool (T261).
- The offline Makefile check accepts the lock targets, which write a lock from the network as an install does, so make orm-python-lock no longer fails runner-check (T263).
- orm takes the released kit 0.0.75 in place of 0.0.73, with the release workflow that kit-sync writes from it (KSTD-5-122).
- make orm-install-python installs the Python client editable, as uv sync does by default: the non-editable install of KSTD-5-104 left out the fixture models that python-models writes into src/polyspec/orm/models, so every Python test that imports polyspec.orm.models failed in a fresh venv, and a source change stayed uninstalled; kit K855 reads the Python symbols from the source package, which removes the reason (T259).
- make rust-fmt-check passes on main: the import list of the Rust conformance runner and a panic! message of the Rust integration tests are formatted as rustfmt writes them (T260).
- A row lock (forShare, forUpdate and their NoWait forms) is valid on a relation step without groupLimit, in every implementation, and that step's statement takes it; the client requires a transaction for it and takes the SQLite row-lock table as for a root lock, and a lock with limit_per_parent or group_by stays IR_INVALID (T257).
- The ci workflow runs no gate of kit: its CI groups run CHECK_TARGETS without CI_KIT_GATES, the prerequisites of kit-gates, which the gates workflow runs in parallel jobs, and the group parity goes; it ran every parity binding in series, past 76 minutes in run 40926936508 (KSTD-5-115).
- make repo-check reads the env of a make spawn from its whole call, which may span lines, and accepts make ci-install-tools as the install of the Go of mise.toml; it reported both falsely on main (KSTD-5-116).
- parity-declarations-check builds the TypeScript dist first, as lint-ts does, so the shared gates job on a fresh checkout finds packages/ts/dist/index.d.ts (KSTD-5-114).
- The python runtime of config/ci.json names orm-install-python, so CI installs the Python client non-editable and the parity API phase reads its symbols; the default uv-install made an editable install, whose file list holds no module (KSTD-5-113).
- Take the released kit 0.0.73 in place of 0.0.70: kit-sync writes gates.yml without the link steps of CI (K824), the PHPUnit autoloader reaches a listed run of the PHP extension (K827), and the principles of kit (KSTD-5-112).
- No public PHP signature names an internal type: ModelMetadata, the meta() contract of generated models, and CatalogRowSnapshot, the row snapshot of the catalog API, are public and declared; Model::registerJoins of the extension is internal, as in the library (T258).
- The orm-gen classes of packages/php (OrmGen, Generator, Scan, ScanVisitor, ChainDeclare, UsageError) are marked internal: they implement the generator command and are no API of the PHP client (T244-1).
- performance_gate is implemented: contracts/performance-references.json records the 36 fixed references of the six clients, three databases and two workloads from the passed check run orm_check_33189_3c995a77 of 97b4566f4, and every coverage case compares its ratio with its reference (KSTD-7-6).
- The parity declarations name the PHP extension run guard as a test helper and bind its three tests to PRT-18, so make parity-declarations-check passes and a check runs them (KSTD-5-109-1).
- The conformance vector ip_hex_roundtrip writes an address into the new bench table ip_hex_cell of codec ip hex and reads it back by eq on the address, on MySQL, PostgreSQL and SQLite in all six implementations: every client binds the hex text of the packed address, which MySQL refused as INET6_ATON of that text before T251. The symbol snapshots record ip_hex_cell and the stage split helpers of T251 and the date helpers of KSTD-5-94, which their rows left out. (KSTD-5-110)
- orm takes the released kit 0.0.70 in place of 0.0.66: the pin of package.json and its lock, which no longer holds the toml-patch dependency that kit deleted, and gates.yml from kit-sync, whose shared job computes no commit range (kit K815). (KSTD-5-111)
- The Python client builds the model of a manifest once per process, by dbspec.md DBS-104 as TypeScript does: a registry keyed by the manifest hash and checked against the texts returns the model already built, so register_model, Db.register, SchemaUtils.register and connect_schema parse a schema once, and RuntimeModel.load_set returns the documents already parsed for the same texts. (T256)
- A Python transaction whose start fails gives its pooled connection back, by interfaces.md INT-72: a failed BEGIN closes the connection, and a failed start step after BEGIN rolls the transaction back and returns the connection, so Db.close() closes it and a SQLite lock is not held until the garbage collector runs. (T255)
- A codec column compares by equality in every implementation exactly when every stage is a host stage, by codec.md COD-43: hex and ip compare the stored cell, and an aes stage compares the blind index, the HMAC of the value whatever its position, so eq on hex aes compiles in Go, PHP and the PHP extension too, and eq on ordered_json aes, whose stored form comes from text a predicate value is not, is OPERATOR_NOT_ALLOWED in Rust too. (T254)
- An eq, not_eq, in or not_in predicate on a column whose every codec stage is hex or ip compiles in Go as in the other implementations, by codec.md COD-43: equality applies when what is compared is a deterministic function of the value, the cell of such a column or the blind index of an AES column; COD-43 no longer limits styled predicates to null checks. (T253)
- orm runs its PHP extension tests without run-tests --without-library, which kit K790 deletes, and its test bootstrap fails an extension run, naming the files, that loaded any file of packages/php/src, so the run tests the extension and never a PHP fallback. (KSTD-5-109)
- On MySQL a column of codec ip hex packs and unpacks its address on the client in every implementation, since SQL wraps only the last stages of the write order: an insert binds the stored hex text instead of INET6_ATON of the hex text of the address, which MySQL refused with 1411. (T251)
- The privilege test of the Rust integration suite reads its PostgreSQL server DSN with a match that names the variable error, without Result::ok. (T252)
- orm runs no release version check, which kit K812 deletes: release.yml has no release-versions step, and AGENTS.md names no make release-versions. (KSTD-5-108)
- AGENTS.md has no refinement of P27, which restated the guided rule of kit K805 and named make item-state as its check. (KSTD-5-106-1)
- orm builds its wheel with uv build from build-system.requires, which is the one declaration of the build backend, and installs the Python client non-editable with uv sync --locked, which make link turns into the link of the checkout (kit K788, K803): config/toolchain.json has no pythonBackend, and packages/python/pylock.toml with its test is deleted. (KSTD-5-104)
- packages/python/pyproject.toml build-system.requires is the single declaration of the wheel build backend, setuptools==84.0.0, since config/toolchain.json declares none. (KSTD-5-99)
- orm has no release consumer projects, release proof, push gate workflow or commits check, which kit K798, K804 and K805 delete: config/release.json has no consumers and no proof, tests/release-consumer and .github/workflows/push-gate.yml are deleted, and the commit identity test and the subject rule go with config/commit-identity.json. (KSTD-5-106)
- packages/python/tests/coverage_catalog_connection.py is in the format of the pinned ruff format. (T250)
- make duplication-check finds no clone: the PHP without-MySQL test, the parity context test and the performance reference recorder share their child runner, command helpers and git reader, and the parity context test expects the interfaces TypeScript in the ts setup. (T249)
- orm runs the hooks of kit K805: .githooks/pre-commit no longer calls the deleted commit gates, and .githooks/pre-merge-commit and config/commit-identity.json are deleted. (KSTD-5-107)
- orm has no pre-push hook: .githooks/pre-push is deleted with the kit K804 push gate, and config/checklist.json hooks names commit-msg and pre-commit. (KSTD-5-105)
- The TypeScript binding commands of config/parity.json run the node:test reporter of the kit that make includes (${ORM_NODE_REPORTER}), not a local build of kit dist. (T248)
- Every tracked lock file has an owner again: the lock of the interface TypeScript is an input of interface-typescript-extractor-check, and the release consumer locks declare their scope. (T247)
- The repository tests of the CI tool selection and of orm-install-python match the invoked install-tools target, since kit K762 passes KIT and KIT_EXT on every recursive make. (T245)
- The runtime path check of make repo-check accepts TEST_ENV ?= .runtime/servers/env, the server environment that a run may override since KSTD-5-94. (T246)
- orm has no main writer hook: .githooks/reference-transaction is deleted with kit K801, and .githooks/pre-commit no longer records the committing git. (KSTD-5-103)
- orm locks Python with uv alone: make orm-python-lock writes packages/python/pylock.toml with uv lock and uv export, and config/dependency-policy.json, packages/python/constraints.txt and consumers.wheel.polyspec of config/release.json are deleted with the kit Python lock machinery. (KSTD-5-102)
- polyspec/orm holds orm-gen again: bin/orm-gen, the generator and the scanner are in packages/php as in 0.0.18, and the separate package polyspec/orm-gen is deleted, so a consumer of polyspec/orm runs vendor/bin/orm-gen with no other package. (T244)
- orm has no version check: scripts/version/check.mts, its test, the version-check target and PLN-5 are deleted; at release, kit make release-versions requires the tag version in every manifest. (T242)
- config/parity.json declares the Rust temporal argument test packages/rust/orm/tests/unit/temporal_args.rs, so make parity-declarations-check passes. (T243)
- orm adopts kit 0.0.66: the pin by its release asset URL, its lock and the synced kit files, so the gates workflow validates ci.json against a schema that declares runner. (KSTD-5-101)
- orm no longer runs or names dependency-policy-check, dependency-policy-mutation-check or dependency-review: CHECK_TARGETS, the CI groups, contracts/check-inputs.json and AGENTS drop them, and config/dependency-review.json is deleted, because the package managers verify their locks and report outdated and vulnerable dependencies. (KSTD-5-100)
- The wheel build backend has one declaration: packages/python/pyproject.toml build-system.requires names setuptools 84.0.0, the config/toolchain.json pythonBackend that the release builds with. Red: `make release-candidate-assets` reported that the two disagree. (KSTD-5-99)
- `make release-assets` and `make release-candidate-assets` build on the Go modules of the lease tool alone, as before the kit standard, so their Go prerequisites build in the environment of the kit release targets. Red: `make release-assets TAG=v0.0.18` stopped at `go mod download` (no modules specified). (KSTD-5-98)
- `make orm-install-php` installs the root Composer lock through Kit's composer-install, so a new worktree finds its locked PHP packages offline. Red: a new orm worktree-setup failed at Composer (KSTD-5-97).
- Install only the pinned prerequisites of each independent CI group, including native parity extractors, PHP arginfo and the minimal Go lease dependency; retain parallel client, DBspec and feature groups. (KSTD-5-96)
- Split native CI checks by client and SQL backend, run Markdown in six native jobs, and isolate performance and public-API/native-binding parity phases without dropping shared comparisons. (KSTD-5-95)
- Complete the native PHP client protocol with IR validation, codecs, planning, binding, execution and runtime classes. Shared native planner and bind cases, three-database six-client conformance and parity declarations provide execution evidence; native class names and ecosystem-library choices remain unchanged (T182).
- The complete PHP ORM surface is implemented in native C with the same class names, no PHP product fallback and matching six-client conformance on all three databases; independent acceptance review reconciles the former schema-only hold with the completed implementation (T199).
- Complete the native PHP query, model and collection client: required model/fixture cases run without PHP product fallback, all 59 conformance vectors agree across six clients on MySQL, PostgreSQL and SQLite after the focused audit-identity correction, and retained result contracts pass (T182-6).
- The native PHP extension executes the specified NULL-key refusal conformance vector with identical results in all six clients on MySQL, PostgreSQL and SQLite; the case preserves the documented IR_INVALID rejection before SQL (T77-6-1-1).
- `make kit-sync` refreshed six shared files from the installed local Kit package: four tracked links became regular copies, and release/gates workflows now match Kit source. `kit-check`'s ten initial findings are cleared (T240).
- Protocol/tooling parity declarations now trace their native case requirements across all supported clients; committed-tree declaration checks pass, with user-held cancellation shown separately rather than counted as execution evidence (KSTD-2-7).
- Incorrect standalone parity declarations and helper-test ownership are reconciled while preserving native assertions and exact owner execution commands; the declaration gate passes (KSTD-2-11).
- The KSTD-5-89 static-gate scope passes on main: the six original verification commands, nine additional static checks (9/9, including 18 pinned tools and 2,421 owned paths), and the source-specific lint gates are recorded with their commits and logs in the checklist. Duplication and parity/divergence checks remain in their existing rows (KSTD-5-89).
- The Rust schema stress test reports repository discovery, Node startup and parse failures with explicit matches; the interface-symbols parser consumes a trailing comma only when present and propagates parse errors (KSTD-5-93-1-1).
- The interface-symbols invocation-extraction unit uses a minimal unique macro fixture instead of copying the production macro body; it still checks the four extracted public signatures (KSTD-5-93-1-1-1).
- Rust apply tests retain rollback and close errors alongside the lock-wait result, SQLite pragma protocol errors retain their parse causes, and catalog coverage keeps its driver-specific failure messages while using the existing OrPanic helper (KSTD-5-93-1-2).
- The SQLite case of the lock_wait apply scenario of the TypeScript dbspec apply test sees the locked error again: its proxy of the node:sqlite apply connection wraps exec synchronously, as node:sqlite's exec is and as the applier calls it, so the failing `BEGIN EXCLUSIVE` reaches apply instead of a rejected promise nobody awaited; `make dbspec-apply-ts-check` counts 122 apply runs again (KSTD-5-89-44).
- `make lint-go` passes on main again: the Go driver of the dbspec apply comparison returns the errors of closing its blocker, its rollbacks and its row sets joined with the failure they follow and wraps the lock failures it reports, and the Go tests that dropped an error or formatted it without wrapping now fail on it or wrap it (KSTD-5-89-42).
- The MySQL test servers allow a non-SUPER login to create audit triggers, PostgreSQL requires SCRAM for loopback roles except `orm`, and the replica supports localhost identity checks while the mismatch DSN reaches it as `127.0.0.1`. PostgreSQL authentication and MySQL daemon changes apply after stopping and restarting the test servers (T239).
- The dependencies of the Rust test builds carry no debug information (`[profile.dev.package."*"] debug = 0`), while orm's own crates keep the line tables of the dev profile; the same test builds on main's setting write 27 percent less into target/debug/deps, 1.3 GB down to 978 MB (KSTD-5-93).
- `make rust-check/clippy` passes across the Rust workspace with all targets and `-D warnings`: the reported borrows, async overrides, state initialization, imports, error extraction, lock lifetime, captured assignment, duplicate module load and generated exports are corrected. The generated model emission owner test passed 1/1 (KSTD-5-93-1).
- The PgBouncer pooler cases of the TypeScript dbspec apply test run again: packages/ts/tests/dbspec-apply-physical.mjs imports pg, which its pooler cases use and which 522cd8c6f had dropped when it moved the database setup into dbspec-physical-database.mjs (KSTD-5-89-43).
- `make duplication-check` passes on main again: the SQLite file connection that CoverageDsnTest and CoverageDsnConnectionExtensionTest open, close and remove is the one helper onSqliteFile of CoverageDsnTest (KSTD-5-89-41).
- On PostgreSQL, the PHP client and the PHP extension report a failed statement with its catalog code again, such as DUPLICATE_KEY for a unique violation: the PDOException of the PostgreSQL PDO adapter carries the SQLSTATE in errorInfo. A statement also costs one server transaction again, because the adapter reads the table name of a result column only when getColumnMeta asks for it (KSTD-5-89-31).
- When another connection holds a SQLite database, apply, recover, rollback and finalize report `locked` after the one 5-second lock wait of PLN-90. Before, the read that restores the session waited another 5 seconds. Now, in all six clients, the read runs with `PRAGMA busy_timeout = 0`, and a lock result of it adds no cleanup error, since the connection holds no lock to release (KSTD-5-89-33).
- `make native-api-equivalence-check` runs with the environment of the test servers and builds the PHP models first, so the database cases of UtilsNativeTest run on MySQL and PostgreSQL; contracts/check-inputs.json declares that the target needs the databases (KSTD-5-89-32).
- `make interface-check` passes on main again: the Go, Rust and TypeScript symbol records list the 30 members that the PostgreSQL cancellation, the catalog value budgets and refusal messages, the shared test code and the ordered LISTEN delivery added without recording them (KSTD-5-89-37).
- The CFG-9 case of the interface checker tests expects the six implemented cancellation adapters that contracts/interfaces.json records since the PHP library and extension implement cancellation, and still refuses an adapter that claims implemented without its cases and surface (KSTD-5-89-36).
- The interface checker passes its manifest step again: docs/spec/interfaces-model.md and its Korean twin are regenerated from contracts/interfaces.json with `--generate`, which adds the Python cancellation case to the CFG-9 row, and the PHP and PHP extension symbol records list the members added since, including PgsqlLargeObjectStream::$context (KSTD-5-89-35).
- `make lint-php` passes on main again after the PostgreSQL cancellation: the PHP PostgreSQL adapter no longer silences pg_connect, pg_query, its COPY file reads and writes, stream_select and the large-object fopen with @: a scoped handler keeps the E_WARNING of a failing call as the reason in its PDOException, so a connection failure raises an OrmException that names the PostgreSQL error and no warning leaves the ORM, the large-object stream wrapper declares the $context property that the streamWrapper protocol sets, and the new files are laid out as phpcs requires (KSTD-5-89-25).
- The PHP plan and statement caches retain at most 8,192 placeholders each, in the library and the extension, so they keep a few MiB (3.2 MiB of plans and 4.3 MiB of statements in the library) instead of 25.6 MiB and 34.4 MiB at the bound of 65,535, and a multi-row INSERT import stops growing once they are full (KSTD-7-3-5).
- The protocol states the PHP cache bound: 8,192 retained placeholders per cache, least recently used entries evicted while over it, and a request over it planned and run without caching; it applies to PHP only (KSTD-7-3-6).
- `make dbspec-php-extension-check/vectors` tests the extension again: the two unit tests of the internal library class `Polyspec\Orm\Dbspec\CatalogRows` moved from DbspecTest, which runs on the library and the extension, to DbspecCatalogRowsTest, which `make dbspec-php-check/documents` runs on the library, so the extension run no longer loads packages/php/src/Dbspec/CatalogRows.php (KSTD-5-89-34).
- orm is on the kit K613, K614 and K621 layout and reads no kit dist: config/layout.kit.yml is kit's copy, config/php-lint is gone, PRINCIPLES.md, PRINCIPLES.ko.md, .editorconfig and .claude/settings.json link into ../kit, and build.sh, the scripts and the tests run kit's scripts/kit sources (KSTD-5-89-26).
- `make duplication-check` passes on main: each piece of code that jscpd found twice in packages/php-ext, packages/php, packages/go, packages/rust, packages/ts and packages/python now lives in one helper that both places use (C headers, PHP traits and helper files, a Go internal package, Rust common modules and macros, JavaScript and Python helpers). The MySQL cancellation case of every active root now starts its second process only after the controller holds both wait locks, so that process can no longer take a wait lock first (KSTD-5-89-22).
- Separate the stress input producer from benchmark-helper ownership; owner selection validates the repaired registry (KSTD-5-89-23).
- `node scripts/features/owners.mts --list` passes on main again after 548960952: the 41 suite targets of contracts/check-inputs.json no longer carry the empty inputs list that its schema refuses, and the four dsn_connection verifications pooler-cancellation and pgsql-pdo-adapter of the PHP client and the extension no longer list the files of the helpers php-test-autoload and error-codes as inputs (KSTD-5-89-24).
- Adopt the sibling Kit bootstrap and remove nine obsolete copies; every ORM tool source is classified for rebuild checks (KSTD-5-89-13).
- `make lint-ts` passes on main: every unsafe type assertion of scripts/features and the tests reads its value through a checked reader, the unused variable of the TypeScript catalog connection coverage is gone, markdown-it is a declared devDependency, and the root tsconfig.json no longer names web-bluetooth (KSTD-5-89-21).
- `make lint-python` passes on main: the LISTEN cleanup of the Python client re-raises an error that is not a psycopg error, the row-lock holder of the transaction coverage re-raises its failure, two unused imports are gone, and ruff format rewrites 21 files with no change to their syntax tree (KSTD-5-89-14).
- `make layout-check` passes: dbspec-apply-python-check sets no PYTHONPATH, since the Python environment resolves the package; packages/php-gen/composer.json maps autoload-dev by PSR-4 and its vendor folder is ignored (KSTD-5-89-12).
- `make lint-php` passes on main again: phpcs reports no finding in the PHP added since KSTD-5-89-3, after its long lines, call signatures and control structures are laid out, each helper class and trait has a file of its own, the test files require nothing at their top, and the one remaining test_* method is camelCase (KSTD-5-89-11).
- Every exception of config/parity.json gives a reason that begins with a kind that kit defines: the 24 that began with `example:`, `implementation:`, `helper:`, `benchmark:` or no label now begin with `harness:`, `test:`, `fixture:` or `ecosystem:` as their tests are, so `make divergence-check` reports none of them (KSTD-5-12-4).
- The PHP case of a statement whose session the server ended before it ran binds the six-client CFG-15 unit connection-rollback-failed-reports-both-errors for the PHP library and the PHP extension, in place of a unit that bound PHP alone (KSTD-2-11-13-6).
- The found-rows count, the float digits of the Rust client and the SQLite path of the Rust build tool take the place that P32 gives them: CFG-10 is cited by the MySQL conformance suite, whose affected_counts vector checks the found row in every client; CFG-32 names the polyspec-orm crate, which owns rust-postgres-float-round-trip; and the Python client-flag check and the Rust tool path check are plain tests of their packages (KSTD-2-11-13-4).
- The Rust unit rust-statement-timeout-bounds-sqlite-lock-wait, which bound a case removed when the Rust client began to keep the DSN busy_timeout of SQLite, leaves config/parity.json (KSTD-2-11-13-5).
- The session state of a transaction ends with the transaction in every client (CFG-30): connection-transaction-session-state-ends binds the Go case of a canceled transaction and new cases in TypeScript, Python, the PHP library, the PHP extension and Rust, which read the server session after a committed lock and local value on SQLite, MySQL and PostgreSQL (KSTD-2-11-13-7).
- KSTD-5-89-9: Static `var/tools/bin/node scripts/features/check.mts` reports 21 feature contracts and 0 errors on the completed inventory; source `9b5a` resolves the missing test files. The DSL-76 shared case also passed twice on all six clients across MySQL, PostgreSQL and SQLite (`058143`).
- KSTD-5-89-10: Implementation-internal tests are declared in each implementation's `internal` list and excluded from shared feature ownership. The languages owner unit passed 13 cases; its stale Go MySQL-only fixture expectation was corrected to match the existing DIA-20/21 bindings.
- KSTD-2-11-16-1: PHP library and native extension cancellation now interrupts active statements, rolls back, and preserves root-handle reuse on SQLite, PostgreSQL and MySQL. The library owner passed 7 tests / 61 assertions and the extension owner passed 4 / 44. Raw logs and hashes are recorded in the checklist.
- KSTD-2-11-13: The connection, pool, TLS, DSN and timeout unit bindings are reconciled across six clients in the completed child items; this records their scoped evidence and does not claim that the global parity declaration check passed.
- KSTD-5-89-6: `make link-state-check` passed on main and in a fresh worktree created by Kit K619 link-state-only setup; the temporary worktree was removed. Evidence is recorded in `var/parallel/consolidation/KSTD-5-89-6-link-state/evidence-manifest.txt`.
- KSTD-2-11-13-1-1: The PHP extension's MySQL rollback-failed and savepoint-rollback-failed cases pass on PHP 8.4.26 (2 tests / 19 assertions) with native module `d01c3`. Evidence log SHA-256: `bb75b0c3379bb6f2cb5e7b13c8f0911ec7398db622fafcb08b1442ca8e7f1368`.
- KSTD-2-11-13-3: The primary/replica and replica-write-refusal units now bind native cases across all six clients. Preserved owner logs show MySQL, PostgreSQL and SQLite coverage: Go 3 tests, TypeScript 3, Python 3, PHP 3 tests / 14 assertions, PHP extension 3 / 14, and Rust 3.
- KSTD-2-11-15-2: `generated-field-types-follow-runtime-model` now binds native generated-field type tests in all six clients for INT-2 to INT-8; the existing Go generator unit remains bound to INT-12. Source: `56f5a226d`.
- KSTD-2-11-15-1: The six native generator owners reject the DSL-129 generated-method name collision. Focused owner evidence on source `56f5a226d`: Go 2 cases, Python 2, PHP generator 1 test / 3 assertions, PHP library 1 / 13, PHP extension 2 / 19, TypeScript 2 and Rust 2. Remaining global parity findings are tracked in KSTD-2.
- T182-6-17: The selected 13 relations and explicit root-page vectors matched across all six clients on MySQL, PostgreSQL and SQLite in two runs per database. The enclosing command later exited 2 in a separate PHP-extension interface-symbol snapshot check; the selected conformance result passed. Evidence log SHA-256: `3faeba3aaa6d32cab85a743eba767240ef3fcb0cd1dc46dce4a12c87aee351ff`.
- KSTD-7-5: The model query and write PHP-extension owners pass their focused cases; the extension conformance owner passes all 59 vectors on three databases. All three feature statuses are implemented. The global parity declaration findings remain tracked separately in KSTD-2.
- KSTD-7-5-1: `audit_lazy` passed two matching runs for the five non-extension clients on all three databases; the PHP-extension owner passed the 59-vector set on MySQL, PostgreSQL and SQLite (3 tests / 183 assertions).
- KSTD-2-10-1: The selected `delete_lock` conformance vector passed twice across all six clients on MySQL, PostgreSQL and SQLite. The selected three-vector record/recheck is recorded in the checklist; the later interface-snapshot check was fixed by six official recorders in f57610f9f.
- KSTD-5-2: `make test-markers-check` passed; it reports that no test is skipped or narrowed by a marker. Evidence log SHA-256: `31d20ca4fc256f1a710dd1f2e2baa3147fb5d9d162bfb8667bcb6d88fc64ff9b`.
- KSTD-5-88: The initial runner-check run passed 58/60 cases; after f315de4e5 corrected the runner parts, the two affected cases passed 2/2. The full target was not rerun.
- KSTD-5-88-12: All JavaScript tests now declare cases through caseTest; the exact repository guard passes (1/1), and the preserved combined guard record shows both JavaScript items passing (2/2).
- KSTD-5-88-14: Every TypeScript test that a check runs reports its cases through `tests/testcase.mts`; the exact owner selector `node --test --test-name-pattern='every PHP and TypeScript test that a check runs reports its cases' scripts/repo/check.test.mts` passed (1/1), and the preserved combined guard record `var/parallel/resume-landing/kstd-5-88-js-green.log` reports both JavaScript items passing (2/2) (KSTD-5-88-14).
- KSTD-5-88-17: The four declared PHP DB checks pass in extension mode. The erroneous SQLite statement-timeout listing was corrected to the existing SQLite busy-timeout owner, which passes 1 test / 5 assertions.
- KSTD-5-88-16: ModelTest::testConnectionTimeZone passes on all 15 provider datasets in both PHP modes; each lane ran 15 tests / 90 assertions on PHP 8.4.26.
- KSTD-5-89-7: TypeScript hot-path latency now converts nanoseconds to microseconds. The formatter unit and CI owner-target scheduling checks each passed (1/1); no database benchmark was run.
- KSTD-5-88-13: all 12 Rust tests now start their own polyspec_orm_testcase case; the repository guard passes (1/1).
- KSTD-2-11-8-1: Rust model generation matches the build: the focused case passes and confirms two fresh generations and the model, manifest and external text from `OUT_DIR` are equal (1 test passed).
- KSTD-7-7: All six catalog clients have owner cases for catalog reads and row mutations. Go, PHP library, PHP extension, Python and Rust passed both cases twice on MySQL, PostgreSQL and SQLite with unchanged state digests. TypeScript's grouped owner now consumes each declared database item; its read cases and MySQL row mutation produced passing case events, and the PostgreSQL and SQLite row-mutation selections passed twice each with stable state. The TypeScript dialect-placeholder and SQLite lock fixes are in 7029645ee; Python per-database bindings are in 2023d9bb1.
- KSTD-7-4: the PHP extension implements the shared DSN, transaction, statement-event, audit, request-hook, and constraint/relation features. Its coverage owners passed twice per database on MySQL, PostgreSQL and SQLite with unchanged state digests; native TLS, SQLite busy-timeout/read-during-write, and transaction-failure checks passed.
- T238: remove the obsolete worktree-prune import and prune-only cases; retain the isolated WORKTREE_STOP declaration test (1/1 passed).
- KSTD-5-89-4: classify the remaining ten repository tool sources; `make rebuild-check` passes without excluding a selected tool.
- KSTD-7-1: the PHP extension implements schema installation, model generation and the interface contract. At PHP 8.4.26, its schema-install owner passed the existing, partial and external-document cases twice each on MySQL, PostgreSQL and SQLite (18 database-case executions); every per-database before/after state digest matched. The model-generation and interface-symbol native owner cases each passed twice. The feature-unit-check component results passed, including the corrected PHP scan-path owner case (1/1).
- T182-6-19 is complete at main 8c28c87b3: `make model-native-php-extension-check` passed on PHP 8.4.26 with 97 native tests / 1,348 assertions, 3 declaration tests / 8 assertions, and 5 PHP library tests / 48 assertions; the `--without-library packages/php` guard passed. The fake Flowmark protocol path is covered; no real Flowmark server or MySQL/PostgreSQL/SQLite feature matrix was run.
- The PHP extension implements Bytes, Transform, Decimal, Go, GoMap, Subscription and Notification as native classes; `testPublicValueClassesAreNative` passes on PHP 8.4.26 (T182-6-19-5).
- PHP `orm-gen` is a separate Composer package requiring the runtime library, and extension model tests now consume CLI-generated models rather than calling Generator in-process; the focused package and native owner checks pass (T182-6-19-4).
- The PHP extension implements Dbspec\Meet as a native class; the focused native owner test `testDbspecMeetIsNative` passes (T182-6-19-3).
- The PHP extension implements Config, Dialect, ParamCheck, TxFrame and DbState natively; `testConfigDialectAndFramesAreNative` passes on PHP 8.4.26 (T182-6-19-2).
- The PHP extension implements Engine and Assemble in C; the focused native owner test `testEngineAndAssembleAreNative` passes on PHP 8.4.26 (T182-6-19-1).
- The native `Orm::connectSchema` of the PHP extension opens a `markdown://` DSN through the markdown IR executor, as `Orm::connect` does, so a generated markdown model connects in extension mode; the native write case stops its fake markdown server when connect fails, and `make model-native-php-extension-check` ends again (T182-6-20).
- KSTD-7-3-3: Go, TypeScript, Python and Rust split oversized root IN lists before planning. The focused SQLite test for 70300 values passes on commit `431496ef9e72e5520b730ff02ad1511f5d11e4a1`: Go allocated 86.5 MB, TypeScript peak RSS rose 52.0 MB, Python traced peak was 36.8 MB, and Rust returned the two matching rows without a cached plan exceeding 999 bind slots.
- KSTD-5-90: conformance-check RECORD=1 passes all six implementation outputs, php-extension included, to record (KSTD-5-90)
- The PHP extension implements native planner, parameter-chunking and composite-key behavior through its declared owners; focused native cases cover root IN splitting, relation chunk padding, composite relations, tuple predicates and composite pages (KSTD-7-3).
- The PHP client and the PHP extension split a root IN list over the bind limit before they plan it: a read or count plans the request with that list cut to its first value, takes the bind count from it, and plans each part within the limit, so no plan holds a bind slot per value. A count of 70300 values on SQLite held 113 MB with the extension and now stays under 32 MB, within the default memory_limit of 128 MB (KSTD-7-3-2). Red: the new case of ParameterChunkingNativeTest ended with Allowed memory size of 134217728 bytes exhausted in Engine.php.
- Every case of a PHP library coverage owner selects a method its test class declares: the owners of planner, authenticated_encryption, parameter_chunking and constraints_and_relations name the camelCase methods in a symbols map, and scripts/features/coverage.test.mts fails on a case whose method the class, its parent or its traits lack (KSTD-7-3-1). Red: the new case listed the test_<id> methods of those four owners, for which PHPUnit ran no test.
- The generator units bind each language's native form of the generator rules: 19 neutral units bind the scan, set-file, check, column-name, external-table, typed-getter, time-setter and chain-method rules in all six clients, with new Go, TypeScript, PHP, Python and Rust tests where a client had none, and the units of one language's own generator rule (DSL-39 to DSL-43, DSL-9, DSL-117, DSL-156, SCH-2) (29 units) are scoped to that language's package, which those rules now name. DSL-129 and the value type table remain as KSTD-2-11-15-1 and KSTD-2-11-15-2 (KSTD-2-11-15).
- Every feature-coverage case is one neutral unit bound to the coverage test of all six clients: the last 15 cases (model generation check, statement events, conformance vector, seven schema definition and five authenticated encryption cases) get their units, each test names the requirement it checks, and the Go generated-model DSN case joins the DSN unit. The performance gate cases, which check measurements and cite no rule, are harness tests in every client (KSTD-2-11-8).
- The PHP plan and statement caches now bound their aggregate retained placeholders to 65,535, evict least-recently-used entries, and avoid retaining a single over-bound plan or statement. Cache hits and recompilation preserve the same plan and statement results (KSTD-7-3-4).
- KSTD-5-91: with RECORD=1, conformance-check records the new vectors before conformance-result-check, so a vector needs no dialect entries before its first run (KSTD-5-91)
- `Registry::model` of the PHP extension no longer releases an uninitialized argument when no model class is registered for a manifest hash, which crashed PHP (SIGBUS) after repeated `Registry::generated` and `Registry::model` calls (T182-6-18-1).
- Rust clippy and the TypeScript interface extractor run under their target leases and `run-long`, as does the Rust dbspec helper build; the focused lifetime and lease cases pass 3/3 (KSTD-5-88-18).
- RuntimeDbTest and AuditExternalSetsTest use a bootstrap-loaded provider trait, so PHPUnit can discover each file on its own; the focused `--list-tests` command discovers 19 cases (KSTD-5-88-15).
- `make layout-check` passes: the root test directories are classified as repository-tool tests, Python recipes use the package environment, and cross-language PHP/JavaScript fixtures have explicit S9 reasons (KSTD-5-89-5).
- orm-gen makes the temporary directory of a Go generation in the system temporary directory, so no unfinished `.orm-gen-` folder appears beside its output and a land no longer finds the main checkout dirty while another land builds it (KSTD-5-88-19).
- `make client-db-check` runs the php-extension lane that config/parity.json declares: it builds the extension and runs the PHP database test files with it loaded, instead of failing before any lane runs (KSTD-5-88-6).
- generator-consumer-check, native-error-cause-check, transaction-failure-rust-check, complex-query-rust-check and page-cache-unit-check run each independent test as a part of its own, so a failed test no longer stops the others (KSTD-5-88-10).
- The type check of the TypeScript interface extractor states `--noEmit` on its command line, so the publish case of `make repo-check` no longer reads it as a build into dist (KSTD-5-88-11).
- The flowmark source checkout that markdown-table-check reads is a tool download under var/tools, and the three recipes that built the TypeScript client before holding it start with `$(HOLD_TYPESCRIPT)`, so the run-directory case of `make repo-check` passes (KSTD-5-88-9).
- The CPX-2 Python Makefile recipes use shell-valid environment assignments and required-variable guards, so the repository shell parser accepts them and missing fixture DSNs still name their setup command (KSTD-5-88-8).
- The lease case of `make orm-test-servers-check` runs scripts/test-servers.mts with the tests/errors.mts it imports, so it checks the refused stop again instead of failing on a missing module (KSTD-5-88-7).
- The test servers keep small logs: both mysqld take a 16 MiB redo log capacity, a 16 MiB undo truncation size and 16 MiB binary log files, and both PostgreSQL servers min_wal_size=32MB, max_wal_size=64MB and wal_keep_size=0. A fresh .runtime/servers takes 377 MB instead of 545 MB, and 473 MB instead of 1217 MB after one run's databases were created and dropped; replication through the slot orm_replica and remote_apply is unchanged (KSTD-5-88-5).
- `make lint-php` passes: the PHP code meets the pinned PHPCS layout, class and method-name rules, and PHPStan checks for both the library and extension (KSTD-5-89-3).
- PHPUnit test method names conform to camelCase; PHP parity and feature bindings point to each renamed method while shared case IDs remain unchanged (KSTD-5-89-3-3).
- The 16 streamWrapper fixture methods of the PHP tests keep the names that PHP's streamWrapper protocol requires, each with the reasoned phpcs:ignore of CamelCapsMethodName that suppression-check accepts, so `make lint-php` passes (KSTD-5-89-3-4).
- Every PHP test file declares one class in a namespace and causes no side effect: each helper class of the PHP and extension tests has a file of its own, and the files a test required at its top are required once by the bootstrap of its package (KSTD-5-89-3-2).
- phpcs reports no layout finding in the PHP of orm: phpcbf fixed braces, spacing, inline control structures and call signatures, long calls, arrays, strings and comments are wrapped at 120 characters, and the silenced @unlink and @trigger_error calls are a file_exists check and an error_reporting(0) scope (KSTD-5-89-3-1).
- Every catch clause of the TypeScript client, the scripts and the tests binds its error and narrows it to the failure it expects, rethrowing the rest, so `make lint-ts` passes on main; the red was `make lint-ts` exit 2 at `168ae591238d` with 23 bindingless catches (KSTD-5-92).
- duplication-check passes: the generated models are build output and the repeated code of the implementations moved into shared modules, so `make duplication-check` finds no clone (KSTD-5-5).
- `make duplication-check` exits 0 with zero clones of 6 or more lines across the whole tree, in all seven formats it reads (KSTD-5-46).
- `make duplication-check` finds no clone: each `@param` of the apply, recover, rollback and finalize operations of the PHP `Dbspec` and `PlanApply` says what its argument is for that operation, so the four docblocks no longer end in the same six lines; no public name, signature or extension stub changes (KSTD-5-46-3).
- KSTD-5-90: conformance-check RECORD=1 passes all six implementation outputs, php-extension included, to record (KSTD-5-90)
- The request hook, audit, soft delete, restore and clock units are six-client units: their 26 units report no declaration finding, and the native request hook and audit cases of the PHP extension pass (KSTD-2-11-12).
- The PHP extension request hook test names the requirements of the insert assignment case it inherits; the focused parity declaration and native binding checks pass (KSTD-2-11-12-4).
- relation() and relations() under a service scope run in every client as the request hook case relation_scope, bound by coverage-request-hook-relation-scope. The CONFIG failure that the consumer reported does not reproduce on current main: its canister conformance passes 101 of 101 cases with the relation calls under its ScopeHook, and the earlier cause is not proven (T203).
- KSTD-5-90: conformance-check RECORD=1 passes all six implementation outputs, php-extension included, to record (KSTD-5-90)
- `tsc .` type-checks the kit sources that orm imports again: kit K574 links the dependencies that a linked package adds, so `make link` installs node_modules/@types/picomatch beside the file links of kit, and `make lint-ts` no longer fails on TS7016 for picomatch (KSTD-5-89-8).
- `make lint-python` passes on main: `ruff format` reformats the six Python files that `ruff format --check` reported, with no change to their syntax tree (KSTD-5-89-1).
- KSTD-5-90: conformance-check RECORD=1 passes all six implementation outputs, php-extension included, to record (KSTD-5-90)
- The two drop cases of `scripts/check/continue.test.mts` expect the drops of the 18 complex-query fixture databases that `databases.mts drop` runs before the bench and decimal databases, so they pass again (KSTD-2-9-13-2).
- On MySQL the PHP client and the PHP extension bind each int and bool of a statement as `PDO::PARAM_INT`, so the root page `LIMIT` and `OFFSET` of `limit(offset, count)` reach MySQL as numbers. The emulated prepare of MySQL quoted every value that `execute()` received, and since the page values became the parameters `offset_p` and `count_p` (PRT-78) MySQL answered 1064 near `''0', '3''`; the model_queries owners of both clients pass on MySQL again (T182-6-16).
- `OrmException::fromDriver` of the PHP extension no longer corrupts the Zend heap: it released the `rv` zval of `zend_read_property` for `errorInfo`, which the read never writes for a declared property, so a release build freed an uninitialized stack value; it now copies the value it reads and releases only what it owns. The native writes of model_writes, statement_events, audit_triggers and constraints_and_relations run again on MySQL, PostgreSQL and SQLite (T182-6-18).
- The Go and Rust restore, audit record and soft delete read cases bind three six-client units citing INT-38, CFG-8 with INT-44, and DBS-67, beside the audit trigger coverage cases of the other clients; the five units that bound one client each are gone (KSTD-2-11-12-3).
- The clock of the update time, the soft deletion and the now condition has three six-client units citing DIA-18, DIA-56 and DSL-137 in place of thirteen units that each bound one client. Python runs the clock cases on SQLite, MySQL and PostgreSQL, and the TypeScript clock cases are bound instead of declared internal (KSTD-2-11-12-2).
- The PHP extension audit tests name the requirements of the audit history, audit transaction entry point, soft delete restore and selected column cases they inherit from the PHP library, which they pass on SQLite with the extension loaded (KSTD-2-11-12-1).
- The Go context and Rust drop cases of handle abandonment bind only the six-client handle-disposal units; the three units that repeated them for one client are gone (KSTD-2-11-16-2).
- Eleven connection units that each bound one client are gone: their constraint classification, DSN parameter, MySQL session and pool option cases are bindings of the six-client units that test the same rule, and CFG-20, the parameters beyond the shared list, has a six-client unit of its own (KSTD-2-11-13-2).
- The parts case of `make runner-check` expects the sixteen parts of client-unit-check that the Makefile declares, code-catalog, insert-parts and dbspec-runners included (KSTD-5-88-4).
- `make databases-create` provisions the 18 complex-query fixture databases only for a run that reads them: the runner asks for them when a target declares the need complex-query, and `make owner-check` when a selected owner part reads a COMPLEX_QUERY_*_DSN or a selected target needs it. Each stays run-owned and is dropped with the run, and a reader of a missing fixture DSN names the setup that provisions it (KSTD-2-9-13-3).
- `make databases-create` seeds the complex-query PostgreSQL fixtures again: psql connects through the run DSN without the client-only `timezone` parameter, which it refused with `invalid URI query parameter "timezone"`, so a run can create its databases. The decimal type check uses the same DSN (KSTD-2-9-13-1).
- The make -k case of `make runner-check` runs version-check with the RUN_TESTS definition of the Makefile and expects its real unit line, `run-tests.mjs node -- scripts/version/check.test.mts`, in place of the `node --test` line that run-tests replaced (KSTD-5-88-3).
- The lane-name case of `make runner-check` expects the client-db-test lanes that config/parity.json declares, go, php, php-extension, typescript, python and rust, in both refusal messages, in place of the old list of four (KSTD-5-88-2).
- The continuation case of `make runner-check` for scripts/perf-test.mts expects its five gate commands by name: the Go native, hot-path and coverage gates and PerfGateTest without and under CPU load, in place of the count of four that the coverage gate made stale (KSTD-5-88-1).
- A transaction or savepoint whose callback and rollback both fail has one six-client unit each, citing CFG-15, in place of ten units that each bound one client. Python runs the cases on SQLite, MySQL and PostgreSQL, and on PostgreSQL it now reports CONNECTION_LOST instead of the OperationalError of psycopg when the server ended the session before the cursor opened (KSTD-2-11-13-1).
- `make feature-unit-check` passes on main again: scripts/features/coverage.test.mts expects the requirements that config/parity.json binds to the catalog parity units (SCH-6a, INT-113 and INT-114 for catalog-connection-read; SCH-6a, INT-109 and INT-123 for catalog-connection-row-mutation), and the generation-scan-parity-php verification of model_generation no longer declares packages/php/tests/OrmGenTestSupport.php, a path of the helper phpstan-test-runner, as an input (KSTD-7-9-2). Red: the catalog case of coverage.test.mts and the helper-input case of owners.test.mts failed on main.
- CPX-2 states the complex query example on the fixture `contracts/fixtures/complex_query`, which every implementation runs: eight ordered statements on MySQL and PostgreSQL and an `OPERATOR_NOT_ALLOWED` refusal before any statement on SQLite. The Go and TypeScript cases name CPX-2, and the TypeScript case imports the `assert` it passes to the shared check (KSTD-2-9-13).
- The Rust codec, driver, Markdown and build error paths keep the native cause in their messages. `make rust-causes-check` passes (ORM 6/6, build 14/14), and the database caller cases `tool_cells`, `grid_cells`, `grid_numbers`, `grid_decimals` and `grid_temporal` pass on SQLite, MySQL and PostgreSQL test servers; the red was `make rust-causes-check` exit 2 at `e555f7f87e9e` (KSTD-5-71).
- `make kit-check` passes on main, confirming CHECK_TARGETS includes every Kit gate and the vendored files match Kit 0.0.54 (KSTD-5-11).
- Main now passes `make kit-check`: the parity requirements, CHECK_TARGETS registrations, absolute tool paths, and vendored copies match Kit 0.0.54. The focused CI target-distribution case also passes 1/1 (KSTD-12).
- The selected PHP extension bootstrap test now runs from the root Composer vendor without PHPUnit discovering a trait-only `*Test.php` file. The timed Dbspec trait lives in `DbspecTimedCases.php`, and its imports, bootstrap include, and feature owner input name that helper. The pre-fix gate run at `3cd748f44648` failed on the discovery warning; the focused test passes 1 test / 5 assertions with the extension loaded (KSTD-5-10).
- The native driver-error cause, lossless row-byte cell, and Markdown connect-refusal behaviors each have one neutral six-client unit, backed by 18 exact native cases. The Rust byte case crosses SQLx row decoding, and Markdown refusal is exercised through native `Orm::connect`. The narrow official RED replay of the historical five-client Markdown declaration reported the missing PHP-extension binding (KSTD-2-11-17).
- The transaction failure units for rollback, rollback faults, and failed savepoint end have executable bindings across all six clients. Focused native cases pass. Go's public nested-transaction test covers failed savepoint rollback and release and names DIA-181 and PLN-17 (KSTD-2-11-11).
- The dbspec set-reader requirements DBS-12 through DBS-15 are explicit requirement bullets, and DIA-198 has one six-runtime query-count unit with native SQLite-memory cases. The focused owner checks and scoped declarations pass; the pre-fix RED replay used the exact `config/parity.json` input from `c3bd1a817` at current test sources, and exposed five missing runtime bindings (KSTD-2-9).
- The PHP extension now tags SQLite row-lock write events with their transaction ID. The focused native transaction test verifies repeated transactions (KSTD-7-5-2).
- The 63 named client API units are checked against their exact INT or COD requirement bullets in both specification languages. The focused requirement test passed 1/1; its RED replay used the exact pre-fix config and specification inputs from `694ca3a35^` while retaining the current test and runtime (KSTD-2-11-7-1).
- All 82 logical interface rules now name an exported PHP extension symbol with a signature matching its generated extension snapshot. The contract validator checks each rule against PHP input and output types and validates the extension separately from the five client language mutation cases. The focused logical drift unit passes (KSTD-2-3).
- Native PHP extension API precedence now matches the client: schema evolution checks external documents before planning and uses SQLite `BEGIN IMMEDIATE` without creating row-lock state; schema names escape literal underscores; Schema, Config, Model and AesKeyring arguments fail at the declared boundary. SQLite cleanup preserves both failures and rolls back when a BEGIN observer fails; transaction-inspection failures propagate while foreign-key restoration runs. Eleven focused native cases pass (76 assertions), and the API binding unit and official extension extractor pass (KSTD-2-11-7).
- The 56-case markdown corpus now covers codec-column and explicit-selection behavior for DIA-175 and DIA-177 across all six clients. PHP extension cases run the generated Model through native C methods; the Flowmark pin uses its `packages/go` module and matching documentation source (KSTD-2-10-3).
- The API parity check binds all 77 error-code units to the PHP extension's native `Code` constants and checks each against the generated stub catalog. Its RED was a fixture replay of `config/parity.json` blob `845da3a77ac511ee6fb144e6d097b53d49499b4f` from `f69b3a2f1^`, not a run of that historical checkout; the replay reported 43 units for 77 catalog codes (KSTD-2-4).
- Rust compiler fixtures compile positive generated-model and DSL consumers and reject private-field access and invalid DSL calls with the expected rustc diagnostics. Ten fixtures cover DSL-49, DSL-50, and DSL-124 (KSTD-2-10-5).
- Each client package now has a database-free native entry-point case for its declared public surface. The six client targets and `make package-check` pass; declaration checks cover INT-93, INT-138, and the affected R12 disposal units (KSTD-2-11-18).
- Rust lint now passes the benchmark, package-workspace, interface-symbols, and catch-check steps. The canonical pre-fix run at `6e0b129d6c57` failed all four steps on the original lint findings; the committed tree passes `make lint-rust` without suppressions (KSTD-5-41).
- Go lint now passes across the repository. The historical canonical run at `b45468a36e63` reported 11 errcheck findings and one deadcode finding; the current checker evaluates build-tag reachability as a union. Database-free catalog session cases verify that primary and rollback driver causes remain discoverable through `errors.Is` (KSTD-5-42).
- The case-database crate now propagates all six clippy-reported failures through `Result` without suppressions. The canonical strict clippy target fails on the actual pre-fix source at `e9617f4f967f` and passes on the committed fixed source (KSTD-5-41-1).
- The PHP extension generates arginfo offline in a temporary build copy and declares its native readonly `Stats` class. The official pre-fix run at `336699563b61` failed the focused declaration checks because the extension did not declare `Stats`; on the committed source, arginfo/build verification passes 42 tests (589 assertions) and declaration verification passes 8 tests (22 assertions) (T182-6-15).
- The Kit Standard checklists render `<gate>`, `min-0-max <max@blue.tools>`, and `Collection<X>` literally instead of letting VitePress parse them as HTML. A focused Markdown renderer case checks both checklists and preserves the `Refines <id>:` example (KSTD-5-87).
- The PHP `Validator::functionType` declaration again matches the native two-argument contract. Planner, Markdown, and parameter-use callers keep the entity.column `INTERNAL` check before typing, while public unknown-column validation remains `COLUMN_UNKNOWN`. The actual-main declaration regression found the four-versus-two mismatch before the PHP fix (KSTD-5-63-1-1).
- Result-shape coverage binds five neutral product behaviors across all six clients: styled-column states including unselected, SQL NULL and encoded null; invalid stored grouped booleans (`CODEC_DECODE`); exact grouped i64 values; exact nonnegative row counts (`CODEC_DECODE`, with missing `row_count` as `INTERNAL`); and ordered-json Model output text preserving key order and stored number spelling. The five TypeScript conformance-result checks remain host-specific COD/helper tests, and two historical Rust invalid-result conformance-helper bindings remain removed. The focused result targets cover the five behaviors; the Python conformance encoder helper has a separate self-test. (KSTD-2-11-14)
- Root pages reject malformed or unsafe offset/count values before reusing a cached plan (T236).
- Column-function callers now return `INTERNAL` naming the missing source field after validation; public validation still returns `COLUMN_UNKNOWN`, and valid function result types and parameter uses are preserved. The actual pre-fix main regression at `cca1851d37ec` failed both predicate and selection planner cases. On source commit `1f2def8c6919`, `make item-test ID=KSTD-5-63-1` passes Go planner and IR (1 each), Rust (3), TypeScript (4), PHP (3 tests, 17 assertions), Python (2), and PHP extension mode (3 PHP tests, 17 assertions; 3 native tests, 29 assertions) (KSTD-5-63-1).
- The PHP extension declaration checks now exclude `CatalogDocumentBuildException` as an internal catalog-building helper while keeping the public PHP `Catalog` connection available. The actual pre-fix client declaration map included the helper at main source `27716799b`. On source commit `ba06f0adb`, extension declarations pass (6 tests, 15 assertions) and the native Mermaid boundary controls pass (2 tests, 4 assertions) (KSTD-5-62-1).
- Dbspec verification now distinguishes a real schema mismatch from catalog or driver failures across Go, PHP, the PHP extension, Python, Rust and TypeScript. Verification failures retain their original cause; a failed post-forward verification does not mark apply history successful. The focused database-free fake-driver target covers settled and rollback verification failures, post-forward failure state, and a genuine mismatch across all six implementations. On main source `fc50349c19be`, the exact Go regression failed on original source `67aee14d481e` in both settled and rollback paths (KSTD-5-61).
- Mermaid imports now convert only the catalog's generated-document build failure into a line-1 diagnostic; other catalog exceptions escape with their original identity. On commit `6dabce876bf8`, the focused targets pass TypeScript (2 cases), Python (2), PHP (2) and the native PHP extension (2). The extension cases build a test-only module that calls the production Mermaid boundary. The canonical pre-fix run on `48b4f552b028` failed all four targets on unexpected-error identity (KSTD-5-62).
- Every code in `docs/spec/errors.yaml` now has one API unit in `config/parity.json`, with one matching catalog symbol per implementation. The API checker on pre-fix main HEAD `48b4f552b028` reported 43 units for 77 codes. The committed focused verification passes all 5 cases and checks 77 codes against 77 units (KSTD-7-10).
- SQLite NOWAIT locking now restores the prior `busy_timeout` after setup, lock-table, or lock failures. Only lock-acquisition `SQLITE_BUSY` maps to `LOCK_NOT_AVAILABLE`; cleanup failures preserve the primary error code and both causes, while single failures retain their original error. The actual pre-fix main RED at `68f414329ab9` failed the focused six-client target. Committed `make item-test ID=KSTD-5-59` passes Go (2 tests), TypeScript (1), PHP (1 test, 18 assertions), PHP extension (1 test, 18 assertions), Python (2, including `BaseException` restoration), and Rust (2). The PHP extension uses the userland `OrmException::withCleanup` contract (KSTD-5-59).
- Scalar-subquery planner and markdown result assembly now report `INTERNAL` with the missing entity or column instead of inventing a result type. The canonical native owner target failed on the actual pre-fix sources at `0898f6f16287` and passes on the fix: Go (2 tests), Rust planner and markdown (4 tests), TypeScript selected cases, PHP (2 tests), Python (1 test with 4 dialect subcases), and PHP extension (2 tests). Count remains `i64`, avg remains `f64` (KSTD-5-63).
- PHP and native C Codec now wrap only expected YAML/JSON codec failures and preserve the exact cause object; unexpected RuntimeException, TypeError and Error propagate unchanged. On PHP 8.4.26, committed main `9af48c4ab` passes `make php-codec-causes-check`: 8 focused tests (102 assertions) across source and native extension. Before the fix at `382a7754552a`, the focused target failed because YAML/JSON wrappers dropped causes and YAML probes changed unexpected throwable identity (KSTD-5-77).
- SQLite `BEGIN EXCLUSIVE` failures are classified as `locked` only for primary result codes `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6), including extended codes. Other driver errors retain their original causes. On main fix commit `e8c2fef66128`, the focused database-free targets pass Go (2), PHP (2 tests, 23 assertions), PHP extension (2 tests, 23 assertions), Python (2), Rust (1), and TypeScript (2). The canonical six-target RED on actual pre-fix main `4af40c9a20df` failed on non-lock results; the Go fake driver also verifies original error propagation and state restoration (KSTD-5-60).
- Documentation now aligns the enumerated implementations with `config/parity.json` while keeping PHP extension capability claims within verified scope. The selector's four unit cases pass, the focused rule reports no findings across 50 English and 50 Korean documents, and `make docs-check` passes. The focused source RED on pre-fix main `0898f6f1` reported 75 findings: 50 count statements, 17 enumerated sets, 6 table headers and 2 protocol rows. PHP extension catalog gaps remain under KSTD-7-7 (KSTD-2-2).
- Rust upsert planning now propagates conflict-key validation errors instead of rendering an empty conflict target. Direct native `Planner::compile` cases verify `ENTITY_UNKNOWN`, missing-key and ambiguous primary-plus-unique `IR_INVALID` errors, while a fully assigned composite primary key produces its ordered SQL target and binds. The canonical target failed the two swallowed-error cases on pre-fix source at `351422f365d5` (2/4 passed) and passes all four cases on committed main `534b426c603f` (KSTD-5-66).
- Composite collection keys now encode integer, boolean, text, byte and datetime component types with byte-length framing; byte payloads use lowercase hex, and datetime payloads use UTC RFC3339 with trailing fractional zeroes trimmed at host precision. Scalar keys and nullable-row handling are unchanged. On committed main `c28c72d52`, `make item-test ID=T77-6-4` passes TypeScript 2, Go 3, PHP 3 (156 assertions), PHP extension 3 (153 assertions), Python 3 and Rust 3. The actual pre-fix main run failed the false/text collision in TypeScript, PHP, PHP extension, Python and Rust; three raw-byte cases in Go; and `.123400` formatting in PHP, PHP extension, Python and Rust. Shared millisecond vectors cover `.120`, `.010`, `.000`, multibyte and embedded-NUL text, while microsecond checks preserve host precision (T77-6-4).
- Rust rejects temporal precision outside 0..6 as `SCHEMA_INVALID` before binding values, including NULL and dotless input. Excess nonzero fraction digits remain `CODEC_ENCODE`, trailing zeroes are accepted, and valid executor clock truncation is unchanged. The focused native test failed on pre-fix `aca190bfb927` and passes 3/3 with `make item-test ID=KSTD-5-68` on `d84a4547407d` (KSTD-5-68).
- Rust relation execution now rejects relation steps with zero or multiple parent bind slots as `IR_INVALID` before executing a query (KSTD-5-67).
  The native target's four malformed-parent assertions failed while its valid scalar/composite control passed at pre-fix `abd38b77eae57fc108311dce4a615fccd6392161`; committed implementation `e0fe5ae77b451ed5ee38e9b84f270a658810c7b2` passes all five cases with `make item-test ID=KSTD-5-67`, including the completion run (KSTD-5-67).
- Every client now rejects SQL NULL at the split-query merge boundary with CODEC_DECODE while preserving valid falsey keys. General nullable row-key handling remains unchanged for joins. `make item-test ID=KSTD-5-50-1` passes Go (1), PHP (1 test, 29 assertions), PHP extension (1 test, 7 assertions), TypeScript (2), Python (2) and Rust (1) focused cases. (KSTD-5-50-1)
- The native PHP extension treats a null transaction audit as pending, so the first audited write inserts its audit record. The focused fake-PDO regression fails with the original guard before any prepared SQL and passes under `make item-test ID=KSTD-7-5-1-1` on PHP 8.4.26 (1 test, 11 assertions; 3 declaration tests, 8 assertions; 10 PHP source comparison tests, 68 assertions) (KSTD-7-5-1-1).
- Rust build generation now resolves relative set, scan, and explicit output paths from `CARGO_MANIFEST_DIR`. It reports an actionable error when that variable is required but missing or relative, while absolute paths remain usable without it and implicit `OUT_DIR` behavior is unchanged. The focused native environment unit passes 1 test across 7 isolated subprocess scenarios (KSTD-5-70).
- Rust build scanning now propagates its actionable missing `OUT_DIR` error instead of scanning with an empty model output path. `make rust-build-outdir-check` passes 1 native test, including valid `OUT_DIR` and explicit `out_dir` controls; on pre-fix `60604e714189`, the missing-variable assertion failed (KSTD-5-65).
- TypeScript and Rust now require three or four ASCII decimal u32 components for the native SQLite version, compare numerically against 3.46.0, and report malformed raw values as INTERNAL before opening SQLite. The committed focused targets pass three unit cases each; on pre-fix 2100937d4, empty input was misclassified and Rust accepted 3.46 (KSTD-5-64).
- The Rust row mapping defect is fixed by the six-client shared blind-index source handling in KSTD-5-49-1; its focused Rust planner check passes (KSTD-5-49).
- Shared blind-index targets now honor an explicit target assignment and reject distinct assigned AES sources when deriving an absent target. Insert and on-duplicate assignments are checked independently, preserving original row parameter offsets. The committed `3c3243761` passes `make item-test ID=KSTD-5-49-1` across Go (6 tests), PHP (7/26), PHP extension (7/26), TypeScript (125), Python (7) and Rust (7); Python regression cases failed on `4b164670` (`var/plan/KSTD-5-49-1.json`) (KSTD-5-49-1).
- The PHP extension now implements the complete runtime Model surface and its native helper classes in C. On committed implementation `24a1e7e`, `make item-test ID=T182-6-14` passes 47 native tests (654 assertions), 3 declaration tests (8 assertions), and 10 PHP source comparison tests (68 assertions) on PHP 8.4.26 (T182-6-14).
- The TypeScript interface extractor now records explicit constructor signatures, including access restrictions, overloads and optional ErrorOptions, without losing class keys or parameter-property fields. On committed implementation `35dae79ed`, `make interface-typescript-extractor-check` passes its compiler check and native case (1/1); the old extractor failed the ErrorOptions assertion (KSTD-5-86).
- PHP relation declaration collection is now case-insensitive like PHP method calls, so uppercase `RELATIONS` retains relation-edge cardinality and CONFIG conflict checks. The focused regression fails before normalization and passes in `b4546a29d` with the relation cases and scan vectors (KSTD-5-84).
- PHP relation getters now use the runtime `Collection<Target>` type for plural relations and preserve the target model type. Alias getter types follow the owning relation edge and its cardinality, independently of the terminal read. Committed implementation `23d83be1a` passes the focused PHPStan consumer, six relation regression cases and two scan vectors; the original consumer case failed against baseline (KSTD-5-83).
- Process cleanup in the step and test-server scripts now treats only ESRCH as gone, preserves cleanup and timeout causes, keeps failed groups tracked, validates PID files before signaling, and stops all servers before deleting their data. On `f718563f3`, `make scripts-typecheck`, `var/tools/bin/node --test scripts/check/step.test.mts` (12/12), and the selected fake-process/FS cases (4/4) pass; before the fix, three step cases and all four selected server cases failed (KSTD-5-78).
- The PHP extension now implements Collection in C and returns a native Iterator from `getIterator()`. `make collection-php-extension-check` passes 19 native tests (212 assertions), three declaration tests (8 assertions), and three PHP library identity tests (82 assertions) on the committed implementation `1d20505db` (T182-6-12).
- The PHP extension now owns the native Request, StyledValue, Page, Func and PendingTime model helper classes. Focused verification passes 12 native surface tests (119 assertions), 5 declaration tests (12 assertions) and 2 PHP source tests (21 assertions) on PHP 8.4.26 (T182-6-13).
- Owner selection now treats only a missing named fixture (`ENOENT`) as optional and propagates other read errors. Database setup validates each action's required DSNs before launching clients and reports the action and repair command. On committed implementation `78329bd0f`, `make item-test ID=KSTD-5-79` passes 26 owner cases and the focused database-configuration case (1/1); the old implementation failed the EISDIR fixture case and omitted action context for missing DSNs (KSTD-5-79).
- TypeScript codec JSON, YAML and UTF-8 failures retain their original causes, while existing `CodecError` instances keep their identity. `make ts-codec-errors-check` passes all six native cases on committed implementation `08dbf4cce`; the old implementation passed the valid-value control and failed the five cause and identity cases (KSTD-5-75).
- TypeScript AES decoding converts only the native final authentication failure to `CODEC_DECODE` and preserves setup, update and unrelated final errors. `make ts-aes-auth-check` passes nine native test events on the committed implementation; before the fix, three passed and the error-preservation group plus five error-origin cases failed (KSTD-5-73).
- PHP `SetReader` now preserves fresh `lstat`, `stat` and `scandir` warnings in set errors, including cached listing failures. `make dbspec-php-check/set` passes 72 existing set cases and seven library-reader diagnostics cases; RED on the prior implementation passed the 72 controls and only the missing-name diagnostic, while six filesystem-failure cases lacked the warning (KSTD-5-76).
- TypeScript `save()` falls back to insert only for its missing-key `OrmError`; an unrelated `CONFIG` thrown while reading a set key reaches the caller. `make ts-save-key-check` passes the three create/update controls and the sentinel error case (KSTD-5-74). Red: the old implementation passed the controls but swallowed the sentinel, failing with `Missing expected rejection`.
- ORM declares `WORKTREE_STOP = orm-test-servers-stop`, so kit worktree cleanup stops its servers before removal. `node --test scripts/repo/worktree-stop.test.mts` passes the Makefile-origin reader, stop-before-removal, and failed-stop preservation cases (T237). Red: the same test on c5755a5ddc46 failed because `stopTargetOf()` returned `undefined`.
- PHP Collection get() and first() preserve the caller's model type in their nullable results. The static CI group checks both lookups with a generic model parameter; unparameterized collection iteration keeps its existing behavior (KSTD-5-82).
- The Rust lint gate now passes all three workspace clippy runs and the Rust catch check, without a suppression. The final catch-check failure is reproduced on the code before f5f9b5993 and the restored tree passes all four steps (KSTD-5-57).
- The unused `AtomicU8` import of `build/tests/lock_probe_order.rs` is dropped, so the clippy gate of `make rust-check` no longer reports `unused_imports` on main (KSTD-5-56). Red: `make rust-check` on 19c5dd83c failed in clippy with `unused_imports` at `build/tests/lock_probe_order.rs:3`.
- Rust clippy passes on main: the `mysql_code_tests` module of `orm/src/lib.rs` is the last item of the file, and the unused `AtomicU8` import of `build/tests/lock_probe_order.rs` is dropped, so `make rust-check` passes (KSTD-5-55) (KSTD-5-56). Red: `make rust-check` on 19c5dd83c failed in clippy with `items_after_test_module` at `orm/src/lib.rs:118` and `unused_imports` at `build/tests/lock_probe_order.rs:3`.
- The lint findings in the tests crate files conformance.rs, integration.rs, decimal_physical.rs and coverage_schema_install.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-24).
- The lint findings in the build table_page.rs and the orm identity_load.rs, soft_delete.rs and dbspec_probe.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-23).
- The lint findings in the tests crate common/mod.rs and the coverage files are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-22).
- The lint findings in the tests crate files bench_set.rs and client_bench.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-21).
- The lint findings in the orm test files value_decode.rs, param_uses.rs and coverage_planner.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-20).
- The lint findings in the tests crate files coverage_schema_install.rs and markdown_conformance.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-18e).
- The lint findings in the build test file lock_probe_order.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-18d).
- The lint findings in the orm test file sqlite_concurrency.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-18c).
- The lint findings in the build test file read_only_query.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-18b).
- The lint findings in the orm test files restore_rows, coverage_audit_triggers and the others outside 13 to 16 are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-18).
- The lint findings in the build test file generate.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-17).
- The lint findings in the orm test files external_documents, rollback, codec_vectors, ir_request and coverage_authenticated_encryption are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-16).
- The lint findings in the test module of the orm tx.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-15).
- The lint findings in the orm test file dbspec_introspect.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-14c).
- The lint findings in the orm test files add_tables_and_columns, dbspec_plan_apply and collection_identity are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-14b).
- The lint findings in the remaining orm test files are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-14).
- The lint findings in the orm test files statement_fault, request_hook and common/audit_rows are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-13).
- The lint findings in the orm test files listen_notify, register, clock and was_inserted are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-12).
- The lint findings in the orm test files revision.rs and statement_events.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-11).
- The lint findings in the other build sources tool_db, catalog and lib are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-10).
- The lint findings in the build generate.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-9).
- The lint findings in the case-database lib.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-8).
- The lint findings in the other orm sources are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-7).
- The lint findings in the orm codec.rs, value.rs and driver.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-6).
- The lint findings in the orm db.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-5).
- The lint findings in the schema test targets dbspec_mermaid, dbspec_set_parse, dbspec_show_create, dbspec_render and common/dbspec_values are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-4).
- The Rust test build of a worktree drops its debug line tables (`debug = 0`), so it is about 27% smaller (4.5 GB to 3.3 GB), while panic and assertion locations keep file:line; main keeps line-tables-only (KSTD-5-85). Red: `make -s print-CARGO_PROFILE_DEV_DEBUG` printed line-tables-only in a worktree.
- The lint findings in the schema parser.rs, literal.rs, set.rs and mermaid.rs, and the interface-symbols binary are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-3).
- The lint findings in the schema introspection mysql.rs, postgres.rs and sqlite.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-2).
- The lint findings in benchmarks driver_compare.rs and native.rs, and the testcase lib.rs are fixed, so `make lint-rust` reports no finding in them (KSTD-5-57-1).
- The lint of `packages/rust/orm/tests/zone.rs` gives the Err branch of the directory helper a statement: a missing directory is ignored and any other error panics with its cause, so the catch check (K537) passes (KSTD-5-57-19). Red: the catch check reported zone.rs:26 as an Err branch with no statement.
- The extension's paramUses gives each row of a multi-row insert the columns at its own positions, so every row's parameters take their own columns, as the PHP path does (KSTD-5-80). Red: MarkdownTest::testParamUses reported the rows as owner, owner, owner and title, title, title.
- `testLimitColumnsPeak` parses the limit/columns document in a process of its own with PHP's default memory limit, so its bound no longer depends on the memory that the test run holds before it (KSTD-5-58). Red: holding 88 MB before the same parse gave a negative bound and failed (`testLimitColumnsPeakAfterHeldMemory`).
- The `Collection` template has no default bound to the base `Model`, so a raw `Collection` parameter no longer makes PHPStan report a false `method.notFound` on its rows; the typed `gets(): Collection<Model>` path is unchanged. `make collection-raw-phpstan-check` runs PHPStan at level 5 over that fixture (KSTD-5-54). Red: the fixture reported `Call to an undefined method Polyspec\Orm\Model::getSeq()`.
- `GroupRows::getIterator()` is documented to yield `GroupRow`, so a caller of its rows gets typed rows and not mixed; `make group-rows-phpstan-check` runs PHPStan at level 9 over a fixture that calls a method on each row (KSTD-5-53). Red: the fixture reported `Cannot call method toArray() on mixed`.
- PHP model getters declare the type of their target instead of `mixed`: a relation getter is `?Model` (`get<Entity>Model`) or `list<Model>` (`get<Entity>Models`); an alias, new or addColumn getter takes the type its call declares, a literal or a typed parameter for new and a closure's return type for addColumn, and an alias takes the chain's result. A call with no declared type is refused with a CONFIG error that names it (KSTD-5-52). Red: the getter-type vectors of tests/generator/php-scan-vectors.json declared `mixed`.
- The owner selection hands a changed Go, Rust, Python, PHP or TypeScript path to its lint target (`lint-go`, `lint-rust`, `lint-python`, `lint-php`, `lint-ts`), so `make land` runs the lint of a branch that changes the language and refuses a new finding (KSTD-5-47). Red: the owners test case `a changed path selects the lint target of its language` failed on the old config with `packages/go/orm/errs.go selects feature-owner-check, not lint-go`. The real Go errcheck gate was not run here, since golangci-lint is not installed in this environment, so a Go finding was not refused by `lint-go` in a land.
- The Python schema install test installs the external document of the bench set (bench_shared.dbs) before the set, as the set requires its table shared_note to exist, and closes its SQLite connections, so test_schema_install passes without a weakened assertion (KSTD-5-51). Red: test_schema_install failed three tests with CONFIG "table shared_note does not exist".
- `contracts/check-inputs.json` declares the scopes of `docs-site-check` and `docs-site-parse-check`, so `make feature-unit-check/owners` passes on main again (KSTD-5-48-1). Red: the owners test reports both targets as declaring no scope.
- Every suppression of a lint finding in the repository states its reason, so `make suppression-check` (P8) passes: the Python test, dbspec and orm suppressions and the Rust allow carry their reasons inline, and the lambda assignments of the tests and of the dbspec sources are defs (KSTD-5-40). Red: `make suppression-check` on 6533e687d reported 95 suppressions without a reason.
- The PHP library's parser keeps the declaration positions as lists of scalars and builds the Position objects only for a successful parse, so the limit/columns document peaks at 66.9 MB under PHPUnit, within the derived bound of its test (T182-0-2-1-1). Red: testLimitColumnsPeak measured 96.8 MB against a bound of 91.6 MB.
- `make docs-check` runs the Markdown checks only, so a land no longer builds the VitePress site; the site build and the checks that read the built site run in `make docs-site-check`, which the owner rules select for changes under docs/ and CI runs (KSTD-5-48). Red: `tests/docs/split.test.mts` finds the site build in the expansion of docs-check.
- `make clippy-crate CRATE=<package>` runs the lint-rust clippy flags on one package, so a sub-item of the clippy row can be checked alone (KSTD-5-41-0).
- The PHP extension's parser reuses its line token buffer and formats the source of a generated name only for a diagnostic, so the limit/columns document peaks at 88 MB, under the 96 MB bound of its test (T182-0-2-1). Red: testLimitColumnsPeak measured 109.1 MB.
- Unsubscribing in the PHP extension frees the function of its unsubscribe closure, so a process that subscribes and unsubscribes over and over keeps its memory flat (T182-5-4). Red: the leak test reported the resident set grew by 31248 KB over 200000 subscribe/unsubscribe cycles.
- The parity declaration check binds each implementation once per unit: the aes-version-codes and dbspec-introspect-query-count units are split into one unit per behaviour, each with its own requirement (COD-44, COD-47 to COD-60, DIA-133, DIA-154 to DIA-156), and the stale Go support glob of dbspec is removed (KSTD-2-7). Red: parity-declarations-check reported 158 findings, 44 of them R12 duplicate-binding and 1 a stale glob. Green: 113 findings, all php-extension declares no symbols.
- The Python code passes `make lint-python`: ruff check and ruff format and vulture report no finding. The blind excepts of the catalog re-raise the error they hand to the session end, the test loops that collect failures or accept any refusal state their reason inline, the unused catalog metadata fields are deleted, and the error codes that orm-gen writes for every client are whitelisted with their reason (KSTD-5-43). Red: `make lint-python` on main reported 13 ruff check issues, 13 files to reformat and 10 vulture findings.
- lint-php passes on the PHP sources: the long lines of packages/php-ext/tests/silent_paths.php are wrapped, and the three Coverage test files of packages/php/tests keep their PSR-1 entry check inside a method, not at file load (KSTD-5-45). Red: phpcs reported 6 findings.
- The TypeScript lint of the repository passes: the lint-ts steps report no oxlint finding and no unused export. The errors keep their cause, the redacted rethrows leave their catch blocks, and the unused byteSize and the unused export quoteIdent are removed or unexported (KSTD-5-44). Red: make lint-ts reports 34 oxlint findings and one knip unused export.
- The VitePress temporary folder `docs/.vitepress/.temp/` is ignored by git, so a build that leaves it no longer blocks a land (KSTD-5-39). Red: the probe of `git check-ignore` fails before the line is added.
- The tool paths of the Makefile name KIT_TOOLS, so a linked worktree builds with the tools that the main checkout installed (KSTD-5-38). Red: the rebuild in a new worktree stops on a missing var/tools/mise/shims/go.
- lint-php passes: the PHP takes the PSR-12 layout, camelCase test methods (with the 218 PHP bindings of config/parity.json and the Makefile filters), one class per file, a namespace for every test class, test helpers required by the PHPUnit bootstrap, no empty catch and no silenced call without its reason, and the tests load their generated models without an autoloader (KSTD-5-9). Red: phpcs and phpstan of the root, packages/php and packages/php-ext failed.
- The hand-written PHP keeps the 120 character line length: long calls, chains, lists, strings and comments are wrapped PSR-12 style, token for token, and the Unicode word table generator writes its description in two lines (KSTD-5-9-1). Red: phpcs reported 1450 long lines.
- config/rebuild.json classifies scripts/typescript/models.mts and scripts/php/vendor-autoload-check.mjs, so make rebuild-check passes (KSTD-5-5-1-1). Red: rebuild-check reported both tools with no class.
- config/rebuild.json classifies scripts/typescript/models.mts and scripts/php/vendor-autoload-check.mjs, so make rebuild-check passes (KSTD-5-5-1-1). Red: rebuild-check reported both tools with no class.
- KSTD-10-5 is done again on main: its autoload check cases are declared with `caseTest`, as KSTD-10-5-1 restored after the KSTD-3-2 commit rewrote them with node:test (KSTD-10-5). Red: the rule failed on the rewritten test.
- The extension fails loudly on its silent paths: `Validator::restoreKey` and `conflictKey` throw an Error naming the missing OrmException class instead of returning null, `scall` throws when a call is not callable, `record_inserted` propagates a failed TxFrame::recordInserted instead of discarding it, and the build uses `-Werror` (T182-2-4). Red: `make dbspec-php-extension-check/silent-paths` returned null with no exception for both calls.
- KSTD-10-5 is done again on main: its autoload check cases are declared with `caseTest`, as KSTD-10-5-1 restored after the KSTD-3-2 commit rewrote them with node:test (KSTD-10-5). Red: the rule failed on the rewritten test.
- The test servers' startLogged no longer waits forever: a ready line that does not come fails with its step and log, and the log is also read on a timer (KSTD-5-37).
- The guard test of `scripts/check/run.test.mts` checks the refusal of a CI group locally, without setting the CI identity; the accepting case runs only in a GitHub Actions process (KSTD-5-13). Red: the bypass check failed on the parent test, which set the CI identity in a local run.
- The workflow rules of the repo check that read the Node, PHP and Rust versions judge only orm's own workflows, not gates.yml and release.yml, which are kit's copies that kit-check holds byte for byte (KSTD-10). Red: the cases found gates.yml, a kit copy, not reading mise.toml and .php-version.
- The fulltext test of `packages/rust/orm` opens its case with `polyspec_orm_testcase::case!`, so it runs with its deadline and RUN line (KSTD-5-22-1). Red: the rule named a Rust test added later without a case.
- The PHP extension implements authenticated_encryption: the PHP library's tests run with the extension loaded and the feature is implemented in every client language (KSTD-7-2).
- The fulltext test of `packages/rust/orm` opens its case with `polyspec_orm_testcase::case!`, so it runs with its deadline and RUN line (KSTD-5-22-1). Red: the rule named a Rust test added later without a case.
- The CI step rule of the repo check judges only orm's own workflows, so the kit copy gates.yml, which kit-check holds byte for byte, is not read for its make steps (KSTD-5-24). Red: the case found gates.yml steps that run rustup and shell commands directly.
- The rebuild layout reads three repository tools that config/rebuild.json did not classify: `scripts/comments/tokens/python-comments.mts`, `scripts/php/vendor-autoload-check.mjs` and `scripts/typescript/models.mts` are `policy` tools, so `make rebuild-check` passes (KSTD-6). Red: `make rebuild-check` exited 2 with each of the three tools having no class.
- The autoload check cases of `scripts/php/vendor-autoload-check.test.mjs` are declared with `caseTest` again, after a later fix had rewritten them with node:test (KSTD-10-5-1). Red: the rule named the file as declaring node:test tests directly.
- Full-text search is implemented in every implementation: the IR ops fulltext and fulltext_boolean (PRT-75) over cols, MATCH for MySQL, to_tsvector for PostgreSQL, refused on SQLite, and the boolean text normalized by fulltext_boolean (DIA-6) (KSTD-2-10-2).
- The repository declares its commit identity in `config/commit-identity.json`, the kit copy of min-0-max <max.tools>, so commits-check enforces it (KSTD-5-17). Red: the identity case found the file missing.
- The autoload check cases of `scripts/php/vendor-autoload-check.test.mjs` are declared with `caseTest` again, after a later fix had rewritten them with node:test (KSTD-10-5-1). Red: the rule named the file as declaring node:test tests directly.
- The trigger rule of the repo check judges only orm's own workflows, and its table no longer holds release.yml, a copy of kit whose triggers kit owns (KSTD-5-25). Red: the case found release.yml with the manual trigger that kit copies, and the rule checked it.
- The coverage rules of `docs/spec/feature-coverage.md` carry ids, and the implementation matrix moves from `docs/spec` to `docs/operations/interface-implementation.md`, so `docs/spec` holds only rules (KSTD-2-8). Red: `make docs-check` failed at `20747f534^` in the docs-build step (vitepress exit 1).
- The lock timeout test of `packages/rust/orm` opens its case with `polyspec_orm_testcase::case!`, so it runs with its deadline and RUN line (KSTD-10-6). Red: the rule named the test as one without a case.
- `group_rows_db.mjs` runs its case through `caseTest` with the database deadline, so it reports its PASS or FAIL line and its deadline like the other TypeScript cases (KSTD-10-4). Red: the case found the script reporting no case.
- `group-rows-db-go` runs its Go test through `GO_TEST`, the go-test wrapper with `-timeout 0`, so the test gets a run line and no default 10 minute deadline (KSTD-10-3). Red: the case found the recipe running `go test` directly.
- `group-rows-db-typescript` starts its recipe with `$(READ_TYPESCRIPT)`, so it holds the TypeScript build output it reads (KSTD-10-2). Red: the case found its recipe without the lease.
- The group-rows-db targets (Go, TypeScript, Python, PHP, PHP extension and Rust) run in the CI groups, and generated-lint-check runs in the static group, so every target of CHECK_TARGETS runs once (KSTD-10-1). Red: the CI group case found seven group-rows-db targets and generated-lint-check in no group.
- The php-ext arginfo header matches its stub after the T230 comment change, so the build of main passes again (T230-1). Red: `make build-php-ext` failed with `the stub hash is e52e7311624b7ffc7855b911a2d9eaa5565b147c, the stub's is 3d0af81494eb1e68a766385d1d89b7ae170fd26b`.
- KSTD-5-23 is done: this commit records its done state in both checklists and refreshes their Korean stamps (KSTD-5-23).
- The `dbspec-php-extension-check/planner` target runs its three PHPUnit suites as parts after the class check, the `dbspec-plan-check` quoting of the `TestPlanApply` pattern is written `$$` for make, and the chained TypeScript verifications of statement-fault and install-register are split into one command each (KSTD-5-23). Red: the repo check read the `$` quoting as a make variable and rejected the command, and the planner test ran three suites in one recipe.
- KSTD-5-22 is done: this commit records its done state in both checklists and refreshes their Korean stamps (KSTD-5-22).
- Every Rust test of the repository starts its case with `polyspec_orm_testcase::case!`: the fixed-list test of packages/rust/build, the restore-or-create and external-relation tests and the AES key read tests (KSTD-5-22). Red: the rule named generate.rs and seven other Rust tests without a case.
- `make feature-unit-check` passes on main again: contracts/check-inputs.json declares generated-lint-check, which selects the generator sources, and CHECK_TARGETS holds the six group-rows-db targets the file declares (KSTD-7-9-1). Red: the CHECK_TARGETS and generator-source tests of scripts/features/owners.test.mts failed on main.
- The comments check reads Python through `scripts/comments/tokens/python-comments.mts`, a TypeScript port of the tokenize and ast reader, so the repository has no Python tool; the output matches the former reader on all 224 tracked Python files (KSTD-5-21). Red: `every tool of the repository is written in Go, PHP, Rust or TypeScript` failed on python-comments.py.
- A MySQL lock wait timeout (1205) is CANCELED in every client, as the write bound of CFG-6: `errors.yaml` and CFG-6 name it, and the Go, PHP, PHP extension, TypeScript, Python and Rust clients map it. Red: `TestMapMySQLErrClassifiesLockWaitTimeout`, the PHP, TypeScript, Python and Rust cases returned DRIVER or nothing for 1205 (T230).
- T229 is done: PostgreSQL LISTEN and NOTIFY are client operations in every client: `notify(channel, payload)` sends with `pg_notify` inside a transaction (delivered with its commit), `listen(channel)` opens a subscription on a connection of its own, and `unlisten` and cancellation end it; MySQL, SQLite and the markdown executor refuse both with CAPABILITY_UNSUPPORTED (T229). Red: the Verification found no unit `postgres-listen-notify` in config/parity.json, and the owner test of each client failed (no `notify`, `listen` or `Notify` in the client).
- KSTD-5-20 is done: this commit records its done state and refreshes the Korean stamps of the checklist that the row commit left stale (KSTD-5-20).
- The workflow-rules case of the repo check expects both kit copies, release.yml and gates.yml, and the rules skip them (KSTD-5-20). Red: the case expected release.yml alone and found gates.yml as a second kit copy.
- The Node case of the repo check lists every workflow of `.github/workflows`, gates.yml included, and checks that each runs the Node of mise.toml; the kit copy gates.yml passes that rule (KSTD-5-19). Red: the case expected four workflows and found gates.yml as a fifth.
- The PHP extension implements the codec: encode and decode of every logical type, AES with the blind index, and the host-style decode run in the extension under the ids codec, codec-aes and codec-decode (T182-2). Red: at 4837ba2dc^ the extension's declarations lacked every `Polyspec\Orm\Codec` method (encode, decode, blindIndex, hostEncode, hostDecode, decodeRows, isHostStyle).
- The PHP extension takes the PHP client's class names: it registers `Polyspec\Orm\Dbspec\*` and `Polyspec\Orm\Code` in place of the `Native` namespaces, so user code is the same with or without the extension, and a process with the extension loads none of the client's PHP files for those classes (T182-0). Red: the declaration tests failed with `Polyspec\Orm\Native\Code is outside Polyspec\Orm\Dbspec\ and Polyspec\Orm\Code`.
- The repo check of build outputs reads quoted text as text: a recipe that prints a usage message such as "WORKTREE=<path>" to stderr is no longer reported as a redirect into a file, while the command string of `sh -c "…"` is still checked (KSTD-5-26). Red: the check reported Makefile:883 (`echo "usage: … WORKTREE=<path>" >&2`) as a redirect in place. Green: the check holds on the Makefile, and a quoted redirect in `sh -c` is still found.
- The Markdown IR executor table of docs/spec/dialects.md mirrors the flowmark capability table at the pinned version, and `make markdown-table-check` passes (KSTD-5-18). Red: the table was missing under the heading.
- The TypeScript build cache `packages/ts/tsconfig.build.tsbuildinfo` and every `*.tsbuildinfo` is ignored by Git and declared as a generated path, so a build leaves no untracked file in the checkout. Red: `git check-ignore` found no rule for it, and `git status` listed it after `make build` (KSTD-15).
- `docs/operations/perf.md` drops the PHP 8.5.10 ratios, since PHP 8.5 goes to 8.4; the page keeps the PHP 8.4 ratios (T233). Red: the page quoted the PHP 8.5.10 ratios.
- T234 is done: its row is [o] in this commit, whose red is the T234 text-absent run before the fix, which found the upstream YAML product name in the changelog and packaging documents, and whose green is the same run after the fix (T234).
- The changelog entries of T142-1-1 and the packaging notes name the PHP YAML dependency generically; the dependency package names and the fork facts stay (T234).
- The recipes `case-database-check`, `example-check` and `timing-check` build the Rust crates through kit's cargo link (`CARGO_SIBLINGS`), so a sibling polyspec crate resolves to its path and no recipe fetches a locked release (K448-5). Red: `make -s link-state-check` reported Makefile:1175, 1740 and 1753 and exited 2 (KSTD-13).
- `docs/spec/dialects.md` states the SQLite version of the pinned PHP 8.4 `pdo_sqlite`: 3.53.4 from `select sqlite_version()` of PHP 8.4.26, in place of PHP 8.5.10 (T232). Red: the document named `pdo_sqlite` of PHP 8.5.10.
- KSTD-9 is done: the server tool sets `LC_ALL` to `en_US.UTF-8` for `initdb`, the PostgreSQL primary and the replica it starts, so the start succeeds with no locale set by the caller. `postgresEnvironment` builds that environment and the tests check it, including a real start with no caller locale. Red: with `LC_ALL` unset, the server exited with `postmaster became multithreaded during startup` (KSTD-9).
- `errors.yaml` names the duplicate key of every database for DUPLICATE_KEY: MySQL 1062, PostgreSQL 23505 and SQLite 2067 and 1555, as the clients map them (T231). Red: the row named only MySQL 1062 and SQLSTATE 23000.
- KSTD-11 is done: orm's Composer root requires phpunit/phpunit at exactly 13.4.3 (`composer.json`), and the tracked `composer.lock` locks 13.4.3, the reviewed target of K435. `make dependency-review UPDATE=1 TARGETS=<file>` applied it (3 of 3 update commands passed); the provider entries of polyspec/ordered-json, purrphp/yaml and opis/json-schema took their sibling manifests (K439-4-1). Red: with `composer.json` and `composer.lock` at 13.4.2, the Verification (the exact 13.4.3 declaration and the locked `phpunit/phpunit` version of `composer show --locked`) fails with exit 1. Green: with 13.4.3 in both files it passes (KSTD-11).
- The docs checks read the built HTML with parse5 and the Markdown tables with mdast-util-from-markdown and mdast-util-gfm: an escaped pipe stays in its cell, and a quoted `>` no longer ends a tag. The regular expressions and the pipe split are removed. Red: check.mts read HTML with regular expressions, and the table readers split lines on the pipe (KSTD-5-4-1).
- The Rust README's capability table holds its last row, which the English README had after a paragraph; the Korean twin already had it in the table. Red: rules.mts found the two table structures differ (KSTD-5-4-1).
- Every PHPUnit run of orm goes through kit `run-tests`, so a hung test fails at its timeout: the extension runs, the `packages/php-ext` run and the `GroupRowsDbTest` run no longer start PHPUnit outside it (KSTD-8). Red: three Makefile lines started `vendor-php/bin/phpunit` directly, so no per-test timeout applied.
- With the PHP extension, a row lock inside a transaction is allowed and a statement past `statementTimeoutMs` is cancelled, as in the PHP library: `Db::enter` rejects a lock only outside a transaction, and the select path no longer frees an unset result when the statement fails. Red: `ModelTest::test_transactions` failed with CONFIG "row locks are allowed only inside a transaction" and the select path crashed with SIGBUS (T182-5-5).
- `make php-vendor-check` reports an autoload that differs from composer.json and no longer repairs it; `make orm-install-php` runs `composer dump-autoload` (KSTD-3-2). Red: a stale autoload passed silently and was rewritten.
- `make generated-lint-check` passes in an installed checkout: php-vendor-check regenerates the Composer autoload from composer.json, so a stale vendor-php no longer names packages/php/gen/bootstrap.php (KSTD-3-1). Red: the main checkout failed with a fatal error on that file.
- `make generated-lint-check` lints the generated models of every ecosystem with the pinned tools; the generated PHP passes PSR-12 and PSR-1 (KSTD-3). Red: the generated PHP failed PSR-12 at packages/php/gen/Account.php:1:1 before the fix.
- The collection identity, collection group and owner parity units are six-way, and the grouped counts of the bench database are checked in every client. Red: the units were per client and cited no shared rule (KSTD-2-11-10).
- Every client has `wasInserted` and `backendWaitingForLock` (INT-52, INT-53). Red: the PHP, TypeScript, Python and Rust clients lacked both; the Go client alone implemented them (KSTD-2-11-7-5).
- The dialect probe citation test reads the dialect spec where it lives, `docs/spec/dialects.md` and its Korean twin, and `make dialect-facts-check` runs it. Red: it failed with `open ../../../../docs/dialects.md: no such file or directory` (KSTD-2-10-6).
- The MySQL binlog probe closes its connection once: the deferred close owns the connection, and `Merge` no longer closes it a second time, so `TestDialectFacts/mysql.trigger.binlog_privilege_1419` passes. Red: it failed with `sql: connection is already closed` (KSTD-2-10-6-1).
- The apply, plan and introspect parity units cite the rules their tests check, and the plan, query-count and pooler units are six-way. Red: the units cited no rule for the physical plan, the query count and the pooler session (KSTD-2-11-9).
- `make lint-python` passes: unused noqa directives are removed, three files are formatted, and the one silent except of the IR answer test names its case. Red: ruff reported 54 findings and three unformatted files (KSTD-5-8-1).
- The lowest supported Node is installed by mise: `make ts-min-check` runs the TypeScript tests on the node that `mise where node@<engines.node>` prints, and scripts/typescript/node-min.mts downloads nothing. Red: node-min.mts downloaded that Node itself, outside mise (KSTD-5-4-2).
- The comments of the PHP extension Db state what it implements: the transactions, savepoints, audit, execute, Utils and Stats are its own, no longer described as throwing INTERNAL. Red: the db.c header and the stub docblock held the stale sentence (T182-5-3-1).
- The statement event rule INT-91 states the seven fields that every client exposes (sql, binds with secrets and clock values masked, kind, tables, elapsed, transaction and error), and the statement event parity unit cites it; the bind count and plan identifier that no client exposed are gone. Red: the unit had no rule to cite (KSTD-2-11-7-4).
- `make interface-check/self-test` passes in every language: the plan spec states what Go Apply returns, the PHP stored-version reader is marked internal, and the symbol contracts record the surface that earlier rows changed, each finding reviewed against its commit. Red: the self-test failed in Go, PHP, TypeScript, Python and Rust (KSTD-5-16).
- Every install directory of the checkout is ignored by Git, so `make layout-check` passes. Red: kit K372 named six install directories (KSTD-5-5-7).
- The five generated error-code sources stay tracked as declared exceptions, on the ground stated in the packaging document: their consumers install the source and run no generator, and the TypeScript build needs no Go toolchain; each client code-catalog test keeps them equal to errors.yaml. Red: kit reported them as tracked generated files (KSTD-5-5-6).
- The PHP fixture models are written by `make orm-install-php` from packages/php/models.txt and loaded by the test bootstrap, and none is tracked. Red: 30 generated files were tracked (KSTD-5-5-5).
- The Go fixture models are written by `make orm-install-go` from packages/go/models.txt, which the generation check and its coverage test also read, and none is tracked. Red: 32 generated files were tracked (KSTD-5-5-4).
- The Python models that orm-gen generates are written by `make orm-install-python`, are left out of the wheel, and are not tracked. Red: models.py was tracked (KSTD-5-5-3).
- The TypeScript models that orm-gen generates are build output: the TypeScript build writes them from one declared list before it compiles, and none is tracked. Red: three generated model files were tracked (KSTD-5-5-1).
- The CI interface test checks the `make check-run GROUP=` step the workflow runs, and its mutation removes that step instead of a step the workflow never held. Red: the test failed with a missing mutation target (KSTD-5-15).
- `make rust-fmt-check` passes: the Rust code is formatted by the pinned rustfmt under the declared packages/rust/rustfmt.toml. Red: cargo fmt --check reported 12 files (KSTD-5-14).
- The TypeScript client reads an AES stored version that SQLite returns as a bigint, so AES reads and rotation work on SQLite again. Red: every SQLite AES read failed with CODEC_DECODE (KSTD-2-11-7-2-4).
- The negative-word helper of the Python dbspec parser is private, so `test_python_extractor` passes. Red: it named `is_negative_word` (KSTD-2-11-7-2-3).
- The stored-version helper of the Python AES module is private, so the public names match the symbol contract again. Red: the extractor test named `stored_version` (KSTD-2-11-7-2-2).
- Decoding an AES column falls back to no default version: a plan with no version column is INTERNAL, a NULL stored version of a non-NULL AES value is CODEC_DECODE, a NULL AES value is NULL and its version is never read, and rotation leaves a NULL AES cell unchanged, in all six implementations (COD-44). Red: the clients assumed a version, and rotation failed on NULL AES cells (KSTD-2-11-7-2-1).
- A bad or undeclared AES key version is CONFIG, a stored version that is not a positive integer is CODEC_DECODE on every read and rotation path, and an AES or version column missing from a row the client selected is INTERNAL, in all six implementations (COD-44). Red: Go returned uncoded errors, and the other clients coerced or misclassified the stored version (KSTD-2-11-7-2).
- A group row with a negative or non-integer row count fails with CODEC_DECODE in every client, as INT-90 rules; a missing count stays INTERNAL. Red: Go, PHP and TypeScript gave INTERNAL and Rust panicked (KSTD-2-11-7-6).
- `make feature-unit-check` passes: the feature document is regenerated, moved test files are declared at their new paths, helper files are no longer inputs of checks, and statement events have their PHP extension coverage owner. Red: the stale document and the helper inputs failed the check (KSTD-7-9).
- Python `Db.register` and `Db.connect_schema` refuse a manifest text that does not hash to its declared hash with CONFIG, as INT-54 rules and the other clients do. Red: they raised SCHEMA_HASH_MISMATCH (KSTD-2-11-7-3).
- The PHP extension runs the executor of the PHP library over PHP's own PDO, in three parts (T182-5-1 to -3) (T182-5).
- Every public member of `Polyspec\Orm\Db` is the PHP extension's: the request hook came with the statement path and `utils` and `stats` with the transactions, which the declaration check confirms (T182-5-3).
- The PHP extension implements the transactions, savepoints, audit, fault injection and frames of `Polyspec\Orm\Db`, plus `utils` and `stats`, so statement-events, statement-fault and all 18 IrAnswersTest cases run with it; PostgreSQL connections now set `ATTR_DISABLE_PREPARES`. Red: the transaction vectors failed while the transaction path was missing (T182-5-2).
- The PHP extension implements the connection and statement path of `Polyspec\Orm\Db` in C over PDO, `execute` included, so sqlite-paths and mysql-session run with it. Red: with the extension loaded `Db` was the PHP library class (T182-5-1).
- A Go insert into a table without an identity column succeeds on PostgreSQL again: only a driver that reports an insert id (MySQL, SQLite) is asked for one, since pgx reports none. Red: after KSTD-5-7-2 returned the dropped error, TestInsertWithoutIdentityOnEveryDatabase and TestColumnsAndSubqueries failed on PostgreSQL with "LastInsertId is not supported by this driver" (KSTD-5-7-8).
- The PHP extension implements `Polyspec\Orm\Planner` in C under the library's name, so the planner, insert-parts and ir-answers suites run with it under `make dbspec-php-extension-check/planner` (81, 6 and 18 cases). Red: with the extension loaded the planner was the PHP library's (T182-4).
- The `orm-gen` binary that `go build` writes beside its command is no longer tracked, and the command folders of `packages/go/cmd` ignore their build output. Red: the tracked-file test of `make feature-unit-check` named `packages/go/cmd/orm-gen/orm-gen`, a Mach-O executable committed in 0b3426809 (KSTD-5-7-7).
- The rest of the Go code handles every error the K334 lint rules find (42) and holds no unreachable function; the planner returns the conflict key error it dropped, and the bench gate helpers build with the tags of the tests that use them (KSTD-5-7-4).
- `packages/go/engine/dbspec` handles every error the K334 lint rules find (41): number parses and type assertions are checked, and wraps keep the error chain (KSTD-5-7-3).
- `packages/go/orm` handles every error the K334 lint rules find (113): dropped driver and close errors are returned or joined, type assertions are checked, error comparisons keep the chain, a builder error is no longer hidden behind the row-lock check, and a bare `$` of a statement stays literal (DSL-153) (KSTD-5-7-2).
- The Go files behind a build tag build and pass the Go lint under their tags: the case clock and `restoreTables` return beside their only users, dropped errors of the physical, markdown, coverage and perfgate tests are checked, and `make lint-go` passes in its 26 steps. Red: kit K406 found 79 findings under seven tags, and the bench stress test no longer built (KSTD-5-7-6).
- `tests/dbspec/syntax.json` carries the tokens of the two hashes cases of DIA-97 that KSTD-2-10 added to `cases.json`, regenerated by its generator. Red: TestSharedSyntaxVectors failed with "syntax.json has no tokens for this case" (KSTD-2-10-8).
- Every error-code unit cites INT-65 and names its constant in all six implementations, the PHP extension included, and the five catalog units are one unit bound in all six; the catalog test compares the constants of `Polyspec\Orm\Code` by reflection, so the same assertions check the library and the extension, and the Python catalog test reads `docs/spec/errors.yaml`. Red: the api check reported the error-code units naming no php-extension symbol (KSTD-2-11-6).
- `dbspec.Apply` reports a stop of its callback and its `ApplyError` as an `ApplyResult`, so its callers decide without comparing errors, and a stop followed by a cleanup failure still returns the joined error; `make lint-go` passes. Red: errorlint reported the two error comparisons of the apply tool (KSTD-5-7-5).
- DBS-173 states that every generator writes the read-only model of each external table that a set uses through a `use` line, whether or not a scanned source calls it, and five regression cases, one per generator, guard it. No generator was red: the missing `Audit` of a consumer came from models generated before T209 (T228).
- The conformance check runs php-extension as the PHP runner with the extension loaded, so every vector runs in the extension; on MySQL and PostgreSQL its results equal the other five implementations, and on SQLite all six differ alike by the documented row-lock statement of a solo run. Red: every conformance run stopped with unsupported language php-extension (T182-0-3).
- The PHP extension implements `Polyspec\Orm\Validator` in C under the library's name, so the 125 cases of `tests/ir/validate.json` run with it under `make dbspec-php-extension-check/ir`, and the interface record holds the class. Red: with the extension loaded the validator was the PHP library's (T182-3).
- The PHP extension implements the AES host stage in the ORM-AES2 format, the blind index and the hex encode with the crypto functions of PHP called from C, so `tests/codec/aes-vectors.json` and the whole HostcodecTest run with it. Red: the aes stage answered `CODEC_UNSUPPORTED` with the extension loaded (T182-2-3).
- The PHP extension decodes the hex and ip host stages and decodes rows in C, so the 68 vectors of `tests/codec/decode-vectors.json` run with it under `make dbspec-php-extension-check/decode`. Red: `hostDecode` answered `CODEC_UNSUPPORTED` with the extension loaded (T182-2-2).
- The Rust integration binary compiles its generated models `nonnull_model` and `external_member` with no `#[cfg(test)]`, so the binary and its tests compile the same code (KSTD-5-12-3).
- The Rust fault tests carry no `#[cfg(feature = "test-faults")]`: the crate enables the feature for its own tests through its dev-dependency, so every build runs the 17 statement-fault cases the other implementations run; divergence-check went from 77 to 49 findings (KSTD-5-12-2).
- The TypeScript chain refuses a null argument on a non-null column with `CONFIG` for a bare, `and` and `ne` condition, as DSL-49 rules; the test runs in the TypeScript test script. Red: `serviceSeq(null)` reached the database and failed with `DRIVER` (KSTD-2-10-7).
- The unparsable-scan test of Python keeps the ruff format, and the TypeScript scan names a parse error at the exact line and column of its label with no non-null assertion and no default position of 0; an error without a label names no position (T227-1).
- The PHP extension implements `Polyspec\Orm\Codec` in C under the library's name: every logical-type stage of `tests/codec/vectors.json` (ordered_json, yaml, serialize, gz, base64, ip) runs in it, and `make dbspec-php-extension-check/codec` runs the vectors with the extension. Red: with the extension loaded the class was the PHP library's; host decode and AES follow in T182-2-2 and T182-2-3 (T182-2-1).
- The Rust integration test decimal_physical.rs carries no `#[cfg(test)]`, a marker that states nothing in a file compiled only as a test; divergence-check went from 99 to 77 findings. The markers of the bin target integration.rs are KSTD-5-12-3 (KSTD-5-12-1).
- The Python chain refuses a null argument on a non-null column with `CONFIG` for a bare, `eq` and `ne` condition, as DSL-49 rules and the PHP client does. Red: `service_seq(None)` rendered `IS NULL` and raised nothing (KSTD-2-10-4).
- The PHP extension registers the PHP client's own classes, `Polyspec\Orm\Dbspec\*` and `Polyspec\Orm\Code`, with no `Native` namespace and no guard, and the extension's make targets run the `packages/php` tests with the extension loaded; the 13 mirrored test files are removed after every case was mapped to its client test, and the analyze argument errors gained their cases. Red: `make test-php-ext` reported every registered class as `Native`, declared by no library class (T182-0-2).
- A file that orm-gen cannot parse while it scans stops the generation in every generator, which writes nothing and names the file with its line and column (DSL-152). Red: the Python scan skipped the file and wrote the models, Go reported it only after writing them, and the TypeScript and PHP errors gave no `file:line:col` (T227).
- `make rebuild-check` passes: `config/rebuild.json` classifies the 78 tools of the repository (57 policy, 16 ecosystem, 4 replaced by KSTD-5-4-1 and KSTD-5-4-2, 1 record). Red: the file did not exist (KSTD-5-4).
- `make lint-ts` passes: the oxlint and knip findings are fixed without suppression, and tsc of the root and of the docs project type-checks the coverage plans, the package reader and the recorded vectors. Red: oxlint found 4, knip 1 unused export and tsc 4 errors (KSTD-5-6).
- `make lint-python` passes: six files take the ruff format, six lambda assignments are functions, and a test computes its root after its imports instead of silencing E402. Red: `ruff format --check` listed 6 files (KSTD-5-8).
- `make lint-go` passes: every unchecked error of the Go code, the tests and the examples is handled (a Close error joins the returned error, and tests close with `testcase.Close`), the staticcheck rewrites are applied, and the 37 unreachable functions are removed or tested as public symbols. Red: golangci-lint found 284 findings and deadcode 37 (KSTD-5-7).
- The codec rules and PLN-15 name the stages of DBS-69, `ordered_json` among them, instead of the styles `json`, `jsons`, `point`, `aes_serialize` and `aes_hex` (KSTD-2-9-12).
- DIA-21 names `orm.Connect`, the Go entry, instead of `orm.Open` (KSTD-2-9-11).
- The two-connection procedure for lock contention moves from the DSL spec to the usage guide; DSL-119 keeps the savepoint rule (KSTD-2-9-10).
- `make toolchain-check` passes: the kit link run installs polyspec/ordered-json from its linked folder, so the platform check of `vendor-php` follows its requirement PHP 8.4 and phpstan starts. Red: phpstan failed with "Your Composer dependencies require a PHP version >= 8.5.0", taken from the release metadata of 0.0.9 (KSTD-5-1).
- The dbspec and query area ids that no test named have tests or citations: 15 markdown cases (DIA-156 to DIA-190), the hashes cases of DIA-97, the encrypted history and full-text introspection cases of DBS-95 and DIA-71, the month-end probes of DSL-142, the Go MySQL-only build of DIA-20 and DIA-21, the chain argument types of DSL-49, DSL-50 and DSL-52, the transaction flow of DSL-121, DSL-122 and DSL-124, and the styled value checks of COD-21 and COD-31; each failed first and then passed. The untraced ids fell from 207 to 174; the rest are KSTD-2-10-1 to -6 and KSTD-2-9-10 to -13 (KSTD-2-10).
- A scanned receiver held in a variable resolves through its initializer and every reassignment to its class and that class's import (DSL-151), so a model reassigned from its own chain in a conditional expression keeps its chain methods. Red: the TypeScript, PHP and Python scans lost the class after `page = c ? page.ltSeq(x) : page.andLtSeq(x)` and generated no `ltSeq` or `andLtSeq`, as in limepie's console/audit.ts; Go and Rust already typed the variable, and their new cases fail when the resolution is broken (T226-1).
- `make feature-unit-check` passes: the PHP extension is a client language of the feature coverage, with its package, its PHPUnit run and its owner of `schema_definition`; the 16 features it does not implement yet are `partial`, and `docs/features.md` is regenerated. Red: 8 coverage cases failed with "no package implements the client language php-extension" and the generated document was stale (KSTD-7).
- 64 implementation-internal tests (dbspec harness and loaders, unicode and vector self-checks, generator scan mechanics, test harness, bench and examples) are no longer declared as parity units; they stay and run as package tests. `make parity-declarations-check` went from 576 to 512 findings (KSTD-2-11-5).
- Every rule of AGENTS.md says whether it is the repository's own (`Own:`, 50) or refines a principle of PRINCIPLES.md by its id (`Refines <id>:`, 8), with the same prefixes in the Korean twin. Red: `make rules-check` reported 58 rules with neither (KSTD-5-3).
- A model call that orm-gen scans belongs to the set whose generated models its class is imported from (DSL-151), in all five generators; a class of the same name from another set is another class. Red: the TypeScript, Python and Rust scans refused `Author.getGhost()` of another set with "no aliasGhost, newGhost or addColumn call attaches it", as limepie's requests set did; Go and PHP already resolved the import, and their new cases fail when the check is broken (T226).
- INT-67 rules that abandoning a query, transaction or connection handle cancels its statement and releases its connection, by the disposal form of each language (KSTD-2-11-4).
- INT-66 rules that the code orm-gen generates passes the standard compiler, formatter and linter of its language with no suppression in the generated text (KSTD-2-11-3).
- INT-65 rules that every implementation exposes every code of `errors.yaml` as a native constant and that its catalog equals `errors.yaml` (KSTD-2-11-1).
- INT-7 names the `StyledValue` type that every generator emits for a column with a value codec, instead of a JSON value type per language (KSTD-2-9-9).
- DBS-172 states that the PHP extension implements every PHP library of the repository (S10), and that the rule describes its dbspec surface (KSTD-2-9-8).
- DBS-12 to DBS-15, the numbered steps of the set file reader, are requirements that the set file units cite, since kit K299 reads an id of an ordered list item; the trace of the cited units reports no unknown or unnamed id (KSTD-2-9-7).
- The set file reader's statement about a tree changed while it reads is a note, not a requirement (KSTD-2-9-6).
- The bench database procedure moves from the dialect spec to the performance guide (KSTD-2-9-5).
- DIA-128 names the `types-and-defaults` case of `tests/dbspec/ddl.json` that checks it, instead of probes that do not exist (KSTD-2-9-4).
- DIA-16 states that PostgreSQL packs an `ip` value on the client into `bytea`, as every planner does, instead of `(?)::inet` and `host(col)` (KSTD-2-9-3).
- The dialect spec no longer describes a `point` type, which dbspec does not have (KSTD-2-9-2).
- The DSL spec no longer says SQLite stores `decimal` as floating point, which contradicted the exact `DECIMALINT(P,S)` storage of DIA-25 (KSTD-2-9-1).
- The dependency policy declares the one PHP platform 8.4.1, the minor of `.php-version` with patch 1, which the Composer manifests and their locks already use. Red: `make dependency-policy-check` reported both manifests and both locks against 8.4.0 (KSTD-4).
- The units of the query area cite the requirement ids their tests name: 342 of the 383 DSL, DIA and COD ids; six new planner cases (force index, today, date, the column function on varchar, styled equality, styled is null) failed and then passed in Go, PHP, Rust, TypeScript and Python, and the conformance recorder keeps a vector file's requirements. The other ids are KSTD-2-9 and KSTD-2-10 (KSTD-2-6).
- The units of the dbspec area cite the requirement ids their tests name: 191 of the 202 DBS, MER, SCH and CPX ids, from a top-level `requirements` of each vector file or a comment at the bound test; new vectors `import/cardinality-differs` (MER-12) and `positions/positions-skip-comments` (DBS-140) failed and then passed in every implementation. The other ids are KSTD-2-9 and KSTD-2-10 (KSTD-2-5).
- The TypeScript build makes the bins its package declares executable, so a consumer runs `node_modules/.bin/orm-gen`. Red: `node --test packages/ts/tests/bin-mode.mjs` failed with `orm-gen (./dist/bin/orm-gen.js) has mode 644`; green: pass 1 after `npm run typescript:build` (T225).
- Each testable rule of the specs has a requirement id `**PFX-n**` (960 ids: DBS, MER, SCH, CPX, DSL, DIA, COD, CFG, PAR, ORE, PLN, PRT, INT, ORES), the same in the Korean twins; `make docs-check` passes (KSTD-2-1).
- The PHP generator test expects the read-only models of the used external tables, which T209 generates. Red: `phpunit packages/php/tests/OrmGenTest.php` failed with generated files ExtAccount.php, ExtAudit.php, ExtPost.php, ExtPostHistory.php, bootstrap.php; green: OK (10 tests, 34 assertions) (T209-1).
- A generated PHP model agrees with its manifest whatever order its unique keys and indexes are declared in: the runtime model keeps them in name order, the order of the canonical manifest text. Red: `phpunit --filter test_a_generated_model_agrees_with_its_manifest_whatever_its_key_order` failed with `CONFIG: generated model ... of entity item differs from its manifest`; green: RuntimeModelTest OK (12 tests, 47 assertions), and the regenerated bench models are unchanged (T224).
- A Korean page links to an English page from the site root, so the nested plans have no dead link; the index pages and seven Korean links follow the moved documents, and the Names heading of dbspec has the id `names`. Red: `make docs-check` failed with `[vitepress] 2 dead link(s) found` (./../plans/execution/plan, ./../plans/kit-standard/plan); green: `make docs-check` exits 0 with docs-site/links ok and 50 document pairs passed (T223).
- T148-4 closes on its four done children: the Python decimal model, the PHP performance gates, the extension declaration environment and the TypeScript AesKeyring symbols (T148-4).
- The checklist no longer holds T77-8-1-6, a row that only awaited the full parity run; a full run is not checklist content (T77-8-1-6).
- The interface contracts follow the nullable reads, the creates batch and the revision write, and a conformance run of selected vectors checks their state contracts (T204-1).
- An audited transaction inserts its audit record right before its first audited write, so a unit of work that writes no audited row writes no audit record, in the five clients (T220).
- The MySQL migration case of the test servers reads the TAP lines of its steps (T221).
- The Python scan binds a model only from the generated models module and starts every parameter as its own binding; TypeScript typed callback parameters take their own class (T222).
- The test servers' PostgreSQL replica keeps its WAL through a physical replication slot, so it streams again after falling behind (T218).
- The PHP insert parts case proves the batch refusal with one repeated model, within the memory limit (T216).
- The generator scans type a name by the classes it may hold, refuse a call only when none declares it, and accept getters of used-document entities (T219).
- The Rust integration case `conditions` passes its time compare as text (T217).
- The PHP generics case types the nullable result of `get()` (T215).
- A table of an external document is read through a read-only entity of the using set: select, joins, subqueries and relations work, and every write fails with `CONFIG`, in the five clients (T209).
- `expectRevision(column, revision)` makes update() and delete() write only a row at that revision, update() incrementing it, and fails otherwise with the new code `REVISION_CHANGED`, in the five clients (T212).
- Breaking: `creates(rows, batch)` is the only form; each batch of `batch` rows is one multi-row INSERT, every batch runs in one transaction, and a batch over the bind limit fails with the new code `BATCH_TOO_LARGE`, in the five clients (T205).
- The Mermaid round-trip vector of the bench document lists the soft_link objects (T214).
- Each generator takes its base Model methods from Model itself, so a T200 `restore_or_create` call generates and a `json_text` column is refused (T213).
- The external text keeps the foreign keys between used tables and their leading indexes, so a runtime accepts the audit `tables` clause of an external document (T201-1).
- The TypeScript AesKeyring symbols hold red and green in interface-check and their parity units (T148-4-4).
- model.mjs passes its connectionsUseUtc time as canonical UTC text (T210).
- The five generators resolve a nested relation alias and a getter typed through its wrapper or type argument, and stop generation on a getter call that nothing attaches (T211).
- The request-hook cases of the five clients cover an upsert whose conflict key the hook completes (T202).
- A full parity-check refuses before interface-check builds anything, through the parse-time gate of kit K236; orm drops its own gate line (T206).
- PHP refuses a generated model whose metadata its manifest contradicts, naming the class, the field and the orm-gen command (T208).
- T203 is closed as not reproduced: no client raises CONFIG from relation() or relations() under a request hook (T203).
- A start of the test servers stops the servers an earlier start left on its datadir, and `make worktree-remove` stops a worktree's servers before removing it (T207).
- T202 is closed as no defect: the request hook already runs before the conflict-key validation in every client (T202).
- The Go statement-timeout tests and the TypeScript model test pass datetimes as canonical text (T210).
- The audit setting takes `tables <table> (<record column>, <name column>)`: its triggers record each audited table of a transaction once, in the six dbspec implementations (T201).
- A full parity-check passes the full-run gate before parity-prepare builds anything (T206).
- A full parity-check passes the full-run gate before parity-prepare builds anything; T148-4-4 is closed as no defect (T206, T148-4-4).
- Breaking: a select read that matches nothing returns its empty value in the five clients: `get()` and `getBy…()` return null instead of `NO_ROWS`, `getSum()` returns 0 and `getAvg()` null when no value is left, and the collections and counts stay empty and 0; `restore()` and `local()` keep `NO_ROWS` (T204).
- The tests that pin the bench set read its new table, entity count and manifest hash (T200-1).
- `restoreOrCreate()` restores the soft-deleted row of a key, or creates it, in one transaction, in the five clients; a live row of the key fails with `ROW_NOT_DELETED`. `RECORD=1` of the conformance check also records only the vectors that `VECTOR` names (T200).
- The element type and behaviour tests read plans.json through the one PHP reader of it (T182-0-1-4).
- The PHP symbol snapshot records the element type check Graph, whose public symbols are declared as PHP-only (T182-0-1-3).
- The interface contract test copies every stub of the PHP extension, so the recorded Code class is checked again (T182-1-1).
- The PHP tests of the element type check, the behaviour cases and the show-create introspection are bound in the parity declaration (T182-0-1-2).
- Names::column states its own TypeError for a column that is not a string, as the extension does (T182-0-2-2).
- The PHP dbspec behaviours that no shared vector fixes are cases with outcomes recorded from the PHP library, so one test checks either implementation of Polyspec\Orm\Dbspec in its own process (T182-0-1).
- The PHP library refuses a document, document set, plan list or unsupported list whose array holds another type with the TypeError the extension gives, instead of reading it with warnings (T182-0-1-1).
- The PHP extension registers the error codes of docs/spec/errors.yaml as Polyspec\Orm\Native\Code, from a stub that `orm-gen errors --lang php-extension` writes (T182-1).
- The PHP extension's mirrored dbspec tests have the same bodies as the PHP client's again (T131-11).
- The PHP extension's arginfo header is regenerated for its translated stub, so its check passes (T131-10).
- The owner selection tests expect comment-language-check, which every source change selects (T131-9).
- Each conformance vector declares `calls`, the public methods it verifies, and a unit test checks that every runner's body calls them; contains_null states that the typed clients set its NULL predicate through the core (T77-6-3).
- The NULL collection key vector is stored in the recorder's form, so recording unchanged outputs leaves the vector files as they are (T77-6-1-8).
- The CodeMirror and VS Code adapters of the dbspec editor stack are complete (T128-8).
- Every language adapter of the tests lives in its package; no parity root names tests/ (T77-9).
- TestApplyStressPlan proves that each apply statement commits separately at 100 tables: the applying PostgreSQL session holds no relation lock after any step, and every 200 steps it prints its progress and elapsed time (T148-4-5).
- The Unicode word tables are generated in English: the generator's headers match the committed tables, so TestCommittedTablesAreGenerated passes (T131-8-1).
- The Rust interface snapshot records the translated doc comments again (T131-8).
- The Python decimal unit passes in the parity run: its round trip reads the DECIMAL_*_DSN names that parity-check exports (T148-4-1).
- The five PHP extension declaration units pass in the parity run: the binding loads the built extension that parity-check names (T148-4-3).
- The two PHP performance gates pass in the parity run: parity-check exports ORM_BENCH_MYSQL_DSN, which their guards read (T148-4-2).
- The PHP decimal-set binding runs its decimal document as its own case, so the dbspec-set-decimal unit passes in both PHP and TypeScript (T148-3-php-1, T148-3-ts-2).
- The TypeScript IR-answer cases run in ir_answers.mjs under their fixture ids, and the flowmark cases stay in markdown_conformance.mjs (T148-3-ts-3).
- The TypeScript install fixture runs in its own file, so the install unit reports only its fixture cases (T148-3-ts-1).
- The TypeScript statement-fault entry-point check runs in its own file, so the fault suite reports only its four cases (T148-3-ts-4).
- The TypeScript collection-key tests report their cases by id as node:test tests, so the parity run passes both units (T148-3-ts-6).
- The TypeScript code-catalog test reports its cases by id as node:test tests, so the parity run passes its unit (T148-3-ts-5).
- The parity-check step exports the bench and decimal DSNs and ORM_DBSPEC_EXTENSION that its bindings read (T148-5).
- Every push runs the parity checks: parity-check and parity-declarations-check are in CHECK_TARGETS and the CI groups (T77-12).
- T77-9-4 closes: every child is done, and the parity rules held on cf01f139 (T77-9-4).
- The Python conformance bindings run every vector by name through the unchanged runner, so the Python suite holds without code change (T77-9-4-6).
- The Go coverage suites run every case through one binding per implementation, which the parity rules already held, so no code changed (T77-9-4-1).
- The NULL collection key conformance vector runs in the five runners on SQLite, MySQL and PostgreSQL with identical output; the PHP extension leg stays held (T77-6-1).
- The integration coverage tests run on PostgreSQL and SQLite in parity, as the Go units do, not on MySQL only (T148-3-14-1).
- The value types test binds the date as its canonical text, as every client does (T148-3-13).
- The zone tests bind datetime parameters as their canonical text, as every client does (T148-3-12).
- The Rust dbspec runtime test expects day_cell, which the bench schema declares and every other client models (T148-3-11).
- The Rust integration, conformance and benchmark parity bindings run the target that holds their test, not a library target (T148-3-14).
- The Rust parity bindings of the client bench, example, benchmark and seeded tests run through tests/cargo-test.mts, which gives the copied programs the tests read (T148-3-9).
- The sqlite send-savepoint test of parity opens its file in the step's run directory, which parity-prepare creates (T148-3-10).
- The comment language check reads each ecosystem's comments with its own tokenizer (go/scanner, the TypeScript parser, tokenize, token_get_all); Rust, C and the hash-comment files keep a lexer that docs/rebuild records (T131-1-1).
- Code comments are English: the 10,469 Korean comment lines of the tracked code files are translated, and `make comment-language-check` fails on Hangul in any code comment (T131).
- The parity-check step owns its run directory (STEP_RUN_DIR, removed when the step ends), so no leftover is reported (T77-58).
- The MySQL days_ago bind uses the bound instant, so the physical fixture is deterministic on every database (T77-33-1).
- The physical fixture of TestPhysicalQueryForms passes on mysql, postgres and sqlite (T77-33).
- Every go-orm unit runs only its own test, and the 45 units hold in every implementation (T77-35).
- The Python connection UTC test binds the instant as offset text, as the protocol takes datetime parameters (T77-57).
- The physical Go units read their cases from the go test -json stream of their make targets: GO_TEST_FLAGS selects it (T77-56).
- The zero-case rule uses kit's run-tests, and the orm counter scripts/check/count-cases.mts is removed (T77-55).
- A test run that reports zero cases fails: scripts/check/count-cases.mts counts the cases through kit's event readers (T77-54).
- The PHP CollectionKey contract lists the key set PHP implements, and the recorded interface hashes follow it (T77-52).
- Every check target in CHECK_TARGETS runs in a CI group: the Go dbspec engine and perf-check (T77-53).
- The interface record run writes the symbol hashes of contracts/interfaces.json, so the manifest is not edited by hand (T77-51).
- The goexit test binds its date text as the setters do, so its transaction test passes again (T77-50).
- The PHP extension's dbspec test copies match the PHP client's and read the shared plan vectors and cases; the shared DSN helper moves to packages/php/testing (T77-49).
- The Go feature wrapper validates its test name as a Go identifier and escapes it for go test -run (T77-48-1).
- The twelve database-backed Go feature units run through the wrapper for each database, mysql on their existing ids and postgres and sqlite as their own units (T77-48).
- The language-set declaration of config/parity.json is removed, because the set is read from config and no literal list remains (T77-47).
- The Go feature units run through one wrapper that takes the environment of feature-check from the same functions (T77-46).
- Every tracked test file runs under an owner target, and a test file never takes a scope declaration; the sixteen files that had no owner target are connected or declared as helpers (T77-45).
- The CHECK_TARGETS inputs name tracked paths, and the Python interface unit check runs its two test files instead of an empty directory (T77-44).
- Every runtime reads a restore key from the request the hook left, before canonicalize renumbers the parameters, and the shared case restore_rewritten_key_set_scope covers it (T77-43).
- The Python request-hook coverage module runs its cases per item, so it exits 0 when every case passes (T77-42).
- A PHP restore reads its key from the request the request hook left, before the planner renumbers parameters, as Go does (T77-41).
- The Go tests bind text to date and datetime columns, as the setters do, so the cancel, value-types and conditions tests pass again (T77-40).
- The Go DSN test expects the MySQL session sql_mode that T104 sets, so TestParseDSN passes again (T77-39).
- The parity run exports the SQLite DSN of the Rust savepoint test, so the Rust lib units no longer fail on it (T77-38).
- The PHP extension test helper requiredDsn is declared once, in packages/php/tests/required_dsn.php, so the extension and PHP client bootstraps load it together without a redeclare (T77-37).
- The Go performance gate is a benchmark of the tools root packages/go/bench, which belongs to no implementation, so its go-internal parity unit is removed; the gate still runs as the performance_gate feature. (#T77-8-1-1)
- The physical fixture uses a fixed clock on sqlite and postgres, so the day_of_week and days_ago expectations are derived from fixed dates (T77-33, T77-33-1 open for MySQL).
- The coverage case unit runs its child without the test context (T77-32).
- The SQLite concurrency unit cleans up after its cases run (T77-31).
- The TypeScript generate unit expects the text-form setter declared in docs/spec/dbspec.md (T77-30).
- The vendored kit copies match @polyspec/kit 0.0.53, which carries the K208 trust wrapper (T77-36).
- Open row T77-35 records that each go-orm parity unit runs the whole orm package twice, and the unit should run only its own tests.
- TestConnectionsUseUTC sends the spec datetime form in UTC, and a native time.Time is refused with CODEC_ENCODE (T77-34).
- TestConnectionsUseUTC sends its datetime as the text form the protocol names, so the orm package units pass (T77-34).
- Open row T77-34 records that TestConnectionsUseUTC fails on SQLite with CODEC_ENCODE for a time.Time in a datetime column, which fails the orm package units of the parity run.
- Open row T77-33 records that the physical fixture timestamps are relative to the run time, so the day_of_week and days_ago expectations are not deterministic.
- The physical query-form test runs on MySQL, PostgreSQL and SQLite: the MySQL DSN converts once with its database name, the retired distance case is removed, and the day_of_week count follows the fixture (T77-26, T77-27).
- The physical query-form test runs on MySQL: the MySQL DSN converts once with its database name (T77-26).
- Open rows T77-30, T77-31 and T77-32 record three TypeScript parity unit failures by their first error lines (T77-30 setDay declaration, T77-31 SQLite file, T77-32 recursive node:test run).
- Open rows T77-26 and T77-27 record the physical query-form test failures found by the parity run (MySQL DSN form, place.location).
- The examples tests run the Python thin-slice at its moved location in the Python package (T77-29).
- The models script scan test covers the TypeScript client testing directory, which holds the conformance runner that calls models (T77-28).
- The physical query-form test reads the ORM_TEST DSN names of the sibling physical tests (T77-24).
- parity-check names the missing flowmark binary and its install step before it runs the markdown conformance units (T77-25).
- The dbspec harness test expects the flat case ids that the harness prints, so the dbspec package exits 0 (T77-23).
- make exports the bench DSNs of the run TEST_ENV to the parity units, which previously ran without them (T77-22).
- The TypeScript engine unit expects day_cell in the bench entity order, so it exits 0 (T77-21).
- parity-check names the missing bench DSN before it runs its units (T77-20).
- The interface self-test names the missing TypeScript checker dependency before it runs (T77-19).
- The move of contracts/interfaces.json is held with its plan (T77-8-1-5).
- The generated-model symbols are declared: the live declaration check finds no undeclared public symbol (T77-8-1-4).
- The client-surface symbols are declared: the live declaration check finds no undeclared public symbol (T77-8-1-3).
- The dbspec symbols are declared: the live declaration check finds no undeclared public symbol (T77-8-1-2).
- The PHP and TypeScript adapters live in packages/php and packages/ts; the parent row closes with its four sub-items (T77-9-2).
- The three feature checks pass on main: the Go and PHP dbspec test files that the T77-9-4 landings added belong to schema_definition (T198).
- The conformance result Python check runs in module mode, so its packages import resolves (T77-17).
- The repository convention tests pass: the Python thin-slice is the Python client example, the Rust cases and the TypeScript plan-cache test follow the shared testcase package (T77-18).
- The client-db test and the interface validator read the one language set from config/parity.json (T77-10).
- The parity declaration rules R4 to R10 pass on main: the undeclared suites, the unbound test files, the root and document counts, and the stale client lists are declared (T148-3-7).
- The parity declarations bind the test files added by the T77-9-4 landings to their units and the php support list, so every declaration holds again (T148-3).
- The PHP conformance binding checks that every declared vector is run and that the vector files name the same set (T77-9-4-3).
- The TypeScript conformance suites run every declared vector, and a test checks that each dialect's declared set equals the runner's (T77-9-4-4).
- The push gate runs parity-declarations-check and parity-check: both are in CHECK_TARGETS, the CI groups and the check inputs (T77-12).
- The Python conformance bindings read the runner at its moved path, packages/python/testing/conformance/runner_python.py (T77-9-4-6).
- The Go dbspec subtests report flat case names: no subtest name contains "/", checked by TestSubtestNamesAreFlat (T77-9-4-2).
- The PHP dbspec tests read plans.json through one helper, dbspec_plan_cases.php, which opens the file once per process (T77-9-4-7).
- The Rust conformance binding declares every vector of the vector files and a test checks that each file name is declared (T77-9-4-5).
- The NULL collection key vector relation_null_key records its IR refusal (IR_INVALID, key_by names a nullable column) on SQLite, MySQL and PostgreSQL, and the five runners return the refusal as a result (T77-6-1-7).
- The Python conformance runner has the NULL collection key handler relation_null_key (T77-6-1-6).
- The TypeScript conformance runner has the NULL collection key handler relation_null_key (T77-6-1-5).
- The Rust conformance runner has the NULL collection key handler relation_null_key (T77-6-1-4).
- The PHP conformance runner has the NULL collection key handler relation_null_key (T77-6-1-3).
- The Go conformance runner has the NULL collection key handler relation_null_key; its expectation is recorded with the database runs (T77-6-1-2).
- The generated-file check is kit's pre-commit hook: config/generated.json declares the repository's paths and exceptions, and the local hook and staged check are removed (T77-16).
- The codec, collection and AES public symbols are recomputed from a fresh extraction and none stays undeclared; the Korean model_generation sentence now names Rust as the English one does (T77-8-1-1).
- The performance gate names only the parity units that exist: its dropped Go unit and Go owner are removed, and the static check passes (T77-15).
- The Python interface and conformance tests read each symbol's signature from the {exported, signature} snapshot, end with testcase.main, and belong to their features (T77-14).
- Generated files are never tracked: AGENTS.md states the rule and its named exceptions, .gitignore covers vendor/, venv/ and *.egg-info/, and make staged-check with the pre-commit hook refuses a staged generated path (T77-13).
- The ten Go dialect physical test files and probe_test.go belong to the schema_definition feature, and the static feature check passes. (#T198-1)
- The Python conformance runner, the Python dbspec comparator and the Python and Rust interface extractors live in packages/python and packages/rust under testing/, with the Python tests in packages/python/tests, and the layout, the parity support lists and the interface checker name the new paths. (#T77-9-3)
- The collection-identity, plan-cache and dialect probe tests, the Go coverage gate and the tracked fixture tests/collection/keys.json are inputs of feature verification commands, so every tracked file selects a behaviour test. (#T198-2)
- The PHP and TypeScript dbspec adapters live in packages/php, packages/php-ext and packages/ts under testing/dbspec, and the comparators, the Go physical tests and the layout name the new paths. (#T77-9-2-4)
- `make -s feature-unit-check/docs` passes: docs/features.md and docs/features.ko.md are regenerated from contracts/features.json. (#T198-3)
- The TypeScript and PHP interface extractors live in packages/ts/testing/interfaces and packages/php/testing/interfaces, with the TypeScript extractor project beside them, and the interface checker, the layout and the dependency records name the new paths. (#T77-9-2-3)
- The TypeScript client exports the codec functions as `decode` and `encode`, the names that Go, PHP, Rust and Python use; the aliases `decodeCodec` and `encodeCodec` are removed. (#T77-8-1-1)
- The TypeScript conformance runner, its result helper and the result helper test live in packages/ts (testing/conformance and tests), and the parity check reads them there. (#T77-9-2-2)
- The features' `clients` flags are removed from contracts/features.json, the schema and scripts/features, and `tests.language-parity` in contracts/rules.json uses the parity check. (#T77-10-2)
- The PHP conformance runner and its result helpers live in packages/php/testing/conformance, and the PHP result-helper test loads them from there. (#T77-9-2-1)
- The Go conformance runner, the dbspec Go programs, the Go symbol extractor and the dialect physical tests live in packages/go/internal, and no Go adapter stays under tests/ except the cross-language tools. (#T77-9-1)
- The error catalogs of TypeScript and Python are exported as `codes`, as Go, PHP and Rust export theirs. The public API of the clients is declared as units in config/parity.json, and interface-check checks the error catalog units of every client against docs/spec/errors.yaml. (#T77-8)
- The Rust model generator checks its generated files with `Builder::check`, as the Go `orm-gen gen --check` does; the thin-slice demo has TypeScript and Python programs, whose stdout the output comparison checks against Go; and the styled value types of TypeScript and Python are in docs/spec/codec.md and docs/spec/dbspec.md. (#T148-3-7-5)
- Every TypeScript and Python error site uses the generated catalog constants, and a drift test fails on a stale catalog. (#T148-3-7-3)
- The TypeScript and Python clients name every error code through a generated catalog, which the parity check compares with docs/spec/errors.yaml. (#T77-4)
- The Rust ir-answers check compiles on main. (#T190)
- Python reads time and date cells on MySQL and PostgreSQL. (#T117)
- toArray writes datetime and time with six fraction digits in every client. (#T121)
- The optimistic update binds the loaded row's version as canonical text in Go and Rust. (#T89-3-2)
- The conformance runners send date, time and datetime inputs as canonical text. (#T89-3-1)
- The docs rules check passes `make lint-ts`: its file is read through a shape guard, and the line filter uses `startsWith`. (#T77-11-2)
- Rows load with their identity keys, and compiled statements execute through a public call in every client. (#T120)
- Generated setters take text for date, time and datetime in every client. (#T189)
- The documents name every declared client in their tables and set enumerations, and the docs rules check them. (#T77-11-1)
- The documents name every implementation of config/parity.json, and the docs rules refuse a stale count. (#T77-11)
- make check and CI run the PHP extension's dbspec suites. (#T188)
- Every AES vector has an explicit name that each client reads. (#T112)
- A PHP datetime without an offset binds in the connection zone, including a daylight-saving wall clock. (#T116)
- Date, time and datetime parameters take the canonical text form in every client; a native value is refused with CODEC_ENCODE. (#T89-3)
- The TypeScript build orders the language package before the LSP by project references. (#T187)
- The dialect facts record the row order of RESTRICT checks on each database. (#T100)
- A PHP rollback test finds its session by connection id, not by a count of sessions. (#T53)
- The PHP extension runs the dbspec sets and schema-definition suites from its own package. (#T111)
- The begin message carries the read-only option in every client. (#T107)
- A changed read at commit is refused, not retried. (#T106)
- TypeScript and Python decode a request's shape as strictly as Go. (#T110)
- The ip encoder refuses white space instead of trimming it. (#T109)
- A single-stage text stage list stores the text alike in every client. (#T108)
- A relative time outside 0001 to 9999 is NULL on every database. (#T98)
- The dbspec check and the IR validator read one meet table per client. (#T96-1)
- A joined child excludes soft-deleted rows on every database. (#T95)
- A fixture of IR read answers proves one decoding in every client. (#T105)
- Every client sets one declared MySQL session sql_mode. (#T104)
- MySQL writes hex encoded by the client, as the other databases do. (#T103)
- Probes and a citation check record the order of faults of one statement. (#T101)
- AGENTS points to the local links rule of kit for 0.0.x development. (#T186)
- The Python conformance target runs through the case harness on the databases of the run. (#T148-3-6-1)
- Parity builds the PHP extension and passes every PHP binding. (#T148-3-8)
- The Python conformance runner runs as a test. (#T148-3-6)
- The feature-coverage bindings run every case under its id. (#T148-3-5)
- Each parity binding runs one suite. (#T148-3-4)
- Parity binds every feature unit in every implementation. (#T148-3-3)
- Shared vector case ids use no slash, so parity binds every case. (#T148-3-3-1)
- The Python bind vectors run through the case harness. (#T89-4)
- Every client refuses NULL for a non-null column before any statement. (#T90)
- A contains value binds as text or NULL in every client. (#T80)
- Every client checks each parameter against its slot type before a statement, proven by shared bind vectors. (#T89)
- A feature coverage process runs up to the longest test class, so a test is stopped by its own deadline. (#T185)
- The repository takes kit 0.0.53. (#T184)
- Every planner reads and binds a PostgreSQL uuid in one form. (#T92-1)
- The clients report the affected count of a write by one rule, proven by a conformance vector through a test entry point. (#T88-1)
- A conformance vector proves that an upsert names exactly one conflict key on every database. (#T87-1)
- The MySQL migration fixture removes its temporary root and stops its servers when its setup fails. (#T183)
- The committed Go models hold the service relation of a service region. (#T85-1)
- The Rust value test asserts the time rule of T92. (#T92-2)
- Go matches a bool if_parent by the column logical type, and a conformance vector pins flattened relations. (#T85)
- A conformance vector pins the scalar column subquery on every database. (#T84-1)
- A conformance vector pins the NULL order of ascending and descending reads on every database. (#T82-1)
- The Go bind vector test reports as a case with its deadline. (#T91-1)
- The TypeScript symbol record holds the contains methods of CompositeAccount. (#T79-1-1)
- push-gate starts the Node.js release of mise.toml again. (#T181-4)
- A statement reads one clock value at the column precision on every database. (#T93)
- Every client binds datetime and time values with exactly p fraction digits. (#T92)
- Every client writes a time, date or datetime string of the markdown message in one form. (#T91)
- The TypeScript conformance runner types its contains calls. (#T79-1)
- MySQL contains_binary renders LIKE under the binary collation instead of the deprecated LIKE BINARY. (#T81)
- MySQL contains folds only ASCII case, as PostgreSQL and SQLite do. (#T79)
- kit-check owns the mise lock sidecars beside mise.lock. (#T181-3)
- The Python dbspec introspection and apply take a public Connection protocol. (#T181-2)
- The lock sidecar of the vulture tool is tracked beside mise.lock, so a fresh checkout installs its tools. (#T181-1)
- The repository takes kit 0.0.50: node is a tool of mise.toml, every recipe starts its tools by their paths, and make lint-python runs ruff and vulture and passes. (#T181)
- The PHP and PHP extension vector runners report every schema refusal through the fork min-0-max/json-schema v2.6.0-p1, as the other runners do. (#T137-1-4-3-1)
- Every implementation reads an empty key_by as absent; protocol.md states it. (#T77-7)
- Python runs every shared suite; its aggregates answer CODEC_DECODE for a value out of range, a SQLite DSN with a broken percent escape is CONFIG, and a MySQL install publishes its statement events. (#T77-3)
- The Python codec and apply runners run in the shared checks; the Python PostgreSQL apply restores lock_timeout with a $1 marker. (#T77-2)
- The Python tests report through the shared harness: RUN with a deadline, STEP, PASS, FAIL and SKIP, as the other implementations do. (#T77-1)
- The PHP client reads YAML through the fork min-0-max/yaml v1.0.0-p1, which resolves the core schema by the YAML 1.2.2 table; a consumer declares the fork's vcs repository, as docs/operations/packaging.md shows. (#T142-1-1)
- The repository checks read the Makefile through one reader that names every target with its prerequisites and recipe. (#T137-1-4-2-2)
- The repository checks read the run texts of the workflows and the Makefile recipes as shell commands, not lines or patterns. (#T137-1-4-2-1)
- The Rust show-create vectors run through the public catalog path, each case a trial named by its id. (#T148-2-1)

## 0.0.18

- The Unicode table generator emits the TypeScript lookup as a checked read. (#T180-2)
- The Python wheel carries no test extra: the tests' JSON Schema validator is a PEP 735 dependency group; the TypeScript build keeps its incremental record out of the tree. (#T180-1)
- The TypeScript packages and the site pass the lint of kit 0.0.47 at the root's strictness; packages/ts builds through TypeScript project references. (#T137-1-4-7-1)
- orm-gen's TypeScript output reads entities and columns with checks that throw naming them, with no non-null assertion or cast, so generated models pass the lint of kit 0.0.47; Core.jsonColumn reads an ordered_json column. (#T179)
- The repository takes kit 0.0.47, and the scripts and tests pass its TypeScript lint without a disable or a cast. (#T137-1-4-7)
- go-vet-check owns the Go analyzers of tests/analyzers. (#T137-1-9)
- Every dbspec compare runner validates the vectors against the shared JSON Schemas of tests/dbspec/schema with its ecosystem's validator; the runners' own field checks are removed. (#T137-1-4-3)
- The repository checks read the workflows as YAML documents, the shell commands with the unbash parser, and Go source with go/analysis analyzers that go vet runs (make go-vet-check). (#T137-1-4-2)
- The introspection and native rule tests read the moved schema and contracts, and tests/testcase.mts gives a case a temporary folder that it removes when the case ends. (#T137-1-8)
- bench/ is benchmarks/, the shared bench schema is contracts/fixtures/bench/, and the Composer release is the http:composer tool of mise.toml; .composer-version is removed, and make layout-check passes. (#T137-1-7)
- The Go programs and tests under tests/ and examples/ are the modules tests/go.mod and examples/go.mod of the root go.work. (#T137-1-6)
- The Go module is github.com/polyspec/orm/packages/go, released by the tags packages/go/vX.Y.Z: engine/*, generator and cmd/orm-gen are packages/go/engine/*, packages/go/generator and packages/go/cmd/orm-gen, and internal/testcase and internal/procevent are packages/go/testcase and packages/go/procevent. A Go consumer requires the new module and imports its paths. (#T137-1-5)
- The conformance orchestrator and the interface checker are TypeScript (tests/conformance/check/main.mts, tests/interfaces/check/main.mts); their Go programs and internal/stmtdiff are removed. (#T137-1-4-6)
- The socket folder of the test servers is named by SHA-256 of the checkout path, and AGENTS.md states that a worktree's servers stop before the worktree is removed. Stop running servers before taking this change: their sockets keep the earlier name. (#T137-1-4-10)

## 0.0.17

- The server tests judge an ended process by its state, so a zombie that its adopting process has not reaped yet counts as ended. (#T177-3)
- startLogged reads the server's log from its size before the spawn, so a server that writes its ready line at once on Linux is seen. (#T177-2)
- Every client requires ordered-json 0.0.9; the Go client imports it from its module path github.com/polyspec/ordered-json/packages/go. (#T178)
- The package check gives the external crate of the Rust client its lock, so it builds offline from the fetched git revisions. (#T177-1)
- scripts/bench-db.mts installs and seeds the bench database through the TypeScript client; the Go programs bench/install and bench/seedaes are removed. (#T137-1-4-9)
- The Python client refuses a SQLite older than 3.46 with CAPABILITY_UNSUPPORTED, as the other clients do. (#T176)
- The infrastructure scripts under scripts/ are TypeScript: the run databases (scripts/check/databases.mts, make databases-create), the test servers (scripts/test-servers.mts) and every command script. The decimal database is installed by the TypeScript decimal model, so the database setup needs neither PHP nor Composer; tests/new-session and the CI SQLite check of PHP are removed. (#T137-1-4-5)
- The PHP orm-gen scan resolves calls on `(new C)`, on the invoked model `(new C)($db)` and on chains of either. (#T175)
- make scripts-typecheck builds the dbspec language service it type-checks against, and the MySQL migration case runs the migration script of the checkout. (#T137-1-4-8)
- The TypeScript symbol record holds the chain methods that the conformance runner calls. (#T174-1)
- config/layout.yml declares tests/generator, the scan vectors of the PHP and the node generator. (#T172-3)
- config/layout.yml declares the S9 exceptions with their reasons: the runners and symbol extractors of one language, the Go tests of the dialect rules, the Unicode table and codec vector generators, and the programs that need setsid or process exit notifications; tests/codec/gen-aes.sh, which generated nothing, is removed. (#T137-1-4-4)
- The scripts and tests of the infrastructure are TypeScript that make scripts-typecheck checks; they read every JSON file through a JSON Schema and use node:util parseArgs, minimatch, path.posix and semver instead of their own versions. (#T137-1-4-1)
- The TypeScript orm-gen scan declares the chain methods called in not, andNot and orNot callbacks, as it does for and and or. (#T174)

## 0.0.16

- The PHPStan case of the PHP scan reads PHPStan's JSON report and matches the identifier of each error, which the raw format of the CI runner leaves out. (#T172-2)
- The PHP performance gate case runs the PHPUnit of the development root, and docs/features.md states the PHP scan. (#T173-1)
- The PHP tests run on the PHPUnit of the development root (vendor-php), and the released composer.json of polyspec/orm and polyspec/orm-dbspec declare no repositories, development requirements or platform settings again. (#T148-1-1)
- The review record lists nikic/php-parser, which the PHP orm-gen scan requires. (#T172-1)
- The PHP orm-gen takes `--scan`: it reads the sources with nikic/php-parser, declares each chain method they call on a model as a typed `@method` tag, so PHPStan finds it, and rejects an unknown column, operator or argument count during generation; a symlink in a scanned directory is an error. (#T172)
- The Rust validate and codec vectors run on the workspace with its test features, and the plan vectors report a measured CPU time above its bound as a warning. (#T148-2-2)
- Go, TypeScript, Python and Rust report each shared-vector case under its id: Go subtests, one TypeScript test per case, Python load_tests cases and Rust libtest-mimic trials; Rust validates through the public engine::validate. (#T148-2)
- The PHP client's and the extension's tests run on PHPUnit: the shared vectors through data providers named by their case ids, and orm's own PHP test runner is removed. symfony/yaml is 8.1. (#T148-1)

## 0.0.15

- CI downloads the Rust crates after it restores the crate cache: make install-rust is install-rust-toolchain and install-rust-crates. (#T171-1)
- make release-consumer-lock runs with npm's allow-remote=root, as the consumer install does, since the consumer lock resolves the URL of @polyspec/ordered-json. (#T171)
- rustls is 0.23.46 in the Rust locks, for the advisories RUSTSEC-2026-0346 to RUSTSEC-2026-0349 of 0.23.45. (#T171)
- Generated TypeScript models import only the runtime names they use and declare the chain methods as class fields instead of a merged interface. (#T170)
- Generated Rust models carry no allow attribute: mut v only where a conversion takes the value, and a Default impl beside the no-argument new. (#T137-1-3-1)
- make run-databases TARGETS=conformance-check VECTOR="..." runs the named conformance vectors on the provisioned bench databases, and RECORD=1 records a full run; RECORD with VECTOR is refused. The conformance README describes five clients. (#T169-2)
- The shared decode vectors compare JSON values in every client, and the accepted YAML keys 1, "true", tRUE, nULL and .InF are shared vectors. PHP skips the three mixed-case keys for the defect of the YAML dependency that T142-1-1 tracks. (#T142-11)
- The conformance vector creates_and_save records the insert parts of T169. (#T169-1)
- Multi-row inserts run as power-of-two parts capped by the bind limit (999 on SQLite, 65535 on MySQL and PostgreSQL) inside the transaction, so the PHP plan cache holds a bounded number of insert shapes in every client. (#T169)
- TypeScript types a plain YAML map key by the yaml library's own core-schema tags instead of a case-insensitive regex, so tRUE, nULL and .InF stay string keys. (#T142-10)
- Every client refuses a YAML anchor with or without an alias, every explicit tag including the core tags, and a text with no document, as docs/spec/codec.md now states. (#T142-9)
- Go reads YAML with goccy/go-yaml and Python with rapidyaml, both keeping U+0085 as content; Python writes with ruamel.yaml, and PyYAML is removed. The next_line exclusions are gone. (#T142-2)
- The PHP client reads YAML with purrphp/yaml and its core schema, so 1_000, dates and timestamps stay strings as in every other client. orm refuses documents, aliases, anchors, tags, merge keys and duplicate keys on its node model. Two vectors stay excluded for defects of the YAML dependency, tracked by T142-1-1. (#T142-1)
- The Rust workspaces deny unsafe code and allow attributes without a reason. The planner's lifetime transmute is removed, the thread CPU clock reads through rustix, and only the SQLite authorizer callback keeps unsafe code, with its reason. (#T137-1-3)
- T166: every client parses a document set through one set parse (Go dbspec.ParseSet, TypeScript parseDbspecSet, Python parse_dbspec_set, PHP and the extension Dbspec::parseSet, Rust dbspec::parse_set): each text is named by its parser's header, a repeated name is the later text's diagnostic, and the shared vectors tests/dbspec/set-parse.json hold the rule; every header read by string matching is removed.
- T165-4: kit-check takes mise.toml and mise.lock as its inputs.
- T167: the PHP client declares @template generics for the result of Db::transaction and the rows of a model (Collection, Page, gets, getsPage), so PHPStan level 9 types them.
- T168: python-venv-check asks mise for the Python of mise.toml instead of reading the file with sed.
- T165-3: orm takes kit 0.0.42, so go vet and go test no longer walk the Go that mise installs under var/tools.
- T165-2: the npm package checks read the npm 12 form of npm pack --json, install-cli admits its URL dependency at the root, workflows take Go from mise.toml, and the editor job downloads the Go modules.
- T165-1: orm takes kit 0.0.41, whose mise.lock pins linux-arm64 for the ARM runners.
- T137-1-2: the PHP client loads by PSR-4 alone: every class has its own file, packages/php/composer.json has no classmap, the test models load by autoload-dev, and the test autoloader is Composer's.
- T137-1-1: config/layout.yml declares packages/dbspec-vscode, and no check sets PYTHONPATH.
- T135-1: the comments of scripts/test-servers.sh and its tests are in English.
- T128-8-3: make install-vscode installs the minimum VS Code of the extension with kit's installer, make dbspec-vscode-integration runs the five editor fixtures inside it, and the editor job of CI runs it on a virtual X server.
- T165: orm takes kit 0.0.40: the tools of mise.toml (Go, Python, uv, Composer, alint, govulncheck, cargo-audit) install from mise.lock, `.python-version` is removed, install-python and python-venv-check read the Python of mise.toml, and CI installs the tools with make install-tools.
- T137-4: the CI Node step installs the interface TypeScript in a second make, after install-packages has installed kit.
- T137-3: CI installs the TypeScript of the interface reader, and the PHP extension's arginfo header matches its stub after the rename.
- T161-1: Python generated models declare the condition method of every column and the tuple method of every key prefix, and every chain method is typed to return the model.
- T128-9: the release publishes @polyspec/dbspec-language, @polyspec/dbspec-lsp and @polyspec/dbspec-codemirror as npm archives with a consumer smoke each, and the VS Code extension keeps the release version; make release-assets builds them, and AGENTS names the editor packages.
- T137-2: the dependency review records every lock of the kit switch; the TypeScript 6 interface reader and the sprintf-js advisory that kit accepts are stated exceptions.
- T137: orm takes kit 0.0.38 as the package @polyspec/kit and follows its standards: the client folders are named by runtime (packages/go, packages/php, packages/python, …), AGENTS.md links the kit principles, the toolchain floors follow the kit pins, and the TypeScript interface reader runs on TypeScript 6 until TypeScript 7 has a stable API; the layout findings are T137-1.
- T137 (breaking): orm takes kit as the npm package `@polyspec/kit` (`make install-tools TOOLS=npm`, `make install-packages`) instead of a vendored copy, and links its PRINCIPLES.md. The client folders are named by runtime: `packages/go`, `packages/ts`, `packages/php`, `packages/php-ext`, `packages/python` (the subdirectory of the Python client) and `packages/rust`, whose crates lie in `build/` and `schema/`; the Go import paths are `github.com/polyspec/orm/packages/go/...`. The toolchain floors are the kit pins: Node.js 26.11.1, PHP 8.5, Python 3.14, Go 1.27.2, Rust 1.99.0 and TypeScript 7.0.2; `orm-gen --scan` of the TypeScript client parses with oxc-parser, so `@polyspec/orm` no longer depends on the TypeScript compiler.

## 0.0.14

- T163: Python `RuntimeModel.load_set` and TypeScript `loadSet` return the parsed documents of a generated schema value, as PHP, Go and Rust do.

## 0.0.13

- T161-2: the model-methods case keeps PHPStan's cache in its own folder, and the runner's parts table names it.
- T161: PHP generated models declare their query methods as real typed methods (column conditions, orders, aggregates, key-prefix tuples, index hints), so PHPStan sees them; docs/operations/usage.md names what stays on `__call`.
## 0.0.12

- T159: the request hook receives the request's bound parameters read-only in every client: Node and Python as the third argument, Go as a copied slice, Rust through `RequestParams::get`; PHP already had `$r->params`.
- T156-2: the committed Go markdown model carries the key-prefix methods.
- T139-2: the Rust symbol record holds the saphyr YAML reader.
- T156-1: the key-prefix tests follow the installed Python package and the testcase rule, and the markdown fixture models carry the key-prefix methods.
- T139-1: the Rust codec writes YAML with serde-saphyr and reads it through saphyr-parser, so it stores every string of the common value model (`0o17`, control and C1 characters, U+FEFF, U+FFFE, U+FFFF) as the other clients do; yaml-rust2 is removed.
- T156: every generator declares a typed method for every prefix of every key (primary key, unique keys, indexes), whether or not a scanned source calls it; Python resolves the same names at run time.
- T143: docs/spec/dbspec.md states which Windows reparse tags each set reader detects: Go, Rust and the PHP extension every name surrogate, TypeScript and PHP symbolic links and junctions, which Node and PHP `lstat` expose.
- T142-8: the targets whose node scripts run PHP check vendor-php first.
- T142-7: every make target whose PHP script loads vendor-php checks it first (31 targets).
- T134-1: the checkout wrapper packages/orm-python/bin/orm-gen is removed; the docs name the installed `orm-gen`.
- T142-6: `interface-check` checks the PHP vendor first.
- T142-5: `codec-check` checks the PHP vendor first and names `make install-php` when it is missing.
- T158-4: the dbspec-vscode integration names `make dbspec-vscode-integration` when `--vscode` is missing.
- T158-3: `codec-check` declares the python need, so the job that runs it provisions the venv.
- T158: orm main CI is green again after T134, T135 and T142.
- T158-2: the socket refusal test lengthens the socket folder, as T135 placed it.
- T158-1: the Go symbol records hold the YAML core functions of T142.
- T134: the Python tests import the package installed editable into the venv; no test changes `sys.path` or `PYTHONPATH`, and a check refuses one.
- T142-3: `codec-check` runs the Python codec vectors.
- T142-4: `codec-check/rust` builds the lease tool it runs.
- T135: the test server sockets live in `/tmp/orm-servers-<cksum of the checkout>`, owned by the checkout, so a long checkout path stays within the Unix socket path limit.
- T142: Go and Python read plain YAML scalars by the YAML 1.2 core schema (`0b101`, `+0x1`, `1_000` and dates stay strings), with shared `yaml_core` codec vectors; PHP (T142-1) and U+0085 (T142-2) are skipped by name until fixed.
- T128-8-2: `packages/dbspec-vscode` is the VS Code extension of dbspec: the language, semantic token colours with no grammar, and the bundled language server, built as a `.vsix`.
- T157: the markdown conformance pins flowmark main at 8b5d16a.

## 0.0.11

- T140-1: the Markdown IR executor table of docs/spec/dialects.md mirrors the flowmark that the markdown conformance pins.
- T153: the Python Collection's get and fetched import key_text and no longer raise NameError.
- T147: the interface check refuses a public component method that no rule declares.
- T147-5: Rust's AesKeyring lists its key versions, and the rule AESKeyring.versions is declared.
- T147-2: Python has Db.stats, Utils.privileges, Utils.stats and SchemaUtils.exists, installed and empty, PHP has Db::stats, and their interface rules are declared.
- T147-3: the interface manifest marks its internal components, and the rule check covers the public ones.
- T147-4: the manifest check refuses a rule whose method its component lacks, and SchemaUtils lists addTablesAndColumns.
- T147-1: the interface rules declare Db.close, the Collection methods get, first, keys, connect, delete and toArray, and Utils.setLocal and local.
- T140 (breaking): a restore picks its key after the request hook from the set values and the and-joined eq conditions, so a hook's condition narrows a restore as it narrows an update; the model sends its set only (docs/spec/protocol.md 1.5).
- T133: every runtime reads tests/dbspec/cases.json with one strict reader that refuses a missing or unknown field in any section.
- T154: the Python Mermaid test imports only through the declared PYTHONPATH.
- T149: the feature coverage runs Python owners, and schema_definition covers Python with its seven cases.

## 0.0.10

- T144: the PHP `orm-gen` takes its autoloader by Composer's lookup and names a missing one; the documents run `vendor-php/bin/orm-gen`.
- T126-2-1: the workflow test judges the workflows among the vendored files only.
- T136-1: the install-python test asserts that uv is installed before Python.
- T128-2a-8: the model generation coverage of Go and PHP generates through the set file.
- T146: the module list of orm-schema's dbspec is formatted, so `make rust-fmt-check` passes.
- T151: the editor packages are classified as not released until the editor stack release, every new file is owned by the check that reads it, the syntax vector generator has a regeneration test and `make install-cli-check` installs dbspec-fmt into a temporary prefix.
- T126-2: orm vendors kit v0.0.35 and its PRINCIPLES.md.
- T150: docs/operations/usage.md names Python's `orm-gen gen --check`, and docs/operations/packaging.md how the Python client takes its schema.
- T128-2a (breaking): a document set is declared once, in `dbspec-set.json`, which every client reads and every generator takes.
- T128-2a-7 (breaking): every document names the set file as the only form of a generator's document set, the interface rule `Dbspec.readSet` declares the set reader of every client, and the parity unit `dbspec-set-files` declares its vectors.
- T136: `make install-python` installs uv before the Python it installs, so a fresh checkout and CI build the Python venv.
- T128-2a-4-1: the Python tests generate their models from set files, so the python check passes with the set-file generator.
- T128-6: `@polyspec/dbspec-lsp` (`packages/dbspec-lsp`, command `dbspec-lsp`) is the dbspec language server: diagnostics, semantic tokens, folding and formatting, with each document's set from its nearest `dbspec-set.json`.
- T128-5-1: `dbspec-fmt` formats dbspec documents from the command line (`--write`, `--check`, standard input), each in the set that `resolveSet` finds from the nearest `dbspec-set.json`; `make install-cli` installs it.
- T145: the TypeScript client locks mysql2 3.24.6.
- T128-2a-6-1: the Rust set vector test warns on a slow run instead of failing it, and `dbspec-rust-check/set` runs its two tests as separate parts.
- T128-2a-6 (breaking): the Rust build generator takes the set file with `Builder::set(path)`; `Builder::new([..])` and `uses` are removed, and `cargo:rerun-if-changed` names the set file and every listed document. `dbspec::read_set` reads a set file.
- T128-2a-5-1: the PHP set targets run only their set tests; the show-create test runs once, in its own target.
- T128-3: every client and the PHP extension give the same syntax tokens and formats, which `make dbspec-compare-check` now compares and the parity unit `dbspec-syntax` declares.
- T128-3p: every client's parse result carries the declaration positions, compared across the clients by `make dbspec-compare-check`.
- T128-2a-5 (breaking): the PHP `orm-gen gen` takes `--set <dbspec-set.json>`; the positional files and `--use` are removed. `Dbspec::readSet` and its native twin in the PHP extension read a set file.
- T128-8-1: `@polyspec/dbspec-codemirror` (`packages/dbspec-codemirror`) is the CodeMirror 6 extension of dbspec: token colours, lint diagnostics, folding and formatting on Shift+Alt+F, from the language service.
- T128-2a-2 (breaking): the Go `orm-gen gen` takes `--set <dbspec-set.json>`; `--document`, `--use` and `runtimemodel.LoadFileSet` are removed. `dbspec.ReadSet` reads a set file and `runtimemodel.LoadSetFile` loads one.
- T128-2a-3 (breaking): the TypeScript `orm-gen gen` takes `--set <dbspec-set.json>`; `--schema` and `--use` are removed. `readDbspecSet` reads a set file, and `@polyspec/orm/dbspec` exports the pure `parseSet(bytes, path)`.
- T128-7: the documentation site renders ```` ```dbs ```` fences through the dbspec language service, with a colour per token class in the light and the dark theme; a fence of a set declares `set=` and `document=`, and any diagnostic of a fence fails the docs build.
- T128-2a-4 (breaking): the Python `orm-gen gen` takes the set file with `--set <dbspec-set.json>`, parsed by argparse; `--schema` and `--use` are removed. `read_dbspec_set` reads a set file by docs/spec/dbspec.md "Document sets".
- T128-2a-1-2: the set reader refuses a repeated key in any object of the set file and reads `schema` as an IEEE 754 double.
- T139: the Rust YAML codec reads and writes with yaml-rust2 alone and decodes by the YAML 1.2 core schema (`07` is 7, `0b101` and `tRuE` are strings, integers beyond i64 and `1e400` are `CODEC_DECODE`); serde_yaml_ng and the unmaintained unsafe-libyaml leave both Rust locks. A string that yaml-rust2 cannot write so that it reads back unchanged is `CODEC_ENCODE` (T139-1).
- T128-2a-1-1: the set reader examines the root without its trailing separator, so a symbolic link at the root is never followed.
- T141: docs/spec/dbspec.md "Files" names the Python byte check `read_dbspec_bytes` and file reader `read_dbspec_file`.
- T128-2a-1: docs/spec/dbspec.md "Document sets" specifies the set file `dbspec-set.json` and its reader, and `tests/dbspec/set-files.json` holds its 61 file-tree vectors.
- T129-2: the PHP extension has `Native\Names` with `render`, `ofTable` and `column`, the renderer names of the PHP client.
- T128-3-1: every runtime parses the complete lines before an encoding stop and reports their diagnostics before the encoding diagnostic, as Go does.
- T128-5-2: the dependency policy states why packages/dbspec-language keeps typescript 6.0.3: its module graph test needs the typescript API that typescript 7 lacks.
- T138: the documentation site draws diagrams with mermaid 12.2.0.
- T128-3-3: the Go, Rust and TypeScript tests of syntax analysis, declaration positions and the browser entry start their cases through the case harness, so each has its deadline and RUN line.
- T128-5: `@polyspec/dbspec-language` (`packages/dbspec-language`) is the dbspec language service: `openDocument(text, {set})` gives the diagnostics with UTF-16 ranges, the tokens, the folding ranges of the blocks and `format()`, through the browser-safe parser entry only.
- T128-3-2: `tests/dbspec/syntax.json` holds the tokens of the nine cases that T129 added and no longer names the three it removed.
- T128-4-1: `@polyspec/orm/dbspec` is browser-safe again: the renderer names take SHA-256 from `@noble/hashes` and their byte length from `TextEncoder` instead of `node:crypto` and `Buffer`, and the browser entry test follows a declared browser package into its modules.
- T128-2-3: the editor packages are placed by the folder standard S5: `packages/dbspec-language`, `packages/dbspec-lsp`, `packages/dbspec-codemirror` and `packages/dbspec-vscode`, each a component of its own, instead of the nested `packages/dbspec/<part>/` that S5 refuses.
- T132: the Go generator scan loads a build-tag or platform configuration only for the packages that hold its files, so the model_generation coverage case of Go finishes in about 30 s instead of passing the 120 s deadline under load.
- T129-1: the interface symbols of the renderer names are recorded: contracts/symbols holds the T129 snapshots, and contracts/interfaces.json holds their hashes, so the interfaces check passes on the T129 tree.
- T130-3: docs/spec/interfaces.md "Finder chains" states the finder rule per runtime, docs/operations/usage.md points to it, and each T130 code commit records the five symbols that it changed, so the interfaces check passes at every commit of the branch.
- T130-2: docs/operations/usage.md states the finder rule exactly: PHP resolves a chain at call time, and a TypeScript chain works after model generation scans the code that calls it. The generators are unchanged.
- T130: an audited table that is also immutable is introspected: each of the immutable and audit settings is recognized by its own recomputed trigger names instead of by a count of triggers, and a table with both settings has the union of their renderer outputs, which its trigger set must equal exactly (docs/spec/dialects.md "Triggers").
- T129: a renderer-generated name (the CHECK `<table>$<column>`, the triggers and functions `<table>$<event>`) is the plain form when it has at most 63 bytes, otherwise its first 54 bytes, a `$` and the first 8 lowercase hex digits of its SHA-256, so an audited table with a long history name is declared; a declared name is still refused, never shortened (docs/spec/dbspec.md "Names").
- T125-8: the Go request hook tests start their cases with the shared testcase package, the Python interface test counts the fifteenth connection rule, and `docs/features.md` lists the feature `request_hook`.
- T125-7: the Python identity load test is `identity_load.py`, so `make python-unit-check` no longer runs its server cases; `make python-identity-load-check` runs them.
- T125-4: the request hook is the feature `request_hook` of `contracts/features.json`, whose Go, PHP, Rust and TypeScript owners pass the five shared cases on MySQL, PostgreSQL and SQLite.
- T125-3: the development rules forbid symbolic links only in what this repository creates, take the standard tool of each ecosystem as it is with its own behavior, and resolve paths declaratively or by discovery.
- T125: every client takes a request hook on a connection handle: `withRequestHook` (Go `WithRequestHook`, Rust and Python `with_request_hook`) returns a handle on the same connection whose hook receives each request of a read, count, page, insert, update, delete, restore and getQuery right before planning and may add predicates, assignments and parameters; the planner validates the changed request, the plan cache keys on it, and rows and transactions of the handle keep the hook.
- T128-4: `@polyspec/orm/dbspec` is a browser-safe entry with parse, emit, analyze, format and readDbspecBytes; its module graph holds no Node module, Node global or driver, and a test follows the graph to prove it.
- T128-2-2: the syntax analysis rules ground their exclusion of regex grammars on valid column names that are keyword words (`key`, `text`, `references`), instead of the reserved `table`.
- T128-2-1: the dbspec syntax analysis rules define a number by its form, a word of digits with an optional fraction, and keep its `number` class on a line read only lexically.
- T128-3s (breaking): a repeated `state_machine` line of one machine is a `setting` error at the later line in every runtime: one `initial` and one `terminal` line per state, and one transition line per `<from> -> <to>` pair whatever its `require` list. Such a document was accepted silently before.
- T128-2: the dbspec specification states syntax analysis (`analyze` and its token classes, for every implementation, from the one parser) and formatting (`format` as `emit(parse(text))`, refusing a document with a diagnostic, with its three invariants), and docs/spec/editor.md states the editor tools: the browser-safe parser entry, the language service, the adapters, their import rules, results, ecosystem mechanisms and fixtures.
- T126-1: orm vendors kit from its release tag v0.0.31 instead of a branch, declares its Python through uv (`pythonBuild.version` and `uv` in config/toolchain.json), and its `release-assets` declares the installs it builds on (`install-go`, `install-node`).
- T128-1: the Go editor tools added after 0.0.9 (`cmd/orm-fmt`, `cmd/orm-lsp`, `cmd/orm-tokens` and the regex classifier `engine/dbspec/tokens.go`) are removed before any release, with the docs bridge that built a Go binary; T128 rebuilds the editor stack as a standard of every runtime.

## 0.0.9

- T126: release 0.0.9: the manifests, the locks, `VERSION`, the contract version of `contracts/features.json`, the version of the PHP extension and the documents declare 0.0.9, `tests/release-consumer` holds the locks of the archives of 0.0.9, and the Python wheel `polyspec_orm-0.0.9-py3-none-any.whl` is among the release assets; the section of the never-tagged 0.0.8 joins 0.0.9.
- T65: the Python client reaches a corpus through the markdown DSN, one server connection per `Db`, and passes the cases of `tests/markdown/cases.json` against the pinned flowmark build; its executor module, lost from main in a rebase, is tracked again.
- T102: the table "Markdown IR executor" of dialects.md mirrors flowmark's spec 60 row by row, one row per row with its ruling split into Result and Rule, at the flowmark version pinned in `tests/markdown/flowmark.version` (now flowmark `444f27f`); `make markdown-table-check` compares the two and fails on a difference.
- T84: a scalar column subquery (`columns.sub` with no `agg`) yields at most one row by its shape: it has `limit` with count 1 and an `order` that includes every primary key column and no `random` item, else `IR_INVALID` in every implementation (MySQL answered 1242 and PostgreSQL 21000 for several rows, SQLite returned the first); the planners render `ORDER BY … LIMIT …` for it. The conformance vector is `T84-1`.
- T82: an order item sorts NULL before every value ascending and after every value descending on every database: PostgreSQL renders `ASC NULLS FIRST` and `DESC NULLS LAST` on an order expression that can be NULL (it sorted NULL last ascending), in the root order, `limit_per_parent` and `group_count`. The probes and the conformance vector are `T82-1`.
- T88: write `affected` counts each written row once: an insert with `on_duplicate` is 1 in every client whether it inserted or updated (MySQL counted 2 for the update), and an update counts the rows it matched in every MySQL configuration (the Python client counted only changed rows and now asks for found rows). The conformance vector is `T88-1`.
- T87: an insert with `on_duplicate` has exactly one key that can meet the inserted row (the primary key unless the insert leaves it out, and each unique key) and assigns every column of it, else `IR_INVALID` in every implementation; the planners' conflict target is that key, so MySQL, PostgreSQL and SQLite agree where MySQL used to update the row met on any unique key. The probes and the conformance vector are `T87-1`.
- T96: the two columns of a column comparison, of a column `in`/`not_in` a subquery column, of a join's `left`/`right` and of each relation key pair must meet as dbspec check operands do, else `OPERATOR_NOT_ALLOWED` in every implementation (PostgreSQL refuses `integer = varchar`, MySQL coerces, SQLite compares by affinity); the conformance vector over the three databases is `T96-1`.
- T97: a column-comparison operator (`eq_col` and the others) is allowed by the left column's type and by the absence of a codec on both columns, with `eq_col` and `not_eq_col` also for two `ip` columns; `bool gt_col`, `bytes gt_col` and an `aes` column's `eq_col` are `OPERATOR_NOT_ALLOWED` in every implementation.
- T94: `ir.Validate` and its four counterparts refuse a primary key or identity assignment in `update` and `restore` (and the soft delete column in `restore`) with `IR_INVALID`, so an IR executor that does not plan sees the rule the planners alone held; the planners' unreachable checks are deleted.
- T99: an `insert` assigns by `p` or `null`; `plus_p` and `minus_p` in its `set` are `IR_INVALID` in every implementation and stay valid in `on_duplicate` and `update` (MySQL read the default in a `VALUES` list, PostgreSQL and SQLite refused the statement).
- T86: `key_by` names a non-null column of the child; a nullable column is `IR_INVALID` in every implementation, since a NULL collection key had a different answer by language.
- T83: `group_by` is valid only on the root of `count` and `group_count`, and an order item under it names a group column, a function of one, or `random`; every other use is `IR_INVALID` in all implementations (MySQL and PostgreSQL refused the SQL the planner made for them, SQLite answered an arbitrary row), and the planner paths that became unreachable are deleted.
- T67: the TypeScript client reaches a corpus through the markdown DSN, a pool keeping the server sessions, and passes the same cases of `tests/markdown/cases.json` against the pinned flowmark build.
- T66: the Rust client reaches a corpus through the markdown DSN and passes the same cases of `tests/markdown/cases.json` against the pinned flowmark build; the identity load test covers the markdown pool.
- T64: the PHP client reaches a corpus through the markdown DSN, one connection per `Db`, and passes the same cases of `tests/markdown/cases.json` against the pinned flowmark build.
- T63: the Go client reaches a corpus through the DSN `markdown://127.0.0.1:<port>/<corpus>?token=<token>`: it connects to a flowmark server, runs every IR kind, transactions and savepoints through it, returns `WRITE_CONFLICT` without a retry, and passes the cases of `tests/markdown/cases.json` against the pinned flowmark build.
- T92 (in part): a `datetime(p)` or `time(p)` value binds on SQLite with exactly p fraction digits: the planner puts the column's precision on the parameter slot in every implementation, and the Go client drops zero digits past p and refuses a non-zero one as `CODEC_ENCODE`.
- T114: the preparation of 0.0.8, which was never tagged — its bump commit was pushed in a batch and has no check runs, so `make release-verify` cannot pass — so its declarations ship in 0.0.9: the dependency review of 2026-10-11 is recorded and ordered-json 0.0.8 reaches every client.
- T78-2: the Python statement fault test is named `statement_fault.py`, so `make python-unit-check` (`unittest discover -p 'test_*.py'`) no longer runs a test that needs the databases; `make python-statement-fault-check` runs it.
- T115: the Python client releases as a PEP 427 wheel, `polyspec_orm-<version>-py3-none-any.whl`. Its `Requires-Dist` pins registry packages as `name==version` and names `polyspec-ordered-json` by its release asset with the sha256; `packages/orm-python/pylock.toml` locks every dependency with hashes, and the release proof installs that lock, then the wheel offline, and imports it.
- T113: the Python client reads a driver's date-time without a zone (PyMySQL, psycopg) as the wall clock of the connection's zone, so a loaded `datetime` is exact on any machine; every client's tests run in `TEST_TZ` (Asia/Seoul), and docs/spec/dialects.md states the rule.
- T75: `make dbspec-apply-stress-mysql` and the other helpers read their server environment from a declared source, so they run on macOS as on Linux, and the repository check refuses an undeclared helper environment name.
- T74: codec decode is exact in every client: `base64` and `hex` text with white space, and lower-case `hex`, fail with `CODEC_DECODE`; MySQL hex cells decode in the client; Go exports `orm.HostDecode`, the counterpart of the other clients' host decode; `tests/codec/decode-vectors.json` pins the stored cells, and docs/spec/codec.md states the rule.
- T73: `ir.Validate` resolves a column-to-column predicate's `ref` path (the root, a joined relation, `^` only inside a subquery) and requires its column, else `COLUMN_UNKNOWN`, and refuses `conn` on the top group and on a group's first item as `IR_INVALID`, in every implementation; `tests/ir/validate.json` pins the cases.
- T78-1: the checker case of the client test lanes (`scripts/check/continue.test.mjs`) reads the commands it expects from the PHP lane of `scripts/client-db-test.sh` and from `scripts/typescript/sqlite-test.sh` instead of comparing counts written by hand, so a test file added to a lane no longer breaks it; the frame double of the Python driver error test takes the `faultable` argument of `TxFrame.run` and checks that the SQLite row lock does not consume the statement fault.
- T115-2: the Python venv is built from the pinned interpreter. `make install-python` installs the Python of `config/toolchain.json` `pythonBuild` (`make install-tools TOOLS=python`) and builds `packages/orm-python/.venv` with kit's `make python-venv` from `var/tools/bin/python3`, then installs the pinned packages with that interpreter's pip; the `python3` of PATH is not used. `make python-venv-check` compares the minor of the venv interpreter with `.python-version` and refuses another minor, naming both versions and the fix (remove the venv, run `make install`). CI drops `actions/setup-python`, so CI and a local check run the same interpreter.
- T119: the dbspec `store` setting takes a time shard clause, `shard <column> year|month|day`, on a non-null `date` or `datetime` column; all six implementations parse, emit, check and hash it alike, SQL backends ignore it, and it is rejected on a block table, a table with a self foreign key, and a table with `order`.
- T115-1: the Python package declares the Python it is tested with. `requires-python` of `packages/orm-python/pyproject.toml` is `>=3.14`, the minor release of `.python-version` that CI tests, instead of the untested floor `>=3.11`: its dependency polyspec-ordered-json 0.0.8 requires 3.14, so the package cannot install on 3.11–3.13. `packages/orm-python/tests/test_requires_python.py` compares the two. The 3.11 matrix leg of CI, the matrix leg suffix of its run ids, artifacts and report paths, and the repo-check case of that leg are removed; README and `docs/operations/packaging.md` state Python 3.14.
- T78: every client's test entry point fails the next statement with a given code and message: Go `orm.FailNextStatement`, Rust `polyspec_orm::testing::fail_next_statement`, TypeScript `failNextStatement` of the testing subpath, PHP `Polyspec\Orm\Testing\Faults::failNextStatement`, and Python `polyspec.orm.testing.fail_next_statement`. The statement is not sent; the client reports it as an `OrmException` (ORM error) with the code and message at the statement end of a driver error, and the fault is consumed by that statement. A transaction's own machinery statements do not consume it (protocol 3.2). The dbspec apply and introspection of every implementation, the PHP extension included, run on the driver connection outside `Db` and do not consume the fault (protocol 3.2).
- T76: AGENTS states the design principles: no backward compatibility (an old path is removed, never kept behind a compatibility layer, a fallback or a migration), the simplest implementation that fully meets the current requirements with no abstraction, setting or indirection for an uncertain future, modular components with separated concerns, and long-term architecture with no stopgap.
- T62-4-10: the `SHOW CREATE TABLE` reader tests of T62-4-8 belong to the feature `schema_definition` of `contracts/features.json`: `tests/dbspec/show-create.json` is one of its fixtures, the Go, PHP, PHP extension and TypeScript tests are among its tests, and the fixture and each test are inputs of the check that runs them (`dbspec-go-check`, `dbspec-php-check`, `dbspec-php-extension-check`, `dbspec-ts-check`, `dbspec-rust-check` and `python-check`), so `features/contracts` and `feature-unit-check` pass again.
- T62-4-9: introspection reports a generated column as generated in every client. The MySQL and PostgreSQL readers check the generation before the type and report `a generated column has no dbspec definition`, the wording of the SQLite reader, instead of `type ... has no dbspec type`. The shared cases `mysql-generated-column` and `postgres-generated-column` of `tests/dbspec/introspect.json` pin it; an unsupported entry may now carry a rule that its reason must contain, and the Go, PHP, PHP extension, TypeScript and Rust harnesses check it. `make dbspec-introspect-python-check` runs the shared cases through the Python client on MySQL, PostgreSQL and SQLite, and the Python runner joins `make dbspec-introspect-compare-check`.
- T62-4-7: dbspec states that it produces no generated column: its column line has no generation clause, and every client reports a MySQL column with a generation expression as unsupported before it reads the expression text, so the double encoding of a non-ASCII literal in `GENERATION_EXPRESSION` reaches no client. `docs/spec/dbspec.md` and `docs/spec/dialects.md` say so; no reader or plan changes.
- T62-4-8: `tests/dbspec/show-create.json` pins the CHECK body that each MySQL reader of `SHOW CREATE TABLE` (Go, PHP, the PHP extension, TypeScript, Python and Rust) reads for a literal with `'`, `\` or parentheses, a non-ASCII literal, two CHECKs in one table and a name the statement lacks; the Go and PHP extension introspections read the same canned catalog to the same checks and unsupported objects. All readers agree, so no reader behaviour changed; TypeScript's `createChecks` is exported for its test.
- T62-4-6: a CHECK whose string literal holds non-ASCII text round-trips through MySQL in every client. MySQL 8.4.11 writes `information_schema.CHECK_CONSTRAINTS.CHECK_CLAUSE` with the UTF-8 bytes of a non-ASCII literal encoded a second time (`café` reads as `cafÃ©`), while `SHOW CREATE TABLE` writes it correctly; the MySQL introspection of Go, PHP, the PHP extension, TypeScript, Python and Rust reads such a check's body from `SHOW CREATE TABLE` in CHECK_CLAUSE form, and the Rust driver runs those follow-up queries after the catalog queries. `tests/dbspec/plans.json` case `rename-column-check-non-ascii-literal` pins the round trip.
- T62-4-5: `make feature-unit-check` asserts every negative owner sample of `scripts/features/coverage.test.mjs` by its exact errors and printed FAIL lines, including the second `duplicate observed case first` of `sample/owner/typescript/none` and the mysql and postgres lines of the second sqlite-only check. A passing run prints no FAIL line for them: the test captures the lines of each negative run, so the output of a failed run is asserted instead of printed. An empty set of observed native cases now fails with `observed no cases differ from ...` instead of `observed cases  differ from ...`. No declaration changes.
- T62-6-6: the PHP, Rust and PHP extension dbspec parsers read a malformed type argument list as Go does: a token where a type parameter belongs, or one that is neither `,` nor `)` after a parameter, is a `syntax` error at that token, instead of a `type` error at the type name that hid it (`varchar(64 x`, `varchar(64,) null`, `decimal(10 2)`). `tests/dbspec/cases.json` pins Go's output for these three cases (`column-type-argument-unclosed`, `column-type-argument-trailing-comma`, `column-type-argument-decimal-space`), and for two type arguments that are non-ASCII words (`column-type-argument-unicode-word`, `column-type-argument-unicode-decimal`), which every implementation passes in `dbspec-compare-check`. Those words are classified by each lexer's own word table, not an ASCII test. No declaration changes.
- T62-6-5: the Rust dbspec parser reads a `diagram` line inside an open table block as a column line, as Go does, instead of closing the table at that line. `tests/dbspec/cases.json` pins Go's output for this case (`diagram-line-inside-open-table`), which every implementation passes in `dbspec-compare-check`. The same case set also pins six column-line cases that every implementation already matches (a bad type argument value, a duplicate column name and a duplicate column type with a syntax error, and the reserved words `identity`, `default` and `null` used as column names with a syntax error). No declaration changes.
- T62-6-4: the TypeScript, PHP, PHP extension, Python and Rust dbspec parsers read a `table` line inside an open table block as a column line, as Go does, and a column line with a syntax error reports only its syntax errors, so `table other {` gets `syntax` at its brace alone (no `name.format` or `type`), and the Rust parser no longer closes the table at that line. `tests/dbspec/cases.json` pins Go's output for two such cases (`table-line-inside-open-table`, `table-line-inside-open-table-at-end`) and for a column with an unknown type on a line with a syntax error (`column-unknown-type-with-syntax-error`), which every implementation passes in `dbspec-compare-check`. The TypeScript unit case `columns count code points` now expects only the syntax error, as Go reports it. The PHP and TypeScript symbol snapshots gain one private method each, so `contracts/symbols/php.json`, `contracts/symbols/typescript.json` and their hashes in `contracts/interfaces.json` are re-recorded. No public declaration changes.
- T62-6-3: the Rust dbspec parser reads a `table` or `diagram` line inside a settings block that is still open as an unknown setting, as Go does, instead of closing the settings block and reading the line as a table. `tests/dbspec/cases.json` pins Go's output for this case (`settings-block-open-with-table-line`), which every implementation passes in `dbspec-compare-check`. No declaration changes.
- T62-6-2: the TypeScript, PHP, PHP extension and Python dbspec parsers report a `settings` line without `{` that is still open at the end of the document at the keyword, as Go does, in addition to the missing `{`: the end-of-document `block opened` error is no longer dropped when its line already has a syntax error. `tests/dbspec/cases.json` pins Go's output for this case (`settings-without-brace-at-end`), and for a table and a diagram left open after a syntax error on their last line (`table-block-open-with-error-line-at-end`, `diagram-block-open-with-error-line-at-end`), which every implementation passes in `dbspec-compare-check`. The PHP, TypeScript and PHP extension symbol snapshots gain one private method each, so `contracts/symbols/php.json`, `contracts/symbols/typescript.json` and their hashes in `contracts/interfaces.json` are re-recorded. No public declaration changes.
- T62-6-1: the TypeScript, PHP, PHP extension, Python and Rust dbspec parsers report a settings block that is still open at the end of the document once, at its own brace, as Go does, instead of also reporting the table brace with `the table block is not closed`. `tests/dbspec/cases.json` pins Go's output for this case (`settings-block-open-at-end`), which every implementation passes in `dbspec-compare-check`. Two unit cases that pinned the double report are updated (the Rust `unclosed-settings-and-table` rule case and the TypeScript `unclosed settings block` case). No declaration changes.
- T62-5-9: the Rust dbspec parser runs a foreign key's set_null check over every child column that exists, including a column whose type is invalid, as Go does, so a non-null such column is reported as Go reports it. `tests/dbspec/cases.json` pins Go's output for this case (`foreign-key-invalid-child-set-null`), which every implementation passes in `dbspec-compare-check`. The private Rust structs of the dbspec parser changed the type of their invalid-type column record, so `contracts/symbols/rust.json` is re-recorded. No public declaration changes.
- T62-5-8: the Rust dbspec parser runs a foreign key's index check for a child column whose line parses but whose type is invalid, as Go does, because that column is still a column of the table; the type check skips it. `tests/dbspec/cases.json` pins Go's output for this case (`foreign-key-invalid-child-type-index`), which every implementation passes in `dbspec-compare-check`. The private Rust structs of the dbspec parser gained fields, so `contracts/symbols/rust.json` is re-recorded. No public declaration changes.
- T62-5-7: the Rust dbspec parser runs a foreign key's count check only when its target table is defined and its header did not fail, as Go does, so a foreign key to an undefined table reports the unknown table and its index error but no count error. `tests/dbspec/cases.json` pins Go's output for this case (`foreign-key-unknown-table-count`), which every implementation passes in `dbspec-compare-check`. No declaration changes.
- T62-5-6: the TypeScript, Python, Rust, PHP and PHP extension dbspec parsers check a foreign key with an unknown child column against the referenced table's keys and column types as Go does: the count check and the referenced-key and type checks run whenever the referenced columns are known, and the type check skips the unknown child. `tests/dbspec/cases.json` pins Go's output for three such cases, one of them a control, which every implementation passes in `dbspec-compare-check`. The TypeScript private method `foreignKeyKeyChecks` has a new parameter type, so its symbol snapshot is re-recorded. No public declaration changes.
- T62-5-5: the Rust, TypeScript, Python, PHP and PHP extension dbspec parsers run a foreign key's index check only when every child column is known and not repeated, and run its set_null check over the known child columns when a child column is unknown, as Go does. `tests/dbspec/cases.json` pins Go's output for three cases, and every implementation passes `make dbspec-compare-check`. No public declaration changes; the TypeScript private method `foreignKeyKeyChecks` gains a parameter, and its snapshot is re-recorded.
- T62-5-4: the TypeScript and Python dbspec parsers run a foreign key's own index check and set_null check when the referenced table is not defined, its name is malformed, or the referenced columns differ in number from the foreign key columns, as Go does; they skip only the pairing and type checks. `tests/dbspec/cases.json` pins Go's output for six such cases, which every implementation passes in `dbspec-compare-check`. No other dbspec behavior changes.
- T62-5-2: the TypeScript and Python dbspec parsers run a foreign key's own index check and set_null check when a referenced column is unknown, as Go does, and the Python parser skips the index check after a failed primary key line. `tests/dbspec/cases.json` pins Go's output for five such cases, which every implementation passes in `dbspec-compare-check`. No other dbspec behavior changes.
- T70: the repository check compares a running Go or Composer with the declared release by major and minor, so a patch release of the declared version passes `make repo-check`; `.go-version` and `.composer-version` and the CI workflows still pin one exact release. No product behavior changes.
- T62-5-1: the TypeScript, PHP, Rust, PHP extension and Python dbspec parsers report `order` on a column line only when the line parses, as Go does, so a column line with a syntax error after a key, index, foreign key or check line gets `syntax` alone. `tests/dbspec/cases.json` pins Go's output for eight such cases, which every implementation passes in `dbspec-compare-check`. No other dbspec behavior changes.
- T62-4-2: the PHP dbspec CHECK decoder reads a word byte with an explicit ASCII range instead of `ctype_alpha` and `ctype_alnum`, which accept bytes of 0x80 and up under the runtime's locale, so a non-ASCII word is reported as Go reports it (`unexpected character`) instead of being read as a column name. The other word predicates that read CHECK or canonical check text and dbspec header and name rules already match Go's ASCII rules; shared cases in `tests/dbspec/cases.json` and `tests/dbspec/introspect.json` pin them. No dbspec behavior changes otherwise.
- T62-4-1: the PHP and TypeScript dbspec lexers classify a word character from the generated Unicode table of Go's `unicode` package, not from their runtime's Unicode data: `go run ./tests/dbspec/unicode -write` also writes `packages/orm-php/src/Dbspec/UnicodeWord.php` and `packages/orm-npm/src/dbspec/unicode_word.ts`, the freshness test covers them, and exhaustive code-point tests of both tables run in `make dbspec-php-check` and `make dbspec-ts-check`. No dbspec behavior changes; the PHP and TypeScript symbol snapshots record the new `UnicodeWord` class, the public `Parser::isWord` and `containsWordRune`.
- T62-4-4: the FAIL lines that `make feature-unit-check` prints for the `sample/owner/*` fixtures (typescript/none, typescript/mysql, typescript/postgres, go/none) are asserted negative samples of `scripts/features/coverage.test.mjs`, which runs them on purpose and asserts their errors; the check exits 0 and no code changes.
- T62-3-1: `engine/dbspec/literal_test.go` belongs to the schema feature of `contracts/features.json`, as a declared test of the feature and an input of `make dbspec-go-check`, so `make feature-unit-check` no longer reports it. No dbspec behavior changes.
- T62-4-3: the Rust dbspec sources pass `cargo clippy --all-targets -- -D warnings` (`make rust-check/clippy`): the parser drops a binding that no code read, the lexer's `is_number` uses `is_none_or`, and `validate` takes the parse result `Parsed` instead of its eight parts. No dbspec behavior changes; the Rust symbol snapshot records the new `validate` signature.
- T62-5-3: the Rust dbspec sources `orm-schema/src/dbspec/parser.rs` and `dbspec/mod.rs` are formatted by rustfmt with the repository's `rustfmt.toml`, so `make rust-fmt-check/clients` passes. The change is layout only; no declaration or behavior changes.
- T62-6: the TypeScript, PHP, Rust, PHP extension and Python dbspec parsers read a repeated settings block as Go does: its lines get the syntax checks of the first block (unknown settings, name syntax, lex errors) and are never validated, `order` is reported at its keyword only when its header is exactly `settings {`, and a `settings` line without `{` no longer crashes the Python parser or reads as a column in Rust. `tests/dbspec/cases.json` pins these with fourteen cases of repeated and brace-less settings blocks, which every implementation passes in `dbspec-compare-check`.
- T62-5: the TypeScript, PHP, Rust, PHP extension and Python dbspec parsers check a table whose header failed as Go does: its repeated name is not reported, a foreign key to it checks no referenced column, count, key or type, a failed audit history table or audit record table is not checked for its columns or key, and every body error of it is reported. `tests/dbspec/cases.json` pins these with thirteen `failed-header-*` cases whose errors Go produces.
- T62-4: the dbspec lexers of Rust, the PHP extension, PHP, TypeScript and Python read a word character as Go's `unicode.IsLetter` or `unicode.IsDigit` does: a symbol such as `€` is a `syntax` error where it stands, a non-ASCII letter or digit is part of a word, a malformed check reference reports `name.format`, and the Rust header name is ASCII as in Go. The C extension and Python read the Go table of Unicode 17.0.0 that `go run ./tests/dbspec/unicode -write` generates into `unicode_word.h`, `unicode_word.rs` and `unicode_word.py`, and `go run ./tests/dbspec/unicode` checks that the files match it; `tests/dbspec/cases.json` pins Go's behaviour with six new invalid cases, and docs/spec/dbspec.md states the word rule.
- T62-2: the PHP, Rust and PHP extension dbspec parsers keep a dotted name such as `a.b` as one token, as the Go parser does, so a dotted table, column or setting name is one `name.format` error.
- T62-1: the TypeScript, PHP, Rust, PHP extension and Python dbspec parsers read the `state_machine`, `markdown` and markdown storage settings (T59, T60, T62) as the Go parser does: each parses, validates and emits them with the same rules and rule names, and the shared cases of `tests/dbspec/cases.json` run in every implementation, with `dbspec-compare-check`.
- T62-3: dbspec exports `CanonicalLiteral(t Type, text string) (string, bool)`, which returns the canonical form of a literal written as a column default and whether it is a valid literal of the type, so a consumer reads column values with the rules of orm instead of a copy of `canonicalDefault`. The function runs the code of `canonicalDefault`; a literal is one token on one line with no space around it, and a text or bytes column has no literal.
- T62: dbspec gains the markdown storage settings: `store files`, `store document list|table` and `store block <foreign key> list|table` (exactly one per table), `key_prefix '<p>'`, `title <column>`, `body <column>`, `order <column>`, `checkbox <column> <state> '<glyph>'`, and the state machine's `state_machine <column> initial <state>`, `history` and `limit` lines. The validator checks the states, glyphs, columns and the history table's shape, the emitter writes the canonical lines, and the manifest hash covers them.
- T61: the protocol has section 5, IR executors: a `markdown://` DSN selects an IR executor instead of a SQL dialect; the client validates each request with `ir.Validate` and sends `{ir_version, manifest_hash, request, params, now}`, and the control messages `begin`, `commit`, `rollback`, `savepoint`, `release` and `rollback_to` open, end and nest a session transaction. `docs/spec/errors.yaml` has `WRITE_CONFLICT`, which the generated Go, PHP and Rust constants carry, and `docs/spec/dialects.md` has the capability table of the markdown executor.
- T68: the Korean checklist states the Python client in T58 with `명시한다`, a word the writing-style rule allows, so `make docs-rules-check` passes on main.
- T57-1: the version check reads no version declaration of the root README, whose title names no version; the CI of the README change had failed on it.
- `make release-consumer TAG=v0.0.7` passes on a machine with npm 12.2.0, PHP 8.5 and Composer 2.10.3, also the Composer project that the machine of the release could not install; the Makefile exports `npm_config_allow_remote=root` for `release-consumer` and `release-proof`, because npm 12 installs no URL dependency by default (T56).
- README states the Python client: the title names no version and the introduction, the examples, the models bullet, the quick start and the tooling line name five clients (T57).

## 0.0.7

- T56: release 0.0.7: the manifests, the locks, `VERSION`, the contract version of `contracts/features.json`, the version of the PHP extension and the documents declare 0.0.7, the dependency review is recorded again and `tests/release-consumer` holds the locks of the archives of 0.0.7.
- T55: Python models and row sets have `to_json_text()`, which writes the same JSON text as TypeScript `toJSONText()`: the members in row order, a styled value column as its tagged value with the stored ordered-json text, and every other value as `JSON.stringify` writes it; a value that JSON cannot write fails with `CODEC_ENCODE`. `to_array()` takes the row order of the TypeScript and PHP clients.
- T54: the Python client reads SQL NULL of a styled value column as `StyledValue.sql_null()` in the root row, a joined row and a related row, as the TypeScript client returns `StyledValue.sqlNull()`, so a value read from a row writes back; the getter returned `None` and a setter given it failed with `CODEC_ENCODE`.

## 0.0.6

- T52: release 0.0.6: the manifests, the locks, `VERSION`, the contract version of `contracts/features.json`, the version of the PHP extension and the documents declare 0.0.6, the dependency review is recorded again and `tests/release-consumer` holds the locks of the archives of 0.0.6.
- T51.1: the Korean records of the Python test entry point pass the writing-style rule of `make docs-rules-check`.
- T51: the distribution of the Python client holds the test entry point `polyspec.orm.testing`, which no module of `polyspec.orm` imports, so the tests of a consumer import it from an installed `polyspec-orm`, as the PHP package holds `testing/Faults.php`.
- T50: a statement event subscriber of the Python client that raises fails the statement with `SUBSCRIBER: statement event subscriber failed: <text of the error>` and the error as `cause`, as the TypeScript client does; an `OrmError` of the subscriber no longer ends in `AttributeError`.
- T49, T49.3: the Python client has the rollback fault test entry point `polyspec.orm.testing.fail_next_rollback(db)` of docs/spec/protocol.md "Test faults": the next transaction whose callback fails rolls back and raises one `ROLLBACK` error with the callback error as `cause` and a `FAULT` error as `rollback`, a commit and a savepoint rollback leave the fault armed, and the distribution excludes the package `polyspec.orm.testing`; with T49.2 a rollback that fails reports both the callback error and the rollback error instead of the raw rollback error.
- T49.2: the Python client returns every driver error of a statement or a connect as an `OrmError`: the SQLite extended result code, the MySQL error number and the PostgreSQL SQLSTATE select `DUPLICATE_KEY`, `FOREIGN_KEY`, `CONSTRAINT`, `DEADLOCK`, `LOCK_NOT_AVAILABLE`, `CANCELED`, `READ_ONLY` or `CONNECTION_LOST` with the table of the TypeScript client, every other driver error is `DRIVER`, and each has the message `<driver>: <driver message>` and the driver error as its `cause`; a `sqlite3.IntegrityError`, a PyMySQL error or a psycopg error no longer escapes raw.
- T49.1: the Python client installs a document set whose document has `use` lines: `is_schema_text` builds the use lines of the plain document as `DbspecUse` values, as `isSchemaText` of the TypeScript client does, instead of dicts that made `utils().schema().install(schema)` fail with `AttributeError: 'dict' object has no attribute 'document'`.

## 0.0.5

- T48: the budget and stall guard of the stress case are `StepBudget` and `StallGuard` in `internal/testcase`, which `testcase-check` owns, and their tests run there; T47 had put them in `tests/dialects/stress_budget.go` and its test, which no check selected, so `feature-unit-check` failed with `every tracked file selects a behaviour test or declares its scope`.
- T47: the stress case `TestApplyStressPlan` takes its deadline from the number of steps of the plan (`testcase.StepBudget`: 250 ms a step and one minute) and fails a database that applies no step within two minutes (`testcase.StallGuard`), not at a fixed total of 12 minutes; the MySQL plan of 22000 steps took 10 minutes 21 seconds on a slow runner and 7 minutes 54 seconds on a fast one, and the fixed deadline failed the slow run with `context deadline exceeded`. The plan keeps all its steps.
- T46: release 0.0.5: the manifests, the locks, `VERSION`, the contract version of `contracts/features.json`, the version of the PHP extension and the documents declare 0.0.5, the dependency review is recorded again `tests/release-consumer` holds the locks of the archives of 0.0.5, and `push-gate.yml` runs on pushes to branches only (`branches: ['**']`), not on tag pushes.
- T45.1: the vendored kit is v0.0.10, whose tests remove the `stub-npm-*` folders of the npm stub, so `kit-test` leaves no temporary entry under the private `TMPDIR` of the runner.
- T45.2, T45.3: `TestCoverageModelGenerationCheck` copies the Go client from `packages/orm-go/model` and `TestCIRequiresGeneratedChecks` requires `run: make check-run GROUP=${{ matrix.group }}` in `ci.yml`, as T44.1 and T44.2 moved them; T45.1 waits for kit to remove the temporary folders of its npm stub.
- T43.5-5 to T43.7-19, T43, T43.5, T43.6, T44.4: the open rows of the Python client and of the kit adoption are closed by their owning unit checks (`make dbspec-compare-check`, `make python-check`, `make repo-check`, `make runner-check`, `make interface-check`, `go test ./tests/conformance/check`); the `tokio::select!` of the Rust catalog case `native_updates_lock_compare_verify_and_rollback` is `biased` so the probe event comes first; `config/release.json` declares the `consumers` and `tests/release-consumer` holds their manifests. The rows that read database servers are checked by CI after the push.
- G5.90, T43.7-5: ordered-json is taken at its release v0.0.7: go.mod requires `github.com/polyspec/ordered-json/packages/ordered-json-go v0.0.7`, the root package.json and composer.json take `polyspec-ordered-json-npm-0.0.7.tgz` and `polyspec-ordered-json-php-0.0.7.zip` of the release, the Rust crate and `Cargo.lock` name the tag `v0.0.7`, and the Python client, the Makefile, ci.yml and the Python tests read `packages/ordered-json-python`.
- T44.2-1, T44.3: the vendored kit is v0.0.9, which reads the VitePress heading anchors and `{#id}` when `siteLinks` is set, skips a package that the root `overrides` take from a URL in the registry review, and accepts a root composer.json; `config/dependency-policy.json` declares the root composer.json (PHP 8.4.0), the root composer.json requires `polyspec/orm` at `0.0.4`, `config/dependency-review.json` records the review, and `make documents-check`, `make dependency-policy-check` and `make dependency-policy-mutation-check` pass and are targets of `CHECK_TARGETS`.
- T44.3: `config/dependency-policy.json` declares the Python manifest of the client and the exceptions for `@polyspec/ordered-json`, `typescript` 6 and `@types/node` 22; `config/toolchain.json` declares `cargoAudit` 0.22.2 and `govulncheck` 1.8.0; the dependencies are raised to their latest stable releases (mermaid 12.1.0, mysql2, pg, typescript 6.0.3, the Go modules sys, tools, sqlite, text, mod, sync and libc), the root package.json lists the workspaces as `packages/*` and takes vite 7 for vitepress through `overrides`, so that no lock has an advisory of moderate or higher severity; the root composer.json sets `config.platform.php` to 8.4.0 and its lock is resolved for it. `make dependency-review RECORD=1` still writes no record while the query for `@polyspec/ordered-json` answers 404 (T44.3).
- T44.2: the repository uses the vendored tools of polyspec/kit v0.0.4 (`scripts/kit`, `tests/kit`, `kit.json`, `.kit/kit.lock.json`) and its own `config/*.json`: the push check, the guard of the full run, the Git hooks, the document check, the commit check (`make commits-check`, `config/commits.json`), the release steps (`make release-verify`, `release-versions`, `release-assets`, `release-publish`, `release-coverage`, `config/release.json` with the Go module of the repository root), the crate download check and the CI result check (`make ci-passed`, input `RESULTS`) are kit's; the copies in `scripts/check`, `scripts/checklist`, `scripts/git`, `scripts/github` and `scripts/release`, the install check of the release assets with `tests/release-install`, `.github/ruleset.json` and the Make targets of the ruleset are removed. `make check` is the guard of kit and runs `make check-run`, the runner of this repository, whose record is `.runtime/check/<run id>/record.json` (`scripts/check/record.mjs`); `make rerun-failed` is kit's. `make owner-check` is kit's and hands the changed paths to `make feature-owner-check` (`config/owner-checks.json`). The checklist moved to `docs/plans/execution/checklist.md`. CI runs on a push to `main` and by hand, `push-gate.yml` runs on every push, and the release assets are named `polyspec-orm-npm-X.Y.Z.tgz`, `polyspec-orm-php-X.Y.Z.zip` and `polyspec-orm-dbspec-php-X.Y.Z.zip`. Every document pair carries a `doc-id` and a `source-sha256` marker, the code blocks of the Korean documents equal the English ones, and `examples/complex`, `examples/thin-slice`, `tests/codec` and the PHP package have Korean READMEs. `make documents-check` reports only the heading anchors of T44.2-1.
- T44.1: the six client packages moved from `clients/<directory>` to `packages/orm-<kind>` (`orm-go`, `orm-npm` for TypeScript, `orm-php`, `orm-php-extension`, `orm-python`, `orm-rust`); the Makefile, the workflows, the scripts, the tests, `contracts/` and the documents name the new directories, `scripts/features/packages.mjs` maps a client language to its directory, and the regenerated symbol snapshots hold the declarations of the old snapshots under the new paths. The Go module `github.com/polyspec/orm` stays at the repository root; its client packages are `github.com/polyspec/orm/packages/orm-go/...`.
- T43.7-18-2: the row names the check `symbol snapshot check` instead of a word that `make docs-rules-check` rejects, so `make docs-rules-check` passes on the checklist.
- T9: the PHP extension `orm_dbspec`, written in C, provides every public method of the PHP client's `Dbspec` and the classes of its results, and the Rust extension is gone (T9.1 to T9.13).
- T43.6-3-4: the run-languages test of the conformance check starts its case with `testcase.Start`, as every Go test of the check does.
- T43.6-1-1: the run id, report path and artifact name of a matrix group carry `${{ matrix.leg }}`, so the Python 3.11 leg and the other leg of the group write different reports; the declared forms in `scripts/repo/ci.mjs` and their tests name it.
- T43.7-18-3: the symbol hash of the Python client in `contracts/interfaces.json` names the current `contracts/symbols/python.json`.
- T43.6-3-3: the utility statements of the Python client for PostgreSQL use the $n markers, as the engine writes them; the advisory lock and set_config statements are constants checked by `test_utils_statements.py`.
- T43.7-18-2: the helpers `for_mysql`, `for_postgres`, `mysql_conversions` and `postgres_loaders` keep their public names and are declared in `contracts/symbols/python.json`; the private names of T43.7-18-1 are reverted.
- T43.7-18-1: the helpers `_for_mysql`, `_for_postgres`, `_mysql_conversions` and `_postgres_loaders` of the Python client are private names, so the public names of the client equal `contracts/symbols/python.json`.
- T43.6-3-2: the conformance check runs every language of a database and every database after one fails, and its error names each failed database and language, instead of stopping at the first failed language.
- T43.6-1: the python group of CI runs on Python 3.11, the minimum release of `requires-python`, as a matrix leg of its own next to the leg of `.python-version`; the leg names its report and artifact with `_py311`, so the two legs of the group do not share a name.
- T43.7-19: the Python drivers return DECIMAL and NUMERIC cells as their exact text (PyMySQL conversions and the psycopg text loader), as the TypeScript and PHP clients do, instead of decimal.Decimal.
- T43.7-18: the Python client translates the engine markers for its drivers: `?` to `%s` for MySQL and `$n` to `%(pn)s` for PostgreSQL, outside quoted text and comments, with every `%` escaped; a statement without values is passed unchanged.
- T43.7-17: the inputs unit run of `dbspec-compare-check` receives `PYTHONPATH` and `ORM_PYTHON`, so the Python runner rejects its cases instead of failing on a missing interpreter variable.
- T43.7-16: every command that sets `ORM_PYTHON` also sets `PYTHONPATH` to `PYTHON_PATH`, so the Python interpreter imports `polyspec.ordered_json` and the client in the conformance and dbspec comparison runs.
- T43.7-15: the row of T43.7-14 names the database subtests `DB` instead of the angle-bracket placeholder, which the documentation build read as an HTML element.
- T43.7-14: `conformance-result-physical-check` depends on `conformance-python-models` and passes `ORM_PYTHON` and `ORM_PYTHON_MODELS`, so the physical result check of the Python runner has its interpreter and models.
- T43.7-8: the physical result runner list of `tests/conformance/check/result_physical_test.go` names python, as `requiredLanguages` does, so the list matches the languages whose runner result file exists.
- T43.7-9: `conformance-check` and `feature-verify-other` declare the `python` need in `contracts/check-inputs.json`, so their CI groups install the Python client interpreter that their targets use.
- T43.7-7 and T43.7-13: `python-install` is renamed `install-python`, so it matches the install target pattern that may download; the ordered-json checkout is inside the workspace and `ORDERED_JSON` names it.
- T43.7-12: `scripts/check/ci-setup.mjs` declares the ordered-json checkout step as a need of the python group, so the check runner does not stop on it in other groups.
- T43.7-11: the python group of CI checks out polyspec/ordered-json at its release v0.0.4 into `../ordered-json`, so the Python checks import `polyspec.ordered_json`.
- T43.7-5: the ordered-json dependency of the Python client is recorded as a bypass row. The pin of `clients/python/pyproject.toml` stays at tag `v0.0.4`, which the tags of ordered-json do not include yet; its retry condition is that tag with its `python/` directory.
- T43.7-4: `AGENTS.md` (Releases) and `docs/operations/packaging.md` state that the Python client is consumed by its git tag and has no release archive, and that the version-bump pull request sets the `version` of `clients/python/pyproject.toml`, which `make version-check` reads.
- T43.7-3: the bypass state of the blocked T43 rows is recorded as it stands. Before the commit "Mark the blocked T43 rows as bypassed", T43, T43.5 and T43.6-1 were in progress, and that commit moved them to bypassed; its message also names T43.5-5 and T43.6, whose bypass marks were set by earlier commits, and does not name T43.6-3, which was bypassed by the commit "Block T43.6-3 on the ordered-json checkout". T43.6 was bypassed by "Block T43.6 on the ordered-json checkout", and T43.5-5 by "Bypass T43.5-5 until the PHP extension runs". The checklist holds the bypassed state for T43, T43.5, T43.5-5, T43.6, T43.6-1 and T43.6-3.
- T43.7-2: `scripts/release/release.mjs` lists `clients/python/pyproject.toml` in `NOT_RELEASED`, because the Python client is consumed by its git tag and has no release archive, so every tracked manifest is released or listed.
- T43.7-6: the Korean row T43.7-3 of `docs/checklist.ko.md` states its facts without the word that the docs-rules check rejects, so `node scripts/docs/rules.mjs` passes.
- T43.7-1: the package-data key of `clients/python/pyproject.toml` is `polyspec.orm` (it was `orm`, which names no package), so the wheel of `polyspec.orm` includes `py.typed`; `clients/python/tests/test_packaging.py` checks that every key names a package under `src` and that `polyspec.orm` lists `py.typed`.
- T43.5-1-1: `make install` creates the Python client interpreter (`clients/python/.venv`) with the pinned dependencies, and the dbspec comparison checks that it exists instead of downloading it.
- T43.5-2-1: `scripts/bench-db.sh` takes the dialects to seed by name (`mysql`, `postgres`, `sqlite`); with no argument it seeds all three as before, and `sqlite` seeds the SQLite bench file alone without the MySQL and PostgreSQL servers.
- T43.5-6: the Python tests remove their temporary directories and files: `test_orm_gen.py` and `test_sqlite.py` clean up with `addClassCleanup`, and `dbspec_apply.py` writes its databases into one `TemporaryDirectory`; one run leaves no entry in TMPDIR.
- T43.5-7: the Python Mermaid check compares each export text with its trailing line end, requires empty export diagnostics, a missing document for each invalid case and version 1, matching the TypeScript check, and reports a failed check with an error that `python -O` keeps.
- T43.5-9: the T43 checklist records the history of T43.4 (waiting in commit a6183322, done in commit d988a0f0 with no state commit between) and the empty commit bodies of a6183322 and feaf90ba; the commits themselves are unchanged.
- T43.5-6-1: the Python tests pass the sibling ordered-json source path to the orm-gen subprocess through PYTHONPATH, so they run without an external PYTHONPATH.
- T43.5-2-3-1: the Python client provides `db.utils()` with the named lock, the transaction-local values (`set_local`, `local`) and the AES key version status (`aes().status`), following the Go client; a call outside a transaction is a CONFIG error.
- T43.5-2-3-2: an add-column function named `Alias<Name>` stores its result under the snake_case name of the alias, so the result key is `start_year` and the value is the function result.
- T43.5-2-3-3: a subquery column whose callback returns an aggregate model builds without a columns key, and its column name is snake_case (`read_total`), so the vector `subqueries` agrees with the Go output.
- T43.5-2-3-4: a terminal-by method after other conditions joins its condition to them with AND and runs on a copy of the query, so the vector `terminal_reuse` agrees with the Go output.
- T43.5-2-3-5: a joined or related model is part of the row output under its relation name, written as its own row output or as a list of them, so the vectors `joins` and `relations` agree with the Go output.
- T43.5-2-3-6: statement events show an executor clock bind as `$NOW` and a bound secret as `$SECRET`, as docs/operations/usage.md specifies, so the vector `functions` agrees with the Go output.
- T43.5-2-3-7: a value attached with new_label is written in the output of the created model, so the vector `write_cycle` agrees with the Go output.
- T43.5-2-3-8: the Python client keeps the primary and foreign keys after removeAllColumns, as docs/spec/dsl.md and the Go client do; a unit test guards the rule and no client change was needed.
- T43.5-2-3-9: the SQLite row lock insert event names `orm__row_lock` in its tables, so the full run of the 26 vectors is byte-identical to the Go output.
- T43.5-2-3: the Python conformance runner runs the 26 SQLite vectors in one process, and its output is byte-identical to the Go runner's output on the same seeded database.
- T43.5-2-4: the conformance checker requires the python language, runs the Python runner with ORM_PYTHON and ORM_PYTHON_MODELS, and conformance-result-check has a python step.
- T43.5-3-1: the Python symbol extractor tests/interfaces/python.py reports the public declarations of the client (524 symbols), saved as contracts/symbols/python.json.
- T43.5-3-2: the outputs and inputs tables of contracts/validate.go give a python type to every entry; the language list gains python with the rule natives in T43.5-3-6.
- T43.5-3-7: `db.utils().schema()` returns the SchemaUtils object of the connection.
- T43.5-3-8: `SchemaUtils.register` checks that the manifest text hashes to its declared hash (CONFIG and nothing registered otherwise), and registering a set that is registered already changes nothing.
- T43.5-3-5: every owner of contracts/interfaces.json names a python symbol and fields.
- T43.5-3-5-1: the 16 owners of contracts/interfaces.json have Python classes or TypedDicts with their fields, and python natives naming them.
- T43.5-3-5-1-3: the seven difference, rename, unsupported and apply owners (DbspecDifference, DbspecUnsupported, DbspecTableRename, DbspecColumnRename, DbspecColumnName, DbspecApplyEvent, DbspecApplyError) have python natives whose fields are the keys the Python code writes, checked against the snapshot.
- T43.5-3-5-1-2: the seven plan and diagnostic owners (DbspecDiagnostic, DbspecManifest, DbspecPlan, DbspecPlanStep, DbspecEffect, DbspecNullCheck, DbspecChange) have python natives whose fields are the Python dict keys, checked against the snapshot.
- T43.5-2: the Python conformance runner runs the 26 SQLite vectors and matches the Go output byte for byte; the checker registers python.
- T43.5-3: the interface contracts declare python: the extractor, the rule, record and owner natives, the manifest and the checker.
- T43.6-2: the Python runner runs the 26 SQLite vectors with the generated models, and its output is byte-identical to the Go output.
- T43.5-4: the features, the version declarations, the check inputs and the CI group declare python.
- T43.5-4-2: the version check, the check inputs and the CI group declare python.
- T43.5-2-2: the Python conformance runner imports the generated models from the run directory, and its SQLite output over the 26 vectors is byte-identical to the Go output.
- T43.5-4-2-2: the Python client has the python-check target, declared in contracts/check-inputs.json, and a CI group python that sets up Python from .python-version; the tool-language rule exempts the Python client's runners.
- T43.5-4-2-1: make version-check reads the Python client version (clients/python/pyproject.toml), and its 31 declarations agree on 0.0.4.
- T43.5-4-1: contracts/features.json declares python as planned for each of the 18 features, and the generator lists python, so docs/features.md and docs/features.ko.md name the Python client; no feature claims a python pass before T43.6 runs its vectors.
- T43.5-3-6: the interface manifest lists python (clients/python/src, contracts/symbols/python.json and its hash); the checker requires five languages, runs the Python extractor, and checks the Python fixtures and prohibited calls.
- T43.5-3-5-1-1: Page and AESRotationStatus are Python owners: Page declares its fields as class annotations, and both owners have python natives checked against the snapshot.
- T43.5-3-4: every record of contracts/interfaces.json has a python native that names a Python TypedDict of polyspec/orm/ir.py.
- T43.5-3-4-2: `polyspec/orm/ir.py` declares the 19 IR records as TypedDicts, and each record of interfaces.json has a python native whose wire fields equal the record's fields, with the base expanded.
- T43.5-3-4-1: the interface extractor reads a TypedDict record: its `#wire` symbol gives the wire type of each field and `@flatten` for its base, and a class that derives from a record of the same module is a record too.
- T43.5-3-11: `installed_differences` returns the differences of an installed set from its target schema, as the TypeScript client does for the same inputs.
- T43.5-3-9-1: the SQLite unsupported-column message writes the CHECK text as the TypeScript client does, an absent check as the empty string.
- T43.5-3-9: `SchemaUtils.install` renders the set for the driver, creates its tables on an empty database, creates nothing when they exist, refuses a partial set and a differing database with the TypeScript client's messages.
- T43.5-3-12: `add_tables_and_columns_steps` returns the names added, the steps and the refusals of an upgrade, as the TypeScript client does for the same inputs.
- T43.5-3-10: `SchemaUtils.add_tables_and_columns` takes an installed set to a newer version by adding its tables and nullable columns, and refuses other changes with SCHEMA_DIFFERS before any statement.
- T43.5-3-13: the generated Python bench models are committed at clients/python/src/polyspec/orm/models/ and `make python-model-check` checks them against the generator.
- T43.5-3-14: the contract validation reads a Python native signature with a self receiver and a "->" return type as the other clients' parameters and return type.
- T43.5-3-15: the Python Model methods `and_` and `or_` are in the symbol snapshot, so the entity rules find them; no change was needed.
- T43.5-3-16: the Python Model methods get_count, get_sum, get_avg, gets_count and gets_page are in the symbol snapshot; no change was needed.
- T43.5-3-17: the Python Model methods get_query and to_array are in the symbol snapshot; no change was needed.
- T43.5-3-18: `AesUtils.rotate(model, keyring)` re-encrypts the rows that are not at the current key version with the current key, gives them the current version and returns their number.
- T43.5-3-3-1: the 22 entity rules have python natives that name the Model methods, and the Model methods carry the contract's types.
- T43.5-3-3-2: the 13 connection, utility, schema and AES tool rules have python natives that name the Python methods, with the common table types.
- T43.5-3-3-3-1: the eight dbspec rules for the files, parse, emit, manifest, render, introspection and external documents have python natives that name the Python functions, with the common table types.
- T43.5-3-3-3-2: the eight dbspec rules for the plans, the comparison and the upgrade steps have python natives that name the Python functions, with the common table types.
- T43.5-3-3-3-3: the six dbspec rules for apply, recovery, rollback, finalization and the Mermaid conversion have python natives that name the Python functions, with the common table types.
- T43.5-3-3-3: the 22 dbspec rules have python natives that name the Python functions.
- T43.5-3-3: all 57 rules of contracts/interfaces.json have python natives that name Python symbols of the snapshot.
- T43.5-1: the Python client runs the shared dbspec comparison (`tests/dbspec/compare/python.py`, registered as `python` in `runners.mjs`); its output on the shared cases and the stress document equals the Go runner's output byte for byte, and `make python-install` creates the interpreter of the client dependencies.
- T43.4: the Python client renders the statements of a document set in the three dialects (131 statements of the shared ddl cases agree), introspects a live database into a document with the unsupported objects (the sqlite cases of the shared introspection cases agree), parses plan documents, chains plans, compares schemas and writes the steps of a plan (50 cases of the shared plans cases agree), applies a chain of plans on a SQLite connection (4 scenarios agree), and converts a document to and from Mermaid (13 cases of the shared mermaid cases agree).
- T43.3: the Python model chain writes and reads through `create`, `creates`, `save`, `update(true)`, `delete(true)`, `restore`, `getsCount` of a group and `getsPage`; joins assemble their columns, relations read their steps, a relation with its own connection attaches after the main rows, the `Db` publishes a statement event to every subscriber, numbers transactions, takes the SQLite row lock of `forUpdate`, and inserts the audit record of a transaction with `auditSource`.
- T43.1: the Python package `polyspec.orm` parses, validates and emits dbspec documents, builds the runtime model of a document set, and `orm-gen gen` writes the model modules of a document set with the manifest hash of the other clients.
- T43.2: the Python client implements the value functions of `orm`, `StyledValue`, the codec stages (`encode`, `decode`, `hostEncode`, `hostDecode`, `blindIndex`, `CodecError`) and `AesKeyring`; the shared codec vectors and the AES vectors pass in Python.
- G5.143: the TypeScript client clock (`wallMicros`) stays within the millisecond of `Date.now()` and does not go back while the wall clock does not, so a SQLite `now` condition read after an insert matches the inserted row.
- G5.142: the npm workspace installs with the default hoisted layout, and the TypeScript build, the package declaration check, the conformance result helpers and the `decimal-typescript-types` commands resolve their modules by package name.

## 0.0.4

- G5.141: the four clients use ordered-json 0.0.3, and the release assets install from a Composer artifact repository of the orm zips and the ordered-json zip alone.
- G5.140: the TypeScript interface check loads typescript from the clients/typescript workspace.
- G5.139: `make package-check` installs the release assets with `npm ci` and `composer install` from the committed consumer projects of tests/release-install with empty caches, and `make install-release-fixtures` writes their locks.
- G5.138: every released manifest is the manifest of the tree: clients/typescript/package.json requires `@polyspec/ordered-json` `0.0.2`, the Composer manifests declare `version` and no `repositories`, the private root package.json (npm workspace with `overrides`) and composer.json (into vendor-php) take ordered-json from its GitHub release, and the release refuses a packed manifest that differs from its source.
- G5.137: VERSION, every package file, the lockfile entries of the orm packages, the feature contract and the version statements of the documents declare 0.0.4, and the changelogs record the changes of 0.0.4 under `## 0.0.4`, so `make release-versions` passes for the tag `v0.0.4`.
- G5.136: the npm tarball and the Composer zips of `make release-assets` declare every polyspec dependency by the exact version of its release, the Composer zips carry the release `version` and no `repositories`, the release refuses a packed manifest that breaks this, and `make package-check` installs the assets of HEAD outside the repository; docs/operations/packaging.md describes the install from release assets.

## 0.0.3

- G5.135: the TypeScript conformance runners import OrderedJSON by the entry point of its package, which the release archive provides.
- G5.134: the four clients use ordered-json 0.0.2: the TypeScript client takes `@polyspec/ordered-json` from the npm archive of the GitHub release `v0.0.2`, so `npm ci` installs it without git; go.mod requires `github.com/polyspec/ordered-json/go` `v0.0.2`, and the Rust and PHP clients take the tag `v0.0.2`. `make repo-check` fails a tracked package.json with a git dependency spec and a tracked package-lock.json with a `resolved` from git.
- G5.133: VERSION, every package file, the lockfile entries of the orm packages, the feature contract and the version statements of the documents declare 0.0.3, and the changelogs record the changes of 0.0.3 under `## 0.0.3`, so `make release-versions` passes for the tag `v0.0.3`.
- G5.132: `make release-publish` uses the changelog section as the release notes when it has at most 125000 characters, the limit of a GitHub release body, and otherwise one line that links the section `## X.Y.Z` of CHANGELOG.md at the tag.

## 0.0.2

- G5.131: the CI job ci-passed checks out the repository and installs node before `make ci-passed`, and `make repo-check` fails a ci-passed job without these steps.
- G5.130: the changelogs record the changes of 0.0.2 under `## 0.0.2` below an empty `## Unreleased`, so `make release-versions` passes for the tag `v0.0.2`.

- G5.129: the process cases of the step runner wait until the background child runs `sleep`, so the reported command line does not depend on the order of exec and the process check.
- G5.128: the CI groups are named with lowercase letters, digits and `_` only, so each job uploads the report directory that its runner writes, and `make repo-check` fails a group whose upload path differs from it.

- G5.127: the setup of a CI group includes what the setup step `databases/create` needs (PHP and the Composer autoload), and `make repo-check` fails a CI group that skips a setup step its targets need directly or through `databases/create`.

- G5.126: CI runs `make feature-helper-check` in the group feature_helpers, and the group conformance runs the TypeScript and conformance checks.

- G5.125: CI runs the dbspec apply targets in the group dbspec_apply and the other dbspec targets with `case-database-check` in the group dbspec.

- G5.124: CI runs the client database tests in the group clients_db and the pooler tests in the group clients_pooler.

- G5.123: the feature coverage runs the cases that use no cargo test binary while the Rust coverage build runs, and the Rust cases of each database after it.

- G5.122: every verification command of contracts/features.json declares its `shard` (`rust` or `other`), and `make check` runs the feature coverage and the two shards as `make feature-coverage`, `make feature-verify-rust` and `make feature-verify-other`, each in a CI group of its own; `make feature-check` runs the three.

- G5.121: `make dbspec-apply-stress-bench APPLY_STRESS_DIALECTS=<databases>` applies the 2000 table plan to the given databases, and CI runs the MySQL apply in the group `stress_mysql` (`make feature-stress-mysql-check`) and the stress bench with the PostgreSQL and SQLite applies in the group `stress_pg_sqlite` (`make feature-stress-pg-sqlite-check`).

- G5.120: `make feature-helper-check` leaves out the helper checks that `make check` runs elsewhere (`FEATURE_SUITE_HELPERS`: `bench-database`, `case-database`, `conformance-result`, `conformance-runners`), and `make repo-check` fails on a helper check that `make check` runs twice or never.

- G5.119: the JavaScript tests start their child processes with only the variables of the case (tests/environment.mjs), so the CI group, `GITHUB_ACTIONS`, the run id and a calling make do not change their results; `make repo-check` refuses a test that passes its caller's environment to a child process.

- G5.118: `make group-rows-physical-check` and `make unselected-column-physical-check` build the state reader of their cases without a deadline before the cases run.

- G5.117: the header of scripts/github/ruleset.mjs names the required checks `push-gate` and `ci-passed`.

- G5.116: `make decimal-physical-check` builds the Rust test binary, the Go test and the state reader of its cases without a deadline before the cases run.

- G5.115: the generated-check case of the interface check requires the grouped `make check GROUP=${{ matrix.group }}` of CI and every target of `CHECK_TARGETS` in a CI group.

- G5.113: ci.yml ends with the completion check `ci-passed`, a tag `vX.Y.Z` of main creates the GitHub Release, the changelogs keep unreleased changes under `## Unreleased`, and every go.mod declares the module path of its directory.

- G5.113-5: `make repo-check` requires every go.mod to declare the module path of its directory, `github.com/polyspec/orm` at the root.

- G5.113-4: AGENTS.md states the release procedure: the version-bump pull request, the tag `vX.Y.Z` of the merged commit of main and the release workflow that publishes it.

- G5.113-3: a push of a tag `vX.Y.Z` runs .github/workflows/release.yml, whose steps `make release-verify`, `make release-versions`, `make release-assets` and `make release-publish` check that the tagged commit is on main with successful `push-gate` and `ci-passed`, that every released manifest declares the tag version and that the changelogs have its section, and create the GitHub Release with the npm tarball, the Composer zips and the notes of that section.

- G5.113-2: the last job `ci-passed` of ci.yml runs after every other job and passes only when each of them succeeded; the ruleset of main requires the checks `push-gate` and `ci-passed`.

- G5.114: the runner unit cases of `make full-run-check` read the grouped `make check` recipe and the part `feature-unit-check/select`.

- G5.113-1: CHANGELOG.md and CHANGELOG.ko.md keep the changes that no tag released under `## Unreleased` at the top, and `make version-check` requires it, with every other section a released version not above VERSION.

- G5.112: the declarations test of the PHP extension loads the modules that the extension requires, such as a shared `pdo`, when it runs PHP without php.ini, and its failure states the stdout of PHP.

- G5.111: CI runs make check as one job per CI group of the Makefile (`CI_GROUPS`), all at once, each with `make check GROUP=<group>` and only the setup steps its targets need; `make repo-check` requires that the groups run every target of `CHECK_TARGETS` exactly once; the new targets `feature-helper-check` and `feature-stress-check` run the helper checks of contracts/features.json, and `feature-check` runs the coverage and the verification commands of the features.

- G5.110: the documentation names the Rust crates `polyspec-orm` and `polyspec-orm-build`.

- G5.109: `make timing-check` runs the preempted vector tests of `polyspec-orm-schema`.

- G5.108: the conformance vector `conditions_values` matches the seeded author names with the case-insensitive condition `uthor-10`.

- G5.107: `orm-gen errors --lang php` generates the class `Polyspec\Orm\Code`.

- G5.106: the interface check case `TestPHPRecordSourceMutationChangesExtractedWire` declares its PHP fixture in `Polyspec\Orm`.

- G5.105: the PHP case `schema_set/external_documents` generates its sets in the namespace `Polyspec\Orm\Tests` that it calls.

- G5.104: the PHP extension builds with GCC 16 without warnings.

- G5.103: the PHP extension builds without the GCC warning `-Wclobbered` in its parser.

- G5.102: the Rust model of a table named `polyspec_orm` is in the module `model::polyspec_orm_model`, and a table named `orm` has the module `model::orm`.

- G5.101: `make rust-150-check` builds its generated crate against `polyspec-orm` and `polyspec-orm-build`.

- G5.100: the site renders Mermaid in the browser of the reader; `make docs-build` and the documentation checks (`make docs-check`, `make docs-verify-idempotent`, `make docs-rules-check`) run with Node only and need no browser.

- G5.99: the build job of docs-pages.yml installs the browsers before the site build, and `make repo-check` requires that of every job that builds the site.

- G5.98: every check runs in `ci.yml` on pull requests, merge groups and manual runs: the jobs `test` (make check) and `docs` (the documentation checks); `push-gate.yml` runs the job `push-gate` on pushes outside the merge queue branches, pull requests and merge groups; `docs-pages.yml` builds and deploys the site on pushes to main and manual runs; the ruleset of main requires the checks `push-gate`, `test` and `docs`.

- G5.97: the clients depend on ordered-json by its tags: `v0.0.1` for the Rust, TypeScript and PHP packages and `go/v0.0.1` for the Go module.

- G5.96: the Rust test commands select the features of `polyspec-orm` and `polyspec-orm-build` by those package names.

- G5.95: the Rust client depends on the crate `polyspec-ordered-json` and the TypeScript client on `@polyspec/ordered-json`; the locks of the Rust, TypeScript and PHP clients and go.mod resolve ordered-json from the branch main of polyspec/ordered-json.

- G5.94: the PHP client requires `polyspec/ordered-json` and uses its namespace `Polyspec\OrderedJson`; update `use OrderedJson\…` to `use Polyspec\OrderedJson\…` where code passes ordered-json values to the client.

- G5.93: orm's internal Rust crates are `polyspec-orm-testcase`, `polyspec-orm-case-clock`, `polyspec-orm-case-database`, `polyspec-orm-tests`, `polyspec-orm-bench` and `polyspec-orm-interface-symbols`, and the version check reads the versions of the `polyspec-orm` packages.

- G5.91: every change reaches `main` through a pull request and the merge queue; `.github/ruleset.json` declares the ruleset `main`, which `make github-ruleset` applies and `make github-ruleset-check` compares, and the workflows run on `merge_group`.

- G5.89: the Rust and TypeScript clients depend on ordered-json by its repository, like the PHP client; a lock update takes its main.

- G5.88: `git-check` reads the subjects of `ORM_GIT_RANGE`, which CI sets to the pull request or the pushed range, and of HEAD without it.

- G5.87: the Rust crates are `polyspec-orm`, `polyspec-orm-build` and `polyspec-orm-schema` and the npm package is `@polyspec/orm`; update dependencies and `polyspec_orm::` paths, and regenerate the TypeScript models.

- G5.86: the PHP packages are `polyspec/orm` and `polyspec/orm-dbspec` in the namespace `Polyspec\Orm`; regenerate PHP models with orm-gen after updating `use` statements.

- G5.85: `make feature-unit-check` passes again: the push-gate workflow and the extension's apply cleanup test have their owners, and the feature list is generated from its source.

- G5.48: a push is refused while a checklist item is `[~]`, by the pre-push hook and again by the CI workflow `push-gate`.

- T9.13: the PHP extension implements apply, recover, rollback and finalize like the PHP client, so it has every method of the PHP client's `Dbspec`, and its public classes are checked against the PHP client's.

- T9.12: rollback of an applied plan whose history row records a step outside the plan stops with a `chain` error in every client instead of failing on the missing step.

- T9.11: the PHP extension implements introspect like the PHP client, and the introspection cross check and a mirror of the PHP client's introspection test run it on MySQL, PostgreSQL and SQLite.

- T9.10: the PHP extension implements exportMermaid and importMermaid like the PHP client, and `make dbspec-compare-check` compares it on every input, plans and Mermaid diagrams included.

- T9.9: the PHP extension implements externalDifferences, parsePlan, emitPlan, chain, diff, compareSchemas, installedDifferences, addTablesAndColumnsSteps and planSteps with the PHP client's results, runs the PHP client's plan test and compares its plan output with the other runners.

- T9.8: the PHP extension orm_dbspec is C built with phpize instead of Rust: `Orm\Dbspec\Native` has the classes of the PHP client's dbspec surface with their mutable document graph, and parse, emit, readFile, readBytes, manifest and render give the PHP client's results, messages and exceptions; gen_stub.php writes its arginfo from the stub, and the extension build no longer needs Rust or libclang.

- T9.7: the PHP parser reports a use cycle through a document whose header names another document instead of recursing until memory runs out, and accepts digit-only column names of an audited table without a TypeError; tests/dbspec/cases.json holds both cases for every client.

- T9.6: contracts/interfaces.json declares the plan, Mermaid, apply and introspect methods of `Dbspec` as rules with their Go, PHP, Rust and TypeScript adapters, and their value types as owners, so the interface check compares them across the four languages.

- T9: the PHP extension orm_dbspec is a fifth implementation of the dbspec interface, checked against its stub, the shared vectors, the PHP client and the four clients, and declared in the interface contract; CI passed on commit T9.5.

- T9.5: the dbspec input test runs the apply runners and the stress harness with their own arguments again; only the compare runners take the inputs that their `reads` names.

- G5.83: AGENTS.md states the rules of pinned toolchains, atomic build outputs, failure messages with their fix, leased or owned ports and databases, and files found without compile-time paths.

- G5.82: `make test-servers` chooses free ports for the servers of each checkout and records them in the server environment, so two checkouts no longer contend for fixed ports, and `make repo-check` refuses a fixed port.

- G5.81: failure messages of a missing environment variable, argument or tool in the checks and tests name the fix after the cause, and `make repo-check` refuses one without it.

- G5.80: build outputs that other runs read (the `.runtime/bin` programs, stress documents, test binaries, clients/typescript/dist, run copies and the lowest Node) are built into a temporary path and renamed into place, and `make repo-check` refuses a Makefile line that writes one in place.

- G5.79: `.go-version` and `.composer-version` pin the Go and Composer releases of the checks, CI installs them and libclang 21, and `make repo-check` refuses another release with its fix.

- G5.78: Go tests find the repository from the working directory instead of `runtime.Caller`, and `make repo-check` refuses `runtime.Caller` in Go code.

- T9.4: docs/spec/dbspec.md describes the PHP extension (its classes, selection by namespace, build and checks), and the PHP client suggests `ext-orm_dbspec`.

- T9.3: contracts/interfaces.json declares the PHP extension under `extensions` with the `Dbspec` rules and owners it implements, and the interface check compares its stub with those rules, its own symbol snapshot and hash.

- T9.2: `make dbspec-compare-check` runs the PHP extension as a fifth runner on the shared cases, the stress document, the files, hashes and statement vectors, and fails unless its output equals the first Go output up to the first plan case.

- T9.1: the PHP extension orm_dbspec (clients/php-extension, built with ext-php-rs over the Rust dbspec) registers `Orm\Dbspec\Native\Dbspec` with readFile, readBytes, parse, emit, manifest and render and readonly result classes like those of the PHP client; `make dbspec-php-extension-check` checks its declarations against its stub and its results against the shared vectors and the PHP client, and CI installs the libclang of its build.

- G5.77: cargo-test copies its test binaries to disk instead of the tmpfs `/tmp`, group signals refuse the runner's own group and groups of 0 or 1, and the check runner prints memory, disk, the largest processes and the group signals to the job log every 30 s.

- G5.76: the Rust symbol inventory records the PostgreSQL insert lock helper of the catalog, and the introspection comparison test is gofmt-formatted.

- G5.75: the CI and documentation workflows cancel the run of the previous push on the same ref, and `make repo-check` requires that concurrency on every workflow that runs on push.

- G5.73: performance is measured and reported and never fails a test: the stress tests, the CPU limits of test cases, the hot-path gates and the introspection comparison print their measurements and a `WARNING` line above their reference values (the stress ratios 11, 34, 63 and 185, 1.5 times the highest CI ratio), the check runner records warnings and writes them as GitHub annotations, and `make repo-check` refuses a test that fails on a measured time above a bound.

- G5.74: the Go stress test also prints the parse ratio to an allocating reference (lines and words counted in a map), measured on the CI runner before it is asserted.

- G5.72: the Rust catalog tests probe the row and table locks of a mutation from inside its Locked publisher on a connection of their own, so a mutation that answers within one poll can no longer run to its end before the probe.

- G5.71: the first failure lines of a target leave out the failure lines printed inside a case that passed, such as the samples that a coverage test makes fail on purpose, so a real failure after them is no longer hidden.

- G5.70: the Go cancellation tests cancel only after a session that was not waiting before their statement starts waits for the lock, so a statement left waiting by an earlier case no longer cancels a case before its statement runs.

- G5.69: the documentation checks launch Chromium with a temporary directory of their own and remove it when the browser closes, so the `.org.chromium.Chromium.*` entries it leaves do not fail the step.

- G5.63-1: the PostgreSQL insert lock helper of the Rust catalog is private, so it stays out of the interface inventory, and its unit test is declared as an input of the catalog verification.

- G5.62: `make test-servers` starts each server and its log reader in a new session (`tests/new-session`), so ending the process group of the command that started them does not stop the shared servers.

- G5.68: the TypeScript cancellation case and the start_logged case assert their behaviour (a cancelled statement ends by its signal, start_logged returns after the ready line and before the server ends) instead of wall-clock upper bounds.

- G5.67: the documentation workflow runs its checks with `make docs-ci` through the runner of `make check` without test servers, and uploads the log of each check and a summary as a report under `!cancelled()`.

- G5.66: every step of the CI and documentation workflows runs a make target (install, install-* and ci-* targets), apart from the summary step, and `make repo-check` refuses any other command in a workflow step.

- G5.64-2: CONTRIBUTING.md states that development runs the unit tests of what changed and that the full suite runs in CI after every push.

- G5.63: a PostgreSQL row insert of the Rust catalog takes the lock of an INSERT on its table before it checks the schema and publishes Locked, instead of relying on a lock the catalog reads happened to take.

- G5.65: every check runs offline: the Makefile exports the offline settings of cargo, go, npm and Composer, `make install` downloads what the checks read, the runner records a missing download as the setup step `downloads` with `run make install`, and the targets that need it are not run.

- G5.64-1: `make repo-check` checks the full-suite rule by the wording of G5.64.

- G5.64: development runs unit tests only; end-to-end runs, `make owner-check` and the full suite run in CI after the push, and no local check is required before a push.

- G5.61: a script that starts a command in a process group of its own checks that group when the command exits and fails on any process left in it (`endGroup`), and `make repo-check` refuses a `detached: true` spawn without that check.

- G5.60: `make repo-check` also refuses an `os.Exit` reached through a helper of the same package after a `defer`, and the five programs that did so (the bench installer, two examples, the Go conformance runner and the Go introspection tool) end with `os.Exit(run())`, so their deferred close runs.

- G5.59: a run first drops the bench and decimal databases that a killed run (`orm_owner_<pid>_…`, `orm_check_<pid>_…` whose process no longer runs) left on the test servers.

- G5.58: the four stress tests also time a reference workload (one checksum pass over the same document) and print its median CPU time and the ratio of the parse to it, without asserting it, so that CI shows whether a ratio budget holds across machines.

- G5.57: a FAIL line that points at the errors reported above keeps those errors (the Go `file_test.go:N: message` lines) as first failure lines in the record and the summary, so a capped log no longer loses them.

- G5.56-1: the conformance lock helper test starts its case with the shared testcase package, which `make repo-check` requires.

- G5.56: an ended holder blocks no lease or lock: a lease records its releaser and a request waits while the releaser runs; a lease whose holder and releaser both ended is taken over (shared by any request, exclusive by the next exclusive request, which makes the resource again); the conformance check locks with `flock`, and the decimal SQLite bench prepares under a lease.

- G5.55: a test step leaves nothing behind: the check runner and `make owner-check` run each step with a temporary directory of its own and in a process group of its own, fail a passed step that leaves a temporary entry, a run directory or a process, keep a failed step's leftovers in the report and remove them in both cases; the interface and conformance checks end with `os.Exit(run())`, the Rust transaction and SQLite lock tests remove their directories on drop, the PHP testcase test removes its `tempnam` file, and `make repo-check` refuses an `os.Exit` after a `defer` in Go. At the end of each run, `databases.sh drop` also purges the binary logs of the MySQL test servers up to the current file once the replica has applied them.

- G5.54: a test run that selects no test fails: `tests/go-test.mjs` runs `go test -json` and counts the test2json `run` events of a `-run` selection, `tests/cargo-test.mjs` counts the tests that `--list` selects before it runs any, and `client-db-test.sh` refuses unknown lane names and an empty selection; the Go decimal physical tests, which never ran without their build tag, now run.

- G5.53: the sequential lanes of `client-db-test.sh`, the performance checks, the package checks and the drop of the run databases run every independent part after a failed one and name the failures; seven recipes and six verification commands that ran independent checks in sequence are split into parts and separate commands, and repository rules refuse such recipes and chained commands.

- G5.52: every CI setup step and `make check` run after a failed setup step; the runner reads the step results (`ORM_CI_SETUP`) and records the targets that need what a failed step installs as not-run with that step, the docs workflow runs each check that has what it needs, no workflow uses `continue-on-error`, and a repository rule enforces it.

- G5.51: `make owner-check` fails when a changed path selects no behaviour test and declares no scope; `contracts/check-inputs.json` separates the `inputs` of a target from its `lints` and declares `lint` or `suite` scopes with reasons for 16 exact paths, every tracked file is connected to the test that reads it (40 new verification commands, 12 helpers, 27 targets with owner scope), a helper checks the generated error codes against `docs/spec/errors.yaml`, and the database state of the conformance and decimal checks leaves out the ORM's SQLite row lock table.

- G5.50: `make codec-check` runs the Go, Rust and TypeScript codec tests itself as independent parts into a directory of its own run, and the PHP checker compares only those outputs; the writers write only when `ORM_CODEC_OUT` is set, through a temporary file and a rename.

- G5.49: the tracked `commit-msg` hook, which make installs through `core.hooksPath`, refuses a commit subject that breaks `git.subject-format`; a case that ends its process reports its error in its FAIL line; and the PHP `first_statement_lost` case finds the session of its `Db` also behind a pooler.

- G5.46: each checkout builds Rust into its own `clients/rust/target`; make stops when `CARGO_TARGET_DIR` names a directory outside the checkout, and `make check` and `make owner-check` no longer pass a target directory to their targets, because cargo would treat what another checkout built as fresh.

- G5.45-1: `make owner-check` runs the transaction end tests of Go (`transaction-end-go`) and of the Rust `tx::` tests (`transaction-end-rust`) when their files change.

- G5.45: the Go, TypeScript and Rust clients close a connection instead of returning it to the pool when a step of its transaction end (a named lock release, a local value reset, a SQLite mode reset, COMMIT or ROLLBACK) failed, so a pooled connection is clean or discarded and no later user inherits a held lock.

- G5.44: the binary log case of `test-servers-check` stops its fixture MySQL server and waits for its exit before it removes the server's directories, so no server is left writing errors into a removed log that fills `/tmp`; a `make check` report takes first failure lines from failures and not from case names, labels a SQLite disk I/O error as out of space only when a file system has no free space, names the largest removed but open file under `/tmp`, and keeps the npm debug log of a failed target with its error lines.

- G5.47: the PHP client opens one connection per `Db` again and keeps none across requests; PgBouncer or ProxySQL pool PHP connections. `new Config(poolSize: n)`, `poolIdleSize` and `poolLifetimeMs` other than zero return `CONFIG`, `Db::poolSize()` is removed, `stats()` reports `maxOpenConnections` 1, and a statement that fails with `CONNECTION_LOST` is no longer sent again.

- G5.43-4: the report of a `make check` run records df of `/`, `/tmp`, `TMPDIR` and the run, the `/tmp` mount, the largest entries of `/tmp` and the run directories, and the removed but open files under `/tmp`, at the start and after every step, and a target that fails with ENOSPC or EDQUOT gets an `out of space` first failure line with those numbers.

- G5.43: the runner of `make check` survives failed writes and the removal of the run databases, keeps a complete report, and names the actual failure lines and the space of each step.

- G5.43-3: the first failure lines of a `make check` target are its failure and error-level lines in order, also behind the lane prefixes of `client-db-test.sh`, and no longer the last lines of its output.

- G5.43-2: the databases of a `make check` run live in `.runtime/check/<run id>/databases`, which their drop removes, apart from the report beside it, and each target log keeps its first 1 MiB and last 256 KiB while it is written.

- G5.43-1: the runner of `make check` records a report or record write that fails (`report write failed: ...`) in the step and the summary and exits 1 instead of crashing, and records an unhandled error as `runner error: <stack>` of a `crashed` run.

- G5.41-1: `make checklist-check` also rejects the GitHub task list markers x and X outside an item state.

- G5.42: every browser wait of the docs check goes through one helper and, on failure, names what it waited for, the matching elements with visibility, state and the element on top, or the accessibility tree, and the requests, errors, event loop delay and host load.

- G5.40: `make repo-check` counts a test as a reader of the TypeScript build output only when it imports it, also across lines, or runs a TypeScript test with node (an argument array or an exec or spawn shell string), not when it only names the path; `full-run-check` no longer holds the build output.

- G5.41: `make checklist-check` fails on a state marker anywhere but the leading state of an item, with its file, line and column; the checklists hold only items and `AGENTS.md` defines the states.

- G5.38-5: AGENTS.md and AGENTS.ko.md state that the full suite runs on GitHub CI after a push and that one CI run collects enough information to fix every failure before the next one; a local `make check` is no required step before a push, and `make repo-check` keeps the rule.

- G5.38: the full suite runs on GitHub CI after a push, never stops at a failure, records each failure with its command, inputs, output and environment, and publishes a summary and the report of its run id.

- G5.38-4: CI runs `make check` after a failed server start, with `ORM_CHECK_RUN_ID`, and then always a `summary` step (the job summary, the run record and the server logs in the report) and a `report` step that uploads `.runtime/check/ci_<run id>_<attempt>/report/` alone; `make repo-check` allows exactly these two steps after `make check`.

- G5.38-3: `scripts/client-db-test.sh` and `scripts/typescript/sqlite-test.sh` run every test after a failed one and name each failed command with its exit status, and `tests/cargo-test.mjs` runs every test binary as `--no-fail-fast` does and names the failed ones.

- G5.38-2: 13 targets of `CHECK_TARGETS` run their independent commands as parts `<target>/<part>` (40 in all), which `make -k` of the runner and of `make owner-check` runs after a failed part.

- G5.38-1: `make check` records a target that a failed setup step (`servers`, `databases/create`) blocks as `not-run` with that step and its first failure lines and runs the others (`needs` of `contracts/check-inputs.json`), runs each target with `make -k`, and writes the report `.runtime/check/<run id>/report` (environment, the command, recipe, inputs and output of each target, the run directories of failed targets, `summary.md`); `scripts/check/summary.mjs` publishes the summary of `ORM_CHECK_RUN_ID`, also of a runner that did not finish.

- G5.39: a docs page that does not load names its pending requests with their age and the server's view, its failed requests, console and page errors, the event loop delay and the host load.

- G5.37: `addTablesAndColumns` creates the missing indexes of existing tables along with missing tables and columns and returns each as `table.index`; a missing unique key stays `SCHEMA_DIFFERS`, named `add_unique <table>.<name>: a missing unique key can fail on the existing rows; add it with a plan`.

- G5.37-1: the test MySQL servers rotate their binary logs every 64 MiB and remove a log an hour after its last write (`MYSQLD_BINLOG` of `scripts/test-servers.sh`), from the next `make test-servers`.

- G5.33-14: `make conformance-check` checks the common state contracts on the outputs of its own run, which list the statement kinds of each sequence (transaction control included since T42), names every difference statement by statement, and `make check` now covers every CI check.

- G5.33-13: CI runs the interface results checker through `make interface-results-check`, which exports the lease variables, and `make repo-check` fails a workflow step that runs a lease-reading program outside make.

- G5.36: the PHP client keeps connections across the requests of a process with `new Config(poolSize: n)`: a `Db` takes a connection of the pool of its DSN, the first `poolIdleSize` connections (all when zero) stay open for the `Db` of a later request with the session settings of their connect, a `Db` beyond the pool gets `CONFIG`, and a request that ends inside a transaction has it rolled back with its MySQL named locks, MySQL local values and SQLite modes. Every client reports a connection that the server ended or that broke with the new code `CONNECTION_LOST`, and the PHP client sends the first statement of a `Db` once more on a new connection when it fails so.

- G5.34-2: `make rerun-failed` runs on a commit that descends from the recorded one, rerunning the targets that did not pass and the owner targets of the paths changed since that commit.

- G5.33-12: the processes that one exclusive lease holder runs at once take that lease one exclusive holder at a time, so a feature step no longer rebuilds the TypeScript client while another loads it.

- G5.30-16-1: the interface guard test requires the `tests/go-run.mjs` form of the interface self-test command.

- G5.32-9: the `server_transactions` event case compares the TimeZone source only on a direct PostgreSQL connection; through a pooler, which applies startup parameters with SET, it compares the setting and the transaction counts.

- G5.34-1: the full-run record lists only the failed targets under `failed` and the unfinished ones under `incomplete`, and `make rerun-failed` reruns both.

- G5.33-11: the environment file of each run names its own send-savepoint SQLite file, so the Rust client database tests of `client-db-check` run their SQLite case again.

- G5.32-8: the raw SQL API is removed from the four clients: `raw`, `andRaw`, `orRaw`, `orderByRaw`, `groupByRaw`, `setRaw<Col>`, `addRawColumn<Alias>` and the format string of `addColumn<Col>Alias<Name>`, which takes a column function only; the IR carries no SQL text, every bind slot has a dbspec type, and the Rust client reads a MySQL `YEAR` cell.

- G5.32-7-1: the Go plan cache key includes the `not` of a condition group, so a negated group no longer reuses the plan of the same group without `not`.

- G5.34: `make check` and the new `make rerun-failed` start with the full suite guard (`scripts/check/full-run.mjs`), which refuses before any step while a checklist item is `[~]` (listing each ID and title), while tracked files have uncommitted changes, while another run of the checkout is in progress and, for `make check`, when `.runtime/full-run.json` records a full run of the same tree. The runner writes the record before the first step and after each step, so a killed run stays `incomplete`; `make rerun-failed` runs only the targets of the current tree's record that did not pass.

- G5.30-16: every `go run` of the checks builds through `tests/go-run.mjs` as a long operation with step logs and no deadline, and `make repo-check` fails a raw `go run`.

- G5.35: `make rust-fmt-check` checks `bench/rust` and `tests/interfaces/rust` as well as `clients/rust`, and both are formatted.

- G5.32-7: negated condition groups `not(fn)`, `andNot(fn)` and `orNot(fn)` render `NOT (…)` in the four clients, and docs/spec/dsl.md states the query expression grammar and its relation to the dbspec `check` grammar.

- G5.33-9: Rust tests receive the paths of the package programs they run through `ORM_PROGRAM_<NAME>` from copies taken under the target lease (`orm_testcase::program`), and `make repo-check` fails `env!("CARGO_BIN_EXE_...")`.

- G5.33-8: the conformance and interface checkers build their Rust programs under the target lease and run copies, and `scripts/check/run.mjs` passes the target directory it was given to its sub-makes.

- G5.30-15: the Go conformance and interface checkers build their runners as long operations with step logs and no deadline (`testcase.RunLong`).

- G5.32-4-1: `bench/rust/Cargo.lock` records the `libsqlite3-sys` dependency of `orm`, so `make rust-fetch` passes again.

- G5.32-6: the timeout and cancellation tests of the four clients make a statement wait for a row lock that another connection holds instead of calling a sleep function through the raw API.

- G5.33-10: a lease that its holder released while another run was being refused is no longer taken for a dead lease, so waiting runs no longer fail on it.

- G5.30-14: the MySQL migration of `make test-servers` runs each step with step logs and no deadline, and waits for the replica without a timeout.

- G5.33-7: targets that only read the TypeScript build output hold a shared lease, `conformance-check` and the feature steps of `make owner-check` hold the exclusive one, and a lease held by an ancestor process counts as held by its children.

- G5.33-6: the Rust builds of the feature verification commands, the feature coverage checker and the scripts hold the target lease, the programs they run are copies, and the copies are copy-on-write clones where the file system supports them.

- G5.33-5: every `cargo test` of the Makefile, the feature verification commands and `scripts/client-db-test.sh` runs through `tests/cargo-test.mjs`, which builds under the target lease, copies the test binaries into a run directory and runs the copies.

- G5.32-4: connecting sends no probe statement: every client reads the SQLite version from the library its driver links instead of `SELECT sqlite_version()`, and the TypeScript client opens its first connection without `SELECT 1`.

- G5.32-5: the Go PostgreSQL client prepares a statement text once per connection again (pgx statement cache), since the exec query mode of G5.32-1 made the steady state of a pool 24 to 44 % slower; pooled clients prepare once per connection and reuse, and only PHP sends each statement in one round trip.

- G5.33: runs from different checkouts and sessions no longer break each other's test resources: the test servers, the shared Rust target directory and the TypeScript build output are leased, and the bench and decimal databases and the run files are per run (G5.33-1 to G5.33-11).

- G5.33-4: the SQLite file of `rust-send-savepoint-check` and the Go test binary of `timing-check` live in the run directory, and every make target that builds the TypeScript client holds its build output as the only holder.

- G5.33-3: make targets run copies of the Rust programs they built, taken under the lease of the shared target directory, write their stress documents into a run directory of their own, and every cargo build of the Makefile holds that lease.

- G5.33-2: no bench or decimal database is shared: `make check`, `make owner-check` and the new `make run-databases` create the databases of their run, and the environment of `make test-servers` names only the server DSNs those runs build theirs from.

- G5.33-1: runs that use the test servers hold a shared lease (`tests/lease`), and `make test-servers-stop`, a fresh start and the MySQL migration hold the exclusive lease and are refused while a lease is held, naming the holders; `make test-servers-leases` and `make test-servers-leases-clear` list the leases and remove dead ones.

- G5.32-3: on PostgreSQL the Rust client binds every value as the type its plan slot declares and no longer describes statements or reads column origins from the catalog; the first run of `server_transactions` spends 13 server transactions for 8 statements instead of 15.

- G5.32-2: every bind slot of the four planners carries the dbspec type of the value its placeholder takes (`col_type`, and `key_types` for a parent slot); a slot without a type is `IR_INVALID`, and only raw fragment placeholders stay untyped until G5.32-3.

- G5.30-13-1: the test servers stop through the Go command `tests/stop-process` (kqueue on macOS, pidfd on Linux), which the Makefile builds as a long operation; the Python helper is removed, and `make repo-check` fails a tool in a language outside Go, PHP, Rust and TypeScript.

- G5.30-13: `make test-servers-stop` waits for each server process to exit through an operating system event (`scripts/stop-process.py`: kqueue on macOS, pidfd on Linux) instead of polling, with no deadline.

- G5.30-12: the documentation smoke test starts its server and browser as long operations with no deadline and checks each page, the links, search and mobile navigation as cases of their own; the package declaration test packs, installs and runs tsc as long operations, checks the result as a case and exits 1 when a case fails.

- G5.30-11: `make test-servers` starts ProxySQL, PgBouncer and both PostgreSQL servers with no deadline, shows their log lines up to the ready line, returns on that line and fails with the log when a server exits first; PostgreSQL stops by fast shutdown without the 60 s limit of `pg_ctl -w`.

- G5.32-1: on PostgreSQL the Go client sends every statement unprepared in the pgx query mode `exec`, with its text binds in one round trip, instead of a separate prepare round trip and transaction per statement text on each connection.

- G5.30: every build, install, tool run, server start, whole suite and CI step runs with detailed step logs and no deadline, only test cases keep their own deadlines, and `make repo-check` fails a deadline on a long operation (G5.30-1 to G5.30-16).

- G5.30-10: `make docs-build` and `make docs-verify-idempotent` build the documentation as long operations with step logs and no deadline.

- G5.30-9: the builds of the feature coverage checker run as long operations with step logs and no deadline; `COVERAGE_BUILD_DEADLINE` is removed, and each coverage run keeps its own deadline.

- G5.30-8: no step or job of `ci.yml` and `docs-pages.yml` has `timeout-minutes`, and `make repo-check` fails a workflow with one.

- G5.30-7: the Makefile runs its builds, installs and tool runs under `RUN_LONG` with no deadline, `RUN_CASE`, `BUILD_DEADLINE`, `TOOL_DEADLINE` and `tests/run-case.mjs` are removed, and `make repo-check` fails a long operation outside run-long or under any deadline, a `go test` binary deadline included.

- G5.30-6: `tests/go-test.mjs` builds the test binaries of every `go test` as the long operation `go-build/<packages>` with step logs and no deadline, and `fuzz-check` and the Go build of `timing-check` run under `tests/run-long.mjs`.

- G5.30-5: every TypeScript build and type check of the Makefile, `npm run typescript:test` and `scripts/typescript/sqlite-test.sh` runs under `tests/run-long.mjs` with step logs and no deadline.

- G5.30-4: the `cargo test --no-run` build before every `cargo test` run of the Makefile, the feature verification commands and `scripts/client-db-test.sh` runs under `tests/run-long.mjs` with step logs and no deadline.

- G5.30-3: the tsc, go vet and cargo build steps of the feature verification commands run under `tests/run-long.mjs` with step logs and no deadline.

- G5.30-2: `tests/run-long.mjs` (`RUN_LONG` in the Makefile) and `runLong` of `tests/testcase.mjs` run a long operation with step logs, its exit code and result, and no deadline.

- G5.30-1: AGENTS.md states that a test case has its own timeout and that a long operation (a build, an install, a tool run, a whole suite or a server) gets detailed step logs instead of a timeout, with no deadline.

- G5.31: the PHP client sends every PostgreSQL statement with its binds in one round trip (`Pdo\Pgsql::ATTR_DISABLE_PREPARES`) instead of a separate prepare round trip and transaction per statement text, and sets the session time zone as the startup parameter `TimeZone=UTC` instead of `SET TIME ZONE`; `server_transactions` of `tests/events/vectors.json` counts the server transactions per statement in the four clients.

- G5.29: every check reports each case with its own deadline, CI steps that run suites have no deadline of their own, each test runs once per push, and `make owner-check` runs only what a changed file is an input of (G5.29-1 to G5.29-13).

- G5.29-13: every `go test` of the Makefile, the feature verification commands and the scripts first builds its test binaries as the case `go-build/<packages>` with a deadline through `tests/go-test.mjs`, `fuzz-check` runs under run-case, and `make repo-check` fails a `go test` outside them.

- G5.29-12: `make check` runs the `go generate` and `git diff` of `clients/go/model` once, in `go-model-check`; `generation-go` runs the generator tests only, and `make repo-check` fails a `go generate` that `make check` would run twice.

- G5.29-11: `make checklist-check` compares the ids and states of indented sub-items between the English and Korean checklists, as it does for top-level items, and accepts ids such as `G5.29-4`.

- G5.29-3: `make owner-check` runs only the verification commands and coverage parts whose declared inputs contain a changed file; shared helpers such as the PHP and TypeScript coverage runners run only their own checks, `planner-go` runs per engine package, and a verification command without inputs fails the feature check.

- G5.29-2: CI no longer runs Go and codec tests again after `make check`; `go vet` runs in the new `go-vet-check` and the PHP codec cross-check in the new `codec-check`, which fails when an output of the Go, Rust or TypeScript codec test is missing, and `make repo-check` finds a re-run by the test runner it starts instead of the exact command text.

- G5.29-1: CI steps that run `make` or a test runner have no `timeout-minutes`, since their cases carry their own deadlines; other steps keep their own, and `make repo-check` enforces both.

- G5.29-10: the TypeScript builds of `scripts/typescript/sqlite-test.sh`, `npm run typescript:test` and `make conformance-result-check` run under `tests/run-case.mjs` with a deadline and show their output, and `make repo-check` checks the build tools of the Makefile recipes, the `package.json` scripts and the shell scripts too.

- G5.29-9: every `cargo test` run of the Makefile, the feature verification commands and `scripts/client-db-test.sh` first builds its test binaries with `cargo test --no-run` as a case with a deadline, and `make repo-check` fails a `cargo test` run without that build.

- G5.29-8: the tsc, go generate, go vet and cargo build steps of the feature verification commands run under `tests/run-case.mjs` with their deadlines, and `make repo-check` fails a verification command that runs such a tool outside it.

- G5.29-7: the PHP and TypeScript decimal database tests report each case with its deadline and elapsed time, and `make repo-check` fails a PHP or TypeScript test that a check runs without the shared case report.

- G5.29-5: the MySQL TLS tests of Go, PHP, Rust and TypeScript report each case with its deadline and elapsed time, the Go connection test reads through the case context, and `make repo-check` fails a Go or Rust test that starts no case of the shared testcase package.

- G5.29-6: the version check test reports each case with its deadline and elapsed time, and `make repo-check` fails a JavaScript test that declares its tests with `node:test` directly instead of `caseTest`.

- G5.29-4: AGENTS.md states that a long operation gets detailed step logs in addition to its own timeout, instead of in place of one.

- G5.27: `make owner-check` runs only the changed features' verification and coverage and the make targets that `contracts/check-inputs.json` declares with scope `owner`; whole-suite targets have scope `suite` and run only in `make check`, and a target without a scope fails the selection. `scripts/features/coverage.mjs --feature <id>` fails on an unknown id with the list of valid ids, and the feature unit tests run in the new `make feature-unit-check`.

- G5.28: a Rust transaction with `timeout_ms` fails with `CAPABILITY_UNSUPPORTED` on MySQL and SQLite, as in Go, PHP and TypeScript, instead of running its callback under a client timer that did not stop the statement on the server; on PostgreSQL the option is the server's `statement_timeout` alone.

- G5.28-1: the Rust symbol snapshot no longer lists the function `cancelled` that G5.28 removed from `tx.rs`, so the interface check passes for Rust again.

- T42: every client publishes an event for each statement it sends to the subscribers of the connection, with its text, masked binds, kind, tables, elapsed time, transaction number and error, in place of the `OnQuery` hook; plan steps name their tables, and every client sends the same transaction control statements.

- G5.26: a documentation page shows `{{` in text and code as written instead of running it as a Vue interpolation, and `make docs-build` fails when the server render of a page fails; the checklist page, which rendered empty, shows G5.5 again.

- D4: the documentation site at https://polyspec.github.io/orm/ is the build of the current commit, deployed by the `docs-pages` workflow.

- G5.25: the conformance check restores a PostgreSQL sequence by the table that owns it in `pg_depend`, so a table whose sequence name PostgreSQL truncates is restored too.

- G5: the GitHub Actions build passes: `make check` runs every target on `ubuntu-26.04-arm` against servers that `make test-servers` starts, and the docs site deploys.

- G5.6: the PHP check without MySQL runs `php -n` with the extensions the client uses on SQLite, and passes on the Linux runner.

- G5.24: `make test-servers` keeps the first report of a starting server when a signal interrupts the wait for it, so an exit is no longer reported as a missed deadline and the wait no longer hangs.

- T41.1: the make targets that `make owner-check` selects run with the server environment, the decimal environment and the Rust target directory that owner-check receives, so a check in a worktree uses the servers and the target directory of the main checkout.

- G5.22: every check runs the programs that cargo builds from the declared `CARGO_TARGET_DIR` and fails when it is unset, instead of naming `clients/rust/target`; `make repo-check` rejects a run command that names that directory.

- G5.22-1: Rust tests read their package directory when they run, so a test binary built in another checkout that shares the target directory finds the fixtures of the checkout that runs it; the feature coverage runner gives Rust test binaries that directory as cargo test does, and `make repo-check` fails a Rust line that reads `env!("CARGO_MANIFEST_DIR")`.

- G5.23: `TestWithContextCancelsInsideTransaction` cancels the blocked read when the server reports it waiting for the lock, instead of after a fixed delay that could end before the statement started.

- G5.21: the TypeScript client no longer ends the process when the PostgreSQL server ends a pooled connection that is idle or closing, such as one that a `DROP DATABASE ... WITH (FORCE)` right after `close()` ends; the next statement opens a new connection.

- G5.18: the environment file of `make test-servers` defines `ORM_TEST_MYSQL_SERVER_DSN` and `ORM_TEST_POSTGRES_SERVER_DSN`, which only the Makefile set, so `go test` outside make reads them too, and `start` rewrites the file for running servers.

- G5.20: the MySQL test servers run with `lower_case_table_names=1` on every platform. `make test-servers` moves the data of servers started with another value by a recorded, resumable migration that refuses colliding names, keeps the earlier data directories and verifies every count; with the declared value it changes nothing.

- G5.19: `docs-pages.yml` builds the static site in its own step before the idempotence check and runs the browser check as a smoke test of the output, so the workflow has its build and smoke stages.

- T41: `make owner-check` also runs every make target of `CHECK_TARGETS` whose inputs, declared in `contracts/check-inputs.json`, match a changed path, so a changed document runs `make docs-check` and `make docs-verify-idempotent`; `make repo-check` requires the inputs of every target.

- G5.17: CI sets up PHP with `coverage: none`, which `make repo-check` requires, and the PHP hot-path regression check refuses to measure with Xdebug or pcov loaded.

- G5.16: the primary and replica cases of the four clients wait up to 60 s for the MySQL replica, which applies the parallel writes of every client one after another.

- G5.13: `make test-servers` waits for each pooler's ready line only up to a declared deadline and then fails with the server, the deadline and its last log lines, and every workflow step declares its own `timeout-minutes`, which `make repo-check` requires.

- G5.15: every make target that runs cargo with `--offline` first runs `make rust-fetch`, which fetches the locked crates of `clients/rust` and `bench/rust`, so a fresh runner no longer fails with `no matching package`.

- G5.14: `make docs-rules-check` fails on an HTML element outside code in a documentation page other than `<br>`, which VitePress would compile as an unclosed element; the T40 checklist messages that broke `make docs-check` are inline code.

- G5.12: `make test-servers` reads the output of ProxySQL and PgBouncer line by line with `sh` instead of `awk`, whose Ubuntu implementation `mawk` held the ready line until the server exited, so the start no longer waits on the Linux runner.

- G5.11: `make test-servers` fails before it starts a server when a socket path under `.runtime/servers` exceeds the Unix limit of the platform, naming the path, its length and the limit.

- G5.10: `make test-servers` starts every MySQL server with `--secure-file-priv=NULL`, so a build whose compiled default names a missing directory, such as `/var/lib/mysql-files` of the Ubuntu packages, starts as the local servers do.

- T40: `utils().schema().register(schema)` registers a schema set on a connection without a statement, and `connectSchema` registers the same way, so a connection opened per request registers its sets without reading the database. `install` and `addTablesAndColumns` now end by comparing the tables of the set in the database with the set (`InstalledDifferences`) and fail with `CONFIG` naming each difference, such as a column changed outside the ORM; the database is verified at install and upgrade, not per request.

- T7.D12: `make docs-rules-check` checks every tracked Korean document, including `AGENTS.ko.md`, `README.ko.md` and `CHANGELOG.ko.md`, and compares the list items of each section with the English source. The Korean rules, changelog, README and codec page are corrected to translate their English sources.

- G5.9: `TestCIRequiresGeneratedChecks` requires that CI runs `make check`, whose `CHECK_TARGETS` hold the generated model checks and whose `feature-check` runs the common interface check, instead of the separate steps that G5.5 and G5.7 removed.

- G5.8: every workflow job runs on `ubuntu-26.04-arm`, declared in `.github/runner`. CI installs MySQL 8.4.11 from the Ubuntu 26.04 packages, PostgreSQL 17 from the PostgreSQL apt repository, the arm64 ProxySQL 3.0.9 package checked by its sha256, and PHP 8.4 for `make php-min-check` through setup-php from the version `scripts/php/php-min.sh` reports. `make repo-check` fails when a job runs on another runner.

- G5.7: the CI workflow no longer runs `make interface-check` and `make perf-check` beside `make check`, whose `feature-check` runs their commands. `make repo-check` fails when a workflow runs a verification command of `contracts/features.json` again.

- G5.5: the CI workflow runs `make check`, every target of `CHECK_TARGETS` through the runner of the local checks, instead of 17 of its 43 targets in separate steps; the later steps run after a failure too. `make repo-check` fails when the workflow omits a target of `CHECK_TARGETS` or runs one twice.

- G5.4: the checks and every workflow run one PHP release, declared in `.php-version` (8.5), and one Rust toolchain, declared in `rust-toolchain.toml` (1.98.1 with clippy and rustfmt), which the Makefile reads and CI installs with `rustup toolchain install`. The new `make php-min-check` runs the PHP client unit tests on the lowest release of `require.php` (8.4). `make repo-check` fails when a workflow or the Makefile chooses its own PHP or Rust version or the running one differs from the declaration.

- G5.3: the checks and every GitHub Actions workflow run one Node release, declared once in `.node-version` (26.8.1); the workflows read it with `node-version-file` instead of `22.16.0` and `24`, whose `node:sqlite` printed an `ExperimentalWarning` that the coverage checker rejects. `make repo-check` fails when a workflow declares its own Node version or the running Node differs from `.node-version`. The TypeScript client still supports Node 22.16.0, which `make ts-min-check` runs.

- T39: the generated models no longer depend on how a path is written. Rust `orm_build::Builder` includes the manifest by the canonical path of the output directory, so a relative, absolute, `./` or trailing-`/` spelling of `out_dir` gives the same source; Go, PHP, Rust and TypeScript each check this on one fixture with four spellings of the scan and output paths.

- G5.2: the CI workflow installs MySQL 8.4.11 from five packages of its Ubuntu 24.04 deb bundle through apt, which installs their dependencies such as `libaio1t64`, so `make test-servers` finds `mysqld` at `/usr/sbin/mysqld` without a symbolic link. `make repo-check` fails when a workflow step creates a symbolic link.

- G5.1: the CI workflow starts the servers of the database checks with `make test-servers`, as the local checks do: the MySQL and PostgreSQL primaries and replicas, ProxySQL and PgBouncer, with every DSN of `.runtime/servers/env` in the environment of its later steps. `make repo-check` fails when the workflow lacks a variable that `scripts/test-servers.sh` writes, defines one itself, writes the environment file or runs a make target before the servers start.

- T35.4: PHP plans the audit record of a set registered by its schema value without its generated classes: such a set has its runtime model from its manifest text and external text, as in Go, Rust and TypeScript.

- T36: `make owner-check` selects and runs the checks that own the changed files: every feature whose declared fixtures or tests contain a changed file, or whose fixture files, or the JSON files they name, name one, with its verification commands and coverage as steps with a deadline each (`scripts/features/owners.mjs`).

- T37: the internal helpers of the utilities have one name and one place in the four clients: `Utils` owns `active`, `run` and `read`, and the schema, privilege and AES utilities call them through it (PHP `UtilsSql` and TypeScript `inTx` are removed, Rust `reader` is `read`). No behavior changes.

- T35.1: a document set can use tables of another set without owning them. External documents, given with Go and PHP `orm-gen gen --use`, TypeScript `orm-gen gen --use` and Rust `Builder::uses`, are validated with the set but never rendered, installed, altered, compared or generated; `manifestHash` covers the used external tables, install, addTablesAndColumns and the connect of a generated schema value fail with `CONFIG` when those tables differ from the database, and a plan whose target uses an external document is invalid.

- T35.2: the audit values come from an audit source of the connection config instead of a handle: Go `Config.AuditSource(ctx)`, PHP `Config(auditSource:)`, TypeScript `connect({ auditSource })`, Rust `Config.audit_source`. A transaction with audit values calls it once, a call value wins over a source value, and the record table is the table that `references` names. `audit(defaults)` and its handle are removed.

- T35: an audited unit of work is recorded as one row of a declared audit record table. The `audit` setting is `audit into <history> column <col> references <table> action <col> previous <col> [exclude (...) | include (...)]`, and the audited table declares the restrict foreign key from the audit column to the record table's one-column primary key, so the database rejects a key that names no record; history `previous` holds the previous audit key. A transaction with audit values (Go `orm.Audit(map)`, PHP `audit:`, TypeScript `{ audit }`, Rust `.audit(pairs)` on the three builders) inserts one record from the audit source of the connection (T35.2) and its values before the callback and writes its key into every audited insert, update, soft delete and restore. The operation id, its transaction options and `setOperation` are removed.

- T34: the published TypeScript declarations import no driver module. The dbspec apply and introspection connection types name only the methods the client calls, so code that uses them type-checks with `skipLibCheck` off without pg, @types/pg, mysql2 or the node:sqlite types; mysql2, pg and node:sqlite connections still fit them.

- T32: `restore()` brings back a soft-deleted row in the four clients. Set the values of its primary key or one unique key and any new values of other columns: one `UPDATE` writes the new values and clears the soft delete column (on an audited table with the operation id, recorded in the history), and the row is read back by the key. A row that is not deleted is returned unchanged, a missing row is `NO_ROWS`, and default reads still exclude soft-deleted rows. The IR has the kind `restore`, and `restore` is a reserved column name.

- T31: Rust `Db::transaction_once(callback)` is a builder, like `transaction` and `transaction_send`, so an audited write runs through every transaction entry point with `.audit(values)` (T35); existing `.await` call sites stay unchanged and the future is `Send` when the callback and its future are.

- T31.1: `go run ./tests/interfaces/check` finds the Rust symbol tool where cargo reports that it built it, so the check runs the current tool when `CARGO_TARGET_DIR` names another target directory, as the Makefile does for every cargo command.

- T30: an `audit` setting may select the recorded columns with `exclude (col, ...)` or `include (col, ...)`, one list at most; the operation column is always recorded. The history table holds exactly the recorded columns besides its identity key, action and previous columns, the triggers copy only those columns on MySQL, PostgreSQL and SQLite, the schema text writes the setting with the `exclude` list of the unrecorded columns, and introspection restores it from the triggers. An unknown or repeated list column, both lists and a listed operation column are `setting` errors, and the PHP and Rust history table checks report one error per mismatch, as Go and TypeScript do. A value that needs encryption is encrypted by the codec before the write, so the triggers copy its ciphertext.

- T8.8.5: `utils().schema().addColumns` is now `addTablesAndColumns` (Go `AddTablesAndColumns`, Rust `add_tables_and_columns`) in the four clients: the additive upgrade of an installed document set also creates every table of the set that the database lacks, with its indexes, foreign keys, checks and audit and immutable triggers through the same plan steps, and returns a created table as `table` next to the added columns as `table.column`; every other difference is still `SCHEMA_DIFFERS` before any statement. The step functions are renamed to `AddTablesAndColumnsSteps`, `Dbspec::addTablesAndColumnsSteps`, `addTablesAndColumnsSteps` and `add_tables_and_columns_steps`, and the fixtures moved to contracts/fixtures/add_tables_and_columns.

- T8.8.4: main is merged into the dbspec branch again with N18, N19 and N19.1. A MySQL DSN connects with TLS through `ssl-mode=VERIFY_IDENTITY` and an absolute `ssl-ca` in the four clients, and the PHP and TypeScript clients refuse a DSN parameter outside the set of each scheme. `utils().schema().addColumns(schema)` (Go `AddColumns`, Rust `add_columns`) takes the generated schema value, introspects the database, compares only the existing tables of the document set and, when every difference is a missing column that is null or has a default, runs the plan steps from those tables to the set (`AddColumnSteps` in each client's dbspec module), which also replace the audit triggers of a changed table; every other difference returns the new code `SCHEMA_DIFFERS` before any statement. MySQL and SQLite add the columns outside a transaction, SQLite in one `BEGIN IMMEDIATE` transaction with foreign keys off.

- T28: the version is 0.0.2. The new VERSION file states it, and `make version-check` (part of `make check`) fails when any Rust manifest or lockfile entry of the orm crates, the PHP composer file, the TypeScript package or lockfile, contracts/features.json or the documented version differs from it.

- T27: every check finishes within minutes and `make check` reports each step; one full run passes 43 steps in 15 minutes, against about 100 minutes before.

- T29.1: dbspec apply, recover, rollback and finalize check on MySQL and PostgreSQL that the connection keeps one server session of its own and stop with a `session` error before the next statement when the session that takes the lock already holds it or a later statement runs in another session, as through a transaction pooler; the requirement is a direct or session-pooled connection.

- T29: the Rust `tx` tests that end or inspect server sessions connect through the server DSNs, so `make client-pooler-check` passes.

- T27.5: every cargo test command shares one test build, client-db-check runs its four clients in parallel lanes and feature-check runs its verification commands in four lanes (a command marked `exclusive` runs alone first); the TypeScript replica case waits on connections without a database and closes them when one fails. client-db-check takes 86 s instead of 449 s and feature-check 251 s instead of 570 s.

- T27.6: a JavaScript case that has not ended at its limit plus GRACE ends its process with a FAIL line, and a PHP case without pcntl has a watchdog process that does the same.

- T27.4: `make bench` runs the 2000-table stress cases and the timing-budget cases (the four stress parse budgets, the 2000-table plan apply, the 2000-table introspection comparison with the release Rust runner, the 2000-table runner comparison and `make timing-check`) with their assertions; `make check` runs the runner comparison and the introspection comparison on a 20-table document of the same shape (`node tests/dbspec/stress.mjs 20`), and the dbspec, integration, conformance and example runners are debug builds.

- T27.3: `make check` runs each target through scripts/check/run.mjs as a reported group with the free disk space, continues after a failure and prints every result; each run creates, seeds and finally drops its own bench and decimal databases (`make decimal-db-setup` takes `DECIMAL_ENV` and `DECIMAL_DATABASE`); every cargo command uses one toolchain and one target directory without incremental data and with line-table debug info; build limits are 8 minutes. The Rust `tx` probe tables live in case databases, and case-database-check counts only the leftovers of finished processes. The targets take about 36 minutes instead of about 100.

- T27.2: `go run ./tests/conformance/check run` takes several `-driver`/`-dsn` pairs, builds the Rust, TypeScript and Go runners once and runs each prebuilt runner under a 1-minute limit; `make conformance-check` checks the three databases in one run, and the run lock is per bench database.

- T27.1: `make feature-check` builds the state reader, one Go test binary per package and the test binaries of each Rust crate once, before its cases, and every coverage run executes those binaries (a Rust entry runs all its symbols in one process of each test binary that compiles the declared file) under a 2-minute limit per process instead of 10 minutes; the three databases run side by side; the state digest hashes typed values instead of JSON; an identical verification command runs once; and the verification commands use the TypeScript client the target builds once. The check passes again (the T25 case-database helpers belong to `schema_install`) and takes 17 minutes from an empty Rust target instead of 34.

- T26: the rollback failure cases of every client end the server session of the transaction through `ORM_TEST_MYSQL_SERVER_DSN` and `ORM_TEST_POSTGRES_SERVER_DSN`, the server DSNs that the make targets export and a pooler check keeps, instead of a `KILL` that ProxySQL takes as its own command, and the Rust session connection is a client connection that sends no `extra_float_digits`, so the cases pass through ProxySQL and PgBouncer.

- T25: every client database case that checks an empty database or installs a schema creates its own database `orm_case_<pid>_<n>` (on MySQL and PostgreSQL) or SQLite file and drops it when it ends, also after a failure, so a table left in the shared test databases no longer fails it; `make case-database-check` leaves a table in both shared databases and requires the model cases of the four clients to pass and leave the shared databases as they were.

- T25.4: the Rust database tests and the `integration` program create a database of their own, `orm_case_<pid>_<n>` or a SQLite file (the workspace crate `orm-case-database`), for every case that installs a schema or checks an empty database, and drop it when the case ends, also after a panic, instead of dropping and installing tables in the shared test databases.

- T25.3: the TypeScript database tests that install a schema or check an empty database create a database of their own, `orm_case_<pid>_<n>` or a SQLite file (clients/typescript/tests/case-database.mjs), and drop it when the case ends, also after a failure, instead of dropping and installing tables in the shared test databases, so a table left there no longer fails `schemaEmpty`, `conditions` or `joinsAndRelations`.

- T25.2: the PHP database tests that install a schema or check an empty database create a database of their own, `orm_case_<pid>_<n>` or a SQLite file (clients/php/tests/case_database.php), and drop it when the case ends, also after a failure, instead of dropping and installing tables in the shared test databases.

- T25.1: the Go database tests that install a schema or check an empty database create a database of their own, `orm_case_<pid>_<n>` or a SQLite file (internal/testdb), and drop it when the test ends, also after a failure, instead of dropping and installing tables in the shared test databases.

- T24.6: the JavaScript, PHP and Rust case reports write a duration that rounds up to the next unit in that unit (`1s`, not `1000ms`), as Go does.

- T24.5: the build, format, lint and package commands of the checks run as cases through tests/run-case.mjs: `RUN` with a deadline, their output lines as `STEP` lines with the elapsed time, and `PASS` or `FAIL` with the exit status, and a command past its deadline is stopped. The codec cross-check and the feature manifest validation report their cases.

- T24: every check reports each case while it runs, with its start and deadline, its steps, and its result and elapsed time, in one form in Go, JavaScript, PHP and Rust, and no check bounds a whole run in place of the per-case deadlines.

- T24.4: every Rust test case prints `RUN <case> deadline=<d>`, `STEP` lines and `PASS` or `FAIL` with its panic message or reason and the elapsed time on stderr while it runs, without `--nocapture` (clients/rust/testcase), and a case past its deadline ends the test binary with a FAIL line. The `integration` program and the `dbspec_stress` example report their cases the same way.

- T24.3: every PHP test case prints `RUN <case> deadline=<d>`, `STEP` lines and `PASS` or `FAIL` with its reason and the elapsed time (tests/testcase.php), runs under its own deadline (a SIGALRM interrupts a stuck case where pcntl exists) instead of a whole-script limit, and a failing case no longer hides the cases after it where the script runs them in a loop. `make conformance-result-check` runs its four commands directly without the Python runner.

- T24.2: every JavaScript test case and every Node check runner prints `RUN <case> deadline=<d>`, `STEP` lines and `PASS` or `FAIL` with its reason and the elapsed time while it runs (tests/testcase.mjs), each case with its own deadline. `make feature-check` reports each coverage run and each verification command as it runs, and `node scripts/features/check.mjs --run --feature <id>` runs one feature's commands. The T19 and T20 records write their message placeholders as code, so the documentation builds again.

- T24.1: every Go test case prints `RUN <case> deadline=<d>` when it starts, `STEP` lines with the elapsed time while a long case runs, and `PASS`, `FAIL` with its reason or `SKIP` with the elapsed time when it ends (internal/testcase). Each case has its own deadline, and a case that passes it fails with every goroutine stack. The Go checks of the Makefile, the client and performance scripts and the feature commands run with `go test -v -timeout 0` instead of whole-binary limits, and the conformance and interface checks report their build, language and comparison cases the same way.

- N3.2: a connection plans only the schema sets registered on it, in every client. The connect helper of generated code (Go `model.Connect`, PHP `Polyspec\Orm\Tests\Model\connect`, Rust `model::connect`, TypeScript `connect`) opens a connection and registers its set through `connectSchema`, and `install(schema)` takes the generated schema value and registers the set it installs; a raw connection registers none. A request of a set that is not registered on its connection fails with `SCHEMA_HASH_MISMATCH` before execution, also with a cached plan, and a manifest text that does not hash to its declared hash fails with `CONFIG` when it is connected or installed. Go checks the schema before its plan cache, so edited generated code no longer runs from a cached plan.

- N3.3.1: this branch provides no `utils().schema().register(manifestJson)`; a set reaches a connection through the connect helper of its generated code or through `install()`, and the records say so.

- T18: a relation request carries every component of its key, one `{left, right}` pair per component in key order (`keys` in place of `left` and `right`), and each `match<L>With<R>()` adds one pair, so `composite_membership` loads from `composite_account` by `tenant_id` and `account_id` together in Go, PHP, Rust and TypeScript, also through a child with its own connection. An empty key list, a pair without a column or a column used twice on one side is `IR_INVALID`. Rust `Core::add_match` replaces `set_match`.

- T8.9.1: each client checks the dbspec signature on bytes that the caller read, with the name its messages use: Go `dbspec.ReadBytes`, PHP `Dbspec::readBytes`, TypeScript `readDbspecBytes` and Rust `dbspec::read_bytes`, and the path readers use it. Bytes that are not UTF-8 after the signature are one `encoding` error `<name> is not valid UTF-8` at the first invalid byte in every client; TypeScript no longer replaces them with U+FFFD and Rust no longer returns an I/O error.

- T21.2: the Rust catalog writes `date`, `time` and `datetime` columns with `Date`, `Time` and `DateTime` binds in the dbspec text form, including temporal row identities, and reads back the written cell on MySQL, PostgreSQL and SQLite instead of failing with `ROW_WRITE_MISMATCH`.

- T21.1: on SQLite a described `DATE`, `TIME` or `DATETIME` column reads as the same `Date`, `Time` or `DateTime` grid cell as on MySQL and PostgreSQL, a value outside the dbspec form fails with `GRID_TEMPORAL_VALUE`, and a read-only grid query keeps the stored text.

- T22: the root package.json no longer has the `schema:check` script, whose script file was removed, and `make repo-check` fails when a root npm script names a path that is not a tracked file or directory.

- T21: the Rust catalog grid decodes MySQL `DATE`, `TIME` and `DATETIME` and PostgreSQL `date`, `time` and `timestamp` cells as `Date`, `Time` and `DateTime` in the dbspec text forms, with exactly the declared fraction digits in a table page and six in a read-only grid query, so a table with a datetime column pages on every database.

- T20: the Rust `client_bench` and the bench/rust `native` and `driver_compare` require their iterations argument; a missing argument or a value that is not an integer of at least the program's minimum ends the program with status 1 and an error naming the argument and the value, instead of running 3000 or 1000 iterations.

- T19: a generated Go relation getter returns `(<result>, error)` and a Rust relation getter `orm::Result<Option<..>>`; a row without a related row reads as no result, and a stored relation value of another type is `INTERNAL` instead of a dropped type assertion or a `None`.

- T8.8.3: main is merged into the dbspec branch again with N17: the PHP client requires no PDO driver extension, and `make php-without-mysql-check` installs `schema/bench.dbs` and creates and reads a row on SQLite in the official PHP image, which has no `pdo_mysql`.

- T8.9: dbspec document files use the extension `.dbs` instead of `.dbspec`, and the header `dbspec 1 <document>` is the file signature. Every tool reads a document file with the one reader of its client (Go `dbspec.ReadFile`, PHP `Dbspec::readFile`, TypeScript `readDbspecFile`, Rust `dbspec::read_file`), which rejects a file that does not start with the bytes `dbspec `, such as a DbSchema project file or an empty file, with one `signature` error `<path> is not a dbspec document` before parsing.

- T17.7: the Go native baseline of the hot-path check runs the statements the generated client runs, its relation and list workloads bind only their keys, and the Rust native insert writes an AES ciphertext into the AES column.

- T15: every feature of contracts/features.json declares its coverage, and `make feature-check` executes each client's owner cases twice on MySQL, PostgreSQL and SQLite or once without a database; a SQLite RESTRICT foreign key violation is FOREIGN_KEY and a CHECK violation is CONSTRAINT in every client.

- T8.8.2: main is merged into the dbspec branch again with N16: each client's test entry point arms a rollback fault, and the next failed rollback is reported as `FAULT` through the single transaction-end form `transaction failed (<cause>) and rollback failed (<error>)` on MySQL, PostgreSQL and SQLite. Measured one client and one database at a time on an idle machine, the 2000-table introspection takes 0.73-2.56 s in every client, within the 5 s budget.

- T8.6.8: every client applies a plan step by step on MySQL, PostgreSQL and SQLite: each statement commits on its own with its recorded history step, recover continues an interrupted plan from the catalog effect of the next step, and rollback undoes the last plan with the rollback statement of every step. Dropped tables and columns stay hidden under `dbspec$hold$` names until finalize drops them, added columns are hidden on rollback and come back on a second apply, a rollback of an applied plan fills or refuses the NULL rows of columns it makes non-null, lock waits end after 5 seconds, and `PlanSteps` replaces `PlanStatements` with each step's rollback statement, effect and finalize mark.

- T8.8.1: main is merged into the dbspec branch, and its features work on the dbspec paths while the Mermaid source path stays removed. One process loads the generated code of several document sets and a connection plans every request with the model of its manifest hash; a request of a manifest that no loaded code registered, or code whose text does not hash to its declared hash, fails with `SCHEMA_HASH_MISMATCH`, and generated code registers its set, so no `utils().schema().register()` exists. A transaction or savepoint whose rollback fails too, also on a connection the server closed, reports one `ROLLBACK` error `transaction failed (<cause>) and rollback failed (<error>)` in every client, keeps both errors and is not retried. `docs/spec/protocol.md` states one clock rule: the client clock is UTC with microseconds, MySQL writes `CURRENT_TIMESTAMP(p)` and `NOW(6)`, SQLite relative forms keep six fraction digits, SQLite binds the client clock for an omitted `default now` column, and every `now` slot carries the fraction digits of its column. The plan history writes `applied_at` as `YYYY-MM-DDTHH:MM:SS.ffffffZ`, and the TypeScript apply clock is microseconds since the epoch.

- T10: all four clients use an ordered-json that keeps one Cargo manifest for its package, so cargo does not warn about a duplicate `ordered-json` package.

- T17.6: every time limit that a test sets on its own computation bounds CPU time (the case thread in Rust, Go and TypeScript, the PHP process) and prints CPU and wall-clock time; `make timing-check` runs the stress, Rust vector and PHP dbspec tests while their process group receives one tenth of wall-clock time.

- T17.5: the Rust native benchmarks `native` and `driver_compare` decode the bench schema types and read every workload's rows, and `make rust-driver-check` runs them against the seeded bench database.

- T17.4: the Go, PHP and Rust programs of examples/complex print the same compact JSON bytes, and `make example-check` compares the outputs of examples/complex and examples/thin-slice byte for byte against the seeded bench database.

- T8.0.14.4: a Go transaction whose context is cancelled closes its connection instead of returning it to the pool, so no named lock, user variable or SQLite mode outlives it, and it reports `CANCELED` alone.

- T8.0.14.3: every client runs `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT` after a failed or panicking nested transaction and reports a failure of either with the cause, and a Go savepoint whose transaction was cancelled or lost its connection returns the cause alone.

- T8.0.14.2: a Rust transaction future dropped before its transaction ends closes its connection at once, so over TLS too the server ends the transaction and its named locks with the session.

- T8.2.6.4.1: the Rust lock file no longer lists the removed `libc` dependency of `orm-schema`, so `cargo check --locked` passes.

- T8.2, T8.2.6, T8.3, T8.5: closed with their completed sub-items; T7.17.2.10.3 and T7.17.2.10.3.1 closed as superseded by dbspec.

- T8.2.6.4: the dbspec document set is the only schema source; the Mermaid schema source, its manifest and `orm-schema-v1` SQL, every schema CLI command that read them and the PhysicalGraph records are removed from every client, and the CLI is `orm-gen` in Go, PHP and TypeScript.

- T8.2.6.3: every generator, runtime, schema tool and schema installation reads the dbspec document set.

- T8.0.9.2: every client opens the percent-decoded path of a SQLite DSN and rejects an invalid escape, a NUL byte and a path that is not UTF-8 with `CONFIG`, checked by the shared cases of tests/dsn/sqlite-paths.json.

- T8.5.1.1: a SQLite table rebuild carries the `sqlite_sequence` counter of an identity table, so a key deleted before the rebuild is not given again, in every client.

- T8.6.7: the apply lock covers one MySQL database or one PostgreSQL schema, so applies to other databases or schemas run at the same time, an unexpected lock result is an error instead of `locked`, and an empty plan chain is valid for a database without tables in every client.

- T8.7.6.2: the Go engine tests reject a missing or mistyped dbspec vector field with its file and location, and the dbspec compare harnesses and Makefile blocks are commented in Korean.

- T8.5.7: every client lists every difference between two schema texts as `[kind, table, name]` without a plan, including the type, identity, primary key and column order changes that a plan refuses.

- T17.1: the 15-second graph-test deadline bounds CPU time instead of wall-clock time in Rust (the thread of the case), Go and PHP (the test process), so a loaded shared machine no longer fails it; every case reports both times.

- T17.3: the Rust native benchmarks read their database from `ORM_BENCH_MYSQL_DSN` instead of a fixed socket and database, exit with status 1 without connecting when it is unset or empty, and `make rust-driver-check` runs that test.

- T17.2: the Go, PHP and Rust example programs require `ORM_BENCH_MYSQL_DSN` and exit with status 1 without connecting when it is unset or empty, and the PHP examples no longer pass the removed `schemaPath`.

- T8.0.14.1: every client reports every transaction-end failure: each cleanup step runs, a `RELEASE_LOCK` that released nothing is an error, a failed rollback after a callback, begin or commit failure is reported with its cause, a Go or Rust callback that panics rolls back before the panic continues, and the Go client treats a rollback on a connection the driver closed as complete.

- T8.7.6.1: a failing Go Mermaid or plan vector case logs only its failure under an enforced deadline, and every dbspec runner rejects a missing or directory input with `<path>: <reason>` and a nonzero exit.

- T8.5.6.1: the dbspec compare runners reject a missing or mistyped vector section, id, document or line with `<file>: <location> <problem>` and a nonzero exit instead of reading it as empty.

- T8.2.6.1.1.1: closed with T8.2.6.1.3, which corrected the same links.

- T8.6: every client applies and recovers plan chains with lock, history, verification and events, and any client continues a chain that another applied.

- T8.7.5.1: `make dbspec-rust-check` runs every Rust dbspec test twice.

- T8.6.6: `make dbspec-apply-pairs-check` applies the first plan of a chain with one client and the rest with another, for every ordered pair of the Go, PHP, TypeScript and Rust clients on MySQL, PostgreSQL and SQLite, and finishes on MySQL with one client a plan another one stopped.

- T8.6.2.2: Go, TypeScript and Rust assert the apply cleanup errors like PHP; TypeScript and Rust reject a PostgreSQL unlock that released nothing, Go returns a failure without cleanup errors unchanged, and docs/spec/plans.md states how each client reports a failure with cleanup errors.

- T8.7: every client exports and imports standard Mermaid erDiagrams with the list of what each leaves out, and the four clients agree byte for byte.

- T8.7.6: `make dbspec-compare-check` compares the Mermaid export, import and round trip results of the Go, PHP, TypeScript and Rust clients.

- T8.7.2.1: Mermaid import in every client reports a label whose column counts differ, decides dbspec type ranges before keys, requires single spaces between comment parts and adds a shared foreign key index once; export reports every comment it leaves out.

- T8.6.3.1: a failed PHP apply reports its cleanup errors with the failure through `Orm\Dbspec\ApplyCleanupError`, an advisory unlock that released nothing is an error, and a MySQL effect query without a row or a result that cannot be closed is an error.

- T8.0.9: `datetime(p)` renders as a local date-time on the three databases, every client connection reads and writes it in UTC, and introspection reports time-zone columns as unsupported.

- T8.0.9.1: Go, TypeScript and Rust connections read and write datetime values in UTC like PHP, and `timezone` accepts only `UTC` or `+00:00`.

- T8.0.14: A failed MySQL `setLocal` reset at the end of a transaction is reported in every client, and a callback failure with a failed cleanup reports both errors as `CONFIG`.

- T8.0.13: Every client and schema tool asserts that a SQLite DSN with a query creates only the file named by its path.

- T8.0.11: Introspection cases assert that PostgreSQL time zone, padded, single-precision and JSON types, MySQL `TIMESTAMP`, `char` and `float`, and `NO ACTION` and `SET DEFAULT` keys are reported as unsupported in every client.

- T8.0.10: An introspection case asserts that a SQLite primary key column keeps its declared nullability in every client.

- T8.0.8: A shared DDL step asserts that the rendered binary collations keep `a`, `A`, `á` and `a ` distinct in a unique key on MySQL, PostgreSQL and SQLite.

- T8.0.7: Every client asserts on the three dialects that an insert cannot write the identity column and an update or duplicate update cannot write a primary key or identity column.

- T8.0.6: The rendered `immutable` and `audit` guards are row triggers, and a shared DDL step asserts that an `UPDATE` or `DELETE` matching no row succeeds on MySQL, PostgreSQL and SQLite.

- T8.0.5: Shared cases assert that `immutable` and `audit` are rejected on a child of a `cascade` or `set_null` foreign key in every client.

- T8.0.4: Declared and generated names over 63 bytes are rejected before rendering in every client, asserted with names of exactly 64 bytes.

- T8.0.3: The introspection cases assert that stored and virtual generated columns are reported as unsupported on MySQL, PostgreSQL and SQLite in every client.

- T8.0.2: Introspection reports prefix, partial and expression indexes as unsupported with their table and name in every client.

- T8.0.1: PostgreSQL introspection reports a foreign key whose referenced table is in another schema as unsupported instead of reading it as a key to a same-named table.

- T8.6.2.1: a failed Go apply reports its cleanup errors together with the failure, and a MySQL effect query without a row is an error.

- T8.7.4: the TypeScript client exports dbspec documents to standard Mermaid erDiagrams and imports them with the list of what each leaves out.

- T8.6.4: the TypeScript client applies plan chains with a lock, history, drift checks, transactions, verification, events and MySQL recovery, and its introspection leaves `dbspec$plans` out.

- T8.7.5: the Rust client exports dbspec documents to standard Mermaid erDiagrams and imports them with the list of what each leaves out.

- T8.6.5: the Rust client applies plan chains with `orm::dbspec::apply` under a lock, with history, drift checks, transactions, verification and events, and `orm::dbspec::recover` finishes an interrupted MySQL plan; Rust introspection leaves `dbspec$plans` out.

- T8.5.6: `make dbspec-compare-check` compares the plans of the Go, PHP, TypeScript and Rust clients, and PHP, TypeScript and Rust reject plan names over 63 bytes and run the shared plan parse cases.

- T8.7.3: the PHP client exports dbspec documents to standard Mermaid erDiagrams with `Orm\Dbspec\Dbspec::exportMermaid` and imports them with `Dbspec::importMermaid`, with the list of what each leaves out.

- T8.6.3: the PHP client applies plan chains through `Orm\Dbspec\Dbspec::apply` with a lock, history, drift checks, transactions, verification and events, and recovers an interrupted MySQL plan with `Dbspec::recover`; its introspection leaves `dbspec$plans` out.

- T8.2.2.1: Go reports the identity rule for a table without a primary key line, as the other clients do.

- T8.2.1.1: the Rust client exposes the parsed dbspec model in `orm_schema::dbspec::model`, as Go, PHP and TypeScript expose theirs.

- T8.5.3: the PHP client parses, chains, diffs and writes schema plans through `Orm\Dbspec\Dbspec`; `make dbspec-plan-php-check` applies them to MySQL, PostgreSQL and SQLite.

- T8.2.6.1.3: the Korean protocol page links the manifest section by its ASCII anchor.

- T8.7.2: the Go engine exports dbspec documents to standard Mermaid erDiagrams and imports them with the list of what each leaves out.

- T8.7.1: docs/spec/mermaid.md specifies standard Mermaid export and import with the list of what each leaves out.

- T17: the Rust client benchmark `client_bench` fails and names `ORM_BENCH_MYSQL_DSN` when the variable is unset or empty instead of connecting to a built-in local socket.

- T12: `make ts-model-check` fails when the TypeScript models script scans a source that does not call models or misses one that does, or when the committed models.ts differs from its output; the script scans only the 8 sources that call models.

- T8.5.2.2: plan names over 63 bytes are rejected, and shared cases cover plan parse errors.

- T8.5.5: the Rust client parses, chains, diffs and writes schema plans for MySQL, PostgreSQL and SQLite; `make dbspec-plan-rust-check` applies them.

- T8.5.4: the TypeScript client parses, chains, diffs and writes schema plans for MySQL, PostgreSQL and SQLite; `make dbspec-plan-ts-check` applies them.

- T8.6.2: the Go engine applies plan chains with a lock, history, drift checks, transactions, verification, events and MySQL recovery.

- T8.6.1: docs/spec/plans.md specifies how plans are applied: lock, history, drift, verification, events and MySQL recovery.

- T8.5.2.1: the Go plan writer keeps no dropped result and no unused renderer state.

- T8.5.2: the Go engine parses, chains, diffs and writes schema plans for MySQL, PostgreSQL and SQLite; `make dbspec-plan-check` applies them.

- T8.5.1: docs/spec/plans.md specifies schema plans: the plan document, the chain from an empty database, the diff and the statements of each dialect, with shared cases.

- T8.4.2.4: MySQL introspection recognizes the time CHECK of a `time(p)` column after `ALTER TABLE` writes its literals with zero fractions.

- T8.2.6.1.2: `schemaHash` is taken over one document `schema` with the tables of the set in name order, so it changes only when a table changes.

- T8.4: MySQL, PostgreSQL and SQLite introspect into dbspec in every client.

- T8.4.6: the four clients introspect the 2000-table stress database to the same document on MySQL, PostgreSQL and SQLite within 5 seconds each.

- T8.4.3.1: PHP introspects the 2000-table stress database within the default 128 MB memory limit.

- T8.4.2.3: MySQL introspection reads checks with two catalog queries instead of a join that took over a minute on 2000 tables.

- T8.4.2.2: MySQL introspection recognizes renderer CHECKs after `ALTER TABLE` rewrites their character set introducers, in the four clients.

- T8.4.2.1: introspection reports each unsupported object once, leaves the objects of a rejected table out with it, and reads only renderer-form SQLite table items, in Go, PHP, TypeScript and Rust.

- T8.4.5: the Rust client introspects MySQL, PostgreSQL and SQLite into a dbspec document: `orm::dbspec::introspect` runs the catalog queries of `orm_schema::dbspec` on a sqlx connection and returns the document and the unsupported objects; `make dbspec-introspect-rust-check` runs the round trips and the unsupported cases.

- T8.4.3: the PHP client introspects MySQL, PostgreSQL and SQLite into a dbspec document through `Orm\Dbspec\Dbspec::introspect(PDO, dialect, name)` with the catalog queries of the Go engine and reports unsupported objects; `make dbspec-introspect-php-check` runs the round trips and the unsupported cases.

- T8.4.4: the TypeScript client introspects MySQL, PostgreSQL and SQLite into a dbspec document through `introspectDbspec` with the catalog queries of the Go engine and reports unsupported objects; `make dbspec-introspect-ts-check` runs the round trips and the unsupported cases.

- T8.2.6.3.7: the bench databases are installed from schema/bench.dbspec, the conformance runners take only a DSN, and the conformance vectors are recorded from the four dbspec clients on MySQL, PostgreSQL and SQLite.

- T8.2.6.3.6: the Rust client builds its runtime model and generated code from the dbspec document set.

- T8.2.6.3.5: the TypeScript client builds its runtime model and generated code from the dbspec document set.

- T8.2.6.3.4: the PHP client builds its runtime model and generated code from the dbspec document set.

- T8.2.6.3.3: the Go client builds its runtime model and generated code from the dbspec document set.

- T14.2: the Rust decimal and generated-model coverage tests are ignored in workspace runs and run by their owners with `--include-ignored`.

- T14.1: the Rust DSN coverage test is ignored in workspace runs and run by feature-check with `--include-ignored`.

- T16: the send-savepoint SQLite file lives beside TEST_ENV, so the Rust send-savepoint tests run from any worktree.

- T14: the decimal and feature-coverage Go tests run only from `decimal-physical-check` and `feature-check`, behind build tags, so `client-db-check` no longer runs tests whose DSNs it does not provide.

- T8.4.2: the Go engine introspects MySQL, PostgreSQL and SQLite into a dbspec document with a constant number of catalog queries and reports unsupported objects; `make dbspec-introspect-check` runs the round trips and the unsupported cases.

- T8.4.1: docs/spec/dialects.md specifies how MySQL, PostgreSQL and SQLite are introspected into one dbspec document and which objects are reported as unsupported; tests/dbspec/introspect.json holds the unsupported cases.

- T13: `make git-check` checks commit subjects against AGENTS.md: `type(scope): Subject (#id)`, types feat, fix, docs, style, refactor, test and chore, a capitalized subject of at most 50 characters without a final period; merge commits keep the subject git writes.

- T8.2.6.1.1: the Korean manifest heading has the anchor `manifest-and-hashes`, which its links use; the decomposed Hangul id reached no link.

- T8.1.8: `audit` no longer requires `soft_delete`. A schema setting is read back from the database and a manifest setting is not, so the requirement made every introspected audited table invalid; the `BEFORE DELETE` trigger still makes a physical delete fail.

Keep only the dbspec check predicate forms that MySQL and PostgreSQL
catalogs give back: remove `not`, `between` and a column alone, and
write only the parentheses that an `or` inside an `and` needs, in every
client (T8.1.7).

Rewrite the bench schema and the shared schema fixtures as dbspec
documents with every name convention declared as a setting, and apply
each rendered document to MySQL, PostgreSQL and SQLite in `make
dbspec-ddl-check` (T8.2.6.3.2).

Specify the runtime model and generated code that clients build from a
dbspec document set, and map every Mermaid manifest field to it
(T8.2.6.3.1).

Reserve `and`, `or`, `not`, `in`, `between` and `is` as dbspec names in
every client, so a check predicate never reads a column named like a
keyword (T8.1.6).

Declare `Dbspec.render` in contracts/interfaces.json and compare the
rendered statements of the four clients in `make dbspec-compare-check`
(T8.3.6).

Reject a dbspec document set with a repeated document name or a missing
used document in the manifest and the renderer of every client, which
now returns statements or diagnostics (T8.2.6.2.1).

Render dbspec document sets to MySQL, PostgreSQL and SQLite statements
in the Rust client (`dbspec::render`), compared with tests/dbspec/ddl.json
(T8.3.5).

Render dbspec document sets to MySQL, PostgreSQL and SQLite statements
in the TypeScript client (`renderDbspec`), compared with
tests/dbspec/ddl.json, and export `renderDbspec` and `dbspecManifest`
from the package root (T8.3.4).

Render dbspec document sets to MySQL, PostgreSQL and SQLite statements
in the PHP client (`Dbspec::render`), compared with tests/dbspec/ddl.json
(T8.3.3).

Reject a dbspec table or column whose renderer-generated CHECK or
trigger name would exceed 63 bytes, in every client (T8.1.5).

Render dbspec document sets to MySQL, PostgreSQL and SQLite statements
in the Go engine (`dbspec.Render`), compared with tests/dbspec/ddl.json
(T8.3.2).

Specify the statements that dbspec renders for MySQL, PostgreSQL and
SQLite in docs/spec/dialects.md, and add tests/dbspec/ddl.json with `make
dbspec-ddl-check`, which applies every vector to the three databases and
runs its behavior steps (T8.3.1).

Type dbspec check predicates in every client: arithmetic, functions,
the `null` literal and `bytes` columns are rejected, a literal must be a
default of the column it meets and is written in that default form, and
two columns compare only when their types meet (T8.1.4).

Add `make go-fmt-check` to `make check`, format the six Go files that
gofmt would change, and format the Rust workspace so `make
rust-fmt-check` passes again (T11).

Compute the manifest text, schema text, `manifestHash` and `schemaHash`
of a dbspec document set in the Go, PHP, TypeScript and Rust clients
(`ManifestOf`, `Dbspec::manifest`, `dbspecManifest`, `manifest`), and
compare them in `make dbspec-compare-check` (T8.2.6.2).

Define the dbspec manifest text, schema text, `manifestHash` and
`schemaHash`, and make the document set the only schema source with no
separate manifest file; three shared cases lock the texts and hashes
(T8.2.6.1).

Add `make dbspec-compare-check`, which runs the Go, PHP, TypeScript and
Rust dbspec clients twice each on the shared cases and the stress
document and fails on any difference in emission or diagnostics
(T8.2.5). `make check` now runs every dbspec target.

Point a dbspec `header` error at the first character that departs from
`dbspec 1 <name>` in every client, and reject double spaces in the
TypeScript header (T8.1.3). Seven shared cases lock the positions.

Implement dbspec parse, validation and canonical emit in the Rust client
(T8.2.1): parse and emit pass all 50 shared cases, and the 2000-table
stress document parses with a 29-31 ms median in release mode. The Rust
symbol snapshot now matches the code, so interface-check passes for all
four languages.

Judge each client's dbspec parse budget on the median of five parses of
the stress document, so a parse slowed by other load on the machine no
longer fails the check while a slow parser still does (T8.2.4.2).

Sort repeated `blind_index` settings by AES column, and let a failed key,
index or tab-broken line keep its kind so that it hides the rules that
depend on its columns (T8.1.2). Six shared cases lock these rules, and
the PHP and TypeScript parsers follow them.

Implement dbspec parse, validation and canonical emit in the Go engine
(T8.2.2): Parse and Emit pass all 44 shared cases, and the 2000-table
stress document parses in 48-53 ms.

Implement dbspec parse, validation and canonical emit in the PHP client
(T8.2.3): Orm\Dbspec\Dbspec::parse and ::emit pass all 44 shared cases,
and the 2000-table stress document parses in 218-308 ms within 128 MiB.

State the dbspec parse budgets of every client in docs/spec/dbspec.md and fail
the Go, TypeScript and PHP stress tests above them (T8.2.4.1). Record
every native Go, PHP and TypeScript symbol in contracts/symbols so
interface-check passes for those languages.

Implement dbspec parse, validation and canonical emit in the TypeScript
client (T8.2.4) with the declared interface: parseDbspec, emitDbspec and
DbspecDiagnostic. All 44 shared cases and 45 focused cases pass, and the
2000-table stress document parses in 105-156 ms and emits unchanged.
Record its 279 symbols in contracts/symbols/typescript.json.

Specify dbspec, the neutral schema language that replaces the Mermaid
schema source (T8.1). docs/spec/dbspec.md and its Korean pair define documents
joined by name through a declared document set, the thirteen neutral types,
keys, indexes, foreign keys, the neutral check expressions, settings with
their schemaHash or manifestHash membership, audit through an operation
column and a history table copied by row triggers, diagrams, the canonical
form, limits and sixteen located diagnostic rules, and decide the fate of
every Mermaid feature. docs/spec/dialects.md records the audit decision. Shared
vectors in tests/dbspec/cases.json hold 4 canonical, 2 normalization and 17
invalid cases. No client implements dbspec yet.

Record the schema facts of MySQL, PostgreSQL and SQLite and decide neutral
support per feature (T8.0, T8.0.12). Add 239 shared probes in
tests/dialects and the dialect-facts-check target; each probe runs in its
own disposable database, schema or file with its own deadline, and a SQLite
file-name case shows that PDO, node:sqlite and the sqlite3 shell keep a DSN
query in the file name. Two runs pass with no failure on MySQL 8.4.11,
PostgreSQL 17.11 and SQLite 3.53.4. docs/spec/dialects.md records syntax,
meaning, probes, the neutral rendering or unsupported reason and the
catalog source per feature, the decisions for a local datetime with a
UTC connection rule and executor update-time stamping, and leaves the audit
context definition for T8.1 review. Thirteen defects of the current schema
tools and clients are recorded as T8.0.1-T8.0.11, T8.0.13 and T8.0.14.

Require no PDO driver extension in the PHP client (N17). `composer.json`
required `ext-pdo_mysql`, so `composer install` refused a PHP without it,
such as the official PHP image, although the client references the MySQL
driver only for a `mysql://` DSN. It now suggests `pdo_mysql`, `pdo_pgsql`
and `pdo_sqlite` and requires none of them, and
`make php-without-mysql-check` runs the client on SQLite in the official
PHP image.

Provide a test fault that makes the rollback of a transaction fail on
every database (N16). orm had no
supported way to make a rollback fail: the ORM tests end the server
session on MySQL and PostgreSQL or install a SQLite trigger written in
SQL. The test entry point of each client now arms a rollback fault on a
connection: Go `orm.FailNextRollback(db)` with the build tag `ormtest`,
Rust `orm::testing::fail_next_rollback(&db)` with the feature
`test-faults`, TypeScript `failNextRollback(db)` of
`@polyspec/orm-typescript/testing` under the Node condition `orm-test`,
and PHP `Orm\Testing\Faults::failNextRollback($db)` from
`testing/Faults.php`, which the package autoloader does not load. No
DSN, configuration value or environment variable arms the fault. The
next rollback of a transaction whose callback failed runs and is then
reported with the new catalog code `FAULT`, so the transaction returns
`ROLLBACK` with the callback error and the `FAULT` error. The case
`rollback_fault` passes in Go, PHP, Rust and TypeScript on MySQL,
PostgreSQL and SQLite.

Store the times of the migration ledger with microseconds on every
database (N15). The ledger `orm_schema_migrations` declared `timestamp`
on MySQL and `TEXT` written with `CURRENT_TIMESTAMP` on SQLite, so its
`started_at` and `finished_at` kept whole seconds there, while
PostgreSQL kept microseconds. The schema tools of Go, PHP, Rust and
TypeScript now create `timestamp(6)` columns written with
`CURRENT_TIMESTAMP(6)` on MySQL, and on SQLite `TEXT` columns with a
`CHECK` for six fraction digits that take the tool clock in UTC. Before
a command uses an existing ledger, the tool verifies its time columns;
a ledger with whole-second columns fails with
`MIGRATION_HISTORY_PRECISION` and stays unchanged. `docs/operations/usage.md`
states the statements that convert a MySQL or SQLite ledger created
before this change. The cases `migration_ledger_microseconds`,
`migration_ledger_whole_seconds` and `migration_ledger_earlier` pass in
Go, PHP, Rust and TypeScript on MySQL, PostgreSQL and SQLite.

Write the database clock with microseconds on MySQL and keep the
fraction of the client clock in SQLite relative value functions (N14).
The MySQL dialect rendered soft deletion as `CURRENT_TIMESTAMP` and the
`now` value function and its relative forms with `NOW()`, so a soft
deletion stored whole seconds in a `datetime(6)` column and
`created_ts <= now()` missed a row created earlier in the same second.
The SQLite relative forms rendered `datetime(clock, modifier)`, which
drops the fraction of the bound clock. Soft deletion now assigns the
clock with the declared fraction digits of its column, as the update
time does: `CURRENT_TIMESTAMP(p)` on MySQL. The MySQL value functions
use `NOW(6)`, and the SQLite relative forms append the six fraction
digits of the clock to the `datetime` result. The cases
`clock_soft_delete_microseconds` and `clock_now_condition` pass in Go,
PHP, Rust and TypeScript on MySQL, PostgreSQL and SQLite.

Report both errors when a transaction or savepoint callback fails and its
rollback fails too (N13). The PHP client replaced the callback error with
the rollback error, the TypeScript client dropped the rollback error, the
Go client discarded the transaction rollback error, and the Rust client
reported both only as `CONFIG` text. Each client now returns one error
with the catalog code `ROLLBACK` that names both errors and keeps them. A
checked-out TypeScript PostgreSQL connection now keeps a connection error
that the server reports between statements instead of ending the process
with an unhandled error event. The ORM tests end a transaction on SQLite
with a fixture trigger that raises `ROLLBACK` while the callback runs only
model calls, and on MySQL and PostgreSQL by ending the server session from
a test connection. In Go, a cancelled statement inside a transaction on
MySQL or PostgreSQL closes its connection, so the transaction reports
`ROLLBACK`, which keeps the cancellation.

Provide `utils().schema().register(manifestJson)` in the four clients
(N3.3). Registering a schema whose tables already exist required
constructing the engine and calling the internal `registerEngine`. Register
verifies the manifest hash against its content and returns `CONFIG` when
they differ, runs no statement, and adds the engine to the connection as
`install` does; `install` uses the same registration. The Rust client
verifies the manifest only, because its connections do not yet keep their
schemas (N3.2). `contracts/interfaces.json` records the operation and the
current symbol snapshot hashes.

Type only the method calls of model chains in the TypeScript generator
scan (N12). The scan collected the name of every method call of a source
file and declared it on every model whose schema accepted it, so a call
such as `this.enabled()` of a class that is not a model added a model method and
removing the call removed it. The scan now resolves each receiver from
the source: `new` of a generated class, bindings, typed parameters,
functions that return a model, model chains, model callbacks, and rows
and collections of models. It declares a method only on the model its
receiver resolves to. The usage guide states the rule.

Report every driver error as an ORM error with a catalog code (N11). The
PHP client returned a driver error that the catalog does not list, such as
a write that an `orm:audit` or `orm:immutable` trigger refuses, as a raw
`PDOException`; the Go client returned it unchanged, and the Rust client
reported the code `SQLX`. The catalog now holds `DRIVER` for every such
error, and each client keeps the driver message and the driver error as
the cause: PHP `OrmException::fromDriver` always returns an
`OrmException`, Go `orm.Error` unwraps to the driver error, and Rust
reports `Error::Driver { code, msg, source }`. SQLite 1811 is a trigger
refusal, not `FOREIGN_KEY`, and PHP, Rust and TypeScript map a CHECK
violation to `CONSTRAINT`. The `trigger_refused` and `check_refused`
cases pass in Go, PHP, Rust and TypeScript on MySQL, PostgreSQL and
SQLite.

Write the client clock with microseconds in every client (N10). The
TypeScript client read its clock from `Date`, so the SQLite `now` bind
slot stored `.mmm000`. It now adds the microseconds of the monotonic
clock, anchored to the wall clock, and moves the anchor when the two
clocks differ by more than one millisecond. The protocol states the rule
of the `now` slot for all clients. The `clock_microseconds` case passes
in Go, PHP, Rust and TypeScript on MySQL, PostgreSQL and SQLite.

Load the generated PHP models of several schemas in one process (N3.1).
Each generated model class carries its schema hash, and a connection keeps
one engine per registered schema: the schema it opened with and every
manifest installed through `utils()->schema()->install()`. Install verifies
the manifest hash against its content before any statement runs, and a
request of a schema the connection has not registered fails with
`SCHEMA_HASH_MISMATCH`. Owner cases in Go, PHP, Rust and TypeScript use two
schemas on one connection on MySQL, PostgreSQL and SQLite.

Verify physical document input bounds through all four parsers
(T7.17.2.10.3.4). Keep 64 MiB, 200000 lines and 4096 blocks unchanged;
execute each upper bound and excess twice per owner with exact retention
and safe resource diagnostics. The PHP upper-bound Red exhausts 128M
because eager prose slices duplicate the input. Retain source and ranges
through copy-on-write instead; remove eager prefix/suffix fields and expose
explicit slice methods. Peak allocation is 71319552 bytes, not RSS.
Related PHP complete-record/diagnostic and connected document round trips
pass twice, with scoped lint/compilation and paired records. This proves
input parsing/retention, not two complete edited copies under 128M.
Ownership, remaining grammar/output acceptance and import activation remain.

Read physical metadata and its ERD projection together in four owners
(T7.17.2.10.3.3). Preserve complete graph records and surrounding Markdown;
reject display contradictions and malformed metadata with safe line/path
diagnostics. Use reversible U+241B display escapes after actual Mermaid
rejects the first backslash-based draft. Keep multiplicity explicitly
unverified rather than treating view notation as SQL proof.
Owning tests run twice, including seven shared rejection vectors and the
connected 2000-table/60000-column/10000-FK document round trip. Chromium
renders hostile labels and parallel FKs twice. PHP peak allocation is
117030912 bytes with unchanged 128M, not RSS. Scoped lint/compilation and
paired records pass. Authoritative ownership, full grammar/resource
acceptance and native/platform proof remain pending.

State the scope of the physical source scanner (T7.17.2.10.3.2).
docs/spec/schema.md (+ko) states that the scanner does not classify arbitrary
HTML tags or full Markdown containers, and that the document reader
establishes its own source ownership and validates graph metadata with
the diagram before imports are enabled. Paired records and diff checks
pass; runtime code is unchanged.

Shield named block HTML until a blank line or EOF (T7.17.2.10.3.1.2).
Keep source opaque after a closing tag; nested HTML and fence markers do
not alter its ending rule. Match only bounded ASCII block-tag names and
their declared delimiters; retain explicit raw-element ending behavior.
Old named-tag failures are Green in four clients. The owning command runs
124 opening/closing tag cases, 23 additional cases and a 100000-line block
case twice per owner, with related HTML/source/resource regressions.
Scoped lint, compilation, paired records and diff checks pass on macOS
arm64. Paragraph-sensitive tags, general containers and joint graph/diagram
parsing remain unfinished; no import capability is claimed.

Shield explicit HTML blocks during physical source scanning
(T7.17.2.10.3.1.1). Ignore schema-shaped fences in comments, raw elements,
processing instructions, declarations and CDATA; resume after the closing
line and reject unfinished blocks with safe opening-line diagnostics.
Keep HTML-shaped content inside code fences unchanged. Locate each HTML
terminator once instead of searching the remaining source on every line.
Four reproduced comment Reds are Green. The owning command passes 29 new
shared cases, two 100000-line stress cases and related source/limit/encoding
regressions twice per client. Scoped lint, compilation, paired records and
diff checks pass. Blank-line HTML, general containers, joint graph/diagram
parsing, imports and native/platform evidence are still unfinished.

Locate physical Markdown source blocks in four clients (T7.17.2.10.2).
Return UTF-8 byte ranges without retaining body/line copies. Keep foreign
fenced examples opaque; reject unknown/duplicate/unfinished blocks and
encoding/byte/line/block excess with a single value-free line diagnostic.
Missing scanner APIs and the reproduced list-example mistake are Green.
`make physical-envelope-check` passes 21 shared cases, six limit/next-value
cases and native encoding checks twice per owner. PHP peak allocation is
71319552 bytes under its unchanged 128M limit, not RSS. Owner lint/compile,
paired-document and diff checks pass on macOS arm64. HTML interpretation,
joint graph/diagram validation and imports remain pending.

Distinguish Rust Result transformations after fallible model setters
(N2.1.1). Preserve model access after error mapping and checked extraction,
and distinguish transformed success values from the original model.
Reject unknown model calls and Result methods on infallible setters.
Fourteen generation cases, one generated-model case, the strict Clippy
checks of both parts and paired documentation checks pass.

Document physical Markdown projection requirements (T7.17.2.10.1).
Separate exact JSON metadata from restricted diagram labels and unverified
crow-foot multiplicity. Require stable IDs, joint contradiction checks,
ordinary Markdown preservation, bounded source handling and full-field
four-client roundtrips before enabling this input. The existing logical
parser is not an authoritative physical document parser. Paired records
and writing checks pass; no grammar or rendering implementation is claimed.


Read and emit strict physical graph JSON in four clients (T7.17.2.9).
Reject decoded duplicate members, malformed syntax/Unicode, rounding and
byte/depth/node excess before information can disappear. Reuse physical
graph validation; preserve every field and ordered list through repeated
text roundtrips. Missing APIs in Go, PHP, Rust and TypeScript are Green.
The reusable physical-json-check passes 30 shared cases, six number forms,
six decoder limit/next-value cases, full-record/encoding checks and related
graph/record regressions twice per client. Two added output-size cases also
pass twice in all four clients. Each owner retains the connected 2000-table,
60000-column, 10000-FK graph and 2000 each of indices, keys and CHECKs
through a stable 14123977-byte emission/parsing/emission result.
Correct reproduced PHP exhaustion with direct tree construction and bounded
FIFO sharing (T7.17.2.9.1), not a higher memory limit or reduced fixture.
The same stress case peaks at 93290496 allocated bytes (89 MiB) under 128M;
this is not RSS. Controlled 256M diagnostic runs are not acceptance proof.
Correct the TypeScript ES2022 Unicode method compile error using direct
code-point validation (T7.17.2.9.2), without suppressions or alternatives.
Correct new prohibited documentation terms without weakening the writing
checker or technical criteria (T7.17.2.9.3).
Go vet, Rust 1.98.1 strict owner Clippy/scoped formatting, Node 26.10.0
TypeScript compilation, PHP syntax and paired documentation checks pass
on macOS arm64. Markdown, imports, DDL, execution and native
or other-platform acceptance remain unfinished requirements.


Resolve physical index, key and CHECK records in graphs (T7.17.2.8).
Require all three arrays; reject the obsolete root shape without fallback.
Validate global IDs, table/column ownership, shared constraint names,
single primary keys and ordered backing-index links with located errors.
Preserve exact records and count their text against the graph byte budget.
Four reproduced old-shape Reds are Green. physical-graph-check executes
45 new shared cases and the existing 28 graph/five limit cases twice per
client, plus related record regressions and detached/sparse checks.
Go, PHP, Rust and TypeScript retain 2000 tables, 60000 columns, 10000 FKs
and 2000 each of indices, keys and CHECKs under existing deadlines.
PHP peaks at 72 MiB allocated under the unchanged 128M limit, not RSS.
Rust 1.98.1 strict owner Clippy/scoped formatting, Go vet, Node 26.10.0
TypeScript compilation, PHP syntax and paired documentation checks pass
on macOS arm64. SQL parsing, physical import, DDL, execution and native
platform acceptance remain unfinished requirements.


Preserve physical primary/unique key records in four clients (T7.17.2.7).
Keep constraint names, ordered column IDs, independent backing-index IDs,
deferral, unique null treatment and temporal overlap metadata. Reject
unknown shapes, duplicates, contradictory deferral, primary-only null
option misuse and byte/count excess without exposing input values.
Missing APIs are Red-to-Green in Go, PHP, Rust and TypeScript.
physical-key-check executes 35 shared vectors and 14 shared limit cases
twice per client, plus encoding/alias/sparse checks and related column,
CHECK, index and FK regressions. Rust 1.98.1 strict owner Clippy/scoped
formatting, Node 26.10.0 TypeScript compilation, PHP syntax and paired
documentation checks pass on macOS arm64. Temporal metadata preservation
does not prove dialect/range-type or backing-index compatibility. Graph
resolution, physical import, DDL, execution, DB conformance and native
platform acceptance remain separate requirements.


Preserve immutable physical index records in four clients (T7.17.2.6).
Retain ordered column/expression terms, repeated columns, prefixes, sort
and null ordering, raw collation/operator-class text, included columns,
partial predicates, uniqueness, visibility, comments and ordered options.
Keep unspecified values distinct; do not coerce SQL or merge indices with
primary/unique constraints. Reject malformed shapes, encodings and bounds
without exposing input values. Four missing-API Reds are Green.
physical-index-check executes 46 shared vectors and 20 shared limit cases
twice per client, plus alias/sparse/encoding/native-number checks and the
existing CHECK/column regressions. Rust 1.98.1 strict owning Clippy and
scoped formatting, Node 26.10.0 TypeScript compilation, PHP syntax and
paired-record checks pass on macOS arm64. This is structural interchange,
not graph attachment, SQL parsing, imports, DDL, execution, DB conformance
or native platform acceptance.


Preserve immutable physical CHECK records in all four clients (T7.17.2.5).
Keep exact names, raw expressions, independent nullable enforcement and
validation states, comments and ordered options. Reject malformed records
and size/encoding excess with value-free errors; detach caller-owned values.
Missing APIs are Red-to-Green in Go, PHP, Rust and TypeScript. The reusable
physical-check-check passes 24 shared vectors and 17 shared limit cases
twice per client, plus encoding/alias cases and 25 column regressions.
Rust 1.98.1 strict owner Clippy and scoped formatting, Node 26.10.0
TypeScript compilation, PHP syntax and paired documentation checks pass
on macOS arm64. Correct new prohibited documentation terms and the
unsupported hyphenated sub-item ID (T7.17.2.5.1) without weakening checks.
This is structural interchange, not graph attachment, SQL validation,
physical import, DDL, DB conformance or execution.


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

### MySQL CHECK constraint namespace

Keep persistent development rules in `AGENTS.md` and concrete work in the project checklist. The checklist checker now rejects unnumbered policy and status prose, so dated progress claims cannot replace item states and executable evidence. The waiting generated-interface check must verify the `multi_statement` exclusion in each public client API.

Add the connection options `poolIdleSize`, the maximum idle connections of the pool, and `poolLifetimeMs`, the lifetime of a pool connection in milliseconds, to the Go (`PoolIdleSize`, `PoolLifetimeMs`), TypeScript (`poolIdleSize`, `poolLifetimeMs`) and Rust (`pool_idle_size`, `pool_lifetime_ms`) clients. A connection released while the pool already keeps `poolIdleSize` idle connections is closed, and a connection whose lifetime has passed is closed while it is idle or when it is released. Zero or unset keeps the previous behavior: up to the pool size of idle connections, no lifetime in Go and TypeScript, and the 30-minute pool lifetime in Rust. A negative value or an idle size above the pool size returns `CONFIG`. The PHP client has no pool and returns `CONFIG` when either option is not zero.

Add the error code `READ_ONLY` for a write that a read-only server or connection rejects: PostgreSQL SQLSTATE 25006, MySQL errors 1290 and 1792, and SQLite `SQLITE_READONLY` (8) with its extended codes. The Go, PHP, Rust and TypeScript clients return `READ_ONLY` with the driver message instead of the unmapped driver error. The database tests check the code for a write through the PostgreSQL standby and the MySQL read-only replica and for a write to a SQLite database file that the process may only read.

Make a pool size of zero or unset open at most 10 connections in the Go, TypeScript and Rust clients. The Go client opened an unlimited number of connections, TypeScript `{ poolSize: 0 }` opened an unlimited number on MySQL, and Rust `Db::connect(dsn, 0, config)` panicked. Tests run six concurrent transactions on a pool of two and check that at most two run and at most two connections are open.

Document in `docs/spec/config.md` how a primary and its replicas are used: one connection per server, selected per model or row with `connect`; the ORM does not route statements, and SQLite is single-node only. The database tests of the four clients open a primary and a replica connection side by side on MySQL and PostgreSQL and check that a replica reads committed rows, rejects a write, and is not used by a model connected to the primary or by a model inside a transaction of the primary.

Make the four clients work through PgBouncer in transaction mode. The PHP and Rust clients send the PostgreSQL `statement_timeout` of `statementTimeoutMs` as a startup parameter, as Go and TypeScript do, instead of `SET SESSION statement_timeout`, which stayed on the pooled server connection and bounded the statements of other client connections. The Rust client no longer sends the startup parameter `extra_float_digits`, which PgBouncer rejected; float8 values stay exact. The TypeScript client cancels a PostgreSQL statement with the protocol cancel request (process id and secret key) instead of `pg_cancel_backend`, whose process id is not a server process behind a pooler. `make client-pooler-check`, part of `make check`, runs the client database tests through PgBouncer and ProxySQL, and `docs/spec/config.md` lists the pooler settings and states that the schema tools connect to the primary directly.

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

- Replace the initial design, revised design, and DSL v3 notes with one design plan (`docs/spec/plan.md`). The plan defines the model syntax for Go, PHP, Rust, and TypeScript, its rules, and the work order.

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

- Initial development version.
- Added the shared IR, compiler, generated clients, database executors, migrations, authenticated versioned encryption, relations, batches, keyset pagination, and conformance checks.
- Added transaction-scoped PostgreSQL advisory locks to the Go ORM.
- Added ordered DDL installation through the Go ORM transaction boundary.
- Verify SQLite duplicate-key and foreign-key errors are mapped to the adapter-neutral ORM error contract.
- Add SQLite support to the adapter-neutral `SchemaInstalled` transaction operation for namespaced physical table names.
- Add adapter-neutral database-emptiness inspection for safe initial-schema preflight on PostgreSQL and SQLite.
- Exclude PostgreSQL system namespaces such as `pg_toast` from empty-database preflight detection.
- T59: dbspec gains the state_machine setting: `state_machine <column> <from> -> <to> [require (<column>, ...)]` and `state_machine <column> terminal <state> [require (<column>, ...)]` on one non-null varchar or text column per table, in any mix and order. The validator checks the column, the require columns, one machine per table and no transition that leaves a terminal state; the emitter writes the canonical lines, and the settings model carries the machine. The database does not enforce the machine; the executor that owns the rows does.
- T60: dbspec gains the markdown setting: `markdown <column>` marks a varchar or text column of any nullability as markdown prose, repeatable per column. The validator checks the column kind, the emitter writes the canonical line, and the settings model carries the trait; the database renders nothing for it.
