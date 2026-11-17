use super::{CatalogConnection, Conn};

use polyspec_orm_test_support::fixture_dsn::server_dsn;

// The SQLite database is a file that the test makes and removes, so every run runs it.
#[tokio::test]
// Requirements: INT-137.
async fn aborted_read_only_connections_are_not_returned_to_the_pool() {
    let _case = polyspec_orm_testcase::case!();
    let path = std::env::temp_dir().join(format!("orm-query-discard-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    let dsn = format!("sqlite://{}", path.display());
    let (db, conn, _) = crate::tool_db::open(&dsn).await.unwrap();
    drop(conn);
    db.close_async().await;
    check("sqlite", &dsn).await;
    std::fs::remove_file(path).unwrap();
}

// MySQL and PostgreSQL are the tools databases of the test servers, which ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name.
// Run by make read-only-disposal-servers-rust-check with the servers of the run.
#[tokio::test]
#[ignore = "needs the database servers of make orm-test-servers; make read-only-disposal-servers-rust-check runs it"]
// Requirements: INT-137.
async fn aborted_read_only_connections_of_a_server_are_not_returned_to_the_pool() {
    let _case = polyspec_orm_testcase::case!();
    for (dialect, variable) in [("mysql", "ORM_TOOLS_MYSQL_DSN"), ("postgres", "ORM_TOOLS_POSTGRES_DSN")] {
        check(dialect, &server_dsn(variable)).await;
    }
}

// One database: a task that holds a connection in a read-only transaction is aborted, and the next connection of the pool writes.
async fn check(dialect: &'static str, dsn: &str) {
    polyspec_orm_testcase::step(format_args!("running {dialect}"));
    let catalog = CatalogConnection::connect(dsn).await.unwrap();
    let owner = catalog;
    let table = format!("orm_readonly_discard_{}", std::process::id());
    Conn::acquire(&owner.pool).await.unwrap().exec(&format!("CREATE TABLE {table}(n INTEGER NOT NULL)"), &[]).await.unwrap();
    let pool = owner.pool.clone();
    let (ready, received) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut conn = Conn::acquire(&pool).await.unwrap();
        conn.discard_on_drop();
        if dialect == "sqlite" {
            conn.exec("PRAGMA query_only=ON", &[]).await.unwrap();
        }
        conn.exec(
            match dialect {
                "mysql" => "START TRANSACTION READ ONLY",
                "postgres" => "BEGIN READ ONLY",
                _ => "BEGIN",
            },
            &[],
        )
        .await
        .unwrap();
        ready.send(()).unwrap();
        std::future::pending::<()>().await;
        drop(conn);
    });
    received.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let mut next = Conn::acquire(&owner.pool).await.unwrap();
    let write = next.exec(&format!("INSERT INTO {table}(n) VALUES(7)"), &[]).await;
    drop(next);
    Conn::acquire(&owner.pool).await.unwrap().exec(&format!("DROP TABLE {table}"), &[]).await.unwrap();
    owner.close().await;
    assert!(write.is_ok(), "cancelled scope must not leak into a reused connection");
    polyspec_orm_testcase::step(format_args!("{dialect} passed"));
}
