//! Migration files and history records: SQL statement splitting, plan files,
//! file logs, and the schema comparison a migration verifies.

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::ddl::{render_diff, sqlite_type_matches};
use crate::schema::json::{self, Obj, J};
use crate::schema::Manifest;

pub use orm_schema::sql::split_sql;

/// The SHA-256 of a text in hex.
pub fn checksum_text(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether a live schema has the tables and columns of the wanted one. Tables
/// and columns are compared by name: column order is not a schema property,
/// and a column added by a migration is appended by the database wherever the
/// declaration places it.
pub fn schema_matches(want: &Manifest, live: &Manifest, driver: &str) -> bool {
    if want.entities.len() != live.entities.len() || !orm_schema::triggers::same_triggers(want, live) {
        return false;
    }
    want.entities.iter().all(|(name, we)| {
        let Some(le) = live.entities.get(name) else { return false };
        we.table == le.table
            && we.comment == le.comment
            && we.columns.len() == le.columns.len()
            && we.columns.iter().all(|wc| {
                let Some(lc) = le.column(&wc.name) else { return false };
                let type_match = if driver == "sqlite" { sqlite_type_matches(&wc.typ, &lc.typ) } else { wc.typ == lc.typ };
                wc.comment == lc.comment && wc.nullable == lc.nullable && type_match
            })
    })
}

/// A migration history row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Record {
    pub migration_id: String,
    pub name: String,
    pub from_hash: String,
    pub to_hash: String,
    pub checksum: String,
    pub status: String,
    pub operations: i64,
}

/// A migration file log.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Log {
    #[serde(default)]
    pub migration_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub driver: String,
    #[serde(default, rename = "from_schema_hash")]
    pub from_hash: String,
    #[serde(default, rename = "to_schema_hash")]
    pub to_hash: String,
    #[serde(default, rename = "plan_checksum")]
    pub checksum: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub operations: i64,
    #[serde(default)]
    pub error_detail: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub finished_at: String,
}

impl Log {
    /// The log of a record; `finished_at` is empty while the migration runs.
    pub fn from_record(r: &Record, driver: &str, started_at: &str, finished_at: &str) -> Log {
        Log {
            migration_id: r.migration_id.clone(),
            name: r.name.clone(),
            driver: driver.to_owned(),
            from_hash: r.from_hash.clone(),
            to_hash: r.to_hash.clone(),
            checksum: r.checksum.clone(),
            status: r.status.clone(),
            operations: r.operations,
            error_detail: String::new(),
            started_at: started_at.to_owned(),
            finished_at: finished_at.to_owned(),
        }
    }

    pub fn with_error(mut self, detail: &str) -> Log {
        self.error_detail = detail.to_owned();
        self
    }

    /// The indented JSON text with a trailing newline.
    pub fn to_json(&self) -> String {
        let j = Obj::new()
            .str("migration_id", &self.migration_id)
            .str("name", &self.name)
            .str("driver", &self.driver)
            .str("from_schema_hash", &self.from_hash)
            .str("to_schema_hash", &self.to_hash)
            .str("plan_checksum", &self.checksum)
            .str("status", &self.status)
            .put("operations", J::Int(self.operations))
            .str_omit("error_detail", &self.error_detail)
            .str("started_at", &self.started_at)
            .str_omit("finished_at", &self.finished_at)
            .done();
        json::indent(&j) + "\n"
    }

    /// Whether the log records the same migration as a history row.
    pub fn matches(&self, r: &Record, driver: &str) -> bool {
        self.migration_id == r.migration_id
            && self.driver == driver
            && self.from_hash == r.from_hash
            && self.to_hash == r.to_hash
            && self.checksum == r.checksum
            && self.status == r.status
            && self.operations == r.operations
    }
}

/// A migration identifier as a file name part.
pub fn safe_migration_id(id: &str) -> String {
    let out: String = id.chars().map(|r| if r.is_ascii_alphanumeric() || matches!(r, '-' | '_' | '.') { r } else { '_' }).collect();
    if out.is_empty() {
        "migration".into()
    } else {
        out
    }
}

/// The file name of a log: the start time without separators and the id.
pub fn log_file_name(log: &Log) -> String {
    format!("{}__{}.json", log.started_at.replace([':', '-'], ""), safe_migration_id(&log.migration_id))
}

/// Formats a time like Go's RFC3339Nano in UTC.
pub fn rfc3339_nano(t: std::time::SystemTime) -> String {
    let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let nanos = d.subsec_nanos();
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let mut out = format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}", rem / 3600, rem / 60 % 60, rem % 60);
    if nanos > 0 {
        let frac = format!("{nanos:09}");
        out.push('.');
        out.push_str(frac.trim_end_matches('0'));
    }
    out.push('Z');
    out
}

/// One statement of a plan file.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Operation {
    pub sql: String,
    pub destructive: bool,
}

