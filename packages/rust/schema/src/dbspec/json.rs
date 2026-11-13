//! The JSON forms of the dbspec values (docs/spec/flowmark-surface.md FMS-10 to FMS-16, FMS-80): a column type, a
//! document, the entities of a runtime model, a diagnostic and a declaration position, as the schemas of
//! `contracts/interface/flowmark/dbspec.schema.json` state them. A form holds no position of a token, so a value
//! that is read from its form has the default position in every name. A value that is not of its form is refused
//! with a text that names the member.

use serde_json::{json, Map, Value};

use super::literal::literal_value;
use super::model::{
    Action, AuditList, AuditTables, Check, Column, DefaultValue, Diagram, Document, Expr, ForeignKey, Index, Literal, Name, Operand, Placement, Pos,
    PrimaryKey, Setting, SettingLine, Settings, StoreShard, Table, Type, Unique, Use,
};
use super::runtime::{Audit, Entity, Field, FieldDefault, ForeignKey as EntityForeignKey, Key, RuntimeModel};
use super::{Diagnostic, Position};

/// The form of a column type (FMS-11): its kind and exactly the parameters of that kind.
pub fn type_to_json(ty: Type) -> Value {
    match ty {
        Type::Decimal(precision, scale) => json!({"kind": "decimal", "precision": precision, "scale": scale}),
        Type::Varchar(length) => json!({"kind": "varchar", "length": length}),
        Type::Time(precision) | Type::DateTime(precision) => json!({"kind": ty.name(), "precision": precision}),
        Type::I16 | Type::I32 | Type::I64 | Type::Bool | Type::F64 | Type::Text | Type::Bytes | Type::Uuid | Type::Date => json!({"kind": ty.name()}),
    }
}

/// The column type of its form (FMS-11); a kind that the form does not have, a parameter of another kind and an
/// absent parameter are refused.
pub fn type_from_json(value: &Value) -> Result<Type, String> {
    read_type(value, "type")
}

fn read_type(value: &Value, at: &str) -> Result<Type, String> {
    let kind = match value.get("kind") {
        Some(Value::String(kind)) => kind.as_str(),
        Some(_) => return Err(format!("{at}.kind is no text")),
        None if value.is_object() => return Err(format!("{at}.kind is absent")),
        None => return Err(format!("{at} is no object")),
    };
    let parameters: &[&str] = match kind {
        "decimal" => &["kind", "precision", "scale"],
        "varchar" => &["kind", "length"],
        "time" | "datetime" => &["kind", "precision"],
        "i16" | "i32" | "i64" | "bool" | "f64" | "text" | "bytes" | "uuid" | "date" => &["kind"],
        other => return Err(format!("{at}.kind {other} is no kind of a column type")),
    };
    let members = object(value, at, parameters)?;
    Ok(match kind {
        "i16" => Type::I16,
        "i32" => Type::I32,
        "i64" => Type::I64,
        "bool" => Type::Bool,
        "f64" => Type::F64,
        "text" => Type::Text,
        "bytes" => Type::Bytes,
        "uuid" => Type::Uuid,
        "date" => Type::Date,
        "decimal" => Type::Decimal(small(members, at, "precision")?, small(members, at, "scale")?),
        "varchar" => {
            let length = integer(members, at, "length")?;
            Type::Varchar(u16::try_from(length).map_err(|_too_large| format!("{at}.length {length} is above 65535"))?)
        }
        "time" => Type::Time(small(members, at, "precision")?),
        _ => Type::DateTime(small(members, at, "precision")?),
    })
}

/// The members of the object `value`; a value that is no object and a member outside `allowed` are refused.
fn object<'v>(value: &'v Value, at: &str, allowed: &[&str]) -> Result<&'v Map<String, Value>, String> {
    let Value::Object(members) = value else { return Err(format!("{at} is no object")) };
    match members.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(format!("{at}.{key} is no member of the form")),
        None => Ok(members),
    }
}

fn required<'v>(members: &'v Map<String, Value>, at: &str, key: &str) -> Result<&'v Value, String> {
    members.get(key).ok_or_else(|| format!("{at}.{key} is absent"))
}

fn text(members: &Map<String, Value>, at: &str, key: &str) -> Result<String, String> {
    match required(members, at, key)? {
        Value::String(text) => Ok(text.clone()),
        _ => Err(format!("{at}.{key} is no text")),
    }
}

fn flag(members: &Map<String, Value>, at: &str, key: &str) -> Result<bool, String> {
    match required(members, at, key)? {
        Value::Bool(flag) => Ok(*flag),
        _ => Err(format!("{at}.{key} is no boolean")),
    }
}

fn integer(members: &Map<String, Value>, at: &str, key: &str) -> Result<u64, String> {
    required(members, at, key)?.as_u64().ok_or_else(|| format!("{at}.{key} is no integer from 0"))
}

/// An integer member from 0 to 255.
fn small(members: &Map<String, Value>, at: &str, key: &str) -> Result<u8, String> {
    let number = integer(members, at, key)?;
    u8::try_from(number).map_err(|_too_large| format!("{at}.{key} {number} is above 255"))
}

fn items<'v>(members: &'v Map<String, Value>, at: &str, key: &str) -> Result<&'v Vec<Value>, String> {
    match required(members, at, key)? {
        Value::Array(items) => Ok(items),
        _ => Err(format!("{at}.{key} is no list")),
    }
}

