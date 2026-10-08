<!-- doc-id: tests-dialects-readme -->
<!-- source-sha256: 22afc5e0ea8b6eb6a5dcde71bda545e207e6d83c9d423a84f3a3719ca308ffc6 -->
# 스키마 dialect 사실 probe

[English](README.md)

이 probe는 MySQL, PostgreSQL, SQLite가 스키마 객체를 정의하고 적용하는
방식을 기록한다. `docs/dialects.md`의 schema definition 표는 각 probe ID를
인용한다. 중립 dbspec 기능은 probe가 세 데이터베이스에서 같은 의미와 그
정의를 복원하는 catalog 출처를 보여 줄 때만 지원한다.

## Probe

Probe는 안정적인 ID `<database>.<topic>.<fact>`, 확인하는 사실, DDL·DML·
catalog 질의로 된 본문을 가진다. 성공해야 하는 단계, 지정한 MySQL 오류
번호·PostgreSQL SQLSTATE·SQLite 메시지로 실패해야 하는 문장, 지정한
텍스트와 같아야 하는 질의 결과만 확인한다. 다른 값을 관찰한 probe는
실패한다. Probe를 고칠 때는 관찰한 사실을 기록하며 기준을 약하게 만들지
않는다.

각 probe는 자기 전용의 일회용 객체에서 실행한다.

| Database | 객체 | 정리 |
|---|---|---|
| MySQL | database `dfx_<pid>_<index>`, 필요하면 `<database>_b`, probe가 필요로 하면 같은 이름의 login | `DROP USER IF EXISTS`, `DROP DATABASE` 후 `information_schema.SCHEMATA`에 없어야 한다 |
| PostgreSQL | schema `dfx_<pid>_<index>`, 필요하면 `<schema>_b` | `DROP SCHEMA … CASCADE` 후 `pg_namespace`에 없어야 한다 |
| SQLite | 테스트 임시 디렉터리의 파일 `dfx_<pid>_<index>.sqlite`, 필요하면 `dfx_<pid>_<index>_b.sqlite` | 파일과 journal 파일을 삭제하며 남아 있으면 안 된다 |

## 실행

```sh
make dialect-facts-check TEST_ENV=<path of the environment file of make test-servers>
```

Target은 먼저 데이터베이스 없이 probe ID를 검사하고, `TEST_ENV`의
`ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`으로 `TestDialectFacts`(build
tag `physical`)를 실행한다. SQLite는 서버가 필요 없다. Go probe 연결은
`modernc.org/sqlite`를 사용하며 `sqlite.env.library`가 링크한 library
version을 기록한다.

`TestSQLiteFileNameWithQuery`는 probe와 함께 실행하며 DSN query를 파일
이름에 남기는 SQLite opener를 기록한다. Go `modernc.org/sqlite`, PHP PDO,
`node:sqlite`, `sqlite3` shell로
`<dir>/bench.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00`을 열고
자기 임시 디렉터리에 생긴 파일 이름을 확인한다.

각 probe는 `internal/testcase`의 case다. 실행 중에 `RUN <probe>
deadline=1m0s`, 시작과 각 `observed` 값의 `STEP` 줄, `PASS <probe>
elapsed=<elapsed>` 또는 `FAIL <probe> elapsed=<elapsed>: <reason>`을
출력한다. 각 probe는 자기 30초 deadline을 가지며 정리 단계도 별도 30초를
가지고, 둘을 더한 것이 case deadline이므로 go test binary는 `-timeout 0`으로
실행한다. 연결할 수 없는 서버의 probe는 각각
연결 오류로 실패한다. 다른 데이터베이스는 계속 실행하며 summary 줄에
데이터베이스별 통과·실패 수를 기록한다.

## 언어

Probe는 공통 `tests/`의 Go test다. 적합성 검사기(`tests/conformance/check`)
도 같은 방식이다. 이 사실은
클라이언트가 아니라 데이터베이스의 성질이므로 실행기 하나가 한 번
기록한다. 모듈은 이미 MySQL(`go-sql-driver/mysql`), PostgreSQL(`pgx`),
SQLite(`modernc.org/sqlite`) driver를 링크하며 Go 오류 타입은 확인에 쓰는
MySQL 오류 번호와 PostgreSQL SQLSTATE를 제공한다. SQLite library는
클라이언트마다 다르며 버전은 `docs/dialects.md`에 기록한다.
