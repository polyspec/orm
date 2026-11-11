//! Database driver adapters: binding, fetching, executing, and the relation
//! parent-value expansion shared by every statement.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ops::{Deref, DerefMut};

use chrono::{NaiveDate, NaiveDateTime};
use sqlx::mysql::{MySql, MySqlPool, MySqlRow};
use sqlx::postgres::{PgPool, PgRow, PgTypeInfo, Postgres};
use sqlx::sqlite::{Sqlite, SqlitePool, SqliteRow};
use sqlx::Executor;

use crate::collection::Key;
use crate::db::Pool;
use crate::db::Zone;
use crate::plan::{Assemble, BindSlot, ParentRef, Plan, Step};
use crate::row::{decode_boolean_columns, decode_styled, read_cell, read_row, DriverRow};
use crate::value::{Param, Val};
use crate::{Error, Result};
pub const NOW_MASK: &str = "$NOW";

/// Compares a row value with a bound parameter regardless of representation
/// (bool vs int, driver width): both are reduced to the same canonical text.
pub(crate) fn same_scalar(v: &Val, p: &Param) -> Result<bool> {
    if matches!(v, Val::Null) {
        return Ok(matches!(p, Param::Null));
    }
    let a = v.as_string()?;
    let b = match p {
        Param::Null => return Ok(false),
        Param::Bool(b) => (*b as i64).to_string(),
        Param::I64(x) => x.to_string(),
        Param::F64(x) => x.to_string(),
        Param::Str(s) => s.clone(),
        Param::Bytes(b) => std::str::from_utf8(b)
            .map_err(|error| Error::Engine {
                code: crate::codes::CODEC_DECODE.into(),
                msg: format!("relation key bytes are not UTF-8: {error}"),
                source: None,
            })?
            .to_owned(),
        Param::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        Param::Date(d) => d.to_string(),
    };
    Ok(a == b)
}

/// Distinct non-null values a relation step binds, first-seen order, from the
/// parent rows that pass `if_parent`.
pub(crate) fn parent_values<'a>(pr: &ParentRef, parents: impl Iterator<Item = &'a [Val]>, params: &[Param]) -> crate::Result<Vec<Param>> {
    let mut seen: std::collections::HashSet<Key> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in parents {
        if let Some(ifp) = &pr.if_parent {
            if !same_scalar(&row[ifp.index], &params[ifp.param])? {
                continue;
            }
        }
        let Some(key) = Key::of_row(row, &pr.keys)? else {
            continue;
        };
        if seen.insert(key) {
            for reference in &pr.keys {
                let v = &row[reference.index];
                out.push(match v {
                    Val::I64(x) => Param::I64(*x),
                    Val::Str(s) => Param::Str(s.clone()),
                    Val::Bytes(b) => Param::Bytes(b.clone()),
                    Val::Bool(b) => Param::Bool(*b),
                    Val::F64(x) => Param::F64(*x),
                    Val::DateTime(t) => Param::DateTime(*t),
                    Val::Date(d) => Param::Date(*d),
                    Val::Json(j) => Param::Str(j.to_string()),
                    Val::Ordered(j) => Param::Str(crate::codec::ordered_text(j)),
                    Val::Null => Param::Null,
                });
            }
        }
    }
    Ok(out)
}

/// Rewrites the step's single `parent` placeholder into n placeholders. n is
/// rounded up to a power of two (values padded by repetition) so the prepared
/// statement cache holds one statement per size class. On PostgreSQL the plan has one
/// `$k` per slot in slot order: the parent slot becomes n placeholders and every later
/// number shifts by n-1 (docs/spec/dialects.md).
pub(crate) fn expand_in(st: &Step, mut vals: Vec<Param>, numbered: bool, parent_slot: usize) -> Result<(String, Vec<Param>)> {
    let width = st.parent.as_ref().map(|p| p.keys.len()).unwrap_or(0);
    assert!(width > 0 && vals.len().is_multiple_of(width), "invalid relation parent key values");
    let tuples = vals.len() / width;
    let mut n = 1;
    while n < tuples {
        n <<= 1;
    }
    let last = vals[(tuples - 1) * width..tuples * width].to_vec();
    while vals.len() < n * width {
        vals.extend(last.iter().cloned());
    }
    let mut sql = String::with_capacity(st.sql.len() + 4 * n);
    if numbered {
        let parent = parent_slot + 1;
        let bytes = st.sql.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != b'$' {
                // copy one UTF-8 scalar (identifiers may carry any text)
                let ch = st.sql[i..].chars().next().unwrap();
                sql.push(ch);
                i += ch.len_utf8();
                continue;
            }
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j == i + 1 {
                sql.push('$');
                i += 1;
                continue;
            }
            let k: usize = st.sql[i + 1..j].parse().map_err(|error| Error::Config(format!("placeholder {} is not a slot index: {error}", &st.sql[i..j])))?;
            if k == parent {
                for m in 0..n * width {
                    if m > 0 {
                        if width > 1 && m % width == 0 {
                            sql.push_str("), (");
                        } else {
                            sql.push_str(", ");
                        }
                    }
                    sql.push_str(&format!("${}", k + m));
                }
            } else if k > parent {
                sql.push_str(&format!("${}", k + n * width - 1));
            } else {
                sql.push_str(&st.sql[i..j]);
            }
            i = j;
        }
        return Ok((sql, vals));
    }
    let mut slot = 0;
    for c in st.sql.chars() {
        if c != '?' {
            sql.push(c);
            continue;
        }
        if st.bind_slots[slot].from == "parent" {
            sql.push('?');
            for m in 1..n * width {
                if width > 1 && m % width == 0 {
                    sql.push_str("), (?");
                } else {
                    sql.push_str(", ?");
                }
            }
        } else {
            sql.push('?');
        }
        slot += 1;
    }
    Ok((sql, vals))
}

