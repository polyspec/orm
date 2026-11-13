<!-- doc-id: spec-flowmark-surface -->
<!-- source-sha256: e32c0c6f647852e4bfa18ca1305aac39d2fcf1e69515d2167d588275a4c8b049 -->
# flowmark가 쓰는 orm의 표면

[English](flowmark-surface.md)

flowmark v0.0.15는 legacy Go 모듈 `github.com/polyspec/orm/legacy/packages/go`의 패키지 일곱 개를 import하고 그
exported 이름 317개를 쓰는 Go 프로그램이다. 이 문서는 flowmark가 생성된 Go 바인딩
`github.com/polyspec/orm/packages/go`로 코어를 부를 때([core](core.md) CORE-1, CORE-70) 그 이름 하나하나를 무엇이
전달하는지 적는다: 어떤 값이 어떤 형식의 JSON으로 건너가는지, 그리고 인터페이스 계약 `packages/rust/interface.json`의
어떤 member가 그 값을 전달하는지다. 이 문서가 이름하는 모든 member에는 [core](core.md)의 규칙이 적용된다.

## 범위

- **FMS-1** 317개 이름은 flowmark v0.0.15의 소스가 쓰는 패키지 `engine/dbspec`(146), `engine/ir`(109),
  `engine/runtimemodel`(29), `orm`(13), `engine/plan`(11), `engine/dialect`(5), `engine/planner`(4)의 exported
  이름이다: field 221개, 타입 45개, 함수 22개, 상수 22개, method 6개, 변수 1개다. flowmark의 시험 하나는 `orm/sqlite`도
  import하지만 그 이름은 쓰지 않는다. 코어가 SQLite driver를 가지고 있으므로 그 import를 전달하는 member는 없다.
- **FMS-2** 데이터 구조는 계약 타입 `text`의 JSON 텍스트 하나로 바인딩을 건너간다. `step_runner.run`의 step이 그렇게
  건너간다(CORE-92). flowmark는 그 텍스트를 자기 struct로 읽고, 넘기는 값의 텍스트를 직접 쓴다. 구조의 field는 계약의
  unit도 member도 아니므로 field 221개에는 선언이 없다. 계약에는 새 타입이 필요 없다: `text`는 JSON 텍스트를,
  `bytes`는 파일의 바이트를, `path`는 set 파일의 경로를, `orm_value`는 cell의 값을 담는다(CORE-62). 타입
  `json_value`는 구조를 전달하지 않는다. 그 타입의 값은 코어로 들어오지 않기 때문이다(CORE-63). JSON 텍스트는
  UTF-8이고, 코어는 같은 값에 같은 텍스트를 쓴다. 구현되지 않았다.
- **FMS-3** 형식은 `contracts/interface/flowmark/`의 JSON Schema다: `dbspec.schema.json`, `ir.schema.json`,
  `plan.schema.json`이며, 각각 draft 2020-12이고 다른 파일을 이름하지 않는다. 파일의 root는 형식 하나이고, 나머지
  형식은 규칙이 `#/$defs/type`처럼 pointer로 이름하는 definition이다. object는 그 schema가 이름하지 않는 member를
  가지지 않는다. 형식이 false, 0, 빈 값, 없는 값일 때 생략하는 member는 없을 때 그 값을 가진다. FMS-80의 함수가 그 형식을
  쓰고 읽으며, FMS-81의 시험이 그 값을 schema와 비교한다. 둘 다 아직 compile하거나 실행하지 않았다.
- **FMS-4** 317개 이름은 각각 표의 group 정확히 하나에 속한다. group의 종류는 셋이다: `a`는 flowmark가 읽기만 하는
  구조, `b`는 flowmark가 부르는 연산, `c`는 flowmark가 만들거나 바꿔서 orm에 넘기는 값이다. flowmark의 소스가 orm
  호출에 닿는 값에 써 넣는 이름은 종류 `c`이므로, 한 구조의 이름이 종류 `a`의 group과 종류 `c`의 group에 나뉘어
  있을 수 있다. 세 종류는 이름 205개, 29개, 83개를 가진다.

| 종류 | Group | 이름 수 | 규칙 |
| --- | --- | --- | --- |
| a | dbspec 문서: use, default, key | 15 | FMS-10 |
| a | dbspec 문서: check | 19 | FMS-12 |
| a | dbspec 문서: setting | 32 | FMS-13 |
| a | dbspec diagnostic과 position | 12 | FMS-15 |
| a | dbspec 결과: set, manifest, statement | 15 | FMS-20, FMS-22, FMS-23, FMS-25 |
| a | runtime model: entity와 field | 22 | FMS-16 |
| a | IR 요청: flowmark가 읽는 tree | 79 | FMS-31 |
| a | IR 결과: parameter use, restore part, 오류 | 8 | FMS-33, FMS-34, FMS-37 |
| a | plan: flowmark가 읽는 부분 | 2 | FMS-40 |
| a | value function: 상대 함수의 단위 | 1 | FMS-36 |
| b | dbspec: set 읽기와 parse | 4 | FMS-20, FMS-21, FMS-22 |
| b | dbspec: 문서의 manifest, 텍스트, statement | 4 | FMS-23, FMS-24, FMS-25 |
| b | dbspec: literal, 타입 텍스트, audit 규칙 | 3 | FMS-6, FMS-26 |
| b | runtime model: 만들기와 찾기 | 3 | FMS-6, FMS-27 |
| b | IR: validate, parameter use, restore key, 연산자 | 5 | FMS-32~FMS-35 |
| b | planner: compile | 1 | FMS-41 |
| b | codec: cell의 stage와 blind index | 4 | FMS-50 |
| b | keyring | 1 | FMS-51 |
| b | 데이터베이스 handle: 연결, 실행, 닫기 | 4 | FMS-42, FMS-43 |
| c | dbspec 문서: flowmark가 쓰는 부분 | 19 | FMS-10, FMS-14 |
| c | 열 타입 | 19 | FMS-11 |
| c | dialect 이름 | 8 | FMS-25, FMS-41 |
| c | runtime model: flowmark가 쓰는 부분 | 4 | FMS-30 |
| c | IR 요청: flowmark가 쓰는 부분 | 17 | FMS-31, FMS-36 |
| c | plan step: flowmark가 쓰는 부분 | 9 | FMS-42 |
| c | planner: compile의 model과 dialect | 3 | FMS-41 |
| c | 연결 인자: schema와 설정 | 4 | FMS-43 |

