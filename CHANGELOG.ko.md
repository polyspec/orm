# 변경 이력

## 0.0.2

- G5.8: 모든 workflow job은 `.github/runner`에 선언한 `ubuntu-26.04-arm`에서 실행한다. CI는 MySQL 8.4.11을 Ubuntu 26.04 package에서, PostgreSQL 17을 PostgreSQL apt repository에서, sha256으로 확인한 arm64 ProxySQL 3.0.9 package를, `make php-min-check`의 PHP 8.4를 `scripts/php/php-min.sh`가 보고한 version으로 setup-php를 통해 설치한다. `make repo-check`는 job이 다른 runner에서 실행하면 실패한다.

- G5.7: CI workflow는 `make check`의 `feature-check`가 명령을 실행하는 `make interface-check`와 `make perf-check`를 더 이상 따로 실행하지 않는다. `make repo-check`는 workflow가 `contracts/features.json`의 검증 명령을 다시 실행하면 실패한다.

- G5.5: CI workflow는 target 43개 가운데 17개를 따로 된 step에서 실행하는 대신, 로컬 검사의 runner로 `CHECK_TARGETS`의 모든 target을 실행하는 `make check`를 실행한다. 이후 step은 실패 뒤에도 실행한다. `make repo-check`는 workflow가 `CHECK_TARGETS`의 target을 빠뜨리거나 두 번 실행하면 실패한다.

- G5.4: 검사와 모든 workflow는 `.php-version`에 선언한 PHP release 하나(8.5)와 `rust-toolchain.toml`에 선언한 Rust toolchain 하나(clippy와 rustfmt를 포함한 1.98.1)로 실행한다. Makefile은 그 toolchain을 읽고 CI는 `rustup toolchain install`로 설치한다. 새 `make php-min-check`는 `require.php`의 최저 release(8.4)에서 PHP client unit test를 실행한다. `make repo-check`는 workflow나 Makefile이 PHP나 Rust version을 직접 고르거나 실행 중인 version이 선언과 다르면 실패한다.

- G5.3: 검사와 모든 GitHub Actions workflow는 `.node-version`에 한 번 선언한 Node release 하나(26.8.1)로 실행한다. workflow는 `22.16.0`과 `24` 대신 `node-version-file`로 이를 읽는다. 22.16.0의 `node:sqlite`는 coverage checker가 거부하는 `ExperimentalWarning`을 출력했다. `make repo-check`는 workflow가 Node version을 직접 선언하거나 실행 중인 Node가 `.node-version`과 다르면 실패한다. TypeScript client는 계속 Node 22.16.0을 지원하며 `make ts-min-check`가 이를 실행한다.

- T39: 생성 모델은 더 이상 path를 쓴 방식에 의존하지 않는다. Rust `orm_build::Builder`는 manifest를 output directory의 canonical path로 include하므로 `out_dir`를 상대 path, 절대 path, `./`, 끝의 `/`로 써도 같은 source가 나온다. Go, PHP, Rust, TypeScript는 각각 fixture 하나에서 scan과 output path를 네 방식으로 써서 이를 확인한다.

- G5.2: CI workflow는 MySQL 8.4.11을 Ubuntu 24.04 deb bundle의 package 다섯 개로 apt를 통해 설치하고, apt가 `libaio1t64` 같은 의존성을 설치하므로 `make test-servers`는 symbolic link 없이 `/usr/sbin/mysqld`에서 `mysqld`를 찾는다. `make repo-check`는 workflow step이 symbolic link를 만들면 실패한다.

- G5.1: CI workflow는 로컬 검사처럼 `make test-servers`로 database 검사의 서버를 시작한다: MySQL과 PostgreSQL primary와 replica, ProxySQL, PgBouncer이며, `.runtime/servers/env`의 모든 DSN을 이후 단계의 환경에 둔다. `make repo-check`는 workflow가 `scripts/test-servers.sh`가 쓰는 변수를 빠뜨리거나, 직접 정의하거나, 환경 파일을 직접 쓰거나, 서버 시작 전에 make target을 실행하면 실패한다.

- T35.4: PHP는 생성 class 없이 schema 값으로 등록한 set의 audit 기록을 plan한다: 그런 set은 Go, Rust, TypeScript처럼 manifest text와 external text에서 runtime model을 얻는다.

- T36: `make owner-check`는 바뀐 file을 소유한 검사를 골라 실행한다: 선언한 fixture나 test에 바뀐 file이 있거나 fixture file이나 그것이 적는 JSON file이 그 file을 적는 모든 기능의 검증 명령과 coverage를 저마다 기한을 가진 단계로 실행한다(`scripts/features/owners.mjs`).

- T37: utility의 internal helper는 네 client에서 한 이름과 한 자리를 갖는다: `Utils`가 `active`, `run`, `read`를 갖고 schema, privilege, AES utility는 그것을 거쳐 부른다(PHP `UtilsSql`과 TypeScript `inTx`는 제거, Rust `reader`는 `read`). 동작은 바뀌지 않는다.

- T35.1: 문서 집합은 다른 집합의 table을 소유하지 않고 쓸 수 있다. Go와 PHP `orm-gen gen --use`, TypeScript `orm-gen gen --use`, Rust `Builder::uses`로 주는 외부 문서는 집합과 함께 검사하지만 렌더링, 설치, 변경, 비교, 생성하지 않는다. `manifestHash`는 쓰는 외부 table을 포함하고, install, addTablesAndColumns, 생성한 schema 값의 연결은 그 table이 database와 다르면 `CONFIG`로 실패하며, target이 외부 문서를 쓰는 plan은 잘못이다.

- T35.2: audit 값은 handle이 아니라 연결 설정의 audit source에서 온다: Go `Config.AuditSource(ctx)`, PHP `Config(auditSource:)`, TypeScript `connect({ auditSource })`, Rust `Config.audit_source`. audit 값을 가진 transaction은 이를 한 번 부르고, 호출 값이 source 값을 이기며, 기록 table은 `references`가 정하는 table이다. `audit(defaults)`와 그 handle은 제거했다.

- T35: 감사 대상 작업 단위는 선언한 audit 기록 table의 row 하나로 기록한다. `audit` setting은 `audit into <history> column <col> references <table> action <col> previous <col> [exclude (...) | include (...)]`이고, 감사 대상 table은 audit column에서 기록 table의 column 하나짜리 primary key로 가는 restrict foreign key를 선언하므로 database는 어떤 기록의 key도 아닌 값을 거부한다. 이력의 `previous`는 이전 audit key를 갖는다. audit 값을 가진 transaction(Go `orm.Audit(map)`, PHP `audit:`, TypeScript `{ audit }`, 세 builder의 Rust `.audit(pairs)`)은 callback 전에 연결의 audit source(T35.2)와 그 값으로 기록 하나를 삽입하고 모든 감사 대상 insert, update, soft delete, restore에 그 key를 쓴다. operation id, 그 transaction option, `setOperation`은 제거했다.

- T34: 배포한 TypeScript 선언은 driver module을 import하지 않는다. dbspec apply와 introspection의 connection type은 client가 호출하는 method만 적으므로, 그것을 쓰는 code는 pg, @types/pg, mysql2, node:sqlite type 없이 `skipLibCheck`를 끄고 type 검사를 통과한다. mysql2, pg, node:sqlite connection은 그대로 맞는다.

- T32: 네 client에서 `restore()`가 soft delete한 행을 되돌린다. primary key나 unique key 하나의 값과 다른 column의 새 값을 지정하면 `UPDATE` 하나가 새 값을 쓰고 soft delete column을 비우며(감사 대상 table에서는 operation id와 함께 쓰고 이력이 기록한다), key로 행을 다시 읽는다. 지워지지 않은 행은 그대로 반환되고, 없는 행은 `NO_ROWS`이며, 기본 읽기는 여전히 soft delete한 행을 뺀다. IR에 kind `restore`가 있고 `restore`는 예약 column 이름이다.

- T31: Rust `Db::transaction_once(callback)`는 `transaction`, `transaction_send`처럼 builder이므로, 감사 대상 write가 `.audit(values)`(T35)로 모든 transaction 진입점을 거쳐 실행된다. 기존 `.await` 호출부는 그대로이고, callback과 그 future가 `Send`이면 future도 `Send`다.

- T31.1: `go run ./tests/interfaces/check`는 cargo가 build했다고 보고한 위치에서 Rust symbol 도구를 찾는다. Makefile이 모든 cargo 명령에 주는 것처럼 `CARGO_TARGET_DIR`이 다른 target directory를 정해도 이 검사는 현재 도구를 실행한다.

- T30: `audit` setting은 기록할 column을 `exclude (col, ...)`나 `include (col, ...)` 목록 하나로 고를 수 있다. operation column은 언제나 기록한다. 이력 table은 identity key, action, previous column 말고는 기록하는 column만 갖고, trigger는 MySQL, PostgreSQL, SQLite에서 그 column만 복사하며, schema text는 setting을 기록하지 않는 column의 `exclude` 목록으로 쓰고, introspection은 trigger에서 그것을 되살린다. 없거나 두 번 적은 목록 column, 두 목록, 목록에 적은 operation column은 `setting` error이고, PHP와 Rust의 이력 table 검사는 Go와 TypeScript처럼 어긋난 곳마다 error 하나를 낸다. 암호화가 필요한 값은 쓰기 전에 codec이 암호화하므로 trigger는 그 ciphertext를 복사한다.

- T8.8.5: 네 client에서 `utils().schema().addColumns`는 이제 `addTablesAndColumns`(Go `AddTablesAndColumns`, Rust `add_tables_and_columns`)다. 설치한 document set을 더해서만 올리는 이 호출은 database에 없는 set의 table도 같은 plan step으로 index, foreign key, check, audit과 immutable trigger와 함께 모두 만들고, 만든 table은 `table`, 더한 column은 `table.column`으로 돌려준다. 다른 모든 차이는 여전히 어떤 statement보다 먼저 `SCHEMA_DIFFERS`다. step 함수는 `AddTablesAndColumnsSteps`, `Dbspec::addTablesAndColumnsSteps`, `addTablesAndColumnsSteps`, `add_tables_and_columns_steps`로 바뀌었고, fixture는 contracts/fixtures/add_tables_and_columns로 옮겼다.

- T8.8.4: N18, N19, N19.1과 함께 main을 dbspec branch에 다시 merge했다. 네 client에서 MySQL DSN은 `ssl-mode=VERIFY_IDENTITY`와 절대 경로 `ssl-ca`로 TLS 연결하고, PHP와 TypeScript client는 scheme마다 정한 집합 밖의 DSN parameter를 거부한다. `utils().schema().addColumns(schema)`(Go `AddColumns`, Rust `add_columns`)는 generated schema 값을 받아 database를 introspect하고 document set의 기존 table만 비교하며, 모든 차이가 null이거나 default가 있는 빠진 column이면 그 table들에서 set까지의 plan step(각 client dbspec module의 `AddColumnSteps`)을 실행한다. 이 step은 바뀐 table의 audit trigger도 바꾼다. 다른 차이는 어떤 statement보다 먼저 새 code `SCHEMA_DIFFERS`를 반환한다. MySQL과 SQLite는 transaction 밖에서, SQLite는 foreign key를 끈 `BEGIN IMMEDIATE` transaction 하나에서 column을 더한다.

- T28: version은 0.0.2다. 새 VERSION 파일이 이를 적고, `make version-check`(`make check`의 일부)는 orm crate의 Rust manifest나 lockfile 항목, PHP composer 파일, TypeScript package나 lockfile, contracts/features.json, 문서의 version이 이와 다르면 실패한다.

- T27: 모든 check가 몇 분 안에 끝나고 `make check`가 step마다 보고한다. 전체 실행 한 번이 step 43개를 15분에 통과한다(이전 약 100분).

- T29.1: dbspec apply, recover, rollback, finalize는 MySQL과 PostgreSQL에서 connection이 다른 client와 나누지 않는 server session 하나를 지키는지 확인하고, lock을 잡는 session이 이미 lock을 잡고 있거나 뒤의 statement가 다른 session에서 실행되면(transaction pooler처럼) 다음 statement 전에 `session` error로 멈춘다. 요구는 직접 연결이나 session pooling 연결이다.

- T29: server session을 끊거나 보는 Rust `tx` test는 server DSN으로 연결하므로 `make client-pooler-check`가 통과한다.

- T27.5: 모든 cargo test 명령이 test build 하나를 함께 쓰고, client-db-check는 네 client를 병렬 줄로, feature-check는 검증 명령을 네 줄로 실행한다(`exclusive`인 명령은 먼저 혼자 실행한다). TypeScript replica case는 database 없는 연결로 기다리고 한 연결이 실패하면 열린 연결을 닫는다. client-db-check는 449 s 대신 86 s, feature-check는 570 s 대신 251 s 걸린다.

- T27.6: 기한에 GRACE를 더한 시간까지 끝나지 않은 JavaScript case는 FAIL 줄과 함께 process를 끝내고, pcntl이 없는 PHP case는 같은 일을 하는 watchdog process를 가진다.

- T27.4: `make bench`는 2000 table stress case와 시간 budget case(네 stress parse budget, 2000 table plan 적용, release Rust runner로 하는 2000 table introspection 비교, 2000 table runner 비교, `make timing-check`)를 그 assertion 그대로 실행한다. `make check`는 runner 비교와 introspection 비교를 같은 모양의 20 table 문서(`node tests/dbspec/stress.mjs 20`)로 실행하고, dbspec, integration, conformance, example runner는 debug build다.

- T27.3: `make check`는 scripts/check/run.mjs로 target마다 남은 disk와 함께 보고하는 묶음으로 실행하고, 실패한 뒤에도 계속해 모든 결과를 출력한다. 실행마다 자기 bench database와 decimal database를 만들어 seed하고 끝에 지운다(`make decimal-db-setup`은 `DECIMAL_ENV`와 `DECIMAL_DATABASE`를 받는다). 모든 cargo 명령은 toolchain 하나와 target directory 하나를 incremental 결과 없이, 줄 번호 debug 정보로 쓰고, build 한도는 8분이다. Rust `tx` probe table은 case database에 있고, case-database-check는 끝난 process가 남긴 것만 남은 것으로 본다. target 합계는 약 100분 대신 약 36분이다.

- T27.2: `go run ./tests/conformance/check run`은 `-driver`/`-dsn` 쌍 여러 개를 받아 Rust, TypeScript, Go runner를 한 번 build하고, build된 runner를 각각 1분 한도로 실행한다. `make conformance-check`는 세 database를 한 실행에서 확인하고, 실행 lock은 bench database마다 잡는다.

- T27.1: `make feature-check`는 case 앞에서 state reader, package마다 Go test binary 하나, Rust crate마다 test binary를 한 번 build하고, 모든 coverage 실행은 그 binary를 process마다 10분 대신 2분 한도로 실행한다(Rust entry는 선언된 file을 compile한 test binary마다 process 하나에서 모든 symbol을 실행한다). 세 database는 함께 진행하고, state digest는 JSON 대신 type을 붙인 값을 hash하며, 같은 검증 명령은 한 번 실행하고, 검증 명령은 target이 한 번 build한 TypeScript client를 쓴다. check는 다시 통과하고(T25 case database helper는 `schema_install`에 속한다), 빈 Rust target에서 34분 대신 17분 걸린다.

- T26: 모든 client의 rollback 실패 case는 ProxySQL이 자기 명령으로 받는 `KILL` 대신, make target이 export하고 pooler check가 그대로 두는 server DSN `ORM_TEST_MYSQL_SERVER_DSN`과 `ORM_TEST_POSTGRES_SERVER_DSN`으로 transaction의 server session을 종료한다. Rust session 연결은 `extra_float_digits`를 보내지 않는 client 연결이다. 그래서 이 case들은 ProxySQL과 PgBouncer를 거쳐도 통과한다.

- T25: 빈 database를 확인하거나 schema를 설치하는 모든 client database case는 자기 database `orm_case_<pid>_<n>`(MySQL과 PostgreSQL)이나 SQLite file을 만들고 끝날 때 실패한 뒤에도 지우므로, 공유 test database에 남은 table이 더는 그 case를 실패시키지 않는다. `make case-database-check`는 두 공유 database에 table 하나를 남겨 둔 채 네 client의 model case가 통과하고 공유 database를 그대로 두는지 확인한다.

