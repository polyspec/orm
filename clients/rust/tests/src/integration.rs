//! Rust half of the S1 demo: same statements as the Go/PHP integration tests.
//! Usage: integration <ormengine.wasm> <schema.json>
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use chrono::Datelike;
use gen::*;
use orm::collection::Key;
use orm::value::{Param, Val};
use orm::db::{Config, Db};
use orm::engine::{Engine, EngineConfig};
use sqlx::mysql::MySqlConnectOptions;

macro_rules! check {
    ($fails:ident, $cond:expr, $what:expr) => {
        if !$cond { $fails += 1; eprintln!("FAIL: {}", $what); }
    };
}

/// The test DSN: `ORM_MYSQL_URL_RUST` when set (CI), else the local socket.
fn connect_opts() -> MySqlConnectOptions {
    match std::env::var("ORM_MYSQL_URL_RUST") {
        Ok(url) => url.parse().expect("ORM_MYSQL_URL_RUST is a mysql:// URL"),
        Err(_) => MySqlConnectOptions::new().socket("/tmp/mysql.sock").username("root").database("orm_bench"),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wasm = std::fs::read(&args[1]).expect("wasm");
    let schema = std::fs::read(&args[2]).expect("schema.json");
    let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, cache_dir: None }).expect("engine"));
    let mut fails = 0;
    // ---- S5 boot check: an engine whose loaded manifest has another hash is refused, and the crate stays unbound ----
    let mut wrong = Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, cache_dir: None }).expect("engine");
    wrong.schema_hash = "0000000000000000".into();
    match gen::init(Arc::new(wrong)) {
        Err(e) if e.code() == orm::codes::SCHEMA_HASH_MISMATCH => {}
        other => { fails += 1; eprintln!("FAIL: wrong schema hash not rejected: {:?}", other.err()); }
    }
    gen::init(engine.clone()).expect("schema hash");
    check!(fails, gen::SCHEMA_HASH == engine.schema_hash, "gen::SCHEMA_HASH is the engine's loaded hash");
    let opts = connect_opts();
    let statements = Arc::new(AtomicUsize::new(0));
    let last_plan = Arc::new(AtomicU64::new(0));
    let leaked = Arc::new(AtomicBool::new(false));
    let (counter, last_plan_h, leaked_h) = (statements.clone(), last_plan.clone(), leaked.clone());
    let on_query = Box::new(move |_: &str, binds: &[Param], _: std::time::Duration, plan_id: u64, _: Option<&orm::Error>| {
        counter.fetch_add(1, Ordering::Relaxed);
        last_plan_h.store(plan_id, Ordering::Relaxed);
        if binds.iter().any(|b| *b == Param::Str("bench-salt".into())) { leaked_h.store(true, Ordering::Relaxed); }
    });
    let db = Db::connect(opts, 4, engine, Config { aes_key: "bench-salt".into(), on_query: Some(on_query) }).await.expect("connect");

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

    // ---- S4: count_distinct / min / max, having, named predicates, raw root ----
    check!(fails, Battle::new().service_seq_eq(7).count_distinct_user_seq(&db).await.unwrap() == 50, "count_distinct");
    check!(fails, Battle::new().service_seq_eq(7).min_seq(&db).await.unwrap() == Some(6), "min typed (i64)");
    check!(fails, Battle::new().service_seq_eq(7).max_seq(&db).await.unwrap() == Some(99906), "max typed (i64)");
    check!(fails, Battle::new().seq_eq(0).max_seq(&db).await.unwrap().is_none(), "max over no rows is None");
    check!(fails, Battle::new().seq_eq(0).min_name(&db).await.unwrap().is_none(), "min String over no rows is None");
    let mx = Battle::new().service_seq_eq(7).max_start_dt(&db).await.unwrap();
    check!(fails, mx.map(|t| t.date().year() >= 2020).unwrap_or(false), "max typed (NaiveDateTime)");
    check!(fails, Battle::new().service_seq_eq(7).max_price(&db).await.unwrap().is_none(), "max over a NULL-only column is None");
    check!(fails, Battle::new().service_seq_eq(7).group_by_user_seq().count(&db).await.unwrap() == 50, "count + group_by = number of groups");
    check!(fails, Battle::new().service_seq_eq(7).group_by_user_seq().having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).count(&db).await.unwrap() == 50, "having on group count");
    check!(fails, Battle::new().service_seq_eq(7).group_by_user_seq().having(|w| w.expr("COUNT(*) > ?", vec![1000.into()])).count(&db).await.unwrap() == 0, "having filters every group");
    // row select keeps HAVING (grouped by the PK so only_full_group_by holds): every group is one row
    let grouped = Battle::new().service_seq_eq(7).group_by_seq().having(|w| w.expr("COUNT(*) > ?", vec![0.into()])).order_by_seq_asc().limit(0, 2).all(&db).await.expect("having rows");
    check!(fails, grouped.len() == 2 && grouped.first().map(|b| b.seq) == Some(6), "having on row select");
    check!(fails, Battle::new().service_seq_eq(7).group_by_seq().having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).limit(0, 2).all(&db).await.unwrap().is_empty(), "having on row select filters every group");
    match Battle::new().service_seq_eq(7).having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).count(&db).await {
        Err(e) if e.code() == "IR_INVALID" => {}
        other => { fails += 1; eprintln!("FAIL: having without group_by not rejected: {:?}", other.err()); }
    }
    let visible = Battle::new().visible().service_seq_eq(7).count(&db).await.expect("visible");
    check!(fails, visible == Battle::new().service_seq_eq(7).is_close_eq(false).is_display_eq(true).count(&db).await.unwrap() && visible > 0, "predicate visible() = is_close 0 AND is_display 1");
    check!(fails, Battle::new().started_after("2026-01-01 00:00:00").service_seq_eq(7).count(&db).await.unwrap() == 1000, "predicate started_after(v) on the query");
    check!(fails, Battle::new().service_seq_eq(7).and(|w| w.visible().or().started_after("2999-01-01 00:00:00")).count(&db).await.unwrap() == visible, "predicates on the Where builder honour or()");
    let all_visible = Battle::new().visible().count(&db).await.unwrap();
    check!(fails, all_visible > visible && Battle::new().seq_eq(0).or().visible().count(&db).await.unwrap() == all_visible, "query predicate honours a pending or()");
    let rows = Battle::new().raw("SELECT COUNT(*) AS n, MAX(seq) AS m, MIN(`start_dt`) AS d FROM {table} WHERE service_seq = ? AND is_close = ?", vec![7.into(), 0.into()]).raw_all(&db).await.expect("raw_all");
    check!(fails, rows.len() == 1 && rows[0].keys().cloned().collect::<Vec<_>>() == vec!["n", "m", "d"], "raw_all: one row keyed by column name in column order");
    check!(fails, matches!(rows[0].get("n"), Some(Val::I64(_))) && rows[0].get("m") == Some(&Val::I64(99906)) && matches!(rows[0].get("d"), Some(Val::DateTime(_))), "raw_all: cells typed by column type");
    check!(fails, Battle::new().raw("SELECT seq FROM {table} WHERE seq = ?", vec![0.into()]).raw_all(&db).await.unwrap().is_empty(), "raw_all: no rows = empty list");
    match Battle::new().raw("SELECT seq FROM {table} WHERE seq = ?", vec![]).raw_all(&db).await {
        Err(e) if e.code() == "IR_INVALID" => {}
        other => { fails += 1; eprintln!("FAIL: raw placeholder/bind mismatch not rejected: {:?}", other.err()); }
    }

    // ---- relations ----
    let n0 = statements.load(Ordering::Relaxed);
    let rows = Battle::new()
        .service_seq_eq(7).order_by_seq_asc().limit(0, 5)
        .relation_user(User::new())
        .relation_service(Service::new()
            .relations_members(ServiceMember::new().order_by_seq_desc().limit_per_parent(3).key_by_user_seq().drop_child_key()))
        .all(&db).await.expect("relations");
    check!(fails, rows.len() == 5 && statements.load(Ordering::Relaxed) - n0 == 4, "relation statements: main, user, service, members");
    for (_, b) in &rows {
        check!(fails, b.user().map(|u| u.seq == b.user_seq && u.name == format!("user-{}", b.user_seq)) == Some(true), "one relation");
        check!(fails, b.service().map(|s| s.seq == 7 && s.members().len() == 3) == Some(true), "nested many relation, 3 per parent");
        for (k, m) in b.service().unwrap().members() { check!(fails, k.as_i64() == m.user_seq && m.service_seq == 7, "key_by user_seq"); }
    }
    let rows = Battle::new()
        .seq_in(vec![7, 8, 14]).order_by_seq_asc()
        .relation_user(User::new().if_parent_is_close_eq(true).relations_battles(Battle::new().order_by_seq_asc().limit_per_parent(2)))
        .join_service(Service::new().relations_modules(ServiceModule::new()))
        .all(&db).await.expect("if_parent");
    let (b7, b8, b14) = (rows.get(&Key::of(&Val::I64(7))).unwrap(), rows.get(&Key::of(&Val::I64(8))).unwrap(), rows.get(&Key::of(&Val::I64(14))).unwrap());
    check!(fails, b7.user().is_some() && b14.user().is_some() && b8.user().is_none(), "if_parent loads only closed battles' users");
    check!(fails, b7.user().unwrap().battles().len() == 2, "nested many under one, limit_per_parent");
    check!(fails, b8.service().map(|s| s.modules().len() == 1 && s.modules().first().unwrap().service_seq == b8.service_seq) == Some(true), "relation off a join");
    let n0 = statements.load(Ordering::Relaxed);
    let none = Battle::new().seq_eq(0).relation_user(User::new()).all(&db).await.expect("empty");
    check!(fails, none.is_empty() && statements.load(Ordering::Relaxed) - n0 == 1, "no parents → relation step skipped");
    let one = Battle::new().seq_eq(42).relation_service(Service::new().relations_members(ServiceMember::new().limit_per_parent(1))).one(&db).await.expect("one").expect("row 42");
    check!(fails, one.service().map(|s| s.members().len()) == Some(1), "one + relation");
    // flatten: typed access is unchanged (array/JSON forms merge the child's columns)
    let m = ServiceMember::new().service_seq_eq(7).order_by_seq_asc().limit(0, 2).relation_user(User::new().flatten()).all(&db).await.expect("flatten");
    check!(fails, m.first().and_then(|m| m.user()).map(|u| u.name.starts_with("user-")) == Some(true), "flatten");
    let page = Battle::new().service_seq_eq(7).order_by_seq_asc().relation_user(User::new()).paginate(&db, 1, 4).await.expect("paginate");
    check!(fails, page.total == 1000 && page.items.len() == 4 && page.items.first().and_then(|b| b.user()).is_some(), "paginate keeps relations");

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

    // ---- S3 writes: upsert, save, query update/delete, sql, delete_cascade ----
    let draft = |name: &str| Battle::new()
        .set_name(name)
        .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
        .set_start_dt(start).set_end_dt(end);
    let a = draft("rust-u1").set_uuid(Some("rust-upsert")).set_read_count(1).insert(&db).await.expect("insert a").unwrap();
    let b = draft("rust-u2").set_uuid(Some("rust-upsert")).set_read_count(1)
        .on_duplicate_set_name("rust-u2").on_duplicate_plus_read_count(5)
        .insert(&db).await.expect("upsert").unwrap();
    check!(fails, a.seq == b.seq && b.name == "rust-u2" && b.read_count == 6, "on_duplicate: existing row returned, set + plus applied");
    let c = draft("rust-u3").set_uuid(Some("rust-upsert")).set_read_count(9).on_duplicate_set_all().insert(&db).await.expect("upsert set_all").unwrap();
    check!(fails, c.seq == a.seq && c.name == "rust-u3" && c.read_count == 9, "on_duplicate_set_all copies the draft's set columns");
    let n = Battle::new().seq_eq(a.seq).plus_read_count(2).update(&db).await.expect("query update");
    check!(fails, n == 1 && Battle::new().one_by_seq(&db, a.seq).await.unwrap().unwrap().read_count == 11, "query update: affected 1, plus applied");
    let n = Battle::new().seq_eq(a.seq).minus_read_count(100).update(&db).await.expect("query update minus");
    check!(fails, n == 1 && Battle::new().one_by_seq(&db, a.seq).await.unwrap().unwrap().read_count == 0, "minus clamps at zero");
    let saved = Battle::new().set_seq(a.seq).set_name("rust-saved").save(&db).await.expect("save update").unwrap();
    check!(fails, saved.seq == a.seq && saved.name == "rust-saved" && saved.uuid.as_deref() == Some("rust-upsert"), "save with pk: update + re-read");
    let inserted = draft("rust-saved-new").save(&db).await.expect("save insert").unwrap();
    check!(fails, inserted.seq != a.seq && inserted.name == "rust-saved-new", "save without pk: insert");
    match Battle::new().set_name("x").update(&db).await {
        Err(e) if e.code() == "IR_INVALID" => {}
        other => { fails += 1; eprintln!("FAIL: update without where not rejected: {:?}", other.err()); }
    }
    let n0 = statements.load(Ordering::Relaxed);
    let s = Battle::new().service_seq_eq(7).select_aes_hex_email().limit(0, 1).sql(&db).await.expect("sql");
    check!(fails, s.sql.starts_with("SELECT ") && s.sql.ends_with(" LIMIT 0, 1") && statements.load(Ordering::Relaxed) == n0, "sql renders without executing");
    check!(fails, s.binds == vec![Param::Str("$SECRET".into()), Param::Str("$SECRET".into()), Param::I64(7)], "sql binds: secrets masked, params as values");
    check!(fails, Battle::new().seq_in(vec![a.seq, inserted.seq]).delete(&db).await.expect("query delete") == 2, "query delete: affected count");

    let (svc, m1, m2, md) = db.transaction(|tx| async move {
        let s = Service::new().set_name("rust-svc").insert(&tx).await?.unwrap();
        let m1 = ServiceMember::new().set_service_seq(s.seq).set_user_seq(1).insert(&tx).await?.unwrap();
        let m2 = ServiceMember::new().set_service_seq(s.seq).set_user_seq(2).insert(&tx).await?.unwrap();
        let md = ServiceModule::new().set_service_seq(s.seq).set_name("rust-mod").insert(&tx).await?.unwrap();
        Ok((s.seq, m1.seq, m2.seq, md.seq))
    }).await.expect("cascade fixture");
    let row = Service::new().seq_eq(svc)
        .relations_members(ServiceMember::new().order_by_seq_asc())
        .relations_modules(ServiceModule::new().no_cascade_delete())
        .one(&db).await.expect("service").expect("service row");
    check!(fails, row.members().len() == 2 && row.modules().len() == 1, "cascade fixture loaded");
    let n0 = statements.load(Ordering::Relaxed);
    row.delete_cascade(&db).await.expect("delete_cascade");
    check!(fails, statements.load(Ordering::Relaxed) - n0 == 3, "delete_cascade: one DELETE per member + the service");
    check!(fails, ServiceMember::new().seq_in(vec![m1, m2]).count(&db).await.unwrap() == 0, "delete_cascade removed the members");
    check!(fails, Service::new().seq_eq(svc).count(&db).await.unwrap() == 0, "delete_cascade removed the service");
    check!(fails, ServiceModule::new().seq_eq(md).count(&db).await.unwrap() == 1, "no_cascade_delete kept the module");
    check!(fails, ServiceModule::new().seq_eq(md).delete(&db).await.unwrap() == 1, "module cleaned up");

    // ---- deadlock gate: T1 locks A then B, T2 locks B then A; the loser's closure re-runs ----
    let a = draft("dl-rust-1").insert(&db).await.expect("dl a").unwrap().seq;
    let b = draft("dl-rust-2").insert(&db).await.expect("dl b").unwrap().seq;
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let runs = Arc::new(AtomicUsize::new(0));
    let last_writer = Arc::new(AtomicUsize::new(0));
    let task = |id: usize, first: i64, second: i64| {
        let (db, barrier, runs, last_writer) = (db.clone(), barrier.clone(), runs.clone(), last_writer.clone());
        tokio::spawn(async move {
            let attempts = AtomicUsize::new(0);
            db.transaction(|tx| {
                let (barrier, runs, last_writer) = (barrier.clone(), runs.clone(), last_writer.clone());
                let attempt = attempts.fetch_add(1, Ordering::Relaxed);
                async move {
                    runs.fetch_add(1, Ordering::Relaxed);
                    Battle::new().seq_eq(first).set_like_count(id as i64 * 10).update(&tx).await?;
                    // both sides hold their first row before touching the second; a re-run has no partner to wait for
                    if attempt == 0 { barrier.wait().await; }
                    Battle::new().seq_eq(second).set_like_count(id as i64 * 10).update(&tx).await?;
                    last_writer.store(id, Ordering::Relaxed);
                    Ok(())
                }
            }).await
        })
    };
    let (r1, r2) = tokio::join!(task(1, a, b), task(2, b, a));
    check!(fails, r1.expect("t1 join").is_ok() && r2.expect("t2 join").is_ok(), "both transactions eventually succeed");
    check!(fails, runs.load(Ordering::Relaxed) >= 3, "the deadlock loser re-ran its closure");
    let expect = last_writer.load(Ordering::Relaxed) as i64 * 10;
    let (ra, rb) = (Battle::new().one_by_seq(&db, a).await.unwrap().unwrap(), Battle::new().one_by_seq(&db, b).await.unwrap().unwrap());
    check!(fails, expect > 0 && ra.like_count == expect && rb.like_count == expect, "final values are the last writer's");
    check!(fails, Battle::new().seq_in(vec![a, b]).delete(&db).await.unwrap() == 2, "deadlock rows cleaned up");

    // ---- S5: on_query plan_id, secret masking, driver error mapping, orm.toml ----
    let s = Battle::new().seq_eq(1).sql(&db).await.expect("sql");
    Battle::new().seq_eq(2).all(&db).await.expect("all"); // same shape (kind all), another value
    check!(fails, s.plan_id != 0 && last_plan.load(Ordering::Relaxed) == s.plan_id, "on_query plan_id is the plan-cache key of the statement's shape");
    check!(fails, !leaked.load(Ordering::Relaxed), "the hook never sees the AES key (secret binds masked as $SECRET)");
    let d1 = draft("rust-dup").set_uuid(Some("rust-dup")).insert(&db).await.expect("dup fixture").unwrap();
    match draft("rust-dup-2").set_uuid(Some("rust-dup")).insert(&db).await {
        Err(e) if e.code() == orm::codes::DUPLICATE_KEY && e.to_string().contains("Duplicate entry") => {}
        other => { fails += 1; eprintln!("FAIL: duplicate uuid not mapped to DUPLICATE_KEY: {:?}", other.err()); }
    }
    check!(fails, Battle::new().seq_eq(d1.seq).delete(&db).await.unwrap() == 1, "duplicate fixture cleaned up");

    let dir = std::env::temp_dir().join(format!("orm-rust-it-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmp dir");
    let (wasm_abs, schema_abs) = (std::path::absolute(&args[1]).unwrap(), std::path::absolute(&args[2]).unwrap());
    let dsn = std::env::var("ORM_MYSQL_URL_RUST").unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into());
    let toml = |schema: &str| format!("schema = {schema:?}\n[db]\ndsn = {dsn:?}\npool = 2\n[secrets]\naes = \"bench-salt\"\n[engine]\nwasm = {:?}\n[debug]\non_query = false\n", wasm_abs);
    let bad = dir.join("relative.toml");
    std::fs::write(&bad, toml("schema/schema.json")).unwrap();
    match Db::from_config(&bad).await {
        Err(e) if e.code() == orm::codes::CONFIG => {}
        other => { fails += 1; eprintln!("FAIL: relative schema path not rejected: {:?}", other.err()); }
    }
    let good = dir.join("orm.toml");
    std::fs::write(&good, toml(schema_abs.to_str().unwrap())).unwrap();
    let db2 = Db::from_config(&good).await.expect("from_config");
    check!(fails, gen::init(db2.engine.clone()).is_ok(), "the engine from orm.toml passes the boot check");
    let b = Battle::new().one_by_seq(&db2, 42).await.expect("one via from_config").expect("row 42");
    check!(fails, b.seq == 42 && b.aes_hex_email.as_deref() == Some("user42@example.com"), "from_config: [db], [engine] and [secrets] applied");
    let _ = std::fs::remove_dir_all(&dir);

    if fails == 0 { println!("ok"); } else { std::process::exit(1); }
}
