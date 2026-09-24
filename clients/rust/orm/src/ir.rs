//! Value-free IR (docs/protocol.md). The serialized form is the plan-cache
//! key.

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
    /// insert only: parameters of each additional row in `set` column order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<Vec<usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optimistic: Option<Optimist>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub agg: String,
    pub n_params: usize,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Query {
    pub entity: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<Limit>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub force_index: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub lock: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub key_by: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub flatten: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub limit_per_parent: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_parent: Option<IfParent>,
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
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub expr: std::collections::BTreeMap<String, Expr>,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub r#fn: std::collections::BTreeMap<String, ColFunc>,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub sub: std::collections::BTreeMap<String, Sub>,
}

/// A raw fragment with `{column}` references and `?` placeholders.
#[derive(Serialize, Debug, Clone, Default)]
pub struct Expr {
    pub sql: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ps: Vec<usize>,
}

/// An ORM function and the indices of its bound arguments.
#[derive(Serialize, Debug, Clone, Default)]
pub struct Func {
    pub name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ps: Vec<usize>,
}

/// A column function applied to a column of the query's entity.
#[derive(Serialize, Debug, Clone, Default)]
pub struct ColFunc {
    pub column: String,
    pub r#fn: Func,
}

/// A subquery: one column for IN lists and scalar columns, or an aggregate.
#[derive(Serialize, Debug, Clone, Default)]
pub struct Sub {
    pub query: Box<Query>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub column: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub agg: String,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Join {
    pub rel: String,
    pub kind: String,
    pub query: Box<Query>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub left: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub right: String,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Relation {
    pub rel: String,
    pub query: Box<Query>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub left: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub right: String,
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
    Pred { pred: Box<Pred> },
    Group { group: Group },
    Joined { joined: JoinedRef },
}

/// Places the where conditions of the named join as a group.
#[derive(Serialize, Debug, Clone, Default)]
pub struct JoinedRef {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub conn: String,
    pub join: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#fn: Option<Func>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Func>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cols: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<Sub>,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct ColRef {
    pub path: String,
    pub column: String,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Order {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub column: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub expr: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub desc: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub random: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#fn: Option<Func>,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct GroupExpr {
    pub expr: String,
    #[serde(rename = "as")]
    pub as_: String,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct Limit {
    pub offset: u32,
    pub count: u32,
}

#[derive(Serialize, Debug, Clone, Default)]
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

#[derive(Serialize, Debug, Clone, Default)]
pub struct Optimist {
    pub column: String,
    pub p: usize,
}
