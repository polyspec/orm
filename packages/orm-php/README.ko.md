<!-- doc-id: packages-orm-php-readme -->
<!-- source-sha256: 124ff78a8fcb31fd1e860249cd4a7d71674e2b2fb9073e7e47dceafb73615a18 -->
# orm — PHP 클라이언트

PHP 클라이언트: PDO(`pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`) 위의 생성 모델(`Polyspec\Orm\Tests\Model\Author`, …). 라이브러리가
SQL을 직접 조립한다. 문장 모양마다 dbspec 문서 묶음의 runtime model(docs/dbspec.md)로 검증하고, 한 번 계획하며,
크기가 제한된 process 내부 plan cache에 보관한다. 옆에서 실행되는 service나
extension은 없다. PHP 8.4 이상. Version 0.0.4. DSN의 scheme이 PDO driver를 고르므로
`composer.json`은 세 가지 중 어느 것도 require하지 않고 각각을 suggest한다. `scripts/php-without-mysql.sh`는
`.github/runner`의 Linux runner에서 SQLite로 `php -n`에 필요한 extension만 두고 client를 실행해,
공유 module인 `mysqlnd`, `pdo_mysql`, `mysqli`가 load되지 않게 한다.

## 배치
- `src/` — runtime이며 PSR-4 `Polyspec\Orm\`(`composer.json`)이다: 모델 문법(`Model.php`,
  `Chain.php`), 요청 검증(`Validator.php`), 계획(`Planner.php`), MySQL,
  PostgreSQL, SQLite의 SQL 형식(`Dialect.php`), 실행(`Db.php`). `RuntimeModel.php`는
  dbspec 문서(`Dbspec/`)에서 runtime model을 만들고, `Generator.php`는 그것을
  모델 class로 쓴다. `OrmGen.php`는 command line이다. `Dbspec/`는 또 문서 묶음의 문장을 render하고,
  database를 introspect하며, migration plan을 diff, apply, recover한다
  (docs/plans.md). `Code.php`는 `docs/errors.yaml`에서 `orm-gen errors --lang php`가 생성하므로
  고치지 않는다.
- `bin/orm-gen` — 모델 생성기이며 `vendor/bin/orm-gen`으로 설치된다.
- `gen/` — `schema/bench.dbs`의 생성 모델이고 namespace는 `Polyspec\Orm\Tests\Model`이다. 각 모델 class는
  runtime model의 자기 entity를 PHP 배열(`meta()`)로, 그리고 typed 컬럼 getter와
  setter를 가진다. 그 밖의 모든 method 이름(조건, join, relation, 컬럼, finder)은
  호출할 때 `docs/dsl.md`의 문법으로 해석된다. orm은 생성 namespace를 autoload하지 않는다.
  runtime은 `gen/bootstrap.php`를 한 번 require해야 한다. 그것이 모델을
  생성한 문서 묶음의 manifest text와 `manifestHash`로 등록하고,
  schema 값 `schema()`와 연결 helper `connect()`를 정의한다.
  한 process가 여러 문서 묶음의 생성 모델을 load할 수 있다. 각 모델 class는 자기 묶음의
  `manifestHash`를 가지며, manifest text의 hash가 선언한 `manifestHash`와 다른 bootstrap은
  어떤 문장보다 먼저 `SCHEMA_HASH_MISMATCH`로 실패한다.
- `tests/` — `model_test.php`(모델 통합 test), `runtime_model_test.php`와
  `runtime_db_test.php`(runtime model, 설치, audit), `schema_set_test.php`(한 process의 여러
  문서 묶음), `add_tables_and_columns_test.php`(설치한 묶음에 더하는 table과 컬럼),
  `mysql_tls.php`(DSN parameter와 MySQL TLS), `clock_test.php`, `driver_error_test.php`, `rollback_test.php`,
  `engine_test.php`, `hostcodec.php`, `dsn.php`,
  `relation_keys.php`, `perf_gate.php`, `orm_gen_test.php`(command line), 그리고 `Dbspec/`의 `dbspec_*`
  test. conformance runner는
  `tests/conformance/runner.php`다.

## 모델

styled 컬럼(`ordered_json`, `serialize`, `yaml`, `gz`, `base64` codec)은 생성된 setter와 getter에서 `Polyspec\Orm\StyledValue`를 쓴다. `StyledValue::sqlNull()`은 SQL NULL을, `StyledValue::value($value)`는 literal null을 포함한 encode된 값을 나타낸다. null을 허용하지 않는 컬럼은 setter를 호출할 때 SQL NULL을 `CODEC_ENCODE`로 거부한다. 선택에서 제외한 styled 컬럼을 요청하면 `COLUMN_UNSELECTED`를 돌려준다. `toArray()`와 `toJson()`은 선택한 styled 컬럼마다 `{"kind":"sql-null"}` 또는 `{"kind":"value","value":...}`를 출력한다. `toJson()`은 ordered JSON 값을 그대로 보존한다.

```sh
vendor/bin/orm-gen gen --out src/Model --namespace 'Example\Model' schema/example.dbs
```

schema가 바뀐 뒤 Composer script로 실행한다(`"scripts": {"orm-gen": "orm-gen gen --out
src/Model --namespace Example\\Model schema/example.dbs"}`). 인자는 묶음의 모든 문서를 나열한다.
생성기는 diagnostic이 있는 문서 묶음과 모델 method와 겹치는 컬럼 이름을 거부하고,
앞서 생성한 file을 바꿔 쓰며, `bootstrap.php`는 한 번 require해야 한다. `--check`를 주면 `gen`은 아무것도 쓰지 않고,
최신이 아닌 출력 file마다 `differs:`, `missing:`, `extra:`를 출력하며, 줄을 출력하면
상태 1로 끝난다.

## 연결

```php
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Config;

$db = \Polyspec\Orm\Tests\Model\connect('mysql://orm@db.internal/orm_example', new Config(
    aesKey: getenv('ORM_AES_KEY') ?: '',
    blindIndexKey: getenv('ORM_BLIND_INDEX_KEY') ?: '',
));

$rows = (new Author)($db)
    ->serviceSeq(7)->andIsClose(false)
    ->and(fn(Author $q) => $q->isDisplay(true)->or()->isAllday(true))
    ->orderBySeqDesc()->limit(0, 20)
    ->gets();
```

DSN scheme(`mysql://`, `postgres://`, `sqlite:///abs/path`)이 PDO driver를 고른다. 모든
연결은 datetime 값을 UTC로 읽고 쓴다: MySQL과 PostgreSQL session은 UTC를 쓰고, 바인드한
`\DateTimeInterface`는 UTC로 바뀌며, 읽은 datetime은 UTC의 `\DateTimeImmutable`이다.
`timezone` parameter는 `+00:00`과 `UTC`만 받고, 다른 zone은 `CONFIG` 오류다. MySQL은
`?socket=`, PostgreSQL은 `?host=`(socket directory)와 `?sslmode=`를 받는다.

연결은 그 연결에 등록한 문서 묶음만 계획한다(docs/protocol.md). 생성 모델의 연결 helper
`connect($dsn, $config)`는 `Orm::connectSchema`로 연결을 열고 그 묶음을 등록한다.
`utils()->schema()->register($schema)`는 열린 연결에 묶음을 등록하고, `utils()->schema()->install($schema)`는
설치하는 묶음을 등록한다. 등록은 database에서 아무것도 읽지 않으므로, 요청마다 연결을 여는 server는
쓰는 모든 묶음을 문장 없이 등록한다. `install`과 `addTablesAndColumns`는 database를 검증한다.
`Orm::connect`는 묶음 없이 연결을 연다. 모든 요청은 모델 class의 `manifestHash`를 담고, 묶음이 연결에
등록되어 있지 않은 요청은 다른 연결이 그 묶음을 설치했더라도 실행 전에
`SCHEMA_HASH_MISMATCH`로 실패한다.

`$db->subscribe(function (Polyspec\Orm\StatementEvent $e): void { … })`는 연결이 보내는 모든 문장의
subscriber를 등록하고, 그것을 제거하는 closure를 돌려준다([statement
event](../../docs/usage.ko.md#statement-events)). event는 `sql`, `binds`, `kind`, `tables`, 초 단위
`elapsed`, `transaction`(`?int`), `error`(`?OrmException`)를 가진다. secret bind는
`"$SECRET"`로, SQLite clock bind는 `"$NOW"`로 읽힌다. clock bind는 client의 wall clock이며 UTC이고
소수부 여섯 자리이며, 문장마다 한 번 읽는다. SQLite에서는 insert가 생략한 기본값 `now` 컬럼에도
바인드한다. subscriber가 던지면 그 작업은
`SUBSCRIBER`로 실패한다.

## 트랜잭션

```php
$db->transaction(function () use ($db): void {
    (new Author)->getBySeq(42)->setName('renamed')->update();
    $db->utils()->lock('author-42');
}, isolation: 'read_committed', readOnly: false, timeoutMs: 0, retry: 3);
```

`connect`가 없는 모델은 요청의 가장 안쪽 transaction을 쓴다. 같은 연결의 중첩 호출은 savepoint이며 `retry`만 받는다.
deadlock이나 `Orm::transactionConflict()`는 closure를 최대 `retry`번 다시 실행한다. row lock(`forUpdate()`와 다른 lock method)과
`utils()->lock()`, `setLocal()`, `local()`은 transaction을 요구한다.

`Config(auditSource: fn (): array => [...])`는 연결의 audit record 값, 예를 들어 계정과 요청을 준다.
`audit:`(컬럼 => 값)를 가진 transaction은 시작하기 전에 그것을 한 번 호출하고, 그 값과 이 값들로 audit record
table의 행 하나를 insert한다. 둘이 겹치면 transaction의 값이 이긴다. transaction 안의 audit 대상 쓰기는 모두 그 행을 가리킨다(docs/usage.md).

## Database
- PostgreSQL plan은 `$n` placeholder를 가진다. 문장은 `?` 형식에서 prepare한다. boolean은
  `PARAM_BOOL`로, binary 값은 `PARAM_LOB`로 바인드한다.
- SQLite는 정수를 `PARAM_INT`로, boolean을 0/1로 바인드한다. transaction 안의 row lock은
  `orm__row_lock` 행을 잡는다. 쓰기 transaction은 `BEGIN IMMEDIATE`로, 읽기 전용 transaction은
  `BEGIN`으로 시작한다. 연결은 `busy_timeout`까지 lock을 기다린다(docs/config.md).
- host 단계(aes, hex, ip)는 바인드 전과 fetch 후에 적용한다. `tests/codec/`가
  바이트 단위로 검사한다.
- `utils()->schema()->install($schema)`는 생성된 schema 값(`schema()`, `Polyspec\Orm\Schema`)을 받고,
  그 manifest text의 hash가 `manifestHash`와 다르면 `CONFIG`로 실패하며,
  dbspec 문서 묶음을 render하고(`Dbspec::render`), 문장을 한 transaction에서 적용하고
  묶음을 연결에 등록한다. 묶음의 모든 table이 있으면 아무것도 만들지 않고,
  일부만 있으면 `CONFIG` 오류다. 그다음 database의 묶음 table을
  묶음과 비교해 차이마다 이름을 밝혀 `CONFIG`로 실패한다. MySQL은 DDL 문장마다 스스로 commit하므로
  문장을 transaction 밖에서 실행하고, transaction 안의 `install`은 `CONFIG` 오류다.
- `utils()->schema()->addTablesAndColumns($schema)`는 생성된
  schema 값으로 설치한 묶음을 올린다: database에 없는 table을 만들고, 있는 table에서 null을 허용하거나 기본값이 있는 빠진 컬럼을
  더하고 빠진 index를 만들며, 이는 dialect의 plan 단계
  (`Dbspec::addTablesAndColumnsSteps`)로 한다. 그 단계는 table마다 index, foreign key,
  check, trigger와 함께 만들고 바뀐 table의 audit trigger를 바꾸며, 만든
  table은 `table`로, 더한 컬럼은 `table.column`으로, 만든 index는
  `table.index`로 돌려준다. 그 밖의 모든 차이, 빠진 unique key도, 변경 전에
  `SCHEMA_DIFFERS` 오류다(docs/schema.md "Adding tables and columns"). MySQL과
  SQLite는 transaction 밖에서 더한다.

## 오류
`Polyspec\Orm\OrmException::$code_`는 `Polyspec\Orm\Code::*` 중 하나다. driver 오류는 driver마다 `DEADLOCK`
(MySQL 1213 / SQLSTATE 40001, PostgreSQL 40P01 / 40001, SQLite locked), `DUPLICATE_KEY`, `CANCELED`
(MySQL 1317 / 3024, PostgreSQL 57014, SQLite 9: `statementTimeoutMs`를 넘은 문장처럼 끝나기 전에 멈춘 문장.
SQLite busy: `busy_timeout`이 끝났을 때 다른 연결이 lock을 잡고 있었다), `FOREIGN_KEY`, `CONSTRAINT`(CHECK 위반), `READ_ONLY`,
`LOCK_NOT_AVAILABLE`로 대응하고, 그 밖의 모든 driver 오류, 예를 들어 trigger가 거부한 쓰기는 `DRIVER`다.
각각은 driver message와 driver 오류를 previous exception으로 가진다. callback이 실패하고 rollback도 실패한 transaction이나
savepoint는 message `transaction failed (<cause>) and rollback failed (<rollback error>)`로 `ROLLBACK`을 던진다. 그 previous exception은
원인이고 `$rollback`은 rollback 오류다. `ROLLBACK` 오류는 다시 시도하지 않는다.

## Test

    ORM_TEST_MYSQL_DSN='mysql://root@localhost/orm_php_test?socket=/tmp/mysql.sock' \
      ORM_TEST_POSTGRES_DSN='postgres:///orm_php_test?host=/tmp' \
      php packages/orm-php/tests/model_test.php
    php packages/orm-php/tests/runtime_model_test.php
    php packages/orm-php/tests/engine_test.php
    php packages/orm-php/tests/hostcodec.php
    php packages/orm-php/tests/dsn.php
    php packages/orm-php/tests/relation_keys.php
    php packages/orm-php/tests/orm_gen_test.php
    go run ./tests/conformance/check run -langs php -driver mysql|postgres|sqlite -dsn <bench DSN>

`model_test.php`는 SQLite, MySQL, PostgreSQL에서 실행되고 MySQL이나 PostgreSQL DSN이 없으면 실패한다. schema를 설치하거나
`utils()->schema()->empty()`를 검사하는 case는 DSN의 server에 자기 database(또는 새 SQLite file)를 만들고 끝나면, 실패 뒤에도,
지운다(tests/case_database.php). 그래서 DSN이 가리키는 database는 비어 있을 필요가 없고 test의
table을 남기지 않는다. `runtime_db_test.php`는 같은 DSN을 받는다. `perf_gate.php`는 시드된 bench database에서 client를 PDO와 비교한다.
