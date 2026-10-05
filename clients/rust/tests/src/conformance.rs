//! Conformance runner (Rust). Runs every vector against the bench database and
//! prints {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}; the
//! other runners print the same document for the same chains.
//!
//! Usage: conformance --dsn URI [--vector NAME]...
//! Each --vector selects one vector by name; without one every vector runs.
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

orm::models!();

use model::{Author, CompositeAccount, Service, ServiceMember, ServiceRegion, SoftRecord, Task, User};
use orm::{AesKeyring, Collection, Db, Model, Null, Param};
use serde_json::{json, Map, Value};

#[derive(Default)]
struct Log {
    statements: Vec<Value>,
    seqs: HashSet<i64>,
    times: HashSet<String>,
    /// vector 안의 transaction 번호를 처음 나온 순서의 번호로 바꾼다.
    transactions: BTreeMap<u64, u64>,
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
            } else if s.starts_with("ORM-AES2\0") {
                assert!(s.len() >= 9 + 12 + 16, "invalid AES ciphertext bind");
                json!("$AES")
            } else if s.starts_with("ORM-AES2") {
                panic!("invalid AES ciphertext bind")
            } else if s.to_ascii_lowercase().starts_with("4f524d2d41455332") {
                assert!(
                    s.to_ascii_lowercase().starts_with("4f524d2d4145533200")
                        && s.len() >= 2 * (9 + 12 + 16)
                        && s.len() % 2 == 0
                        && s.bytes().all(|b| b.is_ascii_hexdigit()),
                    "invalid hex AES ciphertext bind"
                );
                json!("$AES")
            } else {
                v.clone()
            }
        }
        _ => v.clone(),
    }
}

fn param_json(p: &Param) -> Result<Value, String> {
    Ok(match p {
        Param::Null => Value::Null,
        Param::Bool(b) => json!(b),
        Param::I64(x) => json!(x),
        Param::F64(x) => {
            if !x.is_finite() {
                return Err("non-finite float bind".into());
            }
            json!(x)
        }
        Param::Str(s) => json!(s),
        Param::Bytes(b) => {
            if b.starts_with(b"ORM-AES2\0") {
                if b.len() < 9 + 12 + 16 {
                    return Err("invalid AES ciphertext bind".into());
                }
                json!("$AES")
            } else {
                json!(String::from_utf8(b.clone()).map_err(|e| e.to_string())?)
            }
        }
        Param::DateTime(t) => json!(time_text(t)),
        Param::Date(d) => json!(d.to_string()),
    })
}

#[test]
fn invalid_binds_cannot_be_rendered_as_valid_values() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    assert!(param_json(&Param::Bytes(vec![0xff])).is_err());
    assert!(param_json(&Param::Bytes(b"ORM-AES2\0".to_vec())).is_err());
    let mut encrypted = b"ORM-AES2\0".to_vec();
    encrypted.extend([0xff; 12 + 16]);
    assert_eq!(param_json(&Param::Bytes(encrypted)).unwrap(), json!("$AES"));
    assert!(param_json(&Param::F64(f64::INFINITY)).is_err());
    assert_eq!(param_json(&Param::Bytes(Vec::new())).unwrap(), json!(""));
    let log = Log::default();
    assert!(std::panic::catch_unwind(|| norm(&json!("ORM-AES2broken"), &log)).is_err());
    assert!(std::panic::catch_unwind(|| norm(&json!("4f524d2d4145533200bad"), &log)).is_err());
    assert!(std::panic::catch_unwind(|| norm(&json!(format!("4f524d2d41455332ff{}", "00".repeat(28))), &log)).is_err());
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

fn failure<T>(r: orm::Result<T>) -> Value {
    match r {
        Ok(_) => Value::Null,
        Err(e) => json!({"error": code(&e), "message": e.to_string()}),
    }
}

