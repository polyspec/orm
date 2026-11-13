<!-- doc-id: spec-flowmark-surface -->
# The surface of orm that flowmark uses

[Korean](flowmark-surface.ko.md)

flowmark v0.0.15 is a Go program that imports seven packages of the legacy Go module
`github.com/polyspec/orm/legacy/packages/go` and uses 317 of their exported names. This document states how each of
those names is carried when flowmark calls the core through the generated Go binding
`github.com/polyspec/orm/packages/go` ([core](core.md) CORE-1, CORE-70): which values cross as JSON and in which form,
and which members of the interface contract `packages/rust/interface.json` carry them. The rules of [core](core.md)
hold for every member that this document names.

## Scope

- **FMS-1** The 317 names are the exported names that the source of flowmark v0.0.15 uses of the packages
  `engine/dbspec` (146), `engine/ir` (109), `engine/runtimemodel` (29), `orm` (13), `engine/plan` (11),
  `engine/dialect` (5) and `engine/planner` (4): 221 fields, 45 types, 22 functions, 22 constants, 6 methods and 1
  variable. One test of flowmark also imports `orm/sqlite` and uses no name of it; the core holds its SQLite driver, so
  no member carries that import.
- **FMS-2** A data structure crosses the binding as one JSON text of the contract type `text`, as a step of
  `step_runner.run` does (CORE-92): flowmark reads the text into structs of its own and writes the text of a value that
  it passes. A field of a structure is no unit and no member of the contract, so the 221 fields have no declaration.
  The contract needs no new type: `text` holds a JSON text, `bytes` the bytes of a file, `path` the path of a set file
  and `orm_value` a value of a cell (CORE-62). The type `json_value` carries no structure, because a value of it does
  not enter the core (CORE-63). A JSON text is UTF-8, and the core writes the same text for the same value. Not
  implemented.
- **FMS-3** The forms are the JSON Schemas of `contracts/interface/flowmark/`: `dbspec.schema.json`, `ir.schema.json`
  and `plan.schema.json`, each of draft 2020-12 and naming no other file. The root of a file is one form, and its other
  forms are definitions that a rule names by their pointer, such as `#/$defs/type`. An object has no member that its
  schema does not name. A member that a form leaves out when it is false, zero, empty or absent has that value when it
  is absent. Not implemented: no function of the core writes or reads the forms of `dbspec.schema.json` and of
  `plan.schema.json`, and no test compares a value of the core with a schema.
- **FMS-4** Each of the 317 names is in exactly one group of the table. The kind of a group is `a`, a structure that
  flowmark only reads; `b`, an operation that flowmark calls; or `c`, a value that flowmark builds or changes and
  passes to orm. A name is of kind `c` when the source of flowmark writes it into a value that reaches a call of orm, so
  one structure can have names in a group of kind `a` and in a group of kind `c`. The kinds hold 205, 29 and 83 names.

| Kind | Group | Names | Rules |
| --- | --- | --- | --- |
| a | dbspec document: uses, defaults and keys | 15 | FMS-10 |
| a | dbspec document: checks | 19 | FMS-12 |
| a | dbspec document: settings | 32 | FMS-13 |
| a | dbspec diagnostics and positions | 12 | FMS-15 |
| a | dbspec results: set, manifest and statements | 15 | FMS-20, FMS-22, FMS-23, FMS-25 |
| a | runtime model: entities and fields | 22 | FMS-16 |
| a | IR request: the tree that flowmark reads | 79 | FMS-31 |
| a | IR results: parameter uses, restore parts and errors | 8 | FMS-33, FMS-34, FMS-37 |
| a | plan: the parts that flowmark reads | 2 | FMS-40 |
| a | value functions: the unit of a relative function | 1 | FMS-36 |
| b | dbspec: read and parse a set | 4 | FMS-20, FMS-21, FMS-22 |
| b | dbspec: manifest, text and statements of documents | 4 | FMS-23, FMS-24, FMS-25 |
| b | dbspec: literal, type text and audit rule | 3 | FMS-6, FMS-26 |
| b | runtime model: build and look up | 3 | FMS-6, FMS-27 |
| b | IR: validate, parameter uses, restore key and operators | 5 | FMS-32 to FMS-35 |
| b | planner: compile | 1 | FMS-41 |
| b | codec: stages of a cell and blind index | 4 | FMS-50 |
| b | keyring | 1 | FMS-51 |
| b | database handle: connect, execute and close | 4 | FMS-42, FMS-43 |
| c | dbspec document: the parts that flowmark writes | 19 | FMS-10, FMS-14 |
| c | column type | 19 | FMS-11 |
| c | dialect name | 8 | FMS-25, FMS-41 |
| c | runtime model: the parts that flowmark writes | 4 | FMS-30 |
| c | IR request: the parts that flowmark writes | 17 | FMS-31, FMS-36 |
| c | plan step: the parts that flowmark writes | 9 | FMS-42 |
| c | planner: model and dialect of a compile | 3 | FMS-41 |
| c | connection arguments: schema and configuration | 4 | FMS-43 |

