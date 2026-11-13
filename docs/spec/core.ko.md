<!-- doc-id: core -->
<!-- source-sha256: e52bd792f29ddbdcad770cb5f38799794281a2cbdaa7a1447fbd287921158367 -->
# Rust 코어와 생성 바인딩

`packages/rust`의 crate `polyspec-orm`이 orm 규칙의 유일한 구현이고, PHP·Python·Node·Go 바인딩은 그 인터페이스 계약
`packages/rust/interface.json`에서 생성한다. 이 문서는 `legacy/packages/go`, `legacy/packages/php`, `legacy/packages/php-ext`,
`legacy/packages/python`, `legacy/packages/ts`의 언어 구현이 따르는 규칙과 다른 코어의 규칙을 적는다.

## 공존

- **CORE-1** 언어 구현이 자기 변경으로 없어질 때까지 레포는 그 구현을 릴리스의 API로, 코어를 계약의 API로 함께 둔다.
  이 문서의 규칙은 코어와 바인딩에 적용된다. 규칙마다 대체하는 규칙을 적으며, 대체된 규칙은 언어 구현이 없어질 때까지
  그 구현에 계속 적용된다. 언어 구현의 시험은 코어를 위해 바꾸지 않고, 코어의 시험은 언어 구현에 실행하지 않는다. 언어
  구현은 `legacy/packages/`에 있고 어느 릴리스에도 들어가지 않으며, 그 시험은 이 문서의 규칙이 공유 case·fixture·vector를
  바꾸기 전의 고정 사본인 `legacy/contracts/fixtures/`와 `legacy/tests/`를 읽는다.
- **CORE-2** 이 문서의 규칙이 기대값을 바꾸는 공유 recipe case는 코어에서 `contracts/fixtures/core/`의 case가
  `supersedes`로 그 case를 가리켜 대체한다. Rust recipe 실행기는 대체된 case 대신 대체하는 case를 실행하고, 기대값 밖의
  step이 서로 같은지 확인한다.
- **CORE-3** 오류를 기대하는 공유 recipe case와 공유 vector는 그 kind를 코어가 쓰는 대로 소문자로(`no_rows`), 기대
  메시지는 `<kind>: <text>`로 적고, Rust 실행기는 둘을 그대로 비교한다. 실행기 자신이 알리는 case의 언어 코드 실패는 kind가
  아닌 실행기의 코드(`callback`, `step`, `subscriber`)를 가진다. 언어 구현은 카탈로그 코드를 대문자로 유지하고 CORE-1의
  고정 사본을 읽는다.

## 오류

- **CORE-10** 코어의 오류는 닫힌 enum `polyspec_orm::Kind`의 kind 하나를 가진다. kind와 category와 뜻은
  [errors](errors.md)의 표다. kind는 카탈로그 코드의 소문자 snake 형태다(`NO_ROWS`는 `no_rows`). 코어에서는 INT-65와
  INT-89를 대체한다: 바인딩은 kind를 계약의 enum `ErrorKind`로, 모든 오류를 그 category의 클래스(CORE-11)로 내고, 어느
  구현도 자기 상수 목록을 두지 않는다.
- **CORE-11** 오류의 클래스는 모든 바인딩에서 그 category의 클래스 `Orm<Category>Error`(`OrmValueError`,
  `OrmTypeError`, `OrmStoreError`, `OrmBusyError`, `OrmInternalError`)이며 kind를 `kind`로 가진다. kind별 클래스는
  두지 않는다. kind 묶음을 잡는 규칙이 없기 때문이다.
- **CORE-12** 오류 메시지는 `<kind>: <text>`이고 text는 INT-163과 INT-187을 따른다.
- **CORE-13** 드라이버 오류는 INT-89와 DIA-201이 그 코드에 주는 kind나 `driver`를 가지며 드라이버 오류를 원인으로 담는다.
  markdown 서버는 오류 코드를 답한다(PRT-71). 코어의 kind가 아닌 코드는 kind `driver`이며 메시지가 서버가 보낸 코드를
  적는다.
- **CORE-14** 네 kind는 카탈로그 코드가 없다. 언어 구현은 그 실패를 `CONFIG`로 내기 때문이다: `busy`(CORE-22),
  `transaction_ended`(CORE-23), `closed`(CORE-31), `pool_timeout`(CORE-30). `rollback_failed`는 `ROLLBACK`을
  대체한다(CORE-25). 코드 `SUBSCRIBER`(CORE-28), `GENERATOR_SCAN_PARSE`, `GENERATOR_SCAN_UNATTACHED`(CORE-50)는 코어의
  kind가 아니다.

