//! Conformance runner (Rust). Same chains as tests/conformance/runner_go and runner.php; prints the same document.
//! Usage: conformance <ormengine.wasm> <schema.json> [--driver mysql|postgres|sqlite] [--dsn …]
use std::sync::{Arc, Mutex};

use gen::*;
use orm::builder::Q;
use orm::collection::{Collection, Key};
use orm::db::{Config, ConnectOptions, Db};
use orm::engine::{Engine, EngineConfig};
use orm::value::Param;
use serde_json::{json, Value};

type Log = Arc<Mutex<Vec<Value>>>;

/// Row identity of a write vector: every created seq binds as "$SEQ", the read updated_ts as "$TS".
#[derive(Default, Clone)]
struct Mask {
    seqs: Vec<i64>,
    ts: Option<chrono::NaiveDateTime>,
}

/// Installs the mask for the statements to come and re-masks the ones already logged
/// (the INSERTs and their re-reads ran before the created row was known).
fn mask_created(mask: &Arc<Mutex<Mask>>, log: &Log, m: Mask) {
    for st in log.lock().unwrap().iter_mut() {
        for b in st["binds"].as_array_mut().unwrap() {
            if m.seqs.iter().any(|s| *b == json!(s)) { *b = json!("$SEQ"); }
            if m.ts.as_ref().map(|t| *b == json!(fmt_time(t))).unwrap_or(false) { *b = json!("$TS"); }
        }
    }
    *mask.lock().unwrap() = m;
}

fn fmt_time(t: &chrono::NaiveDateTime) -> String {
    if t.and_utc().timestamp_subsec_nanos() == 0 {
        t.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
    }
}

fn norm(p: &Param, m: &Mask) -> Value {
    match p {
        Param::Null => Value::Null,
        Param::Bool(b) => json!(b),
        Param::I64(x) if m.seqs.contains(x) => json!("$SEQ"),
        Param::I64(x) => json!(x),
        Param::F64(x) => json!(x),
        Param::Str(s) => json!(s),
        Param::Bytes(b) if b.first() == Some(&0x78) => json!("$ZLIB"), // zlib stream (gz style)
        Param::Bytes(b) => json!(String::from_utf8_lossy(b)),
        Param::DateTime(t) if m.ts.as_ref() == Some(t) => json!("$TS"),
        Param::DateTime(t) => json!(fmt_time(t)),
        Param::Date(d) => json!(d.to_string()),
    }
}

fn row(b: Option<&BattleRow>) -> Value {
    match b {
        None => Value::Null,
        Some(b) => json!({
            "seq": b.seq, "name": b.name, "aes_hex_email": b.aes_hex_email, "is_close": b.is_close, "is_display": b.is_display,
            "description": b.description, "start_dt": fmt_time(&b.start_dt), "like_count": b.like_count,
        }),
    }
}

fn keyed(c: &Collection<BattleRow>) -> Value {
    Value::Array(c.iter().map(|(k, r)| json!([k.as_i64(), {"seq": r.seq, "name": r.name, "like_count": r.like_count}])).collect())
}

fn keys(c: &Collection<BattleRow>) -> Value {
    Value::Array(c.iter().map(|(k, _)| json!(k.as_i64())).collect())
}

/// The database under test: `--driver` (mysql default) and `--dsn`; the defaults are the Go
/// runner's (MySQL: `ORM_MYSQL_URL_RUST` when set, else the local socket).
struct Target {
    driver: String,
    dsn: Option<String>,
}

