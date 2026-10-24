//! Reuses the ORM test support's database environment reader in generated-model coverage tests.

#[path = "../../../orm/tests/common/feature_database.rs"]
mod selected_database;

pub use selected_database::selected_and_dsn as feature_database;
