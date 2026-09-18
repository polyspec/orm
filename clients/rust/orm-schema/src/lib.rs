//! Schema definitions for the Rust ORM.
//!
//! `schema` parses Mermaid diagrams and builds the validated manifest
//! (schema.json); `ddl` renders the CREATE statements of a manifest and the
//! migration between two manifests for one dialect; `sql` splits rendered SQL
//! into statements. The runtime installs schemas with it, and `orm-build`
//! uses it for build scripts and the `orm-gen` tool.

pub mod ddl;
pub mod schema;
pub mod sql;
pub mod triggers;
