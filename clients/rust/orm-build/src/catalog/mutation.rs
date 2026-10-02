//! Native optimistic updates. No durable operation identity or wire authority.
use super::{metadata, page::quote, CatalogConnection, RowSnapshot, TableMetadata};
use crate::tool_db::{self, Conn, GridCell, GridQueryResult, QueryLimits, P};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[cfg(test)]
#[path = "../../tests/unit/mutation_safety.rs"]
mod safety_tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MutationPhase {
    Validated,
    Locked,
    Applied,
    CommitStarted,
    Committed,
    RolledBack,
    Indeterminate,
}
pub(super) type Publisher = Arc<dyn Fn(MutationPhase) + Send + Sync>;
pub(super) type CommitPermit = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
pub(super) fn cancelled(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) {
        Err("JOB_CANCELLED: mutation cancelled before commit".into())
    } else {
        Ok(())
    }
}
pub(super) fn cell(value: &P) -> GridCell {
    match value {
        P::S(v) => GridCell::Text(v.clone()),
        P::I(v) => GridCell::Integer(*v),
        P::Unsigned(v) => GridCell::Unsigned(*v),
        P::Float32(v) => GridCell::Float32(*v),
        P::Float64(v) => GridCell::Float64(*v),
        P::Decimal(v) => GridCell::Decimal(v.clone()),
        P::Boolean(v) => GridCell::Boolean(*v),
        P::Binary(v) => GridCell::Binary(v.clone()),
        P::Null(_) => GridCell::Null,
    }
}
pub(super) fn bind(value: &GridCell) -> Result<P, String> {
    Ok(match value {
        GridCell::Text(v) => P::S(v.clone()),
        GridCell::Integer(v) => P::I(*v),
        GridCell::Unsigned(v) => P::Unsigned(*v),
        GridCell::Float32(v) => P::Float32(*v),
        GridCell::Float64(v) => P::Float64(*v),
        GridCell::Decimal(v) => P::Decimal(v.clone()),
        GridCell::Boolean(v) => P::Boolean(*v),
        GridCell::Binary(v) => P::Binary(v.clone()),
        GridCell::Null => return Err("ROW_UPDATE_INVALID: NULL row identity".into()),
        // P에는 temporal bind가 없으므로 text로 바꿔 비교하지 않고 거부한다.
        GridCell::Date(_) | GridCell::Time(_) | GridCell::DateTime(_) => return Err("ROW_UPDATE_INVALID: temporal row identity is not supported".into()),
    })
}
pub(super) fn placeholder(index: usize, dialect: &str) -> String {
    if dialect == "postgres" {
        format!("${index}")
    } else {
        "?".into()
    }
}
pub(super) fn qualified(metadata: &TableMetadata, dialect: &str) -> Result<String, String> {
    Ok(format!("{}.{}", quote(&metadata.table.namespace, dialect)?, quote(&metadata.table.name, dialect)?))
}
pub(super) fn predicate(metadata: &TableMetadata, dialect: &str, start: usize) -> Result<String, String> {
    metadata
        .primary_key
        .iter()
        .enumerate()
        .map(|(index, name)| Ok(format!("{}={}", quote(name, dialect)?, placeholder(start + index, dialect))))
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join(" AND "))
}
pub(super) async fn lookup(connection: &mut Conn, metadata: &TableMetadata, dialect: &str, keys: &[P], lock: bool) -> Result<GridQueryResult, String> {
    let columns = metadata.columns.iter().map(|column| quote(&column.name, dialect)).collect::<Result<Vec<_>, _>>()?.join(",");
    let suffix = if lock && dialect != "sqlite" { " FOR UPDATE" } else { "" };
    let sql = format!("SELECT {columns} FROM {} WHERE {} LIMIT 2{suffix}", qualified(metadata, dialect)?, predicate(metadata, dialect, 1)?);
    super::temporal::read(connection, metadata, dialect, &sql, keys, QueryLimits { max_rows: 2, max_bytes: 8 * 1024 * 1024 }).await
}
pub(super) async fn mysql_safety(connection: &mut Conn, metadata: &TableMetadata) -> Result<(), String> {
    let revokes = connection
        .grid_query_bounded("SELECT @@GLOBAL.partial_revokes", &[], QueryLimits { max_rows: 1, max_bytes: 65536 })
        .await
        .map_err(|e| e.to_string())?;
    if !matches!(revokes.rows.as_slice(),[row] if matches!(row.as_slice(),[GridCell::Integer(0)]|[GridCell::Unsigned(0)]|[GridCell::Boolean(false)])) {
        return Err("ROW_MUTATION_UNSUPPORTED: MySQL partial-revoke visibility requires verification".into());
    }
    let account =
        connection.grid_query_bounded("SELECT CURRENT_USER()", &[], QueryLimits { max_rows: 1, max_bytes: 65536 }).await.map_err(|e| e.to_string())?;
    let grantee = match account.rows.as_slice() {
        [row] => match row.as_slice() {
            [GridCell::Text(account)] => {
                let (user, host) = account.rsplit_once('@').ok_or_else(|| "ROW_MUTATION_UNSUPPORTED: unverifiable MySQL account".to_owned())?;
                format!("'{user}'@'{host}'")
            }
            _ => return Err("ROW_MUTATION_UNSUPPORTED: unverifiable MySQL account".into()),
        },
        _ => return Err("ROW_MUTATION_UNSUPPORTED: unverifiable MySQL account".into()),
    };
    let grants=connection.grid_query_bounded(
        "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='TRIGGER' UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'",
        &[P::S(grantee.clone()),P::S(grantee.clone()),P::S(metadata.table.namespace.clone()),P::S(grantee),P::S(metadata.table.namespace.clone()),P::S(metadata.table.name.clone())],QueryLimits{max_rows:3,max_bytes:65536}).await.map_err(|e|e.to_string())?;
    require_trigger_privilege(&grants)?;
    let result = connection
        .grid_query_bounded(
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
            &[P::S(metadata.table.namespace.clone()), P::S(metadata.table.name.clone())],
            QueryLimits { max_rows: 2, max_bytes: 65536 },
        )
        .await
        .map_err(|e| e.to_string())?;
    if !matches!(result.rows.as_slice(),[row] if matches!(row.as_slice(),[GridCell::Text(engine)] if engine.eq_ignore_ascii_case("InnoDB"))) {
        return Err("ROW_MUTATION_UNSUPPORTED: MySQL requires InnoDB".into());
    }
    let triggers = connection
        .grid_query_bounded(
            "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? LIMIT 1",
            &[P::S(metadata.table.namespace.clone()), P::S(metadata.table.name.clone())],
            QueryLimits { max_rows: 1, max_bytes: 65536 },
        )
        .await
        .map_err(|e| e.to_string())?;
    if !triggers.rows.is_empty() {
        return Err("ROW_MUTATION_UNSUPPORTED: MySQL triggers require effect verification".into());
    }
    Ok(())
}
fn require_trigger_privilege(result: &GridQueryResult) -> Result<(), String> {
    if result.rows.iter().any(|row| matches!(row.as_slice(),[GridCell::Text(value)] if value=="TRIGGER")) {
        Ok(())
    } else {
        Err("ROW_MUTATION_UNSUPPORTED: MySQL trigger visibility is unverified".into())
    }
}
impl CatalogConnection {
    /// Explicit caller-authorized update. No automatic retries or durable identity.
    pub async fn update_row(
        &self,
        original: &RowSnapshot,
        changes: &[(String, P)],
        cancellation: Arc<AtomicBool>,
        publish: Publisher,
        permit: CommitPermit,
    ) -> Result<GridQueryResult, String> {
        cancelled(&cancellation)?;
        if changes.is_empty() || changes.len() > original.metadata().columns.len() {
            return Err("ROW_UPDATE_INVALID: invalid column assignments".into());
        }
        tool_db::validate_param_refs(changes.iter().map(|(_, value)| value), &self.dialect).map_err(|e| e.to_string())?;
        let params = changes.iter().map(|(_, value)| value.clone()).collect::<Vec<_>>();
        tool_db::validate_params(&params, &self.dialect).map_err(|e| e.to_string())?;
        let assignments = changes.iter().map(|(name, value)| (name.clone(), cell(value))).collect::<Vec<_>>();
        original.validate_update(&assignments)?;
        let keys = original.key().map(|(_, value)| bind(value)).collect::<Result<Vec<_>, _>>()?;
        tool_db::validate_params(&keys, &self.dialect).map_err(|e| e.to_string())?;
        publish(MutationPhase::Validated);
        cancelled(&cancellation)?;
        let mut connection = Conn::acquire(&self.pool).await.map_err(|e| e.to_string())?;
        connection.discard_on_drop();
        cancelled(&cancellation)?;
        connection
            .exec(
                match self.dialect.as_str() {
                    "mysql" => "START TRANSACTION",
                    "postgres" => "BEGIN",
                    _ => "BEGIN IMMEDIATE",
                },
                &[],
            )
            .await
            .map_err(|e| e.to_string())?;
        let result = async {
            cancelled(&cancellation)?;
            let current = lookup(&mut connection, original.metadata(), &self.dialect, &keys, true).await?;
            let descriptor = metadata::describe(&mut connection, &self.dialect, &original.metadata().table).await?;
            original.check_current(&descriptor, &current)?;
            if self.dialect == "mysql" {
                mysql_safety(&mut connection, &descriptor).await?;
            }
            publish(MutationPhase::Locked);
            cancelled(&cancellation)?;
            let sets = changes
                .iter()
                .enumerate()
                .map(|(index, (name, _))| Ok(format!("{}={}", quote(name, &self.dialect)?, placeholder(index + 1, &self.dialect))))
                .collect::<Result<Vec<_>, String>>()?
                .join(",");
            let sql =
                format!("UPDATE {} SET {sets} WHERE {}", qualified(&descriptor, &self.dialect)?, predicate(&descriptor, &self.dialect, changes.len() + 1)?);
            let mut bound = params;
            bound.extend(keys);
            let affected = connection.exec(&sql, &bound).await.map_err(|e| e.to_string())?;
            // MySQL may report zero changed rows for an exact no-op; post-read is authoritative.
            if affected > 1 || (affected == 0 && self.dialect != "mysql") {
                return Err("ROW_WRITE_MISMATCH: unexpected affected row count".into());
            }
            publish(MutationPhase::Applied);
            cancelled(&cancellation)?;
            let new_keys = original
                .key()
                .map(|(name, value)| changes.iter().find(|(column, _)| column == name).map(|(_, value)| Ok(value.clone())).unwrap_or_else(|| bind(value)))
                .collect::<Result<Vec<_>, String>>()?;
            let after = lookup(&mut connection, &descriptor, &self.dialect, &new_keys, false).await?;
            let after_descriptor = metadata::describe(&mut connection, &self.dialect, &descriptor.table).await?;
            original.check_updated(&after_descriptor, &after, &assignments)?;
            cancelled(&cancellation)?;
            Ok(after)
        }
        .await;
        super::mutation_finish::finish(connection, result, publish, permit).await
    }
}
