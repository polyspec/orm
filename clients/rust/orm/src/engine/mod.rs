//! The native query engine: request validation, planning, dialect rendering,
//! and schema DDL.

pub(crate) mod dialect;
mod planner;
mod validate;

pub use dialect::Dialect;

use crate::ir;
use crate::plan::Plan;
use crate::schema::Manifest;
use crate::{Error, Result};

pub(crate) fn err(code: &str, msg: impl Into<String>) -> Error {
    Error::Engine { code: code.into(), msg: msg.into() }
}

/// Validates a request and plans it for a dialect.
pub(crate) fn compile(m: &Manifest, d: Dialect, r: &ir::Request) -> Result<Plan> {
    validate::validate(m, r)?;
    planner::Planner { m, d }.compile(r)
}
