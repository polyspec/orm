# plan-v2 — plan-v1의 적대 검증(Q1·Q2·Q3) 반영판

> 이전 설계 문서. 현행 구현 기준은 [공통 인터페이스](interfaces.md), [DSL](dsl.md), [프로토콜](protocol.md), [스키마](schema.md)다.

`docs/plan-v1.md`(승인본)를 기준으로, 세 질문에 대한 검증 결과를 반영해 바뀐 것만 적는다. 여기 없는 항목은 v1 그대로다.

> 이 문서는 설계 검토의 변경 기록입니다. 현재 구현 기준은 [docs/usage.md](usage.md),
> [docs/checklist.md](checklist.md), [docs/dialects.md](dialects.md)와 코드입니다.

## 결정 요약

| # | 질문 | 결정 | 근거 한 줄 |
|---|---|---|---|
| 1 | 왜 언어별 실행기인가, 프록시는 왜 버렸나 | ~~Go·Rust = 네이티브, PHP = `ormd` 사이드카가 실행+조립~~ → **S0 실측으로 철회: 세 언어 모두 네이티브 실행기, `ormd`는 컴파일 전용** (`docs/perf.md` §5: ormd 실행 경로가 PDO 대비 PK +69%, 목록 +152%, 4단 관계 +6%) | 행이 범위를 넘는 비용이 홉보다 크고, Go 조립이 PHP 조립보다 빠르지 않았다. 드리프트 위험은 적합성 벡터(키 타입 태그 등)로 잡는다 |
| 2 | join의 addColumn/where 겹침, `'('` 괄호 함정 | **트리 WHERE**: 모델 체인 = 그룹, 조인 체인 = 부모에 AND로 붙는 그룹, 같은 모델 중첩은 `and(f)/or(f)`, 모델 범위는 `cols()` 술어 값(`andPred/orPred`). 괄호 토큰·스플라이스·균형 검증 삭제. 컬럼은 위치 매핑 + alias 네임스페이스 + `addColumn<Col>As(name)` | 무음 실패가 없는 유일한 조합. 시나리오 (a)~(f) 전부 표현 가능 |
| 3 | 더 나은 방식·문법 | 접근은 유지(컴파일러 1 + 네이티브 실행기 + 형태 캐시). 문법: `gtCreatedTs($t)` **유지**, `or<op><Col>` 접두어 **삭제**, 관계는 스키마 선언 기반 `withItems(child)`, `raw()`→`expr()`(스키마 검사 조각), 텍스트 DSL·리터럴 필터·빌드타임 SQL 기각 | 생성량 절감 + 폴백 옵션 제거. 텍스트 DSL은 `if` 분기 조립에서 문자열 결합으로 퇴행 |

## 1. 실행 위치 (Q1) — **S0 실측 후 철회됨. 아래 본문은 검수 당시 안이며, 확정안은 `docs/perf.md` §5·§7 (R3).**

```
Go   앱 ── in-process engine + Go 실행기(database/sql) ──▶ DB        홉 0
Rust 앱 ── engine 범위(S0 확정: libloading .so | wasmtime .wasm) + Rust 실행기(sqlx) ──▶ DB   홉 0
PHP  앱 ── 영속 UDS ──▶ ormd (engine + Go 실행기 + 조립 + 코덱) ──▶ DB    로컬 홉 1
```