/// Splits SQL into plan operations; drops, column rewrites, and type
/// changes are destructive.
pub fn plan_operations(sql_text: &str) -> Vec<Operation> {
    split_sql(sql_text)
        .into_iter()
        .map(|statement| {
            let upper = statement.to_uppercase();
            let destructive = ["DROP TABLE", "DROP COLUMN", "MODIFY COLUMN", "ALTER COLUMN"].iter().any(|k| upper.contains(k));
            Operation { sql: format!("{statement};"), destructive }
        })
        .collect()
}

/// The SQL text a plan checksum covers.
pub fn plan_sql(operations: &[Operation]) -> String {
    let mut b = String::new();
    for op in operations {
        b += &op.sql;
        if !op.sql.ends_with('\n') {
            b.push('\n');
        }
    }
    b
}

pub fn has_destructive(operations: &[Operation]) -> bool {
    operations.iter().any(|o| o.destructive)
}

/// Checks a plan's checksum and the destructive flag of every operation.
pub fn validate_plan_operations(label: &str, operations: &[Operation], checksum: &str) -> Result<(), String> {
    if checksum_text(&plan_sql(operations)) != checksum {
        return Err(format!("{label}: plan checksum mismatch"));
    }
    for (i, op) in operations.iter().enumerate() {
        let classified = plan_operations(&op.sql);
        if classified.len() != 1 {
            return Err(format!("{label}: operation={} must contain exactly one SQL statement", i + 1));
        }
        if op.destructive != classified[0].destructive {
            return Err(format!("{label}: operation={} destructive flag mismatch", i + 1));
        }
    }
    Ok(())
}

/// A reviewed migration plan file (`YYYYMMDD-name.json`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PlanFile {
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub migration_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub driver: String,
    #[serde(default, rename = "from_schema_hash")]
    pub from_hash: String,
    #[serde(default)]
    pub from_schema: Option<Manifest>,
    #[serde(default, rename = "to_schema_hash")]
    pub to_hash: String,
    #[serde(default)]
    pub to_schema: Option<Manifest>,
    #[serde(default, rename = "plan_checksum")]
    pub checksum: String,
    #[serde(default, deserialize_with = "null_vec")]
    pub operations: Vec<Operation>,
    #[serde(default)]
    pub rollback_checksum: String,
    #[serde(default, deserialize_with = "null_vec")]
    pub rollback_operations: Vec<Operation>,
    #[serde(default)]
    pub rollback_data_loss_risk: bool,
}

fn null_vec<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Vec<T>, D::Error> {
    Ok(Option::<Vec<T>>::deserialize(d)?.unwrap_or_default())
}

static PLAN_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{8}-[a-z0-9][a-z0-9._-]*$").unwrap());

