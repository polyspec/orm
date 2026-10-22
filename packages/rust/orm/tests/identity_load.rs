//! Runs the shared cases of contracts/fixtures/identity_load.json with this client (packages/go/orm/
//! identity_load_test.go, the same cases). A single test function, `identity_load`, runs all cases of the file in turn
//! and prints one report line per case, `PASS identity-load/<case id>` or `FAIL identity-load/<case id>` (language
//! parity unit "identity-load"). A compile case adds the fixture's manifest_hash to the request, compiles it for the three dialects,
//! and compares the statement or error with `engine::compile`. An execute case runs against MySQL, PostgreSQL, and SQLite, each in its own case
//! database with the fixture contracts/fixtures/identity_load.dbs installed; it compiles each step's request for that database's
//! dialect, runs it with `Db::execute`, and at the end reads load_probe's rows with the fixture's `read` SQL through the driver
//! and compares them. Even after a failed case, the rest still run, and the failed cases are all listed at the end.

use std::time::Duration;

use polyspec_orm::db::Pool;
use polyspec_orm::{engine, ir, plan, Db, Dialect, Manifest, Param, Schema};
use polyspec_orm_case_database::CaseDatabase;
use polyspec_orm_testcase::Trial;
use serde_json::{json, Map, Value};
use sqlx::Row;

static LOAD_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/identity_load.dbs"), "sha256:5b9923a69ed67de11e46bc3b825656d177d6e3664a867ca4d4d779b2677f97de");
const CASES: &str = include_str!("../../../../contracts/fixtures/identity_load.json");
/// The deadline an execute case uses on one database. The sum for three databases fits within the case deadline DATABASE.
const DATABASE_DEADLINE: Duration = Duration::from_secs(35);
const DRIVERS: [&str; 3] = ["mysql", "postgres", "sqlite"];

fn manifest() -> Manifest {
    Manifest::load(LOAD_SCHEMA.text(), LOAD_SCHEMA.hash()).expect("identity_load.dbs manifest")
}

fn object<'a>(v: &'a Value, what: &str) -> &'a Map<String, Value> {
    v.as_object().unwrap_or_else(|| panic!("{what} is no object: {v}"))
}

fn index(v: &Value, what: &str) -> usize {
    v.as_u64().unwrap_or_else(|| panic!("{what} is no index: {v}")) as usize
}

/// The assignment the case uses (`column`, `p`, `null`). Any other key is an error in the case file.
fn assign(v: &Value) -> ir::Assign {
    let mut a = ir::Assign::default();
    for (key, value) in object(v, "assignment") {
        match key.as_str() {
            "column" => a.column = value.as_str().expect("assignment column").to_owned(),
            "p" => a.p = Some(index(value, "assignment p")),
            "null" => a.null = value.as_bool().expect("assignment null"),
            other => panic!("assignment key {other:?} is not read by this runner"),
        }
    }
    a
}

/// The where group the case uses: a list of `pred` items (`column`, `op`, `p`).
fn group(v: &Value) -> ir::Group {
    let mut g = ir::Group::default();
    for (key, value) in object(v, "where") {
        match key.as_str() {
            "items" => {
                for item in value.as_array().expect("where items") {
                    let mut pred = ir::Pred::default();
                    for (key, value) in object(&item["pred"], "pred") {
                        match key.as_str() {
                            "column" => pred.column = value.as_str().expect("pred column").to_owned(),
                            "op" => pred.op = value.as_str().expect("pred op").to_owned(),
                            "p" => pred.p = Some(index(value, "pred p")),
                            other => panic!("pred key {other:?} is not read by this runner"),
                        }
                    }
                    g.items.push(ir::Item::Pred { pred: Box::new(pred) });
                }
            }
            other => panic!("where key {other:?} is not read by this runner"),
        }
    }
    g
}

