# 공개 소스 준비 계획

상태: 진행 중. 버전은 0.0.1로 유지한다. 작업 범위는 커밋과 `origin/main` 푸시까지이며 패키지 게시와 릴리스 생성은 제외한다.

## 개발 규칙

예상하거나 확인한 결함은 구현을 변경하기 전에 재현 테스트를 작성한다. 테스트는 예상한 원인으로 실패해야 한다. 같은 테스트와 기존 테스트 전체가 통과해야 구현을 완료한다. 직접 실패를 재현하면 데이터베이스가 손상될 수 있는 경우 격리된 fixture에서 먼저 검사하고, 해당하면 containerctl로 관리하는 MySQL·PostgreSQL·SQLite에서 다시 검사한다.

각 항목의 완료 조건은 다음과 같다.

1. 결함이나 누락된 불변 조건을 재현하는 unit 또는 model test를 작성한다.
2. 공통 명세, engine, generator, 영향받는 모든 client에 구현한다.
3. 공개 interface가 변경되면 언어 간 구조와 token을 검사한다.
4. 데이터베이스 동작은 물리 데이터베이스에서 검사한다.
5. 같은 heading, example, table, link를 가진 영어·한국어 문서를 작성한다.
6. 전체 검사가 깨끗하게 통과한 뒤 항목을 완료로 변경한다.

## P8: 정확성과 안전성

- [x] P8.1 Schema migration diff가 index, unique constraint, full-text index, foreign key, delete action, nullability, default, type, comment를 처리한다. PostgreSQL은 필요한 `ALTER COLUMN` operation을 모두 생성한다.
- [x] P8.2 명시적인 table·column rename 선언이 데이터를 보존하고 결정적인 forward·rollback plan을 생성한다.
- [x] P8.3 SQLite가 지원하는 구조 변경은 검증된 table rebuild로 처리하고 안전하지 않은 rebuild는 실행 전에 거부한다.
- [x] P8.4 복합 primary·foreign key가 schema import, planning, generated API, identity, CRUD, relation, pagination, AES rotation에서 동작한다. 지원하지 않는 선언은 schema build 중 실패한다.
  - [x] P8.4a Schema parsing, database import, DDL/diff 생성, planning, join, relation 조회, tuple 중복 제거, 충돌 없는 distinct count가 선언 순서의 모든 key component를 보존한다.
  - [x] P8.4b Go, PHP, Rust, TypeScript가 key type, 전체 key finder, 순서가 있는 row identity, 부분 key save 거부, composite collection key, composite AES rotation 조건을 생성한다.
  - [x] P8.4c 생성된 insert/update/delete/save/paginate가 rollback과 key 구성요소 하나를 공유하는 행을 포함한 MySQL, PostgreSQL, SQLite 물리 테스트를 네 client에서 통과한다. CI는 `scripts/client-db-test.sh`로 같은 시나리오를 실행한다.
- [x] P8.5 공개 encryption이 모든 client에서 인증된 version ciphertext를 사용한다. 조회는 숨겨진 row key version을 선택하고, 여러 version을 함께 읽을 수 있고, 변조 데이터는 실패하며, rotation은 row의 모든 AES column을 제한된 재개 가능 batch로 처리한다. Go, PHP, Rust, TypeScript가 codec tamper vector와 물리 rotation test를 통과한다.
- [x] P8.6 암호화 데이터의 equality search는 명시적인 blind-index column을 요구한다. Runtime은 인증된 AES v2 ciphertext만 허용한다. Go, PHP, Rust, TypeScript가 MySQL, PostgreSQL, SQLite 통합 테스트를 통과한다.
- [x] P8.7 Relation과 root positive `IN` parameter가 각 database limit에 맞게 결정적으로 분할되고 non-`IN` parameter, row 결과, relation attachment, count 결과를 보존한다. 분할할 수 없는 ordering, limiting, grouping, distinct, keyset, `NOT IN` 형태는 `IR_INVALID`로 반환한다.
- [x] P8.8 Plan 및 prepared-statement cache가 설정 가능한 제한, 결정적 eviction, close 처리, 모든 client의 pressure test를 제공한다. Go·PHP·Rust·TypeScript test가 plan eviction, statement eviction, close 처리를 검사하며 PHP SQLite 물리 통합 test가 같은 검사를 통과한다.

## P9: 공통 ORM 작업

