//! MySQL and PostgreSQL store a CHECK expression in their own normalized form,
//! so the text read from the catalog differs from the declared expression. To
//! compare them, the declared expression is created on a temporary table of
//! the same database and read back through the same catalog path; SQLite
//! keeps the text it was given, so its form is the rendered DDL text.

use std::collections::HashMap;

use super::{postgres_check_expr, Catalog, CatalogError};
use crate::ddl::{ddl_column, ddl_table, rendered_check_expression};
use crate::live::sqlite_balanced_paren;
use crate::schema::{Entity, Manifest};

/// Replaces the expression of every live check that is equivalent to the
/// declared check of the same name with the declared text, so a diff reports
/// only real changes. A changed live manifest gets the hash of its new
/// content, so a plan that stores it stays self-consistent.
pub async fn align_live_checks<C: Catalog>(conn: &mut C, driver: &str, live: &mut Manifest, want: &Manifest) -> Result<(), CatalogError<C::Error>> {
    let mut changed = false;
    for (name, declared) in &want.entities {
        if declared.checks.is_empty() {
            continue;
        }
        let key = if live.entities.contains_key(name) {
            Some(name.clone())
        } else {
            let table = ddl_table(&declared.table, driver);
            live.entities.iter().filter(|(_, candidate)| candidate.table == table).map(|(k, _)| k.clone()).next_back()
        };
        let Some(key) = key else { continue };
        if live.entities[&key].checks.is_empty() {
            continue;
        }
        let canonical = canonical_checks(conn, driver, declared).await.map_err(|e| match e {
            CatalogError::Read(m) => CatalogError::Read(format!("table {}: normalize CHECK expressions: {m}", declared.table)),
            query => query,
        })?;
        let current = live.entities.get_mut(&key).expect("live entity");
        for check in current.checks.iter_mut() {
            for (j, wanted) in declared.checks.iter().enumerate() {
                if wanted.name == check.name && canonical[j] == check.expr && check.expr != wanted.expr {
                    check.expr = wanted.expr.clone();
                    changed = true;
                }
            }
        }
    }
    if changed {
        live.schema_hash = live.hash();
    }
    Ok(())
}

fn probe_check_name(i: usize) -> String {
    format!("__orm_check_probe_{}", i + 1)
}

/// The catalog form of each declared check of an entity, in declaration order.
async fn canonical_checks<C: Catalog>(conn: &mut C, driver: &str, e: &Entity) -> Result<Vec<String>, CatalogError<C::Error>> {
    let mysql_q = |s: &str| format!("`{s}`");
    let other_q = |s: &str| format!("\"{s}\"");
    let quote: &dyn Fn(&str) -> String = if driver == "mysql" { &mysql_q } else { &other_q };
    let exprs = e.checks.iter().map(|c| rendered_check_expression(&c.expr, driver, quote)).collect::<Result<Vec<_>, _>>().map_err(CatalogError::Read)?;
    if driver == "sqlite" {
        return Ok(exprs);
    }
    const PROBE: &str = "__orm_check_probe";
    let mut lines = Vec::with_capacity(e.columns.len() + exprs.len());
    for c in &e.columns {
        let mut plain = c.clone();
        plain.auto = false;
        lines.push(ddl_column(&plain, driver, quote).map_err(CatalogError::Read)?);
    }
    for (i, expr) in exprs.iter().enumerate() {
        lines.push(format!("CONSTRAINT {} CHECK ({expr})", quote(&probe_check_name(i))));
    }
    conn.exec(&format!("CREATE TEMPORARY TABLE {} ({})", quote(PROBE), lines.join(", "))).await.map_err(CatalogError::Query)?;
    let read = read_probe_checks(conn, driver, e, exprs.len(), quote).await;
    let dropped = conn.exec(&format!("DROP TABLE IF EXISTS {}", quote(PROBE))).await.map_err(CatalogError::Query);
    let checks = read?;
    dropped?;
    Ok(checks)
}

async fn read_probe_checks<C: Catalog>(
    conn: &mut C,
    driver: &str,
    e: &Entity,
    n: usize,
    quote: &dyn Fn(&str) -> String,
) -> Result<Vec<String>, CatalogError<C::Error>> {
    let mut by_name = HashMap::new();
    if driver == "mysql" {
        let rows = conn.query("SHOW CREATE TABLE `__orm_check_probe`").await.map_err(CatalogError::Query)?;
        let text = rows.first().and_then(|r| r.get(1)).map(|v| v.text()).unwrap_or_default();
        for i in 0..n {
            let marker = format!("CONSTRAINT {} CHECK ", quote(&probe_check_name(i)));
            let Some(at) = text.find(&marker) else {
                return Err(CatalogError::Read(format!("check {} is missing from the probe table", e.checks[i].name)));
            };
            let open = at + marker.len();
            let end = sqlite_balanced_paren(text.as_bytes(), open).map_err(CatalogError::Read)?;
            by_name.insert(probe_check_name(i), text[open + 1..end].to_owned());
        }
    } else {
        let rows = conn
            .query("SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'pg_temp.__orm_check_probe'::regclass AND contype = 'c'")
            .await
            .map_err(CatalogError::Query)?;
        for r in rows {
            by_name.insert(r[0].text(), postgres_check_expr(&r[1].text()));
        }
    }
    (0..n)
        .map(|i| by_name.remove(&probe_check_name(i)).ok_or_else(|| CatalogError::Read(format!("check {} is missing from the probe table", e.checks[i].name))))
        .collect()
}
