# 런타임 연결

애플리케이션은 환경 주입이나 비밀 관리 서비스에서 연결 값을 받아 전달한다. 클라이언트는 설정 파일을 읽지 않는다.

DSN URI만 데이터베이스를 선택한다.

```text
mysql://user:password@host:3306/app?timezone=%2B09:00
mysql://user@localhost/app?socket=/tmp/mysql.sock
postgres://user:password@host:5432/app?sslmode=disable&timezone=Asia/Seoul
postgres:///app?host=/tmp
sqlite:///var/lib/app.sqlite?_pragma=busy_timeout(5000)
```

- scheme이 MySQL, PostgreSQL, SQLite 중 하나를 선택한다. 클라이언트는 해당 네이티브 드라이버를 만들고 연결 풀을 연다. 스키마 로딩과 해시 검사는 내부에서 처리한다.
- `timezone`은 IANA 명칭이나 고정 오프셋으로 연결 시간대를 정한다. MySQL과 PostgreSQL 연결은 세션 시간대를 설정하고, SQLite 값과 ORM 값 함수는 클라이언트에서 이 시간대를 사용한다. `timezone`이 없으면 서버 환경의 시간대를 사용한다. MySQL에서 명칭 시간대를 쓰려면 서버에 시간대 테이블(`mysql_tzinfo_to_sql`)이 있어야 하며, 없으면 연결이 `CONFIG`를 반환한다. PostgreSQL datetime 컬럼은 시각(instant)을 저장하고 연결 시간대로 읽는다.
- 연결 설정은 최대 연결 수 `poolSize`를 받는다. Go는 `orm.Config{PoolSize: n}`, PHP는 `new Config(poolSize: n)`, TypeScript는 `{ poolSize: n }`, Rust는 `Db::connect(dsn, n, config)`다. 0이거나 지정하지 않으면 Go·TypeScript·Rust는 최대 10개의 연결을 열고, 음수는 `CONFIG`를 반환한다. 풀은 최대값보다 많은 연결을 열지 않으며, 모든 연결이 사용 중일 때 연결이 필요한 문이나 트랜잭션은 연결이 반환될 때까지 기다린다. Go는 같은 수까지 유휴 연결을 유지한다. TypeScript의 SQLite 드라이버는 연결 하나를 유지한다. PHP에는 풀이 없다. `Orm::connect`는 `Db` 값이 살아 있는 동안 유지되는 PDO 연결 하나를 열고, 요청을 넘어 유지되는 연결은 없으며, `stats()`는 `poolSize`를 프로세스가 스스로 지키는 상한으로 보고한다.
- 연결 설정은 연결의 모든 문을 제한하는 `statementTimeoutMs`를 받는다. Go는 `orm.Config{StatementTimeoutMs: n}`, PHP는 `new Config(statementTimeoutMs: n)`, TypeScript는 `{ statementTimeoutMs: n }`, Rust는 `Config { statement_timeout_ms: n, ..Default::default() }`다. 0이거나 지정하지 않으면 서버 기본값을 쓰고, 음수는 `CONFIG`를 반환한다. PostgreSQL은 `statement_timeout`으로 모든 문을 제한하며, 모든 클라이언트는 이 값을 각 서버 연결의 startup 매개변수로 전달한다. MySQL은 `max_execution_time`으로 SELECT 문을 제한하며, 쓰기는 이 값이 아니라 서버 잠금 대기 시간(`innodb_lock_wait_timeout`)이 제한한다. SQLite에는 세션 시간 제한이 없으므로 DSN의 `busy_timeout`이 그 한계다. 제한에 걸려 중단된 문은 `CANCELED`를 반환한다.
- 흐름은 자기 언어의 취소 수단을 연결 핸들에 적용해 문을 취소한다. Go의 `db.WithContext(ctx)`와 TypeScript의 `db.withSignal(signal)`은 같은 연결을 가리키는 핸들이다. 모델은 연결에 연결하듯 핸들에 연결하고, 핸들에서 시작한 트랜잭션도 같은 취소를 따르며, 컨텍스트나 시그널을 취소하면 실행 중인 문이 `CANCELED`로 끝나고 연결은 계속 쓸 수 있다. Rust는 문의 future를 버리면 문이 취소되고 연결이 풀로 돌아간다. PostgreSQL은 실행 중인 문을 취소하고 MySQL은 실행 중인 질의를 종료하며, TypeScript의 SQLite 드라이버는 문 하나를 중간에 양보하지 않고 실행하므로 시그널은 실행 중인 문이 아니라 다음 문에 적용된다. PHP 취소는 아직 구현하지 않았다. 체인에는 취소 연산이 없고 연결 핸들이 그 역할을 맡는다. 핸들은 별도의 값이므로 Go의 `db.Root()`와 TypeScript의 `db.root()`는 파생의 기준이 된 연결을 돌려주며, 한 연결에서 파생한 핸들들은 같은 연결로 비교된다.
- MySQL `socket` 매개변수는 Unix 소켓으로 연결한다. 클라이언트는 낙관적 갱신에 필요한 found-rows 개수를 켠다.
- SQLite 경로는 절대 경로여야 한다. 클라이언트는 외래 키를 켠다. 쓰기 트랜잭션은 `BEGIN IMMEDIATE`로 시작해 시작 시점부터 데이터베이스의 쓰기 잠금을 가진다. 따라서 두 쓰기 트랜잭션은 차례로 실행되고, 읽은 뒤에 쓰는 트랜잭션도 실패하지 않는다. `readOnly` 옵션을 쓴 트랜잭션은 `BEGIN`으로 시작하고 쓰기 잠금을 얻지 않는다. 시작 문은 클라이언트가 정하며, `_txlock`이 있는 DSN은 `CONFIG`를 반환한다.
- SQLite 연결은 다른 연결이 가진 잠금을 최대 5000밀리초 기다린다. Go·PHP·TypeScript·Rust 클라이언트에서 DSN 매개변수 `_pragma=busy_timeout(ms)`로 다른 시간을 정한다. 예를 들어 `sqlite:///var/lib/app.sqlite?_pragma=busy_timeout(10000)`이며, `busy_timeout(0)`은 기다리지 않는다. 대기가 끝날 때까지 다른 연결이 잠금을 놓지 않으면 `CANCELED`를 반환한다. `DEADLOCK`만 재시도하므로 이 트랜잭션은 다시 실행하지 않는다. 모든 `_pragma=name(value)` 매개변수는 연결에서 `PRAGMA name = value`를 실행한다.
- SQLite 읽기는 다른 연결이 쓰기 트랜잭션을 연 동안에도 실행되며, 그 전에 커밋된 행을 반환한다. 클라이언트는 데이터베이스 파일의 저널 모드를 그대로 두며 WAL을 요구하지 않는다. 기본 롤백 저널에서는 쓰기의 커밋 중에 시작한 읽기가 `busy_timeout` 안에서 커밋을 기다린다. `_pragma=journal_mode(WAL)`은 파일을 WAL로 바꾸며, WAL에서는 읽기가 커밋을 기다리지 않는다. 이 모드는 파일에 남는다.
- TypeScript SQLite 드라이버는 잠금을 동기적으로 기다리므로 기다리는 동안 이벤트 루프가 멈춘다. 따라서 TypeScript 프로세스는 SQLite 파일 하나에 `Db` 하나를 연다. 그 `Db`의 트랜잭션은 차례로 실행되고, 여러 프로세스는 잠금 대기로 파일을 함께 쓴다.