- [x] P9.1 Batch insert, upsert, primary key update, primary key delete가 typed input, 제한된 chunk, 하나의 transaction, 결정적인 affected-row result를 사용한다. Go·PHP·Rust·TypeScript가 MySQL·PostgreSQL·SQLite에서 rollback 및 result test를 통과한다.
- [x] P9.2 Keyset pagination이 generated typed cursor, 완전한 composite order, version cursor encoding, validation, forward/backward traversal, duplicate-page test를 사용한다.
- [x] P9.3 Transaction callback은 기본으로 재시도하지 않는다. 명시적인 retry policy가 deadlock retry를 제어하고 callback 요구사항을 문서화한다. Go·PHP·Rust·TypeScript 검사가 기본 경로와 명시적 재시도 경로를 확인한다.
- [ ] P9.4 Transaction option이 isolation, read-only mode, nested savepoint, query timeout/cancellation, 지원되는 row lock을 처리한다. 지원하지 않는 database mode는 정확한 capability error를 반환한다.
  - [x] P9.4a root `forUpdate`와 `forShare` row lock이 공통 IR을 사용하고 MySQL/PostgreSQL에서 실행된다. SQLite는 `CAPABILITY_UNSUPPORTED`를 반환한다. timeout/cancellation이 남아 있으므로 P9.4 전체를 완료하지 않는다.
- [x] P9.5 모든 client가 검증된 precompiled plan bundle을 로드하고 일치하는 cache hit에서 compiler request 없이 사용한다. Go·PHP·Rust·TypeScript가 bundle version, schema hash, dialect, request hash, request kind, plan body를 검사하며 client test가 일치하는 cache hit에서 compiler를 호출하지 않는 것을 확인한다.
- [x] P9.6 CHECK constraint와 완전한 index·foreign-key metadata가 Mermaid, manifest, SQL, live database import, diff, migration, verification에서 보존된다. SQLite unit test와 물리 MySQL·PostgreSQL importer test가 명명된 CHECK 복원을 검증한다.
- [ ] P9.7 Many-to-many traversal이 명시적인 through entity와 typed relation metadata를 모든 client에서 사용한다.
- [ ] P9.8 Relation existence/count predicate와 선언형 soft-delete policy가 조회와 쓰기에 planner 강제 predicate를 사용한다.
  - [x] P9.8a `soft_delete` schema directive가 nullable datetime column을 검증하고 planner가 삭제 행을 제외하며 delete를 timestamp update로 변환한다. 네 client의 물리 DB 검증은 남아 있다.

## P10: 검증

- [x] P10.1 model 및 property test가 schema round trip, migration operation order, cursor round trip, query cloning, codec round trip을 검사한다. schema와 generator 갱신 후 대상 test와 100회 manifest round-trip property test가 통과했다.
- [x] P10.2 fuzz test가 Mermaid, manifest, IR, SQL migration statement splitting, cursor, ciphertext decoder의 panic 및 무제한 allocation을 검사한다. 필요한 6개 fuzz target이 로컬 1초 smoke 실행을 모두 통과했다.
- [x] P10.3 Failure-injection test가 compiler failure, driver failure, cancellation, transaction failure, cache eviction, migration interruption, rotation interruption을 검사한다. 기존 client·migration test가 앞의 6개 실패를 검사하고, AES test가 batch 중간 database failure를 주입하여 transaction rollback과 재실행을 검사한다.
- [ ] P10.4 Concurrency test가 optimistic update, deadlock, savepoint, migration lock, AES rotation, cache access를 검사한다.
- [ ] P10.5 MySQL·PostgreSQL·SQLite 물리 검사가 parameter limit, 모든 migration operation, batch write, keyset pagination, transaction mode, encryption 변경을 `-state` 없는 containerctl로 검사한다.
- [ ] P10.6 Go·PHP·Rust·TypeScript가 추가된 모든 operation에서 동일한 common-vector result와 호환되는 public structure를 생성한다.

## P11: source 및 package 검증

패키지 게시, 릴리스 생성, 공개 저장소 준비, Pages 수동 배포는 수행하지 않는다. source document, package metadata, 로컬 package check는 범위에 포함한다.

- [x] P11.1 오래되거나 사실과 다른 README 및 manual 내용을 수정하고 `README.ko.md`를 제공한다.
- [x] P11.2 보안 신고, 기여, 행동 강령, 변경 이력 문서를 추가하고 사용자 대상 문서는 한국어 파일을 함께 작성한다.
- [x] P11.3 Package name, description, license, repository link, runtime requirement, included file, generated-artifact rule을 완성한다.
- [x] P11.4 게시하지 않고 TypeScript package의 `npm pack`, Composer metadata, Rust `orm` crate의 `cargo package`, 외부 임시 Go module을 검증한다.
- [ ] P11.5 CI가 document rule, generated drift, interface check, red-test regression, physical database test, package check, 전체 test suite를 실행한다.

## 완료

- [ ] G8 범위에 포함된 P8~P10 항목이 명시한 test를 통과하고 `make check`가 통과한다. working tree가 clean이고 local `HEAD`가 `origin/main`과 같다.
