# schema.md — 스키마 소스는 Mermaid erDiagram 하나

사람이 쓰는 파일은 `schema/*.mmd`(Mermaid `erDiagram`)뿐이다. GitHub·IDE·아티팩트에서 그대로 그림으로 렌더되고,
`ormgen`이 이 파일을 파싱해 관계·kind·인덱스·스타일을 갖춘 **매니페스트(`schema.json`, 생성물)** 를 만든다. 매니페스트는 손으로 편집하지 않는다.
기존 DB가 있으면 `ormgen import --dsn … --out schema/service.mmd`가 이 파일을 만들어 준다(FK → 관계선, 인덱스 → `%%` 지시문).

## 1. 예

```mermaid
erDiagram
  battle {
    bigint       seq                 PK  "auto"
    varchar(191) name
    text         description             "? lazy"
    datetime(6)  created_ts              "=now"
    datetime(6)  updated_ts              "=now onupdate"
    tinyint      is_close                "=0 bool"
    tinyint      is_display              "=0 bool"
    datetime(6)  display_start_dt        "?"
    datetime(6)  display_end_dt          "?"
    int          player_count            "=0"
    varchar(191) cover_url               "?"
    varchar(255) aes_hex_email           "? aes,hex"
    varbinary(16) ip                     "ip"
    varchar(36)  uuid                UK  "?"
    bigint       user_seq            FK
    bigint       updated_user_seq    FK  "?"
    bigint       service_seq         FK
    bigint       game_group_seq      FK
    int          game_group_number       "=1"
  }
  battle_item {
    bigint  seq          PK "auto"
    bigint  battle_seq   FK
    int     order_number    "=0"
    varchar(191) name
  }
  battle_player {
    bigint  seq                   PK "auto"
    bigint  battle_seq            FK
    bigint  p1_battle_player_seq  FK "?"
    varchar(2) side
  }

  service       ||--o{ battle        : service_seq
  user          ||--o{ battle        : user_seq
  user          ||--o{ battle        : "updated_user_seq (updater / updated_battles)"
  game_group    ||--o{ battle        : game_group_seq
  battle        ||--o{ battle_item   : "battle_seq (battle / items)"
  battle        ||--o{ battle_player : "battle_seq (battle / players)"
  battle_player ||--o| battle_player : "p1_battle_player_seq (p1 / p1_of)"

  %% unique   battle (game_group_seq, game_group_number)
  %% index    battle (service_seq, is_close)              ik
  %% fulltext battle (name, description)
  %% scope battle service_seq
```

## 2. 규칙

### 2.1 컬럼 줄 — `타입 이름 [PK|FK|UK] ["주석"]`
Mermaid 문법을 사용한다. `PK`, `FK`, `UK`는 Mermaid keyword다. 기본키를 구성하는 모든 컬럼에 `PK`를 지정하며 선언 순서가 복합키 순서다. 복합 unique key는 아래 `%% unique`로 표현한다.
생성된 복합키 타입과 전체 키 조회 메서드는 이 순서를 보존한다. PK는 임의의 유효한 컬럼명을 사용할 수 있고 여러 컬럼으로 구성할 수 있다. `seq`는 자동 증가 키에 사용하는 프로젝트 관례일 뿐이다. 자동 키가 없는 엔터티에 insert하려면 모든 primary key 값을 지정해야 하며, insert 후 모든 키 조건으로 행을 조회한다. `save`는 실행 전에 부분 primary key를 거부한다.
타입은 DB 타입을 그대로 쓴다(`bigint`, `uuid`, `varchar(191)`, `datetime(6)`, `decimal(13_3)`, `enum('a','b')`). 매니페스트가 정규 타입(i64/string/datetime/…)으로 바꾸며 UUID 바인딩은 문자열을 사용하고 PostgreSQL DDL은 native `uuid`를 보존한다.
`varchar`와 `char`에는 양의 길이가 필요하다. 길이가 없거나 0이거나 잘못된 값이면 DDL 생성 전에 schema build가 실패한다.

