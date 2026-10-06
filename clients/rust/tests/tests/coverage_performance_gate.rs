//! performance_gate (Rust는 측정만 한다): 생성된 client의 hot path benchmark를 작은 반복
//! 횟수로 공유 bench database에서 실행하고 세 통계 줄을 확인한다. ORM_BENCH_MYSQL_DSN은
//! 시드된 공유 bench database이며 읽기만 한다.
mod common;

use std::process::Command;
use std::time::Duration;

const ITERATIONS: usize = 100;

/// benchmark 한 번의 기한. database가 하는 일을 포함하므로 wall-clock 시간이다.
const DEADLINE: Duration = Duration::from_secs(300);

#[test]
#[ignore = "run by feature-check with ORM_BENCH_MYSQL_DSN"]
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
        // 줄은 "<name> n=<count> mean=<ns>ns p50=<ns>ns p90=<ns>ns p99=<ns>ns"이며 값 앞에 공백이 올 수 있다.
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
