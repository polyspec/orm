# dsl.md — 정규 문법 v3 (확정)

이 문서가 문법의 단일 기준이다. 설계 기준 6가지와 각 결정의 대응:

| 기준 | 결정 |
|---|---|
| 명시적 | 모든 술어에 연산자가 붙는다(`isCloseEq(0)`). 관계(`relation`/`relations`, 1:1·1:N이 이름에 보임)와 조인(`join`/`leftJoin`)은 다른 단어. 조인 조건은 `on(fn)`/`where(fn)`으로 자리를 말한다. 실행은 `one/all/count/insert`처럼 하는 일을 말하는 터미널이 DB를 인자로 받는다 |
| 직관적 | SQL 단어를 그대로 쓴다: `select*`, `where`(=술어), `and/or`, `join/leftJoin/on`, `orderBy`, `limit`, `groupBy`. 관계 옵션도 뜻으로 이름 짓는다(`flatten`, `limitPerParent`, `keyBy`) |
| 누구나 읽기 | 세 언어가 같은 토큰열. 약어 없음(`lk`→`Like`, `ge`→`Gte`, `nin`→`NotIn`) |
| 논리적 | 세 가지뿐: 술어 `<col><Op>(v)`, 연결자 `or()`, 괄호 `and(fn)/or(fn)`. 다른 테이블은 관계 이름으로 내려감. 예외 없음 |
| 유연 | 그룹 무한 중첩, 관계 무한 중첩, 관계 안의 조인, 조인 안의 조인, `expr` 조각, `selectExpr`, `orderByExpr` |
| IDE 힌팅 | 컬럼 먼저·연산자 뒤: `endDt` 입력 → 그 컬럼에 허용된 연산자만 완성. 클로저는 타입이 정해진 `<X>Where`를 받는다. 관계 탐색도 생성 메서드 |

렌더 규칙: 토큰 `fooBar` → PHP `fooBar` / Go `FooBar` / Rust `foo_bar`. 언어별 접사는 머리(`new X` / `m.NewX()` / `X::new()`), 클로저 머리, 터미널 인자(`($db)` / `(ctx, db)` / `(&db).await?`)뿐이다.

## 1. 구조

```
new X                                   ← 쿼리(행 아님)
    .select…                            ← 컬럼 (선택)
    .join<Rel>(new Y .on(fn) .where(fn)) ← 같은 SELECT에 합침. ON과 WHERE를 자리로 명시
    .<col><Op>(v) …                     ← WHERE (최상위 그룹, 기본 AND)
    .or()                               ← 다음 항목을 OR로
    .and(fn) / .or(fn)                  ← 괄호 그룹
    .relation<Rel>(new Y …)             ← 별도 IN 쿼리로 가져와 행 부착 (1:1)
    .relations<Rel>(new Y …)            ← 별도 IN 쿼리로 가져와 키 맵 부착 (1:N)
    .orderBy<Col>Asc/Desc() .limit(o,n)
    .one(db) / .all(db) / .count(db) / .paginate(db, page, per)
```
행(row)은 결과 타입 `X`: getter, `set*`, `update/delete/save`. 쿼리와 행은 다른 타입이라 IDE가 헷갈리지 않는다.

## 2. 토큰

