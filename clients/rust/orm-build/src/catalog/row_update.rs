//! Pure update checks; the executor owns locking, rollback and commit.
use super::{row_snapshot, RowSnapshot, TableMetadata};
use crate::tool_db::{GridCell, GridQueryResult};
use std::collections::HashSet;

fn invalid() -> String {
    "ROW_UPDATE_INVALID: invalid column assignments".into()
}
impl RowSnapshot {
    fn updated_cells(&self, changes: &[(String, GridCell)]) -> Result<Vec<GridCell>, String> {
        if changes.is_empty() || changes.len() > self.metadata().columns.len() {
            return Err(invalid());
        }
        let mut names = HashSet::new();
        let mut bytes = 0usize;
        for (name, cell) in changes {
            let column = self.metadata().columns.iter().find(|column| column.name == *name).ok_or_else(invalid)?;
            if column.generated || !names.insert(name) || (!column.nullable && matches!(cell, GridCell::Null)) {
                return Err(invalid());
            }
            let size = match cell {
                GridCell::Text(value) | GridCell::Decimal(value) => value.len(),
                GridCell::Binary(value) => value.len(),
                _ => 16,
            };
            bytes = bytes
                .checked_add(name.len())
                .and_then(|n| n.checked_add(size))
                .filter(|n| *n <= 8 * 1024 * 1024)
                .ok_or_else(|| "ROW_UPDATE_LIMIT: assignment budget exceeded".to_owned())?;
        }
        let mut cells = self.cells().to_vec();
        for (name, value) in changes {
            let index = self.metadata().columns.iter().position(|column| column.name == *name).ok_or_else(invalid)?;
            cells[index] = value.clone();
        }
        row_snapshot::row(self.metadata(), &cells).map_err(|_| invalid())?;
        row_snapshot::revision(self.metadata(), &cells).map_err(|_| "ROW_UPDATE_LIMIT: updated row budget exceeded".to_owned())?;
        Ok(cells)
    }
    /// Validate before any SQL is executed. This does not authorize a write.
    pub fn validate_update(&self, changes: &[(String, GridCell)]) -> Result<(), String> {
        self.updated_cells(changes).map(|_| ())
    }
    /// Fetch by the resulting keys inside the same writable transaction.
    /// A failed check requires rollback; generated values may be recomputed.
    pub fn check_updated(&self, metadata: &TableMetadata, result: &GridQueryResult, changes: &[(String, GridCell)]) -> Result<(), String> {
        let expected = self.updated_cells(changes)?;
        if metadata != self.metadata() {
            return Err("ROW_SCHEMA_CHANGED: original descriptor changed".into());
        }
        row_snapshot::projection(metadata, result)?;
        if result.rows.len() != 1 {
            return Err("ROW_WRITE_MISMATCH: expected exactly one updated row".into());
        }
        row_snapshot::row(metadata, &result.rows[0])?;
        row_snapshot::revision(metadata, &result.rows[0])?;
        for ((column, actual), wanted) in metadata.columns.iter().zip(&result.rows[0]).zip(&expected) {
            if !column.generated && actual != wanted {
                return Err("ROW_WRITE_MISMATCH: stored ordinary values differ".into());
            }
        }
        Ok(())
    }
}