/// The value a `param` slot binds: the request parameter, transformed when the slot says so.
pub(crate) fn param_arg(b: &BindSlot, params: &[Param]) -> Result<Param> {
    let v = &params[b.param];
    if b.transform.is_empty() {
        return Ok(v.clone());
    }
    crate::bind_check::transform_param(&b.transform, v)
}

/// The hook's view of the binds: `now` slots masked, everything else as bound.
pub(crate) fn masked(st: &Step, args: &[Param], n_parent: usize) -> Vec<Param> {
    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    for b in &st.bind_slots {
        match b.from.as_str() {
            "parent" => {
                out.extend_from_slice(&args[i..i + n_parent]);
                i += n_parent;
            }
            "now" => {
                out.push(Param::Str(NOW_MASK.into()));
                i += 1;
            }
            _ => {
                out.push(args[i].clone());
                i += 1;
            }
        }
    }
    out
}

/// Finds the match column of a relation step from the child spec that references it.
pub(crate) fn child_keys(plan: &Plan, id: u32) -> Vec<crate::plan::KeyRef> {
    fn find(a: &Assemble, id: u32) -> Option<Vec<crate::plan::KeyRef>> {
        for ch in &a.children {
            if ch.kind != "join" && ch.step == id {
                return Some(ch.child_keys.clone());
            }
            if let Some(ja) = &ch.assemble {
                if let Some(i) = find(ja, id) {
                    return Some(i);
                }
            }
        }
        None
    }
    plan.steps.iter().filter_map(|s| s.assemble.as_deref()).find_map(|a| find(a, id)).expect("relation step without a child spec")
}

/// The dbspec type of each bind value the step sends. The parent slot covers the `n_parent` expanded parent values with its key
/// types, repeated in key order.
pub(crate) fn arg_types(st: &Step, n_parent: usize) -> Vec<&str> {
    let mut out = Vec::with_capacity(st.bind_slots.len() + n_parent);
    for b in &st.bind_slots {
        if b.from == "parent" {
            out.extend(b.key_types.iter().map(String::as_str).cycle().take(n_parent));
        } else {
            out.push(b.col_type.as_str());
        }
    }
    out
}

/// A parameter that PostgreSQL reads in the binary form of the type with this oid, the bytes the value holds.
macro_rules! pg_binary_param {
    ($name:ident, $oid:literal) => {
        impl sqlx::Type<Postgres> for $name {
            fn type_info() -> PgTypeInfo {
                PgTypeInfo::with_oid(sqlx::postgres::types::Oid($oid))
            }
        }

        impl sqlx::Encode<'_, Postgres> for $name {
            fn encode_by_ref(&self, buf: &mut sqlx::postgres::PgArgumentBuffer) -> std::result::Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
                buf.extend_from_slice(&self.0);
                Ok(sqlx::encode::IsNull::No)
            }
        }
    };
}

/// A PostgreSQL `uuid` value. The binary form is 16 bytes.
struct PgUuid([u8; 16]);

impl PgUuid {
    /// Reads the canonical text with hyphens (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
    fn parse(text: &str) -> Option<PgUuid> {
        let hex: String = text.chars().filter(|c| *c != '-').collect();
        if text.len() != 36 || hex.len() != 32 || [8, 13, 18, 23].iter().any(|&i| text.as_bytes()[i] != b'-') {
            return None;
        }
        let mut out = [0u8; 16];
        for (i, byte) in out.iter_mut().enumerate() {
            // Text that is not two hex digits in a pair is not a UUID, which is the answer this function gives.
            let pair = hex.get(2 * i..2 * i + 2)?;
            let Ok(value) = u8::from_str_radix(pair, 16) else {
                return None;
            };
            *byte = value;
        }
        Some(PgUuid(out))
    }
}

pg_binary_param!(PgUuid, 2950);

/// A PostgreSQL `numeric` value in its binary form, from a text of any number of digits (DIA-219).
struct PgNumeric(Vec<u8>);

