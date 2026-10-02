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
| audit_triggers | 감사 트리거 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| interface_contract | 공통 인터페이스 검증 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| performance_gate | hot-path 성능 기준 | partial | go: pass<br>php: pass<br>rust: partial<br>typescript: planned |
| conformance_verification | 적합성 검증 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |

## 현재 동작

- `dsn_connection`: 하나의 URI DSN으로 데이터베이스를 연다. URI scheme이 driver를 정하고 timezone 파라미터가 연결 시간대를 정하며, client는 자기 process에서 statement를 계획한다.
- `model_queries`: 생성된 모델 메서드로 조건, 조인, 관계, 컬럼, 서브쿼리, 집계, 페이지를 만들고 행을 모델과 컬렉션으로 읽는다.
- `model_writes`: 생성, 다건 생성, 선택적 낙관적 잠금 갱신, 저장, 선택적 관계 재귀 삭제를 수행하며 upsert의 duplication 할당을 포함한다.
- `transactions`: 현재 실행 흐름이 공유하는 트랜잭션에서 콜백을 실행한다. 중첩 호출은 savepoint를 쓰고, 교착 재시도, 격리 수준, 읽기 전용, timeoutMs, 행 잠금, 이름 잠금, 트랜잭션 지역 값을 제공한다. SQLite 쓰기 트랜잭션은 시작할 때 쓰기 잠금을 얻고 busy_timeout까지 잠금을 기다린다. 각 클라이언트의 test entry point는 rollback fault를 설정한다. callback이 실패한 다음 트랜잭션의 rollback은 실행된 뒤 FAULT로 보고되어 트랜잭션이 ROLLBACK을 반환한다.
- `model_generation`: 언어별 생성기로 dbspec document set에서 모델을 만든다. Go와 Rust는 소스를 읽어 호출한 체인 메서드를 만들고, PHP는 실행 시 체인을 해석하며 TypeScript는 읽은 체인에 타입을 붙인다. `--check`를 붙이면 Go, PHP, TypeScript 생성기는 쓰지 않고 모델을 출력 디렉터리와 비교한다.
- `schema_definition`: dbspec document를 parse하고 emit하며, document set의 manifest와 schema hash를 계산하고, dialect별 DDL을 렌더링하고, 데이터베이스를 document로 introspect하며, 두 schema의 차이를 plan으로 만들어 검증과 복구를 갖춰 적용하고, Mermaid 다이어그램을 export하고 import한다.
- `schema_install`: 연결로 dbspec document set을 설치한다. 모든 client가 자기 dialect의 문장을 렌더링해 테이블이 하나도 없으면 만든다. 한 process는 여러 document set의 generated code를 읽고, 연결 하나가 각 요청을 그 manifest hash의 model로 처리해 그 모두를 처리한다.
- `planner`: 값이 없는 request를 manifest로 검증하고 dialect SQL, bind slot, 조립 정보를 client process에서 만든다. 네 planner는 같은 statement를 만든다.
- `composite_keys`: 선언된 모든 primary key와 foreign key 구성 요소를 식별, 쓰기, 관계, tuple 조건, 페이지에서 유지한다.
- `authenticated_encryption`: 인증과 버전이 있는 AES 값과 blind index를 인코딩하고, 섞인 key version을 읽으며, 테이블의 모든 암호화 컬럼을 배치로 회전한다.
- `parameter_chunking`: 관계 key 목록을 크기 등급으로 채우고, 관계 key와 큰 root IN 목록을 driver bind 한도에서 나누어 결과를 합치며, 병합이 결과를 바꾸는 root 모양은 거부한다.
- `constraints_and_relations`: CHECK 제약, index, 내부와 외부 foreign key, soft delete, 변경 불가 테이블, 관계 삭제 동작을 planner와 migration 시스템에서 유지한다.
- `audit_triggers`: 테이블의 audit 설정은 행 trigger를 설치해, 삽입·갱신·삭제된 모든 행을 트랜잭션이 정한 작업 id와 함께 선언한 history 테이블에 복사한다.
- `interface_contract`: 모든 클라이언트는 contracts/interfaces.json에 선언한 공개 심볼을 노출한다. 각 언어는 모델 코드를 실행하지 않고 실제 구문 트리에서 선언을 뽑고, 비교 도구는 심볼, 필드, 반환, 오류가 공통 인터페이스와 다르면 실패한다.
- `performance_gate`: Go와 PHP 클라이언트는 seed한 MySQL 벤치 데이터베이스에서 hot-path 지연 시간을 순수 드라이버와의 비율 안에서 유지하며, make perf-check는 작업량이 기록한 상한을 넘으면 실패한다. Rust 벤치 도구는 상한 없이 측정만 하고 TypeScript 기준은 만들지 않았다.
- `conformance_verification`: 같은 모델 체인을 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 실행하고 statement와 결과를 기록된 벡터와 비교한다.

make feature-check는 경로를 검사하고 planned가 아닌 기능의 검증 명령을 실제 실행한다. implemented 항목은 test와 paired document가 필요하다. partial과 planned는 미완료 상태다.
