# 전체 작업 체크리스트 (0.0.1 완료까지)

범례: `[ ]` 미착수, `[~]` 진행 중, `[x]` 완료. **P**는 병렬 작업이다. **→ T#**는 선행 작업이다. 모든 항목은 완료 조건을 가진다.
원칙: 폴링·타이머·symlink를 사용하지 않는다. 실행 경로는 하나로 유지한다. 도표 원본은 Mermaid로 관리한다. 생성물은 별도 경로에 저장한다. 버전은 0.0.1로 고정한다.

## 현재 상태 (2026-09-12)

- **S0 완료:** `docs/perf.md`에 측정과 R1~R3, F1~F3 결정을 기록했다.
- **S1 완료:** 엔진, 생성기, 3개 클라이언트, 적합성 하네스, `ormgen tokens`, 데모를 구현했다.
- **S2는 T2.15를 제외하고 완료:** 관계·코덱·타입·58개 벡터 검사를 통과했다. 150테이블 Rust fixture가 남아 있다.
- **S3~S6 완료:** 쓰기, 조인, PHP 호환층, 배포, PostgreSQL, SQLite를 구현했다. TypeScript 실행과 고정 비용 최적화는 미완료다.
- 현재 적합성 범위는 **58개 벡터 × 3개 클라이언트 × 3개 데이터베이스**다. 코덱 범위는 Go·PHP·Rust·TypeScript의 96개 벡터다. TypeScript 데이터베이스 실행은 미완료다.

## 공통 인터페이스 검사

- [x] I1 `interfaces.md`, `contracts/interfaces.json`, Mermaid 도표에 공통 구조·소유권·상태 전이를 정의한다.
- [x] I2 Go·PHP·Rust Query와 Row 인터페이스를 생성·대조하고 TypeScript 구조 초안을 검사한다.
- [x] I3 Request와 Plan 25개 레코드를 대조하고 AST·Reflection·소스 변경 반례를 검사한다.
- [~] I4 바인딩, 쿼리 재사용, 자식 복사, 오류 보존, dirty 상태, 원본 버전, typed key, 페이지를 검사한다. TypeScript 실행 벡터가 남아 있다.
- [x] I5 생성물·구조·상태·문서·예제 검사를 CI에서 실행한다.
- [x] I6 native PK 직접 변경 후 identity 보존과 중첩 컬렉션 키 충돌을 검사한다.

## 온라인 문서

- [x] D1 VitePress로 Markdown 페이지를 빌드하고 구현 상태와 로컬 검색을 제공한다.
- [x] D2 Mermaid를 SVG로 생성하고 JavaScript 없는 본문을 검사한다.
- [x] D3 `/orm/` 링크·앵커·직접 HTML 경로·검색·모바일 탐색·반복 빌드를 검사한다.
- [x] D4 https://polyspec.github.io/orm/ GitHub Pages 배포를 확인한다.

## 작업 레인

| 레인 | 범위 | 완료 조건 |
|---|---|---|
| **E Engine** | `engine/*`, `cmd/ormgen`, protocol 문서 | 공통 IR·Plan·토큰·오류 규칙을 클라이언트 작업 전에 정의한다. |
| **G Go** | `clients/go/*` | Go가 공통 스키마와 실행기 규칙을 사용한다. |
| **P PHP** | `clients/php/*` | PHP가 공통 스키마와 실행기 규칙을 사용한다. |
| **R Rust** | `clients/rust/*` | Rust가 공통 스키마와 실행기 규칙을 사용한다. |
| **T TypeScript** | `clients/typescript/*` | TypeScript가 같은 request·result·상태 규칙을 사용한다. |
| **V 검사** | `tests/*`, `schema/*`, `scripts/*` | 지원 클라이언트의 결과가 같은 검사 결과를 만든다. |

레인 순서는 E → G/P/R/T → V다. 클라이언트 전용 기능은 모든 지원 클라이언트에 같은 논리 구조가 구현될 때까지 미완료로 둔다.

## 단계 0 — S0 기준선 [완료]

- [x] 도구체인, 전송 방식, 데이터베이스, PHP 런타임, 기준선 측정을 기록한다.
- [x] Rust 실행 방식, PHP wire 형식, PDO 정책, prepared statement, 성능 기준을 결정한다.

## 단계 1 — S1 thin slice [완료]

- [x] Mermaid 파싱, schema build, IR v1, planner v1, MySQL dialect, FFI/WASM 진입점, 3개 클라이언트를 구현한다.
- [x] 적합성 실행기, 토큰 대조, 생성 오류 코드, thin-slice 예제를 추가한다.

## 단계 2 — S2 관계와 코덱 [T2.15 잔여]

- [x] 관계 계획, 관계 페이지, keying, flattening, 타입 값, 컬럼 참조, 코덱, 연산자 검사를 구현한다.
- [x] T2.15 `make rust-150-check`로 결정적인 150테이블 Rust fixture를 생성하고 컴파일했습니다.
- [x] 현재 관계·코덱·타입·데이터베이스 벡터를 실행한다.

## 단계 3 — S3 쓰기 [완료]

- [x] upsert, 중복 갱신, save, update, delete, cascade delete, optimistic locking, SQL hook을 구현한다.
- [x] Go·PHP·Rust 쓰기·cascade 적합성 벡터를 실행한다.

## 단계 4 — S4 조인과 호환층 [완료]

- [x] 조인, alias, aggregate, raw statement, named predicate, 관계 결과 namespace를 구현한다.
- [x] PHP 호환 파서와 모델 범위를 넘는 괄호 거부를 구현한다.
- [x] `getBy`, `getsBy`, `getCountBy` finder를 값만 받는 terminal로 생성한다.

