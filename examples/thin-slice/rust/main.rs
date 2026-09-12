//! S1 demo (Rust): one statement, three languages, one JSON.
//! stdout: the result as JSON — byte-identical to the Go and PHP demos.
//! stderr: p50 of the generated client vs the same SQL through sqlx directly.
//!
//!   clients/rust/target/release/demo bin/ormengine.wasm schema/schema.json
//! The DSN comes from ORM_MYSQL_URL_RUST when set, else the local socket.
use std::sync::{Arc, Mutex};
use std::time::Instant;

use gen::*;
use orm::db::{Config, ConnectOptions, Db, Pool};
use orm::engine::{Engine, EngineConfig};
use orm::value::Param;
use serde_json::json;

const ITERATIONS: usize = 500;

/// The test DSN: `ORM_MYSQL_URL_RUST` when set (CI), else the local socket.
fn connect_opts() -> ConnectOptions {
    let url = std::env::var("ORM_MYSQL_URL_RUST").unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into());
    ConnectOptions::parse("mysql", &url).expect("ORM_MYSQL_URL_RUST is a mysql:// URL")
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wasm = std::fs::read(&args[1]).expect("wasm");
    let schema = std::fs::read(&args[2]).expect("schema.json");
    let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, ..Default::default() }).expect("engine"));
    gen::init(engine.clone()).expect("schema hash");

    let last: Arc<Mutex<(String, Vec<Param>)>> = Arc::new(Mutex::new((String::new(), Vec::new())));
    let last_h = last.clone();
    let on_query = Box::new(move |sql: &str, params: &[Param], _: std::time::Duration, _: u64, _: Option<&orm::Error>| {
        *last_h.lock().unwrap() = (sql.to_owned(), params.to_vec());
    });
    let opts = connect_opts();
    let db = Db::connect(opts, 1, engine, Config { aes_key: "bench-salt".into(), on_query: Some(on_query) }).await.expect("connect");
    let now = chrono::NaiveDate::from_ymd_opt(2026, 9, 11).unwrap().and_hms_opt(0, 0, 0).unwrap();

    let query = || async {
        battle::query()
            .service_seq(7)
            .is_close(false)
            .and(|w| w.is_display(true).or().and(|w| w.is_display(false).display_start_dt_lt(now)))
            .seq_in(vec![6, 106, 206, 306, 406])
            .order_by_seq_desc()
            .limit(0, 3)
            .using(&db).gets()
            .await
    };

    let rows = query().await.expect("query");
    let out: Vec<_> = rows.iter().map(|(_, r)| json!({"seq": r.seq, "name": r.name, "is_display": r.is_display, "like_count": r.like_count})).collect();
    println!("{}", serde_json::to_string(&out).unwrap());

    let mut s = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let t = Instant::now();
        query().await.expect("query");
        s.push(t.elapsed().as_micros());
    }
    s.sort_unstable();
    let client = s[ITERATIONS / 2];

    let (sql, params) = last.lock().unwrap().clone();
    // the hook masks secret binds; the native replay needs the real key
    let params: Vec<Param> = params.into_iter().map(|p| if p == Param::Str(orm::db::SECRET_MASK.into()) { Param::Str("bench-salt".into()) } else { p }).collect();
    let mut s = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let t = Instant::now();
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for p in &params {
            q = match p {
                Param::Null => q.bind(Option::<i64>::None),
                Param::Bool(b) => q.bind(*b),
                Param::I64(x) => q.bind(*x),
                Param::F64(x) => q.bind(*x),
                Param::Str(v) => q.bind(v.as_str()),
                Param::Bytes(b) => q.bind(b.as_slice()),
                Param::DateTime(t) => q.bind(*t),
                Param::Date(d) => q.bind(*d),
                Param::Point(point) => q.bind(orm::point_text(*point).expect("valid point")),
            };
        }
        let Pool::MySql(pool) = &db.pool else { panic!("the demo runs on MySQL") };
        let _rows: Vec<sqlx::mysql::MySqlRow> = q.fetch_all(pool).await.expect("native");
        s.push(t.elapsed().as_micros());
    }
    s.sort_unstable();
    let native = s[ITERATIONS / 2];
    eprintln!("rust: client p50 {client}µs, native p50 {native}µs ({ITERATIONS} iterations)");
}
