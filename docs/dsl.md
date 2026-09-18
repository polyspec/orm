# DSL

This page specifies the query syntax defined by the [design plan](plan.md). Client status is recorded in the [implementation matrix](interface-implementation.md); a client that does not yet match this page is incomplete.

## 1. Model and connection

A query starts with a model. A model is created in the language form and receives a database connection through `connect`.

| Language | Creation | Connected model | Connected loaded row |
|---|---|---|---|
| PHP | `new Product` | `(new Product)->connect($slave1)` | `$row->connect($master)` |
| Go | `model.Product()` | `model.Product().Connect(slave1)` | `row.Connect(master)` |
| Rust | `Product::new()` | `Product::new().connect(&slave1)` | `row.connect(&master)` |
| TypeScript | `new Product()` | `new Product().connect(slave1)` | `row.connect(master)` |

- `connect` is the only connection method. A loaded row or collection uses the same method before a write, so rows read from a replica are written through the primary connection.
- PHP accepts `(new Product)($slave1)` and `$row($master)` as the short form of `connect`.
- Go uses functions in the generated `model` package. `model.Product()` returns `*model.ProductModel`.
- Inside a transaction callback, a model without `connect` uses the active transaction of the current execution flow. Outside a transaction, a terminal or write on a model without `connect` returns `CONFIG`.

## 2. Conditions

### 2.1 Connectors and groups

The first condition has no prefix; a prefix written on it is dropped. Each following condition starts with `and` or `or`, either inside the method name or as a separate connector.

```php
(new Product)->connect($slave1)
    ->serviceSeq($serviceSeq)
    ->andIsClose(0)
    ->or()->isSale(2)
    ->and(fn (Product $q) => $q->isSale(1)->andLtSaleStartDt($now))
    ->gets();
```

| Form | Meaning |
|---|---|
| `<Chain>(…)` | first condition of the model or group |
| `and<Chain>(…)`, `or<Chain>(…)` | condition joined with `AND` or `OR` |
| `and()`, `or()` followed by `<Chain>(…)` | the same connection written as a separate call |
| `and(fn)`, `or(fn)` | parenthesized group joined with `AND` or `OR` |
| `and(model)`, `or(model)` | parenthesized group of the conditions set on a joined model |
| `raw(sql, binds)`, `andRaw(sql, binds)`, `orRaw(sql, binds)` | raw condition as the first or a following condition |

- A connector at the start of a model or a group has nothing to join, so it is dropped: `and(fn)`, `or(fn)`, `and()`, `or()`, `and<Chain>(…)`, and `or<Chain>(…)` all read as the first condition, and the statement starts with that condition or group.
- A missing connector between two conditions and a connector without a following condition return `CONFIG`.
- A group callback receives an empty model of the same type. The callback accepts condition methods only; a terminal, write, or `connect` inside the callback returns `CONFIG`.
- A group is the only way to write parentheses.
- Raw SQL references columns of the calling model as `{column}`, which the ORM renders with the model alias. `?` is the only value placeholder, and the placeholder count must equal the bind count; otherwise `IR_INVALID` is returned. Raw text is for code-owned SQL, and request values are passed as binds.

### 2.2 Chains

A chain lists one or more keys separated by `And` or `Or`. Each key consumes one argument in order.

```text
Chain = Key { ("And" | "Or") Key }
Key   = [Operator] Column
      | Column Operator Column
      | ("Fulltext" | "FulltextBoolean") Column { "With" Column }
      | ["Ne"] "Tuple" Column "With" Column { "With" Column }
```

| Operator | SQL |
|---|---|
| none, `Eq` | `=` |
| `Ne` | `!=` |
| `Gt`, `Lt`, `Ge`, `Le` | `>`, `<`, `>=`, `<=` |
| `Lk` | `LIKE` with the value between wildcards |
| `Lb` | binary `LIKE` with the value between wildcards |
| `Between` | `BETWEEN` with a fixed two-value array |
| `Fulltext` | full-text match in natural-language mode |
| `FulltextBoolean` | full-text match in boolean mode |

