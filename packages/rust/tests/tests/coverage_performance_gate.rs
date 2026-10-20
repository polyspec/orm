//! performance_gate (Rust only measures): runs the generated client's hot-path benchmark on the shared bench database with a small number of
//! repetitions and checks three statistics lines. ORM_BENCH_MYSQL_DSN is
//! the seeded shared bench database, and it is only read.
mod common;

use std::process::Command;
use std::time::Duration;

const ITERATIONS: usize = 100;

/// The deadline of one benchmark run. It is wall-clock time because it includes what the database does.
const DEADLINE: Duration = Duration::from_secs(300);

#[test]
fn coverage_hot_path_gate() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let dsn = common::required("ORM_BENCH_MYSQL_DSN");
    let mut command = Command::new(polyspec_orm_testcase::program("client_bench"));
    command.arg(ITERATIONS.to_string()).env("ORM_BENCH_MYSQL_DSN", &dsn);
    let output = common::run("client_bench", command, DEADLINE);
    let redact = |bytes: &[u8]| String::from_utf8_lossy(bytes).replace(&dsn, "[dsn]");
    assert!(output.status.success(), "client_bench failed with {}: {}", output.status, redact(&output.stderr));
    let stdout = String::from_utf8(output.stdout).expect("client_bench prints UTF-8");
    let lines: Vec<&str> = stdout.lines().collect();
    for name in ["client pk one", "client list100", "plan cache hit (no db)"] {
        let matching: Vec<&&str> = lines.iter().filter(|line| line.starts_with(name)).collect();
        let [line] = matching.as_slice() else { panic!("statistics line {name:?} appears {} times: {stdout}", matching.len()) };
        // A line is "<name> n=<count> mean=<ns>ns p50=<ns>ns p90=<ns>ns p99=<ns>ns", and a space may come before the value.
        let mut rest = &line[name.len()..];
        let mut value = |label: &str| {
            let at = rest.find(label).unwrap_or_else(|| panic!("{name}: no {label} field: {line}"));
            let after = rest[at + label.len()..].trim_start();
            let end = after.find(char::is_whitespace).unwrap_or(after.len());
            rest = &after[end..];
            &after[..end]
        };
        assert_eq!(value("n="), ITERATIONS.to_string(), "{name}: sample count: {line}");
        for label in ["mean=", "p50=", "p90=", "p99="] {
            let field = value(label);
            let nanos: f64 =
                field.strip_suffix("ns").and_then(|v| v.parse().ok()).unwrap_or_else(|| panic!("{name}: {label}{field} is not a duration in ns: {line}"));
            assert!(nanos > 0.0, "{name}: {label} must be positive: {line}");
        }
    }
}