- T25.4: Rust database test와 `integration` program은 schema를 설치하거나 빈 database를 확인하는 모든 case에서 공유 test database의 table을 지우고 설치하는 대신 자기 database `orm_case_<pid>_<n>`이나 SQLite file(workspace crate `orm-case-database`)을 만들고, case가 끝날 때 panic한 뒤에도 지운다.

- T25.3: schema를 설치하거나 빈 database를 확인하는 TypeScript database test는 공유 test database의 table을 지우고 설치하는 대신 자기 database `orm_case_<pid>_<n>`이나 SQLite file(clients/typescript/tests/case-database.mjs)을 만들고, case가 끝날 때 실패한 뒤에도 지운다. 그래서 그곳에 남은 table이 더는 `schemaEmpty`, `conditions`, `joinsAndRelations`를 실패시키지 않는다.

- T25.2: schema를 설치하거나 빈 database를 확인하는 PHP database test는 공유 test database의 table을 지우고 설치하는 대신 자기 database `orm_case_<pid>_<n>`이나 SQLite file(clients/php/tests/case_database.php)을 만들고, case가 끝날 때 실패한 뒤에도 지운다.

- T25.1: schema를 설치하거나 빈 database를 확인하는 Go database test는 공유 test database의 table을 지우고 설치하는 대신 자기 database `orm_case_<pid>_<n>`이나 SQLite file(internal/testdb)을 만들고, test가 끝날 때 실패한 뒤에도 지운다.

- T24.6: JavaScript, PHP, Rust case 보고는 다음 단위로 반올림되는 시간을 Go처럼 그 단위로 쓴다(`1000ms`가 아니라 `1s`).

- T24.5: check의 build, format, lint, package 명령은 tests/run-case.mjs로 case가 되어 기한과 함께 `RUN`, 경과 시간을 담은 `STEP` 줄로 출력 줄, 종료 상태와 함께 `PASS`나 `FAIL`을 출력하고, 기한을 넘긴 명령은 멈춘다. codec 교차 검사와 feature manifest 검사도 자기 case를 보고한다.

- T24: 모든 check는 실행 중에 case마다 시작과 기한, 단계, 결과와 경과 시간을 Go, JavaScript, PHP, Rust에서 한 형식으로 보고하고, 어느 check도 case별 기한 대신 실행 전체를 묶지 않는다.

- T24.4: 모든 Rust test case는 실행 중에 `--nocapture` 없이 stderr에 `RUN <case> deadline=<d>`, `STEP` 줄, 경과 시간과 함께 `PASS`나 panic message 또는 이유를 담은 `FAIL`을 출력하고(clients/rust/testcase), 기한을 넘긴 case는 FAIL 줄과 함께 test binary를 끝낸다. `integration` program과 `dbspec_stress` example도 같은 방식으로 case를 보고한다.

- T24.3: 모든 PHP test case는 `RUN <case> deadline=<d>`, `STEP` 줄, 경과 시간과 함께 `PASS`나 이유를 담은 `FAIL`을 출력하고(tests/testcase.php), script 전체의 한도 대신 자기 기한 아래에서 실행되며(pcntl이 있으면 SIGALRM이 멈춘 case를 끊는다), script가 loop로 실행하는 case는 앞의 실패가 뒤의 case를 가리지 않는다. `make conformance-result-check`는 Python runner 없이 네 명령을 직접 실행한다.

- T24.2: 모든 JavaScript test case와 Node check runner는 실행 중에 `RUN <case> deadline=<d>`, `STEP` 줄, 경과 시간과 함께 `PASS`나 이유를 담은 `FAIL`을 출력하고(tests/testcase.mjs), case마다 자기 기한을 가진다. `make feature-check`는 coverage 실행과 검증 명령을 실행하는 동안 하나씩 보고하고, `node scripts/features/check.mjs --run --feature <id>`는 한 기능의 명령만 실행한다. T19와 T20 기록은 message placeholder를 code로 써서 문서가 다시 build된다.

- T24.1: 모든 Go test case는 시작할 때 `RUN <case> deadline=<d>`, 긴 case가 도는 동안 경과 시간을 담은 `STEP` 줄, 끝날 때 경과 시간과 함께 `PASS`, 이유를 담은 `FAIL`, 또는 `SKIP`을 출력한다(internal/testcase). case마다 자기 기한이 있고, 기한을 넘긴 case는 모든 goroutine stack과 함께 실패한다. Makefile의 Go check, client와 performance script, feature 명령은 binary 전체의 한도 대신 `go test -v -timeout 0`으로 실행하며, conformance check와 interface check도 build, 언어, 비교 case를 같은 방식으로 보고한다.

- N3.2: 모든 클라이언트에서 연결은 자기에게 등록된 schema set만 계획한다. generated code의 connect helper(Go `model.Connect`, PHP `Polyspec\Orm\Tests\Model\connect`, Rust `model::connect`, TypeScript `connect`)는 연결을 열고 `connectSchema`로 그 set을 등록하며, `install(schema)`는 generated schema 값을 받아 자기가 설치한 set을 등록한다. raw 연결은 아무것도 등록하지 않는다. 연결에 등록되지 않은 set의 요청은 cache된 plan이 있어도 실행 전에 `SCHEMA_HASH_MISMATCH`로 실패하고, 선언한 hash로 hash되지 않는 manifest text는 connect나 install에서 `CONFIG`로 실패한다. Go는 plan cache보다 먼저 schema를 확인하므로 편집한 generated code가 더는 cache된 plan으로 실행되지 않는다.

- N3.3.1: 이 branch는 `utils().schema().register(manifestJson)`를 제공하지 않는다. set은 generated code의 connect helper나 `install()`로 연결에 들어가며, 기록이 그렇게 적는다.

- T18: relation request는 key의 모든 성분을 담는다. 성분마다 `{left, right}` 한 쌍을 key 순서대로 담고(`left`와 `right` 대신 `keys`), `match<L>With<R>()`는 호출마다 쌍 하나를 더하므로 Go, PHP, Rust, TypeScript에서 `composite_account`의 `composite_membership`을 `tenant_id`와 `account_id`로 함께 읽는다. 자기 연결을 가진 자식으로 읽어도 같다. 빈 key 목록, column이 없는 쌍, 한쪽에 두 번 나오는 column은 `IR_INVALID`다. Rust `Core::add_match`가 `set_match`를 대신한다.

- T8.9.1: 각 client가 호출자가 읽은 bytes에서 message에 쓸 이름과 함께 dbspec signature를 확인한다: Go `dbspec.ReadBytes`, PHP `Dbspec::readBytes`, TypeScript `readDbspecBytes`, Rust `dbspec::read_bytes`이며 path reader가 이것을 쓴다. signature 뒤의 UTF-8이 아닌 bytes는 모든 client에서 첫 잘못된 byte의 `encoding` error 하나(`<name> is not valid UTF-8`)다. TypeScript는 더 이상 U+FFFD로 바꾸지 않고 Rust는 더 이상 I/O error를 돌려주지 않는다.

- T21.2: Rust catalog는 dbspec text 형식의 `Date`, `Time`, `DateTime` bind로 temporal row identity를 포함한 `date`, `time`, `datetime` column에 쓰고, MySQL, PostgreSQL, SQLite에서 `ROW_WRITE_MISMATCH`로 실패하지 않고 쓴 cell을 다시 읽는다.

- T21.1: SQLite에서 기술된 `DATE`, `TIME`, `DATETIME` column은 MySQL, PostgreSQL과 같은 `Date`, `Time`, `DateTime` grid cell로 읽히고, dbspec 형식 밖의 값은 `GRID_TEMPORAL_VALUE`로 실패하며, read-only grid query는 저장된 text를 유지한다.

- T22: root package.json에 script file이 제거된 `schema:check` script가 더 이상 없고, root npm script가 tracked file이나 directory가 아닌 path를 쓰면 `make repo-check`가 실패한다.

- T21: Rust catalog grid는 MySQL `DATE`, `TIME`, `DATETIME`과 PostgreSQL `date`, `time`, `timestamp` cell을 dbspec text 형식의 `Date`, `Time`, `DateTime`으로 decode한다. table page는 선언된 소수 자릿수를, read-only grid query는 여섯 자리를 쓰므로 datetime column이 있는 table의 page를 모든 database에서 읽는다.

- T20: Rust `client_bench`와 bench/rust의 `native`, `driver_compare`는 iterations 인자를 요구한다. 인자가 없거나 program의 최소값 이상의 정수가 아니면 3000번이나 1000번을 반복하는 대신 인자 이름과 값을 담은 error와 함께 status 1로 끝난다.

- T19: 생성된 Go relation getter는 `(<result>, error)`를, Rust relation getter는 `orm::Result<Option<..>>`를 돌려준다. related row가 없는 row는 결과 없음으로 읽히고, 다른 type으로 저장된 relation 값은 버려지는 type assertion이나 `None` 대신 `INTERNAL`이다.

- T8.8.3: N17과 함께 main을 dbspec branch에 다시 merge했다. PHP client는 PDO driver 확장을 요구하지 않고, `make php-without-mysql-check`는 `pdo_mysql`이 없는 공식 PHP image의 SQLite에서 `schema/bench.dbs`를 설치하고 row를 만들고 읽는다.

- T8.9: dbspec 문서 파일의 확장자가 `.dbspec` 대신 `.dbs`이고, header `dbspec 1 <document>`가 파일 signature다. 모든 tool은 자기 client의 reader 하나(Go `dbspec.ReadFile`, PHP `Dbspec::readFile`, TypeScript `readDbspecFile`, Rust `dbspec::read_file`)로 문서 파일을 읽으며, reader는 DbSchema project 파일이나 빈 파일처럼 `dbspec ` bytes로 시작하지 않는 파일을 parse 전에 `signature` error `<path> is not a dbspec document` 하나로 거부한다.

- T17.7: hot-path check의 Go 네이티브 기준 코드가 생성 클라이언트와 같은 statement를 실행하고, relation과 list workload는 key만 bind하며, Rust 네이티브 insert는 AES column에 AES ciphertext를 쓴다.

- T15: contracts/features.json의 모든 feature가 coverage를 선언하고 `make feature-check`가 각 client의 owner case를 MySQL, PostgreSQL, SQLite에서 두 번씩, 또는 database 없이 실행한다. 모든 client에서 SQLite RESTRICT foreign key 위반은 FOREIGN_KEY이고 CHECK 위반은 CONSTRAINT다.

- T8.8.2: N16과 함께 main을 dbspec branch에 다시 merge했다. 각 client의 test entry point가 rollback fault를 설정하고, 그다음 실패한 rollback은 MySQL, PostgreSQL, SQLite에서 하나뿐인 transaction 종료 형태 `transaction failed (<cause>) and rollback failed (<error>)` 안의 `FAULT`로 보고된다. idle machine에서 client 하나와 database 하나씩 잰 2000 table introspection은 모든 client에서 0.73-2.56 s로 5 s budget 안이다.

- T8.6.8: 모든 client가 MySQL, PostgreSQL, SQLite에서 plan을 step 하나씩 적용한다: statement마다 따로 commit하고 history step을 기록하며, recover는 다음 step의 catalog 효과로 중단된 plan을 이어 가고, rollback은 모든 step의 rollback statement로 마지막 plan을 되돌린다. 지우는 table과 column은 finalize가 지울 때까지 `dbspec$hold$` 이름을 받아 숨고, 더한 column은 rollback에서 숨었다가 다시 적용하면 돌아오며, 적용한 plan의 rollback은 non-null로 되돌릴 column의 NULL row를 채우거나 거부하고, lock 대기는 5초에 끝나며, `PlanSteps`가 각 step의 rollback statement, 효과, finalize 표시와 함께 `PlanStatements`를 대신한다.

- T8.8.1: main을 dbspec branch에 merge했고, Mermaid source path는 제거된 채로 main의 기능이 dbspec path에서 동작한다. 한 process가 여러 document set의 generated code를 읽고 연결은 모든 요청을 그 manifest hash의 model로 계획한다. 읽힌 code가 등록하지 않은 manifest의 요청과 text의 hash가 선언한 hash와 다른 code는 `SCHEMA_HASH_MISMATCH`로 실패하며, generated code가 자기 set을 등록하므로 `utils().schema().register()`는 없다. rollback도 실패한 transaction이나 savepoint는 server가 닫은 connection에서도 모든 client에서 `ROLLBACK` 오류 `transaction failed (<cause>) and rollback failed (<error>)` 하나를 보고하고, 두 오류를 유지하며, 재시도하지 않는다. `docs/protocol.md`가 clock 규칙을 한 번 쓴다: client clock은 마이크로초의 UTC이고, MySQL은 `CURRENT_TIMESTAMP(p)`와 `NOW(6)`을 쓰며, SQLite 상대 형식은 소수 여섯 자리를 유지하고, SQLite는 생략한 `default now` column에 client clock을 bind하며, 모든 `now` slot은 그 column의 소수 자리를 가진다. plan history는 `applied_at`을 `YYYY-MM-DDTHH:MM:SS.ffffffZ`로 쓰고, TypeScript apply clock은 epoch 이후 마이크로초다.

- T10: 네 client가 package의 Cargo manifest를 하나만 둔 ordered-json을 쓰므로, cargo가 중복 `ordered-json` package를 경고하지 않는다.

- T17.6: test가 자기 계산에 두는 모든 시간 한도가 CPU 시간(Rust, Go, TypeScript의 case thread, PHP process)을 제한하고 CPU와 wall-clock 시간을 출력한다. `make timing-check`는 stress, Rust vector, PHP dbspec test를 그 process group이 wall-clock 시간의 10분의 1만 받는 상태로 실행한다.

- T17.5: Rust native benchmark `native`와 `driver_compare`가 bench schema 형을 decode해 모든 workload의 row를 읽고, `make rust-driver-check`가 시드된 bench database에서 이들을 실행한다.

- T17.4: examples/complex의 Go, PHP, Rust 프로그램이 같은 compact JSON byte를 출력하고, `make example-check`가 시드된 bench database에서 examples/complex와 examples/thin-slice의 출력을 byte 단위로 비교한다.

- T8.0.14.4: context가 취소된 Go transaction은 connection을 pool에 돌려주지 않고 닫으므로 named lock, user variable, SQLite mode가 남지 않으며 `CANCELED`만 보고한다.

- T8.0.14.3: 모든 client는 실패하거나 panic한 중첩 transaction 뒤에 `ROLLBACK TO SAVEPOINT`와 `RELEASE SAVEPOINT`를 실행하고 둘 중 하나의 실패를 원인과 함께 보고하며, transaction이 취소되었거나 connection을 잃은 Go savepoint는 원인만 돌려준다.

- T8.0.14.2: 트랜잭션이 끝나기 전에 drop된 Rust 트랜잭션 future는 connection을 바로 닫으므로, TLS에서도 server에서 session과 함께 트랜잭션과 named lock이 끝난다.

- T8.2.6.4.1: Rust lock file이 지운 `orm-schema`의 `libc` 의존성을 더 이상 나열하지 않아 `cargo check --locked`가 통과한다.

- T8.2, T8.2.6, T8.3, T8.5: 끝난 하위 항목과 함께 닫는다. T7.17.2.10.3과 T7.17.2.10.3.1은 dbspec으로 대체되어 닫는다.

- T8.2.6.4: dbspec 문서 집합이 유일한 schema source다. Mermaid schema source, 그 manifest와 `orm-schema-v1` SQL, 그것을 읽던 모든 schema CLI 명령과 PhysicalGraph record를 모든 client에서 제거했고, CLI는 Go, PHP, TypeScript에서 `orm-gen`이다.

- T8.2.6.3: 모든 generator, runtime, schema tool, schema 설치가 dbspec 문서 집합을 읽는다.

- T8.0.9.2: 모든 client는 SQLite DSN의 percent-decode한 path를 열고, 잘못된 escape, NUL byte, UTF-8이 아닌 path를 `CONFIG`로 거부하며, tests/dsn/sqlite-paths.json의 공유 case가 이를 확인한다.

- T8.5.1.1: 모든 client에서 SQLite table rebuild는 identity table의 `sqlite_sequence` counter를 옮겨, rebuild 전에 지운 key를 다시 주지 않는다.

- T8.6.7: apply lock은 MySQL database 하나나 PostgreSQL schema 하나만 덮어 다른 database나 schema의 apply가 동시에 실행되고, 예상 밖의 lock 결과는 `locked`가 아닌 error이며, 모든 client에서 빈 plan chain은 table 없는 database의 올바른 chain이다.

