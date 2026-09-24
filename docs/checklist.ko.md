# 프로젝트 체크리스트 (0.0.1 완료)

표기: `[ ]` 시작 전, `[~]` 진행 중, `[x]` 완료. 모든 항목에는 완료 조건이 있다.
규칙: 폴링·타이머 없음, 심볼릭 링크 없음, 실행 경로 하나, 다이어그램 원본은 Mermaid, 생성물은 별도 보관, 버전은 0.0.1 고정, 공개 클라이언트는 드라이버 인자 없이 DSN URI 하나를 받으며, ORM 도입에는 클라이언트 라이브러리만 필요하다.

## 현재 상태 (2026-09-17)

- [DSL](dsl.md)의 모델 문법이 Go, PHP, Rust, TypeScript에 구현되어 있다.
- 모든 클라이언트는 애플리케이션 프로세스 안에서 문장을 검증하고 계획하며, 자기 모델 생성기를 제공한다. 컴파일러 서비스, 데몬, WASM 모듈, 확장은 사용하지 않는다.
- 네 클라이언트는 **MySQL, PostgreSQL, SQLite에서 conformance 벡터 25개**에 대해 같은 문장, bind, 결과를 만든다. 코덱 검사는 네 클라이언트에서 벡터 80개다.
- 남은 작업: conformance 검사기와 기록된 벡터, 이전 컴파일러 서비스 소스 제거, contracts, 언어별 스키마 도구, 성능 재측정, 최종 CI와 Pages 실행.

## 공통 인터페이스 검증

- [x] I1 `interfaces.md`와 Mermaid 다이어그램에 공통 구조, 소유 규칙, 상태 전이를 정의한다.
- [ ] I2 모델 문법에 맞춰 `contracts/interfaces.json`, 생성 구성 요소 페이지, 심볼 검사를 다시 생성한다.
- [ ] I3 모델 문법과 프로세스 내 플래너에 맞춰 구현 대조표를 다시 작성한다.
- [x] I4 네 클라이언트에서 연결, 트랜잭션, 관계, 쓰기, 시간대를 물리 데이터베이스로 검증한다.

## 온라인 문서

- [x] D1 VitePress로 Markdown 페이지를 빌드하고 구현 상태와 로컬 검색을 제공한다.
- [x] D2 Mermaid 다이어그램을 SVG로 렌더링하고 JavaScript 없는 페이지 내용을 검증한다.
- [x] D3 `/orm/` 링크, 앵커, 직접 HTML 경로, 검색, 모바일 탐색, 반복 빌드를 검사한다.
- [ ] D4 현재 페이지를 https://polyspec.github.io/orm/ 에 배포하고 검증한다.

## 작업 레인

| 레인 | 범위 | 완료 조건 |
|---|---|---|
| **E Engine** | `engine/*`, `cmd/ormgen`, 프로토콜 문서 | Go 기준 플래너, 방언, 스키마 빌드, 오류 규칙을 클라이언트 작업 전에 정의한다. |
| **G Go** | `clients/go/*` | Go가 공통 스키마와 실행기 규칙을 사용한다. |
| **P PHP** | `clients/php/*` | PHP가 프로세스 안에서 계획하고 공통 실행기 규칙을 사용한다. |
| **R Rust** | `clients/rust/*` | Rust가 프로세스 안에서 계획하고 공통 실행기 규칙을 사용한다. |
| **T TypeScript** | `clients/typescript/*` | TypeScript가 프로세스 안에서 계획하고 같은 요청, 결과, 상태 규칙을 사용한다. |
| **V Verification** | `tests/*`, `schema/*`, `scripts/*` | 지원하는 모든 클라이언트가 검사된 같은 결과를 만든다. |

레인 순서는 E → G/P/R/T → V다. 클라이언트 전용 기능은 같은 논리 기능이 지원하는 모든 클라이언트에 있기 전까지 미완료다.

## 1단계 — 모델 문법 [완료]

- [x] M1 네 클라이언트에 모델 생성과 `connect`, 체인, 연결자, 그룹, 연산자, 값 형태, 컬럼 비교, 튜플, 서브쿼리를 구현한다.
- [x] M2 관계, 조인, 컬럼 선택, 정렬, 그룹, limit, finder, 집계, 페이지를 구현한다.
- [x] M3 쓰기를 구현한다: `set`, `setRaw`, `new<Name>`, `plus`, `minus`, `create`, `creates`, `duplication`, `update`, `update(true)`, `save`, `delete`.
- [x] M4 실행 흐름 단위 트랜잭션, savepoint, 재시도, 옵션, 행 잠금, `connection.utils()`를 구현한다.
- [x] M5 예약 컬럼 이름과 생성 메서드와 충돌하는 이름을 거부한다.

## 2단계 — 프로세스 내 계획과 생성기 [진행 중]

