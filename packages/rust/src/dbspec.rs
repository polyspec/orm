//! dbspec introspection over a sqlx connection (docs/spec/dialects.md,
//! "Introspection"): [`introspect`] runs the fixed catalog queries of
//! `polyspec_orm_schema::dbspec` on the connection and reads their rows into one dbspec
//! document and the objects it cannot express. The module also re-exports
//! every item of `polyspec_orm_schema::dbspec`, so `polyspec_orm::dbspec` is the one path to
//! the dbspec language.

#[cfg(feature = "runtime")]
mod apply;
#[cfg(feature = "runtime")]
mod introspect;

#[cfg(feature = "runtime")]
pub use apply::{
    apply, effect_holds, effect_query, finalize, recover, rollback, ApplyClock, ApplyConnection, ApplyError, ApplyEvent, ApplyEventError, ApplyEventKind,
    ApplyEvents,
};
#[cfg(feature = "runtime")]
pub use introspect::*;
pub use polyspec_orm_schema::dbspec::*;
