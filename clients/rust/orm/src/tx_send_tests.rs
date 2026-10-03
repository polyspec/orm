//! Owning regressions for borrowed Send callbacks and nested savepoints.
use super::*;
use std::time::{Duration, Instant};

fn require_send<T: Send>(value: T) -> T {
    value
}
fn dsn(name: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).expect("declared test DSN is required")
}
async fn execute(db: &Db, sql: &str) {
    let statement = sqlx::AssertSqlSafe(sql.to_owned());
    match db.pool() {
        Pool::MySql(pool) => sqlx::raw_sql(statement).execute(pool).await.map(|_| ()),
        Pool::Postgres(pool) => sqlx::raw_sql(statement).execute(pool).await.map(|_| ()),
        Pool::Sqlite(pool) => sqlx::raw_sql(statement).execute(pool).await.map(|_| ()),
    }
    .expect("test statement must succeed");
}
async fn state(db: &Db) -> Vec<i32> {
    const SQL: &str = "SELECT id FROM orm_send_savepoint_probe ORDER BY id";
    match db.pool() {
        Pool::MySql(pool) => sqlx::query_scalar(SQL).fetch_all(pool).await,
        Pool::Postgres(pool) => sqlx::query_scalar(SQL).fetch_all(pool).await,
        Pool::Sqlite(pool) => sqlx::query_scalar(SQL).fetch_all(pool).await,
    }
    .expect("test state must be readable")
}
async fn behavior(driver: &str, dsn: &str) {
    let db = Db::connect(dsn, 1, crate::Config::default()).await.expect("declared database must connect");
    // Connection-local fixture: closing the sole connection removes it, including
    // after a failure. No user tables or persisted database rows are modified.
    execute(&db, "CREATE TEMPORARY TABLE orm_send_savepoint_probe (id INTEGER PRIMARY KEY)").await;
    assert!(state(&db).await.is_empty(), "{driver}: initial fixture state");
    require_send(
        db.transaction_send(|| async {
            let tx = active_for(&db).expect("active outer transaction");
            tx.raw("INSERT INTO orm_send_savepoint_probe (id) VALUES (1)").await?;
            let callback = || Box::pin(async { Ok::<_, Error>(17) }) as Pin<Box<dyn Future<Output = Result<i32>> + Send>>;
            let borrowed: &SendOperation<'_, i32> = &callback;
            assert_eq!(require_send(savepoint_send(tx.clone(), borrowed)).await?, 17);
            db.transaction_send(|| async { active_for(&db).expect("nested commit frame").raw("INSERT INTO orm_send_savepoint_probe (id) VALUES (2)").await })
                .retry(0)
                .await?;
            let rejected = db
                .transaction_send(|| async {
                    active_for(&db).expect("nested rollback frame").raw("INSERT INTO orm_send_savepoint_probe (id) VALUES (3)").await?;
                    Err::<(), _>(Error::Config("owned nested rejection".into()))
                })
                .retry(0)
                .await;
            assert!(matches!(rejected,Err(Error::Config(ref text)) if text=="owned nested rejection"), "{driver}: callback error preserved");
            assert!(Arc::ptr_eq(&tx, &active_for(&db).expect("outer frame restored")));
            tx.raw("INSERT INTO orm_send_savepoint_probe (id) VALUES (4)").await
        })
        .retry(0)
        .into_future(),
    )
    .await
    .expect("outer commit must succeed");
    assert_eq!(state(&db).await, [1, 2, 4], "{driver}: nested rollback preserves outer writes");
    let rejected = require_send(
        db.transaction_send(|| async {
            active_for(&db).expect("outer rollback frame").raw("INSERT INTO orm_send_savepoint_probe (id) VALUES (5)").await?;
            db.transaction_send(|| async {
                active_for(&db).expect("nested commit before outer rollback").raw("INSERT INTO orm_send_savepoint_probe (id) VALUES (6)").await
            })
            .retry(0)
            .await?;
            Err::<(), _>(Error::Config("owned outer rejection".into()))
        })
        .retry(0)
        .into_future(),
    )
    .await;
    assert!(matches!(rejected,Err(Error::Config(ref text)) if text=="owned outer rejection"), "{driver}: outer error preserved");
    assert_eq!(state(&db).await, [1, 2, 4], "{driver}: outer rollback includes released nested savepoint");
    assert!(active_for(&db).is_none(), "{driver}: transaction frame removed");
    db.transaction_send(|| async { Ok::<_, Error>(()) }).retry(0).await.expect("connection remains usable");
    // transaction_once의 future는 callback과 그 future가 Send이면 Send다.
    require_send(
        db.transaction_once(async || active_for(&db).expect("once frame").raw("INSERT INTO orm_send_savepoint_probe (id) VALUES (7)").await).into_future(),
    )
    .await
    .expect("once commit must succeed");
    assert_eq!(state(&db).await, [1, 2, 4, 7], "{driver}: transaction_once commits");
    // audit 값을 정해도 transaction_send와 transaction_once의 future는 Send다. 이 연결에는 audit 기본값이
    // 없으므로 둘 다 시작하기 전에 CONFIG다.
    let send = require_send(db.transaction_send(|| async { Ok::<_, Error>(()) }).audit([("actor", "send")]).retry(0).into_future()).await;
    assert!(matches!(send, Err(Error::Config(_))), "{driver}: transaction_send audit without defaults: {:?}", send.err());
    let once = require_send(db.transaction_once(async || Ok::<_, Error>(())).audit([("actor", "once")]).into_future()).await;
    assert!(matches!(once, Err(TransactionOnceError::Orm(Error::Config(_)))), "{driver}: transaction_once audit without defaults: {once:?}");
    assert_eq!(state(&db).await, [1, 2, 4, 7], "{driver}: the audit transactions wrote nothing");
    db.close().await;
}
async fn check(driver: &str, key: &str) {
    let started = Instant::now();
    orm_testcase::step(format_args!("start send_savepoint {driver}"));
    tokio::time::timeout(Duration::from_secs(10), behavior(driver, &dsn(key))).await.expect("individual savepoint test deadline");
    orm_testcase::step(format_args!("send_savepoint {driver} {:?}", started.elapsed()));
}
#[tokio::test]
async fn mysql_send_savepoint() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    check("mysql", "ORM_TEST_MYSQL_DSN").await;
}
#[tokio::test]
async fn postgres_send_savepoint() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    check("postgres", "ORM_TEST_POSTGRES_DSN").await;
}
#[tokio::test]
async fn sqlite_send_savepoint() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    check("sqlite", "ORM_SEND_SQLITE_DSN").await;
}
