//! The column of a PostgreSQL statement that sqlx cannot describe: a multirange, or an array, range, domain or composite that
//! holds one (INT-185). sqlx-postgres 0.9 reads `pg_type.typtype` of each output type that it does not know into an enum that
//! has no multirange (`m`), so its prepare fails with a column decode error of that column before any value is read. The
//! statement is then prepared by the server through the simple protocol, which resolves no type, its output types are read from
//! `pg_prepared_statements.result_types` (PostgreSQL 14, the release that adds multiranges), and the first column whose type is
//! or holds a multirange is refused by INT-170 by its type, whether its value is NULL or not.
//! The failed prepare leaves a statement on the server whose name only sqlx knew, so every prepared statement of the session
//! is released before the refusal returns, and the session keeps no statement of a failed read.
use sqlx::postgres::{PgConnection, PgTypeInfo};
use sqlx::{AssertSqlSafe, TypeInfo};

use super::value::{ValueRefusal, UNSUPPORTED_NATIVE_TYPE};

/// The column of the type resolver of sqlx-postgres whose decode fails for a type kind that it does not know.
const TYPTYPE_COLUMN: &str = "\"typtype\"";

/// The first PostgreSQL release that has multirange types.
const MULTIRANGE_RELEASE: u32 = 140_000;

/// The sequence of the statements that a describe prepares, so that each one names its statement.
static DESCRIBE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The 1-based position of the first output column of a prepared statement whose type is or holds a multirange: the type, the
/// base type of a domain, the element of an array, the subtype of a range and the field types of a composite, each in turn.
const FIRST_MULTIRANGE: &str = "WITH RECURSIVE output(position, type) AS (\
    SELECT u.position, u.type::oid FROM pg_prepared_statements p, unnest(p.result_types) WITH ORDINALITY AS u(type, position) \
    WHERE p.name = $1), \
reach(position, type) AS (SELECT position, type FROM output UNION \
    SELECT r.position, c.child FROM reach r JOIN pg_type t ON t.oid = r.type CROSS JOIN LATERAL (\
        SELECT t.typbasetype WHERE t.typtype = 'd' \
        UNION ALL SELECT t.typelem WHERE t.typcategory = 'A' AND t.typelem <> 0 \
        UNION ALL SELECT g.rngsubtype FROM pg_range g WHERE g.rngtypid = t.oid \
        UNION ALL SELECT a.atttypid FROM pg_attribute a WHERE t.typtype = 'c' AND a.attrelid = t.typrelid AND a.attnum > 0 \
            AND NOT a.attisdropped) AS c(child)) \
SELECT min(r.position) FROM reach r JOIN pg_type t ON t.oid = r.type WHERE t.typtype = 'm'";

/// Whether a prepare failed in the type resolver of sqlx on the kind of an output type.
pub(crate) fn is_unknown_type_kind(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::ColumnDecode { index, .. } if index == TYPTYPE_COLUMN)
}

/// The error of a failed prepare of `text` with the parameter types `types`: INT-170 at the first column that is or holds a
/// multirange when sqlx failed on the kind of an output type, else the error itself. A failure of the describe or of the release
/// is that failure.
pub(super) async fn refusal(connection: &mut PgConnection, text: &str, types: &[PgTypeInfo], error: sqlx::Error) -> sqlx::Error {
    if !is_unknown_type_kind(&error) {
        return error;
    }
    let found = if connection.server_version_num().is_some_and(|version| version < MULTIRANGE_RELEASE) {
        Ok(None)
    } else {
        first_multirange(connection, text, types).await
    };
    match (found, release(connection).await) {
        (Err(describe), _) => describe,
        (_, Err(release)) => release,
        (Ok(Some(column)), Ok(())) => sqlx::Error::Decode(Box::new(ValueRefusal::new(UNSUPPORTED_NATIVE_TYPE, column))),
        (Ok(None), Ok(())) => error,
    }
}

/// Releases every prepared statement of the session. The failed prepare of sqlx left a statement on the server under a name that
/// only sqlx knew and that its cache does not hold, so it is released with all the others: the statements that the cache holds
/// are closed first, so that no later read names one that the server no longer has, and DEALLOCATE ALL releases the rest, the
/// statement of the describe included. The connection, and the transaction that a caller may hold on it, stay open.
async fn release(connection: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::Connection::clear_cached_statements(&mut *connection).await?;
    sqlx::raw_sql("DEALLOCATE ALL").execute(&mut *connection).await.map(|_| ())
}

/// Prepares `text` on the server and reads the position of its first multirange column; `release` deallocates it.
async fn first_multirange(connection: &mut PgConnection, text: &str, types: &[PgTypeInfo]) -> Result<Option<usize>, sqlx::Error> {
    let name = format!("orm_describe_{}", DESCRIBE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let parameters = if types.is_empty() { String::new() } else { format!(" ({})", types.iter().map(TypeInfo::name).collect::<Vec<_>>().join(", ")) };
    sqlx::raw_sql(AssertSqlSafe(format!("PREPARE {name}{parameters} AS {text}"))).execute(&mut *connection).await?;
    let found = sqlx::query_scalar::<_, Option<i64>>(FIRST_MULTIRANGE).bind(&name).fetch_one(&mut *connection).await?;
    match found {
        Some(position) => usize::try_from(position).map(Some).map_err(|error| sqlx::Error::Decode(Box::new(error))),
        None => Ok(None),
    }
}
