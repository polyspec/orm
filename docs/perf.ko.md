# 성능

모든 클라이언트는 호출한 프로세스 안에서 문장을 계획하고 네이티브 드라이버로 실행한다. 현재 클라이언트 오버헤드 기준은 아래 Go·PHP 실행 경로를 `make perf-check`로 측정하며 필수 데이터베이스 환경이 없으면 명령이 실패한다.

드라이버 결과의 측정 환경: Apple M3 Pro, macOS, MySQL 8.4.11 로컬 유닉스 소켓(`/tmp/mysql.sock`), `orm_bench.author` 10만 행, 단일 연결, p50. 원자료: `docs/perf-raw-go-native.txt`, `docs/perf-raw-rust-native.txt`, `docs/perf-raw-rust-native-2.txt`.

## 1. 네이티브 드라이버 기준값

하나의 연결에서 prepared statement를 재사용한다. 이 값은 ORM 없이 드라이버만 측정한 결과다.

| 작업 | Go database/sql | Rust sqlx | PHP PDO |
|---|---:|---:|---:|
| PK 단일 행 (25컬럼, AES 2) | 38.0µs | 81.4µs | 30.5µs |
| 100행 목록 | 448µs | 472µs | 446µs |
| INSERT | 175µs | 191µs | 181µs |
| 4단 관계 (부모 20 + 자식 IN 쿼리 3개, ≤200행 + 조립) | 6.43ms | 6.68ms | 7.45ms |

## 2. 실행기 규칙

**F1 — pool 클라이언트는 문 text를 연결마다 한 번 prepare하고 재사용하며, 짧은 연결은 문마다 round trip 하나로 실행한다.** Go에서 prepared statement 없는 `QueryContext(args)`(prepare, 실행, close의 세 번 왕복)는 PK 행에 100µs, 캐시한 statement로는 38µs가 걸린다. Go(pgx statement cache), Rust(sqlx), TypeScript(`pg` named statement) 클라이언트는 연결이 요청보다 오래 사는 pool을 가지므로, 각 연결은 문 text를 한 번 prepare한 뒤 server가 유지하는 plan으로 bind하고 실행한다. PHP 연결은 요청 하나 동안만 살아서 유지한 prepare를 다시 쓰지 못하므로, PHP 클라이언트는 문과 bind를 round trip 하나로 실행한다(F4). `server_transactions`(`tests/events/vectors.json`, PostgreSQL에서 text 5개의 문 8개)의 `model_statements` page가 쓰는 server transaction은 새 연결의 첫 실행 / 두 번째 실행에서 Go 13 / 8(pgx는 Parse와 Describe를 자기 round trip으로 전송한다), Rust 13 / 8(sqlx 0.9는 자기 round trip으로 prepare하며 round trip 하나의 mode가 없다), TypeScript 8 / 8(`pg`는 Parse를 첫 Bind, Execute와 함께 전송한다), PHP 8 / 8이다. 측정 근거(Go, PostgreSQL, bench database, `GetBySeq`, `GetsByServiceSeqAndIsClose`, `GetCountByServiceSeq`와 10행 목록으로 된 page, 연결 4개의 pool과 worker 4개, warm-up 200 page 뒤 800~1600 page, 부하가 큰 기계에서 세 번): 모든 문을 prepare 없이 round trip 하나로 실행하는 pgx `exec` query mode와 비교해 statement cache는 steady state p50이 24~44% 빨랐고(5.5~6.3ms 대 7.8~8.9ms), page당 backend CPU가 22~31% 적었으며(2.2~2.5ms 대 2.9~3.0ms), 초당 page가 20~33% 많았다. 새 연결의 첫 page는 0~9% 느렸다(5.1~8.1ms 대 5.1~7.6ms). MySQL에서 같은 비교(driver 쪽 interpolation 대 server 쪽 prepare)는 기계의 noise 안에 있었고, Go, Rust, TypeScript MySQL 클라이언트는 server 쪽 prepare를 유지한다.

**F2 — sqlx PK 지연은 드라이버 자체 비용이다.** sqlx는 풀 크기 1과 전용 연결에서도 PK 행을 약 80µs에 읽으며, 이는 Go와 PDO의 두 배다. 차이는 tokio 작업 전환과 프로토콜 파싱에서 생긴다.