- `<ColA><Op><ColB>(model)` compares column `ColA` of the calling model with column `ColB` of `model` in the same statement. `(new Product)->priceGtMinPrice($brand)` renders `a.price > b.min_price`. `Op` is `Eq`, `Ne`, `Gt`, `Lt`, `Ge`, or `Le`. Inside `on(fn)` the calling model is the join child.
- `tuple<ColA>With<ColB>(list)` compares several columns with a list of value groups, such as `tupleTenantIdWithAccountId([[1, 10], [2, 10]])` for `(tenant_id, account_id) IN ((1, 10), (2, 10))`. `Ne` produces `NOT IN`. Go uses the generated value group struct `model.<Model><ColA>With<ColB>` with one field per column, Rust uses tuples, and TypeScript uses typed tuples. SQLite renders the list as `IN (VALUES …)`.
- `getsByServiceSeqAndIsClose(7, 0)` and `serviceSeq(7)->andIsClose(0)->gets()` produce the same condition.
- A chain can combine any columns. PHP resolves chains at call time. Go, Rust, and TypeScript generate the chain methods that consumer source code calls and reject an unknown column, operator, or argument count during generation.
- Each language generates with its own build tool:
  - Go scans the packages named by `--scan` and repeats until the calls type-check: `go run github.com/polyspec/orm/cmd/ormgen gen --schema schema.json --lang go --out model --scan ./...` in a `//go:generate` line. Files that the default build excludes with a `//go:build` constraint are loaded with the tags, GOOS, and GOARCH their constraint needs, so a tagged test is covered without `GOFLAGS=-tags`.
  - TypeScript scans the files named by `--scan` with the TypeScript compiler API and writes exact method signatures: `orm-gen gen --schema schema.json --out src/models --scan src` in the `build` script before `tsc`.
  - Rust scans the sources named by `scan` with `syn` in `build.rs`: `orm_build::Builder::new("schema.json").scan("src").generate()`, and `orm::models!()` includes the result as the module `model`.
  - PHP writes the model classes with column metadata and typed getters and setters: `vendor/bin/orm-gen gen --schema schema.json --out src/Model --namespace App\Model`.

### 2.3 Value shapes

| Value | Without operator or `Eq` | `Ne` |
|---|---|---|
| one value | `= ?` | `!= ?` |
| list | `IN (…)` | `NOT IN (…)` |
| empty list | `EMPTY_IN` before SQL execution | `EMPTY_IN` before SQL execution |
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

- Null is accepted only for nullable columns. Go, Rust, and TypeScript reject null for a non-null column at compile time; PHP returns `CONFIG`.
- Lists are accepted only without an operator, with `Eq`, and with `Ne`. Other operators reject lists and null.
- PHP and TypeScript use the language null value. Go uses `orm.Null` and Rust uses `Null`.
- Go methods use generic type parameters with the allowed value types of each column. Integer columns accept `int`, `int32`, `int64`, and slices of those types.
- An unexecuted model as the value renders `IN (SELECT …)`, or `NOT IN` with `Ne`. The model must add exactly one column with `addColumn<Col>()`; otherwise `CONFIG` is returned.
- An ORM function value applies a function from section 10. A column function wraps the column, and the compared value is the second method argument, for example `andLeLocation(Orm::distance(129.16, 35.16), 2000)`. A value function is the compared value, for example `andGtCreatedTs(Orm::daysAgo(7))`.
- `Between` takes a fixed two-value array: PHP `[1, 10]`, Go `[2]int{1, 10}`, Rust `[1, 10]`, and TypeScript `[1, 10]` typed as `[number, number]`. Go, Rust, and TypeScript reject another length at compile time; PHP returns `CONFIG`.

## 3. Reads

| Method | Result |
|---|---|
| `get()` | one row, or null when no row matches |
| `gets()` | collection of rows |
| `getBy<Chain>(…)` | `get()` with the chain as condition |
| `getsBy<Chain>(…)` | `gets()` with the chain as condition |
| `getCount()`, `getCountBy<Chain>(…)` | row count |
| `getsCount()` | grouped rows with `row_count` |
| `sum<Col>()` with `getSum()` | sum of the column |
| `avg<Col>()` with `getAvg()` | average of the column |
| `getsPage(page, perPage)` | one page with `items`, `totalCount`, `totalPages`, `page`, and `perPage` |
| `getQuery()` | statement text and binds of `gets()` without execution |

