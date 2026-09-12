---
layout: home
title: Common ORM for Go, PHP, Rust, and TypeScript
hero:
  name: orm
  text: Common ORM Interface for Go, PHP, Rust, and TypeScript
  tagline: Generate query, row, and relation types from a schema and execute them with language-specific drivers.
  actions:
    - theme: brand
      text: Read the guide
      link: /usage
    - theme: alt
      text: Common interface
      link: /interfaces
features:
  - title: Common syntax and structure
    details: The interface defines Query, Binding, Row, and Collection roles and checks Go, PHP, Rust, and TypeScript declarations and results.
    link: /interfaces
  - title: Bind before execution
    details: Bind the executor to the root query. Terminals receive values only, and relation queries use the root executor.
    link: /dsl
  - title: Three databases
    details: MySQL, PostgreSQL, and SQLite preserve query semantics. SQL differences and supported features are documented by dialect.
    link: /dialects
---

## One query in four clients

### Go

```go [Go]
count, err := gen.Battle().Using(ctx, db).GetCountByServiceSeq(7)
```

### PHP

```php [PHP]
$count = Battle::query()->using($db)->getCountByServiceSeq(7);
```

### Rust

```rust [Rust]
let count = battle::query().using(&db).get_count_by_service_seq(7).await?;
```

### TypeScript

```ts [TypeScript]
const count = await Battle().serviceSeqEq(7).using(db).getCount()
```

Go `gen.Battle()` returns `*gen.BattleQuery`. Go passes `ctx` with the executor, and Rust and TypeScript use asynchronous results. Syntax follows each language; argument meaning, data structure roles, and execution rules are shared.

[Read the guide](usage.md) for binding, reads, writes, and relations. See the [component diagram](interfaces-model.md) for ownership rules.

## Implementation status

The implemented clients are **Go, PHP, Rust, and TypeScript**. All four clients provide generated entity APIs and native database execution. See the [implementation matrix](interface-implementation.md), [checklist](checklist.md), and [S7 work list](s7.md) for verification scope and remaining work.

[DSL](dsl.md) · [Schema](schema.md) · [IR / Plan](protocol.md) · [Complex query example](examples/complex-query.md) · [Documentation build and deployment](docs-development.md) · [한국어 문서](index.ko.md)
