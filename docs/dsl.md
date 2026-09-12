# dsl.md — Regular syntax v3 (confirmed)

specified documentspecified [common specified](interfaces.md)specified specified specified definitionspecified. data structure·state·ownershipspecified common specified criteriaspecified. specified criteria 6specified each specifieddefinition specified:

| criteria | specified |
|---|---|
| specified | specified specified defaultvaluespecified Columns name specified(`isClose(0)`). different specified namespecified specified(`isCloseNotEq(1)`). relation(`relation`/`relations`, 1:1·1:Nspecified namespecified specified)specified join(`join`/`leftJoin`)specified different specified. join conditionspecified `on(fn)`/`where(fn)`specified specified specified. Executionspecified `get/gets/getCount/insert`specified specified specified specified Terminalspecified valuespecified receives. DB·transactionspecified specified specified `using`specified specified |
| specified | SQL specified specified specified: `select*`, `where`(=Predicate), `and/or`, `join/leftJoin/on`, `orderBy`, `limit`, `groupBy`. relation specified specified name specified(`flatten`, `limitPerParent`, `keyBy`) |
| specified read | three languagespecified same Tokensspecified. specified none(`lk`→`Like`, `ge`→`Gte`, `nin`→`NotIn`) |
| logicalspecified | three specified: Predicate `<col>(v)` specified `<col><Op>(v)`, connectionspecified `or()`, specified `and(fn)/or(fn)`. different specified relation namespecified specified. Examplespecified none |
| specified | specified specified specified, relation specified specified, relation insidespecified join, join insidespecified join, `expr` specifiedeach, `selectExpr`, `orderByExpr` |
| IDE specified | Columns first·specified after: `endDt` specified → specified Columnsspecified allowspecified specified specified. specified typespecified defined `<X>Where`specified receives. relation specified generation specified |

specified rule: Tokens `fooBar` → PHP `fooBar` / Go `FooBar` / Rust `foo_bar`. languagespecified specified specified(`X::query()` / `m.X()` / `x::query()`), specified specified, executor specified(`using($db)` / `Using(ctx, db)` / `using(&db)`)specified Rustspecified `.await?`specified. Gospecified `m.X()`specified `*m.XQuery`specified returnspecified specified specified.

## 1. Structure

specified specified executorspecified join·specified relation Stagespecified returnspecified Rowspecified specified. specified specified executorspecified specified relationspecified Executorspecified specified specified. Rowspecified `update()`, `updateOptimistic()`, `delete()`, `deleteCascade()`specified specified executorspecified Executionspecified. transactionspecified specified after specified specified Rowspecified Executionspecified `CONFIG`specified. after Executionspecified specified executorspecified specified specified specified. executorspecified specified specified `CONFIG`specified specified default connectionspecified specified specified specified.

```php
$battle = Battle::query()->using($db); // Battle::query()($db)도 같다
$count = $battle->getCountByServiceSeq(7);
```
```go
battle := gen.Battle().Using(ctx, db)
count, err := battle.GetCountByServiceSeq(7)
```
```rust
let battle = battle::query().using(&db);
let count = battle.get_count_by_service_seq(7).await?;
```

```
X 쿼리 생성                              ← 쿼리(행 아님)
    .using(db)                           ← 실행 대상 지정 (Go는 ctx도 함께)
    .select…                            ← 컬럼 (선택)
    .join<Rel>(Y 쿼리 .on(fn) .where(fn)) ← 같은 SELECT에 합침. ON과 WHERE를 자리로 명시
    .<col>(v) / .<col><Op>(v) …         ← WHERE (최상위 그룹, 기본 AND)
    .or()                               ← 다음 항목을 OR로
    .and(fn) / .or(fn)                  ← 괄호 그룹
    .relation<Rel>(Y 쿼리 …)             ← 별도 IN 쿼리로 가져와 행 부착 (1:1)
    .relations<Rel>(Y 쿼리 …)            ← 별도 IN 쿼리로 가져와 키 맵 부착 (1:N)
    .orderBy<Col>Asc/Desc() .limit(o,n)
    .get() / .gets() / .getCount() / .getsCount() / .paginate(page, per)
    .getBy<PK|Unique>(v) / .getsBy<Col>(v) / .getCountBy<Col>(v)
```
Row(row)specified result type `XRow`: getter, `set*`, `update/delete`. specified Rowspecified different typespecified IDEspecified specified specified.

