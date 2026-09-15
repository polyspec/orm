use std::collections::BTreeMap;

use crate::db::Exec;
use crate::plan::{BindSlot, Step};
use crate::row::read_row;
use crate::value::Param;
use crate::value::Val;
use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct AesRotationColumn {
    pub name: String,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AesRotationSpec {
    pub table: String,
    pub primary_keys: Vec<String>,
    pub version_column: String,
    pub columns: Vec<AesRotationColumn>,
    pub batch_size: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AesRotationStatus {
    pub current: i32,
    pub total: i64,
    pub pending: i64,
    pub versions: BTreeMap<i32, i64>,
}

#[derive(Debug, Clone)]
pub struct AesKeyring {
    keys: BTreeMap<i32, String>,
    pub current_version: i32,
}

impl AesKeyring {
    pub fn new(keys: BTreeMap<i32, String>, current_version: i32) -> Result<Self> {
        if keys
            .iter()
            .any(|(version, key)| *version < 1 || key.is_empty())
        {
            return Err(Error::Config(
                "AES key list contains an invalid entry".into(),
            ));
        }
        if !keys.contains_key(&current_version) {
            return Err(Error::Config(format!(
                "AES version {current_version} is not declared"
            )));
        }
        Ok(Self {
            keys,
            current_version,
        })
    }

    pub fn versions(&self) -> Vec<i32> {
        self.keys.keys().copied().collect()
    }

    pub fn key(&self, version: i32) -> Result<&str> {
        self.keys
            .get(&version)
            .map(String::as_str)
            .ok_or_else(|| Error::Config(format!("AES version {version} is not declared")))
    }

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
        let old_key = self
            .keys
            .get(&old_version)
            .ok_or_else(|| Error::Config(format!("AES version {old_version} is not declared")))?;
        let new_key = self.keys.get(&target_version).ok_or_else(|| {
            Error::Config(format!("AES version {target_version} is not declared"))
        })?;
        let mut out = row.clone();
        for column in columns {
            let value = row
                .get(&column.name)
                .ok_or_else(|| Error::Config(format!("AES column {} is missing", column.name)))?;
            let plain = decode(value, &column.styles, old_key)?;
            out.insert(
                column.name.clone(),
                encode(&plain, &column.styles, new_key)?,
            );
        }
        out.insert(version_column.to_owned(), Val::I64(target_version as i64));
        Ok(out)
    }
}

fn quote(driver: &str, value: &str) -> Result<String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
        || value.as_bytes()[0].is_ascii_digit()
    {
        return Err(Error::Config(format!(
            "invalid generated identifier {value}"
        )));
    }
    Ok(if driver == "mysql" {
        format!("`{value}`")
    } else {
        format!("\"{value}\"")
    })
}

fn placeholder(driver: &str, position: usize) -> String {
    if driver == "postgres" {
        format!("${position}")
    } else {
        "?".into()
    }
}
fn step(sql: String, binds: Vec<BindSlot>) -> Step {
    Step {
        plan_id: 0,
        id: 0,
        role: "aes_rotation".into(),
        sql,
        lock: String::new(),
        bind_slots: binds,
        assemble: None,
        parent: None,
    }
}
fn parameter(position: usize) -> BindSlot {
    BindSlot {
        from: "param".into(),
        param: position,
        transform: String::new(),
        name: String::new(),
        step: 0,
        column: String::new(),
        host_styles: vec![],
        col_type: String::new(),
    }
}
fn param(value: &Val) -> Result<Param> {
    Ok(match value {
        Val::Null => Param::Null,
        Val::I64(v) => Param::I64(*v),
        Val::F64(v) => Param::F64(*v),
        Val::Str(v) => Param::Str(v.clone()),
        Val::Bytes(v) => Param::Bytes(v.clone()),
        Val::DateTime(v) => Param::DateTime(*v),
        Val::Date(v) => Param::Date(*v),
        Val::Bool(v) => Param::Bool(*v),
        Val::Json(v) => Param::Str(v.to_string()),
    })
}
fn val(value: Param) -> Val {
    match value {
        Param::Null => Val::Null,
        Param::I64(v) => Val::I64(v),
        Param::F64(v) => Val::F64(v),
        Param::Str(v) => Val::Str(v),
        Param::Bytes(v) => Val::Bytes(v),
        Param::DateTime(v) => Val::DateTime(v),
        Param::Date(v) => Val::Date(v),
        Param::Bool(v) => Val::Bool(v),
        Param::Point(v) => Val::Str(format!("POINT({} {})", v.0, v.1)),
    }
}
fn encode(value: &Val, styles: &[String], key: &str) -> Result<Val> {
    Ok(val(crate::codec::host_encode(&param(value)?, styles, key)?))
}

