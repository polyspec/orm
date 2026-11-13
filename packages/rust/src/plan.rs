//! The plan of a request (docs/spec/protocol.md §2).

use serde_json::{json, Map, Value};

use crate::{Error, Result};

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub manifest_hash: String,
    pub kind: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Default)]
pub struct Step {
    /// The plan-cache key of the plan this step belongs to (FNV-1a 64 of the IR shape bytes).
    pub plan_id: u64,
    pub id: u32,
    pub role: String,
    pub sql: String,
    /// A table the statement uses by name: the physical table name, sorted and deduplicated.
    pub tables: Vec<String>,
    pub lock: String,
    pub bind_slots: Vec<BindSlot>,
    pub assemble: Option<std::sync::Arc<Assemble>>,
    /// Relation steps: where the IN values come from.
    pub parent: Option<ParentRef>,
}

#[derive(Debug, Clone, Default)]
pub struct ParentRef {
    pub step: u32,
    pub keys: Vec<KeyRef>,
    pub if_parent: Option<IfParent>,
}

#[derive(Debug, Clone, Default)]
pub struct KeyRef {
    pub column: String,
    pub index: usize,
}

#[derive(Debug, Clone, Default)]
pub struct IfParent {
    pub column: String,
    pub index: usize,
    pub param: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BindSlot {
    pub from: String,
    pub param: usize,
    pub transform: String,
    pub name: String,
    pub step: u32,
    pub column: String,
    /// Style stages the dialect leaves to the executor for this value (aes/hex/ip on
    /// PostgreSQL/SQLite), applied to the bound value in write order. Empty on MySQL.
    pub host_styles: Vec<String>,
    /// The dbspec type of the value the placeholder takes (BindSlot.ColType in engine/plan/plan.go). The parent
    /// slot carries `key_types` instead. A slot with no type does not exist.
    pub col_type: String,
    /// The dbspec type of the key values that the parent slot expands, in key column order.
    pub key_types: Vec<String>,
    pub precision: i64,
    pub scale: i64,
    /// The n of a varchar(n) slot: the value is at most n characters.
    pub length: i64,
    /// The value an assignment slot writes to the non-null column `column`: a NULL value is CODEC_ENCODE before any statement.
    pub not_null: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Assemble {
    pub entity: String,
    pub alias: String,
    pub columns: Vec<OutCol>,
    pub key: Vec<KeyRef>,
    pub children: Vec<Child>,
    /// The position in `columns` holding the key version, for a node that reads an AES column.
    pub aes_version: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct OutCol {
    pub index: usize,
    pub name: String,
    pub column: String,
    pub typ: String,
    pub styles: Vec<String>,
    pub hidden: bool,
    /// The integer or decimal column that a scalar subquery sums (PRT-84).
    pub sum_of: Option<String>,
    /// The precision and scale of the decimal column of a scalar subquery, whose value is its exact decimal text of that
    /// scale (INT-160); a sum states no precision, since it leaves the precision of its column.
    pub precision: Option<u8>,
    pub scale: Option<u8>,
    /// The cells of the sums of the four 16-bit parts of that column, highest first, and the cell that reports a value that
    /// is not an integer, on SQLite and markdown (DIA-218, PRT-84).
    pub sum_parts: Vec<usize>,
    pub non_integer: Option<usize>,
}

impl OutCol {
    /// The number of cells of the row that the column reads: one, or the cells of a split sum (DIA-218).
    pub fn cells(&self) -> usize {
        if self.sum_parts.is_empty() {
            1
        } else {
            self.sum_parts.len() + usize::from(self.non_integer.is_some())
        }
    }
}

/// A joined entity's slice of the same row (kind join, `assemble` set) or a
/// relation step's rows attached by key (kind one/many, `step` set).
#[derive(Debug, Clone, Default)]
pub struct Child {
    pub rel: String,
    pub kind: String,
    pub step: u32,
    pub parent_keys: Vec<KeyRef>,
    pub child_keys: Vec<KeyRef>,
    pub key: Vec<KeyRef>,
    pub flatten: bool,
    /// The related rows hold this row's PK as their FK and no_cascade_delete was
    /// not set: delete_cascade removes them before this row.
    pub cascade: bool,
    pub assemble: Option<std::sync::Arc<Assemble>>,
}

impl Assemble {
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.columns.iter().find(|c| c.name == name).map(|c| c.index)
    }

    /// Width of one positional row: the cells of this node's columns plus its joins'.
    pub fn total_columns(&self) -> usize {
        self.columns.iter().map(OutCol::cells).sum::<usize>()
            + self.children.iter().filter_map(|c| c.assemble.as_ref()).map(|a| a.total_columns()).sum::<usize>()
    }

    /// Whether this node loads relation `rel` (a join or a relation child).
    pub fn has_child(&self, rel: &str) -> bool {
        self.children.iter().any(|c| c.rel == rel)
    }

    /// The child spec of relation `rel`.
    pub fn child(&self, rel: &str) -> Option<&Child> {
        self.children.iter().find(|c| c.rel == rel)
    }
}

// The JSON form of a plan (docs/spec/flowmark-surface.md FMS-40, `contracts/interface/flowmark/plan.schema.json`): the
// members are the tags of legacy/packages/go/engine/plan/plan.go, and a member that the form leaves out is absent when
// it is zero, false, empty or not set.

/// Writes the member `key` when `text` is not empty.
fn put_text(out: &mut Map<String, Value>, key: &str, text: &str) {
    if !text.is_empty() {
        out.insert(key.to_owned(), Value::from(text));
    }
}

/// Writes the member `key` when `list` is not empty.
fn put_list(out: &mut Map<String, Value>, key: &str, list: Vec<Value>) {
    if !list.is_empty() {
        out.insert(key.to_owned(), Value::Array(list));
    }
}

/// Writes the member `key` when `number` is not 0.
fn put_number(out: &mut Map<String, Value>, key: &str, number: impl Into<Value> + PartialEq + Default) {
    if number != Default::default() {
        out.insert(key.to_owned(), number.into());
    }
}

/// Writes the member `key` when `flag` is true.
fn put_flag(out: &mut Map<String, Value>, key: &str, flag: bool) {
    if flag {
        out.insert(key.to_owned(), Value::from(true));
    }
}

fn texts(list: &[String]) -> Vec<Value> {
    list.iter().map(|text| Value::from(text.as_str())).collect()
}

fn key_refs(keys: &[KeyRef]) -> Vec<Value> {
    keys.iter().map(|key| json!({"column": key.column, "index": key.index})).collect()
}

impl Plan {
    /// The form of the plan (FMS-40).
    pub fn to_json(&self) -> Value {
        json!({"manifest_hash": self.manifest_hash, "kind": self.kind, "steps": self.steps.iter().map(Step::to_json).collect::<Vec<Value>>()})
    }
}

impl Step {
    /// The form of the step (FMS-40): its fields but `plan_id`, which is no member.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), Value::from(self.id));
        out.insert("role".into(), Value::from(self.role.as_str()));
        out.insert("sql".into(), Value::from(self.sql.as_str()));
        out.insert("tables".into(), Value::Array(texts(&self.tables)));
        put_text(&mut out, "lock", &self.lock);
        out.insert("bind_slots".into(), Value::Array(self.bind_slots.iter().map(BindSlot::to_json).collect()));
        if let Some(assemble) = &self.assemble {
            out.insert("assemble".into(), assemble.to_json());
        }
        if let Some(parent) = &self.parent {
            let mut from = Map::new();
            from.insert("step".into(), Value::from(parent.step));
            from.insert("keys".into(), Value::Array(key_refs(&parent.keys)));
            if let Some(if_parent) = &parent.if_parent {
                from.insert("if_parent".into(), json!({"column": if_parent.column, "index": if_parent.index, "param": if_parent.param}));
            }
            out.insert("parent".into(), Value::Object(from));
        }
        Value::Object(out)
    }

    /// The step of its form (FMS-42), with `plan_id` 0. A value that is no step of the form is `config`, with a message
    /// that names the member.
    pub fn from_json(value: &Value) -> Result<Step> {
        read::step(value).map_err(Error::config)
    }
}

impl BindSlot {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("from".into(), Value::from(self.from.as_str()));
        out.insert("param".into(), Value::from(self.param));
        put_text(&mut out, "transform", &self.transform);
        put_text(&mut out, "name", &self.name);
        put_number(&mut out, "step", self.step);
        put_text(&mut out, "column", &self.column);
        put_list(&mut out, "host_styles", texts(&self.host_styles));
        put_text(&mut out, "col_type", &self.col_type);
        put_list(&mut out, "key_types", texts(&self.key_types));
        put_number(&mut out, "precision", self.precision);
        put_number(&mut out, "scale", self.scale);
        put_number(&mut out, "length", self.length);
        put_flag(&mut out, "not_null", self.not_null);
        Value::Object(out)
    }
}