## 2. Tokens

### 2.1 Predicate `<col><Op>(v)` — WHERE
| Op | SQL | Example |
|---|---|---|
| `Eq` `NotEq` | `= !=` | `isClose(0)` (`isCloseEq(0)`specified specified) `statusNotEq('x')` |
| `Gt` `Gte` `Lt` `Lte` | `> >= < <=` | `endDtGt($now)` |
| `In` `NotIn` | `IN` / `NOT IN` (specified specified = specified specified `EMPTY_IN`). value specified 2specified specified specified(specified value specified) — resultspecified specified, specified specified specified prepared statementspecified specified specified(`docs/protocol.md`) | `seqIn([1,2,3])` → specified 4specified |
| `Like` `LikeBinary` | `LIKE ?` — specified callspecified specified(`%`specified specified specified specified) | `nameLike("%$kw%")` |
| `Contains` `StartsWith` `EndsWith` | `LIKE %v%` / `v%` / `%v` — `%`·`_` specified | `nameContains($kw)` |
| `Between` | `BETWEEN ? AND ?` | `createdTsBetween($from, $to)` |
| `IsNull` `IsNotNull` | | `endDtIsNull()` |
| `<A>With<B>Match` `<A>With<B>MatchBoolean` | FULLTEXT — YAML `fulltext:` specified Columns specified generation | `nameWithDescriptionMatchBoolean($kw)` |
| `<col>EqCol(ref)` `<col>NotEqCol(ref)` `GtCol` `GteCol` `LtCol` `LteCol` | Columns specified Columns specified. `ref`specified generationspecified Columns specified — PHP `ProductCols::langId()` / Go `gen.ProductCols.LangId` / Rust `product::cols::lang_id()`. specified specified specified = join specified `on/where` insidespecified **specified**, specified specified. different join specified `->at('service')` / `.At("service")` / `.at("service")` | `langIdEqCol(ProductCols::langId())` |
| `expr(fragment, binds)` | schema check specifiedeach. specified Columnsspecified current specified specified·alias specified | `expr('DAYOFWEEK(`created_ts`) = ?', [1])` |
| `<name>(args…)` name specified Predicate | Mermaid `%% predicate battle visible : `is_close` = 0 AND `is_display` = 1` → `visible()`; `?`specified specified one(`startedAfter($dt)`) | `visible()` |

specified Predicatespecified AND(`or()`specified specified: `->isClose(0)->or()->isDisplay(1)` = `is_close = 0 OR is_display = 1`, specified SQL specified). typespecified allowspecified: specified·specified = specified·In·Between·Null, specified = Eq·NotEq·In·Like·Contains·Null, bool = Eq·NotEq·Null, json/bytes = Nullspecified. `Eq` specified specified specified specified specified.

### 2.2 Groups and navigation — `<X>Where` insidespecified
| Tokens | specified |
|---|---|
| `or()` | connectionspecified Tokens. **specified specified one**(Predicate specified specified)specified specified specified ORspecified specified. defaultspecified AND. specified specified specified specified specified `OR_AT_GROUP_START`, specified two specified `DANGLING_CONNECTOR` |
| `and(fn)` / `or(fn)` | specified specified. `and/or`specified specified specified connectionspecified(`or(fn)` = `or()->and(fn)`). specified specified specified `or(fn)`specified `OR_AT_GROUP_START` |
| `<rel>(fn)` | **joinspecified** relation `<rel>`specified `<Y>Where`specified specified. joinspecified specified `ENTITY_NOT_JOINED` |
| specified specified | `campaign(fn($c) => $c->service(fn($s) => …))` — join insidespecified joinspecified relation namespecified specified specified |

specified specified specified Predicate·`and/or`·specified specified WHERE specified specified(same Tokens). **`on(fn)`·`where(fn)` insidespecified same Where specified**specified OR·specified·specified rulespecified specified specified. Columns specified Columns specified generationspecified specified specified: `$c->langIdEqCol(ProductCols::langId())` — specified specified specified specified(joinspecified specified specified) Columnsspecified.