- [x] N1 검증, 계획, 방언, DDL을 PHP, Rust, TypeScript로 이식하고, Go 클라이언트는 엔진 패키지를 직접 호출한다.
- [x] N2 언어마다 생성기 하나를 제공한다: `ormgen gen --lang go`, `vendor/bin/orm-gen`, `orm-gen` npm bin, `orm-build` crate.
- [x] N3 네 클라이언트에서 MySQL, PostgreSQL, SQLite의 `utils().schema().install()`을 구현한다.
- [x] N4 세 데이터베이스에 연결 시간대를 적용한다: PostgreSQL 오프셋 시간대, 시각 읽기, SQLite 시계 기본값, MySQL 명칭 시간대 오류.
- [ ] N5 프로세스 내 러너로 conformance 검사기를 실행하고 벡터를 다시 기록한다.
- [ ] N6 컴파일러 서비스, 메시지 정의, WASM·FFI 진입점, 배포 유닛을 제거하고 Makefile과 CI를 갱신한다.
- [ ] N7 문자열로 받은 SQLite datetime 텍스트를 저장 형식인 소수 여섯 자리 형태로 비교한다.
- [ ] N8 `orm-build`로 150개 테이블 Rust 컴파일 검사를 실행한다.

## 3단계 — 언어별 스키마 도구 [시작 전]

- [ ] L1 모든 언어에서 `.mmd` 파일로 `schema.json`을 빌드한다.
- [ ] L2 모든 언어에서 마이그레이션과 import 도구를 제공한다.

## 스키마와 마이그레이션 도구 (Go) [완료]

- [x] T7.3 결정적인 `ormgen diff`와 파괴적 변경 검사를 구현한다.
- [x] T7.5 Go, PHP, Rust, TypeScript에 YAML 1.2와 `point` 변환을 구현한다. MySQL, PostgreSQL, SQLite에서 `point` DDL과 SQL을 검증한다.
- [x] T7.9 같은 SQL, bind, 타입 결과, 연결 수, 픽스처로 Rust `mysql_async` 0.37.1과 sqlx 0.9를 비교한다. 두 측정 작업 모두 필요한 2배 개선이 없으므로 sqlx를 유지한다.
- [x] T7.10 지원 데이터베이스가 같은 안전한 매개변수 실행 구조를 제공할 수 없으므로 모든 공개 API에서 `multi_statement`를 제외한다.
- [x] T7.13 AES 버전 컬럼을 검증하고, 쓰기 시 현재 버전을 저장하고, Go, PHP, Rust, TypeScript에 상태 조회와 트랜잭션 회전 API를 제공한다.
- [x] T7.14 테이블·컬럼 주석을 manifest, 스키마 해시, import, DDL, diff, SQLite 메타데이터에 포함한다.
- [x] T7.15 MySQL, PostgreSQL, SQLite에 마이그레이션 실행 잠금, 트랜잭션 범위, 상세 복구 상태를 추가한다.
- [x] T7.16 세미콜론 분리를 방언을 아는 SQL 문장 파서로 바꾸고 문장 단위 실패 위치를 유지한다.
- [x] T7.17 DDL, diff, 구조화된 계획, 검증, 복구, 멱등 마이그레이션, 검증된 롤백에 MMD, manifest JSON, 메타데이터가 있는 ORM SQL, 라이브 DB 스키마 원본을 받는다.
- [x] T7.19 AES blind-index 스키마 선언, 키 기반 동등 조건, 쓰기 동기화를 추가한다.
- [x] T7.20 큰 루트 `IN` 조건을 나누고, `IN`이 아닌 매개변수를 유지하고, 행을 합치고, 개수 결과를 더하고, 안전하지 않은 query 형태를 거부한다.
- [x] T7.21 `soft_delete` 스키마 지시어를 추가하고, 읽기와 갱신에 활성 행 조건을 적용하고, 삭제를 시각 갱신으로 바꾼다.

## 문서 작업

- [x] T7.D1 각 영어 페이지 옆에 한국어 `.ko.md` 페이지를 둔다.
- [x] T7.D2 짝 페이지의 제목, 코드 블록, 표, 링크 대상을 맞춘다.
- [x] T7.D3 두 경로에 언어 링크와 검색을 제공한다.
- [x] T7.D4 비격식, 비유, 의인화, 모호한 설명 문구를 제거한다.
- [x] T7.D7 CI에서 짝 문서 구조를 검사한다.
- [x] T7.D8 CI에서 설정된 작성 규칙을 검사한다.
- [ ] T7.D11 갱신된 기능 manifest로 기능 페이지를 다시 생성한다.

## 검증

- [ ] G0 프로세스 내 클라이언트의 오버헤드를 측정하고 `perf.md`에 기록한다.
- [ ] G1 세 데이터베이스에서 네 클라이언트의 conformance 출력을 기록된 벡터와 비교한다.
- [ ] G4 생성 심볼, 스키마, CI 검사를 실행한다.
- [ ] G5 GitHub Actions 빌드를 검증한다.
