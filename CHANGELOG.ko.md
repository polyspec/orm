# 변경 이력

## 미발행 — MySQL CHECK constraint namespace

Go `get`이 일치하는 행이 없을 때 `(nil, nil)` 대신 adapter 중립 `NO_ROWS` 오류를 반환하도록 한다. Go generator·generated model 주석·예제와 SQLite 계약 테스트를 함께 갱신해 호출자가 없는 model을 실수로 역참조할 수 없게 하며, API는 모든 database adapter에서 동일하게 유지한다.

모든 `*_nowait` 행 잠금 요청이 즉시 잠금을 얻지 못할 때 사용하는 adapter 중립 `LOCK_NOT_AVAILABLE` 오류를 추가한다. Go는 `orm.IsLockNotAvailable`을 제공하며 PostgreSQL `55P03`, MySQL `3572`, SQLite ORM row-lock 충돌을 호출자의 driver 검사 없이 매핑한다. 이 상태는 transaction 재시도 신호가 아니다.

`DB.BackendWaitingForLock`이 `wait_event_type`만 보지 않고 backend activity와 join한 PostgreSQL `pg_locks`의 미허용 lock을 확인하도록 보완했다. 따라서 table-lock wait도 caller adapter 경계를 바꾸지 않고 관찰한다.

생성하는 MySQL CHECK constraint 물리 이름에 table 이름을 접두어로 붙여 서로 다른 entity가 같은 논리 check 이름을 선언해도 database 범위 충돌이 발생하지 않도록 한다. PostgreSQL과 SQLite는 선언한 물리 이름을 유지한다.

- CI 벤치 데이터베이스를 모든 단계에 구성한다. 워크플로는 `ORM_BENCH_MYSQL_DSN`을 작업 수준에 두므로 `make feature-check` 안의 성능 기준 검증이 로컬 소켓 기본값에서 실패하지 않고 시드된 MySQL에 접근한다.

- 선언된 커밋 제목 규칙을 강제한다. `make git-check`는 `contracts/rules.json`에 기록된 기준점 이후의 모든 제목이 `type: concise English description` 형식과 기록된 길이 한도를 지키는지 검사하고, CI에서 계약 검사와 함께 실행된다. 규칙 목록은 AES 버전 컬럼 검사를 실제로 실행하는 대상의 이름도 바로잡는다.

- `make client-db-check`가 TypeScript 클라이언트 데이터베이스 테스트를 실행한다. 검사는 Go, PHP, Rust만 실행하던 언어 선택을 제거하므로 하나의 검사가 모든 언어의 클라이언트 테스트를 MySQL, PostgreSQL, SQLite로 실행한다.

- 기능 검사가 테스트 언어 동등성을 강제한다. 검사는 Go, PHP, Rust, TypeScript의 테스트 루트를 훑고, 클라이언트 `pass`·`partial` 주장이 그 언어의 테스트를 지명하지 않거나, `implemented` 기능이 어느 클라이언트에서든 `pass`가 아니거나, 언어 테스트 파일이 어느 기능에도 속하지 않으면 실패한다. 기능 목록은 `audit_triggers`, `point_type`, `interface_contract`, `performance_gate`를 추가하고 모든 클라이언트 주장은 그 언어의 테스트나 공통 적합성 벡터·스키마 사례 기록을 지명한다.

- PHP, TypeScript, Rust 클라이언트에서 소프트 삭제를 테스트한다. 읽기는 `deleted_at`에 값이 있는 행을 걸러내고 삭제는 값이 없는 행에 타임스탬프를 설정하는 보호된 UPDATE로 다시 쓴다. Rust 테스트는 SQLite에서 모델 클라이언트를 실행하고 수행된 모든 문을 검사한다.

