//! The plan of a request (docs/protocol.md §2).

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub schema_hash: String,
    pub kind: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Default)]
pub struct Step {
    /// The plan-cache key of the plan this step belongs to (FNV-1a 64 of the IR shape bytes).
    pub plan_id: u64,
    pub id: u32,
    pub role: String,
    pub sql: String,
    pub lock: String,
    pub bind_slots: Vec<BindSlot>,
    pub assemble: Option<std::sync::Arc<Assemble>>,
    /// Relation steps: where the IN values come from.
    pub parent: Option<ParentRef>,
}

#[derive(Debug, Clone, Default)]
pub struct ParentRef {
    pub step: u32,
    pub keys: Vec<KeyRef>,
    pub if_parent: Option<IfParent>,
}

#[derive(Debug, Clone, Default)]
pub struct KeyRef {
    pub column: String,
    pub index: usize,
}

#[derive(Debug, Clone, Default)]
pub struct IfParent {
    pub column: String,
    pub index: usize,
    pub param: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BindSlot {
    pub from: String,
    pub param: usize,
    pub transform: String,
    pub name: String,
    pub step: u32,
    pub column: String,
    /// Style stages the dialect leaves to the executor for this value (aes/hex/ip on
    /// PostgreSQL/SQLite), applied to the bound value in write order. Empty on MySQL.
    pub host_styles: Vec<String>,
    pub col_type: String,
}

#[derive(Debug, Clone, Default)]
pub struct Assemble {
    pub entity: String,
    pub alias: String,
    pub columns: Vec<OutCol>,
    pub key: Vec<KeyRef>,
    pub children: Vec<Child>,
}

#[derive(Debug, Clone, Default)]
pub struct OutCol {
    pub index: usize,
    pub name: String,
    pub column: String,
    pub typ: String,
    pub styles: Vec<String>,
    pub hidden: bool,
}

/// A joined entity's slice of the same row (kind join, `assemble` set) or a
/// relation step's rows attached by key (kind one/many, `step` set).
#[derive(Debug, Clone, Default)]
pub struct Child {
    pub rel: String,
    pub kind: String,
    pub step: u32,
    pub parent_keys: Vec<KeyRef>,
    pub child_keys: Vec<KeyRef>,
    pub key: Vec<KeyRef>,
    pub flatten: bool,
    /// The related rows hold this row's PK as their FK and no_cascade_delete was
    /// not set: delete_cascade removes them before this row.
    pub cascade: bool,
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
