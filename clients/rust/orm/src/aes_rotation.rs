use std::collections::BTreeMap;

use crate::value::Val;
use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct AesRotationColumn {
    pub name: String,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AesKeyring {
    keys: BTreeMap<i32, String>,
    pub current_version: i32,
}

impl AesKeyring {
    pub fn new(keys: BTreeMap<i32, String>, current_version: i32) -> Result<Self> {
        if keys.iter().any(|(version, key)| *version < 1 || key.is_empty()) {
            return Err(Error::Config("AES key list contains an invalid entry".into()));
        }
        if !keys.contains_key(&current_version) {
            return Err(Error::Config(format!("AES version {current_version} is not declared")));
        }
        Ok(Self { keys, current_version })
    }

    pub fn versions(&self) -> Vec<i32> { self.keys.keys().copied().collect() }

    /// Returns a copy after every AES column succeeds. The caller must persist
    /// all returned columns and the version in one database transaction.
    pub fn rotate_row<D, E>(
        &self,
        row: &BTreeMap<String, Val>,
        version_column: &str,
        columns: &[AesRotationColumn],
        target_version: i32,
        decode: D,
        encode: E,
    ) -> Result<BTreeMap<String, Val>>
    where
        D: Fn(&Val, &[String], &str) -> Result<Val>,
        E: Fn(&Val, &[String], &str) -> Result<Val>,
    {
        let old_version = match row.get(version_column) {
            Some(Val::I64(value)) if *value >= 1 && *value <= i32::MAX as i64 => *value as i32,
            _ => return Err(Error::Config("AES row version must be an integer".into())),
        };
        let old_key = self.keys.get(&old_version).ok_or_else(|| Error::Config(format!("AES version {old_version} is not declared")))?;
        let new_key = self.keys.get(&target_version).ok_or_else(|| Error::Config(format!("AES version {target_version} is not declared")))?;
        let mut out = row.clone();
        for column in columns {
            let value = row.get(&column.name).ok_or_else(|| Error::Config(format!("AES column {} is missing", column.name)))?;
            let plain = decode(value, &column.styles, old_key)?;
            out.insert(column.name.clone(), encode(&plain, &column.styles, new_key)?);
        }
        out.insert(version_column.to_owned(), Val::I64(target_version as i64));
        Ok(out)
    }
}
