<!-- doc-id: contributing -->
<!-- source-sha256: 7fb8fe1ff98e75f619abf2567f757b68d124b7d48f0851355323b78a000d1c87 -->
# 기여 안내

## 필수 작업 순서

1. `AGENTS.md`가 있으면 읽고 `contracts/features.json`에서 관련 경로를 읽는다. Makefile이 kit을
   include하므로 새 checkout에는 kit을 설치하기 전까지 Makefile target이 없다. 그래서 첫 단계는 `package.json`의 `devEngines`가 이름하는 npm으로
   checkout 밖에서 `npm ci`를 실행한다. checkout 안에서는 machine의 npm이 다른 버전을 거부하기 때문이다.

   ```sh
   root="$PWD"
   version="$(node -p 'require("./package.json").devEngines.packageManager.version')"
   (cd "${TMPDIR:-/tmp}" && npm exec --yes --package="npm@$version" -- sh -c "cd '$root' && npm ci --ignore-scripts --allow-remote=root")
   ```

   그다음 `make install-tools TOOLS=npm`이 `mise.toml`의 npm을 설치하고, `make link`(또는 `make install-packages`)가 package를 받는다.
   그다음 `make install`을 한 번
   실행한다. 그것은 검사가 읽는 것(npm, Composer, Go 의존성, Rust toolchain과 crate, 가장 낮은 Node)을
   download하고, 검사는 offline으로 실행되므로 빠진 download는 `run make install`과 함께 실패한다.
2. 예상하거나 확인한 결함을 재현하는 test를 추가한다.
3. engine, generator, 영향받은 모든 client에 완전한 변경을 구현한다.
4. 영문과 한글 paired document를 함께 갱신한다.
5. 바뀐 것의 unit test, 곧 그 Red/Green case를 실행하고 필요하면 commit 설명에 결과를 기록한다. end-to-end
   실행, `make owner-check`, 전체 묶음은 push 뒤 CI에서 실행하며, push 전에 필요한 로컬 검사는 없다.
6. 전체 묶음은 `main`으로의 push 뒤 CI가 실행한다(`make check-run GROUP=<group>`). 모든 checklist 항목이 terminal 상태일 때
   명시적 로컬 최종 검증을 하려면 `make orm-check`를 실행한다. 그것은 `make ci-targets TARGETS=check-run`을 실행하고
   `var/report/ci-targets` 아래에 report를 기록한다.

## Test database server

`make orm-test-servers`는 설치된 `mysqld`, `initdb`, `pg_ctl`, `pg_basebackup`, `proxysql`, `pgbouncer`로 `.runtime/servers` 아래에서 다음 서버를 시작한다.

| 서버 |
|---|
| MySQL 8.4 primary |
| PostgreSQL 17 primary |
| primary의 읽기 전용 MySQL replica |
| primary의 PostgreSQL standby |
| MySQL primary 앞의 ProxySQL |
| PostgreSQL primary 앞의 transaction 모드 PgBouncer |

각 서버는 `make orm-test-servers`가 이 checkout의 서버를 시작할 때 127.0.0.1에서 고른 빈 port에서 listen한다(`scripts/free-ports.mts`). 그래서 두 checkout의 서버가 한 port를 두고 다투지 않는다. 환경 파일 `.runtime/servers/env`가 DSN에 그 port를 기록하고, `make orm-test-servers-tls`와 이후의 `make orm-test-servers`는 그것을 거기서 읽는다.

테스트는 127.0.0.1의 TCP로 연결한다. Unix 소켓은 서버 중지와 ProxySQL 관리 인터페이스에만 쓴다. 소켓은 `/tmp/orm-servers-<n>`에 있고 `<n>`은 checkout 경로의 POSIX `cksum`이다. 그래서 깊은 checkout에서도 Unix socket 경로 한도(macOS 103 byte, Linux 107 byte)를 지킨다. 그 folder의 file `checkout`이 소유 checkout을 적고, `make orm-test-servers`는 다른 checkout이나 사용자의 folder를 거부하며 한도를 넘는 socket 경로를 말하며 실패하고, `make orm-test-servers-stop`은 그 folder를 삭제한다. ProxySQL은 Linux용 패키지를 배포하며, macOS에서는 소스 릴리스에서 빌드한다. 이 target은 다음을 수행한다.

1. primary와 replica를 초기화하고 각 서버가 연결을 받는다고 보고한 뒤 다음 단계로 진행한다.
2. MySQL 시간대 테이블을 불러온다.
3. 두 primary에 `orm_test`, `orm_tools` 데이터베이스를 만들고, replica가 이를 적용한다.
4. ProxySQL과 PgBouncer를 시작하고, 각 서버가 listen한 뒤 쓰는 로그 줄을 기록하면 다음 단계로 진행한다.
5. 마지막에 `.runtime/servers/env`를 쓴다.

ProxySQL 사용자는 `orm`, 비밀번호는 `orm`이다. PgBouncer는 primary의 모든 데이터베이스를 제공한다. PostgreSQL primary는 `synchronous_standby_names`에 standby를 지정하고 `synchronous_commit=local`을 쓰므로, `synchronous_commit=remote_apply`를 설정하고 WAL을 쓰는 트랜잭션은 standby가 그 트랜잭션을 적용한 뒤에 commit된다. commit 기록 외에 WAL을 쓰지 않는 트랜잭션은 기다리지 않으므로, replica 테스트는 그 트랜잭션에서 트랜잭션 logical message(`pg_logical_emit_message(true, …)`)를 쓴다.

