//! The `Db` step (docs/spec/core.md CORE-92): a query of the core of another library held as data, which a host runs
//! with orm without a judgement of its own. A step is JSON text; its query is the members of `Query` with their
//! arguments in the order of the calls, and its outcome is the result or the kind of the failure.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::collection::Collection;
use crate::orm_value::JsonValue;
use crate::{Connection, Error, Kind, OrmValue, Query, Result, Schema};

/// One step (CORE-92).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// Runs the query `query` with the terminal `terminal`.
    Query { query: QueryTree, terminal: Terminal },
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

/// Runs the steps of the core of another library on one connection (CORE-92).
pub struct StepRunner {
    schema: Schema,
    connection: Connection,
}

impl StepRunner {
    /// A runner of the steps of `schema` on `connection`.
    #[must_use]
    pub fn new(schema: &Schema, connection: Connection) -> StepRunner {
        StepRunner { schema: schema.clone(), connection }
    }

    /// Runs the step of the JSON text `step` and returns its outcome as JSON text: `{"ok": <result>}`, or
    /// `{"error": {"kind": <kind>, "message": <message>}}` (CORE-92).
    pub async fn run(&mut self, step: &str) -> String {
        let outcome = match serde_json::from_str::<Step>(step) {
            Ok(step) => self.run_step(step).await,
            Err(error) => Err(Error::config(format!("the text is no step of CORE-92: {error}"))),
        };
        let outcome = outcome.and_then(|result| {
            serde_json::to_string(&json!({"ok": result})).map_err(|error| Error::internal(format!("the result of a step has no JSON text: {error}")))
        });
        match outcome {
            Ok(text) => text,
            Err(error) => json!({"error": {"kind": error.kind().as_str(), "message": error.to_string()}}).to_string(),
        }
    }

    /// Ends what the runner holds open (CORE-93).
    pub async fn close(&mut self) {}

    async fn run_step(&mut self, step: Step) -> Result<Value> {
        match step {
            Step::Query { query, terminal } => {
                let mut query = build(&self.schema, query)?;
                query.connect(self.connection.clone());
                run_terminal(query, terminal).await
            }
        }
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