### 2.3 Columns — SELECT
| Tokens | specified |
|---|---|
| (default) | YAML `lazy: true`specified specified Columns all |
| `selectAll()` | lazy specified all |
| `selectNone()` | PK + FKspecified |
| `select<Col>()` `unselect<Col>()` | add / specified |
| `select<Col>As(name)` | specified (`selectSeqAs('file_name_alias_seq')`) |
| `selectExpr(name, fragment)` | specified Columns (`selectExpr('lat', 'ST_Y(`location`)')`) |

### 2.4 Relations and joins
| Tokens | specified |
|---|---|
| `relation<Rel>(Y::query() …)` | 1:1 relation(YAML `kind: one`specified generation). specified resultspecified specified specified `IN` 1specified specified specified Rowspecified specified |
| `relations<Rel>(Y::query() …)` | 1:N relation(`kind: many`specified generation). same specified specified specified specified specified. specified namespecified specified, kindspecified specified specified namespecified specified specified specified specified |
| `join<Rel>(Y::query() …)` `leftJoin<Rel>(Y::query() …)` | specified relationspecified same SELECTspecified join. join specified condition specified **must specified**: `on(fn)` = ON, `where(fn)` = specified WHEREspecified AND specified. join specified specified specified Predicatespecified specified specified `JOIN_PREDICATE_PLACEMENT`(LEFT JOINspecified INNERspecified specified specified specified). specified insidespecified `join<Rel>`specified specified join. resultspecified `$r->getCampaign()`specified relationspecified same specified |
| (specified alias join none) | same specified two specified relationspecified specified specified(`p1`, `p2`), specified FKspecified YAML specified specified. specified joinspecified specified specified |
| specified specified specified | `keyBy<Col>()` specified Columns · `keyByFn(fn)` specified specified · `flatten()` specified Columnsspecified specified Rowspecified specified · `limitPerParent(n)` specified nRow · `ifParent<Col>Eq(v)` specified Row conditionspecified specified · `dropChildKey()` specified FK Columns remove · `noCascadeDelete()` `delete(cascade)` specified |

### 2.5 Ordering, range, and other operations
`orderBy<Col>Asc()` `orderBy<Col>Desc()` `orderByExpr(fragment)` `groupBy<Col>()` `groupByExpr(expr, as)` `limit(offset, count)` `distinct()` `forceIndex<Name>()` `sql()`

`groupByExpr`specified specified SQL specifiedeachspecified specified specified specified, specified Columnsspecified current specified check·alias specified. `as`specified specified result Rowspecified specified namespecified specified specified specified specified.

### 2.6 Execution (Terminal) — valuespecified specified
| Tokens | result |
|---|---|
| `get()` | Row specified null/nil/None |
| `gets()` | collection(PK specified `keyBy` specified order specified). specified null specified |
| `getCount()` `countDistinct<Col>()` `sum<Col>()` `avg<Col>()` `min<Col>()` `max<Col>()` | specified. `groupBy<Col>()` specified `groupByExpr(expr, as)`specified specified `getCount`specified **specified specified** |
| `getsCount()` | specified Row collection. specified specified specified Row specified specified specified `getRowCount()`/`row_count`specified specified |
| `having(fn)` | `groupBy` after specified Predicate. wherespecified same specified; specified `expr('COUNT(*) > ?', [n])` |
| `raw(sql, binds)` → `rawAll()` | specified specified SELECTspecified specified Execution(specified specified only). `{table}`specified specified specified, `?`specified binds order. Rowspecified Columnsspecified specified specified(typed specified) |
| `paginate(page, per)` | `Page{items, total, pages, current}` |
| `getBy<PK|Unique>(…)` | PK·unique specified specified |
| `getsBy<Col>(v)` | `<col>(v)`specified specified after `gets()`specified Executionspecified collection specified. `Eq`specified allowspecified Columnsspecified generation |
| `getCountBy<Col>(v)` | `<col>(v)`specified specified after `getCount()`specified Executionspecified specified specified. `Eq`specified allowspecified Columnsspecified generation |
| `insert()` (specified `set*` specified after) | specified Row |

