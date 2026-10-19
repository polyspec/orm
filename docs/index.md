---
layout: home
title: Common ORM for Go, PHP, Python, Rust, and TypeScript
hero:
  name: orm
  text: Common ORM Interface for Go, PHP, Python, Rust, and TypeScript
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
<!-- doc-id: index -->

## One query in five clients

### Go

```go [Go]
count, err := model.Author().Connect(slave1).GetCountByServiceSeq(7)
```

### PHP

```php [PHP]
$count = (new Author)->connect($slave1)->getCountByServiceSeq(7);
```

### Rust

```rust [Rust]
let count = Author::new().connect(&slave1).get_count_by_service_seq(7).await?;
```

### TypeScript

```ts [TypeScript]
const count = await new Author().connect(slave1).getCountByServiceSeq(7)
```

### Python

```python [Python]
count = Author().connect(slave1).get_count_by_service_seq(7)
```

Go `model.Author()` returns `*model.AuthorModel`. Rust and TypeScript use asynchronous results, and Python a synchronous one. Syntax follows each language; argument meaning, data structure roles, and execution rules are shared.

[Read the guide](operations/usage.md) for binding, reads, writes, and relations. See the [component diagram](spec/interfaces-model.md) for ownership rules.

## Implementation status

The implemented clients are **Go, PHP, Rust, TypeScript, and Python**. All five clients generate their models with their own build tool, plan statements in the calling process, and execute them through the native database driver. No service runs beside the calling process. See the [implementation matrix](spec/interface-implementation.md) and the [checklist](plans/execution/checklist.md) for verification scope and remaining work.

[DSL](spec/dsl.md) · [Schema](spec/schema.md) · [IR / Plan](spec/protocol.md) · [Complex query example](spec/complex-query.md) · [Documentation build and deployment](operations/docs-development.md) · [한국어 문서](index.ko.md)
