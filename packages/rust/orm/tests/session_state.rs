//! The session state of a transaction ends with the transaction (docs/spec/config.md CFG-30), on SQLite, MySQL and
//! PostgreSQL, as packages/ts/tests/session_state.mjs runs it. A transaction on a connection with one pooled connection
//! takes the named lock of utils().lock, sets a local value with utils().set_local and commits. After it the same server
//! session holds no value: PostgreSQL has no setting ormtest.session and MySQL no user variable orm.ormtest.session,
//! which a statement on that one pooled connection reads, and another connection takes the same lock. SQLite has no
//! session setting, so it checks the lock alone. Each case runs in a case database of its own
//! (polyspec-orm-case-database); the test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.
// Requirements: CFG-30, INT-50, INT-51.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use polyspec_orm::db::Pool;
use polyspec_orm::Db;
use polyspec_orm_case_database::CaseDatabase;

async fn session_state_ends_with_transaction(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let key = format!("orm_test.session.{}", std::process::id());
    let db = Db::connect(database.dsn(), 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
    let other = Db::connect(database.dsn(), 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
    db.transaction(async || {
        db.utils().lock(&key).await?;
        db.utils().set_local("ormtest.session", "kept").await?;
        assert_eq!(db.utils().local("ormtest.session")?, "kept", "{driver}: the transaction reads its local value");
        Ok(())
    })
    .retry(0)
    .await
    .or_panic(|e| format!("{driver}: first transaction: {e}"));
    let leftover: Option<String> = match db.pool() {
        Pool::Postgres(pool) => {
            sqlx::query_scalar("SELECT current_setting('ormtest.session', true)").fetch_one(pool).await.or_panic(|e| format!("{driver}: {e}"))
        }
        Pool::MySql(pool) => sqlx::query_scalar("SELECT @`orm.ormtest.session`").fetch_one(pool).await.or_panic(|e| format!("{driver}: {e}")),
        _ => None,
    };
    assert!(leftover.as_deref().is_none_or(str::is_empty), "{driver}: the session keeps the local value of the committed transaction: {leftover:?}");
    other.transaction(async || other.utils().lock(&key).await).retry(0).await.or_panic(|e| format!("{driver}: the lock after the transaction: {e}"));
    other.close().await;
    db.close().await;
    database.drop().await;
}

#[tokio::test]
async fn session_state_ends_with_transaction_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    session_state_ends_with_transaction("sqlite").await;
}

#[tokio::test]
async fn session_state_ends_with_transaction_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    session_state_ends_with_transaction("mysql").await;
}

#[tokio::test]
async fn session_state_ends_with_transaction_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    session_state_ends_with_transaction("postgres").await;
}
