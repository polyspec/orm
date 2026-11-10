//! The statements that convert the uuid columns in the text storage of a release up to 0.0.28 to 16 bytes
//! (docs/spec/plans.md PLN-108 to PLN-110). dbspec apply reads what the statements depend on from the database and
//! runs them before the drift check.

use super::model::{DefaultValue, Document, ForeignKey, Table};
use super::names::renderer_name;
use super::plan_steps::REBUILD_TABLE;
use super::render::{Dialect, Renderer};
use std::collections::{BTreeMap, BTreeSet};

/// The savepoint of the SQLite rebuild of a table in the text storage of a uuid (PLN-110).
pub const CONVERT_SAVEPOINT: &str = "\"dbspec$convert\"";

/// The uuid columns in text storage of the tables that hold one, by table, as introspection reports them.
pub type TextStorage = BTreeMap<String, Vec<String>>;

/// What the MySQL and MariaDB conversion reads from the database before it writes its statements (PLN-109).
#[derive(Clone, Debug, Default)]
pub struct MySqlTextStorage {
    /// The state foreign keys that the database lacks, by table: a foreign key that an earlier conversion dropped.
    pub missing: BTreeMap<String, Vec<ForeignKey>>,
    /// The COLUMN_TYPE of each column in text storage by table and column: char(36), or varbinary(36) of a conversion
    /// that stopped.
    pub column_types: BTreeMap<String, BTreeMap<String, String>>,
    /// The table and column of each column in text storage that holds a 36-byte text.
    pub texts: BTreeSet<(String, String)>,
}

fn document_table<'d>(d: &'d Document, name: &str) -> Option<&'d Table> {
    d.tables.iter().find(|t| t.name.text == name)
}

fn state_table<'d>(d: &'d Document, name: &str) -> &'d Table {
    document_table(d, name).expect("a table in text storage is a table of the state")
}

/// The columns of table `t` among `names`, in the order of the state table.
fn state_column_order<'d>(state: &'d Document, t: &str, names: &[String]) -> Vec<&'d str> {
    state_table(state, t).columns.iter().filter(|c| names.contains(&c.name.text)).map(|c| c.name.text.as_str()).collect()
}

fn sorted_by_name(keys: &[ForeignKey]) -> Vec<&ForeignKey> {
    let mut sorted: Vec<&ForeignKey> = keys.iter().collect();
    sorted.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    sorted
}

