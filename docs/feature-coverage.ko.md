# 기능 coverage 검증

`contracts/features.json`의 각 기능은 `coverage.kind`, `coverage.cases`, `coverage.commands`를 선언한다. 데이터베이스를 읽거나 바꾸는 동작에는 `database`, 그 외에는 `independent`를 쓴다. 상태가 `pass` 또는 `partial`인 모든 client는 필요한 각 데이터베이스(`mysql`, `postgres`, `sqlite`) 또는 `none` 한 칸에 명령을 제공한다. 명령이 없으면 `make feature-check`가 실패한다.

명령은 현재 환경에서 사례를 한 번 실행하고 표준 출력에 JSON 보고서 하나만 쓴다. 검사기가 각 명령을 두 번 실행한다. 각 보고서는 `feature`, `language`, `database`, `success: true`, `cases`, 선언된 사례 ID마다 `{ "id": "case-id", "value_json": "..." }` 결과 하나를 담은 배열 `results`를 포함한다. `value_json`은 binary64 정밀도를 벗어난 숫자까지 직렬화한 값을 정확히 보존한다. 데이터베이스 명령은 관찰한 데이터베이스 상태에서 계산한 비어 있지 않은 `state_before`와 `state_after` digest도 보고한다. 검사기는 실행 전후와 두 실행 사이의 digest가 같은지 확인하고 결과 배열도 비교한다. 각 명령을 10분으로 제한하고 실패 종료 코드와 잘못된 보고서를 거부한다. 진단 문구는 표준 오류에 쓴다. 저장된 보고서는 읽지 않는다.

`scripts/features/coverage.test.mjs`의 테스트는 필요한 차원을 하나씩 바꾸고 누락된 client, 데이터베이스, 사례, 반복 실행, 상태 비교 또는 선언되지 않은 결과에서 실패를 요구한다. 현재 기능 선언에는 이 명령이 아직 없으므로 주장한 모든 동작에 현재 실행 증거가 생길 때까지 `make feature-check`는 실패한다. 검사기 자체 테스트가 성공해도 client 동작의 완료를 주장하지 않는다.
