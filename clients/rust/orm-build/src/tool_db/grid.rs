use super::{QueryColumn, Val};

/// Typed native query values; binary is never interpreted as UTF-8 text.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum GridCell {
    Null,
    Integer(i64),
    Text(String),
    Boolean(bool),
    Binary(Vec<u8>),
}
impl From<Val> for GridCell {
    fn from(value: Val) -> Self {
        match value {
            Val::Null => Self::Null,
            Val::Int(value) => Self::Integer(value),
            Val::Text(value) => Self::Text(value),
            Val::Bool(value) => Self::Boolean(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GridQueryResult {
    pub columns: Vec<QueryColumn>,
    pub rows: Vec<Vec<GridCell>>,
}