환경 파일은 `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`, 실행마다 만드는 database의 server DSN `ORM_RUN_MYSQL_DSN`, `ORM_RUN_POSTGRES_DSN`과 SQLite query `ORM_RUN_SQLITE_QUERY`, MySQL TLS case의 DSN `ORM_TEST_MYSQL_TLS_DSN`, `ORM_TEST_MYSQL_TLS_OTHER_CA_DSN`, `ORM_TEST_MYSQL_TLS_MISMATCH_DSN`, 그리고 서버의 lease directory `ORM_TEST_SERVERS_LEASES`를 export한다. 이 파일이 있으면 `make orm-test-servers`는 파일 내용을 출력하고 아무것도 바꾸지 않는다. 시작이 실패하면 시작한 서버를 중지하고 로그를 남긴다. `make orm-test-servers-stop`은 서버를 중지하고 `.runtime/servers`를 삭제한다. CI workflow `.github/workflows/ci.yml`은 같은 프로그램을 설치하고 `make orm-test-servers`로 서버를 시작한 뒤 환경 파일을 이후 단계의 환경에 더한다. workflow는 이 변수를 직접 정의하지 않으며, `make repo-check`는 workflow가 변수 하나라도 제공하지 않거나, 직접 정의하거나, 서버 시작 전에 make target을 실행하면 실패한다.

여러 checkout의 실행과 다른 도구가 같은 서버를 동시에 쓸 수 있으므로 그 사용은 lease(`tests/lease`)로 다룬다. `TEST_ENV`를 읽는 make 줄은 그 줄이 끝날 때까지 `ORM_TEST_SERVERS_LEASES`의 shared lease를 가진다. `make orm-test-servers-stop`, 새로 하는 `make orm-test-servers`, MySQL migration은 exclusive lease를 가지며, lease가 하나라도 있으면 보유자마다 checkout, process id, 시작 시각, 명령을 적고 거부된다. make 밖의 도구는 `.runtime/bin/lease hold <ORM_TEST_SERVERS_LEASES> shared --pid <pid>`로 자기 process가 끝날 때까지 shared lease를 가진다. 보유한 lease는 보유자와, 보유자가 끝나면 그것을 지우는 releaser를 적는다. 보유자는 끝났지만 releaser가 실행 중인 lease는 풀리는 중이므로 기다리는 요청은 그것을 기다린다. 보유자와 releaser가 모두 끝난 lease는 보유자 없는 lease이고 아무도 막지 않는다. 보유자 없는 shared lease는 어느 요청이든, 보유자 없는 exclusive lease는 다음 exclusive 요청이 가져가며 그 요청이 자원을 다시 만든다. 보유자 없는 exclusive lease가 남아 있는 동안 shared 요청은 거부된다. 그 보유자가 자원을 만들다 끝났을 수 있기 때문이다. 가져갈 때마다 그것을 적는다. `make orm-test-servers-leases`는 lease를 적고, `make orm-test-servers-leases-clear`는 보유자 없는 lease를 지우며 그것을 적는다.

함께 쓰는 bench나 decimal database는 없다. `make check-run`, `make feature-owner-check`, `make run-databases TARGETS="<target>..."`는 `scripts/check/databases.mts`로 자기 실행의 bench와 decimal database를 만들어 seed하고, `TEST_ENV`(`BENCH_MYSQL_DSN`, `BENCH_POSTGRES_DSN`, `BENCH_SQLITE_DSN`, `ORM_BENCH_MYSQL_DSN`)와 `DECIMAL_ENV`로 모든 target에 주며, 끝에 지운다. 그것을 읽는 target은 server 환경만으로 실행하면 실패하므로 `make run-databases`로 실행한다.

