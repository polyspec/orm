# dbspec

[English](dbspec.md)

dbspec은 이 저장소의 schema 언어다. dbspec 문서 하나는 database 또는 schema 하나의 table, ORM과 database에 동작을 주는 settings, table을 보여 주는 diagram을 정의한다. 같은 문서는 MySQL 8.4, PostgreSQL 17, SQLite 3.46 이상에 같은 의미로 렌더링되고, 셋 중 어느 것을 introspect해도 같은 문서가 복원된다.

dbspec이 지원하는 database 기능은 [schema definitions](dialects.md#schema-definitions) 기록이 정한다. 공통 정의가 하나 있고, 세 database에서 같은 의미로 렌더링되며, introspection이 숨은 marker 없이 같은 정의를 복원하는 기능만 지원한다. 그 밖의 것은 위치가 있는 error로 거부하며, 버리거나 비슷한 것으로 바꾸지 않는다.

## 문서

```text
dbspec 1 shop

use core { users }

table orders {
  id i64 identity
  user_id i64
  status varchar(32) default 'pending'
  total decimal(13,2)
  coupon_code varchar(32) null
  placed_at datetime(6) default now
  primary key (id)
  unique uq_orders_coupon (coupon_code)
  index ix_orders_user (user_id)
  index ix_orders_status (status, placed_at desc)
  foreign key fk_orders_user (user_id) references users (id) on delete restrict on update restrict
  check ck_orders_total (total >= 0)
  settings {
    updated placed_at
    select explicit coupon_code
  }
}

diagram main {
  orders at 120 340
  users at 520 340
}
```

문서는 byte order mark 없는 UTF-8 text다. 줄 끝은 LF 또는 CRLF이며 한 문서에 둘이 섞일 수 있고, 마지막 줄에는 줄 끝이 없어도 된다. 단독 CR은 `encoding` error다. parse는 text를 받는다. 파일을 읽는 도구는 UTF-8이 아닌 bytes를 parse 전에 `encoding` error로 보고한다. token 사이 구분은 공백 문자만 쓰며 tab은 `syntax` error다. 첫 줄은 header `dbspec 1 <document>`로, 언어 version과 문서 이름이다. 그 앞에는 빈 줄이나 comment 줄이 올 수 없다. header 뒤에는 빈 줄을 어디에나 둘 수 있다. 첫 공백 아닌 문자가 `#`인 줄은 comment다. comment는 의미를 바꾸지 않으며 canonical 출력은 그 자리를 유지한다([Canonical form](#canonical-form) 참조).

header 다음에는 `use` 줄, `table` block, `diagram` block이 이 순서로 온다.

## 이름

문서, table, column, index, key, foreign key, check, setting 대상, diagram의 모든 이름은 `[a-z][a-z0-9_]*`이고 63 bytes 이하다. 더 긴 이름은 error이며 줄이지 않는다. 대문자는 error이므로 모든 database의 대소문자 접기가 같은 이름을 준다.

`dbspec`, `use`, `table`, `diagram`, `primary`, `unique`, `index`, `foreign`, `check`, `settings`, `null`, `identity`, `default`, `true`, `false`, `and`, `or`, `not`, `in`, `between`, `is`는 예약어이며 어떤 이름에도 쓸 수 없다. 마지막 여섯 단어는 check predicate keyword다.

index, unique key, foreign key, check 이름은 네 종류 전체에서, 모든 table 이름과 비교해, 그리고 이 문서와, 이 문서가 직접 쓰는 문서의 모든 table과 constraint 전체에서 하나뿐이어야 한다. MySQL, PostgreSQL, SQLite가 이 이름들의 범위를 서로 다르게 정하고, PostgreSQL은 index와 table 이름을 한 namespace에 두기 때문이다. `primary`는 쓸 수 없는 이름이다. 이름은 physical 이름이다. renderer는 이름을 그대로 쓰고 prefix나 suffix를 붙이지 않는다. renderer는 자기 이름도 쓴다([rendered statements](dialects.md#rendered-statements)). `text`, `bytes`, identity column이 아닌 모든 column의 type CHECK에 `<table>$<column>`, `immutable`에 `<table>$immutable_update`와 `<table>$immutable_delete`, `audit`에 `<table>$audit_insert`, `<table>$audit_update`, `<table>$audit_delete`다. dbspec 이름에는 `$`가 없으므로 선언된 이름과 겹치지 않는다. 각각 최대 63 bytes이며, 더 길면 column 이름이나 setting keyword에서 `name.length` error다.

## 문서와 `use`

`use <document> { <table>, ... }`는 다른 문서의 table을 foreign key 대상으로 쓸 수 있게 한다. 다른 문서는 도구가 받는 선언된 문서 집합에서 그 이름과 같은 문서를 찾는다(설정 파일이나 명령 인자가 집합의 문서 파일을 나열한다). 문서는 파일 경로를 적지 않는다. 쓰는 table은 이 문서가 렌더링하지 않으며 diagram에는 배치할 수 있다. 쓰는 문서 자신도 자기 `use` 줄과 함께 parse하고 검증한다. 지정한 문서가 정의하지 않은 table, 집합에 없는 문서, 문서 자신, header 이름이 쓰는 이름과 다른 문서를 쓰거나 use가 순환하면 `use` error다. 실패한 쓰는 문서는 그 이름에서 `use` error 하나를 보고하고 message에 첫 error를 담는다. `use` 줄에서 반복한 문서나 table, 그리고 쓰는 table과 이름이 같은 table은 `name.duplicate` error다. `use` 줄은 문서 이름 순으로 정렬하고, 한 줄 안의 table은 적힌 순서를 유지한다.

## Table

`table <name> { ... }`은 column 줄, 그다음 서로 순서가 자유로운 key, index, foreign key, check 줄, 그리고 최대 하나의 `settings` block을 갖는다. constraint 줄 뒤의 column 줄, `settings` 뒤의 constraint 줄, 두 번째 `settings` block은 `order` error다. 문서가 닫지 않은 block은 그 `{`에서 `syntax` error다. table은 column이 하나 이상이고 primary key가 정확히 하나이며 column은 1000개 이하다.

### Column

`<name> <type> [null] [identity] [default <value>]`

- 줄에 `null`이 없으면 NOT NULL이다. primary key column은 `null`일 수 없다.
- `identity`는 그 column을 자동 key로 만든다. 유일한 primary key column이어야 하고 type은 `i64`다. insert가 값을 생략하면 database가 key를 만들고, client는 명시적 값을 거부한다. table당 identity column은 최대 하나다.
- 수식어 순서는 `null`, `identity`, `default`다. default가 없는 `null` column은 insert가 값을 생략하면 SQL NULL이 된다. `default null`은 `column` error다.
- `default <value>`는 column type의 literal이거나, `datetime(p)` column에서 UTC statement 시각을 쓰는 `now`다. `null`과 `default`는 `identity`와 함께 쓸 수 없다. `text`와 `bytes` column에는 default가 없다. scale보다 소수 자릿수가 많은 decimal default는 늘어난 자리가 0이어도 `column` error이며, 적은 자릿수는 canonical form에서 채운다.

### Type

| dbspec | 값 | MySQL | PostgreSQL | SQLite |
| --- | --- | --- | --- | --- |
| `i16` | −32768 ~ 32767 | `SMALLINT` | `smallint` | `smallint` + 범위 CHECK |
| `i32` | −2147483648 ~ 2147483647 | `INT` | `integer` | `integer` + 범위 CHECK |
| `i64` | signed 64-bit | `BIGINT` | `bigint` | `bigint` + type CHECK |
| `bool` | `true`, `false` | `tinyint(1)` + `(0,1)` CHECK | `boolean` | `BOOLEAN` + `(0,1)` CHECK |
| `decimal(p,s)` | 1 ≤ p ≤ 18, 0 ≤ s ≤ p | `DECIMAL(p,s)` | `numeric(p,s)` | `DECIMALINT(p,s)` + 범위 CHECK (값 × 10^s) |
| `f64` | 유한한 double | `DOUBLE` | `double precision` | `REAL` |
| `varchar(n)` | 1 ≤ n ≤ 16383 문자, U+0000 없음 | `varchar(n)` | `varchar(n)` | `varchar(n)` + 길이 CHECK |
| `text` | 길이 제한 없음, U+0000 없음 | `LONGTEXT` | `text` | `TEXT` |
| `bytes` | 길이 제한 없음 | `LONGBLOB` | `bytea` | `BLOB` |
| `uuid` | 소문자 canonical text | `char(36)` ascii_bin + pattern CHECK | `uuid` | `TEXT` + pattern CHECK |
| `date` | 0001-01-01 ~ 9999-12-31 | `DATE` | `date` | `DATE` + CHECK |
| `time(p)` | 24:00:00 미만의 하루 중 시각, 0 ≤ p ≤ 6 | `TIME(p)` + 하루 CHECK | `time(p)` + 하루 CHECK | `TIME` + CHECK |
| `datetime(p)` | local date-time, 0 ≤ p ≤ 6 | `DATETIME(p)` | `timestamp(p)` | `DATETIME` + CHECK |

모든 문자 column은 binary collation 하나를 쓴다: MySQL `utf8mb4_0900_bin`, PostgreSQL `COLLATE "C"`, SQLite `BINARY`. 모든 연결은 `datetime`을 UTC로 읽고 쓴다. SQLite table은 STRICT가 아니며, 모든 SQLite 연결은 `foreign_keys`를 켠다. 정확한 CHECK text는 renderer version에 속하며 [dialects](dialects.md#schema-definitions)에 있다.

지원하지 않음: 8-bit·24-bit 정수, unsigned type, `f32`, `char(n)`, `binary(n)`, `varbinary(n)`, native enum(`in` check가 있는 `varchar(n)`을 쓴다), native JSON(`ordered_json` codec이 있는 `text`를 쓴다), time zone instant, generated column, `now` 외의 식 default.

### Key와 index

- `primary key (<column>, ...)`: table마다 정확히 하나, 이름 없음.
- `unique <name> (<column>, ...)`: NULL은 서로 다르다.
- `index <name> (<column> [asc|desc], ...)`: 오름차순이 기본이며 canonical 형식에서는 쓰지 않는다.

key나 index는 자기 table의 서로 다른 column을 1~16개 나열한다. `text`나 `bytes` column은 포함할 수 없다. primary key, unique key, index 하나의 `varchar` column 선언 길이 합은 640 이하다. prefix, partial, expression, full-text index는 지원하지 않는다.

### Foreign key

`foreign key <name> (<column>, ...) references <table> (<column>, ...) [on delete <action>] [on update <action>]`

- `<action>`은 `restrict`, `cascade`, `set_null`이다. 생략한 action은 `restrict`이며 canonical 형식은 두 action을 모두 쓴다.
- 참조 column은 참조 table의 primary key나 unique key 하나의 column과 정확히 같고, 그 key의 column 순서를 따른다.
- 둘 다 쓸 때 `on delete`가 `on update`보다 먼저 온다.
- 자식 column type은 참조 column type과 같다.
- table은 앞쪽 column이 foreign key column인 index나 key를 선언한다.
- `set_null`은 모든 자식 column이 `null`이어야 한다.
- 대상은 이 문서의 table이나 쓰는 table이다. `NO ACTION`, `SET DEFAULT`, deferrable constraint, `MATCH FULL`은 지원하지 않는다.

### Check

`check <name> (<predicate>)`

predicate는 다음 중 하나다.

- `=`, `<>`, `<`, `<=`, `>`, `>=`를 쓰는 `<operand> <비교> <operand>`. operand 중 적어도 하나는 column이다
- `<column> [not] in (<literal>, ...)`
- `<column> is [not] null`
- `<predicate> and <predicate>`, `<predicate> or <predicate>`, `(<predicate>)`. `and`가 `or`보다 먼저 묶인다

operand는 같은 table의 column이나 literal이다. 세 database는 양쪽 값의 종류가 같을 때에만 이 predicate를 같게 평가하므로, type이 만날 수 있는 operand를 정한다. column과 만나는 literal은 그 column type의 유효한 `default` literal이어야 하고(`text` column은 `varchar` 형식), canonical form은 그 default처럼 쓴다. 그래서 `decimal(13,2)`에 대한 `0`은 `0.00`이다. 두 column은 다음일 때 만난다.

| Column type | 다른 column |
| --- | --- |
| `i16`, `i32`, `i64` | 다른 정수 column |
| `decimal(p,s)` | scale s가 같은 `decimal` column |
| `f64` | `f64` column |
| `bool` | `bool` column |
| `varchar(n)`, `text` | `varchar`나 `text` column |
| `uuid` | `uuid` column |
| `date` | `date` column |
| `time(p)` | p가 같은 `time` column |
| `datetime(p)` | p가 같은 `datetime` column |

`bool` operand에는 `=`, `<>`, `in`만 쓴다.

`bytes` column, 산술, 함수, `null` literal은 predicate에 쓸 수 없다. 정수 나눗셈, overflow, scale을 곱한 SQLite decimal이 세 database에서 다른 결과를 내기 때문이다. 단항 minus는 숫자 literal에만 쓴다. MySQL이 거부하므로(3823) `cascade`나 `set_null` foreign key의 column은 check에 쓸 수 없다.

`not` 연산자, `between`, `bool` column 하나는 없다. MySQL은 `not`을 그것이 부정하는 비교로 바꿔 쓰고 column 하나를 거부하며, PostgreSQL은 `between`을 비교 두 개로 쓰므로 introspection이 이를 복원할 수 없다([dialects](dialects.md#check-constraints)). `not (a > 3)` 대신 `a <= 3`, `a between 1 and 9` 대신 `a >= 1 and a <= 9`, `active` 대신 `active = true`를 쓴다.

## Settings

`settings { ... }`는 한 줄에 setting 하나를 둔다. setting은 자신이 적용되는 column의 이름을 적는다. column 이름이 동작을 고르는 일은 없다. `codec`은 column마다, `navigation`은 foreign key마다, `blind_index`는 AES column마다 한 번씩 반복하고, 나머지 setting은 최대 한 번 나오며 반복은 `setting` error다. 빈 `settings {}` block은 의미가 없으며 canonical form은 이를 쓰지 않는다. 그 안의 comment는 table 줄의 들여쓰기로 table의 닫는 `}` 앞으로 옮긴다.

codec stage는 쓸 때 적힌 순서로 실행한다. 저장 type은 마지막 stage를 따른다. `hex`, `base64`, `ordered_json`, `yaml`, `serialize`는 text를 만들므로 `varchar`나 `text` column이 필요하고, `aes`, `gz`, `ip`는 bytes를 만들므로 `bytes` column이 필요하다. `ordered_json`은 나올 때 첫 stage다. `aes_version`은 `aes`를 쓰는 column이 있으면 필요하고, 그런 column 없이 쓴 `aes_version`은 `setting` error다. `blind_index`의 index column은 n ≥ 64인 `varchar(n)`이고(`bytes` column은 index에 넣을 수 없다), AES column과 nullability가 같고, 자신은 AES로 encode되지 않으며, 선언된 index나 unique key의 유일한 column이다.

| Setting | 의미 | Hash |
| --- | --- | --- |
| `entity <name>` | 생성 코드가 table에 쓰는 model 이름. 없으면 model 이름은 table 이름이다 | manifest |
| `updated <column>` | executor가 자신이 계획하는 모든 `UPDATE`에서 `datetime` column에 UTC statement 시각을 넣는다. database에는 아무것도 렌더링하지 않는다. raw SQL은 기록되지 않는다 | manifest |
| `soft_delete <column>` | 읽기는 nullable `datetime` column이 null이 아닌 row를 제외한다. 삭제는 그 column에 UTC statement 시각을 넣는다 | manifest |
| `select explicit <column> ...` | column을 기본 select 집합에서 뺀다. 선택하지 않은 column을 읽으면 `COLUMN_UNSELECTED`로 실패한다 | manifest |
| `codec <column> <stage> ...` | 쓸 때 stage 순서로 encode하고 읽을 때 역순으로 decode한다: `ordered_json`, `aes`, `hex`, `gz`, `base64`, `serialize`, `yaml`, `ip` ([codecs](codec.md)) | manifest |
| `aes_version <column>` | row의 AES key version을 저장하는 non-null 정수 column. `aes`를 쓰는 column이 있으면 필요하다 | manifest |
| `blind_index <aes column> <index column>` | executor가 AES column 평문의 HMAC을 index column에 쓰고 같음 조건에 쓴다 | manifest |
| `navigation <foreign key> <child name> <parent name>` | 도구가 foreign key에 보여 주는 관계 이름(자식 쪽, 부모 쪽). 생성 코드는 match method로 join하며 이 이름을 읽지 않는다 | manifest |
| `immutable` | database가 생성된 row trigger로 table row의 `UPDATE`와 `DELETE`를 거부한다. `TRUNCATE`는 포함하지 않는다. `cascade`나 `set_null` foreign key의 자식 table에서는 거부된다 | schema |
| `audit into <history table> operation <column> action <history column> previous <history column>` | 생성된 row trigger가 모든 `INSERT`와 `UPDATE`를 이력 table에 복사한다. [Audit](#audit) 참조 | schema |

`schemaHash`는 table 정의와 schema로 표시한 settings를 포함하며, database를 바꿔야 할 때 정확히 바뀐다. `manifestHash`는 정의와 모든 settings를 포함하며 생성 코드가 확인한다. diagram과 comment는 어느 쪽에도 속하지 않는다. 두 hash는 [Manifest와 hash](#manifest-and-hashes)에서 정한다.

### Audit

감사 대상 table은 자기 operation column을 갖고, 이력 table은 그 row의 모든 version을 갖는다. trigger는 기록하는 모든 값을 자신이 받은 row, 곧 `OLD`와 `NEW`에서 읽는다. 그래서 세 database 모두 executor와 trigger 사이에 다른 전달 장치가 필요 없다.

```text
table service {
  id i64 identity
  name varchar(191)
  operation_id i64
  deleted_at datetime(6) null
  primary key (id)
  index ix_service_operation (operation_id)
  settings {
    soft_delete deleted_at
    audit into service_history operation operation_id action change previous previous_operation_id
  }
}

table service_history {
  history_id i64 identity
  change varchar(8)
  previous_operation_id i64 null
  id i64
  name varchar(191)
  operation_id i64
  deleted_at datetime(6) null
  primary key (history_id)
  index ix_service_history_row (id)
}
```

- **Operation column.** `operation <column>`은 감사 대상 table의 non-null `i64` 또는 `uuid` column의 이름이다. executor는 그 table의 모든 `INSERT`와 `UPDATE`에서 현재 operation의 id를 이 column에 쓴다. `NEW.<column>`은 변경하는 operation이고 `OLD.<column>`은 이전 version을 만든 operation이다.
- **이력 table.** `into <history table>`은 이 문서의 table이나 쓰는 table의 이름이다. 이력 table은 감사 대상과 다른 table이다. `i64 identity` primary key, `action` column(non-null `varchar(8)`), `previous` column(nullable, operation column의 type), 그리고 감사 대상 table의 모든 column마다 같은 이름과 type의 column을 하나씩 갖고, 다른 column은 없다. 이력 column은 nullable일 수 있다. 이력 table 자신은 감사하지 않는다.
- **Trigger.** `AFTER INSERT` row trigger는 `action = 'insert'`, `previous = NULL`과 모든 `NEW` 값을 쓴다. `AFTER UPDATE` row trigger는 `action = 'update'`, `previous = OLD.<operation column>`과 모든 `NEW` 값을 쓴다. `BEFORE DELETE` row trigger는 삭제를 거부한다. 값을 column 대 column으로 복사하므로 이력 row는 세 database에서 같다. row를 JSON으로 만들지 않는다.
- **삭제.** `BEFORE DELETE` trigger 때문에 physical `DELETE`는 실패한다. `soft_delete`를 선언한 table은 soft delete column의 `UPDATE`로 삭제하며, 이력이 그 operation과 함께 기록한다. `audit`은 `soft_delete`를 요구하지 않는다. schema setting은 database에서 다시 읽히고 manifest setting은 읽히지 않으므로, schema setting은 manifest setting에 의존하지 않는다.
- **한계.** `cascade`나 `set_null` foreign key의 자식 table에서는 이 setting을 거부한다. MySQL trigger는 foreign key action이 바꾼 row에서 실행되지 않기 때문이다. `TRUNCATE`는 포함하지 않는다. operation column을 쓰지 않는 raw SQL은 이전 operation의 id를 다시 기록한다. 이 column을 쓰는 것은 executor뿐이다. binary logging이 켜진 MySQL에서 trigger를 만들려면 `SUPER` 또는 `log_bin_trust_function_creators=ON`이 필요하며, apply가 이를 먼저 확인한다.

## Manifest와 hash {#manifest-and-hashes}

선언된 문서 집합이 유일한 schema 원천이다. generator, schema tool, schema 설치는 dbspec 문서를 읽으며, 다른 manifest 파일은 없다.

manifest와 [rendered statements](dialects.md#rendered-statements)는 한 집합의 parse된 문서를 받는다. 집합은 각 문서를 한 번씩, 그리고 그 문서들이 쓰는 모든 문서를 담는다. 반복된 문서 이름은 `name.duplicate` diagnostic, 집합에 없는 쓰이는 문서는 `use` diagnostic이며, 둘 다 뒤쪽 문서나 쓰는 문서의 header 이름(1줄 10열)에 위치하고 message에 문서 이름을 담는다. 문서는 이름 순으로, 한 문서가 쓰는 이름도 이름 순으로 확인한다. diagnostic이 있는 집합에는 manifest도 statement도 없다.

- 문서의 **manifest text**는 모든 comment와 diagram을 뺀 canonical emission이다. 문서 집합의 manifest text는 문서들의 manifest text를 문서 이름 순으로 이어 붙인 것이다. 각 text는 header로 시작하고 줄 끝으로 끝나므로 이어 붙인 결과는 모호하지 않다.
- **schema text**는 manifest text에서 `immutable`과 `audit`을 뺀 모든 setting을 지운 것이다. 비게 된 `settings` block은 canonical form처럼 쓰지 않는다.
- `manifestHash`는 `sha256:` 뒤에 manifest text의 UTF-8 bytes에 대한 SHA-256을 소문자 16진수로 붙인 것이고, `schemaHash`는 schema text에 대해 같은 방식으로 계산한다.

생성 코드는 자신을 만든 문서 집합의 manifest text와 `manifestHash`를 담고, 모든 request에 그 hash를 포함한다. runtime은 process가 시작할 때 한 번 내장된 text로 model을 만든다. PHP generator는 그 model을 PHP array로 쓰므로 opcode cache가 이를 유지하고, 어떤 request도 text를 parse하지 않는다. `schemaHash`는 migration plan과 그 이력이 기록하는 database 상태의 식별자다.

## Runtime model

client는 문서 집합으로 runtime model 하나를 만들고, 생성 코드도 같은 model에서 만든다.

- **Entity.** 집합의 모든 문서의 table마다 entity 하나다. 문서는 이름 순, table은 문서 순서다. entity 이름은 `entity` setting이나 table 이름이다. 생성 type 이름은 snake_case 조각의 첫 글자를 대문자로 쓴 것이다(`service_member` → `ServiceMember`).
- **Field.** column마다 field 하나이며 이름은 column 이름, 순서는 column 순서, 값 type은 아래 표를 따른다. `null` column은 언어의 없음 값을 쓴다: Go는 pointer(`[]byte`와 styled 값은 감싸지 않음), PHP는 `?T`, TypeScript는 `T | null`, Rust는 `Option<T>`.
- **Key.** primary key column이 row를 식별한다. identity column은 insert가 쓰지 않으며 생성된 key를 돌려준다. upsert는 호출이 지정한 primary key나 unique key에서 충돌한다.
- **기본 select 집합.** `select explicit`에 없는 모든 column이다. 선택하지 않은 column을 읽으면 `COLUMN_UNSELECTED`로 실패한다. type이나 codec이 스스로 column을 빼지는 않는다.
- **Default.** default가 있는 column을 생략한 insert는 database default를 받으며 executor는 채우지 않는다. default 없는 non-null column을 생략한 insert는 database에 닿기 전에 `IR_INVALID`로 실패한다.
- **Codec.** `codec` setting이 있는 column은 첫 stage가 encode하는 값을 담는다. stage 중 `ordered_json`, `serialize`, `yaml`, `gz`, `base64`가 있으면 공통 값 model([codecs](codec.md))의 styled 값이며 SQL NULL과 저장된 null을 구분한다. 모든 stage가 `aes`, `hex`, `ip`이면 문자열이다(`ip`는 주소 text).
- **Setting.** `updated`는 executor가 계획하는 모든 `UPDATE`에서 UTC statement 시각을 받는다. `soft_delete`는 읽기를 거르고 delete를 update로 바꾼다. `aes_version`은 row의 key version을 저장한다. `blind_index`는 HMAC column을 쓰고 AES column에 대한 같음 조건을 바꾼다. `audit`에서는 호출한 code가 작업 단위의 operation id를 주고, executor는 자신이 insert하거나 update하는 모든 감사 row의 operation column에 그것을 쓴다. operation id 없는 감사 table의 insert나 update는 `CONFIG`로 실패한다. `immutable`은 runtime 동작이 없다: database가 변경을 거부한다. `navigation`도 runtime 동작이 없다.
- **Relation.** 생성 코드는 이전처럼 column의 match method로 두 entity를 join한다. join 결과는 호출이 준 alias나 `<entity>_model`, `<entity>_models`로 얻는다.
- **Connection.** connection은 DSN URI와 설정을 받으며 schema 경로는 받지 않는다. 생성 코드는 manifest text와 `manifestHash`를 담고 첫 connection 전에 model을 등록한다. request는 `manifestHash`를 담는다.

| dbspec | Go | PHP | TypeScript | Rust |
| --- | --- | --- | --- | --- |
| `i16` | `int16` | `int` | `number` | `i16` |
| `i32` | `int32` | `int` | `number` | `i32` |
| `i64` | `int64` | `int` | `number`(safe integer) | `i64` |
| `bool` | `bool` | `bool` | `boolean` | `bool` |
| `decimal(p,s)` | 소수 자릿수가 정확히 s인 `string` | `string` | `string` | `String` |
| `f64` | `float64` | `float` | `number` | `f64` |
| `varchar(n)`, `text`, `uuid` | `string` | `string` | `string` | `String` |
| `bytes` | `[]byte` | `string` | `Uint8Array` | `Vec<u8>` |
| `date` | `time.Time` | `\DateTimeImmutable` | `string` `YYYY-MM-DD` | `NaiveDate` |
| `time(p)` | 소수 자릿수가 p인 `string` `HH:MM:SS` | `string` | `string` | `String` |
| `datetime(p)` | UTC의 `time.Time` | UTC의 `\DateTimeImmutable` | 소수 자릿수가 p인 `string` `YYYY-MM-DD HH:MM:SS` | `NaiveDateTime` |

Mermaid manifest field는 이 model에 다음처럼 대응한다: `auto`는 identity column, `lazy`는 `select explicit`, `styles`는 codec stage이며 `json`과 `jsons`는 둘 다 `ordered_json`이다. `timestamps.updated`는 `updated`이고 `timestamps.created`는 `default now` column이다. `relations`와 `ref`는 foreign key다. `unique`, `indexes`, `pk`, `nullable`, `default`, `precision`, `scale`은 뜻이 같다. `fulltext`, `unsigned`, `enum`, `point`, `inet`, `on_update`, `uk`, `raw`, `len`은 runtime 대응이 없으므로 fulltext 조건과 point 값은 client에서 사라진다.

## Diagram

`diagram <name> { <table> at <x> <y> ... }`는 view를 위해 table을 배치한다. 좌표는 diagram 단위의 −2147483648 ~ 2147483647 정수다. table은 diagram에 최대 한 번 나오며, diagram은 table을 빼놓을 수 있다. diagram은 어떤 hash도, 어떤 렌더링도 바꾸지 않는다. 문서는 diagram을 여러 개 가질 수 있다.

## Canonical form

출력은 parse한 문서를 하나의 canonical text로 쓴다. 그래서 canonical 입력에 대해 `emit(parse(s)) == s`이고, 모든 유효한 입력에 대해 `emit(parse(emit(d))) == emit(d)`다.

- 두 칸 들여쓰기, token 사이 공백 하나, LF 줄 끝, 마지막 줄바꿈 하나
- header, 빈 줄, 문서 이름 순으로 정렬한 `use` 줄, 각 block 앞의 빈 줄
- table 안: 선언 순서의 column, `primary key`, 그다음 이름 순으로 정렬한 `unique`, `index`, `foreign key`, `check` 줄, 그다음 위 표 순서의 `settings` 줄(`codec`, `blind_index`, `navigation` 줄은 column이나 key 이름 순)
- default와 action은 모두 쓰고(`on delete restrict on update restrict`), `asc`는 생략
- literal은 한 형식으로 쓴다: 정수는 0의 부호나 앞자리 0 없이, decimal은 column scale만큼의 소수 자리로(`decimal(13,2)`이면 `0.00`), 문자열은 작은따옴표 안에 따옴표를 `''`로, `true`와 `false`, `date`는 `'YYYY-MM-DD'`, `time(p)`와 `datetime(p)`는 정확히 p자리 소수로(`datetime(6)`이면 `'2026-01-01 00:00:00.000000'`), `uuid`는 소문자로
- table과 diagram은 문서 순서, diagram 줄도 문서 순서
- `select explicit` column과 `use` 줄 안의 table은 적힌 순서로
- `f64` literal은 다시 읽으면 같은 값이 되는 가장 짧은 지수 없는 10진수로 쓰고, 정수 값이면 소수점 없이, 음의 0은 `0`으로 쓴다. check literal은 만나는 column의 canonical default 형식을 따르고, predicate는 `and` 안의 `or`가 필요로 하는 괄호만 남긴다
- comment 줄은 바로 다음 줄에 붙고 그 줄의 들여쓰기를 따른다. 닫는 `}` 앞의 comment는 그 block 안 줄의 들여쓰기를 따른다. 마지막 block 뒤의 comment는 빈 줄 하나 뒤에 온다. comment는 `#`부터 줄 끝까지의 text를 바꾸지 않는다

## 한도와 error

문서는 최대 32 MiB, table 4096개, column 120000개, foreign key 20000개이며, 할당 전에 확인한다. error는 `SCHEMA_INVALID`이고, 문제 token의 1부터 세는 줄과 열, 아래 규칙, message를 갖는다. 열의 단위는 Unicode code point다. 멈추게 하는 error(`encoding`, `header`, `limit`)는 그 전에 찾은 diagnostic 뒤에 보고한다. diagnostic은 줄, 열, 아래 규칙 표의 순서로 정렬한다. 이름 규칙에 맞지 않는 header 이름은 `name.format`이며 parse는 계속한다. table, constraint, setting 전체에 대한 규칙의 위치는 그 이름이나 keyword token이고, 다른 규칙의 위치는 규칙을 어긴 token이다.

- foreign key: index, `set_null`, type, column 수, 참조 key 규칙은 constraint 이름, 모르는 column이나 대상은 그 token
- key: 16 column과 640자 한도는 key 이름이나 `primary`
- setting: setting 전체와 함께 필요한 setting 규칙은 setting keyword, column type 규칙은 그 column, 이력 table 형태는 이력 table 이름
- column이 없는 table은 table 이름에서 `column`과 `key`를 보고한다. `null identity`는 `identity`에서 `column`을, primary key에서 `key`를 보고한다
- 실패한 쓰는 문서는 그 이름에서 `use` diagnostic 하나를 보고하고 message에 첫 error를 담는다. 두 쓰는 문서가 constraint 이름을 반복하면 뒤 문서 이름에서 `name.duplicate`를 보고한다. `use` 줄에서 문서나 table을 반복하면 `name.duplicate`다. use 순환이나 쓰는 이름과 다른 header 이름은 `use`다
- `header` error의 위치는 줄이 `dbspec 1 <name>`에서 처음 벗어나는 문자이고(`<name>`은 ASCII 문자, 숫자, `_`의 연속), 빠진 부분이 있으면 줄 끝 다음 열이다
- 32 MiB 한도의 위치는 1줄 1열이다. column이 1000개를 넘는 table은 1001번째 column 이름에서 `limit` error다
- check: predicate는 먼저 읽는다. 읽기는 산술 연산자, 함수, `null` literal 같은 predicate 형식 밖의 token과, 형식이 column을 요구하는 자리의 literal(`in`, `is`의 대상, 두 literal 비교의 첫 literal), 그리고 비교, `in`, `is`가 뒤따르지 않는 operand를 보고한다. 그 operand 뒤에 `and`, `or`, `)`, 끝이 오면 operand에서, 그 밖에는 뒤따르는 token에서 보고한다. 읽기 diagnostic이 있는 predicate는 더 확인하지 않는다. 끝까지 읽힌 predicate는 column과 type을 확인하고, 그중 source 순서의 첫 diagnostic을 보고한다. 모르는 column, `cascade`나 `set_null` foreign key의 column, `bytes` column은 그 column, 비교에서 상대 column과 만나지 않는 column은 뒤쪽 column, 만나는 column의 default가 아닌 literal은 그 literal, `bool` operand(column이나 `true`, `false`)에 쓴 `<`, `<=`, `>`, `>=`는 그 연산자가 위치다
- 한 줄의 `syntax` diagnostic은 최대 하나다. check 식은 첫 diagnostic만 보고한다. 참조 안의 잘못된 이름은 `name.format`을 보고하고 더 해석하지 않는다. 자기 줄이 실패한 column이나 table에 대한 참조는 더 보고하지 않는다. 실패한 줄은 첫 단어가 정하는 종류와 선언하려던 이름을 유지하며, 이를 알기 위해서만 tab을 공백으로 읽는다. 그래서 실패한 key나 index 줄도 column을 모르는 key나 index를 선언한 것으로 보므로, 그 column에 기대는 규칙은 보고하지 않는다. 실패한 `primary key` 줄은 그 table의 primary key 없음과 identity 규칙을 가리고, 실패한 `primary key`, `unique`, `index` 줄은 그 table foreign key의 선두 index 규칙과 그 table을 참조하는 foreign key의 참조 key 규칙을 가린다
- 첫 줄이 아닌 header(앞에 comment나 빈 줄이 있는 경우 포함), 그리고 정확히 `dbspec`, 공백, `1`, 공백, 이름이 아닌 header 줄(예: tab이 있는 줄)은 `header` error다 parse는 첫 error만이 아니라 문서의 모든 error를 원문 순서로 보고한다. `encoding`, `header`, `limit` error는 parse를 멈춘다.

| 규칙 | 의미 |
| --- | --- |
| `header` | 첫 줄이 `dbspec 1 <document>`가 아니거나 version이 1이 아니다 |
| `syntax` | token이 그 위치에 올 수 없다 |
| `order` | `use`, `table`, `diagram`의 순서나 table 안 줄의 순서가 틀렸다 |
| `name.format` | 이름이 `[a-z][a-z0-9_]*`가 아니거나 `primary`다 |
| `name.length` | 이름이 63 bytes보다 길다 |
| `name.duplicate` | table, column, constraint, index, diagram 이름이 범위 안에서 겹친다 |
| `type` | type을 모르거나 parameter가 범위를 벗어난다 |
| `column` | column의 `null`, `identity`, `default` 조합이 규칙에 어긋나거나 default가 type에 맞지 않는다 |
| `key` | primary key가 없거나 둘 이상이거나, key column이 nullable이거나, key나 index가 모르는·반복된·`text`·`bytes` column, 16개 넘는 column, 640자 넘는 `varchar`를 나열한다 |
| `foreign_key` | foreign key의 대상, column type, index, column 수, `set_null` nullability가 규칙에 어긋난다 |
| `check` | check predicate가 predicate 형식 밖의 것, 모르는 column, type이 만나지 않는 operand, column type 밖의 literal, `cascade`나 `set_null` foreign key의 column을 쓴다 |
| `setting` | setting을 모르거나, 반복되거나, 모르는 column을 가리키거나, column type이나 함께 필요한 setting이 틀렸다 |
| `use` | 쓰는 문서가 선언된 집합에 없거나 쓰는 table이 거기 정의되지 않았다 |
| `diagram` | diagram이 모르는 table을 가리키거나, table을 반복하거나, 좌표가 정수가 아니다 |
| `limit` | 문서가 크기나 개수 한도를 넘는다 |
| `encoding` | text가 유효한 UTF-8이 아니거나, byte order mark가 있거나, 단독 CR이 있다 |

## Mermaid 언어에서 바뀐 이름

| Mermaid 언어 | dbspec | 이유 |
| --- | --- | --- |
| `auto` | `identity` | 생성되는 key의 SQL 용어 |
| `lazy` | `select explicit` | column을 기본 select에서 뺄 뿐이며 접근할 때 load하지 않는다 |
| `?` / `=v` / `=now` | `null` / `default v` / `default now` | 의미를 말하는 keyword |
| `onupdate` | `settings { updated <column> }` | database 절이 아니라 executor setting |
| `jsontext` | `text` + `codec <column> ordered_json` | ordered JSON은 codec이고 database는 text를 저장한다 |
| 이름 규칙(`is_*`, `created_ts`, `aes_hex_*`, `ip`, `_seq`) | settings | column 이름은 동작을 고르지 않는다 |
| `rename_table`, `rename_column` | migration plan | rename은 상태가 아니라 변경이다 |
| `orm:route`, `orm:permission` 등 API directive | 제거 | schema의 관심사가 아니다 |
| `schema_hash` | `schemaHash`, `manifestHash` | 두 가지 다른 범위 |
| `ormgen`, `orm-gen` | 모든 언어에서 CLI 이름 하나 | 도구 하나, 이름 하나 |

## 유지, 이동, 제거

Mermaid 언어와 manifest의 모든 기능:

| 기능 | 판정 |
| --- | --- |
| entity, column, PK, FK constraint로서의 relation | table, column, primary key, 이름 있는 foreign key로 유지 |
| type 어휘(`tinyint`, `int`, `bigint`, `varchar`, `decimal`, `datetime`, `uuid`, `jsontext`, `enum`, `point`, `unsigned`) | dbspec type으로 교체. `tinyint`, `unsigned`, `enum`, `point`, native JSON은 제거 |
| `unique`, `index` directive | 이름 있는 줄로 유지. 생성 이름은 제거 |
| `fulltext` | 제거(neutral 형식 없음) |
| MySQL 재작성과 prefix가 있는 `check` | neutral 식 집합으로 유지. 재작성과 prefix는 제거 |
| `timestamps`와 이름 규칙 | `default now`와 `updated` setting으로 교체 |
| `soft_delete`, `aes_version`, `blind_index`, style | settings로 유지 |
| `lazy`, 관계 이름 | `select explicit`과 `navigation` settings로 유지 |
| `table_comment`, `column_comment` | physical 객체로서는 제거. `#` comment는 문서에 남는다 |
| `rename_*` | migration plan으로 이동 |
| `orm:table` schema 한정 이름 | 제거(문서 하나는 database나 schema 하나) |
| `orm:foreign` | `use`와 쓰는 table로의 foreign key로 교체 |
| `orm:immutable` | row trigger를 쓰는 `immutable` setting으로 유지 |
| `orm:audit`, `orm:audit_log` | 이력 table을 쓰는 `audit` setting으로 교체. operation·change table, context setting, JSON row 값은 제거 |
| `orm:field`, `route`, `scope`, `filter`, `operation`, `permission` 등 전달용 directive | 제거 |
| `-- orm:` trigger marker와 `-- orm-schema-v1` SQL source | 제거. 복원은 renderer 출력과 비교한다 |
| dialect SQL text가 있는 PhysicalGraph record(`typeSql`, `predicateSql`, `expressionSql`, `collationSql`, `operatorClassSql`)와 주석 달린 Markdown 문서 | 제거. dbspec model이 대신한다 |

## 검증

공유 vector는 `tests/dbspec/`에 있다: canonical 문서와 그 출력, canonical이 아닌 문서와 그 canonical 출력, 그리고 기대하는 모든 diagnostic이 있는 잘못된 문서. 모든 client가 같게 parse하고 출력한다. 2000-table, 60000-column, 10000-foreign-key case의 parse budget은 Rust client release mode에서 300 ms다. Go client budget은 100 ms, TypeScript client는 Node에서 250 ms, PHP client는 128 MiB memory limit 안에서 400 ms다. 각 client의 stress test는 case를 다섯 번 parse해 가장 짧은 시간, median, 가장 긴 시간을 출력하고 median이 budget을 넘으면 실패한다. 그래서 느린 parser는 실패하고, machine의 다른 부하로 느려진 parse 한 번은 결과를 정하지 않는다. budget은 각 구현의 첫 측정에서 정했으며 올리지 않는다.
