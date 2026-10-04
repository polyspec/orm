//! conformance_verification: Rust conformance runner가 --vector로 고른 read-only vector만
//! 실행하고, 그 출력이 선택된 database에 기록된 expect와 JSON 값으로 같다. 선언되지 않은
//! vector 이름은 아무것도 출력하지 않고 실패한다.
mod common;

use serde_json::Value;
use std::process::Command;
use std::time::Duration;

const VECTORS: [&str; 2] = ["conditions_values", "relations"];

/// runner 한 번의 기한. database가 하는 일을 제한하므로 wall-clock 시간이다.
const DEADLINE: Duration = Duration::from_secs(300);

fn runner(dsn: &str, vectors: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_conformance"));
    command.arg("--dsn").arg(dsn);
    for vector in vectors {
        command.arg("--vector").arg(vector);
    }
    command
}

#[test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
fn coverage_conformance_vector() {
    let _case = orm_testcase::case!(orm_testcase::PROCESS);
    let driver = common::required("ORM_FEATURE_DATABASE");
    let dsn = common::required("ORM_FEATURE_DSN");
    let file = match driver.as_str() {
        "mysql" => "vectors.json",
        "postgres" => "vectors.postgres.json",
        "sqlite" => "vectors.sqlite.json",
        other => panic!("ORM_FEATURE_DATABASE {other:?} is not mysql, postgres or sqlite"),
    };
    let path = orm_testcase::manifest_dir().join("../../../tests/conformance").join(file);
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
