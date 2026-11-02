//! Connects a test model to the database using its declared entity.

use polyspec_orm::{Core, Db, Model};

pub fn connected<M: Model>(db: &Db) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    M::from_core(core)
}

pub fn with<M: Model>(values: &[(&str, polyspec_orm::Param)]) -> M {
    with_values(M::from_core(Core::new(M::entity())), values)
}

pub fn connected_with<M: Model>(db: &Db, values: &[(&str, polyspec_orm::Param)]) -> M {
    with_values(connected(db), values)
}

fn with_values<M: Model>(mut model: M, values: &[(&str, polyspec_orm::Param)]) -> M {
    for (column, value) in values {
        model.core_mut().set(column, value.clone());
    }
    model
}
