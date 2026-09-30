//! Bounded physical nodes and FK membership, not full schema or SQL authority.
use crate::{
    physical::PhysicalIdentity,
    physical_column::PhysicalColumn,
    physical_foreign_key::PhysicalForeignKey,
    physical_record::{object, Validator},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fmt,
};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct GraphError {
    path: String,
}
impl GraphError {
    pub fn path(&self) -> &str {
        &self.path
    }
}
impl fmt::Display for GraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SCHEMA_INVALID")
    }
}
impl std::error::Error for GraphError {}
fn error(path: &str) -> GraphError {
    GraphError { path: path.to_owned() }
}
fn list<'a>(value: &'a Value, max: usize, min: usize, path: &str) -> Result<&'a [Value], GraphError> {
    let values = value.as_array().ok_or_else(|| error(path))?;
    if values.len() < min || values.len() > max {
        return Err(error(path));
    }
    Ok(values)
}
// Only bounded-depth validated record trees are counted.
fn string_bytes(value: &Value) -> usize {
    match value {
        Value::String(text) => text.len(),
        Value::Array(values) => values.iter().map(string_bytes).sum(),
        Value::Object(values) => values.values().map(string_bytes).sum(),
        _ => 0,
    }
}
fn reserve<'a>(ids: &mut HashSet<&'a str>, id: &'a str, path: &str) -> Result<(), GraphError> {
    if !ids.insert(id) {
        return Err(error(path));
    }
    Ok(())
}
fn budget(bytes: &mut usize, size: usize, path: &str) -> Result<(), GraphError> {
    *bytes += size;
    if *bytes > 16 * 1024 * 1024 {
        return Err(error(path));
    }
    Ok(())
}
#[derive(Clone, PartialEq)]
pub struct PhysicalGraph {
    value: Value,
}
impl fmt::Debug for PhysicalGraph {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PhysicalGraph")
    }
}
impl PhysicalGraph {
    pub fn from_value(value: Value) -> Result<Self, GraphError> {
        let root = object(&value, &["version", "dialect", "dialectVersion", "tables", "foreignKeys"]).map_err(|_| error(""))?;
        if root["version"].as_f64() != Some(1.0) {
            return Err(error("/version"));
        }
        let dialect = root["dialect"].as_str().filter(|v| matches!(*v, "mysql" | "postgres" | "sqlite")).ok_or_else(|| error("/dialect"))?;
        let version = Validator::new().text(&root["dialectVersion"], 1, 128).map_err(|_| error("/dialectVersion"))?;
        let tables = list(&root["tables"], 4096, 0, "/tables")?;
        let fks = list(&root["foreignKeys"], 20000, 0, "/foreignKeys")?;
        let (mut ids, mut identities, mut table_ids, mut owners) = (HashSet::new(), HashSet::new(), HashSet::new(), HashMap::new());
        let (mut bytes, mut columns_count) = (dialect.len() + version.len(), 0usize);
        for (index, input) in tables.iter().enumerate() {
            let path = format!("/tables/{index}");
            let table = object(input, &["id", "identity", "columns", "comment", "options"]).map_err(|_| error(&path))?;
            let mut v = Validator::new();
            let id = v.id(&table["id"]).map_err(|_| error(&format!("{path}/id")))?;
            reserve(&mut ids, id, &format!("{path}/id"))?;
            let identity_path = format!("{path}/identity");
            let parts = list(&table["identity"], 4, 4, &identity_path)?;
            if !parts[3].is_null() {
                return Err(error(&identity_path));
            }
            let optional = |value: &Value| -> Result<Option<String>, GraphError> {
                if value.is_null() {
                    Ok(None)
                } else {
                    value.as_str().map(|v| Some(v.to_owned())).ok_or_else(|| error(&identity_path))
                }
            };
            let name = parts[2].as_str().ok_or_else(|| error(&identity_path))?;
            let identity = PhysicalIdentity::new(optional(&parts[0])?, optional(&parts[1])?, name.to_owned(), None).map_err(|_| error(&identity_path))?;
            if !identities.insert(identity.key().to_owned()) {
                return Err(error(&identity_path));
            }
            table_ids.insert(id);
            let columns_path = format!("{path}/columns");
            let columns = list(&table["columns"], 4096, 1, &columns_path)?;
            columns_count += columns.len();
            if columns_count > 120000 {
                return Err(error(&columns_path));
            }
            let mut names = HashSet::new();
            for (j, column) in columns.iter().enumerate() {
                let cp = format!("{columns_path}/{j}");
                PhysicalColumn::validate(column).map_err(|_| error(&cp))?;
                let column_id = column["id"].as_str().expect("validated column ID");
                let name = column["name"].as_str().expect("validated column name");
                reserve(&mut ids, column_id, &format!("{cp}/id"))?;
                if !names.insert(name) {
                    return Err(error(&format!("{cp}/name")));
                }
                owners.insert(column_id, id);
                budget(&mut bytes, string_bytes(column), &cp)?;
            }
            v.text(&table["comment"], 0, 8192).map_err(|_| error(&format!("{path}/comment")))?;
            v.options(&table["options"]).map_err(|_| error(&format!("{path}/options")))?;
            let size = ["id", "identity", "comment", "options"].iter().map(|key| string_bytes(&table[*key])).sum();
            if size > 65536 {
                return Err(error(&path));
            }
            budget(&mut bytes, size, &path)?;
        }
        let mut names: HashMap<&str, HashSet<&str>> = HashMap::new();
        for (index, fk) in fks.iter().enumerate() {
            let path = format!("/foreignKeys/{index}");
            PhysicalForeignKey::validate(fk).map_err(|_| error(&path))?;
            let id = fk["id"].as_str().expect("validated FK ID");
            let source = fk["tableId"].as_str().expect("validated source ID");
            let target = fk["target"]["tableId"].as_str().expect("validated target ID");
            reserve(&mut ids, id, &format!("{path}/id"))?;
            if !table_ids.contains(source) {
                return Err(error(&format!("{path}/tableId")));
            }
            if !table_ids.contains(target) {
                return Err(error(&format!("{path}/target/tableId")));
            }
            let local = fk["columns"].as_array().expect("validated columns");
            let remote = fk["target"]["columns"].as_array().expect("validated target columns");
            for (j, column) in local.iter().enumerate() {
                if owners.get(column.as_str().expect("validated column ID")) != Some(&source) {
                    return Err(error(&format!("{path}/columns/{j}")));
                }
                if owners.get(remote[j].as_str().expect("validated target column ID")) != Some(&target) {
                    return Err(error(&format!("{path}/target/columns/{j}")));
                }
            }
            if let Some(name) = fk["name"].as_str() {
                if !names.entry(source).or_default().insert(name) {
                    return Err(error(&format!("{path}/name")));
                }
            }
            budget(&mut bytes, string_bytes(fk), &path)?;
        }
        Ok(Self { value })
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
}
