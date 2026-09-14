# 변경 이력

## Unreleased

- Go ORM client가 `IsTransactionFinished`를 제공하여 호출자가 드라이버 전용 오류를 비교하지 않고 종료된 transaction을 판별할 수 있다.
- Go generated `Get`은 빈 결과에서 `NO_ROWS`를 반환하고, 선택적 행 조회를 위해 명시적인 `GetOrNil`을 생성한다.
- `%% aes_version`로 AES version column을 선언할 수 있으며 generator는 특정 column 이름을 가정하지 않고 manifest metadata를 사용한다.

## 0.0.1

- 초기 개발 version이다.
- 공통 IR, compiler, generated client, database executor, migration, 인증된 version encryption, relation, batch, keyset pagination, conformance check를 추가했다.
