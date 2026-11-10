//! Reads described tables: time and datetime cells are written with as many fractional digits as the column's declared precision p
//! digits (docs/spec/dbspec.md). The grid decode uses six digits, so the remaining digits must be 0.
//! For SQLite, the dbspec text of a declared temporal column is turned into the same temporal cell.
use super::CatalogError;
use super::{TableColumnMetadata, TableMetadata};
use crate::tool_db::{value, Conn, GridCell, GridQueryResult, QueryLimits, P};

/// The refusal of the value of the column at the 0-based `index` of the described columns, by `rule`.
fn refused(rule: value::Rule, index: usize) -> CatalogError {
    value::ValueRefusal::new(rule, index + 1).to_string().into()
}

/// The `(p)` of the native type. If absent, the dialect default: MySQL `time` and `datetime` are 0, PostgreSQL
/// `time` and `timestamp` are 6. A precision above 6 or one that is not a number is INT-181.
fn precision(native_type: &str, dialect: &str) -> Result<usize, value::Rule> {
    let declared = native_type.split_once('(').and_then(|(_, rest)| rest.split_once(')')).map(|(digits, _)| digits);
    let p = match (declared, dialect) {
        (Some(digits), _) => digits.parse::<usize>().map_err(|_not_a_number| value::NATIVE_PRECISION)?,
        (None, "mysql") => 0,
        (None, "postgres") => 6,
        (None, _) => return Err(value::NATIVE_PRECISION),
    };
    if p > 6 {
        return Err(value::NATIVE_PRECISION);
    }
    Ok(p)
}

/// Reduces the six-digit fractional text of a grid cell to p digits. A discarded digit that is not 0 is INT-180; a text
/// without the six digits of the grid cell is no value that the conversion takes (INT-171).
fn fraction(text: &str, p: usize) -> Result<String, value::Rule> {
    let Some((whole, digits)) = text.split_once('.') else { return Err(value::UNSUPPORTED_DRIVER_VALUE) };
    if digits.len() != 6 {
        return Err(value::UNSUPPORTED_DRIVER_VALUE);
    }
    if !digits[p..].bytes().all(|digit| digit == b'0') {
        return Err(value::FRACTION_PAST_PRECISION);
    }
    Ok(if p == 0 { whole.to_owned() } else { format!("{whole}.{}", &digits[..p]) })
}

/// A boolean column by its native type: tinyint(1) on MySQL, boolean on PostgreSQL and SQLite.
fn is_boolean(native_type: &str, dialect: &str) -> bool {
    if dialect == "mysql" {
        native_type.eq_ignore_ascii_case("tinyint(1)")
    } else {
        native_type.eq_ignore_ascii_case("boolean")
    }
}

/// The dbspec kind of SQLite's declared `DATE`, `TIME`, `DATETIME` columns. SQLite has no temporal storage
/// class, and the renderer CHECK enforces the text form and p-digit fractions. A declared `TIME(3)` is no dbspec declaration
/// of SQLite: it is the same kind, but its stored value is returned unchecked (INT-184), so the second value is false.
fn sqlite_kind(native_type: &str) -> Option<(&'static str, bool)> {
    let upper = native_type.to_ascii_uppercase();
    let (name, dbspec) = match upper.split_once('(') {
        Some((name, rest)) if rest.strip_suffix(')').is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())) => {
            (name.trim_end(), false)
        }
        Some(_) => return None,
        None => (upper.as_str(), true),
    };
    match name {
        "DATE" => Some(("date", dbspec)),
        "TIME" => Some(("time", dbspec)),
        "DATETIME" => Some(("datetime", dbspec)),
        _ => None,
    }
}

/// The temporal cell of `kind` that holds `text`.
fn temporal_cell(kind: &str, text: String) -> GridCell {
    match kind {
        "date" => GridCell::Date(text),
        "time" => GridCell::Time(text),
        _ => GridCell::DateTime(text),
    }
}

/// The cell of the stored value of a SQLite dbspec `kind` column (INT-176 to INT-179): a text of the dbspec form whose digits
/// are a date and a time of day, with exactly the fraction digits of the CHECK that fixes them, 0 when none does.
fn sqlite_dbspec_cell(kind: &str, cell: &mut GridCell, check: Option<usize>) -> Result<GridCell, value::Rule> {
    let form = match kind {
        "date" => value::SQLITE_DATE_FORM,
        "time" => value::SQLITE_TIME_FORM,
        _ => value::SQLITE_DATETIME_FORM,
    };
    match cell {
        GridCell::Null => Ok(GridCell::Null),
        GridCell::Text(text) => {
            crate::tool_db::sqlite_temporal(kind, text)?;
            if kind != "date" {
                let digits = text.split_once('.').map_or(0, |(_, fraction)| fraction.len());
                if digits != check.unwrap_or(0) {
                    return Err(value::SQLITE_FRACTION);
                }
            }
            Ok(temporal_cell(kind, std::mem::take(text)))
        }
        _ => Err(form),
    }
}

