<!-- doc-id: dialects -->
# SQL dialects

A SQL dialect is the SQL syntax and execution rule set for one database system. In this project, `mysql`, `postgres`, and `sqlite` select identifier quoting, placeholders, type mapping, write syntax, and supported SQL functions. The planner asks the selected SQL dialect for every database-specific part; the IR and plan format do not change.
Executors still see the same plan shape: steps, bind slots, assemble.

- **DIA-200** MariaDB is a server of the `mysql` dialect, not a dialect of its own: the DSN scheme selects the dialect,
  and the scheme `mysql://` ([config](config.md)) reaches a MariaDB server as it reaches MySQL. The dialect holds both
  servers to one result by these rules, applied in this order:
  1. The `mysql` dialect renders one SQL that both servers accept with the same result. Where a probe shows that a form
     of MySQL alone fails on MariaDB and a form exists that both accept with the same result, such as a collation that
     both have with the same comparison, the dialect renders that form on both servers.
  2. Only where no common form exists does the client read the identity and the version of the server once, when it
     connects, by `VERSION()` and never by the handshake, and render the form of that server. Each such point is a
     numbered rule of this document that names the probe that proves it; it is not a dialect of its own and not a copied
     recipe.
  3. A behaviour that MariaDB cannot hold at all is refused on MariaDB with a stated error code of
     [errors](errors.yaml), the same in every runtime, before any statement that would give another result; it is never a
     silent difference.
  4. A difference in an answer that is the server's own, such as the text of a server error or the name of an
     introspected type, is the result of the case on that server, which its recipe states as the `mariadb` expect of the
     case (FCV-3).

- **DIA-201** The server and its error numbers — MySQL 8.4 / MariaDB 11.8 (probes `mysql.env.server`,
  `mariadb.env.server`): a client of the `mysql` dialect reads the server once when it connects, by `SELECT VERSION()`;
  a version that contains `-MariaDB` is MariaDB and any other is MySQL, and every connection of a pool reads the server
  of its pool. The two servers give one number to different errors, so no common table exists (DIA-200, rule 2): 4025 is
  the CHECK fault of MariaDB (SQLSTATE 23000) and an `AUTOEXTEND_SIZE` out of range on MySQL (HY000), whose CHECK fault
  is 3819 (probes `mysql.check.number_4025_not_a_check`, `mariadb.check.number_4025_not_a_check`). A server error number
  is therefore read by the table of the server of its connection ([errors](errors.yaml)), the same in every runtime:
  MySQL maps 3819 to `CONSTRAINT` and leaves 4025 a `DRIVER` error, MariaDB maps 4025 to `CONSTRAINT` and 1969, its
  statement timeout, to `CANCELED`; 4031, the idle disconnect of MySQL, is `CONNECTION_LOST` on MySQL alone (statement
  runner case `a_server_error_number_is_read_by_the_table_of_its_server`). Its statements are one per dialect, since a
  CHECK fault and a refused table option are written differently on each database, and MariaDB runs those of `mysql`: its
  CHECK fault is 4025 and reads as `CONSTRAINT`, and it has no `AUTOEXTEND_SIZE` and refuses that statement with 1064, a
  `DRIVER` error, as MySQL gives `DRIVER` for its 4025, so one expect of the dialect holds both servers (DIA-200, rule 1).

- **DIA-202** The connection collation — MySQL 8.4 / MariaDB 11.8 (probes `mysql.collation.literal_collate`,
  `mariadb.collation.literal_collate`): every connection of the `mysql` dialect, the catalog connection among them,
  sends `SET NAMES utf8mb4` when it connects, in every runtime, and names no collation. The collation of the connection
  is then the default of the server for utf8mb4, `utf8mb4_0900_ai_ci` on MySQL and `utf8mb4_uca1400_ai_ci` on MariaDB
  (probes `mysql.collation.default_accent_case_insensitive`, `mariadb.collation.default_accent_case_insensitive`), and
  no statement depends on it: a text column that the renderer writes compares under its own `utf8mb4_0900_bin`
  (DIA-119, DIA-90), whose collation outranks that of a literal or a parameter, and SQL that compares text with no such
  column states `COLLATE utf8mb4_0900_bin`. Both servers have that one name (id 309; MariaDB 11.8 lists it beside its
  own `utf8mb4_nopad_bin`) and compare under it by code point with no padding, to the same result directly and through
  ProxySQL: `'a' = 'A'`, `'a' = 'a '` and `'a' = 'á'` are false and `'B' < 'a'` is true (DIA-200, rule 1). A connection
  that names the collation in `SET NAMES` is no common form: ProxySQL 3.0.9 has no collation above id 307 and refuses
  `SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin` with 1115, so the pooler lane could not connect. The statement runner
  case `a_text_literal_compares_by_code_point_under_the_collation_it_states` holds it on every database; PostgreSQL
  compares under `COLLATE "C"` and SQLite under `BINARY` to the same result. Its query is one per dialect, since
  `COLLATE utf8mb4_0900_bin`, `@@character_set_connection` and `@@character_set_results` belong to the `mysql` dialect,
  PostgreSQL gives a comparison as a boolean, cast to an integer, and reads its encoding by
  `current_setting('client_encoding')`, and SQLite by `pragma_encoding`; MariaDB runs the query of `mysql` with the
  result of MySQL (DIA-200, rule 1).

- **DIA-203** The server of the introspection — MySQL 8.4 / MariaDB 11.8 (probes `mysql.check.not_enforced_option`,
  `mariadb.check.not_enforced_option`, `mysql.check.name_schema_scope`, `mariadb.check.name_schema_scope`,
  `mysql.check.catalog_text`, `mariadb.check.catalog_text`, `mariadb.check.string_escaped_twice`): the introspection of
  dbspec, and the verification of an apply that introspects, take the server that the connection read when it
  connected (DIA-201) next to the dialect, in every runtime, and read no version of their own; a server that is not a
  server of the dialect is refused as an unknown dialect is (DBS-174). MySQL states a CHECK that is not enforced in
  `TABLE_CONSTRAINTS.ENFORCED`; MariaDB has no `NOT ENFORCED` CHECK and no `ENFORCED` column (1054), so no common query
  exists (DIA-200, rule 2) and every CHECK of MariaDB is read as enforced. MariaDB scopes a CHECK name to its table, so
  its `CHECK_CLAUSE` is read by table and name, and it writes `CHECK_CLAUSE` as SQL text without outer parentheses and
  introducers whose string literals carry one escape; that text takes the second escape of MySQL's `CHECK_CLAUSE`, and
  then one reader reads the clause of either server (DIA-146). Its renderer CHECKs are `` `c` in (0,1) ``,
  `` octet_length(`c`) = 16 ``, as MariaDB writes the `length` of the renderer, and
  `` `c` >= '00:00:00' and `c` < '24:00:00' `` (probes `mariadb.render.bool_check`,
  `mariadb.render.uuid_bytes`, `mariadb.render.time_of_day_check`; DIA-144).

- **DIA-204** The integer display width — MySQL 8.4 / MariaDB 11.8 (probes `mysql.int.display_width_dropped`,
  `mariadb.int.display_width_dropped`): MySQL writes `COLUMN_TYPE` of `smallint`, `int` and `bigint` without a display
  width and MariaDB with one (`smallint(6)`, `int(11)`, `bigint(20)`). The width changes no value, so the introspection
  of both servers reads an integer type with or without a width as the same type (DIA-200, rule 1); `tinyint(1)` stays
  `bool` on both. The native type of the table descriptor of the catalog connection (`describeTable`) is `COLUMN_TYPE` in
  the form of MySQL 8.4 on both servers, one query in every runtime (DIA-200, rule 1), since the display width of an
  integer is no part of its type since MySQL 8.0.17: an integer type (`tinyint`, `smallint`, `mediumint`, `int`,
  `bigint`) has no width, `unsigned` kept (`int unsigned` for MariaDB `int(10) unsigned`), except `tinyint(1)` and a
  `zerofill` type, whose width MySQL 8.4 keeps too (`tinyint(1)`, `int(5) unsigned zerofill`); `tinyint(1) unsigned` is
  `tinyint unsigned` on both; and MariaDB `year(4)` is `year`. MariaDB `year(2)` has no MySQL 8.4 form and stays as it is.
  The case `catalog_describe_integer_width` holds it on both servers.

- **DIA-205** The column default in the catalog — MySQL 8.4 / MariaDB 11.8 (probes `mysql.default.catalog_text`,
  `mariadb.default.catalog_text`): MySQL gives `COLUMN_DEFAULT` a literal without quotes, a `NULL` default as SQL
  `NULL`, and an expression default, `CURRENT_TIMESTAMP(p)` among them, with `EXTRA` `DEFAULT_GENERATED`. MariaDB writes
  `COLUMN_DEFAULT` as SQL text: `NULL` for a `NULL` default, a string or temporal literal in quotes with its SQL escapes,
  a number as written, an expression as its text and the clock as `current_timestamp()` or `current_timestamp(p)`, and
  `EXTRA` has no `DEFAULT_GENERATED`. No query gives both forms (DIA-200, rule 2), so the introspection reads the MariaDB
  text in the MySQL form: `NULL` is no default, a quoted literal is its value with its escapes undone, a number is
  itself, and any other text is an expression default as MySQL marks it, the clock among them; a quoted text that is not
  one whole literal is an error. The table descriptor of the catalog connection (`describeTable`) reads the same text by
  the same rule: its default expression is the MySQL form, none for `NULL`, and its expression flag is the one MySQL marks.
  The text of an expression stays the text of its server: MySQL writes `(concat('a', 'b'))` as
  `concat(_utf8mb4\'a\',_utf8mb4\'b\')`, with the character set of each literal and its quotes escaped, and MariaDB as
  `concat('a','b')`. The case `catalog_describe_column_defaults` of the recipe catalog_connection reads each form on both
  servers; a quoted text that is not one whole literal is written by neither server, so the native tests of FCV-2 hold it.

- **DIA-206** Dropping a CHECK — MySQL 8.4 / MariaDB 11.8 (probes `mysql.check.drop_constraint`,
  `mariadb.check.drop_constraint`, `mysql.check.drop_constraint_shared_name`, `mariadb.check.drop_constraint_shared_name`):
  a plan drops a CHECK by `ALTER TABLE t DROP CONSTRAINT c`, which both servers accept with the same result, and MariaDB
  has no `DROP CHECK` (1064) (DIA-200, rule 1). MySQL lets a CHECK share its name with a foreign key of its table, and
  `DROP CONSTRAINT` of that name is then ambiguous (3939); MariaDB refuses the shared name (1826). No plan meets that
  table: a document names every check, foreign key, unique key and index apart (DBS-34, the vector
  `check-and-foreign-key-share-a-name`), and a plan drops the foreign keys and checks that change before it adds any
  (PLN-74, PLN-75, PLN-80, PLN-81), so a CHECK that a plan drops never shares its name with a constraint of its table.

- **DIA-207** Partial revokes — MySQL 8.4 / MariaDB 11.8 (probes `mysql.session.partial_revokes_listed`,
  `mariadb.session.partial_revokes_listed`): the catalog refuses a row change on a server with partial revokes (INT-119)
  by `SHOW GLOBAL VARIABLES WHERE Variable_name = 'partial_revokes' AND Value <> 'OFF'`, in every runtime, and refuses
  when it lists a row. MySQL lists the setting when it is on; MariaDB has no partial revokes and no `partial_revokes`
  (1193), and lists no row, so the one form answers both servers with the same result (DIA-200, rule 1). The case
  `row_change_with_partial_revokes_enabled` of the catalog recipe observes on MariaDB that the check refuses nothing there.
  Both replicas refuse a write in the same way: MySQL's runs `super_read_only`, and MariaDB's runs `read_only` with no `READ ONLY
  ADMIN` for the account of its DSN, so each refuses a write of that account with 1290 (`READ_ONLY`). On MySQL the check
  answers first, with `ROW_MUTATION_UNSUPPORTED`; on MariaDB the insert, the update and the delete pass the check and meet
  the replica's 1290 (`READ_ONLY`), and the row stays as it was. MariaDB has no partial revokes, so the premise of that
  case, a server with partial revokes on, does not hold on MariaDB: the case runs on both servers, and its `mariadb`
  expect states the answers of the MariaDB replica (DIA-200, rule 4), the 1193 of `@@GLOBAL.partial_revokes` as `DRIVER`
  and the 1290 of each change as `READ_ONLY`.

- **DIA-208** The statement timeout — MySQL 8.4 / MariaDB 11.8 (probes `mysql.session.statement_timeout`,
  `mariadb.session.statement_timeout`): MySQL bounds a SELECT by `max_execution_time` in milliseconds (3024) and has no
  `max_statement_time` (1193); MariaDB has no `max_execution_time` (1193) and bounds every statement by
  `max_statement_time` in seconds (1969). No setting holds on both (DIA-200, rule 2), so a connection with
  `statementTimeoutMs` (CFG-6), in every runtime and on every connection of a pool, sets after it reads its server
  (DIA-201) and before any other statement `SESSION max_execution_time = <ms>` on MySQL and
  `SESSION max_statement_time = <ms / 1000>`, written with three fraction digits, on MariaDB. A statement that MariaDB
  stops returns `CANCELED` (1969, DIA-201), so MariaDB bounds a write too, as PostgreSQL does. The case
  `mysql_session_settings` of the recipe dsn_connection reads the setting of each server: its `session_read` reads
  `@@SESSION.max_execution_time` on MySQL and `CAST(@@SESSION.max_statement_time * 1000 AS SIGNED)` on MariaDB, since each
  server has the variable of the other as no variable (1193), and both give the one expected row.

- **DIA-209** Row locks — MySQL 8.4 / MariaDB 11.8 (probes `mysql.lock.share_clause`, `mariadb.lock.share_clause`,
  `mysql.lock.nowait_held`, `mariadb.lock.nowait_held`): the lock `share` renders ` LOCK IN SHARE MODE`, which both
  servers read as a shared row lock, since MariaDB has no `FOR SHARE` (1064), and `update_nowait` renders
  ` FOR UPDATE NOWAIT`, which both read alike (DIA-200, rule 1). `share_nowait` has no common form: MySQL takes NOWAIT
  after `FOR SHARE` alone and MariaDB after `LOCK IN SHARE MODE` alone (1064 otherwise), so the planner renders
  ` FOR SHARE NOWAIT` on MySQL and ` LOCK IN SHARE MODE NOWAIT` on MariaDB by the server of the connection (DIA-201;
  DIA-200, rule 2). MariaDB fails a NOWAIT lock that it cannot take at once with 1205, the number of its lock wait
  timeout, where MySQL gives 3572: on MariaDB a statement of a `*_nowait` lock that fails with 1205 returns
  `LOCK_NOT_AVAILABLE`, as on MySQL (INT-49), and 1205 of any other statement stays `CANCELED` (CFG-6). The case
  `nowait_lock_held_by_another_transaction` of the recipe transactions holds it on the MySQL, MariaDB and PostgreSQL servers; it
  leaves out SQLite, which admits one write transaction at a time, so a second transaction waits at its `BEGIN IMMEDIATE` and
  never reaches its lock (the SQLite lock row of INT-49 is held by `sqlite-row-lock-restoration`).

- **DIA-210** The primary-key ordinal of the catalog descriptor — MySQL 8.4 / MariaDB 11.8 (probes
  `mysql.catalog.key_ordinal_by_name`, `mariadb.catalog.key_ordinal_by_name`): MariaDB reads an `information_schema` table by
  the name of its table only from constants of its own conditions, so a join of `KEY_COLUMN_USAGE` on the columns of
  `COLUMNS` opens every table of every database ("Scanned all databases"), about a second for each describe on a server
  with the case databases. The descriptor of the catalog connection reads the ordinal of a column by a subquery that
  names the table by constants, `COALESCE((SELECT k.ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE k WHERE
  k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.CONSTRAINT_NAME = 'PRIMARY' AND k.COLUMN_NAME = c.COLUMN_NAME), 0)`, which
  gives the rows of the join on both servers and reads only its table (DIA-200, rule 1).

- **DIA-211** The count of refused connects — MySQL 8.4 / MariaDB 11.8: the case
  `plain_connect_on_a_held_place_is_refused_once` of the catalog recipe holds that a client does not try again a connect
  that `max_user_connections` refuses (CFG-35), and the servers count that refusal in no common form. MySQL records it as
  an error 1226 of its user in `performance_schema.events_errors_summary_by_user_by_error` and counts it in
  `performance_schema.users`. MariaDB has no error summary; `performance_schema.users` counts only the connections that it
  admits, `USER_STATISTICS` leaves its `DENIED_CONNECTIONS` at 0, and `Aborted_connects` is global. Its server_audit plugin
  writes a refused connect as a `FAILED_CONNECT` line, but only after the refusal is sent (`login_connection`,
  sql/sql_connect.cc, sends the error in `end_statement` and calls `mysql_audit_notify_connection_connect` after it), so a
  read right after the refusal missed the line in 6 of 10 runs on 11.8.6. The count is the client's, not the server's: the
  step `catalog.reconnect {connects}` relays the reconnect through a TCP listener of the runner in front of the server,
  which counts the connections it accepts, and each runtime gives 1 on both servers in the same form (DIA-200, rule 1).

- **DIA-212** The drop of a case database — MySQL 8.4 / MariaDB 11.8: a `DROP DATABASE` of MariaDB that drops the tables
  of its database but cannot remove its folder, since the folder holds a file that is no table's (a trigger file
  `card.TRG-` that a run of the audit recipe left), fails with 1010 "Directory not empty" and logs the tables that it
  dropped as one `DROP TABLE IF EXISTS` list in the binary log, with error code 0 and the `foreign_key_checks` of its
  session. A replica that applies that list with the checks on refuses the parent of a foreign key with 1451, stops its SQL
  thread, and every later `replica.await` of the run fails; the same list with `foreign_key_checks = 0` drops every table.
  The harness of each runtime drops a case database with `SET SESSION foreign_key_checks = 0` on the session of its
  `DROP DATABASE` on both servers (DIA-200, rule 1). `DROP DATABASE` drops the tables of its database whatever their
  foreign keys, so a drop that succeeds is the same, and a drop that fails with 1010 still fails its case. That session
  ends with the drop and returns to no pool, so no later statement of the harness runs without the checks: in every
  runtime a test of its harness drops a case database and reads `foreign_key_checks` 1 on the next admin session, on both
  servers. The drop sets no wait limit of its own; a drop that does not end is ended by the deadline of its case.
  The file comes from MariaDB itself: a `CREATE TRIGGER` on a table that already has a trigger copies `<table>.TRG` to
  `<table>.TRG-` as its crash backup and records the removal of the copy in the DDL log, bound to the execute entry of
  the statement (`Table_triggers_list::create_trigger`, sql/sql_trigger.cc). After the statement succeeds,
  `mysql_create_or_drop_trigger` frees that entry (`ddl_log_complete`) and then runs the removal, which keeps the copy when
  the entry at the freed position is active (`DDL_LOG_DELETE_TMP_FILE_ACTION`, sql/ddl_log.cc): a DDL statement of another
  session that takes the position in between leaves the copy for good. Eight sessions that each create, in a database of
  their own, the twelve triggers of four tables and then drop the database left one copy among 960 on 11.8.6, and its drop
  failed with 1010; the code is the same on 12.2 and on main. That is a defect of the server, and the test servers run the
  MariaDB release as it is: sixteen sessions of twenty-five databases each made 3200 copies on 11.8.6, of which 5 stayed
  and 5 drops failed with 1010. A case whose drop fails with 1010 fails with that error, and the client of every runtime
  returns it as the server gave it, as it does for a user's MariaDB under the same load. The position is global to the server, so a copy
  stays only while a DDL statement of another session runs, in any database; with no DDL at the same time no copy stays:
  one session of two hundred databases made 1600 copies on 11.8.6 and left none. So the recipe runs of every runtime run one
  case at a time, by one policy on every database (MySQL, MariaDB, PostgreSQL, SQLite and markdown): Go, Python and PHP run
  the cases of a recipe target in order; every TypeScript recipe target runs its files with `--test-concurrency=1`
  (`RECIPE_TS_TEST` of the Makefile); every group of a recipe in the Rust programs all and mariadb is a recipe group
  (`Group::recipe`), which runs its trials in order, and every Rust recipe target runs with `--no-fail-fast`
  (`RECIPE_RUST_TEST`); and the suites (scripts/suite-test.mts) run the files of a recipe of contracts/fixtures one at a
  time, after their other files. A case whose subject is concurrency, such as concurrent sessions or a lock wait, makes its
  concurrency inside the case. That changes the order of the cases only, and no case is left out. Runs that share one server, such as the runs
  of several agents on one machine, still run DDL at the same time: a 1010 of such a run names DIA-212 as its cause, and
  its case is judged by a run of that case alone.

