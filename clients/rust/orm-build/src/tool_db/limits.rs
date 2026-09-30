use std::io::Write;

/// Bounds the serialized array of rows, including array separators.
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
pub(super) struct Budget {
    limits: QueryLimits,
    bytes: usize,
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
        serde_json::to_writer(&mut writer, row).map_err(|_| error())?;
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
