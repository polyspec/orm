//! Structural primary/unique constraint interchange, not SQL authority.
use crate::physical_record::{object, RecordError, Validator};
use serde_json::Value;
use std::fmt;

#[derive(Clone, PartialEq)]
pub struct PhysicalKey {
    value: Value,
}

impl fmt::Debug for PhysicalKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PhysicalKey")
    }
}

impl PhysicalKey {
    pub fn from_value(value: Value) -> Result<Self, RecordError> {
        Self::validate(&value)?;
        Ok(Self { value })
    }

    pub(crate) fn validate(value: &Value) -> Result<(), RecordError> {
        let record = object(
            value,
            &[
                "id",
                "name",
                "tableId",
                "kind",
                "columns",
                "indexId",
                "deferrable",
                "initiallyDeferred",
                "nullsDistinct",
                "withoutOverlaps",
                "comment",
                "options",
            ],
        )?;
        let mut v = Validator::new();
        v.id(&record["id"])?;
        v.id(&record["tableId"])?;
        if !record["name"].is_null() {
            let name = v.text(&record["name"], 1, 1024)?;
            crate::physical::PhysicalIdentity::new(None, None, name.to_owned(), None).map_err(|_| RecordError)?;
        }
        let kind = v.text(&record["kind"], 1, 16)?;
        if !matches!(kind, "primary" | "unique") {
            return Err(RecordError);
        }
        v.ids(&record["columns"])?;
        if !record["indexId"].is_null() {
            v.id(&record["indexId"])?;
        }
        for field in ["deferrable", "initiallyDeferred", "nullsDistinct", "withoutOverlaps"] {
            if !record[field].is_null() && !record[field].is_boolean() {
                return Err(RecordError);
            }
        }
        if record["initiallyDeferred"].as_bool() == Some(true) && record["deferrable"].as_bool() != Some(true) {
            return Err(RecordError);
        }
        if kind == "primary" && !record["nullsDistinct"].is_null() {
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