`make orm-check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `client-pooler-check`, `case-database-check`, `conformance-check`, `db-test`, `perf-check`는 `.runtime/servers/env`를 읽고, 파일이 없으면 실패한다. `client-pooler-check`는 `ORM_TEST_POSTGRES_DSN`을 PgBouncer DSN으로, `ORM_TEST_MYSQL_DSN`을 ProxySQL DSN으로 바꾸어 클라이언트 데이터베이스 테스트를 실행한다. 이 target들은 환경 파일의 서버 DSN을 `ORM_TEST_MYSQL_SERVER_DSN`과 `ORM_TEST_POSTGRES_SERVER_DSN`으로도 export하며, pooler check는 이 둘을 바꾸지 않는다. rollback 실패 case는 이 DSN으로 transaction의 서버 session을 종료한다. ProxySQL은 text protocol의 `KILL`을 자기 client session에 대한 명령으로 받기 때문이다.

클라이언트 데이터베이스 case는 `ORM_TEST_MYSQL_DSN`이나 `ORM_TEST_POSTGRES_DSN`이 가리키는 데이터베이스를 쓰지 않고, 그 데이터베이스가 비어 있다고 가정하지 않는다. 빈 데이터베이스를 확인하거나 schema를 설치하는 case는 그 DSN으로 자기 데이터베이스 `orm_case_<pid>_<n>`을, SQLite에서는 임시 directory에 자기 파일 `orm-case-<pid>-<n>.sqlite`를 만들고, 끝날 때 실패한 뒤에도 지운다. DSN의 사용자에게는 데이터베이스를 만드는 권한이 필요하다. `make case-database-check`는 두 공유 데이터베이스에 table 하나를 남겨 둔 채 현재 Go, PHP, TypeScript, Python, Rust의 model case를 실행하고 PHP extension 데이터베이스 case는 별도로 추적하며, case가 통과하며 공유 데이터베이스, 그 PostgreSQL schema, `orm_case_` 데이터베이스와 `orm-case-` 파일을 그대로 두지 않으면 실패한다.

## 컨테이너의 test database server

`make orm-test-container KIND=<mysql|postgres|mariadb>`와 `make orm-test-container-run KIND=<kind> RUN='<command>'`는 한 kind의 server를 program `bay`가 실행하는 Compose project로 시작한다(`scripts/test-servers-container.mts`). macOS에서는 Apple `container`, Linux에서는 Docker 위에서 실행된다. 모든 단계는 `bay`의 command이고 container engine은 직접 실행되지 않는다.

**run은 `sh`와 `bay`만으로 실행된다.** server와 check를 실행하는 machine에는 `sh`, `bay`, `bay`의 container engine만 있으면 된다. 그 host에는 아무것도 설치하지 않고, 그 host의 node, cargo, make, git을 쓰지 않는다. image와 database check는 disk가 넉넉한 machine에서 실행되며 그 machine은 개발 machine이 아니기 때문이다. 그래서 일을 나눈다. `scripts/test-servers-container.mts`는 run의 directory를 쓰기만 하고, 그 directory의 POSIX `sh` file `run.sh`가 실행한다. `run.sh`의 각 단계는 `bay -p <project>`의 command 하나이고 그 exit status가 run을 판정한다. file은 JSON을 읽지 않고, timer를 시작하지 않고, 요청을 반복하지 않는다.

**run의 project.** 각 start는 자기 checkout에 directory `.runtime/containers/<project>`를 만든다. `<project>`는 `orm-<checkout>-<run>`이다. `<checkout>`은 checkout root의 sha256의 처음 16진수 12자리이고, `<run>`은 그 start의 무작위 16진수 8자리다. 다른 machine에서의 run이면 `<run>`은 commit, kind, command, 값들의 sha256의 처음 16진수 8자리여서, 같은 command를 다시 시작하면 같은 project를 가리킨다. `bay`의 각 command는 option `-p`로 project 이름을 받고, Compose file은 project 이름을 적지 않는다. 그래서 두 checkout, 그리고 한 checkout의 두 run은 project, container, file을 공유하지 않는다. directory가 system의 임시 directory가 아니라 checkout 아래에 있는 이유는, server를 제거하기 전에 kill된 run의 project를 `make orm-test-container-stop`이 찾기 위해서다. 그 안에는 다음이 있다.

| File | 내용 |
|---|---|
| `compose.yaml` | server의 service. runner 형태에서는 script가 plan을 읽는 `compose.run.yaml`의 복사본이다 |
| `run.sh` | run의 단계. `sh run.sh`는 run 전체이고 `sh run.sh down`은 project를 제거한다. host 형태에서 `sh run.sh up`은 server를 시작하고 `servers.env`를 쓰며, runner 형태에서 `sh run.sh add <part>`는 part의 job을 queue에 넣고 그 ID를 출력하고, `sh run.sh wait <part>`는 그 job을 끝까지 따라간다. `sh run.sh pull`은 image를 download한다 |
| `servers.env` | 시작된 server의 변수. host 형태에서는 `run.sh`가, runner 형태에서는 `job-check.sh`가 쓴다 |
| `tls/other-ca.pem` | TLS case의 두 번째 CA. 아무것도 서명하지 않는다 |
| `<service>-init/` | service의 초기화 file |
| `runner-setup.sh`, `build.sh`, `check.sh`, `repo.bundle` | runner 형태: 설치, build command, run의 command, run의 commit |
| `job-build.sh`, `job-check.sh`, `setup-<kind>.sh`, `address-<kind>` | runner 형태: job build와 check의 command, kind마다 있는 service `setup-<kind>`의 단계, `setup-<kind>.sh`가 쓰는 그 kind의 primary의 IPv4 주소 |
| `compose.build.yaml`, `compose.run.yaml` | runner 형태: job `build`만 있는 part build와, server, kind마다 있는 service `setup-<kind>`, job `check`가 있는 part check |
| `report/` | run이 기록하는 것: `bay-version`, `steps.log`, host 형태에서는 `bay-up-servers.log`의 `bay up` 출력, runner 형태에서는 `job-<part>.json`에 `bay`가 각 job에 대해 기록하는 것, `job-<part>.log`의 그 출력, 그리고 설치와 `setup-<kind>.sh`와 command의 출력과 status |

**run의 두 형태.** run은 두 형태 중 하나다. script가 directory를 쓸 때 형태를 `run.sh`에 기록하고, run이 실행되는 동안 형태는 바뀌지 않는다. host 형태에서 run의 command는 server의 변수를 가진 host의 process이고, Darwin 같은 host system의 결과를 준다. runner 형태(`FORM=runner`)에서 run은 runner 안의 `bay` job 두 개이고, host에는 이 repository의 tool이 필요 없다. 두 형태는 같은 server service와 그것을 준비하는 같은 단계를 가진다.

**service.** project에는 그 각 kind의 server마다 service 하나가 있고, runner 형태에서는 kind마다 한 번 실행되는 service `setup-<kind>`와 job `build`, `check`도 있다.

| Kind | Service |
|---|---|
| `mysql` | primary `mysql`; 그 read-only replica `mysql-replica` |
| `postgres` | primary `postgres`; 그 standby `postgres-replica` |
| `mariadb` | primary `mariadb` |

각 service는 `config/containers.json`이 digest로 고정한 image와 `expose`에 server의 port를 적고 key `ports`는 적지 않는다. 그래서 host의 port는 publish되지 않는다. server는 `make orm-test-servers`의 native primary의 설정을 받는다(time zone, 소문자 table 이름, binary log 보존, InnoDB log 공간, PostgreSQL은 WAL과 synchronous standby). 각 image의 data directory는 service의 `tmpfs`이므로 data는 container와 함께 끝나고 volume은 남지 않는다.

**한 run의 여러 kind.** `make orm-test-container-run`과 `make orm-test-container-remote`의 `KIND`는 kind 하나이거나 `mysql,postgres`나 `mysql,postgres,sqlite`처럼 쉼표로 이은 kind 목록이다. SQLite는 각 case의 file이므로 `sqlite`는 server를 적지 않는다. 목록에는 server가 있는 kind가 적어도 하나 있어야 하고, 각 kind는 한 번만 적는다. 목록의 run은 project 하나이며, 그 안에 각 kind의 service와 각 kind의 단계가 있고, 각 kind의 변수가 `servers.env` 하나에 있다. 그래서 `make client-db-check`, case 하나를 SQLite, MySQL, PostgreSQL에서 실행하는 Rust case, Python과 TypeScript의 INT-92 case처럼 여러 database를 함께 읽는 check는 그대로 실행되고 database별로 나뉘지 않는다. 각 kind의 mismatch DSN은 그 kind의 primary의 IPv4 주소를 적는다. `make orm-test-container`는 kind 하나를 시작한다. 그 환경 file이 kind 하나의 것이기 때문이다.

**server의 memory 설정.** container의 server는 native server보다 작은 cache를 쓴다. 그래야 `mysql,postgres`의 server 네 개가 job 한도가 2800 MB인 3.7 GiB machine에서 runner의 job과 함께 들어간다. `innodb_buffer_pool_size`는 각 MySQL과 MariaDB server에서 64 MiB이고(기본값 128 MiB), `shared_buffers`는 각 PostgreSQL server에서 32 MB다(기본값 128 MB). 각 case는 작은 database를 따로 만들므로 check에는 더 큰 cache가 필요하지 않다. cache는 page를 memory에 둘 뿐이므로 그 크기는 결과를 바꾸지 않는다.

**주소.** check는 `bay`가 service에 주는 host 이름으로 server에 닿고, 모든 DSN이 server를 그 이름으로 적는다. script는 host 이름의 형식도 접미사도 가지고 있지 않다. directory를 쓸 때, 그 directory를 실행할 machine의 `bay plan --json`에서 각 service의 host 이름과 certificate의 authority path를 읽어 `compose.yaml`과 `run.sh`에 쓴다. 그래서 Compose file은 plan을 위해 한 번, plan의 host 이름으로 한 번 쓴다. PostgreSQL standby가 command에 primary를 적기 때문이다. mismatch DSN의 IPv4 주소는 start 뒤에만 있다. `run.sh`는 primary의 container 안에서 `getent ahostsv4 <host 이름>`이 출력하는 첫 단어로 이를 읽고(`getent hosts`는 service의 IPv6 주소를 먼저 출력한다), 거기서 주소가 없는 host 이름은 run을 실패시킨다. 그래서 실행하는 `bay`와 다른 `bay`를 위해 쓰인 directory는 실패하고 어디에도 연결하지 않는다.

**준비 완료.** 각 service는 server의 준비 확인 program을 container 안에서 127.0.0.1의 TCP로 실행하는 Compose `healthcheck`를 선언한다. image가 data directory를 초기화하려고 시작하는 임시 server는 socket에서만 listen하기 때문이다. MySQL은 `mysqladmin ping`, PostgreSQL은 `pg_isready`, MariaDB는 image의 script `healthcheck.sh --connect --innodb_initialized`다. PostgreSQL standby는 primary에 대해 조건 `service_healthy`의 `depends_on`을 선언한다. `bay up`이 exit status 0으로 돌아오면 server는 준비된 것이다. `run.sh`는 그 command 하나만 기다린다. container의 log를 읽지 않고, timer를 시작하지 않고, 요청을 반복하지 않는다. start의 한도는 Compose file의 `healthcheck`이며 `bay`가 그것을 거기에 요구한다. `start_period`는 600초로, image가 data directory를 초기화하는 시간이다. 부하가 있는 machine에서는 그 초기화에 몇 분이 걸리며, 그 시간 안의 실패한 probe는 세지 않는다. 그 뒤에는 1초 간격(`interval`)의 probe 10회(`retries`, `bay`는 1부터 100까지 받는다)가 각각 5초 제한(`timeout`)으로 start를 실패시킨다. container가 멈추면 start는 즉시 실패한다.

**시작된 server의 준비.** host 형태에서는 `bay up`이 돌아온 뒤 `run.sh`가 server를 준비하는 각 단계를 `bay exec`로 그 container 안에서 실행한다. runner 형태에서는 kind마다 있는 service `setup-<kind>`가 그 단계를 실행한다. 이 service는 그 kind의 server의 image로 만든 container이며, 단계는 그 image의 client를 쓴다. `bay`는 그 kind의 각 server가 healthy가 된 뒤, 그리고 그 각각이 성공적으로 끝나기를 기다리는 job `check` 전에 이 service를 시작한다. `setup-<kind>.sh`는 각 단계를 image의 client로 service의 host 이름에 TCP로 실행한다. MariaDB client는 server의 인증서를 검증하므로 `bay`가 mount하는 authority를 지정한다. `bay`의 job은 시작된 container 안에서 command를 실행하지 않으므로, 단계는 project의 service 안에서 실행된다. 각 단계는 native server의 순서대로 끝까지 실행되고, 0이 아닌 status로 끝난 단계는 그 단계를 적으며 run을 그 status로 끝낸다.

| 단계 | 실행되는 곳 | 그곳인 이유 |
|---|---|---|
| MySQL: primary의 `RESET BINARY LOGS AND GTIDS` | 첫 번째 | binary log에는 image의 초기화가 들어 있고 replica의 image도 같은 초기화를 실행했다. reset은 그 초기화 뒤, replica가 log를 읽기 전에 와야 한다 |
| MySQL: replica가 source를 지정하고 replication을 시작하고 `super_read_only`와 `partial_revokes`를 설정한다 | 두 번째 | `START REPLICA`는 primary에 연결하고, 두 설정은 실행 중인 server를 바꾼다. replica에는 `--skip-replica-start`가 있어 reset 전에는 아무것도 읽지 않는다 |
| MySQL과 MariaDB: database `orm_test`와 `orm_tools`, user `orm`의 account | 마지막 | MySQL replica가 binary log에서 이를 적용하므로 replica가 따라온 뒤에 온다 |
| PostgreSQL: role `orm`의 replication을 허용하는 `pg_hba.conf` 규칙 | primary의 `/docker-entrypoint-initdb.d`의 file | `bay up`은 primary가 healthy가 되자마자 standby를 시작하므로, 규칙은 primary가 첫 연결을 받기 전에 있어야 한다 |
| PostgreSQL: standby는 slot `orm_replica`를 통한 primary의 `pg_basebackup`이다 | service `postgres-replica`의 command | standby의 server가 시작하기 전에 data directory를 채운다 |
| PostgreSQL: database `orm_test`와 `orm_tools` | 단계 | native primary처럼 standby가 따라온 뒤에 primary가 만든다 |

**run은 자기 server를 소유한다.** host 형태에서 `run.sh`는 command가 끝나거나 실패할 때, 단계가 실패할 때, 그리고 SIGINT, SIGTERM, SIGHUP에서 `bay down`으로 자기 project를 제거한다. run의 command는 이 신호마다 SIGTERM을 받는다. `sh`가 자기 옆에서 시작한 command는 SIGINT를 무시하기 때문이다. `bay up`이 실패한 run은 먼저 `bay logs`로 각 service의 마지막 줄을 출력한다. runner 형태에서는 `bay`가 job `check`를 위해 server를 시작하고 그 뒤에 제거하며, `run.sh`는 이 신호 중 하나를 받으면 자기가 queue에 넣고 아직 끝나지 않은 job을 취소한다. `run.sh`는 무엇이든 시작하기 전에 file `started`를, project가 제거된 뒤에 file `removed`를 쓴다. `make orm-test-container-run`은 끝난 run의 directory를 제거하고, `started`는 있고 `removed`는 없는 directory, 즉 project가 제거되지 않은 directory는 남긴다. `KEEP=1`은 runner의 tool과 build를 위해 끝난 run의 directory를 남기고, `sh <directory>/run.sh`가 그것을 다시 실행한다. `make orm-test-container-stop`은 checkout의 server의 exclusive lease를 잡고, kill된 run의 project를 포함해 checkout의 모든 project를 제거한다. 다른 checkout의 project는 제거하지 않는다.

**image.** 어떤 run도 image를 download하지 않는다. `run.sh`는 `bay up`이나 `bay job add` 전에 `bay images`를 실행하고, 이것은 project의 image가 machine에 없으면 실패하며, run은 `make orm-install-container-images`를 적으며 실패한다. `bay up`은 `-no-pull`로 실행되고, image가 없으면 아무것도 만들기 전에 실패한다. 개발 machine에서 image를 download하는 command는 `make orm-install-container-images`뿐이다. 이것은 server와 runner의 image를 적은 Compose file에 대해, 자기가 제거하는 directory 안에서 `bay pull`을 실행한다. 다른 machine에서는 `PULL=1`이 실행하는 `sh run.sh pull`이 project의 image를 pull한다.

**변수.** `run.sh`, runner 형태에서는 `job-check.sh`가 마지막 단계 뒤에 run의 각 kind의 변수로 `servers.env`를 쓴다. `check.sh`는 그 file을 command의 `TEST_ENV`와 `MARIADB_ENV`로 주므로, `make client-db-check`처럼 server의 환경 file을 읽는 target은 그것을 읽는다. `make orm-test-container`는 이를 `.runtime/containers/<kind>.env`로 복사하고, run은 그 변수를 command에 준다. MySQL과 PostgreSQL 변수는 `TEST_ENV`의 primary의 변수이고, MariaDB 변수는 `MARIADB_ENV`의 primary의 변수이며, MySQL과 PostgreSQL에는 replica DSN이 있다. 각 server는 `bay`가 service의 host 이름으로 발급해 container에 mount하는 certificate를 제시하므로 script는 server의 certificate를 발급하지 않는다. TLS DSN은 `bay`의 authority로 이를 검증한다. 두 번째 CA의 DSN은 chain에서 실패한다. 두 번째 CA는 script가 그 run을 위해 발급하며 아무것도 서명하지 않는다. mismatch DSN은 primary의 IPv4 주소로 연결하는데 certificate는 그 주소를 적지 않는다. host 형태에서 DSN은 authority와 두 번째 CA를 host의 path로, runner 형태에서는 runner 안의 path로 적는다. pooler는 시작하지 않는다. 그 변수는 없으며, 그 변수를 읽는 check는 변수 이름을 적어 실패한다.

**runner.** runner의 각 job은 `config/containers.json`이 digest로 고정한 Debian 기반 image로 실행된다. 이 repository의 image는 build되지 않고 어떤 registry에도 없다. runner는 run의 directory를 `/orm-run`에 mount하고 host의 checkout은 mount하지 않는다. 개발 host와 runner는 다른 system이어서, 한 checkout 안에서 그 tool, package, build 출력이 서로를 대체하기 때문이다. runner는 script가 쓰는 checkout commit의 Git bundle `repo.bundle`에서 만든 자기 clone `/orm-run/repo`에서 일한다. git은 host가 아니라 runner에서 실행된다. 그래서 runner 안의 run은 commit의 run이고, script는 tracked file이 commit과 다른 checkout을 거부한다. runner의 home(`HOME`, `/orm-run/home`), tool(`CARGO_HOME`, `RUSTUP_HOME`, machine의 node), package, cargo target directory는 run의 directory 아래에 있고 named volume은 쓰지 않으므로, directory를 제거하면 모두 제거된다. 각 job은 mount된 directory 아래의 같은 home을 가리키므로, job `build`가 그곳에 쓴 것, 예를 들어 git 설정과 Go module은 job `check`에도 있다. 어떤 image에도 이 directory가 없으므로 `runner-setup.sh`가 tool이 쓰기 전에 만든다.

`runner-setup.sh`는 container 안에서 root로, 이 문서의 첫 설치 순서대로 runner를 설치한다. Debian package, machine의 node, rustup, clone, `devEngines`의 npm으로 하는 `npm ci`, 그리고 이 repository의 설치 target `make install`이다. `make install`은 tool, package, toolchain을 설치하고, Go module과 Rust crate처럼 check가 읽는 것을 모두 download하므로, offline으로 실행되는 run의 command가 그 target의 선행 조건이 읽는 것을 찾는다. runner의 home(`HOME`)은 run의 directory 아래에 있다. job은 각자의 container이고, job `build`가 home 아래에 download한 Go module을 job `check`가 읽기 때문이다. 이것은 설치 단계이며 download한다. package manager 밖에서 download하는 각 file은 `config/containers.json`이 그 processor에 대해 고정한 sha256일 때만 쓴다. 남겨 둔 directory에 이미 있는 단계는 건너뛴다.

| 설치하는 것 | 이유 |
|---|---|
| `git` | bundle을 clone한다. repository의 tool이 이를 통해 tracked file을 읽는다 |
| `make`, `gcc`, `g++`, `pkg-config`, `libssl-dev` | recipe, 그리고 crate와 package가 build하는 native code |
| `curl`, `ca-certificates`, `xz-utils`, `unzip`, `openssl` | setup과 installer의 download, check의 TLS file |
| `php8.4-cli`, `php8.4-xml`, `php8.4-mbstring`, `php8.4-curl`, `php8.4-zip`, `composer` | `.php-version`의 PHP와 PHP check가 load하는 extension |
| `php8.4-dev` | 그 PHP의 `phpize`와 `php-config`. `make install`이 PHP extension의 build를 위해 확인한다 |
| `lld` | runner의 Rust build의 linker |
| nodejs.org의 node tarball, `mise.toml`이 고정한 release | machine의 node. 첫 `npm ci`와 `make install-tools TOOLS=npm`에 필요하다 |
| `rustup-init`, `config/containers.json`이 고정한 release | `rust-toolchain.toml`의 toolchain을 설치한다 |

runner는 `lld`로 link한다(Linux target에 `rustflags = ["-C", "link-arg=-fuse-ld=lld"]`). memory 3.7 GiB인 machine에서 한 commit의 test를 빈 target directory에서 build하는 데 기본 linker로는 30분과 swap 3.0 GiB, `lld`로는 16분 22초와 0.86 GiB가 들었다. 이 설정은 runner의 `CARGO_HOME`의 `config.toml`이므로 host의 어떤 run도 읽지 않는다. runner는 다른 service처럼 `bay`의 trust와 certificate를 그대로 받는다. `bay`는 자기 file을 `/etc/bay` 아래에 mount하고 image의 certificate store 위에 file을 두지 않으므로, setup은 `ca-certificates`를 다른 package처럼 설치한다. runner의 TLS DSN은 `bay`가 container에 authority를 mount하는 path를 적으며, 그 path는 `bay plan --json`이 준다(`certificate.containerCa`). service는 port가 없고 `restart: "no"`를 선언하므로 멈춰도 다시 시작되지 않는다. runner의 memory 한도와 job 수는 아래에 적은 대로 실행하는 쪽이 준다.

`check.sh`는 clone 안에서 runner의 tool과 `servers.env`의 변수로 run의 command를 실행한다. 그 출력은 `report/check.log`에도 있고, exit status는 `report/status`에 있으며, `ORM_RUN_REPORT`가 command가 더하는 것을 위해 `report/`를 가리킨다. `build.sh`는 같은 방식으로 server의 변수 없이 build command를 실행하고 `report/build.log`와 `report/build-status`를 남긴다.

**runner의 job.** runner 안의 run은 `bay` job(`x-bay.job`) 두 개다. `bay job add`가 job을 queue에 넣고, machine은 자기 job과 다른 project의 job을 넣은 순서대로 한 번에 하나씩 실행하므로, run은 machine의 다른 job과 겹치지 않는다. job은 그것을 넣은 command가 아니라 `bay` agent의 process에서 실행되므로, 연결이 끊기거나 command가 끝나도 job은 끝나지 않고 결과를 보관한다. `run.sh`는 각 job을 key `<project>-<part>`로 넣고, `bay`는 그 key의 job이 있으면 두 번째 job을 넣지 않고 그것을 돌려주므로, 연결이 끊긴 뒤 다시 시작한 command처럼 다시 넣은 part는 한 번만 실행된다. 각 job의 `x-bay.timeout`은 `config/containers.json`의 `runner`의 `timeout`으로, run 한 번이 걸릴 수 있는 가장 긴 시간이며 일부러 file에 둔다. job `build`(`compose.build.yaml`, `job-build.sh`)는 runner를 설치하고 `BUILD`를 실행한다. job `check`(`compose.run.yaml`, `job-check.sh`)에는 server와 `bay`가 그 전에 시작하는 kind마다의 service `setup-<kind>`가 있고, 각 `setup-<kind>.sh`가 쓴 주소로 `servers.env`를 쓰고 `RUN`을 실행한다. run 전체는 `build`가 성공한 뒤에만 `check`를 queue에 넣고, 둘 다 성공하면 0, job이 끝났으나 성공하지 않았으면 1, job이 끝나지 않았거나 `bay`가 보여 주지 못하면 3으로 끝난다. job은 `bay job wait`의 exit status가 아니라 `bay job show`가 기록한 것, 즉 끝났는지와 어떤 상태인지로 판정한다. `bay job wait`는 기다림이 job보다 먼저 끝날 때도 1로 끝나기 때문이다. `run.sh`는 각 job의 출력을 `bay job logs -f`로 따라가고, `bay`가 그 job에 대해 기록하는 것, 즉 exit status, 시간, machine이 보고하는 경우 최고 memory를 `report/job-<part>.json`에, 그 출력을 `report/job-<part>.log`에 쓴다.

**run의 memory.** run의 container들은 한 machine의 memory를 나눠 쓰고, machine은 그 합에서 container를 끝낼 수 있다. `bay`의 container들이 합쳐서 2.6 GB에서 느려지고 3.0 GB에서 끝나는 machine에서, 최고 memory가 3146~3196 MiB로 측정된 Rust test의 build는 server 두 개 옆에 들어가지 않는다. 그래서 build는 server가 없는 job `build`이고, server는 job `check`를 위해 시작된다. `BUILD`는 build command로, 예를 들면 test를 실행하지 않고 build하는 target이다. 실패한 build는 그 job의 결과로 run을 끝내고, server는 시작되지 않는다. `BUILD`가 없는 run도 같은 두 job을 가지며, 그 command가 필요한 것을 server 옆에서 build한다.

세 값은 실행하는 쪽이 machine에 맞게 주며, 이 repository는 그 값을 가지지 않는다. build의 최고 memory는 job 수에 따라 커지고 machine의 memory는 서로 다르기 때문이다. `CARGO_BUILD_JOBS`는 cargo의 job 수로, `runner-setup.sh`가 runner의 cargo 설정에 쓴다. `RUNNER_MEMORY`는 runner의 각 job의 `mem_limit`이며, 주지 않으면 없다. `SERVER_MEMORY`는 각 server의 `mem_limit`이며, 주지 않으면 4 GiB다. `mysqld`는 container의 기본값인 1 GiB 안에서 끝나기 때문이다.

`run.sh`는 run이 쓴 것을 기록한다. 각 단계의 시각을 출력과 `report/steps.log`에 쓰고, 실패한 단계는 그 단계와 exit status를 함께 쓴다. job과 `setup-<kind>.sh`도 같은 file에 자기 것을 더한다. host 형태에서 `bay up`의 출력은 `run.sh`의 출력과 `report/bay-up-servers.log`에 있고, 그 exit status는 `report/bay-up-servers.status`에 있으며, `bay up`이 실패하면 각 service log의 마지막 줄이 그 뒤에 이어진다. `bay`는 실패한 service와 원인을 출력하므로, 보고에서 시작이 실패한 이유를 볼 수 있다. `bay`는 service를 의존 순서대로 하나씩 시작하고 각 service의 healthcheck를 기다린 뒤 다음 service를 만들기 때문에, 실패한 service 뒤의 service에는 container가 없고 그 log가 그것을 보고한다. runner 형태에서는 service 시작의 출력을 담은 job의 출력이 `report/job-<part>.log`이고, machine이 보고하는 경우 job의 최고 memory는 `report/job-<part>.json`에 있다.

**다른 machine에서의 run.** `bay`는 자신이 실행되는 machine에서만 project를 시작하고 제거하므로, server를 다른 machine에 두는 것은 run 전체가 그곳에서 실행되는 것이다. `make orm-test-container-remote KIND=<kind> RUN='<command>' HOST=<ssh host> REMOTE=<directory>`는 그 machine의 `bay`의 plan을 `ssh`로 읽어 runner 형태의 run을 쓰고, run의 directory를 tar archive로 `ssh`를 통해 `<directory>/<project>.part`에 보낸 뒤 `<directory>/<project>`로 이름을 바꾼다. 그곳에 `run.sh`가 있는 directory는 온전한 것이고 다시 보내지 않는다. 그다음 `ssh <host> sh <directory>/<project>/run.sh add <part>`로 각 job을 그곳의 queue에 넣고(이것은 job의 ID를 출력한다), `ssh <host> sh <directory>/<project>/run.sh wait <part>`로 기다린다. job을 queue에 넣은 순간부터 그 job을 아는 것은 job을 실행하는 machine뿐이므로, 기다림은 그 machine에서 실행된다. `run.sh wait`는 job의 `bay job show -json`을 `report/job-<part>.json`에, 그 출력을 `report/job-<part>.log`에 쓰고, `bay`가 job에 대해 기록한 것으로 job을 판정한다. job이 끝나고 성공했으면 0, 끝나고 성공하지 않았으면 1, 끝나지 않았거나 `bay`가 보여 주지 못하면 3이다. `bay job wait`는 기다림이 job보다 먼저 끝날 때도 1로 끝나기 때문이다. 그 3이나 끊긴 연결 때문에 이곳에서 끝을 알 수 없는 job은 실패한 job이 아니다. 그때 target은 다음 job을 queue에 넣지 않고, `report/`를 가져오고, queue에 들어간 job이 아직 읽는 파일이 있는 그곳의 directory를 남기고, 3으로 끝난다. 그렇지 않으면 `report/`를 `.runtime/containers/reports/<project>`로 가져온 뒤에야, `KEEP=1`이 아니면 그곳의 directory를 제거한다. 그 exit status는 job `check`의 결과이고, `build`가 실패했으면 `build`의 결과다. job이 읽는 모든 파일은 job을 queue에 넣기 전에 최종 directory에 있다. 같은 commit에서 같은 command는 같은 project를 가리키므로, 연결이 끊긴 뒤 다시 시작한 command는 아무것도 보내지 않고, job을 두 번 queue에 넣지 않으며, 끝나지 않은 job을 다시 기다린다. `run.sh`는 machine을 적지 않는다. 이 target만 host와 directory를 적는다.

**Unix socket을 통한 check.** `bay`는 Unix socket을 host에 publish하지 않고, Apple `container`의 각 container는 자기 kernel을 가지므로 container의 socket은 다른 container에서 닿지 않는다. 그래서 `ORM_TEST_MYSQL_SOCKET`과 `ORM_TEST_MARIADB_SOCKET`은 `servers.env`에 없고, 그것을 읽는 check는 그 변수를 적으며 실패한다. server의 socket을 통한 check는 그 server의 container 안에서 실행되어야 하는데 `bay`의 job은 시작된 container 안에서 command를 실행하지 않으므로, 어떤 run에도 그 check는 없다. `SOCKET_BUILD`나 `SOCKET_RUN`을 받은 run은 거부되고, 그것 없이 실행되지 않는다.

**kind당 start 하나.** `make orm-test-container`는 checkout에서 이미 시작했고 `make orm-test-container-stop`이 아직 제거하지 않은 kind를 거부한다. `.runtime/containers/<kind>.env`가 project 하나를 가리키기 때문이다. `make orm-test-container-run`의 run은 세지 않는다. 각 run은 자기 project를 가지고 공유 file을 쓰지 않는다.

**`bay`는 machine의 tool이다.** run은 `make`를 쓰듯이 자기 machine의 `bay`를 쓰며, 그 version을 고정하지도 비교하지도 않는다. run의 결과를 바꾸는 것은 release의 번호가 아니라 script와 `run.sh`가 읽는 출력의 contract다. 그래서 둘은 무엇이든 만들기 전에 자신이 맞춰 쓰인 contract schema version을 확인하고, 다르면 실패한다. 그 값은 `bay version`이 보고한다. 개발 machine의 `bay`는 자주 새로 build되므로 번호 비교는 일을 막기만 한다. `run.sh`는 `bay version`의 줄을 자기 출력과 `report/bay-version`에 쓰므로, run의 기록이 그것을 실행한 `bay`를 적는다. 다른 machine에서의 run은 무엇이든 쓰거나 보내기 전에 `ssh`로 그 machine의 `bay`의 contract를 읽는다.

**CI가 설치하는 release.** CI job에는 `bay`가 없어 download해야 하므로, 어느 release를 받는지가 tracked file에 있다. `config/containers.json`은 `bay` 아래에 version, file의 주소, 그 release의 `SHA256SUMS`에서 온 각 platform archive의 sha256을 고정한다. `make orm-install-bay`는 platform의 archive를 download하고, 그 sha256일 때만 쓰며, `bay`와 `bayd`를 checkout의 `var/tools/bay`에 둔다. machine은 아무것도 바꾸지 않는다. `make orm-install-bay-machine`은 `bay install`과 `bay check -scope run`을 실행한다. 전자는 없는 machine 설정을 적용하며 필요한 권한을 요청하고, 후자는 run에 필요한 부분이 없는 동안 실패한다. 사람이나 CI job이 이를 실행하며, 다른 어떤 target도 machine 설정을 바꾸지 않는다. 어떤 run도 이 pin을 읽지 않는다. pin은 한 변경으로 올린다. version, 주소, sha256 네 개가 새 release와 그 `SHA256SUMS`의 값을 받고, release가 다른 contract schema version을 보고하면 script의 `SCHEMA`가 따라가며 그 contract가 Compose file과 `run.sh`에서 바꾸는 것도 함께 바꾼다.

**`bay`의 command.** `run.sh`는 `bay`의 command를 변수 하나 `BAY_COMMAND`에서 받는다. 단어 하나 이상이며, 없으면 `PATH`의 `bay`를 실행하고, Makefile의 값도 그것이다. run을 시작하는 쪽이 이를 정한다. 그 machine에서 `bay`가 어느 user로 실행되는지는 그쪽만 알기 때문이다. `bay`는 자신을 실행한 user의 home 아래에 상태를 두고, Linux에서는 machine 설정과 command에 root가 필요하므로, 한 machine의 모든 command는 같은 user로 실행되어야 한다. user가 암호 없는 `sudo`를 가진 CI runner는 `var/tools/bay/bay`의 path로 `BAY_COMMAND='sudo -n <bay의 path>'`를 정해, `bay install`과 run의 각 command가 root의 것이 되게 한다. `make orm-test-container-remote`는 다른 machine에서의 command인 `REMOTE_BAY_COMMAND`를 그곳에서 시작하는 `run.sh`에 넘긴다.

**없는 program.** `BAY_COMMAND`가 가리키는 program이 없으면 start는 아무것도 만들기 전에 실패한다. message는 그 program과 그것이 run을 위해 하는 일을 적는다. `run.sh`도 자신을 실행하는 machine에서 같은 확인을 한다.

`make orm-test-container-check`는 이 규칙을 각 test가 쓰는 대역 `bay`로 시험하므로 container도 image도 필요하지 않다.

## Interface 변경

공통 contract, generated artifact, language client, example, structure check를 함께 갱신한다. 특정 client에만 공개된 기능은 미완료로 처리한다.

## Commit message

동작을 나타내는 짧은 영문 명령형 제목을 사용한다. 예: `Implement root IN chunking`. 하나의 commit에는 하나의 변경 범위만 둔다.

## 변경

동작 변경, 영향받은 client와 database, 실행한 test, 알려진 제한을 commit message와 changelog 항목에 작성한다. credential, 운영 data, repository generator가 생성하지 않는 generated file은 포함하지 않는다.
