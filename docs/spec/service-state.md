<!-- doc-id: service-state -->
# Services of the interface cases

[Korean](service-state.ko.md)

A case of the interface contract `packages/rust/interface.json` that needs a database server names a service of the
contract (binding GN-13j, CK-95). This document states the services of orm and the program that writes and reads their
state.

- **SVC-1** The contract declares two services in `services`: `postgres`, whose address is the variable
  `ORM_TEST_POSTGRES_DSN`, and `mysql`, whose address is the variable `ORM_TEST_MYSQL_DSN`. Both name the state program
  by the variable `ORM_TEST_SERVICE_STATE`. The servers are the servers of `make orm-test-servers` or of
  `make orm-test-container KIND=<kind>`, whose environment file sets the addresses; a run sets
  `ORM_TEST_SERVICE_STATE` to the absolute path of `scripts/service-state.mts`. Why: the address of a server is a value
  of the run, and a case states it as `{"service": "address"}`.
- **SVC-2** The cases that name a service are in `contracts/interface/service.json`, in groups of their own, and each
  row of `cases` that names such a group has an `only` without `wasm`, because the core of WASM has no socket (CK-95).
- **SVC-3** The state program is `scripts/service-state.mts`. It is called as `service-state.mts <step> <scope>`
  with the JSON text of the step on its standard input, where `<step>` is `setup`, `check` or `change`. It reads the
  address of the service from the variable that the JSON names in `service` (`ORM_TEST_POSTGRES_DSN` or
  `ORM_TEST_MYSQL_DSN`), and it talks to the server with the client program of that server (`psql` or `mysql`). It
  exits with 0 when the step holds, and otherwise with 1 and a message that names the step, the scope, the statement
  and the output of the client. It waits for each statement without a time limit and uses no timer and no polling.
- **SVC-4** `setup` of `{"service", "table", "columns", "rows", "hold"}` brings the scope into the state that the JSON
  states and into no other: it creates the table `table` with the column definitions `columns` when the table does not
  exist, inserts each row of `rows` that is not there (`INSERT IGNORE` on MySQL, `ON CONFLICT DO NOTHING` on
  PostgreSQL), and, with `hold`, takes the lock that `hold` names in a transaction that outlives the program. `hold`
  is `{"where": "<condition>", "column": "<column>", "mode": "update"}`: in an XA transaction whose identifier is the
  sha256 of the scope, the program sets `column` of the rows of the condition to the first 16 digits of that
  identifier and prepares the transaction (`XA PREPARE`), so the server keeps the exclusive row locks after the session
  of the program ends. The transaction changes a row because InnoDB keeps no lock of a prepared XA transaction that
  changed nothing, a locking read included. Before it does, the program rolls back a prepared transaction of the same
  identifier that an earlier run left, before it inserts the rows, so the step is idempotent. On PostgreSQL the
  transaction is a prepared transaction of the same identifier (`BEGIN`, the update, `PREPARE TRANSACTION`), which
  the test servers keep because they start with `max_prepared_transactions=8` (`POSTGRES_PREPARED` of
  `scripts/test-servers.mts`). A case on PostgreSQL bounds the wait of its session for the lock with
  `SET lock_timeout` through `db.execute`, so the call fails with `lock_not_available` (SQLSTATE 55P03). Why: a lock that
  another holder took is the state that makes a statement of the case wait or fail, and a prepared transaction holds
  it with no process that outlives the step.
- **SVC-5** Two targets that run the same case at once take the same row lock, so the `setup` of the second waits until
  the `check` of the first releases it; the wait is bounded by the server setting `innodb_lock_wait_timeout`, and the
  call of each case meets a lock that another holder took. The table of a case is shared by the scopes, because the
  schema of the case names it; `setup` creates it with `IF NOT EXISTS` and inserts its rows idempotently, so that two
  scopes that set it up at once leave the same rows.
- **SVC-6** `check` of `{"service", "release"}` with `release: true` rolls back the prepared transaction of the scope and
  exits with 0 when no prepared transaction of the scope is left. `check` of `{"service", "absent": "<table>"}` exits
  with 0 when the table does not exist. `change` is not used by a case yet and exits with 1 and a message that names it.
- **SVC-8** A case of `connection_lost` on PostgreSQL makes its call end its own session: `db.execute` runs
  `pg_terminate_backend(pg_backend_pid())`, and the members of `query` read or write the view `service_pg_gone`, whose
  condition calls it for each row and which `WITH CHECK OPTION` applies to an insert too. The instance value of the
  `db` of the case creates the base table, its rows and the view with `db.execute` before the call. The server ends the
  session with SQLSTATE 57P01, which the core maps to `connection_lost` (`packages/rust/src/lib.rs`, the mapping of
  `PgDatabaseError`). `restore_or_create` then raises `rollback_failed`, because its transaction cannot roll back on the ended session. Why:
  a session that the state program ended between the calls is replaced by the pool before
  the next statement, so only a statement that ends its own session reaches the kind.
- **SVC-9** The case of `deadlock` on PostgreSQL tests the conversion of the kind at the boundary of the bindings:
  `db.execute` runs a `DO` block that raises SQLSTATE 40P01, so the server returns the error of a deadlock and the core
  maps it to `deadlock` through the mapping of every statement (`packages/rust/src/lib.rs`, the mapping of
  `PgDatabaseError`; DIA-201). Why: a deadlock of two sessions needs a second session that waits while the call of the
  case runs, which no form of a case has (SVC-4 holds a row and never waits), and the generated code converts a kind
  once for each path (binding B2.376); the deadlock of two waiting sessions is tested by the recipe op
  `transaction.deadlock` of the legacy clients and the tests of the core.
- **SVC-7** The core runs the cases of `contracts/interface/service.json` in the test
  `the_core_passes_the_service_cases_of_its_contract` of `packages/rust/tests/unit/interface_service_cases.rs`, whose
  scope is `rust:<member>:<case id>:`, with the servers of the run: `make interface-service-cases-rust`. A variable of
  a service that is not set fails the test with the service and the variable, never skips it. The test that runs the
  other groups (`the_core_passes_the_cases_of_its_contract`, CORE-71) leaves the file out, because it runs without
  servers.