- **DIA-213** The database of an introspection read — MySQL 8.4 / MariaDB 11.8: MariaDB reads an `information_schema`
  table of one database only when a condition names the schema column of the table that a row describes, `TABLE_SCHEMA`
  (`EVENT_OBJECT_SCHEMA` for `TRIGGERS`); a condition on `CONSTRAINT_SCHEMA` or `TRIGGER_SCHEMA` alone, or a join of
  `KEY_COLUMN_USAGE` on `CONSTRAINT_SCHEMA`, opens every table of every database. On the MariaDB primary of the test
  servers, `EXPLAIN` gives "Scanned all databases" for the check list of `TABLE_CONSTRAINTS` by `CONSTRAINT_SCHEMA`, the
  trigger list of `TRIGGERS` by `TRIGGER_SCHEMA` and the `KEY_COLUMN_USAGE` side of the foreign key join, and "Scanned 1
  database" for each once it names `TABLE_SCHEMA` or `EVENT_OBJECT_SCHEMA`; the existence probes of a constraint and a
  trigger in a plan apply go from "Scanned 1 database" to "Scanned 0 databases". A constraint and a trigger are in the
  schema of their table, so the introspection of every runtime reads the checks `WHERE TABLE_SCHEMA = DATABASE()`, the
  triggers `WHERE EVENT_OBJECT_SCHEMA = DATABASE()`, joins `KEY_COLUMN_USAGE` with `k.TABLE_SCHEMA = DATABASE()` added,
  and the apply probes the same way; on MySQL 8.4 and MariaDB 11.8 the old and the new form give the same rows for a
  database with a check, a two-column foreign key and a trigger (DIA-200, rule 1).

- **DIA-214** The role of a case account — MySQL 8.4 / MariaDB 11.8: the case `row_change_on_a_role_only_trigger_grant`
  of the catalog recipe gives its user TRIGGER through a role alone (INT-119), and no one procedure makes that role on
  both servers. Runners on one server share its accounts, so the user and the role take their names from the case
  database, and the procedure of the case runs each statement by `PREPARE`. MySQL refuses `CREATE ROLE` and `DROP ROLE`
  in a prepared statement (1295), so its role is a locked account, `CREATE USER ... ACCOUNT LOCK`, dropped by `DROP USER`
  and made the default by `ALTER USER ... DEFAULT ROLE ALL`. A MariaDB role is no account and has no host: it is made by
  `CREATE ROLE`, dropped by `DROP ROLE`, and made the default only by `SET DEFAULT ROLE r FOR u`; MariaDB refuses
  `ALTER USER ... DEFAULT ROLE` and `SET DEFAULT ROLE r TO u` (1064), and MySQL refuses `SET DEFAULT ROLE r FOR u` (1064).
  The case therefore writes its procedure once for each server; its other steps and its expects are the same on both.

