# Schema plan

plan은 database를 한 schema에서 다음 schema로 바꾼다. plan은 target schema와, schema가 표현하지 못하는 결정인 rename과 drop 허가를 담는다. plan은 빈 database에서 시작하는 chain을 이룬다. 모든 client는 plan의 두 schema를 같은 방식으로 diff하고 dialect마다 같은 statement를 쓴다. `tests/dbspec/plans.json`이 공유 case를 담는다.

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

canonical plan은 header 줄을 `rename table`, `rename column`, `allow drop table`, `allow drop column` 순서로, 각각 이름 순으로 쓴다. 줄이 다른 형식이거나, 이름이 이름 규칙을 어기거나, 줄이 반복되거나, 두 rename이 한 이름을 주거나, target이 schema text가 아니면 plan은 그 줄에 `plan` diagnostic을 가진 잘못된 plan이다. target의 diagnostic은 plan 안의 위치로 보고한다. target hash가 `from`과 같은 plan도 잘못이다.

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
| `drop_audit`, `add_audit` | source에만 또는 target에만 있는 `audit` setting. 다르면 둘 다 |

plan diff에도 있는 kind는 뜻이 같고, 넓히기는 "Diff"의 것이다. `change_column_type`, `change_column_identity`, `reorder_columns`, `change_primary_key`는 plan이 거부하는 변경이다. column 하나가 여러 kind를 가질 수 있다. 예를 들어 `null`과 type이 함께 바뀌면 `alter_column`과 `change_column_type`이다. 정의는 쓰인 그대로 비교하므로 정의가 그대로인 객체를 지우고 다시 더하지 않으며, setting은 렌더링한 trigger 대신 setting 자체를 비교한다. 만들거나 지우는 table은 그 밖의 차이를 나열하지 않는다. 차이는 table 이름 순으로, table 안에서는 위 표의 순서(행 순, 행 안에서 왼쪽부터)로, kind 안에서는 이름 순으로 온다. 비교는 두 schema text가, 따라서 `schemaHash`가 같을 때에만 비어 있다.

Go는 `CompareSchemas`, PHP는 `Dbspec::compareSchemas`, TypeScript는 `compareSchemas`, Rust는 `compare_schemas`를 가진다. 각각 source와 target 문서를 받아 차이나 diagnostic을 돌려준다.

## Statement

statement는 이 순서로 오며, 각 단계 안에서 table과 객체는 이름 순이다.

