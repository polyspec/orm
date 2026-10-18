use std::process::Command;

// client_bench fails without connecting if ORM_BENCH_MYSQL_DSN is missing or empty, and prints that variable name.
fn run_without_dsn(value: Option<&str>) -> std::process::Output {
    let mut command = Command::new(polyspec_orm_testcase::program("client_bench"));
    command.arg("1");
    match value {
        Some(v) => command.env("ORM_BENCH_MYSQL_DSN", v),
        None => command.env_remove("ORM_BENCH_MYSQL_DSN"),
    };
    command.output().expect("client_bench must start")
}

fn assert_dsn_required(output: std::process::Output) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "client_bench succeeded without ORM_BENCH_MYSQL_DSN");
    assert!(stderr.contains("ORM_BENCH_MYSQL_DSN is required"), "client_bench stderr lacks the DSN requirement: {stderr}");
}

#[test]
fn client_bench_fails_when_dsn_is_unset() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    assert_dsn_required(run_without_dsn(None));
}

#[test]
fn client_bench_fails_when_dsn_is_empty() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    assert_dsn_required(run_without_dsn(Some("")));
}