pg_binary_param!(PgNumeric, 1700);

macro_rules! bind_param {
    ($query:expr, $param:expr) => {
        match $param {
            Param::Null => $query.bind(Option::<i64>::None),
            Param::Bool(value) => $query.bind(*value),
            Param::I64(value) => $query.bind(*value),
            Param::F64(value) => $query.bind(*value),
            Param::Str(value) => $query.bind(value.as_str()),
            Param::Bytes(value) => $query.bind(value.as_slice()),
            Param::DateTime(value) => $query.bind(*value),
            Param::Date(value) => $query.bind(*value),
        }
    };
}

pub(crate) fn bind_mysql<'q>(q: MySqlQuery<'q>, p: &'q Param) -> MySqlQuery<'q> {
    bind_param!(q, p)
}

/// SQLite is dynamically typed: values bind as they are (datetimes already as text, see `args`).
pub(crate) fn bind_sqlite<'q>(q: SqliteQuery<'q>, p: &'q Param) -> SqliteQuery<'q> {
    bind_param!(q, p)
}

/// A datetime from the text forms a caller binds (the same layouts Go's AsTime accepts).
pub(crate) fn parse_datetime(s: &str) -> std::result::Result<NaiveDateTime, String> {
    let s = s.trim();
    // The accepted forms, in order: a space or a T between date and time, then an RFC 3339 instant, then a date alone.
    if let Ok(t) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f") {
        return Ok(t);
    }
    if let Ok(t) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
        return Ok(t);
    }
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(t.naive_utc());
    }
    match NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        Ok(d) => Ok(d.and_hms_opt(0, 0, 0).unwrap()),
        Err(error) => Err(format!("{s} is not a datetime in an accepted form: {error}", s = polyspec_orm_schema::message::Quoted(&s))),
    }
}

/// Binds value `p` as the dbspec type `ty` the plan declared. sqlx declares the PostgreSQL type of that Rust type
/// as the parameter type, so it does not ask the server for the type. A value that cannot be that type is CONFIG.
pub(crate) fn bind_pg<'q>(q: PgQuery<'q>, p: &'q Param, ty: &str, i: usize) -> Result<PgQuery<'q>> {
    let name = ty;
    let bad = || Error::Config(format!("postgres parameter ${} is {name}: cannot bind {p:?}", i + 1));
    let bad_with = |error: &dyn std::fmt::Display| Error::Config(format!("postgres parameter ${} is {name}: cannot bind {p:?}: {error}", i + 1));
    macro_rules! int {
        ($t:ty) => {
            match p {
                Param::Null => q.bind(Option::<$t>::None),
                Param::I64(x) => q.bind(<$t>::try_from(*x).map_err(|error| bad_with(&error))?),
                Param::Bool(b) => q.bind(*b as $t),
                Param::Str(s) => q.bind(s.trim().parse::<$t>().map_err(|error| bad_with(&error))?),
                Param::F64(x) if x.fract() == 0.0 => q.bind(<$t>::try_from(*x as i64).map_err(|error| bad_with(&error))?),
                _ => return Err(bad()),
            }
        };
    }
    macro_rules! float {
        ($t:ty) => {
            match p {
                Param::Null => q.bind(Option::<$t>::None),
                Param::F64(x) => q.bind(*x as $t),
                Param::I64(x) => q.bind(*x as $t),
                Param::Str(s) => q.bind(s.trim().parse::<$t>().map_err(|error| bad_with(&error))?),
                _ => return Err(bad()),
            }
        };
    }
    Ok(match name {
        "i16" => int!(i16),
        "i32" => int!(i32),
        "i64" => int!(i64),
        "f64" => float!(f64),
        // The number that the text names, whatever its number of digits, as PostgreSQL reads that text (DIA-219).
        "decimal" => {
            let text = match p {
                Param::Null => return Ok(q.bind(Option::<PgNumeric>::None)),
                Param::F64(x) => x.to_string(),
                Param::I64(x) => x.to_string(),
                Param::Str(s) => s.clone(),
                _ => return Err(bad()),
            };
            q.bind(PgNumeric(crate::row::numeric_text_binary(&text).map_err(|code| {
                bad_with(&if code == crate::row::NUMERIC_OUT_OF_RANGE {
                    "PostgreSQL reads the text as a numeric past the range of the type"
                } else {
                    "PostgreSQL reads no numeric from the text"
                })
            })?))
        }
        "bool" => match p {
            Param::Null => q.bind(Option::<bool>::None),
            Param::Bool(b) => q.bind(*b),
            Param::I64(x) => q.bind(*x != 0),
            Param::Str(s) => q.bind(matches!(s.trim(), "1" | "true" | "t" | "TRUE")),
            _ => return Err(bad()),
        },
        "varchar" | "text" => match p {
            Param::Null => q.bind(Option::<&str>::None),
            Param::Str(s) => q.bind(s.as_str()),
            Param::I64(x) => q.bind(x.to_string()),
            Param::F64(x) => q.bind(x.to_string()),
            Param::Bool(b) => q.bind(b.to_string()),
            Param::DateTime(t) => q.bind(t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
            Param::Date(d) => q.bind(d.to_string()),
            Param::Bytes(b) => q.bind(std::str::from_utf8(b).map_err(|error| bad_with(&error))?),
        },
        "datetime" => match p {
            Param::Null => q.bind(Option::<NaiveDateTime>::None),
            Param::DateTime(t) => q.bind(*t),
            Param::Date(d) => q.bind(d.and_hms_opt(0, 0, 0).unwrap()),
            Param::Str(s) => q.bind(parse_datetime(s).map_err(|error| bad_with(&error))?),
            _ => return Err(bad()),
        },
        "date" => match p {
            Param::Null => q.bind(Option::<NaiveDate>::None),
            Param::Date(d) => q.bind(*d),
            Param::DateTime(t) => q.bind(t.date()),
            Param::Str(s) => q.bind(parse_datetime(s).map_err(|error| bad_with(&error))?.date()),
            _ => return Err(bad()),
        },
        "time" => match p {
            Param::Null => q.bind(Option::<chrono::NaiveTime>::None),
            Param::Str(s) => q.bind(chrono::NaiveTime::parse_from_str(s.trim(), "%H:%M:%S%.f").map_err(|error| bad_with(&error))?),
            _ => return Err(bad()),
        },
        "bytes" => match p {
            Param::Null => q.bind(Option::<&[u8]>::None),
            Param::Bytes(b) => q.bind(b.as_slice()),
            Param::Str(s) => q.bind(s.as_bytes()),
            _ => return Err(bad()),
        },
        "uuid" => match p {
            Param::Null => q.bind(Option::<PgUuid>::None),
            Param::Str(s) => q.bind(PgUuid::parse(s.trim()).ok_or_else(bad)?),
            _ => return Err(bad()),
        },
        other => return Err(Error::Config(format!("postgres parameter ${} has type {other}, which the executor cannot bind", i + 1))),
    })
}

pub(crate) async fn fetch_mysql<'e, E: Executor<'e, Database = MySql>>(sql: &str, args: &[Param], e: E) -> sqlx::Result<Vec<MySqlRow>> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_mysql(q, a);
    }
    q.fetch_all(e).await
}