- PHP 성능 검사의 네이티브 기준 코드는 클라이언트 조립과 같은 타입 변환을 수행한다. 기준 코드는 셀을 디코딩하고 행 값으로 변환하므로 클라이언트와 기준 코드의 비율은 클라이언트 기계 부분만 잰다. 측정 비율(PHP 8.4.25, 로컬 소켓: PK 1.20–1.31, 100행 1.06–1.12)에 따라 100행 한도를 1.50에서 1.25로 바꾼다.

- TypeScript 클라이언트는 Node.js 22.16 이상을 요구한다. 드라이버가 쓰는 문 옵션(`setReturnArrays`)을 모두 제공하는 `node:sqlite`의 첫 릴리스이다. `orm-gen`은 Node 22가 `node:sqlite`에 대해 내는 실험 기능 경고를 출력하지 않으므로 지원하는 모든 Node 릴리스에서 같은 출력을 낸다. `make ts-min-check`는 지원하는 가장 낮은 릴리스에서 TypeScript 테스트를 실행한다.

- 클라이언트 데이터베이스 테스트는 MySQL과 PostgreSQL을 필수로 요구한다. `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN` 중 하나가 없으면 Go, PHP, Rust, TypeScript 테스트는 SQLite만 실행하지 않고 그 변수 이름을 알리며 실패한다. SQLite 감사 UPDATE는 저장된 바이트로 비교하므로 `NOCASE` 컬럼에서 대소문자만 바뀐 변경도 기록된다.

- 문을 제한하고 취소한다. 연결 설정은 `poolSize`와 `statementTimeoutMs`를 받고, 흐름은 연결 핸들로 취소한다. Go는 `db.WithContext(ctx)`, TypeScript는 `db.withSignal(signal)`, Rust는 문의 future를 버린다. 취소나 시간 제한으로 중단된 문은 새 오류 코드 `CANCELED`를 반환한다. PHP 취소는 아직 구현하지 않았다.

- 컬럼 타입 `jsontext`를 추가한다. JSON을 그 텍스트 그대로 저장하며 PostgreSQL은 `text`, MySQL은 `LONGTEXT`, SQLite는 TEXT를 쓴다. 그래서 멤버 순서, 중복 키, 빈 객체와 빈 배열의 구분이 세 데이터베이스에서 유지된다. 타입 `json`은 거부하고 `jsontext`를 안내한다. `import`는 PostgreSQL `json`·`jsonb`, MySQL `JSON`, json 코덱을 가진 텍스트 컬럼을 이 타입으로 읽는다. 감사 행은 JSON 텍스트 컬럼을 모든 방언에서 JSON으로 기록한다.

- 모델이나 묶음의 시작 위치에 있는 연결자를 무시한다. 첫 조건 자리의 `and(fn)`, `or(fn)`, `and()`, `or()`, 접두어가 붙은 체인은 모두 첫 조건으로 읽는다. 두 조건 사이의 연결자 누락과 뒤따르는 조건이 없는 연결자는 그대로 `CONFIG`를 반환한다.

- 감사 트리거를 스키마 지시문으로 추가한다. `%% orm:audit_log`는 작업 테이블, 변경 테이블, 작업 식별자를 담는 트랜잭션 설정을 지정하고, `%% orm:audit`는 엔티티에 대한 모든 쓰기에 작업을 요구하며 `changes` 모드에서는 이전 행과 새 행을 JSON 경로를 가린 채 기록한다. DDL, `install()`, `diff`, `migrate`, `import`, `validate`가 MySQL, PostgreSQL, SQLite에서 이를 다룬다. `%% orm:immutable`은 MySQL에서도 갱신과 삭제를 거부한다. MySQL은 `uuid` 컬럼을 `char(36)`으로 저장하고, TEXT·BLOB·JSON·geometry의 리터럴 기본값을 식으로 기록하며, 스키마로 한정한 테이블의 데이터베이스를 만든다. SQL 분할기는 트리거 본문을 나누지 않는다. `ormgen gen --lang go`는 `//go:build` 제약으로 제외된 파일도 읽는다.

