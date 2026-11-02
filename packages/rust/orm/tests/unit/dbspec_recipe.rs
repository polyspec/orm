//! The dbspec plan recipes of tests/dbspec (docs/spec/feature-coverage.md FCV-3, FCV-4) without a database: the shared helper of
//! the four entries plan_invalid, plan_chains, plan_parse and plan_comparisons. Each dbspec op maps to one public call of
//! `polyspec_orm::dbspec`, and its result is compared with the `none` part of its expect as JSON.

use polyspec_orm::dbspec::{chain, compare_schemas, diff, emit_plan, parse, parse_plan, plan_steps, Diagnostic, Dialect, Document, Plan, PlanStep};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

/// A value that a step binds with `as`.
#[derive(Clone)]
enum Bound {
    Document(Document),
    Plan(Plan),
}

/// The text of the lines of a step, each ended by LF (the lines joined by LF, then one LF).
fn text(lines: &Value) -> String {
    let lines: Vec<&str> = lines.as_array().expect("lines").iter().map(|line| line.as_str().expect("line")).collect();
    format!("{}\n", lines.join("\n"))
}

/// The diagnostics as [rule, line, column, message]; the message is kept for rule plan, or for every rule when `every`.
fn rows(diagnostics: &[Diagnostic], every: bool) -> Value {
    Value::Array(
        diagnostics
            .iter()
            .map(|d| {
                let message = if every || d.rule == "plan" { Value::from(d.message.clone()) } else { Value::Null };
                json!([d.rule, d.line, d.column, message])
            })
            .collect(),
    )
}

/// The messages of the diagnostics, each of rule `rule`.
fn messages(diagnostics: &[Diagnostic], rule: &str) -> Value {
    Value::Array(
        diagnostics
            .iter()
            .map(|d| {
                assert_eq!(d.rule, rule, "diagnostic of rule {}, want {rule}: {}", d.rule, d.message);
                Value::from(d.message.clone())
            })
            .collect(),
    )
}

/// The value that the ref of raw binds by an earlier step.
fn reference<'b>(raw: &Value, bound: &'b HashMap<String, Bound>) -> &'b Bound {
    let name = raw["ref"].as_str().unwrap_or_else(|| panic!("{raw} is not a ref"));
    bound.get(name).unwrap_or_else(|| panic!("ref {name} binds no value"))
}

fn document<'b>(raw: &Value, bound: &'b HashMap<String, Bound>) -> &'b Document {
    match reference(raw, bound) {
        Bound::Document(document) => document,
        Bound::Plan(_) => panic!("ref {raw} binds a plan, want a document"),
    }
}

fn plan<'b>(raw: &Value, bound: &'b HashMap<String, Bound>) -> &'b Plan {
    match reference(raw, bound) {
        Bound::Plan(plan) => plan,
        Bound::Document(_) => panic!("ref {raw} binds a document, want a plan"),
    }
}

/// The object of a plan step (docs/spec/plans.md "Steps"): its statement, its effect as text, and the fields that the step has.
fn step_fields(s: &PlanStep) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("statement".into(), Value::from(s.statement.clone()));
    out.insert("effect".into(), Value::from(s.effect.to_string()));
    if !s.rollback.is_empty() {
        out.insert("rollback".into(), Value::from(s.rollback.clone()));
    } else if !s.irreversible.is_empty() {
        out.insert("irreversible".into(), Value::from(s.irreversible.clone()));
    }
    if !s.restore.is_empty() {
        out.insert("restore".into(), Value::from(s.restore.clone()));
    }
    if !s.rollback_restore.is_empty() {
        out.insert("rollback_restore".into(), Value::from(s.rollback_restore.clone()));
    }
    if let Some(e) = s.restore_if.as_ref().filter(|_| !s.restore.is_empty() || !s.rollback_restore.is_empty()) {
        out.insert("restore_if".into(), Value::from(e.to_string()));
    }
    if !s.null_checks.is_empty() {
        let checks = s
            .null_checks
            .iter()
            .map(|c| Value::Array(vec![c.table.clone().into(), c.column.clone().into(), c.default.clone().map_or(Value::Null, Value::from)]))
            .collect();
        out.insert("null_checks".into(), Value::Array(checks));
    }
    if s.finalize {
        out.insert("finalize".into(), Value::Bool(true));
    }
    Value::Object(out)
}

