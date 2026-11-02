//! The helpers that the test programs of the Rust client share.

pub mod markdown;
pub mod recipe;
pub mod recipe_keys;

// The request builder of the recipe helper (recipe::ir_request) reads these names from the crate root.
use polyspec_orm::{dbspec, ir, schema};

mod or_panic {
    pub use polyspec_orm_testcase::OrPanic;
}
