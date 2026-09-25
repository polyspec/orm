# 기여 안내

## 필수 작업 순서

1. `AGENTS.md`가 있으면 읽고 `contracts/features.json`에서 관련 경로를 읽는다.
2. 예상하거나 확인한 결함을 재현하는 test를 추가한다.
3. engine, generator, 영향받은 모든 client에 완전한 변경을 구현한다.
4. 영문과 한글 paired document를 함께 갱신한다.
5. 관련 로컬 검사를 실행하고 필요하면 commit 설명에 결과를 기록한다.

## Test database server

`make test-servers`는 설치된 `mysqld`, `initdb`, `pg_ctl`, `pg_basebackup`, `proxysql`, `pgbouncer`로 `.runtime/servers` 아래에서 다음 서버를 시작한다.

| 서버 | 포트 변수(기본값) |
|---|---|
| MySQL 8.4 primary | `TEST_MYSQL_PORT`(33171) |
| PostgreSQL 17 primary | `TEST_POSTGRES_PORT`(55471) |
| primary의 읽기 전용 MySQL replica | `TEST_MYSQL_REPLICA_PORT`(33181) |
| primary의 PostgreSQL standby | `TEST_POSTGRES_REPLICA_PORT`(55481) |
| MySQL primary 앞의 ProxySQL | `TEST_PROXYSQL_PORT`(33182) |
| PostgreSQL primary 앞의 transaction 모드 PgBouncer | `TEST_PGBOUNCER_PORT`(55482) |

테스트는 127.0.0.1의 TCP로 연결한다. `.runtime/servers`의 Unix 소켓은 서버 중지와 ProxySQL 관리 인터페이스에만 쓴다. `make test-servers TEST_MYSQL_PORT=33172 TEST_POSTGRES_PORT=55472`는 다른 포트를 선택하고, 나머지 포트 변수도 같은 방식으로 지정한다. ProxySQL은 Linux용 패키지를 배포하며, macOS에서는 소스 릴리스에서 빌드한다. 이 target은 다음을 수행한다.

1. primary와 replica를 초기화하고 각 서버가 연결을 받는다고 보고한 뒤 다음 단계로 진행한다.
2. MySQL 시간대 테이블을 불러온다.
3. 두 primary에 `orm_test`, `orm_tools`, `orm_bench` 데이터베이스를 만들고, replica가 이를 적용한다.
4. `bench/sql`과 `bench/seedaes`로 `orm_bench`와 `.runtime/servers/orm_bench.sqlite`를 시드한다.
5. ProxySQL과 PgBouncer를 시작하고, 각 서버가 listen한 뒤 쓰는 로그 줄을 기록하면 다음 단계로 진행한다.
6. 마지막에 `.runtime/servers/env`를 쓴다.

ProxySQL 사용자는 `orm`, 비밀번호는 `orm`이다. PgBouncer는 primary의 모든 데이터베이스와, 서버 연결 하나로 `orm_test`에 접속하는 데이터베이스 `orm_test_single`을 제공한다. PostgreSQL primary는 `synchronous_standby_names`에 standby를 지정하고 `synchronous_commit=local`을 쓰므로, `synchronous_commit=remote_apply`를 설정하고 WAL을 쓰는 트랜잭션은 standby가 그 트랜잭션을 적용한 뒤에 commit된다. commit 기록 외에 WAL을 쓰지 않는 트랜잭션은 기다리지 않으므로, replica 테스트는 그 트랜잭션에서 트랜잭션 logical message(`pg_logical_emit_message(true, …)`)를 쓴다.

환경 파일은 `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TEST_PGBOUNCER_SINGLE_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`, `ORM_BENCH_MYSQL_DSN`, `BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`을 export한다. 이 파일이 있으면 `make test-servers`는 파일 내용을 출력하고 아무것도 바꾸지 않는다. 시작이 실패하면 시작한 서버를 중지하고 로그를 남긴다. `make test-servers-stop`은 서버를 중지하고 `.runtime/servers`를 삭제한다.

`make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `conformance-check`, `db-test`, `perf-check`는 `.runtime/servers/env`를 읽고, 파일이 없으면 실패한다.

## Interface 변경

공통 contract, generated artifact, language client, example, structure check를 함께 갱신한다. 특정 client에만 공개된 기능은 미완료로 처리한다.

## Commit message

동작을 나타내는 짧은 영문 명령형 제목을 사용한다. 예: `Implement root IN chunking`. 하나의 commit에는 하나의 변경 범위만 둔다.

## Pull request

동작 변경, 영향받은 client와 database, 실행한 test, 알려진 제한을 작성한다. credential, 운영 data, repository generator가 생성하지 않는 generated file은 포함하지 않는다.