### 2.1 술어 `<col><Op>(v)` — WHERE
| Op | SQL | 예 |
|---|---|---|
| `Eq` `NotEq` | `= !=` | `isCloseEq(0)` `statusNotEq('x')` |
| `Gt` `Gte` `Lt` `Lte` | `> >= < <=` | `endDtGt($now)` |
| `In` `NotIn` | `IN` / `NOT IN` (빈 리스트 = 컴파일 에러 `EMPTY_IN`). 값 개수는 2의 거듭제곱으로 패딩된다(마지막 값 반복) — 결과는 같고, 목록 길이마다 새 prepared statement가 생기지 않는다(`docs/protocol.md`) | `seqIn([1,2,3])` → 바인드 4개 |
| `Like` `LikeBinary` | `LIKE ?` — 패턴은 호출자가 준다(`%`를 자동으로 감싸지 않음) | `nameLike("%$kw%")` |
| `Contains` `StartsWith` `EndsWith` | `LIKE %v%` / `v%` / `%v` — `%`·`_` 이스케이프 | `nameContains($kw)` |
| `Between` | `BETWEEN ? AND ?` | `createdTsBetween($from, $to)` |
| `IsNull` `IsNotNull` | | `endDtIsNull()` |
| `<A>With<B>Match` `<A>With<B>MatchBoolean` | FULLTEXT — YAML `fulltext:` 인덱스 컬럼 조합에만 생성 | `nameWithDescriptionMatchBoolean($kw)` |
| `<col>EqCol(ref)` `<col>NotEqCol(ref)` `GtCol` `GteCol` `LtCol` `LteCol` | 컬럼 대 컬럼 비교. `ref`는 생성된 컬럼 참조 — PHP `ProductCols::langId()` / Go `gen.ProductCols.LangId` / Rust `product::cols::lang_id()`. 경로 없는 참조 = 조인 자식의 `on/where` 안에서는 **부모**, 루트에서는 루트. 다른 조인 엔티티는 `->at('service')` / `.At("service")` / `.at("service")` | `langIdEqCol(ProductCols::langId())` |
| `expr(fragment, binds)` | 스키마 검사 조각. 백틱 컬럼은 현재 엔티티로 해석·alias 치환 | `expr('DAYOFWEEK(`created_ts`) = ?', [1])` |
| `<name>(args…)` 이름 붙인 술어 | Mermaid `%% predicate battle visible : `is_close` = 0 AND `is_display` = 1` → `visible()`; `?`마다 인자 하나(`startedAfter($dt)`) | `visible()` |

연속된 술어는 AND(`or()`로 바꿈: `->isCloseEq(0)->or()->isDisplayEq(1)` = `is_close = 0 OR is_display = 1`, 우선순위는 SQL 그대로). 타입별 허용표: 숫자·날짜 = 비교·In·Between·Null, 문자열 = Eq·NotEq·In·Like·Contains·Null, bool = Eq·NotEq·Null, json/bytes = Null만.

### 2.2 그룹·탐색 — `<X>Where` 안에서
| 토큰 | 의미 |
|---|---|
| `or()` | 연결자 토큰. **다음 항목 하나**(술어 또는 그룹)를 앞 형제와 OR로 잇는다. 기본은 AND. 그룹의 첫 항목 앞에 오면 `OR_AT_GROUP_START`, 연속 두 번이면 `DANGLING_CONNECTOR` |
| `and(fn)` / `or(fn)` | 괄호 그룹. `and/or`는 앞 형제와의 연결자(`or(fn)` = `or()->and(fn)`). 그룹의 첫 항목이 `or(fn)`이면 `OR_AT_GROUP_START` |
| `<rel>(fn)` | **조인된** 관계 `<rel>`의 `<Y>Where`로 내려간다. 조인되지 않았으면 `ENTITY_NOT_JOINED` |
| 다단 탐색 | `campaign(fn($c) => $c->service(fn($s) => …))` — 조인 안의 조인도 관계 이름으로 계속 내려간다 |

쿼리 최상위에서 쓰는 술어·`and/or`·탐색은 곧 WHERE 최상위 그룹이다(같은 토큰). **`on(fn)`·`where(fn)` 안도 같은 Where 빌더**이므로 OR·괄호·탐색 규칙이 그대로 적용된다. 컬럼 대 컬럼 비교는 생성된 참조로 쓴다: `$c->langIdEqCol(ProductCols::langId())` — 경로 없는 참조는 부모(조인을 건 쪽) 컬럼이다.

### 2.3 컬럼 — SELECT
| 토큰 | 의미 |
|---|---|
| (기본) | YAML `lazy: true`가 아닌 컬럼 전부 |
| `selectAll()` | lazy 포함 전부 |
| `selectNone()` | PK + FK만 |
| `select<Col>()` `unselect<Col>()` | 추가 / 제외 |
| `select<Col>As(name)` | 별칭 (`selectSeqAs('file_name_alias_seq')`) |
| `selectExpr(name, fragment)` | 계산 컬럼 (`selectExpr('lat', 'ST_Y(`location`)')`) |