/// Converts the case's request JSON into an IR request and adds the fixture's manifest_hash. If the case file
/// already has manifest_hash, or has a key this runner does not read, it fails.
fn request(v: &Value) -> ir::Request {
    let mut r = ir::Request { manifest_hash: LOAD_SCHEMA.hash().to_owned(), ..Default::default() };
    for (key, value) in object(v, "request") {
        match key.as_str() {
            "ir_version" => r.ir_version = value.as_u64().expect("ir_version") as u32,
            "kind" => r.kind = value.as_str().expect("kind").to_owned(),
            "entity" => r.query.entity = value.as_str().expect("entity").to_owned(),
            "load" => r.load = value.as_bool().expect("load"),
            "n_params" => r.n_params = index(value, "n_params"),
            "set" => r.set = value.as_array().expect("set").iter().map(assign).collect(),
            "on_duplicate" => r.on_duplicate = value.as_array().expect("on_duplicate").iter().map(assign).collect(),
            "rows" => {
                r.rows = value.as_array().expect("rows").iter().map(|row| row.as_array().expect("row").iter().map(|p| index(p, "row p")).collect()).collect()
            }
            "where" => r.query.where_ = Some(group(value)),
            other => panic!("request key {other:?} is not read by this runner"),
        }
    }
    r
}

/// The comparison form of a plan step: role, sql, bind slots (from, the param of the param slot, dbspec type), and table.
fn statement(step: &plan::Step) -> Value {
    let slots: Vec<Value> = step
        .bind_slots
        .iter()
        .map(|b| if b.from == "param" { json!({"from": b.from, "param": b.param, "type": b.col_type}) } else { json!({"from": b.from, "type": b.col_type}) })
        .collect();
    json!({"role": step.role, "sql": step.sql, "slots": slots, "tables": step.tables})
}

/// Checks whether the error is the expected one by code and message (the end of the error text).
fn matches_error(e: &polyspec_orm::Error, code: &str, message: &str) -> bool {
    e.code() == code && e.to_string().ends_with(message)
}

/// Runs one compile case on the three dialects.
fn compile_case(m: &Manifest, c: &Value) -> Result<(), String> {
    let r = request(&c["input"]);
    let expected = &c["expected"];
    for d in [Dialect::MySql, Dialect::Postgres, Dialect::Sqlite] {
        let result = engine::compile(m, d, &r);
        if let Some(code) = expected["error"].as_str() {
            let message = expected["message"].as_str().expect("expected message");
            match result {
                Err(e) => {
                    if !matches_error(&e, code, message) {
                        return Err(format!("{}: compile = {e}; want {code} {message:?}", d.name()));
                    }
                }
                Ok(p) => return Err(format!("{}: compile = {}; want {code} {message:?}", d.name(), Value::Array(p.steps.iter().map(statement).collect()))),
            }
            continue;
        }
        let plan = result.map_err(|e| format!("{}: compile: {e}", d.name()))?;
        let got = Value::Array(plan.steps.iter().map(statement).collect());
        let want = &expected[d.name()];
        if !want.as_array().is_some_and(|w| !w.is_empty()) {
            return Err(format!("{}: the case has no statements", d.name()));
        }
        if &got != want {
            return Err(format!("{} statements: got {got}, want {want}", d.name()));
        }
    }
    Ok(())
}

/// Converts case parameters to request values: integers are i64, strings are text.
fn param(v: &Value) -> Param {
    match v {
        Value::Number(n) => Param::I64(n.as_i64().unwrap_or_else(|| panic!("parameter {n} is no integer"))),
        Value::String(s) => Param::Str(s.clone()),
        other => panic!("parameter {other} is neither an integer nor a string"),
    }
}

