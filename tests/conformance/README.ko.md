# 적합성 벡터

한 문서와 네 실행기를 사용한다. 각 벡터는 Go, PHP, Rust, TypeScript로 같은 체인을 작성한다. 각 실행기는 데이터베이스에서 체인을 실행하고 다음 JSON을 출력한다.

```json
{"<vector>": {"statements": [{"sql": "...", "binds": [...]}], "result": ...}}
```

`check`는 JSON 숫자를 정확한 유리수 값으로 비교하고 기록할 때 원래 십진 표현을 보존한다. 객체 키는 출력에서 정렬한다. SQL, bind 순서와 타입, 결과를 `vectors.json`과 비교한다. 2^53을 넘는 서로 다른 정수도 구분하며 동등한 십진 표현은 같은 값으로 처리한다. 날짜 형식은 `YYYY-MM-DD HH:MM:SS[.ffffff]`다.
어느 깊이의 객체든 중복 키가 있거나 데이터베이스 기대값 파일이 없으면 실패한다.

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
make test-servers
make conformance-check
```

`make conformance-check`는 `make test-servers`의 환경 파일에서 `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`을 읽고 다음을 실행한다.

```sh
go run ./tests/conformance/check run -driver mysql -dsn "$BENCH_MYSQL_DSN"
go run ./tests/conformance/check run -driver postgres -dsn "$BENCH_POSTGRES_DSN"
go run ./tests/conformance/check run -driver sqlite -dsn "$BENCH_SQLITE_DSN"
```

`check run`은 `-dsn`이 필요하며 네 실행기에 같은 DSN URI를 전달한다. 각 DSN은 시간대 `+00:00`을 선택한다. 각 실행기를 두 번 실행하며, 두 JSON 결과가 같고 선언된 sequence 정리 후 데이터베이스 상태가 같아야 한다. 검사는 모든 테이블 행과 MySQL auto-increment 값, PostgreSQL sequence 값, 존재할 때 SQLite `sqlite_sequence` 테이블을 읽는다. `AUTOINCREMENT` 테이블이 없는 SQLite 데이터베이스에는 sequence counter가 없으며 검사기는 모든 행을 계속 읽고 다른 질의 오류를 보고한다. 쓰기 벡터가 삽입하는 네 테이블의 counter만 복원할 수 있으며 각 복원을 보고한다. 테이블 누락, 읽을 수 없는 sequence, 선언되지 않은 counter 변경, 정리 실패, 남은 상태 변경은 실패다. 실행 중 bench 데이터베이스에 외부 쓰기가 없어야 한다.

`check compare`는 저장된 파일을 비교하며 실행기가 현재 실행됐다는 증거가 아니다. 네 클라이언트의 출력이 정확히 하나씩 필요하다. `check run`은 시작할 때 이전 생성 출력을 제거하고 반복 실행, 상태 검사, 기대값 비교가 모두 통과한 뒤에만 네 출력 파일을 게시한다. 실패하면 현재 진단 파일을 `.run-*` 디렉터리에 남기되 검증된 출력으로 다루지 않는다. `check record -driver <db> out/<db>/go.json`은 검토 후 기대값을 갱신할 때 사용한다.

각 클라이언트는 자기 프로세스에서 SQL을 조립한다. `check run`은 실행기가 bench 데이터베이스를 쓰는 동안 디렉터리 잠금 `/tmp/orm-conformance.lock`을 잡으며, 두 번째 실행은 기다리지 않고 실패한다.

## 벡터 추가

1. `vectors.json`에 `{"name", "chain", "expect": null}`을 추가한다.
2. 네 실행기에 같은 체인을 추가하고 statement 순서를 유지한다.
3. 데이터베이스마다 `check record -driver <db>`로 Go 결과를 기대값으로 기록하고 SQL, bind, 결과를 검토한다.

쓰기 벡터는 생성한 행을 제거한다. 검사기는 선언된 sequence counter를 복원하고 매번 원래 상태를 확인한다. 출력에서 생성한 행의 키와 갱신 시각은 `$SEQ`, `$TS`로, 무작위 nonce를 갖는 AES 암호문은 `$AES`로 정규화한다. 정규화는 데이터베이스 상태 변경을 허용하지 않는다.

PHP와 TypeScript 실행기는 쓰기 벡터를 트랜잭션에서 실행하고 예상 밖 벡터 오류를 검사기에 반환한다. 잘못된 파생 정수, 누락된 조회 결과 필드, 잘못된 질의 바인딩, 정확히 표현할 수 없는 결과 값을 거부한다. 출력의 ordered JSON 숫자는 정확히 보존한다. `make conformance-result-check`는 결과 사례를 실행한다. Go 실행기에도 같은 오류, 정수, 바인딩, 필드, 트랜잭션 검사를 적용한다. `make conformance-result-physical-check`는 각 데이터베이스에서 Go, PHP, Rust, TypeScript를 두 번씩 실행하고 출력 동등성과 행·카운터 불변성을 검사한다.

Rust 실행기는 잘못된 바인딩 값과 파생 정수를 거부하고 집계 평균의 binary64 비트를 비교하며 예상 밖 벡터 오류를 프로세스 실패로 반환한다. 쓰기 벡터는 트랜잭션을 사용하므로 실패한 쓰기가 행을 남기지 않는다. 상태 검사기는 모든 데이터베이스에서 실패 뒤 행과 카운터를 확인한다.

`make conformance-rust-group-check`는 각 데이터베이스에서 Rust 실행기를 두 번 실행하고 두 실행 전후의 행과 카운터를 검사하며 `aggregates` 벡터를 기록된 기대값과 비교한다. 선택한 불리언 그룹 컬럼은 결과에서 불리언으로 유지된다.