주석 문자열은 공백으로 나눈 **속성 목록**이다. 없으면 NOT NULL, 기본값 없음, 일반 컬럼.
| 속성 | 의미 |
|---|---|
| `?` | NULL 허용 |
| `=값` | DEFAULT. `=0`, `='ko'`, `=now`(CURRENT_TIMESTAMP), `=null` |
| `onupdate` | ON UPDATE CURRENT_TIMESTAMP (`updated_ts`용) |
| `auto` | AUTO_INCREMENT |
| `unsigned` | UNSIGNED (임포터가 채움; 손으로 쓸 땐 생략 가능) |
| `bool` | tinyint를 bool로 노출 |
| `lazy` | 기본 SELECT에서 제외(`selectX()`로 옵트인). text/blob 계열은 지정 없어도 lazy |
| `aes` `hex` `gz` `json` `jsons` `base64` `serialize` `ip` | dataStyle 파이프라인(순서대로 쓰기, 역순 읽기). 컬럼명 접두어(`aes_hex_*`, `gz_*`, `json_*`)와 컬럼명 `ip`에서 자동 추론되므로 보통 생략 |
| `-> table.column` | FK 대상 명시(관계선 없이 FK만 둘 때). 관계선이 있으면 불필요 |
| `%…%` 나머지 | 설명(문서용). 속성으로 해석되지 않는 단어는 설명으로 취급 |

### 2.2 관계선 — `부모 ||--o{ 자식 : "fk컬럼 (자식측이름 / 부모측이름)"`
| 표기 | kind | 생성되는 토큰 |
|---|---|---|
| `\|\|--o{` (1 : 0..N) | 자식→부모 **one**, 부모→자식 **many** | 자식: `relation<Parent>` / `join<Parent>`, 부모: `relations<Children>` / `join<Children>` |
| `\|\|--\|\|`, `\|\|--o\|` (1 : 0..1) | 양쪽 **one** | 양쪽 `relation…` |
| `}o--o{` (N : M) | 직접 지원 안 함 — 조인 테이블을 엔티티로 그린다(`a_match_b` 관례) |

라벨: 단일 컬럼 관계는 자식 FK 컬럼으로 시작한다. 복합 관계는 `(tenant_id, account_id)`처럼 순서가 있는 자식 FK 목록으로 시작하고 `(tenant_id, account_id) (account / memberships)`처럼 관계 이름을 반드시 명시한다. FK 수는 부모 기본키 수와 같아야 하며 같은 위치의 부모 키에 대응한다. `(자식측 / 부모측)` 관계 이름은 단일 컬럼 관계에서만 생략할 수 있다.
이름 기본값: 자식측 = FK 컬럼에서 `_seq` 또는 `_id` 제거(`service_seq`→`service`, `created_by`→`created_by`), 부모측 = 자식 테이블명에서 부모 테이블명 접두어를 떼고 복수형(`battle_item`→`items`, `product_review`→`reviews`, 접두어가 없으면 테이블명 복수형 `battles`). FK 컬럼명이 `_seq`일 필요는 없으며 관계선이 기준이다.
같은 부모를 두 번 참조하면(`user_seq`, `updated_user_seq`) 관계선을 두 줄 긋는다. 이름 충돌은 `ormgen`이 오류로 표시한다.
같은 자식 column이 서로 겹치는 복합 foreign key를 포함해 둘 이상의 foreign key에 참여할 수 있다. 각 관계선의 순서 있는 local/target key pair가 계속 정본이며 generated DDL은 서로 다른 제약을 모두 생성하고 generated relation metadata도 모든 pair를 보존한다. 소스의 `-> table.column` 선언은 하나의 명시적 target을 지정하므로 관계선과 충돌할 수 없다.