/// The dialect that a name gives (mysql, postgres or sqlite).
fn dialect(name: &str) -> Dialect {
    match name {
        "mysql" => Dialect::MySql,
        "postgres" => Dialect::Postgres,
        "sqlite" => Dialect::Sqlite,
        other => panic!("dialect {other} is not mysql, postgres or sqlite"),
    }
}

/// Runs one dbspec step and returns its result in the form of its expect.
fn run_step(step: &Value, bound: &mut HashMap<String, Bound>) -> Value {
    let op = step["op"].as_str().expect("op");
    let binds = step["as"].as_str().map(str::to_owned);
    match op {
        "dbspec.parse" => match parse(&text(&step["lines"]), &BTreeMap::new()) {
            Ok(parsed) => {
                if let Some(name) = binds {
                    bound.insert(name, Bound::Document(parsed.document));
                }
                json!({"diagnostics": []})
            }
            Err(diagnostics) => json!({"diagnostics": rows(&diagnostics, false)}),
        },
        "dbspec.parse_plan" => match parse_plan(&text(&step["lines"])) {
            Ok(parsed) => {
                if let Some(name) = binds {
                    bound.insert(name, Bound::Plan(parsed));
                }
                json!({"diagnostics": []})
            }
            Err(diagnostics) => json!({"diagnostics": rows(&diagnostics, false)}),
        },
        "dbspec.emit_plan" => json!({"text": emit_plan(plan(&step["plan"], bound))}),
        "dbspec.plan_steps" => {
            let source = step.get("source").filter(|raw| !raw.is_null()).map(|raw| document(raw, bound));
            match plan_steps(source, plan(&step["plan"], bound), dialect(step["dialect"].as_str().expect("dialect"))) {
                Ok(steps) => json!({"steps": steps.iter().map(step_fields).collect::<Vec<Value>>()}),
                Err(diagnostics) => json!({"messages": messages(&diagnostics, "plan")}),
            }
        }
        "dbspec.diff" => {
            let source = step.get("source").filter(|raw| !raw.is_null()).map(|raw| document(raw, bound));
            match diff(source, plan(&step["plan"], bound)) {
                Ok(changes) => json!({"changes": changes.iter().map(|c| json!([c.kind, c.table, c.name])).collect::<Vec<Value>>()}),
                Err(diagnostics) => json!({"messages": messages(&diagnostics, "plan")}),
            }
        }
        "dbspec.chain" => {
            let plans: Vec<Plan> = step["plans"].as_array().expect("plans").iter().map(|raw| plan(raw, bound).clone()).collect();
            match chain(&plans) {
                Ok(ordered) => json!({"order": ordered.iter().map(|p| p.name()).collect::<Vec<&str>>()}),
                Err(diagnostics) => json!({"messages": messages(&diagnostics, "chain")}),
            }
        }
        "dbspec.compare" => match compare_schemas(document(&step["source"], bound), document(&step["target"], bound)) {
            Ok(differences) => json!({
                "differences": differences.iter().map(|d| json!([d.kind, d.table, d.name])).collect::<Vec<Value>>(),
                "diagnostics": [],
            }),
            Err(diagnostics) => json!({"differences": [], "diagnostics": rows(&diagnostics, true)}),
        },
        _ => panic!("OP_UNKNOWN {op}"),
    }
}

/// The repository path `at`, relative to the root of the checkout.
fn repository(at: &str) -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../..").join(at)
}

/// Registers one trial per case of the recipe at `path`, named `<prefix>::<case id>`, and runs them.
pub fn run(path: &str, prefix: &str) {
    let recipe: Value = serde_json::from_str(&std::fs::read_to_string(repository(path)).expect("recipe")).expect("recipe is JSON");
    let cases = recipe["cases"].as_array().expect("cases").clone();
    assert!(!cases.is_empty(), "{path} has no cases");
    let trials: Vec<_> = cases
        .into_iter()
        .map(|case| {
            let id = case["id"].as_str().expect("id").to_owned();
            polyspec_orm_testcase::trial(format!("{prefix}::{id}"), polyspec_orm_testcase::COMPUTE, move || {
                let mut bound = HashMap::new();
                for step in case["steps"].as_array().expect("steps") {
                    let got = run_step(step, &mut bound);
                    assert_eq!(got, step["expect"]["none"], "{id}: {}", step["op"]);
                }
            })
        })
        .collect();
    polyspec_orm_testcase::run(trials);
}
