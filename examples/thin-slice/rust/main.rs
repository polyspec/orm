//! Thin-slice demo (Rust): one statement in every client language, one JSON.
//! stdout: the result as JSON. stderr: p50 of the generated client and of the
//! same SQL through sqlx directly.
//!
//!   packages/rust/target/debug/demo
//! The DSN comes from ORM_BENCH_MYSQL_DSN, which the program requires.
use std::sync::{Arc, Mutex};
use std::time::Instant;

polyspec_orm::models!();

use model::Author;
use polyspec_orm::db::Pool;
use polyspec_orm::Param;
use serde_json::json;

const ITERATIONS: usize = 500;
const AES_KEY: &str = "bench-salt";

/// `ORM_BENCH_MYSQL_DSN` points to the seeded bench database. If it is missing or empty, it does not connect
/// and ends after printing that variable name.
fn dsn() -> String {
    match std::env::var("ORM_BENCH_MYSQL_DSN") {
        Ok(v) if !v.is_empty() => v,
        Ok(_) | Err(std::env::VarError::NotPresent) => {
            eprintln!("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make orm-check or make run-databases TARGETS=<target>, which create the bench database of the run");
            std::process::exit(1)
        }
        Err(e) => {
            eprintln!("ORM_BENCH_MYSQL_DSN must be UTF-8: {e}");
            std::process::exit(1)
        }
    }
}

fn p50(mut s: Vec<u128>) -> u128 {
    s.sort_unstable();
    s[s.len() / 2]
}

#[tokio::main]
async fn main() -> polyspec_orm::Result<()> {
    let last: Arc<Mutex<(String, Vec<Param>)>> = Arc::new(Mutex::new((String::new(), Vec::new())));
    let hook = last.clone();
    let config = polyspec_orm::Config {
        aes_key: AES_KEY.into(),
        blind_index_key: "bench-blind-index".into(),
        ..Default::default()
    };
    let db = model::connect(&dsn(), 1, config).await?;
    let _last_statement = db.subscribe(move |e: &polyspec_orm::StatementEvent<'_>| {
        // An event reveals a secret bind, so a native rerun uses the real key.
        let binds = e
            .binds
            .iter()
            .map(|p| {
                if *p == Param::Str(polyspec_orm::db::SECRET_MASK.into()) {
                    Param::Str(AES_KEY.into())
                } else {
                    p.clone()
                }
            })
            .collect();
        *hook.lock().unwrap() = (e.sql.to_owned(), binds);
        Ok(())
    })?;
    let now = chrono::NaiveDate::from_ymd_opt(2026, 9, 11)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();

    let query = || {
        Author::new()
            .connect(&db)
            .service_seq(7)
            .and_is_close(false)
            .and(|q: Author| {
                q.is_display(true)
                    .or(|q: Author| q.is_display(false).and_lt_display_start_dt(now))
            })
            .and_seq(vec![6, 106, 206, 306, 406])
            .order_by_seq_desc()
            .limit(0, 3)
    };

    let rows = query().gets().await?;
    let out: Vec<_> = rows.models().map(|r| Ok::<_, polyspec_orm::Error>(json!({"seq": r.get_seq()?, "name": r.get_name()?, "is_display": r.get_is_display()?, "like_count": r.get_like_count()?}))).collect::<polyspec_orm::Result<_>>()?;
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