/// The items of the list member `key`, each read by `read` with its place `<at>.<key>[<index>]`.
fn each<T>(members: &Map<String, Value>, at: &str, key: &str, read: impl Fn(&Value, &str) -> Result<T, String>) -> Result<Vec<T>, String> {
    items(members, at, key)?.iter().enumerate().map(|(index, item)| read(item, &format!("{at}.{key}[{index}]"))).collect()
}

/// The items of the optional list member `key`, which holds at least one item when it is present.
fn each_present<T>(members: &Map<String, Value>, at: &str, key: &str, read: impl Fn(&Value, &str) -> Result<T, String>) -> Result<Vec<T>, String> {
    if !members.contains_key(key) {
        return Ok(Vec::new());
    }
    let read = each(members, at, key, read)?;
    if read.is_empty() {
        return Err(format!("{at}.{key} is an empty list; an absent member is the empty list"));
    }
    Ok(read)
}

fn name_of(value: &Value, at: &str) -> Result<Name, String> {
    match value {
        Value::String(text) if !text.is_empty() => Ok(Name { text: text.clone(), pos: Pos::default() }),
        Value::String(_) => Err(format!("{at} is an empty name")),
        _ => Err(format!("{at} is no text")),
    }
}

fn name(members: &Map<String, Value>, at: &str, key: &str) -> Result<Name, String> {
    name_of(required(members, at, key)?, &format!("{at}.{key}"))
}

fn optional_name(members: &Map<String, Value>, at: &str, key: &str) -> Result<Option<Name>, String> {
    members.get(key).map(|value| name_of(value, &format!("{at}.{key}"))).transpose()
}

fn names(members: &Map<String, Value>, at: &str, key: &str) -> Result<Vec<Name>, String> {
    each(members, at, key, name_of)
}

fn line_of(value: &Value, at: &str) -> Result<String, String> {
    value.as_str().map(str::to_owned).ok_or_else(|| format!("{at} is no text"))
}

/// The comment lines of the optional member `key`.
fn lines(members: &Map<String, Value>, at: &str, key: &str) -> Result<Vec<String>, String> {
    each_present(members, at, key, line_of)
}

