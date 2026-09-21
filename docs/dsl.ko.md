# DSL

이 문서는 [설계 계획](plan.md)이 정한 쿼리 문법을 정의한다. 클라이언트 상태는 [구현 대조표](interface-implementation.md)에 기록하며, 이 문서와 일치하지 않는 클라이언트는 미완료 상태다.

## 1. 모델과 연결

쿼리는 모델에서 시작한다. 모델은 언어 형태로 생성하고 `connect`로 데이터베이스 연결을 받는다.

| 언어 | 생성 | 연결한 모델 | 연결한 조회 행 |
|---|---|---|---|
| PHP | `new Product` | `(new Product)->connect($slave1)` | `$row->connect($master)` |
| Go | `model.Product()` | `model.Product().Connect(slave1)` | `row.Connect(master)` |
| Rust | `Product::new()` | `Product::new().connect(&slave1)` | `row.connect(&master)` |
| TypeScript | `new Product()` | `new Product().connect(slave1)` | `row.connect(master)` |

- 연결 메서드는 `connect` 하나다. 조회한 행이나 컬렉션도 쓰기 전에 같은 메서드를 사용하므로, 복제본에서 읽은 행을 기본 연결로 쓸 수 있다.
- PHP는 `(new Product)($slave1)`과 `$row($master)`를 `connect`의 짧은 형태로 허용한다.
- Go는 생성된 `model` 패키지의 함수를 사용한다. `model.Product()`는 `*model.ProductModel`을 반환한다.
- 트랜잭션 콜백 안에서 `connect`를 호출하지 않은 모델은 현재 실행 흐름의 활성 트랜잭션을 사용한다. 트랜잭션 밖에서 `connect` 없는 모델의 종단 작업이나 쓰기는 `CONFIG`를 반환한다.

## 2. 조건

### 2.1 연결자와 묶음

첫 조건에는 접두어가 없으며, 접두어를 적어도 무시한다. 이후 조건은 메서드 명칭 안의 `and`·`or` 또는 별도 연결자로 시작한다.

```php
(new Product)->connect($slave1)
    ->serviceSeq($serviceSeq)
    ->andIsClose(0)
    ->or()->isSale(2)
    ->and(fn (Product $q) => $q->isSale(1)->andLtSaleStartDt($now))
    ->gets();
```

| 형태 | 의미 |
|---|---|
| `<Chain>(…)` | 모델 또는 묶음의 첫 조건 |
| `and<Chain>(…)`, `or<Chain>(…)` | `AND` 또는 `OR`로 연결한 조건 |
| `and()`, `or()` 다음의 `<Chain>(…)` | 같은 연결을 별도 호출로 작성한 형태 |
| `and(fn)`, `or(fn)` | `AND` 또는 `OR`로 연결한 괄호 묶음 |
| `and(model)`, `or(model)` | 조인한 모델에 설정한 조건의 괄호 묶음 |
| `raw(sql, binds)`, `andRaw(sql, binds)`, `orRaw(sql, binds)` | 첫 조건 또는 이후 조건인 원시 조건 |

- 모델이나 묶음의 시작 위치에 있는 연결자는 연결할 대상이 없으므로 무시한다. `and(fn)`, `or(fn)`, `and()`, `or()`, `and<Chain>(…)`, `or<Chain>(…)`은 모두 첫 조건으로 읽고, 문장은 그 조건이나 묶음으로 시작한다.
- 두 조건 사이의 연결자 누락과 뒤따르는 조건이 없는 연결자는 `CONFIG`를 반환한다.
- 묶음 콜백은 같은 타입의 빈 모델을 받는다. 콜백은 조건 메서드만 허용하며 콜백 안의 종단 작업·쓰기·`connect`는 `CONFIG`를 반환한다.
- 괄호는 묶음으로만 작성한다.
- 원시 SQL은 호출한 모델의 컬럼을 `{column}`으로 참조하며 ORM이 모델 별칭을 붙여 출력한다. 값 위치 표시는 `?`만 사용하고 개수가 바인드 개수와 다르면 `IR_INVALID`를 반환한다. 원시 텍스트는 코드가 소유한 SQL에만 사용하며 요청 값은 바인드로 전달한다.

