//! The generated schema.json: every name and type of the model decided from
//! the diagrams, validated, and hashed.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::audit::{self, Audit, AuditLog};
use super::json::{self, Obj, J};
use super::mermaid::{go_quote, DColumn, DEntity, DRelation, Diagram, Directive, OrmDirective};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Manifest {
    pub schema_hash: String,
    #[serde(default, deserialize_with = "null_default")]
    pub order: Vec<String>,
    #[serde(default, deserialize_with = "null_default")]
    pub entities: BTreeMap<String, Entity>,
    #[serde(default, deserialize_with = "null_default")]
    pub orm: Vec<OrmDirective>,
    #[serde(default, deserialize_with = "null_default")]
    pub external_fks: Vec<ExternalFk>,
    #[serde(default, deserialize_with = "null_default")]
    pub immutable: Vec<String>,
    #[serde(default)]
    pub audit_log: Option<AuditLog>,
    #[serde(default, deserialize_with = "null_default")]
    pub audits: Vec<Audit>,
}

/// A foreign key to a table outside the manifest; it affects DDL only.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ExternalFk {
    pub entity: String,
    #[serde(default, deserialize_with = "null_default")]
    pub columns: Vec<String>,
    pub target_table: String,
    #[serde(default, deserialize_with = "null_default")]
    pub target_columns: Vec<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub on_delete: String,
    #[serde(default)]
    pub deferred: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Entity {
    pub name: String,
    pub table: String,
    #[serde(default)]
    pub renamed_from: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default, deserialize_with = "null_default")]
    pub pk: Vec<String>,
    #[serde(default)]
    pub auto: String,
    #[serde(default, deserialize_with = "null_default")]
    pub columns: Vec<Col>,
    #[serde(default, deserialize_with = "null_default")]
    pub relations: BTreeMap<String, Rel>,
    #[serde(default, deserialize_with = "null_default")]
    pub unique: Vec<Vec<String>>,
    #[serde(default, deserialize_with = "null_default")]
    pub indexes: BTreeMap<String, Vec<String>>,
    #[serde(default, deserialize_with = "null_default")]
    pub fulltext: Vec<Vec<String>>,
    #[serde(default, deserialize_with = "null_default")]
    pub checks: Vec<Check>,
    #[serde(default)]
    pub timestamps: Option<Timestamps>,
    #[serde(default)]
    pub soft_delete: String,
    #[serde(default)]
    pub aes_version: String,
    #[serde(skip)]
    pub line: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Check {
    pub name: String,
    pub expr: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Timestamps {
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub updated: String,
}

/// A column with its canonical type: i32 i64 f64 decimal string text bytes
/// bool date time datetime json enum point inet.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Col {
    pub name: String,
    #[serde(default)]
    pub renamed_from: String,
    #[serde(rename = "type")]
    pub typ: String,
    #[serde(default)]
    pub raw: String,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub auto: bool,
    #[serde(default)]
    pub on_update: bool,
    #[serde(default)]
    pub unsigned: bool,
    #[serde(default)]
    pub lazy: bool,
    #[serde(default)]
    pub len: i64,
    #[serde(default)]
    pub precision: i64,
    #[serde(default)]
    pub scale: i64,
    #[serde(default, deserialize_with = "null_default")]
    pub r#enum: Vec<String>,
    #[serde(default, deserialize_with = "null_default")]
    pub styles: Vec<String>,
    #[serde(default)]
    pub blind_index: String,
    #[serde(default, rename = "ref")]
    pub reference: Option<Ref>,
    /// A source-level `-> table.column` declaration, as opposed to a
    /// relation-inferred reference. Build-time only.
    #[serde(skip)]
    pub ref_explicit: bool,
    #[serde(default)]
    pub pk: bool,
    #[serde(default)]
    pub fk: bool,
    #[serde(default)]
    pub uk: bool,
    #[serde(default)]
    pub describe: String,
    #[serde(default)]
    pub comment: String,
    #[serde(skip)]
    pub line: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Ref {
    pub entity: String,
    pub column: String,
}

/// One direction of a relationship line; keys keep the column pair order.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Rel {
    pub name: String,
    pub kind: String,
    pub target: String,
    #[serde(default, deserialize_with = "null_default")]
    pub keys: Vec<RelKey>,
    #[serde(default)]
    pub on_delete: String,
    /// An additional child-side foreign key whose local columns already have
    /// another inferred target.
    #[serde(default)]
    pub foreign_key: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct RelKey {
    pub local: String,
    pub target: String,
}

pub(super) fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// A validation error with the source line when there is one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildError {
    pub line: usize,
    pub msg: String,
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.line > 0 {
            write!(f, "line {}: {}", self.line, self.msg)
        } else {
            f.write_str(&self.msg)
        }
    }
}

impl std::error::Error for BuildError {}

fn berr(line: usize, msg: impl Into<String>) -> BuildError {
    BuildError { line, msg: msg.into() }
}

