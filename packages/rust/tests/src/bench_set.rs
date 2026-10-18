//! The install of the bench set for the programs and tests of this crate: the bench set
//! (contracts/fixtures/bench/dbspec-set.json) uses the table shared_note of its external document
//! bench_shared.dbs, which must exist before the set installs (docs/dbspec.md "External documents"), so
//! the external document is installed first as its own set, as scripts/bench-db.mts does.

use polyspec_orm::dbspec;
use std::sync::LazyLock;

/// The manifest of contracts/fixtures/bench/bench_shared.dbs alone, as the set that owns it would generate it.
static SHARED_MANIFEST: LazyLock<dbspec::Manifest> = LazyLock::new(|| {
    let text = include_str!("../../../../contracts/fixtures/bench/bench_shared.dbs");
    let document = dbspec::parse(text, &Default::default()).unwrap_or_else(|e| panic!("bench_shared.dbs: {e:?}")).document;
    dbspec::manifest(&[&document]).unwrap_or_else(|e| panic!("bench_shared.dbs: {e:?}"))
});

/// The schema value of bench_shared.dbs.
static SHARED: LazyLock<polyspec_orm::Schema> = LazyLock::new(|| polyspec_orm::Schema::new(&SHARED_MANIFEST.manifest_text, &SHARED_MANIFEST.manifest_hash));

/// Installs the external document of the bench set, then the bench set, on the database of `db`.
pub async fn install(db: &polyspec_orm::Db) -> polyspec_orm::Result<()> {
    db.utils().schema().install(&SHARED).await?;
    db.utils().schema().install(&crate::model::SCHEMA).await
}
