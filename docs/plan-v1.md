# 최종안: compatibility 문법의 PHP / Go / Rust 공통 데이터 접근 계층
## — "컴파일러 1개(Go) + 네이티브 실행기 3개 + 동일 토큰 문법"

## Context

사용자는 Go·Rust를 주로, PHP를 가끔 쓰며 세 언어에서 **같은 문장으로 읽히는** DB 접근 문법을 원한다.
초기 요구사항과 호출 패턴을 바탕으로 문법·빈도를 정리했고,
대상 DB는 MySQL(1차) + PostgreSQL + SQLite. **DB 성능이 편리함보다 우선**한다.

초안(프록시/FFI/WASM 엔진이 실행까지 담당)은 적대 검수 4건(성능·패키징 / 문법·의미론 / 범위·실행 / 언어 유사성)에서
다음 결함이 확인되어 구조를 바꿨다.

| 검수 지적 | 채택한 수정 |
|---|---|
| 엔진이 실행을 맡으면 행 데이터가 언어 경계를 두 번 넘고(직렬화), PHP-FPM에서 Go c-shared는 fork 후 로드·워커당 Go 런타임(스레드/RSS 4–8GB)·`ffi.enable` 문제, WASM은 요청마다 재컴파일 → PHP에서 FFI/WASM 실행은 불가. 행을 wasm으로 넘기면 100행 목록에서 예산 10배 초과 | **엔진 = 컴파일러만**(IR→Plan). 실행·풀·트랜잭션은 각 언어 네이티브 드라이버(database/sql, sqlx, PDO). 행 데이터는 절대 경계를 넘지 않음 |
| 쿼리 형태는 소스에서 고정 → 값 무관 플랜을 캐시하면 경계는 콜드패스에서만 | **언어별 플랜 캐시**(IR 형태 해시 + IN 카디널리티). 핫패스 = 네이티브 드라이버 + 캐시된 SQL |
| WHERE 괄호가 루트에서 열려 조인 모델에서 닫히는 실제 코드 존재; 조인별 where 검증은 깨짐 | 루트+조인을 잇는 **단일 토큰 스트림**으로 검증, 선행 연결자, `orJoin(alias)` 스플라이스 |
| relation 세부(keyName 재키잉·parentNode 병합·matchKeyRemove·possible·관계별 연결·ONE 중복) 누락 | IR 필드·규칙 명시 (§프로토콜) |
| `delete(true)`는 클라이언트가 로드한 트리를 걷는 것; 트랜잭션 내 데드락 재시도는 엔진이 불가 | 순서 있는 `MutationBatch`; 데드락 시 **클라이언트가 클로저 재실행**(compatibility 방식) |
| 집계·raw SQL 루트(26곳)·계산 컬럼 `addColumn(col,alias,'ST_Y(%s)')`·`Model::function` 미표현 | `aggregate`, `Query.raw`, `columns.computed`, `Predicate.lhs_expr` 추가 |
| 세 언어 문법이 머리(`(new X)($db)` vs `x.Query(db)`)·관계 생성·터미널·결과 접근에서 갈라짐 | **정규 토큰 문법**: 머리 `new Entity`, 동일 중간 토큰, 실행기를 받는 터미널, `and(f)/or(f)` 그룹, YAML 선언 관계로 `alias<Name>()` 타입화 |
| 일정 21–28주는 1인에게 비현실적; A/B/C 세 패키징을 M1 전에 만드는 건 함정 | 3일 스파이크 + 4주 thin slice, 총 ≈15–16주. WASM·protobuf·Connect는 후순위 실험 |
| MySQL AES를 Go로 옮길 이유 없음(compatibility는 SQL 함수) | MySQL은 **SQL 함수 유지**(바이트 동일). 호스트측 AES는 PG/SQLite에서만(S6) |
| 토큰 이름 패리티는 이름만 검증 | **공유 JSON 적합성 벡터**를 3언어 실행기가 같은 DB에 대해 실행 + 정규화 토큰열 비교 |
| YAML↔DB 드리프트 무방비 | `ormgen validate --dsn`, `schema_hash` 부팅 검사 필수, 임포터 멱등(수동 필드 보존) |