- T8.7.6.2: Go engine test가 빠지거나 type이 틀린 dbspec vector field를 file, 위치와 함께 거부하고, dbspec compare harness와 Makefile block의 주석이 한국어다.

- T8.5.7: 모든 client가 plan 없이 두 schema text의 모든 차이를, plan이 거부하는 type, identity, primary key, column 순서 변경까지 `[kind, table, name]`으로 나열한다.

- T17.1: graph test 15초 제한은 Rust(case의 thread), Go와 PHP(test process)에서 wall-clock 대신 CPU 시간을 제한하므로 부하가 걸린 공유 machine에서 더 실패하지 않고, 모든 case가 두 시간을 보고한다.

- T17.3: Rust native benchmark는 고정 socket과 database 대신 `ORM_BENCH_MYSQL_DSN`에서 database를 읽고, 없거나 비어 있으면 연결하지 않고 status 1로 끝나며, `make rust-driver-check`가 그 test를 실행한다.

- T17.2: Go, PHP, Rust 예제 program은 `ORM_BENCH_MYSQL_DSN`을 요구하고, 없거나 비어 있으면 연결하지 않고 status 1로 끝나며, PHP 예제는 없어진 `schemaPath`를 더 넘기지 않는다.

- T8.0.14.1: 모든 client가 transaction 끝의 모든 실패를 보고한다. 모든 정리 단계를 실행하고, 아무것도 풀지 않은 `RELEASE_LOCK`은 오류이며, callback, begin, commit 실패 뒤의 실패한 rollback은 원인과 함께 보고하고, panic한 Go나 Rust callback은 panic을 이어 가기 전에 rollback하며, Go client는 driver가 닫은 connection의 rollback을 완료로 본다.

- T8.7.6.1: 실패한 Go Mermaid나 plan vector case는 지켜지는 deadline 아래에서 실패만 기록하고, 모든 dbspec runner는 없는 input이나 directory input을 `<path>: <reason>`과 0이 아닌 exit로 거부한다.

- T8.5.6.1: dbspec compare runner는 빠지거나 type이 틀린 vector section, id, document, 줄을 빈 값으로 읽지 않고 `<file>: <location> <problem>`과 0이 아닌 exit로 거부한다.

- T8.2.6.1.1.1: 같은 link를 고친 T8.2.6.1.3으로 닫는다.

- T8.6: 모든 client가 lock, history, 검증, event와 함께 plan chain을 적용하고 recover하며, 어느 client든 다른 client가 적용한 chain을 이어 간다.

- T8.7.5.1: `make dbspec-rust-check`가 모든 Rust dbspec test를 두 번 실행한다.

- T8.6.6: `make dbspec-apply-pairs-check`는 Go, PHP, TypeScript, Rust client의 모든 순서쌍에 대해 MySQL, PostgreSQL, SQLite에서 한 client로 chain의 첫 plan을, 다른 client로 나머지를 적용하고, MySQL에서 한 client가 멈춘 plan을 다른 client가 끝낸다.

- T8.6.2.2: Go, TypeScript, Rust는 PHP처럼 apply의 정리 error를 확인한다. TypeScript와 Rust는 아무것도 풀지 않은 PostgreSQL unlock을 거부하고, Go는 정리 error가 없는 실패를 그대로 돌려주며, docs/plans.md는 각 client가 정리 error가 있는 실패를 보고하는 형식을 적는다.

- T8.7: 모든 client가 표준 Mermaid erDiagram을 export하고 import하며 각각 빼는 것을 나열하고, 네 client가 byte 단위로 일치한다.

- T8.7.6: `make dbspec-compare-check`가 Go, PHP, TypeScript, Rust client의 Mermaid export, import, round trip 결과를 비교한다.

- T8.7.2.1: 모든 client의 Mermaid import는 column 수가 다른 label을 보고하고, key보다 먼저 dbspec type 범위를 판정하고, comment 부분 사이에 공백 하나를 요구하고, 함께 쓰는 foreign key index를 한 번 더한다. export는 빼는 모든 comment를 보고한다.

- T8.6.3.1: 실패한 PHP apply는 정리 error를 실패와 함께 `Orm\Dbspec\ApplyCleanupError`로 보고하고, 아무것도 풀지 않은 advisory unlock은 error이며, row 없는 MySQL 효과 query와 닫을 수 없는 result는 error다.

- T8.0.9: `datetime(p)`는 세 데이터베이스에서 local date-time으로 생성되고, 모든 client 연결이 이를 UTC로 읽고 쓰며, introspection은 time zone 컬럼을 미지원으로 보고한다.

- T8.0.9.1: Go, TypeScript, Rust connection은 PHP처럼 datetime 값을 UTC로 읽고 쓰며, `timezone`은 `UTC`나 `+00:00`만 받는다.

- T8.0.14: transaction 끝에서 실패한 MySQL `setLocal` reset은 모든 client에서 보고되고, callback 실패와 정리 실패가 겹치면 두 오류를 `CONFIG`로 함께 보고한다.

- T8.0.13: 모든 client와 schema tool은 query가 붙은 SQLite DSN이 path로 정한 file만 만드는지 검사한다.

- T8.0.11: Introspection case는 모든 client에서 PostgreSQL time zone, padding, 단정밀도, JSON type과 MySQL `TIMESTAMP`, `char`, `float`, 그리고 `NO ACTION`과 `SET DEFAULT` key가 미지원으로 보고되는지 검사한다.

- T8.0.10: Introspection case는 모든 client에서 SQLite primary key column이 선언한 nullability를 유지하는지 검사한다.

- T8.0.8: 공유 DDL step은 렌더링한 binary collation이 MySQL, PostgreSQL, SQLite의 unique key에서 `a`, `A`, `á`, `a `를 서로 다르게 두는지 검사한다.

- T8.0.7: 모든 client는 세 dialect에서 insert가 identity column을, update와 duplicate update가 primary key나 identity column을 쓰지 못하는지 검사한다.

- T8.0.6: 렌더링한 `immutable`과 `audit` guard는 row trigger이며, 공유 DDL step은 어떤 행과도 맞지 않는 `UPDATE`나 `DELETE`가 MySQL, PostgreSQL, SQLite에서 성공하는지 검사한다.

- T8.0.5: 공유 case는 모든 client가 `cascade` 또는 `set_null` foreign key의 child에서 `immutable`과 `audit`을 거부하는지 검사한다.

- T8.0.4: 63 byte를 넘는 선언 이름과 생성 이름은 모든 client에서 렌더링 전에 거부되며, 정확히 64 byte인 이름을 써서 검사한다.

- T8.0.3: Introspection case는 stored와 virtual generated column이 모든 client에서 MySQL, PostgreSQL, SQLite 모두 미지원으로 보고되는지 검사한다.

- T8.0.2: Introspection은 모든 client에서 prefix, partial, expression index를 table과 이름과 함께 미지원으로 보고한다.

- T8.0.1: PostgreSQL introspection은 참조 table이 다른 schema에 있는 foreign key를 같은 이름의 table을 가리키는 key로 읽지 않고 미지원으로 보고한다.

- T8.6.2.1: 실패한 Go apply는 정리 error를 실패와 함께 보고하고, row 없는 MySQL 효과 query는 error다.

- T8.7.4: TypeScript client가 dbspec 문서를 표준 Mermaid erDiagram으로 export하고, 각각이 빼는 것의 목록과 함께 import한다.

- T8.6.4: TypeScript client가 lock, history, drift 검사, transaction, 검증, event, MySQL recovery와 함께 plan chain을 적용하며, introspection은 `dbspec$plans`를 뺀다.

- T8.7.5: Rust client는 dbspec 문서를 표준 Mermaid erDiagram으로 export하고 import하며, 각각 빼는 것을 나열한다.

- T8.6.5: Rust client는 `orm::dbspec::apply`로 lock, history, drift 확인, transaction, 검증, event와 함께 plan chain을 적용하고, `orm::dbspec::recover`로 중단된 MySQL plan을 끝낸다. Rust introspection은 `dbspec$plans`를 뺀다.

- T8.5.6: `make dbspec-compare-check`가 Go, PHP, TypeScript, Rust client의 plan을 비교하고, PHP, TypeScript, Rust가 63 byte를 넘는 plan 이름을 거절하며 공유 plan parse case를 실행한다.

- T8.7.3: PHP client는 `Orm\Dbspec\Dbspec::exportMermaid`로 dbspec 문서를 표준 Mermaid erDiagram으로 export하고 `Dbspec::importMermaid`로 import하며, 각각이 빼는 것을 알린다.

- T8.6.3: PHP client는 `Orm\Dbspec\Dbspec::apply`로 lock, history, drift 검사, transaction, 검증, event와 함께 plan chain을 적용하고, `Dbspec::recover`로 중단된 MySQL plan을 복구한다. introspection은 `dbspec$plans`를 뺀다.

- T8.2.2.1: Go가 다른 client처럼 primary key 줄 없는 table에도 identity 규칙을 보고한다.

- T8.2.1.1: Rust client가 Go, PHP, TypeScript처럼 parse한 dbspec model을 `orm_schema::dbspec::model`로 공개한다.

- T8.5.3: PHP client는 `Orm\Dbspec\Dbspec`으로 schema plan을 parse, chain, diff하고 쓴다. `make dbspec-plan-php-check`가 이를 MySQL, PostgreSQL, SQLite에 적용한다.

- T8.2.6.1.3: Korean protocol 문서가 manifest 절을 ASCII anchor로 가리킨다.

- T8.7.2: Go engine은 dbspec 문서를 표준 Mermaid erDiagram으로 export하고 import하며, 각각 빼는 것을 나열한다.

- T8.7.1: docs/mermaid.md가 표준 Mermaid export와 import, 그리고 각각 빼는 것의 목록을 정한다.

- T17: Rust client benchmark `client_bench`는 `ORM_BENCH_MYSQL_DSN`이 없거나 비어 있으면 내장 local socket에 연결하지 않고 그 변수 이름을 출력하며 실패한다.

- T12: `make ts-model-check`는 TypeScript models script가 model을 호출하지 않는 source를 scan하거나 호출하는 source를 빠뜨릴 때, 또는 commit된 models.ts가 그 출력과 다를 때 실패한다. script는 model을 호출하는 8개 source만 scan한다.

- T8.5.2.2: 63 bytes를 넘는 plan 이름을 거부하고, 공유 case가 plan parse error를 덮는다.

- T8.5.5: Rust client는 schema plan을 parse, chain, diff하고 MySQL, PostgreSQL, SQLite용으로 쓴다. `make dbspec-plan-rust-check`가 이를 적용한다.

- T8.5.4: TypeScript client는 schema plan을 parse, chain, diff하고 MySQL, PostgreSQL, SQLite용으로 쓴다. `make dbspec-plan-ts-check`가 이를 적용한다.

- T8.6.2: Go engine은 lock, history, drift 검사, transaction, 검증, event, MySQL recovery와 함께 plan chain을 적용한다.

- T8.6.1: docs/plans.md가 plan 적용을 정한다: lock, history, drift, 검증, event, MySQL recovery.

- T8.5.2.1: Go plan writer는 버리는 결과와 쓰지 않는 renderer 상태를 두지 않는다.

- T8.5.2: Go engine은 schema plan을 parse, chain, diff하고 MySQL, PostgreSQL, SQLite용으로 쓴다. `make dbspec-plan-check`가 이를 적용한다.

- T8.5.1: docs/plans.md가 schema plan을 정한다: plan 문서, 빈 database에서의 chain, diff, dialect별 statement와 공유 case.

- T8.4.2.4: MySQL introspection은 `ALTER TABLE`이 literal을 0인 소수와 함께 쓴 뒤에도 `time(p)` column의 time CHECK을 알아본다.

- T8.2.6.1.2: `schemaHash`는 집합의 table을 이름 순으로 담은 문서 `schema` 하나로 계산하므로 table이 바뀔 때만 바뀐다.

- T8.4: 모든 client에서 MySQL, PostgreSQL, SQLite를 dbspec으로 introspect한다.

- T8.4.6: 네 client는 MySQL, PostgreSQL, SQLite에서 2000 table stress database를 각각 5초 안에 같은 문서로 introspect한다.

- T8.4.3.1: PHP는 기본 128 MB memory limit 안에서 2000 table stress database를 introspect한다.

- T8.4.2.3: MySQL introspection은 2000 table에서 1분이 넘던 join 대신 catalog query 두 개로 check를 읽는다.

- T8.4.2.2: MySQL introspection은 네 client에서 `ALTER TABLE`이 character set introducer를 다시 쓴 뒤의 renderer CHECK도 알아본다.

- T8.4.2.1: introspection은 Go, PHP, TypeScript, Rust에서 각 미지원 객체를 한 번만 보고하고, 거부된 table의 객체를 table과 함께 빼며, renderer 형식의 SQLite table 항목만 읽는다.

- T8.4.5: Rust client는 MySQL, PostgreSQL, SQLite를 dbspec 문서로 introspect한다. `orm::dbspec::introspect`가 sqlx connection에서 `orm_schema::dbspec`의 catalog query를 실행하고 문서와 미지원 객체를 돌려준다. `make dbspec-introspect-rust-check`가 round trip과 미지원 case를 실행한다.

- T8.4.3: PHP client는 `Orm\Dbspec\Dbspec::introspect(PDO, dialect, name)`로 Go engine과 같은 catalog query를 써서 MySQL, PostgreSQL, SQLite를 dbspec 문서로 introspect하고 미지원 객체를 보고한다. `make dbspec-introspect-php-check`가 round trip과 미지원 case를 실행한다.

- T8.4.4: TypeScript client는 Go engine과 같은 catalog query로 `introspectDbspec`을 통해 MySQL, PostgreSQL, SQLite를 dbspec 문서로 introspect하고 미지원 객체를 보고한다. `make dbspec-introspect-ts-check`가 round trip과 미지원 case를 실행한다.

- T8.2.6.3.7: bench database는 schema/bench.dbspec에서 설치되고 conformance runner는 DSN만 받으며, conformance vector는 MySQL, PostgreSQL, SQLite에서 네 dbspec client로 기록된다.

- T8.2.6.3.6: Rust client는 dbspec document set에서 runtime model과 생성 코드를 만든다.

- T8.2.6.3.5: TypeScript client는 dbspec document set에서 runtime model과 생성 코드를 만든다.

- T8.2.6.3.4: PHP client는 dbspec document set에서 runtime model과 생성 코드를 만든다.

- T8.2.6.3.3: Go client는 dbspec document set에서 runtime model과 생성 코드를 만든다.

- T14.2: Rust decimal과 generated-model coverage test는 workspace 실행에서 ignored이고 소유 target이 `--include-ignored`로 실행한다.

- T14.1: Rust DSN coverage test는 workspace 실행에서 ignored이고 feature-check가 `--include-ignored`로 실행한다.

- T16: send-savepoint SQLite file은 TEST_ENV 옆에 있어서 Rust send-savepoint test가 어느 worktree에서나 실행된다.

- T14: decimal과 feature-coverage Go test는 build tag 뒤에서 `decimal-physical-check`와 `feature-check`에서만 실행된다. 그래서 `client-db-check`는 DSN을 주지 않는 test를 더 이상 실행하지 않는다.

- T8.4.2: Go engine은 일정한 수의 catalog query로 MySQL, PostgreSQL, SQLite를 dbspec 문서로 introspect하고 미지원 객체를 보고한다. `make dbspec-introspect-check`가 round trip과 미지원 case를 실행한다.

- T8.4.1: docs/dialects.md는 MySQL, PostgreSQL, SQLite를 dbspec 문서 하나로 introspect하는 방법과 미지원으로 보고하는 객체를 정한다. tests/dbspec/introspect.json이 미지원 case를 가진다.

- T13: `make git-check`는 commit 제목을 AGENTS.md로 검사한다. `type(scope): Subject (#id)`, type feat, fix, docs, style, refactor, test, chore, 대문자로 시작하고 끝 마침표가 없는 50자 이내 제목이다. merge commit은 git이 쓰는 제목을 둔다.

- T8.2.6.1.1: Korean manifest heading은 anchor `manifest-and-hashes`를 가지며 link가 이를 쓴다. 분해된 Hangul id에는 어느 link도 닿지 않았다.

