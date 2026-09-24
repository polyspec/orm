//! Database driver adapters: binding, fetching, executing, and the relation
//! parent-value expansion shared by every statement.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Arc;

use chrono::{NaiveDate, NaiveDateTime};
use sqlx::mysql::{MySql, MySqlRow};
use sqlx::postgres::{PgRow, PgTypeInfo, Postgres};
use sqlx::sqlite::{Sqlite, SqliteRow};
use sqlx::{Executor, SqlSafeStr as _, Statement as _, TypeInfo as _};

use crate::collection::Key;
use crate::db::Pool;
use crate::db::Zone;
use crate::plan::{Assemble, BindSlot, ParentRef, Plan, Step};
use crate::row::{decode_styled, read_cell, read_row, DriverRow};
use crate::value::{transform, Param, Val};
use crate::{Error, Result};

pub const SECRET_MASK: &str = "$SECRET";
pub const NOW_MASK: &str = "$NOW";

/// Compares a row value with a bound parameter regardless of representation
/// (bool vs int, driver width): both are reduced to the same canonical text.
pub(crate) fn same_scalar(v: &Val, p: &Param) -> bool {
    let a = match v {
        Val::Null => return matches!(p, Param::Null),
        Val::Bool(b) => (*b as i64).to_string(),
        Val::I64(x) => x.to_string(),
        Val::F64(x) => x.to_string(),
        Val::Str(s) => s.clone(),
        Val::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        Val::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        Val::Date(d) => d.to_string(),
        Val::Json(j) => j.to_string(),
        Val::Ordered(j) => j.compact(),
    };
    let b = match p {
        Param::Null => return false,
        Param::Bool(b) => (*b as i64).to_string(),
        Param::I64(x) => x.to_string(),
        Param::F64(x) => x.to_string(),
        Param::Str(s) => s.clone(),
        Param::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        Param::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        Param::Date(d) => d.to_string(),
        Param::Point(p) => format!("{},{}", p.0, p.1),
    };
    a == b
}

