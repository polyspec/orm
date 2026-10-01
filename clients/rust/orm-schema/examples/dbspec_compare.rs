//! Prints the Rust dbspec result of every shared case, of the stress
//! document, of the statement vectors and of the plan vectors in the line
//! format of tests/dbspec/compare/check.mjs.
//!
//! Usage: `cargo run --release -p orm-schema --example dbspec_compare -- <cases.json> <stress document> <ddl.json> <plans.json>`

use orm_schema::dbspec::{Change, Diagnostic, Dialect, Document, Plan};
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

fn write_diagnostics(out: &mut impl Write, diagnostics: &[orm_schema::dbspec::Diagnostic]) -> std::io::Result<()> {
    for d in diagnostics {
        writeln!(out, "! {} {} {}", d.rule, d.line, d.column)?;
    }
    Ok(())
}

/// Prints the hashes and texts of the case's document set, or the
/// diagnostics of a document or of the set.
fn write_manifest(out: &mut impl Write, case: &Value) -> std::io::Result<()> {
    let documents_value = case["documents"].as_object().into_iter().flatten().collect::<BTreeMap<_, _>>();
    let mut documents = Vec::new();
    for (name, lines) in &documents_value {
        let set = documents_value.iter().filter(|(other, _)| *other != name).map(|(other, l)| ((*other).clone(), join(l, false, false))).collect();
        match orm_schema::dbspec::parse(&join(lines, false, false), &set) {
            Ok(document) => documents.push(document),
            Err(diagnostics) => return write_diagnostics(out, &diagnostics),
        }
    }
    let refs: Vec<&orm_schema::dbspec::Document> = documents.iter().collect();
    match orm_schema::dbspec::manifest(&refs) {
        Err(diagnostics) => write_diagnostics(out, &diagnostics),
        Ok(m) => {
            writeln!(out, "= manifestHash {}\n= schemaHash {}\n= manifestText", m.manifest_hash, m.schema_hash)?;
            for line in m.manifest_text.split('\n') {
                writeln!(out, "| {line}")?;
            }
            writeln!(out, "= schemaText")?;
            for line in m.schema_text.split('\n') {
                writeln!(out, "| {line}")?;
            }
            Ok(())
        }
    }
}

/// Prints the statements of the case's document set in every dialect, or the
/// diagnostics of a document or of the set.
fn write_render(out: &mut impl Write, case: &Value) -> std::io::Result<()> {
    let id = case["id"].as_str().unwrap_or_default();
    let documents_value = case["documents"].as_object().into_iter().flatten().collect::<BTreeMap<_, _>>();
    let mut documents = Vec::new();
    for (name, lines) in &documents_value {
        let set = documents_value.iter().filter(|(other, _)| *other != name).map(|(other, l)| ((*other).clone(), join(l, false, false))).collect();
        match orm_schema::dbspec::parse(&join(lines, false, false), &set) {
            Ok(document) => documents.push(document),
            Err(diagnostics) => {
                writeln!(out, "render/{id}")?;
                return write_diagnostics(out, &diagnostics);
            }
        }
    }
    let refs: Vec<&orm_schema::dbspec::Document> = documents.iter().collect();
    for (name, dialect) in [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)] {
        writeln!(out, "render/{id}/{name}")?;
        match orm_schema::dbspec::render(&refs, dialect) {
            Ok(statements) => {
                for statement in statements {
                    writeln!(out, "| {statement}")?;
                }
            }
            Err(diagnostics) => write_diagnostics(out, &diagnostics)?,
        }
    }
    Ok(())
}

/// Prints diagnostics; a plan or chain diagnostic ends with its message,
/// which every client shares, and a schema diagnostic of the target or
/// source does not.
fn write_plan_diagnostics(out: &mut impl Write, diagnostics: &[Diagnostic]) -> std::io::Result<()> {
    for d in diagnostics {
        if d.rule == orm_schema::dbspec::RULE_PLAN || d.rule == orm_schema::dbspec::RULE_CHAIN {
            writeln!(out, "! {} {} {} {}", d.rule, d.line, d.column, d.message)?;
        } else {
            writeln!(out, "! {} {} {}", d.rule, d.line, d.column)?;
        }
    }
    Ok(())
}

/// Prints the changes as `| kind table name`.
fn write_changes(out: &mut impl Write, changes: &[Change]) -> std::io::Result<()> {
    for c in changes {
        writeln!(out, "| {} {} {}", c.kind, c.table, c.name)?;
    }
    Ok(())
}

fn write_emitted_plan(out: &mut impl Write, plan: &Plan) -> std::io::Result<()> {
    for line in orm_schema::dbspec::emit_plan(plan).split('\n') {
        writeln!(out, "| {line}")?;
    }
    Ok(())
}