- T8.1.8: `audit`은 더 이상 `soft_delete`를 요구하지 않는다. schema setting은 database에서 다시 읽히고 manifest setting은 읽히지 않으므로, 이 요구는 introspect한 모든 audit table을 잘못된 문서로 만들었다. physical delete는 여전히 `BEFORE DELETE` trigger가 실패시킨다.

MySQL과 PostgreSQL catalog가 돌려주는 dbspec check predicate 형식만
남긴다. 모든 client에서 `not`, `between`, column 하나를 없애고 `and`
안의 `or`에 필요한 괄호만 쓴다(T8.1.7).

bench schema와 공유 schema fixture를 이름 관례를 모두 setting으로
선언한 dbspec 문서로 다시 쓰고, `make dbspec-ddl-check`에서 렌더링한
각 문서를 MySQL, PostgreSQL, SQLite에 적용한다(T8.2.6.3.2).

client가 dbspec 문서 집합으로 만드는 runtime model과 생성 코드를 정하고,
Mermaid manifest의 모든 field를 그에 대응시킨다(T8.2.6.3.1).

모든 client에서 `and`, `or`, `not`, `in`, `between`, `is`를 dbspec
예약어로 해 check predicate가 keyword 이름의 column을 읽지 않게
한다(T8.1.6).

contracts/interfaces.json에 `Dbspec.render`를 선언하고, `make
dbspec-compare-check`에서 네 client의 렌더링 statement를 비교한다(T8.3.6).

모든 client의 manifest와 renderer에서 반복된 문서 이름이나 없는 쓰이는
문서가 있는 dbspec 문서 집합을 거부하며, renderer는 이제 statement나
diagnostic을 돌려준다(T8.2.6.2.1).

Rust client에서 dbspec 문서 집합을 MySQL, PostgreSQL, SQLite statement로
렌더링하고(`dbspec::render`), tests/dbspec/ddl.json과 비교한다(T8.3.5).

TypeScript client에서 dbspec 문서 집합을 MySQL, PostgreSQL, SQLite
statement로 렌더링하고(`renderDbspec`) tests/dbspec/ddl.json과 비교하며,
package root에서 `renderDbspec`과 `dbspecManifest`를 export한다(T8.3.4).

PHP client에서 dbspec 문서 집합을 MySQL, PostgreSQL, SQLite statement로
렌더링하고(`Dbspec::render`), tests/dbspec/ddl.json과 비교한다(T8.3.3).

renderer가 생성하는 CHECK나 trigger 이름이 63 bytes를 넘을 dbspec
table이나 column을 모든 client에서 거부한다(T8.1.5).

Go engine에서 dbspec 문서 집합을 MySQL, PostgreSQL, SQLite statement로
렌더링하고(`dbspec.Render`), tests/dbspec/ddl.json과 비교한다(T8.3.2).

dbspec이 MySQL, PostgreSQL, SQLite에 렌더링하는 statement를
docs/dialects.md에 정하고, 모든 vector를 세 database에 적용해 behavior
step을 실행하는 `make dbspec-ddl-check`와 tests/dbspec/ddl.json을
더한다(T8.3.1).

모든 client에서 dbspec check predicate에 type 규칙을 둔다. 산술, 함수,
`null` literal, `bytes` column을 거부하고, literal은 만나는 column의
default여야 하며 그 default 형식으로 쓰고, 두 column은 type이 만날 때에만
비교한다(T8.1.4).

`make go-fmt-check`를 `make check`에 더하고, gofmt가 바꿀 Go 파일
6개를 정리하며, Rust workspace를 정리해 `make rust-fmt-check`가 다시
통과하게 한다(T11).

Go, PHP, TypeScript, Rust client에서 dbspec 문서 집합의 manifest text,
schema text, `manifestHash`, `schemaHash`를 계산하고(`ManifestOf`,
`Dbspec::manifest`, `dbspecManifest`, `manifest`), `make
dbspec-compare-check`에서 비교한다(T8.2.6.2).

dbspec manifest text, schema text, `manifestHash`, `schemaHash`를
정하고, 별도 manifest 파일 없이 문서 집합을 유일한 schema 원천으로
한다. 공유 case 3개가 text와 hash를 고정한다(T8.2.6.1).

Go, PHP, TypeScript, Rust dbspec client를 공유 case와 부하 문서에
각각 두 번 실행하고 emission이나 diagnostic이 하나라도 다르면 실패하는
`make dbspec-compare-check`를 더한다(T8.2.5). 이제 `make check`가 모든
dbspec target을 실행한다.

모든 client에서 dbspec `header` error의 위치를 `dbspec 1 <name>`에서
처음 벗어나는 문자로 정하고, TypeScript header의 이중 공백을 거부한다
(T8.1.3). 공유 case 7개가 이 위치를 고정한다.

Rust client에 dbspec parse, 검증, canonical emit을 구현한다(T8.2.1).
parse와 emit이 공유 case 50개를 통과하고, 2000-table 부하 문서를 release
mode에서 median 29-31 ms에 parse한다. Rust symbol snapshot이 이제 code와
같으므로 interface-check가 네 언어 모두에서 통과한다.

각 client의 dbspec parse budget을 부하 문서 parse 다섯 번의 median으로
판정한다. machine의 다른 부하로 느려진 parse는 더 이상 check를 실패시키지
않고, 느린 parser는 여전히 실패한다(T8.2.4.2).

반복된 `blind_index` setting을 AES column 순으로 정렬하고, 실패한
key, index, tab이 든 줄도 종류를 유지해 그 column에 기대는 규칙을
가리게 한다(T8.1.2). 공유 case 6개가 이 규칙을 고정하고, PHP와
TypeScript parser가 이를 따른다.

Go engine에 dbspec parse, 검증, canonical emit을 구현한다(T8.2.2).
Parse와 Emit이 공유 case 44개를 통과하고, 2000-table 부하 문서를
48-53 ms에 parse한다.

PHP client에 dbspec parse, 검증, canonical emit을 구현한다(T8.2.3).
Orm\Dbspec\Dbspec::parse와 ::emit이 공유 case 44개를 통과하고,
2000-table 부하 문서를 128 MiB 안에서 218-308 ms에 parse한다.

모든 client의 dbspec parse budget을 docs/dbspec.md에 정하고, Go,
TypeScript, PHP stress test가 이를 넘으면 실패하게 한다(T8.2.4.1).
Go, PHP, TypeScript의 모든 native symbol을 contracts/symbols에 기록해
그 언어들의 interface-check를 통과시킨다.

TypeScript client에 선언된 interface(parseDbspec, emitDbspec,
DbspecDiagnostic)로 dbspec parse, 검증, canonical emit을 구현한다
(T8.2.4). 공유 case 44개와 집중 case 45개가 통과하고, 2000-table 부하
문서를 105-156 ms에 parse하며 그대로 emit한다. symbol 279개를
contracts/symbols/typescript.json에 기록한다.

Mermaid schema source를 대신할 neutral schema 언어 dbspec을 명세한다
(T8.1). docs/dbspec.md와 한국어 짝 문서는 선언된 문서 집합에서 이름으로
이어지는 문서, 열세 가지 neutral type, key, index, foreign key, neutral
check 식, schemaHash 또는 manifestHash 소속이 있는 settings, operation
column과 row trigger가 복사하는 이력 table로 하는 audit, diagram,
canonical form, 한도, 위치가 있는 diagnostic 규칙 열여섯 가지를 정의하고,
모든 Mermaid 기능의 처리를 판정한다. docs/dialects.md가 audit 판정을
기록한다. tests/dbspec/cases.json의 공유 vector는 canonical 4개, 정규화
2개, 잘못된 문서 17개다. 아직 dbspec을 구현한 client는 없다.

MySQL, PostgreSQL, SQLite의 스키마 사실을 기록하고 기능별 중립 지원을
결정한다(T8.0, T8.0.12). tests/dialects에 공통 probe 239개와
dialect-facts-check target을 추가한다. 각 probe는 자기 일회용 database,
schema, file에서 자기 deadline으로 실행하며, SQLite 파일 이름 case는 PDO,
node:sqlite, sqlite3 shell이 DSN query를 파일 이름에 남긴다는 것을 보여
준다. MySQL 8.4.11, PostgreSQL 17.11, SQLite 3.53.4에서 두 번 실패 없이
통과했다. docs/dialects.md는 기능별 문법, 의미, probe, 중립 rendering 또는
미지원 사유, catalog 출처와 UTC 연결 규칙의 local datetime,
실행기 수정 시각 기록을 기록하고 audit context 정의는 T8.1 review로
남긴다. 현재 스키마 도구와 client의 결함 13개를 T8.0.1-T8.0.11, T8.0.13,
T8.0.14로 기록한다.

PHP 클라이언트에서 PDO driver 확장을 요구하지 않는다(N17). `composer.json`이
`ext-pdo_mysql`을 요구했으므로, 클라이언트가 MySQL driver를 `mysql://` DSN에서만
참조하는데도 공식 PHP image처럼 그것이 없는 PHP에서 `composer install`이
거부되었다. 이제 `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`를 제안하고 어느 것도
요구하지 않으며, `make php-without-mysql-check`가 공식 PHP image에서 SQLite로
클라이언트를 실행한다.

모든 database에서 트랜잭션 rollback을 실패시키는 test fault를 제공한다(N16).
orm에는 rollback을 실패시키는 지원 방법이 없었다. ORM
test는 MySQL과 PostgreSQL에서 server session을 종료하거나 SQL로 쓴 SQLite
trigger를 설치한다. 이제 각 클라이언트의 test entry point가 연결에 rollback
fault를 설정한다. Go는 build tag `ormtest`의 `orm.FailNextRollback(db)`, Rust는
feature `test-faults`의 `orm::testing::fail_next_rollback(&db)`, TypeScript는
Node condition `orm-test`에서 `@polyspec/orm-typescript/testing`의
`failNextRollback(db)`, PHP는 package autoloader가 load하지 않는
`testing/Faults.php`의 `Orm\Testing\Faults::failNextRollback($db)`를 쓴다.
DSN, 설정 값, 환경 변수는 fault를 설정하지 않는다. callback이 실패한 다음
트랜잭션의 rollback은 실행된 뒤 새 catalog code `FAULT`로 보고되어, 트랜잭션은
callback 오류와 `FAULT` 오류를 가진 `ROLLBACK`을 반환한다. `rollback_fault`
case가 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 통과한다.

migration ledger의 시각을 모든 database에서 마이크로초로 저장한다(N15).
ledger `orm_schema_migrations`는 MySQL에서 `timestamp`를 선언했고 SQLite에서
`CURRENT_TIMESTAMP`로 쓴 `TEXT`를 썼으므로, 그 `started_at`과 `finished_at`은
두 database에서 초 단위로 저장되었고 PostgreSQL에서만 마이크로초를 유지했다.
이제 Go, PHP, Rust, TypeScript의 schema tool은 MySQL에서
`CURRENT_TIMESTAMP(6)`으로 쓰는 `timestamp(6)` column을 만들고, SQLite에서
소수 여섯 자리를 요구하는 `CHECK`가 있고 tool clock을 UTC로 받는 `TEXT`
column을 만든다. command가 기존 ledger를 쓰기 전에 tool은 그 시각 column을
검증하며, 초 단위 column을 가진 ledger는 `MIGRATION_HISTORY_PRECISION`으로
실패하고 바뀌지 않는다. `docs/usage.ko.md`는 이 변경 이전에 만든 MySQL 또는
SQLite ledger를 변환하는 statement를 적는다. `migration_ledger_microseconds`,
`migration_ledger_whole_seconds`, `migration_ledger_earlier` case가 Go, PHP,
Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 통과한다.

MySQL에서 database clock을 마이크로초로 기록하고, SQLite 상대 value
function에서 클라이언트 clock의 소수부를 유지한다(N14). MySQL dialect는 soft
delete를 `CURRENT_TIMESTAMP`로, `now` value function과 그 상대 형식을
`NOW()`로 렌더링했으므로 soft delete가 `datetime(6)` column에 초 단위 값을
저장했고, `created_ts <= now()`가 같은 초에 먼저 만든 row를 놓쳤다. SQLite
상대 형식은 `datetime(clock, modifier)`를 렌더링하여 bind한 clock의 소수부를
버렸다. 이제 soft delete는 update 시각처럼 column이 선언한 소수 자릿수로
clock을 대입한다(MySQL `CURRENT_TIMESTAMP(p)`). MySQL value function은
`NOW(6)`을 쓰고, SQLite 상대 형식은 `datetime` 결과에 clock의 소수 여섯
자리를 붙인다. `clock_soft_delete_microseconds`와 `clock_now_condition`
case가 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 통과한다.

트랜잭션이나 savepoint의 callback이 실패하고 rollback도 실패하면 두 오류를
모두 보고한다(N13). PHP 클라이언트는 callback 오류를 rollback 오류로 바꾸었고,
TypeScript 클라이언트는 rollback 오류를 버렸으며, Go 클라이언트는 트랜잭션
rollback 오류를 버렸고, Rust 클라이언트는 두 오류를 `CONFIG` 문자열로만
보고했다. 이제 모든 클라이언트가 catalog code `ROLLBACK`을 가진 오류 하나를
반환하며, 그 오류는 두 오류를 적고 유지한다. checkout된 TypeScript PostgreSQL
연결은 서버가 문장 사이에 보고한 연결 오류를 처리되지 않은 error event로
process를 종료하지 않고 보관한다. ORM test는 SQLite에서 callback이 model 호출만
하는 동안 `ROLLBACK`을 일으키는 fixture trigger로 트랜잭션을 종료하고, MySQL과
PostgreSQL에서는 test 연결이 server session을 종료한다. Go에서 MySQL이나
PostgreSQL 트랜잭션 안의 취소된 문장은 연결을 닫으므로, 트랜잭션은 취소를 유지한
`ROLLBACK`을 보고한다.

네 클라이언트에 `utils().schema().register(manifestJson)`을 제공한다(N3.3).
테이블이 이미 있는 스키마를 등록하려면 engine을 만들고 내부
`registerEngine`을 호출해야 했다. register는 manifest hash를 내용과 대조하여 다르면
`CONFIG`를 반환하고, 문장을 실행하지 않으며, `install`과 같이 engine을 연결에
추가한다. `install`도 같은 등록을 사용한다. Rust 클라이언트의 연결은 아직
스키마를 유지하지 않으므로(N3.2) manifest만 대조한다. `contracts/interfaces.json`이 이
operation과 현재 symbol snapshot hash를 기록한다.

TypeScript 생성기 scan에서 model chain의 method 호출만 타입으로 만든다(N12).
scan은 소스 파일의 모든 method 호출 이름을 모아 그 이름을 받는 모든 model에
선언했으므로, model이 아닌 class의 `this.enabled()` 같은 호출이 model method를
더했고 그 호출을 지우면 method도 사라졌다. 이제 scan은 소스에서 각 receiver를
해석한다: 생성 class의 `new`, binding, 타입이 있는 parameter, model을 돌려주는
function, model chain, model callback, model의 row와 collection. method는
receiver가 해석된 model에만 선언한다. 사용 안내서가 규칙을 적는다.

모든 driver 오류를 catalog code를 가진 ORM 오류로 보고한다(N11). PHP
클라이언트는 `orm:audit`나 `orm:immutable` trigger가 거부한 쓰기처럼 catalog에
없는 driver 오류를 `PDOException` 그대로 돌려주었고, Go 클라이언트는 바꾸지 않고
돌려주었으며, Rust 클라이언트는 code `SQLX`를 보고했다. 이제 catalog가 그런
오류에 `DRIVER`를 두고, 모든 클라이언트가 driver 메시지와 원인인 driver 오류를
유지한다. PHP `OrmException::fromDriver`는 항상 `OrmException`을 돌려주고, Go
`orm.Error`는 driver 오류로 unwrap되며, Rust는 `Error::Driver { code, msg,
source }`를 보고한다. SQLite 1811은 `FOREIGN_KEY`가 아니라 trigger 거부이고,
PHP, Rust, TypeScript는 CHECK 위반을 `CONSTRAINT`로 바꾼다. `trigger_refused`와
`check_refused` case가 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL,
SQLite로 통과한다.

모든 클라이언트에서 클라이언트 clock을 마이크로초로 기록한다(N10).
TypeScript 클라이언트는 `Date`로 clock을 읽어 SQLite `now` bind slot에
`.mmm000`을 저장했다. 이제 wall clock에 맞춘 monotonic clock의 마이크로초를
더하고, 두 clock의 차이가 1밀리초를 넘으면 기준점을 옮긴다. protocol이 모든
클라이언트의 `now` slot 규칙을 적는다. `clock_microseconds` case가 Go, PHP,
Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 통과한다.

