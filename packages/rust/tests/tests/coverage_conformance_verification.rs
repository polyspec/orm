//! conformance_verification: Rust conformance runner가 --vector로 고른 read-only vector만
//! 실행하고, 그 출력이 선택된 database에 기록된 expect와 JSON 값으로 같다. 선언되지 않은
//! vector 이름은 아무것도 출력하지 않고 실패한다.
//!
//! The suites of tests/conformance run one trial `conformance_<dialect>::<vector>` per vector of that dialect's file:
//! the runner runs every vector once, in the order of the file as the expectations were recorded, on the seeded bench
//! database of BENCH_<DIALECT>_DSN, and the output of each vector equals its recorded expectation. A vector run alone
//! differs, since an earlier vector of the full run makes the first-use statements of each connection. The feature-check case `coverage_conformance_vector` is an ignored trial, which feature-check
//! runs with --include-ignored.
mod common;

use serde_json::Value;
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const VECTORS: [&str; 2] = ["conditions_values", "relations"];

/// runner 한 번의 기한. database가 하는 일을 제한하므로 wall-clock 시간이다.
const DEADLINE: Duration = Duration::from_secs(300);

fn runner(dsn: &str, vectors: &[&str]) -> Command {
    let mut command = Command::new(polyspec_orm_testcase::program("conformance"));
    command.arg("--dsn").arg(dsn);
    for vector in vectors {
        command.arg("--vector").arg(vector);
    }
    command
}

fn coverage_conformance_vector() {
    let driver = common::required("ORM_FEATURE_DATABASE");
    let dsn = common::required("ORM_FEATURE_DSN");
    let file = match driver.as_str() {
        "mysql" => "vectors.json",
        "postgres" => "vectors.postgres.json",
        "sqlite" => "vectors.sqlite.json",
        other => panic!("ORM_FEATURE_DATABASE {other:?} is not mysql, postgres or sqlite"),
    };
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/conformance").join(file);
    let recorded: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let recorded = recorded["vectors"].as_array().unwrap_or_else(|| panic!("{}: no vectors array", path.display()));
    let redact = |bytes: &[u8]| String::from_utf8_lossy(bytes).replace(&dsn, "[dsn]");

    let output = common::run("conformance", runner(&dsn, &VECTORS), DEADLINE);
    assert!(output.status.success(), "conformance runner failed with {}: {}", output.status, redact(&output.stderr));
    let got: serde_json::Map<String, Value> = serde_json::from_slice(&output.stdout).unwrap_or_else(|e| panic!("runner output is not a JSON object: {e}"));
    let mut names: Vec<&str> = got.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(names, VECTORS, "the runner must print exactly the selected vectors");
    for name in VECTORS {
        let matching: Vec<&Value> = recorded.iter().filter(|vector| vector["name"] == name).collect();
        let [vector] = matching.as_slice() else { panic!("{}: vector {name} is recorded {} times", path.display(), matching.len()) };
        let expect = vector.get("expect").filter(|expect| !expect.is_null()).unwrap_or_else(|| panic!("{}: vector {name} has no expectation", path.display()));
        assert_eq!(&got[name], expect, "{driver}: vector {name} differs from {}", path.display());
    }

    let unknown = common::run("conformance unknown vector", runner(&dsn, &["coverage_unknown_vector"]), DEADLINE);
    assert!(!unknown.status.success(), "an unknown vector name must fail");
    assert!(unknown.stdout.is_empty(), "an unknown vector name printed output: {}", redact(&unknown.stdout));
    assert!(redact(&unknown.stderr).contains("unknown vector coverage_unknown_vector"), "unknown vector error: {}", redact(&unknown.stderr));
}

/// The recorded vectors of `file` in tests/conformance.
fn recorded(file: &str) -> Vec<Value> {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/conformance").join(file);
    let recorded: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    recorded["vectors"].as_array().unwrap_or_else(|| panic!("{}: no vectors array", path.display())).clone()
}

/// `value` with every number read as an IEEE double, as tests/conformance/check (JSON.parse) reads the outputs and
/// the expectations: the runner prints a float sum 456000 as 456000.0, which is the same JSON number.
fn numbers(value: &Value) -> Value {
    match value {
        Value::Number(n) => Value::from(n.as_f64().unwrap_or_else(|| panic!("number {n} is no double"))),
        Value::Array(items) => Value::Array(items.iter().map(numbers).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), numbers(v))).collect()),
        other => other.clone(),
    }
}

/// The output of one full run of the runner on the database of `dsn_variable`, by vector name, or the reason the run
/// failed. The first trial of the dialect runs it, and the others read it.
type FullRun = Arc<OnceLock<Result<serde_json::Map<String, Value>, String>>>;

fn full_run(run: &FullRun, dsn_variable: &str) -> Result<serde_json::Map<String, Value>, String> {
    run.get_or_init(|| {
        let dsn = common::required(dsn_variable);
        let redact = |bytes: &[u8]| String::from_utf8_lossy(bytes).replace(&dsn, "[dsn]");
        let output = common::run("conformance", runner(&dsn, &[]), DEADLINE);
        if !output.status.success() {
            return Err(format!("conformance runner failed with {}: {}", output.status, redact(&output.stderr)));
        }
        serde_json::from_slice(&output.stdout).map_err(|e| format!("runner output is not a JSON object: {e}"))
    })
    .clone()
}

/// One trial `conformance_<dialect>::<name>` per vector of `file`: the output of the vector in the full run on the
/// database of `dsn_variable` equals its expectation.
fn dialect_trials(dialect: &'static str, file: &'static str, dsn_variable: &'static str) -> Vec<polyspec_orm_testcase::Trial> {
    let vectors = recorded(file);
    let names: Vec<String> =
        vectors.iter().map(|vector| vector["name"].as_str().unwrap_or_else(|| panic!("{file}: a vector has no name")).to_owned()).collect();
    let run: FullRun = Arc::new(OnceLock::new());
    vectors
        .into_iter()
        .zip(names.clone())
        .map(|(vector, name)| {
            let (run, names) = (run.clone(), names.clone());
            polyspec_orm_testcase::trial(format!("conformance_{dialect}::{name}"), polyspec_orm_testcase::PROCESS, move || {
                let got = full_run(&run, dsn_variable).unwrap_or_else(|reason| panic!("{reason}"));
                let mut printed: Vec<&str> = got.keys().map(String::as_str).collect();
                printed.sort_unstable();
                let mut want: Vec<&str> = names.iter().map(String::as_str).collect();
                want.sort_unstable();
                assert_eq!(printed, want, "the runner must print exactly the vectors of {file}");
                let expect = vector.get("expect").filter(|expect| !expect.is_null()).unwrap_or_else(|| panic!("{file}: vector {name} has no expectation"));
                assert_eq!(numbers(&got[&name]), numbers(expect), "{dialect}: vector {name} differs from {file}");
            })
        })
        .collect()
}

fn main() {
    let mut trials = dialect_trials("mysql", "vectors.json", "BENCH_MYSQL_DSN");
    trials.extend(dialect_trials("postgres", "vectors.postgres.json", "BENCH_POSTGRES_DSN"));
    trials.extend(dialect_trials("sqlite", "vectors.sqlite.json", "BENCH_SQLITE_DSN"));
    trials
        .push(polyspec_orm_testcase::trial("coverage_conformance_vector", polyspec_orm_testcase::PROCESS, coverage_conformance_vector).with_ignored_flag(true));
    polyspec_orm_testcase::run_in_order(trials);
}
