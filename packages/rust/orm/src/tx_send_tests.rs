//! Owning regressions for borrowed Send callbacks and nested savepoints.
use super::*;
use std::time::{Duration, Instant};

fn require_send<T: Send>(value: T) -> T {
    value
}
fn dsn(name: &str) -> String {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => value,
        Ok(_) => panic!("declared test DSN {name} is set but empty"),
        Err(error) => panic!("declared test DSN {name} is required: {error}"),
    }
}
async fn execute(db: &Db, sql: &str) {
    let statement = sqlx::AssertSqlSafe(sql.to_owned());
    match db.pool() {
        Pool::MySql(pool) => sqlx::raw_sql(statement).execute(pool).await.map(|_| ()),
        Pool::Postgres(pool) => sqlx::raw_sql(statement).execute(pool).await.map(|_| ()),
        Pool::Sqlite(pool) => sqlx::raw_sql(statement).execute(pool).await.map(|_| ()),
        Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
    }
    .expect("test statement must succeed");
}
async fn state(db: &Db, table: &str) -> Vec<i32> {
    let sql = sqlx::AssertSqlSafe(format!("SELECT id FROM {table} ORDER BY id"));
    match db.pool() {
        Pool::MySql(pool) => sqlx::query_scalar(sql).fetch_all(pool).await,
        Pool::Postgres(pool) => sqlx::query_scalar(sql).fetch_all(pool).await,
        Pool::Sqlite(pool) => sqlx::query_scalar(sql).fetch_all(pool).await,
        Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
    }
    .expect("test state must be readable")
}
async fn behavior(driver: &str, dsn: &str) {
    let db = Db::connect(dsn, 1, crate::Config::default()).await.expect("declared database must connect");
    // This is a table with a name unique to this run. A transaction pooler (PgBouncer) keeps a temporary table on the server session rather than the client connection, and
    // the next run may get a different session, so
    // no temporary table is used. It is dropped at the end.
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock after the epoch").as_nanos();
    let table = format!("orm_send_savepoint_probe_{}_{nanos}", std::process::id());
    let table = table.as_str();
    execute(&db, &format!("CREATE TABLE {table} (id INTEGER PRIMARY KEY)")).await;
    assert!(state(&db, table).await.is_empty(), "{driver}: initial fixture state");
    require_send(
        db.transaction_send(|| async {
            let tx = active_for(&db).expect("active outer transaction");
            tx.raw(KIND_UTILITY, &format!("INSERT INTO {table} (id) VALUES (1)")).await?;
            let callback = || Box::pin(async { Ok::<_, Error>(17) }) as Pin<Box<dyn Future<Output = Result<i32>> + Send>>;
            let borrowed: &SendOperation<'_, i32> = &callback;
            assert_eq!(require_send(savepoint_send(tx.clone(), borrowed)).await?, 17);
            db.transaction_send(|| async {
                active_for(&db).expect("nested commit frame").raw(KIND_UTILITY, &format!("INSERT INTO {table} (id) VALUES (2)")).await
            })
            .retry(0)
            .await?;
            let rejected = db
                .transaction_send(|| async {
                    active_for(&db).expect("nested rollback frame").raw(KIND_UTILITY, &format!("INSERT INTO {table} (id) VALUES (3)")).await?;
                    Err::<(), _>(Error::Config("owned nested rejection".into()))
                })
                .retry(0)
                .await;
            assert!(matches!(rejected,Err(Error::Config(ref text)) if text=="owned nested rejection"), "{driver}: callback error preserved");
            assert!(Arc::ptr_eq(&tx, &active_for(&db).expect("outer frame restored")));
            tx.raw(KIND_UTILITY, &format!("INSERT INTO {table} (id) VALUES (4)")).await
        })
        .retry(0)
        .into_future(),
    )
    .await
    .expect("outer commit must succeed");
    assert_eq!(state(&db, table).await, [1, 2, 4], "{driver}: nested rollback preserves outer writes");
    let rejected = require_send(
        db.transaction_send(|| async {
            active_for(&db).expect("outer rollback frame").raw(KIND_UTILITY, &format!("INSERT INTO {table} (id) VALUES (5)")).await?;
            db.transaction_send(|| async {
                active_for(&db).expect("nested commit before outer rollback").raw(KIND_UTILITY, &format!("INSERT INTO {table} (id) VALUES (6)")).await
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
    assert_eq!(state(&db, table).await, [1, 2, 4], "{driver}: outer rollback includes released nested savepoint");
    assert!(active_for(&db).is_none(), "{driver}: transaction frame removed");
    db.transaction_send(|| async { Ok::<_, Error>(()) }).retry(0).await.expect("connection remains usable");
    // The transaction_once future is Send if the callback and its future are Send.
    require_send(
        db.transaction_once(async || active_for(&db).expect("once frame").raw(KIND_UTILITY, &format!("INSERT INTO {table} (id) VALUES (7)")).await)
            .into_future(),
    )
    .await
    .expect("once commit must succeed");
    assert_eq!(state(&db, table).await, [1, 2, 4, 7], "{driver}: transaction_once commits");
    // Even when audit values are set, the transaction_send and transaction_once futures are Send. This connection has no audit default
    // , so both are CONFIG before they start.
    let send = require_send(db.transaction_send(|| async { Ok::<_, Error>(()) }).audit([("actor", "send")]).retry(0).into_future()).await;
    assert!(matches!(send, Err(Error::Config(_))), "{driver}: transaction_send audit without defaults: {:?}", send.err());
    let once = require_send(db.transaction_once(async || Ok::<_, Error>(())).audit([("actor", "once")]).into_future()).await;
    assert!(matches!(once, Err(TransactionOnceError::Orm(Error::Config(_)))), "{driver}: transaction_once audit without defaults: {once:?}");
    assert_eq!(state(&db, table).await, [1, 2, 4, 7], "{driver}: the audit transactions wrote nothing");
    execute(&db, &format!("DROP TABLE {table}")).await;
    db.close().await;
}
async fn check(driver: &str, key: &str) {
    let started = Instant::now();
    polyspec_orm_testcase::step(format_args!("start send_savepoint {driver}"));
    tokio::time::timeout(Duration::from_secs(10), behavior(driver, &dsn(key))).await.expect("individual savepoint test deadline");
    polyspec_orm_testcase::step(format_args!("send_savepoint {driver} {:?}", started.elapsed()));
}
#[tokio::test]
// Requirements: DSL-119.
async fn mysql_send_savepoint() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    check("mysql", "ORM_TEST_MYSQL_DSN").await;
}
#[tokio::test]
// Requirements: DSL-119.
async fn postgres_send_savepoint() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    check("postgres", "ORM_TEST_POSTGRES_DSN").await;
}
#[tokio::test]
// Requirements: DSL-119.
async fn sqlite_send_savepoint() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    check("sqlite", "ORM_SEND_SQLITE_DSN").await;
}
