# 기여 안내

## 필수 작업 순서

1. `AGENTS.md`가 있으면 읽고 `contracts/features.json`에서 관련 경로를 읽는다.
2. 예상하거나 확인한 결함을 재현하는 test를 추가한다.
3. engine, generator, 영향받은 모든 client에 완전한 변경을 구현한다.
4. 영문과 한글 paired document를 함께 갱신한다.
5. 관련 로컬 검사를 실행하고 필요하면 commit 설명에 결과를 기록한다.

## Interface 변경

공통 contract, generated artifact, language client, example, structure check를 함께 갱신한다. 특정 client에만 공개된 기능은 미완료로 처리한다.

## Commit message

동작을 나타내는 짧은 영문 명령형 제목을 사용한다. 예: `Implement root IN chunking`. 하나의 commit에는 하나의 변경 범위만 둔다.

## Pull request

동작 변경, 영향받은 client와 database, 실행한 test, 알려진 제한을 작성한다. credential, 운영 data, repository generator가 생성하지 않는 generated file은 포함하지 않는다.