/// Column names follow the reserved-name rules of the model syntax
/// (docs/dsl.md §9). SQL keywords are allowed because every dialect quotes
/// identifiers.
pub const RESERVED_SEGMENTS: &[&str] = &["and", "or", "with", "gt", "lt", "ge", "le", "eq", "ne", "lk", "lb", "between", "fulltext", "tuple"];
pub const RESERVED_PREFIXES: &[&str] = &[
    "and", "or", "get", "set", "new", "plus", "minus", "order_by", "group_by", "tuple", "gt", "lt", "ge", "le", "eq", "ne", "lk", "lb", "between", "fulltext",
];
pub const RESERVED_COLUMNS: &[&str] = &[
    "and",
    "or",
    "get",
    "gets",
    "gets_page",
    "get_query",
    "limit",
    "alias",
    "connect",
    "create",
    "creates",
    "update",
    "delete",
    "save",
    "raw",
    "on",
    "random",
];
const RESERVED_ENTITIES: &[&str] = &["connect", "schema_hash"];

static RE_TYPE_PAREN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([a-z]+)(?:\(([^)]*)\))?$").unwrap());
static RE_IDENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_]*$").unwrap());

/// Derives the manifest from parsed diagrams and validates it.
pub fn build(diagrams: &[Diagram]) -> Result<Manifest, BuildError> {
    build_with(false, diagrams)
}

/// Accepts a live schema that predates required AES version metadata.
/// Migration targets use [`build`].
pub fn build_migration_source(diagrams: &[Diagram]) -> Result<Manifest, BuildError> {
    build_with(true, diagrams)
}

fn build_with(allow_missing_aes_version: bool, diagrams: &[Diagram]) -> Result<Manifest, BuildError> {
    let mut m = Manifest::default();
    for d in diagrams {
        m.orm.extend(d.orm.iter().cloned());
        for e in &d.entities {
            if m.entities.contains_key(&e.name) {
                return Err(berr(e.line, format!("duplicate entity {}", e.name)));
            }
            let ent = build_entity(e)?;
            m.entities.insert(e.name.clone(), ent);
            m.order.push(e.name.clone());
        }
    }
    for d in diagrams {
        for x in d.orm.iter().filter(|x| x.kind == "table") {
            let entity = arg(x, "entity");
            let name = arg(x, "name");
            let Some(ent) = m.entities.get_mut(entity) else {
                return Err(berr(x.line, format!("%% orm:table: unknown entity {entity}")));
            };
            if !qualified_table_name(name) {
                return Err(berr(x.line, format!("%% orm:table: name must be schema.table: {name}")));
            }
            if ent.table != entity {
                return Err(berr(x.line, format!("%% orm:table: duplicate entity {entity}")));
            }
            ent.table = name.to_owned();
        }
    }
    for d in diagrams {
        for r in &d.relations {
            m.add_relation(r)?;
        }
    }
    for d in diagrams {
        for x in &d.directives {
            m.add_directive(x)?;
        }
    }
    let mut first_audit = 0;
    for d in diagrams {
        for x in &d.orm {
            match x.kind.as_str() {
                "audit_log" => audit::add_audit_log(&mut m, x)?,
                "audit" => {
                    if first_audit == 0 {
                        first_audit = x.line;
                    }
                    audit::add_audit(&mut m, x)?;
                }
                _ => {}
            }
            if x.kind == "immutable" {
                let entity = arg(x, "entity");
                if !m.entities.contains_key(entity) {
                    return Err(berr(x.line, format!("%% orm:immutable: unknown entity {entity}")));
                }
                if !m.immutable.iter().any(|e| e == entity) {
                    m.immutable.push(entity.to_owned());
                }
            }
            if x.kind != "foreign" {
                continue;
            }
            let fk = external_fk(x, &m)?;
            m.external_fks.push(fk);
        }
    }
    audit::finish_audits(&mut m, first_audit)?;
    m.validate(allow_missing_aes_version)?;
    m.schema_hash = m.hash();
    Ok(m)
}

fn arg<'a>(x: &'a OrmDirective, key: &str) -> &'a str {
    x.args.get(key).map(String::as_str).unwrap_or("")
}