### 설계 원칙 (사용자 규칙)
1. **폴링/타이머는 메인 메커니즘이 아니다.** 런타임에 주기 작업 없음: 플랜 캐시는 요청 시 채움, `ormd`는 요청-응답만, PHP UDS 스트림은 실패 시 즉시 재연결(재시도 루프 없음), 스키마 변경은 `schema_hash` 불일치 에러로 즉시 드러남(감시 없음). 데드락 재시도는 InnoDB가 트랜잭션을 통째로 롤백하는 상황의 정공법(compatibility와 동일)이며 최대 3회로 한정한 명시적 재실행이지 타이머 루프가 아니다.
2. **symlink 금지, 경로는 선언적/발견적으로 해석.** `.so`/`.wasm`/소켓/스키마 blob 경로는 설정에 절대경로로 선언하거나(`orm.toml`: `engine.library`, `ormd.socket`, `schema.blob`) 정해진 발견 규칙(Cargo `OUT_DIR` 내 프리빌드, composer `vendor/bin/ormd` 아래 고정 위치)으로 찾는다. 버전 symlink(`lib.so.1 → lib.so`) 없이 파일명에 버전 포함, 상대경로 가정 없음.
3. **폴백은 정말 필요한 곳에만.** 언어별 경계 방식은 S0에서 **하나로 확정**하고 대안 경로를 코드에 남기지 않는다. 선언되지 않은 관계 alias는 "untyped bag" 폴백이 아니라 **검증 에러**. 스키마 불일치·컬럼 미지·괄호 불균형은 조용한 우회 없이 에러. 유일한 의도적 대안: `ormgen gen --no-or-prefix`(S2 컴파일 시간 게이트에서 한 번 결정하는 생성 옵션이며 런타임 폴백이 아님).

### 확정 결정
| 항목 | 결정 |
|---|---|
| 엔진 언어·역할 | Go, **컴파일러 전용**: 스키마 검증 → IR 정규화 → Plan(단계별 SQL·바인드 슬롯·조립 명세) |
| 스키마 | YAML(`schema/*.yaml`) = 소스. 런타임은 컴파일된 blob. `ormgen import --dsn`으로 기존 MySQL에서 생성 |
| 실행기 | 언어별 네이티브: Go `database/sql`(in-process 엔진), Rust `sqlx`, PHP `PDO`. 각 ≈500–800줄(플랜 러너·조립·코덱) |
| 엔진 경계 | Go: 함수 호출. Rust: S0에서 `libloading`(프리빌드 `.so`, 빌드 시 cgo 불필요)과 wasmtime(컴파일 전용 `.wasm`) 중 **하나만 확정**. PHP: `ormd`(컴파일 전용 데몬, DB 접근 없음)에 **영속 UDS 스트림**(`STREAM_CLIENT_PERSISTENT`) + **APCu 플랜 캐시**. 경로는 모두 설정 선언(`orm.toml`) |
| 와이어 | v1 JSON(proto-JSON 호환 필드명). protobuf/Connect는 측정이 요구할 때만 |
| 대상 DB | MySQL ≥8.0.2 / MariaDB ≥10.2 먼저; PostgreSQL ≥12, SQLite ≥3.25는 S6. Dialect 인터페이스는 S1부터 |
| 성능 | 핫패스 = 네이티브 드라이버 + 캐시 SQL (엔진 오버헤드 0). 콜드패스(형태당 1회) 비용을 S0에서 실측·문서화 |

## 실측 요약 (example application)
- 스키마: dataStyle은 컬럼명 접두어(`aes_hex_*`, `gz_*`, `jsons_*`), `ip`는 컬럼명, `point`는 타입. 스타일 컬럼 121/5,145(2.4%). text/blob·스타일 컬럼은 기본 SELECT 제외(`addColumnX()` 옵트인). PK `seq` 99%, FK `<table>_seq`(+역할 접두어), `matchAWithB()` 양방향 1,776개. `created_ts/updated_ts timestamp(6)`. `service_seq` 수동 스코핑. Master/Slave 호출부 선택. 저장소에 DDL 없음.
- 빈도: `set*`→`create/update/save` 19k/1.8k/1k/0.9k · `matchXWithY` 7k · `alias*` 5.7k · `relation/relations` 4.5k/2.6k · `and*/condition*/or*` 3k/1.3k/0.4k · `getBy*/getsBy*` 2.1k/1.1k · `orderBy*` 1.8k · `transaction(fn)` 934 · `join*` 788 · `keyName*` 683 · `parentNode` 583 · `Model::$debug` 355 · `Pagination` 238 · `->{'condition(…)'}` 괄호문법 275 · `groupLimit` 4(대체 불가) · `with()/having/offset/insert()` 0.
- 연산자: Lk 245 · Gt 143 · Lt 61 · Ne 60 · Between 44 · Fulltext 30 · Ge 28 · Le 20; 배열→IN, null→IS NULL, 무토큰→`=` 암묵.
- compatibility 버그(재현하지 않음): `matchAll…With…`/`relations…With…` 오파싱, `orderByBrandName`이 `And`로 분할, 조건 문자열 무구분자 연결, 전역 alias 카운터, 빈 배열 IN, `minus` 후 상태 잔존, `plus/minus` 값 미바인드.

