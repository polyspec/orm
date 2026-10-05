# Contributing

## Required workflow

1. Read `AGENTS.md` when it is present and read the relevant files in `contracts/features.json`.
2. Add a reproducing test for a predicted or observed defect.
3. Implement the smallest complete change across the engine, generators, and all affected clients.
4. Update the paired English and Korean documentation.
5. Run the relevant local checks and record the result in the commit description when needed.

## Test database servers

`make test-servers` starts these servers under `.runtime/servers` with the installed `mysqld`, `initdb`, `pg_ctl`, `pg_basebackup`, `proxysql` and `pgbouncer`:

| Server | Port variable (default) |
|---|---|
| MySQL 8.4 primary | `TEST_MYSQL_PORT` (33171) |
| PostgreSQL 17 primary | `TEST_POSTGRES_PORT` (55471) |
| MySQL replica of the primary, read-only | `TEST_MYSQL_REPLICA_PORT` (33181) |
| PostgreSQL standby of the primary | `TEST_POSTGRES_REPLICA_PORT` (55481) |
| ProxySQL in front of the MySQL primary | `TEST_PROXYSQL_PORT` (33182) |
| PgBouncer in transaction mode in front of the PostgreSQL primary | `TEST_PGBOUNCER_PORT` (55482) |

The tests connect over TCP on 127.0.0.1; the Unix sockets in `.runtime/servers` serve only to stop the servers and for the ProxySQL admin interface. `make test-servers TEST_MYSQL_PORT=33172 TEST_POSTGRES_PORT=55472` selects other ports, and the other port variables are set in the same way. ProxySQL publishes packages for Linux; on macOS it is built from its source release. The target:

1. initializes the primaries and their replicas and returns after each server reports that it accepts connections;
2. loads the MySQL time zone tables;
3. creates the databases `orm_test` and `orm_tools` on both primaries, and the replicas apply them;
4. starts ProxySQL and PgBouncer and returns after each logs the line it writes once it listens;
5. writes `.runtime/servers/env` last.

The ProxySQL user is `orm` with the password `orm`. PgBouncer serves every database of the primary and the database `orm_test_single`, which reaches `orm_test` through one server connection. The PostgreSQL primary lists the standby in `synchronous_standby_names` with `synchronous_commit=local`, so a transaction that sets `synchronous_commit=remote_apply` and writes WAL commits after the standby has applied it. A transaction that writes no WAL besides its commit record does not wait; the replica tests write a transactional logical message (`pg_logical_emit_message(true, …)`) in that transaction.

The environment file exports `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TEST_PGBOUNCER_SINGLE_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`, the server DSNs `ORM_RUN_MYSQL_DSN` and `ORM_RUN_POSTGRES_DSN` and the SQLite query `ORM_RUN_SQLITE_QUERY` of the databases of each run, and the DSNs of the MySQL TLS cases `ORM_TEST_MYSQL_TLS_DSN`, `ORM_TEST_MYSQL_TLS_OTHER_CA_DSN` and `ORM_TEST_MYSQL_TLS_MISMATCH_DSN`, and `ORM_TEST_SERVERS_LEASES`, the lease directory of the servers. When the file exists, `make test-servers` prints it and changes nothing. A failed start stops the servers it started and keeps the logs; `make test-servers-stop` stops the servers and removes `.runtime/servers`. The CI workflow `.github/workflows/ci.yml` installs the same programs, starts the servers with `make test-servers` and adds the environment file to the environment of its later steps; it defines none of these variables itself, and `make repo-check` fails when it lacks one, defines one or runs a make target before the servers start.

Runs from any checkout and other tools may use the same servers at once, so their use is leased (`tests/lease`). Every make line that reads `TEST_ENV` holds a shared lease of `ORM_TEST_SERVERS_LEASES` until the line ends. `make test-servers-stop`, a fresh `make test-servers` and the MySQL migration hold the exclusive lease and are refused while any lease is held, naming each holder by checkout, process id, start time and command. A tool outside make holds a shared lease for the life of its process with `.runtime/bin/lease hold <ORM_TEST_SERVERS_LEASES> shared --pid <pid>`. A lease whose process no longer runs is reported as dead and is never taken over: `make test-servers-leases` lists the leases, and `make test-servers-leases-clear` removes the dead ones and names them.

No bench or decimal database is shared. `make check`, `make owner-check` and `make run-databases TARGETS="<target>..."` create the bench and decimal databases of their run with `scripts/check/databases.sh`, seed them, pass them to every target through `TEST_ENV` (`BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`, `ORM_BENCH_MYSQL_DSN`) and `DECIMAL_ENV`, and drop them at the end. A target that reads them fails when it runs with the server environment alone; run it through `make run-databases`.

`make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `client-pooler-check`, `case-database-check`, `conformance-check`, `db-test` and `perf-check` read `.runtime/servers/env` and fail when it is missing. `client-pooler-check` runs the client database tests with `ORM_TEST_POSTGRES_DSN` set to the PgBouncer DSN and `ORM_TEST_MYSQL_DSN` set to the ProxySQL DSN. These targets also export `ORM_TEST_MYSQL_SERVER_DSN` and `ORM_TEST_POSTGRES_SERVER_DSN`, the server DSNs of the environment file, which a pooler check does not replace: the rollback failure cases end the server session of a transaction through them, because ProxySQL takes a text-protocol `KILL` as a command for its own client sessions.

A client database case does not use the database that `ORM_TEST_MYSQL_DSN` or `ORM_TEST_POSTGRES_DSN` names and never assumes that it is empty. A case that checks an empty database or installs a schema creates its own database `orm_case_<pid>_<n>` through that DSN, or its own SQLite file `orm-case-<pid>-<n>.sqlite` in the temporary directory, and drops it when it ends, also after a failure; the user of the DSN needs the privilege to create databases. The statement timeout cases through `orm_test_single` reach only `orm_test`, so they create and drop a table of their own name there. `make case-database-check` leaves a table in both shared databases, runs the model cases of the four clients and fails unless they pass and leave the shared databases, their PostgreSQL schemas, the `orm_case_` databases and the `orm-case-` files as they were.

## Interface changes

Update the shared contract, generated artifacts, language clients, examples, and structure checks together. A client-only public feature is incomplete.

## Commit messages

Use a short English imperative subject that states the action, for example `Implement root IN chunking`. Keep each commit focused.

## Pull requests

Describe the behavior change, affected clients and databases, tests run, and any known limitation. Do not include credentials, production data, or generated files that are not produced by the repository generators.
