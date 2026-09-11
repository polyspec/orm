# 전체 작업 체크리스트 (0.0.1 완료까지)

범례: `[ ]` 미착수 `[~]` 진행 `[x]` 완료 · **P** = 같은 묶음 안에서 병렬 가능 · **→ T#** = 선행 의존 · 각 항목은 완료 조건(DoD)이 있어야 닫힌다.
원칙: 폴링/타이머 금지 · symlink 금지(경로는 선언) · 폴백 금지(한 경로만) · 문제는 근본 해결, 감추지 않음 · 사람이 쓰는 정의는 하나(Mermaid), 나머지는 생성물 · 버전은 0.0.1 고정.

## 현재 위치 (2026-09-11)
- **S0 완료** (측정·결정 R1~R3, F1~F3 — `docs/perf.md`).
- **S1 완료** (thin slice: 엔진·생성기·3언어 실행기, 적합성 하네스, `ormgen tokens`, 데모).
- **S2 완료**(T2.15 150테이블 게이트만 example DB 대기), **S3 완료**, **S4 완료**(PHP `__call` 호환층 T4.6만 남음), **S5 언어 레인 진행 중**(docs/lanes/s5.md), **S6 엔진 완료**(dialect PG/SQLite, ddl).
- 적합성 벡터 **40개 × 3언어 바이트 동일**, 코덱 벡터 60개 × 3언어 통과, 토큰 패리티 diff 0.

## 병렬 레인 (어떻게 나눠 일하는가)
| 레인 | 담당 | 다른 레인과의 경계 |
|---|---|---|
| **E 엔진** | `engine/*`, `cmd/ormgen`(생성기 템플릿 포함), `docs/protocol.md` | 계약(IR·Plan·토큰 이름)을 **먼저** 확정·커밋한다. 언어 레인은 그 커밋 이후에만 시작 |
| **G Go** | `clients/go/*`, Go 러너·통합 테스트 | 엔진 계약만 읽는다. 생성기 템플릿을 고쳐야 하면 E에 요청 |
| **P PHP** | `clients/php/*`, PHP 러너·통합 테스트 | 동일 |
| **R Rust** | `clients/rust/*`, Rust 러너·통합 테스트 | 동일 |
| **V 검증·통합** | `tests/conformance`, `tests/codec`, `schema/*.mmd`, `bench/sql`, `bin/*`, 커밋 | **공유 상태를 바꾸는 유일한 레인**: 로컬 MySQL 스키마(ALTER), `schema.json` 재생성, 아티팩트 빌드, 벡터 재기록. 언어 레인은 스키마·DB를 바꾸지 않는다 |

규칙: (1) 같은 단계 안에서 G∥P∥R은 항상 병렬 가능, E→(G,P,R)→V 순서. (2) 언어 레인은 쓰기 테스트에서 자기 언어 이름의 행(`go-write`, `php-write`, `rust-write`)만 쓰고 지운다. (3) 계약이 바뀌면 E가 `docs/protocol.md`+골든 테스트를 먼저 바꾸고, 세 레인이 같은 커밋을 기준으로 이식한다. (4) 서브에이전트로 돌릴 때는 워크트리 격리, V만 메인 브랜치에 병합.

---

## 단계 0 — S0 스파이크 (경계·와이어·기준선 실측)  [완료]
- [x] T0.1~T0.5 환경(Go 1.27, Rust 1.98.1, MySQL 8.4 `/tmp/mysql.sock`, PHP 8.5+APCu+msgpack, 벤치 테이블 10만 행)
- [x] T0.6~T0.9 엔진 스텁, c-shared, wasip1 reactor, ormd 프레임 서버
- [x] T0.10~T0.12 경계 벤치 → **R1 Rust = wasmtime**, **R2 PHP 와이어 = msgpack 위치형**
- [x] T0.13~T0.17 네이티브 기준선 3언어, PHP 3경로 → **R3 PHP = PDO 네이티브, ormd 컴파일 전용**, F1 prepared 캐시 필수, `docs/perf.md`

---

