<!-- doc-id: core -->
<!-- source-sha256: f450b0740e96aad772cd05c16e34032a3709f4bfd9858c4a50a456c5852ec23a -->
# Rust 코어와 생성 바인딩

`packages/rust`의 crate `polyspec-orm`이 orm 규칙의 유일한 구현이다. 바인딩(PHP, Python, Node, Go)은 그 인터페이스 계약
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
  고정 사본을 읽는다. 공유 case와 그 고정 사본은 schema 하나, `scripts/features/schema/recipe.schema.json`을 이름하므로,
  그 schema의 오류 코드는 소문자 kind이거나 대문자 코드이고, 그 case 형식은 `supersedes`를 이름한다(CORE-2). 공유 case를
  `contracts/interfaces.json`의 state contract와 비교하는 검사는, state contract가 언어 구현이 돌려주는 코드를 적으므로,
  대문자 코드와 그 kind를 같은 오류로 본다(CORE-10).
- **CORE-4** `legacy/packages/`의 언어 구현은 그 언어의 생성된 binding이 `packages/rust/interface.json`의 모든
  contract case를 실패와 skip 없이 통과하고, 언어 구현의 시험이 contract의 `changes`에 선언된 것 밖의 변경 없이
  그 binding으로 통과한 뒤에만 제거한다. 제거는 그 언어 구현의 변경 하나로 한다. 다른 언어 binding의 통과는 그
  제거를 허용하지 않는다. 이 두 검사는 contract의 동작과 contract가 의도적으로 대체하지 않는 릴리스 API를 모두 보존한다.
- **CORE-5** 제거 전에 언어 구현의 API와 `packages/rust/interface.json`의 차이 각각은 그 차이를 정의하는 규칙과
  함께 contract의 `changes` 항목이다. binding으로 실행하는 데 필요한 시험 변경은 그런 항목이 허용할 때만 가능하다.
  따라서 명세로 정한 API 변경 없이 실패하는 legacy 시험을 제거하거나 약화해서 CORE-4를 만족시킬 수 없다.

언어 구현은 아직 CORE-1에 따라 core와 공존한다. CORE-4의 제거 조건은 검증하지 않았으며, CORE-5가 요구하는 차이
목록은 아직 완전하지 않다. `changes`는 CORE-124의 값 표현을 기록하지만, 그 항목들만으로 모든 legacy API 차이가
기록되었다고 볼 수 없다. 이 증거로 제거할 수 있는 언어 구현은 없다.

- **CORE-7** transaction 또는 savepoint machine을 취소하는 driver는 machine과 현재 I/O future를 함께 drop한다.
  열린 transaction을 소유한 machine을 drop하면 보관된 모든 handle을 즉시 무효화한다. 열린 savepoint machine을
  drop하면 transaction 전체를 무효화한다. Drop은 그 savepoint의 rollback을 await할 수 없기 때문이다.
  transaction이나 savepoint를 아직 획득하지 않은 취소된 opening은 소유한 것이 없고 parent를 계속 사용할 수 있게 둔다.
  독립적으로 보관된 operation은 그 future가 완료되거나 drop될 때까지 connection borrow를 소유한다. 논리적 무효화는
  즉시 적용하고, 열린 상태이거나 상태를 알 수 없는 connection은 마지막 borrow가 끝날 때 폐기하며 pool에 반환하지 않는다.
  무효화 뒤에는 새 operation이나 종료 동작을 받지 않는다. 종료 I/O의 수락 시점은 connection slot lock을 잡고 transaction이
  중단되지 않았음을 확인한 뒤 connection을 꺼낼 때다. 이미 수락된 종료 future는 독립적으로 완료를 소유한다. 정상 반환은
  종료 statement와 정리가 성공하고 중단 검사를 통과한 뒤에만 수락한다. 무효화 전에 수락된 반환 future는 정상임이 입증된
  connection을 반환할 수 있다. 이미 보낸 COMMIT은 취소할 수 없다. machine을 drop해도 rollback을 입증하거나 commit된
  결과와 알 수 없는 결과를 구별할 수 없으며, 완료된 commit을 되돌리지 않는다.

## 오류

- **CORE-6** interface contract는 binding 층의 I/O 실패를 나타내는 `io`를 포함하여 그 층의 모든 error category에
  class를 선언한다. 그 class는 PHP의 `Polyspec\Orm\OrmIoError`, Python의 `ORMIoError`, Node와 WASM의
  `OrmIoError`이며 실패의 kind와 message를 보존한다. core의 kind 중 그 category에 속하는 것이
  없어도 binding 층이 자기 실패를 raise할 수 있으므로 이 연결이 필요하다.
- **CORE-10** 코어의 오류는 닫힌 enum `polyspec_orm::Kind`의 kind 하나를 가진다. kind와 category와 뜻은
  [errors](errors.md)의 표다. kind는 카탈로그 코드의 소문자 snake 형태다(`NO_ROWS`는 `no_rows`). 코어에서는 INT-65와
  INT-89를 대체한다: 바인딩은 kind를 계약의 enum `ErrorKind`로, 모든 오류를 그 category의 클래스(CORE-11)로 내고, 어느
  구현도 자기 상수 목록을 가지지 않는다.
- **CORE-11** 오류의 클래스는 모든 바인딩에서 그 category의 클래스 `Orm<Category>Error`(`OrmValueError`,
  `OrmTypeError`, `OrmStoreError`, `OrmBusyError`, `OrmInternalError`)이며 kind를 `kind`로 가진다. kind별 클래스는
  가지지 않는다. kind 묶음을 잡는 규칙이 없기 때문이다.
- **CORE-12** 오류 메시지는 `<kind>: <text>`이고 text는 INT-163과 INT-187을 따른다.
- **CORE-13** 드라이버 오류는 INT-89와 DIA-201이 그 코드에 주는 kind나 `driver`를 가지며 드라이버 오류를 원인으로 담는다.
  markdown 서버는 오류 코드를 돌려준다(PRT-71). 코어의 kind가 아닌 코드는 kind `driver`이며 메시지가 서버가 보낸 코드를
  적는다.
- **CORE-14** 네 kind는 카탈로그 코드가 없다. 언어 구현은 그 실패를 `CONFIG`로 내기 때문이다: `busy`(CORE-22),
  `transaction_ended`(CORE-23), `closed`(CORE-31), `pool_timeout`(CORE-30). `rollback_failed`는 `ROLLBACK`을
  대체한다(CORE-25). 코드 `SUBSCRIBER`(CORE-28), `GENERATOR_SCAN_PARSE`, `GENERATOR_SCAN_UNATTACHED`(CORE-50)는 코어의
  kind가 아니다.
- **CORE-139** 읽기가 디코드할 때 stage가 거부한 저장 cell은 그 행을 읽는 member를 모든 바인딩에서 kind `codec_decode`,
  category `value`의 클래스(CORE-11), 메시지 `codec_decode: <entity>.<column>: <text>`로 실패시킨다. 읽기가 이미 가진
  값의 변환은 CORE-64와 CORE-126의 메시지를 그대로 둔다. 다른 라이브러리의 오류
  클래스는 orm member의 호출자에게 닿지 않는다. 그 라이브러리의 오류는 원인으로만 남는다.

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
- **CORE-27** 코어는 문장의 작업 밖에서 언어 코드를 호출한다. 콜백을 호출하는 멤버는 I/O가 없는 상태 기계이고, `Io`(기다릴
  작업), `Call`(인자와 함께 호출할 콜백), `Await`(콜백이 돌려준 값으로, 언어가 기다린다), `Done`(결과)을 돌려준다. 바인딩은
  멤버의 `wait`대로 `Io`를 기다리고, 호출 스레드에서 `Call`을 호출해 그 결과를 되돌려 준다. 그래서 blocking 런타임이 코어
  안에서 코어를 기다리며 막히지 않는다. 계약의 상태 기계는 CORE-100부터 CORE-105가 적는다.
- **CORE-28** 문장 event subscriber가 던진 예외는 그대로 돌아간다. 그 문장은 실행되었고, 끝나지 않은 트랜잭션의 쓰기는
  함께 롤백된다. INT-96의 `SUBSCRIBER`는 코어의 kind가 아니다.

## 연결

- **CORE-30** 설정은 pool 연결 대기의 한도 `pool_acquire_timeout_ms`를 받으며, 없으면 `30000`이다. 한도를 넘는 대기는
  `pool_timeout`으로 실패하므로 바닥난 pool의 문장도 호출자에게 돌아간다.
- **CORE-31** `Db::close`는 진행 중인 호출을 끝까지 두고, 그 뒤 같은 pool의 모든 handle 호출을 `closed`로 실패시킨다. 두
  번째 `close`는 성공한다.
- **CORE-32** `Db`는 동시 호출을 받는다. 문장은 pool 연결 하나를 빌리고 그 결과는 다른 호출과 무관하다. 트랜잭션 번호는
  `BEGIN`을 보낼 때 하나씩 더한다.

## 취소

- **CORE-40** 코어의 취소 규칙은 하나다. 취소된 문장은 `canceled`로 끝나고, 트랜잭션의 롤백은 취소하지 않는다(CFG-9).
- **CORE-41** PHP `Cancellation`은 한 요청 tree의 프로세스들이 공유하는 상태 파일에 상태를 가진다: 그 프로세스는 파일을 만든 프로세스인 주인과 주인이 fork한 자식이다. 상태 파일은
  orm 한 버전의 비공개 형식이다: 다른 버전이나 다른 프로그램은 그 파일을 읽지 않으며, legacy client의 형식이 아니다(CORE-110). 디렉터리는 필수 인자다. 주인은 그 디렉터리에 정리가 읽지
  않는 임시 이름 `.<random>.tmp`를 써서 파일을 배타적으로(`O_CREAT | O_EXCL | O_CLOEXEC`) 만들고, 파일에 무엇을 쓰기 전에 mode를 `0600`으로 한다.
  `<random>`은 시스템의 난수원에서 얻은 소문자 16진수 32자리다. 주인은 표시 `0`과 line feed를 쓰고 파일에 `flock(LOCK_SH)`를 얻은 뒤에야 상태 파일의 이름인
  `orm-cancel-<random>`으로 rename한다. 그래서 정리가 보는 상태 파일은 늘 주인이 잠근 것이다. 주인은 그 잠금, 곧 수명 잠금을 파일이 있는 동안 가진다: 수명 잠금은 upgrade되지
  않고 drop 전에 풀리지 않는다. 실패한 단계는 임시 파일을 지우고 kind `config`의 오류다. 생성과 rename 사이에 끝난 프로세스는 임시 파일을 남기며, 어떤 정리도 그 파일을 지우지 않는다.
- **CORE-42** `Cancellation`을 만들면 먼저 그 디렉터리를 정리한다. 정리는 이름이 `orm-cancel-<random>`과 `orm-cancel-<random>.lock`인 항목만 읽는다.
  정리는 상태 파일마다 파일을 열고 `flock(LOCK_EX | LOCK_NB)`를 시도한다. 잠금이 성공하면 수명 잠금을 가진 프로세스가 없으므로 정리는 상태 파일을 지우고 이어서 그 lock 파일을 지운다.
  잠금이 `EWOULDBLOCK`으로 실패한 파일은 주인이 있으므로 남긴다. 목록을 읽은 뒤 열기 전에 다른 정리가 지운 파일은 건너뛴다. 그 밖의 실패는 kind `config`의 오류다. 정리는 그다음 상태
  파일이 없는 lock 파일을 각각 지운다.