`count`specified `one/all`specified `oneBy`specified eacheach `getCount`, `get/gets`specified `getBy`specified specified specified. `getBy`specified PK·unique specified, `getsBy`specified `getCountBy`specified specified specified `Eq` specified Columns onespecified specified three language common finder specified. specified conditionspecified same root specified Columns specified specified specified after `gets`specified `getCount`specified callspecified. Executorspecified specified specified `using`specified specified. Gospecified `Using(ctx, db)`, PHPspecified `using($db)`, Rustspecified `using(&db)`specified. after specified Terminalspecified DB·specified specified callspecified. `using`specified specified callspecified executorspecified specified condition·join·relationspecified specified. executorspecified IR·specified specified specified specified specified.

`getsBy`specified `getCountBy`specified current specified specified specified equality Predicate onespecified addspecified after Terminalspecified Executionspecified. specified specified `join`specified `relation` Stagespecified specified·condition·specified specified specified specified. `%% index`specified specified Execution specified specified specified finder specified allow specified specified specified.

### 2.7 Row
| | PHP | Go | Rust |
|---|---|---|---|
| specified | `$r->getName()` `$r->getName($default)` `$r['name']` | `r.Name` / nil-safe `r.GetName()` | `r.name` (nullablespecified `Option`) |
| Relations and joins | `$r->getService()` → Row/null, `$r->getUser()` → Row/null | `r.GetService()` / `r.GetUser()` | `r.service() -> Option<&T>` / `r.user() -> Option<&T>` |
| change | `$r->setName('x')->update()` `->updateOptimistic()` `->delete()` | `r.SetName("x"); r.Update()` `r.UpdateOptimistic()` `r.Delete()` | `r.set_name("x"); r.update().await?` `r.update_optimistic().await?` `r.delete().await?` |
| collection | `foreach ($c as $k => $r)` `first()` `count()` `toArray()` | `for k, r := range c.All()` `First()` `Len()` `ToArray()` | `for (k, r) in &c` `first()` `len()` `to_vec()` `to_map()` |
| transaction | `$db->transaction(fn($tx) => …)` | `orm.Transaction(ctx, db, func(tx *orm.Tx) (T, error) {…})` | `db.transaction(\|tx\| async move {…}).await?` |

specified/throw = rollback. specified specified specifiedExecution(specified 3specified).

## 3. Example 1 — specified·join conditionspecified specified

same modelspecified default condition, `or()` specified, join `on/where`specified specified specified specified.

```php
$battles = Battle::query()
    ->join(Service::query()->nameLike('pro'))
    ->serviceSeq(7)
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w
        ->isDisplay(true)
        ->or()
        ->isAllday(true))
    ->orderBySeqDesc()->limit(0, 20)->using($db)->gets();
```
```go
battles, err := gen.Battle().
    Join(gen.Service().NameLike("pro")).
    ServiceSeq(7).IsClose(false).
    And(func(w *gen.BattleWhere) { w.IsDisplay(true).Or().IsAllday(true) }).
    OrderBySeqDesc().Limit(0, 20).Using(ctx, db).Gets()
```
```rust
let battles = battle::query()
    .join(service::query().name_like("pro"))
    .service_seq(7)
    .is_close(false)
    .and(|w| w.is_display(true).or().is_allday(true))
    .order_by_seq_desc().limit(0, 20).using(&db).gets().await?;
```

`serviceSeq(7)`specified Columns namespecified specified specified default `Eq`specified. `andServiceSeq(7)`specified Regular syntaxspecified specified,
specified specified specified `and(fn)`specified uses. join conditionspecified specified specified `on(fn)`specified, join resultspecified
specified conditionspecified `where(fn)`specified distinctionspecified.

## 4. Example 2 — relationspecified specified specified

relationspecified specified specified specified. `relations`specified 1:N collection, `relation`specified 1:1 Rowspecified specified,
`limitPerParent`specified each specified specified.

```php
$services = Service::query()
    ->nameLike('pro')
    ->relations(ServiceModule::query()
        ->orderBySeqDesc()->limitPerParent(3))
    ->relations(ServiceMember::query()
        ->relation(User::query())->keyBySeq())
    ->orderBySeqDesc()->using($db)->gets();
```
```go
services, err := gen.Service().
    NameLike("pro").
    Relations(gen.ServiceModule().OrderBySeqDesc().LimitPerParent(3)).
    Relations(gen.ServiceMember().Relation(gen.User()).KeyBySeq()).
    OrderBySeqDesc().Using(ctx, db).Gets()
```
```rust
let services = service::query()
    .name_like("pro")
    .relations(service_module::query().order_by_seq_desc().limit_per_parent(3))
    .relations(service_member::query().relation(user::query()).key_by_seq())
    .order_by_seq_desc().using(&db).gets().await?;
```

