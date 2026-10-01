//! Prints the Rust dbspec result of every shared case and of the stress
//! document in the line format of tests/dbspec/compare/check.mjs.
//!
//! Usage: `cargo run --release -p orm-schema --example dbspec_compare -- <cases.json> <stress document>`

use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufWriter, Write};
use std::process::ExitCode;

/// Writes the lines with LF, with CRLF when `crlf` is true, or with
/// alternating CRLF and LF and no final line end when `mixed` is true.
fn join(lines: &Value, crlf: bool, mixed: bool) -> String {
    let lines: Vec<&str> = lines.as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let mut text = String::new();
    for (i, line) in lines.iter().enumerate() {
        text.push_str(line);
        if mixed {
            if i + 1 < lines.len() {
                text.push_str(if i % 2 == 0 { "\r\n" } else { "\n" });
            }
        } else {
            text.push_str(if crlf { "\r\n" } else { "\n" });
        }
    }
    text
}

/// Prints the diagnostics of `text`, or its emission when it has none.
fn write(out: &mut impl Write, text: &str, set: &BTreeMap<String, String>, stress: bool) -> std::io::Result<()> {
    match orm_schema::dbspec::parse(text, set) {
        Err(diagnostics) => {
            for d in diagnostics {
                writeln!(out, "! {} {} {}", d.rule, d.line, d.column)?;
            }
        }
        Ok(document) => {
            let emitted = orm_schema::dbspec::emit(&document);
            if stress {
                writeln!(out, "= {}", if emitted == text { "unchanged" } else { "changed" })?;
            } else {
                for line in emitted.split('\n') {
                    writeln!(out, "| {line}")?;
                }
            }
        }
    }
    Ok(())
}

fn run(cases_path: &str, stress_path: &str) -> Result<(), String> {
    let cases: Value =
        serde_json::from_str(&std::fs::read_to_string(cases_path).map_err(|e| format!("{cases_path}: {e}"))?).map_err(|e| format!("{cases_path}: {e}"))?;
    let stress = std::fs::read_to_string(stress_path).map_err(|e| format!("{stress_path}: {e}"))?;
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let io = |e: std::io::Error| e.to_string();
    for kind in ["canonical", "normalize", "invalid"] {
        for case in cases[kind].as_array().into_iter().flatten() {
            let crlf = case["crlf"] == Value::Bool(true);
            let mixed = case["mixed"] == Value::Bool(true);
            let main = case["main"].as_str().unwrap_or_default();
            let mut set = BTreeMap::new();
            for (name, lines) in case["documents"].as_object().into_iter().flatten() {
                if name != main {
                    set.insert(name.clone(), join(lines, crlf, mixed));
                }
            }
            writeln!(out, "{kind}/{}", case["id"].as_str().unwrap_or_default()).map_err(io)?;
            write(&mut out, &join(&case["documents"][main], crlf, mixed), &set, false).map_err(io)?;
        }
    }
    writeln!(out, "stress").map_err(io)?;
    write(&mut out, &stress, &BTreeMap::new(), true).map_err(io)?;
    out.flush().map_err(io)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [cases, stress] = args.as_slice() else {
        eprintln!("usage: dbspec_compare <cases.json> <stress document>");
        return ExitCode::from(2);
    };
    match run(cases, stress) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
