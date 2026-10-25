//! Shared event error types for stopping a dbspec apply operation, and the recorder of its statement steps.

use polyspec_orm::dbspec::{ApplyEvent, ApplyEventKind};

pub type EventError = Box<dyn std::error::Error + Send + Sync>;

/// The error that halts apply in an event handler.
#[derive(Debug)]
pub struct Stop;

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stop")
    }
}

impl std::error::Error for Stop {}

/// An apply event handler that appends the kind and step of each statement and applied event to `events`.
#[allow(dead_code, reason = "each binary that includes this module uses only the items it needs")]
pub fn record_steps(events: &mut Vec<(ApplyEventKind, usize)>) -> impl FnMut(&ApplyEvent) -> Result<(), EventError> + '_ {
    move |event: &ApplyEvent| {
        if matches!(event.kind, ApplyEventKind::Statement | ApplyEventKind::Applied) {
            events.push((event.kind, event.step));
        }
        Ok(())
    }
}
