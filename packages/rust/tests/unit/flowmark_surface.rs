// The JSON surface of the core (docs/spec/flowmark-surface.md FMS-20 to FMS-50): the functions of FMS-80 that need
// polyspec-orm, with the cases 5 to 10 of FMS-81. A JSON text is compared with its schema of
// contracts/interface/flowmark and with the value of the function of the core that it carries.

use std::collections::HashMap;

use base64::Engine as _;
use binding_core::Io;
use serde_json::{json, Value};

use super::{canonical_literal, emit, manifest, parse_set, read_bytes, read_set, render_statements, runtime_model};
use crate::dbspec::json::{diagnostic_to_json, document_to_json};
use crate::dbspec::{self, Document};
use crate::engine::{self, Dialect};
use crate::ir::Request;
use crate::or_panic::OrPanic;
use crate::orm_value::{blind_index, decode, host_decode, host_encode};
use crate::plan::Step;
use crate::schema::Manifest;
use crate::test_support::Scratch;
use crate::testing::ir_request::{repository, request, schema};
use crate::value::Param;
use crate::{Config, Connection, Db, Error, Kind, OrmValue, Query, Result, Schema};

const DBSPEC_SCHEMA: &str = include_str!("../../../../contracts/interface/flowmark/dbspec.schema.json");
const IR_SCHEMA: &str = include_str!("../../../../contracts/interface/flowmark/ir.schema.json");
const PLAN_SCHEMA: &str = include_str!("../../../../contracts/interface/flowmark/plan.schema.json");

/// The names of the dialects with their values.
const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

/// What the form of the schema text `schema` refuses in `value`: its root form, or the form `#/$defs/<definition>`. One
/// line for each problem, none for a value of the form.
fn refusals(schema: &str, definition: Option<&str>, value: &Value) -> Vec<String> {
    let schema: Value = serde_json::from_str(schema).expect("a schema of contracts/interface/flowmark is JSON");
    let form = match definition {
        Some(definition) => json!({"$schema": schema["$schema"], "$ref": format!("#/$defs/{definition}"), "$defs": schema["$defs"]}),
        None => schema,
    };
    let validator = jsonschema::validator_for(&form).expect("the form is a JSON Schema");
    validator.iter_errors(value).map(|error| format!("{}: {error}", error.instance_path())).collect()
}

fn no_refusal() -> Vec<String> {
    Vec::new()
}

/// The JSON value of a text that a function of the surface returned.
fn parsed(text: &str) -> Value {
    serde_json::from_str(text).or_panic(|error| format!("the text {text} is no JSON: {error}"))
}

/// The failure of `result`, which `what` names.
fn failure<T>(result: Result<T>, what: &str) -> Error {
    match result {
        Ok(_) => panic!("{what} did not fail"),
        Err(error) => error,
    }
}

/// The vector file at the repository path `at`.
fn vectors(at: &str) -> Value {
    let path = repository().join(at);
    let text = std::fs::read_to_string(&path).or_panic(|error| format!("{}: {error}", path.display()));
    serde_json::from_str(&text).or_panic(|error| format!("{}: {error}", path.display()))
}

/// The steps of the vector file `vectors`, each with the id of its case.
fn steps(vectors: &Value) -> Vec<(&str, &Value)> {
    let cases = vectors["cases"].as_array().expect("a vector file holds cases");
    cases
        .iter()
        .flat_map(|case| {
            let id = case["id"].as_str().expect("a case has an id");
            case["steps"].as_array().expect("a case holds steps").iter().map(move |step| (id, step))
        })
        .collect()
}

/// The manifests of the schemas that the steps of tests/planner/compile.json name, by the name that a step gives.
struct Manifests(HashMap<String, Manifest>);

impl Manifests {
    fn of(&mut self, step: &Value) -> &Manifest {
        let name = step["schema"].as_str().expect("a step names its schema");
        self.0.entry(name.to_owned()).or_insert_with(|| schema(&format!("tests/planner/{name}")))
    }
}

/// The request of a compile step, as the value of the core and as its serde text.
fn compile_request(step: &Value, manifest: &Manifest) -> (Request, String) {
    let typed = request(&step["input"], &manifest.manifest_hash);
    let text = serde_json::to_string(&typed).expect("a request has a serde text");
    (typed, text)
}

