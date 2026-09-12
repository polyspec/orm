# 전체 작업 체크리스트 (0.0.1 완료까지)

범례: `[ ]` 미착수 `[~]` 진행 `[x]` 완료 · **P** = 같은 묶음 안에서 병렬 가능 · **→ T#** = 선행 의존 · 각 항목은 완료 조건(DoD)이 있어야 닫힌다.
원칙: 폴링/타이머 금지 · symlink 금지(경로는 선언) · 폴백 금지(한 경로만) · 문제는 근본 해결, 감추지 않음 · 사람이 쓰는 정의는 하나(Mermaid), 나머지는 생성물 · 버전은 0.0.1 고정.

## 현재 위치 (2026-09-12)
- **S0 완료** (측정·결정 R1~R3, F1~F3 — `docs/perf.md`).
- **S1 완료** (thin slice: 엔진·생성기·3언어 실행기, TypeScript 구조 초안, 적합성 하네스, `ormgen tokens`, 데모).
- **S2 구현·검증 완료**(T2.15 150테이블 검사만 대형 스키마 fixture 대기), **S3 완료**, **S4 완료**(PHP 호환층 포함), **S5 구현·CI 검증 완료**(고정 비용 추가 개선은 S7), **S6 완료**(dialect PG/SQLite, ddl, 3언어 실행기; TypeScript 실행기는 미완료).
- 적합성 벡터 **58개 × 3언어 × 3 DB 동일**, 코덱 벡터 60개 × 3언어 통과; TypeScript는 구조 검사만 완료, 토큰 패리티 diff 0.

## Common interface verification

- [x] I1 공통 구조·소유권·상태 전이 명세와 Mermaid 도표 (`interfaces.md`, `contracts/interfaces.json`)
- [x] I2 manifest 기반 Go/PHP/Rust Query·Row 인터페이스 생성과 TypeScript 구조 초안 대조
- [x] I3 저장 필드와 Request/Plan 25개 레코드 대조, AST/Reflection·소스 변경 반례 검사
- [x] I4 Binding·쿼리 재사용·자식 복사·오류 보존·dirty·원본 버전·typed key·페이지 벡터: 총 58 × 3언어 × 3 DB; TypeScript는 실행 벡터 미완료
- [x] I5 CI에 생성물·구조·상태 검사 연결, 현재 문서·예제 동기화
- [x] I6 native PK 직접 변경 후 identity 보존, 중첩 컬렉션 변환 충돌 검증. `interface_identity`, `interface_nested_keys` 통과. 세부 범위: [구현 대조표](interface-implementation.md)

## Online documentation