relation Stagespecified specified resultspecified specified specified `IN`specified specified, resultspecified specified relation namespecified specified.
specified specified specified Stagespecified Executionspecified specified.

## 5. Example 3 — write·transaction

```php
$service = $db->transaction(function ($tx) {
    $service = Service::query()->using($tx)->setName('example')->insert();
    $service->setName('renamed')->update();
    return $service;
});
$service->using($db)->delete();
```
```go
service, err := orm.Transaction(ctx, db, func(tx *orm.Tx) (*gen.ServiceRow, error) {
    service, err := gen.Service().Using(ctx, tx).SetName("example").Insert()
    if err != nil { return nil, err }
    if err := service.SetName("renamed").Update(); err != nil { return nil, err }
    return service, nil
})
if err != nil { return err }
err = service.Using(ctx, db).Delete()
```
```rust
let mut service = db.transaction(|tx| async move {
    let mut service = service::query().using(&tx).set_name("example").insert().await?.unwrap();
    service.set_name("renamed").update().await?;
    Ok(service)
}).await?;
service.using(&db).delete().await?;
```
transaction insidespecified Row specified specified specified specified connectionspecified specified. specified specified specified `bind(db)`specified specified connectionspecified specified.

## 6. PHP specified (specified specified; specified API specified, `__call` only)
specified APIspecified specified specified PHP specified same IRspecified specified: `andX/orX/conditionX`(`orX` = `or()->x`), op-first(`gtEndDt`), specified→In, null→IsNull, `relation(Y::query()->matchAWithB()->aliasR())`→`relationR`/`relationsR`, `joinAWithB`, `addColumnX`/`addAllColumns`, `parentNode`→`flatten`, `groupLimit`→`limitPerParent`, `keyNameX`→`keyByX`, `fetchKey`→`keyByFn`, `deleteLock`→`noCascadeDelete`, `getAll/getsAll`, specified specified specified `getByXAndY/getsByXAndY`, `and('(')…condition(')')`(model specified specified; specified specified `PAREN_ACROSS_MODELS`). specified Columns finderspecified specified `get/gets`·`<col>(v)`specified generation specified providespecified specified specified specified specified. `ormgen check --lang php`specified usespecified specified specified.

## PHP specified
`clients/php/src/Compat.php`(`CompatQuery`·`CompatWhere` specified)specified generationspecified specified·Where specified `__call`specified specified. generation specified specified namespecified specified specified, call specified namespecified specified **specified specified same Q/W specified call**specified specified — specified specified specified specified specified `Req::shape()` specified specified(`clients/php/tests/compat.php`, 50specified). specified resultspecified (specified, specified)specified specified specified static specified specified(opcache specified, specified specified none).

PHPspecified `X::query()->using($db)`specified specified generationspecified executor specified specified. generation specified specified specified specified specifiedtwo specified specified executorspecified usespecified Terminalspecified valuespecified specified.

relationspecified specified languagespecified `relation(Target)`, `relations(Target)`, `join(Target)`, `leftJoin(Target)`specified uses. manifestspecified relation specified onespecified specified specified specified specified `relationAKeyWithBKey(Target)` same generationspecified specified specified providespecified, specified specified specified same IRspecified generationspecified. `relationUser`specified specified namespecified specified specified generationspecified specified.

relation specified specified specified specified specified specified specified Queryspecified specified specified first specified. `matchAKeyWithBKey()`specified `onAKeyWithBKey()`specified namespecified specified same `LinkSelection(parentKey, childKey)`specified specified. after specified callspecified specified specified specified.

