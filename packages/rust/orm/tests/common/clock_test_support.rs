//! Shared model fixture dependencies for the Rust clock integration tests.

#[path = "clock_event.rs"]
mod clock_event;
#[path = "model_connect.rs"]
mod model_connect;
#[path = "or_panic.rs"]
mod or_panic;

pub(crate) use clock_event::{ClockEvent, CLOCK_SCHEMA};
pub(crate) use model_connect::connected;
pub(crate) use or_panic::OrPanic;
