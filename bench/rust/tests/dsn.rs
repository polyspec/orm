use std::process::Command;

// native와 driver_compare는 ORM_BENCH_MYSQL_DSN이 없거나 비어 있으면 연결하지 않고 그 변수 이름을
// 출력하며 실패한다. 고정 socket이나 database로 대신 연결하지 않는다.
fn run_without_dsn(program: &str, value: Option<&str>) -> std::process::Output {
    let mut command = Command::new(program);
    command.arg("10");
    match value {
        Some(v) => command.env("ORM_BENCH_MYSQL_DSN", v),
        None => command.env_remove("ORM_BENCH_MYSQL_DSN"),
    };
    command.output().expect("the benchmark must start")
}

fn assert_dsn_required(program: &str, output: std::process::Output) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{program} without ORM_BENCH_MYSQL_DSN: {stderr}");
    assert!(stderr.contains("ORM_BENCH_MYSQL_DSN is required"), "{program} stderr lacks the DSN requirement: {stderr}");
}

#[test]
fn benchmarks_fail_when_dsn_is_unset() {
    for program in [env!("CARGO_BIN_EXE_native"), env!("CARGO_BIN_EXE_driver_compare")] {
        assert_dsn_required(program, run_without_dsn(program, None));
    }
}

#[test]
fn benchmarks_fail_when_dsn_is_empty() {
    for program in [env!("CARGO_BIN_EXE_native"), env!("CARGO_BIN_EXE_driver_compare")] {
        assert_dsn_required(program, run_without_dsn(program, Some("")));
    }
}
