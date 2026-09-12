//! Value-free IR (docs/protocol.md). Mirrors engine/ir/ir.go; serialized with
//! the same field names so the engine validates it as-is.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, Default)]
pub struct Request {
    pub ir_version: u32,
    pub schema_hash: String,
    pub kind: String,
    #[serde(flatten)]
    pub query: Query,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub set: Vec<Assign>,
    /// insert only: assignments applied when the unique key already exists (never PK/auto).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub on_duplicate: Vec<Assign>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optimistic: Option<Optimist>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub agg: String,
    /// kind raw: a hand-written SELECT run as the root (`{table}` = the entity table, `?` bound from ps).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Raw>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub debug: bool,
    pub n_params: usize,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Raw {
    pub sql: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ps: Vec<usize>,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Query {
    pub entity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_p: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Columns>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<Group>,
    #[serde(rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_: Option<Group>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub joins: Vec<Join>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub relations: Vec<Relation>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<Order>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub group_by: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub group_by_expr: Vec<GroupExpr>,
    /// Root only, needs group_by: group predicates (aggregate expressions as expr items).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub having: Option<Group>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<Limit>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub distinct: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub force_index: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub key_by: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub flatten: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub limit_per_parent: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_parent: Option<IfParent>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub drop_child_key: bool,
    /// delete_cascade stops at this relation (plan children[].cascade = false).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_cascade_delete: bool,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Columns {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mode: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub add: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub remove: Vec<String>,
    #[serde(rename = "as", skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub as_: std::collections::BTreeMap<String, String>,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub expr: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct Join {
    pub rel: String,
    pub kind: String,
    pub query: Box<Query>,
}

#[derive(Serialize, Debug, Clone)]
pub struct Relation {
    pub rel: String,
    pub query: Box<Query>,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Group {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub conn: String,
    pub items: Vec<Item>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum Item {
    Pred { pred: Pred },
    Group { group: Group },
    Nav { nav: Nav },
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Pred {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub conn: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub column: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ps: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<ColRef>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub expr: String,
    #[serde(rename = "match", skip_serializing_if = "Vec::is_empty")]
    pub match_: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ColRef {
    pub path: String,
    pub column: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Nav {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub conn: String,
    pub rel: String,
    pub group: Group,
}

#[derive(Serialize, Debug, Clone)]
pub struct Order {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub column: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub expr: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub desc: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct GroupExpr {
    pub expr: String,
    #[serde(rename = "as")]
    pub as_: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Limit {
    pub offset: u32,
    pub count: u32,
}

#[derive(Serialize, Debug, Clone)]
pub struct IfParent {
    pub column: String,
    pub p: usize,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Assign {
    pub column: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p: Option<usize>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub null: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub expr: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ps: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plus_p: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minus_p: Option<usize>,
}

#[derive(Serialize, Debug, Clone)]
pub struct Optimist {
    pub column: String,
    pub p: usize,
}

impl Query {
    /// Shift every parameter index by `off` (used when attaching a child query).
    pub fn shift(&mut self, off: usize) {
        if let Some(p) = self.scope_p.as_mut() { *p += off; }
        if let Some(g) = self.on.as_mut() {
            g.shift(off);
        }
        if let Some(g) = self.where_.as_mut() {
            g.shift(off);
        }
        if let Some(g) = self.having.as_mut() {
            g.shift(off);
        }
        for j in &mut self.joins {
            j.query.shift(off);
        }
        for r in &mut self.relations {
            r.query.shift(off);
        }
        if let Some(ip) = self.if_parent.as_mut() {
            ip.p += off;
        }
    }
}

impl Group {
    fn shift(&mut self, off: usize) {
        for it in &mut self.items {
            match it {
                Item::Pred { pred } => {
                    if let Some(p) = pred.p.as_mut() {
                        *p += off;
                    }
                    for p in &mut pred.ps {
                        *p += off;
                    }
                }
                Item::Group { group } => group.shift(off),
                Item::Nav { nav } => nav.group.shift(off),
            }
        }
    }
}