- **CORE-43** 상태 파일은 text다. 바이트 0은 표시로, ASCII 숫자 `0`(취소 안 됨)이나 `1`(취소됨)이고, 바이트 1은 line feed다. 그 밖의 표시는 kind `config`의
  오류다. 그 뒤에 파일은 진행 중인 문장마다 레코드 하나를 가지며, 레코드는 한 줄을 차지하는 JSON object다. 문장이 진행 중이라는 사실은 표시의 값이 아니라 그 레코드가 있다는 것이다. 레코드는
  `statement`(레코드를 식별하는 무작위 16진수 32자리), `process`(문장을 실행하는 프로세스의 id), `driver`, `database`(handle의 DSN의 SHA-256을 16진수로 쓴
  값이므로 파일은 DSN도 password도 가지지 않는다)와 서버에서 그 문장을 끝내는 정보를 가진다: 그 정보는 MySQL이나 MariaDB의 connection id인 `connection`, 또는
  PostgreSQL의 backend pid와 secret key인 `backend`와 `secret`이다. SQLite나 markdown의 레코드는 그 정보를 가지지 않는다. `Cancellation`을 가진
  handle의 문장은 전송되기 전에 레코드를 쓰고, 성공이든 실패든 exception이든 끝날 때 레코드를 지운다. 그런 object가 아닌 줄은 kind `config`의 오류다.
- **CORE-44** 한 PHP 프로세스 안에서는 진행 중인 문장을 취소할 수 없다: 문장이 실행되는 동안 언어 코드는 실행되지
  않는다(CORE-27). 같은 프로세스의 `cancel()`은 그 handle의 다음 문장을 `canceled`로 실패시킨다.
- **CORE-106** 표시나 레코드를 읽거나 쓰는 모든 연산은 그 연산 동안만 lock 파일 `<state file>.lock`에 `flock(LOCK_EX)`를 가진다. 일반 파일에는 다른 프로세스가 절반만
  쓰인 상태를 볼 수 없는 크기의 쓰기가 없기 때문이다. 그 연산은 문장의 시작과 끝, `cancel()`, 문장 전의 표시 읽기, SQLite progress handler의 표시 읽기다. 연산은 lock 파일을
  `O_CREAT | O_CLOEXEC`와 mode `0600`으로 열므로 첫 연산이 lock 파일을 만든다. 연산은 잠금을 얻은 뒤 상태 파일을 그 이름을 써서 열고, 상태 파일이 없으면 kind
  `config`의 오류다. lock 파일은 연산이 얻는 유일한 잠금이다: 어떤 연산도 상태 파일의 잠금을 얻거나 바꾸지 않으며, 수명 잠금은 상호 배제에 쓰이지 않는다. 표시는 offset 0에 한 바이트의
  positioned write 한 번으로 쓴다. 레코드는 바이트 1 뒤의 바이트를 바꾸고 파일을 새 길이로 truncate해서 쓴다.
- **CORE-107** `cancel()`은 CORE-106의 잠금을 가지고 표시 `1`을 쓴 뒤 기록된 문장을 끝낸다. `database`가 자기 프로세스에서 이 `Cancellation`을 가진 handle의
  것과 같은 레코드마다, `cancel()`은 그 handle의 DSN으로 제어 연결을 열고 `KILL QUERY <connection>`이나 `backend`와 `secret`의 CancelRequest를
  전송한다. 그 프로세스의 어떤 handle도 가지지 않은 `database`의 레코드는 그대로 남는다: 그 문장은 끝까지 실행되고, 그 handle의 다음 문장이 `canceled`로 실패한다. SQLite
  문장은 표시를 읽는 자기 progress handler로 끝난다(CORE-47). markdown 문장은 그 session의 socket을 가진 프로세스, 곧 주인이나 session이 열린 뒤에 fork된 자식만
  끝낼 수 있고, 그 프로세스는 socket을 shutdown한다(PRT-71). 두 번째 `cancel()`은 아무것도 바꾸지 않는다. 레코드를 지우지 않고 끝난 프로세스의 레코드는 파일에 남고,
  `cancel()`은 그 레코드가 적은 대상에 전송한다: 서버가 같은 사용자의 나중 session에 준 MySQL connection id는 그 session의 문장을 끝낸다.
- **CORE-108** `Cancellation`은 주인의 프로세스 id를 기록한다. 주인이 그것을 drop하면 주인은 CORE-106의 잠금을 얻고, 상태 파일을 지우고 이어서 lock 파일을 지운 뒤 자기
  descriptor를 닫는다. fork된 자식은 같은 object를 가진다. 자식은 주인처럼 lock 파일을 거쳐 읽고 쓰되 자기가 연 descriptor를 쓰며, object를 drop하거나 끝날 때 두 파일
  중 어느 것도 지우지 않는다. 수명 잠금은 open file description에 속하고 fork된 자식은 그것을 상속하므로, 정리는 주인과 그런 자식이 모두 그것을 닫을 때까지 상태 파일을 남긴다. 주인이
  파일을 지운 뒤 자식의 연산은 kind `config`의 오류다.
- **CORE-109** 상태 파일이나 lock 파일의 생성, 잠금, 읽기, 쓰기의 모든 실패는 kind `config`의 오류이고 메시지는 단계와 경로를 적는다. PHP binding은
  `Cancellation`을 코어의 취소와 잇는다: `Cancellation`을 받은 `Db::with_cancel`은 `Cancellation`과 프로세스마다 코어의 cancel 값 하나를 handle에 주고,
  binding은 그 handle의 문장마다 그 전에 표시를 읽어 `1`이면 그 값을 발화시킨다. 그래서 그 문장은 CORE-46대로 실패한다.
- **CORE-110** 이 형식은 legacy PHP client의 형식을 대신하며, 두 형식을 모두 읽는 구현은 없다. legacy의 상태 파일은 flags 바이트 하나와 connection slot마다 바이트
  하나다. legacy 형식을 읽거나 쓰는 모든 코드는 첫 구현과 함께 바뀐다: `legacy/packages/php/src/Cancellation.php`; 문장을 시작하고 끝내며 경로와 slot을 SQLite
  helper에 주는 `legacy/packages/php/src/Db.php`의 `send`; `legacy/packages/php/src/SqliteCancellation.php`와, flags 바이트와
  slot 바이트를 잠금 없이 읽는 `legacy/packages/php/src/native/sqlite_cancel.c`; 같은 class의 두 번째 구현인
  `legacy/packages/php-ext/src/native_classes.c`의 native class; `statePath`와 `registerCancelQuery`를 호출하고 slot을 가진
  `legacy/packages/php-ext/src/db.c`; 파일의 바이트를 비교하는 `legacy/packages/php-ext/tests/QueryCancellationNativeTest.php`.
  구현되지 않았다: CORE-41~CORE-43과 CORE-106~CORE-109는 구현이 없고, legacy client는 자기 형식을 쓴다.

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
  구현되지 않았다: 코어에는 함수 `generate`가 없고 계약에는 그 member가 없어서, 어떤 바인딩도 생성된 모델을 가지지
  않는다. 생성기는 `packages/rust/build`의 crate `polyspec-orm-build` 하나뿐이다. 이것은 Rust 모델만 `Query`가 아니라
  `Core` 위에 쓰고, 여전히 소스를 스캔한다(DSL-41). 그 `generate(set, scan, manifest_file)`은 스캔한 소스가 부르는
  chain, relation key, join, `new_<name>`, getter method를 쓰고, `generator_scan_parse`나
  `generator_scan_unattached`로 시작하는 메시지로 실패한다.
- **CORE-51** 생성한 모든 파일의 첫 줄은 그것을 생성한 orm 판을 적는다.

## 값

- **CORE-60** 열 값은 `orm_value`로 코어 밖으로 전달된다: 64비트 열(`i64`와 MySQL 부호 없는 열)의 정수는 `int64`(Node
  `bigint`), 더 좁은 열의 정수는 크기와 관계없이 `int`(Node `number`), JSON 열은 `json_value`의 값, 날짜·시각·날짜시각은
  DBS-112와 DBS-121의 정규 텍스트, decimal은 정확한 텍스트다.
- **CORE-62** `orm_value`는 코어의 값 타입 `polyspec_orm::OrmValue`이고, 계약은 그것을 값 alias `orm_value`로 선언한다.
  그 kind는 `null`, `bool`, `int`, `int64`, `float`, `text`, `bytes`, `list`, 텍스트 key의 `map`, `nested:json_value`다.
  열 값의 kind는 값이 아니라 열의 타입이 정한다: `i16`과 `i32`는 `int`, `i64`는 `int64`, `f64`는 `float`, `bool`은
  `bool`, `bytes`는 `bytes`이고, `decimal`, `varchar`, `text`, `uuid`, `date`, `time`, `datetime`은 `text`이며
  `datetime(p)`는 소수 자리가 정확히 p개다(PRT-69). SQL NULL은 `null`이다. stage `json` 뒤의 열은
  `nested:json_value`다(CORE-122). 다른 style stage 뒤의 열은 공통 값 모델의 값이며 kind는 `null`, `bool`, `int64`,
  `float`, `text`, `list`, `map`이다: 소수부와 지수가 없고 `i64`에 들어가는 수는 `int64`, `i64`나 유한한 `f64`에
  들어가는 그 밖의 수는 `float`이고, 어느 쪽에도 들어가지 않는 수는 `codec_decode`다.
- **CORE-63** 폐기되었고 CORE-123이 대체한다. native 입력 규칙은 이제 CORE-124의 kind 보존 class도 받아들인다.
- **CORE-123** 언어의 값은 함수 `from_host` 하나로 코어에 들어오며, 이 함수는 값만 읽는다: null은 `null`, boolean은
  `bool`, 정수는 `int64`, float는 `float`, 텍스트는 `text`, bytes는 `bytes`, list는 `list`, map은 `map`이다. 수 타입이
  하나인 언어의 수는 소수부가 없고 -(2^53 - 1)부터 2^53 - 1까지의 범위에 있으면 `int`이고 그렇지 않으면 `float`다.
  텍스트가 byte인 언어의 텍스트는 그 byte가 UTF-8이면 `text`이고 아니면 `bytes`다. key가 순서대로 0부터 n-1인 PHP
  배열은 `list`이고 그 밖의 PHP 배열은 `map`이며, 그 정수 key는 그 정수의 텍스트다. 다른 map의 key는 텍스트다. 열이
  무엇을 받는지는 값을 bind하는 곳에서 열의 타입이 정하므로(PRT-32a) `int`와 `int64`는 똑같이 bind된다. 이 가운데
  어느 것도 아닌 값은 `codec_encode`이고 메시지는 `the value is no value of a column: <what>`이며 값을 적지 않는다:
  `i64` 밖의 정수, 유한하지 않은 float, Unicode scalar 값의 열이 아닌 텍스트, 텍스트가 아닌 map key, 256단계보다 깊이
  중첩된 list나 map, 그리고 언어의 undefined 값, 날짜, 함수, CORE-124의 class가 아닌 객체다. 그 class는 선언한
  property로 읽으며 property의 native 값이 다른 kind로 들어오더라도 class의 kind를 보존한다. property가 예외를 내면
  그 예외를 그대로 돌려주고, 내용이 선언된 표현이 아니면 `codec_encode`다. 구현되지 않았다: 들어오는 `json_value`의 값.
  alias에는 다른 라이브러리의 값을 위한 `in` 행이 없으므로 그런 값은 객체이고 거부된다.
