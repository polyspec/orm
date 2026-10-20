<!-- doc-id: usage -->
<!-- source-sha256: 319c159ef42e3ac02b70b29221420742e80b2e2eac1f5f4ef187e9e3c2580458 -->
# 사용법

하나의 dbspec document set에서 Go·PHP·Rust·TypeScript·Python 클라이언트를 생성하고, 각 클라이언트에서 같은 문장을 같은 SQL로 실행한다.
대상 DB는 MySQL 8(기본), PostgreSQL 12+, SQLite 3.46+.

쿼리는 생성된 모델에서 시작하고 `connect`로 열린 데이터베이스 연결을 받는다. 트랜잭션 콜백 안에서 `connect`를 호출하지 않은 모델은 활성 트랜잭션을 사용한다.

문법의 전체 목록은 [dsl.md](../spec/dsl.md), 스키마 언어는 [dbspec.md](../spec/dbspec.md), 스키마 도구는 [schema.md](../spec/schema.md), IR/Plan 명세는 [protocol.md](../spec/protocol.md),
방언 차이는 [dialects.md](../spec/dialects.md), 설정은 [config.md](../spec/config.md), 에러 코드는 [errors.yaml](../spec/errors.yaml)에 있다.

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
go build ./packages/go/... ./tests/... ./examples/...
```

---

## 2. 스키마

사람이 쓰는 정의는 dbspec document의 집합이다([dbspec.md](../spec/dbspec.md)). `contracts/fixtures/bench/bench.dbs`가 예제다.

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
- setting이 ORM과 데이터베이스의 동작을 정한다: `updated`, `soft_delete`, `aes_version`, `blind_index`, `codec`, `select explicit`, `immutable`, `audit`([dbspec.md](../spec/dbspec.md#settings), [codec.md](../spec/codec.md)). column 이름은 동작을 정하지 않는다.
- foreign key는 이름을 가진다. 쿼리는 `match<L>With<R>`로 관계 키를 지정한다.

[mermaid.md](../spec/mermaid.md)는 document를 Mermaid `erDiagram`으로 내보내고, diagram을 document로 가져오며 diagram이 표현하지 못하는 내용의 목록을 돌려준다.

## 2.1 테이블 생성과 마이그레이션

각 클라이언트는 document set의 `CREATE` statement를 dialect 하나로 렌더링하고, 데이터베이스를 document로 introspect하며, migration plan chain을 lock, history, 검증, MySQL 복구와 함께 적용한다. 언어별 함수는 [schema.md](../spec/schema.md#_2-schema-operations), 렌더링하는 statement는 [dialects.md](../spec/dialects.md#rendered-statements), plan document와 diff와 적용은 [plans.md](../spec/plans.md)에 있다. rename과 삭제 허가는 plan에 선언하며 diff는 이를 추정하지 않는다.

## 3. 코드 생성

각 언어는 자기 빌드 도구로 모델을 생성한다. 생성기는 dbspec document set을 읽어 manifest text와 `manifestHash`를 담고, 엔티티마다 타입이 있는 컬럼 getter와 setter를 가진 모델 하나를 만든다.

모든 생성기는 document set을 [set 파일](../spec/dbspec.ko.md#document-sets)로만 받는다. 여기서는 나열하는 문서 옆의 `contracts/fixtures/bench/dbspec-set.json`이다:

```json
{"schema": 1, "documents": ["example.dbs"]}
```

```sh
go run github.com/polyspec/orm/packages/go/cmd/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --lang go --out model --scan ./...
vendor/bin/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out src/Model --namespace 'Example\Model' --scan src
npx orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out src/models --scan src
orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --out model --scan src
```

```rust
// build.rs
fn main() {
    polyspec_orm_build::Builder::set("contracts/fixtures/bench/dbspec-set.json").scan("src").generate();
}
```

| 언어 | 도구 | 실행 시점 |
|---|---|---|
| Go | `//go:generate` 줄의 `orm-gen gen --lang go` | `go build` 전에 `go generate` |
| PHP | `vendor/bin/orm-gen gen` | 스키마 변경 후 Composer 스크립트 |
| TypeScript | `@polyspec/orm`의 `orm-gen gen` | `tsc` 전에 `build` 스크립트 |
| Python | `orm-gen gen`(Python package) | 스키마나 scan한 소스가 바뀐 뒤 |
| Rust | `polyspec-orm-build` crate | `cargo build` 때마다 `build.rs`에서 실행. `polyspec_orm::models!()`가 모델을 `model` 모듈로 포함한다 |

