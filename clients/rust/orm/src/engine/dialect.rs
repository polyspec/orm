//! The database-specific pieces of SQL. The planner never writes a quote or a
//! placeholder itself.

/// Replaced in code-owned expression fragments with the dialect's advancing
/// wall-clock expression.
pub const CURRENT_TIME_TOKEN: &str = "$CURRENT_TIME";

/// The sphere radius of MySQL `ST_Distance_Sphere`, used by the portable
/// haversine rendering.
const EARTH_RADIUS_METERS: &str = "6370986";

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
        "distance" | "point_x" | "point_y" => &["point"],
        _ => return None,
    })
}

/// The function arguments of a column function, not counting the compared value.
pub fn column_function_arity(name: &str) -> usize {
    if name == "distance" {
        2
    } else {
        0
    }
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

/// The great-circle distance. `x2` and `y2` are called once per occurrence so
/// positional placeholders receive one bind each.
fn haversine(x1: &str, y1: &str, x2: &mut dyn FnMut() -> String, y2: &mut dyn FnMut() -> String) -> String {
    let rad = |v: String| format!("RADIANS({v})");
    let a = rad(y2());
    let b = rad(y2());
    let c = rad(x2());
    format!(
        "(2 * {EARTH_RADIUS_METERS} * ASIN(SQRT(POWER(SIN(({a} - {y1r}) / 2), 2) + COS({y1r}) * COS({b}) * POWER(SIN(({c} - {x1r}) / 2), 2))))",
        y1r = rad(y1.to_owned()),
        x1r = rad(x1.to_owned()),
    )
}

fn sqlite_point_coordinate(col: &str, second: bool) -> String {
    let space = format!("instr({col}, ' ')");
    if second {
        format!("CAST(substr({col}, {space} + 1, length({col}) - {space} - 1) AS REAL)")
    } else {
        format!("CAST(substr({col}, 7, {space} - 7) AS REAL)")
    }
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

    pub fn now(self) -> &'static str {
        "CURRENT_TIMESTAMP"
    }

    pub fn current_time(self) -> &'static str {
        match self {
            Dialect::Postgres => "clock_timestamp()",
            _ => "CURRENT_TIMESTAMP",
        }
    }

    /// Whether a predicate operator exists in this dialect.
    pub fn supports(self, op: &str) -> bool {
        self != Dialect::Sqlite || (op != "match" && op != "match_boolean")
    }

    /// Whether a column style stage is applied in SQL.
    pub fn handles_style(self, style: &str) -> bool {
        match self {
            Dialect::MySql => style == "hex" || style == "ip",
            Dialect::Postgres => style == "ip",
            Dialect::Sqlite => false,
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

    pub fn fulltext(self, cols: &[String], ph: &str, boolean: bool) -> String {
        match self {
            Dialect::MySql => {
                let mode = if boolean { " IN BOOLEAN MODE" } else { " IN NATURAL LANGUAGE MODE" };
                format!("MATCH({}) AGAINST ({ph}{mode})", cols.join(", "))
            }
            _ => {
                let doc = if cols.len() > 1 { format!("coalesce({}, '')", cols.join(", '') || ' ' || coalesce(")) } else { cols.join(" || ' ' || ") };
                let f = if boolean { "websearch_to_tsquery" } else { "plainto_tsquery" };
                format!("to_tsvector('simple', {doc}) @@ {f}('simple', {ph})")
            }
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

    /// Wraps the SQL-side read stages of a column.
    pub fn read_expr(self, col: &str, col_type: &str, styles: &[&str]) -> String {
        match self {
            Dialect::MySql => {
                let mut expr = if col_type == "point" { format!("ST_AsText({col})") } else { col.to_owned() };
                for s in styles.iter().rev() {
                    match *s {
                        "hex" => expr = format!("UNHEX({expr})"),
                        "ip" => expr = format!("INET6_NTOA({expr})"),
                        _ => {}
                    }
                }
                expr
            }
            Dialect::Postgres => {
                let col = if col_type == "point" { format!("({col})::text") } else { col.to_owned() };
                if styles.contains(&"ip") {
                    return format!("host({col})");
                }
                col
            }
            Dialect::Sqlite => col.to_owned(),
        }
    }

    /// Wraps a bound value with the SQL-side write stages of a column.
    pub fn write_expr(self, ph: String, col_type: &str, styles: &[&str]) -> String {
        match self {
            Dialect::MySql => {
                let mut expr = if col_type == "point" { format!("ST_PointFromText({ph})") } else { ph };
                for s in styles {
                    match *s {
                        "hex" => expr = format!("HEX({expr})"),
                        "ip" => expr = format!("INET6_ATON({expr})"),
                        _ => {}
                    }
                }
                expr
            }
            Dialect::Postgres => {
                let mut expr = if col_type == "point" { format!("CAST({ph} AS text)::point") } else { ph };
                for s in styles {
                    if *s == "ip" {
                        expr = format!("({expr})::inet");
                    }
                }
                expr
            }
            Dialect::Sqlite => ph,
        }
    }

    /// Renders a column function applied to `col`; `arg(i)` binds the i-th
    /// function argument.
    pub fn column_function(self, name: &str, col: &str, arg: &mut dyn FnMut(usize) -> String) -> Option<String> {
        Some(match (self, name) {
            (Dialect::MySql, "day_of_week") => format!("DAYOFWEEK({col})"),
            (Dialect::MySql, "year") => format!("YEAR({col})"),
            (Dialect::MySql, "month") => format!("MONTH({col})"),
            (Dialect::MySql, "date") => format!("DATE({col})"),
            (Dialect::MySql, "distance") => {
                let (x, y) = (arg(0), arg(1));
                format!("ST_Distance_Sphere({col}, POINT({x}, {y}))")
            }
            (Dialect::MySql, "point_x") => format!("ST_X({col})"),
            (Dialect::MySql, "point_y") => format!("ST_Y({col})"),
            (Dialect::Postgres, "day_of_week") => format!("(EXTRACT(DOW FROM {col})::int + 1)"),
            (Dialect::Postgres, "year") => format!("EXTRACT(YEAR FROM {col})::int"),
            (Dialect::Postgres, "month") => format!("EXTRACT(MONTH FROM {col})::int"),
            (Dialect::Postgres, "date") => format!("CAST({col} AS date)"),
            (Dialect::Postgres, "distance") => {
                let cell = std::cell::RefCell::new(arg);
                let mut x = || format!("CAST({} AS double precision)", (cell.borrow_mut())(0));
                let mut y = || format!("CAST({} AS double precision)", (cell.borrow_mut())(1));
                haversine(&format!("{col}[0]"), &format!("{col}[1]"), &mut x, &mut y)
            }
            (Dialect::Postgres, "point_x") => format!("{col}[0]"),
            (Dialect::Postgres, "point_y") => format!("{col}[1]"),
            (Dialect::Sqlite, "day_of_week") => format!("(CAST(strftime('%w', {col}) AS INTEGER) + 1)"),
            (Dialect::Sqlite, "year") => format!("CAST(strftime('%Y', {col}) AS INTEGER)"),
            (Dialect::Sqlite, "month") => format!("CAST(strftime('%m', {col}) AS INTEGER)"),
            (Dialect::Sqlite, "date") => format!("date({col})"),
            (Dialect::Sqlite, "distance") => {
                let cell = std::cell::RefCell::new(arg);
                let mut x = || (cell.borrow_mut())(0);
                let mut y = || (cell.borrow_mut())(1);
                haversine(&sqlite_point_coordinate(col, false), &sqlite_point_coordinate(col, true), &mut x, &mut y)
            }
            (Dialect::Sqlite, "point_x") => sqlite_point_coordinate(col, false),
            (Dialect::Sqlite, "point_y") => sqlite_point_coordinate(col, true),
            _ => return None,
        })
    }

    /// Renders a value function; `arg` binds the interval amount and `now`
    /// binds the executor clock, both in SQL text order.
    pub fn value_function(self, name: &str, arg: &mut dyn FnMut() -> String, now: &mut dyn FnMut() -> String) -> Option<String> {
        match (self, name) {
            (Dialect::MySql, "now") => return Some("NOW()".into()),
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
                format!("{f}(NOW(), INTERVAL {} {})", arg(), unit.to_uppercase())
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
                let sign = if later { "'+'" } else { "'-'" };
                let clock = now();
                let modifier = format!("{sign} || CAST({} AS TEXT) || ' {unit}s'", arg());
                if unit == "month" {
                    format!("datetime({clock}, {modifier}, 'floor')")
                } else {
                    format!("datetime({clock}, {modifier})")
                }
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