## 트랜잭션

- **CORE-20** `Db::transaction(callback, options)`은 pool 연결 하나에서 새 트랜잭션으로 `callback`을 실행하고 트랜잭션
  handle `Tx`를 넘긴다. options는 `isolation`, `read_only`, `timeout_ms`, `retry`(기본 `3`), `audit`이며 뜻은 INT-40~
  INT-44다. handle이 트랜잭션에 들어가는 유일한 길이다: 모델은 `connect(&tx)` 뒤에 그 안에서 실행되고, 트랜잭션의 문장
  실행기는 `Tx::run`이다. 실행 흐름의 활성 트랜잭션은 없다: INT-45, INT-161, DSL-10의 첫 문장을 대체한다. 연결이 없는
  모델은 `config`로 실패한다. callback 안의 `Db::transaction`은 pool의 다른 연결에서 독립된 트랜잭션을 연다. 그 트랜잭션이
  바깥 트랜잭션이 잡은 행 잠금을 기다리면 대기 한도에서 `canceled`나 `deadlock`으로 끝난다.
- **CORE-21** `Tx::savepoint(callback)`은 트랜잭션의 savepoint에서 `callback`을 실행하고 savepoint의 handle(`Tx`)을
  넘긴다. options는 받지 않는다. callback이 실패하면 `ROLLBACK TO SAVEPOINT`와 `RELEASE SAVEPOINT`를 보내고 실패를 그대로
  돌려준다. 그중 하나도 실패하면 결과는 `rollback_failed`(CORE-25)다. callback이 성공한 뒤의 release 실패는 그 실패다.
  INT-155는 유지한다. INT-46의 중첩을 대체하므로, `retry`를 받던 중첩 트랜잭션이 그것을 버리는 일은 없다: options를 받지
  않는다.
- **CORE-22** 한 트랜잭션은 한 번에 문장 하나를 실행한다. 같은 트랜잭션의 다른 문장이 끝나지 않았을 때 `Tx`를 거쳐
  오는 문장(`run`, 트랜잭션의 utils 연산, 그에 연결된 모델의 terminal)은 `busy`로 실패하고 아무것도 보내지 않는다.
  savepoint callback이 실행 중이면 부모 handle을 거친 모든 문장은 `busy`다. 판정은 트랜잭션 상태의 원자적 변경 하나이며,
  코어는 언어 코드를 부르는 동안 잠금 guard를 쥐지 않는다. INT-47과 DSL-122의 `CONFIG`를 대체한다.
- **CORE-23** callback이 돌아온 뒤의 `Tx`와 그에 연결된 모든 모델은 모든 문장을 `transaction_ended`로 실패하고 아무것도
  보내지 않는다. INT-150a를 대체한다.
- **CORE-24** 트랜잭션은 실패의 kind가 `deadlock`이면 롤백 뒤 callback 전체를 다시 실행한다: 문장의 deadlock,
  `transaction_conflict`(INT-48)의 오류, callback이 던진 kind `deadlock`의 오류가 해당한다. 바인딩은 callback이 던진 orm
  category 클래스 오류의 kind를 코어에 넘기고(계약의 `recognize`), 그 밖의 실패는 롤백 뒤 그대로 돌려준다. 시도 `n`(1부터)
  전의 기다림은 `50 << (n - 1)` 밀리초에 0~19 밀리초의 jitter를 더한 것이다. 시험은 코어에 시계와 jitter의 근원을 주므로
  결과가 그 둘에 기대지 않는다.
- **CORE-25** callback이 실패하고 롤백도 실패하면 결과는 kind `rollback_failed`의 오류이고, 메시지는 롤백의 실패를 적으며,
  property 둘을 가진다: `callbackError`는 callback의 실패 그대로(orm 오류이거나 언어 예외이며 코어가 열어 보지 않는다),
  `rollbackError`는 롤백의 오류다. callback만 실패하면 그 실패를 감싸지 않고 그대로 돌려준다. INT-46과 INT-72의
  `ROLLBACK`을 대체한다.
- **CORE-26** 코어 안의 panic(Rust callback의 panic 포함)은 트랜잭션을 롤백하고 오류 `internal`이 된다. 다시 일으키지
  않는다. INT-72의 Rust 문장을 대체한다. Go의 panic·`runtime.Goexit`과 PHP·Python·Node의 예외는 코어 밖에서 일어난다:
  바인딩이 callback이 버려졌다고 코어에 알리면 코어가 롤백하고, 언어는 그것을 계속한다.
