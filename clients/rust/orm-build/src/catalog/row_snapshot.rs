//! Checked original values for optimistic row editing, not write authorization.
use super::{metadata, TableKind, TableMetadata, TablePage};
use crate::tool_db::{GridCell, GridQueryResult};
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
pub(super) fn descriptor(value: &TableMetadata) -> Result<Vec<usize>, String> {
    metadata::validate_name(&value.table.namespace).map_err(|_| invalid())?;
    metadata::validate_name(&value.table.name).map_err(|_| invalid())?;
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
        metadata::validate_name(&column.name).map_err(|_| invalid())?;
        bytes = bytes.checked_add(column.name.len()).and_then(|n| n.checked_add(column.native_type.len()))
            .and_then(|n| n.checked_add(column.default_expression.as_ref().map_or(0, String::len))).filter(|n| *n <= 65536).ok_or_else(invalid)?;
        if column.native_type.contains('\0') || column.default_expression.as_ref().is_some_and(|value| value.contains('\0')) || !names.insert(column.name.as_str()) {
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
pub(super) fn row(metadata: &TableMetadata, cells: &[GridCell]) -> Result<(), String> {
    if cells.len() != metadata.columns.len() {
        return Err(invalid());
    }
    for (cell, column) in cells.iter().zip(&metadata.columns) {
        if matches!(cell, GridCell::Null) && !column.nullable {
            return Err(invalid());
        }
        if let GridCell::Decimal(value) = cell {
            let unsigned = value.strip_prefix('-').unwrap_or(value);
            let (whole, fraction) = unsigned.split_once('.').map_or((unsigned, None), |(whole, fraction)| (whole, Some(fraction)));
            if whole.is_empty()
                || (whole.len() > 1 && whole.starts_with('0'))
                || !whole.bytes().all(|byte| byte.is_ascii_digit())
                || fraction.is_some_and(|fraction| fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()))
            {
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
        .map_err(|_| "ROW_SNAPSHOT_LIMIT: original row encoding exceeds its budget".to_owned())?;
    Ok(format!("{:x}", writer.hash.finalize()))
}
impl RowSnapshot {
    pub fn from_page(page: &TablePage, row_index: usize) -> Result<Self, String> {
        super::page::validate_request(&page.metadata.table, page.limit, page.offset).map_err(|_| invalid())?;
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
