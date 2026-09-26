# 기능 coverage 검증

`contracts/features.json`의 각 기능은 `coverage.kind`, 중복되지 않는 `coverage.cases`, `coverage.owners`, `coverage.consumers`를 선언한다. 데이터베이스를 읽거나 바꾸는 동작에는 `database`, 그 외에는 `independent`를 쓴다. 상태가 `pass` 또는 `partial`인 모든 client는 `clients/<language>` 아래에 `part`, `tests`, 필요한 각 데이터베이스(`mysql`, `postgres`, `sqlite`) 또는 `none` 한 칸의 언어별 테스트 명령을 선언한다. 각 사용 부분은 자기 디렉터리에 별도 사례와 테스트를 선언한다. 선언이 빠지거나 선언한 부분 밖의 경로이면 `make feature-check`가 실패한다.

각 데이터베이스 칸에는 `runner`(`node`, `php`, `go`, `cargo`), `test`(`tests`에 선언된 정확한 경로), 중복되지 않는 `cases`를 가진 명령 객체 배열을 둔다. 선언된 모든 테스트와 사례는 정확히 한 번 있어야 한다. 데이터베이스 명령은 데이터베이스 URI를 담은 필수 환경 변수 이름 `dsn_env`도 지정한다. 검사기는 셸 문자열과 추가 명령 필드를 거부한다. Node와 PHP 테스트 파일에는 선언된 사례 ID를 인자로 전달하며 테스트는 검증을 통과한 뒤에만 `CASE <id> PASS`를 출력한다. Go는 고정된 사례 필터로 `go test -json`, Rust는 정확한 사례 필터로 `cargo test`를 실행한다. 검사기는 성공 종료 코드와 각 선언 사례의 관찰된 통과 이벤트를 요구한다. 테스트 출력은 성공 보고서를 제공할 수 없다.
Go와 Rust의 `symbols`는 각 공통 사례 ID를 선언한 소스 파일의 정확한 실제 테스트 이름에 연결한다. 검사기는 누락·추가·중복된 심볼 이름을 거부하고 각 실제 테스트 통과 이벤트를 확인한 뒤 공통 ID를 기록한다. Node와 PHP는 공통 ID를 직접 사용한다. 데이터베이스 명령의 실제 테스트 프로세스에는 선택한 데이터베이스와 선언한 URI를 `ORM_FEATURE_DATABASE`, `ORM_FEATURE_DSN`으로 전달하며 URI가 없으면 테스트 시작 전에 실패한다.

데이터베이스 실행마다 검사기는 같은 URI에 대해 테스트 직전과 직후 상태 판독기를 실행한다. 상태 digest는 검사기가 직접 기록하며 테스트 출력은 제공할 수 없다. 각 테스트 묶음은 프로세스마다 10분 제한으로 두 번 실행한다. 두 실행에서 선언된 사례만 관찰하고 결과가 같아야 한다. 데이터베이스 상태는 각 실행 전후와 실행 사이에 같아야 한다. 환경, 테스트 이벤트, 데이터베이스 테이블 또는 상태 판독이 빠지면 실패한다. 검사기는 저장된 보고서를 읽지 않는다.

`scripts/features/coverage.test.mjs`의 테스트는 필요한 차원을 하나씩 바꾸고 만들어 낸 JSON 성공, 누락된 소유자, 사용자, 테스트 경로, client, 데이터베이스, 사례, 반복 실행, 상태 비교 또는 선언되지 않은 결과에서 실패를 요구한다. 주장한 모든 동작에 현재 실행 증거가 생길 때까지 `make feature-check`는 실패한다. 검사기 자체 테스트가 성공해도 client 동작의 완료를 주장하지 않는다.
`node scripts/features/coverage.mjs --feature dsn_connection`은 다른 기능의 coverage 선언이 완성되는 동안 DSN 연결 기능만 실행한다. 전체 명령은 모든 기능을 계속 검사하며 선언이 빠질 때마다 실패한다. DSN 기능은 세 데이터베이스에서 네 client의 읽기 전용 소유 사례와 Go·Rust client 부분의 생성 모델 사용 사례를 실행한다. 선택한 URI는 `ORM_FEATURE_DSN`으로 전달하고 검사기는 두 실행의 전후 데이터베이스 상태를 읽는다.
