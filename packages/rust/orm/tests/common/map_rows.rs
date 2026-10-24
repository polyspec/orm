//! Maps query rows into values consumed by Rust ORM tests.

use sqlx::{ColumnIndex, Decode, Row, Type};

/// Converts each borrowed query row with the caller's field decoder.
pub fn map_rows<R, T>(rows: &[R], decode: impl FnMut(&R) -> T) -> Vec<T> {
    rows.iter().map(decode).collect()
}

/// Reads the first two columns as an integer sequence and text label.
pub fn sequence_label<R>(row: &R) -> Result<(i64, String), (usize, sqlx::Error)>
where
    R: Row,
    usize: ColumnIndex<R>,
    for<'r> i64: Decode<'r, R::Database> + Type<R::Database>,
    for<'r> String: Decode<'r, R::Database> + Type<R::Database>,
{
    let sequence = row.try_get::<i64, _>(0).map_err(|error| (0, error))?;
    let label = row.try_get::<String, _>(1).map_err(|error| (1, error))?;
    Ok((sequence, label))
}

macro_rules! for_sql_pools {
    ($pool:expr, $read:ident) => {
        match $pool {
            polyspec_orm::db::Pool::MySql(pool) => $read!(pool),
            polyspec_orm::db::Pool::Postgres(pool) => $read!(pool),
            polyspec_orm::db::Pool::Sqlite(pool) => $read!(pool),
            polyspec_orm::db::Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
        }
    };
}

pub(crate) use for_sql_pools;
