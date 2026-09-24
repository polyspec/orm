# 사용법

하나의 Mermaid 스키마에서 Go·PHP·Rust·TypeScript 클라이언트를 생성하고, 각 클라이언트에서 같은 문장을 같은 SQL로 실행한다.
대상 DB는 MySQL 8(기본), PostgreSQL 12+, SQLite 3.46+.

쿼리는 생성된 모델에서 시작하고 `connect`로 열린 데이터베이스 연결을 받는다. 트랜잭션 콜백 안에서 `connect`를 호출하지 않은 모델은 활성 트랜잭션을 사용한다.

문법의 전체 목록은 [dsl.md](dsl.md), 다이어그램 문법은 [schema.md](schema.md), IR/Plan 명세는 [protocol.md](protocol.md),
방언 차이는 [dialects.md](dialects.md), 설정은 [config.md](config.md), 에러 코드는 [errors.yaml](errors.yaml)에 있다.

---

## 1. 준비

| 필요한 것 | 비고 |
|---|---|
| Go 1.27+ | 엔진·생성기·Go 클라이언트 |
| MySQL 8.0.2+ / MariaDB 10.2+ | 1차 대상. PostgreSQL 12+, SQLite 3.46+도 같은 플랜으로 동작 |
| PHP 8.4+ (`pdo_mysql`) | PHP 클라이언트를 쓸 때만. `pdo_pgsql`/`pdo_sqlite`는 해당 DB를 쓸 때 |
| Rust 1.98+ | Rust 클라이언트를 쓸 때만 |
| Node.js 22.16+ | TypeScript 클라이언트를 쓸 때만 |

```sh
git clone https://github.com/polyspec/orm && cd orm
go build ./...
```

---

## 2. 스키마 → 매니페스트

사람이 쓰는 정의는 Mermaid `erDiagram` 하나뿐이다(`schema/bench.mmd`가 예제).

```mermaid
erDiagram
  battle {
    bigint        seq            PK  "auto unsigned"
    varchar(191)  name
    text          description        "?"
    datetime(6)   created_ts         "=now"
    datetime(6)   updated_ts         "=now onupdate"
    tinyint       is_close           "=0"
    bigint        user_seq       FK  "unsigned"
    varchar(255)  aes_hex_email      "?"
  }
  user { bigint seq PK "auto unsigned"  varchar(191) name }

  user ||--o{ battle : user_seq

  %% index battle (user_seq, is_close) ix_user
```

- 주석 문자열이 속성이다: `?`=NULL 허용, `=값`=기본값(`=now`), `onupdate`, `auto`, `unsigned`, `lazy`, `bool`.
- 컬럼 이름이 스타일을 정한다: `aes_hex_*`, `gz_*`, `json_*`, `jsons_*`, `base64_*`, `serialize_*`, `ip`([codec.md](codec.md)).
- 관계선 `부모 ||--o{ 자식 : fk컬럼`은 외래 키를 선언한다. 조회는 `match<L>With<R>`로 관계 키를 지정한다.

```sh
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
```

기존 DB에서 시작한다면 임포트가 같은 파일을 만들어 준다(멱등, 손으로 쓴 속성 보존):

```sh
go run ./cmd/ormgen import --dsn "root@unix(/tmp/mysql.sock)/mydb" --out schema/app.mmd
go run ./cmd/ormgen import --dsn "postgres://user@localhost:5432/mydb" --out schema/app.mmd   # PostgreSQL도 동일
```

## 2.1 테이블 생성과 마이그레이션 생성

manifest에서 데이터베이스별 `CREATE TABLE` SQL을 생성한다.

```sh
go run ./cmd/ormgen ddl --schema schema/schema.json --dialect mysql --out create.mysql.sql
go run ./cmd/ormgen ddl --schema schema/schema.json --dialect postgres --out create.postgres.sql
go run ./cmd/ormgen ddl --schema schema/schema.json --dialect sqlite --out create.sqlite.sql
```

선택한 SQL 파일은 해당 DB의 migration 도구나 client로 적용한다. `ormgen ddl`은 SQL 파일을 생성하며 DB에 연결하지 않는다. 멱등적인 DB 적용에는 실제 DB를 대상으로 `ormgen migrate`를 사용한다.

마이그레이션은 이전 manifest를 보관하고 Mermaid schema를 수정한 뒤 새 manifest와 diff를 생성한다.

```sh
cp schema/schema.json schema/schema.previous.json
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
go run ./cmd/ormgen diff --from schema/schema.previous.json --to schema/schema.json \
  --dialect mysql --out migration.mysql.sql
```

