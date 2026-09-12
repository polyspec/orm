# Feature contract

실행 정본은 [contracts/features.json](../contracts/features.json)이다. 각 항목은 input, output, 상태 전이, 오류, client 지원 상태, fixture, test, paired document를 정의한다.

| ID | 기능 | 상태 | Client 지원 |
|---|---|---|---|
| schema_migrations | Schema migration | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| composite_keys | Composite keys | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| authenticated_encryption | Versioned authenticated encryption | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| parameter_chunking | IN 및 relation parameter limit | partial | go: partial<br>php: partial<br>rust: partial<br>typescript: partial |
| batch_writes | Typed batch write | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| keyset_pagination | Typed keyset pagination | planned | go: planned<br>php: planned<br>rust: planned<br>typescript: planned |
| transactions | Transaction option | partial | go: partial<br>php: partial<br>rust: partial<br>typescript: partial |
| precompiled_plans | Precompiled plan bundle | implemented | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |
| constraints_and_relations | Constraint 및 relation predicate | partial | go: partial<br>php: partial<br>rust: partial<br>typescript: partial |
| conformance_verification | Cross-client conformance verification | partial | go: pass<br>php: pass<br>rust: pass<br>typescript: pass |

make feature-check로 manifest와 참조 경로를 검사한다. implemented 항목은 test와 paired document가 필요하다. partial과 planned는 미완료 상태다.
