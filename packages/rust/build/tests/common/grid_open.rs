//! The database and catalog of one dialect of a grid test (KSTD-5-46): the fixture opened at the DSN, its seed connection
//! dropped, and the catalog connected to the same DSN.

use polyspec_orm_build::tool_db::QueryLimits;
use polyspec_orm_build::{catalog::CatalogConnection, tool_db};

/// Opens the fixture at `dsn` and connects the catalog to it; the seed connection is dropped, as the grid tests did.
pub async fn open_catalog(dsn: &str) -> (polyspec_orm::Db, CatalogConnection) {
    let (database, seed, _) = tool_db::open(dsn).await.expect("fixture connection");
    drop(seed);
    let catalog = CatalogConnection::connect(dsn).await.expect("catalog connection");
    (database, catalog)
}

/// Closes the catalog and its database, then records completion for the dialect.
pub async fn finish_catalog(database: polyspec_orm::Db, catalog: CatalogConnection, dialect: &str) {
    catalog.close().await;
    super::physical_fixture::finish_physical_dialect(database, (), dialect, "finished").await;
}

/// Checks that a grid query refusal reports the shared size-limit code.
pub async fn query_limit(catalog: &mut CatalogConnection, sql: &str, limits: QueryLimits) -> bool {
    catalog.read_only_grid_query(sql, &[], limits).await.err().is_some_and(|error| error.contains("TOOL_QUERY_LIMIT"))
}
