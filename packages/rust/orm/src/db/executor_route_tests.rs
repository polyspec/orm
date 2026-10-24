use super::{Db, Executor};
use crate::plan::Step;
use crate::test_support::Scratch;

#[tokio::test]
async fn query_and_execute_share_pool_and_transaction_routing() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-executor-route");
    let dsn = format!("sqlite://{}", scratch.join("route.sqlite").display());
    let db = Db::connect(&dsn, 1, crate::Config::default()).await.expect("connect to SQLite test database");

    let create = Step { sql: "CREATE TABLE route_probe (value INTEGER NOT NULL)".into(), ..Step::default() };
    Executor::Db(db.clone()).execute(&create, &[]).await.expect("execute through the pool");

    let standard = db
        .transaction(async || {
            let active = Executor::Tx(crate::tx::active_for(&db).expect("transaction is active"));
            let insert = Step { sql: "INSERT INTO route_probe (value) VALUES (7)".into(), ..Step::default() };
            active.execute(&insert, &[]).await?;
            let select = Step { sql: "SELECT value FROM route_probe".into(), ..Step::default() };
            let rows = active.query(&select, &[], Vec::new()).await?;
            assert_eq!(rows.len(), 1);
            Ok::<_, crate::Error>(())
        })
        .await;
    standard.expect("query and execute through the transaction");

    let select = Step { sql: "SELECT value FROM route_probe".into(), ..Step::default() };
    let rows = Executor::Db(db.clone()).query(&select, &[], Vec::new()).await.expect("query through the pool after commit");
    assert_eq!(rows.len(), 1);
    db.close().await;

    let query_error = match Executor::Db(db.clone()).query(&select, &[], Vec::new()).await {
        Ok(_) => panic!("querying a closed database must fail"),
        Err(error) => error,
    };
    assert!(matches!(query_error, crate::Error::Config(message) if message == "database is closed"));
    let execute_error = Executor::Db(db.clone()).execute(&select, &[]).await.expect_err("executing through a closed database must fail");
    assert!(matches!(execute_error, crate::Error::Config(message) if message == "database is closed"));
    let direct_execute_error = db.execute(&select, &[]).await.expect_err("direct execution on a closed database must fail");
    assert!(matches!(direct_execute_error, crate::Error::Config(message) if message == "database is closed"));
    let transaction_error = db.transaction(|| async { Ok::<_, crate::Error>(()) }).await.expect_err("starting a transaction on a closed database must fail");
    assert!(matches!(transaction_error, crate::Error::Config(message) if message == "database is closed"));
}
