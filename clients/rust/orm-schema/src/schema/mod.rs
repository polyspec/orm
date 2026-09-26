//! Schema tooling: Mermaid diagrams → validated manifest (schema.json).
//!
//! ```text
//! // build.rs
//! let diagram = orm_schema::schema::parse(&std::fs::read_to_string("schema/example.mmd")?)?;
//! let manifest = orm_schema::schema::build(&[diagram])?;
//! std::fs::write("schema/schema.json", manifest.marshal_indent() + "\n")?;
//! ```

mod audit;
#[doc(hidden)]
pub mod json;
mod manifest;
mod mermaid;

pub use audit::{Audit, AuditLog, AuditTable};
pub use manifest::{
    build, build_migration_source, check_column_name, BuildError, Check, Col, Entity, ExternalFk, Manifest, Ref, Rel, RelKey, Timestamps, RESERVED_COLUMNS,
    RESERVED_PREFIXES, RESERVED_SEGMENTS,
};
pub use mermaid::{parse, DColumn, DEntity, DRelation, Diagram, Directive, OrmDirective, ParseError};

#[doc(hidden)]
pub use mermaid::{fields, go_quote};

/// A double-quoted string literal with escapes, as error messages quote
/// input text.
pub fn quote_text(s: &str) -> String {
    go_quote(s)
}

/// Parses the diagram files in the given order and builds one manifest, the
/// library form of `orm-gen build`. Parse errors carry the file path.
pub fn build_files(paths: &[std::path::PathBuf]) -> Result<Manifest, String> {
    let mut diagrams = Vec::with_capacity(paths.len());
    for path in paths {
        let src = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        diagrams.push(parse(&src).map_err(|e| format!("{}:{e}", path.display()))?);
    }
    build(&diagrams).map_err(|e| e.to_string())
}

#[cfg(test)]
mod decimal_manifest_tests {
    #[test]
    fn integral_decimal_scale_is_explicit_in_shared_manifest() {
        let source = include_str!("../../../../../contracts/fixtures/decimal_schema.mmd");
        let expected = include_str!("../../../../../contracts/fixtures/decimal_schema.json");
        let diagram = super::parse(source).unwrap();
        let manifest = super::build(&[diagram]).unwrap();
        assert_eq!(manifest.marshal_indent() + "\n", expected);
        assert!(expected.contains("\"scale\": 0"));
    }
}
