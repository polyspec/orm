# 변경 이력

## Unreleased

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
- 평탄화된 논리 schema 이름을 처리하도록 어댑터 독립 `SchemaInstalled` transaction 연산에 SQLite 지원을 추가한다.