- `getsPage` counts rows with the same conditions and joins; a grouped model counts distinct group keys. `page` and `perPage` must be positive, and a model with `limit` returns `CONFIG`. A page after the last page returns an empty collection. Rendering, request reading, and redirects belong to the application.
- `getQuery` requires a connected model or an active transaction because the dialect decides the statement text; otherwise it returns `CONFIG`. Secret values are shown as `$SECRET`.
- Terminals take no arguments except chain values. A terminal does not change the model, so running a second terminal produces the same statement.
- `keyName<Col>()` sets the collection key column. `fetchKey(fn)` computes the collection key. `fetchValue(fn)` replaces each loaded row value with the callback result.
- A row exposes `get<Col>()` getters. A relation result is read through the generated relation getter.

## 4. Columns

| Method | Effect |
|---|---|
| `addColumn<Col>()` | add one column |
| `addColumn<Col>Alias<Name>(format)` | add a formatted column with an output name |
| `addColumn<Name>(fn)` | add a scalar subquery column; the callback receives the calling model and returns an unexecuted model |
| `addRawColumn<Alias>(sql, binds)` | add a raw column with an output name |
| `removeColumn<Col>()` | remove one column |
| `removeAllColumns()` | keep only primary and foreign keys |
| `addAllColumns()` | select every column |
| `forceIndex<Name>()` | add an index hint for the model table |

```php
(new User)->connect($slave1)
    ->addColumnCash(fn (User $u) => (new Point)->sumAmount()->toUserSeqEqSeq($u)->andStatus(1))
    ->gets();
// (SELECT COALESCE(SUM(b.amount), 0) FROM point b WHERE b.to_user_seq = a.seq AND b.status = ?) AS cash
```

## 5. Relations and joins

### 5.1 Relations

A relation runs a separate query for the parent keys and attaches the result to each parent row.

```php
$orders = (new Order)->connect($slave1)
    ->relation((new Status)->matchStatusSeqWithSeq()->aliasOrderStatus())
    ->relations((new OrderItem)->matchSeqWithOrderSeq()->groupLimit(5))
    ->orderBySeqDesc()
    ->gets();
```

| Method | Effect |
|---|---|
| `relation(child)` | attach one related row |
| `relations(child)` | attach a collection of related rows |
| `match<L>With<R>()` | parent column `L` equals child column `R` |
| `alias<Name>()` | result name of the relation |
| `parentNode()` | merge child columns into the parent row |
| `possible<Col>(value)` | load the child only when the parent column equals the value |
| `groupLimit(count)` | limit child rows per parent key |
| `deleteLock()` | exclude the relation from recursive delete |

- A child without `connect` uses the parent connection. A child with `connect` runs its query on that connection.
- A relation result is named `<table>_model` for `relation` and `<table>_models` for `relations`, and is read with `get<Table>Model()` or `get<Table>Models()`. `alias<Name>()` replaces the result name, and the result is read with `get<Name>()`.

```php
$env = (new ServiceEnvironment)->connect($slave1)
    ->relations((new ServiceUrl)->matchSeqWithServiceEnvironmentSeq()->aliasUrls())
    ->relation((new User)->matchWriterSeqWithSeq()->aliasWriter())
    ->relation((new User)->matchEditorSeqWithSeq()->aliasEditor())
    ->getBySeq($seq);
$env->getUrls(); $env->getWriter(); $env->getEditor();
```

### 5.2 Joins

A join adds the child table to the same statement.

| Method | SQL |
|---|---|
| `join<L>With<R>(child)` | `INNER JOIN` on parent column `L` and child column `R` |
| `leftJoin<L>With<R>(child)` | `LEFT JOIN` on parent column `L` and child column `R` |
| `on(fn)` on the child | `ON` conditions written with the condition grammar |

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

- The child is configured before it is passed to the join method. `on(fn)` sets the `ON` conditions; the callback receives the child and uses the condition grammar.
- Conditions set directly on the child are `WHERE` conditions. `and(model)` or `or(model)` places them as a group at that position. When the child is not passed to a group, its conditions are appended with `AND`.
- Passing the same child to two groups, or passing a model that is not joined in the statement, returns `CONFIG`.
- Child columns are returned on the child result of each row.
- A join child with `connect` returns `CONFIG`.

