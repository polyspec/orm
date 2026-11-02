//! The part of a dbspec document that Mermaid carries, which the recipe helper and the dbspec compare example check a Mermaid
//! round trip by.

use polyspec_orm::dbspec::model::{DefaultValue, Name};
use polyspec_orm::dbspec::Document;

/// The tables, columns, primary keys and foreign keys that Mermaid carries, in table-name order, written as lines. Foreign key
/// actions are left out, since Mermaid does not carry them.
pub fn mermaid_skeleton(document: &Document) -> Vec<String> {
    let names = |list: &[Name]| list.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join(", ");
    let mut tables: Vec<_> = document.tables.iter().collect();
    tables.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    let mut out = Vec::new();
    for t in tables {
        out.push(format!("table {}", t.name.text));
        for c in &t.columns {
            let default = match &c.default {
                None => "-".to_owned(),
                Some(DefaultValue::Now) => "now".to_owned(),
                Some(DefaultValue::Literal(text)) => text.clone(),
            };
            out.push(format!("column {} {:?} null={} identity={} default={default}", c.name.text, c.ty, c.nullable, c.identity.is_some()));
        }
        for p in &t.primary {
            out.push(format!("primary key {}", names(&p.columns)));
        }
        let mut keys: Vec<_> = t.foreign_keys.iter().collect();
        keys.sort_by(|a, b| a.name.text.cmp(&b.name.text));
        for f in keys {
            out.push(format!("foreign key {} ({}) references {} ({})", f.name.text, names(&f.columns), f.table.text, names(&f.references)));
        }
    }
    out
}
