use super::{params, ParamType, P};
use polyspec_orm::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::{mysql::MySqlArguments, postgres::PgArguments, query::Query, sqlite::SqliteArguments, MySql, Postgres, Sqlite};

pub(super) fn postgres_types(values: &[P]) -> Result<Vec<sqlx::postgres::PgTypeInfo>, sqlx::Error> {
    use sqlx::Type;
    values
        .iter()
        .map(|value| {
            let kind = match value {
                P::S(_) => ParamType::Text,
                P::I(_) => ParamType::Integer,
                P::Unsigned(_) => ParamType::Unsigned,
                P::Float32(_) => ParamType::Float32,
                P::Float64(_) => ParamType::Float64,
                P::Decimal(_) => ParamType::Decimal,
                P::Boolean(_) => ParamType::Boolean,
                P::Binary(_) => ParamType::Binary,
                P::Date(_) => ParamType::Date,
                P::Time(_) => ParamType::Time,
                P::DateTime(_) => ParamType::DateTime,
                P::Null(kind) => *kind,
            };
            Ok(match kind {
                ParamType::Text => <String as Type<Postgres>>::type_info(),
                ParamType::Integer => <i64 as Type<Postgres>>::type_info(),
                ParamType::Float32 => <f32 as Type<Postgres>>::type_info(),
                ParamType::Float64 => <f64 as Type<Postgres>>::type_info(),
                ParamType::Decimal => <bigdecimal::BigDecimal as Type<Postgres>>::type_info(),
                ParamType::Boolean => <bool as Type<Postgres>>::type_info(),
                ParamType::Binary => <Vec<u8> as Type<Postgres>>::type_info(),
                ParamType::Date => <NaiveDate as Type<Postgres>>::type_info(),
                ParamType::Time => <NaiveTime as Type<Postgres>>::type_info(),
                ParamType::DateTime => <NaiveDateTime as Type<Postgres>>::type_info(),
                ParamType::Unsigned => return Err(params::invalid()),
            })
        })
        .collect()
}

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
            P::Date(v) => q.bind(params::date(v)?),
            P::Time(v) => q.bind(params::time(v)?),
            P::DateTime(v) => q.bind(params::datetime(v)?),
            P::Null(kind) => match kind {
                ParamType::Date => q.bind(None::<NaiveDate>),
                ParamType::Time => q.bind(None::<NaiveTime>),
                ParamType::DateTime => q.bind(None::<NaiveDateTime>),
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
            P::Date(v) => q.bind(params::date(v)?),
            P::Time(v) => q.bind(params::time(v)?),
            P::DateTime(v) => q.bind(params::datetime(v)?),
            P::Null(kind) => match kind {
                ParamType::Date => q.bind(None::<NaiveDate>),
                ParamType::Time => q.bind(None::<NaiveTime>),
                ParamType::DateTime => q.bind(None::<NaiveDateTime>),
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
            // SQLite에는 temporal storage class가 없으므로 dbspec text를 그대로 쓴다.
            P::Date(v) | P::Time(v) | P::DateTime(v) => q.bind(v.clone()),
            P::Unsigned(_) | P::Float32(_) | P::Decimal(_) => return Err(params::invalid()),
            P::Null(kind) => match kind {
                ParamType::Text | ParamType::Date | ParamType::Time | ParamType::DateTime => q.bind(None::<String>),
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