- **CORE-124** binding은 나가는 값이 core로 다시 들어올 때 그 kind를 보존한다. native 값이 kind를 잃는 곳에만
  아래의 생성된 `origin: value` class를 쓰고, 모호하지 않은 native 표현은 모두 native로 유지한다. 각 class는 같은 이름의
  필수 constructor 인자와 읽기 전용 property를 가진다. property는 담긴 native 값을 주며, constructor는 coercion 없이
  선언된 type만 받는다.

  | Kind | 언어와 조건 | Class | 인자와 property | Type |
  |---|---|---|---|---|
  | `int` | PHP, Python, Go; `safe_integer`가 false인 Node와 WASM | `IntegerValue` | `value` | `int64` |
  | `float` | Node와 WASM, `-0.0`을 포함해 `safe_integer`가 true일 때 | `FloatValue` | `value` | `float` |
  | `bytes` | PHP, 빈 bytes를 포함해 `utf8`이 true일 때 | `BytesValue` | `value` | `bytes` |
  | `map` | PHP, 빈 map을 포함해 `sequence_keys`가 true일 때 | `MapValue` | `entries` | text key의 `orm_value` map |

  `IntegerValue`는 값의 크기와 무관하게 `int`를 담고, native 정수는 계속 `int64`로 들어온다. Node와 WASM은 안전한 `int`를
  native number로 유지하고 그 밖의 `int`에는 `IntegerValue`를 써서 정밀도를 잃지 않는다. 정수값 float는
  안전한 정수 범위에서는 `FloatValue`를 거쳐 float로 유지되고 0의 부호를 지킨다. 소수나 그 범위 밖의 정수값 float는
  native number로 유지된다. PHP byte string은 내용이 올바른 UTF-8이어도 `BytesValue`를
  거쳐 bytes로 유지된다. `MapValue`는 PHP가 key를 순서대로 0부터 n-1로 표현할 때 map을 유지한다. core는 key에서 그
  predicate를 선언하고 CORE-123에 따라 그 key를 text로 읽는다. PHP class는 `Polyspec\Orm`, Python class는
  `polyspec.orm`, Node와 WASM class는 package entry, Go class는 binding package에 있다. interface contract의
  `changes`는 이 공개 표현 변경을 기록한다.
  이 class 표현을 쓰는 생성된 binding은 아직 다시 build하고 시험하지 않았다.
  lock이 고정한 binding은 나가는 float의 `safe_integer`를 거부하므로, float에 그 predicate를 지원할 때까지 float 행은
  검증되지 않았다. 모든 정수값 float에 class를 쓰는 것으로 바꾸면 kind가 이미 모호하지 않은 큰 native number도 바뀐다.
- **CORE-64** 값은 함수 `to_host` 하나로 코어를 나가며, 이 함수는 값을 한 단계씩 기술한다. `nested:json_value`의 값은
  `json_value`의 `out` 표의 kind로 기술한다: `null`, `bool`, 수 텍스트를 가진 `number`, `text`, `list`, member 순서의
  `map`이다. 짝 없는 surrogate를 가진 JSON 문자열에는 `text`가 없으므로, 그런 문자열을 가진 JSON 값은 그 열의 값을
  읽을 때 `codec_decode`이고 메시지는 `the JSON value holds a string that is no sequence of Unicode scalar values`다.
- **CORE-61** 폐기되었고 CORE-122가 대체한다: 문서의 canonical form은 더 이상 stage `ordered_json`을 `json`으로 쓰지
  않는다.
- **CORE-122** JSON 값을 member 순서·숫자 텍스트·빈 container와 함께 저장하는 codec stage(COD-9, COD-16)는 코어에서
  `json`이다. 언어 구현은 그것을 쓰던 라이브러리 이름을 따라 `ordered_json`이라 부르지만 코어는 그 이름의 라이브러리에
  의존하지 않으므로(CORE-1), 코어의 dbspec 문서는 `json`을 쓴다. 코어는 `ordered_json`을 같은 encoding의 stage
  `json`으로 읽으므로, 언어 구현이 읽는 문서를 코어도 읽는다. 문서는 쓰인 stage 이름을 지킨다. 문서가
  `ordered_json`이라 쓴 곳에서 그 canonical 텍스트, manifest 텍스트, schema 텍스트는 `ordered_json`을 쓴다. 문서의
  hash는 parser가 읽는 별칭 때문에 바뀌면 안 되고, 릴리스된 생성기는 이름을 쓰인 대로 쓰므로, 한 문서는 코어와
  릴리스에서 같은 manifest hash를 갖는다. 문서의 runtime model은 두 이름 모두에 대해 stage `json`을 갖는다. 그런 값의
  공유 case 값 wrapper는 코어를 나가는 값(CORE-60)과 같이 `json_value`이고(FCV-4), 그 stage를 시험하는 case의 id도
  `json`으로 그것을 부른다. CORE-1의 고정 사본은 언어 구현을 위해 옛 이름을 지킨다.

## 일반 질의

- **CORE-80** `Schema::load(manifest_text, external_text, manifest_hash)`는 INT-133의 schema 값을 실행 시에 만든다.
  manifest가 아닌 텍스트는 `schema_invalid`이고 `manifest_hash`로 hash되지 않는 텍스트는 `schema_hash_mismatch`이며,
  둘 다 어떤 연결보다 앞선다. 불러온 schema는 자기 텍스트와 runtime model을 소유하고, 그것을 가리키는 값들이 그것을
  공유한다: schema 값과 그 사본, 그 schema의 `Query`와 그 `Query`의 행, 그런 `Query`의 요청, 그리고 그 schema가
  등록된 연결(그 연결이 놓일 때까지)이다. 그 가운데 마지막이 놓이면 schema의 메모리가 돌아오며, 프로세스는 불러온
  schema를 가지지 않는다. 생성된 코드의 schema는 그 코드의 static이고 세지 않는다.
- **CORE-125** 생성된 binding은 `schema.load`가 만든 `Schema`만 받는다. 그 factory는 반환 전에 manifest와 hash를
  검증하고 검증된 runtime model을 cache한다(CORE-80). 이 class에는 public constructor, 쓸 수 있는 property,
  그 text나 model을 바꾸는 method가 없다. 따라서 `query.new`는 `entity_unknown`만 선언한다. `schema_invalid`와
  `schema_hash_mismatch`는 query가 그 schema를 받기 전 `schema.load`에서 발생한다. 잘못되었거나 초기화되지 않은 언어
  객체는 binding이 core를 호출하기 전에 거부하며, 이는 `query.new`의 schema 검증 실패가 아니다. 이 제한은 모든 native
  Rust 값이 아니라 interface contract가 받는 값을 적는다. native `Schema::new`와 `Schema::with_external`은 계속
  lazy constructor이며, `Query::new`는 잘못된 native schema를 처음 읽을 때 그 검증 오류를 그대로 반환한다. contract의
  `changes`는 binding 오류 목록의 정정을 기록하며, native constructor와 그 동작은 바뀌지 않는다.
- **CORE-81** `Query`는 이름을 주어 고른 엔티티 하나의 질의이자 행 상태다: `Query::new(schema, entity)`. schema에 없는
  엔티티는 `entity_unknown`이다. `Query`는 `connect(connection)` 뒤에 실행되고 그 연결은 `Db`나 `Tx`다(CORE-20).
  연결이 없는 `Query`의 terminal은 `config`다. `Query`의 엔티티 descriptor는 그 `Query`와 그 사본, 그 행이 공유하고 그 가운데
  마지막과 함께 놓인다(CORE-80).
- **CORE-126** 생성된 binding이 받는 `Query`는 `query.new`가 고른 검증된 schema와 존재하는 entity를 유지한다
  (CORE-125, CORE-81). 그 사본, 불러온 행, 관련 행과 `create`, `restore`, `restore_or_create`가 반환한 행도 그
  descriptor를 유지한다. contract의 어떤 member도 그 schema나 entity를 교체하거나 raw row를 받아들이지 않는다.
  따라서 `query.value`는 `schema_invalid`, `schema_hash_mismatch`, `entity_unknown`을 선언하지 않는다. 그 검사는
  binding이 query를 받기 전에 끝났다. `column_unknown`, `column_unselected`, `codec_decode`, `internal`은 유지한다.
  없는 column과 읽지 않은 column은 database 없이 실패한다. 저장된 값을 변환할 때는 여전히 `codec_decode`가 날 수
  있고, 일관되지 않은 내부 row 상태는 `internal`이다. `set`의 쓰기 배정은 raw decoded row를 주거나 descriptor를
  교체하지 않는다. 이는 binding 오류 목록만 정정한다. native lazy schema, 직접 만든 native descriptor와 그 검증
  동작은 바뀌지 않는다. group `query.value.sqlite`가 저장된 행의 `codec_decode` case를 담는다:
  `restore`가 돌려준 행에서 읽은, 짝이 없는 surrogate escape를 담은 JSON cell이다(CORE-129). 기존 column 오류 case는 유지한다.
- **CORE-82** `where(chain, values)`는 DSL-36과 DSL-37의 chain 이름(예: `GtServiceSeqAndIsClose`)의 조건을 key마다 값
  하나로 더한다. 값은 `orm_value`다(CORE-62): `null`은 조건의 null이고, `list`는 연산자가 없거나 `Ne`인 key의 값
  목록, 값이 둘일 때 `Between` key의 쌍, tuple key의 값 묶음 목록이며, `map`과 `nested:json_value`를 뺀 다른 kind는 값
  하나다. `map`, `nested:json_value`, 값 목록 안의 list, 길이가 다른 `Between` list는 다음 terminal에서
  `codec_encode`이고 메시지는 `the value of a condition is <what>`이다. `And`나 `Or`로 시작하는 이름은 첫 조건을 그 연결어로 앞선 조건에 잇는다. 이름은 crate
  `polyspec-orm-schema`의 `parse_chain`이 읽으며, 생성된 모델의 chain 이름도 읽는 하나뿐인 함수다. 엔티티의 chain이
  아닌 이름, 열이 허용하지 않는 연산자, key 수와 다른 값의 수는 `config`이고, 생성된 모델의 builder 오류처럼 다음
  terminal이 돌려준다. `order_by(spec)`는 `SeqDescAndLabelAsc` 같은 이름의 순서를 더하며 key마다 열과 `Asc`나
  `Desc`이고, 같은 crate의 `parse_order`가 읽는다.
- **CORE-137** `where_none(connector)`는 어떤 행도 만족하지 않는 조건을 더한다. 허용된 값 목록이 빈 호출자가 raw
  SQL 없이 어떤 행도 읽거나 세거나 쓰지 않게 하기 위한 것이다(T563). `connector`는 CORE-82의 연결어인 `""`, `And`,
  `Or` 중 하나다: `""`와 `And`는 조건을 앞선 조건에 `and`로, `Or`는 `or`로 잇는다. 첫 조건은 CORE-82처럼 연결어를
  갖지 않는다. 다른 글은 다음 terminal에서 `config`이고 메시지는 `where_none takes "", "And" or "Or", not <text>`이다.
  이 조건은 `ir_version` 2 요청의 predicate `none`이다(PRT-92): `get`과 `get_by`는 행을 찾지 못하고, `gets`는 빈 `Collection`을,
  `get_count`는 0을 돌려준다. 모든 데이터베이스에서 `X And none`은 어떤 행도 고르지 않고 `X Or none`은 `X`의 행을 고른다.
- **CORE-83** terminal `get`, `gets`, `get_count`, `get_query`는 생성된 모델의 terminal처럼 질의를 실행하고,
  `get_by(chain, values)`, `gets_by(chain, values)`, `get_count_by(chain, values)`는 그 chain의 조건을 `and`로 이어
  실행한다. 어떤 terminal도 질의를 바꾸지 않는다(DSL-69). 행은 같은 엔티티의 `Query`이고 `gets`는 행을
  `Collection`으로 돌려준다. `value(column)`은 행의 열 값을 `orm_value`로 돌려준다(CORE-62). 엔티티의 열이 아닌 이름은 `column_unknown`이고
  행이 읽지 않은 열은 `column_unselected`다.