## 단계 1 — S1 thin slice  [완료]
- [x] T1.1 Mermaid `erDiagram` 파서 · T1.2 매니페스트 빌더+검증기(`ormgen build`, `schema_hash`)
- [x] T1.5 IR v1(`docs/protocol.md`) · T1.6 `engine/ir` 검증 · T1.7 MySQL dialect · T1.8 planner v1 · T1.9 골든 테스트 · T1.10 ffi/wasm 연결
- [x] T1.11~T1.13 Go 런타임·생성기·트랜잭션(데드락 3회 재실행)
- [x] T1.14~T1.16, T1.18 ormd 컴파일 전용 데몬, PHP 트랜스포트(영속 UDS+APCu), PHP 실행기(PDO, FETCH_NUM 위치형), PHP 생성기
- [x] T1.19~T1.20 Rust 런타임(전용 스레드 wasmtime, sqlx, `Tx: Clone`)·생성기. F2 종결(sqlx 고유 비용), F3(sqlx `try_get` 실패를 흐름 제어로 쓰지 않음)
- [x] T1.21 `tests/conformance` 하네스(러너 3 + `check run/compare/record`) · T1.22 `ormgen tokens` · T1.23 데모 `examples/thin-slice` · T1.24 Rust 컴파일 시간(5테이블 check 0.25s)
- [x] T1.3 `ormgen import --dsn` (S5 T5.10에서 완료)
- [x] T1.4 `ormgen validate --dsn` (S5 T5.1에서 완료)
- [ ] T1.17 PHP `__call` 파서 → **S4 T4.7로 이동** (v3 문법은 생성 메서드를 쓰므로 호환층 전용)

---

## 단계 2 — S2 관계·코덱  [3주 · 진행 중]

### 2-A 엔진 — 레인 E
- [x] T2.1 planner 관계 단계 그래프(step `role: relation`, `parent{step,index,column,if_parent}`, `parent` 슬롯 2의 거듭제곱 확장, 부모 0행 생략, 중첩, 조인 하위 관계, paginate = main→관계→count)
- [x] T2.2 관계 의미론(`keyBy` last-wins, one = ORDER 첫 행, `LIMIT_IN_RELATION`, `flatten` one 전용, `ifParent` 부모 컬럼 검증·자동 프로젝션·IN 필터, `dropChildKey` = `hidden`)
- [x] T2.3 `limitPerParent(n)` ROW_NUMBER 서브쿼리 `orm_w`
- [x] T2.6 코덱 명세 `docs/codec.md` + 벡터 `tests/codec/vectors.json`(PHP 원본 60개, `gen.php`)
- [x] T2.7 골든 `TestRelations`(4단계·조인 하위·window·if_parent·hidden·paginate 역할·plain IN) + 옵션 에러 3
- [x] T2.4 교차 컬럼 비교 `<col><Op>Col(ref)` 3언어 노출(`XCols` 참조: Go `gen.BattleCols.Seq` / PHP `BattleCols::seq()` / Rust `battle::cols::seq()`, `.At/at('path')`), `selectExpr` 출력은 `Extra(name)`/`extra(name)`/`$r['name']`; 벡터 `eq_col_where`·`expr_where`·`select_expr`
- [x] T2.5 연산자 허용표 단일화(`ormgen`이 `ir.OpAllowed`를 그대로 씀; fulltext는 `%% fulltext` 조합만 생성)

### 2-B 실행기 — 레인 G ∥ P ∥ R (T2.1 후)
- [x] T2.8a G 단계 러너·`Rows.Related/StepAssemble`·typed 조립 · T2.8b G 코덱(`codec.go`: json/serialize/base64/gz, PHP serialize 형식, `Decode` 읽기 직후·`SetStyled/DirtyStyled`)
- [x] T2.9a R 동일 · T2.9b R 코덱(`codec.rs`, `Val::Json`, MySQL JSON 컬럼 직접 디코드, `read_row` 오류 전파)
- [x] T2.10a P `Db::runPlan`·`Rows`·`flatten`(`extra`)·`hidden` · T2.10b P 코덱(`Codec.php`, `columns()` 타입 `styled`)

### 2-C 생성기 — 레인 E (템플릿) 후 G ∥ P ∥ R 확인
- [x] T2.12a/13a/14a 관계 메서드·옵션(`ifParent<Col>Eq`는 부모 컬럼 합집합), 스타일 컬럼 타입(Go `any` / Rust `serde_json::Value` / PHP `mixed`)과 인코딩 setter
- [x] T2.12b Go: `KeyByFn(fn)`(루트 컬렉션), `<Col><Op>Col`, `ToArray()`(선택 컬럼·hidden 제외·extra·로드된 관계·flatten 병합)
- [x] T2.13b Rust: `key_by_fn`, `<col>_<op>_col`, `to_map()` — 동일 규칙
- [x] T2.14b PHP: `keyByFn`, `<col><Op>Col` — `toArray()`는 S2a부터 동일 규칙
- [ ] T2.15 Rust 생성 crate 컴파일 시간 게이트(150-table fixture) → 초과 시 `--tables` 분할 문서화 → **T5.10(import) 선행**

