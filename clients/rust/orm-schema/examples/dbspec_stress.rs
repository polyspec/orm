//! Measures dbspec parse and emit of the shared stress document
//! (`node tests/dbspec/stress.mjs`, 2000 tables, 60000 columns, 10000 foreign
//! keys). Run in release mode: the document is parsed five times, and the
//! median parse CPU time of the main thread and its ratio to the reference
//! work are printed, with a warning above the reference ratio (docs/dbspec.md,
//! "Verification"); a measurement never fails the run,
//! emission must reproduce the canonical document, and two emissions must be
//! identical.
//!
//! Usage: `cargo run --release -p orm-schema --example dbspec_stress -- <document path>`

use orm_case_clock::CaseClock;
use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::Duration;

/// The documented reference value of the ratio of the median parse CPU time to the median CPU time of the reference
/// work (docs/dbspec.md, "Verification"). A ratio above it prints a warning; a measurement never fails the run.
const REFERENCE_RATIO: f64 = 34.0;
const PARSES: usize = 5;
const RUN_DEADLINE: Duration = Duration::from_secs(10);

fn main() -> ExitCode {
    let run = CaseClock::start();
    // stress case의 wall-clock 기한은 CPU 한도 RUN_DEADLINE의 열 배다(timing-check).
    let mut case = orm_testcase::start("dbspec stress", orm_testcase::wall_for_cpu(RUN_DEADLINE));
    let Some(path) = std::env::args().nth(1) else {
        case.fail("missing document path argument");
        return ExitCode::FAILURE;
    };
    case.step(format_args!("document {path}"));
    let text = match orm_schema::dbspec::read_file(std::path::Path::new(&path)) {
        Ok(text) => text,
        Err(orm_schema::dbspec::ReadError::Io(error)) => {
            case.fail(format_args!("{path}: {error}"));
            return ExitCode::FAILURE;
        }
        Err(orm_schema::dbspec::ReadError::Diagnostics(errors)) => {
            case.fail(&errors[0].message);
            return ExitCode::FAILURE;
        }
    };
    case.step(format_args!("read {} bytes {} lines", text.len(), text.lines().count()));
    let mut parses = Vec::with_capacity(PARSES);
    let mut parsed = None;
    for _ in 0..PARSES {
        let parse = CaseClock::start();
        let document = match orm_schema::dbspec::parse(&text, &BTreeMap::new()) {
            Ok(document) => document,
            Err(errors) => {
                for error in errors.iter().take(20) {
                    eprintln!("{error}");
                }
                case.fail(format_args!("{} diagnostics", errors.len()));
                return ExitCode::FAILURE;
            }
        };
        let (cpu, wall) = (parse.cpu(), parse.wall());
        case.step(format_args!("parse cpu={cpu:?} wall={wall:?}"));
        parses.push(cpu);
        parsed = Some(document);
    }
    let Some(document) = parsed else { unreachable!("PARSES is positive") };
    parses.sort();
    let parse_time = parses[PARSES / 2];
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    case.step(format_args!("parse cpu min {:.3} median {:.3} max {:.3} ms", ms(parses[0]), ms(parse_time), ms(parses[PARSES - 1])));
    // 기준 작업은 같은 문서의 byte마다 checksum을 갱신하는 loop다. 네 client가 같은 계산을 같은 시계로 재고, parse
    // 시간과의 비율을 적는다. 비율은 아직 판정에 쓰지 않는다(docs/dbspec.md, Verification).
    let mut references = Vec::with_capacity(PARSES);
    let mut sum = 0;
    for _ in 0..PARSES {
        let reference = CaseClock::start();
        sum = std::hint::black_box(reference_scan(std::hint::black_box(text.as_bytes())));
        references.push(reference.cpu());
    }
    references.sort();
    let reference_time = references[PARSES / 2];
    case.step(format_args!("reference cpu median {:.3} ms ratio {:.2} sum {sum}", ms(reference_time), parse_time.as_secs_f64() / reference_time.as_secs_f64()));
    let emit = CaseClock::start();
    let emitted = orm_schema::dbspec::emit(&document);
    let emit_time = emit.cpu();
    case.step(format_args!("emit {:.3} ms", emit_time.as_secs_f64() * 1000.0));
    let second = orm_schema::dbspec::emit(&document);
    let mut failures = Vec::new();
    let ratio = parse_time.as_secs_f64() / reference_time.as_secs_f64();
    case.step(format_args!(
        "parse ratio {ratio:.2} to the reference on {} {} (reference ratio {REFERENCE_RATIO})",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    if ratio > REFERENCE_RATIO {
        orm_testcase::warning(format_args!(
            "median parse cpu {:.3} ms is {ratio:.2} times the reference cpu {:.3} ms, above the reference ratio {REFERENCE_RATIO} (docs/dbspec.md, Verification)",
            ms(parse_time),
            ms(reference_time)
        ));
    }
    if emitted != text {
        let at = emitted.bytes().zip(text.bytes()).position(|(a, b)| a != b).unwrap_or(emitted.len().min(text.len()));
        failures.push(format!("emit(parse(doc)) differs from doc at byte {at}"));
    }
    if second != emitted {
        failures.push("two emissions differ".to_owned());
    }
    let (cpu, wall) = (run.cpu(), run.wall());
    if cpu > RUN_DEADLINE {
        orm_testcase::warning(format_args!("dbspec stress used cpu {cpu:?} (wall {wall:?}), above its reference of {RUN_DEADLINE:?}"));
    }
    if !failures.is_empty() {
        case.fail(failures.join("; "));
        return ExitCode::FAILURE;
    }
    case.step(format_args!("parse={:.3}ms emit={:.3}ms cpu={cpu:?} wall={wall:?}", parse_time.as_secs_f64() * 1000.0, emit_time.as_secs_f64() * 1000.0));
    ExitCode::SUCCESS
}

/// The reference work of the stress document: for each byte, h = h * 31 + b (mod 2^32), in order.
fn reference_scan(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0u32, |h, &b| h.wrapping_mul(31).wrapping_add(u32::from(b)))
}