- **CORE-84** 구현되지 않았다: `Query`의 `creates`, `save`, `join`, `leftJoin`, 묶음
  (`not`, `andNot`, `orNot`, `on`. `andGroup`과 `orGroup`은 `where_group`이다, CORE-202), `andModel`, `orModel`, `compare`,
  `getsLookaheadPage`, `getSum`, `getAvg`, 함수나 subquery의 추가 열(DSL-73, DSL-74). 열이나 값의 함수에 대한
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
  DSL-75~DSL-77). 열은 `value`처럼 dbspec 문서의 이름을 써서 지정한다. 엔티티의 열이 아닌 이름은 다음 terminal에서
  `config`이고 메시지는 `<column> is not a column of <entity>`다. 행이 읽지 않은 열의 `value`는
  `column_unselected`다(CORE-83).
- **CORE-88** `match_pair(pair)`는 relation key의 구성 요소 하나를 더한다. 이름은 `<Left>With<Right>`이고, `Left`는
  schema의 어느 엔티티(부모)의 열이며 `Right`는 `Query` 엔티티의 열이고, `polyspec-orm-schema`의 `split_pair`가
  읽는다(DSL-82). `alias(name)`은 결과의 이름을 정한다(DSL-83). 그것이 없으면 결과는 `<entity>_model`이나
  `<entity>_models`이고, alias의 이름은 그 snake case다. `relation(child)`는 `child`의 별도 질의가 읽은 행 하나를 각
  행에 붙이고 `relations(child)`는 그 행들을 붙인다(DSL-79~DSL-81). `match_pair`가 없는 `child`는 `config`이고 메시지는
  `relation child <entity> requires match_<l>_with_<r>()`이며, 그런 열을 이름하지 않는 pair는 `config`이고 메시지는
  `<pair> is not <column>With<column>`이고, 자기 member 하나가 실패시킨 `child`는 다음 terminal에서 그 오류로 질의를
  실패시킨다. `child`는 자기 lock을 가질 수 있다(CORE-86).
  `related(name)`은 행의 `relation` 결과의 행을, `related_rows(name)`은 `relations` 결과의 행들을 돌려준다. 결과
  `name`이 없는 행은 `None`을 돌려주고, 다른 형식의 결과는 `internal`이다.
- **CORE-89** `key_name(column)`은 `gets`의 `Collection`과 그 `Query`의 `relations` 결과의 행을 primary key 대신 열
  `column`으로 key한다(DSL-70). 엔티티의 열이 아닌 이름은 다음 terminal에서 `config`이고 메시지는
  `<column> is not a column of <entity>`다.
- **CORE-90** `where_in(chain, query)`는 chain 이름 `chain`의 열(연산자가 없거나 `Ne`인 key 하나)이 subquery `query`의
  행 안에 있다는, `Ne`이면 없다는 조건을 더한다. subquery는 그 `add_column`이 더한 열 하나를 읽는다(DSL-53). `And`나
  `Or`로 시작하는 이름은 그것을 앞선 조건에 잇는다. 다른 연산자의 chain은 `config`이고 메시지는
  `a subquery is not accepted by the <op> operator`이며, key가 더 많은 chain은 `config`이고 메시지는 `the condition expects <n> values`다.
  그 열 하나가 없는 subquery는 `config`이고 메시지는
  `a subquery model must add exactly one column with add_column_<col>()`이며, 자기 relation이나 연결을 가진 subquery는 `config`이고, limit이나 lock을 가진 subquery는
  `ir_invalid`이고 메시지는 `subquery may not use limit, relations, lock or columns`다. 각각 다음 terminal이 돌려준다.
- **CORE-91** `Query`의 쓰기는 생성된 모델의 쓰기와 같다(DSL-100, DSL-103, DSL-106, DSL-108, DSL-110):
  `set(column, value)`는 다음 쓰기를 위해 열에 `orm_value`를 배정하고, `create`는 배정한 행을 넣고 만든 행을 돌려주며,
  `update`는 배정한 값을 행에 쓰고, `delete`는 행을 지우며, `expect_revision(column, revision)`은 다음 `update`나
  `delete`가 정수 열이 `revision`을 가지고 있는 동안에만 쓰게 한다. `update`와 `delete`의 행은 `Query`가 읽은 행이고,
  행을 읽지 않은 `Query`에서는 `set`이 배정한 primary key의 행이다. 둘 다 없으면 쓰기는 `config`이고 메시지는
  `<entity> requires a loaded row or a set primary key <column>`이다. 엔티티의 열이 아닌 이름은 `config`이고 메시지는
  `<column> is not a column of <entity>`이며, list나 map은 `codec_encode`이고 메시지는 `the value of a column is a list`나 `a map`이고,
  열이 받을 수 없는 값은 쓰기에서 `codec_encode`다(CORE-62). 쓰기는 `duplicate_key` 같은 그
  원인의 kind로 실패한다(CORE-10).
- **CORE-138** `Query`의 조건(`where`, `where_in`, `where_none`; CORE-82, CORE-137)은 그 `update`와 `delete`(CORE-91)에도
  적용된다: 문장은 key의 행이 조건을 만족할 때만 그 행을 쓰고, 조건을 key에 `and`로 잇는다. 그래서 `where_none`을 가진
  query는 어떤 행도 쓰지 않는다. key는 여전히 한 행을 가리키고, `expect_revision`과 soft delete 열은 전처럼 이어진다
  (PRT-93). 아무 행도 바꾸지 않은 쓰기는 오류가 아니다. 다만 `expect_revision` 아래에서는 `revision_changed`로
  남는다(CORE-91). 한 문장으로는 revision과 조건을 구별할 수 없기 때문이다. 그때 메시지는 `the row's <column> is not
  <revision> or the row does not meet the conditions`다. 재귀 delete는 cascade 자식을 행보다 먼저 지우므로, cascade relation을 가진 행에 조건을 둔 재귀 delete는
  `config`다: `a recursive delete of a row with cascading relations takes no conditions`. 언어 구현(legacy/)은 조건이 고른 모든 행을 쓰는 집합 쓰기였다.
  core는 key의 한 행을 그 조건 아래에서 쓴다(T563-3).
- **CORE-92** `Db` step은 다른 library의 코어가 데이터로 가진 질의이고, host는 자기 판단 없이 그것을 orm으로 실행한다:
  `StepRunner::new(schema, connection)`는 그 step을 `connection`에서 실행하고, `run(step)`은 step 하나를 JSON 텍스트로
  받아 그 결과를 JSON 텍스트로 돌려준다. 질의 step은 `{"kind": "query", "query": <query>, "terminal": <terminal>}`이다.
  `<query>`는 `{"entity": <name>, "calls": [<call>, ...]}`이고, call은 각각 `Query`의 member와 그 인자이며 call의
  순서대로 실행된다(`{"call": "where", "chain": .., "values": [..]}`, `chain`과 `query`를 가진 `where_in`, `spec`을 가진
  `order_by`, `offset`과 `count`를 가진 `limit`, lock 넷, `add_all_columns`, `remove_all_columns`, `column`을 가진
  `add_column`, `remove_column`, `key_name`, `pair`를 가진 `match_pair`, `name`을 가진 `alias`, `query`를 가진
  `relation`과 `relations`, `column`과 `value`를 가진 `set`, `column`과 `revision`을 가진 `expect_revision`, `column`을 가진
  `group_by`, `connector`와 `query`를 가진 `where_group`).
  `<terminal>`은 `get`, `gets`, `get_count`, `create`, `update`, `delete` 가운데 하나다. 값은 `orm_value`의 case
  형식이다(CORE-71): `{"kind": <kind>, "value": ..}`이고, bytes는 `{"hex": ..}`, JSON 값은
  `{"kind": "json_value", "text": <JSON text>}`다. 결과는 `{"ok": <result>}`이거나, CORE-10의 kind(예: `duplicate_key`)를 가진
  `{"error": {"kind": <kind>, "message": <message>}}`이므로, 부탁한 코어가 실패의 뜻을 정한다. `get`과 `create`의 result는
  `{"row": <row>}`이고 행이 없으면 `null`이며, `gets`의 result는 collection의 순서와 그 key(CORE-89)를 가진
  `{"rows": [{"key": <key>, "row": <row>}, ...]}`, `get_count`의 result는 `{"count": <n>}`, `update`, `delete`, CORE-93의 step의
  result는 `{}`다. 행은 그 행이 읽은 열을 가진
  `{"values": {<column>: <value>}, "related": {<name>: <row> | null | [<row>, ...]}}`이다. step이 아닌 텍스트는 `config`다.
- **CORE-93** transaction step `{"kind": "transaction", "options": {..}}`는 뒤따르는 step을 callback이 실행하는
  transaction을 열고(CORE-20), savepoint step `{"kind": "savepoint"}`는 가장 안쪽 것의 savepoint를 열며 그 callback이
  뒤따르는 step을 실행한다(CORE-21). step `{"kind": "end", "rollback": <bool>}`은 가장 안쪽 것의 callback을 끝내며,
  `rollback`이 false이면 commit하거나 release하고 true이면 rollback한다. 그 결과는 그 끝의 결과다(예: commit의
  `deadlock`). option은 `isolation`, `read_only`, `timeout_ms`, 그리고 CORE-20의 audit 값의 map인 `audit`이다. step의
  transaction은 `retry` 0으로 실행된다. 부탁한 코어가 `deadlock`에서 그것을 다시 실행하기 때문이다. 열린
  transaction이 없을 때의 savepoint나 end는 `config`이고, `StepRunner::close`는 열린 것을 가장 안쪽부터 모두
  rollback하고, 그것들이 끝난 뒤 결과 `{"ok": {}}`이나 rollback의 첫 실패를 돌려준다. 열린 transaction을 가진 채 놓인
  runner는, 그 callback이 더는 step이 올 수 없음을 알 때 그것을 rollback한다. transaction step은 `Db` 위의 runner와
  열린 transaction이 없음을 요구한다. 중첩 transaction이 열 것은 savepoint step이 열기 때문이다. 그 밖은 `config`다.
- **CORE-94** `Query`의 `restore`와 `restore_or_create`는 생성된 모델의 것과 같다(INT-38, INT-39). `soft_delete` 설정이 있는 엔티티에서 `restore`는 `set`이 배정한 값의 restore 요청을 보내고 복원한 행을
  돌려준다. 그 key는 planner가 배정한 값이 가진 primary key와 unique key 가운데에서 고른다. 그 key의 행이 지워지지
  않았으면 그 행을 돌려주고 아무것도 쓰지 않으며, 그 key의 행이 없으면 `no_rows`다. `restore_or_create`는 한 transaction 안에서 그 key의 soft-delete된 행을 복원하거나, 그 key를 가진
  행이 없으면 배정한 행을 넣고, 그 행을 돌려준다. 그 key의 행이 지워지지 않았으면 `row_not_deleted`이고 아무것도 쓰지
  않는다. 둘 다 연결을 요구하기 전에 빈 list의 `empty_in` 같은 query의 조건을 거부한다. 둘 다 행을 돌려줄 때 배정을 비운다. `Db` step은 이 둘을 terminal `restore`와 `restore_or_create`로 받고 결과는
  `{"row": <row>}`다(CORE-92). `soft_delete`가 없는 엔티티는 `ir_invalid`다.
- **CORE-120** `Query`의 행의 `to_array()`는 map을 돌려준다. key는 행이 읽은 엔티티 열의 이름이고 순서는 schema의 순서이며,
  값은 `value(column)`이 돌려주는 `orm_value`다(CORE-62). 행이 읽지 않은 열은 key가 없다. 그래서 읽지 않은 열과 값이 null인
  열을 구별한다. relation 결과는 이 map의 key가 아니고 `related`와 `related_rows`가 돌려준다(CORE-88). 행을 읽지 않은
  `Query`는 빈 map을 돌려준다. 언어 구현의 `toArray`는 붙인 값(`new<Name>`, CORE-160)과 `parent_node` 자식의 열
  (CORE-157)도 가졌다. 코어의 `to_array`는 둘 다 가지지 않고, 행의 JSON 텍스트가 그것들을 쓴다(CORE-161).