### 2.2 체인

체인은 `And` 또는 `Or`로 구분한 하나 이상의 키다. 각 키는 순서대로 인자 하나를 사용한다.

```text
Chain = Key { ("And" | "Or") Key }
Key   = [Operator] Column
      | Column Operator Column
      | ("Fulltext" | "FulltextBoolean") Column { "With" Column }
      | ["Ne"] "Tuple" Column "With" Column { "With" Column }
```

| 연산자 | SQL |
|---|---|
| 없음, `Eq` | `=` |
| `Ne` | `!=` |
| `Gt`, `Lt`, `Ge`, `Le` | `>`, `<`, `>=`, `<=` |
| `Lk` | 값 앞뒤에 와일드카드를 둔 `LIKE` |
| `Lb` | 값 앞뒤에 와일드카드를 둔 binary `LIKE` |
| `Between` | 길이 2 고정 배열을 받는 `BETWEEN` |
| `Fulltext` | 자연어 모드 전문 검색 |
| `FulltextBoolean` | boolean 모드 전문 검색 |

- `<ColA><Op><ColB>(model)`는 같은 SQL 문장 안에서 호출한 모델의 컬럼 `ColA`와 `model`의 컬럼 `ColB`를 비교한다. `(new Product)->priceGtMinPrice($brand)`는 `a.price > b.min_price`를 출력한다. `Op`는 `Eq`, `Ne`, `Gt`, `Lt`, `Ge`, `Le`다. `on(fn)` 안에서 호출한 모델은 조인 자식이다.
- `tuple<ColA>With<ColB>(list)`는 여러 컬럼을 값 묶음 목록과 비교한다. `tupleTenantIdWithAccountId([[1, 10], [2, 10]])`는 `(tenant_id, account_id) IN ((1, 10), (2, 10))`이다. `Ne`는 `NOT IN`을 만든다. Go는 컬럼마다 필드가 하나인 생성 값 묶음 구조체 `model.<Model><ColA>With<ColB>`, Rust는 튜플, TypeScript는 타입을 지정한 튜플을 사용한다. SQLite는 목록을 `IN (VALUES …)`로 출력한다.
- `getsByServiceSeqAndIsClose(7, 0)`와 `serviceSeq(7)->andIsClose(0)->gets()`는 같은 조건을 만든다.
- 체인은 모든 컬럼을 조합할 수 있다. PHP는 호출 시점에 체인을 해석한다. Go, Rust, TypeScript는 소비자 소스가 호출하는 체인 메서드를 생성하고, 알 수 없는 컬럼·연산자·인자 개수는 생성 단계에서 거부한다.
- 각 언어는 자기 빌드 도구로 생성한다.
  - Go는 `--scan`으로 지정한 패키지를 읽고 호출이 타입 검사를 통과할 때까지 반복한다. `//go:generate` 줄에서 `go run github.com/polyspec/orm/cmd/ormgen gen --schema schema.json --lang go --out model --scan ./...`를 실행한다. 기본 빌드가 `//go:build` 제약으로 제외하는 파일은 그 제약에 필요한 태그, GOOS, GOARCH로 읽으므로 `GOFLAGS=-tags` 없이도 태그를 지정한 테스트를 포함한다.
  - TypeScript는 `--scan`으로 지정한 파일을 TypeScript 컴파일러 API로 읽고 정확한 메서드 시그니처를 작성한다. `tsc` 전에 `build` 스크립트에서 `orm-gen gen --schema schema.json --out src/models --scan src`를 실행한다.
  - Rust는 `build.rs`에서 `scan`으로 지정한 소스를 `syn`으로 읽는다. `orm_build::Builder::new("schema.json").scan("src").generate()`를 실행하고, `orm::models!()`가 결과를 `model` 모듈로 포함한다.
  - PHP는 컬럼 메타데이터와 타입이 있는 getter·setter를 가진 모델 클래스를 작성한다. `vendor/bin/orm-gen gen --schema schema.json --out src/Model --namespace App\Model`을 실행한다.

