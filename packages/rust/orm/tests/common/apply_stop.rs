//! Shared event error types for stopping a dbspec apply operation.

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