- **CORE-150** `plus(column, value)`와 `minus(column, value)`는 다음 쓰기를 위해 열에 저장된 값에 `value`를 더하거나 뺀
  값을 배정한다. 언어 구현의 member `plus<Col>(n)`과 `minus<Col>(n)`이다(DSL-102). 배정은 요청의 `plus_p`나
  `minus_p`이고, 같은 열에 대한 `set`의 배정을 대신하며 `set`도 이것을 대신한다. `minus`는 음수 값을 저장하지 않는다.
  `update`가 이것을 받고, `duplication`에 준 `Query`도 받는다(CORE-151). 엔티티의 열이 아닌 이름은 `config`이고
  메시지는 `<column> is not a column of <entity>`다(CORE-91). 수가 아닌 열은 쓰기에서 `operator_not_allowed`이고
  메시지는 `plus/minus on <entity>.<column> (<type>)`이며, 그런 배정을 가진 `create`는 `ir_invalid`이고 메시지는
  `insert cannot assign <column> by plus or minus`다. insert에는 읽을 저장된 값이 없기 때문이다. 구현되지 않았다:
  `Query`의 `plus`와 `minus`. 생성된 Rust 모델은 `plus_<col>`과 `minus_<col>`을 가진다.
- **CORE-151** `duplication(query)`는 다음 `create`를 duplicate-key update가 있는 insert로 만든다. unique key 하나의 행을
  만난 행은 넣지 않고, 같은 엔티티의 `Query`인 `query`의 배정을 만난 행에 쓴다(DSL-105). 그 배정은 요청의
  `on_duplicate`이고 `create`가 그것을 비운다. 다른 엔티티의 `query`는 `config`이고, 배정이 없는 `query`는 `create`에서
  `config`이며 메시지는 `duplication model has no set_<col> values`다. `query`가 primary key의 열이나 identity 열에
  배정하면 `ir_invalid`이고 메시지는 `on_duplicate cannot assign <entity>.<column>`이며(DSL-113), 어떤 unique key로도
  행을 만날 수 없거나 둘 이상으로 만날 수 있는 insert는 `ir_invalid`이고 메시지는
  `on_duplicate needs exactly one conflict key`로 시작한다. `Query`의 조건은 DSL-162가 적은 대로 insert에 적용되고,
  조건을 만족하지 않는 행은 `condition_not_met`이다. 구현되지 않았다: `Query`의 `duplication`.
- **CORE-152** `update_optimistic()`은 엔티티의 update time 열이 행이 읽은 값을 아직 가지고 있는 동안에만 쓰는
  CORE-91의 `update`다. 언어 구현의 member `update(true)`이다(DSL-107, DSL-155). 그 값은 요청의 `optimistic`이고
  (PRT-7), 아무 행도 바꾸지 않은 문장은 `optimistic_lock`이며 메시지는 `row changed since it was read`다. 행을 읽지
  않은 `Query`, update time 열을 읽지 않은 행, 그 열이 없는 엔티티, `update`가 이미 쓴 행은 `config`이고 메시지는
  `update(true) requires a row loaded with its update time column`이다. 행을 먼저 다시 읽는다. `expect_revision`과
  함께 쓰면 `config`이고 메시지는 `expectRevision does not combine with update(true)`다(DSL-114). update time은 코어가
  쓰는 값이고 revision은 호출자가 가진 값이므로 둘은 서로 다른 member다. `Query`의 조건은 key에 이어지고(CORE-138),
  한 문장으로는 조건과 update time을 구별할 수 없으므로 조건을 만족하지 않는 행도 `optimistic_lock`이다.
  `update_optimistic`은 코어의 terminal의 이름이다. 생성된 wrapper가 호출 `update(true)`를 유지하는지는 generator의
  일이다. 구현되지 않았다: `Query`의 `update_optimistic`. 그 `update`는 인자를 받지 않는다. 생성된 Rust 모델은
  `update(optimistic)`을 가진다.
- **CORE-153** `delete_recursive()`는 `delete`처럼 `Query`의 행을 지우고(CORE-91), 그보다 먼저 그 행이 가진 relation
  결과(CORE-88)의 행을, 각 행이 가진 결과의 행과 함께 자식부터 지운다. 언어 구현의 member `delete(true)`이다
  (DSL-111). `delete_lock`(CORE-157)을 가진 자식의 결과는 남는다. 모든 문장은 `Query`의 연결의 transaction 하나에서
  실행되고, 연결이 `Tx`이면 savepoint에서 실행된다(CORE-21). 그래서 실패하면 아무것도 지우지 않으며, 그 행의
  `revision_changed`도 그렇다(DSL-114). 조건을 가진 `Query`의 행이 지워질 결과를 가지고 있으면 어떤 문장보다도 먼저
  `config`이고 메시지는 `a recursive delete of a row with cascading relations takes no conditions`다(CORE-138). 이것은
  자기 key의 행 하나를 지우고, 조건이 고른 행들을 지우지 않는다(CORE-138). `delete_recursive`는 코어의 terminal의
  이름이다. 생성된 wrapper가 호출 `delete(true)`를 유지하는지는 generator의 일이다. 구현되지 않았다: `Query`의
  `delete_recursive`. 그 `delete`는 인자를 받지 않는다. 생성된 Rust 모델은 `delete(recursive)`를 가진다.
- **CORE-154** `order_by_random()`은 행을 dialect의 함수로 무작위로 정렬하는 항목을 순서의 앞선 항목 뒤에 더한다
  (DSL-99). 요청의 항목 `random`이다. 이것을 가진 추가 열의 subquery는 `ir_invalid`이고 메시지는
  `a scalar column subquery may not order by random`이다. 구현되지 않았다: `Query`의 `order_by_random`.
- **CORE-155** `order_by_function(column, function, descending)`은 열의 열 함수로 정렬하는 항목을 순서에 더한다. 언어
  구현의 member `orderBy<Col>Asc(fn)`과 `orderBy<Col>Desc(fn)`이다(DSL-135). `function`은 DSL-144~DSL-147의 열 함수
  이름 `day_of_week`, `year`, `month`, `date` 가운데 하나이고, 항목은 그것을 `fn`으로 가진다. 엔티티의 열이 아닌
  이름은 `config`이고 메시지는 `<column> is not a column of <entity>`이며, 함수가 아닌 이름은 `function_unknown`이고,
  값 함수(DSL-137~DSL-140)는 `config`이고 메시지는 `order_by accepts a column function only`이며, 함수가 받지 않는
  타입의 열은 `operator_not_allowed`다(DSL-148). 각각 다음 terminal이 돌려준다. 구현되지 않았다: `Query`의
  `order_by_function`. 계약의 어떤 타입도 DSL-131의 함수가 아니다(CORE-84).
- **CORE-156** `force_index(name)`은 `Query`의 문장이 그 엔티티의 index나 unique key `name`을 쓰게 한다. 언어 구현의
  member `forceIndex<Name>()`이다(DSL-78). 요청의 query의 `force_index`이고, 마지막에 부른 것이 남는다. 엔티티의
  index도 unique key도 아닌 이름은 다음 terminal에서 `config`이고 메시지는 `<name> is not an index of <entity>`다.
  `Query`의 모든 builder가 엔티티에 없는 이름을 거부하는 kind다(CORE-82, CORE-87, CORE-89, CORE-91). planner만이
  메시지 `<entity>.<name>`의 `index_unknown`을 준다. 구현되지 않았다: `Query`의 `force_index`.
- **CORE-157** member 셋은 `relation`이나 `relations`에 준 `Query`를 어떻게 붙일지 정하며(CORE-88, PRT-14), 어느
  쪽에도 주지 않은 `Query`에는 효과가 없다. `parent_node()`는 `relation` 결과의 행을 그것을 가진 행에 합친다
  (DSL-84). 요청의 `flatten`이고, 이것에 따라 행의 JSON 텍스트(CORE-161)는 자기 member 뒤에 자식의 member를 쓰며 행이
  가진 이름은 자기 값을 지킨다(PRT-15). `relations`에 주면 `ir_invalid`이고 메시지는
  `relation <name>: flatten needs a one relation`이다. `group_limit(count)`는 부모의 행마다 자식의 순서에서 처음
  `count`개 행까지만 읽는다(DSL-86). 요청의 `limit_per_parent`다. `count`는 `uint`이고, 0이면 다음 terminal에서
  `config`이며 메시지는 `group_limit requires a positive count`다. 행 lock과 함께 쓰면 `ir_invalid`다(CORE-86,
  DSL-123). `delete_lock()`은 결과의 행을 `delete_recursive`에서 뺀다(CORE-153, DSL-87). 요청의
  `no_cascade_delete`다. 구현되지 않았다: `Query`의 `parent_node`, `group_limit`, `delete_lock`.
- **CORE-158** `possible(column, value)`는 `relation`이나 `relations`에 준 `Query`의 결과를 부모의 열 `column`이
  `value`와 같은 행에만 붙인다. 언어 구현의 member `possible<Col>(value)`이다(DSL-85). `column`은 부모 엔티티의 열이고
  `value`는 `orm_value`이며 열의 타입으로 비교한다. 요청의 `if_parent`이고(PRT-14), 마지막에 부른 것이 남는다. 어느
  쪽에도 주지 않은 `Query`, 곧 terminal의 root나 `where_in`의 subquery 같은 것에서는 다음 terminal에서 `config`이고
  메시지는 `possible applies only to a relation child`다. 부모 엔티티의 열이 아닌 이름은 부모의 다음 terminal에서
  `config`이고 메시지는 `<column> is not a column of <entity>`다(CORE-130). `Query`의 모든 builder가 엔티티에 없는
  열에 주는 kind와 메시지다(CORE-87, CORE-89, CORE-91). 행을 읽는 `value`만 `column_unknown`이다(CORE-83). 구현되지
  않았다: `Query`의 `possible`.
- **CORE-159** `fetch_key(function)`은 `gets`의 `Collection`을 primary key와 `key_name`(CORE-89) 대신 `function`이 각
  행에 대해 돌려주는 값으로 key하고, `fetch_value(function)`은 각 행의 값 하나를 계산하며 `Collection`은 그 값을 행
  옆에 그 key로 가진다(DSL-70). 함수는 행인 `Query`를 받고, 행과 그 relation 결과를 읽은 뒤 행의 순서대로 행마다 한
  번 불린다. 실패한 함수는 그 실패를 바꾸지 않고 terminal을 끝낸다. key는 `Key`의 값이다(INT-11). 둘 다 요청을
  바꾸지 않는다. `Db` step(CORE-92)에는 이것들의 형식이 없다. step은 data이기 때문이다. 구현되지 않았다: `Query`의
  `fetch_key`와 `fetch_value`. `Collection`과 `Key`는 선언되지 않았다(CORE-70).
- **CORE-160** `attach(name, value)`는 열이 아닌 이름으로 `orm_value`를 `Query`에 두고, `attached(name)`은 그것을
  돌려준다. 언어 구현의 member `new<Name>(value)`와 `get<Name>()`이다(DSL-101, DSL-115, DSL-44). 어떤 문장도 그 값을
  받지 않는다. `Query`가 읽는 행과 그 `create`가 돌려주는 행이 그 값을 가지고, 행의 JSON 텍스트(CORE-161)가 그것을
  쓴다. `to_array`는 열만 가진다(CORE-120). `Query`가 붙이지 않은 이름의 `attached`는 `None`을 돌려준다. 행의 이름은
  한 공간이다(DSL-128). 엔티티의 열, 추가 열, `Query`의 relation 결과인 `name`은 다음 terminal에서 `config`다
  (DSL-116, DSL-160). 구현되지 않았다: `Query`의 `attach`와 `attached`. 생성된 Rust 모델은 스캔한 소스가 부르는
  이름에 대해 `new_<name>`과 `get_<name>`을 가진다(DSL-156).
