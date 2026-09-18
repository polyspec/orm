# ORM design plan

This page is the single design plan for the ORM. It replaces the earlier initial design, revised design, and DSL v3 notes. The [DSL](dsl.md) and [common interface](interfaces.md) pages specify the resulting syntax and structures; this page records the goal, the rules, and the work order.

## 1. Goal

The ORM provides one model-based query syntax in Go, PHP, Rust, and TypeScript. Every client runs the same statement as the same SQL on MySQL, PostgreSQL, and SQLite.

## 2. Principles

1. Every syntax rule is written explicitly in the [DSL](dsl.md) before implementation.
2. Every method name is derived mechanically from column, operator, and connector rules. Convenience methods tied to specific columns are not provided.
3. Every syntax is written the same way in all four languages; only language spelling and creation forms differ.
4. Syntax without an approved rule is not used in documents, examples, or generated code.
5. The ORM does not provide compatibility layers, fallbacks, or data conversion. A failing rule is corrected in this plan; the test is not weakened.
6. The product version remains `0.0.1`.

## 3. Syntax provided in four languages

| Area | Syntax |
|---|---|
| Connection | model creation followed by `connect(connection)`; the same `connect` rebinds a loaded row or collection |
| Conditions | first condition `<Chain>`, then `and<Chain>` or `or<Chain>`, connectors `and()` and `or()`, groups `and(fn)` and `or(fn)`, operator prefixes `Gt Lt Ge Le Eq Ne Lk Lb Between Fulltext FulltextBoolean`, `<ColA>With<ColB>(model)` |
| Reads | `get`, `gets`, `getBy<Chain>`, `getsBy<Chain>`, `getCount`, `getCountBy<Chain>`, `getsCount`, `sum<Col>` with `getSum`, `avg<Col>` with `getAvg`, `keyName<Col>`, `fetchKey`, `fetchValue` |
| Columns | `addColumn<Col>`, `removeColumn<Col>`, `removeAllColumns`, `addAllColumns`, `forceIndex<Name>` |
| Relations and joins | `relation`, `relations`, `match<L>With<R>`, `alias<Name>`, `parentNode`, `possible<Col>`, `groupLimit`, `deleteLock`, `join<L>With<R>`, `leftJoin<L>With<R>`, `on(fn)` |
| Order and range | `orderBy<Col>Asc`, `orderBy<Col>Desc`, `groupBy<Col>`, `limit(offset, count)` |
| Writes | `set<Col>` for stored columns, `new<Name>` for in-memory attributes, `setRaw<Col>`, `plus<Col>`, `minus<Col>`, `create`, `duplication(model)` with `create`, `update`, `update(true)`, `save`, `delete`, `delete(true)` |
| Transactions | `connection.transaction(fn)` with deadlock retry |
| Pages | total count and one page of rows from the same model |
| Styles | `ip`, `aes`, `aes_serialize`, `aes_hex`, `point`, `serialize`, `base64`, `gz`, `json`, `jsons`, `yaml` |

`serialize` and `aes_serialize` use the published PHP serialization format; each client implements that format.

## 4. Complements

### 4.1 Transactions

- Inside `connection.transaction(fn)`, a model without `connect` executes in the active transaction of the current execution flow. Outside a transaction, executing a model without `connect` returns `CONFIG`.
- A transaction on the same connection inside an active transaction creates a savepoint. A failure inside the inner callback rolls back only the inner work; returning that failure from the outer callback rolls back the complete transaction.
- Concurrent use of one transaction connection returns an error. A task or goroutine started inside the callback has no active transaction.
- Begin, commit, rollback, the executor, and the execution context are private.
- The callback result follows each language: Go returns `error`, Rust returns `Result`, and PHP and TypeScript throw exceptions.
- Row locks `forUpdate`, `forShare`, `forUpdateNoWait`, and `forShareNoWait` are allowed only inside a transaction.

### 4.2 Correctness rules

- The generator rejects a column name that matches a reserved method (`and`, `or`, `get`, `gets`, `limit`, `alias`, `connect`, `create`, `update`, `delete`, `save`) or starts with a reserved prefix (`and`, `or`, `get`, `set`, `new`, `plus`, `minus`, `orderBy`, `groupBy`, or an operator prefix).
- Conditions are stored as a tree. A terminal operation does not change the builder, so a second terminal produces the same statement.
- Deadlock retry runs for driver deadlock errors.
- A join index hint is placed on the joined table. Every join contributes its aggregates and ordering. The relation key default uses the parent key. `possible<Col>` reads the joined parent row.
- `minus<Col>` never stores a negative value. `plus<Col>` and `minus<Col>` bind their amounts. Attribute changes are cleared after a write.
- `update(true)` compares the stored `updated_ts` value that was read, not the current attribute value.
- An empty list value returns `EMPTY_IN` before SQL execution.

