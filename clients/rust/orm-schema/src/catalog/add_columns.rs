//! Plans `utils().schema().add_columns()`: the statements that add the
//! missing nullable or defaulted columns of the existing tables of a manifest
//! and replace the audit triggers of each changed table. The live tables of
//! the manifest are read through the import, with the column facts that the
//! catalog does not hold (bool, int, lazy and styles) taken from the manifest.
//! Every other difference between those tables and the manifest is reported
//! with [`AddColumnsError::Differs`] before any statement runs.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use super::{align_live_checks, read_tables, Catalog, CatalogError};
use crate::ddl::{column_storage, ddl_index_name, ddl_table, ddl_type, render_diff};
use crate::live::render_mermaid;
use crate::schema::{self, Col, DColumn, DEntity, Diagram, Manifest};
use crate::sql::split_sql;
use crate::triggers::trigger_objects;

/// The statements of an add_columns call and the added columns as
/// `table.column`, in manifest order.
#[derive(Debug, Default)]
pub struct AddColumnsPlan {
    pub statements: Vec<String>,
    pub added: Vec<String>,
}

/// A failed plan: the error of a catalog statement, a difference other than a
/// missing nullable or defaulted column, a table the call cannot read, or a
/// manifest that cannot be rendered.
#[derive(Debug)]
pub enum AddColumnsError<E> {
    Query(E),
    Differs(String),
    Unsupported(String),
    Internal(String),
}

impl<E> From<CatalogError<E>> for AddColumnsError<E> {
    fn from(e: CatalogError<E>) -> Self {
        match e {
            CatalogError::Query(e) => AddColumnsError::Query(e),
            CatalogError::Read(m) => AddColumnsError::Differs(format!("the existing tables of the manifest cannot be read: {m}")),
        }
    }
}

/// A manifest with no tables and no triggers that keeps the ORM directives and
/// external keys of m.
fn tables(m: &Manifest) -> Manifest {
    Manifest { orm: m.orm.clone(), external_fks: m.external_fks.clone(), ..Default::default() }
}

/// The column facts of the manifest that the catalog does not hold, as the
/// previous diagram of the import; entities are named by their tables.
fn facts(want: &Manifest, physical: &HashMap<String, String>) -> Diagram {
    let entities = want
        .order
        .iter()
        .map(|name| DEntity {
            name: physical[name].clone(),
            comment: String::new(),
            line: 0,
            columns: want.entities[name]
                .columns
                .iter()
                .map(|c| DColumn {
                    name: c.name.clone(),
                    lazy: c.lazy,
                    bool_: c.typ == "bool",
                    int: c.raw.to_lowercase().starts_with("tinyint") && c.typ != "bool" && c.name.starts_with("is_"),
                    styles: c.styles.clone(),
                    ..Default::default()
                })
                .collect(),
        })
        .collect();
    Diagram { entities, ..Default::default() }
}

static DECIMAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?[0-9]+\.[0-9]+$").expect("decimal pattern"));

/// A default without its string quotes, and a number without trailing
/// fraction zeros.
fn default_text(d: &str) -> String {
    let mut d = if d.len() >= 2 && d.starts_with('\'') && d.ends_with('\'') { d[1..d.len() - 1].replace("''", "'") } else { d.to_owned() };
    if DECIMAL.is_match(&d) {
        d = d.trim_end_matches('0').trim_end_matches('.').to_owned();
    }
    if d == "-0" {
        "0".into()
    } else {
        d
    }
}

/// Replaces the default of every live column whose catalog text is
/// equivalent to the declared default with the declared text: the import
/// reads a string default with its quotes and a decimal default with the
/// digits of its scale, so a diff reports only real changes.
fn align_defaults(current: &mut Manifest, declared: &Manifest) {
    for name in &declared.order {
        let columns: HashMap<&str, &Col> = declared.entities[name].columns.iter().map(|c| (c.name.as_str(), c)).collect();
        let Some(e) = current.entities.get_mut(name) else { continue };
        for c in e.columns.iter_mut() {
            let Some(d) = columns.get(c.name.as_str()) else { continue };
            if let (Some(live), Some(want)) = (&c.default, &d.default) {
                if live != want && default_text(live) == default_text(want) {
                    c.default = Some(want.clone());
                }
            }
        }
    }
}

/// Gives every live column whose type the dialect stores as the declared type
/// the declared type: PostgreSQL stores char(n) as varchar(n) and every blob
/// type as bytea, so the import cannot read the declared raw type back. SQLite
/// compares storage classes in the diff itself.
fn align_types(current: &mut Manifest, declared: &Manifest, driver: &str) {
    if driver == "sqlite" {
        return;
    }
    for name in &declared.order {
        let columns: HashMap<&str, &Col> = declared.entities[name].columns.iter().map(|c| (c.name.as_str(), c)).collect();
        let Some(e) = current.entities.get_mut(name) else { continue };
        for c in e.columns.iter_mut() {
            let Some(d) = columns.get(c.name.as_str()) else { continue };
            if column_storage(c, driver) == column_storage(d, driver) {
                continue;
            }
            let (Ok(live), Ok(want)) = (ddl_type(c, driver), ddl_type(d, driver)) else { continue };
            if live == want {
                c.typ = d.typ.clone();
                c.raw = d.raw.clone();
                c.len = d.len;
                c.precision = d.precision;
                c.scale = d.scale;
                c.unsigned = d.unsigned;
                c.r#enum = d.r#enum.clone();
            }
        }
    }
}