- **DIA-215** The wait for a replica — MySQL 8.4 / MariaDB 11.8: the step `replica.await` of the harness (CFG-23) reads the
  binary log position of the primary and waits on the replica until the replica has applied it, and no statement of
  either part holds on both servers. MySQL reads the position by `SHOW BINARY LOG STATUS`, which MariaDB refuses (1064),
  and MariaDB by `SHOW BINLOG STATUS` or `SHOW MASTER STATUS`, which MySQL 8.4 refuses (1064). MySQL waits by
  `SOURCE_POS_WAIT`, which MariaDB does not have (1305). MySQL 8.4 still runs `MASTER_POS_WAIT`, the name of MariaDB, but
  only with warning 1287, which says that the name will be removed, so the harness does not take it as a common form. A
  wait by GTID has no common form either: the MySQL test servers run with `gtid_mode = OFF`, so `WAIT_FOR_EXECUTED_GTID_SET`
  fails (3062), and `MASTER_GTID_WAIT` is MariaDB's alone. The harness of each runtime therefore runs `SHOW BINARY LOG
  STATUS` and `SOURCE_POS_WAIT` on MySQL and `SHOW BINLOG STATUS` and `MASTER_POS_WAIT` on MariaDB, chosen by the database of
  the case; the wait and its deadline are the same on both.

- **DIA-1** identifiers — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.index.primary_name_reserved`): `` `x` ``; PostgreSQL 12+: `"x"`; SQLite 3.46+: `"x"`
- **DIA-2** placeholders — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.like.ascii_fold_replace`): `?`; PostgreSQL 12+: `$n` (the executor renumbers when it expands a `parent` slot to N values); SQLite 3.46+: `?`
- **DIA-3** LIMIT — MySQL 8.0.2+: `LIMIT off, n`; PostgreSQL 12+: `LIMIT n OFFSET off`; SQLite 3.46+: `LIMIT n OFFSET off`
- **DIA-4** `Lk` — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.like.ascii_fold_replace`): `F(col) LIKE F(?)`, F being 26 nested `REPLACE` of `A`–`Z` with its lower case: the column's `utf8mb4_0900_bin` compares code points, and `LOWER` or a `_ci` collation would fold beyond ASCII (probes `mysql.like.binary_collation_case_sensitive`, `mysql.like.ascii_fold_replace`); PostgreSQL 12+: `ILIKE` under `COLLATE "C"` (probe `postgres.ilike.c_collation_ascii_only`); SQLite 3.46+: `LIKE … ESCAPE '\'` (ASCII case-insensitive, probe `sqlite.like.ascii_only`)
- **DIA-5** `Lb` — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.like.binary_collation_code_point`): `LIKE` (binary collation `utf8mb4_0900_bin`, which compares code points; `LIKE BINARY` is deprecated since MySQL 8.0.27; probe `mysql.like.binary_collation_code_point`); PostgreSQL 12+: `LIKE`; SQLite 3.46+: `instr(col, ?) > 0`
- **DIA-6** `Fulltext` / `FulltextBoolean` — MySQL 8.0.2+: `MATCH … AGAINST (… IN NATURAL LANGUAGE/BOOLEAN MODE)`, boolean value normalized by the transform `fulltext_boolean` (PRT-32): split the value on whitespace and drop empty terms; remove the characters `+ - < > ( ) ~ * " @` from each term and drop a term that becomes empty; prefix every term with `+` and suffix the last term with `*`; join the terms with single spaces; a value with no term fails with `IR_INVALID`; PostgreSQL 12+: `to_tsvector('simple', coalesce(a,'') || ' ' || …) @@ plainto_tsquery / websearch_to_tsquery('simple', ?)`, the value bound as it is, with no transform, since both functions skip the whitespace around the terms; SQLite 3.46+: **rejected** (FTS5 needs virtual tables)
- **DIA-7** `forceIndex<Name>` — MySQL 8.0.2+: `FORCE INDEX (name)`; PostgreSQL 12+: ignored (no hints); SQLite 3.46+: `INDEXED BY "name"`
- **DIA-8** insert id — MySQL 8.0.2+: `LAST_INSERT_ID()` (upsert adds `pk = LAST_INSERT_ID(pk)`); PostgreSQL 12+: `RETURNING pk`; SQLite 3.46+: `RETURNING pk`; a multi-row insert (`rows`, PRT-5) reports no insert id, so it has no `RETURNING`
- **DIA-9** `duplication(model)` — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.upsert.any_unique_key`): `ON DUPLICATE KEY UPDATE` (meets only the one conflict key the validator allows; MySQL meets a row on any unique key (`mysql.upsert.any_unique_key`), the NOT NULL unique key first (`mysql.upsert.not_null_unique_first`)); PostgreSQL 12+: `ON CONFLICT (cols) DO UPDATE SET` — conflict target = the one conflict key the validator allows (an upsert has exactly one key that can meet the inserted row; a row that meets another unique key is a unique violation, `postgres.upsert.other_key_conflicts`); SQLite 3.46+: same as PostgreSQL (`sqlite.upsert.other_key_conflicts`); the conformance vector `upsert_one_key` gives one result on the three databases
- **DIA-10** `groupLimit(n)` — MySQL 8.0.2+: `ROW_NUMBER() OVER (…)`; PostgreSQL 12+: same; SQLite 3.46+: same
- **DIA-11** `tuple<ColA>With<ColB>` — MySQL 8.0.2+: `(a, b) IN ((?, ?), …)`; PostgreSQL 12+: same; SQLite 3.46+: `(a, b) IN (VALUES (?, ?), …)`
- **DIA-12** `orderByRandom()` — MySQL 8.0.2+: `RAND()`; PostgreSQL 12+: `random()`; SQLite 3.46+: `random()`
- **DIA-13** `orderBy<Col>Asc()` / `Desc()` on a nullable column — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.order.null_first_asc`): native: NULL first ascending, last descending (`mysql.order.null_first_asc`); PostgreSQL 12+: `ASC NULLS FIRST` / `DESC NULLS LAST`: NULL is last ascending without it (`postgres.order.null_last_asc`); SQLite 3.46+: native: NULL first ascending, last descending (`sqlite.order.null_first_asc`)
- **DIA-14** ORM functions — MySQL 8.0.2+: see [DSL](dsl.md#_10-orm-functions)
- **DIA-15** `aes`/`hex` styles — MySQL 8.0.2+: client-side authenticated AES-256-GCM v2 ciphertext, then hex text when `hex` is present; an invalid hex text is `CODEC_DECODE` on every database; PostgreSQL 12+: client-side authenticated AES-256-GCM v2 ciphertext, then hex text when `hex` is present; an invalid hex text is `CODEC_DECODE` on every database; SQLite 3.46+: client-side authenticated AES-256-GCM v2 ciphertext, then hex text when `hex` is present; an invalid hex text is `CODEC_DECODE` on every database
- **DIA-16** `ip` style — MySQL 8.0.2+: `INET6_ATON` / `INET6_NTOA`; PostgreSQL 12+: client-side (16-byte packed, `bytea`); SQLite 3.46+: client-side (16-byte packed). SQL wraps only the last stages of the write order, those after every client-side stage, so a stage runs in SQL only when every later stage of its column runs in SQL too: a column of `ip hex` packs and unpacks its address on the client on MySQL as well (16-byte packed, then hex text), and its placeholder takes the stored hex text (planner cases `planner_ip_hex_insert` and `planner_ip_hex_select`)
- **DIA-18** clock written by the update time and soft deletion — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.now.precision_truncates`): `CURRENT_TIMESTAMP(p)` for a `datetime(p)` column with `p > 0`, otherwise `CURRENT_TIMESTAMP`; PostgreSQL 12+: executor-bound text truncated to p (`now` bind slot); SQLite 3.46+: executor-bound text truncated to p (`now` bind slot)

- **DIA-19** Executor consequences: a `$n` renumbering step when expanding relation IN lists on
  PostgreSQL, host-side AES/inet codecs where the table says "client-side", one DSN/driver per database
  (Go: `pgx` stdlib / `modernc.org/sqlite`; Rust: sqlx features; PHP: `pdo_pgsql` / `pdo_sqlite`).

- **DIA-20** `github.com/polyspec/orm/packages/go`: `legacy/packages/go/orm` links MySQL only. A program that opens PostgreSQL or SQLite
  imports the matching package for its side effect, as it would a `database/sql` driver:

```go
import (
    _ "github.com/polyspec/orm/packages/go/orm/pg"      // driver "postgres"
    _ "github.com/polyspec/orm/packages/go/orm/sqlite"  // driver "sqlite"
)
```

- **DIA-21** `github.com/polyspec/orm/packages/go`: Without the driver package import, `orm.Connect` returns `CONFIG` naming the import. The split keeps a MySQL-only binary at
  4.6MB instead of 11MB and avoids SQLite's package init (it parses `/etc/services`). Rust does the
  same with sqlx features, PHP with the PDO extension that is installed.

## Rules that keep the three databases identical
- **DIA-22** `UPDATE` always assigns the entity's updated timestamp explicitly (`updated_ts = CURRENT_TIMESTAMP(p)` on MySQL, as `mysql.go` renders, and on PostgreSQL and SQLite an executor-bound text truncated to p via a `now` bind slot; soft deletion assigns its column the same way) — MySQL's `ON UPDATE` has no counterpart elsewhere and optimistic locking relies on it.
- **DIA-23** `plus`/`minus` reference the column table-qualified (`"author"."read_count" + $9`): inside `ON CONFLICT DO UPDATE` a bare name is ambiguous on PostgreSQL.
- **DIA-24** SQLite datetimes are UTC text `YYYY-MM-DD HH:MM:SS` with exactly p fraction digits for a `datetime(p)` column, and times are `HH:MM:SS` with exactly p digits for a `time(p)` column, as the renderer CHECK requires; the executor binds that form (the bind slot carries p) and supplies the clock for omitted `default now` columns on insert, so a value read back compares equal. A string compared with or assigned to a datetime or time column is written in the same form: `YYYY-MM-DD[ T]HH:MM:SS[.f]` or `HH:MM:SS[.f]` is padded with zeros to p digits, a digit past p must be zero and is dropped, and a non-zero digit past p returns `CODEC_ENCODE`; a string with `Z` or `±HH:MM` is converted to UTC. A date column takes `YYYY-MM-DD`. Any other string returns `CODEC_ENCODE`. The client binds a datetime or time value in this text form on MySQL and PostgreSQL too. A `time(p)` column is read as its text with exactly p fraction digits, which the database writes: MySQL `CAST(c AS CHAR)`, PostgreSQL `to_char(c, 'HH24:MI:SS')` for p = 0 and `substr(to_char(c, 'HH24:MI:SS.US'), 1, 9 + p)` otherwise; PostgreSQL binds a `time` value as `CAST(CAST(? AS text) AS time)`. The conformance vectors `datetime_p0_roundtrip` and `time_p3_roundtrip` insert such values, read them back by the same parameter and compare, and the planner cases `planner_time_select` and `planner_time_insert` pin the statements.
- **DIA-25** A `decimal(P,S)` column uses MySQL `DECIMAL(P,S)`, PostgreSQL `NUMERIC(P,S)`, and SQLite `DECIMALINT(P,S)`. SQLite stores the exact value as a signed integer multiplied by 10^S; the executor converts this integer to the generated model's fixed-scale decimal string on read. The declaration requires `1 ≤ P ≤ 18` and `0 ≤ S ≤ P`, so the scaled value fits a signed 64-bit integer. The manifest records `scale: 0` explicitly for an integral decimal. Invalid text, excess digits, scale loss, and an incompatible stored cell fail with `CODEC_ENCODE` or `CODEC_DECODE`.
- **DIA-26** A `jsontext` column is text on every dialect: `text` on PostgreSQL, `LONGTEXT` on MySQL, and TEXT on SQLite. The stored text is returned as written, so member order, duplicate keys, and an empty object against an empty array survive. The ORM has no JSON path conditions and no JSON indexes; data queried inside the database is modeled as columns or a child table.
- **DIA-27** A `uuid` column holds 16 bytes on every database: a native `uuid` on PostgreSQL, `BINARY(16)` on MySQL and MariaDB, and a 16-byte BLOB on SQLite and flowmark. Its value at the interface is one text in every runtime, the lower-case canonical form of 36 characters: 8, 4, 4, 4 and 12 digits of `0-9a-f` joined by `-`. On MySQL and SQLite the client binds a uuid parameter as the 16 bytes that its 32 digits write in their order, two digits to a byte, and reads a uuid cell of 16 bytes as that text again; no server function converts a value (MariaDB has no `UUID_TO_BIN` and `BIN_TO_UUID`), and no field of the text moves. Every planner reads a PostgreSQL `uuid` column as `CAST(col AS text)` and binds a value as `CAST(CAST(? AS text) AS uuid)`, so the PostgreSQL client binds and reads the text. The 16 bytes are in the order of the text, and PostgreSQL compares a `uuid` by its bytes (`postgres.uuid.byte_order`), so equality, `ORDER BY` and the range operators (PRT-22) compare byte order on every database, which is the order of the canonical text: the conformance vector `uuid_roundtrip` and the cases `uuid_stored_in_16_bytes`, `uuid_order_is_the_order_of_its_text` and `uuid_equality_and_range` of the recipe `conformance_verification` hold one result on the five databases. A uuid cell that is not 16 bytes, or on PostgreSQL not canonical text, is `CODEC_DECODE` `uuid cell is not a uuid` (COD-1).
- **DIA-28** MySQL writes a literal default of a TEXT, BLOB, JSON, or geometry column in the expression form `DEFAULT ('value')`, which needs MySQL 8.0.13 or later; import reads it back as the literal.
- **DIA-29** Booleans: PostgreSQL `boolean`, MySQL `BOOLEAN`/`TINYINT(1)` with numeric `0`/`1` defaults, and SQLite INTEGER 0/1 (read back as bool by column type); bind bools, not integers.
- **DIA-30** CHECK expressions are rendered unchanged on PostgreSQL and SQLite. MySQL wraps the declared expression in an explicit boolean comparison because MySQL rejects predicate-valued `CASE` expressions as CHECK definitions; `NULL` remains `UNKNOWN` and therefore retains standard CHECK semantics. MySQL scopes CHECK names to the database rather than the table, so the renderer writes every CHECK name unchanged (no prefix) and the schema check keeps all constraint, index and generated names unique and at most 63 bytes; a generated name that would be longer is a `name.length` error at the column or setting that produces it, and is never shortened or hashed ([dbspec names](dbspec.md#names)).
- **DIA-31** `bind_slots[].col_type` is the dbspec type of the value a placeholder takes: the type of the column it is compared with or assigned to (a value that host styles encode is the stored value, so it has the column's type), the input type of a SQL-side style function (`INET6_ATON` takes `text`), the result type of a compared column function, `i32` or `f64` for the interval of a relative time function, `text` for a secret, the column's type for a config value or an audit key, and `datetime` for a `now` slot. A `parent` slot carries `key_types`, the types of the compared key columns. Every slot has a type, and a slot without one is `IR_INVALID`. `col_type` is the type the placeholder takes, after any SQL-side style; the logical type of a parameter is the type before it, the type of the compared or assigned column or of the first stage's input, which `ir.ParamUses` lists ([protocol](protocol.md) §5 "Parameters"). Before any statement a client checks each parameter against the logical type of each `param` slot it fills, with the slot's `precision`, `scale` and `length`, and a value outside it is `CODEC_ENCODE`; a slot with `host_styles` leaves the check to the encoding of its first stage, and a slot with a `transform` to that transform, which binds SQL NULL as NULL and answers `CODEC_ENCODE` for another value that is not text. On PostgreSQL the Rust client binds each value as the PostgreSQL type of its slot's dbspec type and asks the server for no parameter or column information. Executors normalize SQLite time values before binding.
- **DIA-32** aes/hex/ip host stages: `bind_slots[].host_styles` names the stages the executor applies to a bound value; `columns[].styles` carries them on read. AES uses the `ORM-AES2\0` authenticated ciphertext format, a random 12-byte nonce, AES-256-GCM, and the versioned key derivation defined in `docs/spec/codec.md`.
- **DIA-33** An entity with AES columns declares its key version column with the `aes_version` setting. A read selects that column once: the selected column when the request selects it, otherwise a hidden column; the key comes from the configured key versions using the stored version. A missing key fails with `CONFIG` and invalid ciphertext with `CODEC_DECODE`; the current key is never tried for an older version.
- **DIA-35** `contains` matches a substring with the ASCII letters compared without regard to case and every other character by code point, on every database: MySQL folds A–Z of both operands with nested `REPLACE` (`Lk` above), PostgreSQL `ILIKE` under `COLLATE "C"` and SQLite `LIKE` fold ASCII letters only; the conformance vector `contains_ascii_fold` pins the result.
- **DIA-36** A relative time function (`seconds_ago` to `months_later`) is NULL when its result lies outside 0001-01-01 00:00:00 to 9999-12-31 23:59:59.999999 or its interval exceeds the span of that range (315537897600 seconds, 5258964960 minutes, 87649416 hours, 3652059 days, 119988 months), so a comparison with it and the negation of that comparison both match no row. Past the range MySQL and SQLite give NULL and below it the year 0000 (`mysql.relative.out_of_range_null`, `sqlite.relative.out_of_range_null`); PostgreSQL fails on an interval it cannot represent and gives the year 10000 past the range (`postgres.relative.interval_out_of_range`). Every dialect therefore wraps the interval in `CASE WHEN <interval> BETWEEN -<span> AND <span> THEN <interval> END`, inside the function so that no constant folding evaluates an unrepresentable interval, and the result in `CASE WHEN <result> BETWEEN '0001-01-01 00:00:00' AND '9999-12-31 23:59:59.999999' THEN <result> END`; SQLite needs only the result guard, because it already gives NULL for an interval it cannot apply. The conformance vector `relative_time_out_of_range` runs both sides of each comparison. Month arithmetic keeps the last valid day of the target month ([DSL-142](dsl.md)): MySQL `DATE_ADD` and `DATE_SUB` and PostgreSQL `make_interval(months => n)` do so themselves (`mysql.relative.month_end_kept`, `postgres.relative.month_end_kept`), while SQLite `datetime` carries a day past the end of the target month into the next month, so its form adds the `floor` modifier (`sqlite.relative.month_floor`).
- **DIA-216** A `SUM` or an `AVG` of an `f64` column whose result leaves the finite binary64 range is one fact on every database, a sum or an average out of the range of its type (DSL-66), and is `CODEC_DECODE` with the text `aggregate scalar is not a finite number`. SQLite and markdown return an infinite real, which the executor refuses so. PostgreSQL refuses the statement with SQLSTATE 22003 (`value out of range: overflow`). MySQL returns the infinite double in its binary protocol and writes it as 0 in its text protocol, which is a finite sum, so the planner selects `SUM(c) + 0` for an `f64` column on MySQL, which MySQL refuses with 1690 (SQLSTATE 22003) when the sum is not finite and which is the sum itself otherwise. The executor reports SQLSTATE 22003 of the statement of `getSum()` or `getAvg()` on MySQL and PostgreSQL as that `CODEC_DECODE`, with the driver error as its cause. Outside a transaction a PostgreSQL statement first runs once more (CFG-28); inside one, PostgreSQL has aborted the transaction, as for every statement it refuses.
- **DIA-217** A finite `f64` parameter is the binary64 value that the caller gave, on every database. PDO binds a float as its text, which PHP writes with its `precision` setting, 14 significant digits by default, and that text names another binary64 value, so the PHP client `polyspec/orm` and the PHP-extension client `polyspec/orm-php-ext` bind a finite float on MySQL, PostgreSQL and SQLite as the shortest decimal text that reads back as the same value, whatever that setting is; a markdown connection binds it as a float (PRT-67).
- **DIA-218** SQLite sums integers in a signed 64-bit integer and refuses a sum past that range with `integer overflow`, where MySQL and PostgreSQL return the exact sum, so on SQLite, and on markdown, which runs its statements in SQLite, the sum of an exact column (DSL-161), the integers of an integer column or the scaled integers of a `decimal(P,S)` column (DIA-25), is planned as the sums of the four 16-bit parts of its values and one cell more: `SUM(c >> 48)`, the high part, which `>>` shifts with its sign, in [-2^15, 2^15); `SUM((c >> 32) & 65535)`, `SUM((c >> 16) & 65535)` and `SUM(c & 65535)`, the three others, in [0, 2^16); and `MAX(typeof(c) NOT IN ('integer', 'null'))`, which is 1 when a value is not an integer. A sum selects the four sums, each as `COALESCE(<sum>, 0)`, and that cell; an average selects the four sums, that cell and `COUNT(c)`. The executor combines the four sums p3, p2, p1 and p0 as the exact integer ((p3 × 2^16 + p2) × 2^16 + p1) × 2^16 + p0, which it holds without a bound, and that integer is the exact sum of DSL-161, which DSL-66 converts once, so `getSum()` and `getAvg()` give one value on every database, a sum past the i64 range above or below included, in the host type of DSL-66 in every runtime. None of the four sums leaves the i64 range on a table that SQLite can hold, so the split has no bound that a database reaches: a part lies in [-2^15, 2^16), so n parts sum into (-2^62, 2^63) for n up to 2^47; and a table holds fewer than 2^47 rows, since a database file has at most 4294967294 pages (SQLITE_MAX_PAGE_COUNT, 2^32 - 2) of at most 65536 bytes ([SQLite limits](https://www.sqlite.org/limits.html)), fewer than 2^48 bytes, and each row takes at least the 2-byte entry of the cell pointer array of its b-tree page ([SQLite file format](https://www.sqlite.org/fileformat2.html)); markdown runs its statements in SQLite under the same limits. A value that is not an integer, which only a table changed behind its schema holds, since the CHECK of the column refuses it, would lose its fraction to `>>` and `&`; the last cell reports it, and the executor refuses the sum and the average with the `CODEC_DECODE` of DSL-66 `column <column> holds a value that is not an integer`, or `column <column> holds a value that is not a decimal of scale <S>` for a `decimal(P,S)` column. That is also the refusal of the decimal text of a sum that MySQL and PostgreSQL return with a fraction for an integer column, or with more fraction digits than S for a decimal column, as such a column does, so the sum of such a column fails alike on every database. The case `added_sum_fractional` holds it; the cases `aggregate_of_an_integer_column_past_the_i64_range_is_exact` and `sum_parts_of_i64_boundary_values_are_exact` of the recipe `conformance_verification` hold sums and averages past the range above and below it, a running sum that passes the range and comes back, and values at both ends of the range whose parts carry into each other, on every database.
- **DIA-219** Every client reads a MySQL `DECIMAL` and a PostgreSQL `NUMERIC` cell as its exact decimal text, whatever its number of digits: a catalog column holds at most 18 digits (DIA-25), but a sum of DSL-161 and a cell of a raw statement can hold more, and no client reads them through a decimal of fixed width that rounds. Rust reads the text that MySQL sends and decodes the binary NUMERIC of PostgreSQL from its sign, weight, display scale and base-10000 digits, since its 128-bit decimal holds 28 significant digits and rounds a longer value; a NUMERIC NaN or infinity, which no exact column holds, is `CODEC_DECODE`. A decimal field parameter holds at most 18 digits (COD-2), but a parameter that PostgreSQL types as `NUMERIC` when a statement runs again after a schema change (CFG-28) is the text of a field of another type, of any number of digits; every client binds it as the number that PostgreSQL 17 reads from that text (numeric_in), and Rust encodes the binary NUMERIC of that text, with no width of its own, by the same rule: spaces around it, one sign, `NaN` and the infinities in any case, a hexadecimal, octal or binary integer, an underscore between digits, and an exponent. A text that PostgreSQL does not read as a numeric fails as PostgreSQL refuses it, `DRIVER` of SQLSTATE `22P02` for a text that is no numeric and `22003` for a numeric past its range, in every client; Rust has the server read the text of a parameter whose type changed (CFG-28), and its encoder binds the values that a decimal field and an integer or a float bound as a numeric hold. The case `decimal_text_past_28_digits_reads_exactly` of the recipe `conformance_verification` reads a decimal of 40 digits and one of 30 fraction digits on MySQL and PostgreSQL, and the case `model_decimal_text_parameter_after_schema_change` of the recipe `parameter_chunking` writes and compares texts of 30 digits, of 29 fraction digits and with an exponent as the column that PostgreSQL changed to `NUMERIC`; its case `model_numeric_text_parameter_refused_after_schema_change` writes a text that is no numeric and one past the range, which PostgreSQL refuses. The databases differ there by their own rules, and each case expects each: MySQL in strict mode refuses a text that is no value of the column type, or one past its range, as an error of the statement (1366, 1292, 1264), so the write is `DRIVER` as on PostgreSQL; SQLite, and markdown through it, stores a text that the affinity of its column (INTEGER, NUMERIC) does not convert to a number as that text, so the write succeeds and the row holds the text. The case `model_text_parameter_refused_after_schema_change` writes the texts `seven` and `2026-02-30` to a column changed to an integer and to a date, with these outcomes.
- **DIA-37** Conformance: the recipe `conformance_verification` states the expect of each case for each dialect; every case's **result** is identical to MySQL except `get_query`, whose result is the dialect's own SQL text.

## Schema definitions

This section records how MySQL, PostgreSQL and SQLite define, enforce and report schema objects, and decides for each feature whether the neutral schema language dbspec supports it. A feature is supported only when (1) dbspec has one common definition for it, (2) that definition renders with the same meaning on MySQL, PostgreSQL and SQLite, and (3) introspection restores the same definition from the catalog without hidden markers. A behavior generated from a setting, such as a CHECK or trigger that the renderer writes, is restored only when the catalog text equals the output of the declared renderer version.

Every fact cites the IDs of the shared probes in `legacy/packages/go/internal/dialects` (`make dialect-facts-check`). A probe runs DDL, DML and catalog queries in its own disposable database, schema or file and fails when the database behaves differently. `render.*` probes check a proposed rendering. Facts without a probe ID cite the official manual. Each row ends with **Decision:**; **T8.1 review** marks a definition this record does not decide.

Notation: "renderer CHECK" is a CHECK constraint that the renderer writes for a type or setting; T8.1 fixes its exact text and name, and introspection accepts it only when the catalog text equals the renderer output for that server.

### Probe environment

| Item | Value |
|---|---|
| MySQL | 8.4.11; server `sql_mode` includes `STRICT_TRANS_TABLES`, and every client sets the session `sql_mode` of [config](config.md) (`mysql.session.sql_mode_set`); `lower_case_table_names=1`; `log_bin=1`; `log_bin_trust_function_creators=0`; `explicit_defaults_for_timestamp=1`; server time zone `SYSTEM` (KST) (`mysql.env.server`) |
| PostgreSQL | 17.11; `TimeZone=Asia/Seoul`; database collation `C`; `max_identifier_length=63` (`postgres.env.server`) |
| SQLite (probes) | 3.53.4 through `modernc.org/sqlite` v1.58.0 (`sqlite.env.library`) |
| SQLite, Go client | `modernc.org/sqlite` v1.58.0 (`legacy/packages/go/go.mod`): 3.53.4 from `select sqlite_version()` |
| SQLite, PHP client | `pdo_sqlite` of PHP 8.4.26: 3.53.4 from `select sqlite_version()` |
| SQLite, TypeScript client | `node:sqlite` of Node 26.11.1: 3.53.4 from `select sqlite_version()`; `package.json` accepts Node 26.12.0 and later, whose later bundled versions were not measured |
| SQLite file name | A file name that still carries the DSN query is opened literally by PHP PDO, `node:sqlite` and the `sqlite3` shell, which create `bench.sqlite?_pragma=…`; `modernc.org/sqlite` parses the query (`sqlite.filename.*` cases of `TestSQLiteFileNameWithQuery`). A client removes the query before it names the file |
| SQLite, Rust client | sqlx 0.9 `sqlite` feature enables `sqlite-bundled`; `libsqlite3-sys` 0.37.0 (`packages/rust/Cargo.lock`) bundles 3.51.3, read from `sqlite3_libversion()` of a build of that crate and feature. The probes did not run on 3.51.3 |

### Types

- **DIA-38** Integers — MySQL 8.4: `TINYINT`/`SMALLINT`/`MEDIUMINT`/`INT`/`BIGINT`, range enforced in strict mode (1264); display width is dropped except `tinyint(1)`; PostgreSQL 17: `smallint`/`integer`/`bigint` only, range enforced (22003); no `tinyint`/`mediumint` (42704); SQLite: Declared name selects affinity only; any value or range is stored in a non-STRICT table; Probes: `mysql.int.tinyint_range`, `mysql.int.display_width_dropped`, `postgres.int.smallint_range`, `postgres.int.no_tinyint`, `sqlite.type.affinity_unenforced`, `sqlite.render.integer_check`; Decision and neutral rendering: **Decision:** supported as `i16`, `i32`, `i64`: MySQL `SMALLINT`/`INT`/`BIGINT`, PostgreSQL `smallint`/`integer`/`bigint`, SQLite `smallint`/`integer`/`bigint` with renderer CHECK `typeof(c) IN ('integer','null') AND c BETWEEN min AND max` (none for `i64` range). 8-bit and 24-bit integers are unsupported: PostgreSQL has no such type; Introspection: MySQL `COLUMNS.COLUMN_TYPE`; PostgreSQL `pg_attribute.atttypid`/`format_type`; SQLite `pragma_table_info.type` and the CHECK text in `sqlite_master.sql`
- **DIA-39** Unsigned — MySQL 8.4: `UNSIGNED` rejects negatives; `BIGINT UNSIGNED` reaches 18446744073709551615; PostgreSQL 17: No modifier (42601); SQLite: Accepted as part of the name and ignored; Probes: `mysql.int.unsigned_rejects_negative`, `mysql.int.bigint_unsigned_exceeds_signed`, `postgres.int.no_unsigned`, `sqlite.type.affinity_unenforced`; Decision and neutral rendering: **Decision:** unsupported. No PostgreSQL or SQLite type holds the unsigned 64-bit range; a non-negative rule is an explicit CHECK definition; Introspection: MySQL `COLUMN_TYPE` suffix ` unsigned` is reported as unsupported
- **DIA-40** Boolean — MySQL 8.4: `BOOLEAN` is `tinyint(1)` and stores 2 and -1; PostgreSQL 17: `boolean` rejects integers (42804); SQLite: `TRUE`/`FALSE` are 1/0; `BOOLEAN` has NUMERIC affinity and stores any value; Probes: `mysql.bool.alias_tinyint`, `postgres.bool.rejects_integer`, `sqlite.bool.literals`, `mysql.render.bool_check`, `sqlite.render.bool_check`; Decision and neutral rendering: **Decision:** supported as `bool`: MySQL `tinyint(1)` with renderer CHECK `b IN (0,1)`, PostgreSQL `boolean`, SQLite `BOOLEAN` with renderer CHECK `b IN (0,1)`. Field names never select boolean; Introspection: MySQL `COLUMN_TYPE` `tinyint(1)` with the CHECK; PostgreSQL `boolean`; SQLite type and CHECK text
- **DIA-41** Decimal — MySQL 8.4: `DECIMAL(p,s)`, p ≤ 65 (1426), s ≤ 30 (1425); excess scale rounds half away from zero; overflow fails (1264); PostgreSQL 17: `numeric(p,s)`, p ≤ 1000 (22023), negative scale allowed; same rounding; overflow fails (22003); SQLite: No decimal storage; `DECIMAL(4,2)` has NUMERIC affinity and stores 1.235 as a real; `DECIMALINT(p,s)` has INTEGER affinity; Probes: `mysql.decimal.scale_rounds`, `mysql.decimal.overflow_rejected`, `mysql.decimal.precision_limits`, `postgres.numeric.scale_rounds`, `postgres.numeric.overflow_rejected`, `postgres.numeric.precision_limits`, `sqlite.type.affinity_from_name`, `sqlite.render.decimal_check`; Decision and neutral rendering: **Decision:** supported as `decimal(p,s)` with 1 ≤ p ≤ 18 and 0 ≤ s ≤ p: MySQL `DECIMAL(p,s)`, PostgreSQL `numeric(p,s)`, SQLite `DECIMALINT(p,s)` storing the value × 10^s with renderer CHECK `typeof(d) IN ('integer','null') AND d BETWEEN -(10^p-1) AND 10^p-1`. Clients reject a value with more than s fraction digits or p digits in all with `CODEC_ENCODE` before any statement (`decimal-scale` and `decimal-precision` of `tests/bind/vectors.json`), so database rounding is never used; Introspection: MySQL `NUMERIC_PRECISION`/`NUMERIC_SCALE`; PostgreSQL `numeric_precision`/`numeric_scale`; SQLite declared type text
- **DIA-42** Floating point — MySQL 8.4: `FLOAT` is 4-byte, `DOUBLE` 8-byte; no NaN or infinity (1367); PostgreSQL 17: `real` 4-byte, `double precision` 8-byte; stores NaN and Infinity; SQLite: `REAL` is 8-byte; infinity is stored; Probes: `mysql.float.single_precision`, `mysql.float.no_infinity`, `postgres.float.real_single_precision`, `postgres.float.nan_infinity`, `sqlite.float.infinity`; Decision and neutral rendering: **Decision:** `f64` supported: MySQL `DOUBLE`, PostgreSQL `double precision`, SQLite `REAL`; values are finite and clients reject NaN and infinities. `f32` unsupported: SQLite has no 4-byte float; Introspection: MySQL `DATA_TYPE`; PostgreSQL `atttypid`; SQLite declared type
- **DIA-43** `varchar(n)` — MySQL 8.4: Length in characters (1406); excess trailing spaces are removed; utf8mb4 n ≤ 16383 (1074); PostgreSQL 17: Length in characters (22001); excess trailing spaces are removed; n ≤ 10485760 (22023); SQLite: Length not enforced; Probes: `mysql.varchar.length_in_characters`, `mysql.varchar.trailing_spaces_truncated`, `mysql.varchar.max_length`, `postgres.varchar.length_in_characters`, `postgres.varchar.trailing_spaces_truncated`, `postgres.varchar.max_length`, `sqlite.varchar.length_unenforced`, `sqlite.render.varchar_check`; Decision and neutral rendering: **Decision:** supported as `varchar(n)` with 1 ≤ n ≤ 16383: MySQL and PostgreSQL `varchar(n)`, SQLite `varchar(n)` with renderer CHECK `length(v) <= n`. Clients reject a value longer than n characters, including trailing spaces, with `CODEC_ENCODE` before any statement (the conformance vector `varchar_length_rejected`), so the database removal of spaces is never used; Introspection: MySQL `CHARACTER_MAXIMUM_LENGTH`; PostgreSQL `atttypmod`/`character_maximum_length`; SQLite declared type and CHECK text
- **DIA-44** `char(n)` — MySQL 8.4: Trailing spaces are removed on read; PostgreSQL 17: Value is returned padded with spaces; SQLite: No padding; Probes: `mysql.char.trailing_spaces_removed`, `postgres.char.padded`; Decision and neutral rendering: **Decision:** unsupported. The stored and returned values differ between MySQL and PostgreSQL; Introspection: Reported as unsupported
- **DIA-45** `text` — MySQL 8.4: `TEXT` ≤ 65535 bytes (1406), `LONGTEXT` ≤ 4 GiB; a literal default needs `DEFAULT ('x')` (1101); an index needs a prefix (1170); PostgreSQL 17: `text` without length; 1 MiB stored in the probe; field limit 1 GB; SQLite: `TEXT`, limited by `SQLITE_MAX_LENGTH` (default 10^9 bytes); Probes: `mysql.text.max_bytes`, `mysql.text.literal_default_needs_expression`, `mysql.text.index_needs_prefix`, `postgres.text.unlimited`; Decision and neutral rendering: **Decision:** supported as `text`: MySQL `LONGTEXT`, PostgreSQL `text`, SQLite `TEXT`. A `text` column cannot be part of a key or index. The largest value is the smallest of PostgreSQL's 1 GB field limit, SQLite's `SQLITE_MAX_LENGTH` and MySQL's `max_allowed_packet`. Ordered JSON is `text` with a codec setting; Introspection: MySQL `DATA_TYPE`; PostgreSQL `atttypid`; SQLite declared type
- **DIA-46** U+0000 in text — MySQL 8.4: Stored; PostgreSQL 17: Rejected (22021); SQLite: Stored; `length()` stops at it; Probes: `mysql.text.nul_preserved`, `postgres.text.nul_rejected`, `sqlite.text.nul_preserved`; Decision and neutral rendering: **Decision:** U+0000 is not a neutral text value. Clients reject it in `text` and `varchar` with `CODEC_ENCODE` before any statement on every database (the conformance vector `text_nul_rejected`); Introspection: Not applicable
- **DIA-47** Bytes — MySQL 8.4: `BINARY(n)` pads with zero bytes; `VARBINARY(n)` enforces its length (1406); `LONGBLOB`; PostgreSQL 17: `bytea` has no length (42601); SQLite: `BLOB` has no length; Probes: `mysql.binary.zero_padded`, `mysql.varbinary.length_enforced`, `postgres.bytea.no_length`; Decision and neutral rendering: **Decision:** `bytes` without length supported: MySQL `LONGBLOB`, PostgreSQL `bytea`, SQLite `BLOB`. `binary(n)` and `varbinary(n)` are unsupported: padding and length exist on MySQL only; Introspection: MySQL `DATA_TYPE`; PostgreSQL `atttypid`; SQLite declared type
- **DIA-48** UUID — MySQL 8.4: No type (1064); MariaDB 11.8: a `UUID` type that stores the groups of the text in another order, so that `ORDER BY` is not the order of the text; PostgreSQL 17: `uuid` of 16 bytes compared by its bytes, which accepts braces and upper case and returns lower case; SQLite: No type; Probes: `mysql.uuid.no_type`, `mariadb.uuid.no_type`, `postgres.uuid.native_normalized`, `postgres.uuid.byte_order`, `mysql.render.uuid_bytes`, `mariadb.render.uuid_bytes`, `mysql.uuid.binary_pads`, `mariadb.uuid.binary_pads`, `sqlite.render.uuid_bytes`; Decision and neutral rendering: **Decision:** supported as `uuid` of 16 bytes whose value is the lower-case canonical text (DIA-27): PostgreSQL `uuid`; MySQL and MariaDB `BINARY(16)` with renderer CHECK `length(u) = 16`, not MariaDB's own `UUID`, whose order differs from the other databases (rule 1 of DIA-200 holds one form that both servers order alike); SQLite `BLOB` with renderer CHECK `typeof(u) IN ('blob', 'null') AND length(u) = 16`. `BINARY(16)` pads a shorter value with zero bytes and refuses a longer one (1406, `mysql.uuid.binary_pads`), so its CHECK holds every stored value and is the named marker that tells a uuid from a `bytes` column (DIA-144); the client always binds 16 bytes. A text other than the lower-case canonical form, upper case and braces among them, is refused by the encode of the client with `CODEC_ENCODE` `parameter <i> is not a lower-case canonical uuid` before any statement in all six runtimes and on every database, PostgreSQL included (the conformance vector `uuid_form_rejected`), so PostgreSQL's reading of other forms is never used and no input is normalized. Releases up to 0.0.28 stored a uuid as `char(36) CHARACTER SET ascii COLLATE ascii_bin` on MySQL and as `TEXT` on SQLite; dbspec apply converts such a column to 16 bytes (PLN-108); Introspection: PostgreSQL `uuid`; MySQL and SQLite type and CHECK text
- **DIA-49** Enum — MySQL 8.4: `ENUM` rejects unknown values (1265), stores the first value for an omitted NOT NULL column and sorts by list position; PostgreSQL 17: `CREATE TYPE … AS ENUM` is a separate type object (`USER-DEFINED`, `pg_enum`), rejects unknown values (22P02), sorts by list position; SQLite: `enum('a','b')` is a syntax error; Probes: `mysql.enum.rejects_unknown`, `mysql.enum.not_null_first_value_default`, `mysql.enum.sorts_by_position`, `postgres.enum.type_object`, `sqlite.enum.type_name_rejected`; Decision and neutral rendering: **Decision:** native enums unsupported. A value list is a `varchar(n)` column with an `in` CHECK definition; it sorts as text on every database; Introspection: MySQL `ENUM` columns and PostgreSQL enum types are reported as unsupported
- **DIA-50** JSON — MySQL 8.4: `JSON` keeps the last duplicate key and reorders members; PostgreSQL 17: `json` keeps the text; `jsonb` keeps the last duplicate key and reorders; MariaDB 11.8: `JSON` is `LONGTEXT` in `utf8mb4_bin` with a `CHECK (json_valid(c))` named after its column `c`, which keeps the text as written, member order and duplicate keys included; SQLite: Text; `json()` keeps duplicate keys; Probes: `mysql.json.normalizes`, `mariadb.json.normalizes`, `postgres.json.text_jsonb_normalized`, `sqlite.json.text_kept`; Decision and neutral rendering: **Decision:** native JSON types unsupported. Ordered JSON is a `text` column with the ordered-json codec setting; Introspection: MySQL `JSON` and PostgreSQL `json`/`jsonb` columns are reported as unsupported; on MariaDB the column and its `json_valid` CHECK are each reported as unsupported, so the vector `mysql-unsupported` of `tests/dbspec/introspect.json` states the CHECK `doc` in its `mariadb` result (DIA-200, rule 4)

Sources: [MySQL numeric types](https://dev.mysql.com/doc/refman/8.4/en/numeric-types.html), [MySQL string types](https://dev.mysql.com/doc/refman/8.4/en/string-types.html), [MySQL storage requirements](https://dev.mysql.com/doc/refman/8.4/en/storage-requirements.html), [MySQL ENUM](https://dev.mysql.com/doc/refman/8.4/en/enum.html), [MySQL JSON](https://dev.mysql.com/doc/refman/8.4/en/json.html), [PostgreSQL numeric types](https://www.postgresql.org/docs/17/datatype-numeric.html), [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html), [PostgreSQL binary data](https://www.postgresql.org/docs/17/datatype-binary.html), [PostgreSQL UUID](https://www.postgresql.org/docs/17/datatype-uuid.html), [PostgreSQL enum](https://www.postgresql.org/docs/17/datatype-enum.html), [PostgreSQL JSON](https://www.postgresql.org/docs/17/datatype-json.html), [SQLite datatypes](https://www.sqlite.org/datatype3.html), [SQLite STRICT tables](https://www.sqlite.org/stricttables.html), [SQLite limits](https://www.sqlite.org/limits.html).

- **DIA-51** SQLite STRICT tables enforce storage classes but accept only `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB` and `ANY` as type names (`sqlite.strict.enforces_types`, `sqlite.strict.type_names_limited`). A STRICT table therefore cannot keep `varchar(n)` or `DECIMALINT(p,s)` in its catalog, and the length or scale would not be restorable. **Decision:** SQLite tables are not STRICT; the declared type name carries the neutral type and renderer CHECKs enforce it.

### Date and time

- **DIA-52** `date` — MySQL 8.4: `DATE`; strict mode rejects `0000-00-00` (1292); PostgreSQL 17: `date`, 4713 BC to 5874897 AD; SQLite: No type; any text is stored; Probes: `mysql.date.zero_rejected`, `sqlite.datetime.text_unvalidated`, `sqlite.render.date_check`; Decision and neutral rendering: **Decision:** supported as `date` from 0001-01-01 to 9999-12-31: MySQL `DATE`, PostgreSQL `date`, SQLite `DATE` with renderer CHECK `d IS date(d)`; Introspection: MySQL `DATA_TYPE`; PostgreSQL `atttypid`; SQLite type and CHECK text
- **DIA-53** `time` — MySQL 8.4: `TIME` is an interval from -838:59:59 to 838:59:59 (1292 beyond); PostgreSQL 17: `time` is a time of day and accepts 24:00:00; 25:00:00 fails (22008); SQLite 3.54.1 (the pinned Go driver): no type; `time('24:00:00')` returns `00:00:00`, and `time('24:00:01')` and `time('25:00:00')` return NULL; the renderer CHECK rejects 24:00:00; Probes: `mysql.time.interval_range`, `postgres.time.day_range`, `sqlite.render.time_check`, `mysql.render.time_of_day_check`, `postgres.render.time_of_day_check`; Decision and neutral rendering: **Decision:** supported as `time(p)`, a time of day below 24:00:00: MySQL `TIME(p)` with renderer CHECK `v >= '00:00:00' AND v < '24:00:00'`, PostgreSQL `time(p)` with renderer CHECK `v < '24:00:00'`, SQLite `TIME` text with renderer CHECK `v IS time(v) AND v < '24:00:00'` for p = 0 (T8.1 fixes the fraction form). `postgres.render.time_of_day_check` has not executed yet; Introspection: Types and CHECK text
- **DIA-54** Fractional seconds — MySQL 8.4: 0 to 6 digits (1426 beyond); excess digits round; `DATETIME(6) DEFAULT CURRENT_TIMESTAMP` without `(6)` fails (1067); PostgreSQL 17: 0 to 6 digits; `timestamp(7)` becomes 6; excess digits round; SQLite: Text; `strftime('%f')` has three fraction digits; `CURRENT_TIMESTAMP` has none; Probes: `mysql.datetime.max_precision`, `mysql.datetime.fraction_rounds`, `mysql.datetime.default_precision_must_match`, `postgres.timestamp.precision_capped`, `postgres.timestamp.fraction_rounds`, `sqlite.datetime.now_is_utc`; Decision and neutral rendering: **Decision:** precision 0 to 6. Clients reject a value with a non-zero digit past the declared digits with `CODEC_ENCODE` before any statement and accept a zero there, which they drop (the conformance vector `datetime_precision_rejected`), so database rounding is never used; Introspection: MySQL `DATETIME_PRECISION`; PostgreSQL `datetime_precision`; SQLite type text
- **DIA-55** `DATETIME` / `timestamp` — MySQL 8.4: `DATETIME` keeps the written wall clock and converts a literal with an offset to the session time zone; range 0001-01-01 to 9999-12-31 accepted. `TIMESTAMP` converts between the session time zone and UTC and accepts only 1970-01-01 00:00:01 to 2038-01-19 03:14:07 UTC (1292); PostgreSQL 17: `timestamp` drops the offset of a literal; `timestamptz` stores an instant and displays it in the session time zone; 0001-01-01, 9999-12-31 and `infinity` accepted; SQLite: No type; text; Probes: `mysql.datetime.no_conversion`, `mysql.datetime.offset_literal_converted`, `mysql.datetime.range`, `mysql.timestamp.range_2038`, `mysql.timestamp.session_time_zone`, `postgres.timestamp.ignores_offset`, `postgres.timestamptz.session_time_zone`, `postgres.timestamp.range`, `mysql.render.datetime_utc_session`, `postgres.render.timestamp_utc_session`, `sqlite.render.datetime_check`; Decision and neutral rendering: **Decision:** supported as `datetime(p)`, a local date-time without a time zone from 0001-01-01 to 9999-12-31: MySQL `DATETIME(p)`, PostgreSQL `timestamp(p)`, SQLite `DATETIME` text `YYYY-MM-DD HH:MM:SS` with p fraction digits and a renderer CHECK (length, `datetime()`, hour below 24, digits). Every connection reads and writes in UTC. Instants with a time zone (MySQL `TIMESTAMP`, PostgreSQL `timestamptz`) are unsupported; Introspection: MySQL `DATA_TYPE`; PostgreSQL `atttypid` (`timestamp` versus `timestamptz`); SQLite type and CHECK text
- **DIA-56** Current time — MySQL 8.4: `CURRENT_TIMESTAMP` for `DATETIME` is the session wall clock (`+09:00` gives a value nine hours after `+00:00`); `NOW()` is the statement start; PostgreSQL 17: `now()` is the transaction start for every statement of the transaction; SQLite: `datetime('now')` and `CURRENT_TIMESTAMP` are UTC; `'now'` is stable within one statement; Probes: `mysql.current_timestamp.session_time_zone`, `mysql.now.precision_truncates`, `mysql.now.compare_six_digits`, `postgres.now.transaction_start`, `postgres.now.precision_rounds`, `postgres.now.compare_six_digits`, `sqlite.datetime.now_is_utc`; Decision and neutral rendering: **Decision:** a statement has one clock value, truncated when written and kept at six digits when compared ([protocol](protocol.md) "Clock"): MySQL writes `CURRENT_TIMESTAMP(p)`, which truncates (`mysql.now.precision_truncates`), and compares with `NOW(6)` (`mysql.now.compare_six_digits`); PostgreSQL rounds into `timestamp(p < 6)` (`postgres.now.precision_rounds`), so the client binds its `now` slot truncated to p for every clock it writes and at six digits for the `now` value function (`postgres.now.compare_six_digits`); SQLite binds the `now` slot the same way and extends a `datetime(p < 6)` column to six digits when it compares with the clock; Introspection: Default text (see defaults)

Time zone decision (owner: local date-time with a UTC connection rule):

- **DIA-57** **Definition.** `datetime(p)` is a wall-clock date-time without a time zone. The runtime rule is that every connection reads and writes it in UTC: clients set MySQL `time_zone='+00:00'` and PostgreSQL `TimeZone='UTC'` on each connection, convert a value with an offset to UTC before binding, and never send an offset literal. SQLite stores the UTC text form that clients write. A driver that returns a date-time without a zone (PyMySQL, psycopg) returns the wall clock of the connection's zone, so a client reads it in that zone and never in the local zone of its process: the result of every read and of every optimistic `updated_ts` comparison is the same whatever the process's zone. A date-time without a zone that a program passes as a bind, a naive Python `datetime` as a Rust `NaiveDateTime`, is likewise the wall clock of the connection's zone (UTC). Every client except PHP takes the process zone from `TZ`; PHP ignores `TZ` and takes it from `date.timezone`. Every check that runs database clients runs them in `TEST_TZ` of the Makefile (`Asia/Seoul`): `WITH_TEST_ENV` exports `TZ` and adds `tests/timezone/date.ini`, which sets `date.timezone` from `TZ`, to the PHP ini scan path, and the conformance checker passes `-d date.timezone` to its PHP runner. A client that reads a value as local time then fails also on a UTC machine.
- **Reasons.** The type is restored exactly from every catalog; the range 0001-01-01 to 9999-12-31 is accepted on all three databases (`mysql.datetime.range`, `postgres.timestamp.range`); under the UTC rule the clock functions agree: MySQL `NOW(6)` equals `UTC_TIMESTAMP(6)` (`mysql.render.datetime_utc_session`), PostgreSQL `CURRENT_TIMESTAMP` cast to `timestamp` equals `now() AT TIME ZONE 'UTC'` (`postgres.render.timestamp_utc_session`), and SQLite `'now'` is UTC (`sqlite.datetime.now_is_utc`). An offset literal would be converted by MySQL and dropped by PostgreSQL (`mysql.datetime.offset_literal_converted`, `postgres.timestamp.ignores_offset`), which is why clients never send one.
- **DIA-58** **Consequences.** The database does not enforce the UTC rule: a writer outside the ORM whose session uses another time zone stores a different wall clock without an error, and raw SQL must follow the same rule. Instants with a time zone are unsupported, so the 1970 to 2038 limit of MySQL `TIMESTAMP` (`mysql.timestamp.range_2038`) never applies. The rejected alternatives were instants limited to that range on every database, and a rendering of MySQL `DATETIME` with PostgreSQL `timestamptz`, which introspection cannot restore.
- **DIA-59** **Existing columns.** dbspec introspection reports a PostgreSQL `timestamptz` column as unsupported, so it is converted before the schema is introspected: `ALTER TABLE … ALTER COLUMN c TYPE timestamp(p) USING c AT TIME ZONE 'UTC'` keeps the UTC wall clock of each instant (`postgres.render.timestamptz_conversion`). A MySQL `TIMESTAMP` column converts to `DATETIME(p)` with `MODIFY` in a `+00:00` session (`mysql.render.timestamp_conversion`). There is no compatibility mapping: introspection reports a remaining `timestamptz` or `TIMESTAMP` column as unsupported.

Sources: [MySQL date and time types](https://dev.mysql.com/doc/refman/8.4/en/date-and-time-types.html), [MySQL DATETIME and TIMESTAMP](https://dev.mysql.com/doc/refman/8.4/en/datetime.html), [MySQL TIME](https://dev.mysql.com/doc/refman/8.4/en/time.html), [MySQL time zone support](https://dev.mysql.com/doc/refman/8.4/en/time-zone-support.html), [PostgreSQL date/time types](https://www.postgresql.org/docs/17/datatype-datetime.html), [PostgreSQL current date/time](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT), [SQLite date and time functions](https://www.sqlite.org/lang_datefunc.html).

### Null, defaults, identity and generated columns

- **DIA-60** NOT NULL — MySQL 8.4: An omitted NOT NULL column without default fails (1364); PostgreSQL 17: Fails (23502); SQLite: Fails; a non-INTEGER PRIMARY KEY column of a rowid table accepts NULL unless declared NOT NULL; Probes: `mysql.not_null.missing_value_rejected`, `postgres.not_null.missing_value_rejected`, `sqlite.not_null.missing_value_rejected`, `sqlite.pk.nullable_non_integer`; Decision and neutral rendering: **Decision:** supported. Primary key columns are rendered `NOT NULL` explicitly on every database; Introspection: MySQL `IS_NULLABLE`; PostgreSQL `attnotnull`; SQLite `pragma_table_info.notnull`
- **DIA-61** Literal defaults — MySQL 8.4: `COLUMN_DEFAULT` holds the literal unquoted; a `TEXT`/`BLOB` default needs `DEFAULT ('x')`, reported as `_utf8mb4\'x\'` with `DEFAULT_GENERATED`; PostgreSQL 17: `pg_get_expr` adds casts: `'x'::character varying`, `'y'::text`; SQLite: `dflt_value` is the text as written: `'x'`, `0`; Probes: `mysql.default.catalog_text`, `mysql.text.literal_default_needs_expression`, `postgres.default.catalog_text`, `sqlite.default.catalog_text`; Decision and neutral rendering: **Decision:** supported for literals of the column's neutral type. Introspection normalizes each dialect's catalog form back to the literal; MySQL `text` literals use the expression form; Introspection: MySQL `COLUMN_DEFAULT` with `EXTRA`; PostgreSQL `pg_attrdef` through `pg_get_expr`; SQLite `pragma_table_info.dflt_value`
- **DIA-62** Expression defaults — MySQL 8.4: `DEFAULT (expr)`, e.g. `(uuid())`, reported with `DEFAULT_GENERATED`; PostgreSQL 17: Any expression, normalized: `(1 + 1)`, `now()`, `CURRENT_TIMESTAMP`; SQLite: `DEFAULT (expr)` only with parentheses; text kept as written without the outer parentheses; Probes: `mysql.default.catalog_text`, `postgres.default.catalog_text`, `sqlite.default.catalog_text`, `sqlite.default.expression_needs_parentheses`; Decision and neutral rendering: **Decision:** only the clock default of the time decision is supported. Other expression defaults, including UUID generators (MySQL `uuid()`, PostgreSQL `gen_random_uuid()`, none on SQLite), are unsupported. With the binary log on, MySQL 8.4 refuses `ALTER TABLE … ADD COLUMN` with a nondeterministic default such as `(uuid())` with error 1674, also with `binlog_format=ROW`, since the statement fills the rows of the table and a replica would compute other values; `CREATE TABLE` takes it, and MariaDB 11.8 takes both; Introspection: As literal defaults
- **DIA-63** Automatic key — MySQL 8.4: `AUTO_INCREMENT` on a key column (1075 otherwise); an explicit larger key advances the counter; a rolled-back insert leaves a gap; PostgreSQL 17: `GENERATED BY DEFAULT AS IDENTITY` does not advance past an explicit key, so the next generated key collides (23505); `ALWAYS` rejects explicit keys (428C9); `serial` is a sequence default, not identity; a rollback leaves a gap; SQLite: `INTEGER PRIMARY KEY AUTOINCREMENT` only on `INTEGER PRIMARY KEY`; an explicit key advances it; a rollback leaves no gap; without `AUTOINCREMENT` the largest deleted key is reused; Probes: `mysql.auto_increment.explicit_value_advances`, `mysql.auto_increment.rollback_leaves_gap`, `mysql.auto_increment.requires_key`, `postgres.identity.by_default_not_advanced`, `postgres.identity.always_rejects_explicit`, `postgres.identity.rollback_leaves_gap`, `postgres.serial.sequence_default`, `sqlite.autoincrement.explicit_value_advances`, `sqlite.autoincrement.rollback_no_gap`, `sqlite.rowid.reused_without_autoincrement`, `sqlite.autoincrement.integer_only`; Decision and neutral rendering: **Decision:** supported as a single-column signed `i64` primary key generated when omitted: MySQL `BIGINT AUTO_INCREMENT`, PostgreSQL `bigint GENERATED BY DEFAULT AS IDENTITY`, SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`. Keys are never reused. Clients reject an explicit value for it, and an apply step that writes explicit keys on PostgreSQL resets the identity sequence to the largest key. Gaps are not part of the meaning; Introspection: MySQL `EXTRA` `auto_increment`; PostgreSQL `attidentity`/`identity_generation`; SQLite `AUTOINCREMENT` in `sqlite_master.sql` and `sqlite_sequence`
- **DIA-64** Generated columns — MySQL 8.4: `VIRTUAL` and `STORED`; expression reported normalized, e.g. ``(`a` + 1)``; explicit values fail (3105); PostgreSQL 17: `STORED` only in 17 (`VIRTUAL` 42601); `pg_get_expr` normalizes `(a + 1)`; explicit values fail (428C9); SQLite: `VIRTUAL` and `STORED`; `pragma_table_xinfo.hidden` 2 or 3 without the expression, which is only in `sqlite_master.sql`; Probes: `mysql.generated.catalog_expression`, `mysql.generated.explicit_value_rejected`, `postgres.generated.stored_only`, `postgres.generated.explicit_value_rejected`, `sqlite.generated.virtual_and_stored`, `sqlite.generated.explicit_value_rejected`; Decision and neutral rendering: **Decision:** unsupported. `VIRTUAL` does not exist on PostgreSQL 17, and a `STORED` expression needs the neutral expression set and per-dialect catalog normalization that T8.1 defines only for CHECK. No client reads the expression text of a MySQL generated column: `GENERATION_EXPRESSION` holds the UTF-8 bytes of a non-ASCII literal a second time (`cafÃ©`), and every client reports the column before it uses the text, so dbspec produces no generated column; Introspection: Reported as unsupported

Sources: [MySQL data type defaults](https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html), [MySQL AUTO_INCREMENT](https://dev.mysql.com/doc/refman/8.4/en/example-auto-increment.html), [MySQL generated columns](https://dev.mysql.com/doc/refman/8.4/en/create-table-generated-columns.html), [PostgreSQL CREATE TABLE](https://www.postgresql.org/docs/17/sql-createtable.html), [PostgreSQL generated columns](https://www.postgresql.org/docs/17/ddl-generated-columns.html), [SQLite CREATE TABLE](https://www.sqlite.org/lang_createtable.html), [SQLite AUTOINCREMENT](https://www.sqlite.org/autoinc.html), [SQLite generated columns](https://www.sqlite.org/gencol.html).

### Keys and indexes

- **DIA-65** Primary key — MySQL 8.4: The constraint name is discarded; the key is `PRIMARY`; PostgreSQL 17: The constraint name is kept; SQLite: The name is kept only in `sqlite_master.sql`; the index is `sqlite_autoindex_<table>_1`; Probes: `mysql.pk.name_is_primary`, `postgres.pk.name_kept`, `sqlite.pk.name_not_reported`; Decision and neutral rendering: **Decision:** supported without a name; PostgreSQL uses its default `<table>_pkey` and SQLite no constraint name; Introspection: MySQL `STATISTICS` index `PRIMARY`; PostgreSQL `pg_constraint` `contype='p'`; SQLite `pragma_table_info.pk`
- **DIA-66** Unique key — MySQL 8.4: Several NULLs allowed; PostgreSQL 17: Several NULLs allowed unless `NULLS NOT DISTINCT` (23505); SQLite: Several NULLs allowed; Probes: `mysql.unique.nulls_distinct`, `postgres.unique.nulls_not_distinct_option`, `sqlite.unique.nulls_distinct`; Decision and neutral rendering: **Decision:** supported with distinct NULLs; `NULLS NOT DISTINCT` unsupported; Introspection: MySQL `STATISTICS.NON_UNIQUE=0`; PostgreSQL `pg_index.indisunique` with `pg_constraint`; SQLite `pragma_index_list.unique`/`origin`
- **DIA-67** Key order — MySQL 8.4: `DESC` stored (`COLLATION` `D`); PostgreSQL 17: `DESC` stored (`pg_get_indexdef`); SQLite: `DESC` stored (`pragma_index_xinfo.desc`); Probes: `mysql.index.descending`, `postgres.index.descending_partial_expression`, `sqlite.index.descending`; Decision and neutral rendering: **Decision:** supported: ascending or descending per column, no NULLS FIRST/LAST option; Introspection: As listed
- **DIA-68** Prefix keys — MySQL 8.4: `v(10)` reported as `SUB_PART`; PostgreSQL 17: No such syntax (42883); SQLite: No such syntax; Probes: `mysql.index.prefix`, `postgres.index.prefix_rejected`; Decision and neutral rendering: **Decision:** unsupported; Introspection: MySQL `SUB_PART` reported as unsupported
- **DIA-69** Partial indexes — MySQL 8.4: None (1064); PostgreSQL 17: `WHERE` predicate (`pg_index.indpred`); SQLite: `WHERE` predicate (`pragma_index_list.partial`, text in `sqlite_master.sql`); Probes: `mysql.index.partial_rejected`, `postgres.index.descending_partial_expression`, `sqlite.index.partial_expression`; Decision and neutral rendering: **Decision:** unsupported; Introspection: Reported as unsupported
- **DIA-70** Expression indexes — MySQL 8.4: Functional key parts: `COLUMN_NAME` NULL, normalized `EXPRESSION`; MariaDB 11.8: no functional key part (1064), so `COLUMN_NAME` is never NULL, and `STATISTICS` has no `EXPRESSION` column (1054); PostgreSQL 17: Expression keys (`pg_index.indkey` 0); SQLite: Expression keys (`pragma_index_info.cid` -2, name NULL); Probes: `mysql.index.functional`, `mariadb.index.functional`, `postgres.index.descending_partial_expression`, `sqlite.index.partial_expression`; Decision and neutral rendering: **Decision:** unsupported, for the reason given for generated columns; Introspection: Reported as unsupported; a key part is functional when its `COLUMN_NAME` is NULL, the one form that both MySQL and MariaDB read with the same result (DIA-200, rule 1). MariaDB refuses the statement of the vector `mysql-functional-index` (1064), so the case `mysql_functional_index` of the recipe dbspec_introspect states that refusal as its `mariadb` result, the answer of the server (DIA-200, rule 4)
- **DIA-71** Full-text indexes — MySQL 8.4: `FULLTEXT` index; PostgreSQL 17: No such index; GIN over a `to_tsvector` expression; SQLite: FTS5 virtual tables only; Probes: (manual); Decision and neutral rendering: **Decision:** unsupported: SQLite has no full-text index on a table, and the PostgreSQL form is an expression index; Introspection: Reported as unsupported
- **DIA-72** Key length — MySQL 8.4: An index key is at most 3072 bytes: utf8mb4 `varchar(768)` accepted, `varchar(769)` rejected (1071); PostgreSQL 17: A B-tree entry over 2704 bytes fails at insert (54000); 640 four-byte characters fit; SQLite: No limit; Probes: `mysql.index.max_key_bytes`, `postgres.index.btree_entry_limit`, `postgres.index.varchar_640_four_byte_fits`; Decision and neutral rendering: **Decision:** the declared lengths of the `varchar` columns of one index total at most 640 characters, which is 2560 bytes in utf8mb4 and within both limits. `postgres.index.varchar_640_four_byte_fits` has not executed yet; Introspection: Not applicable
- **DIA-73** Index and unique names — MySQL 8.4: Index names are scoped to the table; at most 64 characters (1059); `PRIMARY` is reserved (1280); PostgreSQL 17: Index and unique constraint names share the schema namespace (42P07); SQLite: Index names are unique in the database; Probes: `mysql.index.name_table_scope`, `mysql.index.name_max_length`, `mysql.index.primary_name_reserved`, `postgres.index.name_schema_scope`, `postgres.unique.name_schema_scope`, `sqlite.index.name_database_scope`; Decision and neutral rendering: **Decision:** names follow the identifier rule below and are unique in the whole schema across indexes and unique keys; `primary` is not a valid name; Introspection: MySQL `STATISTICS.INDEX_NAME`; PostgreSQL `pg_class` of the index; SQLite `pragma_index_list.name`

Sources: [MySQL CREATE INDEX](https://dev.mysql.com/doc/refman/8.4/en/create-index.html), [MySQL InnoDB limits](https://dev.mysql.com/doc/refman/8.4/en/innodb-limits.html), [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html), [PostgreSQL partial indexes](https://www.postgresql.org/docs/17/indexes-partial.html), [PostgreSQL unique indexes](https://www.postgresql.org/docs/17/indexes-unique.html), [SQLite CREATE INDEX](https://www.sqlite.org/lang_createindex.html), [SQLite partial indexes](https://www.sqlite.org/partialindex.html), [SQLite expression indexes](https://www.sqlite.org/expridx.html), [SQLite FTS5](https://www.sqlite.org/fts5.html).

### Foreign keys

- **DIA-74** Actions — MySQL 8.4: `RESTRICT`, `NO ACTION` (both immediate), `CASCADE`, `SET NULL`; the catalog reports an omitted action as `NO ACTION` and a written one as written; PostgreSQL 17: All actions; `NO ACTION` is checked at statement end, `RESTRICT` immediately; SQLite: All actions; `NO ACTION` at statement end, `RESTRICT` immediately; Probes: `mysql.fk.rule_catalog`, `mysql.fk.restrict_row_order`, `sqlite.fk.restrict_row_order`, `postgres.fk.restrict_statement_end`; Decision and neutral rendering: **Decision:** supported for delete and update: `restrict`, `cascade`, `set_null`, rendered with the explicit keywords `RESTRICT`, `CASCADE`, `SET NULL`. `NO ACTION` is unsupported because MySQL checks it immediately. One `DELETE` that removes a referenced row and a row referencing it is refused by MySQL and SQLite when the referenced row comes first in their row order and accepted by PostgreSQL; portable code deletes the referencing rows first.; Introspection: MySQL `REFERENTIAL_CONSTRAINTS.UPDATE_RULE`/`DELETE_RULE`; PostgreSQL `pg_constraint.confupdtype`/`confdeltype`; SQLite `pragma_foreign_key_list.on_update`/`on_delete`
- **DIA-75** `SET DEFAULT` — MySQL 8.4: Accepted and recorded, but the parent delete fails (1451); MariaDB 11.8: InnoDB accepts `SET DEFAULT`, records it as `RESTRICT` in `REFERENTIAL_CONSTRAINTS` and rejects the parent delete (1451); PostgreSQL 17: Supported; SQLite: Supported; Probes: `mysql.fk.set_default_acts_as_restrict`, `mariadb.fk.set_default_acts_as_restrict`, `postgres.fk.set_default`; Decision and neutral rendering: **Decision:** unsupported; Introspection: Reported as unsupported; MariaDB keeps no `SET DEFAULT` to read, so its introspection reads the `restrict` key that the server recorded, and the vector `mysql-fk-set-default` of `tests/dbspec/introspect.json` states that key and no unsupported object as its `mariadb` result (DIA-200, rule 4)
- **DIA-76** Deferrable — MySQL 8.4: None (1064); PostgreSQL 17: `DEFERRABLE INITIALLY DEFERRED` checked at COMMIT (23503); SQLite: Same; Probes: `mysql.fk.deferrable_rejected`, `postgres.fk.deferrable`, `sqlite.fk.deferrable`; Decision and neutral rendering: **Decision:** unsupported. Cycles are created with nullable columns and a later update; Introspection: Reported as unsupported
- **DIA-77** `MATCH` — MySQL 8.4: `MATCH FULL` recorded as `MATCH_OPTION FULL`, omitted by `SHOW CREATE TABLE` and not enforced; PostgreSQL 17: `MATCH FULL` rejects a partly NULL key (23503); SQLite: Accepted, reported as `NONE`, not enforced; Probes: `mysql.fk.match_full_not_enforced`, `postgres.fk.match_full`, `sqlite.fk.match_not_enforced`; Decision and neutral rendering: **Decision:** only the default `MATCH SIMPLE` is supported; Introspection: MySQL `MATCH_OPTION`; PostgreSQL `confmatchtype`; SQLite `pragma_foreign_key_list.match`
- **DIA-78** Enforcement switch — MySQL 8.4: Always on; PostgreSQL 17: Always on; SQLite: Off until `PRAGMA foreign_keys = ON` on each connection; ignored inside a transaction; Probes: `sqlite.fk.off_by_default`, `sqlite.fk.pragma_ignored_in_transaction`; Decision and neutral rendering: **Decision:** supported with the rule that every SQLite connection enables `foreign_keys` before its first transaction (the Go DSN pragma, PHP `PRAGMA`, Node `node:sqlite` and sqlx defaults enable it); Introspection: `PRAGMA foreign_keys` per connection
- **DIA-79** Child index — MySQL 8.4: Creates an index on the child columns, named after the constraint; PostgreSQL 17: None; SQLite: None; Probes: `mysql.fk.child_index_created`, `postgres.fk.no_child_index`; Decision and neutral rendering: **Decision:** a foreign key requires an explicitly declared index whose leading columns are its child columns; MySQL then uses it and creates none; Introspection: Index catalogs
- **DIA-80** Column types — MySQL 8.4: Child and parent types must match (3780); PostgreSQL 17: `integer` may reference `bigint`; SQLite: Not checked; Probes: `mysql.fk.type_mismatch_rejected`, `postgres.fk.type_mismatch_allowed`; Decision and neutral rendering: **Decision:** child column types equal the referenced column types; Introspection: Column catalogs
- **DIA-81** Names — MySQL 8.4: Unique in the database (1826); PostgreSQL 17: Scoped to the table; SQLite: Not reported by `pragma_foreign_key_list`; kept in `sqlite_master.sql`; Probes: `mysql.fk.name_schema_scope`, `sqlite.fk.names_not_reported`; Decision and neutral rendering: **Decision:** named and unique in the whole schema; SQLite introspection reads the name from the `CREATE TABLE` text; Introspection: MySQL `REFERENTIAL_CONSTRAINTS.CONSTRAINT_NAME`; PostgreSQL `pg_constraint.conname`; SQLite `sqlite_master.sql`
- **DIA-82** Triggers on cascaded rows — MySQL 8.4: Not fired for rows changed by a cascade; PostgreSQL 17: Fired; SQLite: Fired; Probes: `mysql.fk.cascade_skips_triggers`, `postgres.fk.cascade_fires_triggers`, `sqlite.fk.cascade_fires_triggers`; Decision and neutral rendering: See triggers; Introspection: Not applicable

Sources: [MySQL FOREIGN KEY constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html), [PostgreSQL foreign keys](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK), [SQLite foreign key support](https://www.sqlite.org/foreignkeys.html), [SQLite PRAGMA foreign_keys](https://www.sqlite.org/pragma.html#pragma_foreign_keys).

### CHECK constraints

- **DIA-83** Enforcement — MySQL 8.4: Enforced (3819); NULL passes; `NOT ENFORCED` stores an unchecked constraint; PostgreSQL 17: Enforced (23514); NULL passes; `NOT VALID` keeps violating rows; SQLite: Enforced; NULL passes; Probes: `mysql.check.enforced_null_passes`, `mysql.check.not_enforced_option`, `postgres.check.enforced_null_passes`, `postgres.check.not_valid`, `sqlite.check.enforced_null_passes`; Decision and neutral rendering: **Decision:** supported for enforced and validated constraints; `NOT ENFORCED` and `NOT VALID` unsupported; Introspection: MySQL `TABLE_CONSTRAINTS.ENFORCED`; PostgreSQL `convalidated`
- **DIA-84** Expression text — MySQL 8.4: `CHECK_CLAUSE` is normalized: ``(`a` in (1,2))``, string literals with `_utf8mb4` introducers and escaped twice, `NOT` written into the comparisons it negates (De Morgan), `BETWEEN` kept, a negative literal as `-(n)`; a bool column alone is rejected (3812); PostgreSQL 17: `pg_get_constraintdef` rewrites `IN` as `= ANY (ARRAY[...])` with casts, `BETWEEN` as two comparisons and `NOT BETWEEN` as their negation, and keeps `NOT`; SQLite: Kept only as written in `sqlite_master.sql`; Probes: `mysql.check.catalog_text`, `mysql.check.alter_rewrites_introducers`, `mysql.check.alter_writes_time_precision`, `mysql.check.not_pushed_down`, `mysql.check.between_kept`, `mysql.check.string_escaped_twice`, `mysql.check.bool_column_rejected`, `postgres.check.normalized_text`, `postgres.check.between_rewritten`, `postgres.check.not_kept`, `sqlite.check.text_verbatim`; Decision and neutral rendering: **Decision:** supported for the predicate forms of [dbspec](dbspec.md#checks), which leave out `not`, `between` and a column alone because MySQL or PostgreSQL rewrites or rejects them. The renderer writes each dialect's text, and introspection accepts a constraint only when the catalog text equals that dialect's normalized form of the rendered expression. MySQL 8.4 writes a `CHECK_CLAUSE` that holds a non-ASCII literal with its UTF-8 bytes encoded a second time, so introspection reads such a constraint's body from `SHOW CREATE TABLE`, which writes it correctly, and escapes it as `CHECK_CLAUSE` does; Introspection: MySQL `CHECK_CONSTRAINTS.CHECK_CLAUSE`; PostgreSQL `pg_get_constraintdef`; SQLite `sqlite_master.sql`
- **DIA-85** Nondeterministic functions — MySQL 8.4: Rejected at DDL (3814); PostgreSQL 17: Allowed; SQLite: Rejected when evaluated; Probes: `mysql.check.nondeterministic_rejected`, `postgres.check.nondeterministic_allowed`, `sqlite.check.nondeterministic_rejected`; Decision and neutral rendering: **Decision:** the neutral expression set has no clock, random or session functions; Introspection: Not applicable
- **DIA-86** Columns of FK actions — MySQL 8.4: A column of a foreign key with a referential action cannot appear in a CHECK (3823); PostgreSQL 17: Allowed; SQLite: Allowed; Probes: `mysql.check.fk_action_column_rejected`; Decision and neutral rendering: **Decision:** dbspec rejects a CHECK that uses a column of a foreign key with `cascade` or `set_null`; Introspection: Not applicable
- **DIA-87** Fault order — MySQL 8.4: A row that breaks a CHECK and a unique key is refused with the CHECK fault (3819); a foreign key is checked per row, so one `INSERT` whose first row references its second row is refused (1452); PostgreSQL 17: The CHECK fault (23514); a foreign key is checked at the end of the statement, so that `INSERT` is accepted; SQLite: The CHECK fault; a foreign key is checked at the end of the statement, so that `INSERT` is accepted; Probes: `mysql.fault.check_before_unique`, `mysql.fault.fk_statement_end`, `postgres.fault.check_before_unique`, `postgres.fault.fk_statement_end`, `sqlite.fault.check_before_unique`, `sqlite.fault.fk_statement_end`; Decision and neutral rendering: **Decision:** a statement with several faults reports a row's CHECK fault before its key fault on every database; PostgreSQL and SQLite report foreign keys at the end of the statement and MySQL per row. A SQL statement reports one error; an executor that lists several faults orders them by this rule; Introspection: Not applicable
- **DIA-88** Names — MySQL 8.4: Unique in the database (3822); PostgreSQL 17: Scoped to the table; SQLite: Not checked; two constraints of one table may share a name; Probes: `mysql.check.name_schema_scope`, `postgres.check.name_table_scope`, `sqlite.constraint.duplicate_names_accepted`; Decision and neutral rendering: **Decision:** named and unique in the whole schema; Introspection: As expression text

Sources: [MySQL CHECK constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html), [PostgreSQL check constraints](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS), [PostgreSQL catalog information functions](https://www.postgresql.org/docs/17/functions-info.html), [SQLite CREATE TABLE CHECK](https://www.sqlite.org/lang_createtable.html#ckconst), [SQLite deterministic functions](https://www.sqlite.org/deterministic.html).

### Comments, collation and identifiers

- **DIA-89** Comments — MySQL 8.4: `COMMENT` clauses: column at most 1024 characters (1629), table at most 2048 (1628); PostgreSQL 17: `COMMENT ON` without a practical limit (5000 characters stored); SQLite: No comment object; SQL comments stay inside the `CREATE TABLE` text; Probes: `mysql.comment.column_limit`, `mysql.comment.table_limit`, `postgres.comment.unlimited`, `sqlite.comment.no_object`; Decision and neutral rendering: **Decision:** unsupported as a physical object. SQLite can keep a comment only in an ORM-owned table or inside the DDL text, both of which are markers. Descriptions stay in the dbspec document and are not rendered; Introspection: MySQL and PostgreSQL comments are reported as unsupported
- **DIA-90** Collation — MySQL 8.4: The default utf8mb4 collation `utf8mb4_0900_ai_ci` makes `a`, `A` and `á` equal in a unique key (1062); `utf8mb4_bin` is PAD SPACE (`a` = `a `); `utf8mb4_0900_bin` is NO PAD and orders by code point; PostgreSQL 17: Database collation `C` here: case, accent and space sensitive, code point order; columns may declare `COLLATE "C"`; SQLite: `BINARY` default: byte order; `NOCASE` folds ASCII only; Probes: `mysql.collation.default_accent_case_insensitive`, `mysql.collation.utf8mb4_bin_pads`, `mysql.collation.utf8mb4_0900_bin_codepoint`, `postgres.collation.c_codepoint`, `sqlite.collation.binary_codepoint`, `sqlite.collation.nocase_ascii_only`; Decision and neutral rendering: **Decision:** one collation, binary code point order: MySQL `CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`, PostgreSQL `COLLATE "C"` on every text column (independent of the database default), SQLite `BINARY`. Other collations are unsupported. The `COLLATE "C"` column catalog assertion in `postgres.collation.c_codepoint` has not executed yet; Introspection: MySQL `COLUMNS.COLLATION_NAME`; PostgreSQL `pg_attribute.attcollation`; SQLite `COLLATE` in `sqlite_master.sql`
- **DIA-91** Identifier length — MySQL 8.4: At most 64 characters (1059); PostgreSQL 17: Longer names are truncated to 63 bytes with a notice; names equal in 63 bytes collide (42P07); SQLite: No limit; Probes: `mysql.ident.max_length`, `mysql.index.name_max_length`, `postgres.ident.truncated_to_63`, `sqlite.ident.no_length_limit`; Decision and neutral rendering: **Decision:** names match `[a-z][a-z0-9_]*` and are at most 63 bytes. A longer name is rejected, never shortened or rewritten; Introspection: Names as stored
- **DIA-92** Identifier case — MySQL 8.4: Column names case-insensitive (1060); table names follow `lower_case_table_names` (1 on the test servers of both platforms, which `make orm-test-servers` declares: `Foo` is stored as `foo`, and `Foo` and `foo` collide, 1050); PostgreSQL 17: Unquoted names fold to lower case (42701); quoted names are case-sensitive; SQLite: Case-insensitive; Probes: `mysql.ident.column_case_insensitive`, `mysql.ident.table_case_server_setting`, `postgres.ident.case_folding`, `sqlite.ident.case_insensitive`; Decision and neutral rendering: **Decision:** lower-case names only, so every folding rule gives the same name; Introspection: Names as stored
- **DIA-93** Name scopes — MySQL 8.4: Index: table; CHECK, FK, trigger: database; PostgreSQL 17: Index, unique constraint: schema; CHECK, FK, trigger: table; SQLite: Index, trigger: database; constraints: not checked; Probes: `mysql.index.name_table_scope`, `mysql.check.name_schema_scope`, `mysql.fk.name_schema_scope`, `mysql.trigger.name_schema_scope`, `postgres.index.name_schema_scope`, `postgres.check.name_table_scope`, `postgres.trigger.name_table_scope`, `sqlite.index.name_database_scope`, `sqlite.trigger.name_database_scope`; Decision and neutral rendering: **Decision:** every index, constraint and trigger name is unique in the whole schema; Introspection: Not applicable
- **DIA-94** Namespaces — MySQL 8.4: A schema is a database; PostgreSQL 17: Schemas inside a database; a table name is unique per schema; SQLite: A qualified name refers to an attached database of the connection; Probes: `postgres.namespace.relname_per_schema`, `sqlite.namespace.attached_databases`; Decision and neutral rendering: **Decision:** schema-qualified names are unsupported. One dbspec document is the connection's current database or schema; Introspection: MySQL `DATABASE()`; PostgreSQL `current_schema()`; SQLite `main`

Sources: [MySQL CREATE TABLE](https://dev.mysql.com/doc/refman/8.4/en/create-table.html), [MySQL collations](https://dev.mysql.com/doc/refman/8.4/en/charset-collation-names.html), [MySQL pad attribute](https://dev.mysql.com/doc/refman/8.4/en/charset-binary-collations.html), [MySQL identifier length](https://dev.mysql.com/doc/refman/8.4/en/identifier-length.html), [MySQL identifier case](https://dev.mysql.com/doc/refman/8.4/en/identifier-case-sensitivity.html), [PostgreSQL COMMENT](https://www.postgresql.org/docs/17/sql-comment.html), [PostgreSQL collation](https://www.postgresql.org/docs/17/collation.html), [PostgreSQL identifiers](https://www.postgresql.org/docs/17/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS), [SQLite collating sequences](https://www.sqlite.org/datatype3.html#collation), [SQLite ATTACH](https://www.sqlite.org/lang_attach.html).

### Update-time stamping

- **DIA-95** Column clause — MySQL 8.4: `ON UPDATE CURRENT_TIMESTAMP` fires when another column changes, not when no value changes, and an explicit value wins; PostgreSQL 17: No such clause (42601); SQLite: No such clause; Probes: `mysql.on_update.fires_on_change`, `mysql.on_update.skipped_when_unchanged`, `mysql.on_update.explicit_value_kept`, `postgres.on_update.unsupported`, `sqlite.on_update.unsupported`; Decision and neutral rendering: **Decision:** the column clause is unsupported: it exists on MySQL only; Introspection: MySQL `EXTRA` `on update …` reported as unsupported
- **DIA-96** Trigger — MySQL 8.4: A `BEFORE UPDATE` row trigger can assign `NEW` and fires when no value changes; PostgreSQL 17: A `BEFORE UPDATE` row trigger with a function can assign `NEW` and fires when no value changes; SQLite: `NEW` cannot be assigned; an `AFTER UPDATE` trigger runs a separate `UPDATE` and fires when no value changes; Probes: `mysql.trigger.new_assignable`, `mysql.trigger.update_fires_when_unchanged`, `postgres.trigger.update_fires_when_unchanged`, `sqlite.trigger.new_read_only`; Decision and neutral rendering: **Decision:** no trigger is rendered for stamping; see below; Introspection: Not applicable

Update-time stamping decision (owner: executor stamping):

- **DIA-97** **Definition.** Update-time stamping is an ORM mapping setting of a table column. The executor assigns the column explicitly on every `UPDATE` it plans, with the UTC statement time. Nothing physical is created: no trigger, no `ON UPDATE` clause and no default change. The setting belongs to `manifestHash`, not to `schemaHash`, and introspection neither reads nor produces it.
- **Reasons.** The executor writes the same value on the three databases, and the column definition stays an ordinary `datetime(p)` that introspection restores exactly. MySQL `ON UPDATE CURRENT_TIMESTAMP` stays unsupported: it exists on MySQL only and skips an update that changes no value (`mysql.on_update.skipped_when_unchanged`), unlike the executor.
- **DIA-98** **Consequences.** Raw SQL and writers outside the ORM do not stamp the column. Trigger stamping was rejected: it needs MySQL `SUPER` or `log_bin_trust_function_creators=ON` (`mysql.trigger.binlog_privilege_1419`), a PostgreSQL function object, and a second write per row on SQLite (`sqlite.trigger.new_read_only`).

### Triggers and audit context

- **DIA-99** Levels and events — MySQL 8.4: Row triggers only (1064 for `FOR EACH STATEMENT`); `INSERT`/`UPDATE`/`DELETE`; PostgreSQL 17: Row and statement triggers; also `TRUNCATE`; SQLite: Row triggers only; Probes: `mysql.trigger.no_statement_level`, `postgres.trigger.statement_fires_on_zero_rows`, `sqlite.trigger.no_statement_level`; Decision and neutral rendering: **Decision:** generated triggers are row triggers for `INSERT`, `UPDATE`, `DELETE`; Introspection: MySQL `TRIGGERS.ACTION_TIMING`/`EVENT_MANIPULATION`/`ACTION_ORIENTATION`; PostgreSQL `pg_trigger.tgtype`; SQLite `sqlite_master.sql`
- **DIA-100** Zero-row statements — MySQL 8.4: Not fired; PostgreSQL 17: A statement trigger fires for an `UPDATE` that matches no row (P0001); a row trigger does not; SQLite: Not fired; Probes: `mysql.trigger.zero_rows_not_fired`, `postgres.trigger.statement_fires_on_zero_rows`, `postgres.trigger.row_skips_zero_rows`, `sqlite.trigger.zero_rows_not_fired`; Decision and neutral rendering: **Decision:** row triggers only, so a statement that matches no row never fails; Introspection: Not applicable
- **DIA-101** `TRUNCATE` — MySQL 8.4: No trigger event (1064); `TRUNCATE TABLE` skips `DELETE` triggers; PostgreSQL 17: `BEFORE TRUNCATE` statement trigger fires; SQLite: No `TRUNCATE`; `DELETE` without `WHERE` fires row triggers; Probes: `mysql.trigger.no_truncate_event`, `mysql.trigger.truncate_skips_delete_trigger`, `postgres.trigger.truncate_event`, `sqlite.trigger.delete_all_fires_row_triggers`; Decision and neutral rendering: **Decision:** generated triggers do not cover `TRUNCATE` on any database. `immutable` and `audit` guarantee row `UPDATE` and `DELETE` only, and `TRUNCATE` remains a privileged operation outside the guarantee; Introspection: Not applicable
- **DIA-102** Cascaded rows — MySQL 8.4: Triggers do not fire for rows changed by a foreign key action; PostgreSQL 17: Fire; SQLite: Fire; Probes: `mysql.fk.cascade_skips_triggers`, `postgres.fk.cascade_fires_triggers`, `sqlite.fk.cascade_fires_triggers`; Decision and neutral rendering: **Decision:** an `audit` or `immutable` setting is rejected on a table that is the child of a foreign key with `cascade` or `set_null`, so the same row changes are observed on every database; Introspection: Not applicable
- **DIA-103** Privileges — MySQL 8.4: With binary logging and `log_bin_trust_function_creators=0`, a login without `SUPER` cannot create a trigger (1419); PostgreSQL 17: `TRIGGER` privilege on the table and `EXECUTE` on the function; SQLite: No privileges; Probes: `mysql.trigger.binlog_privilege_1419`; Decision and neutral rendering: **Decision:** apply checks the privilege before the first trigger statement and fails with the required setting; Introspection: MySQL `@@log_bin`, `@@log_bin_trust_function_creators`
- **DIA-104** Trigger body object — MySQL 8.4: Body inside the trigger; PostgreSQL 17: Body is a separate function in `pg_proc` that remains after `DROP TABLE`; SQLite: Body inside the trigger; `DROP TABLE` drops its triggers; Probes: `postgres.trigger.function_separate_object`, `sqlite.trigger.dropped_with_table`; Decision and neutral rendering: **Decision:** the renderer owns one function per generated PostgreSQL trigger; diff and apply create and drop the function with its trigger; Introspection: PostgreSQL `pg_proc`
- **DIA-105** `NEW` assignment — MySQL 8.4: Allowed in `BEFORE` triggers; PostgreSQL 17: Allowed in `BEFORE` row triggers; SQLite: Not allowed; Probes: `mysql.trigger.new_assignable`, `postgres.trigger.update_fires_when_unchanged`, `sqlite.trigger.new_read_only`; Decision and neutral rendering: Fact for update-time stamping; Introspection: Not applicable
- **DIA-106** Catalog text — MySQL 8.4: `ACTION_STATEMENT` is the body exactly as written, comments included; PostgreSQL 17: `prosrc` is the function body as written; `pg_get_triggerdef` returns normalized text with the table qualified by its schema; SQLite: `sqlite_master.sql` is the `CREATE TRIGGER` text as written; Probes: `mysql.trigger.body_catalog_verbatim`, `postgres.trigger.catalog_text`, `sqlite.trigger.catalog_verbatim`; Decision and neutral rendering: **Decision:** a generated trigger is restored only when the catalog text equals the declared renderer version's output: MySQL timing, event and body; PostgreSQL `pg_get_triggerdef` and `prosrc`; SQLite the full text. Comment markers are not used; Introspection: As listed
- **DIA-107** Names — MySQL 8.4: Unique in the database (1359); PostgreSQL 17: Scoped to the table; SQLite: Unique in the database; Probes: `mysql.trigger.name_schema_scope`, `postgres.trigger.name_table_scope`, `sqlite.trigger.name_database_scope`; Decision and neutral rendering: **Decision:** generated names are at most 63 bytes by the rule of [dbspec names](dbspec.md#names) (the plain form, or its first 54 bytes, a `$` and 8 hexadecimal digits of its SHA-256), so no table is rejected for the length of a generated name; a generated name equal to another generated or declared name is a `name.duplicate` error that names both sources; declared names longer than 63 bytes are still rejected; Introspection: As listed

Audit context options. The audit triggers read the audit of the unit of work that the client sets inside the transaction:

- **PostgreSQL** `set_config('<setting>', id, true)` is local to the transaction; after `COMMIT` the setting reads as an empty string in the same session and NULL in a session that never set it (`postgres.context.set_config_local`).
- **MySQL** user variables are session-scoped and survive `COMMIT` (`mysql.context.user_variable_session_scope`); a pooled connection keeps the value unless the client clears it.
- **SQLite** has no session variable. A trigger of a main table can be created over a `TEMP` table but fails when it fires (`sqlite.context.temp_table_not_visible`); a row in a main table is visible to every connection after `COMMIT` (`sqlite.context.main_table_shared`).

The options are (1) these per-database mechanisms with the rule that the client sets the id inside the transaction and clears it at the end of the transaction on MySQL and SQLite, or (2) an audit column written by the executor in each audited row, which changes the table definition.

- **DIA-108** **Decision:** neither channel. The audited row carries its own audit column with the key of an audit record, which the transaction inserts and the executor writes on every `INSERT` and `UPDATE`, so a row trigger reads the changing audit record from `NEW` and the previous one from `OLD` on every database. Generated triggers copy the row column by column into a history table instead of serializing it as JSON, and an audited table deletes only through its soft delete column, because `OLD` of a physical `DELETE` names the previous audit record rather than the deleting one. The session variable, the transaction setting and the `orm__context` table are not used. The definition is in [dbspec](dbspec.md#audit).

Sources: [MySQL trigger syntax](https://dev.mysql.com/doc/refman/8.4/en/trigger-syntax.html), [MySQL stored program binary logging](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html), [MySQL FOREIGN KEY and triggers](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html), [MySQL user variables](https://dev.mysql.com/doc/refman/8.4/en/user-variables.html), [PostgreSQL CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html), [PostgreSQL trigger functions](https://www.postgresql.org/docs/17/plpgsql-trigger.html), [PostgreSQL set_config](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET), [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html), [SQLite DELETE](https://www.sqlite.org/lang_delete.html).

### DDL transactions, views and sequences

- **DIA-109** DDL in transactions — MySQL 8.4: DDL commits the open transaction; one statement is atomic (a failed `DROP TABLE a, missing` drops nothing, 1051); PostgreSQL 17: DDL is transactional; `CREATE INDEX CONCURRENTLY` cannot run in a transaction (25001); SQLite: DDL is transactional; `ALTER TABLE` cannot change a column, and `ADD COLUMN` rejects a non-constant default; Probes: `mysql.ddl.implicit_commit`, `mysql.ddl.atomic_statement`, `postgres.ddl.transactional`, `postgres.ddl.concurrent_index_outside_transaction`, `sqlite.ddl.transactional`, `sqlite.alter.limited`; Decision and neutral rendering: **Decision:** no feature depends on transactional DDL. Apply journals each statement, and SQLite column changes rebuild the table; Introspection: Not applicable
- **DIA-110** Views — MySQL 8.4: `VIEW_DEFINITION` is rewritten with database-qualified names and aliases; PostgreSQL 17: `pg_get_viewdef` returns normalized text; SQLite: `sqlite_master.sql` keeps the text as written; Probes: `mysql.view.definition_rewritten`, `postgres.view.definition_normalized`, `sqlite.view.text_verbatim`; Decision and neutral rendering: **Decision:** unsupported: a view body is a dialect query without a neutral form; Introspection: Reported as unsupported
- **DIA-111** Sequences — MySQL 8.4: None (1064); PostgreSQL 17: `CREATE SEQUENCE`; SQLite: None; Probes: `mysql.sequence.unsupported`, `postgres.sequence.object`, `sqlite.sequence.unsupported`; Decision and neutral rendering: **Decision:** unsupported; the automatic key is the only generated number; Introspection: Reported as unsupported
- **DIA-112** Other objects — MySQL 8.4: Partitions, events, procedures, engines; PostgreSQL 17: Functions, types, extensions, partitions; SQLite: Virtual tables, `WITHOUT ROWID`; Probes: (manual); Decision and neutral rendering: **Decision:** unsupported, except the functions the renderer owns for its triggers; Introspection: Reported as unsupported

Sources: [MySQL implicit commit](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html), [MySQL atomic DDL](https://dev.mysql.com/doc/refman/8.4/en/atomic-ddl.html), [PostgreSQL CREATE INDEX CONCURRENTLY](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY), [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html), [MySQL CREATE VIEW](https://dev.mysql.com/doc/refman/8.4/en/create-view.html), [PostgreSQL CREATE SEQUENCE](https://www.postgresql.org/docs/17/sql-createsequence.html).

### Catalog sources

| Object | MySQL 8.4 | PostgreSQL 17 | SQLite |
|---|---|---|---|
| Tables | `information_schema.TABLES` (`TABLE_TYPE='BASE TABLE'`, `TABLE_COLLATION`, `TABLE_COMMENT`) | `pg_class` (`relkind='r'`) joined to `pg_namespace` by `relnamespace` | `sqlite_master` (`type='table'`) |
| Columns | `information_schema.COLUMNS` (`COLUMN_TYPE`, `IS_NULLABLE`, `COLUMN_DEFAULT`, `EXTRA`, `GENERATION_EXPRESSION`, `COLLATION_NAME`) | `pg_attribute`, `format_type`, `pg_attrdef` through `pg_get_expr`, `attidentity`, `attgenerated`, `attcollation` | `pragma_table_xinfo`, plus `sqlite_master.sql` for `AUTOINCREMENT`, `COLLATE` and constraint names |
| Primary and unique keys, indexes | `information_schema.STATISTICS` (`INDEX_NAME`, `NON_UNIQUE`, `SEQ_IN_INDEX`, `COLLATION`, `SUB_PART`, `EXPRESSION`), `TABLE_CONSTRAINTS` | `pg_index` (`indkey`, `indoption`, `indpred`), `pg_get_indexdef`, `pg_constraint` | `pragma_index_list`, `pragma_index_xinfo`, `sqlite_master.sql` |
| Foreign keys | `REFERENTIAL_CONSTRAINTS`, `KEY_COLUMN_USAGE` | `pg_constraint` (`contype='f'`, `conkey`, `confkey`, `confupdtype`, `confdeltype`, `confmatchtype`, `condeferrable`) | `pragma_foreign_key_list`, `sqlite_master.sql` for names |
| CHECK | `CHECK_CONSTRAINTS.CHECK_CLAUSE`, `TABLE_CONSTRAINTS.ENFORCED` | `pg_constraint` (`contype='c'`), `pg_get_constraintdef`, `convalidated` | `sqlite_master.sql` |
| Triggers | `information_schema.TRIGGERS` (`ACTION_TIMING`, `EVENT_MANIPULATION`, `ACTION_ORIENTATION`, `ACTION_STATEMENT`) | `pg_trigger` (`tgtype`, `tgfoid`), `pg_get_triggerdef`, `pg_proc.prosrc` | `sqlite_master` (`type='trigger'`) |
| Comments | `COLUMNS.COLUMN_COMMENT`, `TABLES.TABLE_COMMENT` | `pg_description` (`col_description`, `obj_description`) | None |
| Sequences and counters | `TABLES.AUTO_INCREMENT` | `pg_sequences`, `pg_get_serial_sequence` | `sqlite_sequence` |

## Rendered statements

- **DIA-113** The renderer turns a dbspec document set into the statements of one dialect; an invalid set returns its diagnostics instead ([manifest and hashes](dbspec.md#manifest-and-hashes)). `tests/dbspec/ddl.json` lists the exact statements for every rendered form and is the normative text; this section states the rules behind it. Every vector of that file is applied to MySQL 8.4, PostgreSQL 17 and SQLite by `make dbspec-ddl-check`.

### Statements and their order

- **DIA-114** Documents are rendered in `use` order (a used document before the document that uses it, ties by document name), and the tables of a document in document order. A used table is rendered once, by its own document.
- **DIA-115** Every identifier is quoted: MySQL backticks, PostgreSQL and SQLite double quotes. Keywords are upper case and every statement is one line without a final semicolon.
- **DIA-116** For each table: one `CREATE TABLE`; on SQLite then one `CREATE UNIQUE INDEX` per unique key; then one `CREATE INDEX` per index, in name order.
- **DIA-117** After every table: on MySQL and PostgreSQL one `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` per foreign key, tables in order and keys in name order; SQLite writes foreign keys inside `CREATE TABLE`, where a later table may be referenced.
- **DIA-118** Last, the triggers of `immutable` and `audit`, tables in order; a PostgreSQL trigger follows the `CREATE FUNCTION` it executes.

### Inside `CREATE TABLE`

- **DIA-119** The parts come in this order: columns in declared order; the primary key; on MySQL and PostgreSQL the unique keys as named `UNIQUE` constraints in name order; on SQLite the foreign keys in name order; the renderer CHECKs in column order; the declared checks in name order. MySQL ends the statement with `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`.

- **DIA-120** A column is written as its name, its type, `NOT NULL` or `NULL`, then its default:

| dbspec | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `i16`, `i32`, `i64` | `SMALLINT`, `INT`, `BIGINT` | `smallint`, `integer`, `bigint` | `smallint`, `integer`, `bigint` |
| `bool` | `tinyint(1)` | `boolean` | `BOOLEAN` |
| `decimal(p,s)` | `DECIMAL(p,s)` | `numeric(p,s)` | `DECIMALINT(p,s)` |
| `f64` | `DOUBLE` | `double precision` | `REAL` |
| `varchar(n)` | `varchar(n) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` | `varchar(n) COLLATE "C"` | `varchar(n)` |
| `text` | `LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` | `text COLLATE "C"` | `TEXT` |
| `bytes` | `LONGBLOB` | `bytea` | `BLOB` |
| `uuid` | `BINARY(16)` | `uuid` | `BLOB` |
| `date` | `DATE` | `date` | `DATE` |
| `time(p)` | `TIME(p)` | `time(p)` | `TIME` |
| `datetime(p)` | `DATETIME(p)` | `timestamp(p)` | `DATETIME` |

- **DIA-121** **Identity.** MySQL `BIGINT NOT NULL AUTO_INCREMENT` with `PRIMARY KEY` at table level; PostgreSQL `bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL` with `PRIMARY KEY` at table level; SQLite `INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT` on the column and no table-level primary key.
- **DIA-122** **Defaults.** A literal default is written in the dialect form of the literal (below). `default now` is MySQL `CURRENT_TIMESTAMP(p)`, PostgreSQL `statement_timestamp()`, and SQLite the UTC text with exactly p fraction digits: `strftime('%Y-%m-%d %H:%M:%S', 'now')` for p = 0, `substr(strftime('%Y-%m-%d %H:%M:%f', 'now'), 1, 20 + p)` for p ≤ 3, and `(strftime('%Y-%m-%d %H:%M:%f', 'now') || '0…')` with p − 3 zeros for p > 3, each in parentheses. These defaults serve raw SQL: an ORM insert binds the `now` slot for an omitted `default now` column on PostgreSQL and SQLite and leaves it to `CURRENT_TIMESTAMP(p)` on MySQL ([protocol](protocol.md) "Clock").
- **DIA-123** **Literals.** Integers, `f64` and strings are written as in the document; a MySQL string doubles every backslash, because MySQL reads a backslash as an escape. `true` and `false` are `1` and `0` on MySQL and SQLite and `TRUE` and `FALSE` on PostgreSQL. A SQLite decimal literal is the integer value × 10^s: `7.50` of `decimal(13,2)` is `750`. A `uuid` literal is its 16 bytes on MySQL and SQLite, `X'` and the 32 lower-case digits of the text and `'`, and the quoted text on PostgreSQL: `'0e2b5e8c-3b0f-4c59-9a0f-6a2f2c2e1b10'` is `X'0e2b5e8c3b0f4c599a0f6a2f2c2e1b10'`. Introspection reads such a literal back from a check, which MySQL writes as `0x` and the hex and MariaDB and SQLite as `X'` and the hex: 16 bytes compared with a `uuid` column are the quoted canonical text, and any other binary literal is refused with `the binary literal <hex> is no uuid literal` (the vectors `*-uuid-check-literal` of `tests/dbspec/introspect.json`).
- **DIA-124** **Keys.** `PRIMARY KEY (…)` lists the key columns; PostgreSQL keeps its default name `<table>_pkey`. A unique key is `CONSTRAINT <name> UNIQUE (…)` on MySQL and PostgreSQL and `CREATE UNIQUE INDEX <name> ON <table> (…)` on SQLite, whose catalog then reports the name. An index column is followed by `DESC` when it is descending.
- **DIA-125** **Foreign keys.** `CONSTRAINT <name> FOREIGN KEY (…) REFERENCES <table> (…) ON DELETE <action> ON UPDATE <action>` with `RESTRICT`, `CASCADE` or `SET NULL`.
- **DIA-126** **Checks.** A declared check is `CONSTRAINT <name> CHECK (<predicate>)`: column names quoted, `and`, `or`, `not`, `in`, `between`, `is null` and `is not null` in upper case, literals in the dialect form, parentheses as written.

### Renderer CHECKs

- **DIA-127** A renderer CHECK enforces a type the dialect does not enforce. It is named `<table>$<column>` by the rule of [dbspec names](dbspec.md#names): the plain form when it has at most 63 bytes, otherwise its first 54 bytes, a `$` and 8 hexadecimal digits of its SHA-256. A dbspec name cannot contain `$`, so it never meets a declared name. One CHECK per column holds every condition of the column's type:

| dbspec | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `i16`, `i32` | | | `typeof(c) IN ('integer', 'null') AND c BETWEEN <min> AND <max>` |
| `i64` (not identity) | | | `typeof(c) IN ('integer', 'null')` |
| `bool` | `c IN (0, 1)` | | `c IN (0, 1)` |
| `decimal(p,s)` | | | `typeof(c) IN ('integer', 'null') AND c BETWEEN -(10^p − 1) AND 10^p − 1` |
| `f64` | | | `typeof(c) IN ('real', 'null')` |
| `varchar(n)` | | | `length(c) <= n` |
| `uuid` | `length(c) = 16` | | `typeof(c) IN ('blob', 'null') AND length(c) = 16` |
| `date` | | | `c IS date(c)` |
| `time(0)` | `c >= '00:00:00' AND c < '24:00:00'` | `c < '24:00:00'` | `c IS time(c) AND c < '24:00:00'` |
| `time(p)`, p > 0 | as `time(0)` | as `time(0)` | `length(c) = 9 + p AND substr(c, 1, 8) IS time(substr(c, 1, 8)) AND substr(c, 1, 8) < '24:00:00' AND substr(c, 9, 1) = '.' AND substr(c, 10) GLOB` p digit classes |
| `datetime(0)` | | | `length(c) = 19 AND c IS datetime(c) AND substr(c, 12, 2) < '24'` |
| `datetime(p)`, p > 0 | | | `length(c) = 20 + p AND substr(c, 1, 19) IS datetime(substr(c, 1, 19)) AND substr(c, 12, 2) < '24' AND substr(c, 20, 1) = '.' AND substr(c, 21) GLOB` p digit classes |

- **DIA-128** The SQLite `f64` CHECK has no probe in the schema definitions above: a REAL column converts integers and numeric text to real values and keeps other text, which this CHECK rejects (the `types-and-defaults` case of `tests/dbspec/ddl.json`). PostgreSQL reads the input hour 24 of a `timestamp` as midnight of the next day, so `'2026-01-01 24:00:00'` stores `2026-01-02 00:00:00`, a valid date-time, while MySQL rejects that input (1292) and SQLite its renderer CHECK; no PostgreSQL CHECK applies, because the stored values are the same set (the same case). Clients never send hour 24.

### Triggers

- **DIA-129** A generated trigger is named `<table>$<event>` (shortened by the same rule as the renderer CHECK names, [dbspec names](dbspec.md#names)): `immutable_update`, `immutable_delete`, `audit_insert`, `audit_update` and `audit_delete`. A PostgreSQL trigger executes a function of the same name that the renderer owns. A rejection raises the message `table <table> is immutable` or `table <table> deletes through its soft delete column`: MySQL `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '…'`, PostgreSQL `RAISE EXCEPTION '…'`, SQLite `SELECT RAISE(ABORT, '…')`.

- **DIA-130** `immutable`: `BEFORE UPDATE` and `BEFORE DELETE` row triggers that reject.
- **DIA-131** `audit`: an `AFTER INSERT` row trigger inserts into the history table the action `'insert'`, a NULL previous audit record and the `NEW` value of every recorded column; an `AFTER UPDATE` row trigger inserts `'update'`, `OLD.<audit column>` and the `NEW` value of every recorded column; a `BEFORE DELETE` row trigger rejects. The insert names the action, previous and recorded columns in that order, the recorded columns in table column order, and leaves the history key to its identity ([audit](dbspec.md#audit)). With `tables`, each of the two triggers then inserts `(NEW.<audit column>, '<table>')` into the record column and the name column of the tables table and keeps a row that exists: MySQL `INSERT INTO <tables table> (<record column>, <name column>) VALUES (NEW.<audit column>, '<table>') ON DUPLICATE KEY UPDATE <name column> = <name column>`, PostgreSQL and SQLite the same insert with `ON CONFLICT DO NOTHING` in place of the `ON DUPLICATE KEY UPDATE` clause.
- **DIA-132** A MySQL trigger body is the single statement, or `BEGIN <history insert>; <tables insert>; END` with `tables`; the PostgreSQL and SQLite bodies list the statements in the same order, each followed by `; `; a PostgreSQL function body is `BEGIN … RETURN NULL; END` in `LANGUAGE plpgsql` (a `BEFORE` rejection never returns); a SQLite body is `BEGIN …; END`.

## Introspection

- **DIA-133** Introspection reads the current database (MySQL), the current schema (PostgreSQL) or the `main` database (SQLite) of a connection and returns one dbspec document, named by the caller, and the list of objects it cannot read. The recipe `contracts/fixtures/dbspec_introspect/dbspec_introspect.json` renders and applies every vector of `tests/dbspec/ddl.json` and every schema document, introspects the database, and requires the schema text of the result to equal the schema text of the source with its tables in name order and no unsupported object. It also runs `tests/dbspec/introspect.json`: each case renders its documents and runs its statements in an empty database of its dialect, with `{schema}` in a statement replaced by the name of that database or schema (a PostgreSQL case may create a second schema `{schema}_b`, which is dropped with it), then expects the introspected document in canonical form and the unsupported objects as `[kind, table, name]`; an entry may add a fourth element, a rule that the reason of that object must contain, which is compared when present, and otherwise reasons are not compared. A case of the `mysql` dialect may hold a `mariadb` member with its own `document` and `unsupported`, the result on a MariaDB server where the answer of that server differs (DIA-200, rule 4), and the DIA rule of each such difference names its vector (DIA-50, DIA-75). A catalog query that fails is the error of the call: the recipe case `catalog_query_failure` introspects an empty SQLite database with the catalog queries of MySQL. `make dbspec-introspect-<client>-check` runs the recipe through one client, and the Go test suite runs its entries. `make dbspec-introspect-compare-check` applies a 20-table document of the stress shape (`make dbspec-introspect-compare-bench`, part of `make bench`: the 2000-table stress document with the release Rust runner) to each dialect, runs all six configured implementations on it (Go, PHP, PHP extension, TypeScript, Rust and Python: the PHP extension is the runner of `tests/dbspec/introspect`, and the Python runner is `legacy/packages/python/tests/dbspec_introspect_runner.py`), and requires equal outputs (the canonical document, then a line `! kind<TAB>table<TAB>name` per unsupported object), the source schema text, and no unsupported object; it prints the time of each introspection and a warning when one takes more than its reference of 5 seconds, and the time never fails it.

### Document

- **DIA-134** Tables come in name order, columns in catalog position, constraints and indexes by name; a document holds no diagram and no comment.
- **DIA-135** Every table and column whose name begins with `dbspec$` is left out and not reported: the plan history table `dbspec$plans`, the hidden tables and columns of a plan and the SQLite work table ([plans](plans.md#steps)).
- **DIA-136** Only the settings that render in the database are read: `immutable` and `audit`, recognized from their triggers. The manifest settings live only in documents; a tool that synchronizes keeps them from the document it compares.

### Types and columns

| Catalog | MySQL `COLUMN_TYPE` | PostgreSQL `format_type` | SQLite declared type | dbspec |
| --- | --- | --- | --- | --- |
| 16, 32, 64-bit integer | `smallint`, `int`, `bigint` | `smallint`, `integer`, `bigint` | `smallint`, `integer`, `bigint` with its renderer CHECK | `i16`, `i32`, `i64` |
| boolean | `tinyint(1)` with its renderer CHECK | `boolean` | `BOOLEAN` with its renderer CHECK | `bool` |
| decimal | `decimal(p,s)` | `numeric(p,s)` | `DECIMALINT(p,s)` with its renderer CHECK | `decimal(p,s)` |
| float | `double` | `double precision` | `REAL` with its renderer CHECK | `f64` |
| bounded text | `varchar(n)` in `utf8mb4_0900_bin` | `character varying(n)` with collation `C` | `varchar(n)` with its renderer CHECK | `varchar(n)` |
| text | `longtext` in `utf8mb4_0900_bin` | `text` with collation `C` | `TEXT` without CHECK | `text` |
| bytes | `longblob` | `bytea` | `BLOB` | `bytes` |
| uuid | `binary(16)` with its renderer CHECK | `uuid` | `BLOB` with its renderer CHECK | `uuid` |
| date | `date` | `date` | `DATE` with its renderer CHECK | `date` |
| time of day | `time` or `time(p)` with its renderer CHECK | `time(p) without time zone` with its renderer CHECK | `TIME` with the renderer CHECK of one p | `time(p)` |
| date-time | `datetime` or `datetime(p)` | `timestamp(p) without time zone` | `DATETIME` with the renderer CHECK of one p | `datetime(p)` |

- **DIA-137** MySQL writes precision 0 without parentheses (`time`, `datetime`). A column whose type, collation or character set is not in this table, a MySQL `tinyint(1)`, `binary(16)` or `time` column without its renderer CHECK, and a SQLite column whose CHECK is not the renderer output of one dbspec type are reported as unsupported.

- **DIA-138** **Null.** `IS_NULLABLE`, `attnotnull` and `pragma_table_xinfo.notnull` give `null`.
- **DIA-139** **Identity.** A single-column `bigint` primary key with MySQL `EXTRA` `auto_increment`, PostgreSQL `attidentity` `d`, or SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` is `identity`; PostgreSQL `attidentity` `a` (`ALWAYS`) is unsupported.
- **DIA-140** **Defaults.** A literal default is read in the column's canonical default form: MySQL `COLUMN_DEFAULT` is the unescaped value (a string, a number, `1` or `0` for `bool`); PostgreSQL `pg_get_expr` gives a literal with a cast, such as `'-5'::integer`, `'a''b'::character varying` or `'2026-01-01'::date`, whose cast is removed; SQLite `dflt_value` is the rendered literal, a scaled integer for a decimal. A `uuid` default is read as its canonical text from its 16 bytes: MySQL `COLUMN_DEFAULT` of a `binary(16)` is `0x` and 32 upper-case digits, and of the `char(36)` and `varbinary(36)` of a column in text storage (DIA-144) the text or its `0x` digits; SQLite `dflt_value` is the rendered `X'…'`. A clock default is `default now` when it equals the renderer output: MySQL `CURRENT_TIMESTAMP` or `CURRENT_TIMESTAMP(p)` with `DEFAULT_GENERATED`, PostgreSQL `statement_timestamp()`, SQLite the `strftime` expression of that precision. Any other expression is unsupported.

### Keys, indexes and foreign keys

- **DIA-141** The primary key keeps its column order. A MySQL `UNIQUE` index, a PostgreSQL `UNIQUE` constraint and a SQLite unique index whose origin is `c` are unique keys; any other index is an index, with `DESC` read from `COLLATION`, `indoption` or `pragma_index_xinfo.desc`.
- **DIA-142** A prefix, partial, expression or full-text index, a PostgreSQL unique index without its constraint, a SQLite `sqlite_autoindex` other than the primary key, and an index whose name contains `$` are unsupported.
- **DIA-143** A foreign key reads its name, columns, referenced table and columns and both actions; `NO ACTION`, `SET DEFAULT`, a deferrable key, `MATCH FULL` and a PostgreSQL key whose referenced table is in another schema are unsupported. SQLite foreign key names come from the `CREATE TABLE` text in `sqlite_master`.

### Checks

- **DIA-144** A check named `<table>$<column>` is a renderer CHECK. It must equal the catalog form of the renderer output for the column's type: MySQL `` (`c` in (0,1)) `` for `bool`, `` (length(`c`) = 16) `` for `uuid` (`mysql.render.uuid_bytes`), `` ((`c` >= _utf8mb4\'00:00:00\') and (`c` < _utf8mb4\'24:00:00\')) `` for `time(p)`, and on MariaDB the forms of DIA-203; PostgreSQL `CHECK ((c < '24:00:00'::time without time zone))` with the column name as `quote_ident` writes it; SQLite the rendered text itself. MySQL writes `CHECK_CLAUSE` again on every `ALTER TABLE` of the table, giving the time literals no introducer (`mysql.check.alter_rewrites_introducers`), and writes a time literal that meets a `time(p)` column with `p` zero fraction digits (`mysql.check.alter_writes_time_precision`), so a MySQL clause is compared with its character set introducers and the zero fractions of its time literals removed; the literals of these templates are ASCII and a zero fraction keeps the value, so the comparison keeps their meaning. A renderer CHECK that differs, and a name with `$` that is no renderer CHECK, are unsupported. The renderer CHECK of a `uuid` on MySQL and SQLite is the named marker of its type, which tells a uuid from a `bytes` column, since a `bytes` column has none. A column of the text storage of a uuid that a release up to 0.0.28 made, MySQL `char(36)` in `ascii_bin` with the CHECK `` regexp_like(`c`,_utf8mb4\'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$\',_utf8mb4\'c\') `` and SQLite `TEXT` with the CHECK `c GLOB` of 36 character classes, and a MySQL `varbinary(36)` column with the CHECK `` (length(`c`) in (16,36)) `` of a conversion that stopped (PLN-108), on MariaDB `` c regexp '…' `` of DIA-203 and `` octet_length(`c`) in (16,36) ``, is read as a `uuid` column and reported as an unsupported column with the reason `uuid stored as text by an earlier release; dbspec apply converts it to 16 bytes`.

- **DIA-145** Every other check is read into a predicate of [dbspec](dbspec.md#checks) and written in canonical form:

- **DIA-146** **MySQL** `CHECK_CLAUSE`: fully parenthesized, lower-case keywords, backquoted columns, `in (a,b)` without spaces, a negative number as `-(n)`, and a string as `_utf8mb4` followed by the MySQL string literal, whose text is escaped a second time (`\'` and `\\` in the clause).
- **DIA-147** **PostgreSQL** `pg_get_constraintdef`: `CHECK (…)` around a fully parenthesized expression, columns quoted only where `quote_ident` needs it, casts on literals and columns (`'x'::text`, `(s)::text`, `'-1.50'::numeric`, `(1.5)::double precision`), `= ANY (ARRAY[…])` for `in` and `<> ALL (ARRAY[…])` for `not in`, and a time or date-time literal without trailing zero fractions.
- **DIA-148** **SQLite**: the text inside `CHECK (…)` of the `CREATE TABLE` statement, which is the rendered text; a decimal literal is the scaled integer.

- **DIA-149** A literal is read as the value of the column it meets and written in its canonical default form, so `'2100-01-01 00:00:00'` of a `datetime(6)` column becomes `'2100-01-01 00:00:00.000000'` and `1` of a `bool` column `true`. A check that does not read as a predicate, or whose predicate breaks a dbspec rule, is unsupported.

### Triggers

- **DIA-150** Each setting is recognized by its own trigger names, which are recomputed by the rule of [dbspec names](dbspec.md#names), never by a count of triggers: the triggers named `<table>$immutable_update` and `<table>$immutable_delete` give the `immutable` setting, and the triggers named `<table>$audit_insert`, `<table>$audit_update` and `<table>$audit_delete` give the `audit` setting, when they equal the renderer output of that setting: MySQL timing, event and `ACTION_STATEMENT`; PostgreSQL `pg_get_triggerdef` with the schema prefix of the table removed and the `prosrc` of its function; SQLite the `CREATE TRIGGER` text. The `audit` parameters are read from the insert statement of `audit_insert` and the `OLD` column of `audit_update` before the comparison: the insert names the action, previous and recorded columns, the recorded columns include the audit column, and the columns of the table that it does not name become the `exclude` list in column order, as the schema text writes it; the audit record table is the target of the one foreign key of the audit column; a second insert of `audit_insert` gives the `tables` clause, its target and its two columns. A table that has both settings has the union of each setting’s renderer output, and its trigger set must equal that union exactly by name and by statement. An extra trigger, a missing one or a different statement makes every trigger of the table unsupported, and so does every other trigger.

### Unsupported objects

- **DIA-151** Each unsupported object is reported with its kind, its table and name where it has them, and the reason; the document leaves it out. The list is ordered by table, kind and name, and objects without a table come first. The kinds are `column`, `index`, `unique`, `foreign_key`, `check`, `trigger` (one per set for an `immutable` or `audit` setting that does not parse), `view`, `routine`, `sequence`, `event`, `partition` (a MySQL or PostgreSQL partitioned table and a PostgreSQL partition) and `table` (a SQLite `WITHOUT ROWID` or virtual table, and a table without a primary key).

- **DIA-152** An object that refers to a left-out object is reported and left out too: an index or a key on an unsupported column, a foreign key to a table that is left out, a check that names an unsupported column. The introspected document is parsed, and each object on a line that the parse rejects is reported with the diagnostic as its reason and left out, until the document parses. When the parse rejects a table, the table is left out with all its objects, and objects of that table rejected by the same parse are not reported apart from it. Each object is reported once, also a foreign key whose catalog rows are one per column.

- **DIA-153** SQLite reads table items from the `CREATE TABLE` text. A column definition is read when it is the renderer form: the quoted name, the declared type, `NULL` or `NOT NULL`, and the default if there is one; a column with any other clause (`CHECK`, `REFERENCES`, `UNIQUE`, `COLLATE`, …) is unsupported. A `CHECK`, `UNIQUE` or `FOREIGN KEY` item that is not the renderer form is reported with that kind and its constraint name, an empty name when it has none; the automatic index of a `UNIQUE` item or clause is not reported apart from it. A primary key item of another form, and any other item, leave the table out.
- **DIA-191** An unsupported SQLite column whose declared type has no dbspec type is reported with the reason `declared type <type> with CHECK <check> has no dbspec type`, where `<check>` is the column's CHECK text as a JSON string, `""` when the column has no CHECK. All six clients report a column with no CHECK using this exact empty-string form. The Go client writes `<check>` with `%q` and the TypeScript client with `JSON.stringify`; the Python client writes the same text.
- **DIA-198** The number of catalog queries for introspection is fixed per dialect and does not depend on the number of tables.
- **DIA-133a** PHP and the PHP extension: a failing catalog query is the error of the call in every error mode of the PDO connection, the silent mode too.
- **DIA-133b** PHP-extension package `polyspec/orm-php-ext` implements `Dbspec::introspect` natively, and its method takes the place of the method of the library.

## MariaDB 11.8 probes

Each fact probe of MySQL has a probe of the same topic and fact on MariaDB, `mariadb.<topic>.<fact>`, that
`TestDialectFactsMariadb` runs on the MariaDB 11.8.6 of `make orm-test-mariadb` (`make dialect-facts-mariadb-check`, DIA-200).
Where the MySQL fact holds, the probe is its twin and proves it on MariaDB 11.8; where MariaDB answers otherwise, the probe of that
ID states the MariaDB fact (`legacy/packages/go/internal/dialects/probes_mariadb.go`), which the table writes. Each MariaDB probe passes
on MariaDB 11.8.6. A rule of this document names MariaDB 11.8 only where a MariaDB probe proves its form, and names that
probe; a rule that names MySQL alone has no proof on MariaDB yet.

| Probe | On MariaDB 11.8.6 |
|---|---|
| `mariadb.auto_increment.explicit_value_advances` | the MySQL fact holds |
| `mariadb.auto_increment.requires_key` | the MySQL fact holds |
| `mariadb.auto_increment.rollback_leaves_gap` | the MySQL fact holds |
| `mariadb.binary.zero_padded` | the MySQL fact holds |
| `mariadb.bool.alias_tinyint` | the MySQL fact holds |
| `mariadb.catalog.key_ordinal_by_name` | a subquery that names the table by constants reads the primary-key ordinal as the join does, and only the join opens every table of every database |
| `mariadb.char.trailing_spaces_removed` | the MySQL fact holds |
| `mariadb.check.alter_rewrites_introducers` | MariaDB has no REGEXP_LIKE (1305 outside a CHECK, 1901 in one), and ALTER TABLE leaves CHECK_CLAUSE as it was |
| `mariadb.check.alter_writes_time_precision` | ALTER TABLE leaves a time literal that meets a time(p) column as it was written |
| `mariadb.check.between_kept` | CHECK_CLAUSE keeps BETWEEN and writes a negative literal as -n |
| `mariadb.check.bool_column_rejected` | a bool column alone is a CHECK expression, which refuses 0 (4025) |
| `mariadb.check.catalog_text` | CHECK_CLAUSE is the expression without outer parentheses and without a character set introducer |
| `mariadb.check.drop_constraint` | the MySQL fact holds |
| `mariadb.check.drop_constraint_shared_name` | a CHECK cannot share its name with a foreign key or a unique key of its table (1826), so DROP CONSTRAINT names one constraint |
| `mariadb.check.enforced_null_passes` | CHECK is enforced (4025, SQLSTATE 23000) and NULL passes |
| `mariadb.check.fk_action_column_rejected` | a column of a foreign key with a referential action cannot appear in a CHECK (1901) |
| `mariadb.check.name_schema_scope` | CHECK names are scoped to their table: two tables may each have a CHECK ck |
| `mariadb.check.nondeterministic_rejected` | a CHECK cannot call NOW() (1901) |
| `mariadb.check.not_enforced_option` | MariaDB has no NOT ENFORCED CHECK (1064), and TABLE_CONSTRAINTS has no ENFORCED column (1054) |
| `mariadb.check.not_pushed_down` | CHECK_CLAUSE pushes NOT into comparisons and IS NULL and writes no inner parentheses |
| `mariadb.check.string_escaped_twice` | CHECK_CLAUSE escapes a string literal once, as MariaDB text |
| `mariadb.collation.default_accent_case_insensitive` | the default utf8mb4 collation utf8mb4_uca1400_ai_ci makes a = A = á in a unique key (1062) |
| `mariadb.collation.utf8mb4_0900_bin_codepoint` | the MySQL fact holds |
| `mariadb.collation.utf8mb4_bin_pads` | the MySQL fact holds |
| `mariadb.comment.column_limit` | the MySQL fact holds |
| `mariadb.comment.table_limit` | the MySQL fact holds |
| `mariadb.context.user_variable_session_scope` | the MySQL fact holds |
| `mariadb.current_timestamp.session_time_zone` | the MySQL fact holds |
| `mariadb.date.zero_rejected` | the default sql_mode of MariaDB accepts 0000-00-00, and NO_ZERO_DATE with strict mode rejects it (1292) |
| `mariadb.datetime.default_precision_must_match` | DATETIME(6) DEFAULT CURRENT_TIMESTAMP without (6) is accepted as CURRENT_TIMESTAMP(6), which COLUMN_DEFAULT reports |
| `mariadb.datetime.fraction_rounds` | DATETIME(0) truncates .5 seconds |
| `mariadb.datetime.max_precision` | the MySQL fact holds |
| `mariadb.datetime.no_conversion` | the MySQL fact holds |
| `mariadb.datetime.offset_literal_converted` | DATETIME rejects a literal with an offset (1292) |
| `mariadb.datetime.range` | the MySQL fact holds |
| `mariadb.ddl.atomic_statement` | a DROP TABLE of two tables, one missing, drops the one that exists and fails (1051) |
| `mariadb.ddl.implicit_commit` | the MySQL fact holds |
| `mariadb.decimal.overflow_rejected` | the MySQL fact holds |
| `mariadb.decimal.precision_limits` | DECIMAL precision is at most 65 (1426) and scale at most 38 (1425), so DECIMAL(65,31) is accepted |
| `mariadb.decimal.scale_rounds` | the MySQL fact holds |
| `mariadb.default.catalog_text` | COLUMN_DEFAULT quotes a literal with its SQL escapes, writes NULL for a NULL default, an expression default as its text and the clock as current_timestamp(p), and EXTRA has no DEFAULT_GENERATED |
| `mariadb.enum.not_null_first_value_default` | the MySQL fact holds |
| `mariadb.enum.rejects_unknown` | the MySQL fact holds |
| `mariadb.enum.sorts_by_position` | the MySQL fact holds |
| `mariadb.env.server` | the server is MariaDB 11.8 in strict mode with lower_case_table_names=1 |
| `mariadb.fault.check_before_unique` | a row that breaks a CHECK and a unique key is refused with the CHECK fault, 4025 of SQLSTATE 23000 |
| `mariadb.fault.fk_statement_end` | the MySQL fact holds |
| `mariadb.fk.cascade_skips_triggers` | the MySQL fact holds |
| `mariadb.fk.child_index_created` | the MySQL fact holds |
| `mariadb.fk.deferrable_rejected` | the MySQL fact holds |
| `mariadb.fk.match_full_not_enforced` | MATCH FULL is recorded as MATCH_OPTION NONE, omitted by SHOW CREATE TABLE, and a partly NULL key is accepted |
| `mariadb.fk.name_schema_scope` | foreign key names are unique in the database: a second fk is refused with 1005 (errno 121) |
| `mariadb.fk.restrict_row_order` | the MySQL fact holds |
| `mariadb.fk.rule_catalog` | REFERENTIAL_CONSTRAINTS reports an omitted action as RESTRICT and a written RESTRICT as RESTRICT |
| `mariadb.fk.set_default_acts_as_restrict` | InnoDB accepts ON DELETE SET DEFAULT, records it as RESTRICT and rejects the parent delete (1451) |
| `mariadb.fk.type_mismatch_rejected` | an INT column cannot reference a BIGINT key: 1005 (errno 150) |
| `mariadb.float.no_infinity` | the MySQL fact holds |
| `mariadb.float.single_precision` | the MySQL fact holds |
| `mariadb.generated.catalog_expression` | VIRTUAL and STORED generated columns are reported with their expression without outer parentheses |
| `mariadb.generated.explicit_value_rejected` | an explicit value for a generated column is rejected in strict mode (1906) |
| `mariadb.ident.column_case_insensitive` | the MySQL fact holds |
| `mariadb.ident.max_length` | a table name is at most 64 characters (1103) |
| `mariadb.ident.table_case_server_setting` | the MySQL fact holds |
| `mariadb.index.descending` | the MySQL fact holds |
| `mariadb.index.functional` | MariaDB has no functional index key (1064), and STATISTICS has no EXPRESSION column (1054) |
| `mariadb.index.max_key_bytes` | an index on a utf8mb4 VARCHAR(769), beyond 3072 bytes, is accepted |
| `mariadb.index.name_max_length` | the MySQL fact holds |
| `mariadb.index.name_table_scope` | the MySQL fact holds |
| `mariadb.index.partial_rejected` | the MySQL fact holds |
| `mariadb.index.prefix` | the MySQL fact holds |
| `mariadb.index.primary_name_reserved` | the MySQL fact holds |
| `mariadb.int.bigint_unsigned_exceeds_signed` | the MySQL fact holds |
| `mariadb.int.display_width_dropped` | COLUMN_TYPE keeps the integer display width: int(11), tinyint(1), bigint(20) |
| `mariadb.int.tinyint_range` | the MySQL fact holds |
| `mariadb.int.unsigned_rejects_negative` | the MySQL fact holds |
| `mariadb.json.normalizes` | JSON is LONGTEXT with a JSON_VALID CHECK: the text is kept as written, duplicate keys and member order included |
| `mariadb.like.ascii_fold_replace` | the MySQL fact holds |
| `mariadb.like.binary_collation_case_sensitive` | the MySQL fact holds |
| `mariadb.like.binary_collation_code_point` | the MySQL fact holds |
| `mariadb.lock.nowait_held` | a NOWAIT read of a row that another transaction locks fails at once with 1205, the number of a lock wait timeout |
| `mariadb.lock.share_clause` | LOCK IN SHARE MODE takes a shared row lock and takes NOWAIT, and MariaDB has no FOR SHARE (1064) |
| `mariadb.not_null.missing_value_rejected` | the MySQL fact holds |
| `mariadb.now.compare_six_digits` | the MySQL fact holds |
| `mariadb.now.precision_truncates` | the MySQL fact holds |
| `mariadb.on_update.explicit_value_kept` | the MySQL fact holds |
| `mariadb.on_update.fires_on_change` | the MySQL fact holds |
| `mariadb.on_update.skipped_when_unchanged` | the MySQL fact holds |
| `mariadb.order.null_first_asc` | the MySQL fact holds |
| `mariadb.pk.name_is_primary` | the MySQL fact holds |
| `mariadb.relative.month_end_kept` | the MySQL fact holds |
| `mariadb.relative.out_of_range_null` | the MySQL fact holds |
| `mariadb.render.bool_check` | TINYINT(1) with CHECK (b IN (0,1)) rejects 2 (4025) |
| `mariadb.render.datetime_utc_session` | the MySQL fact holds |
| `mariadb.render.time_of_day_check` | TIME(6) with CHECK (v >= '00:00:00' AND v < '24:00:00') accepts only a time of day (4025) |
| `mariadb.render.timestamp_conversion` | the MySQL fact holds |
| `mariadb.render.uuid_bytes` | BINARY(16) with CHECK (length(u) = 16), whose CHECK_CLAUSE is octet_length(`u`) = 16, stores the 16 bytes of a uuid and orders them as the text; COLUMN_DEFAULT writes a binary default as x' and the lower-case hex of its bytes |
| `mariadb.sequence.unsupported` | MariaDB has CREATE SEQUENCE, a table of its own kind |
| `mariadb.session.partial_revokes_listed` | MariaDB has no partial_revokes (1193), and SHOW GLOBAL VARIABLES lists no row of it |
| `mariadb.session.sql_mode_set` | the MySQL fact holds |
| `mariadb.session.statement_timeout` | MariaDB has no max_execution_time (1193): SESSION max_statement_time bounds every statement in seconds (1969) |
| `mariadb.text.index_needs_prefix` | an index on TEXT without a prefix length is accepted with the prefix of 768 characters, which STATISTICS reports as SUB_PART |
| `mariadb.text.literal_default_needs_expression` | TEXT accepts DEFAULT 'x' and DEFAULT ('x'), and COLUMN_DEFAULT reports both as the quoted literal |
| `mariadb.text.max_bytes` | the MySQL fact holds |
| `mariadb.text.nul_preserved` | the MySQL fact holds |
| `mariadb.time.interval_range` | the MySQL fact holds |
| `mariadb.timestamp.range_2038` | TIMESTAMP accepts 1970-01-01 00:00:01..2106-02-07 06:28:15 UTC and rejects 1970-01-01 00:00:00 and 2106-02-07 06:28:16 (1292) |
| `mariadb.timestamp.session_time_zone` | the MySQL fact holds |
| `mariadb.trigger.binlog_privilege_1419` | the MySQL fact holds |
| `mariadb.trigger.body_catalog_verbatim` | the MySQL fact holds |
| `mariadb.trigger.name_schema_scope` | the MySQL fact holds |
| `mariadb.trigger.new_assignable` | the MySQL fact holds |
| `mariadb.trigger.no_statement_level` | the MySQL fact holds |
| `mariadb.trigger.no_truncate_event` | the MySQL fact holds |
| `mariadb.trigger.truncate_skips_delete_trigger` | the MySQL fact holds |
| `mariadb.trigger.update_fires_when_unchanged` | the MySQL fact holds |
| `mariadb.trigger.zero_rows_not_fired` | the MySQL fact holds |
| `mariadb.unique.nulls_distinct` | the MySQL fact holds |
| `mariadb.upsert.any_unique_key` | the MySQL fact holds |
| `mariadb.upsert.not_null_unique_first` | the MySQL fact holds |
| `mariadb.uuid.binary_pads` | the MySQL fact holds |
| `mariadb.uuid.no_type` | MariaDB has a UUID type, reported as DATA_TYPE uuid, whose ORDER BY is not the order of the text |
| `mariadb.varbinary.length_enforced` | the MySQL fact holds |
| `mariadb.varchar.length_in_characters` | the MySQL fact holds |
| `mariadb.varchar.max_length` | the MySQL fact holds |
| `mariadb.varchar.trailing_spaces_truncated` | the MySQL fact holds |
| `mariadb.view.definition_rewritten` | VIEW_DEFINITION is rewritten with qualified names and aliases, without parentheses around the condition |

## Markdown corpus

A markdown connection is a SQLite connection whose statements a flowmark server answers on a corpus
([protocol](protocol.md#_5-markdown-connections)), so every rule of the SQLite dialect holds on it. The rows below state what
a corpus adds to SQLite, and where a surface behaves as on SQLite they say so; the recipes run every case of SQLite on a
markdown connection too. flowmark's [operations](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/40-ops.md) state how the server answers a statement.

- **DIA-154** The DSN scheme `markdown://` selects the SQLite dialect on a connection to a flowmark server
  ([protocol](protocol.md#_5-markdown-connections)): the client plans each request as on SQLite and sends its statements.
- **DIA-155** `one`, `all`, `count`, `group_count`, `sum`, `avg` — Result: as on SQLite.
- **DIA-156** ordering — Result: as on SQLite: NULL before every value ascending and after every value descending.
- **DIA-157** `group_by` — Result: as on SQLite, by orm's rule.
- **DIA-158** `paginate`, `lookahead_paginate`, `group_lookahead_paginate` — Result: as on SQLite; a statement reads one consistent corpus.
- **DIA-159** `insert` (single and multi-row) — Result: as on SQLite; Rule: the corpus assigns no column that the
  other databases leave to the application, so an insert that leaves out a required column is `IR_INVALID` (DBS-79).
- **DIA-160** `update` — Result: as on SQLite; Rule: a `COMMIT` that finds a file changed outside the engine since the
  transaction read it is `WRITE_CONFLICT`, which the client never retries (PRT-71).
- **DIA-161** `delete`, `restore` — Result: as on SQLite; Rule: the foreign keys are SQLite's, and the corpus's rules judge
  every write as well ([constraints](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/50-constraints.md)).
- **DIA-162** `optimistic` — Result: as on SQLite.
- **DIA-163** `on_duplicate` — Result: as on SQLite, with orm's one conflict key.
- **DIA-164** primary key comparison — Result: byte for byte, as on SQLite; Rule: a key equal to another of its table only
  without regard to the case of A–Z is `DUPLICATE_KEY` on every write, an `on_duplicate` insert too, because a key is a file
  name and an anchor ([document model](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/20-document-model.md)).
- **DIA-165** `lock` `update`, `share` — Result: as on SQLite.
- **DIA-166** `lock` `update_nowait`, `share_nowait` — Result: as on SQLite.
- **DIA-167** relations (`limit_per_parent`, `if_parent`, `flatten`, `key_by`, `no_cascade_delete`) — Result: as on SQLite,
  assembled by the client.
- **DIA-168** subqueries (`tuple_in`, `tuple_not_in`, scalar `Sub` aggregates) — Result: as on SQLite.
- **DIA-169** a scalar column subquery — Result: as on SQLite, by orm's rule.
- **DIA-170** column comparisons — Result: as on SQLite, by orm's rule.
- **DIA-171** `contains` — Result: as on SQLite.
- **DIA-172** `contains_binary` — Result: as on SQLite.
- **DIA-173** `now`, `default now`, `updated`, `soft_delete` — Result: as on SQLite, the request's clock.
- **DIA-174** `soft_delete` — Result: as on SQLite, by orm's rule.
- **DIA-175** codec columns — Result: applied by the client, as on SQLite; Rule: a write the engine originates (CLI, MCP,
  sidecar, history) applies the codec through orm's Go codec package, and validation decodes with the same package.
- **DIA-176** indexes — Result: as on SQLite: the corpus's database holds the declared indexes.
- **DIA-177** `select explicit`, `entity`, `navigation` — Result: client-side, as on SQLite.
- **DIA-178** `aes`, `aes_version`, `blind_index` — Result: as on SQLite: the client encrypts and decrypts; Rule: a corpus
  takes these settings, and the engine reads its keys by injection for the writes it originates and for its validation
  ([schema](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/30-schema.md)).
- **DIA-179** `audit`, `immutable` settings — Result: as on SQLite: orm writes the audit record and the history; Rule: the
  corpus refuses a change to an `immutable` table through the engine too.
- **DIA-180** transactions — Result: SQLite's statements; Rule: `readOnly` is SQLite's `query_only`.
- **DIA-181** savepoints — Result: as on SQLite.
- **DIA-182** `orderByRandom` — Result: as on SQLite.
- **DIA-183** a transaction with audit values — Result: as on SQLite.
- **DIA-184** `isolation` and `timeoutMs` options — Result: as on SQLite.
- **DIA-185** `getQuery()`, `getPagePlanSteps()`, statement events, `subscribe()`, `utils().run(fn)` — Result: as on SQLite:
  the statements are SQLite's.
- **DIA-186** `force_index` — Result: as on SQLite.
- **DIA-187** `fulltext` — Result: as on SQLite.
- **DIA-188** lock, local-setting, privilege and AES-rotation utilities — Result: as on SQLite.
- **DIA-189** schema install, dbplan chains — Result: as on SQLite; Rule: a schema statement is its own transaction on a
  corpus, appended to `dbspec/statements.json` ([operations](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/40-ops.md)).
- **DIA-190** an unavailable table (a file with `format.block`, `format.section`, `format.encoding` or a `parent.cycle` among its rows, two rows with byte-for-byte equal keys, or a `corpus.walk` entry at its place) — Result: every request that needs its rows, read or write, fails `CONSTRAINT`, naming the file and the diagnostic; Rule: no answer comes from the other files' rows alone ([canonical format](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/10-canonical-format.md))
- **DIA-199** Go and Rust and TypeScript and Python: the pool options of a markdown connection (DIA-154), `poolSize`,
  `poolIdleSize` and `poolLifetimeMs` (CFG-4, CFG-5) — Result: as on SQLite: an idle size above the pool size, set or
  default, is refused with `CONFIG`. PHP and the PHP extension keep no pool (CFG-4).

## Notifications

- **DIA-192** **Definition.** `notify(channel, payload)`, `listen(channel)` and `unlisten(channel)` are client operations of the PostgreSQL dialect: PostgreSQL's `pg_notify` and `LISTEN` / `UNLISTEN`. They are not IR, so no planner or executor builds them ([protocol](protocol.md#_6-notifications)). A channel is a PostgreSQL identifier of 1 to 63 bytes of UTF-8 without U+0000; a channel outside that range is `CONFIG` before any statement runs.
- **DIA-193** **notify.** `notify` runs `SELECT pg_notify($1, $2)` on the connection of its handle. Inside a transaction the notification is delivered when the transaction commits and discarded when it rolls back; outside one it is delivered at the commit of its own statement. PostgreSQL requires a payload to be shorter than 8000 bytes; a payload of 8000 or more UTF-8 bytes, or one containing U+0000, fails with `DRIVER` before a statement runs.
- **DIA-194** **listen.** `listen(channel)` opens a connection of its own, outside the pool, runs `LISTEN` with the channel as a quoted identifier, and yields each notification as its channel, its payload and the process id of the sender. Notifications that arrive while no receive is pending are kept in arrival order. A lost connection ends the subscription with `CONNECTION_LOST`.
- **DIA-195** **unlisten and cancellation.** `unlisten(channel)` runs `UNLISTEN` on the listening connection and stops delivering that channel. `close()` runs `UNLISTEN` for every channel of the subscription and returns its connection to the client, with no error. A pending receive is cancelled by the cancellation primitive of its language on the handle that listens, as [CFG-9](config.md) defines: Go cancels the context of `db.WithContext(ctx)`, and TypeScript aborts the signal of `db.withSignal(signal)`. Python, PHP and Rust have no such primitive for a receive, so their receive takes a deadline, and a deadline that expires ends it. A cancelled or expired receive fails with `CANCELED` and closes the subscription, and a later call on it fails with `CONFIG`.
- **DIA-196** **Other databases.** On MySQL, SQLite and a markdown connection, `notify`, `listen` and `unlisten` fail with `CAPABILITY_UNSUPPORTED` before any statement or connection is used; none of them is a silent no-op.
- **DIA-197** Python driver form: The client sends the statement that the engine writes for its driver. A `?` marker of MySQL becomes `%s` and takes the values in order; a `$n` marker of PostgreSQL becomes `%(pn)s` with the argument named `pn`. A marker inside a quoted string, a quoted identifier or a comment is text and stays as it is. Every `%` of the statement is written `%%`, because the driver formats the whole statement. A statement without values is passed unchanged with no arguments.
