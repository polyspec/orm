//! Connects a test model to the database using its declared entity.

use polyspec_orm::{Core, Db, Model};

pub fn connected<M: Model>(db: &Db) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    M::from_core(core)
}