- **CORE-27** 코어는 문장의 작업 밖에서 언어 코드를 부른다. callback을 부르는 member는 I/O 없는 상태기계이며 `Io`(기다릴
  작업), `Call`(인자와 함께 부를 callback), `Done`(결과)을 낸다. 바인딩은 `Io`를 member의 `wait`대로 기다리고 `Call`을
  호출 스레드에서 부른 뒤 결과를 넣는다. 그래서 블로킹 런타임이 코어 안에서 코어를 블로킹하는 일이 없다.
- **CORE-28** 문장 사건 subscriber가 던진 예외는 그대로 돌아간다. 그 문장은 실행되었고, 끝나지 않은 트랜잭션의 쓰기는
  함께 롤백된다. INT-96의 `SUBSCRIBER`는 코어의 kind가 아니다.

## 연결

- **CORE-30** 설정은 pool 연결 대기의 한도 `pool_acquire_timeout_ms`를 받으며, 없으면 `30000`이다. 한도를 넘는 대기는
  `pool_timeout`으로 실패하므로 바닥난 pool의 문장도 호출자에게 돌아간다.
- **CORE-31** `Db::close`는 진행 중인 호출을 끝까지 두고, 그 뒤 같은 pool의 모든 handle 호출을 `closed`로 실패시킨다. 두
  번째 `close`는 성공한다.
- **CORE-32** `Db`는 동시 호출을 받는다. 문장은 pool 연결 하나를 빌리고 그 결과는 다른 호출과 무관하다. 트랜잭션 번호는
  `BEGIN`을 보낼 때 센다.

## 취소

- **CORE-40** 코어의 취소 규칙은 하나다. 취소된 문장은 `canceled`로 끝나고, 트랜잭션의 롤백은 취소하지 않는다(CFG-9).
- **CORE-41** PHP `Cancellation`은 다른 프로세스와 공유하는 상태 파일에 상태를 둔다. 그 디렉터리는 필수 인자다. 상태
  파일은 정리가 읽지 않는 임시 이름으로 `O_CREAT | O_EXCL | O_CLOEXEC`, mode `0600`으로 만들고, 주인이 `flock(LOCK_SH)`를
  얻은 뒤에야 상태 파일 이름으로 rename한다. 그래서 정리가 보는 상태 파일은 늘 주인이 잠근 것이다. 주인은 파일의 수명
  동안 잠금을 쥐고, 소멸할 때 파일을 지운다.
- **CORE-42** `Cancellation`을 만들 때 그 디렉터리의 상태 파일 중 `flock(LOCK_EX | LOCK_NB)`가 성공하는 것을 모두 지운다.
  주인이 없기 때문이다. 잠금이 `EWOULDBLOCK`으로 실패한 파일은 주인이 있으므로 둔다. 그 밖의 실패는 오류다.
- **CORE-43** 상태 파일은 표시 바이트(`0` 취소 안 됨, `1` 취소됨)와 그 뒤 진행 중인 문장마다 레코드 하나를 담는다:
  데이터베이스와 서버에서 그 문장을 끝내는 정보(MySQL connection id, PostgreSQL backend pid와 secret key). 문장은 시작할
  때 레코드를 쓰고 끝날 때 지운다. `cancel()`은 표시를 쓰고 기록된 모든 문장을 자기 프로세스의 제어 연결로 끝낸다.
- **CORE-44** 한 PHP 프로세스 안에서는 진행 중인 문장을 취소할 수 없다: 문장이 실행되는 동안 언어 코드는 실행되지
  않는다(CORE-27). 같은 프로세스의 `cancel()`은 그 handle의 다음 문장을 `canceled`로 실패시킨다.

- **CORE-45** `Db::with_cancel(cancel)`은 취소 `cancel`을 가진 같은 pool의 handle을 돌려준다. 호출된 handle의 어떤
  것도 바꾸지 않는다. 그 handle에 연결된 모델, 그 handle이 시작한 트랜잭션, 그 트랜잭션의 `Tx`는 같은 취소를 가진다.
  코어에서는 이것이 CFG-9의 네 이름(`WithContext`, `withSignal`, `with_future`, `withCancellation`)을 대신한다.
