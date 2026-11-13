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

`make orm-test-container KIND=<mysql|postgres|mariadb>` and `make orm-test-container-run KIND=<kind> RUN='<command>'` start the servers of one kind as a Compose project that the program `bay` runs (`scripts/test-servers-container.mts`): on Apple `container` on macOS and on Docker on Linux. Every step is a command of `bay`, and no container engine is run directly.

**A run executes with `sh` and `bay` alone.** The machine that runs the servers and the checks needs only `sh`, `bay` and the container engine of `bay`; nothing is installed on its host, and no node, cargo, make or git of that host is used. The reason is that the images and the database checks run on a machine with enough disk, which is not the machine of development. So the work is divided: `scripts/test-servers-container.mts` only writes the directory of a run, and the file `run.sh` of that directory, a POSIX `sh` file, executes it. Each step of `run.sh` is one command of `bay -p <project>`, and its exit status decides the run; the file reads no JSON, starts no timer and repeats no request.

**The project of a run.** Each start creates the directory `.runtime/containers/<project>` of its checkout. `<project>` is `orm-<checkout>-<run>`: `<checkout>` is the first 12 hexadecimal digits of the sha256 of the root of the checkout, and `<run>` is 8 random hexadecimal digits of that start. Each command of `bay` takes the project name with its option `-p`, and the Compose file names no project. So two checkouts, and two runs of one checkout, never share a project, a container or a file. The directory is below the checkout, and not below the temporary directory of the system, so that `make orm-test-container-stop` finds the project of a run that was killed before it removed its servers. It holds:

| File | Content |
|---|---|
| `compose.yaml` | The services of the servers, and the service `runner` in the form of the runner |
| `run.sh` | The steps of the run: `sh run.sh` is the whole run, `sh run.sh up` starts the servers and writes `servers.env`, `sh run.sh down` removes the project, `sh run.sh pull` downloads its images |
| `servers.env` | The variables of the started servers, which `run.sh` writes |
| `tls/other-ca.pem` | The second CA of the TLS cases, which signs nothing |
| `<service>-init/` | The initialization files of a service |
| `runner-setup.sh`, `build.sh`, `check.sh`, `repo.bundle` | The form of the runner: its installation, the build command, the command of the run, and the commit of the run |
| `compose.build.yaml`, `compose.run.yaml` | The form of the runner: the Compose file with the runner alone, and with the servers; `compose.yaml` is a copy of one of them |
| `report/` | What a run records: `bay-version`, `steps.log`, and in the form of the runner the output and the status of its commands and the memory of the runner |

**The two forms of a run.** A run has one of two forms. The script records the form in `run.sh` when it writes the directory, and the form does not change while the run executes. In the form of the host the command of the run is a process of the host with the variables of the servers; it gives the results of the system of the host, such as Darwin. In the form of the runner (`FORM=runner`) the command runs in the service `runner` with `bay exec runner`, and the host needs no tool of this repository. Both forms have the same services of the servers and the same steps that prepare them.

**The services.** A project has one service for each server and, in the form of the runner, the service `runner`:

| Kind | Services |
|---|---|
| `mysql` | `mysql`, the primary; `mysql-replica`, its read-only replica |
| `postgres` | `postgres`, the primary; `postgres-replica`, its standby |
| `mariadb` | `mariadb`, the primary |

Each service names the image that `config/containers.json` pins by its digest, the port of its server in `expose`, and no key `ports`, so no port of the host is published. A server takes the settings of the native primary of `make orm-test-servers` (time zone, lower-case table names, binary log retention, InnoDB log space, and for PostgreSQL its WAL and its synchronous standby). The data directory of each image is a `tmpfs` of its service, so the data ends with the container and no volume is left.

**The addresses.** A check reaches a server at the host name that `bay` gives its service, and every DSN names the server by it. The script holds no form and no suffix of a host name: when it writes the directory it reads the host name of each service, and the path of the authority of the certificates, from `bay plan --json` of the machine that will run the directory, and writes them into `compose.yaml` and `run.sh`. The Compose file is therefore written once for the plan and once with the host names of the plan, which the standby of PostgreSQL names in its command. The IPv4 address of the mismatch DSN exists only after the start: `run.sh` reads it as the first word that `getent ahostsv4 <host name>` prints in the container of the primary (`getent hosts` prints the IPv6 address of a service first), and a host name that has no address there fails the run, so a directory that was written for another `bay` than the one that runs it fails and connects to nothing.

