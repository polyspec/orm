# perf.md — S0 스파이크 실측과 결정

측정 환경: Apple M3 Pro, macOS, MySQL 8.4.11 로컬 유닉스 소켓(`/tmp/mysql.sock`), `orm_bench.battle` 10만 행(`aes_hex_*` 2컬럼),
Go 1.27, Rust 1.98.1(sqlx 0.9, wasmtime 48), PHP 8.5.10(mysqlnd, msgpack, APCu). 단일 연결, p50 기준. 원자료: `docs/perf-raw-*.txt`.

## 1. 엔진 컴파일 비용 (Go in-process, JSON in → JSON out)
| 워크로드 | ns/op | allocs |
|---|---:|---:|
| Compile list(WHERE 트리 2단 + IN 3 + order + limit, plan 1.9KB) | 10,985 | 48 |
| Compile pk | 5,033 | 13 |

형태당 1회(플랜 캐시)이므로 핫패스 기여 0.

## 2. 언어 경계 (콜드패스, 형태당 1회)
| 경로 | list | pk | 비고 |
|---|---:|---:|---|
| Go in-process | 11.0µs | 5.0µs | 함수 호출 |
| Rust `libloading` (.dylib 2.7MB) | 11.4µs | 5.4µs | dlopen 366ms(1회), Go 런타임·시그널이 호스트 프로세스에 탑재 |
| Rust `wasmtime` (.wasm 4.6MB) | 50.6µs | 24.0µs | 모듈 컴파일 390ms(디스크 캐시 후 22ms), 인스턴스화 1.9ms, 런타임 탑재 없음 |
| PHP 영속 UDS → ormd | 26.5µs | 17.4µs | 와이어 오버헤드 ≈12–15µs; 요청당 새 connect면 +22µs |
| PHP APCu 히트(xxh3 + fetch) | 0.25µs | | 캐시된 플랜 `json_decode` 8.3µs → 배열로 저장해 디코드 회피 |

**결정 R1 — Rust 경계 = wasmtime.** 두 경로 모두 예산(형태당 ≤2ms) 대비 100배 여유. 4.4배 느린 것은 콜드패스뿐이고, FFI는 Go 런타임을 tokio 프로세스에 넣는 운영 위험(시그널·스레드·366ms dlopen)이 있다. 아티팩트 하나로 모든 OS/arch, 4번째 언어(TS/엣지)에도 같은 파일.

## 3. PHP 와이어 (100행 × 20열 결과 디코드)
| 인코딩 | bytes | 디코드 p50 |
|---|---:|---:|
| JSON 연관배열(compatibility 형태) | 33.7KB | 139.1µs |
| JSON 위치형 | 16.9KB | 69.8µs |
| **msgpack 위치형** | 11.6KB | **28.7µs** |
| msgpack 연관배열 | 24.5KB | 69.9µs |

**결정 R2 — PHP 와이어 = msgpack + 위치형 행 + 컬럼 헤더.** 모델은 행 배열과 공유 컬럼 인덱스를 들고 있어 변환 비용 0(`array_combine`은 +60µs라 쓰지 않음).

## 4. 네이티브 기준선 (prepared statement 재사용, 단일 연결)
| 워크로드 | Go database/sql | Rust sqlx | PHP PDO |
|---|---:|---:|---:|
| PK 단건 (25열, AES 2) | 38.0µs | 81.4µs | 30.5µs |
| 100행 목록 | 448µs | 472µs | 446µs |
| INSERT | 175µs | 191µs | 181µs |
| 4단 관계(부모 20 + 자식 IN 3회 ≤200행 + 조립) | 6.43ms | 6.68ms | 7.45ms |

**발견 F1 — prepared statement 캐시는 실행기 필수.** Go에서 `QueryContext(args)`(prepare+exec+close, 왕복 3회)는 PK 100µs, 캐시 후 38µs. ormd도 같은 수정으로 112→51µs.
**발견 F2 — sqlx PK 81µs**는 Go/PDO의 2배. 풀 체크아웃·tokio 스케줄링·per-connection 캐시 조회로 추정. S1 Rust 실행기에서 전용 연결·`persistent` 확인 후 재측정(T1.19 DoD에 추가).