fn external_fk(x: &OrmDirective, m: &Manifest) -> Result<ExternalFk, BuildError> {
    let entity = arg(x, "entity");
    let Some(e) = m.entities.get(entity) else {
        return Err(berr(x.line, format!("%% orm:foreign: unknown entity {entity}")));
    };
    let columns = split_directive_list(arg(x, "columns"));
    if columns.is_empty() {
        return Err(berr(x.line, "%% orm:foreign: columns must not be empty"));
    }
    for column in &columns {
        if e.column(column).is_none() {
            return Err(berr(x.line, format!("% orm:foreign: unknown column {entity}.{column}")));
        }
    }
    let reference = parse_external_reference(arg(x, "references"));
    let Some((table, target_columns)) = reference.filter(|(t, cols)| !t.is_empty() && cols.len() == columns.len()) else {
        return Err(berr(x.line, "%% orm:foreign: references must be table(col,...) with matching columns"));
    };
    let mut name = arg(x, "name").to_owned();
    if name.is_empty() {
        name = format!("fk_{}_{}", e.table.replace('.', "_"), columns.join("_"));
    }
    let on_delete = arg(x, "on_delete");
    if !on_delete.is_empty() && on_delete != "cascade" && on_delete != "setnull" {
        return Err(berr(x.line, "%% orm:foreign: on_delete must be cascade or setnull"));
    }
    let deferred = arg(x, "deferred");
    if !deferred.is_empty() && deferred != "true" && deferred != "false" {
        return Err(berr(x.line, "%% orm:foreign: deferred must be true or false"));
    }
    Ok(ExternalFk {
        entity: entity.to_owned(),
        columns,
        target_table: table,
        target_columns,
        name,
        on_delete: on_delete.to_owned(),
        deferred: deferred == "true",
    })
}

fn split_directive_list(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned).collect()
}

fn parse_external_reference(value: &str) -> Option<(String, Vec<String>)> {
    let open = value.rfind('(')?;
    if open == 0 || !value.ends_with(')') {
        return None;
    }
    let table = value[..open].trim().to_owned();
    let columns = split_directive_list(&value[open + 1..value.len() - 1]);
    (!table.is_empty() && !columns.is_empty()).then_some((table, columns))
}

fn qualified_table_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() == 2 && RE_IDENT.is_match(parts[0]) && RE_IDENT.is_match(parts[1])
}

fn build_entity(e: &DEntity) -> Result<Entity, BuildError> {
    if !RE_IDENT.is_match(&e.name) {
        return Err(berr(e.line, format!("entity name must be snake_case: {}", e.name)));
    }
    if RESERVED_ENTITIES.contains(&e.name.as_str()) {
        return Err(berr(e.line, format!("entity name is reserved by the generated models: {}", e.name)));
    }
    let mut ent = Entity { name: e.name.clone(), table: e.name.clone(), comment: e.comment.clone(), line: e.line, ..Default::default() };
    for dc in &e.columns {
        check_column_name(&dc.name).map_err(|msg| berr(dc.line, msg))?;
        if ent.column(&dc.name).is_some() {
            return Err(berr(dc.line, format!("duplicate column {}.{}", e.name, dc.name)));
        }
        let mut c = build_column(dc).map_err(|msg| berr(dc.line, msg))?;
        for k in &dc.keys {
            match k.as_str() {
                "PK" => {
                    c.pk = true;
                    ent.pk.push(c.name.clone());
                }
                "FK" => c.fk = true,
                "UK" => {
                    c.uk = true;
                    ent.unique.push(vec![c.name.clone()]);
                }
                _ => {}
            }
        }
        if c.auto {
            if !ent.auto.is_empty() {
                return Err(berr(dc.line, format!("two auto columns in {}", e.name)));
            }
            ent.auto = c.name.clone();
        }
        ent.columns.push(c);
    }
    if ent.pk.is_empty() {
        return Err(berr(e.line, format!("entity {} has no PK", e.name)));
    }
    if ent.column("aes_key_version").is_some() {
        ent.aes_version = "aes_key_version".into();
    }
    let created = ent.column("created_ts").is_some();
    let updated = ent.column("updated_ts").is_some();
    if created || updated {
        ent.timestamps = Some(Timestamps {
            created: if created { "created_ts".into() } else { String::new() },
            updated: if updated { "updated_ts".into() } else { String::new() },
        });
    }
    Ok(ent)
}

/// Applies the column naming rules.
pub fn check_column_name(n: &str) -> Result<(), String> {
    if !RE_IDENT.is_match(n) {
        return Err(format!("column name must be snake_case: {n}"));
    }
    if n.contains("__") {
        return Err(format!("column name may not contain '__': {n}"));
    }
    for segment in n.split('_') {
        if RESERVED_SEGMENTS.contains(&segment) {
            return Err(format!("column name may not contain the segment {}: {n}", go_quote(segment)));
        }
    }
    if RESERVED_COLUMNS.contains(&n) {
        return Err(format!("column name is a reserved method name: {n}"));
    }
    for p in RESERVED_PREFIXES {
        if n == *p || n.starts_with(&format!("{p}_")) {
            return Err(format!("column name may not start with {}: {n}", go_quote(p)));
        }
    }
    Ok(())
}

