# 공통 인터페이스 구현 대조표

기준: [공통 인터페이스 v1](interfaces.md), [기계 명세](../contracts/interfaces.json), [생성 도표](interfaces-model.md). 재현 명령과 검사 범위는 [검사 안내](../tests/interfaces/README.md)에 있다.

로컬 검증: **conformance 벡터 22개 × Go·PHP·Rust·TypeScript × MySQL·PostgreSQL·SQLite에서 문장, bind, 결과가 같다**. 완료 전에 최종 CI 실행이 필요하다.

| 인터페이스 | 구현과 검증 |
|---|---|
| IF-01, IF-18, IF-32 | 각 client는 같은 planner의 이식본으로 자기 process에서 request를 계획하고 모델의 schema hash를 확인한다. conformance 벡터가 네 client의 계획된 SQL과 bind를 비교한다. `tests/interfaces/check`는 Go, Rust, TypeScript의 request 레코드 20개를 필드 단위로 비교한다 |
| IF-02 | 컬럼 값은 논리 타입을 유지한다. `TestConnectionTimeZone`과 PHP, TypeScript, Rust의 같은 테스트가 세 데이터베이스에서 네 시간대의 날짜·시각 값을 검사한다 |
| IF-03 ~ IF-08 | 생성된 모델은 체인 상태를 core 객체 하나에 저장한다. `conditions_connectors`, `conditions_group`, `conditions_values`, `joins`, `errors` 벡터가 연결자, 그룹, 값 모양, 조인 배치, 잘못된 체인을 검사한다 |
| IF-09 ~ IF-12 | 모델 메서드 22개를 언어별로 고정한다. Go는 생성 모델, PHP와 TypeScript는 기반 클래스, Rust는 `orm-build` 템플릿이다. `terminal_by`와 `terminal_reuse`가 터미널과 모델 하나의 재사용을 검사한다 |
| IF-13 ~ IF-17 | `Db.connect`, `Db.transaction`, `Db.utils`, `Utils.lock`, `SchemaUtils.install`, AES 유틸리티를 언어별로 고정한다. `transactions` 벡터와 client 트랜잭션 테스트가 savepoint, 행 잠금, 이름 잠금, 지역 값을 검사한다 |
| IF-19, IF-20 | `relations`, `relation_empty`, `subqueries` 벡터가 관계 statement와 조립을 검사한다. `TestBindLimitSplitting`이 세 데이터베이스에서 Go의 큰 IN 목록 분할을 검사한다. PHP, Rust, TypeScript에는 분할 테스트가 없다 |
| IF-21 ~ IF-24 | `write_cycle`, `now_defaults`, `creates_and_save`, `delete_recursive` 벡터가 변경 필드 쓰기, 시각 기본값, upsert, 낙관적 갱신, 재귀 삭제를 검사한다 |
| IF-25 ~ IF-27 | owner 규칙이 모든 언어에서 `Page` 필드 5개와 `AESRotationStatus` 필드 4개를 고정한다. client 모델 테스트가 key 컬렉션과 페이지를 검사한다 |
| IF-28 ~ IF-31 | 코덱 벡터 80개, AES 벡터, `aes_values`, `aes_status`, `get_query`, `errors` 벡터가 코덱, key version, 마스킹된 bind, 오류 코드를 검사한다 |
| IF-33 | 매니페스트에서 구성요소 도표를 생성한다. `make interface-check`가 도표, 심볼 스냅샷, 소스 변이를 검사한다 |
| IF-34 | PHP와 TypeScript는 체인 규칙을 따르는 이름만 해석하고, Go와 Rust 생성기는 다른 이름을 빌드 전에 거부한다 |

구조 검사는 공통 메서드와 저장 필드를 먼저 대조하고, 네이티브 선언의 누락·추가·변경을 보고한다. 심볼 목록마다 SHA-256 값을 `contracts/interfaces.json`에 고정하므로 명세를 갱신하지 않고 선언을 바꾸면 실패한다. `owners`는 `Page`와 `AESRotationStatus`의 필드를 제한하므로 심볼 목록만 다시 기록해도 상태 필드를 추가할 수 없다. PHP의 기본 readonly setter 표기처럼 언어 버전이 자동으로 추가하는 표현은 정규화하며 명시적인 접근 제한 변경은 보존한다. 언어마다 소스 변경 반례 7개를 검사한다.

이 결과는 명시한 인터페이스와 시나리오의 검증이다. 함수 본문 전체의 등가성이나 모든 입력에 대한 증명으로 확대하지 않는다. 전체 진행 상태는 [체크리스트](checklist.ko.md)에서 관리한다.