**Readiness.** Each service declares a Compose `healthcheck` that runs the readiness program of its server inside the container, over TCP on 127.0.0.1, because the temporary server that an image starts to initialize a data directory listens only on its socket: `mysqladmin ping` for MySQL, `pg_isready` for PostgreSQL, and `healthcheck.sh --connect --innodb_initialized`, the script of the image, for MariaDB. The standby of PostgreSQL declares `depends_on` with the condition `service_healthy` on its primary. The servers are ready when `bay up` returns with exit status 0: `run.sh` waits for that command alone. It reads no log of a container, starts no timer and repeats no request. The bound of a start is the `healthcheck` of the Compose file, where `bay` requires it: `start_period` is 600 s, the time in which an image initializes its data directory, which takes minutes on a loaded machine, and a failed probe in that time is not counted; after it, 10 probes (`retries`, which `bay` accepts from 1 to 100) one second apart (`interval`), each with a limit of 5 s (`timeout`), fail the start. A container that stops fails the start at once.

**The setup of a started server.** After `bay up` returned, `run.sh` runs each step that prepares a server in its container with `bay exec`, to its end and in the order of the native servers; a step that exits with another status than 0 removes the project and ends the run with that status, naming the step.

| Step | Where it runs | Reason for the place |
|---|---|---|
| MySQL: `RESET BINARY LOGS AND GTIDS` on the primary | `bay exec`, first | The binary log holds the initialization of the image, which the image of the replica ran as well; the reset must come after that initialization and before the replica reads the log |
| MySQL: the replica names its source, starts its replication, and sets `super_read_only` and `partial_revokes` | `bay exec`, second | `START REPLICA` connects to the primary, and both settings change a running server; the replica has `--skip-replica-start`, so it reads nothing before the reset |
| MySQL and MariaDB: the databases `orm_test` and `orm_tools` and the accounts of the user `orm` | `bay exec`, last | The MySQL replica applies them from the binary log, so they come after it follows |
| PostgreSQL: the rule of `pg_hba.conf` that lets the role `orm` replicate | A file of `/docker-entrypoint-initdb.d` of the primary | `bay up` starts the standby as soon as the primary is healthy, so the rule must hold before the primary accepts its first connection |
| PostgreSQL: the standby is a `pg_basebackup` of the primary through the slot `orm_replica` | The command of the service `postgres-replica` | It fills the data directory before the server of the standby starts |
| PostgreSQL: the databases `orm_test` and `orm_tools` | `bay exec` | The primary creates them after the standby follows it, as the native primary does |

**A run owns its servers.** `run.sh` removes its project with `bay down` when its command ends or fails, when a step fails, and on SIGINT, SIGTERM and SIGHUP, so a run whose `ssh` connection ends removes its servers; the command of the run gets SIGTERM for each of these signals, because a command that `sh` starts beside itself ignores SIGINT. A run whose `bay up` fails prints the last lines of each service with `bay logs` first. `run.sh` writes the file `started` before `bay up` and the file `removed` after `bay down`; `make orm-test-container-run` removes the directory of a run that ended, and leaves a directory that has `started` and not `removed`, whose project is not removed. `KEEP=1` keeps the directory of a run that ended, for the tools and the build of the runner, and `sh <directory>/run.sh` runs it again. `make orm-test-container-stop` holds the exclusive lease of the servers of the checkout and removes every project of the checkout, the project of a killed run included; it never removes a project of another checkout.

**The images.** No run downloads an image. Before `bay up`, `run.sh` runs `bay images`, which fails when an image of the project is not on the machine, and the run fails naming `make orm-install-container-images`; `bay up` runs with `-no-pull`, which fails before it creates anything when an image is absent. On the machine of development `make orm-install-container-images` is the only command that downloads an image: it runs `bay pull` on a Compose file that names the images of the servers and of the runner, in a directory that it removes. On another machine `sh run.sh pull`, which `PULL=1` runs, pulls the images of the project.

**The variables.** `run.sh` writes `servers.env` after the last step. `make orm-test-container` copies it to `.runtime/containers/<kind>.env`, and a run gives its variables to its command. The MySQL and PostgreSQL variables are those of the primary of `TEST_ENV`, the MariaDB variables those of the primary of `MARIADB_ENV`, with the replica DSN of MySQL and PostgreSQL. Each server presents the certificate that `bay` issues for the host name of its service and mounts in its container, so the script issues no certificate of a server: the TLS DSN verifies it with the authority of `bay`; the DSN with the second CA, which the script issues for the run and which signs nothing, fails the chain; and the mismatch DSN connects to the IPv4 address of the primary, which the certificate does not name. In the form of the host the DSNs name the authority and the second CA by their paths on the host; in the form of the runner by their paths in the runner. No pooler is started; its variables are absent, and a check that reads one fails naming the variable.

