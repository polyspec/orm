use polyspec_orm_case_clock::CaseClock;
use polyspec_orm_schema::dbspec::{self, Document};
use polyspec_orm_testcase::Trial;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

#[path = "common/dbspec_cases.rs"]
mod dbspec_cases;

const CASE_DEADLINE: Duration = Duration::from_secs(1);
// SUITE_DEADLINE는 test의 CPU 시간 한도이고, 멈춘 test를 끝내는 wall-clock 기한은 그 열 배다
// (polyspec_orm_testcase::wall_for_cpu).
const SUITE_DEADLINE: Duration = Duration::from_secs(5);

fn cases_path() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/cases.json")
}

/// tests/dbspec/cases.json, read strictly: a missing or unknown section or field of any section panics with its place.
fn read_cases() -> Value {
    let path = cases_path();
    let value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap();
    dbspec_cases::check_cases(&value, "tests/dbspec/cases.json").unwrap_or_else(|e| panic!("{e}"));
    value
}

/// Line ends of a case: LF, CRLF when `crlf` is true, or alternating CRLF and
/// LF starting with CRLF when `mixed` is true, where the last line has none.
#[derive(Clone, Copy)]
enum Ends {
    Lf,
    Crlf,
    Mixed,
}

fn joined(lines: &Value, ends: Ends) -> String {
    let lines = lines.as_array().unwrap();
    let mut text = String::new();
    for (index, line) in lines.iter().enumerate() {
        text.push_str(line.as_str().unwrap());
        match ends {
            Ends::Lf => text.push('\n'),
            Ends::Crlf => text.push_str("\r\n"),
            Ends::Mixed if index + 1 == lines.len() => {}
            Ends::Mixed => text.push_str(if index % 2 == 0 { "\r\n" } else { "\n" }),
        }
    }
    text
}

fn ends(case: &Value) -> Ends {
    match (case["crlf"].as_bool().unwrap_or(false), case["mixed"].as_bool().unwrap_or(false)) {
        (false, false) => Ends::Lf,
        (true, false) => Ends::Crlf,
        (false, true) => Ends::Mixed,
        (true, true) => panic!("{}: crlf and mixed are exclusive", case["id"]),
    }
}

fn declared(case: &Value) -> (String, BTreeMap<String, String>) {
    let ends = ends(case);
    let main = case["main"].as_str().unwrap();
    let mut set = BTreeMap::new();
    let mut main_text = None;
    for (name, lines) in case["documents"].as_object().unwrap() {
        let text = joined(lines, ends);
        if name == main {
            main_text = Some(text);
        } else {
            set.insert(name.clone(), text);
        }
    }
    (main_text.expect("main document is listed"), set)
}

fn parsed(id: &str, text: &str, set: &BTreeMap<String, String>) -> Document {
    match dbspec::parse(text, set).map(|parsed| parsed.document) {
        Ok(document) => document,
        Err(errors) => panic!("{id}: unexpected errors {errors:?}"),
    }
}

