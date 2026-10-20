//! markdown IR executor conformance (tests/markdown/README.md): runs every case in tests/markdown/cases.json, in order,
//! with this client, against one server of the flowmark build that FLOWMARK points to. That build
//! must be the one pinned by tests/markdown/flowmark.version; if it is missing or a different build, the test fails (it does not
//! skip). The model is made by build.rs from tests/markdown/corpus/dbspec/conformance.dbs.

#[allow(
    dead_code,
    unused_imports,
    clippy::all,
    reason = "the generated models are included whole, a crate uses only some of them, and lints of hand-written code do not apply to generated code"
)]
mod markdown_model {
    include!(concat!(env!("OUT_DIR"), "/markdown/orm_model.rs"));
}

use std::collections::BTreeSet;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, PoisonError};

use markdown_model::{Logs, People, Tasks};
use polyspec_orm::chrono::NaiveDate;
use polyspec_orm::{Config, Db, Error, Isolation};
use serde_json::{json, Value};

/// The module path that must be the main module of the build FLOWMARK points to.
const FLOWMARK_MODULE: &str = "github.com/polyspec/flowmark";

/// The case this runner implements. It must equal the case set in cases.json.
const CASES: &[&str] = &[
    "insert_one",
    "insert_rows",
    "insert_rows_tasks",
    "insert_identity",
    "one",
    "one_no_rows",
    "all",
    "count",
    "group_count",
    "group_count_no_rows",
    "sum",
    "avg",
    "paginate",
    "join",
    "relation_many",
    "relation_one",
    "update",
    "update_optimistic_conflict",
    "insert_on_duplicate",
    "delete",
    "delete_referenced",
    "soft_delete",
    "restore",
    "transaction_commit",
    "transaction_rollback",
    "savepoint_rollback",
    "read_only_write",
    "lock_update",
    "lock_nowait",
    "get_query",
    "isolation",
    "write_conflict",
    "transaction_retry_commit",
    "connect_corpus_mismatch",
    "connect_token_mismatch",
    "order_nulls",
    "order_random",
    "primary_key_case",
    "tuple_in",
    "subquery_aggregate",
    "scalar_column_subquery",
    "column_pairs",
    "contains",
    "contains_binary",
    "now_truncated",
    "index_read",
    "force_index",
    "unavailable_table",
    "install_refuses_aes",
    "install_refuses_audit",
];

/// The directory of the shared suite: cases.json, flowmark.version, corpus/.
fn conformance_dir() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../tests/markdown")
}

/// The directory to delete. Dropping it deletes everything inside.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The flowmark server the test started. Dropping it ends the process and waits for it.
struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The flowmark server the test started, and its corpus.
struct Served {
    bin: PathBuf,
    db: Db,
    dir: PathBuf,
    corpus: String,
    port: u16,
    token: String,
}

impl Served {
    fn dsn(&self, corpus: &str, token: &str) -> String {
        format!("markdown://127.0.0.1:{}/{corpus}?token={token}", self.port)
    }
}

/// The flowmark server that the cases share, on the runtime that runs them. A later case reads the corpus state that the
/// cases before it made, so after a failure the later cases fail with the case that stopped them.
struct Shared {
    runtime: tokio::runtime::Runtime,
    served: Served,
    _server: Server,
    _scratch: Scratch,
    stopped: Option<String>,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);

/// Starts the pinned flowmark build on a new corpus. The Rust cases are exactly the cases of cases.json.
fn start() -> Shared {
    let bin = pinned_flowmark();
    let ids: Vec<String> = load_cases().into_iter().map(|(id, _)| id).collect();
    let missing: Vec<&str> = ids.iter().map(String::as_str).filter(|id| !CASES.contains(id)).collect();
    let extra: BTreeSet<&str> = CASES.iter().copied().filter(|id| !ids.iter().any(|i| i == id)).collect();
    assert!(missing.is_empty() && extra.is_empty(), "cases.json and the Rust cases differ: missing in Rust {missing:?}, not in cases.json {extra:?}");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a current-thread runtime");
    let scratch = Scratch(std::env::temp_dir().join(format!("orm-markdown-{}-{}", std::process::id(), unique())));
    let (served, server) = runtime.block_on(serve(&bin, &scratch.0));
    Shared { runtime, served, _server: server, _scratch: scratch, stopped: None }
}