/// Keeps the named values of a row.
fn pick<M: Model>(m: Option<&M>, names: &[&str]) -> Value {
    let Some(m) = m else { return Value::Null };
    let all = orm::model::to_array(m).expect("array form");
    let mut out = Map::new();
    for n in names {
        out.insert((*n).to_owned(), all.get(*n).unwrap_or_else(|| panic!("missing selected field: {n}")).clone());
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
        Some(Value::Number(n)) => n.as_i64().unwrap_or_else(|| {
            let f = n.as_f64().expect("JSON number");
            assert!(f.is_finite() && f.fract() == 0.0 && f >= i64::MIN as f64 && f < 9_223_372_036_854_775_808.0, "non-integral or out-of-range number: {n}");
            f as i64
        }),
        Some(Value::String(s)) => s.parse().unwrap_or_else(|_| panic!("invalid integer text: {s}")),
        other => panic!("missing or invalid integer value: {other:?}"),
    }
}

#[test]
fn invalid_derived_integers_cannot_be_reported_as_zero() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for value in [None, Some(json!("bad")), Some(json!(1.5)), Some(json!(9_223_372_036_854_775_808.0))] {
        assert!(std::panic::catch_unwind(|| int(value)).is_err());
    }
    assert_eq!(int(Some(json!(0))), 0);
    assert_eq!(int(Some(json!(2.0))), 2);
}

struct Args {
    dsn: String,
    /// 실행할 vector 이름. 비어 있으면 모든 vector를 실행한다.
    vectors: Vec<String>,
}

const USAGE: &str = "usage: conformance --dsn URI [--vector NAME]...";

impl Args {
    fn parse(args: &[String]) -> Result<Args, String> {
        let mut dsn = None;
        let mut vectors: Vec<String> = Vec::new();
        let mut rest = args.iter();
        while let Some(flag) = rest.next() {
            let value = rest.next().ok_or_else(|| format!("{flag} requires a value; {USAGE}"))?;
            match flag.as_str() {
                "--dsn" if dsn.is_none() => dsn = Some(value.clone()),
                "--dsn" => return Err(format!("--dsn is given twice; {USAGE}")),
                "--vector" if value.is_empty() => return Err(format!("--vector requires a nonempty name; {USAGE}")),
                "--vector" if vectors.contains(value) => return Err(format!("vector {value} is selected twice")),
                "--vector" => vectors.push(value.clone()),
                other => return Err(format!("unknown argument {other:?}; {USAGE}")),
            }
        }
        let dsn = dsn.ok_or_else(|| format!("--dsn is required; {USAGE}"))?;
        Ok(Args { dsn, vectors })
    }
}

#[test]
fn arguments_reject_missing_duplicate_and_unknown_flags() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let parse = |args: &[&str]| Args::parse(&args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>());
    let args = parse(&["--dsn", "sqlite://x", "--vector", "relations", "--vector", "conditions_values"]).unwrap();
    assert_eq!((args.dsn.as_str(), args.vectors), ("sqlite://x", vec!["relations".to_owned(), "conditions_values".to_owned()]));
    assert!(parse(&["--dsn", "sqlite://x"]).unwrap().vectors.is_empty());
    for invalid in [
        &["--vector", "relations"][..],
        &["--dsn"],
        &["--dsn", "a", "--dsn", "b"],
        &["--dsn", "a", "--vector", ""],
        &["--dsn", "a", "--vector", "relations", "--vector", "relations"],
        &["--dsn", "a", "--vectors", "relations"],
    ] {
        assert!(parse(invalid).is_err(), "{invalid:?}");
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse(&std::env::args().skip(1).collect::<Vec<_>>()).unwrap_or_else(|e| {
        eprintln!("conformance: {e}");
        std::process::exit(2);
    });
    let shared: Shared = Arc::new(Mutex::new(Log::default()));
    let hook = shared.clone();
    let config = orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
    let db = model::connect(&args.dsn, 4, config).await.expect("connect");
    // 각 statement를 그 event로 기록한다(docs/usage.md "Statement events"). transaction은 vector
    // 안에서 처음 나온 순서로 1부터 다시 센 번호이고 밖이면 null이다. error는 statement의 오류
    // code이거나 null이다.
    let _recording = db.subscribe(move |e: &orm::StatementEvent<'_>| {
        let mut log = hook.lock().unwrap();
        let binds: Vec<Value> = e.binds.iter().map(|b| norm(&param_json(b).unwrap_or_else(|e| panic!("invalid query bind: {e}")), &log)).collect();
        let transaction = e.transaction.map(|n| {
            let next = log.transactions.len() as u64 + 1;
            *log.transactions.entry(n).or_insert(next)
        });
        log.statements.push(json!({
            "sql": e.sql,
            "binds": binds,
            "kind": e.kind,
            "tables": e.tables,
            "transaction": transaction,
            "error": e.error.map(|error| error.code().to_owned()),
        }));
        Ok(())
    });
    let out = match run_all(&db, &shared, &args.vectors).await {
        Ok(out) => out,
        Err(e) => {
            db.close().await;
            eprintln!("conformance: {e}");
            std::process::exit(2);
        }
    };
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    db.close().await;
}

