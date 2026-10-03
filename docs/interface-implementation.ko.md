# 공통 인터페이스 구현 대조표

기준: [공통 인터페이스 v1](interfaces.md), [기계 명세](../contracts/interfaces.json), [생성 도표](interfaces-model.md). 재현 명령과 검사 범위는 [검사 안내](../tests/interfaces/README.md)에 있다.

로컬 검증: **conformance 벡터 26개 × Go·PHP·Rust·TypeScript × MySQL·PostgreSQL·SQLite에서 문장, bind, 결과가 같다**. 생성 인터페이스, 네이티브 심볼, 레코드 검사는 `make interface-check`에서 실행한다.

### Rust ORM 대응

생성된 모델은 중간 질의·모델 계층 없이 다음 공개 Rust API를 직접 사용한다.

| 명세 호출 | Rust API와 동작 |
|---|---|
| 엔진 선택과 연결 | `Db::connect(dsn, pool_size, Config)`가 DSN에서 MySQL·PostgreSQL·SQLite를 선택하고 등록된 set 없이 제한된 pool을 만든다. 생성된 `model::connect`가 부르는 `Db::connect_schema(dsn, &SCHEMA, pool_size, Config)`는 생성 모델의 set도 등록한다. |
| 스키마 해시 검사 | 생성된 `Schema::new(manifest_text, manifest_hash)`가 내장 manifest text를 검증하며, 해시가 다른 요청은 `SCHEMA_HASH_MISMATCH`로 거부한다. |
| 스키마 설치와 검사 | `db.utils().schema().install(&model::SCHEMA)`가 set을 설치하고 연결에 등록하며 `exists`, `installed`, `empty`가 선택한 데이터베이스를 검사한다. manifest의 감사 지시어는 감사 테이블·trigger와 함께 설치된다. |
| 트랜잭션 격리 수준·읽기 전용·시간 제한·재시도·operation id | `db.transaction(callback).isolation(Isolation::...).read_only().timeout_ms(ms).retry(count)`가 선언된 옵션을 적용하며 `retry(0)`은 콜백을 한 번 실행한다. `Db::transaction_once(callback)`는 콜백 오류를 보존하고 재시도하지 않는다. 세 transaction builder 모두 `operation(id)`로 작업 단위의 operation id를 정한다. |
| 취소 | 문장 또는 트랜잭션 Future를 폐기하면 확인된 연결을 닫아 서버 작업을 취소하거나 롤백한 뒤 슬롯을 재사용하며, 드라이버 취소는 `CANCELED`로 대응한다. |
| 암호화 열 | `Config::aes_version`, `Config::aes_keys`, `Config::blind_index_key`, `db.utils().aes()`가 생성된 암호화 열의 키 검증·암호화 쓰기·blind index·상태·회전을 제공한다. |

PostgreSQL·MySQL·SQLite 사례가 이 호출을 실행하고, pooler 사례는 같은 생성 모델을
1슬롯 PgBouncer 연결에서 실행한다.