/// Distinct non-null values a relation step binds, first-seen order, from the
/// parent rows that pass `if_parent`.
pub(crate) fn parent_values<'a>(pr: &ParentRef, parents: impl Iterator<Item = &'a [Val]>, params: &[Param]) -> Vec<Param> {
    let mut seen: std::collections::HashSet<Key> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in parents {
        if let Some(ifp) = &pr.if_parent {
            if !same_scalar(&row[ifp.index], &params[ifp.param]) {
                continue;
            }
        }
        let Some(key) = Key::of_row(row, &pr.keys) else {
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
    out
}

/// Rewrites the step's single `parent` placeholder into n placeholders. n is
/// rounded up to a power of two (values padded by repetition) so the prepared
/// statement cache holds one statement per size class. On PostgreSQL the plan has one
/// `$k` per slot in slot order: the parent slot becomes n placeholders and every later
/// number shifts by n-1 (docs/dialects.md).
pub(crate) fn expand_in(st: &Step, mut vals: Vec<Param>, numbered: bool) -> (String, Vec<Param>) {
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
            let k: usize = st.sql[i + 1..j].parse().unwrap_or(0);
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
        return (sql, vals);
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
    (sql, vals)
}

/// The value a `param` slot binds: the request parameter, transformed when the slot says so.
pub(crate) fn param_arg(b: &BindSlot, params: &[Param]) -> Result<Param> {
    let v = &params[b.param];
    if b.transform.is_empty() {
        return Ok(v.clone());
    }
    let Param::Str(s) = v else {
        return Err(Error::Config(format!("transform {} needs a string", b.transform)));
    };
    Ok(Param::Str(transform(&b.transform, s)))
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

/// Prepares `sql` with no declared parameter types so the server infers them, and returns them.
pub(crate) async fn pg_describe<'e, E: Executor<'e, Database = Postgres>>(e: E, sql: &str) -> Result<Arc<[PgTypeInfo]>> {
    let stmt = e.prepare(sqlx::AssertSqlSafe(sql.to_owned()).into_sql_str()).await?;
    match stmt.parameters() {
        Some(sqlx::Either::Left(types)) => Ok(Arc::from(types.to_vec())),
        _ => Err(Error::internal("postgres did not describe the statement's parameters")),
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
        Param::Point(_) => unreachable!("point is converted to text before binding"),
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
        Param::Point(_) => unreachable!("point is converted to text before binding"),
    }
}

/// A datetime from the text forms an application binds (the same layouts Go's AsTime accepts).
pub(crate) fn parse_datetime(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f"))
        .ok()
        .or_else(|| chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| t.naive_utc()))
        .or_else(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap()))
}

/// Binds one PostgreSQL parameter as the type the server inferred for its placeholder
/// (`ty`), converting the executor value the way pgx would; a value that cannot become
/// that type is CONFIG (the statement text and the value are named).
pub(crate) fn bind_pg<'q>(q: PgQuery<'q>, p: &'q Param, ty: &PgTypeInfo, i: usize, zone: Zone) -> Result<PgQuery<'q>> {
    let name = ty.name();
    let bad = || Error::Config(format!("postgres parameter ${} is {name}: cannot bind {p:?}", i + 1));
    macro_rules! int {
        ($t:ty) => {
            match p {
                Param::Null => q.bind(Option::<$t>::None),
                Param::I64(x) => q.bind(<$t>::try_from(*x).map_err(|_| bad())?),
                Param::Bool(b) => q.bind(*b as $t),
                Param::Str(s) => q.bind(s.trim().parse::<$t>().map_err(|_| bad())?),
                Param::F64(x) if x.fract() == 0.0 => q.bind(<$t>::try_from(*x as i64).map_err(|_| bad())?),
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
                Param::Str(s) => q.bind(s.trim().parse::<$t>().map_err(|_| bad())?),
                _ => return Err(bad()),
            }
        };
    }
    Ok(match name {
        "INT2" => int!(i16),
        "INT4" => int!(i32),
        "INT8" => int!(i64),
        "FLOAT4" => float!(f32),
        "FLOAT8" => float!(f64),
        "NUMERIC" => match p {
            Param::Null => q.bind(Option::<rust_decimal::Decimal>::None),
            Param::F64(x) => q.bind(rust_decimal::Decimal::try_from(*x).map_err(|_| bad())?),
            Param::I64(x) => q.bind(rust_decimal::Decimal::from(*x)),
            Param::Str(s) => q.bind(rust_decimal::Decimal::from_str(s.trim()).map_err(|_| bad())?),
            _ => return Err(bad()),
        },
        "BOOL" => match p {
            Param::Null => q.bind(Option::<bool>::None),
            Param::Bool(b) => q.bind(*b),
            Param::I64(x) => q.bind(*x != 0),
            Param::Str(s) => q.bind(matches!(s.trim(), "1" | "true" | "t" | "TRUE")),
            _ => return Err(bad()),
        },
        "TEXT" | "VARCHAR" | "CHAR" | "\"CHAR\"" | "NAME" | "UNKNOWN" => match p {
            Param::Null => q.bind(Option::<&str>::None),
            Param::Str(s) => q.bind(s.as_str()),
            Param::I64(x) => q.bind(x.to_string()),
            Param::F64(x) => q.bind(x.to_string()),
            Param::Bool(b) => q.bind(b.to_string()),
            Param::DateTime(t) => q.bind(t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
            Param::Date(d) => q.bind(d.to_string()),
            Param::Bytes(b) => q.bind(std::str::from_utf8(b).map_err(|_| bad())?),
            Param::Point(point) => q.bind(crate::point_text(*point)?),
        },
        "TIMESTAMP" => match p {
            Param::Null => q.bind(Option::<NaiveDateTime>::None),
            Param::DateTime(t) => q.bind(*t),
            Param::Date(d) => q.bind(d.and_hms_opt(0, 0, 0).unwrap()),
            Param::Str(s) => q.bind(parse_datetime(s).ok_or_else(bad)?),
            _ => return Err(bad()),
        },
        // wall-clock values are in the connection zone; text with an offset is an instant
        "TIMESTAMPTZ" => match p {
            Param::Null => q.bind(Option::<chrono::DateTime<chrono::Utc>>::None),
            Param::DateTime(t) => q.bind(zone.instant(*t).ok_or_else(bad)?),
            Param::Date(d) => q.bind(zone.instant(d.and_hms_opt(0, 0, 0).unwrap()).ok_or_else(bad)?),
            Param::Str(s) => {
                match chrono::DateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M:%S%.f%:z").or_else(|_| chrono::DateTime::parse_from_rfc3339(s.trim())) {
                    Ok(t) => q.bind(t.with_timezone(&chrono::Utc)),
                    Err(_) => q.bind(zone.instant(parse_datetime(s).ok_or_else(bad)?).ok_or_else(bad)?),
                }
            }
            _ => return Err(bad()),
        },
        "DATE" => match p {
            Param::Null => q.bind(Option::<NaiveDate>::None),
            Param::Date(d) => q.bind(*d),
            Param::DateTime(t) => q.bind(t.date()),
            Param::Str(s) => q.bind(parse_datetime(s).ok_or_else(bad)?.date()),
            _ => return Err(bad()),
        },
        "JSONB" | "JSON" => match p {
            Param::Null => q.bind(Option::<sqlx::types::Json<serde_json::Value>>::None),
            Param::Str(s) => q.bind(sqlx::types::Json(serde_json::value::RawValue::from_string(s.clone()).map_err(|_| bad())?)),
            _ => return Err(bad()),
        },
        "BYTEA" => match p {
            Param::Null => q.bind(Option::<&[u8]>::None),
            Param::Bytes(b) => q.bind(b.as_slice()),
            Param::Str(s) => q.bind(s.as_bytes()),
            _ => return Err(bad()),
        },
        "INET" => match p {
            Param::Null => q.bind(Option::<std::net::IpAddr>::None),
            Param::Str(s) => q.bind(s.trim().parse::<std::net::IpAddr>().map_err(|_| bad())?),
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

pub(crate) async fn exec_mysql<'e, E: Executor<'e, Database = MySql>>(sql: &str, args: &[Param], e: E) -> sqlx::Result<(u64, u64)> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_mysql(q, a);
    }
    let r = q.execute(e).await?;
    Ok((r.last_insert_id(), r.rows_affected()))
}

pub(crate) fn pg_query<'q>(sql: &str, args: &'q [Param], types: &[PgTypeInfo], zone: Zone) -> Result<PgQuery<'q>> {
    if types.len() != args.len() {
        return Err(Error::internal(format!("postgres described {} parameters, the plan binds {}", types.len(), args.len())));
    }
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for (i, (a, ty)) in args.iter().zip(types).enumerate() {
        q = bind_pg(q, a, ty, i, zone)?;
    }
    Ok(q)
}

pub(crate) async fn fetch_pg<'e, E: Executor<'e, Database = Postgres>>(
    sql: &str,
    args: &[Param],
    types: &[PgTypeInfo],
    zone: Zone,
    e: E,
) -> Result<Vec<PgRow>> {
    Ok(pg_query(sql, args, types, zone)?.fetch_all(e).await?)
}

pub(crate) async fn exec_pg<'e, E: Executor<'e, Database = Postgres>>(sql: &str, args: &[Param], types: &[PgTypeInfo], zone: Zone, e: E) -> Result<(u64, u64)> {
    let r = pg_query(sql, args, types, zone)?.execute(e).await?;
    Ok((0, r.rows_affected()))
}

pub(crate) async fn fetch_sqlite<'e, E: Executor<'e, Database = Sqlite>>(sql: &str, args: &[Param], e: E) -> sqlx::Result<Vec<SqliteRow>> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_sqlite(q, a);
    }
    q.fetch_all(e).await
}

