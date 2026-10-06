//! The cases of tests/dbspec/plans.json through the plan functions of
//! `polyspec_orm_schema::dbspec` (docs/plans.md): every case diffs to its changes,
//! writes its steps for MySQL, PostgreSQL and SQLite and emits its plan
//! text again; every invalid case reports its `plan` diagnostics; every chain
//! case orders its plans or reports its `chain` diagnostics; every parse case
//! reports its diagnostics with rule, line, column and the message of a `plan`
//! diagnostic; every comparison lists its differences or `compare`
//! diagnostics.

use orm_case_clock::CaseClock;
use polyspec_orm_schema::dbspec::{self, chain, compare_schemas, diff, emit_plan, parse_plan, plan_steps, Dialect, Document, Plan, PlanStep};
use serde_json::Value;

/// step의 plans.json object다(docs/plans.md "Steps").
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
use std::time::{Duration, Instant};

/// case 하나의 기한.
const DEADLINE: Duration = Duration::from_secs(5);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn vectors() -> Value {
    let path = orm_testcase::manifest_dir().join("../../../tests/dbspec/plans.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("plans.json");
    assert_eq!(vectors["version"], 1, "tests/dbspec/plans.json version");
    vectors
}

fn lines(value: &Value) -> String {
    value.as_array().expect("lines").iter().map(|l| format!("{}\n", l.as_str().expect("line"))).collect()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("strings").iter().map(|s| s.as_str().expect("string").to_owned()).collect()
}

/// case의 source schema이며 null이면 빈 schema다.
fn source(id: &str, value: &Value) -> Option<Document> {
    if value.is_null() {
        return None;
    }
    Some(dbspec::parse(&lines(value), &BTreeMap::new()).unwrap_or_else(|e| panic!("{id}: source: {e:?}")))
}

/// case 하나를 시작, 결과, 경과 시간 줄과 기한으로 감싼다.
fn run(id: &str, body: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let mut inner = orm_testcase::start(format!("plan/{id}"), orm_testcase::wall_for_cpu(DEADLINE));
    let clock = CaseClock::start();
    let result = body();
    let (cpu, wall) = (clock.cpu(), clock.wall());
    let result = result.and_then(|()| if cpu > DEADLINE { Err(format!("cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})")) } else { Ok(()) });
    match &result {
        Ok(()) => inner.step(format_args!("cpu={cpu:?} wall={wall:?}")),
        Err(e) => inner.fail(format_args!("cpu={cpu:?} wall={wall:?}: {e}")),
    }
    drop(inner);
    result.map_err(|e| format!("plan/{id}: {e}"))
}

#[test]
fn plan_vectors() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    let started = Instant::now();
    let vectors = vectors();
    let cases = vectors["cases"].as_array().expect("cases");
    let invalid = vectors["invalid"].as_array().expect("invalid");
    assert!(!cases.is_empty() && !invalid.is_empty(), "tests/dbspec/plans.json has {} cases and {} invalid cases", cases.len(), invalid.len());
    let mut failures = Vec::new();
    for case in cases {
        let id = case["id"].as_str().expect("id");
        let result = run(id, || {
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
        failures.extend(result.err());
    }
    for case in invalid {
        let id = format!("invalid/{}", case["id"].as_str().expect("id"));
        let result = run(&id, || {
            let source = source(&id, &case["source"]);
            let diagnostics = match parse_plan(&lines(&case["plan"])) {
                Err(diagnostics) => diagnostics,
                Ok(plan) => match diff(source.as_ref(), &plan) {
                    Err(diagnostics) => diagnostics,
                    Ok(changes) => return Err(format!("diff succeeded with {changes:?}")),
                },
            };
            if let Some(d) = diagnostics.iter().find(|d| d.rule != "plan") {
                return Err(format!("rule {}, want plan", d.rule));
            }
            let got: Vec<String> = diagnostics.into_iter().map(|d| d.message).collect();
            let want = strings(&case["errors"]);
            if got != want {
                return Err(format!("errors\nwant {want:?}\ngot  {got:?}"));
            }
            Ok(())
        });
        failures.extend(result.err());
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    orm_testcase::step(format_args!("plan vectors: {} cases and {} invalid cases in {:?}", cases.len(), invalid.len(), started.elapsed()));
}

#[test]
fn plan_chains() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    let started = Instant::now();
    let vectors = vectors();
    let chains = vectors["chains"].as_array().expect("chains");
    assert!(!chains.is_empty(), "tests/dbspec/plans.json has no chains");
    let mut failures = Vec::new();
    for case in chains {
        let id = format!("chain/{}", case["id"].as_str().expect("id"));
        let result = run(&id, || {
            let plans: Vec<Plan> = case["plans"]
                .as_array()
                .expect("plans")
                .iter()
                .map(|p| parse_plan(&lines(p)).map_err(|e| format!("parse: {e:?}")))
                .collect::<Result<_, _>>()?;
            let (order, errors): (Vec<String>, Vec<String>) = match chain(&plans) {
                Ok(ordered) => (ordered.iter().map(|p| p.name().to_owned()).collect(), Vec::new()),
                Err(diagnostics) => {
                    if let Some(d) = diagnostics.iter().find(|d| d.rule != "chain") {
                        return Err(format!("rule {}, want chain", d.rule));
                    }
                    (Vec::new(), diagnostics.into_iter().map(|d| d.message).collect())
                }
            };
            let want_order = if case["order"].is_null() { Vec::new() } else { strings(&case["order"]) };
            let want_errors = if case["errors"].is_null() { Vec::new() } else { strings(&case["errors"]) };
            if order != want_order || errors != want_errors {
                return Err(format!("want order {want_order:?} errors {want_errors:?}\ngot  order {order:?} errors {errors:?}"));
            }
            Ok(())
        });
        failures.extend(result.err());
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    orm_testcase::step(format_args!("plan chains: {} cases in {:?}", chains.len(), started.elapsed()));
}

#[test]
fn plan_parse_errors() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    let started = Instant::now();
    let vectors = vectors();
    let parse = vectors["parse"].as_array().expect("parse");
    assert!(!parse.is_empty(), "tests/dbspec/plans.json has no parse cases");
    let mut failures = Vec::new();
    for case in parse {
        let id = format!("parse/{}", case["id"].as_str().expect("id"));
        let result = run(&id, || {
            let diagnostics = parse_plan(&lines(&case["plan"])).err().unwrap_or_default();
            // plan diagnostic은 message까지, target diagnostic은 rule, 줄, 칸까지 비교한다.
            let got = Value::from(
                diagnostics
                    .into_iter()
                    .map(|d| {
                        let message = if d.rule == "plan" { Value::from(d.message) } else { Value::Null };
                        Value::from(vec![Value::from(d.rule), Value::from(d.line), Value::from(d.column), message])
                    })
                    .collect::<Vec<_>>(),
            );
            if got != case["errors"] {
                return Err(format!("errors\nwant {}\ngot  {got}", case["errors"]));
            }
            Ok(())
        });
        failures.extend(result.err());
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    orm_testcase::step(format_args!("plan parse errors: {} cases in {:?}", parse.len(), started.elapsed()));
}

#[test]
fn plan_comparisons() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    let started = Instant::now();
    let vectors = vectors();
    let comparisons = vectors["comparisons"].as_array().expect("comparisons");
    assert!(!comparisons.is_empty(), "tests/dbspec/plans.json has no comparisons");
    let mut failures = Vec::new();
    for case in comparisons {
        let id = format!("comparison/{}", case["id"].as_str().expect("id"));
        let result = run(&id, || {
            let from = source(&id, &case["source"]).ok_or("the source is null")?;
            let to = source(&id, &case["target"]).ok_or("the target is null")?;
            let (differences, errors) = match compare_schemas(&from, &to) {
                Ok(differences) => (differences.into_iter().map(|d| Value::from(vec![d.kind, d.table, d.name])).collect(), Vec::new()),
                Err(diagnostics) => (
                    Vec::new(),
                    diagnostics
                        .into_iter()
                        .map(|d| Value::from(vec![Value::from(d.rule), Value::from(d.line), Value::from(d.column), Value::from(d.message)]))
                        .collect(),
                ),
            };
            let (differences, errors) = (Value::from(differences), Value::from(errors));
            if differences != case["differences"] || errors != case["errors"] {
                return Err(format!("want differences {} errors {}\ngot  differences {differences} errors {errors}", case["differences"], case["errors"]));
            }
            Ok(())
        });
        failures.extend(result.err());
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    orm_testcase::step(format_args!("plan comparisons: {} cases in {:?}", comparisons.len(), started.elapsed()));
}