- **FMS-5** 계약은 이 문서가 이름하는 unit과 member를 모두 선언한다: class `db`, `schema`, `runtime_model`, record
  `config`, functions unit `dbspec`과 `codec`, 그리고 `db.close`, `schema.load`, `aes_keyring.constructor`와 FMS-7의
  member다. FMS-7의 선언에서는 아직 바인딩이 생성되지 않으므로 어느 언어도 그것을 부르지 않는다. 이 문서의 규칙이
  member가 구현되지 않았다고 적은 곳은 그 뜻이다.
  형식을 쓰고 읽는 FMS-80의 함수는 작성되었고 아직 compile하거나 실행하지 않았다.
- **FMS-6** 이름 여덟 개는 자기 member가 없다. 다섯 개는 orm의 상태를 읽지 않으므로 flowmark가 자기가 읽은 JSON
  텍스트에서 계산한다: 타입의 canonical 텍스트 `Type.String`은 타입의 member에서(FMS-11), audit이 열을 복사하는지
  알려 주는 `AuditSetting.Records`는 audit setting의 `column`, `exclude`, `include`에서(FMS-13), 이름의 field인
  `Entity.Field`는 entity의 `fields`에서(FMS-16) 계산한다. `DiagnosticsError`는 diagnostic을 각각
  `<line>:<column> <rule>: <message>`로 써서 `; `로 이은 텍스트이고, 상수 `SetFileName`은 텍스트
  `dbspec-set.json`이다(FMS-20). 세 개는 다른 이름의 member를 거쳐 코어에 닿는다: `Parse`는
  `dbspec.parse_set`(FMS-22), `Render`는 `dbspec.render_statements`(FMS-25), `ir.Decode`는
  `runtime_model.validate`(FMS-32)를 거친다.
- **FMS-7** 이름을 전달하는 member는 표의 행이다. 표에서 `list<T>`는 계약 타입 `{"list": T}`이고 `optional<T>`는
  `{"optional": T}`이며, `orm_value`는 `{"unit": "orm_value"}`이고, class는 그 unit으로 적는다. `dbspec`과 `codec`은
  `orm`처럼 kind `functions`의 unit이고 module `dbspec`과 `codec`에 있다. 그래서 함수 `dbspec.runtime_model`과 class
  `runtime_model`은 모든 언어에서 이름이 다르다. `runtime_model`은 root module의 class이고 core 타입은
  `polyspec_orm::Manifest`다. `dbspec.read_set`은 파일을 읽으므로(`wait: blocking_io`) 그 core 함수는 token
  `binding_core::Io`를 첫 인자로 받고(CORE-27), `path`를 받으므로 WASM에는 제공되지 않는다(`only`). `db`의 두 member는
  `db.connect`처럼 데이터베이스를 기다리고(`wait: async_driver`), 그 밖의 member는 모두 계산만 한다(`wait: none`).
  `db.connect_schema`에서 class `schema`를 받는 parameter는 borrow `&`를 적는다. `orm.ir_version`은 unit `orm`의 상수
  `ir_version`이다. 선언은 `packages/rust/interface.json`에 있고, 계약 검사나 생성기가 아직 읽지 않았다.

| Member | 매개변수 | 반환 |
| --- | --- | --- |
| `dbspec.read_set` | `path: path` | `text` |
| `dbspec.read_bytes` | `name: text`, `bytes: bytes` | `text` |
| `dbspec.parse_set` | `owned: list<text>`, `external: list<text>` | `text` |
| `dbspec.manifest` | `documents: text` | `text` |
| `dbspec.emit` | `document: text` | `text` |
| `dbspec.render_statements` | `documents: text`, `dialect: text` | `text` |
| `dbspec.canonical_literal` | `column_type: text`, `literal: text` | `optional<text>` |
| `dbspec.runtime_model` | `documents: text` | `text` |
| `runtime_model.load` | `model: text` | `runtime_model` |
| `runtime_model.validate` | `request: text` | `none` |
| `runtime_model.param_uses` | `request: text` | `text` |
| `runtime_model.restore_key` | `request: text` | `text` |
| `runtime_model.compile` | `request: text`, `dialect: text` | `text` |
| `runtime_model.operator_allowed` | `entity: text`, `column: text`, `operator: text` | `bool` |
| `orm.value_function_unit` | `name: text` | `optional<text>` |
| `orm.ir_version` | 없음, 상수 | `uint` |
| `codec.decode` | `stages: list<text>`, `cell: orm_value` | `orm_value` |
| `codec.host_encode` | `value: orm_value`, `stages: list<text>`, `key: text` | `orm_value` |
| `codec.host_decode` | `cell: orm_value`, `stages: list<text>`, `key: text` | `orm_value` |
| `codec.blind_index` | `value: orm_value`, `key: text` | `text` |
| `db.connect_schema` | `dsn: text`, `schema: schema`, `pool_size: uint`, `cfg: config` | `db` |
| `db.execute` | `step: text`, `params: list<orm_value>` | `none` |

## dbspec의 값

- **FMS-10** `dbspec.schema.json`의 root는 문서 하나, 곧 `packages/rust/schema/src/dbspec/model.rs`의 값
  `polyspec_orm_schema::dbspec::Document`다: 문서의 이름, 외부 문서인지 여부, `use` 줄, table, diagram을 가지고, 각각
  텍스트가 거기에 딸려 적은 주석 줄을 함께 가진다. table은 열, primary key, unique key, index, foreign key, check,
  setting을 가진다. member는 Rust 값의 field를 snake case로 쓴 것이고, `type`(field `ty`), `primary_key`(field
  `primary`), FMS-11부터 FMS-13까지의 형식만 다르다. 이 형식은 `engine/dbspec`의 타입 `Document`, `Table`, `Column`,
  `ForeignKey`, `Check`를 그 field와 함께 전달하고, `Use`, `Unique`, `PrimaryKey`, `Default`는 그 field로 전달한다.
  열의 field `Null`은 `nullable`이고, default는 `{"kind": "now"}`나 `{"kind": "literal", "text": <text>}`이며, 상수
  `ActionCascade`와 `ActionSetNull`은 `on_delete`의 텍스트 `cascade`와 `set_null`이다. 문서의 이름이 자기 token의
  위치를 가지므로(`Name`), 이 형식은 위치를 뺀 문서의 view이고 `dbspec::json::document_to_json`이 쓴다. 그 함수는
  형식이 담을 수 없는 문서를 거부한다: primary key가 둘 이상인 table, block이 두 번 가진 한 줄짜리 setting, list가
  둘인 audit setting, canonical 텍스트가 없는 check literal이다. `dbspec::parse`는 그런 문서를 돌려주지 않는다. 이
  형식을 전달하는 member는 구현되지 않았다.