- **FMS-5** Of what this document names, the contract declares the classes `db` and `schema`, the record `config` and
  the members `db.close`, `schema.load` and `aes_keyring.constructor`. Every other unit, member, function and form of
  this document is not implemented, and its rule says so.
- **FMS-6** Eight names have no member of their own. Five are computed by flowmark from a JSON text that it read,
  because they read no state of orm: `Type.String`, the canonical text of a type, from the members of the type
  (FMS-11); `AuditSetting.Records`, whether the audit copies a column, from `column`, `exclude` and `include` of the
  audit setting (FMS-13); `Entity.Field`, the field of a name, from `fields` of the entity (FMS-16);
  `DiagnosticsError`, the text of diagnostics, each as `<line>:<column> <rule>: <message>`, joined by `; `; and the
  constant `SetFileName`, the text `dbspec-set.json` (FMS-20). Three reach the core through the member of another
  name: `Parse` through `dbspec.parse_set` (FMS-22), `Render` through `dbspec.render_statements` (FMS-25) and
  `ir.Decode` through `runtime_model.validate` (FMS-32).
- **FMS-7** The members that carry the names are the rows of the table. In it `list<T>` is the contract type
  `{"list": T}` and `optional<T>` is `{"optional": T}`, `orm_value` is `{"unit": "orm_value"}`, and a class is named by
  its unit. `dbspec` and `codec` are units of the kind `functions`, as `orm` is, and `runtime_model` is a class whose
  core type is `polyspec_orm::Manifest`. `dbspec.read_set` reads files (`wait: blocking_io`) and is not offered to
  WASM, because it takes a `path`; the two members of `db` wait for the database (`wait: async_driver`), as
  `db.connect` does; every other member computes (`wait: none`). Not implemented.

| Member | Parameters | Returns |
| --- | --- | --- |
| `dbspec.read_set` | `path: path` | `text` |
| `dbspec.read_bytes` | `name: text`, `bytes: bytes` | `text` |
| `dbspec.parse_set` | `owned: list<text>`, `external: list<text>` | `text` |
| `dbspec.manifest` | `documents: text` | `text` |
| `dbspec.emit` | `document: text` | `text` |
| `dbspec.render_statements` | `documents: text`, `dialect: text` | `text` |
| `dbspec.canonical_literal` | `type: text`, `literal: text` | `optional<text>` |
| `dbspec.runtime_model` | `documents: text` | `text` |
| `runtime_model.load` | `model: text` | `runtime_model` |
| `runtime_model.validate` | `request: text` | `none` |
| `runtime_model.param_uses` | `request: text` | `text` |
| `runtime_model.restore_key` | `request: text` | `text` |
| `runtime_model.compile` | `request: text`, `dialect: text` | `text` |
| `runtime_model.operator_allowed` | `entity: text`, `column: text`, `operator: text` | `bool` |
| `orm.value_function_unit` | `name: text` | `optional<text>` |
| `orm.ir_version` | none, a constant | `uint` |
| `codec.decode` | `stages: list<text>`, `cell: orm_value` | `orm_value` |
| `codec.host_encode` | `value: orm_value`, `stages: list<text>`, `key: text` | `orm_value` |
| `codec.host_decode` | `cell: orm_value`, `stages: list<text>`, `key: text` | `orm_value` |
| `codec.blind_index` | `value: orm_value`, `key: text` | `text` |
| `db.connect_schema` | `dsn: text`, `schema: schema`, `pool_size: uint`, `cfg: config` | `db` |
| `db.execute` | `step: text`, `params: list<orm_value>` | `none` |

## Values of dbspec

- **FMS-10** The root of `dbspec.schema.json` is one document, the value `polyspec_orm_schema::dbspec::Document` of
  `packages/rust/schema/src/dbspec/model.rs`: its name, whether it is external, its `use` lines, its tables and its
  diagrams, each with the comment lines that the text attaches to it. A table holds its columns, its primary key, its
  unique keys, indexes, foreign keys and checks, and its settings. A member is the field of the Rust value in snake
  case, except `type` (the field `ty`), `primary_key` (the field `primary`) and the forms of FMS-11 to FMS-13. The form
  carries the types `Document`, `Table`, `Column`, `ForeignKey` and `Check` of `engine/dbspec` with their fields, and
  `Use`, `Unique`, `PrimaryKey` and `Default` by their fields. The field `Null` of a column is `nullable`, a default is
  `{"kind": "now"}` or `{"kind": "literal", "text": <text>}`, and the constants `ActionCascade` and `ActionSetNull` are
  the texts `cascade` and `set_null` of `on_delete`. The core has no serde form of a document: a name of it holds the
  position of its token (`Name`), so the form is a view of the document without positions. Not implemented.
