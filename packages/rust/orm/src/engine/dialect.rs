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

/// text를 SQL 문자열 literal로 quote한다.
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

    /// 쓰기에서 codec stage를 SQL에서 적용하는지 판단한다. PostgreSQL의 `bytes` column은
    /// `bytea`라서 `ip`도 executor가 적용한다.
    pub fn handles_style(self, style: &str) -> bool {
        match self {
            Dialect::MySql => style == "hex" || style == "ip",
            Dialect::Postgres | Dialect::Sqlite => false,
        }
    }

    /// 읽기에서 codec stage를 SQL에서 푸는지 판단한다(MySQL: `ip`). `hex`는 어느 dialect도 SQL에서
    /// 풀지 않는다: `UNHEX`는 홀수 길이를 받고 공백이 있는 셀에 NULL을 내므로, executor가 `host_decode`로
    /// 정확히 읽는다(docs/codec.md).
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

    /// column을 읽는 expression: SQL에서 적용하는 read stage와 text로 읽는 type을 감싼다.
    /// `time(p)`는 소수 p자리의 `HH:MM:SS` text로, PostgreSQL `uuid`는 text로 읽는다.
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

    /// bind 값을 column에 쓰는 expression: SQL에서 적용하는 write stage와 text로
    /// 보내는 type을 감싼다. PostgreSQL `uuid`와 `time`은 text를 cast한다.
    pub fn write_expr(self, ph: String, ty: Type, styles: &[&str]) -> String {
        match self {
            Dialect::MySql => {
                let mut expr = ph;
                for s in styles {
                    match *s {
                        "hex" => expr = format!("HEX({expr})"),
                        "ip" => expr = format!("INET6_ATON({expr})"),
                        _ => {}
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

    /// `col`에 적용한 column function을 render한다. column function은 인자를 받지 않는다.
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
                format!("{f}(NOW(6), INTERVAL {} {})", arg(), unit.to_uppercase())
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
                let clock = format!("CAST({} AS timestamp(6))", now());
                format!("({clock}{op}make_interval({field} => CAST({} AS {cast})))", arg())
            }
            Dialect::Sqlite => {
                // datetime returns whole seconds: append the six fraction
                // digits of a second clock slot, which equals the first in
                // one statement.
                let sign = if later { "'+'" } else { "'-'" };
                let clock = now();
                let floor = if unit == "month" { ", 'floor'" } else { "" };
                let modifier = format!("{sign} || CAST({} AS TEXT) || ' {unit}s'{floor}", arg());
                format!("(datetime({clock}, {modifier}) || substr({}, 20))", now())
            }
        })
    }

    pub fn tuple_in(self, cols: &[String], rows: &[Vec<String>], negate: bool) -> String {
        tuple_in(cols, rows, negate, self == Dialect::Sqlite)
    }

    /// table의 identity column을 가장 큰 key 다음 값에서 다시 시작하는 statement다. 빈 table이면
    /// 다음 key는 1이다.
    /// - MySQL: InnoDB는 AUTO_INCREMENT를 column의 가장 큰 값 이하로 정하면 가장 큰 값에 1을 더한
    ///   값으로 정하므로 1은 언제나 가장 큰 key 다음이다. DDL이므로 열린 transaction을 commit한다.
    /// - PostgreSQL: identity sequence를 가장 큰 key에 1을 더한 값으로 정하고 is_called를 false로 두어
    ///   다음 nextval이 그 값을 돌려주게 한다. pg_get_serial_sequence의 첫 인자는 identifier로 읽히므로
    ///   quote한 table 이름이고, 둘째 인자는 column 이름 그대로다.
    /// - SQLite: AUTOINCREMENT table의 다음 key는 sqlite_sequence의 seq에 1을 더한 값이므로 seq를 가장
    ///   큰 key로 정한다. table이 아직 행을 받은 적이 없어 sqlite_sequence에 행이 없으면 다음 key는 이미
    ///   가장 큰 key 다음이다.
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