- CHECK 식을 선언과 맞춘 `db:` source로 작성한 plan은 맞춘 내용의 스키마 해시를 저장하므로 모든 언어에서 `apply`, `recover`, `rollback`이 받아들인다. `tests/schema/cases.json`은 Go 클라이언트와 엔진 테스트의 Mermaid 스키마도 기록한다.

- Go 스키마 도구가 실제 데이터베이스에서 올바르게 동작한다. SQLite 카탈로그에서 `AUTOINCREMENT` 키와 생성된 시각 기본값을 읽으므로 NULL 허용 컬럼 추가는 rebuild가 아닌 `ADD COLUMN`이 되고 rollback SQL의 기본값이 올바르다. SQLite full-text 선언은 객체를 만들지 않으며 rebuild를 막지 않는다. 수정 시각 속성은 MySQL에서만 컬럼 변경이다. MySQL·PostgreSQL CHECK 식은 데이터베이스의 정규형으로 비교한다. 추가하는 컬럼은 코멘트를 함께 기록하고 MySQL `MODIFY COLUMN`은 코멘트를 유지한다. 검증은 컬럼을 명칭 기준으로 비교한다. `db:` source를 포함한 모든 도구 DSN은 client URI(`mysql://`, `postgres://`, `sqlite:///경로`)이며 `--driver` 옵션을 제거했고, `import`와 `validate`는 SQLite도 읽는다. 모든 언어의 도구 테스트는 `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`을 사용한다. `tests/schema/cases.json`에 매니페스트 쌍별 `ormgen plan` 파일도 기록한다.

- 모든 클라이언트가 같은 스키마 설치 규칙을 따른다. PostgreSQL과 SQLite는 진행 중인 트랜잭션이나 새 트랜잭션에서 설치하고, MySQL은 트랜잭션 밖에서 설치하며 트랜잭션 안에서는 `CONFIG`를 반환한다. SQLite에서 datetime·date 컬럼과 비교하거나 대입하는 문자열은 저장 text 형식으로 바꾸므로 `startDt('2026-01-02 00:00:00')`가 저장값과 일치한다. 그 밖의 형식은 `CODEC_ENCODE`를 반환한다. Rust 클라이언트는 PostgreSQL에서 `T` 구분자와 RFC 3339 오프셋을 포함한 datetime text를 바인딩한다.

- 모든 클라이언트가 SQL을 조립한다. PHP, Rust, TypeScript는 애플리케이션 프로세스 안에서 요청을 검증하고, 문장을 계획하고, MySQL·PostgreSQL·SQLite 방언과 스키마 DDL을 출력한다. Go 클라이언트는 엔진 패키지를 직접 호출한다. 네 클라이언트는 conformance 벡터에서 같은 문장, bind, 결과를 만든다. 모든 클라이언트에서 `utils().schema().install()`이 세 데이터베이스에 동작한다.

- 언어마다 모델 생성기 하나를 제공한다. Go는 `go generate`용 `ormgen gen --lang go`, PHP는 `vendor/bin/orm-gen`, TypeScript는 빌드에서 쓰는 `orm-gen` npm bin, Rust는 `build.rs`에서 쓰는 `orm-build` crate와 `orm::models!()`를 사용한다. TypeScript와 Rust는 읽은 소스가 호출하는 체인 메서드를 생성한다. 연결은 `model.Connect(dsn, schemaPath, config)`(Go), `Orm::connect(dsn, new Config(schemaPath: …))`(PHP), `Db.connect(dsn, schemaPath, options)`(TypeScript), `Db::connect(dsn, pool_size, config)`(Rust)다.

- 컴파일러 서비스, 클라이언트 전송과 브리지, WASM·FFI 엔진 진입점, 서비스 배포 유닛을 제거했다. ORM 도입에는 클라이언트 라이브러리만 필요하다.