데이터베이스 자격 증명과 AES 키는 커밋하거나 런타임 파일에 기록하거나 로그에 남기지 않는다. 배포 비밀 저장소에서 값을 읽은 뒤 클라이언트 연결 옵션으로 전달한다.

## Primary와 replica

ORM은 문을 서버 사이에서 분배하지 않는다. replica에서 읽는 애플리케이션은 서버마다 연결을 하나씩 연다. primary에 하나, replica마다 하나를 열고, 문이 쓸 연결을 `connect`로 모델이나 행에 전달한다.

| 언어 | 연결 | replica로 읽기 | primary로 쓰기 |
|---|---|---|---|
| PHP | `$master = Orm::connect($primaryDsn, $config);` `$slave1 = Orm::connect($replicaDsn, $config);` | `(new User)($slave1)->name($name)->get()` | `$row->connect($master)->setName($new)->update()` |
| Go | `master, err := model.Connect(primaryDSN, schemaPath, cfg)` `slave1, err := model.Connect(replicaDSN, schemaPath, cfg)` | `model.User().Connect(slave1).Name(name).Get()` | `row.Connect(master).SetName(next).Update()` |
| Rust | `let master = Db::connect(&primary_dsn, n, cfg.clone()).await?;` `let slave1 = Db::connect(&replica_dsn, n, cfg).await?;` | `User::new().connect(&slave1).name(name).get().await?` | `row.connect(&master).set_name(next).update(false).await?` |
| TypeScript | `const master = await Db.connect(primaryDsn, schemaPath, options);` `const slave1 = await Db.connect(replicaDsn, schemaPath, options);` | `new User().connect(slave1).name(name).get()` | `row.connect(master).setName(next).update()` |

