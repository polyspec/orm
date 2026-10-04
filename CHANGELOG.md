# Changelog

## 0.0.2

- G5.29-8: the tsc, go generate, go vet and cargo build steps of the feature verification commands run under `tests/run-case.mjs` with their deadlines, and `make repo-check` fails a verification command that runs such a tool outside it.

- G5.29-7: the PHP and TypeScript decimal database tests report each case with its deadline and elapsed time, and `make repo-check` fails a PHP or TypeScript test that a check runs without the shared case report.

- G5.29-5: the MySQL TLS tests of Go, PHP, Rust and TypeScript report each case with its deadline and elapsed time, the Go connection test reads through the case context, and `make repo-check` fails a Go or Rust test that starts no case of the shared testcase package.

- G5.29-6: the version check test reports each case with its deadline and elapsed time, and `make repo-check` fails a JavaScript test that declares its tests with `node:test` directly instead of `caseTest`.

- G5.29-4: AGENTS.md states that a long operation gets detailed step logs in addition to its own timeout, instead of in place of one.

- G5.27: `make owner-check` runs only the changed features' verification and coverage and the make targets that `contracts/check-inputs.json` declares with scope `owner`; whole-suite targets have scope `suite` and run only in `make check`, and a target without a scope fails the selection. `scripts/features/coverage.mjs --feature <id>` fails on an unknown id with the list of valid ids, and the feature unit tests run in the new `make feature-unit-check`.

- G5.28: a Rust transaction with `timeout_ms` fails with `CAPABILITY_UNSUPPORTED` on MySQL and SQLite, as in Go, PHP and TypeScript, instead of running its callback under a client timer that did not stop the statement on the server; on PostgreSQL the option is the server's `statement_timeout` alone.

- T42: every client publishes an event for each statement it sends to the subscribers of the connection, with its text, masked binds, kind, tables, elapsed time, transaction number and error, in place of the `OnQuery` hook; plan steps name their tables, and every client sends the same transaction control statements.

- G5.26: a documentation page shows `{{` in text and code as written instead of running it as a Vue interpolation, and `make docs-build` fails when the server render of a page fails; the checklist page, which rendered empty, shows G5.5 again.

- D4: the documentation site at https://polyspec.github.io/orm/ is the build of the current commit, deployed by the `docs-pages` workflow.

- G5.25: the conformance check restores a PostgreSQL sequence by the table that owns it in `pg_depend`, so a table whose sequence name PostgreSQL truncates is restored too.

- G5: the GitHub Actions build passes: `make check` runs every target on `ubuntu-26.04-arm` against servers that `make test-servers` starts, and the docs site deploys.

- G5.6: the PHP check without MySQL runs `php -n` with the extensions the client uses on SQLite, and passes on the Linux runner.

- G5.24: `make test-servers` keeps the first report of a starting server when a signal interrupts the wait for it, so an exit is no longer reported as a missed deadline and the wait no longer hangs.

- T41.1: the make targets that `make owner-check` selects run with the server environment, the decimal environment and the Rust target directory that owner-check receives, so a check in a worktree uses the servers and the target directory of the main checkout.

- G5.22: every check runs the programs that cargo builds from the declared `CARGO_TARGET_DIR` and fails when it is unset, instead of naming `clients/rust/target`; `make repo-check` rejects a run command that names that directory.

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

- T8.8.1: main is merged into the dbspec branch, and its features work on the dbspec paths while the Mermaid source path stays removed. One process loads the generated code of several document sets and a connection plans every request with the model of its manifest hash; a request of a manifest that no loaded code registered, or code whose text does not hash to its declared hash, fails with `SCHEMA_HASH_MISMATCH`, and generated code registers its set, so no `utils().schema().register()` exists. A transaction or savepoint whose rollback fails too, also on a connection the server closed, reports one `ROLLBACK` error `transaction failed (<cause>) and rollback failed (<error>)` in every client, keeps both errors and is not retried. `docs/protocol.md` states one clock rule: the client clock is UTC with microseconds, MySQL writes `CURRENT_TIMESTAMP(p)` and `NOW(6)`, SQLite relative forms keep six fraction digits, SQLite binds the client clock for an omitted `default now` column, and every `now` slot carries the fraction digits of its column. The plan history writes `applied_at` as `YYYY-MM-DDTHH:MM:SS.ffffffZ`, and the TypeScript apply clock is microseconds since the epoch.

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

