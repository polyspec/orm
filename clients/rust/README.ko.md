[English](README.md)

# orm — Rust 클라이언트

| 크레이트 | 내용 |
|---|---|
| `orm` (`clients/rust/orm`) | 모델 빌더, 요청 검증, MySQL·PostgreSQL·SQLite SQL 계획기, 계획 캐시, sqlx 실행기, codec, DSN 파서, 트랜잭션, 유틸리티, 오류 코드 |
| `orm-schema` (`clients/rust/orm-schema`) | 스키마 정의: 런타임과 `orm-build`가 함께 쓰는 dbspec parser, emitter, manifest, renderer, plan, Mermaid export와 import, runtime model, 그리고 SQL 문장 분리 |
| `orm-build` (`clients/rust/orm-build`) | 빌드 시 생성기: dbspec document set을 읽고 크레이트 소스를 검사해 호출된 모델과 manifest text를 `OUT_DIR`에 쓴다. `live-db` 기능은 catalog과 tool database 연결을 제공한다. |
| `orm-tests` (`clients/rust/tests`) | `integration`, `conformance`, `client_bench`, `complex`, `demo` |

클라이언트에는 이 크레이트만 필요하다. 문장은 프로세스 안에서 계획하며 별도 서비스를 실행하지 않는다.

## 모델

`build.rs`가 모델을 생성하고 `orm::models!()`가 `model` 모듈로 포함한다.

```toml
[dependencies]
orm = { path = "…/clients/rust/orm" }

[build-dependencies]
orm-build = { path = "…/clients/rust/orm-build" }
```

```rust
// build.rs
fn main() {
    orm_build::Builder::new(["schema/example.dbs"]).scan("src").generate();
}
```

```rust
// src/main.rs
orm::models!();

use model::Author;

let db = model::connect(&dsn, 8, orm::Config::default()).await?;
let rows = Author::new().connect(&db).service_seq(7).and_is_close(false).order_by_seq_desc().gets().await?;
```

모든 모델에는 고정 메서드(`connect`, `get`, `gets`, `set_<col>`, `order_by_<col>_asc` 등)가 있다. [DSL](../../docs/dsl.ko.md)의 체인, join, relation, 열 및 getter 메서드는 검사한 소스의 호출에 맞춰 생성한다. 소스에 등장하는 모델에 알 수 없는 열·연산자·인수 개수가 있으면 파일 위치를 표시하고 빌드를 실패시킨다. 생성 모듈에는 document set의 manifest text와 `manifestHash`(`model::SCHEMA`, `model::MANIFEST_HASH`)와 connect helper `model::connect`가 포함된다. `model::connect`는 `Db::connect_schema`로 연결을 열고 그 set을 등록한다. 연결은 자기에게 등록된 set만 계획한다([protocol](../../docs/protocol.ko.md)).

## 연결

`model::connect(dsn, pool_size, config)`와 `Db::connect(dsn, pool_size, config)`는 DSN URI를 받는다. `Db::connect`는 등록된 set 없이 연결을 연다. scheme은 `mysql`, `postgres`, `sqlite` 중 하나를 선택하고 `timezone` 매개변수는 연결 시간대를 정한다. 인증 정보는 DSN으로, AES 키는 `Config`로 전달한다. `caching_sha2_password`를 쓰는 MySQL 연결에는 TLS가 필요하다. DSN에 `ssl-mode=verify_ca`와 `ssl-ca`를 지정한다. 클라이언트는 암호화하지 않은 연결의 RSA 인증을 켜지 않는다.

`db.utils().schema().install(&model::SCHEMA)`는 document set을 연결의 데이터베이스에 맞게 render하고 statement를 적용한 뒤 그 set을 연결에 등록한다. manifest text가 `manifestHash`로 hash되지 않으면 `CONFIG`를 반환한다. set의 테이블이 모두 있으면 아무것도 만들지 않고 일부만 있으면 `CONFIG`를 반환한다.
`db.utils().schema().add_tables_and_columns(&model::SCHEMA).await`는 설치한 set을 올린다: 데이터베이스에 없는 테이블을 만들고 기존 테이블에 빠진 컬럼 가운데 null이거나 default가 있는 컬럼을 dialect의 plan step(`orm_schema::dbspec::add_tables_and_columns_steps`)으로 추가하며, 그 step은 각 테이블을 index, foreign key, check, 트리거와 함께 만들고 바뀐 각 테이블의 audit 트리거를 바꾼다. 만든 테이블을 `table`, 추가한 컬럼을 `table.column`으로 반환한다. 다른 모든 차이는 어떤 statement보다 먼저 `SCHEMA_DIFFERS`를 반환한다(docs/schema.md, "Adding tables and columns"). MySQL과 SQLite는 트랜잭션 밖에서 추가한다.