/// Uses the time and datetime cells of the result as the precision of the metadata column. For SQLite's declared
/// temporal columns, turns the stored dbspec text into the same temporal cells as MySQL and PostgreSQL. A refusal names the
/// position of its column among the described columns (INT-165).
pub(super) fn declared_precision(metadata: &TableMetadata, dialect: &str, checks: &[Option<usize>], result: &mut GridQueryResult) -> Result<(), CatalogError> {
    for row in &mut result.rows {
        for (index, (cell, column)) in row.iter_mut().zip(&metadata.columns).enumerate() {
            if is_boolean(&column.native_type, dialect) {
                // A boolean column is read as a bool by its column type: the integer 0 or 1 of a MySQL tinyint(1) or a
                // SQLite BOOLEAN becomes a bool; any other value fails (INT-182).
                let value = match *cell {
                    GridCell::Null => GridCell::Null,
                    GridCell::Boolean(flag) => GridCell::Boolean(flag),
                    GridCell::Integer(n) if n == 0 || n == 1 => GridCell::Boolean(n == 1),
                    _ => return Err(refused(value::BOOLEAN, index)),
                };
                *cell = value;
                continue;
            }
            if dialect == "sqlite" {
                let Some((kind, dbspec)) = sqlite_kind(&column.native_type) else { continue };
                if dbspec {
                    *cell = sqlite_dbspec_cell(kind, cell, checks.get(index).copied().flatten()).map_err(|rule| refused(rule, index))?;
                } else if let GridCell::Text(text) = cell {
                    // SQLite refuses no value for the type that its column declares (INT-184): a text of the dbspec form is the
                    // temporal cell of its kind, and any other value keeps its storage class.
                    if crate::tool_db::is_temporal(kind, text) {
                        *cell = temporal_cell(kind, std::mem::take(text));
                    }
                }
            } else if let GridCell::Time(text) | GridCell::DateTime(text) = cell {
                let p = precision(&column.native_type, dialect).map_err(|rule| refused(rule, index))?;
                *text = fraction(text, p).map_err(|rule| refused(rule, index))?;
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
    match digits.parse::<usize>() {
        Ok(precision) if digits.len() == 1 && precision <= 6 => Some(Some(precision)),
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
pub(super) async fn sqlite_check_precisions(connection: &mut Conn, metadata: &TableMetadata, dialect: &str) -> Result<Vec<Option<usize>>, CatalogError> {
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
            _ => return Err(format!("TABLE_METADATA_INVALID: the definition of table {:?} is not one text", metadata.table.name).into()),
        },
        _ => return Err(format!("TABLE_METADATA_INVALID: the definition of table {:?} is not one text", metadata.table.name).into()),
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
pub(super) async fn check_write_precision(connection: &mut Conn, metadata: &TableMetadata, values: &[(String, P)], dialect: &str) -> Result<(), CatalogError> {
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
            return Err(format!("CODEC_ENCODE: temporal value \"{text}\" has more fraction digits than its precision {precision}").into());
        }
    }
    Ok(())
}

/// Runs the statement that selects all the metadata's columns, and applies the column precision to the temporal cells. Its
/// callers are the reads of a row change (the locking lookup of a key and the read of an inserted identity), so a server
/// error is the error of that change, as the other runtimes return it: a locking read that a read-only server refuses
/// (MariaDB 1290) is `READ_ONLY`, not the `QUERY_READ_ONLY` of a read-only query.
pub(super) async fn read(
    connection: &mut Conn,
    metadata: &TableMetadata,
    dialect: &str,
    sql: &str,
    params: &[P],
    limits: QueryLimits,
) -> Result<GridQueryResult, CatalogError> {
    let mut result = connection.grid_query_values_bounded(sql, params, limits).await.map_err(super::catalog_write_error)?;
    let checks = sqlite_check_precisions(connection, metadata, dialect).await?;
    declared_precision(metadata, dialect, &checks, &mut result)?;
    Ok(result)
}

/// Reads a page of at most keep rows. The row after them is the sentinel that reports more rows: it is cut before the
/// precision of the cells is converted, so its value is never read, and the returned flag reports it.
pub(super) async fn read_page(
    connection: &mut Conn,
    metadata: &TableMetadata,
    dialect: &str,
    sql: &str,
    limits: QueryLimits,
    keep: usize,
) -> Result<(GridQueryResult, bool), CatalogError> {
    let mut result = connection.grid_query_values_bounded(sql, &[], limits).await.map_err(super::catalog_query_error)?;
    let has_more = result.rows.len() > keep;
    result.rows.truncate(keep);
    let checks = sqlite_check_precisions(connection, metadata, dialect).await?;
    declared_precision(metadata, dialect, &checks, &mut result)?;
    Ok((result, has_more))
}

#[cfg(test)]
mod tests {
    use super::{fraction, precision, refused, sqlite_dbspec_cell, value, GridCell};

    #[test]
    fn precision_follows_the_native_type_and_dialect_default() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(precision("datetime(6)", "mysql"), Ok(6));
        assert_eq!(precision("datetime", "mysql"), Ok(0));
        assert_eq!(precision("time(3) without time zone", "postgres"), Ok(3));
        assert_eq!(precision("timestamp without time zone", "postgres"), Ok(6));
        assert_eq!(precision("DATETIME", "sqlite"), Err(value::NATIVE_PRECISION));
        assert_eq!(precision("datetime(7)", "mysql"), Err(value::NATIVE_PRECISION));
        assert_eq!(precision("datetime(x)", "mysql"), Err(value::NATIVE_PRECISION));
    }

    #[test]
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
    fn a_sqlite_text_is_checked_for_its_form_before_its_digits() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        use crate::tool_db::sqlite_temporal;
        for (kind, text, rule) in [
            ("date", "2026-1-02", value::SQLITE_DATE_FORM),
            ("date", "0000-01-01", value::DATE_RANGE),
            ("date", "2026-02-30", value::CALENDAR_DATE),
            ("date", "2026-13-01", value::CALENDAR_DATE),
            ("time", "03:04:05.1234567", value::SQLITE_TIME_FORM),
            ("time", "24:00:00", value::TIME_OF_DAY),
            ("time", "23:60:00", value::TIME_OF_DAY),
            ("datetime", "2026-01-02T03:04:05Z", value::SQLITE_DATETIME_FORM),
            ("datetime", "0000-02-30 24:00:00", value::DATE_RANGE),
            ("datetime", "2026-02-30 03:04:05", value::CALENDAR_DATE),
            ("datetime", "2026-01-02 24:00:00", value::TIME_OF_DAY),
        ] {
            assert_eq!(sqlite_temporal(kind, text), Err(rule), "{kind} {text}");
        }
        assert_eq!(sqlite_temporal("datetime", "2026-01-02 03:04:05.000001"), Ok(()));
    }

    #[test]
    fn a_sqlite_dbspec_column_takes_the_fraction_digits_of_its_check() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let cell = |text: &str| GridCell::Text(text.to_owned());
        assert_eq!(sqlite_dbspec_cell("datetime", &mut cell("2026-01-02 03:04:05"), None), Ok(GridCell::DateTime("2026-01-02 03:04:05".into())));
        assert_eq!(sqlite_dbspec_cell("datetime", &mut cell("2026-01-02 03:04:05.000"), None), Err(value::SQLITE_FRACTION));
        assert_eq!(sqlite_dbspec_cell("time", &mut cell("03:04:05.120"), Some(3)), Ok(GridCell::Time("03:04:05.120".into())));
        assert_eq!(sqlite_dbspec_cell("time", &mut cell("03:04:05"), Some(3)), Err(value::SQLITE_FRACTION));
        assert_eq!(sqlite_dbspec_cell("date", &mut GridCell::Integer(20260102), None), Err(value::SQLITE_DATE_FORM));
        assert_eq!(sqlite_dbspec_cell("time", &mut GridCell::Float64(1.5f64.to_bits()), None), Err(value::SQLITE_TIME_FORM));
        assert_eq!(sqlite_dbspec_cell("datetime", &mut GridCell::Null, None), Ok(GridCell::Null));
    }

    #[test]
    fn fraction_keeps_exactly_p_digits_and_rejects_dropped_digits() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(fraction("2026-01-02 03:04:05.120000", 3), Ok("2026-01-02 03:04:05.120".into()));
        assert_eq!(fraction("03:04:05.000000", 0), Ok("03:04:05".into()));
        assert_eq!(fraction("03:04:05.123456", 6), Ok("03:04:05.123456".into()));
        assert_eq!(fraction("03:04:05.123456", 3), Err(value::FRACTION_PAST_PRECISION));
        assert_eq!(fraction("03:04:05", 0), Err(value::UNSUPPORTED_DRIVER_VALUE));
    }

    #[test]
    fn a_described_refusal_names_the_position_of_its_column() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(refused(value::BOOLEAN, 1).message(), "CATALOG_VALUE: column 2: a boolean column holds a value that is not a boolean");
        assert_eq!(
            refused(value::FRACTION_PAST_PRECISION, 0).message(),
            "GRID_TEMPORAL_PRECISION: column 1: temporal value has more fraction digits than its precision"
        );
    }
}
