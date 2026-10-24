use super::{P, ParamType, params};
use polyspec_orm::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::{MySql, Postgres, Sqlite, mysql::MySqlArguments, postgres::PgArguments, query::Query, sqlite::SqliteArguments};

pub(super) fn postgres_types(values: &[P]) -> Result<Vec<sqlx::postgres::PgTypeInfo>, sqlx::Error> {
    use sqlx::Type;
    values
        .iter()
        .map(|value| {
            let kind = value.param_type();
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

macro_rules! bind_values {
    (@unsigned mysql $q:ident $value:ident) => { $q.bind(*$value) };
    (@unsigned postgres $q:ident $value:ident) => {{ let _ = $value; return Err(params::invalid()) }};
    (@null_unsigned mysql $q:ident) => { $q.bind(None::<u64>) };
    (@null_unsigned postgres $q:ident) => { return Err(params::invalid()) };
    ($kind:ident, $q:ident, $values:expr) => {{
    for value in $values {
        $q = match value {
            P::S(v) => $q.bind(v.clone()),
            P::I(v) => $q.bind(*v),
            P::Unsigned(v) => bind_values!(@unsigned $kind $q v),
            P::Float32(v) => $q.bind(f32::from_bits(*v)),
            P::Float64(v) => $q.bind(f64::from_bits(*v)),
            P::Decimal(v) => $q.bind(params::decimal(v)?),
            P::Boolean(v) => $q.bind(*v),
            P::Binary(v) => $q.bind(v.clone()),
            P::Date(v) => $q.bind(params::date(v)?),
            P::Time(v) => $q.bind(params::time(v)?),
            P::DateTime(v) => $q.bind(params::datetime(v)?),
            P::Null(kind) => match kind {
                ParamType::Date => $q.bind(None::<NaiveDate>),
                ParamType::Time => $q.bind(None::<NaiveTime>),
                ParamType::DateTime => $q.bind(None::<NaiveDateTime>),
                ParamType::Text => $q.bind(None::<String>),
                ParamType::Integer => $q.bind(None::<i64>),
                ParamType::Unsigned => bind_values!(@null_unsigned $kind $q),
                ParamType::Float32 => $q.bind(None::<f32>),
                ParamType::Float64 => $q.bind(None::<f64>),
                ParamType::Decimal => $q.bind(None::<bigdecimal::BigDecimal>),
                ParamType::Boolean => $q.bind(None::<bool>),
                ParamType::Binary => $q.bind(None::<Vec<u8>>),
            },
        };
    }
    Ok($q)
    }};
}

pub(super) fn mysql<'q>(mut q: Query<'q, MySql, MySqlArguments>, values: &[P]) -> Result<Query<'q, MySql, MySqlArguments>, sqlx::Error> {
    bind_values!(mysql, q, values)
}
pub(super) fn postgres<'q>(mut q: Query<'q, Postgres, PgArguments>, values: &[P]) -> Result<Query<'q, Postgres, PgArguments>, sqlx::Error> {
    bind_values!(postgres, q, values)
}
pub(super) fn sqlite<'q>(mut q: Query<'q, Sqlite, SqliteArguments>, values: &[P]) -> Result<Query<'q, Sqlite, SqliteArguments>, sqlx::Error> {
    for value in values {
        q = match value {
            P::S(v) => q.bind(v.clone()),
            P::I(v) => q.bind(*v),
            P::Float64(v) => q.bind(f64::from_bits(*v)),
            P::Boolean(v) => q.bind(*v),
            P::Binary(v) => q.bind(v.clone()),
            // SQLite has no temporal storage class, so the dbspec text is written as is.
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
