# `orm.toml` 설정 (S5 T5.5)

모든 경로는 절대 경로로 선언한다. 자동 검색, symlink, 폴백을 사용하지 않는다. 경로가 없거나 상대 경로이면 시작 단계에서 `CONFIG` 오류를 반환한다.

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

시작 시 네 클라이언트는 `schema` 존재 여부와 생성 클라이언트의 `schema_hash` 일치를 검사한다. 불일치이면 `SCHEMA_HASH_MISMATCH`를 반환하고 감시와 재로드를 수행하지 않는다. 선언된 `ormd`와 `engine` 경로는 절대 경로이며 실제 파일 또는 디렉터리여야 한다. AES 컬럼이 있으면 AES 키 설정이 필요하다. `[db].user/password`는 MySQL DSN에서만 사용한다. 다른 driver는 URL에 사용자를 지정한다. compiler의 SQL dialect과 IR version은 `[db].driver` 및 client IR version과 같아야 한다. 위반 시 `CONFIG` 또는 `VERSION_MISMATCH`를 반환한다. Go·PHP·Rust·TypeScript는 plan compile에 `[ormd].endpoint`를 사용한다.

`aes`, `aes_env`, `aes_keys`는 함께 사용할 수 없다. 단일 키 형식은 버전 1을 사용한다. 버전 설정은 양의 정수 `aes_version`, 해당 버전의 비어 있지 않은 키, `[secrets.aes_keys]`의 양의 정수 키를 요구한다. AES 테이블의 신규 행과 모든 AES 컬럼을 대입하는 update는 `aes_version`을 `aes_key_version`에 저장한다. 상태 조회와 회전 절차는 [S7](s7.ko.md)에서 설명한다.

`blind_index`와 `blind_index_env`는 함께 사용할 수 없다. `blind_index` directive가 있는 schema는 둘 중 하나를 요구한다. 이 key는 AES key와 분리되며 AES rotation 중에도 유지된다. 매핑된 AES 컬럼의 equality predicate는 plaintext의 lowercase HMAC-SHA256 값을 선언된 index 컬럼에 bind한다. index 컬럼은 single-column index로 선언되어야 하며 string 저장 시 64개의 hexadecimal 문자를 저장할 수 있어야 한다.

compiler 기본 경로는 언어별로 다르다. PHP는 선언된 Unix socket, Go는 in-process compiler, Rust는 선언된 WASM compiler를 사용한다. Connect/Protobuf는 공통 compiler service 경로이며 TypeScript가 기본으로 사용한다. `[ormd].endpoint`를 지정하면 지원되는 클라이언트가 Connect/Protobuf를 사용한다.

`fromConfig`는 설정된 데이터베이스를 열지만 기본 query 연결을 설치하지 않는다. 루트 query에 Go는 `Using(ctx, db)`, PHP는 `using($db)`, Rust는 `using(&db)`, TypeScript는 `using(db)`를 사용한다. relation 단계와 로드된 row는 루트 연결을 사용한다. `getCountByServiceSeq(7)` 같은 terminal에는 값만 전달한다. 연결하지 않은 실행과 종료된 transaction의 재사용은 `CONFIG`를 반환한다.
