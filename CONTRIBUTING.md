<!-- doc-id: contributing -->
# Contributing

## Required workflow

1. Read `AGENTS.md` when it is present and read the relevant files in `contracts/features.json`. A
   fresh checkout has no Makefile targets until kit is installed, since the Makefile includes it, so the first step runs
   `npm ci` with the npm that `devEngines` of `package.json` names, from outside the checkout, because the npm of the
   machine refuses another version inside it:

   ```sh
   root="$PWD"
   version="$(node -p 'require("./package.json").devEngines.packageManager.version')"
   (cd "${TMPDIR:-/tmp}" && npm exec --yes --package="npm@$version" -- sh -c "cd '$root' && npm ci --ignore-scripts --allow-remote=root")
   ```

   Then `make install-tools TOOLS=npm` installs the npm of `mise.toml`, and `make link` (or `make install-packages`) takes the
   packages. Then run `make install` once: it downloads what the checks read (npm, Composer and Go dependencies, the Rust
   toolchain and crates, the lowest Node), and the checks run offline, so a missing download fails
   with `run make install`.
2. Add a reproducing test for a predicted or observed defect.
3. Implement the smallest complete change across the engine, generators, and all affected clients.
4. Update the paired English and Korean documentation.
5. Run the unit tests of what changed, its Red/Green cases, and record the result in the commit
   description when needed. End-to-end runs, `make owner-check` and the full suite run in CI after
   the push; no local check is required before a push.
6. The full suite runs in CI after a push to `main` (`make check-run GROUP=<group>`). For an explicit
   local final verification after every checklist item is terminal, run `make orm-check`, which runs
   `make ci-targets TARGETS=check-run` and records the report under `var/report/ci-targets`.

## Test database servers

`make orm-test-servers` starts these servers under `.runtime/servers` with the installed `mysqld`, `initdb`, `pg_ctl`, `pg_basebackup`, `proxysql` and `pgbouncer`:

| Server |
|---|
| MySQL 8.4 primary |
| PostgreSQL 17 primary |
| MySQL replica of the primary, read-only |
| PostgreSQL standby of the primary |
| ProxySQL in front of the MySQL primary |
| PgBouncer in transaction mode in front of the PostgreSQL primary |

Each server listens on a free port that `make orm-test-servers` chooses on 127.0.0.1 when it starts the servers of this checkout (`scripts/free-ports.mts`), so the servers of two checkouts never contend for one port; the environment file `.runtime/servers/env` records the ports in its DSNs, and `make orm-test-servers-tls` and a later `make orm-test-servers` read them from it.

The tests connect over TCP on 127.0.0.1; the Unix sockets serve only to stop the servers and for the ProxySQL admin interface. They live in `/tmp/orm-servers-<n>`, where `<n>` is the POSIX `cksum` of the checkout path, so a deep checkout stays within the Unix socket path limit (103 bytes on macOS, 107 on Linux); the folder's file `checkout` names its checkout, `make orm-test-servers` refuses a folder another checkout or user owns and fails naming any socket path over the limit, and `make orm-test-servers-stop` removes the folder. ProxySQL publishes packages for Linux; on macOS it is built from its source release. The target:

1. initializes the primaries and their replicas and returns after each server reports that it accepts connections;
2. loads the MySQL time zone tables;
3. creates the databases `orm_test` and `orm_tools` on both primaries, and the replicas apply them;
4. starts ProxySQL and PgBouncer and returns after each logs the line it writes once it listens;
5. writes `.runtime/servers/env` last.

The ProxySQL user is `orm` with the password `orm`. PgBouncer serves every database of the primary. The PostgreSQL primary lists the standby in `synchronous_standby_names` with `synchronous_commit=local`, so a transaction that sets `synchronous_commit=remote_apply` and writes WAL commits after the standby has applied it. A transaction that writes no WAL besides its commit record does not wait; the replica tests write a transactional logical message (`pg_logical_emit_message(true, …)`) in that transaction.

The environment file exports `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`, the server DSNs `ORM_RUN_MYSQL_DSN` and `ORM_RUN_POSTGRES_DSN` and the SQLite query `ORM_RUN_SQLITE_QUERY` of the databases of each run, and the DSNs of the MySQL TLS cases `ORM_TEST_MYSQL_TLS_DSN`, `ORM_TEST_MYSQL_TLS_OTHER_CA_DSN` and `ORM_TEST_MYSQL_TLS_MISMATCH_DSN`, and `ORM_TEST_SERVERS_LEASES`, the lease directory of the servers. When the file exists, `make orm-test-servers` prints it and changes nothing. A failed start stops the servers it started and keeps the logs; `make orm-test-servers-stop` stops the servers and removes `.runtime/servers`. The CI workflow `.github/workflows/ci.yml` installs the same programs, starts the servers with `make orm-test-servers` and adds the environment file to the environment of its later steps; it defines none of these variables itself, and `make repo-check` fails when it lacks one, defines one or runs a make target before the servers start.

