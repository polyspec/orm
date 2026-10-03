# 사용법

하나의 dbspec document set에서 Go·PHP·Rust·TypeScript 클라이언트를 생성하고, 각 클라이언트에서 같은 문장을 같은 SQL로 실행한다.
대상 DB는 MySQL 8(기본), PostgreSQL 12+, SQLite 3.46+.

쿼리는 생성된 모델에서 시작하고 `connect`로 열린 데이터베이스 연결을 받는다. 트랜잭션 콜백 안에서 `connect`를 호출하지 않은 모델은 활성 트랜잭션을 사용한다.

문법의 전체 목록은 [dsl.md](dsl.md), 스키마 언어는 [dbspec.md](dbspec.md), 스키마 도구는 [schema.md](schema.md), IR/Plan 명세는 [protocol.md](protocol.md),
방언 차이는 [dialects.md](dialects.md), 설정은 [config.md](config.md), 에러 코드는 [errors.yaml](errors.yaml)에 있다.

---

## 1. 준비

| 필요한 것 | 비고 |
|---|---|
| Go 1.27+ | 엔진·생성기·Go 클라이언트 |
| MySQL 8.0.2+ / MariaDB 10.2+ | 1차 대상. PostgreSQL 12+, SQLite 3.46+도 같은 플랜으로 동작 |
| PHP 8.4+ (`pdo_mysql`) | PHP 클라이언트를 쓸 때만. `pdo_pgsql`/`pdo_sqlite`는 해당 DB를 쓸 때 |
| Rust 1.98+ | Rust 클라이언트를 쓸 때만 |
| Node.js 22.16+ | TypeScript 클라이언트를 쓸 때만 |

```sh
git clone https://github.com/polyspec/orm && cd orm
go build ./...
```

---

## 2. 스키마

사람이 쓰는 정의는 dbspec document의 집합이다([dbspec.md](dbspec.md)). `schema/bench.dbs`가 예제다.

```text
dbspec 1 example

table users {
  id i64 identity
  name varchar(191)
  email bytes null
  key_version i32
  created_at datetime(6) default now
  updated_at datetime(6) default now
  primary key (id)
  settings {
    updated updated_at
    codec email aes
    aes_version key_version
  }
}

table authors {
  id i64 identity
  user_id i64
  closed bool default false
  primary key (id)
  index ix_authors_user (user_id, closed)
  foreign key fk_authors_user (user_id) references users (id) on delete restrict on update restrict
}
```