## 5. Four-language rules

### 5.1 Model creation and connection

| Language | Creation | Connected model | Connected loaded row |
|---|---|---|---|
| PHP | `new Product` | `(new Product)->connect($slave1)` | `$row->connect($master)` |
| Go | `model.Product()` | `model.Product().Connect(slave1)` | `row.Connect(master)` |
| Rust | `Product::new()` | `Product::new().connect(&slave1)` | `row.connect(&master)` |
| TypeScript | `new Product()` | `new Product().connect(slave1)` | `row.connect(master)` |

- Creation uses each language form. Go uses a function in the generated `model` package and returns `*model.ProductModel`.
- `connect` is the only connection method. `on` is reserved for join conditions.
- PHP also accepts `(new Product)($slave1)` and `$row($master)` as the short form of `connect`.

### 5.2 Conditions

- The first condition has no prefix. Each following condition uses `and<Chain>`, `or<Chain>`, or a connector `and()` or `or()` followed by `<Chain>`. A missing connector, a connector at the start of a group, or a connector without a following condition returns `CONFIG`.
- `<Chain>` accepts any column combination with `And`, `Or`, operator prefixes, and `<ColA>With<ColB>`. Arguments follow the keys in order. The same chain is valid after `getBy`, `getsBy`, `getCountBy`, and `getsCountBy`.
- Groups use `and(fn)` and `or(fn)` only. The callback receives an empty model of the same type and accepts condition methods only; a terminal or write inside the callback returns `CONFIG`.
- PHP resolves chains at call time. Go, Rust, and TypeScript generate the chain methods that consumer source code calls: the generator reads the consumer source, parses each chain, checks it against the schema, and writes only those methods.

```go
rows, err := model.Product().Connect(slave1).
    GetsByServiceSeqAndIsCloseAndLtSaleStartDt(serviceSeq, 0, now)

rows, err = model.Product().Connect(slave1).
    ServiceSeq(serviceSeq).
    And(func(q *model.ProductModel) {
        q.IsSaleAndLtSaleStartDt(1, now).Or().IsSale(2)
    }).
    Gets()
```

```php
$rows = (new Product)->connect($slave1)
    ->serviceSeq($serviceSeq)
    ->and(fn (Product $q) => $q->isSaleAndLtSaleStartDt(1, $now)->or()->isSale(2))
    ->gets();
```

### 5.3 Relations and joins

- A relation or join child without `connect` uses the parent connection.
- A relation child with `connect` runs its separate query on that connection. Inside a transaction, that query uses the connection's active transaction in the same flow, if one exists.
- A join child with `connect` returns `CONFIG` because a join is part of one statement.

## 6. Additional capabilities

| Area | Capabilities |
|---|---|
| Operations | AES key rotation and status, row locks, savepoints, transaction options (isolation, read-only, timeout), bulk insert, SQL output, raw forms with schema checks, schema installation and migration, large `IN` list splitting |

## 7. Work order

1. Write the [DSL](dsl.md), [common interface](interfaces.md), guide, and README with Korean pages from sections 3 to 6.
2. Update `contracts/interfaces.json`, `contracts/features.json`, and `contracts/rules.json` to the syntax in this plan.
3. Add failing conformance vectors from application usage: list with relations, upsert, optimistic update, recursive delete, multi-write transaction, relation on another connection, section 4.2 defects, and section 4.1 transaction rules.
4. Update generators and runtimes in the order Go, PHP, Rust, TypeScript, and regenerate clients.
5. Run `make check`, SQLite, PostgreSQL, and MySQL conformance, the public symbol audit, repeated generation, and `make docs-check`.
6. Regenerate the Platform, SDK, and module models and update their callers.

## 8. Completion criteria

- Documents, manifests, generated clients, and tests describe the same syntax.
- Application-based conformance vectors pass in four languages and three databases.
- Every section 4.2 regression test passes, and the public symbols match the common interface.
- A task that does not meet these criteria is not recorded as complete.