```php
Battle::query()->relation(User::query()->matchUserSeqWithSeq())->gets();
Battle::query()->leftJoin(User::query()->onUserSeqWithSeq())->gets();
```
```go
gen.Battle().Relation(gen.User().MatchUserSeqWithSeq()).Gets(ctx, db)
gen.Battle().LeftJoin(gen.User().OnUserSeqWithSeq()).Gets(ctx, db)
```
```rust
battle::query().relation(user::query().match_user_seq_with_seq()).gets().await?;
battle::query().left_join(user::query().on_user_seq_with_seq()).gets().await?;
```

specified specified specified specified specified specified specified relationspecified onespecified Manifestspecified specified relationspecified usespecified, specified specified default specified specified specified. specified specified specified specified specified relation specified `relation`/`relations`specified specified specified three language specifiedtwo `RELATION_UNKNOWN`specified failurespecified. generationspecified specified specified samespecified relation namespecified directly specified specified specified callspecified IRspecified specified specified specified criteriaspecified specified.

name specified: camel Tokens(`IsClose` → `Is`,`Close`)specified specified `columns()` specified **specified specified**specified Columnsspecified specified. name insidespecified `And`/`Or`specified connectionspecified, specified specified. specified Columns → `COLUMN_UNKNOWN`(specified Columns specified specified); op specified Columnsspecified specified(`InStock` = Columns `in_stock` specified `In`+`stock`) → `COLUMN_UNKNOWN`(two specified specified). valuespecified specified specified(`andIsClose(0)`specified `isClose(false)`specified same SQL·result, specified typespecified specified).