- **FMS-11** 열 타입은 타입의 이름인 `kind`(`Type::name`)와 그 kind의 매개변수만 가진 object다: `varchar`는
  `length`, `decimal`은 `precision`과 `scale`, `time`과 `datetime`은 `precision`을 가지고, 다른 kind는 매개변수가
  없다(`#/$defs/type`). 이 형식은 `Type`, `TypeKind`, `Type`의 field 네 개, 상수 `TypeI16`부터 `TypeDatetime`까지
  13개를 전달하고, 상수의 텍스트가 kind다. legacy 값은 kind에 없는 매개변수에 0을 가지지만 이 형식에는 그런 member가
  없다. 구현되지 않았다.
- **FMS-12** check predicate는 `kind`를 가진 object이고(`#/$defs/expr`), `model::Expr`의 variant마다 kind가 하나다:
  `logic`은 `op`(`and`나 `or`)와 각각 predicate인 `left`, `right`를 가진다. `compare`는 `op`(`=`, `<>`, `<`, `<=`,
  `>`, `>=` 가운데 하나)와 각각 operand인 `left`, `right`를 가진다. `in`은 `column`, `negated`, 그리고 literal의
  canonical 텍스트인 `list`를 가진다. `is_null`은 `column`과 `negated`를 가진다. operand는
  `{"kind": "column", "name": <name>}`이나 `{"kind": "literal", "text": <text>}`다. tree에는 괄호가 없다. 이 형식은
  interface `Expr`과 타입 `Binary`(kind `logic`과 `compare`), `In`, `IsNull`, `ColumnRef`, `Literal`을 그 field와 함께
  전달한다. `In`과 `IsNull`의 field `Operand`는 `column`이다. 코어가 거기에 열을 가지기 때문이다. 구현되지 않았다.
- **FMS-13** table의 setting은 object 하나이고(`#/$defs/settings`), 그 member는 `model::Setting`의 variant를 snake
  case로 쓴 것이다: `entity`, `updated`, `soft_delete`, `select_explicit`, `codec`, `aes_version`, `blind_index`,
  `navigation`, `markdown`, `store`, `title`, `body`, `order`, `task_marker`, `immutable`, `audit`. 열 하나를 이름하는
  setting은 `{"column": <column>}`이고, `codec`, `blind_index`, `navigation`, `markdown`은 줄마다 항목 하나를 가진
  list이며, `immutable`은 immutable인 table에 있는 object다. member가 없으면 그 setting이 없는 것이고, setting 블록이
  없는 table에는 `settings`가 없다. legacy 이름 가운데 `Marks`는 `markdown`, `Codecs`는 `codec`이고,
  `BlindIndexes`는 `column`(`AESColumn`)과 `index`(`IndexColumn`)를 가진 `blind_index`다. `AuditSetting`의 field는
  `into`(`History`), `column`, `references`, `action`, `previous`, `table`·`record`·`name`을 가진
  `tables`(`Tables`, `TablesRecord`, `TablesName`), 그리고 `exclude`나 `include`다. 구현되지 않았다.
- **FMS-14** 문서는 같은 형식으로 코어에 들어온다. 코어에서 나갔다가 다시 들어온 문서는 같은 문서다:
  `dbspec.emit`은 둘에 같은 canonical 텍스트를 쓰고, `dbspec.manifest`는 같은 hash를 쓴다. 들어온 문서에는 token의
  위치가 없으므로, 문서를 받는 member의 diagnostic은 코어가 집합에 주는 줄과 열을 가지고 token의 줄과 열은 가지지
  않는다. flowmark는 문서의 `name`, `external`, `tables`, 주석을 뺀 table의 모든 member, 열의 `name`, `type`,
  `nullable`, `identity`, primary key의 `columns`를 쓰고, 다른 member는 읽기만 한다. 이 형식의 문서가 아닌 텍스트는
  `config`이고 메시지가 그 member를 이름한다. 구현되지 않았다.
- **FMS-15** diagnostic은 값 `dbspec::Diagnostic`이고(`#/$defs/diagnostic`), 선언 위치는 값
  `dbspec::Position`이다(`#/$defs/position`):
  `{"rule": <rule>, "line": <line>, "column": <column>, "message": <message>}`와
  `{"kind": <kind>, "path": [<name>, ...], "line": <line>, "column": <column>}`다. 상수 `PositionTable`과
  `PositionConstraint`는 kind `table`과 `constraint`다. diagnostic을 찾은 `dbspec`의 member는 실패하지 않는다: 그
  결과는 자기 값의 object이거나 `{"diagnostics": [<diagnostic>, ...]}`다. 구현되지 않았다.
- **FMS-16** runtime model은 `{"manifest_hash": <hash>, "entities": [<entity>, ...]}`이고
  (`#/$defs/runtime_model`), `packages/rust/src/schema.rs`의 값 `polyspec_orm::Manifest`다: 그 model의 요청이 이름하는
  manifest hash와, 집합의 순서로 놓인 `dbspec::RuntimeModel`의 entity다. entity는 `name`, `table`, `fields`,
  `primary_key`, `uniques`, `indexes`, `foreign_keys`, `immutable`, `external`을 가지고, table에 있을 때 `identity`,
  `updated`, `soft_delete`, `aes_version`, `audit`을 가진다. field는 `name`, `type`(FMS-11), `nullable`, `identity`,
  `primary_key`, `foreign_key`, `select_explicit`, `codec`을 가지고, 열에 있을 때 `default`와 `blind_index`를 가진다.
  이 형식은 `engine/runtimemodel`의 `Model`, `Entity`, `Field`를 전달한다: legacy 모듈에서 이름별 map인 `Entities`는
  list `entities`이고, `PK`는 `primary_key`, `Null`은 `nullable`이며, field의 `Type`, `Length`, `Precision`, `Scale`은
  그 `type`이다. legacy 모듈에서 boolean인 `Default`는 `default`가 있는지 여부이고, `ManifestText`는 manifest의
  `manifest_text`다(FMS-23). `dbspec::json::runtime_model_to_json`은 `entities`를 가진 object를 쓰고,
  `Manifest::to_json`이 `manifest_hash`를 더한다. 이 member는 구현되지 않았다.

## dbspec의 member

