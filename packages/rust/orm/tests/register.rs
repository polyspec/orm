//! Registration sends no statement to the database (docs/spec/schema.md "Schema registration"). sqlx writes a log record with target `sqlx::query`
//! for each statement the connection sends, so this test installs a logger in the process that counts those records,
//! and checks that `utils().schema().register` leaves no record in the case databases of SQLite, MySQL, and PostgreSQL.
//! The same holds for a set that uses external documents (a member of contracts/fixtures/external): it does not read the database, and text that does not hash to the declared hash
//! is CONFIG with no statement. The logger is confirmed to count statements by `empty()` on the same connection leaving a record,
//! and `connect_schema` sends only the statements that `connect` sends.
//!
//! Since the logger is one per process, this binary has only one test. It fails if ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN
//! is missing.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

#[path = "common/external_schema.rs"]
mod external_schema;
use external_schema::set_schema;

use std::sync::atomic::{AtomicU64, Ordering};

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

async fn register_case(driver: &str, dsn: &str) {
    let member = set_schema(&["external/member"], &["external/core"]);
    let note = set_schema(&["install/note"], &[]);
    // The manifest text of another set does not hash to the declared hash.
    let edited: &'static Schema = Box::leak(Box::new(Schema::with_external(note.text(), "", member.hash())));
    let db = Db::connect(dsn, 2, Config::default()).await.or_panic(|e| format!("{driver}: connect: {e}"));
    let before = SENT.load(Ordering::SeqCst);
    let utils = db.utils();
    let schema = utils.schema();
    schema.register(member).or_panic(|e| format!("{driver}: register: {e}"));
    schema.register(member).or_panic(|e| format!("{driver}: second register: {e}"));
    match schema.register(edited) {
        Err(e) => assert!(e.code() == polyspec_orm::codes::CONFIG, "{driver}: register of a text that does not hash to its declared hash: {e:?}, want CONFIG"),
        other => panic!("{driver}: register of a text that does not hash to its declared hash: {other:?}, want CONFIG"),
    }
    let sent = SENT.load(Ordering::SeqCst) - before;
    assert_eq!(sent, 0, "{driver}: register sent {sent} statements");
    let before = SENT.load(Ordering::SeqCst);
    schema.empty().await.or_panic(|e| format!("{driver}: empty: {e}"));
    assert!(SENT.load(Ordering::SeqCst) > before, "{driver}: the logger counted no statement of empty()");
    db.close().await;

    let before = SENT.load(Ordering::SeqCst);
    Db::connect(dsn, 2, Config::default()).await.or_panic(|e| format!("{driver}: connect: {e}")).close().await;
    let connect_sent = SENT.load(Ordering::SeqCst) - before;
    let before = SENT.load(Ordering::SeqCst);
    Db::connect_schema(dsn, member, 2, Config::default()).await.or_panic(|e| format!("{driver}: connect with the schema: {e}")).close().await;
    let sent = SENT.load(Ordering::SeqCst) - before;
    assert_eq!(sent, connect_sent, "{driver}: connect_schema sent {sent} statements, connect {connect_sent}; registering must send none");
}

#[tokio::test]
async fn register_sends_no_statement() {
    // Requirements: DBS-119, SCH-11, INT-54.
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