fn run(case: &Value, kind: &str) {
    let clock = CaseClock::start();
    let id = case["id"].as_str().unwrap();
    let (text, set) = declared(case);
    match kind {
        "canonical" => {
            let document = parsed(id, &text, &set);
            let emitted = dbspec::emit(&document);
            assert_eq!(emitted, text, "{id}: canonical text emits unchanged");
            assert_eq!(dbspec::emit(&document), emitted, "{id}: second emission is identical");
            assert_eq!(dbspec::format(&text, &set), Ok(text.clone()), "{id}: a canonical text formats to itself");
        }
        "normalize" => {
            let document = parsed(id, &text, &set);
            let expected = joined(&case["canonical"], Ends::Lf);
            let emitted = dbspec::emit(&document);
            assert_eq!(emitted, expected, "{id}: emits its canonical lines");
            let again = parsed(id, &emitted, &set);
            assert_eq!(dbspec::emit(&again), expected, "{id}: canonical emission is a fixed point");
            assert_eq!(dbspec::format(&text, &set), Ok(expected.clone()), "{id}: a normalize text formats to its canonical text");
            assert_eq!(dbspec::format(&expected, &set), Ok(expected.clone()), "{id}: formatting the canonical text changes nothing");
        }
        "invalid" => {
            let errors = match dbspec::parse(&text, &set).map(|parsed| parsed.document) {
                Ok(_) => panic!("{id}: parsed an invalid document"),
                Err(errors) => errors,
            };
            let got: Vec<(String, usize, usize)> = errors.iter().map(|e| (e.rule.clone(), e.line, e.column)).collect();
            let expected: Vec<(String, usize, usize)> = case["errors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (e["rule"].as_str().unwrap().to_owned(), e["line"].as_u64().unwrap() as usize, e["column"].as_u64().unwrap() as usize))
                .collect();
            assert_eq!(got, expected, "{id}: diagnostics {errors:?}");
            for error in &errors {
                assert!(!error.message.is_empty(), "{id}: diagnostic has a message");
            }
            assert_eq!(dbspec::format(&text, &set), Err(errors.clone()), "{id}: an invalid text is refused with its diagnostics");
        }
        _ => unreachable!("unknown case kind {kind}"),
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if cpu >= CASE_DEADLINE {
        polyspec_orm_testcase::warning(format_args!("{id}: cpu {cpu:?} exceeds {CASE_DEADLINE:?} (wall {wall:?})"));
    }
    polyspec_orm_testcase::step(format_args!("cpu={cpu:?} wall={wall:?}"));
}

/// The positions case: the main document parses, and its declaration positions equal the listed ones in
/// order.
fn run_positions(case: &Value) {
    let id = case["id"].as_str().unwrap();
    let (text, set) = declared(case);
    let parsed = match dbspec::parse(&text, &set) {
        Ok(parsed) => parsed,
        Err(errors) => panic!("{id}: unexpected errors {errors:?}"),
    };
    let expected: Vec<(String, Vec<String>, usize, usize)> = case["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let path = p["path"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect();
            (p["kind"].as_str().unwrap().to_owned(), path, p["line"].as_u64().unwrap() as usize, p["column"].as_u64().unwrap() as usize)
        })
        .collect();
    let got: Vec<(String, Vec<String>, usize, usize)> = parsed.positions.iter().map(|p| (p.kind.clone(), p.path.clone(), p.line, p.column)).collect();
    assert_eq!(got, expected, "{id}: positions");
}

fn assert_keys(value: &Value, keys: &[&str], id: &str) {
    let object = value.as_object().unwrap_or_else(|| panic!("{id}: an object is expected"));
    for key in object.keys() {
        assert!(keys.contains(&key.as_str()), "{id}: unknown key {key}");
    }
    for key in keys {
        assert!(object.contains_key(*key), "{id}: missing key {key}");
    }
}

/// The canonical, normalize, invalid and positions cases of cases.json, each the trial `shared_dbspec_vectors::<id>`.
fn shared_dbspec_vectors(file: &Value, seen: &mut std::collections::BTreeSet<String>) -> Vec<Trial> {
    let mut trials = Vec::new();
    for kind in ["canonical", "normalize", "invalid", "positions"] {
        let cases = file[kind].as_array().unwrap_or_else(|| panic!("{kind} cases are listed"));
        assert!(!cases.is_empty(), "{kind} cases are not empty");
        for case in cases {
            let id = case["id"].as_str().unwrap();
            assert!(!id.is_empty() && seen.insert(id.to_owned()), "case id {id} is nonempty and unique");
            let case = case.clone();
            trials.push(polyspec_orm_testcase::trial(format!("shared_dbspec_vectors::{id}"), polyspec_orm_testcase::wall_for_cpu(CASE_DEADLINE), move || {
                if kind == "positions" {
                    run_positions(&case);
                } else {
                    run(&case, kind);
                }
            }));
        }
    }
    trials
}

/// The analyses of tests/dbspec/syntax.json, built as scripts/dbspec/syntax-vectors.mjs builds them (`vectorInputs`):
/// the main document of each canonical, normalize and invalid case; each document of a sets case with its 1-based
/// place as the id suffix, with the parsing documents and the other documents of the case; each document of a hashes
/// case by its name.
fn vector_inputs(cases: &Value) -> Vec<(String, String, BTreeMap<String, String>)> {
    let mut inputs = Vec::new();
    for kind in ["canonical", "normalize", "invalid"] {
        for case in cases[kind].as_array().unwrap_or_else(|| panic!("{kind} cases are listed")) {
            let id = case["id"].as_str().unwrap();
            let (text, set) = declared(case);
            inputs.push((format!("{kind}/{id}"), text, set));
        }
    }
    for case in cases["sets"].as_array().expect("sets cases are listed") {
        let id = case["id"].as_str().unwrap();
        let documents = case["documents"].as_array().unwrap();
        let external: Vec<&Value> = case.get("external").and_then(Value::as_array).map_or(Vec::new(), |list| list.iter().collect());
        let all: Vec<&Value> = documents.iter().chain(external.iter().copied()).collect();
        for (index, lines) in documents.iter().enumerate() {
            let mut set = BTreeMap::new();
            for (name, other) in case["parsing"].as_object().unwrap() {
                set.insert(name.clone(), joined(other, Ends::Lf));
            }
            for (other_index, other) in all.iter().enumerate() {
                if other_index != index {
                    let text = joined(other, Ends::Lf);
                    let name = dbspec::parse_set(&[&text], &[]).remove(0).name.expect("a set document has a header name");
                    set.insert(name, text);
                }
            }
            inputs.push((format!("sets/{id}/{}", index + 1), joined(lines, Ends::Lf), set));
        }
    }
    for case in cases["hashes"].as_array().expect("hashes cases are listed") {
        let id = case["id"].as_str().unwrap();
        let documents = case["documents"].as_object().unwrap();
        for (name, lines) in documents {
            let mut set = BTreeMap::new();
            for (other, other_lines) in documents {
                if other != name {
                    set.insert(other.clone(), joined(other_lines, Ends::Lf));
                }
            }
            inputs.push((format!("hashes/{id}/{name}"), joined(lines, Ends::Lf), set));
        }
    }
    inputs
}

/// tests/dbspec/syntax.json, read strictly: an unknown or missing key panics.
fn syntax_file() -> Value {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/syntax.json");
    let file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap();
    assert_keys(&file, &["version", "note", "cases"], "syntax.json");
    assert_eq!(file["version"].as_u64(), Some(1));
    file
}

/// syntax.json has exactly one entry for each analysis that cases.json gives; the file's key order is not compared.
fn syntax_entries_match_the_analyses() {
    let entries = syntax_file()["cases"].as_array().expect("syntax cases are listed").clone();
    let inputs = vector_inputs(&read_cases());
    let mut by_id = BTreeMap::new();
    for entry in &entries {
        assert_keys(entry, &["id", "tokens"], "syntax entry");
        let id = entry["id"].as_str().expect("entry id is a string").to_owned();
        assert!(by_id.insert(id.clone(), entry).is_none(), "{id}: syntax.json lists the id once");
    }
    assert_eq!(by_id.len(), inputs.len(), "syntax.json has one entry per analysis");
    for (id, _, _) in &inputs {
        assert!(by_id.contains_key(id), "{id}: syntax.json lists the analysis");
    }
}

/// Each entry of tests/dbspec/syntax.json, the trial `shared_dbspec_syntax::<id>`: its analysis equals its tokens
/// exactly. A token that is not four values panics.
fn shared_dbspec_syntax(cases: &Value) -> Vec<Trial> {
    let mut inputs: BTreeMap<String, (String, BTreeMap<String, String>)> = BTreeMap::new();
    for (id, text, set) in vector_inputs(cases) {
        inputs.insert(id, (text, set));
    }
    let mut trials = Vec::new();
    for entry in syntax_file()["cases"].as_array().expect("syntax cases are listed") {
        let id = entry["id"].as_str().expect("entry id is a string").to_owned();
        let entry = entry.clone();
        let input = inputs.get(&id).cloned();
        trials.push(polyspec_orm_testcase::trial(format!("shared_dbspec_syntax::{id}"), polyspec_orm_testcase::wall_for_cpu(CASE_DEADLINE), move || {
            assert_keys(&entry, &["id", "tokens"], "syntax entry");
            let (text, set) = input.unwrap_or_else(|| panic!("{id}: cases.json gives the analysis"));
            let expected: Vec<(usize, usize, usize, String)> = entry["tokens"]
                .as_array()
                .unwrap()
                .iter()
                .map(|token| {
                    let values = token.as_array().unwrap_or_else(|| panic!("{id}: token is an array"));
                    assert_eq!(values.len(), 4, "{id}: token has four values");
                    (
                        values[0].as_u64().unwrap() as usize,
                        values[1].as_u64().unwrap() as usize,
                        values[2].as_u64().unwrap() as usize,
                        values[3].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            let got: Vec<(usize, usize, usize, String)> = dbspec::analyze(&text, &set).tokens.into_iter().map(|t| (t.line, t.start, t.end, t.class)).collect();
            assert_eq!(got, expected, "{id}: tokens");
        }));
    }
    trials
}

/// files case는 `dbspec::read_file`에 path를 주어, `dbspec::read_bytes`에 파일 byte와 case
/// path를 이름으로 주어 두 번 읽는다. signature가 없는 byte는 "<name> is not a dbspec
/// document", UTF-8이 아닌 byte는 "<name> is not valid UTF-8" diagnostic 하나를, 나머지
/// 파일은 그 byte를 돌려주며 그 text는 parse와 emit에서 바뀌지 않는다.
fn shared_dbspec_files(file: &Value, seen: &mut std::collections::BTreeSet<String>) -> Vec<Trial> {
    let path = cases_path();
    let cases = file["files"].as_array().expect("files cases are listed");
    assert!(!cases.is_empty(), "files cases are not empty");
    let mut trials = Vec::new();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id.to_owned()), "case id {id} is nonempty and unique");
        let (case, path) = (case.clone(), path.clone());
        trials.push(polyspec_orm_testcase::trial(format!("shared_dbspec_files::{id}"), polyspec_orm_testcase::wall_for_cpu(CASE_DEADLINE), move || {
            read_file_case(&case, &path)
        }));
    }
    trials
}

/// Reads one files case twice and checks both reads.
fn read_file_case(case: &Value, path: &std::path::Path) {
    let id = case["id"].as_str().unwrap();
    let case_clock = CaseClock::start();
    let file_path = path.parent().unwrap().join(case["path"].as_str().unwrap());
    let expected: Vec<(String, usize, usize)> = case["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["rule"].as_str().unwrap().to_owned(), e["line"].as_u64().unwrap() as usize, e["column"].as_u64().unwrap() as usize))
        .collect();
    let name = case["path"].as_str().unwrap();
    let shown = file_path.display().to_string();
    let raw = std::fs::read(&file_path).unwrap_or_else(|e| panic!("{id}: {shown}: {e}"));
    let reads = [
        ("file", shown.as_str(), dbspec::read_file(&file_path)),
        ("bytes", name, dbspec::read_bytes(name, raw.clone()).map_err(dbspec::ReadError::Diagnostics)),
    ];
    for (kind, name, read) in reads {
        match read {
            Ok(text) => {
                assert!(expected.is_empty(), "{id} {kind}: read text where diagnostics are expected");
                assert_eq!(text.as_bytes(), raw.as_slice(), "{id} {kind}: the file bytes");
                let document = parsed(id, &text, &BTreeMap::new());
                assert_eq!(dbspec::emit(&document), text, "{id} {kind}: the file text emits unchanged");
            }
            Err(dbspec::ReadError::Diagnostics(errors)) => {
                let got: Vec<(String, usize, usize)> = errors.iter().map(|e| (e.rule.clone(), e.line, e.column)).collect();
                assert_eq!(got, expected, "{id} {kind}: diagnostics {errors:?}");
                for error in &errors {
                    let message = match error.rule.as_str() {
                        "signature" => format!("{name} is not a dbspec document"),
                        _ => format!("{name} is not valid UTF-8"),
                    };
                    assert_eq!(error.message, message, "{id} {kind}: message");
                }
            }
            Err(dbspec::ReadError::Io(error)) => panic!("{id} {kind}: {shown}: {error}"),
        }
    }
    let (cpu, wall) = (case_clock.cpu(), case_clock.wall());
    if cpu >= CASE_DEADLINE {
        polyspec_orm_testcase::warning(format_args!("{id}: cpu {cpu:?} exceeds {CASE_DEADLINE:?} (wall {wall:?})"));
    }
    polyspec_orm_testcase::step(format_args!("cpu={cpu:?} wall={wall:?}"));
}

/// A change to cases.json, with the location and the problem that the reader names for it.
type Mutation<'a> = (&'a str, &'a str, Box<dyn Fn(&mut Value)>);

/// The reader of cases.json refuses a missing or an unknown section or field of every section, naming it.
fn shared_dbspec_cases_reader_refuses_missing_and_unknown_fields() {
    let original = read_cases();
    let manifest = original["sets"].as_array().unwrap().iter().position(|c| c.get("manifest").is_some()).expect("a sets case has a manifest");
    let manifest_extra = format!("sets[{manifest}].manifest.extra");
    let mutations: Vec<Mutation> = vec![
        ("note", "is missing", Box::new(|v| drop(v.as_object_mut().unwrap().remove("note")))),
        ("extra", "is not a known field", Box::new(|v| v["extra"] = Value::Array(Vec::new()))),
        ("canonical[0].extra", "is not a known field", Box::new(|v| v["canonical"][0]["extra"] = Value::Bool(true))),
        ("normalize[0].canonical", "is missing", Box::new(|v| drop(v["normalize"][0].as_object_mut().unwrap().remove("canonical")))),
        ("invalid[0].errors[0].extra", "is not a known field", Box::new(|v| v["invalid"][0]["errors"][0]["extra"] = Value::from(1))),
        ("hashes[0].extra", "is not a known field", Box::new(|v| v["hashes"][0]["extra"] = Value::Bool(true))),
        ("sets[0].extra", "is not a known field", Box::new(|v| v["sets"][0]["extra"] = Value::Bool(true))),
        (&manifest_extra, "is not a known field", Box::new(move |v| v["sets"][manifest]["manifest"]["extra"] = Value::Array(Vec::new()))),
        ("files[0].errors", "is missing", Box::new(|v| drop(v["files"][0].as_object_mut().unwrap().remove("errors")))),
        ("positions[0].positions[0].extra", "is not a known field", Box::new(|v| v["positions"][0]["positions"][0]["extra"] = Value::from(1))),
        ("positions[0].positions[0].line", "is not an integer", Box::new(|v| v["positions"][0]["positions"][0]["line"] = Value::Bool(true))),
    ];
    for (location, problem, change) in &mutations {
        let mut value = original.clone();
        change(&mut value);
        assert_eq!(dbspec_cases::check_cases(&value, "tests/dbspec/cases.json"), Err(format!("tests/dbspec/cases.json: {location} {problem}")), "{location}");
    }
    polyspec_orm_testcase::step(format_args!("{} refused", mutations.len()));
}

fn main() {
    let file = read_cases();
    let mut seen = std::collections::BTreeSet::new();
    let mut trials = shared_dbspec_vectors(&file, &mut seen);
    trials.extend(shared_dbspec_files(&file, &mut seen));
    trials.extend(shared_dbspec_syntax(&file));
    trials.push(polyspec_orm_testcase::trial(
        "syntax_entries_match_the_analyses",
        polyspec_orm_testcase::wall_for_cpu(SUITE_DEADLINE),
        syntax_entries_match_the_analyses,
    ));
    trials.push(polyspec_orm_testcase::trial(
        "shared_dbspec_cases_reader_refuses_missing_and_unknown_fields",
        polyspec_orm_testcase::wall_for_cpu(SUITE_DEADLINE),
        shared_dbspec_cases_reader_refuses_missing_and_unknown_fields,
    ));
    polyspec_orm_testcase::run(trials);
}
