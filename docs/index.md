---
layout: home
title: Go · PHP · Rust 공통 ORM
hero:
  name: orm
  text: 세 언어, 하나의 계약
  tagline: 스키마에서 쿼리·행·관계 타입을 생성하고, 공통 컴파일러와 각 언어의 드라이버로 실행해요.
  actions:
    - theme: brand
      text: 사용법 읽기
      link: /usage
    - theme: alt
      text: 공통 인터페이스
      link: /interfaces
features:
  - title: 같은 문법과 구조
    details: Query, Binding, Row, Collection의 역할과 상태를 명세하고, Go·PHP·Rust 선언과 실행 결과를 검사해요.
    link: /interfaces
  - title: 한 번 연결하고 실행
    details: 루트 쿼리에 실행기를 바인딩해요. get·gets·getCount와 finder는 값만 받고, 관계와 조회 행이 연결을 상속해요.
    link: /dsl
  - title: 세 데이터베이스
    details: MySQL, PostgreSQL, SQLite에서 같은 쿼리 의미를 유지해요. SQL 표현과 지원 범위는 방언 문서에 정리해요.
    link: /dialects
---

## 같은 조회, 세 언어

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

Go의 `gen.Battle()`은 `*gen.BattleQuery`를 반환해요. Go는 실행 취소와 기한을 전달하는 `ctx`를 실행기와 함께 바인딩하고, Rust는 비동기 결과를 `await`로 받아요. 생성 표기와 오류 전달은 언어에 맞추며, 인자 의미·자료구조의 역할·실행 계약은 함께 유지해요.

[사용법](usage.md)에서 연결과 조회·쓰기·관계를 시작하고, [공통 구성요소 도표](interfaces-model.md)에서 각 역할의 소유 관계를 확인할 수 있어요.

## 구현과 검증 상태

현재 구현 언어는 **Go·PHP·Rust**예요. TypeScript는 아직 구현하지 않았어요. 계약별 검사 범위와 남은 작업은 [구현 대조표](interface-implementation.md)와 [체크리스트](checklist.md)에 있어요.

[문법](dsl.md) · [스키마](schema.md) · [IR / Plan](protocol.md) · [복잡한 쿼리 예제](examples/complex-query.md) · [문서 빌드와 배포](docs-development.md)
