---
layout: home
title: Go·PHP·Python·Rust·TypeScript 공통 ORM
hero:
  name: orm
  text: Go·PHP·Python·Rust·TypeScript 공통 ORM 인터페이스
  tagline: 스키마에서 query·row·relation 타입을 생성하고 언어별 드라이버로 실행한다.
  actions:
    - theme: brand
      text: 사용법 보기
      link: /operations/usage
    - theme: alt
      text: 공통 인터페이스
      link: /spec/interfaces
features:
  - title: 공통 문법과 구조
    details: 모델 타입 하나가 조회를 만들고 읽은 행을 담는다. Go, PHP, Rust, TypeScript는 메서드 명칭, 값 규칙, 결과를 공유한다.
    link: /spec/interfaces
  - title: connect 후 실행
    details: 모델은 connect로 연결을 받는다. 트랜잭션 콜백 안의 모델은 활성 트랜잭션을 사용하고 관계 자식은 부모 연결을 사용한다.
    link: /spec/dsl
  - title: 세 데이터베이스
    details: MySQL, PostgreSQL, SQLite는 query 의미를 유지한다. SQL 차이와 지원 기능은 방언 문서에 기록한다.
    link: /spec/dialects
---
<!-- doc-id: index -->
<!-- source-sha256: 22f22f1626fa0dabcdb6fee1261ee8569fe258b8f68d39e78f38531dab5b9e29 -->

## 공통 client contract의 query

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

Go `model.Author()`은 `*model.AuthorModel`을 반환한다. Rust와 TypeScript는 비동기 결과를, Python은 동기 결과를 사용한다. 문법은 언어 관례를 따르지만 인자 의미, 자료 구조 역할, 실행 규칙은 같다.

[사용법](operations/usage.md)에서 연결, 조회, 쓰기, relation을 확인한다. [구성요소 도표](spec/interfaces-model.md)에서 소유 규칙을 확인한다.

## 구현 상태

`config/parity.json`은 **Go, PHP, PHP-extension, Rust, TypeScript, Python** 여섯 implementation을 선언한다. 위 예시는 library API의 문법을 보여 준다. PHP-extension도 공통 implementation 집합에 속하지만, 아직 끝나지 않은 native 동작과 database 근거는 [체크리스트](plans/execution/checklist.md)에 남아 있다. 공통 protocol은 caller process 안에서 planning하도록 정하며, 검증한 범위는 [구현 대조표](operations/interface-implementation.md)에 적혀 있다.

[DSL](spec/dsl.md) · [스키마](spec/schema.md) · [IR / Plan](spec/protocol.md) · [복합 query 예제](spec/complex-query.md) · [문서 빌드와 배포](operations/docs-development.md) · [English](index.md)