Runs from any checkout and other tools may use the same servers at once, so their use is leased (`tests/lease`). Every make line that reads `TEST_ENV` holds a shared lease of `ORM_TEST_SERVERS_LEASES` until the line ends. `make orm-test-servers-stop`, a fresh `make orm-test-servers` and the MySQL migration hold the exclusive lease and are refused while any lease is held, naming each holder by checkout, process id, start time and command. A tool outside make holds a shared lease for the life of its process with `.runtime/bin/lease hold <ORM_TEST_SERVERS_LEASES> shared --pid <pid>`. A held lease records its holder and the releaser that removes it once the holder ends. A lease whose holder ended while its releaser runs is being released, and a waiting request waits for it. A lease whose holder and releaser both ended is dead and blocks no one: a dead shared lease is taken over by any request, a dead exclusive lease by the next exclusive request, which makes the resource again, and a shared request is refused while a dead exclusive lease remains, because its holder may have left the resource half made. Each takeover is reported. `make orm-test-servers-leases` lists the leases, and `make orm-test-servers-leases-clear` removes the dead ones and names them.

No bench or decimal database is shared. `make check-run`, `make feature-owner-check` and `make run-databases TARGETS="<target>..."` create the bench and decimal databases of their run with `scripts/check/databases.mts`, seed them, pass them to every target through `TEST_ENV` (`BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`, `ORM_BENCH_MYSQL_DSN`) and `DECIMAL_ENV`, and drop them at the end. A target that reads them fails when it runs with the server environment alone; run it through `make run-databases`.