### 2.3 값 형태

| 값 | 연산자 없음 또는 `Eq` | `Ne` |
|---|---|---|
| 값 하나 | `= ?` | `!= ?` |
| 목록 | `IN (…)` | `NOT IN (…)` |
| 빈 목록 | SQL 실행 전 `EMPTY_IN` | SQL 실행 전 `EMPTY_IN` |
| null | `IS NULL` | `IS NOT NULL` |

```php
->andCoverUrl('a.png')->andCoverUrl(['a', 'b'])->andCoverUrl(null)->andNeSeq([1, 2])
```

```go
.AndCoverUrl("a.png").AndCoverUrl([]string{"a", "b"}).AndCoverUrl(orm.Null).AndNeSeq([]int{1, 2})
```

```rust
.and_cover_url("a.png").and_cover_url(vec!["a", "b"]).and_cover_url(Null).and_ne_seq(vec![1, 2])
```

```ts
.andCoverUrl('a.png').andCoverUrl(['a', 'b']).andCoverUrl(null).andNeSeq([1, 2])
```

- null은 nullable 컬럼에서만 허용한다. Go·Rust·TypeScript는 NOT NULL 컬럼의 null을 컴파일 단계에서 거부하고 PHP는 `CONFIG`를 반환한다.
- 목록은 연산자가 없거나 `Eq`·`Ne`일 때만 허용한다. 다른 연산자는 목록과 null을 거부한다.
- PHP와 TypeScript는 언어의 null 값을 사용한다. Go는 `orm.Null`, Rust는 `Null`을 사용한다.
- Go 메서드는 컬럼별 허용 값 타입을 제네릭 타입 매개변수로 제한한다. 정수 컬럼은 `int`, `int32`, `int64`와 각 타입의 슬라이스를 허용한다.
- 실행하지 않은 모델을 값으로 넘기면 `IN (SELECT …)`, `Ne`와 함께 쓰면 `NOT IN`을 출력한다. 모델은 `addColumn<Col>()`로 컬럼 하나만 추가해야 하며 아니면 `CONFIG`를 반환한다.
- ORM 함수 값은 10절의 함수를 적용한다. 컬럼 함수는 컬럼을 감싸며 비교 값은 메서드의 두 번째 인자다. 예: `andLeLocation(Orm::distance(129.16, 35.16), 2000)`. 값 함수는 비교 값 자체다. 예: `andGtCreatedTs(Orm::daysAgo(7))`.
- `Between`은 길이 2 고정 배열을 받는다. PHP `[1, 10]`, Go `[2]int{1, 10}`, Rust `[1, 10]`, TypeScript `[number, number]` 타입의 `[1, 10]`이다. Go·Rust·TypeScript는 다른 길이를 컴파일 단계에서 거부하고 PHP는 `CONFIG`를 반환한다.

## 3. 조회

| 메서드 | 결과 |
|---|---|
| `get()` | 행 하나; 일치하는 행이 없으면 `NO_ROWS` 오류 |
| `gets()` | 행 컬렉션 |
| `getBy<Chain>(…)` | 체인을 조건으로 사용하는 `get()` |
| `getsBy<Chain>(…)` | 체인을 조건으로 사용하는 `gets()` |
| `getCount()`, `getCountBy<Chain>(…)` | 행 개수 |
| `getsCount()` | `row_count`를 포함한 그룹 행 |
| `sum<Col>()`와 `getSum()` | 컬럼 합계 |
| `avg<Col>()`와 `getAvg()` | 컬럼 평균 |
| `getsPage(page, perPage)` | `items`, `totalCount`, `totalPages`, `page`, `perPage`를 포함한 한 페이지 |
| `getQuery()` | 실행하지 않은 `gets()`의 SQL 문장과 바인드 값 |

