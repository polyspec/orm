# Runtime connection

The application supplies connection values from environment injection or a secret manager. The client does not read a configuration file.

The DSN URI is the only database selector:

```text
mysql://user:password@host:3306/app?timezone=%2B09:00
mysql://user@localhost/app?socket=/tmp/mysql.sock
postgres://user:password@host:5432/app?sslmode=disable&timezone=Asia/Seoul
postgres:///app?host=/tmp
sqlite:///var/lib/app.sqlite?_pragma=busy_timeout(5000)
```

- The scheme selects MySQL, PostgreSQL, or SQLite. The client creates the matching native driver and opens its pool; schema loading and hash checks are internal.
- `timezone` sets the connection time zone as an IANA name or a fixed offset. MySQL and PostgreSQL connections set the session time zone, and SQLite values and ORM value functions use it on the client. Without `timezone` the server environment time zone is used. A named zone on MySQL requires the server's time zone tables (`mysql_tzinfo_to_sql`); without them the connection returns `CONFIG`. PostgreSQL datetime columns store instants and are read in the connection time zone.
- The connection configuration takes `poolSize`, the maximum open connections: Go `orm.Config{PoolSize: n}`, PHP `new Config(poolSize: n)`, TypeScript `{ poolSize: n }`, and Rust `Db::connect(dsn, n, config)`. Zero or unset keeps the driver default, and a negative value returns `CONFIG`. The SQLite drivers of PHP, TypeScript, and Rust hold one connection, and PDO has no pool, so the PHP value is the bound a process keeps for itself.
- The connection configuration takes `statementTimeoutMs`, the bound of every statement of the connection: Go `orm.Config{StatementTimeoutMs: n}`, PHP `new Config(statementTimeoutMs: n)`, TypeScript `{ statementTimeoutMs: n }`, and Rust `Config { statement_timeout_ms: n, ..Default::default() }`. Zero or unset keeps the server default, and a negative value returns `CONFIG`. PostgreSQL bounds every statement with `statement_timeout`, which every client sends as a startup parameter of each server connection. MySQL bounds SELECT statements with `max_execution_time`; a write is bounded by the server lock wait timeout (`innodb_lock_wait_timeout`), not by this value. SQLite has no session timeout, so its bound is the DSN `busy_timeout`. A statement the bound stops returns `CANCELED`.
- A flow cancels its statements with the cancellation primitive of its own language, on a connection handle. Go `db.WithContext(ctx)` and TypeScript `db.withSignal(signal)` return a handle on the same connection: models connect to the handle as they connect to the connection, transactions started on it carry the same cancellation, and cancelling the context or the signal ends the statement in flight with `CANCELED` while the connection stays usable. In Rust, dropping the future of a statement cancels it and returns the connection to the pool. PostgreSQL cancels the running statement, MySQL ends the running query, and the TypeScript SQLite driver runs a statement without yielding, so a signal there ends the next statement rather than the one in flight. PHP cancellation is not implemented yet. The chain has no cancellation operation; the connection handle carries it. A handle is a separate value, so `db.Root()` in Go and `db.root()` in TypeScript return the connection it was derived from, and two handles of one connection compare equal.
- A MySQL `socket` parameter connects through a Unix socket. The client enables the found-rows count that optimistic updates rely on.
- A SQLite path must be absolute. The client enables foreign keys and deferred transactions.

Database credentials and AES keys must not be committed, written to runtime files, or included in logs. Pass them through the client connection options after resolving them from the deployment secret source.

## Primary and replicas

The ORM does not route statements between servers. An application that reads from replicas opens one connection per server, one to the primary and one to each replica, and passes the connection a statement uses to the model or row with `connect`:

