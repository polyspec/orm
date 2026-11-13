// The JSON forms of the dbspec values (docs/spec/flowmark-surface.md FMS-10 to FMS-16) and the literal of a text
// (FMS-26): the cases of FMS-81 that need no database and no value of polyspec-orm. A form is compared with its schema
// of contracts/interface/flowmark/dbspec.schema.json, and a value that is read from its form with the value that wrote
// it.

use std::collections::BTreeMap;

use polyspec_orm_testcase::OrPanic;
use serde_json::{json, Value};

use super::{
    diagnostic_to_json, document_from_json, document_to_json, position_to_json, runtime_model_from_json, runtime_model_to_json, type_from_json, type_to_json,
};
use crate::dbspec::{self, canonical_literal, Dialect, Document, Type};

const SCHEMA: &str = include_str!("../../../../../contracts/interface/flowmark/dbspec.schema.json");
const BENCH: &str = include_str!("../../../../../contracts/fixtures/bench/bench.dbs");
const BENCH_READER: &str = include_str!("../../../../../contracts/fixtures/bench/bench_reader.dbs");
const BENCH_SHARED: &str = include_str!("../../../../../contracts/fixtures/bench/bench_shared.dbs");
const CANONICAL: &str = include_str!("../../../../../tests/dbspec/canonical.json");

/// What the form `#/$defs/<definition>` of the schema refuses in `value`: one line for each problem, none for a value
/// of the form.
fn refusals(definition: &str, value: &Value) -> Vec<String> {
    let schema: Value = serde_json::from_str(SCHEMA).expect("dbspec.schema.json is JSON");
    let form = json!({"$schema": schema["$schema"], "$ref": format!("#/$defs/{definition}"), "$defs": schema["$defs"]});
    let validator = jsonschema::validator_for(&form).expect("the form is a JSON Schema");
    validator.iter_errors(value).map(|error| format!("{}: {error}", error.instance_path())).collect()
}

fn no_refusal() -> Vec<String> {
    Vec::new()
}

/// The documents of the bench set, the owned documents first.
fn bench_documents() -> Vec<Document> {
    dbspec::parse_set(&[BENCH, BENCH_READER], &[BENCH_SHARED])
        .into_iter()
        .map(|parsed| match parsed.document {
            Some(document) => document,
            None => panic!("a document of contracts/fixtures/bench does not parse: {:?}", parsed.diagnostics),
        })
        .collect()
}

/// The lines of a vector joined as a text: each line ends with a line feed.
fn joined(lines: &Value) -> String {
    let lines = lines.as_array().expect("the text of a vector is a list of lines");
    lines.iter().map(|line| format!("{}\n", line.as_str().expect("a line of a vector is a text"))).collect()
}

// Requirements: FMS-10, FMS-11, FMS-12, FMS-13, FMS-14, FMS-81. The form of each document of contracts/fixtures/bench is
// a value of the schema, and the document that is read from it has the same canonical text, the same form, the same
// manifest and the same statements in the three dialects.
#[test]
fn a_document_of_the_bench_set_keeps_its_text_hashes_and_statements() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let documents = bench_documents();
    let mut read = Vec::new();
    for document in &documents {
        let name = &document.name.text;
        let form = document_to_json(document).expect("a parsed document has a form");
        assert_eq!(refusals("document", &form), no_refusal(), "the form of {name}");
        let back = document_from_json(&form).or_panic(|refusal| format!("the form of {name} is refused: {refusal}"));
        assert_eq!(dbspec::emit(&back), dbspec::emit(document), "the canonical text of {name}");
        assert_eq!(back.external, document.external, "{name}");
        assert_eq!(document_to_json(&back).expect("the document that was read has a form"), form, "the form of {name}");
        read.push(back);
    }
    let written: Vec<&Document> = documents.iter().collect();
    let read: Vec<&Document> = read.iter().collect();
    assert_eq!(dbspec::manifest(&read), dbspec::manifest(&written));
    assert!(dbspec::manifest(&written).is_ok(), "the bench set has a manifest");
    for dialect in [Dialect::MySql, Dialect::Postgres, Dialect::Sqlite] {
        assert_eq!(dbspec::render_statements(&read, dialect), dbspec::render_statements(&written, dialect), "{dialect:?}");
    }
}

