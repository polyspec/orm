//! The `Db` step (docs/spec/core.md CORE-92): a query of the core of another library held as data, which a host runs
//! with orm without a judgement of its own. A step is JSON text; its query is the members of `Query` with their
//! arguments in the order of the calls, and its outcome is the result or the kind of the failure.

use std::collections::BTreeMap;
use std::sync::Arc;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::collection::Collection;
use crate::orm_value::JsonValue;
use crate::{Connection, Error, Isolation, Kind, OrmValue, Query, Result, Schema, TransactionOptions, Tx};

/// One step (CORE-92).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// Runs the query `query` with the terminal `terminal`.
    Query { query: QueryTree, terminal: Terminal },
    /// Opens a transaction of the connection of the runner, whose callback runs the steps that follow (CORE-93).
    Transaction {
        #[serde(default)]
        options: StepOptions,
    },
    /// Opens a savepoint of the innermost transaction or savepoint, whose callback runs the steps that follow (CORE-93).
    Savepoint,
    /// Ends the callback of the innermost transaction or savepoint: it commits or releases it, or with `rollback` rolls
    /// it back (CORE-93).
    End { rollback: bool },
}

/// The options of a transaction step (CORE-93): those of `TransactionOptions` but `retry`, which is 0.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepOptions {
    #[serde(default)]
    pub isolation: Option<StepIsolation>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// The audit values by column (CORE-20).
    #[serde(default)]
    pub audit: Option<BTreeMap<String, StepValue>>,
}

/// The isolation level of a transaction step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepIsolation {
    ReadUncommitted,
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