impl Assemble {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("entity".into(), Value::from(self.entity.as_str()));
        out.insert("alias".into(), Value::from(self.alias.as_str()));
        out.insert("columns".into(), Value::Array(self.columns.iter().map(OutCol::to_json).collect()));
        if let Some(position) = self.aes_version {
            out.insert("aes_version".into(), Value::from(position));
        }
        put_list(&mut out, "children", self.children.iter().map(Child::to_json).collect());
        out.insert("key".into(), Value::Array(key_refs(&self.key)));
        Value::Object(out)
    }
}

impl OutCol {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("index".into(), Value::from(self.index));
        out.insert("name".into(), Value::from(self.name.as_str()));
        put_text(&mut out, "column", &self.column);
        out.insert("type".into(), Value::from(self.typ.as_str()));
        put_list(&mut out, "styles", texts(&self.styles));
        put_flag(&mut out, "hidden", self.hidden);
        if let Some(column) = &self.sum_of {
            out.insert("sum_of".into(), Value::from(column.as_str()));
        }
        if let Some(precision) = self.precision {
            out.insert("precision".into(), Value::from(precision));
        }
        if let Some(scale) = self.scale {
            out.insert("scale".into(), Value::from(scale));
        }
        put_list(&mut out, "sum_parts", self.sum_parts.iter().map(|cell| Value::from(*cell)).collect());
        if let Some(cell) = self.non_integer {
            out.insert("non_integer".into(), Value::from(cell));
        }
        Value::Object(out)
    }
}