- `ormd` = `engine` + **Go 클라이언트와 같은 실행기 코드** + 프레이밍. 새 구현이 아니라 재사용이다.
- PHP 클라이언트 = `__call` 파서(≈400줄) + IR 조립 + 트랜스포트 + 결과 트리→`ArrayAccess` 모델 매핑(≈600줄). PDO·조립·코덱·dirty 추적·데드락 재실행은 PHP에 없다.
- 커넥션 핀 규칙: `tx_begin` 프레임에 스트림↔백엔드 커넥션 핀, `commit/rollback`에 해제, UDS 종료 시 롤백, 열린 tx가 있는 스트림에 새 `request_id`가 오면 롤백 + `TX_LEAK` 에러. PHP `register_shutdown_function`에서 `reset` 프레임 송신(타이머 없음).
- DSN은 `ormd`만 보유. PHP 워커에서 DB 자격 제거(신뢰 범위 축소). PHP의 raw SQL은 `Query.raw`로 `ormd` 경유. 워커 로컬 PDO 금지.
- 와이어: S0에서 JSON vs msgpack(PHP ext) 실측 후 하나 확정.
- 성능 검사 분리: Go/Rust 핫패스 네이티브 대비 처리량 손실 ≤5%·CPU ≤+10%. PHP는 원격 DB 단건 ≤+25%, 100행 ≤+15%, 4단 관계는 **PDO 기준선 이하**(Go 조립 > PHP 조립 가설을 S0에서 검증).
- 뒤집는 조건(문서화): PHP가 FrankenPHP 워커 모드 → in-process 승격. PHP 주력화 또는 S0에서 "PDO+PHP 조립"이 "ormd+디코드"보다 빠르면 PHP 네이티브 실행기로 복귀.
- 공개 API에서 `multi_statement`를 제외한다. MySQL·PostgreSQL·SQLite는 안전한 매개변수 다중 문장 실행 구조를 동일하게 제공할 수 없다.

## 2. WHERE·컬럼 문법 (Q2)

### 규칙
1. 모델 하나의 체인은 하나의 **그룹**. 그룹 안 연결자는 SQL 우선순위(`a AND b OR c` = `(a AND b) OR c`).
2. 조인 체인은 부모 WHERE에 **AND로 붙는 그룹**. 그룹 선두 `or…`는 `OrAtGroupStart` 컴파일 에러. `condition*`는 PHP 호환층에서 `and*` 동의어.
3. `and(f)` / `or(f)`: 같은 엔티티의 `<Entity>Where` 빌더(술어·그룹만 허용, `limit/relation` 불가)를 받는 중첩 그룹. 그룹 선두의 `or(f)`는 선행 연결자 무시.
4. `andPred(p)` / `orPred(p)`: **술어 값**. `$x->cols()`(Go `x.Cols()`, Rust `x.cols()`)가 alias가 박힌 읽기 전용 typed 컬럼 참조를 주고, 그 메서드가 `Pred`를 만든다. `Pred::all([...])`, `Pred::any([...])`, `Pred::not(p)`. **모델 범위를 넘는 유일한 통로.** 참조 alias가 문장에 없으면 `AliasUnknown`.
5. `expr(fragment, binds)`: 백틱 컬럼을 스키마로 검사하고 alias를 치환하는 조각(`expr('DAYOFWEEK(`created_ts`) = ?', [1])`). `raw()`는 삭제, `Query.raw`(루트 통째)만 유지.
6. IR: `where: Group{conn, items:[Pred|Group]}`. `open/close/splice_alias/CONN_AT_START/ParenUnbalanced` 삭제. 균형은 구성상 보장.

