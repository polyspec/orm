//! Checks orm-testcase's output through a child process. The fixture test works only when `TESTCASE_FIXTURE` is set,
//! and `report_form` runs this test binary again with that variable to read libtest's output.
use std::process::Command;
use std::time::Duration;

use polyspec_orm_testcase::{budget_text, case, duration, stall_text, start, step_budget, StepGuard, COMPUTE, DATABASE, PROCESS};

const FIXTURE: &str = "TESTCASE_FIXTURE";

fn fixture(name: &str) -> bool {
    std::env::var(FIXTURE).as_deref() == Ok(name)
}

fn fixture_pass() {
    if !fixture("report") {
        return;
    }
    let c = case!(COMPUTE);
    c.step("first step");
    helper_step();
}

/// Helper that prints stage lines with no case value.
fn helper_step() {
    polyspec_orm_testcase::step("helper step");
}

fn fixture_fail() {
    if !fixture("report") {
        return;
    }
    let _case = case!(COMPUTE);
    panic!("fixture failure reason\nsecond line");
}

fn fixture_inner() {
    if !fixture("report") {
        return;
    }
    let _case = case!(COMPUTE);
    let mut inner = start("fixture/inner", COMPUTE);
    inner.fail("inner failure reason");
}

#[tokio::main(flavor = "current_thread")]
async fn fixture_async() {
    if !fixture("report") {
        return;
    }
    let _case = case!(COMPUTE);
    tokio::task::yield_now().await;
}

fn fixture_deadline() {
    if !fixture("deadline") {
        return;
    }
    let _case = case!(Duration::from_millis(200));
    std::thread::sleep(Duration::from_secs(60));
}

/// The step guard ends work that reports no step within its stall limit, with the stall text of every runtime, and lets work that
/// keeps reporting steps run on.
#[tokio::main(flavor = "current_thread")]
async fn step_guard_ends_a_stalled_case() {
    let _case = case!(COMPUTE);
    let guard = StepGuard::new(Duration::from_secs(3600), Duration::from_millis(500));
    let steps = guard
        .run(async {
            for _ in 0..10 {
                guard.progressed();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
    assert_eq!(steps, Ok(()), "the guard ended work that reported its steps");
    let stalled = guard.run(tokio::time::sleep(Duration::from_secs(60))).await;
    assert_eq!(stalled, Err("no step was applied within 0.5s".to_owned()));
}

/// The step guard ends work that keeps reporting steps at its step budget, with the budget text of every runtime.
#[tokio::main(flavor = "current_thread")]
async fn step_guard_ends_a_case_past_its_budget() {
    let _case = case!(COMPUTE);
    let guard = StepGuard::new(Duration::from_millis(250), Duration::from_secs(3600));
    let spent = guard
        .run(async {
            loop {
                guard.progressed();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
    assert_eq!(spent, Err::<(), _>("step budget 0.25s exceeded".to_owned()));
}

/// The texts name the limits of a recipe case in seconds: the 120 second stall limit and the step budget of one step.
fn step_guard_names_its_limits_in_seconds() {
    let _case = case!(COMPUTE);
    assert_eq!(stall_text(DATABASE), "no step was applied within 120s");
    assert_eq!(budget_text(step_budget(1)), "step budget 60.25s exceeded");
}

/// No clock ends a case (T474): a case started without a deadline stays open while the paused clock of its runtime moves a week,
/// and ends when its work ends, so the result of a case does not depend on the time that the machine gives its work.
#[tokio::main(flavor = "current_thread", start_paused = true)]
async fn no_clock_ends_a_case() {
    let case = start("form/long");
    tokio::time::sleep(Duration::from_secs(7 * 24 * 3600)).await;
    case.step("a week of the clock passed");
    drop(case);
}

/// Runs this test binary with the fixture name and returns the exit status and output (stdout and stderr). Stages are visible with `--nocapture`.
fn run_fixture(name: &str, filter: &str) -> (Option<i32>, String) {
    let output = Command::new(std::env::current_exe().expect("test binary"))
        .args([filter, "--test-threads=1", "--nocapture"])
        .env(FIXTURE, name)
        .output()
        .expect("run the fixture binary");
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    (output.status.code(), text)
}

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
    let (code, output) = run_fixture("report", "form::fixture_");
    assert_eq!(code, Some(101), "the failing fixture fails the binary\n{output}");
    // libtest reports each test as `test <name> ... ok` or `FAILED`; a step is the test's own output.
    // The trial lines pad the name, so the report is read with one space between its words.
    let words = output.split_whitespace().collect::<Vec<_>>().join(" ");
    for expected in [
        "first step",
        "helper step",
        "test form::fixture_async ... ok",
        "test form::fixture_fail ... FAILED",
        "fixture_fail",
        "fixture failure reason",
        "test form::fixture_inner ... FAILED",
        "fixture/inner: inner failure reason",
    ] {
        assert!(words.contains(expected), "no {expected:?} in the report\n{output}");
    }
    assert!(
        !output.lines().any(|line| line.starts_with("RUN ") || line.starts_with("PASS ") || line.starts_with("FAIL ")),
        "a harness line in the report\n{output}"
    );
    let (code, output) = run_fixture("deadline", "form::fixture_deadline");
    assert_eq!(code, Some(101), "the expired fixture ends the binary\n{output}");
    assert!(output.contains("fixture_deadline: deadline 200ms exceeded and the case did not stop"), "no deadline line for the expired case\n{output}");
    assert!(
        !output.split_whitespace().collect::<Vec<_>>().join(" ").contains("test form::fixture_deadline ... ok"),
        "an ok result for the expired case\n{output}"
    );
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("form": fixture_pass, fixture_fail, fixture_inner, fixture_async, fixture_deadline, report_form, step_guard_ends_a_stalled_case, step_guard_ends_a_case_past_its_budget, step_guard_names_its_limits_in_seconds, no_clock_ends_a_case)
}