impl Child {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("rel".into(), Value::from(self.rel.as_str()));
        out.insert("kind".into(), Value::from(self.kind.as_str()));
        put_number(&mut out, "step", self.step);
        put_list(&mut out, "parent_keys", key_refs(&self.parent_keys));
        put_list(&mut out, "child_keys", key_refs(&self.child_keys));
        put_list(&mut out, "key", key_refs(&self.key));
        put_flag(&mut out, "flatten", self.flatten);
        put_flag(&mut out, "cascade", self.cascade);
        if let Some(assemble) = &self.assemble {
            out.insert("assemble".into(), assemble.to_json());
        }
        Value::Object(out)
    }
}

/// The readers of the form of a step. A refusal is a text that names the member.
mod read {
    use std::sync::Arc;

    use serde_json::{Map, Value};

    use super::{Assemble, BindSlot, Child, IfParent, KeyRef, OutCol, ParentRef, Step};

    type Members = Map<String, Value>;

    /// The members of the object `value`; a value that is no object and a member outside `allowed` are refused.
    fn object<'v>(value: &'v Value, at: &str, allowed: &[&str]) -> Result<&'v Members, String> {
        let Value::Object(members) = value else { return Err(format!("{at} is no object")) };
        match members.keys().find(|key| !allowed.contains(&key.as_str())) {
            Some(key) => Err(format!("{at}.{key} is no member of the form")),
            None => Ok(members),
        }
    }

    fn required<'v>(members: &'v Members, at: &str, key: &str) -> Result<&'v Value, String> {
        members.get(key).ok_or_else(|| format!("{at}.{key} is absent"))
    }

    fn text_of(value: &Value, at: &str) -> Result<String, String> {
        value.as_str().map(str::to_owned).ok_or_else(|| format!("{at} is no text"))
    }

    fn text(members: &Members, at: &str, key: &str) -> Result<String, String> {
        text_of(required(members, at, key)?, &format!("{at}.{key}"))
    }

    /// The text of the member `key`, empty when it is absent.
    fn optional_text(members: &Members, at: &str, key: &str) -> Result<String, String> {
        members.get(key).map_or(Ok(String::new()), |value| text_of(value, &format!("{at}.{key}")))
    }

    /// One of the texts `allowed` of the member `key`.
    fn word(members: &Members, at: &str, key: &str, allowed: &[&str]) -> Result<String, String> {
        let written = text(members, at, key)?;
        if allowed.contains(&written.as_str()) {
            Ok(written)
        } else {
            Err(format!("{at}.{key} {written} is none of {}", allowed.join(", ")))
        }
    }

    fn index_of(value: &Value, at: &str) -> Result<usize, String> {
        let refusal = || format!("{at} is no integer from 0");
        usize::try_from(value.as_u64().ok_or_else(refusal)?).map_err(|_too_large| refusal())
    }

    fn index(members: &Members, at: &str, key: &str) -> Result<usize, String> {
        index_of(required(members, at, key)?, &format!("{at}.{key}"))
    }

    fn optional_index(members: &Members, at: &str, key: &str) -> Result<Option<usize>, String> {
        members.get(key).map(|value| index_of(value, &format!("{at}.{key}"))).transpose()
    }

    /// The number of a step: the member `key`, 0 when `absent` and it is absent.
    fn step_number(members: &Members, at: &str, key: &str, absent: bool) -> Result<u32, String> {
        let number = match (members.get(key), absent) {
            (None, true) => return Ok(0),
            (None, false) => return Err(format!("{at}.{key} is absent")),
            (Some(value), _) => index_of(value, &format!("{at}.{key}"))?,
        };
        u32::try_from(number).map_err(|_too_large| format!("{at}.{key} {number} is above 4294967295"))
    }

    /// A size of a bind slot: the member `key`, 0 when it is absent.
    fn size(members: &Members, at: &str, key: &str) -> Result<i64, String> {
        match optional_index(members, at, key)? {
            Some(number) => i64::try_from(number).map_err(|_too_large| format!("{at}.{key} {number} is above 9223372036854775807")),
            None => Ok(0),
        }
    }

    /// A precision or a scale of an output column: the member `key`, from 0 to 255.
    fn small(members: &Members, at: &str, key: &str) -> Result<Option<u8>, String> {
        match optional_index(members, at, key)? {
            Some(number) => u8::try_from(number).map(Some).map_err(|_too_large| format!("{at}.{key} {number} is above 255")),
            None => Ok(None),
        }
    }

    fn flag(members: &Members, at: &str, key: &str) -> Result<bool, String> {
        match members.get(key) {
            None => Ok(false),
            Some(Value::Bool(flag)) => Ok(*flag),
            Some(_) => Err(format!("{at}.{key} is no boolean")),
        }
    }

    /// The items of the list member `key`, each read by `read` with its place; an absent member is refused unless
    /// `absent`, which reads it as the empty list.
    fn list<T>(members: &Members, at: &str, key: &str, absent: bool, read: impl Fn(&Value, &str) -> Result<T, String>) -> Result<Vec<T>, String> {
        match (members.get(key), absent) {
            (None, true) => Ok(Vec::new()),
            (None, false) => Err(format!("{at}.{key} is absent")),
            (Some(Value::Array(items)), _) => items.iter().enumerate().map(|(place, item)| read(item, &format!("{at}.{key}[{place}]"))).collect(),
            (Some(_), _) => Err(format!("{at}.{key} is no list")),
        }
    }

    fn key_ref(value: &Value, at: &str) -> Result<KeyRef, String> {
        let members = object(value, at, &["column", "index"])?;
        Ok(KeyRef { column: text(members, at, "column")?, index: index(members, at, "index")? })
    }

    pub(super) fn step(value: &Value) -> Result<Step, String> {
        let at = "step";
        let members = object(value, at, &["id", "role", "sql", "tables", "lock", "bind_slots", "assemble", "parent"])?;
        let parent = match members.get("parent") {
            Some(value) => {
                let at = "step.parent";
                let members = object(value, at, &["step", "keys", "if_parent"])?;
                let if_parent = match members.get("if_parent") {
                    Some(value) => {
                        let at = "step.parent.if_parent";
                        let members = object(value, at, &["column", "index", "param"])?;
                        Some(IfParent { column: text(members, at, "column")?, index: index(members, at, "index")?, param: index(members, at, "param")? })
                    }
                    None => None,
                };
                Some(ParentRef { step: step_number(members, at, "step", false)?, keys: list(members, at, "keys", false, key_ref)?, if_parent })
            }
            None => None,
        };
        Ok(Step {
            plan_id: 0,
            id: step_number(members, at, "id", false)?,
            role: word(members, at, "role", &["main", "count", "relation"])?,
            sql: text(members, at, "sql")?,
            tables: list(members, at, "tables", false, text_of)?,
            lock: optional_text(members, at, "lock")?,
            bind_slots: list(members, at, "bind_slots", false, bind_slot)?,
            assemble: members.get("assemble").map(|value| assemble(value, "step.assemble").map(Arc::new)).transpose()?,
            parent,
        })
    }

    fn bind_slot(value: &Value, at: &str) -> Result<BindSlot, String> {
        let members = object(
            value,
            at,
            &["from", "param", "transform", "name", "step", "column", "host_styles", "col_type", "key_types", "precision", "scale", "length", "not_null"],
        )?;
        Ok(BindSlot {
            from: word(members, at, "from", &["param", "config", "parent", "now", "audit"])?,
            param: index(members, at, "param")?,
            transform: optional_text(members, at, "transform")?,
            name: optional_text(members, at, "name")?,
            step: step_number(members, at, "step", true)?,
            column: optional_text(members, at, "column")?,
            host_styles: list(members, at, "host_styles", true, text_of)?,
            col_type: optional_text(members, at, "col_type")?,
            key_types: list(members, at, "key_types", true, text_of)?,
            precision: size(members, at, "precision")?,
            scale: size(members, at, "scale")?,
            length: size(members, at, "length")?,
            not_null: flag(members, at, "not_null")?,
        })
    }

    fn assemble(value: &Value, at: &str) -> Result<Assemble, String> {
        let members = object(value, at, &["entity", "alias", "columns", "aes_version", "children", "key"])?;
        Ok(Assemble {
            entity: text(members, at, "entity")?,
            alias: text(members, at, "alias")?,
            columns: list(members, at, "columns", false, out_col)?,
            key: list(members, at, "key", false, key_ref)?,
            children: list(members, at, "children", true, child)?,
            aes_version: optional_index(members, at, "aes_version")?,
        })
    }

    fn out_col(value: &Value, at: &str) -> Result<OutCol, String> {
        let members = object(value, at, &["index", "name", "column", "type", "styles", "hidden", "sum_of", "precision", "scale", "sum_parts", "non_integer"])?;
        Ok(OutCol {
            index: index(members, at, "index")?,
            name: text(members, at, "name")?,
            column: optional_text(members, at, "column")?,
            typ: text(members, at, "type")?,
            styles: list(members, at, "styles", true, text_of)?,
            hidden: flag(members, at, "hidden")?,
            sum_of: members.get("sum_of").map(|value| text_of(value, &format!("{at}.sum_of"))).transpose()?,
            precision: small(members, at, "precision")?,
            scale: small(members, at, "scale")?,
            sum_parts: list(members, at, "sum_parts", true, index_of)?,
            non_integer: optional_index(members, at, "non_integer")?,
        })
    }

    fn child(value: &Value, at: &str) -> Result<Child, String> {
        let members = object(value, at, &["rel", "kind", "step", "parent_keys", "child_keys", "key", "flatten", "cascade", "assemble"])?;
        Ok(Child {
            rel: text(members, at, "rel")?,
            kind: word(members, at, "kind", &["join", "one", "many"])?,
            step: step_number(members, at, "step", true)?,
            parent_keys: list(members, at, "parent_keys", true, key_ref)?,
            child_keys: list(members, at, "child_keys", true, key_ref)?,
            key: list(members, at, "key", true, key_ref)?,
            flatten: flag(members, at, "flatten")?,
            cascade: flag(members, at, "cascade")?,
            assemble: members.get("assemble").map(|value| assemble(value, &format!("{at}.assemble")).map(Arc::new)).transpose()?,
        })
    }
}