- `getsPage`는 같은 조건과 조인으로 행 개수를 계산한다. 그룹 모델은 서로 다른 그룹 키 개수를 계산한다. `page`와 `perPage`는 양수여야 하며 `limit`를 지정한 모델은 `CONFIG`를 반환한다. 마지막 페이지 이후를 요청하면 빈 컬렉션을 반환한다. 화면 출력, 요청 값 읽기, redirect는 애플리케이션의 책임이다.
- 방언이 SQL 문장을 정하므로 `getQuery`는 연결한 모델이나 활성 트랜잭션에서만 사용할 수 있으며 아니면 `CONFIG`를 반환한다. 비밀 값은 `$SECRET`로 표시한다.
- 종단 작업은 체인 값 외의 인자를 받지 않는다. 종단 작업은 모델을 바꾸지 않으므로 두 번째 종단 작업도 같은 SQL 문장을 만든다.
- `keyName<Col>()`은 컬렉션 키 컬럼을 정한다. `fetchKey(fn)`은 컬렉션 키를 계산한다. `fetchValue(fn)`은 조회한 각 행 값을 콜백 결과로 바꾼다.
- 행은 `get<Col>()` getter를 제공한다. 관계 결과는 생성된 관계 getter로 읽는다.

## 4. 컬럼

| 메서드 | 동작 |
|---|---|
| `addColumn<Col>()` | 컬럼 하나 추가 |
| `addColumn<Col>Alias<Name>(format)` | 출력 명칭을 지정한 서식 컬럼 추가 |
| `addColumn<Name>(fn)` | 스칼라 서브쿼리 컬럼 추가. 콜백은 호출한 모델을 받아 실행하지 않은 모델을 반환한다 |
| `addRawColumn<Alias>(sql, binds)` | 출력 명칭을 지정한 원시 컬럼 추가 |
| `removeColumn<Col>()` | 컬럼 하나 제외 |
| `removeAllColumns()` | 기본 키와 외래 키만 유지 |
| `addAllColumns()` | 모든 컬럼 선택 |
| `forceIndex<Name>()` | 모델 테이블에 인덱스 힌트 추가 |

```php
(new User)->connect($slave1)
    ->addColumnCash(fn (User $u) => (new Point)->sumAmount()->toUserSeqEqSeq($u)->andStatus(1))
    ->gets();
// (SELECT COALESCE(SUM(b.amount), 0) FROM point b WHERE b.to_user_seq = a.seq AND b.status = ?) AS cash
```

## 5. 관계와 조인

### 5.1 관계

관계는 부모 키로 별도 질의를 실행하고 결과를 각 부모 행에 연결한다.

```php
$orders = (new Order)->connect($slave1)
    ->relation((new Status)->matchStatusSeqWithSeq()->aliasOrderStatus())
    ->relations((new OrderItem)->matchSeqWithOrderSeq()->groupLimit(5))
    ->orderBySeqDesc()
    ->gets();
```

| 메서드 | 동작 |
|---|---|
| `relation(child)` | 관련 행 하나 연결 |
| `relations(child)` | 관련 행 컬렉션 연결 |
| `match<L>With<R>()` | 부모 컬럼 `L`과 자식 컬럼 `R`이 같음 |
| `alias<Name>()` | 관계 결과 명칭 |
| `parentNode()` | 자식 컬럼을 부모 행에 병합 |
| `possible<Col>(value)` | 부모 컬럼이 값과 같을 때만 자식 조회 |
| `groupLimit(count)` | 부모 키별 자식 행 수 제한 |
| `deleteLock()` | 재귀 삭제에서 관계 제외 |

