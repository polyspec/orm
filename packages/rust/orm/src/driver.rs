//! Database driver adapters: binding, fetching, executing, and the relation
//! parent-value expansion shared by every statement.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ops::{Deref, DerefMut};
use std::str::FromStr;

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

pub const SECRET_MASK: &str = "$SECRET";
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
            .map_err(|error| Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("relation key bytes are not UTF-8: {error}") })?
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
                    Val::Ordered(j) => Param::Str(j.compact()),
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
pub(crate) fn expand_in(st: &Step, mut vals: Vec<Param>, numbered: bool) -> Result<(String, Vec<Param>)> {
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
        let parent = st.bind_slots.iter().position(|b| b.from == "parent").map(|i| i + 1).unwrap_or(0);
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
            let k: usize = st.sql[i + 1..j]
                .parse()
                .map_err(|error| Error::Config(format!("placeholder {} is not a slot index: {error}", &st.sql[i..j])))?;
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

/// The hook's view of the binds: `secret` slots masked, everything else as bound.
pub(crate) fn masked(st: &Step, args: &[Param], n_parent: usize) -> Vec<Param> {
    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    for b in &st.bind_slots {
        match b.from.as_str() {
            "parent" => {
                out.extend_from_slice(&args[i..i + n_parent]);
                i += n_parent;
            }
            "secret" => {
                out.push(Param::Str(SECRET_MASK.into()));
                i += 1;
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

impl sqlx::Type<Postgres> for PgUuid {
    fn type_info() -> PgTypeInfo {
        PgTypeInfo::with_oid(sqlx::postgres::types::Oid(2950))
    }
}

impl sqlx::Encode<'_, Postgres> for PgUuid {
    fn encode_by_ref(&self, buf: &mut sqlx::postgres::PgArgumentBuffer) -> std::result::Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        buf.extend_from_slice(&self.0);
        Ok(sqlx::encode::IsNull::No)
    }
}

pub(crate) fn bind_mysql<'q>(q: MySqlQuery<'q>, p: &'q Param) -> MySqlQuery<'q> {
    match p {
        Param::Null => q.bind(Option::<i64>::None),
        Param::Bool(b) => q.bind(*b),
        Param::I64(x) => q.bind(*x),
        Param::F64(x) => q.bind(*x),
        Param::Str(s) => q.bind(s.as_str()),
        Param::Bytes(b) => q.bind(b.as_slice()),
        Param::DateTime(t) => q.bind(*t),
        Param::Date(d) => q.bind(*d),
    }
}

/// SQLite is dynamically typed: values bind as they are (datetimes already as text, see `args`).
pub(crate) fn bind_sqlite<'q>(q: SqliteQuery<'q>, p: &'q Param) -> SqliteQuery<'q> {
    match p {
        Param::Null => q.bind(Option::<i64>::None),
        Param::Bool(b) => q.bind(*b),
        Param::I64(x) => q.bind(*x),
        Param::F64(x) => q.bind(*x),
        Param::Str(s) => q.bind(s.as_str()),
        Param::Bytes(b) => q.bind(b.as_slice()),
        Param::DateTime(t) => q.bind(*t),
        Param::Date(d) => q.bind(*d),
    }
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
        Err(error) => Err(format!("{s:?} is not a datetime in an accepted form: {error}")),
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
        "decimal" => match p {
            Param::Null => q.bind(Option::<rust_decimal::Decimal>::None),
            Param::F64(x) => q.bind(rust_decimal::Decimal::try_from(*x).map_err(|error| bad_with(&error))?),
            Param::I64(x) => q.bind(rust_decimal::Decimal::from(*x)),
            Param::Str(s) => q.bind(rust_decimal::Decimal::from_str(s.trim()).map_err(|error| bad_with(&error))?),
            _ => return Err(bad()),
        },
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
        connection.completed();
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
        connection.completed();
    }
    result
}

pub(crate) fn pg_query<'q>(sql: &str, args: &'q [Param], types: &[&str]) -> Result<PgQuery<'q>> {
    if types.len() != args.len() {
        return Err(Error::internal(format!("the plan types {} parameters and binds {}", types.len(), args.len())));
    }
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for (i, (a, ty)) in args.iter().zip(types).enumerate() {
        q = bind_pg(q, a, ty, i)?;
    }
    Ok(q)
}

pub(crate) async fn fetch_pg<'e, E: Executor<'e, Database = Postgres>>(sql: &str, args: &[Param], types: &[&str], e: E) -> Result<Vec<PgRow>> {
    Ok(pg_query(sql, args, types)?.fetch_all(e).await?)
}

pub(crate) async fn fetch_pg_pool(sql: &str, args: &[Param], types: &[&str], pool: &PgPool) -> Result<Vec<PgRow>> {
    let mut connection = CancellableConnection::new(pool.acquire().await?);
    let result = fetch_pg(sql, args, types, &mut *connection).await;
    if result.is_ok() {
        connection.completed();
    }
    result
}

pub(crate) async fn exec_pg<'e, E: Executor<'e, Database = Postgres>>(sql: &str, args: &[Param], types: &[&str], e: E) -> Result<(u64, u64)> {
    let r = pg_query(sql, args, types)?.execute(e).await?;
    Ok((0, r.rows_affected()))
}

pub(crate) async fn exec_pg_pool(sql: &str, args: &[Param], types: &[&str], pool: &PgPool) -> Result<(u64, u64)> {
    let mut connection = CancellableConnection::new(pool.acquire().await?);
    let result = exec_pg(sql, args, types, &mut *connection).await;
    if result.is_ok() {
        connection.completed();
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
        connection.completed();
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
        connection.completed();
    }
    result
}

/// The statement text of a step: the plan's SQL as is, or with its `parent` placeholder expanded.
pub(crate) fn statement(st: &Step, parent_vals: Vec<Param>, numbered: bool) -> Result<(Cow<'_, str>, Vec<Param>)> {
    if parent_vals.is_empty() {
        Ok((Cow::Borrowed(st.sql.as_str()), parent_vals))
    } else {
        let (sql, vals) = expand_in(st, parent_vals, numbered)?;
        Ok((Cow::Owned(sql), vals))
    }
}

pub(crate) fn relation_chunks(st: &Step, vals: Vec<Param>, driver: &str) -> Result<Vec<Vec<Param>>> {
    let width = st.parent.as_ref().map(|parent| parent.keys.len()).unwrap_or(0);
    if width == 0 || !vals.len().is_multiple_of(width) {
        return Err(Error::Engine { code: crate::codes::IR_INVALID.into(), msg: format!("relation {} has invalid parent key values", st.id) });
    }
    let non_parent = st.bind_slots.iter().filter(|bind| bind.from != "parent").count();
    let limit: usize = if driver == "sqlite" { 999 } else { 65535 };
    let max_tuples = (limit.saturating_sub(non_parent)) / width;
    if max_tuples == 0 {
        return Err(Error::Engine {
            code: crate::codes::IR_INVALID.into(),
            msg: format!("relation {} needs at least {} bind parameters but {} permits {}", st.id, non_parent + width, driver, limit),
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
    decode_boolean_columns(asm, &mut data)?;
    Ok(data)
}

/// The transaction of one pool.
pub(crate) enum TxInner {
    MySql(MySqlOwnedTx),
    Postgres(CancellableConnection<Postgres>),
    Sqlite(CancellableConnection<Sqlite>),
    /// The flowmark session held until the transaction ends.
    Markdown(crate::markdown::MdLease),
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

    pub(crate) fn completed(&mut self) {
        self.close_on_drop = false;
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