pub(crate) async fn fetch_mysql_pool(sql: &str, args: &[Param], pool: &MySqlPool) -> sqlx::Result<Vec<MySqlRow>> {
    let mut connection = CancellableConnection::new(pool.acquire().await?);
    let result = fetch_mysql(sql, args, &mut *connection).await;
    if result.is_ok() {
        connection.returned().await;
    }
    result
}

pub(crate) async fn exec_mysql<'e, E: Executor<'e, Database = MySql>>(sql: &str, args: &[Param], e: E) -> sqlx::Result<(u64, u64)> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_mysql(q, a);
    }
    let r = q.execute(e).await?;
    Ok((r.last_insert_id(), r.rows_affected()))
}

pub(crate) async fn exec_mysql_pool(sql: &str, args: &[Param], pool: &MySqlPool) -> sqlx::Result<(u64, u64)> {
    let mut connection = CancellableConnection::new(pool.acquire().await?);
    let result = exec_mysql(sql, args, &mut *connection).await;
    if result.is_ok() {
        connection.returned().await;
    }
    result
}

pub(crate) fn pg_query<'q>(sql: &str, args: &'q [Param], types: &[&str]) -> Result<PgQuery<'q>> {
    pg_query_read(sql, args, types, &[])
}

/// The query of `sql` with each parameter bound as its type, or as the value of `read` at its position, which the server
/// read from the text of the parameter.
fn pg_query_read<'q>(sql: &str, args: &'q [Param], types: &[&str], read: &'q [Option<PgRead>]) -> Result<PgQuery<'q>> {
    if types.len() != args.len() {
        return Err(Error::internal(format!("the plan types {} parameters and binds {}", types.len(), args.len())));
    }
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for (i, (a, ty)) in args.iter().zip(types).enumerate() {
        q = match read.get(i) {
            Some(Some(value)) => q.bind(value),
            _ => bind_pg(q, a, ty, i)?,
        };
    }
    Ok(q)
}

/// A parameter value that PostgreSQL read from its text as the type it infers for the parameter: the binary form that
/// the server returned, of that type, or None for NULL.
pub(crate) struct PgRead {
    oid: sqlx::postgres::types::Oid,
    bytes: Option<Vec<u8>>,
}

impl sqlx::Type<Postgres> for PgRead {
    fn type_info() -> PgTypeInfo {
        PgTypeInfo::with_oid(sqlx::postgres::types::Oid(25))
    }
    fn compatible(_: &PgTypeInfo) -> bool {
        true
    }
}