/// The texts of the bench set, the owned texts and the external texts.
fn bench_texts() -> (Vec<String>, Vec<String>) {
    let read = |name: &str| {
        let path = repository().join("contracts/fixtures/bench").join(name);
        std::fs::read_to_string(&path).or_panic(|error| format!("{}: {error}", path.display()))
    };
    (vec![read("bench.dbs"), read("bench_reader.dbs")], vec![read("bench_shared.dbs")])
}

/// The documents of the bench set, and the JSON list of their forms.
fn bench_documents() -> (Vec<Document>, String) {
    let (owned, external) = bench_texts();
    let owned: Vec<&str> = owned.iter().map(String::as_str).collect();
    let external: Vec<&str> = external.iter().map(String::as_str).collect();
    let documents: Vec<Document> = dbspec::parse_set(&owned, &external)
        .into_iter()
        .map(|text| text.document.unwrap_or_else(|| panic!("a document of contracts/fixtures/bench does not parse: {:?}", text.diagnostics)))
        .collect();
    let forms: Vec<Value> = documents.iter().map(|document| document_to_json(document).expect("a parsed document has a form")).collect();
    (documents, Value::Array(forms).to_string())
}

// Requirements: FMS-22, FMS-81. parse_set gives, for the texts of each case of tests/dbspec/set-parse.json, the names,
// the diagnostics and the documents of dbspec::parse_set as a value of the form of its result.
#[test]
fn parse_set_gives_the_result_of_each_text_of_a_set() {
    let _case = polyspec_orm_testcase::case!();
    let vectors = vectors("tests/dbspec/set-parse.json");
    let texts = |step: &Value, key: &str| -> Vec<String> {
        match step.get(key) {
            Some(list) => list.as_array().expect("the texts of a step are a list").iter().map(|text| text.as_str().expect("a text").to_owned()).collect(),
            None => Vec::new(),
        }
    };
    let mut compared = 0;
    for (id, step) in steps(&vectors) {
        let (owned, external) = (texts(step, "owned"), texts(step, "external"));
        let got = parsed(&parse_set(&owned, &external).or_panic(|error| format!("{id}: {error}")));
        assert_eq!(refusals(DBSPEC_SCHEMA, Some("parse_set_result"), &got), no_refusal(), "{id}");
        let owned: Vec<&str> = owned.iter().map(String::as_str).collect();
        let external: Vec<&str> = external.iter().map(String::as_str).collect();
        let want = dbspec::parse_set(&owned, &external);
        let got = got.as_array().expect("the result is a list");
        assert_eq!(got.len(), want.len(), "{id}");
        for (got, want) in got.iter().zip(&want) {
            assert_eq!(got.get("name").and_then(Value::as_str), want.name.as_deref(), "{id}");
            assert_eq!(got["external"], want.external, "{id}");
            assert_eq!(got["diagnostics"], Value::Array(want.diagnostics.iter().map(diagnostic_to_json).collect()), "{id}");
            assert_eq!(got["positions"].as_array().map(Vec::len), Some(want.positions.len()), "{id}");
            let document = want.document.as_ref().map(|document| document_to_json(document).expect("a parsed document has a form"));
            assert_eq!(got.get("document"), document.as_ref(), "{id}");
            compared += 1;
        }
    }
    assert!(compared > 0, "tests/dbspec/set-parse.json holds no text");
}

// Requirements: FMS-21, FMS-81. read_bytes gives the text of the bytes of a document file, or the diagnostic of the
// signature or of the encoding.
#[test]
fn read_bytes_gives_the_text_or_the_diagnostic_of_the_bytes() {
    let _case = polyspec_orm_testcase::case!();
    let text = parsed(&read_bytes("a.dbs", b"dbspec 1 a\n"));
    assert_eq!(text, json!({"text": "dbspec 1 a\n"}));
    let signature = parsed(&read_bytes("a.dbs", b"table a {\n}\n"));
    assert_eq!(signature, json!({"diagnostics": [{"rule": "signature", "line": 1, "column": 1, "message": "a.dbs is not a dbspec document"}]}));
    let encoding = parsed(&read_bytes("a.dbs", b"dbspec 1 a\n\xff"));
    assert_eq!(encoding, json!({"diagnostics": [{"rule": "encoding", "line": 2, "column": 1, "message": "a.dbs is not valid UTF-8"}]}));
    for result in [&text, &signature, &encoding] {
        assert_eq!(refusals(DBSPEC_SCHEMA, Some("bytes_result"), result), no_refusal(), "{result}");
    }
}