// Requirements: FMS-10, FMS-12, FMS-13, FMS-14. The canonical texts of tests/dbspec/canonical.json hold the comments,
// the checks, every setting and the diagrams: the form of each is a value of the schema and gives the same text.
#[test]
fn a_canonical_text_keeps_its_text_through_its_form() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let vectors: Value = serde_json::from_str(CANONICAL).expect("tests/dbspec/canonical.json is JSON");
    let mut texts = 0;
    for case in vectors["cases"].as_array().expect("the vector file holds cases") {
        for step in case["steps"].as_array().expect("a case holds steps") {
            if step["op"] != "dbspec.format" {
                continue;
            }
            let id = case["id"].as_str().expect("a case has an id");
            let text = joined(&step["expect"]["none"]["text"]);
            let set: BTreeMap<String, String> = match step.get("set") {
                Some(set) => set.as_object().expect("the set of a step is an object").iter().map(|(name, lines)| (name.clone(), joined(lines))).collect(),
                None => BTreeMap::new(),
            };
            let document = match dbspec::parse(&text, &set) {
                Ok(parsed) => parsed.document,
                Err(diagnostics) => panic!("{id}: the canonical text does not parse: {diagnostics:?}"),
            };
            let form = document_to_json(&document).or_panic(|refusal| format!("{id}: {refusal}"));
            assert_eq!(refusals("document", &form), no_refusal(), "{id}");
            let back = document_from_json(&form).or_panic(|refusal| format!("{id}: the form is refused: {refusal}"));
            assert_eq!(dbspec::emit(&back), text, "{id}");
            texts += 1;
        }
    }
    assert!(texts > 0, "tests/dbspec/canonical.json holds no dbspec.format step");
}

/// The form of the document `bench`, which the cases of a refusal change.
fn bench_form() -> Value {
    let documents = bench_documents();
    document_to_json(&documents[0]).expect("a parsed document has a form")
}

// Requirements: FMS-14, FMS-81. A member that the schema does not name, a varchar type without its length and a
// predicate without its kind are each refused with a text that names the member.
#[test]
fn a_value_that_is_no_document_is_refused_by_the_name_of_its_member() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let refusal = |form: &Value| document_from_json(form).err().unwrap_or_else(|| panic!("the form {form} is read"));

    let mut unknown = bench_form();
    unknown["tables"][0]["engine"] = json!("innodb");
    assert_eq!(refusal(&unknown), "document.tables[0].engine is no member of the form");
    assert_ne!(refusals("document", &unknown), no_refusal(), "the schema refuses it too");

    let mut varchar = bench_form();
    let columns = varchar["tables"][0]["columns"].as_array_mut().expect("the columns of a table");
    let position = columns.iter().position(|column| column["type"]["kind"] == "varchar").expect("the first table of bench has a varchar column");
    columns[position]["type"] = json!({"kind": "varchar"});
    assert_eq!(refusal(&varchar), format!("document.tables[0].columns[{position}].type.length is absent"));
    assert_ne!(refusals("document", &varchar), no_refusal(), "the schema refuses it too");

    let mut predicate = bench_form();
    let tables = predicate["tables"].as_array_mut().expect("the tables of a document");
    let table = tables.iter().position(|table| table["checks"].as_array().is_some_and(|checks| !checks.is_empty())).expect("bench has a table with a check");
    tables[table]["checks"][0]["expr"].as_object_mut().expect("a predicate is an object").remove("kind");
    assert_eq!(refusal(&predicate), format!("document.tables[{table}].checks[0].expr.kind is absent"));
    assert_ne!(refusals("document", &predicate), no_refusal(), "the schema refuses it too");

    assert_eq!(refusal(&json!([])), "document is no object");
    let mut external = bench_form();
    external.as_object_mut().expect("a document is an object").remove("external");
    assert_eq!(refusal(&external), "document.external is absent");
}

