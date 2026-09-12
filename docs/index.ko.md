---
layout: home
title: Go·PHP·Rust·TypeScript 공통 ORM
hero:
  name: orm
  text: Go·PHP·Rust·TypeScript 공통 ORM 인터페이스
  tagline: 스키마에서 query·row·relation 타입을 생성하고 언어별 드라이버로 실행한다.
  actions:
    - theme: brand
      text: 사용법 보기
      link: /usage
    - theme: alt
      text: 공통 인터페이스
      link: /interfaces
features:
  - title: 공통 문법과 구조
    details: 인터페이스는 Query, Binding, Row, Collection 역할을 정의하고 네 언어의 선언과 결과를 검사한다.
    link: /interfaces
  - title: 실행기 연결 후 실행
    details: 루트 query에 실행기를 연결한다. terminal에는 값만 전달하고 relation query는 루트 실행기를 사용한다.
    link: /dsl
  - title: 세 데이터베이스
    details: MySQL, PostgreSQL, SQLite는 query 의미를 유지한다. SQL 차이와 지원 기능은 방언 문서에 기록한다.
    link: /dialects
---

## 네 클라이언트의 같은 query

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

Go `gen.Battle()`은 `*gen.BattleQuery`를 반환한다. Go는 실행기와 함께 `ctx`를 전달하고 Rust와 TypeScript는 비동기 결과를 사용한다. 문법은 언어 관례를 따르지만 인자 의미, 자료 구조 역할, 실행 규칙은 같다.

[사용법](usage.md)에서 연결, 조회, 쓰기, relation을 확인한다. [구성요소 도표](interfaces-model.md)에서 소유 규칙을 확인한다.

## 구현 상태

구현 클라이언트는 **Go, PHP, Rust, TypeScript**다. TypeScript는 현재 공통 query 구조를 제공하며 모든 생성 entity 지원이 필요하다. 검사 범위와 잔여 작업은 [구현 대조표](interface-implementation.md), [체크리스트](checklist.md), [S7 작업 목록](s7.md)에 기록한다.

[DSL](dsl.md) · [스키마](schema.md) · [IR / Plan](protocol.md) · [복합 query 예제](examples/complex-query.md) · [문서 빌드와 배포](docs-development.md) · [English](index.md)
