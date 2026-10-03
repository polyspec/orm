# 스키마

스키마 source는 dbspec document(`.dbs`)의 집합이다. [dbspec.md](dbspec.md)가 언어, 검증 규칙, manifest text와 두 hash를 정의한다. `schema/bench.dbs`는 테스트와 벤치마크의 스키마다. 다른 스키마 파일은 없으며 모든 generator, runtime, 스키마 작업이 document set을 읽는다.

## 1. 모델 생성 {#_1-model-generation}

각 언어는 자기 도구로 document set에서 모델을 생성한다([사용법](usage.md#_3-code-generation)).

| 언어 | 도구 |
|---|---|
| Go | `orm-gen gen --document <file.dbs>... --lang go --out <directory> --scan <package pattern>...` |
| PHP | `vendor/bin/orm-gen gen --out <directory> --namespace <namespace> <files.dbs...>` |
| TypeScript | `@polyspec/orm-typescript`의 `orm-gen gen --schema <file.dbs> --out <directory> --scan <path>` |
| Rust | `build.rs`의 `orm_build::Builder::new([<files.dbs>]).scan("src").generate()` |

각 도구는 모든 문서 파일을 자기 client의 file reader로 읽는다. reader는 dbspec signature로 시작하지 않는 파일을 parse 전에 `signature` error로 거부하며([파일](dbspec.md#files)), 그러면 도구는 `SCHEMA_INVALID`로 실패하고 모델을 쓰지 않는다.

`github.com/polyspec/orm/generator` 패키지는 다른 프로그램에 Go 생성을 제공한다. `generator.Generate`는 document set의 runtime model, 출력 디렉터리, `PackageName`(기본값은 디렉터리 이름), 호출을 생성할 패키지 패턴인 `Scan`을 받는다. 이름 규칙, 필드 대응, 출력은 ORM generator가 책임진다.

## 2. 스키마 작업 {#_2-schema-operations}

스키마 작업은 각 클라이언트 라이브러리의 함수다. 함수는 parse한 document와 dialect(`mysql`, `postgres`, `sqlite`)를 받아 statement나 위치가 있는 diagnostic을 돌려준다.

| 작업 | Go `engine/dbspec` | PHP `Orm\Dbspec\Dbspec` | TypeScript | Rust |
|---|---|---|---|---|
| document set의 statement 렌더링([방언](dialects.md#rendered-statements)) | `Render` | `render` | `renderDbspec` | `orm_schema::dbspec::render` |
| 데이터베이스를 document로 introspect([방언](dialects.md#introspection)) | `Introspect` | `introspect` | `introspectDbspec` | `orm::dbspec::introspect` |
| plan과 source의 diff([plans](plans.md)) | `Diff` | `diff` | `diffPlan` | `orm_schema::dbspec::diff` |
| plan의 step과 rollback statement 작성([plans](plans.md#steps)) | `PlanSteps` | `planSteps` | `planSteps` | `orm_schema::dbspec::plan_steps` |
| plan chain 적용([plans](plans.md#apply)) | `Apply` | `apply` | `applyPlans` | `orm::dbspec::apply` |
| 중단된 plan 이어 가기([plans](plans.md#apply)) | `Recover` | `recover` | `recoverPlans` | `orm::dbspec::recover` |
| 마지막 plan rollback([plans](plans.md#apply)) | `Rollback` | `rollback` | `rollbackPlans` | `orm::dbspec::rollback` |
| 적용한 plan finalize([plans](plans.md#apply)) | `Finalize` | `finalize` | `finalizePlans` | `orm::dbspec::finalize` |

[mermaid.md](mermaid.md)는 document를 Mermaid `erDiagram`으로 내보내는 방법과 diagram을 document로 가져오는 방법을 정한다.

## 3. Rust 카탈로그 연결 {#_3-rust-catalog-connections}

도구 셀 디코딩은 실제 SQL NULL과 지원되는 정수·텍스트·boolean(그리드 셀은 decimal, binary, date, time, datetime도. [인터페이스](interfaces.md) 참고)을 보존하되 미지원 타입·잘못된 UTF-8·signed 64비트 범위를 넘는 unsigned 정수를 거부한다. SQL NULL·대체 문자열·순환한 정수로 대체하지 않는다. 이 검증이 카탈로그 도구를 범용 쿼리 결과 디코더로 만드는 것은 아니다.

도구 `Val::int()`, `opt_int()`, `bool()`은 검증된 결과를 반환한다. 필수 정수·boolean 변환은 SQL NULL을 거부하며 선택적 정수는 NULL을 `None`으로 보존한다. Boolean은 실제 boolean, 정수 0/1, 문자열 `t`, `f`, `true`, `false`, `1`, `0`만 허용하며 잘못된 값을 기본값으로 바꾸지 않는다. 오류는 입력값을 포함하지 않으며 트랜잭션 정리를 포함한 카탈로그 작업에 전달된다.

`live-db` 기능은 `orm_build::catalog::CatalogConnection::connect(dsn)`을 노출한다. 별도 driver 인자 없이 DSN이 DB를 선택한다. 카탈로그 연결은 SQLite 외래키 설정을 보존한다. 카탈로그 연결은 테이블 메타데이터와 페이지를 읽고 행을 바꾼다. 데이터베이스의 스키마는 `orm::dbspec::introspect`가 읽는다.

SQLite 카탈로그 연결은 기존 일반 DB 파일을 요구하고 파일 자동 생성을 끈다. `close(self)`는 예약 연결을 해제한 뒤 풀을 닫는다. 임의 SQL/데이터 접근을 활성화하기 전에 네이티브 디코딩 한계를 소유 코드에서 수정해야 한다.

## 4. 스키마 설치 {#_4-schema-installation}

`connection.utils().schema().install(schema)`는 generated schema 값의 document set을 연결의 dialect로 렌더링하고 trigger를 포함한 statement를 적용한 뒤 그 set을 연결에 등록한다([protocol](protocol.md)). manifest text가 선언한 `manifestHash`로 hash되지 않으면 어떤 statement보다 먼저 `CONFIG`로 실패한다. 집합의 테이블이 하나도 없으면 모든 테이블을 만들고, 모두 있으면 아무것도 바꾸지 않으며, 일부만 있으면 `CONFIG`로 실패한다. diagnostic이 있는 집합은 `SCHEMA_INVALID`로 실패한다. PostgreSQL과 SQLite는 연결의 진행 중인 트랜잭션이나 새 트랜잭션에서 statement를 적용한다. MySQL은 스키마 statement마다 암묵적으로 커밋하므로 트랜잭션 밖에서 적용하며, 트랜잭션 안에서 호출하면 `CONFIG`를 반환한다.

| 언어 | 호출 | 입력 |
|---|---|---|
| Go | `Utils().Schema().Install(model.Schema)` | 생성된 package의 schema 값(`*orm.Schema`) |
| PHP | `utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema())` | 생성된 모델의 schema 값(`Orm\Schema`) |
| TypeScript | `utils().schema().install(SCHEMA)` | 생성된 module의 schema 값(`{ manifestText, manifestHash }`) |
| Rust | `utils().schema().install(&model::SCHEMA).await` | 생성된 모델의 schema 값(`orm::Schema`) |

## 5. 테이블과 컬럼 추가

`connection.utils().schema().addTablesAndColumns(schema)`는 설치한 document set을 더하기만 하는 새 version으로 올린다: 데이터베이스에 없는 set의 테이블을 모두 만들고, 기존 테이블에 빠진 컬럼을, 각 컬럼이 `null`이거나 default가 있을 때 추가한다. 만든 테이블은 `table`, 추가한 컬럼은 `table.column`으로, 테이블 이름 순, 그다음 컬럼 순서로 반환한다. 연결의 데이터베이스를 introspect하고([dialects](dialects.md#introspection)) 있는 set의 테이블을 schema text의 [비교](plans.md#comparison)로 set과 비교한다. set 밖의 모든 테이블은 비교하지도 바꾸지도 않으므로 한 데이터베이스가 여러 set의 테이블을 담을 수 있다. 모든 차이가 `create_table`이거나 그런 컬럼의 `add_column`이면 그 테이블들에서 set까지의 plan 하나의 [step](plans.md#steps)을 실행한다: 만드는 테이블은 index, foreign key, check, `immutable`과 `audit` 트리거와 함께 만들고, 추가하는 컬럼은 MySQL과 PostgreSQL에서 컬럼의 renderer CHECK와 함께 `ADD COLUMN`, SQLite에서 테이블 다시 만들기이며, audit 테이블은 트리거를 바꾸므로 새 트리거가 새 컬럼을 이력 테이블에 복사한다. 다시 부르면 아무것도 추가하지 않고 빈 목록을 반환한다. plan 이력을 기록하지 않고 set을 등록하지 않는다. set은 generated code의 connect helper가 등록한다.

다른 모든 차이는 version이 테이블을 더할 때에도 어떤 statement보다 먼저 `SCHEMA_DIFFERS`를 반환하며, 각 차이를 `<kind> <table>[.<name>]`로 적는다: default 없는 non-null 빠진 컬럼, set이 선언하지 않은 컬럼, 바뀐 type, `null`, default, identity, 기존 컬럼 앞의 빠진 컬럼(PostgreSQL은 컬럼을 끝에 붙이므로 `reorder_columns`), 기존 테이블의 바뀐 primary key, unique key, index, foreign key, check, setting, 그리고 introspection이 읽지 못하는 set 테이블의 객체다. manifest text가 선언한 `manifestHash`로 hash되지 않으면 먼저 `CONFIG`, diagnostic이 있는 set은 `SCHEMA_INVALID`로 실패한다. PostgreSQL은 연결의 진행 중인 트랜잭션이나 새 트랜잭션에서 step을 적용한다. MySQL은 schema statement마다 암묵적으로 commit하고, SQLite는 트랜잭션 안에서 바꿀 수 없는 foreign key를 끈 채 테이블을 다시 만들므로, 둘 다 트랜잭션 밖에서 적용하고 안에서는 `CONFIG`를 반환한다. SQLite는 연결 하나에서 `BEGIN IMMEDIATE` 트랜잭션 하나로 실행하고, commit 전에 `PRAGMA foreign_key_check`가 row를 돌려주지 않아야 하며, foreign key를 다시 켠다.

| 언어 | 호출 | Step |
|---|---|---|
| Go | `Utils().Schema().AddTablesAndColumns(model.Schema)` | `dbspec.AddTablesAndColumnsSteps` |
| PHP | `utils()->schema()->addTablesAndColumns(\Polyspec\Orm\Tests\Model\schema())` | `Dbspec::addTablesAndColumnsSteps` |
| TypeScript | `utils().schema().addTablesAndColumns(SCHEMA)` | `addTablesAndColumnsSteps` |
| Rust | `utils().schema().add_tables_and_columns(&model::SCHEMA).await` | `orm_schema::dbspec::add_tables_and_columns_steps` |

`install`은 set을 통째로만 만들고 일부 테이블만 있는 set에는 `CONFIG`를 반환한다. `addTablesAndColumns`는 그런 set을 새 version으로 올리고, 그 뒤 `install`은 아무것도 바꾸지 않는다.