- 모든 생성기는 model의 모든 key(primary key, unique key, index)의 모든 prefix마다 유형 있는 메서드를 schema에서 선언한다. 소스가 `--scan`으로 지정되었는지, 그 소스가 호출하는지와 상관없다. 한 column은 그 column 메서드이고(예: `audit_seq` index의 `auditSeq`), 여러 column은 tuple 메서드이다(예: `tupleAccountSeqWithProjectSeq`). Go, Rust, TypeScript, PHP, Python은 이 메서드를 생성된 model에 선언한다. Python과 PHP는 모든 column의 조건 메서드와 column 메서드도 model을 반환하는 유형으로 선언하고, 그 밖의 체인 이름은 실행 시점에 해석한다. scan은 소스가 호출하는 체인 메서드를 더하며, 체인 문법이 받지 않는 이름은 빌드를 멈춘다. PHP는 schema가 열거하는 메서드를 생성된 model마다 선언해 PHPStan 같은 정적 분석기가 그것을 찾게 한다: 모든 column의 조건 메서드, 두 column 이상인 모든 key prefix의 tuple 메서드, 모든 column의 `addColumn<Col>`, `removeColumn<Col>`, `groupBy<Col>`, `keyName<Col>`, `orderBy<Col>Asc`, `orderBy<Col>Desc`, 모든 숫자 column의 `plus<Col>`, `minus<Col>`, `sum<Col>`, `avg<Col>`, 모든 index의 `forceIndex<Index>`. 각 메서드는 그 이름의 체인을 실행하므로 체인이 만드는 쿼리를 만든다. `--scan`을 주면 PHP는 소스가 호출하는 체인 메서드도 `@method` 태그로 선언하고 체인 문법이 받지 않는 이름은 빌드를 멈춘다([dsl.md](../spec/dsl.ko.md)). `--scan`이 없으면 그 밖의 체인 이름은 schema가 열거하지 않으므로 PHP가 호출 시점에 `__call`로 해석한다: `lbName`이나 `gtSeq` 같은 연산자 체인, `seqAndName` 같은 여러 column의 체인, `and`나 `or`로 이은 조건, finder `getBy<Chain>`, `getsBy<Chain>`, `getCountBy<Chain>`, 여러 column의 정렬, `join<Pair>`, `leftJoin<Pair>`, `match<Pair>`, `alias<Name>`, `new<Name>`, `possible<Col>`, 더한 column의 `addColumn<Name>`, 더한 값이나 relation의 `get<Name>`.
- 생성 모델은 document와 scan한 소스에만 의존하고 path를 쓴 방식에는 의존하지 않는다: scan과 output path를 상대 path나 절대 path로, `./`를 넣어, 또는 끝에 `/`를 붙여 써도, PHP set 파일 path를 상대 path, 절대 path, `./`를 넣은 path로 써도 같은 파일이 나온다. Rust `include_str!`은 manifest file의 path를 output directory의 canonical path로 쓴다.
- TypeScript scan은 receiver가 생성 모델로 해석되는 호출에 대해서만 메서드를 선언하며, 그 모델에 선언한다. receiver는 다음 경우에 모델로 해석된다: 생성 class `C`의 `new C()`(import alias나 namespace import를 거친 경우 포함), 모델에 묶였거나 모델 class 타입을 가진 변수나 parameter, 선언된 반환 타입이 모델이거나, 반환 타입 없이 식 본문이나 유일한 `return` 문이 모델인 function이나 arrow function, 모델의 체인 메서드, 모델의 `and`, `or`, `on`, `fetchKey`, `fetchValue`, `addColumn…`에 넘긴 callback의 타입 없는 첫 parameter, `as C` 타입을 붙인 식, 모델의 행: `get`이나 `getBy…`를 await한 결과, 또는 모델 collection(`gets`나 `getsBy…`를 await한 결과, 그 `values()`나 `filter(…)`, spread 복사본, `Collection<C>`나 `C[]` 타입의 값)의 원소를 `for … of`, index, `first`, `get`, `at`, `find`, `map`, `forEach`, `filter`, `find`, `some`, `every`의 callback으로 얻은 것. model이 아닌 class의 `this.enabled()`처럼 그 밖의 receiver에 대한 호출은 메서드를 더하지 않는다. 그런 receiver의 호출에 타입이 필요하면 receiver에 모델 타입을 준다.
- `orm-gen gen --lang go`는 scan 회차마다 `--out` 옆의 임시 디렉터리에 파일을 쓰고, scan이 수렴한 뒤에만 `--out`의 생성 파일을 교체한다. 생성 헤더가 없는 파일은 그대로 유지한다. 생성이 실패하면 `--out`을 바꾸지 않으며 `orm-gen`은 상태 1로 종료한다. 이 실패에는 잘못된 체인 호출, 수렴하지 않는 scan, 로드할 수 없는 scan 대상 패키지, 컴파일되지 않는 생성 코드가 포함된다. scan이 수렴했지만 scan한 패키지가 다른 이유로 컴파일되지 않으면 `--out`은 완전한 모델을 담고 `orm-gen`은 상태 3으로 종료한다.
- `--check`는 출력을 쓰지 않고 기존 파일과 비교한다. 대상은 Go·PHP·TypeScript·Python `orm-gen`의 `gen`이다. 명령은 내용이 다른 파일에 `differs: <path>`, 없는 파일에 `missing: <path>`, 출력 디렉터리에서 생성 코드 주석을 가지고 있지만 생성이 더 이상 쓰지 않는 파일에 `extra: <path>`를 경로 순서로 출력하고, 한 줄이라도 출력하면 상태 1로 종료한다. 파일이 최신이면 아무것도 출력하지 않고 상태 0으로 종료한다. Python은 파일 하나 `models.py`를 쓰므로 그 검사는 그 파일에 `missing`이나 `differs`를 출력하며 `extra` 줄은 없다. Go `gen --check`는 `gen`과 같은 scan을 시스템 임시 디렉터리 아래의 디렉터리에서 실행하므로 모델 패키지는 `--out`의 이름과 import 경로를 유지한다. 생성 실패와 상태 3은 `gen`과 같다. Rust는 `build.rs`에서 모델을 생성하며 `gen` 명령이 없다.

```sh
go run github.com/polyspec/orm/packages/go/cmd/orm-gen gen --set contracts/fixtures/bench/dbspec-set.json --lang go --out model --scan ./... --check
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

`orm-gen gen --set <dbspec-set.json>`은 dbspec document set을 set 파일에서 `dbspec.ReadSet`으로 읽고, 생성한 `orm.go`에 `ManifestText`, `ManifestHash`, schema 값 `Schema`를 쓴다. set 파일의 `external`에 있는 path마다 [외부 문서](../spec/dbspec.ko.md#external-documents) 하나를 적으며, 생성 코드는 그 문서에서 쓰는 table을 `ExternalText`로 담고 `Install`이 database에서 확인하며, 그 model은 만들지 않는다. `model.Connect(dsn, config)`는 `orm.ConnectSchema(dsn, model.Schema, config)`를 호출한다. 연결을 열고 그 모델의 set을 연결에 등록하며, text의 hash가 `ManifestHash`와 다르면 `CONFIG`로 실패한다. 연결에 등록되지 않은 set의 요청은 `SCHEMA_HASH_MISMATCH`로 실패한다([protocol](../spec/protocol.md)). `orm.Connect(dsn, config)`는 set 없이 연결을 연다. `master.Utils().Schema().Install(model.Schema)`는 그 set을 연결에 등록하고 document set을 연결의 dialect로 render해 trigger를 포함한 문장을 적용한다. set의 테이블이 하나도 없으면 모두 만들고, 모두 있으면 아무것도 바꾸지 않으며, 일부만 있으면 `CONFIG`로 실패한다. 그다음 데이터베이스의 set 테이블이 set과 다르면 각 차이를 적은 `CONFIG`로 실패한다.

### PHP

```php
$master = \Polyspec\Orm\Tests\Model\connect($masterDsn, new Config(aesKey: $aesKey));
$master->utils()->schema()->register(\Module\Orm\schema());
```

generated model의 `bootstrap.php`는 `MANIFEST_TEXT`, `MANIFEST_HASH`, schema 값 `schema()`, connect helper `connect()`를 정의한다. `connect()`는 `Orm::connectSchema`로 연결을 열고 그 모델의 set을 연결에 등록하며, 모든 요청은 `manifestHash`를 포함한다. `Orm::connect`는 set 없이 연결을 연다. `$db->utils()->schema()->register(\Module\Orm\schema())`는 다른 generated model의 set, 여기서는 module set을 statement 없이 같은 연결에 등록하므로, 요청마다 연결을 여는 서버는 쓰는 모든 set을 그 연결에 등록한다. `$db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema())`는 배포할 때 set을 설치하고 데이터베이스를 확인한 뒤 연결에 등록한다. `new Config(poolSize: 1)`은 요청마다 연결하는 대신 php-fpm worker마다 연결 하나를 요청을 넘어 유지한다([설정](../spec/config.ko.md)). 연결은 세션 설정을 유지하며, 끝난 요청이 열어 둔 트랜잭션은 그 lock과 local 값과 함께 rollback된다.

### Rust

```rust
let master = model::connect(&master_dsn, pool_size, polyspec_orm::Config { aes_key, ..Default::default() }).await?;
master.utils().schema().install(&model::SCHEMA).await?;
```

`polyspec_orm_build::Builder::set(path)`는 dbspec document set을 set 파일에서 `dbspec::read_set`으로 읽고 모델과 manifest text를 `OUT_DIR`에 쓴다. 생성된 모듈은 manifest text를 `include_str!`로 `model::SCHEMA`에, `manifestHash`를 `model::MANIFEST_HASH`에 담는다. 그 `model::connect`는 `polyspec_orm::Db::connect_schema(dsn, &model::SCHEMA, pool_size, config)`를 호출해 연결을 열고 set을 등록한다. `polyspec_orm::Db::connect`는 set 없이 연결을 연다. runtime model은 처음 쓸 때 포함된 text로 만들고, 모든 요청은 `manifestHash`를 담는다. `utils().schema().install(&model::SCHEMA)`는 set을 연결에 등록하고 document set을 연결의 데이터베이스에 맞게 render하고 statement를 적용한다. set의 table이 모두 있으면 아무것도 만들지 않고, 일부만 있으면 `CONFIG`를 반환하며, 그다음 set의 table이 set과 다르면 각 차이를 적은 `CONFIG`를 반환한다. MySQL은 statement를 transaction 밖에서 적용하며 transaction 안에서는 `CONFIG`를 반환한다.

### TypeScript

```typescript
import { Item, SCHEMA, connect } from './models/models.js';