/// Go's strconv.Atoi for the digits of a type argument.
fn atoi(s: &str) -> Option<i64> {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Maps the raw database type to the canonical type and applies the naming
/// conventions (is_* → bool, prefix styles, text/blob → lazy).
fn build_column(dc: &DColumn) -> Result<Col, String> {
    let mut c = Col {
        name: dc.name.clone(),
        raw: dc.typ.clone(),
        nullable: dc.nullable,
        default: dc.default.clone(),
        auto: dc.auto,
        on_update: dc.on_update,
        unsigned: dc.unsigned,
        lazy: dc.lazy,
        styles: dc.styles.clone(),
        describe: dc.describe.clone(),
        comment: dc.db_comment.clone(),
        line: dc.line,
        ..Default::default()
    };
    let lower = dc.typ.to_lowercase();
    let Some(m) = RE_TYPE_PAREN.captures(&lower) else {
        return Err(format!("column {}: bad type {}", dc.name, go_quote(&dc.typ)));
    };
    let base = m.get(1).unwrap().as_str();
    let arg = m.get(2).map_or("", |x| x.as_str());
    match base {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" => {
            c.typ = if dc.unsigned { "i64" } else { "i32" }.into();
            if base == "tinyint" && (dc.bool_ || (dc.name.starts_with("is_") && !dc.int)) {
                c.typ = "bool".into();
            }
        }
        "bigint" => c.typ = "i64".into(),
        "float" | "double" | "real" => c.typ = "f64".into(),
        "decimal" | "numeric" => {
            c.typ = "decimal".into();
            if !arg.is_empty() {
                let (p, s) = match arg.split_once('_') {
                    Some((p, s)) => (p, Some(s)),
                    None => (arg, None),
                };
                c.precision = atoi(p).ok_or_else(|| format!("column {}: decimal precision {}", dc.name, go_quote(arg)))?;
                if let Some(s) = s {
                    c.scale = atoi(s).ok_or_else(|| format!("column {}: decimal scale {}", dc.name, go_quote(arg)))?;
                }
            }
        }
        "varchar" | "char" => {
            c.typ = "string".into();
            if arg.is_empty() {
                return Err(format!("column {}: {base} requires a positive length", dc.name));
            }
            match atoi(arg) {
                Some(n) if n >= 1 => c.len = n,
                _ => return Err(format!("column {}: {base} requires a positive length, got {}", dc.name, go_quote(arg))),
            }
        }
        "uuid" => c.typ = "string".into(),
        "text" | "tinytext" | "mediumtext" | "longtext" => c.typ = "text".into(),
        "blob" | "tinyblob" | "mediumblob" | "longblob" | "varbinary" | "binary" => {
            c.typ = "bytes".into();
            if !arg.is_empty() {
                c.len = atoi(arg).unwrap_or(0);
            }
        }
        "date" => c.typ = "date".into(),
        "time" => c.typ = "time".into(),
        "datetime" | "timestamp" => {
            c.typ = "datetime".into();
            if !arg.is_empty() {
                c.precision = atoi(arg).unwrap_or(0);
            }
        }
        "jsontext" => c.typ = "jsontext".into(),
        "json" => return Err(format!("column {}: type json is not supported; use jsontext, which stores the ordered-json text", dc.name)),
        "enum" => {
            c.typ = "enum".into();
            if arg.is_empty() {
                return Err(format!("column {}: enum needs values enum(a_b_c)", dc.name));
            }
            c.r#enum = arg.split('_').map(str::to_owned).collect();
        }
        "point" => c.typ = "point".into(),
        "bool" | "boolean" => c.typ = "bool".into(),
        _ => return Err(format!("column {}: unsupported type {}", dc.name, go_quote(&dc.typ))),
    }
    if c.styles.is_empty() {
        let n = dc.name.as_str();
        let inferred: &[&str] = if n.starts_with("aes_hex_") {
            &["aes", "hex"]
        } else if n.starts_with("aes_") && n != "aes_key_version" {
            &["aes"]
        } else if n.starts_with("gz_") {
            &["serialize", "gz"]
        } else if n.starts_with("jsons_") {
            &["jsons"]
        } else if n.starts_with("json_") {
            &["json"]
        } else if n.starts_with("yaml_") {
            &["yaml"]
        } else if n.starts_with("base64_") {
            &["serialize", "base64"]
        } else if n.starts_with("serialize_") {
            &["serialize"]
        } else if n == "ip" {
            &["ip"]
        } else {
            &[]
        };
        c.styles = inferred.iter().map(|s| (*s).to_owned()).collect();
    }
    if c.styles.len() == 1 && c.styles[0] == "ip" {
        c.typ = "inet".into();
    }
    if c.typ == "jsontext" && c.styles.is_empty() {
        c.styles = vec!["json".into()];
    }
    if c.typ == "jsontext" && c.styles != ["json"] && c.styles != ["jsons"] {
        return Err(format!(
            "column {}: a jsontext column takes only the json or jsons stage; store an encrypted JSON value in a blob column with the stages json aes",
            dc.name
        ));
    }
    if dc.name == "aes_key_version" {
        c.lazy = true;
    }
    if !c.lazy && !dc.lazy {
        let aes_hex = c.styles.len() == 2 && c.styles[0] == "aes" && c.styles[1] == "hex";
        if c.typ == "text" || c.typ == "bytes" || (!c.styles.is_empty() && !aes_hex && c.styles[0] != "ip") {
            c.lazy = true;
        }
    }
    if !dc.reference.is_empty() {
        let (entity, column) = dc.reference.split_once('.').unwrap_or((&dc.reference, ""));
        c.reference = Some(Ref { entity: entity.to_owned(), column: column.to_owned() });
        c.ref_explicit = true;
        c.fk = true;
    }
    Ok(c)
}