### 시나리오 (a) — 키워드를 여러 조인 테이블에서 OR 검색
```php
$ga1 = ProductBrandLang::query()->alias('ga1');   $ga2 = ProductBrand::query()->alias('ga2');   $ga3 = ProductLang::query()->alias('ga3');
$products = Product::query()
    ->withLang(ProductLang::query()->langId($langId))
    ->leftJoin('ga1', Product::productBrandSeq()->cmp(ProductBrandLang::productBrandSeq()), $ga1)
    ->leftJoinBrand($ga2)
    ->leftJoinLang($ga3)
    ->serviceSeq($s)->isClose(0)
    ->and(fn($w) => $w->fulltextBooleanNameWithShortDescriptionWithContent($kw)
        ->orPred($ga1->cols()->fulltextBooleanNameWithDescription($kw))
        ->orPred($ga2->cols()->fulltextBooleanNameWithDescription($kw))
        ->orPred($ga3->cols()->fulltextBooleanNameWithShortDescriptionWithContent($kw)))
    ->groupBySeq()->limit(0, 100)
    ->using($db)->gets();
```
```go
ga1 := m.ProductBrandLang().Alias("ga1");  ga2 := m.ProductBrand().Alias("ga2");  ga3 := m.ProductLang().Alias("ga3")
products, err := m.Product().
    WithLang(m.ProductLang().LangId(langId)).
    LeftJoin("ga1", m.ProductCol.ProductBrandSeq.Cmp(m.ProductBrandLangCol.ProductBrandSeq), ga1).
    LeftJoinBrand(ga2).
    LeftJoinLang(ga3).
    ServiceSeq(s).IsClose(0).
    And(func(w *m.ProductWhere) { w.FulltextBooleanNameWithShortDescriptionWithContent(kw).
        OrPred(ga1.Cols().FulltextBooleanNameWithDescription(kw)).
        OrPred(ga2.Cols().FulltextBooleanNameWithDescription(kw)).
        OrPred(ga3.Cols().FulltextBooleanNameWithShortDescriptionWithContent(kw)) }).
    GroupBySeq().Limit(0, 100).Using(ctx, db).Gets()
```
```rust
let ga1 = product_brand_lang::query().alias("ga1");  let ga2 = product_brand::query().alias("ga2");  let ga3 = product_lang::query().alias("ga3");
let products = product::query()
    .with_lang(product_lang::query().lang_id(lang_id))
    .left_join("ga1", Product::product_brand_seq().cmp(ProductBrandLang::product_brand_seq()), ga1.clone())
    .left_join_brand(ga2.clone())
    .left_join_lang(ga3.clone())
    .service_seq(s).is_close(0)
    .and(|w| w.fulltext_boolean_name_with_short_description_with_content(kw)
        .or_pred(ga1.cols().fulltext_boolean_name_with_description(kw))
        .or_pred(ga2.cols().fulltext_boolean_name_with_description(kw))
        .or_pred(ga3.cols().fulltext_boolean_name_with_short_description_with_content(kw)))
    .group_by_seq().limit(0, 100)
    .using(&db).gets().await?;
```
조인 선언 순서·괄호 위치·스플라이스 누락이 사라진다. 잘못된 alias는 Go/Rust에서 변수 미정의 컴파일 에러.

### 시나리오 (f) — 같은 모델 6단 (Battle/IndexFromGet)
```php
$battles = Battle::query()->addAllColumns()->withItems(BattleItem::query()->orderByOrderNumber())
    ->serviceModuleSeq($smSeq)->isClose(0)
    ->and(fn($w) => $w->isDisplay(1)
        ->or(fn($w) => $w->isDisplay(2)->ltDisplayStartDt($now)->gtDisplayEndDt($now))
        ->or(fn($w) => $w->isDisplay(3)->ltDisplayStartDt($now)))
    ->and(fn($w) => $w->isDisplay(1)
        ->or(fn($w) => $w->isAllday(0)
            ->or(fn($w) => $w->isAllday(1)->and(function ($w) use ($days) {
                foreach ($days as $col => $n) { $w->or(fn($d) => $d->$col(1)->expr('DAYOFWEEK(NOW()) = ?', [$n])); }
            }))))
    ->orderBySeqDesc()->using($db)->paginate($page, 20);
```
이런 재사용 조건은 스키마 `predicates:`로 선언해 `->displayCondition()` 메서드로 생성한다(S4).