- 연결 시간대를 고쳤다. PostgreSQL은 고정 오프셋 `timezone`을 POSIX 형식으로 받고, PostgreSQL에서 읽은 datetime 값은 연결 시간대로 표시하고, SQLite insert는 `=now` 컬럼에 연결 시간대의 실행기 시각을 쓰고, 서버 시간대 테이블이 없는 MySQL 명칭 시간대는 `CONFIG`를 반환한다.

- keyset 페이지, 관계 존재·개수 조건, tenant scope, `having`, `distinct`, 원시 요청, `min`/`max`/`countDistinct` 집계, `like`·`startsWith`·`endsWith` 연산자, 요청 debug 출력, `predicate`·`scope`·`many_to_many` 스키마 지시어를 제거했다. `CURSOR_INVALID` 오류 코드를 제거했다.

- 스키마 검증에 모델 문법의 예약 명칭 규칙을 적용하고 `key`, `order` 같은 SQL 키워드를 테이블과 컬럼 명칭으로 허용한다. `curlfile` 코덱, Go 설정 파일 로더, `ormgen check`와 `ormgen precompile` 명령을 제거했다. 스키마, 프로토콜, 설정, dialect, 코덱, 패키징 문서를 현재 설계로 다시 작성하고 보관용 설계 페이지를 제거했다.

- Go 클라이언트를 모델 문법으로 다시 작성했다: `Connect`를 갖는 `model.<Entity>()` 모델, `ormgen gen --scan`으로 지정한 패키지의 호출에서 생성하는 체인 메서드, savepoint와 함수형 옵션을 갖는 goroutine 범위 콜백 트랜잭션, `Utils()`, `GetsPage`, `Creates`, `GetQuery`, `New<Name>`, 다른 연결의 관계, DSN `timezone` 매개변수의 연결 시간대. 컴파일러에 바인드 값을 받는 원시 컬럼 표현식, 대소문자를 구분하는 포함 검색, 여러 행 insert를 추가하고 `{column}` 경로를 SQL 문장의 루트 기준으로 해석한다. conformance 벡터를 모델 문법으로 바꾸고 MySQL, PostgreSQL, SQLite 기대값을 기록했다.

- 명시 키 join·relation, join 자식 조건 그룹, 컬럼·값 함수, 다중 컬럼 목록 조건, 서브쿼리, 무작위 정렬을 컴파일러 프로토콜과 Go·PHP·Rust·TypeScript IR 브리지로 전달한다. `make proto-check`는 공통 질의 형태를 네 브리지로 컴파일하고 plan을 비교한다.

- MySQL·PostgreSQL·SQLite용으로 명시적 키 조인과 관계, 조인 자식 조건 묶음, 컬럼 함수와 값 함수, 여러 컬럼 목록 조건, 서브쿼리 조건과 컬럼, 원시 조각의 `{column}` 참조, 무작위 정렬을 컴파일한다. `FUNCTION_UNKNOWN` 오류 코드를 추가했다.

- 공통 인터페이스를 `connect` 모델, 격리 수준·읽기 전용·timeout·재시도 옵션을 가진 콜백 트랜잭션, 실행 흐름 단위 savepoint, 트랜잭션 안의 행 잠금, `connection.utils()` 작업 기준으로 다시 작성했다. 공개 begin/commit/rollback, 트랜잭션 원시 SQL, 명시적 savepoint 호출, 애플리케이션 전용 권한 보조 기능을 제거했다.

- 복잡한 쿼리 예를 승인된 문법으로 다시 작성했다. 설정한 조인 자식, 조인 모델 묶음, ORM 함수 값, `getsPage`를 사용한다.

- ORM 함수 값을 정의했다. 값 함수 `now`, `today`, `…Ago`, `…Later`와 컬럼 함수 `dayOfWeek`, `year`, `month`, `date`, `distance`, `pointX`, `pointY`의 MySQL·PostgreSQL·SQLite 출력 형태를 포함한다. 비교 값은 메서드의 두 번째 인자다. SQLite 최소 버전을 3.46으로 올리고 SQLite decimal 차이를 문서에 기록했다.

