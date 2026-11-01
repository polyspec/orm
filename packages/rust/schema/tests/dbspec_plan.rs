//! The cases of tests/dbspec/plans.json through the plan functions of
//! `polyspec_orm_schema::dbspec` (docs/spec/plans.md): every case diffs to its changes,
//! writes its steps for MySQL, PostgreSQL and SQLite and emits its plan text again. The
//! validation sections are the recipes tests/dbspec/plan-*.json, run by the recipe helper
//! of polyspec_orm (FCV-3).

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

#[path = "common/vector_file.rs"]
mod vector_file;
use vector_file::{lines, vectors};

use polyspec_orm_case_clock::CaseClock;
use polyspec_orm_schema::dbspec::{self, diff, emit_plan, parse_plan, plan_steps, Dialect, Document, PlanStep};
use polyspec_orm_testcase::Trial;
use serde_json::Value;

/// The plans.json object of a step (docs/spec/plans.md "Steps").
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
use std::collections::BTreeMap;
use std::time::Duration;

/// The deadline of one case.
const DEADLINE: Duration = Duration::from_secs(5);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("strings").iter().map(|s| s.as_str().expect("string").to_owned()).collect()
}

/// The source schema of the case; null means an empty schema.
fn source(id: &str, value: &Value) -> Option<Document> {
    if value.is_null() {
        return None;
    }
    Some(dbspec::parse(&lines(value), &BTreeMap::new()).map(|parsed| parsed.document).or_panic(|e| format!("{id}: source: {e:?}")))
}

/// Runs one case and writes its result and CPU time. A failed case panics with its reason.
fn run(id: &str, body: impl FnOnce() -> Result<(), String>) {
    let clock = CaseClock::start();
    let result = body();
    let (cpu, wall) = (clock.cpu(), clock.wall());
    // A measured time is reported, never a failure (AGENTS.md).
    if cpu > DEADLINE {
        polyspec_orm_testcase::warning(format_args!("plan/{id}: cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})"));
    }
    match result {
        Ok(()) => polyspec_orm_testcase::step(format_args!("cpu={cpu:?} wall={wall:?}")),
        Err(e) => panic!("plan/{id}: cpu={cpu:?} wall={wall:?}: {e}"),
    }
}

// Requirements: PLN-73, PLN-74, PLN-75, PLN-76, PLN-77, PLN-78, PLN-79, PLN-80, PLN-81, PLN-82, PLN-83.
fn plan_vectors() -> Vec<Trial> {
    let vectors = vectors("plans");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "tests/dbspec/plans.json has no cases");
    let mut trials = Vec::new();
    for case in cases {
        let name = case["id"].as_str().expect("id").to_owned();
        let case = case.clone();
        trials.push(polyspec_orm_testcase::trial(format!("plan_vectors::cases::{name}"), polyspec_orm_testcase::wall_for_cpu(DEADLINE), move || {
            plan_vectors_cases(&case)
        }));
    }
    trials
}

fn plan_vectors_cases(case: &Value) {
    let id = case["id"].as_str().expect("id");
    run(id, || {
        let source = source(id, &case["source"]);
        let text = lines(&case["plan"]);
        let plan = parse_plan(&text).map_err(|e| format!("parse: {e:?}"))?;
        let emitted = emit_plan(&plan);
        if emitted != text {
            return Err(format!("emit_plan differs:\n{emitted}"));
        }
        let changes: Vec<Vec<String>> =
            diff(source.as_ref(), &plan).map_err(|e| format!("diff: {e:?}"))?.into_iter().map(|c| vec![c.kind, c.table, c.name]).collect();
        let want: Vec<Vec<String>> = case["changes"].as_array().expect("changes").iter().map(strings).collect();
        if changes != want {
            return Err(format!("changes\nwant {want:?}\ngot  {changes:?}"));
        }
        for (name, dialect) in DIALECTS {
            let steps = plan_steps(source.as_ref(), &plan, dialect).map_err(|e| format!("{name}: {e:?}"))?;
            let got: Vec<Value> = steps.iter().map(step_fields).collect();
            let want = case["steps"][name].as_array().cloned().unwrap_or_default();
            if got != want {
                return Err(format!("{name} steps\nwant {}\ngot  {}", Value::Array(want), Value::Array(got)));
            }
        }
        Ok(())
    });
}

fn main() {
    polyspec_orm_testcase::run(plan_vectors());
}