### 2.4 관계·조인
| 토큰 | 의미 |
|---|---|
| `relation<Rel>(new Y …)` | 1:1 관계(YAML `kind: one`에만 생성). 부모 결과의 키를 모아 `IN` 1회로 자식을 가져와 행으로 부착 |
| `relations<Rel>(new Y …)` | 1:N 관계(`kind: many`에만 생성). 같은 방식으로 가져와 키 맵으로 부착. 카디널리티가 이름에 드러나고, kind가 맞지 않는 이름은 존재하지 않아 컴파일 에러 |
| `join<Rel>(new Y …)` `leftJoin<Rel>(new Y …)` | 선언 관계를 같은 SELECT에 조인. 조인 자식에서 조건 자리는 **반드시 명시**: `on(fn)` = ON, `where(fn)` = 부모 WHERE에 AND 그룹. 조인 자식 체인의 맨 술어는 컴파일 에러 `JOIN_PREDICATE_PLACEMENT`(LEFT JOIN을 INNER로 바꾸는 함정 방지). 자식 안의 `join<Rel>`은 다단 조인. 결과는 `$r->getService()`으로 관계와 같은 모양 |
| (자유 alias 조인 없음) | 같은 테이블 두 번이면 관계를 둘 선언(`p1`, `p2`), 동명 FK도 YAML 한 줄. 미선언 조인은 컴파일 에러 |
| 자식에 붙이는 옵션 | `keyBy<Col>()` 키 컬럼 · `keyByFn(fn)` 클라이언트 재키잉 · `flatten()` 자식 컬럼을 부모 행에 병합 · `limitPerParent(n)` 부모당 n행 · `ifParent<Col>Eq(v)` 부모 행 조건부 로딩 · `dropChildKey()` 자식의 FK 컬럼 제거 · `noCascadeDelete()` `delete(cascade)` 정지점 |

### 2.5 정렬·범위·기타
`orderBy<Col>Asc()` `orderBy<Col>Desc()` `orderByExpr(fragment)` `groupBy<Col>()` `limit(offset, count)` `distinct()` `forceIndex<Name>()` `debug()` `sql()` `clone`

### 2.6 실행 (터미널) — DB를 인자로
| 토큰 | 결과 |
|---|---|
| `one(db)` | 행 또는 null/nil/None |
| `all(db)` | 컬렉션(PK 또는 `keyBy` 키 순서 맵). 절대 null 아님 |
| `count(db)` `countDistinct<Col>(db)` `sum<Col>(db)` `avg<Col>(db)` `min<Col>(db)` `max<Col>(db)` | 스칼라. `groupBy<Col>()`가 있는 `count`는 **그룹 수** |
| `having(fn)` | `groupBy` 뒤 그룹 술어. where와 같은 빌더; 집계식은 `expr('COUNT(*) > ?', [n])` |
| `raw(sql, binds)` → `rawAll(db)` | 손으로 쓴 SELECT를 루트로 실행(신뢰 코드 전용). `{table}`은 엔티티 테이블, `?`는 binds 순서. 행은 컬럼명 맵으로 돌아온다(typed 아님) |
| `paginate(db, page, per)` | `Page{items, total, pages, current}` |
| `oneBy<PK|Unique>(db, …)` | PK·유니크 인덱스 단축 |
| `insert(db)` (쿼리에 `set*` 채운 뒤) | 삽입된 행 |

### 2.7 행
| | PHP | Go | Rust |
|---|---|---|---|
| 스칼라 | `$r->getName()` `$r->getName($default)` `$r['name']` | `r.Name` / nil-safe `r.GetName()` | `r.name` (nullable은 `Option`) |
| 관계·조인 | `$r->getService()` → 행/null, `$r->getUser()` → 컬렉션 | `r.GetService()` / `r.GetUser()` | `r.service() -> Option<&T>` / `r.user() -> &Collection<T>` |
| 변경 | `$r->setName('x')->update($db)` `->updateOptimistic($db)` `->delete($db)` | `r.SetName("x"); r.Update(ctx, db)` `r.UpdateOptimistic(ctx, db)` `r.Delete(ctx, db)` | `r.set_name("x"); r.update(&db).await?` `r.update_optimistic(&db).await?` `r.delete(&db).await?` |
| 컬렉션 | `foreach ($c as $k => $r)` `first()` `count()` `toArray()` | `for k, r := range c.All()` `First()` `Len()` `ToArray()` | `for (k, r) in &c` `first()` `len()` `to_vec()` |
| 트랜잭션 | `$db->transaction(fn($tx) => …)` | `orm.Transaction(ctx, db, func(tx *orm.Tx) (T, error) {…})` | `db.transaction(\|tx\| async move {…}).await?` |

