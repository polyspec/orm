//! feature-check가 고른 database와 DSN, 그리고 coverage case의 기한과 진행 출력.
//! feature-check는 ORM_FEATURE_DATABASE와 ORM_FEATURE_DSN을 주고 시드된 bench
//! database에서 ignored coverage test를 --include-ignored로 실행한다.
use orm::Db;
use std::future::Future;
use std::time::{Duration, Instant};

/// 한 database case의 기한. database가 하는 일을 제한하므로 wall-clock 시간으로 잰다.
const DEADLINE: Duration = Duration::from_secs(300);

/// ORM_FEATURE_DATABASE와 ORM_FEATURE_DSN으로 연결한다. 둘 중 하나가 없거나 DSN이
/// 다른 database를 고르면 실패한다.
pub async fn connect() -> Db {
    let driver = std::env::var("ORM_FEATURE_DATABASE").expect("ORM_FEATURE_DATABASE is required");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()), "ORM_FEATURE_DATABASE {driver:?} is not mysql, postgres or sqlite");
    let config = orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
    let db = super::model::connect(&dsn, 2, config).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    db
}

/// `body`를 기한 안에서 실행하고 시작, 성공, 걸린 시간을 출력한다.
pub async fn run<F: Future<Output = ()>>(case: &str, body: F) {
    let started = Instant::now();
    orm_testcase::step(format_args!("start {case}"));
    if tokio::time::timeout(DEADLINE, body).await.is_err() {
        panic!("{case}: not finished within {DEADLINE:?}");
    }
    orm_testcase::step(format_args!("{case} {:?}", started.elapsed()));
}

/// 결과의 error code. 성공은 "ok"다.
pub fn code<T>(r: orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}
