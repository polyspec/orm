# 성능

모든 클라이언트는 애플리케이션 프로세스 안에서 문장을 계획하고 네이티브 드라이버로 실행한다. 이전 실행 경로의 클라이언트 측정값은 더 이상 적용되지 않아 삭제했다. 현재 클라이언트의 오버헤드는 수치를 기록하기 전에 `make perf-check`와 아래 벤치마크 프로그램으로 다시 측정해야 한다.

드라이버 결과의 측정 환경: Apple M3 Pro, macOS, MySQL 8.4.11 로컬 유닉스 소켓(`/tmp/mysql.sock`), `orm_bench.battle` 10만 행, 단일 연결, p50. 원자료: `docs/perf-raw-go-native.txt`, `docs/perf-raw-rust-native.txt`, `docs/perf-raw-rust-native-2.txt`.

## 1. 네이티브 드라이버 기준값

하나의 연결에서 prepared statement를 재사용한다. 이 값은 ORM 없이 드라이버만 측정한 결과다.

| 작업 | Go database/sql | Rust sqlx | PHP PDO |
|---|---:|---:|---:|
| PK 단일 행 (25컬럼, AES 2) | 38.0µs | 81.4µs | 30.5µs |
| 100행 목록 | 448µs | 472µs | 446µs |
| INSERT | 175µs | 191µs | 181µs |
| 4단 관계 (부모 20 + 자식 IN 쿼리 3개, ≤200행 + 조립) | 6.43ms | 6.68ms | 7.45ms |

## 2. 실행기 규칙

**F1 — 모든 실행기는 prepared statement를 캐시한다.** Go에서 prepared statement 없는 `QueryContext(args)`(prepare, 실행, close의 세 번 왕복)는 PK 행에 100µs, 캐시한 statement로는 38µs가 걸린다.

**F2 — sqlx PK 지연은 드라이버 자체 비용이다.** sqlx는 풀 크기 1과 전용 연결에서도 PK 행을 약 80µs에 읽으며, 이는 Go와 PDO의 두 배다. 차이는 tokio 작업 전환과 프로토콜 파싱에서 생긴다.

**F3 — 실행기는 실패한 sqlx `try_get`을 흐름 제어에 사용하지 않는다.** 실패한 `try_get`은 셀마다 오류 문자열을 만든다. 정수 컬럼을 `i64`로 읽고 unsigned 컬럼을 `u64`로 다시 읽는 방식은 100행 읽기를 p50 378µs에서 615µs, p90 1.6ms로 늘렸다. 실행기는 컬럼 타입 명칭에 따라 분기해 signed와 unsigned 값을 한 번에 읽는다.

**F4 — PHP는 `PDO::ATTR_EMULATE_PREPARES = true`로 고정한다.** 웹 요청은 보통 문장 형태를 한 번 실행하므로 cold path가 기준이다. cold path p50(off → on): PK 72→48µs, IN(8) 107→75µs, 100행 460→382µs. warm path p50: PK 33→49µs, 100행 435→400µs. 타입(IP 문자열, JSON, 실수, 불리언)과 conformance 출력은 두 모드에서 같다.

**F5 — PHP는 `PDO::FETCH_NUM` 배열을 행 저장소로 유지한다.** 행을 하나씩 가져오는 방식은 100행에 약 511µs, `fetchAll`은 약 425µs가 걸렸다.

## 3. 회귀 검사 (`make perf-check`)

검사는 한 프로세스에서 생성 클라이언트와 같은 결과의 네이티브 코드를 p50 표본 300개로 측정한다. 양쪽은 같은 non-lazy 컬럼을 선택하며, PHP 기준 코드도 같은 생성 행 결과를 디코딩하고 만든다. 중앙값 비율이 한도를 넘으면 CI가 실패한다.

| 클라이언트 | PK 한도 | 100행 한도 | 검사 |
|---|---:|---:|---|
| Go | 1.35 | 1.25 | `ORM_RUN_PERF_GATE=1`인 `bench/go` `TestHotPathGate` |
| PHP | 1.35 | 1.50 | `clients/php/tests/perf_gate.php <schema.json>` |

비율은 하드웨어에 따라 달라지고 왕복 시간이 길수록 1에 가까워진다. 한도를 바꾸려면 측정 결과와 이 문서의 갱신이 필요하다.

## 4. Rust MySQL 드라이버 비교

하나의 release 프로세스에서 sqlx 0.9와 `mysql_async` 0.37.1을 비교했다. 풀마다 연결 하나, 같은 prepared SQL과 bind, 같은 4필드 타입 결과, 준비 작업 200회, 측정 작업 1,000회를 사용했다. 모든 쌍의 결과가 같았다. 환경: Apple M3 Pro, MySQL 8.4 로컬 유닉스 소켓, 2026-09-12.

| 작업 | sqlx 평균 | `mysql_async` 평균 | 비율 (`mysql_async/sqlx`) |
|---|---:|---:|---:|
| PK 행 | 58.840µs | 61.825µs | 1.051 |
| 100행 목록 | 1.180ms | 1.113ms | 0.943 |

`bench/rust`에서 `cargo run --release --locked --bin driver_compare -- 1000`을 실행한다. 드라이버 교체에는 측정된 2배 개선이 필요하다. 두 작업 모두 조건을 충족하지 않으므로 Rust 클라이언트는 sqlx를 유지한다. `make rust-driver-check`는 프로그램을 컴파일하며, 지연 시간은 CI 통과 조건이 아니다.

## 5. 결정 요약

| ID | 결정 | 근거 |
|---|---|---|
| F1 | 모든 실행기의 prepared statement 캐시 | §2 |
| F2 | sqlx PK 지연은 드라이버 고유 비용 | §1, §2 |
| F3 | 실패한 sqlx `try_get`을 흐름 제어에 사용하지 않음 | §2 |
| F4 | PHP `ATTR_EMULATE_PREPARES = true` | §2 |
| F5 | PHP 행은 `FETCH_NUM` 배열 유지 | §2 |
| D1 | Rust는 sqlx 유지 | §4 |
