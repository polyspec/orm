//! Rust half of the S1 demo: same statements as the Go/PHP integration tests.
//! Usage: integration <ormengine.wasm> <schema.json>
//! The database under test is `ORM_TEST_DRIVER` (mysql default) with `ORM_TEST_DSN`
//! (MySQL falls back to `ORM_MYSQL_URL_RUST`, then the local socket). Results are asserted
//! as they are on every database; the SQL assertions read the statement in the MySQL spelling.
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use chrono::Datelike;
use gen::*;
use orm::collection::Key;
use orm::value::{Param, Val};
use orm::db::{Config, ConnectOptions, Db, Exec};
use orm::engine::{Engine, EngineConfig};
use orm::plan::{BindSlot, Step};

macro_rules! check {
    ($fails:ident, $cond:expr, $what:expr) => {
        if !$cond { $fails += 1; eprintln!("FAIL: {}", $what); }
    };
}

/// The database under test: (driver, dsn).
fn target() -> (String, String) {
    let driver = std::env::var("ORM_TEST_DRIVER").unwrap_or_else(|_| "mysql".into());
    let dsn = match std::env::var("ORM_TEST_DSN") {
        Ok(d) => d,
        Err(_) if driver == "mysql" => std::env::var("ORM_MYSQL_URL_RUST").unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into()),
        Err(_) => panic!("ORM_TEST_DSN is required for driver {driver}"),
    };
    (driver, dsn)
}

/// The statement in the MySQL spelling (backticks, `?`, `LIMIT off, n`) so one assertion reads every dialect.
fn norm_sql(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => out.push('`'),
            '$' if chars.peek().map(|d| d.is_ascii_digit()).unwrap_or(false) => {
                while chars.peek().map(|d| d.is_ascii_digit()).unwrap_or(false) {
                    chars.next();
                }
                out.push('?');
            }
            _ => out.push(c),
        }
    }
    match out.rsplit_once(" LIMIT ") {
        Some((head, tail)) if tail.contains(" OFFSET ") => {
            let (n, off) = tail.split_once(" OFFSET ").unwrap();
            format!("{head} LIMIT {off}, {n}")
        }
        _ => out,
    }
}