- **CORE-46** 취소가 발화한 handle의 문장은 보내기 전에 `canceled`로 실패하고, 트랜잭션의 `BEGIN`과 savepoint의
  `SAVEPOINT`도 그렇다. 그런 문장은 statement event를 내지 않고, 그 트랜잭션이나 savepoint의 callback은 실행되지 않는다.
  메시지는 `the cancellation of the handle has fired`다. `COMMIT`,
  `ROLLBACK`, `ROLLBACK TO SAVEPOINT`, `RELEASE SAVEPOINT`는 취소와 관계없이 보내므로 취소된 트랜잭션도 끝난다(CFG-9).
- **CORE-47** 취소가 발화할 때 진행 중인 문장은 그 서버에서 끝나고 `canceled`로 실패한다: MySQL과 MariaDB는 같은 DSN의
  제어 연결에서 `KILL QUERY <connection id>`로 끝내고 그 뒤 문장의 연결은 pool로 돌려주지 않고 닫는다. PostgreSQL은
  protocol의 CancelRequest로, SQLite는 문장을 interrupt하는 progress handler로, markdown 연결은 연결을 닫아서
  끝낸다(PRT-71). 구현되지 않았다: 그런 문장은 끝까지 실행되어 자기 결과를 돌려준다.

## 코드 생성

- **CORE-50** dbspec 집합의 엔티티 코드는 코어 함수 하나 `generate(set, language, options)`가 manifest만 읽어 PHP,
  Python, TypeScript, Go, Rust로 만든다. 엔티티 class는 계약의 일반 `Query`를 감싸고, 열마다 타입이 있는 getter와 setter,
  열·연결어·그 열이 허용하는 연산자마다 조건 member 하나를 가지며, 계약의 member만 부른다. 이름은 bindgen crate
  `polyspec-bindgen-core`의 변환(N-2)이므로 바인딩의 이름과 같다. 소스를 스캔하지 않는다: DSL-39~DSL-44를 대체하며
  스캔의 kind는 없어진다. 여러 열 chain은 일반 member `getsBy(chain, args)`나 열 하나짜리 member의 chain으로 쓴다.
- **CORE-51** 생성한 모든 파일의 첫 줄은 그것을 생성한 orm 판을 적는다.

## 값

- **CORE-60** 열 값은 `orm_value`로 코어를 나간다: 64비트 열(`i64`와 MySQL 부호 없는 열)의 정수는 `int64`(Node
  `bigint`), 더 좁은 열의 정수는 크기와 관계없이 `int`(Node `number`), JSON 열은 `json_value`의 값, 날짜·시각·날짜시각은
  DBS-112와 DBS-121의 정규 텍스트, decimal은 정확한 텍스트다.
- **CORE-62** `orm_value`는 코어의 값 타입 `polyspec_orm::OrmValue`이고, 계약은 그것을 값 alias `orm_value`로 선언한다.
  그 kind는 `null`, `bool`, `int`, `int64`, `float`, `text`, `bytes`, `list`, 텍스트 key의 `map`, `nested:json_value`다.
  열 값의 kind는 값이 아니라 열의 타입이 정한다: `i16`과 `i32`는 `int`, `i64`는 `int64`, `f64`는 `float`, `bool`은
  `bool`, `bytes`는 `bytes`이고, `decimal`, `varchar`, `text`, `uuid`, `date`, `time`, `datetime`은 `text`이며
  `datetime(p)`는 소수 자리가 정확히 p개다(PRT-69). SQL NULL은 `null`이다. stage `json` 뒤의 열은
  `nested:json_value`다(CORE-61). 다른 style stage 뒤의 열은 공통 값 모델의 값이며 kind는 `null`, `bool`, `int64`,
  `float`, `text`, `list`, `map`이다: 소수부와 지수가 없고 `i64`에 들어가는 수는 `int64`, `i64`나 유한한 `f64`에
  들어가는 그 밖의 수는 `float`이고, 어느 쪽에도 들어가지 않는 수는 `codec_decode`다.