fn valid_date(ymd: &str) -> bool {
    let (Ok(y), Ok(m), Ok(d)) = (ymd[..4].parse::<i32>(), ymd[4..6].parse::<u32>(), ymd[6..8].parse::<u32>()) else { return false };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

/// The migration id of a plan file path: its `YYYYMMDD-name` base name.
pub fn plan_id(out: &str, requested: &str) -> Result<String, String> {
    let base = std::path::Path::new(out).file_name().and_then(|b| b.to_str()).unwrap_or(out);
    let Some(file_id) = base.strip_suffix(".json") else {
        return Err(format!("MIGRATION_FILE_NAME: plan file must use YYYYMMDD-name.json: {base}"));
    };
    if !PLAN_NAME.is_match(file_id) {
        return Err(format!("MIGRATION_FILE_NAME: plan file must use YYYYMMDD-name.json: {base}"));
    }
    if !valid_date(&file_id[..8]) {
        return Err(format!("MIGRATION_FILE_NAME: invalid YYYYMMDD date in {base}"));
    }
    if !requested.is_empty() && requested != file_id {
        return Err(format!("MIGRATION_FILE_NAME: migration_id={requested} must match plan filename id={file_id}"));
    }
    Ok(file_id.to_owned())
}

impl PlanFile {
    /// Plans the migration between two schemas with its rollback.
    pub fn new(id: &str, name: &str, dialect: &str, from: Manifest, to: Manifest) -> Result<PlanFile, String> {
        let sql_text = render_diff(&from, &to, dialect, true).map_err(|e| format!("MIGRATION_PLAN: {e}"))?;
        let rollback_text = render_diff(&to, &from, dialect, true).map_err(|e| format!("MIGRATION_ROLLBACK_PLAN: {e}"))?;
        let operations = plan_operations(&sql_text);
        let rollback_operations = plan_operations(&rollback_text);
        Ok(PlanFile {
            version: 1,
            migration_id: id.to_owned(),
            name: name.to_owned(),
            driver: dialect.to_owned(),
            from_hash: from.schema_hash.clone(),
            to_hash: to.schema_hash.clone(),
            checksum: checksum_text(&plan_sql(&operations)),
            rollback_checksum: checksum_text(&plan_sql(&rollback_operations)),
            rollback_data_loss_risk: has_destructive(&operations) || has_destructive(&rollback_operations),
            from_schema: Some(from),
            to_schema: Some(to),
            operations,
            rollback_operations,
        })
    }

    /// Reads a plan file.
    pub fn parse(text: &str) -> Result<PlanFile, String> {
        serde_json::from_str(text).map_err(|e| format!("MIGRATION_SOURCE: invalid plan JSON: {e}"))
    }

    /// The indented JSON text with a trailing newline.
    pub fn to_json(&self) -> String {
        let ops = |v: &[Operation]| J::Arr(v.iter().map(|o| Obj::new().str("sql", &o.sql).put("destructive", J::Bool(o.destructive)).done()).collect());
        let schema = |m: &Option<Manifest>| m.as_ref().map_or(J::Null, |m| m.to_json(&m.schema_hash));
        let j = Obj::new()
            .put("version", J::Int(self.version))
            .str("migration_id", &self.migration_id)
            .str("name", &self.name)
            .str("driver", &self.driver)
            .str("from_schema_hash", &self.from_hash)
            .put("from_schema", schema(&self.from_schema))
            .str("to_schema_hash", &self.to_hash)
            .put("to_schema", schema(&self.to_schema))
            .str("plan_checksum", &self.checksum)
            .put("operations", ops(&self.operations))
            .str("rollback_checksum", &self.rollback_checksum)
            .put("rollback_operations", ops(&self.rollback_operations))
            .put("rollback_data_loss_risk", J::Bool(self.rollback_data_loss_risk))
            .done();
        json::indent(&j) + "\n"
    }

    /// Checks the embedded schemas, both checksums, and the data loss flag.
    pub fn validate_rollback(&self) -> Result<(), String> {
        let (Some(from), Some(to)) = (&self.from_schema, &self.to_schema) else {
            return Err("MIGRATION_ROLLBACK_PLAN: version, migration_id, driver, from_schema, and to_schema are required".into());
        };
        if self.version != 1 || self.migration_id.is_empty() || self.driver.is_empty() {
            return Err("MIGRATION_ROLLBACK_PLAN: version, migration_id, driver, from_schema, and to_schema are required".into());
        }
        if from.schema_hash != self.from_hash || to.schema_hash != self.to_hash {
            return Err("MIGRATION_ROLLBACK_PLAN: embedded schema hash mismatch".into());
        }
        for (label, m) in [("from_schema", from), ("to_schema", to)] {
            if m.hash() != m.schema_hash {
                return Err(format!(
                    "MIGRATION_ROLLBACK_PLAN: invalid {label}: schema.json was edited by hand: hash {} does not match content {}",
                    m.schema_hash,
                    m.hash()
                ));
            }
        }
        validate_plan_operations("MIGRATION_PLAN", &self.operations, &self.checksum)?;
        validate_plan_operations("MIGRATION_ROLLBACK_PLAN", &self.rollback_operations, &self.rollback_checksum)?;
        let want = has_destructive(&self.operations) || has_destructive(&self.rollback_operations);
        if self.rollback_data_loss_risk != want {
            return Err(format!("MIGRATION_ROLLBACK_PLAN: rollback_data_loss_risk mismatch expected={want} actual={}", self.rollback_data_loss_risk));
        }
        Ok(())
    }

    /// Checks that a history row records this plan.
    pub fn verify_record(&self, r: &Record) -> Result<(), String> {
        if r.from_hash != self.from_hash || r.to_hash != self.to_hash || r.checksum != self.checksum || r.operations != self.operations.len() as i64 {
            return Err(format!(
                "MIGRATION_HISTORY_CONFLICT: migration_id={} recorded_from={} requested_from={} recorded_to={} requested_to={} recorded_plan_checksum={} requested_plan_checksum={} recorded_operations={} requested_operations={}",
                self.migration_id,
                r.from_hash,
                self.from_hash,
                r.to_hash,
                self.to_hash,
                r.checksum,
                self.checksum,
                r.operations,
                self.operations.len()
            ));
        }
        Ok(())
    }
}

/// A `SELECT 'orm-sqlite-rebuild …'` marker of a SQLite table rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildMarker {
    pub table: String,
    pub target: String,
    pub temp: String,
}

/// The table rebuilds a SQLite migration performs.
pub fn sqlite_rebuild_markers(text: &str) -> Vec<RebuildMarker> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        let line = line.trim();
        let Some(position) = line.find("orm-sqlite-rebuild ") else { continue };
        let payload = line[position + "orm-sqlite-rebuild ".len()..].trim_matches(['\'', '"', ';', ' ']);
        let mut values = std::collections::HashMap::new();
        for field in crate::schema::fields(payload) {
            if let Some((k, v)) = field.split_once('=') {
                values.insert(k, v.trim_matches(['\'', '"', ';', ' ']).to_owned());
            }
        }
        let get = |k: &str| values.get(k).cloned().unwrap_or_default();
        if !get("table").is_empty() && !get("target").is_empty() && !get("temp").is_empty() {
            out.push(RebuildMarker { table: get("table"), target: get("target"), temp: get("temp") });
        }
    }
    out
}