생성된 SQL을 적용하기 전에 검토한다. `ormgen diff`에서 테이블 삭제, 컬럼 삭제, 컬럼 정의 변경에는 `--allow-destructive`가 필요하며 migration 명령은 이 변경을 거부한다. rename은 안전 여부를 추정할 수 없으므로 명시적인 migration으로 작성한다.

diff는 외래키를 먼저 제거하고 해당 인덱스를 제거한 다음 컬럼을 변경하며, 인덱스를 생성한 뒤 외래키를 생성한다. 이름이 있는 인덱스, unique 제약조건, full-text 인덱스, 외래키 대상과 삭제 동작, 컬럼 타입, NULL 허용, 기본값, 코멘트를 비교한다. PostgreSQL은 `TYPE`, `SET|DROP NOT NULL`, `SET|DROP DEFAULT` 작업을 별도 문장으로 생성한다. 외래키 이름은 `fk_<table>_<column>` 형식으로 결정하고 `RESTRICT`, `CASCADE`, `SET NULL`을 명시한다.

SQLite는 column 제거·정의 변경과 primary key·unique·foreign key 변경 시 table을 rebuild한다. transaction은 예약된 임시 table을 생성하고, 이름이 같거나 명시적으로 rename된 column을 복사하고, source table을 교체하고, index와 comment를 다시 생성하고, foreign key를 검증한다. 모든 rebuild에는 `--allow-destructive`가 필요하다. default가 없는 새 필수 column, 기존 임시 객체, 기존 foreign key 위반, 의존 trigger·view가 있으면 첫 rebuild operation 전에 실패한다. 복사·constraint·검증 실패는 transaction을 rollback한다. SQLite는 full-text 조건을 인덱스 없이 평가하므로 full-text 선언은 SQLite 객체를 만들지 않고 rebuild를 일으키지 않는다. NULL 허용 column이나 default가 있는 column 추가는 rebuild 없이 `ADD COLUMN`으로 처리한다.

`ormgen migrate`는 실제 스키마를 읽고 `orm_schema_migrations`를 생성한 뒤 계획을 계산하고 지원되는 비파괴 변경을 적용한다. 적용 후 실제 스키마를 검증하고 결과를 기록한다. 같은 `migration-id`를 다시 실행하면 기록된 migration과 실제 스키마가 일치할 때만 no-op이 된다. `--dry-run`은 DB를 변경하지 않고 계획을 출력한다. 검증은 table과 column을 명칭 기준으로 비교한다. column 순서는 schema 속성이 아니며, DB는 추가된 column을 선언 위치와 관계없이 끝에 붙인다. comment가 있는 column을 추가하면 같은 migration에서 comment도 기록한다.

수정 시각 속성(`onupdate`)은 MySQL에서만 column 속성이다. PostgreSQL과 SQLite에는 이런 속성이 없고 ORM이 update마다 값을 지정하므로, 이 속성만 바뀐 것은 PostgreSQL·SQLite 변경이 아니다. MySQL과 PostgreSQL은 CHECK 식을 자체 정규형으로 저장한다. 비교할 때는 선언된 식을 같은 DB의 임시 table에 만들어 다시 읽고, 정규형이 같으면 변경이 없는 것으로 본다.

### 2.2 Schema 입력 행렬

아래 명령은 하나의 schema source loader를 사용한다. `<source>`에는 `schema.mmd`, `schema.json`, `ormgen ddl` 또는 `ormgen diff`가 생성한 SQL 파일, `db:<dsn>`을 지정한다. `--dialect`는 `ddl`, `diff`, `plan`의 SQL 방언을 정하며, `db:` source는 같은 방언이어야 한다.

모든 DSN은 client와 같은 URI다: `mysql://`, `postgres://`, `sqlite:///<절대 경로>`. scheme이 DB를 정하므로 도구에는 driver 옵션이 없다. `import`와 `validate`는 MySQL, PostgreSQL, SQLite를 읽는다.

| 입력 | DDL | diff SQL | 구조화 plan | database migration |
|---|---|---|---|---|
| Mermaid `.mmd` | `ddl --schema` | `diff --from/--to` | `plan --from/--to` | `migrate --schema` |
| manifest `.json` | `ddl --schema` | `diff --from/--to` | `plan --from/--to` | `migrate --schema` |
| ORM `.sql` | `ddl --schema` | `diff --from/--to` | `plan --from/--to` | `migrate --schema` |
| 실제 `db:<dsn>` | `ddl --schema` | `diff --from/--to` | `plan --from/--to` | `migrate --schema` |