- `connect`를 호출하지 않은 자식은 부모 연결을 사용한다. `connect`를 호출한 자식은 그 연결에서 질의를 실행한다.
- 관계 결과 명칭은 `relation`이면 `<table>_model`, `relations`이면 `<table>_models`이며 `get<Table>Model()` 또는 `get<Table>Models()`로 읽는다. `alias<Name>()`은 결과 명칭을 바꾸며 결과는 `get<Name>()`으로 읽는다.

```php
$env = (new ServiceEnvironment)->connect($slave1)
    ->relations((new ServiceUrl)->matchSeqWithServiceEnvironmentSeq()->aliasUrls())
    ->relation((new User)->matchWriterSeqWithSeq()->aliasWriter())
    ->relation((new User)->matchEditorSeqWithSeq()->aliasEditor())
    ->getBySeq($seq);
$env->getUrls(); $env->getWriter(); $env->getEditor();
```

### 5.2 조인

조인은 자식 테이블을 같은 SQL 문장에 추가한다.

| 메서드 | SQL |
|---|---|
| `join<L>With<R>(child)` | 부모 컬럼 `L`과 자식 컬럼 `R`로 `INNER JOIN` |
| `leftJoin<L>With<R>(child)` | 부모 컬럼 `L`과 자식 컬럼 `R`로 `LEFT JOIN` |
| 자식의 `on(fn)` | 조건 문법으로 작성한 `ON` 조건 |

```php
$brandLang = (new ProductBrandLang)
    ->on(fn (ProductBrandLang $b) => $b->langId($langId))
    ->lkName($keyword);

(new Product)->connect($slave1)
    ->leftJoinProductBrandSeqWithProductBrandSeq($brandLang)
    ->serviceSeq($serviceSeq)
    ->and(fn (Product $q) => $q->lkName($keyword)->or($brandLang))
    ->gets();
```

```go
brandLang := model.ProductBrandLang().
    On(func(b *model.ProductBrandLangModel) { b.LangId(langId) }).
    LkName(keyword)

rows, err := model.Product().Connect(slave1).
    LeftJoinProductBrandSeqWithProductBrandSeq(brandLang).
    ServiceSeq(serviceSeq).
    And(func(q *model.ProductModel) { q.LkName(keyword).Or(brandLang) }).
    Gets()
```

- 자식은 조인 메서드에 전달하기 전에 설정한다. `on(fn)`은 `ON` 조건을 정하며 콜백은 자식을 받아 조건 문법을 사용한다.
- 자식에 직접 설정한 조건은 `WHERE` 조건이다. `and(model)` 또는 `or(model)`은 그 조건을 해당 위치의 묶음으로 넣는다. 묶음에 전달하지 않은 자식 조건은 `AND`로 추가된다.
- 같은 자식을 두 묶음에 전달하거나 문장에서 조인하지 않은 모델을 전달하면 `CONFIG`를 반환한다.
- 자식 컬럼은 각 행의 자식 결과로 반환된다.
- `connect`를 호출한 조인 자식은 `CONFIG`를 반환한다.

## 6. 정렬과 범위

`orderBy<Col>Asc()`, `orderBy<Col>Desc()`, `orderBySeqDescAndNameAsc()` 같은 체인이 정렬을 정한다. `orderByRandom()`은 방언 함수로 행을 무작위 정렬한다. `groupBy<Col>()`은 그룹을 정한다. `orderByRaw(sql)`와 `groupByRaw(sql)`는 2.1절 규칙에 따른 원시 식을 사용한다. `limit(offset, count)`은 범위를 정한다.

## 7. 쓰기

