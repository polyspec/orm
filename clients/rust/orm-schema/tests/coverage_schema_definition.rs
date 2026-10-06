//! schema_definition: contracts/fixtures/schema_definition.json의 case를 dbspec parse, emit,
//! manifest, render로 실행한다. 값은 fixture에서 읽는다.
use orm_case_clock::CaseClock;
use polyspec_orm_schema::dbspec::{self, Dialect, Document};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

/// 한 case가 자기 계산에 쓰는 thread CPU 시간의 한도.
const CPU_LIMIT: Duration = Duration::from_secs(10);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn repository() -> PathBuf {
    orm_testcase::manifest_dir().join("../../..")
}

/// fixture에서 `id` case 하나를 찾아 operation이 `operation`인지 확인하고 input과 expected를 돌려준다.
fn case(id: &str, operation: &str) -> (Value, Value) {
    let path = repository().join("contracts/fixtures/schema_definition.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(fixture["feature"], "schema_definition", "{}: feature", path.display());
    let cases: Vec<&Value> = fixture["cases"].as_array().expect("fixture cases").iter().filter(|c| c["id"] == id).collect();
    let [case] = cases.as_slice() else { panic!("{}: case {id} appears {} times", path.display(), cases.len()) };
    assert_eq!(case["operation"], operation, "{id}: operation");
    (case["input"].clone(), case["expected"].clone())
}

/// input의 document 경로와 그 text.
fn sources(input: &Value) -> Vec<(String, String)> {
    let paths = input["documents"].as_array().expect("input documents");
    assert!(!paths.is_empty(), "input names no document");
    paths
        .iter()
        .map(|path| {
            let path = path.as_str().expect("document path").to_owned();
            let file = repository().join(&path);
            let text = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
            (path, text)
        })
        .collect()
}

fn parse(path: &str, text: &str) -> Document {
    dbspec::parse(text, &Default::default()).unwrap_or_else(|errors| panic!("{path}: {errors:?}"))
}

/// `body`를 실행하고 시작, 성공, 걸린 시간을 출력하며 CPU 시간 한도를 확인한다.
fn run(id: &str, body: impl FnOnce()) {
    let clock = CaseClock::start();
    orm_testcase::step(format_args!("start {id}"));
    body();
    let cpu = clock.cpu();
    if cpu >= CPU_LIMIT {
        orm_testcase::warning(format_args!("{id}: used {cpu:?} of CPU time, limit {CPU_LIMIT:?}"));
    }
    orm_testcase::step(format_args!("{id} cpu={cpu:?} wall={:?}", clock.wall()));
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_dbspec_emit_round_trip() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("dbspec_emit_round_trip", || {
        let (input, expected) = case("dbspec_emit_round_trip", "parse_emit");
        let identical = expected["identical"].as_bool().expect("expected.identical");
        for (path, text) in sources(&input) {
            assert_eq!(dbspec::emit(&parse(&path, &text)) == text, identical, "{path}: parse then emit reproduces the document");
        }
    });
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_dbspec_manifest_hash() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("dbspec_manifest_hash", || {
        let (input, expected) = case("dbspec_manifest_hash", "manifest");
        let documents: Vec<Document> = sources(&input).iter().map(|(path, text)| parse(path, text)).collect();
        let refs: Vec<&Document> = documents.iter().collect();
        let manifest = dbspec::manifest(&refs).unwrap_or_else(|errors| panic!("manifest: {errors:?}"));
        assert_eq!(manifest.manifest_hash, expected["manifest_hash"].as_str().expect("expected.manifest_hash"));
    });
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_dbspec_render_ddl() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("dbspec_render_ddl", || {
        let (input, expected) = case("dbspec_render_ddl", "render");
        let documents: Vec<Document> = sources(&input).iter().map(|(path, text)| parse(path, text)).collect();
        let refs: Vec<&Document> = documents.iter().collect();
        assert_eq!(expected.as_object().expect("expected statements").len(), DIALECTS.len(), "expected dialects");
        for (name, dialect) in DIALECTS {
            let want: Vec<String> =
                expected[name].as_array().unwrap_or_else(|| panic!("expected.{name}")).iter().map(|s| s.as_str().expect("statement").to_owned()).collect();
            assert_eq!(dbspec::render(&refs, dialect), Ok(want), "{name}");
        }
    });
}