- **FMS-20** `dbspec.read_set(path)`는 `dbspec::read_set`처럼(`packages/rust/schema/src/dbspec/set.rs`) `path`의 set
  파일과 그 파일이 나열한 모든 파일을 읽고 `{"documents": [<file>, ...], "external": [<file>, ...]}`나
  `{"errors": [<error>, ...]}`를 돌려준다(`#/$defs/set_result`). 파일은 `{"path": <path>, "bytes": <base64>}`다: 이어
  붙인 경로와, padding이 있는 base64로 쓴 파일의 바이트이며, 이 member는 그 바이트를 검사하지 않는다. 오류는
  `{"rule": <rule>, "path": <path>, "message": <message>}`다. Unicode 텍스트가 아닌 경로는 JSON 텍스트가 없으므로,
  이어 붙인 경로가 그런 집합은 `config`이고 메시지가 set 파일을 이름한다. 이 member는 `ReadSet`, `Set`, `SetFile`,
  `SetError`를 전달한다. 이름이 `dbspec-set.json`이 아닌 set 파일은 거부한다(`set.file`). 구현되지 않았다.
- **FMS-21** `dbspec.read_bytes(name, bytes)`는 `dbspec::read_bytes`처럼 문서 파일의 바이트를 검사하고
  `{"text": <text>}`나 signature 또는 encoding의 diagnostic을 돌려준다(`#/$defs/bytes_result`). `name`은 메시지가 그
  파일을 부르는 이름이다. flowmark는 FMS-20의 파일의 바이트를 넘긴다. 이 member는 `ReadBytes`를 전달한다. 구현되지
  않았다.
- **FMS-22** `dbspec.parse_set(owned, external)`은 `dbspec::parse_set`처럼 한 집합의 텍스트를 parse하고 텍스트마다
  object 하나를, 소유한 텍스트를 먼저 돌려준다(`#/$defs/parse_set_result`): header가 실패하면 없는 `name`,
  `external`, 텍스트에 diagnostic이 있으면 없는 `document`(FMS-10), `positions`, `diagnostics`다. 이 member는
  `ParseSet`과 `SetDocument`를 전달한다. `Parse`는 member가 없다: flowmark의 시험 하나가 집합의 각 텍스트를 나머지
  텍스트와 함께 parse하는데, 그것은 텍스트를 `owned`로 준 이 member의 호출 한 번이다. 구현되지 않았다.
- **FMS-23** `dbspec.manifest(documents)`는 한 집합의 문서를 JSON list로 받고(`#/$defs/documents`),
  `dbspec::manifest`처럼 `{"manifest": <manifest>}`나 집합의 diagnostic을 돌려준다(`#/$defs/manifest_result`).
  manifest는 `manifest_text`, `external_text`, `schema_text`, `manifest_hash`, `schema_hash`를 가진다. 이 member는
  `ManifestOf`와 `Manifest.ManifestHash`를 전달한다. 구현되지 않았다.
- **FMS-24** `dbspec.emit(document)`는 `dbspec::emit`처럼 문서 하나의 canonical 텍스트를 돌려준다. `Emit`을
  전달한다. 구현되지 않았다.
- **FMS-25** `dbspec.render_statements(documents, dialect)`는 집합의 table을 만드는 statement를
  `dbspec::render_statements`의 순서로 `{"statements": [{"sql": <sql>, "table": <table>}, ...]}`로 돌려주거나 집합의
  diagnostic을 돌려준다(`#/$defs/statements_result`). `dialect`는 상수 `DialectMySQL`, `DialectPostgres`,
  `DialectSQLite`의 텍스트인 `mysql`, `postgres`, `sqlite` 가운데 하나이고, 다른 텍스트는 `config`다. 이 member는
  `RenderStatements`, `RenderedStatement`, `engine/dbspec`의 타입 `Dialect`를 전달한다. `Render`는 member가 없다: 그
  결과는 각 statement의 `sql`이다. 이 member는 구현되지 않았다. dialect의 이름은 `dbspec_json::render_statements`가 읽는다.
- **FMS-26** `dbspec.canonical_literal(column_type, literal)`은 그 타입의 열의 default로서 `literal`의 canonical
  텍스트를 돌려주고, `literal`이 그 타입의 literal이 아니면 아무것도 돌려주지 않는다. `column_type`은 타입의 JSON
  텍스트다(FMS-11). parameter는 `type`이라는 이름을 쓰지 않는다. Go가 그 단어를 예약한다.
  literal은 앞뒤에 공백이 없는 token 하나다: 빼기 부호가 붙어 있는 수, 단어, 따옴표로 감싼 문자열이다. `text`나
  `bytes` 열에는 literal이 없다. 이 member는 `CanonicalLiteral`을 전달한다. 이 member는 구현되지 않았다.
  `packages/rust/schema/src/dbspec/literal.rs`의 `dbspec::canonical_literal`이 텍스트에서 literal을 읽고, parser가 읽은
  token에 대한 규칙인 `default_literal`을 적용한다.
- **FMS-27** `dbspec.runtime_model(documents)`는 `{"model": <model>}`(FMS-16)이나 집합의 diagnostic을
  돌려준다(`#/$defs/runtime_model_result`): 같은 문서의 `dbspec::runtime_model`의 entity와 `dbspec::manifest`의
  manifest hash다. 이 member는 `Build`를 전달하고, model의 handle은 `runtime_model.load`가 만든다(FMS-30). 구현되지
  않았다.

## runtime model과 요청

- **FMS-30** `runtime_model`은 계약의 class이고, 그 값은 manifest hash를 가진 runtime model, 곧
  `polyspec_orm::Manifest`다. handle이 model을 코어 안에 유지하므로 model을 읽는 member는 model 텍스트를 받지
  않는다. `runtime_model.load(model)`은 FMS-16의 model 텍스트의 handle을 만들고, 그 형식의 model이 아닌 텍스트는
  `config`다. model이 manifest 텍스트의 model일 필요는 없다: flowmark는 `dbspec.runtime_model`이 돌려준 model을 바꿔서
  그 결과를 load하며, `manifest_hash`, list `entities`, entity의 `external`을 쓴다. 이 class는 legacy 모듈의 함수가
  받는 `Model`의 pointer를 전달한다. 구현되지 않았다.