impl sqlx::Encode<'_, Postgres> for PgRead {
    fn encode_by_ref(&self, buf: &mut sqlx::postgres::PgArgumentBuffer) -> std::result::Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        match &self.bytes {
            Some(bytes) => {
                buf.extend_from_slice(bytes);
                Ok(sqlx::encode::IsNull::No)
            }
            None => Ok(sqlx::encode::IsNull::Yes),
        }
    }
    fn produces(&self) -> Option<PgTypeInfo> {
        Some(PgTypeInfo::with_oid(self.oid))
    }
}

pub(crate) async fn fetch_pg<'e, E: Executor<'e, Database = Postgres>>(sql: &str, args: &[Param], types: &[&str], e: E) -> Result<Vec<PgRow>> {
    Ok(pg_query(sql, args, types)?.fetch_all(e).await?)
}

/// An error that a named statement from before a schema change can raise: the result type changed (0A000), a parameter keeps its old
/// type against the new column (42883, 42804), or a value is read as that old type (22P02, 22003, 22007, 22008). A statement outside a
/// transaction that fails has changed nothing, so it can run again, and one that fails for another reason fails the same way the
/// second time (CFG-28).
pub fn stale_plan(error: &sqlx::Error) -> bool {
    let Some(database) = error.as_database_error() else {
        return false;
    };
    match database.code().as_deref() {
        Some("0A000") => database.message().contains("cached plan must not change result type"),
        Some("42883" | "42804" | "22P02" | "22003" | "22007" | "22008") => true,
        _ => false,
    }
}

/// Opens the one transaction in which a statement that failed with stale_plan runs again. The transaction holds one server connection
/// through PgBouncer, and DEALLOCATE ALL makes the server parse the statement after the change on it; the connection forgets its names
/// first, while PgBouncer still lists them. A failure leaves the connection uncompleted, so it closes with its transaction.
async fn begin_again(connection: &mut sqlx::PgConnection) -> Result<()> {
    sqlx::raw_sql("BEGIN").execute(&mut *connection).await?;
    sqlx::Connection::clear_cached_statements(&mut *connection).await?;
    sqlx::raw_sql("DEALLOCATE ALL").execute(&mut *connection).await?;
    Ok(())
}

/// Ends that transaction. The connection forgets the statement that ran with the inferred types, so the next run declares the types
/// of its model again.
async fn commit_again(connection: &mut sqlx::PgConnection) -> Result<()> {
    sqlx::Connection::clear_cached_statements(&mut *connection).await?;
    sqlx::raw_sql("COMMIT").execute(connection).await?;
    Ok(())
}

/// The type of a parameter of a statement that runs again: the binding of the type the server infers (CFG-28), its
/// PostgreSQL type, and whether that type has no binding of its own, so that the parameter keeps the binding of the model.
struct Inferred {
    ty: String,
    oid: Option<sqlx::postgres::types::Oid>,
    unmapped: bool,
}

/// The type of each parameter when the statement runs again. Each binding declares its type from the model, and a Parse with the
/// declared type of a column that the schema change gave another type would fail again, so the statement is parsed with the types
/// that the server infers and each value is bound as that type (CFG-28). sqlx sends every value in binary format, so a value cannot
/// stay text with an undeclared type; a value of another type than the declared one is the value the server reads from its text
/// (server_read). A type without a binding of its own keeps the binding of the model.
async fn inferred_types(sql: &str, declared: &[&str], connection: &mut sqlx::PgConnection) -> Result<Vec<Inferred>> {
    use sqlx::{SqlSafeStr, Statement, TypeInfo};
    let statement = (&mut *connection).prepare_with(sqlx::AssertSqlSafe(sql.to_owned()).into_sql_str(), &[]).await?;
    let inferred = match statement.parameters() {
        Some(sqlx::Either::Left(inferred)) if inferred.len() == declared.len() => inferred,
        _ => return Ok(declared.iter().map(|&ty| Inferred { ty: ty.to_owned(), oid: None, unmapped: false }).collect()),
    };
    Ok(declared
        .iter()
        .zip(inferred)
        .map(|(&ty, info)| {
            let mapped = match info.name() {
                "INT2" => Some("i16"),
                "INT4" => Some("i32"),
                "INT8" => Some("i64"),
                "FLOAT8" => Some("f64"),
                "NUMERIC" => Some("decimal"),
                "BOOL" => Some("bool"),
                "VARCHAR" => Some("varchar"),
                "TEXT" => Some("text"),
                "TIMESTAMP" => Some("datetime"),
                "DATE" => Some("date"),
                _ => None,
            };
            Inferred { ty: mapped.unwrap_or(ty).to_owned(), oid: info.oid(), unmapped: mapped.is_none() }
        })
        .collect())
}