/// One of the texts `allowed` of the member `key`.
fn one_of(members: &Map<String, Value>, at: &str, key: &str, allowed: &[&'static str]) -> Result<&'static str, String> {
    let written = text(members, at, key)?;
    allowed.iter().find(|word| **word == written).copied().ok_or_else(|| format!("{at}.{key} {written} is none of {}", allowed.join(", ")))
}

fn texts(names: &[Name]) -> Value {
    Value::Array(names.iter().map(|name| Value::from(name.text.as_str())).collect())
}

/// Writes the comment lines as the member `key`; no line is no member.
fn put_lines(out: &mut Map<String, Value>, key: &str, lines: &[String]) {
    if !lines.is_empty() {
        out.insert(key.to_owned(), json!(lines));
    }
}

/// An object with the optional member `comments` first.
fn commented(comments: &[String]) -> Map<String, Value> {
    let mut out = Map::new();
    put_lines(&mut out, "comments", comments);
    out
}

/// The form of a document (FMS-10). A document that the form cannot hold is refused: a table with more than one
/// primary key, a setting of one line that a block holds twice, an audit setting with two lists and a check literal
/// without its canonical text, which validation sets. No document that `parse` returns is refused.
pub fn document_to_json(document: &Document) -> Result<Value, String> {
    let mut out = Map::new();
    out.insert("name".into(), Value::from(document.name.text.as_str()));
    out.insert("external".into(), Value::from(document.external));
    out.insert(
        "uses".into(),
        Value::Array(
            document
                .uses
                .iter()
                .map(|line| {
                    let mut out = commented(&line.comments);
                    out.insert("document".into(), Value::from(line.document.text.as_str()));
                    out.insert("tables".into(), texts(&line.tables));
                    Value::Object(out)
                })
                .collect(),
        ),
    );
    out.insert("tables".into(), Value::Array(document.tables.iter().map(table_to_json).collect::<Result<_, _>>()?));
    if !document.diagrams.is_empty() {
        out.insert("diagrams".into(), Value::Array(document.diagrams.iter().map(diagram_to_json).collect()));
    }
    put_lines(&mut out, "trailing", &document.trailing);
    Ok(Value::Object(out))
}

fn table_to_json(table: &Table) -> Result<Value, String> {
    let at = &table.name.text;
    let mut out = commented(&table.comments);
    out.insert("name".into(), Value::from(at.as_str()));
    out.insert("columns".into(), Value::Array(table.columns.iter().map(column_to_json).collect()));
    match table.primary.as_slice() {
        [] => {}
        [key] => {
            let mut primary = commented(&key.comments);
            primary.insert("columns".into(), texts(&key.columns));
            out.insert("primary_key".into(), Value::Object(primary));
        }
        _ => return Err(format!("table {at} holds more than one primary key; the form holds one")),
    }
    out.insert(
        "uniques".into(),
        Value::Array(
            table
                .uniques
                .iter()
                .map(|unique| {
                    let mut out = commented(&unique.comments);
                    out.insert("name".into(), Value::from(unique.name.text.as_str()));
                    out.insert("columns".into(), texts(&unique.columns));
                    Value::Object(out)
                })
                .collect(),
        ),
    );
    out.insert(
        "indexes".into(),
        Value::Array(
            table
                .indexes
                .iter()
                .map(|index| {
                    let mut out = commented(&index.comments);
                    out.insert("name".into(), Value::from(index.name.text.as_str()));
                    out.insert("columns".into(), Value::Array(index.columns.iter().map(|(name, desc)| json!({"name": name.text, "desc": desc})).collect()));
                    Value::Object(out)
                })
                .collect(),
        ),
    );
    out.insert(
        "foreign_keys".into(),
        Value::Array(
            table
                .foreign_keys
                .iter()
                .map(|key| {
                    let mut out = commented(&key.comments);
                    out.insert("name".into(), Value::from(key.name.text.as_str()));
                    out.insert("columns".into(), texts(&key.columns));
                    out.insert("table".into(), Value::from(key.table.text.as_str()));
                    out.insert("references".into(), texts(&key.references));
                    out.insert("on_delete".into(), Value::from(key.on_delete.as_str()));
                    out.insert("on_update".into(), Value::from(key.on_update.as_str()));
                    Value::Object(out)
                })
                .collect(),
        ),
    );
    let checks = table.checks.iter().map(|check| -> Result<Value, String> {
        let mut out = commented(&check.comments);
        out.insert("name".into(), Value::from(check.name.text.as_str()));
        out.insert("expr".into(), expr_to_json(&check.expr, at, &check.name.text)?);
        Ok(Value::Object(out))
    });
    out.insert("checks".into(), Value::Array(checks.collect::<Result<_, String>>()?));
    if let Some(settings) = &table.settings {
        out.insert("settings".into(), settings_to_json(settings, at)?);
    }
    put_lines(&mut out, "closing", &table.closing);
    Ok(Value::Object(out))
}

fn column_to_json(column: &Column) -> Value {
    let mut out = commented(&column.comments);
    out.insert("name".into(), Value::from(column.name.text.as_str()));
    out.insert("type".into(), type_to_json(column.ty));
    out.insert("nullable".into(), Value::from(column.nullable));
    out.insert("identity".into(), Value::from(column.identity.is_some()));
    match &column.default {
        Some(DefaultValue::Now) => out.insert("default".into(), json!({"kind": "now"})),
        Some(DefaultValue::Literal(text)) => out.insert("default".into(), json!({"kind": "literal", "text": text})),
        None => None,
    };
    Value::Object(out)
}

/// The canonical text of a check literal, which validation sets.
fn literal_text(literal: &Literal, table: &str, check: &str) -> Result<Value, String> {
    if literal.text.is_empty() {
        return Err(format!(
            "check {check} of table {table} holds the literal {} without its canonical text; the document is not validated",
            literal.value.describe()
        ));
    }
    Ok(Value::from(literal.text.as_str()))
}

fn expr_to_json(expr: &Expr, table: &str, check: &str) -> Result<Value, String> {
    Ok(match expr {
        Expr::Logic(left, op, right) => {
            json!({"kind": "logic", "op": op, "left": expr_to_json(left, table, check)?, "right": expr_to_json(right, table, check)?})
        }
        Expr::Compare(left, op, _, right) => {
            let operand = |operand: &Operand| -> Result<Value, String> {
                Ok(match operand {
                    Operand::Column(name) => json!({"kind": "column", "name": name.text}),
                    Operand::Literal(literal) => json!({"kind": "literal", "text": literal_text(literal, table, check)?}),
                })
            };
            json!({"kind": "compare", "op": op, "left": operand(left)?, "right": operand(right)?})
        }
        Expr::In(column, negated, list) => {
            let list = list.iter().map(|literal| literal_text(literal, table, check)).collect::<Result<Vec<Value>, String>>()?;
            json!({"kind": "in", "column": column.text, "negated": negated, "list": list})
        }
        Expr::IsNull(column, negated) => json!({"kind": "is_null", "column": column.text, "negated": negated}),
    })
}

/// The member of the settings form that holds the lines of the keyword `keyword`, and whether it is a list.
fn setting_member(setting: &Setting) -> (&'static str, bool) {
    match setting {
        Setting::Entity(_) => ("entity", false),
        Setting::Updated(_) => ("updated", false),
        Setting::SoftDelete(_) => ("soft_delete", false),
        Setting::SelectExplicit(_) => ("select_explicit", false),
        Setting::Codec(..) => ("codec", true),
        Setting::AesVersion(_) => ("aes_version", false),
        Setting::BlindIndex(..) => ("blind_index", true),
        Setting::Navigation(..) => ("navigation", true),
        Setting::Markdown(_) => ("markdown", true),
        Setting::Store { .. } => ("store", false),
        Setting::Title(_) => ("title", false),
        Setting::Body(_) => ("body", false),
        Setting::Order(_) => ("order", false),
        Setting::TaskMarker(_) => ("task_marker", false),
        Setting::Immutable => ("immutable", false),
        Setting::Audit { .. } => ("audit", false),
    }
}

fn settings_to_json(settings: &Settings, table: &str) -> Result<Value, String> {
    let mut out = commented(&settings.comments);
    put_lines(&mut out, "closing", &settings.closing);
    for line in &settings.lines {
        let (member, list) = setting_member(&line.setting);
        let value = Value::Object(setting_to_json(line, table)?);
        if list {
            match out.entry(member).or_insert_with(|| Value::Array(Vec::new())) {
                Value::Array(lines) => lines.push(value),
                _ => return Err(format!("the settings of table {table} hold the member {member} in two forms")),
            }
        } else if out.insert(member.to_owned(), value).is_some() {
            return Err(format!("the settings of table {table} hold the setting {member} more than once; the form holds one"));
        }
    }
    Ok(Value::Object(out))
}

/// Writes the name `name` as the member `key`.
fn put(out: &mut Map<String, Value>, key: &str, name: &Name) {
    out.insert(key.to_owned(), Value::from(name.text.as_str()));
}

fn setting_to_json(line: &SettingLine, table: &str) -> Result<Map<String, Value>, String> {
    let mut out = commented(&line.comments);
    match &line.setting {
        Setting::Entity(name) => put(&mut out, "name", name),
        Setting::Updated(column)
        | Setting::SoftDelete(column)
        | Setting::AesVersion(column)
        | Setting::Markdown(column)
        | Setting::Title(column)
        | Setting::Body(column)
        | Setting::Order(column)
        | Setting::TaskMarker(column) => put(&mut out, "column", column),
        Setting::SelectExplicit(columns) => {
            out.insert("columns".into(), texts(columns));
        }
        Setting::Codec(column, stages) => {
            put(&mut out, "column", column);
            out.insert("stages".into(), texts(stages));
        }
        Setting::BlindIndex(column, index) => {
            put(&mut out, "column", column);
            put(&mut out, "index", index);
        }
        Setting::Navigation(key, child, parent) => {
            put(&mut out, "foreign_key", key);
            put(&mut out, "child", child);
            put(&mut out, "parent", parent);
        }
        Setting::Store { kind, foreign, shape, shard } => {
            put(&mut out, "kind", kind);
            if let Some(foreign) = foreign {
                put(&mut out, "foreign", foreign);
            }
            if let Some(shape) = shape {
                put(&mut out, "shape", shape);
            }
            if let Some(shard) = shard {
                out.insert("shard".into(), json!({"column": shard.column.text, "period": shard.period.text}));
            }
        }
        Setting::Immutable => {}
        Setting::Audit { into, column, references, action, previous, tables, lists } => {
            put(&mut out, "into", into);
            put(&mut out, "column", column);
            put(&mut out, "references", references);
            put(&mut out, "action", action);
            put(&mut out, "previous", previous);
            if let Some(tables) = tables {
                out.insert("tables".into(), json!({"table": tables.table.text, "record": tables.record.text, "name": tables.name.text}));
            }
            match lists.as_slice() {
                [] => {}
                [list] if matches!(list.keyword.text.as_str(), "exclude" | "include") => {
                    out.insert(list.keyword.text.clone(), texts(&list.columns));
                }
                [list] => return Err(format!("the audit setting of table {table} holds the list {}, which is neither exclude nor include", list.keyword.text)),
                _ => return Err(format!("the audit setting of table {table} holds more than one list; the form holds one")),
            }
        }
    }
    Ok(out)
}

fn diagram_to_json(diagram: &Diagram) -> Value {
    let mut out = commented(&diagram.comments);
    out.insert("name".into(), Value::from(diagram.name.text.as_str()));
    out.insert(
        "placements".into(),
        Value::Array(
            diagram
                .placements
                .iter()
                .map(|placement| {
                    let mut out = commented(&placement.comments);
                    out.insert("table".into(), Value::from(placement.table.text.as_str()));
                    out.insert("x".into(), Value::from(placement.x));
                    out.insert("y".into(), Value::from(placement.y));
                    Value::Object(out)
                })
                .collect(),
        ),
    );
    put_lines(&mut out, "closing", &diagram.closing);
    Value::Object(out)
}

/// The document of its form (FMS-10, FMS-14). Every name has the default position, and the value of a check literal
/// is read from its canonical text. A value that is not of the form is refused with a text that names the member.
pub fn document_from_json(value: &Value) -> Result<Document, String> {
    let at = "document";
    let members = object(value, at, &["name", "external", "uses", "tables", "diagrams", "trailing"])?;
    Ok(Document {
        name: name(members, at, "name")?,
        external: flag(members, at, "external")?,
        uses: each(members, at, "uses", |value, at| {
            let members = object(value, at, &["comments", "document", "tables"])?;
            Ok(Use { comments: lines(members, at, "comments")?, document: name(members, at, "document")?, tables: names(members, at, "tables")? })
        })?,
        tables: each(members, at, "tables", table_from_json)?,
        diagrams: each_present(members, at, "diagrams", diagram_from_json)?,
        trailing: lines(members, at, "trailing")?,
    })
}

fn table_from_json(value: &Value, at: &str) -> Result<Table, String> {
    let members = object(value, at, &["comments", "name", "columns", "primary_key", "uniques", "indexes", "foreign_keys", "checks", "settings", "closing"])?;
    let primary = match members.get("primary_key") {
        Some(value) => {
            let at = &format!("{at}.primary_key");
            let members = object(value, at, &["comments", "columns"])?;
            vec![PrimaryKey { comments: lines(members, at, "comments")?, pos: Pos::default(), columns: names(members, at, "columns")? }]
        }
        None => Vec::new(),
    };
    Ok(Table {
        comments: lines(members, at, "comments")?,
        name: name(members, at, "name")?,
        columns: each(members, at, "columns", column_from_json)?,
        primary,
        uniques: each(members, at, "uniques", |value, at| {
            let members = object(value, at, &["comments", "name", "columns"])?;
            Ok(Unique { comments: lines(members, at, "comments")?, name: name(members, at, "name")?, columns: names(members, at, "columns")? })
        })?,
        indexes: each(members, at, "indexes", |value, at| {
            let members = object(value, at, &["comments", "name", "columns"])?;
            let columns = each(members, at, "columns", |value, at| {
                let members = object(value, at, &["name", "desc"])?;
                Ok((name(members, at, "name")?, flag(members, at, "desc")?))
            })?;
            Ok(Index { comments: lines(members, at, "comments")?, name: name(members, at, "name")?, columns })
        })?,
        foreign_keys: each(members, at, "foreign_keys", |value, at| {
            let members = object(value, at, &["comments", "name", "columns", "table", "references", "on_delete", "on_update"])?;
            Ok(ForeignKey {
                comments: lines(members, at, "comments")?,
                name: name(members, at, "name")?,
                columns: names(members, at, "columns")?,
                table: name(members, at, "table")?,
                references: names(members, at, "references")?,
                on_delete: action(members, at, "on_delete")?,
                on_update: action(members, at, "on_update")?,
            })
        })?,
        checks: each(members, at, "checks", |value, at| {
            let members = object(value, at, &["comments", "name", "expr"])?;
            Ok(Check {
                comments: lines(members, at, "comments")?,
                name: name(members, at, "name")?,
                expr: expr_from_json(required(members, at, "expr")?, &format!("{at}.expr"))?,
            })
        })?,
        settings: members.get("settings").map(|value| settings_from_json(value, &format!("{at}.settings"))).transpose()?,
        closing: lines(members, at, "closing")?,
    })
}

fn action(members: &Map<String, Value>, at: &str, key: &str) -> Result<Action, String> {
    Ok(match one_of(members, at, key, &["restrict", "cascade", "set_null"])? {
        "restrict" => Action::Restrict,
        "cascade" => Action::Cascade,
        _ => Action::SetNull,
    })
}

fn column_from_json(value: &Value, at: &str) -> Result<Column, String> {
    let members = object(value, at, &["comments", "name", "type", "nullable", "identity", "default"])?;
    let default = match members.get("default") {
        Some(value) => Some(default_from_json(value, &format!("{at}.default"))?),
        None => None,
    };
    Ok(Column {
        comments: lines(members, at, "comments")?,
        name: name(members, at, "name")?,
        ty: read_type(required(members, at, "type")?, &format!("{at}.type"))?,
        nullable: flag(members, at, "nullable")?,
        identity: flag(members, at, "identity")?.then(Pos::default),
        default: default.map(|(now, text)| if now { DefaultValue::Now } else { DefaultValue::Literal(text) }),
    })
}

/// The default of its form: whether it is `now`, and the canonical text of a literal.
fn default_from_json(value: &Value, at: &str) -> Result<(bool, String), String> {
    let kind = kind_of(value, at, &["now", "literal"])?;
    if kind == "now" {
        object(value, at, &["kind"])?;
        return Ok((true, String::new()));
    }
    let members = object(value, at, &["kind", "text"])?;
    Ok((false, text(members, at, "text")?))
}

/// The member `kind` of the object `value`, one of `allowed`.
fn kind_of(value: &Value, at: &str, allowed: &[&'static str]) -> Result<&'static str, String> {
    let Value::Object(members) = value else { return Err(format!("{at} is no object")) };
    one_of(members, at, "kind", allowed)
}

fn literal_from_json(members: &Map<String, Value>, at: &str, key: &str) -> Result<Literal, String> {
    literal_of(required(members, at, key)?, &format!("{at}.{key}"))
}

/// The check literal of its canonical text.
fn literal_of(value: &Value, at: &str) -> Result<Literal, String> {
    let Value::String(text) = value else { return Err(format!("{at} is no text")) };
    match literal_value(text) {
        Some(value) => Ok(Literal { value, pos: Pos::default(), text: text.clone() }),
        None => Err(format!("{at} {text} is no literal")),
    }
}

fn expr_from_json(value: &Value, at: &str) -> Result<Expr, String> {
    Ok(match kind_of(value, at, &["logic", "compare", "in", "is_null"])? {
        "logic" => {
            let members = object(value, at, &["kind", "op", "left", "right"])?;
            let op = one_of(members, at, "op", &["and", "or"])?;
            let side = |key: &str| expr_from_json(required(members, at, key)?, &format!("{at}.{key}")).map(Box::new);
            Expr::Logic(side("left")?, op, side("right")?)
        }
        "compare" => {
            let members = object(value, at, &["kind", "op", "left", "right"])?;
            let op = one_of(members, at, "op", &["=", "<>", "<", "<=", ">", ">="])?;
            let side = |key: &str| -> Result<Operand, String> {
                let value = required(members, at, key)?;
                let at = &format!("{at}.{key}");
                Ok(match kind_of(value, at, &["column", "literal"])? {
                    "column" => Operand::Column(name(object(value, at, &["kind", "name"])?, at, "name")?),
                    _ => Operand::Literal(literal_from_json(object(value, at, &["kind", "text"])?, at, "text")?),
                })
            };
            Expr::Compare(side("left")?, op, Pos::default(), side("right")?)
        }
        "in" => {
            let members = object(value, at, &["kind", "column", "negated", "list"])?;
            let list = each(members, at, "list", literal_of)?;
            if list.is_empty() {
                return Err(format!("{at}.list is an empty list"));
            }
            Expr::In(name(members, at, "column")?, flag(members, at, "negated")?, list)
        }
        _ => {
            let members = object(value, at, &["kind", "column", "negated"])?;
            Expr::IsNull(name(members, at, "column")?, flag(members, at, "negated")?)
        }
    })
}

fn settings_from_json(value: &Value, at: &str) -> Result<Settings, String> {
    let members = object(
        value,
        at,
        &[
            "comments",
            "closing",
            "entity",
            "updated",
            "soft_delete",
            "select_explicit",
            "codec",
            "aes_version",
            "blind_index",
            "navigation",
            "markdown",
            "store",
            "title",
            "body",
            "order",
            "task_marker",
            "immutable",
            "audit",
        ],
    )?;
    let mut out = Vec::new();
    // The members that hold one line.
    let one: [(&str, &[&str], ReadSetting<'_>); 12] = [
        ("entity", &["comments", "name"], &entity_setting),
        ("updated", &["comments", "column"], &column_setting(Setting::Updated)),
        ("soft_delete", &["comments", "column"], &column_setting(Setting::SoftDelete)),
        ("select_explicit", &["comments", "columns"], &select_explicit_setting),
        ("aes_version", &["comments", "column"], &column_setting(Setting::AesVersion)),
        ("store", &["comments", "kind", "foreign", "shape", "shard"], &store_from_json),
        ("title", &["comments", "column"], &column_setting(Setting::Title)),
        ("body", &["comments", "column"], &column_setting(Setting::Body)),
        ("order", &["comments", "column"], &column_setting(Setting::Order)),
        ("task_marker", &["comments", "column"], &column_setting(Setting::TaskMarker)),
        ("immutable", &["comments"], &immutable_setting),
        ("audit", &["comments", "into", "column", "references", "action", "previous", "tables", "exclude", "include"], &audit_from_json),
    ];
    for (key, allowed, read) in one {
        if let Some(value) = members.get(key) {
            out.push(setting_line(value, &format!("{at}.{key}"), allowed, read)?);
        }
    }
    // The members that hold one line for each item.
    let many: [(&str, &[&str], ReadSetting<'_>); 4] = [
        ("codec", &["comments", "column", "stages"], &codec_setting),
        ("blind_index", &["comments", "column", "index"], &blind_index_setting),
        ("navigation", &["comments", "foreign_key", "child", "parent"], &navigation_setting),
        ("markdown", &["comments", "column"], &column_setting(Setting::Markdown)),
    ];
    for (key, allowed, read) in many {
        out.extend(each_present(members, at, key, |value, at| setting_line(value, at, allowed, read))?);
    }
    // The canonical text orders the lines by their kind and then by their name; the list holds them in that order.
    out.sort_by(|a, b| (a.setting.rank(), a.setting.sort_name()).cmp(&(b.setting.rank(), b.setting.sort_name())));
    Ok(Settings { comments: lines(members, at, "comments")?, lines: out, closing: lines(members, at, "closing")? })
}

/// The reader of the setting of one line from the members of its object.
type ReadSetting<'r> = &'r dyn Fn(&Map<String, Value>, &str) -> Result<Setting, String>;

/// The line of the object `value`, whose members are `allowed`, with the setting that `read` reads.
fn setting_line(value: &Value, at: &str, allowed: &[&str], read: ReadSetting<'_>) -> Result<SettingLine, String> {
    let members = object(value, at, allowed)?;
    Ok(SettingLine { comments: lines(members, at, "comments")?, pos: Pos::default(), setting: read(members, at)? })
}

/// The reader of a setting that names one column.
fn column_setting(make: fn(Name) -> Setting) -> impl Fn(&Map<String, Value>, &str) -> Result<Setting, String> {
    move |members, at| Ok(make(name(members, at, "column")?))
}

fn entity_setting(members: &Map<String, Value>, at: &str) -> Result<Setting, String> {
    Ok(Setting::Entity(name(members, at, "name")?))
}

fn select_explicit_setting(members: &Map<String, Value>, at: &str) -> Result<Setting, String> {
    Ok(Setting::SelectExplicit(names(members, at, "columns")?))
}

fn immutable_setting(_members: &Map<String, Value>, _at: &str) -> Result<Setting, String> {
    Ok(Setting::Immutable)
}

fn codec_setting(members: &Map<String, Value>, at: &str) -> Result<Setting, String> {
    Ok(Setting::Codec(name(members, at, "column")?, names(members, at, "stages")?))
}

fn blind_index_setting(members: &Map<String, Value>, at: &str) -> Result<Setting, String> {
    Ok(Setting::BlindIndex(name(members, at, "column")?, name(members, at, "index")?))
}

fn navigation_setting(members: &Map<String, Value>, at: &str) -> Result<Setting, String> {
    Ok(Setting::Navigation(name(members, at, "foreign_key")?, name(members, at, "child")?, name(members, at, "parent")?))
}

fn word(text: &str) -> Name {
    Name { text: text.to_owned(), pos: Pos::default() }
}

fn store_from_json(members: &Map<String, Value>, at: &str) -> Result<Setting, String> {
    let kind = word(one_of(members, at, "kind", &["files", "document", "block"])?);
    let shape = if members.contains_key("shape") { Some(word(one_of(members, at, "shape", &["list", "table"])?)) } else { None };
    let shard = match members.get("shard") {
        Some(value) => {
            let at = &format!("{at}.shard");
            let members = object(value, at, &["column", "period"])?;
            Some(StoreShard {
                keyword: word("shard"),
                column: name(members, at, "column")?,
                period: word(one_of(members, at, "period", &["year", "month", "day"])?),
            })
        }
        None => None,
    };
    Ok(Setting::Store { kind, foreign: optional_name(members, at, "foreign")?, shape, shard })
}

fn audit_from_json(members: &Map<String, Value>, at: &str) -> Result<Setting, String> {
    let tables = match members.get("tables") {
        Some(value) => {
            let at = &format!("{at}.tables");
            let members = object(value, at, &["table", "record", "name"])?;
            Some(AuditTables { table: name(members, at, "table")?, record: name(members, at, "record")?, name: name(members, at, "name")? })
        }
        None => None,
    };
    let mut lists = Vec::new();
    for keyword in ["exclude", "include"] {
        if members.contains_key(keyword) {
            lists.push(AuditList { keyword: word(keyword), columns: names(members, at, keyword)? });
        }
    }
    if lists.len() > 1 {
        return Err(format!("{at} holds exclude and include; the form holds one of them"));
    }
    Ok(Setting::Audit {
        into: name(members, at, "into")?,
        column: name(members, at, "column")?,
        references: name(members, at, "references")?,
        action: name(members, at, "action")?,
        previous: name(members, at, "previous")?,
        tables,
        lists,
    })
}

fn diagram_from_json(value: &Value, at: &str) -> Result<Diagram, String> {
    let members = object(value, at, &["comments", "name", "placements", "closing"])?;
    let coordinate = |members: &Map<String, Value>, at: &str, key: &str| -> Result<i32, String> {
        let refusal = || format!("{at}.{key} is no integer from -2147483648 to 2147483647");
        let number = required(members, at, key)?.as_i64().ok_or_else(refusal)?;
        i32::try_from(number).map_err(|_out_of_range| refusal())
    };
    Ok(Diagram {
        comments: lines(members, at, "comments")?,
        name: name(members, at, "name")?,
        placements: each(members, at, "placements", |value, at| {
            let members = object(value, at, &["comments", "table", "x", "y"])?;
            Ok(Placement {
                comments: lines(members, at, "comments")?,
                table: name(members, at, "table")?,
                x: coordinate(members, at, "x")?,
                y: coordinate(members, at, "y")?,
            })
        })?,
        closing: lines(members, at, "closing")?,
    })
}

/// The form of the entities of a runtime model (FMS-16): the object with the member `entities`. The member
/// `manifest_hash` of the form is the hash of `polyspec_orm::Manifest`, which the value of this crate does not hold.
pub fn runtime_model_to_json(model: &RuntimeModel) -> Value {
    json!({"entities": model.entities.iter().map(entity_to_json).collect::<Vec<Value>>()})
}

fn key_to_json(key: &Key) -> Value {
    json!({"name": key.name, "columns": key.columns})
}

fn entity_to_json(entity: &Entity) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), Value::from(entity.name.as_str()));
    out.insert("table".into(), Value::from(entity.table.as_str()));
    out.insert("fields".into(), Value::Array(entity.fields.iter().map(field_to_json).collect()));
    out.insert("primary_key".into(), json!(entity.primary_key));
    let mut put = |key: &str, column: &Option<String>| {
        if let Some(column) = column {
            out.insert(key.to_owned(), Value::from(column.as_str()));
        }
    };
    put("identity", &entity.identity);
    put("updated", &entity.updated);
    put("soft_delete", &entity.soft_delete);
    put("aes_version", &entity.aes_version);
    out.insert("uniques".into(), Value::Array(entity.uniques.iter().map(key_to_json).collect()));
    out.insert("indexes".into(), Value::Array(entity.indexes.iter().map(key_to_json).collect()));
    out.insert(
        "foreign_keys".into(),
        Value::Array(
            entity.foreign_keys.iter().map(|key| json!({"name": key.name, "columns": key.columns, "table": key.table, "references": key.references})).collect(),
        ),
    );
    if let Some(audit) = &entity.audit {
        out.insert(
            "audit".into(),
            json!({"history": audit.history, "column": audit.column, "record": audit.record, "action": audit.action, "previous": audit.previous}),
        );
    }
    out.insert("immutable".into(), Value::from(entity.immutable));
    out.insert("external".into(), Value::from(entity.external));
    Value::Object(out)
}

fn field_to_json(field: &Field) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), Value::from(field.name.as_str()));
    out.insert("type".into(), type_to_json(field.ty));
    out.insert("nullable".into(), Value::from(field.nullable));
    out.insert("identity".into(), Value::from(field.identity));
    out.insert("primary_key".into(), Value::from(field.primary_key));
    out.insert("foreign_key".into(), Value::from(field.foreign_key));
    match &field.default {
        Some(FieldDefault::Now) => out.insert("default".into(), json!({"kind": "now"})),
        Some(FieldDefault::Literal(text)) => out.insert("default".into(), json!({"kind": "literal", "text": text})),
        None => None,
    };
    out.insert("select_explicit".into(), Value::from(field.select_explicit));
    out.insert("codec".into(), json!(field.codec));
    if let Some(index) = &field.blind_index {
        out.insert("blind_index".into(), Value::from(index.as_str()));
    }
    Value::Object(out)
}

