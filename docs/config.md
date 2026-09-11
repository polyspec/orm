# `orm.toml` — one declared configuration for the three clients (S5 T5.5)

Every path is absolute and declared; nothing is discovered, no symlinks, no fallbacks. A missing
or relative path is a startup error (`CONFIG`).

```toml
schema = "/srv/app/schema/schema.json"      # the manifest the client was generated from; its schema_hash is checked once at startup

[db]
driver = "mysql"            # mysql (default) | postgres | sqlite — also the engine dialect (ormd -dialect / wasm orm_load_dialect)
                            # Go: a non-mysql driver needs its package imported, see docs/dialects.md
dsn = "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true"   # Go
# dsn = "mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4"          # PHP (PDO)
# dsn = "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock"                      # Rust (sqlx)
# postgres: "postgres://user@host:5432/db?sslmode=disable" (Go/Rust) / "pgsql:host=…;dbname=…;user=…" (PHP)
# sqlite:   "file:/abs/path.sqlite?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)" (Go) / "sqlite:///abs/path.sqlite" (Rust) / "/abs/path.sqlite" (PHP)
user = "root"
password = ""
pool = 8

[secrets]
aes = "bench-salt"          # or aes_env = "ORM_AES_KEY"

[engine]                    # Rust only: the wasm engine and where wasmtime may cache its compilation
wasm = "/srv/app/bin/ormengine.wasm"
cache_dir = "/var/cache/orm"

[ormd]                      # PHP only: the compile daemon
socket = "/run/orm/ormd.sock"

[debug]
on_query = false            # log every statement (sql, binds with secrets masked, duration, plan id)
```

Checks at startup (all three): `schema` exists and its `schema_hash` equals the generated client's
(`SCHEMA_HASH_MISMATCH` otherwise — no watching, no reload); `ormd`/`engine` paths exist and are absolute;
`secrets.aes` or `aes_env` present when the schema has aes columns; `[db].user/password` only with mysql DSNs (other drivers carry the user in the URL); the daemon/engine dialect must equal `[db].driver` (`CONFIG` otherwise).

`fromConfig` opens the configured database; it does not install a default query connection.
Bind it to a root query with Go `Bind(ctx, db)`, PHP `bind($db)`, or Rust `bind(&db)`.
A transaction is bound the same way. All relation steps and loaded rows use that root binding.
Terminals such as `getCountByServiceSeq(7)` take only values. Unbound execution and reuse of a
finished transaction return `CONFIG`; rebind to an active handle before executing again.