- 관계 결과 명칭(`get<Table>Model(s)`, `alias<Name>`이면 `get<Name>`)을 정의하고 컬럼, 추가 컬럼, 관계 결과, `new<Name>` 값 사이의 명칭 중복을 거부한다.

- `new<Name>`을 컬럼이 아닌 명칭으로 추가하고 getter, `toArray()`, JSON 출력에는 포함하지만 SQL에는 사용하지 않는 값으로 정의했다. 실제 컬럼 명칭의 `new<Name>`을 거부하고 `orderByRandom()`을 추가했다.

- 승인된 DSL 규칙을 정의했다. 자식 `on(fn)`의 조인 `ON` 조건, `and(model)`/`or(model)` 조인 모델 조건 묶음, `getsPage`, `getQuery`, 서브쿼리로 쓰는 실행하지 않은 모델, `{column}`을 사용하는 원시 형태, `<ColA><Op><ColB>(model)` 컬럼 비교, `creates`, `tuple<ColA>With<ColB>`, ORM 함수 값, 컬럼 명칭 금지 조각, `curlfile_serialize` 제거를 포함한다.

- 가이드, README, 문서 첫 화면을 모델 문법으로 갱신했다. `connect`를 사용하는 모델 생성, 접두어 없는 첫 조건, `and`/`or` 연결자와 묶음, `match<L>With<R>` 관계 키, `create`/`update(true)`/`delete(true)` 쓰기, `connect` 없이 쓰는 콜백 트랜잭션을 설명한다.

- DSL 명세를 모델 문법으로 다시 작성했다. `connect` 연결, 접두어 없는 첫 조건, `and`/`or` 연결자와 묶음, 연산자 접두어를 포함한 체인 문법, 값 하나·목록·null 값 형태, 길이 2 고정 `Between` 배열, 조회, 컬럼, 관계, 조인, 쓰기, 트랜잭션, 예약 명칭을 정의한다.

- 초기 설계, 수정 설계, DSL v3 기록을 하나의 설계 계획(`docs/plan.md`)으로 대체했다. 이 계획은 Go·PHP·Rust·TypeScript의 모델 문법과 규칙, 작업 순서를 정의한다.

- Go 의존성 `github.com/polyspec/ordered-json/go`를 ordered-json 커밋 `40c9f98`의 `v0.0.0-20260916062150-40c9f98cde3a`로 갱신했다. 이전 버전은 `v0.0.0-20260915123419-26c2aebc9789`이며 ORM 버전은 `0.0.1`로 유지한다.

- 제한된 PostgreSQL integration orchestration을 위한 ORM 소유 `DB.BackendWaitingForLock` inspection API를 추가했다. PostgreSQL이 아닌 adapter는 driver-specific application 경로를 노출하지 않고 `false`를 반환한다.

- `github.com/polyspec/orm/generator`를 통해 Go·PHP·Rust·TypeScript용 정본 schema client 생성기를 공개한다.
- Go client 생성에서 명시적 package 이름을 선택할 수 있게 하며 기본값 `gen`은 유지한다.

- `Tx.InstallSchema(context.Context, []byte) error`를 ORM이 소유하는 정본 스키마 설치 경계로 정의한다. 소비자는 SQL이나 dialect별 DDL을 제공하지 않는다.

- SQLite transaction의 `readOnly`와 isolation option을 거부하지 않고 ORM이 소유한 connection pragma로 적용한다. `Tx.ReadOnly`와 `Tx.Isolation`에서 논리 mode를 노출하고 transaction 종료 전에 connection 상태를 복원하며 read-only 쓰기 거부와 이후 connection 재사용을 검증한다.
- transaction 시작 시 생성되는 ORM 소유 SQLite lock table을 database-empty 검사에서 제외해 새 database가 사용자 소유로 잘못 판정되지 않게 한다.

- 직렬화·`NoWait`·transaction release 검증과 함께 제한된 SQLite ORM lock-cancellation regression을 추가한다. 대기 중인 lock 요청이 무제한 대기 없이 caller context cancellation을 반환한다는 근거를 추적한다.

