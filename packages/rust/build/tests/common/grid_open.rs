//! The database and catalog of one dialect of a grid test (KSTD-5-46): the fixture opened at the DSN, its seed connection
//! dropped, and the catalog connected to the same DSN.

use polyspec_orm_build::{catalog::CatalogConnection, tool_db};

/// Opens the fixture at `dsn` and connects the catalog to it; the seed connection is dropped, as the grid tests did.
pub async fn open_catalog(dsn: &str) -> (polyspec_orm::Db, CatalogConnection) {
    let (database, seed, _) = tool_db::open(dsn).await.expect("fixture connection");
    drop(seed);
    let catalog = CatalogConnection::connect(dsn).await.expect("catalog connection");
    (database, catalog)
}
