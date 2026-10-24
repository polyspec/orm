//! The shared clock event model used by clock and write-set integration cases.

use polyspec_orm::{Entity, Schema};

pub static CLOCK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/clock.dbs"), "sha256:fab61fb83cfec00c4d7a4d257b610b87c6fdccd49e02a85848a41ba263bc1ffb");
pub static CLOCK_EVENT: Entity = Entity {
    name: "clock_event",
    schema: &CLOCK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<ClockEvent>,
    collect: polyspec_orm::model::collect_boxed::<ClockEvent>,
};
const COLUMNS: [&str; 3] = ["seq", "label", "created_ts"];

model_row!(ClockEvent, CLOCK_EVENT, COLUMNS);