`make orm-check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `client-pooler-check`, `case-database-check`, `conformance-check`, `db-test` and `perf-check` read `.runtime/servers/env` and fail when it is missing. `client-pooler-check` runs the client database tests with `ORM_TEST_POSTGRES_DSN` set to the PgBouncer DSN and `ORM_TEST_MYSQL_DSN` set to the ProxySQL DSN. These targets also export `ORM_TEST_MYSQL_SERVER_DSN` and `ORM_TEST_POSTGRES_SERVER_DSN`, the server DSNs of the environment file, which a pooler check does not replace: the rollback failure cases end the server session of a transaction through them, because ProxySQL takes a text-protocol `KILL` as a command for its own client sessions.

A client database case does not use the database that `ORM_TEST_MYSQL_DSN` or `ORM_TEST_POSTGRES_DSN` names and never assumes that it is empty. A case that checks an empty database or installs a schema creates its own database `orm_case_<pid>_<n>` through that DSN, or its own SQLite file `orm-case-<pid>-<n>.sqlite` in the temporary directory, and drops it when it ends, also after a failure; the user of the DSN needs the privilege to create databases. `make case-database-check` leaves a table in both shared databases, runs the model cases currently supported by Go, PHP, TypeScript, Python and Rust; PHP extension database cases remain separately tracked and fails unless they pass and leave the shared databases, their PostgreSQL schemas, the `orm_case_` databases and the `orm-case-` files as they were.

## Test database servers in containers

`make orm-test-container KIND=<mysql|postgres|mariadb>` and `make orm-test-container-run KIND=<kind> RUN='<command>'` start the servers of one kind as a Compose project that the program `bay` runs (`scripts/test-servers-container.mts`): on Apple `container` on macOS and on Docker on Linux. The script starts and removes the servers only through `bay up` and `bay down`. It runs the container engine only for the images, as the rule of the images below states.

**The project of a run.** Each start creates the directory `.runtime/containers/<project>` of its checkout and writes `compose.yaml`, the TLS files and the initialization files of its servers into it. `<project>` is `orm-<checkout>-<run>`: `<checkout>` is the first 12 hexadecimal digits of the sha256 of the root of the checkout, and `<run>` is 8 random hexadecimal digits of that start. The Compose file names the project in its key `name`, because `bay` reads the project name only from that key or from the name of the directory. So two checkouts, and two runs of one checkout, never share a project, a container or a file. The directory is below the checkout, and not below the temporary directory of the system, so that `make orm-test-container-stop` finds the project of a run that was killed before it removed its servers.

**The services.** A project has one service for each server, and no other service:

| Kind | Services |
|---|---|
| `mysql` | `mysql`, the primary; `mysql-replica`, its read-only replica |
| `postgres` | `postgres`, the primary; `postgres-replica`, its standby |
| `mariadb` | `mariadb`, the primary |

Each service names the image that `config/containers.json` pins by its digest, the port of its server in `expose`, and no key `ports`, so no port of the host is published. A check reaches a server at `<project>-<service>.container.test:<port>`, the name that `bay` gives a service, and every DSN of the environment names the server by that name. A server takes the settings of the native primary of `make orm-test-servers` (time zone, lower-case table names, binary log retention, InnoDB log space, and for PostgreSQL its WAL and its synchronous standby). Its data is in the writable layer of its container, so `bay down` removes the data with the container and no volume is left.

**The setup of a server.** `bay` runs no command in a started container, so each step that prepares a server is a file of the directory `/docker-entrypoint-initdb.d` of its service, which the image runs once, before the server accepts connections over TCP:

- the MySQL primary resets its binary log and then creates the databases `orm_test` and `orm_tools` and the accounts of the user `orm`, so its binary log holds these statements and none of the initialization of the image;
- the MySQL replica names the primary as its replication source and persists `super_read_only` and `partial_revokes`; it starts after the primary is healthy, reads the binary log of the primary from its first file when its server starts, and so applies the databases and the accounts;
- the PostgreSQL primary lets the role `orm` replicate and creates the databases `orm_test` and `orm_tools`; the standby starts after the primary is healthy, as a `pg_basebackup` of the primary through the slot `orm_replica`;
- the MariaDB primary creates the databases and the accounts.

**Readiness.** Each service declares a Compose `healthcheck` that runs the readiness program of its server inside the container, over TCP on 127.0.0.1, because the temporary server that an image starts to initialize a data directory listens only on its socket: `mysqladmin ping` for MySQL, `pg_isready` for PostgreSQL, and `healthcheck.sh --connect --innodb_initialized`, the script of the image, for MariaDB. A replica declares `depends_on` with the condition `service_healthy` on its primary. The servers are ready when `bay up` returns with exit status 0: the script waits for that process alone. It reads no log of a container, starts no timer and repeats no request. The interval (1 s), the time limit of one probe (5 s) and the count of probes (600) of a `healthcheck` are settings of the probe of `bay`, which requires a count; the count is set far above the time a start takes on a loaded machine, and a start that uses it up fails as an unhealthy service.

**A run owns its servers.** `make orm-test-container-run` removes its project with `bay down`, and then the directory of the project, when its command ends or fails and when the run gets SIGINT or SIGTERM, which it forwards to its command. A start whose `bay up` fails prints the last lines of each service with `bay logs`, removes the project in the same way, and fails naming the project and the exit status. `make orm-test-container-stop` holds the exclusive lease of the servers of the checkout and removes every project of the checkout, the project of a killed run included; it never removes a project of another checkout.

**The images.** No start downloads an image. `bay` has no command that pulls an image and no setting that refuses a pull, so before `bay up` the script asks the container engine of the platform (`CONTAINER_PROGRAM`: Apple `container` on macOS) whether each image of the project is on the machine (`image inspect`), and a start with an absent image fails naming the image and `make orm-install-container-images`. That target is the only command that pulls, and it pulls with the engine (`image pull`) until `bay` has a command for it.

**The variables.** `make orm-test-container` writes `.runtime/containers/<kind>.env` after `bay up` returned, and `make orm-test-container-run` gives the same variables to its command and writes no file. The MySQL and PostgreSQL variables are those of the primary of `TEST_ENV`, the MariaDB variables those of the primary of `MARIADB_ENV`, with the replica DSN of MySQL and PostgreSQL. Each server has TLS with a certificate that the script issues for the start and that names the host name of the service: the TLS DSN connects to that name, the DSN with the second CA fails the chain, and the mismatch DSN connects to the IPv4 address that the host name resolves to, which the certificate does not name. No pooler is started, and no Unix socket of a server is on the host, because `bay` publishes none; their variables are absent, and a check that reads one fails naming the variable.

**One start of a kind.** `make orm-test-container` refuses a kind that it has started in the checkout and that `make orm-test-container-stop` has not removed, because `.runtime/containers/<kind>.env` names one project. Runs of `make orm-test-container-run` are not counted: each has its own project and writes no shared file.

**A missing program.** A start fails before it creates anything when `BAY_PROGRAM` or `CONTAINER_PROGRAM` names no program: the message names the path, what the program does for the script, and what provides it.

`make orm-test-container-check` tests these rules against a stand-in `bay` and a stand-in container engine that each test writes, so it needs no container and no image.

## Interface changes

Update the shared contract, generated artifacts, language clients, examples, and structure checks together. A client-only public feature is incomplete.

## Commit messages

Use a short English imperative subject that states the action, for example `Implement root IN chunking`. Keep each commit focused.

## Changes

Describe the behavior change, affected clients and databases, tests run, and any known limitation in the commit message and the changelog entry. Do not include credentials, production data, or generated files that are not produced by the repository generators.