- **FMS-11** A column type is an object with `kind`, the name of the type (`Type::name`), and exactly the parameters
  of that kind: `length` for `varchar`, `precision` and `scale` for `decimal`, `precision` for `time` and `datetime`,
  and none for another kind (`#/$defs/type`). It carries `Type`, `TypeKind`, the four fields of `Type` and the 13
  constants `TypeI16` to `TypeDatetime`, whose texts are the kinds. The legacy value holds 0 for a parameter that its
  kind does not have; the form has no such member. Not implemented.
- **FMS-12** A check predicate is an object with `kind` (`#/$defs/expr`), one kind for each variant of `model::Expr`:
  `logic` with `op` (`and` or `or`), `left` and `right`, each a predicate; `compare` with `op` (`=`, `<>`, `<`, `<=`,
  `>` or `>=`), `left` and `right`, each an operand; `in` with `column`, `negated` and `list`, the literals in their
  canonical text; and `is_null` with `column` and `negated`. An operand is `{"kind": "column", "name": <name>}` or
  `{"kind": "literal", "text": <text>}`. The tree holds no parentheses. The form carries the interface `Expr` and the
  types `Binary` (the kinds `logic` and `compare`), `In`, `IsNull`, `ColumnRef` and `Literal` with their fields. The
  field `Operand` of `In` and of `IsNull` is `column`, because the core holds a column there. Not implemented.
- **FMS-13** The settings of a table are one object (`#/$defs/settings`) whose members are the variants of
  `model::Setting` in snake case: `entity`, `updated`, `soft_delete`, `select_explicit`, `codec`, `aes_version`,
  `blind_index`, `navigation`, `markdown`, `store`, `title`, `body`, `order`, `task_marker`, `immutable` and `audit`. A
  setting that names one column is `{"column": <column>}`; `codec`, `blind_index`, `navigation` and `markdown` are
  lists with one item for each line; `immutable` is an object that is present on an immutable table. An absent member
  is an absent setting, and a table without a settings block has no `settings`. Of the legacy names, `Marks` is
  `markdown`, `Codecs` is `codec`, and `BlindIndexes` is `blind_index` with `column` (`AESColumn`) and `index`
  (`IndexColumn`). The fields of `AuditSetting` are `into` (`History`), `column`, `references`, `action`, `previous`,
  `tables` with `table`, `record` and `name` (`Tables`, `TablesRecord` and `TablesName`), and `exclude` or `include`.
  Not implemented.
- **FMS-14** A document enters the core in the same form. A document that leaves the core and enters it again is the
  same document: `dbspec.emit` writes the same canonical text for both, and `dbspec.manifest` the same hashes. A
  document that enters has no position of a token, so a diagnostic of a member that takes documents has the line and
  the column that the core gives a set, and never those of a token. flowmark writes `name`, `external` and `tables` of
  a document, every member of a table but its comments, `name`, `type`, `nullable` and `identity` of a column and
  `columns` of a primary key; it only reads the other members. A text that is no document of the form is `config`,
  with a message that names the member. Not implemented.
- **FMS-15** A diagnostic is the value `dbspec::Diagnostic` (`#/$defs/diagnostic`), and a declaration position is the
  value `dbspec::Position` (`#/$defs/position`):
  `{"rule": <rule>, "line": <line>, "column": <column>, "message": <message>}` and
  `{"kind": <kind>, "path": [<name>, ...], "line": <line>, "column": <column>}`. The constants `PositionTable` and
  `PositionConstraint` are the kinds `table` and `constraint`. A member of `dbspec` that finds a diagnostic does not
  fail: its result is the object of its value or `{"diagnostics": [<diagnostic>, ...]}`. Not implemented.
- **FMS-16** The runtime model is `{"manifest_hash": <hash>, "entities": [<entity>, ...]}`
  (`#/$defs/runtime_model`), the value `polyspec_orm::Manifest` of `packages/rust/src/schema.rs`: the manifest hash
  that the requests of the model name, and the entities of `dbspec::RuntimeModel` in the order of the set. An entity
  holds `name`, `table`, `fields`, `primary_key`, `uniques`, `indexes`, `foreign_keys`, `immutable` and `external`, and
  `identity`, `updated`, `soft_delete`, `aes_version` and `audit` when the table has them. A field holds `name`, `type`
  (FMS-11), `nullable`, `identity`, `primary_key`, `foreign_key`, `select_explicit` and `codec`, and `default` and
  `blind_index` when the column has them. The form carries `Model`, `Entity` and `Field` of `engine/runtimemodel`:
  `Entities`, a map by name in the legacy module, is the list `entities`; `PK` is `primary_key`; `Null` is `nullable`;
  `Type`, `Length`, `Precision` and `Scale` of a field are its `type`; `Default`, a boolean in the legacy module, is
  the presence of `default`; and `ManifestText` is `manifest_text` of the manifest (FMS-23). The core has no serde form
  of the runtime model. Not implemented.

