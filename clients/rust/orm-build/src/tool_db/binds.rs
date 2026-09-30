use super::{params, ParamType, P};
use sqlx::{mysql::MySqlArguments, postgres::PgArguments, query::Query, sqlite::SqliteArguments, MySql, Postgres, Sqlite};

pub(super) fn mysql<'q>(mut q: Query<'q, MySql, MySqlArguments>, values: &[P]) -> Result<Query<'q, MySql, MySqlArguments>, sqlx::Error> {
    for value in values {
        q = match value {
            P::S(v) => q.bind(v.clone()),
            P::I(v) => q.bind(*v),
            P::Unsigned(v) => q.bind(*v),
            P::Float32(v) => q.bind(f32::from_bits(*v)),
            P::Float64(v) => q.bind(f64::from_bits(*v)),
            P::Decimal(v) => q.bind(params::decimal(v)?),
            P::Boolean(v) => q.bind(*v),
            P::Binary(v) => q.bind(v.clone()),
            P::Null(kind) => match kind {
                ParamType::Text => q.bind(None::<String>),
                ParamType::Integer => q.bind(None::<i64>),
                ParamType::Unsigned => q.bind(None::<u64>),
                ParamType::Float32 => q.bind(None::<f32>),
                ParamType::Float64 => q.bind(None::<f64>),
                ParamType::Decimal => q.bind(None::<bigdecimal::BigDecimal>),
                ParamType::Boolean => q.bind(None::<bool>),
                ParamType::Binary => q.bind(None::<Vec<u8>>),
            },
        };
    }
    Ok(q)
}
pub(super) fn postgres<'q>(mut q: Query<'q, Postgres, PgArguments>, values: &[P]) -> Result<Query<'q, Postgres, PgArguments>, sqlx::Error> {
    for value in values {
        q = match value {
            P::S(v) => q.bind(v.clone()),
            P::I(v) => q.bind(*v),
            P::Unsigned(_) => return Err(params::invalid()),
            P::Float32(v) => q.bind(f32::from_bits(*v)),
            P::Float64(v) => q.bind(f64::from_bits(*v)),
            P::Decimal(v) => q.bind(params::decimal(v)?),
            P::Boolean(v) => q.bind(*v),
            P::Binary(v) => q.bind(v.clone()),
            P::Null(kind) => match kind {
                ParamType::Text => q.bind(None::<String>),
                ParamType::Integer => q.bind(None::<i64>),
                ParamType::Unsigned => return Err(params::invalid()),
                ParamType::Float32 => q.bind(None::<f32>),
                ParamType::Float64 => q.bind(None::<f64>),
                ParamType::Decimal => q.bind(None::<bigdecimal::BigDecimal>),
                ParamType::Boolean => q.bind(None::<bool>),
                ParamType::Binary => q.bind(None::<Vec<u8>>),
            },
        };
    }
    Ok(q)
}
pub(super) fn sqlite<'q>(mut q: Query<'q, Sqlite, SqliteArguments>, values: &[P]) -> Result<Query<'q, Sqlite, SqliteArguments>, sqlx::Error> {
    for value in values {
        q = match value {
            P::S(v) => q.bind(v.clone()),
            P::I(v) => q.bind(*v),
            P::Float64(v) => q.bind(f64::from_bits(*v)),
            P::Boolean(v) => q.bind(*v),
            P::Binary(v) => q.bind(v.clone()),
            P::Unsigned(_) | P::Float32(_) | P::Decimal(_) => return Err(params::invalid()),
            P::Null(kind) => match kind {
                ParamType::Text => q.bind(None::<String>),
                ParamType::Integer => q.bind(None::<i64>),
                ParamType::Float64 => q.bind(None::<f64>),
                ParamType::Boolean => q.bind(None::<bool>),
                ParamType::Binary => q.bind(None::<Vec<u8>>),
                ParamType::Unsigned | ParamType::Float32 | ParamType::Decimal => return Err(params::invalid()),
            },
        };
    }
    Ok(q)
}