// Requirements: FMS-11. A type has its kind and exactly the parameters of that kind, and a form with a parameter of
// another kind or without its own is refused.
#[test]
fn a_type_has_exactly_the_parameters_of_its_kind() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let types = [
        (Type::I16, json!({"kind": "i16"})),
        (Type::I32, json!({"kind": "i32"})),
        (Type::I64, json!({"kind": "i64"})),
        (Type::Bool, json!({"kind": "bool"})),
        (Type::Decimal(13, 2), json!({"kind": "decimal", "precision": 13, "scale": 2})),
        (Type::F64, json!({"kind": "f64"})),
        (Type::Varchar(191), json!({"kind": "varchar", "length": 191})),
        (Type::Text, json!({"kind": "text"})),
        (Type::Bytes, json!({"kind": "bytes"})),
        (Type::Uuid, json!({"kind": "uuid"})),
        (Type::Date, json!({"kind": "date"})),
        (Type::Time(3), json!({"kind": "time", "precision": 3})),
        (Type::DateTime(6), json!({"kind": "datetime", "precision": 6})),
    ];
    for (ty, form) in types {
        assert_eq!(type_to_json(ty), form, "{}", ty.render());
        assert_eq!(refusals("type", &form), no_refusal(), "{}", ty.render());
        assert_eq!(type_from_json(&form), Ok(ty), "{}", ty.render());
    }
    for (form, refusal) in [
        (json!({"kind": "varchar"}), "type.length is absent"),
        (json!({"kind": "i64", "length": 0}), "type.length is no member of the form"),
        (json!({"kind": "decimal", "precision": 256, "scale": 0}), "type.precision 256 is above 255"),
        (json!({"kind": "varchar", "length": 65536}), "type.length 65536 is above 65535"),
        (json!({"kind": "money"}), "type.kind money is no kind of a column type"),
        (json!({"length": 3}), "type.kind is absent"),
        (json!("i64"), "type is no object"),
    ] {
        assert_eq!(type_from_json(&form), Err(refusal.to_owned()), "{form}");
        assert_ne!(refusals("type", &form), no_refusal(), "the schema refuses {form} too");
    }
}

// Requirements: FMS-16, FMS-81. The entities of a runtime model that are read from their form equal the entities that
// wrote it, and the form with a manifest hash is a value of the schema.
#[test]
fn the_entities_of_a_runtime_model_are_read_back_from_their_form() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let documents = bench_documents();
    let set: Vec<&Document> = documents.iter().collect();
    let model = dbspec::runtime_model(&set).expect("the bench set has a runtime model");
    assert!(model.entities.iter().any(|entity| entity.external), "the bench set uses a table of an external document");
    let mut form = runtime_model_to_json(&model);
    assert_eq!(runtime_model_from_json(&form), Ok(model.clone()));
    form["manifest_hash"] = json!(dbspec::manifest(&set).expect("the bench set has a manifest").manifest_hash);
    assert_eq!(refusals("runtime_model", &form), no_refusal());
    assert_eq!(runtime_model_from_json(&form), Ok(model), "the manifest hash is a member of the form");

    let mut unknown = form.clone();
    unknown["entities"][0]["fields"][0]["size"] = json!(1);
    assert_eq!(runtime_model_from_json(&unknown), Err("model.entities[0].fields[0].size is no member of the form".to_owned()));
    let mut hash = form.clone();
    hash["manifest_hash"] = json!(1);
    assert_eq!(runtime_model_from_json(&hash), Err("model.manifest_hash is no text".to_owned()));
    let mut entities = form;
    entities.as_object_mut().expect("the form is an object").remove("entities");
    assert_eq!(runtime_model_from_json(&entities), Err("model.entities is absent".to_owned()));
}

// Requirements: FMS-15. A diagnostic and a declaration position have the members of their forms.
#[test]
fn a_diagnostic_and_a_position_have_the_members_of_their_forms() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let refused = dbspec::parse("dbspec 1 shop\n\ntable item {\n  seq i64 bad\n  primary key (seq)\n}\n", &BTreeMap::new());
    let diagnostics = refused.err().expect("the text holds a word that no column takes");
    let form = diagnostic_to_json(&diagnostics[0]);
    assert_eq!(refusals("diagnostic", &form), no_refusal());
    assert_eq!(form, json!({"rule": diagnostics[0].rule, "line": diagnostics[0].line, "column": diagnostics[0].column, "message": diagnostics[0].message}));
    assert_eq!(form["line"], 4, "{form}");

    let parsed = dbspec::parse("dbspec 1 shop\n\ntable item {\n  seq i64\n  primary key (seq)\n}\n", &BTreeMap::new()).expect("the text parses");
    assert!(!parsed.positions.is_empty());
    for position in &parsed.positions {
        let form = position_to_json(position);
        assert_eq!(refusals("position", &form), no_refusal(), "{form}");
        assert_eq!(form, json!({"kind": position.kind, "path": position.path, "line": position.line, "column": position.column}));
    }
    let table = parsed.positions.iter().find(|position| position.kind == "table").expect("the table has a position");
    assert_eq!(position_to_json(table), json!({"kind": "table", "path": ["item"], "line": 3, "column": 7}));
}

