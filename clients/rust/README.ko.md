[English](README.md)

# orm — Rust 클라이언트

| 크레이트 | 내용 |
|---|---|
| `orm` (`clients/rust/orm`) | 모델 빌더, 요청 검증, MySQL·PostgreSQL·SQLite SQL 계획기, 계획 캐시, sqlx 실행기, codec, DSN 파서, 트랜잭션, 유틸리티, 오류 코드 |
| `orm-schema` (`clients/rust/orm-schema`) | 스키마 정의: Mermaid → `schema.json`, DDL 및 변경 명령 렌더링, SQL 문장 분리. 런타임은 이를 사용해 스키마를 설치하고 `orm-build`는 `orm_build::schema`와 `orm_build::ddl`로 다시 공개한다. |
| `orm-build` (`clients/rust/orm-build`) | 빌드 시 생성기: `schema.json`을 읽고 크레이트 소스를 검사해 호출된 모델을 `OUT_DIR`에 쓴다. `cli` 기능은 `orm-gen` 스키마 도구를 제공한다. |
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
    orm_build::Builder::new("schema/schema.json").scan("src").generate();
}
```

```rust
// src/main.rs
orm::models!();

use model::Battle;

let db = orm::Db::connect(&dsn, 8, orm::Config::default()).await?;
let rows = Battle::new().connect(&db).service_seq(7).and_is_close(false).order_by_seq_desc().gets().await?;
```

모든 모델에는 고정 메서드(`connect`, `get`, `gets`, `set_<col>`, `order_by_<col>_asc` 등)가 있다. [DSL](../../docs/dsl.ko.md)의 체인, join, relation, 열 및 getter 메서드는 검사한 소스의 호출에 맞춰 생성한다. 소스에 등장하는 모델에 알 수 없는 열·연산자·인수 개수가 있으면 파일 위치를 표시하고 빌드를 실패시킨다. 생성 모듈에는 스키마가 포함되므로 연결 하나로 여러 스키마의 모델을 사용할 수 있다.

## 연결

`Db::connect(dsn, pool_size, config)`는 DSN URI를 받는다. scheme은 `mysql`, `postgres`, `sqlite` 중 하나를 선택하고 `timezone` 매개변수는 연결 시간대를 정한다. 인증 정보는 DSN으로, AES 키는 `Config`로 전달한다. `caching_sha2_password`를 쓰는 MySQL 연결에는 TLS가 필요하다. DSN에 `ssl-mode=verify_ca`와 `ssl-ca`를 지정한다. 클라이언트는 암호화하지 않은 연결의 RSA 인증을 켜지 않는다.

`db.utils().schema().install(schema_json)`은 manifest의 테이블과 인덱스를 한 트랜잭션에서 생성하고 기존 것은 유지한다.

## 필수 호출

| 작업 | Rust API |
|---|---|
| 생성 스키마 해시 검증 | `Schema::manifest()`는 포함된 manifest와 생성 해시를 검증하고 `Manifest::load(bytes)`는 다른 manifest를 검증한다. |
| 엔진 선택과 모델 노출 | `Db::connect`가 DSN에서 dialect를 선택한다. 생성 모델마다 스키마를 포함하고 생성 모듈에 entity descriptor를 등록하므로 전역 등록 호출은 필요 없다. |
| 스키마 객체 설치 | `db.utils().schema().install(model::SCHEMA.json())` |
| 격리 수준 또는 읽기 전용 실행 | `db.transaction(callback).isolation(Isolation::…).read_only().await` |
| `Send` future가 필요한 callback 실행 | `db.transaction_send(callback).await` |
| 한 번 실행하는 callback 자체 오류 보존 | `db.transaction_once(callback).await`; rollback 뒤 `TransactionOnceError::Callback(error)`를 반환한다. |
| 트랜잭션 callback 시간 제한 | `db.transaction(callback).timeout_ms(milliseconds).await` |
| 0을 포함한 deadlock 재시도 횟수 | `db.transaction(callback).retry(count).await` |
| 문장 또는 트랜잭션 callback 취소 | 해당 Future를 drop한다. `timeout_ms`는 기한 만료 시 callback을 취소하고 rollback을 기다린다. |
| 모델 열 암호화 | 스키마에 `aes`와 `aes_key_version`을 선언하고 `Config::aes_key` 또는 `Config::aes_keys`와 `Config::aes_version`을 전달한다. |
| 감사 쓰기 기록 | 스키마에 `audit_log`와 `audit`를 선언하고 감사 테이블을 설치한 뒤 트랜잭션 안에서 `db.utils().set_local`로 이름 붙은 context를 설정한다. |

Rust 연결에서 `aes_version`은 양수여야 한다. 선언한 모든 키 버전은 양수이며 키는 비어 있지 않아야 한다. `aes_keys`가 있으면 현재 버전을 포함해야 한다. 함께 제공한 `aes_key`는 그 버전의 키와 같아야 한다. 잘못된 키 설정이면 연결을 열기 전에 `Db::connect`가 `CONFIG`를 반환한다. AES 열이 없는 연결에는 두 키 필드를 비워 둘 수 있다.

`timeout_ms(0)`은 callback 기한을 끈다. 양수 기한은 callback이 시작한 문장을 포함한 실행을 덮는다. 기한 만료는 rollback에 성공한 뒤에만 `CANCELED`를 반환한다. rollback도 실패하면 반환 오류에 시간 초과와 rollback 실패를 모두 담는다. 성공한 callback 뒤의 commit은 이 기한 대상이 아니다. 각 트랜잭션은 자기 연결을 보유하며 취소된 문장 뒤에도 다음 트랜잭션이 연결을 사용할 수 있다.

`transaction_once`는 한 번만 실행할 수 있는 callback을 받고 재시도하지 않는다. 중첩 호출은 savepoint를 쓴다. DB 준비·commit 오류는 `TransactionOnceError::Orm`이다. callback 실패는 rollback 뒤 원래 오류를 반환한다. rollback도 실패하면 두 오류를 모두 담는다. 이 호출에는 callback 기한 옵션이 없다.

## 행 값

생성 모델의 필드는 비공개다. `get_<column>`은 `Result`를 반환하고 열을 조회하거나 대입하지 않았다면 `COLUMN_UNSELECTED`를 반환한다. 빠진 값이 SQL NULL이나 기본값처럼 보이지 않는다. 명시적 투영은 SQL 선택 열과 행 출력을 바꾼다. `gets_count`는 선택한 그룹 값과 검증한 `row_count`를 가진 `GroupRows`를 반환하므로 그룹 결과를 일부 필드만 채운 모델로 표현하지 않는다. `GroupRow::value(name)`은 `Result<&Val>`을 반환하며 선택하지 않은 이름을 `COLUMN_UNSELECTED`로 거부한다. 선택한 SQL NULL은 `Val::Null`로 유지한다.

`json`, `jsons`, `serialize`, `yaml` 열의 생성 setter는 `StyledValue<T>`를 받고 `Result<Self>`를 반환한다. `StyledValue::SqlNull`은 SQL NULL을 쓰고 `StyledValue::Value(v)`는 인코딩된 null을 포함한 값을 저장한다. NULL 불허 열은 setter에서 `SqlNull`을 `CODEC_ENCODE`로 거부한다. getter는 `Result<StyledValue<T>>`를 반환하고 조회·대입 전에는 `COLUMN_UNSELECTED`를 보고한다. 행 배열과 모델 JSON은 각 값 스타일 열에 `{"kind":"sql-null"}` 또는 `{"kind":"value","value":...}`를 쓴다. 잘못 저장된 텍스트에는 entity와 열 이름을 포함한 `CODEC_DECODE`를 반환한다.

`Val`의 숫자·boolean·날짜·시간·텍스트·바이트·JSON·point 변환은 `Result`를 반환한다. 맞지 않는 종류, 잘못된 텍스트, 정수 범위 초과, 유한하지 않은 실수, 잘못된 UTF-8 또는 정밀도를 잃는 decimal 변환은 `CODEC_DECODE`를 반환한다. 유한하지 않은 실수는 JSON 출력에서도 실패한다. 생성 모델의 `assign`은 `Result<bool>`을 반환한다. `Ok(false)`는 알 수 없는 열 이름이고, 잘못된 값은 오류다. `i64` 범위를 넘는 unsigned 값은 읽을 때 실패하고 쓰기에서는 `Param::try_from(u64)`가 `CODEC_ENCODE`를 반환한다. SQL NULL은 빈 텍스트·바이트와 다르다. DB decimal 값은 호출자가 검증된 숫자 변환을 요청하기 전까지 정확한 텍스트로 유지한다.

`get_sum`과 `get_avg`는 근사 `f64` scalar를 반환한다. 유효한 숫자 집계는 동률일 때 짝수 쪽을 택하는 가장 가까운 유한 binary64 값으로 변환한다. 잘못된 숫자 텍스트, SQL NULL, NaN, infinity 및 유한 binary64 범위 초과는 `CODEC_DECODE`를 반환한다. 이 집계 변환은 일반 값의 `Val::as_f64` 정확도 조건을 바꾸지 않는다.

## 오류

`orm::codes`는 `docs/errors.yaml`에서 생성한다(`ormgen errors --lang rust --out clients/rust/orm/src/codes.rs`). 요청 오류는 `Error::Engine { code, msg }`다. 실행기는 `Error::Config`(`CONFIG`)와 `Error::OptimisticLock`을 발생시킨다. 드라이버 오류는 deadlock·중복 키·foreign key를 제외하고 `Error::Sqlx`로 유지한다. 세 경우에는 공통 코드와 드라이버 메시지를 담은 `Error::Engine`으로 변환한다. 다른 연결이 SQLite lock을 `busy_timeout` 종료 시점까지 보유하면 `CANCELED`가 된다. `Db::transaction`은 `DEADLOCK`에서 callback을 다시 실행하며 기본 재시도는 세 번이다.

## 문장 hook

`Config.on_query`는 모델 문장마다 `(sql, binds, duration, plan_id, err)`를 받는다. 비밀 bind는 `$SECRET`, 실행기 시계 bind는 `$NOW`로 표시한다. `plan_id`는 요청 모양의 FNV-1a 64 계획 캐시 키다.

## 빌드와 테스트

```sh
cd clients/rust
cargo clippy --workspace --all-targets -- -D warnings
ORM_TEST_MYSQL_DSN=… ORM_TEST_POSTGRES_DSN=… cargo test --workspace
cargo build --release -p orm-tests
ORM_TEST_MYSQL_DSN=… ORM_TEST_POSTGRES_DSN=… ./target/release/integration ../../schema/schema.json
./target/release/conformance --driver mysql --dsn "mysql://…" ../../schema/schema.json
```

`integration`과 `zone` 테스트는 SQLite·MySQL·PostgreSQL에서 실행된다. `ORM_TEST_MYSQL_DSN`과 `ORM_TEST_POSTGRES_DSN`은 시험 DB를 가리켜야 하고 하나라도 없으면 테스트가 실패한다. 테스트는 그 DB에서 자기 테이블을 삭제하고 설치한다. `conformance`, `complex`, `demo`는 데이터가 준비된 bench DB를 읽는다.
Rust conformance 출력은 bind를 손실 없이 표현할 수 없거나 요청한 선택 필드·관계가 없거나 계산한 정수가 유효하지 않거나 범위를 벗어나면 실패한다. 이런 오류를 null, 0, 대체 텍스트, 빈 point로 바꾸지 않는다.
