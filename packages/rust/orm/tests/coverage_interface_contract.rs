//! interface_contract: runs `node tests/interfaces/check/main.mts -language rust` from the repository root
//! and requires exit 0.
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The deadline for the interface check. It is wall-clock time, since another process (the extractor build and symbol extraction) does the work.
/// The check finishes within 10 s on the development machine (8 s measured in T27), and takes 1-2 minutes when the build cache is empty.
const DEADLINE: Duration = Duration::from_secs(300);

// Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64.
#[test]
fn coverage_interface_symbols() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let started = Instant::now();
    let root = polyspec_orm_testcase::manifest_dir().join("../../..");
    let mut child = Command::new("node")
        .args(["tests/interfaces/check/main.mts", "-language", "rust"])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("node tests/interfaces/check/main.mts: {e}"));
    let (closed, events) = mpsc::channel();
    let pipes: [Box<dyn Read + Send>; 2] = [Box::new(child.stdout.take().expect("piped stdout")), Box::new(child.stderr.take().expect("piped stderr"))];
    for mut pipe in pipes {
        let closed = closed.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            let read = pipe.read_to_string(&mut text).map(|_| text);
            // The receiver disappears only after the deadline passes and fails, and that failure is already reported.
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