- column은 타입, `null`, `identity`, `default`를 적는다. key, index, foreign key, check는 테이블 안의 이름 있는 줄이다.
- setting이 ORM과 데이터베이스의 동작을 정한다: `updated`, `soft_delete`, `aes_version`, `blind_index`, `codec`, `select explicit`, `immutable`, `audit`([dbspec.md](dbspec.md#settings), [codec.md](codec.md)). column 이름은 동작을 정하지 않는다.
- foreign key는 이름을 가진다. 쿼리는 `match<L>With<R>`로 관계 키를 지정한다.

[mermaid.md](mermaid.md)는 document를 Mermaid `erDiagram`으로 내보내고, diagram을 document로 가져오며 diagram이 표현하지 못하는 내용의 목록을 돌려준다.

## 2.1 테이블 생성과 마이그레이션

각 클라이언트는 document set의 `CREATE` statement를 dialect 하나로 렌더링하고, 데이터베이스를 document로 introspect하며, migration plan chain을 lock, history, 검증, MySQL 복구와 함께 적용한다. 언어별 함수는 [schema.md](schema.md#_2-schema-operations), 렌더링하는 statement는 [dialects.md](dialects.md#rendered-statements), plan document와 diff와 적용은 [plans.md](plans.md)에 있다. rename과 삭제 허가는 plan에 선언하며 diff는 이를 추정하지 않는다.

## 3. 코드 생성

각 언어는 자기 빌드 도구로 모델을 생성한다. 생성기는 dbspec document set을 읽어 manifest text와 `manifestHash`를 담고, 엔티티마다 타입이 있는 컬럼 getter와 setter를 가진 모델 하나를 만든다.

```sh
go run github.com/polyspec/orm/cmd/orm-gen gen --document schema/example.dbs --lang go --out model --scan ./...
vendor/bin/orm-gen gen --out src/Model --namespace 'Example\Model' schema/example.dbs
npx orm-gen gen --schema schema/example.dbs --out src/models --scan src
```

```rust
// build.rs
fn main() {
    orm_build::Builder::new(["schema/example.dbs"]).scan("src").generate();
}
```

| 언어 | 도구 | 실행 시점 |
|---|---|---|
| Go | `//go:generate` 줄의 `orm-gen gen --lang go` | `go build` 전에 `go generate` |
| PHP | `vendor/bin/orm-gen gen` | 스키마 변경 후 Composer 스크립트 |
| TypeScript | `@polyspec/orm-typescript`의 `orm-gen gen` | `tsc` 전에 `build` 스크립트 |
| Rust | `orm-build` crate | `cargo build` 때마다 `build.rs`에서 실행. `orm::models!()`가 모델을 `model` 모듈로 포함한다 |

- Go, Rust, TypeScript 생성기는 `--scan`(Rust는 `scan`)으로 지정한 소스를 읽어 소스가 호출하는 체인 메서드를 생성한다. 그래서 잘못된 메서드 이름은 빌드를 멈춘다. PHP는 호출 시점에 체인 이름을 해석한다.
- TypeScript scan은 receiver가 생성 모델로 해석되는 호출에 대해서만 메서드를 선언하며, 그 모델에 선언한다. receiver는 다음 경우에 모델로 해석된다: 생성 class `C`의 `new C()`(import alias나 namespace import를 거친 경우 포함), 모델에 묶였거나 모델 class 타입을 가진 변수나 parameter, 선언된 반환 타입이 모델이거나, 반환 타입 없이 식 본문이나 유일한 `return` 문이 모델인 function이나 arrow function, 모델의 체인 메서드, 모델의 `and`, `or`, `on`, `fetchKey`, `fetchValue`, `addColumn…`에 넘긴 callback의 타입 없는 첫 parameter, `as C` 타입을 붙인 식, 모델의 행: `get`이나 `getBy…`를 await한 결과, 또는 모델 collection(`gets`나 `getsBy…`를 await한 결과, 그 `values()`나 `filter(…)`, spread 복사본, `Collection<C>`나 `C[]` 타입의 값)의 원소를 `for … of`, index, `first`, `get`, `at`, `find`, `map`, `forEach`, `filter`, `find`, `some`, `every`의 callback으로 얻은 것. model이 아닌 class의 `this.enabled()`처럼 그 밖의 receiver에 대한 호출은 메서드를 더하지 않는다. 그런 receiver의 호출에 타입이 필요하면 receiver에 모델 타입을 준다.
- `orm-gen gen --lang go`는 scan 회차마다 `--out` 옆의 임시 디렉터리에 파일을 쓰고, scan이 수렴한 뒤에만 `--out`의 생성 파일을 교체한다. 생성 헤더가 없는 파일은 그대로 유지한다. 생성이 실패하면 `--out`을 바꾸지 않으며 `orm-gen`은 상태 1로 종료한다. 이 실패에는 잘못된 체인 호출, 수렴하지 않는 scan, 로드할 수 없는 scan 대상 패키지, 컴파일되지 않는 생성 코드가 포함된다. scan이 수렴했지만 scan한 패키지가 다른 이유로 컴파일되지 않으면 `--out`은 완전한 모델을 담고 `orm-gen`은 상태 3으로 종료한다.
- `--check`는 출력을 쓰지 않고 기존 파일과 비교한다. 대상은 Go·PHP·TypeScript `orm-gen`의 `gen`이다. 명령은 내용이 다른 파일에 `differs: <path>`, 없는 파일에 `missing: <path>`, 출력 디렉터리에서 생성 코드 주석을 가지고 있지만 생성이 더 이상 쓰지 않는 파일에 `extra: <path>`를 경로 순서로 출력하고, 한 줄이라도 출력하면 상태 1로 종료한다. 파일이 최신이면 아무것도 출력하지 않고 상태 0으로 종료한다. Go `gen --check`는 `gen`과 같은 scan을 시스템 임시 디렉터리 아래의 디렉터리에서 실행하므로 모델 패키지는 `--out`의 이름과 import 경로를 유지한다. 생성 실패와 상태 3은 `gen`과 같다. Rust는 `build.rs`에서 모델을 생성하며 `gen` 명령이 없다.

```sh
go run github.com/polyspec/orm/cmd/orm-gen gen --document schema/example.dbs --lang go --out model --scan ./... --check
```
- 호출 인자의 타입이 확정되지 않아도 scan은 호출한 메서드를 생성한다. 예를 들어 다른 모델 패키지에 아직 없는 메서드로 계산한 값이 이런 인자다. join과 relation 인자는 생성하는 패키지의 모델로 확정되어야 한다. 따라서 여러 모델 패키지에 대한 `go generate` 한 번으로 각 패키지의 최종 모델을 쓴다. 다른 패키지의 메서드가 생기기 전에 실행한 생성은 그 패키지 호출 때문에 여전히 상태 3으로 종료한다.
- 스키마를 바꾸거나 새 체인 호출을 추가한 뒤에는 **모델을 다시 생성하고 스키마와 함께 배포**한다. 요청의 `manifest_hash`가 클라이언트가 읽은 모델과 다르면 `SCHEMA_HASH_MISMATCH`로 실패한다.

---

## 4. 연결

연결은 DSN URI 하나를 인자로 받으며, 클라이언트는 환경이나 비밀 저장소를 스스로 읽지 않는다. URI scheme이 데이터베이스를 선택하며 호출자는 별도 드라이버 값을 전달하지 않는다.

```text
mysql://user:password@host:3306/orm_example
postgres://user:password@host:5432/orm_example?sslmode=disable
sqlite:///var/lib/orm_example.sqlite
```

각 클라이언트는 DSN을 받아 해당 네이티브 드라이버와 풀을 만든다. 클라이언트는 읽어 들인 스키마로 호출한 프로세스 안에서 모든 문장을 계획한다. 그 옆에서 실행되는 서비스는 없다. `master`, `slave1`처럼 데이터베이스마다 연결을 하나씩 열고, `connect`가 각 모델에 선택한 연결을 준다.

### Go

```go
master, err := model.Connect(masterDSN, orm.Config{AESKey: aesKey})
```

`orm-gen gen --document <file.dbs>...`은 dbspec document set을 document마다 `--document` 하나로 읽고, 생성한 `orm.go`에 `ManifestText`, `ManifestHash`, schema 값 `Schema`를 쓴다. `model.Connect(dsn, config)`는 `orm.ConnectSchema(dsn, model.Schema, config)`를 호출한다. 연결을 열고 그 모델의 set을 연결에 등록하며, text의 hash가 `ManifestHash`와 다르면 `CONFIG`로 실패한다. 연결에 등록되지 않은 set의 요청은 `SCHEMA_HASH_MISMATCH`로 실패한다([protocol](protocol.md)). `orm.Connect(dsn, config)`는 set 없이 연결을 연다. `master.Utils().Schema().Install(model.Schema)`는 그 set을 연결에 등록하고 document set을 연결의 dialect로 render해 trigger를 포함한 문장을 적용한다. set의 테이블이 하나도 없으면 모두 만들고, 모두 있으면 아무것도 바꾸지 않으며, 일부만 있으면 `CONFIG`로 실패한다.

### PHP

```php
$master = \Polyspec\Orm\Tests\Model\connect($masterDsn, new Config(aesKey: $aesKey));
```

generated model의 `bootstrap.php`는 `MANIFEST_TEXT`, `MANIFEST_HASH`, schema 값 `schema()`, connect helper `connect()`를 정의한다. `connect()`는 `Orm::connectSchema`로 연결을 열고 그 모델의 set을 연결에 등록하며, 모든 요청은 `manifestHash`를 포함한다. `Orm::connect`는 set 없이 연결을 연다. `$db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema())`는 set을 설치하고 연결에 등록한다.

감사 대상 table(`audit` setting, [dbspec](dbspec.md#audit))은 operation id를 정한 transaction 안에서 쓴다. executor는 transaction이 insert하거나 update하는 모든 감사 대상 행의 operation column에 그 id를 쓰며, soft delete도 포함한다:

```php
$master->transaction(function (): void {
    (new Service)->setName('renamed')->create();
    (new Service)->getBySeq(42)->delete();
}, operation: $operationId);
```

id는 `i64` operation column이면 `int`, `uuid` column이면 소문자 canonical UUID `string`이다. 그런 transaction 밖에서, 또는 다른 type의 id로 감사 대상 table을 insert하거나 update하면 `CONFIG`로 실패하고, operation column을 setter로 지정하면 `IR_INVALID`로 실패한다. 중첩 transaction은 바깥 transaction의 id를 쓰며 `operation`을 받지 않는다.

### Rust

```rust
let master = model::connect(&master_dsn, pool_size, orm::Config { aes_key, ..Default::default() }).await?;
master.utils().schema().install(&model::SCHEMA).await?;
```

`orm_build::Builder::new(documents)`는 dbspec document set을 읽고 모델과 manifest text를 `OUT_DIR`에 쓴다. 생성된 모듈은 manifest text를 `include_str!`로 `model::SCHEMA`에, `manifestHash`를 `model::MANIFEST_HASH`에 담는다. 그 `model::connect`는 `orm::Db::connect_schema(dsn, &model::SCHEMA, pool_size, config)`를 호출해 연결을 열고 set을 등록한다. `orm::Db::connect`는 set 없이 연결을 연다. runtime model은 처음 쓸 때 포함된 text로 만들고, 모든 요청은 `manifestHash`를 담는다. `utils().schema().install(&model::SCHEMA)`는 set을 연결에 등록하고 document set을 연결의 데이터베이스에 맞게 render하고 statement를 적용한다. set의 table이 모두 있으면 아무것도 하지 않고, 일부만 있으면 `CONFIG`를 반환한다. MySQL은 statement를 transaction 밖에서 적용하며 transaction 안에서는 `CONFIG`를 반환한다.

감사 대상 table(`audit` setting)은 unit of work의 operation id를 transaction에서 받는다. 가장 바깥 transaction에 `operation(id)`로 정하면, executor가 그 transaction이 insert하거나 update하는 모든 감사 대상 row의 operation column에 그 값을 쓴다. soft delete의 update도 같다:

```rust
db.transaction(async || {
    service.set_name("renamed").update(false).await
})
.operation(operation_id) // i64 operation column에는 i64, uuid column에는 &str 또는 String
.await?;
```

operation id 없이, transaction 밖에서, 또는 operation column type에 맞지 않는 id로 감사 대상 table을 insert하거나 update하면 `CONFIG`로 실패한다. 중첩 transaction은 `operation`을 받지 않고, operation column을 직접 쓰는 요청은 `IR_INVALID`로 실패한다.

### TypeScript

```typescript
import { Item, SCHEMA, connect } from './models/models.js';

const master = await connect(masterDsn, { aesKey });
await master.utils().schema().install(SCHEMA);
await master.transaction(async () => {
  await new Item().setTitle('first').create();
}, { operation: 42 });
```

`orm-gen gen`은 document set의 dbspec 문서를 하나씩 반복한 `--schema`로 받고, 생성된 `models.ts`는 manifest text를 `MANIFEST_TEXT`로, 그 hash를 `MANIFEST_HASH`로, schema 값을 `SCHEMA`로, connect helper를 `connect(dsn, options)`로 export한다. `connect`는 `Db.connectSchema`로 연결을 열고 그 모델의 set을 연결에 등록한다. `Db.connect(dsn, options)`는 set 없이 연결을 열고, 연결에 등록되지 않은 set의 요청은 `SCHEMA_HASH_MISMATCH`로 실패한다. `utils().schema().install(SCHEMA)`는 한 document set의 schema 값을 받아 연결에 등록하고, 그 테이블이 하나도 없을 때 rendered statement를 적용한다. 모든 테이블이 있으면 아무것도 바꾸지 않고, 일부만 있으면 `CONFIG`로 실패한다. `transaction`의 `operation` 옵션은 작업 단위의 operation id다. 트랜잭션 안에서 `audit` setting이 있는 테이블의 모든 insert와 update는 soft delete를 포함해 이 값을 operation column에 쓴다. `i64` operation column에는 safe integer, `uuid` operation column에는 문자열을 쓴다. 이 값이 없거나 다른 타입이면 audit 테이블의 insert와 update는 `CONFIG`로 실패하고, operation column을 직접 지정하면 `IR_INVALID`로 실패한다. 중첩 트랜잭션은 바깥 트랜잭션의 operation을 그대로 쓴다.

각 클라이언트는 요청 형태별로 Plan을 캐시한다. `connection.utils().schema().install(schema)`는 document set을 설치하고([schema.md](schema.md#_4-schema-installation)), `connection.utils().schema().addTablesAndColumns(schema)`는 설치한 set을 더하기만 하는 version으로 올린다: 데이터베이스에 없는 테이블을 만들고, 기존 테이블에 빠진 컬럼 가운데 null이거나 default가 있는 컬럼을 추가하며, 다른 모든 차이에는 변경 전에 `SCHEMA_DIFFERS`를 반환한다([schema.md](schema.md#_5-adding-tables-and-columns)).

---

## 5. 읽기

메서드 명칭은 공통이며 표기만 다르다(PHP·TypeScript `camelCase` / Go `PascalCase` / Rust `snake_case`).

```php
$rows = (new Author)->connect($slave1)
    ->serviceSeq(7)->andIsClose(false)
    ->and(fn (Author $q) => $q->isDisplay(true)->or()->isAllday(true))
    ->andSeq([6, 106, 206])
    ->orderBySeqDesc()->limit(0, 20)
    ->gets();
```
```go
rows, err := model.Author().Connect(slave1).
    ServiceSeq(7).AndIsClose(false).
    And(func(q *model.AuthorModel) { q.IsDisplay(true).Or().IsAllday(true) }).
    AndSeq([]int{6, 106, 206}).
    OrderBySeqDesc().Limit(0, 20).
    Gets()
```
```rust
let rows = Author::new().connect(&slave1)
    .service_seq(7).and_is_close(false)
    .and(|q| q.is_display(true).or().is_allday(true))
    .and_seq(vec![6, 106, 206])
    .order_by_seq_desc().limit(0, 20)
    .gets().await?;
```
```typescript
const rows = await new Author().connect(slave1)
    .serviceSeq(7).andIsClose(false)
    .and(q => q.isDisplay(true).or().isAllday(true))
    .andSeq([6, 106, 206])
    .orderBySeqDesc().limit(0, 20)
    .gets();
```

- 조건: 첫 조건에는 접두어가 없고, 이후 조건은 `and<Chain>`, `or<Chain>` 또는 `and()`·`or()`를 사용하며, 묶음은 `and(fn)`·`or(fn)`을 사용한다. 연산자 접두어·값 형태·체인 규칙은 [dsl.md](dsl.md)에 있다.
- 조회 메서드: `getBy<Chain>`, `getsBy<Chain>`, `getCountBy<Chain>`은 `getsByServiceSeqAndIsClose(7, false)`처럼 모든 컬럼 체인을 받는다.
- 컬럼: `addColumn<Col>()`, `removeColumn<Col>()`, `removeAllColumns()`, `addAllColumns()`. `text`·`blob`·스타일 컬럼은 기본 SELECT에서 빠지며 `addColumn<Col>()`로 추가한다.
- Rust 생성 모델 필드는 비공개다. 조회하거나 대입하지 않은 컬럼을 읽으면 `COLUMN_UNSELECTED`를 반환하며, 빠진 값을 SQL NULL이나 기본값으로 보여주지 않는다.
- PHP 생성 모델 getter도 스타일이 없는 컬럼을 조회하거나 대입하지 않고 읽으면 `COLUMN_UNSELECTED`를 반환하며, 선택한 SQL NULL과 명시적으로 대입한 값은 계속 읽을 수 있다.
- 종단 작업: `get`은 행 하나를 반환하며 일치하는 행이 없으면 `NO_ROWS`를 반환한다. `gets`는 컬렉션을 반환하며 일치하는 행이 없으면 빈 컬렉션이다. `getCount`는 개수를 반환한다.
- 컬렉션은 PK 또는 `keyName<Col>()`을 키로 하는 순서 있는 맵이다. `first()`, `count()`, `toArray()`를 제공하며 순회하면 `key => row`가 나온다.
- `toArray()`는 컬렉션 순서대로 행을 맵 목록으로 반환한다. Go는 `rows.ToArray()`, Rust는 `rows.to_array()`, PHP는 `$rows->toArray()`, TypeScript는 `rows.toArray()`를 사용한다. 순회는 키와 키 타입을 유지한다.

### 집계와 그룹

```php
(new Author)->connect($slave1)->serviceSeq(7)->groupByUserSeq()->getsCount();   // 사용자별 row_count 행
(new Author)->connect($slave1)->serviceSeq(7)->sumLikeCount()->getSum();       // like_count 합계
(new Author)->connect($slave1)->serviceSeq(7)->avgPrice()->getAvg();           // price 평균
```
원시 조건·정렬·그룹·컬럼 형태, 서브쿼리 컬럼, ORM 함수 값은 [dsl.md](dsl.md)에서 정의한다.
Rust `gets_count()`는 일부 필드만 채운 모델 대신 선택한 그룹 값과 검증한 `row_count`만 담은 `GroupRows`를 반환한다.
Rust `GroupRow::value(name)`은 `Result<&Val>`을 반환한다. 선택하지 않은 이름은 `COLUMN_UNSELECTED`이고 선택한 SQL NULL은 `Val::Null`로 유지한다.
Go `GetsCount()`는 `*orm.GroupRows`를 반환한다. 각 `GroupRow`는 `Value(name)`으로 선택한 값, `Count()`로 검증한 개수를 제공한다. `Value(name)`은 선택하지 않은 이름에 `COLUMN_UNSELECTED`를 반환하고 선택된 SQL NULL에는 오류 없이 nil을 반환한다.
PHP와 TypeScript의 `getsCount()`도 `GroupRow` 항목이 담긴 `GroupRows`를 반환한다. 선택한 그룹 값은 `value(name)`으로 읽고 검증한 행 개수는 PHP에서 `count()`, TypeScript에서 `count`로 읽는다. 선택하지 않은 이름은 `COLUMN_UNSELECTED`로 실패하며 SQL NULL은 null로 유지된다.

---

## 6. 관계와 조인

**관계**는 별도 SQL 문장을 사용한다. 부모 값을 `IN`으로 모아 조회하고 자식 행을 연결한다.
**조인**은 같은 SQL 문장의 일부다.

```php
$rows = (new Author)->connect($slave1)->serviceSeq(7)->limit(0, 20)
    ->relation((new User)->matchUserSeqWithSeq())                          // $b->getUser()
    ->relation((new Service)->matchServiceSeqWithSeq()
        ->relations((new ServiceMember)->matchSeqWithServiceSeq()          // ->getServiceMembers()
            ->orderBySeqDesc()->groupLimit(3)
            ->keyNameUserSeq()))
    ->relation((new User)->connect($userReplica)->matchUserSeqWithSeq()->aliasWriter())
    ->joinServiceSeqWithSeq((new Service)->on(fn (Service $s) => $s->name('service-7')))
    ->gets();
```

| 자식 옵션 | 의미 |
|---|---|
| `match<L>With<R>()` | 부모 컬럼 `L`과 자식 컬럼 `R`이 같음 |
| `alias<Name>()` | 관계 결과 명칭 |
| `keyName<Col>()` | many 컬렉션의 키 컬럼. 중복이면 마지막 행 사용 |
| `parentNode()` | one 관계 컬럼을 부모 행에 병합. 부모 값 우선 |
| `groupLimit(n)` | `ROW_NUMBER() OVER (PARTITION BY …)`로 부모당 n행 |
| `possible<Col>(v)` | 부모 행이 일치할 때만 조회 |
| `deleteLock()` | `delete(true)`의 중단 지점 |

`connect`를 호출한 관계 자식은 그 연결에서 SQL 문장을 실행한다. 조인 자식은 `on(fn)`으로 `ON` 조건을 정하고 `WHERE` 조건을 직접 설정하며, `and(child)` 또는 `or(child)`가 자식 조건을 묶음으로 넣는다. 조인 자식의 `connect`는 `CONFIG`를 반환한다.
조인한 모델과의 컬럼 비교는 `priceGtMinPrice($brand)` 같은 `<ColA><Op><ColB>(model)`를 사용한다.

---

## 7. 쓰기

```php
$row = (new Author)->connect($master)->setName('x')->setUserSeq(1)->…->create();   // 생성 키를 포함한 행 반환
$row->setName('y')->update();                                                     // 바뀐 컬럼만 UPDATE
$row->setName('z')->update(true);                                                 // updated_ts 불일치 → OPTIMISTIC_LOCK
$row->delete();
$row->delete(true);                                                               // deleteLock()을 제외한 조회 관계부터 삭제

$replicaRow->connect($master)->plusReadCount(1)->update();                        // 복제본에서 읽고 기본 연결로 쓰기

(new Author)->connect($master)->setUuid($u)->setName('x')->…
    ->duplication((new Author)->setName('x')->plusReadCount(1))->create();        // UPSERT
$row->newIsMember(true);                                                          // SQL에 포함하지 않는 추가 값
```

- `update`는 방언 간 값을 맞추기 위해 `updated_ts`를 항상 명시적으로 기록한다.
- `minus<Col>`은 음수를 저장하지 않는다. `setRaw<Col>`은 스키마 검사를 거친 SQL 식을 기록한다.
- `save()`는 기본 키가 있으면 갱신하고 없으면 행을 생성한다.
- 트랜잭션은 `connection.transaction(fn)`을 사용한다. 콜백 오류나 예외는 트랜잭션을 되돌리고 교착 상태는 재시도한다.
- 활성 트랜잭션 안에서 같은 연결의 `transaction`을 호출하면 savepoint를 만든다. 바깥 콜백이 안쪽 실패를 반환하지 않으면 안쪽 작업만 되돌린다.
- 트랜잭션 옵션은 `isolation`, `readOnly`, `timeoutMs`를 선택한다. 지원하는 격리 수준은 `default`, `read_uncommitted`, `read_committed`, `repeatable_read`, `serializable`이다. PostgreSQL은 `BEGIN` 후에, MySQL은 유지한 연결에서 `START TRANSACTION` 전에 설정을 적용한다. SQLite는 `PRAGMA query_only`로 `readOnly`를 적용하고 공통 격리 수준을 트랜잭션 연결에 대응시키며, ORM은 commit이나 rollback 전에 연결 상태를 복원한다. 양수 `timeoutMs`는 PostgreSQL `statement_timeout`을 적용하고 MySQL·SQLite는 `CAPABILITY_UNSUPPORTED`를 반환한다.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, `forShareNoWait()`는 트랜잭션 안에서만 허용한다. MySQL과 PostgreSQL은 선택한 행 잠금을 실행하며 `NoWait`는 행을 사용할 수 없으면 즉시 실패한다. SQLite는 잠금 접미사를 만들지 않고 네 모드 모두 ORM 트랜잭션 범위의 데이터베이스 잠금 행을 사용한다. SQLite 쓰기 트랜잭션은 시작할 때 데이터베이스 쓰기 잠금을 얻으므로 그 안의 잠금 요청은 기다리지 않고 성공하며, 잠금 대기는 트랜잭션 시작에서 일어난다([런타임 연결](config.md)).
- 공통 실행 중 취소 메서드는 없다. `timeoutMs`가 PostgreSQL 문장 실행 시간을 제한한다.
- test는 자기 클라이언트의 test fault로 모든 데이터베이스에서 트랜잭션의 rollback을 실패시킨다. production build는 이 fault를 포함하거나 load하지 않는다([protocol §3.1](protocol.md#_3-1-test-faults)). Go는 `-tags ormtest`와 `orm.FailNextRollback(db)`, Rust는 feature `test-faults`와 `orm::testing::fail_next_rollback(&db)`, TypeScript는 `node --conditions=orm-test`에서 `@polyspec/orm-typescript/testing`의 `failNextRollback(db)`, PHP는 `require 'vendor/orm/php-client/testing/Faults.php'` 뒤의 `Orm\Testing\Faults::failNextRollback($db)`를 사용한다. callback이 실패한 다음 트랜잭션은 rollback되고 callback 오류와 `FAULT` 오류를 가진 `ROLLBACK`을 반환한다.

```go
err := master.Transaction(func() error {
    row, err := model.Author().SetName("x").….Create()
    if err != nil {
        return err
    }
    _, err = model.AuthorLog().SetAuthorSeq(row.GetSeq()).Create()
    return err
})
```
```php
$row = $master->transaction(fn () => (new Author)->setName('x')->…->create());
```
```rust
let row = master.transaction(async || Author::new().set_name("x")./*…*/.create().await).await?;
```

### Go operation id

`audit` setting([audit](dbspec.ko.md#audit))이 있는 테이블은 `orm.Operation(id)`로 unit of work를 정한 트랜잭션 안에서만 쓴다. 그 트랜잭션에서 audit 테이블의 모든 insert, update, soft delete, duplicate update는 `id`를 테이블의 operation 컬럼에 쓰고, 데이터베이스 trigger가 각 버전을 history 테이블에 복사한다. `id`는 `i64` operation 컬럼이면 `int64`, `uuid` operation 컬럼이면 소문자 UUID string이다. 중첩 트랜잭션은 바깥 트랜잭션의 id를 쓰며 `orm.Retry`만 받는다.

```go
err := master.Transaction(func() error {
    _, err := model.Item().SetTitle("draft").Create()
    return err
}, orm.Operation(int64(42)))
```

그런 트랜잭션 밖에서 audit 테이블을 쓰거나 operation 컬럼에 맞지 않는 id로 쓰면 데이터베이스에 닿기 전에 `CONFIG`로 실패한다. `int64`나 `string`이 아닌 값을 준 `orm.Operation`은 트랜잭션을 시작하기 전에 `CONFIG`로 실패한다. operation 컬럼을 직접 할당하는 요청은 `IR_INVALID`로 실패한다.

---

## 8. 스타일 컬럼

`gz_*`, `json_*`, `jsons_*`, `base64_*`, `serialize_*`는 클라이언트 출력에서 저장 바이트가 아니라 **디코딩한 값**을 사용한다
(Go `any`, Rust `serde_json::Value`, PHP `mixed`). MySQL은 `aes_hex_*`와 `ip`를 SQL 함수로 처리하고,
PostgreSQL·SQLite 실행기는 같은 바이트를 만든다([codec.md](codec.md)).

```php
$b->setJsonSetting(['a' => 1])->connect($master)->update();
$b = (new Author)->connect($slave1)->addColumnJsonSetting()->getBySeq(42);   // 기본 SELECT에서 제외된 컬럼
$b->getJsonSetting()['a'];
```

---

## 9. 여러 데이터베이스

같은 문장은 세 데이터베이스에서 같은 결과를 만들며 SQL 문장 텍스트만 방언별로 다르다. 규칙과 예외는 [dialects.md](dialects.md)에 있다.

`connection.utils().schema().install(...)`은 연결의 dialect로 document set을 렌더링한다([schema.md](schema.md#_4-schema-installation)).

- Go: `model.Connect(url, config)`. DSN scheme이 드라이버를 선택한다.
- PHP: `\Polyspec\Orm\Tests\Model\connect(url, config)`. DSN scheme이 PDO 드라이버를 선택한다.
- Rust: `model::connect(url, pool_size, config).await?`. DSN scheme이 sqlx 드라이버를 선택한다.
- TypeScript: generated module의 `connect(url, options)`. DSN scheme이 드라이버 패키지를 선택한다.
- 여러 연결을 함께 열 수 있으며, `connect`가 모델마다 하나를 선택한다. 예를 들어 읽기는 `slave1`, 쓰기는 `master`를 사용한다.
- SQLite는 `Lb`와 전문 검색 연산자를 거부한다(`OPERATOR_NOT_ALLOWED`).

---

## 10. 운영

| 하는 일 | 명령 |
|---|---|
| 스키마가 라이브 DB와 같은지 | 데이터베이스를 introspect하고 schema text를 document set과 비교한다([schema.md](schema.md#_2-schema-operations)) |
| 생성물이 최신인지 | 언어별 생성기 실행 후 `git diff --exit-code` |
| 문장 로그 | `Config.OnQuery` / `onQuery` / `Config { on_query }` → `(sql, binds, 시간, plan_id, err)`, 비밀은 `$SECRET`로 마스킹 |
| 실행 없이 SQL 보기 | 연결한 모델의 `getQuery()` ([dsl.md](dsl.md)) |
| 에러 코드 상수 | `orm-gen errors --lang go\|php\|rust --out …` ([errors.yaml](errors.yaml)) |
| 스키마 설치 | `connection.utils().schema().install(...)` ([schema.md](schema.md#_4-schema-installation)) |
| 설치한 set에 빠진 테이블과 컬럼 추가 | `connection.utils().schema().addTablesAndColumns(...)` ([schema.md](schema.md#_5-adding-tables-and-columns)) |

---

## 11. 자주 나는 에러

| 코드 | 원인과 조치 |
|---|---|
| `SCHEMA_HASH_MISMATCH` | 생성된 모델의 `manifestHash`가 클라이언트가 읽은 모델과 다르다. 다시 생성하고 함께 배포한다 |
| `OPERATOR_NOT_ALLOWED` | 스타일 컬럼이나 SQLite 전문 검색처럼 그 타입·스타일에서 허용하지 않는 연산자 |
| `COLUMN_UNKNOWN` / `RELATION_UNKNOWN` | 스키마에 없는 명칭. document를 고치고 다시 생성한다 |
| `EMPTY_IN` | 조건이 빈 목록을 받았다. 호출 전에 확인한다 |
| `CONFIG` | 트랜잭션 밖의 `connect` 누락, 연결자 누락·위치 오류, 조인 자식의 `connect`, 설정·경로·드라이버 불일치 |
| `LIMIT_IN_RELATION` | 관계 자식이 `limit`를 사용했다. `groupLimit(n)`을 사용한다 |
| `OPTIMISTIC_LOCK` | `update(true)`가 더 새로운 `updated_ts`를 발견했다. 다시 읽고 재시도한다 |
| `LOCK_NOT_AVAILABLE` | `*_nowait` 행 잠금이 즉시 잠금을 얻지 못했다. transaction conflict로 재시도하지 않는다 |
| `DUPLICATE_KEY` / `DEADLOCK` | 원문을 유지한 드라이버 오류. 교착 오류는 트랜잭션 재시도 뒤에 반환된다 |
| `CANCELED` | 문이 끝나기 전에 중단되었다. 취소, 시간 제한, 또는 SQLite `busy_timeout`이 끝날 때까지 다른 연결이 잠금을 놓지 않은 경우이며 재시도하지 않는다 |
| `READ_ONLY` | 쓰기가 읽기 전용 서버나 연결에 도달했다. replica, 읽기 전용 트랜잭션, 읽기 전용으로 열린 SQLite 데이터베이스가 해당한다. 쓰기는 primary 연결에서 실행한다 |
| `CONSTRAINT` | CHECK 제약이 행을 거부했다. 오류는 드라이버 메시지와 드라이버 오류를 유지한다 |
| `DRIVER` | `audit`이나 `immutable` trigger가 거부한 쓰기 같은 그 밖의 드라이버 오류. 오류는 드라이버 메시지와 원인인 드라이버 오류를 유지한다 |
| `ROLLBACK` | 서버가 session을 종료한 경우처럼 트랜잭션이나 savepoint의 callback이 실패하고 rollback도 실패했다. 오류는 두 오류를 유지하며 재시도하지 않는다 |
| `FAULT` | 클라이언트의 test entry point로 설정한 test fault가 rollback을 실행한 뒤 트랜잭션의 rollback을 실패로 보고했다. `ROLLBACK` 오류의 rollback 오류다([protocol §3.1](protocol.md#_3-1-test-faults)) |
| `CODEC_DECODE` | 저장 바이트가 선언된 컬럼 스타일과 다르다 |

---

## 12. 확인

```sh
make test-servers                                        # MySQL, PostgreSQL, 각 replica, ProxySQL, PgBouncer, 시드한 벤치 데이터베이스
. .runtime/servers/env                                   # 테스트의 DSN 변수
go test ./...                                            # 엔진, 생성기, Go 클라이언트
npm run typescript:test                                  # TypeScript 클라이언트
(cd clients/rust && cargo test --workspace)              # Rust 클라이언트
go run ./tests/conformance/check run -dsn "$BENCH_MYSQL_DSN"   # 네 클라이언트의 같은 결과 (MySQL)
go run ./tests/conformance/check run -driver postgres -dsn "$BENCH_POSTGRES_DSN"
```

예제: [`examples/thin-slice`](../examples/thin-slice)(Go·PHP·Rust, 같은 JSON), [`examples/complex`](../examples/complex)(조인·그룹·2단 관계·집계).

Rust 소스 분석은 실패 가능한 모델 setter의 결과와 모델을 구분한다. 오류 변환과 검사 후 추출은 모델을 유지하고 성공 값 변환은 다른 형식을 반환할 수 있다. Result 연산은 컬럼 메서드를 만들지 않으며 알려진 모델의 알 수 없는 호출은 계속 생성에 실패한다.