```sh
go run ./cmd/ormgen diff --from 'db:sqlite:///var/lib/app.sqlite' --to schema/app.mmd \
  --dialect sqlite --out migrations/20260912-app.sql
go run ./cmd/ormgen plan --from schema/previous.json --to migrations/20260912-app.sql \
  --dialect sqlite --migration-id 20260912-app --out migrations/20260912-app.json
go run ./cmd/ormgen migrate --dsn sqlite:///var/lib/app.sqlite \
  --schema migrations/20260912-app.sql --migration-id 20260912-app
```

`ormgen ddl`과 `ormgen diff`는 target manifest와 hash를 포함한 `orm-schema-v1` metadata를 추가한다. SQL을 이후 schema 입력으로 사용할 때 이 metadata가 codec style과 relation option을 보존한다. 이 metadata가 없는 SQL은 `MIGRATION_SOURCE_LOSS`로 실패하며 누락된 ORM metadata를 추정하지 않는다. `db:<dsn>` 입력은 조회만 수행한다. Database 변경은 `migrate` 또는 `apply`로만 실행하며 migration lock, history record, file log, source 검사, 적용 후 검증을 사용한다.

구조화된 plan을 생성하고 검토한 동일 plan을 적용한다.

Migration plan 파일은 `YYYYMMDD-name.json` 형식을 사용한다. `.json`을 제외한 파일명이 migration ID다. `--migration-id`를 명시하면 이 값과 일치해야 한다. 날짜가 잘못됐거나 이름이 없거나 ID가 다르면 `MIGRATION_FILE_NAME`을 반환한다.

```sh
go run ./cmd/ormgen plan --from schema/previous.json --to schema/schema.json \
  --dialect postgres --out migrations/20260912-schema.json
go run ./cmd/ormgen apply --plan migrations/20260912-schema.json \
  --dsn "$ORM_DSN" --schema schema/schema.json
go run ./cmd/ormgen verify --dsn "$ORM_DSN" --schema schema/schema.json
go run ./cmd/ormgen rollback --plan migrations/20260912-schema.json \
  --dsn "$ORM_DSN" --allow-destructive
```

plan에는 source·target manifest, 순서가 고정된 정방향·rollback 작업, destructive 표시, 방향별 checksum이 저장된다. `apply`는 실행 전에 실제 source schema를 검사하며 `--allow-destructive`를 명시하지 않은 destructive 작업을 거부한다. `rollback`은 검토한 같은 plan, `applied` 상태의 DB history row, plan의 target schema와 일치하는 실제 schema를 요구한다. 저장된 rollback 작업을 실행하고 source schema를 검증한 후 history 상태를 `rolled_back`으로 변경한다. 반복 실행은 source schema와 rollback 파일 로그가 일치할 때만 `noop`을 반환한다.

Rollback은 source manifest의 schema 구조를 복원한다. 정방향 작업에서 제거한 행이나 rollback 작업에서 제거한 값은 복원하지 않는다. 어느 방향이든 destructive 작업을 포함하면 plan의 `rollback_data_loss_risk`가 설정되며, `rollback` 실행에는 `--allow-destructive`가 필요하다. DB 연결 전 SQL, checksum, destructive 표시, 위험 표시의 변경 여부를 검사한다.

Rollback은 history 상태를 `applied`에서 `rolling_back`으로 변경하고 schema 검증 후 `rolled_back`으로 변경한다. 작업 또는 검증 실패 시 선점한 migration을 `rollback_failed`로 변경하고 작업 번호, SQL 문장, driver 오류, 최종 schema 불일치를 기록한다. 상태 선점 실패는 다른 migration process가 저장한 상태를 변경하지 않는다.

주석은 매니페스트와 마이그레이션 비교에 포함됩니다. Mermaid 원본에서 `%% table_comment`와 `%% column_comment`을 사용합니다. import는 데이터베이스 주석을 읽고, DDL 생성기는 방언별 주석 문을 생성합니다.

마이그레이션 문은 하나의 데이터베이스 트랜잭션에서 실행됩니다. 문장 실행이
실패하면 실행 문장 번호, SQL 본문, 드라이버 오류, rollback 실행 여부를 기록합니다.
DDL을 암시적으로 commit하는 데이터베이스는 해당 데이터베이스의 DDL 동작을 따릅니다.

마이그레이션은 하나의 전용 데이터베이스 연결에서 실행됩니다. MySQL은 데이터베이스별
`GET_LOCK`, PostgreSQL은 트랜잭션 advisory lock, SQLite는 `BEGIN IMMEDIATE`를
사용합니다. 다른 마이그레이션이 잠금을 보유하면 첫 계획 문장을 실행하기 전에
`MIGRATION_LOCK_BUSY`로 실패합니다. 잠금은 commit, rollback, 연결 종료 시 해제됩니다.

