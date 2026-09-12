# DSL v3 — 정규 문법

이 문서는 공개 쿼리 문법을 정의한다. 자료구조·소유권·상태 전이는 [공통 인터페이스](interfaces.md)에서 정의한다.

| 규칙 | 정의 |
|---|---|
| 명시적 이름 | `<col>(value)`는 equality다. 다른 연산자는 `<col>NotEq`, `<col>Gt`, `<col>In`, `<col>IsNull`처럼 메서드명에 표시한다. `relation`, `relations`, `join`, `leftJoin`은 서로 다른 동작이다. |
| SQL 용어 | `select`, `and`, `or`, `join`, `leftJoin`, `on`, `orderBy`, `limit`, `groupBy` 이름을 사용한다. |
| 공통 토큰 | PHP·Go·Rust·TypeScript가 같은 논리 토큰을 사용한다. 표기는 언어 규칙을 따른다. |
| 그룹 | `or()`는 다음 항목의 연결자를 바꾼다. `and(fn)`과 `or(fn)`은 중첩 그룹을 만든다. |
| IDE 검사 | 생성된 builder는 스키마가 허용한 컬럼과 연산자만 노출한다. Where callback은 생성된 entity Where 타입을 받는다. |
| 실행 | 루트 쿼리에 `using`으로 실행 대상을 지정한다. terminal은 값만 받는다. |

## 1. 구조

쿼리를 먼저 만들고 실행 대상을 지정한 뒤 값 연산으로 종료한다. 실행 대상은 join, relation 단계, 반환 행에 적용된다. 실행 대상이 없거나 transaction이 끝난 뒤 실행하면 `CONFIG`다.

