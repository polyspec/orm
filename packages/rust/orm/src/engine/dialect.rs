//! The database-specific pieces of SQL. The planner never writes a quote or a
//! placeholder itself.

use polyspec_orm_schema::dbspec::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    MySql,
    Postgres,
    Sqlite,
}

/// The column types each column function accepts.
pub fn column_function_types(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "day_of_week" | "year" | "month" | "date" => &["date", "datetime"],
        _ => return None,
    })
}

/// The interval unit of a relative value function.
pub fn value_function_unit(name: &str) -> Option<&'static str> {
    Some(match name {
        "seconds_ago" | "seconds_later" => "second",
        "minutes_ago" | "minutes_later" => "minute",
        "hours_ago" | "hours_later" => "hour",
        "days_ago" | "days_later" => "day",
        "months_ago" | "months_later" => "month",
        _ => return None,
    })
}

pub fn is_value_function(name: &str) -> bool {
    value_function_unit(name).is_some() || name == "now" || name == "today"
}

fn quote_with(q: &str, ident: &str) -> String {
    ident.split('.').map(|part| format!("{q}{}{q}", part.replace(q, &format!("{q}{q}")))).collect::<Vec<_>>().join(".")
}

/// Quotes text as a SQL string literal.
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn tuple_in(cols: &[String], rows: &[Vec<String>], negate: bool, values: bool) -> String {
    let parts: Vec<String> = rows.iter().map(|r| format!("({})", r.join(", "))).collect();
    let op = if negate { " NOT IN " } else { " IN " };
    let mut list = parts.join(", ");
    if values {
        list = format!("VALUES {list}");
    }
    format!("({}){op}({list})", cols.join(", "))
}

impl Dialect {
    pub fn parse(name: &str) -> Option<Dialect> {
        match name {
            "mysql" => Some(Dialect::MySql),
            "postgres" => Some(Dialect::Postgres),
            "sqlite" => Some(Dialect::Sqlite),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Dialect::MySql => "mysql",
            Dialect::Postgres => "postgres",
            Dialect::Sqlite => "sqlite",
        }
    }

    pub fn quote(self, ident: &str) -> String {
        match self {
            Dialect::MySql => quote_with("`", ident),
            Dialect::Postgres => quote_with("\"", ident),
            Dialect::Sqlite => quote_with("\"", &ident.split('.').collect::<Vec<_>>().join("__")),
        }
    }

    /// The placeholder of the n-th (1-based) bind.
    pub fn placeholder(self, n: usize) -> String {
        match self {
            Dialect::Postgres => format!("${n}"),
            _ => "?".into(),
        }
    }

    pub fn limit(self, offset: u32, count: u32) -> String {
        match self {
            Dialect::MySql => format!(" LIMIT {offset}, {count}"),
            _ => format!(" LIMIT {count} OFFSET {offset}"),
        }
    }

    pub fn force_index(self, name: &str) -> String {
        match self {
            Dialect::MySql => format!(" FORCE INDEX ({})", quote_with("`", name)),
            Dialect::Postgres => String::new(),
            Dialect::Sqlite => format!(" INDEXED BY {}", quote_with("\"", name)),
        }
    }

    pub fn insert_returning_id(self) -> bool {
        self != Dialect::MySql
    }

    /// The database clock assigned to a column with the given fraction
    /// digits: `CURRENT_TIMESTAMP(p)` on MySQL for `p > 0`, otherwise
    /// `CURRENT_TIMESTAMP`.
    pub fn now(self, precision: i64) -> String {
        if self == Dialect::MySql && precision > 0 {
            format!("CURRENT_TIMESTAMP({precision})")
        } else {
            "CURRENT_TIMESTAMP".into()
        }
    }

    /// Decides whether the codec stage is applied in SQL on writes (MySQL: `ip`). `hex` is applied by the executor on all dialects. A PostgreSQL `bytes` column
    /// is `bytea`, so `ip` is also applied by the executor.
    pub fn handles_style(self, style: &str) -> bool {
        match self {
            Dialect::MySql => style == "ip",
            Dialect::Postgres | Dialect::Sqlite => false,
        }
    }

    /// Decides whether the codec stage is decoded in SQL on reads (MySQL: `ip`). `hex` is not decoded in SQL by any dialect
    /// because `UNHEX` accepts odd lengths and returns NULL for cells with whitespace, so the executor decodes with `host_decode`
    /// to read it exactly (docs/codec.md).
    pub fn decodes_style(self, style: &str) -> bool {
        match self {
            Dialect::MySql => style == "ip",
            Dialect::Postgres | Dialect::Sqlite => false,
        }
    }

