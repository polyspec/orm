//! Plan as returned by the engine (docs/protocol.md §2).

use serde::Deserialize;

#[derive(Deserialize, Debug, Clone)]
pub struct Plan {
    pub schema_hash: String,
    pub kind: String,
    pub steps: Vec<Step>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Step {
    pub id: u32,
    pub role: String,
    pub sql: String,
    /// `null` from the engine when the statement binds nothing (a Go nil slice).
    #[serde(default, deserialize_with = "null_as_empty")]
    pub bind_slots: Vec<BindSlot>,
    #[serde(default)]
    pub assemble: Option<std::sync::Arc<Assemble>>,
    /// Relation steps: where the IN values come from.
    #[serde(default)]
    pub parent: Option<ParentRef>,
}

/// Go marshals a nil slice as `null`; read it as an empty list.
fn null_as_empty<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> std::result::Result<Vec<T>, D::Error> {
    Ok(Option::<Vec<T>>::deserialize(d)?.unwrap_or_default())
}

#[derive(Deserialize, Debug, Clone)]
pub struct ParentRef {
    pub step: u32,
    #[serde(default)]
    pub column: String,
    pub index: usize,
    #[serde(default)]
    pub if_parent: Option<IfParent>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct IfParent {
    #[serde(default)]
    pub column: String,
    pub index: usize,
    pub param: usize,
}

#[derive(Deserialize, Debug, Clone)]
pub struct BindSlot {
    pub from: String,
    #[serde(default)]
    pub param: usize,
    #[serde(default)]
    pub transform: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub step: u32,
    #[serde(default)]
    pub column: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Assemble {
    pub entity: String,
    pub alias: String,
    pub columns: Vec<OutCol>,
    #[serde(default)]
    pub children: Vec<Child>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct OutCol {
    pub index: usize,
    pub name: String,
    #[serde(default)]
    pub column: String,
    #[serde(rename = "type")]
    pub typ: String,
    #[serde(default)]
    pub styles: Vec<String>,
    #[serde(default)]
    pub hidden: bool,
}

/// A joined entity's slice of the same row (kind join, `assemble` set) or a
/// relation step's rows attached by key (kind one/many, `step` set).
#[derive(Deserialize, Debug, Clone)]
pub struct Child {
    pub rel: String,
    pub kind: String,
    #[serde(default)]
    pub step: u32,
    #[serde(default)]
    pub parent_column: String,
    #[serde(default)]
    pub parent_index: usize,
    #[serde(default)]
    pub child_column: String,
    #[serde(default)]
    pub child_index: usize,
    #[serde(default)]
    pub key_by: String,
    #[serde(default)]
    pub key_index: usize,
    #[serde(default)]
    pub flatten: bool,
    /// The related rows hold this row's PK as their FK and no_cascade_delete was
    /// not set: delete_cascade removes them before this row.
    #[serde(default)]
    pub cascade: bool,
    #[serde(default)]
    pub assemble: Option<Assemble>,
}

impl Assemble {
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.columns.iter().find(|c| c.name == name).map(|c| c.index)
    }

    /// Width of one positional row: this node's columns plus its joins'.
    pub fn total_columns(&self) -> usize {
        self.columns.len() + self.children.iter().filter_map(|c| c.assemble.as_ref()).map(|a| a.total_columns()).sum::<usize>()
    }
}