| 인터페이스 | 구현과 검증 |
|---|---|
| IF-01, IF-18, IF-32 | 각 client는 같은 planner의 이식본으로 자기 process에서 request를 계획하고 모델의 schema hash를 확인한다. conformance 벡터가 네 client의 계획된 SQL과 bind를 비교한다. `tests/interfaces/check`는 Go, PHP, Rust, TypeScript의 request 레코드 20개를 필드 단위로 비교한다 |
| IF-02 | 컬럼 값은 논리 타입을 유지한다. `TestConnectionsUseUTC`와 PHP·TypeScript·Rust 대응 사례가 SQLite와 서버 시간대를 KST로 설정한 MySQL·PostgreSQL에서 날짜·시각 값을 UTC로 쓰고 읽는지 검사하고 SQLite 문자열 datetime을 저장 형식인 소수 여섯 자리로 비교한다. Rust 생성 모델은 타입이 지정된 `NaiveDateTime` 값을 사용하고 integration 사례에서 같은 데이터베이스 시각 동작을 검사한다 |
| IF-03 ~ IF-08 | 생성된 모델은 체인 상태를 core 객체 하나에 저장한다. `conditions_connectors`, `conditions_group`, `conditions_values`, `joins`, `errors` 벡터가 연결자, 그룹, 값 모양, 조인 배치, 잘못된 체인을 검사한다 |
| IF-09 ~ IF-12 | 모델 메서드 23개를 언어별로 고정한다. Go는 생성 모델, PHP와 TypeScript는 기반 클래스, Rust는 `orm-build` 템플릿이다. `terminal_by`와 `terminal_reuse`가 터미널과 모델 하나의 재사용을 검사한다 |
| IF-13 ~ IF-17 | `Db.connect`, `Db.transaction`, `Db.utils`, `Utils.lock`, `SchemaUtils.install`, AES 유틸리티를 언어별로 고정한다. `transactions` 벡터와 client 트랜잭션 테스트가 savepoint, 행 잠금, 이름 잠금, 지역 값을 검사한다 |
| IF-19, IF-20 | `relations`, `relation_empty`, `subqueries` 벡터가 관계 statement와 조립을 검사한다. `TestBindLimitSplitting`이 세 데이터베이스에서 Go의 큰 IN 목록 분할을 검사하며 PHP·Rust·TypeScript는 공통 planner 명세과 각 client suite의 관계·subquery 경로를 검사한다 |
| IF-21 ~ IF-24 | `write_cycle`, `now_defaults`, `creates_and_save`, `delete_recursive`, `restore` 벡터가 변경 필드 쓰기, 시각 기본값, upsert, 낙관적 갱신, 재귀 삭제, soft delete한 행의 restore를 검사한다 |
| IF-25 ~ IF-27 | owner 규칙이 모든 언어에서 `Page` 필드 5개와 `AESRotationStatus` 필드 4개를 고정한다. client 모델 테스트가 key 컬렉션과 페이지를 검사한다 |
| IF-28 ~ IF-31 | 코덱 벡터 80개, AES 벡터, `aes_values`, `aes_status`, `get_query`, `errors` 벡터가 코덱, key version, 마스킹된 bind, 오류 코드를 검사한다 |
| IF-33 | 매니페스트에서 구성요소 도표를 생성한다. `make interface-check`가 도표, 심볼 스냅샷, 소스 변이를 검사한다 |
| IF-34 | PHP와 TypeScript는 체인 규칙을 따르는 이름만 해석하고, Go와 Rust 생성기는 다른 이름을 빌드 전에 거부한다 |

구조 검사는 공통 메서드와 저장 필드를 먼저 대조하고, 네이티브 선언의 누락·추가·변경을 보고한다. 심볼 목록마다 SHA-256 값을 `contracts/interfaces.json`에 고정하므로 명세를 갱신하지 않고 선언을 바꾸면 실패한다. `owners`는 `Page`와 `AESRotationStatus`의 필드를 제한하므로 심볼 목록만 다시 기록해도 상태 필드를 추가할 수 없다. PHP의 기본 readonly setter 표기처럼 언어 버전이 자동으로 추가하는 표현은 정규화하며 명시적인 접근 제한 변경은 보존한다. 언어마다 소스 변경 반례 7개를 검사한다.

### Planner 소유 위치

| 클라이언트 | Planner와 생성 모델 소유 위치 | 실행 소유 테스트 | 사용 부분·공유 검사 |
|---|---|---|---|
| Go | `engine/*`을 `clients/go/orm`이 직접 호출하며 생성 모델은 `clients/go/model`에 있다 | `clients/go/orm/*_test.go`, `clients/go/model/*_test.go` | `tests/conformance/runner.go`, `tests/interfaces/check` |
| PHP | `clients/php/src`가 PDO를 통해 계획·실행하며 생성 모델은 `clients/php/gen`에 있다 | `clients/php/tests/*.php` | `tests/conformance/runner.php`, `tests/interfaces/php.php` |
| Rust | `clients/rust/orm`이 sqlx를 통해 계획·실행하며 `orm-build`가 모델을 생성한다 | `clients/rust/tests/src`, `clients/rust/orm/src/*_test.rs` | `tests/conformance/runner_rust.rs`, `tests/interfaces/rust` |
| TypeScript | `clients/typescript/src`가 네이티브 driver를 통해 계획·실행하며 생성 모델은 `clients/typescript/src/models`에 있다 | `clients/typescript/tests` | `tests/conformance/runner_typescript.mjs`, `tests/interfaces/typescript.mjs` |

각 owner 테스트는 해당 client 디렉터리에 둔다. Conformance는 네 결과를 비교하며 owner 테스트를 대체하지 않고, `tests/interfaces/check`가 공통 선언과 생성물을 검사한다.

이 결과는 명시한 인터페이스와 시나리오의 검증이다. 함수 본문 전체의 등가성이나 모든 입력에 대한 증명으로 확대하지 않는다. 전체 진행 상태는 [체크리스트](checklist.ko.md)에서 관리한다.