fn plural(s: &str) -> String {
    let b = s.as_bytes();
    if s.ends_with('y') && b.len() > 1 && !b"aeiou".contains(&b[b.len() - 2]) {
        format!("{}ies", &s[..s.len() - 1])
    } else if s.ends_with('s') || s.ends_with('x') || s.ends_with("ch") || s.ends_with("sh") {
        format!("{s}es")
    } else {
        format!("{s}s")
    }
}

impl Entity {
    /// The column by name.
    pub fn column(&self, name: &str) -> Option<&Col> {
        self.columns.iter().find(|c| c.name == name)
    }

    pub fn column_mut(&mut self, name: &str) -> Option<&mut Col> {
        self.columns.iter_mut().find(|c| c.name == name)
    }
}

impl Manifest {
    /// The entities in source order.
    pub fn ordered(&self) -> impl Iterator<Item = &Entity> {
        self.order.iter().filter_map(|n| self.entities.get(n))
    }

    fn add_relation(&mut self, r: &DRelation) -> Result<(), BuildError> {
        let Some(parent) = self.entities.get(&r.parent) else {
            return Err(berr(r.line, format!("relation references unknown entity {}", r.parent)));
        };
        let (parent_name_, parent_pk) = (parent.name.clone(), parent.pk.clone());
        if !self.entities.contains_key(&r.child) {
            return Err(berr(r.line, format!("relation references unknown entity {}", r.child)));
        }
        if r.fks.len() != parent_pk.len() {
            return Err(berr(
                r.line,
                format!("relation {} -> {}: {} FK columns do not match {} target PK columns", r.parent, r.child, r.fks.len(), parent_pk.len()),
            ));
        }
        let child = self.entities.get_mut(&r.child).unwrap();
        let mut overlapping = false;
        for (i, name) in r.fks.iter().enumerate() {
            let Some(fk) = child.column_mut(name) else {
                return Err(berr(r.line, format!("relation {} -> {}: FK column {name} not in {}", r.parent, r.child, r.child)));
            };
            fk.fk = true;
            match &fk.reference {
                None => fk.reference = Some(Ref { entity: parent_name_.clone(), column: parent_pk[i].clone() }),
                Some(reference) if reference.entity != parent_name_ || reference.column != parent_pk[i] => {
                    if fk.ref_explicit {
                        return Err(berr(
                            r.line,
                            format!(
                                "relation {} -> {}: FK column {name} references {}.{}, expected {}.{}",
                                r.parent, r.child, reference.entity, reference.column, parent_name_, parent_pk[i]
                            ),
                        ));
                    }
                    overlapping = true;
                }
                Some(_) => {}
            }
        }
        let child_many = r.cardinality.ends_with('{');
        let mut child_name = r.child_name.clone();
        if child_name.is_empty() {
            if r.fks.len() != 1 {
                return Err(berr(r.line, format!("relation {} -> {}: composite relation must name both sides", r.parent, r.child)));
            }
            let fk = &r.fks[0];
            let trimmed = fk.strip_suffix("_seq").unwrap_or(fk);
            child_name = trimmed.strip_suffix("_id").unwrap_or(trimmed).to_owned();
            if child_name == *fk {
                return Err(berr(
                    r.line,
                    format!("relation {} -> {}: cannot derive a name from FK {fk}; write (child / parent) in the label", r.parent, r.child),
                ));
            }
        }
        let child_entity_name = child.name.clone();
        let mut parent_rel_name = r.parent_name.clone();
        if parent_rel_name.is_empty() {
            let prefix = format!("{parent_name_}_");
            let base = child_entity_name.strip_prefix(&prefix).unwrap_or(&child_entity_name);
            parent_rel_name = if child_many { plural(base) } else { base.to_owned() };
        }
        if child.relations.contains_key(&child_name) {
            return Err(berr(r.line, format!("relation name {child_entity_name}.{child_name} already used; name the sides in the label")));
        }
        if self.entities[&r.parent].relations.contains_key(&parent_rel_name) {
            return Err(berr(r.line, format!("relation name {parent_name_}.{parent_rel_name} already used; name the sides in the label")));
        }
        let child_keys: Vec<RelKey> = r.fks.iter().zip(&parent_pk).map(|(f, p)| RelKey { local: f.clone(), target: p.clone() }).collect();
        let parent_keys: Vec<RelKey> = r.fks.iter().zip(&parent_pk).map(|(f, p)| RelKey { local: p.clone(), target: f.clone() }).collect();
        let child = self.entities.get_mut(&r.child).unwrap();
        child.relations.insert(
            child_name.clone(),
            Rel {
                name: child_name,
                kind: "one".into(),
                target: parent_name_.clone(),
                keys: child_keys,
                on_delete: r.on_delete.clone(),
                foreign_key: overlapping,
            },
        );
        let parent = self.entities.get_mut(&r.parent).unwrap();
        parent.relations.insert(
            parent_rel_name.clone(),
            Rel {
                name: parent_rel_name,
                kind: if child_many { "many" } else { "one" }.into(),
                target: child_entity_name,
                keys: parent_keys,
                on_delete: r.on_delete.clone(),
                foreign_key: false,
            },
        );
        Ok(())
    }

