//! A plain column of a table fixture: not generated, not an automatic key, with no default (KSTD-5-46).

use super::TableColumnMetadata;

/// The column `name` of native type `native_type`, plain except for its nullability.
pub fn plain_column(name: &str, native_type: &str, nullable: bool) -> TableColumnMetadata {
    TableColumnMetadata {
        name: name.into(),
        native_type: native_type.into(),
        nullable,
        generated: false,
        automatic_key: false,
        default_expression: None,
        expression_default: false,
    }
}
