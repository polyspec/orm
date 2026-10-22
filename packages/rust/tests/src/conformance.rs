//! Conformance runner (Rust). Runs every vector against the bench database and
//! prints {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}; the
//! other runners print the same document for the same chains.
//!
//! Usage: conformance --dsn URI [--vector NAME]...
//! Each --vector selects one vector by name; without one every vector runs.
use polyspec_orm_testcase::OrPanic;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

polyspec_orm::models!();

use model::{
    AuditRecord, AuditedNote, Author, BindCell, ClockCell, CompositeAccount, DayCell, HexCell, NoteReader, Service, ServiceMember, ServiceRegion, SharedNote,
    SoftLink, SoftRecord, Task, TimeCell, UpsertCell, User, UuidCell,
};
use polyspec_orm::{AesKeyring, Collection, Db, Model, Null, Param};
use serde_json::{json, Map, Value};

#[derive(Default)]
struct Log {
    statements: Vec<Value>,
    seqs: HashSet<i64>,
    times: HashSet<String>,
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

fn code(e: &polyspec_orm::Error) -> Value {
    json!(e.code())
}

fn code_of<T>(r: polyspec_orm::Result<T>) -> Value {
    match r {
        Ok(_) => Value::Null,
        Err(e) => code(&e),
    }
}

fn failure<T>(r: polyspec_orm::Result<T>) -> Value {
    match r {
        Ok(_) => Value::Null,
        Err(e) => json!({"error": code(&e), "message": e.to_string()}),
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

/// Creates Apple, apple, Évian, évian, and x_y rows in tenant 902, collects the account_id each pattern selects by cond, then deletes them.
async fn contains_vector(db: &Db, cond: impl Fn(CompositeAccount, &str) -> CompositeAccount, patterns: &[&str]) -> polyspec_orm::Result<Value> {
    let rows = ["Apple", "apple", "Évian", "évian", "x_y"]
        .iter()
        .enumerate()
        .map(|(i, name)| CompositeAccount::new().set_tenant_id(902).set_account_id(i as i64 + 1).set_name(*name))
        .collect::<Vec<_>>();
    CompositeAccount::new().connect(db).creates(rows, 5).await?;
    let mut matches = Vec::new();
    for p in patterns {
        let found = cond(CompositeAccount::new().connect(db).tenant_id(902), p).order_by_account_id_asc().gets().await?;
        matches.push(picks(&found, &["account_id"]));
    }
    CompositeAccount::new().connect(db).tenant_id(902).order_by_account_id_asc().gets().await?.delete(false).await?;
    Ok(Value::Array(matches))
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
        Some(Value::String(s)) => s.parse().or_panic(|error| format!("invalid integer text {s}: {error}")),
        other => panic!("missing or invalid integer value: {other:?}"),
    }
}

#[test]
fn invalid_derived_integers_cannot_be_reported_as_zero() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for value in [None, Some(json!("bad")), Some(json!(1.5)), Some(json!(9_223_372_036_854_775_808.0))] {
        assert!(std::panic::catch_unwind(|| int(value)).is_err());
    }
    assert_eq!(int(Some(json!(0))), 0);
    assert_eq!(int(Some(json!(2.0))), 2);
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

/// Every vector of the vector files is declared in `vectors`, so a run without `--vector` reports each of them by name.
/// The declared names are read from this file: the first string literal after each run invocation. The call token is
/// built with concat! so that this test does not count itself.
#[test]
fn every_vector_of_the_vector_files_is_declared() {
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
    let dir = polyspec_orm_testcase::manifest_dir().join("../../../tests/conformance");
    for file in ["vectors.json", "vectors.postgres.json", "vectors.sqlite.json"] {
        let path = dir.join(file);
        let text = std::fs::read_to_string(&path).or_panic(|e| format!("{}: {e}", path.display()));
        let recorded: Value = serde_json::from_str(&text).or_panic(|e| format!("{}: {e}", path.display()));
        let vectors = recorded["vectors"].as_array().unwrap_or_else(|| panic!("{}: no vectors array", path.display()));
        assert!(declared.len() >= vectors.len(), "{file}: the binding declares {} vectors for {} recorded", declared.len(), vectors.len());
        for vector in vectors {
            let name = vector["name"].as_str().unwrap_or_else(|| panic!("{file}: a vector has no name"));
            assert!(seen.contains(name), "{file}: vector {name} is not declared by the conformance binding");
        }
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
            log.statements.push(json!({
                "sql": e.sql,
                "binds": binds,
                "kind": e.kind,
                "tables": e.tables,
                "transaction": transaction,
                "error": e.error.map(|error| error.code().to_owned()),
            }));
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

    // DSL-87 and DSL-111: a user with its authors loaded as has-many rows. Unlocked, delete(true) deletes the authors and the user;
    // locked, the authors stay, so the user's delete fails on the foreign key, and the normalized code is recorded.
    run!("delete_lock", async {
        let mut out: Vec<Value> = Vec::new();
        for locked in [false, true] {
            let user = User::new().connect(db).set_name("delete-lock").create().await?;
            let u_seq = user.get_seq()?;
            let author = Author::new()
                .connect(db)
                .set_name("delete-lock")
                .set_user_seq(u_seq)
                .set_service_seq(7)
                .set_service_region_seq(7)
                .set_service_member_seq(7)
                .set_start_dt("2026-01-01 00:00:00")?
                .set_end_dt("2026-12-31 00:00:00")?
                .create()
                .await?;
            let a_seq = author.get_seq()?;
            let rel = if locked {
                Author::new().match_seq_with_user_seq().delete_lock()
            } else {
                Author::new().match_seq_with_user_seq()
            };
            let loaded = User::new().connect(db).seq(u_seq).relations(rel).gets().await?;
            let error = match loaded.delete(true).await {
                Ok(()) => "none".to_owned(),
                Err(e) => {
                    if e.code().is_empty() {
                        return Err(e);
                    }
                    e.code().to_owned()
                }
            };
            let authors = Author::new().connect(db).seq(a_seq).gets().await?.len();
            let users = User::new().connect(db).seq(u_seq).gets().await?.len();
            out.push(json!([authors, users, error]));
            if locked {
                Author::new().connect(db).seq(a_seq).gets().await?.delete(false).await?;
                User::new().connect(db).seq(u_seq).gets().await?.delete(false).await?;
            }
        }
        Ok::<Value, polyspec_orm::Error>(Value::Array(out))
    });
    run!("conditions_connectors", async {
        let rows = author().service_seq(7).and_is_close(false).or(()).read_count(6).order_by_seq_asc().limit(0, 3).gets().await?;
        Ok::<Value, polyspec_orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_group", async {
        let rows = author()
            .service_seq(7)
            .and(|q: Author| q.is_display(false).or(|q: Author| q.is_close(true).and_gt_read_count(500)))
            .order_by_seq_desc()
            .limit(0, 3)
            .gets()
            .await?;
        Ok::<Value, polyspec_orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_leading_group", async {
        let rows = author().and(|q: Author| q.is_display(false).or_is_close(true)).and_service_seq(7).order_by_seq_desc().limit(0, 3).gets().await?;
        Ok::<Value, polyspec_orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_leading_prefix", async {
        let rows = author().and_service_seq(7).and_gt_read_count(990).order_by_seq_desc().limit(0, 3).gets().await?;
        Ok::<Value, polyspec_orm::Error>(picks(&rows, &cols))
    });
    run!("conditions_values", async {
        let mut counts = Vec::new();
        for q in [
            author().service_seq(vec![7, 8]).and_ne_is_close(true),
            author().service_seq(7).and_uuid(Null),
            author().service_seq(7).and_ne_photo_url(Null),
            author().service_seq(7).and_ne_read_count(vec![6, 106, 206]),
            author().service_seq(7).and_between_read_count([100, 200]),
            author().service_seq(7).and_lk_name("uthor-10"),
            author().service_seq(7).and_lb_name("Author-10"),
            author().service_seq(7).and_ge_read_count(990),
            author().service_seq(7).and_le_read_count(10),
            author().service_seq(7).and_lt_seq(1000),
        ] {
            counts.push(json!(q.get_count().await?));
        }
        Ok::<Value, polyspec_orm::Error>(Value::Array(counts))
    });
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
    run!("expression_forms", async {
        let count = author().service_seq(7).and_not(|q: Author| q.is_close(true).or_gt_read_count(500)).get_count().await?;
        let rows = author().not(|q: Author| q.is_display(false)).and_service_seq(7).order_by_seq_desc().limit(0, 3).gets().await?;
        let or_count = author().service_seq(7).or_not(|q: Author| q.lt_read_count(990)).get_count().await?;
        Ok::<Value, polyspec_orm::Error>(json!({"count": count, "rows": picks(&rows, &["seq", "is_display"]), "or_count": or_count}))
    });
    run!("columns", async {
        let none = Service::new().connect(db).remove_all_columns().get_by_seq(7).await?.ok_or(polyspec_orm::Error::NoRows)?;
        let added = author()
            .remove_all_columns()
            .add_column_name()
            .add_column_start_dt_alias_start_year(polyspec_orm::year())
            .get_by_seq(42)
            .await?
            .ok_or(polyspec_orm::Error::NoRows)?;
        let removed = Service::new().connect(db).remove_column_name().get_by_seq(7).await?.ok_or(polyspec_orm::Error::NoRows)?;
        Ok::<Value, polyspec_orm::Error>(json!([none.to_array()?, pick(Some(&added), &["seq", "name", "start_year"]), removed.to_array()?]))
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
        Ok::<Value, polyspec_orm::Error>(json!({
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
        Ok::<Value, polyspec_orm::Error>(json!(rows.len()))
    });
    run!("relation_null_key", async {
        let rows = User::new().connect(db).relations(Author::new().match_seq_with_user_seq().key_name_price()).seq(100).gets().await;
        match rows {
            Ok(rows) => Ok::<Value, polyspec_orm::Error>(json!(rows.len())),
            Err(e) => Ok(json!({"error": code(&e), "message": e.to_string()})),
        }
    });
    // shared_note is a table of the external document bench_shared: it is read through its entity, and a write fails
    // with CONFIG before any statement (docs/spec/dbspec.md "External documents").
    run!("external_read", async {
        let readers = NoteReader::new().connect(db).relation(SharedNote::new().match_shared_note_seq_with_seq()).order_by_seq_asc().gets().await?;
        let mut related = Vec::new();
        for r in readers.models() {
            let note = r.get_shared_note_model()?.ok_or(polyspec_orm::Error::NoRows)?;
            related.push(json!([r.get_seq()?, note.get_title()?]));
        }
        let notes = SharedNote::new().connect(db).seq(NoteReader::new().add_column_shared_note_seq()).order_by_seq_asc().gets().await?;
        let mut titles = Vec::new();
        for n in notes.models() {
            titles.push(json!(n.get_title()?));
        }
        let write = code_of(SharedNote::new().connect(db).set_seq(9).set_title("written").create().await);
        Ok::<Value, polyspec_orm::Error>(json!({"relation": related, "subquery": titles, "write": write}))
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
        Ok::<Value, polyspec_orm::Error>(Value::Array(out))
    });
    run!("aggregates", async {
        let sum = author().service_seq(7).sum_read_count().get_sum().await?;
        let avg = author().service_seq(7).avg_like_count().get_avg().await?.ok_or(polyspec_orm::Error::NoRows)?;
        assert_eq!(avg.to_bits(), 0x404805c28f5c28f6, "aggregate average has an unexpected binary64 value");
        let groups = author().service_seq(7).group_by_is_close().order_by_is_close_asc().gets_count().await?;
        let page = author().service_seq(7).remove_all_columns().order_by_seq_asc().gets_page(3, 4).await?;
        Ok::<Value, polyspec_orm::Error>(json!({
            "sum": sum,
            "avg": format!("{avg:.4}"),
            "groups": groups.to_array()?,
            "page": {"keys": keys_of(&page.items), "total": page.total_count, "pages": page.total_pages, "page": page.page, "per_page": page.per_page},
        }))
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
    run!("audit_lazy", async {
        // An audited transaction inserts its audit record right before its first write of an audited
        // table: reads and an update that matches no row leave no record, and the create inserts one.
        // The transaction is rolled back at the end, so the database is the same as at the start.
        let result = Mutex::new(Map::new());
        let ended: polyspec_orm::Result<()> = db
            .transaction(async || {
                let before = AuditRecord::new().get_count().await?;
                result.lock().unwrap().insert("before".into(), json!(before));
                let read = AuditedNote::new().label("audit-lazy").get_count().await?;
                result.lock().unwrap().insert("read".into(), json!(read));
                AuditedNote::new().set_seq(-1).set_label("audit-none").update(false).await?;
                let unchanged = AuditRecord::new().get_count().await?;
                result.lock().unwrap().insert("unchanged".into(), json!(unchanged));
                let created = AuditedNote::new().set_label("audit-lazy").create().await?;
                mask(shared, &[created.get_seq().unwrap()], &[]);
                let written = AuditRecord::new().get_count().await?;
                result.lock().unwrap().insert("written".into(), json!(written));
                Err(polyspec_orm::Error::Config("boom".into()))
            })
            .audit([("request_id", "audit-lazy")])
            .retry(0)
            .await;
        let rolled_back = matches!(&ended, Err(polyspec_orm::Error::Config(m)) if m == "boom");
        let mut result = result.into_inner().unwrap();
        result.insert("rolled_back".into(), json!(rolled_back));
        let after = AuditRecord::new().connect(db).get_count().await?;
        result.insert("after".into(), json!(after));
        Ok::<Value, polyspec_orm::Error>(Value::Object(result))
    });
    run!("functions", async {
        let mut counts = Vec::new();
        for q in [
            author().service_seq(7).and_eq_start_dt(polyspec_orm::day_of_week(), 2),
            author().service_seq(7).and_start_dt(polyspec_orm::year(), 2026),
            author().service_seq(7).and_gt_start_dt(polyspec_orm::days_ago(36500)),
            author().service_seq(7).and_lt_start_dt(polyspec_orm::months_later(1200)),
        ] {
            counts.push(json!(q.get_count().await?));
        }
        let rows = author()
            .remove_all_columns()
            .add_column_start_dt_alias_start_month(polyspec_orm::month())
            .order_by_start_dt_asc(polyspec_orm::year())
            .order_by_seq_asc()
            .gets_by_seq(vec![42, 43])
            .await?;
        let months: Vec<Value> = rows.models().map(|r| json!(int(r.get_start_month().expect("start_month")))).collect();
        Ok::<Value, polyspec_orm::Error>(json!({"counts": counts, "months": months}))
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
        Ok::<Value, polyspec_orm::Error>(Value::Array(errs))
    });
    run!("get_query", async {
        let st = author().service_seq(7).and_lk_name("x").and_aes_hex_email("user7@example.com").order_by_seq_desc().limit(0, 5).get_query().await?;
        let log = Log::default();
        let binds: Vec<Value> = st.binds.iter().map(|b| norm(&param_json(b).or_panic(|e| format!("invalid query bind: {e}")), &log)).collect();
        Ok::<Value, polyspec_orm::Error>(json!({"sql": st.sql, "binds": binds}))
    });
    run!("aes_values", async {
        let row =
            author().remove_all_columns().add_column_aes_hex_email().add_column_aes_hex_phone().get_by_seq(42).await?.ok_or(polyspec_orm::Error::NoRows)?;
        let found = author().aes_hex_email("user42@example.com").get_count().await?;
        Ok::<Value, polyspec_orm::Error>(json!({"row": row.to_array()?, "found": found}))
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
                .set_start_dt(txt(start))?
                .set_end_dt(txt(start))?
                .set_price("12.500")?
                .set_ip("10.0.0.1")
                .set_aes_hex_email("cycle@example.com");
            let created = created.set_json_setting(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::parse(r#"{"a":1}"#).expect("json literal")))?;
            let created = created.set_serialize_data(polyspec_orm::StyledValue::Value(json!({"k": "v"})))?;
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
            let loaded = author()
                .add_all_columns()
                .get_by_seq(seq)
                .await
                .map_err(|error| {
                    eprintln!("write_cycle selected row: {error}");
                    error
                })?
                .ok_or(polyspec_orm::Error::NoRows)?;
            mask(shared, &[], &[loaded.get_updated_ts().unwrap()]);
            let mut loaded = loaded.set_name("cycle-2").plus_read_count(3);
            loaded.update(true).await?;
            let mut loaded = loaded.set_name("stale");
            let stale = loaded.update(true).await;
            let again = author().add_all_columns().get_by_seq(seq).await?.ok_or(polyspec_orm::Error::NoRows)?;
            let updated = pick(Some(&again), &["name", "read_count", "price", "ip", "aes_hex_email", "json_setting", "serialize_data", "start_dt"]);
            again.delete(false).await?;
            let gone = author().get_by_seq(seq).await;
            Ok::<Value, polyspec_orm::Error>(json!({"created": created_array, "updated": updated, "stale": code_of(stale), "deleted": code_of(gone)}))
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
                .set_start_dt(txt(start))?
                .set_end_dt(txt(start))?
                .create()
                .await?;
            let seq = created.get_seq().unwrap();
            mask(shared, &[seq], &[]);
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
        "required_columns",
        db.transaction(async || {
            let missing_state = failure(Task::new().connect(db).set_title("draft").create().await);
            let missing_title = failure(Task::new().connect(db).set_state("open").create().await);
            let created = Task::new().connect(db).set_title("draft").set_state("open").create().await?;
            mask(shared, &[created.get_seq().unwrap()], &[]);
            created.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(json!({"missing_state": missing_state, "missing_title": missing_title}))
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
            let inserted = CompositeAccount::new().connect(db).creates(rows, 2).await?;
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
            Ok::<Value, polyspec_orm::Error>(json!({"inserted": inserted, "pairs": pairs.to_array()?, "left": left}))
        })
        .retry(0)
    );
    // creates(rows, batch) runs each batch of batch rows as one multi-row INSERT in one transaction; a batch that is
    // not a positive integer is CONFIG before any statement (docs/spec/protocol.md).
    run!("creates_batch", async {
        let rows = || {
            ["a", "b", "c", "d", "e"]
                .iter()
                .enumerate()
                .map(|(i, name)| CompositeAccount::new().set_tenant_id(903).set_account_id(i as i64 + 1).set_name(*name))
                .collect::<Vec<_>>()
        };
        let inserted = CompositeAccount::new().connect(db).creates(rows(), 2).await?;
        let zero = code_of(CompositeAccount::new().connect(db).creates(rows(), 0).await);
        let count = CompositeAccount::new().connect(db).tenant_id(vec![903]).get_count().await?;
        let all = CompositeAccount::new().connect(db).tenant_id(vec![903]).order_by_account_id_asc().gets().await?;
        all.delete(false).await?;
        Ok::<Value, polyspec_orm::Error>(json!({"inserted": inserted, "zero": zero, "count": count}))
    });
    // A batch whose binds exceed the bind limit is BATCH_TOO_LARGE before any statement: 21846 rows of three columns
    // bind 65538 parameters, over the limit of every dialect.
    run!("creates_batch_too_large", async {
        let rows = (0..21846).map(|i| CompositeAccount::new().set_tenant_id(904).set_account_id(i as i64 + 1).set_name("n")).collect::<Vec<_>>();
        let n = rows.len();
        let refused = code_of(CompositeAccount::new().connect(db).creates(rows, n).await);
        let count = CompositeAccount::new().connect(db).tenant_id(vec![904]).get_count().await?;
        Ok::<Value, polyspec_orm::Error>(json!({"code": refused, "count": count}))
    });
    run!("contains_ascii_fold", db.transaction(async || contains_vector(db, |q, p| q.and_lk_name(p), &["PPL", "ÉV", "_", ""]).await).retry(0));
    run!("contains_binary_code_point", db.transaction(async || contains_vector(db, |q, p| q.and_lb_name(p), &["pp", "É", "PPL", "_"]).await).retry(0));
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
            mask(shared, &seqs, &[]);
            loaded.delete(true).await?;
            let left = ServiceMember::new().connect(db).get_count_by_service_seq(seq).await?;
            let service2 = Service::new().connect(db).get_by_seq(seq).await;
            Ok::<Value, polyspec_orm::Error>(json!({"members": members, "members_left": left, "service_left": code_of(service2)}))
        })
        .retry(0)
    );

    run!("transactions", async {
        let events = Mutex::new(Vec::new());
        let result: polyspec_orm::Result<()> = db
            .transaction(async || {
                Service::new().set_name("tx-outer").create().await?;
                let inner: polyspec_orm::Result<()> = db
                    .transaction(async || {
                        Service::new().set_name("tx-inner").create().await?;
                        Err(polyspec_orm::Error::Config("boom".into()))
                    })
                    .await;
                events.lock().unwrap().push(json!(matches!(&inner, Err(polyspec_orm::Error::Config(m)) if m == "boom")));
                let count = Service::new().name(vec!["tx-outer", "tx-inner"]).get_count().await?;
                events.lock().unwrap().push(json!(count));
                let locked = Service::new().name("tx-outer").for_update().gets().await?;
                events.lock().unwrap().push(json!(locked.len()));
                db.utils().lock("conformance").await?;
                db.utils().set_local("ormtest.actor", "runner").await?;
                let actor = db.utils().local("ormtest.actor")?;
                events.lock().unwrap().push(json!(actor));
                Err(polyspec_orm::Error::Config("boom".into()))
            })
            .retry(0)
            .await;
        let mut events = events.into_inner().unwrap();
        events.push(json!(matches!(&result, Err(polyspec_orm::Error::Config(m)) if m == "boom")));
        let left = Service::new().connect(db).name(vec!["tx-outer", "tx-inner"]).get_count().await?;
        events.push(json!(left));
        Ok::<Value, polyspec_orm::Error>(Value::Array(events))
    });
    run!("restore", async {
        // Restores the soft-deleted row to its primary key. The deletion time is written as a fixed value so that all databases and
        // the runner's binds match. The transaction rolls back at the end, so the database is as it was at the start.
        let result = Mutex::new(Map::new());
        let ended: polyspec_orm::Result<()> = db
            .transaction(async || {
                let mut created = SoftRecord::new().set_name("restore").create().await?;
                let seq = created.get_seq().unwrap();
                mask(shared, &[seq], &[]);
                let deleted_at = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap();
                created = created.set_deleted_at(txt(deleted_at))?;
                created.update(false).await?;
                let hidden = SoftRecord::new().get_by_seq(seq).await;
                result.lock().unwrap().insert("hidden".into(), code_of(hidden));
                // Values outside the key are used only when restoring a deleted row. The second restore does not change a row that was not deleted, and
                // returns it.
                for (name, value) in [("restored", "restore-2"), ("again", "ignored")] {
                    let row = SoftRecord::new().set_seq(seq).set_name(value).restore().await?;
                    let mut array = row.to_array()?;
                    array["seq"] = json!("$SEQ");
                    result.lock().unwrap().insert(name.into(), array);
                }
                let missing = SoftRecord::new().set_seq(0).restore().await;
                result.lock().unwrap().insert("missing".into(), code_of(missing));
                Err(polyspec_orm::Error::Config("boom".into()))
            })
            .retry(0)
            .await;
        if !matches!(&ended, Err(polyspec_orm::Error::Config(m)) if m == "boom") {
            ended?;
        }
        let left = SoftRecord::new().connect(db).name("restore").get_count().await?;
        let mut result = result.into_inner().unwrap();
        result.insert("left".into(), json!(left));
        Ok::<Value, polyspec_orm::Error>(Value::Object(result))
    });
    run!("restore_or_create", async {
        // restore_or_create restores the soft-deleted row of its key, refuses a live row with ROW_NOT_DELETED and creates a
        // missing key (docs/operations/usage.md "Restore or create a row"). The transaction rolls back at the end.
        let result = Mutex::new(Map::new());
        let ended: polyspec_orm::Result<()> = db
            .transaction(async || {
                let mut created = SoftLink::new().set_code("roc-1").set_label("first").create().await?;
                mask(shared, &[created.get_seq().unwrap()], &[]);
                let deleted_at = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap();
                created = created.set_deleted_at(txt(deleted_at))?;
                created.update(false).await?;
                let restored = SoftLink::new().set_code("roc-1").set_label("second").restore_or_create().await?;
                let mut restored_row = restored.to_array()?;
                restored_row["seq"] = json!("$SEQ");
                result.lock().unwrap().insert("restored".into(), restored_row);
                let live = SoftLink::new().set_code("roc-1").set_label("third").restore_or_create().await;
                result.lock().unwrap().insert("live".into(), code_of(live));
                let made = SoftLink::new().set_code("roc-2").set_label("new").restore_or_create().await?;
                mask(shared, &[made.get_seq().unwrap()], &[]);
                let mut created_row = made.to_array()?;
                created_row["seq"] = json!("$SEQ");
                result.lock().unwrap().insert("created".into(), created_row);
                Err(polyspec_orm::Error::Config("boom".into()))
            })
            .retry(0)
            .await;
        if !matches!(&ended, Err(polyspec_orm::Error::Config(m)) if m == "boom") {
            ended?;
        }
        let left = SoftLink::new().connect(db).get_count().await?;
        let mut result = result.into_inner().unwrap();
        result.insert("left".into(), json!(left));
        Ok::<Value, polyspec_orm::Error>(Value::Object(result))
    });
    run!("expect_revision", async {
        // expect_revision makes an update or a delete write only while author 42's like_count still holds the expected
        // revision; an update stores revision + 1, and a mismatch is REVISION_CHANGED and writes nothing (docs/spec/dsl.md
        // "Writes"). The transaction rolls back at the end, so the database is as it was.
        let result = Mutex::new(Map::new());
        let read = async || -> polyspec_orm::Result<(Value, i64)> {
            let row = Author::new().get_by_seq(42).await?.ok_or(polyspec_orm::Error::NoRows)?;
            let like_count = i64::from(row.get_like_count()?);
            Ok((json!({"name": row.get_name()?, "like_count": like_count}), like_count))
        };
        let ended: polyspec_orm::Result<()> = db
            .transaction(async || {
                let (before, revision) = read().await?;
                result.lock().unwrap().insert("before".into(), before);
                Author::new().set_seq(42).set_name("revision-1").expect_revision("like_count", revision).update(false).await?;
                let (updated, _) = read().await?;
                result.lock().unwrap().insert("updated".into(), updated);
                let mismatch = Author::new().set_seq(42).set_name("revision-stale").expect_revision("like_count", revision).update(false).await;
                result.lock().unwrap().insert("update_mismatch".into(), code_of(mismatch));
                let (after, _) = read().await?;
                result.lock().unwrap().insert("after_mismatch".into(), after);
                let mismatch = Author::new().set_seq(42).expect_revision("like_count", revision).delete(false).await;
                result.lock().unwrap().insert("delete_mismatch".into(), code_of(mismatch));
                let kept = Author::new().seq(42).get_count().await?;
                result.lock().unwrap().insert("kept".into(), json!(kept));
                let matched = Author::new().set_seq(42).expect_revision("like_count", revision + 1).delete(false).await;
                result.lock().unwrap().insert("delete_match".into(), code_of(matched));
                let deleted = Author::new().seq(42).get_count().await?;
                result.lock().unwrap().insert("deleted".into(), json!(deleted));
                Err(polyspec_orm::Error::Config("boom".into()))
            })
            .retry(0)
            .await;
        if !matches!(&ended, Err(polyspec_orm::Error::Config(m)) if m == "boom") {
            ended?;
        }
        let left = Author::new().connect(db).seq(42).get_count().await?;
        let mut result = result.into_inner().unwrap();
        result.insert("left".into(), json!(left));
        Ok::<Value, polyspec_orm::Error>(Value::Object(result))
    });
    run!("joins_soft_deleted", async {
        // A joined soft_record row that is soft deleted meets no parent: the inner join drops the parent and the
        // left join gives it a null child. The transaction rolls back at the end, so the database is as it was.
        let names = vec!["soft-join-live", "soft-join-deleted"];
        let result = Mutex::new(Map::new());
        let ended: polyspec_orm::Result<()> = db
            .transaction(async || {
                for name in &names {
                    let service = Service::new().set_name(*name).create().await?;
                    let mut record = SoftRecord::new().set_name(*name).create().await?;
                    mask(shared, &[service.get_seq().unwrap(), record.get_seq().unwrap()], &[]);
                    if *name == "soft-join-deleted" {
                        let deleted_at = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap();
                        record = record.set_deleted_at(txt(deleted_at))?;
                        record.update(false).await?;
                    }
                }
                let inner = Service::new().join_name_with_name(SoftRecord::new().alias_record()).name(names.clone()).order_by_name_asc().gets().await?;
                result.lock().unwrap().insert("inner".into(), picks(&inner, &["name"]));
                let left = Service::new().left_join_name_with_name(SoftRecord::new().alias_record()).name(names.clone()).order_by_name_asc().gets().await?;
                let mut rows = Vec::new();
                for row in left.models() {
                    rows.push(json!({"name": row.get_name()?, "record": pick(row.get_record()?, &["name"])}));
                }
                result.lock().unwrap().insert("left".into(), Value::Array(rows));
                Err(polyspec_orm::Error::Config("boom".into()))
            })
            .retry(0)
            .await;
        if !matches!(&ended, Err(polyspec_orm::Error::Config(m)) if m == "boom") {
            ended?;
        }
        Ok::<Value, polyspec_orm::Error>(Value::Object(result.into_inner().unwrap()))
    });
    run!("column_pairs", async {
        // Two compared columns meet as dbspec check operands do (docs/spec/dbspec.md "Checks"): a comparison of two
        // columns, a column in a subquery column, a join and a relation run when their columns meet, here i32 with
        // i64 and text with varchar, and fail with OPERATOR_NOT_ALLOWED before any statement when they do not.
        let mut result = Map::new();
        let s1 = Service::new();
        result.insert("col_i32_i64".into(), json!(author().join_service_seq_with_seq(s1.clone()).read_count_lt_seq(&s1).get_count().await?));
        let s2 = Service::new();
        result.insert("col_text_varchar".into(), json!(author().join_service_seq_with_seq(s2.clone()).description_ne_name(&s2).get_count().await?));
        result.insert("in_i32_i64".into(), json!(author().like_count(User::new().add_column_seq()).get_count().await?));
        result.insert("join_i32_i64".into(), json!(author().join_read_count_with_seq(Service::new()).get_count().await?));
        let related = author().relation(Service::new().match_like_count_with_seq()).order_by_seq_asc().limit(0, 2).gets().await?;
        result.insert("relation_i32_i64".into(), json!(related.models().count()));
        let s3 = Service::new();
        result.insert("col_varchar_i64".into(), code_of(author().join_service_seq_with_seq(s3.clone()).name_eq_seq(&s3).get_count().await));
        let s4 = Service::new();
        result.insert("col_decimal_i64".into(), code_of(author().join_service_seq_with_seq(s4.clone()).price_eq_seq(&s4).get_count().await));
        result.insert("in_varchar_i64".into(), code_of(author().name(User::new().add_column_seq()).get_count().await));
        result.insert("join_varchar_i64".into(), code_of(author().join_name_with_seq(Service::new()).get_count().await));
        result.insert("relation_varchar_i64".into(), code_of(author().relation(Service::new().match_name_with_seq()).limit(0, 1).gets().await));
        Ok::<Value, polyspec_orm::Error>(Value::Object(result))
    });
    run!("relative_time_out_of_range", async {
        // A relative time function outside 0001-01-01 to 9999-12-31, or with an interval no database represents, is NULL, so
        // a comparison and its negation both match no row. secondsAgo takes an integer in every client, so 1e15 seconds
        // stands for an interval past every bound.
        let mut counts = Map::new();
        for (name, f) in [
            ("seconds_ago", polyspec_orm::seconds_ago(1000000000000000)),
            ("days_later", polyspec_orm::days_later(4000000)),
            ("months_ago", polyspec_orm::months_ago(200000)),
        ] {
            let gt = author().and_gt_start_dt(f.clone()).get_count().await?;
            let le = author().and_le_start_dt(f).get_count().await?;
            counts.insert(name.into(), json!([gt, le]));
        }
        Ok::<Value, polyspec_orm::Error>(Value::Object(counts))
    });
    run!("aes_status", async {
        let keyring = AesKeyring::new([(1, "bench-salt".to_owned())].into_iter().collect(), 1)?;
        let status = db.utils().aes().status(&Author::new(), &keyring).await?;
        let mut versions: Vec<String> = status.versions.iter().map(|(v, n)| format!("{v}:{n}")).collect();
        versions.sort();
        Ok::<Value, polyspec_orm::Error>(json!({"current": status.current, "pending": status.pending, "versions": versions.join(",")}))
    });
    // the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
    run!("hex_malformed", async {
        let white_space = code_of(HexCell::new().connect(db).get_by_seq(1).await);
        let odd_length = code_of(HexCell::new().connect(db).get_by_seq(2).await);
        Ok::<Value, polyspec_orm::Error>(json!({"white_space": white_space, "odd_length": odd_length}))
    });
    // A datetime(p) or time(p) value is bound with exactly p fraction digits, the form the SQLite CHECK of the column
    // requires (docs/spec/dialects.md); zeros past p are dropped. Each vector inserts, reads the row back by the same
    // parameter and deletes it.
    let at = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap().and_hms_opt(12, 34, 56).unwrap();
    run!(
        "datetime_p0_roundtrip",
        db.transaction(async || {
            let created = TimeCell::new().connect(db).set_at(txt(at))?.set_clock("10:11:12").create().await?;
            mask(shared, &[created.get_seq().unwrap()], &[]);
            let rows = TimeCell::new().connect(db).at(txt(at)).gets().await?;
            created.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(picks(&rows, &["clock"]))
        })
        .retry(0)
    );
    run!(
        "time_p3_roundtrip",
        db.transaction(async || {
            let created = TimeCell::new().connect(db).set_at(txt(at))?.set_clock("10:11:12.345000").create().await?;
            mask(shared, &[created.get_seq().unwrap()], &[]);
            let rows = TimeCell::new().connect(db).clock("10:11:12.345").gets().await?;
            created.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(picks(&rows, &["clock"]))
        })
        .retry(0)
    );
    // A date and a time(0) column read back as their text form (the driver's date and time values are the codec's input).
    run!(
        "date_roundtrip",
        db.transaction(async || {
            let created = DayCell::new().connect(db).set_label("date").set_day("2026-06-01")?.set_at_time("10:11:12").create().await?;
            mask(shared, &[created.get_seq().unwrap()], &[]);
            let rows = DayCell::new().connect(db).label("date").gets().await?;
            created.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(picks(&rows, &["day", "at_time"]))
        })
        .retry(0)
    );
    run!(
        "date_null",
        db.transaction(async || {
            let created = DayCell::new().connect(db).set_label("nil").create().await?;
            mask(shared, &[created.get_seq().unwrap()], &[]);
            let rows = DayCell::new().connect(db).label("nil").gets().await?;
            created.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(picks(&rows, &["day", "at_time"]))
        })
        .retry(0)
    );
    // An upsert has exactly one conflict key (docs/spec/protocol.md 1): upsert_cell leaves its identity primary key out, so
    // the unique key on code is the one key that can meet the row; an insert that does not assign code is IR_INVALID
    // before any statement.
    run!(
        "upsert_one_key",
        db.transaction(async || {
            let created = UpsertCell::new().connect(db).set_code("k1").set_label("first").duplication(UpsertCell::new().set_label("second")).create().await?;
            mask(shared, &[created.get_seq().unwrap()], &[]);
            let inserted = UpsertCell::new().connect(db).code("k1").gets().await?;
            UpsertCell::new().connect(db).set_code("k1").set_label("other").duplication(UpsertCell::new().set_label("second")).create().await?;
            let updated = UpsertCell::new().connect(db).code("k1").gets().await?;
            let unassigned = failure(UpsertCell::new().connect(db).set_label("none").duplication(UpsertCell::new().set_label("second")).create().await);
            updated.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(
                json!({"inserted": picks(&inserted, &["label"]), "updated": picks(&updated, &["label"]), "unassigned": unassigned}),
            )
        })
        .retry(0)
    );
    // A PostgreSQL uuid column is read as its text and a uuid value is bound as text cast to uuid, in one form in every
    // planner (docs/spec/dialects.md); the vector inserts, reads the row back by the same value and deletes it.
    run!(
        "uuid_roundtrip",
        db.transaction(async || {
            let created = UuidCell::new().connect(db).set_id("0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5").create().await?;
            mask(shared, &[created.get_seq().unwrap()], &[]);
            let rows = UuidCell::new().connect(db).id("0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5").gets().await?;
            created.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(picks(&rows, &["id"]))
        })
        .retry(0)
    );
    // A write counts each written row once (docs/spec/protocol.md "Write"): an upsert is 1 whether it inserts or updates,
    // and an update counts the row it matched even when the row already holds the value. The count is read through the
    // test entry point (docs/spec/protocol.md "Test write result").
    run!(
        "affected_counts",
        db.transaction(async || {
            let created = UpsertCell::new().connect(db).set_code("c1").set_label("x").duplication(UpsertCell::new().set_label("y")).create().await?;
            let seq = created.get_seq().unwrap();
            mask(shared, &[seq], &[]);
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
    // A value outside the logical type of its slot is CODEC_ENCODE before any statement (docs/spec/protocol.md §5
    // "Parameters"). A create that the client lets through is deleted, so the vector leaves the database as it found it.
    macro_rules! rejected {
        ($create:expr) => {
            async {
                match $create.await {
                    Ok(created) => {
                        mask(shared, &[created.get_seq().unwrap()], &[]);
                        created.delete(false).await?;
                        Ok::<Value, polyspec_orm::Error>(json!({"code": null}))
                    }
                    Err(e) => Ok(json!({"code": code(&e)})),
                }
            }
        };
    }
    run!(
        "datetime_precision_rejected",
        rejected!(TimeCell::new().connect(db).set_at(txt(at + chrono::Duration::milliseconds(500)))?.set_clock("10:11:12").create())
    );
    run!("varchar_length_rejected", rejected!(BindCell::new().connect(db).set_label("123456789").create()));
    run!("text_nul_rejected", rejected!(BindCell::new().connect(db).set_label("nul").set_body("a\u{0}b").create()));
    run!("uuid_form_rejected", rejected!(BindCell::new().connect(db).set_label("uuid").set_token("123E4567-E89B-12D3-A456-426614174000").create()));
    // A parameter that assigns NULL to a non-null column is CODEC_ENCODE before any statement (docs/spec/protocol.md §5
    // "Parameters"); creates binds each row value as a parameter.
    run!("null_into_not_null", async {
        let mut null_row = BindCell::new();
        polyspec_orm::core::Core::set(polyspec_orm::Model::core_mut(&mut null_row), "label", Param::Null);
        let created = BindCell::new().connect(db).creates(vec![BindCell::new().set_label("a"), null_row], 2).await;
        Ok::<Value, polyspec_orm::Error>(json!({"code": code_of(created)}))
    });
    // A contains value NULL binds NULL, so `col LIKE NULL` matches no row (docs/spec/protocol.md §2).
    run!("contains_null", async {
        let mut q = author().service_seq(7);
        polyspec_orm::core::Core::chain(
            polyspec_orm::Model::core_mut(&mut q),
            "and",
            &[polyspec_orm::core::ChainKey { op: "lk", column: "name", ..polyspec_orm::core::ChainKey::EMPTY }],
            vec![polyspec_orm::core::Arg::Value(polyspec_orm::args::Value::Null)],
        );
        Ok::<Value, polyspec_orm::Error>(match q.get_count().await {
            Ok(n) => json!({"code": null, "count": n}),
            Err(e) => json!({"code": code(&e), "count": null}),
        })
    });
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
            mask(shared, &[seq], &[]);
            let row = ClockCell::new().connect(db).get_by_seq(seq).await?.ok_or(polyspec_orm::Error::NoRows)?;
            row.delete(false).await?;
            let at6 = row.get_at6()?;
            Ok::<Value, polyspec_orm::Error>(json!({
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
            mask(shared, &[created.get_seq().unwrap()], &[]);
            let ge_now = ClockCell::new().connect(db).label("compare").and_ge_at0(polyspec_orm::now()).get_count().await?;
            let lt_now = ClockCell::new().connect(db).label("compare").and_lt_at3(polyspec_orm::now()).get_count().await?;
            created.delete(false).await?;
            Ok::<Value, polyspec_orm::Error>(json!({"at0_ge_now": ge_now, "at3_lt_now": lt_now}))
        })
        .retry(0)
    );
    // the seed prices the authors of service 100 except a seq that is a multiple of 3 (benchmarks/sql/seed.*.sql)
    run!("order_nulls", async {
        let priced = || author().remove_all_columns().add_column_price().service_seq(100).and_lt_seq(500);
        let asc = priced().order_by_price_asc().order_by_seq_asc().gets().await?.to_array()?;
        let desc = priced().order_by_price_desc().order_by_seq_asc().gets().await?.to_array()?;
        let mut per_parent = serde_json::Map::new();
        for order in ["asc", "desc"] {
            let child = Author::new().match_seq_with_user_seq().remove_all_columns().add_column_price();
            let child = if order == "asc" { child.order_by_price_asc() } else { child.order_by_price_desc() };
            let users = User::new().connect(db).relations(child.order_by_seq_asc().group_limit(2)).seq(100).gets().await?;
            per_parent.insert(order.into(), users.to_array()?);
        }
        Ok::<Value, polyspec_orm::Error>(json!({"asc": asc, "desc": desc, "limit_per_parent": Value::Object(per_parent)}))
    });
    // user 100 has the authors 99 (price NULL) and 5099 (price 3.000) under seq 10000 (benchmarks/sql/seed.*.sql)
    run!("scalar_column_subquery", async {
        let mut out = serde_json::Map::new();
        for order in ["asc", "desc"] {
            let users = User::new()
                .connect(db)
                .add_column_read_total(move |u: &User| {
                    let sub = Author::new().remove_all_columns().add_column_name().user_seq_eq_seq(u).and_lt_seq(10000);
                    let sub = if order == "asc" { sub.order_by_price_asc() } else { sub.order_by_price_desc() };
                    sub.order_by_seq_asc().limit(0, 1)
                })
                .seq(100)
                .gets()
                .await?;
            let mut rows = Vec::new();
            for u in users.models() {
                rows.push(json!([u.get_seq().unwrap(), u.get_read_total()?]));
            }
            out.insert(order.into(), Value::Array(rows));
        }
        Ok::<Value, polyspec_orm::Error>(Value::Object(out))
    });
    // a flattened region of a closed author (seq, name and service_seq collide with the parent; absent for an open author) that holds a flattened service (seq and name collide) with its service members
    run!("relations_flatten", async {
        let rows = author()
            .remove_all_columns()
            .add_column_name()
            .add_column_is_close()
            .relation(
                ServiceRegion::new().match_service_region_seq_with_seq().possible_is_close(true).parent_node().relation(
                    Service::new()
                        .match_service_seq_with_seq()
                        .parent_node()
                        .relations(ServiceMember::new().match_seq_with_service_seq().remove_all_columns().order_by_seq_asc().group_limit(2)),
                ),
            )
            .service_seq(7)
            .order_by_seq_asc()
            .limit(0, 8)
            .gets()
            .await?;
        rows.to_array()
    });
    out
}

/// The text form of a datetime column, which the date setters take (T189).
fn txt(t: chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S%.f").to_string()
}
