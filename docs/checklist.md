# 전체 작업 체크리스트 (plan-v2 기준)

범례: `[ ]` 미착수 `[~]` 진행 `[x]` 완료 · **P** = 같은 단계 안에서 병렬 가능 · **→ T#** = 선행 의존 · 각 항목은 완료 조건(DoD)이 있어야 닫힌다.
원칙: 폴링/타이머 금지 · symlink 금지(경로는 `orm.toml` 선언) · 폴백 금지(한 경로만) · 문제는 근본 해결, 감추지 않음 · 사람이 쓰는 정의는 하나(Mermaid), 나머지는 생성물.

---

## 단계 0 — S0 스파이크 (경계·와이어·기준선 실측)  [3일]

### 0-A 환경 (순차, 모두 선행)
- [x] T0.1 Go 1.27 확인
- [x] T0.2 Rust 1.98.1 확인 (`~/.cargo/bin`, 셸 PATH에 추가 필요)
- [x] T0.3 MySQL 8.4 설치 (`brew install mysql@8.4`) → DoD: 로컬 소켓으로 접속, `battle` 벤치 테이블 생성
- [x] T0.4 PHP 8.5 + APCu + msgpack 설치 → DoD: `php -m`에 apcu, msgpack 표시, php.ini에 `extension=` 등록
- [x] T0.5 벤치 테이블·데이터 생성 (`bench/sql/battle.sql`: `battle` DDL 축약, 10만 행, `aes_hex_*` 2컬럼 포함) → T0.3

### 0-B 엔진 스텁·아티팩트 (T0.1 후 순차)
- [x] T0.6 `engine.Compile(IR JSON) → Plan JSON` 스텁(WHERE 트리, 그룹 선두 OR 에러, EMPTY_IN, 스키마 검증) + 테스트 + 벤치 → DoD: `go test ./engine` 통과, list 11µs/pk 5µs 기록
- [x] T0.7 `engine/ffi` c-shared 빌드 (`libormengine.dylib`, 2.7MB)
- [x] T0.8 `engine/wasm` wasip1 reactor 빌드 (`ormengine.wasm`, 4.6MB), vet 통과
- [x] T0.9 `cmd/ormd` UDS 프레임 서버 스텁 (compile op)

### 0-C 경계 벤치 (T0.6~T0.9 후, **P**)
- [x] T0.10 **P** Rust: libloading vs wasmtime 컴파일 경계 → DoD: 수치 `docs/perf-raw-rust-boundary.txt` (FFI 11.4/5.4µs, wasm 50.6/24µs, wasm 인스턴스 1.9ms). **결정: Rust = wasmtime**
- [x] T0.11 **P** PHP: 영속 UDS 스트림 왕복(compile), 요청당 connect 비용, APCu 히트 경로, JSON vs msgpack 100×20 디코드 → DoD: `docs/perf-raw-php-boundary.txt`, **결정: PHP 와이어(JSON|msgpack)**
- [x] T0.12 **P** Go: in-process `Compile` ns/op·allocs (완료: 11µs/48 allocs), 형태 해시 계산 비용 → DoD: 해시 ≤1µs

### 0-D 네이티브 기준선 + PHP 3경로 (T0.5 후, **P**)
- [x] T0.13 **P** Go `database/sql`: PK 단건·100행·INSERT, 동시성 1/16/64, 로컬 소켓 → `bench/go/native_test.go`
- [x] T0.14 **P** Rust `sqlx`: 동일 워크로드 → `bench/rust/src/native.rs`
- [x] T0.15 **P** PHP PDO 직접: 동일 워크로드 + compatibility 조립 기준(vendor `yejune/compatibility` composer 설치, 손으로 쓴 모델 클래스, 4단 관계 1회) → `bench/php/native.php`
- [x] T0.16 PHP 경로 (ii)(iii): `ormd`가 실행까지 하는 임시 경로(Go 실행기 없이 `database/sql` 직접 실행 + 행 JSON/msgpack 반환) → PDO 대비 단건·100행·4단 관계 → T0.11, T0.13
- [x] T0.17 `docs/perf.md` 작성: 3계층(엔진/경계/e2e) 표, 핫패스·콜드패스 분리, 결정 3개(Rust 경계, PHP 와이어, PHP 실행 위치 재확인) → T0.10~T0.16. **게이트**: Go/Rust 핫패스 ≤5% 손실 / PHP 원격 단건 ≤+25%

---

