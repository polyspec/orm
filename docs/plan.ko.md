# ORM 설계 계획

이 문서는 ORM의 단일 설계 계획이다. 이전의 초기 설계, 수정 설계, DSL v3 기록을 대체한다. 결과 문법과 구조는 [DSL](dsl.md)과 [공통 인터페이스](interfaces.md)에서 정의하고, 이 문서는 목표·규칙·작업 순서를 기록한다.

## 1. 목표

ORM은 Go·PHP·Rust·TypeScript에서 하나의 모델 기반 쿼리 문법을 제공한다. 모든 클라이언트는 같은 문장을 MySQL·PostgreSQL·SQLite에서 같은 SQL로 실행한다.

## 2. 원칙

1. 모든 문법 규칙은 구현 전에 [DSL](dsl.md)에 명시한다.
2. 모든 메서드 명칭은 컬럼·연산자·연결자 규칙에서 기계적으로 만든다. 특정 컬럼 전용 편의 메서드는 제공하지 않는다.
3. 모든 문법은 네 언어에서 같은 형태로 작성한다. 언어별 표기와 생성 형태만 다르다.
4. 승인된 규칙이 없는 문법은 문서·예제·생성 코드에 쓰지 않는다.
5. 호환 계층·대체 경로·데이터 변환은 제공하지 않는다. 규칙이 틀리면 이 계획에서 정정하며 테스트 기준을 낮추지 않는다.
6. 제품 버전은 `0.0.1`로 유지한다.

## 3. 네 언어에서 제공하는 문법

| 영역 | 문법 |
|---|---|
| 연결 | 모델 생성 후 `connect(connection)`, 조회한 행·컬렉션의 연결 변경도 같은 `connect` 사용 |
| 조건 | 첫 조건 `<Chain>`, 이후 `and<Chain>` 또는 `or<Chain>`, 연결자 `and()`·`or()`, 묶음 `and(fn)`·`or(fn)`, 연산자 접두어 `Gt Lt Ge Le Eq Ne Lk Lb Between Fulltext FulltextBoolean`, `<ColA>With<ColB>(model)` |
| 조회 | `get`, `gets`, `getBy<Chain>`, `getsBy<Chain>`, `getCount`, `getCountBy<Chain>`, `getsCount`, `sum<Col>`와 `getSum`, `avg<Col>`와 `getAvg`, `keyName<Col>`, `fetchKey`, `fetchValue` |
| 컬럼 | `addColumn<Col>`, `removeColumn<Col>`, `removeAllColumns`, `addAllColumns`, `forceIndex<Name>` |
| 관계·조인 | `relation`, `relations`, `match<L>With<R>`, `alias<Name>`, `parentNode`, `possible<Col>`, `groupLimit`, `deleteLock`, `join<L>With<R>`, `leftJoin<L>With<R>`, `on(fn)` |
| 정렬·범위 | `orderBy<Col>Asc`, `orderBy<Col>Desc`, `groupBy<Col>`, `limit(offset, count)` |
| 쓰기 | 저장 컬럼 `set<Col>`, 메모리 속성 `new<Name>`, `setRaw<Col>`, `plus<Col>`, `minus<Col>`, `create`, `duplication(model)`과 `create`, `update`, `update(true)`, `save`, `delete`, `delete(true)` |
| 트랜잭션 | 교착 재시도를 포함한 `connection.transaction(fn)` |
| 페이지 | 같은 모델의 전체 개수와 한 페이지 행 |
| 스타일 | `ip`, `aes`, `aes_serialize`, `aes_hex`, `point`, `serialize`, `base64`, `gz`, `json`, `jsons`, `yaml` |

`serialize`와 `aes_serialize`는 공개된 PHP 직렬화 형식을 사용하며 각 클라이언트가 이 형식을 구현한다.

## 4. 보완

### 4.1 트랜잭션

- `connection.transaction(fn)` 안에서 `connect`를 호출하지 않은 모델은 현재 실행 흐름의 활성 트랜잭션에서 실행된다. 트랜잭션 밖에서 `connect` 없이 모델을 실행하면 `CONFIG`를 반환한다.
- 활성 트랜잭션 안에서 같은 연결의 트랜잭션을 호출하면 savepoint를 만든다. 안쪽 콜백의 실패는 안쪽 작업만 되돌린다. 바깥 콜백이 그 실패를 반환하면 전체 트랜잭션을 되돌린다.
- 하나의 트랜잭션 연결을 동시에 사용하면 오류를 반환한다. 콜백 안에서 시작한 task나 goroutine에는 활성 트랜잭션이 없다.
- begin, commit, rollback, 실행기, 실행 컨텍스트는 비공개다.
- 콜백 결과는 언어 규칙을 따른다. Go는 `error`, Rust는 `Result`를 반환하고 PHP와 TypeScript는 예외를 던진다.
- 행 잠금 `forUpdate`, `forShare`, `forUpdateNoWait`, `forShareNoWait`는 트랜잭션 안에서만 허용한다.

### 4.2 정확성 규칙

