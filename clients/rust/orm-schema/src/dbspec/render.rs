//! The statements that create the tables of a dbspec document set in one
//! dialect (docs/dialects.md, "Rendered statements").

use super::model::{Action, Column, DefaultValue, Document, Expr, ForeignKey, Operand, Setting, Table, Type};
use super::{check_set, Diagnostic};

/// A database whose statements [`render`] writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    MySql,
    Postgres,
    Sqlite,
}

/// Writes the statements that create the tables of the document set in
/// `dialect` (docs/dialects.md, "Rendered statements"), or the diagnostics of
/// an invalid document set, as [`super::manifest`] reports them.
pub fn render(documents: &[&Document], dialect: Dialect) -> Result<Vec<String>, Vec<Diagnostic>> {
    check_set(documents)?;
    let r = Renderer { d: dialect };
    let ordered = use_order(documents);
    let mut out = Vec::new();
    for document in &ordered {
        for table in &document.tables {
            out.extend(r.table(table));
        }
    }
    if dialect != Dialect::Sqlite {
        for document in &ordered {
            for table in &document.tables {
                for key in sorted_by(&table.foreign_keys, |f| &f.name.text) {
                    out.push(format!("ALTER TABLE {} ADD {}", r.q(&table.name.text), r.foreign_key(key)));
                }
            }
        }
    }
    for document in &ordered {
        for table in &document.tables {
            out.extend(r.triggers(table));
        }
    }
    Ok(out)
}

/// Orders documents so that a used document comes before the documents that
/// use it, ties by document name.
fn use_order<'d>(documents: &[&'d Document]) -> Vec<&'d Document> {
    let mut by_name: Vec<&'d Document> = documents.to_vec();
    by_name.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    let mut out = Vec::with_capacity(by_name.len());
    for document in &by_name {
        visit(&document.name.text, &by_name, &mut out);
    }
    out
}

fn visit<'d>(name: &str, by_name: &[&'d Document], out: &mut Vec<&'d Document>) {
    let Some(document) = by_name.iter().find(|d| d.name.text == name) else { return };
    if out.iter().any(|d| d.name.text == name) {
        return;
    }
    let mut used: Vec<&str> = document.uses.iter().map(|u| u.document.text.as_str()).collect();
    used.sort_unstable();
    for u in used {
        visit(u, by_name, out);
    }
    out.push(document);
}

fn sorted_by<T>(items: &[T], key: impl Fn(&T) -> &String) -> Vec<&T> {
    let mut sorted: Vec<&T> = items.iter().collect();
    sorted.sort_by(|a, b| key(a).cmp(key(b)));
    sorted
}

pub(crate) struct Renderer {
    pub d: Dialect,
}

pub(crate) const UUID_PATTERN: &str = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

impl Renderer {
    /// Quotes an identifier.
    pub fn q(&self, name: &str) -> String {
        match self.d {
            Dialect::MySql => format!("`{name}`"),
            Dialect::Postgres | Dialect::Sqlite => format!("\"{name}\""),
        }
    }