## 아키텍처

```
schema/*.yaml ─▶ ormgen ─┬─▶ schema.blob (엔진 내장)
                         ├─▶ clients/php/gen   (클래스 + 토큰표 + docblock)
                         ├─▶ clients/go/gen    (typed 메서드, 별도 모듈)
                         └─▶ clients/rust/gen  (typed 메서드, 별도 crate)

            ┌── engine (Go 패키지, 순수·무상태) ──┐
  IR(JSON) ─▶ 검증 → planner → dialect → Plan{steps, bind_slots, assemble} ─▶
            └──────────────────────────────────┘
   Go: in-process      Rust: S0에서 확정한 단일 경계      PHP: ormd(UDS 영속) + APCu

   각 언어 실행기: 플랜 캐시(형태 해시) → 네이티브 드라이버 실행 → 결과 트리 조립 → typed 모델
```

- 관계 배치는 Plan의 단계 그래프(`bind_from{step,column}` = 부모 결과의 left 값 dedup → IN)로 표현; 실행기는 단계를 순서대로 실행.
- 트랜잭션은 실행기 네이티브(`Tx` 핸들을 터미널에 전달). 데드락(1213/40001)은 실행기가 클로저를 새 트랜잭션으로 재실행(3회, 50ms·2^n+지터).
- 엔진 경계는 형태당 1회. 캐시 키 = IR 형태 해시(값 제외, IN 카디널리티 포함) + `schema_hash`.

## 저장소 레이아웃 (`the repository`)
```
go.mod                       github.com/polyspec/orm (가칭)
cmd/ormgen/                  import · gen · validate · tokens · erd
cmd/ormd/                    PHP용 컴파일 데몬 (UDS, length-prefixed JSON 프레임, 무상태)
engine/  schema/ ir/ planner/ dialect/{mysql,postgres,sqlite} plan/ api/(Compile)
engine/ffi/                  c-shared 빌드 (orm_compile(req,len,&resp,&len), orm_free) — Rust용
clients/go/orm/              Db/Tx, Collection, 플랜 캐시, 러너, 조립  |  clients/go/gen/  (별도 module)
clients/rust/orm/            동일 (sqlx, IndexMap)                     |  clients/rust/gen/ (별도 crate)
clients/php/src/             Query/Model/Collection, __call 파서, Transport(Uds), APCu 캐시 | gen/
schema/                      example import (battle, battle_player, user, company_store, product 등)
tests/conformance/*.json     체인·픽스처·기대 SQL/바인드/결과 (3언어 공통)
tests/codec/*.json           스타일 코덱 벡터 (docker MySQL 산출물)
bench/                       S0 스파이크 + 회귀 게이트
docs/  dsl.md · protocol.md · packaging.md · perf.md · errors.yaml
```

## 스키마 YAML (v1)
```yaml
version: 1
entity: battle
table: battle
primary_key: seq
auto_increment: seq
timestamps: {created: created_ts, updated: updated_ts}
columns:
  seq:            {type: i64, unsigned: true}
  name:           {type: string, len: 191, collation: utf8mb4_unicode_ci}
  description:    {type: text, nullable: true, lazy: true}
  aes_hex_email:  {type: string, style: [aes, hex]}
  gz_extend:      {type: bytes, style: [serialize, gz], lazy: true}
  ip:             {type: inet}
  is_close:       {type: bool, default: 0}
  created_ts:     {type: datetime, precision: 6}
  service_seq:    {type: i64, ref: service.seq}
  user_seq:       {type: i64, ref: user.seq}
  updated_user_seq: {type: i64, ref: user.seq, role: updated, nullable: true}
relations:                       # 임포터가 FK에서 시드, 개발자가 이름을 다듬음 → alias<Name>() + typed 필드
  user:       {kind: one,  right: user_seq,  target: user}
  items:      {kind: many, target: battle_item, right: battle_seq}
  p1:         {kind: one,  target: battle_player, left: p1_battle_player_seq, right: seq}
unique: [[uuid], [game_group_seq, game_group_number]]
indexes: {ik: [service_module_seq, is_close, is_display, is_allday]}
fulltext: [[name, description]]
```
검증(빌드 실패): 컬럼명이 `_and_/_or_/_with_` 포함, 연산자 토큰+`_`로 시작(`eq_ ne_ gt_ ge_ lt_ le_ in_ nin_ lk_ lb_ between_ is_null_ not_null_ fulltext_`), 키워드와 동일(`condition order get new match with and or alias asc desc by`), 예약어(`match type range map` 등)는 렌더러가 `match_` 식으로 개명·경고, `ref` 대상 없음, `serialize` 스타일 쓰기 경고. 허용 확인 픽스처: `order_number`, `get_dt`, `condition_type`, `withdraw_count`, `android_app_url`, `origin_price`, `brand_name`.
임포터: `CURRENT_TIMESTAMP%` 접두 매치, 접두어→style, FK→ref/relations, lazy 규칙, 컬럼 collation, `block_encryption_mode`·`INET6_ATON` 저장 길이(4/16B) 확인, 재실행 시 수동 필드(`lazy`, `role`, `style`, `relations` 이름) 보존.

