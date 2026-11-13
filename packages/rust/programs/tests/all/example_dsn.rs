// The example programs complex and demo fail, without connecting, if ORM_BENCH_MYSQL_DSN is missing or empty,
// and print that variable name.
const DSN: &str = "ORM_BENCH_MYSQL_DSN";

fn examples_fail_when_dsn_is_unset() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    for program in &[polyspec_orm_testcase::program("complex"), polyspec_orm_testcase::program("demo")] {
        polyspec_orm_testcase::assert_env_required(program, polyspec_orm_testcase::run_with_env(program, &[], DSN, None), DSN);
    }
}

fn examples_fail_when_dsn_is_empty() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    for program in &[polyspec_orm_testcase::program("complex"), polyspec_orm_testcase::program("demo")] {
        polyspec_orm_testcase::assert_env_required(program, polyspec_orm_testcase::run_with_env(program, &[], DSN, Some("")), DSN);
    }
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("example_dsn": examples_fail_when_dsn_is_unset, examples_fail_when_dsn_is_empty)
}
