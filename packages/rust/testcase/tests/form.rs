//! orm-testcase의 출력을 하위 process로 확인한다. fixture test는 `TESTCASE_FIXTURE`가 있을
//! 때만 일하고, `report_form`이 이 test binary를 그 변수와 함께 다시 실행해 libtest의 출력을 읽는다.
use std::process::Command;
use std::time::Duration;

use polyspec_orm_testcase::{case, duration, start, COMPUTE, PROCESS};

const FIXTURE: &str = "TESTCASE_FIXTURE";

fn fixture(name: &str) -> bool {
    std::env::var(FIXTURE).as_deref() == Ok(name)
}

#[test]
fn fixture_pass() {
    if !fixture("report") {
        return;
    }
    let c = case!(COMPUTE);
    c.step("first step");
    helper_step();
}

/// case 값 없이 단계를 출력하는 helper다.
fn helper_step() {
    polyspec_orm_testcase::step("helper step");
}

#[test]
fn fixture_fail() {
    if !fixture("report") {
        return;
    }
    let _case = case!(COMPUTE);
    panic!("fixture failure reason\nsecond line");
}

#[test]
fn fixture_inner() {
    if !fixture("report") {
        return;
    }
    let _case = case!(COMPUTE);
    let mut inner = start("fixture/inner", COMPUTE);
    inner.fail("inner failure reason");
}

#[tokio::test]
async fn fixture_async() {
    if !fixture("report") {
        return;
    }
    let _case = case!(COMPUTE);
    tokio::task::yield_now().await;
}

#[test]
fn fixture_deadline() {
    if !fixture("deadline") {
        return;
    }
    let _case = case!(Duration::from_millis(200));
    std::thread::sleep(Duration::from_secs(60));
}

/// 이 test binary를 fixture 이름과 함께 실행하고 종료 상태와 출력(stdout과 stderr)을 돌려준다. `--nocapture`로 단계가 보인다.
fn run_fixture(name: &str, filter: &str) -> (Option<i32>, String) {
    let output = Command::new(std::env::current_exe().expect("test binary"))
        .args([filter, "--test-threads=1", "--nocapture"])
        .env(FIXTURE, name)
        .output()
        .expect("run the fixture binary");
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    (output.status.code(), text)
}

#[test]
fn report_form() {
    if std::env::var(FIXTURE).is_ok() {
        return;
    }
    let _case = case!(PROCESS);
    assert_eq!(duration(Duration::from_micros(500)), "500µs");
    assert_eq!(duration(Duration::from_millis(12)), "12ms");
    assert_eq!(duration(Duration::from_nanos(999_600)), "1ms");
    assert_eq!(duration(Duration::from_micros(999_600)), "1s");
    assert_eq!(duration(Duration::from_millis(1340)), "1.34s");
    assert_eq!(duration(Duration::from_secs(60)), "1m0s");
    assert_eq!(duration(Duration::from_millis(75_030)), "1m15.03s");
    assert_eq!(duration(Duration::from_secs(3600)), "1h0m0s");
    let (code, output) = run_fixture("report", "fixture_");
    assert_eq!(code, Some(101), "the failing fixture fails the binary\n{output}");
    // libtest reports each test as `test <name> ... ok` or `FAILED`; a step is the test's own output.
    for expected in [
        "first step",
        "helper step",
        "test fixture_async ... ok",
        "test fixture_fail ... FAILED",
        "fixture_fail",
        "fixture failure reason",
        "test fixture_inner ... FAILED",
        "fixture/inner: inner failure reason",
    ] {
        assert!(output.contains(expected), "no {expected:?} in the report\n{output}");
    }
    assert!(
        !output.lines().any(|line| line.starts_with("RUN ") || line.starts_with("PASS ") || line.starts_with("FAIL ")),
        "a harness line in the report\n{output}"
    );
    let (code, output) = run_fixture("deadline", "fixture_deadline");
    assert_eq!(code, Some(101), "the expired fixture ends the binary\n{output}");
    assert!(
        output.contains("fixture_deadline: deadline 200ms exceeded and the case did not stop"),
        "no deadline line for the expired case\n{output}"
    );
    assert!(!output.contains("test fixture_deadline ... ok"), "an ok result for the expired case\n{output}");
}