에러/throw = rollback. 데드락은 클로저 재실행(최대 3회).

## 3. Predicate and join example

Use the canonical builder chain for predicates, groups, and join conditions.

## 4. Relations and per-parent limits

Use declared relations for separate child queries and per-parent limits.

## 5. 예 3 — 쓰기·트랜잭션
```php
$battle = $master->transaction(function ($tx) use ($data, $serviceSeq) {
    $game = (new Game)
        ->setIsClose($data['is_close'] ?? 0)
        ->setStartDt($data['start_dt'])
        ->setServiceSeq($serviceSeq)
        ->insert($tx);
    return (new Battle)
        ->setGameSeq($game->getSeq())
        ->setName($data['name'])
        ->setServiceSeq($serviceSeq)
        ->insert($tx);
});
$battle->setName('renamed')->update($master);
$battle->delete($master, cascade: true);
```
```go
battle, err := orm.Transaction(ctx, master, func(tx *orm.Tx) (*m.Battle, error) {
    game, err := m.NewGame().
        SetIsClose(data.IsClose).
        SetStartDt(data.StartDt).
        SetServiceSeq(serviceSeq).
        Insert(ctx, tx)
    if err != nil { return nil, err }
    return m.NewBattle().
        SetGameSeq(game.Seq).
        SetName(data.Name).
        SetServiceSeq(serviceSeq).
        Insert(ctx, tx)
})
battle.SetName("renamed").Update(ctx, master)
battle.Delete(ctx, master, orm.Cascade)
```
```rust
let battle = master.transaction(|tx| async move {
    let game = Game::new()
        .set_is_close(data.is_close)
        .set_start_dt(&data.start_dt)
        .set_service_seq(service_seq)
        .insert(&tx).await?;
    Battle::new()
        .set_game_seq(game.seq)
        .set_name(&data.name)
        .set_service_seq(service_seq)
        .insert(&tx).await
}).await?;
battle.set_name("renamed").update(&master).await?;
battle.delete(&master, Cascade::Yes).await?;
```

## 6. PHP 호환층 (정규 문법 아님, `__call` 전용)
compatibility 표기를 같은 IR로 번역한다: `andX/orX/conditionX`(`orX` = `or()->xEq`), op-first(`gtEndDt`), 무접두 `x(v)`, 배열→In, null→IsNull, `relation((new Y)->matchAWithB()->aliasR())`→`relationR`/`relationsR`, `joinAWithB`, `addColumnX`/`addAllColumns`, `parentNode`→`flatten`, `groupLimit`→`limitPerParent`, `keyNameX`→`keyByX`, `fetchKey`→`keyByFn`, `deleteLock`→`noCascadeDelete`, `get/gets`→`one/all`, `getsByAAndB`, `and('(')…condition(')')`(모델 내 균형만; 경계 초과는 `PAREN_ACROSS_MODELS`). `ormgen check --lang php`가 사용처를 목록으로 낸다.

## PHP 호환층
`clients/php/src/Compat.php`(`CompatQuery`·`CompatWhere` 트레이트)가 생성된 쿼리·Where 클래스의 `__call`로 붙는다. 생성 메서드가 없는 이름만 여기로 오며, 호출 시점에 이름을 디코드해 **정규 메서드와 같은 Q/W 원시 호출**로 바꾼다 — 그래서 호환 체인과 정규 체인은 `Req::shape()` 바이트가 같다(`clients/php/tests/compat.php`, 50쌍). 디코드 결과는 (클래스, 메서드명)당 한 번 static 배열에 메모된다(opcache 친화, 요청마다 파싱 없음).

이름 해석: camel 토큰(`IsClose` → `Is`,`Close`)을 엔티티의 `columns()` 표에서 **최장 일치**로 컬럼에 맞춘다. 이름 안의 `And`/`Or`는 연결자, 괄호는 그룹. 모르는 컬럼 → `COLUMN_UNKNOWN`(후보 컬럼 목록 포함); op 단어로도 컬럼으로도 읽히면(`InStock` = 컬럼 `in_stock` 또는 `In`+`stock`) → `COLUMN_UNKNOWN`(두 해석 명시). 값은 그대로 바인드된다(`andIsClose(0)`은 `isCloseEq(false)`와 같은 SQL·결과, 파라미터 타입만 다르다).