- [x] D1 기존 Markdown을 직접 사용하는 VitePress 정적 사이트, 사용법·명세·구현 상태 탐색과 로컬 검색
- [x] D2 Mermaid 원본 유지, 빌드 시 SVG 생성, JavaScript 없는 본문·언어별 예제·도표 읽기
- [x] D3 `/orm/` 내부 링크·앵커·직접 HTML 경로·검색·모바일 검사, 반복 빌드 바이트 비교
- [x] D4 [GitHub Pages 배포](https://github.com/polyspec/orm/actions/runs/34649137210) 성공. [공개 문서](https://polyspec.github.io/orm/)의 본문·도표·검색·404 실제 확인

명령과 배포 구조: [문서 빌드와 배포](docs-development.md).

## 병렬 레인 (어떻게 나눠 일하는가)
| 레인 | 담당 | 다른 레인과의 작업 범위 |
|---|---|---|
| **E 엔진** | `engine/*`, `cmd/ormgen`(생성기 템플릿 포함), `docs/protocol.md` | 명세(IR·Plan·토큰 이름)을 **먼저** 확정·커밋한다. 언어 레인은 그 커밋 이후에만 시작 |
| **G Go** | `clients/go/*`, Go 러너·통합 테스트 | 엔진 명세만 읽는다. 생성기 템플릿을 고쳐야 하면 E에 요청 |
| **P PHP** | `clients/php/*`, PHP 러너·통합 테스트 | 동일 |
| **R Rust** | `clients/rust/*`, Rust 러너·통합 테스트 | 동일 |
| **V 검증·통합** | `tests/conformance`, `tests/codec`, `schema/*.mmd`, `bench/sql`, `bin/*`, 커밋 | **공유 상태를 바꾸는 유일한 레인**: 로컬 MySQL 스키마(ALTER), `schema.json` 재생성, 아티팩트 빌드, 벡터 재기록. 언어 레인은 스키마·DB를 바꾸지 않는다 |

규칙: (1) 같은 단계 안에서 G∥P∥R은 항상 병렬 가능, E→(G,P,R)→V 순서. (2) 언어 레인은 쓰기 테스트에서 자기 언어 이름의 행(`go-write`, `php-write`, `rust-write`)만 쓰고 지운다. (3) 명세이 바뀌면 E가 `docs/protocol.md`+골든 테스트를 먼저 바꾸고, 세 레인이 같은 커밋을 기준으로 이식한다. (4) 서브에이전트로 돌릴 때는 워크트리 격리, V만 메인 브랜치에 병합.

---

## 단계 0 — S0 스파이크 (호출 경로·전송·기준선 실측)  [완료]
- [x] T0.1~T0.5 환경(Go 1.27, Rust 1.98.1, MySQL 8.4 `/tmp/mysql.sock`, PHP 8.5+APCu+msgpack, 벤치 테이블 10만 행)
- [x] T0.6~T0.9 엔진 스텁, c-shared, wasip1 reactor, ormd 프레임 서버
- [x] T0.10~T0.12 호출 경로 벤치 → **R1 Rust = wasmtime**, **R2 PHP 와이어 = msgpack 위치형**
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
- [x] T1.17 PHP `__call` 파서 → T4.6에서 완료

---

## 단계 2 — S2 관계·코덱  [완료 · T2.15 잔여]

### 2-A 엔진 — 레인 E
- [x] T2.1 planner 관계 단계 그래프(step `role: relation`, `parent{step,index,column,if_parent}`, `parent` 슬롯 2의 거듭제곱 확장, 부모 0행 생략, 중첩, 조인 하위 관계, paginate = main→관계→count)
- [x] T2.2 관계 의미론(`keyBy` last-wins, one = ORDER 첫 행, `LIMIT_IN_RELATION`, `flatten` one 전용, `ifParent` 부모 컬럼 검증·자동 프로젝션·IN 필터, `dropChildKey` = `hidden`)
- [x] T2.3 `limitPerParent(n)` ROW_NUMBER 서브쿼리 `orm_w`
- [x] T2.6 코덱 명세 `docs/codec.md` + 벡터 `tests/codec/vectors.json`(60개, `gen.php`)
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
- [ ] T2.15 Rust 생성 crate 컴파일 시간 검사(150테이블) → 대형 스키마 fixture 확보 후 실행, 초과 시 `--tables` 분할 문서화

### 2-D 검증 — 레인 V
- [x] T2.17 코덱 벡터 3언어 통과(`go test ./clients/go/orm`, `cargo test -p orm`, `php tests/codec/check.php`: Go/Rust 산출물을 PHP가 읽어 동일)
- [x] T2.16 적합성 벡터 S2분 완료(관계·코덱·타입 15개) → 현재 총 **58 × 3언어 × 3 DB 동일**; TypeScript는 실행 벡터 미완료

---

## 단계 3 — S3 쓰기 long tail  [1.5주]  (T2.x 후)

### 3-A 엔진 — 레인 E
- [x] T3.1 엔진: `on_duplicate` upsert(`ON DUPLICATE KEY UPDATE … , pk = LAST_INSERT_ID(pk)`), `no_cascade_delete` + `children[].cascade`(소유 관계만). MutationBatch는 불필요(cascade는 클라이언트가 행마다 DELETE, Db면 트랜잭션 자동)
- [x] T3.2 골든 `TestUpsertAndCascade`

### 3-B 실행기 — 레인 G ∥ P ∥ R
- [x] T3.3 G/P/R(병렬 레인, docs/lanes/s3.md): `onDuplicateSet<Col>[Expr]`, `onDuplicatePlus/Minus<Col>`, `onDuplicateSetAll`, `save`, 쿼리 `update`/`delete`(affected), 행 `deleteCascade`(깊이 우선·Db면 트랜잭션), `noCascadeDelete`, `sql()`(`$SECRET` 마스킹)
- [x] T3.4 데드락 검사 3언어(Go goroutine, PHP 자식 프로세스 2개, Rust tokio 태스크): 재실행 후 양쪽 성공 확인

### 3-C 검증 — 레인 V
- [x] T3.5 적합성 벡터 +6(upsert, upsert_set_all, save_branch, bulk_update_plus_minus, delete_cascade_order, sql_dump) → **36 × 3언어 동일**

---

## 단계 4 — S4 조인·엣지 문법·PHP 호환층  [2.5주]  (T3.x 후)

### 4-A 엔진 — 레인 E
- [x] T4.1 조인 잔여: 다단 조인 별칭 네임스페이스 골든(`TestJoinAliasNamespaces`: 같은 대상 2단 조인 별칭 5개 유일, 엔티티별 `select<Col>As` 격리), 출력 이름 중복은 `COLUMN_ALIAS_CONFLICT`(컬럼·alias·expr 3경우)
- [x] T4.2 엔진: `countDistinct<Col>`, `groupBy`/`groupByExpr`+`count` = 그룹 수(`orm_g`), `group_count` = 그룹별 행과 `row_count`, `min<Col>`/`max<Col>`, `having`(루트 전용) — 골든 통과; 3언어 노출은 T4.5
- [x] T4.3 엔진: `%% predicate` = expr 조각(백틱 컬럼 검증, `?` = arity) → `predicates{expr, arity}`; 생성 메서드 3언어(T4.5)
- [x] T4.4 엔진: `kind: raw` 루트(`{table}` 치환, `?` = ps, role `raw`) — `rawAll` 3언어(T4.5)

### 4-B 생성기·실행기 — 레인 E(템플릿) → G ∥ P ∥ R
- [x] T4.5 G/P/R(병렬 레인, docs/lanes/s4.md): 집계 터미널(`getCount`/`getsCount` 포함), `groupByExpr`, `having`, `raw`/`rawAll`, 이름 붙인 술어 메서드, `getBy`/`getsBy`/`getCountBy` finder 단축 — **3언어 병합, 적합성 40 × 3 동일**
- [x] T4.6 PHP `__call` 호환층(`clients/php/src/Compat.php`, 생성 클래스에 trait): and*/or*/condition*, op-first, 괄호 토큰·brace-call, relation/matchAWithB/alias, join, addColumn*, keyName/fetchKey, parentNode/groupLimit/possible/deleteLock, 선언되지 않은 getBy*/getsBy…And…, duplication, plus/minus/setRaw → 같은 IR; `compat.php` 50쌍 IR 동일; 번역 불가 목록은 dsl.md "PHP 호환층" 표(모델 간 괄호 → PAREN_ACROSS_MODELS)
- [x] T4.7 `ormgen check --lang php` + `--lang go` 프래그먼트 analyzer(백틱 컬럼 존재·`?`/바인드 개수, `ormgen:ignore` 주석으로 의도적 음성 테스트 제외) — CI 단계로 포함

### 4-C 검증 — 레인 V
- [x] T4.8 적합성 벡터 +13(S3 6 + S4 4 + 조인 3: `join_fulltext_or` R9 fulltext OR 탐색, `join_two_groups` 조인 2개의 ON/WHERE, `join_multi_level` 2단 조인 별칭) → **43 × 3언어 × 3 DB 동일**
- [x] T4.9 `examples/complex`(3언어, 같은 JSON, 토큰 49개 동일): 조인 on/where + 루트 or 그룹 + 탐색 + 3단 관계 옵션 + 집계/having. `docs/examples/*.md`(예시 스키마)는 설명용으로 유지 — README에 명시
- [x] T4.10 본 엔티티 equality finder(`getsBy<Field>`, `getCountBy<Field>`)가 기존 root `join`·`relation` 단계를 보존하는지 검증: Go는 명시적 root 조건 체인과 SQL·bind·statement 수·조립된 행을 비교하고, `root_finder_join_relation`을 3언어 × 3 DB에서 동일하게 실행 → **44 × 3언어 × 3 DB 동일**

---

## 단계 5 — S5 하드닝·배포  [1.5주]  (T4.x 후, 대부분 **P**)

### 5-A 도구 — 레인 E
- [x] T5.10 `ormgen import --dsn`(information_schema → `.mmd`, 결정적·멱등, 이름 기반 FK 추론, 인덱스→`%%`, `=now`, 기존 파일의 라벨/lazy/bool/스타일/predicate 이어받기) — orm_bench 임포트 = 손으로 쓴 매니페스트와 타입·관계·인덱스 동일. **150테이블 스냅샷 fixture는 로컬에 없음** → T2.15(150테이블 검사)는 fixture 확보 후 실행
- [x] T5.1 `ormgen validate --dsn` + 3언어 `schema_hash` 부팅 검사 1회(`SCHEMA_HASH_MISMATCH`, 감시 없음)
- [x] T5.2 `docs/errors.yaml` + `ormgen errors --lang` + 3언어 상수 파일 체크인·사용, 드라이버 매핑(1213/40001 → DEADLOCK, 1062/23000 → DUPLICATE_KEY, 원문 보존)

### 5-B 런타임 — 레인 G ∥ P ∥ R
- [x] T5.3 `on_query(sql, binds, duration, plan_id, err)` 3언어(plan_id 16자리 hex, 비밀 `$SECRET` 마스킹; 적합성 벡터도 `$SECRET`로 재기록)
- [~] T5.3b 고정 비용: Go 66µs vs 네이티브 61µs(+8%, 이전 +13%; IR 해시 무직렬화, 스캔 셀 재사용, 플랜별 스캔 팩트 캐시). ≤+5%는 typed 직접 스캔(생성기 재설계) 필요 → S7 후보. PHP 62µs vs 56µs(+11%, 이전 +16%; 빌더 시그니처 로컬 캐시). Rust: 3행 데모 오차 범위 내(+2µs), list100 476→428µs, PK p99 210→102µs(`MySqlRow` 직접 디코드, `Vec<Val>` 제거). ≤+5% 미달 언어(Go/PHP)는 S7
- [x] T5.4 PHP `EMULATE_PREPARES = true` 결정: 콜드(prepare+execute, PHP-FPM 현실) PK 72→48µs, IN(8) 107→75, 100행 460→382; 웜 PK는 33→49로 손해. 타입 동일, 러너 출력 동일 (`clients/php/tests/bench_emulate.php`)
- [x] T5.5 `orm.toml` 스펙 + 로더 3언어(`orm.OpenConfig` / `Orm::fromConfig` / `Db::from_config`; 절대경로·존재·symlink 금지, 미지 키 거부, aes|aes_env)

### 5-C 배포 — 레인 V
- [x] T5.6 아티팩트·패키징: `scripts/build-artifacts.sh`(wasm 1개 + ormd·ormgen linux/darwin × amd64/arm64, 파일명에 0.0.1, SHA256SUMS), `clients/php/composer.json`(PSR-4), `clients/rust/orm/Cargo.toml` 메타데이터, Go는 모듈 경로
- [x] T5.7 `deploy/ormd.service`, `deploy/com.orm.ormd.plist`, `deploy/README.md`(소켓 소유자·0600·symlink 금지)
- [x] T5.8 CI `.github/workflows/ci.yml`: MySQL·PostgreSQL 서비스 + SQLite, 엔진·3클라이언트·3 DB 적합성·코덱·토큰 패리티·생성물 최신 검사·회귀 검사(`bench/go` TestHotPathGate)까지 [GitHub CI 실제 실행](https://github.com/polyspec/orm/actions/runs/34649545210) 통과. 공통 구조·상태·소스 반례 검사 포함
- [x] T5.9 문서: README·`packaging.md`·`dsl.md`(호환층 표)·`dialects.md`·`config.md`·`codec.md`·`errors.yaml`, `perf.md` §6d 재측정(S6 종료 시점 3언어 × 네이티브 대비)

---

## 단계 6 — S6 PostgreSQL · SQLite  [완료]
- [x] T6.1 E `dialect/postgres`: `$n`, `"quote"`, `ILIKE`, `ON CONFLICT (unique key 추론) DO UPDATE`, `RETURNING`, `to_tsvector('simple')`/`websearch_to_tsquery`, `host()`/`::inet`, aes/hex는 app-side — 골든 통과
- [x] T6.2 E `dialect/sqlite`: `?`, `"quote"`, `LIKE … ESCAPE`, `INDEXED BY`, `ON CONFLICT`, `RETURNING`; `like_binary`·fulltext는 `OPERATOR_NOT_ALLOWED`로 거부(dialect `Supports`), 모든 스타일 app-side — 골든 통과
- [x] T6.3 (위 S6 항목에서 완료: 3언어 호스트 AES/HEX/IP, `aes-vectors.json` 바이트 일치)
- [x] T6.4 드라이버 추상 3언어(Go: pgx stdlib·modernc sqlite / Rust: sqlx feature + Pool enum + PG 파라미터 타입 서버 조회 / PHP: pdo_pgsql·pdo_sqlite + 타입 바인딩), `$n` 재번호, RETURNING, 에러 매핑, `[db].driver`, ormd `-dialect` 검사, hook `$SECRET`·`$NOW` 마스킹, 슬롯 `col_type`
- [x] T6.5 로컬 PostgreSQL 17·SQLite에 bench 시드 + AES 시더; **3언어 × 3 DB 각 44/44 동일**(방언별 기대값 파일, 벡터 선언은 `vectors.json` 한 곳)
- [x] T6.6 `ormgen import --driver postgres`(+`validate --driver postgres`): PG 타입·identity·GIN을 정규 표기로 되돌림 — orm_bench 임포트 결과가 손으로 쓴 매니페스트와 타입·관계·인덱스 0 차이(MySQL 전용 `unsigned`/`onupdate` 제외)
- [x] T6.7 `docs/dialects.md` 차이표 + 레인 스펙 `docs/lanes/s6.md`

## 단계 7 — S7 후속 기능과 문서 정비  [미착수]

S7 항목은 구현과 문서 작업을 각각 완료해야 한다. 구현하지 않은 항목은 완료로 표시하지 않는다. Go·PHP·Rust·TypeScript에 같은 기능을 제공할 수 없으면 설계 검토에서 중단한다.

### 기능 개발

- [ ] T7.1 protobuf/Connect 전송 형식과 Go·PHP·Rust·TypeScript 클라이언트 구현
- [x] T7.3 `ormgen diff` 구현, 파괴적 변경 명시 옵션과 결정성 테스트 추가
- [~] T7.4 `scope` 지시문·NULL 불가 컬럼 검사·Go/PHP/Rust 생성 API 구현; IR 자동 적용·DB 격리 테스트·TypeScript 전체 생성은 미착수
- [ ] T7.5 `point`, `yaml`, `curlfile` 스타일의 공통 codec 구현
- [ ] T7.6 서버 스트리밍 API 구현
- [x] T7.7 `ormgen precompile` 구현, 요청·스키마 해시 포함 출력과 검증 테스트 추가
- [~] T7.8 TypeScript 공통 자료 구조·호출 순서 초안과 컴파일·AST 검사 추가; 전체 엔티티 생성 및 벡터 실행은 미착수
- [ ] T7.9 `mysql_async`와 현행 Rust 드라이버 비교
- [ ] T7.10 `multi_statement` 플랜 구현과 관계 단계 결과 비교
- [ ] T7.11 Go·PHP typed 직접 스캔 성능 개선 및 기준값 재측정
- [ ] T7.12 150테이블 Rust 생성 crate fixture와 컴파일 시간 측정
- [~] T7.13 AES 키 버전 컬럼 검사와 Go·PHP·Rust·TypeScript 행 재암호화 구조 및 Go 단위 테스트 완료; Go DB 행 순회·트랜잭션 저장·각 언어 DB API·상태 조회는 미착수

### 문서 정비

- [x] T7.D1 언어별 문서 파일 구조를 `docs/*.md`와 `docs/**/*.ko.md`로 고정
- [x] T7.D2 한국어 문서를 `docs/**/*.ko.md`로 배치하고 영어 문서와 항목을 비교
- [x] T7.D3 VitePress 언어 링크와 검색 범위 추가
- [x] T7.D4 문서에서 구어체·비유·의인화 표현 제거
- [x] T7.D5 기능별 입력·출력·오류·상태·지원 언어를 표로 작성
- [x] T7.D6 구현되지 않은 기능을 별도 목록으로 표시
- [x] T7.D7 두 언어 문서의 제목·코드·표 항목 일치 검사 추가
- [x] T7.D8 문서 문체 검사와 번역 항목 검사기를 CI에 추가
- [ ] T7.D9 S7 기능별 예제와 검증 명령 추가
- [x] T7.D10 Pages 빌드와 정적 링크 검사에 S7 문서 포함

---

## 실행 요약
| 시점 | 동시에 진행 가능한 묶음 |
|---|---|
| **현재** | T2.15(150테이블 fixture) ∥ T5.8(GitHub 실제 실행 확인); T5.3b Go/PHP typed 직접 스캔은 S7 후보 |
| S3 | E T3.1→T3.2 (T2.4/2.5와 병렬 가능) → G ∥ P ∥ R T3.3 → V T3.4, T3.5 |
| S4 | E T4.1 ∥ T4.2 ∥ T4.3 ∥ T4.4 → G ∥ P(T4.5+T4.6) ∥ R → V T4.7~T4.9 |
| S5 | E T5.10 ∥ T5.1 ∥ T5.2 ; G ∥ P ∥ R T5.3, T5.3b, T5.4, T5.5 ; V T5.6 ∥ T5.7 → T5.8 → T5.9 |
| S6 | E T6.1 ∥ T6.2 ; G/R T6.3 → T6.4 → V T6.5 |

## 크리티컬 패스 (구현·CI 실행 확인 완료)
T2.4/T2.5 → T3.1 → T3.3 → T4.1~4.4 → T4.5/4.6 → T4.8 → T5.8 → T6.1/6.2 → T6.4 → T6.5

## 검사 조건
- G0 (T0.17) ✔ Go/Rust 핫패스 ≤5% 손실, PHP ≤+5%
- G1 (T1.23) ✔ 3언어 데모 같은 JSON, `ormgen tokens` diff 0, 적합성 15/15
- G2 (T2.15/T2.16): Rust 150테이블 `cargo check` 기록(대형 스키마 fixture 대기), 적합성 58/58 ✔, 코덱 벡터 60×3 ✔
- G3 (T3.4/T3.5): 데드락 검사 3/3, 적합성 45/45
- G4 (T4.8): 적합성 58/58, `ormgen check`와 토큰 패리티를 CI에서 검증
- G5 (T5.8) ✔ [GitHub CI 실행](https://github.com/polyspec/orm/actions/runs/34649545210) 통과; 벤치 회귀 검사 활성
- G7 (T7.1~T7.12, T7.D1~T7.D10): 모든 기능과 문서 항목의 구현·검사·Pages 배포가 완료될 때까지 미완료
- G6 (T6.5) ✔ 3 DB 동일 결과 (3언어 × 58 벡터); TypeScript 실행 벡터 미완료