impl StepOptions {
    /// The options of the transaction of the step, with `retry` 0: the core that asked runs it again on `deadlock`.
    fn transaction(self) -> Result<TransactionOptions> {
        let isolation = self.isolation.map(|level| match level {
            StepIsolation::ReadUncommitted => Isolation::ReadUncommitted,
            StepIsolation::ReadCommitted => Isolation::ReadCommitted,
            StepIsolation::RepeatableRead => Isolation::RepeatableRead,
            StepIsolation::Serializable => Isolation::Serializable,
        });
        let audit = match self.audit {
            Some(values) => Some(
                values
                    .into_iter()
                    .map(|(column, value)| match value.0.scalar() {
                        Ok(param) => Ok((column, param)),
                        Err(_refused) => Err(Error::new(Kind::CodecEncode, format!("the audit value of {column} is no value of a column"))),
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
            None => None,
        };
        Ok(TransactionOptions { isolation, read_only: self.read_only, timeout_ms: self.timeout_ms, retry: Some(0), audit })
    }
}

/// A query: the entity and the members of `Query` called on it in order (CORE-92).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryTree {
    pub entity: String,
    #[serde(default)]
    pub calls: Vec<Call>,
}

/// A member of `Query` with its arguments (CORE-92).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "call", rename_all = "snake_case", deny_unknown_fields)]
pub enum Call {
    Where { chain: String, values: Vec<StepValue> },
    WhereIn { chain: String, query: QueryTree },
    OrderBy { spec: String },
    Limit { offset: u32, count: u32 },
    ForUpdate,
    ForShare,
    ForUpdateNoWait,
    ForShareNoWait,
    AddAllColumns,
    RemoveAllColumns,
    AddColumn { column: String },
    RemoveColumn { column: String },
    KeyName { column: String },
    MatchPair { pair: String },
    Alias { name: String },
    Relation { query: QueryTree },
    Relations { query: QueryTree },
    Set { column: String, value: StepValue },
    ExpectRevision { column: String, revision: i64 },
}

/// The terminal of a query step (CORE-92).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Terminal {
    Get,
    Gets,
    GetCount,
    Create,
    Update,
    Delete,
}

/// An `orm_value` in the case form of CORE-71: `{"kind": <kind>, "value": ..}`, bytes as `{"hex": ..}` and a JSON value
/// as `{"kind": "json_value", "text": <JSON text>}` (CORE-92).
#[derive(Debug, Clone, PartialEq)]
pub struct StepValue(pub OrmValue);

impl Serialize for StepValue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        value_json(&self.0).map_err(serde::ser::Error::custom)?.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for StepValue {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<StepValue, D::Error> {
        let value = Value::deserialize(deserializer)?;
        json_value(&value).map(StepValue).map_err(serde::de::Error::custom)
    }
}

/// The case form of `value`; a float that is not finite has none, so it is `codec_encode`.
fn value_json(value: &OrmValue) -> Result<Value> {
    let of = |kind: &str, value: Value| json!({"kind": kind, "value": value});
    Ok(match value {
        OrmValue::Null => json!({"kind": "null"}),
        OrmValue::Bool(flag) => of("bool", Value::from(*flag)),
        OrmValue::Int(n) => of("int", Value::from(*n)),
        OrmValue::Int64(n) => of("int64", Value::from(*n)),
        OrmValue::Float(x) => match serde_json::Number::from_f64(*x) {
            Some(number) => of("float", Value::Number(number)),
            None => return Err(Error::new(Kind::CodecEncode, format!("the float {x} has no JSON form"))),
        },
        OrmValue::Text(text) => of("text", Value::from(text.as_str())),
        OrmValue::Bytes(bytes) => of("bytes", json!({"hex": bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()})),
        OrmValue::Json(json) => json!({"kind": "json_value", "text": json.value().to_string()}),
        OrmValue::List(items) => of("list", Value::Array(items.iter().map(value_json).collect::<Result<Vec<Value>>>()?)),
        OrmValue::Map(entries) => {
            of("map", Value::Object(entries.iter().map(|(key, entry)| Ok((key.clone(), value_json(entry)?))).collect::<Result<Map<String, Value>>>()?))
        }
    })
}

/// The `orm_value` of its case form; another form is a message of the refusal.
fn json_value(value: &Value) -> std::result::Result<OrmValue, String> {
    let kind = value.get("kind").and_then(Value::as_str).ok_or_else(|| format!("the value {value} names no kind"))?;
    let inner = value.get("value");
    let wrong = || format!("the value {value} is no value of the kind {kind}");
    Ok(match kind {
        "null" => OrmValue::Null,
        "bool" => OrmValue::Bool(inner.and_then(Value::as_bool).ok_or_else(wrong)?),
        "int" => OrmValue::Int(inner.and_then(Value::as_i64).ok_or_else(wrong)?),
        "int64" => OrmValue::Int64(inner.and_then(Value::as_i64).ok_or_else(wrong)?),
        "float" => OrmValue::Float(inner.and_then(Value::as_f64).ok_or_else(wrong)?),
        "text" => OrmValue::Text(inner.and_then(Value::as_str).ok_or_else(wrong)?.to_owned()),
        "bytes" => {
            let hex = inner.and_then(|bytes| bytes.get("hex")).and_then(Value::as_str).ok_or_else(wrong)?;
            OrmValue::Bytes(hex_bytes(hex).ok_or_else(wrong)?)
        }
        "json_value" => {
            let text = value.get("text").and_then(Value::as_str).ok_or_else(wrong)?;
            let parsed = polyspec_json::parse(text.as_bytes(), &polyspec_json::ParseOptions::default())
                .map_err(|error| format!("the JSON text of {value} does not parse: {error}"))?;
            OrmValue::Json(JsonValue::new(parsed).map_err(|error| error.to_string())?)
        }
        "list" => OrmValue::List(inner.and_then(Value::as_array).ok_or_else(wrong)?.iter().map(json_value).collect::<std::result::Result<_, _>>()?),
        "map" => OrmValue::Map(
            inner
                .and_then(Value::as_object)
                .ok_or_else(wrong)?
                .iter()
                .map(|(key, entry)| Ok((key.clone(), json_value(entry)?)))
                .collect::<std::result::Result<IndexMap<String, OrmValue>, String>>()?,
        ),
        other => return Err(format!("the kind {other} is no kind of orm_value")),
    })
}

/// The bytes of a text of pairs of lower-case hexadecimal digits.
fn hex_bytes(hex: &str) -> Option<Vec<u8>> {
    let digit = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let bytes = hex.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    bytes.chunks(2).map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?)).collect()
}

/// Runs the steps of the core of another library on one connection (CORE-92), and the steps of its transactions and
/// savepoints on their handles (CORE-93).
pub struct StepRunner {
    schema: Schema,
    connection: Connection,
    /// The open transaction and savepoints, the innermost last.
    frames: Vec<Frame>,
}

/// An open transaction or savepoint: the handle that its callback received, the end that the callback waits for and
/// the task that runs it. A frame dropped without its end drops `end`, so the callback rolls back.
struct Frame {
    handle: Tx,
    end: oneshot::Sender<bool>,
    task: JoinHandle<Result<()>>,
}

/// The error of a callback that its end step rolled back (CORE-93).
const ROLLED_BACK: &str = "the end step rolled back the callback";

/// What a callback of a frame receives: where it sends its handle, and the end that it waits for.
type Parts = (oneshot::Sender<Tx>, oneshot::Receiver<bool>);

