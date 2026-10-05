# 기여 안내

## 필수 작업 순서

1. `AGENTS.md`가 있으면 읽고 `contracts/features.json`에서 관련 경로를 읽는다. `make install`을 한 번
   실행한다. 그것은 검사가 읽는 것(npm, Composer, Go 의존성, Rust toolchain과 crate, 가장 낮은 Node)을
   download하고, 검사는 offline으로 실행되므로 빠진 download는 `run make install`과 함께 실패한다.
2. 예상하거나 확인한 결함을 재현하는 test를 추가한다.
3. engine, generator, 영향받은 모든 client에 완전한 변경을 구현한다.
4. 영문과 한글 paired document를 함께 갱신한다.
5. 바뀐 것의 unit test, 곧 그 Red/Green case를 실행하고 필요하면 commit 설명에 결과를 기록한다. end-to-end
   실행, `make owner-check`, 전체 묶음은 push 뒤 CI에서 실행하며, push 전에 필요한 로컬 검사는 없다.
6. 전체 묶음 `make check`는 push마다 CI에서 실행한다. 어떤 단계보다 먼저,
   `docs/checklist.md`의 항목이 `[~]`인 동안(각 ID와 제목을 적는다), 추적하는 file에 commit하지 않은 변경이
   있는 동안, 그리고 `.runtime/full-run.json`이 같은 tree(`git rev-parse HEAD^{tree}`)의 전체 실행을 기록하고
   있을 때 이유와 종료 상태 2로 거부한다. 기록은 tree, commit, 결과, 통과하지 못한 target과 모든 단계의 시각을
   담고, 첫 단계 전과 각 단계마다 쓰이므로 강제 종료된 실행은 `incomplete`로 남는다. `make rerun-failed`는 현재
   tree의 기록에서 통과하지 못한 target만 실행하며, 그런 기록이 없으면 거부된다.

## Test database server

`make test-servers`는 설치된 `mysqld`, `initdb`, `pg_ctl`, `pg_basebackup`, `proxysql`, `pgbouncer`로 `.runtime/servers` 아래에서 다음 서버를 시작한다.

| 서버 |
|---|
| MySQL 8.4 primary |
| PostgreSQL 17 primary |
| primary의 읽기 전용 MySQL replica |
| primary의 PostgreSQL standby |
| MySQL primary 앞의 ProxySQL |
| PostgreSQL primary 앞의 transaction 모드 PgBouncer |

각 서버는 `make test-servers`가 이 checkout의 서버를 시작할 때 127.0.0.1에서 고른 빈 port에서 listen한다(`scripts/free-ports.mjs`). 그래서 두 checkout의 서버가 한 port를 두고 다투지 않는다. 환경 파일 `.runtime/servers/env`가 DSN에 그 port를 기록하고, `make test-servers-tls`와 이후의 `make test-servers`는 그것을 거기서 읽는다.

테스트는 127.0.0.1의 TCP로 연결한다. `.runtime/servers`의 Unix 소켓은 서버 중지와 ProxySQL 관리 인터페이스에만 쓴다. ProxySQL은 Linux용 패키지를 배포하며, macOS에서는 소스 릴리스에서 빌드한다. 이 target은 다음을 수행한다.

1. primary와 replica를 초기화하고 각 서버가 연결을 받는다고 보고한 뒤 다음 단계로 진행한다.
2. MySQL 시간대 테이블을 불러온다.
3. 두 primary에 `orm_test`, `orm_tools` 데이터베이스를 만들고, replica가 이를 적용한다.
4. ProxySQL과 PgBouncer를 시작하고, 각 서버가 listen한 뒤 쓰는 로그 줄을 기록하면 다음 단계로 진행한다.
5. 마지막에 `.runtime/servers/env`를 쓴다.

ProxySQL 사용자는 `orm`, 비밀번호는 `orm`이다. PgBouncer는 primary의 모든 데이터베이스와, 서버 연결 하나로 `orm_test`에 접속하는 데이터베이스 `orm_test_single`을 제공한다. PostgreSQL primary는 `synchronous_standby_names`에 standby를 지정하고 `synchronous_commit=local`을 쓰므로, `synchronous_commit=remote_apply`를 설정하고 WAL을 쓰는 트랜잭션은 standby가 그 트랜잭션을 적용한 뒤에 commit된다. commit 기록 외에 WAL을 쓰지 않는 트랜잭션은 기다리지 않으므로, replica 테스트는 그 트랜잭션에서 트랜잭션 logical message(`pg_logical_emit_message(true, …)`)를 쓴다.

환경 파일은 `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TEST_PGBOUNCER_SINGLE_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`, 실행마다 만드는 database의 server DSN `ORM_RUN_MYSQL_DSN`, `ORM_RUN_POSTGRES_DSN`과 SQLite query `ORM_RUN_SQLITE_QUERY`, MySQL TLS case의 DSN `ORM_TEST_MYSQL_TLS_DSN`, `ORM_TEST_MYSQL_TLS_OTHER_CA_DSN`, `ORM_TEST_MYSQL_TLS_MISMATCH_DSN`, 그리고 서버의 lease directory `ORM_TEST_SERVERS_LEASES`를 export한다. 이 파일이 있으면 `make test-servers`는 파일 내용을 출력하고 아무것도 바꾸지 않는다. 시작이 실패하면 시작한 서버를 중지하고 로그를 남긴다. `make test-servers-stop`은 서버를 중지하고 `.runtime/servers`를 삭제한다. CI workflow `.github/workflows/ci.yml`은 같은 프로그램을 설치하고 `make test-servers`로 서버를 시작한 뒤 환경 파일을 이후 단계의 환경에 더한다. workflow는 이 변수를 직접 정의하지 않으며, `make repo-check`는 workflow가 변수 하나라도 제공하지 않거나, 직접 정의하거나, 서버 시작 전에 make target을 실행하면 실패한다.

