//! The general query of the core (docs/spec/core.md CORE-81 to CORE-83): the query and the row state of one entity
//! that is chosen by its name. A generated model holds its columns in typed fields and names its entity in its type;
//! a `Query` holds them by name and names its entity in a value.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use polyspec_orm_schema::chain::{parse_chain, parse_order};

use crate::collection::{AnyCollection, Collection, Key};
use crate::core::{Arg, Core};
use crate::db::Statement;
use crate::model::{AnyModel, Boxed, Entity};
use crate::value::Val;
use crate::{Connection, Error, Kind, Result, Schema};

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

/// The descriptor of `name` in `schema`. The process keeps one per entity of a schema that a `Query` named (CORE-81),
/// because a core refers to its descriptor for the life of the process.
fn descriptor(schema: &'static Schema, name: &str) -> Result<&'static Entity> {
    static KEPT: Mutex<Vec<&'static Entity>> = Mutex::new(Vec::new());
    let mut kept = KEPT.lock().map_err(|_poisoned| Error::internal("the lock of the entity descriptors was poisoned by a panic"))?;
    if let Some(found) = kept.iter().find(|found| std::ptr::eq(found.schema, schema) && found.name == name) {
        return Ok(found);
    }
    let name: &'static str = Box::leak(name.to_owned().into_boxed_str());
    let entity: &'static Entity = Box::leak(Box::new(Entity { name, schema, new: new_query, collect: collect_queries }));
    kept.push(entity);
    Ok(entity)
}

impl Query {
    /// A query of the entity `entity` of `schema`; a name that the schema does not have is `entity_unknown` (CORE-81).
    pub fn new(schema: &Schema, entity: &str) -> Result<Query> {
        schema.manifest()?.entity(entity)?;
        let schema = schema.interned();
        Ok(Query { core: Core::new(descriptor(schema, entity)?), values: IndexMap::new() })
    }

    /// The name of the entity.
    pub fn entity(&self) -> &str {
        self.core.entity().name
    }

    /// Sets the connection of the query: a `Db`, or the `Tx` of a transaction, in which its terminals then run
    /// (CORE-20, CORE-81).
    pub fn connect(&mut self, connection: Connection) {
        self.core.connect(connection);
    }

    /// Adds the conditions of the chain name `chain`, one value of `values` per key (CORE-82). A name that starts with
    /// `And` or `Or` joins its first condition to the conditions before it with that connector. A refused name or
    /// number of values is `config` at the next terminal.
    pub fn where_chain(&mut self, chain: &str, values: Vec<Arg>) {
        let (connector, name) = match (chain.strip_prefix("And"), chain.strip_prefix("Or")) {
            (Some(rest), _) if starts_a_word(rest) => ("and", rest),
            (_, Some(rest)) if starts_a_word(rest) => ("or", rest),
            _ => ("", chain),
        };
        self.chain(connector, name, values);
    }

    fn chain(&mut self, connector: &'static str, name: &str, values: Vec<Arg>) {
        let manifest = match self.core.entity().schema.manifest() {
            Ok(manifest) => manifest,
            Err(error) => return self.core.fail_err(error),
        };
        let entity = match manifest.entity(self.core.entity().name) {
            Ok(entity) => entity,
            Err(error) => return self.core.fail_err(error),
        };
        match parse_chain(&manifest.model, entity, name) {
            Ok(keys) => self.core.chain_parsed(connector, &keys, values),
            Err(message) => self.core.fail(message),
        }
    }

    /// Adds the order of the name `spec`, such as `SeqDescAndLabelAsc` (CORE-82). A refused name is `config` at the next
    /// terminal.
    pub fn order_by(&mut self, spec: &str) {
        let manifest = match self.core.entity().schema.manifest() {
            Ok(manifest) => manifest,
            Err(error) => return self.core.fail_err(error),
        };
        let entity = match manifest.entity(self.core.entity().name) {
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

    /// A copy of the query with the conditions of `chain` joined by `and` (CORE-83).
    fn by(&self, chain: &str, values: Vec<Arg>) -> Query {
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
    pub async fn get_by(&self, chain: &str, values: Vec<Arg>) -> Result<Option<Query>> {
        self.by(chain, values).get().await
    }

    /// `gets` with the conditions of `chain` joined by `and`; the query does not change (CORE-83).
    pub async fn gets_by(&self, chain: &str, values: Vec<Arg>) -> Result<Collection<Query>> {
        self.by(chain, values).gets().await
    }

    /// `get_count` with the conditions of `chain` joined by `and`; the query does not change (CORE-83).
    pub async fn get_count_by(&self, chain: &str, values: Vec<Arg>) -> Result<i64> {
        self.by(chain, values).get_count().await
    }

    /// The value of the column `column` of a row (CORE-83): a name that is no column of the entity is `column_unknown`,
    /// and a column that the row did not read is `column_unselected`.
    pub fn value(&self, column: &str) -> Result<Val> {
        if !self.is_column(column)? {
            return Err(Error::new(Kind::ColumnUnknown, format!("{}.{column}", self.entity())));
        }
        self.core.require_field(column)?;
        self.values.get(column).cloned().ok_or_else(|| Error::internal(format!("the row read {}.{column} and holds no value of it", self.entity())))
    }

    fn is_column(&self, name: &str) -> Result<bool> {
        let manifest = self.core.entity().schema.manifest()?;
        Ok(manifest.entity(self.core.entity().name)?.field(name).is_some())
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