### 2-D 검증 — 레인 V
- [x] T2.17 코덱 벡터 3언어 통과(`go test ./clients/go/orm`, `cargo test -p orm`, `php tests/codec/check.php`: Go/Rust 산출물을 PHP가 읽어 동일)
- [~] T2.16 적합성 벡터 +20 → 현재 **+15 (총 30 × 3언어 동일)**: codec_roundtrip, eq_col_where, expr_where, select_expr, key_by_fn_to_array, drop_child_key_to_array, relation_four_levels(R1), relation_one_ordered, relation_if_parent, relation_empty_parents, relation_off_join, paginate_relations, key_by_column, key_by_unselected, types_roundtrip(datetime(6)·bool·int max·int unsigned max·decimal·json/jsons 빈 값·serialize 빈 문자열). 남은 5개는 S3 쓰기 벡터와 함께: BIGINT UNSIGNED 상한, timestamp 타입 컬럼, 중첩 flatten 2단, serialize 실수 DB 왕복, 조인 두 개 + 관계 → T2.8~T2.14

---

## 단계 3 — S3 쓰기 long tail  [1.5주]  (T2.x 후)

### 3-A 엔진 — 레인 E
- [x] T3.1 엔진: `on_duplicate` upsert(`ON DUPLICATE KEY UPDATE … , pk = LAST_INSERT_ID(pk)`), `no_cascade_delete` + `children[].cascade`(소유 관계만). MutationBatch는 불필요(cascade는 클라이언트가 행마다 DELETE, Db면 트랜잭션 자동)
- [x] T3.2 골든 `TestUpsertAndCascade`

### 3-B 실행기 — 레인 G ∥ P ∥ R
- [x] T3.3 G/P/R(병렬 레인, docs/lanes/s3.md): `onDuplicateSet<Col>[Expr]`, `onDuplicatePlus/Minus<Col>`, `onDuplicateSetAll`, `save`, 쿼리 `update`/`delete`(affected), 행 `deleteCascade`(깊이 우선·Db면 트랜잭션), `noCascadeDelete`, `sql(db)`(`$SECRET` 마스킹)
- [x] T3.4 데드락 게이트 3언어(Go goroutine, PHP 자식 프로세스 2개, Rust tokio 태스크): 재실행 후 양쪽 성공 확인

### 3-C 검증 — 레인 V
- [x] T3.5 적합성 벡터 +6(upsert, upsert_set_all, save_branch, bulk_update_plus_minus, delete_cascade_order, sql_dump) → **36 × 3언어 동일**

---

## 단계 4 — S4 조인·엣지 문법·PHP 호환층  [2.5주]  (T3.x 후)

### 4-A 엔진 — 레인 E
- [ ] T4.1 조인 잔여: 다단 조인 alias 충돌 검증(`COLUMN_ALIAS_CONFLICT` 실제 케이스), 조인 하위 관계 키 고유성, 조인 컬럼 `select<Col>As` 네임스페이스 (join/leftJoin/on/where/nav/조인 하위 관계는 S1·S2에 있음)
- [x] T4.2 엔진: `countDistinct<Col>`, `groupBy`+`count` = 그룹 수(`orm_g`), `min<Col>`/`max<Col>`, `having`(루트 전용) — 골든 통과; 3언어 노출은 T4.5
- [x] T4.3 엔진: `%% predicate` = expr 조각(백틱 컬럼 검증, `?` = arity) → `predicates{expr, arity}`; 생성 메서드 3언어(T4.5)
- [x] T4.4 엔진: `kind: raw` 루트(`{table}` 치환, `?` = ps, role `raw`) — `rawAll` 3언어(T4.5)