/// The statements of PLN-109 on MySQL and MariaDB, from the storage that the database has now, so that a command that
/// stopped between two statements writes the statements that remain.
pub fn mysql_uuid_conversion(state: &Document, text: &TextStorage, read: &MySqlTextStorage) -> Vec<String> {
    let r = Renderer { d: Dialect::MySql };
    let q = |name: &str| r.q(name);
    let tables: Vec<&String> = text.keys().collect();
    let text_column = |table: &str, column: &str| text.get(table).is_some_and(|columns| columns.iter().any(|c| c == column));
    let mut out = Vec::new();
    // 1. The foreign keys of the state that the database has and whose columns or referenced columns are in text storage.
    let mut dropped: BTreeMap<String, Vec<ForeignKey>> = BTreeMap::new();
    let mut state_tables: Vec<&Table> = state.tables.iter().collect();
    state_tables.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    for st in state_tables {
        for f in sorted_by_name(&st.foreign_keys) {
            if read.missing.get(&st.name.text).is_some_and(|keys| keys.iter().any(|g| g.name.text == f.name.text)) {
                continue;
            }
            let uses = f.columns.iter().any(|c| text_column(&st.name.text, &c.text)) || f.references.iter().any(|c| text_column(&f.table.text, &c.text));
            if uses {
                out.push(format!("ALTER TABLE {} DROP FOREIGN KEY {}", q(&st.name.text), q(&f.name.text)));
                dropped.entry(st.name.text.clone()).or_default().push(f.clone());
            }
        }
    }
    for (t, keys) in &read.missing {
        dropped.entry(t.clone()).or_default().extend(keys.iter().cloned());
    }
    let column = |table: &str, name: &str| state_table(state, table).column(name).expect("a column in text storage is a column of the state").clone();
    let text_definition = |table: &str, name: &str| {
        let c = column(table, name);
        let mut s = format!("{} VARBINARY(36) {}", q(&c.name.text), if c.nullable { "NULL" } else { "NOT NULL" });
        if let Some(DefaultValue::Literal(literal)) = &c.default {
            s.push_str(&format!(" DEFAULT {literal}"));
        }
        s
    };
    // 2. Each char(36) column becomes varbinary(36), which holds both forms.
    for t in &tables {
        for c in state_column_order(state, t, &text[*t]) {
            if read.column_types.get(*t).and_then(|types| types.get(c)).map(String::as_str) != Some("char(36)") {
                continue;
            }
            let check = q(&renderer_name(t, c));
            out.push(format!(
                "ALTER TABLE {} DROP CONSTRAINT {check}, MODIFY COLUMN {}, ADD CONSTRAINT {check} CHECK (length({}) IN (16, 36))",
                q(t),
                text_definition(t, c),
                q(c)
            ));
        }
    }
    // 3. The texts become their 16 bytes.
    for t in &tables {
        for c in state_column_order(state, t, &text[*t]) {
            if read.texts.contains(&((*t).clone(), c.to_owned())) {
                out.push(format!("UPDATE {} SET {} = UNHEX(REPLACE({}, '-', '')) WHERE length({}) = 36", q(t), q(c), q(c), q(c)));
            }
        }
    }
    // 4. Each table gets its rendered form, a referenced table before the tables that reference it, with its dropped
    // foreign keys whose referenced table has its rendered form.
    let mut pending: BTreeSet<&str> = tables.iter().map(|t| t.as_str()).collect();
    let mut added: BTreeSet<(String, String)> = BTreeSet::new();
    while !pending.is_empty() {
        // A cycle of such tables takes the first of them by name; its foreign keys to a pending table are added last.
        let ready =
            pending.iter().copied().find(|t| !state_table(state, t).foreign_keys.iter().any(|f| f.table.text != *t && pending.contains(f.table.text.as_str())));
        let next = ready.or_else(|| pending.iter().next().copied()).expect("a pending table");
        pending.remove(next);
        let mut parts = Vec::new();
        for c in state_column_order(state, next, &text[next]) {
            let check = q(&renderer_name(next, c));
            let col = column(next, c);
            parts.push(format!("DROP CONSTRAINT {check}"));
            parts.push(format!("MODIFY COLUMN {}", r.column(&col)));
            parts.push(format!("ADD CONSTRAINT {check} CHECK ({})", r.type_check(&col).expect("a uuid column has a renderer CHECK on MySQL")));
        }
        for f in sorted_by_name(dropped.get(next).map_or(&[], Vec::as_slice)) {
            if !pending.contains(f.table.text.as_str()) {
                parts.push(format!("ADD {}", r.foreign_key(f)));
                added.insert((next.to_owned(), f.name.text.clone()));
            }
        }
        out.push(format!("ALTER TABLE {} {}", q(next), parts.join(", ")));
    }
    // 5. A foreign key of a cycle, and one of a table without text storage, is added last.
    for (t, keys) in &dropped {
        for f in sorted_by_name(keys) {
            if !added.contains(&(t.clone(), f.name.text.clone())) {
                out.push(format!("ALTER TABLE {} ADD {}", q(t), r.foreign_key(f)));
            }
        }
    }
    out
}

/// The statements of PLN-110: each table that holds a column in text storage, in name order, is rebuilt in its rendered
/// form inside one savepoint.
pub fn sqlite_uuid_conversion(state: &Document, text: &TextStorage) -> Vec<String> {
    let r = Renderer { d: Dialect::Sqlite };
    let mut out = Vec::new();
    for (name, columns) in text {
        let t = state_table(state, name);
        out.push(format!("SAVEPOINT {CONVERT_SAVEPOINT}"));
        out.push(r.create_table(t, REBUILD_TABLE, &|c: &str| renderer_name(&t.name.text, c), &[]));
        if t.columns.iter().any(|c| c.identity.is_some()) {
            out.push(format!("INSERT INTO sqlite_sequence (name, seq) SELECT '{REBUILD_TABLE}', seq FROM sqlite_sequence WHERE name = '{name}'"));
        }
        let into: Vec<String> = t.columns.iter().map(|c| r.q(&c.name.text)).collect();
        let from: Vec<String> = t
            .columns
            .iter()
            .map(|c| if columns.contains(&c.name.text) { format!("unhex(replace({}, '-', ''))", r.q(&c.name.text)) } else { r.q(&c.name.text) })
            .collect();
        out.push(format!("INSERT INTO {} ({}) SELECT {} FROM {}", r.q(REBUILD_TABLE), into.join(", "), from.join(", "), r.q(name)));
        out.push(format!("DROP TABLE {}", r.q(name)));
        out.push(format!("ALTER TABLE {} RENAME TO {}", r.q(REBUILD_TABLE), r.q(name)));
        out.extend(r.table(t).into_iter().skip(1));
        out.extend(r.triggers(t));
        out.push(format!("RELEASE {CONVERT_SAVEPOINT}"));
    }
    out
}