## 단계 5 — S5 강화와 배포 [완료]

- [x] schema import·validation, schema-hash 검사, 오류 코드, query hook, 패키지, 배포 unit, CI를 구현한다.
- [~] T5.3b 고정 비용 최적화: Go·PHP가 문서 기준을 초과하므로 typed 직접 스캔 작업이 필요하다.

## 단계 6 — S6 PostgreSQL과 SQLite [완료]

- [x] 두 dialect의 placeholder, quoting, returning, full-text 규칙, AES·HEX·IP 처리, 데이터베이스 설정을 구현한다.
- [x] 필요한 데이터베이스가 제공되는 환경에서 3개 클라이언트 벡터를 실행한다.

## 단계 7 — S7 추가 기능 [진행 중]

S7 항목은 구현·테스트·문서·정적 페이지 배포를 모두 완료해야 닫는다. Go·PHP·Rust·TypeScript에서 같은 논리 구조를 제공할 수 없으면 미완료로 유지한다.

- [ ] T7.1 4개 클라이언트의 typed protobuf/Connect 경로와 공통 벡터를 구현한다.
- [x] T7.3 결정적인 `ormgen diff`와 destructive change 검사를 구현한다.
- [~] T7.4 query 수준 `scope_p`, planner 강제 적용, 생성 메서드, MySQL·PostgreSQL·SQLite tenant isolation 검사를 구현했다. TypeScript database runner가 남아 있다.
- [x] T7.5 Go·PHP·Rust·TypeScript에 `curlfile`, YAML 1.2, `point` 변환을 구현한다. MySQL·PostgreSQL·SQLite에서 `point` DDL과 SQL을 검사한다.
- [ ] T7.6 서버 streaming, 취소, 오류, 행 소유권 검사를 구현한다.
- [x] T7.7 결정적인 정적 query precompile과 schema-hash 검사를 구현한다.
- [~] T7.8 TypeScript 구조·AST 검사를 구현했다. 타입 검사, 패키지 빌드, AST 검사, `interface_attach`, 공통 codec 벡터 96개가 통과하며 전체 TypeScript 실행기와 데이터베이스 벡터 실행이 남아 있다.
- [ ] T7.9 Rust `mysql_async`와 현행 driver 결과를 비교하고 기록한다.
- [ ] T7.10 `multi_statement` 관계 계획과 결과를 구현·검사한다.
- [ ] T7.11 Go·PHP typed 직접 스캔과 성능 기준 재측정을 구현한다.
- [x] T7.12 고정된 Rust 의존성으로 결정적인 150테이블 Rust fixture를 생성하고 컴파일했습니다.
- [~] T7.13 AES version column 검사와 행 재암호화 도우미를 구현했다. 데이터베이스 저장, 상태 조회, 4개 클라이언트의 동등한 DB API가 남아 있다.
- [x] T7.14 매니페스트, 스키마 해시, import, DDL, diff, SQLite 메타데이터에 테이블·컬럼 주석을 포함했습니다. 단위 테스트와 containerctl MySQL·PostgreSQL 테스트가 통과했습니다.
- [x] T7.15 MySQL·PostgreSQL·SQLite의 마이그레이션 실행 잠금, 트랜잭션 처리 범위, 상세 복구 상태를 추가했습니다. 마이그레이션 잠금 안에서 도착·출발·unsafe 실제 상태를 판정합니다.
- [x] T7.16 세미콜론 분할을 방언별 SQL 문장 분석기로 교체하고 문장별 실패 위치를 보존했습니다.
- [~] T7.17 MMD, manifest JSON, metadata가 있는 ORM SQL, 실제 DB schema를 DDL·diff·구조화 plan·검증·복구·멱등 DB migration 입력으로 지원한다. SQL loss 검사는 통과하며 rollback plan 생성과 실행이 남아 있다.
- [x] T7.18 containerctl로 MySQL·PostgreSQL의 주석, 계획 적용, 반복 실행, drift, 실패, 잠금 충돌, 복구를 실제 DB에서 검증했습니다.

## 문서 작업

- [x] T7.D1 각 영문 페이지 옆에 `.ko.md` 페이지를 둔다.
- [x] T7.D2 쌍 문서의 제목, 코드 fence, 표, 링크 대상을 일치시킨다.
- [x] T7.D3 두 경로에 언어 링크와 검색을 제공한다.
- [x] T7.D4 설명서에서 비격식·비유·의인화·모호한 표현을 제거한다.
- [x] T7.D5 기능별 입력·출력·오류·상태 변경·지원 클라이언트를 기록한다.
- [x] T7.D6 미구현 기능을 미착수 또는 진행으로 표시한다.
- [x] T7.D7 쌍 문서 구조를 CI에서 검사한다.
- [x] T7.D8 문체 규칙을 CI에서 검사한다.
- [x] T7.D9 완료된 S7 기능의 예제와 재현 명령을 추가한다.
- [x] T7.D10 두 언어 경로를 GitHub Pages에 게시하고 정적 검사를 실행한다.

## 검사 기준

- [x] G0 문서화한 기준으로 클라이언트 오버헤드를 측정한다.
- [x] G1 공통 JSON과 토큰 스트림을 비교한다.
- [x] G2 150테이블 Rust compile 검사를 완료하고 CI에 포함했습니다.
- [x] G3 구현된 클라이언트의 쓰기·관계 벡터를 검사한다.
- [x] G4 생성 심볼·스키마·CI 검사를 실행한다.
- [x] G5 GitHub Actions 빌드를 확인한다.
- [ ] G7 T7.1~T7.18과 T7.D1~T7.D10의 완료 조건을 모두 충족한 뒤 닫는다.
