//! Structural physical column interchange; never SQL execution permission.
use crate::physical_record::{object, RecordError, Validator};
use serde_json::Value;
use std::fmt;

#[derive(Clone, PartialEq)]
pub struct PhysicalColumn {
    value: Value,
}
impl fmt::Debug for PhysicalColumn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PhysicalColumn")
    }
}

impl PhysicalColumn {
    pub fn from_value(value: Value) -> Result<Self, RecordError> {
        let record = object(&value, &["id", "name", "typeSql", "nullable", "default", "generation", "comment", "options"])?;
        let mut validator = Validator::new();
        validator.id(&record["id"])?;
        let name = validator.text(&record["name"], 1, 1024)?;
        crate::physical::PhysicalIdentity::new(None, None, name.to_owned(), None).map_err(|_| RecordError)?;
        validator.text(&record["typeSql"], 1, 4096)?;
        record["nullable"].as_bool().ok_or(RecordError)?;
        validator.text(&record["comment"], 0, 8192)?;
        let default = &record["default"];
        match validator.text(&default["kind"], 1, 16)? {
            "absent" | "null" => {
                object(default, &["kind"])?;
            }
            "literal" | "expression" => {
                object(default, &["kind", "sql"])?;
                validator.text(&default["sql"], 1, 16384)?;
            }
            _ => return Err(RecordError),
        }
        let generation = &record["generation"];
        match validator.text(&generation["kind"], 1, 16)? {
            "none" => {
                object(generation, &["kind"])?;
            }
            "identity" => {
                object(generation, &["kind", "sql"])?;
                validator.text(&generation["sql"], 1, 16384)?;
            }
            "computed" => {
                object(generation, &["kind", "sql", "storage"])?;
                validator.text(&generation["sql"], 1, 16384)?;
                if !matches!(validator.text(&generation["storage"], 1, 16)?, "stored" | "virtual" | "unspecified") {
                    return Err(RecordError);
                }
            }
            _ => return Err(RecordError),
        }
        validator.options(&record["options"])?;
        Ok(Self { value })
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
}
