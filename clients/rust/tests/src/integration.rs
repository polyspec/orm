//! Rust half of the S1 demo: same statements as the Go/PHP integration tests.
//! Usage: integration <ormengine.wasm> <schema.json>
use std::sync::Arc;

use gen::*;
use orm::db::{Config, Db};
use orm::engine::{Engine, EngineConfig};
use sqlx::mysql::MySqlConnectOptions;

macro_rules! check {
    ($fails:ident, $cond:expr, $what:expr) => {
        if !$cond { $fails += 1; eprintln!("FAIL: {}", $what); }
    };
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wasm = std::fs::read(&args[1]).expect("wasm");
    let schema = std::fs::read(&args[2]).expect("schema.json");
    let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, cache_dir: None }).expect("engine"));
    gen::init(engine.clone());
    let opts = MySqlConnectOptions::new().socket("/tmp/mysql.sock").username("root").database("orm_bench");
    let db = Db::connect(opts, 4, engine, Config { aes_key: "bench-salt".into(), on_query: None }).await.expect("connect");
    let mut fails = 0;

    // ---- reads ----
    let b = Battle::new().one_by_seq(&db, 42).await.expect("one").expect("row 42");
    check!(fails, b.seq == 42 && b.name == "battle-42" && b.aes_hex_email.as_deref() == Some("user42@example.com"), "one by pk + aes decode");
    check!(fails, b.description.is_none(), "lazy column not loaded by default");
    check!(fails, b.is_close && !b.is_display, "bool coercion (42: closed, not displayed)");

    let b2 = Battle::new().select_description().seq_eq(42).one(&db).await.unwrap().unwrap();
    check!(fails, b2.description.as_deref().map(|d| d.starts_with("desc-42")).unwrap_or(false), "select lazy column");

    let now = chrono::NaiveDate::from_ymd_opt(2026, 9, 11).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let rows = Battle::new()
        .service_seq_eq(7)
        .is_close_eq(false)
        .and(|w| w.is_display_eq(true).or().and(|w| w.is_display_eq(false).display_start_dt_lt(now)))
        .seq_in(vec![6, 106, 206, 306, 406])
        .order_by_seq_desc()
        .limit(0, 3)
        .all(&db)
        .await
        .expect("all");
    check!(fails, rows.len() == 3 && rows.first().map(|r| r.seq) == Some(306), "all + group + or + in + order + limit");
    for (k, r) in &rows { check!(fails, k.as_i64() == r.seq, "collection keyed by pk"); }

    check!(fails, Battle::new().service_seq_eq(7).count(&db).await.unwrap() == 1000, "count");
    check!(fails, Battle::new().service_seq_eq(7).sum_like_count(&db).await.unwrap() > 0.0, "sum");

    let cnt = Battle::new()
        .join_service(Service::new().where_(|w| w.name_eq("service-7")))
        .left_join_user(User::new().on(|w| w.name_contains("user")))
        .is_close_eq(false)
        .and(|w| w.is_display_eq(true).or().service(|s| s.seq_gt(1000)))
        .count(&db)
        .await
        .expect("join count");
    check!(fails, cnt > 0, "join + on/where + nav");

    let page = Battle::new().service_seq_eq(7).order_by_seq_asc().paginate(&db, 2, 10).await.expect("paginate");
    check!(fails, page.total == 1000 && page.pages == 100 && page.items.len() == 10 && page.items.first().map(|r| r.seq) == Some(1006), "paginate");
    check!(fails, Battle::new().name_contains("%").count(&db).await.unwrap() == 0, "contains escapes %");

    let j = Battle::new().join_service(Service::new().where_(|w| w.seq_eq(7))).seq_eq(6).one(&db).await.unwrap().unwrap();
    check!(fails, j.service().map(|s| s.name.as_str()) == Some("service-7"), "joined row access");

    // ---- writes ----
    let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let end = chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let created = db.transaction(|tx| async move {
        Battle::new()
            .set_name("rust-write")
            .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
            .set_start_dt(start).set_end_dt(end)
            .set_aes_hex_email(Some("w@example.com"))
            .insert(&tx).await
    }).await.expect("insert").expect("inserted row");
    check!(fails, created.seq > 0 && created.aes_hex_email.as_deref() == Some("w@example.com"), "insert in tx + aes");

    let mut c = created.clone();
    c.set_name("rust-write-2").set_like_count(5);
    c.update_optimistic(&db).await.expect("update");
    let again = Battle::new().one_by_seq(&db, created.seq).await.unwrap().unwrap();
    check!(fails, again.name == "rust-write-2" && again.like_count == 5, "dirty update");
    c.set_name("stale");
    match c.update_optimistic(&db).await {
        Err(e) if e.code() == "OPTIMISTIC_LOCK" => {}
        other => { fails += 1; eprintln!("FAIL: optimistic lock not detected: {:?}", other.err()); }
    }
    again.delete(&db).await.expect("delete");
    check!(fails, Battle::new().seq_eq(created.seq).count(&db).await.unwrap() == 0, "delete");

    match Battle::new().seq_in(vec![]).count(&db).await {
        Err(e) if e.code() == "EMPTY_IN" => {}
        other => { fails += 1; eprintln!("FAIL: EMPTY_IN: {:?}", other.err()); }
    }

    if fails == 0 { println!("ok"); } else { std::process::exit(1); }
}
