//! Rust test의 case별 기한과 단계 출력이다(internal/testcase의 Go 형식, tests/testcase.mts와 같은 기한 등급을 쓴다).
//!
//! 결과는 cargo test의 native 출력이다. case는 libtest의 test 하나이고 `test <name> ... ok`나 `FAILED`로
//! 나온다. 실패는 panic이므로 libtest가 이유를 적는다. 단계는 `println!`으로 쓰므로 libtest의 출력 capture를
//! 따른다: 통과한 test의 단계는 `--nocapture` 없이 보이지 않고, 실패한 test의 단계는 그 test의 출력으로 보인다.
//! 기한은 wall-clock 시간이다. 멈춘 case를 끝내는 timer이고 case 자신의 계산 시간을 재는 제한이 아니기 때문이다
//! (AGENTS.md testing rule). Rust에는 case를 끊을 수단이 없으므로 기한에 [`GRACE`]를 더한 시간이 지나면 진단을
//! stderr에 쓰고 test process를 끝낸다. 기한을 직접 지키는 code(예: `tokio::time::timeout`)는 그 전에 자기 error로
//! 실패하고 정리를 마친다.
use std::fmt::Display;
use std::io::Write;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// memory 안의 계산과 repository file 읽기만 하는 case의 기한이다. 기준: 이런 case 가운데 가장
/// 큰 것(dbspec stress 문서의 parse와 emit)이 몇 초 안에 끝나므로, 1분을 넘긴 case는 멈춘 것이다.
pub const COMPUTE: Duration = Duration::from_secs(60);
/// TEST_ENV의 database에 연결해 정해진 수의 statement를 실행하는 case의 기한이다. 기준: database를
/// 만들고 지우는 일과 공유 server에서 lock을 기다리는 시간까지 2분이면 넉넉하다.
pub const DATABASE: Duration = Duration::from_secs(120);
/// `go run`, cargo, php, node 같은 하위 process를 실행하는 case의 기한이다. 기준: build cache가
/// 비었을 때 compile에 몇 분이 걸린다.
pub const PROCESS: Duration = Duration::from_secs(300);
/// 기한이 지난 뒤 process를 끝내기까지 기다리는 시간이다.
pub const GRACE: Duration = Duration::from_secs(5);

/// 자기 계산의 CPU 시간 한도 `limit`를 검사하는 case의 wall-clock 기한이다. timing-check가 test
/// process에 CPU의 10분의 1만 주므로 한도의 열 배다. 한도 자체는 case가 CPU 시간으로 검사한다.
pub fn wall_for_cpu(limit: Duration) -> Duration {
    limit * 10
}

/// 실행 중인 test의 package directory다. cargo test가 실행할 때 준 `CARGO_MANIFEST_DIR`를 읽는다.
/// compile 시점의 `env!("CARGO_MANIFEST_DIR")`는 build한 경로를 binary에 넣는다. test는 build가 아니라
/// 실행이 정한 package directory를 읽으므로, tests/cargo-test.mts가 실행 directory에 복사한 binary도 그
/// 실행의 package directory를 쓴다. 값이 없으면 cargo 밖에서 실행한 것이므로 경로를 추측하지 않고 panic한다.
pub fn manifest_dir() -> std::path::PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR").map(std::path::PathBuf::from).expect("CARGO_MANIFEST_DIR is unset; run the test through cargo test")
}

/// package의 program `name`(Cargo.toml의 `[[bin]]`)의 실행 file 경로를 test가 실행될 때 `ORM_PROGRAM_<NAME>`
/// (대문자, `-`는 `_`)에서 읽는다. tests/cargo-test.mts와 기능 coverage checker가 Rust target directory의
/// lease 안에서 복사한 program을 그 변수로 준다. compile 시점의 `env!("CARGO_BIN_EXE_<name>")`는 target
/// directory의 경로를 binary에 넣으므로, 이 checkout의 다른 실행이 그 program을 다시 build하면 그것을
/// 실행하게 된다. 값이 없으면 그 runner 밖에서 실행한 것이므로 경로를 추측하지 않고 panic한다.
pub fn program(name: &str) -> String {
    let variable = format!("ORM_PROGRAM_{}", name.to_uppercase().replace('-', "_"));
    std::env::var(&variable).unwrap_or_else(|_| panic!("{variable} is unset; run the test through tests/cargo-test.mts, which gives the copied program"))
}

/// test 함수 이름을 case 이름으로 쓰고 기한 `$deadline` 아래의 case를 시작한다. case는 scope를 벗어날 때
/// 실패를 확인하므로 `let _case = polyspec_orm_testcase::case!(..);`로 묶어 둔다.
#[macro_export]
macro_rules! case {
    ($deadline:expr) => {
        $crate::start(
            $crate::test_name({
                fn here() {}
                ::std::any::type_name_of_val(&here)
            }),
            $deadline,
        )
    };
}