    pub fn list<'n>(&self, names: impl IntoIterator<Item = &'n String>) -> String {
        names.into_iter().map(|n| self.q(n)).collect::<Vec<_>>().join(", ")
    }

    pub fn table(&self, t: &Table) -> Vec<String> {
        let mut parts: Vec<String> = t.columns.iter().map(|c| self.column(c)).collect();
        let identity_inline = self.d == Dialect::Sqlite && t.columns.iter().any(|c| c.identity.is_some());
        if !identity_inline {
            for key in &t.primary {
                parts.push(format!("PRIMARY KEY ({})", self.list(key.columns.iter().map(|n| &n.text))));
            }
        }
        if self.d == Dialect::Sqlite {
            for key in sorted_by(&t.foreign_keys, |f| &f.name.text) {
                parts.push(self.foreign_key(key));
            }
        } else {
            for u in sorted_by(&t.uniques, |u| &u.name.text) {
                parts.push(format!("CONSTRAINT {} UNIQUE ({})", self.q(&u.name.text), self.list(u.columns.iter().map(|n| &n.text))));
            }
        }
        for c in &t.columns {
            if let Some(check) = self.type_check(c) {
                parts.push(format!("CONSTRAINT {} CHECK ({check})", self.q(&format!("{}${}", t.name.text, c.name.text))));
            }
        }
        for k in sorted_by(&t.checks, |k| &k.name.text) {
            let mut b = String::new();
            self.predicate(&mut b, t, &k.expr);
            parts.push(format!("CONSTRAINT {} CHECK ({b})", self.q(&k.name.text)));
        }
        let mut create = format!("CREATE TABLE {} ({})", self.q(&t.name.text), parts.join(", "));
        if self.d == Dialect::MySql {
            create.push_str(" ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin");
        }
        let mut out = vec![create];
        if self.d == Dialect::Sqlite {
            for u in sorted_by(&t.uniques, |u| &u.name.text) {
                out.push(format!(
                    "CREATE UNIQUE INDEX {} ON {} ({})",
                    self.q(&u.name.text),
                    self.q(&t.name.text),
                    self.list(u.columns.iter().map(|n| &n.text))
                ));
            }
        }
        for x in sorted_by(&t.indexes, |x| &x.name.text) {
            let columns: Vec<String> =
                x.columns.iter().map(|(name, descending)| if *descending { format!("{} DESC", self.q(&name.text)) } else { self.q(&name.text) }).collect();
            out.push(format!("CREATE INDEX {} ON {} ({})", self.q(&x.name.text), self.q(&t.name.text), columns.join(", ")));
        }
        out
    }

    pub fn column(&self, c: &Column) -> String {
        let name = self.q(&c.name.text);
        if c.identity.is_some() {
            return match self.d {
                Dialect::MySql => format!("{name} BIGINT NOT NULL AUTO_INCREMENT"),
                Dialect::Postgres => format!("{name} bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL"),
                Dialect::Sqlite => format!("{name} INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT"),
            };
        }
        let mut s = format!("{name} {} {}", self.type_text(c.ty), if c.nullable { "NULL" } else { "NOT NULL" });
        if let Some(default) = &c.default {
            s.push_str(&format!(" DEFAULT {}", self.default_text(c.ty, default)));
        }
        s
    }

    /// The default `d` of a column of type `t` in the dialect.
    pub fn default_text(&self, t: Type, d: &DefaultValue) -> String {
        match d {
            DefaultValue::Literal(text) => self.literal(Some(t), text),
            DefaultValue::Now => {
                // Validation allows `default now` only on a datetime(p) column.
                let Type::DateTime(p) = t else { unreachable!("default now on a {} column", t.render()) };
                self.now(p)
            }
        }
    }

    pub fn type_text(&self, t: Type) -> String {
        match self.d {
            Dialect::MySql => match t {
                Type::I16 => "SMALLINT".into(),
                Type::I32 => "INT".into(),
                Type::I64 => "BIGINT".into(),
                Type::Bool => "tinyint(1)".into(),
                Type::Decimal(p, s) => format!("DECIMAL({p},{s})"),
                Type::F64 => "DOUBLE".into(),
                Type::Varchar(n) => format!("varchar({n}) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin"),
                Type::Text => "LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin".into(),
                Type::Bytes => "LONGBLOB".into(),
                Type::Uuid => "char(36) CHARACTER SET ascii COLLATE ascii_bin".into(),
                Type::Date => "DATE".into(),
                Type::Time(p) => format!("TIME({p})"),
                Type::DateTime(p) => format!("DATETIME({p})"),
            },
            Dialect::Postgres => match t {
                Type::I16 => "smallint".into(),
                Type::I32 => "integer".into(),
                Type::I64 => "bigint".into(),
                Type::Bool => "boolean".into(),
                Type::Decimal(p, s) => format!("numeric({p},{s})"),
                Type::F64 => "double precision".into(),
                Type::Varchar(n) => format!("varchar({n}) COLLATE \"C\""),
                Type::Text => "text COLLATE \"C\"".into(),
                Type::Bytes => "bytea".into(),
                Type::Uuid => "uuid".into(),
                Type::Date => "date".into(),
                Type::Time(p) => format!("time({p})"),
                Type::DateTime(p) => format!("timestamp({p})"),
            },
            Dialect::Sqlite => match t {
                Type::I16 => "smallint".into(),
                Type::I32 => "integer".into(),
                Type::I64 => "bigint".into(),
                Type::Bool => "BOOLEAN".into(),
                Type::Decimal(p, s) => format!("DECIMALINT({p},{s})"),
                Type::F64 => "REAL".into(),
                Type::Varchar(n) => format!("varchar({n})"),
                Type::Text | Type::Uuid => "TEXT".into(),
                Type::Bytes => "BLOB".into(),
                Type::Date => "DATE".into(),
                Type::Time(_) => "TIME".into(),
                Type::DateTime(_) => "DATETIME".into(),
            },
        }
    }

    /// The `default now` of a `datetime(p)` column.
    pub fn now(&self, p: u8) -> String {
        match (self.d, p) {
            (Dialect::MySql, _) => format!("CURRENT_TIMESTAMP({p})"),
            (Dialect::Postgres, _) => "statement_timestamp()".into(),
            (Dialect::Sqlite, 0) => "(strftime('%Y-%m-%d %H:%M:%S', 'now'))".into(),
            (Dialect::Sqlite, 1..=3) => format!("(substr(strftime('%Y-%m-%d %H:%M:%f', 'now'), 1, {}))", 20 + u32::from(p)),
            (Dialect::Sqlite, _) => format!("(strftime('%Y-%m-%d %H:%M:%f', 'now') || '{}')", "0".repeat(usize::from(p) - 3)),
        }
    }

    /// Writes a canonical literal met by a column of type `t` in the dialect.
    fn literal(&self, t: Option<Type>, text: &str) -> String {
        if text == "true" || text == "false" {
            return match (self.d, text) {
                (Dialect::Postgres, _) => text.to_uppercase(),
                (_, "true") => "1".into(),
                _ => "0".into(),
            };
        }
        if text.starts_with('\'') {
            return if self.d == Dialect::MySql { text.replace('\\', "\\\\") } else { text.to_owned() };
        }
        if self.d == Dialect::Sqlite && matches!(t, Some(Type::Decimal(..))) {
            return scaled_decimal(text);
        }
        text.to_owned()
    }

    pub fn foreign_key(&self, f: &ForeignKey) -> String {
        format!(
            "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
            self.q(&f.name.text),
            self.list(f.columns.iter().map(|n| &n.text)),
            self.q(&f.table.text),
            self.list(f.references.iter().map(|n| &n.text)),
            action_text(f.on_delete),
            action_text(f.on_update)
        )
    }

    /// The renderer CHECK of a column, or `None` when the dialect enforces
    /// the type itself.
    pub fn type_check(&self, c: &Column) -> Option<String> {
        if c.identity.is_some() {
            return None;
        }
        let q = self.q(&c.name.text);
        match self.d {
            Dialect::MySql => match c.ty {
                Type::Bool => Some(format!("{q} IN (0, 1)")),
                Type::Uuid => Some(format!("REGEXP_LIKE({q}, '{UUID_PATTERN}', 'c')")),
                Type::Time(_) => Some(format!("{q} >= '00:00:00' AND {q} < '24:00:00'")),
                _ => None,
            },
            Dialect::Postgres => match c.ty {
                Type::Time(_) => Some(format!("{q} < '24:00:00'")),
                _ => None,
            },
            Dialect::Sqlite => sqlite_check(&q, c.ty),
        }
    }

    /// Writes a typed check predicate of table `t` in the dialect.
    pub fn predicate(&self, b: &mut String, t: &Table, e: &Expr) {
        match e {
            Expr::Logic(left, op, right) => {
                for (index, side) in [left, right].into_iter().enumerate() {
                    if index > 0 {
                        b.push_str(&format!(" {} ", op.to_uppercase()));
                    }
                    if side.needs_parentheses(op) {
                        b.push('(');
                        self.predicate(b, t, side);
                        b.push(')');
                    } else {
                        self.predicate(b, t, side);
                    }
                }
            }
            Expr::Compare(left, op, _, right) => {
                let ty = [left, right].into_iter().find_map(|o| match o {
                    Operand::Column(name) => column_type(t, &name.text),
                    Operand::Literal(_) => None,
                });
                self.operand(b, ty, left);
                b.push_str(&format!(" {op} "));
                self.operand(b, ty, right);
            }
            Expr::In(name, negated, list) => {
                let ty = column_type(t, &name.text);
                b.push_str(&self.q(&name.text));
                b.push_str(if *negated { " NOT IN (" } else { " IN (" });
                b.push_str(&list.iter().map(|l| self.literal(ty, &l.text)).collect::<Vec<_>>().join(", "));
                b.push(')');
            }
            Expr::IsNull(name, negated) => {
                b.push_str(&self.q(&name.text));
                b.push_str(if *negated { " IS NOT NULL" } else { " IS NULL" });
            }
        }
    }

    fn operand(&self, b: &mut String, ty: Option<Type>, o: &Operand) {
        match o {
            Operand::Column(name) => b.push_str(&self.q(&name.text)),
            Operand::Literal(literal) => b.push_str(&self.literal(ty, &literal.text)),
        }
    }

    /// Writes the triggers of the `immutable` and `audit` settings.
    pub fn triggers(&self, t: &Table) -> Vec<String> {
        let Some(settings) = &t.settings else { return Vec::new() };
        let mut out = Vec::new();
        if settings.lines.iter().any(|l| matches!(l.setting, Setting::Immutable)) {
            let message = format!("table {} is immutable", t.name.text);
            out.extend(self.reject(t, "immutable_update", "BEFORE UPDATE", &message));
            out.extend(self.reject(t, "immutable_delete", "BEFORE DELETE", &message));
        }
        for line in &settings.lines {
            if let Setting::Audit { into, operation, action, previous } = &line.setting {
                let audit = Audit { history: &into.text, action: &action.text, previous: &previous.text };
                out.extend(self.history(t, &audit, "audit_insert", "AFTER INSERT", "'insert'", "NULL"));
                let old = format!("OLD.{}", self.q(&operation.text));
                out.extend(self.history(t, &audit, "audit_update", "AFTER UPDATE", "'update'", &old));
                let message = format!("table {} deletes through its soft delete column", t.name.text);
                out.extend(self.reject(t, "audit_delete", "BEFORE DELETE", &message));
            }
        }
        out
    }

    /// Writes the trigger named `<table>$<event>` whose body is the single
    /// statement `body`; PostgreSQL wraps it in a function of the same name.
    fn trigger(&self, t: &Table, event: &str, timing: &str, body: &str, rejects: bool) -> Vec<String> {
        let name = self.q(&format!("{}${event}", t.name.text));
        let on = format!(" {timing} ON {} FOR EACH ROW ", self.q(&t.name.text));
        match self.d {
            Dialect::MySql => vec![format!("CREATE TRIGGER {name}{on}{body}")],
            Dialect::Postgres => {
                let returns = if rejects { "" } else { "RETURN NULL; " };
                vec![
                    format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN {body}; {returns}END$$"),
                    format!("CREATE TRIGGER {name}{on}EXECUTE FUNCTION {name}()"),
                ]
            }
            Dialect::Sqlite => vec![format!("CREATE TRIGGER {name}{on}BEGIN {body}; END")],
        }
    }

    fn reject(&self, t: &Table, event: &str, timing: &str, message: &str) -> Vec<String> {
        let body = match self.d {
            Dialect::MySql => format!("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '{message}'"),
            Dialect::Postgres => format!("RAISE EXCEPTION '{message}'"),
            Dialect::Sqlite => format!("SELECT RAISE(ABORT, '{message}')"),
        };
        self.trigger(t, event, timing, &body, true)
    }

    fn history(&self, t: &Table, a: &Audit, event: &str, timing: &str, action: &str, previous: &str) -> Vec<String> {
        let mut columns = vec![self.q(a.action), self.q(a.previous)];
        let mut values = vec![action.to_owned(), previous.to_owned()];
        for c in &t.columns {
            columns.push(self.q(&c.name.text));
            values.push(format!("NEW.{}", self.q(&c.name.text)));
        }
        let body = format!("INSERT INTO {} ({}) VALUES ({})", self.q(a.history), columns.join(", "), values.join(", "));
        self.trigger(t, event, timing, &body, false)
    }
}