## 정규 문법 (세 언어 동일 토큰)
렌더 규칙: 토큰 `fooBar` → PHP `fooBar` / Go `FooBar` / Rust `foo_bar`. 머리·중간·터미널 구조는 동일하고, 언어 고정 접사만 다르다.

| 토큰 | PHP | Go | Rust |
|---|---|---|---|
| 머리 `new Entity` | `new Battle` (`(new Battle)($db)` 호환) | `m.NewBattle()` | `Battle::new()` |
| `<col>(v)` = `col = v` | `->isClose(0)` | `.IsClose(0)` | `.is_close(0)` |
| `<op><Col>(v)`, op ∈ `ne gt ge lt le in nin lk lb between isNull notNull fulltext fulltextBoolean` | `->gtCreatedTs($t)`, `->inSeq([..])`, `->isNullEndDt()` | `.GtCreatedTs(t)`, `.InSeq(ids)`, `.IsNullEndDt()` | `.gt_created_ts(t)`, `.in_seq(ids)`, `.is_null_end_dt()` |
| `or<op><Col>(v)` | `->orIsSale(1)` | `.OrIsSale(1)` | `.or_is_sale(1)` |
| `and(f)` / `or(f)` 괄호 그룹 | `->or(fn($q) => $q->…)` | `.Or(func(q *m.Battle) { q.… })` | `.or(\|q\| q.…)` |
| `raw(sql, binds)` / `orRaw` | 동일 | 동일 | 동일 |
| `andJoin(alias)` / `orJoin(alias)` 조인 where 스플라이스 | `->orJoin('ga1')` | `.OrJoin("ga1")` | `.or_join("ga1")` |
| `on(f)` 조인 ON | `->on(fn($q) => $q->side('p1'))` | `.On(func(q *m.BattlePlayer){ q.Side("p1") })` | `.on(\|q\| q.side("p1"))` |
| `match<A>With<B>()` (FK 양방향 생성) · `relation(x)` / `relations(x)` | 동일 | 동일 | 동일 |
| `alias<Name>()` (YAML `relations:` 선언 → typed) · `alias("x")` (조인 전용 자유형) | `->aliasP1()` / `->alias('ga1')` | `.AliasP1()` / `.Alias("ga1")` | `.alias_p1()` / `.alias("ga1")` |
| `keyName<Col>()` `parentNode()` `groupLimit(n)` `possible<Col>(v)` `stripKey()` | 동일 | 동일 | 동일 |
| `join<A>With<B>(x)` / `leftJoin<A>With<B>(x)` (FK쌍·동명 FK 생성) / `join("a","b",x)` 탈출구 | 동일 | 동일 | 동일 |
| `orderBy<Col>[Asc\|Desc]()` `groupBy<Col>()` `limit(o,n)` `forceIndex<Name>()` `distinct()` `orderByRaw(sql)` | 동일 | 동일 | 동일 |
| `addAllColumns() removeAllColumns() addColumn<Col>() removeColumn<Col>() addColumnRaw(alias, fmt, cols)` | 동일 | 동일 | 동일 |
| `set<Col>(v)` `setRaw<Col>(expr, binds)` `plus<Col>(n)` `minus<Col>(n)` | 동일 | 동일 | 동일 |
| `debug()` · `clone` · `sql(db)` | `->debug()`, `clone $q` | `.Debug()`, `q.Clone()` | `.debug()`, `q.clone()` |
| **터미널** `get gets count sum avg create update save delete paginate` — 실행기를 인자로 | `->gets($db)` | `.Gets(ctx, db)` | `.gets(&db).await?` |
| `getBy<PK|unique>(…)` 만 생성 | `->getBySeq($db, $seq)` | `.GetBySeq(ctx, db, seq)` | `.get_by_seq(&db, seq).await?` |
| 트랜잭션 | `$db->transaction(function ($tx) {…})` | `orm.Transaction(ctx, db, func(tx *orm.Tx) (T, error) {…})` | `db.transaction(\|tx\| async move {…}).await?` (`Tx: Clone`) |
| 결과 스칼라 | `$m->getSeq()`, `$m->getName($default)`, `$m['name']` | `m.Seq` / nil-safe `m.GetSeq()` | `m.seq` (nullable은 `Option`) |
| 결과 관계 | `$m->getUser()`→null, `$m->getItems([])` | `m.GetUser()`→nil, `m.GetUser()`→빈 컬렉션 | `m.user() -> Option<&User>`, `m.user() -> &Items` |
| 컬렉션(PK/keyName 순서 맵) | `foreach ($c as $seq => $m)`, `->first()`, `->count()`, `->toArray()` | `for k, m := range c.All()`, `c.First()`, `c.Len()`, `c.ToArray()` | `for (k, m) in &c`, `c.first()`, `c.len()`, `c.to_vec()` |

