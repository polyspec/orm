# 프로젝트 체크리스트 (0.0.1 완료)

표기: `[ ]` 대기, `[~]` 진행 중, `[o]` 완료, `[!]` 일시 우회.

## 공통 인터페이스 검증

- [o] I1 `interfaces.md`와 Mermaid 다이어그램에 공통 구조, 소유 규칙, 상태 전이를 정의한다.
- [o] I2 모델 문법에 맞춰 `contracts/interfaces.json`, 생성 구성 요소 페이지, 심볼 검사를 다시 생성한다. 근거: `go run ./tests/interfaces/check --generate --record --self-test`와 `make interface-check`가 매니페스트, 두 구성 요소 페이지, 네 심볼 스냅샷, 소스 변경 반례를 다시 생성하고 대조했으며 생성물이 최신이고 네 언어가 모두 통과했다.
- [o] I3 모델 문법과 프로세스 내 플래너에 맞춰 구현 대조표를 다시 작성한다. 근거: 영문·국문 매트릭스가 각 언어의 planner와 생성 모델 소유 위치, owner 테스트 위치, 공유 conformance 검사, SQLite datetime 범위를 명시하며 `make interface-check`와 문서 쌍 검사가 통과했다.
- [o] I4 네 클라이언트에서 연결, 트랜잭션, 관계, 쓰기, 시간대를 물리 데이터베이스로 검증한다.
- [o] I4.1 PHP request 레코드 선언 20개를 공통 필드·중첩 타입 정의와 대조한다. 소스 변경 반례는 검사에 실패하고 PHP 단독 선언 검사는 통과해야 한다.
- [o] I4.2 모든 인터페이스 오류 표기와 기록된 오류 결과를 `docs/errors.yaml`과 대조한다. 알 수 없거나 중복된 표기와 잘못된 오류 결과는 실패해야 한다.

## 온라인 문서

- [o] D1 VitePress로 Markdown 페이지를 빌드하고 구현 상태와 로컬 검색을 제공한다.
- [o] D2 Mermaid 다이어그램을 SVG로 렌더링하고 JavaScript 없는 페이지 내용을 검증한다.
- [o] D3 `/orm/` 링크, 앵커, 직접 HTML 경로, 검색, 모바일 탐색, 반복 빌드를 검사한다.
- [!] D4 현재 페이지를 https://polyspec.github.io/orm/ 에 배포하고 검증한다. 원인: 정적 사이트를 두 번 빌드해 동일한 결과를 확인했고 로컬 정적 검사를 통과했으며 현재 Pages URL도 HTTP 200을 반환하지만, 이 저장소는 로컬 전용이고 개발 규칙이 현재 커밋의 push·게시를 금지한다. 재시도: 현재 `main` 커밋을 승인된 방식으로 push하거나 GitHub Actions 배포를 실행한 뒤 배포된 콘텐츠 hash와 경로를 검증한다.

## 1단계 — 모델 문법

- [o] M1 네 클라이언트에 모델 생성과 `connect`, 체인, 연결자, 그룹, 연산자, 값 형태, 컬럼 비교, 튜플, 서브쿼리를 구현한다.
- [o] M2 관계, 조인, 컬럼 선택, 정렬, 그룹, limit, finder, 집계, 페이지를 구현한다.
- [o] M3 쓰기를 구현한다: `set`, `setRaw`, `new<Name>`, `plus`, `minus`, `create`, `creates`, `duplication`, `update`, `update(true)`, `save`, `delete`.
- [o] M4 실행 흐름 단위 트랜잭션, savepoint, 재시도, 옵션, 행 잠금, `connection.utils()`를 구현한다.
- [o] M5 예약 컬럼 이름과 생성 메서드와 충돌하는 이름을 거부한다.

## 2단계 — 프로세스 내 계획과 생성기

