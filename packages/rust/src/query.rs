//! The general query of the core (docs/spec/core.md CORE-81 to CORE-83): the query and the row state of one entity
//! that is chosen by its name. A generated model holds its columns in typed fields and names its entity in its type;
//! a `Query` holds them by name and names its entity in a value.

use std::collections::HashMap;
use std::sync::Arc;

use binding_core::OrderedMap;
use indexmap::IndexMap;
use polyspec_orm_schema::chain::{parse_chain, parse_order, split_pair, ChainKey};

use crate::args::Value;
use crate::collection::{AnyCollection, Collection, GroupRows, Key, LookaheadPage, Page};
use crate::core::{Arg, Core};
use crate::db::Statement;
use crate::model::{AnyModel, Boxed, LoadedEntity, RelatedValue};
use crate::value::Val;
use crate::{Connection, Error, Kind, OrmValue, Result, Schema};

/// The query and the row state of one entity (CORE-81).
#[derive(Clone)]
pub struct Query {
    core: Core,
    /// The values of the columns of the entity that a row read, by column name.
    values: IndexMap<String, Val>,
}

/// One page of the rows of a `Query`, the core type of the class `page` of the contract (CORE-200).
pub type QueryPage = Page<Query>;

impl Page<Query> {
    /// The number of rows that the conditions of the query select, on every page (CORE-200).
    #[must_use]
    pub fn total_count(&self) -> i64 {
        self.total_count
    }

    /// The number of pages: the count divided by the rows of a page and rounded up (CORE-200).
    #[must_use]
    pub fn total_pages(&self) -> i64 {
        self.total_pages
    }

    /// The number of the page, from 1, as `gets_page` received it (CORE-200).
    #[must_use]
    pub fn page(&self) -> u32 {
        self.page
    }

    /// The number of rows of a page, as `gets_page` received it (CORE-200).
    #[must_use]
    pub fn per_page(&self) -> u32 {
        self.per_page
    }

    /// The rows of the page, as `gets` returns them (CORE-200).
    #[must_use]
    pub fn rows(&self) -> Rows {
        Rows(self.items.clone())
    }
}

/// One page of the rows of a `Query` read one row past its end, the core type of the class `lookahead_page` of the
/// contract (CORE-206).
pub type QueryLookaheadPage = LookaheadPage<Query>;

impl LookaheadPage<Query> {
    /// The number of the page, from 1, as `gets_lookahead_page` received it (CORE-206).
    #[must_use]
    pub fn page(&self) -> u32 {
        self.page
    }

    /// The number of rows of a page, as `gets_lookahead_page` received it (CORE-206).
    #[must_use]
    pub fn per_page(&self) -> u32 {
        self.per_page
    }

    /// Whether the query has a row past the page (CORE-206).
    #[must_use]
    pub fn has_next(&self) -> bool {
        self.has_next
    }

    /// The rows of the page, as `gets` returns them (CORE-206).
    #[must_use]
    pub fn rows(&self) -> Rows {
        Rows(self.items.clone())
    }
}

/// One page of the group rows of a `Query` read one group past its end, the core type of the class
/// `group_lookahead_page` of the contract (CORE-206).
#[derive(Clone)]
pub struct GroupLookaheadRows {
    rows: Vec<OrderedMap<OrmValue>>,
    page: u32,
    per_page: u32,
    has_next: bool,
}

impl GroupLookaheadRows {
    /// The number of the page, from 1, as `gets_count_lookahead_page` received it (CORE-206).
    #[must_use]
    pub fn page(&self) -> u32 {
        self.page
    }

    /// The number of groups of a page, as `gets_count_lookahead_page` received it (CORE-206).
    #[must_use]
    pub fn per_page(&self) -> u32 {
        self.per_page
    }

    /// Whether the query has a group past the page (CORE-206).
    #[must_use]
    pub fn has_next(&self) -> bool {
        self.has_next
    }

    /// The group rows of the page, as `gets_count` returns them (CORE-201, CORE-206).
    #[must_use]
    pub fn rows(&self) -> Vec<OrderedMap<OrmValue>> {
        self.rows.clone()
    }
}

fn new_query(core: Core) -> Box<dyn AnyModel> {
    Box::new(Query { core, values: IndexMap::new() })
}

fn collect_queries(items: Boxed, fetched: HashMap<Key, serde_json::Value>) -> Arc<dyn AnyCollection> {
    Arc::new(Collection::<Query>::from_boxes(items, fetched))
}

