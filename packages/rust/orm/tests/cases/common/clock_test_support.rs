//! Shared model fixture dependencies for the Rust clock integration tests.

use polyspec_orm_test_support::model_connect;

pub(crate) use crate::clock_event::{ClockEvent, CLOCK_SCHEMA};
pub(crate) use crate::or_panic::OrPanic;
pub(crate) use model_connect::connected;