- [o] N1 검증, 계획, 방언, DDL을 PHP, Rust, TypeScript로 이식하고, Go 클라이언트는 엔진 패키지를 직접 호출한다.
- [o] N2 언어마다 생성기 하나를 제공한다: `ormgen gen --lang go`, `vendor/bin/orm-gen`, `orm-gen` npm bin, `orm-build` crate.
- [o] N2.1 실패 가능한 styled setter 다음 Rust Result 처리를 모델 호출과 구분한다. 우선순위: 생성 모델 컨트롤러 컴파일에 필요하다. 수락 기준: 추적 expect/unwrap 소스 사례가 수정 전 실패하고 생성은 Result 메서드를 만들지 않으면서 후속 호출의 모델을 유지하며 알 수 없는 모델 메서드는 계속 실패한다. Rust 소스 분석은 클라이언트 전용이며 런타임과 다른 클라이언트는 바꾸지 않는다. 증거: 소유 Result 처리 사례는 잘못된 expect 열 메서드로 먼저 실패했고 생성 사례 10개와 집중 Clippy가 통과한다. 생성 컨트롤러의 styled setter expect 호출이 컴파일되고 설정 사례를 포함한 CLI 68개가 통과한다. 체크리스트 검사는 통과하며 기존 문서 규칙 문제는 남아 있다.
- [o] N3 네 클라이언트에서 MySQL, PostgreSQL, SQLite의 `utils().schema().install()`을 구현한다.
- [o] N4 세 데이터베이스에 연결 시간대를 적용한다: PostgreSQL 오프셋 시간대, 시각 읽기, SQLite 시계 기본값, MySQL 명칭 시간대 오류.
- [o] N5 프로세스 내 러너로 conformance 검사기를 실행하고 벡터를 다시 기록한다. 네 출력이 일치할 때만 기대값을 기록하고 거부 시 파일을 보존하며 TypeScript의 SQLite 정수 결과를 정확히 유지한다. 세 데이터베이스 기대값 파일의 `write_cycle.price`를 고정 소수부 텍스트로 기록했다. 증거: 출력 누락·불일치 및 벡터 누락·추가 사례는 실패하고 기록·TypeScript 정수 사례는 통과한다. `make conformance-check`는 MySQL, PostgreSQL, SQLite 각각 25개 벡터 × 네 클라이언트와 클라이언트별 동일한 두 실제 실행 및 행·카운터 상태 불변을 검증하며 통과한다.
- [o] N5.1 MySQL, PostgreSQL, SQLite에서 네 클라이언트를 모두 실행하고 모든 벡터를 기록된 기대값과 비교하며, 반복 실행이 관찰 대상 데이터베이스 상태를 바꾸지 않는지 확인한다. 증거: `make conformance-check`가 통과한다. 각 데이터베이스에서 25개 벡터를 네 클라이언트와 비교하고 실제 결과 테스트가 각 클라이언트를 두 번 실행해 출력이 같고 행과 카운터가 바뀌지 않음을 확인한다.
- [o] N5.1.1 네 출력을 모두 요구하고 오래된 출력과 달라진 반복 결과를 거부하며 실행 시간을 제한한다. 모든 테이블 행과 선언된 counter를 검사하고 선언된 테스트 counter만 복원하며 MySQL, PostgreSQL, SQLite에서 counter 관찰과 정리를 테스트한다.
- [o] N5.1.1.1 JSON 숫자를 float64 반올림 없이 비교하고 기록한다. 2^53을 넘는 서로 다른 정수를 구분하고 동등한 십진 표현은 같은 값으로 처리한다.
- [o] N5.1.1.2 중첩 JSON 실행 증거와 기대값의 중복 키를 거부하고 데이터베이스 기대값 파일이 없으면 실패한다.
- [o] N5.1.1.3 실행기 명령 로그에서 `-dsn`과 `--dsn` 양쪽 표기의 데이터베이스 연결 문자열을 가린다.
- [o] N5.1.1.4 어느 테이블에도 `AUTOINCREMENT`가 없어 `sqlite_sequence`가 존재하지 않을 때 SQLite 상태를 읽는다. 테이블이 없음을 확인했을 때만 카운터 0개로 처리하고 행 변경과 테이블이 있을 때의 시퀀스 변경은 계속 감지하며 다른 질의 오류는 거부한다.
- [o] N5.1.1.4.1 SQLite 카운터 기준을 두 체크리스트 언어로 기록한다. `sqlite_sequence` 테이블이 없음을 확인한 경우만 카운터 0개로 처리하고 다른 질의 오류는 실패시킨다. 문서 표현 규칙과 항목 ID·상태 일치를 검증한다.
- [o] N5.1.2 네 conformance 실행기 모두 예상 밖 오류를 전파하고 쓰기 실패 시 상태를 정리하며 세 데이터베이스에서 공통 집계 스칼라 기준을 강제한다. 증거: N5.1.2.9–N5.1.2.11이 실행기 오류와 쓰기 경로를 검증하고, N5.1.2.12는 각 데이터베이스에서 네 실행기를 두 번씩 실행하여 출력과 행·카운터 상태가 같은지 확인하며, N5.1.2.13은 세 데이터베이스에서 Rust 불리언 집계 결과를 검증한다. `make conformance-result-check`가 통과하고 기능 목록은 중앙 Go 실행기 테스트를 client 소유 근거와 구분해 등록한다.
- [o] N5.1.2.1 Go 값 변환, host 인코딩, 생성 모델 대입이 잘못된 형식, null, 범위 초과, 지원하지 않는 값을 오류로 보고한다. 유효한 값을 실행 테스트로 검증하고 행 조립의 대입 오류를 전파하며 insert 필드를 쓰기 전에 검증한다.
- [o] N5.1.2.2 PHP와 TypeScript의 잘못되거나 유한하지 않은 집계 스칼라를 거부하고 공통 9개 사례로 가장 가까운 binary64 변환을 검증한다.
- [o] N5.1.2.3 네 클라이언트의 생성 모델에서 decimal 컬럼 값을 정확히 보존한다. 생성된 decimal 필드는 `48.0450`을 포함해 고정 소수부 자릿수 텍스트를 binary64 변환 없이 받고 반환하며, 정밀도 1–18 또는 소수부 자릿수 0–정밀도를 벗어난 선언은 실패한다. SQLite는 배율을 적용한 부호 있는 정수를 저장하고 MySQL과 PostgreSQL은 decimal 값을 저장한다. scalar 집계에는 별도의 유한 binary64 기준을 유지한다. 증거: 네 클라이언트에서 공통 decimal 사례가 통과한다. `make decimal-physical-check`는 MySQL, PostgreSQL, SQLite에서 각 생성 모델을 두 번 실행하여 소유 테스트 24건, rollback, 데이터베이스 행과 카운터의 상태 불변을 검증한다. 기능 목록은 decimal 소유 테스트를 등록하며 전체 기능 coverage 감사는 G1에서 계속 관리한다.
- [o] N5.1.2.3.1 정확한 값 기준을 바꾸지 않고 Rust decimal 실제 데이터베이스 assertion의 불필요한 `as_deref()`를 제거한다. 원인: `get_large_value()`가 이미 빌린 선택적 문자열을 반환하므로 `cargo clippy -p orm-tests --all-targets -- -D warnings`가 `clients/rust/tests/src/decimal_physical.rs:22`에서 실패했다. 근거: assertion이 빌린 선택적 문자열을 직접 비교하도록 바뀌었고 `orm` 및 `orm-tests` 표적 Clippy가 통과했으며 변경한 Rust 실제 사례가 MySQL·PostgreSQL·SQLite에서 정확한 값 `9007199254740993`과 rollback을 유지하며 통과했다.
- [o] N5.1.2.4 Go, PHP, Rust, TypeScript 스키마 빌더의 `auto` 컬럼이 NULL을 허용하지 않는 부호 있는 `i64` 기본 키이도록 강제한다. 각 언어는 동일한 허용·거부 Mermaid 사례를 실행하고 거부된 선언의 원천 행을 보고한다.
- [o] N5.1.2.4.1 실제 SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` 컬럼을 각 스키마 도구에서 부호 있는 `i64` 자동 키로 읽고, 자동 키가 아닌 `INTEGER` 컬럼은 `i32`로 유지한다. 클라이언트에서 실제 SQLite 가져오기와 스키마 빌드를 검증한다.
- [o] N5.1.2.5 Go scalar·collection 키의 문자열 대체 경로를 정확한 타입별 키 표현으로 바꾼다. 지원하지 않는 값은 실패하고 서로 다른 값은 충돌하지 않으며 relation, 분할 질의, collection 호출자가 오류를 전파한다. 증거: Go 소유 RED/GREEN 사례가 타입별 scalar·복합 key, 잘못된 값, byte 스캔 타입, relation key, 분할 질의 중복 제거, 모델 key callback, collection 조회를 검증한다. Go client 전체와 실행기 단위 사례가 통과하고 MySQL·PostgreSQL·SQLite에서 모델 조건·join·relation·컬럼·subquery가 통과한다. Go vet, 문서, 규칙, 체크리스트 검사도 통과한다.
- [o] N5.1.2.6 네 클라이언트와 세 데이터베이스에서 SQL NULL, 인코딩된 null 값, 조회하지 않은 값 스타일 컬럼을 구분한다. 완료된 Go·PHP·TypeScript·Rust 소유 사례는 공통 13개 사례와 MySQL·PostgreSQL·SQLite 실제 데이터베이스 사례로 저장 텍스트, getter, 행 배열, 모델 JSON 출력, 오류를 검증한다. TypeScript 출력 검증 사례도 각 데이터베이스에서 두 번 통과한다.
- [o] N5.1.2.6.1 Go codec과 생성 모델 setter·getter에서 값 스타일 상태를 명시적으로 구분한다. MySQL, PostgreSQL, SQLite에서 공통 상태, 행 배열, 모델 JSON, 오류를 검증한다.
- [o] N5.1.2.6.2 PHP 값 스타일 컬럼의 setter, getter, codec, 모델 출력에 `StyledValue`를 사용한다. MySQL, PostgreSQL, SQLite에서 공통 상태 사례와 실제 모델 동작을 검증한다.
- [o] N5.1.2.6.3 TypeScript 값 스타일 컬럼의 setter, getter, codec, 모델 출력에 `StyledValue`를 사용한다. MySQL, PostgreSQL, SQLite에서 공통 상태·codec 사례와 실제 모델 동작을 검증한다.
- [o] N5.1.2.6.4 Go conformance 쓰기 실행기에 명시적인 값 스타일 값을 전달하고 쓰기 전에 각 setter 오류를 반환한다. MySQL, PostgreSQL, SQLite에서 모델 생성, 실행기 컴파일, Go 모델·런타임 테스트를 검증한다.
- [o] N5.1.2.6.5 Rust 값 스타일 컬럼 codec과 생성 setter·getter에 `StyledValue`를 사용한다. null 불허 컬럼의 `SqlNull`을 setter에서 거부하고 미조회 필드를 보고하며 SQL NULL과 인코딩된 null을 저장, 행 배열, 모델 JSON에서 보존한다. 증거: 공통 13개 사례와 Rust 라이브러리·생성기 테스트 23/23 통과, 생성된 null 불허 스타일 setter가 `SqlNull`을 거부하고 인코딩된 JSON null을 수용하는 사례 1/1 통과, `orm-tests integration --case json_values`가 MySQL·PostgreSQL·SQLite에서 각각 두 번 및 setter 사례 추가 후 한 번 더 통과, 작업공간 Clippy·서식·영한 문서·체크리스트 검사 통과.
- [o] N5.1.2.6.5.1 명시적인 `StyledValue` 값 래퍼에 맞춰 Rust 모델 JSON 출력 검사를 갱신하면서 정렬된 JSON 멤버 순서와 숫자 텍스트를 보존한다. 원인: 완료된 스타일 컬럼 구현은 `{"kind":"value","value":...}`를 출력하지만 기존 정렬 텍스트 검사는 이전의 래퍼 없는 문서를 예상했다. 증거: `cargo test --offline --locked -p orm --test model_output -- --exact json_output_keeps_the_ordered_json_text`가 두 정렬 fixture에서 통과한다.
- [o] N5.1.2.6.6 TypeScript 값 스타일 JSON 출력에서 정의되지 않았거나 생략되는 멤버를 모델 변경 전과 인코딩·대입 값 읽기 시 거부한다. 소유 RED 사례는 `StyledValue.value({missing: undefined}).toJSON()`, 중첩 객체, 빠진 배열 위치, 숨은 멤버와 심볼 멤버, 지원하지 않는 객체, 대입 후 변경을 검증한다. 소유 사례와 TypeScript 빌드가 통과하고 `model.mjs --case styledStates --dialect`가 MySQL·PostgreSQL·SQLite에서 각 두 번 통과하며 영한 문서·체크리스트 검사도 통과한다.
- [o] N5.1.2.6.6.1 TypeScript conformance 결과의 값 스타일 값에 정의되지 않은 멤버가 있으면 `CODEC_ENCODE` 코드를 검사한다. 추적된 중앙 결과 테스트는 종전 진단 문구 검사에서 실패하고 코드 검사 뒤 5/5 통과하며 TypeScript 값 스타일 소유 사례와 영한 문서·체크리스트 검사도 통과한다.
- [o] N5.1.2.7 생성 Rust 모델 필드를 비공개로 두고 조회하거나 대입하지 않은 필드 접근을 `COLUMN_UNSELECTED`로 거부한다. SQL 열 선택을 유지하고 일부 필드만 채운 모델 대신 `GroupRows`로 그룹 값과 검증한 행 개수를 반환한다. 증거: MySQL·PostgreSQL·SQLite에서 생성 모델과 그룹 사례를 실행하고 잘못된 그룹 개수를 거부하며 Rust code가 결과 타입으로 컴파일된다.
- [o] N5.1.2.8 실패한 실행을 포함하여 모든 conformance 실행 뒤 모든 테이블 행과 선언된 카운터를 확인한다. 실행기 오류와 남은 데이터베이스 상태 변경을 함께 보고한다. SQLite 오류 사례와 MySQL·PostgreSQL·SQLite 실제 데이터베이스 사례로 실패 보고와 정리를 검증한다.
- [o] N5.1.2.9 PHP와 TypeScript conformance 실행기가 잘못된 파생 정수와 결과 값을 거부하고 ordered JSON 숫자를 정확히 보존하며 예상 밖 벡터 오류를 전파하고 쓰기 벡터를 트랜잭션에서 실행한다. 결과 사례와 MySQL, PostgreSQL, SQLite에서 행·카운터를 바꾸지 않는 동일한 두 실행을 검증한다.
- [o] N5.1.2.10 Go conformance 실행기가 잘못된 질의 바인딩과 누락된 조회 필드를 거부하고 예상 밖 오류를 보존하며 집계 binary64 값을 검증하고 쓰기 벡터를 트랜잭션에서 실행한다. 오류 사례와 MySQL, PostgreSQL, SQLite에서 행·카운터를 바꾸지 않는 동일한 두 실행을 검증한다.
- [o] N5.1.2.11 Rust conformance 실행기가 잘못된 바인딩과 파생 정수 값을 거부하고 다른 binary64 비트의 집계 평균을 거부하며 예상 밖 벡터 오류를 전파하고 실패한 쓰기 벡터를 롤백한다. 잘못된 암호문 접두를 RED·GREEN 사례로, MySQL·PostgreSQL·SQLite에서 실패한 쓰기 상태를 검증한다. N5.1.2의 네 클라이언트 성공 비교는 계속 필요하다.
- [o] N5.1.2.12 실제 결과 테스트가 MySQL, PostgreSQL, SQLite에서 정확한 네 client 목록을 각각 두 번 실행하고 두 출력을 비교하며 모든 행과 카운터가 이전 상태로 돌아오는지 검증한다. Rust 실행기가 빠지면 실행 전에 실패해야 한다. 중앙 Go 실행기 테스트를 기능 목록에 등록하고 실행하되 client 소유 증거로 사용하지 않는다. 증거: 네 client 중 세 개만 있는 경우 실패하며 수정 후 client/데이터베이스 12개 사례와 각 반복 실행 및 중앙 Go 실행기 테스트가 통과한다.
- [o] N5.1.2.13 선택한 Rust 불리언 그룹 컬럼을 `GroupRows` 반환 전에 선언된 타입으로 해석한다. 소유 RED 사례는 불리언 그룹 결과의 정수 `0`/`1`을 재현하고 잘못된 불리언을 거부해야 하며, 수정 후 다른 타입 컬럼을 바꾸지 않고 GREEN이 되어야 한다. 증거: Rust 라이브러리 16/16과 Clippy가 통과했고 MySQL, PostgreSQL, SQLite에서 `aggregates` 벡터가 각각 두 번 기대값과 같으며 행과 카운터가 바뀌지 않았다.
- [o] N6 컴파일러 서비스, 메시지 정의, WASM·FFI 진입점, 배포 유닛을 제거하고 Makefile과 CI를 갱신한다.
- [o] N7 문자열로 받은 SQLite datetime 텍스트를 저장 형식인 소수 여섯 자리 형태로 비교한다. 근거: Go `TestConnectionTimeZone`, PHP 모델 모음, TypeScript 모델 모음이 SQLite에서 소수부가 없거나 0인 문자열과 분수부 문자열을 비교하고 날짜만 있는 datetime을 거부하며 생성된 값을 6자리 형식으로 읽는다. 문자열 datetime 입력을 지원하는 MySQL·PostgreSQL에서도 같은 사례가 통과한다.
- [o] N8 `orm-build`로 150개 테이블 Rust 컴파일 검사를 실행한다. 근거: `make rust-150-check`가 150개 엔티티를 생성하고 모든 생성 모델의 getter, setter, chain을 호출하는 Rust crate를 컴파일했다.
- [o] N9 한 번 실행하는 Rust 트랜잭션에서 콜백의 오류 타입을 보존한다. MySQL, PostgreSQL, SQLite에서 rollback, commit, 중첩 savepoint 동작과 서로 다른 콜백·rollback 오류를 검증한다.
- [o] N9.1 `statement_timeout_ms`를 `busy_timeout`으로 적용해 SQLite 잠금 대기를 제한한다. 양수인 연결
  timeout은 선언한 한도에서 `CANCELED`를 반환하고 이후 작업을 위해 연결을 유지해야 한다. 증거: 200 ms
  한도를 사용하는 SQLite 소유 사례와 생성 model 사용자 사례가 통과하고 Rust format·Clippy가 통과한다.
- [o] N9.2 `Send` 서비스 callback을 통과해야 하는 생성 모델 쓰기에 `Db::transaction_send`를 제공한다.
  callback과 그 future가 `Send`임을 요구하고 트랜잭션 옵션과 재시도 동작을 보존하며 반환 future의 `Send` 요건을
  소유자 테스트로 검증한다. 증거: ORM 컴파일과 요건 테스트가 통과한다.

## 3단계 — 언어별 스키마 도구

- [ ] N9.2.1 Send savepoint의 기존 borrowed-Box 경고를 제거한다. 원인: 의존성을 포함한 Clippy가 orm/src/tx.rs의 savepoint_send에서 실패한다. 기준: lint 실패를 재현하고 소유 테스트로 Send/savepoint 동작을 보존하며 경고 억제 없이 통과한다.

- [o] L1 모든 언어에서 `.mmd` 파일로 `schema.json`을 빌드한다. 근거: `make schema-cross-language-check`가 같은 Mermaid 원본을 Go·PHP·Rust·TypeScript로 빌드하고 전체 JSON 매니페스트를 비교해 12개 엔티티와 schema hash `16198b563e2e3cae`가 네 출력에서 같음을 보고했다.
- [o] L2 모든 언어에서 마이그레이션과 import 도구를 제공한다. 증거: Go SQLite 가져오기 테스트가 `DECIMALINT(13,4)`와 `DECIMALINT(16,0)`을 논리 decimal 타입으로 정규화하고 manifest를 빌드한다. PHP schema 도구가 SQLite·MySQL·PostgreSQL에서 마이그레이션과 가져오기를 통과한다. Rust CLI 가져오기와 TypeScript SQLite 가져오기 테스트가 decimal 정밀도와 scale을 보존한다. 네 SQLite 가져오기 경로가 같은 논리 매핑을 사용하며 입력을 조용히 버리지 않는다.

## 스키마와 마이그레이션 도구

- [o] T7.3 결정적인 `ormgen diff`와 파괴적 변경 검사를 구현한다.
- [o] T7.5 Go, PHP, Rust, TypeScript에 YAML 1.2와 `point` 변환을 구현한다. MySQL, PostgreSQL, SQLite에서 `point` DDL과 SQL을 검증한다.
- [o] T7.9 같은 SQL, bind, 타입 결과, 연결 수, 픽스처로 Rust `mysql_async` 0.37.1과 sqlx 0.9를 비교한다. 두 측정 작업 모두 필요한 2배 개선이 없으므로 sqlx를 유지한다.
- [o] T7.10 지원 데이터베이스가 같은 안전한 매개변수 실행 구조를 제공할 수 없으므로 모든 공개 API에서 `multi_statement`를 제외한다. 네 클라이언트의 실행 가능한 제외 검사는 G4에서 다룬다.
- [o] T7.13 AES 버전 컬럼을 검증하고, 쓰기 시 현재 버전을 저장하고, Go, PHP, Rust, TypeScript에 상태 조회와 트랜잭션 회전 API를 제공한다.
- [o] T7.14 테이블·컬럼 주석을 manifest, 스키마 해시, import, DDL, diff, SQLite 메타데이터에 포함한다.
- [o] T7.15 MySQL, PostgreSQL, SQLite에 마이그레이션 실행 잠금, 트랜잭션 범위, 상세 복구 상태를 추가한다.
- [o] T7.16 세미콜론 분리를 방언을 아는 SQL 문장 파서로 바꾸고 문장 단위 실패 위치를 유지한다.
- [o] T7.17 DDL, diff, 구조화된 계획, 검증, 복구, 멱등 마이그레이션, 검증된 롤백에 MMD, manifest JSON, 메타데이터가 있는 ORM SQL, 라이브 DB 스키마 원본을 받는다.
- [o] T7.17.1 공개 라이브러리에 Rust DSN 전용 카탈로그 연결을 노출하고 CLI도 같은 구현을 사용한다. 근거: 모듈 누락 컴파일 Red와 없는 SQLite 파일 생성 Red를 수정했다. 실제 MySQL/PostgreSQL 반복 카탈로그 읽기·SQLite FK/내용 보존을 포함한 공개 API 소유 테스트 4개 및 기존 SQLite CLI 자동 rowid 임포트 회귀가 통과했다. 기존 동작 추출이며 무손실 물리 임포트나 임의 데이터 디코딩 완료가 아니다.
- [o] T7.17.1.1 공개 데이터 접근 확장 전에 카탈로그/도구 셀의 손실 디코딩을 거부한다. 원인: 미지원 셀은 NULL이 되고 잘못된 UTF-8은 대체되며 unsigned 오버플로가 순환한다. 기준: MySQL/PostgreSQL/SQLite 소유 물리 Red/Green·비밀값 없는 명시적 오류·정상 카탈로그/CLI 경로 유지. 근거: 7개 손실 사례 Red → 세 DB Green; 카탈로그 테스트 4개와 SQLite CLI 자동 rowid 사례 통과.
- [o] T7.17.1.2 잘못된 숫자/boolean 접근자 기본값을 검증된 결과로 바꾸고 카탈로그/마이그레이션 소유 경로에서 오류를 전달한다. T7.17.1.1 관련 항목. 원인: 잘못된 정수 문자열은 0이 되고 잘못된/NULL boolean은 false가 된다. 기준: 필수 변환은 값을 포함하지 않는 오류를 반환하고 선택적 정수만 NULL을 허용하며 카탈로그·마이그레이션 호출자가 트랜잭션 정리를 유지하면서 오류를 전달한다. 소유 접근자·실제 카탈로그·CLI 회귀 사례 통과. 근거: Result API 누락 컴파일 Red → 접근자 2개 Green(세 DB 포함); 카탈로그 4개·원시 셀 1개·CLI 5개 회귀 통과. 잘못된 SQLite 이력을 값 노출/변경 없이 거부하고 세 DB 계획/적용/롤백/복구 경로를 유지했다.
- [o] T7.17.1.3 Rust 도구 조회는 전체 행을 먼저 적재하지 않고 스트리밍 중 결과 누적을 제한한다. 원인: 카탈로그/도구 fetch_all 결과 적재에 상한이 없다. 근거: 예산 API 누락 컴파일 Red와 여러 문장 런타임 Red를 수정하고 MySQL prepared unsigned 오버플로 회귀를 재현·수정했다. 조회/카탈로그/접근자 소유 테스트 9개·CLI 11개가 통과했다. 실제 세 DB에서 정확/초과 예산·잘못된 상한·bind·빈 결과·값 없는 오류·연결 재사용을 검증했다. 기본 상한은 100,000행·JSON 결과 64MiB이며 잘린 성공 대신 거부하고 한 문장만 받는다. 누적 출력 제한이며 드라이버 패킷 메모리/DB 실행 제한이나 임의 SQL 결과 타입 완료를 의미하지 않는다.
- [o] T7.17.1.4 빈 결과와 중복 별칭에서도 순서 있는 제한된 조회 컬럼 메타데이터를 노출한다. 근거: 결과 API 누락 컴파일 Red를 수정하고 실제 MySQL·PostgreSQL·SQLite에서 중복 별칭 순서·빈 결과 컬럼·공개 카탈로그 조회를 검증했다. 소유 통합 테스트 10개·구현 후 메타데이터 예산 단위 회귀 1개·CLI 11개가 통과했다. 예약된 연결 하나에서 prepared 메타데이터와 검증된 행을 제공하며 2,048컬럼·이름/타입 64KiB로 제한한다. SQL 그리드 기반이며 읽기 전용 격리·전체 데이터 타입 완료는 아니다.
- [o] T7.17.1.5 방언 AST 검증과 DB가 강제하는 읽기 전용 범위 및 drop 시 폐기되는 연결로 제한된 카탈로그 조회를 노출한다. 근거: API 누락 컴파일 Red를 수정하고 소유 통합 테스트 11개·구현 후 정책/해제 단위 회귀 2개·CLI 11개가 통과했다. 실제 세 DB에서 MySQL 함수 내부 쓰기 거부·PostgreSQL/SQLite 읽기 전용 상태·행 보존·조회 오류 뒤 재실행을 검증했다. 이벤트 기반 중단 사례로 연결 풀 재사용 금지를 확인했으며 취소 지연은 미측정이다. 변경/트랜잭션 문장·쓰기 CTE·SELECT INTO·잠금·실행 주석을 거부하고 SQL 원문/오류를 보존하며 파서/방문 깊이를 제한한다. 초기 MySQL 세션 변수 검증 가정을 서버 설정 변경 없이 바로잡고 확인된 실패 테스트 fixture를 정리했다. OS/함수 샌드박스나 전체 SQL 타입 지원은 아니다.
- [o] T7.19 AES blind-index 스키마 선언, 키 기반 동등 조건, 쓰기 동기화를 추가한다.
- [o] T7.20 큰 루트 `IN` 조건을 나누고, `IN`이 아닌 매개변수를 유지하고, 행을 합치고, 개수 결과를 더하고, 안전하지 않은 query 형태를 거부한다.
- [o] T7.21 `soft_delete` 스키마 지시어를 추가하고, 읽기와 갱신에 활성 행 조건을 적용하고, 삭제를 시각 갱신으로 바꾼다.

- [o] T7.17.1.6 텍스트와 구분하며 바이트를 보존하는 바이너리 셀을 갖춘 제한된 Rust 타입형 읽기 전용 그리드 결과를 추가한다. 원인: 도구 값은 임의 바이트를 거부하거나 UTF-8 바이너리를 텍스트로 해석하므로 SQL 그리드 값을 정확히 표현하지 못한다. 근거: GridCell/API 누락 컴파일 Red가 Green이며 실제 세 DB의 바이너리/NULL/빈 값/텍스트 사례가 통과했다. 구현 후 추가한 예산·변경 정책·빈 메타데이터·bind 회귀도 통과했다. 소유 통합 테스트 12개·CLI 11개·라이브러리 5개가 통과했으며 스트리밍/메타데이터 예산과 읽기 전용 강제/해제는 기존 구현을 공유한다. 숫자/시간 타입·다른 client의 그리드 API는 미완료이며 바이너리 지원만으로 조회 타입을 완료하지 않는다.

- [o] T7.17.1.7 Rust 그리드의 네이티브 부동소수점 비트와 unsigned 정수 범위를 보존한다. 원인: 엄격한 카탈로그 스칼라 디코딩이 이 조회 값을 거부한다. 근거: 타입 variant 누락 컴파일 Red는 Green이며 실제 세 DB float64·PostgreSQL float32/부호 있는 0/NaN·MySQL u64::MAX 사례가 통과했다. 숫자 NULL·바이트 예산은 추가 회귀다. 통합 13개·CLI 11개·라이브러리 5개가 통과하며 엄격한 카탈로그 의미와 읽기 전용 해제를 유지한다. decimal/시간 타입은 미완료다.

- [o] T7.17.1.8 실수 변환 없이 유한 Rust 그리드 decimal 정밀도와 선언 scale을 보존한다. 원인: 그리드 값에 decimal 태그가 없고 고정 정밀도 모델 디코딩은 임의 SQL numeric 결과를 표현하지 못한다. 근거: decimal variant 누락 컴파일 Red가 실제 MySQL 65자리·PostgreSQL 끝자리 0 scale·SQLite 네이티브 저장 클래스에서 Green이다. 추가 PostgreSQL 200자리/지수·숫자 NULL·바이트 예산·비유한 거부 회귀가 통과했다. 통합 14개·CLI 11개·라이브러리 5개가 통과했다. BigDecimal 0.4.11을 고정하고 공개 드라이버 디코딩 뒤 PostgreSQL 이진 dscale을 복원하며 값이 달라지는 scale 조정을 거부한다. 비유한 numeric 지원·시간 타입은 미완료다.

- [o] T7.17.1.9 명시적 테이블 조회/편집을 위해 한정된 Rust 테이블 메타데이터의 선언 기본키 순서·네이티브 타입·nullable·생성 컬럼을 노출한다. 원인: 논리 카탈로그 컬럼 플래그는 복합키 순서를 잃고 신뢰할 행 식별을 확정할 수 없다. 근거: 공개 API 누락 컴파일 Red 후 실제 MySQL/PostgreSQL/SQLite 역순 복합키·생성 컬럼·nullable SQLite 키/rowid 별칭 Green. 추가 뷰·DESC/WITHOUT ROWID 키·타입 없는 컬럼·한정 이름/입력 회귀와 소유 테스트 12개가 통과했다. 메타데이터는 편집 권한이 아니며 변경·낙관적 충돌 검사는 미완료다.

- [o] T7.17.1.9.1 Rust 카탈로그 API로 한정된 MySQL 시스템 뷰 메타데이터를 읽는다. 원인: 실제 프로세스의 시스템 카탈로그 검사가 실패하며 관계 분류기에 SYSTEM VIEW 종류가 없었다. 근거: 실제 MySQL 네이티브 종류 확인·descriptor 실패 Red 후 신뢰할 행 식별 없는 View 분류 Green. 세 DB 일반 테이블/뷰 사례를 포함한 메타데이터/카탈로그 테스트 6개가 통과했다. 새 시스템 뷰 사례는 DB 내용을 변경하지 않으며 Rust 범위는 네 클라이언트 conformance를 증명하지 않는다.

- [o] T7.17.1.10 네이티브 타입형 그리드 API로 명시적 한정 Rust 테이블 페이지 조회를 추가한다. 원인: 임의 SQL 결과는 행 편집의 테이블/컬럼/키 출처를 보장하지 않는다. 근거: 공개 API 누락 컴파일 Red 후 실제 MySQL/PostgreSQL/SQLite의 정확한 컬럼·복합키 순서·인용 식별자·다음 페이지 Green. 추가 빈/뷰 페이지·offset/limit 상한·8 MiB 인코딩 초과/복구·변경 descriptor 조립 회귀가 통과했다. 소유 라이브러리/읽기 전용/메타데이터/페이지 테스트 10개 통과. 독립 offset 페이지는 요청 간 고정 스냅샷이나 편집 권한이 아니며 네 클라이언트 conformance는 별도 작업이다.
  - [o] T7.17.1.11 테이블 페이지에서 검증된 불변 Rust 행 편집 기준을 캡처했다. 근거: API 누락 컴파일 Red가 Green이며 기준 테스트 3개와 관련 라이브러리/메타데이터/페이지/읽기 전용 테스트 13개가 통과했다. 실제 세 DB 소유 fixture에서 변경 행 충돌과 정확한 원본 값 복구를 검증했다. 비NULL 기본키 순서와 8 MiB 제한 값별 revision을 유지하고 잘못된 식별/projection을 거부하며 스키마/누락/변경/중복 충돌을 구분한다. Debug/오류에 값을 넣지 않는다. 추가 유효성/타입/한도/실제 DB 검사는 회귀 검사다. 순수 API는 읽기/잠금/쓰기/권한이 아니며 타입형 bind·잠긴 변경 실행·4클라이언트 적합성은 미완료다.
  - [o] T7.17.1.12 네이티브 Rust 타입형 쓰기 bind를 텍스트/정수 이상으로 확장했다. 근거: 타입형 값/NULL API 누락 컴파일 Red가 Green이다. 새 소유 유효성/실제 경로 사례 3개와 라이브러리/네이티브/CLI 테스트 40개가 통과했으며 실제 세 DB 타입형 조회·저장 왕복·지원 NULL·영향 행·거부 복구·거부된 쓰기의 원본 유지·제약 오류·rollback을 포함한다. 추가 경로/타입/상한 검사는 회귀 검사다. SQLite BOOLEAN 기대값은 실제 INTEGER 저장으로 바로잡았고 완료 로그를 조기 성공으로 표시하지 않는다. 미지원 종류/비유한 사례/잘못된 decimal/인수 초과는 prepare/실행 전에 거부한다. 드라이버별 bind 모듈이 조회/실행을 공유하며 SQL 값 서식화는 없다. 테스트 소유 테이블/파일을 제거했으며 잠긴 낙관적 변경·4클라이언트 적합성은 미완료다.
  - [o] T7.17.1.13 소유 트랜잭션에서 호출자가 승인한 네이티브 Rust update/delete·명시적 키 삽입을 실행한다. 원인: 기준/bind만으로 현재 행을 잠그거나 비교하지 못했다. 근거: API/검증 누락 컴파일 Red와 실제 INTEGER 키/commit 거부 Red가 Green이며 macOS의 실제 세 DB를 포함한 소유 라이브러리/기준/페이지/bind/변경 테스트 18개가 통과했다. 원본 잠금·descriptor/값 충돌·인용 복합키·키 변경·생성/default/NULL·영향 행·FK/unique 보존·강제 변환 rollback·취소/중단 정리·대기 중단 후 commit 소유를 검증했다. PostgreSQL 제약 거부는 rollback 확인과 원래 오류를 보존하고 소유 연결 종료는 재시도 없는 Indeterminate로 구분한다. MySQL은 InnoDB·확인된 직접 트리거 가시성·트리거가 없고 partial revoke가 비활성화됐음을 요구한다. 테스트 소유 자원을 제거했다. 추가 수명주기/default/상한 사례는 Red가 아닌 회귀 검사다. 자동 식별자(T7.17.1.13.2)·영속 권한/복구·4클라이언트 적합성·다른 플랫폼은 미완료다.
    - [o] T7.17.1.13.1 PostgreSQL bind 준비와 commit 오류 분류를 수정했다. 실제 INTEGER 키 22P03 및 명시적 지연 제약 거부 Red가 Green이다. 그리드/조회 메타데이터를 선언 codec 타입으로 준비하고 원래 commit 오류를 보존하며 PostgreSQL 제약/트랜잭션 거부의 rollback을 확인하고 소유 연결 종료와 구분한다. 호출자의 대기 중단 후 commit도 관측된다. 소유 테스트 18개와 부모 작업 단위 커밋에 포함한다.
    - [~] T7.17.1.13.2 정확한 식별자로 자동/default 기본키 삽입을 지원한다. 자동/고정 기본값 키는 아래에서 검증했고 MySQL 표현식 기본값 식별자는 미해결이다. 전체 삽입과 영속 권한 요구를 유지한다.
      - [o] T7.17.1.13.2.1 생성 메타데이터와 제한된 서버 반환으로 자동/고정 기본값 키를 지원한다. 자동 키·MySQL 고정 기본값 Red가 Green이며 실제 세 DB 동시성·default-only·제약/강제 변환 거부·취소 rollback을 포함한 소유 테스트 21개가 통과했다. 소유 Clippy --no-deps가 통과했다. 테스트 자원을 제거했으며 다른 플랫폼/4클라이언트 완료는 주장하지 않는다.
      - [ ] T7.17.1.13.2.2 키 추정·재평가·사용자 스키마/트리거 변경 없이 생략한 MySQL 표현식 기본값 식별자를 반환한다. 원인: statement 응답은 AUTO_INCREMENT를 반환하고 DEFAULT(column)은 고정 기본값만 지원한다. UUID 기본값 삽입은 현재 쓰기 전에 거부한다. 기준: 정확한 경로나 물리적 제한을 입증하며 거부를 완료로 취급하지 않는다.

## 문서 작업

- [o] T7.D1 각 영어 페이지 옆에 한국어 `.ko.md` 페이지를 둔다.
- [o] T7.D2 짝 페이지의 제목, 코드 블록, 표, 링크 대상을 맞춘다.
- [o] T7.D3 두 경로에 언어 링크와 검색을 제공한다.
- [o] T7.D4 비격식, 비유, 의인화, 모호한 설명 문구를 제거한다.
- [o] T7.D7 CI에서 짝 문서 구조를 검사한다.
- [o] T7.D8 CI에서 설정된 작성 규칙을 검사한다.
  - [o] T7.D8.2 인터페이스 요건·성능 측정값·검사 기준을 바꾸지 않고 금지 표현을 제거했다. 근거: 수정 전 `npm run docs:rules-check`에서 파일/표현 실패 10개를 재현했고 수정 후 영한 21쌍이 통과했다. 새 `npm run docs:build` 뒤 `npm run docs:static-check`가 42페이지·내부 대상 437개·SVG 26개와 JavaScript 없는 읽기·검색·테마·모바일 탐색을 검증했다. `make checklist-check`가 통과했다.
- [o] T7.D8.1 상시 규칙은 `AGENTS.md`에, 작업 산출물은 이 체크리스트에 둔다. 번호 없는 절차·작업 레인·날짜 고정 상태 서술을 제거하고 체크리스트 검사기가 재도입을 거부하며 기존 항목 ID와 상태를 보존한다. 증거: 정리 전 검사 실패 사례, `make checklist-check`와 영한 문서 검사 통과, 두 언어 파일과 기록을 포함한 로컬 커밋.
- [o] T7.D11 갱신된 기능 manifest로 기능 페이지를 다시 생성한다. 근거: `make feature-docs`가 17개 기능 행을 모두 생성했고 영문·국문 기능 페이지가 최신 상태이며 문서 쌍과 정적 문서 검사가 통과했다.

## 검증

- [o] G0 프로세스 내 클라이언트의 오버헤드를 측정하고 `perf.md`에 기록한다. 근거: 2026-09-27 `make perf-check`가 CPU 부하가 있을 때와 없을 때 Go·PHP에서 통과했고 PK와 100행의 모든 비율이 기록된 한도 안에 있으며 영문·국문 성능 기록에 관찰값을 남겼다.
- [o] G1 현재 Go, PHP, Rust, TypeScript conformance 출력을 MySQL, PostgreSQL, SQLite의 기록된 벡터 25개 모두와 비교한다. 각 클라이언트의 실제 실행 두 번에서 결과가 같고 행과 카운터가 변하지 않아야 하며 누락·추가·불일치 벡터나 데이터베이스 상태 변경은 거부한다. 근거: 추적된 사례가 추가된 데이터베이스 기대값과 빈 벡터 집합을 잘못 수용하는 문제를 먼저 재현했고 정확한 벡터 집합 검증 후 통과했다. 격리된 `make conformance-check`가 클라이언트·데이터베이스 실제 사례 12개를 모두 통과하고 각 데이터베이스의 벡터 25개를 네 클라이언트와 비교했다. 별도 SQLite 실제 실행 두 번의 상태 digest도 같았다.
- [o] G1.1.2 모든 지원 client와 database의 현재 실행 coverage 보고서, 정확한 사례 ID, 결과와 상태가 같은 두 번의 실행을 요구한다. 변경 반례 테스트는 누락된 구현 선언, 언어 테스트, 데이터베이스 실행, 사례, 반복과 선언되지 않은 결과를 거부한다. 모든 기능이 실행 가능한 coverage 명령을 제공할 때까지 기능 검사는 실패 상태로 유지한다.
- [o] G1.1.2.1 `scripts/features/coverage.mjs`에서 AGENTS.md의 소유자·사용자 테스트 위치 규칙을 강제한다. 변경 반례 테스트는 누락된 소유자·사용자 증거와 중앙 또는 외부 테스트 경로를 RED로 재현하고 유효한 소유자·사용자 실행은 GREEN이어야 한다. `make feature-check`는 이 검사기에 의존하며 기능 정의에 현재 실행 증거가 없으면 RED 상태를 유지한다.
- [o] G1.1.2.2 공통 집계 숫자 사례 아홉 개를 `clients/typescript/tests` 아래의 TypeScript 소유자 테스트에서 실행한다. coverage 변경 반례는 중앙 테스트 경로를 거부하고, 소유자 사례를 두 번 실행했을 때 사례 ID와 결과가 같아야 하며, 이전 중앙 경로는 제거한다. 기능 테스트 목록 검사는 소유자 `.mjs` 파일을 찾아야 하며 `model_queries` 검증은 소유자 테스트를 실행해야 한다. 이 항목은 G1 소유자 coverage의 선행 작업이며 네 언어 데이터베이스 대조를 완료하지 않는다.
- [o] G1.1.2.3 남은 모든 TypeScript client 동작 테스트를 `clients/typescript/tests` 아래에 두고 이전 중앙 경로를 제거한다. 추적된 목록 테스트는 이동 전 실패하고 이동 후 통과해야 하며 모든 테스트의 명령, 기능 선언, 문서는 현재 소유 경로를 사용해야 한다. 소유자 단위 사례와 모델·스키마 도구·SQLite 사례를 필요한 데이터베이스에서 각각 제한 시간을 두고 실행한다. 중앙 conformance 대조는 `tests/conformance`에 유지한다.
- [o] G1.1.2.4 만들어 낸 JSON 성공 보고서를 출력하는 테스트 명령을 거부한다. 선언된 각 언어의 테스트 파일과 정확한 사례 필터를 실행하고 종료 상태와 관찰한 테스트 이벤트에서 현재 결과를 만들며 데이터베이스 실행 전후 상태를 검사기에서 직접 읽는다. 추적되는 가짜 보고 변경 사례가 수정 전에는 실패하고 수정 후에는 통과해야 한다. 소유자와 사용자의 테스트는 각자 부분에 둔다. 시간제한을 둔 검사기 테스트를 실행하고 남은 기능 coverage 결함을 기록한다.
- [o] G1.1.2.5 기능 coverage 명령에서 공통 사례 ID와 Go·Rust의 실제 테스트 심볼을 분리한다. 누락되거나 추가·중복되거나 존재하지 않는 심볼 연결을 거부하고 선언한 실제 테스트 통과 이벤트를 확인한 뒤 공통 ID를 기록한다. 선택한 데이터베이스와 DSN을 각 소유 테스트에 전달한다. 변경 반례의 RED와 실제 실행의 GREEN으로 기준을 검증하고 `dsn_connection`의 소유자 및 실제 사용 부분 사례만 MySQL, PostgreSQL, SQLite에서 같은 결과와 불변 상태로 두 번씩 등록한다. 관련 없는 기능 선언은 자체 증거가 생길 때까지 RED로 유지한다. 근거: 검사기 변경 전에 실제 심볼 사례가 실패했고 변경 후 검사기 테스트 10개가 모두 통과했다. 격리된 `dsn_connection` 검사에서 소유자 24회와 생성 모델 사용 부분 12회가 통과했고 각 데이터베이스에서 두 번의 결과와 상태가 동일했다. 전체 기능 검사는 선언되지 않은 coverage 종류 16개 때문에 계속 RED이며 기존 기능 목록 오류는 main에서도 재현된다.
- [o] G1.1.1 Rust 행 값 디코딩 테스트를 `model_queries`에 등록해 기능 검증에 포함한다. N5.1.2.2는 이 등록에 의존한다.
- [o] G4 생성 심볼, 스키마, CI 검사를 실행한다. Go, PHP, Rust, TypeScript의 각 공개 API에 `multi_statement`가 없고 호출 시 인터페이스 검사에 실패하는지 검증한다. 근거: `make interface-check`가 Go 2,827개, PHP 1,080개, Rust 2,054개, TypeScript 3,111개 실제 심볼을 검사하고 각 언어의 공개 선언 및 호출 변경 사례를 거부했다. `make schema-check`가 스키마 사례 159개와 현재 변경 계획을 검증했다. CI 명령 변경 테스트가 생성 모델, 인터페이스, 스키마 검사 각각의 제거를 거부했다. PHP 생성 모델은 연결 전 실제 `multi_statement(true)` 호출을 `CONFIG`로 거부했다. 표적 검사기, 생성기, 문서, 규칙 및 체크리스트 검사가 통과했다.
- [o] G4.1 네 클라이언트의 `getsCount`가 선택한 그룹 값과 검증한 `row_count`를 전용 그룹 결과로 반환하게 한다. 잘못된 개수를 거부하고 일부 필드만 채운 모델을 만들지 않는다. 근거: G4.1.1, G4.1.2, G4.1.4가 MySQL, PostgreSQL, SQLite의 소유 동작을 검증했고 공통 출력 및 네 공개 서명을 현재 심볼과 대조했으며 모델 컬렉션으로 되돌리는 변경은 논리 기준 테스트에서 실패했다. `make interface-check`가 Go 2,827개, PHP 1,080개, Rust 2,054개, TypeScript 3,111개 심볼을 검사하고 각 언어의 소스 변경 반례 일곱 개를 거부했다.
- [o] G4.1.1 Go 런타임과 생성 모델에서 전용 그룹 결과를 반환한다. 선택한 값의 타입, 잘못된 개수, 조회하지 않은 필드, MySQL, PostgreSQL, SQLite의 실제 결과를 검증한다. 근거: Go 그룹 결과 단위 사례가 누락·중복·잘못된 형식·불리언·음수 개수를 거부했고 생성 모델과 SQL 예약어 소유 사례가 MySQL, PostgreSQL, SQLite에서 선택 값과 개수를 검증하며 통과했다. Go runner 컴파일, 생성기 테스트, 체크리스트 및 문서 규칙 검사도 통과했다.
- [o] G4.1.2 PHP와 TypeScript의 `getsCount`에서 전용 `GroupRows`를 반환한다. 각 행에는 선택한 그룹 값과 검증한 음수가 아닌 `row_count`만 담고 개수가 누락·중복되거나 불리언·손실·잘못된 값이면 실패한다. 불리언과 SQL NULL을 포함한 선택 값의 선언된 타입을 보존하고 일부 필드만 채운 모델은 만들지 않는다. 생성 모델은 결과 타입을 노출한다. 근거: 소유 사례가 먼저 그룹 결과 타입 누락으로 실패한 뒤 PHP 단위 사례와 TypeScript 빌드·단위·타입 사례가 통과했다. `make group-rows-physical-check`의 PHP·TypeScript MySQL·PostgreSQL·SQLite 사례 12/12가 통과했고 각 사례 뒤 상태 해시가 동일했다. 문서·용어·체크리스트 검사도 통과했다.
- [o] G4.1.3 조회하지 않은 PHP 일반 컬럼을 읽을 때 `COLUMN_UNSELECTED`로 실패한다. 선택한 SQL NULL과 대입한 값은 유지한다. 원인: `readColumn`이 로드된 행에 없는 컬럼에 null, 0, false, 빈 문자열 또는 다른 타입 영값을 반환했다. 근거: 소유 RED 사례가 기본값 반환을 재현했고 수정 뒤 PHP 모델 10개 사례가 SQLite·MySQL·PostgreSQL에서 통과했으며 생성 모델 사례가 각 데이터베이스에서 두 번 실행되어 상태 해시가 유지됐다.
- [o] G4.1.4 Go 또는 Rust의 `GroupRow.Value`가 그룹 결과에 없는 이름을 요청하면 `COLUMN_UNSELECTED`를 반환한다. 선택된 SQL NULL은 존재하는 값으로 구분한다. 근거: G4.1.4.1과 G4.1.4.2가 각각 이전 반환형을 RED로 재현하고 소유 테스트를 통과했으며 MySQL, PostgreSQL, SQLite에서 생성 모델 경로를 검증했다.
- [o] G4.1.4.1 Go `GroupRow.Value`가 선택하지 않은 이름에 오류를 반환하고 선택된 SQL NULL을 구분한다. 근거: 소유 테스트가 반환형 변경 전 실패하고 변경 후 통과했으며 생성 모델과 SQL 예약어 소유 사례가 MySQL, PostgreSQL, SQLite에서 `COLUMN_UNSELECTED`를 확인하며 통과했다.
- [o] G4.1.4.2 Rust `GroupRow::value(name)`에 요청한 이름이 없으면 `COLUMN_UNSELECTED`를 반환한다. SQL NULL을 포함한 선택 값은 유지한다. 근거: 소유 테스트는 기존 `Option` API에서 컴파일 실패하고 `Result<&Val>` 변경 뒤 1/1 통과했으며 생성 모델 `columns_and_subqueries`가 SQLite·MySQL·PostgreSQL에서 각 두 번 통과했다. 라이브러리와 integration 표적 Clippy, Rust 서식, 영한 문서 규칙, 체크리스트 검사도 통과했다.
- [!] G5 GitHub Actions 빌드를 검증한다. 원인: 기록된 최신 `ci.yml` 실행이 필요한 replica와 PgBouncer DSN을 workflow가 제공하지 않아 feature·documentation·package 단계에서 실패했다. 현재 로컬 전용 checkout에서는 현재 커밋을 게시하거나 새 외부 서비스 endpoint를 만들 수 없다. 재시도: 현재 `main`을 대상으로 필요한 replica와 pooler 서비스를 제공하는 GitHub Actions 실행이 성공한 뒤 재개한다. 로컬 YAML 파싱은 통과했으며 완료가 아니다.