| Language | Connections | Read through a replica | Write through the primary |
|---|---|---|---|
| PHP | `$master = Orm::connect($primaryDsn, $config);` `$slave1 = Orm::connect($replicaDsn, $config);` | `(new User)($slave1)->name($name)->get()` | `$row->connect($master)->setName($new)->update()` |
| Go | `master, err := model.Connect(primaryDSN, schemaPath, cfg)` `slave1, err := model.Connect(replicaDSN, schemaPath, cfg)` | `model.User().Connect(slave1).Name(name).Get()` | `row.Connect(master).SetName(next).Update()` |
| Rust | `let master = Db::connect(&primary_dsn, n, cfg.clone()).await?;` `let slave1 = Db::connect(&replica_dsn, n, cfg).await?;` | `User::new().connect(&slave1).name(name).get().await?` | `row.connect(&master).set_name(next).update(false).await?` |
| TypeScript | `const master = await Db.connect(primaryDsn, schemaPath, options);` `const slave1 = await Db.connect(replicaDsn, schemaPath, options);` | `new User().connect(slave1).name(name).get()` | `row.connect(master).setName(next).update()` |

- A model or a loaded row uses the connection it is connected to and no other. Inside a transaction of `master`, a model connected to `slave1` runs on `slave1` outside the transaction, and a model without `connect` runs in the transaction.
- Each connection has its own pool, prepared statements, and session settings.
- A replica applies the changes of the primary after the primary commits them. A read that must see a write of the same request uses the primary connection; the application selects it.
- A replica rejects a write: PostgreSQL returns SQLSTATE 25006 and a MySQL replica with `super_read_only` returns error 1290. The clients return this driver error without an ORM error code.
- The schema tools and `utils().schema().install` run on the primary, and the replicas apply the schema through replication.
- SQLite is single-node only. A SQLite database is a local file named by an absolute path, and the ORM supports no SQLite replica.

`make test-servers` starts a replica of the MySQL primary and a standby of the PostgreSQL primary, and the database tests of the four clients check these rules on both databases.

## Connection poolers

A connection pooler stands between the application and one database server and shares a small number of server connections among many client connections. The clients work through PgBouncer in transaction mode for PostgreSQL and through ProxySQL for MySQL, used as poolers only: the application connects to the pooler with the DSN of that server, and the pooler routes no statement to another server. `make client-pooler-check` runs the database tests of the four clients through both.

PgBouncer settings:

| Setting | Value | Reason |
|---|---|---|
| `pool_mode` | `transaction` | A server connection serves one client transaction or one statement outside a transaction at a time. |
| `max_prepared_statements` | above 0 (PgBouncer default 200) | The clients run statements as protocol-level named prepared statements. With 0, a statement prepared on one server connection is missing on the next and PgBouncer returns `prepared statement … already exists` or `does not exist`. |
| `track_extra_parameters` | `statement_timeout` | Needed when a connection sets `statementTimeoutMs`. The clients send `statement_timeout` as a startup parameter; PgBouncer rejects a startup parameter it does not track, and sets a tracked one on every server connection it assigns to that client connection and on no other. |

- Outside a transaction the clients set no PostgreSQL session state other than the time zone, which is a startup parameter or `SET TIME ZONE`; PgBouncer tracks `TimeZone` by default. Transaction options (`SET TRANSACTION`, `SET LOCAL statement_timeout`), `utils().setLocal` (`set_config(…, true)`), and `utils().lock` (`pg_advisory_xact_lock`) end with their transaction.
- Cancellation of a statement works through PgBouncer: PgBouncer forwards the protocol cancel request of a client connection to the server connection that runs its statement. TypeScript sends that request with the process id and secret key of its connection.
- The Rust client does not send the startup parameter `extra_float_digits`; PostgreSQL 12 and later print float8 values exactly with the server default.

ProxySQL runs with its default multiplexing and needs no ORM-specific setting. ProxySQL keeps the `time_zone` and `max_execution_time` of each client connection and applies them on every server connection it uses for it. A statement that contains a user variable, `GET_LOCK`, or `CREATE TEMPORARY TABLE` makes ProxySQL keep that client connection on one server connection until it disconnects. On MySQL, `utils().setLocal` and the audit triggers use the user variable `` @`orm.<key>` `` and `utils().lock` uses `GET_LOCK`, so a connection that uses them is no longer multiplexed; results do not change.

The schema tools (`ormgen`, `orm-gen`) connect to the primary directly, not through a pooler: a migration holds a session-scoped MySQL `GET_LOCK`, and reading the CHECK constraints of a live database creates a temporary table and reads it in later statements.