## 필수 호출

| 작업 | Rust API |
|---|---|
| 생성 manifest 해시 검증 | `Schema::manifest()`는 포함된 manifest text로 runtime model을 만들고 `manifestHash`를 확인한다. `Manifest::load(text, hash)`는 다른 manifest text에 같은 일을 한다. |
| 엔진 선택과 모델 노출 | `model::connect`가 DSN에서 dialect를 선택하고 생성 모델의 set을 연결에 등록한다. 연결에 등록되지 않은 set의 요청은 `SCHEMA_HASH_MISMATCH`를 반환한다. |
| 스키마 객체 설치 | `db.utils().schema().install(&model::SCHEMA)` |
| 설치한 set에 빠진 테이블과 컬럼 추가 | `db.utils().schema().add_tables_and_columns(&model::SCHEMA)` |
| 격리 수준 또는 읽기 전용 실행 | `db.transaction(callback).isolation(Isolation::…).read_only().await` |
| `Send` future가 필요한 callback 실행 | `db.transaction_send(callback).await` |
| 한 번 실행하는 callback 자체 오류 보존 | `db.transaction_once(callback).await`, 감사 대상 write에는 `.audit(values)`를 더한다. rollback 뒤 `TransactionOnceError::Callback(error)`를 반환한다. |
| 트랜잭션 callback 시간 제한 | `db.transaction(callback).timeout_ms(milliseconds).await` |
| 0을 포함한 deadlock 재시도 횟수 | `db.transaction(callback).retry(count).await` |
| 문장 또는 트랜잭션 callback 취소 | 해당 Future를 drop한다. `timeout_ms`는 기한 만료 시 callback을 취소하고 rollback을 기다린다. |
| 모델 열 암호화 | 스키마에 `aes` codec stage와 `aes_version` setting을 선언하고 `Config::aes_key` 또는 `Config::aes_keys`와 `Config::aes_version`을 전달한다. |
| 감사 쓰기 기록 | 스키마에 `audit` setting을 선언하고, `db.audit(Audit::new().set_…(…))`로 audit 기본값을 가진 handle을 받아, `transaction`, `transaction_send`, `transaction_once`의 `.audit([("action", …)])`로 작업 단위의 값을 준다([사용법](../../docs/usage.ko.md#audited-writes)). |

Rust 연결에서 `aes_version`은 양수여야 한다. 선언한 모든 키 버전은 양수이며 키는 비어 있지 않아야 한다. `aes_keys`가 있으면 현재 버전을 포함해야 한다. 함께 제공한 `aes_key`는 그 버전의 키와 같아야 한다. 잘못된 키 설정이면 연결을 열기 전에 `Db::connect`가 `CONFIG`를 반환한다. AES 열이 없는 연결에는 두 키 필드를 비워 둘 수 있다.

`timeout_ms(0)`은 callback 기한을 끈다. 양수 기한은 callback이 시작한 문장을 포함한 실행을 덮는다. 기한 만료는 rollback에 성공한 뒤에만 `CANCELED`를 반환한다. rollback도 실패하면 반환 오류에 시간 초과와 rollback 실패를 모두 담는다. 성공한 callback 뒤의 commit은 이 기한 대상이 아니다. 각 트랜잭션은 자기 연결을 보유하며 취소된 문장 뒤에도 다음 트랜잭션이 연결을 사용할 수 있다.

`transaction_send`의 중첩 호출은 savepoint에서 타입을 지운 callback을 직접 빌린다.
callback의 Box 할당 객체를 빌릴 필요는 없다. 소유 테스트가 세 DB 엔진에서
Send future와 중첩 commit/rollback을 보존해야 한다.
`make rust-send-savepoint-check`는 선언한 테스트 환경에서 소유 lint와 동작을
검사하며 사용자의 데이터베이스를 사용하지 않는다. 공통 Make 테스트 환경이
SEND_SQLITE_DSN에서 ORM_SEND_SQLITE_DSN을 선언한다. 직접 Cargo를 실행할 때는
MySQL/PostgreSQL 테스트 DSN과 이 URI를 명시해야 한다. 테스트 테이블은 연결
전용 임시 테이블이며 연결 종료 시 제거된다.

`transaction_once`는 한 번만 실행할 수 있는 callback을 받고 재시도하지 않는다. 중첩 호출은 savepoint를 쓴다. DB 준비·commit 오류는 `TransactionOnceError::Orm`이다. callback 실패는 rollback 뒤 원래 오류를 반환한다. rollback도 실패하면 두 오류를 모두 담는다. 이 호출에는 callback 기한 옵션이 없다.

## 행 값

생성 모델의 필드는 비공개다. `get_<column>`은 `Result`를 반환하고 열을 조회하거나 대입하지 않았다면 `COLUMN_UNSELECTED`를 반환한다. 빠진 값이 SQL NULL이나 기본값처럼 보이지 않는다. 명시적 투영은 SQL 선택 열과 행 출력을 바꾼다. `gets_count`는 선택한 그룹 값과 검증한 `row_count`를 가진 `GroupRows`를 반환하므로 그룹 결과를 일부 필드만 채운 모델로 표현하지 않는다. `GroupRow::value(name)`은 `Result<&Val>`을 반환하며 선택하지 않은 이름을 `COLUMN_UNSELECTED`로 거부한다. 선택한 SQL NULL은 `Val::Null`로 유지한다.

`ordered_json`, `serialize`, `yaml`, `gz`, `base64` codec stage가 있는 열의 생성 setter는 `StyledValue<T>`를 받고 `Result<Self>`를 반환한다. `StyledValue::SqlNull`은 SQL NULL을 쓰고 `StyledValue::Value(v)`는 인코딩된 null을 포함한 값을 저장한다. NULL 불허 열은 setter에서 `SqlNull`을 `CODEC_ENCODE`로 거부한다. getter는 `Result<StyledValue<T>>`를 반환하고 조회·대입 전에는 `COLUMN_UNSELECTED`를 보고한다. 행 배열과 모델 JSON은 각 값 스타일 열에 `{"kind":"sql-null"}` 또는 `{"kind":"value","value":...}`를 쓴다. 잘못 저장된 텍스트에는 entity와 열 이름을 포함한 `CODEC_DECODE`를 반환한다.

`Val`의 숫자·boolean·날짜·시간·텍스트·바이트·JSON 변환은 `Result`를 반환한다. 맞지 않는 종류, 잘못된 텍스트, 정수 범위 초과, 유한하지 않은 실수, 잘못된 UTF-8 또는 정밀도를 잃는 decimal 변환은 `CODEC_DECODE`를 반환한다. 유한하지 않은 실수는 JSON 출력에서도 실패한다. 생성 모델의 `assign`은 `Result<bool>`을 반환한다. `Ok(false)`는 알 수 없는 열 이름이고, 잘못된 값은 오류다. `i64` 범위를 넘는 unsigned 값은 읽을 때 실패하고 쓰기에서는 `Param::try_from(u64)`가 `CODEC_ENCODE`를 반환한다. SQL NULL은 빈 텍스트·바이트와 다르다. DB decimal 값은 호출자가 검증된 숫자 변환을 요청하기 전까지 정확한 텍스트로 유지한다.

`get_sum`과 `get_avg`는 근사 `f64` scalar를 반환한다. 유효한 숫자 집계는 동률일 때 짝수 쪽을 택하는 가장 가까운 유한 binary64 값으로 변환한다. 잘못된 숫자 텍스트, SQL NULL, NaN, infinity 및 유한 binary64 범위 초과는 `CODEC_DECODE`를 반환한다. 이 집계 변환은 일반 값의 `Val::as_f64` 정확도 조건을 바꾸지 않는다.

## 오류

`orm::codes`는 `docs/errors.yaml`에서 생성한다(`orm-gen errors --lang rust --out clients/rust/orm/src/codes.rs`). 요청 오류는 `Error::Engine { code, msg }`다. 실행기는 `Error::Config`(`CONFIG`)와 `Error::OptimisticLock`을 발생시킨다. 모든 드라이버 오류는 `Error::Driver { code, msg, source }`가 된다. deadlock, 중복 키, foreign key, CHECK 위반처럼 `docs/errors.yaml`에 있는 조건은 공통 코드를, trigger가 거부한 쓰기 같은 그 밖의 드라이버 오류는 `DRIVER`를 가지며, `source`는 드라이버 오류다. 다른 연결이 SQLite lock을 `busy_timeout` 종료 시점까지 보유하면 `CANCELED`가 된다. `Db::transaction`은 `DEADLOCK`에서 callback을 다시 실행하며 기본 재시도는 세 번이다. callback이 실패하고 트랜잭션이나 savepoint의 rollback도 실패하면 `Error::Rollback { callback, rollback }`(`ROLLBACK`)을 반환한다. 메시지는 `transaction failed (<callback 오류>) and rollback failed (<rollback 오류>)`이고 두 오류를 모두 담으며 재시도하지 않는다.

## 문장 hook

`Config.on_query`는 모델 문장마다 `(sql, binds, duration, plan_id, err)`를 받는다. 비밀 bind는 `$SECRET`, 실행기 시계 bind는 `$NOW`로 표시한다. `plan_id`는 요청 모양의 FNV-1a 64 계획 캐시 키다.

## 빌드와 테스트

`CatalogConnection::read_only_query`는 방언으로 파싱된 단일 조회만 받으며
변경/트랜잭션 문장·쓰기 CTE·SELECT INTO·잠금 조회·실행 주석을 거부한다.
drop 시 폐기되는 별도 풀 연결에서 DB가 강제하는 읽기 전용 범위로 원문 SQL을
실행하고 이후 롤백한다. SQL은 256KiB·파서 재귀는 64로 제한하며 미지원 문법은
명시적으로 실패한다. DB 쓰기 보호이며 권한 있는 DB 함수의 외부 부작용까지
막는 샌드박스는 아니다. 최소 권한 DB 계정을 사용해야 한다.

Rust 도구/카탈로그 조회는 스트리밍 중 검증된 예산으로 행을 누적한다.
기본값은 100,000행과 JSON 인코딩 값 64MiB다. 조회당 한 문장만 허용하며
여러 결과 집합을 암묵적으로 합치지 않는다. 명시적 `QueryLimits`로
줄일 수 있다. 한도를 넘으면 잘린 성공이나 값을 포함한 예산 오류 대신 결과를
거부한다. 누적 출력 제한이며 DB 실행이나 드라이버 패킷 메모리 제한은 아니다.
`query_result_bounded`는 행이 없어도 prepared 메타데이터에서 순서 있는 컬럼명과
네이티브 타입명을 반환한다. 중복 이름은 배열 위치로 구별한다. 메타데이터는
2,048컬럼 및 이름/타입 UTF-8 64KiB로 제한한다. 카탈로그 연결도 `query`로
같은 작업을 노출하며 실행 정책은 호출자가 별도로 적용해야 한다.
지원 셀은 NULL·signed 정수·텍스트·boolean이며 미지원 타입은 변환하지 않고
실패한다. 읽기 전용 SQL 샌드박스가 아니다.

```sh
cd clients/rust
cargo clippy --workspace --all-targets -- -D warnings
ORM_TEST_MYSQL_DSN=… ORM_TEST_POSTGRES_DSN=… ORM_TEST_MYSQL_SERVER_DSN=… ORM_TEST_POSTGRES_SERVER_DSN=… cargo test --workspace
cargo build -p orm-tests
ORM_TEST_MYSQL_DSN=… ORM_TEST_POSTGRES_DSN=… ./target/debug/integration ../../schema/bench.dbs
./target/debug/conformance --dsn "mysql://…" ../../schema/bench.dbs
```

`integration`과 `zone` 테스트는 SQLite·MySQL·PostgreSQL에서 실행된다. `ORM_TEST_MYSQL_DSN`과 `ORM_TEST_POSTGRES_DSN`은 시험 DB를 가리켜야 하고 하나라도 없으면 테스트가 실패한다. schema를 설치하거나 빈 DB를 확인하는 case는 그 DSN으로 자기 DB를 만들고 끝날 때 지운다. rollback 테스트는 pooler 없는 서버를 가리키는 `ORM_TEST_MYSQL_SERVER_DSN`과 `ORM_TEST_POSTGRES_SERVER_DSN`으로 transaction의 서버 session을 종료하고, dbspec 테스트(`dbspec_*`)는 그 DSN으로 자기 DB를 만들고 바꾼다. `dbspec_apply`는 transaction pooler case를 위해 `ORM_TEST_PGBOUNCER_DSN`도 요구한다. make target은 둘을 `.runtime/servers/env`에서 정한다. `conformance`, `complex`, `demo`는 데이터가 준비된 bench DB를 읽는다.
Rust conformance 출력은 bind를 손실 없이 표현할 수 없거나 요청한 선택 필드·관계가 없거나 계산한 정수가 유효하지 않거나 범위를 벗어나면 실패한다. 이런 오류를 null, 0, 대체 텍스트로 바꾸지 않는다.

Rust 소스 검사기는 styled setter 바로 다음 `expect`와 `unwrap`을 Result 처리로 구분한다.
후속 호출에서 모델을 유지하고 알 수 없는 모델 메서드는 거부한다.
