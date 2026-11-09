//! The refusals of a catalog conversion of a driver value: one code and one text per rule of docs/spec/interfaces.md
//! "Catalog value rules" (INT-165 to INT-186), and the 1-based position of the column whose value breaks it.

use polyspec_orm::codes::{CATALOG_VALUE, GRID_TEMPORAL_PRECISION, GRID_TEMPORAL_VALUE};

/// One rule of the catalog value rules: its code and its text, which names no value, no type and no column label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub code: &'static str,
    pub text: &'static str,
}

/// INT-166
pub const MYSQL_YEAR: Rule = Rule { code: CATALOG_VALUE, text: "MySQL YEAR has no grid cell" };
/// INT-167
pub const MYSQL_TIMESTAMP: Rule = Rule { code: CATALOG_VALUE, text: "MySQL TIMESTAMP follows a time zone" };
/// INT-168
pub const POSTGRES_ZONED: Rule = Rule { code: CATALOG_VALUE, text: "PostgreSQL timestamptz and timetz are unsupported" };
/// INT-169
pub const POSTGRES_NUMERIC_NOT_FINITE: Rule = Rule { code: CATALOG_VALUE, text: "PostgreSQL numeric is not finite" };
/// INT-170
pub const UNSUPPORTED_NATIVE_TYPE: Rule = Rule { code: CATALOG_VALUE, text: "unsupported native type" };
/// INT-171
pub const UNSUPPORTED_DRIVER_VALUE: Rule = Rule { code: CATALOG_VALUE, text: "unsupported driver value" };
/// INT-172
pub const UNDECODABLE: Rule = Rule { code: CATALOG_VALUE, text: "the driver could not decode the value" };
/// INT-173
pub const DATE_RANGE: Rule = Rule { code: GRID_TEMPORAL_VALUE, text: "date outside 0001-01-01 to 9999-12-31" };
/// INT-174
pub const CALENDAR_DATE: Rule = Rule { code: GRID_TEMPORAL_VALUE, text: "date is not a calendar date" };
/// INT-175
pub const TIME_OF_DAY: Rule = Rule { code: GRID_TEMPORAL_VALUE, text: "time outside 00:00:00 to 23:59:59.999999" };
/// INT-176
pub const SQLITE_DATE_FORM: Rule = Rule { code: GRID_TEMPORAL_VALUE, text: "the stored value is not a dbspec date" };
/// INT-177
pub const SQLITE_TIME_FORM: Rule = Rule { code: GRID_TEMPORAL_VALUE, text: "the stored value is not a dbspec time" };
/// INT-178
pub const SQLITE_DATETIME_FORM: Rule = Rule { code: GRID_TEMPORAL_VALUE, text: "the stored value is not a dbspec datetime" };
/// INT-179
pub const SQLITE_FRACTION: Rule = Rule { code: GRID_TEMPORAL_PRECISION, text: "the fraction digits are not the count that its dbspec CHECK fixes" };
/// INT-180
pub const FRACTION_PAST_PRECISION: Rule = Rule { code: GRID_TEMPORAL_PRECISION, text: "temporal value has more fraction digits than its precision" };
/// INT-181
pub const NATIVE_PRECISION: Rule = Rule { code: GRID_TEMPORAL_PRECISION, text: "native type declares more than 6 fraction digits" };
/// INT-182
pub const BOOLEAN: Rule = Rule { code: CATALOG_VALUE, text: "a boolean column holds a value that is not a boolean" };
/// INT-186
pub const OUTPUT_SETTING_CHANGED: Rule = Rule { code: CATALOG_VALUE, text: "the query changed a setting that the output of its values depends on" };

/// A value that a catalog conversion refuses by one rule, at the 1-based position of its column. A driver or library failure
/// (INT-172) names no column and keeps that failure as its source.
#[derive(Debug)]
pub struct ValueRefusal {
    rule: Rule,
    column: Option<usize>,
    source: Option<Box<dyn std::error::Error + Send + Sync + 'static>>,
}

