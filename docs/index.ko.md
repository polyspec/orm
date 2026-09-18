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
    details: 모델 타입 하나가 조회를 만들고 읽은 행을 담는다. Go, PHP, Rust, TypeScript는 메서드 명칭, 값 규칙, 결과를 공유한다.
    link: /interfaces
  - title: connect 후 실행
    details: 모델은 connect로 연결을 받는다. 트랜잭션 콜백 안의 모델은 활성 트랜잭션을 사용하고 관계 자식은 부모 연결을 사용한다.
    link: /dsl
  - title: 세 데이터베이스
    details: MySQL, PostgreSQL, SQLite는 query 의미를 유지한다. SQL 차이와 지원 기능은 방언 문서에 기록한다.
    link: /dialects
---

## 네 클라이언트의 같은 query

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

Go `model.Battle()`은 `*model.BattleModel`을 반환한다. Rust와 TypeScript는 비동기 결과를 사용한다. 문법은 언어 관례를 따르지만 인자 의미, 자료 구조 역할, 실행 규칙은 같다.

[사용법](usage.md)에서 연결, 조회, 쓰기, relation을 확인한다. [구성요소 도표](interfaces-model.md)에서 소유 규칙을 확인한다.

## 구현 상태

구현 클라이언트는 **Go, PHP, Rust, TypeScript**다. 네 클라이언트는 자기 빌드 도구로 모델을 생성하고, 애플리케이션 프로세스 안에서 문장을 계획하고, 네이티브 데이터베이스 드라이버로 실행한다. 애플리케이션 옆에서 실행되는 서비스는 없다. 검사 범위와 잔여 작업은 [구현 대조표](interface-implementation.md)와 [체크리스트](checklist.md)에 기록한다.

[DSL](dsl.md) · [스키마](schema.md) · [IR / Plan](protocol.md) · [복합 query 예제](examples/complex-query.md) · [문서 빌드와 배포](docs-development.md) · [English](index.md)