### 2.3 `%%` 지시문 (Mermaid는 주석으로 무시, ormgen만 읽음)
```
%% unique   <table> (<col>, …)              # 복합 UNIQUE. 단일 컬럼은 컬럼 줄의 UK로
%% index    <table> (<col>, …)  [이름]      # 복합 인덱스. 단일 컬럼 인덱스는 FK면 자동, 아니면 여기
%% fulltext <table> (<col>, …)              # FULLTEXT → `<a>With<b>Match…()` 생성
%% check    <table> <name> : <expression>   # database CHECK constraint; backtick columns are validated
%% timestamps <table> created_ts updated_ts # 자동 타임스탬프 컬럼 지정(기본: 이름이 created_ts/updated_ts면 자동)
%% predicate <table> <name> : <expr 조각>   # 재사용 술어 → `<name>(args…)` 메서드. 백틱 컬럼은 검증, `?`마다 인자 하나
%% scope <table> <column>                 # query API와 IR에 독립된 tenant scope 생성
%% aes_version <table> <column>           # AES payload가 사용하는 NULL 불가 정수 version column
%% soft_delete <table> <column>            # nullable datetime; reads exclude non-NULL rows and delete writes the current timestamp
%% many_to_many <source> <target> <source_relation> <target_relation> through <through_entity>
%% table_comment <table> "database table comment"
%% column_comment <table> <column> "database column comment"
%% rename_table <new_table> <old_table>      # migration rename
%% rename_column <table> <new_col> <old_col> # migration rename
%% orm:table entity=<entity> name=<schema.table> # 정규화된 물리 테이블 이름
%% orm:foreign entity=<entity> columns=<local_col>[,<local_col>...] references=<schema.table>(<col>[,<col>...]) [name=<constraint>] [on_delete=<action>] [deferred=true]
%% orm:immutable entity=<entity> # 생성된 데이터베이스 trigger가 UPDATE·DELETE·TRUNCATE를 거부
```

`orm:table` directive가 정규화된 물리 테이블을 선언하는 schema source의 유일한 방법이다. manifest는 두 식별자 구성요소를 보존한다. PostgreSQL DDL과 query quoting은 schema와 table을 별도 식별자로 처리하며, SQLite는 `schema.table`을 결정적인 물리 이름 `schema__table`로 매핑하고 generated index 이름에도 같은 namespace를 사용해 namespace를 보존한다. 따라서 하나의 SQLite database에서 같은 table 기본 이름을 가진 module schema가 충돌하지 않는다.

`orm:foreign`은 현재 manifest 외부의 table을 참조하는 물리 foreign key나 명시적 제약 옵션이 필요한 관계를 선언한다. 로컬·참조 column 수는 같아야 한다. `deferred=true`는 PostgreSQL과 SQLite에서 deferrable, initially deferred 제약을 생성하며 지원하지 않는 action이나 잘못된 참조는 schema validation에서 실패한다. `orm:immutable`은 선언한 entity의 행 update·delete·truncate를 거부하는 dialect별 database trigger를 생성한다.

Rename directive는 migration metadata다. `ormgen diff`는 비슷한 이름을 rename으로 추정하지 않는다. target directive는 정방향 `RENAME`을 생성하며 같은 구조화 plan은 rollback용 역방향 `RENAME`을 생성한다. 이후 schema version에도 directive를 유지한다. 현재 table이나 column 이름이 이미 있으면 반복 diff는 no-op이다. 누락, 중복, 자기 참조, 모호한 rename source는 schema 검증이나 diff 생성 단계에서 실패한다.

테이블 주석과 컬럼 주석은 스키마 데이터입니다. `ormgen ddl`은 MySQL 주석,
PostgreSQL `COMMENT ON` 문, SQLite의 `orm_schema_comments` 행을 생성합니다.
`ormgen import`는 같은 데이터베이스 메타데이터를 읽어 이 지시문을 생성합니다.
주석을 변경하면 스키마 해시가 변경되고 멱등 마이그레이션이 생성됩니다.