/// The entities of the form of a runtime model (FMS-16). The member `manifest_hash` of the form is a text that this
/// function does not keep; the caller that holds the hash reads it. A value that is not of the form is refused with
/// a text that names the member.
pub fn runtime_model_from_json(value: &Value) -> Result<RuntimeModel, String> {
    let at = "model";
    let members = object(value, at, &["manifest_hash", "entities"])?;
    if members.contains_key("manifest_hash") {
        text(members, at, "manifest_hash")?;
    }
    Ok(RuntimeModel { entities: each(members, at, "entities", entity_from_json)? })
}

fn word_of(value: &Value, at: &str) -> Result<String, String> {
    name_of(value, at).map(|name| name.text)
}

fn optional_word(members: &Map<String, Value>, at: &str, key: &str) -> Result<Option<String>, String> {
    Ok(optional_name(members, at, key)?.map(|name| name.text))
}

fn key_from_json(value: &Value, at: &str) -> Result<Key, String> {
    let members = object(value, at, &["name", "columns"])?;
    Ok(Key { name: name(members, at, "name")?.text, columns: each(members, at, "columns", word_of)? })
}

fn entity_from_json(value: &Value, at: &str) -> Result<Entity, String> {
    let members = object(
        value,
        at,
        &[
            "name",
            "table",
            "fields",
            "primary_key",
            "identity",
            "uniques",
            "indexes",
            "foreign_keys",
            "updated",
            "soft_delete",
            "aes_version",
            "audit",
            "immutable",
            "external",
        ],
    )?;
    let audit = match members.get("audit") {
        Some(value) => {
            let at = &format!("{at}.audit");
            let members = object(value, at, &["history", "column", "record", "action", "previous"])?;
            let word = |key: &str| name(members, at, key).map(|name| name.text);
            Some(Audit { history: word("history")?, column: word("column")?, record: word("record")?, action: word("action")?, previous: word("previous")? })
        }
        None => None,
    };
    Ok(Entity {
        name: name(members, at, "name")?.text,
        table: name(members, at, "table")?.text,
        fields: each(members, at, "fields", field_from_json)?,
        primary_key: each(members, at, "primary_key", word_of)?,
        identity: optional_word(members, at, "identity")?,
        uniques: each(members, at, "uniques", key_from_json)?,
        indexes: each(members, at, "indexes", key_from_json)?,
        foreign_keys: each(members, at, "foreign_keys", |value, at| {
            let members = object(value, at, &["name", "columns", "table", "references"])?;
            Ok(EntityForeignKey {
                name: name(members, at, "name")?.text,
                columns: each(members, at, "columns", word_of)?,
                table: name(members, at, "table")?.text,
                references: each(members, at, "references", word_of)?,
            })
        })?,
        updated: optional_word(members, at, "updated")?,
        soft_delete: optional_word(members, at, "soft_delete")?,
        aes_version: optional_word(members, at, "aes_version")?,
        audit,
        immutable: flag(members, at, "immutable")?,
        external: flag(members, at, "external")?,
    })
}