**The service `runner`.** It runs a Debian base image that `config/containers.json` pins by its digest, with a command that does not end; no image of this repository is built and no registry holds one. It mounts the directory of the run at `/orm-run` and nothing of the checkout of the host: the host of development and the runner are different systems, and their tools, packages and build outputs in one checkout would replace each other. The runner works in its own clone, `/orm-run/repo`, of `repo.bundle`, a Git bundle of the commit of the checkout that the script writes; git runs in the runner and not on the host. A run in the runner is therefore a run of a commit, and the script refuses a checkout whose tracked files differ from it. The tools (`CARGO_HOME`, `RUSTUP_HOME`, the node of the machine), the packages and the cargo target directory are below the directory of the run, and no named volume is used, so removing the directory removes them all.

`runner-setup.sh` installs the runner, as root in the container, in the order of the first installation of this document: the packages of Debian, the node of the machine, rustup, the clone, `npm ci` with the npm of `devEngines`, `make install-tools TOOLS=npm`, `make install-packages`, `make install-tools`, and the Rust toolchain of `rust-toolchain.toml`. It is an installation step and downloads; each file that it downloads outside a package manager is used only with the sha256 that `config/containers.json` pins for the processor. A step that a kept directory already has is skipped.

| Installed | Reason |
|---|---|
| `git` | Clones the bundle; the tools of the repository read the tracked files through it |
| `make`, `gcc`, `g++`, `pkg-config`, `libssl-dev` | The recipes, and the native code that the crates and the packages build |
| `curl`, `ca-certificates`, `xz-utils`, `unzip`, `openssl` | The downloads of the setup and of the installers, and the TLS files of the checks |
| `php8.4-cli`, `php8.4-xml`, `php8.4-mbstring`, `php8.4-curl`, `php8.4-zip`, `composer` | The PHP of `.php-version` with the extensions that the PHP checks load |
| `lld` | The linker of the Rust builds of the runner |
| The node tarball of nodejs.org, at the release that `mise.toml` pins | The node of the machine, which the first `npm ci` and `make install-tools TOOLS=npm` need |
| `rustup-init`, at the release that `config/containers.json` pins | Installs the toolchain of `rust-toolchain.toml` |

The runner links with `lld` (`rustflags = ["-C", "link-arg=-fuse-ld=lld"]` for the Linux targets): on a machine with 3.7 GiB of memory a build of the tests of one commit from an empty target directory took 30 minutes and 3.0 GiB of swap with the default linker, and 16 minutes 22 seconds and 0.86 GiB with `lld`. The setting is the `config.toml` of the `CARGO_HOME` of the runner, so no run of the host reads it. The runner keeps the trust and the certificate of `bay`, as each service does: `bay` mounts its files below `/etc/bay` and puts no file over the certificate store of the image, so the setup installs `ca-certificates` like any package. The TLS DSNs of the runner name the authority of `bay` at the path where `bay` mounts it in a container, which `bay plan --json` gives (`certificate.containerCa`). The service has no port and declares `restart: "no"`, so it is not started again when it stops. The memory limits and the count of jobs of the runner are given by the one who runs, as stated below.

`check.sh` runs the command of the run in the clone with the tools of the runner and the variables of `servers.env`. Its output is also `report/check.log`, its exit status `report/status`, and `ORM_RUN_REPORT` names `report/` for what the command adds. `build.sh` runs the build command in the same way, without the variables of the servers, and leaves `report/build.log` and `report/build-status`.

**The memory of a run.** The containers of a run share the memory of one machine, and a machine may end them at a sum: on a machine where the containers of `bay` together slow down at 2.6 GB and are ended at 3.0 GB, a build of the Rust tests, whose highest memory was measured at 3146 to 3196 MiB, does not fit beside two servers. So a run in the runner starts in two steps. `bay up` first starts the runner alone, from `compose.build.yaml`; `run.sh` installs it and runs the build command (`BUILD`) when the run has one, such as the target that builds the tests without running them. A second `bay up`, from `compose.run.yaml`, then adds the servers and keeps the runner, whose declaration is the same in both files; the steps that prepare the servers and the command of the run (`RUN`) follow. A build that fails ends the run with its status, and no server starts. A run without `BUILD` has the same two steps, and its command builds what it needs beside the servers.

Three values are given by the one who runs, for the machine, and this repository holds no value of them, because the highest memory of a build grows with the count of its jobs and the memory of machines differs: `CARGO_BUILD_JOBS`, the count of the jobs of cargo, which `runner-setup.sh` writes into the cargo configuration of the runner; `RUNNER_MEMORY`, the `mem_limit` of the runner, which has none without it; and `SERVER_MEMORY`, the `mem_limit` of each server, which is 4 GiB without it, since `mysqld` is ended in the 1 GiB that a container has by default.

`run.sh` records what a run used: the time of each step in its output and in `report/steps.log`, and the highest memory and swap of the runner, which the kernel keeps in `memory.peak` and `memory.swap.peak` of its cgroup, in `report/runner-memory.peak` and `report/runner-memory.swap.peak` before the project is removed, and with the suffix `.build` after the build command. A kernel without these files leaves the failure in `report/steps.log` and the run goes on, because a measurement does not decide a run.

