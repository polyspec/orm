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
// Requirements: INT-97.
async fn finite_grid_decimals_preserve_precision_and_scale() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    physical_fixture::within(30, "grid decimal deadline", check()).await;
}
async fn check() {
    let failures = for_physical_dialects!("grid-decimals", |dialect, dsn, failures| {
        let (database, mut catalog) = open_catalog(&dsn).await;
        let large = "123456789012345678901234567890123456789012345678901234567890123.45";
        let (sql, expected) = match dialect {
            "mysql" => (
                format!("SELECT CAST('{large}' AS DECIMAL(65,2)), CAST('100.23000' AS DECIMAL(10,5)), CAST('0.00000' AS DECIMAL(10,5))"),
                vec![GridCell::Decimal(large.into()), GridCell::Decimal("100.23000".into()), GridCell::Decimal("0.00000".into())],
            ),
            "postgres" => (
                format!("SELECT '{large}'::numeric(65,2), '100.23000'::numeric(10,5), '0.00000'::numeric(10,5)"),
                vec![GridCell::Decimal(large.into()), GridCell::Decimal("100.23000".into()), GridCell::Decimal("0.00000".into())],
            ),
            _ => (format!("SELECT '{large}', 123, 1.5"), vec![GridCell::Text(large.into()), GridCell::Integer(123), GridCell::Float64(1.5f64.to_bits())]),
        };
        match catalog.read_only_grid_query(&sql, &[], QueryLimits::default()).await {
            Ok(result) if result.rows == vec![expected] => {}
            _ => failures.push(dialect),
        }
        if !grid_open::query_limit(&mut catalog, &sql, QueryLimits { max_rows: 1, max_bytes: 2 }).await {
            failures.push("decimal-budget")
        }
        let null_sql = match dialect {
            "mysql" => "SELECT CAST(NULL AS DECIMAL(10,5))",
            "postgres" => "SELECT NULL::numeric(10,5)",
            _ => "SELECT NULL",
        };
        match catalog.read_only_grid_query(null_sql, &[], QueryLimits::default()).await {
            Ok(result) if result.rows == vec![vec![GridCell::Null]] => {}
            _ => failures.push("decimal-null"),
        }
        if dialect == "postgres" {
            let huge = "9".repeat(200);
            let sql = format!("SELECT '{huge}'::numeric, '1e-20'::numeric");
            match catalog.read_only_grid_query(&sql, &[], QueryLimits::default()).await {
                Ok(result) if result.rows == vec![vec![GridCell::Decimal(huge), GridCell::Decimal("0.00000000000000000001".into())]] => {}
                _ => failures.push("large-numeric"),
            }
            if !catalog
                .read_only_grid_query("SELECT 'NaN'::numeric", &[], QueryLimits::default())
                .await
                .is_err_and(|error| error.contains("Unsupported or invalid finite grid decimal: ") && error.contains("NaN"))
            {
                failures.push("nonfinite-numeric-cause")
            }
        }
        grid_open::finish_catalog(database, catalog, dialect).await;
    });
    assert!(failures.is_empty(), "decimal cases failed: {failures:?}");
}