## Members of dbspec

- **FMS-20** `dbspec.read_set(path)` reads the set file at `path` and every file that it lists, as `dbspec::read_set`
  does (`packages/rust/schema/src/dbspec/set.rs`), and returns `{"documents": [<file>, ...], "external": [<file>, ...]}`
  or `{"errors": [<error>, ...]}` (`#/$defs/set_result`). A file is `{"path": <path>, "bytes": <base64>}`: its joined
  path, and its bytes in base64 with padding, which the member does not check. An error is
  `{"rule": <rule>, "path": <path>, "message": <message>}`. A path that is no Unicode text has no JSON text, so a set
  with such a joined path is `config`, with a message that names the set file. The member carries `ReadSet`, `Set`,
  `SetFile` and `SetError`. It refuses a set file of another name than `dbspec-set.json` (`set.file`). Not implemented.
- **FMS-21** `dbspec.read_bytes(name, bytes)` checks the bytes of a document file, as `dbspec::read_bytes` does, and
  returns `{"text": <text>}` or the diagnostic of the signature or of the encoding (`#/$defs/bytes_result`). `name` is
  the name that the message gives the file. flowmark passes the bytes of a file of FMS-20. The member carries
  `ReadBytes`. Not implemented.
- **FMS-22** `dbspec.parse_set(owned, external)` parses the texts of one set, as `dbspec::parse_set` does, and returns
  one object for each text, the owned texts first (`#/$defs/parse_set_result`): `name`, absent when the header fails;
  `external`; `document` (FMS-10), absent when the text has a diagnostic; `positions`; and `diagnostics`. The member
  carries `ParseSet` and `SetDocument`. `Parse` has no member: one test of flowmark parses each text of a set with the
  texts of the others, which is one call of this member with the texts as `owned`. Not implemented.
- **FMS-23** `dbspec.manifest(documents)` takes the documents of one set as a JSON list (`#/$defs/documents`) and
  returns `{"manifest": <manifest>}` or the diagnostics of the set (`#/$defs/manifest_result`), as `dbspec::manifest`
  does. The manifest holds `manifest_text`, `external_text`, `schema_text`, `manifest_hash` and `schema_hash`. The
  member carries `ManifestOf` and `Manifest.ManifestHash`. Not implemented.
- **FMS-24** `dbspec.emit(document)` returns the canonical text of one document, as `dbspec::emit` does. It carries
  `Emit`. Not implemented.
- **FMS-25** `dbspec.render_statements(documents, dialect)` returns the statements that create the tables of the set,
  in the order of `dbspec::render_statements`, as `{"statements": [{"sql": <sql>, "table": <table>}, ...]}`, or the
  diagnostics of the set (`#/$defs/statements_result`). `dialect` is `mysql`, `postgres` or `sqlite`, the texts of the
  constants `DialectMySQL`, `DialectPostgres` and `DialectSQLite`; another text is `config`. The member carries
  `RenderStatements`, `RenderedStatement` and the type `Dialect` of `engine/dbspec`. `Render` has no member: its result
  is `sql` of each statement. Not implemented: the core has no function that reads the name of a `dbspec::Dialect`.
- **FMS-26** `dbspec.canonical_literal(type, literal)` returns the canonical text of `literal` as the default of a
  column of the type, or nothing when `literal` is no literal of the type. `type` is the JSON text of a type (FMS-11).
  A literal is one token with no space around it: a number whose minus sign is attached, a word or a quoted string. A
  `text` or `bytes` column has no literal. The member carries `CanonicalLiteral`. Not implemented: the core holds the
  rule for a token that the parser has read (`default_literal` of `packages/rust/schema/src/dbspec/literal.rs`, private
  to its crate) and no function that reads a literal from a text.
- **FMS-27** `dbspec.runtime_model(documents)` returns `{"model": <model>}` (FMS-16) or the diagnostics of the set
  (`#/$defs/runtime_model_result`): the entities of `dbspec::runtime_model` and the manifest hash of `dbspec::manifest`
  of the same documents. The member carries `Build`; `runtime_model.load` makes the handle of the model (FMS-30). Not
  implemented.

## Runtime model and requests

- **FMS-30** `runtime_model` is a class of the contract whose value is a runtime model with its manifest hash,
  `polyspec_orm::Manifest`. A handle keeps the model in the core, so a member that reads the model takes no model
  text. `runtime_model.load(model)` makes the handle of a model text of FMS-16; a text that is no model of the form is
  `config`. The model need not be the model of a manifest text: flowmark changes a model that `dbspec.runtime_model`
  returned and loads the result, and it writes `manifest_hash`, the list `entities` and `external` of an entity. The
  class carries the pointer to a `Model` that the functions of the legacy module take. Not implemented.