1. 바뀌는 trigger와 지우는 table의 trigger를 PostgreSQL function과 함께 지운다.
2. 바뀌는 foreign key와 지우는 table의 foreign key를 지운다.
3. 바뀌는 check, renderer CHECK, unique key, index를 지운다.
4. table, 그다음 column의 이름을 바꾼다.
5. column, 그다음 table을 지운다.
6. [renderer](dialects.md#rendered-statements)가 쓰는 대로 table을 만든다.
7. column을 더하고 바꾼다.
8. unique key, index, check, renderer CHECK을 더한다.
9. 만든 table과 바뀌는 foreign key를 더한다.
10. 만든 table과 바뀌는 trigger를 만든다.

MySQL은 column을 렌더링한 전체 정의의 `MODIFY COLUMN`으로 바꾸고, PostgreSQL은 `ALTER COLUMN`의 `TYPE`, `SET NOT NULL`, `DROP NOT NULL`, `SET DEFAULT`, `DROP DEFAULT`를 이 순서로 쓴다.

SQLite는 맞춘 table의 이름, column, foreign key, check 중 하나라도 바뀌면 table을 다시 만든다. target table을 `"$rebuild"`로 만들고, table에 `identity` column이 있으면 `INSERT INTO sqlite_sequence (name, seq) SELECT '$rebuild', seq FROM sqlite_sequence WHERE name = '<table>'`로 automatic key counter를 옮겨 지운 row의 key까지 포함해 지금까지 준 가장 큰 key를 유지하므로 key를 다시 쓰지 않고, 맞춘 column을 `INSERT … SELECT` 하나로 옮기고, table을 지우고, `"$rebuild"`에 원래 table 이름을 주고, index를 만들고 trigger를 다시 만든다. rename이 먼저 실행되므로 다른 table의 foreign key가 따라온다. 정밀도가 커지는 `time(p)`나 `datetime(p)` column은 0인 소수 자리를 덧붙여 옮긴다. index와 unique key만, 또는 trigger만 바뀌면 다시 만들지 않는다. SQLite는 foreign key를 끄고 plan을 실행한 뒤 검사한다(`PRAGMA foreign_key_check`가 row를 돌려주지 않는다).

## Apply

apply는 database가 아직 적용하지 않은 chain의 plan을 connection 하나에서 plan 하나씩 실행한다.

1. **Lock.** lock은 apply가 바꾸는 database 하나만 덮으므로, 다른 database나 PostgreSQL database 하나의 다른 schema에 대한 apply는 동시에 실행된다. MySQL은 `GET_LOCK(CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51)), 0)`를 잡고 같은 이름의 `RELEASE_LOCK`으로 놓는다. 이 이름은 현재 database 이름의 SHA-256 앞 51자리 hex를 담으며, database 이름의 길이와 상관없이 MySQL이 받는 최대 길이인 64자다. PostgreSQL은 `pg_try_advisory_lock(hashtext('dbspec$plans'), hashtext(current_schema()))`를 잡고 같은 key의 `pg_advisory_unlock`으로 놓는다. advisory lock은 현재 database에 속하며, 이름의 `hashtext`가 같은 두 schema는 lock을 함께 쓴다. SQLite는 foreign key를 끄고 apply 전체를 그 file의 `BEGIN IMMEDIATE` transaction 하나에서 실행한다. 다른 session이 잡은 lock은 `locked` error이며 아무것도 바뀌지 않는다. MySQL `1`이나 `0`, PostgreSQL `true`나 `false`가 아닌 결과는, 현재 schema가 없는 PostgreSQL connection의 NULL처럼, error다.
2. **History.** table `dbspec$plans`는 plan마다 row 하나를 기록한다: `name`, `from_hash`, `to_hash`, `state`(`running`이나 `done`), `step`(끝난 statement 수), `steps`, `applied_at`(UTC, `YYYY-MM-DDTHH:MM:SSZ`). apply는 이 table이 없으면 만든다. 이름에 dbspec 이름에는 없는 `$`가 있고, introspection은 이 table을 보고하지 않고 뺀다.
3. **State.** database는 chain 순서에서 마지막 `done` row의 `to_hash`에 있거나 비어 있다. `running` row는 plan과 step을 적은 `interrupted` error다. apply는 database를 introspect해 `schemaHash`가 그 state이고 미지원 객체가 없기를 요구하며, 빈 state에는 table이 없어야 한다. 그렇지 않으면 두 hash를 적은 `drift` error다. state를 담지 않은 chain은 `chain` error다.
4. **Statement.** 다음 plan마다 apply는 `running` row를 쓰고 statement를 실행하며, 각 statement 뒤에 `step`을 기록한다. PostgreSQL은 plan 하나를 row와 함께 transaction 하나에서 실행한다. SQLite는 plan마다 `PRAGMA foreign_key_check`가 row를 돌려주지 않기를 요구한다. MySQL은 statement마다 따로 commit한다.
5. **검증.** apply는 database를 introspect한다. `schemaHash`가 plan의 `to` hash와 같고 미지원 객체가 없어야 하며, 아니면 `verify` error이고 PostgreSQL은 plan을, SQLite는 apply 전체를 되돌린다. 그다음 row가 `done`이 된다.

apply는 일어난 일을 event로 알린다: plan이 시작할 때 statement 수와 함께 `plan`, 각 statement 앞뒤로 index와 text와 함께 `statement`와 `applied`, 그리고 `verified`, `done`이다. error를 돌려주는 event handler는 그 지점에서 apply를 멈춘다.

**실패.** 실패한 뒤에도 apply는 lock을 놓고 transaction을 끝내며 SQLite에서는 foreign key를 다시 켜고, 이 단계의 error를 모두 실패와 함께 보고한다. 아무것도 풀지 않은 advisory unlock은 error이고, row를 돌려주지 않는 효과 query도 error다. 정리 error가 없는 실패는 그대로 보고한다: code를 가진 apply error, history, lock, transaction statement의 database error, 또는 event handler의 error다. 정리 error가 있으면 client마다 자기 형식으로 모두 담는다:

- Go는 실패와 정리 error를 순서대로 `errors.Join`해 돌려준다. `errors.Is`와 `errors.As`가 그 각각을 찾는다.
- PHP는 previous throwable이 실패이고 `cleanup`이 정리 error를 순서대로 담은 `ApplyCleanupError`를 던진다.
- TypeScript는 `errors`가 실패와 그 뒤 정리 error를 순서대로 담은 `AggregateError`로 reject한다.
- Rust는 실패를 `error`로 가진 `ApplyError::Cleanup { error, cleanup }`을 돌려준다. 그 뒤의 정리 error는 앞의 결과를 다시 `error`로 감싼다. 아무것도 풀지 않은 unlock은 `ApplyError::LockNotHeld`다.

**Recovery.** `running` row를 남길 수 있는 것은 MySQL뿐이다. statement가 commit된 뒤 다음 statement 전에 connection이 끝난 경우다. recover는 row를 읽는다. `step`이 `k`이면 `k` 앞의 statement는 끝났고 statement `k`는 실행됐을 수 있다. plan의 MySQL statement는 각각 catalog가 보여 주는 효과 하나를 가진다: 있거나 없는 table, column, index, constraint, trigger이며, `MODIFY COLUMN`은 다시 실행해도 된다. recover는 statement `k`의 효과를 확인해 있으면 `k + 1`부터, 없으면 `k`부터 이어 가고, 검증한 뒤 row를 `done`으로 바꾼다. 실패한 statement는 index와 database error와 함께 보고하며, MySQL에서는 그 row가 `running`으로 남는다. `running` row가 없으면 recover는 아무것도 바꾸지 않고, chain 전체를 적용한 database에서 apply는 아무것도 바꾸지 않는다. 빈 chain의 apply는 history table을 만들고, table이 없는 database를 요구하며, event를 알리지 않는다.

## 검증

`make dbspec-go-check`는 `tests/dbspec/plans.json`의 case를 Go engine으로 실행한다. `make dbspec-plan-check`는 모든 case를 MySQL, PostgreSQL, SQLite에 적용한다. source를 렌더링하고, `before` step을 실행하고, statement를 적용하고, `after` step을 실행한 뒤, introspect한 schema text가 plan의 target과 같기를 요구한다. `make dbspec-apply-check`는 history, lock, drift, 검증, recovery와 함께 chain을 세 database에 적용한다. `make dbspec-ts-check`와 `make dbspec-plan-ts-check`는 TypeScript client의 `parsePlan`, `emitPlan`, `chainPlans`, `diffPlan`, `planStatements`로 같은 일을 한다. source를 렌더링하고, `before` step을 실행하고, statement를 적용하고, `after` step을 실행한 뒤, introspect한 schema text가 plan의 target과 같기를 요구한다. `make dbspec-apply-ts-check`는 `make dbspec-apply-check`의 chain을 TypeScript client의 `applyPlans`와 `recoverPlans`로 적용한다. 각 apply check는 PostgreSQL에서 event가 advisory lock을 먼저 푼 apply도 실행해, 아무것도 풀지 않은 unlock이 실패하기를 요구한다. 또 세 database에서 첫 apply가 lock을 잡은 동안 두 번째 database, schema 또는 file에 apply하며 이것은 `locked`가 아니어야 하고, 빈 chain을 event 없이 apply하고 recover하며 table이 있는 database에서는 `drift`이기를 요구한다. `tests/dbspec/plans.json`은 빈 chain을 chain case `empty`로 담는다. `make dbspec-go-check`, `make dbspec-php-check`, `make dbspec-ts-check`, `make dbspec-rust-check`는 감싼 SQLite connection과 script한 MySQL connection으로 실패를 주입하고, 각 client가 정리 error가 없는 실패는 그대로, 실패한 `ROLLBACK`, 실패한 `BEGIN IMMEDIATE` 뒤 실패한 foreign key 복원, row가 없는 효과 query의 error는 "Apply"의 형식으로 보고하기를 요구한다. `make dbspec-apply-pairs-check`는 `tests/dbspec/apply`의 Go, PHP, TypeScript, Rust client apply runner를 실행한다: MySQL, PostgreSQL, SQLite에서 서로 다른 두 client의 모든 순서쌍마다 첫 client가 chain의 첫 plan을, 둘째 client가 나머지를 적용하고, MySQL에서는 첫 client가 statement 뒤에 멈춘 plan을 둘째 client가 `interrupted`로 거부한 뒤 recover한다. 48 run 각각에서 history row와 introspect한 schema text가 chain의 것과 같아야 한다.

`make dbspec-rust-check`는 같은 case를 Rust client로 실행하고, `make dbspec-plan-rust-check`는 Rust renderer, plan statement, introspection으로 적용한다. `make dbspec-php-check`는 같은 case를 PHP client의 `Orm\Dbspec\Dbspec`(`parsePlan`, `emitPlan`, `chain`, `diff`, `planStatements`)으로 실행하고, `make dbspec-plan-php-check`는 이를 통해 세 database에 적용한다. `make dbspec-apply-php-check`는 `make dbspec-apply-check`의 scenario를 그 `apply`와 `recover`로 실행한다. 각 client의 plan test는 parse case도 실행하며, 그 diagnostic은 rule, 줄, 칸과 `plan` diagnostic의 message를 가진다. `comparisons` case도 실행하며, 그 차이나 message를 포함한 `compare` diagnostic은 나열된 것과 정확히 같아야 한다. `make dbspec-compare-check`는 `tests/dbspec/plans.json`의 모든 항목을 Go, PHP, TypeScript, Rust client로 각각 두 번 실행하고 모든 출력이 첫 Go 출력과 같기를 요구한다: 모든 case의 emit한 plan, change, dialect별 statement, 모든 invalid case와 parse case의 diagnostic, 모든 chain의 순서나 diagnostic, 모든 comparison의 차이나 diagnostic이며, `plan`, `chain`, `compare` diagnostic은 message까지 비교한다. `make dbspec-apply-rust-check`는 `make dbspec-apply-check`의 chain을 Rust client의 `orm::dbspec::apply`와 `orm::dbspec::recover`로 적용한다.
