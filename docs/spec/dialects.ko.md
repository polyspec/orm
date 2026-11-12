<!-- doc-id: dialects -->
<!-- source-sha256: 137f43bbe95a71112490ff7107da5ce8f23dea0690719063ba5bcfe888914382 -->
# SQL dialect

SQL dialect는 하나의 데이터베이스 시스템이 사용하는 SQL 문법과 실행 규칙이다. 이 프로젝트에서 `mysql`, `postgres`, `sqlite`는 identifier quoting, placeholder, 타입 변환, write 문법, 지원 SQL 함수를 선택한다. Planner는 database별 SQL 요소를 선택한 SQL dialect에 요청한다. IR과 plan 형식은 변경하지 않는다.

- **DIA-200** MariaDB는 `mysql` dialect의 server이며 dialect가 따로 있지 않다. Dialect는 DSN의 scheme이 고르고,
  scheme `mysql://`([config](config.ko.md))은 MySQL에 닿듯 MariaDB server에도 닿는다. Dialect는 다음 규칙을 이 순서로
  적용해 두 server의 결과를 하나로 맞춘다.
  1. `mysql` dialect는 두 server가 같은 결과로 받는 SQL 하나를 render한다. MySQL에만 있는 형식이 MariaDB에서 실패함을
     probe가 보이고, 두 server가 같은 결과로 받는 형식(예: 두 server에 모두 있고 비교가 같은 collation)이 있으면, dialect는
     두 server에서 그 형식을 render한다.
  2. 공통 형식이 없는 곳에서만 클라이언트는 연결할 때 한 번 `VERSION()`으로 server의 정체와 version을 읽고(handshake는
     읽지 않는다) 그 server의 형식을 render한다. 그런 곳은 각각 이 문서의 번호 있는 규칙이며 그것을 증명하는 probe를 적는다. 별도의
     dialect도 아니고 복사한 recipe도 아니다.
  3. MariaDB가 전혀 지닐 수 없는 동작은 MariaDB에서 [errors](errors.yaml)의 정해진 error code로 거부하며, 모든 runtime에서
     같고, 다른 결과를 낼 문보다 먼저 거부한다. 조용한 차이는 없다.
  4. server 자신의 답에 있는 차이(server error의 문구, introspect한 type 이름 등)는 그 server에서 그 case의 결과이며, recipe는
     그것을 case의 `mariadb` expect로 적는다(FCV-3).

- **DIA-201** server와 그 error 번호 — MySQL 8.4 / MariaDB 11.8 (probe `mysql.env.server`,
  `mariadb.env.server`): `mysql` dialect의 클라이언트는 연결할 때 한 번 `SELECT VERSION()`으로 server를 읽는다.
  `-MariaDB`를 담은 version은 MariaDB이고 그 밖은 MySQL이며, pool의 모든 연결은 그 pool의 server를 읽는다. 두 server는
  서로 다른 error에 같은 번호를 주므로 공통 표가 없다(DIA-200, 규칙 2). 4025는 MariaDB의 CHECK 위반(SQLSTATE 23000)이고
  MySQL에서는 범위 밖의 `AUTOEXTEND_SIZE`(HY000)이며, MySQL의 CHECK 위반은 3819다(probe
  `mysql.check.number_4025_not_a_check`, `mariadb.check.number_4025_not_a_check`). 그래서 server error 번호는 그 연결의
  server의 표([errors](errors.yaml))로 읽으며 모든 runtime에서 같다. MySQL은 3819를 `CONSTRAINT`로 바꾸고 4025는 `DRIVER`
  error로 두며, MariaDB는 4025를 `CONSTRAINT`로, statement timeout인 1969를 `CANCELED`로 바꾼다. MySQL의 idle 연결 끊김인
  4031은 MySQL에서만 `CONNECTION_LOST`다(statement runner case `a_server_error_number_is_read_by_the_table_of_its_server`).
  CHECK 위반과 거부되는 table option은 database마다 다르게 쓰므로 그 statement는 dialect마다 하나이며, MariaDB는 `mysql`의
  statement를 실행한다. MariaDB의 CHECK 위반은 4025로 `CONSTRAINT`로 읽히고, MariaDB에는 `AUTOEXTEND_SIZE`가 없어 그
  statement를 1064, 곧 `DRIVER` error로 거부하며 MySQL도 그 4025에 `DRIVER`를 주므로, dialect의 expect 하나가 두 server를
  지킨다(DIA-200, 규칙 1).

- **DIA-202** 연결의 collation — MySQL 8.4 / MariaDB 11.8 (probe `mysql.collation.literal_collate`,
  `mariadb.collation.literal_collate`): catalog 연결을 포함해 `mysql` dialect의 모든 연결은 모든 runtime에서 연결할 때
  `SET NAMES utf8mb4`를 실행하고 collation은 지정하지 않는다. 그러면 연결의 collation은 server의 utf8mb4 기본값, 곧 MySQL은
  `utf8mb4_0900_ai_ci`, MariaDB는 `utf8mb4_uca1400_ai_ci`가 된다(probe `mysql.collation.default_accent_case_insensitive`,
  `mariadb.collation.default_accent_case_insensitive`). 어떤 문장도 이 값에 기대지 않는다. renderer가 쓴 text column은 자기
  `utf8mb4_0900_bin`으로 비교하며(DIA-119, DIA-90), 그 collation이 literal이나 parameter의 collation보다 우선한다. 그런 column 없이
  text를 비교하는 SQL은 `COLLATE utf8mb4_0900_bin`을 적는다. 두 server 모두 이 한 이름을 알고(id 309, MariaDB 11.8은 자기
  `utf8mb4_nopad_bin` 옆에 이를 둔다), 그 아래에서 padding 없이 code point로 비교하며, 직접 연결과 ProxySQL을 거친 연결에서
  결과가 같다. `'a' = 'A'`, `'a' = 'a '`, `'a' = 'á'`는 거짓이고 `'B' < 'a'`는 참이다(DIA-200, 규칙 1). `SET NAMES`에
  collation을 적는 연결은 공통 형식이 아니다. ProxySQL 3.0.9는 id 307보다 큰 collation을 몰라 `SET NAMES utf8mb4 COLLATE
  utf8mb4_0900_bin`을 1115로 거부하므로 pooler lane이 연결하지 못했다. Statement runner case
  `a_text_literal_compares_by_code_point_under_the_collation_it_states`가 모든 database에서 이를 지킨다. PostgreSQL은
  `COLLATE "C"`로, SQLite는 `BINARY`로 비교하며 결과가 같다. `COLLATE utf8mb4_0900_bin`, `@@character_set_connection`,
  `@@character_set_results`는 `mysql` dialect의 것이고, PostgreSQL은 비교를 boolean으로 주어 integer로 cast하며 encoding을
  `current_setting('client_encoding')`으로, SQLite는 `pragma_encoding`으로 읽으므로 그 query는 dialect마다 하나다. MariaDB는
  `mysql`의 query를 실행해 MySQL과 같은 결과를 준다(DIA-200, 규칙 1).

- **DIA-203** introspection의 server — MySQL 8.4 / MariaDB 11.8 (probe `mysql.check.not_enforced_option`,
  `mariadb.check.not_enforced_option`, `mysql.check.name_schema_scope`, `mariadb.check.name_schema_scope`,
  `mysql.check.catalog_text`, `mariadb.check.catalog_text`, `mariadb.check.string_escaped_twice`): dbspec의
  introspection과, introspect하는 apply의 검증은 모든 runtime에서 dialect와 함께 연결이 연결할 때 읽은 server(DIA-201)를
  받으며 스스로 version을 읽지 않는다. dialect의 server가 아닌 server는 알 수 없는 dialect처럼 거부된다(DBS-174). MySQL은
  적용되지 않는 CHECK를 `TABLE_CONSTRAINTS.ENFORCED`에 적는다. MariaDB에는 `NOT ENFORCED` CHECK도 `ENFORCED` column(1054)도
  없으므로 공통 query가 없고(DIA-200, 규칙 2) MariaDB의 모든 CHECK는 적용되는 것으로 읽는다. MariaDB는 CHECK 이름의 범위를
  table로 정하므로 그 `CHECK_CLAUSE`는 table과 CHECK 이름의 쌍을 key로 읽는다. 또 `CHECK_CLAUSE`를 바깥 괄호와 introducer 없이, string
  literal에 escape를 한 번 붙인 SQL text로 쓴다. 그 text에 MySQL `CHECK_CLAUSE`의 두 번째 escape를 붙이면 한 reader가 두
  server의 clause를 읽는다(DIA-146). MariaDB의 renderer CHECK는 `` `c` in (0,1) ``, renderer의 `length`를 MariaDB가 쓰는 대로 `` octet_length(`c`) = 16 ``,
  `` `c` >= '00:00:00' and `c` < '24:00:00' ``이다(probe `mariadb.render.bool_check`, `mariadb.render.uuid_bytes`,
  `mariadb.render.time_of_day_check`; DIA-144).

- **DIA-204** 정수 display width — MySQL 8.4 / MariaDB 11.8 (probe `mysql.int.display_width_dropped`,
  `mariadb.int.display_width_dropped`): MySQL은 `smallint`, `int`, `bigint`의 `COLUMN_TYPE`을 display width 없이 쓰고
  MariaDB는 width와 함께 쓴다(`smallint(6)`, `int(11)`, `bigint(20)`). width는 값을 바꾸지 않으므로 두 server의
  introspection은 width가 있든 없든 정수 type을 같은 type으로 읽는다(DIA-200, 규칙 1). `tinyint(1)`은 두 server에서 모두
  `bool`이다. catalog 연결의 테이블 descriptor(`describeTable`)의 네이티브 타입은 두 server에서 MySQL 8.4 형식의
  `COLUMN_TYPE`이며, 모든 runtime에서 query 하나다(DIA-200, 규칙 1). MySQL 8.0.17부터 정수의 display width는 그 type의
  일부가 아니기 때문이다: 정수 type(`tinyint`, `smallint`, `mediumint`, `int`, `bigint`)은 width가 없고 `unsigned`는
  남는다(MariaDB `int(10) unsigned`는 `int unsigned`). 다만 MySQL 8.4도 width를 남기는 `tinyint(1)`과 `zerofill` type은
  예외다(`tinyint(1)`, `int(5) unsigned zerofill`). `tinyint(1) unsigned`는 두 server에서 `tinyint unsigned`이고, MariaDB
  `year(4)`는 `year`다. MariaDB `year(2)`는 MySQL 8.4 형식이 없으므로 그대로 둔다. 사례 `catalog_describe_integer_width`가
  두 server에서 이를 확인한다.

- **DIA-205** catalog의 column default — MySQL 8.4 / MariaDB 11.8 (probe `mysql.default.catalog_text`,
  `mariadb.default.catalog_text`): MySQL은 `COLUMN_DEFAULT`에 literal을 따옴표 없이, `NULL` default를 SQL `NULL`로 주고,
  `CURRENT_TIMESTAMP(p)`를 포함한 식 default에는 `EXTRA` `DEFAULT_GENERATED`를 준다. MariaDB는 `COLUMN_DEFAULT`를 SQL
  text로 쓴다. `NULL` default는 `NULL`, string과 시간 literal은 SQL escape를 붙여 따옴표로 감싸고, 숫자는 쓴 그대로, 식은
  그 text로, 시계는 `current_timestamp()`나 `current_timestamp(p)`로 쓰며, `EXTRA`에는 `DEFAULT_GENERATED`가 없다. 두 형식을
  함께 주는 query가 없으므로(DIA-200, 규칙 2) introspection은 MariaDB text를 MySQL 형식으로 읽는다. `NULL`은 default가
  없는 것이고, 따옴표로 감싼 literal은 escape를 푼 그 값이며, 숫자는 그 자신이고, 다른 text는 시계를 포함해 MySQL이 표시하는
  것과 같은 식 default다. 하나의 온전한 literal이 아닌 따옴표 text는 error다. catalog connection의 table descriptor
  (`describeTable`)도 같은 text를 같은 규칙으로 읽는다. 그 default 식은 MySQL 형식이고 `NULL`이면 없으며, 식 표시는 MySQL이
  표시하는 것과 같다. 식의 text는 그 서버의 text로 남는다. MySQL은 `(concat('a', 'b'))`를 literal마다 문자 집합을 붙이고
  따옴표를 escape해 `concat(_utf8mb4\'a\',_utf8mb4\'b\')`로, MariaDB는 `concat('a','b')`로 쓴다. recipe catalog_connection의
  case `catalog_describe_column_defaults`가 두 서버에서 각 형식을 읽는다. 하나의 온전한 literal이 아닌 따옴표 text는 어느
  서버도 쓰지 않으므로 FCV-2의 native 시험이 맡는다.

- **DIA-206** CHECK 삭제 — MySQL 8.4 / MariaDB 11.8 (probe `mysql.check.drop_constraint`,
  `mariadb.check.drop_constraint`, `mysql.check.drop_constraint_shared_name`, `mariadb.check.drop_constraint_shared_name`):
  plan은 두 server가 같은 결과로 받는 `ALTER TABLE t DROP CONSTRAINT c`로 CHECK를 지운다. MariaDB에는 `DROP CHECK`가
  없다(1064)(DIA-200, 규칙 1). MySQL은 CHECK가 그 표의 foreign key와 이름을 나누는 것을 허용하고, 그때 그 이름의
  `DROP CONSTRAINT`는 모호하다(3939). MariaDB는 나눈 이름을 거부한다(1826). 어떤 plan도 그런 표를 만나지 않는다. 문서는
  모든 check, foreign key, unique key, index의 이름을 서로 다르게 짓고(DBS-34, vector `check-and-foreign-key-share-a-name`),
  plan은 바뀌는 foreign key와 check를 무엇을 더하기 전에 지우므로(PLN-74, PLN-75, PLN-80, PLN-81), plan이 지우는 CHECK는
  그 표의 어떤 constraint와도 이름을 나누지 않는다.

- **DIA-208** Statement timeout — MySQL 8.4 / MariaDB 11.8 (probe `mysql.session.statement_timeout`,
  `mariadb.session.statement_timeout`): MySQL은 SELECT를 millisecond 단위의 `max_execution_time`으로 제한하고(3024)
  `max_statement_time`이 없다(1193). MariaDB는 `max_execution_time`이 없고(1193) 모든 statement를 초 단위의
  `max_statement_time`으로 제한한다(1969). 두 server에 모두 통하는 설정이 없으므로(DIA-200, 규칙 2), `statementTimeoutMs`
  (CFG-6)를 가진 연결은 모든 runtime에서, pool의 모든 연결에서, server를 읽은 뒤(DIA-201) 다른 statement보다 먼저 MySQL에서는
  `SESSION max_execution_time = <ms>`를, MariaDB에서는 소수 세 자리로 적은 `SESSION max_statement_time = <ms / 1000>`을
  설정한다. MariaDB가 멈춘 statement는 `CANCELED`를 돌려주므로(1969, DIA-201), MariaDB는 PostgreSQL처럼 write도 제한한다.
  recipe dsn_connection의 case `mysql_session_settings`가 각 server의 설정을 읽는다. 각 server에는 다른 server의 변수가
  없으므로(1193) 그 `session_read`는 MySQL에서 `@@SESSION.max_execution_time`을, MariaDB에서
  `CAST(@@SESSION.max_statement_time * 1000 AS SIGNED)`를 읽고, 둘 다 기대한 한 row를 준다.

- **DIA-209** Row lock — MySQL 8.4 / MariaDB 11.8 (probe `mysql.lock.share_clause`, `mariadb.lock.share_clause`,
  `mysql.lock.nowait_held`, `mariadb.lock.nowait_held`): lock `share`는 두 server가 공유 row lock으로 읽는
  ` LOCK IN SHARE MODE`로 render한다. MariaDB에는 `FOR SHARE`가 없다(1064). `update_nowait`는 두 server가 똑같이 읽는
  ` FOR UPDATE NOWAIT`로 render한다(DIA-200, 규칙 1). `share_nowait`에는 공통 형식이 없다. MySQL은 `FOR SHARE` 뒤에만,
  MariaDB는 `LOCK IN SHARE MODE` 뒤에만 NOWAIT를 받으므로(그 밖에는 1064), planner는 연결의 server에 따라(DIA-201;
  DIA-200, 규칙 2) MySQL에서는 ` FOR SHARE NOWAIT`를, MariaDB에서는 ` LOCK IN SHARE MODE NOWAIT`를 render한다. MariaDB는
  바로 잡지 못한 NOWAIT lock을 lock wait timeout의 번호인 1205로 실패시키고 MySQL은 3572를 준다. MariaDB에서 `*_nowait`
  lock의 statement가 1205로 실패하면 MySQL처럼 `LOCK_NOT_AVAILABLE`을 돌려주고(INT-49), 다른 statement의 1205는 그대로
  `CANCELED`다(CFG-6). recipe transactions의 case `nowait_lock_held_by_another_transaction`가 MySQL, MariaDB, PostgreSQL 서버에서 이를
  확인한다. SQLite는 한 번에 쓰기 transaction 하나만 받으므로 두 번째 transaction이 `BEGIN IMMEDIATE`에서 기다리고 lock에 닿지
  않아 이 case에서 빠진다(INT-49의 SQLite lock row는 `sqlite-row-lock-restoration`이 확인한다).

- **DIA-210** catalog descriptor의 primary key 순번 — MySQL 8.4 / MariaDB 11.8 (probe `mysql.catalog.key_ordinal_by_name`,
  `mariadb.catalog.key_ordinal_by_name`): MariaDB는 `information_schema` table을 그 자신의 조건에 있는 상수로만 table 이름으로
  읽으므로, `COLUMNS`의 column에 `KEY_COLUMN_USAGE`를 join하면 모든 database의 모든 table을 연다("Scanned all databases").
  case database가 있는 server에서 describe 하나에 약 1초가 걸린다. catalog connection의 descriptor는 column의 순번을 table을
  상수로 이름 짓는 subquery `COALESCE((SELECT k.ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE k WHERE
  k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.CONSTRAINT_NAME = 'PRIMARY' AND k.COLUMN_NAME = c.COLUMN_NAME), 0)`로 읽는다.
  이 subquery는 두 server에서 join과 같은 row를 주고 그 table만 읽는다(DIA-200, 규칙 1).

- **DIA-211** 거부된 연결의 수 — MySQL 8.4 / MariaDB 11.8: catalog recipe의 case
  `plain_connect_on_a_held_place_is_refused_once`는 client가 `max_user_connections`가 거부한 연결을 다시 시도하지 않는다는
  것(CFG-35)을 지키는데, 두 server는 그 거부를 공통된 형태로 세지 않는다. MySQL은 그것을 그 user의 오류 1226으로
  `performance_schema.events_errors_summary_by_user_by_error`에 기록하고 `performance_schema.users`에서 센다. MariaDB에는 오류
  요약이 없고, `performance_schema.users`는 받아들인 연결만 세며, `USER_STATISTICS`는 `DENIED_CONNECTIONS`를 0으로 두고,
  `Aborted_connects`는 global이다. MariaDB의 server_audit plugin은 거부된 연결을 `FAILED_CONNECT` 줄로 쓰지만 거부를 보낸
  뒤에야 쓰므로(`login_connection`, sql/sql_connect.cc는 `end_statement`에서 오류를 보내고 그 뒤에
  `mysql_audit_notify_connection_connect`를 부른다), 거부 직후 읽으면 11.8.6에서 run 10번 중 6번 그 줄을 놓쳤다. 그래서 수는
  server가 아니라 client의 것이다. step `catalog.reconnect {connects}`는 재연결을 server 앞에 둔 runner의 TCP listener로
  중계하고, listener는 받아들인 연결을 센다. 각 runtime은 두 server에서 같은 형태로 1을 준다(DIA-200, 규칙 1).

- **DIA-212** case database의 삭제 — MySQL 8.4 / MariaDB 11.8: MariaDB의 `DROP DATABASE`가 database의 표는 지웠지만 폴더에
  어느 표의 것도 아닌 파일(audit recipe의 한 run이 남긴 trigger 파일 `card.TRG-`)이 있어 폴더를 지우지 못하면, 1010
  "Directory not empty"로 실패하고 지운 표들을 `DROP TABLE IF EXISTS` 목록 하나로 binary log에 남긴다. 그 error code는
  0이고 session의 `foreign_key_checks`를 따른다. 검사를 켠 채 그 목록을 적용하는 replica는 foreign key의 부모를 1451로
  거부하고 SQL thread를 멈추며, 그 run의 뒤따르는 `replica.await`는 모두 실패한다. 같은 목록을
  `foreign_key_checks = 0`으로 적용하면 표가 모두 지워진다. 각 runtime의 harness는 두 server에서 case database를
  `DROP DATABASE`의 session에 `SET SESSION foreign_key_checks = 0`을 두고 지운다(DIA-200, 규칙 1). `DROP DATABASE`는
  foreign key와 상관없이 database의 표를 지우므로 성공하는 삭제는 같고, 1010으로 실패하는 삭제는 여전히 그 case를
  실패시킨다. 그 session은 삭제와 함께 끝나고 어느 pool로도 돌아가지 않으므로, harness의 뒤따르는 statement는 모두
  검사를 켠 채 실행된다. 모든 runtime에서 harness의 시험이 case database를 지운 뒤 다음 admin session에서
  `foreign_key_checks` 1을 읽으며, 두 server 모두에서 그렇다. 삭제는 자기 대기 한도를 두지 않고, 끝나지 않는 삭제는 그
  case의 deadline이 끝낸다. 그 파일은 MariaDB 자신이 남긴다. trigger가 이미 있는 표에 `CREATE TRIGGER`를 하면
  `<table>.TRG`를 crash 대비 사본 `<table>.TRG-`로 복사하고, 그 사본의 삭제를 statement의 execute entry에 묶어 DDL
  log에 적는다(`Table_triggers_list::create_trigger`, sql/sql_trigger.cc). statement가 성공하면
  `mysql_create_or_drop_trigger`는 그 entry를 먼저 놓고(`ddl_log_complete`) 그다음 삭제를 실행하는데, 삭제는 놓은
  위치의 entry가 활성이면 사본을 남긴다(`DDL_LOG_DELETE_TMP_FILE_ACTION`, sql/ddl_log.cc). 그 사이에 다른 session의
  DDL statement가 그 위치를 차지하면 사본은 그대로 남는다. 여덟 session이 각자의 database에서 표 넷의 trigger 열둘을
  만들고 database를 지우자 11.8.6에서 사본 960개 중 하나가 남았고, 그 삭제는 1010으로 실패했다. 12.2와 main의 code도
  같다. 이것은 server의 결함이고, test server는 MariaDB release를 그대로 쓴다. 11.8.6에서 각 스물다섯 database의 열여섯
  session이 사본 3200개를 만들었고, 그중 5개가 남아 삭제 5개가 1010으로 실패했다. 삭제가 1010으로 실패한 case는 그 오류로
  실패하고, 모든 runtime의 client는 같은 부하의 사용자 MariaDB에서처럼 그 오류를 server가 준 그대로 돌려준다. 그 위치는 server
  전체에 하나이므로, 사본은 어느 database에서든 다른 session의 DDL statement가 동시에 실행될 때만 남는다. 동시에 실행되는 DDL이
  없으면 사본은 남지 않는다. 11.8.6에서 한 session이 database 이백 개로 사본 1600개를 만들었고, 하나도 남지 않았다. 그래서
  모든 runtime의 recipe run은 모든 database(MySQL, MariaDB, PostgreSQL, SQLite, markdown)에서 같은 정책 하나로 case를
  한 번에 하나씩 실행한다. Go, Python, PHP는 recipe target의 case를 차례로 실행하고, 모든 TypeScript recipe target은
  파일을 `--test-concurrency=1`로 실행하며(Makefile의 `RECIPE_TS_TEST`), Rust program all과 mariadb에서 recipe의 모든
  group은 trial을 차례로 실행하는 recipe group(`Group::recipe`)이고 모든 Rust recipe target은 `--no-fail-fast`로
  실행하며(`RECIPE_RUST_TEST`), suite(scripts/suite-test.mts)는 contracts/fixtures recipe의 파일을 다른 파일 뒤에 한 번에
  하나씩 실행한다. 동시 session이나 lock 대기처럼 동시성이 주제인 case는 그 동시성을 case 안에서 만든다. 이것은 case의
  순서만 바꾸고, 빠지는 case는 없다.
  한 machine에서 여러 agent가 돌리는 run처럼 server 하나를 나누어 쓰는 run은 여전히 DDL을 동시에 실행한다. 그런 run의
  1010은 원인으로 DIA-212를 짚고, 그 case를 단독으로 다시 돌려 판정한다.

