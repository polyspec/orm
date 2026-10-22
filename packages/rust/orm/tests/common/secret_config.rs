//! The `secret_config` model of the AES tests (KSTD-5-46): its schema and entity, the row that reads and writes its
//! values by column name, and the connection of a row to a database. The schema is contracts/fixtures/secret_config.dbs.

use polyspec_orm::{Core, Entity, Model, Schema, Val};
use std::collections::BTreeMap;

// secret_config { bigint seq PK "auto"; int aes_key_version; longblob config "json aes" }
pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/secret_config.dbs"), "sha256:c50e5970f7edf30cb5aaa52d291e4ae19ebbdd28040084829ebada1932120f7b");
pub static SECRET: Entity =
    Entity { name: "secret_config", schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<Secret>, collect: polyspec_orm::model::collect_boxed::<Secret> };
pub const COLUMNS: [&str; 3] = ["seq", "aes_key_version", "config"];

/// A secret_config row whose values are read and written by column name.
#[derive(Clone)]
pub struct Secret {
    core: Core,
    pub values: BTreeMap<String, Val>,
}

impl Model for Secret {
    fn entity() -> &'static Entity {
        &SECRET
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        Secret { core, values: BTreeMap::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        if !COLUMNS.contains(&name) {
            return Ok(false);
        }
        self.values.insert(name.to_owned(), v);
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }
}