/// Reads load_probe's rows as (seq, label) with the fixture's read SQL.
async fn read_rows(db: &Db, query: &str) -> Result<Vec<(i64, String)>, String> {
    macro_rules! read {
        ($pool:expr) => {{
            let rows = sqlx::raw_sql(sqlx::AssertSqlSafe(query.to_owned())).fetch_all($pool).await.map_err(|e| format!("{query}: {e}"))?;
            rows.iter()
                .map(|r| {
                    Ok((
                        r.try_get::<i64, _>(0).map_err(|e| format!("{query}: seq: {e}"))?,
                        r.try_get::<String, _>(1).map_err(|e| format!("{query}: label: {e}"))?,
                    ))
                })
                .collect()
        }};
    }
    match db.pool() {
        Pool::MySql(p) => read!(p),
        Pool::Postgres(p) => read!(p),
        Pool::Sqlite(p) => read!(p),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

/// Runs the execute case's steps on connection `db` and compares the rows.
async fn execute_steps(driver: &str, db: &Db, m: &Manifest, read: &str, c: &Value) -> Result<(), String> {
    let dialect = Dialect::parse(driver).expect("driver dialect");
    db.utils().schema().install(&LOAD_SCHEMA).await.map_err(|e| format!("install: {e}"))?;
    for (i, s) in c["steps"].as_array().expect("case steps").iter().enumerate() {
        let plan = engine::compile(m, dialect, &request(&s["request"])).map_err(|e| format!("step {i}: compile: {e}"))?;
        let params: Vec<Param> = s["params"].as_array().expect("step params").iter().map(param).collect();
        let result = db.execute(&plan.steps[0], &params).await;
        match (s["error"].as_str(), result) {
            (None, Ok(())) => {}
            (None, Err(e)) => return Err(format!("step {i}: execute: {e}")),
            (Some(code), Err(e)) if matches_error(&e, code, s["message"].as_str().expect("step message")) => {}
            (Some(code), other) => return Err(format!("step {i}: execute = {other:?}; want {code} {}", s["message"])),
        }
    }
    let want: Vec<(i64, String)> = c["expected"]["rows"]
        .as_array()
        .expect("expected rows")
        .iter()
        .map(|row| (row[0].as_i64().expect("row seq"), row[1].as_str().expect("row label").to_owned()))
        .collect();
    let got = read_rows(db, read).await?;
    if got != want {
        return Err(format!("rows {got:?}, want {want:?}"));
    }
    Ok(())
}

/// Runs one execute case in its own case database for `driver`. The case database is dropped regardless of the result.
async fn execute_on(driver: &'static str, doc: &Value, m: &Manifest, c: &Value) -> Result<(), String> {
    polyspec_orm_testcase::step(format_args!("{driver}: case database"));
    let database = CaseDatabase::create(driver).await;
    let run = async {
        let db = Db::connect_schema(database.dsn(), &LOAD_SCHEMA, 2, polyspec_orm::Config::default()).await.map_err(|e| format!("connect: {e}"))?;
        let result = execute_steps(driver, &db, m, doc["read"][driver].as_str().expect("read SQL"), c).await;
        db.close().await;
        result
    };
    let result = match tokio::time::timeout(DATABASE_DEADLINE, run).await {
        Ok(result) => result,
        Err(_) => Err(format!("timeout after {DATABASE_DEADLINE:?}")),
    };
    database.drop().await;
    result.map_err(|e| format!("{driver}: {e}"))
}

// Each case of identity_load.json is one trial, `identity_load::<id>`. A compile case's deadline is COMPUTE, and an execute case's
// deadline is DATABASE. An execute case runs the remaining databases even after one database fails, and records every database's result.
fn identity_load() -> Vec<Trial> {
    let doc: Value = serde_json::from_str(CASES).expect("contracts/fixtures/identity_load.json");
    doc["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|c| {
            let id = c["id"].as_str().expect("case id").to_owned();
            let deadline = match c["operation"].as_str() {
                Some("compile") => polyspec_orm_testcase::COMPUTE,
                Some("execute") => polyspec_orm_testcase::DATABASE,
                other => panic!("{id}: unknown operation {other:?}"),
            };
            let (doc, c) = (doc.clone(), c.clone());
            polyspec_orm_testcase::async_trial(format!("identity_load::{id}"), deadline, move || async move {
                let m = manifest();
                let result = if c["operation"] == "compile" {
                    compile_case(&m, &c)
                } else {
                    let mut errors = Vec::new();
                    for driver in DRIVERS {
                        if let Err(e) = execute_on(driver, &doc, &m, &c).await {
                            errors.push(e);
                        }
                    }
                    if errors.is_empty() {
                        Ok(())
                    } else {
                        Err(errors.join("; "))
                    }
                };
                if let Err(reason) = result {
                    panic!("{reason}");
                }
            })
        })
        .collect()
}

fn main() {
    polyspec_orm_testcase::run_in_order(identity_load());
}