impl Target {
    fn parse(args: &[String]) -> Target {
        let mut t = Target { driver: "mysql".into(), dsn: None };
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--driver" => t.driver = args[i + 1].clone(),
                "--dsn" => t.dsn = Some(args[i + 1].clone()),
                other => panic!("unknown argument {other}; usage: conformance <wasm> <schema.json> [--driver mysql|postgres|sqlite] [--dsn …]"),
            }
            i += 2;
        }
        t
    }

    fn connect_opts(&self) -> ConnectOptions {
        let dsn = match (&self.dsn, self.driver.as_str()) {
            (Some(d), _) => d.clone(),
            (None, "mysql") => std::env::var("ORM_MYSQL_URL_RUST").unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into()),
            (None, "postgres") => "postgres://maxkwon@localhost:5432/orm_bench".into(),
            (None, "sqlite") => "sqlite:///tmp/orm_bench.sqlite".into(),
            (None, other) => panic!("driver {other}: want mysql, postgres or sqlite"),
        };
        ConnectOptions::parse(&self.driver, &dsn).expect("connect options")
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wasm = std::fs::read(&args[1]).expect("wasm");
    let schema = std::fs::read(&args[2]).expect("schema.json");
    let target = Target::parse(&args[3..]);
    let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, dialect: &target.driver, cache_dir: None }).expect("engine"));
    gen::init(engine.clone()).expect("schema hash");

    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let mask = Arc::new(Mutex::new(Mask::default()));
    let (log_h, mask_h) = (log.clone(), mask.clone());
    let on_query = Box::new(move |sql: &str, params: &[Param], _: std::time::Duration, _: u64, _: Option<&orm::Error>| {
        let m = mask_h.lock().unwrap().clone();
        log_h.lock().unwrap().push(json!({"sql": sql, "binds": params.iter().map(|p| norm(p, &m)).collect::<Vec<_>>()}));
    });
    let opts = target.connect_opts();
    let db = Db::connect(opts, 4, engine, Config { aes_key: "bench-salt".into(), on_query: Some(on_query) }).await.expect("connect");

    let mut out: Vec<(String, Value)> = Vec::new();
    macro_rules! run {
        ($name:expr, $body:expr) => {{
            log.lock().unwrap().clear();
            let res: orm::Result<Value> = $body;
            let res = match res {
                Ok(v) => v,
                Err(e) => json!({"error": e.code()}),
            };
            let statements = Value::Array(log.lock().unwrap().clone());
            out.push(($name.into(), json!({"statements": statements, "result": res})));
        }};
    }
    let now = chrono::NaiveDate::from_ymd_opt(2026, 9, 11).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
    let end = chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap().and_hms_opt(0, 0, 0).unwrap();
    // FKs and dts every write vector sets (user 1, service 999, module 1, member 1; 2026-06-01 .. 2026-12-31)

    run!("pk_one", async { Ok(row(Battle::new().seq_eq(42).one(&db).await?.as_ref())) }.await);
    run!("pk_one_by", async { Ok(row(Battle::new().one_by_seq(&db, 42).await?.as_ref())) }.await);
    run!("pk_missing", async { Ok(row(Battle::new().seq_eq(0).one(&db).await?.as_ref())) }.await);
    run!("select_lazy", async {
        let b = Battle::new().select_description().seq_eq(42).one(&db).await?.unwrap();
        Ok(json!({"seq": b.seq, "description_prefix": &b.description.as_deref().unwrap()[..7]}))
    }.await);
    run!("list_order_limit", async {
        Ok(keyed(&Battle::new().service_seq_eq(7).is_close_eq(false).order_by_seq_desc().limit(0, 5).all(&db).await?))
    }.await);
    run!("in_keyed", async { Ok(keys(&Battle::new().seq_in(vec![306, 6, 106]).order_by_seq_asc().all(&db).await?)) }.await);
    run!("group_or", async {
        Ok(keyed(&Battle::new()
            .service_seq_eq(7)
            .is_close_eq(false)
            .and(|w| w.is_display_eq(true).or().and(|w| w.is_display_eq(false).display_start_dt_lt(now)))
            .seq_in(vec![6, 106, 206, 306, 406])
            .order_by_seq_desc()
            .limit(0, 3)
            .all(&db)
            .await?))
    }.await);
    run!("aggregates", async {
        Ok(json!({
            "count": Battle::new().service_seq_eq(7).count(&db).await?,
            "sum_like_count": Battle::new().service_seq_eq(7).sum_like_count(&db).await?,
            "avg_like_count": Battle::new().service_seq_eq(7).avg_like_count(&db).await?,
        }))
    }.await);
    run!("join_nav_count", async {
        Ok(json!(Battle::new()
            .join_service(Service::new().where_(|w| w.name_eq("service-7")))
            .left_join_user(User::new().on(|w| w.name_contains("user")))
            .is_close_eq(false)
            .and(|w| w.is_display_eq(true).or().service(|s| s.seq_gt(1000)))
            .count(&db)
            .await?))
    }.await);
    run!("join_row", async {
        let b = Battle::new().join_service(Service::new().where_(|w| w.seq_eq(7))).seq_eq(6).one(&db).await?.unwrap();
        let s = b.service().unwrap();
        Ok(json!({"seq": b.seq, "service": {"seq": s.seq, "name": s.name}}))
    }.await);
    run!("paginate", async {
        let p = Battle::new().service_seq_eq(7).order_by_seq_asc().paginate(&db, 2, 10).await?;
        Ok(json!({"total": p.total, "pages": p.pages, "current": p.current, "per": p.per, "keys": keys(&p.items)}))
    }.await);
    run!("contains_escape", async { Ok(json!(Battle::new().name_contains("%").count(&db).await?)) }.await);
    run!("empty_in_error", async { Ok(json!(Battle::new().seq_in(vec![]).count(&db).await?)) }.await);
    run!("op_not_allowed_error", async {
        // Not expressible through the typed builder; the untyped core reaches the engine.
        let mut q = Q::new(gen::schema_hash(), "battle");
        q.w().pred("seq", "like", "x");
        Ok(json!(orm::db::scalar(&db, &mut q.req, "count").await?.as_i64()))
    }.await);
    run!("write_cycle", async {
        let created = db.transaction(|tx| async move {
            Battle::new()
                .set_name("conf-write")
                .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
                .set_start_dt(start).set_end_dt(end)
                .set_aes_hex_email(Some("w@example.com"))
                .insert(&tx).await
        }).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![created.seq], ts: Some(created.updated_ts) });
        let mut c = created.clone();
        c.set_name("conf-write-2").set_like_count(5);
        c.update_optimistic(&db).await?;
        let again = Battle::new().one_by_seq(&db, created.seq).await?.unwrap();
        c.set_name("stale");
        let stale = match c.update_optimistic(&db).await {
            Ok(()) => Value::Null,
            Err(e) => json!(e.code()),
        };
        again.delete(&db).await?;
        let left = Battle::new().seq_eq(created.seq).count(&db).await?;
        Ok(json!({
            "inserted": created.seq > 0, "email": created.aes_hex_email,
            "after_update": {"name": again.name, "like_count": again.like_count},
            "stale": stale, "left": left,
        }))
    }.await);

    run!("eq_col_where", async {
        Ok(keys(&Battle::new()
            .join_service(Service::new().where_(|w| w.seq_eq_col(battle::cols::service_module_seq())))
            .seq_in(vec![1, 2, 10]).order_by_seq_asc().all(&db).await?))
    }.await);
    run!("expr_where", async { Ok(json!(Battle::new().service_seq_eq(7).expr("LENGTH(`name`) > ?", vec![8.into()]).count(&db).await?)) }.await);
    run!("select_expr", async {
        let b = Battle::new().select_expr("tag", "CONCAT(`name`, '!')").seq_eq(42).one(&db).await?.unwrap();
        Ok(json!({"seq": b.seq, "tag": b.extra("tag").map(|v| v.as_string())}))
    }.await);
    run!("relation_four_levels", async {
        Ok(Battle::new().select_none().seq_eq(7)
            .relation_service(Service::new()
                .relations_members(ServiceMember::new().order_by_seq_asc().limit_per_parent(2)
                    .relation_user(User::new()
                        .relations_battles(Battle::new().select_none().order_by_seq_asc().limit_per_parent(1)))))
            .one(&db).await?.unwrap().to_map())
    }.await);
    run!("relation_one_ordered", async { Ok(Battle::new().select_none().seq_eq(7).relation_service(Service::new().order_by_seq_desc()).one(&db).await?.unwrap().to_map()) }.await);
    run!("relation_if_parent", async {
        let c = Battle::new().select_none().seq_in(vec![7, 8, 14]).order_by_seq_asc().relation_user(User::new().if_parent_is_close_eq(true)).all(&db).await?;
        Ok(Value::Array(c.iter().map(|(_, b)| b.to_map()).collect()))
    }.await);
    run!("relation_empty_parents", async { Ok(keys(&Battle::new().seq_eq(0).relation_user(User::new()).all(&db).await?)) }.await);
    run!("relation_off_join", async { Ok(Battle::new().select_none().seq_eq(8).join_service(Service::new().relations_modules(ServiceModule::new())).one(&db).await?.unwrap().to_map()) }.await);
    run!("paginate_relations", async {
        let p = Battle::new().select_none().service_seq_eq(7).order_by_seq_asc().relation_user(User::new()).paginate(&db, 1, 3).await?;
        Ok(json!({"total": p.total, "items": p.items.iter().map(|(_, b)| b.to_map()).collect::<Vec<_>>()}))
    }.await);
    run!("key_by_column", async { Ok(Service::new().seq_eq(7).relations_members(ServiceMember::new().order_by_seq_asc().limit_per_parent(3).key_by_user_seq()).one(&db).await?.unwrap().to_map()) }.await);
    run!("key_by_unselected", async { Ok(Service::new().seq_eq(7).relations_modules(ServiceModule::new().select_none().key_by_name()).one(&db).await?.unwrap().to_map()) }.await);
    run!("types_roundtrip", async {
        let dt = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_micro_opt(12, 34, 56, 123456).unwrap();
        let created = db.transaction(|tx| async move {
            Battle::new()
                .set_name("conf-types")
                .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
                .set_start_dt(dt).set_end_dt(dt).set_display_start_dt(Some(dt)).set_is_display(true).set_target_team_player_count(2147483647).set_read_count(4294967295).set_price(Some(12345.678))
                .set_json_setting(json!({"k": []})).set_jsons_tags(json!([])).set_serialize_data(json!(""))
                .insert(&tx).await
        }).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![created.seq], ts: Some(created.updated_ts) });
        let b = Battle::new().select_json_setting().select_jsons_tags().select_serialize_data().seq_eq(created.seq).one(&db).await?.unwrap();
        b.delete(&db).await?;
        Ok(json!({
            "display_start_dt": fmt_time(b.display_start_dt.as_ref().unwrap()), "is_display": b.is_display, "is_close": b.is_close,
            "target_team_player_count": b.target_team_player_count, "read_count": b.read_count, "price": b.price,
            "json_setting": b.json_setting, "jsons_tags": b.jsons_tags, "serialize_data": b.serialize_data,
        }))
    }.await);
    run!("key_by_fn_to_array", async {
        let c = ServiceMember::new().service_seq_eq(7).order_by_seq_asc().limit(0, 2)
            .relation_user(User::new().flatten())
            .key_by_fn(|m| Key::S(format!("u{}", m.user_seq)))
            .all(&db).await?;
        Ok(Value::Array(c.iter().map(|(k, m)| json!([k.to_string(), m.to_map()])).collect()))
    }.await);
    run!("drop_child_key_to_array", async {
        let u = User::new().seq_eq(5).relations_battles(Battle::new().select_none().order_by_seq_asc().limit_per_parent(2).drop_child_key()).one(&db).await?.unwrap();
        Ok(u.to_map())
    }.await);
    let fks = |q: Battle| q.set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1).set_start_dt(start).set_end_dt(end);
    run!("upsert", async {
        let (a, b) = db.transaction(|tx| async move {
            let a = fks(Battle::new().set_uuid(Some("conf-upsert")).set_name("u1").set_read_count(1)).insert(&tx).await?.unwrap();
            let b = fks(Battle::new().set_uuid(Some("conf-upsert")).set_name("u2").set_read_count(1))
                .on_duplicate_set_name("u2").on_duplicate_plus_read_count(5)
                .insert(&tx).await?.unwrap();
            b.delete(&tx).await?;
            Ok((a, b))
        }).await?;
        mask_created(&mask, &log, Mask { seqs: vec![a.seq], ts: Some(a.updated_ts) });
        Ok(json!({"same_seq": a.seq == b.seq, "name": b.name, "read_count": b.read_count}))
    }.await);
    run!("upsert_set_all", async {
        let (a, b) = db.transaction(|tx| async move {
            let a = fks(Battle::new().set_uuid(Some("conf-upsert")).set_name("u1").set_read_count(1)).insert(&tx).await?.unwrap();
            let b = fks(Battle::new().set_uuid(Some("conf-upsert")).set_name("u3").set_read_count(9)).on_duplicate_set_all().insert(&tx).await?.unwrap();
            b.delete(&tx).await?;
            Ok((a, b))
        }).await?;
        mask_created(&mask, &log, Mask { seqs: vec![a.seq], ts: Some(a.updated_ts) });
        Ok(json!({"same_seq": a.seq == b.seq, "name": b.name, "read_count": b.read_count}))
    }.await);
    run!("save_branch", async {
        let r = db.transaction(|tx| async move { fks(Battle::new().set_name("conf-save")).save(&tx).await }).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![r.seq], ts: Some(r.updated_ts) });
        let after = Battle::new().set_seq(r.seq).set_name("conf-save-2").save(&db).await?.unwrap();
        after.delete(&db).await?;
        Ok(json!({"inserted": r.seq > 0, "after": after.name}))
    }.await);
    run!("bulk_update_plus_minus", async {
        let r = db.transaction(|tx| async move { fks(Battle::new().set_read_count(3).set_name("conf-bulk")).insert(&tx).await }).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![r.seq], ts: Some(r.updated_ts) });
        let read = |seq: i64| { let db = &db; async move { Battle::new().one_by_seq(db, seq).await.map(|b| b.unwrap().read_count) } };
        Battle::new().seq_eq(r.seq).plus_read_count(2).update(&db).await?;
        let after_plus = read(r.seq).await?;
        // minus clamps at zero
        Battle::new().seq_eq(r.seq).minus_read_count(10).update(&db).await?;
        let after_minus = read(r.seq).await?;
        Battle::new().seq_eq(r.seq).set_read_count_expr("`read_count` * ? + 1", vec![2.into()]).update(&db).await?;
        let after_expr = read(r.seq).await?;
        let deleted = Battle::new().seq_eq(r.seq).delete(&db).await?;
        Ok(json!({"after_plus": after_plus, "after_minus": after_minus, "after_expr": after_expr, "deleted": deleted}))
    }.await);
    run!("delete_cascade_order", async {
        let (s, m1, m2, md) = db.transaction(|tx| async move {
            let s = Service::new().set_name("conf-svc").insert(&tx).await?.unwrap();
            let m1 = ServiceMember::new().set_service_seq(s.seq).set_user_seq(1).insert(&tx).await?.unwrap();
            let m2 = ServiceMember::new().set_service_seq(s.seq).set_user_seq(2).insert(&tx).await?.unwrap();
            let md = ServiceModule::new().set_service_seq(s.seq).set_name("conf-mod").insert(&tx).await?.unwrap();
            Ok((s.seq, m1.seq, m2.seq, md.seq))
        }).await?;
        mask_created(&mask, &log, Mask { seqs: vec![s, m1, m2, md], ts: None });
        Service::new().seq_eq(s)
            .relations_members(ServiceMember::new().order_by_seq_asc())
            .relations_modules(ServiceModule::new().no_cascade_delete())
            .one(&db).await?.unwrap()
            .delete_cascade(&db).await?;
        let members_left = ServiceMember::new().service_seq_eq(s).count(&db).await?;
        let modules_left = ServiceModule::new().service_seq_eq(s).count(&db).await?;
        let service_left = Service::new().seq_eq(s).count(&db).await?;
        ServiceModule::new().seq_eq(md).delete(&db).await?;
        Ok(json!({"members_left": members_left, "modules_left": modules_left, "service_left": service_left}))
    }.await);
    run!("sql_dump", async {
        let s = Battle::new().service_seq_eq(7).select_aes_hex_email().limit(0, 1).sql(&db).await?;
        Ok(json!({"sql": s.sql, "binds": s.binds.iter().map(|p| norm(p, &Mask::default())).collect::<Vec<_>>()}))
    }.await);
    run!("agg_min_max", async {
        Ok(json!({
            "min": Battle::new().service_seq_eq(7).min_seq(&db).await?,
            "max": Battle::new().service_seq_eq(7).max_seq(&db).await?,
            "distinct_users": Battle::new().service_seq_eq(7).count_distinct_user_seq(&db).await?,
        }))
    }.await);
    run!("group_count_having", async {
        Ok(json!(Battle::new().service_seq_eq(7).group_by_user_seq().having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).count(&db).await?))
    }.await);
    run!("predicate_named", async {
        Ok(json!({
            "visible": Battle::new().visible().service_seq_eq(7).count(&db).await?,
            "started_after": Battle::new().started_after("2026-01-01 00:00:00").service_seq_eq(7).count(&db).await?,
        }))
    }.await);
    run!("raw_root", async {
        let rows = Battle::new()
            .raw("SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?", vec![7.into(), false.into()])
            .raw_all(&db).await?;
        Ok(Value::Array(rows.iter().map(|r| Value::Object(r.iter().map(|(k, v)| (k.clone(), v.to_json())).collect())).collect()))
    }.await);
    run!("codec_roundtrip", async {
        let value = json!({"a": 1, "b": [1, 2, {"c": "한글/slash"}], "d": null, "e": true, "f": 1.5});
        let v = value.clone();
        let created = db.transaction(|tx| { let v = v.clone(); async move {
            Battle::new()
                .set_name("conf-codec")
                .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
                .set_start_dt(start).set_end_dt(end)
                .set_json_setting(v.clone()).set_jsons_tags(json!(["x", "y"])).set_base64_extra(v.clone()).set_serialize_data(v.clone()).set_gz_extend(v).set_ip(Some("10.1.2.3"))
                .insert(&tx).await
        }}).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![created.seq], ts: Some(created.updated_ts) });
        let b = Battle::new().select_json_setting().select_jsons_tags().select_base64_extra().select_serialize_data().select_gz_extend().seq_eq(created.seq).one(&db).await?.unwrap();
        b.delete(&db).await?;
        Ok(json!({"json_setting": b.json_setting, "jsons_tags": b.jsons_tags, "base64_extra": b.base64_extra, "serialize_data": b.serialize_data, "gz_extend": b.gz_extend, "ip": b.ip}))
    }.await);

    println!("{}", serde_json::to_string_pretty(&Value::Object(out.into_iter().collect())).unwrap());
}