pub(crate) async fn exec_sqlite<'e, E: Executor<'e, Database = Sqlite>>(sql: &str, args: &[Param], e: E) -> sqlx::Result<(u64, u64)> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_sqlite(q, a);
    }
    let r = q.execute(e).await?;
    Ok((r.last_insert_rowid() as u64, r.rows_affected()))
}

pub(crate) async fn acquire_sqlite_row_lock(target: &mut Target<'_>, mode: &str) -> Result<()> {
    if mode.is_empty() {
        return Ok(());
    }
    let tx = match target {
        Target::Tx(TxInner::Sqlite(tx)) => tx,
        Target::Pool(Pool::Sqlite(_)) => return Err(Error::Config("SQLite row locks require an ORM transaction".into())),
        _ => return Ok(()),
    };
    let nowait = mode.ends_with("_nowait");
    let previous: i64 = sqlx::query_scalar("PRAGMA busy_timeout").fetch_one(&mut **tx).await?;
    if nowait {
        sqlx::raw_sql("PRAGMA busy_timeout=0").execute(&mut **tx).await?;
    }
    let result = async {
        sqlx::raw_sql("CREATE TABLE IF NOT EXISTS \"orm__row_lock\" (\"id\" INTEGER PRIMARY KEY CHECK (\"id\" = 1))").execute(&mut **tx).await?;
        sqlx::raw_sql("INSERT INTO \"orm__row_lock\" (\"id\") VALUES (1) ON CONFLICT (\"id\") DO UPDATE SET \"id\"=excluded.\"id\"").execute(&mut **tx).await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    if nowait {
        let statement = format!("PRAGMA busy_timeout={previous}");
        let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(statement).into_sql_str()).execute(&mut **tx).await;
    }
    result.map_err(|error| {
        let mapped = Error::from(error);
        if nowait && mapped.is_deadlock() {
            Error::Engine { code: crate::codes::LOCK_NOT_AVAILABLE.into(), msg: mapped.to_string() }
        } else {
            mapped
        }
    })
}

