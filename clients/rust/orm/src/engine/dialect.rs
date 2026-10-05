//! The database-specific pieces of SQL. The planner never writes a quote or a
//! placeholder itself.

use orm_schema::dbspec::Type;

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

    /// codec stage를 SQL에서 적용하는지 판단한다. PostgreSQL의 `bytes` column은
    /// `bytea`라서 `ip`도 executor가 적용한다.
    pub fn handles_style(self, style: &str) -> bool {
        match self {
            Dialect::MySql => style == "hex" || style == "ip",
            Dialect::Postgres | Dialect::Sqlite => false,
        }
    }

    /// Whether ORM-written timestamps come from the executor clock.
    pub fn host_now(self) -> bool {
        self == Dialect::Sqlite
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
            Dialect::MySql => format!("{col} LIKE {ph}"),
            Dialect::Postgres => format!("{col} ILIKE {ph}"),
            Dialect::Sqlite => format!("{col} LIKE {ph} ESCAPE '\\'"),
        }
    }

    pub fn contains_binary(self, col: &str, value: &mut dyn FnMut(&str) -> String) -> String {
        match self {
            Dialect::MySql => format!("{col} LIKE BINARY {}", value("like_contains")),
            Dialect::Postgres => format!("{col} LIKE {}", value("like_contains")),
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
                    match *s {
                        "hex" => expr = format!("UNHEX({expr})"),
                        "ip" => expr = format!("INET6_NTOA({expr})"),
                        _ => {}
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
            (Dialect::Postgres, "now") => return Some("now()".into()),
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
                format!("(now(){op}make_interval({field} => CAST({} AS {cast})))", arg())
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

    pub fn random(self) -> &'static str {
        match self {
            Dialect::MySql => "RAND()",
            _ => "random()",
        }
    }
}
