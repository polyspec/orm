//! Cases and stage output for Rust tests (the Go format of legacy/packages/go/testcase).
//!
//! The result is cargo test's native output. A case is one libtest test that appears as `test <name> ... ok` or `FAILED`
//! A failure is a panic, so libtest records the reason. Stages are written to stderr, keeping them separate from the
//! `libtest-mimic` result lines on stdout; the standard libtest harness captures stderr for passing tests unless `--nocapture` is set.
//! No clock ends a case (T474): a machine under load runs the same work more slowly, and the result of a case must not change
//! with that load. A case ends when its work ends; a run that does not end is stopped with its run.
use std::fmt::Display;
use std::io::Write;
use std::thread;
use std::time::Duration;

mod groups;
mod sqlite_file;
pub use groups::{run_groups, Group};
pub use sqlite_file::SqliteFile;

/// The package directory of the running test. Reads the `CARGO_MANIFEST_DIR` that cargo test gave when running it.
/// The compile-time `env!("CARGO_MANIFEST_DIR")` puts the built path into the binary. A test reads the package directory
/// that the run decided, not the build's, so a binary that tests/cargo-test.mts copied into the run directory also uses
/// the package directory of the run. If the value is missing, the test ran outside cargo, so it panics without guessing a path.
pub fn manifest_dir() -> std::path::PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR").map(std::path::PathBuf::from).expect("CARGO_MANIFEST_DIR is unset; run the test through cargo test")
}

/// The executable path of the package's program `name` (`[[bin]]` in Cargo.toml) is read at test run time from `ORM_PROGRAM_<NAME>`
/// (uppercase, `-` becomes `_`). The checker for tests/cargo-test.mts and the feature coverage gives that variable
/// the program copied within the lease. The compile-time `env!("CARGO_BIN_EXE_<name>")` puts the target
/// directory's path into the binary, so if another run in this checkout builds that program again, it would run that
/// program. If the value is missing, the test ran outside that runner, so it panics without guessing a path.
pub fn program(name: &str) -> String {
    let variable = format!("ORM_PROGRAM_{}", name.to_uppercase().replace('-', "_"));
    match std::env::var(&variable) {
        Ok(value) => value,
        Err(_) => panic!("{variable} is unset; run the test through tests/cargo-test.mts, which gives the copied program"),
    }
}

/// Runs the program `program` with `args`, with the environment variable `var` set to `value`, or unset when `value` is `None`.
/// The output is returned for `assert_env_required`.
pub fn run_with_env(program: &str, args: &[&str], var: &str, value: Option<&str>) -> std::process::Output {
    let mut command = std::process::Command::new(program);
    command.args(args);
    match value {
        Some(v) => command.env(var, v),
        None => command.env_remove(var),
    };
    command.output().expect("the program must start")
}

/// Asserts that the output of a program exits with status 1 and says on stderr that the variable `var` is required.
pub fn assert_env_required(program: &str, output: std::process::Output, var: &str) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{program} without {var}: {stderr}");
    assert!(stderr.contains(&format!("{var} is required")), "{program} stderr lacks the {var} requirement: {stderr}");
}

/// Uses the test function name as the case name and starts the case. The case is checked for failure when it leaves scope, so
/// keep it bound with `let _case = polyspec_orm_testcase::case!();`.
#[macro_export]
macro_rules! case {
    () => {
        $crate::start($crate::test_name({
            fn here() {}
            ::std::any::type_name_of_val(&here)
        }))
    };
}

/// Changes the `crate::module::test::here` path obtained with `type_name_of_val` into the libtest test name
/// (`module::test`), removing the `{{closure}}` stage of an async test and the first crate name.
pub fn test_name(here: &str) -> String {
    let path = here.strip_suffix("::here").unwrap_or(here);
    let segments: Vec<&str> = path.split("::").filter(|segment| *segment != "{{closure}}").collect();
    if segments.len() > 1 {
        segments[1..].join("::")
    } else {
        segments.join("::")
    }
}

/// Writes the line `WARNING <message>`, saying that a performance measurement passed the documented reference value. Performance is measured and reported only; it does not fail the test
/// (AGENTS.md): a warning is not a failure. The message holds the measured value, the reference value, and the machine. The check runner collects this line into the run record
/// summary and also writes it as a GitHub Actions `::warning::` annotation.
pub fn warning(text: impl Display) {
    emit(&format!("WARNING {text}; machine {} {}", std::env::consts::OS, std::env::consts::ARCH));
}

/// Prints one diagnostic stage line to stderr, separate from test result lines on stdout.
pub fn step(text: impl Display) {
    eprintln!("{text}");
}