/// The statement text of a step: the plan's SQL as is, or with its `parent` placeholder expanded.
pub(crate) fn statement(st: &Step, parent_vals: Vec<Param>, numbered: bool) -> (Cow<'_, str>, Vec<Param>) {
    if parent_vals.is_empty() {
        (Cow::Borrowed(st.sql.as_str()), parent_vals)
    } else {
        let (sql, vals) = expand_in(st, parent_vals, numbered);
        (Cow::Owned(sql), vals)
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
    Ok(data)
}

/// The transaction of one pool.
pub(crate) enum TxInner {
    MySql(MySqlOwnedTx),
    Postgres(sqlx::Transaction<'static, Postgres>),
    Sqlite(sqlx::Transaction<'static, Sqlite>),
}

/// Where a statement runs: the pool (each statement on its own) or a transaction's connection.
pub(crate) enum Target<'a> {
    Pool(&'a Pool),
    Tx(&'a mut TxInner),
}

/// A MySQL transaction whose pool connection is retained after the explicit
/// `SET TRANSACTION` and `START TRANSACTION` statements.
pub(crate) struct MySqlOwnedTx {
    pub(crate) conn: Option<sqlx::pool::PoolConnection<MySql>>,
}

impl MySqlOwnedTx {
    pub(crate) async fn commit(mut self) -> sqlx::Result<()> {
        let mut conn = self.conn.take().expect("active MySQL transaction connection");
        sqlx::raw_sql("COMMIT").execute(&mut *conn).await?;
        Ok(())
    }

    pub(crate) async fn rollback(mut self) -> sqlx::Result<()> {
        let mut conn = self.conn.take().expect("active MySQL transaction connection");
        sqlx::raw_sql("ROLLBACK").execute(&mut *conn).await?;
        Ok(())
    }
}

impl Drop for MySqlOwnedTx {
    fn drop(&mut self) {
        let Some(mut conn) = self.conn.take() else {
            return;
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = sqlx::raw_sql("ROLLBACK").execute(&mut *conn).await;
            });
        }
    }
}

pub(crate) type MySqlQuery<'q> = sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>;
pub(crate) type PgQuery<'q> = sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>;
pub(crate) type SqliteQuery<'q> = sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments>;
