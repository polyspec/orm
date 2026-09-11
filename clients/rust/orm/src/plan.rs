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
    pub bind_slots: Vec<BindSlot>,
    #[serde(default)]
    pub assemble: Option<std::sync::Arc<Assemble>>,
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
}

#[derive(Deserialize, Debug, Clone)]
pub struct Child {
    pub rel: String,
    pub kind: String,
    #[serde(default)]
    pub step: u32,
    #[serde(default)]
    pub parent_column: String,
    #[serde(default)]
    pub child_column: String,
    #[serde(default)]
    pub key_by: String,
    #[serde(default)]
    pub flatten: bool,
    #[serde(default)]
    pub drop_child_key: bool,
    pub assemble: Assemble,
}

impl Assemble {
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.columns.iter().find(|c| c.name == name).map(|c| c.index)
    }

    pub fn total_columns(&self) -> usize {
        self.columns.len() + self.children.iter().map(|c| c.assemble.total_columns()).sum::<usize>()
    }
}