    fn add_directive(&mut self, x: &Directive) -> Result<(), BuildError> {
        let Some(ent) = self.entities.get_mut(&x.table) else {
            return Err(berr(x.line, format!("%% {}: unknown entity {}", x.kind, x.table)));
        };
        for c in &x.columns {
            if ent.column(c).is_none() {
                return Err(berr(x.line, format!("%% {} {}: unknown column {c}", x.kind, x.table)));
            }
        }
        match x.kind.as_str() {
            "table_comment" => ent.comment = x.raw.clone(),
            "column_comment" => ent.column_mut(&x.columns[0]).unwrap().comment = x.raw.clone(),
            "rename_table" => {
                if !ent.renamed_from.is_empty() {
                    return Err(berr(x.line, format!("rename_table declared twice for {}", ent.name)));
                }
                ent.renamed_from = x.name.clone();
            }
            "rename_column" => {
                let entity = ent.name.clone();
                let column = ent.column_mut(&x.columns[0]).unwrap();
                if !column.renamed_from.is_empty() {
                    return Err(berr(x.line, format!("rename_column declared twice for {entity}.{}", column.name)));
                }
                column.renamed_from = x.name.clone();
            }
            "unique" => ent.unique.push(x.columns.clone()),
            "index" => {
                let name = if x.name.is_empty() { format!("ix_{}", x.columns.join("_")) } else { x.name.clone() };
                if ent.indexes.contains_key(&name) {
                    return Err(berr(x.line, format!("duplicate index name {name}")));
                }
                ent.indexes.insert(name, x.columns.clone());
            }
            "fulltext" => ent.fulltext.push(x.columns.clone()),
            "check" => {
                if ent.checks.iter().any(|c| c.name == x.name) {
                    return Err(berr(x.line, format!("check {} declared twice", x.name)));
                }
                if ent.column(&x.name).is_some() {
                    return Err(berr(x.line, format!("check {} collides with a column", x.name)));
                }
                for col in backtick_names(&x.raw) {
                    if ent.column(&col).is_none() {
                        return Err(berr(x.line, format!("check {}: unknown column `{col}`", x.name)));
                    }
                }
                ent.checks.push(Check { name: x.name.clone(), expr: x.raw.clone() });
            }
            "timestamps" => ent.timestamps = Some(Timestamps { created: x.columns[0].clone(), updated: x.columns[1].clone() }),
            "aes_version" => {
                if !ent.aes_version.is_empty() && ent.aes_version != "aes_key_version" {
                    return Err(berr(x.line, format!("aes version declared twice for {}", ent.name)));
                }
                ent.aes_version = x.columns[0].clone();
            }
            "soft_delete" => {
                if !ent.soft_delete.is_empty() {
                    return Err(berr(x.line, format!("soft_delete declared twice for {}", ent.name)));
                }
                let c = ent.column(&x.columns[0]).unwrap();
                if c.typ != "datetime" || !c.nullable {
                    return Err(berr(x.line, format!("soft_delete column {} must be a nullable datetime", x.columns[0])));
                }
                ent.soft_delete = x.columns[0].clone();
            }
            "blind_index" => {
                let encrypted = ent.column(&x.columns[0]).unwrap();
                let index = ent.column(&x.columns[1]).unwrap();
                if encrypted.name == index.name {
                    return Err(berr(x.line, "blind index source and target must differ"));
                }
                if !encrypted.styles.iter().any(|s| s == "aes") {
                    return Err(berr(x.line, format!("blind index source {} is not an AES column", encrypted.name)));
                }
                if index.styles.iter().any(|s| s == "aes") {
                    return Err(berr(x.line, format!("blind index target {} must not be an AES column", index.name)));
                }
                if index.typ != "string" && index.typ != "bytes" {
                    return Err(berr(x.line, format!("blind index target {} must be string or bytes", index.name)));
                }
                if index.typ == "string" && index.len < 64 {
                    return Err(berr(x.line, format!("blind index target {} must hold 64 hexadecimal characters", index.name)));
                }
                if encrypted.nullable != index.nullable {
                    return Err(berr(x.line, format!("blind index target {} nullability must match source {}", index.name, encrypted.name)));
                }
                if !ent.indexes.values().any(|cols| cols.len() == 1 && cols[0] == index.name) {
                    return Err(berr(x.line, format!("blind index target {} requires a declared single-column index", index.name)));
                }
                if !encrypted.blind_index.is_empty() {
                    return Err(berr(x.line, format!("blind index source {} is declared twice", encrypted.name)));
                }
                if ent.columns.iter().any(|c| c.blind_index == index.name) {
                    return Err(berr(x.line, format!("blind index target {} is declared twice", index.name)));
                }
                let index_name = index.name.clone();
                ent.column_mut(&x.columns[0]).unwrap().blind_index = index_name;
            }
            _ => {}
        }
        Ok(())
    }