- **FMS-31** 요청은 `ir.schema.json`의 JSON 텍스트다: `polyspec_orm::ir::Request`의 serde
  형식이고(`packages/rust/src/ir.rs`), [protocol](protocol.md) 1절의 요청이다. 요청의 query의 member는 요청 object의
  member이고, group의 item은 `pred`, `group`, `joined` 가운데 정확히 하나를 가진 object이며, limit은 `offset`과
  `count`의 쌍이거나 `offset_p`와 `count_p`의 쌍이고 두 member를 모두 가진다. 이 형식은 `engine/ir`의 모든 타입과
  field를 전달한다: field는 legacy 모듈에서 그 tag의 member를 가지므로 `IRVersion`은 `ir_version`, `ForceIdx`는
  `force_index`, `NParams`는 `n_params`이고, 요청의 `Query`는 member가 아니다. flowmark는 자기가 만드는 요청의
  `ir_version`, `manifest_hash`, `kind`, `entity`, `where`, `order`, `load`, `set`, `n_params`와 배정의 `column`, `p`,
  `null`을 쓰고, 다른 member는 읽기만 한다. schema는 코어가 쓰는 텍스트를 적는다. 요청을 받는 member는 형식의
  member가 없으면 그 default로 읽되 limit의 member는 예외이고, JSON object가 아닌 텍스트, 형식에 없는 member, `null`인 member,
  타입이 다른 member, object 뒤의 텍스트를 `ir_invalid`로 거부한다. legacy 모듈은 0인 member를 뺀 literal limit을 쓰고 `null`을 없는 member로
  읽는데, 둘 다 이 형식의 요청이 아니다. `ir::Request`를 읽는 serde의 코드는 형식에 없는 member를 받고
  `null`을 없는 member로 읽으므로, `Request::from_json`은 serde가 읽기 전에 텍스트의 member를 검사한다. 요청을 읽는
  member는 아직 없다.
- **FMS-32** `runtime_model.validate(request)`는 `polyspec_orm::engine::validate`처럼 요청을 model에 대해 검증하고
  아무것도 돌려주지 않는다. 검증이 거부한 요청은 `ir_invalid`, `version_mismatch`, `schema_hash_mismatch`,
  `column_unknown`, `operator_not_allowed` 같은 그 원인의 kind로 실패한다. 이 member는 `Validate`를 전달한다.
  `Decode`는 member가 없다: flowmark는 요청 텍스트를 자기 struct로 읽고, 그 struct에서 FMS-31의 형식으로 쓴 텍스트를
  이 member에 넘긴다. 구현되지 않았다.
- **FMS-33** `runtime_model.param_uses(request)`는 검증된 요청의 parameter마다 그 slot을 parameter의 순서로
  돌려준다(`ir.schema.json`의 `#/$defs/param_uses`). 열이 없는 slot은 `{"type": <type>}`이고, 열의 slot은 그 열의
  `column`, `length`, `null`, `precision`, `scale`도 가지며, 배정이면 `"assign": true`를 가진다. 이것은
  `polyspec_orm::testing::param_uses`가 쓰는 형식이다(`packages/rust/src/testing.rs`). 이 member는 `ParamUses`와
  `ParamUse`를 전달하고, legacy 모듈에서 field의 pointer인 `Column`은 열의 이름과 크기다. 이 member는 구현되지
  않았다. `Manifest::param_uses`는 모든 빌드에서 그 형식을 쓰고, `testing::param_uses`는 같은 값을 돌려준다.
- **FMS-34** `runtime_model.restore_key(request)`는 restore 요청의 key를 고르고([protocol](protocol.md) 1.5절) 그
  부분을 돌려준다(`#/$defs/restore_parts`):
  `{"key": [<column>, ...], "where": <group>, "set": [<assign>, ...], "soft_delete": <column>}`다. entity는 요청의
  entity이고, model에 없는 entity는 `entity_unknown`이다. 이 member는 `RestoreKey`와 `RestoreParts`를 전달한다.
  이 member는 구현되지 않았다. `Manifest::restore_key`가 `packages/rust/src/engine/validate.rs`의 `restore_key`의 부분을
  쓰고, `restore_key`는 crate 안에서만 보인다.
- **FMS-35** `runtime_model.operator_allowed(entity, column, operator)`는 그 열에 그 연산자의 조건이 허용되는지를
  검증이 정하는 대로 돌려준다(`packages/rust/src/engine/validate.rs`의 `op_allowed`이고, 이 함수는
  `dbspec::operator_allowed_for_field`를 부른다). model에 없는 entity는 `entity_unknown`이고, entity에 없는 열은
  `column_unknown`이다. 이 member는 legacy 모듈에서 field의 pointer를 받는 `OpAllowed`를 전달한다. 구현되지
  않았다.
- **FMS-36** `orm.ir_version`은 상수 1, 곧 코어가 검증하는 요청 형식의 버전이고, `engine/ir`의 상수 `Version`을
  전달한다. `orm.value_function_unit(name)`은 상대 value function의 간격의 단위인 `second`, `minute`, `hour`, `day`,
  `month` 가운데 하나를 돌려주고, 다른 이름에는 아무것도 돌려주지 않는다. flowmark가 이름별로 읽는 map인
  `engine/dialect`의 변수 `ValueFunctionUnits`를 전달한다. 이 member들은 구현되지 않았다. 그 상수는
  `polyspec_orm::ir::VERSION`이고 `polyspec_orm::IR_VERSION`이기도 하며, 그 함수는
  `polyspec_orm::engine::value_function_unit`이다.
- **FMS-37** member는 그 category의 class의 오류로 실패하고, 그 오류는 kind(CORE-10, CORE-11)와 메시지
  `<kind>: <text>`(CORE-12)를 가진다. 이 오류는 `engine/ir`의 타입 `Error`를 전달한다: `Code`는 소문자로 쓴 kind이고,
  `Msg`는 kind 뒤의 텍스트다. 어느 member도 오류를 JSON으로 돌려주지 않는다.

## plan과 데이터베이스

- **FMS-40** plan은 `plan.schema.json`의 JSON 텍스트다: [protocol](protocol.md) 2절의 plan이고, 그 member는
  `legacy/packages/go/engine/plan/plan.go`의 tag다. 형식이 언제나 쓰는 list(`steps`, `tables`, `bind_slots`,
  `columns`, `key`, `keys`)는 list이고 `null`이 아니다. `packages/rust/src/plan.rs`의 `Plan::to_json`과
  `Step::to_json`이 코어의 값 `polyspec_orm::plan::Plan`의 형식을 쓴다. 출력 열의 field `typ`은 member `type`이고,
  step의 field `plan_id`는 member가 아니다. flowmark는 plan의 `steps`, step의 `sql`과 `bind_slots`, slot의
  `col_type`을 읽는다. plan을 돌려주는 member는 아직 없다.
- **FMS-41** `runtime_model.compile(request, dialect)`는 `polyspec_orm::engine::compile`처럼 요청을 검증하고 그
  dialect로 plan을 세워 plan을 돌려준다(FMS-40). `dialect`는 `mysql`, `postgres`, `sqlite` 가운데
  하나이고(`Dialect::parse`), 다른 텍스트는 `config`다. 이 member는 `Planner.Compile`을 전달한다. field `M`과 `D`를
  가진 struct `Planner`는 handle과 인자 `dialect`이고, 구현 `MySQL`, `Postgres`, `SQLite`를 가진 `engine/dialect`의
  interface `Dialect`는 dialect의 텍스트다. legacy 모듈의 `Compile`은 검증 없이 plan을 세우고, 이 member는 먼저
  검증한다. 구현되지 않았다.
