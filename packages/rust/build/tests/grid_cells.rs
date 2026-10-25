#[path = "common/physical_fixture.rs"]
mod physical_fixture;
#[macro_use]
#[path = "common/physical_dialects.rs"]
mod physical_dialects;

#[path = "common/grid_open.rs"]
mod grid_open;
use grid_open::open_catalog;

use polyspec_orm_build::tool_db::{GridCell, QueryLimits};

#[tokio::test]
// Requirements: SCH-3, INT-115.
async fn binary_grid_values_remain_distinct_from_text_and_null() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    physical_fixture::within(30, "grid cell deadline", check()).await;
}

async fn check() {
    let failures = for_physical_dialects!("grid-cells", |dialect, dsn, failures| {
        let (database, mut catalog) = open_catalog(&dsn).await;
        let sql = if dialect == "postgres" {
            "SELECT decode('00ff','hex'), decode('6869','hex'), decode('','hex'), 'hi', NULL"
        } else {
            "SELECT X'00FF', X'6869', X'', 'hi', NULL"
        };
        let expected =
            vec![vec![GridCell::Binary(vec![0, 255]), GridCell::Binary(b"hi".to_vec()), GridCell::Binary(vec![]), GridCell::Text("hi".into()), GridCell::Null]];
        match catalog.read_only_grid_query(sql, &[], QueryLimits::default()).await {
            Ok(result) if result.rows == expected && result.columns.len() == 5 => {}
            _ => failures.push(dialect),
        }
        if dialect == "sqlite"
            && !catalog.read_only_query("SELECT X'FF'", &[], QueryLimits::default()).await.is_err_and(|error| error.contains("invalid utf-8 sequence"))
        {
            failures.push("invalid-text-blob-cause");
        }
        let tiny = QueryLimits { max_rows: 1, max_bytes: 2 };
        if !grid_open::query_limit(&mut catalog, sql, tiny).await {
            failures.push("binary-byte-budget");
        }
        let two_rows =
            if dialect == "postgres" { "SELECT decode('ff','hex') UNION ALL SELECT decode('ff','hex')" } else { "SELECT X'FF' UNION ALL SELECT X'FF'" };
        if !grid_open::query_limit(&mut catalog, two_rows, QueryLimits { max_rows: 1, max_bytes: 1024 }).await {
            failures.push("binary-row-budget");
        }
        if !catalog
            .read_only_grid_query("DELETE FROM grid_test_should_not_exist", &[], QueryLimits::default())
            .await
            .err()
            .is_some_and(|error| error.contains("QUERY_READ_ONLY"))
        {
            failures.push("mutation-policy");
        }
        let empty_sql = format!("{sql} WHERE 1=0");
        match catalog.read_only_grid_query(&empty_sql, &[], QueryLimits::default()).await {
            Ok(result) if result.rows.is_empty() && result.columns.len() == 5 => {}
            _ => failures.push("empty-metadata"),
        }
        let bind_sql = if dialect == "postgres" { "SELECT CAST($1 AS TEXT)" } else { "SELECT ?" };
        match catalog.read_only_grid_query(bind_sql, &[polyspec_orm_build::tool_db::s("text")], QueryLimits::default()).await {
            Ok(result) if result.rows == vec![vec![GridCell::Text("text".into())]] => {}
            _ => failures.push("bound-text"),
        }
        grid_open::finish_catalog(database, catalog, dialect).await;
    });
    assert!(failures.is_empty(), "grid type cases failed: {failures:?}");
}