- T8.6.2.2: Go, TypeScript and Rust assert the apply cleanup errors like PHP; TypeScript and Rust reject a PostgreSQL unlock that released nothing, Go returns a failure without cleanup errors unchanged, and docs/plans.md states how each client reports a failure with cleanup errors.

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

- T8.7.1: docs/mermaid.md specifies standard Mermaid export and import with the list of what each leaves out.

- T17: the Rust client benchmark `client_bench` fails and names `ORM_BENCH_MYSQL_DSN` when the variable is unset or empty instead of connecting to a built-in local socket.

- T12: `make ts-model-check` fails when the TypeScript models script scans a source that does not call models or misses one that does, or when the committed models.ts differs from its output; the script scans only the 8 sources that call models.

- T8.5.2.2: plan names over 63 bytes are rejected, and shared cases cover plan parse errors.

- T8.5.5: the Rust client parses, chains, diffs and writes schema plans for MySQL, PostgreSQL and SQLite; `make dbspec-plan-rust-check` applies them.

- T8.5.4: the TypeScript client parses, chains, diffs and writes schema plans for MySQL, PostgreSQL and SQLite; `make dbspec-plan-ts-check` applies them.

- T8.6.2: the Go engine applies plan chains with a lock, history, drift checks, transactions, verification, events and MySQL recovery.

- T8.6.1: docs/plans.md specifies how plans are applied: lock, history, drift, verification, events and MySQL recovery.

- T8.5.2.1: the Go plan writer keeps no dropped result and no unused renderer state.

- T8.5.2: the Go engine parses, chains, diffs and writes schema plans for MySQL, PostgreSQL and SQLite; `make dbspec-plan-check` applies them.

- T8.5.1: docs/plans.md specifies schema plans: the plan document, the chain from an empty database, the diff and the statements of each dialect, with shared cases.

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

- T8.4.1: docs/dialects.md specifies how MySQL, PostgreSQL and SQLite are introspected into one dbspec document and which objects are reported as unsupported; tests/dbspec/introspect.json holds the unsupported cases.

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
SQLite in docs/dialects.md, and add tests/dbspec/ddl.json with `make
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

State the dbspec parse budgets of every client in docs/dbspec.md and fail
the Go, TypeScript and PHP stress tests above them (T8.2.4.1). Record
every native Go, PHP and TypeScript symbol in contracts/symbols so
interface-check passes for those languages.

Implement dbspec parse, validation and canonical emit in the TypeScript
client (T8.2.4) with the declared interface: parseDbspec, emitDbspec and
DbspecDiagnostic. All 44 shared cases and 45 focused cases pass, and the
2000-table stress document parses in 105-156 ms and emits unchanged.
Record its 279 symbols in contracts/symbols/typescript.json.

Specify dbspec, the neutral schema language that replaces the Mermaid
schema source (T8.1). docs/dbspec.md and its Korean pair define documents
joined by name through a declared document set, the thirteen neutral types,
keys, indexes, foreign keys, the neutral check expressions, settings with
their schemaHash or manifestHash membership, audit through an operation
column and a history table copied by row triggers, diagrams, the canonical
form, limits and sixteen located diagnostic rules, and decide the fate of
every Mermaid feature. docs/dialects.md records the audit decision. Shared
vectors in tests/dbspec/cases.json hold 4 canonical, 2 normalization and 17
invalid cases. No client implements dbspec yet.

Record the schema facts of MySQL, PostgreSQL and SQLite and decide neutral
support per feature (T8.0, T8.0.12). Add 239 shared probes in
tests/dialects and the dialect-facts-check target; each probe runs in its
own disposable database, schema or file with its own deadline, and a SQLite
file-name case shows that PDO, node:sqlite and the sqlite3 shell keep a DSN
query in the file name. Two runs pass with no failure on MySQL 8.4.11,
PostgreSQL 17.11 and SQLite 3.53.4. docs/dialects.md records syntax,
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
`MIGRATION_HISTORY_PRECISION` and stays unchanged. `docs/usage.md`
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
docs/schema.md (+ko) states that the scanner does not classify arbitrary
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