/// The rows that `gets` read, each under its key, in the order of the read (CORE-170): the class `rows` of the
/// contract, which holds the `Collection` of a `Query`.
#[derive(Clone)]
pub struct Rows(Collection<Query>);

/// The key of a row as `orm_value` (CORE-170): an integer is `int64`, a bool `bool`, bytes `bytes`, a text `text`, and
/// a date-time the text of its six fraction digits.
fn key_value(key: &Key) -> OrmValue {
    match key {
        Key::I(number) => OrmValue::Int64(*number),
        Key::S(text) => OrmValue::Text(text.clone()),
        Key::B(flag) => OrmValue::Bool(*flag),
        Key::X(bytes) => OrmValue::Bytes(bytes.clone()),
        Key::T(at) => OrmValue::Text(at.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
    }
}

impl Rows {
    /// The number of rows.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether no row was read.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The first row, `None` when no row was read.
    #[must_use]
    pub fn first(&self) -> Option<Query> {
        self.0.first().cloned()
    }

    /// The row of the key `key`, `None` when no row has it. An `int` and an `int64` name the same key, a text names the
    /// key of that text and, when no row has it, the key of the date-time that it writes, and a value of any other kind
    /// is the key of no row.
    #[must_use]
    pub fn get(&self, key: &OrmValue) -> Option<Query> {
        let row = match key {
            OrmValue::Int(number) | OrmValue::Int64(number) => self.0.get(Key::I(*number)),
            OrmValue::Bool(flag) => self.0.get(Key::B(*flag)),
            OrmValue::Bytes(bytes) => self.0.get(Key::X(bytes.clone())),
            OrmValue::Text(text) => match (self.0.get(Key::S(text.clone())), crate::driver::parse_datetime(text)) {
                (Some(row), _) => Some(row),
                (None, Ok(at)) => self.0.get(Key::T(at)),
                (None, Err(_no_datetime)) => None,
            },
            OrmValue::Null | OrmValue::Float(_) | OrmValue::Json(_) | OrmValue::List(_) | OrmValue::Map(_) => None,
        };
        row.cloned()
    }

    /// The keys of the rows, in the order of the rows.
    #[must_use]
    pub fn keys(&self) -> Vec<OrmValue> {
        self.0.keys().iter().map(key_value).collect()
    }

    /// The rows, in their order.
    #[must_use]
    pub fn values(&self) -> Vec<Query> {
        self.0.models().cloned().collect()
    }

    /// `to_array` of each row, in the order of the rows (CORE-120).
    pub fn to_array(&self) -> Result<Vec<OrderedMap<OrmValue>>> {
        self.0.models().map(Query::to_array).collect()
    }
}

impl Query {
    /// A query of the entity `entity` of `schema`; a name that the schema does not have is `entity_unknown` (CORE-81).
    pub fn new(schema: &Schema, entity: &str) -> Result<Query> {
        schema.manifest()?.entity(entity)?;
        // CORE-80, CORE-81: the query, its copies and its rows share the descriptor, and the descriptor the schema.
        let descriptor = LoadedEntity { name: entity.to_owned(), schema: schema.shared(), new: new_query, collect: collect_queries };
        Ok(Query { core: Core::of(descriptor.into()), values: IndexMap::new() })
    }

    /// The name of the entity.
    pub fn entity(&self) -> &str {
        self.core.entity().name()
    }

    /// Sets the connection of the query: a `Db`, or the `Tx` of a transaction, in which its terminals then run
    /// (CORE-20, CORE-81).
    pub fn connect(&mut self, connection: Connection) {
        self.core.connect(connection);
    }

    /// Adds the conditions of the chain name `chain`, one value of `values` per key (CORE-82). A name that starts with
    /// `And` or `Or` joins its first condition to the conditions before it with that connector. A refused name or
    /// number of values is `config` at the next terminal.
    /// The value argument is borrowed, as a generated binding passes it (binding design T-1).
    pub fn where_chain(&mut self, chain: &str, values: &[OrmValue]) {
        let (connector, name) = split_connector(chain);
        self.chain(connector, name, values.to_vec());
    }

    /// Adds a condition that no row satisfies, the predicate `none` of the request (CORE-137, PRT-92). `connector` is
    /// `""`, `And` or `Or`, the connector words of CORE-82: `And` joins it to the conditions before it with `and` and `Or`
    /// with `or`; `""` names no connector and is the form of a first condition. A connector on a first condition is
    /// dropped (DSL-18), and `""` after another condition, like any other text, fails the query with `config` at the
    /// next terminal (DSL-19).
    pub fn where_none(&mut self, connector: &str) {
        if let Some(conn) = self.connector_of("where_none", connector) {
            self.core.add_none(conn);
        }
    }

    /// The connector of the word `connector`, `""`, `And` or `Or` (CORE-82); any other text fails the query with `config`
    /// in the name of `member`.
    fn connector_of(&mut self, member: &str, connector: &str) -> Option<&'static str> {
        match connector {
            "" => Some(""),
            "And" => Some("and"),
            "Or" => Some("or"),
            other => {
                self.core.fail(format!("{member} takes \"\", \"And\" or \"Or\", not {other}"));
                None
            }
        }
    }

    /// Adds the conditions of `query`, a query of the same entity, as one group in parentheses (CORE-202). `connector` is
    /// `""`, `And` or `Or`, as `where_none` takes it. Nothing but the conditions of `query` is read. A query with no
    /// condition, a query of another entity and a refused connector are `config` at the next terminal, and a query that
    /// a member failed fails this query with its error.
    pub fn where_group(&mut self, connector: &str, query: Query) {
        if let Some(error) = query.core.err() {
            return self.core.fail_err(error);
        }
        let Some(conn) = self.connector_of("where_group", connector) else { return };
        if query.entity() != self.entity() {
            let message = format!("where_group takes a query of {}, not of {}", self.entity(), query.entity());
            return self.core.fail(message);
        }
        if query.core.where_.items.is_empty() {
            return self.core.fail("the query of where_group has no condition");
        }
        self.core.add_group(conn, query.core);
    }

    /// Adds the condition that the column of the chain name `chain`, one key with no operator or with `Ne`, is in, or
    /// with `Ne` is not in, the rows of the subquery `query`, which reads one column that `add_column` added (CORE-90).
    /// A name that starts with `And` or `Or` joins the condition to the conditions before it with that connector. A
    /// refused chain or subquery is an error at the next terminal.
    pub fn where_in(&mut self, chain: &str, query: Query) {
        if let Some(error) = query.core.err() {
            return self.core.fail_err(error);
        }
        let (connector, name) = split_connector(chain);
        if let Some(keys) = self.parsed(name) {
            self.core.chain_parsed(connector, &keys, vec![Arg::Value(Value::Sub(Box::new(query.core)))]);
        }
    }

    /// The keys of the chain name `name`; a refused name fails the query with `config` (CORE-82).
    fn parsed(&mut self, name: &str) -> Option<Vec<ChainKey>> {
        match self.read_entity(|model, entity| parse_chain(model, entity, name))? {
            Ok(keys) => Some(keys),
            Err(message) => {
                self.core.fail(message);
                None
            }
        }
    }

    /// What `read` gives for the runtime model of the schema of this query and the entity of the query in it; an error
    /// that refuses the manifest or the entity fails the query and gives None.
    fn read_entity<T>(&mut self, read: impl FnOnce(&polyspec_orm_schema::dbspec::RuntimeModel, &polyspec_orm_schema::dbspec::Entity) -> T) -> Option<T> {
        let manifest = match self.core.entity().schema().manifest() {
            Ok(manifest) => manifest,
            Err(error) => {
                self.core.fail_err(error);
                return None;
            }
        };
        let entity = match manifest.entity(self.core.entity().name()) {
            Ok(entity) => entity,
            Err(error) => {
                self.core.fail_err(error);
                return None;
            }
        };
        Some(read(&manifest.model, entity))
    }

    fn chain(&mut self, connector: &'static str, name: &str, values: Vec<OrmValue>) {
        let Some(keys) = self.parsed(name) else { return };
        if keys.len() != values.len() {
            return self.core.fail(format!("the condition expects {} values", keys.len()));
        }
        // CORE-82: the operator of a key decides what its value is.
        let args = keys.iter().zip(values).map(|(key, value)| value.into_arg(key.op)).collect::<Result<Vec<_>>>();
        match args {
            Ok(args) => self.core.chain_parsed(connector, &keys, args),
            Err(error) => self.core.fail_err(error),
        }
    }

    /// Adds the order of the name `spec`, such as `SeqDescAndLabelAsc` (CORE-82). A refused name is `config` at the next
    /// terminal.
    pub fn order_by(&mut self, spec: &str) {
        let Some(order) = self.read_entity(|_, entity| parse_order(entity, spec)) else { return };
        match order {
            Ok(keys) => {
                for (column, descending) in keys {
                    self.core.order_by(&column, descending, None);
                }
            }
            Err(message) => self.core.fail(message),
        }
    }

    /// Adds the column `column` to the grouping of the query, which `gets_count` and `get_count` read (CORE-201). A name
    /// that is no column of the entity is `config` at the next terminal.
    pub fn group_by(&mut self, column: &str) {
        if self.known_column(column) {
            self.core.group_by(column);
        }
    }

    /// Names the column `column` whose sum `get_sum` returns; the last one called holds (CORE-205). A name that is no
    /// column of the entity is `config` at the next terminal.
    pub fn sum(&mut self, column: &str) {
        if self.known_column(column) {
            self.core.aggregate("sum", column);
        }
    }

    /// Reads at most `count` rows after the first `offset` rows of the order (CORE-85). A `count` of 0 is `config` at
    /// the next terminal.
    pub fn limit(&mut self, offset: u32, count: u32) {
        self.core.limit(offset, count);
    }

    /// Reads at most `count` rows per row of the parent, the first of the order of this query, when the query is given to
    /// `relation` or `relations` (CORE-157). A `count` of 0 is `config` at the next terminal.
    pub fn group_limit(&mut self, count: u32) {
        self.core.group_limit(count);
    }

    /// Locks the rows that `get` and `gets` read with the lock `update`, the member `forUpdate` of the language
    /// implementations (CORE-86). The last lock called holds.
    pub fn for_update(&mut self) {
        self.core.lock("update");
    }

    /// Locks the rows that `get` and `gets` read with the lock `share`, the member `forShare` of the language
    /// implementations (CORE-86). The last lock called holds.
    pub fn for_share(&mut self) {
        self.core.lock("share");
    }

    /// Locks the rows that `get` and `gets` read with the lock `update_nowait`, the member `forUpdateNoWait` of the language
    /// implementations (CORE-86). The last lock called holds.
    pub fn for_update_no_wait(&mut self) {
        self.core.lock("update_nowait");
    }

    /// Locks the rows that `get` and `gets` read with the lock `share_nowait`, the member `forShareNoWait` of the language
    /// implementations (CORE-86). The last lock called holds.
    pub fn for_share_no_wait(&mut self) {
        self.core.lock("share_nowait");
    }

    /// Reads every column of the entity (CORE-87).
    pub fn add_all_columns(&mut self) {
        self.core.add_all_columns();
    }

    /// Reads only the columns of the primary key and of the foreign keys (CORE-87).
    pub fn remove_all_columns(&mut self) {
        self.core.remove_all_columns();
    }

    /// Adds the column `column` to the columns that a row reads (CORE-87). A name that is no column of the entity is
    /// `config` at the next terminal.
    pub fn add_column(&mut self, column: &str) {
        if self.known_column(column) {
            self.core.add_column(column);
        }
    }

    /// Removes the column `column` from the columns that a row reads (CORE-87). A name that is no column of the entity
    /// is `config` at the next terminal.
    pub fn remove_column(&mut self, column: &str) {
        if self.known_column(column) {
            self.core.remove_column(column);
        }
    }

    /// Keys the collection of `gets`, and the rows of a `relations` result of the query, by the column `column` in place
    /// of the primary key (CORE-89). A name that is no column of the entity is `config` at the next terminal.
    pub fn key_name(&mut self, column: &str) {
        if self.known_column(column) {
            self.core.key_name(column);
        }
    }

    /// Whether `column` is a column of the entity; a name that is none fails the query with `config`, which the next
    /// terminal returns (CORE-87).
    fn known_column(&mut self, column: &str) -> bool {
        match self.is_column(column) {
            Ok(true) => true,
            Ok(false) => {
                let message = format!("{column} is not a column of {}", self.entity());
                self.core.fail(message);
                false
            }
            Err(error) => {
                self.core.fail_err(error);
                false
            }
        }
    }

    /// Adds a component of the relation key: `pair` is `<Left>With<Right>`, a column of the parent, of any entity of the
    /// schema, and a column of this entity, read by `split_pair` (CORE-88). A name that names no such columns is
    /// `config` at the next terminal.
    pub fn match_pair(&mut self, pair: &str) {
        let Some(split) = self.read_entity(|model, entity| split_pair(model, None, Some(entity), pair)) else { return };
        match split {
            Ok((left, right)) => self.core.add_match(&left, &right),
            Err(message) => self.core.fail(message),
        }
    }

    /// Names the result of the query as a relation child; the name is its snake case (CORE-88).
    pub fn alias(&mut self, name: &str) {
        self.core.set_alias(name);
    }

    /// Attaches to each row the row that a separate query of `child` reads by the key of its `match_pair` (CORE-88).
    pub fn relation(&mut self, child: Query) {
        self.attach(false, child);
    }

    /// Attaches to each row the rows that a separate query of `child` reads by the key of its `match_pair` (CORE-88).
    pub fn relations(&mut self, child: Query) {
        self.attach(true, child);
    }

    /// Attaches `child`; a child that a member failed fails the query with its error, which the next terminal returns
    /// (CORE-88).
    fn attach(&mut self, many: bool, child: Query) {
        match child.core.err() {
            Some(error) => self.core.fail_err(error),
            None => self.core.relation(many, child.core),
        }
    }

    /// The row of the `relation` result `name` of a row, `None` for a row without the result or without a related row;
    /// a `relations` result is `internal` (CORE-88).
    pub fn related(&self, name: &str) -> Result<Option<Query>> {
        Ok(self.core.related_one::<Query>(name)?.cloned())
    }

    /// The rows of the `relations` result `name` of a row, `None` for a row without the result; a `relation` result is
    /// `internal` (CORE-88).
    pub fn related_rows(&self, name: &str) -> Result<Option<Vec<Query>>> {
        Ok(self.core.related_many::<Query>(name)?.map(|rows| rows.models().cloned().collect()))
    }

    /// Assigns `value` to the column `column` for the next write (CORE-91). A name that is no column of the entity is
    /// `config` and a list or a map is `codec_encode`, each at the next terminal; the column decides at the write whether
    /// it takes any other value (CORE-62).
    /// The value argument is borrowed, as a generated binding passes it (binding design T-1).
    pub fn set(&mut self, column: &str, value: &OrmValue) {
        if !self.known_column(column) {
            return;
        }
        match value.clone() {
            OrmValue::Json(json) => self.core.set_ordered(column, json.value().clone()),
            other => match other.scalar() {
                Ok(param) => self.core.set(column, param),
                Err(refused) => {
                    let what = if matches!(refused, OrmValue::Map(_)) { "a map" } else { "a list" };
                    self.core.fail_err(Error::new(Kind::CodecEncode, format!("the value of a column is {what}")));
                }
            },
        }
    }

    /// Assigns to the column `column`, for the next write, its stored value plus `value` (CORE-150). A name that is no
    /// column of the entity is `config` and a list, a map or a JSON value is `codec_encode`, each at the next terminal.
    /// The value argument is borrowed, as a generated binding passes it (binding design T-1).
    pub fn plus(&mut self, column: &str, value: &OrmValue) {
        if let Some(amount) = self.amount(column, value) {
            self.core.plus(column, amount);
        }
    }

    /// Assigns to the column `column`, for the next write, its stored value minus `value`, and never a negative value
    /// (CORE-150). A name that is no column of the entity is `config` and a list, a map or a JSON value is
    /// `codec_encode`, each at the next terminal.
    /// The value argument is borrowed, as a generated binding passes it (binding design T-1).
    pub fn minus(&mut self, column: &str, value: &OrmValue) {
        if let Some(amount) = self.amount(column, value) {
            self.core.minus(column, amount);
        }
    }

    /// The parameter of the amount `value` of `plus` or `minus` on the column `column`; a name that is no column and a
    /// value that is no one value fail the query (CORE-150).
    fn amount(&mut self, column: &str, value: &OrmValue) -> Option<crate::value::Param> {
        if !self.known_column(column) {
            return None;
        }
        match value.clone().scalar() {
            Ok(param) => Some(param),
            Err(refused) => {
                let what = match refused {
                    OrmValue::Map(_) => "a map",
                    OrmValue::List(_) => "a list",
                    _ => "a JSON value",
                };
                self.core.fail_err(Error::new(Kind::CodecEncode, format!("the value of a column is {what}")));
                None
            }
        }
    }

    /// Makes the next `create` an insert with a duplicate-key update that writes the assignments of `query`, a query of
    /// the same entity, to the row that the insert met (CORE-151). A query of another entity is `config` at the next
    /// terminal, and a query that a member failed fails this query with its error.
    pub fn duplication(&mut self, query: Query) {
        if let Some(error) = query.core.err() {
            return self.core.fail_err(error);
        }
        if query.entity() != self.entity() {
            let message = format!("duplication takes a query of {}, not of {}", self.entity(), query.entity());
            return self.core.fail(message);
        }
        self.core.duplication(query.core);
    }

    /// Makes the next `update` or `delete` write only while the integer column `column` holds `revision`; `update` also
    /// stores `revision + 1` (CORE-91, DSL-108).
    pub fn expect_revision(&mut self, column: &str, revision: i64) {
        self.core.expect_revision(column, revision);
    }

    /// Makes the `update`, `delete` and `restore` of the query from then on fail with `no_rows` when the statement of
    /// the write matched no row; `restore_or_create` does not take it (CORE-142, PRT-90).
    pub fn require_match(&mut self) {
        self.core.require_match();
    }

    /// Inserts the row of the assignments and returns the created row with its identity (CORE-91). The assignments are
    /// cleared.
    pub async fn create(&mut self) -> Result<Query> {
        crate::model::create(self).await
    }

    /// Writes the assignments to the row that the query read or, in a query that read no row, to the row of the primary
    /// key that `set` assigned (CORE-91).
    pub async fn update(&mut self) -> Result<()> {
        crate::model::update(self, false).await
    }

    /// Inserts the rows of the assignments of `rows`, queries of the same entity, in batches of `batch` rows in one
    /// transaction, under the conditions of this query, and returns the number of rows inserted (CORE-204). A `batch` of
    /// 0 and a row of another entity are `config`, and a batch over the bind limit of the database is `batch_too_large`.
    pub async fn creates(&self, rows: &[Query], batch: u32) -> Result<i64> {
        for row in rows {
            if row.entity() != self.entity() {
                return Err(Error::config(format!("creates takes rows of {}, not of {}", self.entity(), row.entity())));
            }
            if let Some(error) = row.core.err() {
                return Err(error);
            }
        }
        let batch = usize::try_from(batch).map_err(|error| Error::internal(format!("the batch {batch} is no size: {error}")))?;
        let inserted = crate::model::creates(self, rows.to_vec(), batch).await?;
        i64::try_from(inserted).map_err(|error| Error::internal(format!("the count {inserted} of inserted rows is no int64: {error}")))
    }

    /// Writes the assignments by `update` when the query read a row or `set` assigned its primary key, and by `create`
    /// otherwise (CORE-203). It returns the query as `update` left it, or the row that `create` returned.
    pub async fn save(&mut self) -> Result<Query> {
        crate::model::save(self).await
    }

    /// Deletes the row that the query read or, in a query that read no row, the row of the primary key that `set`
    /// assigned (CORE-91).
    pub async fn delete(&self) -> Result<()> {
        crate::model::delete(self, false).await
    }

    /// Restores the soft-deleted row of the key that the assignments hold, writes the other assignments to it and
    /// returns the row; a row of the key that is not deleted is returned and not written, and no row of the key is
    /// `no_rows` (CORE-94). The assignments are cleared.
    pub async fn restore(&mut self) -> Result<Query> {
        let row = crate::model::restore(self).await?;
        self.core.sets.clear();
        Ok(row)
    }

    /// Restores the soft-deleted row of the key that the assignments hold or, when no row holds the key, inserts the row
    /// of the assignments, in one transaction, and returns the row; a row of the key that is not deleted is
    /// `row_not_deleted` (CORE-94). The assignments are cleared.
    pub async fn restore_or_create(&mut self) -> Result<Query> {
        let row = crate::model::restore_or_create(self).await?;
        self.core.sets.clear();
        Ok(row)
    }

    /// A copy of the query with the conditions of `chain` joined by `and` (CORE-83).
    fn by(&self, chain: &str, values: Vec<OrmValue>) -> Query {
        let mut out = self.clone();
        let connector = if out.core.where_.items.is_empty() { "" } else { "and" };
        out.chain(connector, chain, values);
        out
    }

    /// Runs the query and returns its first row, or `None` when no row matches (CORE-83).
    pub async fn get(&self) -> Result<Option<Query>> {
        let rows = crate::model::load(&self.core, "one").await?;
        rows.items.into_iter().next().map(|(_, row)| row_query(row)).transpose()
    }

    /// Runs the query and returns its rows (CORE-83).
    pub async fn gets(&self) -> Result<Collection<Query>> {
        let rows = crate::model::load(&self.core, "all").await?;
        Ok(Collection::from_boxes(rows.items, rows.fetched))
    }

    /// Reads the page `page` of `per_page` rows and counts the rows of every page (CORE-200); the query does not
    /// change. A `page` or a `per_page` of 0 and a query with `limit` are `config`.
    pub async fn gets_page(&self, page: u32, per_page: u32) -> Result<QueryPage> {
        crate::model::gets_page(self, page, per_page).await
    }

    /// Runs the grouped count of the query and returns one map for each group, in the order of the query: the columns of
    /// `group_by` by name and then `row_count`, the number of rows of the group (CORE-201). A query without `group_by`
    /// is `ir_invalid`; the query does not change.
    pub async fn gets_count(&self) -> Result<Vec<OrderedMap<OrmValue>>> {
        self.group_maps(&crate::model::gets_count(self).await?)
    }

    /// Reads the page `page` of `per_page` rows and one row past it, and counts nothing (CORE-206); the query does not
    /// change. A `page` or a `per_page` of 0 and a query with `limit` are `config`.
    pub async fn gets_lookahead_page(&self, page: u32, per_page: u32) -> Result<QueryLookaheadPage> {
        crate::model::gets_lookahead_page(self, page, per_page).await
    }

    /// Reads the page `page` of `per_page` group rows of `gets_count` and one group past it (CORE-206); the query does
    /// not change. A query without `group_by` is `ir_invalid`.
    pub async fn gets_count_lookahead_page(&self, page: u32, per_page: u32) -> Result<GroupLookaheadRows> {
        let read = crate::model::gets_count_lookahead_page(self, page, per_page).await?;
        Ok(GroupLookaheadRows { rows: self.group_maps(&read.items)?, page: read.page, per_page: read.per_page, has_next: read.has_next })
    }

    /// The group rows `groups` as maps: the columns of `group_by` by name and then `row_count` (CORE-201).
    fn group_maps(&self, groups: &GroupRows) -> Result<Vec<OrderedMap<OrmValue>>> {
        let manifest = self.core.entity().schema().manifest()?;
        let entity = manifest.entity(self.core.entity().name())?;
        let mut out = Vec::with_capacity(groups.len());
        for group in groups.iter() {
            let mut row = OrderedMap::with_capacity(group.values().len());
            for (name, cell) in group.values() {
                // A group row repeats no name, so `row_count` is the count and never a column of that name (INT-68).
                let value = if name == "row_count" {
                    OrmValue::Int64(group.count())
                } else {
                    let field = entity
                        .field(name)
                        .ok_or_else(|| Error::internal(format!("a group row of {} holds {name}, which is no column of it", self.entity())))?;
                    OrmValue::of_column(field, cell.clone())?
                };
                if row.insert(name.clone(), value).is_some() {
                    return Err(Error::internal(format!("a group row of {} names {name} twice", self.entity())));
                }
            }
            out.push(row);
        }
        Ok(out)
    }

    /// The sum of the column that `sum` named over the rows that the conditions select, 0 when no value is left
    /// (CORE-205). A query without `sum` is `config`; the query does not change.
    pub async fn get_sum(&self) -> Result<f64> {
        // A refused `sum` named no column, so its error comes before the refusal of a query without `sum`.
        if let Some(error) = self.core.err() {
            return Err(error);
        }
        crate::model::get_sum(&self.core).await
    }

    /// Runs the count of the query (CORE-83).
    pub async fn get_count(&self) -> Result<i64> {
        crate::model::get_count(&self.core).await
    }

    /// The statement of the query, which is not run (CORE-83).
    pub async fn get_query(&self) -> Result<Statement> {
        crate::model::get_query(&self.core).await
    }

    /// `get` with the conditions of `chain` joined by `and`; the query does not change (CORE-83).
    /// The value argument is borrowed, as a generated binding passes it (binding design T-1).
    pub async fn get_by(&self, chain: &str, values: &[OrmValue]) -> Result<Option<Query>> {
        self.by(chain, values.to_vec()).get().await
    }

    /// `gets` with the conditions of `chain` joined by `and`; the query does not change (CORE-83).
    pub async fn gets_by(&self, chain: &str, values: Vec<OrmValue>) -> Result<Collection<Query>> {
        self.by(chain, values).gets().await
    }

    /// `gets` as the class `rows` of the contract holds its result (CORE-170).
    pub async fn gets_rows(&self) -> Result<Rows> {
        self.gets().await.map(Rows)
    }

    /// `gets_by` as the class `rows` of the contract holds its result (CORE-170).
    /// The value argument is borrowed, as a generated binding passes it (binding design T-1).
    pub async fn gets_rows_by(&self, chain: &str, values: &[OrmValue]) -> Result<Rows> {
        self.gets_by(chain, values.to_vec()).await.map(Rows)
    }

    /// `get_count` with the conditions of `chain` joined by `and`; the query does not change (CORE-83).
    /// The value argument is borrowed, as a generated binding passes it (binding design T-1).
    pub async fn get_count_by(&self, chain: &str, values: &[OrmValue]) -> Result<i64> {
        self.by(chain, values.to_vec()).get_count().await
    }

    /// The value of the column `column` of a row as `orm_value` (CORE-62, CORE-83): a name that is no column of the entity is `column_unknown`,
    /// and a column that the row did not read is `column_unselected`.
    pub fn value(&self, column: &str) -> Result<OrmValue> {
        let manifest = self.core.entity().schema().manifest()?;
        let Some(field) = manifest.entity(self.core.entity().name())?.field(column) else {
            return Err(Error::new(Kind::ColumnUnknown, format!("{}.{column}", self.entity())));
        };
        self.core.require_field(column)?;
        let cell =
            self.values.get(column).cloned().ok_or_else(|| Error::internal(format!("the row read {}.{column} and holds no value of it", self.entity())))?;
        OrmValue::of_column(field, cell)
    }

    /// The values of the columns of the entity that the row read, by column name in the order of the schema (CORE-120).
    /// A column that the row did not read has no key, and a column whose value is null has the key with `Null`.
    pub fn to_array(&self) -> Result<OrderedMap<OrmValue>> {
        let columns = self.read_columns()?;
        let mut out = OrderedMap::with_capacity(columns.len());
        for column in columns {
            let value = self.value(&column)?;
            if out.insert(column, value).is_some() {
                return Err(Error::internal(format!("the entity {} names a column twice", self.entity())));
            }
        }
        Ok(out)
    }

    /// The columns of the entity that the row read, in the order of the schema (CORE-92).
    pub(crate) fn read_columns(&self) -> Result<Vec<String>> {
        let manifest = self.core.entity().schema().manifest()?;
        let entity = manifest.entity(self.core.entity().name())?;
        Ok(entity.fields.iter().filter(|field| self.core.field_ready(&field.name)).map(|field| field.name.clone()).collect())
    }

    /// The relation results of the row by their names, in the order that the row holds them (CORE-92).
    pub(crate) fn related_results(&self) -> Result<Vec<(String, Related)>> {
        let Some(row) = self.core.row.as_ref() else { return Ok(Vec::new()) };
        let mut out = Vec::with_capacity(row.related.len());
        for (name, related) in &row.related {
            let result = match &related.value {
                RelatedValue::Many(_) => Related::Many(self.related_rows(name)?.unwrap_or_default()),
                RelatedValue::One(_) => Related::One(self.related(name)?.map(Box::new)),
            };
            out.push((name.clone(), result));
        }
        Ok(out)
    }

    fn is_column(&self, name: &str) -> Result<bool> {
        let manifest = self.core.entity().schema().manifest()?;
        Ok(manifest.entity(self.core.entity().name())?.field(name).is_some())
    }
}