type Vector<'a> = (&'static str, std::pin::Pin<Box<dyn std::future::Future<Output = orm::Result<Value>> + 'a>>);

/// 선언된 vector 중 `selected`가 고른 것을 선언 순서로 실행한다. `selected`가 비어 있으면
/// 모두 실행하고, 선언되지 않은 이름이 있으면 어떤 vector도 실행하지 않고 오류를 돌려준다.
async fn run_all(db: &Db, shared: &Shared, selected: &[String]) -> Result<BTreeMap<String, Value>, String> {
    let vectors = vectors(db, shared);
    let unknown: Vec<&str> = selected.iter().map(String::as_str).filter(|name| !vectors.iter().any(|(declared, _)| declared == name)).collect();
    if !unknown.is_empty() {
        return Err(format!("unknown vector {}", unknown.join(", ")));
    }
    let mut out = BTreeMap::new();
    for (name, body) in vectors {
        if !selected.is_empty() && !selected.iter().any(|s| s == name) {
            continue;
        }
        *shared.lock().unwrap() = Log::default();
        let result = match body.await {
            Ok(v) => v,
            Err(e) => panic!("conformance vector {name} failed: {e}"),
        };
        let statements = std::mem::take(&mut shared.lock().unwrap().statements);
        out.insert(name.to_owned(), json!({"statements": statements, "result": result}));
    }
    Ok(out)
}