- **FMS-31** A request is the JSON text of `ir.schema.json`: the serde form of `polyspec_orm::ir::Request`
  (`packages/rust/src/ir.rs`), which is the request of [protocol](protocol.md) section 1. The members of the query of
  a request are members of the request object; an item of a group is an object of exactly one of `pred`, `group` and
  `joined`; a limit is the pair `offset` and `count` or the pair `offset_p` and `count_p`, with both members. The form
  carries every type and field of `engine/ir`: a field has the member of its tag in the legacy module, so `IRVersion`
  is `ir_version`, `ForceIdx` is `force_index`, `NParams` is `n_params`, and `Query` of a request is no member.
  flowmark writes `ir_version`, `manifest_hash`, `kind`, `entity`, `where`, `order`, `load`, `set` and `n_params` of
  the requests that it makes, and `column`, `p` and `null` of an assignment; it only reads the other members. The
  schema states the text that the core writes. A member that takes a request reads an absent member of the form as its
  default, except a member of a limit, and refuses with `ir_invalid` a text that is no JSON object, a member that the
  form does not have and text after the object. The legacy module writes a literal limit without a member that is 0
  and reads `null` as an absent member; neither is a request of the form. Not implemented: the reader of
  `ir::Request` takes a member that the form does not have, and no function of the core reads a request from a text.
- **FMS-32** `runtime_model.validate(request)` validates the request against the model, as
  `polyspec_orm::engine::validate` does, and returns nothing. A request that the validation refuses fails with the
  kind of its cause, such as `ir_invalid`, `version_mismatch`, `schema_hash_mismatch`, `column_unknown` or
  `operator_not_allowed`. The member carries `Validate`. `Decode` has no member: flowmark reads the request text into
  structs of its own and passes this member the text that it writes from them in the form of FMS-31. Not implemented.
- **FMS-33** `runtime_model.param_uses(request)` returns the slots of each parameter of a validated request, in the
  order of the parameters (`#/$defs/param_uses` of `ir.schema.json`). A slot with no column is `{"type": <type>}`; a
  slot of a column also has `column`, `length`, `null`, `precision` and `scale` of the column, and `"assign": true` for
  an assignment. This is the form that `polyspec_orm::testing::param_uses` writes (`packages/rust/src/testing.rs`).
  The member carries `ParamUses` and `ParamUse`, whose `Column`, a pointer to a field in the legacy module, is the
  name and the sizes of the column. Not implemented: the core builds `param_uses` only with the feature `test-faults`.
- **FMS-34** `runtime_model.restore_key(request)` picks the key of a restore request ([protocol](protocol.md) section
  1.5) and returns its parts (`#/$defs/restore_parts`):
  `{"key": [<column>, ...], "where": <group>, "set": [<assign>, ...], "soft_delete": <column>}`. The entity is the
  entity of the request; an entity that the model does not have is `entity_unknown`. The member carries `RestoreKey`
  and `RestoreParts`. Not implemented: `restore_key` and `RestoreParts` of `packages/rust/src/engine/validate.rs` are
  private to the crate, and `RestoreParts` has no serde form.
- **FMS-35** `runtime_model.operator_allowed(entity, column, operator)` returns whether a condition of the operator on
  the column is allowed, as the validation decides (`op_allowed` of `packages/rust/src/engine/validate.rs`, which calls
  `dbspec::operator_allowed_for_field`). An entity that the model does not have is `entity_unknown`, and a column that
  the entity does not have is `column_unknown`. The member carries `OpAllowed`, which takes a pointer to a field in the
  legacy module. Not implemented.
- **FMS-36** `orm.ir_version` is the constant 1, the version of the request form that the core validates; it carries
  the constant `Version` of `engine/ir`. `orm.value_function_unit(name)` returns the unit of the interval of a
  relative value function, `second`, `minute`, `hour`, `day` or `month`, or nothing for another name; it carries the
  variable `ValueFunctionUnits` of `engine/dialect`, a map that flowmark reads by name. Not implemented: the constant
  `IR_VERSION` of `packages/rust/src/engine/validate.rs` is private, and the function `value_function_unit` of
  `packages/rust/src/engine/dialect.rs` is in a module that is private to the crate.
- **FMS-37** A member fails with an error of the class of its category, which has a kind (CORE-10, CORE-11) and the
  message `<kind>: <text>` (CORE-12). The error carries the type `Error` of `engine/ir`: `Code` is the kind, in lower
  case, and `Msg` is the text after the kind. No member returns an error as JSON.

## Plans and the database

