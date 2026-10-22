//! The `secret_config` row connected to a database, for the AES tests that write it (KSTD-5-46).

use super::secret_config::{Secret, SECRET};
use polyspec_orm::{Core, Db, Model};

/// A row of the model connected to `db`.
pub fn connected(db: &Db) -> Secret {
    let mut core = Core::new(&SECRET);
    core.connect(db);
    Secret::from_core(core)
}