- **FMS-42** `db.execute(step, params)`는 `Db::execute`처럼(`packages/rust/src/db.rs`) 행을 읽지 않는 plan의
  statement 하나를 실행한다. `step`은 step의 JSON 텍스트이고(`plan.schema.json`의 `#/$defs/step`), `params`는
  `orm_value`로 준 요청의 parameter다(CORE-62). 그 형식의 step이 아닌 텍스트는 `config`이고, `params` 안의 list, map,
  JSON 값은 `codec_encode`다. flowmark는 step의 `role`, `sql`, `bind_slots`와 slot의 `from`, `name`, `param`,
  `host_styles`를 쓰고, legacy 모듈의 값이 가진 대로 `id`에는 0을, `tables`에는 빈 list를 준다. flowmark의 시험
  하나가 이 member를 부른다. 이 member는 `orm`의 `DB.Execute`와 `engine/plan`의 `Step`, `BindSlot`을 전달한다. 이 member는
  구현되지 않았다. `Db::execute`는 Rust 값 `Step`과 `Param`을 받으므로 CORE-70이 선언하지 않고, `Db::execute_text`는
  step을 그 JSON 텍스트로, parameter를 `orm_value`로 받는다.
- **FMS-43** `db.connect_schema(dsn, schema, pool_size, cfg)`는 `Db::connect_schema`처럼 연결하고 `schema`의 집합을
  그 연결에 등록한다. 그 시그니처의 타입은 모두 계약의 타입이다. `ConnectSchema`를 전달한다. field `Hash`와 `Text`를
  가진 legacy 모듈의 struct `Schema`는 class `schema`이고, `schema.load(manifest_text, external_text, manifest_hash)`가
  같은 텍스트로 그것을 만든다. `Config`는 record `config`, `DB`는 class `db`, `DB.Close`는 member `db.close`다.
  구현되지 않았다: 계약은 `db.connect_schema`를 선언하지 않는다.

## Codec

- **FMS-50** unit `codec`은 값이 `orm_value`(CORE-62)인 member 네 개를 가진다. `codec.decode(stages, cell)`은
  `codec::decode`처럼 저장된 cell을 그 codec stage로 decode한다. `codec.host_encode(value, stages, key)`는
  `codec::host_encode`처럼 host stage `aes`, `hex`, `ip`를 쓰기 순서로 값에 적용한다.
  `codec.host_decode(cell, stages, key)`는 `codec::host_decode`처럼 그것을 되돌린다. `codec.blind_index(value, key)`는
  `codec::blind_index`처럼 값의 blind index를 돌려준다. 값과 cell은 `text`, `bytes`, `null` 가운데 하나이고, 다른
  kind는 값이면 `codec_encode`, cell이면 `codec_decode`다. 이 member들은 패키지 `orm`의 `HostEncode`, `HostDecode`,
  `Decode`, `BlindIndex`를 전달한다. 이 member들은 구현되지 않았다. `packages/rust/src/orm_value.rs`의 네 함수는
  `orm_value`를 받고 돌려주며, Rust 값 `Param`과 `Val`을 받고 돌려주는 `packages/rust/src/codec.rs`의 함수를 부른다.
- **FMS-51** `NewAESKeyring`은 계약의 member `aes_keyring.constructor(keys, current)`다. flowmark는 keyring 파일의
  key를 판정하려고 그것을 부르고 keyring을 유지하지 않는다.

## JSON으로 건너가지 않는 것

- **FMS-60** legacy 모듈의 값 일곱 가지는 데이터가 아니며, 각각 다른 것이 전달한다.
  1. 데이터베이스 handle `*orm.DB`는 열린 연결이다: 계약의 class `db`다.
  2. 함수가 pointer로 받는 runtime model과 그것을 가진 `Planner`는 class `runtime_model`이다(FMS-30). 그래서 코어는
     요청마다 model을 그 텍스트에서 읽지 않는다.
  3. model 안을 향한 pointer는 이름이다: `RestoreKey`에는 요청의 entity, `OpAllowed`에는 entity와 열의 이름,
     `ParamUse.Column`에는 열의 이름과 그 크기다.
  4. dialect 값, 곧 type 세 개를 가진 `engine/dialect`의 interface `Dialect`는 dialect의 이름이다.
  5. check predicate, 곧 flowmark가 type switch로 읽는 interface `Expr`은 `kind`를 가진 object다
     (FMS-12).
  6. flowmark가 `errors.As`로 읽는 오류는 바인딩의 오류다(FMS-37).
  7. 패키지의 변수인 map `ValueFunctionUnits`는 함수 `orm.value_function_unit`이다(FMS-36).
- **FMS-61** 바이트는 JSON 텍스트 안을 그대로 건너가지 않는다: 나열된 파일의 바이트는 base64이고(FMS-20), Unicode
  텍스트가 아닌 이어 붙인 경로는 거부한다.
- **FMS-62** flowmark v0.0.15는 orm에 함수를 넘기지 않고 orm의 subscription, transaction, cancellation, request
  hook을 가지지 않는다. 이 문서의 어느 member도 언어 코드를 부르지 않으므로 상태 기계인 member는 없다(CORE-27).
  flowmark가 열어 둔 채로 가지는 orm의 값은 시험 하나의 데이터베이스 handle뿐이다.
- **FMS-63** token의 위치는 코어 안에 남는다. 문서의 형식은 위치를 가지지 않고(FMS-14), `dbspec.parse_set`의
  `positions`가 선언을 가진다.

## 코어에 있는 legacy 모듈의 이름

- **FMS-70** 317개 이름 가운데 5개는 계약의 unit이나 member이고(`orm.DB`, `DB.Close`, `orm.Config`, `orm.Schema`,
  `orm.NewAESKeyring`), 255개는 코어에 같은 이름의 item이 있으며, 57개는 없다. 57개 가운데 코어에 없는 것은 없다:
  52개는 다른 이름의 공개 item이고 첫째 표의 행이며, 5개는 공개되지 않았거나 형식이 다른 item이 가지고 있고 둘째
  표의 행이며, 각 행은 그것을 전달하는 FMS-80의 공개 함수를 적는다. 두 표의 파일은 `packages/rust` 아래에 있다.