SQL 문장 분석기는 작은따옴표 문자열, 인용 식별자, 한 줄 주석, 블록 주석,
PostgreSQL dollar quote 블록을 처리합니다. 이 영역의 세미콜론은 문장 종료로 처리하지
않습니다. 실행 오류에는 1부터 시작하는 작업 번호와 전체 SQL 문장이 포함됩니다.

각 apply, 복구, rollback 실행은 기본적으로 `migrations/logs` 아래에 JSON 감사 파일도 생성한다. 파일명은 `<UTC 시각>__<migration-id>.json`이며 driver, schema hash, 계획 checksum, 상태, 작업 수, 시작 시각, 종료 시각, 오류 상세를 포함한다. `--log-dir`로 다른 디렉터리를 지정할 수 있다. 적용 또는 rollback된 migration에 대응하는 방향별 파일 로그가 없거나 DB history와 다르면 반복 검증에 실패한다.

실행이 중단되어 데이터베이스 이력 상태가 `applying` 또는 `failed`이면 재시도 전에 명시적
복구를 실행한다. `ormgen apply`에는 검토한 동일 plan을 사용하고, `ormgen migrate`에는 기록된
migration ID를 사용한다.

```sh
go run ./cmd/ormgen recover --plan migrations/20260912-schema.json \
  --dsn "$ORM_DSN" --schema schema/schema.json
go run ./cmd/ormgen recover --migration-id 20260912-initial \
  --dsn "$ORM_DSN" --schema schema/schema.json
```

복구는 동일한 데이터베이스 마이그레이션 잠금을 획득하고 실제 schema를 기록된 출발·도착
schema와 비교한다. 도착 schema와 일치하면 이력 상태를 `applied`로 변경한다. 출발 schema와
일치하면 `retryable`로 변경하고 동일 `apply` 또는 `migrate` 명령으로 검증된 계획을 실행할 수
있다. 파일 로그까지 일치하는 `applied` 또는 `retryable` 상태는 `noop`을 반환한다. 그 외 schema
상태는 `MIGRATION_RECOVERY_UNSAFE`로 실패하며 migration ID, 이전 상태, 출발 hash, 도착 hash,
실제 hash를 반환한다. 이 실패는 데이터베이스 이력을 변경하거나 파일 로그를 생성하지 않는다.

| 입력 | 필수 검사 | 결과 |
|---|---|---|
| 구조화 plan | plan checksum, ID, 출발 hash, 도착 hash, 작업 수, 도착 manifest | `applied`, `retryable`, `noop` 중 하나 |
| Migration ID | 기록된 출발 hash, 기록된 도착 hash, 도착 manifest | `applied`, `retryable`, `noop` 중 하나 |
| 부분 적용 또는 외부 변경 schema | 출발·도착 schema 모두 불일치 | `MIGRATION_RECOVERY_UNSAFE`, 상태 변경 없음 |

```sh
go run ./cmd/ormgen migrate --dsn "$ORM_DSN" \
  --schema schema/schema.json --migration-id 20260912-initial --dry-run
go run ./cmd/ormgen migrate --dsn "$ORM_DSN" \
  --schema schema/schema.json --migration-id 20260912-initial
```

---

## 3. 코드 생성

각 언어는 자기 빌드 도구로 모델을 생성한다. 생성기는 `schema.json`을 읽어 해시를 확인하고, 엔티티마다 타입이 있는 컬럼 getter와 setter를 가진 모델 하나를 만든다.

```sh
go run github.com/polyspec/orm/cmd/ormgen gen --schema schema/schema.json --lang go --out model --scan ./...
vendor/bin/orm-gen gen --schema schema/schema.json --out src/Model --namespace 'App\Model'
npx orm-gen gen --schema schema/schema.json --out src/models --scan src
```

```rust
// build.rs
fn main() {
    orm_build::Builder::new("schema/schema.json").scan("src").generate();
}
```

| 언어 | 도구 | 실행 시점 |
|---|---|---|
| Go | `//go:generate` 줄의 `ormgen gen --lang go` | `go build` 전에 `go generate` |
| PHP | `vendor/bin/orm-gen gen` | 스키마 변경 후 Composer 스크립트 |
| TypeScript | `@polyspec/orm-typescript`의 `orm-gen gen` | `tsc` 전에 `build` 스크립트 |
| Rust | `orm-build` crate | `cargo build` 때마다 `build.rs`에서 실행. `orm::models!()`가 모델을 `model` 모듈로 포함한다 |