/// Writes in Go's time.Duration String form (1m0s, 1.5s, 12ms, 500µs). The report lines of the four languages have the same
/// form.
pub fn duration(d: Duration) -> String {
    // Picks the unit from the rounded value: 999.6ms is 1s, not 1000ms.
    let nanos = d.as_nanos();
    let micros = (nanos + 500) / 1_000;
    if micros < 1_000 {
        return format!("{micros}µs");
    }
    let rounded_millis = (nanos + 500_000) / 1_000_000;
    if rounded_millis < 1_000 {
        return format!("{rounded_millis}ms");
    }
    let millis = (nanos + 500_000) / 1_000_000;
    let trim = |ms: u128| {
        let text = format!("{}.{:03}", ms / 1000, ms % 1000);
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    if millis < 60_000 {
        return format!("{}s", trim(millis));
    }
    let hours = millis / 3_600_000;
    let minutes = (millis % 3_600_000) / 60_000;
    let rest = millis % 60_000;
    let head = if hours > 0 { format!("{hours}h") } else { String::new() };
    format!("{head}{minutes}m{}s", trim(rest))
}

/// Writes one diagnostic line straight to stderr (it does not pass through libtest's capture).
fn emit(line: &str) {
    let mut err = std::io::stderr().lock();
    if let Err(error) = writeln!(err, "{line}") {
        panic!("the diagnostic line could not be written to stderr: {error}");
    }
    if let Err(error) = err.flush() {
        panic!("stderr could not be flushed: {error}");
    }
}

/// One running case. When dropped, it checks for failure: if there is a reason, it panics so libtest reports it as a failure.
pub struct Case {
    name: String,
    failure: Option<String>,
}

/// Starts a case with name `name`; no clock ends it.
pub fn start(name: impl Into<String>) -> Case {
    Case { name: name.into(), failure: None }
}

impl Case {
    /// Prints one stage line. A case that runs long calls it at each stage, so that its progress is observable.
    pub fn step(&self, text: impl Display) {
        eprintln!("{text}");
    }

    /// The case name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Ends the case as a failure. The reason is written by drop in the panic message.
    pub fn fail(&mut self, reason: impl Display) {
        self.failure = Some(reason.to_string());
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        // If already panicking, that panic is reported as the failure, so it does not panic again.
        if !thread::panicking() {
            if let Some(reason) = self.failure.take() {
                panic!("{}: {reason}", self.name);
            }
        }
    }
}

/// The libtest-mimic trial that [`trial`] builds and [`run`] runs.
pub use libtest_mimic::Trial;

/// A libtest-mimic trial for a test target with `harness = false`: the trial `name` runs `body` as the case `name`. A vector file's case is the trial `<test>::<case id>`, so the runner reports each
/// case under its id and the filter `<test>::` selects the cases of one test. A panic in `body` fails the trial.
pub fn trial(name: impl Into<String>, body: impl FnOnce() + Send + 'static) -> libtest_mimic::Trial {
    let name = name.into();
    libtest_mimic::Trial::test(name.clone(), move || {
        let _case = start(name);
        body();
        Ok(())
    })
}

/// [`trial`] for an async case: `body` runs on a current-thread runtime of its own, as `#[tokio::test]` runs it.
pub fn async_trial<F>(name: impl Into<String>, body: impl FnOnce() -> F + Send + 'static) -> libtest_mimic::Trial
where
    F: std::future::Future<Output = ()>,
{
    trial(name, move || {
        // A debug build polls nested transactions of a recipe on the stack of this thread, and they outgrow the 2 MiB of a test
        // thread, so the case runs on the stack size that the recipe connections take.
        let thread = thread::Builder::new()
            .stack_size(64 << 20)
            .spawn(move || tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a current-thread runtime").block_on(body()))
            .expect("a thread of the case");
        if let Err(payload) = thread.join() {
            std::panic::resume_unwind(payload);
        };
    })
}

/// Runs `trials` with the arguments of the test binary's command line, as libtest does, and exits with the result.
pub fn run(trials: Vec<libtest_mimic::Trial>) -> ! {
    libtest_mimic::run(&libtest_mimic::Arguments::from_args(), trials).exit()
}

/// [`run`] for cases that share a database or a server: unless the command line gives `--test-threads`, the trials
/// run one after another, in the order of the file.
pub fn run_in_order(trials: Vec<libtest_mimic::Trial>) -> ! {
    run_in_order_then(trials, || {})
}

/// [`run_in_order`], then `after` once every trial has ended, before the exit: it releases what the trials shared.
pub fn run_in_order_then(trials: Vec<libtest_mimic::Trial>, after: impl FnOnce()) -> ! {
    let mut arguments = libtest_mimic::Arguments::from_args();
    arguments.test_threads.get_or_insert(1);
    let conclusion = libtest_mimic::run(&arguments, trials);
    after();
    conclusion.exit()
}

/// Returns the value of an `Ok`, and panics with the message `report` makes of the error otherwise.
pub trait OrPanic<T, E> {
    fn or_panic(self, report: impl FnOnce(E) -> String) -> T;
}

impl<T, E> OrPanic<T, E> for std::result::Result<T, E> {
    fn or_panic(self, report: impl FnOnce(E) -> String) -> T {
        match self {
            Ok(value) => value,
            Err(error) => panic!("{}", report(error)),
        }
    }
}
