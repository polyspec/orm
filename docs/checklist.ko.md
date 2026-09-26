# 프로젝트 체크리스트 (0.0.1 완료)

표기: `[ ]` 대기, `[~]` 진행 중, `[o]` 완료, `[!]` 일시 우회.

## 공통 인터페이스 검증

- [o] I1 `interfaces.md`와 Mermaid 다이어그램에 공통 구조, 소유 규칙, 상태 전이를 정의한다.
- [ ] I2 모델 문법에 맞춰 `contracts/interfaces.json`, 생성 구성 요소 페이지, 심볼 검사를 다시 생성한다.
- [ ] I3 모델 문법과 프로세스 내 플래너에 맞춰 구현 대조표를 다시 작성한다.
- [o] I4 네 클라이언트에서 연결, 트랜잭션, 관계, 쓰기, 시간대를 물리 데이터베이스로 검증한다.
- [o] I4.1 PHP request 레코드 선언 20개를 공통 필드·중첩 타입 정의와 대조한다. 소스 변경 반례는 검사에 실패하고 PHP 단독 선언 검사는 통과해야 한다.
- [o] I4.2 모든 인터페이스 오류 표기와 기록된 오류 결과를 `docs/errors.yaml`과 대조한다. 알 수 없거나 중복된 표기와 잘못된 오류 결과는 실패해야 한다.

## 온라인 문서

- [o] D1 VitePress로 Markdown 페이지를 빌드하고 구현 상태와 로컬 검색을 제공한다.
- [o] D2 Mermaid 다이어그램을 SVG로 렌더링하고 JavaScript 없는 페이지 내용을 검증한다.
- [o] D3 `/orm/` 링크, 앵커, 직접 HTML 경로, 검색, 모바일 탐색, 반복 빌드를 검사한다.
- [ ] D4 현재 페이지를 https://polyspec.github.io/orm/ 에 배포하고 검증한다.

## 1단계 — 모델 문법

- [o] M1 네 클라이언트에 모델 생성과 `connect`, 체인, 연결자, 그룹, 연산자, 값 형태, 컬럼 비교, 튜플, 서브쿼리를 구현한다.
- [o] M2 관계, 조인, 컬럼 선택, 정렬, 그룹, limit, finder, 집계, 페이지를 구현한다.
- [o] M3 쓰기를 구현한다: `set`, `setRaw`, `new<Name>`, `plus`, `minus`, `create`, `creates`, `duplication`, `update`, `update(true)`, `save`, `delete`.
- [o] M4 실행 흐름 단위 트랜잭션, savepoint, 재시도, 옵션, 행 잠금, `connection.utils()`를 구현한다.
- [o] M5 예약 컬럼 이름과 생성 메서드와 충돌하는 이름을 거부한다.

## 2단계 — 프로세스 내 계획과 생성기