- Go, Rust, TypeScript 생성기는 `--scan`(Rust는 `scan`)으로 지정한 소비자 소스를 읽어 소스가 호출하는 체인 메서드를 생성한다. 그래서 잘못된 메서드 이름은 빌드를 멈춘다. PHP는 호출 시점에 체인 이름을 해석한다.
- `ormgen gen --lang go`는 scan 회차마다 `--out` 옆의 임시 디렉터리에 파일을 쓰고, scan이 수렴한 뒤에만 `--out`의 생성 파일을 교체한다. 생성 헤더가 없는 파일은 그대로 유지한다. 생성이 실패하면 `--out`을 바꾸지 않으며 `ormgen`은 상태 1로 종료한다. 이 실패에는 잘못된 체인 호출, 수렴하지 않는 scan, 로드할 수 없는 scan 대상 패키지, 컴파일되지 않는 생성 코드가 포함된다. scan이 수렴했지만 scan한 패키지가 다른 이유로 컴파일되지 않으면 `--out`은 완전한 모델을 담고 `ormgen`은 상태 3으로 종료한다.
- 호출 인자의 타입이 확정되지 않아도 scan은 호출한 메서드를 생성한다. 예를 들어 다른 모델 패키지에 아직 없는 메서드로 계산한 값이 이런 인자다. join과 relation 인자는 생성하는 패키지의 모델로 확정되어야 한다. 따라서 여러 모델 패키지에 대한 `go generate` 한 번으로 각 패키지의 최종 모델을 쓴다. 다른 패키지의 메서드가 생기기 전에 실행한 생성은 그 패키지 호출 때문에 여전히 상태 3으로 종료한다.
- 스키마를 바꾸거나 새 체인 호출을 추가한 뒤에는 **모델을 다시 생성하고 스키마와 함께 배포**한다. 생성물의 `schema_hash`와 읽은 `schema.json`이 다르면 기동 시 `SCHEMA_HASH_MISMATCH`로 멈춘다.

Rust `build.rs`는 모델을 생성하기 전에 다이어그램으로 `schema.json`을 만들 수도 있다:

```rust
// build.rs
fn main() {
    let files = vec!["schema/app.mmd".into()];
    let manifest = orm_build::schema::build_files(&files).expect("schema");
    std::fs::write("schema/schema.json", manifest.marshal_indent() + "\n").unwrap();
    println!("cargo:rerun-if-changed=schema/app.mmd");
    orm_build::Builder::new("schema/schema.json").scan("src").generate();
}
```

---

## 4. 연결

애플리케이션은 환경 변수나 Secret Manager에서 DSN URI 하나를 주입한다. URI scheme이 데이터베이스를 선택하며 호출자는 별도 드라이버 값을 전달하지 않는다.

```text
mysql://user:password@host:3306/app?timezone=%2B09:00
postgres://user:password@host:5432/app?sslmode=disable
sqlite:///var/lib/app.sqlite
```

각 클라이언트는 DSN을 받아 해당 네이티브 드라이버와 풀을 만든다. 클라이언트는 읽어 들인 스키마로 애플리케이션 프로세스 안에서 모든 문장을 계획한다. 애플리케이션 옆에서 실행되는 서비스는 없다. 애플리케이션은 `master`, `slave1`처럼 데이터베이스마다 연결을 하나씩 열고, 각 모델에 `connect`로 선택한 연결을 전달한다.

### Go

```go
master, err := model.Connect(masterDSN, schemaPath, orm.Config{AESKey: aesKey})
```

`model.Connect`는 `schemaPath`를 읽어 생성된 모델과 비교한 뒤 `orm.Open(dsn, engine, config)`를 호출한다.

### PHP

```php
$master = Orm::connect($masterDsn, new Config(schemaPath: $schemaPath, aesKey: $aesKey));
```

### Rust

```rust
let master = orm::Db::connect(&master_dsn, pool_size, orm::Config { aes_key, ..Default::default() }).await?;
```

생성된 모듈이 스키마를 포함하므로 연결은 스키마 경로를 받지 않는다.

### TypeScript

```typescript
import { Db } from '@polyspec/orm-typescript';

const master = await Db.connect(masterDsn, schemaPath, { aesKey });
```

각 클라이언트는 요청 형태별로 Plan을 캐시한다. `connection.utils().schema().install(manifestJson)`은 모든 데이터베이스에서 manifest의 없는 테이블, 키, 인덱스, 주석, 트리거를 만들고 기존 테이블은 유지한다.

---

## 5. 읽기

메서드 명칭은 공통이며 표기만 다르다(PHP·TypeScript `camelCase` / Go `PascalCase` / Rust `snake_case`).