/// The text of a value as PostgreSQL reads a parameter sent as text, as every client but Rust sends it, or None for a
/// value with no such text.
fn param_text(p: &Param) -> Option<String> {
    Some(match p {
        Param::Str(s) => s.clone(),
        Param::I64(x) => x.to_string(),
        Param::F64(x) => x.to_string(),
        Param::Bool(b) => b.to_string(),
        Param::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        Param::Date(d) => d.to_string(),
        Param::Null | Param::Bytes(_) => return None,
    })
}

/// The value of each parameter of a statement that runs again after a schema change whose type PostgreSQL now infers
/// as another than the plan declared (CFG-28): the server reads the text of a text parameter, or of a value that the
/// binding of the inferred type does not take, as the inferred type, as it reads the text that every other client
/// sends. So a text that the inferred type does not read fails with the DRIVER error of PostgreSQL, 22P02 or 22003
/// among them, as in every client, and a text that it reads is the value the server read, by the input rules and the
/// settings of that connection. A parameter of the declared type keeps its binding.
async fn server_read(args: &[Param], declared: &[&str], inferred: &[Inferred], connection: &mut sqlx::PgConnection) -> Result<Vec<Option<PgRead>>> {
    use sqlx::Row as _;
    let mut out = Vec::with_capacity(args.len());
    for (i, ((arg, &declared), inferred)) in args.iter().zip(declared).zip(inferred).enumerate() {
        let retyped = inferred.ty != declared || inferred.unmapped;
        let text = match (retyped, inferred.oid, arg) {
            (true, Some(_), Param::Str(text)) => Some(text.clone()),
            (true, Some(_), arg) if bind_pg(sqlx::query(""), arg, &inferred.ty, i).is_err() => param_text(arg),
            _ => None,
        };
        let (Some(text), Some(oid)) = (text, inferred.oid) else {
            out.push(None);
            continue;
        };
        let name: String = sqlx::query_scalar("SELECT format_type($1, NULL)").bind(oid).fetch_one(&mut *connection).await?;
        let row = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT CAST($1 AS {name})"))).bind(text).fetch_one(&mut *connection).await?;
        let raw = row.try_get_raw(0)?;
        let bytes = if sqlx::ValueRef::is_null(&raw) {
            None
        } else {
            Some(raw.as_bytes().map_err(|error| Error::internal(format!("the server read parameter ${} with no bytes: {error}", i + 1)))?.to_vec())
        };
        out.push(Some(PgRead { oid, bytes }));
    }
    Ok(out)
}

/// The retry of a statement whose plan went stale: a new transaction, the parameter types that the server infers now, and
/// the reads of the arguments that those types need.
async fn replanned(sql: &str, args: &[Param], types: &[&str], connection: &mut sqlx::PgConnection) -> Result<(Vec<String>, Vec<Option<PgRead>>)> {
    begin_again(connection).await?;
    let inferred = inferred_types(sql, types, connection).await?;
    let read = server_read(args, types, &inferred, connection).await?;
    Ok((inferred.into_iter().map(|inferred| inferred.ty).collect(), read))
}

pub(crate) async fn fetch_pg_pool(sql: &str, args: &[Param], types: &[&str], pool: &PgPool) -> Result<Vec<PgRow>> {
    let mut connection = CancellableConnection::new(pool.acquire().await?);
    let result = match pg_query(sql, args, types)?.fetch_all(&mut *connection).await {
        Err(error) if stale_plan(&error) => {
            let (inferred, read) = replanned(sql, args, types, &mut connection).await?;
            let inferred: Vec<&str> = inferred.iter().map(String::as_str).collect();
            let rows = pg_query_read(sql, args, &inferred, &read)?.fetch_all(&mut *connection).await?;
            commit_again(&mut connection).await?;
            Ok(rows)
        }
        result => result.map_err(Error::from),
    };
    if result.is_ok() {
        connection.returned().await;
    }
    result
}

pub(crate) async fn exec_pg<'e, E: Executor<'e, Database = Postgres>>(sql: &str, args: &[Param], types: &[&str], e: E) -> Result<(u64, u64)> {
    let r = pg_query(sql, args, types)?.execute(e).await?;
    Ok((0, r.rows_affected()))
}

pub(crate) async fn exec_pg_pool(sql: &str, args: &[Param], types: &[&str], pool: &PgPool) -> Result<(u64, u64)> {
    let mut connection = CancellableConnection::new(pool.acquire().await?);
    let result = match pg_query(sql, args, types)?.execute(&mut *connection).await {
        Err(error) if stale_plan(&error) => {
            let (inferred, read) = replanned(sql, args, types, &mut connection).await?;
            let inferred: Vec<&str> = inferred.iter().map(String::as_str).collect();
            let done = pg_query_read(sql, args, &inferred, &read)?.execute(&mut *connection).await?;
            commit_again(&mut connection).await?;
            Ok((0, done.rows_affected()))
        }
        result => result.map(|done| (0, done.rows_affected())).map_err(Error::from),
    };
    if result.is_ok() {
        connection.returned().await;
    }
    result
}

