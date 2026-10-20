//! Registration sends no statement to the database (docs/spec/schema.md "Schema registration"). sqlx writes a log record with target `sqlx::query`
//! for each statement the connection sends, so this test installs a logger in the process that counts those records,
//! and checks that `utils().schema().register` leaves no record in the case databases of SQLite, MySQL, and PostgreSQL.
//! The same holds for a set that uses external documents (a member of contracts/fixtures/external): it does not read the database, and text that does not hash to the declared hash
//! is CONFIG with no statement. The logger is confirmed to count statements by `empty()` on the same connection leaving a record,
//! and `connect_schema` sends only the statements that `connect` sends.
//!
//! Since the logger is one per process, this binary has only one test. It fails if ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN
//! is missing.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use polyspec_orm::dbspec::{self, Document};
use polyspec_orm::{Config, Db, Schema};
use polyspec_orm_case_database::CaseDatabase;

/// The number of log records of statements sqlx sent to the database.
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

/// A schema value made from contracts/fixtures/<name>.dbs. Like generated code, it has the manifest text, external text, and
/// their manifestHash.
fn set_schema(owned: &[&str], external: &[&str]) -> &'static Schema {
    let fixture = |name: &str| {
        let path = format!("{}/../../../contracts/fixtures/{name}.dbs", polyspec_orm_testcase::manifest_dir().display());
        dbspec::read_file(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("{path}: {e:?}"))
    };
    let texts: Vec<(String, bool)> = owned.iter().map(|n| (fixture(n), false)).chain(external.iter().map(|n| (fixture(n), true))).collect();
    let name = |text: &str| text.lines().next().unwrap().trim_start_matches("dbspec 1 ").to_owned();
    let documents: Vec<Document> = texts
        .iter()
        .map(|(text, is_external)| {
            let set: BTreeMap<String, String> = texts.iter().filter(|(other, _)| other != text).map(|(other, _)| (name(other), other.clone())).collect();
            let mut document = dbspec::parse(text, &set).map(|parsed| parsed.document).unwrap_or_else(|e| panic!("{e:?}"));
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
    // The manifest text of another set does not hash to the declared hash.
    let edited: &'static Schema = Box::leak(Box::new(Schema::with_external(note.text(), "", member.hash())));
    let db = Db::connect(dsn, 2, Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    let before = SENT.load(Ordering::SeqCst);
    let utils = db.utils();
    let schema = utils.schema();
    schema.register(member).unwrap_or_else(|e| panic!("{driver}: register: {e}"));
    schema.register(member).unwrap_or_else(|e| panic!("{driver}: second register: {e}"));
    match schema.register(edited) {
        Err(e) if e.code() == polyspec_orm::codes::CONFIG => {}
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
    // Requirements: INT-54.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    log::set_logger(&COUNTER).expect("the statement counter is the only logger of this test binary");
    log::set_max_level(log::LevelFilter::Trace);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        register_case(driver, database.dsn()).await;
        database.drop().await;
        polyspec_orm_testcase::step(format_args!("register_sends_no_statement {driver}"));
    }
}