    /// Whether ORM-written timestamps come from the executor clock (a `now` slot truncated to the
    /// column's fraction digits): SQLite has no sub-second clock function, and a PostgreSQL clock
    /// rounds into timestamp(p < 6) (docs/protocol.md "Clock").
    pub fn host_now(self) -> bool {
        self != Dialect::MySql
    }

    /// A datetime(p) column as it compares with the six-digit clock of a value function: SQLite
    /// compares text, so a column with p < 6 is extended with zeros to six fraction digits; MySQL
    /// and PostgreSQL compare values.
    pub fn clock_operand(self, col: &str, precision: u8) -> String {
        match (self, precision) {
            (Dialect::Sqlite, 0) => format!("({col} || '.000000')"),
            (Dialect::Sqlite, p) if p < 6 => format!("({col} || '{}')", "0".repeat(6 - usize::from(p))),
            _ => col.to_owned(),
        }
    }

    /// The row lock suffix; SQLite locks through the executor.
    pub fn row_lock(self, mode: &str) -> Option<&'static str> {
        if !matches!(mode, "update" | "share" | "update_nowait" | "share_nowait") {
            return None;
        }
        if self == Dialect::Sqlite {
            return Some("");
        }
        Some(match mode {
            "update" => " FOR UPDATE",
            "share" => " FOR SHARE",
            "update_nowait" => " FOR UPDATE NOWAIT",
            _ => " FOR SHARE NOWAIT",
        })
    }

    pub fn like(self, col: &str, ph: &str) -> String {
        match self {
            Dialect::MySql => format!("{} LIKE {}", ascii_lower(col), ascii_lower(ph)),
            Dialect::Postgres => format!("{col} ILIKE {ph}"),
            Dialect::Sqlite => format!("{col} LIKE {ph} ESCAPE '\\'"),
        }
    }

    pub fn contains_binary(self, col: &str, value: &mut dyn FnMut(&str) -> String) -> String {
        match self {
            // utf8mb4_0900_bin compares code points under LIKE; LIKE BINARY is deprecated since MySQL 8.0.27.
            Dialect::MySql | Dialect::Postgres => format!("{col} LIKE {}", value("like_contains")),
            Dialect::Sqlite => format!("instr({col}, {}) > 0", value("")),
        }
    }

    pub fn upsert(self, conflict: &[String], assigns: &str) -> String {
        match self {
            Dialect::MySql => format!(" ON DUPLICATE KEY UPDATE {assigns}"),
            _ => {
                let q: Vec<String> = conflict.iter().map(|c| quote_with("\"", c)).collect();
                format!(" ON CONFLICT ({}) DO UPDATE SET {assigns}", q.join(", "))
            }
        }
    }

    /// The expression that reads a column: wraps the read stage applied in SQL and the type read as text.
    /// `time(p)` is read as `HH:MM:SS` text with p fractional digits, and PostgreSQL `uuid` is read as text.
    pub fn read_expr(self, col: &str, ty: Type, styles: &[&str]) -> String {
        match self {
            Dialect::MySql => {
                let mut expr = match ty {
                    Type::Time(_) => format!("CAST({col} AS CHAR)"),
                    _ => col.to_owned(),
                };
                for s in styles.iter().rev() {
                    if *s == "ip" {
                        expr = format!("INET6_NTOA({expr})");
                    }
                }
                expr
            }
            Dialect::Postgres => match ty {
                Type::Uuid => format!("CAST({col} AS text)"),
                Type::Time(0) => format!("to_char({col}, 'HH24:MI:SS')"),
                Type::Time(p) => format!("substr(to_char({col}, 'HH24:MI:SS.US'), 1, {})", 9 + p as usize),
                _ => col.to_owned(),
            },
            Dialect::Sqlite => col.to_owned(),
        }
    }

    /// The expression that writes a bind value to a column: wraps the write stage applied in SQL and the
    /// type sent as text. PostgreSQL `uuid` and `time` cast the text.
    pub fn write_expr(self, ph: String, ty: Type, styles: &[&str]) -> String {
        match self {
            Dialect::MySql => {
                let mut expr = ph;
                for s in styles {
                    if *s == "ip" {
                        expr = format!("INET6_ATON({expr})");
                    }
                }
                expr
            }
            Dialect::Postgres => match ty {
                Type::Uuid => format!("CAST(CAST({ph} AS text) AS uuid)"),
                Type::Time(_) => format!("CAST(CAST({ph} AS text) AS time)"),
                _ => ph,
            },
            Dialect::Sqlite => ph,
        }
    }

    /// Renders the column function applied to `col`. A column function takes no arguments.
    pub fn column_function(self, name: &str, col: &str) -> Option<String> {
        Some(match (self, name) {
            (Dialect::MySql, "day_of_week") => format!("DAYOFWEEK({col})"),
            (Dialect::MySql, "year") => format!("YEAR({col})"),
            (Dialect::MySql, "month") => format!("MONTH({col})"),
            (Dialect::MySql, "date") => format!("DATE({col})"),
            (Dialect::Postgres, "day_of_week") => format!("(EXTRACT(DOW FROM {col})::int + 1)"),
            (Dialect::Postgres, "year") => format!("EXTRACT(YEAR FROM {col})::int"),
            (Dialect::Postgres, "month") => format!("EXTRACT(MONTH FROM {col})::int"),
            (Dialect::Postgres, "date") => format!("CAST({col} AS date)"),
            (Dialect::Sqlite, "day_of_week") => format!("(CAST(strftime('%w', {col}) AS INTEGER) + 1)"),
            (Dialect::Sqlite, "year") => format!("CAST(strftime('%Y', {col}) AS INTEGER)"),
            (Dialect::Sqlite, "month") => format!("CAST(strftime('%m', {col}) AS INTEGER)"),
            (Dialect::Sqlite, "date") => format!("date({col})"),
            _ => return None,
        })
    }

    /// Renders a value function; `arg` binds the interval amount and `now`
    /// binds the executor clock, both in SQL text order.
    pub fn value_function(self, name: &str, arg: &mut dyn FnMut() -> String, now: &mut dyn FnMut() -> String) -> Option<String> {
        match (self, name) {
            (Dialect::MySql, "now") => return Some("NOW(6)".into()),
            (Dialect::MySql, "today") => return Some("CURDATE()".into()),
            // The executor clock is bound, so one statement has one clock: now() is the
            // transaction start and statement_timestamp() the statement start
            // (postgres.now.transaction_start).
            (Dialect::Postgres, "now") => return Some(format!("CAST({} AS timestamp(6))", now())),
            (Dialect::Postgres, "today") => return Some("CURRENT_DATE".into()),
            (Dialect::Sqlite, "now") => return Some(now()),
            (Dialect::Sqlite, "today") => return Some(format!("date({})", now())),
            _ => {}
        }
        let unit = value_function_unit(name)?;
        let later = name.ends_with("_later");
        Some(match self {
            Dialect::MySql => {
                let f = if later { "DATE_ADD" } else { "DATE_SUB" };
                guard_result(&mut || format!("{f}(NOW(6), INTERVAL {} {})", guard_interval(unit, "", arg), unit.to_uppercase()))
            }
            Dialect::Postgres => {
                let op = if later { " + " } else { " - " };
                let field = match unit {
                    "second" => "secs",
                    "minute" => "mins",
                    "hour" => "hours",
                    "day" => "days",
                    _ => "months",
                };
                let cast = if field == "secs" { "double precision" } else { "integer" };
                let operand_cast = if cast == "double precision" { cast } else { "bigint" };
                guard_result(&mut || {
                    let clock = format!("CAST({} AS timestamp(6))", now());
                    let interval = guard_interval(unit, operand_cast, arg);
                    format!("({clock}{op}make_interval({field} => CAST({interval} AS {cast})))")
                })
            }
            Dialect::Sqlite => {
                // datetime returns whole seconds: append the six fraction
                // digits of a second clock slot, which equals the first in
                // one statement.
                let sign = if later { "'+'" } else { "'-'" };
                let floor = if unit == "month" { ", 'floor'" } else { "" };
                guard_result(&mut || {
                    let clock = now();
                    let modifier = format!("{sign} || CAST({} AS TEXT) || ' {unit}s'{floor}", arg());
                    format!("(datetime({clock}, {modifier}) || substr({}, 20))", now())
                })
            }
        })
    }

    pub fn tuple_in(self, cols: &[String], rows: &[Vec<String>], negate: bool) -> String {
        tuple_in(cols, rows, negate, self == Dialect::Sqlite)
    }

    /// The statement that restarts the table's identity column from the value after the largest key. For an empty table
    /// the next key is 1.
    /// - MySQL: if InnoDB sets AUTO_INCREMENT to a value at or below the column's largest value, it sets it to the largest value plus 1,
    ///   so 1 is always after the largest key. Since it is DDL, it commits an open transaction.
    /// - PostgreSQL: sets the identity sequence to the largest key plus 1 and leaves is_called false, so
    ///   the next nextval returns that value. The first argument of pg_get_serial_sequence is read as an identifier, so
    ///   it is the quoted table name, and the second argument is the column name as is.
    /// - SQLite: the next key of an AUTOINCREMENT table is the seq in sqlite_sequence plus 1, so it sets seq to the largest
    ///   key. If the table has never received a row and so has no row in sqlite_sequence, the next key is already
    ///   after the largest key.
    pub fn restart_identity(self, table: &str, column: &str) -> String {
        match self {
            Dialect::MySql => format!("ALTER TABLE {} AUTO_INCREMENT = 1", quote_with("`", table)),
            Dialect::Postgres => {
                let t = quote_with("\"", table);
                format!(
                    "SELECT setval(pg_get_serial_sequence({}, {}), COALESCE(MAX({}), 0) + 1, false) FROM {t}",
                    literal(&t),
                    literal(column),
                    quote_with("\"", column)
                )
            }
            Dialect::Sqlite => format!(
                "UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX({}), 0) FROM {}) WHERE name = {}",
                quote_with("\"", column),
                quote_with("\"", table),
                literal(table)
            ),
        }
    }

    /// The clause that sorts NULL before every value ascending and after every value descending; PostgreSQL alone needs it.
    pub fn nulls_order(self, desc: bool) -> &'static str {
        match self {
            Dialect::Postgres if desc => " NULLS LAST",
            Dialect::Postgres => " NULLS FIRST",
            _ => "",
        }
    }

    pub fn random(self) -> &'static str {
        match self {
            Dialect::MySql => "RAND()",
            _ => "random()",
        }
    }
}