`many_to_many`는 하나의 지시문으로 양쪽 typed relation 이름을 선언한다. through entity에는 source primary-key component마다 참조 column 하나와 target primary-key component마다 참조 column 하나가 있어야 하며, 이 FK column들이 through entity의 primary key를 구성해야 한다. 관계 로딩은 through table subquery로 target table을 제한하고 선언된 key 순서를 유지한다.

### 2.4 생략 가능한 것 (기본 규칙)
- `seq` PK에 `auto`를 지정하는 형식은 `bigint seq PK "auto"`이다. 다른 PK 이름과 복합 PK도 허용한다.
- `created_ts`/`updated_ts`는 이름만으로 타임스탬프 컬럼.
- `is_*` tinyint는 `bool` 없이도 bool로 노출(임포터 기본; 끄려면 `int` 속성).
- text/blob/스타일 컬럼은 자동 lazy(`aes_hex_*`만 예외로 기본 포함).
- 관계선이 FK 대상을 명시하면 `-> table.seq`는 불필요하다. `<table>_seq`는 명명 관례이며 필수 조건이 아니다.

### 2.5 표준 Mermaid가 못 담는 것과 그 자리 (CREATE문 대체 범위)
| CREATE문 요소 | 자리 |
|---|---|
| 테이블·컬럼·타입·PK/FK/UK·관계·카디널리티 | 표준 Mermaid |
| NULL/NOT NULL, DEFAULT, AUTO_INCREMENT, ON UPDATE, lazy, 스타일, FK 대상 | 컬럼 주석 문자열(렌더러는 글자로 표시) |
| 복합 UNIQUE, INDEX(순서 포함), FULLTEXT, 타임스탬프 지정, 재사용 술어, soft delete | `%%` 지시문(렌더러는 무시) |
| FK 참조 동작 | 관계선 라벨 속성 `cascade`/`setnull` (기본 RESTRICT) |
| 3 DB 방언 차이 | 파일에 없음. 타입 어휘를 고정하고 `ormgen ddl --dialect mysql\|postgres\|sqlite`가 방언별 CREATE문을 생성 |
| CHECK, 파티션, 콜레이션·엔진 옵션, 뷰·함수·시퀀스·확장 | 다루지 않음(ORM 범위 밖). 마이그레이션 SQL에 직접 |
| 임의 트리거 | 스키마 생성기는 다루지 않는다. Go adapter의 명시적 `Tx.InstallAudit` 인터페이스는 선언된 감사 관계를 검증하고 PostgreSQL·SQLite의 방언별 감사 트리거 SQL을 소유한다. `Tx.InstallImmutable`은 append-only 테이블을 위한 같은 adapter 소유 경로이며 UPDATE·DELETE(그리고 PostgreSQL TRUNCATE)를 거부한다. PostgreSQL은 transaction-local 설정을 사용하고 SQLite는 ORM 소유 transaction context table을 사용한다. |

SQLite audit trigger에서 생성 JSON column은 text로 저장된다. adapter는 감사 row object를 만들기 전에 유효한 JSON text를 JSON node로 복원하므로 nested redaction path가 PostgreSQL `jsonb`와 같은 논리적 의미를 가지며, JSON이 아닌 text는 scalar로 유지한다. qualified logical table은 audit discovery, trigger 대상, operation/change table과 immutable guard 모두에서 같은 `schema__table` 물리 매핑을 사용한다.

SQLite의 `ForUpdate`, `ForShare`와 `NoWait` 형식은 adapter가 소유한다. ORM은 caller-owned transaction이 시작되기 전에 transaction lock table을 초기화하고, 해당 transaction 안에서 lock row를 획득하며, 일반 lock mode에서는 대기와 cancellation을 준수하고 `NoWait`에서는 즉시 반환한다. 애플리케이션은 선택한 database driver에 따라 분기하지 않는다.

Go adapter regression test는 lock 직렬화, 즉시 `NoWait`, 소유 transaction 종료 후 완료와 대기 중 cancellation을 검증한다. 각 사례는 제한된 focused test timeout을 사용한다.

