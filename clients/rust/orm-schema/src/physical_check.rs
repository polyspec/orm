//! Structural CHECK interchange, not SQL execution permission.
use crate::physical_record::{object, RecordError, Validator};
use serde_json::Value;
use std::fmt;

#[derive(Clone, PartialEq)]
pub struct PhysicalCheck {
    value: Value,
}

impl fmt::Debug for PhysicalCheck {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PhysicalCheck")
    }
}

impl PhysicalCheck {
    pub fn from_value(value: Value) -> Result<Self, RecordError> {
        Self::validate(&value)?;
        Ok(Self { value })
    }

    pub(crate) fn validate(value: &Value) -> Result<(), RecordError> {
        let record = object(value, &["id", "name", "tableId", "expressionSql", "enforced", "validated", "comment", "options"])?;
        let mut validator = Validator::new();
        validator.id(&record["id"])?;
        validator.id(&record["tableId"])?;
        if !record["name"].is_null() {
            let name = validator.text(&record["name"], 1, 1024)?;
            crate::physical::PhysicalIdentity::new(None, None, name.to_owned(), None).map_err(|_| RecordError)?;
        }
        validator.text(&record["expressionSql"], 1, 16384)?;
        for field in ["enforced", "validated"] {
            if !record[field].is_null() && !record[field].is_boolean() {
                return Err(RecordError);
            }
        }
        validator.text(&record["comment"], 0, 8192)?;
        validator.options(&record["options"])?;
        Ok(())
    }

    pub fn value(&self) -> &Value {
        &self.value
    }
}