const master = await connect(masterDsn, { aesKey });
await master.utils().schema().install(SCHEMA);
```

`orm-gen gen --set <dbspec-set.json>`은 dbspec document set을 set 파일에서 `readDbspecSet`으로 읽고, 생성된 `models.ts`는 manifest text를 `MANIFEST_TEXT`로, 그 hash를 `MANIFEST_HASH`로, schema 값을 `SCHEMA`로, connect helper를 `connect(dsn, options)`로 export한다. `connect`는 `Db.connectSchema`로 연결을 열고 그 모델의 set을 연결에 등록한다. `Db.connect(dsn, options)`는 set 없이 연결을 열고, 연결에 등록되지 않은 set의 요청은 `SCHEMA_HASH_MISMATCH`로 실패한다. `utils().schema().install(SCHEMA)`는 한 document set의 schema 값을 받아 연결에 등록하고, 그 테이블이 하나도 없을 때 rendered statement를 적용한다. 모든 테이블이 있으면 아무것도 바꾸지 않고, 일부만 있으면 `CONFIG`로 실패한다. 그다음 set의 테이블이 set과 다르면 각 차이를 적은 `CONFIG`로 실패한다.

각 클라이언트는 요청 형태별로 Plan을 캐시한다. `connection.utils().schema().install(schema)`는 document set을 설치하고([schema.md](../spec/schema.md#_4-schema-installation)), `connection.utils().schema().addTablesAndColumns(schema)`는 설치한 set을 더하기만 하는 version으로 올린다: 데이터베이스에 없는 테이블을 만들고, 기존 테이블에 빠진 컬럼 가운데 null이거나 default가 있는 컬럼을 추가하고 빠진 index를 만들며, 다른 모든 차이에는 변경 전에 `SCHEMA_DIFFERS`를 반환한다. 빠진 unique key도 있는 row에서 실패할 수 있어 plan에서 다루므로 `SCHEMA_DIFFERS`다([schema.md](../spec/schema.md#_5-adding-tables-and-columns)). 둘 다 실행할 때 데이터베이스를 확인한다. `connection.utils().schema().register(schema)`와 connect helper는 데이터베이스를 읽지 않고 연결마다 set을 등록한다([schema.md](../spec/schema.md#_6-schema-registration)).

---

## 5. 읽기

메서드 명칭은 공통이며 표기만 다르다(PHP·TypeScript `camelCase` / Go `PascalCase` / Rust·Python `snake_case`).

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

- 조건: 첫 조건에는 접두어가 없고, 이후 조건은 `and<Chain>`, `or<Chain>` 또는 `and()`·`or()`를 사용하며, 묶음은 `and(fn)`·`or(fn)`을, 부정 묶음은 `not(fn)`·`andNot(fn)`·`orNot(fn)`을 사용한다. 연산자 접두어·값 형태·체인 규칙은 [dsl.md](../spec/dsl.md)에 있다.
- 조회 메서드: `getBy<Chain>`, `getsBy<Chain>`, `getCountBy<Chain>`은 `getsByServiceSeqAndIsClose(7, false)`처럼 컬럼 체인을 적용한다. Go, Rust, TypeScript는 모델 생성이 scan된 코드에서 찾은 체인을 선언하고, PHP는 `--scan`을 주면 `@method` 태그로 선언하고 아니면 호출이 실행될 때 체인을 해석하며, Python은 호출이 실행될 때 체인을 해석한다. 규칙은 [조회 체인](../spec/interfaces.md#finder-chains)에 있다.
- 컬럼: `addColumn<Col>()`, `removeColumn<Col>()`, `removeAllColumns()`, `addAllColumns()`. `text`·`blob`·스타일 컬럼은 기본 SELECT에서 빠지며 `addColumn<Col>()`로 추가한다.
- Rust 생성 모델 필드는 비공개다. 조회하거나 대입하지 않은 컬럼을 읽으면 `COLUMN_UNSELECTED`를 반환하며, 빠진 값을 SQL NULL이나 기본값으로 보여주지 않는다.
- PHP 생성 모델 getter도 스타일이 없는 컬럼을 조회하거나 대입하지 않고 읽으면 `COLUMN_UNSELECTED`를 반환하며, 선택한 SQL NULL과 명시적으로 대입한 값은 계속 읽을 수 있다.
- 종단 작업: `get`은 행 하나를 반환하며 일치하는 행이 없으면 null을 반환한다. 어떤 읽기도 빈 결과에 오류를 내지 않는다. `gets`는 컬렉션을 반환하며 일치하는 행이 없으면 빈 컬렉션이다. `getCount`는 개수를 반환한다.
- 컬렉션은 PK 또는 `keyName<Col>()`을 키로 하는 순서 있는 맵이다. `first()`, `count()`, `toArray()`를 제공하며 순회하면 `key => row`가 나온다.
- `toArray()`는 컬렉션 순서대로 행을 맵 목록으로 반환한다. Go는 `rows.ToArray()`, Rust는 `rows.to_array()`, PHP는 `$rows->toArray()`, TypeScript는 `rows.toArray()`, Python은 `rows.to_array()`를 사용한다. 순회는 키와 키 타입을 유지한다.

### 집계와 그룹

```php
(new Author)->connect($slave1)->serviceSeq(7)->groupByUserSeq()->getsCount();   // rows per user with row_count
(new Author)->connect($slave1)->serviceSeq(7)->sumLikeCount()->getSum();       // sum of like_count
(new Author)->connect($slave1)->serviceSeq(7)->avgPrice()->getAvg();           // average price
```
부정 묶음, 컬럼 함수 출력, 서브쿼리 컬럼, ORM 함수 값은 [dsl.md](../spec/dsl.md)에서 정의한다.
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
| `parentNode()` | one 관계 컬럼을 부모 행에 병합. 부모 값 우선 ([protocol](../spec/protocol.md#_1-2-joins-and-relations)) |
| `groupLimit(n)` | `ROW_NUMBER() OVER (PARTITION BY …)`로 부모당 n행 |
| `possible<Col>(v)` | 부모 행이 일치할 때만 조회 |
| `deleteLock()` | `delete(true)`의 중단 지점 |

`connect`를 호출한 관계 자식은 그 연결에서 SQL 문장을 실행한다. 조인 자식은 `on(fn)`으로 `ON` 조건을 정하고 `WHERE` 조건을 직접 설정하며, `and(child)` 또는 `or(child)`가 자식 조건을 묶음으로 넣는다. 조인 자식의 `connect`는 `CONFIG`를 반환한다.
조인한 모델과의 컬럼 비교는 `priceGtMinPrice($brand)` 같은 `<ColA><Op><ColB>(model)`를 사용한다.

---

## 7. 쓰기

```php
$row = (new Author)->connect($master)->setName('x')->setUserSeq(1)->…->create();   // returns the row with its generated key
$row->setName('y')->update();                                                     // updates changed columns only
$row->setName('z')->update(true);                                                 // updated_ts mismatch → OPTIMISTIC_LOCK
$row->delete();
$row->delete(true);                                                               // loaded relations first, except deleteLock()

