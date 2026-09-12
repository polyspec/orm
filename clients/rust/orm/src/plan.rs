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
    /// The plan-cache key of the plan this step belongs to (FNV-1a 64 of the IR shape bytes);
    /// set by the executor when the plan is cached, passed to the on_query hook.
    #[serde(skip)]
    pub plan_id: u64,
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
fn null_as_empty<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Vec<T>, D::Error> {
    Ok(Option::<Vec<T>>::deserialize(d)?.unwrap_or_default())
}

#[derive(Deserialize, Debug, Clone)]
pub struct ParentRef {
    pub step: u32,
    #[serde(default)]
    pub keys: Vec<KeyRef>,
    #[serde(default)]
    pub if_parent: Option<IfParent>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct KeyRef {
    pub column: String,
    pub index: usize,
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
    /// Style stages the dialect leaves to the executor for this value (aes/hex/ip on
    /// PostgreSQL/SQLite), applied to the bound value in write order. Empty on MySQL.
    #[serde(default)]
    pub host_styles: Vec<String>,
    #[serde(default)]
    pub col_type: String,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct Assemble {
    pub entity: String,
    pub alias: String,
    pub columns: Vec<OutCol>,
    #[serde(default)]
    pub key: Vec<KeyRef>,
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
    pub parent_keys: Vec<KeyRef>,
    #[serde(default)]
    pub child_keys: Vec<KeyRef>,
    #[serde(default)]
    pub key: Vec<KeyRef>,
    #[serde(default)]
    pub flatten: bool,
    /// The related rows hold this row's PK as their FK and no_cascade_delete was
    /// not set: delete_cascade removes them before this row.
    #[serde(default)]
    pub cascade: bool,
    #[serde(default)]
    pub assemble: Option<std::sync::Arc<Assemble>>,
}

impl Assemble {
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.columns
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.index)
    }

    /// Width of one positional row: this node's columns plus its joins'.
    pub fn total_columns(&self) -> usize {
        self.columns.len()
            + self
                .children
                .iter()
                .filter_map(|c| c.assemble.as_ref())
                .map(|a| a.total_columns())
                .sum::<usize>()
    }

    /// Whether this node loads relation `rel` (a join or a relation child).
    pub fn has_child(&self, rel: &str) -> bool {
        self.children.iter().any(|c| c.rel == rel)
    }

    /// The child spec of relation `rel`.
    pub fn child(&self, rel: &str) -> Option<&Child> {
        self.children.iter().find(|c| c.rel == rel)
    }
}
