# `orm.toml` — 네 클라이언트의 선언 설정 (S5 T5.5)

모든 경로는 절대 경로로 선언한다. 자동 검색, symlink, 폴백을 사용하지 않는다. 경로가 없거나 상대 경로이면 시작 단계에서 `CONFIG` 오류를 반환한다.

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

시작 시 네 클라이언트는 `schema` 존재 여부와 생성 클라이언트의 `schema_hash` 일치를 검사한다. 불일치이면 `SCHEMA_HASH_MISMATCH`를 반환하고 감시와 재로드를 수행하지 않는다. `ormd`와 `engine` 경로는 절대 경로이며 실제 파일 또는 디렉터리여야 한다. AES 컬럼이 있으면 `secrets.aes` 또는 `aes_env`가 필요하다. `[db].user/password`는 MySQL DSN에서만 사용한다. 다른 driver는 URL에 사용자를 지정한다. compiler의 방언과 IR version은 `[db].driver` 및 client IR version과 같아야 한다. 위반 시 `CONFIG` 또는 `VERSION_MISMATCH`를 반환한다. Go와 Rust는 plan compile에 `[ormd].endpoint`를 사용한다. PHP와 TypeScript executor 전환은 T7.1에 남아 있다.

`fromConfig`는 설정된 데이터베이스를 열지만 기본 query 연결을 설치하지 않는다. 루트 query에 Go는 `Using(ctx, db)`, PHP는 `using($db)`, Rust는 `using(&db)`를 사용한다. relation 단계와 로드된 row는 루트 연결을 사용한다. `getCountByServiceSeq(7)` 같은 terminal에는 값만 전달한다. 연결하지 않은 실행과 종료된 transaction의 재사용은 `CONFIG`를 반환한다.
