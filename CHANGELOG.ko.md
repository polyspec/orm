# 변경 이력

## Unreleased

- SQLite 물리 테이블 이름에서 논리 schema namespace를 보존하도록 `schema.table`을 `schema__table`로 매핑하여 하나의 database에서 같은 이름의 table이 충돌하지 않게 한다.
- 생성 SQLite index 이름에도 qualified 물리 table 이름을 namespace로 사용하여 module의 같은 논리 index 이름이 충돌하지 않게 한다.
- 하나의 자식 column이 서로 다른 복합 관계선을 포함한 둘 이상의 foreign key에 참여할 때 이를 보존한다. generated DDL 순서와 migration diff가 하나의 column reference로 제약을 합치지 않고 관계 metadata를 사용한다.
- `ErrorCode`, `IsDuplicateKey`, `IsForeignKey`를 통해 adapter에 독립적인 Go 오류 분류를 제공하며 호출자가 driver 오류 타입을 검사하지 않도록 한다.
- Go ORM client가 `DB.Stats`와 `DB.Acquire`를 통해 ORM 소유 pool 통계와 불투명한 connection lease를 제공하며 `database/sql` query 접근은 노출하지 않는다.
- Go ORM client가 `IsTransactionFinished`를 제공하여 호출자가 드라이버 전용 오류를 비교하지 않고 종료된 transaction을 판별할 수 있다.
- Go generated `Get`은 빈 결과에서 `NO_ROWS`를 반환하고, 선택적 행 조회를 위해 명시적인 `GetOrNil`을 생성한다.
- `%% aes_version`로 AES version column을 선언할 수 있으며 generator는 특정 column 이름을 가정하지 않고 manifest metadata를 사용한다.
- 감사 redaction은 선언된 JSON 경로가 없을 때 값을 변경하지 않으며 PostgreSQL에서 없는 부모 객체를 materialize하지 않는다.
- Go JSON·JSONS codec이 ordered-json 값을 사용하여 객체 멤버 순서를 보존하고 빈 객체와 빈 배열을 구분한다.
- Go JSON·JSONS codec이 tag가 있는 Go 구조체와 raw `jsontext.Value` 입력을 표준 JSON encoder 경계 없이 ordered-json으로 변환한다.
- Go client가 ordered-json 모노레포의 `github.com/polyspec/ordered-json/go` `v0.0.1` 패키지를 사용한다.

## 0.0.1

- 초기 개발 version이다.
- 공통 IR, compiler, generated client, database executor, migration, 인증된 version encryption, relation, batch, keyset pagination, conformance check를 추가했다.
- SQLite 중복 키·외래 키 오류가 어댑터 독립 ORM 오류 계약으로 매핑되는지 검증한다.
- namespace를 보존한 물리 table 이름을 처리하도록 어댑터 독립 `SchemaInstalled` transaction 연산에 SQLite 지원을 추가한다.
- PostgreSQL·SQLite에서 안전한 초기 schema preflight를 수행할 수 있도록 어댑터 독립 database-empty 검사를 추가한다.
- 빈 database preflight가 `pg_toast` 같은 PostgreSQL system namespace를 사용자 객체로 세지 않도록 수정한다.