### 번역표
| compatibility | 정규 | 비고 |
|---|---|---|
| `andX(v)` `conditionX(v)` `whereX(v)` | `xEq(v)` | 배열 → `xIn(v)`, `null` → `xIsNull()` |
| `orX(v)` | `or()->xEq(v)` | |
| `andXAndY(a, b)` `orXOrY(a, b)` `conditionXAnd(YOrZ)(a, b, c)` | `xEq(a)->yEq(b)` / `->or()` / `->and(fn)` | 이름의 `And`/`Or`가 연결자, 이름의 괄호가 그룹. 인자 수는 술어 수와 같아야 한다(`IR_INVALID`) |
| op-first `GtX LtX GeX LeX EqX NeX` | `xGt xLt xGte xLte xEq xNotEq` | `NeX(null)` → `xIsNotNull()`, `NeX([…])` → `xNotIn([…])` |
| `LkX(v)` `LbX(v)` | `xLike('%v%')` `xLikeBinary('%v%')` | compatibility처럼 `%`를 감싸고 이스케이프하지 않는다(`Contains`가 아님) |
| `InX([…])` `NinX/NotInX([…])` `BetweenX([lo, hi])` `IsNullX()` `NotNullX()/IsNotNullX()` | `xIn xNotIn xBetween(lo, hi) xIsNull xIsNotNull` | `IsNull/NotNull`은 인자를 소비하지 않는다 |
| `FulltextAWithB(v)` `FulltextBooleanAWithB(v)` | `aWithBMatch(v)` `aWithBMatchBoolean(v)` | 불리언 `+word*` 변형은 실행기가 정규 경로에서 이미 적용 |
| `and('(')` `or('(')` `condition('(')` … `condition(')')`, `->{'and('}()` `->{'condition)'}()` | `and(fn)` / `or(fn)` 그룹 | 같은 모델 체인 안에서 균형. 조인·관계 자식이 부모의 `(`를 닫거나, 열어둔 채 붙거나, 터미널까지 안 닫히면 `PAREN_ACROSS_MODELS`(두 모델 이름과 고칠 위치를 메시지에 적는다) |
| `->{'condition(AAndB)Or(C)'}(a, b, c)` `->{'or(IsSale)'}(1)` `->{'getsByAAnd((BAndC)Or(D))'}($db, …)` | 위와 같은 그룹 | brace-call 형 |
| `and()` / `or()` / `or(fn)` | 없음 / `or()` / `or()->and(fn)` | |
| `and('sql …', [':k' => v])` `or(…)` `condition('sql …', binds)` | `expr('sql … ?', [v])` | 공백이 있는 문자열 = 조각. 이름 바인드 `:k`는 등장 순으로 `?`가 된다 |
| `and('Name', v)` `and('snake_name', v)` | `nameEq(v)` | compatibility `and($key, $value)` |
| 조인 자식의 `onX(v)` `onXOrY(a, b)` | `on(fn($w) => $w->xEq(v)…)` | ON 절 |
| 조인 자식의 `andX(v)` | `where(fn($w) => $w->xEq(v))` | compatibility가 부모 WHERE에 AND로 붙이던 자리 |
| `relation((new Y)->matchAWithB()->aliasR())` `relations(…)` `oneToOne/oneToMany` `relationAWithB(new Y)` `match('a', 'b')` `alias('r')` | `relationR(new Y)` / `relationsR(new Y)` | 부모.A = Y.B 쌍과 대상 엔티티로 매니페스트 관계를 찾는다. 쌍이 없거나(`RELATION_UNKNOWN`), 여러 관계가 맞으면 `alias<Name>`이 고른다(없으면 `RELATION_UNKNOWN`). `relation`인데 1:N이면 `RELATION_UNKNOWN`("relations를 쓰라"). match 없음 = compatibility 기본쌍(자식 PK, `<자식>_<pk>`) |
| `matchAWithB(false)` | `dropChildKey()` | 자식 컬럼 B가 자식 PK가 아닐 때(compatibility와 동일) |
| `matchAllAWithB()` | `selectAll()` + 관계 | |
| `joinAWithB(new Y)` `leftJoinAWithB(new Y)` | `joinR(new Y)` `leftJoinR(new Y)` | 쌍은 이름에서, alias는 후보가 여럿일 때 |
| `addColumnX()` `addColumn('x')` `addColumns([…])` | `selectX()` | |
| `addColumnXAliasY()` `addColumn('x', 'y')` | `selectXAs('y')` | |
| `addColumnXAliasY('fmt(%s)')` `addColumn('x', 'y', fmt)` | `selectExpr('y', 'fmt(`x`)')` | `%s` 자리에 백틱 컬럼 |
| `addRawColumnX(sql)` | `selectExpr('x', sql)` | |
| `addAllColumns()` `removeAllColumns()` `onlyColumns([…])` | `selectAll()` `selectNone()` `selectNone()->select…()` | |
| `removeColumnX()` `removeColumn('x')` `removeColumns([…])` | `unselectX()` | |
| `orderByX()` `orderByXAndYDesc()` `orderByXDesc('fmt %s')` `orderBy('sql')` | `orderByXAsc()` `orderByXAsc()->orderByYDesc()` `orderByExpr('fmt `x`', true)` `orderByExpr('sql')` | `orderByXAsc/Desc`는 이미 정규 |
| `groupByXAndY()` | `groupByX()->groupByY()` | |
| `forceIndex('name')` | `forceIndex<Name>()` | |
| `keyNameX()` `keyName('x')` | `relations` 자식: attach 시 `keyByX()` · 루트: 터미널에서 `keyByFn(fn($r) => $r['x'])` · `relation`(1:1) 자식: 무시 | compatibility와 같은 자리 규칙. attach 시 적용이라 정규 체인은 `keyByX()`를 자식 체인 끝에 둔다(`dropChildKey()`는 그 뒤) |
| `keyName(fn)` `fetchKey(fn)` | `keyByFn(fn)` | 루트 컬렉션 전용(정규 PHP도 같음) |
| `parentNode()` `groupLimit(n)` `possibleX(v)` `deleteLock()` | `flatten()` `limitPerParent(n)` `ifParentXEq(v)` `noCascadeDelete()` | `deleteLock(false)`는 없음 |
| `get($db)` `gets($db)` | `one($db)` / `all($db)` | `gets`는 결과가 없으면 **null**(compatibility). DB는 첫 인자(`IR_INVALID`) |
| `getAll($db)` `getsAll($db)` | `selectAll()->one/all($db)` | |
| `getByX($db, v)` `getsByXAndY($db, a, b)` `getAllByX` `getsAllByX` | 술어 + `one/all($db)` | 술어는 호출 순서대로 붙는다(`->andA()->getsByB()` = `aEq()->bEq()`) |
| `getCount($db)` `getsCount($db)` `getCountByX($db, v)` | `count($db)` | |
| `getSumX($db)` `getAvgX($db)` | `sumX($db)` `avgX($db)` | |
| `create($db)` | `insert($db)` | |
| `duplication((new X)->setA(v)->plusB(n)->setCExpr(f, b))` `duplication(['a' => v])` | `onDuplicateSetA(v)->onDuplicatePlusB(n)->onDuplicateSetCExpr(f, b)` | 모델의 set/plus/minus/expr 순서 그대로 |
| `setRawX('f(:a, :b)', [':a' => 1, ':b' => 2])` | `setXExpr('f(?, ?)', [1, 2])` | |
| `plusX(n)` `minusX(n)` `setX(v)` `limit(o, n)` `groupByX()` | 이미 정규 | 숫자 컬럼만 `plus/minus` |
| 행 `->delete($db, true)` | `->deleteCascade($db)` | `delete($db)`는 그대로 |
| 행 `->getRelModel()` `->getRelModels()` | `->getRel()` | compatibility 기본 attach 키 |