- **CORE-63** 언어의 값은 함수 `from_host` 하나로 코어에 들어오며, 이 함수는 값만 읽는다: null은 `null`, boolean은
  `bool`, 정수는 `int64`, float는 `float`, 텍스트는 `text`, bytes는 `bytes`, list는 `list`, map은 `map`이다. 수 타입이
  하나인 언어의 수는 소수부가 없고 -(2^53 - 1)부터 2^53 - 1까지의 범위에 있으면 `int`이고 그렇지 않으면 `float`다.
  텍스트가 byte인 언어의 텍스트는 그 byte가 UTF-8이면 `text`이고 아니면 `bytes`다. key가 순서대로 0부터 n-1인 PHP
  배열은 `list`이고 그 밖의 PHP 배열은 `map`이며, 그 정수 key는 그 정수의 텍스트다. 다른 map의 key는 텍스트다. 열이
  무엇을 받는지는 값을 bind하는 곳에서 열의 타입이 정하므로(PRT-32a) `int`와 `int64`는 똑같이 bind된다. 이 가운데
  어느 것도 아닌 값은 `codec_encode`이고 메시지는 `the value is no value of a column: <what>`이며 값을 적지 않는다:
  `i64` 밖의 정수, 유한하지 않은 float, Unicode scalar 값의 열이 아닌 텍스트, 텍스트가 아닌 map key, 256단계보다 깊이
  중첩된 list나 map, 그리고 언어의 undefined 값, 날짜, 함수, 객체다. 구현되지 않았다: 들어오는 `json_value`의 값.
  alias에는 다른 라이브러리의 값을 위한 `in` 행이 없으므로 그런 값은 객체이고 거부된다.
- **CORE-64** 값은 함수 `to_host` 하나로 코어를 나가며, 이 함수는 값을 한 단계씩 기술한다. `nested:json_value`의 값은
  `json_value`의 `out` 표의 kind로 기술한다: `null`, `bool`, 수 텍스트를 가진 `number`, `text`, `list`, member 순서의
  `map`이다. 짝 없는 surrogate를 가진 JSON 문자열에는 `text`가 없으므로, 그런 문자열을 가진 JSON 값은 그 열의 값을
  읽을 때 `codec_decode`이고 메시지는 `the JSON value holds a string that is no sequence of Unicode scalar values`다.
- **CORE-61** JSON 값을 member 순서·숫자 텍스트·빈 container와 함께 저장하는 codec stage(COD-9, COD-16)는 코어에서
  `json`이다. 언어 구현은 그것을 쓰던 라이브러리 이름을 따라 `ordered_json`이라 부르지만 코어는 그 이름의 라이브러리에
  의존하지 않으므로(CORE-1), 코어의 dbspec 문서는 `json`을 쓴다. 코어는 `ordered_json`을 같은 encoding의 stage
  `json`으로 읽으므로, 언어 구현이 읽는 문서를 코어도 읽고, 그 canonical form은 `json`을 쓴다. 그런 값의
  공유 case 값 wrapper는 코어를 나가는 값(CORE-60)과 같이 `json_value`이고(FCV-4), 그 stage를 시험하는 case의 id도
  `json`으로 그것을 부른다. CORE-1의 고정 사본은 언어 구현을 위해 옛 이름을 지킨다.

## 일반 질의

- **CORE-80** `Schema::load(manifest_text, external_text, manifest_hash)`는 INT-133의 schema 값을 실행 시에 만든다.
  manifest가 아닌 텍스트는 `schema_invalid`이고 `manifest_hash`로 hash되지 않는 텍스트는 `schema_hash_mismatch`이며,
  둘 다 어떤 연결보다 앞선다. 불러온 schema는 자기 텍스트와 runtime model을 소유하고, 그것을 가리키는 값들이 그것을
  공유한다: schema 값과 그 사본, 그 schema의 `Query`와 그 `Query`의 행, 그런 `Query`의 요청, 그리고 그 schema가
  등록된 연결(그 연결이 놓일 때까지)이다. 그 가운데 마지막이 놓이면 schema의 메모리가 돌아오며, 프로세스는 불러온
  schema를 두지 않는다. 생성된 코드의 schema는 그 코드의 static이고 세지 않는다.
- **CORE-81** `Query`는 이름으로 고른 엔티티 하나의 질의이자 행 상태다: `Query::new(schema, entity)`. schema에 없는
  엔티티는 `entity_unknown`이다. `Query`는 `connect(connection)` 뒤에 실행되고 그 연결은 `Db`나 `Tx`다(CORE-20).
  연결이 없는 `Query`의 terminal은 `config`다. `Query`의 엔티티 descriptor는 그 `Query`와 그 사본, 그 행이 공유하고 그 가운데
  마지막과 함께 놓인다(CORE-80).