한 process에서 여러 schema의 생성 PHP model을 읽는다(N3.1).
생성된 model class마다 자기 schema hash를 가지며, 연결은 등록된 schema마다
engine 하나를 유지한다. 연결을 열 때의 schema와
`utils()->schema()->install()`로 설치한 모든 manifest가 등록된다. install은
문장을 실행하기 전에 manifest hash를 내용과 대조하고, 연결에 등록되지 않은
schema의 요청은 `SCHEMA_HASH_MISMATCH`로 실패한다. Go, PHP, Rust,
TypeScript owner case가 MySQL, PostgreSQL, SQLite에서 schema 두 개를 한
연결에서 사용한다.

네 파서에서 물리 문서 입력 상한을 검증한다(T7.17.2.10.3.4).
64 MiB·200000줄·4096블록을 유지하며 소유별 상한·초과를 두 번 실행해
정확한 보존·안전한 자원 진단을 확인했다. PHP 상한 Red는 즉시 할당하는
본문 부분이 입력을 복제해 128M을 소진한다. 대신 원문·범위를
copy-on-write로 유지하고 prefix/suffix 필드를 제거해 명시적인 부분
조회 메서드를 제공한다. 최대 할당량은 71319552바이트이며 RSS가 아니다.
관련 PHP 전체 레코드·진단·연결 문서 왕복도 두 번 통과했고 범위 내
lint·컴파일·문서 쌍 검사도 통과했다. 입력 파싱·보존의 증거이며 128M에서
완전한 편집 사본 두 개를 유지한다는 의미가 아니다. 소유·남은 문법/출력
기준·임포트 활성화는 미완료다.

네 소유에서 물리 메타데이터와 ERD 표시를 함께 읽는다(T7.17.2.10.3.3).
완전한 그래프 레코드와 주변 마크다운을 보존하고 표시 모순·잘못된
메타데이터를 안전한 줄/경로 진단으로 거절한다. 실제 Mermaid가 처음의
역슬래시 표시 초안을 거절한 뒤 가역 U+241B 표시 이스케이프를 사용한다.
다중성은 검증하지 않았음을 명시하며 그림 표기를 SQL 증거로 쓰지 않는다.
공통 거절 7개와 연결된 2000테이블/60000컬럼/10000FK 문서 왕복을 포함한
소유 테스트를 두 번 실행했다. Chromium의 특수 이름·병렬 FK 렌더링도
두 번 통과했다. PHP 최대 할당량은 기존 128M에서 117030912바이트이며
RSS가 아니다. 범위 내 lint·컴파일과 문서 쌍 검사가 통과했다.
권위 있는 소유·전체 문법/자원 기준·네이티브/플랫폼
증거는 아직 미완료다.

물리 원문 scanner의 범위를 적는다(T7.17.2.10.3.2). docs/schema.md(+ko)는
scanner가 임의의 HTML 태그나 전체 Markdown container를 분류하지 않으며,
문서 reader가 자기 원문 소유를 확정하고 graph metadata를 그림과 함께
검증한 뒤에 import를 켠다고 적는다. 문서 쌍과 diff 검사가 통과했고 실행
코드는 그대로다.

이름 있는 블록 HTML을 빈 줄이나 EOF까지 보호한다(T7.17.2.10.3.1.2).
종료 태그 뒤에도 내부 원문을 해석하지 않으며 중첩 HTML·펜스 표시는 종료
규칙을 바꾸지 않는다. 제한된 ASCII 블록 이름과 명시한 구분자만 비교하고
명시적인 원시 요소 종료 규칙을 유지한다. 네 클라이언트의 기존 이름 있는
태그 실패가 Green이다. 소유 명령이 시작·종료 태그 124개, 추가 23개와
100000줄 블록 사례를 관련 HTML·원문·자원 회귀와 함께 소유별 두 번
실행했다. macOS arm64에서 범위 내 lint·컴파일·문서 쌍과 diff 검사가
통과했다. 문단에 따라 달라지는 태그·일반 컨테이너·그래프/그림 공동 파싱은
미완료이며 임포트 기능 완료를 주장하지 않는다.

물리 원문 스캔에서 명시적 종료를 가진 HTML 블록을 보호한다
(T7.17.2.10.3.1.1). 주석·원시 요소·처리 지시·선언·CDATA 내부의 스키마
모양 펜스를 무시하고 종료 줄 뒤에서 재개한다. 미완성 블록은 안전한
시작 줄 진단으로 거절한다. 코드 펜스 내부의 HTML 모양 원문은 그대로
유지한다. 줄마다 나머지 소스를 검색하지 않고 HTML 종료를 한 번 찾는다.
네 클라이언트에서 재현한 주석 Red가 Green이다. 소유 명령이 새 공통
29개·100000줄 부하 2개와 관련 원문·제한·인코딩 회귀를 클라이언트마다
두 번 통과했다. 범위 내 lint·컴파일·문서 쌍과 diff 검사가 통과했다.
빈 줄 HTML·일반 컨테이너·그래프/그림 공동 파싱·임포트·네이티브/플랫폼
증거는 여전히 미완료다.

네 클라이언트에서 물리 마크다운 원문 블록을 찾는다(T7.17.2.10.2).
본문·줄 복사본을 유지하지 않고 UTF-8 바이트 범위를 반환한다. 다른 펜스
예제를 해석하지 않으며 알 수 없는 버전·중복·미완성 블록과 인코딩·바이트·
줄·블록 초과를 값 없는 줄 진단 하나로 거절한다. 빠진 스캐너 API와
재현한 목록 예제 오인이 Green이다. `make physical-envelope-check`가
소유별 공통 21개, 제한·초과 6개와 네이티브 인코딩을 두 번 통과했다.
PHP 최대 할당량은 기존 128M 제한에서 71319552바이트이며 RSS가 아니다.
macOS arm64에서 소유 lint·컴파일, 문서 쌍과 diff 검사를 통과했다.
HTML 해석·그래프/그림 공동 검증·임포트는 미완료다.

실패 가능한 Rust 모델 setter 뒤의 Result 변환을 구분한다
(N2.1.1). 오류 변환과 확인된 추출 뒤 모델 접근을 유지하고 변환된 성공
값을 원래 모델과 구분한다. 알 수 없는 모델 호출과 실패하지 않는
setter의 Result 메서드를 거부한다. 생성 사례 14개, 생성 모델 소비
사례 1개, 소유 및 소비 코드의 엄격한 Clippy와 문서 쌍 검사가 통과했다.

물리 마크다운 표시 요구사항을 명시한다(T7.17.2.10.1). 정확한 JSON
메타데이터와 제한된 그림 이름·검증하지 않은 crow-foot 다중성을 구분한다.
입력 활성화 전에 안정된 ID, 공동 모순 검사, 일반 마크다운 보존,
제한된 소스 처리, 네 클라이언트의 모든 필드 왕복을 요구한다. 기존 논리
파서는 권위 있는 물리 문서 파서가 아니다. 문서 쌍·표현 검사를 통과했으며
문법이나 렌더링 구현 완료를 주장하지 않는다.


네 클라이언트에서 엄격한 물리 그래프 JSON을 읽고 출력한다(T7.17.2.9).
정보가 사라지기 전에 디코딩된 중복 멤버, 잘못된 문법·Unicode, 반올림과
바이트·깊이·노드 초과를 거절한다. 물리 그래프 검증을 재사용하고 반복
텍스트 왕복으로 모든 필드·목록 순서를 보존한다. Go/PHP/Rust/TypeScript의
빠진 API Red가 Green이다. physical-json-check가 클라이언트별 공통 30개,
숫자 표기 6개, 디코더 제한·다음 값 6개, 전체 레코드·인코딩, 관련 그래프·
레코드 회귀를 두 번 통과했다. 추가 출력 크기 2개도 네 클라이언트에서
두 번 통과했다. 연결된 2000테이블·60000컬럼·10000FK와 인덱스·키·CHECK
각 2000개를 14123977바이트 출력·파싱·재출력으로 멱등하게 보존했다.
PHP 메모리 소진 재현을 제한 상승이나 fixture 축소 없이 직접 트리 구성·
제한된 FIFO 공유로 고쳤다(T7.17.2.9.1). 동일 부하의 최대 할당량은 기존
128M 제한에서 93290496바이트(89 MiB)이며 RSS가 아니다. 256M 원인 측정
실행은 완료 증거가 아니다. TypeScript ES2022 Unicode 메서드 컴파일 오류를
억제나 대안 없이 직접 코드 포인트 검증으로 고쳤다(T7.17.2.9.2).
새 문서의 금지 표현은 검사기·기술적 기준을 약화하지 않고 고쳤다(T7.17.2.9.3).
macOS arm64에서 Go vet, Rust 1.98.1 엄격한 소유 Clippy·범위 내 포맷,
Node 26.10.0 TypeScript 컴파일, PHP 문법, 문서 쌍 검사가 통과했다.
마크다운·임포트·DDL·실행·다른 플랫폼 검증은 미완료다.


물리 그래프의 인덱스·키·CHECK 참조를 검증한다(T7.17.2.8). 세 배열을 필수로
받고 이전 루트 형태는 폴백 없이 거절한다. 전역 ID, 테이블·컬럼 소유,
공유 제약 이름, 테이블당 단일 기본 키, 순서 있는 기반 인덱스 연결을
위치 오류로 검증한다. 정확한 레코드를 보존하고 텍스트를 그래프 바이트
제한에 포함한다. 네 언어의 이전 형태 Red가 Green이다.
physical-graph-check가 클라이언트별 새 공통 사례 45개와 기존 그래프 28개·
제한 5개를 두 번 실행하고 관련 레코드 회귀·참조 분리·빈 배열 요소를 검증했다.
Go/PHP/Rust/TypeScript가 기존 시간 제한 아래에서 2000테이블, 60000컬럼,
10000FK와 인덱스·키·CHECK 각 2000개를 보존한다. PHP 최대 할당량은 기존
128M 제한에서 72 MiB이며 RSS가 아니다. macOS arm64에서 Rust 1.98.1
엄격한 소유 Clippy·범위 내 포맷, Go vet, Node 26.10.0 TypeScript 컴파일,
PHP 문법, 문서 쌍 검사가 통과했다. SQL 파싱, 물리 임포트, DDL, 실행,
네이티브 플랫폼 검증은 미완료 요구사항이다.


네 클라이언트에서 물리 기본·고유 키 레코드를 보존한다(T7.17.2.7). 제약 이름,
순서 있는 컬럼 ID, 독립적인 기반 인덱스 ID, 지연 검사, 고유 키 NULL 처리,
시간 중첩 메타데이터를 유지한다. 알 수 없는 형태, 중복 컬럼, 모순된 지연
플래그, 기본 키 NULL 옵션 오용, 바이트·개수 제한 초과는 입력 값 없이
거절한다. Go/PHP/Rust/TypeScript의 빠진 API Red가 Green이다.
physical-key-check가 클라이언트별 공통 벡터 35개와 제한 사례 14개를 두 번
실행하고 인코딩·참조 분리·빈 배열 요소, 기존 컬럼·CHECK·인덱스·FK 회귀를
검증했다. macOS arm64에서 Rust 1.98.1 엄격한 소유 Clippy·범위 내 포맷,
Node 26.10.0 TypeScript 컴파일, PHP 문법, 문서 쌍 검사를 통과했다.
시간 메타데이터 보존은 방언·범위 타입·기반 인덱스 일치 검증이 아니다.
그래프 참조 검증, 물리 임포트, DDL, 실행, DB 대조, 네이티브 플랫폼
검증은 별도 요구사항이다.


네 클라이언트에서 불변 물리 인덱스 레코드를 보존한다(T7.17.2.6). 순서 있는
컬럼·식 항목, 반복 컬럼, 접두 길이, 정렬·NULL 순서, 원문 collation/
operator-class, 포함 컬럼, 부분 조건, 고유성, 가시성, 주석, 순서 있는
옵션을 유지한다. 미지정 값을 구분하며 SQL을 변환하거나 인덱스를 기본·고유
제약과 합치지 않는다. 잘못된 형태·인코딩·제한 초과는 입력 값 없이 거절한다.
네 언어의 빠진 API Red가 Green이다. physical-index-check가 클라이언트별
공통 벡터 46개와 제한 사례 20개를 두 번 실행하고 참조 분리·빈 배열 요소·
인코딩·네이티브 수치와 기존 CHECK·컬럼 회귀를 검증했다. macOS arm64에서
Rust 1.98.1 엄격한 소유 Clippy와 범위 내 포맷, Node 26.10.0 TypeScript
컴파일, PHP 문법, 문서 쌍 검사를 통과했다. 구조 교환이며 그래프 연결,
SQL 파싱, 임포트, DDL, 실행, DB 대조, 다른 플랫폼 검증은 아니다.


네 클라이언트에서 불변 물리 CHECK 레코드를 보존한다(T7.17.2.5). 정확한 이름,
원문 식, 서로 독립적인 nullable 강제·검증 상태, 주석, 순서 있는 옵션을 유지한다.
잘못된 레코드와 크기·인코딩 제한 초과는 값을 노출하지 않는 오류로 거절하고
호출자 값을 분리한다. Go/PHP/Rust/TypeScript에서 빠진 API로 실패한 Red가 Green이다.
재사용 가능한 physical-check-check가 클라이언트마다 공통 벡터 24개와 제한
사례 17개를 두 번 실행하고 인코딩·참조 분리와 컬럼 25개 회귀를 검증했다.
macOS arm64에서 Rust 1.98.1 엄격한 소유 Clippy와 범위 내 포맷 검사,
Node 26.10.0 TypeScript 컴파일, PHP 문법, 문서 쌍 검사를 통과했다.
새 문서의 금지 표현과 지원하지 않는 하이픈 하위 ID도 검사를 약화하지 않고
고쳤다(T7.17.2.5.1). 구조 교환이며 그래프 연결, SQL 검증, 물리 임포트,
DDL, DB 대조, 실행은 아니다.


중첩 savepoint가 Box 할당 객체 대신 타입을 지운 Send callback을 직접 빌리게
수정했다(N9.2.1). 엄격한 borrowed-Box lint와 추적되는 callback 참조 컴파일
실패를 재현했고 억제 없이 Green이다. 분리된 소유 트랜잭션 테스트와 공개
rust-send-savepoint-check를 추가했다. Rust 1.98.1의 엄격한 Clippy와 세 DB
MySQL/PostgreSQL/SQLite 사례가 두 번 통과했다. Send future·중첩/외부 rollback·
정확한 테스트 행·callback 오류·프레임 복구·연결 재사용을 유지한다. 연결 전용
임시 테이블을 사용하므로 사용자 테이블 쓰기나 영구 테스트 데이터 정리가 없다.
공통 Make 테스트 환경이 SQLite URI를 선언해 기존 테스트 진입점도 전달받는다.
macOS arm64에서 소유 라이브러리/테스트 Clippy·수정 파일 포맷·영한 문서 검사가
통과했다. 공개 트랜잭션 의미 변경이나 네 언어의 DB conformance는 아니다.

네 클라이언트에서 불변 물리 그래프를 해석한다(T7.17.2.4). 테이블/컬럼/FK
순서·정확한 이름·독립 제약을 유지하고 중복 ID/이름·누락/다른 소속 참조·
개수/문자열 초과를 값 없는 JSON pointer 오류로 거부한다. 네 언어의 API 누락과
Go 네이티브 정수 버전 거부 Red가 Green이다. 기존 연결 스트레스 사례가 PHP
128M 제한을 넘었다. 제한을 올리지 않고 참조 없는 배열의 copy-on-write를
이용하며 명시적 참조는 분리했다. 동일 사례의 PHP 프로세스 최대 할당량은
62MiB다. 공개 physical-graph-check가 그래프 28개·제한 5개를 언어마다 두 번
실행했고 컬럼 25개·FK 26개 회귀도 통과했다. 각 언어에서 테이블 2000개·컬럼
60000개·연결된 FK 10000개를 보관한다. macOS arm64에서 소유 Rust 1.98.1
Clippy·명시한 Node 26.10.0의 TypeScript 컴파일·영한 기록 검사가 통과했다.
처음 잘못 계산한 바이트 제한의 예상 위치는 별도 문자열 바이트 합으로 수정했다.
전체 물리 스키마·임포트·DDL·DB conformance의 증거는 아니다.