## Unreleased

- SQLite `forUpdate`·`forShare`와 두 `NoWait` mode를 ORM 소유 transaction 범위 lock 행으로 구현한다. SQLite lock suffix는 생성하지 않고 `NoWait`은 busy timeout을 일시적으로 0으로 설정한다. Go·PHP·Rust·TypeScript가 같은 lock mode를 plan 계약으로 전달한다.
- SQLite 물리 테이블 이름에서 논리 schema namespace를 보존하도록 `schema.table`을 `schema__table`로 매핑하여 하나의 database에서 같은 이름의 table이 충돌하지 않게 한다.
- 생성 SQLite index 이름에도 qualified 물리 table 이름을 namespace로 사용하여 module의 같은 논리 index 이름이 충돌하지 않게 한다.
- 하나의 자식 column이 서로 다른 복합 관계선을 포함한 둘 이상의 foreign key에 참여할 때 이를 보존한다. generated DDL 순서와 migration diff가 하나의 column reference로 제약을 합치지 않고 관계 metadata를 사용한다.
- `ErrorCode`, `IsDuplicateKey`, `IsForeignKey`를 통해 adapter에 독립적인 Go 오류 분류를 제공하며 호출자가 driver 오류 타입을 검사하지 않도록 한다.
- Go ORM client가 `DB.Stats`와 `DB.Acquire`를 통해 ORM 소유 pool 통계와 불투명한 connection lease를 제공하며 `database/sql` query 접근은 노출하지 않는다.
- Go ORM client가 `IsTransactionFinished`를 제공하여 호출자가 드라이버 전용 오류를 비교하지 않고 종료된 transaction을 판별할 수 있다.
- Go generated `Get`은 빈 결과에서 `NO_ROWS`를 반환하고, 선택적 행 조회를 위해 명시적인 `GetOrNil`을 생성한다.
- `%% aes_version`로 AES version column을 선언할 수 있으며 generator는 특정 column 이름을 가정하지 않고 manifest metadata를 사용한다.
- 감사 redaction은 선언된 JSON 경로가 없을 때 값을 변경하지 않으며 PostgreSQL에서 없는 부모 객체를 materialize하지 않는다.
- Go JSON·JSONS codec이 ordered-json 값을 사용하여 객체 멤버 순서를 보존하고 빈 객체와 빈 배열을 구분한다.
- Go JSON·JSONS codec이 tag가 있는 Go 구조체와 raw `jsontext.Value` 입력을 표준 JSON encoder 경계 없이 ordered-json으로 변환한다.
- Go client가 ordered-json 모노레포의 `github.com/polyspec/ordered-json/go` `v0.0.1` 패키지를 사용한다.

## 0.0.1

- 초기 개발 version이다.
- 공통 IR, compiler, generated client, database executor, migration, 인증된 version encryption, relation, batch, keyset pagination, conformance check를 추가했다.
- SQLite 중복 키·외래 키 오류가 어댑터 독립 ORM 오류 계약으로 매핑되는지 검증한다.
- namespace를 보존한 물리 table 이름을 처리하도록 어댑터 독립 `SchemaInstalled` transaction 연산에 SQLite 지원을 추가한다.
- PostgreSQL·SQLite에서 안전한 초기 schema preflight를 수행할 수 있도록 어댑터 독립 database-empty 검사를 추가한다.
- 빈 database preflight가 `pg_toast` 같은 PostgreSQL system namespace를 사용자 객체로 세지 않도록 수정한다.
- 네 언어 ORM client를 ordered-json revision `6d23a2a5e7c0c5d501d759b6d32a439661f153f2`로 갱신했다. Go는 `v0.0.0-20260916090424-6d23a2a5e7c0` 모듈을 사용하고 Rust·PHP·TypeScript는 root package를 사용한다. ORM 버전은 `0.0.1`로 유지한다.