```php
$battle = Battle::query()->using($db);
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
```ts
const battle = Battle().using(database);
const count = await battle.getCountByServiceSeq(7);
```

호출 순서는 다음과 같다.

```text
Query() → using(executor) → select/join/where/relation → order/limit → get/gets/getCount
```

행은 별도 생성 타입이다. 행은 스키마에 따라 getter, setter, `update`, `updateOptimistic`, `delete`, `deleteCascade`를 제공한다.

## 2. 토큰

### 2.1 술어 `<col><Op>(value)` — WHERE

| 토큰 | SQL | 예 |
|---|---|---|
| `<col>` / `<col>Eq` | `=` | `isClose(false)` |
| `<col>NotEq` | `!=` | `statusNotEq("x")` |
| `<col>Gt`, `Gte`, `Lt`, `Lte` | 비교 | `endDtGt(now)` |
| `<col>In`, `NotIn` | `IN`, `NOT IN` | `seqIn([1, 2, 3])` |
| `<col>Like`, `LikeBinary` | `LIKE` | `nameLike("%kw%")` |
| `<col>Contains`, `StartsWith`, `EndsWith` | 이스케이프된 `LIKE` 패턴 | `nameContains(keyword)` |
| `<col>Between` | `BETWEEN` | `createdTsBetween(from, to)` |
| `<col>IsNull`, `IsNotNull` | `IS NULL`, `IS NOT NULL` | `endDtIsNull()` |
| `<A>With<B>Match` | full-text match | `nameWithDescriptionMatch(keyword)` |
| `<col><Op>Col(ref)` | 컬럼 비교 | `langIdEqCol(ProductCols::langId())` |
| `expr(fragment, binds)` | 스키마 검사 SQL 조각 | `expr('DAYOFWEEK(`created_ts`) = ?', [1])` |
| named predicate | 스키마에 정의한 술어 그룹 | `visible()` |

빈 `IN` 목록은 `EMPTY_IN`을 반환한다. 허용 연산자는 컬럼 타입에 따라 결정한다. `Eq` 접미사는 명시적 equality 메서드다.

### 2.2 그룹과 탐색 — `<X>Where`

| 토큰 | 의미 |
|---|---|
| `or()` | 다음 항목을 OR로 연결한다. 기본 연결자는 AND다. |
| `and(fn)` / `or(fn)` | 중첩 그룹을 추가한다. |
| `<rel>(fn)` | 선언된 join relation의 조건을 추가한다. 선언되지 않은 경로는 `ENTITY_NOT_JOINED`다. |
| `on(fn)` / `where(fn)` | join ON과 WHERE에서 같은 Where builder를 사용한다. |

그룹 첫 위치의 `or()`와 `or(fn)`은 `OR_AT_GROUP_START`다. 술어 없이 연결자를 두 번 사용하면 `DANGLING_CONNECTOR`다. 그룹은 깊이 제한 없이 중첩할 수 있다.

### 2.3 컬럼 — SELECT

| 토큰 | 의미 |
|---|---|
| 기본값 | eager 컬럼을 선택한다. lazy·styled 컬럼은 제외한다. |
| `selectAll()` | 전체 컬럼을 선택한다. |
| `selectNone()` | primary key와 foreign key를 선택한다. |
| `select<Col>()` / `unselect<Col>()` | 컬럼 하나를 추가·제거한다. |
| `select<Col>As(name)` | 출력 이름을 지정해 선택한다. |
| `selectExpr(name, fragment)` | 스키마 검사 expression을 선택한다. |

출력 매핑은 `{alias, column, out_name, index}` 위치 정보로 처리한다. join 컬럼은 alias namespace에 둔다.

### 2.4 관계와 조인

`relation<Rel>(child)`는 연결된 한 행을 가져온다. `relations<Rel>(child)`는 collection을 가져온다. `join<Rel>(child)`와 `leftJoin<Rel>(child)`는 SQL join을 추가한다. 관계 종류와 key 매핑은 스키마에서 정한다.

join 조건에서는 `child.on(fn)`을 ON에 사용하고 `child.where(fn)`을 WHERE에 사용한다. join 안에 선언된 join을 추가할 수 있다. 생성 이름은 모든 클라이언트에서 같은 논리 이름을 사용한다.

### 2.5 정렬·범위·옵션

`orderBy<Col>Asc`, `orderBy<Col>Desc`, `groupBy<Col>`, `groupByExpr`, `having(fn)`, `limit(offset, count)`, `keyBy<Col>`, `keyByFn`, `flatten`, `limitPerParent`를 사용한다. `parentNode`는 선언된 결과 병합 작업에서만 사용한다.

### 2.6 실행 terminal

| Terminal | 반환값 |
|---|---|
| `get()` | 행 하나 또는 null |
| `gets()` | 행 collection |
| `getCount()` | 정수 count |
| `getsCount()` | 그룹 count 행 |
| `paginate(page, perPage)` | page 결과 |
| `getBy<PK|Unique>(value)` | 행 하나 또는 null |
| `getsBy<Col>(value)` | 행 collection |
| `getCountBy<Col>(value)` | 정수 count |

Finder는 equality 술어를 적용한 뒤 해당 terminal을 호출한다. 데이터베이스나 executor를 terminal에 전달하지 않는다.

### 2.7 Batch write

Batch write는 typed query draft와 하나의 transaction을 사용한다. `batchInsert`, `batchUpsert`, `batchUpdate`, `batchDelete`는 entity별 query 목록과 양수 chunk size를 받는다. 결과는 `attempted`, `affected`, `inserted`를 포함한다. 오류가 발생하면 전체 batch를 rollback하며, 전달된 transaction은 재사용한다.

### 2.8 행

행은 저장 필드마다 생성 getter와 setter를 가진다. setter는 필드를 dirty로 표시한다. update는 행의 binding을 사용하고 optimistic locking에 필요한 원본 값을 보존한다. 관계 접근자는 선언된 행 또는 collection 타입을 반환한다.

## 3. 예: 루트와 조인 조건

```php
$battles = Battle::query()
    ->using($db)
    ->serviceSeq(7)->isClose(false)
    ->and(fn($w) => $w->isDisplay(true)->or(fn($w) => $w->isAllday(true)))
    ->leftJoinUser(User::query()->on(fn($w) => $w->seqEqCol(BattleCols::userSeq())))
    ->orderBySeqDesc()->limit(0, 20)->gets();
```

루트 그룹과 join ON 그룹은 별도로 저장하고 선언 순서대로 compile한다.

## 4. 예: 관계와 부모별 제한

```go
battles, err := gen.Battle().Using(ctx, db).
    ServiceSeq(7).IsClose(false).
    WithUser(gen.User().OrderBySeqDesc()).
    LimitPerParent(20).Gets()
```

관계 단계는 앞 단계에서 부모 key를 받는다. `limitPerParent`는 각 부모 key 안에서 적용한다.

## 5. 예: 쓰기와 transaction

```rust
let mut row = battle::query().using(&db).get_by_seq(7).await?.unwrap();
row.set_name("updated".to_owned());
row.update().await?;
```

행과 쿼리는 같은 root transaction binding을 사용한다. 종료된 transaction은 이후 작업을 `CONFIG`로 거부한다.

## 6. 의도적으로 지원하지 않는 문법

정규 API는 `relationUser`, `relationsUser`, `matchAWithB`, `aliasName`, `or<Op><Col>`, `bind(db)`, terminal의 데이터베이스 인자, `new Battle` 방식의 언어 종속 진입점을 생성하지 않는다. 생성 진입점은 언어의 생성자 또는 factory 표기를 사용하되 쿼리 구조는 동일하게 유지한다.

## 스타일 컬럼

스타일은 스키마 선언이다. `aes`, `hex`, `gz`, `json`, `jsons`, `base64`, `serialize` 처리는 [codec.md](codec.md)에 정의한다. `aes_key_version`은 평문 메타데이터이며 스타일을 사용하지 않고 기본 projection에서 제외한다.