네 클라이언트에서 정확한 물리 FK를 보존한다(T7.17.2.3). 제약 이름·컬럼 쌍
순서·독립 동작·match·지연 조건을 유지하고 잘못되거나 모순된 객체는 값 노출
없이 거절한다. 컬럼/FK의 제한 검증을 공통 모듈로 분리하고 Rust ColumnError를
RecordError로 교체했다. API 누락 Red가 Green이다. 공개 physical-fk-check가
FK 26개·컬럼 25개 벡터를 각 언어에서 두 번 실행했고 불변/sparse/길이 제한과
FK 2000개 보관도 검증했다. macOS arm64에서 Rust 1.98.1 Clippy·명시한 Node
26.10.0의 TypeScript 컴파일·PHP 문법·영한 문서 검사가 통과했다. 보관 시간은
연결 그래프의 증거가 아니며 그래프 해석·임포트·물리 DDL·실행은
미완료다.

네 클라이언트에 불변 물리 컬럼을 추가했다(T7.17.2.2). 원문 SQL·없음/NULL/
리터럴/표현식 기본값·identity/computed 생성·정확한 이름/코멘트·옵션 순서를
강제 변환 없이 보존한다. 알 수 없는 필드·잘못된 타입/UTF-8·제한 초과를
거절한다. API 누락과 PHP 참조 입력 공유 Red가 Green이며 TypeScript 타입
좁히기 컴파일 오류도 수정했다. 추적되는 physical-column-check가 공통 벡터
25개를 클라이언트마다 두 번 실행하고 바이트/개수/인코딩/별칭 공유도 검증했다.
TypeScript 컴파일·소유 Rust Clippy·PHP 문법·영한 문서 검사가 통과했다.
구조가 맞는다는 것은 SQL 검증·물리 임포트·실행 권한을 뜻하지 않는다.

물리 catalog/schema/table/column 이름을 논리 모델 식별자와 분리해 정확히
보존한다(T7.17.2.1). 불변 요소와 UTF-8 hex 키로 대소문자와 한정 구성을
정규화 없이 구분하고 빈 값·제어문자·인코딩 오류·바이트 초과는 값 없는
오류로 거절한다. Go/PHP/Rust/TypeScript API 누락과 TypeScript sparse array
허용 Red가 Green이다. 반복 가능한 physical-identity-check가 공통 벡터 10개를
각 클라이언트에서 두 번 실행하고 바이트·인코딩·별칭 공유도 검증했다.
소유 Clippy·TypeScript 컴파일·PHP 문법·체크리스트·문서 규칙이 통과했다.
물리 임포트·주석 해석·DDL·DB conformance 완료는 아니다.

문서 검사 실패 후 앞선 커밋이 이어진 최종 한국어 변경 허가 기록의 금지 표현을
수정했다. 같은 규칙이 영한 21쌍에서 Green이며 체크리스트와 새 정적 문서
검사(42페이지·437대상·26도표)가 통과했다. 네이티브 코드와 인수 기준은
바꾸지 않았다.

네이티브 Rust 행 변경에 실패 가능한 명시적 커밋 전 허가를 요구한다. 트랜잭션
쓰기 검증 후 허가 실패는 커밋 시작 발행·독립 소유 작업 이전에 롤백한다.
허가 실패를 보존하며 잘못된 대입은 허가에 도달하지 않는다. 필수 인수 API
누락 컴파일 Red가 Green이고 실제 MySQL/PostgreSQL/SQLite의 삽입/갱신/삭제
거부 및 승인 커밋이 통과했다. 소유 관련 테스트 20개와 Clippy --no-deps가
통과했다. 기존 호출자는 호환 기본값 없이 명시적 허가를 제공한다. 수정 Rust
서식·체크리스트/문서 규칙·새 문서 빌드/정적 검사도 통과했다(42페이지·437대상·
26도표).
영속 기록/승인/복구·다른 플랫폼·4클라이언트 적합성은 미완료다.

제한된 명시적 트랜잭션 입력 조건으로 MySQL 표현식 기본값 식별자를 반환한다.
기존 일치 없음·쓰기 후 정확히 한 행의 값·실제 키를 commit 전에 증명하며 모호한
조건은 쓰기 없이 거부한다. 기본값 재평가·사용자 스키마 변경·트리거 추가는 없다.
엔진/descriptor 검사 전 MySQL 대상 메타데이터 잠금이 없던 문제를 수정했다.
UUID 식별자와 실제 테이블 잠금 Red가 Green이며 다른 추가 사례는 회귀 검사다.
실제 세 DB의 변하는 텍스트 키·NULL 조건·취소/강제 변환 rollback·인덱스 기반
동시 식별자를 포함한 소유 테스트 21개와 소유 Clippy가 통과했다. 검증·RETURNING·
식별 조건 역할을 분리했다. 네이티브 키 삽입은 검증했으며 영속 권한/복구·
다른 OS·4클라이언트 작업은 남아 있다.
체크리스트/문서 규칙과 수정 Rust 파일 서식 검사가 통과했다. 새 문서 빌드와
정적 검사가 42페이지·내부 대상 437개·도표 26개에서 통과했다.

정확한 메타데이터와 제한된 RETURNING 또는 MySQL statement 응답/서버 DEFAULT로
자동·고정 기본값 키를 반환한다. 자동 키와 MySQL 고정 기본값 Red가 Green이며
실제 로컬 세 DB 동시성·기본값·제약/강제 변환 거부·취소 rollback을 포함한 소유
테스트 21개가 통과했다. 소유 Clippy --no-deps는 통과했으며 기존 의존성 borrowed-Box
lint는 실패했다(N9.2.1). 생략한 MySQL 표현식 기본값 키는 미해결(T7.17.1.13.2.2)이며
쓰기 전에 거부하고 완료로 취급하지 않는다. 전체 삽입/편집·4클라이언트·다른
플랫폼 요구는 남아 있다.

기술 요건·측정값·검사 규칙을 바꾸지 않고 체크리스트·인터페이스·성능 문서의
금지 표현을 수정했다. 기존 문서 규칙 Red가 영한 21쌍에서 Green이다.
새 문서 빌드와 정적 검사가 42페이지·내부 대상 437개·도표 26개 및 JavaScript
없는 읽기와 대화형 탐색에서 통과했다. 체크리스트 검사도 통과했다(T7.D8.2).

새 discard-on-drop 트랜잭션에서 호출자가 승인한 네이티브 Rust update/delete와
명시적 키 삽입을 추가한다. 원본 키를 잠그고 descriptor/정확한 기준 값을 비교한
뒤 타입형 bind로 쓰고 저장 값/영향 행을 commit 전에 검증한다. 생성 컬럼 대입·
강제 변환·안전하지 않은 MySQL 엔진/미확인 트리거 가시성을 거부한다. 값 없는
단계를 발행하고 호출자 취소 뒤에도 commit을 소유하며 확인된 PostgreSQL 거부와
응답 미확인을 구분하고 자동 재시도하지 않는다.
공개 API/검증 누락 컴파일 Red·INTEGER 키 준비·명시적 commit 거부 Red가 Green이다.
macOS에서 소유 라이브러리/기준/페이지/bind/변경 테스트 18개가 통과했으며 실제
세 DB 쓰기·인용 복합키·키 변경·스키마 충돌·FK/unique 원본 보존·생성/default/NULL·
취소 rollback·경쟁 잠금·중단 정리를 포함한다. PostgreSQL 소유 연결 종료로 불명
commit을 확인하고 대기 중단 뒤 성공 commit도 관측한다. 다른 추가 사례는 회귀
검사이며 Red라고 주장하지 않는다. PostgreSQL 준비에 선언 bind codec 타입을
전달하고 값 복사 전에 빌린 입력의 상한을 검증한다.
실패한 Red의 fixture를 포함한 테스트 소유 자원을 제거했다. 자동 기본키 삽입·
영속 작업 식별/권한·4클라이언트 적합성·다른 플랫폼은 미완료다.
체크리스트 검사는 통과했다. 문서 규칙 검사는 기존 금지 표현에서 여전히 실패하며
별도 T7.D8.2에서 수정한다.


SQLx 드라이버 codec으로 네이티브 Rust tool bind에 명시적 타입형 NULL·바이너리·
bool·네이티브 실수 비트·정확한 decimal·MySQL unsigned를 추가한다. 제한된 조회와
영향 행 실행이 bind 경로를 공유한다. 미지원 dialect 종류·잘못되거나 표현할 수
없는 입력·인수 개수/값 상한을 prepare/실행 전에 거부하며 SQL에 값을 서식화하지
않는다. API 누락 컴파일 Red가 Green이며 유효성/실제 경로 사례 3개와 관련
네이티브/라이브러리/CLI 테스트 40개가 통과했다. 세 DB 소유 fixture에서 저장 값·
지원 NULL 종류·영향 행·네이티브 제약 오류·거부된 쓰기의 원본 유지·rollback을
확인했고 PostgreSQL NaN/무한대/음수 0·SQLite 무한대 bind도 통과했다. 나머지는
추가 회귀 검사다. SQLite boolean 기대값은 codec 변경 대신 실제 INTEGER 저장
측정으로 바로잡았고 dialect별 조기 성공 로그를 제거했다. 소유 테이블/파일을
제거했다. bind는 컬럼/서버 강제 변환 방지가 아니며 잠긴 행 변경/쓰기 후 검증·
4클라이언트 적합성은 미완료다.

한정된 테이블 페이지에서 비NULL 기본키 식별·정확한 타입형 원본 셀·8 MiB 제한
SHA-256 descriptor/값 revision을 검증하는 불변 Rust RowSnapshot을 캡처한다.
descriptor 변경·누락/변경 행·중복 식별을 구분하고 Debug/오류에 값을 넣지 않는다.
API 누락 컴파일 Red가 Green이며 기준 사례 3개와 관련 테스트 13개가 통과했다.
실제 세 DB 소유 행에서 변경 충돌과 정확한 복구를 검증했다. 유효성/타입/한도/
실제 DB 추가 검사는 회귀 검사다. 순수 비교 API이며 DB 잠금·쓰기·권한은 아니다.
타입형 bind·잠긴 변경·4클라이언트 적합성은 미완료다.

네이티브 타입형 값·descriptor 컬럼 출처·선언 기본키 순서가 있는 명시적 한정
Rust 테이블 페이지를 추가한다. 식별자를 인용하고 새 강제 읽기 전용 범위·
limit/offset·행 인코딩 상한을 적용하며 추가 행 하나로 다음 페이지를 확인한다.
descriptor 변경이나 prepared 컬럼 불일치를 거부한다. API 누락 컴파일 Red는
실제 세 DB에서 Green이며 빈/뷰·인용 이름·상한·8 MiB 초과/복구·조립 회귀와
소유 테스트 10개가 통과했다. offset 페이지는 독립 스냅샷이고 편집 권한이 아니다.
네 클라이언트 conformance는 미완료다.

Rust 한정 테이블 descriptor에서 MySQL 네이티브 SYSTEM VIEW를 뷰로 분류한다.
실제 MySQL 테스트로 네이티브 종류와 descriptor 거부를 먼저 Red로 확인한 뒤
기본키 행 식별이나 DB 쓰기 없이 Green을 검증했다. 세 DB 일반 테이블/뷰 회귀를
포함한 메타데이터/카탈로그 테스트 6개가 통과했다. 알 수 없는 종류는 계속 거부하며
쓰기 권한이나 네 클라이언트 conformance를 뜻하지 않는다.

생성 사례·알 수 없는 메서드 거부·컴파일한 컨트롤러 사용 사례로
styled setter Result 처리를 검증한다.

styled setter 바로 다음 Rust Result 처리를 구분하고 `expect`나 `unwrap`의
열 메서드를 생성하지 않는다. 후속 모델 호출 검증을 유지한다.

바인딩한 카탈로그 이름·네이티브 타입·생성 플래그·제약 선언 순서의 기본키를
가진 한정된 Rust 테이블 descriptor를 노출한다. 신뢰할 행 식별을 판정하기 전에
SQLite nullable 레거시 키·DESC 키·INTEGER rowid 별칭·WITHOUT ROWID 키를
구분한다. 공개 API 누락 컴파일 Red는 실제 MySQL·PostgreSQL·SQLite에서
Green이다. 추가 뷰·잘못된 이름·미지원 namespace·타입 없는 컬럼 회귀와 소유
라이브러리/카탈로그/읽기 전용/컬럼/메타데이터 테스트 12개가 통과했다. descriptor는
변경 권한이 아니며 물리 임포트나 네 클라이언트 conformance 완료도 아니다.

이진 실수나 고정 정밀도 모델 codec 대신 고정한 BigDecimal 0.4.11로 유한 Rust
그리드 decimal을 정확한 일반 문자열로 보존한다. 공개 드라이버 바이트에서
PostgreSQL 결과 scale을 복원하고 값이 달라지는 조정을 거부한다. decimal variant
누락 컴파일 Red는 실제 MySQL 65자리·PostgreSQL scale 보존 결과에서 Green이며
SQLite는 실제 저장 클래스를 유지한다. 추가 200자리/지수·NULL·예산·비유한
거부 회귀가 통과했다. 통합 14개·CLI 11개·라이브러리 5개가 통과했다. 비유한
numeric 지원·시간 타입은 미완료다.

엄격한 카탈로그 스칼라 디코딩을 바꾸지 않고 Rust 그리드 float32/float64의
IEEE-754 비트와 unsigned 전체 범위를 보존한다. 타입 variant 누락 컴파일 Red는
실제 세 DB float64·PostgreSQL float32/부호 있는 0/NaN·MySQL u64::MAX에서
Green이다. 숫자 NULL·바이트 예산 추가 회귀가 통과했다. 통합 테스트 13개·CLI
11개·라이브러리 5개가 통과했다. decimal/시간 타입은 미완료다.

텍스트·빈 텍스트·NULL과 구분하면서 바이너리 바이트를 보존하는 Rust 타입형
읽기 전용 그리드 결과를 노출한다. 트랜잭션 정책을 복제하지 않고 카탈로그 도구와
스트리밍/메타데이터 예산·강제 읽기 전용 연결 범위를 공유하며 엄격한 카탈로그 값
의미는 유지한다. 타입형 API 누락 컴파일 Red는 실제 세 DB에서 Green이며 구현 후
예산·변경 정책·빈 메타데이터·bind 회귀도 통과했다. 소유 통합 테스트 12개·CLI
11개·라이브러리 5개가 통과했다. 추가 조회 타입·다른 client의 그리드 API는
미완료이며 전체 SQL 그리드 완료를 주장하지 않는다.

방언 AST 검증과 DB가 강제하는 읽기 전용 범위 및 drop 시 폐기되는 별도 연결로
제한된 카탈로그 조회를 추가한다. 쓰기 CTE·변경/트랜잭션 문장·SELECT INTO·
잠금·실행 주석을 거부하며 SQL 원문을 유지하고 미지원 문법은 명시적으로 실패한다.
SQL/파서/방문 깊이를 제한한다. PostgreSQL·SQLite 읽기 전용 상태와 MySQL 함수
내부 쓰기 거부·행 보존·오류 뒤 재실행을 검증했다. 이벤트 기반 중단 범위 사례로
세 DB의 연결 풀 재사용 금지를 확인했으며 취소 지연 측정이나 외부 함수 샌드박스는
아니다. API 누락 컴파일 Red는 Green이고 소유 통합 테스트 11개·정책/해제 단위
회귀 2개·CLI 11개가 통과했다. 초기 MySQL 세션 변수 검증의 잘못된 가정을
수정했으며 서버 설정은 변경하지 않았다. 추가 SQL 결과 타입은 남아 있다.

제한된 조회 행과 함께 순서 있는 prepared 컬럼명/네이티브 타입명을 노출하며
빈 결과와 중복 별칭도 보존한다. 카탈로그 연결도 같은 공개 조회를 제공한다.
메타데이터는 2,048컬럼·이름/타입 64KiB로 제한하고 값을 로그에 남기지 않는다.
결과 API 누락 컴파일 Red는 Green이다. 세 DB 조회 사례를 포함한 소유 통합
테스트 10개·메타데이터 예산 단위 사례 1개·CLI 11개가 통과했다. 메타데이터
예산 테스트는 구현 후 회귀 검증이며 수정 전 Red가 아니다. 읽기 전용 실행
정책·추가 SQL 타입·조회 UI는 미완료이며 호출자가 승인한 문장만 실행하는 API다.

