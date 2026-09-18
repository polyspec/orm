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
    details: One model type builds the query and holds the loaded row. Go, PHP, Rust, and TypeScript share its method names, value rules, and results.
    link: /interfaces
  - title: Connect, then execute
    details: A model receives its connection through connect. Inside a transaction callback, models use the active transaction, and relation children use the parent connection.
    link: /dsl
  - title: Three databases
    details: MySQL, PostgreSQL, and SQLite preserve query semantics. SQL differences and supported features are documented by dialect.
    link: /dialects
---

## One query in four clients

### Go

```go [Go]
count, err := model.Battle().Connect(slave1).GetCountByServiceSeq(7)
```

### PHP

```php [PHP]
$count = (new Battle)->connect($slave1)->getCountByServiceSeq(7);
```

### Rust

```rust [Rust]
let count = Battle::new().connect(&slave1).get_count_by_service_seq(7).await?;
```

### TypeScript

```ts [TypeScript]
const count = await new Battle().connect(slave1).getCountByServiceSeq(7)
```

Go `model.Battle()` returns `*model.BattleModel`. Rust and TypeScript use asynchronous results. Syntax follows each language; argument meaning, data structure roles, and execution rules are shared.

[Read the guide](usage.md) for binding, reads, writes, and relations. See the [component diagram](interfaces-model.md) for ownership rules.

## Implementation status

The implemented clients are **Go, PHP, Rust, and TypeScript**. All four clients generate their models with their own build tool, plan statements in the application process, and execute them through the native database driver. No service runs beside the application. See the [implementation matrix](interface-implementation.md) and the [checklist](checklist.md) for verification scope and remaining work.

[DSL](dsl.md) · [Schema](schema.md) · [IR / Plan](protocol.md) · [Complex query example](examples/complex-query.md) · [Documentation build and deployment](docs-development.md) · [한국어 문서](index.ko.md)