- **CORE-82** `where(chain, values)`는 DSL-36과 DSL-37의 chain 이름(예: `GtServiceSeqAndIsClose`)의 조건을 key마다 값
  하나로 더한다. 값은 `orm_value`다(CORE-62): `null`은 조건의 null이고, `list`는 연산자가 없거나 `Ne`인 key의 값
  목록, 값이 둘일 때 `Between` key의 쌍, tuple key의 값 묶음 목록이며, `map`과 `nested:json_value`를 뺀 다른 kind는 값
  하나다. `map`, `nested:json_value`, 값 목록 안의 list, 길이가 다른 `Between` list는 다음 terminal에서
  `codec_encode`이고 메시지는 `the value of a condition is <what>`이다. `And`나 `Or`로 시작하는 이름은 첫 조건을 그 연결어로 앞선 조건에 잇는다. 이름은 crate
  `polyspec-orm-schema`의 `parse_chain`이 읽으며, 생성된 모델의 chain 이름도 읽는 하나뿐인 함수다. 엔티티의 chain이
  아닌 이름, 열이 허용하지 않는 연산자, key 수와 다른 값의 수는 `config`이고, 생성된 모델의 builder 오류처럼 다음
  terminal이 돌려준다. `order_by(spec)`는 `SeqDescAndLabelAsc` 같은 이름의 순서를 더하며 key마다 열과 `Asc`나
  `Desc`이고, 같은 crate의 `parse_order`가 읽는다.
- **CORE-83** terminal `get`, `gets`, `get_count`, `get_query`는 생성된 모델의 terminal처럼 질의를 실행하고,
  `get_by(chain, values)`, `gets_by(chain, values)`, `get_count_by(chain, values)`는 그 chain의 조건을 `and`로 이어
  실행한다. 어떤 terminal도 질의를 바꾸지 않는다(DSL-69). 행은 같은 엔티티의 `Query`이고 `gets`는 행을
  `Collection`으로 돌려준다. `value(column)`은 행의 열 값을 `orm_value`로 돌려준다(CORE-62). 엔티티의 열이 아닌 이름은 `column_unknown`이고
  행이 읽지 않은 열은 `column_unselected`다.
- **CORE-84** 구현되지 않았다: `Query`의 `creates`, `save`, `restore`, `restoreOrCreate`, `join`, `leftJoin`, 묶음
  (`andGroup`, `orGroup`, `not`, `andNot`, `orNot`, `on`), `andModel`, `orModel`, `compare`, `getsCount`, `getsPage`,
  `getsLookaheadPage`, `getSum`, `getAvg`, `toArray`, 함수나 subquery의 추가 열(DSL-73, DSL-74). 열이나 값의 함수에 대한
  조건(DSL-54)도 구현되지 않았다. `where`가 그것을 `orm_value`로 받을 수 없기 때문이다.
- **CORE-85** `limit(offset, count)`는 순서의 처음 `offset`개 행 뒤에서 최대 `count`개 행을 읽는다(DSL-99). 둘 다
  `uint`여서 음수 값은 형식이 없다. `count`가 0이면 다음 terminal에서 `config`이고 메시지는 `limit requires a
  non-negative offset and a positive count`다. limit을 가진 `Query`를 `relation`이나 `relations`에 주면
  `limit_in_relation`이다(DSL-79).
- **CORE-86** `Query`의 행 lock은 `for_update`, `for_share`, `for_update_no_wait`, `for_share_no_wait`이며, 언어 구현의
  member `forUpdate`, `forShare`, `forUpdateNoWait`, `forShareNoWait`이다(DSL-123). 각각 요청의 lock `update`, `share`,
  `update_nowait`, `share_nowait`을 정하고, 마지막에 부른 것이 남는다. lock은 root `Query`나 `relation`·`relations`에
  준 `Query`의 `get`과 `gets`에 걸리며, 그 경우 그 `Query`의 statement가 lock을 잡는다(PRT-8). lock을 가진
  `get_count`는 `ir_invalid`다. transaction 밖의 lock은 모든 database에서 `config`이고 메시지는 `row locks are allowed
  only inside a transaction`이다. lock 절이 없는 SQLite는 transaction 안에서 lock을 잡는다(INT-49).
- **CORE-87** `Query`의 행이 읽는 열(PRT-9): `add_all_columns`는 모든 열을 읽고, `remove_all_columns`는 primary key와
  foreign key의 열만 남기며, `add_column(column)`은 열 하나를 더하고 `remove_column(column)`은 열 하나를 뺀다(DSL-72,
  DSL-75~DSL-77). 열은 `value`처럼 dbspec 문서의 이름으로 부른다. 엔티티의 열이 아닌 이름은 다음 terminal에서
  `config`이고 메시지는 `<column> is not a column of <entity>`다. 행이 읽지 않은 열의 `value`는
  `column_unselected`다(CORE-83).
