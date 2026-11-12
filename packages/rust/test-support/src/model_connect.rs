//! Connects a test model to the database using its declared entity.

use polyspec_orm::{Connection, Core, Model};

/// A model connected to a `Db` or to the `Tx` of a transaction.
pub fn connected<M: Model>(connection: impl Into<Connection>) -> M {
    let mut core = Core::new(M::entity());
    core.connect(connection);
    M::from_core(core)
}

pub fn with<M: Model>(values: &[(&str, polyspec_orm::Param)]) -> M {
    with_values(M::from_core(Core::new(M::entity())), values)
}

pub fn connected_with<M: Model>(connection: impl Into<Connection>, values: &[(&str, polyspec_orm::Param)]) -> M {
    with_values(connected(connection), values)
}

fn with_values<M: Model>(mut model: M, values: &[(&str, polyspec_orm::Param)]) -> M {
    for (column, value) in values {
        model.core_mut().set(column, value.clone());
    }
    model
}
