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
    assert_eq!(
        output.status.code(),
        Some(1),
        "{program} without ORM_BENCH_MYSQL_DSN: {stderr}"
    );
    assert!(
        stderr.contains("ORM_BENCH_MYSQL_DSN is required"),
        "{program} stderr lacks the DSN requirement: {stderr}"
    );
}

#[test]
fn benchmarks_fail_when_dsn_is_unset() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    for program in &[
        polyspec_orm_testcase::program("native"),
        polyspec_orm_testcase::program("driver_compare"),
    ] {
        assert_dsn_required(program, run_without_dsn(program, None));
    }
}

#[test]
fn benchmarks_fail_when_dsn_is_empty() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    for program in &[
        polyspec_orm_testcase::program("native"),
        polyspec_orm_testcase::program("driver_compare"),
    ] {
        assert_dsn_required(program, run_without_dsn(program, Some("")));
    }
}

// native와 driver_compare는 iterations 인자가 없거나 최소값 이상의 정수가 아니면 연결하기 전에
// status 1로 끝나고, 인자 이름과 받은 값을 출력한다. 기본 반복 횟수로 대신 실행하지 않는다.
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
