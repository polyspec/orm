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
        // SQLite binds datetimes as text: the same value still masks
        Param::Str(s) if m.ts.as_ref().map(|t| fmt_time(t) == *s).unwrap_or(false) => json!("$TS"),
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
            *mask.lock().unwrap() = Mask::default();
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



    run!("interface_query_reuse", async {
        let mut q=Battle::new().bind(&db).service_seq(7).limit(0,2);
        let first=q.get_count().await?;let rows=q.gets().await?;let last=q.get_count().await?;
        Ok(json!([first,rows.len(),last]))
    }.await);
    run!("interface_attach", async {
        let child=User::new().seq_in(vec![1,2]).and(|w|w.name("user-1").or().name("user-2"));
        let a=Battle::new().service_seq(7).join_user(&child);
        let b=Battle::new().service_seq(8).join_user(&child);
        let child=child.name("later");
        Ok(json!({"a":a.q.req.ir.query,"b":b.q.req.ir.query,"child":child.q.req.ir.query,
            "a_params":a.q.req.params.iter().map(|p|norm(p,&Mask::default())).collect::<Vec<_>>(),
            "b_params":b.q.req.params.iter().map(|p|norm(p,&Mask::default())).collect::<Vec<_>>(),
            "child_params":child.q.req.params.iter().map(|p|norm(p,&Mask::default())).collect::<Vec<_>>()}))
    }.await);
    run!("interface_typed_keys", async {
        let mut c=Collection::with_capacity(0);
        for (key,name) in [(Key::I(1),"first"),(Key::S("1".into()),"string"),(Key::I(2),"second"),(Key::I(1),"last")] {
            let mut row=ServiceRow::default();row.set_name(name);c.put(key,row);
        }
        Ok(json!(c.entries().map(|(k,r)|json!([match k{Key::I(i)=>json!(i),Key::S(s)=>json!(s)},r.name])).collect::<Vec<_>>()))
    }.await);
    run!("interface_invalid_page", async { Battle::new().bind(&db).paginate(1,0).await?;Ok(Value::Null) }.await);
    run!("interface_error", async {
        let mut child=User::new();
        child.q.defer_err(orm::codec::encode(&["unsupported"],Some(&json!("x"))).unwrap_err());
        let mut q=Battle::new().bind(&db).join_user(child);
        let first=q.sql().await.err().map(|e|e.code().to_owned());let second=q.sql().await.err().map(|e|e.code().to_owned());
        Ok(json!([first,second]))
    }.await);
    run!("interface_row_state", async {
        let observed=Arc::new(Mutex::new(None));
        let err=db.transaction(|tx|{let observed=observed.clone();let log=log.clone();async move {
            let mut r=Battle::new().bind(&tx).select_none().select_seq().get_by_seq(6).await?.unwrap();
            let before=r.has("name");
            r.set_name("interface-first").set_like_count(5).set_name("interface-final");
            r.update().await?;let n=log.lock().unwrap().len();r.update().await?;
            *observed.lock().unwrap()=Some(json!({"before":before,"assigned":r.has("name"),"value":r.name,"export":r.to_map(),"noop_statements":log.lock().unwrap().len()-n,"relation_loaded":r.rel_loaded("user")}));
            Err::<(),_>(orm::Error::Config("interface rollback".into()))
        }}).await.unwrap_err();
        if err.to_string()!="CONFIG: interface rollback"{return Err(err)}
        let value=observed.lock().unwrap().take().unwrap();Ok(value)
    }.await);
    run!("interface_dirty_retry", async {
        let observed=Arc::new(Mutex::new(None));
        let err=db.transaction(|tx|{let observed=observed.clone();let log=log.clone();let mask=mask.clone();async move {
            let mut r=Battle::new().bind(&tx).get_by_seq(6).await?.unwrap();
            mask_created(&mask,&log,Mask{seqs:vec![],ts:Some(r.updated_ts)});
            Battle::new().bind(&tx).seq(6).set_updated_ts(chrono::NaiveDate::from_ymd_opt(2001,1,1).unwrap().and_hms_opt(0,0,0).unwrap()).update().await?;
            r.set_name("interface-pending");
            let first=r.update_optimistic().await.err().map(|e|e.code().to_owned());let second=r.update_optimistic().await.err().map(|e|e.code().to_owned());
            *observed.lock().unwrap()=Some(json!({"errors":[first,second],"value":r.name}));
            Err::<(),_>(orm::Error::Config("interface rollback".into()))
        }}).await.unwrap_err();
        if err.to_string()!="CONFIG: interface rollback"{return Err(err)}
        let value=observed.lock().unwrap().take().unwrap();Ok(value)
    }.await);

    run!("interface_original_version", async {
        let observed=Arc::new(Mutex::new(None));
        let err=db.transaction(|tx|{let observed=observed.clone();let log=log.clone();let mask=mask.clone();async move {
            let mut r=Battle::new().bind(&tx).get_by_seq(6).await?.unwrap();
            mask_created(&mask,&log,Mask{seqs:vec![],ts:Some(r.updated_ts)});
            let version=chrono::NaiveDate::from_ymd_opt(2002,1,1).unwrap().and_hms_opt(0,0,0).unwrap();
            r.set_updated_ts(version).set_name("interface-version");r.update_optimistic().await?;
            let mut sparse=Battle::new().bind(&tx).select_none().select_seq().get_by_seq(6).await?.unwrap();sparse.set_name("not-written");
            let missing=sparse.update_optimistic().await.err().map(|e|e.code().to_owned());
            let stored=Battle::new().bind(&tx).get_by_seq(6).await?.unwrap();
            *observed.lock().unwrap()=Some(json!({"name":stored.name,"version_retained":r.updated_ts==version&&stored.updated_ts==version,"missing_version":missing,"pending":sparse.name}));
            Err::<(),_>(orm::Error::Config("interface rollback".into()))
        }}).await.unwrap_err();
        if err.to_string()!="CONFIG: interface rollback"{return Err(err)}
        let value=observed.lock().unwrap().take().unwrap();Ok(value)
    }.await);
    run!("unbound_terminal", async { Ok(json!(Battle::new().get_count_by_service_seq(7).await?)) }.await);
    run!("bound_count_finder", async {
        Ok(json!(Battle::new().bind(&db)
            .join_service(Service::new().where_(|w| w.name("service-7")))
            .relation_user(User::new()).get_count_by_service_seq(7).await?))
    }.await);
    run!("finished_transaction", async {
        let mut q = db.transaction(|tx| async move { Ok(Battle::new().bind(&tx)) }).await?;
        Ok(json!(q.get_count_by_service_seq(7).await?))
    }.await);
    run!("bound_transaction_rollback", async {
        let observed = Arc::new(Mutex::new(None));
        let err = db.transaction(|tx| {
            let observed = observed.clone();
            let db = &db;
            async move {
                let mut s = Service::new().bind(&tx).set_name("conf-bind").insert().await?.unwrap();
                s.set_name("conf-bound").update().await?;
                let m = ServiceMember::new().bind(&tx).set_service_seq(s.seq).set_user_seq(1).insert().await?.unwrap();
                let parent = Service::new().bind(db).bind(&tx)
                    .relations_members(ServiceMember::new().bind(db).join_user(User::new())).get_by_seq(s.seq).await?.unwrap();
                if parent.name != "conf-bound" || parent.members().len() != 1 {
                    return Err(orm::Error::Config("bound relation missing".into()));
                }
                let mut child = parent.members().first().unwrap().clone();
                child.set_user_seq(2).update().await?;
                child.user().unwrap().clone().set_name("conf-user").update().await?;
                let changed = ServiceMember::new().bind(&tx).user_seq(2).get_count_by_service_seq(s.seq).await?;
                let u = User::new().bind(&tx).get_by_seq(1).await?.unwrap();
                *observed.lock().unwrap() = Some((s.seq, m, changed, u.name));
                Err::<bool, _>(orm::Error::Config("binding rollback".into()))
            }
        }).await;
        match err {
            Err(orm::Error::Config(ref msg)) if msg == "binding rollback" => {}
            Err(e) => return Err(e),
            Ok(_) => return Err(orm::Error::Config("rollback missing".into())),
        }
        let (seq, m, changed, joined_name) = observed.lock().unwrap().take().unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![seq, m.seq], ts: None });
        let expired = m.delete().await.err().map(|e| e.code().to_string());
        let members_left = ServiceMember::new().bind(&db).get_count_by_service_seq(seq).await?;
        let service_left = Service::new().bind(&db).get_count_by_seq(seq).await?;
        let u = User::new().bind(&db).get_by_seq(1).await?.unwrap();
        Ok(json!({"changed": changed, "joined_name": joined_name, "expired_row": expired,
            "members_left": members_left, "service_left": service_left, "user_name": u.name}))
    }.await);

    run!("pk_one", async { Ok(row(Battle::new().seq(42).bind(&db).get().await?.as_ref())) }.await);
    run!("pk_one_by", async { Ok(row(Battle::new().bind(&db).get_by_seq(42).await?.as_ref())) }.await);
    run!("pk_missing", async { Ok(row(Battle::new().seq(0).bind(&db).get().await?.as_ref())) }.await);
    run!("select_lazy", async {
        let b = Battle::new().select_description().seq(42).bind(&db).get().await?.unwrap();
        Ok(json!({"seq": b.seq, "description_prefix": &b.description.as_deref().unwrap()[..7]}))
    }.await);
    run!("list_order_limit", async {
        Ok(keyed(&Battle::new().service_seq(7).is_close(false).order_by_seq_desc().limit(0, 5).bind(&db).gets().await?))
    }.await);
    run!("in_keyed", async { Ok(keys(&Battle::new().seq_in(vec![306, 6, 106]).order_by_seq_asc().bind(&db).gets().await?)) }.await);
    run!("group_or", async {
        Ok(keyed(&Battle::new()
            .service_seq(7)
            .is_close(false)
            .and(|w| w.is_display(true).or().and(|w| w.is_display(false).display_start_dt_lt(now)))
            .seq_in(vec![6, 106, 206, 306, 406])
            .order_by_seq_desc()
            .limit(0, 3)
            .bind(&db).gets()
            .await?))
    }.await);
    run!("aggregates", async {
        Ok(json!({
            "count": Battle::new().service_seq(7).bind(&db).get_count().await?,
            "sum_like_count": Battle::new().service_seq(7).bind(&db).sum_like_count().await?,
            "avg_like_count": Battle::new().service_seq(7).bind(&db).avg_like_count().await?,
        }))
    }.await);
    run!("join_nav_count", async {
        Ok(json!(Battle::new()
            .join_service(Service::new().where_(|w| w.name("service-7")))
            .left_join_user(User::new().on(|w| w.name_contains("user")))
            .is_close(false)
            .and(|w| w.is_display(true).or().service(|s| s.seq_gt(1000)))
            .bind(&db).get_count()
            .await?))
    }.await);
    run!("join_row", async {
        let b = Battle::new().join_service(Service::new().where_(|w| w.seq(7))).seq(6).bind(&db).get().await?.unwrap();
        let s = b.service().unwrap();
        Ok(json!({"seq": b.seq, "service": {"seq": s.seq, "name": s.name}}))
    }.await);
    run!("root_finder_join_relation", async {
        let c = Battle::new().select_none()
            .join_service(Service::new().where_(|w| w.name("service-7")))
            .relation_user(User::new()).order_by_seq_asc().limit(0, 2)
            .bind(&db).gets_by_service_seq(7).await?;
        Ok(Value::Array(c.iter().map(|(_, b)| json!({
            "seq": b.seq,
            "service": b.service().map(|s| json!({"seq": s.seq, "name": s.name})),
            "user": b.user().map(|u| json!({"seq": u.seq, "name": u.name})),
        })).collect()))
    }.await);
    run!("paginate", async {
        let p = Battle::new().service_seq(7).order_by_seq_asc().bind(&db).paginate(2, 10).await?;
        Ok(json!({"total": p.total, "pages": p.pages, "current": p.current, "per": p.per, "keys": keys(&p.items)}))
    }.await);
    run!("contains_escape", async { Ok(json!(Battle::new().name_contains("%").bind(&db).get_count().await?)) }.await);
    run!("empty_in_error", async { Ok(json!(Battle::new().seq_in(vec![]).bind(&db).get_count().await?)) }.await);
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
                .bind(&tx).insert().await
        }).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![created.seq], ts: Some(created.updated_ts) });
        let mut c = created.clone();
        c.set_name("conf-write-2").set_like_count(5);
        c.bind(&db).update_optimistic().await?;
        let again = Battle::new().bind(&db).one_by_seq(created.seq).await?.unwrap();
        c.set_name("stale");
        let stale = match c.bind(&db).update_optimistic().await {
            Ok(()) => Value::Null,
            Err(e) => json!(e.code()),
        };
        again.delete().await?;
        let left = Battle::new().seq(created.seq).bind(&db).get_count().await?;
        Ok(json!({
            "inserted": created.seq > 0, "email": created.aes_hex_email,
            "after_update": {"name": again.name, "like_count": again.like_count},
            "stale": stale, "left": left,
        }))
    }.await);

    run!("eq_col_where", async {
        Ok(keys(&Battle::new()
            .join_service(Service::new().where_(|w| w.seq_eq_col(battle::cols::service_module_seq())))
            .seq_in(vec![1, 2, 10]).order_by_seq_asc().bind(&db).gets().await?))
    }.await);
    run!("expr_where", async { Ok(json!(Battle::new().service_seq(7).expr("LENGTH(`name`) > ?", vec![8.into()]).bind(&db).get_count().await?)) }.await);
    run!("select_expr", async {
        let b = Battle::new().select_expr("tag", "CONCAT(`name`, '!')").seq(42).bind(&db).get().await?.unwrap();
        Ok(json!({"seq": b.seq, "tag": b.extra("tag").map(|v| v.as_string())}))
    }.await);
    run!("relation_four_levels", async {
        Ok(Battle::new().select_none().seq(7)
            .relation_service(Service::new()
                .relations_members(ServiceMember::new().order_by_seq_asc().limit_per_parent(2)
                    .relation_user(User::new()
                        .relations_battles(Battle::new().select_none().order_by_seq_asc().limit_per_parent(1)))))
            .bind(&db).get().await?.unwrap().to_map())
    }.await);
    run!("relation_one_ordered", async { Ok(Battle::new().select_none().seq(7).relation_service(Service::new().order_by_seq_desc()).bind(&db).get().await?.unwrap().to_map()) }.await);
    run!("relation_if_parent", async {
        let c = Battle::new().select_none().seq_in(vec![7, 8, 14]).order_by_seq_asc().relation_user(User::new().if_parent_is_close_eq(true)).bind(&db).gets().await?;
        Ok(Value::Array(c.iter().map(|(_, b)| b.to_map()).collect()))
    }.await);
    run!("relation_empty_parents", async { Ok(keys(&Battle::new().seq(0).relation_user(User::new()).bind(&db).gets().await?)) }.await);
    run!("relation_off_join", async { Ok(Battle::new().select_none().seq(8).join_service(Service::new().relations_modules(ServiceModule::new())).bind(&db).get().await?.unwrap().to_map()) }.await);
    run!("paginate_relations", async {
        let p = Battle::new().select_none().service_seq(7).order_by_seq_asc().relation_user(User::new()).bind(&db).paginate(1, 3).await?;
        Ok(json!({"total": p.total, "items": p.items.iter().map(|(_, b)| b.to_map()).collect::<Vec<_>>()}))
    }.await);
    run!("key_by_column", async { Ok(Service::new().seq(7).relations_members(ServiceMember::new().order_by_seq_asc().limit_per_parent(3).key_by_user_seq()).bind(&db).get().await?.unwrap().to_map()) }.await);
    run!("key_by_unselected", async { Ok(Service::new().seq(7).relations_modules(ServiceModule::new().select_none().key_by_name()).bind(&db).get().await?.unwrap().to_map()) }.await);
    run!("types_roundtrip", async {
        let dt = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_micro_opt(12, 34, 56, 123456).unwrap();
        let created = db.transaction(|tx| async move {
            Battle::new()
                .set_name("conf-types")
                .set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1)
                .set_start_dt(dt).set_end_dt(dt).set_display_start_dt(Some(dt)).set_is_display(true).set_target_team_player_count(2147483647).set_read_count(4294967295).set_price(Some(12345.678))
                .set_json_setting(json!({"k": []})).set_jsons_tags(json!([])).set_serialize_data(json!(""))
                .bind(&tx).insert().await
        }).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![created.seq], ts: Some(created.updated_ts) });
        let b = Battle::new().select_json_setting().select_jsons_tags().select_serialize_data().seq(created.seq).bind(&db).get().await?.unwrap();
        b.delete().await?;
        Ok(json!({
            "display_start_dt": fmt_time(b.display_start_dt.as_ref().unwrap()), "is_display": b.is_display, "is_close": b.is_close,
            "target_team_player_count": b.target_team_player_count, "read_count": b.read_count, "price": b.price,
            "json_setting": b.json_setting, "jsons_tags": b.jsons_tags, "serialize_data": b.serialize_data,
        }))
    }.await);
    run!("key_by_fn_to_array", async {
        let c = ServiceMember::new().service_seq(7).order_by_seq_asc().limit(0, 2)
            .relation_user(User::new().flatten())
            .key_by_fn(|m| Key::S(format!("u{}", m.user_seq)))
            .bind(&db).gets().await?;
        Ok(Value::Array(c.iter().map(|(k, m)| json!([k.to_string(), m.to_map()])).collect()))
    }.await);
    run!("drop_child_key_to_array", async {
        let u = User::new().seq(5).relations_battles(Battle::new().select_none().order_by_seq_asc().limit_per_parent(2).drop_child_key()).bind(&db).get().await?.unwrap();
        Ok(u.to_map())
    }.await);
    let fks = |q: Battle| q.set_user_seq(1).set_service_seq(999).set_service_module_seq(1).set_service_member_seq(1).set_start_dt(start).set_end_dt(end);
    run!("upsert", async {
        let (a, b) = db.transaction(|tx| async move {
            let a = fks(Battle::new().set_uuid(Some("conf-upsert")).set_name("u1").set_read_count(1)).bind(&tx).insert().await?.unwrap();
            let b = fks(Battle::new().set_uuid(Some("conf-upsert")).set_name("u2").set_read_count(1))
                .on_duplicate_set_name("u2").on_duplicate_plus_read_count(5)
                .bind(&tx).insert().await?.unwrap();
            b.delete().await?;
            Ok((a, b))
        }).await?;
        mask_created(&mask, &log, Mask { seqs: vec![a.seq], ts: Some(a.updated_ts) });
        Ok(json!({"same_seq": a.seq == b.seq, "name": b.name, "read_count": b.read_count}))
    }.await);
    run!("upsert_set_all", async {
        let (a, b) = db.transaction(|tx| async move {
            let a = fks(Battle::new().set_uuid(Some("conf-upsert")).set_name("u1").set_read_count(1)).bind(&tx).insert().await?.unwrap();
            let b = fks(Battle::new().set_uuid(Some("conf-upsert")).set_name("u3").set_read_count(9)).on_duplicate_set_all().bind(&tx).insert().await?.unwrap();
            b.delete().await?;
            Ok((a, b))
        }).await?;
        mask_created(&mask, &log, Mask { seqs: vec![a.seq], ts: Some(a.updated_ts) });
        Ok(json!({"same_seq": a.seq == b.seq, "name": b.name, "read_count": b.read_count}))
    }.await);
    run!("save_branch", async {
        let r = db.transaction(|tx| async move { fks(Battle::new().set_name("conf-save")).bind(&tx).save().await }).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![r.seq], ts: Some(r.updated_ts) });
        let after = Battle::new().set_seq(r.seq).set_name("conf-save-2").bind(&db).save().await?.unwrap();
        after.delete().await?;
        Ok(json!({"inserted": r.seq > 0, "after": after.name}))
    }.await);
    run!("bulk_update_plus_minus", async {
        let r = db.transaction(|tx| async move { fks(Battle::new().set_read_count(3).set_name("conf-bulk")).bind(&tx).insert().await }).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![r.seq], ts: Some(r.updated_ts) });
        let read = |seq: i64| { let db = &db; async move { Battle::new().bind(db).one_by_seq(seq).await.map(|b| b.unwrap().read_count) } };
        Battle::new().seq(r.seq).plus_read_count(2).bind(&db).update().await?;
        let after_plus = read(r.seq).await?;
        // minus clamps at zero
        Battle::new().seq(r.seq).minus_read_count(10).bind(&db).update().await?;
        let after_minus = read(r.seq).await?;
        Battle::new().seq(r.seq).set_read_count_expr("`read_count` * ? + 1", vec![2.into()]).bind(&db).update().await?;
        let after_expr = read(r.seq).await?;
        let deleted = Battle::new().seq(r.seq).bind(&db).delete().await?;
        Ok(json!({"after_plus": after_plus, "after_minus": after_minus, "after_expr": after_expr, "deleted": deleted}))
    }.await);
    run!("delete_cascade_order", async {
        let (s, m1, m2, md) = db.transaction(|tx| async move {
            let s = Service::new().set_name("conf-svc").bind(&tx).insert().await?.unwrap();
            let m1 = ServiceMember::new().set_service_seq(s.seq).set_user_seq(1).bind(&tx).insert().await?.unwrap();
            let m2 = ServiceMember::new().set_service_seq(s.seq).set_user_seq(2).bind(&tx).insert().await?.unwrap();
            let md = ServiceModule::new().set_service_seq(s.seq).set_name("conf-mod").bind(&tx).insert().await?.unwrap();
            Ok((s.seq, m1.seq, m2.seq, md.seq))
        }).await?;
        mask_created(&mask, &log, Mask { seqs: vec![s, m1, m2, md], ts: None });
        Service::new().seq(s)
            .relations_members(ServiceMember::new().order_by_seq_asc())
            .relations_modules(ServiceModule::new().no_cascade_delete())
            .bind(&db).get().await?.unwrap()
            .bind(&db).delete_cascade().await?;
        let members_left = ServiceMember::new().service_seq(s).bind(&db).get_count().await?;
        let modules_left = ServiceModule::new().service_seq(s).bind(&db).get_count().await?;
        let service_left = Service::new().seq(s).bind(&db).get_count().await?;
        ServiceModule::new().seq(md).bind(&db).delete().await?;
        Ok(json!({"members_left": members_left, "modules_left": modules_left, "service_left": service_left}))
    }.await);
    run!("sql_dump", async {
        let s = Battle::new().service_seq(7).select_aes_hex_email().limit(0, 1).bind(&db).sql().await?;
        Ok(json!({"sql": s.sql, "binds": s.binds.iter().map(|p| norm(p, &Mask::default())).collect::<Vec<_>>()}))
    }.await);
    run!("agg_min_max", async {
        Ok(json!({
            "min": Battle::new().service_seq(7).bind(&db).min_seq().await?,
            "max": Battle::new().service_seq(7).bind(&db).max_seq().await?,
            "distinct_users": Battle::new().service_seq(7).bind(&db).count_distinct_user_seq().await?,
        }))
    }.await);
    run!("group_count_having", async {
        Ok(json!(Battle::new().service_seq(7).group_by_user_seq().having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).bind(&db).get_count().await?))
    }.await);
    run!("predicate_named", async {
        Ok(json!({
            "visible": Battle::new().visible().service_seq(7).bind(&db).get_count().await?,
            "started_after": Battle::new().started_after("2026-01-01 00:00:00").service_seq(7).bind(&db).get_count().await?,
        }))
    }.await);
    run!("raw_root", async {
        let rows = Battle::new()
            .raw("SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?", vec![7.into(), false.into()])
            .bind(&db).raw_all().await?;
        Ok(Value::Array(rows.iter().map(|r| Value::Object(r.iter().map(|(k, v)| (k.clone(), v.to_json())).collect())).collect()))
    }.await);
    run!("join_fulltext_or", async {
        Ok(json!(Battle::new()
            .join_service(Service::new().where_(|w| w.seq(7)))
            .is_close(false)
            .and(|w| w.name_with_description_match_boolean("battle").or().service(|s| s.name("service-999")))
            .bind(&db).get_count().await?))
    }.await);
    run!("join_two_groups", async {
        Ok(json!(Battle::new()
            .join_service(Service::new().on(|w| w.name("service-7")).where_(|w| w.seq_gt(0)))
            .left_join_user(User::new().where_(|w| w.name_contains("user-4")))
            .seq_in(vec![6, 106, 206, 406])
            .bind(&db).get_count().await?))
    }.await);
    run!("join_multi_level", async {
        Ok(Battle::new().select_none().seq(6)
            .join_service_member(ServiceMember::new().select_none()
                .join_user(User::new().select_none())
                .join_service(Service::new().select_none()))
            .bind(&db).get().await?.unwrap().to_map())
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
                .bind(&tx).insert().await
        }}).await?.unwrap();
        mask_created(&mask, &log, Mask { seqs: vec![created.seq], ts: Some(created.updated_ts) });
        let b = Battle::new().select_json_setting().select_jsons_tags().select_base64_extra().select_serialize_data().select_gz_extend().seq(created.seq).bind(&db).get().await?.unwrap();
        b.delete().await?;
        Ok(json!({"json_setting": b.json_setting, "jsons_tags": b.jsons_tags, "base64_extra": b.base64_extra, "serialize_data": b.serialize_data, "gz_extend": b.gz_extend, "ip": b.ip}))
    }.await);

    println!("{}", serde_json::to_string_pretty(&Value::Object(out.into_iter().collect())).unwrap());
}
