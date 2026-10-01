# Schema dialect fact probes

[Korean](README.ko.md)

These probes record how MySQL, PostgreSQL and SQLite define and enforce
schema objects. `docs/dialects.md` cites each probe ID in its schema
definition tables; a neutral dbspec feature is supported only when the
probes show one meaning on all three databases and a catalog source that
restores it.

## Probe

A probe has a stable ID `<database>.<topic>.<fact>`, the fact it asserts
and a body of DDL, DML and catalog queries. A step that must succeed, a
statement that must fail with a given MySQL error number, PostgreSQL
SQLSTATE or SQLite message, and a query result that must equal a given
text are the only assertions. A probe that observes another value fails;
correcting a probe means recording the observed fact, not weakening it.

Each probe runs in its own disposable object:

| Database | Object | Cleanup |
|---|---|---|
| MySQL | database `dfx_<pid>_<index>`; a login of the same name when the probe needs one | `DROP USER IF EXISTS`, `DROP DATABASE`, then `information_schema.SCHEMATA` must not list it |
| PostgreSQL | schema `dfx_<pid>_<index>` and, when needed, `<schema>_b` | `DROP SCHEMA … CASCADE`, then `pg_namespace` must not list them |
| SQLite | file `dfx_<pid>_<index>.sqlite` in the test's temporary directory | the file and its journal files are removed and must not exist |

## Run

```sh
make dialect-facts-check TEST_ENV=<path of the environment file of make test-servers>
```

The target first checks probe IDs without a database, then runs
`TestDialectFacts` (build tag `physical`) with `ORM_TEST_MYSQL_DSN` and
`ORM_TEST_POSTGRES_DSN` from `TEST_ENV`. SQLite needs no server: the Go
probe connection uses `modernc.org/sqlite`, and `sqlite.env.library`
reports the library version it links.

Every probe logs `start`, `observed` values, and `result … PASS|FAIL after
<elapsed>`; `go test -v` also reports each subtest with its elapsed time.
Each probe has its own 30-second deadline and its cleanup has another 30
seconds, so the go test binary runs with `-timeout 0`. A server that cannot
be reached fails each of its probes with the connection error; the other
databases still run and the summary lines report passed and failed counts
per database.

## Language

The probes are Go tests in shared `tests/`, as are the conformance checker
(`tests/conformance/check`) and the schema recorder (`tests/schema/record`).
The facts belong to the databases, not to a client, so one runner states
them once. The module already links the MySQL (`go-sql-driver/mysql`),
PostgreSQL (`pgx`) and SQLite (`modernc.org/sqlite`) drivers, and Go's
error types expose the MySQL error number and PostgreSQL SQLSTATE that the
assertions compare. The SQLite library differs per client; the versions are
listed in `docs/dialects.md`.
