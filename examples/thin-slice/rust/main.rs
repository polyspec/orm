//! Thin-slice demo (Rust): one statement in every client language, one JSON.
//! stdout: the result as JSON. stderr: p50 of the generated client and of the
//! same SQL through sqlx directly.
//!
//!   clients/rust/target/release/demo
//! The DSN comes from ORM_BENCH_MYSQL_DSN when set, else the local socket.
use std::sync::{Arc, Mutex};
use std::time::Instant;

orm::models!();

use model::Battle;
use orm::db::Pool;
use orm::Param;
use serde_json::json;

const ITERATIONS: usize = 500;
const AES_KEY: &str = "bench-salt";

fn dsn() -> String {
    std::env::var("ORM_BENCH_MYSQL_DSN")
        .unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into())
}

fn p50(mut s: Vec<u128>) -> u128 {
    s.sort_unstable();
    s[s.len() / 2]
}

#[tokio::main]
async fn main() -> orm::Result<()> {
    let last: Arc<Mutex<(String, Vec<Param>)>> = Arc::new(Mutex::new((String::new(), Vec::new())));
    let hook = last.clone();
    let config = orm::Config {
        aes_key: AES_KEY.into(),
        blind_index_key: "bench-blind-index".into(),
        on_query: Some(Arc::new(
            move |sql: &str,
                  binds: &[Param],
                  _: std::time::Duration,
                  _: u64,
                  _: Option<&orm::Error>| {
                // the hook masks secret binds; the native replay needs the real key
                let binds = binds
                    .iter()
                    .map(|p| {
                        if *p == Param::Str(orm::db::SECRET_MASK.into()) {
                            Param::Str(AES_KEY.into())
                        } else {
                            p.clone()
                        }
                    })
                    .collect();
                *hook.lock().unwrap() = (sql.to_owned(), binds);
            },
        )),
        ..Default::default()
    };
    let db = orm::Db::connect(&dsn(), 1, config).await?;
    let now = chrono::NaiveDate::from_ymd_opt(2026, 9, 11)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();

    let query = || {
        Battle::new()
            .connect(&db)
            .service_seq(7)
            .and_is_close(false)
            .and(|q: Battle| {
                q.is_display(true)
                    .or(|q: Battle| q.is_display(false).and_lt_display_start_dt(now))
            })
            .and_seq(vec![6, 106, 206, 306, 406])
            .order_by_seq_desc()
            .limit(0, 3)
    };

    let rows = query().gets().await?;
    let out: Vec<_> = rows.models().map(|r| json!({"seq": r.get_seq(), "name": r.get_name(), "is_display": r.get_is_display(), "like_count": r.get_like_count()})).collect();
    println!("{}", serde_json::to_string(&out).unwrap());

    let mut s = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let t = Instant::now();
        query().gets().await?;
        s.push(t.elapsed().as_micros());
    }
    let client = p50(s);

    let (sql, params) = last.lock().unwrap().clone();
    let Pool::MySql(pool) = db.pool() else {
        panic!("the demo runs on MySQL")
    };
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
        let _rows: Vec<sqlx::mysql::MySqlRow> = q.fetch_all(pool).await.expect("native");
        s.push(t.elapsed().as_micros());
    }
    let native = p50(s);
    eprintln!("rust: client p50 {client}µs, native p50 {native}µs ({ITERATIONS} iterations)");
    db.close().await;
    Ok(())
}