여러 checkout의 실행과 다른 도구가 같은 서버를 동시에 쓸 수 있으므로 그 사용은 lease(`tests/lease`)로 다룬다. `TEST_ENV`를 읽는 make 줄은 그 줄이 끝날 때까지 `ORM_TEST_SERVERS_LEASES`의 shared lease를 가진다. `make test-servers-stop`, 새로 하는 `make test-servers`, MySQL migration은 exclusive lease를 가지며, lease가 하나라도 있으면 보유자마다 checkout, process id, 시작 시각, 명령을 적고 거부된다. make 밖의 도구는 `.runtime/bin/lease hold <ORM_TEST_SERVERS_LEASES> shared --pid <pid>`로 자기 process가 끝날 때까지 shared lease를 가진다. 보유한 lease는 보유자와, 보유자가 끝나면 그것을 지우는 releaser를 적는다. 보유자는 끝났지만 releaser가 실행 중인 lease는 풀리는 중이므로 기다리는 요청은 그것을 기다린다. 보유자와 releaser가 모두 끝난 lease는 보유자 없는 lease이고 아무도 막지 않는다. 보유자 없는 shared lease는 어느 요청이든, 보유자 없는 exclusive lease는 다음 exclusive 요청이 가져가며 그 요청이 자원을 다시 만든다. 보유자 없는 exclusive lease가 남아 있는 동안 shared 요청은 거부된다. 그 보유자가 자원을 만들다 끝났을 수 있기 때문이다. 가져갈 때마다 그것을 적는다. `make test-servers-leases`는 lease를 적고, `make test-servers-leases-clear`는 보유자 없는 lease를 지우며 그것을 적는다.

함께 쓰는 bench나 decimal database는 없다. `make check`, `make owner-check`, `make run-databases TARGETS="<target>..."`는 `scripts/check/databases.sh`로 자기 실행의 bench와 decimal database를 만들어 seed하고, `TEST_ENV`(`BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`, `ORM_BENCH_MYSQL_DSN`)와 `DECIMAL_ENV`로 모든 target에 주며, 끝에 지운다. 그것을 읽는 target은 server 환경만으로 실행하면 실패하므로 `make run-databases`로 실행한다.

`make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `client-pooler-check`, `case-database-check`, `conformance-check`, `db-test`, `perf-check`는 `.runtime/servers/env`를 읽고, 파일이 없으면 실패한다. `client-pooler-check`는 `ORM_TEST_POSTGRES_DSN`을 PgBouncer DSN으로, `ORM_TEST_MYSQL_DSN`을 ProxySQL DSN으로 바꾸어 클라이언트 데이터베이스 테스트를 실행한다. 이 target들은 환경 파일의 서버 DSN을 `ORM_TEST_MYSQL_SERVER_DSN`과 `ORM_TEST_POSTGRES_SERVER_DSN`으로도 export하며, pooler check는 이 둘을 바꾸지 않는다. rollback 실패 case는 이 DSN으로 transaction의 서버 session을 종료한다. ProxySQL은 text protocol의 `KILL`을 자기 client session에 대한 명령으로 받기 때문이다.

클라이언트 데이터베이스 case는 `ORM_TEST_MYSQL_DSN`이나 `ORM_TEST_POSTGRES_DSN`이 가리키는 데이터베이스를 쓰지 않고, 그 데이터베이스가 비어 있다고 가정하지 않는다. 빈 데이터베이스를 확인하거나 schema를 설치하는 case는 그 DSN으로 자기 데이터베이스 `orm_case_<pid>_<n>`을, SQLite에서는 임시 directory에 자기 파일 `orm-case-<pid>-<n>.sqlite`를 만들고, 끝날 때 실패한 뒤에도 지운다. DSN의 사용자에게는 데이터베이스를 만드는 권한이 필요하다. `orm_test_single`을 거치는 statement timeout case는 `orm_test`에만 닿으므로 그곳에 자기 이름의 table을 만들고 지운다. `make case-database-check`는 두 공유 데이터베이스에 table 하나를 남겨 둔 채 네 클라이언트의 model case를 실행하고, case가 통과하며 공유 데이터베이스, 그 PostgreSQL schema, `orm_case_` 데이터베이스와 `orm-case-` 파일을 그대로 두지 않으면 실패한다.

## Interface 변경

공통 contract, generated artifact, language client, example, structure check를 함께 갱신한다. 특정 client에만 공개된 기능은 미완료로 처리한다.

## Commit message

동작을 나타내는 짧은 영문 명령형 제목을 사용한다. 예: `Implement root IN chunking`. 하나의 commit에는 하나의 변경 범위만 둔다.

## Pull request

동작 변경, 영향받은 client와 database, 실행한 test, 알려진 제한을 작성한다. credential, 운영 data, repository generator가 생성하지 않는 generated file은 포함하지 않는다.
