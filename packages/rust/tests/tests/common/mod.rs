//! Child process execution and feature-check input used by the coverage tests.
use polyspec_orm_testcase::OrPanic;

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The value of `variable`. Fails if it is missing or empty.
pub fn required(variable: &str) -> String {
    match std::env::var(variable) {
        Ok(value) if !value.is_empty() => value,
        _ => {
            panic!(
                "{variable} is required; coverage cases never skip; run the test through its make target, which reads the environment of make orm-test-servers"
            )
        }
    }
}

/// Runs `command` and reads the exit status after stdout and stderr are closed. Within `deadline`, the
/// pipe must close, or it ends the child and fails. It prints only `name`, so the DSN in the arguments is not revealed.
pub fn run(name: &str, mut command: Command, deadline: Duration) -> Output {
    let started = Instant::now();
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().or_panic(|e| format!("{name}: start: {e}"));
    let pipes: [Box<dyn Read + Send>; 2] = [Box::new(child.stdout.take().expect("piped stdout")), Box::new(child.stderr.take().expect("piped stderr"))];
    let (closed, events) = mpsc::channel();
    for (index, mut pipe) in pipes.into_iter().enumerate() {
        let closed = closed.clone();
        let name = name.to_owned();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let read = pipe.read_to_end(&mut bytes).map(|_| bytes);
            // The receiver is dropped only after the deadline has passed and it fails, and that failure is already reported.
            if closed.send((index, read)).is_err() {
                eprintln!("{name}: output arrived after the deadline");
            }
        });
    }
    drop(closed);
    let mut output: [Option<Vec<u8>>; 2] = [None, None];
    for _ in 0..2 {
        match events.recv_timeout(deadline.saturating_sub(started.elapsed())) {
            Ok((index, read)) => output[index] = Some(read.or_panic(|e| format!("{name}: read output: {e}"))),
            Err(_) => {
                let killed = child.kill();
                let waited = child.wait();
                panic!("{name}: not finished within {deadline:?} (kill: {killed:?}, wait: {waited:?})");
            }
        }
    }
    let status = child.wait().or_panic(|e| format!("{name}: wait: {e}"));
    let [stdout, stderr] = output.map(|bytes| bytes.expect("both pipes closed"));
    Output { status, stdout, stderr }
}
