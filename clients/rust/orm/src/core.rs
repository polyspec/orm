//! The state shared by every generated model: the query under construction and,
//! for a loaded row, the row state.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use indexmap::IndexMap;

use crate::args::{Func, Value};
use crate::db::Db;
use crate::model::{AnyModel, Entity, RowState};
use crate::value::Param;
use crate::{codes, Error};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// One key of a generated chain method.
#[derive(Debug, Clone, Copy)]
pub struct ChainKey {
    /// Connector before this key; empty for the first key.
    pub conn: &'static str,
    /// "", ne, gt, lt, ge, le, lk, lb, between, fulltext, fulltext_boolean, tuple, ne_tuple.
    pub op: &'static str,
    pub column: &'static str,
    pub columns: &'static [&'static str],
    /// Column of the passed model for a column comparison.
    pub compare: &'static str,
}

impl ChainKey {
    pub const EMPTY: ChainKey = ChainKey { conn: "", op: "", column: "", columns: &[], compare: "" };
}

/// A condition value passed to a chain method.
pub enum Arg {
    Value(Value),
    /// A column function and its compared value.
    Function(Func, Param),
    /// The identity of a model compared column by column.
    Model(u64),
    Tuples(Vec<Vec<Param>>),
    Text(String),
}

#[derive(Clone)]
pub(crate) struct CondNode {
    pub conn: &'static str,
    pub kind: CondKind,
}

#[derive(Clone)]
pub(crate) enum CondKind {
    Pred(PredSpec),
    Group(Vec<CondNode>),
    Joined(u64),
    Raw(RawSpec),
}

#[derive(Clone, Default)]
pub(crate) struct CondGroup {
    pub items: Vec<CondNode>,
    pub pending: &'static str,
}

#[derive(Clone)]
pub(crate) struct PredSpec {
    pub column: String,
    pub op: &'static str,
    pub value: PredValue,
}

