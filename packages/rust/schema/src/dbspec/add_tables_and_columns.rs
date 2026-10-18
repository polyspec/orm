//! Writes the steps that addTablesAndColumns of a connection runs (docs/schema.md, "Adding tables and columns").

use super::model::{Name, Pos, Table};
use super::plan::plan_to;
use super::{compare_schemas, emit, manifest, plan_steps, Dialect, Document, Plan, PlanStep, Unsupported};
use std::collections::{BTreeMap, BTreeSet};

/// The result of [`add_tables_and_columns_steps`]: the tables to create and columns to add as steps, or a difference.
#[derive(Clone, Debug)]
pub struct AddTablesAndColumnsSteps {
    /// Tables to create come first in table name order as "table", then columns to add in column order as "table.column".
    pub added: Vec<String>,
    pub steps: Vec<PlanStep>,
    /// A difference that is neither create_table nor add_column, as "<kind> <table>[.<name>]".
    pub differences: Vec<String>,
}

fn qualified(table: &str, name: &str) -> String {
    if name.is_empty() {
        table.to_owned()
    } else {
        format!("{table}.{name}")
    }
}

fn schema_document(tables: Vec<Table>) -> Document {
    Document {
        name: Name { text: "schema".to_owned(), pos: Pos { line: 1, column: 10 } },
        uses: Vec::new(),
        tables,
        diagrams: Vec::new(),
        trailing: Vec::new(),
        external: false,
    }
}

/// is the table of the set in the database (source). If the set's table has an object that could not be read, that table
/// cannot be said to equal the set, so that object is reported as "unsupported_<kind> <table>[.<name>]: <reason>"
/// and returned.
fn set_source(live: &Document, unsupported: &[Unsupported], target: &Document) -> Result<Document, Vec<String>> {
    let declared: BTreeSet<&str> = target.tables.iter().map(|t| t.name.text.as_str()).collect();
    let differences: Vec<String> = unsupported
        .iter()
        .filter(|u| declared.contains(u.table.as_str()))
        .map(|u| format!("unsupported_{} {}: {}", u.kind, qualified(&u.table, &u.name), u.reason))
        .collect();
    if !differences.is_empty() {
        return Err(differences);
    }
    Ok(schema_document(live.tables.iter().filter(|t| declared.contains(t.name.text.as_str())).cloned().collect()))
}

/// Checks whether the database equals the document set (docs/schema.md, "Schema installation"). `live`
/// is the document introspected from the connection's database, `unsupported` is the objects introspection could not read,
/// `target` is the schema text document of the document set. Tables of the database that are not in the set are not compared.
/// If a set's table has an unreadable object, that object is reported as "unsupported_<kind> <table>[.<name>]: <reason>",
/// otherwise every difference from the database's table of the set to the set is reported as "<kind> <table>[.<name>]"
/// and returned. An empty list means equal.
pub fn installed_differences(live: &Document, unsupported: &[Unsupported], target: &Document) -> Vec<String> {
    let source = match set_source(live, unsupported, target) {
        Ok(source) => source,
        Err(differences) => return differences,
    };
    match compare_schemas(&source, target) {
        Err(diagnostics) => diagnostics.iter().map(|d| format!("{}: {}", d.rule, d.message)).collect(),
        Ok(found) => found.iter().map(|d| format!("{} {}", d.kind, qualified(&d.table, &d.name))).collect(),
    }
}