fn direct_step(sql: String, parameters: usize) -> Step {
    Step { plan_id: 0, id: 0, role: "test".into(), sql, bind_slots: (0..parameters).map(|param| BindSlot { from: "param".into(), param, transform: String::new(), name: String::new(), step: 0, column: String::new(), host_styles: vec![], col_type: String::new() }).collect(), assemble: None, parent: None }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wasm = std::fs::read(&args[1]).expect("wasm");
    let schema = std::fs::read(&args[2]).expect("schema.json");
    let (driver, dsn) = target();
    let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, dialect: &driver, cache_dir: None }).expect("engine"));
    let mut fails = 0;
    // ---- S6: the driver must be the engine's dialect ----
    let other = if driver == "mysql" { "sqlite" } else { "mysql" };
    let other_dsn = if other == "mysql" { "mysql://root@localhost/x" } else { "sqlite::memory:" };
    match Db::connect(ConnectOptions::parse(other, other_dsn).unwrap(), 1, engine.clone(), Config { aes_key: String::new(), aes_version: 1, on_query: None }).await {
        Err(e) if e.code() == orm::codes::CONFIG
            && e.to_string().contains("driver")
            && e.to_string().contains("compiler uses") => {}
        other => { fails += 1; eprintln!("FAIL: driver/dialect mismatch not rejected: {:?}", other.err()); }
    }
    // ---- S5 boot check: an engine whose loaded manifest has another hash is refused, and the crate stays unbound ----
    let mut wrong = Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, dialect: &driver, cache_dir: None }).expect("engine");
    wrong.schema_hash = "0000000000000000".into();
    match gen::init(Arc::new(wrong)) {
        Err(e) if e.code() == orm::codes::SCHEMA_HASH_MISMATCH => {}
        other => { fails += 1; eprintln!("FAIL: wrong schema hash not rejected: {:?}", other.err()); }
    }
    gen::init(engine.clone()).expect("schema hash");
    check!(fails, gen::SCHEMA_HASH == engine.schema_hash, "gen::SCHEMA_HASH is the engine's loaded hash");
    let opts = ConnectOptions::parse(&driver, &dsn).expect("connect options");
    let statements = Arc::new(AtomicUsize::new(0));
    let last_plan = Arc::new(AtomicU64::new(0));
    let leaked = Arc::new(AtomicBool::new(false));
    let (counter, last_plan_h, leaked_h) = (statements.clone(), last_plan.clone(), leaked.clone());
    let on_query = Box::new(move |_: &str, binds: &[Param], _: std::time::Duration, plan_id: u64, _: Option<&orm::Error>| {
        counter.fetch_add(1, Ordering::Relaxed);
        last_plan_h.store(plan_id, Ordering::Relaxed);
        if binds.iter().any(|b| *b == Param::Str("bench-salt".into())) { leaked_h.store(true, Ordering::Relaxed); }
    });
    let db = Db::connect(opts, 4, engine, Config { aes_key: "bench-salt".into(), aes_version: 1, on_query: Some(on_query) }).await.expect("connect");

    // ---- reads ----
    let b = battle::query().using(&db).one_by_seq(42).await.expect("one").expect("row 42");
    check!(fails, b.seq == 42 && b.name == "battle-42" && b.aes_hex_email.as_deref() == Some("user42@example.com"), "one by pk + aes decode");
    check!(fails, b.description.is_none(), "lazy column not loaded by default");
    check!(fails, b.is_close && !b.is_display, "bool coercion (42: closed, not displayed)");

    let b2 = battle::query().select_description().seq_eq(42).using(&db).one().await.unwrap().unwrap();
    check!(fails, b2.description.as_deref().map(|d| d.starts_with("desc-42")).unwrap_or(false), "select lazy column");

    let now = chrono::NaiveDate::from_ymd_opt(2026, 9, 11).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let rows = battle::query()
        .service_seq_eq(7)
        .is_close_eq(false)
        .and(|w| w.is_display_eq(true).or().and(|w| w.is_display_eq(false).display_start_dt_lt(now)))
        .seq_in(vec![6, 106, 206, 306, 406])
        .order_by_seq_desc()
        .limit(0, 3)
        .using(&db).all()
        .await
        .expect("all");
    check!(fails, rows.len() == 3 && rows.first().map(|r| r.seq) == Some(306), "all + group + or + in + order + limit");
    for (k, r) in &rows { check!(fails, k.as_i64() == r.seq, "collection keyed by pk"); }

    check!(fails, battle::query().service_seq_eq(7).using(&db).count().await.unwrap() == 1000, "count");
    check!(fails, battle::query().service_seq_eq(7).using(&db).sum_like_count().await.unwrap() > 0.0, "sum");

    let cnt = battle::query()
        .join(service::query().where_(|w| w.name_eq("service-7")))
        .left_join(user::query().on(|w| w.name_contains("user")))
        .is_close_eq(false)
        .and(|w| w.is_display_eq(true).or().service(|s| s.seq_gt(1000)))
        .using(&db).count()
        .await
        .expect("join count");
    check!(fails, cnt > 0, "join + on/where + nav");

    let page = battle::query().service_seq_eq(7).order_by_seq_asc().using(&db).paginate(2, 10).await.expect("paginate");
    check!(fails, page.total == 1000 && page.pages == 100 && page.items.len() == 10 && page.items.first().map(|r| r.seq) == Some(1006), "paginate");
    check!(fails, battle::query().name_contains("%").using(&db).count().await.unwrap() == 0, "contains escapes %");

    let j = battle::query().join(service::query().where_(|w| w.seq_eq(7))).seq_eq(6).using(&db).one().await.unwrap().unwrap();
    check!(fails, j.service().map(|s| s.name.as_str()) == Some("service-7"), "joined row access");

    let mut streamed = Vec::new();
    let stream_result = battle::query().service_seq_eq(7).order_by_seq_asc().using(&db).stream(|row| {
        streamed.push(row);
        streamed.len() < 3
    }).await.expect("stream stop");
    check!(fails, stream_result.state == orm::db::STREAM_STOPPED && stream_result.count == 3, "stream visitor stop");
    check!(fails, streamed.len() == 3 && streamed[0].seq != streamed[1].seq && !streamed[0].name.is_empty(), "stream row ownership");
    check!(fails, battle::query().service_seq_eq(7).using(&db).get_count().await.unwrap() > 0, "stream cursor closes after visitor stop");
    let stream_result = battle::query().service_seq_eq(7).order_by_seq_asc().limit(0, 4).using(&db).stream(|_| true).await.expect("stream exhaustion");
    check!(fails, stream_result.state == orm::db::STREAM_EXHAUSTED && stream_result.count == 4, "stream exhaustion");
    match battle::query().relation(user::query()).using(&db).stream(|_| true).await {
        Err(error) if error.code() == orm::codes::IR_INVALID => {}
        other => { fails += 1; eprintln!("FAIL: relation stream not rejected: {:?}", other.err()); }
    }

    // ---- S4: count_distinct / min / max, having, named predicates, raw root ----
    check!(fails, battle::query().service_seq_eq(7).using(&db).count_distinct_user_seq().await.unwrap() == 50, "count_distinct");
    check!(fails, battle::query().service_seq_eq(7).using(&db).min_seq().await.unwrap() == Some(6), "min typed (i64)");
    check!(fails, battle::query().service_seq_eq(7).using(&db).max_seq().await.unwrap() == Some(99906), "max typed (i64)");
    check!(fails, battle::query().seq_eq(0).using(&db).max_seq().await.unwrap().is_none(), "max over no rows is None");
    check!(fails, battle::query().seq_eq(0).using(&db).min_name().await.unwrap().is_none(), "min String over no rows is None");
    let mx = battle::query().service_seq_eq(7).using(&db).max_start_dt().await.unwrap();
    check!(fails, mx.map(|t| t.date().year() >= 2020).unwrap_or(false), "max typed (NaiveDateTime)");
    check!(fails, battle::query().service_seq_eq(7).using(&db).max_price().await.unwrap().is_none(), "max over a NULL-only column is None");
    check!(fails, battle::query().service_seq_eq(7).group_by_user_seq().using(&db).count().await.unwrap() == 50, "count + group_by = number of groups");
    check!(fails, battle::query().service_seq_eq(7).group_by_user_seq().having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).using(&db).count().await.unwrap() == 50, "having on group count");
    check!(fails, battle::query().service_seq_eq(7).group_by_user_seq().having(|w| w.expr("COUNT(*) > ?", vec![1000.into()])).using(&db).count().await.unwrap() == 0, "having filters every group");
    // row select keeps HAVING (grouped by the PK so only_full_group_by holds): every group is one row
    let grouped = battle::query().service_seq_eq(7).group_by_seq().having(|w| w.expr("COUNT(*) > ?", vec![0.into()])).order_by_seq_asc().limit(0, 2).using(&db).all().await.expect("having rows");
    check!(fails, grouped.len() == 2 && grouped.first().map(|b| b.seq) == Some(6), "having on row select");
    check!(fails, battle::query().service_seq_eq(7).group_by_seq().having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).limit(0, 2).using(&db).all().await.unwrap().is_empty(), "having on row select filters every group");
    match battle::query().service_seq_eq(7).having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).using(&db).count().await {
        Err(e) if e.code() == "IR_INVALID" => {}
        other => { fails += 1; eprintln!("FAIL: having without group_by not rejected: {:?}", other.err()); }
    }
    let visible = battle::query().visible().service_seq_eq(7).using(&db).count().await.expect("visible");
    check!(fails, visible == battle::query().service_seq_eq(7).is_close_eq(false).is_display_eq(true).using(&db).count().await.unwrap() && visible > 0, "predicate visible() = is_close 0 AND is_display 1");
    check!(fails, battle::query().started_after("2026-01-01 00:00:00").service_seq_eq(7).using(&db).count().await.unwrap() == 1000, "predicate started_after(v) on the query");
    check!(fails, battle::query().service_seq_eq(7).and(|w| w.visible().or().started_after("2999-01-01 00:00:00")).using(&db).count().await.unwrap() == visible, "predicates on the Where builder honour or()");
    let all_visible = battle::query().visible().using(&db).count().await.unwrap();
    check!(fails, all_visible > visible && battle::query().seq_eq(0).or().visible().using(&db).count().await.unwrap() == all_visible, "query predicate honours a pending or()");
    let rows = battle::query().raw("SELECT COUNT(*) AS n, MAX(seq) AS m, MIN(start_dt) AS d FROM {table} WHERE service_seq = ? AND is_close = ?", vec![7.into(), false.into()]).using(&db).raw_all().await.expect("raw_all");
    check!(fails, rows.len() == 1 && rows[0].keys().cloned().collect::<Vec<_>>() == vec!["n", "m", "d"], "raw_all: one row keyed by column name in column order");
    // SQLite stores datetimes as text; the other drivers type the column
    let d_typed = match rows[0].get("d") { Some(Val::DateTime(_)) => driver != "sqlite", Some(Val::Str(s)) => driver == "sqlite" && s.starts_with("20"), _ => false };
    check!(fails, matches!(rows[0].get("n"), Some(Val::I64(_))) && rows[0].get("m") == Some(&Val::I64(99906)) && d_typed, "raw_all: cells typed by column type");
    check!(fails, battle::query().raw("SELECT seq FROM {table} WHERE seq = ?", vec![0.into()]).using(&db).raw_all().await.unwrap().is_empty(), "raw_all: no rows = empty list");
    match battle::query().raw("SELECT seq FROM {table} WHERE seq = ?", vec![]).using(&db).raw_all().await {
        Err(e) if e.code() == "IR_INVALID" => {}
        other => { fails += 1; eprintln!("FAIL: raw placeholder/bind mismatch not rejected: {:?}", other.err()); }
    }

    // ---- relations ----
    let n0 = statements.load(Ordering::Relaxed);
    let rows = battle::query()
        .service_seq_eq(7).order_by_seq_asc().limit(0, 5)
        .relation(user::query())
        .relation(service::query()
            .relations(service_member::query().order_by_seq_desc().limit_per_parent(3).key_by_user_seq().drop_child_key()))
        .using(&db).all().await.expect("relations");
    check!(fails, rows.len() == 5 && statements.load(Ordering::Relaxed) - n0 == 4, "relation statements: main, user, service, members");
    for (_, b) in &rows {
        check!(fails, b.user().map(|u| u.seq == b.user_seq && u.name == format!("user-{}", b.user_seq)) == Some(true), "one relation");
        check!(fails, b.service().map(|s| s.seq == 7 && s.members().len() == 3) == Some(true), "nested many relation, 3 per parent");
        for (k, m) in b.service().unwrap().members() { check!(fails, k.as_i64() == m.user_seq && m.service_seq == 7, "key_by user_seq"); }
    }
    let rows = battle::query()
        .seq_in(vec![7, 8, 14]).order_by_seq_asc()
        .relation(user::query().if_parent_is_close_eq(true).relations(battle::query().order_by_seq_asc().limit_per_parent(2)))
        .join(service::query().relations(service_module::query()))
        .using(&db).all().await.expect("if_parent");
    let (b7, b8, b14) = (rows.get(&Key::of(&Val::I64(7))).unwrap(), rows.get(&Key::of(&Val::I64(8))).unwrap(), rows.get(&Key::of(&Val::I64(14))).unwrap());
    check!(fails, b7.user().is_some() && b14.user().is_some() && b8.user().is_none(), "if_parent loads only closed battles' users");
    check!(fails, b7.user().unwrap().battles().len() == 2, "nested many under one, limit_per_parent");
    check!(fails, b8.service().map(|s| s.modules().len() == 1 && s.modules().first().unwrap().service_seq == b8.service_seq) == Some(true), "relation off a join");
    let n0 = statements.load(Ordering::Relaxed);
    let none = battle::query().seq_eq(0).relation(user::query()).using(&db).all().await.expect("empty");
    check!(fails, none.is_empty() && statements.load(Ordering::Relaxed) - n0 == 1, "no parents → relation step skipped");
    let one = battle::query().seq_eq(42).relation(service::query().relations(service_member::query().limit_per_parent(1))).using(&db).one().await.expect("one").expect("row 42");
    check!(fails, one.service().map(|s| s.members().len()) == Some(1), "one + relation");
    // flatten: typed access is unchanged (array/JSON forms merge the child's columns)
    let m = service_member::query().service_seq_eq(7).order_by_seq_asc().limit(0, 2).relation(user::query().flatten()).using(&db).all().await.expect("flatten");
    check!(fails, m.first().and_then(|m| m.user()).map(|u| u.name.starts_with("user-")) == Some(true), "flatten");
    let page = battle::query().service_seq_eq(7).order_by_seq_asc().relation(user::query()).using(&db).paginate(1, 4).await.expect("paginate");
    check!(fails, page.total == 1000 && page.items.len() == 4 && page.items.first().and_then(|b| b.user()).is_some(), "paginate keeps relations");

    // ---- writes ----
    // Dropping a transaction future must invalidate handles retained outside the
    // callback and release its uncommitted write even while those handles live.
    let retained = Arc::new(std::sync::Mutex::new(None));
    let ready = Arc::new(tokio::sync::Notify::new());
    let mut cancelled = Box::pin(db.transaction(|tx| {
        let retained = retained.clone(); let ready = ready.clone();
        async move {
            let r = service::query().using(&tx).set_name("interface-cancel").insert().await?;
            *retained.lock().unwrap() = r;
            ready.notify_one();
            std::future::pending::<orm::Result<()>>().await
        }
    }));
    tokio::select! {
        _ = ready.notified() => {},
        result = &mut cancelled => panic!("transaction ended before cancellation: {result:?}"),
    }
    drop(cancelled);
    let retained = retained.lock().unwrap().take().unwrap();
    check!(fails, retained.delete().await.unwrap_err().code() == "CONFIG", "cancelled transaction invalidates retained row");
    let remaining = service::query().using(&db).get_count_by_name("interface-cancel").await.unwrap();
    check!(fails, remaining == 0, "cancelled transaction rolled back while row retained");

    let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let end = chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let created = db.transaction(|tx| async move {
        battle::query()
            .set_name("rust-write")
            .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
            .set_start_dt(start).set_end_dt(end)
            .set_aes_hex_email(Some("w@example.com"))
            .using(&tx).insert().await
    }).await.expect("insert").expect("inserted row");
    check!(fails, created.seq > 0 && created.aes_hex_email.as_deref() == Some("w@example.com"), "insert in tx + aes");

    let mut c = created.clone();
    c.set_name("rust-write-2").set_like_count(5);
    c.using(&db).update_optimistic().await.expect("update");
    let again = battle::query().using(&db).one_by_seq(created.seq).await.unwrap().unwrap();
    check!(fails, again.name == "rust-write-2" && again.like_count == 5, "dirty update");
    c.set_name("stale");
    match c.using(&db).update_optimistic().await {
        Err(e) if e.code() == "OPTIMISTIC_LOCK" => {}
        other => { fails += 1; eprintln!("FAIL: optimistic lock not detected: {:?}", other.err()); }
    }
    again.delete().await.expect("delete");
    check!(fails, battle::query().seq_eq(created.seq).using(&db).count().await.unwrap() == 0, "delete");

    match battle::query().seq_in(vec![]).using(&db).count().await {
        Err(e) if e.code() == "EMPTY_IN" => {}
        other => { fails += 1; eprintln!("FAIL: EMPTY_IN: {:?}", other.err()); }
    }

    // ---- S3 writes: upsert, save, query update/delete, sql, delete_cascade ----
    let draft = |name: &str| battle::query()
        .set_name(name)
        .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
        .set_start_dt(start).set_end_dt(end);
    let a = draft("rust-u1").set_uuid(Some("rust-upsert")).set_read_count(1).using(&db).insert().await.expect("insert a").unwrap();
    let b = draft("rust-u2").set_uuid(Some("rust-upsert")).set_read_count(1)
        .on_duplicate_set_name("rust-u2").on_duplicate_plus_read_count(5)
        .using(&db).insert().await.expect("upsert").unwrap();
    check!(fails, a.seq == b.seq && b.name == "rust-u2" && b.read_count == 6, "on_duplicate: existing row returned, set + plus applied");
    let c = draft("rust-u3").set_uuid(Some("rust-upsert")).set_read_count(9).on_duplicate_set_all().using(&db).insert().await.expect("upsert set_all").unwrap();
    check!(fails, c.seq == a.seq && c.name == "rust-u3" && c.read_count == 9, "on_duplicate_set_all copies the draft's set columns");
    let n = battle::query().seq_eq(a.seq).plus_read_count(2).using(&db).update().await.expect("query update");
    check!(fails, n == 1 && battle::query().using(&db).one_by_seq(a.seq).await.unwrap().unwrap().read_count == 11, "query update: affected 1, plus applied");
    let n = battle::query().seq_eq(a.seq).minus_read_count(100).using(&db).update().await.expect("query update minus");
    check!(fails, n == 1 && battle::query().using(&db).one_by_seq(a.seq).await.unwrap().unwrap().read_count == 0, "minus clamps at zero");
    let saved = battle::query().set_seq(a.seq).set_name("rust-saved").using(&db).save().await.expect("save update").unwrap();
    check!(fails, saved.seq == a.seq && saved.name == "rust-saved" && saved.uuid.as_deref() == Some("rust-upsert"), "save with pk: update + re-read");
    let inserted = draft("rust-saved-new").using(&db).save().await.expect("save insert").unwrap();
    check!(fails, inserted.seq != a.seq && inserted.name == "rust-saved-new", "save without pk: insert");
    match battle::query().set_name("x").using(&db).update().await {
        Err(e) if e.code() == "IR_INVALID" => {}
        other => { fails += 1; eprintln!("FAIL: update without where not rejected: {:?}", other.err()); }
    }
    let n0 = statements.load(Ordering::Relaxed);
    let s = battle::query().service_seq_eq(7).select_aes_hex_email().limit(0, 1).using(&db).sql().await.expect("sql");
    check!(fails, s.sql.starts_with("SELECT ") && norm_sql(&s.sql).ends_with(" LIMIT 0, 1") && statements.load(Ordering::Relaxed) == n0, "sql renders without executing");
    // MySQL decrypts in SQL (two secret slots); the other dialects decode aes/hex in the executor
    let want_binds = if driver == "mysql" { vec![Param::Str("$SECRET".into()), Param::Str("$SECRET".into()), Param::I64(7)] } else { vec![Param::I64(7)] };
    check!(fails, s.binds == want_binds, "sql binds: secrets masked, params as values");
    check!(fails, battle::query().seq_in(vec![a.seq, inserted.seq]).using(&db).delete().await.expect("query delete") == 2, "query delete: affected count");

    let (svc, m1, m2, md) = db.transaction(|tx| async move {
        let s = service::query().set_name("rust-svc").using(&tx).insert().await?.unwrap();
        let m1 = service_member::query().set_service_seq(s.seq).set_user_seq(1).using(&tx).insert().await?.unwrap();
        let m2 = service_member::query().set_service_seq(s.seq).set_user_seq(2).using(&tx).insert().await?.unwrap();
        let md = service_module::query().set_service_seq(s.seq).set_name("rust-mod").using(&tx).insert().await?.unwrap();
        Ok((s.seq, m1.seq, m2.seq, md.seq))
    }).await.expect("cascade fixture");
    let row = service::query().seq_eq(svc)
        .relations(service_member::query().order_by_seq_asc())
        .relations(service_module::query().no_cascade_delete())
        .using(&db).one().await.expect("service").expect("service row");
    check!(fails, row.members().len() == 2 && row.modules().len() == 1, "cascade fixture loaded");
    let n0 = statements.load(Ordering::Relaxed);
    row.delete_cascade().await.expect("delete_cascade");
    check!(fails, statements.load(Ordering::Relaxed) - n0 == 3, "delete_cascade: one DELETE per member + the service");
    check!(fails, service_member::query().seq_in(vec![m1, m2]).using(&db).count().await.unwrap() == 0, "delete_cascade removed the members");
    check!(fails, service::query().seq_eq(svc).using(&db).count().await.unwrap() == 0, "delete_cascade removed the service");
    check!(fails, service_module::query().seq_eq(md).using(&db).count().await.unwrap() == 1, "no_cascade_delete kept the module");
    check!(fails, service_module::query().seq_eq(md).using(&db).delete().await.unwrap() == 1, "module cleaned up");

    // ---- deadlock gate: T1 locks A then B, T2 locks B then A; the loser's closure re-runs ----
    // SQLite has one writer: two transactions cannot interleave row locks (SQLITE_BUSY is
    // mapped to DEADLOCK and re-run, but this scenario cannot happen), so the gate is MySQL/PostgreSQL only.
    if driver != "sqlite" {
    let a = draft("dl-rust-1").using(&db).insert().await.expect("dl a").unwrap().seq;
    let b = draft("dl-rust-2").using(&db).insert().await.expect("dl b").unwrap().seq;
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
                    battle::query().seq_eq(first).set_like_count(id as i64 * 10).using(&tx).update().await?;
                    // both sides hold their first row before touching the second; a re-run has no partner to wait for
                    if attempt == 0 { barrier.wait().await; }
                    battle::query().seq_eq(second).set_like_count(id as i64 * 10).using(&tx).update().await?;
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
    let (ra, rb) = (battle::query().using(&db).one_by_seq(a).await.unwrap().unwrap(), battle::query().using(&db).one_by_seq(b).await.unwrap().unwrap());
    check!(fails, expect > 0 && ra.like_count == expect && rb.like_count == expect, "final values are the last writer's");
    check!(fails, battle::query().seq_in(vec![a, b]).using(&db).delete().await.unwrap() == 2, "deadlock rows cleaned up");
    }

    // ---- S7: versioned AES database rotation ----
    let rotation_table = "orm_aes_rotation_test";
    let quote = |name: &str| if driver == "mysql" { format!("`{name}`") } else { format!("\"{name}\"") };
    let _ = db.execute(&direct_step(format!("DROP TABLE IF EXISTS {}", quote(rotation_table)), 0), &[]).await;
    db.execute(&direct_step(format!("CREATE TABLE {} ({} BIGINT NOT NULL, {} BIGINT NOT NULL, {} INTEGER NOT NULL, {} VARCHAR(255), {} VARCHAR(255), PRIMARY KEY ({}, {}))", quote(rotation_table), quote("tenant_id"), quote("id"), quote("aes_key_version"), quote("aes_hex_email"), quote("aes_hex_phone"), quote("tenant_id"), quote("id")), 0), &[]).await.expect("create AES rotation table");
    let styles = vec!["aes".to_owned(), "hex".to_owned()];
    let email = orm::codec::host_encode(&Param::Str("member@example.test".into()), &styles, "rotation-key-v1").expect("encode email");
    let phone = orm::codec::host_encode(&Param::Str("01012345678".into()), &styles, "rotation-key-v1").expect("encode phone");
    let values = if driver == "postgres" { "$1, $2, $3, $4, $5" } else { "?, ?, ?, ?, ?" };
    let insert = direct_step(format!("INSERT INTO {} ({}, {}, {}, {}, {}) VALUES ({values})", quote(rotation_table), quote("tenant_id"), quote("id"), quote("aes_key_version"), quote("aes_hex_email"), quote("aes_hex_phone")), 5);
    for id in [1_i64, 2_i64] { db.execute(&insert, &[Param::I64(7), Param::I64(id), Param::I64(1), email.clone(), phone.clone()]).await.expect("seed AES rotation table"); }
    let keyring = orm::aes_rotation::AesKeyring::new([(1, "rotation-key-v1".to_owned()), (2, "rotation-key-v2".to_owned())].into_iter().collect(), 2).expect("AES keyring");
    let spec = orm::aes_rotation::AesRotationSpec { table: rotation_table.into(), primary_keys: vec!["tenant_id".into(), "id".into()], version_column: "aes_key_version".into(), columns: vec![orm::aes_rotation::AesRotationColumn { name: "aes_hex_email".into(), styles: styles.clone() }, orm::aes_rotation::AesRotationColumn { name: "aes_hex_phone".into(), styles: styles.clone() }] };
    let before = orm::aes_rotation::aes_status(&db, &spec, &keyring).await.expect("AES status before");
    let changed = orm::aes_rotation::rotate_aes_rows(&db, &spec, &keyring).await.expect("AES rotate");
    let after = orm::aes_rotation::aes_status(&db, &spec, &keyring).await.expect("AES status after");
    let repeated = orm::aes_rotation::rotate_aes_rows(&db, &spec, &keyring).await.expect("AES rotate repeat");
    check!(fails, before.total == 2 && before.pending == 2 && before.versions.get(&1) == Some(&2), "AES status reports the stored source version");
    check!(fails, changed == 2 && after.pending == 0 && after.versions.get(&2) == Some(&2) && repeated == 0, "AES rotation updates every composite-key row once and repeat is a no-op");
    let raw = db.query(&direct_step(format!("SELECT {}, {}, {} FROM {} WHERE {} = 7 AND {} = 1", quote("aes_key_version"), quote("aes_hex_email"), quote("aes_hex_phone"), quote(rotation_table), quote("tenant_id"), quote("id")), 0), &[], vec![]).await.expect("read rotated AES row");
    let stored = orm::row::read_row(&raw[0], 3).expect("decode rotated row");
    let decoded_email = orm::codec::host_decode(&stored[1], &styles, "rotation-key-v2").expect("decode rotated email");
    let decoded_phone = orm::codec::host_decode(&stored[2], &styles, "rotation-key-v2").expect("decode rotated phone");
    check!(fails, stored[0].as_i64() == 2 && decoded_email == Val::Str("member@example.test".into()) && decoded_phone == Val::Str("01012345678".into()), "AES rotation stores every AES column with the current key");
    db.execute(&direct_step(format!("DROP TABLE {}", quote(rotation_table)), 0), &[]).await.expect("drop AES rotation table");

    // ---- S5: on_query plan_id, secret masking, driver error mapping, orm.toml ----
    let s = battle::query().seq_eq(1).using(&db).sql().await.expect("sql");
    battle::query().seq_eq(2).using(&db).all().await.expect("all"); // same shape (kind all), another value
    check!(fails, s.plan_id != 0 && last_plan.load(Ordering::Relaxed) == s.plan_id, "on_query plan_id is the plan-cache key of the statement's shape");
    check!(fails, !leaked.load(Ordering::Relaxed), "the hook never sees the AES key (secret binds masked as $SECRET)");
    let d1 = draft("rust-dup").set_uuid(Some("rust-dup")).using(&db).insert().await.expect("dup fixture").unwrap();
    // the driver's own message is kept
    let driver_msg = match driver.as_str() { "mysql" => "Duplicate entry", "postgres" => "23505", _ => "UNIQUE" };
    match draft("rust-dup-2").set_uuid(Some("rust-dup")).using(&db).insert().await {
        Err(e) if e.code() == orm::codes::DUPLICATE_KEY && e.to_string().contains(driver_msg) && !e.is_deadlock() => {}
        other => { fails += 1; eprintln!("FAIL: duplicate uuid not mapped to DUPLICATE_KEY: {:?}", other.err()); }
    }
    check!(fails, battle::query().seq_eq(d1.seq).using(&db).delete().await.unwrap() == 1, "duplicate fixture cleaned up");

    let dir = std::env::temp_dir().join(format!("orm-rust-it-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmp dir");
    let (wasm_abs, schema_abs) = (std::path::absolute(&args[1]).unwrap(), std::path::absolute(&args[2]).unwrap());
    let toml = |schema: &str| format!("schema = {schema:?}\n[db]\ndriver = {driver:?}\ndsn = {dsn:?}\npool = 2\n[secrets]\naes = \"bench-salt\"\n[engine]\nwasm = {:?}\n[debug]\non_query = false\n", wasm_abs);
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
    check!(fails, db2.driver() == driver && db2.engine.dialect == driver, "from_config: [db].driver selects the pool and the engine dialect");
    let b = battle::query().using(&db2).one_by_seq(42).await.expect("one via from_config").expect("row 42");
    check!(fails, b.seq == 42 && b.aes_hex_email.as_deref() == Some("user42@example.com"), "from_config: [db], [engine] and [secrets] applied");
    let _ = std::fs::remove_dir_all(&dir);

    if fails == 0 { println!("ok"); } else { std::process::exit(1); }
}
