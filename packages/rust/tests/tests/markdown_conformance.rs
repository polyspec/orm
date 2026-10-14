//! markdown IR executor conformance(tests/markdown/README.md): tests/markdown/cases.json의 모든 case를 그
//! 순서대로, FLOWMARK가 가리키는 flowmark build의 server 하나에 대해 이 client로 실행한다. 그 build는
//! tests/markdown/flowmark.version이 고정한 build여야 하고, 없거나 다른 build이면 test는 실패한다(건너뛰지
//! 않는다). model은 build.rs가 tests/markdown/corpus/dbspec/conformance.dbs에서 만든다.

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

use markdown_model::{Logs, People, Tasks};
use polyspec_orm::chrono::NaiveDate;
use polyspec_orm::{Config, Db, Error, Isolation};
use serde_json::{json, Value};

/// FLOWMARK가 가리키는 build의 main module이어야 하는 module path다.
const FLOWMARK_MODULE: &str = "github.com/polyspec/flowmark";

/// 이 runner가 구현한 case다. cases.json의 case 집합과 같아야 한다.
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
    "connect_corpus_mismatch",
    "connect_token_mismatch",
];

/// 공유 suite의 directory다: cases.json, flowmark.version, corpus/.
fn conformance_dir() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../tests/markdown")
}

/// 지울 directory다. drop하면 그 안의 모든 것을 지운다.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// test가 시작한 flowmark server다. drop하면 process를 끝내고 기다린다.
struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// test가 시작한 flowmark server와 그 corpus다.
struct Served {
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

#[tokio::test]
async fn markdown_conformance() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let bin = pinned_flowmark();
    let cases = load_cases();
    let ids: Vec<&str> = cases.iter().map(|(id, _)| id.as_str()).collect();
    let missing: Vec<&str> = ids.iter().copied().filter(|id| !CASES.contains(id)).collect();
    let extra: BTreeSet<&str> = CASES.iter().copied().filter(|id| !ids.contains(id)).collect();
    assert!(missing.is_empty() && extra.is_empty(), "cases.json and the Rust cases differ: missing in Rust {missing:?}, not in cases.json {extra:?}");
    let scratch = Scratch(std::env::temp_dir().join(format!("orm-markdown-{}-{}", std::process::id(), unique())));
    let (served, _server) = serve(&bin, &scratch.0).await;
    for (id, expect) in &cases {
        polyspec_orm_testcase::step(format_args!("case {id}"));
        let got = match run_case(id, &served).await {
            Ok(value) => value,
            Err(error) => json!({ "error": error.code() }),
        };
        // 뒤의 case는 앞 case가 만든 corpus 상태를 읽으므로 첫 실패에서 멈춘다.
        assert!(same(&got, expect), "{id}: got {got}, want {expect}");
    }
    served.db.close().await;
}

/// 이름이 겹치지 않도록 directory 이름에 붙이는 시각이다.
fn unique() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

/// cases.json의 case: id와 expect를 순서대로 돌려준다. id가 비었거나 겹치면 실패한다.
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

/// FLOWMARK가 가리키는 flowmark binary다. binary의 Go build 정보가 flowmark module의 flowmark.version 판이
/// 아니면 실패한다.
fn pinned_flowmark() -> PathBuf {
    let version = conformance_dir().join("flowmark.version");
    let pin = std::fs::read_to_string(&version).unwrap_or_else(|e| panic!("{}: {e}", version.display())).trim().to_owned();
    let bin = std::env::var("FLOWMARK").unwrap_or_default();
    assert!(
        !bin.is_empty(),
        "FLOWMARK is not set; run make markdown-conformance-check, which passes the path of the flowmark {pin} pinned in tests/markdown/flowmark.version"
    );
    let bytes = std::fs::read(&bin).unwrap_or_else(|e| {
        panic!("FLOWMARK {bin}: {e}; run make install-flowmark, which installs the flowmark {pin} pinned in tests/markdown/flowmark.version")
    });
    let main = main_module(&bytes).unwrap_or_else(|| {
        panic!("FLOWMARK {bin} is no Go build; run make install-flowmark, which installs the flowmark {pin} pinned in tests/markdown/flowmark.version")
    });
    assert!(
        main == (FLOWMARK_MODULE.to_owned(), pin.clone()),
        "FLOWMARK {bin} is {main:?}, not the pinned {FLOWMARK_MODULE} {pin}; run make install-flowmark, or give FLOWMARK a build of a flowmark checkout at that revision"
    );
    PathBuf::from(bin)
}

