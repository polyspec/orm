//! Rust test가 case마다 쓰는 진행 보고 형식과 case별 기한이다(internal/testcase의 Go 형식,
//! tests/testcase.mjs, tests/testcase.php와 같다).
//!
//! ```text
//! RUN <case> deadline=<기한>
//! STEP <case> elapsed=<경과>: <단계>
//! PASS <case> elapsed=<경과>
//! FAIL <case> elapsed=<경과>: <이유>
//! ```
//!
//! 줄은 stderr에 바로 쓴다. libtest의 출력 capture는 `print!` 계열 macro만 잡으므로 이 줄은
//! `--nocapture` 없이도 case가 도는 동안 보이고, stdout의 `test <name> ... ok` 줄과 섞이지 않는다.
//! 기한은 wall-clock 시간이다. 멈춘 case를 끝내는 timer이고 case 자신의 계산 시간을 재는 제한이
//! 아니기 때문이다(AGENTS.md testing rule). Rust에는 case를 끊을 수단이 없으므로 기한에 [`GRACE`]를
//! 더한 시간이 지나면 FAIL 줄을 출력하고 test process를 끝낸다. 기한을 직접 지키는 code(예:
//! `tokio::time::timeout`)는 그 전에 자기 error로 실패하고 정리를 마친다.
use std::cell::RefCell;
use std::fmt::Display;
use std::io::Write;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Once;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

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
/// compile 시점의 `env!("CARGO_MANIFEST_DIR")`는 build한 checkout의 경로를 binary에 넣는데, worktree는
/// main checkout의 target directory를 함께 쓰고 cargo는 다른 checkout에서 build한 binary를 다시
/// build하지 않으므로, 그 checkout이 지워지면 test가 fixture를 찾지 못한다. 값이 없으면 cargo 밖에서
/// 실행한 것이므로 경로를 추측하지 않고 panic한다.
pub fn manifest_dir() -> std::path::PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR").map(std::path::PathBuf::from).expect("CARGO_MANIFEST_DIR is unset; run the test through cargo test")
}

/// package의 program `name`(Cargo.toml의 `[[bin]]`)의 실행 file 경로를 test가 실행될 때 `ORM_PROGRAM_<NAME>`
/// (대문자, `-`는 `_`)에서 읽는다. tests/cargo-test.mjs와 기능 coverage checker가 공유 Rust target
/// directory의 lease 안에서 복사한 program을 그 변수로 준다. compile 시점의 `env!("CARGO_BIN_EXE_<name>")`는
/// 공유 target directory의 경로를 binary에 넣으므로, 다른 checkout이 그 program을 다시 build하면 그것을
/// 실행하게 된다. 값이 없으면 그 runner 밖에서 실행한 것이므로 경로를 추측하지 않고 panic한다.
pub fn program(name: &str) -> String {
    let variable = format!("ORM_PROGRAM_{}", name.to_uppercase().replace('-', "_"));
    std::env::var(&variable).unwrap_or_else(|_| panic!("{variable} is unset; run the test through tests/cargo-test.mjs, which gives the copied program"))
}

/// test 함수 이름을 case 이름으로 쓰고 기한 `$deadline` 아래의 case를 시작한다. 돌려준 값이
/// scope를 벗어나면 결과를 출력하므로 `let _case = orm_testcase::case!(..);`로 묶어 둔다.
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

thread_local! {
    /// 이 thread에서 마지막으로 난 panic의 message다. case가 FAIL 이유로 쓴다.
    static LAST_PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
    /// 이 thread에서 실행 중인 case의 이름과 시작 시각이다. 안쪽 case가 뒤에 온다.
    static RUNNING: RefCell<Vec<(String, Instant)>> = const { RefCell::new(Vec::new()) };
}

