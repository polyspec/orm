//! Reads the tables of a live database from its catalog through a
//! connection that implements [`Catalog`]: the `orm-build` tool connection
//! and the connection of the runtime use the same reads.

mod add_columns;
mod checks;
mod reader;

pub use add_columns::{plan_add_columns, AddColumnsError, AddColumnsPlan};
pub use checks::align_live_checks;
pub use reader::{live_manifest, postgres_check_expr, read_tables, trigger_bodies};

/// A value of a catalog row.
#[derive(Debug, Clone, PartialEq)]
pub enum CatalogValue {
    Null,
    Int(i64),
    Text(String),
    Bool(bool),
}

/// The rows of one catalog statement, as values in column order.
pub type Rows = Vec<Vec<CatalogValue>>;

impl CatalogValue {
    /// The text of the value; SQL NULL is the empty text.
    pub fn text(&self) -> String {
        match self {
            CatalogValue::Null => String::new(),
            CatalogValue::Int(n) => n.to_string(),
            CatalogValue::Text(s) => s.clone(),
            CatalogValue::Bool(b) => b.to_string(),
        }
    }

    pub fn opt_text(&self) -> Option<String> {
        match self {
            CatalogValue::Null => None,
            v => Some(v.text()),
        }
    }

    pub fn int(&self) -> Result<i64, String> {
        match self {
            CatalogValue::Int(n) => Ok(*n),
            CatalogValue::Bool(b) => Ok(i64::from(*b)),
            CatalogValue::Text(s) => s.parse().map_err(|_| format!("catalog integer {s:?} is invalid")),
            CatalogValue::Null => Err("catalog integer is NULL".into()),
        }
    }

    pub fn opt_int(&self) -> Result<Option<i64>, String> {
        match self {
            CatalogValue::Null => Ok(None),
            v => v.int().map(Some),
        }
    }

    pub fn bool(&self) -> Result<bool, String> {
        match self {
            CatalogValue::Bool(b) => Ok(*b),
            CatalogValue::Int(0) => Ok(false),
            CatalogValue::Int(1) => Ok(true),
            CatalogValue::Text(s) if matches!(s.as_str(), "t" | "true" | "1") => Ok(true),
            CatalogValue::Text(s) if matches!(s.as_str(), "f" | "false" | "0") => Ok(false),
            v => Err(format!("catalog boolean {v:?} is invalid")),
        }
    }
}

/// One connection that runs the catalog statements, in the order they are
/// given, without bind values.
#[allow(async_fn_in_trait)]
pub trait Catalog {
    type Error: std::fmt::Display;
    /// Runs one statement and returns its rows.
    async fn query(&mut self, sql: &str) -> Result<Rows, Self::Error>;
    /// Runs one statement that returns no rows.
    async fn exec(&mut self, sql: &str) -> Result<(), Self::Error>;
}

/// A failed catalog read: the error of a statement, or catalog content that
/// cannot be read.
#[derive(Debug)]
pub enum CatalogError<E> {
    Query(E),
    Read(String),
}

impl<E: std::fmt::Display> std::fmt::Display for CatalogError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CatalogError::Query(e) => write!(f, "{e}"),
            CatalogError::Read(m) => f.write_str(m),
        }
    }
}

impl<E: std::fmt::Display> From<CatalogError<E>> for String {
    fn from(e: CatalogError<E>) -> String {
        e.to_string()
    }
}
