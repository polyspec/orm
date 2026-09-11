//! Conformance runner (Rust). Same chains as tests/conformance/runner_go and runner.php; prints the same document.
//! Usage: conformance <ormengine.wasm> <schema.json>
use std::sync::{Arc, Mutex};

use gen::*;
use orm::builder::Q;
use orm::collection::{Collection, Key};
use orm::db::{Config, Db};
use orm::engine::{Engine, EngineConfig};
use orm::value::Param;
use serde_json::{json, Value};
use sqlx::mysql::MySqlConnectOptions;

type Log = Arc<Mutex<Vec<Value>>>;

#[derive(Default, Clone)]
struct Mask {
    seq: i64,
    ts: Option<chrono::NaiveDateTime>,
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
        Param::I64(x) if m.seq != 0 && *x == m.seq => json!("$SEQ"),
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

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wasm = std::fs::read(&args[1]).expect("wasm");
    let schema = std::fs::read(&args[2]).expect("schema.json");
    let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, cache_dir: None }).expect("engine"));
    gen::init(engine.clone());

    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let mask = Arc::new(Mutex::new(Mask::default()));
    let (log_h, mask_h) = (log.clone(), mask.clone());
    let on_query = Box::new(move |sql: &str, params: &[Param], _: std::time::Duration, _: Option<&orm::Error>| {
        let m = mask_h.lock().unwrap().clone();
        log_h.lock().unwrap().push(json!({"sql": sql, "binds": params.iter().map(|p| norm(p, &m)).collect::<Vec<_>>()}));
    });
    let opts = MySqlConnectOptions::new().socket("/tmp/mysql.sock").username("root").database("orm_bench");
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
        let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let end = chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let created = db.transaction(|tx| async move {
            Battle::new()
                .set_name("conf-write")
                .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
                .set_start_dt(start).set_end_dt(end)
                .set_aes_hex_email(Some("w@example.com"))
                .insert(&tx).await
        }).await?.unwrap();
        *mask.lock().unwrap() = Mask { seq: created.seq, ts: Some(created.updated_ts) };
        {
            // the INSERT's own log entries were recorded before the mask existed: re-mask them
            let m = mask.lock().unwrap().clone();
            for st in log.lock().unwrap().iter_mut() {
                for b in st["binds"].as_array_mut().unwrap() {
                    if *b == json!(m.seq) { *b = json!("$SEQ"); }
                    if *b == json!(fmt_time(m.ts.as_ref().unwrap())) { *b = json!("$TS"); }
                }
            }
        }
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
    run!("expr_where", async { Ok(json!(Battle::new().service_seq_eq(7).expr("DAYOFMONTH(`start_dt`) = ?", vec![1.into()]).count(&db).await?)) }.await);
    run!("select_expr", async {
        let b = Battle::new().select_expr("tag", "CONCAT(`name`, '!')").seq_eq(42).one(&db).await?.unwrap();
        Ok(json!({"seq": b.seq, "tag": b.extra("tag").map(|v| v.as_string())}))
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
    run!("codec_roundtrip", async {
        let value = json!({"a": 1, "b": [1, 2, {"c": "한글/slash"}], "d": null, "e": true, "f": 1.5});
        let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let end = chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let v = value.clone();
        let created = db.transaction(|tx| { let v = v.clone(); async move {
            Battle::new()
                .set_name("conf-codec")
                .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
                .set_start_dt(start).set_end_dt(end)
                .set_json_setting(v.clone()).set_jsons_tags(json!(["x", "y"])).set_base64_extra(v.clone()).set_serialize_data(v.clone()).set_gz_extend(v).set_ip(Some("10.1.2.3"))
                .insert(&tx).await
        }}).await?.unwrap();
        *mask.lock().unwrap() = Mask { seq: created.seq, ts: Some(created.updated_ts) };
        {
            let m = mask.lock().unwrap().clone();
            for st in log.lock().unwrap().iter_mut() {
                for b in st["binds"].as_array_mut().unwrap() {
                    if *b == json!(m.seq) { *b = json!("$SEQ"); }
                    if *b == json!(fmt_time(m.ts.as_ref().unwrap())) { *b = json!("$TS"); }
                }
            }
        }
        let b = Battle::new().select_json_setting().select_jsons_tags().select_base64_extra().select_serialize_data().select_gz_extend().seq_eq(created.seq).one(&db).await?.unwrap();
        b.delete(&db).await?;
        Ok(json!({"json_setting": b.json_setting, "jsons_tags": b.jsons_tags, "base64_extra": b.base64_extra, "serialize_data": b.serialize_data, "gz_extend": b.gz_extend, "ip": b.ip}))
    }.await);

    println!("{}", serde_json::to_string_pretty(&Value::Object(out.into_iter().collect())).unwrap());
}