pub(crate) async fn fetch_sqlite<'e, E: Executor<'e, Database = Sqlite>>(sql: &str, args: &[Param], e: E) -> sqlx::Result<Vec<SqliteRow>> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_sqlite(q, a);
    }
    q.fetch_all(e).await
}

pub(crate) async fn fetch_sqlite_pool(sql: &str, args: &[Param], pool: &SqlitePool) -> sqlx::Result<Vec<SqliteRow>> {
    let mut connection = CancellableConnection::new(pool.acquire().await?);
    let result = fetch_sqlite(sql, args, &mut *connection).await;
    if result.is_ok() {
        connection.returned().await;
    }
    result
}

pub(crate) async fn exec_sqlite<'e, E: Executor<'e, Database = Sqlite>>(sql: &str, args: &[Param], e: E) -> sqlx::Result<(u64, u64)> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_sqlite(q, a);
    }
    let r = q.execute(e).await?;
    Ok((r.last_insert_rowid() as u64, r.rows_affected()))
}

pub(crate) async fn exec_sqlite_pool(sql: &str, args: &[Param], pool: &SqlitePool) -> sqlx::Result<(u64, u64)> {
    let mut connection = CancellableConnection::new(pool.acquire().await?);
    let result = exec_sqlite(sql, args, &mut *connection).await;
    if result.is_ok() {
        connection.returned().await;
    }
    result
}

/// The statement text of a step: the plan's SQL as is, or with its `parent` placeholder expanded.
pub(crate) fn statement(st: &Step, parent_vals: Vec<Param>, numbered: bool) -> Result<(Cow<'_, str>, Vec<Param>)> {
    if parent_vals.is_empty() {
        if st.role == "relation" || st.parent.is_some() {
            parent_bind_slot(st)?;
        }
        Ok((Cow::Borrowed(st.sql.as_str()), parent_vals))
    } else {
        let parent_slot = parent_bind_slot(st)?;
        let (sql, vals) = expand_in(st, parent_vals, numbered, parent_slot)?;
        Ok((Cow::Owned(sql), vals))
    }
}

/// The relation step's single parent bind slot, in zero-based bind-slot order.
fn parent_bind_slot(st: &Step) -> Result<usize> {
    let mut parent_slot = None;
    let mut count = 0;
    for (index, bind) in st.bind_slots.iter().enumerate() {
        if bind.from == "parent" {
            parent_slot = Some(index);
            count += 1;
        }
    }
    if count != 1 {
        return Err(Error::Engine {
            code: crate::codes::IR_INVALID.into(),
            msg: format!("relation {} requires exactly one parent bind slot, found {count}", st.id),
            source: None,
        });
    }
    Ok(parent_slot.expect("a single parent bind slot has an index"))
}

pub(crate) fn relation_chunks(st: &Step, vals: Vec<Param>, driver: &str) -> Result<Vec<Vec<Param>>> {
    let width = st.parent.as_ref().map(|parent| parent.keys.len()).unwrap_or(0);
    if width == 0 || !vals.len().is_multiple_of(width) {
        return Err(Error::Engine { code: crate::codes::IR_INVALID.into(), msg: format!("relation {} has invalid parent key values", st.id), source: None });
    }
    let non_parent = st.bind_slots.iter().filter(|bind| bind.from != "parent").count();
    let limit: usize = if driver == "sqlite" { 999 } else { 65535 };
    let max_tuples = (limit.saturating_sub(non_parent)) / width;
    if max_tuples == 0 {
        return Err(Error::Engine {
            code: crate::codes::IR_INVALID.into(),
            msg: format!("relation {} needs at least {} bind parameters but {} permits {}", st.id, non_parent + width, driver, limit),
            source: None,
        });
    }
    let mut chunk_tuples = 1usize;
    while chunk_tuples.saturating_mul(2) <= max_tuples {
        chunk_tuples *= 2;
    }
    let tuples = vals.len() / width;
    let mut chunks = Vec::with_capacity(tuples.div_ceil(chunk_tuples));
    for start in (0..tuples).step_by(chunk_tuples) {
        let end = (start + chunk_tuples).min(tuples);
        chunks.push(vals[start * width..end * width].to_vec());
    }
    Ok(chunks)
}

#[cfg(test)]
#[path = "driver_parent_slot_tests.rs"]
mod parent_slot_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "../tests/unit/driver_cause.rs"]
mod cause_message_tests;

/// The first cell of the first row (Null when there is no row).
pub(crate) fn first_cell(rows: &[DriverRow], zone: Zone) -> Result<Val> {
    match rows.first() {
        Some(r) => read_cell(r, 0, zone),
        None => Ok(Val::Null),
    }
}

