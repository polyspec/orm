# Contributing

## Required workflow

1. Read `AGENTS.md` when it is present and read the relevant files in `contracts/features.json`. Run
   `make install` once: it downloads what the checks read (npm, Composer and Go dependencies, the Rust
   toolchain and crates, the lowest Node), and the checks run offline, so a missing download fails
   with `run make install`.
2. Add a reproducing test for a predicted or observed defect.
3. Implement the smallest complete change across the engine, generators, and all affected clients.
4. Update the paired English and Korean documentation.
5. Run the unit tests of what changed, its Red/Green cases, and record the result in the commit
   description when needed. End-to-end runs, `make owner-check` and the full suite run in CI after
   the push; no local check is required before a push.
6. The full suite `make check` runs in CI on every pull request and merge group. Before any step it refuses, with the reasons and exit status 2, while an item of `docs/checklist.md` is `[~]`
   (each is named with its ID and title), while tracked files have uncommitted changes, and when
   `.runtime/full-run.json` records a full run of the same tree (`git rev-parse HEAD^{tree}`). The
   record holds the tree, the commit, the result, the targets that did not pass and the times of
   every step, and is written before the first step and after each step, so a killed run stays
   `incomplete`. `make rerun-failed` runs only the targets of the current tree's record that did
   not pass and is refused without such a record.

## Test database servers

`make test-servers` starts these servers under `.runtime/servers` with the installed `mysqld`, `initdb`, `pg_ctl`, `pg_basebackup`, `proxysql` and `pgbouncer`:

| Server |
|---|
| MySQL 8.4 primary |
| PostgreSQL 17 primary |
| MySQL replica of the primary, read-only |
| PostgreSQL standby of the primary |
| ProxySQL in front of the MySQL primary |
| PgBouncer in transaction mode in front of the PostgreSQL primary |

Each server listens on a free port that `make test-servers` chooses on 127.0.0.1 when it starts the servers of this checkout (`scripts/free-ports.mjs`), so the servers of two checkouts never contend for one port; the environment file `.runtime/servers/env` records the ports in its DSNs, and `make test-servers-tls` and a later `make test-servers` read them from it.

The tests connect over TCP on 127.0.0.1; the Unix sockets in `.runtime/servers` serve only to stop the servers and for the ProxySQL admin interface. ProxySQL publishes packages for Linux; on macOS it is built from its source release. The target:

1. initializes the primaries and their replicas and returns after each server reports that it accepts connections;
2. loads the MySQL time zone tables;
3. creates the databases `orm_test` and `orm_tools` on both primaries, and the replicas apply them;
4. starts ProxySQL and PgBouncer and returns after each logs the line it writes once it listens;
5. writes `.runtime/servers/env` last.

The ProxySQL user is `orm` with the password `orm`. PgBouncer serves every database of the primary and the database `orm_test_single`, which reaches `orm_test` through one server connection. The PostgreSQL primary lists the standby in `synchronous_standby_names` with `synchronous_commit=local`, so a transaction that sets `synchronous_commit=remote_apply` and writes WAL commits after the standby has applied it. A transaction that writes no WAL besides its commit record does not wait; the replica tests write a transactional logical message (`pg_logical_emit_message(true, …)`) in that transaction.

The environment file exports `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TEST_PGBOUNCER_SINGLE_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`, the server DSNs `ORM_RUN_MYSQL_DSN` and `ORM_RUN_POSTGRES_DSN` and the SQLite query `ORM_RUN_SQLITE_QUERY` of the databases of each run, and the DSNs of the MySQL TLS cases `ORM_TEST_MYSQL_TLS_DSN`, `ORM_TEST_MYSQL_TLS_OTHER_CA_DSN` and `ORM_TEST_MYSQL_TLS_MISMATCH_DSN`, and `ORM_TEST_SERVERS_LEASES`, the lease directory of the servers. When the file exists, `make test-servers` prints it and changes nothing. A failed start stops the servers it started and keeps the logs; `make test-servers-stop` stops the servers and removes `.runtime/servers`. The CI workflow `.github/workflows/ci.yml` installs the same programs, starts the servers with `make test-servers` and adds the environment file to the environment of its later steps; it defines none of these variables itself, and `make repo-check` fails when it lacks one, defines one or runs a make target before the servers start.

Runs from any checkout and other tools may use the same servers at once, so their use is leased (`tests/lease`). Every make line that reads `TEST_ENV` holds a shared lease of `ORM_TEST_SERVERS_LEASES` until the line ends. `make test-servers-stop`, a fresh `make test-servers` and the MySQL migration hold the exclusive lease and are refused while any lease is held, naming each holder by checkout, process id, start time and command. A tool outside make holds a shared lease for the life of its process with `.runtime/bin/lease hold <ORM_TEST_SERVERS_LEASES> shared --pid <pid>`. A held lease records its holder and the releaser that removes it once the holder ends. A lease whose holder ended while its releaser runs is being released, and a waiting request waits for it. A lease whose holder and releaser both ended is dead and blocks no one: a dead shared lease is taken over by any request, a dead exclusive lease by the next exclusive request, which makes the resource again, and a shared request is refused while a dead exclusive lease remains, because its holder may have left the resource half made. Each takeover is reported. `make test-servers-leases` lists the leases, and `make test-servers-leases-clear` removes the dead ones and names them.

No bench or decimal database is shared. `make check`, `make owner-check` and `make run-databases TARGETS="<target>..."` create the bench and decimal databases of their run with `scripts/check/databases.sh`, seed them, pass them to every target through `TEST_ENV` (`BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`, `ORM_BENCH_MYSQL_DSN`) and `DECIMAL_ENV`, and drop them at the end. A target that reads them fails when it runs with the server environment alone; run it through `make run-databases`.

`make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `client-pooler-check`, `case-database-check`, `conformance-check`, `db-test` and `perf-check` read `.runtime/servers/env` and fail when it is missing. `client-pooler-check` runs the client database tests with `ORM_TEST_POSTGRES_DSN` set to the PgBouncer DSN and `ORM_TEST_MYSQL_DSN` set to the ProxySQL DSN. These targets also export `ORM_TEST_MYSQL_SERVER_DSN` and `ORM_TEST_POSTGRES_SERVER_DSN`, the server DSNs of the environment file, which a pooler check does not replace: the rollback failure cases end the server session of a transaction through them, because ProxySQL takes a text-protocol `KILL` as a command for its own client sessions.

A client database case does not use the database that `ORM_TEST_MYSQL_DSN` or `ORM_TEST_POSTGRES_DSN` names and never assumes that it is empty. A case that checks an empty database or installs a schema creates its own database `orm_case_<pid>_<n>` through that DSN, or its own SQLite file `orm-case-<pid>-<n>.sqlite` in the temporary directory, and drops it when it ends, also after a failure; the user of the DSN needs the privilege to create databases. The statement timeout cases through `orm_test_single` reach only `orm_test`, so they create and drop a table of their own name there. `make case-database-check` leaves a table in both shared databases, runs the model cases of the four clients and fails unless they pass and leave the shared databases, their PostgreSQL schemas, the `orm_case_` databases and the `orm-case-` files as they were.

## Interface changes

Update the shared contract, generated artifacts, language clients, examples, and structure checks together. A client-only public feature is incomplete.

## Commit messages

Use a short English imperative subject that states the action, for example `Implement root IN chunking`. Keep each commit focused.

## Pull requests

Describe the behavior change, affected clients and databases, tests run, and any known limitation. Do not include credentials, production data, or generated files that are not produced by the repository generators.
