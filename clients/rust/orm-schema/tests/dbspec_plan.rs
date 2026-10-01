//! The cases of tests/dbspec/plans.json through the plan functions of
//! `orm_schema::dbspec` (docs/plans.md): every case diffs to its changes,
//! writes its statements for MySQL, PostgreSQL and SQLite and emits its plan
//! text again; every invalid case reports its `plan` diagnostics; every chain
//! case orders its plans or reports its `chain` diagnostics; every parse case
//! reports its diagnostics with rule, line, column and the message of a `plan`
//! diagnostic.

use orm_schema::dbspec::{self, chain, diff, emit_plan, parse_plan, plan_statements, Dialect, Document, Plan};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// case 하나의 기한.
const DEADLINE: Duration = Duration::from_secs(5);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn vectors() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/dbspec/plans.json");
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
    let started = Instant::now();
    println!("RUN plan/{id} deadline={DEADLINE:?}");
    let result = body().and_then(|()| if started.elapsed() > DEADLINE { Err(format!("took {:?}", started.elapsed())) } else { Ok(()) });
    match &result {
        Ok(()) => println!("PASS plan/{id} elapsed={:?}", started.elapsed()),
        Err(e) => println!("FAIL plan/{id} elapsed={:?}: {e}", started.elapsed()),
    }
    result.map_err(|e| format!("plan/{id}: {e}"))
}

#[test]
fn plan_vectors() {
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
                let statements = plan_statements(source.as_ref(), &plan, dialect).map_err(|e| format!("{name}: {e:?}"))?;
                let want = strings(&case["statements"][name]);
                if statements != want {
                    return Err(format!("{name} statements\nwant {want:#?}\ngot  {statements:#?}"));
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
    println!("PASS plan vectors: {} cases and {} invalid cases in {:?}", cases.len(), invalid.len(), started.elapsed());
}

#[test]
fn plan_chains() {
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
    println!("PASS plan chains: {} cases in {:?}", chains.len(), started.elapsed());
}

#[test]
fn plan_parse_errors() {
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
    println!("PASS plan parse errors: {} cases in {:?}", parse.len(), started.elapsed());
}