/// Runs one case of cases.json on the shared server, which the first case starts.
fn markdown_conformance_case(id: &str, expect: &Value) {
    let mut guard = SHARED.lock().unwrap_or_else(PoisonError::into_inner);
    let shared = guard.get_or_insert_with(start);
    if let Some(stopped) = &shared.stopped {
        panic!("not run: {stopped} failed, and this case reads the corpus state it leaves");
    }
    let got = match shared.runtime.block_on(run_case(id, &shared.served)) {
        Ok(value) => value,
        Err(error) => json!({ "error": error.code() }),
    };
    if !same(&got, expect) {
        shared.stopped = Some(id.to_owned());
        panic!("{id}: got {got}, want {expect}");
    }
}

/// Runs one case of contracts/fixtures/ir_answers.json: a listener answers connect with {"ok": true} and the chain's
/// one request with the case's answer, and the chain's result equals expect (docs/spec/protocol.md section 5, Read).
/// A case with `answers` instead of `answer` is a transaction: the listener answers every later message with the member
/// of `answers` named by the op of a control message or the kind of a request, and a message without one IR_INVALID.
fn ir_answer_case(chain: &str, answer: &Value, answers: &Value, expect: &Value) {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a current-thread runtime");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a listener");
    let port = listener.local_addr().expect("its address").port();
    let replies = [r#"{"ok":true}"#.to_owned(), answer.to_string()];
    let keyed = answers.as_object().cloned();
    let server = std::thread::spawn(move || {
        use std::io::Write;
        let Ok((conn, _)) = listener.accept() else { return };
        let mut writer = conn.try_clone().expect("a second handle");
        let mut lines = std::io::BufReader::new(conn).lines();
        if let Some(keyed) = keyed {
            let mut first = true;
            while let Some(Ok(line)) = lines.next() {
                let reply = if std::mem::take(&mut first) {
                    json!({ "ok": true })
                } else {
                    let message: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                    let key = message["op"].as_str().or(message["request"]["kind"].as_str()).unwrap_or("unreadable").to_owned();
                    keyed
                        .get(&key)
                        .cloned()
                        .unwrap_or_else(|| json!({ "error": { "code": "IR_INVALID", "message": format!("the case has no answer for {key}") } }))
                };
                if writer.write_all(format!("{reply}\n").as_bytes()).is_err() {
                    return;
                }
            }
            return;
        }
        for reply in replies {
            if !matches!(lines.next(), Some(Ok(_))) {
                return;
            }
            if writer.write_all(format!("{reply}\n").as_bytes()).is_err() {
                return;
            }
        }
        let _ = lines.next();
    });
    let token = "0123456789abcdef0123456789abcdef".to_owned();
    let got = runtime.block_on(async {
        let dsn = format!("markdown://127.0.0.1:{port}/conformance?token={token}");
        let db = markdown_model::connect(&dsn, 1, Config::default()).await.expect("connect");
        let s = Served { bin: PathBuf::new(), db, dir: PathBuf::new(), corpus: "conformance".to_owned(), port, token };
        let got = match run_case(chain, &s).await {
            Ok(value) => value,
            Err(error) => json!({ "error": error.code() }),
        };
        s.db.close().await;
        got
    });
    let _ = server.join();
    assert!(same(&got, expect), "got {got}, want {expect}");
}

/// Each case of tests/markdown/cases.json is the trial `markdown_conformance::<id>`, in the order of the file, and each
/// case of contracts/fixtures/ir_answers.json the trial `ir_answers::<id>`, which needs no flowmark server; the filter
/// `ir_answers::` runs only those (make ir-answers-check/rust).
fn main() {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/ir_answers.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("ir_answers.json")).expect("ir_answers.json is JSON");
    let answers: Vec<_> = doc["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .cloned()
        .map(|case| {
            let id = case["id"].as_str().expect("id").to_owned();
            polyspec_orm_testcase::trial(format!("ir_answers::{id}"), polyspec_orm_testcase::COMPUTE, move || {
                ir_answer_case(case["chain"].as_str().expect("chain"), &case["answer"], &case["answers"], &case["expect"])
            })
        })
        .collect();
    let trials = load_cases()
        .into_iter()
        .map(|(id, expect)| {
            polyspec_orm_testcase::trial(format!("markdown_conformance::{id}"), polyspec_orm_testcase::PROCESS, move || markdown_conformance_case(&id, &expect))
        })
        .chain(answers)
        .collect();
    polyspec_orm_testcase::run_in_order_then(trials, || {
        if let Some(shared) = SHARED.lock().unwrap_or_else(PoisonError::into_inner).take() {
            shared.runtime.block_on(shared.served.db.close());
        }
    });
}

