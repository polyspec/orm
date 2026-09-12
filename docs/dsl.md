# DSL v3 — regular syntax

This page defines the public query syntax. Data structures, ownership, and state transitions are defined in [the common interface](interfaces.md).

| Rule | Definition |
|---|---|
| Explicit names | `<col>(value)` means equality. Other operators are part of the method name: `<col>NotEq`, `<col>Gt`, `<col>In`, and `<col>IsNull`. `relation`, `relations`, `join`, and `leftJoin` identify different operations. |
| SQL terms | Use `select`, `and`, `or`, `join`, `leftJoin`, `on`, `orderBy`, `limit`, and `groupBy` names. |
| Shared tokens | PHP, Go, Rust, and TypeScript use the same logical token names. Language casing follows local syntax. |
| Grouping | `or()` changes the connection for the next item. `and(fn)` and `or(fn)` create a nested group. |
| IDE checks | Generated builders expose only columns and operators allowed by the schema. Where callbacks receive the generated entity Where type. |
| Execution | A root query receives its executor with `using`. Terminal methods receive values only. |

## 1. Structure

A query is built first, bound to an executor, and terminated with a value operation. The executor is inherited by joins, relation stages, and returned rows. Executing without an executor or after its transaction ends returns `CONFIG`.

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

The call order is:

```text
Query() → using(executor) → select/join/where/relation → order/limit → get/gets/getCount
```

Rows are separate generated types. A row provides getters, setters, `update`, `updateOptimistic`, `delete`, and `deleteCascade` according to the schema.

## 2. Tokens

### 2.1 Predicates `<col><Op>(value)` — WHERE

| Token | SQL | Example |
|---|---|---|
| `<col>` / `<col>Eq` | `=` | `isClose(false)` |
| `<col>NotEq` | `!=` | `statusNotEq("x")` |
| `<col>Gt`, `Gte`, `Lt`, `Lte` | comparison | `endDtGt(now)` |
| `<col>In`, `NotIn` | `IN`, `NOT IN` | `seqIn([1, 2, 3])` |
| `<col>Like`, `LikeBinary` | `LIKE` | `nameLike("%kw%")` |
| `<col>Contains`, `StartsWith`, `EndsWith` | escaped `LIKE` pattern | `nameContains(keyword)` |
| `<col>Between` | `BETWEEN` | `createdTsBetween(from, to)` |
| `<col>IsNull`, `IsNotNull` | `IS NULL`, `IS NOT NULL` | `endDtIsNull()` |
| `<A>With<B>Match` | full-text match | `nameWithDescriptionMatch(keyword)` |
| `<col><Op>Col(ref)` | column comparison | `langIdEqCol(ProductCols::langId())` |
| `expr(fragment, binds)` | schema-checked SQL fragment | `expr('DAYOFWEEK(`created_ts`) = ?', [1])` |
| named predicate | schema-defined predicate group | `visible()` |

An empty `IN` list returns `EMPTY_IN`. The allowed operators depend on the column type. The `Eq` suffix is the explicit equality method.

### 2.2 Groups and navigation — `<X>Where`

| Token | Meaning |
|---|---|
| `or()` | Connect the next item with OR. The default connection is AND. |
| `and(fn)` / `or(fn)` | Add a nested group. |
| `<rel>(fn)` | Add conditions to a declared joined relation. An undeclared path returns `ENTITY_NOT_JOINED`. |
| `on(fn)` / `where(fn)` | Use the same Where builder for join ON and WHERE conditions. |

A leading `or()` or `or(fn)` returns `OR_AT_GROUP_START`. Two connectors without a predicate return `DANGLING_CONNECTOR`. Groups can be nested without a fixed depth.

### 2.3 Columns — SELECT