- **DIA-213** introspection 읽기의 database — MySQL 8.4 / MariaDB 11.8: MariaDB는 조건이 row가 설명하는 table의 schema
  column인 `TABLE_SCHEMA`(`TRIGGERS`에서는 `EVENT_OBJECT_SCHEMA`)를 이름 지을 때만 `information_schema` table을 한 database에서
  읽는다. `CONSTRAINT_SCHEMA`나 `TRIGGER_SCHEMA`만의 조건, 또는 `CONSTRAINT_SCHEMA`로 `KEY_COLUMN_USAGE`를 join하면 모든
  database의 모든 table을 연다. test server의 MariaDB primary에서 `EXPLAIN`은 `CONSTRAINT_SCHEMA`로 읽는 `TABLE_CONSTRAINTS`의
  check 목록, `TRIGGER_SCHEMA`로 읽는 `TRIGGERS`의 trigger 목록, foreign key join의 `KEY_COLUMN_USAGE` 쪽에 "Scanned all
  databases"를 주고, 각각 `TABLE_SCHEMA`나 `EVENT_OBJECT_SCHEMA`를 이름 지으면 "Scanned 1 database"를 준다. plan apply의
  constraint와 trigger 존재 probe는 "Scanned 1 database"에서 "Scanned 0 databases"로 바뀐다. constraint와 trigger는 그
  table의 schema에 있으므로, 모든 runtime의 introspection은 check를 `WHERE TABLE_SCHEMA = DATABASE()`로, trigger를
  `WHERE EVENT_OBJECT_SCHEMA = DATABASE()`로 읽고, `KEY_COLUMN_USAGE` join에 `k.TABLE_SCHEMA = DATABASE()`를 더하며, apply
  probe도 같은 방식으로 읽는다. check 하나, column 두 개의 foreign key 하나, trigger 하나가 있는 database에서 MySQL 8.4와
  MariaDB 11.8 모두 예전 형태와 새 형태가 같은 row를 준다(DIA-200, 규칙 1).

- **DIA-215** replica 기다리기 — MySQL 8.4 / MariaDB 11.8: harness의 step `replica.await`(CFG-23)는 primary의 binary log
  위치를 읽고 replica가 그 위치를 적용할 때까지 replica에서 기다리며, 두 부분 어느 쪽에도 두 server에 통하는 statement가
  없다. MySQL은 위치를 `SHOW BINARY LOG STATUS`로 읽는데 MariaDB는 이를 거부하고(1064), MariaDB는 `SHOW BINLOG STATUS`나
  `SHOW MASTER STATUS`로 읽는데 MySQL 8.4는 이를 거부한다(1064). MySQL은 `SOURCE_POS_WAIT`로 기다리는데 MariaDB에는 그
  함수가 없다(1305). MySQL 8.4는 MariaDB의 이름인 `MASTER_POS_WAIT`도 실행하지만 그 이름이 없어질 것이라는 warning 1287을
  함께 내므로, harness는 이를 공통 형식으로 쓰지 않는다. GTID로 기다리는 공통 형식도 없다: MySQL 시험 server는
  `gtid_mode = OFF`로 돌아 `WAIT_FOR_EXECUTED_GTID_SET`이 실패하고(3062), `MASTER_GTID_WAIT`는 MariaDB에만 있다. 그래서 모든
  runtime의 harness는 case의 database에 따라 MySQL에서 `SHOW BINARY LOG STATUS`와 `SOURCE_POS_WAIT`를, MariaDB에서
  `SHOW BINLOG STATUS`와 `MASTER_POS_WAIT`를 실행하며, 기다림과 그 기한은 두 server에서 같다.

- **DIA-1** identifiers — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.index.primary_name_reserved`): `` `x` ``; PostgreSQL 12+: `"x"`; SQLite 3.46+: `"x"`
- **DIA-2** placeholders — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.like.ascii_fold_replace`): `?`; PostgreSQL 12+: `$n` (the executor renumbers when it expands a `parent` slot to N values); SQLite 3.46+: `?`
- **DIA-3** LIMIT — MySQL 8.0.2+: `LIMIT off, n`; PostgreSQL 12+: `LIMIT n OFFSET off`; SQLite 3.46+: `LIMIT n OFFSET off`
- **DIA-4** `Lk` — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.like.ascii_fold_replace`): `F(col) LIKE F(?)`, F는 `A`–`Z` 각각을 소문자로 바꾸는 `REPLACE` 26겹: column의 `utf8mb4_0900_bin`은 code point로 비교하고, `LOWER`나 `_ci` collation은 ASCII 밖까지 접는다(probe `mysql.like.binary_collation_case_sensitive`, `mysql.like.ascii_fold_replace`); PostgreSQL 12+: `COLLATE "C"` 아래의 `ILIKE`(probe `postgres.ilike.c_collation_ascii_only`); SQLite 3.46+: `LIKE … ESCAPE '\'` (ASCII 대소문자 구분 없음, probe `sqlite.like.ascii_only`)
- **DIA-5** `Lb` — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.like.binary_collation_code_point`): `LIKE` (binary collation `utf8mb4_0900_bin`, code point로 비교한다. `LIKE BINARY`는 MySQL 8.0.27부터 deprecated다. probe `mysql.like.binary_collation_code_point`); PostgreSQL 12+: `LIKE`; SQLite 3.46+: `instr(col, ?) > 0`
- **DIA-6** `Fulltext` / `FulltextBoolean` — MySQL 8.0.2+: `MATCH … AGAINST (… IN NATURAL LANGUAGE/BOOLEAN MODE)`, boolean value normalized by the transform `fulltext_boolean` (PRT-32): split the value on whitespace and drop empty terms; remove the characters `+ - < > ( ) ~ * " @` from each term and drop a term that becomes empty; prefix every term with `+` and suffix the last term with `*`; join the terms with single spaces; a value with no term fails with `IR_INVALID`; PostgreSQL 12+: `to_tsvector('simple', coalesce(a,'') || ' ' || …) @@ plainto_tsquery / websearch_to_tsquery('simple', ?)`, 값은 그대로 bind한다. 두 함수 모두 항 주변의 공백을 건너뛰기 때문이다. boolean 값은 transform `fulltext_text`(PRT-32)로 bind한다. 이 transform은 값을 바꾸지 않고, MySQL transform의 항 기준으로 항이 없는 값을 `IR_INVALID`로 실패시킨다. 그래서 빈 boolean 검색은 두 server에서 한 답이다; SQLite 3.46+: **rejected** (FTS5 needs virtual tables)
- **DIA-7** `forceIndex<Name>` — MySQL 8.0.2+: `FORCE INDEX (name)`; PostgreSQL 12+: ignored (no hints); SQLite 3.46+: `INDEXED BY "name"`
- **DIA-8** insert id — MySQL 8.0.2+: `LAST_INSERT_ID()` (upsert adds `pk = LAST_INSERT_ID(pk)`); PostgreSQL 12+: `RETURNING pk`; SQLite 3.46+: `RETURNING pk`; 여러 행 insert(`rows`, PRT-5)는 insert id를 알리지 않으므로 `RETURNING`이 없다
- **DIA-9** `duplication(model)` — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.upsert.any_unique_key`): `ON DUPLICATE KEY UPDATE` (validator가 허용한 충돌 key 하나만 만난다. MySQL은 아무 unique key에서나 행과 만나며(`mysql.upsert.any_unique_key`), NOT NULL unique key가 먼저다(`mysql.upsert.not_null_unique_first`)); PostgreSQL 12+: `ON CONFLICT (cols) DO UPDATE SET` — 충돌 대상은 validator가 허용한 충돌 key 하나다(upsert에는 삽입 행을 만날 수 있는 key가 정확히 하나다. 다른 unique key에서 만나는 행은 unique 위반이다, `postgres.upsert.other_key_conflicts`); SQLite 3.46+: PostgreSQL과 같다(`sqlite.upsert.other_key_conflicts`). conformance vector `upsert_one_key`는 세 database에서 같은 결과를 준다
- **DIA-10** `groupLimit(n)` — MySQL 8.0.2+: `ROW_NUMBER() OVER (…)`; PostgreSQL 12+: same; SQLite 3.46+: same
- **DIA-11** `tuple<ColA>With<ColB>` — MySQL 8.0.2+: `(a, b) IN ((?, ?), …)`; PostgreSQL 12+: same; SQLite 3.46+: `(a, b) IN (VALUES (?, ?), …)`
- **DIA-12** `orderByRandom()` — MySQL 8.0.2+: `RAND()`; PostgreSQL 12+: `random()`; SQLite 3.46+: `random()`
- **DIA-13** nullable 컬럼의 `orderBy<Col>Asc()` / `Desc()` — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.order.null_first_asc`): 기본: 오름차순 NULL 먼저, 내림차순 NULL 나중 (`mysql.order.null_first_asc`); PostgreSQL 12+: `ASC NULLS FIRST` / `DESC NULLS LAST`: 이것 없이는 오름차순 NULL 나중 (`postgres.order.null_last_asc`); SQLite 3.46+: 기본: 오름차순 NULL 먼저, 내림차순 NULL 나중 (`sqlite.order.null_first_asc`)
- **DIA-14** ORM 함수 — MySQL 8.0.2+: [DSL](dsl.ko.md) 10절 참고
- **DIA-15** `aes`/`hex` styles — MySQL 8.0.2+: 실행기에서 인증된 AES-256-GCM v2 처리 후 `hex`가 있으면 hex text로 변환. 잘못된 hex text는 모든 database에서 `CODEC_DECODE`다; PostgreSQL 12+: 실행기에서 인증된 AES-256-GCM v2 처리 후 `hex`가 있으면 hex text로 변환. 잘못된 hex text는 모든 database에서 `CODEC_DECODE`다; SQLite 3.46+: 실행기에서 인증된 AES-256-GCM v2 처리 후 `hex`가 있으면 hex text로 변환. 잘못된 hex text는 모든 database에서 `CODEC_DECODE`다
- **DIA-16** `ip` style — MySQL 8.0.2+: `INET6_ATON` / `INET6_NTOA`; PostgreSQL 12+: client-side (16-byte packed, `bytea`); SQLite 3.46+: client-side (16-byte packed). SQL은 write 순서의 마지막 단계, 즉 모든 client-side 단계 뒤의 단계만 감싸므로, 한 단계는 그 column의 모든 뒤 단계도 SQL에서 실행될 때만 SQL에서 실행된다: `ip hex` column은 MySQL에서도 주소를 client에서 pack하고 unpack하며(16-byte packed 뒤 hex text), 그 placeholder는 저장되는 hex text를 받는다(planner case `planner_ip_hex_insert`와 `planner_ip_hex_select`)
- **DIA-18** update 시각과 soft delete가 쓰는 clock — MySQL 8.0.2+ / MariaDB 11.8 (`mariadb.now.precision_truncates`): `p > 0`인 `datetime(p)` column은 `CURRENT_TIMESTAMP(p)`, 그 밖에는 `CURRENT_TIMESTAMP`; PostgreSQL 12+: executor가 bind한, p로 자른 텍스트(`now` bind slot); SQLite 3.46+: executor가 bind한, p로 자른 텍스트(`now` bind slot)

- **DIA-19** Executor 결과는 PostgreSQL parent IN list 확장 후 `$n` 재번호화, client-side AES/inet codec, database별 DSN/driver 선택이다.

- **DIA-20** `github.com/polyspec/orm/packages/go`: `packages/go/orm`은 MySQL만 연결한다. PostgreSQL 또는 SQLite를 열려면 해당 package를 side effect import한다.

```go
import (
    _ "github.com/polyspec/orm/packages/go/orm/pg"      // driver "postgres"
    _ "github.com/polyspec/orm/packages/go/orm/sqlite"  // driver "sqlite"
)
```

- **DIA-21** `github.com/polyspec/orm/packages/go`: 필요한 driver package를 import하지 않으면 `orm.Connect`는 필요한 import를 이름을 기준으로 적은 `CONFIG`를 반환한다. Rust는 sqlx feature를 사용하고 PHP는 설치된 PDO extension을 사용한다.

