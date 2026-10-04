//! 등록은 database에 아무 statement도 보내지 않는다(docs/schema.md "Schema registration"). sqlx는 연결이 보낸
//! statement마다 target `sqlx::query`의 log record를 남기므로, 이 test는 그 record를 세는 logger를 process에
//! 설치하고 SQLite, MySQL, PostgreSQL의 case database에서 `utils().schema().register`가 record를 남기지 않는지
//! 확인한다. 외부 문서를 쓰는 set(contracts/fixtures/external의 member)도 database를 읽지 않고, 선언한 hash로
//! hash되지 않는 text는 statement 없이 CONFIG다. 같은 연결의 `empty()`가 record를 남기는 것으로 logger가
//! statement를 센다는 것을 확인한다. `connect_schema`는 `connect`가 보내는 statement만 보낸다.
//!
//! logger는 process에 하나이므로 이 binary에는 test가 하나뿐이다. ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이
//! 없으면 실패한다.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use orm::dbspec::{self, Document};
use orm::{Config, Db, Schema};
use orm_case_database::CaseDatabase;

/// sqlx가 database에 보낸 statement의 log record 수다.
static SENT: AtomicU64 = AtomicU64::new(0);

struct StatementCounter;

impl log::Log for StatementCounter {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target() == "sqlx::query"
    }
    fn log(&self, record: &log::Record<'_>) {
        if record.target() == "sqlx::query" {
            SENT.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn flush(&self) {}
}

static COUNTER: StatementCounter = StatementCounter;

/// contracts/fixtures/<name>.dbs로 만든 schema 값. generated code처럼 manifest text, external text와 그
/// manifestHash를 가진다.
fn set_schema(owned: &[&str], external: &[&str]) -> &'static Schema {
    let fixture = |name: &str| {
        let path = format!("{}/../../../contracts/fixtures/{name}.dbs", orm_testcase::manifest_dir().display());
        dbspec::read_file(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("{path}: {e:?}"))
    };
    let texts: Vec<(String, bool)> = owned.iter().map(|n| (fixture(n), false)).chain(external.iter().map(|n| (fixture(n), true))).collect();
    let name = |text: &str| text.lines().next().unwrap().trim_start_matches("dbspec 1 ").to_owned();
    let documents: Vec<Document> = texts
        .iter()
        .map(|(text, is_external)| {
            let set: BTreeMap<String, String> = texts.iter().filter(|(other, _)| other != text).map(|(other, _)| (name(other), other.clone())).collect();
            let mut document = dbspec::parse(text, &set).unwrap_or_else(|e| panic!("{e:?}"));
            document.external = *is_external;
            document
        })
        .collect();
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).unwrap_or_else(|e| panic!("{e:?}"));
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    Box::leak(Box::new(Schema::with_external(leak(manifest.manifest_text), leak(manifest.external_text), leak(manifest.manifest_hash))))
}

async fn register_case(driver: &str, dsn: &str) {
    let member = set_schema(&["external/member"], &["external/core"]);
    let note = set_schema(&["install/note"], &[]);
    // 다른 set의 manifest text는 선언한 hash로 hash되지 않는다.
    let edited: &'static Schema = Box::leak(Box::new(Schema::with_external(note.text(), "", member.hash())));
    let db = Db::connect(dsn, 2, Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    let before = SENT.load(Ordering::SeqCst);
    let utils = db.utils();
    let schema = utils.schema();
    schema.register(member).unwrap_or_else(|e| panic!("{driver}: register: {e}"));
    schema.register(member).unwrap_or_else(|e| panic!("{driver}: second register: {e}"));
    match schema.register(edited) {
        Err(e) if e.code() == orm::codes::CONFIG => {}
        other => panic!("{driver}: register of a text that does not hash to its declared hash: {other:?}, want CONFIG"),
    }
    let sent = SENT.load(Ordering::SeqCst) - before;
    assert_eq!(sent, 0, "{driver}: register sent {sent} statements");
    let before = SENT.load(Ordering::SeqCst);
    schema.empty().await.unwrap_or_else(|e| panic!("{driver}: empty: {e}"));
    assert!(SENT.load(Ordering::SeqCst) > before, "{driver}: the logger counted no statement of empty()");
    db.close().await;

    let before = SENT.load(Ordering::SeqCst);
    Db::connect(dsn, 2, Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}")).close().await;
    let connect_sent = SENT.load(Ordering::SeqCst) - before;
    let before = SENT.load(Ordering::SeqCst);
    Db::connect_schema(dsn, member, 2, Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect with the schema: {e}")).close().await;
    let sent = SENT.load(Ordering::SeqCst) - before;
    assert_eq!(sent, connect_sent, "{driver}: connect_schema sent {sent} statements, connect {connect_sent}; registering must send none");
}

#[tokio::test]
async fn register_sends_no_statement() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    log::set_logger(&COUNTER).expect("the statement counter is the only logger of this test binary");
    log::set_max_level(log::LevelFilter::Trace);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        register_case(driver, database.dsn()).await;
        database.drop().await;
        orm_testcase::step(format_args!("register_sends_no_statement {driver}"));
    }
}
