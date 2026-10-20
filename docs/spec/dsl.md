<!-- doc-id: dsl -->
# DSL

This page specifies the query syntax defined by the [design plan](plan.md). Client status is recorded in the [implementation matrix](interface-implementation.md); a client that does not yet match this page is incomplete.

## 1. Model and connection

- **DSL-1** A query starts with a model. A model is created in the language form and receives a database connection through `connect`.

- **DSL-2** PHP — Creation: `new Product`; Connected model: `(new Product)->connect($slave1)`; Connected loaded row: `$row->connect($master)`
- **DSL-3** Go — Creation: `model.Product()`; Connected model: `model.Product().Connect(slave1)`; Connected loaded row: `row.Connect(master)`
- **DSL-4** Python — Creation: `Product()`; Connected model: `Product().connect(slave1)`; Connected loaded row: `row.connect(master)`
- **DSL-5** Rust — Creation: `Product::new()`; Connected model: `Product::new().connect(&slave1)`; Connected loaded row: `row.connect(&master)`
- **DSL-6** TypeScript — Creation: `new Product()`; Connected model: `new Product().connect(slave1)`; Connected loaded row: `row.connect(master)`

- **DSL-7** `connect` is the only connection method. A loaded row or collection uses the same method before a write, so rows read from a replica are written through the primary connection.
- **DSL-8** PHP accepts `(new Product)($slave1)` and `$row($master)` as the short form of `connect`.
- **DSL-9** Go uses functions in the generated `model` package. `model.Product()` returns `*model.ProductModel`.
- **DSL-10** Inside a transaction callback, a model without `connect` uses the active transaction of the current execution flow. Outside a transaction, a terminal or write on a model without `connect` returns `CONFIG`.

## 2. Conditions

### 2.1 Connectors and groups

- **DSL-11** The first condition has no prefix; a prefix written on it is dropped. Each following condition starts with `and` or `or`, either inside the method name or as a separate connector.

```php
(new Product)->connect($slave1)
    ->serviceSeq($serviceSeq)
    ->andIsClose(0)
    ->or()->isSale(2)
    ->and(fn (Product $q) => $q->isSale(1)->andLtSaleStartDt($now))
    ->gets();
```

- **DSL-12** `<Chain>(…)` — Meaning: first condition of the model or group
- **DSL-13** `and<Chain>(…)`, `or<Chain>(…)` — Meaning: condition joined with `AND` or `OR`
- **DSL-14** `and()`, `or()` followed by `<Chain>(…)` — Meaning: the same connection written as a separate call
- **DSL-15** `and(fn)`, `or(fn)` — Meaning: parenthesized group joined with `AND` or `OR`
- **DSL-16** `not(fn)`, `andNot(fn)`, `orNot(fn)` — Meaning: negated group `NOT (…)` as the first condition or joined with `AND` or `OR`
- **DSL-17** `and(model)`, `or(model)` — Meaning: parenthesized group of the conditions set on a joined model

- **DSL-18** A connector at the start of a model or a group has nothing to join, so it is dropped: `and(fn)`, `or(fn)`, `and()`, `or()`, `and<Chain>(…)`, and `or<Chain>(…)` all read as the first condition, and the statement starts with that condition or group.
- **DSL-19** A missing connector between two conditions and a connector without a following condition return `CONFIG`.
- **DSL-20** A group callback receives an empty model of the same type. The callback accepts condition methods only; a terminal, write, or `connect` inside the callback returns `CONFIG`.
- **DSL-21** A group is the only way to write parentheses.

- **DSL-22** `not(fn)` negates its group as a whole; a negated group always has parentheses. Rust names the two joined forms `and_not` and `or_not`. A callback that adds no condition returns `CONFIG`.

### 2.1.1 Query expression grammar