// Requirements: FMS-20, FMS-61, FMS-81. read_set gives the files of a set in a temporary directory with their bytes in
// base64, and the errors of a set file that dbspec::read_set refuses.
#[test]
fn read_set_gives_the_files_or_the_errors_of_a_set() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-flowmark-read-set");
    for name in ["dbspec-set.json", "bench.dbs", "bench_reader.dbs", "bench_shared.dbs"] {
        let from = repository().join("contracts/fixtures/bench").join(name);
        std::fs::copy(&from, scratch.join(name)).or_panic(|error| format!("copy {}: {error}", from.display()));
    }
    let path = scratch.join("dbspec-set.json");
    let got = parsed(&read_set(Io::for_generated_call(), &path).expect("the paths of the set are Unicode texts"));
    assert_eq!(refusals(DBSPEC_SCHEMA, Some("set_result"), &got), no_refusal());
    let want = dbspec::read_set(&path).or_panic(|errors| format!("the bench set is refused: {errors:?}"));
    for (list, files) in [("documents", &want.documents), ("external", &want.external)] {
        let got = got[list].as_array().expect("the files of a list");
        assert_eq!(got.len(), files.len(), "{list}");
        assert!(!files.is_empty(), "the bench set lists a file in {list}");
        for (got, file) in got.iter().zip(files) {
            assert_eq!(got["path"].as_str(), file.path.to_str(), "{list}");
            let bytes = base64::engine::general_purpose::STANDARD.decode(got["bytes"].as_str().expect("the bytes are a text"));
            assert_eq!(bytes.expect("the bytes are base64 with padding"), file.bytes, "{list}");
        }
    }

    let other = scratch.join("other.json");
    std::fs::copy(&path, &other).expect("copy the set file");
    let got = parsed(&read_set(Io::for_generated_call(), &other).expect("the path of the set file is a Unicode text"));
    assert_eq!(refusals(DBSPEC_SCHEMA, Some("set_result"), &got), no_refusal());
    let want = dbspec::read_set(&other).expect_err("a set file of another name is refused");
    let errors: Vec<Value> =
        want.iter().map(|error| json!({"rule": error.rule, "path": error.path.to_str().expect("a Unicode path"), "message": error.message})).collect();
    assert_eq!(got, json!({"errors": errors}));
    assert_eq!(got["errors"][0]["rule"], dbspec::RULE_SET_FILE);
}