/// 모든 vector를 선언 순서로 만든다. future는 await할 때 실행된다.
fn vectors<'a>(db: &'a Db, shared: &'a Shared) -> Vec<Vector<'a>> {
    let mut out: Vec<Vector<'a>> = Vec::new();
    macro_rules! run {
        ($name:expr, $body:expr) => {{
            out.push((
                $name,
                Box::pin(async move {
                    let res: orm::Result<Value> = $body.await;
                    res
                }),
            ));
        }};
    }
    let author = move || Author::new().connect(db);
    let cols = ["seq", "name", "is_close", "is_display", "read_count"];

    run!("conditions_connectors", async {
        let rows = author().service_seq(7).and_is_close(false).or(()).read_count(6).order_by_seq_asc().limit(0, 3).gets().await?;
        Ok::<Value, orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_group", async {
        let rows = author()
            .service_seq(7)
            .and(|q: Author| q.is_display(false).or(|q: Author| q.is_close(true).and_gt_read_count(500)))
            .order_by_seq_desc()
            .limit(0, 3)
            .gets()
            .await?;
        Ok::<Value, orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_leading_group", async {
        let rows = author().and(|q: Author| q.is_display(false).or_is_close(true)).and_service_seq(7).order_by_seq_desc().limit(0, 3).gets().await?;
        Ok::<Value, orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_leading_prefix", async {
        let rows = author().and_service_seq(7).and_gt_read_count(990).order_by_seq_desc().limit(0, 3).gets().await?;
        Ok::<Value, orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_values", async {
        let mut counts = Vec::new();
        for q in [
            author().service_seq(vec![7, 8]).and_ne_is_close(true),
            author().service_seq(7).and_uuid(Null),
            author().service_seq(7).and_ne_photo_url(Null),
            author().service_seq(7).and_ne_read_count(vec![6, 106, 206]),
            author().service_seq(7).and_between_read_count([100, 200]),
            author().service_seq(7).and_lk_name("attle-10"),
            author().service_seq(7).and_lb_name("Author-10"),
            author().service_seq(7).and_ge_read_count(990),
            author().service_seq(7).and_le_read_count(10),
            author().service_seq(7).and_lt_seq(1000),
        ] {
            counts.push(json!(q.get_count().await?));
        }
        Ok::<Value, orm::Error>(Value::Array(counts))
    });
    run!("terminal_by", async {
        let one = author().get_by_seq(42).await?;
        let missing = author().get_by_seq(-1).await;
        let rows = author().order_by_seq_asc().limit(0, 2).gets_by_service_seq_and_is_close(7, false).await?;
        let count = author().get_count_by_service_seq(7).await?;
        Ok::<Value, orm::Error>(json!({"one": pick(Some(&one), &cols), "missing": code_of(missing), "rows": picks(&rows, &cols), "count": count}))
    });
    run!("terminal_reuse", async {
        let q = author().service_seq(7).order_by_seq_asc().limit(0, 2);
        let first = q.get_count_by_is_close(true).await?;
        let rows = q.gets().await?;
        let last = q.get_count().await?;
        Ok::<Value, orm::Error>(json!([first, rows.len(), last]))
    });
    run!("expression_forms", async {
        let count = author().service_seq(7).and_not(|q: Author| q.is_close(true).or_gt_read_count(500)).get_count().await?;
        let rows = author().not(|q: Author| q.is_display(false)).and_service_seq(7).order_by_seq_desc().limit(0, 3).gets().await?;
        let or_count = author().service_seq(7).or_not(|q: Author| q.lt_read_count(990)).get_count().await?;
        Ok::<Value, orm::Error>(json!({"count": count, "rows": picks(&rows, &["seq", "is_display"]), "or_count": or_count}))
    });
    run!("columns", async {
        let none = Service::new().connect(db).remove_all_columns().get_by_seq(7).await?;
        let added = author().remove_all_columns().add_column_name().add_column_start_dt_alias_start_year(orm::year()).get_by_seq(42).await?;
        let removed = Service::new().connect(db).remove_column_name().get_by_seq(7).await?;
        Ok::<Value, orm::Error>(json!([none.to_array()?, pick(Some(&added), &["seq", "name", "start_year"]), removed.to_array()?]))
    });
    run!("joins", async {
        let service = Service::new().on(|s: Service| s.gt_seq(0)).name("service-7");
        let rows = author()
            .remove_all_columns()
            .add_column_name()
            .join_service_seq_with_seq(service.clone())
            .is_close(false)
            .and(|q: Author| q.is_display(true).or(&service))
            .order_by_seq_asc()
            .limit(0, 2)
            .gets()
            .await?;
        let member = ServiceMember::new();
        let compared = author().join_service_member_seq_with_seq(member.clone()).service_seq(7).and_success_count_lt_seq(&member).get_count().await?;
        let left =
            author().left_join_service_region_seq_with_seq(ServiceRegion::new().alias_module()).service_seq(7).order_by_seq_asc().limit(0, 1).gets().await?;
        Ok::<Value, orm::Error>(json!({
            "rows": rows.to_array()?,
            "compared": compared,
            "module": pick(left.first().map(|b| b.get_module()).transpose()?.flatten(), &["seq", "name"]),
        }))
    });
    run!("relations", async {
        let rows = author()
            .remove_all_columns()
            .add_column_name()
            .add_column_is_close()
            .relation(
                User::new()
                    .match_user_seq_with_seq()
                    .alias_writer()
                    .relations(Author::new().match_seq_with_user_seq().remove_all_columns().order_by_seq_desc().group_limit(2)),
            )
            .relation(
                Service::new()
                    .match_service_seq_with_seq()
                    .relations(ServiceMember::new().match_seq_with_service_seq().remove_all_columns().order_by_seq_asc().group_limit(2).key_name_user_seq()),
            )
            .relation(ServiceRegion::new().match_service_region_seq_with_seq().possible_is_close(true).parent_node())
            .service_seq(7)
            .order_by_seq_asc()
            .limit(0, 3)
            .gets()
            .await?;
        rows.to_array()
    });
    run!("relation_empty", async {
        let rows = author().relations(ServiceMember::new().match_user_seq_with_user_seq()).gets_by_seq(-1).await?;
        Ok::<Value, orm::Error>(json!(rows.len()))
    });
    run!("subqueries", async {
        let users = User::new()
            .connect(db)
            .add_column_read_total(|u: &User| Author::new().sum_read_count().user_seq_eq_seq(u).and_service_seq(7))
            .seq(Author::new().add_column_user_seq().service_seq(7).and_ge_read_count(906))
            .order_by_seq_asc()
            .gets()
            .await?;
        let out: Vec<Value> = users.models().map(|u| json!([u.get_seq().unwrap(), int(u.get_read_total().expect("read_total"))])).collect();
        Ok::<Value, orm::Error>(Value::Array(out))
    });
    run!("aggregates", async {
        let sum = author().service_seq(7).sum_read_count().get_sum().await?;
        let avg = author().service_seq(7).avg_like_count().get_avg().await?;
        assert_eq!(avg.to_bits(), 0x404805c28f5c28f6, "aggregate average has an unexpected binary64 value");
        let groups = author().service_seq(7).group_by_is_close().order_by_is_close_asc().gets_count().await?;
        let page = author().service_seq(7).remove_all_columns().order_by_seq_asc().gets_page(3, 4).await?;
        Ok::<Value, orm::Error>(json!({
            "sum": sum,
            "avg": format!("{avg:.4}"),
            "groups": groups.to_array()?,
            "page": {"keys": keys_of(&page.items), "total": page.total_count, "pages": page.total_pages, "page": page.page, "per_page": page.per_page},
        }))
    });
    run!("functions", async {
        let mut counts = Vec::new();
        for q in [
            author().service_seq(7).and_eq_start_dt(orm::day_of_week(), 2),
            author().service_seq(7).and_start_dt(orm::year(), 2026),
            author().service_seq(7).and_gt_start_dt(orm::days_ago(36500)),
            author().service_seq(7).and_lt_start_dt(orm::months_later(1200)),
        ] {
            counts.push(json!(q.get_count().await?));
        }
        let rows = author()
            .remove_all_columns()
            .add_column_start_dt_alias_start_month(orm::month())
            .order_by_start_dt_asc(orm::year())
            .order_by_seq_asc()
            .gets_by_seq(vec![42, 43])
            .await?;
        let months: Vec<Value> = rows.models().map(|r| json!(int(r.get_start_month().expect("start_month")))).collect();
        Ok::<Value, orm::Error>(json!({"counts": counts, "months": months}))
    });
    run!("errors", async {
        let errs = vec![
            code_of(author().name("a").is_close(true).gets().await),
            code_of(author().name("a").and(()).gets().await),
            code_of(author().seq(Vec::<i64>::new()).gets().await),
            code_of(Author::new().name("a").gets().await),
            code_of(author().for_update().gets().await),
            code_of(author().join_user_seq_with_seq(User::new().connect(db)).gets().await),
            code_of(author().limit(0, 1).gets_page(1, 10).await),
            code_of(author().relation(User::new().match_user_seq_with_seq().limit(0, 1)).gets_by_seq(42).await),
            code_of(author().name("a").or(&User::new()).gets().await),
        ];
        Ok::<Value, orm::Error>(Value::Array(errs))
    });
    run!("get_query", async {
        let st = author().service_seq(7).and_lk_name("x").and_aes_hex_email("user7@example.com").order_by_seq_desc().limit(0, 5).get_query().await?;
        let log = Log::default();
        let binds: Vec<Value> = st.binds.iter().map(|b| norm(&param_json(b).unwrap_or_else(|e| panic!("invalid query bind: {e}")), &log)).collect();
        Ok::<Value, orm::Error>(json!({"sql": st.sql, "binds": binds}))
    });
    run!("aes_values", async {
        let row = author().remove_all_columns().add_column_aes_hex_email().add_column_aes_hex_phone().get_by_seq(42).await?;
        let found = author().aes_hex_email("user42@example.com").get_count().await?;
        Ok::<Value, orm::Error>(json!({"row": row.to_array()?, "found": found}))
    });

    run!(
        "write_cycle",
        db.transaction(async || {
            let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
            let created = author()
                .set_name("cycle")
                .set_user_seq(1)
                .set_service_seq(999)
                .set_service_region_seq(1)
                .set_service_member_seq(1)
                .set_start_dt(start)
                .set_end_dt(start)
                .set_price("12.500")?
                .set_ip("10.0.0.1")
                .set_aes_hex_email("cycle@example.com");
            let created = created.set_json_setting(orm::StyledValue::Value(orm::ordered_json::parse(r#"{"a":1}"#).expect("json literal")))?;
            let created = created.set_serialize_data(orm::StyledValue::Value(json!({"k": "v"})))?;
            let created = created.new_label("created").create().await.map_err(|error| {
                eprintln!("write_cycle create: {error}");
                error
            })?;
            let seq = created.get_seq().unwrap();
            mask(shared, &[seq], &[]);
            let mut created_array = created.to_array().map_err(|error| {
                eprintln!("write_cycle created row conversion: {error}");
                error
            })?;
            created_array["seq"] = json!("$SEQ");
            let loaded = author().add_all_columns().get_by_seq(seq).await.map_err(|error| {
                eprintln!("write_cycle selected row: {error}");
                error
            })?;
            mask(shared, &[], &[loaded.get_updated_ts().unwrap()]);
            let mut loaded = loaded.set_name("cycle-2").plus_read_count(3);
            loaded.update(true).await?;
            let mut loaded = loaded.set_name("stale");
            let stale = loaded.update(true).await;
            let again = author().add_all_columns().get_by_seq(seq).await?;
            let updated = pick(Some(&again), &["name", "read_count", "price", "ip", "aes_hex_email", "json_setting", "serialize_data", "start_dt"]);
            again.delete(false).await?;
            let gone = author().get_by_seq(seq).await;
            Ok::<Value, orm::Error>(json!({"created": created_array, "updated": updated, "stale": code_of(stale), "deleted": code_of(gone)}))
        })
        .retry(0)
    );
    run!(
        "now_defaults",
        db.transaction(async || {
            let start = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
            let before = chrono::Utc::now().naive_utc();
            let created = author()
                .set_name("clock")
                .set_user_seq(1)
                .set_service_seq(999)
                .set_service_region_seq(1)
                .set_service_member_seq(1)
                .set_start_dt(start)
                .set_end_dt(start)
                .create()
                .await?;
            let seq = created.get_seq().unwrap();
            mask(shared, &[seq], &[]);
            let loaded = author().get_by_seq(seq).await?;
            let (created_ts, updated_ts) = (loaded.get_created_ts().unwrap(), loaded.get_updated_ts().unwrap());
            // The runner connects in +00:00, so the wall-clock value is UTC.
            let near = (created_ts - before).num_seconds().abs() < 60;
            loaded.delete(false).await?;
            Ok::<Value, orm::Error>(json!({"created_near_clock": near, "created_equals_updated": created_ts == updated_ts}))
        })
        .retry(0)
    );
    run!(
        "required_columns",
        db.transaction(async || {
            let missing_state = failure(Task::new().connect(db).set_title("draft").create().await);
            let missing_title = failure(Task::new().connect(db).set_state("open").create().await);
            let created = Task::new().connect(db).set_title("draft").set_state("open").create().await?;
            mask(shared, &[created.get_seq().unwrap()], &[]);
            created.delete(false).await?;
            Ok::<Value, orm::Error>(json!({"missing_state": missing_state, "missing_title": missing_title}))
        })
        .retry(0)
    );
    run!(
        "creates_and_save",
        db.transaction(async || {
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
            Ok::<Value, orm::Error>(json!({"inserted": inserted, "pairs": pairs.to_array()?, "left": left}))
        })
        .retry(0)
    );
    run!(
        "delete_recursive",
        db.transaction(async || {
            let service = Service::new().connect(db).set_name("recursive").create().await?;
            let seq = service.get_seq().unwrap();
            let mut seqs = vec![seq];
            for i in 0..2 {
                let member = ServiceMember::new().connect(db).set_service_seq(seq).set_user_seq(i + 1).create().await?;
                seqs.push(member.get_seq().unwrap());
            }
            let loaded = Service::new().connect(db).relations(ServiceMember::new().match_seq_with_service_seq()).get_by_seq(seq).await?;
            let members = loaded.get_service_member_models()?.expect("selected service members").len();
            mask(shared, &seqs, &[]);
            loaded.delete(true).await?;
            let left = ServiceMember::new().connect(db).get_count_by_service_seq(seq).await?;
            let service2 = Service::new().connect(db).get_by_seq(seq).await;
            Ok::<Value, orm::Error>(json!({"members": members, "members_left": left, "service_left": code_of(service2)}))
        })
        .retry(0)
    );

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
                db.utils().set_local("ormtest.actor", "runner").await?;
                let actor = db.utils().local("ormtest.actor")?;
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
    run!("restore", async {
        // soft delete한 행을 primary key로 되돌린다. 지운 시각은 고정한 값으로 써서 모든 database와
        // runner의 bind가 같다. transaction은 끝에 rollback하므로 database는 처음과 같다.
        let result = Mutex::new(Map::new());
        let ended: orm::Result<()> = db
            .transaction(async || {
                let mut created = SoftRecord::new().set_name("restore").create().await?;
                let seq = created.get_seq().unwrap();
                mask(shared, &[seq], &[]);
                let deleted_at = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap();
                created = created.set_deleted_at(deleted_at);
                created.update(false).await?;
                let hidden = SoftRecord::new().get_by_seq(seq).await;
                result.lock().unwrap().insert("hidden".into(), code_of(hidden));
                // key 밖의 값은 지워진 행을 되돌릴 때만 쓴다. 두 번째 restore는 지워지지 않은 행을 바꾸지 않고
                // 돌려준다.
                for (name, value) in [("restored", "restore-2"), ("again", "ignored")] {
                    let row = SoftRecord::new().set_seq(seq).set_name(value).restore().await?;
                    let mut array = row.to_array()?;
                    array["seq"] = json!("$SEQ");
                    result.lock().unwrap().insert(name.into(), array);
                }
                let missing = SoftRecord::new().set_seq(0).restore().await;
                result.lock().unwrap().insert("missing".into(), code_of(missing));
                Err(orm::Error::Config("boom".into()))
            })
            .retry(0)
            .await;
        if !matches!(&ended, Err(orm::Error::Config(m)) if m == "boom") {
            ended?;
        }
        let left = SoftRecord::new().connect(db).name("restore").get_count().await?;
        let mut result = result.into_inner().unwrap();
        result.insert("left".into(), json!(left));
        Ok::<Value, orm::Error>(Value::Object(result))
    });
    run!("aes_status", async {
        let keyring = AesKeyring::new([(1, "bench-salt".to_owned())].into_iter().collect(), 1)?;
        let status = db.utils().aes().status(&Author::new(), &keyring).await?;
        let mut versions: Vec<String> = status.versions.iter().map(|(v, n)| format!("{v}:{n}")).collect();
        versions.sort();
        Ok::<Value, orm::Error>(json!({"current": status.current, "pending": status.pending, "versions": versions.join(",")}))
    });
    out
}