/// The source schema of a plan case, `None` for the empty schema, or `Err`
/// after printing its diagnostics.
fn plan_source(out: &mut impl Write, lines: &Value) -> std::io::Result<Result<Option<Document>, ()>> {
    if lines.is_null() {
        return Ok(Ok(None));
    }
    match orm_schema::dbspec::parse(&join(lines, false, false), &BTreeMap::new()) {
        Ok(document) => Ok(Ok(Some(document))),
        Err(diagnostics) => {
            write_plan_diagnostics(out, &diagnostics)?;
            Ok(Err(()))
        }
    }
}

/// Prints, for every plan case, the emitted plan, the changes and the
/// statements of each dialect; for every invalid case its diagnostics; for
/// every chain case the chain order or its diagnostics; and for every parse
/// case its diagnostics or the emitted plan.
fn write_plans(out: &mut impl Write, plans: &Value) -> std::io::Result<()> {
    for case in plans["cases"].as_array().into_iter().flatten() {
        let id = case["id"].as_str().unwrap_or_default();
        writeln!(out, "plans/cases/{id}")?;
        let Ok(source) = plan_source(out, &case["source"])? else { continue };
        let plan = match orm_schema::dbspec::parse_plan(&join(&case["plan"], false, false)) {
            Ok(plan) => plan,
            Err(diagnostics) => {
                write_plan_diagnostics(out, &diagnostics)?;
                continue;
            }
        };
        write_emitted_plan(out, &plan)?;
        writeln!(out, "plans/cases/{id}/changes")?;
        match orm_schema::dbspec::diff(source.as_ref(), &plan) {
            Ok(changes) => write_changes(out, &changes)?,
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
        for (name, dialect) in [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)] {
            writeln!(out, "plans/cases/{id}/{name}")?;
            match orm_schema::dbspec::plan_statements(source.as_ref(), &plan, dialect) {
                Ok(statements) => {
                    for statement in statements {
                        writeln!(out, "| {statement}")?;
                    }
                }
                Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
            }
        }
    }
    for case in plans["invalid"].as_array().into_iter().flatten() {
        writeln!(out, "plans/invalid/{}", case["id"].as_str().unwrap_or_default())?;
        let Ok(source) = plan_source(out, &case["source"])? else { continue };
        match orm_schema::dbspec::parse_plan(&join(&case["plan"], false, false)) {
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
            Ok(plan) => match orm_schema::dbspec::diff(source.as_ref(), &plan) {
                Ok(changes) => write_changes(out, &changes)?,
                Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
            },
        }
    }
    for case in plans["chains"].as_array().into_iter().flatten() {
        writeln!(out, "plans/chains/{}", case["id"].as_str().unwrap_or_default())?;
        let mut parsed = Vec::new();
        let mut failed = false;
        for lines in case["plans"].as_array().into_iter().flatten() {
            match orm_schema::dbspec::parse_plan(&join(lines, false, false)) {
                Ok(plan) => parsed.push(plan),
                Err(diagnostics) => {
                    write_plan_diagnostics(out, &diagnostics)?;
                    failed = true;
                }
            }
        }
        if failed {
            continue;
        }
        match orm_schema::dbspec::chain(&parsed) {
            Ok(chain) => {
                for plan in chain {
                    writeln!(out, "| {}", plan.name())?;
                }
            }
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
    }
    for case in plans["parse"].as_array().into_iter().flatten() {
        writeln!(out, "plans/parse/{}", case["id"].as_str().unwrap_or_default())?;
        match orm_schema::dbspec::parse_plan(&join(&case["plan"], false, false)) {
            Ok(plan) => write_emitted_plan(out, &plan)?,
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
    }
    Ok(())
}

fn run(cases_path: &str, stress_path: &str, ddl_path: &str, plans_path: &str) -> Result<(), String> {
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
    for case in cases["hashes"].as_array().into_iter().flatten() {
        writeln!(out, "hashes/{}", case["id"].as_str().unwrap_or_default()).map_err(io)?;
        write_manifest(&mut out, case).map_err(io)?;
    }
    let ddl: Value =
        serde_json::from_str(&std::fs::read_to_string(ddl_path).map_err(|e| format!("{ddl_path}: {e}"))?).map_err(|e| format!("{ddl_path}: {e}"))?;
    for case in ddl["cases"].as_array().into_iter().flatten() {
        write_render(&mut out, case).map_err(io)?;
    }
    let plans: Value =
        serde_json::from_str(&std::fs::read_to_string(plans_path).map_err(|e| format!("{plans_path}: {e}"))?).map_err(|e| format!("{plans_path}: {e}"))?;
    write_plans(&mut out, &plans).map_err(io)?;
    out.flush().map_err(io)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [cases, stress, ddl, plans] = args.as_slice() else {
        eprintln!("usage: dbspec_compare <cases.json> <stress document> <ddl.json> <plans.json>");
        return ExitCode::from(2);
    };
    match run(cases, stress, ddl, plans) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