### specified
| specified PHP specified | specified | specified |
|---|---|---|
| `andX(v)` `conditionX(v)` `whereX(v)` | `x(v)` | specified → `xIn(v)`, `null` → `xIsNull()` |
| `orX(v)` | `or()->x(v)` | |
| `andXAndY(a, b)` `orXOrY(a, b)` `conditionXAnd(YOrZ)(a, b, c)` | `x(a)->y(b)` / `->or()` / `->and(fn)` | namespecified `And`/`Or`specified connectionspecified, namespecified specified specified. specified specified Predicate specified specified specified(`IR_INVALID`) |
| op-first `GtX LtX GeX LeX EqX NeX` | `xGt xLt xGte xLte x xNotEq` | `NeX(null)` → `xIsNotNull()`, `NeX([…])` → `xNotIn([…])` |
| `LkX(v)` `LbX(v)` | `xLike('%v%')` `xLikeBinary('%v%')` | `%`specified specified specified specified(`Contains`specified specified) |
| `InX([…])` `NinX/NotInX([…])` `BetweenX([lo, hi])` `IsNullX()` `NotNullX()/IsNotNullX()` | `xIn xNotIn xBetween(lo, hi) xIsNull xIsNotNull` | `IsNull/NotNull`specified specified specified specified |
| `FulltextAWithB(v)` `FulltextBooleanAWithB(v)` | `aWithBMatch(v)` `aWithBMatchBoolean(v)` | specified `+word*` specified Executorspecified specified specified specified specified |
| `and('(')` `or('(')` `condition('(')` … `condition(')')`, `->{'and('}()` `->{'condition)'}()` | `and(fn)` / `or(fn)` specified | same model specified insidespecified specified. join·relation specified specified `(`specified specified, specified specified specified, Terminalspecified inside specified `PAREN_ACROSS_MODELS`(two model namespecified specified specified specified specified) |
| `->{'condition(AAndB)Or(C)'}(a, b, c)` `->{'or(IsSale)'}(1)` `->{'getsByAAnd((BAndC)Or(D))'}(…)` | specified same specified | brace-call specified |
| `and()` / `or()` / `or(fn)` | none / `or()` / `or()->and(fn)` | |
| `and('sql …', [':k' => v])` `or(…)` `condition('sql …', binds)` | `expr('sql … ?', [v])` | specified specified specified = specifiedeach. name specified `:k`specified specified specified `?`specified specified |
| `and('Name', v)` `and('snake_name', v)` | `name(v)` | `and($key, $value)` |
| join specified `onX(v)` `onXOrY(a, b)` | `on(fn($w) => $w->x(v)…)` | ON specified |
| join specified `andX(v)` | `where(fn($w) => $w->x(v))` | specified WHEREspecified ANDspecified specified specified |
| `relation(Y::query()->matchAWithB()->aliasR())` `relations(…)` `oneToOne/oneToMany` `relationAWithB(Y::query())` `match('a', 'b')` `alias('r')` | `relationR(Y::query())` / `relationsR(Y::query())` | specified.A = Y.B specified specified specified specified relationspecified specified. specified specified(`RELATION_UNKNOWN`), specified relationspecified specified `alias<Name>`specified specified(specified `RELATION_UNKNOWN`). `relation`specified 1:Nspecified `RELATION_UNKNOWN`("relationsspecified specified"). match none = defaultspecified(specified PK, `<specified>_<pk>`) |
| `matchAWithB(false)` | `dropChildKey()` | specified Columns Bspecified specified PKspecified specified specified |
| `matchAllAWithB()` | `selectAll()` + relation | |
| `joinAWithB(Y::query())` `leftJoinAWithB(Y::query())` | `joinR(Y::query())` `leftJoinR(Y::query())` | specified namespecified, aliasspecified specified specified specified |
| `addColumnX()` `addColumn('x')` `addColumns([…])` | `selectX()` | |
| `addColumnXAliasY()` `addColumn('x', 'y')` | `selectXAs('y')` | |
| `addColumnXAliasY('fmt(%s)')` `addColumn('x', 'y', fmt)` | `selectExpr('y', 'fmt(`x`)')` | `%s` specified specified Columns |
| `addRawColumnX(sql)` | `selectExpr('x', sql)` | |
| `addAllColumns()` `removeAllColumns()` `onlyColumns([…])` | `selectAll()` `selectNone()` `selectNone()->select…()` | |
| `removeColumnX()` `removeColumn('x')` `removeColumns([…])` | `unselectX()` | |
| `orderByX()` `orderByXAndYDesc()` `orderByXDesc('fmt %s')` `orderBy('sql')` | `orderByXAsc()` `orderByXAsc()->orderByYDesc()` `orderByExpr('fmt `x`', true)` `orderByExpr('sql')` | `orderByXAsc/Desc`specified specified specified |
| `groupByXAndY()` | `groupByX()->groupByY()` | |
| `forceIndex('name')` | `forceIndex<Name>()` | |
| `keyNameX()` `keyName('x')` | `relations` specified: attach specified `keyByX()` · specified: Terminalspecified `keyByFn(fn($r) => $r['x'])` · `relation`(1:1) specified: specified | attach specified specified specified specified `keyByX()`specified specified specified specified specified(`dropChildKey()`specified specified after) |
| `keyName(fn)` `fetchKey(fn)` | `keyByFn(fn)` | specified collection only(specified PHPspecified specified) |
| `parentNode()` `groupLimit(n)` `possibleX(v)` `deleteLock()` | `flatten()` `limitPerParent(n)` `ifParentXEq(v)` `noCascadeDelete()` | `deleteLock(false)`specified none |
| `getAll()` `getsAll()` | `selectAll()->get/gets()` | |
| `getByX(v)` `getsByX(v)` `getCountByX(v)` | generation finder specified Predicate + `get/gets/getCount()` | `getBy`specified PK·unique specified, `getsBy`·`getCountBy`specified specified specified `Eq` specified Columnsspecified generationspecified. specified namespecified PHP specified value conversion rulespecified follows |
| specified specified specified `getByXAndY` `getsByXAndY` `getAllByX` `getsAllByX` | Predicate + `get/gets()` | PHP specified namespecified call orderspecified specified(`->andA()->getsByB()` = `a()->b()`) |
| `getsCount()` | specified Rowspecified returnspecified Terminal | `groupBy`specified specified `getCount`specified specified specified. result Rowspecified specified Columnsspecified `row_count`specified specified |
| `getSumX()` `getAvgX()` | `sumX()` `avgX()` | |
| `create()` | `insert()` | |
| `duplication(X::query()->setA(v)->plusB(n)->setCExpr(f, b))` `duplication(['a' => v])` | `onDuplicateSetA(v)->onDuplicatePlusB(n)->onDuplicateSetCExpr(f, b)` | modelspecified set/plus/minus/expr order specified |
| `setRawX('f(:a, :b)', [':a' => 1, ':b' => 2])` | `setXExpr('f(?, ?)', [1, 2])` | |
| `plusX(n)` `minusX(n)` `setX(v)` `limit(o, n)` `groupByX()` | specified specified | specified Columnsspecified `plus/minus` |
| Row `->using($db)->delete(true)` | `->using($db)->deleteCascade()` | `delete()`specified specified |
| Row `->getRelModel()` `->getRelModels()` | `->getRel()` | default attach specified |