/// Gives every live index whose physical name is the physical name of a
/// declared index the declared name: a name longer than the identifier limit
/// of the dialect is stored cut with a digest, which the import cannot read
/// back.
fn align_indexes(current: &mut Manifest, declared: &Manifest, driver: &str) {
    for name in &declared.order {
        let Some(e) = current.entities.get_mut(name) else { continue };
        let table = &declared.entities[name].table;
        let by_physical: HashMap<String, &String> = declared.entities[name].indexes.keys().map(|index| (ddl_index_name(table, index, driver), index)).collect();
        e.indexes = std::mem::take(&mut e.indexes)
            .into_iter()
            .map(|(index, columns)| (by_physical.get(&ddl_index_name(table, &index, driver)).map_or(index, |d| (*d).clone()), columns))
            .collect();
    }
}

pub async fn plan_add_columns<C: Catalog>(conn: &mut C, driver: &str, want: &Manifest) -> Result<AddColumnsPlan, AddColumnsError<C::Error>> {
    let mut physical = HashMap::new();
    for name in &want.order {
        let table = &want.entities[name].table;
        if driver != "sqlite" && table.contains('.') {
            return Err(AddColumnsError::Unsupported(format!("addColumns reads the tables of the connected schema; table {table} is qualified")));
        }
        physical.insert(name.clone(), ddl_table(table, driver));
    }
    let only: HashSet<String> = physical.values().cloned().collect();
    let live = read_tables(conn, driver, Some(&only)).await?;
    if live.is_empty() {
        return Ok(AddColumnsPlan::default());
    }
    let unreadable = |e: String| AddColumnsError::Differs(format!("the existing tables of the manifest cannot be read as a manifest: {e}"));
    let diagram = schema::parse(&render_mermaid(&live, Some(&facts(want, &physical)))).map_err(|e| unreadable(e.to_string()))?;
    let read = schema::build_migration_source(&[diagram]).map_err(|e| unreadable(e.to_string()))?;
    let by_table: HashMap<&str, &schema::Entity> = read.entities.values().map(|e| (e.table.as_str(), e)).collect();
    let mut current = tables(&read);
    let mut declared = tables(want);
    for name in &want.order {
        let Some(e) = by_table.get(physical[name].as_str()) else { continue };
        let mut e = (*e).clone();
        e.name = name.clone();
        e.table = want.entities[name].table.clone();
        current.order.push(name.clone());
        current.entities.insert(name.clone(), e);
        declared.order.push(name.clone());
        declared.entities.insert(name.clone(), want.entities[name].clone());
    }
    align_live_checks(conn, driver, &mut current, &declared).await?;
    align_defaults(&mut current, &declared);
    align_types(&mut current, &declared, driver);
    align_indexes(&mut current, &declared, driver);
    let mut expanded = tables(&current);
    let (mut added, mut missing) = (Vec::new(), Vec::new());
    let mut changed = BTreeSet::new();
    for name in &declared.order {
        let we = &declared.entities[name];
        let ce = &current.entities[name];
        let mut live_columns: HashMap<&str, &Col> = ce.columns.iter().map(|c| (c.name.as_str(), c)).collect();
        let mut columns = Vec::new();
        for wc in &we.columns {
            if let Some(lc) = live_columns.remove(wc.name.as_str()) {
                columns.push(lc.clone());
            } else if wc.auto || (!wc.nullable && wc.default.is_none()) {
                missing.push(format!("{}.{}", we.table, wc.name));
            } else {
                columns.push(wc.clone());
                added.push(format!("{}.{}", we.table, wc.name));
                changed.insert(we.table.clone());
            }
        }
        columns.extend(ce.columns.iter().filter(|c| live_columns.contains_key(c.name.as_str())).cloned());
        let mut e = ce.clone();
        e.columns = columns;
        expanded.order.push(name.clone());
        expanded.entities.insert(name.clone(), e);
    }
    if !missing.is_empty() {
        return Err(AddColumnsError::Differs(format!("addColumns adds only nullable or defaulted columns; required columns: {}", missing.join(", "))));
    }
    let differences = split_sql(
        &render_diff(&expanded, &declared, driver, true).map_err(|e| AddColumnsError::Differs(format!("the existing tables differ from the manifest: {e}")))?,
    );
    if !differences.is_empty() {
        return Err(AddColumnsError::Differs(format!("the existing tables differ from the manifest beyond missing columns: {}", differences.join(" "))));
    }
    if added.is_empty() {
        return Ok(AddColumnsPlan::default());
    }
    let mut statements = split_sql(&render_diff(&current, &expanded, driver, false).map_err(|e| AddColumnsError::Differs(format!("add columns: {e}")))?);
    for o in trigger_objects(want, driver).map_err(AddColumnsError::Internal)? {
        if o.kind == "audit" && changed.contains(&o.table) {
            statements.extend(o.create);
        }
    }
    Ok(AddColumnsPlan { statements, added })
}