$replicaRow->connect($master)->plusReadCount(1)->update();                        // read on a replica, write on the primary

(new Author)->connect($master)->setUuid($u)->setName('x')->…
    ->duplication((new Author)->setName('x')->plusReadCount(1))->create();        // UPSERT
$row->newIsMember(true);                                                          // attached value, not part of SQL
```

- `update`는 방언 간 값을 맞추기 위해 `updated_ts`를 항상 명시적으로 기록한다.
- `minus<Col>`은 음수를 저장하지 않는다.
- `save()`는 기본 키가 있으면 갱신하고 없으면 행을 생성한다.
- `creates(rows, batch)`는 행을 `batch`개씩 batch로 나누어 각 batch를 하나의 multi-row INSERT로, 하나의 트랜잭션에서 삽입하고 삽입한 행 수를 반환한다. `batch`는 호출자가 정하며 client는 batch를 나누지 않는다. `batch`는 필수인 양의 정수이며 아니면 `CONFIG`다. 바인드 수(행 수 × 컬럼 수)가 바인드 한도(SQLite 999, MySQL과 PostgreSQL 65535)를 넘는 batch는 `BATCH_TOO_LARGE`이고, message는 그 batch와 바인드 수와 한도를 밝힌다. 둘 다 어떤 statement보다 먼저 실패한다.
- 트랜잭션은 `connection.transaction(fn)`을 사용한다. 콜백 오류나 예외는 트랜잭션을 되돌리고 교착 상태는 재시도한다.
- 활성 트랜잭션 안에서 같은 연결의 `transaction`을 호출하면 savepoint를 만든다. 바깥 콜백이 안쪽 실패를 반환하지 않으면 안쪽 작업만 되돌린다.
- 트랜잭션 옵션은 `isolation`, `readOnly`, `timeoutMs`를 선택한다. 지원하는 격리 수준은 `default`, `read_uncommitted`, `read_committed`, `repeatable_read`, `serializable`이다. PostgreSQL은 `BEGIN` 후에, MySQL은 유지한 연결에서 `START TRANSACTION` 전에 설정을 적용한다. SQLite는 `PRAGMA query_only`로 `readOnly`를 적용하고 공통 격리 수준을 트랜잭션 연결에 대응시키며, ORM은 commit이나 rollback 전에 연결 상태를 복원한다. 양수 `timeoutMs`는 PostgreSQL `statement_timeout`을 적용하고 MySQL·SQLite는 `CAPABILITY_UNSUPPORTED`를 반환한다.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, `forShareNoWait()`는 트랜잭션 안에서만 허용한다. MySQL과 PostgreSQL은 선택한 행 잠금을 실행하며 `NoWait`는 행을 사용할 수 없으면 즉시 실패한다. SQLite는 잠금 접미사를 만들지 않고 네 모드 모두 ORM 트랜잭션 범위의 데이터베이스 잠금 행을 사용한다. SQLite 쓰기 트랜잭션은 시작할 때 데이터베이스 쓰기 잠금을 얻으므로 그 안의 잠금 요청은 기다리지 않고 성공하며, 잠금 대기는 트랜잭션 시작에서 일어난다([런타임 연결](../spec/config.md)).
- 공통 실행 중 취소 메서드는 없다. `timeoutMs`가 PostgreSQL 문장 실행 시간을 제한한다.
- test는 자기 클라이언트의 test fault로 모든 데이터베이스에서 트랜잭션의 rollback을 실패시킨다. production build는 이 fault를 포함하거나 load하지 않는다([protocol §3.1](../spec/protocol.md#_3-1-test-faults)). Go는 `-tags ormtest`와 `orm.FailNextRollback(db)`, Rust는 feature `test-faults`와 `polyspec_orm::testing::fail_next_rollback(&db)`, TypeScript는 `node --conditions=orm-test`에서 `@polyspec/orm/testing`의 `failNextRollback(db)`, PHP는 `require 'vendor/polyspec/orm/testing/Faults.php'` 뒤의 `Polyspec\Orm\Testing\Faults::failNextRollback($db)`를 사용한다. callback이 실패한 다음 트랜잭션은 rollback되고 callback 오류와 `FAULT` 오류를 가진 `ROLLBACK`을 반환한다.
- test는 자기 클라이언트의 statement fault로 연결의 다음 statement가 주어진 code와 message로 모든 데이터베이스에서 실패하게 한다([protocol §3.2](../spec/protocol.ko.md#_3-2-test-statement-fault)). Go는 `-tags ormtest`와 `orm.FailNextStatement(db, code, message)`, Rust는 feature `test-faults`와 `polyspec_orm::testing::fail_next_statement(&db, code, message)`, TypeScript는 `node --conditions=orm-test`와 `@polyspec/orm/testing`의 `failNextStatement(db, code, message)`, PHP는 `Polyspec\Orm\Testing\Faults::failNextStatement($db, $code, $message)`, Python은 `polyspec.orm.testing.fail_next_statement(db, code, message)`를 쓴다. statement는 데이터베이스로 가지 않고, 클라이언트는 그 code와 message의 `OrmException`으로 보고하며, fault는 그 statement가 소비한다.

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

### 감사 대상 쓰기 {#audited-writes}

`audit` setting([audit](../spec/dbspec.ko.md#audit))이 있는 테이블은 작업 단위를 audit 기록 테이블, 곧 setting이 `references`로 정한 테이블에 기록하는 트랜잭션 안에서만 쓴다. 두 곳이 기록의 값을 준다:

- 연결 설정은 프로세스마다 한 번 `auditSource`를 받는다([설정](../spec/config.ko.md)). 현재 요청의 audit 값, 곧 계정과 요청 id처럼 audit 기록 테이블의 컬럼 이름에서 값으로 가는 map을 돌려주는 함수다. ORM은 자기 audit 값을 쓰지 않는다.
- 트랜잭션의 `audit` 옵션은 이 변경의 값이며, 컬럼 이름에서 값으로 가는 map이다(Go `orm.Audit(map[string]any)`, PHP `audit:` 배열, Rust `transaction`, `transaction_send`, `transaction_once`의 `.audit(pairs)`, TypeScript `{ audit: {...} }`). 빈 map은 source의 값만 기록한다.

```go
master, err := model.Connect(dsn, orm.Config{AuditSource: func(ctx context.Context) (map[string]any, error) {
    r := requestOf(ctx) // the request context of the calling code
    return map[string]any{"account_seq": r.AccountSeq, "request_id": r.ID}, nil
}})
err = master.WithContext(ctx).Transaction(func() error {
    _, err := model.Service().SetName("renamed").Create()
    return err
}, orm.Audit(map[string]any{"action": "service.rename", "reason": reason}))
```
```php
$master = \Polyspec\Orm\Tests\Model\connect($dsn, new Config(auditSource: fn (): array => ['account_seq' => $request->accountSeq(), 'request_id' => $request->id()]));
$master->transaction(function (): void {
    (new Service)->setName('renamed')->create();
}, audit: ['action' => 'service.rename', 'reason' => $reason]);
```
```rust
let master = model::connect(&dsn, pool_size, polyspec_orm::Config {
    audit_source: Some(Arc::new(|| Ok(vec![("account_seq".into(), Param::I64(current_account()?)), ("request_id".into(), Param::from(current_request_id()?))]))),
    ..Default::default()
}).await?;
master.transaction(async || Service::new().set_name("renamed").create().await.map(|_| ()))
    .audit([("action", "service.rename"), ("reason", reason.as_str())])
    .await?;