- [o] N1 검증, 계획, 방언, DDL을 PHP, Rust, TypeScript로 이식하고, Go 클라이언트는 엔진 패키지를 직접 호출한다.
- [o] N2 언어마다 생성기 하나를 제공한다: `ormgen gen --lang go`, `vendor/bin/orm-gen`, `orm-gen` npm bin, `orm-build` crate.
- [o] N3 네 클라이언트에서 MySQL, PostgreSQL, SQLite의 `utils().schema().install()`을 구현한다.
- [o] N4 세 데이터베이스에 연결 시간대를 적용한다: PostgreSQL 오프셋 시간대, 시각 읽기, SQLite 시계 기본값, MySQL 명칭 시간대 오류.
- [ ] N5 프로세스 내 러너로 conformance 검사기를 실행하고 벡터를 다시 기록한다.
- [~] N5.1 MySQL, PostgreSQL, SQLite에서 네 클라이언트를 모두 실행하고 모든 벡터를 기록된 기대값과 비교하며, 반복 실행이 관찰 대상 데이터베이스 상태를 바꾸지 않는지 확인한다.
- [o] N5.1.1 네 출력을 모두 요구하고 오래된 출력과 달라진 반복 결과를 거부하며 실행 시간을 제한한다. 모든 테이블 행과 선언된 counter를 검사하고 선언된 테스트 counter만 복원하며 MySQL, PostgreSQL, SQLite에서 counter 관찰과 정리를 테스트한다.
- [o] N5.1.1.1 JSON 숫자를 float64 반올림 없이 비교하고 기록한다. 2^53을 넘는 서로 다른 정수를 구분하고 동등한 십진 표현은 같은 값으로 처리한다.
- [o] N5.1.1.2 중첩 JSON 실행 증거와 기대값의 중복 키를 거부하고 데이터베이스 기대값 파일이 없으면 실패한다.
- [o] N5.1.1.3 실행기 명령 로그에서 `-dsn`과 `--dsn` 양쪽 표기의 데이터베이스 연결 문자열을 가린다.
- [~] N5.1.2 네 conformance 실행기 모두 예상 밖 오류를 전파하고 쓰기 실패 시 상태를 정리하며 세 데이터베이스에서 공통 집계 스칼라 기준을 강제한다.
- [o] N5.1.2.1 Go 값 변환, host 인코딩, 생성 모델 대입이 잘못된 형식, null, 범위 초과, 지원하지 않는 값을 오류로 보고한다. 유효한 값을 실행 테스트로 검증하고 행 조립의 대입 오류를 전파하며 insert 필드를 쓰기 전에 검증한다.
- [o] N5.1.2.2 PHP와 TypeScript의 잘못되거나 유한하지 않은 집계 스칼라를 거부하고 공통 9개 사례로 가장 가까운 binary64 변환을 검증한다.
- [ ] N5.1.2.3 네 클라이언트의 생성 모델에서 decimal 컬럼 값을 정확히 보존한다. 생성된 decimal 필드는 `48.0450`을 근사 binary64 값으로 받아들이면 안 된다. MySQL, PostgreSQL, SQLite에서 동등한 RED 사례와 GREEN 실행 증거를 추가한다. scalar 집계 결과에는 별도의 유한 binary64 변환 기준을 적용한다.
- [o] N5.1.2.4 Go, PHP, Rust, TypeScript 스키마 빌더의 `auto` 컬럼이 NULL을 허용하지 않는 부호 있는 `i64` 기본 키이도록 강제한다. 각 언어는 동일한 허용·거부 Mermaid 사례를 실행하고 거부된 선언의 원천 행을 보고한다.
- [o] N5.1.2.4.1 실제 SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` 컬럼을 각 스키마 도구에서 부호 있는 `i64` 자동 키로 읽고, 자동 키가 아닌 `INTEGER` 컬럼은 `i32`로 유지한다. 클라이언트에서 실제 SQLite 가져오기와 스키마 빌드를 검증한다.
- [ ] N5.1.2.5 Go scalar·collection 키의 문자열 대체 경로를 정확한 타입별 키 표현으로 바꾼다. 지원하지 않는 값은 오류를 반환하고 서로 다른 값은 충돌하지 않으며 relation, 분할 질의, collection 호출자가 오류를 전파하는지 검증한다.
- [~] N5.1.2.6 네 클라이언트와 세 데이터베이스에서 SQL NULL, 인코딩된 null 값, 조회하지 않은 값 스타일 컬럼을 구분한다. 공통 사례로 저장 텍스트, getter, 행 배열, 모델 JSON 출력, 오류를 검증한다.
- [o] N5.1.2.6.1 Go codec과 생성 모델 setter·getter에서 값 스타일 상태를 명시적으로 구분한다. MySQL, PostgreSQL, SQLite에서 공통 상태, 행 배열, 모델 JSON, 오류를 검증한다.
- [o] N5.1.2.6.2 PHP 값 스타일 컬럼의 setter, getter, codec, 모델 출력에 `StyledValue`를 사용한다. MySQL, PostgreSQL, SQLite에서 공통 상태 사례와 실제 모델 동작을 검증한다.
- [o] N5.1.2.6.3 TypeScript 값 스타일 컬럼의 setter, getter, codec, 모델 출력에 `StyledValue`를 사용한다. MySQL, PostgreSQL, SQLite에서 공통 상태·codec 사례와 실제 모델 동작을 검증한다.
- [ ] N6 컴파일러 서비스, 메시지 정의, WASM·FFI 진입점, 배포 유닛을 제거하고 Makefile과 CI를 갱신한다.
- [ ] N7 문자열로 받은 SQLite datetime 텍스트를 저장 형식인 소수 여섯 자리 형태로 비교한다.
- [ ] N8 `orm-build`로 150개 테이블 Rust 컴파일 검사를 실행한다.

## 3단계 — 언어별 스키마 도구

- [ ] L1 모든 언어에서 `.mmd` 파일로 `schema.json`을 빌드한다.
- [ ] L2 모든 언어에서 마이그레이션과 import 도구를 제공한다.

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
- [o] T7.19 AES blind-index 스키마 선언, 키 기반 동등 조건, 쓰기 동기화를 추가한다.
- [o] T7.20 큰 루트 `IN` 조건을 나누고, `IN`이 아닌 매개변수를 유지하고, 행을 합치고, 개수 결과를 더하고, 안전하지 않은 query 형태를 거부한다.
- [o] T7.21 `soft_delete` 스키마 지시어를 추가하고, 읽기와 갱신에 활성 행 조건을 적용하고, 삭제를 시각 갱신으로 바꾼다.

## 문서 작업

- [o] T7.D1 각 영어 페이지 옆에 한국어 `.ko.md` 페이지를 둔다.
- [o] T7.D2 짝 페이지의 제목, 코드 블록, 표, 링크 대상을 맞춘다.
- [o] T7.D3 두 경로에 언어 링크와 검색을 제공한다.
- [o] T7.D4 비격식, 비유, 의인화, 모호한 설명 문구를 제거한다.
- [o] T7.D7 CI에서 짝 문서 구조를 검사한다.
- [o] T7.D8 CI에서 설정된 작성 규칙을 검사한다.
- [o] T7.D8.1 상시 규칙은 `AGENTS.md`에, 작업 산출물은 이 체크리스트에 둔다. 번호 없는 절차·작업 레인·날짜 고정 상태 서술을 제거하고 체크리스트 검사기가 재도입을 거부하며 기존 항목 ID와 상태를 보존한다. 증거: 정리 전 검사 실패 사례, `make checklist-check`와 영한 문서 검사 통과, 두 언어 파일과 기록을 포함한 로컬 커밋.
- [ ] T7.D11 갱신된 기능 manifest로 기능 페이지를 다시 생성한다.

## 검증

- [ ] G0 프로세스 내 클라이언트의 오버헤드를 측정하고 `perf.md`에 기록한다.
- [ ] G1 세 데이터베이스에서 네 클라이언트의 conformance 출력을 기록된 벡터와 비교한다.
- [o] G1.1.2 모든 지원 client와 database의 현재 실행 coverage 보고서, 정확한 사례 ID, 결과와 상태가 같은 두 번의 실행을 요구한다. 변경 반례 테스트는 누락된 구현 선언, 언어 테스트, 데이터베이스 실행, 사례, 반복과 선언되지 않은 결과를 거부한다. 모든 기능이 실행 가능한 coverage 명령을 제공할 때까지 기능 검사는 실패 상태로 유지한다.
- [o] G1.1.2.1 `scripts/features/coverage.mjs`에서 AGENTS.md의 소유자·사용자 테스트 위치 규칙을 강제한다. 변경 반례 테스트는 누락된 소유자·사용자 증거와 중앙 또는 외부 테스트 경로를 RED로 재현하고 유효한 소유자·사용자 실행은 GREEN이어야 한다. `make feature-check`는 이 검사기에 의존하며 기능 정의에 현재 실행 증거가 없으면 RED 상태를 유지한다.
- [o] G1.1.1 Rust 행 값 디코딩 테스트를 `model_queries`에 등록해 기능 검증에 포함한다. N5.1.2.2는 이 등록에 의존한다.
- [ ] G4 생성 심볼, 스키마, CI 검사를 실행한다. Go, PHP, Rust, TypeScript의 각 공개 API에 `multi_statement`가 없고 호출 시 컴파일 또는 인터페이스 검사에 실패하는지 검증한다.
- [ ] G5 GitHub Actions 빌드를 검증한다.