### 컬럼 측
- 결과 매핑은 **위치 기반**(`Plan.assemble.columns[] = {alias, column, out_name, index}`). 문자열 접두어 분리 폐기 → alias `product`가 루트 `product_seq`를 훔치는 잠복 버그 소멸.
- 조인 결과는 alias 네임스페이스: PHP `$m->getGa1()->getName()` / `$m['ga1']['name']`, Go `orm.JoinOf[m.ProductBrandLang](m, "ga1").Name`(선언 관계면 `m.Brand.Name`), Rust `m.join::<ProductBrandLang>("ga1").name`(선언 관계면 `m.brand().name`). 루트 이름공간에 섞이는 경로는 `parentNode()`뿐.
- 별칭 토큰 `addColumn<Col>As(name)`: `->addColumnSeqAs('file_name_alias_seq')`. 메서드명 안 `Alias` 파싱 제거. `addColumn<Col>Alias<Name>`은 PHP 호환층만.
- 충돌은 컴파일 에러(`ColumnAliasConflict`): `parentNode()` 병합 컬럼이 루트 컬럼(PK 제외)과 같음, 같은 조인 안 별칭 중복, 두 parentNode 조인 간 중복. 매니페스트 검증에 `__` 금지 추가, 엔진 내부 SELECT 별칭은 `alias__col`.

### PHP 호환층
- 모델 안에서 균형 잡힌 `and('(')/or('(')/condition('(')…condition(')')`, `->{'condition(AAndB)Or(C)'}`는 파싱 시 스택으로 트리화(루트 중첩 301/271, 조인 자체 34/3 → 사실상 전부).
- 모델 범위를 넘는 괄호(조인에서 닫힘 ≈31건, 조인 첫 술어 `or*` 26건)는 `ParenAcrossModels` 에러 + `orPred($alias->cols()->…)` 재작성 힌트. `ormgen check --lang php`가 목록을 출력.

## 3. 문법 결정 (Q3)

- **유지**: `query()`, `<col>(v)`(`=`), `<op><Col>(v)`(`ne gt ge lt le in nin lk lb between isNull notNull fulltext… fulltextBoolean…`), `getBy<PK|unique>`, `getsBy<Col>`, `getCountBy<Col>`, `set*/setRaw*/plus*/minus*`, `keyName<Col>() parentNode() groupLimit(n) possible<Col>(v) stripKey()`, 정렬·그룹·limit·컬럼 선택, 터미널·트랜잭션·결과 접근·컬렉션 규칙(v1 표).
- **삭제**: `or<op><Col>` 접두어 생성(OR은 `or(f)`·`orPred`), `--no-or-prefix` 옵션, `orJoin/andJoin`, `raw()/orRaw`, `relation()/relations()`, `match<A>With<B>()`, `alias<Name>()`(정규 문법에서; PHP 호환층은 유지), `join<A>With<B>` FK쌍 생성.
- **추가**:
  - `with<Rel>(child)` — 스키마 `relations:` 선언 관계 부착. kind(one/many)·left/right는 스키마가 확인한다.
  - `join<Rel>(child)` / `leftJoin<Rel>(child)` — 선언 관계 조인. `child.on(f)`가 ON. 미선언 조인은 스키마에 선언하거나(권장) `join(alias, Col.cmp(Col), child)` 탈출구.
  - 컬럼 객체 `Entity::col()` / `m.EntityCol.Col` / `Entity::col()` → `Col<T>`: `cmp(Col)`(컬럼 비교), `fn("ST_Y(%s)")`(lhs 식) → `Pred`. `<op><Col>` 메서드는 이 객체 위의 설탕이라 IR은 하나.
  - `expr(fragment, binds)`, `Pred::all/any/not`, `andPred/orPred`, `cols()`.
  - 스키마 `predicates:` — 이름 붙인 재사용 술어 그룹 → `<name>()` 메서드 생성 (S4).
