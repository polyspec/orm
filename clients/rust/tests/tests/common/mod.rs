//! coverage test가 쓰는 child process 실행과 feature-check 입력.
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// `variable`의 값. 없거나 비어 있으면 실패한다.
pub fn required(variable: &str) -> String {
    match std::env::var(variable) {
        Ok(value) if !value.is_empty() => value,
        _ => panic!("{variable} is required; coverage cases never skip"),
    }
}

/// `command`를 실행하고 stdout과 stderr가 닫힌 뒤 종료 상태를 읽는다. `deadline` 안에 두
/// pipe가 닫히지 않으면 child를 끝내고 실패한다. `name`만 출력하므로 인자의 DSN은 드러나지 않는다.
pub fn run(name: &str, mut command: Command, deadline: Duration) -> Output {
    let started = Instant::now();
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap_or_else(|e| panic!("{name}: start: {e}"));
    let pipes: [Box<dyn Read + Send>; 2] = [Box::new(child.stdout.take().expect("piped stdout")), Box::new(child.stderr.take().expect("piped stderr"))];
    let (closed, events) = mpsc::channel();
    for (index, mut pipe) in pipes.into_iter().enumerate() {
        let closed = closed.clone();
        let name = name.to_owned();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let read = pipe.read_to_end(&mut bytes).map(|_| bytes);
            // 수신자는 기한이 지나 실패한 뒤에만 사라지고, 그 실패가 이미 보고된다.
            if closed.send((index, read)).is_err() {
                eprintln!("{name}: output arrived after the deadline");
            }
        });
    }
    drop(closed);
    let mut output: [Option<Vec<u8>>; 2] = [None, None];
    for _ in 0..2 {
        match events.recv_timeout(deadline.saturating_sub(started.elapsed())) {
            Ok((index, read)) => output[index] = Some(read.unwrap_or_else(|e| panic!("{name}: read output: {e}"))),
            Err(_) => {
                let killed = child.kill();
                let waited = child.wait();
                panic!("{name}: not finished within {deadline:?} (kill: {killed:?}, wait: {waited:?})");
            }
        }
    }
    let status = child.wait().unwrap_or_else(|e| panic!("{name}: wait: {e}"));
    let [stdout, stderr] = output.map(|bytes| bytes.expect("both pipes closed"));
    Output { status, stdout, stderr }
}
