//! Conformance runner (Rust). Runs the bodies that no recipe step reaches, the generated-method and the fixed-clock
//! bodies (tests/conformance/README.md), against a database and prints
//! {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}; the other runners print the same document for the same chains.
//!
//! Usage: conformance --dsn URI [--vector NAME]...
//! Each --vector selects one vector by name; without one every vector runs.
use polyspec_orm_testcase::OrPanic;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

polyspec_orm::models!();

use model::{Author, ClockCell, HexCell, Service, ServiceMember, UpsertCell};
use polyspec_orm::{Collection, Db, Model, Null, Param};
use serde_json::{json, Map, Value};

use polyspec_orm_test_support::statement_record;

#[derive(Default)]
struct Log {
    statements: Vec<Value>,
    seqs: HashSet<i64>,
    /// Renumbers the transaction numbers in the vector by order of first appearance, starting at 1.
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
            if s.starts_with("ORM-AES2\0") {
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
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
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

/// Hides the identity of rows a vector created: their keys wherever they are bound,
/// including statements logged earlier.
fn mask(shared: &Shared, seqs: &[i64]) {
    let mut log = shared.lock().unwrap();
    log.seqs.extend(seqs.iter().copied());
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

fn code(e: &polyspec_orm::Error) -> Value {
    json!(e.code())
}

fn code_of<T>(r: polyspec_orm::Result<T>) -> Value {
    match r {
        Ok(_) => Value::Null,
        Err(e) => code(&e),
    }
}

/// Keeps the named values of a row.
fn pick<M: Model>(m: Option<&M>, names: &[&str]) -> Value {
    let Some(m) = m else { return Value::Null };
    let all = polyspec_orm::model::to_array(m).expect("array form");
    let mut out = Map::new();
    for n in names {
        out.insert((*n).to_owned(), all.get(*n).unwrap_or_else(|| panic!("missing selected field: {n}")).clone());
    }
    Value::Object(out)
}

fn picks<M: Model>(c: &Collection<M>, names: &[&str]) -> Value {
    Value::Array(c.models().map(|m| pick(Some(m), names)).collect())
}

struct Args {
    dsn: String,
    /// The vector name to run. If empty, all vectors run.
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
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
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

/// Each body of this runner is declared once and is named in tests/conformance/vectors.json. A vector name with no body here
/// is a recipe case (tests/conformance/README.md). The declared names are read from this file: the first string literal after
/// each run invocation. The call token is built with concat! so that this test does not count itself.
#[test]
fn every_body_is_a_vector_of_the_vector_file() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let call = concat!("run", "!(");
    let declared: Vec<&str> = include_str!("conformance.rs")
        .split(call)
        .skip(1)
        .map(|rest| {
            let literal = rest.trim_start().strip_prefix('"').unwrap_or_else(|| panic!("a vector invocation has no name literal"));
            &literal[..literal.find('"').unwrap_or_else(|| panic!("a vector name literal is not closed"))]
        })
        .collect();
    let mut seen = HashSet::new();
    for name in &declared {
        assert!(seen.insert(*name), "vector {name} is declared twice");
    }
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/conformance/vectors.json");
    let text = std::fs::read_to_string(&path).or_panic(|e| format!("{}: {e}", path.display()));
    let recorded: Value = serde_json::from_str(&text).or_panic(|e| format!("{}: {e}", path.display()));
    let vectors = recorded["vectors"].as_array().unwrap_or_else(|| panic!("{}: no vectors array", path.display()));
    let names: HashSet<&str> = vectors.iter().map(|vector| vector["name"].as_str().unwrap_or_else(|| panic!("a vector has no name"))).collect();
    for name in &declared {
        assert!(names.contains(name), "the body {name} is not a vector of {}", path.display());
    }
}

#[tokio::main]
async fn main() {
    let args = match Args::parse(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("conformance: {e}");
            std::process::exit(2);
        }
    };
    let shared: Shared = Arc::new(Mutex::new(Log::default()));
    let hook = shared.clone();
    let config = polyspec_orm::Config {
        aes_key: "bench-salt".into(),
        blind_index_key: "bench-blind-index".into(),
        audit_source: Some(Arc::new(|| Ok(Vec::new()))),
        ..Default::default()
    };
    let db = model::connect(&args.dsn, 4, config).await.expect("connect");
    db.transaction(async || Ok(())).retry(0).await.expect("prepare conformance connection");
    // Records each statement as that event (docs/operations/usage.md "Statement events"). A transaction's
    // number is counted from 1 in order of first appearance within the vector, and is null outside a transaction. error is the statement's error
    // code, or null.
    let _recording = db
        .subscribe(move |e: &polyspec_orm::StatementEvent<'_>| {
            let mut log = hook.lock().unwrap();
            let binds: Vec<Value> = e.binds.iter().map(|b| norm(&param_json(b).or_panic(|e| format!("invalid query bind: {e}")), &log)).collect();
            let transaction = e.transaction.map(|n| {
                let next = log.transactions.len() as u64 + 1;
                *log.transactions.entry(n).or_insert(next)
            });
            log.statements.push(statement_record::statement_record(e, binds, transaction));
            Ok(())
        })
        .expect("a SQL connection accepts a subscriber");
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

type Vector<'a> = (&'static str, std::pin::Pin<Box<dyn std::future::Future<Output = polyspec_orm::Result<Value>> + 'a>>);

/// Runs, in declaration order, the declared vectors that `selected` picks. If `selected` is empty,
/// it runs all of them; if a name is not declared, it runs no vector and returns an error.
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

/// Builds all vectors in declaration order. A future runs when it is awaited.
fn vectors<'a>(db: &'a Db, shared: &'a Shared) -> Vec<Vector<'a>> {
    let mut out: Vec<Vector<'a>> = Vec::new();
    macro_rules! run {
        ($name:expr, $body:expr) => {{
            out.push((
                $name,
                Box::pin(async move {
                    let res: polyspec_orm::Result<Value> = $body.await;
                    res
                }),
            ));
        }};
    }
    let author = move || Author::new().connect(db);
    let cols = ["seq", "name", "is_close", "is_display", "read_count"];

    run!("terminal_by", async {
        let one = author().get_by_seq(42).await?.ok_or(polyspec_orm::Error::NoRows)?;
        let missing = author().get_by_seq(-1).await;
        let rows = author().order_by_seq_asc().limit(0, 2).gets_by_service_seq_and_is_close(7, false).await?;
        let count = author().get_count_by_service_seq(7).await?;
        Ok::<Value, polyspec_orm::Error>(json!({"one": pick(Some(&one), &cols), "missing": code_of(missing), "rows": picks(&rows, &cols), "count": count}))
    });
    run!("terminal_reuse", async {
        let q = author().service_seq(7).order_by_seq_asc().limit(0, 2);
        let first = q.get_count_by_is_close(true).await?;
        let rows = q.gets().await?;
        let last = q.get_count().await?;
        Ok::<Value, polyspec_orm::Error>(json!([first, rows.len(), last]))
    });
    run!("relation_empty", async {
        let rows = author().relations(ServiceMember::new().match_user_seq_with_user_seq()).gets_by_seq(-1).await?;
        Ok::<Value, polyspec_orm::Error>(json!(rows.len()))
    });
    run!("empty_reads", async {
        let get = author().seq(-1).get().await?;
        let get_by = author().get_by_seq(-1).await?;
        let gets = author().seq(-1).gets().await?;
        let groups = author().seq(-1).group_by_is_close().gets_count().await?;
        let page = author().seq(-1).remove_all_columns().order_by_seq_asc().gets_page(1, 10).await?;
        Ok::<Value, polyspec_orm::Error>(json!({
            "get": get.map(|m| m.to_array()).transpose()?,
            "get_by": get_by.map(|m| m.to_array()).transpose()?,
            "gets": gets.len(),
            "gets_count": groups.to_array()?,
            "page": {"items": page.items.len(), "total_count": page.total_count, "total_pages": page.total_pages, "page": page.page, "per_page": page.per_page},
            "count": author().seq(-1).get_count().await?,
            "sum": author().seq(-1).sum_read_count().get_sum().await?,
            "avg": author().seq(-1).avg_like_count().get_avg().await?,
            "null_rows": author().price(Null).get_count().await?,
            "null_sum": author().price(Null).sum_price().get_sum().await?,
            "null_avg": author().price(Null).avg_price().get_avg().await?,
        }))
    });
    run!("aes_values", async {
        let row =
            author().remove_all_columns().add_column_aes_hex_email().add_column_aes_hex_phone().get_by_seq(42).await?.ok_or(polyspec_orm::Error::NoRows)?;
        let found = author().aes_hex_email("user42@example.com").get_count().await?;
        Ok::<Value, polyspec_orm::Error>(json!({"row": row.to_array()?, "found": found}))
    });

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
                .set_start_dt(txt(start))?
                .set_end_dt(txt(start))?
                .create()
                .await?;
            let seq = created.get_seq().unwrap();
            mask(shared, &[seq]);
            let loaded = author().get_by_seq(seq).await?.ok_or(polyspec_orm::Error::NoRows)?;
            let (created_ts, updated_ts) = (loaded.get_created_ts().unwrap(), loaded.get_updated_ts().unwrap());
            // The runner connects in +00:00, so the wall-clock value is UTC.
            let near = (created_ts - before).num_seconds().abs() < 60;
            loaded.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(json!({"created_near_clock": near, "created_equals_updated": created_ts == updated_ts}))
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
            let loaded = Service::new()
                .connect(db)
                .relations(ServiceMember::new().match_seq_with_service_seq())
                .get_by_seq(seq)
                .await?
                .ok_or(polyspec_orm::Error::NoRows)?;
            let members = loaded.get_service_member_models()?.expect("selected service members").len();
            mask(shared, &seqs);
            loaded.delete(true).await?;
            let left = ServiceMember::new().connect(db).get_count_by_service_seq(seq).await?;
            let service2 = Service::new().connect(db).get_by_seq(seq).await;
            Ok::<Value, polyspec_orm::Error>(json!({"members": members, "members_left": left, "service_left": code_of(service2)}))
        })
        .retry(0)
    );

    // the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
    run!("hex_malformed", async {
        let white_space = code_of(HexCell::new().connect(db).get_by_seq(1).await);
        let odd_length = code_of(HexCell::new().connect(db).get_by_seq(2).await);
        Ok::<Value, polyspec_orm::Error>(json!({"white_space": white_space, "odd_length": odd_length}))
    });
    // A write counts each written row once (docs/spec/protocol.md "Write"): an upsert is 1 whether it inserts or updates,
    // and an update counts the row it matched even when the row already holds the value. The count is read through the
    // test entry point (docs/spec/protocol.md "Test write result").
    run!(
        "affected_counts",
        db.transaction(async || {
            let created = UpsertCell::new().connect(db).set_code("c1").set_label("x").duplication(UpsertCell::new().set_label("y")).create().await?;
            let seq = created.get_seq().unwrap();
            mask(shared, &[seq]);
            let upsert_inserted = polyspec_orm::testing::last_affected(db);
            UpsertCell::new().connect(db).set_code("c1").set_label("x").duplication(UpsertCell::new().set_label("y")).create().await?;
            let upsert_updated = polyspec_orm::testing::last_affected(db);
            let mut row = UpsertCell::new().connect(db).get_by_seq(seq).await?.ok_or(polyspec_orm::Error::NoRows)?.set_label("y");
            row.update(false).await?;
            let update_unchanged = polyspec_orm::testing::last_affected(db);
            let mut row = row.set_label("z");
            row.update(false).await?;
            let update_changed = polyspec_orm::testing::last_affected(db);
            row.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(json!({
                "upsert_inserted": upsert_inserted,
                "upsert_updated": upsert_updated,
                "update_unchanged": update_unchanged,
                "update_changed": update_changed
            }))
        })
        .retry(0)
    );
    // One statement has one clock (docs/spec/protocol.md "Clock"): the columns that an insert leaves to `default now` hold
    // that clock truncated to their digits, and a datetime(p) column compares with a clock at six digits. The executor
    // clock is fixed at .999999 through the test entry point, so a rounding clock shows as the next second; MySQL writes
    // its own clock, CURRENT_TIMESTAMP(p), which truncates. These vectors come last because the fixed clock stays on
    // the connection.
    run!(
        "clock_truncate_write",
        db.transaction(async || {
            use chrono::SubsecRound;
            polyspec_orm::testing::fix_clock(db, "2026-06-01 12:34:56.999999");
            let created = ClockCell::new().connect(db).set_label("write").create().await?;
            let seq = created.get_seq().unwrap();
            mask(shared, &[seq]);
            let row = ClockCell::new().connect(db).get_by_seq(seq).await?.ok_or(polyspec_orm::Error::NoRows)?;
            row.delete(false).await?;
            let at6 = row.get_at6()?;
            Ok::<Value, polyspec_orm::Error>(json!({
                "at6_fixed": at6.format("%Y-%m-%d %H:%M:%S%.6f").to_string() == "2026-06-01 12:34:56.999999",
                "p0_truncated": row.get_at0()? == at6.trunc_subsecs(0),
                "p3_truncated": row.get_at3()? == at6.trunc_subsecs(3),
            }))
        })
        .retry(0)
    );
    run!(
        "clock_compare_six_digits",
        db.transaction(async || {
            polyspec_orm::testing::fix_clock(db, "2026-06-01 12:34:56.999999");
            let day = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap();
            let created = ClockCell::new()
                .connect(db)
                .set_label("compare")
                .set_at0(txt(day.and_hms_opt(12, 34, 56).unwrap()))?
                .set_at3(txt(day.and_hms_milli_opt(12, 34, 56, 999).unwrap()))?
                .set_at6(txt(day.and_hms_opt(12, 34, 56).unwrap()))?
                .create()
                .await?;
            mask(shared, &[created.get_seq().unwrap()]);
            let ge_now = ClockCell::new().connect(db).label("compare").and_ge_at0(polyspec_orm::now()).get_count().await?;
            let lt_now = ClockCell::new().connect(db).label("compare").and_lt_at3(polyspec_orm::now()).get_count().await?;
            created.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(json!({"at0_ge_now": ge_now, "at3_lt_now": lt_now}))
        })
        .retry(0)
    );
    out
}

/// The text form of a datetime column, which the date setters take (T189).
fn txt(t: chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S%.f").to_string()
}
