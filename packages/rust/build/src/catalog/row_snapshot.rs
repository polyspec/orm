//! Checked original values for optimistic row editing, not write authorization.
use super::{TableKind, TableMetadata, TablePage, metadata};
use crate::tool_db::{GridCell, GridQueryResult, P};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Write};

pub struct RowSnapshot {
    metadata: TableMetadata,
    cells: Vec<GridCell>,
    key_indexes: Vec<usize>,
    revision: String,
}
impl std::fmt::Debug for RowSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RowSnapshot").field("columns", &self.cells.len()).field("keys", &self.key_indexes.len()).finish_non_exhaustive()
    }
}
fn invalid() -> String {
    "ROW_SNAPSHOT_INVALID: invalid original row or descriptor".into()
}

fn invalid_with(error: impl std::fmt::Display) -> String {
    format!("ROW_SNAPSHOT_INVALID: invalid original row or descriptor: {error}")
}
pub(super) fn descriptor(value: &TableMetadata) -> Result<Vec<usize>, String> {
    metadata::validate_name(&value.table.namespace).map_err(invalid_with)?;
    metadata::validate_name(&value.table.name).map_err(invalid_with)?;
    if !matches!(value.kind, TableKind::Table | TableKind::Partitioned)
        || !value.reliable_row_identity
        || value.primary_key.is_empty()
        || value.columns.is_empty()
        || value.columns.len() > 2048
    {
        return Err(invalid());
    }
    let mut names = HashSet::new();
    let mut bytes = 0usize;
    for column in &value.columns {
        metadata::validate_name(&column.name).map_err(invalid_with)?;
        bytes = bytes
            .checked_add(column.name.len())
            .and_then(|n| n.checked_add(column.native_type.len()))
            .and_then(|n| n.checked_add(column.default_expression.as_ref().map_or(0, String::len)))
            .filter(|n| *n <= 65536)
            .ok_or_else(invalid)?;
        if column.native_type.contains('\0')
            || column.default_expression.as_ref().is_some_and(|value| value.contains('\0'))
            || !names.insert(column.name.as_str())
        {
            return Err(invalid());
        }
    }
    let mut keys = HashSet::new();
    let mut indexes = Vec::new();
    for key in &value.primary_key {
        if !keys.insert(key.as_str()) {
            return Err(invalid());
        }
        let index = value.columns.iter().position(|column| column.name == *key && !column.nullable).ok_or_else(invalid)?;
        indexes.push(index);
    }
    Ok(indexes)
}
pub(super) fn projection(metadata: &TableMetadata, result: &GridQueryResult) -> Result<(), String> {
    if result.columns.len() != metadata.columns.len() {
        return Err(invalid());
    }
    let mut bytes = 0usize;
    for (column, declared) in result.columns.iter().zip(&metadata.columns) {
        bytes = bytes.checked_add(column.name.len()).and_then(|n| n.checked_add(column.native_type.len())).filter(|n| *n <= 65536).ok_or_else(invalid)?;
        if column.name != declared.name || column.native_type.is_empty() || column.native_type.contains('\0') {
            return Err(invalid());
        }
    }
    Ok(())
}
pub(super) fn key_params(metadata: &TableMetadata, cells: &[GridCell]) -> Result<Vec<P>, String> {
    metadata
        .primary_key
        .iter()
        .map(|name| {
            let index = metadata.columns.iter().position(|column| column.name == *name).unwrap();
            super::mutation::bind(&cells[index])
        })
        .collect()
}