### 4-B 생성기·실행기 — 레인 E(템플릿) → G ∥ P ∥ R
- [x] T4.5 G/P/R(병렬 레인, docs/lanes/s4.md): 집계 터미널, `having`, `raw`/`rawAll`, 이름 붙인 술어 메서드 — **3언어 병합, 적합성 40 × 3 동일**
- [ ] T4.6 **P** P: compatibility `__call` 호환층 — `condition*/and*/or*/on*`, op-first(`gtEndDt`), 무접두 `x(v)`, 배열→In·null→IsNull, `relation((new Y)->matchAWithB()->aliasR())`, `joinAWithB`, `addColumnX/addAllColumns`, `parentNode→flatten`, `groupLimit→limitPerParent`, `keyNameX→keyByX`, `fetchKey→keyByFn`, `deleteLock→noCascadeDelete`, `get/gets→one/all`, `getsByAAndB`, `and('(')…condition(')')`(모델 내 균형만, 경계 초과는 `PAREN_ACROSS_MODELS`) — 같은 IR 생성, 적합성으로 검증
- [~] T4.7 `ormgen check --lang php` 완료 → example application 스캔 결과 `docs/checklist.md`(6,752 파일: relation 7,306·match 7,259·alias 5,877·and/or/condition 4,032·괄호 토큰 720·brace-call 64·raw 조각 63·delete(true) 354·duplication 23; 모델 경계를 넘는 괄호 후보 59 파일) — `--lang go` expr analyzer는 남음

### 4-C 검증 — 레인 V
- [~] T4.8 적합성 벡터: +10 완료(S3 6 + S4 4 → 40) — 남은 것: R9 조인+OR fulltext(이제 fulltext 인덱스 있음), 조인 두 그룹, 다단 조인 R8, computed 컬럼 `ST_Y`
- [ ] T4.9 `docs/examples/complex-query.md`를 실행 가능한 예제로 승격(3언어 실행, 플랜 덤프 비교)

---

## 단계 5 — S5 하드닝·배포  [1.5주]  (T4.x 후, 대부분 **P**)

### 5-A 도구 — 레인 E
- [x] T5.10 `ormgen import --dsn`(information_schema → `.mmd`, 결정적·멱등, 이름 기반 FK 추론, 인덱스→`%%`, `=now`, 기존 파일의 라벨/lazy/bool/스타일/predicate 이어받기) — orm_bench 임포트 = 손으로 쓴 매니페스트와 타입·관계·인덱스 동일. **150-table fixture는 로컬에 없음** → T2.15(150테이블 게이트)는 사용자가 DB 접근을 주면 실행
- [~] T5.1 `ormgen validate --dsn`(매니페스트 ↔ 라이브 DB: 테이블·컬럼·타입·NULL·auto·스타일·PK, exit 1) 완료 → 클라이언트 `schema_hash` 부팅 검사 1회는 레인(S5)
- [~] T5.2 `docs/errors.yaml` + `ormgen errors --lang go|php|rust` 완료 → 상수 파일 체크인·사용·드라이버 에러 매핑은 레인(docs/lanes/s5.md)

### 5-B 런타임 — 레인 G ∥ P ∥ R
- [~] T5.3 `on_query(sql, binds, duration, plan_id, err)` — Go 완료(plan_id 16자리 hex, 비밀 `$SECRET` 마스킹), PHP·Rust 레인 진행 중
- [~] T5.3b 고정 비용: Go 66µs vs 네이티브 61µs(+8%, 이전 +13%; IR 해시 무직렬화, 스캔 셀 재사용, 플랜별 스캔 팩트 캐시). ≤+5%는 typed 직접 스캔(생성기 재설계) 필요 → S7 후보. PHP·Rust 레인 진행 중
- [~] T5.4 PHP `EMULATE_PREPARES` 실측·결정 — PHP 레인 진행 중
- [~] T5.5 `orm.toml` 스펙 `docs/config.md` 작성 → 로더 3언어(절대경로·symlink 금지 검증, schema_hash 부팅 검사)는 레인

### 5-C 배포 — 레인 V
- [~] T5.6 `scripts/build-artifacts.sh`(wasm 단일, ormd·ormgen linux/darwin × amd64/arm64, 파일명에 0.0.1, SHA256SUMS) → composer/crates 패키징 메타데이터는 남음
- [x] T5.7 `deploy/ormd.service`, `deploy/com.orm.ormd.plist`, `deploy/README.md`(소켓 소유자·0600·symlink 금지)
- [~] T5.8 CI `.github/workflows/ci.yml` 작성(MySQL 서비스, 엔진·3클라이언트·적합성·코덱·토큰 패리티·생성물 최신 검사). **남은 것**: 러너·통합 테스트가 DSN을 환경변수로 받게(현재 `/tmp/mysql.sock` 고정 → 레인), 벤치 회귀 게이트, 실제 실행 확인
- [~] T5.9 문서: README(3언어 퀵스타트)·`packaging.md` 완료; `dsl.md` 호환층 표는 T4.6 후, `perf.md` 재측정은 레인 종료 후(DB 유휴 시)

---