/// The timestamp appended to the directory name so that names do not collide.
fn unique() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

/// The cases from cases.json: returns each id and expect in order. Fails if an id is empty or duplicated.
fn load_cases() -> Vec<(String, Value)> {
    let path = conformance_dir().join("cases.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for case in doc["cases"].as_array().unwrap_or_else(|| panic!("{}: no cases", path.display())) {
        let id = case["id"].as_str().unwrap_or_default().to_owned();
        assert!(!id.is_empty() && seen.insert(id.clone()), "cases.json: case id {id:?} is empty or repeated");
        out.push((id, case["expect"].clone()));
    }
    out
}

/// The flowmark binary that FLOWMARK points to. Fails if the binary's Go build info does not show
/// the flowmark.version of the flowmark module.
fn pinned_flowmark() -> PathBuf {
    let version = conformance_dir().join("flowmark.version");
    let pin = std::fs::read_to_string(&version).unwrap_or_else(|e| panic!("{}: {e}", version.display())).trim().to_owned();
    let bin = std::env::var("FLOWMARK").unwrap_or_default();
    assert!(
        !bin.is_empty(),
        "FLOWMARK is not set; run make markdown-conformance-check, which passes the path of the flowmark {pin} pinned in tests/markdown/flowmark.version"
    );
    let bytes = std::fs::read(&bin).unwrap_or_else(|e| {
        panic!("FLOWMARK {bin}: {e}; run make orm-install-flowmark, which installs the flowmark {pin} pinned in tests/markdown/flowmark.version")
    });
    let main = main_module(&bytes).unwrap_or_else(|| {
        panic!("FLOWMARK {bin} is no Go build; run make orm-install-flowmark, which installs the flowmark {pin} pinned in tests/markdown/flowmark.version")
    });
    assert!(
        main == (FLOWMARK_MODULE.to_owned(), pin.clone()),
        "FLOWMARK {bin} is {main:?}, not the pinned {FLOWMARK_MODULE} {pin}; run make orm-install-flowmark, or give FLOWMARK a build of a flowmark checkout at that revision"
    );
    PathBuf::from(bin)
}

/// Reads the main module's path and version from the Go binary's build info. The Go linker puts the module info text between two
/// 16-byte markers, and the `mod\t<path>\t<version>` line in that text is the main module.
fn main_module(binary: &[u8]) -> Option<(String, String)> {
    const START: [u8; 16] = [0x30, 0x77, 0xaf, 0x0c, 0x92, 0x74, 0x08, 0x02, 0x41, 0xe1, 0xc1, 0x07, 0xe6, 0xd6, 0x18, 0xe6];
    const END: [u8; 16] = [0xf9, 0x32, 0x43, 0x31, 0x86, 0x18, 0x20, 0x72, 0x00, 0x82, 0x42, 0x10, 0x41, 0x16, 0xd8, 0xf2];
    let start = binary.windows(START.len()).position(|w| w == START)? + START.len();
    let end = start + binary[start..].windows(END.len()).position(|w| w == END)?;
    let text = std::str::from_utf8(&binary[start..end]).ok()?;
    let line = text.lines().find(|line| line.starts_with("mod\t"))?;
    let mut fields = line.split('\t').skip(1);
    Some((fields.next()?.to_owned(), fields.next()?.to_owned()))
}