```
```typescript
const master = await connect(dsn, { auditSource: () => ({ account_seq: currentRequest().accountSeq, request_id: currentRequest().id }) });
await master.transaction(async () => {
  await new Service().setName('renamed').create();
}, { audit: { action: 'service.rename', reason } });
```

- `audit`을 가진 트랜잭션은 시작하기 전에 source를 한 번 부르고, 감사 대상 테이블에 처음 쓰기 직전에, 재시도하는 트랜잭션이면 시도마다, source의 값과 자기 값으로 audit 기록 테이블에 행 하나를 삽입한다. 같은 컬럼이면 트랜잭션의 값이 source의 값을 이긴다. 트랜잭션 안의 감사 대상 테이블의 모든 insert, update, soft delete, restore는 그 행의 primary key(생성된 identity나 준 값)를 테이블의 audit 컬럼에 쓰고, 데이터베이스 trigger가 각 버전을 history 테이블에 복사한다. 감사 대상 행을 쓰지 않는 트랜잭션은 audit 행을 삽입하지 않는다. 읽기는 아무것도 남기지 않고, 어떤 행과도 맞지 않는 첫 update, delete 또는 restore는 savepoint로 그 audit 행을 되돌린다. callback이 실패하거나 첫 감사 대상 쓰기를 되돌리는 savepoint가 rollback되면 audit 행도 변경과 함께 되돌아가고, 다음 감사 대상 쓰기가 다시 삽입한다.
- audit 기록 테이블은 연결에 등록한 set의 감사 대상 테이블들의 `references`가 정한 테이블 하나이며, 연결에 등록한 set의 테이블이다. 그런 테이블이 없거나 여럿이거나 primary key가 컬럼 둘 이상이면 `CONFIG`로 실패한다. 연결에 audit source가 없거나, source나 트랜잭션의 값이 audit 기록 테이블에 없는 컬럼을 정하거나, 값이 하나도 없으면 트랜잭션은 시작하기 전에 `CONFIG`로 실패한다. source의 오류는 그 오류로 트랜잭션을 실패시킨다.
- `audit`을 가진 트랜잭션 밖에서 감사 대상 테이블을 쓰면 `CONFIG`로 실패한다. 중첩 트랜잭션은 바깥 트랜잭션의 audit을 쓰며 `audit`을 받지 않는다. audit 컬럼을 직접 할당하는 요청은 `IR_INVALID`로 실패한다.
- setting에 `tables`가 있으면([audit](../spec/dbspec.ko.md#audit)) trigger는 transaction이 바꾼 감사 대상 테이블마다 행 하나를 `audit_table (audit_seq, table_name)` 같은 tables table에 함께 쓴다. 이 테이블은 audit 집합의 평범한 테이블이므로 생성된 model이 읽고, audit 기록에서의 join이 한 테이블의 audit을 거르고 page로 나눈다: `(new Audit)->connect($db)->ltSeq($last)->joinSeqWithAuditSeq((new AuditTable)->tableName('service'))->orderBySeqDesc()->limit(0, 20)->gets()`, 같은 chain의 `getCount()`가 개수를 센다. primary key `(audit_seq, table_name)` 덕분에 audit 하나에 join 행 하나다. 어떤 audit도 바꾸지 않은 테이블은 어떤 행과도 맞지 않는다: 다른 읽기처럼 빈 목록, 개수 0, 행 하나 읽기는 null이다.

### Soft delete한 행 되돌리기 {#restore-a-soft-deleted-row}

`soft_delete` setting이 있는 테이블의 삭제는 행과 그 unique key 값을 남기고, 읽기는 그 행을 반환하지 않으므로 같은 key를 다시 삽입하면 `DUPLICATE_KEY`로 실패한다. `restore()`는 그런 행을 되돌린다. 새 모델에 primary key나 unique key 하나의 값과, 다른 컬럼의 새 값을 지정하고 `restore()`를 호출한다. 이 호출은 지정 값을 요청의 `set`으로 보내고, planner는 request hook 뒤에 key를 고르므로 hook은 `update`처럼 restore에 조건을 더할 수 있다. 이 호출은 `UPDATE` 하나로 새 값을 쓰고 soft delete 컬럼을 비우며([protocol](../spec/protocol.ko.md#_1-5-restore)), 그 key의 값으로 기본 select 집합의 행을 읽어 조회한 모델로 반환한다.

```go
row, err := model.Membership().Connect(master).SetTeamId(1).SetMemberId(2).SetRole("owner").Restore()
```
```php
$row = (new Membership)->connect($master)->setTeamId(1)->setMemberId(2)->setRole('owner')->restore();
```
```rust
let row = Membership::new().connect(&master).set_team_id(1).set_member_id(2).set_role("owner").restore().await?;
```
```typescript
const row = await new Membership().connect(master).setTeamId(1).setMemberId(2).setRole('owner').restore();
```

- key는 hook 뒤 요청의 지정 값과, 함수, 값 함수, ref, subquery 없는 컬럼의 `eq` 조건이 모든 primary key 컬럼에 값을 주면 primary key이고, 그렇지 않으면 컬럼 모두에 값을 주는 첫 unique key(이름 순서)다. key 값은 null, raw, plus, minus가 아닌 일반 값이다. key 컬럼의 지정 값은 조건이고, 나머지 지정 값은 새 값이며 `update`처럼 할당한다. hook이 더한 조건은 restore를 더 좁힌다. key의 값이 없으면 문장 없이 `IR_INVALID`로 실패하며, primary key나 soft delete 컬럼의 새 값, `soft_delete`가 없는 테이블도 그렇다.
- 지워지지 않은 행은 바뀌지 않은 채 반환되며 새 값을 포함해 아무것도 쓰지 않는다. 어떤 행도 갖지 않은 key는 `NO_ROWS`로 실패한다.
- `audit` setting이 있는 테이블에서 restore는 다른 update와 같다. audit 값을 가진 트랜잭션 안에서 실행하고, audit 기록의 key를 audit 컬럼에 쓰며, trigger가 그 버전을 history 테이블에 기록한다. audit이 없으면 `CONFIG`로 실패한다.
- restore는 soft delete처럼 `updated` 컬럼을 할당하지 않는다. update와 읽기는 문장 두 개이며, 트랜잭션 안에서는 한 상태를 본다.

---

### 행 되돌리기 또는 만들기 {#restore-or-create-a-row}

`restoreOrCreate()`는 `soft_delete` setting이 있는 테이블의 key에, 그 key가 어떤 상태이든 그 행을 준다. `restore()`처럼 새 모델에 primary key나 unique key 하나의 값과, 행의 다른 값을 지정한다.

```go
row, err := model.Membership().Connect(master).SetTeamId(1).SetMemberId(2).SetRole("owner").RestoreOrCreate()
```
```php
$row = (new Membership)->connect($master)->setTeamId(1)->setMemberId(2)->setRole('owner')->restoreOrCreate();
```
```python
row = (
    Membership()
    .connect(master)
    .set_team_id(1)
    .set_member_id(2)
    .set_role("owner")
    .restore_or_create()
)
```
```rust
let row = Membership::new().connect(&master).set_team_id(1).set_member_id(2).set_role("owner").restore_or_create().await?;
```
```typescript
const row = await new Membership().connect(master).setTeamId(1).setMemberId(2).setRole('owner').restoreOrCreate();
```

- 한 트랜잭션 안에서 실행하며, key는 `restore()`가 고르는 key다. 그 key를 가진 soft delete된 행은 `restore()`가 되돌리듯 지정 값으로 되돌려지고 audit도 함께 쓰이며, 그 행을 반환한다.
- 어떤 행도 갖지 않은 key는 `create()`가 행을 만들듯 지정 값으로 만들어지고, 만든 행을 반환한다. 이미 있는 행이 가진 다른 unique key는 `create()`처럼 `DUPLICATE_KEY`로 실패한다.
- 그 key를 가진, 지워지지 않은 행은 `ROW_NOT_DELETED`로 실패하며, 지정 값을 포함해 아무것도 쓰지 않는다. 그 행을 update할지는 호출하는 쪽이 정한다.
- statement는 restore 단계, key 읽기, 그리고 어떤 행도 갖지 않은 key라면 insert다. conformance vector `restore_or_create`가 MySQL, PostgreSQL, SQLite에서 그것과 결과를 고정한다. `soft_delete`가 없는 테이블은 `restore()`처럼 `IR_INVALID`로 실패한다.

## 8. 스타일 컬럼

`gz_*`, `json_*`, `jsons_*`, `base64_*`, `serialize_*`는 클라이언트 출력에서 저장 바이트가 아니라 **디코딩한 값**을 사용한다
(Go `any` · Rust `serde_json::Value` · PHP `mixed`). MySQL은 `aes_hex_*`와 `ip`를 SQL 함수로 처리하고,
PostgreSQL·SQLite 실행기는 같은 바이트를 만든다([codec.md](../spec/codec.md)).

```php
$b->setJsonSetting(['a' => 1])->connect($master)->update();
$b = (new Author)->connect($slave1)->addColumnJsonSetting()->getBySeq(42);   // excluded from the default SELECT
$b->getJsonSetting()['a'];
```

---

## 9. 여러 데이터베이스

같은 문장은 세 데이터베이스에서 같은 결과를 만들며 SQL 문장 텍스트만 방언별로 다르다. 규칙과 예외는 [dialects.md](../spec/dialects.md)에 있다.

`connection.utils().schema().install(...)`은 연결의 dialect로 document set을 렌더링한다([schema.md](../spec/schema.md#_4-schema-installation)).

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
| 스키마가 라이브 DB와 같은지 | 데이터베이스를 introspect하고 schema text를 document set과 비교한다([schema.md](../spec/schema.md#_2-schema-operations)) |
| 생성물이 최신인지 | 언어별 생성기 실행 후 `git diff --exit-code` |
| Statement event | 연결의 `subscribe`. client가 보내는 모든 statement([statement event](#statement-events)) |
| key를 지킨 적재처럼 compile한 statement 실행 | 연결의 `execute`([compile한 statement 실행](#execute-a-compiled-statement)) |
| handle의 모든 request를 plan 전에 바꾸기 | 연결의 `withRequestHook`([request hook](#request-hook)) |
| 실행 없이 SQL 보기 | 연결한 모델의 `getQuery()` ([dsl.md](../spec/dsl.md)) |
| 에러 코드 상수 | `orm-gen errors --lang go\|php\|rust\|typescript\|python --out …` ([errors.yaml](../spec/errors.yaml)) |
| 스키마 설치 | `connection.utils().schema().install(...)` ([schema.md](../spec/schema.md#_4-schema-installation)) |
| 설치한 set에 빠진 테이블, 컬럼, index 추가 | `connection.utils().schema().addTablesAndColumns(...)` ([schema.md](../spec/schema.md#_5-adding-tables-and-columns)) |

---


### Statement event {#statement-events}

모든 client는 데이터베이스로 보내는 statement마다 event 하나를 publish한다: model의 statement, transaction 제어, schema utility의 statement, 그 밖의 모든 utility statement다. subscriber는 연결에 등록한다. 공유 vector `tests/events/vectors.json`은 sequence 하나를 MySQL, PostgreSQL, SQLite에서 실행하고 모든 client가 publish하는 event를 적는다.

| Client | 등록과 해제 | Event |
|---|---|---|
| Go | `unsubscribe, err := db.Subscribe(func(e orm.StatementEvent) error { …; return nil })`; `unsubscribe()` | `orm.StatementEvent{SQL, Binds, Kind, Tables, Elapsed, Transaction, Err}`. `Elapsed`는 `time.Duration`, `Transaction`은 transaction 밖에서 0 |
| PHP | `$unsubscribe = $db->subscribe(function (Polyspec\Orm\StatementEvent $e): void { … })`; `$unsubscribe()` | `sql`, `binds`, `kind`, `tables`, `elapsed`(초), `transaction`(`?int`), `error`(`?OrmException`)를 가진 `Polyspec\Orm\StatementEvent` |
| Rust | `let subscription = db.subscribe(\|e: &polyspec_orm::StatementEvent<'_>\| Ok(()))?;`; `subscription.unsubscribe()` | `polyspec_orm::StatementEvent { sql, binds, kind, tables, elapsed, transaction, error }`. `elapsed`는 `Duration`, `transaction`은 `Option<u64>`, `error`는 `Option<&polyspec_orm::Error>` |
| TypeScript | `const unsubscribe = db.subscribe(e => { … })`; `unsubscribe()` | `sql`, `binds`, `kind`, `tables`, `elapsed`(초), `transaction`(`number \| null`), `error`(`OrmError \| null`)를 가진 `StatementEvent` |

- `sql`은 보낸 statement다. relation step은 펼친 `IN` 목록을 담는다.
- `binds`는 순서대로 bind한 값이다. 비밀은 `$SECRET`, executor 시각 값은 `$NOW`다.
- `kind`는 statement의 출처에서 정한다: model statement는 plan step이 쓰는 동사인 `select`, `insert`, `update`, `delete`다(soft delete는 `update`). transaction 제어는 `begin`, `commit`, `rollback`, `savepoint`, `release`, `rollback_to`다. schema utility의 statement는 `schema`다(`install`과 `addTablesAndColumns`의 catalog 읽기와 statement, `exists`, `installed`, `empty`의 읽기). 그 밖의 모든 statement는 `utility`다: 이름 lock과 row lock, transaction 지역 값, transaction 설정, 권한, AES 상태와 회전, SQLite row lock table이다.
- `tables`는 정렬하고 중복을 뺀 목록이다. model statement는 plan step의 `tables`를 가진다([protocol](../spec/protocol.md#_2-plan)). table을 만들거나 바꾸는 schema statement는 그 table을 가진다. table에 대한 utility statement는 그 table을 가진다(SQLite row lock의 `orm__row_lock`, 권한의 table, AES 상태와 회전의 table). transaction 제어, catalog 읽기, 그 밖의 statement는 table이 없다.
- `elapsed`는 statement를 보낸 때부터 client가 그 결과를 다 읽을 때까지다.
- `transaction`은 연결에서의 transaction 번호다: 바깥 begin마다(deadlock 뒤의 재시도와 foreign key를 끈 채 table을 다시 만드는 SQLite transaction 포함) 1부터 다음 번호를 받고, begin부터 commit이나 rollback까지의 모든 statement가 그 번호를 가진다. transaction 밖의 statement는 번호가 없다.
- `error`는 statement가 끝난 오류이며 operation이 보고하는 code를 가진다. 성공하면 없다. 돌려받은 행을 decode하지 못한 것은 statement의 오류가 아니다.

client는 statement가 끝난 뒤 operation이 이어지기 전에 subscriber를 등록 순서대로 동기 호출한다. 연결의 모든 handle(Go `WithContext`, TypeScript `withSignal`, 복제한 Rust 값, Python `with_request_hook`)이 subscriber를 공유한다. subscriber가 없으면 client는 목록이 빈 것만 확인한다. subscriber는 실패하면 안 된다: subscriber가 오류를 돌려주거나(Go, Rust) 예외를 던지면(PHP, TypeScript, Python) 남은 subscriber는 실행되지 않고 operation은 그 오류를 cause로 가진 `SUBSCRIBER`로 실패한다. statement의 효과는 남으며, transaction 안에서는 callback이 그 오류를 받는다.

모든 client는 같은 transaction 제어 statement를 실행한다:

| Dialect | 시작 | 끝 |
|---|---|---|
| MySQL | `SET TRANSACTION ISOLATION LEVEL <level>`(isolation이 있으면 `utility`), 그다음 `START TRANSACTION` 또는 `START TRANSACTION READ ONLY` | `COMMIT` 또는 `ROLLBACK` |
| PostgreSQL | option에 따라 ` ISOLATION LEVEL <level>`과 ` READ ONLY`를 붙인 `BEGIN`, 그다음 `SET LOCAL statement_timeout = <ms>`(`timeoutMs`가 있으면 `utility`) | `COMMIT` 또는 `ROLLBACK` |
| SQLite | `BEGIN IMMEDIATE`, 읽기 전용 transaction은 `BEGIN`, 그다음 option에 따라 `PRAGMA read_uncommitted = 1`과 `PRAGMA query_only = 1`(`utility`) | 같은 `PRAGMA`를 0으로, 그다음 `COMMIT` 또는 `ROLLBACK` |

`<level>`은 `READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ`, `SERIALIZABLE` 중 하나다. SQLite 연결의 첫 transaction 전에 client는 transaction 밖에서 `CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))`로 row lock table을 만든다. 중첩 transaction은 `SAVEPOINT orm_sp_<depth>`와 `RELEASE SAVEPOINT orm_sp_<depth>`를 실행하고, callback이 실패하면 `ROLLBACK TO SAVEPOINT orm_sp_<depth>` 다음 `RELEASE`를 실행한다. MySQL transaction이 끝나기 전에 client는 이름 lock을 `SELECT RELEASE_LOCK(?)`로 풀고 지역 값을 key 순서로 ``SET @`orm.<key>` = NULL``로 지운다. MySQL이나 PostgreSQL transaction의 context나 signal이 취소되면 client는 `ROLLBACK` 대신 session을 닫는다. 취소된 SQLite transaction은 그래도 `PRAGMA` mode를 되돌리고 `ROLLBACK`으로 끝난다.

물리 연결을 여는 statement(time zone 같은 session 설정, SQLite version 읽기), statement의 준비, protocol 수준의 취소는 event가 아니다.

### Compile한 statement 실행 {#execute-a-compiled-statement}

request를 직접 compile하는 program은, 예를 들어 행을 identity key와 함께 쓰고 그 뒤 각 identity를 다시 시작하는 적재는([protocol](../spec/protocol.ko.md#_1-6-load)), 각 statement를 연결의 `execute`로 실행한다. client의 planner가 compile한 plan의 step 하나와, 그 bind slot이 읽는 request 매개변수를 넘긴다.

| Client | Compile | 실행 |
|---|---|---|
| Go | `engine.New(model, dialect)` 다음 `Compile(requestJSON)`, 또는 `(&planner.Planner{M: model, D: dialect}).Compile(request)` | `err := db.Execute(&plan.Steps[0], params)` |
| PHP | `(new Polyspec\Orm\Engine($model, $dialect, $cacheSize))->compile($request)` | `$db->execute($plan['steps'][0], $params)` |
| Rust | `polyspec_orm::engine::compile(&manifest, dialect, &request)` | `db.execute(&plan.steps[0], &params).await?` |
| TypeScript | `new Engine(model, dialect).compile(request)` | `await db.execute(plan.steps[0], params)` |
| Python | `polyspec.orm.engine`의 `Engine(model, dialect).compile(request)` | `db.execute(plan['steps'][0], params)` |

- statement는 model 쓰기가 실행되는 곳에서 실행된다: 연결의 활성 transaction, 없으면 연결이다. bind slot은 model statement와 같은 방식으로 값을 받는다: host style을 거친 request 매개변수, decimal, SQLite 날짜와 시각, 설정의 AES key와 key version, client 시각, transaction의 audit이다.
- 동사의 kind인 `insert`, `update`, `delete`, `select`로 statement event를 publish하며, identity를 다시 시작하는 MySQL `ALTER TABLE`은 `schema`다([statement event](#statement-events)). driver 오류는 model statement가 보고할 code를 가진다.
- 행을 읽는 step(`assemble`이 있는 step)은 `IR_INVALID` `execute runs a statement without rows; the statement is a read`로, 매개변수 밖을 읽는 `param` slot은 `IR_INVALID` `bind slot <i> reads parameter <p>, but execute has <n> parameters`로 실패하며, 둘 다 statement를 보내지 않는다.
- `execute`는 아무것도 돌려주지 않는다. 적재가 필요한 값은 model이나 query로 다시 읽는다.
- PHP extension `orm_dbspec`은 dbspec 표면만 구현하고 query 연결을 갖지 않으므로 `execute`가 없다. 둘 다 PHP client가 실행한다.

### Request hook {#request-hook}

`withRequestHook`은 같은 연결의 handle을 돌려준다. 그 handle의 hook은 handle의 각 request([protocol](../spec/protocol.ko.md#_1-request))를 client가 plan하기 직전에 받는다. hook은 predicate, assignment, 매개변수를 더할 수 있고, client는 hook에 자기 의미를 붙이지 않는다.

| Client | Handle | Hook |
|---|---|---|
| Go | `h := db.WithRequestHook(hook)` | `orm.RequestHook`인 `func(r *ir.Request, addParam func(value any) int, params []any) error`이며 `r`을 직접 고치고 사본인 `params`에서 bind된 값을 읽는다. `ir`은 `github.com/polyspec/orm/packages/go/engine/ir`이다 |
| PHP | `$h = $db->withRequestHook($hook)` | `\Closure(Polyspec\Orm\Request $r): void`이며 `$r->ir`을 직접 고치고 `$r->param($value)`로 매개변수를 더하며 `$r->params`에서 bind된 값을 읽는다 |
| Rust | `let h = db.with_request_hook(hook);` | `Fn(&mut polyspec_orm::ir::Request, &mut polyspec_orm::RequestParams) -> polyspec_orm::Result<()>`이며 request를 직접 고치고 `params.add(value)`로 매개변수를 더하며 `params.get(index)`로 bind된 값을 읽는다 |
| TypeScript | `const h = db.withRequestHook(hook)` | `RequestHook`인 `(request: Request, addParam: (value: unknown) => number, params: readonly unknown[]) => Request`이며 plan할 request를 돌려주고 고정된 사본인 `params`에서 bind된 값을 읽는다 |
| Python | `h = db.with_request_hook(hook)` | `RequestHook`인 `Callable[[IRRequest, Callable[[object], int], tuple], IRRequest]`이며 plan할 request를 돌려주고 tuple에서 bind된 값을 읽는다. `IRRequest`는 `polyspec.orm.ir`의 것이다 |

- handle은 연결의 모든 것을 공유한다: pool(PHP에서는 PDO 연결), plan cache와 statement cache, statement event subscriber, 활성 transaction이다. handle은 자기가 나온 handle의 다른 속성(Go context, TypeScript signal)을 지키며, 그 handle에서 `WithContext`나 `withSignal`로 만든 handle도 hook을 지킨다. handle은 hook 하나를 가진다: hook이 있는 handle의 `withRequestHook`은 새 hook을 가진 handle을 돌려준다. `Root()`(Go)와 `root()`(Python, TypeScript)는 연결을 돌려준다.
- client는 handle을 거쳐 실행되는 model 종단의 request마다 hook을 한 번 부른다: `one`과 `all` 읽기, `count`, `group_count`, `sum`, `avg`, `paginate`(page statement와 count statement에 한 번), 행 하나나 `rows`의 `insert`, `update`, `delete`, soft delete, `restore`, `on_duplicate`가 있는 insert, `getQuery`다. client가 model을 위해 만드는 request에도 부른다: 재귀 delete의 자식 delete와, handle에서 시작한 audit 값이 있는 transaction의 audit 기록 insert다. 자식이 자기 연결을 가진 relation은 그 연결을 거친다. `execute`, schema utility와 다른 utility는 request를 보내지 않으므로 hook을 부르지 않는다.
- hook은 model이 만든 request, 그것이 bind한 매개변수(읽기 전용이라 hook이 호출자가 준 값을 확인할 수 있다), 매개변수를 더하는 수단을 받는다: `addParam(value)`는 value를 request 매개변수 끝에 더하고 그 index를 돌려준다. hook은 protocol이 허용하는 어떤 방식으로든 request를 바꿀 수 있다. 예를 들어 root, join, relation의 `where`에 predicate를, `set`에 assignment와 `rows`의 각 항목에 매개변수 하나를, `on_duplicate`에 항목을 더한다. client는 그 뒤 `n_params`를 매개변수 수로 쓰고 request를 다른 request처럼 plan한다. planner가 request를 검증하므로 매개변수 밖의 index는 `IR_INVALID`로, 모르는 column은 `COLUMN_UNKNOWN`으로 statement 전에 실패한다. plan cache는 값이 아니라 request로 key를 정하므로, hook이 같은 모양으로 바꾼 두 request는 hook이 더한 값과 관계없이 plan 하나를 함께 쓴다.
- hook의 오류(PHP, Python, TypeScript는 throw, Go와 Rust는 반환)는 바뀌지 않은 채 statement 전에 operation을 실패시킨다.
- model은 자기가 연결된 handle을 거친다. transaction 안에서 연결이 없는 model은 transaction을 시작한 handle을 거친다. hook이 있는 handle로 읽거나 만든 행은 그 handle을 지키므로, 그 뒤의 `update`, `delete`, `restore`도 hook을 지난다. hook이 있는 handle에서 시작한 transaction은 callback의 model에 hook을 지키며, 그 안에서 연결의 다른 handle에 연결한 model은 그 handle의 hook으로 실행된다.
- 만든 행은 호출자가 지정한 값을 가진다. hook이 지정한 값은 써지지만 행으로 다시 읽히지 않는다.
- hook이 없는 handle은 model이 만든 request를 복사하거나 부르는 일 없이 그대로 plan한다.
- 공유 case `contracts/fixtures/request_hook.dbs`는 모든 client에서 SQLite로 실행된다: hook이 더한 predicate가 읽기, count, page를 거르고, hook이 더한 assignment를 행 하나의 insert와 여러 행의 insert가 쓰며, 읽은 행의 update와 delete가 hook을 지나고, 매개변수 밖의 index는 statement 전에 `IR_INVALID`로 실패하며, hook이 없는 handle은 모든 행을 읽고, restore는 지정 값과 hook이 더한 조건에서 key를 얻으며, hook이 더한 조건은 그 밖의 행의 restore를 막고, 값과 조건이 어떤 key도 덮지 않는 restore는 statement 전에 `IR_INVALID`로 실패한다.

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
| `WRITE_CONFLICT` | IR executor가 읽은 뒤 바뀐 대상을 찾았거나, commit에서 transaction의 쓰기를 다른 쓰기로 만드는 읽은 뒤의 변경을 찾았다. 파일과 줄을 적는다. `DEADLOCK`과 달리 retry option이 있어도 재시도하지 않는다 |
| `CANCELED` | 문이 끝나기 전에 중단되었다. 취소, 시간 제한, 또는 SQLite `busy_timeout`이 끝날 때까지 다른 연결이 잠금을 놓지 않은 경우이며 재시도하지 않는다 |
| `READ_ONLY` | 쓰기가 읽기 전용 서버나 연결에 도달했다. replica, 읽기 전용 트랜잭션, 읽기 전용으로 열린 SQLite 데이터베이스가 해당한다. 쓰기는 primary 연결에서 실행한다 |
| `CONSTRAINT` | CHECK 제약이 행을 거부했다. 오류는 드라이버 메시지와 드라이버 오류를 유지한다 |
| `DRIVER` | `audit`이나 `immutable` trigger가 거부한 쓰기 같은 그 밖의 드라이버 오류. 오류는 드라이버 메시지와 원인인 드라이버 오류를 유지한다 |
| `CONNECTION_LOST` | 서버가 연결을 끝냈거나(세션 종료, 재시작, 유휴 한도) 연결이 끊겼다. statement는 이 오류를 반환하고 다시 전송되지 않는다([연결 끊김](../spec/config.ko.md#lost-connections)) |
| `ROLLBACK` | 서버가 session을 종료한 경우처럼 트랜잭션이나 savepoint의 callback이 실패하고 rollback도 실패했다. 오류는 두 오류를 유지하며 재시도하지 않는다 |
| `FAULT` | 클라이언트의 test entry point로 설정한 test fault가 rollback을 실행한 뒤 트랜잭션의 rollback을 실패로 보고했다. `ROLLBACK` 오류의 rollback 오류다([protocol §3.1](../spec/protocol.md#_3-1-test-faults)) |
| `CODEC_DECODE` | 저장 바이트가 선언된 컬럼 스타일과 다르다 |

---

## 12. 확인

```sh
make orm-test-servers                                        # MySQL, PostgreSQL, their replicas, ProxySQL, PgBouncer, and the seeded bench databases
. .runtime/servers/env                                   # the DSN variables of the tests
go test ./packages/go/... ./tests/... ./examples/...    # engine, generator, Go client, Go runners and examples
npm run typescript:test                                  # TypeScript client
(cd packages/rust && cargo test --workspace)              # Rust client
node tests/conformance/check/main.mts run --out "$(mktemp -d)/out" --dsn "$BENCH_MYSQL_DSN"   # five clients, identical results on MySQL
node tests/conformance/check/main.mts run --out "$(mktemp -d)/out" --driver postgres --dsn "$BENCH_POSTGRES_DSN"
```

예제: [`examples/thin-slice`](../../examples/thin-slice)(Go·PHP·Rust, 같은 JSON), [`examples/complex`](../../examples/complex)(조인·그룹·2단 관계·집계).

Rust 소스 분석은 실패 가능한 모델 setter의 결과와 모델을 구분한다. 오류 변환과 검사 후 추출은 모델을 유지하고 성공 값 변환은 다른 형식을 반환할 수 있다. Result 연산은 컬럼 메서드를 만들지 않으며 알려진 모델의 알 수 없는 호출은 계속 생성에 실패한다.