| Token | Meaning |
|---|---|
| default | Select eager columns. Lazy and styled columns are excluded. |
| `selectAll()` | Select all columns. |
| `selectNone()` | Select primary and foreign keys. |
| `select<Col>()` / `unselect<Col>()` | Add or remove one column. |
| `select<Col>As(name)` | Select one column with an output name. |
| `selectExpr(name, fragment)` | Select a schema-checked expression. |

Output mapping is positional and uses `{alias, column, out_name, index}`. Join columns remain in their alias namespace.

### 2.4 Relations and joins

`relation<Rel>(child)` loads one related row. `relations<Rel>(child)` loads a collection. `join<Rel>(child)` and `leftJoin<Rel>(child)` add a SQL join. Relation kind and key mapping come from the schema.

Join conditions use `child.on(fn)` for ON and `child.where(fn)` for WHERE. A join may contain another declared join. The generated names are the same logical names in all clients.

### 2.5 Ordering, range, and options

Use `orderBy<Col>Asc`, `orderBy<Col>Desc`, `groupBy<Col>`, `groupByExpr`, `having(fn)`, `limit(offset, count)`, `keyBy<Col>`, `keyByFn`, `flatten`, and `limitPerParent`. `parentNode` is available only for the declared result merge operation.

### 2.6 Execution terminals

| Terminal | Return |
|---|---|
| `get()` | one row or null |
| `gets()` | collection of rows |
| `getCount()` | integer count |
| `getsCount()` | grouped count rows |
| `paginate(page, perPage)` | page result |
| `getBy<PK|Unique>(value)` | one row or null |
| `getsBy<Col>(value)` | collection of rows |
| `getCountBy<Col>(value)` | integer count |

Finder methods apply their equality predicate and call the corresponding terminal. The database or executor is never passed to a terminal.

### 2.7 Batch writes

Batch writes use typed query drafts and one transaction. `batchInsert`, `batchUpsert`, `batchUpdate`, and `batchDelete` accept an entity-specific query list and a positive chunk size. The result contains `attempted`, `affected`, and `inserted`. An error rolls the complete batch back; a supplied transaction is reused.

### 2.8 Rows

A row has a generated getter and setter for each stored field. A setter marks the field dirty. Update operations use the row binding and preserve the original values required by optimistic locking. Relation accessors return the declared row or collection type.

## 3. Example: root and join conditions

```php
$battles = Battle::query()
    ->using($db)
    ->serviceSeq(7)->isClose(false)
    ->and(fn($w) => $w->isDisplay(true)->or(fn($w) => $w->isAllday(true)))
    ->leftJoinUser(User::query()->on(fn($w) => $w->seqEqCol(BattleCols::userSeq())))
    ->orderBySeqDesc()->limit(0, 20)->gets();
```

The root group and join ON group are stored separately and compiled in declaration order.

## 4. Example: relations and parent limits

```go
battles, err := gen.Battle().Using(ctx, db).
    ServiceSeq(7).IsClose(false).
    WithUser(gen.User().OrderBySeqDesc()).
    LimitPerParent(20).Gets()
```

A relation stage receives parent keys from the preceding stage. `limitPerParent` applies the limit within each parent key.

## 5. Example: writes and transactions

```rust
let mut row = battle::query().using(&db).get_by_seq(7).await?.unwrap();
row.set_name("updated".to_owned());
row.update().await?;
```

Rows and queries use the same root transaction binding. A finished transaction rejects later operations with `CONFIG`.

## 6. Deliberately unsupported syntax

The regular API does not generate `relationUser`, `relationsUser`, `matchAWithB`, `aliasName`, `or<Op><Col>`, `bind(db)`, database arguments on terminals, or `new Battle`-style language-specific entry points. Generated entry points use the language's constructor or factory form while preserving the same query structure.

## Styled columns

Styles are schema declarations. `aes`, `hex`, `gz`, `json`, `jsons`, `base64`, and `serialize` are applied by the host codec or dialect as defined in [codec.md](codec.md). `aes_key_version` is plaintext metadata, has no style, and is excluded from the default projection.
