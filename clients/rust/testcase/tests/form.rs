//! orm-testcase의 보고 형식을 하위 process로 확인한다. fixture test는 `TESTCASE_FIXTURE`가 있을
//! 때만 일하고, `report_form`이 이 test binary를 그 변수와 함께 다시 실행해 출력을 읽는다.
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

/// 이 test binary를 fixture 이름과 함께 실행하고 종료 상태와 stderr를 돌려준다.
fn run_fixture(name: &str, filter: &str) -> (Option<i32>, String) {
    let output = Command::new(std::env::current_exe().expect("test binary"))
        .args([filter, "--test-threads=1"])
        .env(FIXTURE, name)
        .output()
        .expect("run the fixture binary");
    (output.status.code(), String::from_utf8_lossy(&output.stderr).into_owned())
}

/// `output`에 `patterns`가 이 순서로 한 줄씩 나타나는지 확인한다. pattern의 `*`는 경과 시간이다.
fn in_order(output: &str, patterns: &[&str]) {
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    let mut at = 0;
    for pattern in patterns {
        let (head, tail) = pattern.split_once('*').unwrap_or((pattern, ""));
        let found = lines[at..].iter().position(|line| {
            if tail.is_empty() && !pattern.contains('*') {
                *line == *pattern
            } else {
                line.starts_with(head) && line.ends_with(tail) && line.len() > head.len() + tail.len()
            }
        });
        match found {
            Some(offset) => at += offset + 1,
            None => panic!("no line matching {pattern:?} in order\n{output}"),
        }
    }
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
    in_order(
        &output,
        &[
            "RUN fixture_pass deadline=1m0s",
            "STEP fixture_pass elapsed=*: first step",
            "STEP fixture_pass elapsed=*: helper step",
            "PASS fixture_pass elapsed=*",
        ],
    );
    in_order(&output, &["RUN fixture_fail deadline=1m0s", "FAIL fixture_fail elapsed=*: fixture failure reason"]);
    in_order(
        &output,
        &[
            "RUN fixture_inner deadline=1m0s",
            "RUN fixture/inner deadline=1m0s",
            "FAIL fixture/inner elapsed=*: inner failure reason",
            "PASS fixture_inner elapsed=*",
        ],
    );
    in_order(&output, &["RUN fixture_async deadline=1m0s", "PASS fixture_async elapsed=*"]);
    let (code, output) = run_fixture("deadline", "fixture_deadline");
    assert_eq!(code, Some(101), "the expired fixture ends the binary\n{output}");
    in_order(&output, &["RUN fixture_deadline deadline=200ms", "FAIL fixture_deadline elapsed=*: deadline 200ms exceeded"]);
    assert!(!output.contains("PASS fixture_deadline"), "PASS line for the expired case\n{output}");
}