## 6. Order and range

`orderBy<Col>Asc()`, `orderBy<Col>Desc()`, and chains such as `orderBySeqDescAndNameAsc()` set the order. `orderByRandom()` orders rows randomly with the dialect function. `groupBy<Col>()` sets grouping. `orderByRaw(sql)` and `groupByRaw(sql)` use raw expressions with the rules in section 2.1. `limit(offset, count)` sets the range.

## 7. Writes

| Method | Effect |
|---|---|
| `set<Col>(value)` | stored column value; the column must exist |
| `setRaw<Col>(sql, binds)` | stored column value from a schema-checked SQL expression |
| `new<Name>(value)` | attach a value under a name that is not a column; see the rules below |
| `plus<Col>(n)`, `minus<Col>(n)` | bound increment and decrement; `minus` never stores a negative value |
| `create()` | insert and return the row with its generated key |
| `creates(models)` | insert models created with `set<Col>` in multi-row statements in one transaction and return the inserted row count; every model must set the same columns |
| `duplication(model)` with `create()` | insert with duplicate-key update from the changes of `model` |
| `update()` | update changed columns of the row |
| `update(true)` | update only when the stored `updated_ts` equals the value that was read; otherwise `OPTIMISTIC_LOCK` |
| `save()` | `update()` when the primary key is set, otherwise `create()` |
| `delete()` | delete the row or every row of a collection |
| `delete(true)` | delete loaded relation rows recursively, except relations marked with `deleteLock()` |

Attribute changes are cleared after a successful write.

- `new<Name>` attaches data that the row carries to its output, such as a computed amount or a flag for a view. The value is not used in `INSERT`, `UPDATE`, or `SELECT` statements. `get<Name>()`, `toArray()`, and JSON output include it after reads and writes; a model returned by `create()` keeps the attached values.
- A real column name in `new<Name>` is rejected; stored column values use `set<Col>`.
- Go and Rust generate `New<Name>` and `Get<Name>` for the names that consumer source code calls. The value type is `any` in Go and the common value type in Rust.

```php
$item = (new CartItem)->connect($master)
    ->setProductSeq(5)->setQuantity(2)
    ->newAmount(24000)          // not part of the INSERT statement
    ->create();
$item->getAmount();             // 24000
```

## 8. Transactions

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

- A callback error or exception rolls back the transaction. Deadlocks are retried.
- A transaction on the same connection inside an active transaction creates a savepoint.
- Two transactions that must be open at the same time need two connections, because a second transaction on one connection becomes a savepoint of the first. Lock contention is written that way: one connection holds the row and another waits for it.
- Concurrent use of one transaction connection returns an error.
- The execution flow is the goroutine in Go, the request in PHP, the tokio task in Rust, and the `AsyncLocalStorage` context in TypeScript. A goroutine or spawned Rust task started inside the callback has no active transaction; a Go subtest is such a goroutine, so a transaction opened in one is a separate transaction that waits for the connection held outside it. In TypeScript, asynchronous work started inside the callback shares the callback's context and therefore the transaction; a statement that overlaps another statement on it returns `CONFIG`.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, and `forShareNoWait()` are allowed only inside a transaction.
- Begin, commit, and rollback are not public.

The options are `isolation`, `readOnly`, `timeoutMs`, and `retry` (default `3`, `0` disables retry). An omitted option keeps its default.

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

A transaction of the same connection inside an active one accepts only `retry`, which it ignores; the savepoint joins the outer transaction.

## 9. Reserved names

The generator rejects a column whose method name matches a reserved method (`and`, `or`, `get`, `gets`, `getsPage`, `getQuery`, `limit`, `alias`, `connect`, `create`, `creates`, `update`, `delete`, `save`, `raw`, `on`) or starts with a reserved prefix (`and`, `or`, `get`, `set`, `new`, `plus`, `minus`, `orderBy`, `groupBy`, `tuple`, or an operator). A column named `random` is rejected because `orderByRandom()` is reserved.

The names attached to a row form one name space: real columns, columns added with `addColumn<Name>(fn)` or `addRawColumn<Alias>`, relation result names, and `new<Name>` names. A duplicate name in this space is rejected. Go and Rust reject it during generation; PHP and TypeScript return `CONFIG`. Two relations to the same table therefore need different aliases, and a subquery column needs a name that is not a real column.