- 생성기는 예약 메서드(`and`, `or`, `get`, `gets`, `limit`, `alias`, `connect`, `create`, `update`, `delete`, `save`)와 같거나 예약 접두어(`and`, `or`, `get`, `set`, `new`, `plus`, `minus`, `orderBy`, `groupBy`, 연산자 접두어)로 시작하는 컬럼 명칭을 거부한다.
- 조건은 트리로 저장한다. 종단 작업은 빌더를 바꾸지 않으므로 두 번째 종단 작업도 같은 SQL 문장을 만든다.
- 드라이버 교착 오류에 대해 교착 재시도를 실행한다.
- 조인 인덱스 힌트는 조인한 테이블에 적용한다. 모든 조인의 집계와 정렬을 반영한다. 관계 키 기본값은 부모 키를 사용한다. `possible<Col>`은 조인한 부모 행을 읽는다.
- `minus<Col>`은 음수를 저장하지 않는다. `plus<Col>`과 `minus<Col>`은 값을 바인드한다. 쓰기 후 속성 변경 기록을 비운다.
- `update(true)`는 현재 속성 값이 아니라 조회한 `updated_ts` 저장 값을 비교한다.
- 빈 목록 값은 SQL 실행 전에 `EMPTY_IN`을 반환한다.

## 5. 네 언어 규칙

### 5.1 모델 생성과 연결

| 언어 | 생성 | 연결한 모델 | 연결한 조회 행 |
|---|---|---|---|
| PHP | `new Product` | `(new Product)->connect($slave1)` | `$row->connect($master)` |
| Go | `model.Product()` | `model.Product().Connect(slave1)` | `row.Connect(master)` |
| Rust | `Product::new()` | `Product::new().connect(&slave1)` | `row.connect(&master)` |
| TypeScript | `new Product()` | `new Product().connect(slave1)` | `row.connect(master)` |

- 생성은 각 언어 형태를 사용한다. Go는 생성된 `model` 패키지의 함수를 사용하며 `*model.ProductModel`을 반환한다.
- 연결 메서드는 `connect` 하나다. `on`은 조인 조건 전용이다.
- PHP는 `(new Product)($slave1)`과 `$row($master)`도 `connect`의 짧은 형태로 허용한다.

### 5.2 조건

- 첫 조건에는 접두어가 없다. 이후 조건은 `and<Chain>`, `or<Chain>`, 또는 연결자 `and()`·`or()` 다음의 `<Chain>`을 사용한다. 연결자 누락, 묶음 시작 위치의 연결자, 뒤따르는 조건이 없는 연결자는 `CONFIG`를 반환한다.
- `<Chain>`은 `And`, `Or`, 연산자 접두어, `<ColA>With<ColB>`를 포함한 모든 컬럼 조합을 허용한다. 인자는 키 순서를 따른다. 같은 체인을 `getBy`, `getsBy`, `getCountBy`, `getsCountBy` 뒤에도 사용할 수 있다.
- 묶음은 `and(fn)`과 `or(fn)`만 사용한다. 콜백은 같은 타입의 빈 모델을 받으며 조건 메서드만 허용한다. 콜백 안의 종단 작업이나 쓰기는 `CONFIG`를 반환한다.
- PHP는 호출 시점에 체인을 해석한다. Go, Rust, TypeScript는 소비자 소스가 호출하는 체인 메서드만 생성한다. 생성기는 소비자 소스를 읽어 각 체인을 해석하고 스키마와 대조한 뒤 해당 메서드만 작성한다.

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

### 5.3 관계와 조인

- `connect`를 호출하지 않은 관계·조인 자식은 부모 연결을 사용한다.
- `connect`를 호출한 관계 자식은 그 연결에서 별도 질의를 실행한다. 트랜잭션 안에서는 같은 흐름에 그 연결의 활성 트랜잭션이 있으면 그 트랜잭션을 사용한다.
- 조인은 하나의 SQL 문장이므로 `connect`를 호출한 조인 자식은 `CONFIG`를 반환한다.

## 6. 추가 기능

| 영역 | 기능 |
|---|---|
| 운영 | AES 키 회전과 상태 조회, 행 잠금, savepoint, 트랜잭션 옵션(격리 수준·읽기 전용·timeout), 일괄 삽입, SQL 출력, 스키마 검사를 포함한 원시 형태, 스키마 설치와 마이그레이션, 큰 `IN` 목록 분할 |

## 7. 작업 순서

1. 3절부터 6절까지를 기준으로 [DSL](dsl.md), [공통 인터페이스](interfaces.md), 가이드, README와 한국어 문서를 다시 작성한다.
2. 이 계획의 문법에 맞춰 `contracts/interfaces.json`, `contracts/features.json`, `contracts/rules.json`을 갱신한다.
3. 애플리케이션 사용 사례에서 실패하는 conformance 벡터를 추가한다. 대상은 관계를 포함한 목록, upsert, 낙관적 갱신, 재귀 삭제, 여러 쓰기를 포함한 트랜잭션, 다른 연결의 관계, 4.2절 결함, 4.1절 트랜잭션 규칙이다.
4. Go, PHP, Rust, TypeScript 순서로 생성기와 런타임을 갱신하고 클라이언트를 다시 생성한다.
5. `make check`, SQLite·PostgreSQL·MySQL conformance, 공개 심볼 감사, 반복 생성, `make docs-check`를 실행한다.
6. Platform, SDK, 모듈 모델을 다시 생성하고 호출 코드를 갱신한다.

## 8. 완료 기준

- 문서, 매니페스트, 생성 클라이언트, 테스트가 같은 문법을 기술한다.
- 애플리케이션 기반 conformance 벡터가 네 언어와 세 데이터베이스에서 통과한다.
- 4.2절 회귀 테스트가 모두 통과하고 공개 심볼이 공통 인터페이스와 일치한다.
- 이 기준을 충족하지 않은 작업은 완료로 기록하지 않는다.
