//! Collections of models and pages.

use std::any::Any;
use std::collections::HashMap;

use crate::model::{AnyModel, Model};
use crate::value::{Param, Val};
use crate::Result;

/// A collection key. The integer 7 and the text "7" are different keys.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Key {
    I(i64),
    S(String),
}

impl Key {
    pub fn of(v: &Val) -> Result<Key> {
        Ok(match v {
            Val::I64(x) => Key::I(*x),
            Val::Bool(b) => Key::I(*b as i64),
            other => Key::S(other.as_string()?),
        })
    }

    pub fn of_row(row: &[Val], refs: &[crate::plan::KeyRef]) -> Result<Option<Key>> {
        let mut values = Vec::with_capacity(refs.len());
        for r in refs {
            let v = &row[r.index];
            if v.is_null() {
                return Ok(None);
            }
            values.push(v.clone());
        }
        Key::of_values(&values).map(Some)
    }

    pub fn of_values(values: &[Val]) -> Result<Key> {
        if values.len() == 1 {
            return Key::of(&values[0]);
        }
        let mut out = String::new();
        for value in values {
            let part = match value {
                Val::Bool(b) => (*b as i64).to_string(),
                other => other.as_string()?,
            };
            out.push_str(&format!("{}:{}", part.len(), part));
        }
        Ok(Key::S(out))
    }

    /// The key as JSON: a number or a string.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Key::I(x) => serde_json::json!(x),
            Key::S(s) => serde_json::json!(s),
        }
    }
}

impl From<i64> for Key {
    fn from(v: i64) -> Key {
        Key::I(v)
    }
}

impl From<i32> for Key {
    fn from(v: i32) -> Key {
        Key::I(v as i64)
    }
}

impl From<&str> for Key {
    fn from(v: &str) -> Key {
        Key::S(v.to_owned())
    }
}

impl From<String> for Key {
    fn from(v: String) -> Key {
        Key::S(v)
    }
}

impl From<Param> for Key {
    fn from(v: Param) -> Key {
        match v {
            Param::I64(x) => Key::I(x),
            Param::Bool(b) => Key::I(b as i64),
            Param::Str(s) => Key::S(s),
            other => Key::S(format!("{other:?}")),
        }
    }
}

impl std::fmt::Display for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Key::I(x) => write!(f, "{x}"),
            Key::S(s) => write!(f, "{s}"),
        }
    }
}

/// An ordered set of models keyed by primary key, key column, or key callback.
/// A later model with the same key replaces the earlier one.
#[derive(Clone)]
pub struct Collection<M> {
    pub(crate) keys: Vec<Key>,
    pub(crate) items: HashMap<Key, M>,
    pub(crate) fetched: HashMap<Key, serde_json::Value>,
}

impl<M> Default for Collection<M> {
    fn default() -> Self {
        Collection { keys: Vec::new(), items: HashMap::new(), fetched: HashMap::new() }
    }
}

impl<M: Model> Collection<M> {
    pub(crate) fn put(&mut self, k: Key, v: M) {
        if !self.items.contains_key(&k) {
            self.keys.push(k.clone());
        }
        self.items.insert(k, v);
    }

    /// Builds a typed collection from assembled models. Generated entities use it.
    pub fn from_boxes(items: crate::model::Boxed, fetched: HashMap<Key, serde_json::Value>) -> Self {
        let mut out = Collection { fetched, ..Default::default() };
        for (k, m) in items {
            let m = *m.into_any().downcast::<M>().expect("collection model type");
            out.put(k, m);
        }
        out
    }

    /// The number of models.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// The model with the key.
    pub fn get(&self, key: impl Into<Key>) -> Option<&M> {
        self.items.get(&key.into())
    }

    /// The first model.
    pub fn first(&self) -> Option<&M> {
        self.keys.first().and_then(|k| self.items.get(k))
    }

    /// The keys in order.
    pub fn keys(&self) -> &[Key] {
        &self.keys
    }

    /// The keys and models in order.
    pub fn iter(&self) -> impl Iterator<Item = (&Key, &M)> {
        self.keys.iter().map(|k| (k, &self.items[k]))
    }

    /// The models in order.
    pub fn models(&self) -> impl Iterator<Item = &M> {
        self.keys.iter().map(|k| &self.items[k])
    }

    /// The models in order, by value.
    pub fn into_vec(mut self) -> Vec<M> {
        let keys = std::mem::take(&mut self.keys);
        keys.iter().filter_map(|k| self.items.remove(k)).collect()
    }

    /// The fetch_value result of the key.
    pub fn fetched_value(&self, key: impl Into<Key>) -> Option<&serde_json::Value> {
        self.fetched.get(&key.into())
    }

    /// Sets the connection of every model.
    pub fn connect(mut self, db: &crate::Db) -> Self {
        for m in self.items.values_mut() {
            m.core_mut().connect(db);
        }
        self
    }

    /// Deletes every model in one transaction; `delete(true)` first deletes
    /// loaded related rows.
    pub async fn delete(&self, recursive: bool) -> Result<()> {
        let Some(first) = self.first() else { return Ok(()) };
        let conn = first.core().conn.clone();
        crate::model::in_transaction(&conn, async || {
            for m in self.models() {
                crate::model::delete_row(m, recursive).await?;
            }
            Ok(())
        })
        .await
    }

    /// The JSON text of the models: an array of the models' JSON output.
    pub fn to_json(&self) -> crate::Result<String> {
        Ok(format!("[{}]", self.models().map(|m| crate::model::to_json(m)).collect::<crate::Result<Vec<_>>>()?.join(",")))
    }