- **FMS-40** A plan is the JSON text of `plan.schema.json`: the plan of [protocol](protocol.md) section 2, whose
  members are the tags of `legacy/packages/go/engine/plan/plan.go`. A list that the form always writes (`steps`,
  `tables`, `bind_slots`, `columns`, `key` and `keys`) is a list and never `null`. The value of the core,
  `polyspec_orm::plan::Plan` of `packages/rust/src/plan.rs`, has no serde form; its field `typ` of an output column is
  the member `type`, and its field `plan_id` of a step is no member. flowmark reads `steps` of a plan, `sql` and
  `bind_slots` of a step and `col_type` of a slot. Not implemented.
- **FMS-41** `runtime_model.compile(request, dialect)` validates the request and plans it for the dialect, as
  `polyspec_orm::engine::compile` does, and returns the plan (FMS-40). `dialect` is `mysql`, `postgres` or `sqlite`
  (`Dialect::parse`); another text is `config`. The member carries `Planner.Compile`. The struct `Planner` with its
  fields `M` and `D` is the handle and the argument `dialect`, and the interface `Dialect` of `engine/dialect` with its
  implementations `MySQL`, `Postgres` and `SQLite` is the text of the dialect. `Compile` of the legacy module plans
  without validating; this member validates first. Not implemented.
- **FMS-42** `db.execute(step, params)` runs one statement of a plan that reads no rows, as `Db::execute` does
  (`packages/rust/src/db.rs`). `step` is the JSON text of a step (`#/$defs/step` of `plan.schema.json`), and `params`
  are the parameters of the request as `orm_value` (CORE-62). A text that is no step of the form is `config`, and a
  list, a map or a JSON value among `params` is `codec_encode`. flowmark writes `role`, `sql` and `bind_slots` of the
  step and `from`, `name`, `param` and `host_styles` of a slot; it gives `id` the value 0 and `tables` no item, as the
  value of the legacy module has them. One test of flowmark calls the member. It carries `DB.Execute` of `orm`, and
  `Step` and `BindSlot` of `engine/plan`. Not implemented: `Db::execute` takes the Rust values `Step` and `Param`, so
  CORE-70 does not declare it.
- **FMS-43** `db.connect_schema(dsn, schema, pool_size, cfg)` connects and registers the set of `schema` on the
  connection, as `Db::connect_schema` does; every type of its signature is a type of the contract. It carries
  `ConnectSchema`. The struct `Schema` of the legacy module with its fields `Hash` and `Text` is the class `schema`,
  which `schema.load(manifest_text, external_text, manifest_hash)` makes from the same texts. `Config` is the record
  `config`, `DB` is the class `db`, and `DB.Close` is the member `db.close`. Not implemented: the contract does not
  declare `db.connect_schema`.

## Codec

- **FMS-50** The unit `codec` has four members whose values are `orm_value` (CORE-62). `codec.decode(stages, cell)`
  decodes a stored cell through its codec stages, as `codec::decode` does. `codec.host_encode(value, stages, key)`
  applies the host stages `aes`, `hex` and `ip` to a value in write order, as `codec::host_encode` does.
  `codec.host_decode(cell, stages, key)` undoes them, as `codec::host_decode` does. `codec.blind_index(value, key)`
  returns the blind index of a value, as `codec::blind_index` does. A value and a cell are `text`, `bytes` or `null`;
  another kind is `codec_encode` for a value and `codec_decode` for a cell. The members carry `HostEncode`,
  `HostDecode`, `Decode` and `BlindIndex` of the package `orm`. Not implemented: the four functions of
  `packages/rust/src/codec.rs` take and return the Rust values `Param` and `Val`, which are no types of the contract.
- **FMS-51** `NewAESKeyring` is the member `aes_keyring.constructor(keys, current)` of the contract. flowmark calls it
  to judge the keys of a keyring file and keeps no keyring.

## What does not cross as JSON

- **FMS-60** Seven values of the legacy module are no data, and each has another carrier.
  1. The database handle `*orm.DB` is open connections: the class `db` of the contract.
  2. The runtime model that a function takes by pointer, and the `Planner` that holds it, are the class
     `runtime_model` (FMS-30), so that the core does not read a model from its text for every request.
  3. A pointer into a model is a name: the entity of the request for `RestoreKey`, the names of the entity and of the
     column for `OpAllowed`, and the name of the column with its sizes for `ParamUse.Column`.
  4. A dialect value, the interface `Dialect` of `engine/dialect` with its three types, is the name of the
     dialect.
  5. A check predicate, the interface `Expr` that flowmark reads by a type switch, is an object with `kind`
     (FMS-12).
  6. An error that flowmark reads with `errors.As` is the error of the binding (FMS-37).
  7. The map `ValueFunctionUnits`, a variable of a package, is the function `orm.value_function_unit` (FMS-36).
- **FMS-61** Bytes do not cross inside a JSON text as they are: the bytes of a listed file are base64 (FMS-20), and a
  joined path that is no Unicode text is refused.
