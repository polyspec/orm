//! Conformance runner (Rust). Runs every vector against the bench database and
//! prints {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}; the
//! other runners print the same document for the same chains.
//!
//! Usage: conformance [--driver mysql|postgres|sqlite] [--dsn URI] <schema.json>
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

orm::models!();

use model::{Battle, CompositeAccount, Service, ServiceMember, ServiceModule, User};
use orm::{AesKeyring, Collection, Db, Model, Null, Param};
use serde_json::{json, Map, Value};

#[derive(Default)]
struct Log {
    statements: Vec<Value>,
    seqs: HashSet<i64>,
    times: HashSet<String>,
}

type Shared = Arc<Mutex<Log>>;

fn time_text(t: &chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// Renders a bound value the way every runner does.
fn norm(v: &Value, log: &Log) -> Value {
    match v {
        Value::Number(n) => match n.as_i64() {
            Some(x) if log.seqs.contains(&x) => json!("$SEQ"),
            _ => v.clone(),
        },
        Value::String(s) => {
            if log.times.contains(s) {
                json!("$TS")
            } else if s.starts_with("ORM-AES2") || s.to_lowercase().starts_with("4f524d2d41455332") {
                json!("$AES")
            } else {
                v.clone()
            }
        }
        _ => v.clone(),
    }
}

fn param_json(p: &Param) -> Value {
    match p {
        Param::Null => Value::Null,
        Param::Bool(b) => json!(b),
        Param::I64(x) => json!(x),
        Param::F64(x) => json!(x),
        Param::Str(s) => json!(s),
        Param::Bytes(b) => json!(String::from_utf8_lossy(b)),
        Param::DateTime(t) => json!(time_text(t)),
        Param::Date(d) => json!(d.to_string()),
        Param::Point(p) => json!(orm::point_text(*p).unwrap_or_default()),
    }
}

/// Hides the identity of rows a vector created: their keys and update times
/// wherever they are bound, including statements logged earlier.
fn mask(shared: &Shared, seqs: &[i64], times: &[chrono::NaiveDateTime]) {
    let mut log = shared.lock().unwrap();
    log.seqs.extend(seqs.iter().copied());
    log.times.extend(times.iter().map(time_text));
    let mut statements = std::mem::take(&mut log.statements);
    for st in statements.iter_mut() {
        if let Some(binds) = st["binds"].as_array_mut() {
            for b in binds.iter_mut() {
                *b = norm(b, &log);
            }
        }
    }
    log.statements = statements;
}

fn code(e: &orm::Error) -> Value {
    json!(e.code())
}

fn code_of<T>(r: orm::Result<T>) -> Value {
    match r {
        Ok(_) => Value::Null,
        Err(e) => code(&e),
    }
}

/// Keeps the named values of a row.
fn pick<M: Model>(m: Option<&M>, names: &[&str]) -> Value {
    let Some(m) = m else { return Value::Null };
    let all = orm::model::to_json(m);
    let mut out = Map::new();
    for n in names {
        out.insert((*n).to_owned(), all.get(*n).cloned().unwrap_or(Value::Null));
    }
    Value::Object(out)
}

fn picks<M: Model>(c: &Collection<M>, names: &[&str]) -> Value {
    Value::Array(c.models().map(|m| pick(Some(m), names)).collect())
}

fn keys_of<M: Model>(c: &Collection<M>) -> Value {
    Value::Array(c.keys().iter().map(|k| k.to_json()).collect())
}

fn int(v: Option<Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

struct Args {
    schema: String,
    driver: String,
    dsn: Option<String>,
}

impl Args {
    fn parse() -> Args {
        let mut rest = Vec::new();
        let (mut driver, mut dsn) = ("mysql".to_owned(), None);
        let mut it = std::env::args().skip(1);
        while let Some(a) = it.next() {
            match a.as_str() {
                "--driver" => driver = it.next().expect("--driver value"),
                "--dsn" => dsn = Some(it.next().expect("--dsn value")),
                _ => rest.push(a),
            }
        }
        if rest.len() != 1 {
            eprintln!("usage: conformance [--driver mysql|postgres|sqlite] [--dsn URI] <schema.json>");
            std::process::exit(2);
        }
        Args { schema: rest[0].clone(), driver, dsn }
    }

    fn dsn(&self) -> String {
        if let Some(d) = &self.dsn {
            return d.clone();
        }
        match self.driver.as_str() {
            "postgres" => "postgres:///orm_bench?host=/tmp&timezone=%2B00:00".into(),
            "sqlite" => "sqlite:///tmp/orm_bench.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00".into(),
            _ => "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock&timezone=%2B00:00".into(),
        }
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let schema = orm::Manifest::load(&std::fs::read(&args.schema).expect("schema.json")).expect("schema manifest");
    assert_eq!(schema.schema_hash, model::SCHEMA_HASH, "the models were generated from another schema");
    let shared: Shared = Arc::new(Mutex::new(Log::default()));
    let hook = shared.clone();
    let config = orm::Config {
        aes_key: "bench-salt".into(),
        blind_index_key: "bench-blind-index".into(),
        on_query: Some(Arc::new(move |sql: &str, binds: &[Param], _: std::time::Duration, _: u64, _: Option<&orm::Error>| {
            let mut log = hook.lock().unwrap();
            let binds: Vec<Value> = binds.iter().map(|b| norm(&param_json(b), &log)).collect();
            log.statements.push(json!({"sql": sql, "binds": binds}));
        })),
        ..Default::default()
    };
    let db = Db::connect(&args.dsn(), 4, config).await.expect("connect");
    let out = run_all(&db, &shared).await;
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    db.close().await;
}

async fn run_all(db: &Db, shared: &Shared) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    macro_rules! run {
        ($name:expr, $body:expr) => {{
            *shared.lock().unwrap() = Log::default();
            let res: orm::Result<Value> = $body.await;
            let result = match res {
                Ok(v) => v,
                Err(e) => json!({"error": code(&e)}),
            };
            let statements = std::mem::take(&mut shared.lock().unwrap().statements);
            out.insert($name.to_owned(), json!({"statements": statements, "result": result}));
        }};
    }
    let battle = || Battle::new().connect(db);
    let cols = ["seq", "name", "is_close", "is_display", "read_count"];

    run!("conditions_connectors", async {
        let rows = battle().service_seq(7).and_is_close(false).or(()).read_count(6).order_by_seq_asc().limit(0, 3).gets().await?;
        Ok::<Value, orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_group", async {
        let rows = battle()
            .service_seq(7)
            .and(|q: Battle| q.is_display(false).or(|q: Battle| q.is_close(true).and_gt_read_count(500)))
            .order_by_seq_desc()
            .limit(0, 3)
            .gets()
            .await?;
        Ok::<Value, orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_leading_group", async {
        let rows = battle()
            .and(|q: Battle| q.is_display(false).or_is_close(true))
            .and_service_seq(7)
            .order_by_seq_desc()
            .limit(0, 3)
            .gets()
            .await?;
        Ok::<Value, orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_leading_prefix", async {
        let rows = battle().and_service_seq(7).and_gt_read_count(990).order_by_seq_desc().limit(0, 3).gets().await?;
        Ok::<Value, orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_values", async {
        let mut counts = Vec::new();
        for q in [
            battle().service_seq(vec![7, 8]).and_ne_is_close(true),
            battle().service_seq(7).and_uuid(Null),
            battle().service_seq(7).and_ne_cover_url(Null),
            battle().service_seq(7).and_ne_read_count(vec![6, 106, 206]),
            battle().service_seq(7).and_between_read_count([100, 200]),
            battle().service_seq(7).and_lk_name("attle-10"),
            battle().service_seq(7).and_lb_name("Battle-10"),
            battle().service_seq(7).and_ge_read_count(990),
            battle().service_seq(7).and_le_read_count(10),
            battle().service_seq(7).and_lt_seq(1000),
        ] {
            counts.push(json!(q.get_count().await?));
        }
        Ok::<Value, orm::Error>(Value::Array(counts))
    });
    run!("terminal_by", async {
        let one = battle().get_by_seq(42).await?;
        let missing = battle().get_by_seq(-1).await?;
        let rows = battle().order_by_seq_asc().limit(0, 2).gets_by_service_seq_and_is_close(7, false).await?;
        let count = battle().get_count_by_service_seq(7).await?;
        Ok::<Value, orm::Error>(json!({"one": pick(one.as_ref(), &cols), "missing": missing.is_none(), "rows": picks(&rows, &cols), "count": count}))
    });
    run!("terminal_reuse", async {
        let q = battle().service_seq(7).order_by_seq_asc().limit(0, 2);
        let first = q.get_count_by_is_close(true).await?;
        let rows = q.gets().await?;
        let last = q.get_count().await?;
        Ok::<Value, orm::Error>(json!([first, rows.len(), last]))
    });
    run!("raw_forms", async {
        let count = battle().service_seq(7).and_raw("{read_count} > ?", [990]).get_count().await?;
        let rows = battle()
            .raw("{seq} IN (?, ?)", [42, 43])
            .remove_all_columns()
            .add_raw_column_doubled("({read_count} * ?)", [2])
            .order_by_raw("{seq} DESC")
            .gets()
            .await?;
        let rows: Vec<Value> = rows.models().map(|r| json!([r.get_seq(), int(r.get_doubled())])).collect();
        Ok::<Value, orm::Error>(json!({"count": count, "rows": rows}))
    });
    run!("columns", async {
        let none = Service::new().connect(db).remove_all_columns().get_by_seq(7).await?;
        let added = battle().remove_all_columns().add_column_name().add_column_read_count_alias_read_text("CONCAT('r', %s)").get_by_seq(42).await?;
        let removed = Service::new().connect(db).remove_column_name().get_by_seq(7).await?;
        Ok::<Value, orm::Error>(json!([
            none.map(|m| m.to_array()),
            pick(added.as_ref(), &["seq", "name", "read_text"]),
            removed.map(|m| m.to_array())
        ]))
    });
    run!("joins", async {
        let service = Service::new().on(|s: Service| s.gt_seq(0)).name("service-7");
        let rows = battle()
            .remove_all_columns()
            .add_column_name()
            .join_service_seq_with_seq(service.clone())
            .is_close(false)
            .and(|q: Battle| q.is_display(true).or(&service))
            .order_by_seq_asc()
            .limit(0, 2)
            .gets()
            .await?;
        let member = ServiceMember::new();
        let compared = battle()
            .join_service_member_seq_with_seq(member.clone())
            .service_seq(7)
            .and_success_count_lt_seq(&member)
            .get_count()
            .await?;
        let left = battle()
            .left_join_service_module_seq_with_seq(ServiceModule::new().alias_module())
            .service_seq(7)
            .order_by_seq_asc()
            .limit(0, 1)
            .gets()
            .await?;
        Ok::<Value, orm::Error>(json!({
            "rows": rows.to_array(),
            "compared": compared,
            "module": pick(left.first().and_then(|b| b.get_module()), &["seq", "name"]),
        }))
    });
    run!("relations", async {
        let rows = battle()
            .remove_all_columns()
            .add_column_name()
            .add_column_is_close()
            .relation(
                User::new()
                    .match_user_seq_with_seq()
                    .alias_writer()
                    .relations(Battle::new().match_seq_with_user_seq().remove_all_columns().order_by_seq_desc().group_limit(2)),
            )
            .relation(
                Service::new()
                    .match_service_seq_with_seq()
                    .relations(ServiceMember::new().match_seq_with_service_seq().remove_all_columns().order_by_seq_asc().group_limit(2).key_name_user_seq()),
            )
            .relation(ServiceModule::new().match_service_module_seq_with_seq().possible_is_close(true).parent_node())
            .service_seq(7)
            .order_by_seq_asc()
            .limit(0, 3)
            .gets()
            .await?;
        Ok::<Value, orm::Error>(rows.to_array())
    });
    run!("relation_empty", async {
        let rows = battle().relations(ServiceMember::new().match_user_seq_with_user_seq()).gets_by_seq(-1).await?;
        Ok::<Value, orm::Error>(json!(rows.len()))
    });
    run!("subqueries", async {
        let users = User::new()
            .connect(db)
            .add_column_read_total(|u: &User| Battle::new().sum_read_count().user_seq_eq_seq(u).and_service_seq(7))
            .seq(Battle::new().add_column_user_seq().service_seq(7).and_ge_read_count(906))
            .order_by_seq_asc()
            .gets()
            .await?;
        let out: Vec<Value> = users.models().map(|u| json!([u.get_seq(), int(u.get_read_total())])).collect();
        Ok::<Value, orm::Error>(Value::Array(out))
    });
    run!("aggregates", async {
        let sum = battle().service_seq(7).sum_read_count().get_sum().await?;
        let avg = battle().service_seq(7).avg_like_count().get_avg().await?;
        let groups = battle().service_seq(7).group_by_is_close().order_by_is_close_asc().gets_count().await?;
        let page = battle().service_seq(7).remove_all_columns().order_by_seq_asc().gets_page(3, 4).await?;
        Ok::<Value, orm::Error>(json!({
            "sum": sum,
            "avg": format!("{avg:.4}"),
            "groups": groups.to_array(),
            "page": {"keys": keys_of(&page.items), "total": page.total_count, "pages": page.total_pages, "page": page.page, "per_page": page.per_page},
        }))
    });
    run!("functions", async {
        let mut counts = Vec::new();
        for q in [
            battle().service_seq(7).and_eq_start_dt(orm::day_of_week(), 2),
            battle().service_seq(7).and_start_dt(orm::year(), 2026),
            battle().service_seq(7).and_gt_start_dt(orm::days_ago(36500)),
            battle().service_seq(7).and_lt_start_dt(orm::months_later(1200)),
        ] {
            counts.push(json!(q.get_count().await?));
        }
        let rows = battle()
            .remove_all_columns()
            .add_column_start_dt_alias_start_month(orm::month())
            .order_by_start_dt_asc(orm::year())
            .order_by_seq_asc()
            .gets_by_seq(vec![42, 43])
            .await?;
        let months: Vec<Value> = rows.models().map(|r| json!(int(r.get_start_month()))).collect();
        Ok::<Value, orm::Error>(json!({"counts": counts, "months": months}))
    });
    run!("errors", async {
        let errs = vec![
            code_of(battle().name("a").is_close(true).gets().await),
            code_of(battle().name("a").and(()).gets().await),
            code_of(battle().seq(Vec::<i64>::new()).gets().await),
            code_of(Battle::new().name("a").gets().await),
            code_of(battle().for_update().gets().await),
            code_of(battle().join_user_seq_with_seq(User::new().connect(db)).gets().await),
            code_of(battle().limit(0, 1).gets_page(1, 10).await),
            code_of(battle().relation(User::new().match_user_seq_with_seq().limit(0, 1)).gets_by_seq(42).await),
            code_of(battle().name("a").or(&User::new()).gets().await),
        ];
        Ok::<Value, orm::Error>(Value::Array(errs))
    });
    run!("get_query", async {
        let st = battle()
            .service_seq(7)
            .and_lk_name("x")
            .and_aes_hex_email("user7@example.com")
            .order_by_seq_desc()
            .limit(0, 5)
            .get_query()
            .await?;
        let log = Log::default();
        let binds: Vec<Value> = st.binds.iter().map(|b| norm(&param_json(b), &log)).collect();
        Ok::<Value, orm::Error>(json!({"sql": st.sql, "binds": binds}))
    });
    run!("aes_values", async {
        let row = battle().remove_all_columns().add_column_aes_hex_email().add_column_aes_hex_phone().get_by_seq(42).await?;
        let found = battle().aes_hex_email("user42@example.com").get_count().await?;
        Ok::<Value, orm::Error>(json!({"row": row.map(|r| r.to_array()), "found": found}))
    });
    run!("write_cycle", async {
        let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let created = battle()
            .set_name("cycle")
            .set_user_seq(1)
            .set_service_seq(999)
            .set_service_module_seq(1)
            .set_service_member_seq(1)
            .set_start_dt(start)
            .set_end_dt(start)
            .set_price(12.5)
            .set_ip("10.0.0.1")
            .set_aes_hex_email("cycle@example.com")
            .set_json_setting(json!({"a": 1}))
            .set_serialize_data(json!({"k": "v"}))
            .new_label("created")
            .create()
            .await?;
        let seq = created.get_seq();
        mask(shared, &[seq], &[]);
        let mut created_array = created.to_array();
        created_array["seq"] = json!("$SEQ");
        let loaded = battle().add_all_columns().get_by_seq(seq).await?.ok_or(orm::Error::NoRows)?;
        mask(shared, &[], &[loaded.get_updated_ts()]);
        let mut loaded = loaded.set_name("cycle-2").plus_read_count(3);
        loaded.update(true).await?;
        let mut loaded = loaded.set_name("stale");
        let stale = loaded.update(true).await;
        let again = battle().add_all_columns().get_by_seq(seq).await?.ok_or(orm::Error::NoRows)?;
        let updated = pick(Some(&again), &["name", "read_count", "price", "ip", "aes_hex_email", "json_setting", "serialize_data", "start_dt"]);
        again.delete(false).await?;
        let gone = battle().get_by_seq(seq).await?;
        Ok::<Value, orm::Error>(json!({"created": created_array, "updated": updated, "stale": code_of(stale), "deleted": gone.is_none()}))
    });
    run!("now_defaults", async {
        let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let before = chrono::Utc::now().naive_utc();
        let created = battle()
            .set_name("clock")
            .set_user_seq(1)
            .set_service_seq(999)
            .set_service_module_seq(1)
            .set_service_member_seq(1)
            .set_start_dt(start)
            .set_end_dt(start)
            .create()
            .await?;
        let seq = created.get_seq();
        mask(shared, &[seq], &[]);
        let loaded = battle().get_by_seq(seq).await?.ok_or(orm::Error::NoRows)?;
        let (created_ts, updated_ts) = (loaded.get_created_ts(), loaded.get_updated_ts());
        // The runner connects in +00:00, so the wall-clock value is UTC.
        let near = (created_ts - before).num_seconds().abs() < 60;
        loaded.delete(false).await?;
        Ok::<Value, orm::Error>(json!({"created_near_clock": near, "created_equals_updated": created_ts == updated_ts}))
    });
    run!("creates_and_save", async {
        let rows = vec![
            CompositeAccount::new().set_tenant_id(900).set_account_id(1).set_name("a"),
            CompositeAccount::new().set_tenant_id(900).set_account_id(2).set_name("b"),
            CompositeAccount::new().set_tenant_id(901).set_account_id(1).set_name("c"),
        ];
        let inserted = CompositeAccount::new().connect(db).creates(rows).await?;
        CompositeAccount::new()
            .connect(db)
            .set_tenant_id(900)
            .set_account_id(1)
            .set_name("dup")
            .duplication(CompositeAccount::new().set_name("updated"))
            .create()
            .await?;
        CompositeAccount::new().connect(db).set_tenant_id(900).set_account_id(2).set_name("saved").save().await?;
        let pairs = CompositeAccount::new().connect(db).tuple_tenant_id_with_account_id(vec![(900, 1), (900, 2)]).order_by_account_id_asc().gets().await?;
        let all = CompositeAccount::new().connect(db).tenant_id(vec![900, 901]).order_by_tenant_id_asc().order_by_account_id_asc().gets().await?;
        all.delete(false).await?;
        let left = CompositeAccount::new().connect(db).tenant_id(vec![900, 901]).get_count().await?;
        Ok::<Value, orm::Error>(json!({"inserted": inserted, "pairs": pairs.to_array(), "left": left}))
    });
    run!("delete_recursive", async {
        let service = Service::new().connect(db).set_name("recursive").create().await?;
        let seq = service.get_seq();
        let mut seqs = vec![seq];
        for i in 0..2 {
            let member = ServiceMember::new().connect(db).set_service_seq(seq).set_user_seq(i + 1).create().await?;
            seqs.push(member.get_seq());
        }
        let loaded = Service::new()
            .connect(db)
            .relations(ServiceMember::new().match_seq_with_service_seq())
            .get_by_seq(seq)
            .await?
            .ok_or(orm::Error::NoRows)?;
        let members = loaded.get_service_member_models().map(|c| c.len()).unwrap_or(0);
        mask(shared, &seqs, &[]);
        loaded.delete(true).await?;
        let left = ServiceMember::new().connect(db).get_count_by_service_seq(seq).await?;
        let service2 = Service::new().connect(db).get_by_seq(seq).await?;
        Ok::<Value, orm::Error>(json!({"members": members, "members_left": left, "service_left": service2.is_some()}))
    });
    run!("transactions", async {
        let events = Mutex::new(Vec::new());
        let result: orm::Result<()> = db
            .transaction(async || {
                Service::new().set_name("tx-outer").create().await?;
                let inner: orm::Result<()> = db
                    .transaction(async || {
                        Service::new().set_name("tx-inner").create().await?;
                        Err(orm::Error::Config("boom".into()))
                    })
                    .await;
                events.lock().unwrap().push(json!(matches!(&inner, Err(orm::Error::Config(m)) if m == "boom")));
                let count = Service::new().name(vec!["tx-outer", "tx-inner"]).get_count().await?;
                events.lock().unwrap().push(json!(count));
                let locked = Service::new().name("tx-outer").for_update().gets().await?;
                events.lock().unwrap().push(json!(locked.len()));
                db.utils().lock("conformance").await?;
                db.utils().set_local("app.actor", "runner").await?;
                let actor = db.utils().local("app.actor")?;
                events.lock().unwrap().push(json!(actor));
                Err(orm::Error::Config("boom".into()))
            })
            .retry(0)
            .await;
        let mut events = events.into_inner().unwrap();
        events.push(json!(matches!(&result, Err(orm::Error::Config(m)) if m == "boom")));
        let left = Service::new().connect(db).name(vec!["tx-outer", "tx-inner"]).get_count().await?;
        events.push(json!(left));
        Ok::<Value, orm::Error>(Value::Array(events))
    });
    run!("aes_status", async {
        let keyring = AesKeyring::new([(1, "bench-salt".to_owned())].into_iter().collect(), 1)?;
        let status = db.utils().aes().status(&Battle::new(), &keyring).await?;
        let mut versions: Vec<String> = status.versions.iter().map(|(v, n)| format!("{v}:{n}")).collect();
        versions.sort();
        Ok::<Value, orm::Error>(json!({"current": status.current, "pending": status.pending, "versions": versions.join(",")}))
    });
    out
}
