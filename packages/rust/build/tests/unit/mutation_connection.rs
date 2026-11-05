use crate::catalog::{CatalogConnection, MutationPhase, TableRef};
use crate::tool_db::{Conn, P};
use std::sync::{atomic::AtomicBool, Arc};

/// Inserts the row `id` with no hook that stops it.
async fn insert(catalog: &CatalogConnection, declared: &crate::catalog::TableMetadata, id: i64) -> Result<(), String> {
    catalog
        .insert_row(declared, &[("id".to_owned(), P::I(id))], Arc::new(AtomicBool::new(false)), Arc::new(|_: MutationPhase| {}), Arc::new(|| Ok(())))
        .await
        .map(drop)
}

/// Inserts rows and reads which server connection wrote each, through a column whose default is the id of that connection.
async fn writers(dsn: &str, create: &str, table: &str) -> Vec<Vec<crate::tool_db::Val>> {
    let mut catalog = CatalogConnection::connect(dsn).await.unwrap();
    let namespace = catalog.current_namespace().await.unwrap();
    let pool = catalog.pool.clone();
    let mut admin = Conn::acquire(&pool).await.unwrap();
    admin.exec(&format!("DROP TABLE IF EXISTS {table}"), &[]).await.unwrap();
    admin.exec(create, &[]).await.unwrap();
    admin.discard_on_drop();
    drop(admin);
    let declared = catalog.describe_table(&TableRef { namespace, name: table.to_owned() }).await.unwrap();
    for id in 1..=5 {
        insert(&catalog, &declared, id).await.unwrap();
    }
    // A refused insert rolls back and discards its connection, and the next one still writes in a transaction of its own.
    let refused = insert(&catalog, &declared, 1).await.unwrap_err();
    assert!(refused.contains("ROW_CONFLICT"), "{refused}");
    insert(&catalog, &declared, 7).await.unwrap();
    let mut read = Conn::acquire(&pool).await.unwrap();
    let committed = read.query(&format!("SELECT id FROM {table}"), &[]).await.unwrap();
    assert_eq!(committed.len(), 6, "the committed rows");
    let rows = read.query(&format!("SELECT backend FROM {table} WHERE id < 7"), &[]).await.unwrap();
    read.exec(&format!("DROP TABLE {table}"), &[]).await.unwrap();
    read.discard_on_drop();
    drop(read);
    catalog.close().await;
    rows
}

#[tokio::test]
// Requirements: INT-106b.
// Runtime-unique (FCV-14): which connection a mutation takes is a choice of each runtime's pool, and the spec names only its fresh transaction.
async fn committed_mutations_of_a_catalog_share_one_connection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let table = format!("orm_mutation_connection_{}", std::process::id());
    let postgres = std::env::var("ORM_TOOLS_POSTGRES_DSN").unwrap();
    let create = format!("CREATE TABLE {table}(id BIGINT PRIMARY KEY, backend INTEGER NOT NULL DEFAULT pg_backend_pid())");
    let written = writers(&postgres, &create, &table).await;
    assert_eq!(written.len(), 5);
    assert!(written.iter().all(|writer| *writer == written[0]), "postgres writers: {written:?}");
    let mysql = std::env::var("ORM_TOOLS_MYSQL_DSN").unwrap();
    let create = format!("CREATE TABLE {table}(id BIGINT PRIMARY KEY, backend BIGINT NOT NULL DEFAULT (CONNECTION_ID())) ENGINE=InnoDB");
    let written = writers(&mysql, &create, &table).await;
    assert_eq!(written.len(), 5);
    assert!(written.iter().all(|writer| *writer == written[0]), "mysql writers: {written:?}");
}
