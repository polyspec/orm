<!-- doc-id: contributing -->
<!-- source-sha256: 7521f712b804e9bee7e9c15ffd734e6227d44e532f40423a41163265ad1deb41 -->
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

`make orm-test-container KIND=<mysql|postgres|mariadb>`와 `make orm-test-container-run KIND=<kind> RUN='<command>'`는 한 kind의 server를 program `bay`가 실행하는 Compose project로 시작한다(`scripts/test-servers-container.mts`). macOS에서는 Apple `container`, Linux에서는 Docker 위에서 실행된다. 모든 단계는 `bay`(`BAY_PROGRAM`)의 command이고 script는 container engine을 실행하지 않는다. script는 자신이 맞춰 쓰인 `bay`의 contract schema version을 요구하며, 그 값은 `bay version --json`이 보고한다.

**run의 project.** 각 start는 자기 checkout에 directory `.runtime/containers/<project>`를 만들고 그 안에 `compose.yaml`과 server의 file을 쓴다. `<project>`는 `orm-<checkout>-<run>`이다. `<checkout>`은 checkout root의 sha256의 앞 16진수 12자리이고, `<run>`은 그 start의 무작위 16진수 8자리다. `bay`의 각 command는 option `-p`로 project 이름을 받고, Compose file은 project를 이름하지 않는다. 그래서 두 checkout도, 한 checkout의 두 run도 project, container, file을 공유하지 않는다. directory는 system의 임시 directory가 아니라 checkout 아래에 있다. server를 제거하기 전에 kill된 run의 project를 `make orm-test-container-stop`이 찾기 위해서다.

**service.** project에는 server마다 service 하나가 있고 다른 service는 없다.

| Kind | Service |
|---|---|
| `mysql` | primary `mysql`; 그 read-only replica `mysql-replica` |
| `postgres` | primary `postgres`; 그 standby `postgres-replica` |
| `mariadb` | primary `mariadb` |

각 service는 `config/containers.json`이 digest로 고정한 image와 `expose`에 server의 port를 적고 key `ports`는 적지 않는다. 그래서 host의 port는 publish되지 않는다. server는 `make orm-test-servers`의 native primary의 설정을 받는다(time zone, 소문자 table 이름, binary log 보존, InnoDB log 공간, PostgreSQL은 WAL과 synchronous standby). 각 image의 data directory는 service의 `tmpfs`이므로 data는 container와 함께 끝나고 volume은 남지 않는다.

**주소.** check는 `bay`가 service에 주는 host 이름으로 server에 닿고, environment의 모든 DSN이 server를 그 이름으로 적는다. script는 host 이름의 형식도 접미사도 가지고 있지 않다. `bay up` 전에 `bay plan --json`에서 각 service의 host 이름을 읽는다. PostgreSQL standby가 command에 primary를 적기 때문이다. 그래서 Compose file은 plan을 위해 한 번, plan의 host 이름으로 한 번 쓴다. start 뒤에는 `bay up --json`의 출력에서 각 service의 host 이름과 IPv4 주소를 읽고, `bay up`이 plan과 다른 host 이름으로 보고하는 service는 start를 실패시킨다.

**준비 완료.** 각 service는 server의 준비 확인 program을 container 안에서 127.0.0.1의 TCP로 실행하는 Compose `healthcheck`를 선언한다. image가 data directory를 초기화하려고 시작하는 임시 server는 socket에서만 listen하기 때문이다. MySQL은 `mysqladmin ping`, PostgreSQL은 `pg_isready`, MariaDB는 image의 script `healthcheck.sh --connect --innodb_initialized`다. PostgreSQL standby는 primary에 대해 조건 `service_healthy`의 `depends_on`을 선언한다. `bay up`이 exit status 0으로 돌아오면 server는 준비된 것이다. script는 그 process 하나만 기다린다. container의 log를 읽지 않고, timer를 시작하지 않고, 요청을 반복하지 않는다. start의 한도는 Compose file의 `healthcheck`이며 `bay`가 그것을 거기에 요구한다. `start_period`는 600초로, image가 data directory를 초기화하는 시간이다. 부하가 있는 machine에서는 그 초기화에 몇 분이 걸리며, 그 시간 안의 실패한 probe는 세지 않는다. 그 뒤에는 1초 간격(`interval`)의 probe 10회(`retries`, `bay`는 1부터 100까지 받는다)가 각각 5초 제한(`timeout`)으로 start를 실패시킨다. container가 멈추면 start는 즉시 실패한다.