- **DSL-23** A condition is one expression of a neutral grammar: it renders and means the same on MySQL, PostgreSQL and SQLite. Its element set is the predicate set of a dbspec `check` ([dbspec](dbspec.md#checks)): a comparison (`=`, `<>`, `<`, `<=`, `>`, `>=`), `in`, `is [not] null`, `and`, `or` and grouping, whose operands are columns and values. A value is a typed bind: it takes the dbspec type of the column it meets, or the result type of the column function it is compared with ([dialects](dialects.md)), never a literal written into the SQL. A query adds three extensions that a `check` does not have, because introspection cannot restore them from a database and a query is never introspected:

  - `not` through `not(fn)`, `andNot(fn)` and `orNot(fn)`;
  - `between` through the `Between` operator, which every database renders as `BETWEEN`;
  - the column functions `year`, `month`, `dayOfWeek` and `date` and the value functions `now`, `today`, `<unit>Ago` and `<unit>Later` (section 10), each with one rendering per database.

- **DSL-24** The existing `Lk`, `Lb`, `Fulltext`, `FulltextBoolean` and tuple operators and column comparisons keep their rules. Arithmetic is not part of the grammar: integer overflow and division differ between the three databases. The DSL has no SQL text form: a condition, column, order, grouping or assignment is written only with the methods of this document, so every value reaches the database as a typed bind.

### 2.2 Chains

- **DSL-25** A chain lists one or more keys separated by `And` or `Or`. Each key consumes one argument in order.

```text
Chain = Key { ("And" | "Or") Key }
Key   = [Operator] Column
      | Column Operator Column
      | ("Fulltext" | "FulltextBoolean") Column { "With" Column }
      | ["Ne"] "Tuple" Column "With" Column { "With" Column }
```

- **DSL-26** none, `Eq` — SQL: `=`
- **DSL-27** `Ne` — SQL: `!=`
- **DSL-28** `Gt`, `Lt`, `Ge`, `Le` — SQL: `>`, `<`, `>=`, `<=`
- **DSL-29** `Lk` — SQL: `LIKE` with the value between wildcards
- **DSL-30** `Lb` — SQL: binary `LIKE` with the value between wildcards
- **DSL-31** `Between` — SQL: `BETWEEN` with a fixed two-value array
- **DSL-32** `Fulltext` — SQL: full-text match in natural-language mode
- **DSL-33** `FulltextBoolean` — SQL: full-text match in boolean mode

- **DSL-34** `<ColA><Op><ColB>(model)` compares column `ColA` of the calling model with column `ColB` of `model` in the same statement. `(new Product)->priceGtMinPrice($brand)` renders `a.price > b.min_price`. `Op` is `Eq`, `Ne`, `Gt`, `Lt`, `Ge`, or `Le`. Inside `on(fn)` the calling model is the join child.
- **DSL-35** `tuple<ColA>With<ColB>(list)` compares several columns with a list of value groups, such as `tupleTenantIdWithAccountId([[1, 10], [2, 10]])` for `(tenant_id, account_id) IN ((1, 10), (2, 10))`. `Ne` produces `NOT IN`. Go uses the generated value group struct `model.<Model><ColA>With<ColB>` with one field per column, Rust uses tuples, TypeScript uses typed tuples, and Python uses tuples. SQLite renders the list as `IN (VALUES …)`.
- **DSL-36** `getsByServiceSeqAndIsClose(7, 0)` and `serviceSeq(7)->andIsClose(0)->gets()` produce the same condition.
- **DSL-37** A chain can combine any columns. PHP and Python resolve chains at call time, while Go, Rust, and TypeScript generate the chain methods that the scanned source code calls and reject an unknown column, operator, or argument count during generation, and PHP declares them as `@method` tags when `--scan` is given and rejects the same errors during generation; the scan of Python reports a model method that no column, chain, or operator matches during generation.
- **DSL-38** Each language generates with its own build tool:
  - **DSL-39** Go scans the packages named by `--scan` and repeats until the calls type-check: `go run github.com/polyspec/orm/packages/go/cmd/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --lang go --out model --scan ./...` in a `//go:generate` line. Files that the default build excludes with a `//go:build` constraint are loaded with the tags, GOOS, and GOARCH their constraint needs, so a tagged test is covered without `GOFLAGS=-tags`. The default build loads every scanned package once; such a configuration loads only the packages that hold its files and takes the type information of every other package from the default load.
  - **DSL-40** TypeScript scans the files named by `--scan` with oxc-parser and writes exact method signatures: `orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out src/models --scan src` in the `build` script before `tsc`.
  - **DSL-41** Rust scans the sources named by `scan` with `syn` in `build.rs`: `polyspec_orm_build::Builder::set("contracts/fixtures/bench/dbspec-set.json").scan("src").generate()`, and `polyspec_orm::models!()` includes the result as the module `model`.
  - **DSL-42** PHP writes the model classes with column metadata and typed getters and setters: `vendor/bin/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out src/Model --namespace Example\Model --scan src`. `--scan` takes a file or a directory and may repeat; a directory is read without its `vendor` and `node_modules` directories, and a symlink stops generation with status 1, since the scan never follows one. It reads the PHP files with `nikic/php-parser` and declares, in the class comment of each model, one typed `@method` tag for every chain method the sources call on that model (for example `ltSeq`, `andIsClose`, `getsBySeqAndName`), so that PHPStan finds the call. The call still runs through `__call`. A receiver counts as a model when it is `new C` of a generated class `C` (also through a `use` alias), a variable, parameter, or return type declared with that class, a chain method of a model, or the untyped first parameter of a closure given to `and`, `or`, `not`, `andNot`, `orNot`, `on`, `fetchKey`, or `fetchValue`. A call on any other receiver adds no tag. A called name that no column, chain, or operator accepts, or a call whose argument count the chain does not take, stops generation with status 1 and names the model and the method.
  - **DSL-43** Python writes the model classes with typed getters and setters and reports the model methods of the scanned sources that no rule matches: `orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out model --scan src`, the console script the package installs.
  - **DSL-44** The getters of the scan are one rule in the five generators. A scanned call `get<Name>()` (`get_<name>()` in Python and Rust) on a receiver that resolves to a model is a getter, unless it is a column getter, a fixed method, or a `getBy`, `getsBy` or `getCountBy` chain. It is attached by an `alias<Name>()` call of a relation child, a `new<Name>()` call, or an `addColumn` call that names `<Name>`, or it is the relation result `get<Model>Model` or `get<Model>Models`. The alias of a relation nested in a relation attaches the getter to the model the nested relation is called on: `new Product().relation(new Store().matchSeqWithStoreSeq().aliasStore().relation(new Match().matchStoreSeqWithSeq().aliasMatch()))` gives `getStore` to Product and `getMatch` to Store. A getter returns no declared model, so a receiver read through one names its model with the getter's type argument in TypeScript (`row.getStore<Store | null>()`), the type of its binding in Go, Rust (`Option<Store>`) and Python (`store: Store | None = row.get_store()`), or a `/** @var Store|null $store */` tag on its assignment in PHP; a parameter typed `Iterable<Store>` (TypeScript), `Iterable[Store]` (Python) or as a model collection yields models to its loop. A scanned getter call that nothing attaches stops generation and names the model and the method, so a missing getter is never dropped without a message. The scan refuses a model method call only when no class the receiver may hold declares it. The PHP generator also checks the argument count against those classes; every other client leaves undeclared chain methods and counts to its compiler, or, in Python, to the call itself. A used table of an external document is an entity of the set (T209), so a relation to it attaches its getter as a relation to any other entity does.

### 2.3 Value shapes

- **DSL-45** one value — Without operator or `Eq`: `= ?`; `Ne`: `!= ?`
- **DSL-46** list — Without operator or `Eq`: `IN (…)`; `Ne`: `NOT IN (…)`
- **DSL-47** empty list — Without operator or `Eq`: `EMPTY_IN` before SQL execution; `Ne`: `EMPTY_IN` before SQL execution
- **DSL-48** null — Without operator or `Eq`: `IS NULL`; `Ne`: `IS NOT NULL`

```php
->andPhotoUrl('a.png')->andPhotoUrl(['a', 'b'])->andPhotoUrl(null)->andNeSeq([1, 2])
```

```go
.AndPhotoUrl("a.png").AndPhotoUrl([]string{"a", "b"}).AndPhotoUrl(orm.Null).AndNeSeq([]int{1, 2})
```

```rust
.and_photo_url("a.png").and_photo_url(vec!["a", "b"]).and_photo_url(Null).and_ne_seq(vec![1, 2])
```

```ts
.andPhotoUrl('a.png').andPhotoUrl(['a', 'b']).andPhotoUrl(null).andNeSeq([1, 2])
```

```python
.and_photo_url('a.png').and_photo_url(['a', 'b']).and_photo_url(None).and_ne_seq([1, 2])
```

- **DSL-49** Null is accepted only for nullable columns. Go, Rust, and TypeScript reject null for a non-null column at compile time; PHP and Python return `CONFIG`.
- **DSL-50** Lists are accepted only without an operator, with `Eq`, and with `Ne`. Other operators reject lists and null.
- **DSL-51** PHP, TypeScript and Python use their own null value, Go uses `orm.Null`, and Rust uses `Null`.
- **DSL-52** Go methods use generic type parameters with the allowed value types of each column. Integer columns accept `int`, `int32`, `int64`, and slices of those types.
- **DSL-53** An unexecuted model as the value renders `IN (SELECT …)`, or `NOT IN` with `Ne`. The model must add exactly one column with `addColumn<Col>()`; otherwise `CONFIG` is returned.
- **DSL-54** An ORM function value applies a function from section 10. A column function wraps the column, and the compared value is the second method argument, for example `andEqCreatedTs(Orm::year(), 2026)`. A value function is the compared value, for example `andGtCreatedTs(Orm::daysAgo(7))`.
- **DSL-55** `Between` takes a fixed two-value array: PHP `[1, 10]`, Go `[2]int{1, 10}`, Rust `[1, 10]`, TypeScript `[1, 10]` typed as `[number, number]`, and Python `[1, 10]`. Go, Rust, and TypeScript reject another length at compile time; PHP and Python return `CONFIG`.

## 3. Reads

- **DSL-56** `get()` — Result: one row; null when no row matches
- **DSL-57** `gets()` — Result: collection of rows
- **DSL-58** `getBy<Chain>(…)` — Result: `get()` with the chain as condition
- **DSL-59** `getsBy<Chain>(…)` — Result: `gets()` with the chain as condition
- **DSL-60** `getCount()`, `getCountBy<Chain>(…)` — Result: row count; 0 when no row matches
- **DSL-61** `getsCount()` — Result: grouped rows with `row_count`
- **DSL-62** `sum<Col>()` with `getSum()` — Result: sum of the column; 0 when there is no value
- **DSL-63** `avg<Col>()` with `getAvg()` — Result: average of the column; null when there is no value
- **DSL-64** `getsPage(page, perPage)` — Result: one page with `items`, `totalCount`, `totalPages`, `page`, and `perPage`
- **DSL-65** `getQuery()` — Result: statement text and binds of `gets()` without execution

- **DSL-66** `getSum()` and `getAvg()` convert a numeric database scalar to the nearest finite IEEE 754 binary64 value, with ties rounded to even. SQL `SUM` and `AVG` skip null values and give a null scalar when no value is left, whether no row matches or every value is null: then `getSum()` returns 0, the sum of no values, and `getAvg()` returns null, since the average of no values is undefined and 0 would be an invented average. A nonnumeric, nonfinite or overflowing scalar returns `CODEC_DECODE`. Row column decoding retains its lossless conversion rules.
- **DSL-67** `getsPage` counts rows with the same conditions and joins; a grouped model counts distinct group keys. `page` and `perPage` must be positive, and a model with `limit` returns `CONFIG`. A page after the last page returns an empty collection. orm does no rendering, request reading or redirects.
- **DSL-68** `getQuery` requires a connected model or an active transaction because the dialect decides the statement text; otherwise it returns `CONFIG`. Secret values are shown as `$SECRET`.
- **DSL-69** Terminals take no arguments except chain values. A terminal does not change the model, so running a second terminal produces the same statement.
- **DSL-70** `keyName<Col>()` sets the collection key column. `fetchKey(fn)` computes the collection key. `fetchValue(fn)` replaces each loaded row value with the callback result.
- **DSL-71** A row exposes `get<Col>()` getters. A relation result is read through the generated relation getter.

## 4. Columns

- **DSL-72** `addColumn<Col>()` — Effect: add one column
- **DSL-73** `addColumn<Col>Alias<Name>(fn)` — Effect: add a column function of the column (section 10) with an output name
- **DSL-74** `addColumn<Name>(fn)` — Effect: add a scalar subquery column; the callback receives the calling model and returns an unexecuted model; a scalar column subquery has `limit(0, 1)` and an order that includes every primary key column, else the request is `IR_INVALID`
- **DSL-75** `removeColumn<Col>()` — Effect: remove one column
- **DSL-76** `removeAllColumns()` — Effect: keep only primary and foreign keys
- **DSL-77** `addAllColumns()` — Effect: select every column
- **DSL-78** `forceIndex<Name>()` — Effect: add an index hint for the model table

```php
(new User)->connect($slave1)
    ->addColumnCash(fn (User $u) => (new Point)->sumAmount()->toUserSeqEqSeq($u)->andStatus(1))
    ->gets();
// (SELECT COALESCE(SUM(b.amount), 0) FROM point b WHERE b.to_user_seq = a.seq AND b.status = ?) AS cash
```

## 5. Relations and joins

### 5.1 Relations

- **DSL-79** A relation runs a separate query for the parent keys and attaches the result to each parent row.

```php
$orders = (new Order)->connect($slave1)
    ->relation((new Status)->matchStatusSeqWithSeq()->aliasOrderStatus())
    ->relations((new OrderItem)->matchSeqWithOrderSeq()->groupLimit(5))
    ->orderBySeqDesc()
    ->gets();
```

- **DSL-80** `relation(child)` — Effect: attach one related row
- **DSL-81** `relations(child)` — Effect: attach a collection of related rows
- **DSL-82** `match<L>With<R>()` — Effect: parent column `L` equals child column `R`; a composite key calls one per component, in key order, e.g. `matchTenantIdWithTenantId().matchAccountIdWithAccountId()`
- **DSL-83** `alias<Name>()` — Effect: result name of the relation
- **DSL-84** `parentNode()` — Effect: merge child columns into the parent row
- **DSL-85** `possible<Col>(value)` — Effect: load the child only when the parent column equals the value
- **DSL-86** `groupLimit(count)` — Effect: limit child rows per parent key
- **DSL-87** `deleteLock()` — Effect: exclude the relation from recursive delete

- **DSL-88** A child without `connect` uses the parent connection. A child with `connect` runs its query on that connection.
- **DSL-89** A relation result is named `<table>_model` for `relation` and `<table>_models` for `relations`, and is read with `get<Table>Model()` or `get<Table>Models()`. `alias<Name>()` replaces the result name, and the result is read with `get<Name>()`.

```php
$env = (new ServiceEnvironment)->connect($slave1)
    ->relations((new ServiceUrl)->matchSeqWithServiceEnvironmentSeq()->aliasUrls())
    ->relation((new User)->matchWriterSeqWithSeq()->aliasWriter())
    ->relation((new User)->matchEditorSeqWithSeq()->aliasEditor())
    ->getBySeq($seq);
$env->getUrls(); $env->getWriter(); $env->getEditor();
```

### 5.2 Joins

- **DSL-90** A join adds the child table to the same statement.

- **DSL-91** `join<L>With<R>(child)` — SQL: `INNER JOIN` on parent column `L` and child column `R`
- **DSL-92** `leftJoin<L>With<R>(child)` — SQL: `LEFT JOIN` on parent column `L` and child column `R`
- **DSL-93** `on(fn)` on the child — SQL: `ON` conditions written with the condition grammar

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

- **DSL-94** The child is configured before it is passed to the join method. `on(fn)` sets the `ON` conditions; the callback receives the child and uses the condition grammar.
- **DSL-95** Conditions set directly on the child are `WHERE` conditions. `and(model)` or `or(model)` places them as a group at that position. When the child is not passed to a group, its conditions are appended with `AND`.
- **DSL-96** Passing the same child to two groups, or passing a model that is not joined in the statement, returns `CONFIG`.
- **DSL-97** Child columns are returned on the child result of each row.
- **DSL-98** A join child with `connect` returns `CONFIG`.

## 6. Order and range

- **DSL-99** `orderBy<Col>Asc()`, `orderBy<Col>Desc()`, and chains such as `orderBySeqDescAndNameAsc()` set the order. `orderByRandom()` orders rows randomly with the dialect function. `groupBy<Col>()` sets grouping on `getsCount()` and on group counts; on any other read it is `IR_INVALID`. `limit(offset, count)` sets the range.

## 7. Writes

- **DSL-100** `set<Col>(value)` — Effect: stored column value; the column must exist
- **DSL-101** `new<Name>(value)` — Effect: attach a value under a name that is not a column; see the rules below
- **DSL-102** `plus<Col>(n)`, `minus<Col>(n)` — Effect: bound increment and decrement; `minus` never stores a negative value
- **DSL-103** `create()` — Effect: insert and return the row with its generated key
- **DSL-104** `creates(models, batch)` — Effect: insert models created with `set<Col>` in batches of `batch` rows, each batch one multi-row INSERT, all in one transaction (a savepoint inside an active transaction), and return the inserted row count; every model must set the same columns. `batch` is required and a positive integer, otherwise `CONFIG`; a batch whose binds exceed the dialect bind limit is `BATCH_TOO_LARGE`; both fail before any statement
- **DSL-105** `duplication(model)` with `create()` — Effect: insert with duplicate-key update from the changes of `model`
- **DSL-106** `update()` — Effect: update changed columns of the row
- **DSL-107** `update(true)` — Effect: update only when the stored `updated_ts` equals the value that was read; otherwise `OPTIMISTIC_LOCK`
- **DSL-108** `expectRevision(column, revision)` with `update()` or `delete()` — Effect: write only while the row's `column` still holds `revision`; `update()` also stores `revision + 1`; otherwise `REVISION_CHANGED` and nothing changes; see the rules below
- **DSL-109** `save()` — Effect: `update()` when the primary key is set, otherwise `create()`
- **DSL-110** `delete()` — Effect: delete the row or every row of a collection
- **DSL-111** `delete(true)` — Effect: delete loaded relation rows recursively, except relations marked with `deleteLock()`

- **DSL-112** Attribute changes are cleared after a successful write.

- **DSL-113** `create()` and `creates()` reject a value for the identity column, and `update()` and the changes of a `duplication` model reject a primary key or identity column, with `IR_INVALID` before any statement runs. The database generates every identity key, because PostgreSQL identity does not advance past an explicit key and its next generated key would collide. Only a load writes identity keys: an `insert` request with `load` and then a `restart_identity` request, run with `execute` on the connection ([protocol](protocol.md#_1-6-load)).
- **DSL-114** `expectRevision(column, revision)` makes the next `update()` or `delete()` of the model a write with an expected revision. The chain names the revision column, rather than a dbspec setting: a revision column is an ordinary integer column that the chain already names (as `plus<Col>` does), the expected revision is a value of one write that only the chain can carry, and a setting would change the manifest, and so the manifest hash, of every document set that declares it. The column is an `i16`, `i32` or `i64` column of the entity that is not a primary key column; another column, a value of the column set in the same write, or `update(true)` with the expectation fails with `CONFIG` before any statement runs. The write builds on the request the model already sends, with no second mechanism: the key predicate of `update()` and `delete()` gains `column = revision`, and `update()` assigns the bound increment `column = column + 1` (as `plus<Col>(1)`) with its changed columns, also when no other column changed. The one conditional statement locks the row it matches in the connection's transaction, when one is open, and compares and writes it with no window between the two; SQLite, which has no `FOR UPDATE`, holds its write lock for the statement. A statement that matches no row, because the row holds another revision or no longer exists, fails with `REVISION_CHANGED` and writes nothing; a `delete(true)` runs in its transaction, so the root's `REVISION_CHANGED` rolls back the related rows it deleted. A soft delete compares the same way. The model is not read again: after a successful `update()` the row's revision is `revision + 1`. The expectation is cleared with the other changes after a successful `update()` and applies to that model only, not to a collection's rows. The `optimistic` request slot of `update(true)` compares the `updated_ts` that the executor writes; the revision is a value that the caller holds, such as the revision a form was rendered with, and it guards `delete()` too.
- **DSL-115** `new<Name>` attaches data that the row carries to its output, such as a computed amount or a flag for a view. The value is not used in `INSERT`, `UPDATE`, or `SELECT` statements. `get<Name>()`, `toArray()`, and JSON output include it after reads and writes; a model returned by `create()` keeps the attached values.
- **DSL-116** A real column name in `new<Name>` is rejected; stored column values use `set<Col>`.
- **DSL-117** Go and Rust generate `New<Name>` and `Get<Name>` for the names that the scanned source code calls. The value type is `any` in Go and the common value type in Rust.

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

- **DSL-118** A callback error or exception rolls back the transaction. Deadlocks are retried.
- **DSL-119** A transaction on the same connection inside an active transaction creates a savepoint.
- **DSL-120** Two transactions that must be open at the same time need two connections, because a second transaction on one connection becomes a savepoint of the first. Lock contention is written that way: one connection holds the row and another waits for it.
- **DSL-121** Concurrent use of one transaction connection returns an error.
- **DSL-122** The execution flow is the goroutine in Go, the request in PHP, the tokio task in Rust, the `AsyncLocalStorage` context in TypeScript, and the thread of the request in Python: a transaction is active on the connection that opened it, and every execution flow holds its own connection. A goroutine or spawned Rust task started inside the callback has no active transaction; a Go subtest is such a goroutine, so a transaction opened in one is a separate transaction that waits for the connection held outside it. In TypeScript, asynchronous work started inside the callback shares the callback's context and therefore the transaction; a statement that overlaps another statement on it returns `CONFIG`.
- **DSL-123** `forUpdate()`, `forShare()`, `forUpdateNoWait()`, and `forShareNoWait()` are allowed only inside a transaction.
- **DSL-124** Begin, commit, and rollback are not public.

- **DSL-125** The options are `isolation`, `readOnly`, `timeoutMs`, and `retry` (default `3`, `0` disables retry). An omitted option keeps its default.

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

- **DSL-126** A transaction of the same connection inside an active one accepts only `retry`, which it ignores; the savepoint joins the outer transaction.

## 9. Reserved names

- **DSL-127** The generator rejects a column whose method name matches a reserved method (`and`, `or`, `get`, `gets`, `getsPage`, `getQuery`, `limit`, `alias`, `connect`, `create`, `creates`, `update`, `delete`, `restore`, `save`, `on`) or starts with a reserved prefix (`and`, `or`, `get`, `set`, `new`, `plus`, `minus`, `orderBy`, `groupBy`, `tuple`, or an operator). A column named `random` is rejected because `orderByRandom()` is reserved.

- **DSL-128** The names attached to a row form one name space: real columns, columns added with `addColumn<Name>(fn)` or `addColumn<Col>Alias<Name>(fn)`, relation result names, and `new<Name>` names. A duplicate name in this space is rejected. Go and Rust reject it during generation; PHP and TypeScript return `CONFIG`. Two relations to the same table therefore need different aliases, and a subquery column needs a name that is not a real column.

- **DSL-129** A column whose method name equals another generated method of the model, such as `sum_amount` next to `amount` (`sumAmount()`), is rejected.

- **DSL-130** A column name also must not contain any of these underscore-separated segments: `and`, `or`, `with`, `gt`, `lt`, `ge`, `le`, `eq`, `ne`, `lk`, `lb`, `between`, `fulltext`, `tuple`. For example, `price_gt_limit` and `with_tax` are rejected, and `min_price` is accepted.

## 10. ORM functions

- **DSL-131** An ORM function value carries a function kind and its arguments. The model method that receives it records the model alias, column, and operator, and the client planner renders SQL for the connection dialect.

- **DSL-132** column function in a condition — Form: `and<Op><Col>(Orm::year(), 2026)`
- **DSL-133** value function in a condition — Form: `and<Op><Col>(Orm::daysAgo(7))`
- **DSL-134** column function as a column — Form: `addColumn<Col>Alias<Name>(Orm::year())`
- **DSL-135** column function in ordering — Form: `orderBy<Col>Asc(Orm::year())`

- **DSL-136** Go uses `orm.Year()`, Rust uses `polyspec_orm::year()`, TypeScript uses `orm.year()`, and Python uses `orm.year()`.

### 10.1 Value functions

- **DSL-137** `now()` — MySQL: `NOW(6)`; PostgreSQL: `now()`; SQLite: value computed by the client in UTC and bound
- **DSL-138** `today()` — MySQL: `CURDATE()`; PostgreSQL: `CURRENT_DATE`; SQLite: value computed by the client and bound
- **DSL-139** `secondsAgo(n)`, `minutesAgo(n)`, `hoursAgo(n)`, `daysAgo(n)`, `monthsAgo(n)` — MySQL: `DATE_SUB(NOW(6), INTERVAL ? unit)`; PostgreSQL: `now() - make_interval(unit => ?)`; SQLite: `datetime(clock, '-n units')` over the bound client clock, followed by the six fraction digits of the clock
- **DSL-140** `secondsLater(n)`, `minutesLater(n)`, `hoursLater(n)`, `daysLater(n)`, `monthsLater(n)` — MySQL: `DATE_ADD(NOW(6), INTERVAL ? unit)`; PostgreSQL: `now() + make_interval(unit => ?)`; SQLite: `datetime(clock, '+n units')` over the bound client clock, followed by the six fraction digits of the clock

- **DSL-141** Every connection reads and writes datetime values in UTC ([config](config.md)); MySQL and PostgreSQL connections set the session time zone to UTC.
- **DSL-142** Month arithmetic keeps the last valid day of the target month, as MySQL and PostgreSQL do.
- **DSL-143** A relative time function outside 0001-01-01 to 9999-12-31 23:59:59.999999, or with an interval past that span, is NULL, and each dialect guards the forms above for it ([dialects](dialects.md)).

### 10.2 Column functions

- **DSL-144** `dayOfWeek()` (1 = Sunday … 7) — Columns: date and time; MySQL: `DAYOFWEEK(c)`; PostgreSQL: `(EXTRACT(DOW FROM c)::int + 1)`; SQLite: `(CAST(strftime('%w', c) AS INTEGER) + 1)`
- **DSL-145** `year()` — Columns: date and time; MySQL: `YEAR(c)`; PostgreSQL: `EXTRACT(YEAR FROM c)::int`; SQLite: `CAST(strftime('%Y', c) AS INTEGER)`
- **DSL-146** `month()` — Columns: date and time; MySQL: `MONTH(c)`; PostgreSQL: `EXTRACT(MONTH FROM c)::int`; SQLite: `CAST(strftime('%m', c) AS INTEGER)`
- **DSL-147** `date()` — Columns: date and time; MySQL: `DATE(c)`; PostgreSQL: `CAST(c AS date)`; SQLite: `date(c)`

- **DSL-148** A column function on a column type that it does not list returns `OPERATOR_NOT_ALLOWED`.
- **DSL-149** SQLite stores `decimal` values as floating-point numbers, so decimal arithmetic in SQLite can differ from MySQL and PostgreSQL. The ORM does not change the SQLite storage.
- **DSL-150** The minimum SQLite version is 3.46. A client reads the version of the SQLite library its driver links (Go `RegisterSQLiteVersion` from `modernc.org/sqlite`, PHP `PDO::ATTR_SERVER_VERSION`, TypeScript `process.versions.sqlite`, Rust `libsqlite3_sys::SQLITE_VERSION`, Python `sqlite3.sqlite_version`) and connects without a statement that asks for it or checks the connection.