규칙: `get`→null/nil/None, `gets`→빈 컬렉션(절대 null 아님); 에러/throw = rollback(compatibility의 "falsy 반환=rollback"은 폐기, 문서화); 무인자 `getX()`는 존재하는 키(null 포함)와 선언된 컬럼은 값/null 반환, 미선언 키만 throw; `getX($d)`는 누락·null·`''`에 `$d`. Go `GetX()`는 protobuf-go 관례의 nil-safe 체인. Rust 쿼리 메서드는 by-value, setter는 `&mut self`; 컬렉션 키는 `orm.Key`(int|string).
PHP `__call` 호환층(패리티 덤프에는 미포함): `condition*/and*/on*` 접두어, `and('(')`/`condition(')')` 토큰, `->{'condition(AAndB)Or(C)'}` 괄호문법, `getsByAAndB` 복합, 배열→IN·null→IS NULL 암묵, `$model($db)` 재바인딩, `fetchValue`/`column(cb)` 후처리 훅.
PHP 파서: camel 경계 토큰화 → 선두 키워드 전체토큰 최장일치 → 술어 `[Op] Column (And|Or [Op] Column)*`에서 Column은 엔티티 컬럼표와 최장일치(YAML 규칙으로 유일성 보장) → `match/join/relation`의 `With` 양쪽을 각 엔티티 컬럼표로 해석. 파싱 결과는 생성된 정적 배열(opcache 공유)로 사전 계산, 동적 이름만 런타임 파싱.

### 시나리오 예 (PHP / Go / Rust 줄 단위 대응 — R9: 조인 + 괄호 OR fulltext)
```php
$products = (new Product)
    ->relation((new ProductLang)->matchSeqWithProductSeq()->langId($langId)->aliasLang())
    ->leftJoinProductBrandSeqWithSeq((new ProductBrand)->alias('ga2')->fulltextBooleanNameWithDescription($kw))
    ->serviceSeq($serviceSeq)->isClose(0)
    ->and(fn($q) => $q->fulltextBooleanNameWithShortDescriptionWithContent($kw)->orJoin('ga2'))
    ->groupBySeq()->limit(0, 100)
    ->gets($slave1);
```
```go
products, err := m.NewProduct().
    Relation(m.NewProductLang().MatchSeqWithProductSeq().LangId(langId).AliasLang()).
    LeftJoinProductBrandSeqWithSeq(m.NewProductBrand().Alias("ga2").FulltextBooleanNameWithDescription(kw)).
    ServiceSeq(serviceSeq).IsClose(0).
    And(func(q *m.Product) { q.FulltextBooleanNameWithShortDescriptionWithContent(kw).OrJoin("ga2") }).
    GroupBySeq().Limit(0, 100).
    Gets(ctx, slave1)
```
```rust
let products = Product::new()
    .relation(ProductLang::new().match_seq_with_product_seq().lang_id(lang_id).alias_lang())
    .left_join_product_brand_seq_with_seq(ProductBrand::new().alias("ga2").fulltext_boolean_name_with_description(kw))
    .service_seq(service_seq).is_close(0)
    .and(|q| q.fulltext_boolean_name_with_short_description_with_content(kw).or_join("ga2"))
    .group_by_seq().limit(0, 100)
    .gets(&slave1).await?;
```