### 번역하지 않는 것 (에러 코드와 대체)
| compatibility | 결과 | 대체 |
|---|---|---|
| `andAWithB($model)` 컬럼 대 컬럼(four cases) | `IR_INVALID` | `aEqCol(YCols::b())` |
| `joinAWithB($child, $targetModel)` 다른 조인 모델 기준 조인 | `IR_INVALID` | 그 자식 체인 안에 `joinR`을 중첩 |
| `addColumn('x', fn)` 콜백 컬럼, `column(col, alias, fn)`, `fetchValue(fn)` | `IR_INVALID` / `BadMethodCallException` | 행에서 계산 |
| `Model::function(v, 'expr %s', binds)` 값 객체 | `IR_INVALID` | `expr(fragment, binds)` |
| compatibility 내장 헬퍼 `andDisplayCondition` `conditionDisplayCondition` `andStartEndDtRange` `onStartEndDtRange` `addColumnIsDisplayCondition` `addColumnIsStartEndDtRange` | `COLUMN_UNKNOWN` | Mermaid `%% predicate`로 선언해 `visible()`처럼 쓴다 |
| `newX(v)` `newRawX(…)` (테이블 밖 속성) | `BadMethodCallException` | 행 배열에 붙인다 |
| `get('SELECT …', binds)` `gets(sql, binds)` 원시 SQL 형 | `IR_INVALID`(첫 인자가 DB가 아님) | `raw(sql, binds)->rawAll($db)` |
| `alias`를 행의 접근 키로 쓰는 것(`$row['member']`, `getMember()`) | 관계 이름으로만 접근(`getServiceMember()`, `getServiceMemberModel()`) | alias는 관계 선택에만 쓰인다; IR·플랜에 별칭이 없다 |
| 조인 자식이 부모의 `(`를 닫는 체인(59 files) | `PAREN_ACROSS_MODELS` | `)`를 부모 체인으로 옮기거나 `and(fn)` |
| `keyName`을 `relation`(1:1) 자식에 | 무시 | compatibility도 무시 |
| `fetchKey`를 관계 자식에 | 루트에만 적용 | 정규 PHP `keyByFn`도 루트 전용 |
| `update(true)`(낙관적 잠금) `save($check)` | 행 `update($db)` / `updateOptimistic($db)`, 쿼리 `save($db)` | 인자 형이 다르다 |
| `print()` `debug()` `Model::$debug` `filter(fn)` | `BadMethodCallException` | `sql($db)`, `on_query` 훅 |
| `condition('table.col = 1')` 안의 테이블명 치환 | 그대로 전달 | 엔진은 백틱 컬럼만 alias로 해석한다(`expr` 규칙) |