**시작된 server의 준비.** `bay up`이 돌아온 뒤 script는 server를 준비하는 각 단계를 `bay exec`로 그 container 안에서 끝까지, native server의 순서로 실행한다. 0이 아닌 status로 끝난 단계는 그 단계, status, 출력을 적어 start를 실패시킨다.

| 단계 | 실행되는 곳 | 그곳인 이유 |
|---|---|---|
| MySQL: primary의 `RESET BINARY LOGS AND GTIDS` | `bay exec`, 첫 번째 | binary log에는 image의 초기화가 들어 있고 replica의 image도 같은 초기화를 실행했다. reset은 그 초기화 뒤, replica가 log를 읽기 전에 와야 한다 |
| MySQL: replica가 source를 지정하고 replication을 시작하고 `super_read_only`와 `partial_revokes`를 설정한다 | `bay exec`, 두 번째 | `START REPLICA`는 primary에 연결하고, 두 설정은 실행 중인 server를 바꾼다. replica에는 `--skip-replica-start`가 있어 reset 전에는 아무것도 읽지 않는다 |
| MySQL과 MariaDB: database `orm_test`와 `orm_tools`, user `orm`의 account | `bay exec`, 마지막 | MySQL replica가 binary log에서 이를 적용하므로 replica가 따라온 뒤에 온다 |
| PostgreSQL: role `orm`의 replication을 허용하는 `pg_hba.conf` 규칙 | primary의 `/docker-entrypoint-initdb.d`의 file | `bay up`은 primary가 healthy가 되자마자 standby를 시작하므로, 규칙은 primary가 첫 연결을 받기 전에 있어야 한다 |
| PostgreSQL: standby는 slot `orm_replica`를 통한 primary의 `pg_basebackup`이다 | service `postgres-replica`의 command | standby의 server가 시작하기 전에 data directory를 채운다 |
| PostgreSQL: database `orm_test`와 `orm_tools` | `bay exec` | native primary처럼 standby가 따라온 뒤에 primary가 만든다 |

**run은 자기 server를 소유한다.** `make orm-test-container-run`은 command가 끝나거나 실패할 때, 그리고 run이 SIGINT나 SIGTERM을 받을 때 `bay down`으로 project를 제거하고 이어서 project의 directory를 제거한다. signal은 command에 전달한다. `bay up`이 실패한 start는 `bay logs`로 각 service의 마지막 줄을 출력하고, 같은 방법으로 project를 제거하고, project와 exit status를 적어 실패한다. `make orm-test-container-stop`은 checkout의 server의 exclusive lease를 잡고 checkout의 모든 project를 제거한다. kill된 run의 project도 포함한다. 다른 checkout의 project는 제거하지 않는다.

**image.** 어떤 start도 image를 download하지 않는다. script는 `bay up` 전에 `bay images --json`에서 project의 각 image가 machine에 있는지 읽고, image가 없는 start는 그 image와 `make orm-install-container-images`를 적어 실패한다. `bay up`은 `-no-pull`로 실행되며, 이 option은 image가 없으면 아무것도 만들기 전에 실패한다. `make orm-install-container-images`만 download한다. 세 image를 적은 Compose file에 `bay pull`을 실행하고, 그 file의 directory는 제거한다.