- 모델이나 읽어 온 행은 자신이 연결된 연결만 사용한다. `master`의 트랜잭션 안에서 `slave1`에 연결한 모델은 트랜잭션 밖에서 `slave1`로 실행되고, `connect`가 없는 모델은 트랜잭션 안에서 실행된다.
- 연결마다 풀, prepared statement, 세션 설정이 따로 있다.
- replica는 primary가 commit한 변경을 그 뒤에 적용한다. 같은 요청의 쓰기를 읽어야 하는 읽기는 primary 연결을 사용하며, 애플리케이션이 그 연결을 선택한다.
- replica는 쓰기를 거부한다. PostgreSQL은 SQLSTATE 25006을, `super_read_only`인 MySQL replica는 오류 1290을 반환한다. 클라이언트는 읽기 전용 트랜잭션의 쓰기와 읽기 전용으로 열린 SQLite 데이터베이스에 대한 쓰기와 마찬가지로 드라이버 메시지와 함께 `READ_ONLY`를 반환한다.
- 스키마 도구와 `utils().schema().install`은 primary에서 실행하고, replica는 복제로 스키마를 적용한다.
- SQLite는 단일 노드 전용이다. SQLite 데이터베이스는 절대 경로로 지정한 로컬 파일이며, ORM은 SQLite replica를 지원하지 않는다.

`make test-servers`는 MySQL primary의 replica와 PostgreSQL primary의 standby를 시작하고, 네 클라이언트의 데이터베이스 테스트는 두 데이터베이스에서 이 규칙을 검사한다.

## 연결 pooler

연결 pooler는 애플리케이션과 데이터베이스 서버 하나 사이에서 적은 수의 서버 연결을 많은 클라이언트 연결이 나누어 쓰게 한다. 클라이언트는 PostgreSQL에서 transaction 모드의 PgBouncer, MySQL에서 ProxySQL을 통해 동작하며, 둘은 pooler로만 쓴다. 애플리케이션은 그 서버의 DSN으로 pooler에 연결하고, pooler는 어떤 문도 다른 서버로 보내지 않는다. `make client-pooler-check`는 네 클라이언트의 데이터베이스 테스트를 두 pooler를 통해 실행한다.

PgBouncer 설정:

| 설정 | 값 | 이유 |
|---|---|---|
| `pool_mode` | `transaction` | 서버 연결 하나가 한 번에 클라이언트 트랜잭션 하나 또는 트랜잭션 밖의 문 하나를 처리한다. |
| `max_prepared_statements` | 0보다 큰 값(PgBouncer 기본값 200) | 클라이언트는 문을 프로토콜 수준의 이름 있는 prepared statement로 실행한다. 0이면 한 서버 연결에서 준비한 문이 다음 서버 연결에 없어서 PgBouncer가 `prepared statement … already exists` 또는 `does not exist`를 반환한다. |
| `track_extra_parameters` | `statement_timeout` | 연결이 `statementTimeoutMs`를 설정할 때 필요하다. 클라이언트는 `statement_timeout`을 startup 매개변수로 전달한다. PgBouncer는 추적하지 않는 startup 매개변수를 거부하고, 추적하는 매개변수는 그 클라이언트 연결에 배정하는 모든 서버 연결에만 설정한다. |

- 클라이언트가 트랜잭션 밖에서 정하는 PostgreSQL 세션 상태는 시간대뿐이다. 시간대는 startup 매개변수나 `SET TIME ZONE`으로 정하며, PgBouncer는 `TimeZone`을 기본으로 추적한다. 트랜잭션 옵션(`SET TRANSACTION`, `SET LOCAL statement_timeout`), `utils().setLocal`(`set_config(…, true)`), `utils().lock`(`pg_advisory_xact_lock`)은 트랜잭션과 함께 끝난다.
- 문 취소는 PgBouncer를 거쳐서도 동작한다. PgBouncer는 클라이언트 연결의 프로토콜 취소 요청을 그 문을 실행하는 서버 연결로 전달한다. TypeScript는 연결의 process id와 secret key로 그 요청을 전송한다.
- Rust 클라이언트는 startup 매개변수 `extra_float_digits`를 보내지 않는다. PostgreSQL 12 이상은 서버 기본값으로 float8 값을 정확히 출력한다.

ProxySQL은 기본 multiplexing으로 실행하며 ORM 전용 설정이 필요 없다. ProxySQL은 클라이언트 연결마다 `time_zone`과 `max_execution_time`을 기억하고 그 연결에 쓰는 모든 서버 연결에 적용한다. 사용자 변수, `GET_LOCK`, `CREATE TEMPORARY TABLE`을 포함한 문이 실행되면 ProxySQL은 그 클라이언트 연결이 끊어질 때까지 서버 연결 하나에 고정한다. MySQL에서 `utils().setLocal`과 감사 트리거는 사용자 변수 `` @`orm.<key>` ``를, `utils().lock`은 `GET_LOCK`을 쓰므로 이들을 사용한 연결은 더 이상 multiplexing되지 않는다. 결과는 달라지지 않는다.

스키마 도구(`ormgen`, `orm-gen`)는 pooler를 거치지 않고 primary에 직접 연결한다. migration은 세션 범위의 MySQL `GET_LOCK`을 잡고, 라이브 데이터베이스의 CHECK 제약을 읽을 때 임시 테이블을 만들어 이후 문에서 읽기 때문이다.
