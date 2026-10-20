<!-- doc-id: changelog -->
# Changelog

## Unreleased
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
- The shared decode vectors compare JSON values in every client, and the accepted YAML keys 1, "true", tRUE, nULL and .InF are shared vectors. PHP skips the three mixed-case keys for the purrphp defect of T142-1-1. (#T142-11)
- The conformance vector creates_and_save records the insert parts of T169. (#T169-1)
- Multi-row inserts run as power-of-two parts capped by the bind limit (999 on SQLite, 65535 on MySQL and PostgreSQL) inside the transaction, so the PHP plan cache holds a bounded number of insert shapes in every client. (#T169)
- TypeScript types a plain YAML map key by the yaml library's own core-schema tags instead of a case-insensitive regex, so tRUE, nULL and .InF stay string keys. (#T142-10)
- Every client refuses a YAML anchor with or without an alias, every explicit tag including the core tags, and a text with no document, as docs/spec/codec.md now states. (#T142-9)
- Go reads YAML with goccy/go-yaml and Python with rapidyaml, both keeping U+0085 as content; Python writes with ruamel.yaml, and PyYAML is removed. The next_line exclusions are gone. (#T142-2)
- The PHP client reads YAML with purrphp/yaml and its core schema, so 1_000, dates and timestamps stay strings as in every other client. orm refuses documents, aliases, anchors, tags, merge keys and duplicate keys on its node model. Two vectors stay excluded for purrphp defects, tracked by T142-1-1. (#T142-1)
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