/// Go binary의 build 정보에서 main module의 path와 version을 읽는다. Go linker는 module 정보 text를 두
/// 16 byte 표지 사이에 두며, 그 text의 `mod\t<path>\t<version>` 줄이 main module이다.
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

/// corpus/를 새 corpus로 install하고 그 server를 시작해 연결한다.
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
    (Served { db, dir, corpus, port, token }, server)
}

/// 두 JSON 값이 같다: 수는 그 값이 같으면 같다(16과 16.0).
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

/// transaction을 rollback시키려고 callback이 돌려주는 오류다.
fn stop() -> Error {
    Error::Config("stop".into())
}

fn is_stop(error: &Error) -> bool {
    matches!(error, Error::Config(message) if message == "stop")
}

/// case `id`를 실행하고 README가 정한 결과 값을 돌려준다. 오류는 그 code의 {"error": code} 결과가 된다.
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
            json!(People::new().connect(db).creates(vec![bob, cara]).await?)
        }
        "insert_rows_tasks" => {
            let rows = vec![
                Tasks::new().set_owner("P1").set_title("write spec").set_points(3).set_due(Some(day("2026-10-01"))),
                Tasks::new().set_owner("P1").set_title("review").set_points(5).set_due(None::<NaiveDate>),
                Tasks::new().set_owner("P2").set_title("ship").set_points(8).set_due(Some(day("2026-10-05"))),
            ];
            json!(Tasks::new().connect(db).creates(rows).await?)
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
            .to_array()?,
        "one_no_rows" => People::new().connect(db).id("P9").get().await?.to_array()?,
        "all" => People::new().connect(db).remove_all_columns().add_column_name().add_column_age().order_by_name_desc().gets().await?.to_array()?,
        "count" => json!(Tasks::new().connect(db).owner("P1").get_count().await?),
        "group_count" => Tasks::new().connect(db).group_by_owner().order_by_owner_asc().gets_count().await?.to_array()?,
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
            .to_array()?,
        "relation_one" => Tasks::new()
            .connect(db)
            .remove_all_columns()
            .add_column_title()
            .relation(People::new().remove_all_columns().add_column_name().match_owner_with_id())
            .id("T3")
            .get()
            .await?
            .to_array()?,
        "update" => {
            let mut m = People::new().connect(db).id("P2").get().await?.set_age(Some(26));
            m.update(false).await?;
            People::new().connect(db).remove_all_columns().add_column_age().id("P2").get().await?.to_array()?
        }
        "update_optimistic_conflict" => {
            let stale = People::new().connect(db).id("P2").get().await?;
            let mut fresh = People::new().connect(db).id("P2").get().await?.set_name("Bobby");
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
            let read = People::new().connect(db).id("P1").get().await?;
            json!({ "created": m.get_id()?, "name": read.get_name()? })
        }
        "delete" => {
            Tasks::new().connect(db).id("T2").get().await?.delete(false).await?;
            json!(Tasks::new().connect(db).get_count().await?)
        }
        "delete_referenced" => {
            Tasks::new().connect(db).id("T1").get().await?.delete(false).await?;
            Value::Null
        }
        "soft_delete" => {
            People::new().connect(db).id("P3").get().await?.delete(false).await?;
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
        "lock_update" => db.transaction(async || People::new().connect(db).remove_all_columns().id("P1").for_update().get().await?.to_array()).await?,
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
                    let mut m = People::new().id("P1").get().await?.set_name("Ann C");
                    m.update(false).await?;
                    // engine 밖의 편집: transaction이 쓸 file을 commit 전에 바꾼다.
                    let path = s.dir.join("people.flowmark.md");
                    let text = std::fs::read_to_string(&path).map_err(|e| Error::Config(format!("{}: {e}", path.display())))?;
                    if !text.contains("Cara") {
                        return Err(Error::Config(format!("{} holds no Cara to edit:\n{text}", path.display())));
                    }
                    std::fs::write(&path, text.replacen("Cara", "Carol", 1)).map_err(|e| Error::Config(format!("{}: {e}", path.display())))
                })
                .await;
            let read = People::new().connect(db).id("P1").get().await?;
            let code = committed.err().map(|error| error.code().to_owned()).unwrap_or_default();
            json!({ "error": code, "name": read.get_name()? })
        }
        "connect_corpus_mismatch" => {
            markdown_model::connect(&s.dsn("other", &s.token), 0, Config::default()).await?.close().await;
            Value::Null
        }
        "connect_token_mismatch" => {
            markdown_model::connect(&s.dsn(&s.corpus, &"0".repeat(32)), 0, Config::default()).await?.close().await;
            Value::Null
        }
        other => unreachable!("case {other} is not in CASES"),
    })
}