- **CORE-161** `Query`의 행의 `to_json()`은 그 JSON 텍스트인 object 하나를 돌려준다(COD-26). 행이 읽은 열, 그다음 붙인
  값(CORE-160), 그다음 이름별 relation 결과(행은 그 object, 행이 없으면 `null`, `relations`의 행들은 그 순서의 array),
  그다음 `parent_node` 자식의 member(CORE-157)를 쓴다. 한 번 쓴 이름은 다시 쓰지 않는다. codec stage가 있는 열은
  `{"kind":"sql-null"}`이나 `{"kind":"value","value":<value>}`로 tag를 붙여 쓴다. stage `json`의 값은 저장된 텍스트,
  곧 member의 순서와 수의 텍스트를 지킨다. `datetime(p)`는 PRT-69의 텍스트다. codec stage가 없는 bytes 열은
  `codec_encode`이고 메시지는 `<entity>.<column>: JSON output cannot write bytes`다. TypeScript 구현의 member
  `toJSON`과 `toJSONText`, PHP의 `toJson`, Python의 `to_json_text`는 이 member 하나다. 언어가 그 텍스트로 하는 일,
  예컨대 자기 `JSON.stringify`는 바인딩의 일이다. 구현되지 않았다: `Query`의 `to_json`.
- **CORE-162** `get_page_plan_steps(page, per_page)`는 `gets_page(page, per_page)`가 실행하는 plan의 step을 돌려주고
  문장을 보내지 않는다(DSL-159). plan의 순서대로 main step, count step, relation마다 step 하나이며, 각각 그 `role`
  (`main`, `count`, `relation`), 그 문장의 table 이름을 정렬한 `tables`, 그 `sql`의 record다. `gets_page`의 인자와
  거부를 그대로 받는다: 메시지 `gets_page requires a positive page and per_page`나
  `gets_page cannot be combined with limit`의 `config`, 연결이 없는 `Query`의 `config`(CORE-81), planner의 거부,
  markdown에서의 `capability_unsupported`. 연결의 request hook이 그 요청을 본다. 구현되지 않았다: `Query`의
  `get_page_plan_steps`. `gets_page`는 CORE-200이다.
- **CORE-163** 여러 열에 대한 조건, 곧 언어 구현의 member `tuple<ColA>With<ColB>(list)`(DSL-35)는 chain key
  `Tuple<ColA>With<ColB>`, `not in`이면 `NeTuple<ColA>With<ColB>`와 값 하나를 받는 `where`다. 그 값은 값 묶음의
  `list`이고 각 묶음은 열마다 값 하나를 가진 `list`다(CORE-82). list의 list가 아닌 값은 `codec_encode`이고 메시지는
  `the value of a condition is no list of value groups`이며, 빈 list는 `empty_in`이고 메시지는
  `tuple condition received an empty list`이고, 길이가 다른 묶음은 `config`이고 메시지는
  `every tuple needs one value per column`이며, 열이 둘보다 적은 key나 codec stage가 있는 열 또는 list 연산자가 없는
  열의 key는 `config`다. 각각 다음 terminal이 돌려준다. `Query`는 이것을 가진다.
- **CORE-170** 계약은 `Query`의 terminal `get`, `gets`, `gets_by`와 행의 `to_array`를 선언한다(CORE-83, CORE-120).
  `query.get`은 `query.get_by`처럼 행을 돌려주거나 아무것도 돌려주지 않는다. `query.gets`와 `query.gets_by`는
  `Query::gets_rows()`와 `Query::gets_rows_by(chain, values)`다. 이 둘은 `gets`와 `gets_by`를 실행하고 그 `Collection`을
  계약의 class `rows`인 `Rows`로 돌려준다. `rows`에는 행의 수 `len()`, 첫 행이나 없음을 돌려주는 `first()`, key의 행이나
  없음을 돌려주는 `get(key)`, 행의 순서대로 key를 돌려주는 `keys()`, 순서대로 행을 돌려주는 `values()`, 그 순서대로 각
  행의 `to_array`를 돌려주는 `to_array()`가 있다. key는 `orm_value`다: 정수 key는 `int64`, bool key는 `bool`, bytes key는
  `bytes`, 텍스트 key는 `text`이고, date-time key는 소수 자리가 여섯인 텍스트 `YYYY-MM-DD hh:mm:ss.ffffff`다. 행의 key는
  `key_name`의 열(CORE-89)의 값이고, 그것이 없으면 primary key의 값이다. 열이 둘 이상인 primary key의 key는 각 성분을
  타입의 tag와 길이를 붙여 이은 텍스트 하나다(`Key::of_values`). `get(key)`는 `int`를 같은 수의 `int64`로 받고, 텍스트를
  텍스트 key로 받으며 그 key의 행이 없으면 그 텍스트가 적는 date-time의 key로 받는다. 다른 종류의 값은 어떤 행의 key도
  아니므로 `get`은 아무것도 돌려주지 않고 어떤 kind도 내지 않는다. `Query`의 `to_array`는 계약의 map인 `orm_value`의
  `OrderedMap`을 돌려준다. `Query`에는 fetch key와 fetch value가 없으므로, `rows`가 `Query`의 `Collection`에서 빼는 것은
  `connect`, `delete`, JSON 텍스트뿐이다. 선언하지 않는 것: key와 값으로 하는 `rows`의 iteration(binding GN-6f). binding이
  `iterate` member의 case를 정하지 않았고 계약의 모든 group에는 case가 있어야 하기 때문이다(CORE-71). `keys()`와
  `values()`가 같은 쌍을 준다. case는 SQLite 데이터베이스에서 실행된다(CORE-129). member가 돌려준 행은 receiver가 instance
  value `{"from": <member>, "pick": [<step>]}`(binding GN-13f)인 `query.value`의 case로 관찰한다. step `"?"`는 optional의
  값이고 `{"index": n}`은 list의 항목이다. 코어의 case runner는 생성된 시험이 하듯 그런 값을 만든다. 이유: `query`의
  list는 key와 key로 찾는 일을 잃고, `Collection<Query>`에는 `core_type`이 적을 수 있는 Rust 경로가 없으므로, 코어가
  `Query`의 collection에 자기 타입을 준다.
- **CORE-200** `gets_page(page, per_page)`는 `Query`의 행 가운데 한 page를 읽고 모든 page의 행을 센다. 언어 구현의
  member `getsPage(page, perPage)`다(DSL-64, DSL-67, INT-32). 돌려주는 것은 `page`다: `rows`는 `gets`가 돌려주는
  그대로의 그 page의 행이고(CORE-83), `total_count`는 조건이 고르는 행의 수, `total_pages`는 `total_count`를
  `per_page`로 나누어 올림한 값, `page`와 `per_page`는 받은 그대로다. 요청은 `paginate`다(PRT-2): 행의 문장은
  `(page - 1) * per_page`개 행 뒤에서 `per_page`개 행을 읽고, count 문장은 같은 조건을 가지며 순서가 없다. 순서가
  없는 `Query`는 primary key 오름차순으로, key 열의 순서대로 정렬되므로 이어지는 page가 행을 되풀이하거나 건너뛰지
  않는다. 마지막 page 뒤의 page는 행이 없고 오류가 아니다. `page`와 `per_page`는 `uint`다. 어느 하나가 0이면
  `config`이고 메시지는 `gets_page requires a positive page and per_page`이며, `limit`(CORE-85)가 있는 `Query`는
  `config`이고 메시지는 `gets_page cannot be combined with limit`이고, `uint`의 범위를 넘는 offset은 `config`이고
  메시지는 `page offset exceeds u32 range`다. 각각 어떤 문장보다도, 그리고 연결을 구하기보다도 먼저다(CORE-81). 이
  terminal은 `Query`를 바꾸지 않는다(DSL-69). 계약에서 `page`는 class이고 그 member `total_count`, `total_pages`,
  `page`, `per_page`는 property이며 member `rows`는 unit `rows`를 돌려준다(CORE-70). `Db` step(CORE-92)에는 이것의
  terminal이 없다.
- **CORE-201** `group_by(column)`은 `Query`의 grouping에 열 하나를 더한다. 언어 구현의 member `groupBy<Col>()`이다
  (DSL-99). `gets_count()`는 조건이 고르는 행의 group마다 행 하나를 돌려준다. member `getsCount()`다(DSL-61, INT-31,
  INT-68). 요청은 `group_count`이고 그 `group_by`는 부른 순서대로 열을 가진다(PRT-2). group 행은 map이다: grouping
  열마다 그 이름으로 `value`가 그 열에 돌려주는 `orm_value`를 가지며(CORE-62, CORE-83) null도 그렇고, 그다음에 그
  group의 행 수인 `row_count`를 `int64`로 가진다. 다른 열은 없고 엔티티의 행이 아니다(INT-68). 행은 `Query`의
  순서대로이고, 순서의 항목은 grouping 열만 가리킨다. 다른 열은 `ir_invalid`이고 메시지는
  `order by <column>, which is not a group column`이다. `group_by`가 없는 `Query`의 `gets_count`는 `ir_invalid`이고
  메시지는 `group_count needs group_by`다. group된 `Query`의 `get_count`는 group의 수를 세고(PRT-2), 그 밖의 모든
  terminal은 `ir_invalid`이며 메시지는 `group_by is only valid on count or group_count, not <kind>`다. `gets_page`도
  그렇다(CORE-200, DSL-99). `relation`, `relations`, `where_in`에 준 group된 `Query`는 `ir_invalid`이고 메시지는
  `group_by is only valid on the request's root query`다. 엔티티의 열이 아닌 이름은 다음 terminal에서 `config`이고
  메시지는 `<column> is not a column of <entity>`다(CORE-87). 0 이상의 정확한 정수가 아닌 count는 `codec_decode`다
  (INT-68). `Db` step은 `column`을 가진 call `group_by`를 받고(CORE-92) `gets_count`의 terminal은 없다. 계약은 group
  행을 `orm_value`의 map의 list로 돌려준다. Rust 값 `Val`을 가진 `GroupRow`와 `GroupRows`는 선언하지 않는다(CORE-70).
- **CORE-202** `where_group(connector, query)`는 같은 엔티티의 `Query`인 `query`의 조건을 괄호로 묶은 group 하나로
  더한다. 언어 구현의 member `and(fn)`과 `or(fn)`이다(DSL-15, DSL-21). `connector`는 `where_none`이 받는 낱말 `""`,
  `And`, `Or`다(CORE-137): `And`와 `Or`는 group을 앞선 조건에 잇고, 첫 조건인 group은 connector를 받지 않으며(DSL-18),
  다른 조건 뒤의 `""`는 `config`이고 메시지는 `condition without and/or after another condition`이다(DSL-19). 그 밖의
  텍스트는 `config`이고 메시지는 `where_group takes "", "And" or "Or", not <text>`다. group은 `query`의 조건을 그
  순서와 connector대로 가진다. `where`, `where_in`, `where_none`, `where_group`의 조건이므로 group은 겹친다. `query`의
  다른 것은 가지지 않는다: 그 순서, 열, limit, lock, grouping, 배정, relation, 연결은 효과가 없다. 언어 구현은 함수에
  빈 모델을 주고 함수가 그 위에 group을 만든다(DSL-20). 코어는 `where_in`이 subquery를 받듯(CORE-90) 만들어진
  `Query`를 받으므로 함수를 보관하지 않고, `Db` step은 group을 data로, 곧 `connector`와 `query`를 가진 call
  `where_group`으로 나른다(CORE-92). 조건이 없는 `query`는 `config`이고 메시지는
  `the query of where_group has no condition`이며(DSL-22), 다른 엔티티의 `query`는 `config`이고 메시지는
  `where_group takes a query of <entity>, not of <other>`이고, member가 실패시킨 `query`는 그 오류로 `Query`를
  실패시킨다. 각각 다음 terminal이 돌려준다. group의 조건은 모든 조건처럼 `update`와 `delete`에도 적용된다(CORE-138).

