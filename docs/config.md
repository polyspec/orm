# `orm.toml` configuration (S5 T5.5)

Every path is absolute and declared; nothing is discovered, no symlinks, no fallbacks. A missing
or relative path is a startup error (`CONFIG`).

```toml
schema = "/srv/app/schema/schema.json"      # the manifest the client was generated from; its schema_hash is checked once at startup

[db]
driver = "mysql"            # mysql (default) | postgres | sqlite — also the engine dialect (ormd -dialect / wasm orm_load_dialect)
                            # Go: a non-mysql driver needs its package imported, see docs/dialects.md
dsn = "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true"   # Go
# dsn = "mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4"          # PHP (PDO)
# dsn = "mysql://root@localhost/orm_bench?socketPath=/tmp/mysql.sock"                  # Rust/TypeScript
# postgres: "postgres://user@host:5432/db?sslmode=disable" (Go/Rust/TypeScript) / "pgsql:host=…;dbname=…;user=…" (PHP)
# sqlite:   "file:/abs/path.sqlite?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)" (Go) / "sqlite:///abs/path.sqlite" (Rust) / "/abs/path.sqlite" (PHP/TypeScript)
user = "root"
password = ""
pool = 8

[secrets]
# aes = "bench-salt"          # single key compatibility form; version 1
# aes_env = "ORM_AES_KEY"     # environment variant of the single key form
# blind_index = "bench-blind-index"      # stable HMAC key for encrypted equality search
# blind_index_env = "ORM_BLIND_INDEX_KEY" # environment variant
aes_version = 2               # current version for new writes and rotation

[secrets.aes_keys]
1 = "old-key"
2 = "current-key"

[engine]                    # Rust native compiler settings
wasm = "/srv/app/bin/ormengine.wasm"
cache_dir = "/var/cache/orm"

[ormd]                      # PHP Unix socket or common Connect compiler service
endpoint = "http://127.0.0.1:8080"
timeout_ms = 5000
socket = "/run/orm/ormd.sock" # PHP default compiler transport

[debug]
on_query = false            # log every statement (sql, binds with secrets masked, duration, plan id)
```

Checks at startup (all four): `schema` exists and its `schema_hash` equals the generated client's
(`SCHEMA_HASH_MISMATCH` otherwise — no watching, no reload); declared `ormd`/`engine` paths exist and are absolute;
an AES key configuration present when the schema has AES columns; `[db].user/password` only with mysql DSNs (other drivers carry the user in the URL); the compiler dialect and IR version must equal `[db].driver` and the client IR version (`CONFIG` or `VERSION_MISMATCH` otherwise). Go, PHP, Rust, and TypeScript use `[ormd].endpoint` for plan compilation.

`aes`, `aes_env`, and `aes_keys` are mutually exclusive. The single-key forms use version 1. A versioned configuration requires a positive `aes_version`, a non-empty key for that version, and positive integer keys under `[secrets.aes_keys]`. New AES-table rows and updates that assign every AES column store `aes_version` in `aes_key_version`. See [S7](s7.md) for status and rotation operations.

`blind_index` and `blind_index_env` are mutually exclusive. A schema with a `blind_index` directive requires one of them. The key is independent from AES keys and remains unchanged during AES rotation. Equality predicates on the mapped AES column bind the lowercase HMAC-SHA256 value of the plaintext to the declared index column. The index column must be a declared single-column index with 64 hexadecimal characters for string storage.

Compiler defaults are language-specific: PHP uses the declared Unix socket, Go uses its in-process compiler, and Rust uses the declared WASM compiler. Connect/Protobuf is the common compiler service path; TypeScript uses it by default. An explicit `[ormd].endpoint` selects Connect/Protobuf where supported.

`fromConfig` opens the configured database; it does not install a default query connection.
Select it for a root query with Go `Using(ctx, db)`, PHP `using($db)`, Rust `using(&db)`, or TypeScript `using(db)`.
A transaction is bound the same way. All relation steps and loaded rows use that root binding.
Terminals such as `getCountByServiceSeq(7)` take only values. Unbound execution and reuse of a
finished transaction return `CONFIG`; rebind to an active handle before executing again.