- **FMS-62** flowmark v0.0.15 passes no function to orm and holds no subscription, transaction, cancellation or
  request hook of orm. No member of this document calls language code, so none is a state machine (CORE-27). The only
  value of orm that flowmark holds open is the database handle of one test.
- **FMS-63** The position of a token stays in the core. The form of a document holds none (FMS-14), and `positions`
  of `dbspec.parse_set` holds the declarations.

## Names of the legacy module in the core

- **FMS-70** Of the 317 names, 5 are units or members of the contract (`orm.DB`, `DB.Close`, `orm.Config`,
  `orm.Schema` and `orm.NewAESKeyring`), 255 have an item of the same name in the core, and 57 have none. None of the
  57 is absent from the core: 52 are a public item of another name, the rows of the first table, and 5 are held by an
  item that is not public or has another form, the rows of the second table. The files of both tables are under
  `packages/rust`.

| Names of the legacy module | Item of the core | File |
| --- | --- | --- |
| `DialectMySQL` | `dbspec::Dialect::MySql` | `schema/src/dbspec/render.rs` |
| `TypeDatetime` | `Type::DateTime` | `schema/src/dbspec/model.rs` |
| `TypeKind` | `Type` and `Type::name` | `schema/src/dbspec/model.rs` |
| `AuditSetting` and its 7 fields | `Setting::Audit` and `AuditTables` | `schema/src/dbspec/model.rs` |
| `AuditSetting.Records` | `Setting::records` | `schema/src/dbspec/model.rs` |
| `Binary` and its 3 fields | `Expr::Logic` and `Expr::Compare` | `schema/src/dbspec/model.rs` |
| `In` and its 3 fields | `Expr::In` | `schema/src/dbspec/model.rs` |
| `IsNull` and its 2 fields | `Expr::IsNull` | `schema/src/dbspec/model.rs` |
| `ColumnRef` and `ColumnRef.Name` | `Operand::Column` | `schema/src/dbspec/model.rs` |
| `Default.Now` and `Default.Literal` | `DefaultValue::Now` and `DefaultValue::Literal` | `schema/src/dbspec/model.rs` |
| `ColumnSetting.Column` | the name of a setting of one column, as `Setting::Updated` | `schema/src/dbspec/model.rs` |
| `Settings.Title`, `Settings.TaskMarker` | `Setting::Title`, `Setting::TaskMarker` | `schema/src/dbspec/model.rs` |
| `Settings.Codecs`, the 2 fields of `CodecSetting` | `Setting::Codec` | `schema/src/dbspec/model.rs` |
| `Settings.BlindIndexes`, the 2 fields of `BlindIndexSetting` | `Setting::BlindIndex` | `schema/src/dbspec/model.rs` |
| `MarkSetting.Column` | `Setting::Markdown` | `schema/src/dbspec/model.rs` |
| the 4 fields of `StoreSetting` | `Setting::Store` | `schema/src/dbspec/model.rs` |
| `ManifestOf` | `dbspec::manifest` | `schema/src/dbspec/mod.rs` |
| `MySQL`, `Postgres`, `SQLite` of `engine/dialect` | the variants of `engine::Dialect` | `src/engine/dialect.rs` |
| `Query.ForceIdx` and `Query.Where` | `ir::Query::force_index` and `ir::Query::where_` | `src/ir.rs` |
| `Entity.PK` | `Entity::primary_key` | `schema/src/dbspec/runtime.rs` |
| `Model.Entities` | `RuntimeModel::entities` | `schema/src/dbspec/runtime.rs` |
| `Model.ManifestHash` | `Manifest::manifest_hash` | `src/schema.rs` |
| `Model.ManifestText` | `dbspec::Manifest::manifest_text` | `schema/src/dbspec/mod.rs` |
| `DB.Execute` | `Db::execute` | `src/db.rs` |

| Name of the legacy module | Item of the core | File | What the member needs |
| --- | --- | --- | --- |
| `CanonicalLiteral` | `default_literal`, for a token | `schema/src/dbspec/literal.rs` | a function that reads a text |
| `ValueFunctionUnits` | `value_function_unit` | `src/engine/dialect.rs` | an export from `engine` |
| `Version` of `engine/ir` | `IR_VERSION` | `src/engine/validate.rs` | a public constant |
| `RestoreParts.Where` | `RestoreParts::where_` | `src/engine/validate.rs` | a public result (FMS-34) |
| `DiagnosticsError` | `diagnostics`, which returns an error | `src/schema.rs` | nothing (FMS-6) |

- **FMS-71** An item of the same name is not always the same thing. `ir.Decode` has the name of `codec::decode`, and
  the core has no function that reads a request (FMS-31). `runtimemodel.Build` has the name of `request::build`, which
  builds a request; the model is built by `dbspec::runtime_model`. `ir.ParamUses` is built only with `test-faults`
  (FMS-33). `ir.RestoreKey`, `ir.OpAllowed` and `planner.Planner` are `restore_key`, `op_allowed` and `Planner`, each
  private to the crate. `PositionTable` and `PositionConstraint` are the texts `table` and `constraint` of the parser,
  which has no constant for them. `Type.String` is `Type::render`.

