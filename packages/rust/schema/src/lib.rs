//! Schema definitions for the Rust ORM.
//!
//! `dbspec` parses dbspec documents and emits them as canonical text, and builds the manifest,
//! runtime model, dialect statements, and plan and Mermaid export/import.
//! `sql` splits SQL text into statements.

pub mod dbspec;
pub mod sql;
