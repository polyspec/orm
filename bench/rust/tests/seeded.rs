use std::process::Command;
use std::time::Instant;

// native와 driver_compare는 ORM_BENCH_MYSQL_DSN의 시드된 bench database에서 모든 workload의
// 모든 row를 읽고 status 0으로 끝나며 workload마다 통계 한 줄을 출력한다. DSN이 없으면
// 실패한다.
fn run_seeded(program: &str, iterations: &str) -> String {
    let dsn = std::env::var("ORM_BENCH_MYSQL_DSN").expect("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database");
    assert!(!dsn.is_empty(), "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database");
    let started = Instant::now();
    let output = Command::new(program).arg(iterations).env("ORM_BENCH_MYSQL_DSN", dsn).output().expect("the benchmark must start");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("{program}: status {:?} in {:?}", output.status.code(), started.elapsed());
    assert_eq!(output.status.code(), Some(0), "{program} against the seeded bench database: {stderr}");
    stdout
}

fn assert_lines(program: &str, stdout: &str, names: &[&str]) {
    for name in names {
        assert!(stdout.lines().any(|line| line.starts_with(name) && line.contains("p50=")), "{program} printed no {name} line:\n{stdout}");
    }
}

#[test]
fn native_reads_the_seeded_database() {
    let _case = orm_testcase::case!(orm_testcase::PROCESS);
    let program = env!("CARGO_BIN_EXE_native");
    let stdout = run_seeded(program, "30");
    assert_lines(program, &stdout, &["sqlx pk get", "sqlx list100", "sqlx insert", "sqlx relation4 + rust assembly"]);
}

#[test]
fn driver_compare_reads_the_seeded_database() {
    let _case = orm_testcase::case!(orm_testcase::PROCESS);
    let program = env!("CARGO_BIN_EXE_driver_compare");
    let stdout = run_seeded(program, "10");
    assert_lines(program, &stdout, &["sqlx pk", "mysql_async pk", "sqlx list100", "mysql_async list100"]);
}