## 상태 기계

CORE-100부터 CORE-105의 구현은 `packages/rust/src/tx/machine.rs`에 있고, 계약은 세 member에 `machine`을 적는다.
고정된 `polyspec-binding-core` 0.0.4는 `Passthrough`, `Step::Await`, `Machine::settle`을 제공한다. 검증은 아직
완료하지 않았다. core의 시험이 각 machine을 한 단계씩 구동하고, contract는 `db.transaction`과 `db.close`의
case를 SQLite 데이터베이스에서 가진다(CORE-129). `tx.savepoint`는 case가 없다. case가 이름할 수 있는 `tx`를 주는 member가 없기 때문이다.

- **CORE-100** 계약의 멤버 `db.transaction`, `tx.savepoint`, `db.close`는 `core`에 `"machine": true`를 이름한다. 셋 다
  `wait: async_driver`이고 언어 코드에 닿기 때문이다: 앞의 둘은 언어의 함수를 호출하고, `Db`나 `Tx`의 instance는 멤버가
  실행되는 동안 언어 코드가 가진다. 계약에서 receiver는 `&self`로 남는다: 생성 코드는 instance가 가진 값의 clone을 코어
  함수에 주며, clone은 instance에 되쓰지도 않고 instance를 소비하지도 않으므로, 멤버가 실행되는 동안 instance를 계속 쓸 수
  있다.
- **CORE-101** `Db`와 `Tx`는 clone이 하나의 상태를 공유하는 `Clone` handle이다. `Db`의 clone은 pool, 닫힘 상태(CORE-31),
  plan cache, `stats`의 counter를 공유하고, 각 clone은 자기가 복제된 handle의 request hook과 취소(CORE-45)를 가진다. `Tx`의
  clone은 트랜잭션, 두 번째 문장을 `busy`로 거부하는 CORE-22의 상태, 그리고 handle을 받은 콜백이 돌아왔는지(CORE-23)를
  공유한다. 그래서 clone을 통한 문장은 그 handle을 통한 문장이다.
- **CORE-102** 세 멤버의 코어 함수는 receiver를 값으로 받고, 인자를 소유하는 상태 기계(`binding_core::machine::Machine`)를
  돌려준다:
  - `Db::transaction(self, callback: F, options: TransactionOptions)`. `Done`은
    `Result<binding_core::Passthrough, Failure<E>>`이다.
  - `Tx::savepoint(self, callback: F)`. `Done`은 같다.
  - `Db::close(self)`. `Done`은 `Result<(), E>`이다.
  `F`는 `FnMut(Tx) -> Result<binding_core::Passthrough, Failure<E>>`이고, `E`는 코어의 error인 `polyspec_orm::Error`로,
  kind와 메시지 전체를 가진다(CORE-12). `Passthrough`는 코어가 옮기기만 하고 읽지 않는 언어의 값이다: 콜백이 돌려준 값이
  멤버가 돌려주는 값이다. Rust 코드가 await하는 함수는 콜백이 future를 돌려주는
  `Db::transaction_async(&self, callback, options)`와 `Tx::savepoint_async(&self, callback)`, 그리고
  `Db::close_async(&self)`다. 셋은 CORE-20부터 CORE-26과 CORE-31의 규칙을 그대로 따르고 계약의 멤버가 아니다. CORE-93의
  step runner가 앞의 둘을 호출한다.
- **CORE-103** `Db::transaction`과 `Tx::savepoint`의 상태 기계는 다음 단계를 내고, 스스로 I/O를 하지 않는다:
  1. `Io`: 시작. 연결을 빌리고 옵션과 함께 `BEGIN`을 보내거나(CORE-20), CORE-22와 CORE-23의 검사 뒤에 `SAVEPOINT`를
     전송한다. 시작이 실패하면 기계는 `Done(Err(Failure::Kind))`로 끝나고 콜백은 실행되지 않는다.
  2. `Call`: `Machine::call`이 기계를 구동하는 스레드에서 트랜잭션이나 savepoint의 handle `Tx`로 `callback`을 호출하고,
     돌려받은 것을 보관한다.
  3. 콜백이 `Ok(value)`를 돌려주면 `Await(value)`. driver는 자기 언어에 awaitable이 있으면 그 값을 기다리고, 다음 단계
     전에 결과를 `Machine::settle`에 준다: `Ok(value)`는 awaitable이 낸 값이거나, awaitable이 없는 언어에서는 같은 값이다.
     `Err(raised)`는 awaitable이 던진 예외다.
  4. `Io`: 끝. `Ok(value)` 뒤에는 `COMMIT`이나 `RELEASE SAVEPOINT`를 보내고, 기계는 `Done(Ok(value))`로 끝난다. 콜백의
     실패, 곧 2단계의 `Err(Failure::Kind)`나 `Err(Failure::Raised)` 또는 3단계의 `Err(raised)` 뒤에는 `ROLLBACK`을, 또는
     `ROLLBACK TO SAVEPOINT`와 `RELEASE SAVEPOINT`를 보내고, 기계는 그 실패를 그대로 가지고 끝난다: `settle`이 받은 예외는
     `Done(Err(Failure::Raised))`로 끝나므로, 호출자는 같은 예외 객체를 받는다. 롤백도 실패하면 결과는
     `rollback_failed`(CORE-25)이고, 그 `callbackError`가 이 실패다.
  콜백의 handle은 4단계가 문장을 보내기 전에 끝난다(CORE-23). 기계가 실패로 끝날 때 가지고 있던 `Passthrough`는 drop되고,
  그 drop이 언어 쪽의 값을 놓아 준다.
- **CORE-104** CORE-24의 재시도는 CORE-24가 적는 대로 기다리는 `Io` 단계 뒤에 1~4단계를 다시 하는 것이다: 기계는 시도마다
  `callback`을 한 번 호출하며(`F`가 `FnMut`인 이유다), commit이 `deadlock`으로 실패한 시도의 값은 drop한다. 실패
  `Failure::Raised`는 코어에게 kind가 없으므로, 언어 코드가 잡지 않은 콜백 문장의 예외는 kind가 `deadlock`이었어도 바인딩을
  통해서는 재시도되지 않는다: 계약은 `callback`의 함수 타입에 `errors.recognize`를 적지 않는데, 생성기가 `machine`과 함께
  이를 거부하기 때문이다. 이것이 적힐 때까지 CORE-24는 바인딩을 통해서는 commit의 `deadlock`에만 성립한다.
  `db.transaction`의 매개변수 `options`가 required로 남는 이유도 같다: 생성기는 `machine`이 있는 멤버의 default 있는
  매개변수를 거부하므로, 옵션을 정하지 않는 호출자는 빈 record를 넘긴다.
- **CORE-105** `Db::close`의 상태 기계는 `Io` 단계 하나, 곧 CORE-31의 pool 닫기를 내고 `Done(Ok(()))`로 끝난다. 언어 코드를
  호출하지 않으므로 `Call`도 `Await`도 내지 않고, 그 `settle`은 호출되지 않는다.

- **CORE-127** binding member `db.execute`는 database handle, compiled-step text, parameter 값을 소유하는 machine인
  `Db::execute_text_machine(self, step: String, params: Vec<OrmValue>)`를 사용한다. 첫 advance는 기존 `execute_text`
  로직을 호출하는 `Io` future 하나를 준다. parse, step 검증, scalar 변환 순서(FMS-42)를 보존한다. 다음 advance는
  그 결과를 바꾸지 않은 `Done(Result<(), Error>)`를 준다. `Call`이나 `Await`를 주지 않으며 생성이나 advance에서
  I/O를 하지 않는다. contract의 receiver는 `&self`로 유지한다. binding은 handle을 clone하고 호출자는 자기 instance를
  유지한다. native Rust `execute_text(&self, &str, Vec<OrmValue>)`는 native future API로 남는다. `Io`를 주기 전에
  machine을 drop하거나 poll하지 않은 소유 future를 drop하면 statement를 보내지 않는다. 반환한 `Io`는 machine과
  독립적으로 입력을 소유하고 machine을 drop한 뒤에도 완료할 수 있다. driver는 그 future도 drop하여 취소한다.
  취소는 이미 실행한 statement를 되돌릴 수 없다.

`Db::execute_text_machine`은 구현되었으며 native 실행 artifact 세 case를 통과한다. contract는 이 소유 constructor를
`machine: true`로 표시한다. 커밋된 native machine owner는 execute artifact 4개, transaction/savepoint/close artifact 18개, 준비 artifact 2개, 기존 dbspec 일치 3개를 포함한 27개 case에서 실패와 skip 없이 통과한다. 이 member의 생성된 binding runtime 검증은 끝나지 않았다.

- **CORE-128** SQLite row-lock-table 준비가 성공하면 CREATE statement를 실행한 실제 connection lease를 준비 완료 전에 반환한다. 따라서 독립된 operation이 없을 때 완료한 transaction-opening I/O는 의도한 transaction lease만 보유한다. 취소나 오류는 반환하지 않은 준비 lease를 폐기한다. 이 규칙은 pool 소유권에 관한 것이며 SQLite worker 종료 수신을 뜻하지 않는다. 준비는 statement 관찰 전에 연결을 얻는다. 연결 획득 실패(`closed` 또는 `pool_timeout`)는 SQL을 보내거나 statement event를 발행하지 않으며 server 오류 변환이나 subscriber 오류 대체를 거치지 않는다. INT-91이 전송부터 결과까지 측정하므로 statement elapsed는 pool 연결 대기를 제외한다.

준비 반환 helper와 gate로 제어한 실제 lease 시험, 닫힌 pool 관찰 시험을 구현했으며 커밋된 native machine owner에서 통과했다. 이는 pool 소유권과 관찰을 입증하며 물리적 SQLite worker 종료를 입증하지 않는다.

## 인터페이스 계약

- **CORE-70** 코어의 인터페이스 계약은 `packages/rust/interface.json`이다. 계약은 코어가 가지고 있고 시그니처의 모든
  타입이 계약의 타입인 unit과 member만 선언한다. 값 alias `orm_value`(CORE-62)와 그것을 받거나 돌려주는 `Query`의
  member를 선언한다: `where`, `value`, `get_by`, `get_count_by`. CORE-85~CORE-91의 `Query` member와 CORE-92, CORE-93의
  class `StepRunner`를 선언한다. `StepRunner`의 case는 SQLite 데이터베이스에서 실행된다(CORE-129). [flowmark가 쓰는 surface](flowmark-surface.ko.md) FMS-7의 unit과 member는 그 문서가 적은 대로 선언한다. 시그니처의 타입이 아직 계약의 타입이 아니어서 선언하지
  않는 것: `Tx::run`(table은 빌린 텍스트이고 행은 열이 없는 cell의 list다),
  `Db::subscribe`(자기 문장을 빌리는 event), `Db::with_request_hook`(protocol의 request), `Key`, `GroupRow`, `GroupRows`, `Statement`(그 값이 Rust 값
  `Param`과 `Key`다). `Utils`와 그 부분은 자기 handle을 빌리므로 이것들도 선언하지 않는다. `Query`의 terminal `get`, `gets`,
  `gets_by`와 행의 `to_array`는 선언하고, `gets`와 `gets_by`는 class `rows`를 돌려준다(CORE-170). `Collection`, `Page`,
  `LookaheadPage`는 타입으로 선언하지 않는다: 각각 자기 모델에 대해 generic이어서 `core_type`의 Rust 경로가 적을 수 없고,
  `Query`에서 page를 돌려주는 terminal은 `gets_page`뿐이고 그 `Page`는 class `page`다(CORE-200). `get_query`는 `Statement`를 돌려주므로 선언하지 않는다.
