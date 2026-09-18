//! The schema tools reproduce the recorded results of tests/schema/cases.json:
//! the manifest of every Mermaid fixture, its DDL for each dialect, and the
//! migrations and migration plan files between the fixtures.

use std::collections::HashMap;

use orm_build::ddl::{render_ddl, render_diff};
use orm_build::migration::PlanFile;
use orm_build::schema::{self, Manifest};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize, Default)]
struct Outcome {
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    error: String,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    mmd: String,
    manifest: Outcome,
    #[serde(default)]
    ddl: HashMap<String, Outcome>,
}

#[derive(Deserialize)]
struct Diff {
    from: String,
    to: String,
    dialect: String,
    allow_destructive: bool,
    #[serde(flatten)]
    outcome: Outcome,
}

#[derive(Deserialize)]
struct Plan {
    from: String,
    to: String,
    dialect: String,
    #[serde(flatten)]
    outcome: Outcome,
}

#[derive(Deserialize)]
struct Cases {
    plan_id: String,
    plan_name: String,
    cases: Vec<Case>,
    diffs: Vec<Diff>,
    plans: Vec<Plan>,
}

fn outcome(result: Result<String, String>) -> (String, String) {
    match result {
        Ok(text) => (Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect(), String::new()),
        Err(e) => (String::new(), e),
    }
}

fn check(label: &str, want: &Outcome, got: Result<String, String>, failures: &mut Vec<String>) {
    let (sha, error) = outcome(got);
    if sha != want.sha256 || error != want.error {
        failures.push(format!("{label}: want sha256={:?} error={:?}, got sha256={sha:?} error={error:?}", want.sha256, want.error));
    }
}

#[test]
fn recorded_schema_cases() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tests/schema/cases.json");
    let recorded: Cases = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut manifests: HashMap<String, Manifest> = HashMap::new();
    let mut failures = Vec::new();
    for c in &recorded.cases {
        let built = schema::parse(&c.mmd).map_err(|e| e.to_string()).and_then(|d| schema::build(&[d]).map_err(|e| e.to_string()));
        check(&c.name, &c.manifest, built.as_ref().map(|m| m.marshal_indent()).map_err(Clone::clone), &mut failures);
        let Ok(m) = built else { continue };
        assert_eq!(Manifest::load(&m.marshal_indent()).map(|l| l.schema_hash).as_deref(), Ok(m.schema_hash.as_str()), "{}: load", c.name);
        for (dialect, want) in &c.ddl {
            check(&format!("{} ddl {dialect}", c.name), want, render_ddl(&m, dialect), &mut failures);
        }
        manifests.insert(c.name.clone(), m);
    }
    for d in &recorded.diffs {
        let label = format!("diff {} → {} {} allow={}", d.from, d.to, d.dialect, d.allow_destructive);
        check(&label, &d.outcome, render_diff(&manifests[&d.from], &manifests[&d.to], &d.dialect, d.allow_destructive), &mut failures);
    }
    for p in &recorded.plans {
        let label = format!("plan {} → {} {}", p.from, p.to, p.dialect);
        let plan = PlanFile::new(&recorded.plan_id, &recorded.plan_name, &p.dialect, manifests[&p.from].clone(), manifests[&p.to].clone());
        check(&label, &p.outcome, plan.map(|plan| plan.to_json()), &mut failures);
    }
    assert!(recorded.diffs.len() > 1000, "recorded diffs: {}", recorded.diffs.len());
    assert!(recorded.plans.len() > 500, "recorded plans: {}", recorded.plans.len());
    let total = recorded.cases.len() + recorded.diffs.len() + recorded.plans.len();
    assert!(failures.is_empty(), "{} of {total} results differ:\n{}", failures.len(), failures.join("\n"));
}
