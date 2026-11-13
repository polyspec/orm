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

/// A service model connected to `connection`, or to none.
pub fn service(connection: Option<polyspec_orm::Connection>) -> Service {
    let mut core = Core::new(&ENTITY);
    if let Some(connection) = connection {
        core.connect(connection);
    }
    Service::from_core(core)
}

/// A service model connected to `db`.
pub fn service_on(db: &Db) -> Service {
    service(Some(db.into()))
}