## Order of the work

- **FMS-80** The functions of the core that the members name need no binding, so they are written and tested before
  the contract changes. They are the signatures below; a function of the crate `polyspec-orm-schema` reports a value
  that is not of its form as a text that names the member, and a function of the crate `polyspec-orm` as `config`, or
  as `ir_invalid` for a request. Not implemented.

```rust
// packages/rust/schema/src/dbspec/literal.rs, exported from dbspec
pub fn canonical_literal(ty: Type, text: &str) -> Option<String>;

// packages/rust/schema/src/dbspec/json.rs, the module dbspec::json
pub fn type_to_json(ty: Type) -> serde_json::Value;
pub fn type_from_json(value: &serde_json::Value) -> Result<Type, String>;
pub fn document_to_json(document: &Document) -> serde_json::Value;
pub fn document_from_json(value: &serde_json::Value) -> Result<Document, String>;
pub fn runtime_model_to_json(model: &RuntimeModel) -> serde_json::Value;
pub fn runtime_model_from_json(value: &serde_json::Value) -> Result<RuntimeModel, String>;
pub fn diagnostic_to_json(diagnostic: &Diagnostic) -> serde_json::Value;
pub fn position_to_json(position: &Position) -> serde_json::Value;

// packages/rust/src/dbspec_json.rs, the module polyspec_orm::dbspec_json: the functions of the unit dbspec
pub fn read_set(path: &std::path::Path) -> crate::Result<String>;
pub fn read_bytes(name: &str, bytes: &[u8]) -> String;
pub fn parse_set(owned: &[String], external: &[String]) -> String;
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

- **FMS-81** Each function of FMS-80 has a test that fails before the function exists. Not implemented.
  1. A document: for every document of `contracts/fixtures/bench/`, `document_to_json` is a value of
     `dbspec.schema.json`, and `document_from_json` of it gives a document with the same text of `dbspec::emit`, the
     same hashes of `dbspec::manifest` and the same statements of `dbspec::render_statements` in the three dialects.
  2. A refused document: a member that the schema does not name, a `varchar` type without `length` and a predicate
     without `kind` are each an error that names the member.
  3. A runtime model: `runtime_model_from_json(runtime_model_to_json(model))` equals `model`, and the value is a value
     of `#/$defs/runtime_model` with a manifest hash.
  4. A literal: `canonical_literal` gives the result of each case of `TestCanonicalLiteral` of
     `legacy/packages/go/engine/dbspec/literal_test.go`.
  5. A set: `dbspec_json::parse_set` gives, for the texts of each case of `tests/dbspec/set-parse.json`, the names,
     the diagnostics and the documents of `dbspec::parse_set`, as a value of `#/$defs/parse_set_result`; `read_bytes`
     gives the `signature` and the `encoding` diagnostic; `read_set` gives the files and the errors of
     `dbspec::read_set` for a set in a temporary directory.
  6. A request: `Request::from_json` refuses a member that the form does not have and text after the object with
     `ir_invalid`, and the serde text of each request of `tests/planner/compile.json` and of `tests/ir/validate.json`
     is a value of `ir.schema.json` that `Request::from_json` reads back to the same serde text.
  7. A model handle: for the serde text of each request of the `planner.compile` and `ir.param_uses` cases of
     `tests/planner/compile.json`, `Manifest::compile` gives the plan of `engine::compile` as `Plan::to_json` writes
     it, a value of `plan.schema.json`, and `Manifest::param_uses` the value of `testing::param_uses`;
     `Manifest::restore_key` gives the key, the where and the set of `restore_key` for the restore cases; and for
     each request of `tests/ir/validate.json`, `Manifest::validate` gives the result of `engine::validate`.
  8. A step: `Step::from_json(step.to_json())` gives a step with the fields of `step` but `plan_id`, which is 0.
  9. A cell: `host_decode(host_encode(value))` gives `value` for a text and for bytes through `hex`, `ip` and `aes`,
     `blind_index` gives the index of `codec::blind_index`, and a list is `codec_encode`.
  10. A statement: `Db::execute_text` inserts a row on a SQLite database with a step that `Manifest::compile` wrote.
- **FMS-82** The declarations of the units and members of FMS-7 in `packages/rust/interface.json`, their cases in
  `contracts/interface/core.json` (CORE-71), the generated bindings and the Go code of flowmark follow the functions of
  FMS-80. The schema tests of FMS-81 need a JSON Schema validator in the tests of `polyspec-orm`, which the tests of
  `polyspec-orm-schema` already have (`jsonschema`). Not implemented.