**F3 — 실행기는 실패한 sqlx `try_get`을 흐름 제어에 사용하지 않는다.** 실패한 `try_get`은 셀마다 오류 문자열을 만든다. 정수 컬럼을 `i64`로 읽고 unsigned 컬럼을 `u64`로 다시 읽는 방식은 100행 읽기를 p50 378µs에서 615µs, p90 1.6ms로 늘렸다. 실행기는 컬럼 타입 명칭에 따라 분기해 signed와 unsigned 값을 한 번에 읽는다.

**F4 — PHP는 문장마다 round trip 하나를 쓴다.** PHP 연결은 요청 하나 동안만 살고 요청은 보통 문장 형태를 한 번 실행하므로 cold path가 기준이다. MySQL에서는 `PDO::ATTR_EMULATE_PREPARES = true`로 고정한다. cold path p50(off → on): PK 72→48µs, IN(8) 107→75µs, 100행 460→382µs. warm path p50: PK 33→49µs, 100행 435→400µs. 타입(IP 문자열, JSON, 실수, 불리언)과 conformance 출력은 두 모드에서 같다. PostgreSQL에서는 `Pdo\Pgsql::ATTR_DISABLE_PREPARES = true`를 둔다: 문장과 bind는 unnamed statement 하나로 server에 가고, parameter와 type 추론은 named prepare와 같으며, 요청의 문장 text마다 따로 드는 prepare round trip과 그 implicit transaction이 없다. 문장당 server transaction은 `tests/events/vectors.json`의 `server_transactions`가 검사한다.

**F5 — PHP는 `PDO::FETCH_NUM` 배열을 행 저장소로 유지한다.** 행을 하나씩 가져오는 방식은 100행에 약 511µs, `fetchAll`은 약 425µs가 걸렸다.

## 3. 회귀 검사 (`make perf-check`)

검사는 한 프로세스에서 생성 클라이언트와 같은 결과의 네이티브 코드를 측정한다. 준비 작업 100쌍 뒤에 순서를 번갈아 바꾸는 인접한 1,000쌍을 측정하고, 쌍별 client/native 비율의 중앙값을 한도와 비교한다. 한 쌍을 느리게 하는 부하는 그 쌍의 양쪽을 함께 느리게 하므로 중앙값 비율은 기계 부하를 따르지 않는다. 각 검사는 CPU마다 바쁜 프로세스 하나를 함께 실행한 상태(`TestHotPathGateUnderLoad`, PHP 검사는 `ORM_PERF_CPU_LOAD=1`)에서도 실행한다. 양쪽은 같은 SQL text를 실행한다. `make perf-check`는 gate 전에 Go 네이티브 statement를 생성 클라이언트가 실행하는 statement와 비교하는 `TestNativeStatementsEqualClient`와 모든 네이티브 읽기 workload를 벤치 데이터베이스에서 실행하는 `TestNativeWorkloadsRead`를 실행한다. 모든 클라이언트의 네이티브 쪽은 타입 변환까지 수행한다. PHP 기준 코드는 셀을 디코딩하고 클라이언트 조립과 같은 타입 변환으로 행 값을 만든다. 비율은 클라이언트 기계 부분만 잰다. 모델 객체 생성은 행당 약 0.1µs로 측정된 클라이언트 작업이며 클라이언트 쪽에 남는다. 중앙값 비율이 한도를 넘으면 경고로 보고한다(`WARNING` 줄, CI summary, GitHub warning annotation). 성능은 측정하고 보고할 뿐 검사를 실패시키지 않는다(AGENTS.md).

| 클라이언트 | PK 한도 | 100행 한도 | 검사 |
|---|---:|---:|---|
| Go | 1.35 | 1.25 | `ORM_RUN_PERF_GATE=1`인 `packages/orm-go/bench` `TestHotPathGate` |
| PHP | 1.35 | 1.25 | `packages/orm-php/tests/perf_gate.php` |