    fn validate(&self, allow_missing_aes_version: bool) -> Result<(), BuildError> {
        let mut renamed_tables: HashMap<&str, &str> = HashMap::new();
        for e in self.ordered() {
            if !e.renamed_from.is_empty() {
                if e.renamed_from == e.name {
                    return Err(berr(e.line, format!("rename_table source equals target {}", e.name)));
                }
                if let Some(target) = renamed_tables.get(e.renamed_from.as_str()) {
                    return Err(berr(e.line, format!("rename_table source {} is used by {target} and {}", e.renamed_from, e.name)));
                }
                renamed_tables.insert(&e.renamed_from, &e.name);
            }
            let targets: HashSet<&str> = e.columns.iter().map(|c| c.name.as_str()).collect();
            let mut renamed_columns: HashMap<&str, &str> = HashMap::new();
            for c in e.columns.iter().filter(|c| !c.renamed_from.is_empty()) {
                if c.renamed_from == c.name {
                    return Err(berr(c.line, format!("rename_column source equals target {}.{}", e.name, c.name)));
                }
                if targets.contains(c.renamed_from.as_str()) {
                    return Err(berr(c.line, format!("rename_column source {}.{} remains a target column", e.name, c.renamed_from)));
                }
                if let Some(target) = renamed_columns.get(c.renamed_from.as_str()) {
                    return Err(berr(c.line, format!("rename_column source {}.{} is used by {target} and {}", e.name, c.renamed_from, c.name)));
                }
                renamed_columns.insert(&c.renamed_from, &c.name);
            }
        }
        for e in self.ordered() {
            for c in &e.columns {
                if c.styles.iter().any(|s| s == "aes") {
                    let version = e.column(&e.aes_version);
                    let valid = version.is_some_and(|v| !v.nullable && (v.typ == "i32" || v.typ == "i64"));
                    if !valid {
                        if allow_missing_aes_version && version.is_none() {
                            continue;
                        }
                        return Err(berr(e.line, format!("{}.{} requires a non-null integer aes version column", e.name, c.name)));
                    }
                }
            }
            for (rn, r) in &e.relations {
                if e.column(rn).is_some() {
                    return Err(berr(e.line, format!("relation name {}.{rn} collides with a column; name the sides in the label", e.name)));
                }
                if !self.entities.contains_key(&r.target) {
                    return Err(berr(e.line, format!("relation target missing: {}", r.target)));
                }
            }
            for c in &e.columns {
                if let Some(reference) = &c.reference {
                    let exists = self.entities.get(&reference.entity).is_some_and(|t| t.column(&reference.column).is_some());
                    if !exists {
                        return Err(berr(c.line, format!("{}.{} -> {}.{}: target does not exist", e.name, c.name, reference.entity, reference.column)));
                    }
                }
            }
            if let Some(ts) = &e.timestamps {
                for col in [&ts.created, &ts.updated] {
                    if !col.is_empty() && e.column(col).is_none() {
                        return Err(berr(e.line, format!("timestamps column missing: {}.{col}", e.name)));
                    }
                }
            }
            let mut seen = HashSet::new();
            for u in &e.unique {
                let k = u.join(",");
                if !seen.insert(k.clone()) {
                    return Err(berr(e.line, format!("duplicate unique {} ({k})", e.name)));
                }
            }
        }
        Ok(())
    }

    /// Non-fatal findings: FK columns without a relationship line.
    pub fn warnings(&self) -> Vec<String> {
        let mut w = Vec::new();
        for e in self.ordered() {
            for c in &e.columns {
                if c.fk && c.reference.is_none() {
                    w.push(format!("{}.{} is FK but has no relationship line or '-> table.column'", e.name, c.name));
                }
            }
        }
        w
    }

