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
Mermaid 표준 그대로다. `PK`/`FK`/`UK`는 Mermaid 키워드(`PK, FK`처럼 복수 가능, 여러 컬럼에 `PK`면 복합 PK, 여러 컬럼에 같은 `UK`는 아래 `%% unique`로).
타입은 DB 타입을 그대로 쓴다(`bigint`, `varchar(191)`, `datetime(6)`, `decimal(13_3)`, `enum('a','b')`). 매니페스트가 정규 타입(i64/string/datetime/…)으로 바꾼다.

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

라벨: 첫 단어는 자식의 FK 컬럼. 괄호 안 `(자식측 / 부모측)`은 관계 이름 재정의이며 생략 가능.
이름 기본값: 자식측 = FK 컬럼에서 `_seq` 제거(`service_seq`→`service`, `updated_user_seq`→`updated_user`), 부모측 = 자식 테이블명에서 부모 테이블명 접두어를 떼고 복수형(`battle_item`→`items`, `product_review`→`reviews`, 접두어가 없으면 테이블명 복수형 `battles`).
같은 부모를 두 번 참조하면(`user_seq`, `updated_user_seq`) 관계선을 두 줄 긋는다. 이름 충돌은 `ormgen`이 오류로 표시한다.

### 2.3 `%%` 지시문 (Mermaid는 주석으로 무시, ormgen만 읽음)
```
%% unique   <table> (<col>, …)              # 복합 UNIQUE. 단일 컬럼은 컬럼 줄의 UK로
%% index    <table> (<col>, …)  [이름]      # 복합 인덱스. 단일 컬럼 인덱스는 FK면 자동, 아니면 여기
%% fulltext <table> (<col>, …)              # FULLTEXT → `<a>With<b>Match…()` 생성
%% timestamps <table> created_ts updated_ts # 자동 타임스탬프 컬럼 지정(기본: 이름이 created_ts/updated_ts면 자동)
%% predicate <table> <name> : <expr 조각>   # 재사용 술어 → `<name>(args…)` 메서드. 백틱 컬럼은 검증, `?`마다 인자 하나
%% scope <table> <column>                 # query API에 scope(value) 조건 생성
```

### 2.4 생략 가능한 것 (기본 규칙)
- PK가 `seq`이고 `auto`면 `bigint seq PK "auto"` 한 줄.
- `created_ts`/`updated_ts`는 이름만으로 타임스탬프 컬럼.
- `is_*` tinyint는 `bool` 없이도 bool로 노출(임포터 기본; 끄려면 `int` 속성).
- text/blob/스타일 컬럼은 자동 lazy(`aes_hex_*`만 예외로 기본 포함).
- FK 컬럼이 `<table>_seq`이고 관계선이 있으면 `-> table.seq` 불필요.

### 2.5 표준 Mermaid가 못 담는 것과 그 자리 (CREATE문 대체 범위)
| CREATE문 요소 | 자리 |
|---|---|
| 테이블·컬럼·타입·PK/FK/UK·관계·카디널리티 | 표준 Mermaid |
| NULL/NOT NULL, DEFAULT, AUTO_INCREMENT, ON UPDATE, lazy, 스타일, FK 대상 | 컬럼 주석 문자열(렌더러는 글자로 표시) |
| 복합 UNIQUE, INDEX(순서 포함), FULLTEXT, 타임스탬프 지정, 재사용 술어 | `%%` 지시문(렌더러는 무시) |
| FK 참조 동작 | 관계선 라벨 속성 `cascade`/`setnull` (기본 RESTRICT) |
| 3 DB 방언 차이 | 파일에 없음. 타입 어휘를 고정하고 `ormgen ddl --dialect mysql\|postgres\|sqlite`가 방언별 CREATE문을 생성 |
| CHECK, 파티션, 콜레이션·엔진 옵션, 뷰·트리거·함수·시퀀스·확장 | 다루지 않음(ORM 범위 밖). 마이그레이션 SQL에 직접 |

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

## 4. 명령
```
ormgen import   --dsn mysql://… --schema service --out schema/service.mmd   # DB → Mermaid (멱등: 라벨의 이름 재정의·주석 속성 보존)
ormgen build    schema/*.mmd --out schema/schema.json                       # Mermaid → 매니페스트 (검증 포함)
ormgen validate --dsn …                                                      # 매니페스트 ↔ 라이브 DB
ormgen ddl      --dialect mysql|postgres|sqlite [--tables …]                # 매니페스트 → CREATE문
ormgen gen      --lang php,go,rust                                           # 매니페스트 → 클라이언트
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
- PostgreSQL(`--driver postgres`, `postgres://…` DSN이면 자동): `information_schema.columns` + `pg_index`를 읽어 같은 다이어그램을 만든다. 타입은 정규 타입으로 되돌려 적는다(`character varying(191)`→`varchar(191)`, `boolean`→`tinyint`, `numeric(p,s)`→`decimal(p,s)`, `timestamp(6)`→`datetime(6)`, `inet`→`varbinary(16)`, `jsonb`→`json`), identity/`nextval`→`auto`, GIN 인덱스→`%% fulltext`. MySQL에만 있는 `unsigned`·`onupdate`는 나오지 않으므로, 같은 DB를 MySQL과 PostgreSQL에서 각각 임포트하면 그 두 속성만 다르다(정규 타입·관계·인덱스는 동일 — 로컬 orm_bench로 확인).
- `--out`이 이미 있으면 DB가 모르는 사실을 이어받는다: 관계 라벨 재정의 `(child / parent)`, 컬럼 속성 `lazy`/`bool`/`int`/명시 스타일, `%% predicate` 줄. 그 외는 DB가 진실이다.