// Requirements: FMS-14, FMS-23, FMS-24, FMS-25, FMS-26, FMS-27. The functions that take documents give the manifest,
// the canonical text, the statements and the runtime model of dbspec for the documents of the bench set, the
// diagnostics of a set that is no set, and config for a text that is not of its form.
#[test]
fn the_functions_of_documents_give_the_values_of_dbspec() {
    let _case = polyspec_orm_testcase::case!();
    let (documents, list) = bench_documents();
    let set: Vec<&Document> = documents.iter().collect();

    let want = dbspec::manifest(&set).expect("the bench set has a manifest");
    let got = parsed(&manifest(&list).expect("manifest"));
    assert_eq!(refusals(DBSPEC_SCHEMA, Some("manifest_result"), &got), no_refusal());
    assert_eq!(
        got,
        json!({"manifest": {
            "manifest_text": want.manifest_text,
            "external_text": want.external_text,
            "schema_text": want.schema_text,
            "manifest_hash": want.manifest_hash,
            "schema_hash": want.schema_hash,
        }})
    );

    let first = document_to_json(&documents[0]).expect("a parsed document has a form").to_string();
    assert_eq!(emit(&first).expect("emit"), dbspec::emit(&documents[0]));

    for (name, dialect) in [("mysql", dbspec::Dialect::MySql), ("postgres", dbspec::Dialect::Postgres), ("sqlite", dbspec::Dialect::Sqlite)] {
        let got = parsed(&render_statements(&list, name).or_panic(|error| format!("{name}: {error}")));
        assert_eq!(refusals(DBSPEC_SCHEMA, Some("statements_result"), &got), no_refusal(), "{name}");
        let want = dbspec::render_statements(&set, dialect).expect("the bench set has statements");
        assert!(!want.is_empty(), "{name}");
        let want: Vec<Value> = want.iter().map(|statement| json!({"sql": statement.sql, "table": statement.table})).collect();
        assert_eq!(got, json!({"statements": want}), "{name}");
    }
    assert_eq!(failure(render_statements(&list, "oracle"), "a dialect that the core does not have").kind(), Kind::Config);

    let got = parsed(&runtime_model(&list).expect("runtime_model"));
    assert_eq!(refusals(DBSPEC_SCHEMA, Some("runtime_model_result"), &got), no_refusal());
    let loaded = Manifest::from_json(&got["model"].to_string()).expect("the model of the result loads");
    assert_eq!(loaded.manifest_hash, want.manifest_hash);
    assert_eq!(loaded.model, dbspec::runtime_model(&set).expect("the bench set has a runtime model"));
    assert_eq!(loaded.to_json(), got["model"], "the form of the model that was read");
    assert_eq!(failure(Manifest::from_json(r#"{"entities": []}"#), "a model without its hash").text(), "model.manifest_hash is absent");
    assert_eq!(failure(Manifest::from_json("[]"), "a model that is no object").kind(), Kind::Config);

    // The reader document without the document that it uses is no set: the result is the diagnostic of the set.
    let alone = Value::Array(vec![document_to_json(&documents[1]).expect("a parsed document has a form")]).to_string();
    for got in [manifest(&alone), render_statements(&alone, "sqlite"), runtime_model(&alone)] {
        let got = parsed(&got.expect("a set that is no set is no failure"));
        assert_eq!(refusals(DBSPEC_SCHEMA, Some("diagnostics_result"), &got), no_refusal());
        assert_eq!(got["diagnostics"][0]["rule"], "use", "{got}");
    }

    assert_eq!(failure(manifest("{}"), "documents that are no list").text(), "documents is no list");
    assert_eq!(failure(emit("[]"), "a document that is no object").text(), "document is no object");
    let refused = failure(manifest(r#"[{"name": "a", "external": false, "uses": [], "tables": [], "owner": 1}]"#), "a member that the form does not have");
    assert_eq!((refused.kind(), refused.text()), (Kind::Config, "documents[0]: document.owner is no member of the form"));

    assert_eq!(canonical_literal(r#"{"kind": "decimal", "precision": 5, "scale": 2}"#, "-0.5").expect("a type"), Some("-0.50".to_owned()));
    assert_eq!(canonical_literal(r#"{"kind": "i16"}"#, "1.5").expect("a type"), None);
    assert_eq!(failure(canonical_literal(r#"{"kind": "money"}"#, "1"), "a type that dbspec does not have").kind(), Kind::Config);
}

// Requirements: FMS-31, FMS-81. Request::from_json refuses with ir_invalid a text that is no object, a member that the
// form does not have, a member that is null, an item of two members, a limit of one member and text after the object.
#[test]
fn a_text_that_is_no_request_of_the_form_is_ir_invalid() {
    let _case = polyspec_orm_testcase::case!();
    let read = Request::from_json(r#"{"ir_version": 1, "manifest_hash": "h", "kind": "all", "entity": "author", "n_params": 0}"#).expect("a request");
    assert_eq!((read.ir_version, read.kind.as_str(), read.query.entity.as_str()), (1, "all", "author"));
    assert!(Request::from_json("{}").is_ok(), "an absent member has its default");
    for (text, message) in [
        ("[]", "request is no object"),
        (r#"{"shape": 1}"#, "request.shape is no member of the form"),
        (r#"{"where": null}"#, "request.where is no object"),
        (r#"{"entity": null}"#, "request.entity is null; an absent member is its default"),
        (r#"{"group_by": ["a", null]}"#, "request.group_by[1] is null; an absent member is its default"),
        (r#"{"where": {"items": [{"pred": {"column": "a", "colour": 1}}]}}"#, "request.where.items[0].pred.colour is no member of the form"),
        (
            r#"{"where": {"items": [{"pred": {"column": "a"}, "group": {"items": []}}]}}"#,
            "request.where.items[0] holds 2 members; an item holds one of pred, group and joined",
        ),
        (r#"{"limit": {"offset": 0}}"#, "request.limit is neither the pair offset and count nor the pair offset_p and count_p"),
        (r#"{"limit": {"offset": 0, "count_p": 1}}"#, "request.limit is neither the pair offset and count nor the pair offset_p and count_p"),
        (r#"{"columns": {"sub": {"first": {"query": {"entity": "a", "size": 1}}}}}"#, "request.columns.sub.first.query.size is no member of the form"),
        (r#"{"joins": {}}"#, "request.joins is no list"),
    ] {
        let error = failure(Request::from_json(text), text);
        assert_eq!((error.kind(), error.text()), (Kind::IrInvalid, message), "{text}");
    }
    for text in [r#"{} {}"#, r#"{"n_params": 1.5}"#, r#"{"kind": 1}"#, "", "{"] {
        assert_eq!(failure(Request::from_json(text), text).kind(), Kind::IrInvalid, "{text}");
    }
    assert_eq!(crate::IR_VERSION, 1);
    assert_eq!(engine::value_function_unit("days_ago"), Some("day"));
    assert_eq!(engine::value_function_unit("now"), None);
}

// Requirements: FMS-31, FMS-81. The serde text of each request of tests/planner/compile.json is a value of the form,
// and Request::from_json reads it back to the same serde text.
#[test]
fn the_serde_text_of_a_request_is_read_back_to_the_same_text() {
    let _case = polyspec_orm_testcase::case!();
    let vectors = vectors("tests/planner/compile.json");
    let mut manifests = Manifests(HashMap::new());
    let mut requests = 0;
    for (id, step) in steps(&vectors) {
        let (_, text) = compile_request(step, manifests.of(step));
        assert_eq!(refusals(IR_SCHEMA, None, &parsed(&text)), no_refusal(), "{id}");
        let read = Request::from_json(&text).or_panic(|error| format!("{id}: {error}"));
        assert_eq!(serde_json::to_string(&read).expect("a request has a serde text"), text, "{id}");
        requests += 1;
    }
    assert!(requests > 0, "tests/planner/compile.json holds no request");
}

/// Compares the result of a function of the surface with the result of the function of the core that it carries: the
/// same value, or a failure of the same kind and message.
fn same<T>(id: &str, got: Result<String>, want: Result<T>, value: impl FnOnce(T) -> Value) -> Option<Value> {
    match (got, want) {
        (Ok(got), Ok(want)) => {
            let got = parsed(&got);
            assert_eq!(got, value(want), "{id}");
            Some(got)
        }
        (Err(got), Err(want)) => {
            assert_eq!((got.kind(), got.to_string()), (want.kind(), want.to_string()), "{id}");
            None
        }
        (Ok(got), Err(want)) => panic!("{id}: the text function gave {got}, the function of the core fails with {want}"),
        (Err(got), Ok(_)) => panic!("{id}: the text function fails with {got}, the function of the core does not"),
    }
}

// Requirements: FMS-33, FMS-34, FMS-40, FMS-41, FMS-81. For the serde text of each request of
// tests/planner/compile.json, Manifest::compile gives the plan of engine::compile as Plan::to_json writes it,
// Manifest::param_uses the uses of the validated request, and Manifest::restore_key the parts of restore_key.
#[test]
fn a_model_gives_the_plan_the_parameter_uses_and_the_restore_key_of_a_request_text() {
    let _case = polyspec_orm_testcase::case!();
    let vectors = vectors("tests/planner/compile.json");
    let mut manifests = Manifests(HashMap::new());
    let (mut plans, mut uses, mut restores) = (0, 0, 0);
    for (id, step) in steps(&vectors) {
        let manifest = manifests.of(step);
        let (typed, text) = compile_request(step, manifest);
        for (name, dialect) in DIALECTS {
            let want = engine::compile(manifest, dialect, &typed);
            if let Some(plan) = same(&format!("{id} {name}"), manifest.compile(&text, name), want, |plan| plan.to_json()) {
                assert_eq!(refusals(PLAN_SCHEMA, None, &plan), no_refusal(), "{id} {name}");
                plans += 1;
            }
        }
        if step["op"] == "ir.param_uses" {
            let want = engine::validate(manifest, &typed).and_then(|()| engine::param_uses_json(manifest, &typed));
            if let Some(slots) = same(id, manifest.param_uses(&text), want, |slots| slots) {
                assert_eq!(refusals(IR_SCHEMA, Some("param_uses"), &slots), no_refusal(), "{id}");
                uses += 1;
            }
        }
        if typed.kind == "restore" {
            let want = manifest.entity(&typed.query.entity).and_then(|entity| engine::validate::restore_key(entity, &typed));
            let parts = same(id, manifest.restore_key(&text), want, |parts| {
                json!({
                    "key": parts.key,
                    "where": serde_json::to_value(&parts.where_).expect("a group has a serde form"),
                    "set": serde_json::to_value(&parts.set).expect("an assignment has a serde form"),
                    "soft_delete": parts.soft_delete,
                })
            });
            if let Some(parts) = parts {
                assert_eq!(refusals(IR_SCHEMA, Some("restore_parts"), &parts), no_refusal(), "{id}");
                restores += 1;
            }
        }
    }
    assert!(plans > 0 && uses > 0 && restores > 0, "tests/planner/compile.json gave {plans} plans, {uses} parameter uses and {restores} restore keys");
    let bench = schema("contracts/fixtures/bench/bench.dbs");
    assert_eq!(failure(bench.compile("{}", "oracle"), "a dialect that the core does not have").kind(), Kind::Config);
}

/// Whether `value` holds null at any depth.
fn holds_null(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Array(items) => items.iter().any(holds_null),
        Value::Object(members) => members.values().any(holds_null),
        _ => false,
    }
}

// Requirements: FMS-31, FMS-32, FMS-35, FMS-81. For the JSON text of each request of tests/ir/validate.json,
// Manifest::validate gives the result that the case states; a request that holds null is no request of the form.
#[test]
fn a_model_validates_a_request_text_as_the_validation_does() {
    let _case = polyspec_orm_testcase::case!();
    let vectors = vectors("tests/ir/validate.json");
    let manifest = schema(&format!("tests/ir/{}", vectors["schema"].as_str().expect("the vector file names its schema")));
    let mut validated = 0;
    for (id, step) in steps(&vectors) {
        let mut request = step["request"].clone();
        if let Value::Object(members) = &mut request {
            let hash = step.get("manifest_hash").and_then(Value::as_str).unwrap_or(&manifest.manifest_hash);
            members.insert("manifest_hash".into(), Value::from(hash));
        }
        let got = manifest.validate(&request.to_string());
        if holds_null(&request) {
            assert_eq!(failure(got, id).kind(), Kind::IrInvalid, "{id}: a request that holds null is no request of the form");
            continue;
        }
        let want = &step["expect"]["none"];
        match (want.get("error").and_then(Value::as_str), got) {
            (None, Ok(())) => {}
            (None, Err(error)) => panic!("{id}: the case is valid, the text is refused with {error}"),
            (Some(kind), Ok(())) => panic!("{id}: the case is {kind}, the text is accepted"),
            (Some(kind), Err(error)) => {
                assert_eq!(error.kind().as_str(), kind, "{id}: {error}");
                if let Some(message) = want.get("message").and_then(Value::as_str) {
                    assert_eq!(error.to_string(), message, "{id}");
                }
            }
        }
        validated += 1;
    }
    assert!(validated > 0, "tests/ir/validate.json holds no request");

    assert!(manifest.operator_allowed("author", "name", "contains").expect("a column of author"), "a varchar column takes contains");
    assert!(!manifest.operator_allowed("author", "seq", "contains").expect("a column of author"), "an integer column takes no contains");
    assert_eq!(failure(manifest.operator_allowed("nobody", "seq", "eq"), "an entity that the model does not have").kind(), Kind::EntityUnknown);
    assert_eq!(failure(manifest.operator_allowed("author", "nothing", "eq"), "a column that the entity does not have").kind(), Kind::ColumnUnknown);
    let newer = json!({"ir_version": 2, "manifest_hash": manifest.manifest_hash, "kind": "all", "entity": "author", "n_params": 0});
    assert_eq!(failure(manifest.validate(&newer.to_string()), "a request of another version").kind(), Kind::VersionMismatch);
}

// Requirements: FMS-40, FMS-42, FMS-81. Step::from_json of the form of a step gives a step with the fields of the step
// but plan_id, which is 0, and a value that is no step of the form is config.
#[test]
fn a_step_is_read_back_from_its_form_without_its_plan_id() {
    let _case = polyspec_orm_testcase::case!();
    let vectors = vectors("tests/planner/compile.json");
    let mut manifests = Manifests(HashMap::new());
    let mut read = 0;
    for (id, step) in steps(&vectors) {
        let manifest = manifests.of(step);
        let (typed, _) = compile_request(step, manifest);
        for (name, dialect) in DIALECTS {
            let Ok(plan) = engine::compile(manifest, dialect, &typed) else { continue };
            for planned in &plan.steps {
                let form = planned.to_json();
                assert_eq!(refusals(PLAN_SCHEMA, Some("step"), &form), no_refusal(), "{id} {name}");
                let back = Step::from_json(&form).or_panic(|error| format!("{id} {name}: {error}"));
                let want = Step { plan_id: 0, ..planned.clone() };
                assert_eq!(format!("{back:?}"), format!("{want:?}"), "{id} {name}");
                read += 1;
            }
        }
    }
    assert!(read > 0, "tests/planner/compile.json gave no step");

    let step = json!({"id": 0, "role": "main", "sql": "DELETE FROM a", "tables": [], "bind_slots": []});
    assert_eq!(Step::from_json(&step).expect("the step that flowmark writes").sql, "DELETE FROM a");
    let refused = |change: &dyn Fn(&mut Value)| {
        let mut step = step.clone();
        change(&mut step);
        let error = failure(Step::from_json(&step), "a value that is no step");
        assert_eq!(error.kind(), Kind::Config, "{error}");
        error.text().to_owned()
    };
    assert_eq!(refused(&|step| step["extra"] = json!(1)), "step.extra is no member of the form");
    assert_eq!(refused(&|step| drop(step.as_object_mut().expect("an object").remove("sql"))), "step.sql is absent");
    assert_eq!(refused(&|step| step["role"] = json!("other")), "step.role other is none of main, count, relation");
    assert_eq!(refused(&|step| step["bind_slots"] = json!([{"from": "param"}])), "step.bind_slots[0].param is absent");
    assert_eq!(failure(Step::from_json(&json!([])), "a list").text(), "step is no object");
}

// Requirements: FMS-50, FMS-81. host_decode of host_encode gives the value for a text and for bytes through hex, ip and
// aes, blind_index gives the index of codec::blind_index, decode gives the value of a stored cell, and a value that is
// neither a text nor bytes nor null is codec_encode, a cell codec_decode.
#[test]
fn the_codec_functions_take_and_give_orm_value() {
    let _case = polyspec_orm_testcase::case!();
    let stages = |names: &[&str]| -> Vec<String> { names.iter().map(|name| (*name).to_owned()).collect() };
    let text = |text: &str| OrmValue::Text(text.to_owned());
    for (value, names) in [
        (text("hello"), vec!["hex"]),
        (OrmValue::Bytes(vec![0, 159, 255]), vec!["hex"]),
        (text("192.0.2.1"), vec!["ip"]),
        (text("secret"), vec!["aes"]),
        (OrmValue::Bytes(vec![0, 159, 255]), vec!["aes"]),
        (text("secret"), vec!["aes", "hex"]),
    ] {
        let stages = stages(&names);
        let cell = host_encode(value.clone(), &stages, "key").or_panic(|error| format!("{names:?}: {error}"));
        assert_ne!(cell, value, "{names:?}");
        assert_eq!(host_decode(cell, &stages, "key").or_panic(|error| format!("{names:?}: {error}")), value, "{names:?}");
    }
    assert_eq!(host_encode(OrmValue::Null, &stages(&["hex"]), "").expect("null"), OrmValue::Null);
    assert_eq!(host_decode(OrmValue::Null, &stages(&["hex"]), "").expect("null"), OrmValue::Null);

    let want = crate::codec::blind_index(&Param::Str("a@x".into()), "key").expect("the index of the codec");
    assert_eq!(blind_index(text("a@x"), "key").expect("the index"), want);
    assert_eq!(blind_index(OrmValue::Bytes(b"a@x".to_vec()), "key").expect("the index"), want);

    assert_eq!(decode(&stages(&["base64"]), text("aGk=")).expect("base64"), text("hi"));
    match decode(&stages(&["json"]), text(r#"{"b":1,"a":[true,null]}"#)).expect("json") {
        OrmValue::Json(value) => assert_eq!(value.value().to_string(), r#"{"b":1,"a":[true,null]}"#),
        other => panic!("the stage json gave {other:?}"),
    }
    assert_eq!(decode(&stages(&["json"]), OrmValue::Null).expect("null"), OrmValue::Null);

    for refused in [OrmValue::List(Vec::new()), OrmValue::Int(1), OrmValue::Bool(true)] {
        assert_eq!(failure(host_encode(refused.clone(), &stages(&["hex"]), ""), "a value of another kind").kind(), Kind::CodecEncode, "{refused:?}");
        assert_eq!(failure(blind_index(refused.clone(), "key"), "a value of another kind").kind(), Kind::CodecEncode, "{refused:?}");
        assert_eq!(failure(host_decode(refused.clone(), &stages(&["hex"]), ""), "a cell of another kind").kind(), Kind::CodecDecode, "{refused:?}");
        assert_eq!(failure(decode(&stages(&["json"]), refused.clone()), "a cell of another kind").kind(), Kind::CodecDecode, "{refused:?}");
    }
}

// Requirements: FMS-41, FMS-42, FMS-81. Db::execute_text inserts a row on a SQLite database with a step that
// Manifest::compile wrote; a text that is no step is config, and a list among the parameters is codec_encode.
#[tokio::test]
async fn execute_text_runs_a_step_that_compile_wrote() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-flowmark-execute");
    let text = "dbspec 1 note\n\ntable note {\n  seq i64\n  label varchar(32)\n  primary key (seq)\n}\n";
    let document = dbspec::parse(text, &Default::default()).expect("the note document parses").document;
    let set = dbspec::manifest(&[&document]).expect("the note document has a manifest");
    let schema = Schema::load(&set.manifest_text, "", &set.manifest_hash).expect("the note schema loads");
    let model = Manifest::load(&set.manifest_text, &set.manifest_hash).expect("the note model loads");
    let db = Db::connect(&format!("sqlite://{}", scratch.join("note.sqlite").display()), 1, Config::default()).await.expect("connect");
    db.utils().schema().install(&schema).await.expect("install");

    let insert = json!({
        "ir_version": 1,
        "manifest_hash": set.manifest_hash,
        "kind": "insert",
        "entity": "note",
        "set": [{"column": "seq", "p": 0}, {"column": "label", "p": 1}],
        "n_params": 2,
    });
    let plan = parsed(&model.compile(&insert.to_string(), "sqlite").expect("compile"));
    let step = plan["steps"][0].to_string();
    db.execute_text(&step, vec![OrmValue::Int64(7), OrmValue::Text("seven".into())]).await.expect("execute");
    let mut query = Query::new(&schema, "note").expect("a query of note");
    query.connect(Connection::from(&db));
    let row = query.get().await.expect("get").expect("the row that the step inserted");
    assert_eq!(row.value("seq").expect("seq"), OrmValue::Int64(7));
    assert_eq!(row.value("label").expect("label"), OrmValue::Text("seven".into()));

    assert_eq!(failure(db.execute_text("{}", Vec::new()).await, "a text that is no step").kind(), Kind::Config);
    assert_eq!(failure(db.execute_text("step", Vec::new()).await, "a text that is no JSON").kind(), Kind::Config);
    let list = failure(db.execute_text(&step, vec![OrmValue::List(Vec::new()), OrmValue::Null]).await, "a list among the parameters");
    assert_eq!(list.kind(), Kind::CodecEncode, "{list}");
    assert_eq!(query.get_count().await.expect("count"), 1, "a refused call sends no statement");
    db.close().await;
}