| Legacy 모듈의 이름 | 코어의 item | 파일 |
| --- | --- | --- |
| `DialectMySQL` | `dbspec::Dialect::MySql` | `schema/src/dbspec/render.rs` |
| `TypeDatetime` | `Type::DateTime` | `schema/src/dbspec/model.rs` |
| `TypeKind` | `Type`과 `Type::name` | `schema/src/dbspec/model.rs` |
| `AuditSetting`과 그 field 7개 | `Setting::Audit`과 `AuditTables` | `schema/src/dbspec/model.rs` |
| `AuditSetting.Records` | `Setting::records` | `schema/src/dbspec/model.rs` |
| `Binary`와 그 field 3개 | `Expr::Logic`과 `Expr::Compare` | `schema/src/dbspec/model.rs` |
| `In`과 그 field 3개 | `Expr::In` | `schema/src/dbspec/model.rs` |
| `IsNull`과 그 field 2개 | `Expr::IsNull` | `schema/src/dbspec/model.rs` |
| `ColumnRef`와 `ColumnRef.Name` | `Operand::Column` | `schema/src/dbspec/model.rs` |
| `Default.Now`와 `Default.Literal` | `DefaultValue::Now`와 `DefaultValue::Literal` | `schema/src/dbspec/model.rs` |
| `ColumnSetting.Column` | `Setting::Updated`처럼 열 하나인 setting의 이름 | `schema/src/dbspec/model.rs` |
| `Settings.Title`, `Settings.TaskMarker` | `Setting::Title`, `Setting::TaskMarker` | `schema/src/dbspec/model.rs` |
| `Settings.Codecs`, `CodecSetting`의 field 2개 | `Setting::Codec` | `schema/src/dbspec/model.rs` |
| `Settings.BlindIndexes`, `BlindIndexSetting`의 field 2개 | `Setting::BlindIndex` | `schema/src/dbspec/model.rs` |
| `MarkSetting.Column` | `Setting::Markdown` | `schema/src/dbspec/model.rs` |
| `StoreSetting`의 field 4개 | `Setting::Store` | `schema/src/dbspec/model.rs` |
| `ManifestOf` | `dbspec::manifest` | `schema/src/dbspec/mod.rs` |
| `engine/dialect`의 `MySQL`, `Postgres`, `SQLite` | `engine::Dialect`의 variant | `src/engine/dialect.rs` |
| `Query.ForceIdx`와 `Query.Where` | `ir::Query::force_index`와 `ir::Query::where_` | `src/ir.rs` |
| `Entity.PK` | `Entity::primary_key` | `schema/src/dbspec/runtime.rs` |
| `Model.Entities` | `RuntimeModel::entities` | `schema/src/dbspec/runtime.rs` |
| `Model.ManifestHash` | `Manifest::manifest_hash` | `src/schema.rs` |
| `Model.ManifestText` | `dbspec::Manifest::manifest_text` | `schema/src/dbspec/mod.rs` |
| `DB.Execute` | `Db::execute` | `src/db.rs` |

| Legacy 모듈의 이름 | 코어의 item | 파일 | 전달하는 것 |
| --- | --- | --- | --- |
| `CanonicalLiteral` | token을 받는 `default_literal` | `schema/src/dbspec/literal.rs` | 텍스트를 읽는 `dbspec::canonical_literal` |
| `ValueFunctionUnits` | `value_function_unit` | `src/engine/dialect.rs` | `engine::value_function_unit` |
| `engine/ir`의 `Version` | `ir::VERSION` | `src/ir.rs` | `ir::VERSION`, 곧 `polyspec_orm::IR_VERSION` |
| `RestoreParts.Where` | `RestoreParts::where_` | `src/engine/validate.rs` | `Manifest::restore_key`(FMS-34) |
| `DiagnosticsError` | 오류를 돌려주는 `diagnostics` | `src/schema.rs` | 없음(FMS-6) |

- **FMS-71** 같은 이름의 item이 언제나 같은 것은 아니다. `ir.Decode`는 `codec::decode`와 이름이 같고, 요청을 읽는 함수는 `Request::from_json`이다(FMS-31). `runtimemodel.Build`는 요청을 만드는 `request::build`와 이름이 같고, model은
  `dbspec::runtime_model`이 만든다. `ir.ParamUses`는 crate 안에서만 보이는 `engine::param_uses`이고
  `Manifest::param_uses`가 그것을 부른다(FMS-33). `ir.RestoreKey`,
  `ir.OpAllowed`, `planner.Planner`는 `restore_key`, `op_allowed`, `Planner`이고 각각 crate 안에서만 보인다.
  `PositionTable`과 `PositionConstraint`는 parser의 텍스트 `table`과 `constraint`이고, parser에는 그 상수가 없다.
  `Type.String`은 `Type::render`다.

## 작업의 순서

- **FMS-80** member가 이름하는 코어의 함수는 바인딩이 필요 없으므로 계약이 바뀌기 전에 쓰고 시험한다. 그 함수는 아래
  시그니처다. crate `polyspec-orm-schema`의 함수는 자기 형식이 아닌 값을 그 member를 이름하는 텍스트로 알리고, crate
  `polyspec-orm`의 함수는 `config`로, 요청이면 `ir_invalid`로 알린다. 그 함수는 작성되었고, 아직 compile하거나 실행하지 않았다.

