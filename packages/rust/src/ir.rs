//! Value-free IR (docs/spec/protocol.md). The serialized form is the plan-cache
//! key.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Request {
    pub ir_version: u32,
    pub manifest_hash: String,
    pub kind: String,
    #[serde(flatten)]
    pub query: Query,
    /// insert only: the rows keep their stored keys. The identity column takes a value, which a
    /// table with an identity requires; not valid with `on_duplicate`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub load: bool,
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

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
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

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Columns {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mode: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub add: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub remove: Vec<String>,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub r#fn: std::collections::BTreeMap<String, ColFunc>,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub sub: std::collections::BTreeMap<String, Sub>,
}

/// An ORM function and the indices of its bound arguments.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Func {
    pub name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ps: Vec<usize>,
}

/// A column function applied to a column of the query's entity.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ColFunc {
    pub column: String,
    pub r#fn: Func,
}

/// A subquery: one column for IN lists and scalar columns, or an aggregate.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Sub {
    pub query: Box<Query>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub column: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub agg: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Join {
    pub rel: String,
    pub kind: String,
    pub query: Box<Query>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub left: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub right: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Relation {
    pub rel: String,
    pub query: Box<Query>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<KeyPair>,
}

/// One component of a relation key: parent column `left` equals child column `right`.
/// The relation of a composite key holds one pair per component, in key order.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct KeyPair {
    pub left: String,
    pub right: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Group {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub conn: String,
    /// A nested group negated as a whole: NOT (…). The top-level where and on groups are not negated.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub not: bool,
    pub items: Vec<Item>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum Item {
    Pred { pred: Box<Pred> },
    Group { group: Group },
    Joined { joined: JoinedRef },
}

/// Places the where conditions of the named join as a group.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct JoinedRef {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub conn: String,
    pub join: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#fn: Option<Func>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Func>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cols: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<Sub>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ColRef {
    pub path: String,
    pub column: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Order {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub column: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub desc: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub random: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#fn: Option<Func>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum Limit {
    Literal { offset: u32, count: u32 },
    Params { offset_p: usize, count_p: usize },
}

impl Limit {
    pub(crate) fn literal_count(&self) -> Option<u32> {
        match self {
            Self::Literal { count, .. } => Some(*count),
            Self::Params { .. } => None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct IfParent {
    pub column: String,
    pub p: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Assign {
    pub column: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p: Option<usize>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub null: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plus_p: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minus_p: Option<usize>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Optimist {
    pub column: String,
    pub p: usize,
}

/// The version of the request form that the core validates (docs/spec/flowmark-surface.md FMS-36).
pub const VERSION: u32 = 1;

impl Request {
    /// The request of its JSON text (FMS-31). An absent member of the form has its default, except a member of a limit.
    /// A text that is no JSON object, a member that the form does not have, a member that is `null`, a member of
    /// another type and text after the object are `ir_invalid`.
    pub fn from_json(text: &str) -> crate::Result<Request> {
        let value: serde_json::Value = serde_json::from_str(text).map_err(|error| not_of_the_form(format!("the request is no JSON text: {error}")))?;
        form::check(form::Form::Request, &value, "request").map_err(not_of_the_form)?;
        serde_json::from_value(value).map_err(|error| not_of_the_form(format!("the request is not of its form: {error}")))
    }
}

fn not_of_the_form(message: String) -> crate::Error {
    crate::Error::new(crate::Kind::IrInvalid, message)
}

/// The members of the request form (FMS-31, `contracts/interface/flowmark/ir.schema.json`). The reader of serde takes
/// a member that the form does not have and reads `null` as an absent member; this check refuses both before it.
mod form {
    use serde_json::Value;

    /// An object of the form.
    #[derive(Clone, Copy)]
    pub(super) enum Form {
        Request,
        Query,
        Columns,
        Func,
        ColFunc,
        Sub,
        Join,
        Relation,
        KeyPair,
        Group,
        Item,
        JoinedRef,
        Pred,
        ColRef,
        Order,
        Limit,
        IfParent,
        Assign,
        Optimist,
    }

    /// What a member holds.
    #[derive(Clone, Copy)]
    enum Member {
        /// A text, a number, a boolean, or a list of them.
        Plain,
        One(Form),
        List(Form),
        /// An object whose member names are free and whose members are objects of one form.
        Map(Form),
    }

    const QUERY: &[(&str, Member)] = &[
        ("entity", Member::Plain),
        ("columns", Member::One(Form::Columns)),
        ("on", Member::One(Form::Group)),
        ("where", Member::One(Form::Group)),
        ("joins", Member::List(Form::Join)),
        ("relations", Member::List(Form::Relation)),
        ("order", Member::List(Form::Order)),
        ("group_by", Member::Plain),
        ("limit", Member::One(Form::Limit)),
        ("force_index", Member::Plain),
        ("lock", Member::Plain),
        ("key_by", Member::Plain),
        ("flatten", Member::Plain),
        ("limit_per_parent", Member::Plain),
        ("if_parent", Member::One(Form::IfParent)),
        ("no_cascade_delete", Member::Plain),
    ];

    /// The members of a request beside those of its query.
    const REQUEST: &[(&str, Member)] = &[
        ("ir_version", Member::Plain),
        ("manifest_hash", Member::Plain),
        ("kind", Member::Plain),
        ("load", Member::Plain),
        ("set", Member::List(Form::Assign)),
        ("on_duplicate", Member::List(Form::Assign)),
        ("rows", Member::Plain),
        ("optimistic", Member::One(Form::Optimist)),
        ("agg", Member::Plain),
        ("n_params", Member::Plain),
    ];

    fn members(form: Form) -> &'static [(&'static str, Member)] {
        match form {
            Form::Request => REQUEST,
            Form::Query => QUERY,
            Form::Columns => &[
                ("mode", Member::Plain),
                ("add", Member::Plain),
                ("remove", Member::Plain),
                ("fn", Member::Map(Form::ColFunc)),
                ("sub", Member::Map(Form::Sub)),
            ],
            Form::Func => &[("name", Member::Plain), ("ps", Member::Plain)],
            Form::ColFunc => &[("column", Member::Plain), ("fn", Member::One(Form::Func))],
            Form::Sub => &[("query", Member::One(Form::Query)), ("column", Member::Plain), ("agg", Member::Plain)],
            Form::Join => {
                &[("rel", Member::Plain), ("kind", Member::Plain), ("query", Member::One(Form::Query)), ("left", Member::Plain), ("right", Member::Plain)]
            }
            Form::Relation => &[("rel", Member::Plain), ("query", Member::One(Form::Query)), ("kind", Member::Plain), ("keys", Member::List(Form::KeyPair))],
            Form::KeyPair => &[("left", Member::Plain), ("right", Member::Plain)],
            Form::Group => &[("conn", Member::Plain), ("not", Member::Plain), ("items", Member::List(Form::Item))],
            Form::Item => &[("pred", Member::One(Form::Pred)), ("group", Member::One(Form::Group)), ("joined", Member::One(Form::JoinedRef))],
            Form::JoinedRef => &[("conn", Member::Plain), ("join", Member::Plain)],
            Form::Pred => &[
                ("conn", Member::Plain),
                ("column", Member::Plain),
                ("op", Member::Plain),
                ("p", Member::Plain),
                ("ps", Member::Plain),
                ("ref", Member::One(Form::ColRef)),
                ("fn", Member::One(Form::Func)),
                ("value", Member::One(Form::Func)),
                ("cols", Member::Plain),
                ("sub", Member::One(Form::Sub)),
            ],
            Form::ColRef => &[("path", Member::Plain), ("column", Member::Plain)],
            Form::Order => &[("column", Member::Plain), ("desc", Member::Plain), ("random", Member::Plain), ("fn", Member::One(Form::Func))],
            Form::Limit => &[("offset", Member::Plain), ("count", Member::Plain), ("offset_p", Member::Plain), ("count_p", Member::Plain)],
            Form::IfParent => &[("column", Member::Plain), ("p", Member::Plain)],
            Form::Assign => {
                &[("column", Member::Plain), ("p", Member::Plain), ("null", Member::Plain), ("plus_p", Member::Plain), ("minus_p", Member::Plain)]
            }
            Form::Optimist => &[("column", Member::Plain), ("p", Member::Plain)],
        }
    }

    /// The member `key` of an object of the form `form`; the members of a query are members of a request.
    fn member(form: Form, key: &str) -> Option<Member> {
        let own = members(form).iter().find(|(name, _)| *name == key).map(|(_, member)| *member);
        match form {
            Form::Request => own.or_else(|| member(Form::Query, key)),
            _ => own,
        }
    }

    /// Checks that `value` is an object of the form `form`, at the place `at` of the request.
    pub(super) fn check(form: Form, value: &Value, at: &str) -> Result<(), String> {
        let Value::Object(object) = value else { return Err(format!("{at} is no object")) };
        for (key, held) in object {
            let at = format!("{at}.{key}");
            let Some(member) = member(form, key) else { return Err(format!("{at} is no member of the form")) };
            match member {
                Member::Plain => plain(held, &at)?,
                Member::One(inner) => check(inner, held, &at)?,
                Member::List(inner) => {
                    let Value::Array(items) = held else { return Err(format!("{at} is no list")) };
                    for (index, item) in items.iter().enumerate() {
                        check(inner, item, &format!("{at}[{index}]"))?;
                    }
                }
                Member::Map(inner) => {
                    let Value::Object(entries) = held else { return Err(format!("{at} is no object")) };
                    for (name, entry) in entries {
                        check(inner, entry, &format!("{at}.{name}"))?;
                    }
                }
            }
        }
        let holds = |key: &str| object.contains_key(key);
        match form {
            // An item is an object of exactly one of its three members.
            Form::Item if object.len() != 1 => Err(format!("{at} holds {} members; an item holds one of pred, group and joined", object.len())),
            // A limit is the pair of its literals or the pair of its parameters, with both members.
            Form::Limit if !(object.len() == 2 && ((holds("offset") && holds("count")) || (holds("offset_p") && holds("count_p")))) => {
                Err(format!("{at} is neither the pair offset and count nor the pair offset_p and count_p"))
            }
            _ => Ok(()),
        }
    }

    /// A member that holds no object of the form: `null` is no value of it, in a list either.
    fn plain(value: &Value, at: &str) -> Result<(), String> {
        match value {
            Value::Null => Err(format!("{at} is null; an absent member is its default")),
            Value::Array(items) => items.iter().enumerate().try_for_each(|(index, item)| plain(item, &format!("{at}[{index}]"))),
            _ => Ok(()),
        }
    }
}