## 프로토콜 (JSON IR → Plan)
- `Value`: null | bool | i64 | u64 | f64 | string | bytes(b64) | decimal(string) | list. JSON 정수는 문자열 아닌 숫자(i64 범위 내), 초과는 문자열+태그.
- `Predicate { conn: NONE|AND|OR(선행), open, close, op: EQ NE GT GE LT LE IN NIN BETWEEN LK LB IS_NULL NOT_NULL FT FT_BOOL COL_CMP RAW, alias, column, value, lhs_expr, expr_binds{}, ref_alias, ref_column, cmp_op, splice_alias }`.
  괄호 전용 토큰 허용. **WHERE는 하나의 합성 스트림**: `implicit(getBy/relation IN) ++ root.where ++ 스플라이스되지 않은 joins[i].where(선언 순)`. 괄호 균형·연결자 검증은 합성 스트림에서만. 첫 토큰의 conn은 무시, 비선두 `NONE`은 `AND` 삽입, 선두 `OR`는 `CONN_AT_START`. `IN []`은 `EMPTY_IN` 에러. `FT_BOOL` 값 변환(`' '→' +'`, 끝 `*`)은 compatibility 그대로.
- `Query { entity, alias(클라이언트 부여·엔진 유일성 검증), conn(명명 연결), columns{mode: DEFAULT|ALL|ONLY, add[], remove[], computed[{alias, format, columns[]}], raw[]}, where[], order[{column|raw, dir}], group[{column|raw}], limit{offset,count}, group_limit{offset,count}, force_index, distinct, joins[], relations[], key_column, aggregate{kind: COUNT|COUNT_DISTINCT|GROUP_COUNT|SUM|AVG, column}, raw{sql, binds}, debug }`. raw 조각의 alias 참조는 `{self}`/`{alias:x}` 플레이스홀더. `ONLY` = PK + FK + add[].
- `Join { kind: INNER|LEFT, left, right, target_alias, query(on[], where[], columns, relations[]) }`. 응답에서 `alias_col` 접두어로 분리.
- `Relation { kind: ONE|MANY, left, right, alias, key_column, parent_node, strip_right_key, possible{column,value}, conn, query }`.
  규칙: 배치 = 부모 left dedup → `right IN`; MANY는 right로 그룹핑 후 `key_column`으로 재키잉(중복은 last-wins, `key_column`은 projection에 있어야 함); ONE 중복은 **ORDER BY 기준 첫 행**(=`group_limit 1`, compatibility의 get/gets 불일치를 의도적으로 통일); `Relation.query.limit`은 `LIMIT_IN_RELATION` 에러; `group_limit`은 `PARTITION BY right`, 내부·외부 동일 ORDER, `row_num` 제거, 루트에는 `partition_by` 없으면 에러; `parent_node` 병합 = non-null은 덮어씀, null은 빈 키만 채움, PK는 건너뜀, 순서 = ONE → 조인하위 ONE → MANY → 조인하위 MANY; `possible`은 루트 행 기준 strict 비교, 불일치 부모는 null; 조인 하위 relation은 조인별 고유 키로 처리.
- `Mutation { entity, op: CREATE|UPDATE|DELETE, set[{column, value|raw{expr,binds}|plus|minus}], where[], on_duplicate[], optimistic{column,value} }`, `MutationBatch{mutations[]}`(순서 보장, 한 tx). `minus`는 0 하한, `plus/minus` 값은 바인드. `delete(true)`는 클라이언트 트리 워크(`deleteLock` 존중) → Batch. `update(true)` 낙관 락은 `CLIENT_FOUND_ROWS` 필수(드라이버 DSN 설정).
- `Plan { steps[{id, kind: QUERY|EXEC, sql, bind_slots[{PARAM i | STEP{step,column} | LIST_EXPAND}], depends_on, link{kind, parent_column, child_column, parent_node, strip_child_column, possible, row_aligned}}], assemble }`. 실행기 응답 조립 = 평면 테이블 트리 `Result{alias, columns[], rows[][], key_column, link, children{alias→Result}}` → typed 모델(in-process Go는 바로 struct 스캔).
- 헤더: `ir_version`, `schema_hash` → `VERSION_MISMATCH`/`SCHEMA_HASH_MISMATCH`. 에러 코드는 `docs/errors.yaml`에서 3언어 enum 생성(`SchemaInvalid ColumnUnknown OperatorNotAllowed ParenUnbalanced ConnAtStart EmptyIn LimitInRelation VersionMismatch SchemaHashMismatch OptimisticLock Deadlock DuplicateKey`). 드라이버 에러는 원본 유지.
- RAW/`setRaw`/`lhs_expr`/raw order·group은 신뢰 코드 전용(호출자가 이미 DB 자격을 가짐); 바인드만 값 채널; `ormd`는 실행하지 않으므로 신뢰 경계 확장 없음.

