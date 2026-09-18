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
- The connection configuration takes `statementTimeoutMs`, the bound of every statement of the connection: Go `orm.Config{StatementTimeoutMs: n}`, PHP `new Config(statementTimeoutMs: n)`, TypeScript `{ statementTimeoutMs: n }`, and Rust `Config { statement_timeout_ms: n, ..Default::default() }`. Zero or unset keeps the server default, and a negative value returns `CONFIG`. PostgreSQL bounds every statement with `statement_timeout`. MySQL bounds SELECT statements with `max_execution_time`; a write is bounded by the server lock wait timeout (`innodb_lock_wait_timeout`), not by this value. SQLite has no session timeout, so its bound is the DSN `busy_timeout`. A statement the bound stops returns `CANCELED`.
- A flow cancels its statements with the cancellation primitive of its own language, on a connection handle. Go `db.WithContext(ctx)` and TypeScript `db.withSignal(signal)` return a handle on the same connection: models connect to the handle as they connect to the connection, transactions started on it carry the same cancellation, and cancelling the context or the signal ends the statement in flight with `CANCELED` while the connection stays usable. In Rust, dropping the future of a statement cancels it and returns the connection to the pool. PostgreSQL cancels the running statement, MySQL ends the running query, and the TypeScript SQLite driver runs a statement without yielding, so a signal there ends the next statement rather than the one in flight. PHP cancellation is not implemented yet. The chain has no cancellation operation; the connection handle carries it. A handle is a separate value, so `db.Root()` in Go and `db.root()` in TypeScript return the connection it was derived from, and two handles of one connection compare equal.
- A MySQL `socket` parameter connects through a Unix socket. The client enables the found-rows count that optimistic updates rely on.
- A SQLite path must be absolute. The client enables foreign keys and deferred transactions.

Database credentials and AES keys must not be committed, written to runtime files, or included in logs. Pass them through the client connection options after resolving them from the deployment secret source.