impl ValueRefusal {
    pub fn new(rule: Rule, column: usize) -> Self {
        Self { rule, column: Some(column), source: None }
    }
    /// A refusal of the read as a whole, which names no column (INT-186).
    pub(crate) fn of_read(rule: Rule) -> Self {
        Self { rule, column: None, source: None }
    }
    /// INT-172: the failure of the driver or of a library, kept as the source. It names no column, since a driver of one runtime
    /// (Go database/sql) does not tell which column it failed to decode.
    pub fn undecodable(source: impl Into<Box<dyn std::error::Error + Send + Sync + 'static>>) -> Self {
        Self { rule: UNDECODABLE, column: None, source: Some(source.into()) }
    }
    pub fn rule(&self) -> Rule {
        self.rule
    }
    pub fn code(&self) -> &'static str {
        self.rule.code
    }
    /// The 1-based position of the column, or None for INT-172, which names none.
    pub fn column(&self) -> Option<usize> {
        self.column
    }
    /// The failure of the driver or of a library that the refusal keeps (INT-172).
    pub(crate) fn into_source(self) -> Option<Box<dyn std::error::Error + Send + Sync + 'static>> {
        self.source
    }
}

impl std::fmt::Display for ValueRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.column {
            Some(column) => write!(f, "{}: column {column}: {}", self.rule.code, self.rule.text),
            None => write!(f, "{}: {}", self.rule.code, self.rule.text),
        }
    }
}

impl std::error::Error for ValueRefusal {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        cause(&self.source)
    }
}

/// The cause that an error keeps in its `source` field, as `std::error::Error::source` answers it.
pub(crate) fn cause<'a>(source: &'a Option<Box<dyn std::error::Error + Send + Sync + 'static>>) -> Option<&'a (dyn std::error::Error + 'static)> {
    source.as_deref().map(|source| source as &(dyn std::error::Error + 'static))
}

/// A driver value whose format or length is not that of its type: a failure of the driver's value, which INT-172 keeps as the
/// cause.
#[derive(Debug)]
pub(crate) struct Malformed {
    what: &'static str,
    source: Option<Box<dyn std::error::Error + Send + Sync + 'static>>,
}
impl std::fmt::Display for Malformed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed binary driver value: {}", self.what)
    }
}
impl std::error::Error for Malformed {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        cause(&self.source)
    }
}

pub(crate) fn malformed(what: &'static str) -> sqlx::Error {
    sqlx::Error::Decode(Box::new(Malformed { what, source: None }))
}

/// A malformed driver value whose part failed to convert, with that failure as the source.
pub(crate) fn malformed_by(what: &'static str, source: impl std::error::Error + Send + Sync + 'static) -> sqlx::Error {
    sqlx::Error::Decode(Box::new(Malformed { what, source: Some(Box::new(source)) }))
}

/// The error of a conversion that refuses its value by `rule`. Its column is set where the row is converted (`at_column`).
pub(crate) fn refuse(rule: Rule) -> sqlx::Error {
    sqlx::Error::Decode(Box::new(ValueRefusal::new(rule, 0)))
}

/// The error of a conversion whose driver value is not of the host form that the conversion takes for its column (INT-171).
pub(crate) fn unsupported_driver_value() -> sqlx::Error {
    refuse(UNSUPPORTED_DRIVER_VALUE)
}

/// The refusal that a conversion error of the value at the 0-based `index` of its row leaves with: a refusal takes the
/// position of its column, and any other error is a failure of the driver or of a library, which INT-172 keeps as the cause.
pub(crate) fn at_column(error: sqlx::Error, index: usize) -> sqlx::Error {
    let column = index + 1;
    match error {
        sqlx::Error::Decode(inner) => match inner.downcast::<ValueRefusal>() {
            Ok(mut refusal) => {
                if refusal.column.is_some() {
                    refusal.column = Some(column);
                }
                sqlx::Error::Decode(refusal)
            }
            Err(inner) => sqlx::Error::Decode(Box::new(ValueRefusal::undecodable(sqlx::Error::Decode(inner)))),
        },
        other => sqlx::Error::Decode(Box::new(ValueRefusal::undecodable(other))),
    }
}

/// The refusal that an error of a catalog read is, or the error itself when it is none.
pub(crate) fn take_refusal(error: sqlx::Error) -> Result<ValueRefusal, sqlx::Error> {
    match error {
        sqlx::Error::Decode(inner) => inner.downcast::<ValueRefusal>().map(|refusal| *refusal).map_err(sqlx::Error::Decode),
        other => Err(other),
    }
}

/// The refusal that an error of a catalog read holds, if it is one.
pub fn refusal_of(error: &sqlx::Error) -> Option<&ValueRefusal> {
    match error {
        sqlx::Error::Decode(inner) => inner.downcast_ref::<ValueRefusal>(),
        _ => None,
    }
}
