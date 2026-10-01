//! Mermaid diagrams (docs/mermaid.md): [`export_mermaid`] writes a standard
//! `erDiagram` from one document and [`import_mermaid`] reads one into a
//! document, each with the list of what it leaves out.

use super::introspect::{Catalog, IColumn, IForeignKey, IKey, ITable};
use super::model::{Action, DefaultValue, Document, Table, Type};
use super::parser::well_formed;
use super::{Diagnostic, Unsupported};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

/// The rule of a Mermaid line that import cannot read.
pub const RULE_MERMAID: &str = "mermaid";

fn report(dropped: &mut Vec<Unsupported>, kind: &str, table: &str, name: &str, reason: &str) {
    dropped.push(Unsupported { kind: kind.to_owned(), table: table.to_owned(), name: name.to_owned(), reason: reason.to_owned() });
}

/// Writes `document` as a standard `erDiagram` and returns the text and what
/// the diagram cannot hold, as `[kind, table, name]` in table, kind and name
/// order (docs/mermaid.md, "Export").
pub fn export_mermaid(document: &Document) -> (String, Vec<Unsupported>) {
    let mut dropped = Vec::new();
    for u in &document.uses {
        report(&mut dropped, "use", "", &u.document.text, "export writes the tables of one document; used tables appear only as relationship ends");
    }
    for g in &document.diagrams {
        report(&mut dropped, "diagram", "", &g.name.text, "a dbspec diagram has no Mermaid form");
    }
    let mut tables: Vec<&Table> = document.tables.iter().collect();
    tables.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    let mut out = String::from("erDiagram\n");
    for t in &tables {
        let table = t.name.text.as_str();
        if !t.comments.is_empty() || !t.closing.is_empty() {
            report(&mut dropped, "comment", table, table, "Mermaid has no table comments");
        }
        out.push_str(&format!("    {table} {{\n"));
        for c in &t.columns {
            let column = c.name.text.as_str();
            if !c.comments.is_empty() {
                report(&mut dropped, "comment", table, column, "Mermaid has no column comments");
            }
            let mut line = format!("        {} {column}", mermaid_type(c.ty));
            let mut keys = Vec::new();
            if t.primary.iter().any(|p| p.columns.iter().any(|n| n.text == column)) {
                keys.push("PK");
            }
            if t.foreign_keys.iter().any(|f| f.columns.iter().any(|n| n.text == column)) {
                keys.push("FK");
            }
            if t.uniques.iter().any(|u| u.columns.iter().any(|n| n.text == column)) {
                keys.push("UK");
            }
            if !keys.is_empty() {
                line.push(' ');
                line.push_str(&keys.join(", "));
            }
            let mut suffix = Vec::new();
            if c.nullable {
                suffix.push("null".to_owned());
            }
            if c.identity.is_some() {
                suffix.push("identity".to_owned());
            }
            if let Some(default) = &c.default {
                let literal = match default {
                    DefaultValue::Now => "now",
                    DefaultValue::Literal(text) => text.as_str(),
                };
                if literal.contains('"') {
                    report(&mut dropped, "default", table, column, "a Mermaid comment cannot hold the default, which contains a double quote");
                } else {
                    suffix.push(format!("default {literal}"));
                }
            }
            if !suffix.is_empty() {
                line.push_str(&format!(" \"{}\"", suffix.join(" ")));
            }
            out.push_str(&line);
            out.push('\n');
        }
        out.push_str("    }\n");
        for u in &t.uniques {
            report(&mut dropped, "unique", table, &u.name.text, "Mermaid marks the columns of a unique key with UK but has no key");
        }
        for x in &t.indexes {
            report(&mut dropped, "index", table, &x.name.text, "Mermaid has no indexes");
        }
        for k in &t.checks {
            report(&mut dropped, "check", table, &k.name.text, "Mermaid has no checks");
        }
        for f in &t.foreign_keys {
            if f.on_delete != Action::Restrict || f.on_update != Action::Restrict {
                report(&mut dropped, "foreign_key", table, &f.name.text, "Mermaid has no foreign key actions");
            }
        }
        if t.settings.is_some() {
            report(&mut dropped, "settings", table, table, "Mermaid has no settings");
        }
    }
    for t in &tables {
        let mut keys: Vec<_> = t.foreign_keys.iter().collect();
        keys.sort_by(|a, b| a.name.text.cmp(&b.name.text));
        for f in keys {
            let nullable = f.columns.iter().any(|c| t.column(&c.text).is_some_and(|col| col.nullable));
            let marker = if nullable { "|o--o{" } else { "||--o{" };
            let columns: Vec<&str> = f.columns.iter().map(|n| n.text.as_str()).collect();
            let references: Vec<&str> = f.references.iter().map(|n| n.text.as_str()).collect();
            out.push_str(&format!(
                "    {} {marker} {} : \"{} ({}) references ({})\"\n",
                f.table.text,
                t.name.text,
                f.name.text,
                columns.join(", "),
                references.join(", ")
            ));
        }
    }
    dropped.sort_by(|a, b| (&a.table, &a.kind, &a.name).cmp(&(&b.table, &b.kind, &b.name)));
    (out, dropped)
}

