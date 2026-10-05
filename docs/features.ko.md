# 기능 정의

실행 기준은 저장소의 기능 manifest이다. 먼저 manifest의 `source.read_order` 경로를 읽고 선택한 기능의 모든 참조 경로를 읽는다. 각 항목은 input, output, 상태 전이, 오류, client 지원 상태, fixture, test, paired document, 실제 검증 명령을 정의한다.

| ID | 기능 | 상태 | Client 지원 |
|---|---|---|---|
| dsn_connection | DSN URI 연결 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| model_queries | 모델 조회 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| model_writes | 모델 쓰기 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| transactions | 트랜잭션 | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| statement_events | Statement event | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
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
| catalog_connection | Rust catalog 연결 | partial | go: unsupported<br>php: unsupported<br>rust: pass<br>typescript: unsupported |

## 현재 동작

- `dsn_connection`: 하나의 URI DSN으로 데이터베이스를 연다. URI scheme이 driver를 정하고 모든 연결이 datetime을 UTC로 읽고 쓰며, client는 자기 process에서 statement를 계획한다. PHP client는 PDO driver 확장을 요구하지 않으므로 pdo_mysql이 없는 PHP도 SQLite로 실행한다. MySQL DSN은 ssl-mode=VERIFY_IDENTITY와 절대 경로 ssl-ca로 TLS 연결하며, 이는 server 인증서를 CA와 host 이름에 대조한다. PHP와 TypeScript client는 scheme마다 정한 parameter 밖의 parameter를 거부한다. poolSize를 둔 PHP process는 php-fpm worker처럼 database의 연결을 그 수까지 요청을 넘어 유지하고, 끝난 요청이 열어 둔 transaction을 그 lock과 local 값과 함께 종료한다. 모든 client는 server가 끝냈거나 끊긴 연결을 CONNECTION_LOST로 보고하며, PHP client는 Db의 첫 statement가 그렇게 실패하면 새 연결에서 한 번 더 전송한다.
- `model_queries`: 생성된 모델 메서드로 조건, 조인, 관계, 컬럼, 서브쿼리, 집계, 페이지를 만들고 행을 모델과 컬렉션으로 읽는다.
- `model_writes`: 생성, 다건 생성, 선택적 낙관적 잠금 갱신, 저장, 선택적 관계 재귀 삭제를 수행하며 upsert의 duplication 할당을 포함한다. primary key나 unique key 하나의 값으로 찾은 soft delete한 행을 다른 컬럼의 새 값과 함께 restore하고 되돌린 행을 반환한다.
- `transactions`: 현재 실행 흐름이 공유하는 트랜잭션에서 콜백을 실행한다. 중첩 호출은 savepoint를 쓰고, 교착 재시도, 격리 수준, 읽기 전용, timeoutMs, 행 잠금, 이름 잠금, 트랜잭션 지역 값을 제공한다. SQLite 쓰기 트랜잭션은 시작할 때 쓰기 잠금을 얻고 busy_timeout까지 잠금을 기다린다. 각 클라이언트의 test entry point는 rollback fault를 설정한다. callback이 실패한 다음 트랜잭션의 rollback은 실행된 뒤 FAULT로 보고되어 트랜잭션이 ROLLBACK을 반환한다.
- `statement_events`: client가 보내는 모든 statement에 대해 연결에 등록한 subscriber에게 event를 publish한다: statement, 가린 bind, 출처에 따른 kind, statement가 가리키는 table, 경과 시간, 연결에서의 transaction 번호, 오류다. subscriber는 statement 뒤 operation이 이어지기 전에 동기로 실행되고, 실패한 subscriber는 operation을 SUBSCRIBER로 실패시킨다. 모든 client는 같은 transaction 제어 statement를 실행한다.
- `model_generation`: 언어별 생성기로 dbspec document set에서 모델을 만든다. Go와 Rust는 소스를 읽어 호출한 체인 메서드를 만들고, PHP는 실행 시 체인을 해석하며 TypeScript는 읽은 체인에 타입을 붙인다. `--check`를 붙이면 Go, PHP, TypeScript 생성기는 쓰지 않고 모델을 출력 디렉터리와 비교한다.
- `schema_definition`: dbspec document를 parse하고 emit하며, document set의 manifest와 schema hash를 계산하고, dialect별 DDL을 렌더링하고, 데이터베이스를 document로 introspect하며, 두 schema의 차이를 plan으로 만들어 검증과 복구를 갖춰 적용하고, Mermaid 다이어그램을 export하고 import한다. apply와 introspection의 TypeScript 선언은 connection을 자체 type으로 적으므로, 그것을 부르는 code는 pg, mysql2, node:sqlite type 없이 type 검사를 통과한다.
- `schema_install`: 연결로 dbspec document set을 설치한다. 모든 client가 자기 dialect의 문장을 렌더링해 set의 table이 하나도 없으면 모두 만들고, 모두 있으면 아무것도 바꾸지 않으며, 일부만 있으면 CONFIG로 실패한다. 그다음 database의 set table을 set과 비교하고 각 차이를 적은 CONFIG로 실패한다. utils().schema().register나 generated code의 connect helper로 연결에 set을 등록하는 것은 database를 읽거나 쓰지 않으며, install과 addTablesAndColumns가 database를 확인한다. 한 process가 여러 document set의 generated code를 읽고, 한 연결이 그 모두를 각 요청의 manifest hash에 맞는 model로 처리한다. addTablesAndColumns는 설치한 document set에 database에 없는 table과, 기존 table에 빠진 column 가운데 null이거나 default가 있는 column을 dialect의 plan step으로 더하며, 그 step은 각 table을 index, foreign key, check, trigger와 함께 만들고 바뀐 table의 audit trigger를 바꾼다. 다른 set의 table은 바꾸지 않고, 다른 모든 차이에는 변경 전에 SCHEMA_DIFFERS를 반환한다. 다른 set의 외부 문서를 쓰는 set은 자기 table만 소유한다. install과 addTablesAndColumns는 쓰는 외부 table이 선언대로 database에 있기를 요구하고 아니면 CONFIG로 실패하며, 그 table을 만들거나 바꾸지 않는다.
- `planner`: 값이 없는 request를 manifest로 검증하고 dialect SQL, bind slot, 조립 정보, 각 statement가 가리키는 table을 client process에서 만든다. 네 planner는 같은 statement를 만든다.
- `composite_keys`: 선언된 모든 primary key와 foreign key 구성 요소를 식별, 쓰기, 관계, tuple 조건, 페이지에서 유지한다.
- `authenticated_encryption`: 인증과 버전이 있는 AES 값과 blind index를 인코딩하고, 섞인 key version을 읽으며, 테이블의 모든 암호화 컬럼을 배치로 회전한다.
- `parameter_chunking`: 관계 key 목록을 크기 등급으로 채우고, 관계 key와 큰 root IN 목록을 driver bind 한도에서 나누어 결과를 합치며, 병합이 결과를 바꾸는 root 모양은 거부한다.
- `constraints_and_relations`: CHECK 제약, index, 내부와 외부 foreign key, soft delete, 변경 불가 테이블, 관계 삭제 동작을 planner와 migration 시스템에서 유지한다.
- `audit_triggers`: 테이블의 audit 설정은 audit column과, 그 column의 선언한 restrict foreign key의 대상인 audit 기록 테이블을 정하고, 삽입·갱신된 모든 행을 선언한 history 테이블에 복사하는 행 trigger를 설치한다. 설정은 모든 column을, 또는 exclude나 include 목록이 고른 column만 기록하며, history 테이블은 기록하는 column만 가진다. 연결 설정은 현재 요청의 audit 값을 돌려주는 audit source를 받고, audit 값을 가진 트랜잭션은 이를 한 번 불러 callback 전에 그 값과 트랜잭션의 값으로 감사 대상 테이블이 references로 정한 테이블에 audit 기록 하나를 삽입한다. 트랜잭션 안의 모든 감사 대상 insert, update, soft delete, restore는 그 기록의 key를 쓰며, 이는 모든 트랜잭션 진입점에서 같다: 연결이나 그 context, signal handle을 통한 Go Transaction, PHP transaction, TypeScript transaction, 그리고 Rust transaction, transaction_send, transaction_once다. 중첩 트랜잭션은 바깥 audit을 유지한다.
- `interface_contract`: 모든 클라이언트는 contracts/interfaces.json에 선언한 공개 심볼을 노출한다. 각 언어는 모델 코드를 실행하지 않고 실제 구문 트리에서 선언을 뽑고, 비교 도구는 심볼, 필드, 반환, 오류가 공통 인터페이스와 다르면 실패한다.
- `performance_gate`: Go와 PHP 클라이언트는 seed한 MySQL 벤치 데이터베이스에서 hot-path 지연 시간을 순수 드라이버와의 비율 안에서 유지하며, make perf-check는 작업량이 기록한 상한을 넘으면 실패한다. Rust 벤치 도구는 상한 없이 측정만 하고 TypeScript 기준은 만들지 않았다.
- `conformance_verification`: 같은 모델 체인을 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 실행하고 statement와 결과를 기록된 벡터와 비교한다.
- `catalog_connection`: live-db feature가 켜진 orm-build는 하나의 DSN으로 catalog 연결을 열고, table metadata와 제한된 table page를 읽고, dialect로 parse한 read-only query를 실행하며, 검증된 snapshot으로 row를 insert, update, delete한다. Rust client만 제공한다.

make feature-check는 경로를 검사하고 planned가 아닌 기능의 검증 명령을 실제 실행한다. implemented 항목은 test와 paired document가 필요하다. partial과 planned는 미완료 상태다.