`DB.BackendWaitingForLock`은 PostgreSQL lock wait를 확인하는 제한된 integration orchestration inspection API다. PostgreSQL이 아닌 adapter는 driver type이나 database-specific application 경로를 노출하지 않고 `false`를 반환한다.

타입 문자열에 쉼표는 Mermaid 문법상 불가 → `decimal(13_3)`, `enum(a_b_c)`처럼 `_`로 쓴다(ormgen이 해석). 방언별 매핑 규칙표(정규 타입 → DDL)는 `docs/dialects.md`(S6)에 둔다.

## 3. 매니페스트 (생성물, `schema.json`)
```json
{
  "schema_hash": "…",
  "entities": {
    "battle": {
      "table": "battle", "pk": ["seq"], "auto": "seq",
      "columns": {"seq": {"type": "i64", "unsigned": true}, "description": {"type": "text", "nullable": true, "lazy": true},
                  "is_close": {"type": "bool", "default": 0}, "aes_hex_email": {"type": "string", "nullable": true, "style": ["aes","hex"]}, "…": {}},
      "relations": {"service": {"kind": "one", "target": "service", "left": "service_seq", "right": "seq"},
                    "items":   {"kind": "many", "target": "battle_item", "left": "seq", "right": "battle_seq"}, "…": {}},
      "unique": [["uuid"], ["game_group_seq", "game_group_number"]],
      "indexes": {"ik": ["service_seq", "is_close"]},
      "fulltext": [["name", "description"]],
      "timestamps": {"created": "created_ts", "updated": "updated_ts"}
    }
  }
}
```
이 파일은 커밋하되 편집하지 않는다. `ormgen validate`가 `.mmd`↔`schema.json`↔라이브 DB 세 방향의 불일치를 오류로 표시한다.

## 3.1 Namespaced ORM extension

parser는 `%% orm:<kind>` 줄을 `Manifest.ORM`에 보존한다. core는 directive kind, identifier 문법, key/value 문법, 중복 option, 중복 선언만 검사한다. route, permission, public-key, CRUD 의미는 검사하지 않는다. 상위 generator가 해당 검사를 담당한다.

```text
%% orm:field product.company_seq relation=scope fk=company.seq public=company.uuid required=true order=1
```

## 4. 명령
```
ormgen import   --dsn mysql://… --schema service --out schema/service.mmd   # DB → Mermaid (멱등: 라벨의 이름 재정의·주석 속성 보존)
ormgen build    schema/*.mmd --out schema/schema.json                       # Mermaid → 매니페스트 (검증 포함)
ormgen validate --dsn …                                                      # 매니페스트 ↔ 라이브 DB
ormgen ddl      --dialect mysql|postgres|sqlite [--tables …]                # 매니페스트 → CREATE문
ormgen gen      --lang php|go|rust|typescript                                           # 매니페스트 → 클라이언트
ormgen check    --lang php                                                   # 소스 코드 ↔ 매니페스트 (레거시 이름·expr 컬럼)
```

## 5. 검증 에러 (빌드 실패)
컬럼명 규칙(`_and_/_or_/_with_` 포함, 연산자 접미어로 끝남 `_eq/_gt/…`, 키워드와 동일, `__`), 관계 이름 충돌·예약어, 관계선의 FK 컬럼이 자식 엔티티에 없음, `%% index` 컬럼 미존재, 복합 UK와 컬럼 UK 중복, `-> table.column` 대상 없음, FK 컬럼인데 관계선도 `->`도 없음(경고).