/// Mermaid type에는 쉼표가 없으므로 `decimal(p,s)`를 `decimal(p-s)`로 쓴다.
fn mermaid_type(ty: Type) -> String {
    match ty {
        Type::Decimal(p, s) => format!("decimal({p}-{s})"),
        other => other.render(),
    }
}

/// Go RE2의 `\s`와 같은 ASCII 공백. Rust의 `\s`는 Unicode 공백이므로 쓰지 않는다.
const WS: &str = r"[\t\n\f\r ]";
const ENTITY_NAME: &str = r#"([A-Za-z0-9_-]+|"[^"]*")"#;

fn pattern(text: &str) -> Regex {
    Regex::new(text).expect("constant Mermaid pattern")
}

static ENTITY_START: LazyLock<Regex> = LazyLock::new(|| pattern(&format!(r"^{ENTITY_NAME}{WS}*\{{$")));
static ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        r#"^([A-Za-z][A-Za-z0-9_()\[\]-]*){WS}+([A-Za-z_*][A-Za-z0-9_-]*)((?:{WS}+(?:PK|FK|UK)(?:{WS}*,{WS}*(?:PK|FK|UK))*)?)(?:{WS}+"([^"]*)")?$"#
    ))
});
static RELATION: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(r#"^{ENTITY_NAME}{WS}+(\|o|\|\||\}}o|\}}\|)(--|\.\.)(o\||\|\||o\{{|\|\{{){WS}+{ENTITY_NAME}{WS}*:{WS}*("[^"]*"|[^\t\n\f\r "]+)$"#))
});
static LABEL: LazyLock<Regex> = LazyLock::new(|| pattern(r"^([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) references \(([a-z0-9_, ]+)\)$"));
static SUFFIX: LazyLock<Regex> = LazyLock::new(|| pattern(r"^(null)?(?: ?(identity))?(?: ?default (.+))?$"));
static KNOWN_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"^(i16|i32|i64|bool|f64|text|bytes|uuid|date)$|^varchar\(([0-9]+)\)$|^(time|datetime)\(([0-9])\)$|^decimal\(([0-9]+)-([0-9]+)\)$")
});

struct Entity {
    name: String,
    attributes: Vec<Attribute>,
}

struct Attribute {
    typ: String,
    name: String,
    comment: String,
    keys: Vec<String>,
}

impl Attribute {
    fn has(&self, key: &str) -> bool {
        self.keys.iter().any(|k| k == key)
    }
}

struct Relation {
    left: String,
    right: String,
    left_card: String,
    right_card: String,
    label: String,
}

fn failure(line: usize, message: impl Into<String>) -> Vec<Diagnostic> {
    vec![Diagnostic { rule: RULE_MERMAID.to_owned(), line, column: 1, message: message.into() }]
}

/// 정규식 capture group의 text. 참여하지 않은 group은 빈 문자열이다.
fn group<'t>(captures: &regex::Captures<'t>, i: usize) -> &'t str {
    captures.get(i).map_or("", |m| m.as_str())
}

/// The entities of `text` by name, in first appearance order.
#[derive(Default)]
struct Entities {
    list: Vec<Entity>,
    index: BTreeMap<String, usize>,
}

impl Entities {
    /// 이름의 entity 위치. 처음 나오면 만든다. 따옴표는 이름에 들지 않는다.
    fn entity(&mut self, name: &str) -> usize {
        let name = name.trim_matches('"');
        if let Some(&i) = self.index.get(name) {
            return i;
        }
        self.list.push(Entity { name: name.to_owned(), attributes: Vec::new() });
        self.index.insert(name.to_owned(), self.list.len() - 1);
        self.list.len() - 1
    }
}