/// Driver rows as decoded positional rows: cells by column type, styled cells
/// through their host and codec stages.
pub(crate) fn positional(raw: &[DriverRow], asm: &Assemble, aes_keys: &BTreeMap<i32, String>, zone: Zone) -> Result<Vec<Vec<Val>>> {
    let n = asm.total_columns();
    let mut data: Vec<Vec<Val>> = raw.iter().map(|r| read_row(r, n, zone)).collect::<Result<_>>()?;
    decode_styled(asm, &mut data, aes_keys)?;
    if matches!(raw.first(), Some(DriverRow::MySql(_))) {
        decode_declared_text_columns(asm, &mut data)?;
    }
    decode_boolean_columns(asm, &mut data)?;
    crate::row::decode_uuid_columns(asm, &mut data, matches!(raw.first(), Some(DriverRow::Postgres(_))))?;
    Ok(data)
}

/// MySQL reports text columns with a binary collation as binary values. The plan's declared
/// type distinguishes those UTF-8 text values from actual byte columns without loosening bind
/// validation or changing the driver's decoding of unplanned rows.
fn decode_declared_text_columns(asm: &Assemble, data: &mut [Vec<Val>]) -> Result<()> {
    for column in asm.columns.iter().filter(|column| matches!(column.typ.as_str(), "varchar" | "text") && column.styles.is_empty()) {
        for row in data.iter_mut() {
            let value = row.get_mut(column.index).ok_or_else(|| Error::internal(format!("text column {} has no value", column.name)))?;
            if matches!(value, Val::Bytes(_)) {
                *value = Val::Str(value.take_string().map_err(|error| crate::model::column_decode_error(&asm.entity, &column.name, error))?);
            }
        }
    }
    Ok(())
}

/// The transaction of one pool.
pub(crate) enum TxInner {
    MySql(MySqlOwnedTx),
    Postgres(CancellableConnection<Postgres>),
    Sqlite(CancellableConnection<Sqlite>),
    /// The flowmark session held until the transaction ends.
    Markdown(crate::markdown::MarkdownLease),
}

/// Where a statement runs: the pool (each statement on its own) or a transaction's connection.
pub(crate) enum Target<'a> {
    Pool(&'a Pool),
    Tx(&'a mut TxInner),
}

/// A MySQL transaction whose pool connection is retained after the explicit
/// `SET TRANSACTION` and `START TRANSACTION` statements until its `COMMIT` or
/// `ROLLBACK`.
pub(crate) struct MySqlOwnedTx {
    pub(crate) conn: Option<CancellableConnection<MySql>>,
}

impl Drop for MySqlOwnedTx {
    fn drop(&mut self) {
        // The transaction future may be dropped while a statement is still
        // running. Sending ROLLBACK on that same protocol stream would wait
        // behind the statement; dropping the cancellable connection closes
        // it immediately so the server rolls the transaction back.
        drop(self.conn.take());
    }
}

pub(crate) type MySqlQuery<'q> = sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>;
pub(crate) type PgQuery<'q> = sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>;
pub(crate) type SqliteQuery<'q> = sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments>;

/// A checked-out pool connection is closed when its executor future is
/// dropped. SQLx otherwise may return a connection whose server statement is
/// still active to the pool.
pub(crate) struct CancellableConnection<DB: sqlx::Database> {
    connection: Option<sqlx::pool::PoolConnection<DB>>,
    close_on_drop: bool,
}

impl<DB: sqlx::Database> CancellableConnection<DB> {
    pub(crate) fn new(connection: sqlx::pool::PoolConnection<DB>) -> Self {
        Self { connection: Some(connection), close_on_drop: true }
    }

    /// Returns the completed connection to the pool before this call ends: the drop handler of SQLx returns it from a task
    /// of its own, and the pool statistics that follow must already count it as idle (INT-79).
    pub(crate) async fn returned(mut self) {
        self.close_on_drop = false;
        if let Some(mut connection) = self.connection.take() {
            connection.return_to_pool().await;
        }
    }
}

impl<DB: sqlx::Database> Deref for CancellableConnection<DB> {
    type Target = DB::Connection;

    fn deref(&self) -> &Self::Target {
        self.connection.as_ref().expect("cancellable connection is active").deref()
    }
}

impl<DB: sqlx::Database> DerefMut for CancellableConnection<DB> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.connection.as_mut().expect("cancellable connection is active").deref_mut()
    }
}

impl<DB: sqlx::Database> Drop for CancellableConnection<DB> {
    fn drop(&mut self) {
        if self.close_on_drop {
            if let Some(connection) = self.connection.take() {
                // The connection removed from the pool is dropped on the spot to close the socket. The server receives EOF and
                // ends the session's transaction and lock. close_hard flushes before shutdown, but sqlx's rustls
                // flush, if there is no data to send, waits until it reads data the server will not send, so it never finishes.
                // SQLite's close_hard is also a drop.
                drop(connection.detach());
            }
        }
    }
}