```php
$rows = (new Battle)->connect($slave1)
    ->serviceSeq(7)->andIsClose(false)
    ->and(fn (Battle $q) => $q->isDisplay(true)->or()->isAllday(true))
    ->andSeq([6, 106, 206])
    ->orderBySeqDesc()->limit(0, 20)
    ->gets();
```
```go
rows, err := model.Battle().Connect(slave1).
    ServiceSeq(7).AndIsClose(false).
    And(func(q *model.BattleModel) { q.IsDisplay(true).Or().IsAllday(true) }).
    AndSeq([]int{6, 106, 206}).
    OrderBySeqDesc().Limit(0, 20).
    Gets()
```
```rust
let rows = Battle::new().connect(&slave1)
    .service_seq(7).and_is_close(false)
    .and(|q| q.is_display(true).or().is_allday(true))
    .and_seq(vec![6, 106, 206])
    .order_by_seq_desc().limit(0, 20)
    .gets().await?;
```
```typescript
const rows = await new Battle().connect(slave1)
    .serviceSeq(7).andIsClose(false)
    .and(q => q.isDisplay(true).or().isAllday(true))
    .andSeq([6, 106, 206])
    .orderBySeqDesc().limit(0, 20)
    .gets();
```

- 조건: 첫 조건에는 접두어가 없고, 이후 조건은 `and<Chain>`, `or<Chain>` 또는 `and()`·`or()`를 사용하며, 묶음은 `and(fn)`·`or(fn)`을 사용한다. 연산자 접두어·값 형태·체인 규칙은 [dsl.md](dsl.md)에 있다.
- 조회 메서드: `getBy<Chain>`, `getsBy<Chain>`, `getCountBy<Chain>`은 `getsByServiceSeqAndIsClose(7, false)`처럼 모든 컬럼 체인을 받는다.
- 컬럼: `addColumn<Col>()`, `removeColumn<Col>()`, `removeAllColumns()`, `addAllColumns()`. `text`·`blob`·스타일 컬럼은 기본 SELECT에서 빠지며 `addColumn<Col>()`로 추가한다.
- 종단 작업: `get`은 행 하나를 반환하며 일치하는 행이 없으면 `NO_ROWS`를 반환한다. `gets`는 컬렉션을 반환하며 일치하는 행이 없으면 빈 컬렉션이다. `getCount`는 개수를 반환한다.
- 컬렉션은 PK 또는 `keyName<Col>()`을 키로 하는 순서 있는 맵이다. `first()`, `count()`, `toArray()`를 제공하며 순회하면 `key => row`가 나온다.
- `toArray()`는 컬렉션 순서대로 행을 맵 목록으로 반환한다. Go는 `rows.ToArray()`, Rust는 `rows.to_array()`, PHP는 `$rows->toArray()`, TypeScript는 `rows.toArray()`를 사용한다. 순회는 키와 키 타입을 유지한다.

### 집계와 그룹

```php
(new Battle)->connect($slave1)->serviceSeq(7)->groupByUserSeq()->getsCount();   // 사용자별 row_count 행
(new Battle)->connect($slave1)->serviceSeq(7)->sumLikeCount()->getSum();       // like_count 합계
(new Battle)->connect($slave1)->serviceSeq(7)->avgPrice()->getAvg();           // price 평균
```
원시 조건·정렬·그룹·컬럼 형태, 서브쿼리 컬럼, ORM 함수 값은 [dsl.md](dsl.md)에서 정의한다.

---

## 6. 관계와 조인

**관계**는 별도 SQL 문장을 사용한다. 부모 값을 `IN`으로 모아 조회하고 자식 행을 연결한다.
**조인**은 같은 SQL 문장의 일부다.

```php
$rows = (new Battle)->connect($slave1)->serviceSeq(7)->limit(0, 20)
    ->relation((new User)->matchUserSeqWithSeq())                          // $b->getUser()
    ->relation((new Service)->matchServiceSeqWithSeq()
        ->relations((new ServiceMember)->matchSeqWithServiceSeq()          // ->getServiceMembers()
            ->orderBySeqDesc()->groupLimit(3)
            ->keyNameUserSeq()))
    ->relation((new User)->connect($userReplica)->matchUserSeqWithSeq()->aliasWriter())
    ->joinServiceSeqWithSeq((new Service)->on(fn (Service $s) => $s->name('service-7')))
    ->gets();
```

| 자식 옵션 | 의미 |
|---|---|
| `match<L>With<R>()` | 부모 컬럼 `L`과 자식 컬럼 `R`이 같음 |
| `alias<Name>()` | 관계 결과 명칭 |
| `keyName<Col>()` | many 컬렉션의 키 컬럼. 중복이면 마지막 행 사용 |
| `parentNode()` | one 관계 컬럼을 부모 행에 병합. 부모 값 우선 |
| `groupLimit(n)` | `ROW_NUMBER() OVER (PARTITION BY …)`로 부모당 n행 |
| `possible<Col>(v)` | 부모 행이 일치할 때만 조회 |
| `deleteLock()` | `delete(true)`의 중단 지점 |

