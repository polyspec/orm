<!-- doc-id: dsl -->
<!-- source-sha256: 274cad42457739f04be1d4e258cc2e53d96b54ff056b400aebb7a07c38ec4a0c -->
# DSL

이 문서는 [설계 계획](plan.md)이 정한 쿼리 문법을 정의한다. 클라이언트 상태는 [구현 대조표](../operations/interface-implementation.md)에 기록하며, 이 문서와 일치하지 않는 클라이언트는 미완료 상태다.

## 1. 모델과 연결

- **DSL-1** 쿼리는 모델에서 시작한다. 모델은 언어 형태로 생성하고 `connect`로 데이터베이스 연결을 받는다.

- **DSL-2** PHP — 생성: `new Product`; 연결한 모델: `(new Product)->connect($slave1)`; 연결한 조회 행: `$row->connect($master)`
- **DSL-3** Go — 생성: `model.Product()`; 연결한 모델: `model.Product().Connect(slave1)`; 연결한 조회 행: `row.Connect(master)`
- **DSL-5** Rust — 생성: `Product::new()`; 연결한 모델: `Product::new().connect(&slave1)`; 연결한 조회 행: `row.connect(&master)`
- **DSL-6** TypeScript — 생성: `new Product()`; 연결한 모델: `new Product().connect(slave1)`; 연결한 조회 행: `row.connect(master)`
- **DSL-4** Python — 생성: `Product()`; 연결한 모델: `Product().connect(slave1)`; 연결한 조회 행: `row.connect(master)`

- **DSL-7** 연결 메서드는 `connect` 하나다. 조회한 행이나 컬렉션도 쓰기 전에 같은 메서드를 사용하므로, 복제본에서 읽은 행을 기본 연결로 쓸 수 있다.
- **DSL-8** PHP는 `(new Product)($slave1)`과 `$row($master)`를 `connect`의 짧은 형태로 허용한다.
- **DSL-9** Go는 생성된 `model` 패키지의 함수를 사용한다. `model.Product()`는 `*model.ProductModel`을 반환한다.
- **DSL-10** 트랜잭션 콜백 안에서 `connect`를 호출하지 않은 모델은 현재 실행 흐름의 활성 트랜잭션을 사용한다. 트랜잭션 밖에서 `connect` 없는 모델의 종단 작업이나 쓰기는 `CONFIG`를 반환한다.

## 2. 조건

### 2.1 연결자와 묶음

- **DSL-11** 첫 조건에는 접두어가 없으며, 접두어를 적어도 무시한다. 이후 조건은 메서드 명칭 안의 `and`·`or` 또는 별도 연결자로 시작한다.

```php
(new Product)->connect($slave1)
    ->serviceSeq($serviceSeq)
    ->andIsClose(0)
    ->or()->isSale(2)
    ->and(fn (Product $q) => $q->isSale(1)->andLtSaleStartDt($now))
    ->gets();
```

- **DSL-12** `<Chain>(…)` — 의미: 모델 또는 묶음의 첫 조건
- **DSL-13** `and<Chain>(…)`, `or<Chain>(…)` — 의미: `AND` 또는 `OR`로 연결한 조건
- **DSL-14** `and()`, `or()` 다음의 `<Chain>(…)` — 의미: 같은 연결을 별도 호출로 작성한 형태
- **DSL-15** `and(fn)`, `or(fn)` — 의미: `AND` 또는 `OR`로 연결한 괄호 묶음
- **DSL-16** `not(fn)`, `andNot(fn)`, `orNot(fn)` — 의미: 첫 조건이거나 `AND` 또는 `OR`로 연결한 부정 묶음 `NOT (…)`
- **DSL-17** `and(model)`, `or(model)` — 의미: 조인한 모델에 설정한 조건의 괄호 묶음

- **DSL-18** 모델이나 묶음의 시작 위치에 있는 연결자는 연결할 대상이 없으므로 무시한다. `and(fn)`, `or(fn)`, `and()`, `or()`, `and<Chain>(…)`, `or<Chain>(…)`은 모두 첫 조건으로 읽고, 문장은 그 조건이나 묶음으로 시작한다.
- **DSL-19** 두 조건 사이의 연결자 누락과 뒤따르는 조건이 없는 연결자는 `CONFIG`를 반환한다.
- **DSL-20** 묶음 콜백은 같은 타입의 빈 모델을 받는다. 콜백은 조건 메서드만 허용하며 콜백 안의 종단 작업·쓰기·`connect`는 `CONFIG`를 반환한다.
- **DSL-21** 괄호는 묶음으로만 작성한다.

- **DSL-22** `not(fn)`은 묶음 전체를 부정하며 부정 묶음은 항상 괄호를 가진다. Rust는 연결한 두 형태를 `and_not`, `or_not`이라 부른다. 조건을 하나도 더하지 않은 콜백은 `CONFIG`를 반환한다.

### 2.1.1 쿼리 식 문법

