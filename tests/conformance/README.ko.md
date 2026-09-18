# 적합성 벡터

한 문서와 네 실행기를 사용한다. 각 벡터는 Go, PHP, Rust, TypeScript로 같은 체인을 작성한다. 각 실행기는 데이터베이스에서 체인을 실행하고 다음 JSON을 출력한다.

```json
{"<vector>": {"statements": [{"sql": "...", "binds": [...]}], "result": ...}}
```

`check`는 JSON 키와 숫자를 정규화한 후 SQL, bind 순서와 타입, 결과를 `vectors.json`과 비교한다. 날짜 형식은 `YYYY-MM-DD HH:MM:SS[.ffffff]`다.

| 파일 | 역할 |
|---|---|
| `vectors.json` | 벡터 이름, 체인, MySQL 기대값 |
| `vectors.postgres.json`, `vectors.sqlite.json` | PostgreSQL과 SQLite 기대값 |
| `runner_go/main.go` | Go 실행기(`clients/go/model`의 생성 모델) |
| `runner.php` | PHP 실행기(PDO) |
| `clients/rust/tests/src/conformance.rs` | Rust 실행기(`orm-build` 생성 모델, sqlx) |
| `runner_typescript.mjs` | TypeScript 실행기(네이티브 데이터베이스 드라이버) |
| `check/main.go` | 실행 제어와 결과 비교 |

## 실행

```sh
(cd clients/rust && cargo build --locked --release -p orm-tests --bin conformance)
npm run typescript:build
go run ./tests/conformance/check run
go run ./tests/conformance/check run -driver postgres -dsn 'postgres:///orm_bench?host=/tmp&timezone=%2B00:00'
go run ./tests/conformance/check run -driver sqlite -dsn 'sqlite:///tmp/orm_bench.sqlite?timezone=%2B00:00'
```

`-langs go,php`는 지정한 실행기만 실행한다. 모든 실행기는 같은 DSN URI를 받는다.
DSN을 생략하면 로컬 bench 데이터베이스를 시간대 `+00:00`으로 사용한다.
`check record -driver <db> out/<db>/go.json`은 검토 후 기대값을 갱신할 때 사용한다.

각 클라이언트는 자기 프로세스에서 SQL을 조립한다. `check run`은 실행기가 bench 데이터베이스를 쓰는 동안 디렉터리 잠금 `/tmp/orm-conformance.lock`을 잡으며, 두 번째 실행은 기다리지 않고 실패한다.

## 벡터 추가

1. `vectors.json`에 `{"name", "chain", "expect": null}`을 추가한다.
2. 네 실행기에 같은 체인을 추가하고 statement 순서를 유지한다.
3. 데이터베이스마다 `check record -driver <db>`로 Go 결과를 기대값으로 기록하고 SQL, bind, 결과를 검토한다.

쓰기 벡터는 실행 전 상태를 복원한다. 생성한 행의 키와 갱신 시각은 `$SEQ`, `$TS`로, 무작위 nonce를 갖는 AES 암호문은 `$AES`로 정규화한다.
