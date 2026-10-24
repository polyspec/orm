use super::{Db, Executor};
use crate::plan::Step;

#[tokio::test]
async fn query_and_execute_share_pool_and_transaction_routing() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let db = Db::connect("sqlite::memory:", 1, crate::Config::default()).await.expect("connect to SQLite memory database");

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
}