- **DSL-23** 조건은 중립 문법의 식 하나다. 이 식은 MySQL, PostgreSQL, SQLite에서 같게 렌더링되고 같은 의미를 가진다. 원소 집합은 dbspec `check`의 predicate 집합([dbspec](dbspec.ko.md#check))이다: 비교(`=`, `<>`, `<`, `<=`, `>`, `>=`), `in`, `is [not] null`, `and`, `or`, 괄호 묶음이며 피연산자는 column과 값이다. 값은 type 있는 bind다: 만나는 column의 dbspec type이나 비교하는 column 함수의 결과 type을 가지며([dialects](dialects.ko.md)), SQL에 쓴 literal이 아니다. 쿼리는 `check`에 없는 확장 세 가지를 더한다. introspection은 database에서 이것을 복원할 수 없지만 쿼리는 introspection하지 않기 때문이다:

- `not(fn)`, `andNot(fn)`, `orNot(fn)`의 `not`;
- 모든 database가 `BETWEEN`으로 렌더링하는 `Between` 연산자의 `between`;
- column 함수 `year`, `month`, `dayOfWeek`, `date`와 값 함수 `now`, `today`, `<unit>Ago`, `<unit>Later`(10절). 각각 database마다 렌더링이 하나다.

- **DSL-24** 기존 `Lk`, `Lb`, `Fulltext`, `FulltextBoolean`, tuple 연산자와 column 비교는 그 규칙을 유지한다. 산술은 문법에 없다: 정수 overflow와 나눗셈이 세 database에서 다르다. DSL에는 SQL text 형식이 없다. 조건, 컬럼, 정렬, 그룹, 할당은 이 문서의 메서드로만 쓰므로 모든 값은 type 있는 bind로 database에 간다.

### 2.2 체인

- **DSL-25** 체인은 `And` 또는 `Or`로 구분한 하나 이상의 키다. 각 키는 순서대로 인자 하나를 사용한다.

```text
Chain = Key { ("And" | "Or") Key }
Key   = [Operator] Column
      | Column Operator Column
      | ("Fulltext" | "FulltextBoolean") Column { "With" Column }
      | ["Ne"] "Tuple" Column "With" Column { "With" Column }
```

- **DSL-26** 없음, `Eq` — SQL: `=`
- **DSL-27** `Ne` — SQL: `!=`
- **DSL-28** `Gt`, `Lt`, `Ge`, `Le` — SQL: `>`, `<`, `>=`, `<=`
- **DSL-29** `Lk` — SQL: 값 앞뒤에 와일드카드를 둔 `LIKE`
- **DSL-30** `Lb` — SQL: 값 앞뒤에 와일드카드를 둔 binary `LIKE`
- **DSL-31** `Between` — SQL: 길이 2 고정 배열을 받는 `BETWEEN`
- **DSL-32** `Fulltext` — SQL: 자연어 모드 전문 검색
- **DSL-33** `FulltextBoolean` — SQL: boolean 모드 전문 검색

- **DSL-34** `<ColA><Op><ColB>(model)`는 같은 SQL 문장 안에서 호출한 모델의 컬럼 `ColA`와 `model`의 컬럼 `ColB`를 비교한다. `(new Product)->priceGtMinPrice($brand)`는 `a.price > b.min_price`를 출력한다. `Op`는 `Eq`, `Ne`, `Gt`, `Lt`, `Ge`, `Le`다. `on(fn)` 안에서 호출한 모델은 조인 자식이다.
- **DSL-35** `tuple<ColA>With<ColB>(list)`는 여러 컬럼을 값 묶음 목록과 비교한다. `tupleTenantIdWithAccountId([[1, 10], [2, 10]])`는 `(tenant_id, account_id) IN ((1, 10), (2, 10))`이다. `Ne`는 `NOT IN`을 만든다. Go는 컬럼마다 필드가 하나인 생성 값 묶음 구조체 `model.<Model><ColA>With<ColB>`, Rust는 튜플, TypeScript는 타입을 지정한 튜플, Python은 튜플을 사용한다. SQLite는 목록을 `IN (VALUES …)`로 출력한다.
- **DSL-36** `getsByServiceSeqAndIsClose(7, 0)`와 `serviceSeq(7)->andIsClose(0)->gets()`는 같은 조건을 만든다.
- **DSL-37** 체인은 모든 컬럼을 조합할 수 있다. PHP와 Python은 호출 시점에 체인을 해석하고, Go, Rust, TypeScript는 읽은 소스가 호출하는 체인 메서드를 생성하고, 알 수 없는 컬럼·연산자·인자 개수는 생성 단계에서 거부하며, PHP는 `--scan`을 주면 같은 메서드를 `@method` 태그로 선언하고 같은 오류를 생성 단계에서 거부한다. Python의 scan은 어떤 규칙에도 맞지 않는 model method를 생성 단계에서 보고한다.
- **DSL-38** 각 언어는 자기 빌드 도구로 생성한다.
  - **DSL-39** Go는 `--scan`으로 지정한 패키지를 읽고 호출이 타입 검사를 통과할 때까지 반복한다. `//go:generate` 줄에서 `go run github.com/polyspec/orm/packages/go/cmd/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --lang go --out model --scan ./...`를 실행한다. 기본 빌드가 `//go:build` 제약으로 제외하는 파일은 그 제약에 필요한 태그, GOOS, GOARCH로 읽으므로 `GOFLAGS=-tags` 없이도 태그를 지정한 테스트를 포함한다. 기본 빌드는 읽을 모든 패키지를 한 번 읽고, 그런 설정은 그 파일을 가진 패키지만 읽으며 다른 모든 패키지의 타입 정보는 기본 빌드에서 가져온다.
  - **DSL-40** TypeScript는 `--scan`으로 지정한 파일을 oxc-parser로 읽고 정확한 메서드 시그니처를 작성한다. `tsc` 전에 `build` 스크립트에서 `orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out src/models --scan src`를 실행한다.
  - **DSL-41** Rust는 `build.rs`에서 `scan`으로 지정한 소스를 `syn`으로 읽는다. `polyspec_orm_build::Builder::set("contracts/fixtures/bench/dbspec-set.json").scan("src").generate()`를 실행하고, `polyspec_orm::models!()`가 결과를 `model` 모듈로 포함한다.
  - **DSL-42** PHP는 컬럼 메타데이터와 타입이 있는 getter·setter를 가진 모델 클래스를 작성한다. `vendor/bin/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out src/Model --namespace Example\Model --scan src`를 실행한다. `--scan`은 파일이나 디렉터리를 받고 여러 번 쓸 수 있다. 디렉터리는 그 안의 `vendor`와 `node_modules` 디렉터리를 빼고 읽으며, symlink를 만나면 따라가지 않고 상태 1로 생성을 멈춘다. `nikic/php-parser`로 PHP 파일을 읽고, 소스가 그 모델에서 호출하는 체인 메서드(예: `ltSeq`, `andIsClose`, `getsBySeqAndName`)마다 타입이 있는 `@method` 태그를 각 모델 클래스의 주석에 선언하므로 PHPStan이 호출을 찾는다. 호출은 그대로 `__call`로 실행된다. 받는 사람은 생성 클래스 `C`의 `new C`(`use` 별칭 포함), 그 클래스로 선언한 변수·매개변수·반환 타입, 모델의 체인 메서드, `and`·`or`·`not`·`andNot`·`orNot`·`on`·`fetchKey`·`fetchValue`에 준 클로저의 타입 없는 첫 매개변수일 때 모델로 읽는다. 다른 받는 사람의 호출은 태그를 더하지 않는다. 어떤 컬럼·체인·연산자도 받지 않는 이름이나 체인이 받지 않는 인자 개수의 호출은 모델과 메서드 이름을 밝히며 상태 1로 생성을 멈춘다.
  - **DSL-43** Python은 타입이 있는 getter·setter를 가진 모델 클래스를 작성하고, 읽은 source 중 어떤 규칙에도 맞지 않는 model method를 보고한다. package가 설치하는 console script로 `orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out model --scan src`을 실행한다.
  - **DSL-44** scan의 getter는 다섯 generator에서 같은 규칙이다. model로 해석되는 receiver에 대한 scan된 `get<Name>()` 호출(Python과 Rust는 `get_<name>()`)은 column getter, 고정 method, `getBy`·`getsBy`·`getCountBy` chain이 아니면 getter다. getter는 relation child의 `alias<Name>()` 호출, `new<Name>()` 호출, `<Name>`을 이름 짓는 `addColumn` 호출이 붙이며, relation 결과 `get<Model>Model`·`get<Model>Models`도 getter다. relation 안에 중첩된 relation의 alias는 중첩 relation을 호출한 model에 getter를 붙인다. `new Product().relation(new Store().matchSeqWithStoreSeq().aliasStore().relation(new Match().matchStoreSeqWithSeq().aliasMatch()))`는 Product에 `getStore`를, Store에 `getMatch`를 준다. getter는 선언된 model을 반환하지 않으므로, getter로 읽은 receiver는 TypeScript에서는 getter의 type argument(`row.getStore<Store | null>()`), Go·Rust(`Option<Store>`)·Python(`store: Store | None = row.get_store()`)에서는 binding의 type, PHP에서는 대입에 붙인 `/** @var Store|null $store */` tag로 model을 밝힌다. `Iterable<Store>`(TypeScript), `Iterable[Store]`(Python) 또는 model collection으로 type을 밝힌 parameter는 loop에 model을 준다. 아무것도 붙이지 않는 scan된 getter 호출은 생성을 멈추고 model과 method를 밝히므로, 빠진 getter가 message 없이 버려지는 일은 없다. scan은 receiver가 가질 수 있는 class 중 어느 것도 선언하지 않을 때만 model method 호출을 거부한다. PHP generator는 인자 개수도 그 class들에 대해 검사한다. 나머지 client는 선언되지 않은 chain method와 인자 개수를 컴파일러에, Python은 호출 자체에 맡긴다. 사용하는 외부 document의 used table은 set의 entity이므로(T209), 그 entity에 대한 관계도 다른 entity와 같이 getter를 붙인다.
  - **DSL-151** scan된 호출은 class를 import한 generated model이 속한 set의 호출이며, import binding은 그 언어의 checker가 해석하는 대로 해석한다. 다른 set의 generated model에서 import한 같은 이름의 class는 다른 class이므로, 그 호출은 이 set의 generation이 선언하지도 거부하지도 않는다. Go는 receiver type의 package를 따른다. TypeScript는 relative나 absolute specifier를 import하는 file 기준으로 해석한다: set의 `models.ts`는 그 set의 것이고, orm-gen이 다른 manifest(그 `MANIFEST_HASH`)로 생성한 module은 다른 set의 것이다; scan의 어떤 file도 가리키지 않는 bare specifier(package나 path alias)는 class 이름을 따른다. PHP는 `use`와 namespace가 class에 주는 fully qualified name을 따른다. Python은 relative import를 import하는 file에서 set의 `models.py`로 해석하고, absolute import는 dotted name이 그 file path의 꼬리일 때 그 file을 가리킨다. Rust는 path나 `use`가 class에 이르는 module을 따른다: set의 `orm_model.rs`를 `include!`하는 module(`OUT_DIR`이면 `polyspec_orm::models!()`)은 그 set의 것이고, 다른 `orm_model.rs`를 include하는 module은 다른 set의 것이다. 변수에 담긴 receiver는 변수 이름이 아니라 checker가 그 변수의 type을 정하는 대로, 변수의 initializer와 모든 재대입을 거쳐 그 class와 class의 import binding으로 해석한다: import한 class의 chain으로 초기화되고 conditional expression(`c ? a : b`, `a if c else b`, `if c { a } else { b }`)이나 branch에서 자기 chain으로 재대입된 변수는 그 class를 가지므로, 각 재대입 뒤의 호출은 그 class의 호출이다. 어떤 import도 가리키지 않는 class는 전처럼 이름을 따른다.

### 2.3 값 형태

- **DSL-45** 값 하나 — 연산자 없음 또는 `Eq`: `= ?`; `Ne`: `!= ?`
- **DSL-46** 목록 — 연산자 없음 또는 `Eq`: `IN (…)`; `Ne`: `NOT IN (…)`
- **DSL-47** 빈 목록 — 연산자 없음 또는 `Eq`: SQL 실행 전 `EMPTY_IN`; `Ne`: SQL 실행 전 `EMPTY_IN`
- **DSL-48** null — 연산자 없음 또는 `Eq`: `IS NULL`; `Ne`: `IS NOT NULL`

```php
->andPhotoUrl('a.png')->andPhotoUrl(['a', 'b'])->andPhotoUrl(null)->andNeSeq([1, 2])
```

```go
.AndPhotoUrl("a.png").AndPhotoUrl([]string{"a", "b"}).AndPhotoUrl(orm.Null).AndNeSeq([]int{1, 2})
```

```rust
.and_photo_url("a.png").and_photo_url(vec!["a", "b"]).and_photo_url(Null).and_ne_seq(vec![1, 2])
```

```ts
.andPhotoUrl('a.png').andPhotoUrl(['a', 'b']).andPhotoUrl(null).andNeSeq([1, 2])
```

```python
.and_photo_url('a.png').and_photo_url(['a', 'b']).and_photo_url(None).and_ne_seq([1, 2])
```

- **DSL-49** null은 nullable 컬럼에서만 허용한다. Go·Rust·TypeScript는 NOT NULL 컬럼의 null을 컴파일 단계에서 거부하고 PHP와 Python은 `CONFIG`를 반환한다.
- **DSL-50** 목록은 연산자가 없거나 `Eq`·`Ne`일 때만 허용한다. 다른 연산자는 목록과 null을 거부한다.
- **DSL-51** PHP, TypeScript, Python은 각자의 null 값을, Go는 `orm.Null`을, Rust는 `Null`을 사용한다.
- **DSL-52** Go 메서드는 컬럼별 허용 값 타입을 제네릭 타입 매개변수로 제한한다. 정수 컬럼은 `int`, `int32`, `int64`와 각 타입의 슬라이스를 허용한다.
- **DSL-53** 실행하지 않은 모델을 값으로 넘기면 `IN (SELECT …)`, `Ne`와 함께 쓰면 `NOT IN`을 출력한다. 모델은 `addColumn<Col>()`로 컬럼 하나만 추가해야 하며 아니면 `CONFIG`를 반환한다.
- **DSL-54** ORM 함수 값은 10절의 함수를 적용한다. 컬럼 함수는 컬럼을 감싸며 비교 값은 메서드의 두 번째 인자다. 예: `andEqCreatedTs(Orm::year(), 2026)`. 값 함수는 비교 값 자체다. 예: `andGtCreatedTs(Orm::daysAgo(7))`.
- **DSL-55** `Between`은 길이 2 고정 배열을 받는다. PHP `[1, 10]`, Go `[2]int{1, 10}`, Rust `[1, 10]`, TypeScript `[number, number]` 타입의 `[1, 10]`, Python `[1, 10]`이다. Go·Rust·TypeScript는 다른 길이를 컴파일 단계에서 거부하고 PHP와 Python은 `CONFIG`를 반환한다.

## 3. 조회

- **DSL-56** `get()` — 결과: 행 하나; 일치하는 행이 없으면 null
- **DSL-57** `gets()` — 결과: 행 컬렉션
- **DSL-58** `getBy<Chain>(…)` — 결과: 체인을 조건으로 사용하는 `get()`
- **DSL-59** `getsBy<Chain>(…)` — 결과: 체인을 조건으로 사용하는 `gets()`
- **DSL-60** `getCount()`, `getCountBy<Chain>(…)` — 결과: 행 개수; 일치하는 행이 없으면 0
- **DSL-61** `getsCount()` — 결과: `row_count`를 포함한 그룹 행
- **DSL-62** `sum<Col>()`와 `getSum()` — 결과: 컬럼 합계; 값이 없으면 0
- **DSL-63** `avg<Col>()`와 `getAvg()` — 결과: 컬럼 평균; 값이 없으면 null
- **DSL-64** `getsPage(page, perPage)` — 결과: `items`, `totalCount`, `totalPages`, `page`, `perPage`를 포함한 한 페이지
- **DSL-65** `getQuery()` — 결과: 실행하지 않은 `gets()`의 SQL 문장과 바인드 값

- **DSL-66** `getSum()`과 `getAvg()`는 데이터베이스의 숫자 스칼라를 가장 가까운 유한 IEEE 754 binary64 값으로 변환하며 정확히 중간인 값은 짝수 쪽으로 반올림한다. SQL `SUM`과 `AVG`는 null 값을 건너뛰고, 남은 값이 없으면 일치하는 행이 없든 모든 값이 null이든 null scalar를 준다. 그러면 `getSum()`은 값이 없는 합인 0을, `getAvg()`는 null을 반환한다. 값이 없는 평균은 정의되지 않으며 0은 지어낸 평균이기 때문이다. 숫자가 아닌 값, 유한하지 않은 값, 범위 초과 값은 `CODEC_DECODE`를 반환한다. 행 컬럼 디코딩에는 무손실 변환 규칙을 유지한다.
- **DSL-67** `getsPage`는 같은 조건과 조인으로 행 개수를 계산한다. 그룹 모델은 서로 다른 그룹 키 개수를 계산한다. `page`와 `perPage`는 양수여야 하며 `limit`를 지정한 모델은 `CONFIG`를 반환한다. 마지막 페이지 이후를 요청하면 빈 컬렉션을 반환한다. orm은 화면 출력, 요청 값 읽기, redirect를 하지 않는다.
- **DSL-68** 방언이 SQL 문장을 정하므로 `getQuery`는 연결한 모델이나 활성 트랜잭션에서만 사용할 수 있으며 아니면 `CONFIG`를 반환한다. 비밀 값은 `$SECRET`로 표시한다.
- **DSL-69** 종단 작업은 체인 값 외의 인자를 받지 않는다. 종단 작업은 모델을 바꾸지 않으므로 두 번째 종단 작업도 같은 SQL 문장을 만든다.
- **DSL-70** `keyName<Col>()`은 컬렉션 키 컬럼을 정한다. `fetchKey(fn)`은 컬렉션 키를 계산한다. `fetchValue(fn)`은 조회한 각 행 값을 콜백 결과로 바꾼다.
- **DSL-71** 행은 `get<Col>()` getter를 제공한다. 관계 결과는 생성된 관계 getter로 읽는다.

## 4. 컬럼

- **DSL-72** `addColumn<Col>()` — 동작: 컬럼 하나 추가
- **DSL-73** `addColumn<Col>Alias<Name>(fn)` — 동작: 출력 명칭을 지정한 컬럼 함수(10절) 컬럼 추가
- **DSL-74** `addColumn<Name>(fn)` — 동작: 스칼라 서브쿼리 컬럼 추가. 콜백은 호출한 모델을 받아 실행하지 않은 모델을 반환한다
- **DSL-75** `removeColumn<Col>()` — 동작: 컬럼 하나 제외
- **DSL-76** `removeAllColumns()` — 동작: 기본 키와 외래 키만 유지
- **DSL-77** `addAllColumns()` — 동작: 모든 컬럼 선택
- **DSL-78** `forceIndex<Name>()` — 동작: 모델 테이블에 인덱스 힌트 추가

```php
(new User)->connect($slave1)
    ->addColumnCash(fn (User $u) => (new Point)->sumAmount()->toUserSeqEqSeq($u)->andStatus(1))
    ->gets();
// (SELECT COALESCE(SUM(b.amount), 0) FROM point b WHERE b.to_user_seq = a.seq AND b.status = ?) AS cash
```

## 5. 관계와 조인

### 5.1 관계

- **DSL-79** 관계는 부모 키로 별도 질의를 실행하고 결과를 각 부모 행에 연결한다.

```php
$orders = (new Order)->connect($slave1)
    ->relation((new Status)->matchStatusSeqWithSeq()->aliasOrderStatus())
    ->relations((new OrderItem)->matchSeqWithOrderSeq()->groupLimit(5))
    ->orderBySeqDesc()
    ->gets();
```

- **DSL-80** `relation(child)` — 동작: 관련 행 하나 연결
- **DSL-81** `relations(child)` — 동작: 관련 행 컬렉션 연결
- **DSL-82** `match<L>With<R>()` — 동작: 부모 컬럼 `L`과 자식 컬럼 `R`이 같음. composite key는 성분마다 key 순서대로 한 번씩 부른다. 예: `matchTenantIdWithTenantId().matchAccountIdWithAccountId()`
- **DSL-83** `alias<Name>()` — 동작: 관계 결과 명칭
- **DSL-84** `parentNode()` — 동작: 자식 컬럼을 부모 행에 병합
- **DSL-85** `possible<Col>(value)` — 동작: 부모 컬럼이 값과 같을 때만 자식 조회
- **DSL-86** `groupLimit(count)` — 동작: 부모 키별 자식 행 수 제한
- **DSL-87** `deleteLock()` — 동작: 재귀 삭제에서 관계 제외

- **DSL-88** `connect`를 호출하지 않은 자식은 부모 연결을 사용한다. `connect`를 호출한 자식은 그 연결에서 질의를 실행한다.
- **DSL-89** 관계 결과 명칭은 `relation`이면 `<table>_model`, `relations`이면 `<table>_models`이며 `get<Table>Model()` 또는 `get<Table>Models()`로 읽는다. `alias<Name>()`은 결과 명칭을 바꾸며 결과는 `get<Name>()`으로 읽는다.

```php
$env = (new ServiceEnvironment)->connect($slave1)
    ->relations((new ServiceUrl)->matchSeqWithServiceEnvironmentSeq()->aliasUrls())
    ->relation((new User)->matchWriterSeqWithSeq()->aliasWriter())
    ->relation((new User)->matchEditorSeqWithSeq()->aliasEditor())
    ->getBySeq($seq);
$env->getUrls(); $env->getWriter(); $env->getEditor();
```

### 5.2 조인

- **DSL-90** 조인은 자식 테이블을 같은 SQL 문장에 추가한다.

- **DSL-91** `join<L>With<R>(child)` — SQL: 부모 컬럼 `L`과 자식 컬럼 `R`로 `INNER JOIN`
- **DSL-92** `leftJoin<L>With<R>(child)` — SQL: 부모 컬럼 `L`과 자식 컬럼 `R`로 `LEFT JOIN`
- **DSL-93** 자식의 `on(fn)` — SQL: 조건 문법으로 작성한 `ON` 조건

```php
$brandLang = (new ProductBrandLang)
    ->on(fn (ProductBrandLang $b) => $b->langId($langId))
    ->lkName($keyword);

(new Product)->connect($slave1)
    ->leftJoinProductBrandSeqWithProductBrandSeq($brandLang)
    ->serviceSeq($serviceSeq)
    ->and(fn (Product $q) => $q->lkName($keyword)->or($brandLang))
    ->gets();
```

```go
brandLang := model.ProductBrandLang().
    On(func(b *model.ProductBrandLangModel) { b.LangId(langId) }).
    LkName(keyword)

rows, err := model.Product().Connect(slave1).
    LeftJoinProductBrandSeqWithProductBrandSeq(brandLang).
    ServiceSeq(serviceSeq).
    And(func(q *model.ProductModel) { q.LkName(keyword).Or(brandLang) }).
    Gets()
```

- **DSL-94** 자식은 조인 메서드에 전달하기 전에 설정한다. `on(fn)`은 `ON` 조건을 정하며 콜백은 자식을 받아 조건 문법을 사용한다.
- **DSL-95** 자식에 직접 설정한 조건은 `WHERE` 조건이다. `and(model)` 또는 `or(model)`은 그 조건을 해당 위치의 묶음으로 넣는다. 묶음에 전달하지 않은 자식 조건은 `AND`로 추가된다.
- **DSL-96** 같은 자식을 두 묶음에 전달하거나 문장에서 조인하지 않은 모델을 전달하면 `CONFIG`를 반환한다.
- **DSL-97** 자식 컬럼은 각 행의 자식 결과로 반환된다.
- **DSL-98** `connect`를 호출한 조인 자식은 `CONFIG`를 반환한다.

## 6. 정렬과 범위

- **DSL-99** `orderBy<Col>Asc()`, `orderBy<Col>Desc()`, `orderBySeqDescAndNameAsc()` 같은 체인이 정렬을 정한다. `orderByRandom()`은 방언 함수로 행을 무작위 정렬한다. `groupBy<Col>()`은 `getsCount()`와 group count에서 그룹을 정하며, 다른 읽기에서는 `IR_INVALID`이다. `limit(offset, count)`은 범위를 정한다.

## 7. 쓰기

- **DSL-100** `set<Col>(value)` — 동작: 저장 컬럼 값. 컬럼이 존재해야 한다
- **DSL-101** `new<Name>(value)` — 동작: 컬럼이 아닌 명칭으로 값을 행에 추가. 아래 규칙 참고
- **DSL-102** `plus<Col>(n)`, `minus<Col>(n)` — 동작: 바인드한 증가·감소. `minus`는 음수를 저장하지 않는다
- **DSL-103** `create()` — 동작: 삽입 후 생성 키를 포함한 행 반환
- **DSL-104** `creates(models, batch)` — 동작: `set<Col>`로 만든 모델을 `batch` 행씩의 묶음으로, 묶음마다 multi-row INSERT 하나로, 모두 한 트랜잭션(활성 트랜잭션 안에서는 savepoint)에서 삽입하고 삽입한 행 수 반환. 모든 모델은 같은 컬럼을 설정해야 한다. `batch`는 필수이며 양의 정수이고, 아니면 `CONFIG`다. bind 수가 dialect bind 한도를 넘는 묶음은 `BATCH_TOO_LARGE`다. 둘 다 어떤 statement보다 먼저 실패한다
- **DSL-105** `duplication(model)`과 `create()` — 동작: `model`의 변경 값으로 중복 키 갱신을 포함한 삽입
- **DSL-106** `update()` — 동작: 행의 변경 컬럼 갱신
- **DSL-107** `update(true)` — 동작: 저장된 `updated_ts`가 조회 값과 같을 때만 갱신, 다르면 `OPTIMISTIC_LOCK`
- **DSL-108** `update()`나 `delete()`와 함께 쓴 `expectRevision(column, revision)` — 동작: 행의 `column`이 여전히 `revision`일 때만 쓴다. `update()`는 `revision + 1`도 저장한다. 아니면 `REVISION_CHANGED`이며 아무것도 바뀌지 않는다. 아래 규칙을 본다
- **DSL-109** `save()` — 동작: 기본 키가 있으면 `update()`, 없으면 `create()`
- **DSL-110** `delete()` — 동작: 행 또는 컬렉션의 모든 행 삭제
- **DSL-111** `delete(true)` — 동작: `deleteLock()` 관계를 제외하고 조회한 관계 행을 재귀 삭제

- **DSL-112** 쓰기가 성공하면 속성 변경 기록을 비운다.

- **DSL-113** `create()`와 `creates()`는 identity column 값을, `update()`와 `duplication` 모델의 변경은 primary key나 identity column 값을 statement 실행 전에 `IR_INVALID`로 거부한다. PostgreSQL identity는 명시한 key를 지나 나아가지 않아 다음 생성 key가 충돌하므로, identity key는 모두 database가 만든다. identity key를 쓰는 것은 적재뿐이다: `load`가 있는 `insert` 요청, 그다음 `restart_identity` 요청을 연결의 `execute`로 실행한다([protocol](protocol.ko.md#_1-6-load)).
- **DSL-114** `expectRevision(column, revision)`은 모델의 다음 `update()`나 `delete()`를 기대 revision을 가진 쓰기로 만든다. revision column은 dbspec setting이 아니라 chain이 이름한다: revision column은 chain이 이미 이름하는(`plus<Col>`처럼) 평범한 정수 column이고, 기대 revision은 chain만 나를 수 있는 한 쓰기의 값이며, setting은 그것을 선언하는 모든 document set의 manifest와 그래서 manifest hash를 바꾸기 때문이다. column은 entity의 `i16`, `i32`, `i64` column이며 primary key column이 아니다. 다른 column, 같은 쓰기에서 set한 그 column의 값, 기대와 함께 쓴 `update(true)`는 어떤 statement보다 먼저 `CONFIG`로 실패한다. 쓰기는 두 번째 장치 없이 모델이 이미 보내는 request 위에 만들어진다: `update()`와 `delete()`의 key 조건에 `column = revision`이 더해지고, `update()`는 바뀐 column과 함께, 다른 column이 바뀌지 않았을 때도, bind된 증가 `column = column + 1`(`plus<Col>(1)`처럼)을 할당한다. 하나의 조건부 statement가 연결의 트랜잭션이 열려 있으면 맞는 행을 그 트랜잭션에서 lock하고, 그 사이에 틈 없이 비교하고 쓴다. `FOR UPDATE`가 없는 SQLite는 statement 동안 write lock을 쥔다. 행이 다른 revision을 갖거나 더는 없어 어떤 행과도 맞지 않는 statement는 `REVISION_CHANGED`로 실패하고 아무것도 쓰지 않는다. `delete(true)`는 그 트랜잭션에서 실행되므로 root의 `REVISION_CHANGED`가 이미 지운 관련 행을 rollback한다. soft delete도 같은 방식으로 비교한다. 모델을 다시 읽지 않는다: `update()`가 성공한 뒤 행의 revision은 `revision + 1`이다. 기대는 `update()`가 성공한 뒤 다른 변경과 함께 지워지며 그 모델에만 적용되고 collection의 행에는 적용되지 않는다. `update(true)`의 `optimistic` request slot은 executor가 쓰는 `updated_ts`를 비교한다. revision은 form을 그릴 때의 revision처럼 호출자가 쥔 값이며 `delete()`도 지킨다.
- **DSL-115** `new<Name>`은 계산한 금액이나 화면용 표시 값처럼 행이 출력까지 전달하는 데이터를 추가한다. 이 값은 `INSERT`, `UPDATE`, `SELECT` 문장에 사용하지 않는다. 조회와 쓰기 뒤에도 `get<Name>()`, `toArray()`, JSON 출력에 포함되며 `create()`가 반환한 모델도 추가한 값을 유지한다.
- **DSL-116** `new<Name>`에 실제 컬럼 명칭을 사용하면 거부한다. 저장 컬럼 값은 `set<Col>`을 사용한다.
- **DSL-117** Go와 Rust는 읽은 소스가 호출하는 명칭의 `New<Name>`과 `Get<Name>`을 생성한다. 값 타입은 Go의 `any`, Rust의 공통 값 타입이다.

```php
$item = (new CartItem)->connect($master)
    ->setProductSeq(5)->setQuantity(2)
    ->newAmount(24000)          // not part of the INSERT statement
    ->create();
$item->getAmount();             // 24000
```

## 8. 트랜잭션

```php
$order = $master->transaction(function () use ($data) {
    $order = (new Order)->setServiceSeq($data['service_seq'])->create();
    (new OrderItem)->setOrderSeq($order->getSeq())->setAmount($data['amount'])->create();

    return $order;
});
```

```go
err := master.Transaction(func() error {
    order, err := model.Order().SetServiceSeq(serviceSeq).Create()
    if err != nil {
        return err
    }
    _, err = model.OrderItem().SetOrderSeq(order.GetSeq()).SetAmount(amount).Create()
    return err
})
```

```rust
master.transaction(async || {
    let order = Order::new().set_service_seq(service_seq).create().await?;
    OrderItem::new().set_order_seq(order.seq).set_amount(amount).create().await?;
    Ok(())
}).await?;
```

```ts
await master.transaction(async () => {
  const order = await new Order().setServiceSeq(serviceSeq).create()
  await new OrderItem().setOrderSeq(order.getSeq()).setAmount(amount).create()
})
```

- **DSL-118** 콜백 오류나 예외는 트랜잭션을 되돌린다. 교착 상태는 재시도한다.
- **DSL-119** 활성 트랜잭션 안에서 같은 연결의 트랜잭션을 호출하면 savepoint를 만든다.
- **DSL-121** 하나의 트랜잭션 연결을 동시에 사용하면 오류를 반환한다.
- **DSL-122** 실행 흐름은 Go에서 goroutine, PHP에서 요청, Rust에서 tokio task, TypeScript에서 `AsyncLocalStorage` 컨텍스트, Python에서 요청의 thread다. Python은 transaction이 그 transaction을 연 connection에 활성이고 모든 실행 흐름이 자기 connection을 가진다. 콜백 안에서 시작한 goroutine이나 새 Rust task에는 활성 트랜잭션이 없다. Go 하위 테스트도 이런 goroutine이므로, 그 안에서 연 트랜잭션은 바깥이 쥔 연결을 기다리는 별개 트랜잭션이 된다. TypeScript에서 콜백 안에서 시작한 비동기 작업은 콜백의 컨텍스트와 트랜잭션을 공유하며, 그 트랜잭션에서 다른 문장과 겹친 문장은 `CONFIG`를 반환한다.
- **DSL-123** `forUpdate()`, `forShare()`, `forUpdateNoWait()`, `forShareNoWait()`는 트랜잭션 안에서만 허용한다.
- **DSL-124** begin, commit, rollback은 공개하지 않는다.

- **DSL-125** 옵션은 `isolation`, `readOnly`, `timeoutMs`, `retry`(기본값 `3`, `0`이면 재시도하지 않음)다. 생략한 옵션은 기본값을 유지한다.

```php
$master->transaction(fn () => …, isolation: 'serializable', readOnly: true, timeoutMs: 500, retry: 0);
```

```go
err := master.Transaction(func() error { … },
    orm.Isolation(orm.Serializable), orm.ReadOnly(), orm.TimeoutMs(500), orm.Retry(0))
```

```rust
master.transaction(async || { … })
    .isolation(Isolation::Serializable).read_only().timeout_ms(500).retry(0).await?;
```

```ts
await master.transaction(async () => { … }, { isolation: 'serializable', readOnly: true, timeoutMs: 500, retry: 0 })
```

- **DSL-126** 활성 트랜잭션 안에서 같은 연결의 트랜잭션은 `retry`만 받으며 그 값은 사용하지 않는다. savepoint는 바깥 트랜잭션에 포함된다.

## 9. 예약 명칭

- **DSL-127** 생성기는 메서드 명칭이 예약 메서드(`and`, `or`, `get`, `gets`, `getsPage`, `getQuery`, `limit`, `alias`, `connect`, `create`, `creates`, `update`, `delete`, `restore`, `save`, `on`)와 같거나 예약 접두어(`and`, `or`, `get`, `set`, `new`, `plus`, `minus`, `orderBy`, `groupBy`, `tuple`, 연산자)로 시작하는 컬럼을 거부한다. `orderByRandom()`이 예약되어 있으므로 `random` 컬럼도 거부한다.

- **DSL-128** 행에 추가되는 명칭은 하나의 명칭 공간을 사용한다. 대상은 실제 컬럼, `addColumn<Name>(fn)`이나 `addColumn<Col>Alias<Name>(fn)`으로 추가한 컬럼, 관계 결과 명칭, `new<Name>` 명칭이다. 이 공간에서 명칭이 겹치면 거부한다. Go와 Rust는 생성 단계에서 거부하고 PHP와 TypeScript는 `CONFIG`를 반환한다. 따라서 같은 테이블에 대한 관계 두 개는 서로 다른 별칭이 필요하며, 서브쿼리 컬럼은 실제 컬럼이 아닌 명칭을 사용해야 한다.

- **DSL-129** 메서드 명칭이 모델의 다른 생성 메서드와 같은 컬럼도 거부한다. 예를 들어 `amount` 옆의 `sum_amount`는 `sumAmount()`와 겹친다.

- **DSL-130** 컬럼 명칭은 밑줄로 나눈 조각에 `and`, `or`, `with`, `gt`, `lt`, `ge`, `le`, `eq`, `ne`, `lk`, `lb`, `between`, `fulltext`, `tuple`을 포함할 수 없다. 예를 들어 `price_gt_limit`와 `with_tax`는 거부하고 `min_price`는 허용한다.

## 10. ORM 함수

- **DSL-131** ORM 함수 값은 함수 종류와 인자를 가진다. 함수 값을 받은 모델 메서드가 모델 별칭·컬럼·연산자를 기록하고, 클라이언트 플래너가 연결의 방언에 맞는 SQL을 출력한다.

- **DSL-132** 조건의 컬럼 함수 — 형태: `and<Op><Col>(Orm::year(), 2026)`
- **DSL-133** 조건의 값 함수 — 형태: `and<Op><Col>(Orm::daysAgo(7))`
- **DSL-134** 컬럼으로 쓰는 컬럼 함수 — 형태: `addColumn<Col>Alias<Name>(Orm::year())`
- **DSL-135** 정렬에 쓰는 컬럼 함수 — 형태: `orderBy<Col>Asc(Orm::year())`

- **DSL-136** Go는 `orm.Year()`, Rust는 `polyspec_orm::year()`, TypeScript는 `orm.year()`, Python은 `orm.year()`를 사용한다.

### 10.1 값 함수

- **DSL-137** `now()` — MySQL: `NOW(6)`; PostgreSQL: `now()`; SQLite: 클라이언트가 UTC로 계산해 바인드한 값
- **DSL-138** `today()` — MySQL: `CURDATE()`; PostgreSQL: `CURRENT_DATE`; SQLite: 클라이언트가 계산해 바인드한 값
- **DSL-139** `secondsAgo(n)`, `minutesAgo(n)`, `hoursAgo(n)`, `daysAgo(n)`, `monthsAgo(n)` — MySQL: `DATE_SUB(NOW(6), INTERVAL ? unit)`; PostgreSQL: `now() - make_interval(unit => ?)`; SQLite: bind한 클라이언트 clock에 `datetime(clock, '-n units')`를 적용하고 clock의 소수 여섯 자리를 붙인 값
- **DSL-140** `secondsLater(n)`, `minutesLater(n)`, `hoursLater(n)`, `daysLater(n)`, `monthsLater(n)` — MySQL: `DATE_ADD(NOW(6), INTERVAL ? unit)`; PostgreSQL: `now() + make_interval(unit => ?)`; SQLite: bind한 클라이언트 clock에 `datetime(clock, '+n units')`를 적용하고 clock의 소수 여섯 자리를 붙인 값

- **DSL-141** 모든 연결은 datetime 값을 UTC로 읽고 쓴다([config](config.ko.md)). MySQL과 PostgreSQL 연결은 세션 시간대를 UTC로 설정한다.
- **DSL-142** 월 계산은 MySQL, PostgreSQL과 같이 대상 월의 마지막 유효 일자를 유지한다.
- **DSL-143** 0001-01-01부터 9999-12-31 23:59:59.999999 밖이거나 그 폭을 넘는 interval의 상대 시간 함수는 NULL이며, 각 dialect가 위 형식에 그 guard를 붙인다([dialects](dialects.ko.md)).

### 10.2 컬럼 함수

- **DSL-144** `dayOfWeek()` (1 = 일요일 … 7) — 컬럼: 날짜·시각; MySQL: `DAYOFWEEK(c)`; PostgreSQL: `(EXTRACT(DOW FROM c)::int + 1)`; SQLite: `(CAST(strftime('%w', c) AS INTEGER) + 1)`
- **DSL-145** `year()` — 컬럼: 날짜·시각; MySQL: `YEAR(c)`; PostgreSQL: `EXTRACT(YEAR FROM c)::int`; SQLite: `CAST(strftime('%Y', c) AS INTEGER)`
- **DSL-146** `month()` — 컬럼: 날짜·시각; MySQL: `MONTH(c)`; PostgreSQL: `EXTRACT(MONTH FROM c)::int`; SQLite: `CAST(strftime('%m', c) AS INTEGER)`
- **DSL-147** `date()` — 컬럼: 날짜·시각; MySQL: `DATE(c)`; PostgreSQL: `CAST(c AS date)`; SQLite: `date(c)`

- **DSL-148** 목록에 없는 컬럼 타입에 컬럼 함수를 사용하면 `OPERATOR_NOT_ALLOWED`를 반환한다.
- **DSL-150** SQLite 최소 버전은 3.46이다. 클라이언트는 driver가 link한 SQLite library의 version을 읽고(Go `modernc.org/sqlite`의 `RegisterSQLiteVersion`, PHP `PDO::ATTR_SERVER_VERSION`, TypeScript `process.versions.sqlite`, Rust `libsqlite3_sys::SQLITE_VERSION`, Python `sqlite3.sqlite_version`), 그것을 묻거나 연결을 확인하는 statement 없이 연결한다.
