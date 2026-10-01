use orm_case_clock::CaseClock;
use orm_schema::dbspec::{self, Document};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

const CASE_DEADLINE: Duration = Duration::from_secs(1);
const SUITE_DEADLINE: Duration = Duration::from_secs(5);

fn cases_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/dbspec/cases.json")
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
    match dbspec::parse(text, set) {
        Ok(document) => document,
        Err(errors) => panic!("{id}: unexpected errors {errors:?}"),
    }
}

fn run(case: &Value, kind: &str) {
    let clock = CaseClock::start();
    let id = case["id"].as_str().unwrap();
    println!("RUN {kind} {id}");
    let (text, set) = declared(case);
    match kind {
        "canonical" => {
            let document = parsed(id, &text, &set);
            let emitted = dbspec::emit(&document);
            assert_eq!(emitted, text, "{id}: canonical text emits unchanged");
            assert_eq!(dbspec::emit(&document), emitted, "{id}: second emission is identical");
        }
        "normalize" => {
            let document = parsed(id, &text, &set);
            let expected = joined(&case["canonical"], Ends::Lf);
            let emitted = dbspec::emit(&document);
            assert_eq!(emitted, expected, "{id}: emits its canonical lines");
            let again = parsed(id, &emitted, &set);
            assert_eq!(dbspec::emit(&again), expected, "{id}: canonical emission is a fixed point");
        }
        "invalid" => {
            let errors = match dbspec::parse(&text, &set) {
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
        }
        _ => unreachable!("unknown case kind {kind}"),
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < CASE_DEADLINE, "{id}: cpu {cpu:?} exceeds {CASE_DEADLINE:?} (wall {wall:?})");
    println!("PASS {kind} {id} cpu={cpu:?} wall={wall:?}");
}

#[test]
fn shared_dbspec_vectors() {
    let clock = CaseClock::start();
    let path = cases_path();
    println!("RUN dbspec vectors {}", path.display());
    let file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap();
    assert_eq!(file["version"].as_u64(), Some(1));
    let mut seen = std::collections::BTreeSet::new();
    let mut count = 0;
    for kind in ["canonical", "normalize", "invalid"] {
        let cases = file[kind].as_array().unwrap_or_else(|| panic!("{kind} cases are listed"));
        assert!(!cases.is_empty(), "{kind} cases are not empty");
        for case in cases {
            let id = case["id"].as_str().unwrap();
            assert!(!id.is_empty() && seen.insert(id.to_owned()), "case id {id} is nonempty and unique");
            run(case, kind);
            count += 1;
        }
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < SUITE_DEADLINE, "dbspec vectors: cpu {cpu:?} exceeds {SUITE_DEADLINE:?} (wall {wall:?})");
    println!("PASS dbspec vectors {count} cases cpu={cpu:?} wall={wall:?}");
}
