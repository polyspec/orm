use super::{QueryColumn, Val};

/// Typed native query values; binary is never interpreted as UTF-8 text.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum GridCell {
    Null,
    Integer(i64),
    Unsigned(u64),
    Float32(u32),
    Float64(u64),
    Decimal(String),
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

pub(super) fn postgres_decimal(row:&sqlx::postgres::PgRow,index:usize)->Result<GridCell,sqlx::Error>{
    use sqlx::Row;
    let invalid=||sqlx::Error::Decode("Unsupported or invalid finite grid decimal".into());
    let Some(decimal)=row.try_get::<Option<bigdecimal::BigDecimal>,_>(index).map_err(|_|invalid())? else{return Ok(GridCell::Null)};
    let raw=row.try_get_raw(index)?;
    let decimal=if raw.format()==sqlx::postgres::PgValueFormat::Binary {
        let bytes=raw.as_bytes().map_err(|_|invalid())?;
        if bytes.len()<8{return Err(invalid())}
        let scale=u16::from_be_bytes([bytes[6],bytes[7]]);
        let scaled=decimal.with_scale(i64::from(scale));
        if scaled!=decimal{return Err(invalid())}
        scaled
    }else{decimal};
    Ok(GridCell::Decimal(decimal.to_plain_string()))
}
