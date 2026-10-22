//! The `secret_config` model of the AES tests (KSTD-5-46): its schema and entity, the row that reads and writes its
//! values by column name, and the connection of a row to a database. The schema is contracts/fixtures/secret_config.dbs.

use polyspec_orm::{Entity, Schema};

// secret_config { bigint seq PK "auto"; int aes_key_version; longblob config "json aes" }
pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/secret_config.dbs"), "sha256:c50e5970f7edf30cb5aaa52d291e4ae19ebbdd28040084829ebada1932120f7b");
pub static SECRET: Entity =
    Entity { name: "secret_config", schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<Secret>, collect: polyspec_orm::model::collect_boxed::<Secret> };
pub const COLUMNS: [&str; 3] = ["seq", "aes_key_version", "config"];

model_row!(Secret, SECRET, COLUMNS);

