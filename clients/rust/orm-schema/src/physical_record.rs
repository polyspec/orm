//! Shared bounded physical-record validation.
use serde_json::{Map, Value};
use std::fmt;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordError;
impl fmt::Display for RecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SCHEMA_INVALID")
    }
}
impl std::error::Error for RecordError {}
pub(crate) fn object<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>, RecordError> {
    let object = value.as_object().ok_or(RecordError)?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err(RecordError);
    }
    Ok(object)
}
pub(crate) struct Validator {
    bytes: usize,
}
impl Validator {
    pub(crate) fn new() -> Self {
        Self { bytes: 0 }
    }
    pub(crate) fn text<'a>(&mut self, value: &'a Value, min: usize, max: usize) -> Result<&'a str, RecordError> {
        let text = value.as_str().ok_or(RecordError)?;
        if text.len() < min || text.len() > max || text.contains('\0') {
            return Err(RecordError);
        }
        self.bytes += text.len();
        if self.bytes > 65536 {
            return Err(RecordError);
        }
        Ok(text)
    }
    pub(crate) fn id<'a>(&mut self, value: &'a Value) -> Result<&'a str, RecordError> {
        let id = self.text(value, 1, 128)?;
        if !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')) {
            return Err(RecordError);
        }
        Ok(id)
    }
    pub(crate) fn ids<'a>(&mut self, value: &'a Value) -> Result<&'a [Value], RecordError> {
        let ids = value.as_array().ok_or(RecordError)?;
        if ids.is_empty() || ids.len() > 64 {
            return Err(RecordError);
        }
        let mut seen = std::collections::HashSet::new();
        for value in ids {
            if !seen.insert(self.id(value)?) {
                return Err(RecordError);
            }
        }
        Ok(ids)
    }
    pub(crate) fn options(&mut self, value: &Value) -> Result<(), RecordError> {
        let options = value.as_array().ok_or(RecordError)?;
        if options.len() > 64 {
            return Err(RecordError);
        }
        for option in options {
            let entry = object(option, &["name", "value"])?;
            self.text(&entry["name"], 1, 128)?;
            self.text(&entry["value"], 0, 4096)?;
        }
        Ok(())
    }
}
