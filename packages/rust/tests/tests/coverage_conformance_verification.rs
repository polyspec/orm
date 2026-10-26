//! conformance_verification: runs only the selected vectors with the Rust conformance runner's --vector option,
//! and checks that its output equals the recorded JSON values. The creates_and_save vector removes the rows it creates. A name of an undeclared
//! vector prints nothing and fails.
//!
//! The suites of tests/conformance run one trial `conformance_<dialect>::<vector>` per vector of that dialect's file:
//! the runner runs every vector once, in the order of the file as the expectations were recorded, on the seeded bench
//! database of BENCH_<DIALECT>_DSN, and the output of each vector equals its recorded expectation. A vector run alone
//! differs, since an earlier vector of the full run makes the first-use statements of each connection. The feature-check case `coverage_conformance_vector` is an ignored trial, which feature-check
//! runs with --include-ignored.
//! Requirements: PRT-68, INT-20, INT-21, INT-22, INT-23, INT-24, INT-25, INT-26, INT-39, DBS-115.
use polyspec_orm_testcase::OrPanic;

polyspec_orm::models!();

mod common;

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use model::{AuditRecord, AuditedNote};

const SELECTED_VECTORS: [&str; 4] = ["conditions_values", "relations", "functions", "creates_and_save"];
const OUTPUT_VECTOR_KEYS: [&str; 4] = ["conditions_values", "creates_and_save", "functions", "relations"];

/// The deadline of one runner run. It is wall-clock time because it limits what the database does.
const DEADLINE: Duration = Duration::from_secs(300);

fn runner(dsn: &str, vectors: &[&str]) -> Command {
    let mut command = Command::new(polyspec_orm_testcase::program("conformance"));
    command.arg("--dsn").arg(dsn);
    for vector in vectors {
        command.arg("--vector").arg(vector);
    }
    command
}

// Requirements: DIA-37, DSL-137, DSL-139, DSL-144, DIA-11, DIA-14.
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
    let recorded: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).or_panic(|e| format!("{}: {e}", path.display()))).or_panic(|e| format!("{}: {e}", path.display()));
    let recorded = recorded["vectors"].as_array().unwrap_or_else(|| panic!("{}: no vectors array", path.display()));
    let redact = |bytes: &[u8]| String::from_utf8_lossy(bytes).replace(&dsn, "[dsn]");

    let output = common::run("conformance", runner(&dsn, &SELECTED_VECTORS), DEADLINE);
    assert!(output.status.success(), "conformance runner failed with {}: {}", output.status, redact(&output.stderr));
    let got: serde_json::Map<String, Value> = serde_json::from_slice(&output.stdout).or_panic(|e| format!("runner output is not a JSON object: {e}"));
    let mut names: Vec<&str> = got.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(names, OUTPUT_VECTOR_KEYS, "the runner output uses canonical JSON object-key order, independent of --vector arguments");
    for name in SELECTED_VECTORS {
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

fn selected_vector_order_matches_document_and_canonical_json_order() {
    let vectors = recorded("vectors.json");
    let names: Vec<&str> = vectors.iter().map(|vector| vector["name"].as_str().expect("vector name")).filter(|name| SELECTED_VECTORS.contains(name)).collect();
    assert_eq!(names, SELECTED_VECTORS, "selected names follow the document's vector declaration order");
    let mut keys = SELECTED_VECTORS.to_vec();
    keys.sort_unstable();
    assert_eq!(keys, OUTPUT_VECTOR_KEYS, "serialized JSON object keys use canonical lexical order");
}

/// The recorded vectors of `file` in tests/conformance.
fn recorded(file: &str) -> Vec<Value> {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/conformance").join(file);
    let recorded: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).or_panic(|e| format!("{}: {e}", path.display()))).or_panic(|e| format!("{}: {e}", path.display()));
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
        let driver = conformance_driver(dsn_variable)?;
        run_with_audit_lazy_counter_baseline(&dsn, &driver, || {
            let output = common::run("conformance", runner(&dsn, &[]), DEADLINE);
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).replace(&dsn, "[dsn]");
                return Err(format!("conformance runner failed with {}: {stderr}", output.status));
            }
            serde_json::from_slice(&output.stdout).map_err(|e| format!("runner output is not a JSON object: {e}"))
        })
    })
    .clone()
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
struct CounterValue {
    value: String,
    called: bool,
    owner: String,
}

type CounterSnapshot = BTreeMap<String, CounterValue>;

fn conformance_driver(dsn_variable: &str) -> Result<String, String> {
    match dsn_variable {
        "BENCH_MYSQL_DSN" => Ok("mysql".into()),
        "BENCH_POSTGRES_DSN" => Ok("postgres".into()),
        "BENCH_SQLITE_DSN" => Ok("sqlite".into()),
        other => Err(format!("unsupported conformance DSN variable {other:?}")),
    }
}

/// Normalizes the two tables written by audit_lazy, then restores every counter after the full runner finishes.
fn run_with_audit_lazy_counter_baseline<T>(dsn: &str, driver: &str, run: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let root = polyspec_orm_testcase::manifest_dir().join("../../../");
    let original = read_conformance_counters(&root, driver, dsn)?;
    let run_result = (|| {
        assert_audit_lazy_tables_empty(dsn)?;
        let baseline = audit_lazy_counter_baseline(&original, driver)?;
        restore_conformance_counters(&root, driver, dsn, &baseline)?;
        run()
    })();
    let restore_result =
        restore_conformance_counters(&root, driver, dsn, &original).and_then(|()| read_conformance_counters(&root, driver, dsn)).and_then(|current| {
            if current == original {
                Ok(())
            } else {
                Err(format!("{driver} conformance counters differ after restore: got {current:?}, want {original:?}"))
            }
        });
    match (run_result, restore_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(format!("restore {driver} conformance counters: {error}")),
        (Err(run_error), Err(restore_error)) => Err(format!("{run_error}; restore {driver} conformance counters: {restore_error}")),
    }
}

