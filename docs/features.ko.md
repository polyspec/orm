# Feature contract

실행 정본은 [contracts/features.json](../contracts/features.json)이다. 먼저 매니페스트의 `source.read_order` 경로를 읽고 선택한 기능의 모든 참조 경로를 읽는다. 각 항목은 input, output, 상태 전이, 오류, client 지원 상태, fixture, test, paired document, 실제 검증 명령을 정의한다.

| ID | 기능 | 상태 | Client 지원 |
|---|---|---|---|
| schema_migrations | Schema migration | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| composite_keys | Composite keys | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| authenticated_encryption | Versioned authenticated encryption | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| parameter_chunking | IN 및 relation parameter limit | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| batch_writes | Typed batch write | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| keyset_pagination | Typed keyset pagination | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| transactions | Transaction option | partial | go: partial<br>php: partial<br>rust: partial<br>typescript: partial |
| precompiled_plans | Precompiled plan bundle | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| constraints_and_relations | Constraint 및 relation predicate | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| conformance_verification | Cross-client conformance verification | partial | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |

## 현재 동작

- `schema_migrations`: 모델 schema 상태를 비교하고 검증된 forward 및 rollback operation을 생성한다.
- `composite_keys`: 선언된 primary 및 foreign key component 전체를 identity, CRUD, relation, pagination, rotation에서 보존한다.
- `authenticated_encryption`: 인증된 version ciphertext를 저장하고 여러 key version을 읽으며 모든 암호화 column을 제한된 재개 가능 batch로 회전한다.
- `parameter_chunking`: database limit에 따라 relation parameter tuple과 큰 root IN 목록을 분할하면서 결과 순서와 relation 조립을 보존한다. 안전하게 분할할 수 없는 root query 형태는 명시적 오류로 거부한다.
- `batch_writes`: typed insert, upsert, primary-key update, primary-key delete request를 제한된 chunk와 하나의 transaction으로 실행하고 결정적인 count를 반환한다.
- `keyset_pagination`: version cursor, 완전한 composite order, validation, forward 및 backward traversal을 제공한다.
- `transactions`: 명시적 retry, isolation, read-only, savepoint, row lock, timeout, cancellation과 capability error를 제공한다.
- `precompiled_plans`: 검증된 plan bundle을 로드하고 일치하는 request를 compiler 호출 없이 실행한다.
- `constraints_and_relations`: CHECK, index, foreign-key, soft-delete, relation existence, relation count, many-to-many through metadata를 planner와 migration system에서 보존한다. 생성 client가 MySQL·PostgreSQL·SQLite에서 선언된 operation을 실행한다.
- `conformance_verification`: 공통 input vector를 Go, PHP, Rust, TypeScript에서 실행하고 database별 normalized result를 비교한다.

make feature-check는 경로를 검사하고 planned가 아닌 기능의 검증 명령을 실제 실행한다. implemented 항목은 test와 paired document가 필요하다. partial과 planned는 미완료 상태다.
