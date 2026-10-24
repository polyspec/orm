//! The `secret_config` row connected to a database, for the AES tests that write it (KSTD-5-46).

use super::secret_config::Secret;
use polyspec_orm::Db;
#[path = "model_connect.rs"]
mod model_connect;

/// A row of the model connected to `db`.
pub fn connected(db: &Db) -> Secret {
    model_connect::connected(db)
}