/// Installs corpus/ as a new corpus, starts that server, and connects to it.
async fn serve(bin: &Path, scratch: &Path) -> (Served, Server) {
    let corpus = "conformance".to_owned();
    let dir = scratch.join(&corpus);
    std::fs::create_dir_all(dir.join("dbspec")).unwrap();
    std::fs::copy(conformance_dir().join("corpus/dbspec/conformance.dbs"), dir.join("dbspec/conformance.dbs")).unwrap();
    polyspec_orm_testcase::step(format_args!("flowmark install {}", dir.display()));
    let install = Command::new(bin).arg("install").arg(&dir).output().unwrap();
    assert!(
        install.status.success(),
        "flowmark install: {}\n{}{}",
        install.status,
        String::from_utf8_lossy(&install.stdout),
        String::from_utf8_lossy(&install.stderr)
    );
    polyspec_orm_testcase::step(format_args!("flowmark serve {} --port 0", dir.display()));
    let mut child = Command::new(bin).arg("serve").arg(&dir).args(["--port", "0"]).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let server = Server(child);
    let mut line = String::new();
    std::io::BufReader::new(stdout).read_line(&mut line).unwrap();
    let port = line
        .trim_end()
        .strip_prefix("[serve] listening on 127.0.0.1:")
        .and_then(|rest| rest.strip_suffix(&format!(" for the corpus {corpus}")))
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or_else(|| panic!("flowmark serve printed {line:?}, not its listening line"));
    let file: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".flowmark/server.json")).unwrap()).unwrap();
    let token = file["token"].as_str().expect("server.json has a token").to_owned();
    let dsn = format!("markdown://127.0.0.1:{port}/{corpus}?token={token}");
    let db = markdown_model::connect(&dsn, 0, Config::default()).await.unwrap_or_else(|e| panic!("connect: {e}"));
    (Served { bin: bin.to_path_buf(), db, dir, corpus, port, token }, server)
}

/// Two JSON values are equal: numbers are equal if their values are equal (16 and 16.0).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn day(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
}

/// The error the callback returns to roll back the transaction.
fn stop() -> Error {
    Error::Config("stop".into())
}

fn is_stop(error: &Error) -> bool {
    matches!(error, Error::Config(message) if message == "stop")
}

/// The orm code of the error of `r`, or null when it holds a value.
fn code_of<T>(r: polyspec_orm::Result<T>) -> Value {
    r.err().map_or(Value::Null, |e| Value::from(e.code().to_owned()))
}

/// An integer result value, which a client may hold as a number or as its text; an absent or null value is null.
fn integer(v: Option<Value>) -> Value {
    match v {
        Some(Value::String(text)) => json!(text.parse::<i64>().unwrap_or_else(|_| panic!("invalid integer text: {text}"))),
        Some(other) => other,
        None => Value::Null,
    }
}