| 메서드 | 동작 |
|---|---|
| `set<Col>(value)` | 저장 컬럼 값. 컬럼이 존재해야 한다 |
| `setRaw<Col>(sql, binds)` | 스키마 검사를 거친 SQL 식으로 만든 저장 컬럼 값 |
| `new<Name>(value)` | 컬럼이 아닌 명칭으로 값을 행에 추가. 아래 규칙 참고 |
| `plus<Col>(n)`, `minus<Col>(n)` | 바인드한 증가·감소. `minus`는 음수를 저장하지 않는다 |
| `create()` | 삽입 후 생성 키를 포함한 행 반환 |
| `creates(models)` | `set<Col>`로 만든 모델을 하나의 트랜잭션에서 여러 행 문장으로 삽입하고 삽입한 행 수 반환. 모든 모델은 같은 컬럼을 설정해야 한다 |
| `duplication(model)`과 `create()` | `model`의 변경 값으로 중복 키 갱신을 포함한 삽입 |
| `update()` | 행의 변경 컬럼 갱신 |
| `update(true)` | 저장된 `updated_ts`가 조회 값과 같을 때만 갱신, 다르면 `OPTIMISTIC_LOCK` |
| `save()` | 기본 키가 있으면 `update()`, 없으면 `create()` |
| `delete()` | 행 또는 컬렉션의 모든 행 삭제 |
| `delete(true)` | `deleteLock()` 관계를 제외하고 조회한 관계 행을 재귀 삭제 |

쓰기가 성공하면 속성 변경 기록을 비운다.

- `new<Name>`은 계산한 금액이나 화면용 표시 값처럼 행이 출력까지 전달하는 데이터를 추가한다. 이 값은 `INSERT`, `UPDATE`, `SELECT` 문장에 사용하지 않는다. 조회와 쓰기 뒤에도 `get<Name>()`, `toArray()`, JSON 출력에 포함되며 `create()`가 반환한 모델도 추가한 값을 유지한다.
- `new<Name>`에 실제 컬럼 명칭을 사용하면 거부한다. 저장 컬럼 값은 `set<Col>`을 사용한다.
- Go와 Rust는 소비자 소스가 호출하는 명칭의 `New<Name>`과 `Get<Name>`을 생성한다. 값 타입은 Go의 `any`, Rust의 공통 값 타입이다.

```php
$item = (new CartItem)->connect($master)
    ->setProductSeq(5)->setQuantity(2)
    ->newAmount(24000)          // INSERT 문장에 포함하지 않음
    ->create();
$item->getAmount();             // 24000
```

## 8. 트랜잭션

```php
$order = $master->transaction(function () use ($data) {
    $order = (new Order)->setServiceSeq($data['service_seq'])->create();
    (new OrderItem)->setOrderSeq($order->getSeq())->setAmount($data['amount'])->create();

    return $order;
});
```

```go
err := master.Transaction(func() error {
    order, err := model.Order().SetServiceSeq(serviceSeq).Create()
    if err != nil {
        return err
    }
    _, err = model.OrderItem().SetOrderSeq(order.GetSeq()).SetAmount(amount).Create()
    return err
})
```

```rust
master.transaction(async || {
    let order = Order::new().set_service_seq(service_seq).create().await?;
    OrderItem::new().set_order_seq(order.seq).set_amount(amount).create().await?;
    Ok(())
}).await?;
```

```ts
await master.transaction(async () => {
  const order = await new Order().setServiceSeq(serviceSeq).create()
  await new OrderItem().setOrderSeq(order.getSeq()).setAmount(amount).create()
})
```

- 콜백 오류나 예외는 트랜잭션을 되돌린다. 교착 상태는 재시도한다.
- 활성 트랜잭션 안에서 같은 연결의 트랜잭션을 호출하면 savepoint를 만든다.
- 두 트랜잭션을 동시에 열어야 하면 연결이 두 개여야 한다. 한 연결의 두 번째 트랜잭션은 첫 트랜잭션의 savepoint가 되기 때문이다. 잠금 경합도 이렇게 쓴다: 한 연결이 행을 잡고 다른 연결이 기다린다.
- 하나의 트랜잭션 연결을 동시에 사용하면 오류를 반환한다.
- 실행 흐름은 Go에서 goroutine, PHP에서 요청, Rust에서 tokio task, TypeScript에서 `AsyncLocalStorage` 컨텍스트다. 콜백 안에서 시작한 goroutine이나 새 Rust task에는 활성 트랜잭션이 없다. Go 하위 테스트도 이런 goroutine이므로, 그 안에서 연 트랜잭션은 바깥이 쥔 연결을 기다리는 별개 트랜잭션이 된다. TypeScript에서 콜백 안에서 시작한 비동기 작업은 콜백의 컨텍스트와 트랜잭션을 공유하며, 그 트랜잭션에서 다른 문장과 겹친 문장은 `CONFIG`를 반환한다.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, `forShareNoWait()`는 트랜잭션 안에서만 허용한다.
- begin, commit, rollback은 공개하지 않는다.

