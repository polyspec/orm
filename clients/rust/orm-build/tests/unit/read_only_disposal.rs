use super::{CatalogConnection, Conn};

#[tokio::test]
async fn aborted_read_only_connections_are_not_returned_to_the_pool() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("read-only disposal deadline");
}
async fn check() {
    let path = std::env::temp_dir().join(format!("orm-query-discard-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").unwrap(),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").unwrap(),
        };
        if dialect == "sqlite" {
            let (db, conn, _) = crate::tool_db::open(&dsn).await.unwrap();
            drop(conn);
            db.close().await;
        }
        let catalog = CatalogConnection::connect(&dsn).await.unwrap();
        let mut owner = catalog;
        let table = format!("orm_readonly_discard_{}", std::process::id());
        owner.connection.exec(&format!("CREATE TABLE {table}(n INTEGER NOT NULL)"), &[]).await.unwrap();
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
        owner.connection.exec(&format!("DROP TABLE {table}"), &[]).await.unwrap();
        owner.close().await;
        assert!(write.is_ok(), "cancelled scope must not leak into a reused connection");
        polyspec_orm_testcase::step(format_args!("{dialect} passed"));
    }
    std::fs::remove_file(path).unwrap();
}