/// Reads a standard `erDiagram` into the dbspec document `name` and returns
/// it with what it does not carry over (docs/mermaid.md, "Import"). A line
/// that does not follow the grammar is a `mermaid` diagnostic.
pub fn import_mermaid(text: &str, name: &str) -> Result<(Document, Vec<Unsupported>), Vec<Diagnostic>> {
    let body = text.strip_suffix('\n').unwrap_or(text);
    let lines: Vec<&str> = body.split('\n').collect();
    let mut entities = Entities::default();
    let mut relations = Vec::new();
    let mut open: Option<usize> = None;
    let mut header = false;
    for (i, raw) in lines.iter().enumerate() {
        let n = i + 1;
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        if !header {
            if line != "erDiagram" {
                return Err(failure(n, "a Mermaid entity relationship diagram starts with erDiagram"));
            }
            header = true;
        } else if let Some(e) = open {
            if line == "}" {
                open = None;
                continue;
            }
            let Some(m) = ATTRIBUTE.captures(line) else {
                return Err(failure(n, "an attribute is <type> <name> [PK|FK|UK, ...] [\"comment\"]"));
            };
            let keys = group(&m, 3).split(',').map(str::trim).filter(|k| !k.is_empty()).map(str::to_owned).collect();
            entities.list[e].attributes.push(Attribute { typ: m[1].to_owned(), name: m[2].to_owned(), comment: group(&m, 4).to_owned(), keys });
        } else if let Some(m) = ENTITY_START.captures(line) {
            open = Some(entities.entity(&m[1]));
        } else if let Some(m) = RELATION.captures(line) {
            let left = entities.entity(&m[1]);
            let right = entities.entity(&m[5]);
            relations.push(Relation {
                left: entities.list[left].name.clone(),
                right: entities.list[right].name.clone(),
                left_card: m[2].to_owned(),
                right_card: m[4].to_owned(),
                label: m[6].trim_matches('"').to_owned(),
            });
        } else {
            return Err(failure(n, "a line is an entity block, an attribute, a relationship, a %% comment or blank"));
        }
    }
    if !header {
        return Err(failure(1, "a Mermaid entity relationship diagram starts with erDiagram"));
    }
    if let Some(e) = open {
        return Err(failure(lines.len(), format!("entity {} has no closing brace", entities.list[e].name)));
    }
    let mut c = Catalog::default();
    for e in &entities.list {
        if !well_formed(&e.name) {
            c.report("table", &e.name, &e.name, "the entity name is not a dbspec name");
            continue;
        }
        let mut t = ITable::new(&e.name);
        for a in &e.attributes {
            if !well_formed(&a.name) {
                c.report("column", &e.name, &a.name, "the attribute name is not a dbspec name");
                continue;
            }
            let Some(typ) = import_type(&a.typ) else {
                c.report("column", &e.name, &a.name, format!("type {} is not a dbspec type", a.typ));
                continue;
            };
            let mut col = IColumn { name: a.name.clone(), typ, null: false, identity: false, dflt: String::new() };
            if !a.comment.is_empty() {
                match SUFFIX.captures(&a.comment) {
                    Some(m) => {
                        col.null = !group(&m, 1).is_empty();
                        col.identity = !group(&m, 2).is_empty();
                        col.dflt = group(&m, 3).to_owned();
                    }
                    None => c.report("comment", &e.name, &a.name, format!("the comment {:?} is not a dbspec column suffix", a.comment)),
                }
            }
            t.columns.push(col);
            if a.has("PK") {
                t.primary.push(a.name.clone());
            }
            if a.has("UK") {
                c.report("unique", &e.name, &a.name, "Mermaid does not say which UK attributes form one key");
            }
        }
        c.tables.push(t);
    }
    let is_fk = |entity: &str, column: &str| -> bool {
        let e = &entities.list[entities.index[entity]];
        e.attributes.iter().find(|a| a.name == column).is_some_and(|a| a.has("FK"))
    };
    let mut used_fk: BTreeSet<(String, String)> = BTreeSet::new();
    for r in &relations {
        let many_right = r.right_card.ends_with('{');
        let many_left = r.left_card.starts_with('}');
        if many_left == many_right {
            c.report("relationship", &r.left, &r.label, format!("the relationship to {} is not one to many", r.right));
            continue;
        }
        let (parent, child, parent_card, child_card) =
            if many_left { (&r.right, &r.left, &r.right_card, &r.left_card) } else { (&r.left, &r.right, &r.left_card, &r.right_card) };
        let m = LABEL.captures(&r.label);
        let (Some(m), true, true) = (m, c.has_table(parent), c.has_table(child)) else {
            c.report("relationship", child, &r.label, "the label does not give the foreign key columns, or an end is not a table");
            continue;
        };
        let fk_name = m[1].to_owned();
        let (cols, refs) = (split_names(&m[2]), split_names(&m[3]));
        let parent_columns: BTreeSet<String> = c.table(parent).map(|t| t.columns.iter().map(|x| x.name.clone()).collect()).unwrap_or_default();
        let child_table = c.table(child).expect("the child is a table");
        let mut ok = cols.len() == refs.len();
        let mut nullable = false;
        if ok {
            for (col, reference) in cols.iter().zip(&refs) {
                let Some(cc) = child_table.columns.iter().find(|x| &x.name == col) else {
                    ok = false;
                    break;
                };
                if !is_fk(child, col) || !parent_columns.contains(reference) {
                    ok = false;
                    break;
                }
                nullable = nullable || cc.null;
            }
        }
        if !ok {
            c.report(
                "relationship",
                child,
                &fk_name,
                format!("its columns are not FK attributes of {child} or its referenced columns are not attributes of {parent}"),
            );
            continue;
        }
        let mut want_parent = if nullable { "|o" } else { "||" };
        if many_left {
            want_parent = if nullable { "o|" } else { "||" };
        }
        let cardinality_differs = parent_card != want_parent || (child_card != "o{" && child_card != "}o");
        let primary_begins = child_table.primary.len() >= cols.len() && child_table.primary[..cols.len()] == cols[..];
        let index = (!primary_begins).then(|| format!("ix_{child}_{}", cols.join("_")));
        child_table.fks.push(IForeignKey {
            name: fk_name.clone(),
            columns: cols.clone(),
            table: parent.clone(),
            refs,
            on_delete: Action::Restrict.as_str(),
            on_update: Action::Restrict.as_str(),
        });
        if let Some(ix) = &index {
            child_table.indexes.push(IKey { name: ix.clone(), columns: cols.clone(), desc: vec![false; cols.len()] });
        }
        if cardinality_differs {
            c.report("cardinality", child, &fk_name, "the cardinalities differ from the ones the foreign key's nullability gives");
        }
        for col in &cols {
            used_fk.insert((child.clone(), col.clone()));
        }
        if let Some(ix) = &index {
            c.report("index", child, ix, "Mermaid has no indexes; the foreign key needs one");
        }
    }
    for e in &entities.list {
        for a in &e.attributes {
            if a.has("FK") && !used_fk.contains(&(e.name.clone(), a.name.clone())) && c.has_table(&e.name) {
                c.report("foreign_key", &e.name, &a.name, "no relationship gives the foreign key of this FK attribute");
            }
        }
    }
    let introspection = c.document(name).map_err(|message| failure(1, message))?;
    Ok((introspection.document, introspection.unsupported))
}

fn split_names(s: &str) -> Vec<String> {
    s.split(',').map(|p| p.trim().to_owned()).collect()
}

/// Mermaid type이 dbspec type이면 그 Type. `decimal(p-s)`는 `decimal(p,s)`다.
/// 수가 Type의 범위를 넘으면 dbspec type이 아니다.
fn import_type(s: &str) -> Option<Type> {
    let m = KNOWN_TYPE.captures(s)?;
    if let Some(kind) = m.get(1) {
        return Some(match kind.as_str() {
            "i16" => Type::I16,
            "i32" => Type::I32,
            "i64" => Type::I64,
            "bool" => Type::Bool,
            "f64" => Type::F64,
            "text" => Type::Text,
            "bytes" => Type::Bytes,
            "uuid" => Type::Uuid,
            _ => Type::Date,
        });
    }
    if let Some(length) = m.get(2) {
        return length.as_str().parse().ok().map(Type::Varchar);
    }
    if let Some(kind) = m.get(3) {
        let precision = m[4].parse().ok()?;
        return Some(if kind.as_str() == "time" { Type::Time(precision) } else { Type::DateTime(precision) });
    }
    Some(Type::Decimal(m[5].parse().ok()?, m[6].parse().ok()?))
}