옵션은 `isolation`, `readOnly`, `timeoutMs`, `retry`(기본값 `3`, `0`이면 재시도하지 않음)다. 생략한 옵션은 기본값을 유지한다.

```php
$master->transaction(fn () => …, isolation: 'serializable', readOnly: true, timeoutMs: 500, retry: 0);
```

```go
err := master.Transaction(func() error { … },
    orm.Isolation(orm.Serializable), orm.ReadOnly(), orm.TimeoutMs(500), orm.Retry(0))
```

```rust
master.transaction(async || { … })
    .isolation(Isolation::Serializable).read_only().timeout_ms(500).retry(0).await?;
```

```ts
await master.transaction(async () => { … }, { isolation: 'serializable', readOnly: true, timeoutMs: 500, retry: 0 })
```

활성 트랜잭션 안에서 같은 연결의 트랜잭션은 `retry`만 받으며 그 값은 사용하지 않는다. savepoint는 바깥 트랜잭션에 포함된다.

## 9. 예약 명칭

생성기는 메서드 명칭이 예약 메서드(`and`, `or`, `get`, `gets`, `getsPage`, `getQuery`, `limit`, `alias`, `connect`, `create`, `creates`, `update`, `delete`, `save`, `raw`, `on`)와 같거나 예약 접두어(`and`, `or`, `get`, `set`, `new`, `plus`, `minus`, `orderBy`, `groupBy`, `tuple`, 연산자)로 시작하는 컬럼을 거부한다. `orderByRandom()`이 예약되어 있으므로 `random` 컬럼도 거부한다.

행에 추가되는 명칭은 하나의 명칭 공간을 사용한다. 대상은 실제 컬럼, `addColumn<Name>(fn)`이나 `addRawColumn<Alias>`로 추가한 컬럼, 관계 결과 명칭, `new<Name>` 명칭이다. 이 공간에서 명칭이 겹치면 거부한다. Go와 Rust는 생성 단계에서 거부하고 PHP와 TypeScript는 `CONFIG`를 반환한다. 따라서 같은 테이블에 대한 관계 두 개는 서로 다른 별칭이 필요하며, 서브쿼리 컬럼은 실제 컬럼이 아닌 명칭을 사용해야 한다.

메서드 명칭이 모델의 다른 생성 메서드와 같은 컬럼도 거부한다. 예를 들어 `amount` 옆의 `sum_amount`는 `sumAmount()`와 겹친다.

컬럼 명칭은 밑줄로 나눈 조각에 `and`, `or`, `with`, `gt`, `lt`, `ge`, `le`, `eq`, `ne`, `lk`, `lb`, `between`, `fulltext`, `tuple`을 포함할 수 없다. 예를 들어 `price_gt_limit`와 `with_tax`는 거부하고 `min_price`는 허용한다.

## 10. ORM 함수

ORM 함수 값은 함수 종류와 인자를 가진다. 함수 값을 받은 모델 메서드가 모델 별칭·컬럼·연산자를 기록하고, 클라이언트 플래너가 연결의 방언에 맞는 SQL을 출력한다.

| 용도 | 형태 |
|---|---|
| 조건의 컬럼 함수 | `and<Op><Col>(Orm::distance(129.16, 35.16), 2000)` |
| 조건의 값 함수 | `and<Op><Col>(Orm::daysAgo(7))` |
| 컬럼으로 쓰는 컬럼 함수 | `addColumn<Col>Alias<Name>(Orm::distance(129.16, 35.16))` |
| 정렬에 쓰는 컬럼 함수 | `orderBy<Col>Asc(Orm::distance(129.16, 35.16))` |