/// 26 nested REPLACE calls, one for each of A to Z with its lower case: MySQL LIKE under utf8mb4_0900_bin then
/// folds the ASCII letters only, as PostgreSQL ILIKE under "C" and SQLite LIKE do.
fn ascii_lower(x: &str) -> String {
    let mut s = "REPLACE(".repeat(26) + x;
    for c in b'A'..=b'Z' {
        s.push_str(&format!(", '{}', '{}')", c as char, c.to_ascii_lowercase() as char));
    }
    s
}

/// The largest interval of each unit that stays inside orm's range, 0001-01-01 to 9999-12-31 (3652059 days): a
/// relative time function whose interval exceeds it is NULL, so no database computes it and PostgreSQL never fails
/// with interval out of range (postgres.relative.interval_out_of_range).
fn interval_bound(unit: &str) -> &'static str {
    match unit {
        "second" => "315537897600",
        "minute" => "5258964960",
        "hour" => "87649416",
        "day" => "3652059",
        _ => "119988",
    }
}

/// The interval argument of a relative time function, NULL past its bound. The guard sits inside the argument, not
/// around the function, so a database that folds constants never evaluates an out-of-range interval.
fn guard_interval(unit: &str, operand_cast: &str, arg: &mut dyn FnMut() -> String) -> String {
    // A typed placeholder needs its cast on both sides: PostgreSQL infers an uncast THEN placeholder as text.
    let cast = |placeholder: String| if operand_cast.is_empty() { placeholder } else { format!("CAST({placeholder} AS {operand_cast})") };
    let operand = cast(arg());
    let bound = interval_bound(unit);
    let then = cast(arg());
    format!("CASE WHEN {operand} BETWEEN -{bound} AND {bound} THEN {then} END")
}

/// A relative time value, NULL outside 0001-01-01 00:00:00 to 9999-12-31 23:59:59.999999: past the range MySQL and
/// SQLite give NULL, below it they give the year 0000 (mysql.relative.out_of_range_null,
/// sqlite.relative.out_of_range_null), and PostgreSQL gives the year 10000 or later.
fn guard_result(value: &mut dyn FnMut() -> String) -> String {
    let first = value();
    let then = value();
    format!("CASE WHEN {first} BETWEEN '0001-01-01 00:00:00' AND '9999-12-31 23:59:59.999999' THEN {then} END")
}