## 4. 임포트 (`ormgen import --dsn … [--driver mysql|postgres] --out schema/app.mmd [--tables a,b]`)
살아 있는 MySQL의 `information_schema`를 읽어 다이어그램을 쓴다. 결정적(테이블 알파벳순·컬럼 ordinal순)이라 바뀐 게 없으면 재실행 diff가 0이다.
- 타입: `COLUMN_TYPE` 그대로, `unsigned`는 속성으로(`is_*` tinyint는 bool이라 생략), `decimal(13,3)`→`decimal(13_3)`, `enum('a','b')`→`enum(a_b)`.
- 속성: `?`(NULL), `=값`(`CURRENT_TIMESTAMP*`→`=now`), `onupdate`, `auto`.
- 관계선: FK 제약이 없어도 `<역할>_<테이블>_seq` 이름을 사용해 부모를 추론(앞 단어를 하나씩 떼며 테이블명과 맞춘다: `updated_user_seq`→`user`).
- 인덱스: 복합 unique→`%% unique`, fulltext→`%% fulltext`, 복합/비FK 단일 인덱스→`%% index … 이름`, 단일 컬럼 unique→컬럼 줄 `UK`, FK 단일 인덱스는 생략(자동).
- MySQL과 PostgreSQL은 카탈로그에서 실제 외래키 대상, 컬럼 순서, 삭제 규칙을 읽는다. SQLite는 `PRAGMA foreign_key_list`를 읽는다. 단일·복합 외래키를 관계선으로 생성하며 복합 라벨은 순서가 있는 괄호형 FK 목록을 사용한다. `cascade`와 `setnull`을 보존하고 생략된 동작은 `RESTRICT`를 사용한다.
- PostgreSQL(`--driver postgres`, `postgres://…` DSN이면 자동)은 `information_schema.columns`, `pg_index`, `pg_constraint`를 읽어 같은 다이어그램을 만든다. 타입은 정규 타입으로 변환하고(`character varying(191)`→`varchar(191)`, `boolean`→`tinyint`, `numeric(p,s)`→`decimal(p,s)`, `timestamp(6) with time zone`→`datetime(6)`, `inet`→`varbinary(16)`, `jsonb`→`json`) identity/`nextval`은 `auto`로 변환하며, 생성된 GIN full-text 인덱스는 `pg_get_indexdef`에서 복원한다. PostgreSQL의 `datetime` 컬럼은 session time zone이 바뀌어도 Go `time.Time`의 instant를 보존하도록 `timestamp with time zone`으로 생성한다.
- `--out`이 이미 있으면 DB가 모르는 사실을 이어받는다: 관계 라벨 재정의 `(child / parent)`, 컬럼 속성 `lazy`/`bool`/`int`/명시 스타일, `%% predicate` 줄. 그 외는 DB가 진실이다.
### 데이터베이스 관리 작업

Go transaction adapter는 데이터베이스별 관리 작업을 타입이 지정된 메서드
뒤에 둡니다. PostgreSQL 호출자는 불변 테이블에 `InstallImmutable`을,
명시적인 역할 구분에 `GrantTablePrivileges`와 `RevokeTablePrivilege`를,
검증에 `InspectTablePrivileges`를, transaction 범위 잠금 테스트에
`LockTable`을 사용합니다. 호출자는 이 SQL 문을 직접 만들거나
`database/sql`에 직접 접근하지 않습니다.

### 정본 스키마 설치

Go transaction adapter는 정본 `schema.json` manifest를 `Tx.InstallSchema(context.Context, []byte) error`로 받는다. 연결된 transaction이 자신의 dialect를 선택하고 manifest의 schema engine을 공용 ORM database에 compile·등록한 뒤 ORM schema renderer를 통해 변환하고 caller-owned transaction 안에서 적용 가능한 문장을 실행한다. 소비자는 SQL·DDL 문자열·dialect 분기·driver transaction을 제공하지 않는다. 이 경계의 유일한 schema 입력은 manifest다.
## 공개 client 생성

`github.com/polyspec/orm/generator` 패키지가 client 생성 API다. `generator.Generate`는 정본 manifest, `Go`·`PHP`·`Rust`·`TypeScript` 중 하나와 출력 디렉터리를 받는다. Go 생성은 선택적으로 `PackageName`을 받아 기본값 `gen` 대신 `storage` 같은 명시적 package를 생성할 수 있다. 이름·필드 매핑·언어별 출력은 ORM generator가 소유하며 소비자는 entity별 생성 규칙을 구현하지 않는다.
