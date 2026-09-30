//! Exact physical FK interchange, independent of logical relationships.
use crate::physical_record::{object, RecordError, Validator};
use serde_json::Value;
use std::fmt;
#[derive(Clone, PartialEq)]
pub struct PhysicalForeignKey {
    value: Value,
}
impl fmt::Debug for PhysicalForeignKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PhysicalForeignKey")
    }
}
impl PhysicalForeignKey {
    pub fn from_value(value: Value) -> Result<Self, RecordError> {
        Self::validate(&value)?;
        Ok(Self { value })
    }
    pub(crate) fn validate(value: &Value) -> Result<(), RecordError> {
        let record = object(
            value,
            &["id", "name", "tableId", "columns", "target", "onDelete", "onUpdate", "match", "deferrable", "initiallyDeferred", "comment", "options"],
        )?;
        let mut v = Validator::new();
        v.id(&record["id"])?;
        v.id(&record["tableId"])?;
        if !record["name"].is_null() {
            let name = v.text(&record["name"], 1, 1024)?;
            crate::physical::PhysicalIdentity::new(None, None, name.to_owned(), None).map_err(|_| RecordError)?;
        }
        let local = v.ids(&record["columns"])?;
        let target = object(&record["target"], &["tableId", "columns"])?;
        v.id(&target["tableId"])?;
        let remote = v.ids(&target["columns"])?;
        if local.len() != remote.len() {
            return Err(RecordError);
        }
        for field in ["onDelete", "onUpdate"] {
            if !matches!(v.text(&record[field], 1, 16)?, "noAction" | "restrict" | "cascade" | "setNull" | "setDefault" | "unspecified") {
                return Err(RecordError);
            }
        }
        if !matches!(v.text(&record["match"], 1, 16)?, "simple" | "full" | "partial" | "unspecified") {
            return Err(RecordError);
        }
        for field in ["deferrable", "initiallyDeferred"] {
            if !record[field].is_null() && !record[field].is_boolean() {
                return Err(RecordError);
            }
        }
        if record["initiallyDeferred"].as_bool() == Some(true) && record["deferrable"].as_bool() != Some(true) {
            return Err(RecordError);
        }
        v.text(&record["comment"], 0, 8192)?;
        v.options(&record["options"])?;
        Ok(())
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
}