/// 이 thread에서 실행 중인 가장 안쪽 case의 단계 줄을 출력한다. case 값을 받지 않는 helper
/// 함수가 쓴다. 실행 중인 case가 없으면 이름 없이 출력한다.
pub fn step(text: impl Display) {
    let line = RUNNING.with(|running| match running.borrow().last() {
        Some((name, started)) => format!("STEP {name} elapsed={}: {text}", duration(started.elapsed())),
        None => format!("STEP elapsed=0s: {text}"),
    });
    emit(&line);
}

/// panic message를 thread별로 기억하는 hook을 한 번 설치한다. 원래 hook도 그대로 부른다.
fn remember_panics() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let message = if let Some(text) = info.payload().downcast_ref::<&str>() {
                (*text).to_string()
            } else if let Some(text) = info.payload().downcast_ref::<String>() {
                text.clone()
            } else {
                "panicked".to_string()
            };
            let first = message.lines().next().unwrap_or("panicked").to_string();
            LAST_PANIC.with(|last| *last.borrow_mut() = Some(first));
            previous(info);
        }));
    });
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

/// 보고 줄 하나를 stderr에 바로 쓴다.
fn emit(line: &str) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{line}");
    let _ = err.flush();
}

/// 실행 중인 case 하나다. drop될 때 PASS나 FAIL 줄을 출력한다.
pub struct Case {
    name: String,
    started: Instant,
    stop: Option<Sender<()>>,
    watchdog: Option<JoinHandle<()>>,
    failure: Option<String>,
}

/// 이름 `name`, 기한 `deadline`의 case를 시작하고 RUN 줄을 출력한다. 기한에 [`GRACE`]를 더한
/// 시간이 지나도 case가 끝나지 않으면 FAIL 줄을 출력하고 process를 끝낸다.
pub fn start(name: impl Into<String>, deadline: Duration) -> Case {
    remember_panics();
    let name = name.into();
    assert!(!deadline.is_zero(), "case {name}: the deadline is zero");
    emit(&format!("RUN {name} deadline={}", duration(deadline)));
    let started = Instant::now();
    RUNNING.with(|running| running.borrow_mut().push((name.clone(), started)));
    let (stop, stopped) = mpsc::channel::<()>();
    let watched = name.clone();
    let watchdog = thread::spawn(move || {
        if let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(deadline + GRACE) {
            emit(&format!("FAIL {watched} elapsed={}: deadline {} exceeded", duration(started.elapsed()), duration(deadline)));
            std::process::exit(101);
        }
    });
    Case { name, started, stop: Some(stop), watchdog: Some(watchdog), failure: None }
}

impl Case {
    /// case가 지금까지 걸린 시간과 함께 단계 하나를 출력한다. 1분을 넘을 수 있는 case는 단계마다
    /// 부른다.
    pub fn step(&self, text: impl Display) {
        emit(&format!("STEP {} elapsed={}: {text}", self.name, duration(self.started.elapsed())));
    }

    /// case 이름이다.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// case를 panic 없이 실패로 끝낸다. drop이 이 이유로 FAIL 줄을 출력한다.
    pub fn fail(&mut self, reason: impl Display) {
        self.failure = Some(reason.to_string());
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        RUNNING.with(|running| {
            let mut running = running.borrow_mut();
            if let Some(at) = running.iter().rposition(|(name, started)| *name == self.name && *started == self.started) {
                running.remove(at);
            }
        });
        drop(self.stop.take());
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
        let elapsed = duration(self.started.elapsed());
        if thread::panicking() {
            let reason = LAST_PANIC.with(|last| last.borrow_mut().take()).unwrap_or_else(|| "panicked".to_string());
            emit(&format!("FAIL {} elapsed={elapsed}: {reason}", self.name));
        } else if let Some(reason) = self.failure.take() {
            emit(&format!("FAIL {} elapsed={elapsed}: {reason}", self.name));
        } else {
            emit(&format!("PASS {} elapsed={elapsed}", self.name));
        }
    }
}