## 세 database의 같은 결과를 유지하는 규칙
- **DIA-22** `UPDATE`는 updated timestamp를 항상 명시한다(MySQL은 `mysql.go`가 render하는 대로 `updated_ts = CURRENT_TIMESTAMP(p)`, PostgreSQL과 SQLite는 `now` bind slot으로 executor가 bind한, p로 자른 텍스트). soft delete도 같은 방식으로 column에 clock을 대입한다. MySQL의 `ON UPDATE`는 다른 database에 대응하지 않는다.
- **DIA-221** transaction을 시작하는 문은 각 dialect의 형태다: MySQL과 MariaDB는 `START TRANSACTION`이며, transaction이 격리 수준을 지정하면 그 앞에 `SET TRANSACTION ISOLATION LEVEL <level>`이 오고, 읽기 전용 transaction은 ` READ ONLY`를 붙인다; PostgreSQL은 `BEGIN`이며, transaction이 지정하면 ` ISOLATION LEVEL <level>`과 ` READ ONLY`를 붙인다; SQLite와 markdown은 transaction이 시작할 때 쓰기 잠금을 잡는 `BEGIN IMMEDIATE`이고, 읽기 전용 transaction은 `BEGIN`이다. row lock을 잡는 SQLite transaction은 먼저 INT-49의 잠금 행 table을 만든다. transaction의 statement event는 이 문을 그대로 기록하므로, transaction의 문을 비교하는 recipe는 그것을 database마다 적는다.
- **DIA-23** `plus`와 `minus`는 column을 table-qualified로 작성한다.
- **DIA-24** SQLite datetime은 UTC 기준 `YYYY-MM-DD HH:MM:SS` text이고 `datetime(p)` 컬럼은 정확히 p자리 소수를, `time(p)` 컬럼의 time은 `HH:MM:SS`와 정확히 p자리 소수를 가진다(renderer의 CHECK가 요구한다). 실행기는 bind slot이 싣는 p로 그 형식을 bind한다. 삽입이 생략한 `default now` 컬럼 값은 실행기가 UTC 시각으로 채운다. datetime이나 time 컬럼과 비교하거나 대입하는 문자열도 같은 형식으로 바꾼다. `YYYY-MM-DD[ T]HH:MM:SS[.f]`나 `HH:MM:SS[.f]`는 0으로 p자리까지 채우고, p자리 뒤의 자리는 0이어야 하며 버려지고 0이 아니면 `CODEC_ENCODE`를 반환한다. `Z`나 `±HH:MM`을 포함한 문자열은 UTC로 변환한다. date 컬럼은 `YYYY-MM-DD`를 받는다. 그 밖의 문자열은 `CODEC_ENCODE`를 반환한다. 클라이언트는 MySQL과 PostgreSQL에서도 datetime과 time 값을 이 text 형식으로 bind한다. `time(p)` 컬럼은 소수 정확히 p자리의 text로 읽으며, 그 text는 데이터베이스가 쓴다. MySQL은 `CAST(c AS CHAR)`, PostgreSQL은 p = 0이면 `to_char(c, 'HH24:MI:SS')`, 그 밖에는 `substr(to_char(c, 'HH24:MI:SS.US'), 1, 9 + p)`이다. PostgreSQL은 `time` 값을 `CAST(CAST(? AS text) AS time)`로 bind한다. conformance vector `datetime_p0_roundtrip`과 `time_p3_roundtrip`이 그런 값을 삽입하고 같은 매개변수로 다시 읽어 비교하고, planner case `planner_time_select`와 `planner_time_insert`가 statement를 고정한다.
- **DIA-25** `decimal(P,S)` 컬럼은 MySQL에서 `DECIMAL(P,S)`, PostgreSQL에서 `NUMERIC(P,S)`, SQLite에서 `DECIMALINT(P,S)`를 사용한다. SQLite는 정확한 값을 10^S배 한 부호 있는 정수로 저장하고, 실행기는 읽을 때 생성 모델의 고정 소수부 자릿수 십진 문자열로 변환한다. 선언은 `1 ≤ P ≤ 18`, `0 ≤ S ≤ P`를 요구하므로 배율 정수가 부호 있는 64비트 정수 범위에 들어간다. 정수 decimal의 매니페스트에도 `scale: 0`을 명시한다. 잘못된 텍스트, 초과 자릿수, 소수부 손실, 맞지 않는 저장 셀은 `CODEC_ENCODE` 또는 `CODEC_DECODE`로 실패한다.
- **DIA-26** `jsontext` 컬럼은 모든 방언에서 텍스트다. PostgreSQL은 `text`, MySQL은 `LONGTEXT`, SQLite는 TEXT다. 저장한 텍스트를 그대로 반환하므로 멤버 순서, 중복 키, 빈 객체와 빈 배열의 구분이 유지된다. ORM에는 JSON 경로 조건과 JSON 인덱스가 없으며, 데이터베이스 안에서 질의하는 데이터는 컬럼이나 자식 테이블로 만든다.
- **DIA-27** `uuid` 컬럼은 모든 데이터베이스에서 16 byte를 담는다: PostgreSQL에서 네이티브 `uuid`, MySQL과 MariaDB에서 `BINARY(16)`, SQLite와 flowmark에서 16 byte BLOB이다. interface에서 그 값은 모든 runtime에서 하나의 text, 곧 36자의 소문자 canonical 형식이다: `0-9a-f`의 숫자 8, 4, 4, 4, 12개를 `-`로 잇는다. MySQL과 SQLite에서 클라이언트는 uuid parameter를 그 숫자 32개가 순서대로, 두 숫자에 한 byte씩 쓰는 16 byte로 bind하고, 16 byte인 uuid 셀을 다시 그 text로 읽는다. 어떤 server 함수도 값을 바꾸지 않으며(MariaDB에는 `UUID_TO_BIN`과 `BIN_TO_UUID`가 없다), text의 어떤 field도 자리를 옮기지 않는다. 모든 planner는 PostgreSQL `uuid` 컬럼을 `CAST(col AS text)`로 읽고 값을 `CAST(CAST(? AS text) AS uuid)`로 bind하므로 PostgreSQL 클라이언트는 text를 bind하고 읽는다. 16 byte는 text의 순서를 따르고 PostgreSQL은 `uuid`를 byte로 비교하므로(`postgres.uuid.byte_order`), 같음, `ORDER BY`, 범위 연산자(PRT-22)는 모든 데이터베이스에서 byte 순서로 비교하며 이는 canonical text의 순서다. conformance vector `uuid_roundtrip`과 recipe `conformance_verification`의 case `uuid_stored_in_16_bytes`, `uuid_order_is_the_order_of_its_text`, `uuid_equality_and_range`가 다섯 데이터베이스에서 하나의 결과를 지킨다. 16 byte가 아니거나 PostgreSQL에서 canonical text가 아닌 uuid 셀은 `CODEC_DECODE` `uuid cell is not a uuid`다(COD-1).
- **DIA-28** MySQL은 TEXT, BLOB, JSON, geometry 컬럼의 리터럴 기본값을 식 형식 `DEFAULT ('value')`로 기록하며 MySQL 8.0.13 이상이 필요하다. import는 이를 리터럴로 다시 읽는다.
- **DIA-29** Boolean은 PostgreSQL `boolean`, MySQL `BOOLEAN`/`TINYINT(1)`의 숫자 `0`/`1` 기본값, SQLite INTEGER 0/1을 사용한다. 정수가 아니라 boolean을 bind한다.
- **DIA-30** CHECK 표현식은 PostgreSQL과 SQLite에서 선언한 표현식을 그대로 생성한다. MySQL은 predicate를 반환하는 `CASE` CHECK 정의를 거부하므로 명시적인 boolean 비교로 감싼다. `NULL`은 `UNKNOWN`으로 유지되어 표준 CHECK 의미를 보존한다. MySQL CHECK 이름은 table이 아니라 database 범위이지만, renderer는 모든 CHECK 이름을 접두어 없이 그대로 쓴다. schema 검사는 제약·인덱스·생성 이름을 모두 전체 schema에서 유일하고 63바이트 이하로 유지하므로, 더 긴 생성 이름은 그것을 만드는 column이나 setting의 `name.length` 오류이며 줄이거나 hash를 붙이지 않는다([dbspec 이름](dbspec.md#names)).
- **DIA-31** `bind_slots[].col_type`은 placeholder가 받는 값의 dbspec type이다: 비교하거나 할당하는 column의 type(host style이 encode한 값도 저장되는 값이므로 column의 type이다), SQL 쪽 style 함수의 입력 type(`INET6_ATON`은 `text`), 비교하는 column 함수의 결과 type, 상대 시각 함수의 간격은 `i32`나 `f64`, secret은 `text`, config 값과 audit key는 그 column의 type, `now` slot은 `datetime`이다. `parent` slot은 비교하는 key column의 type인 `key_types`를 가진다. 모든 slot에 type이 있고, type 없는 slot은 `IR_INVALID`다. `col_type`은 SQL 쪽 style을 거친 뒤 placeholder가 받는 type이다. parameter의 논리 type은 그 앞의 type, 곧 비교하거나 할당하는 column이나 첫 stage 입력의 type이며 `ir.ParamUses`가 이를 나열한다([protocol](protocol.md) §5 "Parameters"). 클라이언트는 어떤 statement보다 먼저 각 parameter를 그것이 채우는 `param` slot의 논리 type과 slot의 `precision`, `scale`, `length`로 검사하고, 그 밖의 값은 `CODEC_ENCODE`다. `host_styles`가 있는 slot은 첫 stage의 encode가, `transform`이 있는 slot은 그 transform이 값을 검사한다. transform은 SQL NULL을 NULL로 bind하고 text가 아닌 다른 값은 `CODEC_ENCODE`다. PostgreSQL에서 Rust client는 각 값을 그 slot의 dbspec type에 해당하는 PostgreSQL type으로 bind하고 server에 parameter나 column 정보를 묻지 않는다. 실행기는 bind 전에 SQLite 시간 값을 정규화한다.
- **DIA-32** `bind_slots[].host_styles`와 `columns[].styles`는 실행기가 처리할 host stage를 기록한다. AES는 `docs/spec/codec.md`에 정의한 `ORM-AES2\0` authenticated ciphertext format, 12바이트 random nonce, AES-256-GCM, version key derivation을 사용한다.
- **DIA-33** AES column이 있는 entity는 `aes_version` setting으로 key version column을 선언한다. 읽기는 그 column을 한 번만 고른다. request가 고른 column이면 그것을, 아니면 숨은 column을 쓰며, 저장된 version으로 설정된 key version에서 key를 선택한다. key가 없으면 `CONFIG`를, ciphertext가 유효하지 않으면 `CODEC_DECODE`를 반환하며 이전 version에 current key를 사용하지 않는다.
- **DIA-35** `contains`는 모든 database에서 substring을 찾고, ASCII 글자는 대소문자 구분 없이, 다른 모든 문자는 code point로 비교한다: MySQL은 두 피연산자의 A–Z를 중첩 `REPLACE`로 접고(위 `Lk`), PostgreSQL `COLLATE "C"` 아래의 `ILIKE`와 SQLite `LIKE`는 ASCII 글자만 접는다. conformance vector `contains_ascii_fold`가 결과를 고정한다.
- **DIA-36** 상대 시간 함수(`seconds_ago`부터 `months_later`까지)는 결과가 0001-01-01 00:00:00부터 9999-12-31 23:59:59.999999 밖이거나 interval이 그 범위의 폭(315537897600초, 5258964960분, 87649416시간, 3652059일, 119988개월)을 넘으면 NULL이다. 그래서 그 함수와의 비교와 그 비교의 부정이 모두 어떤 행과도 맞지 않는다. 범위를 넘으면 MySQL과 SQLite는 NULL을, 범위 아래에서는 0000년을 준다(`mysql.relative.out_of_range_null`, `sqlite.relative.out_of_range_null`). PostgreSQL은 표현할 수 없는 interval에서 실패하고 범위를 넘으면 10000년을 준다(`postgres.relative.interval_out_of_range`). 그래서 모든 dialect는 interval을 `CASE WHEN <interval> BETWEEN -<폭> AND <폭> THEN <interval> END`로 감싸되 상수 접기가 표현할 수 없는 interval을 계산하지 않도록 함수 안에서 감싸고, 결과를 `CASE WHEN <결과> BETWEEN '0001-01-01 00:00:00' AND '9999-12-31 23:59:59.999999' THEN <결과> END`로 감싼다. SQLite는 적용할 수 없는 interval에 이미 NULL을 주므로 결과 guard만 쓴다. conformance vector `relative_time_out_of_range`가 각 비교의 양쪽을 실행한다. 월 연산은 대상 월의 마지막 유효한 날을 유지한다([DSL-142](dsl.md)). MySQL `DATE_ADD`와 `DATE_SUB`, PostgreSQL `make_interval(months => n)`은 스스로 그렇게 하고(`mysql.relative.month_end_kept`, `postgres.relative.month_end_kept`), SQLite `datetime`은 대상 월의 끝을 넘는 날을 다음 달로 넘기므로 그 형태에 `floor` modifier를 더한다(`sqlite.relative.month_floor`).
- **DIA-216** 결과가 유한한 binary64 범위를 벗어나는 `f64` 컬럼의 `SUM`이나 `AVG`는 모든 데이터베이스에서 한 사실, 즉 타입의 범위를 벗어난 합이나 평균(DSL-66)이며, text `aggregate scalar is not a finite number`와 함께 `CODEC_DECODE`다. SQLite와 markdown은 무한대 real을 반환하고 executor가 그렇게 거부한다. PostgreSQL은 statement를 SQLSTATE 22003(`value out of range: overflow`)으로 거부한다. MySQL은 무한대 double을 binary protocol에서는 그대로 반환하고 text protocol에서는 유한한 합인 0으로 쓴다. 그래서 planner는 MySQL에서 `f64` 컬럼에 `SUM(c) + 0`을 선택하며, MySQL은 합이 유한하지 않으면 이를 1690(SQLSTATE 22003)으로 거부하고 그렇지 않으면 합 그대로다. executor는 MySQL과 PostgreSQL에서 `getSum()`이나 `getAvg()`의 statement가 받은 SQLSTATE 22003을 그 `CODEC_DECODE`로 보고하고 driver 오류를 cause로 유지한다. transaction 밖에서는 PostgreSQL statement가 먼저 한 번 더 실행된다(CFG-28). transaction 안에서는 PostgreSQL이 거부한 모든 statement처럼 transaction을 중단한 상태다.
- **DIA-217** 유한한 `f64` parameter는 모든 데이터베이스에서 호출자가 준 binary64 값이다. PDO는 float를 텍스트로 bind하며, PHP는 그 텍스트를 `precision` 설정(기본값은 유효 숫자 14자리)으로 쓰므로 그 텍스트는 다른 binary64 값이 된다. 그래서 PHP 클라이언트 `polyspec/orm`과 PHP 확장 클라이언트 `polyspec/orm-php-ext`는 MySQL, PostgreSQL, SQLite에서 유한한 float를 그 설정과 상관없이 같은 값으로 다시 읽히는 가장 짧은 십진 텍스트로 bind한다. markdown 연결은 float로 bind한다(PRT-67).
- **DIA-218** SQLite는 정수를 부호 있는 64비트 정수로 더하고 그 범위를 넘는 합을 `integer overflow`로 거부하지만, MySQL과 PostgreSQL은 정확한 합을 반환한다. 그래서 SQLite와, statement를 SQLite에서 실행하는 markdown에서는 정확한 컬럼(DSL-161)의 합, 곧 정수 컬럼의 정수나 `decimal(P,S)` 컬럼의 scale된 정수(DIA-25)의 합을 값의 16비트 네 부분의 합과 셀 하나로 계획한다: `>>`가 부호와 함께 미는 상위 부분의 합 `SUM(c >> 48)`은 [-2^15, 2^15)의 값을, 나머지 세 부분의 합 `SUM((c >> 32) & 65535)`, `SUM((c >> 16) & 65535)`, `SUM(c & 65535)`은 [0, 2^16)의 값을 더하며, `MAX(typeof(c) NOT IN ('integer', 'null'))`은 정수가 아닌 값이 있으면 1이다. 합은 네 합을 각각 `COALESCE(<합>, 0)`로, 그리고 그 셀을 선택하고, 평균은 네 합과 그 셀과 `COUNT(c)`를 선택한다. executor는 네 합 p3, p2, p1, p0을 한계 없이 담는 정확한 정수 ((p3 × 2^16 + p2) × 2^16 + p1) × 2^16 + p0으로 합치며, 그 정수가 DSL-161의 정확한 합이고 DSL-66이 그것을 한 번 변환한다. 그래서 `getSum()`과 `getAvg()`는 i64 범위를 위나 아래로 넘는 합을 포함해 모든 데이터베이스에서 같은 값 하나를, 모든 runtime에서 DSL-66의 host 타입으로 준다. SQLite가 담을 수 있는 표에서 네 합은 어느 것도 i64 범위를 벗어나지 않으므로, 이 분할에는 데이터베이스가 닿는 한계가 없다: 한 부분은 [-2^15, 2^16)에 있으므로 n개 부분의 합은 n이 2^47 이하이면 (-2^62, 2^63)에 있다. 그리고 데이터베이스 파일은 많아야 65536 byte인 page를 많아야 4294967294개(SQLITE_MAX_PAGE_COUNT, 2^32 - 2) 가지므로([SQLite limits](https://www.sqlite.org/limits.html)) 2^48 byte보다 작고, 행 하나는 적어도 그 b-tree page의 cell pointer 배열 항목 2 byte를 차지하므로([SQLite file format](https://www.sqlite.org/fileformat2.html)) 표는 2^47개보다 적은 행을 담는다. markdown은 같은 한계 아래 SQLite에서 statement를 실행한다. 정수가 아닌 값은 컬럼의 CHECK가 거부하므로 스키마 뒤에서 바뀐 표만 담는데, `>>`와 `&`에서 소수부를 잃을 것이다. 마지막 셀이 이를 알리며, executor는 합과 평균을 DSL-66의 `CODEC_DECODE` `column <column> holds a value that is not an integer`로, `decimal(P,S)` 컬럼이면 `column <column> holds a value that is not a decimal of scale <S>`로 거부한다. 이는 그런 컬럼에 대해 MySQL과 PostgreSQL이 정수 컬럼이면 소수부가 있는, decimal 컬럼이면 소수 자릿수가 S보다 많은 decimal text로 반환하는 합의 거부이기도 하므로, 그런 컬럼의 합은 모든 데이터베이스에서 같게 실패한다. case `added_sum_fractional`이 이를 지킨다. recipe `conformance_verification`의 case `aggregate_of_an_integer_column_past_the_i64_range_is_exact`와 `sum_parts_of_i64_boundary_values_are_exact`가 모든 데이터베이스에서 범위를 위와 아래로 넘는 합과 평균, 범위를 넘었다가 돌아오는 누적 합, 그리고 부분끼리 올림이 넘어가는 범위 양 끝의 값을 지킨다.
- **DIA-219** 모든 클라이언트는 MySQL `DECIMAL`과 PostgreSQL `NUMERIC` 셀을 자릿수와 관계없이 정확한 decimal text로 읽는다. catalog 컬럼은 많아야 18자리(DIA-25)를 담지만 DSL-161의 합과 raw statement의 셀은 더 많은 자리를 담을 수 있으며, 어떤 클라이언트도 이를 반올림하는 고정 폭 decimal로 읽지 않는다. Rust의 128비트 decimal은 유효 숫자 28자리를 담고 더 긴 값을 반올림하므로, Rust는 MySQL이 보내는 text를 읽고 PostgreSQL의 binary NUMERIC을 부호, weight, display scale과 10000진 숫자로부터 해독한다. 어떤 정확한 컬럼도 담지 않는 NUMERIC NaN과 무한대는 `CODEC_DECODE`이다. decimal field 매개변수는 많아야 18자리(COD-2)를 담지만, schema 변경 뒤에 문이 다시 실행될 때(CFG-28) PostgreSQL이 `NUMERIC`으로 타입을 정하는 매개변수는 다른 타입 field의 text이며 자릿수에 제한이 없다. 모든 클라이언트는 그것을 PostgreSQL 17이 그 text에서 읽는 수(numeric_in)로 bind하며, Rust는 자체 폭 없이 같은 규칙으로 그 text의 binary NUMERIC을 인코딩한다: 앞뒤 공백, 부호 하나, 대소문자와 관계없는 `NaN`과 무한대, 16진·8진·2진 정수, 숫자 사이의 밑줄, 지수. PostgreSQL이 numeric으로 읽지 않는 text는 모든 클라이언트에서 PostgreSQL이 거부하는 대로 실패한다. numeric이 아닌 text는 SQLSTATE `22P02`, 범위를 넘는 numeric은 `22003`의 `DRIVER`이며, Rust는 타입이 바뀐 매개변수의 text를 server가 읽게 하며(CFG-28), 인코더는 decimal field의 값과 numeric으로 bind하는 정수와 실수를 bind한다. recipe `conformance_verification`의 case `decimal_text_past_28_digits_reads_exactly`가 MySQL과 PostgreSQL에서 40자리 decimal과 소수 30자리 decimal을 읽고, recipe `parameter_chunking`의 case `model_decimal_text_parameter_after_schema_change`가 PostgreSQL이 `NUMERIC`으로 바꾼 column에 30자리, 소수 29자리, 지수가 있는 text를 쓰고 비교한다. 같은 recipe의 case `model_numeric_text_parameter_refused_after_schema_change`는 PostgreSQL이 거부하는 numeric이 아닌 text와 범위를 넘는 text를 쓴다. 여기서 database는 각자의 규칙대로 다르고, 각 case는 그 각각을 기대한다. strict mode의 MySQL은 column 타입의 값이 아니거나 범위를 넘는 text를 문의 오류(1366, 1292, 1264)로 거부하므로 쓰기는 PostgreSQL처럼 `DRIVER`이다. SQLite와 그것을 거치는 markdown은 column의 affinity(INTEGER, NUMERIC)가 수로 바꾸지 않는 text를 그 text로 저장하므로 쓰기는 성공하고 행은 그 text를 담는다. case `model_text_parameter_refused_after_schema_change`가 정수와 날짜로 바뀐 column에 text `seven`과 `2026-02-30`을 이 결과로 쓴다.
- **DIA-37** recipe `conformance_verification`은 각 case의 expect를 방언마다 적으며, case의 결과는 세 database에서 같아야 한다. `get_query`는 방언 SQL을 반환한다.

## Schema definitions

이 절은 MySQL, PostgreSQL, SQLite가 스키마 객체를 정의하고 적용하고 catalog에 기록하는 방식을 정리하고, 중립 스키마 언어 dbspec이 각 기능을 지원하는지 결정한다. 기능은 (1) dbspec에 공통 정의가 하나 있고, (2) 그 정의가 MySQL, PostgreSQL, SQLite에서 같은 의미로 생성되며, (3) introspection이 숨은 표식 없이 catalog에서 같은 정의를 복원할 때만 지원한다. Renderer가 setting에서 생성하는 CHECK나 trigger 같은 동작은 catalog 텍스트가 선언한 renderer version의 출력과 같을 때만 복원한다.

모든 사실은 `packages/go/internal/dialects`의 공통 probe ID(`make dialect-facts-check`)를 인용한다. Probe는 자기 전용 일회용 database, schema, file에서 DDL, DML, catalog 질의를 실행하며 데이터베이스가 다르게 동작하면 실패한다. `render.*` probe는 제안한 rendering을 검사한다. Probe ID가 없는 사실은 공식 manual을 인용한다. 각 행은 **Decision:**으로 끝난다. **T8.1 review**는 이 기록이 결정하지 않는 정의다.

표기: "renderer CHECK"는 renderer가 타입이나 setting을 위해 생성하는 CHECK 제약이다. 정확한 텍스트와 이름은 T8.1에서 정하며, introspection은 catalog 텍스트가 해당 서버의 renderer 출력과 같을 때만 받아들인다.

### Probe environment

| 항목 | 값 |
|---|---|
| MySQL | 8.4.11, 서버 `sql_mode`에 `STRICT_TRANS_TABLES` 포함, 모든 클라이언트가 [config](config.ko.md)의 세션 `sql_mode`를 정함(`mysql.session.sql_mode_set`), `lower_case_table_names=1`, `log_bin=1`, `log_bin_trust_function_creators=0`, `explicit_defaults_for_timestamp=1`, 서버 시간대 `SYSTEM`(KST) (`mysql.env.server`) |
| PostgreSQL | 17.11, `TimeZone=Asia/Seoul`, database collation `C`, `max_identifier_length=63` (`postgres.env.server`) |
| SQLite (probe) | `modernc.org/sqlite` v1.58.0의 3.53.4 (`sqlite.env.library`) |
| SQLite, Go client | `modernc.org/sqlite` v1.58.0(`packages/go/go.mod`), `select sqlite_version()` 결과 3.53.4 |
| SQLite, PHP client | PHP 8.4.26의 `pdo_sqlite`, `select sqlite_version()` 결과 3.53.4 |
| SQLite, TypeScript client | Node 26.11.1의 `node:sqlite`, `select sqlite_version()` 결과 3.53.4. `package.json`은 Node 26.12.0 이상을 허용하며 그 뒤 release의 bundled version은 측정하지 않았다 |
| SQLite 파일 이름 | DSN query가 남아 있는 파일 이름은 PHP PDO, `node:sqlite`, `sqlite3` shell이 그대로 열어 `bench.sqlite?_pragma=…`를 만든다. `modernc.org/sqlite`는 query를 해석한다(`TestSQLiteFileNameWithQuery`의 `sqlite.filename.*` case). 클라이언트는 파일 이름을 정하기 전에 query를 제거한다 |
| SQLite, Rust client | sqlx 0.9 `sqlite` feature가 `sqlite-bundled`를 켠다. `libsqlite3-sys` 0.37.0(`packages/rust/Cargo.lock`)은 3.51.3을 포함하며, 같은 crate와 feature로 build한 프로그램의 `sqlite3_libversion()`으로 확인했다. Probe는 3.51.3에서 실행하지 않았다 |

### Types

- **DIA-38** 정수 — MySQL 8.4: `TINYINT`/`SMALLINT`/`MEDIUMINT`/`INT`/`BIGINT`, strict mode에서 범위 검사(1264). `tinyint(1)`을 제외하면 display width를 제거한다; PostgreSQL 17: `smallint`/`integer`/`bigint`만 있으며 범위를 검사한다(22003). `tinyint`/`mediumint`는 없다(42704); SQLite: 선언한 이름은 affinity만 정한다. STRICT가 아닌 table은 어떤 값과 범위도 저장한다; Probe: `mysql.int.tinyint_range`, `mysql.int.display_width_dropped`, `postgres.int.smallint_range`, `postgres.int.no_tinyint`, `sqlite.type.affinity_unenforced`, `sqlite.render.integer_check`; 결정과 중립 rendering: **Decision:** `i16`, `i32`, `i64`로 지원한다. MySQL `SMALLINT`/`INT`/`BIGINT`, PostgreSQL `smallint`/`integer`/`bigint`, SQLite `smallint`/`integer`/`bigint`와 renderer CHECK `typeof(c) IN ('integer','null') AND c BETWEEN min AND max`(`i64`는 범위 없음). 8비트·24비트 정수는 PostgreSQL에 해당 타입이 없으므로 지원하지 않는다; Introspection: MySQL `COLUMNS.COLUMN_TYPE`, PostgreSQL `pg_attribute.atttypid`/`format_type`, SQLite `pragma_table_info.type`과 `sqlite_master.sql`의 CHECK 텍스트
- **DIA-39** Unsigned — MySQL 8.4: `UNSIGNED`는 음수를 거부하고 `BIGINT UNSIGNED`는 18446744073709551615까지 저장한다; PostgreSQL 17: 수식어가 없다(42601); SQLite: 이름의 일부로 받아들이고 무시한다; Probe: `mysql.int.unsigned_rejects_negative`, `mysql.int.bigint_unsigned_exceeds_signed`, `postgres.int.no_unsigned`, `sqlite.type.affinity_unenforced`; 결정과 중립 rendering: **Decision:** 지원하지 않는다. PostgreSQL과 SQLite에는 부호 없는 64비트 범위를 담는 타입이 없다. 음수 금지 규칙은 명시적인 CHECK 정의다; Introspection: MySQL `COLUMN_TYPE`의 ` unsigned` 접미사는 미지원으로 보고한다
- **DIA-40** Boolean — MySQL 8.4: `BOOLEAN`은 `tinyint(1)`이며 2와 -1을 저장한다; PostgreSQL 17: `boolean`은 정수를 거부한다(42804); SQLite: `TRUE`/`FALSE`는 1/0이다. `BOOLEAN`은 NUMERIC affinity이며 어떤 값도 저장한다; Probe: `mysql.bool.alias_tinyint`, `postgres.bool.rejects_integer`, `sqlite.bool.literals`, `mysql.render.bool_check`, `sqlite.render.bool_check`; 결정과 중립 rendering: **Decision:** `bool`로 지원한다. MySQL `tinyint(1)`과 renderer CHECK `b IN (0,1)`, PostgreSQL `boolean`, SQLite `BOOLEAN`과 renderer CHECK `b IN (0,1)`. 필드 이름은 boolean을 선택하지 않는다; Introspection: MySQL `COLUMN_TYPE` `tinyint(1)`과 CHECK, PostgreSQL `boolean`, SQLite 타입과 CHECK 텍스트
- **DIA-41** Decimal — MySQL 8.4: `DECIMAL(p,s)`, p ≤ 65(1426), s ≤ 30(1425). 초과 소수는 0에서 먼 쪽으로 반올림하고 overflow는 실패한다(1264); PostgreSQL 17: `numeric(p,s)`, p ≤ 1000(22023), 음수 scale 허용. 반올림은 같고 overflow는 실패한다(22003); SQLite: Decimal 저장이 없다. `DECIMAL(4,2)`는 NUMERIC affinity이며 1.235를 real로 저장한다. `DECIMALINT(p,s)`는 INTEGER affinity다; Probe: `mysql.decimal.scale_rounds`, `mysql.decimal.overflow_rejected`, `mysql.decimal.precision_limits`, `postgres.numeric.scale_rounds`, `postgres.numeric.overflow_rejected`, `postgres.numeric.precision_limits`, `sqlite.type.affinity_from_name`, `sqlite.render.decimal_check`; 결정과 중립 rendering: **Decision:** 1 ≤ p ≤ 18, 0 ≤ s ≤ p인 `decimal(p,s)`로 지원한다. MySQL `DECIMAL(p,s)`, PostgreSQL `numeric(p,s)`, SQLite는 값 × 10^s를 저장하는 `DECIMALINT(p,s)`와 renderer CHECK `typeof(d) IN ('integer','null') AND d BETWEEN -(10^p-1) AND 10^p-1`. 클라이언트가 소수 s자리나 전체 p자리를 넘는 값을 어떤 statement보다 먼저 `CODEC_ENCODE`로 거부하므로(`tests/bind/vectors.json`의 `decimal-scale`과 `decimal-precision`) 데이터베이스 반올림은 쓰지 않는다; Introspection: MySQL `NUMERIC_PRECISION`/`NUMERIC_SCALE`, PostgreSQL `numeric_precision`/`numeric_scale`, SQLite 선언 타입 텍스트
- **DIA-42** 부동소수점 — MySQL 8.4: `FLOAT`는 4바이트, `DOUBLE`은 8바이트. NaN과 무한대 값이 없다(1367); PostgreSQL 17: `real` 4바이트, `double precision` 8바이트. NaN과 Infinity를 저장한다; SQLite: `REAL`은 8바이트이며 무한대를 저장한다; Probe: `mysql.float.single_precision`, `mysql.float.no_infinity`, `postgres.float.real_single_precision`, `postgres.float.nan_infinity`, `sqlite.float.infinity`; 결정과 중립 rendering: **Decision:** `f64`를 지원한다. MySQL `DOUBLE`, PostgreSQL `double precision`, SQLite `REAL`. 값은 유한하며 클라이언트가 NaN과 무한대를 거부한다. SQLite에 4바이트 float가 없으므로 `f32`는 지원하지 않는다; Introspection: MySQL `DATA_TYPE`, PostgreSQL `atttypid`, SQLite 선언 타입
- **DIA-43** `varchar(n)` — MySQL 8.4: 길이는 문자 수다(1406). 초과한 뒤쪽 공백은 제거한다. utf8mb4 n ≤ 16383(1074); PostgreSQL 17: 길이는 문자 수다(22001). 초과한 뒤쪽 공백은 제거한다. n ≤ 10485760(22023); SQLite: 길이를 검사하지 않는다; Probe: `mysql.varchar.length_in_characters`, `mysql.varchar.trailing_spaces_truncated`, `mysql.varchar.max_length`, `postgres.varchar.length_in_characters`, `postgres.varchar.trailing_spaces_truncated`, `postgres.varchar.max_length`, `sqlite.varchar.length_unenforced`, `sqlite.render.varchar_check`; 결정과 중립 rendering: **Decision:** 1 ≤ n ≤ 16383인 `varchar(n)`으로 지원한다. MySQL과 PostgreSQL `varchar(n)`, SQLite `varchar(n)`과 renderer CHECK `length(v) <= n`. 클라이언트는 뒤쪽 공백을 포함해 n자를 넘는 값을 어떤 statement보다 먼저 `CODEC_ENCODE`로 거부하므로(conformance vector `varchar_length_rejected`) 데이터베이스의 공백 제거는 쓰지 않는다; Introspection: MySQL `CHARACTER_MAXIMUM_LENGTH`, PostgreSQL `atttypmod`/`character_maximum_length`, SQLite 선언 타입과 CHECK 텍스트
- **DIA-44** `char(n)` — MySQL 8.4: 읽을 때 뒤쪽 공백을 제거한다; PostgreSQL 17: 공백을 채운 값을 반환한다; SQLite: 채우지 않는다; Probe: `mysql.char.trailing_spaces_removed`, `postgres.char.padded`; 결정과 중립 rendering: **Decision:** 지원하지 않는다. MySQL과 PostgreSQL의 저장·반환 값이 다르다; Introspection: 미지원으로 보고한다
- **DIA-45** `text` — MySQL 8.4: `TEXT`는 65535바이트 이하(1406), `LONGTEXT`는 4 GiB 이하. 리터럴 기본값은 `DEFAULT ('x')`가 필요하고(1101) index는 prefix가 필요하다(1170); PostgreSQL 17: 길이 없는 `text`. Probe에서 1 MiB를 저장했다. 필드 한도는 1 GB; SQLite: `TEXT`, `SQLITE_MAX_LENGTH`(기본 10^9바이트) 한도; Probe: `mysql.text.max_bytes`, `mysql.text.literal_default_needs_expression`, `mysql.text.index_needs_prefix`, `postgres.text.unlimited`; 결정과 중립 rendering: **Decision:** `text`로 지원한다. MySQL `LONGTEXT`, PostgreSQL `text`, SQLite `TEXT`. `text` 컬럼은 key나 index에 포함할 수 없다. 최대 값은 PostgreSQL 1 GB 필드 한도, SQLite `SQLITE_MAX_LENGTH`, MySQL `max_allowed_packet` 중 가장 작은 값이다. Ordered JSON은 codec setting을 가진 `text`다; Introspection: MySQL `DATA_TYPE`, PostgreSQL `atttypid`, SQLite 선언 타입
- **DIA-46** text의 U+0000 — MySQL 8.4: 저장한다; PostgreSQL 17: 거부한다(22021); SQLite: 저장하며 `length()`는 그 앞에서 멈춘다; Probe: `mysql.text.nul_preserved`, `postgres.text.nul_rejected`, `sqlite.text.nul_preserved`; 결정과 중립 rendering: **Decision:** U+0000은 중립 text 값이 아니다. 모든 데이터베이스에서 클라이언트가 `text`와 `varchar`의 U+0000을 어떤 statement보다 먼저 `CODEC_ENCODE`로 거부한다(conformance vector `text_nul_rejected`); Introspection: 해당 없음
- **DIA-220** UTF-8이 아닌 text — MySQL 8.4: `utf8mb4` column이 거부한다(1366, `Incorrect string value`); PostgreSQL 17: `UTF8` database가 거부한다(22021, `invalid byte sequence for encoding "UTF8"`); SQLite: 그 byte로 저장하고 그대로 읽는다; 모든 client는 그 거부를 서버의 message와 함께 `DRIVER`로 보고하며, 그런 text는 Go, PHP, PHP extension만 담는다(PRT-67).
- **DIA-47** Bytes — MySQL 8.4: `BINARY(n)`은 0바이트로 채우고 `VARBINARY(n)`은 길이를 검사한다(1406). `LONGBLOB`; PostgreSQL 17: `bytea`는 길이가 없다(42601); SQLite: `BLOB`은 길이가 없다; Probe: `mysql.binary.zero_padded`, `mysql.varbinary.length_enforced`, `postgres.bytea.no_length`; 결정과 중립 rendering: **Decision:** 길이 없는 `bytes`를 지원한다. MySQL `LONGBLOB`, PostgreSQL `bytea`, SQLite `BLOB`. 채움과 길이는 MySQL에만 있으므로 `binary(n)`과 `varbinary(n)`은 지원하지 않는다; Introspection: MySQL `DATA_TYPE`, PostgreSQL `atttypid`, SQLite 선언 타입
- **DIA-48** UUID — MySQL 8.4: 타입이 없다(1064); MariaDB 11.8: text의 group을 다른 순서로 저장해 `ORDER BY`가 text의 순서가 아닌 `UUID` 타입; PostgreSQL 17: byte로 비교하는 16 byte `uuid`이며 중괄호와 대문자를 받고 소문자를 반환한다; SQLite: 타입이 없다; Probe: `mysql.uuid.no_type`, `mariadb.uuid.no_type`, `postgres.uuid.native_normalized`, `postgres.uuid.byte_order`, `mysql.render.uuid_bytes`, `mariadb.render.uuid_bytes`, `mysql.uuid.binary_pads`, `mariadb.uuid.binary_pads`, `sqlite.render.uuid_bytes`; 결정과 중립 rendering: **Decision:** 값이 소문자 canonical text인 16 byte `uuid`로 지원한다(DIA-27). PostgreSQL `uuid`, MySQL과 MariaDB `BINARY(16)`과 renderer CHECK `length(u) = 16`이며, 정렬이 다른 데이터베이스와 다른 MariaDB 자체의 `UUID`는 쓰지 않는다(DIA-200의 규칙 1은 두 server가 똑같이 정렬하는 한 형식을 지킨다). SQLite `BLOB`과 renderer CHECK `typeof(u) IN ('blob', 'null') AND length(u) = 16`. `BINARY(16)`은 더 짧은 값을 0 byte로 채우고 더 긴 값을 거부하므로(1406, `mysql.uuid.binary_pads`) 그 CHECK는 저장된 모든 값에서 참이며, uuid를 `bytes` column과 구별하는 이름을 가진 표시다(DIA-144). 클라이언트는 언제나 16 byte를 bind한다. 대문자와 중괄호를 포함해 소문자 canonical 형식이 아닌 text는 PostgreSQL을 포함한 모든 데이터베이스와 여섯 runtime 모두에서 어떤 statement보다 먼저 클라이언트의 encode가 `CODEC_ENCODE` `parameter <i> is not a lower-case canonical uuid`로 거부하므로(conformance vector `uuid_form_rejected`) PostgreSQL의 다른 형식 읽기는 쓰지 않고 어떤 입력도 정규화하지 않는다. 0.0.28까지의 release는 uuid를 MySQL에서 `char(36) CHARACTER SET ascii COLLATE ascii_bin`, SQLite에서 `TEXT`로 저장했다. dbspec apply가 그런 column을 16 byte로 바꾼다(PLN-108); Introspection: PostgreSQL `uuid`, MySQL과 SQLite 타입과 CHECK 텍스트
- **DIA-49** Enum — MySQL 8.4: `ENUM`은 목록 밖의 값을 거부하고(1265), 생략한 NOT NULL 컬럼에 첫 값을 저장하며, 목록 위치로 정렬한다; PostgreSQL 17: `CREATE TYPE … AS ENUM`은 별도 타입 객체(`USER-DEFINED`, `pg_enum`)이며 목록 밖의 값을 거부하고(22P02) 목록 위치로 정렬한다; SQLite: `enum('a','b')`는 문법 오류다; Probe: `mysql.enum.rejects_unknown`, `mysql.enum.not_null_first_value_default`, `mysql.enum.sorts_by_position`, `postgres.enum.type_object`, `sqlite.enum.type_name_rejected`; 결정과 중립 rendering: **Decision:** native enum은 지원하지 않는다. 값 목록은 `in` CHECK 정의를 가진 `varchar(n)` 컬럼이며 모든 데이터베이스에서 텍스트로 정렬한다; Introspection: MySQL `ENUM` 컬럼과 PostgreSQL enum 타입은 미지원으로 보고한다
- **DIA-50** JSON — MySQL 8.4: `JSON`은 마지막 중복 키를 남기고 멤버 순서를 바꾼다; PostgreSQL 17: `json`은 텍스트를 유지하고 `jsonb`는 마지막 중복 키를 남기며 순서를 바꾼다; MariaDB 11.8: `JSON`은 컬럼 `c`의 이름을 단 `CHECK (json_valid(c))`를 가진 `utf8mb4_bin`의 `LONGTEXT`이며, 멤버 순서와 중복 키를 포함해 텍스트를 쓴 그대로 유지한다; SQLite: 텍스트다. `json()`은 중복 키를 유지한다; Probe: `mysql.json.normalizes`, `mariadb.json.normalizes`, `postgres.json.text_jsonb_normalized`, `sqlite.json.text_kept`; 결정과 중립 rendering: **Decision:** native JSON 타입은 지원하지 않는다. Ordered JSON은 ordered-json codec setting을 가진 `text` 컬럼이다; Introspection: MySQL `JSON`, PostgreSQL `json`/`jsonb` 컬럼은 미지원으로 보고한다. MariaDB에서는 컬럼과 그 `json_valid` CHECK를 각각 미지원으로 보고하므로, `tests/dbspec/introspect.json`의 vector `mysql-unsupported`는 그 `mariadb` 결과에 CHECK `doc`을 적는다(DIA-200, 규칙 4)

출처: [MySQL numeric types](https://dev.mysql.com/doc/refman/8.4/en/numeric-types.html), [MySQL string types](https://dev.mysql.com/doc/refman/8.4/en/string-types.html), [MySQL storage requirements](https://dev.mysql.com/doc/refman/8.4/en/storage-requirements.html), [MySQL ENUM](https://dev.mysql.com/doc/refman/8.4/en/enum.html), [MySQL JSON](https://dev.mysql.com/doc/refman/8.4/en/json.html), [PostgreSQL numeric types](https://www.postgresql.org/docs/17/datatype-numeric.html), [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html), [PostgreSQL binary data](https://www.postgresql.org/docs/17/datatype-binary.html), [PostgreSQL UUID](https://www.postgresql.org/docs/17/datatype-uuid.html), [PostgreSQL enum](https://www.postgresql.org/docs/17/datatype-enum.html), [PostgreSQL JSON](https://www.postgresql.org/docs/17/datatype-json.html), [SQLite datatypes](https://www.sqlite.org/datatype3.html), [SQLite STRICT tables](https://www.sqlite.org/stricttables.html), [SQLite limits](https://www.sqlite.org/limits.html).

- **DIA-51** SQLite STRICT table은 storage class를 검사하지만 타입 이름은 `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, `ANY`만 허용한다(`sqlite.strict.enforces_types`, `sqlite.strict.type_names_limited`). 따라서 STRICT table은 catalog에 `varchar(n)`이나 `DECIMALINT(p,s)`를 유지할 수 없고 길이와 scale을 복원할 수 없다. **Decision:** SQLite table은 STRICT로 만들지 않는다. 선언 타입 이름이 중립 타입을 담고 renderer CHECK가 이를 검사한다.

### Date and time

- **DIA-52** `date` — MySQL 8.4: `DATE`. Strict mode는 `0000-00-00`을 거부한다(1292); PostgreSQL 17: `date`, 기원전 4713년부터 5874897년까지; SQLite: 타입이 없으며 어떤 텍스트도 저장한다; Probe: `mysql.date.zero_rejected`, `sqlite.datetime.text_unvalidated`, `sqlite.render.date_check`; 결정과 중립 rendering: **Decision:** 0001-01-01부터 9999-12-31까지의 `date`로 지원한다. MySQL `DATE`, PostgreSQL `date`, SQLite `DATE`와 renderer CHECK `d IS date(d)`; Introspection: MySQL `DATA_TYPE`, PostgreSQL `atttypid`, SQLite 타입과 CHECK 텍스트
- **DIA-53** `time` — MySQL 8.4: `TIME`은 -838:59:59부터 838:59:59까지의 interval이다(그 밖은 1292); PostgreSQL 17: `time`은 하루 중 시각이며 24:00:00을 받는다. 25:00:00은 실패한다(22008); SQLite 3.54.1(Go 드라이버가 고정해 쓰는 버전): 타입이 없고 `time('24:00:00')`은 `00:00:00`을, `time('24:00:01')`과 `time('25:00:00')`은 NULL을 반환하며 renderer CHECK가 24:00:00을 거부한다; Probe: `mysql.time.interval_range`, `postgres.time.day_range`, `sqlite.render.time_check`, `mysql.render.time_of_day_check`, `postgres.render.time_of_day_check`; 결정과 중립 rendering: **Decision:** 24:00:00 미만의 하루 중 시각인 `time(p)`로 지원한다. MySQL `TIME(p)`와 renderer CHECK `v >= '00:00:00' AND v < '24:00:00'`, PostgreSQL `time(p)`와 renderer CHECK `v < '24:00:00'`, SQLite `TIME` 텍스트와 p = 0의 renderer CHECK `v IS time(v) AND v < '24:00:00'`(소수 형식은 T8.1에서 정한다). `postgres.render.time_of_day_check`는 아직 실행하지 않았다; Introspection: 타입과 CHECK 텍스트
- **DIA-54** 소수 초 — MySQL 8.4: 0~6자리(그 이상은 1426). 초과 자릿수는 반올림한다. `(6)` 없는 `DATETIME(6) DEFAULT CURRENT_TIMESTAMP`는 실패한다(1067); PostgreSQL 17: 0~6자리. `timestamp(7)`은 6이 된다. 초과 자릿수는 반올림한다; SQLite: 텍스트. `strftime('%f')`는 소수 세 자리이며 `CURRENT_TIMESTAMP`는 소수가 없다; Probe: `mysql.datetime.max_precision`, `mysql.datetime.fraction_rounds`, `mysql.datetime.default_precision_must_match`, `postgres.timestamp.precision_capped`, `postgres.timestamp.fraction_rounds`, `sqlite.datetime.now_is_utc`; 결정과 중립 rendering: **Decision:** precision은 0~6이다. 클라이언트가 선언한 자리 뒤의 0이 아닌 숫자를 어떤 statement보다 먼저 `CODEC_ENCODE`로 거부하고 그 자리의 0은 받아서 버리므로(conformance vector `datetime_precision_rejected`) 데이터베이스 반올림은 쓰지 않는다; Introspection: MySQL `DATETIME_PRECISION`, PostgreSQL `datetime_precision`, SQLite 타입 텍스트
- **DIA-55** `DATETIME` / `timestamp` — MySQL 8.4: `DATETIME`은 쓴 wall clock 값을 유지하고 offset이 있는 리터럴을 session 시간대로 변환한다. 0001-01-01부터 9999-12-31까지 받는다. `TIMESTAMP`는 session 시간대와 UTC 사이를 변환하며 UTC 1970-01-01 00:00:01부터 2038-01-19 03:14:07까지만 받는다(1292); PostgreSQL 17: `timestamp`는 리터럴의 offset을 버린다. `timestamptz`는 시점을 저장하고 session 시간대로 표시한다. 0001-01-01, 9999-12-31, `infinity`를 받는다; SQLite: 타입이 없으며 텍스트다; Probe: `mysql.datetime.no_conversion`, `mysql.datetime.offset_literal_converted`, `mysql.datetime.range`, `mysql.timestamp.range_2038`, `mysql.timestamp.session_time_zone`, `postgres.timestamp.ignores_offset`, `postgres.timestamptz.session_time_zone`, `postgres.timestamp.range`, `mysql.render.datetime_utc_session`, `postgres.render.timestamp_utc_session`, `sqlite.render.datetime_check`; 결정과 중립 rendering: **Decision:** 0001-01-01부터 9999-12-31까지 시간대 없는 local date-time인 `datetime(p)`로 지원한다. MySQL `DATETIME(p)`, PostgreSQL `timestamp(p)`, SQLite는 소수 p자리의 `YYYY-MM-DD HH:MM:SS` 텍스트 `DATETIME`과 renderer CHECK(길이, `datetime()`, 24 미만의 시, 숫자). 모든 연결은 UTC로 읽고 쓴다. 시간대 정보가 있는 시점(MySQL `TIMESTAMP`, PostgreSQL `timestamptz`)은 지원하지 않는다; Introspection: MySQL `DATA_TYPE`, PostgreSQL `atttypid`(`timestamp`와 `timestamptz`), SQLite 타입과 CHECK 텍스트
- **DIA-56** 현재 시각 — MySQL 8.4: `DATETIME`의 `CURRENT_TIMESTAMP`는 session wall clock이다(`+09:00` 값은 `+00:00`보다 9시간 뒤). `NOW()`는 문장 시작 시각이다; PostgreSQL 17: `now()`는 transaction의 모든 문장에서 transaction 시작 시각이다; SQLite: `datetime('now')`와 `CURRENT_TIMESTAMP`는 UTC이며 `'now'`는 한 문장 안에서 같다; Probe: `mysql.current_timestamp.session_time_zone`, `mysql.now.precision_truncates`, `mysql.now.compare_six_digits`, `postgres.now.transaction_start`, `postgres.now.precision_rounds`, `postgres.now.compare_six_digits`, `sqlite.datetime.now_is_utc`; 결정과 중립 rendering: **Decision:** statement의 clock 값은 하나이며, 쓸 때 자르고 비교할 때 여섯 자리를 유지한다([protocol](protocol.ko.md) "Clock"). MySQL은 자르는 `CURRENT_TIMESTAMP(p)`를 쓰고(`mysql.now.precision_truncates`) `NOW(6)`와 비교한다(`mysql.now.compare_six_digits`). PostgreSQL은 `timestamp(p < 6)`에 반올림하므로(`postgres.now.precision_rounds`) 클라이언트가 쓰는 모든 clock에 p로 자른 `now` slot을, `now` value function에 여섯 자리 slot을 bind한다(`postgres.now.compare_six_digits`). SQLite도 `now` slot을 같은 방식으로 bind하고 clock과 비교하는 `datetime(p < 6)` 컬럼을 여섯 자리로 늘린다; Introspection: 기본값 텍스트(기본값 참조)

시간대 결정(owner: UTC 연결 규칙을 가진 local date-time):

- **DIA-57** **정의.** `datetime(p)`는 시간대 정보가 없는 wall clock date-time이다. 실행 규칙은 모든 연결이 UTC로 읽고 쓰는 것이다. 클라이언트는 각 연결에서 MySQL `time_zone='+00:00'`, PostgreSQL `TimeZone='UTC'`를 설정하고, offset이 있는 값은 bind 전에 UTC로 변환하며, offset 리터럴을 보내지 않는다. SQLite는 클라이언트가 쓴 UTC 텍스트 형식을 저장한다. 시간대 없는 date-time을 주는 driver(PyMySQL, psycopg)는 연결 시간대의 wall clock을 주므로, 클라이언트는 그 값을 연결 시간대로 읽으며 process의 지역 시간대로 읽지 않는다. 그래서 모든 읽기와 optimistic `updated_ts` 비교의 결과는 process의 시간대와 무관하다. 프로그램이 bind로 넘기는 시간대 없는 date-time, 곧 Rust `NaiveDateTime`과 같은 시간대 없는 Python `datetime`도 연결 시간대(UTC)의 wall clock이다. PHP를 뺀 모든 클라이언트는 process 시간대를 `TZ`에서 얻고, PHP는 `TZ`를 읽지 않고 `date.timezone`에서 얻는다. database client를 실행하는 모든 검사는 Makefile의 `TEST_TZ`(`Asia/Seoul`)로 client를 실행한다. `WITH_TEST_ENV`가 `TZ`를 export하고, `TZ`로 `date.timezone`을 정하는 `tests/timezone/date.ini`를 PHP ini scan 경로에 더하며, conformance checker는 PHP runner에 `-d date.timezone`을 넘긴다. 그러면 값을 지역 시각으로 읽는 클라이언트는 UTC machine에서도 실패한다.
- **이유.** 모든 catalog에서 타입을 정확히 복원한다. 0001-01-01부터 9999-12-31까지의 범위를 세 데이터베이스가 받는다(`mysql.datetime.range`, `postgres.timestamp.range`). UTC 규칙에서 시각 함수가 일치한다. MySQL `NOW(6)`는 `UTC_TIMESTAMP(6)`와 같고(`mysql.render.datetime_utc_session`), PostgreSQL `CURRENT_TIMESTAMP`를 `timestamp`로 cast한 값은 `now() AT TIME ZONE 'UTC'`와 같으며(`postgres.render.timestamp_utc_session`), SQLite `'now'`는 UTC다(`sqlite.datetime.now_is_utc`). Offset 리터럴은 MySQL이 변환하고 PostgreSQL이 버리므로(`mysql.datetime.offset_literal_converted`, `postgres.timestamp.ignores_offset`) 클라이언트는 이를 보내지 않는다.
- **DIA-58** **결과.** 데이터베이스는 UTC 규칙을 검사하지 않는다. 다른 시간대의 session을 쓰는 ORM 밖의 writer는 오류 없이 다른 wall clock을 저장하며 raw SQL도 같은 규칙을 따라야 한다. 시간대 정보가 있는 시점은 지원하지 않으므로 MySQL `TIMESTAMP`의 1970~2038 한도(`mysql.timestamp.range_2038`)는 적용되지 않는다. 채택하지 않은 선택지는 모든 데이터베이스에서 그 범위로 제한한 시점, 그리고 introspection이 복원할 수 없는 MySQL `DATETIME`과 PostgreSQL `timestamptz` rendering이다.
- **DIA-59** **기존 컬럼.** dbspec introspection은 PostgreSQL `timestamptz` 컬럼을 미지원으로 보고하므로, schema를 introspect하기 전에 그 컬럼을 변환한다. `ALTER TABLE … ALTER COLUMN c TYPE timestamp(p) USING c AT TIME ZONE 'UTC'`는 각 시점의 UTC wall clock을 유지한다(`postgres.render.timestamptz_conversion`). MySQL `TIMESTAMP` 컬럼은 `+00:00` session에서 `MODIFY`로 `DATETIME(p)`로 변환한다(`mysql.render.timestamp_conversion`). 호환 mapping은 없다. 남아 있는 `timestamptz`나 `TIMESTAMP` 컬럼은 introspection이 미지원으로 보고한다.
- **DIA-222** 행을 유지하며 column의 type을 바꾸기 — MySQL 8.4: 각 값을 변환하는 `ALTER TABLE … MODIFY c <type>`; PostgreSQL 17: `ALTER TABLE … ALTER COLUMN c TYPE <type> USING <expression>`; SQLite: column의 type을 바꾸는 문이 없으므로, 새 type의 column을 가진 새 table이 행을 받는다(`CREATE TABLE`, `INSERT … SELECT`, `DROP TABLE`, `ALTER TABLE … RENAME TO`). 선언한 type은 복사되는 각 값을 변환하는 affinity만 정한다(DIA-38). 변경 전에 prepare한 문은 MySQL과 SQLite에서 다시 실행되고, PostgreSQL에서는 result type이 바뀐 prepared statement가 실패한다(CFG-28).

출처: [MySQL date and time types](https://dev.mysql.com/doc/refman/8.4/en/date-and-time-types.html), [MySQL DATETIME and TIMESTAMP](https://dev.mysql.com/doc/refman/8.4/en/datetime.html), [MySQL TIME](https://dev.mysql.com/doc/refman/8.4/en/time.html), [MySQL time zone support](https://dev.mysql.com/doc/refman/8.4/en/time-zone-support.html), [PostgreSQL date/time types](https://www.postgresql.org/docs/17/datatype-datetime.html), [PostgreSQL current date/time](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT), [SQLite date and time functions](https://www.sqlite.org/lang_datefunc.html).

### Null, defaults, identity and generated columns

- **DIA-60** NOT NULL — MySQL 8.4: 기본값 없는 NOT NULL 컬럼을 생략하면 실패한다(1364); PostgreSQL 17: 실패한다(23502); SQLite: 실패한다. rowid table의 INTEGER가 아닌 PRIMARY KEY 컬럼은 NOT NULL을 선언하지 않으면 NULL을 받는다; Probe: `mysql.not_null.missing_value_rejected`, `postgres.not_null.missing_value_rejected`, `sqlite.not_null.missing_value_rejected`, `sqlite.pk.nullable_non_integer`; 결정과 중립 rendering: **Decision:** 지원한다. Primary key 컬럼은 모든 데이터베이스에서 `NOT NULL`을 명시해 생성한다; Introspection: MySQL `IS_NULLABLE`, PostgreSQL `attnotnull`, SQLite `pragma_table_info.notnull`
- **DIA-61** 리터럴 기본값 — MySQL 8.4: `COLUMN_DEFAULT`는 따옴표 없는 리터럴이다. `TEXT`/`BLOB` 기본값은 `DEFAULT ('x')`가 필요하며 `DEFAULT_GENERATED`와 함께 `_utf8mb4\'x\'`로 기록한다; PostgreSQL 17: `pg_get_expr`는 cast를 추가한다: `'x'::character varying`, `'y'::text`; SQLite: `dflt_value`는 쓴 텍스트다: `'x'`, `0`; Probe: `mysql.default.catalog_text`, `mysql.text.literal_default_needs_expression`, `postgres.default.catalog_text`, `sqlite.default.catalog_text`; 결정과 중립 rendering: **Decision:** 컬럼의 중립 타입 리터럴을 지원한다. Introspection은 dialect별 catalog 형식을 리터럴로 정규화한다. MySQL `text` 리터럴은 식 형식을 쓴다; Introspection: MySQL `COLUMN_DEFAULT`와 `EXTRA`, PostgreSQL `pg_attrdef`와 `pg_get_expr`, SQLite `pragma_table_info.dflt_value`
- **DIA-62** 식 기본값 — MySQL 8.4: `DEFAULT (expr)`, 예: `(uuid())`, `DEFAULT_GENERATED`로 기록한다; PostgreSQL 17: 모든 식을 정규화한다: `(1 + 1)`, `now()`, `CURRENT_TIMESTAMP`; SQLite: 괄호가 있는 `DEFAULT (expr)`만 받는다. 바깥 괄호를 뺀 쓴 텍스트를 유지한다; Probe: `mysql.default.catalog_text`, `postgres.default.catalog_text`, `sqlite.default.catalog_text`, `sqlite.default.expression_needs_parentheses`; 결정과 중립 rendering: **Decision:** 시간 결정에 따른 시각 기본값만 지원한다. UUID 생성기(MySQL `uuid()`, PostgreSQL `gen_random_uuid()`, SQLite 없음)를 포함한 다른 식 기본값은 지원하지 않는다. binary log가 켜진 MySQL 8.4는 `(uuid())`처럼 결정적이지 않은 기본값을 둔 `ALTER TABLE … ADD COLUMN`을 `binlog_format=ROW`에서도 error 1674로 거부한다. 그 문장이 표의 행을 채우고 replica는 다른 값을 계산하기 때문이다. `CREATE TABLE`은 받고, MariaDB 11.8은 둘 다 받는다; Introspection: 리터럴 기본값과 같다
- **DIA-63** 자동 key — MySQL 8.4: Key 컬럼의 `AUTO_INCREMENT`(아니면 1075). 명시한 더 큰 key는 counter를 올린다. Rollback한 insert는 간격을 남긴다; PostgreSQL 17: `GENERATED BY DEFAULT AS IDENTITY`는 명시한 key 뒤로 진행하지 않아 다음 생성 key가 충돌한다(23505). `ALWAYS`는 명시한 key를 거부한다(428C9). `serial`은 identity가 아닌 sequence 기본값이다. Rollback은 간격을 남긴다; SQLite: `INTEGER PRIMARY KEY AUTOINCREMENT`는 `INTEGER PRIMARY KEY`에만 쓸 수 있다. 명시한 key는 counter를 올린다. Rollback은 간격을 남기지 않는다. `AUTOINCREMENT`가 없으면 삭제한 가장 큰 key를 다시 쓴다; Probe: `mysql.auto_increment.explicit_value_advances`, `mysql.auto_increment.rollback_leaves_gap`, `mysql.auto_increment.requires_key`, `postgres.identity.by_default_not_advanced`, `postgres.identity.always_rejects_explicit`, `postgres.identity.rollback_leaves_gap`, `postgres.serial.sequence_default`, `sqlite.autoincrement.explicit_value_advances`, `sqlite.autoincrement.rollback_no_gap`, `sqlite.rowid.reused_without_autoincrement`, `sqlite.autoincrement.integer_only`; 결정과 중립 rendering: **Decision:** 생략하면 생성하는 단일 컬럼 부호 있는 `i64` primary key로 지원한다. MySQL `BIGINT AUTO_INCREMENT`, PostgreSQL `bigint GENERATED BY DEFAULT AS IDENTITY`, SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`. Key는 다시 쓰지 않는다. 클라이언트는 이 컬럼의 명시 값을 거부하며, PostgreSQL에서 명시 key를 쓰는 apply 단계는 identity sequence를 가장 큰 key로 맞춘다. 간격은 의미에 포함하지 않는다; Introspection: MySQL `EXTRA` `auto_increment`, PostgreSQL `attidentity`/`identity_generation`, SQLite `sqlite_master.sql`의 `AUTOINCREMENT`와 `sqlite_sequence`
- **DIA-64** 생성 컬럼 — MySQL 8.4: `VIRTUAL`과 `STORED`. 식을 정규화해 기록한다(예: ``(`a` + 1)``). 명시 값은 실패한다(3105); PostgreSQL 17: 17은 `STORED`만 있다(`VIRTUAL`은 42601). `pg_get_expr`는 `(a + 1)`로 정규화한다. 명시 값은 실패한다(428C9); SQLite: `VIRTUAL`과 `STORED`. `pragma_table_xinfo.hidden`은 2 또는 3이며 식은 `sqlite_master.sql`에만 있다; Probe: `mysql.generated.catalog_expression`, `mysql.generated.explicit_value_rejected`, `postgres.generated.stored_only`, `postgres.generated.explicit_value_rejected`, `sqlite.generated.virtual_and_stored`, `sqlite.generated.explicit_value_rejected`; 결정과 중립 rendering: **Decision:** 지원하지 않는다. PostgreSQL 17에는 `VIRTUAL`이 없고, `STORED` 식에는 T8.1이 CHECK에만 정의하는 중립 식 집합과 dialect별 catalog 정규화가 필요하다. 어느 client도 MySQL 생성 컬럼의 식 text를 읽지 않는다. `GENERATION_EXPRESSION`은 non-ASCII literal의 UTF-8 byte를 한 번 더 인코딩한 값(`cafÃ©`)을 담고, 모든 client는 그 text를 쓰기 전에 열을 보고한다. 그래서 dbspec은 생성 컬럼을 만들지 않는다; Introspection: 미지원으로 보고한다

출처: [MySQL data type defaults](https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html), [MySQL AUTO_INCREMENT](https://dev.mysql.com/doc/refman/8.4/en/example-auto-increment.html), [MySQL generated columns](https://dev.mysql.com/doc/refman/8.4/en/create-table-generated-columns.html), [PostgreSQL CREATE TABLE](https://www.postgresql.org/docs/17/sql-createtable.html), [PostgreSQL generated columns](https://www.postgresql.org/docs/17/ddl-generated-columns.html), [SQLite CREATE TABLE](https://www.sqlite.org/lang_createtable.html), [SQLite AUTOINCREMENT](https://www.sqlite.org/autoinc.html), [SQLite generated columns](https://www.sqlite.org/gencol.html).

### Keys and indexes

- **DIA-65** Primary key — MySQL 8.4: 제약 이름을 버리고 key 이름은 `PRIMARY`다; PostgreSQL 17: 제약 이름을 유지한다; SQLite: 이름은 `sqlite_master.sql`에만 있고 index는 `sqlite_autoindex_<table>_1`이다; Probe: `mysql.pk.name_is_primary`, `postgres.pk.name_kept`, `sqlite.pk.name_not_reported`; 결정과 중립 rendering: **Decision:** 이름 없이 지원한다. PostgreSQL은 기본 이름 `<table>_pkey`를 쓰고 SQLite는 제약 이름을 쓰지 않는다; Introspection: MySQL `STATISTICS` index `PRIMARY`, PostgreSQL `pg_constraint` `contype='p'`, SQLite `pragma_table_info.pk`
- **DIA-66** Unique key — MySQL 8.4: NULL 여러 개 허용; PostgreSQL 17: `NULLS NOT DISTINCT`가 아니면 NULL 여러 개 허용(23505); SQLite: NULL 여러 개 허용; Probe: `mysql.unique.nulls_distinct`, `postgres.unique.nulls_not_distinct_option`, `sqlite.unique.nulls_distinct`; 결정과 중립 rendering: **Decision:** 서로 다른 NULL로 지원한다. `NULLS NOT DISTINCT`는 지원하지 않는다; Introspection: MySQL `STATISTICS.NON_UNIQUE=0`, PostgreSQL `pg_index.indisunique`와 `pg_constraint`, SQLite `pragma_index_list.unique`/`origin`
- **DIA-67** Key 순서 — MySQL 8.4: `DESC`를 저장한다(`COLLATION` `D`); PostgreSQL 17: `DESC`를 저장한다(`pg_get_indexdef`); SQLite: `DESC`를 저장한다(`pragma_index_xinfo.desc`); Probe: `mysql.index.descending`, `postgres.index.descending_partial_expression`, `sqlite.index.descending`; 결정과 중립 rendering: **Decision:** 컬럼별 오름차순·내림차순을 지원한다. NULLS FIRST/LAST 선택지는 없다; Introspection: 표에 적은 대로
- **DIA-68** Prefix key — MySQL 8.4: `v(10)`을 `SUB_PART`로 기록한다; PostgreSQL 17: 해당 문법이 없다(42883); SQLite: 해당 문법이 없다; Probe: `mysql.index.prefix`, `postgres.index.prefix_rejected`; 결정과 중립 rendering: **Decision:** 지원하지 않는다; Introspection: MySQL `SUB_PART`는 미지원으로 보고한다
- **DIA-69** Partial index — MySQL 8.4: 없다(1064); PostgreSQL 17: `WHERE` 조건(`pg_index.indpred`); SQLite: `WHERE` 조건(`pragma_index_list.partial`, 텍스트는 `sqlite_master.sql`); Probe: `mysql.index.partial_rejected`, `postgres.index.descending_partial_expression`, `sqlite.index.partial_expression`; 결정과 중립 rendering: **Decision:** 지원하지 않는다; Introspection: 미지원으로 보고한다
- **DIA-70** 식 index — MySQL 8.4: Functional key part: `COLUMN_NAME` NULL, 정규화한 `EXPRESSION`; MariaDB 11.8: functional key part가 없으므로(1064) `COLUMN_NAME`은 NULL이 아니고, `STATISTICS`에는 `EXPRESSION` column이 없다(1054); PostgreSQL 17: 식 key(`pg_index.indkey` 0); SQLite: 식 key(`pragma_index_info.cid` -2, 이름 NULL); Probe: `mysql.index.functional`, `mariadb.index.functional`, `postgres.index.descending_partial_expression`, `sqlite.index.partial_expression`; 결정과 중립 rendering: **Decision:** 생성 컬럼과 같은 이유로 지원하지 않는다; Introspection: 미지원으로 보고한다. key part는 `COLUMN_NAME`이 NULL일 때 functional이며, 이는 MySQL과 MariaDB가 같은 결과로 읽는 한 형식이다(DIA-200, 규칙 1). MariaDB는 vector `mysql-functional-index`의 statement를 거부하므로(1064), recipe dbspec_introspect의 case `mysql_functional_index`는 그 거부, 곧 server의 답을 `mariadb` 결과로 적는다(DIA-200, 규칙 4)
- **DIA-71** Full-text index — MySQL 8.4: `FULLTEXT` index; PostgreSQL 17: 해당 index가 없고 `to_tsvector` 식에 대한 GIN을 쓴다; SQLite: FTS5 virtual table만 있다; Probe: (manual); 결정과 중립 rendering: **Decision:** 지원하지 않는다. SQLite에는 table의 full-text index가 없고 PostgreSQL 형식은 식 index다; Introspection: 미지원으로 보고한다
- **DIA-72** Key 길이 — MySQL 8.4: Index key는 3072바이트 이하다. utf8mb4 `varchar(768)`은 받고 `varchar(769)`는 거부한다(1071); PostgreSQL 17: 2704바이트를 넘는 B-tree 항목은 insert에서 실패한다(54000). 4바이트 문자 640개는 들어간다; SQLite: 한도가 없다; Probe: `mysql.index.max_key_bytes`, `postgres.index.btree_entry_limit`, `postgres.index.varchar_640_four_byte_fits`; 결정과 중립 rendering: **Decision:** 한 index의 `varchar` 컬럼 선언 길이 합은 640자 이하다. utf8mb4로 2560바이트이며 두 한도 안에 있다. `postgres.index.varchar_640_four_byte_fits`는 아직 실행하지 않았다; Introspection: 해당 없음
- **DIA-73** Index와 unique 이름 — MySQL 8.4: Index 이름은 table 범위이고 64자 이하다(1059). `PRIMARY`는 예약어다(1280); PostgreSQL 17: Index와 unique 제약 이름은 schema 이름공간을 공유한다(42P07); SQLite: Index 이름은 database에서 고유하다; Probe: `mysql.index.name_table_scope`, `mysql.index.name_max_length`, `mysql.index.primary_name_reserved`, `postgres.index.name_schema_scope`, `postgres.unique.name_schema_scope`, `sqlite.index.name_database_scope`; 결정과 중립 rendering: **Decision:** 이름은 아래 식별자 규칙을 따르고 index와 unique key 전체에서 schema 안에 고유하다. `primary`는 유효한 이름이 아니다; Introspection: MySQL `STATISTICS.INDEX_NAME`, PostgreSQL index의 `pg_class`, SQLite `pragma_index_list.name`

출처: [MySQL CREATE INDEX](https://dev.mysql.com/doc/refman/8.4/en/create-index.html), [MySQL InnoDB limits](https://dev.mysql.com/doc/refman/8.4/en/innodb-limits.html), [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html), [PostgreSQL partial indexes](https://www.postgresql.org/docs/17/indexes-partial.html), [PostgreSQL unique indexes](https://www.postgresql.org/docs/17/indexes-unique.html), [SQLite CREATE INDEX](https://www.sqlite.org/lang_createindex.html), [SQLite partial indexes](https://www.sqlite.org/partialindex.html), [SQLite expression indexes](https://www.sqlite.org/expridx.html), [SQLite FTS5](https://www.sqlite.org/fts5.html).

### Foreign keys

- **DIA-74** 동작 — MySQL 8.4: `RESTRICT`, `NO ACTION`(둘 다 즉시), `CASCADE`, `SET NULL`. Catalog는 생략한 동작을 `NO ACTION`으로, 쓴 동작은 쓴 대로 기록한다; PostgreSQL 17: 모든 동작. `NO ACTION`은 문장 끝에, `RESTRICT`는 즉시 검사한다; SQLite: 모든 동작. `NO ACTION`은 문장 끝에, `RESTRICT`는 즉시 검사한다; Probe: `mysql.fk.rule_catalog`, `mysql.fk.restrict_row_order`, `sqlite.fk.restrict_row_order`, `postgres.fk.restrict_statement_end`; 결정과 중립 rendering: **Decision:** delete와 update에 `restrict`, `cascade`, `set_null`을 지원하며 명시 keyword `RESTRICT`, `CASCADE`, `SET NULL`로 생성한다. MySQL은 `NO ACTION`을 즉시 검사하므로 `NO ACTION`은 지원하지 않는다. 하나의 `DELETE`가 참조되는 행과 그 행을 참조하는 행을 함께 지우면, MySQL과 SQLite는 참조되는 행이 행 순서에서 먼저 나올 때 거부하고 PostgreSQL은 받아들인다; 이식 가능한 코드는 참조하는 행을 먼저 지운다.; Introspection: MySQL `REFERENTIAL_CONSTRAINTS.UPDATE_RULE`/`DELETE_RULE`, PostgreSQL `pg_constraint.confupdtype`/`confdeltype`, SQLite `pragma_foreign_key_list.on_update`/`on_delete`
- **DIA-75** `SET DEFAULT` — MySQL 8.4: 받아서 기록하지만 부모 삭제는 실패한다(1451); MariaDB 11.8: InnoDB는 `SET DEFAULT`를 받아 `REFERENTIAL_CONSTRAINTS`에 `RESTRICT`로 기록하고 부모 삭제를 거부한다(1451); PostgreSQL 17: 지원한다; SQLite: 지원한다; Probe: `mysql.fk.set_default_acts_as_restrict`, `mariadb.fk.set_default_acts_as_restrict`, `postgres.fk.set_default`; 결정과 중립 rendering: **Decision:** 지원하지 않는다; Introspection: 미지원으로 보고한다. MariaDB에는 읽을 `SET DEFAULT`가 남지 않으므로 그 introspection은 server가 기록한 `restrict` key를 읽고, `tests/dbspec/introspect.json`의 vector `mysql-fk-set-default`는 그 key와 미지원 객체 없음을 `mariadb` 결과로 적는다(DIA-200, 규칙 4)
- **DIA-76** Deferrable — MySQL 8.4: 없다(1064); PostgreSQL 17: `DEFERRABLE INITIALLY DEFERRED`는 COMMIT에서 검사한다(23503); SQLite: 같다; Probe: `mysql.fk.deferrable_rejected`, `postgres.fk.deferrable`, `sqlite.fk.deferrable`; 결정과 중립 rendering: **Decision:** 지원하지 않는다. 순환은 nullable 컬럼과 이후 update로 만든다; Introspection: 미지원으로 보고한다
- **DIA-77** `MATCH` — MySQL 8.4: `MATCH FULL`은 `MATCH_OPTION FULL`로 기록하지만 `SHOW CREATE TABLE`에서 빠지며 검사하지 않는다; PostgreSQL 17: `MATCH FULL`은 일부가 NULL인 key를 거부한다(23503); SQLite: 받지만 `NONE`으로 기록하고 검사하지 않는다; Probe: `mysql.fk.match_full_not_enforced`, `postgres.fk.match_full`, `sqlite.fk.match_not_enforced`; 결정과 중립 rendering: **Decision:** 기본 `MATCH SIMPLE`만 지원한다; Introspection: MySQL `MATCH_OPTION`, PostgreSQL `confmatchtype`, SQLite `pragma_foreign_key_list.match`
- **DIA-78** 검사 스위치 — MySQL 8.4: 항상 켜져 있다; PostgreSQL 17: 항상 켜져 있다; SQLite: 각 연결에서 `PRAGMA foreign_keys = ON` 전까지 꺼져 있으며 transaction 안에서는 무시한다; Probe: `sqlite.fk.off_by_default`, `sqlite.fk.pragma_ignored_in_transaction`; 결정과 중립 rendering: **Decision:** 모든 SQLite 연결이 첫 transaction 전에 `foreign_keys`를 켠다는 규칙으로 지원한다(Go DSN pragma, PHP `PRAGMA`, Node `node:sqlite`와 sqlx 기본값이 켠다); Introspection: 연결별 `PRAGMA foreign_keys`
- **DIA-79** 자식 index — MySQL 8.4: 제약 이름을 따른 index를 자식 컬럼에 만든다; PostgreSQL 17: 없다; SQLite: 없다; Probe: `mysql.fk.child_index_created`, `postgres.fk.no_child_index`; 결정과 중립 rendering: **Decision:** foreign key는 자식 컬럼으로 시작하는 index를 명시적으로 선언해야 한다. 그러면 MySQL은 그 index를 쓰고 새로 만들지 않는다; Introspection: Index catalog
- **DIA-80** 컬럼 타입 — MySQL 8.4: 자식과 부모 타입이 같아야 한다(3780); PostgreSQL 17: `integer`가 `bigint`를 참조할 수 있다; SQLite: 검사하지 않는다; Probe: `mysql.fk.type_mismatch_rejected`, `postgres.fk.type_mismatch_allowed`; 결정과 중립 rendering: **Decision:** 자식 컬럼 타입은 참조 컬럼 타입과 같다; Introspection: 컬럼 catalog
- **DIA-81** 이름 — MySQL 8.4: Database에서 고유하다(1826); PostgreSQL 17: Table 범위다; SQLite: `pragma_foreign_key_list`에 없고 `sqlite_master.sql`에 남는다; Probe: `mysql.fk.name_schema_scope`, `sqlite.fk.names_not_reported`; 결정과 중립 rendering: **Decision:** 이름을 가지며 schema 전체에서 고유하다. SQLite introspection은 `CREATE TABLE` 텍스트에서 이름을 읽는다; Introspection: MySQL `REFERENTIAL_CONSTRAINTS.CONSTRAINT_NAME`, PostgreSQL `pg_constraint.conname`, SQLite `sqlite_master.sql`
- **DIA-82** Cascade 행의 trigger — MySQL 8.4: Cascade로 바뀐 행에서 trigger가 실행되지 않는다; PostgreSQL 17: 실행된다; SQLite: 실행된다; Probe: `mysql.fk.cascade_skips_triggers`, `postgres.fk.cascade_fires_triggers`, `sqlite.fk.cascade_fires_triggers`; 결정과 중립 rendering: Trigger 참조; Introspection: 해당 없음

출처: [MySQL FOREIGN KEY constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html), [PostgreSQL foreign keys](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK), [SQLite foreign key support](https://www.sqlite.org/foreignkeys.html), [SQLite PRAGMA foreign_keys](https://www.sqlite.org/pragma.html#pragma_foreign_keys).

### CHECK constraints

- **DIA-83** 검사 — MySQL 8.4: 검사한다(3819). NULL은 통과한다. `NOT ENFORCED`는 검사하지 않는 제약을 저장한다; PostgreSQL 17: 검사한다(23514). NULL은 통과한다. `NOT VALID`는 위반 행을 유지한다; SQLite: 검사하며 NULL은 통과한다; Probe: `mysql.check.enforced_null_passes`, `mysql.check.not_enforced_option`, `postgres.check.enforced_null_passes`, `postgres.check.not_valid`, `sqlite.check.enforced_null_passes`; 결정과 중립 rendering: **Decision:** 검사하고 검증한 제약을 지원한다. `NOT ENFORCED`와 `NOT VALID`는 지원하지 않는다; Introspection: MySQL `TABLE_CONSTRAINTS.ENFORCED`, PostgreSQL `convalidated`
- **DIA-84** 식 텍스트 — MySQL 8.4: `CHECK_CLAUSE`는 정규화한다: ``(`a` in (1,2))``, 문자열 리터럴에 `_utf8mb4` introducer와 두 번의 escape, `NOT`은 부정하는 비교로 바꿔 씀(De Morgan), `BETWEEN`은 유지, 음수 literal은 `-(n)`. bool column 하나는 거부한다(3812); PostgreSQL 17: `pg_get_constraintdef`는 `IN`을 cast가 있는 `= ANY (ARRAY[...])`로, `BETWEEN`을 비교 두 개로, `NOT BETWEEN`을 그 부정으로 바꾸고 `NOT`은 유지한다; SQLite: `sqlite_master.sql`에 쓴 그대로만 남는다; Probe: `mysql.check.catalog_text`, `mysql.check.alter_rewrites_introducers`, `mysql.check.alter_writes_time_precision`, `mysql.check.not_pushed_down`, `mysql.check.between_kept`, `mysql.check.string_escaped_twice`, `mysql.check.bool_column_rejected`, `postgres.check.normalized_text`, `postgres.check.between_rewritten`, `postgres.check.not_kept`, `sqlite.check.text_verbatim`; 결정과 중립 rendering: **Decision:** [dbspec](dbspec.md#checks)의 predicate 형식에 지원한다. MySQL이나 PostgreSQL이 바꿔 쓰거나 거부하므로 `not`, `between`, column 하나는 형식에서 뺀다. Renderer가 dialect별 텍스트를 쓰고, introspection은 catalog 텍스트가 생성한 식의 해당 dialect 정규형과 같을 때만 제약을 받아들인다. MySQL 8.4는 non-ASCII literal을 가진 `CHECK_CLAUSE`를 UTF-8 bytes를 한 번 더 인코딩해 쓰므로, introspection은 그런 제약의 본문을 바르게 쓰는 `SHOW CREATE TABLE`에서 읽고 `CHECK_CLAUSE`와 같은 형식으로 escape한다; Introspection: MySQL `CHECK_CONSTRAINTS.CHECK_CLAUSE`, PostgreSQL `pg_get_constraintdef`, SQLite `sqlite_master.sql`
- **DIA-85** 비결정 함수 — MySQL 8.4: DDL에서 거부한다(3814); PostgreSQL 17: 허용한다; SQLite: 평가할 때 거부한다; Probe: `mysql.check.nondeterministic_rejected`, `postgres.check.nondeterministic_allowed`, `sqlite.check.nondeterministic_rejected`; 결정과 중립 rendering: **Decision:** 중립 식 집합에는 시각, 난수, session 함수가 없다; Introspection: 해당 없음
- **DIA-86** FK 동작 컬럼 — MySQL 8.4: 참조 동작이 있는 foreign key 컬럼은 CHECK에 쓸 수 없다(3823); PostgreSQL 17: 허용한다; SQLite: 허용한다; Probe: `mysql.check.fk_action_column_rejected`; 결정과 중립 rendering: **Decision:** dbspec은 `cascade`나 `set_null` foreign key의 컬럼을 쓰는 CHECK를 거부한다; Introspection: 해당 없음
- **DIA-87** Fault 순서 — MySQL 8.4: CHECK와 unique key를 함께 어긴 행은 CHECK fault로 거부한다(3819). Foreign key는 행마다 검사하므로 첫 행이 둘째 행을 참조하는 `INSERT` 하나를 거부한다(1452); PostgreSQL 17: CHECK fault로 거부한다(23514). Foreign key는 statement 끝에 검사하므로 그 `INSERT`를 받아들인다; SQLite: CHECK fault로 거부한다. Foreign key는 statement 끝에 검사하므로 그 `INSERT`를 받아들인다; Probe: `mysql.fault.check_before_unique`, `mysql.fault.fk_statement_end`, `postgres.fault.check_before_unique`, `postgres.fault.fk_statement_end`, `sqlite.fault.check_before_unique`, `sqlite.fault.fk_statement_end`; 결정과 중립 rendering: **Decision:** fault가 여럿인 statement는 모든 database에서 한 행의 CHECK fault를 그 행의 key fault보다 먼저 보고한다. PostgreSQL과 SQLite는 foreign key를 statement 끝에, MySQL은 행마다 보고한다. SQL statement는 오류 하나를 보고하며, fault 여럿을 나열하는 executor는 이 규칙의 순서를 따른다; Introspection: 해당 없음
- **DIA-88** 이름 — MySQL 8.4: Database에서 고유하다(3822); PostgreSQL 17: Table 범위다; SQLite: 검사하지 않으며 한 table의 두 제약이 같은 이름을 쓸 수 있다; Probe: `mysql.check.name_schema_scope`, `postgres.check.name_table_scope`, `sqlite.constraint.duplicate_names_accepted`; 결정과 중립 rendering: **Decision:** 이름을 가지며 schema 전체에서 고유하다; Introspection: 식 텍스트와 같다

출처: [MySQL CHECK constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html), [PostgreSQL check constraints](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS), [PostgreSQL catalog information functions](https://www.postgresql.org/docs/17/functions-info.html), [SQLite CREATE TABLE CHECK](https://www.sqlite.org/lang_createtable.html#ckconst), [SQLite deterministic functions](https://www.sqlite.org/deterministic.html).

### Comments, collation and identifiers

- **DIA-89** Comment — MySQL 8.4: `COMMENT` 절: 컬럼은 1024자 이하(1629), table은 2048자 이하(1628); PostgreSQL 17: 실질 한도가 없는 `COMMENT ON`(5000자 저장); SQLite: Comment 객체가 없다. SQL 주석은 `CREATE TABLE` 텍스트 안에 남는다; Probe: `mysql.comment.column_limit`, `mysql.comment.table_limit`, `postgres.comment.unlimited`, `sqlite.comment.no_object`; 결정과 중립 rendering: **Decision:** 물리 객체로 지원하지 않는다. SQLite는 ORM 소유 table이나 DDL 텍스트 안에만 comment를 둘 수 있으며 둘 다 표식이다. 설명은 dbspec 문서에 남고 생성하지 않는다; Introspection: MySQL과 PostgreSQL comment는 미지원으로 보고한다
- **DIA-90** Collation — MySQL 8.4: 기본 utf8mb4 collation `utf8mb4_0900_ai_ci`는 unique key에서 `a`, `A`, `á`를 같게 본다(1062). `utf8mb4_bin`은 PAD SPACE다(`a` = `a `). `utf8mb4_0900_bin`은 NO PAD이며 code point 순서다; PostgreSQL 17: 여기서는 database collation `C`: 대소문자·악센트·공백을 구분하고 code point 순서다. 컬럼은 `COLLATE "C"`를 선언할 수 있다; SQLite: 기본 `BINARY`: byte 순서. `NOCASE`는 ASCII만 접는다; Probe: `mysql.collation.default_accent_case_insensitive`, `mysql.collation.utf8mb4_bin_pads`, `mysql.collation.utf8mb4_0900_bin_codepoint`, `postgres.collation.c_codepoint`, `sqlite.collation.binary_codepoint`, `sqlite.collation.nocase_ascii_only`; 결정과 중립 rendering: **Decision:** binary code point 순서 collation 하나만 지원한다. MySQL `CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`, PostgreSQL은 database 기본값과 관계없이 모든 text 컬럼에 `COLLATE "C"`, SQLite `BINARY`. 다른 collation은 지원하지 않는다. `postgres.collation.c_codepoint`의 `COLLATE "C"` 컬럼 catalog 확인은 아직 실행하지 않았다; Introspection: MySQL `COLUMNS.COLLATION_NAME`, PostgreSQL `pg_attribute.attcollation`, SQLite `sqlite_master.sql`의 `COLLATE`
- **DIA-91** 식별자 길이 — MySQL 8.4: 64자 이하(1059); PostgreSQL 17: 더 긴 이름은 notice와 함께 63바이트로 잘리며 63바이트까지 같은 이름은 충돌한다(42P07); SQLite: 한도가 없다; Probe: `mysql.ident.max_length`, `mysql.index.name_max_length`, `postgres.ident.truncated_to_63`, `sqlite.ident.no_length_limit`; 결정과 중립 rendering: **Decision:** 이름은 `[a-z][a-z0-9_]*`이며 63바이트 이하다. 더 긴 이름은 줄이거나 바꾸지 않고 거부한다; Introspection: 저장한 이름
- **DIA-92** 식별자 대소문자 — MySQL 8.4: 컬럼 이름은 대소문자를 구분하지 않는다(1060). Table 이름은 `lower_case_table_names`를 따른다(`make orm-test-servers`가 선언한 두 platform의 test 서버는 1: `Foo`는 `foo`로 저장되고 `Foo`와 `foo`가 충돌, 1050); PostgreSQL 17: 따옴표 없는 이름은 소문자로 접는다(42701). 따옴표 있는 이름은 대소문자를 구분한다; SQLite: 대소문자를 구분하지 않는다; Probe: `mysql.ident.column_case_insensitive`, `mysql.ident.table_case_server_setting`, `postgres.ident.case_folding`, `sqlite.ident.case_insensitive`; 결정과 중립 rendering: **Decision:** 소문자 이름만 쓰므로 모든 접기 규칙에서 같은 이름이 된다; Introspection: 저장한 이름
- **DIA-93** 이름 범위 — MySQL 8.4: Index: table. CHECK, FK, trigger: database; PostgreSQL 17: Index, unique 제약: schema. CHECK, FK, trigger: table; SQLite: Index, trigger: database. 제약: 검사하지 않음; Probe: `mysql.index.name_table_scope`, `mysql.check.name_schema_scope`, `mysql.fk.name_schema_scope`, `mysql.trigger.name_schema_scope`, `postgres.index.name_schema_scope`, `postgres.check.name_table_scope`, `postgres.trigger.name_table_scope`, `sqlite.index.name_database_scope`, `sqlite.trigger.name_database_scope`; 결정과 중립 rendering: **Decision:** 모든 index, 제약, trigger 이름은 schema 전체에서 고유하다; Introspection: 해당 없음
- **DIA-94** 이름공간 — MySQL 8.4: Schema는 database다; PostgreSQL 17: Database 안의 schema이며 table 이름은 schema마다 고유하다; SQLite: 한정 이름은 연결의 attach한 database를 참조한다; Probe: `postgres.namespace.relname_per_schema`, `sqlite.namespace.attached_databases`; 결정과 중립 rendering: **Decision:** schema 한정 이름은 지원하지 않는다. dbspec 문서 하나는 연결의 현재 database나 schema다; Introspection: MySQL `DATABASE()`, PostgreSQL `current_schema()`, SQLite `main`

출처: [MySQL CREATE TABLE](https://dev.mysql.com/doc/refman/8.4/en/create-table.html), [MySQL collations](https://dev.mysql.com/doc/refman/8.4/en/charset-collation-names.html), [MySQL pad attribute](https://dev.mysql.com/doc/refman/8.4/en/charset-binary-collations.html), [MySQL identifier length](https://dev.mysql.com/doc/refman/8.4/en/identifier-length.html), [MySQL identifier case](https://dev.mysql.com/doc/refman/8.4/en/identifier-case-sensitivity.html), [PostgreSQL COMMENT](https://www.postgresql.org/docs/17/sql-comment.html), [PostgreSQL collation](https://www.postgresql.org/docs/17/collation.html), [PostgreSQL identifiers](https://www.postgresql.org/docs/17/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS), [SQLite collating sequences](https://www.sqlite.org/datatype3.html#collation), [SQLite ATTACH](https://www.sqlite.org/lang_attach.html).

### Update-time stamping

- **DIA-95** 컬럼 절 — MySQL 8.4: `ON UPDATE CURRENT_TIMESTAMP`는 다른 컬럼이 바뀌면 실행되고, 값이 바뀌지 않으면 실행되지 않으며, 명시 값이 우선한다; PostgreSQL 17: 해당 절이 없다(42601); SQLite: 해당 절이 없다; Probe: `mysql.on_update.fires_on_change`, `mysql.on_update.skipped_when_unchanged`, `mysql.on_update.explicit_value_kept`, `postgres.on_update.unsupported`, `sqlite.on_update.unsupported`; 결정과 중립 rendering: **Decision:** 컬럼 절은 MySQL에만 있으므로 지원하지 않는다; Introspection: MySQL `EXTRA` `on update …`는 미지원으로 보고한다
- **DIA-96** Trigger — MySQL 8.4: `BEFORE UPDATE` row trigger는 `NEW`에 대입할 수 있고 값이 바뀌지 않아도 실행된다; PostgreSQL 17: 함수를 쓰는 `BEFORE UPDATE` row trigger는 `NEW`에 대입할 수 있고 값이 바뀌지 않아도 실행된다; SQLite: `NEW`에 대입할 수 없다. `AFTER UPDATE` trigger가 별도 `UPDATE`를 실행하며 값이 바뀌지 않아도 실행된다; Probe: `mysql.trigger.new_assignable`, `mysql.trigger.update_fires_when_unchanged`, `postgres.trigger.update_fires_when_unchanged`, `sqlite.trigger.new_read_only`; 결정과 중립 rendering: **Decision:** 기록용 trigger를 생성하지 않는다. 아래 참조; Introspection: 해당 없음

수정 시각 기록 결정(owner: 실행기 기록):

- **DIA-97** **정의.** 수정 시각 기록은 table 컬럼의 ORM mapping setting이다. 실행기는 계획하는 모든 `UPDATE`에서 UTC 문장 시각으로 컬럼을 명시적으로 대입한다. Trigger, `ON UPDATE` 절, 기본값 변경 같은 물리 객체는 만들지 않는다. 이 setting은 `schemaHash`가 아니라 `manifestHash`에 속하며 introspection은 이를 읽거나 만들지 않는다.
- **이유.** 실행기는 세 데이터베이스에서 같은 값을 쓰고, 컬럼 정의는 introspection이 정확히 복원하는 일반 `datetime(p)`로 남는다. MySQL `ON UPDATE CURRENT_TIMESTAMP`는 MySQL에만 있고 값을 바꾸지 않는 update를 건너뛰므로(`mysql.on_update.skipped_when_unchanged`) 실행기와 다르며 계속 지원하지 않는다.
- **DIA-98** **결과.** Raw SQL과 ORM 밖의 writer는 컬럼을 기록하지 않는다. Trigger 기록은 채택하지 않았다. MySQL `SUPER`나 `log_bin_trust_function_creators=ON`(`mysql.trigger.binlog_privilege_1419`), PostgreSQL 함수 객체, SQLite의 행마다 추가 쓰기(`sqlite.trigger.new_read_only`)가 필요하다.

### Triggers and audit context

- **DIA-99** 수준과 event — MySQL 8.4: Row trigger만 있다(`FOR EACH STATEMENT`는 1064). `INSERT`/`UPDATE`/`DELETE`; PostgreSQL 17: Row와 statement trigger, `TRUNCATE`도 있다; SQLite: Row trigger만 있다; Probe: `mysql.trigger.no_statement_level`, `postgres.trigger.statement_fires_on_zero_rows`, `sqlite.trigger.no_statement_level`; 결정과 중립 rendering: **Decision:** 생성하는 trigger는 `INSERT`, `UPDATE`, `DELETE`의 row trigger다; Introspection: MySQL `TRIGGERS.ACTION_TIMING`/`EVENT_MANIPULATION`/`ACTION_ORIENTATION`, PostgreSQL `pg_trigger.tgtype`, SQLite `sqlite_master.sql`
- **DIA-100** 0행 문장 — MySQL 8.4: 실행되지 않는다; PostgreSQL 17: Statement trigger는 일치하는 행이 없는 `UPDATE`에도 실행된다(P0001). Row trigger는 실행되지 않는다; SQLite: 실행되지 않는다; Probe: `mysql.trigger.zero_rows_not_fired`, `postgres.trigger.statement_fires_on_zero_rows`, `postgres.trigger.row_skips_zero_rows`, `sqlite.trigger.zero_rows_not_fired`; 결정과 중립 rendering: **Decision:** row trigger만 쓰므로 일치하는 행이 없는 문장은 실패하지 않는다; Introspection: 해당 없음
- **DIA-101** `TRUNCATE` — MySQL 8.4: Trigger event가 없다(1064). `TRUNCATE TABLE`은 `DELETE` trigger를 건너뛴다; PostgreSQL 17: `BEFORE TRUNCATE` statement trigger가 실행된다; SQLite: `TRUNCATE`가 없다. `WHERE` 없는 `DELETE`는 row trigger를 실행한다; Probe: `mysql.trigger.no_truncate_event`, `mysql.trigger.truncate_skips_delete_trigger`, `postgres.trigger.truncate_event`, `sqlite.trigger.delete_all_fires_row_triggers`; 결정과 중립 rendering: **Decision:** 생성하는 trigger는 어느 데이터베이스에서도 `TRUNCATE`를 다루지 않는다. `immutable`과 `audit`은 행 `UPDATE`와 `DELETE`만 보장하며 `TRUNCATE`는 보장 밖의 권한 작업이다; Introspection: 해당 없음
- **DIA-102** Cascade 행 — MySQL 8.4: Foreign key 동작으로 바뀐 행에서 trigger가 실행되지 않는다; PostgreSQL 17: 실행된다; SQLite: 실행된다; Probe: `mysql.fk.cascade_skips_triggers`, `postgres.fk.cascade_fires_triggers`, `sqlite.fk.cascade_fires_triggers`; 결정과 중립 rendering: **Decision:** `cascade`나 `set_null` foreign key의 자식 table에는 `audit`과 `immutable` setting을 거부한다. 따라서 모든 데이터베이스가 같은 행 변경을 관찰한다; Introspection: 해당 없음
- **DIA-103** 권한 — MySQL 8.4: Binary logging과 `log_bin_trust_function_creators=0`에서 `SUPER`가 없는 login은 trigger를 만들 수 없다(1419); PostgreSQL 17: Table의 `TRIGGER` 권한과 함수의 `EXECUTE` 권한; SQLite: 권한이 없다; Probe: `mysql.trigger.binlog_privilege_1419`; 결정과 중립 rendering: **Decision:** apply는 첫 trigger 문장 전에 권한을 확인하고 필요한 설정과 함께 실패한다; Introspection: MySQL `@@log_bin`, `@@log_bin_trust_function_creators`
- **DIA-104** Trigger 본문 객체 — MySQL 8.4: 본문이 trigger 안에 있다; PostgreSQL 17: 본문은 `pg_proc`의 별도 함수이며 `DROP TABLE` 후에도 남는다; SQLite: 본문이 trigger 안에 있다. `DROP TABLE`은 trigger도 삭제한다; Probe: `postgres.trigger.function_separate_object`, `sqlite.trigger.dropped_with_table`; 결정과 중립 rendering: **Decision:** renderer는 생성하는 PostgreSQL trigger마다 함수 하나를 소유한다. Diff와 apply는 trigger와 함께 함수를 만들고 삭제한다; Introspection: PostgreSQL `pg_proc`
- **DIA-105** `NEW` 대입 — MySQL 8.4: `BEFORE` trigger에서 허용; PostgreSQL 17: `BEFORE` row trigger에서 허용; SQLite: 허용하지 않는다; Probe: `mysql.trigger.new_assignable`, `postgres.trigger.update_fires_when_unchanged`, `sqlite.trigger.new_read_only`; 결정과 중립 rendering: 수정 시각 기록을 위한 사실; Introspection: 해당 없음
- **DIA-223** 행의 변경을 건너뛰는 trigger — MySQL 8.4: 없다; `BEFORE` row trigger는 문을 거부할 수만 있으며(`SIGNAL SQLSTATE '45000'`), 모든 client는 이를 `DRIVER`로 보고한다; PostgreSQL 17: 함수가 `NULL`을 반환하는 `BEFORE` row trigger는 그 행을 건너뛰고, 문은 그 행을 바뀌지 않은 것으로 보고한다; SQLite: `BEFORE` trigger의 `RAISE(IGNORE)`가 마찬가지로 그 행을 건너뛴다.
- **DIA-106** Catalog 텍스트 — MySQL 8.4: `ACTION_STATEMENT`는 주석을 포함해 쓴 그대로의 본문이다; PostgreSQL 17: `prosrc`는 쓴 그대로의 함수 본문이다. `pg_get_triggerdef`는 schema로 한정한 table을 포함한 정규화 텍스트를 반환한다; SQLite: `sqlite_master.sql`은 쓴 그대로의 `CREATE TRIGGER` 텍스트다; Probe: `mysql.trigger.body_catalog_verbatim`, `postgres.trigger.catalog_text`, `sqlite.trigger.catalog_verbatim`; 결정과 중립 rendering: **Decision:** 생성한 trigger는 catalog 텍스트가 선언한 renderer version의 출력과 같을 때만 복원한다. MySQL은 timing, event, 본문, PostgreSQL은 `pg_get_triggerdef`와 `prosrc`, SQLite는 전체 텍스트다. 주석 표식은 쓰지 않는다; Introspection: 표에 적은 대로
- **DIA-107** 이름 — MySQL 8.4: Database에서 고유하다(1359); PostgreSQL 17: Table 범위다; SQLite: Database에서 고유하다; Probe: `mysql.trigger.name_schema_scope`, `postgres.trigger.name_table_scope`, `sqlite.trigger.name_database_scope`; 결정과 중립 rendering: **Decision:** 생성 이름은 [dbspec 이름](dbspec.md#names)의 규칙으로 63바이트 이하다(plain form, 또는 처음 54 bytes, `$`, SHA-256 16진수 8자리). 생성 이름의 길이 때문에 table을 거부하지 않으며, 다른 생성 이름이나 선언된 이름과 같은 생성 이름은 두 출처를 적는 `name.duplicate` 오류다. 선언된 이름이 63바이트를 넘으면 여전히 거부한다; Introspection: 표에 적은 대로

Audit context 선택지. Audit trigger는 클라이언트가 transaction 안에서 설정한 작업 단위의 audit을 읽는다.

- **PostgreSQL** `set_config('<setting>', id, true)`는 transaction 범위다. `COMMIT` 뒤 같은 session에서는 빈 문자열, 설정한 적 없는 session에서는 NULL을 읽는다(`postgres.context.set_config_local`).
- **MySQL** user variable은 session 범위이며 `COMMIT` 뒤에도 남는다(`mysql.context.user_variable_session_scope`). Pool 연결은 클라이언트가 지우지 않으면 값을 유지한다.
- **SQLite**에는 session 변수가 없다. Main table의 trigger는 `TEMP` table을 읽도록 만들 수 있지만 실행할 때 실패한다(`sqlite.context.temp_table_not_visible`). Main table의 행은 `COMMIT` 뒤 모든 연결에 보인다(`sqlite.context.main_table_shared`).

선택지는 (1) 클라이언트가 transaction 안에서 id를 설정하고 MySQL과 SQLite에서는 transaction 끝에서 지운다는 규칙을 가진 위 데이터베이스별 방식, (2) 실행기가 audit 대상 행마다 쓰는 audit 컬럼이며 table 정의가 바뀐다.

- **DIA-108** **판정:** 두 전달 방식 모두 쓰지 않는다. 감사 대상 row가 audit 기록의 key를 담는 자기 audit column을 갖는다. transaction이 audit 기록을 삽입하고 executor가 모든 `INSERT`와 `UPDATE`에서 그 column을 쓰므로, 모든 database에서 row trigger는 바꾸는 audit 기록을 `NEW`에서, 이전 audit 기록을 `OLD`에서 읽는다. 생성된 trigger는 row를 JSON으로 만들지 않고 column 대 column으로 이력 table에 복사한다. physical `DELETE`의 `OLD`는 지우는 audit 기록이 아니라 이전 audit 기록이므로, 감사 대상 table은 soft delete column으로만 지운다. session 변수, transaction setting, `orm__context` table은 쓰지 않는다. 정의는 [dbspec](dbspec.md#audit)에 있다.

출처: [MySQL trigger syntax](https://dev.mysql.com/doc/refman/8.4/en/trigger-syntax.html), [MySQL stored program binary logging](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html), [MySQL FOREIGN KEY and triggers](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html), [MySQL user variables](https://dev.mysql.com/doc/refman/8.4/en/user-variables.html), [PostgreSQL CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html), [PostgreSQL trigger functions](https://www.postgresql.org/docs/17/plpgsql-trigger.html), [PostgreSQL set_config](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET), [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html), [SQLite DELETE](https://www.sqlite.org/lang_delete.html).

### DDL transactions, views and sequences

- **DIA-109** Transaction 안의 DDL — MySQL 8.4: DDL은 열린 transaction을 commit한다. 문장 하나는 원자적이다(실패한 `DROP TABLE a, missing`은 아무것도 삭제하지 않는다, 1051); PostgreSQL 17: DDL은 transaction에 포함된다. `CREATE INDEX CONCURRENTLY`는 transaction 안에서 실행할 수 없다(25001); SQLite: DDL은 transaction에 포함된다. `ALTER TABLE`은 컬럼을 바꿀 수 없고 `ADD COLUMN`은 상수가 아닌 기본값을 거부한다; Probe: `mysql.ddl.implicit_commit`, `mysql.ddl.atomic_statement`, `postgres.ddl.transactional`, `postgres.ddl.concurrent_index_outside_transaction`, `sqlite.ddl.transactional`, `sqlite.alter.limited`; 결정과 중립 rendering: **Decision:** transaction DDL에 의존하는 기능은 없다. Apply는 문장마다 journal을 쓰고 SQLite 컬럼 변경은 table을 다시 만든다; Introspection: 해당 없음
- **DIA-224** Schema와 그 catalog — MySQL 8.4: schema는 database이며 `information_schema.SCHEMATA`에 나열되고, 연결된 database의 table과 trigger는 schema가 `DATABASE()`인 `information_schema.TABLES`와 `information_schema.TRIGGERS`의 행이다; PostgreSQL 17: schema는 `pg_namespace`의 namespace이고, document set의 table은 `public`에 있으며, `information_schema.tables`와 `information_schema.triggers`가 그것을 schema별로 나열한다; SQLite: schema가 없고 `sqlite_master`가 모든 table, view, trigger를 `type`으로 나열하므로, `schema().exists(s)`(INT-57)는 이름이 `s__`로 시작하는 table이나 view를, `schema().installed(s, t)`는 이름이 `s__t`인 table이나 view를 보고한다. catalog을 읽는 recipe는 database마다 그 query를 적는다.
- **DIA-110** View — MySQL 8.4: `VIEW_DEFINITION`은 database로 한정한 이름과 alias로 다시 쓴다; PostgreSQL 17: `pg_get_viewdef`는 정규화 텍스트를 반환한다; SQLite: `sqlite_master.sql`은 쓴 그대로 유지한다; Probe: `mysql.view.definition_rewritten`, `postgres.view.definition_normalized`, `sqlite.view.text_verbatim`; 결정과 중립 rendering: **Decision:** 지원하지 않는다. View 본문은 중립 형식이 없는 dialect 질의다; Introspection: 미지원으로 보고한다
- **DIA-111** Sequence — MySQL 8.4: 없다(1064); PostgreSQL 17: `CREATE SEQUENCE`; SQLite: 없다; Probe: `mysql.sequence.unsupported`, `postgres.sequence.object`, `sqlite.sequence.unsupported`; 결정과 중립 rendering: **Decision:** 지원하지 않는다. 자동 key가 유일한 생성 번호다; Introspection: 미지원으로 보고한다
- **DIA-112** 기타 객체 — MySQL 8.4: Partition, event, procedure, engine; PostgreSQL 17: 함수, 타입, extension, partition; SQLite: Virtual table, `WITHOUT ROWID`; Probe: (manual); 결정과 중립 rendering: **Decision:** renderer가 trigger용으로 소유하는 함수를 제외하고 지원하지 않는다; Introspection: 미지원으로 보고한다
- **DIA-225** 테이블 권한 — MySQL 8.4 / MariaDB 11.8: 권한은 이름이 `user@host`인 계정이나 role에 속하고, schema는 자기 `USAGE` 권한이 없는 database이며, `TRUNCATE TABLE`이 `DROP`을 요구하므로 `TRUNCATE` 권한이 없다; PostgreSQL 17: 권한은 role에 속하고, schema는 `USAGE`가 필요하며, `TRUNCATE`는 테이블 권한이다; SQLite: 권한이 없다. 권한 유틸리티(INT-59)는 schema 사용 권한을 부여하고 `TRUNCATE` 권한을 취소하고 조회하는데, 이것은 PostgreSQL에만 있다. 그래서 PostgreSQL에서 실행하고 다른 곳에서는 `CAPABILITY_UNSUPPORTED`를 반환한다. 그 전에 PostgreSQL에서와 같이 인자를 검사하므로, 잘못된 인자는 모든 database에서 같은 `CONFIG`다.

출처: [MySQL implicit commit](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html), [MySQL atomic DDL](https://dev.mysql.com/doc/refman/8.4/en/atomic-ddl.html), [PostgreSQL CREATE INDEX CONCURRENTLY](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY), [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html), [MySQL CREATE VIEW](https://dev.mysql.com/doc/refman/8.4/en/create-view.html), [PostgreSQL CREATE SEQUENCE](https://www.postgresql.org/docs/17/sql-createsequence.html).

### Catalog sources

| 객체 | MySQL 8.4 | PostgreSQL 17 | SQLite |
|---|---|---|---|
| Table | `information_schema.TABLES`(`TABLE_TYPE='BASE TABLE'`, `TABLE_COLLATION`, `TABLE_COMMENT`) | `relnamespace`로 `pg_namespace`와 join한 `pg_class`(`relkind='r'`) | `sqlite_master`(`type='table'`) |
| 컬럼 | `information_schema.COLUMNS`(`COLUMN_TYPE`, `IS_NULLABLE`, `COLUMN_DEFAULT`, `EXTRA`, `GENERATION_EXPRESSION`, `COLLATION_NAME`) | `pg_attribute`, `format_type`, `pg_get_expr`를 통한 `pg_attrdef`, `attidentity`, `attgenerated`, `attcollation` | `pragma_table_xinfo`와 `AUTOINCREMENT`, `COLLATE`, 제약 이름을 위한 `sqlite_master.sql` |
| Primary·unique key, index | `information_schema.STATISTICS`(`INDEX_NAME`, `NON_UNIQUE`, `SEQ_IN_INDEX`, `COLLATION`, `SUB_PART`, `EXPRESSION`), `TABLE_CONSTRAINTS` | `pg_index`(`indkey`, `indoption`, `indpred`), `pg_get_indexdef`, `pg_constraint` | `pragma_index_list`, `pragma_index_xinfo`, `sqlite_master.sql` |
| Foreign key | `REFERENTIAL_CONSTRAINTS`, `KEY_COLUMN_USAGE` | `pg_constraint`(`contype='f'`, `conkey`, `confkey`, `confupdtype`, `confdeltype`, `confmatchtype`, `condeferrable`) | `pragma_foreign_key_list`, 이름을 위한 `sqlite_master.sql` |
| CHECK | `CHECK_CONSTRAINTS.CHECK_CLAUSE`, `TABLE_CONSTRAINTS.ENFORCED` | `pg_constraint`(`contype='c'`), `pg_get_constraintdef`, `convalidated` | `sqlite_master.sql` |
| Trigger | `information_schema.TRIGGERS`(`ACTION_TIMING`, `EVENT_MANIPULATION`, `ACTION_ORIENTATION`, `ACTION_STATEMENT`) | `pg_trigger`(`tgtype`, `tgfoid`), `pg_get_triggerdef`, `pg_proc.prosrc` | `sqlite_master`(`type='trigger'`) |
| Comment | `COLUMNS.COLUMN_COMMENT`, `TABLES.TABLE_COMMENT` | `pg_description`(`col_description`, `obj_description`) | 없음 |
| Sequence와 counter | `TABLES.AUTO_INCREMENT` | `pg_sequences`, `pg_get_serial_sequence` | `sqlite_sequence` |

## Rendered statements

- **DIA-113** renderer는 dbspec 문서 집합을 한 dialect의 statement로 바꾼다. 잘못된 집합은 대신 그 diagnostic을 돌려준다([manifest와 hash](dbspec.md#manifest-and-hashes)). `tests/dbspec/ddl.json`이 렌더링되는 모든 형식의 정확한 statement를 나열하며 규범 text다. 이 절은 그 뒤의 규칙을 정한다. 그 파일의 모든 vector는 `make dbspec-ddl-check`가 MySQL 8.4, PostgreSQL 17, SQLite에 적용한다.

### Statement와 순서

- **DIA-114** 문서는 `use` 순서로 렌더링한다(쓰이는 문서가 쓰는 문서보다 먼저, 같으면 문서 이름 순). 한 문서의 table은 문서 순서다. 쓰이는 table은 자기 문서가 한 번만 렌더링한다.
- **DIA-115** 모든 identifier는 따옴표로 감싼다: MySQL은 backtick, PostgreSQL과 SQLite는 큰따옴표. keyword는 대문자이고 statement마다 끝 semicolon 없는 한 줄이다.
- **DIA-116** table마다 `CREATE TABLE` 하나. SQLite는 이어서 unique key마다 `CREATE UNIQUE INDEX` 하나. 그다음 index마다 이름 순으로 `CREATE INDEX` 하나.
- **DIA-117** 모든 table 뒤에 MySQL과 PostgreSQL은 foreign key마다 `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` 하나를 table 순서와 key 이름 순으로 쓴다. SQLite는 foreign key를 `CREATE TABLE` 안에 쓰며, 뒤에 오는 table도 참조할 수 있다.
- **DIA-118** 마지막으로 `immutable`과 `audit`의 trigger를 table 순서로 쓴다. PostgreSQL trigger는 자신이 실행하는 `CREATE FUNCTION` 뒤에 온다.

### `CREATE TABLE` 안

- **DIA-119** 부분의 순서: 선언 순서의 column, primary key, MySQL과 PostgreSQL은 이름 순의 이름 있는 `UNIQUE` constraint로 쓴 unique key, SQLite는 이름 순의 foreign key, column 순서의 renderer CHECK, 이름 순의 선언된 check. MySQL statement의 끝에는 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`을 붙인다.

- **DIA-120** column은 이름, type, `NOT NULL`이나 `NULL`, 그다음 default 순으로 쓴다.

| dbspec | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `i16`, `i32`, `i64` | `SMALLINT`, `INT`, `BIGINT` | `smallint`, `integer`, `bigint` | `smallint`, `integer`, `bigint` |
| `bool` | `tinyint(1)` | `boolean` | `BOOLEAN` |
| `decimal(p,s)` | `DECIMAL(p,s)` | `numeric(p,s)` | `DECIMALINT(p,s)` |
| `f64` | `DOUBLE` | `double precision` | `REAL` |
| `varchar(n)` | `varchar(n) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` | `varchar(n) COLLATE "C"` | `varchar(n)` |
| `text` | `LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` | `text COLLATE "C"` | `TEXT` |
| `bytes` | `LONGBLOB` | `bytea` | `BLOB` |
| `uuid` | `BINARY(16)` | `uuid` | `BLOB` |
| `date` | `DATE` | `date` | `DATE` |
| `time(p)` | `TIME(p)` | `time(p)` | `TIME` |
| `datetime(p)` | `DATETIME(p)` | `timestamp(p)` | `DATETIME` |

- **DIA-121** **Identity.** MySQL은 `BIGINT NOT NULL AUTO_INCREMENT`와 table 수준 `PRIMARY KEY`, PostgreSQL은 `bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL`과 table 수준 `PRIMARY KEY`, SQLite는 column에 `INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT`를 쓰고 table 수준 primary key는 없다.
- **DIA-122** **Default.** literal default는 literal의 dialect 형식(아래)으로 쓴다. `default now`는 MySQL `CURRENT_TIMESTAMP(p)`, PostgreSQL `statement_timestamp()`, SQLite는 소수 자릿수가 정확히 p인 UTC text다. p = 0이면 `strftime('%Y-%m-%d %H:%M:%S', 'now')`, p ≤ 3이면 `substr(strftime('%Y-%m-%d %H:%M:%f', 'now'), 1, 20 + p)`, p > 3이면 0을 p − 3개 붙인 `(strftime('%Y-%m-%d %H:%M:%f', 'now') || '0…')`이며 모두 괄호로 감싼다. 이 default는 raw SQL을 위한 것이다: ORM insert는 빼먹은 `default now` 컬럼에 PostgreSQL과 SQLite에서는 `now` slot을 bind하고 MySQL에서는 `CURRENT_TIMESTAMP(p)`에 맡긴다([protocol](protocol.ko.md) "Clock").
- **DIA-123** **Literal.** 정수, `f64`, 문자열은 문서대로 쓴다. MySQL은 backslash를 escape로 읽으므로 MySQL 문자열은 모든 backslash를 두 번 쓴다. `true`와 `false`는 MySQL과 SQLite에서 `1`과 `0`, PostgreSQL에서 `TRUE`와 `FALSE`다. SQLite decimal literal은 정수 값 × 10^s다. `decimal(13,2)`의 `7.50`은 `750`이다. `uuid` literal은 MySQL과 SQLite에서 16 byte, 곧 `X'`와 text의 소문자 숫자 32개와 `'`이고, PostgreSQL에서 따옴표로 감싼 text다. `'0e2b5e8c-3b0f-4c59-9a0f-6a2f2c2e1b10'`은 `X'0e2b5e8c3b0f4c599a0f6a2f2c2e1b10'`이다. Introspection은 check에서 이 literal을 다시 읽는다. MySQL은 `0x`와 hex로, MariaDB와 SQLite는 `X'`와 hex로 쓴다. `uuid` column과 비교하는 16 byte는 따옴표로 감싼 canonical text이고, 다른 binary literal은 `the binary literal <hex> is no uuid literal`로 거부한다(`tests/dbspec/introspect.json`의 vector `*-uuid-check-literal`).
- **DIA-124** **Key.** `PRIMARY KEY (…)`는 key column을 나열한다. PostgreSQL은 기본 이름 `<table>_pkey`를 유지한다. unique key는 MySQL과 PostgreSQL에서 `CONSTRAINT <name> UNIQUE (…)`, SQLite에서 `CREATE UNIQUE INDEX <name> ON <table> (…)`이며, 그래서 SQLite catalog가 그 이름을 보고한다. 내림차순 index column 뒤에는 `DESC`를 쓴다.
- **DIA-125** **Foreign key.** `RESTRICT`, `CASCADE`, `SET NULL`로 `CONSTRAINT <name> FOREIGN KEY (…) REFERENCES <table> (…) ON DELETE <action> ON UPDATE <action>`이다.
- **DIA-126** **Check.** 선언된 check는 `CONSTRAINT <name> CHECK (<predicate>)`다. column 이름은 따옴표로 감싸고, `and`, `or`, `not`, `in`, `between`, `is null`, `is not null`은 대문자, literal은 dialect 형식, 괄호는 적힌 대로 쓴다.

### Renderer CHECK

- **DIA-127** renderer CHECK는 dialect가 강제하지 않는 type을 강제한다. 이름은 [dbspec 이름](dbspec.md#names)의 규칙으로 `<table>$<column>`이다: 63 bytes 이하이면 plain form이고, 아니면 처음 54 bytes, `$`, SHA-256의 16진수 8자리다. dbspec 이름에는 `$`가 없으므로 선언된 이름과 겹치지 않는다. column마다 CHECK 하나가 column type의 모든 조건을 담는다.

| dbspec | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `i16`, `i32` | | | `typeof(c) IN ('integer', 'null') AND c BETWEEN <min> AND <max>` |
| `i64`(identity 아님) | | | `typeof(c) IN ('integer', 'null')` |
| `bool` | `c IN (0, 1)` | | `c IN (0, 1)` |
| `decimal(p,s)` | | | `typeof(c) IN ('integer', 'null') AND c BETWEEN -(10^p − 1) AND 10^p − 1` |
| `f64` | | | `typeof(c) IN ('real', 'null')` |
| `varchar(n)` | | | `length(c) <= n` |
| `uuid` | `length(c) = 16` | | `typeof(c) IN ('blob', 'null') AND length(c) = 16` |
| `date` | | | `c IS date(c)` |
| `time(0)` | `c >= '00:00:00' AND c < '24:00:00'` | `c < '24:00:00'` | `c IS time(c) AND c < '24:00:00'` |
| `time(p)`, p > 0 | `time(0)`과 같음 | `time(0)`과 같음 | `length(c) = 9 + p AND substr(c, 1, 8) IS time(substr(c, 1, 8)) AND substr(c, 1, 8) < '24:00:00' AND substr(c, 9, 1) = '.' AND substr(c, 10) GLOB` 숫자 class p개 |
| `datetime(0)` | | | `length(c) = 19 AND c IS datetime(c) AND substr(c, 12, 2) < '24'` |
| `datetime(p)`, p > 0 | | | `length(c) = 20 + p AND substr(c, 1, 19) IS datetime(substr(c, 1, 19)) AND substr(c, 12, 2) < '24' AND substr(c, 20, 1) = '.' AND substr(c, 21) GLOB` 숫자 class p개 |

- **DIA-128** SQLite `f64` CHECK는 위 schema definitions에 probe가 없다. REAL column은 정수와 숫자 text를 real 값으로 바꾸고 다른 text는 그대로 두는데, 이 CHECK가 그것을 거부한다(`tests/dbspec/ddl.json`의 `types-and-defaults` case). PostgreSQL은 `timestamp` 입력의 24시를 다음 날 자정으로 읽으므로 `'2026-01-01 24:00:00'`은 유효한 date-time인 `2026-01-02 00:00:00`으로 저장된다. MySQL은 그 입력을 거부하고(1292) SQLite는 renderer CHECK가 거부한다. 저장되는 값의 집합이 같으므로 PostgreSQL CHECK는 없다(같은 case). client는 24시를 보내지 않는다.

### Trigger

- **DIA-129** 생성 trigger 이름은 renderer CHECK 이름과 같은 규칙([dbspec 이름](dbspec.md#names))으로 줄인 `<table>$<event>`이다: `immutable_update`, `immutable_delete`, `audit_insert`, `audit_update`, `audit_delete`. PostgreSQL trigger는 renderer가 소유한 같은 이름의 function을 실행한다. 거부는 `table <table> is immutable`이나 `table <table> deletes through its soft delete column` message를 일으킨다: MySQL `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '…'`, PostgreSQL `RAISE EXCEPTION '…'`, SQLite `SELECT RAISE(ABORT, '…')`.

- **DIA-130** `immutable`: 거부하는 `BEFORE UPDATE`와 `BEFORE DELETE` row trigger.
- **DIA-131** `audit`: `AFTER INSERT` row trigger는 이력 table에 action `'insert'`, NULL 이전 audit 기록, 기록하는 모든 column의 `NEW` 값을 넣는다. `AFTER UPDATE` row trigger는 `'update'`, `OLD.<audit column>`, 기록하는 모든 column의 `NEW` 값을 넣는다. `BEFORE DELETE` row trigger는 거부한다. insert는 action, previous, 기록하는 column 순으로, 기록하는 column은 table의 column 순서로 적고 이력 key는 identity에 맡긴다([audit](dbspec.md#audit)). `tables`가 있으면 두 trigger는 각각 이어서 `(NEW.<audit column>, '<table>')`을 tables table의 record column과 name column에 넣고, 있는 row는 그대로 둔다: MySQL은 `INSERT INTO <tables table> (<record column>, <name column>) VALUES (NEW.<audit column>, '<table>') ON DUPLICATE KEY UPDATE <name column> = <name column>`, PostgreSQL과 SQLite는 `ON DUPLICATE KEY UPDATE` 절 대신 `ON CONFLICT DO NOTHING`을 쓴 같은 insert다.
- **DIA-132** MySQL trigger 본문은 statement 하나이고, `tables`가 있으면 `BEGIN <history insert>; <tables insert>; END`다. PostgreSQL과 SQLite 본문도 statement를 같은 순서로 적고 각각 뒤에 `; `를 붙인다. PostgreSQL function 본문은 `LANGUAGE plpgsql`의 `BEGIN … RETURN NULL; END`다(`BEFORE` 거부는 반환하지 않는다). SQLite 본문은 `BEGIN …; END`다.

## Introspection

- **DIA-133** introspection은 connection의 현재 database(MySQL), 현재 schema(PostgreSQL), `main` database(SQLite)를 읽어 호출자가 이름을 준 dbspec 문서 하나와 읽지 못한 객체 목록을 돌려준다. recipe `contracts/fixtures/dbspec_introspect/dbspec_introspect.json`은 `tests/dbspec/ddl.json`의 모든 vector와 모든 schema 문서를 렌더링해 적용하고 database를 introspect한 뒤, 결과의 schema text가 table을 이름 순으로 둔 원본의 schema text와 같고 미지원 객체가 없기를 요구한다. 또 `tests/dbspec/introspect.json`을 실행한다. 각 case는 그 dialect의 빈 database에 문서를 렌더링하고 statement를 실행한 뒤(statement의 `{schema}`는 그 database 또는 schema의 이름 문자열로 치환하며, PostgreSQL case는 함께 지우는 두 번째 schema `{schema}_b`를 만들 수 있다), introspect한 문서의 canonical form과 미지원 객체 `[kind, table, name]`를 기대한다. 네 번째 원소가 있으면 그 객체의 이유가 그 rule을 포함하는지 비교하고, 없으면 이유는 비교하지 않는다. `mysql` dialect의 case는 MariaDB server의 답이 다른 곳에서 그 server의 결과로 자기 `document`와 `unsupported`를 가진 `mariadb` member를 둘 수 있으며(DIA-200, 규칙 4), 그런 차이마다 그 DIA 규칙이 그 vector를 적는다(DIA-50, DIA-75). 실패한 catalog query는 호출의 error다. recipe case `catalog_query_failure`는 빈 SQLite database를 MySQL의 catalog query로 introspect한다. `make dbspec-introspect-<client>-check`는 recipe를 클라이언트 하나로 실행하고, Go 시험 suite가 그 entry를 실행한다. `make dbspec-introspect-compare-check`는 stress 모양의 20 table 문서(`make bench`의 `make dbspec-introspect-compare-bench`는 2000 table stress 문서와 release Rust runner)를 각 dialect에 적용하고 runner 다섯 개(Go, PHP, TypeScript, Rust, Python, PHP 확장; PHP 확장은 `tests/dbspec/introspect`의 runner이고 Python runner는 `packages/python/tests/dbspec_introspect_runner.py`)를 실행해, 출력(canonical 문서, 그다음 미지원 객체마다 `! kind<TAB>table<TAB>name` 줄)이 같고, 원본 schema text를 가지며, 미지원 객체가 없기를 요구한다. 각 introspection의 시간을 출력하고 그것이 기준값 5초를 넘으면 경고하며, 시간은 검사를 실패시키지 않는다.

### 문서

- **DIA-134** table은 이름 순, column은 catalog 위치 순, constraint와 index는 이름 순이다. 문서에는 diagram과 comment가 없다.
- **DIA-135** 이름이 `dbspec$`로 시작하는 table과 column은 모두 빼고 보고하지 않는다: plan history table `dbspec$plans`, plan이 숨긴 table과 column, SQLite 작업 table이다([plans](plans.md#steps)).
- **DIA-136** database에 렌더링되는 setting만 읽는다: trigger로 알아보는 `immutable`과 `audit`. manifest setting은 문서에만 있다. 동기화하는 도구는 비교하는 문서에서 이를 유지한다.

### Type과 column

| Catalog | MySQL `COLUMN_TYPE` | PostgreSQL `format_type` | SQLite 선언 type | dbspec |
| --- | --- | --- | --- | --- |
| 16, 32, 64-bit 정수 | `smallint`, `int`, `bigint` | `smallint`, `integer`, `bigint` | renderer CHECK가 있는 `smallint`, `integer`, `bigint` | `i16`, `i32`, `i64` |
| boolean | renderer CHECK가 있는 `tinyint(1)` | `boolean` | renderer CHECK가 있는 `BOOLEAN` | `bool` |
| decimal | `decimal(p,s)` | `numeric(p,s)` | renderer CHECK가 있는 `DECIMALINT(p,s)` | `decimal(p,s)` |
| 실수 | `double` | `double precision` | renderer CHECK가 있는 `REAL` | `f64` |
| 길이 제한 text | `utf8mb4_0900_bin`의 `varchar(n)` | collation `C`의 `character varying(n)` | renderer CHECK가 있는 `varchar(n)` | `varchar(n)` |
| text | `utf8mb4_0900_bin`의 `longtext` | collation `C`의 `text` | CHECK 없는 `TEXT` | `text` |
| bytes | `longblob` | `bytea` | `BLOB` | `bytes` |
| uuid | renderer CHECK가 있는 `binary(16)` | `uuid` | renderer CHECK가 있는 `BLOB` | `uuid` |
| date | `date` | `date` | renderer CHECK가 있는 `DATE` | `date` |
| 하루 중 시각 | renderer CHECK가 있는 `time`이나 `time(p)` | renderer CHECK가 있는 `time(p) without time zone` | p 하나의 renderer CHECK가 있는 `TIME` | `time(p)` |
| date-time | `datetime`이나 `datetime(p)` | `timestamp(p) without time zone` | p 하나의 renderer CHECK가 있는 `DATETIME` | `datetime(p)` |

- **DIA-137** MySQL은 precision 0을 괄호 없이 쓴다(`time`, `datetime`). type, collation, character set이 이 표에 없는 column, renderer CHECK 없는 MySQL `tinyint(1)`, `binary(16)`, `time` column, CHECK가 어떤 dbspec type의 renderer 출력도 아닌 SQLite column은 미지원으로 보고한다.

- **DIA-138** **Null.** `IS_NULLABLE`, `attnotnull`, `pragma_table_xinfo.notnull`이 `null`을 준다.
- **DIA-139** **Identity.** MySQL `EXTRA` `auto_increment`, PostgreSQL `attidentity` `d`, SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`인 단일 column `bigint` primary key는 `identity`다. PostgreSQL `attidentity` `a`(`ALWAYS`)는 미지원이다.
- **DIA-140** **Default.** literal default는 column의 canonical default 형식으로 읽는다. MySQL `COLUMN_DEFAULT`는 escape를 푼 값(문자열, 숫자, `bool`이면 `1`이나 `0`)이다. PostgreSQL `pg_get_expr`는 `'-5'::integer`, `'a''b'::character varying`, `'2026-01-01'::date`처럼 cast를 가진 literal을 주며 cast를 뗀다. SQLite `dflt_value`는 렌더링한 literal이며 decimal은 scale을 곱한 정수다. `uuid` default는 16 byte에서 canonical text로 읽는다. `binary(16)`의 MySQL `COLUMN_DEFAULT`는 `0x`와 대문자 숫자 32개이고, text 저장(DIA-144)인 column의 `char(36)`과 `varbinary(36)`은 그 text이거나 그 `0x` 숫자다. SQLite `dflt_value`는 렌더링한 `X'…'`다. 시각 default는 renderer 출력과 같을 때 `default now`다: `DEFAULT_GENERATED`인 MySQL `CURRENT_TIMESTAMP`나 `CURRENT_TIMESTAMP(p)`, PostgreSQL `statement_timestamp()`, 그 precision의 SQLite `strftime` 식. 그 밖의 식은 미지원이다.

### Key, index, foreign key

- **DIA-141** primary key는 column 순서를 유지한다. MySQL `UNIQUE` index, PostgreSQL `UNIQUE` constraint, origin이 `c`인 SQLite unique index는 unique key이고, 그 밖의 index는 index이며 `DESC`는 `COLLATION`, `indoption`, `pragma_index_xinfo.desc`에서 읽는다.
- **DIA-142** prefix, partial, expression, full-text index, constraint 없는 PostgreSQL unique index, primary key가 아닌 SQLite `sqlite_autoindex`, 이름에 `$`가 있는 index는 미지원이다.
- **DIA-143** foreign key는 이름, column, 참조 table과 column, 두 action을 읽는다. `NO ACTION`, `SET DEFAULT`, deferrable key, `MATCH FULL`, 참조 table이 다른 schema에 있는 PostgreSQL key는 미지원이다. SQLite foreign key 이름은 `sqlite_master`의 `CREATE TABLE` text에서 온다.

### Check

- **DIA-144** `<table>$<column>` 이름의 check는 renderer CHECK다. column type에 대한 renderer 출력의 catalog 형식과 같아야 한다: `bool`은 MySQL `` (`c` in (0,1)) ``, `uuid`는 `` (length(`c`) = 16) ``(`mysql.render.uuid_bytes`), `time(p)`는 `` ((`c` >= _utf8mb4\'00:00:00\') and (`c` < _utf8mb4\'24:00:00\')) ``이고 MariaDB에서는 DIA-203의 형식이며, PostgreSQL은 column 이름을 `quote_ident`가 쓰는 대로 쓴 `CHECK ((c < '24:00:00'::time without time zone))`, SQLite는 렌더링한 text 그대로다. MySQL은 table의 `ALTER TABLE`마다 `CHECK_CLAUSE`를 다시 써서 time literal의 introducer를 뺀다(`mysql.check.alter_rewrites_introducers`). 또 `time(p)` column과 만나는 time literal을 0으로 된 `p` 자리 소수와 함께 쓴다(`mysql.check.alter_writes_time_precision`). 그래서 MySQL clause는 character set introducer와 time literal의 0인 소수를 뺀 뒤 비교한다. 이 template의 literal은 ASCII이고 0인 소수는 값을 바꾸지 않으므로 비교는 의미를 지킨다. 다른 renderer CHECK와 renderer CHECK가 아닌 `$` 이름은 미지원이다. MySQL과 SQLite에서 `uuid`의 renderer CHECK는 그 type의 이름을 가진 표시이며, `bytes` column은 그것을 갖지 않으므로 uuid를 `bytes` column과 구별한다. 0.0.28까지의 release가 만든 uuid의 text 저장 column, 곧 CHECK `` regexp_like(`c`,_utf8mb4\'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$\',_utf8mb4\'c\') ``를 가진 `ascii_bin`의 MySQL `char(36)`과 문자 class 36개의 CHECK `c GLOB`을 가진 SQLite `TEXT`, 그리고 멈춘 변환(PLN-108)의 CHECK `` (length(`c`) in (16,36)) ``을 가진 MySQL `varbinary(36)` column, MariaDB에서는 DIA-203의 `` c regexp '…' ``과 `` octet_length(`c`) in (16,36) ``은 `uuid` column으로 읽고, 이유 `uuid stored as text by an earlier release; dbspec apply converts it to 16 bytes`를 가진 미지원 column으로 보고한다.

- **DIA-145** 그 밖의 check는 [dbspec](dbspec.md#checks)의 predicate로 읽어 canonical form으로 쓴다.

- **DIA-146** **MySQL** `CHECK_CLAUSE`: 모두 괄호로 감싸고, keyword는 소문자, column은 backquote, `in (a,b)`는 공백 없음, 음수는 `-(n)`, 문자열은 `_utf8mb4`와 MySQL 문자열 literal이며 그 text는 한 번 더 escape된다(clause 안의 `\'`와 `\\`).
- **DIA-147** **PostgreSQL** `pg_get_constraintdef`: 모두 괄호로 감싼 식을 `CHECK (…)`가 감싸고, column은 `quote_ident`가 필요할 때만 따옴표를 쓰며, literal과 column에 cast가 붙고(`'x'::text`, `(s)::text`, `'-1.50'::numeric`, `(1.5)::double precision`), `in`은 `= ANY (ARRAY[…])`, `not in`은 `<> ALL (ARRAY[…])`이고, time과 date-time literal은 끝의 0 소수를 뺀다.
- **DIA-148** **SQLite**: `CREATE TABLE` statement의 `CHECK (…)` 안 text이며 렌더링한 text다. decimal literal은 scale을 곱한 정수다.

- **DIA-149** literal은 만나는 column의 값으로 읽어 canonical default 형식으로 쓴다. 그래서 `datetime(6)` column의 `'2100-01-01 00:00:00'`은 `'2100-01-01 00:00:00.000000'`, `bool` column의 `1`은 `true`가 된다. predicate로 읽히지 않거나 dbspec 규칙을 어기는 check는 미지원이다.

### Trigger

- **DIA-150** 각 setting은 제 trigger의 이름을 보고 알아보며, 그 이름은 [dbspec 이름](dbspec.md#names)의 규칙으로 재계산한다. trigger 개수로 알아보지 않는다. `<table>$immutable_update`와 `<table>$immutable_delete` 이름의 trigger는 `immutable` setting을, `<table>$audit_insert`, `<table>$audit_update`, `<table>$audit_delete` 이름의 trigger는 `audit` setting을 준다. 각각 그 setting의 renderer 출력과 같을 때다: MySQL timing, event, `ACTION_STATEMENT`, PostgreSQL은 table의 schema prefix를 뗀 `pg_get_triggerdef`와 그 function의 `prosrc`, SQLite는 `CREATE TRIGGER` text. `audit` parameter는 비교 전에 `audit_insert`의 insert statement와 `audit_update`의 `OLD` column에서 읽는다. insert는 action, previous, 기록하는 column을 적고, 기록하는 column은 audit column을 포함하며, insert가 적지 않은 table의 column은 schema text가 쓰는 대로 column 순서의 `exclude` 목록이 된다. audit 기록 table은 audit column의 유일한 foreign key의 대상 table이다. `audit_insert`의 둘째 insert는 `tables` 절, 그 대상과 두 column을 준다. 두 setting을 함께 쓴 table은 각 setting renderer 출력의 합집합을 가지며, trigger 집합은 그 합과 이름과 내용이 정확히 같아야 한다. 더 있거나, 빠지거나, 내용이 다른 trigger 하나는 그 table의 모든 trigger를 미지원으로 만들며, 그 밖의 모든 trigger도 마찬가지다.

### 미지원 객체

- **DIA-151** 미지원 객체마다 kind, 있으면 table과 이름, 이유를 보고하며 문서에서는 뺀다. 목록은 table, kind, 이름 순이고 table이 없는 객체가 먼저 온다. kind는 `column`, `index`, `unique`, `foreign_key`, `check`, `trigger`(parse되지 않는 `immutable`이나 `audit` setting마다 하나), `view`, `routine`, `sequence`, `event`, `partition`(MySQL이나 PostgreSQL의 partitioned table과 PostgreSQL partition), `table`(SQLite `WITHOUT ROWID`나 virtual table, primary key가 없는 table)이다.

- **DIA-152** 빠진 객체를 참조하는 객체도 보고하고 뺀다. 미지원 column 위의 index나 key, 빠진 table로 가는 foreign key, 미지원 column을 쓰는 check가 그렇다. introspect한 문서는 parse되며, parse가 거부한 줄의 객체는 그 diagnostic을 이유로 보고되고 빠진다. 문서가 parse될 때까지 반복한다. parse가 table을 거부하면 그 table은 모든 객체와 함께 빠지고, 같은 parse에서 거부된 그 table의 객체는 따로 보고하지 않는다. 각 객체는 한 번만 보고한다. catalog row가 column마다 하나인 foreign key도 그렇다.

- **DIA-153** SQLite는 table 항목을 `CREATE TABLE` text에서 읽는다. column 정의는 renderer 형식, 곧 따옴표 친 이름, 선언 type, `NULL`이나 `NOT NULL`, 있으면 default일 때 읽는다. 다른 clause(`CHECK`, `REFERENCES`, `UNIQUE`, `COLLATE` 등)가 있는 column은 미지원이다. renderer 형식이 아닌 `CHECK`, `UNIQUE`, `FOREIGN KEY` 항목은 그 kind와 constraint 이름을 붙여 보고하며, 이름이 없으면 빈 이름이다. `UNIQUE` 항목이나 clause의 자동 index는 따로 보고하지 않는다. 다른 형식의 primary key 항목과 그 밖의 항목은 table을 빼게 한다.
- **DIA-191** CHECK가 없는 column을 포함해, declared type이 dbspec type이 없는 SQLite column은 `declared type <type> with CHECK <check> has no dbspec type` 이유로 보고된다. 여기서 `<check>`는 column의 CHECK text를 JSON 문자열로 쓴 것이고, CHECK가 없으면 `""`이다. 여섯 client 모두 CHECK가 없는 column에 이 빈 문자열 형식을 정확히 사용한다. Go client는 `%q`로, TypeScript client는 `JSON.stringify`로 `<check>`를 쓰며, Python client도 같은 text를 쓴다.
- **DIA-198** introspection의 catalog query 수는 dialect별로 고정되어 table 수에 좌우되지 않는다.
- **DIA-133a** PHP와 PHP extension: 실패한 catalog query는 PDO connection의 모든 error mode에서, silent mode에서도 호출의 error다.
- **DIA-133b** PHP-extension package `polyspec/orm-php-ext`은 `Dbspec::introspect`를 native로 구현하고, 그 method가 library의 method를 대신한다.

## MariaDB 11.8 probe

MySQL의 fact probe마다 같은 topic과 fact를 가진 MariaDB probe `mariadb.<topic>.<fact>`가 있고, `TestDialectFactsMariadb`가
이것을 `make orm-test-mariadb`의 MariaDB 11.8.6에서 실행한다(`make dialect-facts-mariadb-check`, DIA-200). MySQL의 fact가 성립하는
곳에서 probe는 그 쌍이며 MariaDB 11.8에서 그 fact를 증명한다. MariaDB가 다르게 답하는 곳에서 그 ID의 probe는 MariaDB의 fact를
적고(`packages/go/internal/dialects/probes_mariadb.go`), 표가 그 fact를 옮긴다. 모든 MariaDB probe는 MariaDB 11.8.6에서 통과한다.
이 문서의 규칙은 MariaDB probe가 그 형식을 증명하는 곳에서만 MariaDB 11.8을 적고 그 probe를 적는다. MySQL만 적은 규칙은
아직 MariaDB에서 증명되지 않았다.

| Probe | MariaDB 11.8.6에서 |
|---|---|
| `mariadb.auto_increment.explicit_value_advances` | MySQL의 fact가 성립한다 |
| `mariadb.auto_increment.requires_key` | MySQL의 fact가 성립한다 |
| `mariadb.auto_increment.rollback_leaves_gap` | MySQL의 fact가 성립한다 |
| `mariadb.binary.zero_padded` | MySQL의 fact가 성립한다 |
| `mariadb.bool.alias_tinyint` | MySQL의 fact가 성립한다 |
| `mariadb.catalog.key_ordinal_by_name` | table을 상수로 이름 짓는 subquery가 join처럼 primary key 순번을 읽고, join만 모든 database의 모든 table을 연다 |
| `mariadb.char.trailing_spaces_removed` | MySQL의 fact가 성립한다 |
| `mariadb.check.alter_rewrites_introducers` | MariaDB에는 REGEXP_LIKE가 없고(CHECK 밖에서 1305, 안에서 1901), ALTER TABLE은 CHECK_CLAUSE를 그대로 둔다 |
| `mariadb.check.alter_writes_time_precision` | ALTER TABLE은 time(p) column과 만나는 time literal을 쓴 그대로 둔다 |
| `mariadb.check.between_kept` | CHECK_CLAUSE는 BETWEEN을 유지하고 음수 literal을 -n으로 쓴다 |
| `mariadb.check.bool_column_rejected` | bool column 하나만으로 CHECK 식이 되고, 그 CHECK는 0을 거부한다(4025) |
| `mariadb.check.catalog_text` | CHECK_CLAUSE는 바깥 괄호와 character set introducer가 없는 식이다 |
| `mariadb.check.drop_constraint` | MySQL의 fact가 성립한다 |
| `mariadb.check.drop_constraint_shared_name` | CHECK는 그 표의 foreign key나 unique key와 이름을 나눌 수 없어(1826), DROP CONSTRAINT는 constraint 하나를 가리킨다 |
| `mariadb.check.enforced_null_passes` | CHECK는 적용되고(4025, SQLSTATE 23000) NULL은 통과한다 |
| `mariadb.check.fk_action_column_rejected` | 참조 action이 있는 foreign key의 column은 CHECK에 나올 수 없다(1901) |
| `mariadb.check.name_schema_scope` | CHECK 이름의 범위는 그 table이다: 두 table이 각각 CHECK ck를 가질 수 있다 |
| `mariadb.check.nondeterministic_rejected` | CHECK는 NOW()를 부를 수 없다(1901) |
| `mariadb.check.not_enforced_option` | MariaDB에는 NOT ENFORCED CHECK가 없고(1064), TABLE_CONSTRAINTS에는 ENFORCED column이 없다(1054) |
| `mariadb.check.not_pushed_down` | CHECK_CLAUSE는 NOT을 비교와 IS NULL 안으로 밀어 넣고 안쪽 괄호를 쓰지 않는다 |
| `mariadb.check.string_escaped_twice` | CHECK_CLAUSE는 string literal을 MariaDB text로 한 번만 escape한다 |
| `mariadb.collation.default_accent_case_insensitive` | 기본 utf8mb4 collation utf8mb4_uca1400_ai_ci는 unique key에서 a = A = á로 만든다(1062) |
| `mariadb.collation.utf8mb4_0900_bin_codepoint` | MySQL의 fact가 성립한다 |
| `mariadb.collation.utf8mb4_bin_pads` | MySQL의 fact가 성립한다 |
| `mariadb.comment.column_limit` | MySQL의 fact가 성립한다 |
| `mariadb.comment.table_limit` | MySQL의 fact가 성립한다 |
| `mariadb.context.user_variable_session_scope` | MySQL의 fact가 성립한다 |
| `mariadb.current_timestamp.session_time_zone` | MySQL의 fact가 성립한다 |
| `mariadb.date.zero_rejected` | MariaDB의 기본 sql_mode는 0000-00-00을 받고, strict mode와 NO_ZERO_DATE는 그것을 거부한다(1292) |
| `mariadb.datetime.default_precision_must_match` | (6) 없는 DATETIME(6) DEFAULT CURRENT_TIMESTAMP를 CURRENT_TIMESTAMP(6)로 받고, COLUMN_DEFAULT가 그것을 보고한다 |
| `mariadb.datetime.fraction_rounds` | DATETIME(0)은 .5초를 버린다 |
| `mariadb.datetime.max_precision` | MySQL의 fact가 성립한다 |
| `mariadb.datetime.no_conversion` | MySQL의 fact가 성립한다 |
| `mariadb.datetime.offset_literal_converted` | DATETIME은 offset을 가진 literal을 거부한다(1292) |
| `mariadb.datetime.range` | MySQL의 fact가 성립한다 |
| `mariadb.ddl.atomic_statement` | 하나가 없는 두 table의 DROP TABLE은 있는 table을 지우고 실패한다(1051) |
| `mariadb.ddl.implicit_commit` | MySQL의 fact가 성립한다 |
| `mariadb.decimal.overflow_rejected` | MySQL의 fact가 성립한다 |
| `mariadb.decimal.precision_limits` | DECIMAL의 정밀도는 최대 65(1426), scale은 최대 38(1425)이므로 DECIMAL(65,31)을 받는다 |
| `mariadb.decimal.scale_rounds` | MySQL의 fact가 성립한다 |
| `mariadb.default.catalog_text` | COLUMN_DEFAULT는 literal을 SQL escape와 함께 따옴표로 감싸고, NULL default를 NULL로, 식 default를 그 text로, 시계를 current_timestamp(p)로 쓰며, EXTRA에는 DEFAULT_GENERATED가 없다 |
| `mariadb.enum.not_null_first_value_default` | MySQL의 fact가 성립한다 |
| `mariadb.enum.rejects_unknown` | MySQL의 fact가 성립한다 |
| `mariadb.enum.sorts_by_position` | MySQL의 fact가 성립한다 |
| `mariadb.env.server` | 서버는 strict mode이고 lower_case_table_names=1인 MariaDB 11.8이다 |
| `mariadb.fault.check_before_unique` | CHECK와 unique key를 모두 깨는 행은 CHECK fault, SQLSTATE 23000의 4025로 거부된다 |
| `mariadb.fault.fk_statement_end` | MySQL의 fact가 성립한다 |
| `mariadb.fk.cascade_skips_triggers` | MySQL의 fact가 성립한다 |
| `mariadb.fk.child_index_created` | MySQL의 fact가 성립한다 |
| `mariadb.fk.deferrable_rejected` | MySQL의 fact가 성립한다 |
| `mariadb.fk.match_full_not_enforced` | MATCH FULL은 MATCH_OPTION NONE으로 기록되고 SHOW CREATE TABLE에서 빠지며, 일부가 NULL인 key를 받는다 |
| `mariadb.fk.name_schema_scope` | foreign key 이름은 database 안에서 유일하다: 두 번째 fk는 1005(errno 121)로 거부된다 |
| `mariadb.fk.restrict_row_order` | MySQL의 fact가 성립한다 |
| `mariadb.fk.rule_catalog` | REFERENTIAL_CONSTRAINTS는 생략된 action을 RESTRICT로, 쓴 RESTRICT를 RESTRICT로 보고한다 |
| `mariadb.fk.set_default_acts_as_restrict` | InnoDB는 ON DELETE SET DEFAULT를 받아 RESTRICT로 기록하고 부모 삭제를 거부한다(1451) |
| `mariadb.fk.type_mismatch_rejected` | INT column은 BIGINT key를 참조할 수 없다: 1005(errno 150) |
| `mariadb.float.no_infinity` | MySQL의 fact가 성립한다 |
| `mariadb.float.single_precision` | MySQL의 fact가 성립한다 |
| `mariadb.generated.catalog_expression` | VIRTUAL과 STORED generated column은 바깥 괄호 없는 식으로 보고된다 |
| `mariadb.generated.explicit_value_rejected` | strict mode에서 generated column의 명시 값은 거부된다(1906) |
| `mariadb.ident.column_case_insensitive` | MySQL의 fact가 성립한다 |
| `mariadb.ident.max_length` | table 이름은 최대 64문자이다(1103) |
| `mariadb.ident.table_case_server_setting` | MySQL의 fact가 성립한다 |
| `mariadb.index.descending` | MySQL의 fact가 성립한다 |
| `mariadb.index.functional` | MariaDB에는 functional index key가 없고(1064), STATISTICS에는 EXPRESSION column이 없다(1054) |
| `mariadb.index.max_key_bytes` | 3072 byte를 넘는 utf8mb4 VARCHAR(769)의 index를 받는다 |
| `mariadb.index.name_max_length` | MySQL의 fact가 성립한다 |
| `mariadb.index.name_table_scope` | MySQL의 fact가 성립한다 |
| `mariadb.index.partial_rejected` | MySQL의 fact가 성립한다 |
| `mariadb.index.prefix` | MySQL의 fact가 성립한다 |
| `mariadb.index.primary_name_reserved` | MySQL의 fact가 성립한다 |
| `mariadb.int.bigint_unsigned_exceeds_signed` | MySQL의 fact가 성립한다 |
| `mariadb.int.display_width_dropped` | COLUMN_TYPE은 정수의 표시 폭을 유지한다: int(11), tinyint(1), bigint(20) |
| `mariadb.int.tinyint_range` | MySQL의 fact가 성립한다 |
| `mariadb.int.unsigned_rejects_negative` | MySQL의 fact가 성립한다 |
| `mariadb.json.normalizes` | JSON은 JSON_VALID CHECK를 가진 LONGTEXT이다: 중복 key와 member 순서까지 쓴 그대로 남는다 |
| `mariadb.like.ascii_fold_replace` | MySQL의 fact가 성립한다 |
| `mariadb.like.binary_collation_case_sensitive` | MySQL의 fact가 성립한다 |
| `mariadb.like.binary_collation_code_point` | MySQL의 fact가 성립한다 |
| `mariadb.lock.nowait_held` | 다른 transaction이 잠근 row의 NOWAIT 읽기는 lock wait timeout의 번호인 1205로 바로 실패한다 |
| `mariadb.lock.share_clause` | LOCK IN SHARE MODE는 공유 row lock을 잡고 NOWAIT를 받으며, MariaDB에는 FOR SHARE가 없다(1064) |
| `mariadb.not_null.missing_value_rejected` | MySQL의 fact가 성립한다 |
| `mariadb.now.compare_six_digits` | MySQL의 fact가 성립한다 |
| `mariadb.now.precision_truncates` | MySQL의 fact가 성립한다 |
| `mariadb.on_update.explicit_value_kept` | MySQL의 fact가 성립한다 |
| `mariadb.on_update.fires_on_change` | MySQL의 fact가 성립한다 |
| `mariadb.on_update.skipped_when_unchanged` | MySQL의 fact가 성립한다 |
| `mariadb.order.null_first_asc` | MySQL의 fact가 성립한다 |
| `mariadb.pk.name_is_primary` | MySQL의 fact가 성립한다 |
| `mariadb.relative.month_end_kept` | MySQL의 fact가 성립한다 |
| `mariadb.relative.out_of_range_null` | MySQL의 fact가 성립한다 |
| `mariadb.render.bool_check` | CHECK (b IN (0,1))를 가진 TINYINT(1)은 2를 거부한다(4025) |
| `mariadb.render.datetime_utc_session` | MySQL의 fact가 성립한다 |
| `mariadb.render.time_of_day_check` | CHECK (v >= '00:00:00' AND v < '24:00:00')를 가진 TIME(6)은 하루 안의 시각만 받는다(4025) |
| `mariadb.render.timestamp_conversion` | MySQL의 fact가 성립한다 |
| `mariadb.render.uuid_bytes` | CHECK (length(u) = 16)을 가진 BINARY(16)은 CHECK_CLAUSE가 octet_length(`u`) = 16이고, uuid의 16 byte를 저장해 text의 순서로 정렬하며, COLUMN_DEFAULT는 binary default를 x'와 그 byte의 소문자 hex로 쓴다 |
| `mariadb.sequence.unsupported` | MariaDB에는 CREATE SEQUENCE가 있고, sequence는 그 자체 종류의 table이다 |
| `mariadb.session.sql_mode_set` | MySQL의 fact가 성립한다 |
| `mariadb.session.statement_timeout` | MariaDB에는 max_execution_time이 없고(1193), SESSION max_statement_time이 모든 statement를 초 단위로 제한한다(1969) |
| `mariadb.text.index_needs_prefix` | prefix 길이 없는 TEXT index를 768문자 prefix로 받고, STATISTICS는 이를 SUB_PART로 보고한다 |
| `mariadb.text.literal_default_needs_expression` | TEXT는 DEFAULT 'x'와 DEFAULT ('x')를 모두 받고, COLUMN_DEFAULT는 둘 다 따옴표 친 literal로 보고한다 |
| `mariadb.text.max_bytes` | MySQL의 fact가 성립한다 |
| `mariadb.text.nul_preserved` | MySQL의 fact가 성립한다 |
| `mariadb.time.interval_range` | MySQL의 fact가 성립한다 |
| `mariadb.timestamp.range_2038` | TIMESTAMP는 UTC 1970-01-01 00:00:01..2106-02-07 06:28:15를 받고 1970-01-01 00:00:00과 2106-02-07 06:28:16을 거부한다(1292) |
| `mariadb.timestamp.session_time_zone` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.binlog_privilege_1419` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.body_catalog_verbatim` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.name_schema_scope` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.new_assignable` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.no_statement_level` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.no_truncate_event` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.truncate_skips_delete_trigger` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.update_fires_when_unchanged` | MySQL의 fact가 성립한다 |
| `mariadb.trigger.zero_rows_not_fired` | MySQL의 fact가 성립한다 |
| `mariadb.unique.nulls_distinct` | MySQL의 fact가 성립한다 |
| `mariadb.upsert.any_unique_key` | MySQL의 fact가 성립한다 |
| `mariadb.upsert.not_null_unique_first` | MySQL의 fact가 성립한다 |
| `mariadb.uuid.binary_pads` | MySQL의 fact가 성립한다 |
| `mariadb.uuid.no_type` | MariaDB에는 UUID type이 있고 DATA_TYPE uuid로 보고되며, 그 ORDER BY는 text의 순서가 아니다 |
| `mariadb.varbinary.length_enforced` | MySQL의 fact가 성립한다 |
| `mariadb.varchar.length_in_characters` | MySQL의 fact가 성립한다 |
| `mariadb.varchar.max_length` | MySQL의 fact가 성립한다 |
| `mariadb.varchar.trailing_spaces_truncated` | MySQL의 fact가 성립한다 |
| `mariadb.view.definition_rewritten` | VIEW_DEFINITION은 qualified name과 alias로 다시 쓰이고, 조건을 괄호로 감싸지 않는다 |

## Markdown corpus

markdown 연결은 flowmark server가 corpus에서 문에 답하는 SQLite 연결이므로([protocol](protocol.ko.md#_5-markdown-connections)) SQLite dialect의 모든 규칙이 이 연결에 적용된다. 아래 행은 corpus가 SQLite에 더하는 것을 적고, 표면이 SQLite와 같으면 그렇다고 적는다. recipe는 SQLite의 모든 case를 markdown 연결에서도 실행한다. server가 문에 답하는 방식은 flowmark의 [operations](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/40-ops.md)가 정한다.

- **DIA-154** DSN scheme `markdown://`은 flowmark server에 연결하는 SQLite dialect를 고른다([protocol](protocol.ko.md#_5-markdown-connections)). 클라이언트는 각 요청을 SQLite에서처럼 계획하고 그 문을 server에 전한다.
- **DIA-155** `one`, `all`, `count`, `group_count`, `sum`, `avg` — 결과: SQLite와 같다.
- **DIA-156** 정렬 — 결과: SQLite와 같다. 오름차순에서 NULL은 모든 값 앞, 내림차순에서는 모든 값 뒤다.
- **DIA-157** `group_by` — 결과: SQLite와 같다. orm의 규칙을 따른다.
- **DIA-158** `paginate`, `lookahead_paginate`, `group_lookahead_paginate` — 결과: SQLite와 같다. 문 하나는 일관된 corpus 하나를 읽는다.
- **DIA-159** `insert`(단일 행과 여러 행) — 결과: SQLite와 같다. 규칙: corpus는 다른 database가 application에 맡기는 column을 할당하지 않으므로, 필수 column을 생략한 insert는 `IR_INVALID`다(DBS-79).
- **DIA-160** `update` — 결과: SQLite와 같다. 규칙: transaction이 읽은 뒤 engine 밖에서 바뀐 파일을 찾은 `COMMIT`은 `WRITE_CONFLICT`이며, 클라이언트는 이를 다시 시도하지 않는다(PRT-71).
- **DIA-161** `delete`, `restore` — 결과: SQLite와 같다. 규칙: foreign key는 SQLite의 것이고, corpus의 규칙도 모든 쓰기를 판정한다([constraints](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/50-constraints.md)).
- **DIA-162** `optimistic` — 결과: SQLite와 같다.
- **DIA-163** `on_duplicate` — 결과: SQLite와 같다. orm의 conflict key 하나를 쓴다.
- **DIA-164** primary key 비교 — 결과: SQLite와 같이 byte 단위로 비교한다. 규칙: key는 파일 이름이자 anchor이므로([document model](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/20-document-model.md)), 표의 다른 key와 A–Z의 대소문자만 다른 key는 `on_duplicate` insert를 포함한 모든 쓰기에서 `DUPLICATE_KEY`다.
- **DIA-165** `lock` `update`, `share` — 결과: SQLite와 같다.
- **DIA-166** `lock` `update_nowait`, `share_nowait` — 결과: SQLite와 같다.
- **DIA-167** 관계(`limit_per_parent`, `if_parent`, `flatten`, `key_by`, `no_cascade_delete`) — 결과: SQLite와 같다. 클라이언트가 조립한다.
- **DIA-168** subquery(`tuple_in`, `tuple_not_in`, scalar `Sub` 집계) — 결과: SQLite와 같다.
- **DIA-169** scalar column subquery — 결과: SQLite와 같다. orm의 규칙을 따른다.
- **DIA-170** column 비교 — 결과: SQLite와 같다. orm의 규칙을 따른다.
- **DIA-171** `contains` — 결과: SQLite와 같다.
- **DIA-172** `contains_binary` — 결과: SQLite와 같다.
- **DIA-173** `now`, `default now`, `updated`, `soft_delete` — 결과: SQLite와 같다. 요청의 clock을 쓴다.
- **DIA-174** `soft_delete` — 결과: SQLite와 같다. orm의 규칙을 따른다.
- **DIA-175** codec column — 결과: SQLite와 같이 클라이언트가 적용한다. 규칙: engine이 시작하는 쓰기(CLI, MCP, sidecar, history)는 orm의 Go codec package로 codec을 적용하고, 검증도 같은 package로 디코딩한다.
- **DIA-176** index — 결과: SQLite와 같다. corpus의 데이터베이스가 선언된 index를 가진다.
- **DIA-177** `select explicit`, `entity`, `navigation` — 결과: SQLite와 같이 클라이언트에서 처리한다.
- **DIA-178** `aes`, `aes_version`, `blind_index` — 결과: SQLite와 같다. 클라이언트가 암호화하고 복호화한다. 규칙: corpus는 이 설정을 받으며, engine은 자기가 시작하는 쓰기와 검증을 위해 주입된 key를 읽는다([schema](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/30-schema.md)).
- **DIA-179** `audit`, `immutable` 설정 — 결과: SQLite와 같다. orm이 audit 기록과 history를 쓴다. 규칙: corpus는 engine을 통한 `immutable` 표의 변경도 거부한다.
- **DIA-180** 트랜잭션 — 결과: SQLite의 문이다. 규칙: `readOnly`는 SQLite의 `query_only`다.
- **DIA-181** savepoint — 결과: SQLite와 같다.
- **DIA-182** `orderByRandom` — 결과: SQLite와 같다.
- **DIA-183** audit 값을 가진 트랜잭션 — 결과: SQLite와 같다.
- **DIA-184** `isolation`, `timeoutMs` 옵션 — 결과: SQLite와 같다.
- **DIA-185** `getQuery()`, `getPagePlanSteps()`, statement event, `subscribe()`, `utils().run(fn)` — 결과: SQLite와 같다. 문은 SQLite의 문이다.
- **DIA-186** `force_index` — 결과: SQLite와 같다.
- **DIA-187** `fulltext` — 결과: SQLite와 같다.
- **DIA-188** lock, local-setting, privilege, AES-rotation utility — 결과: SQLite와 같다.
- **DIA-189** schema install, dbplan chain — 결과: SQLite와 같다. 규칙: corpus에서 schema 문은 자기 트랜잭션이며, `dbspec/statements.json`에 덧붙는다([operations](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/40-ops.md)).
- **DIA-190** 사용할 수 없는 table(`format.block`, `format.section`, `format.encoding`이나 그 행 사이의 `parent.cycle`이 있는 file, 바이트 단위로 같은 key를 가진 두 행, 또는 자리의 `corpus.walk` 항목) — 결과: 그 행이 필요한 모든 요청은 읽기든 쓰기든 file과 진단을 밝히며 `CONSTRAINT`로 실패하며, 다른 file들의 행만으로 답하지 않는다([canonical format](https://github.com/polyspec/flowmark/blob/16a55a50fc8d/docs/spec/10-canonical-format.md))
- **DIA-199** Go와 Rust와 TypeScript와 Python: markdown 연결(DIA-154)의 pool 설정 `poolSize`, `poolIdleSize`,
  `poolLifetimeMs`(CFG-4, CFG-5) — 결과: SQLite에서와 같다. 설정했든 기본값이든 pool 크기를 넘는 idle 크기는 `CONFIG`로
  거부된다. PHP와 PHP extension은 pool을 유지하지 않는다(CFG-4).

## Notifications

- **DIA-192** **정의.** `notify(channel, payload)`, `listen(channel)`, `unlisten(channel)`은 PostgreSQL dialect의 클라이언트 작업이다: PostgreSQL의 `pg_notify`와 `LISTEN` / `UNLISTEN`. IR이 아니므로 planner나 executor가 만들지 않는다([protocol](protocol.ko.md#_6-notifications)). channel은 U+0000 없는 UTF-8 1~63바이트의 PostgreSQL 식별자이며, 그 범위 밖의 channel은 문을 실행하기 전에 `CONFIG`로 실패한다.
- **DIA-193** **notify.** `notify`는 자기 handle의 연결에서 `SELECT pg_notify($1, $2)`를 실행한다. transaction 안에서는 알림이 그 transaction이 commit될 때 전달되고 rollback되면 버려지며, 밖에서는 자기 문의 commit에 전달된다. PostgreSQL payload는 8000바이트보다 짧아야 한다. UTF-8 8000바이트 이상이거나 U+0000을 포함한 payload는 문을 실행하기 전에 `DRIVER`로 실패한다.
- **DIA-194** **listen.** `listen(channel)`은 pool 밖의 자기 연결을 열고, channel을 인용된 식별자로 `LISTEN`을 실행하며, 알림마다 channel, payload, 보낸 프로세스의 pid를 준다. 받기 대기가 없을 때 도착한 알림은 도착 순서대로 보관한다. 연결이 끊기면 구독은 `CONNECTION_LOST`로 끝난다.
- **DIA-195** **unlisten과 취소.** `unlisten(channel)`은 listen 연결에서 `UNLISTEN`을 실행하고 그 channel의 전달을 멈춘다. `close()`는 구독의 모든 channel에 `UNLISTEN`을 실행하고 연결을 클라이언트에 오류 없이 돌려준다. 대기 중인 받기는 [CFG-9](config.ko.md)가 정하는 대로 그 언어의 취소 수단으로 취소한다: Go는 `db.WithContext(ctx)`의 context를, TypeScript는 `db.withSignal(signal)`의 signal을 취소한다. Python, PHP, Rust에는 받기를 위한 그런 수단이 없으므로 그 받기는 기한을 받으며, 기한이 지나면 받기가 끝난다. 취소되었거나 기한이 지난 받기는 `CANCELED`로 실패하고 구독을 닫으며, 그 뒤의 호출은 `CONFIG`로 실패한다.
- **DIA-196** **다른 데이터베이스.** MySQL, SQLite, markdown 연결에서 `notify`, `listen`, `unlisten`은 문이나 연결을 쓰기 전에 `CAPABILITY_UNSUPPORTED`로 실패한다. 어느 것도 조용한 no-op이 아니다.
- **DIA-197** Python 드라이버 형식: Python client는 엔진이 쓴 문장을 자기 드라이버 형식으로 바꿔 전송한다. MySQL의 `?` 표지는 `%s`가 되고 값을 순서대로 받는다. PostgreSQL의 `$n` 표지는 이름 `pn`을 가진 `%(pn)s`가 된다. 인용 문자열, 인용 식별자, 주석 안의 표지는 글자이므로 그대로 둔다. 드라이버가 문장 전체를 형식화하므로 문장의 모든 `%`는 `%%`로 쓴다. 값이 없는 문장은 인자 없이 그대로 드라이버에 넘긴다.
