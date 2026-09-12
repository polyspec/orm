# `orm.toml` — one declared configuration for four clients (S5 T5.5)

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
# aes_keys = { "1" = "old-key", "2" = "bench-salt" }  # required for key rotation
# aes_version = 2             # current version for new writes and rotation

[engine]                    # compatibility compiler settings during the Connect migration
wasm = "/srv/app/bin/ormengine.wasm"
cache_dir = "/var/cache/orm"

[ormd]                      # compiler transport
endpoint = "http://127.0.0.1:8080"
timeout_ms = 5000
socket = "/run/orm/ormd.sock" # PHP compatibility executor during the Connect migration

[debug]
on_query = false            # log every statement (sql, binds with secrets masked, duration, plan id)
```

Checks at startup (all four): `schema` exists and its `schema_hash` equals the generated client's
(`SCHEMA_HASH_MISMATCH` otherwise — no watching, no reload); `ormd`/`engine` paths exist and are absolute;
`secrets.aes` or `aes_env` present when the schema has aes columns; `[db].user/password` only with mysql DSNs (other drivers carry the user in the URL); the compiler dialect and IR version must equal `[db].driver` and the client IR version (`CONFIG` or `VERSION_MISMATCH` otherwise). Go and Rust use `[ormd].endpoint` for plan compilation. PHP and TypeScript executor migration remains in T7.1.

`fromConfig` opens the configured database; it does not install a default query connection.
Select it for a root query with Go `Using(ctx, db)`, PHP `using($db)`, or Rust `using(&db)`.
A transaction is bound the same way. All relation steps and loaded rows use that root binding.
Terminals such as `getCountByServiceSeq(7)` take only values. Unbound execution and reuse of a
finished transaction return `CONFIG`; rebind to an active handle before executing again.