## 5. PHP 실행 위치 — 3경로 비교 (핵심 결정)
| 워크로드 | (i) PDO 직접 + PHP 조립 | (iii) ormd 실행(prepared) + msgpack | 차이 |
|---|---:|---:|---:|
| PK 단건 | 30.5µs | 51.4µs | **+69%** |
| 100행 목록 | 446µs | 1,122µs | **+152%** |
| 100행 + 연관배열 변환 | — | 1,448µs | |
| 4단 관계 | 7.45ms (PHP 조립) | 7.87ms (Go 조립) | **+6%** |

게이트(원격 단건 ≤+25%, 목록 ≤+15%, 4단 관계는 compatibility보다 빨라야)를 전부 실패. 목록의 +676µs는 홉(15µs)이 아니라 **행이 경계를 넘는 비용**(Go 제네릭 `[]any` 스캔·복사 + msgpack 인코딩 + PHP 디코드)이다. 4단 관계는 Go 조립이 PHP 조립보다 빠르지 않았다(PDO+mysqlnd의 C 디코딩이 이미 빠르고, 조립 자체는 양쪽 다 수십 µs).
"(i)는 compatibility가 아니라 손으로 쓴 조립"이므로 compatibility 자체는 이보다 느리지만, (iii)가 (i)조차 못 이기므로 결론은 바뀌지 않는다.

**결정 R3 — PHP는 네이티브 실행기(PDO). `ormd`는 컴파일 전용.** plan-v2 §1의 "PHP는 ormd 사이드카가 실행" 결정을 **측정으로 철회**한다. Q1 검수의 가설("Go 조립 > PHP 조립", "홉 비용만 지불")은 실측에서 성립하지 않았다. 검수가 옳게 짚은 드리프트 위험(키 타입·`possible` 비교·`unserialize`)은 적합성 벡터에 키 타입 태그·정수 possible·serialize 픽스처를 넣어 잡는다(체크리스트 T2.16).
뒤집는 조건(유효): 행이 경계를 넘지 않는 새 방식이 나오거나(FrankenPHP in-process로 PHP가 Go 실행기를 직접 호출), PHP가 주력화되어 조립 3벌 유지 비용이 문제될 때.

## 6. 핫패스 게이트 — Go 실측 (S1, 생성 클라이언트)
| 워크로드 | 네이티브(prepared) | 생성 클라이언트 | 비고 |
|---|---:|---:|---|
| PK 단건 | 38.0µs / 39 allocs | 32.9µs / 75 allocs | 플랜 캐시 히트 1.7µs 포함 |
| 100행 목록 | 448µs / 2,176 allocs | 369µs / 4,517 allocs | typed struct 매핑 포함 |
| 플랜 캐시 히트(컴파일 없이) | — | 1.7µs / 14 allocs | IR JSON 직렬화 + FNV |
손실 0(측정 오차 안). 할당 수는 2배(위치형 `[]any` 스캔 → struct) — CPU에 영향 없음, 필요 시 S5에서 typed 스캔으로 줄인다. **G0/G1 Go 게이트 통과.**

### PHP 실측 (생성 클라이언트, ormd 컴파일 + PDO 실행, APCu 플랜 캐시)
| 워크로드 | PDO 직접 | 생성 클라이언트 | 비고 |
|---|---:|---:|---|
| PK 단건 | 30.5µs | 31.4µs (+3%) | 플랜 캐시 히트 1.8µs 포함 |
| 100행 목록 | 446µs | 390µs | 위치형 fetch + 지연 접근(getName ×100 포함 시 410µs) |
**PHP 게이트(≤5%) 통과.** ormd는 형태당 1회만 호출된다.

## 7. S0 결정 요약
| ID | 결정 | 근거 |
|---|---|---|
| R1 | Rust 경계 = wasmtime (.wasm 내장) | §2 |
| R2 | PHP 와이어 = msgpack 위치형 | §3 |
| R3 | PHP 실행 = PDO 네이티브, ormd 컴파일 전용 | §5 |
| F1 | 모든 실행기에 prepared statement 캐시 | §4 |
| F2 | Rust 실행기 PK 지연 재측정 항목 | §4 |