## 7. 없는 것 (의도적)
op-first 술어(`gtEndDt`), 무접두 술어, `or<op><Col>`, 술어 값 객체·`cols()`·`andPred`, `raw()`(→`expr`), `orderBy<Col>()` 무접미, `with<Rel>`, `match…With…`, `alias<Name>()`, `get/gets/getBy`, `addColumn*`, `parentNode`, `groupLimit`, `keyName*`, 텍스트 쿼리 언어, 맵/구조체 필터, 빌드타임 SQL.

## 스타일 컬럼 (코덱, `docs/codec.md`)
`gz_*`·`json_*`·`jsons_*`·`base64_*`·`serialize_*`(그리고 MySQL `json` 타입)은 저장 바이트가 아니라 **디코드된 값**으로 드나든다. 타입은 JSON형 값 하나다.

| | PHP | Go | Rust |
|---|---|---|---|
| 필드/getter | `$r->getJsonSetting()` → array/스칼라/null (`mixed`) | `r.JsonSetting` (`any`: nil, bool, int64, float64, string, []any, map[string]any) | `r.json_setting` (`serde_json::Value`, NULL은 `Value::Null`) |
| setter | `->setJsonSetting(['a' => 1])` | `.SetJsonSetting(map[string]any{"a": 1})` | `.set_json_setting(json!({"a": 1}))` |
| 기본 SELECT | 제외(lazy) → `selectJsonSetting()` 로 옵트인 | `SelectJsonSetting()` | `select_json_setting()` |
| 술어 | `isNull`/`isNotNull`만 | 동일 | 동일 |

인코딩은 setter 시점에 일어나고, 실패(직렬화 불가한 값·객체)는 터미널에서 `CODEC_ENCODE`/`CODEC_UNSUPPORTED`로 돌아온다. 읽기 실패는 `CODEC_DECODE`. `aes_hex_*`·`ip`는 SQL 함수라 문자열 그대로다.

