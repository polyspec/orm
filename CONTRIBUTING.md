# Contributing

## Required workflow

1. Read `AGENTS.md` when it is present and read the relevant files in `contracts/features.json`.
2. Add a reproducing test for a predicted or observed defect.
3. Implement the smallest complete change across the engine, generators, and all affected clients.
4. Update the paired English and Korean documentation.
5. Run the relevant local checks and record the result in the commit description when needed.

## Test database servers

`make test-servers` starts MySQL 8.4 and PostgreSQL 17 under `.runtime/servers` with the installed `mysqld`, `initdb` and `pg_ctl`. The tests connect over TCP on 127.0.0.1 (the MySQL socket in `.runtime/servers` is used only to stop the server), on `TEST_MYSQL_PORT` (33171) and `TEST_POSTGRES_PORT` (55471); `make test-servers TEST_MYSQL_PORT=33172 TEST_POSTGRES_PORT=55472` selects other ports. The target:

1. initializes both servers and returns after each server reports that it accepts connections;
2. loads the MySQL time zone tables;
3. creates the databases `orm_test`, `orm_tools` and `orm_bench` on both servers;
4. seeds `orm_bench` and `.runtime/servers/orm_bench.sqlite` from `bench/sql` and `bench/seedaes`;
5. writes `.runtime/servers/env` last.

The environment file exports `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`, `ORM_BENCH_MYSQL_DSN`, `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN` and `BENCH_SQLITE_DSN`. When the file exists, `make test-servers` prints it and changes nothing. A failed start stops the servers it started and keeps the logs; `make test-servers-stop` stops the servers and removes `.runtime/servers`.

`make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `conformance-check`, `db-test` and `perf-check` read `.runtime/servers/env` and fail when it is missing.

## Interface changes

Update the shared contract, generated artifacts, language clients, examples, and structure checks together. A client-only public feature is incomplete.

## Commit messages

Use a short English imperative subject that states the action, for example `Implement root IN chunking`. Keep each commit focused.

## Pull requests

Describe the behavior change, affected clients and databases, tests run, and any known limitation. Do not include credentials, production data, or generated files that are not produced by the repository generators.