/// `live` is the document introspected from the connection's database, `unsupported` is the objects introspection could not read,
/// `target` is the schema text document of the document set. Tables of the database that are not in the set
/// are neither compared nor changed. A difference between a set's table in the database and the set that is missing from the database
/// table's create_table, add_column for a nullable or defaulted column, and add_index for a non-unique index
/// only, the plan step from the set's table in the database to the set (docs/plans.md,
/// "Steps"), with tables to create in table name order as "table" and columns to add in column order
/// as "table.column", then indexes to add in index order as "table.index", and returns that list. Other
/// differences are returned without a step as "<kind> <table>[.<name>]", and a missing unique key, which could fail on existing rows,
/// is returned with its reason.
pub fn add_tables_and_columns_steps(live: &Document, unsupported: &[Unsupported], target: &Document, dialect: Dialect) -> AddTablesAndColumnsSteps {
    let declared: BTreeMap<&str, &Table> = target.tables.iter().map(|t| (t.name.text.as_str(), t)).collect();
    let mut differences = Vec::new();
    let none = |differences| AddTablesAndColumnsSteps { added: Vec::new(), steps: Vec::new(), differences };
    let source = match set_source(live, unsupported, target) {
        Ok(source) => source,
        Err(differences) => return none(differences),
    };
    let mut adding = BTreeSet::new();
    match compare_schemas(&source, target) {
        Err(diagnostics) => differences.extend(diagnostics.iter().map(|d| format!("{}: {}", d.rule, d.message))),
        Ok(found) => {
            for d in found {
                match d.kind.as_str() {
                    "create_table" => {
                        adding.insert(d.table.clone());
                    }
                    "add_column" => {
                        let column = declared[d.table.as_str()].columns.iter().find(|c| c.name.text == d.name);
                        match column {
                            Some(c) if c.identity.is_none() && (c.nullable || c.default.is_some()) => {
                                adding.insert(qualified(&d.table, &d.name));
                            }
                            _ => differences.push(format!("add_column {} without null or default", qualified(&d.table, &d.name))),
                        }
                    }
                    // An index does not reject rows, so it is added to existing tables too.
                    "add_index" => {
                        adding.insert(qualified(&d.table, &d.name));
                    }
                    // A unique key fails when existing rows overlap, so plan and apply handle it.
                    "add_unique" => differences
                        .push(format!("add_unique {}: a missing unique key can fail on the existing rows; add it with a plan", qualified(&d.table, &d.name))),
                    _ => differences.push(format!("{} {}", d.kind, qualified(&d.table, &d.name))),
                }
            }
        }
    }
    if !differences.is_empty() || adding.is_empty() {
        return none(differences);
    }
    // Tables to create, columns to add, and indexes are ordered by table name; within a table, columns come first, then indexes.
    let added: Vec<String> = target
        .tables
        .iter()
        .flat_map(|t| {
            if adding.contains(&t.name.text) {
                vec![t.name.text.clone()]
            } else {
                t.columns
                    .iter()
                    .map(|c| qualified(&t.name.text, &c.name.text))
                    .chain(t.indexes.iter().map(|i| qualified(&t.name.text, &i.name.text)))
                    .filter(|name| adding.contains(name))
                    .collect()
            }
        })
        .collect();
    // Tables and columns to add are written as one plan. The plan starts from the set's table in the database
    // (an empty database if there are none), so the steps keep the order and rollback of docs/plans.md
    // as is.
    let start = (!source.tables.is_empty()).then_some(&source);
    let from = match start {
        Some(source) => manifest(&[source]).map(|m| Some(m.schema_hash)),
        None => Ok(None),
    };
    // The target may be the schema text of a set that writes external documents, so the plan document is not parsed; the plan is built
    // from the target.
    let steps = from
        .and_then(|from| {
            plan_to(Plan {
                name: "add_tables_and_columns".to_owned(),
                from,
                rename_tables: Vec::new(),
                rename_columns: Vec::new(),
                drop_tables: Vec::new(),
                drop_columns: Vec::new(),
                schema: target.clone(),
                schema_text: emit(target),
                to: String::new(),
            })
        })
        .and_then(|plan| plan_steps(start, &plan, dialect));
    match steps {
        Ok(steps) => AddTablesAndColumnsSteps { added, steps, differences: Vec::new() },
        Err(diagnostics) => none(diagnostics.iter().map(|d| format!("{}: {}", d.rule, d.message)).collect()),
    }
}
