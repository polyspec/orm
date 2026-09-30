//! Structural index interchange, not SQL execution permission.
use crate::physical_record::{object, RecordError, Validator};
use serde_json::Value;
use std::fmt;

#[derive(Clone, PartialEq)]
pub struct PhysicalIndex {
    value: Value,
}

impl fmt::Debug for PhysicalIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PhysicalIndex")
    }
}

impl PhysicalIndex {
    pub fn from_value(value: Value) -> Result<Self, RecordError> {
        Self::validate(&value)?;
        Ok(Self { value })
    }

    pub(crate) fn validate(value: &Value) -> Result<(), RecordError> {
        let record = object(
            value,
            &["id", "name", "tableId", "unique", "methodSql", "terms", "include", "predicateSql", "nullsDistinct", "visible", "comment", "options"],
        )?;
        let mut v = Validator::new();
        v.id(&record["id"])?;
        v.id(&record["tableId"])?;
        if !record["name"].is_null() {
            let name = v.text(&record["name"], 1, 1024)?;
            crate::physical::PhysicalIdentity::new(None, None, name.to_owned(), None).map_err(|_| RecordError)?;
        }
        record["unique"].as_bool().ok_or(RecordError)?;
        for field in ["nullsDistinct", "visible"] {
            if !record[field].is_null() && !record[field].is_boolean() {
                return Err(RecordError);
            }
        }
        optional_text(&mut v, &record["methodSql"], 128)?;
        optional_text(&mut v, &record["predicateSql"], 16384)?;
        let terms = record["terms"].as_array().ok_or(RecordError)?;
        if terms.is_empty() || terms.len() > 64 {
            return Err(RecordError);
        }
        for value in terms {
            term(&mut v, value)?;
        }
        let included = record["include"].as_array().ok_or(RecordError)?;
        if included.len() > 64 {
            return Err(RecordError);
        }
        let mut seen = std::collections::HashSet::new();
        for value in included {
            if !seen.insert(v.id(value)?) {
                return Err(RecordError);
            }
        }
        v.text(&record["comment"], 0, 8192)?;
        v.options(&record["options"])?;
        Ok(())
    }

    pub fn value(&self) -> &Value {
        &self.value
    }
}

fn optional_text(v: &mut Validator, value: &Value, max: usize) -> Result<(), RecordError> {
    if !value.is_null() {
        v.text(value, 1, max)?;
    }
    Ok(())
}

fn term(v: &mut Validator, value: &Value) -> Result<(), RecordError> {
    let record = object(value, &["source", "order", "nulls", "collationSql", "operatorClassSql", "prefixLength"])?;
    let source = &record["source"];
    let kind = v.text(&source["kind"], 1, 16)?;
    match kind {
        "column" => {
            let source = object(source, &["kind", "columnId"])?;
            v.id(&source["columnId"])?;
        }
        "expression" => {
            let source = object(source, &["kind", "sql"])?;
            v.text(&source["sql"], 1, 16384)?;
        }
        _ => return Err(RecordError),
    }
    if !matches!(v.text(&record["order"], 1, 16)?, "asc" | "desc" | "unspecified") {
        return Err(RecordError);
    }
    if !matches!(v.text(&record["nulls"], 1, 16)?, "first" | "last" | "unspecified") {
        return Err(RecordError);
    }
    optional_text(v, &record["collationSql"], 1024)?;
    optional_text(v, &record["operatorClassSql"], 4096)?;
    if !record["prefixLength"].is_null() {
        let prefix = record["prefixLength"].as_f64().ok_or(RecordError)?;
        if kind != "column" || !(1.0..=2147483647.0).contains(&prefix) || prefix.fract() != 0.0 {
            return Err(RecordError);
        }
    }
    Ok(())
}
