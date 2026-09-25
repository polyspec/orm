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
3. creates the databases `orm_test`, `orm_tools` and `orm_bench` on both primaries, and the replicas apply them;
4. seeds `orm_bench` and `.runtime/servers/orm_bench.sqlite` from `bench/sql` and `bench/seedaes`;
5. starts ProxySQL and PgBouncer and returns after each logs the line it writes once it listens;
6. writes `.runtime/servers/env` last.

The ProxySQL user is `orm` with the password `orm`. PgBouncer serves every database of the primary and the database `orm_test_single`, which reaches `orm_test` through one server connection. The PostgreSQL primary lists the standby in `synchronous_standby_names` with `synchronous_commit=local`, so a transaction that sets `synchronous_commit=remote_apply` and writes WAL commits after the standby has applied it. A transaction that writes no WAL besides its commit record does not wait; the replica tests write a transactional logical message (`pg_logical_emit_message(true, …)`) in that transaction.

The environment file exports `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TEST_PGBOUNCER_SINGLE_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`, `ORM_BENCH_MYSQL_DSN`, `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN` and `BENCH_SQLITE_DSN`. When the file exists, `make test-servers` prints it and changes nothing. A failed start stops the servers it started and keeps the logs; `make test-servers-stop` stops the servers and removes `.runtime/servers`.

`make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `client-pooler-check`, `conformance-check`, `db-test` and `perf-check` read `.runtime/servers/env` and fail when it is missing. `client-pooler-check` runs the client database tests with `ORM_TEST_POSTGRES_DSN` set to the PgBouncer DSN and `ORM_TEST_MYSQL_DSN` set to the ProxySQL DSN.

## Interface changes

Update the shared contract, generated artifacts, language clients, examples, and structure checks together. A client-only public feature is incomplete.

## Commit messages

Use a short English imperative subject that states the action, for example `Implement root IN chunking`. Keep each commit focused.

## Pull requests

Describe the behavior change, affected clients and databases, tests run, and any known limitation. Do not include credentials, production data, or generated files that are not produced by the repository generators.