- **CORE-88** `match_pair(pair)`는 relation key의 구성 요소 하나를 더한다. 이름은 `<Left>With<Right>`이고, `Left`는
  schema의 어느 엔티티(부모)의 열이며 `Right`는 `Query` 엔티티의 열이고, `polyspec-orm-schema`의 `split_pair`가
  읽는다(DSL-82). `alias(name)`은 결과의 이름을 정한다(DSL-83). 그것이 없으면 결과는 `<entity>_model`이나
  `<entity>_models`이고, alias의 이름은 그 snake case다. `relation(child)`는 `child`의 별도 질의가 읽은 행 하나를 각
  행에 붙이고 `relations(child)`는 그 행들을 붙인다(DSL-79~DSL-81). `match_pair`가 없는 `child`는 `config`이고 메시지는
  `relation child <entity> requires match_<l>_with_<r>()`이다. `child`는 자기 lock을 가질 수 있다(CORE-86).
  `related(name)`은 행의 `relation` 결과의 행을, `related_rows(name)`은 `relations` 결과의 행들을 돌려준다. 결과
  `name`이 없는 행은 `None`을 돌려주고, 다른 형식의 결과는 `internal`이다.
- **CORE-89** `key_name(column)`은 `gets`의 `Collection`과 그 `Query`의 `relations` 결과의 행을 primary key 대신 열
  `column`으로 key한다(DSL-70). 엔티티의 열이 아닌 이름은 다음 terminal에서 `config`이고 메시지는 `<column> is not a
  column of <entity>`다.
- **CORE-90** `where_in(chain, query)`는 chain 이름 `chain`의 열(연산자가 없거나 `Ne`인 key 하나)이 열 하나를 읽는
  subquery `query`의 행 안에 있다는, `Ne`이면 없다는 조건을 더한다(DSL-53). key 수나 연산자가 다른 chain은 다음
  terminal에서 `config`이고 메시지는 `where_in takes a chain of one key with no operator or with Ne`다. subquery는 limit,
  relation, lock, 그 열 하나 밖의 열을 받지 않으며, 그 밖의 것은 `ir_invalid`이고 메시지는 `subquery may not use limit,
  relations, lock or columns`다.
- **CORE-91** `Query`의 쓰기는 생성된 모델의 쓰기와 같다(DSL-100, DSL-103, DSL-106, DSL-108, DSL-110):
  `set(column, value)`는 다음 쓰기를 위해 열에 `orm_value`를 배정하고, `create`는 배정한 행을 넣고 만든 행을 돌려주며,
  `update`는 배정한 값을 행에 쓰고, `delete`는 행을 지우며, `expect_revision(column, revision)`은 다음 `update`나
  `delete`가 정수 열이 `revision`을 가지고 있는 동안에만 쓰게 한다. `update`와 `delete`의 행은 `Query`가 읽은 행이고,
  행을 읽지 않은 `Query`에서는 `set`이 배정한 primary key의 행이다. 둘 다 없으면 쓰기는 `config`이고 메시지는 `<entity>
  requires a loaded row or a set primary key <column>`이다. 엔티티의 열이 아닌 이름은 `config`이고 메시지는 `<column> is
  not a column of <entity>`이며, 열이 받을 수 없는 값은 `codec_encode`다(CORE-62). 쓰기는 `duplicate_key` 같은 그
  원인의 kind로 실패한다(CORE-10).
- **CORE-92** `Db` step은 다른 library의 코어가 데이터로 가진 질의이고, host는 자기 판단 없이 그것을 orm으로 실행한다:
  `StepRunner::new(schema, connection)`는 그 step을 `connection`에서 실행하고, `run(step)`은 step 하나를 JSON 텍스트로
  받아 그 결과를 JSON 텍스트로 돌려준다. 질의 step은 `{"kind": "query", "query": <query>, "terminal": <terminal>}`이다.
  `<query>`는 `{"entity": <name>, "calls": [<call>, ...]}`이고, call은 각각 `Query`의 member와 그 인자이며 call의
  순서대로 실행된다(`{"call": "where", "chain": .., "values": [..]}`, `chain`과 `query`를 가진 `where_in`, `spec`을 가진
  `order_by`, `offset`과 `count`를 가진 `limit`, lock 넷, `add_all_columns`, `remove_all_columns`, `column`을 가진
  `add_column`, `remove_column`, `key_name`, `pair`를 가진 `match_pair`, `name`을 가진 `alias`, `query`를 가진
  `relation`과 `relations`, `column`과 `value`를 가진 `set`, `column`과 `revision`을 가진 `expect_revision`).
  `<terminal>`은 `get`, `gets`, `get_count`, `create`, `update`, `delete` 가운데 하나다. 값은 `orm_value`의 case
  형식이다(CORE-71): `{"kind": <kind>, "value": ..}`이고, bytes는 `{"hex": ..}`, JSON 값은 `{"kind": "json_value",
  "text": <JSON text>}`다. 결과는 `{"ok": <result>}`이거나, CORE-10의 kind(예: `duplicate_key`)를 가진 `{"error":
  {"kind": <kind>, "message": <message>}}`이므로, 부탁한 코어가 실패의 뜻을 정한다. `get`과 `create`의 result는
  `{"row": <row>}`이고 행이 없으면 `null`이며, `gets`의 result는 collection의 순서와 그 key(CORE-89)를 가진 `{"rows":
  [{"key": <key>, "row": <row>}, ...]}`, `get_count`의 result는 `{"count": <n>}`, `update`, `delete`, CORE-93의 step의
  result는 `{}`다. 행은 그 행이 읽은 열을 가진 `{"values": {<column>: <value>}, "related": {<name>: <row> | null |
  [<row>, ...]}}`이다. step이 아닌 텍스트는 `config`다.