/// `type_name_of_val`로 얻은 `crate::module::test::here` 경로를 libtest의 test 이름
/// (`module::test`)으로 바꾼다. async test의 `{{closure}}` 단계와 첫 crate 이름을 뺀다.
pub fn test_name(here: &str) -> String {
    let path = here.strip_suffix("::here").unwrap_or(here);
    let segments: Vec<&str> = path.split("::").filter(|segment| *segment != "{{closure}}").collect();
    if segments.len() > 1 {
        segments[1..].join("::")
    } else {
        segments.join("::")
    }
}

/// 성능 측정이 문서의 기준값을 넘었다는 줄 `WARNING <message>`를 쓴다. 성능은 측정하고 보고할 뿐 test를 실패시키지
/// 않는다(AGENTS.md): 경고는 실패가 아니다. message는 측정값, 기준값, 기계를 담는다. check runner는 이 줄을 실행 기록과
/// summary에 모으고 GitHub Actions의 `::warning::` annotation으로도 쓴다.
pub fn warning(text: impl Display) {
    emit(&format!("WARNING {text}; machine {} {}", std::env::consts::OS, std::env::consts::ARCH));
}

/// 단계 한 줄을 출력한다. case 값을 받지 않는 helper 함수가 쓴다. libtest가 test의 출력을 capture하므로 실패한 test에서만 보인다.
pub fn step(text: impl Display) {
    println!("{text}");
}

/// Go time.Duration의 String 형식(1m0s, 1.5s, 12ms, 500µs)으로 쓴다. 네 언어의 보고 줄이 같은
/// 형식을 가진다.
pub fn duration(d: Duration) -> String {
    // 반올림한 값으로 단위를 고른다. 999.6ms는 1000ms가 아니라 1s다.
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

/// 진단 줄 하나를 stderr에 바로 쓴다(libtest의 capture를 거치지 않는다).
fn emit(line: &str) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{line}");
    let _ = err.flush();
}

/// 실행 중인 case 하나다. drop될 때 실패를 확인한다: 이유가 있으면 panic하여 libtest가 실패로 보고한다.
pub struct Case {
    name: String,
    stop: Option<Sender<()>>,
    watchdog: Option<JoinHandle<()>>,
    failure: Option<String>,
}

/// 이름 `name`, 기한 `deadline`의 case를 시작한다. 기한에 [`GRACE`]를 더한 시간이 지나도 case가 끝나지 않으면
/// 진단을 stderr에 쓰고 process를 끝낸다.
pub fn start(name: impl Into<String>, deadline: Duration) -> Case {
    let name = name.into();
    assert!(!deadline.is_zero(), "case {name}: the deadline is zero");
    let (stop, stopped) = mpsc::channel::<()>();
    let watched = name.clone();
    let watchdog = thread::spawn(move || {
        if let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(deadline + GRACE) {
            emit(&format!("{watched}: deadline {} exceeded and the case did not stop", duration(deadline)));
            std::process::exit(101);
        }
    });
    Case { name, stop: Some(stop), watchdog: Some(watchdog), failure: None }
}

impl Case {
    /// 단계 한 줄을 출력한다. 1분을 넘을 수 있는 case는 단계마다 부른다.
    pub fn step(&self, text: impl Display) {
        println!("{text}");
    }

    /// case 이름이다.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// case를 실패로 끝낸다. 이유는 drop이 panic 메시지로 쓴다.
    pub fn fail(&mut self, reason: impl Display) {
        self.failure = Some(reason.to_string());
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
        // 이미 panic 중이면 그 panic이 실패로 보고되므로 다시 panic하지 않는다.
        if !thread::panicking() {
            if let Some(reason) = self.failure.take() {
                panic!("{}: {reason}", self.name);
            }
        }
    }
}

/// The libtest-mimic trial that [`trial`] builds and [`run`] runs.
pub use libtest_mimic::Trial;

/// A libtest-mimic trial for a test target with `harness = false`: the trial `name` runs `body` as the case `name`
/// with the deadline `deadline`. A vector file's case is the trial `<test>::<case id>`, so the runner reports each
/// case under its id and the filter `<test>::` selects the cases of one test. A panic in `body` fails the trial.
pub fn trial(name: impl Into<String>, deadline: Duration, body: impl FnOnce() + Send + 'static) -> libtest_mimic::Trial {
    let name = name.into();
    libtest_mimic::Trial::test(name.clone(), move || {
        let _case = start(name, deadline);
        body();
        Ok(())
    })
}

/// [`trial`] for an async case: `body` runs on a current-thread runtime of its own, as `#[tokio::test]` runs it.
pub fn async_trial<F>(name: impl Into<String>, deadline: Duration, body: impl FnOnce() -> F + Send + 'static) -> libtest_mimic::Trial
where
    F: std::future::Future<Output = ()>,
{
    trial(name, deadline, move || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a current-thread runtime").block_on(body());
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