/// The callback of a frame: it sends its handle to the runner and waits for its end, which commits or releases it on
/// `false` and rolls it back on `true` or when the runner is dropped (CORE-93).
async fn serve(handle: Tx, parts: Arc<std::sync::Mutex<Option<Parts>>>) -> Result<()> {
    let taken = parts.lock().map_err(|_poisoned| Error::internal("the parts of a step callback were poisoned by a panic"))?.take();
    let Some((send, end)) = taken else {
        return Err(Error::internal("the callback of a step transaction ran twice"));
    };
    if send.send(handle).is_err() {
        return Err(Error::new(Kind::Internal, ROLLED_BACK));
    }
    match end.await {
        Ok(false) => Ok(()),
        Ok(true) | Err(_) => Err(Error::new(Kind::Internal, ROLLED_BACK)),
    }
}

impl StepRunner {
    /// A runner of the steps of `schema` on `connection`.
    #[must_use]
    pub fn new(schema: &Schema, connection: Connection) -> StepRunner {
        StepRunner { schema: schema.clone(), connection, frames: Vec::new() }
    }

    /// Runs the step of the JSON text `step` and returns its outcome as JSON text: `{"ok": <result>}`, or
    /// `{"error": {"kind": <kind>, "message": <message>}}` (CORE-92).
    pub async fn run(&mut self, step: &str) -> String {
        let outcome = match serde_json::from_str::<Step>(step) {
            Ok(step) => self.run_step(step).await,
            Err(error) => Err(Error::config(format!("the text is no step of CORE-92: {error}"))),
        };
        outcome_text(outcome)
    }

    /// Rolls back every open transaction and savepoint, the innermost first, and returns when they ended (CORE-93); the
    /// outcome is `{"ok": {}}`, or the first failure of a rollback. The runner then runs its steps on its connection.
    pub async fn close(&mut self) -> String {
        let mut first = None;
        while !self.frames.is_empty() {
            if let Err(error) = self.end(true).await {
                first.get_or_insert(error);
            }
        }
        outcome_text(first.map_or(Ok(json!({})), Err))
    }

    /// The connection of the next query step: the handle of the innermost frame, or the connection of the runner.
    fn current(&self) -> Connection {
        match self.frames.last() {
            Some(frame) => Connection::Tx(frame.handle.clone()),
            None => self.connection.clone(),
        }
    }

    async fn run_step(&mut self, step: Step) -> Result<Value> {
        match step {
            Step::Query { query, terminal } => {
                let mut query = build(&self.schema, query)?;
                query.connect(self.current());
                run_terminal(query, terminal).await
            }
            Step::Transaction { options } => {
                let Connection::Db(db) = &self.connection else {
                    return Err(Error::config("a transaction step needs a runner on a Db; in a transaction a step opens a savepoint"));
                };
                if !self.frames.is_empty() {
                    return Err(Error::config("a transaction step inside a transaction; a step opens a savepoint there"));
                }
                let options = options.transaction()?;
                let db = db.clone();
                self.open(move |parts| tokio::spawn(async move { db.transaction(move |tx| serve(tx, Arc::clone(&parts)), options).await })).await
            }
            Step::Savepoint => {
                let Some(parent) = self.frames.last().map(|frame| frame.handle.clone()) else {
                    return Err(Error::config("a savepoint step needs an open transaction"));
                };
                self.open(move |parts| tokio::spawn(async move { parent.savepoint(move |sp| serve(sp, parts)).await })).await
            }
            Step::End { rollback } => self.end(rollback).await.map(|()| json!({})),
        }
    }

    /// Opens a frame whose task `start` spawns with the parts of its callback; a frame whose callback does not run
    /// returns the failure of its task, such as the failure of `BEGIN`.
    async fn open(&mut self, start: impl FnOnce(Arc<std::sync::Mutex<Option<Parts>>>) -> JoinHandle<Result<()>>) -> Result<Value> {
        let (send, handle) = oneshot::channel();
        let (end, ended) = oneshot::channel();
        let task = start(Arc::new(std::sync::Mutex::new(Some((send, ended)))));
        match handle.await {
            Ok(handle) => {
                self.frames.push(Frame { handle, end, task });
                Ok(json!({}))
            }
            Err(_unsent) => match joined(task.await) {
                Err(error) => Err(error),
                Ok(()) => Err(Error::internal("a step transaction ended before its callback ran")),
            },
        }
    }