**변수.** `make orm-test-container`는 마지막 단계 뒤에 `.runtime/containers/<kind>.env`를 쓰고, `make orm-test-container-run`은 같은 변수를 command에 주고 file은 쓰지 않는다. MySQL과 PostgreSQL 변수는 `TEST_ENV`의 primary의 변수이고, MariaDB 변수는 `MARIADB_ENV`의 primary의 변수이며, MySQL과 PostgreSQL에는 replica DSN이 있다. 각 server는 `bay`가 service의 host 이름으로 발급해 container에 mount하는 certificate를 제시하므로 script는 server의 certificate를 발급하지 않는다. TLS DSN은 `bay`의 authority로 이를 검증하며 그 path는 `bay plan --json`이 준다. 두 번째 CA의 DSN은 chain에서 실패한다. 두 번째 CA는 script가 그 start를 위해 발급하며 아무것도 서명하지 않는다. mismatch DSN은 service의 IPv4 주소로 연결하는데 certificate는 그 주소를 적지 않는다. pooler는 시작하지 않는다. 그 변수는 없으며, 그 변수를 읽는 check는 변수 이름을 적어 실패한다.

**Unix socket을 통한 check.** `bay`는 Unix socket을 host에 publish하지 않고, container의 socket은 다른 container에서 닿지 않는다. Apple `container`의 container는 각자 kernel을 가지기 때문이다. 그래서 host의 environment에는 `ORM_TEST_MYSQL_SOCKET`과 `ORM_TEST_MARIADB_SOCKET`이 없고, server의 socket으로 연결하는 check는 그 server의 container 안에서 실행된다. BAY8이 구현하는 설계는 다음과 같다. server의 service가 check program의 Linux build가 든 run의 directory를 read-only로 mount한다. script는 image의 socket path와 project의 DSN을 주어 `bay exec -e <변수>=<값> <service> <program>`을 실행하고, `bay exec`의 exit status, 곧 program의 exit status가 check의 결과다. program은 socket 변수를 읽는 recipe runner다. MySQL과 MariaDB의 image는 서로 다른 library를 가지므로 각 program은 Linux용 static executable로 build한다. Linux machine에서는 checkout의 toolchain이 build한다. macOS에서는 project의 service `build`가 build한다. 이 service는 고정된 toolchain image를 끝나지 않는 command로 실행하고, checkout을 read-only로, build의 directory를 mount하며, script는 `bay exec build <build command>`로 build를 실행하고 그 exit status를 읽는다. 한 번 실행되는 service는 쓰지 않는다. `bay up`이 그 종료를 기다리지 않기 때문이다. BAY8이 끝날 때까지 socket 변수를 읽는 check는 변수 이름을 적어 실패한다.

**server가 도는 machine.** `bay`는 자신이 실행되는 machine에서만 project를 시작하고 제거한다. 따라서 server를 다른 machine에 두는 것은 run 전체가 그곳으로 옮겨 가는 것이다. Compose project와 check가 그 machine에서, 그 machine의 checkout으로 실행된다. Unix socket을 통한 check는 어느 machine에서든 server의 container 안에서 실행된다.

**kind당 start 하나.** `make orm-test-container`는 checkout에서 이미 시작했고 `make orm-test-container-stop`이 아직 제거하지 않은 kind를 거부한다. `.runtime/containers/<kind>.env`가 project 하나를 가리키기 때문이다. `make orm-test-container-run`의 run은 세지 않는다. 각 run은 자기 project를 가지고 공유 file을 쓰지 않는다.

**없는 program.** `BAY_PROGRAM`이 가리키는 program이 없거나 contract schema version이 다른 `bay`이면 start는 아무것도 만들기 전에 실패한다. message는 path, 그 program이 script를 위해 하는 일, 그것을 제공하는 것을 적는다.

`make orm-test-container-check`는 이 규칙을 각 test가 쓰는 대역 `bay`로 시험하므로 container도 image도 필요하지 않다.

## Interface 변경

공통 contract, generated artifact, language client, example, structure check를 함께 갱신한다. 특정 client에만 공개된 기능은 미완료로 처리한다.

## Commit message

동작을 나타내는 짧은 영문 명령형 제목을 사용한다. 예: `Implement root IN chunking`. 하나의 commit에는 하나의 변경 범위만 둔다.

## 변경

동작 변경, 영향받은 client와 database, 실행한 test, 알려진 제한을 commit message와 changelog 항목에 작성한다. credential, 운영 data, repository generator가 생성하지 않는 generated file은 포함하지 않는다.