fn audit_lazy_counter_baseline(original: &CounterSnapshot, driver: &str) -> Result<CounterSnapshot, String> {
    let mut baseline = original.clone();
    for table in ["audit_record", "audited_note"] {
        match driver {
            "mysql" => {
                let counter = baseline.get_mut(table).ok_or_else(|| format!("MySQL counter snapshot has no {table} AUTO_INCREMENT"))?;
                counter.value = "1".into();
                counter.called = true;
            }
            "postgres" => {
                let mut found = false;
                for counter in baseline.values_mut().filter(|counter| counter.owner == table) {
                    counter.value = "1".into();
                    counter.called = false;
                    found = true;
                }
                if !found {
                    return Err(format!("PostgreSQL counter snapshot has no sequence owned by {table}"));
                }
            }
            "sqlite" => {
                if let Some(counter) = baseline.get_mut(table) {
                    counter.value = "0".into();
                    counter.called = true;
                }
            }
            other => return Err(format!("unsupported conformance driver {other:?}")),
        }
    }
    Ok(baseline)
}

fn assert_audit_lazy_tables_empty(dsn: &str) -> Result<(), String> {
    let runtime =
        tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| format!("create audit_lazy counter-check runtime: {error}"))?;
    runtime.block_on(async {
        let db = model::connect(dsn, 1, polyspec_orm::Config::default()).await.map_err(|error| format!("connect to the conformance database: {error}"))?;
        let result = async {
            let records = AuditRecord::new().connect(&db).get_count().await.map_err(|error| format!("count audit_record before audit_lazy: {error}"))?;
            let notes = AuditedNote::new().connect(&db).get_count().await.map_err(|error| format!("count audited_note before audit_lazy: {error}"))?;
            if records != 0 {
                return Err(format!("cannot normalize audit_record identity counter: table has {records} rows"));
            }
            if notes != 0 {
                return Err(format!("cannot normalize audited_note identity counter: table has {notes} rows"));
            }
            Ok(())
        }
        .await;
        db.close().await;
        result
    })
}

fn read_conformance_counters(root: &Path, driver: &str, dsn: &str) -> Result<CounterSnapshot, String> {
    let output = common::run("conformance counters", counter_command(root, driver, dsn, None)?, DEADLINE);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).replace(dsn, "[dsn]");
        return Err(format!("read {driver} conformance counters failed with {}: {stderr}", output.status));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("decode {driver} conformance counters: {error}"))
}

fn restore_conformance_counters(root: &Path, driver: &str, dsn: &str, counters: &CounterSnapshot) -> Result<(), String> {
    let output = common::run("restore conformance counters", counter_command(root, driver, dsn, Some(counters))?, DEADLINE);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).replace(dsn, "[dsn]");
        return Err(format!("restore {driver} conformance counters failed with {}: {stderr}", output.status));
    }
    Ok(())
}

fn counter_command(root: &Path, driver: &str, dsn: &str, restore: Option<&CounterSnapshot>) -> Result<Command, String> {
    let mut command = Command::new("node");
    command.current_dir(root).args(["tests/conformance/check/main.mts", "counters", "--driver", driver, "--dsn", dsn]);
    if let Some(snapshot) = restore {
        let json = serde_json::to_string(snapshot).map_err(|error| format!("encode {driver} counter snapshot: {error}"))?;
        command.arg("--restore-json").arg(json);
    }
    Ok(command)
}

/// Requirements: DIA-24. Cases: conformance_mysql::datetime_p0_roundtrip, conformance_mysql::time_p3_roundtrip,
/// conformance_mysql::datetime_precision_rejected, conformance_postgres::datetime_p0_roundtrip,
/// conformance_postgres::time_p3_roundtrip, conformance_postgres::datetime_precision_rejected,
/// conformance_sqlite::datetime_p0_roundtrip, conformance_sqlite::time_p3_roundtrip,
/// conformance_sqlite::datetime_precision_rejected.
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
                let got = full_run(&run, dsn_variable).or_panic(|reason| reason);
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
    let mut trials = vec![polyspec_orm_testcase::trial(
        "selected_vector_order_matches_document_and_canonical_json_order",
        polyspec_orm_testcase::PROCESS,
        selected_vector_order_matches_document_and_canonical_json_order,
    )];
    trials.extend(dialect_trials("mysql", "vectors.json", "BENCH_MYSQL_DSN"));
    trials.extend(dialect_trials("postgres", "vectors.postgres.json", "BENCH_POSTGRES_DSN"));
    trials.extend(dialect_trials("sqlite", "vectors.sqlite.json", "BENCH_SQLITE_DSN"));
    trials
        .push(polyspec_orm_testcase::trial("coverage_conformance_vector", polyspec_orm_testcase::PROCESS, coverage_conformance_vector).with_ignored_flag(true));
    polyspec_orm_testcase::run_in_order(trials);
}