## 엔진 (Go)
- `engine/schema`: YAML 로드·검증·컴파일 blob, 연산자 허용표(타입·스타일별), 관계 기본키(left=부모 PK, right=`<parent>_<pk>`), `schema_hash`.
- `engine/ir`: JSON → IR, 합성 WHERE 스트림 검증, alias 유일성.
- `engine/planner`: 단계 그래프(루트 → 조인 포함 SELECT → 관계별 IN 단계 재귀), group_limit 서브쿼리, 조립 명세.
- `engine/dialect`: `Quote Placeholder Like(ci) Upsert InsertReturning Fulltext RowNumber ForceIndex Now StyleExpr(style, read|write)`. MySQL: `HEX(AES_ENCRYPT(?,?))`/`AES_DECRYPT(UNHEX(col),?)`, `INET6_ATON/NTOA` — compatibility와 동일 SQL. `LIKE`는 컬럼 collation으로 ci 결정. PG/SQLite(S6): 호스트측 AES(MySQL 키 폴딩 재현, ECB, PKCS7), `ILIKE`/`LOWER()`.
- `engine/api`: `Compile(ir) → Plan`, `Explain`, `Tokens`. 순수 함수, 무상태, 동시성 안전.
- `engine/ffi`: `orm_compile/orm_free` c-shared(Linux amd64/arm64, macOS). `GOMAXPROCS=1`, 시그널 최소화.
- `cmd/ormd`: length-prefixed JSON 프레임, UDS, 무상태(PHP 전용).

## 실행기 (언어별, 얇게)
- 공통: 플랜 캐시(형태 해시→Plan, 요청 시 채움·만료 타이머 없음, `schema_hash` 변경 시 키가 달라져 자연 무효화), 단계 러너(bind_from·LIST_EXPAND), 결과 트리 조립(ONE/MANY/JOIN 링크, parent_node, possible, strip), 호스트측 코덱(gz=zlib, json, jsons, serialize 읽기, base64; MySQL에선 AES/ip는 SQL), `on_query(sql, binds, duration)` 훅, `debug()` SQL 덤프(바인드 마스킹), 데드락 클로저 재실행(최대 3회), `Page`. 설정은 `orm.toml` 한 파일(연결 DSN·엔진 경로·소켓 경로·스키마 blob 경로 전부 명시).
- Go: `Collection[T]`(슬라이스+인덱스, 순서 유지), in-process 엔진, 행을 typed struct로 직접 스캔.
- Rust: `IndexMap`, sqlx(mysql feature 우선), `Tx: Clone` 핸들, 생성 crate 별도(`--tables`, 모듈=테이블).
- PHP: PDO, `ArrayAccess`+magic getter 모델, `__call` 파서, APCu 플랜 캐시, 영속 UDS 트랜스포트, `Pagination` 호환 `paginate()`.

## ormgen
- `import --dsn … --schema service --out schema/` (멱등, 수동 필드 보존) · `validate --dsn`(라이브 information_schema와 diff, CI 게이트) · `gen --lang php,go,rust [--tables …] [--no-or-prefix]` · `tokens`(정규화된 문장 토큰열 덤프) · `erd --mermaid [--tables --depth]`(YAML `relations/ref` → `erDiagram`, FK 거리 부분 그래프; S5).
- 생성량 추정: 컬럼 5,145 × 타입별 연산자 ≈ 41k 술어 메서드(+`or*` 시 2배) ≈ 테이블당 180–200개. Go는 문제 없음; Rust는 S1(5 테이블)·S2(150 테이블)에서 `cargo check` 시간 측정, 초과 시 `--no-or-prefix`(`->or()->isSale(1)` 연결자 토큰) 및 `--tables`.