- **CORE-133** member `tx.execute`는 `Tx::execute_text_machine(self, step: String, params: Vec<OrmValue>)`이다. 이것은
  `Db::execute_text_machine`이 `Db::execute_text`를 실행하듯 `Tx::execute_text`를 실행한다(CORE-127). step과 parameter는
  `db.execute`가 읽는 대로 읽고, 문장은 handle의 트랜잭션에서 실행된다. 이유: `db.transaction`의 callback은 handle로만
  자기 트랜잭션에 닿으므로, callback의 문장에는 `tx`의 member가 필요하다.
- **CORE-131** 계약의 record `config`는 `Config`이다. 기본값이 있는 field는 `Option<T>`이고, 빠진 field는 `None`을
  받는다(binding GN-6i). `Db::connect`와 `Db::connect_schema`는 각 `None`을 그 field의 `default_core`가 이름하는 상수로
  정하고, `aes_keys`는 정수 key의 `KeyedMap<String>`이다. 연결은 이것을 key ring으로 읽고, `i32`가 아닌 key는
  `config`로 거절한다. field `audit_source`는 CFG-8의 audit 값을 `OrderedMap<OrmValue>`로 돌려주는 parameter 없는
  함수의 `Option`, 곧 `Box<dyn Fn() -> Result<OrderedMap<OrmValue>, Failure<Error>> + Send + Sync>`이다(binding GN-6z).
  연결은 이것을 `Arc`에 보관한다. `TransactionOptions`의 field `audit`는 `Option<OrderedMap<OrmValue>>`이다(INT-44). 각
  audit 값은 `orm_value`의 scalar이고, 다른 값은 `codec_encode`이다. `db.transaction`의 machine은 `BEGIN`을 보내기 전에
  자기를 구동하는 thread에서 `Call` step으로 source를 부르고(CORE-103), raise한 source는 그 실패를 바꾸지 않고
  트랜잭션을 끝낸다. 이유: binding은 계약의 field만으로 record를 만들고 기본값이 있는 field를 `None`으로 주며, 언어의
  함수는 그 언어 코드의 thread에서만 부를 수 있다.
- **CORE-132** member `db.connect`와 `db.connect_schema`는 machine `Db::connect_machine(dsn: String, pool_size: u32,
  cfg: Config)`와 `Db::connect_schema_machine(dsn: String, schema: Schema, pool_size: u32, cfg: Config)`이다(binding
  GN-6ab). 이 machine은 borrow `value`(GN-6h)로 받은 schema를 포함해 자기 인자를 소유하고, `Db::connect`와 `Db::connect_schema`를 `Io` step
  하나로 실행한다. 언어 코드는 부르지 않으며, 결과는 native 형식의 결과다. 이유: `Config`가 함수 `audit_source`를
  가지므로, binding은 이 member를 언어 코드에 닿는 member로 세고(GN-6q) machine으로 구동한다.
- **CORE-134** crate `polyspec-orm`은 기본으로 켜진 feature `runtime`을 가진다. 이 feature는 statement를 실행하는
  것을 담는다: sqlx, tokio의 network와 multi-thread runtime, rustls, AES-GCM, 그리고 연결을 열거나, statement,
  transaction, query를 실행하거나, 연결로 catalog를 읽거나 dbspec을 적용하는 module이다. 계약은 target `wasm`의 core를
  feature 없이 build한다(`core.features` `{"wasm": []}`, binding I-1). 그래서 WASM module은 browser에 platform I/O가
  없는 `wasm32-unknown-unknown`에서 compile된다(binding GN-4b). target `wasm`은 dbspec 편집 연산인 unit `orm`,
  `error_kind`, `value`, `integer_value`, `float_value`, `dbspec`, `runtime_model`을 담는다. 다른 모든 unit은 `wasm`을
  뺀 `only`와 이유 CORE-134를 가진다(binding Q-4). 이유: dbspec 연산은 editor가 browser에서 실행하는 것이고(plan
  OM-1.2, F-15), 연결이 필요한 member는 거기서 닿을 database가 없다. 선언된 target 집합은 각 target의 coverage를
  사실대로 적지만, case를 가리는 mask나 오류를 내는 stub은 그렇지 않다(T493-8).
- **CORE-135** `db.transaction`의 kind `rollback_failed`는 callback이 실패한 transaction의 rollback이 driver에서
  실패할 때만 생기며, case의 어떤 입력도 그것을 만들지 못한다. 그래서 core는 그 rollback 뒤에 fault injection point
  `orm.rollback`(`polyspec_orm::fault::ROLLBACK`, `broken`으로 주입, binding G-5, point의 형식은 CORE-121)을 둔다.
  그 자리는 rollback을 실패로 보고하여 callback 오류와 rollback 오류를 가진 `rollback_failed`를 raise한다(CORE-25).
  legacy client는 같은 실패를 실패한 rollback의 test entry point로 시험한다
  (`legacy/packages/python/tests/test_rollback_fault.py`, `legacy/packages/php/tests/RollbackTest.php`).
- **CORE-136** core의 case runner(`packages/rust/tests/unit/interface_cases.rs`)는 binding GN-13pa의 이름 있는
  instance를 받는다. receiver 다음에 만들어지는 `with`의 값, 안쪽 fixture의 step을 위해 자기 인자에 이름을 붙이는
  function fixture의 `names`, `"on": "<name>"`을 가진 step과 `after`의 호출, 인자 `{"bound": "<name>"}`, 그리고
  `raises`를 가진 step이다. `raises`를 가진 step 다음에는 다음 step이 실행된다(GN-13o). core의 JSON은 key 순서를 지키지
  않으므로 `with`의 값은 다른 값을 이름하지 않는다. `db.transaction`의 case는 callback의 handle에 connect되어 callback이
  돌아온 뒤 호출되는 query에 `transaction_ended`를 주고(CORE-23), handle의 savepoint callback이 도는 동안 그 handle의
  statement에 `busy`를 준다(CORE-22).
- **CORE-71** 계약의 case는 계약의 `cases`가 이름하는 `contracts/interface/core.json`의 group이며 binding의 case
  형식을 따른다: case의 키는 그 member의 parameter이고, receiver는 인스턴스 값이며, 실패는 kind, category, message
  전체(CORE-12)를 적는다. `after`의 호출은 method를 부른 뒤의 receiver를 관찰하고, 각각 `{call, args, result}`다.
  receiver가 없는 member는 `after`를 적지 않는다. 그 member가 돌려준 인스턴스는 그것을 receiver로 만드는 method의
  case가 관찰한다(binding G-5). 코어는 그 모든 group을 계약이 이름하는 함수로 실행하고, 시험이 부를 수 없는 member를
  이름하는 group은 실패한다.
- **CORE-72** 폐기됨, CORE-129로 대체: case 형식이 이제 case의 디렉터리에 있는 SQLite 데이터베이스를 이름한다.
- **CORE-129** SQLite 데이터베이스가 필요한 case는 그 시험의 디렉터리에 있는 파일 `shop.db`에서 실행된다: 그 DSN은
  조합 텍스트 `{"text": ["sqlite://", {"case_path": "shop.db"}]}`이고(binding GN-13l), 그 `db`의 instance 값은 호출
  전에 `db.execute`로 case의 표와 행을 만든다. 그런 group의 `cases` 행은 `wasm`을 뺀 `only`를 가진다. `wasm`의
  코어에는 파일 시스템이 없기 때문이다. 데이터베이스 서버가 필요한 case는 binding GN-13j의 service를 기다리고,
  case가 `tx` handle을 거쳐서만 닿는 kind는 case 형식이 그것을 줄 때까지 case가 없다. 어떤 member도 `tx`를
  돌려주지 않고, 함수 값의 step은 그것을 다른 member에 넘길 수 없기 때문이다(T500).
- **CORE-130** 계약의 member의 `raises`는 그 member의 경로가 돌려주는 kind만 이름한다. 읽기 `get_count`,
  `get_count_by`, `get_by`는 `SELECT` 하나를 보내고 `read_only`를 포함한 쓰기의 kind를 내지 않는다. `condition_not_met`의 조건은 insert만
  검사하므로 `update`, `delete`, `restore`는 그것을 내지 않는다. `restore`는 지워지지 않은 행을 그대로 돌려주므로
  `row_not_deleted`는 `restore_or_create`만 raise한다. `restore_or_create`는 복원한 행을 자기 transaction에서 읽으므로
  `no_rows`를 내지 않는다. `db.execute`는 `Db`에서 실행되어 `Tx`만 내는 `busy`와 `transaction_ended`를 내지 않는다. `Query`의 어떤 member도 `column_unknown`을 내지 않는다.
  builder가 terminal이 entity를 읽기 전에 모르는 열을 `config`로 거부하기 때문이다(CORE-82). `db.connect`와
  `db.connect_schema`는 `capability_unsupported`를 내지 않는다. core는 link한 SQLite가 3.46 이상임을 build 때
  확인하므로(DSL-150) 어떤 연결도 더 오래된 SQLite를 만나지 않는다. `db.connect_schema`는 `schema_invalid`를 내지 않는다. 계약의 schema는 `Schema::load`가 만들고,
  그것은 manifest가 아닌 텍스트를 연결 전에 거부한다. `get_count`와 `get_count_by`는 행 잠금에 `lock_not_available`이
  아니라 `ir_invalid`를 raise한다. 요청의 검증이 count의 잠금을 거부하기 때문이다(`packages/rust/src/engine/validate.rs`).
  `restore_or_create`는 실패 뒤 transaction을 되돌릴 수 없을 때, 서버가 끝낸 session에서처럼, `rollback_failed`를 raise한다.
- **CORE-121** 코어는 어떤 입력도 닿지 않는 category `internal`의 분기에 fault injection point를 두어, 계약의 case가
  그 point를 설정하고 그 분기가 일으키는 오류의 kind, category, message를 확인하게 한다(binding G-5, X-1). point는
  module `polyspec_orm::fault`의 상수를 받는 `binding_core::fault::point!`다. point는 코어의 feature `fault-test`가
  켜진 빌드에서, case가 설정한 호출에서만 발동한다. 그래서 그 feature가 없는 빌드와 case가 설정하지 않은 호출은
  point를 통해 그 분기를 타지 않는다. 계약의 `faults`가 point를 적는다: `orm.internal`은 상수
  `polyspec_orm::fault::INTERNAL`이고 `broken`으로 주입되며, planner에서 step이 읽는 행의 열 하나를 projection되지
  않은 것으로 다뤄 `internal`을 일으킨다. `runtime_model.compile`의 case
  `a_column_that_the_plan_does_not_project_is_internal`이 그것을 설정한다. 코어의 case runner는 생성된 binding 시험처럼
  case의 fault를 그 member의 호출에 대해 설정하고, 그 호출의 poll마다 설정을 설치하며, fault가 발동하지 않은 case를
  실패시킨다. 코어는 feature `fault-test`를 켠 자신을 dev-dependency로 가지므로, flag 없는 코어의 `cargo test`가 그
  point를 설정한다(binding CK-65).