/// The history table and columns of an `audit` setting.
struct Audit<'a> {
    history: &'a str,
    action: &'a str,
    previous: &'a str,
}

/// The type of the column `name` of table `t`.
fn column_type(t: &Table, name: &str) -> Option<Type> {
    t.column(name).map(|c| c.ty)
}

fn action_text(a: Action) -> &'static str {
    match a {
        Action::Restrict => "RESTRICT",
        Action::Cascade => "CASCADE",
        Action::SetNull => "SET NULL",
    }
}

/// A canonical decimal literal multiplied by 10^scale: the digits without the
/// point, without leading zeros.
fn scaled_decimal(text: &str) -> String {
    let (sign, unsigned) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text),
    };
    let digits = unsigned.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        "0".into()
    } else {
        format!("{sign}{digits}")
    }
}

/// The SQLite renderer CHECK of a column of type `t` whose quoted name is `q`,
/// or `None` for `text` and `bytes`.
fn sqlite_check(q: &str, t: Type) -> Option<String> {
    let integer = format!("typeof({q}) IN ('integer', 'null')");
    let digits = |n: u8| "[0-9]".repeat(usize::from(n));
    Some(match t {
        Type::I16 => format!("{integer} AND {q} BETWEEN -32768 AND 32767"),
        Type::I32 => format!("{integer} AND {q} BETWEEN -2147483648 AND 2147483647"),
        Type::I64 => integer,
        Type::Bool => format!("{q} IN (0, 1)"),
        Type::Decimal(p, _) => {
            let limit = "9".repeat(usize::from(p));
            format!("{integer} AND {q} BETWEEN -{limit} AND {limit}")
        }
        Type::F64 => format!("typeof({q}) IN ('real', 'null')"),
        Type::Varchar(n) => format!("length({q}) <= {n}"),
        Type::Uuid => {
            let hex = |n: usize| "[0-9a-f]".repeat(n);
            format!("{q} GLOB '{}-{}-{}-{}-{}'", hex(8), hex(4), hex(4), hex(4), hex(12))
        }
        Type::Date => format!("{q} IS date({q})"),
        Type::Time(0) => format!("{q} IS time({q}) AND {q} < '24:00:00'"),
        Type::Time(p) => {
            let clock = format!("substr({q}, 1, 8)");
            format!(
                "length({q}) = {} AND {clock} IS time({clock}) AND {clock} < '24:00:00' AND substr({q}, 9, 1) = '.' AND substr({q}, 10) GLOB '{}'",
                9 + u32::from(p),
                digits(p)
            )
        }
        Type::DateTime(0) => format!("length({q}) = 19 AND {q} IS datetime({q}) AND substr({q}, 12, 2) < '24'"),
        Type::DateTime(p) => {
            let stamp = format!("substr({q}, 1, 19)");
            format!(
                "length({q}) = {} AND {stamp} IS datetime({stamp}) AND substr({q}, 12, 2) < '24' AND substr({q}, 20, 1) = '.' AND substr({q}, 21) GLOB '{}'",
                20 + u32::from(p),
                digits(p)
            )
        }
        Type::Text | Type::Bytes => return None,
    })
}
