//! Reference resolution after root bounds and table/column validation.
use crate::{
    physical_check::PhysicalCheck,
    physical_graph::{budget, error, reserve, string_bytes, GraphError},
    physical_index::PhysicalIndex,
    physical_key::PhysicalKey,
};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

fn register<'a>(
    record: &'a Value,
    path: &str,
    ids: &mut HashSet<&'a str>,
    tables: &HashSet<&'a str>,
    names: &mut HashMap<&'a str, HashSet<&'a str>>,
) -> Result<(), GraphError> {
    let id = record["id"].as_str().expect("validated record ID");
    let table = record["tableId"].as_str().expect("validated table ID");
    reserve(ids, id, &format!("{path}/id"))?;
    if !tables.contains(table) {
        return Err(error(&format!("{path}/tableId")));
    }
    if let Some(name) = record["name"].as_str() {
        if !names.entry(table).or_default().insert(name) {
            return Err(error(&format!("{path}/name")));
        }
    }
    Ok(())
}

pub(crate) fn resolve<'a>(
    root: &'a Map<String, Value>,
    ids: &mut HashSet<&'a str>,
    tables: &HashSet<&'a str>,
    owners: &HashMap<&'a str, &'a str>,
    names: &mut HashMap<&'a str, HashSet<&'a str>>,
    bytes: &mut usize,
) -> Result<(), GraphError> {
    let mut by_id = HashMap::new();
    let mut index_names = HashMap::new();
    for (i, index) in root["indices"].as_array().expect("bounded indices").iter().enumerate() {
        let path = format!("/indices/{i}");
        PhysicalIndex::validate(index).map_err(|_| error(&path))?;
        register(index, &path, ids, tables, &mut index_names)?;
        let table = index["tableId"].as_str().expect("validated table ID");
        for (j, term) in index["terms"].as_array().expect("validated terms").iter().enumerate() {
            let source = &term["source"];
            if source["kind"] == "column" && owners.get(source["columnId"].as_str().expect("validated column ID")) != Some(&table) {
                return Err(error(&format!("{path}/terms/{j}/source/columnId")));
            }
        }
        for (j, column) in index["include"].as_array().expect("validated included columns").iter().enumerate() {
            if owners.get(column.as_str().expect("validated column ID")) != Some(&table) {
                return Err(error(&format!("{path}/include/{j}")));
            }
        }
        budget(bytes, string_bytes(index), &path)?;
        by_id.insert(index["id"].as_str().expect("validated index ID"), index);
    }
    let mut primary = HashSet::new();
    let mut linked = HashSet::new();
    for (i, key) in root["keys"].as_array().expect("bounded keys").iter().enumerate() {
        let path = format!("/keys/{i}");
        PhysicalKey::validate(key).map_err(|_| error(&path))?;
        register(key, &path, ids, tables, names)?;
        let table = key["tableId"].as_str().expect("validated table ID");
        for (j, column) in key["columns"].as_array().expect("validated key columns").iter().enumerate() {
            if owners.get(column.as_str().expect("validated column ID")) != Some(&table) {
                return Err(error(&format!("{path}/columns/{j}")));
            }
        }
        if key["kind"] == "primary" && !primary.insert(table) {
            return Err(error(&format!("{path}/kind")));
        }
        if let Some(index_id) = key["indexId"].as_str() {
            let index = by_id.get(index_id).ok_or_else(|| error(&format!("{path}/indexId")))?;
            if !linked.insert(index_id) || !matches(index, key) {
                return Err(error(&format!("{path}/indexId")));
            }
        }
        budget(bytes, string_bytes(key), &path)?;
    }
    for (i, check) in root["checks"].as_array().expect("bounded checks").iter().enumerate() {
        let path = format!("/checks/{i}");
        PhysicalCheck::validate(check).map_err(|_| error(&path))?;
        register(check, &path, ids, tables, names)?;
        budget(bytes, string_bytes(check), &path)?;
    }
    Ok(())
}

fn matches(index: &Value, key: &Value) -> bool {
    if index["tableId"] != key["tableId"]
        || !index["predicateSql"].is_null()
        || (key["withoutOverlaps"].as_bool() != Some(true) && index["unique"].as_bool() != Some(true))
    {
        return false;
    }
    let terms = index["terms"].as_array().expect("validated terms");
    let columns = key["columns"].as_array().expect("validated columns");
    if terms.len() != columns.len() {
        return false;
    }
    if terms.iter().zip(columns).any(|(term, column)| term["source"]["kind"] != "column" || term["source"]["columnId"] != *column) {
        return false;
    }
    key["nullsDistinct"].is_null() || index["nullsDistinct"].is_null() || key["nullsDistinct"] == index["nullsDistinct"]
}