### specified specified specified (specified specified specified)
| specified PHP specified | result | specified |
|---|---|---|
| `andAWithB($model)` Columns specified Columns | `IR_INVALID` | `aEqCol(YCols::b())` |
| `joinAWithB($child, $targetModel)` different join model criteria join | `IR_INVALID` | specified specified specified insidespecified `joinR`specified specified |
| `addColumn('x', fn)` specified Columns, `column(col, alias, fn)`, `fetchValue(fn)` | `IR_INVALID` / `BadMethodCallException` | Rowspecified specified |
| `Model::function(v, 'expr %s', binds)` value specified | `IR_INVALID` | `expr(fragment, binds)` |
| specified specified specified specified `andDisplayCondition` `conditionDisplayCondition` `andStartEndDtRange` `onStartEndDtRange` `addColumnIsDisplayCondition` `addColumnIsStartEndDtRange` | `COLUMN_UNKNOWN` | Mermaid `%% predicate`specified specified `visible()`specified specified |
| `newX(v)` `newRawX(…)` (specified outside specified) | `BadMethodCallException` | Row specified specified |
| `get('SELECT …', binds)` `gets(sql, binds)` specified SQL specified | `IR_INVALID`(get/getsspecified specified none) | `raw(sql, binds)->using($db)->rawAll()` |
| `alias`specified Rowspecified specified specified specified specified(`$row['member']`, `getMember()`) | relation namespecified specified(`getServiceMember()`, `getServiceMemberModel()`) | aliasspecified relation specified specified; IR·specified specified specified |
| join specified specified `(`specified specified specified | `PAREN_ACROSS_MODELS` | `)`specified specified specified specified `and(fn)` |
| `keyName`specified `relation`(1:1) specified | specified | 1:1 relationspecified specified specified |
| `fetchKey`specified relation specified | specified specified | specified PHP `keyByFn`specified specified only |
| `update(true)`(specified specified) `save($check)` | Row `update()` / `updateOptimistic()`, specified `save()` | specified specified specified |
| `print()` `debug()` `Model::$debug` `filter(fn)` | `BadMethodCallException` | `sql()`, `on_query` specified |
| `condition('table.col = 1')` insidespecified specified specified | specified specified | Enginespecified specified Columnsspecified aliasspecified specified(`expr` rule) |

## 7. specified specified (specified)
op-first Predicate(`gtEndDt`), `or<op><Col>`, Predicate value specified·`cols()`·`andPred`, `raw()`(→`expr`), `orderBy<Col>()` specified, `with<Rel>`, `match…With…`, `alias<Name>()`, `addColumn*`, `parentNode`, `groupLimit`, `keyName*`, specified specified language, specified/Structurespecified specified, specified SQL.

## specified Columns (specified, `docs/codec.md`)
`gz_*`·`json_*`·`jsons_*`·`base64_*`·`serialize_*`(specified MySQL `json` type)specified specified specified specified **specified value**specified specified. typespecified JSONspecified value onespecified.

| | PHP | Go | Rust |
|---|---|---|---|
| field/getter | `$r->getJsonSetting()` → array/specified/null (`mixed`) | `r.JsonSetting` (`any`: nil, bool, int64, float64, string, []any, map[string]any) | `r.json_setting` (`serde_json::Value`, NULLspecified `Value::Null`) |
| setter | `->setJsonSetting(['a' => 1])` | `.SetJsonSetting(map[string]any{"a": 1})` | `.set_json_setting(json!({"a": 1}))` |
| default SELECT | specified(lazy) → `selectJsonSetting()` specified specified | `SelectJsonSetting()` | `select_json_setting()` |
| Predicate | `isNull`/`isNotNull`specified | same | same |

specified setter specified specified, failure(specified specified value·specified)specified Terminalspecified `CODEC_ENCODE`/`CODEC_UNSUPPORTED`specified specified. read failurespecified `CODEC_DECODE`. `aes_hex_*`·`ip`specified SQL specified specified specified.