#[derive(Clone)]
pub(crate) enum PredValue {
    None,
    One(Param),
    List(Vec<Param>),
    Pair(Param, Param),
    Tuples(Vec<&'static str>, Vec<Vec<Param>>),
    Match(Vec<&'static str>, Param),
    Ref(u64, &'static str),
    Sub(Box<Core>),
    ColumnFn(Func, Param),
    ValueFn(Func),
}

#[derive(Clone)]
pub(crate) struct RawSpec {
    pub sql: String,
    pub binds: Vec<Param>,
}

#[derive(Clone)]
pub(crate) struct JoinSpec {
    pub kind: &'static str,
    pub left: String,
    pub right: String,
    pub child: Box<Core>,
}

#[derive(Clone)]
pub(crate) struct RelSpec {
    pub many: bool,
    pub child: Box<Core>,
}

pub type SubFn = Arc<dyn Fn(&Core) -> Core + Send + Sync>;
pub type KeyFn = Arc<dyn Fn(&dyn AnyModel) -> crate::collection::Key + Send + Sync>;
pub type ValueFn = Arc<dyn Fn(&dyn AnyModel) -> serde_json::Value + Send + Sync>;

#[derive(Clone)]
pub(crate) enum Added {
    Format(String, String),
    Func(String, Func),
    Sub(SubFn),
    Raw(RawSpec),
}

#[derive(Clone, Default)]
pub(crate) struct Columns {
    pub mode: &'static str,
    pub add: Vec<String>,
    pub remove: Vec<String>,
    pub added: IndexMap<String, Added>,
}

#[derive(Clone)]
pub(crate) struct OrderSpec {
    pub column: String,
    pub desc: bool,
    pub func: Option<Func>,
    pub random: bool,
    pub raw: Option<String>,
}

#[derive(Clone)]
pub(crate) enum SetValue {
    Value(Param),
    Json(serde_json::Value),
    Ordered(ordered_json::Value),
    Null,
    Raw(RawSpec),
    Plus(Param),
    Minus(Param),
}

#[derive(Clone)]
pub(crate) struct SetSpec {
    pub column: String,
    pub value: SetValue,
}

/// The builder and row state of one model. Clones keep the identity, so a
/// joined model can be passed to a join and later referenced by condition.
#[derive(Clone)]
pub struct Core {
    pub(crate) id: u64,
    pub(crate) ent: &'static Entity,
    pub(crate) conn: Option<Db>,
    pub(crate) err: Option<(String, String)>,
    pub(crate) group: bool,
    pub(crate) subject: Option<u64>,

    pub(crate) where_: CondGroup,
    pub(crate) on: Option<Vec<CondNode>>,
    pub(crate) joins: Vec<JoinSpec>,
    pub(crate) relations: Vec<RelSpec>,
    pub(crate) columns: Columns,
    pub(crate) order: Vec<OrderSpec>,
    pub(crate) group_by: Vec<String>,
    pub(crate) group_raw: Vec<String>,
    pub(crate) limit: Option<(u32, u32)>,
    pub(crate) index: String,
    pub(crate) lock: &'static str,
    pub(crate) agg: String,
    pub(crate) agg_fn: &'static str,

    pub(crate) match_left: String,
    pub(crate) match_right: String,
    pub(crate) alias: String,
    pub(crate) parent_node: bool,
    pub(crate) possible: Option<(String, Param)>,
    pub(crate) group_limit: u32,
    pub(crate) delete_lock: bool,
    pub(crate) key_name: String,
    pub(crate) fetch_key: Option<KeyFn>,
    pub(crate) fetch_value: Option<ValueFn>,

    pub(crate) sets: Vec<SetSpec>,
    pub(crate) news: IndexMap<String, serde_json::Value>,
    pub(crate) duplication: Option<Box<Core>>,

    pub(crate) row: Option<RowState>,
}

pub(crate) fn config(msg: impl Into<String>) -> Error {
    Error::Engine { code: codes::CONFIG.into(), msg: msg.into() }
}

impl Core {
    /// Creates the core of a new model. Generated constructors call it.
    pub fn new(ent: &'static Entity) -> Core {
        Core {
            id: next_id(),
            ent,
            conn: None,
            err: None,
            group: false,
            subject: None,
            where_: CondGroup::default(),
            on: None,
            joins: Vec::new(),
            relations: Vec::new(),
            columns: Columns::default(),
            order: Vec::new(),
            group_by: Vec::new(),
            group_raw: Vec::new(),
            limit: None,
            index: String::new(),
            lock: "",
            agg: String::new(),
            agg_fn: "",
            match_left: String::new(),
            match_right: String::new(),
            alias: String::new(),
            parent_node: false,
            possible: None,
            group_limit: 0,
            delete_lock: false,
            key_name: String::new(),
            fetch_key: None,
            fetch_value: None,
            sets: Vec::new(),
            news: IndexMap::new(),
            duplication: None,
            row: None,
        }
    }

    /// The model descriptor.
    pub fn entity(&self) -> &'static Entity {
        self.ent
    }

    /// The first recorded builder error.
    pub fn err(&self) -> Option<Error> {
        self.err.as_ref().map(|(code, msg)| Error::Engine { code: code.clone(), msg: msg.clone() })
    }

    pub(crate) fn fail(&mut self, msg: impl Into<String>) {
        if self.err.is_none() {
            self.err = Some((codes::CONFIG.into(), msg.into()));
        }
    }

    pub(crate) fn fail_err(&mut self, e: Error) {
        if self.err.is_none() {
            self.err = Some((e.code().to_owned(), e.to_string()));
        }
    }

    /// The model a group callback stands for.
    pub(crate) fn subject_id(&self) -> u64 {
        self.subject.unwrap_or(self.id)
    }

    /// The identity of the model.
    pub fn id(&self) -> u64 {
        self.id
    }

    /// Sets the connection of a model or a loaded row.
    pub fn connect(&mut self, db: &Db) {
        if self.group {
            self.fail("connect is not allowed inside a group callback");
            return;
        }
        self.conn = Some(db.clone());
    }

    /// Creates the core passed to an and/or group or an on callback.
    pub fn group(&self) -> Core {
        let mut g = Core::new(self.ent);
        g.group = true;
        g.subject = Some(self.subject_id());
        g
    }

    fn add(&mut self, conn: &'static str, kind: CondKind) {
        let g = &mut self.where_;
        let mut conn = conn;
        if !g.pending.is_empty() {
            if !conn.is_empty() {
                let msg = format!("connector {conn} follows connector {}", g.pending);
                self.fail(msg);
                return;
            }
            conn = g.pending;
            g.pending = "";
        }
        // A connector at the start has nothing to join, so it is dropped: the
        // first condition or group carries no AND or OR.
        if g.items.is_empty() {
            conn = "";
        }
        if !g.items.is_empty() && conn.is_empty() {
            self.fail("condition without and/or after another condition");
            return;
        }
        self.where_.items.push(CondNode { conn, kind });
    }

    /// Records and(())/or(()) without a condition.
    pub fn connector(&mut self, conn: &'static str) {
        if !self.where_.pending.is_empty() {
            let msg = format!("connector {conn} follows connector {}", self.where_.pending);
            self.fail(msg);
            return;
        }
        self.where_.pending = conn;
    }

    /// Places the conditions of a joined model as a group.
    pub fn place(&mut self, conn: &'static str, joined: u64) {
        if joined == self.subject_id() {
            self.fail(format!("{conn} cannot place the model inside itself"));
            return;
        }
        self.add(conn, CondKind::Joined(joined));
    }

    /// Appends the conditions collected by a group callback.
    pub fn add_group(&mut self, conn: &'static str, g: Core) {
        if let Some(e) = g.err() {
            self.fail_err(e);
        }
        if g.where_.items.is_empty() {
            self.fail(format!("{conn} group callback added no condition"));
            return;
        }
        if !g.where_.pending.is_empty() {
            self.fail(format!("connector {} without a following condition", g.where_.pending));
            return;
        }
        self.add(conn, CondKind::Group(g.where_.items));
    }

    /// Sets the join ON conditions from a callback group.
    pub fn set_on(&mut self, g: Core) {
        if self.group {
            self.fail("on is not allowed inside a group callback");
            return;
        }
        if let Some(e) = g.err() {
            self.fail_err(e);
        }
        if !g.where_.pending.is_empty() {
            self.fail(format!("connector {} without a following condition", g.where_.pending));
            return;
        }
        if g.where_.items.is_empty() {
            self.fail("on callback added no condition");
            return;
        }
        self.on = Some(g.where_.items);
    }

    /// Appends a raw condition; conn is empty for the first condition.
    pub fn raw(&mut self, conn: &'static str, sql: &str, binds: Vec<Param>) {
        self.add(conn, CondKind::Raw(RawSpec { sql: sql.to_owned(), binds }));
    }

    /// Appends the conditions of a chain. Each key receives one argument.
    pub fn chain(&mut self, conn: &'static str, keys: &[ChainKey], args: Vec<Arg>) {
        if keys.len() != args.len() {
            self.fail(format!("the condition expects {} values", keys.len()));
            return;
        }
        for (i, (key, arg)) in keys.iter().zip(args).enumerate() {
            let c = if i == 0 { conn } else { key.conn };
            match predicate(key, arg, keys.len() == 1) {
                Ok(p) => self.add(c, CondKind::Pred(p)),
                Err(e) => {
                    self.fail_err(e);
                    return;
                }
            }
        }
    }

    /// Adds a configured child model as an INNER or LEFT join.
    pub fn join(&mut self, kind: &'static str, left: &str, right: &str, child: Core) {
        if self.group {
            self.fail("join is not allowed inside a group callback");
            return;
        }
        if child.conn.is_some() {
            self.fail("a join child cannot have its own connection");
            return;
        }
        if self.joins.iter().any(|j| j.child.id == child.id) {
            self.fail("the model is already joined");
            return;
        }
        self.joins.push(JoinSpec { kind, left: left.into(), right: right.into(), child: Box::new(child) });
    }

    /// Attaches a child model loaded by a separate query.
    pub fn relation(&mut self, many: bool, child: Core) {
        if self.group {
            self.fail("relation is not allowed inside a group callback");
            return;
        }
        if child.match_left.is_empty() {
            self.fail(format!("relation child {} requires match_<l>_with_<r>()", child.ent.name));
            return;
        }
        self.relations.push(RelSpec { many, child: Box::new(child) });
    }

    pub fn set_match(&mut self, left: &str, right: &str) {
        self.match_left = left.into();
        self.match_right = right.into();
    }

    pub fn set_alias(&mut self, name: &str) {
        self.alias = name.into();
    }

    pub fn parent_node(&mut self) {
        self.parent_node = true;
    }

    pub fn possible(&mut self, column: &str, value: Param) {
        self.possible = Some((column.into(), value));
    }

    pub fn group_limit(&mut self, n: u32) {
        if n == 0 {
            self.fail("group_limit requires a positive count");
            return;
        }
        self.group_limit = n;
    }

    pub fn delete_lock(&mut self) {
        self.delete_lock = true;
    }

    pub fn key_name(&mut self, column: &str) {
        self.key_name = column.into();
    }

    pub fn fetch_key(&mut self, f: KeyFn) {
        self.fetch_key = Some(f);
    }

    pub fn fetch_value(&mut self, f: ValueFn) {
        self.fetch_value = Some(f);
    }

    fn add_name(&mut self, name: &str, added: Added) {
        if self.columns.added.contains_key(name) {
            self.fail(format!("column name {name} is already added"));
            return;
        }
        self.columns.added.insert(name.to_owned(), added);
    }

    pub fn add_column(&mut self, column: &str) {
        if !self.columns.add.iter().any(|c| c == column) {
            self.columns.add.push(column.into());
        }
    }

    pub fn add_column_format(&mut self, column: &str, name: &str, format: &str) {
        self.add_name(name, Added::Format(column.into(), format.into()));
    }

    pub fn add_column_func(&mut self, column: &str, name: &str, f: Func) {
        if !f.column {
            self.fail(format!("add_column {name} requires a column function"));
            return;
        }
        self.add_name(name, Added::Func(column.into(), f));
    }

    pub fn add_column_sub(&mut self, name: &str, f: SubFn) {
        self.add_name(name, Added::Sub(f));
    }

    pub fn add_raw_column(&mut self, name: &str, sql: &str, binds: Vec<Param>) {
        self.add_name(name, Added::Raw(RawSpec { sql: sql.into(), binds }));
    }

    pub fn remove_column(&mut self, column: &str) {
        if !self.columns.remove.iter().any(|c| c == column) {
            self.columns.remove.push(column.into());
        }
    }

    pub fn remove_all_columns(&mut self) {
        self.columns.mode = "none";
    }

    pub fn add_all_columns(&mut self) {
        self.columns.mode = "all";
    }

    pub fn force_index(&mut self, name: &str) {
        self.index = name.into();
    }

    pub fn order_by(&mut self, column: &str, desc: bool, func: Option<Func>) {
        if let Some(f) = &func {
            if !f.column {
                self.fail("order_by accepts a column function only");
                return;
            }
        }
        self.order.push(OrderSpec { column: column.into(), desc, func, random: false, raw: None });
    }

    pub fn order_by_random(&mut self) {
        self.order.push(OrderSpec { column: String::new(), desc: false, func: None, random: true, raw: None });
    }

    pub fn order_by_raw(&mut self, sql: &str) {
        self.order.push(OrderSpec { column: String::new(), desc: false, func: None, random: false, raw: Some(sql.into()) });
    }

    pub fn group_by(&mut self, column: &str) {
        self.group_by.push(column.into());
    }

    pub fn group_by_raw(&mut self, sql: &str) {
        self.group_raw.push(sql.into());
    }

    pub fn limit(&mut self, offset: u32, count: u32) {
        if count == 0 {
            self.fail("limit requires a positive count");
            return;
        }
        self.limit = Some((offset, count));
    }

    /// Requests a row lock: update, share, update_nowait, or share_nowait.
    pub fn lock(&mut self, mode: &'static str) {
        self.lock = mode;
    }

    /// Selects the function (sum or avg) and column of get_sum or get_avg.
    pub fn aggregate(&mut self, func: &'static str, column: &str) {
        self.agg_fn = func;
        self.agg = column.into();
    }

    fn put_set(&mut self, column: &str, value: SetValue) {
        if self.group {
            self.fail("set is not allowed inside a group callback");
            return;
        }
        if let Some(s) = self.sets.iter_mut().find(|s| s.column == column) {
            s.value = value;
            return;
        }
        self.sets.push(SetSpec { column: column.into(), value });
    }

    /// Records a stored column value.
    pub fn set(&mut self, column: &str, value: Param) {
        let v = if matches!(value, Param::Null) { SetValue::Null } else { SetValue::Value(value) };
        self.put_set(column, v);
    }

    /// Records a stored value of a column with codec styles.
    pub fn set_json(&mut self, column: &str, value: serde_json::Value) {
        let v = if value.is_null() { SetValue::Null } else { SetValue::Json(value) };
        self.put_set(column, v);
    }

    /// Records the ordered-json value of a column with the `json` or `jsons`
    /// stage; the JSON null stores NULL.
    pub fn set_ordered(&mut self, column: &str, value: ordered_json::Value) {
        let v = if value.kind() == ordered_json::Kind::Null { SetValue::Null } else { SetValue::Ordered(value) };
        self.put_set(column, v);
    }

    pub fn set_raw(&mut self, column: &str, sql: &str, binds: Vec<Param>) {
        self.put_set(column, SetValue::Raw(RawSpec { sql: sql.into(), binds }));
    }

    pub fn plus(&mut self, column: &str, n: Param) {
        self.put_set(column, SetValue::Plus(n));
    }

    pub fn minus(&mut self, column: &str, n: Param) {
        self.put_set(column, SetValue::Minus(n));
    }

    /// Attaches a value under a name that is not a column.
    pub fn attach(&mut self, name: &str, value: serde_json::Value) {
        self.news.insert(name.to_owned(), value);
    }

    /// A value attached with `new_<name>` or an added output column.
    pub fn attached(&self, name: &str) -> crate::Result<Option<serde_json::Value>> {
        if let Some(v) = self.news.get(name) {
            return Ok(Some(v.clone()));
        }
        self.row.as_ref().and_then(|r| r.extra.get(name)).map(|v| v.to_json()).transpose()
    }

    /// Sets the duplicate-key update of the next create.
    pub fn duplication(&mut self, other: Core) {
        self.duplication = Some(Box::new(other));
    }

    /// Sets the collection key callback of a typed model.
    pub fn fetch_key_with<M: crate::model::Model, K: Into<crate::collection::Key>>(&mut self, f: impl Fn(&M) -> K + Send + Sync + 'static) {
        self.fetch_key(Arc::new(move |m: &dyn AnyModel| f(m.as_any().downcast_ref::<M>().expect("fetch_key model type")).into()));
    }

    /// Sets the value callback of a typed model.
    pub fn fetch_value_with<M: crate::model::Model>(&mut self, f: impl Fn(&M) -> serde_json::Value + Send + Sync + 'static) {
        self.fetch_value(Arc::new(move |m: &dyn AnyModel| f(m.as_any().downcast_ref::<M>().expect("fetch_value model type"))));
    }

    /// Adds a scalar subquery column; the callback receives the calling model.
    pub fn add_column_query<M: crate::model::Model, R: crate::model::Model>(&mut self, name: &str, f: impl Fn(&M) -> R + Send + Sync + 'static) {
        self.add_column_sub(name, Arc::new(move |c: &Core| f(&M::from_core(c.clone())).into_core()));
    }

    /// A copy of the builder for a terminal with chain values; the identity is kept.
    pub fn by(&self, keys: &[ChainKey], args: Vec<Arg>) -> Core {
        let mut out = self.clone();
        let conn = if out.where_.items.is_empty() { "" } else { "and" };
        out.chain(conn, keys, args);
        out
    }
}

fn predicate(key: &ChainKey, arg: Arg, single: bool) -> crate::Result<PredSpec> {
    let op_of = |op: &str| -> &'static str {
        match op {
            "" => "eq",
            "ne" => "not_eq",
            "gt" => "gt",
            "lt" => "lt",
            "ge" => "gte",
            "le" => "lte",
            "lk" => "contains",
            "lb" => "contains_binary",
            _ => "eq",
        }
    };
    let pred = |op: &'static str, value: PredValue| PredSpec { column: key.column.to_owned(), op, value };
    match key.op {
        "fulltext" | "fulltext_boolean" => {
            let Arg::Text(s) = arg else {
                return Err(config(format!("full-text value for {} must be text", key.column)));
            };
            let op = if key.op == "fulltext" { "match" } else { "match_boolean" };
            return Ok(PredSpec { column: String::new(), op, value: PredValue::Match(key.columns.to_vec(), Param::Str(s)) });
        }
        "tuple" | "ne_tuple" => {
            let Arg::Tuples(rows) = arg else {
                return Err(config("tuple values must be a list of value groups"));
            };
            if rows.is_empty() {
                return Err(Error::Engine { code: codes::EMPTY_IN.into(), msg: "tuple condition received an empty list".into() });
            }
            let op = if key.op == "tuple" { "tuple_in" } else { "tuple_not_in" };
            return Ok(PredSpec { column: String::new(), op, value: PredValue::Tuples(key.columns.to_vec(), rows) });
        }
        _ => {}
    }
    if !key.compare.is_empty() {
        let Arg::Model(id) = arg else {
            return Err(config(format!("column comparison {} requires a model", key.column)));
        };
        let op = match key.op {
            "" => "eq_col",
            "ne" => "not_eq_col",
            "gt" => "gt_col",
            "lt" => "lt_col",
            "ge" => "gte_col",
            _ => "lte_col",
        };
        return Ok(pred(op, PredValue::Ref(id, key.compare)));
    }
    let eq = key.op.is_empty() || key.op == "ne";
    match arg {
        Arg::Function(f, compared) => {
            if !single {
                return Err(config("a column function is accepted only by a single-key condition"));
            }
            if !f.column {
                return Err(config(format!("{} requires a column function with a compared value", key.column)));
            }
            Ok(pred(op_of(key.op), PredValue::ColumnFn(f, compared)))
        }
        Arg::Value(Value::Func(f)) => {
            if f.column {
                return Err(config(format!("column function on {} requires one compared value", key.column)));
            }
            Ok(pred(op_of(key.op), PredValue::ValueFn(f)))
        }
        Arg::Value(Value::Null) => {
            if !eq {
                return Err(config(format!("null is not accepted by the {} operator", key.op)));
            }
            Ok(pred(if key.op == "ne" { "is_not_null" } else { "is_null" }, PredValue::None))
        }
        Arg::Value(Value::Sub(core)) => {
            if !eq {
                return Err(config(format!("a subquery is not accepted by the {} operator", key.op)));
            }
            Ok(pred(if key.op == "ne" { "not_in" } else { "in" }, PredValue::Sub(core)))
        }
        Arg::Value(Value::List(list)) => {
            if !eq {
                return Err(config(format!("a list is not accepted by the {} operator", key.op)));
            }
            if list.is_empty() {
                return Err(Error::Engine { code: codes::EMPTY_IN.into(), msg: format!("{} received an empty list", key.column) });
            }
            Ok(pred(if key.op == "ne" { "not_in" } else { "in" }, PredValue::List(list)))
        }
        Arg::Value(Value::Pair(a, b)) => Ok(pred("between", PredValue::Pair(a, b))),
        Arg::Value(Value::One(v)) => Ok(pred(op_of(key.op), PredValue::One(v))),
        _ => Err(config(format!("{} received an unsupported value", key.column))),
    }
}