## 마일스톤 (1인 + AI, ≈15–16주)
| # | 산출물 | 기간 |
|---|---|---|
| **S0 스파이크** | 손으로 쓴 SQL 2개(PK 단건·100행)를 Go c-shared `orm_compile`로 반환. Go in-process 호출 비용, Rust `libloading` vs wasmtime(컴파일 전용 wasm) 경계 비용, PHP 영속 UDS 왕복 + APCu 히트 경로, 3언어 네이티브 드라이버 기준선. **결정: Rust 경계 방식, PHP 데몬 방식 확정.** 결과는 `docs/perf.md` | 3일 |
| **S1 thin slice** | `ormgen import`(3 테이블), YAML 검증, MySQL dialect(SELECT/INSERT/UPDATE, 전체 술어, order/limit, 괄호 그룹), `Compile→Plan`, 3언어 플랜 캐시·러너, Go/PHP/Rust 생성기+실행기, 터미널 `get gets create save update`, 네이티브 `transaction`, 적합성 벡터 10개 + 토큰열 diff. **데모: 같은 문장 3파일, 같은 JSON 출력, 네이티브 대비 타이밍** | 3.5주 |
| **S2 관계·코덱** | ONE/MANY 단계 그래프, alias/keyName/parentNode/possible/stripKey, 결과 트리 조립, 컬렉션 타입, 코덱(json/jsons/gz/base64/serialize 읽기; MySQL AES·ip는 SQL), `addColumnX/addAllColumns`, 타입별 연산자표, Rust 컴파일 시간 게이트 | 3주 |
| **S3 쓰기 long tail** | dirty 추적, plus/minus/setRaw, `duplication`(upsert), 낙관 락, `delete(true)`→Batch, 데드락 클로저 재실행, `paginate`, `debug/sql`, clone | 1.5주 |
| **S4 조인·엣지 문법** | join/leftJoin/on/다단, 조인 하위 relation, `orJoin` 스플라이스, group_limit, 집계, `Query.raw`, computed 컬럼·`lhs_expr`, PHP `->{'…'}` 호환층, Go/Rust typed 컬럼 상수 탈출구, 충돌 픽스처 | 2.5주 |
| **S5 하드닝·배포** | `validate --dsn`, `schema_hash` 부팅 검사, `errors.yaml`→enum, `on_query` 훅, .so 빌드(linux amd64/arm64, darwin), composer/crates/Go 모듈 패키징, `ormd` systemd 유닛, `erd`, CI(MySQL × 3언어), 벤치 회귀 게이트 | 1.5주 |
| **S6 PostgreSQL·SQLite** | dialect 구현, 호스트측 AES(MySQL 키 폴딩·`block_encryption_mode` 확인), docker 적합성(같은 벡터 × 3 DB), LIKE 의미 고정, `RETURNING`/`ON CONFLICT` | 2.5주 |
| **S7 이후 과제** | protobuf/Connect, FrankenPHP in-process(배포 방식 변경 시), DDL diff/마이그레이션, 멀티테넌시 `scope`, min/max/having, point/yaml/curlfile, 서버 스트리밍 | 이후 |

## 검증
- 단위: dialect 골든(IR→SQL+바인드), 합성 WHERE 검증 케이스(루트 열고 조인에서 닫기, 선두 OR, 빈 IN), PHP 파서 충돌 픽스처, planner 단계 그래프 골든.
- 코덱 벡터: AES/hex/ip는 docker MySQL 산출물과 **바이트 일치**, gz/json은 **라운드트립 일치**(zlib 구현 차이).
- 적합성: `tests/conformance/*.json` — 체인(정규 토큰열)·픽스처·기대 SQL·바인드·결과 JSON. 3언어 하네스가 같은 MySQL에 실행해 정규 JSON 출력 → diff. 시드: R1(4단 관계), R9(조인+괄호 OR fulltext), R10(groupLimit+join+groupBy), E1(6단 괄호), W4(setRaw 카운터), 엣지(빈 IN, null 연산자, ONE 중복, keyName 누락, unsigned 상한, timestamp(6), tinyint→bool, decimal).
- 패리티 린트: `ormgen tokens`가 문장 단위 정규 토큰열(머리·접사 제거)을 3언어 생성물에서 추출해 diff.
- 성능: 3계층 — (0) 엔진 `Compile` ns/op·allocs, (1) 경계 에코(1KB/64KB), (2) e2e: MySQL 로컬 소켓 + 원격 호스트 각각, 워크로드 PK 단건·100행(aes_hex 2컬럼)·4단 관계·INSERT·3문 tx, 동시성 1/16/64, 워밍업 30s, A/B 교차 5회, p50/p99/p99.9·처리량·CPU-time/op·allocs·PHP 워커 RSS/스레드. **캐시 웜(핫패스)과 콜드를 분리 보고**. 게이트: 핫패스 네이티브 대비 처리량 손실 ≤5%·CPU-time ≤+10%(조립 비용), 콜드 형태당 컴파일 ≤1ms(Go) / ≤2ms(Rust 경계) / ≤3ms(PHP UDS). CI에서 회귀 실패.
- 실전: example tables 5개 YAML로 위 시나리오를 3언어로 재현, `Model::$debug` 대응 SQL 덤프가 compatibility 출력과 의미 동일함을 골든으로 확인.
