use std::io::Write;

/// Bounds accumulated query results: tool queries count serialized rows, while catalog plain reads count cell values.
#[derive(Clone, Copy, Debug)]
pub struct QueryLimits {
    pub max_rows: usize,
    pub max_bytes: usize,
}
impl Default for QueryLimits {
    fn default() -> Self {
        Self { max_rows: 100_000, max_bytes: 64 * 1024 * 1024 }
    }
}
fn error() -> sqlx::Error {
    sqlx::Error::Decode("TOOL_QUERY_LIMIT: invalid or exceeded result budget".into())
}

fn error_with(error: impl std::fmt::Display) -> sqlx::Error {
    sqlx::Error::Decode(format!("TOOL_QUERY_LIMIT: invalid or exceeded result budget: {error}").into())
}
pub(super) struct Budget {
    limits: QueryLimits,
    bytes: usize,
}
/// Bounds converted plain-result values by their client-visible byte sizes.
pub(super) struct ValueBudget {
    limits: QueryLimits,
    bytes: usize,
}
pub(super) trait CellSize {
    fn size_bytes(&self) -> usize;
}
impl CellSize for super::Val {
    fn size_bytes(&self) -> usize {
        match self {
            super::Val::Text(text) => text.len(),
            super::Val::Null | super::Val::Int(_) | super::Val::Bool(_) => 8,
        }
    }
}
impl CellSize for super::GridCell {
    fn size_bytes(&self) -> usize {
        match self {
            super::GridCell::Text(text)
            | super::GridCell::Decimal(text)
            | super::GridCell::Date(text)
            | super::GridCell::Time(text)
            | super::GridCell::DateTime(text) => text.len(),
            super::GridCell::Binary(bytes) => bytes.len(),
            super::GridCell::Null
            | super::GridCell::Integer(_)
            | super::GridCell::Unsigned(_)
            | super::GridCell::Float32(_)
            | super::GridCell::Float64(_)
            | super::GridCell::Boolean(_) => 8,
        }
    }
}
impl ValueBudget {
    pub(super) fn new(limits: QueryLimits) -> Result<Self, sqlx::Error> {
        let ceiling = QueryLimits::default();
        if limits.max_rows == 0 || limits.max_rows > ceiling.max_rows || limits.max_bytes == 0 || limits.max_bytes > ceiling.max_bytes {
            return Err(error());
        }
        Ok(Self { limits, bytes: 0 })
    }
    pub(super) fn check_row_count(&self, count: usize) -> Result<(), sqlx::Error> {
        if count >= self.limits.max_rows {
            Err(error())
        } else {
            Ok(())
        }
    }
    pub(super) fn add_row<T: CellSize>(&mut self, row: &[T], _count: usize) -> Result<(), sqlx::Error> {
        let size = row.iter().try_fold(0usize, |bytes, value| bytes.checked_add(value.size_bytes()).filter(|total| *total <= self.limits.max_bytes));
        let Some(bytes) = size else { return Err(error()) };
        self.bytes = self.bytes.checked_add(bytes).filter(|total| *total <= self.limits.max_bytes).ok_or_else(error)?;
        Ok(())
    }
}
impl Budget {
    pub(super) fn new(limits: QueryLimits) -> Result<Self, sqlx::Error> {
        let ceiling = QueryLimits::default();
        if limits.max_rows == 0 || limits.max_rows > ceiling.max_rows || limits.max_bytes < 2 || limits.max_bytes > ceiling.max_bytes {
            return Err(error());
        }
        Ok(Self { limits, bytes: 2 })
    }
    pub(super) fn check_row_count(&self, count: usize) -> Result<(), sqlx::Error> {
        if count >= self.limits.max_rows {
            Err(error())
        } else {
            Ok(())
        }
    }
    pub(super) fn add_row<T: serde::Serialize>(&mut self, row: &[T], count: usize) -> Result<(), sqlx::Error> {
        let mut writer = Counter { bytes: self.bytes + usize::from(count > 0), limit: self.limits.max_bytes };
        serde_json::to_writer(&mut writer, row).map_err(error_with)?;
        self.bytes = writer.bytes;
        Ok(())
    }
}
struct Counter {
    bytes: usize,
    limit: usize,
}
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let next = self.bytes.checked_add(bytes.len()).filter(|n| *n <= self.limit).ok_or_else(|| std::io::Error::other("result budget exceeded"))?;
        self.bytes = next;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