/// A relation result of a row: the row of a `relation` or the rows of a `relations` (CORE-88).
pub(crate) enum Related {
    One(Option<Box<Query>>),
    Many(Vec<Query>),
}

/// The connector of a chain name that starts with `And` or `Or`, and the name after it (CORE-82).
fn split_connector(chain: &str) -> (&'static str, &str) {
    match (chain.strip_prefix("And"), chain.strip_prefix("Or")) {
        (Some(rest), _) if starts_a_word(rest) => ("and", rest),
        (_, Some(rest)) if starts_a_word(rest) => ("or", rest),
        _ => ("", chain),
    }
}

/// Whether `rest`, the name after a connector word, starts a word of a chain name.
fn starts_a_word(rest: &str) -> bool {
    rest.starts_with(|first: char| first.is_ascii_uppercase())
}

/// The row that the assembler made by the descriptor of a `Query`.
fn row_query(row: Box<dyn AnyModel>) -> Result<Query> {
    row.into_any().downcast::<Query>().map(|row| *row).map_err(|_other| Error::internal("a row of a query is no Query"))
}

impl AnyModel for Query {
    fn core_dyn(&self) -> &Core {
        &self.core
    }

    fn core_dyn_mut(&mut self) -> &mut Core {
        &mut self.core
    }

    fn assign_dyn(&mut self, name: &str, value: Val) -> Result<bool> {
        if !self.is_column(name)? {
            return Ok(false);
        }
        self.values.insert(name.to_owned(), value);
        self.core.mark_field_ready(name);
        Ok(true)
    }

    fn value_dyn(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn into_any(self: Box<Self>) -> Box<dyn std::any::Any> {
        self
    }
}

#[cfg(test)]
#[path = "../tests/unit/query.rs"]
mod query_tests;

#[cfg(test)]
#[path = "../tests/unit/query_members.rs"]
mod query_members_tests;

#[cfg(test)]
#[path = "../tests/unit/query_step.rs"]
mod query_step_tests;