Rust 도구/카탈로그 조회는 드라이버 스트림에서 행을 누적하며 행/JSON 결과
예산을 검증한다(상한 100,000행·64MiB). 한도 초과는 일부 성공이나 값 노출
없이 거부하고 여러 문장은 결과 집합을 합치지 않고 거부한다. MySQL prepared
결과의 unsigned 검증을 보존한다. 변경 중 기존 오버플로 테스트가 회귀를
발견했고 타입 기반 디코딩 수정 후 Green이다. 예산 API 누락 컴파일 Red와
여러 문장 런타임 Red는 Green이다. 조회/카탈로그/접근자 소유 테스트 9개와
CLI 테스트 11개가 통과하며 예산·연결 재사용·스칼라 검증은 세 DB에서 실행한다.
누적 결과 제한이며 드라이버 패킷이나 DB 실행 제한은 아니다. 임의 SQL 타입·
읽기 전용 격리·쿼리 UI는 별도 작업으로 남아 있다.

Rust 도구의 정수·선택적 정수·boolean 변환이 0/false 기본값 대신 검증된
결과를 반환한다. 선택적 SQL NULL은 보존하고 잘못된 필수 값은 내용 노출
없이 거부한다. 트랜잭션 정리를 유지하면서 카탈로그·마이그레이션 읽기 오류를
전달한다. Result API 누락 컴파일 Red가 Green이며 접근자 테스트 2개(세 DB
포함), 카탈로그 4개, 셀 1개, CLI 회귀 5개가 통과했다. 잘못된 SQLite 이력은
거부 후에도 유지되며 MySQL·PostgreSQL·SQLite 계획/적용/롤백/복구가 통과했다.

Rust 도구/카탈로그의 미지원 셀, 잘못된 UTF-8, unsigned 정수 오버플로를
NULL·대체 문자열·순환 정수로 바꾸지 않고 거부한다. 셀 값을 포함하지 않는
디코딩 오류를 전달한다. 수정 전 실패한 손실 사례 7개가 수정 후 SQLite,
MySQL, PostgreSQL에서 통과했으며 카탈로그 소유 테스트 4개와 SQLite CLI
rowid 사례도 통과했다. 숫자·boolean 접근자 검증은 별도 대기 항목이다.

`live-db`로 Rust DSN 전용 카탈로그 연결을 공개하고 기존 읽기 구현을 라이브러리로
옮겨 CLI와 공유한다. 없는 SQLite DB 파일을 생성하지 않고 거부하며 풀 종료 전에
예약 연결을 해제한다. API 누락·SQLite 파일 생성 Red를 Green으로 수정했다.
공개 API 소유 테스트 4개가 SQLite·MySQL·PostgreSQL에서 실행됐고 기존 SQLite CLI
자동 rowid 임포트 사례가 통과했다. 무손실 물리 임포트와 검증된 임의 셀 디코딩은 미완료다.

Rust ORM의 엔진 선택, 스키마 검증·설치, 트랜잭션 옵션, 취소, 암호화 열과 감사
지시어 대응을 문서화한다.

Rust 스타일 값 모델 JSON 테스트가 정렬된 JSON 멤버와 숫자 텍스트를 유지하면서 명시적인
값 래퍼를 검사하도록 갱신한다.

Rust 문장이나 트랜잭션 Future가 폐기되면 확인된 연결을 즉시 닫는다. 중단된
트랜잭션을 롤백하고 실행 중인 서버 작업을 풀에 반환하지 않으면서 1슬롯 풀 연결을
해제한다. Rust zone 테스트가 SQLite, MySQL, PostgreSQL에서 이를 검증한다.


Rust `Db::transaction_once`를 추가해 한 번 실행하는 콜백의 자체 오류형을 반환한다. 활성
트랜잭션 안에서는 savepoint를 사용하고 콜백과 롤백이 함께 실패하면 두 실패를 모두 보고한다.
데이터베이스 오류와 콜백 오류를 구별한다.

### MySQL CHECK constraint namespace

지속 적용할 개발 규칙은 `AGENTS.md`에 두고 구체 작업은 프로젝트 체크리스트에 둔다. 체크리스트 검사는 번호 없는 정책·상태 서술을 거부하므로 날짜가 고정된 진행 주장으로 항목 상태와 실행 증거를 대신할 수 없다. 대기 중인 생성 인터페이스 검사는 각 공개 클라이언트 API에서 `multi_statement`가 제외됐는지 검증해야 한다.

Go(`PoolIdleSize`, `PoolLifetimeMs`), TypeScript(`poolIdleSize`, `poolLifetimeMs`), Rust(`pool_idle_size`, `pool_lifetime_ms`) 클라이언트에 풀의 최대 유휴 연결 수 `poolIdleSize`와 풀 연결의 수명(밀리초) `poolLifetimeMs` 연결 옵션을 추가한다. 풀이 이미 `poolIdleSize`개의 유휴 연결을 유지하는 동안 반환된 연결은 닫히고, 수명이 지난 연결은 유휴 상태일 때 또는 반환될 때 닫힌다. 0이거나 지정하지 않으면 이전 동작을 유지한다. 풀 크기까지 유휴 연결을 유지하고, Go와 TypeScript는 수명이 없으며, Rust는 풀의 30분 수명을 유지한다. 음수나 풀 크기보다 큰 유휴 연결 수는 `CONFIG`를 반환한다. PHP 클라이언트에는 풀이 없으며 두 옵션 중 하나라도 0이 아니면 `CONFIG`를 반환한다.

읽기 전용 서버나 연결이 거부한 쓰기에 대한 오류 코드 `READ_ONLY`를 추가한다. PostgreSQL SQLSTATE 25006, MySQL 오류 1290과 1792, SQLite `SQLITE_READONLY`(8)와 그 확장 코드가 해당한다. Go, PHP, Rust, TypeScript 클라이언트는 매핑되지 않은 드라이버 오류 대신 드라이버 메시지와 함께 `READ_ONLY`를 반환한다. 데이터베이스 테스트는 PostgreSQL standby와 MySQL 읽기 전용 replica를 통한 쓰기, 그리고 프로세스가 읽기만 할 수 있는 SQLite 데이터베이스 파일에 대한 쓰기에서 이 코드를 검사한다.

Go·TypeScript·Rust 클라이언트에서 pool size가 0이거나 지정하지 않으면 최대 10개의 연결을 연다. Go 클라이언트는 연결 수에 제한이 없었고, TypeScript `{ poolSize: 0 }`은 MySQL에서 제한 없이 연결을 열었으며, Rust `Db::connect(dsn, 0, config)`는 panic했다. 테스트는 크기 2인 풀에서 트랜잭션 여섯 개를 동시에 실행하고, 동시에 실행되는 트랜잭션과 열린 연결이 각각 최대 두 개인지 검사한다.

`docs/config.md`에 primary와 replica를 쓰는 방법을 기술한다. 서버마다 연결을 하나씩 열고 모델이나 행마다 `connect`로 선택하며, ORM은 문을 분배하지 않고, SQLite는 단일 노드 전용이다. 네 클라이언트의 데이터베이스 테스트는 MySQL과 PostgreSQL에서 primary 연결과 replica 연결을 함께 열고, replica가 commit된 행을 읽고 쓰기를 거부하며, primary에 연결한 모델이나 primary 트랜잭션 안의 모델이 replica를 쓰지 않는지 검사한다.

네 클라이언트가 transaction 모드의 PgBouncer를 통해 동작한다. PHP와 Rust 클라이언트는 `statementTimeoutMs`의 PostgreSQL `statement_timeout`을 Go·TypeScript처럼 startup 매개변수로 전달한다. 이전의 `SET SESSION statement_timeout`은 pool의 서버 연결에 남아 다른 클라이언트 연결의 문까지 제한했다. Rust 클라이언트는 PgBouncer가 거부하던 startup 매개변수 `extra_float_digits`를 더 이상 보내지 않으며, float8 값은 그대로 정확하다. TypeScript 클라이언트는 PostgreSQL 문을 `pg_cancel_backend` 대신 프로토콜 취소 요청(process id와 secret key)으로 취소한다. pooler 뒤에서는 그 process id가 서버 프로세스가 아니기 때문이다. `make check`에 포함된 `make client-pooler-check`는 클라이언트 데이터베이스 테스트를 PgBouncer와 ProxySQL을 통해 실행하고, `docs/config.md`는 pooler 설정과 스키마 도구가 primary에 직접 연결한다는 점을 기술한다.

`make test-servers`는 primary의 읽기 전용 MySQL replica와 PostgreSQL standby, MySQL primary 앞의 ProxySQL, PostgreSQL primary 앞의 transaction 모드 PgBouncer도 `TEST_MYSQL_REPLICA_PORT`(33181), `TEST_POSTGRES_REPLICA_PORT`(55481), `TEST_PROXYSQL_PORT`(33182), `TEST_PGBOUNCER_PORT`(55482)에서 시작한다. 시작은 ProxySQL과 PgBouncer가 listen한 뒤 쓰는 로그 줄을 기록한 다음에 반환한다. 환경 파일에는 `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TEST_PGBOUNCER_SINGLE_DSN`이 추가된다. 마지막 변수는 서버 연결 하나로 `orm_test`에 접속하는 PgBouncer 데이터베이스를 가리킨다.
Go·PHP·Rust·TypeScript 클라이언트의 SQLite 쓰기 트랜잭션을 `BEGIN IMMEDIATE`로 시작해 시작 시점부터 쓰기 잠금을 갖게 한다. 읽기 전용 트랜잭션은 `BEGIN`으로 시작한다. 모든 SQLite 연결은 잠금을 최대 5000밀리초 기다리며, 네 클라이언트 모두 DSN 매개변수 `_pragma=busy_timeout(ms)`로 다른 시간을 정한다. 이전에는 DSN이 정하지 않으면 Go와 TypeScript 클라이언트가 잠금을 기다리지 않았다. 대기가 끝날 때까지 다른 연결이 놓지 않은 잠금은 `DEADLOCK` 대신 `CANCELED`를 반환하므로, 트랜잭션은 대기 뒤에 다시 실행되지 않는다. SQLite `LOCKED`는 계속 `DEADLOCK`이다. 읽은 뒤에 쓰는 트랜잭션은 다른 연결이 동시에 쓰면 `DEADLOCK`으로 실패했다. Go 프로세스 하나의 연결 8개는 재시도 없이 이런 트랜잭션 80개 중 20개만 커밋했고, 변경 뒤에는 각 클라이언트의 여러 연결과 여러 프로세스가 모두 커밋한다. PHP 클라이언트는 이전에 무시하던 SQLite DSN의 `_pragma=name(value)` 매개변수를 실행하며, 모든 클라이언트는 `_txlock`을 `CONFIG`로 거부한다. TypeScript 클라이언트는 다른 클라이언트처럼 NOWAIT 행 잠금의 대기 시간을 0으로 둔다. Go 행 잠금은 `SQLITE_BUSY`를 반환한 문을 더 이상 반복하지 않는다.

Go `ormgen`과 PHP·TypeScript `orm-gen`의 `build`와 `gen`, Rust `orm-gen`의 `build`에 `--check`를 추가한다. 이 명령은 출력을 생성하되 쓰지 않고, 출력 파일마다 `differs: <path>`, `missing: <path>`, `extra: <path>`를 경로 순서로 출력하며, 한 줄이라도 출력하면 상태 1로 종료한다. `extra`는 출력 디렉터리에서 생성 코드 주석을 가지고 있지만 생성이 더 이상 쓰지 않는 파일이다. Go `gen --check`는 `gen`과 같은 scan을 시스템 임시 디렉터리 아래의 디렉터리에서 실행하고 그 결과를 `--out`과 비교한다.

필수 컬럼(NOT NULL, 기본값 없음, `auto` 아님, AES 키 버전 아님)을 생략한 삽입은 Go, PHP, Rust, TypeScript 클라이언트에서 MySQL·PostgreSQL·SQLite 모두 문장을 실행하기 전에 `IR_INVALID: required column <entity>.<column> is not set`으로 실패한다. MySQL은 생략한 NOT NULL `enum` 컬럼에 첫 번째 값을 저장했고 PostgreSQL과 SQLite는 각자의 드라이버 오류를 반환했다. 벤치 스키마는 NOT NULL `enum` 컬럼을 가진 엔터티 `task`를 추가하고, conformance 벡터 `required_columns`는 생략한 `enum` 컬럼과 생략한 텍스트 컬럼의 오류를 기록한다.

Go, PHP, Rust, TypeScript 도구의 스키마 diff, `validate`, migration 검증은 PostgreSQL `enum` 컬럼과 라이브 텍스트 컬럼을 같다고 비교한다. `enum` 컬럼이 있는 스키마의 migration은 PostgreSQL에서 `MIGRATION_VERIFY_FAILED`로 검증에 실패했다.