두 검사는 `ORM_BENCH_MYSQL_DSN`에서 시드된 벤치 데이터베이스를 읽는다. Go 검사는 `ORM_RUN_PERF_GATE=1`일 때 실행된다. `ORM_BENCH_MYSQL_DSN` 없이 실행한 검사는 그 변수 명칭을 출력하고 실패하며, 어떤 벤치 테스트도 로컬 서버로 대신하지 않는다.

변환을 포함한 기준 코드에서 PHP 8.4.25 로컬 소켓은 PK 비율 1.20–1.31, 100행 비율 1.06–1.12를 보였다. PK 비율은 쿼리당 약 10.5µs인 요청 조립과 계획 고정 비용이 지배한다. PHP 8.5.10은 1.14와 1.02를 보였다.

비율은 하드웨어에 따라 달라지고 왕복 시간이 길수록 1에 가까워진다. 한도는 경고의 기준값이다. 바꾸려면 측정 결과와 이 문서의 갱신이 필요하다.

## 4. Rust MySQL 드라이버 비교

하나의 release 프로세스에서 sqlx 0.9와 `mysql_async` 0.37.1을 비교했다. 풀마다 연결 하나, 같은 prepared SQL과 bind, 같은 4필드 타입 결과, 준비 작업 200회, 측정 작업 1,000회를 사용했다. 모든 쌍의 결과가 같았다. 환경: Apple M3 Pro, MySQL 8.4 로컬 유닉스 소켓, 2026-09-12.

| 작업 | sqlx 평균 | `mysql_async` 평균 | 비율 (`mysql_async/sqlx`) |
|---|---:|---:|---:|
| PK 행 | 58.840µs | 61.825µs | 1.051 |
| 100행 목록 | 1.180ms | 1.113ms | 0.943 |

`bench/rust`에서 `cargo run --release --locked --bin driver_compare -- 1000`을 실행한다. 반복 횟수는 `native`, `driver_compare`, `client_bench`의 필수 인자다. 인자가 없거나 program의 최소값(3, 10, 1) 이상의 정수가 아니면 program은 연결하기 전에 status 1로 끝난다. 드라이버 교체에는 측정된 2배 개선이 필요하다. 두 작업 모두 조건을 충족하지 않으므로 Rust 클라이언트는 sqlx를 유지한다. `make rust-driver-check`는 `driver_compare`와 sqlx 기준 `native`를 `ORM_BENCH_MYSQL_DSN`의 시드된 벤치 데이터베이스에서 적은 반복 횟수로 실행하고, 둘 다 모든 작업의 row를 읽고 status 0으로 끝나지 않으면 실패한다. 지연 시간은 CI 통과 조건이 아니다.

## 5. 최신 기준 실행

2026-09-27 시드한 MySQL 벤치 데이터베이스에서 `make perf-check`가 통과했다. Go 기준은 PK 클라이언트 49.0µs, 네이티브 46.0µs(비율 1.08), 100행 클라이언트 388.0µs, 네이티브 321.0µs(1.21)였고 CPU 부하에서는 각각 40.0µs 대 37.0µs(1.07), 363.0µs 대 298.0µs(1.21)였다. PHP 기준은 PK 81.0µs 대 72.0µs(1.13), 100행 813.8µs 대 712.9µs(1.14)였고 CPU 부하에서는 65.3µs 대 56.5µs(1.15), 1836.2µs 대 1569.8µs(1.15)였다. 모든 값은 3절의 한도 안에 있다.

## 6. 결정 요약

| ID | 결정 | 근거 |
|---|---|---|
| F1 | pool 클라이언트는 연결마다 한 번 prepare하고 재사용, PHP는 문마다 round trip 하나 | §2 |
| F2 | sqlx PK 지연은 드라이버 고유 비용 | §1, §2 |
| F3 | 실패한 sqlx `try_get`을 흐름 제어에 사용하지 않음 | §2 |
| F4 | PHP: 문장마다 round trip 하나(MySQL emulated prepare, PostgreSQL `ATTR_DISABLE_PREPARES`) | §2 |
| F5 | PHP 행은 `FETCH_NUM` 배열 유지 | §2 |
| D1 | Rust는 sqlx 유지 | §4 |