**A run on another machine.** `bay` starts and removes a project only on the machine where it runs, so servers on another machine mean that the whole run executes there. `make orm-test-container-remote KIND=<kind> RUN='<command>' HOST=<ssh host> REMOTE=<directory>` writes a run in the form of the runner with the plan of the `bay` of that machine, which it reads through `ssh`, sends the directory of the run into `<directory>/<project>` as a tar archive through `ssh`, runs `ssh <host> sh <directory>/<project>/run.sh`, brings `report/` back to `.runtime/containers/reports/<project>`, and removes the directory there unless `KEEP=1`. Its exit status is that of `run.sh`. `run.sh` names no machine: only this target names the host and the directory.

**Checks through a Unix socket.** `bay` publishes no Unix socket on the host, and a socket of a container is not reached from another container, since each container of Apple `container` has a kernel of its own. So `ORM_TEST_MYSQL_SOCKET` and `ORM_TEST_MARIADB_SOCKET` are absent from `servers.env`, and a check that connects through the socket of a server runs in the container of that server. The design, which BAY8 implements in the form of the runner: the runner builds each program that reads a socket variable as a static executable for Linux, because the images of MySQL and MariaDB hold other libraries than the runner, into a directory of the run that the service of the server mounts read-only; `run.sh` runs `bay exec -e <variable>=<value> <server service> <program>` with the socket path of the image and the DSNs of the project, and the exit status of that command is the result of the check. Until BAY8 is done a check that reads a socket variable fails naming it.

**One start of a kind.** `make orm-test-container` refuses a kind that it has started in the checkout and that `make orm-test-container-stop` has not removed, because `.runtime/containers/<kind>.env` names one project. Runs of `make orm-test-container-run` are not counted: each has its own project and writes no shared file.

**`bay` is a tool of the machine.** A run takes the `bay` of its machine, as it takes `make`, and neither pins nor compares its version. What changes the result of a run is not the number of a release but the contract of the output that the script and `run.sh` read, so both check the contract schema version that they are written for, which `bay version` reports, before they create anything, and fail for another one. The `bay` of a machine of development is rebuilt often, and a comparison of numbers would only stop work. `run.sh` writes the line of `bay version` to its output and to `report/bay-version`, so the record of a run names the `bay` that ran it. A run on another machine reads the contract of the `bay` of that machine through `ssh` before it writes or sends anything.

**The release that CI installs.** A CI job has no `bay` and must download one, so which release it takes is in a tracked file: `config/containers.json` pins under `bay` the version, the address of the files, and the sha256 of the archive of each platform, from `SHA256SUMS` of that release. `make orm-install-bay` downloads the archive of the platform, uses it only with that sha256, and puts `bay` and `bayd` into `var/tools/bay` of the checkout; it changes nothing of the machine. `make orm-install-bay-machine` runs `bay install`, which applies the machine setup that is missing and asks for the rights that it needs, and `bay check -scope run`, which fails while a part that a run needs is missing; a person or a CI job runs it, and no other target changes the machine setup. No run reads this pin. It is raised in one change: the version, the address and the four sha256 take the values of the new release and of its `SHA256SUMS`, and `SCHEMA` of the script follows when the release reports another contract schema version, with what that contract changes in the Compose file and in `run.sh`.

**The command of `bay`.** `run.sh` takes the command of `bay` from one variable, `BAY_COMMAND`, of one or more words; without it, it runs `bay` of `PATH`, which is also the value of the Makefile. The one who starts the run sets it, because only that one knows as which user `bay` runs on the machine: `bay` keeps its state below the home of the user that runs it, and on Linux its machine setup and its commands need root, so every command of one machine must run as the same user. A CI runner, whose user has `sudo` without a password, sets `BAY_COMMAND='sudo -n <path of bay>'` with the path of `var/tools/bay/bay`, so that `bay install` and each command of a run are of root. `make orm-test-container-remote` passes `REMOTE_BAY_COMMAND`, the command on the other machine, to the `run.sh` that it starts there.

**A missing program.** A start fails before it creates anything when `BAY_COMMAND` names no program: the message names the program and what it does for the run. `run.sh` makes the same check on the machine that runs it.

`make orm-test-container-check` tests these rules against a stand-in `bay` that each test writes, so it needs no container and no image.

## Interface changes

Update the shared contract, generated artifacts, language clients, examples, and structure checks together. A client-only public feature is incomplete.

## Commit messages

Use a short English imperative subject that states the action, for example `Implement root IN chunking`. Keep each commit focused.

## Changes

Describe the behavior change, affected clients and databases, tests run, and any known limitation in the commit message and the changelog entry. Do not include credentials, production data, or generated files that are not produced by the repository generators.