Go는 `orm.Distance(…)`, Rust는 `orm::distance(…)`, TypeScript는 `orm.distance(…)`를 사용한다.

### 10.1 값 함수

| 함수 | MySQL | PostgreSQL | SQLite |
|---|---|---|---|
| `now()` | `NOW()` | `now()` | 클라이언트가 연결 시간대로 계산해 바인드한 값 |
| `today()` | `CURDATE()` | `CURRENT_DATE` | 클라이언트가 계산해 바인드한 값 |
| `secondsAgo(n)`, `minutesAgo(n)`, `hoursAgo(n)`, `daysAgo(n)`, `monthsAgo(n)` | `DATE_SUB(NOW(), INTERVAL ? unit)` | `now() - make_interval(unit => ?)` | 클라이언트가 계산해 바인드한 값 |
| `secondsLater(n)`, `minutesLater(n)`, `hoursLater(n)`, `daysLater(n)`, `monthsLater(n)` | `DATE_ADD(NOW(), INTERVAL ? unit)` | `now() + make_interval(unit => ?)` | 클라이언트가 계산해 바인드한 값 |

- 연결 시간대는 DSN의 `timezone` 매개변수에서 받고, 없으면 서버 환경의 시간대를 사용한다. MySQL과 PostgreSQL 연결은 세션 시간대를 설정한다.
- 월 계산은 MySQL, PostgreSQL과 같이 대상 월의 마지막 유효 일자를 유지한다.

### 10.2 컬럼 함수

| 함수 | 컬럼 | MySQL | PostgreSQL | SQLite |
|---|---|---|---|---|
| `dayOfWeek()` (1 = 일요일 … 7) | 날짜·시각 | `DAYOFWEEK(c)` | `(EXTRACT(DOW FROM c)::int + 1)` | `(CAST(strftime('%w', c) AS INTEGER) + 1)` |
| `year()` | 날짜·시각 | `YEAR(c)` | `EXTRACT(YEAR FROM c)::int` | `CAST(strftime('%Y', c) AS INTEGER)` |
| `month()` | 날짜·시각 | `MONTH(c)` | `EXTRACT(MONTH FROM c)::int` | `CAST(strftime('%m', c) AS INTEGER)` |
| `date()` | 날짜·시각 | `DATE(c)` | `CAST(c AS date)` | `date(c)` |
| `distance(longitude, latitude)` | point | `ST_Distance_Sphere(c, ST_GeomFromText(?))` | PostGIS가 있으면 `ST_DistanceSphere`, 없으면 `c[0]`, `c[1]`의 하버사인 식 | 저장한 `POINT(x y)` 텍스트 좌표의 하버사인 식 |
| `pointX()`, `pointY()` | point | `c`의 경도와 위도 | `c[0]`, `c[1]` | 저장한 `POINT(x y)` 텍스트의 좌표 |

- `distance`는 MySQL `ST_Distance_Sphere`와 같은 반지름 6,370,986 m 구면에서 미터를 반환한다. point 값은 `[경도, 위도]`다.
- SQLite 하버사인 식은 SQLite 수학 함수가 필요하다. 연결이 이를 확인하며 사용할 수 없으면 `distance`는 `CAPABILITY_UNSUPPORTED`를 반환한다.
- 목록에 없는 컬럼 타입에 컬럼 함수를 사용하면 `OPERATOR_NOT_ALLOWED`를 반환한다.
- SQLite는 `decimal` 값을 부동소수점으로 저장하므로 SQLite의 십진 계산 결과는 MySQL, PostgreSQL과 다를 수 있다. ORM은 SQLite 저장 형식을 바꾸지 않는다.
- SQLite 최소 버전은 3.46이다.