/// The code that flowmark install prints when it refuses tests/markdown/refused/<name>.dbs, {"error": code}; an install
/// that succeeds is {"error": null}.
fn refused_install(s: &Served, name: &str) -> Value {
    let scratch = Scratch(std::env::temp_dir().join(format!("orm-markdown-refused-{}-{}", std::process::id(), unique())));
    let dir = scratch.0.join(name);
    std::fs::create_dir_all(dir.join("dbspec")).unwrap();
    std::fs::copy(conformance_dir().join(format!("refused/{name}.dbs")), dir.join(format!("dbspec/{name}.dbs"))).unwrap();
    let install = Command::new(&s.bin).arg("install").arg(&dir).output().unwrap();
    if install.status.success() {
        return json!({ "error": null });
    }
    let out = format!("{}{}", String::from_utf8_lossy(&install.stdout), String::from_utf8_lossy(&install.stderr));
    let code = out
        .lines()
        .find_map(|line| line.strip_prefix("flowmark install: ")?.split_once(':').map(|(code, _)| code.to_owned()))
        .filter(|code| !code.is_empty() && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
        .unwrap_or_else(|| panic!("flowmark install {}: {} without a refusal code\n{out}", dir.display(), install.status));
    json!({ "error": code })
}

/// Runs case `id` and returns the result value that the README defines. An error becomes the {"error": code} result for that code.
async fn run_case(id: &str, s: &Served) -> polyspec_orm::Result<Value> {
    let db = &s.db;
    Ok(match id {
        "insert_one" => {
            let m =
                People::new().connect(db).set_name("Ann").set_email(Some("ann@example.com".to_owned())).set_age(Some(30)).set_score("1.50")?.create().await?;
            json!({ "id": m.get_id()? })
        }
        "insert_rows" => {
            let bob = People::new().set_name("Bob").set_email(Some("bob@example.com".to_owned())).set_age(Some(25)).set_score("2.00")?;
            let cara = People::new().set_name("Cara").set_email(None::<String>).set_age(None::<i32>).set_score("0.50")?;
            json!(People::new().connect(db).creates(vec![bob, cara], 2).await?)
        }
        "insert_rows_tasks" => {
            let rows = vec![
                Tasks::new().set_owner("P1").set_title("write spec").set_points(3).set_due(Some("2026-10-01".to_string()))?,
                Tasks::new().set_owner("P1").set_title("review").set_points(5).set_due(None::<String>)?,
                Tasks::new().set_owner("P2").set_title("ship").set_points(8).set_due(Some("2026-10-05".to_string()))?,
            ];
            json!(Tasks::new().connect(db).creates(rows, 100).await?)
        }
        "insert_identity" => {
            let m = Logs::new().connect(db).set_task("T1").set_note("started").create().await?;
            json!({ "id": m.get_id()? })
        }
        "one" => People::new()
            .connect(db)
            .remove_all_columns()
            .add_column_name()
            .add_column_email()
            .add_column_age()
            .add_column_active()
            .add_column_score()
            .id("P1")
            .get()
            .await?
            .ok_or(polyspec_orm::Error::NoRows)?
            .to_array()?,
        "one_no_rows" => People::new().connect(db).id("P9").get().await?.map(|m| m.to_array()).transpose()?.unwrap_or(Value::Null),
        "all" => People::new().connect(db).remove_all_columns().add_column_name().add_column_age().order_by_name_desc().gets().await?.to_array()?,
        "count" => json!(Tasks::new().connect(db).owner("P1").get_count().await?),
        "group_count" => Tasks::new().connect(db).group_by_owner().order_by_owner_asc().gets_count().await?.to_array()?,
        "group_count_no_rows" => Tasks::new().connect(db).owner("P9").group_by_owner().order_by_owner_asc().gets_count().await?.to_array()?,
        "sum" => json!(Tasks::new().connect(db).sum_points().get_sum().await?),
        "avg" => json!(People::new().connect(db).avg_age().get_avg().await?),
        "paginate" => {
            let page = People::new().connect(db).remove_all_columns().add_column_name().order_by_name_asc().gets_page(2, 2).await?;
            json!({ "items": page.items.to_array()?, "total_count": page.total_count, "total_pages": page.total_pages })
        }
        "join" => Tasks::new()
            .connect(db)
            .remove_all_columns()
            .add_column_title()
            .join_owner_with_id(People::new().remove_all_columns().add_column_name())
            .order_by_title_asc()
            .gets()
            .await?
            .to_array()?,
        "relation_many" => People::new()
            .connect(db)
            .remove_all_columns()
            .add_column_name()
            .relations(Tasks::new().remove_all_columns().add_column_due().match_id_with_owner().order_by_title_asc())
            .id("P1")
            .get()
            .await?
            .ok_or(polyspec_orm::Error::NoRows)?
            .to_array()?,
        "relation_one" => Tasks::new()
            .connect(db)
            .remove_all_columns()
            .add_column_title()
            .relation(People::new().remove_all_columns().add_column_name().match_owner_with_id())
            .id("T3")
            .get()
            .await?
            .ok_or(polyspec_orm::Error::NoRows)?
            .to_array()?,
        "update" => {
            let mut m = People::new().connect(db).id("P2").get().await?.ok_or(polyspec_orm::Error::NoRows)?.set_age(Some(26));
            m.update(false).await?;
            People::new().connect(db).remove_all_columns().add_column_age().id("P2").get().await?.ok_or(polyspec_orm::Error::NoRows)?.to_array()?
        }
        "update_optimistic_conflict" => {
            let stale = People::new().connect(db).id("P2").get().await?.ok_or(polyspec_orm::Error::NoRows)?;
            let mut fresh = People::new().connect(db).id("P2").get().await?.ok_or(polyspec_orm::Error::NoRows)?.set_name("Bobby");
            fresh.update(false).await?;
            let mut stale = stale.set_age(Some(27));
            stale.update(true).await?;
            Value::Null
        }
        "insert_on_duplicate" => {
            let m = People::new()
                .connect(db)
                .set_name("Ann B")
                .set_email(Some("ann@example.com".to_owned()))
                .duplication(People::new().set_name("Ann B"))
                .create()
                .await?;
            let read = People::new().connect(db).id("P1").get().await?.ok_or(polyspec_orm::Error::NoRows)?;
            json!({ "created": m.get_id()?, "name": read.get_name()? })
        }
        "delete" => {
            Tasks::new().connect(db).id("T2").get().await?.ok_or(polyspec_orm::Error::NoRows)?.delete(false).await?;
            json!(Tasks::new().connect(db).get_count().await?)
        }
        "delete_referenced" => {
            Tasks::new().connect(db).id("T1").get().await?.ok_or(polyspec_orm::Error::NoRows)?.delete(false).await?;
            Value::Null
        }
        "soft_delete" => {
            People::new().connect(db).id("P3").get().await?.ok_or(polyspec_orm::Error::NoRows)?.delete(false).await?;
            json!(People::new().connect(db).get_count().await?)
        }
        "restore" => {
            let m = People::new().connect(db).set_id("P3").restore().await?;
            let count = People::new().connect(db).get_count().await?;
            json!({ "id": m.get_id()?, "name": m.get_name()?, "count": count })
        }
        "transaction_commit" => {
            db.transaction(async || Logs::new().set_task("T3").set_note("committed").create().await.map(drop)).await?;
            json!(Logs::new().connect(db).get_count().await?)
        }
        "transaction_rollback" => {
            let ended: polyspec_orm::Result<()> = db
                .transaction(async || {
                    Logs::new().set_task("T3").set_note("rolled back").create().await?;
                    Err(stop())
                })
                .await;
            match ended {
                Err(error) if is_stop(&error) => {}
                other => return Err(Error::Config(format!("the transaction ended with {other:?}, not its callback's error"))),
            }
            json!(Logs::new().connect(db).get_count().await?)
        }
        "savepoint_rollback" => {
            db.transaction(async || {
                Logs::new().set_task("T3").set_note("outer").create().await?;
                let inner: polyspec_orm::Result<()> = db
                    .transaction(async || {
                        Logs::new().set_task("T3").set_note("inner").create().await?;
                        Err(stop())
                    })
                    .await;
                match inner {
                    Err(error) if is_stop(&error) => Ok(()),
                    other => Err(Error::Config(format!("the savepoint ended with {other:?}, not its callback's error"))),
                }
            })
            .await?;
            let rows = Logs::new().connect(db).order_by_id_asc().gets().await?;
            let notes: Vec<String> = rows.models().map(|m| m.get_note().map(str::to_owned)).collect::<polyspec_orm::Result<_>>()?;
            json!(notes)
        }
        "read_only_write" => {
            db.transaction(async || Logs::new().set_task("T3").set_note("read only").create().await.map(drop)).read_only().await?;
            Value::Null
        }
        "lock_update" => db.transaction(async || People::new().connect(db).remove_all_columns().id("P1").for_update().get().await?.ok_or(polyspec_orm::Error::NoRows)?.to_array()).await?,
        "lock_nowait" => {
            db.transaction(async || People::new().connect(db).id("P1").for_update_no_wait().get().await.map(drop)).await?;
            Value::Null
        }
        "get_query" => {
            People::new().connect(db).get_query().await?;
            Value::Null
        }
        "isolation" => {
            db.transaction(async || Ok(())).isolation(Isolation::Serializable).await?;
            Value::Null
        }
        "write_conflict" => {
            let committed = db
                .transaction(async || {
                    let mut m = People::new().id("P1").get().await?.ok_or(polyspec_orm::Error::NoRows)?.set_name("Ann C");
                    m.update(false).await?;
                    // An edit outside the engine: changes a file the transaction writes before commit.
                    let path = s.dir.join("people.flowmark.md");
                    let text = std::fs::read_to_string(&path).map_err(|e| Error::Config(format!("{}: {e}", path.display())))?;
                    if !text.contains("Cara") {
                        return Err(Error::Config(format!("{} holds no Cara to edit:\n{text}", path.display())));
                    }
                    std::fs::write(&path, text.replacen("Cara", "Carol", 1)).map_err(|e| Error::Config(format!("{}: {e}", path.display())))
                })
                .await;
            let read = People::new().connect(db).id("P1").get().await?.ok_or(polyspec_orm::Error::NoRows)?;
            let code = committed.err().map(|error| error.code().to_owned()).unwrap_or_default();
            json!({ "error": code, "name": read.get_name()? })
        }
        // A transaction that reads P1 and writes its own name back, with retry options: the commit's code (null when it
        // commits) and how many times the callback ran. WRITE_CONFLICT is never retried, DEADLOCK is
        // (contracts/fixtures/ir_answers.json).
        "transaction_retry_commit" => {
            let runs = std::sync::atomic::AtomicU32::new(0);
            let committed = db
                .transaction(async || {
                    runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let m = People::new().id("P1").get().await?.ok_or(polyspec_orm::Error::NoRows)?;
                    let name = m.get_name()?.to_owned();
                    m.set_name(&name).update(false).await.map(drop)
                })
                .retry(3)
                .await;
            let code = committed.err().map(|error| Value::from(error.code().to_owned())).unwrap_or(Value::Null);
            json!({ "error": code, "runs": runs.load(std::sync::atomic::Ordering::SeqCst) })
        }
        "connect_corpus_mismatch" => {
            markdown_model::connect(&s.dsn("other", &s.token), 0, Config::default()).await?.close().await;
            Value::Null
        }
        "connect_token_mismatch" => {
            markdown_model::connect(&s.dsn(&s.corpus, &"0".repeat(32)), 0, Config::default()).await?.close().await;
            Value::Null
        }
        // NULL sorts before every value ascending and after every value descending (docs/spec/dialects.md DIA-156).
        "order_nulls" => json!({
            "asc": People::new().connect(db).remove_all_columns().add_column_age().order_by_age_asc().gets().await?.to_array()?,
            "desc": People::new().connect(db).remove_all_columns().add_column_age().order_by_age_desc().gets().await?.to_array()?,
        }),
        // orderByRandom is supported and not seeded, so the case answers the keys sorted (DIA-182).
        "order_random" => {
            let rows = People::new().connect(db).remove_all_columns().order_by_random().gets().await?;
            let mut keys = rows.models().map(|m| m.get_id().map(str::to_owned)).collect::<polyspec_orm::Result<Vec<String>>>()?;
            keys.sort();
            json!(keys)
        }
        // The key t3 equals T3 without regard to case: a plain insert is DUPLICATE_KEY, and an on_duplicate insert meets
        // T3, which keeps its key (DIA-164).
        "primary_key_case" => {
            let duplicate = code_of(Tasks::new().connect(db).set_id("t3").set_owner("P2").set_title("dup").set_points(1).create().await);
            Tasks::new()
                .connect(db)
                .set_id("t3")
                .set_owner("P2")
                .set_title("ship it")
                .set_points(8)
                .duplication(Tasks::new().set_title("ship it"))
                .create()
                .await?;
            let met = Tasks::new().connect(db).remove_all_columns().add_column_title().id("T3").get().await?.ok_or(polyspec_orm::Error::NoRows)?.to_array()?;
            json!({ "duplicate": duplicate, "met": met, "count": Tasks::new().connect(db).get_count().await? })
        }
        // Two columns compared with a list of value groups, IN and NOT IN (DIA-168).
        "tuple_in" => {
            let pairs = || vec![("T1".to_owned(), "P1".to_owned()), ("T3".to_owned(), "P1".to_owned())];
            json!({
                "in": Tasks::new().connect(db).remove_all_columns().tuple_id_with_owner(pairs()).order_by_id_asc().gets().await?.to_array()?,
                "not_in": Tasks::new().connect(db).remove_all_columns().ne_tuple_id_with_owner(pairs()).order_by_id_asc().gets().await?.to_array()?,
            })
        }
        // The sum of each person's task points as a scalar Sub aggregate, and the owners of a task through an IN subquery
        // (DIA-168).
        "subquery_aggregate" => {
            let rows = People::new()
                .connect(db)
                .remove_all_columns()
                .add_column_task_points(|p: &People| Tasks::new().sum_points().owner_eq_id(p))
                .order_by_id_asc()
                .gets()
                .await?;
            let mut sums = Vec::new();
            for m in rows.models() {
                sums.push(json!([m.get_id()?, integer(m.get_task_points()?)]));
            }
            let owners = People::new().connect(db).remove_all_columns().id(Tasks::new().add_column_owner()).order_by_id_asc().gets().await?.to_array()?;
            json!({ "sums": sums, "owners": owners })
        }
        // The title of each person's first task, a column subquery with limit 1 and an order by the primary key; without
        // the limit it is IR_INVALID (DIA-169).
        "scalar_column_subquery" => {
            let rows = People::new()
                .connect(db)
                .remove_all_columns()
                .add_column_first_task(|p: &People| Tasks::new().remove_all_columns().add_column_title().owner_eq_id(p).order_by_id_asc().limit(0, 1))
                .order_by_id_asc()
                .gets()
                .await?;
            let mut first = Vec::new();
            for m in rows.models() {
                first.push(json!([m.get_id()?, m.get_first_task()?]));
            }
            let unlimited = code_of(
                People::new()
                    .connect(db)
                    .remove_all_columns()
                    .add_column_first_task(|p: &People| Tasks::new().remove_all_columns().add_column_title().owner_eq_id(p).order_by_id_asc())
                    .order_by_id_asc()
                    .gets()
                    .await,
            );
            json!({ "first": first, "unlimited": unlimited })
        }
        // varchar with varchar meet; i32 with varchar do not and are OPERATOR_NOT_ALLOWED (DIA-170).
        "column_pairs" => {
            let p = People::new();
            let meet = Tasks::new().connect(db).join_owner_with_id(p.clone()).title_ne_name(&p).get_count().await?;
            let q = People::new();
            let refused = code_of(Tasks::new().connect(db).join_owner_with_id(q.clone()).points_eq_name(&q).get_count().await);
            json!({ "meet": meet, "refused": refused })
        }
        // Lk: A-Z and a-z without regard to case, % literal (DIA-171).
        "contains" => json!({
            "fold": People::new().connect(db).remove_all_columns().lk_name("ANN").order_by_id_asc().gets().await?.to_array()?,
            "literal": People::new().connect(db).remove_all_columns().lk_name("%").order_by_id_asc().gets().await?.to_array()?,
        }),
        // Lb: compared by code point (DIA-172).
        "contains_binary" => json!({
            "exact": People::new().connect(db).remove_all_columns().lb_name("Ann").order_by_id_asc().gets().await?.to_array()?,
            "folded": People::new().connect(db).remove_all_columns().lb_name("ann").order_by_id_asc().gets().await?.to_array()?,
        }),
        // The default now of joined, a datetime(0), holds no fraction, and a relative time function past 9999-12-31 is
        // NULL and matches no row (DIA-173).
        "now_truncated" => {
            use polyspec_orm::chrono::Timelike;
            let joined = People::new().connect(db).id("P1").get().await?.ok_or(polyspec_orm::Error::NoRows)?.get_joined()?;
            let far = || polyspec_orm::seconds_later(1000000000000000);
            json!({
                "fraction": joined.nanosecond(),
                "out_of_range": [People::new().connect(db).and_gt_joined(far()).get_count().await?, People::new().connect(db).and_le_joined(far()).get_count().await?],
            })
        }
        // A read through the column of the index ix_tasks_owner, which the corpus derives in memory (DIA-176).
        "index_read" => Tasks::new().connect(db).remove_all_columns().owner("P2").gets().await?.to_array()?,
        // An index hint, which the corpus does not name: CAPABILITY_UNSUPPORTED (DIA-186).
        "force_index" => Tasks::new().connect(db).force_index_ix_tasks_owner().owner("P1").gets().await?.to_array()?,
        // A heading of another table in tasks.flowmark.md is format.block: a read of tasks fails CONSTRAINT naming the
        // file, and reads again once the file is restored (DIA-190).
        "unavailable_table" => {
            let path = s.dir.join("tasks.flowmark.md");
            let io = |e: std::io::Error| Error::Config(format!("{}: {e}", path.display()));
            let text = std::fs::read(&path).map_err(io)?;
            let mut broken_text = text.clone();
            broken_text.extend_from_slice(b"\n## people row P1\n");
            std::fs::write(&path, &broken_text).map_err(io)?;
            let broken = Tasks::new().connect(db).get_count().await;
            std::fs::write(&path, &text).map_err(io)?;
            let names_file = broken.as_ref().is_err_and(|e| e.to_string().contains("tasks.flowmark.md"));
            json!({ "broken": code_of(broken), "names_file": names_file, "restored": Tasks::new().connect(db).get_count().await? })
        }
        // A catalog with an aes column is a schema error on a corpus (DIA-178).
        "install_refuses_aes" => refused_install(s, "aes"),
        // A catalog with an audit setting is a schema error on a corpus (DIA-179).
        "install_refuses_audit" => refused_install(s, "audit"),
        other => unreachable!("case {other} is not in CASES"),
    })
}