    /// The models as arrays; CODEC_ENCODE when a value has no serde_json form.
    pub fn to_array(&self) -> crate::Result<serde_json::Value> {
        Ok(serde_json::Value::Array(self.models().map(|m| crate::model::to_array(m)).collect::<crate::Result<_>>()?))
    }
}

/// A collection seen without its model type.
pub trait AnyCollection: Any + Send + Sync {
    fn models_dyn(&self) -> Vec<&dyn AnyModel>;
    fn as_any(&self) -> &dyn Any;
    fn to_array_dyn(&self) -> crate::Result<serde_json::Value>;
    fn to_json_dyn(&self) -> crate::Result<String>;
}

impl<M: Model> AnyCollection for Collection<M> {
    fn models_dyn(&self) -> Vec<&dyn AnyModel> {
        self.models().map(|m| m as &dyn AnyModel).collect()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn to_array_dyn(&self) -> crate::Result<serde_json::Value> {
        self.to_array()
    }

    fn to_json_dyn(&self) -> crate::Result<String> {
        self.to_json()
    }
}

impl<M: Model> serde::Serialize for Collection<M> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        crate::model::raw_json(self.to_json()).map_err(serde::ser::Error::custom)?.serialize(s)
    }
}

/// One page of a collection.
pub struct Page<M> {
    pub items: Collection<M>,
    pub total_count: i64,
    pub total_pages: i64,
    pub page: u32,
    pub per_page: u32,
}

/// One grouped result with exactly the selected grouping values and its count.
#[derive(Clone)]
pub struct GroupRow {
    values: Vec<(String, Val)>,
    count: i64,
}

impl GroupRow {
    pub(crate) fn new(values: Vec<(String, Val)>) -> Result<Self> {
        let mut names = std::collections::HashSet::new();
        for (name, _) in &values {
            if !names.insert(name) {
                return Err(crate::Error::Config(format!("group result repeats column {name}")));
            }
        }
        let count = values.iter().find(|(name, _)| name == "row_count").ok_or_else(|| crate::Error::internal("group result has no row_count"))?.1.as_i64()?;
        if count < 0 {
            return Err(crate::Error::internal("group result has a negative row_count"));
        }
        Ok(Self { values, count })
    }

    pub fn count(&self) -> i64 {
        self.count
    }

    pub fn value(&self, name: &str) -> Result<&Val> {
        self.values
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
            .ok_or_else(|| crate::Error::Engine { code: crate::codes::COLUMN_UNSELECTED.into(), msg: format!("group result has no selected column {name}") })
    }

    pub fn to_array(&self) -> Result<serde_json::Value> {
        let mut values = serde_json::Map::new();
        for (name, value) in &self.values {
            values.insert(name.clone(), value.to_json()?);
        }
        Ok(serde_json::Value::Object(values))
    }

    pub fn to_json(&self) -> Result<String> {
        let mut parts = Vec::with_capacity(self.values.len());
        for (name, value) in &self.values {
            let text = match value {
                Val::Ordered(value) => value.compact(),
                other => other.to_json()?.to_string(),
            };
            parts.push(format!("{}:{text}", serde_json::Value::String(name.clone())));
        }
        Ok(format!("{{{}}}", parts.join(",")))
    }
}

/// Grouped results contain grouping values and row counts, never partial models.
#[derive(Clone, Default)]
pub struct GroupRows {
    rows: Vec<GroupRow>,
}

impl GroupRows {
    pub(crate) fn new(rows: Vec<GroupRow>) -> Self {
        Self { rows }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &GroupRow> {
        self.rows.iter()
    }

    pub fn to_array(&self) -> Result<serde_json::Value> {
        Ok(serde_json::Value::Array(self.rows.iter().map(GroupRow::to_array).collect::<Result<Vec<_>>>()?))
    }

    pub fn to_json(&self) -> Result<String> {
        Ok(format!("[{}]", self.rows.iter().map(GroupRow::to_json).collect::<Result<Vec<_>>>()?.join(",")))
    }
}

impl serde::Serialize for GroupRows {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        crate::model::raw_json(self.to_json()).map_err(serde::ser::Error::custom)?.serialize(serializer)
    }
}

#[cfg(test)]
mod group_tests {
    use super::{GroupRow, GroupRows, Val};

    #[test]
    fn grouped_rows_contain_only_group_values_and_checked_counts() {
        let row = GroupRow::new(vec![("is_close".into(), Val::Bool(false)), ("row_count".into(), Val::I64(3))]).unwrap();
        assert_eq!(row.count(), 3);
        assert_eq!(row.value("is_close").unwrap(), &Val::Bool(false));
        assert_eq!(row.value("name").unwrap_err().code(), crate::codes::COLUMN_UNSELECTED);
        let nullable = GroupRow::new(vec![("name".into(), Val::Null), ("row_count".into(), Val::I64(0))]).unwrap();
        assert_eq!(nullable.value("name").unwrap(), &Val::Null);
        let groups = GroupRows::new(vec![row]);
        assert_eq!(groups.to_json().unwrap(), r#"[{"is_close":false,"row_count":3}]"#);
        assert_eq!(groups.to_array().unwrap(), serde_json::json!([{"is_close": false, "row_count": 3}]));
        assert_eq!(GroupRow::new(vec![("row_count".into(), Val::I64(-1))]).err().unwrap().code(), "INTERNAL");
        assert_eq!(GroupRow::new(vec![("row_count".into(), Val::Str("invalid".into()))]).err().unwrap().code(), "CODEC_DECODE");
        assert_eq!(GroupRow::new(vec![("row_count".into(), Val::I64(1)), ("row_count".into(), Val::I64(2))]).err().unwrap().code(), "CONFIG");
    }
}
