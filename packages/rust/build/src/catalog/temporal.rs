//! Reads described tables: time and datetime cells are written with as many fractional digits as the column's declared precision p
//! digits (docs/spec/dbspec.md). The grid decode uses six digits, so the remaining digits must be 0.
//! For SQLite, the dbspec text of a declared temporal column is turned into the same temporal cell.
use super::TableMetadata;
use crate::tool_db::{is_temporal, Conn, GridCell, GridQueryResult, QueryLimits, P};

/// The `(p)` of the native type. If absent, the dialect default: MySQL `time` and `datetime` are 0, PostgreSQL
/// `time` and `timestamp` are 6.
fn precision(native_type: &str, dialect: &str) -> Result<usize, String> {
    let declared = native_type.split_once('(').and_then(|(_, rest)| rest.split_once(')')).map(|(digits, _)| digits);
    let p = match (declared, dialect) {
        (Some(digits), _) => digits.parse::<usize>().map_err(|_| format!("GRID_TEMPORAL_PRECISION: native type {native_type:?} has no precision"))?,
        (None, "mysql") => 0,
        (None, "postgres") => 6,
        (None, _) => return Err(format!("GRID_TEMPORAL_PRECISION: native type {native_type:?} has no precision")),
    };
    if p > 6 {
        return Err(format!("GRID_TEMPORAL_PRECISION: native type {native_type:?} declares more than 6 fraction digits"));
    }
    Ok(p)
}

/// Reduces the six-digit fractional text to p digits. If the discarded digits are not 0, it is an error.
fn fraction(text: &str, p: usize, column: &str) -> Result<String, String> {
    let Some((whole, digits)) = text.split_once('.') else {
        return Err(format!("GRID_TEMPORAL_PRECISION: {column} has no fraction digits"));
    };
    if digits.len() != 6 || !digits[p..].bytes().all(|digit| digit == b'0') {
        return Err(format!("GRID_TEMPORAL_PRECISION: {column} has more fraction digits than its precision {p}"));
    }
    Ok(if p == 0 { whole.to_owned() } else { format!("{whole}.{}", &digits[..p]) })
}

/// The dbspec kind of SQLite's declared `DATE`, `TIME`, `DATETIME` columns. SQLite has no temporal storage
/// class, and the renderer CHECK enforces the text form and p-digit fractions.
fn sqlite_kind(native_type: &str) -> Option<&'static str> {
    match native_type.to_ascii_uppercase().as_str() {
        "DATE" => Some("date"),
        "TIME" => Some("time"),
        "DATETIME" => Some("datetime"),
        _ => None,
    }
}

/// Uses the time and datetime cells of the result as the precision of the metadata column. For SQLite's declared
/// temporal columns, turns the stored dbspec text into the same temporal cells as MySQL and PostgreSQL.
pub(super) fn declared_precision(metadata: &TableMetadata, dialect: &str, result: &mut GridQueryResult) -> Result<(), String> {
    for row in &mut result.rows {
        for (cell, column) in row.iter_mut().zip(&metadata.columns) {
            if dialect == "sqlite" {
                let Some(kind) = sqlite_kind(&column.native_type) else { continue };
                *cell = match cell {
                    GridCell::Null => GridCell::Null,
                    GridCell::Text(text) if is_temporal(kind, text) => match kind {
                        "date" => GridCell::Date(std::mem::take(text)),
                        "time" => GridCell::Time(std::mem::take(text)),
                        _ => GridCell::DateTime(std::mem::take(text)),
                    },
                    _ => return Err(format!("GRID_TEMPORAL_VALUE: {} holds a value that is not a dbspec {kind}", column.name)),
                };
            } else if let GridCell::Time(text) | GridCell::DateTime(text) = cell {
                *text = fraction(text, precision(&column.native_type, dialect)?, &column.name)?;
            }
        }
    }
    Ok(())
}

/// Runs the statement that selects all the metadata's columns, and applies the column precision to the temporal cells.
pub(super) async fn read(
    connection: &mut Conn,
    metadata: &TableMetadata,
    dialect: &str,
    sql: &str,
    params: &[P],
    limits: QueryLimits,
) -> Result<GridQueryResult, String> {
    let mut result = connection.grid_query_bounded(sql, params, limits).await.map_err(|error| error.to_string())?;
    declared_precision(metadata, dialect, &mut result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{fraction, precision};

    #[test]
    // Requirements: INT-101.
    fn precision_follows_the_native_type_and_dialect_default() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(precision("datetime(6)", "mysql"), Ok(6));
        assert_eq!(precision("datetime", "mysql"), Ok(0));
        assert_eq!(precision("time(3) without time zone", "postgres"), Ok(3));
        assert_eq!(precision("timestamp without time zone", "postgres"), Ok(6));
        assert!(precision("DATETIME", "sqlite").is_err());
        assert!(precision("datetime(7)", "mysql").is_err());
    }

    #[test]
    // Requirements: DBS-121.
    fn temporal_text_follows_the_dbspec_forms() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        use crate::tool_db::is_temporal;
        for (kind, text) in
            [("date", "0001-01-01"), ("date", "9999-12-31"), ("time", "23:59:59.999999"), ("time", "00:00:00"), ("datetime", "2026-01-02 03:04:05.1")]
        {
            assert!(is_temporal(kind, text), "{kind} {text}");
        }
        for (kind, text) in [
            ("date", "2026-02-30"),
            ("date", "2026-1-02"),
            ("date", "0000-01-01"),
            ("time", "24:00:00"),
            ("time", "03:04:05."),
            ("time", "03:04:05.1234567"),
            ("datetime", "2026-01-02T03:04:05"),
            ("datetime", "2026-01-02 03:04:05Z"),
        ] {
            assert!(!is_temporal(kind, text), "{kind} {text}");
        }
    }

    #[test]
    // Requirements: DIA-24.
    fn fraction_keeps_exactly_p_digits_and_rejects_dropped_digits() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(fraction("2026-01-02 03:04:05.120000", 3, "c"), Ok("2026-01-02 03:04:05.120".into()));
        assert_eq!(fraction("03:04:05.000000", 0, "c"), Ok("03:04:05".into()));
        assert_eq!(fraction("03:04:05.123456", 6, "c"), Ok("03:04:05.123456".into()));
        assert!(fraction("03:04:05.123456", 3, "c").is_err_and(|e| e.contains("more fraction digits than its precision 3")));
        assert!(fraction("03:04:05", 0, "c").is_err());
    }
}