`connect`를 호출한 관계 자식은 그 연결에서 SQL 문장을 실행한다. 조인 자식은 `on(fn)`으로 `ON` 조건을 정하고 `WHERE` 조건을 직접 설정하며, `and(child)` 또는 `or(child)`가 자식 조건을 묶음으로 넣는다. 조인 자식의 `connect`는 `CONFIG`를 반환한다.
조인한 모델과의 컬럼 비교는 `priceGtMinPrice($brand)` 같은 `<ColA><Op><ColB>(model)`를 사용한다.

---

## 7. 쓰기

```php
$row = (new Battle)->connect($master)->setName('x')->setUserSeq(1)->…->create();   // 생성 키를 포함한 행 반환
$row->setName('y')->update();                                                     // 바뀐 컬럼만 UPDATE
$row->setName('z')->update(true);                                                 // updated_ts 불일치 → OPTIMISTIC_LOCK
$row->delete();
$row->delete(true);                                                               // deleteLock()을 제외한 조회 관계부터 삭제

$replicaRow->connect($master)->plusReadCount(1)->update();                        // 복제본에서 읽고 기본 연결로 쓰기

(new Battle)->connect($master)->setUuid($u)->setName('x')->…
    ->duplication((new Battle)->setName('x')->plusReadCount(1))->create();        // UPSERT
$row->newIsMember(true);                                                          // SQL에 포함하지 않는 추가 값
```

- `update`는 방언 간 값을 맞추기 위해 `updated_ts`를 항상 명시적으로 기록한다.
- `minus<Col>`은 음수를 저장하지 않는다. `setRaw<Col>`은 스키마 검사를 거친 SQL 식을 기록한다.
- `save()`는 기본 키가 있으면 갱신하고 없으면 행을 생성한다.
- 트랜잭션은 `connection.transaction(fn)`을 사용한다. 콜백 오류나 예외는 트랜잭션을 되돌리고 교착 상태는 재시도한다.
- 활성 트랜잭션 안에서 같은 연결의 `transaction`을 호출하면 savepoint를 만든다. 바깥 콜백이 안쪽 실패를 반환하지 않으면 안쪽 작업만 되돌린다.
- 트랜잭션 옵션은 `isolation`, `readOnly`, `timeoutMs`를 선택한다. 지원하는 격리 수준은 `default`, `read_uncommitted`, `read_committed`, `repeatable_read`, `serializable`이다. PostgreSQL은 `BEGIN` 후에, MySQL은 유지한 연결에서 `START TRANSACTION` 전에 설정을 적용한다. SQLite는 `PRAGMA query_only`로 `readOnly`를 적용하고 공통 격리 수준을 트랜잭션 연결에 대응시키며, ORM은 commit이나 rollback 전에 연결 상태를 복원한다. 양수 `timeoutMs`는 PostgreSQL `statement_timeout`을 적용하고 MySQL·SQLite는 `CAPABILITY_UNSUPPORTED`를 반환한다.
- `forUpdate()`, `forShare()`, `forUpdateNoWait()`, `forShareNoWait()`는 트랜잭션 안에서만 허용한다. MySQL과 PostgreSQL은 선택한 행 잠금을 실행하며 `NoWait`는 행을 사용할 수 없으면 즉시 실패한다. SQLite는 잠금 접미사를 만들지 않고 네 모드 모두 ORM 트랜잭션 범위의 데이터베이스 잠금 행을 사용한다.
- 공통 실행 중 취소 메서드는 없다. `timeoutMs`가 PostgreSQL 문장 실행 시간을 제한한다.

```go
err := master.Transaction(func() error {
    row, err := model.Battle().SetName("x").….Create()
    if err != nil {
        return err
    }
    _, err = model.BattleLog().SetBattleSeq(row.GetSeq()).Create()
    return err
})
```
```php
$row = $master->transaction(fn () => (new Battle)->setName('x')->…->create());
```
```rust
let row = master.transaction(async || Battle::new().set_name("x")./*…*/.create().await).await?;
```

---

## 8. 스타일 컬럼

`gz_*`, `json_*`, `jsons_*`, `base64_*`, `serialize_*`는 클라이언트 출력에서 저장 바이트가 아니라 **디코딩한 값**을 사용한다
(Go `any`, Rust `serde_json::Value`, PHP `mixed`). MySQL은 `aes_hex_*`와 `ip`를 SQL 함수로 처리하고,
PostgreSQL·SQLite 실행기는 같은 바이트를 만든다([codec.md](codec.md)).

```php
$b->setJsonSetting(['a' => 1])->connect($master)->update();
$b = (new Battle)->connect($slave1)->addColumnJsonSetting()->getBySeq(42);   // 기본 SELECT에서 제외된 컬럼
$b->getJsonSetting()['a'];
```