- 생성량: 컬럼당 `<col>` + 타입별 `<op><Col>`(평균 ≈8) + 컬럼 객체 ≈ 5,145×10 ≈ 51k → `or` 접두어 제거로 v1의 82k 대비 40%. 관계당 3(`with/join/leftJoin`). Rust는 S2에서 150테이블 `cargo check` 측정, 대응은 `--tables` 분할만.
- `ormgen check --lang php,go`: PHP 레거시 이름·`expr` 백틱 컬럼·`ParenAcrossModels`를 스키마 대조(PHP의 타입 검사 역할). Rust는 컴파일러. S5 CI 검사.
- 기각 이유 기록: 텍스트 DSL(if 분기 조립에서 문자열 결합 퇴행, IDE/타입 상실, PHP 오타가 런타임 에러), 구조체/맵 리터럴(Go/Rust `Option/Default` 범벅, 술어 순서 비결정), 빌드타임 SQL 생성(분기 조합 폭발 → 린트로만), E′ 전면 컬럼 객체(생성량 절감보다 문법 손실이 큼).

## 4. 프로토콜 변경점
- `Predicate` 토큰 스트림 → `Group{conn, items:[Pred|Group]}` 트리. `Pred = {alias, column, op, value | cmp{alias, column} | fn{format} | expr{fragment, binds}}`.
- `Join.query.where`는 그 조인의 그룹(부모에 AND). `Relation.query.where`는 관계 배치 쿼리의 그룹.
- `Plan.assemble.columns[]` 위치 매핑. 에러 추가: `OrAtGroupStart AliasUnknown ColumnAliasConflict ParenAcrossModels(PHP) TxLeak EntityNotJoined`. 삭제: `ParenUnbalanced ConnAtStart`.
- `ormd` 프레임: `request_id`, `tx_begin/commit/rollback/reset`, `query/mutation/batch`. 응답 결과 트리에 **키 타입 태그** 포함.

## 5. 검증 변경점
- 적합성 정규 JSON: 키 타입 태그(`{"k":123,"t":"i"}`), 순서-민감 비교, `possible` 정수 픽스처, `json` 빈 객체 픽스처, PHP `serialize` 참조·객체·float 픽스처. PHP 하네스는 레거시 표기 벡터를 한 번 더 실행.
- 데드락은 벡터가 아니라 3언어 공통 동시성 테스트(2 tx 교차 갱신)로 별도 검사.
- S0 항목 추가: PHP 3경로 실측 — (i) PDO+PHP 조립(비교 기준), (ii) `ormd`+JSON, (iii) `ormd`+msgpack — 단건·100행·4단 관계, 로컬/원격.

## 6. 마일스톤 조정
- S0(3일): Rust 범위 확정, PHP 와이어 확정, PHP 3경로 수치.
- S1: PHP 측은 클라이언트(파서·매핑·트랜스포트) + `ormd`(엔진 + Go 실행기 재사용 + 프레이밍 + 커넥션 핀). Go 실행기가 먼저 완성되어야 하므로 순서 Go → ormd/PHP → Rust.
- S2: `with<Rel>`, 결과 트리 위치 매핑, 컬럼 객체·`Pred`.
- S4: `join<Rel>`·`join(alias, cmp, child)`, `cols()`·`orPred`, `expr`, 스키마 `predicates:`, `ormgen check --lang php` 목록. 공개 API에서 `multi_statement`를 제외한다.
- 총 기간 변화 없음(≈15–16주). PHP 조립·코덱·데드락 구현이 빠진 만큼 `ormd` 커넥션 핀·프레이밍이 들어온다.

## 7. v1에서 그대로 유지
컴파일러 전용 엔진, 형태 해시 플랜 캐시(Go/Rust 프로세스 내, PHP 제한된 process-local cache), Mermaid 스키마·`import/validate`·`schema_hash`, Relation 의미론(배치 IN, keyName 재키잉, parentNode 병합 순서, ONE 첫 행, groupLimit 파티션, possible strict), MutationBatch·낙관 락·`CLIENT_FOUND_ROWS`, 결과 접근·컬렉션 규칙, 에러 enum 생성, 코덱 벡터, 설계 원칙 3개, S0 스파이크 골격, `--tables`.
