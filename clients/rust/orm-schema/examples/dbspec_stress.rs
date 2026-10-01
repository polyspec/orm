//! Measures dbspec parse and emit of the shared stress document
//! (`node tests/dbspec/stress.mjs`, 2000 tables, 60000 columns, 10000 foreign
//! keys). Run in release mode: the document is parsed five times and the
//! median parse must finish within 300 ms (docs/dbspec.md, "Verification"),
//! emission must reproduce the canonical document, and two emissions must be
//! identical.
//!
//! Usage: `cargo run --release -p orm-schema --example dbspec_stress -- <document path>`

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::{Duration, Instant};

const PARSE_BUDGET: Duration = Duration::from_millis(300);
const PARSES: usize = 5;
const RUN_DEADLINE: Duration = Duration::from_secs(10);

fn main() -> ExitCode {
    let started = Instant::now();
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("FAIL dbspec stress: missing document path argument");
        return ExitCode::FAILURE;
    };
    println!("RUN dbspec stress {path}");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("FAIL dbspec stress: {path}: {error}");
            return ExitCode::FAILURE;
        }
    };
    println!("STEP read {} bytes {} lines", text.len(), text.lines().count());
    let mut parses = Vec::with_capacity(PARSES);
    let mut parsed = None;
    for _ in 0..PARSES {
        let parse_started = Instant::now();
        let document = match orm_schema::dbspec::parse(&text, &BTreeMap::new()) {
            Ok(document) => document,
            Err(errors) => {
                for error in errors.iter().take(20) {
                    eprintln!("{error}");
                }
                eprintln!("FAIL dbspec stress: {} diagnostics", errors.len());
                return ExitCode::FAILURE;
            }
        };
        parses.push(parse_started.elapsed());
        parsed = Some(document);
    }
    let Some(document) = parsed else { unreachable!("PARSES is positive") };
    parses.sort();
    let parse_time = parses[PARSES / 2];
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    println!("STEP parse min {:.3} median {:.3} max {:.3} ms", ms(parses[0]), ms(parse_time), ms(parses[PARSES - 1]));
    let emit_started = Instant::now();
    let emitted = orm_schema::dbspec::emit(&document);
    let emit_time = emit_started.elapsed();
    println!("STEP emit {:.3} ms", emit_time.as_secs_f64() * 1000.0);
    let second = orm_schema::dbspec::emit(&document);
    let mut failed = false;
    if parse_time > PARSE_BUDGET {
        eprintln!("FAIL dbspec stress: median parse {parse_time:?} exceeds {PARSE_BUDGET:?}");
        failed = true;
    }
    if emitted != text {
        let at = emitted.bytes().zip(text.bytes()).position(|(a, b)| a != b).unwrap_or(emitted.len().min(text.len()));
        eprintln!("FAIL dbspec stress: emit(parse(doc)) differs from doc at byte {at}");
        failed = true;
    }
    if second != emitted {
        eprintln!("FAIL dbspec stress: two emissions differ");
        failed = true;
    }
    let elapsed = started.elapsed();
    if elapsed > RUN_DEADLINE {
        eprintln!("FAIL dbspec stress: {elapsed:?} exceeds {RUN_DEADLINE:?}");
        failed = true;
    }
    if failed {
        return ExitCode::FAILURE;
    }
    println!("PASS dbspec stress parse={:.3}ms emit={:.3}ms elapsed={elapsed:?}", parse_time.as_secs_f64() * 1000.0, emit_time.as_secs_f64() * 1000.0);
    ExitCode::SUCCESS
}
