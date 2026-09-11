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
| `In` `NotIn` | `IN` / `NOT IN` (빈 리스트 = 컴파일 에러 `EMPTY_IN`) | `seqIn([1,2,3])` |
| `Like` `LikeBinary` | `LIKE ?` — 패턴은 호출자가 준다(`%`를 자동으로 감싸지 않음) | `nameLike("%$kw%")` |
| `Contains` `StartsWith` `EndsWith` | `LIKE %v%` / `v%` / `%v` — `%`·`_` 이스케이프 | `nameContains($kw)` |
| `Between` | `BETWEEN ? AND ?` | `createdTsBetween($from, $to)` |
| `IsNull` `IsNotNull` | | `endDtIsNull()` |
| `<A>With<B>Match` `<A>With<B>MatchBoolean` | FULLTEXT — YAML `fulltext:` 인덱스 컬럼 조합에만 생성 | `nameWithDescriptionMatchBoolean($kw)` |
| `<col>EqCol(ref)` `<col>NotEqCol(ref)` `GtCol` `GteCol` `LtCol` `LteCol` | 컬럼 대 컬럼 비교. `ref`는 `on(fn($c, $a))`의 부모 참조 `$a-><col>()` 또는 탐색 안의 다른 엔티티 참조 | `langIdEqCol($a->langId())` |
| `expr(fragment, binds)` | 스키마 검사 조각. 백틱 컬럼은 현재 엔티티로 해석·alias 치환 | `expr('DAYOFWEEK(`created_ts`) = ?', [1])` |

연속된 술어는 AND(`or()`로 바꿈: `->isCloseEq(0)->or()->isDisplayEq(1)` = `is_close = 0 OR is_display = 1`, 우선순위는 SQL 그대로). 타입별 허용표: 숫자·날짜 = 비교·In·Between·Null, 문자열 = Eq·NotEq·In·Like·Contains·Null, bool = Eq·NotEq·Null, json/bytes = Null만.

### 2.2 그룹·탐색 — `<X>Where` 안에서
| 토큰 | 의미 |
|---|---|
| `or()` | 연결자 토큰. **다음 항목 하나**(술어 또는 그룹)를 앞 형제와 OR로 잇는다. 기본은 AND. 그룹의 첫 항목 앞에 오면 `OR_AT_GROUP_START`, 연속 두 번이면 `DANGLING_CONNECTOR` |
| `and(fn)` / `or(fn)` | 괄호 그룹. `and/or`는 앞 형제와의 연결자(`or(fn)` = `or()->and(fn)`). 그룹의 첫 항목이 `or(fn)`이면 `OR_AT_GROUP_START` |
| `<rel>(fn)` | **조인된** 관계 `<rel>`의 `<Y>Where`로 내려간다. 조인되지 않았으면 `ENTITY_NOT_JOINED` |
| 다단 탐색 | `campaign(fn($c) => $c->service(fn($s) => …))` — 조인 안의 조인도 관계 이름으로 계속 내려간다 |

쿼리 최상위에서 쓰는 술어·`and/or`·탐색은 곧 WHERE 최상위 그룹이다(같은 토큰). **`on(fn)`·`where(fn)` 안도 같은 Where 빌더**이므로 OR·괄호·탐색 규칙이 그대로 적용된다. `on(fn($c, $a))`의 둘째 인자 `$a`는 부모(조인을 건 쪽) 컬럼 참조로, ON에서 컬럼 대 컬럼 비교(`$c->langIdEqCol($a->langId())`)에 쓴다.

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
| `count(db)` `sum<Col>(db)` `avg<Col>(db)` | 스칼라 |
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

