use std::process::Command;
use std::time::Instant;

// native and driver_compare, against the seeded bench database of ORM_BENCH_MYSQL_DSN, read all rows of every workload
// and end with status 0, printing one statistics line per workload. Without a DSN, they
// fail.
fn run_seeded(program: &str, iterations: &str) -> String {
    let dsn = std::env::var("ORM_BENCH_MYSQL_DSN")
        .expect("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run");
    assert!(
        !dsn.is_empty(),
        "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database"
    );
    let started = Instant::now();
    let output = Command::new(program)
        .arg(iterations)
        .env("ORM_BENCH_MYSQL_DSN", dsn)
        .output()
        .expect("the benchmark must start");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!(
        "{program}: status {:?} in {:?}",
        output.status.code(),
        started.elapsed()
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{program} against the seeded bench database: {stderr}"
    );
    stdout
}

fn assert_lines(program: &str, stdout: &str, names: &[&str]) {
    for name in names {
        assert!(
            stdout
                .lines()
                .any(|line| line.starts_with(name) && line.contains("p50=")),
            "{program} printed no {name} line:\n{stdout}"
        );
    }
}

#[test]
fn native_reads_the_seeded_database() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let program = &polyspec_orm_testcase::program("native");
    let stdout = run_seeded(program, "30");
    assert_lines(
        program,
        &stdout,
        &[
            "sqlx pk get",
            "sqlx list100",
            "sqlx insert",
            "sqlx relation4 + rust assembly",
        ],
    );
}

#[test]
fn driver_compare_reads_the_seeded_database() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let program = &polyspec_orm_testcase::program("driver_compare");
    let stdout = run_seeded(program, "10");
    assert_lines(
        program,
        &stdout,
        &[
            "sqlx pk",
            "mysql_async pk",
            "sqlx list100",
            "mysql_async list100",
        ],
    );
}
