#[path = "common/physical_fixture.rs"]
mod physical_fixture;
#[macro_use]
#[path = "common/physical_dialects.rs"]
mod physical_dialects;

#[path = "common/grid_open.rs"]
mod grid_open;
use grid_open::open_catalog;

use polyspec_orm_build::tool_db::QueryLimits;

#[tokio::test]
// Requirements: INT-102a.
// Runtime-unique (FCV-14): the text of the cause is the one of the Rust driver.
async fn plain_query_keeps_the_driver_cause_of_an_unsigned_value() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    physical_fixture::within(30, "plain unsigned deadline", check()).await;
}
async fn check() {
    let failures = for_physical_dialects!("grid-numbers", |dialect, dsn, failures| {
        let (database, mut catalog) = open_catalog(&dsn).await;
        if dialect == "mysql"
            && !catalog
                .read_only_query("SELECT CAST(18446744073709551615 AS UNSIGNED)", &[], QueryLimits::default())
                .await
                .is_err_and(|error| error.to_string().contains("number too large to fit in target type"))
        {
            failures.push("unsigned-legacy-conversion-cause");
        }
        grid_open::finish_catalog(database, catalog, dialect).await;
    });
    assert!(failures.is_empty(), "plain unsigned cases failed: {failures:?}");
}
