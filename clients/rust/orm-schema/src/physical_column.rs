//! Structural physical column interchange; never SQL execution permission.
use serde_json::{Map, Value};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColumnError;
impl fmt::Display for ColumnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SCHEMA_INVALID")
    }
}
impl std::error::Error for ColumnError {}

#[derive(Clone, PartialEq)]
pub struct PhysicalColumn {
    value: Value,
}
impl fmt::Debug for PhysicalColumn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PhysicalColumn")
    }
}

fn object<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>, ColumnError> {
    let object = value.as_object().ok_or(ColumnError)?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err(ColumnError);
    }
    Ok(object)
}
struct Validator {
    bytes: usize,
}
impl Validator {
    fn text<'a>(&mut self, value: &'a Value, min: usize, max: usize) -> Result<&'a str, ColumnError> {
        let text = value.as_str().ok_or(ColumnError)?;
        if text.len() < min || text.len() > max || text.contains('\0') {
            return Err(ColumnError);
        }
        self.bytes += text.len();
        if self.bytes > 65536 {
            return Err(ColumnError);
        }
        Ok(text)
    }
}
impl PhysicalColumn {
    pub fn from_value(value: Value) -> Result<Self, ColumnError> {
        let record = object(&value, &["id", "name", "typeSql", "nullable", "default", "generation", "comment", "options"])?;
        let mut validator = Validator { bytes: 0 };
        let id = validator.text(&record["id"], 1, 128)?;
        if !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) {
            return Err(ColumnError);
        }
        let name = validator.text(&record["name"], 1, 1024)?;
        crate::physical::PhysicalIdentity::new(None, None, name.to_owned(), None).map_err(|_| ColumnError)?;
        validator.text(&record["typeSql"], 1, 4096)?;
        record["nullable"].as_bool().ok_or(ColumnError)?;
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
            _ => return Err(ColumnError),
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
                    return Err(ColumnError);
                }
            }
            _ => return Err(ColumnError),
        }
        let options = record["options"].as_array().ok_or(ColumnError)?;
        if options.len() > 64 {
            return Err(ColumnError);
        }
        for option in options {
            let entry = object(option, &["name", "value"])?;
            validator.text(&entry["name"], 1, 128)?;
            validator.text(&entry["value"], 0, 4096)?;
        }
        Ok(Self { value })
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
}
