# 기능 정의

실행 기준은 저장소의 기능 manifest이다. 먼저 manifest의 `source.read_order` 경로를 읽고 선택한 기능의 모든 참조 경로를 읽는다. 각 항목은 input, output, 상태 전이, 오류, client 지원 상태, fixture, test, paired document, 실제 검증 명령을 정의한다.

| ID | 기능 | 상태 | Client 지원 |
|---|---|---|---|
| dsn_connection | DSN URI 연결 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| model_queries | 모델 조회 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| model_writes | 모델 쓰기 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| transactions | 트랜잭션 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| model_generation | 모델 생성 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| schema_definition | 스키마 정의와 마이그레이션 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| schema_install | 스키마 설치 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| planner | 프로세스 내 planner | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| composite_keys | 복합 key | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| authenticated_encryption | 인증 암호화 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| parameter_chunking | 파라미터 분할 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| constraints_and_relations | 제약과 관계 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| conformance_verification | 적합성 검증 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |

## 현재 동작

- `dsn_connection`: 하나의 URI DSN으로 데이터베이스를 연다. URI scheme이 driver를 정하고 timezone 파라미터가 연결 시간대를 정하며, client는 자기 process에서 statement를 계획한다.
- `model_queries`: 생성된 모델 메서드로 조건, 조인, 관계, 컬럼, 서브쿼리, 집계, 페이지를 만들고 행을 모델과 컬렉션으로 읽는다.
- `model_writes`: 생성, 다건 생성, 선택적 낙관적 잠금 갱신, 저장, 선택적 관계 재귀 삭제를 수행하며 upsert의 duplication 할당을 포함한다.
- `transactions`: 현재 실행 흐름이 공유하는 트랜잭션에서 콜백을 실행한다. 중첩 호출은 savepoint를 쓰고, 교착 재시도, 격리 수준, 읽기 전용, timeoutMs, 행 잠금, 이름 잠금, 트랜잭션 지역 값을 제공한다.
- `model_generation`: 언어별 생성기로 schema.json에서 모델을 만든다. Go와 Rust는 소스를 읽어 호출한 체인 메서드를 만들고, PHP는 실행 시 체인을 해석하며 TypeScript는 읽은 체인에 타입을 붙인다.
- `schema_definition`: Mermaid 다이어그램에서 schema.json을 만들고, dialect별 DDL을 렌더링하며, 데이터베이스를 다이어그램으로 가져오고, 두 manifest를 비교해 forward와 rollback migration을 만든다.
- `schema_install`: 연결로 manifest를 설치한다. 모든 client가 자기 dialect의 생성 DDL을 렌더링해 없는 테이블을 만들고 manifest를 등록한다.
- `planner`: 값이 없는 request를 manifest로 검증하고 dialect SQL, bind slot, 조립 정보를 client process에서 만든다. 네 planner는 같은 statement를 만든다.
- `composite_keys`: 선언된 모든 primary key와 foreign key 구성 요소를 식별, 쓰기, 관계, tuple 조건, 페이지에서 유지한다.
- `authenticated_encryption`: 인증과 버전이 있는 AES 값과 blind index를 인코딩하고, 섞인 key version을 읽으며, 테이블의 모든 암호화 컬럼을 배치로 회전한다.
- `parameter_chunking`: 관계 key 목록을 크기 등급으로 채우고, 관계 key와 큰 root IN 목록을 driver bind 한도에서 나누어 결과를 합치며, 병합이 결과를 바꾸는 root 모양은 거부한다.
- `constraints_and_relations`: CHECK 제약, index, 내부와 외부 foreign key, soft delete, 변경 불가 테이블, 관계 삭제 동작을 planner와 migration 시스템에서 유지한다.
- `conformance_verification`: 같은 모델 체인을 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 실행하고 statement와 결과를 기록된 벡터와 비교한다.

make feature-check는 경로를 검사하고 planned가 아닌 기능의 검증 명령을 실제 실행한다. implemented 항목은 test와 paired document가 필요하다. partial과 planned는 미완료 상태다.
