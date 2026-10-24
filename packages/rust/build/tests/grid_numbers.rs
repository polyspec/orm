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
// Requirements: INT-102.
async fn grid_numbers_preserve_native_bits_and_unsigned_range() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    physical_fixture::within(30, "grid numeric deadline", check()).await;
}
async fn check() {
    let failures = for_physical_dialects!("grid-numbers", |dialect, dsn, failures| {
        let (database, mut catalog) = open_catalog(&dsn).await;
        let sql = match dialect {
            "postgres" => "SELECT 1.5::double precision",
            "mysql" => "SELECT CAST(1.5 AS DOUBLE)",
            _ => "SELECT 1.5",
        };
        match catalog.read_only_grid_query(sql, &[], QueryLimits::default()).await {
            Ok(result) if result.rows == vec![vec![GridCell::Float64(1.5f64.to_bits())]] => {}
            _ => failures.push("float64"),
        }
        if !grid_open::query_limit(&mut catalog, sql, QueryLimits { max_rows: 1, max_bytes: 2 }).await {
            failures.push("numeric-byte-budget");
        }
        let null_sql = match dialect {
            "postgres" => "SELECT NULL::double precision",
            "mysql" => "SELECT CAST(NULL AS DOUBLE)",
            _ => "SELECT CAST(NULL AS REAL)",
        };
        match catalog.read_only_grid_query(null_sql, &[], QueryLimits::default()).await {
            Ok(result) if result.rows == vec![vec![GridCell::Null]] => {}
            _ => failures.push("numeric-null"),
        }
        if dialect == "mysql" {
            match catalog.read_only_grid_query("SELECT CAST(18446744073709551615 AS UNSIGNED)", &[], QueryLimits::default()).await {
                Ok(result) if result.rows == vec![vec![GridCell::Unsigned(u64::MAX)]] => {}
                _ => failures.push("unsigned-range"),
            }
            if !catalog
                .read_only_query("SELECT CAST(18446744073709551615 AS UNSIGNED)", &[], QueryLimits::default())
                .await
                .is_err_and(|error| error.to_string().contains("number too large to fit in target type"))
            {
                failures.push("unsigned-legacy-conversion-cause");
            }
        }
        if dialect == "postgres" {
            match catalog.read_only_grid_query("SELECT 1.5::real, '-0'::double precision, 'NaN'::double precision", &[], QueryLimits::default()).await {
                Ok(result) if matches!(result.rows[0].as_slice(), [GridCell::Float32(bits), GridCell::Float64(zero), GridCell::Float64(nan)] if *bits == 1.5f32.to_bits() && *zero == (-0.0f64).to_bits() && f64::from_bits(*nan).is_nan()) =>
                    {}
                _ => failures.push("float-width-specials"),
            }
        }
        grid_open::finish_catalog(database, catalog, dialect).await;
    });
    assert!(failures.is_empty(), "grid numeric cases failed: {failures:?}");
}
