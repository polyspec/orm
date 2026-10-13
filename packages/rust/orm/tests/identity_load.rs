//! contracts/fixtures/identity_load.json의 공유 case를 이 client로 실행한다(packages/go/orm/
//! identity_load_test.go와 같은 case). test 함수 `identity_load` 하나가 파일의 모든 case를 차례로 실행하고
//! case마다 보고 줄 하나 `PASS identity-load/<case id>`나 `FAIL identity-load/<case id>`를 출력한다(language
//! parity unit "identity-load"). compile case는 request에 fixture의 manifest_hash를 더해 세 dialect로
//! `engine::compile`하고 statement나 오류를 비교한다. execute case는 MySQL, PostgreSQL, SQLite마다 case
//! database 하나에 fixture contracts/fixtures/identity_load.dbs를 설치한 뒤 각 step의 request를 그 database의
//! dialect로 compile해 `Db::execute`로 실행하고, 마지막에 fixture의 `read` SQL로 load_probe의 행을 driver로
//! 바로 읽어 비교한다. 실패한 case 뒤에도 나머지 case를 실행하고 끝에서 실패한 case를 모두 적는다.

use std::time::Duration;

use polyspec_orm::db::Pool;
use polyspec_orm::{engine, ir, plan, Db, Dialect, Manifest, Param, Schema};
use polyspec_orm_case_database::CaseDatabase;
use serde_json::{json, Map, Value};
use sqlx::Row;

static LOAD_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/identity_load.dbs"), "sha256:5b9923a69ed67de11e46bc3b825656d177d6e3664a867ca4d4d779b2677f97de");
const CASES: &str = include_str!("../../../../contracts/fixtures/identity_load.json");
/// parity unit의 이름이며 보고 줄의 case 이름 앞부분이다.
const UNIT: &str = "identity-load";
/// execute case가 database 하나에서 쓰는 기한이다. 세 database의 합이 case 기한 DATABASE 안에 든다.
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

/// case가 쓰는 assignment(`column`, `p`, `null`)다. 다른 key는 case 파일의 오류다.
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

/// case가 쓰는 where group: `pred` item(`column`, `op`, `p`)의 목록이다.
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

/// case의 request JSON을 IR request로 바꾸고 fixture의 manifest_hash를 더한다. case 파일에
/// manifest_hash가 이미 있거나 이 runner가 읽지 않는 key가 있으면 실패한다.
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

/// plan step의 비교 형태: role, sql, bind slot(from, param slot의 param, dbspec type), table이다.
fn statement(step: &plan::Step) -> Value {
    let slots: Vec<Value> = step
        .bind_slots
        .iter()
        .map(|b| if b.from == "param" { json!({"from": b.from, "param": b.param, "type": b.col_type}) } else { json!({"from": b.from, "type": b.col_type}) })
        .collect();
    json!({"role": step.role, "sql": step.sql, "slots": slots, "tables": step.tables})
}

/// 오류가 code와 message(오류 text의 끝)로 기대한 것인지 본다.
fn matches_error(e: &polyspec_orm::Error, code: &str, message: &str) -> bool {
    e.code() == code && e.to_string().ends_with(message)
}

/// compile case 하나를 세 dialect에서 실행한다.
fn compile_case(m: &Manifest, c: &Value) -> Result<(), String> {
    let r = request(&c["input"]);
    let expected = &c["expected"];
    for d in [Dialect::MySql, Dialect::Postgres, Dialect::Sqlite] {
        let result = engine::compile(m, d, &r);
        if let Some(code) = expected["error"].as_str() {
            let message = expected["message"].as_str().expect("expected message");
            match result {
                Err(e) if matches_error(&e, code, message) => {}
                Err(e) => return Err(format!("{}: compile = {e}; want {code} {message:?}", d.name())),
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

/// case parameter를 request 값으로 바꾼다: 정수는 i64, 문자열은 text다.
fn param(v: &Value) -> Param {
    match v {
        Value::Number(n) => Param::I64(n.as_i64().unwrap_or_else(|| panic!("parameter {n} is no integer"))),
        Value::String(s) => Param::Str(s.clone()),
        other => panic!("parameter {other} is neither an integer nor a string"),
    }
}

/// fixture의 read SQL로 load_probe의 행을 (seq, label)로 읽는다.
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

/// execute case의 step을 연결 `db`에서 실행하고 행을 비교한다.
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

/// execute case 하나를 `driver`의 자기 case database에서 실행한다. case database는 결과와 상관없이 지운다.
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

// identity_load.json의 모든 case를 실행한다. language parity unit "identity-load"가 이 함수 하나를 실행하고
// case마다 보고 줄을 읽는다.
#[tokio::test]
async fn identity_load() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let doc: Value = serde_json::from_str(CASES).expect("contracts/fixtures/identity_load.json");
    let m = manifest();
    let mut failed = Vec::new();
    for c in doc["cases"].as_array().expect("cases") {
        let id = c["id"].as_str().expect("case id");
        let mut case = match c["operation"].as_str() {
            Some("compile") => polyspec_orm_testcase::start(format!("{UNIT}/{id}"), polyspec_orm_testcase::COMPUTE),
            Some("execute") => polyspec_orm_testcase::start(format!("{UNIT}/{id}"), polyspec_orm_testcase::DATABASE),
            other => panic!("{id}: unknown operation {other:?}"),
        };
        let result = if c["operation"] == "compile" {
            compile_case(&m, c)
        } else {
            // 한 database의 실패 뒤에도 나머지 database를 실행해 모든 database의 결과를 적는다.
            let mut errors = Vec::new();
            for driver in DRIVERS {
                if let Err(e) = execute_on(driver, &doc, &m, c).await {
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
            case.fail(&reason);
            failed.push(format!("{id}: {reason}"));
        }
    }
    assert!(failed.is_empty(), "identity_load cases failed:\n{}", failed.join("\n"));
}