```rust
// packages/rust/schema/src/dbspec/literal.rs, exported from dbspec
pub fn canonical_literal(ty: Type, text: &str) -> Option<String>;

// packages/rust/schema/src/dbspec/json.rs, the module dbspec::json
pub fn type_to_json(ty: Type) -> serde_json::Value;
pub fn type_from_json(value: &serde_json::Value) -> Result<Type, String>;
pub fn document_to_json(document: &Document) -> Result<serde_json::Value, String>;
pub fn document_from_json(value: &serde_json::Value) -> Result<Document, String>;
// The object with `entities`; `manifest_hash` of the form is a member that polyspec_orm::Manifest reads and writes.
pub fn runtime_model_to_json(model: &RuntimeModel) -> serde_json::Value;
pub fn runtime_model_from_json(value: &serde_json::Value) -> Result<RuntimeModel, String>;
pub fn diagnostic_to_json(diagnostic: &Diagnostic) -> serde_json::Value;
pub fn position_to_json(position: &Position) -> serde_json::Value;

// packages/rust/src/dbspec_json.rs, the module polyspec_orm::dbspec_json: the functions of the unit dbspec
pub fn read_set(io: binding_core::Io, path: &std::path::Path) -> crate::Result<String>;
pub fn read_bytes(name: &str, bytes: &[u8]) -> String;
pub fn parse_set(owned: &[String], external: &[String]) -> crate::Result<String>;
pub fn manifest(documents: &str) -> crate::Result<String>;
pub fn emit(document: &str) -> crate::Result<String>;
pub fn render_statements(documents: &str, dialect: &str) -> crate::Result<String>;
pub fn canonical_literal(ty: &str, literal: &str) -> crate::Result<Option<String>>;
pub fn runtime_model(documents: &str) -> crate::Result<String>;

// packages/rust/src/ir.rs
pub const VERSION: u32 = 1; // also polyspec_orm::IR_VERSION
impl Request {
    pub fn from_json(text: &str) -> crate::Result<Request>;
}

// packages/rust/src/plan.rs
impl Plan {
    pub fn to_json(&self) -> serde_json::Value;
}
impl Step {
    pub fn to_json(&self) -> serde_json::Value;
    pub fn from_json(value: &serde_json::Value) -> crate::Result<Step>;
}

// packages/rust/src/engine/json.rs: the functions of the class runtime_model
impl crate::Manifest {
        pub fn from_json(model: &str) -> crate::Result<Manifest>;
    pub fn to_json(&self) -> serde_json::Value;
    pub fn validate(&self, request: &str) -> crate::Result<()>;
    pub fn param_uses(&self, request: &str) -> crate::Result<String>;
    pub fn restore_key(&self, request: &str) -> crate::Result<String>;
    pub fn compile(&self, request: &str, dialect: &str) -> crate::Result<String>;
    pub fn operator_allowed(&self, entity: &str, column: &str, operator: &str) -> crate::Result<bool>;
}

// packages/rust/src/engine/mod.rs
pub use dialect::value_function_unit; // fn(name: &str) -> Option<&'static str>

// packages/rust/src/orm_value.rs: the functions of the unit codec
pub fn decode(stages: &[String], cell: OrmValue) -> crate::Result<OrmValue>;
pub fn host_encode(value: OrmValue, stages: &[String], key: &str) -> crate::Result<OrmValue>;
pub fn host_decode(cell: OrmValue, stages: &[String], key: &str) -> crate::Result<OrmValue>;
pub fn blind_index(value: OrmValue, key: &str) -> crate::Result<String>;

// packages/rust/src/db.rs
impl Db {
    pub async fn execute_text(&self, step: &str, params: Vec<OrmValue>) -> crate::Result<()>;
}
```

- **FMS-81** FMS-80의 함수는 각각 그 함수가 있기 전에는 실패하는 시험을 가진다. 그 시험은
  `packages/rust/schema/tests/unit/flowmark_surface.rs`와 `packages/rust/tests/unit/flowmark_surface.rs`이고, 아직
  실행하지 않았다.
  1. 문서: `contracts/fixtures/bench/`의 모든 문서와 `tests/dbspec/canonical.json`의 모든 canonical 텍스트에 대해 `document_to_json`은 `dbspec.schema.json`의 값이고, 그
     값의 `document_from_json`은 `dbspec::emit`의 텍스트, `dbspec::manifest`의 hash, bench 집합에서는 세
     dialect의 `dbspec::render_statements`의 statement도 같은 문서를 준다.
  2. 거부되는 문서: schema가 이름하지 않는 member, `length`가 없는 `varchar` 타입, `kind`가 없는 predicate는 각각 그
     member를 이름하는 오류다.
  3. runtime model: `runtime_model_from_json(runtime_model_to_json(model))`은 `model`과 같고, manifest hash를 더한 그 값은
     `Manifest::from_json`이 읽는 `#/$defs/runtime_model`의 값이다.
  4. literal: `canonical_literal`은 `legacy/packages/go/engine/dbspec/literal_test.go`의 `TestCanonicalLiteral`의
     case마다 그 결과를 준다.
  5. 집합: `dbspec_json::parse_set`은 `tests/dbspec/set-parse.json`의 case마다 그 텍스트에 대해
     `dbspec::parse_set`의 이름, diagnostic, 문서를 `#/$defs/parse_set_result`의 값으로 준다. `read_bytes`는
     `signature`와 `encoding` diagnostic을 준다. `read_set`은 임시 디렉터리의 집합에 대해 `dbspec::read_set`의
     파일과 오류를 준다.
  6. 요청: `Request::from_json`은 형식에 없는 member, `null`인 member, object 뒤의 텍스트를 `ir_invalid`로 거부하고,
     `tests/planner/compile.json`의 각 요청의 serde 텍스트는 `ir.schema.json`의 값이며 `Request::from_json`이 그것을
     다시 읽으면 같은 serde 텍스트가 된다.
  7. model handle: `tests/planner/compile.json`의 각 요청의 serde 텍스트에 대해 `Manifest::compile`은 `engine::compile`의 plan을 `Plan::to_json`이 쓰는 대로, 곧
     `plan.schema.json`의 값으로 주고, `ir.param_uses` case에서는 `Manifest::param_uses`가 `testing::param_uses`의 값을 준다.
     `Manifest::restore_key`는 restore case에 대해 `restore_key`의 key, where, set을 주고, `tests/ir/validate.json`의
     각 요청의 JSON 텍스트에 대해 `Manifest::validate`는 그 case가 적은 결과를 주고, `null`을 가진 요청에는
     `ir_invalid`를 준다.
  8. step: `Step::from_json(step.to_json())`은 `plan_id`를 뺀 `step`의 field를 가진 step을 주고, `plan_id`는 0이다.
  9. cell: `host_decode(host_encode(value))`는 `hex`, `ip`, `aes`를 거친 텍스트와 바이트에 대해 `value`를 주고,
     `blind_index`는 `codec::blind_index`의 index를 주며, list는 `codec_encode`다.
  10. statement: `Db::execute_text`는 `Manifest::compile`이 쓴 step으로 SQLite 데이터베이스에 행 하나를 넣는다.
- **FMS-82** `packages/rust/interface.json`에 FMS-7의 unit과 member를 선언하는 일, `contracts/interface/core.json`의
  그 case(CORE-71), 생성된 바인딩, flowmark의 Go 코드는 FMS-80의 함수 다음이다. 선언은 작성되었고, 코어의 case runner가
  부르는 member 18개의 case가 있다. `dbspec.read_set`, `db.connect_schema`, `db.execute`는 case가 없다: case 형식에는
  파일의 path나 데이터베이스의 값이 없다(CORE-72). 선언한 member의 `raises` 가운데 kind 65개는 case가 없다(OM-1.5-2). FMS-81의 schema 시험은 `polyspec-orm-schema`처럼
  `polyspec-orm`의 시험 dependency인 `jsonschema`로 schema를 읽는다. 생성된 바인딩과 flowmark의 Go 코드는 구현되지 않았다.
