# Schema plan

plan은 database를 한 schema에서 다음 schema로 바꾼다. plan은 target schema와, schema가 표현하지 못하는 결정인 rename과 drop 허가를 담는다. plan은 빈 database에서 시작하는 chain을 이룬다. 모든 client는 plan의 두 schema를 같은 방식으로 diff하고 dialect마다 같은 step을 쓴다. `tests/dbspec/plans.json`이 공유 case를 담는다.

## Plan 문서

plan은 관례상 `<name>.dbplan`인 UTF-8, LF 줄 끝 text file이다.

```
dbplan 1 add_clients
from sha256:3b1f…
rename table users clients
rename column clients.mail email
allow drop table legacy
allow drop column clients.fax

dbspec 1 schema

table clients {
  …
}
```

- 첫 줄은 정확히 `dbplan 1 <name>`이며 name은 [이름 규칙](dbspec.md#names)을 따른다.
- 둘째 줄은 chain의 첫 plan이면 `from empty`, 아니면 plan이 시작하는 schema의 `from <schemaHash>`다.
- 그다음 한 줄에 하나씩 `rename table <old> <new>`, `rename column <table>.<old> <new>`(`<table>`은 target의 table 이름), `allow drop table <name>`, `allow drop column <table>.<name>`(source의 이름)을 쓴다.
- 빈 줄에서 header가 끝난다. 나머지는 target이다. canonical form의 `schema`라는 문서 하나인 [schema text](dbspec.md#manifest-and-hashes)이며, plan의 `to` hash는 그 text의 `schemaHash`다.

canonical plan은 header 줄을 `rename table`, `rename column`, `allow drop table`, `allow drop column` 순서로, 각각 이름 순으로 쓴다. 줄이 다른 형식이거나, 이름이 이름 규칙을 어기거나, 줄이 반복되거나, 두 rename이 한 이름을 주거나, target이 schema text가 아니면 plan은 그 줄에 `plan` diagnostic을 가진 잘못된 plan이다. target의 diagnostic은 plan 안의 위치로 보고한다. target hash가 `from`과 같은 plan도 잘못이고, target에 `use` 줄이 있는 plan도 그렇다. plan은 database 전체를 바꾸며, [외부 문서](dbspec.ko.md#external-documents)를 쓰는 집합은 install과 addTablesAndColumns로 설치하고 올린다.

## Chain

directory의 plan들은 chain 하나를 이룬다. `from empty` plan이 먼저 오고, 다음 plan은 앞 plan의 `to` hash에서 시작한다. plan이 없는 directory는 빈 chain이며 그 database에는 table이 없다. plan이 있을 때 `from empty` plan이 없거나, 두 plan의 `from`이 같거나, chain이 닿지 않는 plan이 있거나, cycle이 있으면 그 plan들을 적은 `chain` diagnostic이다.

## Diff

plan의 diff는 source(앞 plan의 target이나 빈 schema)와 target을 비교한다. source는 plan의 `from` hash를 가져야 한다. table은 같은 이름끼리, 이름을 바꾼 table은 새 이름을 기준으로 맞추고, 맞춘 table의 column도 같다. source에 없는 옛 이름, source에 이미 있는 새 이름, target에 없는 새 이름의 rename은 `plan` diagnostic이다.

| 변경 | 조건 | 허가 |
| --- | --- | --- |
| `create_table` | target에만 있는 table | |
| `drop_table` | source에만 있는 table | `allow drop table` |
| `rename_table`, `rename_column` | rename | |
| `add_column` | target에만 있는 column | |
| `drop_column` | source에만 있는 column | `allow drop column` |
| `alter_column` | type이 넓어지거나 `null`이나 default가 바뀌는 맞춘 column | |
| `unique`, `index`, `foreign_key`, `check`의 `drop_*`, `add_*` | 한쪽에만 있거나 rename 뒤 정의가 다른 객체 | |
| `drop_triggers`, `create_triggers` | 렌더링한 `immutable`이나 `audit` statement가 한 dialect에서라도 다른 table | |

넓히기는 세 database에서 모든 값을 지킨다. `i16`에서 `i32`나 `i64`로, `i32`에서 `i64`로, `varchar(n)`에서 `m ≥ n`인 `varchar(m)`이나 `text`로, `decimal(p,s)`에서 `q ≥ p`인 `decimal(q,s)`로, `time(p)`나 `datetime(p)`에서 정밀도가 큰 같은 type으로다. 다음은 두 plan 사이에서 새 column이나 table을 채워야 하거나 PostgreSQL이 주는 column 순서를 지킬 수 없으므로 `plan` diagnostic이다.

- default 없는 non-null column을 table에 더하기
- 그 밖의 type 변경, `identity` 변경, primary key 변경
- 다른 순서의 맞춘 column, 맞춘 column 앞에 더한 column
- 허가 없는 drop, 아무것도 지우지 않는 허가

정의가 그대로여도 다시 만드는 객체가 있다. 이름이 바뀌거나 바뀐 column을 쓰는 check, 양쪽 어느 column이든 바뀐 foreign key, 그리고 column이 지우는 index나 unique key의 앞부분인 foreign key다. 마지막은 MySQL이 그렇지 않으면 그 index를 지우지 않기 때문이다. `<table>$<column>` 이름의 renderer CHECK은 이름이나 text가 바뀌면 지우고 더한다. 같은 schema끼리의 diff는 비어 있다.

## 비교

비교는 plan 없이 두 schema의 모든 차이를 나열한다. database가 model과 어떻게 다른지 보여 주는 도구를 위한 것이다. rename과 허가가 없으므로 table과 column은 같은 이름끼리만 맞춘다. 양쪽은 [schema text](dbspec.ko.md#manifest-and-hashes)의 문서다. canonical emission이 그 문서 하나의 schema text가 아닌 쪽은 그쪽을 밝히는 `compare` diagnostic(1줄 1칸)이며 source가 target보다 먼저 오고, 그때 비교에는 차이가 없다. 차이는 `[kind, table, name]`이다. `name`은 column이나 객체의 이름이고, table, key, 순서, setting kind에서는 비어 있다.

| Kind | 조건 |
| --- | --- |
| `create_table` | target에만 있는 table |
| `drop_table` | source에만 있는 table |
| `drop_column` | source에만 있는 column |
| `add_column` | target에만 있는 column |
| `alter_column` | type이 넓어지거나 `null`이나 default가 바뀌는 양쪽의 column |
| `change_column_type` | type이 넓어지지 않고 바뀌는 양쪽의 column |
| `change_column_identity` | `identity`가 바뀌는 양쪽의 column |
| `reorder_columns` | 양쪽의 column이 다른 순서로 오거나, target에만 있는 column이 양쪽의 column 앞에 온다 |
| `change_primary_key` | primary key의 column이나 column 순서가 다르다 |
| `drop_unique`, `add_unique`, `drop_index`, `add_index`, `drop_foreign_key`, `add_foreign_key`, `drop_check`, `add_check` | source에만 또는 target에만 있는 객체. 정의가 다르면 둘 다 |
| `drop_immutable`, `add_immutable` | source에만 또는 target에만 있는 `immutable` setting |
| `drop_audit`, `add_audit` | source에만 또는 target에만 있는 `audit` setting. 이력 table, audit column, audit 기록 table, action, previous column이 다르거나 두 table에 다 있는 column 가운데 기록하는 column이 다르면 둘 다(한쪽에만 있는 column은 `add_column`이나 `drop_column`) |

plan diff에도 있는 kind는 뜻이 같고, 넓히기는 "Diff"의 것이다. `change_column_type`, `change_column_identity`, `reorder_columns`, `change_primary_key`는 plan이 거부하는 변경이다. column 하나가 여러 kind를 가질 수 있다. 예를 들어 `null`과 type이 함께 바뀌면 `alter_column`과 `change_column_type`이다. 정의는 쓰인 그대로 비교하므로 정의가 그대로인 객체를 지우고 다시 더하지 않으며, setting은 렌더링한 trigger 대신 setting 자체를 비교한다. 만들거나 지우는 table은 그 밖의 차이를 나열하지 않는다. 차이는 table 이름 순으로, table 안에서는 위 표의 순서(행 순, 행 안에서 왼쪽부터)로, kind 안에서는 이름 순으로 온다. 비교는 두 schema text가, 따라서 `schemaHash`가 같을 때에만 비어 있다.

Go는 `CompareSchemas`, PHP는 `Dbspec::compareSchemas`, TypeScript는 `compareSchemas`, Rust는 `compare_schemas`를 가진다. 각각 source와 target 문서를 받아 차이나 diagnostic을 돌려준다.

## Step

plan은 statement 하나씩인 step으로 실행된다. 모든 step은 statement, 그 statement가 한 일을 정확히 되돌리는 rollback statement, 그리고 statement가 효과를 냈는지 알려 주는 효과("효과" 참고)를 가지며, 어떤 step은 restore statement와 null 검사도 가진다. Go `PlanSteps`, PHP `Dbspec::planSteps`, TypeScript `planSteps`, Rust `orm_schema::dbspec::plan_steps`는 source 문서(빈 schema이면 없음), plan, dialect를 받아 step이나 plan diagnostic을 돌려준다. `tests/dbspec/plans.json`은 모든 case와 dialect의 step을 `statement`, `rollback`이나 `irreversible`, `effect`, 그리고 해당하면 `restore`와 `restore_if`, `null_checks`, `finalize: true`를 가진 object로 적는다.

step은 이 순서로 오며, 각 묶음 안에서 table과 객체는 이름 순이다.

1. 바뀌는 trigger, SQLite가 다시 만드는 table의 trigger, 지우는 table의 trigger를 PostgreSQL function과 함께 지운다.
2. 바뀌는 foreign key와 지우는 table의 foreign key를 지운다.
3. 바뀌는 check, renderer CHECK, unique key, index와 지우는 table의 것을 지운다.
4. table, 그다음 column의 이름을 바꾼다.
5. 지우는 column(MySQL, PostgreSQL), 그다음 지우는 table을 숨긴다.
6. [renderer](dialects.md#rendered-statements)가 쓰는 대로 table을 만든다.
7. column을 더하고 바꾸며, SQLite에서는 table을 다시 만든다.
8. unique key, index, check, renderer CHECK을 더한다.
9. 만든 table의 foreign key와 바뀌는 foreign key를 더한다.
10. 만든 table, 다시 만든 table, 바뀌는 table의 trigger를 만든다.
11. finalize: 숨긴 table과 column을 지운다.

MySQL은 column을 렌더링한 전체 정의의 `MODIFY COLUMN`으로 바꾸고, PostgreSQL은 `ALTER COLUMN`의 `TYPE`, `SET NOT NULL`, `DROP NOT NULL`, `SET DEFAULT`, `DROP DEFAULT`를 이 순서로 쓴다.

**Rollback statement.** trigger, PostgreSQL function, foreign key, check, renderer CHECK, unique key, index를 지우는 statement는 source 객체를 만드는 statement로 되돌린다. 이름 바꾸기는 반대 이름 바꾸기로, 만든 table, index, key, check, trigger, function은 그것을 지우는 statement로 되돌린다. MySQL `MODIFY COLUMN`은 source 정의의 `MODIFY COLUMN`으로, PostgreSQL `TYPE`은 source type으로, `SET NOT NULL`은 `DROP NOT NULL`로 그리고 그 반대로, `SET DEFAULT`나 `DROP DEFAULT`는 source default를 설정하거나 지워 되돌린다. rollback statement는 실행될 때의 table과 column 이름을 쓰므로, 4번 묶음 뒤의 step에서는 바뀐 이름을 쓴다.

**지우는 대신 숨기기.** plan은 finalize step 전에는 데이터를 없애지 않는다. 지우는 table이나 column은 보관 이름을 받아 row와 값을 가진 채 finalize가 지울 때까지 남고, rollback은 같은 위치에서 원래 이름을 돌려준다. 보관 이름은 `dbspec$hold$<h>$<n>`이다. `<h>`는 plan `to` hash의 앞 12자리 hex이고, `<n>`은 plan의 지우는 column(table 이름 순, 그다음 source column 순), 그다음 지우는 table(이름 순), 그다음 더하는 column(table 이름 순, 그다음 target column 순)에 1부터 번호를 붙인다. 숨기는 이름의 길이와 상관없이 최대 28자이며, dbspec 이름에는 `$`가 없으므로 겹치지 않는다. introspection은 이름이 `dbspec$`로 시작하는 table과 column을 모두 뺀다.

- MySQL과 PostgreSQL에서 table `t`의 지우는 column `c`: `c`가 non-null이면 그것 없이 쓰는 write가 성공하도록 `c`를 nullable로 바꾸는 `ALTER TABLE t MODIFY COLUMN`(PostgreSQL `ALTER TABLE t ALTER COLUMN c DROP NOT NULL`), 그다음 `ALTER TABLE t RENAME COLUMN c TO h`다. rollback은 이름을 되돌리고 source 정의를 복원한다. default는 남으므로 그것 없이 쓴 row는 default를 받는다.
- 지우는 table `t`는 trigger, foreign key, check, renderer CHECK, unique key, index를(SQLite에서는 trigger와 index를) 지운 뒤 `ALTER TABLE t RENAME TO h`로 숨기고 `ALTER TABLE h RENAME TO t`로 되돌린다. 숨긴 SQLite table은 foreign key를 유지하므로, 그것이 참조하는 parent row를 지우면 table이 있는 것처럼 동작한다. MySQL과 PostgreSQL에서는 rollback이 foreign key를 다시 더하며, 그사이 parent row가 지워졌으면 그 step에서 실패한다. 명령의 SQLite connection은 `PRAGMA legacy_alter_table = OFF`를 설정하므로, 그곳의 이름 바꾸기도 MySQL과 PostgreSQL처럼 다른 table의 foreign key를 데려간다.
- MySQL과 PostgreSQL에서 더한 column `c`는 그 값을 지키는 `ALTER TABLE t RENAME COLUMN c TO h`로 되돌린다. 그 step은 restore statement `ALTER TABLE t RENAME COLUMN h TO c`를 가지며, table에 column `h`가 있으면 apply와 recover가 statement 대신 그것을 실행하므로, rollback 뒤 plan을 다시 적용하면 column이 값과 함께 돌아온다.
- SQLite는 table을 다시 만들어서만 column을 바꾼다. 맞춘 table은 이름, column, foreign key, check 중 하나라도 바뀌면 다시 만들며, index와 unique key만, 또는 trigger만 바뀌면 다시 만들지 않는다. 이름 바꾸기가 먼저 실행되므로 다른 table의 foreign key가 따라온다. 다시 만들기는 각 statement가 현재 row를 옮기는 rollback을 갖도록 작업 table `dbspec$rebuild`를 거쳐 row를 옮겼다가 되돌린다: 새 정의의 `CREATE TABLE "dbspec$rebuild"`, `INSERT INTO "dbspec$rebuild" (…) SELECT … FROM t`, `t`의 unique key와 index마다 `DROP INDEX`, `DELETE FROM t`, `DROP TABLE t`, 새 정의의 `CREATE TABLE t`, `INSERT INTO t (…) SELECT … FROM "dbspec$rebuild"`, `DELETE FROM "dbspec$rebuild"`, `DROP TABLE "dbspec$rebuild"`, 그리고 새 정의의 unique key와 index다. `identity` column이 있는 table은 빈 table로 복사하기 전마다 `INSERT INTO sqlite_sequence (name, seq) SELECT …`, row를 옮긴 table의 `DELETE FROM` 전마다 `DELETE FROM sqlite_sequence WHERE name = …`로 automatic key counter, 즉 지운 row의 key까지 포함해 지금까지 준 가장 큰 key를 옮기므로 key를 다시 쓰지 않는다. 새 정의는 target table에 지우는 column을 nullable이고 CHECK 없이 보관 이름을 붙여 더한 것이다. `DROP TABLE t`의 rollback이 만드는 옛 정의는, 이름 바꾸기가 바꾼 이름을 쓰고 renderer CHECK은 SQLite가 이름 바꾸기 뒤에 남기는 대로 source 이름을 가진 source table에, 더하는 column을 nullable이고 CHECK 없이 보관 이름을 붙여 더한 것이다. 새 정의로의 복사는 정밀도가 커지는 `time(p)`나 `datetime(p)` column에 0인 소수 자리를 덧붙이고, table에 더하는 column의 보관 이름이 있으면 그것에서 옮기며, 그것이 restore statement다.
- finalize step은 숨긴 table과 column을 번호 순서로 지운다: `DROP TABLE h`와 `ALTER TABLE t DROP COLUMN h`다. rollback이 없다.

**되돌릴 수 없는 step.** step을 되돌리면 error 없이 값이 바뀔 수 있을 때만 그 step에는 rollback statement가 없고 `irreversible`로 이유를 적는다: `time(p)`나 `datetime(p)` column의 정밀도를 넓히는 step이다. 다시 좁히면 MySQL과 PostgreSQL은 그동안 쓴 값을 반올림하고, 그렇지 않으면 SQLite의 CHECK이 그 값을 거부한다(`narrowing the precision rounds the values written since`). SQLite에서는 그것을 넓히는 다시 만들기의 `DELETE FROM t`에 rollback이 없다. 넓힌 정수, `varchar`, `text`, `decimal`을 되돌리는 다른 좁히기는 맞지 않는 값에서 실패하며(MySQL은 [dialects](dialects.md)의 strict `sql_mode`에서) rollback이다. apply는 plan을 실행하기 전에 되돌릴 수 없는 step을 알리고, rollback은 그 앞에서 멈춘다.

**non-null column 복원.** column을 다시 non-null로 만드는 rollback statement(지우는 column, plan이 nullable로 바꾼 column, 또는 그런 column을 되돌려 복사하는 SQLite 다시 만들기)는 null 검사를 가진다: table, 적용한 plan에서의 column 이름, source default다. 적용한 plan의 rollback은 어떤 step도 실행하기 전에 그 column이 NULL인 row, 즉 그사이 쓰인 row의 수를 확인한다. source default가 있으면 `UPDATE t SET c = <default> WHERE c IS NULL`로 default를 넣고, 없으면 plan, step, table, column, row 수를 적은 `nulls` error로 멈추며 아무것도 바꾸지 않는다.

**효과.** step의 효과는 `present`나 `absent`와 `table`, `column`(table, column), `index`(table, index), `constraint`(table, constraint), `trigger`(table, trigger), `function`(function), `sequence`(이름의 `sqlite_sequence` row), `rows`(table에 row가 있는지) 중 하나이거나, 다시 실행해도 결과가 같은 statement(`MODIFY COLUMN`과 `ALTER COLUMN`)의 `repeat`이다. rollback statement는 step을 그 효과의 반대로 되돌리고, restore statement는 그 step의 효과를 가진다. `tests/dbspec/plans.json`은 효과를 `repeat`이나 상태, 종류, 이름의 text로 적는다. 예: `present table users`, `absent column users nick`. step의 `restore`는 그것을 고르는 효과 `restore_if`와 함께 적는다.

## Apply

orm은 세 database 모두에서 schema 변경을 step 하나씩 적용한다. 모든 statement는 transaction 밖에서 따로 commit하고, 그 뒤에 history step을 기록한다. plan이 실행되는 동안 다른 session은 commit된 step을 하나씩 본다. 중단되거나 실패한 plan은 알려진 step에서 멈추며, `recover`가 그것을 이어 가고 `rollback`이 step 하나씩 되돌린다. 다른 session이 변경을 한꺼번에 보거나 전혀 보지 않아야 하면 maintenance window나 database의 blue-green 전환이 필요하며, 이것은 운영자가 선택하고 orm은 제공하지 않는다. 이 명령들은 database를 document set 하나의 schema로 본다. 그 상태는 database의 모든 table의 schema이므로, 한 set이 다른 set의 [외부 문서](dbspec.ko.md#external-documents)를 쓰며 database 하나를 나누는 여러 set의 table은 대신 install과 addTablesAndColumns로 설치하고 올린다.

apply, recover, rollback, finalize는 caller가 가진 connection 하나에서 실행되며 끝에 그 session 설정을 되돌린다. lock과 session 설정은 server session에 속하므로 MySQL과 PostgreSQL에서 connection은 명령 내내 다른 client와 나누지 않는 server session 하나를 지켜야 한다: 직접 연결이나 session pooling 연결이다. `pool_mode = transaction`인 PgBouncer 같은 transaction pooler는 transaction이나 statement마다 server connection을 고르므로, lock이 transaction 밖에서 하나씩 실행되는 step을 덮지 못한다. 명령은 이것을 알아내고 lock 없이 실행하는 대신 `session` error로 멈춘다. lock을 잡기 전에 명령은 server session(MySQL `CONNECTION_ID()`, PostgreSQL `pg_backend_pid()`)과, 그 session이 lock을 이미 잡고 있는지(MySQL lock 이름의 `IS_USED_LOCK`, PostgreSQL advisory key의 `pg_locks` row)를 읽는다. 이미 잡고 있는 session은 다른 client와 나눠 쓰는 것이므로 `session` error다. lock statement도 server session을 돌려주고(`SELECT GET_LOCK(…, 0), CONNECTION_ID()`, `SELECT pg_try_advisory_lock(…), pg_backend_pid()`), 명령은 모든 step의 statement 앞에서 server session을 다시 읽는다. 처음과 다른 session은 plan과 step이 들어 있는 `session` error이며 그 step의 statement는 실행되지 않는다. error message에는 요구가 들어 있다: `apply, recover, rollback and finalize need one server session of their own for the whole run: a direct or session-pooled connection`. ProxySQL이 multiplexing하는 connection은 `GET_LOCK`을 실행한 뒤 server session을 지키므로 이 확인을 통과한다.

1. **Lock.** lock은 명령이 바꾸는 database 하나만 덮으므로, 다른 database나 PostgreSQL database 하나의 다른 schema에 대한 명령은 동시에 실행된다. MySQL은 `GET_LOCK(CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51)), 0)`를 잡고 같은 이름의 `RELEASE_LOCK`으로 놓는다. 이 이름은 현재 database 이름의 SHA-256 앞 51자리 hex를 담으며, database 이름의 길이와 상관없이 MySQL이 받는 최대 길이인 64자다. PostgreSQL은 `pg_try_advisory_lock(hashtext('dbspec$plans'), hashtext(current_schema()))`를 잡고 같은 key의 `pg_advisory_unlock`으로 놓는다. advisory lock은 현재 database에 속하며, 이름의 `hashtext`가 같은 두 schema는 lock을 함께 쓴다. SQLite는 `PRAGMA locking_mode = EXCLUSIVE`를 설정하고 `BEGIN EXCLUSIVE`와 `COMMIT`을 실행하므로, connection은 명령이 이전 locking mode를 되돌리고 database를 한 번 읽을 때까지 file의 exclusive lock을 유지하며 다른 connection은 읽지도 쓰지도 못한다. 그다음 foreign key를 끄고 `PRAGMA legacy_alter_table = OFF`를 설정한다. 다른 session이 잡은 lock은 `locked` error이며 아무것도 바뀌지 않는다. MySQL `1`이나 `0`, PostgreSQL `true`나 `false`가 아닌 결과는, 현재 schema가 없는 PostgreSQL connection의 NULL처럼, error다.
2. **Lock 대기.** statement는 다른 session이 잡은 lock을 최대 5초 기다린다: PostgreSQL `SET lock_timeout = '5s'`, MySQL `SET SESSION lock_wait_timeout = 5, innodb_lock_wait_timeout = 5`, SQLite `PRAGMA busy_timeout = 5000`이며, 이 값은 SQLite lock을 기다리는 시간도 정한다. 시간이 지난 statement는 database error를 담은 그 step의 `failed` error다.
3. **History.** table `dbspec$plans`는 plan마다 row 하나를 기록한다: `name`, `from_hash`, `to_hash`, `state`, `step`(효과가 있는 step 수), `steps`, `applied_at`(UTC tool clock을 소수 여섯 자리로 쓴 `YYYY-MM-DDTHH:MM:SS.ffffffZ`. 모든 database에 text로 저장하므로 어느 database도 자리를 버리지 않는다. clock은 [protocol](protocol.ko.md)이 정한다. 각 명령은 clock을 함수로 받는다: Go `time.Time`, PHP `DateTimeImmutable`, Rust `DateTime<Utc>`, TypeScript는 `Date`가 millisecond만 가지므로 epoch 이후 microsecond 수). state는 `applying`, `applied`, `finalizing`, `done`, `rolling_back` 중 하나다. 모든 명령은 이 table이 없으면 만든다.
4. **State.** database는 chain 순서에서 마지막 row의 `to_hash`에 있거나 비어 있다. `applying`, `finalizing`, `rolling_back` row는 중단된 plan이며, apply와 finalize는 이를 plan과 step을 적은 `interrupted` error로 보고한다. apply와 finalize는 database를 introspect해 `schemaHash`가 state이고 미지원 객체가 없기를, 빈 state에는 table이 없기를 요구한다. 그렇지 않으면 두 hash를 적은 `drift` error다. state를 담지 않은 chain은 `chain` error이며, 마지막 앞의 row가 `applied`나 `done`이 아닌 것도 그렇다. rollback과 중단된 plan의 recover는 `step`이 plan의 step 밖인 row를 `chain` error로 보고한다.
5. **Apply.** 다음 plan마다 apply는 rollback이 없는 step을 각각 `irreversible` event로 알리고, row(`applying`, step 0)를 쓰고, finalize step 앞의 step을 실행하며 각 step 뒤에 `step`을 기록한다. SQLite는 그다음 `PRAGMA foreign_key_check`가 row를 돌려주지 않기를 요구한다. apply는 database를 introspect한다. `schemaHash`가 plan의 `to` hash와 같고 미지원 객체가 없어야 한다. 그다음 row가 `applied`가 된다. 실패한 검사는 `verify` error이며 row는 모든 step을 기록한 채 `applying`으로 남는다.
6. **Finalize.** finalize는 `applied`인 모든 plan의 finalize step을 chain 순서로 실행한다. row가 `finalizing`이 되고, 각 step을 기록하고, row가 `done`이 된다. 숨긴 것이 없는 plan은 finalize step이 없어 바로 `done`이 된다.
7. **Recover.** recover는 중단된 plan을 앞으로 이어 간다. 그 `step`이 `k`이면 처음 `k`개 step이 효과를 가진다. `applying`이나 `finalizing` row는 step `k`를 실행했을 수 있으므로, recover는 step `k`의 효과를 읽어 있으면 `k + 1`부터 이어 간다. `rolling_back` row는 step `k - 1`의 rollback을 실행했을 수 있으므로, recover는 step `k - 1`의 효과가 없으면 `k - 1`부터 이어 간다. `repeat` step은 다시 실행한다. apply와 recover는 table에 `restore_if`의 column이 있으면 step의 statement 대신 restore statement를 실행한다. 그다음 recover는 남은 step을 apply처럼 실행해 `applied`까지, `finalizing` row이면 `done`까지 간다. 중단된 plan이 없으면 recover는 아무것도 바꾸지 않는다.
8. **Rollback.** rollback은 history의 마지막 plan을 되돌린다: `applied`, `done`, 또는 중단된 plan이다. recover처럼 효과를 읽고, row를 `rolling_back`으로 바꾸고, step `k - 1`부터 step 0까지 rollback statement를 실행하며 각각 뒤에 `step`을 기록한다. SQLite에서는 그다음 `PRAGMA foreign_key_check`가 row를 돌려주지 않아야 하고, introspect한 `schemaHash`가 plan의 `from` hash와 같거나 첫 plan이면 database에 table이 없어야 한다. 그다음 rollback은 row를 지운다. 적용한 plan의 rollback은 먼저 그 step의 null 검사를 실행한다("non-null column 복원" 참고). rollback이 없는 step은 그 step 앞에서 rollback을 멈추는 `irreversible` error이며 plan과 step을 적는다. 그것이 되돌릴 첫 step이면 아무것도 바뀌지 않는다. `applied` plan은 먼저 drift를 검사한다. row가 없으면 rollback은 아무것도 바꾸지 않는다. rollback은 한 번에 plan 하나를 되돌리므로, 거듭 호출하면 database가 plan 하나씩 뒤로 간다.

각 명령은 일어난 일을 event로 알린다: apply나 recover가 plan을 앞으로 실행할 때 `plan`, rollback과 finalize가 plan에서 시작할 때 `rollback`과 `finalize`(각각 step 수와 함께), rollback이 없는 step의 index와 statement와 함께 `irreversible`, 각 statement 앞뒤로 step index와 statement나 rollback statement와 함께 `statement`와 `applied`, introspection 뒤 `verified`, plan이 그 state에 이르면 `done`이다. error를 돌려주는 event handler는 그 지점에서 명령을 멈추며, row는 마지막으로 기록한 step을 유지한다.

**실패.** 실패한 statement는 plan, step, database error를 적은 `failed` error이며, row는 마지막으로 기록한 step을 유지한다. 실패한 뒤에도 명령은 session 설정을 되돌리고, SQLite foreign key를 다시 켜고, lock을 놓으며, 이 단계의 error를 모두 실패와 함께 보고한다. 아무것도 풀지 않은 advisory unlock은 error이고, row를 돌려주지 않는 효과 query도 error다. 정리 error가 없는 실패는 그대로 보고한다: code를 가진 apply error, history, lock, 설정 statement의 database error, 또는 event handler의 error다. 정리 error가 있으면 client마다 자기 형식으로 모두 담는다:

- Go는 실패와 정리 error를 순서대로 `errors.Join`해 돌려준다. `errors.Is`와 `errors.As`가 그 각각을 찾는다.
- PHP는 previous throwable이 실패이고 `cleanup`이 정리 error를 순서대로 담은 `ApplyCleanupError`를 던진다.
- TypeScript는 `errors`가 실패와 그 뒤 정리 error를 순서대로 담은 `AggregateError`로 reject한다.
- Rust는 실패를 `error`로 가진 `ApplyError::Cleanup { error, cleanup }`을 돌려준다. 그 뒤의 정리 error는 앞의 결과를 다시 `error`로 감싼다. 아무것도 풀지 않은 unlock은 `ApplyError::LockNotHeld`다.

중단된 뒤 recover나 rollback 전까지 plan의 table에 쓰면 안 된다. 예를 들어 SQLite 다시 만들기가 비운 table에 쓴 row는 작업 table에 없다. chain 전체를 적용한 database에서 apply는 아무것도 바꾸지 않는다. 빈 chain의 apply는 history table을 만들고, table이 없는 database를 요구하며, event를 알리지 않는다. 빈 chain의 recover, rollback, finalize는 아무것도 바꾸지 않는다.

Go에는 `Apply`, `Recover`, `Rollback`, `Finalize`, PHP에는 `Dbspec::apply`, `recover`, `rollback`, `finalize`, TypeScript에는 `applyPlans`, `recoverPlans`, `rollbackPlans`, `finalizePlans`, Rust에는 `orm::dbspec::apply`, `recover`, `rollback`, `finalize`가 있다. 각각 connection, dialect, chain의 plan, `applied_at`의 clock, event handler를 받는다. TypeScript connection type(`DbspecApplyMySqlConnection`, `DbspecApplyPostgresConnection`, `DbspecApplySqliteConnection`, 그리고 `introspectDbspec`의 `DbspecMySqlConnection`, `DbspecPostgresConnection`, `DbspecSqliteConnection`)은 pg, mysql2, node:sqlite의 type 없이 client가 호출하는 method만 적는다. mysql2 connection, pg client, node:sqlite database가 이 type에 맞으며, driver 하나만 설치한 code도 공개 선언의 type 검사를 통과한다.

## 검증

`make dbspec-go-check`는 `tests/dbspec/plans.json`의 case를 Go engine으로 실행하고 모든 dialect의 step이 적힌 대로이기를 요구한다. `make dbspec-plan-check`는 모든 case를 MySQL, PostgreSQL, SQLite에 적용한다. source를 렌더링하고, `before` step을 실행하고, finalize 앞의 step을 실행하고(SQLite는 foreign key를 끄고, 그다음 `PRAGMA foreign_key_check`가 row를 돌려주지 않는다), introspect한 schema text가 plan의 target과 같기를 요구한다. 되돌릴 수 없는 step이 없으면 rollback statement를 첫 step까지 실행해 source schema text를 요구하고 step을 다시 실행한다. 그다음 `after` step과 finalize step을 실행하고, target schema text와 이름이 `dbspec$`로 시작하는 table이나 column이 없음을 다시 요구한다. `make dbspec-apply-check`는 history, lock, drift, 검증, recovery, rollback, finalize와 함께 chain을 세 database에 적용한다. `tests/dbspec/plans.json`의 case `representative`를 그 source를 만드는 첫 plan 뒤에 적용하면서 모든 step `k`의 statement 뒤, step을 기록하기 전에 plan을 멈춘다. 그리고 그 멈춘 상태에서 각각 recover로 `applied`까지, rollback으로 첫 plan까지 가며, 적용한 plan의 rollback을 모든 step의 rollback statement 뒤에 멈춘 뒤 첫 plan까지 이어 되돌린다. 매번 history row와 introspect한 schema text를 요구한다. 그다음 plan을 finalize하고 `done` row, 숨긴 table이나 column 없음, `irreversible` rollback을 요구한다. 또 적용한 plan에서 target의 column으로 row를 쓰고, plan을 rollback해 지운 column의 값이 복원되거나 default를 가진 그 row와 source schema text를 요구하며, plan을 다시 적용해 더한 column의 값이 돌아오기를 요구한다. 그리고 숨긴 non-null default 없는 column에 그사이 NULL row가 생긴 plan을 rollback해 row 수를 적은 `nulls` error와 바뀌지 않은 database를 요구한다. `make bench`의 `make dbspec-apply-stress-bench`는 `tests/dbspec/stress.mjs`의 2000 table 문서를 첫 plan으로 세 database에 적용하며, PostgreSQL은 기본 lock 설정이다. `make dbspec-ts-check`와 `make dbspec-plan-ts-check`는 TypeScript client의 `parsePlan`, `emitPlan`, `chainPlans`, `diffPlan`, `planSteps`로 같은 일을 한다. `make dbspec-rust-check`는 같은 case를 Rust client로 실행하고, `make dbspec-plan-rust-check`는 Rust renderer, plan step, introspection으로 적용한다. `make dbspec-php-check`는 같은 case를 PHP client의 `Orm\Dbspec\Dbspec`(`parsePlan`, `emitPlan`, `chain`, `diff`, `planSteps`)으로 실행하고, `make dbspec-plan-php-check`는 그것으로 세 database에 적용한다. `make dbspec-apply-php-check`, `make dbspec-apply-ts-check`, `make dbspec-apply-rust-check`는 `make dbspec-apply-check`의 scenario를 client의 apply, recover, rollback, finalize로 실행한다. 각 client의 plan test는 rule, line, column과 `plan` diagnostic이면 message를 가진 diagnostic의 parse case와, difference나 message를 가진 `compare` diagnostic이 적힌 것과 정확히 같아야 하는 `comparisons` case도 실행한다. `make dbspec-compare-check`는 `tests/dbspec/plans.json`의 모든 항목을 Go, PHP, TypeScript, Rust client로 각각 두 번 실행하고 모든 출력이 첫 Go 출력과 같기를 요구한다: 모든 case의 emit한 plan, change, dialect마다 statement, rollback statement, irreversible 이유, 효과, finalize 표시를 가진 step, 모든 invalid와 parse case의 diagnostic, 모든 chain의 순서나 diagnostic, 모든 비교의 difference나 diagnostic이며, 모든 `plan`, `chain`, `compare` diagnostic의 message를 포함한다. 각 apply check는 PostgreSQL에서 event가 advisory lock을 먼저 푼 apply도 실행해, 아무것도 풀지 않은 unlock이 실패하기를 요구한다. 또 세 database에서 첫 apply가 lock을 잡은 동안 두 번째 database, schema 또는 file에 apply하며 이것은 `locked`가 아니어야 하고, 빈 chain을 event 없이 apply, recover, rollback, finalize하며 table이 있는 database에서는 `drift`이기를 요구한다. 각 apply check는 PgBouncer(`ORM_TEST_PGBOUNCER_DSN`, transaction pooling)로 자기 database에 연결해, 다른 client가 lock을 잡은 채 남긴 server connection에서 실행한 apply와, 첫 `statement` event에서 다른 client의 transaction이 그 server connection을 가져가 다음 statement가 다른 server session에서 실행되는 apply에서 `session` error를 요구한다. 다른 scenario는 server(`ORM_TEST_MYSQL_SERVER_DSN`, `ORM_TEST_POSTGRES_SERVER_DSN`)에서 실행한다. `tests/dbspec/plans.json`은 빈 chain을 chain case `empty`로 담는다. `make dbspec-go-check`, `make dbspec-php-check`, `make dbspec-ts-check`, `make dbspec-rust-check`는 감싼 SQLite connection과 script한 MySQL connection으로 실패를 주입하고, 각 client가 정리 error가 없는 실패는 그대로, 실패한 lock 해제, 실패한 `BEGIN EXCLUSIVE` 뒤 실패한 foreign key 복원, row가 없는 효과 query의 error는 "Apply"의 형식으로 보고하기를 요구한다. `make dbspec-apply-pairs-check`는 `tests/dbspec/apply`의 Go, PHP, TypeScript, Rust client apply runner를 실행한다: MySQL, PostgreSQL, SQLite에서 서로 다른 두 client의 모든 순서쌍마다 첫 client가 chain의 첫 plan을, 둘째 client가 나머지를 적용하고, 첫 client가 statement 뒤에 멈춘 둘째 plan을 둘째 client가 `interrupted`로 거부한 뒤 recover하며, 첫 client가 다시 멈춘 plan을 둘째 client가 rollback한다. 108 run 각각에서 history row와 introspect한 schema text가 chain의 것과 같아야 한다.
