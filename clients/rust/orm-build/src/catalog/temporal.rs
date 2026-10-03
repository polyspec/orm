//! 기술된 table의 read: time과 datetime cell을 column이 선언한 precision p만큼의 소수
//! 자릿수로 쓴다(docs/dbspec.md). grid decode는 여섯 자리를 쓰므로 나머지 자리는 0이어야 한다.
//! SQLite는 선언된 temporal column의 dbspec text를 같은 temporal cell로 바꾼다.
use super::TableMetadata;
use crate::tool_db::{is_temporal, Conn, GridCell, GridQueryResult, QueryLimits, P};

/// native type의 `(p)`. 없으면 dialect의 기본값: MySQL `time`과 `datetime`은 0, PostgreSQL
/// `time`과 `timestamp`는 6이다.
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

/// 여섯 자리 소수의 text를 p자리로 줄인다. 버리는 자리가 0이 아니면 오류다.
fn fraction(text: &str, p: usize, column: &str) -> Result<String, String> {
    let Some((whole, digits)) = text.split_once('.') else {
        return Err(format!("GRID_TEMPORAL_PRECISION: {column} has no fraction digits"));
    };
    if digits.len() != 6 || !digits[p..].bytes().all(|digit| digit == b'0') {
        return Err(format!("GRID_TEMPORAL_PRECISION: {column} has more fraction digits than its precision {p}"));
    }
    Ok(if p == 0 { whole.to_owned() } else { format!("{whole}.{}", &digits[..p]) })
}

/// SQLite의 선언된 `DATE`, `TIME`, `DATETIME` column의 dbspec 종류. SQLite에는 temporal storage
/// class가 없고 renderer CHECK가 text 형식과 p자리 소수를 강제한다.
fn sqlite_kind(native_type: &str) -> Option<&'static str> {
    match native_type.to_ascii_uppercase().as_str() {
        "DATE" => Some("date"),
        "TIME" => Some("time"),
        "DATETIME" => Some("datetime"),
        _ => None,
    }
}

/// result의 time과 datetime cell을 metadata column의 precision으로 쓴다. SQLite의 선언된
/// temporal column은 저장된 dbspec text를 MySQL, PostgreSQL과 같은 temporal cell로 바꾼다.
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

/// metadata의 column을 모두 고른 statement를 실행하고 temporal cell에 column precision을 적용한다.
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
    fn precision_follows_the_native_type_and_dialect_default() {
        let _case = orm_testcase::case!(orm_testcase::COMPUTE);
        assert_eq!(precision("datetime(6)", "mysql"), Ok(6));
        assert_eq!(precision("datetime", "mysql"), Ok(0));
        assert_eq!(precision("time(3) without time zone", "postgres"), Ok(3));
        assert_eq!(precision("timestamp without time zone", "postgres"), Ok(6));
        assert!(precision("DATETIME", "sqlite").is_err());
        assert!(precision("datetime(7)", "mysql").is_err());
    }

    #[test]
    fn temporal_text_follows_the_dbspec_forms() {
        let _case = orm_testcase::case!(orm_testcase::COMPUTE);
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
    fn fraction_keeps_exactly_p_digits_and_rejects_dropped_digits() {
        let _case = orm_testcase::case!(orm_testcase::COMPUTE);
        assert_eq!(fraction("2026-01-02 03:04:05.120000", 3, "c"), Ok("2026-01-02 03:04:05.120".into()));
        assert_eq!(fraction("03:04:05.000000", 0, "c"), Ok("03:04:05".into()));
        assert_eq!(fraction("03:04:05.123456", 6, "c"), Ok("03:04:05.123456".into()));
        assert!(fraction("03:04:05.123456", 3, "c").is_err_and(|e| e.contains("more fraction digits than its precision 3")));
        assert!(fraction("03:04:05", 0, "c").is_err());
    }
}