---

## 9. 여러 데이터베이스

같은 문장은 세 데이터베이스에서 같은 결과를 만들며 SQL 문장 텍스트만 방언별로 다르다. 규칙과 예외는 [dialects.md](dialects.md)에 있다.

```sh
go run ./cmd/ormgen ddl --schema schema/schema.json --dialect postgres --out app.pg.sql
psql … -f app.pg.sql
```
- Go: `model.Connect(url, schemaPath, config)`. DSN scheme이 드라이버를 선택한다.
- PHP: `Orm::connect(url, config)`. DSN scheme이 PDO 드라이버를 선택한다.
- Rust: `orm::Db::connect(url, pool_size, config).await?`. DSN scheme이 sqlx 드라이버를 선택한다.
- TypeScript: `Db.connect(url, schemaPath, options)`. DSN scheme이 드라이버 패키지를 선택한다.
- 애플리케이션은 여러 연결을 열고 모델마다 `connect`로 하나를 선택할 수 있다. 예를 들어 읽기는 `slave1`, 쓰기는 `master`를 사용한다.
- SQLite는 `Lb`와 전문 검색 연산자를 거부한다(`OPERATOR_NOT_ALLOWED`).

---

## 10. 운영

| 하는 일 | 명령 |
|---|---|
| 스키마가 라이브 DB와 같은지 | `ormgen validate --dsn … --schema schema/schema.json` (다르면 exit 1) |
| 생성물이 최신인지 | 언어별 생성기 실행 후 `git diff --exit-code` |
| 문장 로그 | `Config.OnQuery` / `onQuery` / `Config { on_query }` → `(sql, binds, 시간, plan_id, err)`, 비밀은 `$SECRET`로 마스킹 |
| 실행 없이 SQL 보기 | 연결한 모델의 `getQuery()` ([dsl.md](dsl.md)) |
| 에러 코드 상수 | `ormgen errors --lang go\|php\|rust --out …` ([errors.yaml](errors.yaml)) |
| 스키마 설치 | `connection.utils().schema().install(manifestJson)` |

---

## 11. 자주 나는 에러

| 코드 | 원인과 조치 |
|---|---|
| `SCHEMA_HASH_MISMATCH` | 생성물과 엔진이 읽은 `schema.json`이 다르다. 다시 생성하고 함께 배포한다 |
| `OPERATOR_NOT_ALLOWED` | 스타일 컬럼이나 SQLite 전문 검색처럼 그 타입·스타일에서 허용하지 않는 연산자 |
| `COLUMN_UNKNOWN` / `RELATION_UNKNOWN` | 스키마에 없는 명칭. 다이어그램을 고치고 다시 생성한다 |
| `EMPTY_IN` | 조건이 빈 목록을 받았다. 호출 전에 확인한다 |
| `CONFIG` | 트랜잭션 밖의 `connect` 누락, 연결자 누락·위치 오류, 조인 자식의 `connect`, 설정·경로·드라이버 불일치 |
| `LIMIT_IN_RELATION` | 관계 자식이 `limit`를 사용했다. `groupLimit(n)`을 사용한다 |
| `OPTIMISTIC_LOCK` | `update(true)`가 더 새로운 `updated_ts`를 발견했다. 다시 읽고 재시도한다 |
| `LOCK_NOT_AVAILABLE` | `*_nowait` 행 잠금이 즉시 잠금을 얻지 못했다. transaction conflict로 재시도하지 않는다 |
| `DUPLICATE_KEY` / `DEADLOCK` | 원문을 유지한 드라이버 오류. 교착 오류는 트랜잭션 재시도 뒤에 반환된다 |
| `CODEC_DECODE` | 저장 바이트가 선언된 컬럼 스타일과 다르다 |

---

## 12. 확인

```sh
make test-servers                                        # MySQL, PostgreSQL, 시드한 벤치 데이터베이스
. .runtime/servers/env                                   # 테스트의 DSN 변수
go test ./...                                            # 엔진, 생성기, Go 클라이언트
npm run typescript:test                                  # TypeScript 클라이언트
(cd clients/rust && cargo test --workspace)              # Rust 클라이언트
go run ./tests/conformance/check run -dsn "$BENCH_MYSQL_DSN"   # 네 클라이언트의 같은 결과 (MySQL)
go run ./tests/conformance/check run -driver postgres -dsn "$BENCH_POSTGRES_DSN"
```

예제: [`examples/thin-slice`](../examples/thin-slice)(Go·PHP·Rust, 같은 JSON), [`examples/complex`](../examples/complex)(조인·그룹·2단 관계·집계).