    /// SHA-256 of the compact JSON with an empty hash, first 8 bytes in hex.
    pub fn hash(&self) -> String {
        let sum = Sha256::digest(json::compact(&self.to_json("")).as_bytes());
        sum[..8].iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The schema.json text, without the trailing newline.
    pub fn marshal_indent(&self) -> String {
        json::indent(&self.to_json(&self.schema_hash))
    }

    /// Reads a schema.json produced by [`build`] and checks its hash.
    pub fn load(text: &str) -> Result<Manifest, String> {
        let m: Manifest = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let hash = m.hash();
        if hash != m.schema_hash {
            return Err(format!("schema.json was edited by hand: hash {} does not match content {hash}", m.schema_hash));
        }
        Ok(m)
    }

    #[doc(hidden)]
    pub fn to_json(&self, hash: &str) -> J {
        let order = if self.order.is_empty() { J::Null } else { json::strs(&self.order) };
        let mut o = Obj::new()
            .str("schema_hash", hash)
            .put("order", order)
            .put("entities", J::Obj(self.entities.iter().map(|(k, e)| (k.clone(), entity_json(e))).collect()));
        if !self.orm.is_empty() {
            o = o.put("orm", J::Arr(self.orm.iter().map(orm_json).collect()));
        }
        if !self.external_fks.is_empty() {
            o = o.put("external_fks", J::Arr(self.external_fks.iter().map(external_fk_json).collect()));
        }
        o = o.strs_omit("immutable", &self.immutable);
        if let Some(log) = &self.audit_log {
            o = o.put("audit_log", audit::audit_log_json(log));
        }
        if !self.audits.is_empty() {
            o = o.put("audits", J::Arr(self.audits.iter().map(audit::audit_json).collect()));
        }
        o.done()
    }
}

fn orm_json(x: &OrmDirective) -> J {
    let mut o = Obj::new().str("kind", &x.kind).str_omit("name", &x.name);
    if !x.args.is_empty() {
        o = o.put("args", J::Obj(x.args.iter().map(|(k, v)| (k.clone(), J::Str(v.clone()))).collect()));
    }
    o.str("raw", &x.raw).done()
}

fn external_fk_json(f: &ExternalFk) -> J {
    Obj::new()
        .str("entity", &f.entity)
        .strs("columns", &f.columns)
        .str("target_table", &f.target_table)
        .strs("target_columns", &f.target_columns)
        .str_omit("name", &f.name)
        .str_omit("on_delete", &f.on_delete)
        .bool_omit("deferred", f.deferred)
        .done()
}

fn lists(v: &[Vec<String>]) -> J {
    J::Arr(v.iter().map(|l| json::strs(l)).collect())
}

fn entity_json(e: &Entity) -> J {
    let mut o = Obj::new()
        .str("name", &e.name)
        .str("table", &e.table)
        .str_omit("renamed_from", &e.renamed_from)
        .str_omit("comment", &e.comment)
        .strs("pk", &e.pk)
        .str_omit("auto", &e.auto)
        .put("columns", J::Arr(e.columns.iter().map(col_json).collect()))
        .put("relations", J::Obj(e.relations.iter().map(|(k, r)| (k.clone(), rel_json(r))).collect()));
    if !e.unique.is_empty() {
        o = o.put("unique", lists(&e.unique));
    }
    if !e.indexes.is_empty() {
        o = o.put("indexes", J::Obj(e.indexes.iter().map(|(k, v)| (k.clone(), json::strs(v))).collect()));
    }
    if !e.fulltext.is_empty() {
        o = o.put("fulltext", lists(&e.fulltext));
    }
    if !e.checks.is_empty() {
        o = o.put("checks", J::Arr(e.checks.iter().map(|c| Obj::new().str("name", &c.name).str("expr", &c.expr).done()).collect()));
    }
    if let Some(ts) = &e.timestamps {
        o = o.put("timestamps", Obj::new().str_omit("created", &ts.created).str_omit("updated", &ts.updated).done());
    }
    o.str_omit("soft_delete", &e.soft_delete).str_omit("aes_version", &e.aes_version).done()
}

fn col_json(c: &Col) -> J {
    let mut o =
        Obj::new().str("name", &c.name).str_omit("renamed_from", &c.renamed_from).str("type", &c.typ).str("raw", &c.raw).bool_omit("nullable", c.nullable);
    if let Some(d) = &c.default {
        o = o.str("default", d);
    }
    o = o
        .bool_omit("auto", c.auto)
        .bool_omit("on_update", c.on_update)
        .bool_omit("unsigned", c.unsigned)
        .bool_omit("lazy", c.lazy)
        .int_omit("len", c.len)
        .int_omit("precision", c.precision)
        .int_omit("scale", c.scale)
        .strs_omit("enum", &c.r#enum)
        .strs_omit("styles", &c.styles)
        .str_omit("blind_index", &c.blind_index);
    if let Some(r) = &c.reference {
        o = o.put("ref", Obj::new().str("entity", &r.entity).str("column", &r.column).done());
    }
    o.bool_omit("pk", c.pk).bool_omit("fk", c.fk).bool_omit("uk", c.uk).str_omit("describe", &c.describe).str_omit("comment", &c.comment).done()
}

fn rel_json(r: &Rel) -> J {
    Obj::new()
        .str("name", &r.name)
        .str("kind", &r.kind)
        .str("target", &r.target)
        .put("keys", J::Arr(r.keys.iter().map(|k| Obj::new().str("local", &k.local).str("target", &k.target).done()).collect()))
        .str_omit("on_delete", &r.on_delete)
        .bool_omit("foreign_key", r.foreign_key)
        .done()
}

/// The `quoted` identifiers of an expression fragment.
fn backtick_names(frag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = frag;
    while let Some(i) = rest.find('`') {
        let Some(j) = rest[i + 1..].find('`') else { break };
        out.push(rest[i + 1..i + 1 + j].to_owned());
        rest = &rest[i + j + 2..];
    }
    out
}
