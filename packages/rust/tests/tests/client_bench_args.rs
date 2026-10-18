use std::process::Command;

// client_bench ends with status 1, before connecting, if the iterations argument is missing or not an integer of 1 or more,
// and prints the argument name and the value received. It does not run with the default repeat count instead.
fn run_with_args(args: &[&str]) -> (Option<i32>, String) {
    let output =
        Command::new(polyspec_orm_testcase::program("client_bench")).args(args).env_remove("ORM_BENCH_MYSQL_DSN").output().expect("client_bench must start");
    (output.status.code(), String::from_utf8_lossy(&output.stderr).into_owned())
}

#[test]
fn client_bench_requires_the_iterations_argument() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let (code, stderr) = run_with_args(&[]);
    assert_eq!(code, Some(1), "client_bench without arguments: {stderr}");
    assert!(stderr.contains("the iterations argument is required"), "client_bench stderr lacks the missing argument: {stderr}");
}

#[test]
fn client_bench_rejects_an_invalid_iterations_argument() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    for arg in ["many", "-1", "0", "1.5", ""] {
        let (code, stderr) = run_with_args(&[arg]);
        assert_eq!(code, Some(1), "client_bench {arg:?}: {stderr}");
        assert!(
            stderr.contains(&format!("the iterations argument must be an integer of at least 1, got {arg:?}")),
            "client_bench stderr for {arg:?} lacks the argument and its value: {stderr}"
        );
    }
}