- **CORE-93** transaction step `{"kind": "transaction", "options": {..}}`는 뒤따르는 step을 callback이 실행하는
  transaction을 열고(CORE-20), savepoint step `{"kind": "savepoint"}`는 가장 안쪽 것의 savepoint를 열며 그 callback이
  뒤따르는 step을 실행한다(CORE-21). step `{"kind": "end", "rollback": <bool>}`은 가장 안쪽 것의 callback을 끝내며,
  `rollback`이 false이면 commit하거나 release하고 true이면 rollback한다. 그 결과는 그 끝의 결과다(예: commit의
  `deadlock`). option은 `isolation`, `read_only`, `timeout_ms`, 그리고 CORE-20의 audit 값의 map인 `audit`이다. step의
  transaction은 `retry` 0으로 실행된다. 부탁한 코어가 `deadlock`에서 그것을 다시 실행하기 때문이다. 열린
  transaction이 없을 때의 savepoint나 end는 `config`이고, `StepRunner::close`는 열린 것을 가장 안쪽부터 모두
  rollback하고 그것들이 끝난 뒤 돌아온다. 열린 transaction을 가진 채 놓인 runner는, 그 callback이 더는 step이 올 수
  없음을 알 때 그것을 rollback한다.

## 인터페이스 계약

- **CORE-70** 코어의 인터페이스 계약은 `packages/rust/interface.json`이다. 계약은 코어가 가지고 있고 시그니처의 모든
  타입이 계약의 타입인 unit과 member만 선언한다. 값 alias `orm_value`(CORE-62)와 그것을 받거나 돌려주는 `Query`의
  member를 선언한다: `where`, `value`, `get_by`, `get_count_by`. 시그니처의 타입이 아직 계약의 타입이 아니어서 선언하지
  않는 것: `Tx::run`(table은 빌린 텍스트이고 행은 열이 없는 cell의 list다), `Tx::execute`(plan step),
  `Db::subscribe`(자기 문장을 빌리는 event), `Db::with_request_hook`(protocol의 request), `Config`의 field
  `audit_source`(함수), `TransactionOptions`의 field `audit`, `Key`, `GroupRow`, `GroupRows`, `Statement`(그 값이 Rust 값
  `Param`과 `Key`다). `Utils`와 그 부분은 자기 handle을 빌리고 `Collection`, `Page`, `LookaheadPage`는 생성된 모델의
  타입을 받으므로, 이것들과 이것들을 돌려주는 member(`get`, `gets`, `gets_by`)도 선언하지 않는다.
- **CORE-71** 계약의 case는 계약의 `cases`가 이름하는 `contracts/interface/core.json`의 group이며 binding의 case
  형식을 따른다: case의 키는 그 member의 parameter이고, receiver는 인스턴스 값이며, 실패는 kind, category, message
  전체(CORE-12)를 적는다. 코어는 그 모든 group을 계약이 이름하는 함수로 실행하고, 시험이 부를 수 없는 member를
  이름하는 group은 실패한다.
- **CORE-72** 데이터베이스가 필요한 case는 구현되지 않았다: SQLite DSN은 절대 경로를 담고(CFG-11) 서버 DSN은 실행이
  주는데, case 형식에는 그 어느 쪽의 값도 없다. `contracts/interface/core.json`은 문장을 보내지 않는 case만 담고,
  데이터베이스가 필요한 member는 코어의 시험이 시험한다.