pub(super) fn row(metadata: &TableMetadata, cells: &[GridCell]) -> Result<(), String> {
    if cells.len() != metadata.columns.len() {
        return Err(invalid());
    }
    for (cell, column) in cells.iter().zip(&metadata.columns) {
        if matches!(cell, GridCell::Null) && !column.nullable {
            return Err(invalid());
        }
        if let GridCell::Decimal(value) = cell {
            if !crate::tool_db::decimal_valid(value) {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
struct RevisionWriter {
    hash: Sha256,
    bytes: usize,
}
impl Write for RevisionWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes =
            self.bytes.checked_add(bytes.len()).filter(|n| *n <= 8 * 1024 * 1024).ok_or_else(|| std::io::Error::other("row snapshot budget exceeded"))?;
        self.hash.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn revision(metadata: &TableMetadata, cells: &[GridCell]) -> Result<String, String> {
    let mut writer = RevisionWriter { hash: Sha256::new(), bytes: 0 };
    serde_json::to_writer(&mut writer, &("orm-row-baseline-v1", metadata, cells))
        .map_err(|error| format!("ROW_SNAPSHOT_LIMIT: original row encoding exceeds its budget: {error}"))?;
    Ok(format!("{:x}", writer.hash.finalize()))
}
impl RowSnapshot {
    pub fn from_page(page: &TablePage, row_index: usize) -> Result<Self, String> {
        super::page::validate_request(&page.metadata.table, page.limit, page.offset).map_err(invalid_with)?;
        if page.result.rows.len() > page.limit || (page.has_more && page.result.rows.len() != page.limit) || page.order_by != page.metadata.primary_key {
            return Err(invalid());
        }
        let key_indexes = descriptor(&page.metadata)?;
        projection(&page.metadata, &page.result)?;
        let cells = page.result.rows.get(row_index).ok_or_else(invalid)?;
        row(&page.metadata, cells)?;
        let revision = revision(&page.metadata, cells)?;
        Ok(Self { metadata: page.metadata.clone(), cells: cells.clone(), key_indexes, revision })
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn metadata(&self) -> &TableMetadata {
        &self.metadata
    }
    pub fn cells(&self) -> &[GridCell] {
        &self.cells
    }
    pub fn key(&self) -> impl Iterator<Item = (&str, &GridCell)> {
        self.metadata.primary_key.iter().zip(&self.key_indexes).map(|(name, index)| (name.as_str(), &self.cells[*index]))
    }
    /// Caller must fetch by original keys under its owning writable lock.
    pub fn check_current(&self, metadata: &TableMetadata, result: &GridQueryResult) -> Result<(), String> {
        if metadata != &self.metadata {
            return Err("ROW_SCHEMA_CHANGED: original descriptor changed".into());
        }
        projection(metadata, result)?;
        match result.rows.len() {
            0 => return Err("ROW_CONFLICT: original row is missing".into()),
            1 => {}
            _ => return Err("ROW_IDENTITY_AMBIGUOUS: key selected multiple rows".into()),
        }
        row(metadata, &result.rows[0])?;
        revision(metadata, &result.rows[0])?;
        if result.rows[0] != self.cells {
            return Err("ROW_CONFLICT: original values changed".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod cause_message_tests {
    use super::*;

    fn fixture() -> TablePage {
        TablePage {
            metadata: TableMetadata {
                table: super::super::TableRef { namespace: "main".into(), name: "fixture".into() },
                kind: TableKind::Table,
                columns: vec![super::super::TableColumnMetadata {
                    name: "id".into(),
                    native_type: "INTEGER".into(),
                    nullable: false,
                    generated: false,
                    automatic_key: false,
                    default_expression: None,
                    expression_default: false,
                }],
                primary_key: vec!["id".into()],
                reliable_row_identity: true,
            },
            result: GridQueryResult {
                columns: vec![crate::tool_db::QueryColumn { name: "id".into(), native_type: "INTEGER".into() }],
                rows: vec![vec![GridCell::Integer(1)]],
            },
            limit: 1,
            offset: 0,
            order_by: vec!["id".into()],
            has_more: false,
        }
    }

    #[test]
    fn primary_key_parameters_follow_declared_key_order() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut page = fixture();
        page.metadata.columns.push(super::super::TableColumnMetadata {
            name: "slug".into(),
            native_type: "TEXT".into(),
            nullable: false,
            generated: false,
            automatic_key: false,
            default_expression: None,
            expression_default: false,
        });
        page.metadata.primary_key = vec!["slug".into(), "id".into()];
        let keys = key_params(&page.metadata, &[GridCell::Integer(7), GridCell::Text("row-key".into())]).unwrap();
        assert!(matches!(keys.as_slice(), [P::S(slug), P::I(7)] if slug == "row-key"));
    }

    #[test]
    fn row_snapshot_uses_shared_decimal_syntax_validation() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let page = fixture();
        for value in ["0", "-0", "100.23000", "-12345678901234567890.00001"] {
            assert!(row(&page.metadata, &[GridCell::Decimal(value.into())]).is_ok(), "{value}");
        }
        for value in ["", "01", "-", "+1", "1.", "1e3", "NaN"] {
            assert!(row(&page.metadata, &[GridCell::Decimal(value.into())]).is_err(), "{value}");
        }
    }

    #[test]
    fn row_snapshot_descriptor_and_update_preserve_cause_message() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut page = fixture();
        page.metadata.table.name.clear();
        let error = RowSnapshot::from_page(&page, 0).expect_err("empty table name must fail");
        assert!(
            error.contains("ROW_SNAPSHOT_INVALID: invalid original row or descriptor: TABLE_REFERENCE_INVALID: expected 1..1024 UTF-8 bytes without NUL"),
            "{error}"
        );

        let mut page = fixture();
        page.metadata.columns[0].name.clear();
        let error = RowSnapshot::from_page(&page, 0).expect_err("empty column name must fail");
        assert!(
            error.contains("ROW_SNAPSHOT_INVALID: invalid original row or descriptor: TABLE_REFERENCE_INVALID: expected 1..1024 UTF-8 bytes without NUL"),
            "{error}"
        );

        let snapshot = RowSnapshot::from_page(&fixture(), 0).expect("valid page");
        let error = snapshot.validate_update(&[("id".into(), GridCell::Decimal("01".into()))]).expect_err("invalid decimal assignment must fail");
        assert!(error.contains("ROW_UPDATE_INVALID: invalid column assignments: ROW_SNAPSHOT_INVALID: invalid original row or descriptor"), "{error}");

        let mut page = fixture();
        page.metadata.columns.push(super::super::TableColumnMetadata {
            name: "payload".into(),
            native_type: "TEXT".into(),
            nullable: false,
            generated: false,
            automatic_key: false,
            default_expression: None,
            expression_default: false,
        });
        page.result.columns.push(crate::tool_db::QueryColumn { name: "payload".into(), native_type: "TEXT".into() });
        page.result.rows[0].push(GridCell::Text("small".into()));
        let snapshot = RowSnapshot::from_page(&page, 0).expect("valid page with payload");
        let huge = GridCell::Text("x".repeat(8 * 1024 * 1024 - 64));
        let error = snapshot.validate_update(&[("payload".into(), huge)]).expect_err("oversized update must fail");
        assert!(
            error.contains(
                "ROW_UPDATE_LIMIT: updated row budget exceeded: ROW_SNAPSHOT_LIMIT: original row encoding exceeds its budget: row snapshot budget exceeded"
            ),
            "{error}"
        );
    }

    #[test]
    fn row_snapshot_revision_preserves_writer_cause_message() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut page = fixture();
        page.metadata.columns.push(super::super::TableColumnMetadata {
            name: "payload".into(),
            native_type: "TEXT".into(),
            nullable: false,
            generated: false,
            automatic_key: false,
            default_expression: None,
            expression_default: false,
        });
        page.result.columns.push(crate::tool_db::QueryColumn { name: "payload".into(), native_type: "TEXT".into() });
        page.result.rows[0].push(GridCell::Text("x".repeat(8 * 1024 * 1024 + 1)));
        let error = RowSnapshot::from_page(&page, 0).expect_err("oversized row must fail");
        assert!(error.contains("ROW_SNAPSHOT_LIMIT: original row encoding exceeds its budget: row snapshot budget exceeded"), "{error}");
    }
}
