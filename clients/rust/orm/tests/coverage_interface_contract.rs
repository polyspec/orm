//! interface_contract: repository root에서 `go run ./tests/interfaces/check -language rust`를
//! 실행하고 exit 0을 요구한다.
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// interface check의 기한. 다른 process(go build와 symbol 추출)가 하는 일이므로 wall-clock 시간이다.
/// 그 check는 개발 machine에서 10 s 안에 끝나고(T27 측정 8 s), go build cache가 비면 1-2분 걸린다.
const DEADLINE: Duration = Duration::from_secs(300);

#[test]
#[ignore = "run by feature-check"]
fn coverage_interface_symbols() {
    let _case = orm_testcase::case!(orm_testcase::PROCESS);
    let started = Instant::now();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("go")
        .args(["run", "./tests/interfaces/check", "-language", "rust"])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("go run ./tests/interfaces/check: {e}"));
    let (closed, events) = mpsc::channel();
    let pipes: [Box<dyn Read + Send>; 2] = [Box::new(child.stdout.take().expect("piped stdout")), Box::new(child.stderr.take().expect("piped stderr"))];
    for mut pipe in pipes {
        let closed = closed.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            let read = pipe.read_to_string(&mut text).map(|_| text);
            // 수신자는 기한이 지나 실패한 뒤에만 사라지고, 그 실패가 이미 보고된다.
            if closed.send(read).is_err() {
                eprintln!("interface check output arrived after the deadline");
            }
        });
    }
    drop(closed);
    let mut output = String::new();
    for _ in 0..2 {
        match events.recv_timeout(DEADLINE.saturating_sub(started.elapsed())) {
            Ok(read) => output.push_str(&read.unwrap_or_else(|e| panic!("interface check output: {e}"))),
            Err(_) => {
                let killed = child.kill();
                let waited = child.wait();
                panic!("interface check not finished within {DEADLINE:?} (kill: {killed:?}, wait: {waited:?})");
            }
        }
    }
    let status = child.wait().unwrap_or_else(|e| panic!("interface check: {e}"));
    assert!(status.success(), "interface check failed with {status}:\n{output}");
}