    /// Ends the innermost frame: its callback succeeds, or with `rollback` fails, and the outcome is the outcome of its
    /// end (CORE-93).
    async fn end(&mut self, rollback: bool) -> Result<()> {
        let Some(Frame { end, task, .. }) = self.frames.pop() else {
            return Err(Error::config("an end step needs an open transaction or savepoint"));
        };
        let delivered = end.send(rollback).is_ok();
        match joined(task.await) {
            Ok(()) if delivered => Ok(()),
            Ok(()) => Err(Error::internal("the callback of a step transaction ended before its end step")),
            Err(error) if rollback && error.kind() == Kind::Internal && error.text() == ROLLED_BACK => Ok(()),
            Err(error) => Err(error),
        }
    }
}

/// The result of the task of a frame; a task that panicked is `internal`.
fn joined(result: std::result::Result<Result<()>, tokio::task::JoinError>) -> Result<()> {
    result.map_err(|error| Error::internal(format!("the task of a step transaction failed: {error}")))?
}

/// The JSON text of an outcome (CORE-92).
fn outcome_text(outcome: Result<Value>) -> String {
    let outcome = outcome.and_then(|result| {
        serde_json::to_string(&json!({"ok": result})).map_err(|error| Error::internal(format!("the result of a step has no JSON text: {error}")))
    });
    match outcome {
        Ok(text) => text,
        Err(error) => json!({"error": {"kind": error.kind().as_str(), "message": error.to_string()}}).to_string(),
    }
}

/// The `Query` of a query tree, with its calls in order (CORE-92).
fn build(schema: &Schema, tree: QueryTree) -> Result<Query> {
    let mut query = Query::new(schema, &tree.entity)?;
    for call in tree.calls {
        match call {
            Call::Where { chain, values } => query.where_chain(&chain, values.into_iter().map(|value| value.0).collect()),
            Call::WhereIn { chain, query: sub } => query.where_in(&chain, build(schema, sub)?),
            Call::OrderBy { spec } => query.order_by(&spec),
            Call::Limit { offset, count } => query.limit(offset, count),
            Call::ForUpdate => query.for_update(),
            Call::ForShare => query.for_share(),
            Call::ForUpdateNoWait => query.for_update_no_wait(),
            Call::ForShareNoWait => query.for_share_no_wait(),
            Call::AddAllColumns => query.add_all_columns(),
            Call::RemoveAllColumns => query.remove_all_columns(),
            Call::AddColumn { column } => query.add_column(&column),
            Call::RemoveColumn { column } => query.remove_column(&column),
            Call::KeyName { column } => query.key_name(&column),
            Call::MatchPair { pair } => query.match_pair(&pair),
            Call::Alias { name } => query.alias(&name),
            Call::Relation { query: child } => query.relation(build(schema, child)?),
            Call::Relations { query: child } => query.relations(build(schema, child)?),
            Call::Set { column, value } => query.set(&column, value.0),
            Call::ExpectRevision { column, revision } => query.expect_revision(&column, revision),
        }
    }
    Ok(query)
}

/// Runs the terminal `terminal` of `query` and returns its result (CORE-92).
async fn run_terminal(mut query: Query, terminal: Terminal) -> Result<Value> {
    Ok(match terminal {
        Terminal::Get => json!({"row": query.get().await?.as_ref().map(row_json).transpose()?}),
        Terminal::Gets => json!({"rows": rows_json(&query.gets().await?)?}),
        Terminal::GetCount => json!({"count": query.get_count().await?}),
        Terminal::Create => json!({"row": row_json(&query.create().await?)?}),
        Terminal::Update => {
            query.update().await?;
            json!({})
        }
        Terminal::Delete => {
            query.delete().await?;
            json!({})
        }
    })
}

/// The rows of a collection with their keys, in the order of the collection.
fn rows_json(rows: &Collection<Query>) -> Result<Value> {
    rows.iter().map(|(key, row)| Ok(json!({"key": key.to_json(), "row": row_json(row)?}))).collect::<Result<Vec<Value>>>().map(Value::Array)
}

/// A row: the columns that it read and its relation results (CORE-92).
fn row_json(row: &Query) -> Result<Value> {
    let mut values = Map::new();
    for column in row.read_columns()? {
        values.insert(column.clone(), value_json(&row.value(&column)?)?);
    }
    let mut related = Map::new();
    for (name, result) in row.related_results()? {
        let value = match result {
            crate::query::Related::One(None) => Value::Null,
            crate::query::Related::One(Some(one)) => row_json(&one)?,
            crate::query::Related::Many(rows) => Value::Array(rows.iter().map(row_json).collect::<Result<Vec<Value>>>()?),
        };
        related.insert(name, value);
    }
    Ok(json!({"values": values, "related": related}))
}
