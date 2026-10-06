use polyspec_orm_build::{
    catalog::{CatalogConnection, RowSnapshot, TableRef},
    tool_db::{self, GridCell},
};
fn quote(value: &str, dialect: &str) -> String {
    let mark = if dialect == "mysql" { '`' } else { '"' };
    format!("{mark}{}{mark}", value.replace(mark, &format!("{mark}{mark}")))
}
#[tokio::test]
async fn qualified_table_pages_preserve_columns_key_order_and_bounds() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("table page deadline");
}
async fn check() {
    let path = std::env::temp_dir().join(format!("orm-table-page-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN"),
        };
        let (database, mut seed, _) = tool_db::open(&dsn).await.expect("fixture connection");
        let name = format!("orm_table_page_{}_\"'", std::process::id());
        let sql_name = quote(&name, dialect);
        let note = "note\"';--";
        let sql_note = quote(note, dialect);
        seed.exec(
            &format!(
                "CREATE TABLE {sql_name}(a BIGINT NOT NULL,b BIGINT NOT NULL,{sql_note} VARCHAR(50),g BIGINT GENERATED ALWAYS AS (a+1) STORED,PRIMARY KEY(b,a))"
            ),
            &[],
        )
        .await
        .expect("owned fixture table");
        seed.exec(&format!("INSERT INTO {sql_name}(a,b,{sql_note}) VALUES(1,3,'first'),(2,1,'second'),(3,2,'third')"), &[]).await.expect("owned fixture rows");
        let mut catalog = CatalogConnection::connect(&dsn).await.expect("catalog connection");
        let namespace = catalog.current_namespace().await.expect("selected namespace");
        let table = TableRef { namespace, name: name.clone() };
        let page = catalog.table_page(&table, 2, 0).await.expect("first page");
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let baseline = RowSnapshot::from_page(&page, 0).expect("owned original row baseline");
        let current = polyspec_orm_build::tool_db::GridQueryResult { columns: page.result.columns.clone(), rows: vec![page.result.rows[0].clone()] };
        baseline.check_current(&page.metadata, &current).expect("unchanged original row");
        seed.exec(&format!("UPDATE {sql_name} SET {sql_note}='changed' WHERE a=2 AND b=1"), &[]).await.expect("change only owned fixture row");
        let changed = catalog.table_page(&table, 1, 0).await.expect("changed owned row");
        let assignments = vec![(note.to_owned(), GridCell::Text("changed".into()))];
        if baseline.check_updated(&changed.metadata, &changed.result, &assignments).is_err() {
            failures.push("row-update-exact");
        }
        if !baseline.check_updated(&page.metadata, &current, &assignments).is_err_and(|error| error.starts_with("ROW_WRITE_MISMATCH")) {
            failures.push("row-update-mismatch");
        }
        if !baseline.check_current(&changed.metadata, &changed.result).is_err_and(|error| error.starts_with("ROW_CONFLICT")) {
            failures.push("row-baseline-conflict");
        }
        seed.exec(&format!("UPDATE {sql_name} SET {sql_note}='second' WHERE a=2 AND b=1"), &[]).await.expect("restore owned fixture baseline");
        let restored = catalog.table_page(&table, 1, 0).await.expect("restored owned row");
        baseline.check_current(&restored.metadata, &restored.result).expect("restored original values");
        let phases = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = phases.clone();
        let publish: std::sync::Arc<dyn Fn(polyspec_orm_build::catalog::MutationPhase) + Send + Sync> =
            std::sync::Arc::new(move |phase| captured.lock().unwrap().push(phase));
        let changed = catalog
            .update_row(
                &baseline,
                &[("a".into(), tool_db::P::I(4)), (note.to_owned(), tool_db::P::S("typed change".into()))],
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                publish.clone(),
                std::sync::Arc::new(|| Ok(())),
            )
            .await
            .expect("quoted composite-key update");
        assert_eq!(changed.rows[0], vec![GridCell::Integer(4), GridCell::Integer(1), GridCell::Text("typed change".into()), GridCell::Integer(5)]);
        let page_after = catalog.table_page(&table, 1, 0).await.unwrap();
        let changed_baseline = RowSnapshot::from_page(&page_after, 0).unwrap();
        catalog
            .update_row(
                &changed_baseline,
                &[("a".into(), tool_db::P::I(2)), (note.to_owned(), tool_db::P::S("second".into()))],
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                publish,
                std::sync::Arc::new(|| Ok(())),
            )
            .await
            .expect("restore only owned composite row");
        assert_eq!(phases.lock().unwrap().last(), Some(&polyspec_orm_build::catalog::MutationPhase::Committed));
        polyspec_orm_testcase::step(format_args!("{dialect} finished"));
        if page.limit != 2
            || page.offset != 0
            || !page.has_more
            || page.order_by != vec!["b", "a"]
            || page.result.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>() != vec!["a", "b", note, "g"]
            || page.result.rows.len() != 2
            || page.result.rows[0][0] != GridCell::Integer(2)
            || page.result.rows[1][0] != GridCell::Integer(3)
        {
            failures.push(dialect);
        }
        let next = catalog.table_page(&table, 2, 2).await.expect("second page");
        if next.has_more || next.result.rows.len() != 1 || next.result.rows[0][0] != GridCell::Integer(1) {
            failures.push("next-page");
        }
        let empty = catalog.table_page(&table, 2, 3).await.expect("empty page");
        if !empty.result.rows.is_empty() || empty.has_more || empty.result.columns.len() != 4 {
            failures.push("empty-page");
        }
        let view = format!("{name}_view");
        let sql_view = quote(&view, dialect);
        seed.exec(&format!("CREATE VIEW {sql_view} AS SELECT a,b FROM {sql_name}"), &[]).await.expect("owned view");
        let view_page = catalog.table_page(&TableRef { namespace: table.namespace.clone(), name: view }, 2, 0).await.expect("view page");
        if !view_page.order_by.is_empty() || view_page.metadata.reliable_row_identity || view_page.result.rows.len() != 2 || !view_page.has_more {
            failures.push("view-page");
        }
        seed.exec(&format!("DROP VIEW {sql_view}"), &[]).await.expect("remove owned view");
        if catalog.table_page(&TableRef { namespace: table.namespace.clone(), name: "missing' OR '1'='1".into() }, 1, 0).await.is_ok() {
            failures.push("missing-name");
        }
        let large = format!("orm_table_page_large_{}", std::process::id());
        let large_type = if dialect == "mysql" { "LONGTEXT" } else { "TEXT" };
        seed.exec(&format!("CREATE TABLE {large}(note {large_type})"), &[]).await.expect("owned budget table");
        let insert = if dialect == "postgres" { format!("INSERT INTO {large} VALUES($1)") } else { format!("INSERT INTO {large} VALUES(?)") };
        seed.exec(&insert, &[tool_db::s(&"x".repeat(8 * 1024 * 1024))]).await.expect("owned budget row");
        match catalog.table_page(&TableRef { namespace: table.namespace.clone(), name: large.clone() }, 1, 0).await {
            Err(error) if error.contains("TOOL_QUERY_LIMIT") => {}
            _ => failures.push("byte-budget"),
        }
        let recovery = catalog.table_page(&table, 2, 0).await.expect("recovered page");
        if recovery.result.rows.len() != 2 || !recovery.has_more {
            failures.push("read-only-cleanup");
        }
        seed.exec(&format!("DROP TABLE {large}"), &[]).await.expect("remove owned budget table");
        for (limit, offset) in [(0, 0), (1001, 0), (1, 1000001)] {
            if catalog.table_page(&table, limit, offset).await.is_ok() {
                failures.push("page-bounds");
            }
        }
        catalog.close().await;
        seed.exec(&format!("DROP TABLE {sql_name}"), &[]).await.expect("remove owned fixture");
        drop(seed);
        database.close().await;
        polyspec_orm_testcase::step(format_args!("{dialect} finished"));
    }
    std::fs::remove_file(path).expect("remove owned SQLite fixture");
    assert!(failures.is_empty(), "table page cases failed: {failures:?}");
}