fn field_from_json(value: &Value, at: &str) -> Result<Field, String> {
    let members =
        object(value, at, &["name", "type", "nullable", "identity", "primary_key", "foreign_key", "default", "select_explicit", "codec", "blind_index"])?;
    let default = match members.get("default") {
        Some(value) => Some(default_from_json(value, &format!("{at}.default"))?),
        None => None,
    };
    Ok(Field {
        name: name(members, at, "name")?.text,
        ty: read_type(required(members, at, "type")?, &format!("{at}.type"))?,
        nullable: flag(members, at, "nullable")?,
        identity: flag(members, at, "identity")?,
        primary_key: flag(members, at, "primary_key")?,
        foreign_key: flag(members, at, "foreign_key")?,
        default: default.map(|(now, text)| if now { FieldDefault::Now } else { FieldDefault::Literal(text) }),
        select_explicit: flag(members, at, "select_explicit")?,
        codec: each(members, at, "codec", word_of)?,
        blind_index: optional_word(members, at, "blind_index")?,
    })
}

/// The form of a diagnostic (FMS-15).
pub fn diagnostic_to_json(diagnostic: &Diagnostic) -> Value {
    json!({"rule": diagnostic.rule, "line": diagnostic.line, "column": diagnostic.column, "message": diagnostic.message})
}

/// The form of a declaration position (FMS-15).
pub fn position_to_json(position: &Position) -> Value {
    json!({"kind": position.kind, "path": position.path, "line": position.line, "column": position.column})
}

#[cfg(test)]
#[path = "../../tests/unit/flowmark_surface.rs"]
mod flowmark_surface_tests;
