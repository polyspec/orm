//! The general query of the core (docs/spec/core.md CORE-81 to CORE-83): the query and the row state of one entity
//! that is chosen by its name. A generated model holds its columns in typed fields and names its entity in its type;
//! a `Query` holds them by name and names its entity in a value.

use std::collections::HashMap;
use std::sync::Arc;

use indexmap::IndexMap;
use polyspec_orm_schema::chain::{parse_chain, parse_order, split_pair, ChainKey};

use crate::args::Value;
use crate::collection::{AnyCollection, Collection, Key};
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

fn new_query(core: Core) -> Box<dyn AnyModel> {
    Box::new(Query { core, values: IndexMap::new() })
}

fn collect_queries(items: Boxed, fetched: HashMap<Key, serde_json::Value>) -> Arc<dyn AnyCollection> {
    Arc::new(Collection::<Query>::from_boxes(items, fetched))
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
    pub fn where_chain(&mut self, chain: &str, values: Vec<OrmValue>) {
        let (connector, name) = split_connector(chain);
        self.chain(connector, name, values);
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
        match parse_chain(&manifest.model, entity, name) {
            Ok(keys) => Some(keys),
            Err(message) => {
                self.core.fail(message);
                None
            }
        }
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
        let manifest = match self.core.entity().schema().manifest() {
            Ok(manifest) => manifest,
            Err(error) => return self.core.fail_err(error),
        };
        let entity = match manifest.entity(self.core.entity().name()) {
            Ok(entity) => entity,
            Err(error) => return self.core.fail_err(error),
        };
        match parse_order(entity, spec) {
            Ok(keys) => {
                for (column, descending) in keys {
                    self.core.order_by(&column, descending, None);
                }
            }
            Err(message) => self.core.fail(message),
        }
    }

    /// Reads at most `count` rows after the first `offset` rows of the order (CORE-85). A `count` of 0 is `config` at
    /// the next terminal.
    pub fn limit(&mut self, offset: u32, count: u32) {
        self.core.limit(offset, count);
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
        let manifest = match self.core.entity().schema().manifest() {
            Ok(manifest) => manifest,
            Err(error) => return self.core.fail_err(error),
        };
        let entity = match manifest.entity(self.core.entity().name()) {
            Ok(entity) => entity,
            Err(error) => return self.core.fail_err(error),
        };
        match split_pair(&manifest.model, None, Some(entity), pair) {
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
    pub fn set(&mut self, column: &str, value: OrmValue) {
        if !self.known_column(column) {
            return;
        }
        match value {
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

    /// Makes the next `update` or `delete` write only while the integer column `column` holds `revision`; `update` also
    /// stores `revision + 1` (CORE-91, DSL-108).
    pub fn expect_revision(&mut self, column: &str, revision: i64) {
        self.core.expect_revision(column, revision);
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

    /// Runs the count of the query (CORE-83).
    pub async fn get_count(&self) -> Result<i64> {
        crate::model::get_count(&self.core).await
    }

    /// The statement of the query, which is not run (CORE-83).
    pub async fn get_query(&self) -> Result<Statement> {
        crate::model::get_query(&self.core).await
    }

    /// `get` with the conditions of `chain` joined by `and`; the query does not change (CORE-83).
    pub async fn get_by(&self, chain: &str, values: Vec<OrmValue>) -> Result<Option<Query>> {
        self.by(chain, values).get().await
    }

    /// `gets` with the conditions of `chain` joined by `and`; the query does not change (CORE-83).
    pub async fn gets_by(&self, chain: &str, values: Vec<OrmValue>) -> Result<Collection<Query>> {
        self.by(chain, values).gets().await
    }

    /// `get_count` with the conditions of `chain` joined by `and`; the query does not change (CORE-83).
    pub async fn get_count_by(&self, chain: &str, values: Vec<OrmValue>) -> Result<i64> {
        self.by(chain, values).get_count().await
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
    pub fn to_array(&self) -> Result<IndexMap<String, OrmValue>> {
        self.read_columns()?.into_iter().map(|column| self.value(&column).map(|value| (column, value))).collect()
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