## 단계 6 — S6 PostgreSQL · SQLite  [2.5주]  (T5.8 후)
- [x] T6.1 E `dialect/postgres`: `$n`, `"quote"`, `ILIKE`, `ON CONFLICT (unique key 추론) DO UPDATE`, `RETURNING`, `to_tsvector('simple')`/`websearch_to_tsquery`, `host()`/`::inet`, aes/hex는 app-side — 골든 통과
- [x] T6.2 E `dialect/sqlite`: `?`, `"quote"`, `LIKE … ESCAPE`, `INDEXED BY`, `ON CONFLICT`, `RETURNING`; `like_binary`·fulltext는 `OPERATOR_NOT_ALLOWED`로 거부(dialect `Supports`), 모든 스타일 app-side — 골든 통과
- [ ] T6.3 **P** G/R 호스트측 AES 코덱(MySQL 키 폴딩, AES-128-ECB, PKCS7) + 벡터(MySQL `AES_ENCRYPT` 산출물과 바이트 일치), `ip` 16B packed, `point` 정책 → T2.6
- [ ] T6.4 G/P/R 드라이버 추상(Go: driver별 DSN·placeholder, Rust: sqlx feature 게이트, PHP: pdo_pgsql/pdo_sqlite) → T6.1, T6.2
- [~] T6.5 V `ormgen ddl --dialect`(MySQL은 validate 왕복, SQLite는 로드 확인, PG는 로컬에 없음) → `bench/sql/battle.pg.sql`·`battle.sqlite.sql`; `tests/codec/aes-vectors.json`(MySQL AES 산출물 8개); docker-compose·3 DB 적합성은 레인 병합 후
- [ ] T6.6 E `ormgen import --dsn postgres://…` → T5.10
- [x] T6.7 `docs/dialects.md` 차이표 + 레인 스펙 `docs/lanes/s6.md`

---

## 단계 7 — 이후 과제 (착수 안 함, 기록만)
- [ ] protobuf/Connect 와이어 · FrankenPHP in-process · DDL diff/마이그레이션 생성 · 멀티테넌시 `scope` · point/yaml/curlfile 스타일 · 서버 스트리밍 · `ormgen precompile`(정적 형태 APCu 시드) · 4번째 언어 클라이언트 · sqlx 대체 드라이버 비교(`mysql_async`) · `multi_statement` 플랜(step 0만 의존하는 단계 묶음)

---

## 병렬 실행 요약
| 시점 | 동시에 진행 가능한 묶음 |
|---|---|
| **지금 (S2 잔여)** | E: T2.4 ∥ T2.5 → 그 뒤 G T2.12b ∥ P T2.14b ∥ R T2.13b ; V: T2.16(벡터 +19)는 지금 바로 |
| S3 | E T3.1→T3.2 (T2.4/2.5와 병렬 가능) → G ∥ P ∥ R T3.3 → V T3.4, T3.5 |
| S4 | E T4.1 ∥ T4.2 ∥ T4.3 ∥ T4.4 → G ∥ P(T4.5+T4.6) ∥ R → V T4.7~T4.9 |
| S5 | E T5.10 ∥ T5.1 ∥ T5.2 ; G ∥ P ∥ R T5.3, T5.3b, T5.4, T5.5 ; V T5.6 ∥ T5.7 → T5.8 → T5.9 |
| S6 | E T6.1 ∥ T6.2 ; G/R T6.3 → T6.4 → V T6.5 |

## 절대 순차(크리티컬 패스)
T2.4/T2.5 → T3.1 → T3.3 → T4.1~4.4 → T4.5/4.6 → T4.8 → T5.8 → T6.1/6.2 → T6.4 → T6.5

## 게이트(통과 못 하면 다음 단계 금지)
- G0 (T0.17) ✔ Go/Rust 핫패스 ≤5% 손실, PHP ≤+5%
- G1 (T1.23) ✔ 3언어 데모 같은 JSON, `ormgen tokens` diff 0, 적합성 15/15
- G2 (T2.15/T2.16): Rust 150테이블 `cargo check` 기록(S5 import 후), 적합성 35/35 (현재 30/30 ✔), 코덱 벡터 60×3 ✔
- G3 (T3.4/T3.5): 데드락 게이트 3/3, 적합성 45/45
- G4 (T4.8): 적합성 60/60, `ormgen check` compatibility checks 문서화
- G5 (T5.8): CI 녹색, 벤치 회귀 게이트 활성, perf.md 재측정
- G6 (T6.5): 3 DB 동일 결과
