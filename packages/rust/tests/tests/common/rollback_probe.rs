//! The probe model of contracts/fixtures/rollback.dbs, which the replica and statement fault tests install. The
//! including binary declares the model_row macro (common/model_row.rs) before this module.

use polyspec_orm::{Entity, Schema};

pub static PROBE_SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/rollback.dbs"), "sha256:c57c6748bed0458f6d9843a0e0861ca8ea89c3bde5c4308f2e049b6a87a1203c");
pub static PROBE: Entity = Entity {
    name: "rollback_probe",
    schema: &PROBE_SCHEMA,
    new: polyspec_orm::model::new_boxed::<Probe>,
    collect: polyspec_orm::model::collect_boxed::<Probe>,
};
const COLUMNS: [&str; 2] = ["seq", "label"];

model_row!(Probe, PROBE, COLUMNS);
