//! The service table of contracts/fixtures/bench/bench.dbs and its model, which sqlite_concurrency and transaction_flow use.

use std::sync::LazyLock;

use polyspec_orm::{Core, Db, Entity, Model};

use crate::sqlite_case::SCHEMA;

static ENTITY: LazyLock<Entity> = LazyLock::new(|| Entity {
    name: "service",
    schema: &SCHEMA,
    new: polyspec_orm::model::new_boxed::<Service>,
    collect: polyspec_orm::model::collect_boxed::<Service>,
});

typed_model!(Service, ENTITY, {
    seq: i64 = "seq",
    name: String = "name",
});

/// A service model connected to `db`, or to the active transaction without one.
pub fn service(db: Option<&Db>) -> Service {
    let mut core = Core::new(&ENTITY);
    if let Some(db) = db {
        core.connect(db);
    }
    Service::from_core(core)
}
