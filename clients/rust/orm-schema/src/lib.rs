//! Schema definitions for the Rust ORM.
//!
//! `dbspec`는 dbspec document를 parse하고 canonical text로 emit하며, manifest,
//! runtime model, dialect statement, plan과 Mermaid export/import를 만든다.
//! `sql`은 SQL text를 statement로 나눈다.

pub mod dbspec;
pub mod sql;