`make test-servers`와 `make test-servers-stop`을 추가한다. `make test-servers`는 `.runtime/servers` 아래에서 MySQL 8.4와 PostgreSQL 17을 127.0.0.1의 TCP 포트로 시작하고, `orm_test`, `orm_tools`, `orm_bench` 데이터베이스를 만들고, MySQL·PostgreSQL·SQLite 벤치 데이터베이스를 시드하고, 환경 파일 `.runtime/servers/env`를 쓴다. 두 번째 시작은 파일 내용을 출력하고 아무것도 바꾸지 않는다. `make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `conformance-check`, `db-test`, `perf-check`는 이 파일을 읽고 파일이 없으면 실패한다. `make db-test`는 `ORM_TOOLS_MYSQL_DSN`과 `ORM_TOOLS_POSTGRES_DSN`이 가리키는 데이터베이스에서 물리 migration 테스트를 실행하며 컨테이너를 시작하지 않는다. `tests/compose.yaml`은 삭제한다. conformance 검사와 실행기는 DSN이 필요하며 로컬 소켓에 연결하지 않는다. PHP, Rust, TypeScript 실행기는 `--dsn`만 받는다.

Go·PHP hot-path 검사는 준비 작업 100쌍 뒤 순서를 번갈아 측정한 1,000쌍의 쌍별 client/native 비율 중앙값을 바뀌지 않은 한도(1.35, 1.25)와 비교하고, CPU마다 바쁜 프로세스 하나를 함께 실행한 상태로 한 번 더 실행한다(`TestHotPathGateUnderLoad`, `ORM_PERF_CPU_LOAD=1`). `make perf-check`가 두 실행을 모두 수행한다.

Go 클라이언트가 행을 읽을 때의 할당을 줄인다. 행 모델은 빌더로 쓰기 전까지 문장 빌더를 갖지 않고, 행 core와 행 상태는 결과마다 한 블록으로 할당하며, 불러온 키 값은 map 대신 slice로 저장하고, MySQL 드라이버가 datetime 셀을 연결 시간대로 읽으므로 클라이언트가 다시 변환하지 않는다. 벤치의 100행 목록은 쿼리당 358,386 B와 객체 5,233개 대신 270,611 B와 객체 4,336개를 할당하며 결과는 같다.

Rust `orm-gen` 명령 테스트는 `ORM_TOOLS_MYSQL_DSN` 또는 `ORM_TOOLS_POSTGRES_DSN`이 없으면 그 데이터베이스를 빼지 않고 실패한다.

모델의 JSON 출력은 Go 클라이언트처럼 각 ordered-json 값을 저장한 텍스트로 쓰며 멤버 순서와 숫자 텍스트를 바꾸지 않는다. PHP는 `Model::toJson()`과 `Collection::toJson()`을 추가하고, ordered-json 값을 가진 행의 `json_encode`는 `CODEC_ENCODE`로 실패한다. TypeScript의 모델·컬렉션 `JSON.stringify`는 `JSON.rawJSON`으로 저장한 텍스트를 쓰고 JavaScript가 멤버 키 순서를 바꾸면 `CODEC_ENCODE`로 실패하며, `toJSONText()`는 모든 경우에 정확한 텍스트를 쓴다. Rust는 모델과 컬렉션에 `to_json()`을 추가하고 serde 직렬화는 같은 텍스트를 serde_json raw value로 쓴다.

Go·PHP hot-path 검사와 Go bench는 `ORM_BENCH_MYSQL_DSN`이 없으면 로컬 소켓에 연결하지 않고 실패한다. Go 클라이언트 테스트 `TestAuditLargeTextChangeStaysWithinBudget`, `TestPoolSize`, `TestStatementTimeout`은 `ORM_TEST_MYSQL_DSN` 또는 `ORM_TEST_POSTGRES_DSN`이 없으면 그 데이터베이스를 빼지 않고 실패한다.

Rust 배열 출력은 프로세스를 멈추지 않고 오류를 반환한다. 모델과 컬렉션의 `to_array`, `Val::to_json`, 첨부 값 getter는 `orm::Result`를 반환하고, 숫자 `1e400`처럼 serde_json이 표현할 수 없는 값은 `CODEC_ENCODE`를 반환한다. 모델의 serde 직렬화는 같은 오류를 serializer로 보고한다.

`make rust-fmt-check`를 추가한다. 이 target은 `clients/rust/rustfmt.toml`로 Rust workspace에 `cargo fmt --all --check`를 실행하며, `make check`와 CI가 실행한다.

Go, PHP, Rust, TypeScript 클라이언트에서 키 목록과 버전만 설정하면 AES 쓰기는 현재 버전의 키 `AESKeys[AESVersion]`로 암호화한다. 이전에는 이 쓰기가 `secret aes not configured`로 실패했다. 설정한 `AESKey`가 `AESKeys[AESVersion]`과 다르면 연결이 `CONFIG`로 실패한다.

PHP, Rust, TypeScript 클라이언트는 Go 클라이언트처럼 `jsontext`와 `json aes` 컬럼을 포함한 `json`·`jsons` 단계의 ordered-json 값을 반환한다. PHP는 `OrderedJson\Value`, Rust는 `orm::ordered_json::Value`, TypeScript는 `ordered-json`의 `Value`를 반환한다. 이 값은 멤버 순서, 숫자 텍스트, 빈 객체와 빈 배열의 구분을 유지한다. 쓰기는 이 값을 받아 텍스트를 그대로 저장한다. PHP와 TypeScript는 공통 값 모델도 받고, Rust 생성 setter는 ordered-json 값만 받는다. `toArray`는 이 값을 유지하고 모델의 JSON 출력은 decode한 값을 쓴다. 유한하지 않은 수처럼 JSON 모델 밖의 값은 `CODEC_ENCODE`로 실패한다.

Go 생성기의 scan은 호출 인자의 타입이 확정되지 않아도 호출한 모델 메서드를 생성한다. 예를 들어 다른 모델 패키지에 아직 없는 메서드로 계산한 값이 이런 인자다. 여러 모델 패키지에 대한 `go generate` 한 번으로 각 패키지의 최종 모델을 쓰며, join과 relation 인자는 여전히 생성하는 패키지의 모델로 확정되어야 한다.

PHP, Rust, TypeScript 클라이언트의 `get`과 생성된 `getBy…` 종결 메서드는 일치하는 행이 없으면 `null`이나 `None`을 반환하지 않고 Go 클라이언트처럼 `NO_ROWS`로 실패한다. PHP `get()`은 `static`, TypeScript `get()`은 `Promise<this>`, Rust `get()`은 `orm::Result<Self>`를 반환한다. conformance 벡터 `terminal_by`, `write_cycle`, `delete_recursive`는 없는 행의 `NO_ROWS` 코드를 기록한다.

PHP, Rust, TypeScript 스키마 생성기가 Go 생성기와 같은 MySQL DDL을 출력한다. CHECK 제약 이름은 `ck_<table>_<name>`, CHECK 표현식은 `(expr) <> 0` 형식, boolean 기본값은 MySQL과 SQLite에서 `0`/`1`, PostgreSQL에서 `false`/`true`이며, 제약·인덱스 이름은 MySQL 64바이트, PostgreSQL 63바이트를 넘으면 SHA-256 접미사를 붙여 줄인다. 네 생성기의 MySQL import는 `ck_<table>_` 접두어를 제거해 선언한 check 이름을 반환하므로 CHECK 제약을 가진 MySQL 테이블이 바뀌지 않았으면 diff가 없다.

암호화한 JSON 값을 추가한다. `longblob config "json aes"`처럼 `json aes` 단계를 가진 blob 컬럼은 값의 ordered-json 텍스트를 AES v2와 행의 `aes_key_version`으로 암호화해 저장한다. Go, PHP, Rust, TypeScript 클라이언트는 SQLite, MySQL, PostgreSQL에서 이 값을 쓰고, 읽고, 갱신하고, 키를 교체한다. Go는 멤버 순서와 숫자 텍스트를 유지한 ordered-json 값을 반환하고, PHP, Rust, TypeScript는 `json` 컬럼과 같은 JSON 값 모델을 반환한다. `aes` 단계는 다른 단계 뒤에 올 수 있고, `jsontext` 컬럼은 `json`·`jsons`가 아닌 단계를 거부한다. 감사 변경 행은 모든 AES 컬럼을 암호문 대신 `{"redacted": true, "present": true}`로 기록한다. PHP, Rust, TypeScript 스키마 빌더도 Go 빌더처럼 감사 `service=` 옵션을 읽는다.

모든 스키마 생성기가 MySQL `enum(a_b)` 컬럼을 `enum('a','b')`로 출력한다. 따옴표 없는 값 목록은 MySQL이 거부했다. PostgreSQL 감사 트리거는 `service` 컬럼 값을 그 컬럼의 타입 그대로, `service=`가 없는 엔티티는 NULL로 넣으므로 정수 service 컬럼을 가진 변경 테이블도 변경 행을 받는다.

Go, PHP, Rust, TypeScript 클라이언트에서 PostgreSQL `schema().empty()`가 `public`, `information_schema`, `pg_` 스키마가 아닌 스키마를 객체 유무와 관계없이 내용으로 판정하도록 한다. 빈 스키마만 있는 데이터베이스는 더 이상 비어 있다고 보고되지 않는다. `public`의 테이블, 파티션 테이블, 뷰, 구체화된 뷰, 외부 테이블은 계속 내용이며 MySQL과 SQLite의 의미는 바뀌지 않는다. Rust `integration` 테스트도 다른 클라이언트 테스트처럼 `ORM_TEST_MYSQL_DSN` 또는 `ORM_TEST_POSTGRES_DSN`이 없으면 SQLite만 실행하지 않고 실패한다.

`ormgen gen --lang go`가 scan 회차마다 출력 디렉터리 옆의 임시 디렉터리에 파일을 쓰고 scan은 package overlay로 그 파일을 읽으며, scan이 수렴한 뒤에만 출력 디렉터리의 생성 파일을 교체하도록 한다. 잘못된 체인 호출, 수렴하지 않는 scan, 로드할 수 없는 scan 대상 패키지, 컴파일되지 않는 생성 코드를 포함한 생성 실패는 출력 디렉터리를 바이트 단위로 그대로 두고 상태 1로 종료한다. scan한 패키지가 다른 이유로 컴파일되지 않으면 출력 디렉터리에 완전한 모델을 남기고 상태 3으로 종료한다.

Go generator scan의 receiver 해석을 바로잡는다. relation collection의 `Len`처럼 `Get` 메서드의 결과에 호출한 메서드는 model 메서드로 요청하지 않고, model 생성자와 이름이 같지만 다른 package에 속한 호출은 model 체인을 시작하지 않으며, 출력 package의 직접 작성한 파일은 테스트를 포함해 scan하고 생성된 파일은 scan하지 않는다.

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

- 모든 클라이언트가 SQL을 조립한다. PHP, Rust, TypeScript는 호출한 프로세스 안에서 요청을 검증하고, 문장을 계획하고, MySQL·PostgreSQL·SQLite 방언과 스키마 DDL을 출력한다. Go 클라이언트는 엔진 패키지를 직접 호출한다. 네 클라이언트는 conformance 벡터에서 같은 문장, bind, 결과를 만든다. 모든 클라이언트에서 `utils().schema().install()`이 세 데이터베이스에 동작한다.

- 언어마다 모델 생성기 하나를 제공한다. Go는 `go generate`용 `ormgen gen --lang go`, PHP는 `vendor/bin/orm-gen`, TypeScript는 빌드에서 쓰는 `orm-gen` npm bin, Rust는 `build.rs`에서 쓰는 `orm-build` crate와 `orm::models!()`를 사용한다. TypeScript와 Rust는 읽은 소스가 호출하는 체인 메서드를 생성한다. 연결은 `model.Connect(dsn, schemaPath, config)`(Go), `Orm::connect(dsn, new Config(schemaPath: …))`(PHP), `Db.connect(dsn, schemaPath, options)`(TypeScript), `Db::connect(dsn, pool_size, config)`(Rust)다.

- 컴파일러 서비스, 클라이언트 전송과 브리지, WASM·FFI 엔진 진입점, 서비스 배포 유닛을 제거했다. ORM 도입에는 클라이언트 라이브러리만 필요하다.

- 연결 시간대를 고쳤다. PostgreSQL은 고정 오프셋 `timezone`을 POSIX 형식으로 받고, PostgreSQL에서 읽은 datetime 값은 연결 시간대로 표시하고, SQLite insert는 `=now` 컬럼에 연결 시간대의 실행기 시각을 쓰고, 서버 시간대 테이블이 없는 MySQL 명칭 시간대는 `CONFIG`를 반환한다.

- keyset 페이지, 관계 존재·개수 조건, tenant scope, `having`, `distinct`, 원시 요청, `min`/`max`/`countDistinct` 집계, `like`·`startsWith`·`endsWith` 연산자, 요청 debug 출력, `predicate`·`scope`·`many_to_many` 스키마 지시어를 제거했다. `CURSOR_INVALID` 오류 코드를 제거했다.

- 스키마 검증에 모델 문법의 예약 명칭 규칙을 적용하고 `key`, `order` 같은 SQL 키워드를 테이블과 컬럼 명칭으로 허용한다. `filepart` 코덱, Go 설정 파일 로더, `ormgen check`와 `ormgen precompile` 명령을 제거했다. 스키마, 프로토콜, 설정, dialect, 코덱, 패키징 문서를 현재 설계로 다시 작성하고 보관용 설계 페이지를 제거했다.

- Go 클라이언트를 모델 문법으로 다시 작성했다: `Connect`를 갖는 `model.<Entity>()` 모델, `ormgen gen --scan`으로 지정한 패키지의 호출에서 생성하는 체인 메서드, savepoint와 함수형 옵션을 갖는 goroutine 범위 콜백 트랜잭션, `Utils()`, `GetsPage`, `Creates`, `GetQuery`, `New<Name>`, 다른 연결의 관계, DSN `timezone` 매개변수의 연결 시간대. 컴파일러에 바인드 값을 받는 원시 컬럼 표현식, 대소문자를 구분하는 포함 검색, 여러 행 insert를 추가하고 `{column}` 경로를 SQL 문장의 루트 기준으로 해석한다. conformance 벡터를 모델 문법으로 바꾸고 MySQL, PostgreSQL, SQLite 기대값을 기록했다.

- 명시 키 join·relation, join 자식 조건 그룹, 컬럼·값 함수, 다중 컬럼 목록 조건, 서브쿼리, 무작위 정렬을 컴파일러 프로토콜과 Go·PHP·Rust·TypeScript IR 브리지로 전달한다. `make proto-check`는 공통 질의 형태를 네 브리지로 컴파일하고 plan을 비교한다.

- MySQL·PostgreSQL·SQLite용으로 명시적 키 조인과 관계, 조인 자식 조건 묶음, 컬럼 함수와 값 함수, 여러 컬럼 목록 조건, 서브쿼리 조건과 컬럼, 원시 조각의 `{column}` 참조, 무작위 정렬을 컴파일한다. `FUNCTION_UNKNOWN` 오류 코드를 추가했다.

- 공통 인터페이스를 `connect` 모델, 격리 수준·읽기 전용·timeout·재시도 옵션을 가진 콜백 트랜잭션, 실행 흐름 단위 savepoint, 트랜잭션 안의 행 잠금, `connection.utils()` 작업 기준으로 다시 작성했다. 공개 begin/commit/rollback, 트랜잭션 원시 SQL, 명시적 savepoint 호출, 권한 보조 기능을 제거했다.

- 복잡한 쿼리 예를 정의된 문법으로 다시 작성했다. 설정한 조인 자식, 조인 모델 묶음, ORM 함수 값, `getsPage`를 사용한다.

- ORM 함수 값을 정의했다. 값 함수 `now`, `today`, `…Ago`, `…Later`와 컬럼 함수 `dayOfWeek`, `year`, `month`, `date`, `distance`, `pointX`, `pointY`의 MySQL·PostgreSQL·SQLite 출력 형태를 포함한다. 비교 값은 메서드의 두 번째 인자다. SQLite 최소 버전을 3.46으로 올리고 SQLite decimal 차이를 문서에 기록했다.

- 관계 결과 명칭(`get<Table>Model(s)`, `alias<Name>`이면 `get<Name>`)을 정의하고 컬럼, 추가 컬럼, 관계 결과, `new<Name>` 값 사이의 명칭 중복을 거부한다.

- `new<Name>`을 컬럼이 아닌 명칭으로 추가하고 getter, `toArray()`, JSON 출력에는 포함하지만 SQL에는 사용하지 않는 값으로 정의했다. 실제 컬럼 명칭의 `new<Name>`을 거부하고 `orderByRandom()`을 추가했다.

- DSL 규칙을 정의했다. 자식 `on(fn)`의 조인 `ON` 조건, `and(model)`/`or(model)` 조인 모델 조건 묶음, `getsPage`, `getQuery`, 서브쿼리로 쓰는 실행하지 않은 모델, `{column}`을 사용하는 원시 형태, `<ColA><Op><ColB>(model)` 컬럼 비교, `creates`, `tuple<ColA>With<ColB>`, ORM 함수 값, 컬럼 명칭 금지 조각, `filepart_serialize` 제거를 포함한다.

- 가이드, README, 문서 첫 화면을 모델 문법으로 갱신했다. `connect`를 사용하는 모델 생성, 접두어 없는 첫 조건, `and`/`or` 연결자와 묶음, `match<L>With<R>` 관계 키, `create`/`update(true)`/`delete(true)` 쓰기, `connect` 없이 쓰는 콜백 트랜잭션을 설명한다.

- DSL 명세를 모델 문법으로 다시 작성했다. `connect` 연결, 접두어 없는 첫 조건, `and`/`or` 연결자와 묶음, 연산자 접두어를 포함한 체인 문법, 값 하나·목록·null 값 형태, 길이 2 고정 `Between` 배열, 조회, 컬럼, 관계, 조인, 쓰기, 트랜잭션, 예약 명칭을 정의한다.

- 초기 설계, 수정 설계, DSL v3 기록을 하나의 설계 계획(`docs/plan.md`)으로 대체했다. 이 계획은 Go·PHP·Rust·TypeScript의 모델 문법과 규칙, 작업 순서를 정의한다.

- 제한된 PostgreSQL integration orchestration을 위한 ORM 소유 `DB.BackendWaitingForLock` inspection API를 추가했다. PostgreSQL이 아닌 adapter는 driver-specific 경로를 노출하지 않고 `false`를 반환한다.

- `github.com/polyspec/orm/generator`를 통해 Go·PHP·Rust·TypeScript용 정본 schema client 생성기를 공개한다.
- Go client 생성에서 명시적 package 이름을 선택할 수 있게 하며 기본값 `gen`은 유지한다.

- `Tx.InstallSchema(context.Context, []byte) error`를 ORM이 소유하는 정본 스키마 설치 호출로 정의한다. 그 호출은 SQL이나 dialect별 DDL을 받지 않는다.

- SQLite transaction의 `readOnly`와 isolation option을 거부하지 않고 ORM이 소유한 connection pragma로 적용한다. `Tx.ReadOnly`와 `Tx.Isolation`에서 논리 mode를 노출하고 transaction 종료 전에 connection 상태를 복원하며 read-only 쓰기 거부와 이후 connection 재사용을 검증한다.
- transaction 시작 시 생성되는 ORM 소유 SQLite lock table을 database-empty 검사에서 제외해 새 database가 사용자 소유로 잘못 판정되지 않게 한다.

- 직렬화·`NoWait`·transaction release 검증과 함께 제한된 SQLite ORM lock-cancellation regression을 추가한다. 대기 중인 lock 요청이 무제한 대기 없이 caller context cancellation을 반환한다는 근거를 추적한다.


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
