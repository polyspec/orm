//! The database and DSN that feature-check chose, and the coverage case's deadline and progress output.
//! feature-check gives ORM_FEATURE_DATABASE and ORM_FEATURE_DSN, and runs each coverage test by its exact name on the seeded bench
//! database.
use polyspec_orm_testcase::OrPanic;

use polyspec_orm::Db;
use std::future::Future;
use std::time::{Duration, Instant};

/// The deadline of one database case. It is measured in wall-clock time because it limits what the database does.
const DEADLINE: Duration = Duration::from_secs(300);

/// Connects with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN. Fails if either is missing, or if the DSN
/// selects a different database.
pub async fn connect() -> Db {
    let driver = std::env::var("ORM_FEATURE_DATABASE")
        .expect("ORM_FEATURE_DATABASE is required; run it through make feature-check, which sets it for each coverage case");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required; run it through make feature-check, which sets it for each coverage case");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()), "ORM_FEATURE_DATABASE {driver:?} is not mysql, postgres or sqlite");
    let config = polyspec_orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
    let db = super::model::connect(&dsn, 2, config).await.or_panic(|e| format!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    db
}

/// Runs `body` within the deadline and prints its start, success, and elapsed time.
pub async fn run<F: Future<Output = ()>>(case: &str, body: F) {
    let started = Instant::now();
    polyspec_orm_testcase::step(format_args!("start {case}"));
    if tokio::time::timeout(DEADLINE, body).await.is_err() {
        panic!("{case}: not finished within {DEADLINE:?}");
    }
    polyspec_orm_testcase::step(format_args!("{case} {:?}", started.elapsed()));
}

/// The error code of the result. Success is "ok".
pub fn code<T>(r: polyspec_orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}