pub async fn aes_status(
    ex: &impl Exec,
    spec: &AesRotationSpec,
    keyring: &AesKeyring,
) -> Result<AesRotationStatus> {
    let driver = ex.db().driver();
    let table = quote(driver, &spec.table)?;
    let version = quote(driver, &spec.version_column)?;
    let rows = ex
        .query(
            &step(
                format!(
                    "SELECT {version}, COUNT(*) FROM {table} GROUP BY {version} ORDER BY {version}"
                ),
                vec![],
            ),
            &[],
            vec![],
        )
        .await?;
    let mut status = AesRotationStatus {
        current: keyring.current_version,
        total: 0,
        pending: 0,
        versions: BTreeMap::new(),
    };
    for row in rows {
        let values = read_row(&row, 2)?;
        let stored_value = values[0].as_i64();
        let count = values[1].as_i64();
        if !(1..=i32::MAX as i64).contains(&stored_value) || count < 0 {
            return Err(Error::Engine {
                code: crate::codes::CODEC_DECODE.into(),
                msg: "AES rotation status contains an invalid value".into(),
            });
        }
        let stored = stored_value as i32;
        status.versions.insert(stored, count);
        status.total += count;
        if stored != status.current {
            status.pending += count;
        }
    }
    Ok(status)
}

pub async fn rotate_aes_rows(
    ex: &impl Exec,
    spec: &AesRotationSpec,
    keyring: &AesKeyring,
) -> Result<u64> {
    if ex.tx().is_none() {
        let spec = spec.clone();
        let keyring = keyring.clone();
        return ex
            .db()
            .transaction(move |tx| {
                let spec = spec.clone();
                let keyring = keyring.clone();
                async move { rotate_in_transaction(&tx, &spec, &keyring).await }
            })
            .await;
    }
    rotate_in_transaction(ex, spec, keyring).await
}

async fn rotate_in_transaction(
    ex: &impl Exec,
    spec: &AesRotationSpec,
    keyring: &AesKeyring,
) -> Result<u64> {
    if spec.columns.is_empty() {
        return Err(Error::Config("AES rotation columns are empty".into()));
    }
    if spec.primary_keys.is_empty() {
        return Err(Error::Config("AES rotation primary keys are empty".into()));
    }
    let driver = ex.db().driver();
    let table = quote(driver, &spec.table)?;
    let primary: Vec<String> = spec
        .primary_keys
        .iter()
        .map(|key| quote(driver, key))
        .collect::<Result<_>>()?;
    let version = quote(driver, &spec.version_column)?;
    let columns: Vec<String> = spec
        .columns
        .iter()
        .map(|column| quote(driver, &column.name))
        .collect::<Result<_>>()?;
    let batch_size = if spec.batch_size == 0 {
        1000
    } else {
        spec.batch_size
    };
    let select = step(format!("SELECT {}, {version}, {} FROM {table} WHERE {version} <> {} ORDER BY {} LIMIT {batch_size}", primary.join(", "), columns.join(", "), placeholder(driver, 1), primary.join(", ")), vec![parameter(0)]);
    let rows = ex
        .query(
            &select,
            &[Param::I64(keyring.current_version as i64)],
            vec![],
        )
        .await?;
    let mut sets: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(index, name)| format!("{name} = {}", placeholder(driver, index + 1)))
        .collect();
    sets.push(format!(
        "{version} = {}",
        placeholder(driver, columns.len() + 1)
    ));
    let mut predicates: Vec<String> = primary
        .iter()
        .enumerate()
        .map(|(index, key)| format!("{key} = {}", placeholder(driver, columns.len() + 2 + index)))
        .collect();
    predicates.push(format!(
        "{version} = {}",
        placeholder(driver, columns.len() + 2 + primary.len())
    ));
    let bind_count = columns.len() + primary.len() + 2;
    let update = step(
        format!(
            "UPDATE {table} SET {} WHERE {}",
            sets.join(", "),
            predicates.join(" AND ")
        ),
        (0..bind_count).map(parameter).collect(),
    );
    let mut count = 0;
    for row in rows {
        let values = read_row(&row, primary.len() + columns.len() + 1)?;
        let mut source = BTreeMap::new();
        for (index, key) in spec.primary_keys.iter().enumerate() {
            source.insert(key.clone(), values[index].clone());
        }
        source.insert(spec.version_column.clone(), values[primary.len()].clone());
        for (index, column) in spec.columns.iter().enumerate() {
            source.insert(
                column.name.clone(),
                values[index + primary.len() + 1].clone(),
            );
        }
        let rotated = keyring.rotate_row(
            &source,
            &spec.version_column,
            &spec.columns,
            keyring.current_version,
            crate::codec::host_decode,
            encode,
        )?;
        let mut args = Vec::with_capacity(bind_count);
        for column in &spec.columns {
            args.push(param(&rotated[&column.name])?);
        }
        args.push(Param::I64(keyring.current_version as i64));
        for value in &values[..primary.len()] {
            args.push(param(value)?);
        }
        args.push(Param::I64(values[primary.len()].as_i64()));
        let (_, affected) = ex.execute(&update, &args).await?;
        if affected != 1 {
            return Err(Error::Engine {
                code: crate::codes::OPTIMISTIC_LOCK.into(),
                msg: format!(
                    "AES rotation changed {} primary key {:?}",
                    spec.table,
                    &values[..primary.len()]
                ),
            });
        }
        count += 1;
    }
    Ok(count)
}
