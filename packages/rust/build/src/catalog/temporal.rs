//! Reads described tables: time and datetime cells are written with as many fractional digits as the column's declared precision p
//! digits (docs/spec/dbspec.md). The grid decode uses six digits, so the remaining digits must be 0.
//! For SQLite, the dbspec text of a declared temporal column is turned into the same temporal cell.
use super::{TableColumnMetadata, TableMetadata};
use crate::tool_db::{is_temporal, Conn, GridCell, GridQueryResult, QueryLimits, P};

/// The `(p)` of the native type. If absent, the dialect default: MySQL `time` and `datetime` are 0, PostgreSQL
/// `time` and `timestamp` are 6.
fn precision(native_type: &str, dialect: &str) -> Result<usize, String> {
    let declared = native_type.split_once('(').and_then(|(_, rest)| rest.split_once(')')).map(|(digits, _)| digits);
    let p = match (declared, dialect) {
        (Some(digits), _) => {
            digits.parse::<usize>().map_err(|error| format!("GRID_TEMPORAL_PRECISION: native type {native_type:?} has no precision: {error}"))?
        }
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
pub(super) fn declared_precision(metadata: &TableMetadata, dialect: &str, checks: &[Option<usize>], result: &mut GridQueryResult) -> Result<(), String> {
    for row in &mut result.rows {
        for (index, (cell, column)) in row.iter_mut().zip(&metadata.columns).enumerate() {
            if dialect == "sqlite" {
                let Some(kind) = sqlite_kind(&column.native_type) else { continue };
                *cell = match cell {
                    GridCell::Null => GridCell::Null,
                    GridCell::Text(text) if is_temporal(kind, text) => {
                        // A SQLite fraction is kept at the digits of the CHECK that fixes it (SQLite has no temporal storage class).
                        let digits = text.split_once('.').map_or(0, |(_, fraction)| fraction.len());
                        // DIA-24: a CHECK that fixes p requires exactly p fraction digits. A column with no CHECK has no declared p,
                        // so its text is kept as main reads it.
                        if let Some(precision) = checks.get(index).copied().flatten().filter(|_| kind != "date") {
                            if precision != digits {
                                return Err(format!(
                                    "GRID_TEMPORAL_PRECISION: column {:?} holds {digits} fraction digits; its dbspec CHECK fixes {precision}",
                                    column.name
                                ));
                            }
                        }
                        match kind {
                            "date" => GridCell::Date(std::mem::take(text)),
                            "time" => GridCell::Time(std::mem::take(text)),
                            _ => GridCell::DateTime(std::mem::take(text)),
                        }
                    }
                    _ => return Err(format!("GRID_TEMPORAL_VALUE: {} holds a value that is not a dbspec {kind}", column.name)),
                };
            } else if let GridCell::Time(text) | GridCell::DateTime(text) = cell {
                *text = fraction(text, precision(&column.native_type, dialect)?, &column.name)?;
            }
        }
    }
    Ok(())
}

/// The dbspec temporal kind of a column, its precision p, and whether p is declared, or None for every other type (the Python
/// catalog's temporal kind). A SQLite p is the CHECK precision of the column, undeclared when no CHECK fixes it.
fn temporal_kind(column: &TableColumnMetadata, dialect: &str, check: Option<usize>) -> Option<(&'static str, usize, bool)> {
    let lower = column.native_type.trim().to_ascii_lowercase();
    match dialect {
        "mysql" | "postgres" => {
            if lower == "date" {
                return Some(("date", 0, true));
            }
            let (time, datetime, fallback) = if dialect == "mysql" {
                (declared_digit(&lower, "time", ""), declared_digit(&lower, "datetime", ""), 0)
            } else {
                (declared_digit(&lower, "time", " without time zone"), declared_digit(&lower, "timestamp", " without time zone"), 6)
            };
            if let Some(p) = time {
                return Some(("time", p.unwrap_or(fallback), true));
            }
            datetime.map(|p| ("datetime", p.unwrap_or(fallback), true))
        }
        "sqlite" => match column.native_type.to_ascii_uppercase().as_str() {
            "DATE" => Some(("date", 0, true)),
            "TIME" => Some(("time", check.unwrap_or(0), check.is_some())),
            "DATETIME" => Some(("datetime", check.unwrap_or(0), check.is_some())),
            _ => None,
        },
        _ => None,
    }
}

/// The precision of a native type of the form base, base(p) and base suffix, with p from 0 to 6: None when the type has another form.
fn declared_digit(lower: &str, base: &str, suffix: &str) -> Option<Option<usize>> {
    let rest = lower.strip_suffix(suffix)?.strip_prefix(base)?;
    if rest.is_empty() {
        return Some(None);
    }
    let digits = rest.strip_prefix('(')?.strip_suffix(')')?;
    match digits {
        "0" | "1" | "2" | "3" | "4" | "5" | "6" => digits.parse().ok().map(Some),
        _ => None,
    }
}

/// The fraction digits that the dbspec CHECK of a SQLite TIME or DATETIME column fixes (engine/dbspec/render.go): the count of
/// the [0-9] groups of its GLOB, or 0 for a CHECK of the whole form without a fraction. None when no CHECK names the column.
fn check_precision(table_sql: &str, column: &str) -> Option<usize> {
    let quoted = format!("\"{}\"", column.replace('"', "\"\""));
    for clause in check_clauses(table_sql) {
        if !clause.contains(&quoted) {
            continue;
        }
        if let Some(digits) = glob_digits(clause) {
            return Some(digits);
        }
        if clause.contains("IS time(") || clause.contains("IS datetime(") {
            return Some(0);
        }
    }
    None
}

/// The number of [0-9] groups of the first GLOB '<groups>' of a CHECK clause.
fn glob_digits(clause: &str) -> Option<usize> {
    let mut rest = clause;
    while let Some(at) = rest.find("GLOB '") {
        let after = &rest[at + "GLOB '".len()..];
        let groups = after.len() - after.trim_start_matches("[0-9]").len();
        if after[groups..].starts_with('\'') {
            return Some(groups / "[0-9]".len());
        }
        rest = after;
    }
    None
}

/// The text inside each CHECK ( ... ) of a table definition, balanced over its parentheses.
fn check_clauses(table_sql: &str) -> Vec<&str> {
    let upper = table_sql.to_ascii_uppercase();
    let bytes = table_sql.as_bytes();
    let mut clauses = Vec::new();
    let mut search = 0;
    while let Some(found) = upper[search..].find("CHECK") {
        let start = search + found + "CHECK".len();
        let trimmed = table_sql[start..].trim_start();
        search = start;
        if !trimmed.starts_with('(') {
            continue;
        }
        let open_end = table_sql.len() - trimmed.len() + 1;
        let (mut depth, mut index) = (1usize, open_end);
        while index < bytes.len() && depth > 0 {
            match bytes[index] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            index += 1;
        }
        clauses.push(if depth == 0 { &table_sql[open_end..index - 1] } else { &table_sql[open_end..] });
        search = open_end;
    }
    clauses
}

/// The CHECK precision of each SQLite TIME and DATETIME column of the table, read from the definition in sqlite_master.
pub(super) async fn sqlite_check_precisions(connection: &mut Conn, metadata: &TableMetadata, dialect: &str) -> Result<Vec<Option<usize>>, String> {
    let mut checks = vec![None; metadata.columns.len()];
    if dialect != "sqlite" || !metadata.columns.iter().any(|column| matches!(column.native_type.to_ascii_uppercase().as_str(), "TIME" | "DATETIME")) {
        return Ok(checks);
    }
    let rows = connection
        .query_bounded(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            &[P::S(metadata.table.name.clone())],
            QueryLimits { max_rows: 2, max_bytes: 4 * 1024 * 1024 },
        )
        .await
        .map_err(|error| error.to_string())?;
    let table_sql = match rows.as_slice() {
        [row] if row.len() == 1 => match &row[0] {
            crate::tool_db::Val::Text(text) => text.clone(),
            _ => return Err(format!("TABLE_METADATA_INVALID: the definition of table {:?} is not one text", metadata.table.name)),
        },
        _ => return Err(format!("TABLE_METADATA_INVALID: the definition of table {:?} is not one text", metadata.table.name)),
    };
    for (check, column) in checks.iter_mut().zip(&metadata.columns) {
        if matches!(column.native_type.to_ascii_uppercase().as_str(), "TIME" | "DATETIME") {
            *check = check_precision(&table_sql, &column.name);
        }
    }
    Ok(checks)
}

/// Refuses a temporal value that names more fraction digits than the precision of its column, before any write (CODEC_ENCODE).
/// A SQLite column whose precision no CHECK fixes has nothing to refuse.
pub(super) async fn check_write_precision(connection: &mut Conn, metadata: &TableMetadata, values: &[(String, P)], dialect: &str) -> Result<(), String> {
    if !values.iter().any(|(_, value)| matches!(value, P::Time(_) | P::DateTime(_))) {
        return Ok(());
    }
    let checks = sqlite_check_precisions(connection, metadata, dialect).await?;
    for (name, value) in values {
        let (text, index) = match value {
            P::Time(text) | P::DateTime(text) => (text, metadata.columns.iter().position(|column| column.name == *name)),
            _ => continue,
        };
        let Some(index) = index else { continue };
        let Some((_, precision, declared)) = temporal_kind(&metadata.columns[index], dialect, checks[index]) else { continue };
        let Some((_, fraction)) = text.split_once('.') else { continue };
        if declared && fraction.get(precision..).is_some_and(|rest| rest.bytes().any(|digit| digit != b'0')) {
            return Err(format!("CODEC_ENCODE: temporal value \"{text}\" has more fraction digits than its precision {precision}"));
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
    let mut result = connection.grid_query_bounded(sql, params, limits).await.map_err(super::catalog_query_error)?;
    let checks = sqlite_check_precisions(connection, metadata, dialect).await?;
    declared_precision(metadata, dialect, &checks, &mut result)?;
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
    fn malformed_precision_preserves_parse_cause_message() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let error = precision("datetime(x)", "mysql").expect_err("malformed precision must fail");
        assert!(error.starts_with("GRID_TEMPORAL_PRECISION: native type \"datetime(x)\" has no precision: "), "{error}");
        assert!(error.contains("invalid digit found in string"), "{error}");
    }

    #[test]
    // Requirements: INT-103.
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
    // Requirements: INT-103.
    fn fraction_keeps_exactly_p_digits_and_rejects_dropped_digits() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(fraction("2026-01-02 03:04:05.120000", 3, "c"), Ok("2026-01-02 03:04:05.120".into()));
        assert_eq!(fraction("03:04:05.000000", 0, "c"), Ok("03:04:05".into()));
        assert_eq!(fraction("03:04:05.123456", 6, "c"), Ok("03:04:05.123456".into()));
        assert!(fraction("03:04:05.123456", 3, "c").is_err_and(|e| e.contains("more fraction digits than its precision 3")));
        assert!(fraction("03:04:05", 0, "c").is_err());
    }
}
