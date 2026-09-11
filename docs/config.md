# `orm.toml` — one declared configuration for the three clients (S5 T5.5)

Every path is absolute and declared; nothing is discovered, no symlinks, no fallbacks. A missing
or relative path is a startup error (`CONFIG`).

```toml
schema = "/srv/app/schema/schema.json"      # the manifest the client was generated from; its schema_hash is checked once at startup

[db]
dsn = "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true"   # Go
# dsn = "mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4"          # PHP (PDO)
# dsn = "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock"                      # Rust (sqlx)
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
`secrets.aes` or `aes_env` present when the schema has aes columns.