// Requirements: FMS-26, FMS-81. The cases of TestCanonicalLiteral of legacy/packages/go/engine/dbspec/literal_test.go:
// the canonical text of a literal of each type, and nothing for a text that is no literal of the type or no one token.
#[test]
fn the_canonical_text_of_a_literal_follows_its_type() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let varchar = Type::Varchar(8);
    let cases: [(&str, Type, &str, Option<&str>); 53] = [
        ("i16-negative-zero", Type::I16, "-0", Some("0")),
        ("i16-leading-zeros", Type::I16, "007", Some("7")),
        ("i16-max", Type::I16, "32767", Some("32767")),
        ("i16-out-of-range", Type::I16, "32768", None),
        ("i16-fraction", Type::I16, "1.5", None),
        ("i16-string", Type::I16, "'1'", None),
        ("i16-now", Type::I16, "now", None),
        ("i32-min", Type::I32, "-2147483648", Some("-2147483648")),
        ("i32-out-of-range", Type::I32, "-2147483649", None),
        ("i64-min", Type::I64, "-9223372036854775808", Some("-9223372036854775808")),
        ("i64-out-of-range", Type::I64, "9223372036854775808", None),
        ("i64-word", Type::I64, "one", None),
        ("bool-false", Type::Bool, "false", Some("false")),
        ("bool-true", Type::Bool, "true", Some("true")),
        ("bool-number", Type::Bool, "1", None),
        ("bool-upper-case", Type::Bool, "TRUE", None),
        ("decimal-negative-fraction", Type::Decimal(5, 2), "-0.5", Some("-0.50")),
        ("decimal-leading-zeros-scale-zero", Type::Decimal(4, 0), "0012", Some("12")),
        ("decimal-integer-digits-overflow", Type::Decimal(3, 1), "100", None),
        ("decimal-fraction-digits-overflow", Type::Decimal(3, 1), "1.25", None),
        ("decimal-extra-zero-digits", Type::Decimal(4, 0), "12.0", None),
        ("decimal-string", Type::Decimal(4, 0), "'12'", None),
        ("f64-fraction", Type::F64, "0001.2500", Some("1.25")),
        ("f64-negative-zero", Type::F64, "-0.0", Some("0")),
        ("f64-string", Type::F64, "'1'", None),
        ("varchar-escaped-quote", varchar, "'it''s'", Some("'it''s'")),
        ("varchar-too-long", Type::Varchar(2), "'abc'", None),
        ("varchar-number", varchar, "1", None),
        ("uuid-lower-case", Type::Uuid, "'0E2B5D7A-0000-4000-8000-00000000000A'", Some("'0e2b5d7a-0000-4000-8000-00000000000a'")),
        ("uuid-invalid", Type::Uuid, "'x'", None),
        ("date-minimum", Type::Date, "'0001-01-01'", Some("'0001-01-01'")),
        ("date-february-30", Type::Date, "'2026-02-30'", None),
        ("time-fraction", Type::Time(3), "'23:59:59.5'", Some("'23:59:59.500'")),
        ("time-no-fraction", Type::Time(3), "'12:00:00'", Some("'12:00:00.000'")),
        ("time-extra-zero-digit", Type::Time(0), "'12:00:00.0'", None),
        ("time-24", Type::Time(0), "'24:00:00'", None),
        ("time-now", Type::Time(3), "now", None),
        ("datetime-no-fraction", Type::DateTime(6), "'2026-01-01 00:00:00'", Some("'2026-01-01 00:00:00.000000'")),
        ("datetime-t-separator", Type::DateTime(0), "'2026-01-01T00:00:00'", None),
        ("datetime-now", Type::DateTime(0), "now", Some("now")),
        ("text-string", Type::Text, "'x'", None),
        ("bytes-string", Type::Bytes, "'x'", None),
        ("empty", Type::I32, "", None),
        ("plus-sign", Type::I32, "+1", None),
        ("minus-space-number", Type::I32, "- 1", None),
        ("leading-space", Type::I32, " 1", None),
        ("trailing-space", Type::I32, "1 ", None),
        ("two-literals", Type::I32, "1 2", None),
        ("unclosed-string", varchar, "'x", None),
        ("two-strings", varchar, "'a' 'b'", None),
        ("parenthesis", Type::I32, "(1)", None),
        ("line-end", varchar, "'a\nb'", None),
        ("carriage-return", varchar, "'a\rb'", None),
    ];
    for (id, ty, text, want) in cases {
        assert_eq!(canonical_literal(ty, text).as_deref(), want, "{id}: canonical_literal({}, {text:?})", ty.render());
    }
}
