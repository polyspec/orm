//! Canonical emission: two-space indentation, one space between tokens, LF
//! line ends, sorted constraint and setting lines, comments before the line
//! they are attached to.

use super::model::*;

/// What an emission writes: the canonical text, the manifest text without
/// comments and diagrams, or the schema text that also keeps only the schema
/// settings (docs/dbspec.md, "Manifest and hashes").
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum View {
    Canonical,
    Manifest,
    Schema,
}

struct Out {
    text: String,
    view: View,
}

impl Out {
    fn line(&mut self, depth: usize, line: &str) {
        for _ in 0..depth {
            self.text.push_str("  ");
        }
        self.text.push_str(line);
        self.text.push('\n');
    }

    fn comments(&mut self, depth: usize, comments: &[String]) {
        if self.view != View::Canonical {
            return;
        }
        for comment in comments {
            self.line(depth, comment);
        }
    }

    fn blank(&mut self) {
        self.text.push('\n');
    }
}

fn names(names: &[Name]) -> String {
    names.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join(", ")
}

fn sorted<T>(items: &[T], key: impl Fn(&T) -> &str) -> Vec<&T> {
    let mut items: Vec<&T> = items.iter().collect();
    items.sort_by(|a, b| key(a).cmp(key(b)));
    items
}

pub(crate) fn emit(document: &Document, view: View) -> String {
    let mut out = Out { text: String::with_capacity(64 * (document.tables.len() + 1) * 16), view };
    out.line(0, &format!("dbspec 1 {}", document.name.text));
    let uses = sorted(&document.uses, |u| &u.document.text);
    if !uses.is_empty() {
        out.blank();
    }
    for line in uses {
        out.comments(0, &line.comments);
        out.line(0, &format!("use {} {{ {} }}", line.document.text, names(&line.tables)));
    }
    for table in &document.tables {
        out.blank();
        emit_table(&mut out, table);
    }
    if view != View::Canonical {
        return out.text;
    }
    for diagram in &document.diagrams {
        out.blank();
        out.comments(0, &diagram.comments);
        out.line(0, &format!("diagram {} {{", diagram.name.text));
        for placement in &diagram.placements {
            out.comments(1, &placement.comments);
            out.line(1, &format!("{} at {} {}", placement.table.text, placement.x, placement.y));
        }
        out.comments(1, &diagram.closing);
        out.line(0, "}");
    }
    if !document.trailing.is_empty() {
        out.blank();
        out.comments(0, &document.trailing);
    }
    out.text
}

fn emit_table(out: &mut Out, table: &Table) {
    out.comments(0, &table.comments);
    out.line(0, &format!("table {} {{", table.name.text));
    let mut line = String::new();
    for column in &table.columns {
        line.clear();
        line.push_str(&column.name.text);
        line.push(' ');
        line.push_str(&column.ty.render());
        if column.nullable {
            line.push_str(" null");
        }
        if column.identity.is_some() {
            line.push_str(" identity");
        }
        match &column.default {
            Some(DefaultValue::Now) => line.push_str(" default now"),
            Some(DefaultValue::Literal(text)) => {
                line.push_str(" default ");
                line.push_str(text);
            }
            None => {}
        }
        out.comments(1, &column.comments);
        out.line(1, &line);
    }
    for key in &table.primary {
        out.comments(1, &key.comments);
        out.line(1, &format!("primary key ({})", names(&key.columns)));
    }
    for unique in sorted(&table.uniques, |u| &u.name.text) {
        out.comments(1, &unique.comments);
        out.line(1, &format!("unique {} ({})", unique.name.text, names(&unique.columns)));
    }
    for index in sorted(&table.indexes, |i| &i.name.text) {
        let columns: Vec<String> = index.columns.iter().map(|(n, desc)| if *desc { format!("{} desc", n.text) } else { n.text.clone() }).collect();
        out.comments(1, &index.comments);
        out.line(1, &format!("index {} ({})", index.name.text, columns.join(", ")));
    }
    for key in sorted(&table.foreign_keys, |k| &k.name.text) {
        out.comments(1, &key.comments);
        out.line(
            1,
            &format!(
                "foreign key {} ({}) references {} ({}) on delete {} on update {}",
                key.name.text,
                names(&key.columns),
                key.table.text,
                names(&key.references),
                key.on_delete.as_str(),
                key.on_update.as_str()
            ),
        );
    }
    for check in sorted(&table.checks, |c| &c.name.text) {
        let mut expr = String::new();
        emit_expr(&mut expr, &check.expr);
        out.comments(1, &check.comments);
        out.line(1, &format!("check {} ({expr})", check.name.text));
    }
    let mut closing: Vec<&String> = Vec::new();
    match &table.settings {
        // An empty block has no meaning and is omitted; its comments stay before the closing `}`.
        Some(settings) if settings.lines.is_empty() => closing.extend(settings.comments.iter().chain(&settings.closing)),
        _ => {}
    }
    closing.extend(&table.closing);
    let lines = table.settings.as_ref().map(|s| (s, written(s, out.view))).filter(|(_, lines)| !lines.is_empty());
    if let Some((settings, mut lines)) = lines {
        out.comments(1, &settings.comments);
        out.line(1, "settings {");
        lines.sort_by(|a, b| (a.setting.rank(), a.setting.sort_name()).cmp(&(b.setting.rank(), b.setting.sort_name())));
        for line in lines {
            out.comments(2, &line.comments);
            out.line(2, &setting_text(&line.setting));
        }
        out.comments(2, &settings.closing);
        out.line(1, "}");
    }
    for comment in closing {
        if out.view == View::Canonical {
            out.line(1, comment);
        }
    }
    out.line(0, "}");
}

