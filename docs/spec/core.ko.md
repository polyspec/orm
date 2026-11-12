<!-- doc-id: core -->
<!-- source-sha256: 7c3f1db7610a64b8d4479014b7cc024a998accf52c0e3871f7d0cbac0e911bce -->
# Rust 코어와 생성 바인딩

`packages/rust`의 crate `polyspec-orm`이 orm 규칙의 유일한 구현이고, PHP·Python·Node·Go 바인딩은 그 인터페이스 계약
`packages/rust/interface.json`에서 생성한다. 이 문서는 `packages/go`, `packages/php`, `packages/php-ext`,
`packages/python`, `packages/ts`의 언어 구현이 따르는 규칙과 다른 코어의 규칙을 적는다.

## 공존

- **CORE-1** 언어 구현이 자기 변경으로 없어질 때까지 레포는 그 구현을 릴리스의 API로, 코어를 계약의 API로 함께 둔다.
  이 문서의 규칙은 코어와 바인딩에 적용된다. 규칙마다 대체하는 규칙을 적으며, 대체된 규칙은 언어 구현이 없어질 때까지
  그 구현에 계속 적용된다. 언어 구현의 시험은 코어를 위해 바꾸지 않고, 코어의 시험은 언어 구현에 실행하지 않는다.
- **CORE-2** 이 문서의 규칙이 기대값을 바꾸는 공유 recipe case는 코어에서 `contracts/fixtures/core/`의 case가
  `supersedes`로 그 case를 가리켜 대체한다. Rust recipe 실행기는 대체된 case 대신 대체하는 case를 실행하고, 기대값 밖의
  step이 서로 같은지 확인한다.
- **CORE-3** 오류를 기대하는 공유 recipe case와 공유 vector는 그 kind를 코어가 쓰는 대로 소문자로(`no_rows`), 기대
  메시지는 `<kind>: <text>`로 적고, Rust 실행기는 둘을 그대로 비교한다. 실행기 자신이 알리는 case의 언어 코드 실패는 kind가
  아닌 실행기의 코드(`callback`, `step`, `subscriber`)를 가진다. 언어 구현은 여전히 카탈로그 코드를 대문자로
  쓰므로(CORE-1), 그 실행기는 기대 kind를 자기 코드의 소문자와 비교한다.

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