A column whose method name equals another generated method of the model, such as `sum_amount` next to `amount` (`sumAmount()`), is rejected.

A column name also must not contain any of these underscore-separated segments: `and`, `or`, `with`, `gt`, `lt`, `ge`, `le`, `eq`, `ne`, `lk`, `lb`, `between`, `fulltext`, `tuple`. For example, `price_gt_limit` and `with_tax` are rejected, and `min_price` is accepted.

## 10. ORM functions

An ORM function value carries a function kind and its arguments. The model method that receives it records the model alias, column, and operator, and the client planner renders SQL for the connection dialect.

| Use | Form |
|---|---|
| column function in a condition | `and<Op><Col>(Orm::distance(129.16, 35.16), 2000)` |
| value function in a condition | `and<Op><Col>(Orm::daysAgo(7))` |
| column function as a column | `addColumn<Col>Alias<Name>(Orm::distance(129.16, 35.16))` |
| column function in ordering | `orderBy<Col>Asc(Orm::distance(129.16, 35.16))` |

Go uses `orm.Distance(…)`, Rust uses `orm::distance(…)`, and TypeScript uses `orm.distance(…)`.

### 10.1 Value functions

| Function | MySQL | PostgreSQL | SQLite |
|---|---|---|---|
| `now()` | `NOW()` | `now()` | value computed by the client in the connection time zone and bound |
| `today()` | `CURDATE()` | `CURRENT_DATE` | value computed by the client and bound |
| `secondsAgo(n)`, `minutesAgo(n)`, `hoursAgo(n)`, `daysAgo(n)`, `monthsAgo(n)` | `DATE_SUB(NOW(), INTERVAL ? unit)` | `now() - make_interval(unit => ?)` | value computed by the client and bound |
| `secondsLater(n)`, `minutesLater(n)`, `hoursLater(n)`, `daysLater(n)`, `monthsLater(n)` | `DATE_ADD(NOW(), INTERVAL ? unit)` | `now() + make_interval(unit => ?)` | value computed by the client and bound |

- The connection time zone comes from the DSN `timezone` parameter; without it the server environment time zone is used. MySQL and PostgreSQL connections set the session time zone.
- Month arithmetic keeps the last valid day of the target month, as MySQL and PostgreSQL do.

### 10.2 Column functions

| Function | Columns | MySQL | PostgreSQL | SQLite |
|---|---|---|---|---|
| `dayOfWeek()` (1 = Sunday … 7) | date and time | `DAYOFWEEK(c)` | `(EXTRACT(DOW FROM c)::int + 1)` | `(CAST(strftime('%w', c) AS INTEGER) + 1)` |
| `year()` | date and time | `YEAR(c)` | `EXTRACT(YEAR FROM c)::int` | `CAST(strftime('%Y', c) AS INTEGER)` |
| `month()` | date and time | `MONTH(c)` | `EXTRACT(MONTH FROM c)::int` | `CAST(strftime('%m', c) AS INTEGER)` |
| `date()` | date and time | `DATE(c)` | `CAST(c AS date)` | `date(c)` |
| `distance(longitude, latitude)` | point | `ST_Distance_Sphere(c, ST_GeomFromText(?))` | PostGIS `ST_DistanceSphere` when installed; otherwise the haversine formula on `c[0]` and `c[1]` | haversine formula on the coordinates of the stored `POINT(x y)` text |
| `pointX()`, `pointY()` | point | longitude and latitude of `c` | `c[0]`, `c[1]` | coordinates of the stored `POINT(x y)` text |

- `distance` returns meters on a sphere with radius 6,370,986 m, the radius used by MySQL `ST_Distance_Sphere`. Point values are `[longitude, latitude]`.
- The SQLite haversine formula requires SQLite math functions. The connection checks them, and `distance` returns `CAPABILITY_UNSUPPORTED` when they are unavailable.
- A column function on a column type that it does not list returns `OPERATOR_NOT_ALLOWED`.
- SQLite stores `decimal` values as floating-point numbers, so decimal arithmetic in SQLite can differ from MySQL and PostgreSQL. The ORM does not change the SQLite storage.
- The minimum SQLite version is 3.46.
