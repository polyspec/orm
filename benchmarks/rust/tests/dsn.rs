use std::process::Command;

// native and driver_compare fail without connecting if ORM_BENCH_MYSQL_DSN is missing or empty, and
// print that variable name and fail. They do not connect to a fixed socket or database instead.
const DSN: &str = "ORM_BENCH_MYSQL_DSN";

/// Runs native and driver_compare with the DSN variable set to `value` (or unset), and asserts that each refuses.
fn assert_dsn_required_for_all(value: Option<&str>) {
    for program in &[polyspec_orm_testcase::program("native"), polyspec_orm_testcase::program("driver_compare")] {
        polyspec_orm_testcase::assert_env_required(program, polyspec_orm_testcase::run_with_env(program, &["10"], DSN, value), DSN);
    }
}

#[test]
fn benchmarks_fail_when_dsn_is_unset() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    assert_dsn_required_for_all(None);
}

#[test]
fn benchmarks_fail_when_dsn_is_empty() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    assert_dsn_required_for_all(Some(""));
}

// native and driver_compare end with status 1 before connecting if the iterations argument is missing or not an integer at or above the minimum,
// and print the argument name and the value received. They do not run with the default repeat count instead.
fn run_with_args(program: &str, args: &[&str]) -> (Option<i32>, String) {
    let output = Command::new(program)
        .args(args)
        .env_remove("ORM_BENCH_MYSQL_DSN")
        .output()
        .expect("the benchmark must start");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn benchmarks_require_the_iterations_argument() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    for program in &[
        polyspec_orm_testcase::program("native"),
        polyspec_orm_testcase::program("driver_compare"),
    ] {
        let (code, stderr) = run_with_args(program, &[]);
        assert_eq!(code, Some(1), "{program} without arguments: {stderr}");
        assert!(
            stderr.contains("the iterations argument is required"),
            "{program} stderr lacks the missing argument: {stderr}"
        );
    }
}

#[test]
fn benchmarks_reject_an_invalid_iterations_argument() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    for (program, minimum) in [
        (polyspec_orm_testcase::program("native"), 3),
        (polyspec_orm_testcase::program("driver_compare"), 10),
    ] {
        let program = program.as_str();
        let small = (minimum - 1).to_string();
        for arg in ["many", "-1", "1.5", small.as_str()] {
            let (code, stderr) = run_with_args(program, &[arg]);
            assert_eq!(code, Some(1), "{program} {arg:?}: {stderr}");
            assert!(
                stderr.contains(&format!(
                    "the iterations argument must be an integer of at least {minimum}, got {arg:?}"
                )),
                "{program} stderr for {arg:?} lacks the argument and its value: {stderr}"
            );
        }
    }
}