## 단계 1 — S1 thin slice (3 테이블 · 3언어 · 같은 문장 · 같은 결과)  [3.5주]

### 1-A 스키마 (순차)
- [x] T1.1 Mermaid `erDiagram` 파서(`docs/schema.md`): 엔티티 블록(타입·PK/FK/UK·주석 속성 `? =v auto bool lazy 스타일 -> t.c`), 관계선(crow's foot → kind, 라벨 `fk (child / parent)`), `%%` 지시문(unique/index/fulltext/timestamps/predicate), 이름 기본 규칙(`_seq` 제거·접두어 제거+복수형) → DoD: §1 예제 파싱, 라운드트립(파싱→출력) 동일
- [x] T1.2 매니페스트 빌더+검증기(`ormgen build` → `schema.json`, `schema_hash`): 컬럼명 규칙, 관계 이름 충돌·예약어, FK 무관계 경고, 정규 타입 매핑 → DoD: 픽스처 `order_number get_dt condition_type withdraw_count android_app_url origin_price brand_name` 허용, 금지 케이스 에러 → T1.1
- [ ] T1.3 `ormgen import --dsn`(information_schema → `.mmd`): 접두어→style, FK→관계선, 인덱스→`%%`, lazy 규칙, `CURRENT_TIMESTAMP%`, collation, `block_encryption_mode` 확인, `INET6_ATON` 길이 확인, **멱등**(라벨 이름 재정의·주석 속성 보존) → T1.1, T0.3 → DoD: 로컬 `orm_bench` + 150-table fixture에서 임포트, 재실행 diff 0, Mermaid 렌더 확인
- [ ] T1.4 `ormgen validate --dsn`(`.mmd` ↔ `schema.json` ↔ 라이브 DB, exit≠0) → T1.3

### 1-B 엔진 (T1.2 후, 일부 **P**)
- [x] T1.5 IR v1 정의(`docs/protocol.md`): Value, Pred 트리(Group/Pred/cmp/fn/expr), Query, Join, Relation, Mutation, MutationBatch, Plan, Result, 헤더(ir_version, schema_hash), 에러 코드(`docs/errors.yaml`) → **선행: 모든 클라이언트 작업**
- [x] T1.6 **P** `engine/ir`: JSON→IR, 트리 검증(그룹 선두 OR, alias 유일성, EntityNotJoined, EMPTY_IN, 연산자 허용표) → T1.5
- [x] T1.7 **P** `engine/dialect` 인터페이스 + MySQL 구현: quote, placeholder, LIKE(ci by collation), upsert, insert id, fulltext(값 변환 `' '→' +'`, 끝 `*`), row_number, force_index, StyleExpr(aes/hex/ip는 SQL 함수) → T1.5
- [x] T1.8 `engine/planner` v1: 단일 테이블 SELECT/INSERT/UPDATE/DELETE, order/limit, 위치 기반 `assemble.columns[]`, lazy 컬럼 제외·`add/remove/all/only` 모드 → T1.6, T1.7
- [x] T1.9 `engine/api.Compile` + 골든 테스트(IR→SQL+바인드) 30개 → T1.8
- [~] T1.10 **P** `engine/ffi`·`engine/wasm` 실제 엔진 연결(완료: orm_load/orm_compile), 빌드 스크립트(`make artifacts`: darwin/linux amd64/arm64 dylib·so, wasm), 파일명에 버전 포함 → T1.9

### 1-C Go 클라이언트 (T1.9 후)
- [ ] T1.11 `clients/go/orm`: `Db/Tx`(database/sql 래핑, `CLIENT_FOUND_ROWS` DSN 강제), 플랜 캐시(형태 해시 + IN 카디널리티 + schema_hash, 만료 없음), 러너(bind_slots), typed 스캔, `Collection[T]`(순서 유지), `on_query` 훅, `debug()` → T1.9
- [ ] T1.12 `ormgen gen --lang go`: 엔티티 struct, `NewX()`, `<col>(v)`, `<op><Col>(v)` 타입별, `orderBy*`, `limit`, 컬럼 선택, `set*`, 터미널 `get gets count create update save delete`, `getBy<PK|unique>`, nil-safe `GetX()`, 별도 모듈 `clients/go/gen`, gofmt 통과 → T1.11
- [ ] T1.13 Go 트랜잭션 `orm.Transaction[T]`(에러=rollback, 데드락 3회 클로저 재실행, 백오프 50ms·2^n+지터 — 재시도이지 타이머 루프 아님) → T1.11

### 1-D ormd(컴파일 전용) + PHP 클라이언트 (T1.9 후) — S0 R3: PHP는 PDO 네이티브 실행
- [ ] T1.14 `cmd/ormd` 컴파일 데몬 확정: 프레임 `compile`만, msgpack 응답(플랜), `request_id`, 무상태, DSN 없음, 소켓 0600, S0 임시 `exec*` op 삭제 → T1.9
- [ ] T1.15 `clients/php/src` 트랜스포트: 영속 UDS(`STREAM_CLIENT_PERSISTENT`, 실패 시 즉시 재연결 1회 — 루프 없음), APCu 플랜 캐시(배열로 저장, 키 = xxh3(IR 형태)+schema_hash) → T1.14
- [ ] T1.16 `clients/php/src` 실행기: PDO(`EMULATE_PREPARES=false`, `ATTR_FOUND_ROWS`), prepared statement 캐시(F1), 플랜 러너(bind_slots·LIST_EXPAND), 위치형 행 + 공유 컬럼 인덱스를 드는 `Model`(ArrayAccess + magic getter, `getX()`/`getX($d)` 규칙, 변환 비용 0), `Collection`, `Db/Tx`, `transaction(fn)`, 데드락 클로저 재실행 → T1.15
- [ ] T1.17 PHP `__call` 파서: camel 토큰화 → 키워드 최장일치 → `[Op] Column (And|Or …)*` 컬럼표 최장일치 → 정적 배열 사전 계산(opcache) + 동적 이름 런타임 파싱, 충돌 픽스처 통과 → T1.16
- [ ] T1.18 `ormgen gen --lang php`: 클래스(정규 메서드 docblock, `COLUMNS` 표, 관계표), pint 통과 → T1.17

### 1-E Rust 클라이언트 (T1.10 후)
- [ ] T1.19 `clients/rust/orm`: wasmtime 로더(엔진 wasm을 crate에 `include_bytes!`, `Cache` 디렉터리는 `orm.toml`/env 선언, 스레드당 `Store`), 플랜 캐시, sqlx(mysql) 러너(`AssertSqlSafe`, persistent prepared, F2: PK 81µs 원인 규명·재측정 DoD), typed 스캔, `IndexMap` 컬렉션, `Tx: Clone`, `db.transaction(|tx| async {…})` → T1.10
- [ ] T1.20 `ormgen gen --lang rust`: 별도 crate `clients/rust/gen`, 모듈=테이블, `X::new()`, 술어 메서드 by-value, setter `&mut self`, 예약어 개명(`match_`), rustfmt 통과, `--tables` → T1.19

### 1-F 적합성·데모 (T1.12, T1.18, T1.20 후)
- [ ] T1.21 `tests/conformance` 하네스 v0: 벡터 스키마(체인 정규 토큰열, 픽스처, 기대 SQL·바인드, 기대 결과 정규 JSON: 키 타입 태그·순서 민감), 3언어 러너, docker 없이 로컬 MySQL 사용 → 벡터 10개(PK, gets, IN, null 연산자 에러, 그룹, order, limit, create, save, update)
- [ ] T1.22 `ormgen tokens`: 생성물에서 문장 단위 정규 토큰열 추출 3-way diff → T1.12/T1.18/T1.20
- [ ] T1.23 **데모**: 같은 문장 3파일(`examples/thin-slice/{php,go,rust}`), 같은 JSON 출력, 네이티브 대비 타이밍 한 줄 → 모든 T1
- [ ] T1.24 Rust 생성 crate 컴파일 시간 측정(3 테이블) 기록 → T1.20

---

## 단계 2 — S2 관계·코덱  [3주]

### 2-A 엔진 (순차 → 일부 P)
- [ ] T2.1 planner 관계 단계 그래프: `with<Rel>`(ONE/MANY), `bind_from{step,column}` dedup, `LIST_EXPAND` 슬롯, 부모 0행 시 단계 생략, 중첩 재귀, 관계별 `conn` → T1.8
- [ ] T2.2 관계 의미론: `key_column` 재키잉(last-wins, projection 포함 검증), ONE 중복 = ORDER 첫 행(`group_limit 1`), `Relation.query.limit` → `LIMIT_IN_RELATION`, `parent_node` 병합 규칙(non-null 덮어씀·null은 빈 키만·PK 제외·순서 ONE→조인ONE→MANY→조인MANY), `possible` strict, `strip_right_key` → T2.1
- [ ] T2.3 `group_limit`: `ROW_NUMBER() OVER (PARTITION BY right ORDER …)` 서브쿼리, 내·외부 동일 ORDER, `row_num` 제거, 루트에 partition_by 없으면 에러 → T2.1
- [ ] T2.4 **P** 컬럼 객체·`Pred` IR: `cmp`, `fn(format)`, `expr(fragment, binds)` 스키마 검사·alias 치환·`{self}/{alias:x}` → T1.6
- [ ] T2.5 **P** 타입별 연산자 허용표 확정(문서 + 검증) + fulltext는 YAML `fulltext:` 인덱스 컬럼 조합만 → T1.7
- [ ] T2.6 **P** 코덱 명세(`docs/codec.md`) + 벡터(`tests/codec/*.json`, 로컬 MySQL 산출물: AES/hex/ip 바이트 일치, gz/json 라운드트립) → T0.3
- [ ] T2.7 골든 테스트: 관계 플랜 단계 그래프 20개(R1 4단, R10 groupLimit, parentNode 중첩, possible) → T2.1~T2.3

### 2-B 실행기 (T2.1 후, **P** 언어별)
- [ ] T2.8 **P** Go 실행기: 단계 러너(DAG 순서), 결과 트리 조립(ONE/MANY 링크, key_column, parent_node, possible, strip), 코덱(gz=zlib, json, jsons, serialize 읽기, base64), 컬렉션 중첩 타입 → T2.1, T2.6
- [ ] T2.9 **P** Rust 실행기: 동일 → T2.1, T2.6
- [ ] T2.10 **P** PHP 실행기: 단계 러너·결과 트리 조립·코덱(gz/json/jsons/serialize/base64는 PHP 내장), 중첩 모델/컬렉션, `getRel()`·`['rel']` → T2.1, T2.6

### 2-C 생성기 (T2.4, T2.5 후, **P**)
- [ ] T2.12 **P** Go gen: `with<Rel>`, `keyName<Col>`, `parentNode`, `groupLimit`, `possible<Col>`, `stripKey`, `addColumn<Col>`/`addColumn<Col>As`/`addAllColumns`/`removeAllColumns`, 컬럼 객체 `m.XCol`, `Pred` 결합자, relation typed 필드·`GetRel()` → T2.4, T2.5
- [ ] T2.13 **P** Rust gen: 동일 + `x() -> Option<&T>`, `xs() -> &Collection` → T2.4, T2.5
- [ ] T2.14 **P** PHP gen + `__call`: `with<Rel>`, compatibility 호환(`relation(s)`, `match<A>With<B>`, `alias<Name>`) → 같은 IR → T2.4
- [ ] T2.15 Rust 생성 crate 컴파일 시간 게이트(150-table fixture 임포트) → 초과 시 `--tables` 분할 문서화 → T2.13, T1.3

### 2-D 검증
- [ ] T2.16 적합성 벡터 +20 (R1, 중첩 parentNode, keyName 누락 에러, possible 정수, ONE 중복, groupLimit 3, json 빈 객체, serialize 참조·float, unsigned 상한, timestamp(6), tinyint→bool, decimal) → T2.8~T2.14
- [ ] T2.17 코덱 벡터 3언어(Go·Rust·ormd) 통과 → T2.6

---

## 단계 3 — S3 쓰기 long tail  [1.5주]  (T1.13, T2.8 후)
- [ ] T3.1 엔진: `Mutation` set 변형(value|raw|plus|minus), `minus` 0 하한, plus/minus 바인드, `on_duplicate`(upsert), `optimistic{column,value}`, `MutationBatch` 순서 실행 플랜
- [ ] T3.2 **P** Go 실행기: dirty 추적(origin 보관, 변경 컬럼만), `save()` 분기(PK 존재), 낙관 락(`affected==0` → `OptimisticLock`, `CLIENT_FOUND_ROWS` 검증), `delete(true)` 트리 워크(`deleteLock` 존중) → Batch, `duplication()` → T3.1
- [ ] T3.3 **P** Rust 실행기: 동일 → T3.1
- [ ] T3.4 **P** PHP 실행기: dirty 추적·save·낙관 락·delete(true) 트리 워크·duplication → T3.1
- [ ] T3.5 **P** `paginate(db, page, per)` → `Page{items,total,pages,current}`(count 변형 플랜 자동), `debug()`/`sql(db)` 덤프(바인드 마스킹), `clone` 3언어 → T2.8
- [ ] T3.6 데드락 동시성 테스트(2 tx 교차 갱신) 3언어 공통 게이트 → T1.13
- [ ] T3.7 적합성 벡터 +10(W4 setRaw 카운터, plus/minus, upsert, 낙관 락 실패, delete cascade 순서)

---

## 단계 4 — S4 조인·엣지 문법  [2.5주]  (T2.x 후)
- [ ] T4.1 엔진: `join<Rel>`/`leftJoin<Rel>`(선언 관계), `join(alias, cmp, child)` 탈출구, 조인 그룹 WHERE(부모에 AND), `on(f)`, 다단(target_alias), 조인 하위 relation(조인별 고유 키), 조인 컬럼 위치 매핑 + alias 네임스페이스, `ColumnAliasConflict`
- [ ] T4.2 엔진: 집계 `aggregate{COUNT|COUNT_DISTINCT|GROUP_COUNT|SUM|AVG}`, `Query.raw`, `orderByRaw`, `groupBy raw`, `force_index`, `distinct`
- [ ] T4.3 엔진: YAML `predicates:` 이름 붙인 술어 그룹 → 생성 메서드
- [ ] T4.4 엔진: `multi_statement` 플랜 옵션(step 0 결과만 의존하는 단계 묶음) → 실행기 `NextResultSet`/`fetch_many`/`nextRowset` → T2.1
- [ ] T4.5 **P** Go gen/실행기: `join<Rel>`, `cols()`, `andPred/orPred`, `Pred::all/any/not`, `expr`, `On(f)`, `orm.JoinOf`, 집계 터미널 → T4.1, T4.2
- [ ] T4.6 **P** Rust gen/실행기: 동일 → T4.1, T4.2
- [ ] T4.7 **P** PHP: `->{'condition(…)'}` 괄호문법 스택 트리화(모델 내 균형만), `ParenAcrossModels` 에러+재작성 힌트, `condition*/and*/or*/on*` 호환, `getsByAAndB` 호환, `addColumn<Col>Alias<Name>` 호환 → T4.1
- [ ] T4.8 `ormgen check --lang php`(레거시 이름·expr 백틱 컬럼·ParenAcrossModels 목록) / `--lang go`(expr 문자열 analyzer) → T4.7
- [ ] T4.9 적합성 벡터 +15(R9 조인+OR fulltext, (e) 조인 두 그룹, 다단 조인 R8, 조인 하위 relation R6, 집계, raw 루트, computed 컬럼 ST_Y, expr) → T4.5~T4.7
- [ ] T4.10 `docs/examples/complex-query.md`를 실행 가능한 예제로 승격(3언어 실행, 플랜 덤프 비교) → T4.9

---

## 단계 5 — S5 하드닝·배포  [1.5주]  (T4.x 후, 대부분 **P**)
- [ ] T5.1 **P** `schema_hash` 부팅 검사(각 클라이언트 초기화 시 엔진/ormd에 1회) + `ormgen validate --dsn` CI 게이트
- [ ] T5.2 **P** `docs/errors.yaml` → 3언어 enum 생성, 드라이버 에러 원본 보존(Deadlock·DuplicateKey만 매핑)
- [ ] T5.3 **P** `on_query(sql, binds, duration, plan_id)` 훅 3언어, 로깅 예제
- [ ] T5.4 **P** 아티팩트 빌드 파이프라인: wasm(단일), ormd(linux amd64/arm64, darwin), 버전을 파일명에, 체크섬 → composer(`bin/ormd-<ver>-<os>-<arch>`), crates.io(`include_bytes!` wasm), Go 모듈 태그
- [ ] T5.5 **P** `orm.toml` 스펙·로더 3언어(연결 DSN, ormd 소켓 절대경로, wasm 캐시 디렉터리, schema blob 경로, 디버그) — 상대경로·symlink 금지 검증
- [ ] T5.6 **P** `ormd` systemd/launchd 유닛 예제, 소켓 퍼미션 문서
- [x] T5.7 (불필요 — 스키마 소스 자체가 Mermaid erDiagram)
- [ ] T5.8 CI: GitHub Actions — Go 테스트·골든, Rust 테스트, PHP 테스트, MySQL 서비스 컨테이너로 적합성 3언어, 벤치 회귀 게이트(T0.17 수치 대비), `ormgen tokens` diff, `ormgen check` → T5.1~T5.5
- [ ] T5.9 문서: `dsl.md`(정규 문법·PHP 파서 알고리즘·호환층), `protocol.md`, `packaging.md`(결정·수치·뒤집는 조건), `perf.md` 갱신, README 3언어 퀵스타트

---

## 단계 6 — S6 PostgreSQL · SQLite  [2.5주]  (T5.8 후)
- [ ] T6.1 **P** `dialect/postgres`: `$n` placeholder, `"quote"`, `ILIKE`/`LIKE`, `ON CONFLICT`, `RETURNING`, fulltext → `tsvector`(v1 범위 결정 후), `ROW_NUMBER` 동일, pgx stdlib
- [ ] T6.2 **P** `dialect/sqlite`: `?`, `"quote"`, `LIKE`(ci ASCII) → `lb`는 `GLOB` 또는 `= ` 처리 결정, `ON CONFLICT`, `RETURNING`(3.35+), modernc/sqlx-sqlite
- [ ] T6.3 호스트측 AES 코덱(MySQL 키 폴딩, AES-128-ECB, PKCS7) Go·Rust + 벡터(MySQL `AES_ENCRYPT` 산출물과 바이트 일치), `ip` 16B packed, `point` 정책(v2 유지) → T2.6
- [ ] T6.4 실행기 드라이버 추상(Go: driver별 DSN·placeholder, Rust: sqlx feature 게이트) → T6.1, T6.2
- [ ] T6.5 docker-compose(mysql, postgres, sqlite 파일)로 적합성 전 벡터 × 3 DB 동일 결과 → T6.1~T6.4
- [ ] T6.6 `ormgen import --dsn postgres://…` (information_schema 차이 흡수) → T1.3
- [ ] T6.7 문서: dialect 차이표(LIKE, upsert, insert id, fulltext, 타입 매핑), 버전 하한(MySQL 8.0.2/MariaDB 10.2/PG 12/SQLite 3.25)

---

## 단계 7 — 이후 과제 (착수 안 함, 기록만)
- [ ] protobuf/Connect 와이어 · FrankenPHP in-process · DDL diff/마이그레이션 생성 · 멀티테넌시 `scope` · min/max/having · point/yaml/curlfile 스타일 · 서버 스트리밍 · `ormgen precompile`(정적 형태 APCu 시드) · 4번째 언어 클라이언트(사이드카 경로)

---

## 병렬 실행 요약
| 시점 | 동시에 진행 가능한 묶음 |
|---|---|
| 지금 | T0.5 · T0.11 · T0.12 (T0.13~T0.15는 T0.5 후) |
| T1.5 확정 직후 | T1.6 ∥ T1.7 ; T1.3 ∥ T1.4 |
| T1.9 완료 후 | T1.10(아티팩트) ∥ T1.11(Go 런타임) — 이후 Rust(T1.19)는 T1.10, ormd/PHP(T1.14)는 T1.11에 매달림 |
| S2 | T2.4 ∥ T2.5 ∥ T2.6 (엔진 코어 T2.1~T2.3와 병렬) → 실행기 T2.8 ∥ T2.9 → 생성기 T2.12 ∥ T2.13 ∥ T2.14 |
| S3 | T3.2 ∥ T3.3 ∥ T3.5 |
| S4 | T4.5 ∥ T4.6 ∥ T4.7 (엔진 T4.1~T4.4 후) |
| S5 | T5.1~T5.7 전부 병렬 → T5.8 → T5.9 |
| S6 | T6.1 ∥ T6.2 ∥ T6.3 → T6.4 → T6.5 |

## 절대 순차(크리티컬 패스)
T1.1 → T1.2 → T1.5 → T1.6/T1.7 → T1.8 → T1.9 → T1.11 → T1.14 → T1.16 → T1.21 → T2.1 → T2.8 → T3.1 → T4.1 → T5.8 → T6.5

## 게이트(통과 못 하면 다음 단계 금지)
- G0 (T0.17): Go/Rust 핫패스 ≤5% 손실, PHP 원격 단건 ≤+25%, 4단 관계 ormd ≥ compatibility 속도
- G1 (T1.23): 3언어 데모 같은 JSON, `ormgen tokens` diff 0, 적합성 10/10
- G2 (T2.15/T2.16): Rust 150테이블 `cargo check` 기록, 적합성 30/30, 코덱 벡터 3/3
- G3 (T3.6/T3.7): 데드락 게이트 3/3, 적합성 40/40
- G4 (T4.9): 적합성 55/55, `ormgen check` compatibility checks 문서화
- G5 (T5.8): CI 녹색, 벤치 회귀 게이트 활성
- G6 (T6.5): 3 DB 동일 결과