/// The setting lines that the view writes: every line, or only the schema settings.
fn written(settings: &Settings, view: View) -> Vec<&SettingLine> {
    let schema = |line: &&SettingLine| matches!(line.setting, Setting::Immutable | Setting::Audit { .. });
    settings.lines.iter().filter(|line| view != View::Schema || schema(line)).collect()
}

fn setting_text(setting: &Setting) -> String {
    match setting {
        Setting::Entity(name) => format!("entity {}", name.text),
        Setting::Updated(column) => format!("updated {}", column.text),
        Setting::SoftDelete(column) => format!("soft_delete {}", column.text),
        Setting::SelectExplicit(columns) => {
            format!("select explicit {}", columns.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join(" "))
        }
        Setting::Codec(column, stages) => format!("codec {} {}", column.text, stages.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join(" ")),
        Setting::AesVersion(column) => format!("aes_version {}", column.text),
        Setting::BlindIndex(aes, target) => format!("blind_index {} {}", aes.text, target.text),
        Setting::Navigation(key, child, parent) => format!("navigation {} {} {}", key.text, child.text, parent.text),
        Setting::Immutable => "immutable".into(),
        Setting::Audit { into, operation, action, previous } => {
            format!("audit into {} operation {} action {} previous {}", into.text, operation.text, action.text, previous.text)
        }
    }
}

pub(crate) fn emit_expr(out: &mut String, expr: &Expr) {
    match expr {
        Expr::Logic(left, op, right) => {
            emit_side(out, op, left);
            out.push(' ');
            out.push_str(op);
            out.push(' ');
            emit_side(out, op, right);
        }
        Expr::Compare(left, op, _, right) => {
            emit_operand(out, left);
            out.push(' ');
            out.push_str(op);
            out.push(' ');
            emit_operand(out, right);
        }
        Expr::In(column, negated, list) => {
            out.push_str(&column.text);
            out.push_str(if *negated { " not in (" } else { " in (" });
            for (index, literal) in list.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                out.push_str(&literal.text);
            }
            out.push(')');
        }
        Expr::IsNull(column, negated) => {
            out.push_str(&column.text);
            out.push_str(if *negated { " is not null" } else { " is null" });
        }
    }
}

/// `op` predicate의 `side`를 쓰며, `and` 안의 `or`이면 괄호로 감싼다.
fn emit_side(out: &mut String, op: &str, side: &Expr) {
    if side.needs_parentheses(op) {
        out.push('(');
        emit_expr(out, side);
        out.push(')');
    } else {
        emit_expr(out, side);
    }
}

fn emit_operand(out: &mut String, operand: &Operand) {
    match operand {
        Operand::Column(name) => out.push_str(&name.text),
        Operand::Literal(literal) => out.push_str(&literal.text),
    }
}
