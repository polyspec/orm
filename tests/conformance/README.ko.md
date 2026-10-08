# 적합성 벡터

한 문서와 네 실행기를 사용한다. 각 벡터는 Go, PHP, Rust, TypeScript로 같은 체인을 작성한다. 각 실행기는 데이터베이스에서 체인을 실행하고 다음 JSON을 출력한다.

```json
{"<vector>": {"statements": [{"sql": "...", "binds": [...], "kind": "...", "tables": [...], "transaction": 1, "error": null}], "result": ...}}
```

각 statement는 연결의 statement event다([사용법](../../docs/usage.md#statement-events)): 실행기의 연결이 실행하는 모든 statement를 kind, table, 오류 code와 함께 기록한다. `transaction`은 벡터 안에서 처음 나온 순서로 1부터 다시 센 번호이고 transaction 밖에서는 null이다.

`check`는 JSON 숫자를 정확한 유리수 값으로 비교하고 기록할 때 원래 십진 표현을 보존한다. 객체 키는 출력에서 정렬한다. SQL, bind 순서와 타입, 결과를 `vectors.json`과 비교한다. 2^53을 넘는 서로 다른 정수도 구분하며 동등한 십진 표현은 같은 값으로 처리한다. 날짜 형식은 `YYYY-MM-DD HH:MM:SS[.ffffff]`다.
어느 깊이의 객체든 중복 키가 있거나 데이터베이스 기대값 파일이 없으면 실패한다.
기본 파일과 데이터베이스 기대값 파일에는 비어 있지 않은 고유 벡터 이름과 정확히 같은 벡터 집합이 필요하다. 기대값 이름이 누락되거나 추가되면 비교와 기록이 실패한다.
`write_cycle` 기대값은 생성한 행과 갱신한 행의 `json_setting`, `serialize_data`에 값 스타일 컬럼의 태그 값을 사용한다.

| 파일 | 역할 |
|---|---|
| `vectors.json` | 벡터 이름, 체인, MySQL 기대값 |
| `vectors.postgres.json`, `vectors.sqlite.json` | PostgreSQL과 SQLite 기대값 |
| `runner_go/main.go` | Go 실행기(`packages/orm-go/model`의 생성 모델) |
| `runner.php` | PHP 실행기(PDO) |
| `packages/orm-rust/tests/src/conformance.rs` | Rust 실행기(`polyspec-orm-build` 생성 모델, sqlx) |
| `runner_typescript.mjs` | TypeScript 실행기(네이티브 데이터베이스 드라이버) |
| `check/main.go` | 실행 제어와 결과 비교 |

## 실행

```sh
make test-servers
make conformance-check
```

`make conformance-check`는 자기 실행(`make check`나 `make run-databases`)의 bench database인 `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`을 읽고 다음을 실행한다.

```sh
go run ./tests/conformance/check run -out "$RUN_DIR/out" -driver mysql -dsn "$BENCH_MYSQL_DSN" -driver postgres -dsn "$BENCH_POSTGRES_DSN" -driver sqlite -dsn "$BENCH_SQLITE_DSN"
go run ./tests/interfaces/check --results "$RUN_DIR/out" --results "$RUN_DIR/out/postgres" --results "$RUN_DIR/out/sqlite"
```

`$RUN_DIR`은 그 실행 하나의 directory(`.runtime/run/conformance-check-<make pid>`)이고 target이 끝에 지운다: 모든 실행은 새 directory에 출력을 쓰고(`check run -out`은 이미 있는 directory를 거부한다), `contracts/interfaces.json`의 공통 state contract는 같은 실행의 출력과 비교하므로, 결과는 tree에만 달렸고 이전 실행이 남긴 출력에 달리지 않는다.

`check run`은 `-dsn`이 필요하며 네 실행기에 같은 DSN URI를 전달한다. 각 DSN은 시간대 `+00:00`을 선택한다. 각 실행기를 두 번 실행하며, 두 JSON 결과가 같고 선언된 sequence 정리 후 데이터베이스 상태가 같아야 한다. 검사는 모든 테이블 행과 MySQL auto-increment 값, PostgreSQL sequence 값, 존재할 때 SQLite `sqlite_sequence` 테이블을 읽는다. `AUTOINCREMENT` 테이블이 없는 SQLite 데이터베이스에는 sequence counter가 없으며 검사기는 모든 행을 계속 읽고 다른 질의 오류를 보고한다. 쓰기 벡터가 삽입하는 다섯 테이블의 counter만 복원할 수 있으며 각 복원을 보고한다. 테이블 누락, 읽을 수 없는 sequence, 선언되지 않은 counter 변경, 정리 실패, 남은 상태 변경은 실패다. 실행 중 bench 데이터베이스에 외부 쓰기가 없어야 한다.
비어 있는 SQLite `AUTOINCREMENT` 테이블에는 아직 `sqlite_sequence` 항목이 없을 수 있다. counter 테스트는 테이블 정의를 확인하고 첫 삽입으로 생긴 counter를 관찰한 뒤 원래의 항목 부재 상태로 복원한다.


각 실행기는 반복할 수 있는 vector 선택(Go는 `-vector NAME`, PHP, Rust, TypeScript는 `--vector NAME`)을 받아 이름이 지정된 vector만 선언 순서로 실행한다. 알 수 없거나 반복된 이름은 vector를 실행하기 전에 실패한다. `check run`, `check compare`, `check record`는 같은 반복 가능한 `-vector NAME`을 받는다: `run`은 그것을 네 실행기에 넘기고 `compare`와 `record`는 이름이 지정된 vector만 비교하고 기록하므로, 일부 vector를 바꾸면 그 vector만 실행하고 기록한다. 각 client의 `conformance_verification` coverage case는 자기 실행기로 읽기 전용 vector `conditions_values`와 `relations`를 실행하고 각 결과를 선택된 데이터베이스의 기록된 기대값과 비교한다.

`check compare`는 저장된 파일을 비교하며 실행기가 현재 실행됐다는 증거가 아니다. 네 클라이언트의 출력이 정확히 하나씩 필요하다. `check run`은 반복 실행, 상태 검사, 기대값 비교가 모두 통과한 뒤에만 네 출력 파일을 게시한다. 실패하면 현재 진단 파일을 `.run-*` 디렉터리에 남기되 검증된 출력으로 다루지 않는다. `check record -driver <db>`는 네 출력에 선언된 벡터만 있고 결과가 모두 같을 때만 기대값을 갱신한다. 거부된 출력은 기대값 파일을 변경하지 않는다.

각 클라이언트는 자기 프로세스에서 SQL을 조립한다. `check run`은 실행기가 bench 데이터베이스를 쓰는 동안 디렉터리 잠금 `/tmp/orm-conformance.lock`을 잡으며, 두 번째 실행은 기다리지 않고 실패한다.

## 벡터 추가

1. `vectors.json`에 `{"name", "chain", "expect": null}`을 추가한다.
2. 네 실행기에 같은 체인을 추가하고 statement 순서를 유지한다.
3. 데이터베이스마다 네 출력 파일을 `check record -driver <db>`에 전달하고 SQL, bind, 결과를 검토해 커밋한다. 이전 기대값 때문에 `check run`이 실패했다면, 네 실행기의 완료와 데이터베이스 상태 복원을 확인한 뒤 `.run-*`의 진단 파일을 사용한다.

쓰기 벡터는 생성한 행을 제거한다. 검사기는 선언된 sequence counter를 복원하고 매번 원래 상태를 확인한다. 출력에서 생성한 행의 키와 갱신 시각은 `$SEQ`, `$TS`로, 무작위 nonce를 갖는 AES 암호문은 `$AES`로 정규화한다. 정규화는 데이터베이스 상태 변경을 허용하지 않는다.

PHP와 TypeScript 실행기는 쓰기 벡터를 트랜잭션에서 실행하고 예상 밖 벡터 오류를 검사기에 반환한다. 잘못된 파생 정수, 누락된 조회 결과 필드, 잘못된 질의 바인딩, 정확히 표현할 수 없는 결과 값을 거부한다. 출력의 ordered JSON 숫자는 정확히 보존한다. TypeScript 결과 사례는 값 스타일 값에 정의되지 않은 멤버가 있을 때 `CODEC_ENCODE` 코드를 검사하며 진단 문구는 계약에 포함하지 않는다. `make conformance-result-check`는 결과 사례를 실행한다. Go 실행기에도 같은 오류, 정수, 바인딩, 필드, 트랜잭션 검사를 적용한다. `make conformance-result-physical-check`는 각 데이터베이스에서 Go, PHP, Rust, TypeScript를 두 번씩 실행하고 출력 동등성과 행·카운터 불변성을 검사한다.
TypeScript 파생 정수 변환은 SQLite `bigint`가 부호 있는 64비트 범위에 있고 숫자 결과로 정확히 표현될 때만 수용한다. 다른 `bigint` 결과는 정확한 ordered JSON 숫자로 직렬화한다.

Rust 실행기는 잘못된 바인딩 값과 파생 정수를 거부하고 집계 평균의 binary64 비트를 비교하며 예상 밖 벡터 오류를 프로세스 실패로 반환한다. 쓰기 벡터는 트랜잭션을 사용하므로 실패한 쓰기가 행을 남기지 않는다. 상태 검사기는 모든 데이터베이스에서 실패 뒤 행과 카운터를 확인한다.

`make conformance-rust-group-check`는 각 데이터베이스에서 Rust 실행기를 두 번 실행하고 두 실행 전후의 행과 카운터를 검사하며 `aggregates` 벡터를 기록된 기대값과 비교한다. 선택한 불리언 그룹 컬럼은 결과에서 불리언으로 유지된다.
