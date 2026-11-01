//! The recipe helper of Rust (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit, the
//! libtest-mimic program `<recipe>_<database>`, passes the trials of [`trials`] for the recipe and the database to the
//! runner, and each case of the recipe is the trial `<recipe>_<database>::<case id>`, whose steps call the public API of
//! `polyspec_orm` that each op names. It has no command line and no output of its own.

use std::collections::HashMap;

use crate::markdown;
use polyspec_orm::codec;
use polyspec_orm::ordered_json::{self, Kind};
use polyspec_orm::{Param, StyledValue, Val};
use serde_json::{Map, Number, Value};

/// The database part of a recipe without a database (FCV-3).
pub const NONE: &str = "none";

/// What a step produced: its value, or the code and message of its error.
type Outcome = Result<Produced, (String, String)>;

#[derive(Clone)]
enum Produced {
    /// The value a decode or a host decode read.
    Read(Val),
    /// The cell an encode, a host encode or a blind index wrote.
    Written(Param),
}

/// One trial for each case of the recipe at `path`, relative to the repository root, on `database`, named
/// `<entry>::<case id>`.
pub fn trials(entry: &str, path: &str, database: &str) -> Vec<polyspec_orm_testcase::Trial> {
    assert_eq!(database, NONE, "recipe {path}: database {database} has no case database in this helper");
    let root = polyspec_orm_testcase::manifest_dir().join("../../..");
    let text = match std::fs::read_to_string(root.join(path)) {
        Ok(text) => text,
        Err(error) => panic!("recipe {path}: {error}"),
    };
    let recipe: Value = match serde_json::from_str(&text) {
        Ok(recipe) => recipe,
        Err(error) => panic!("recipe {path}: {error}"),
    };
    let Some(cases) = recipe["cases"].as_array() else { panic!("recipe {path} has no cases") };
    cases
        .iter()
        .map(|case| {
            let case = case.clone();
            let (path, database) = (path.to_owned(), database.to_owned());
            let id = case["id"].as_str().unwrap_or_default().to_owned();
            polyspec_orm_testcase::trial(format!("{entry}::{id}"), polyspec_orm_testcase::COMPUTE, move || {
                let mut bound = HashMap::new();
                let steps = case["steps"].as_array().cloned().unwrap_or_default();
                for (index, step) in steps.iter().enumerate() {
                    if let Err(failure) = run(step, &mut bound, &database) {
                        panic!("recipe {path} case {id} step {index} ({}) on {database}: {failure}", step["op"]);
                    }
                }
            })
        })
        .collect()
}

/// Maps the op of `step` to its call and checks the result against the expect of `database`.
fn run(step: &Value, bound: &mut HashMap<String, Outcome>, database: &str) -> Result<(), String> {
    if step["op"] == "ir.answer" {
        // The chain runs on a listener that answers with the step's answer (or answers), and its value is compared as JSON (FCV-3).
        let got = markdown::answer(step["chain"].as_str().unwrap_or_default(), &step["answer"], &step["answers"]);
        let want = &step["expect"][database]["value"];
        return if markdown::same(&got, want) { Ok(()) } else { Err(format!("got {got}, want {want}")) };
    }
    let styles: Vec<String> = step["styles"].as_array().map(|s| s.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    let key = step["key"].as_str().unwrap_or_default();
    let op = step["op"].as_str().unwrap_or_default();
    let failed = |error: polyspec_orm::Error| (error.code().to_owned(), error.to_string());
    let outcome: Outcome = match op {
        "codec.decode" => codec::decode(&styles, &cell(&step["raw"], bound)?).map(Produced::Read).map_err(failed),
        "codec.encode" => encode(&styles, &step["value"], bound)?.map(Produced::Written).map_err(failed),
        "codec.host_encode" => codec::host_encode(&param(&step["value"], bound)?, &styles, key).map(Produced::Written).map_err(failed),
        "codec.host_decode" => codec::host_decode(&cell(&step["raw"], bound)?, &styles, key).map(Produced::Read).map_err(failed),
        "codec.blind_index" => codec::blind_index(&param(&step["value"], bound)?, key).map(|text| Produced::Written(Param::Str(text))).map_err(failed),
        other => return Err(format!("OP_UNKNOWN {other}")),
    };
    if let Some(name) = step["as"].as_str() {
        bound.insert(name.to_owned(), outcome.clone());
    }
    let Some(expect) = step["expect"].get(database) else {
        return match outcome {
            Err((_, message)) => Err(format!("unexpected error {message}")),
            Ok(_) => Ok(()),
        };
    };
    if let Some(code) = expect["error"].as_str() {
        return match outcome {
            Err((got, _)) if got == code => Ok(()),
            Err((got, message)) => Err(format!("error {got} ({message}), want {code}")),
            Ok(_) => Err(format!("error none, want {code}")),
        };
    }
    let want = &expect["value"];
    match outcome {
        Err((_, message)) => Err(format!("unexpected error {message}")),
        Ok(Produced::Written(written)) => compare_cell(want, &written),
        Ok(Produced::Read(Val::Null)) if want.get("null").is_some() => Ok(()),
        Ok(Produced::Read(read)) if op == "codec.host_decode" => compare_cell(want, &read_param(read)),
        Ok(Produced::Read(read)) => {
            let ordered = styles.iter().any(|s| s == "ordered_json");
            let got = from_val(&read)?;
            if equal(&got, want, ordered) {
                Ok(())
            } else {
                Err(format!("decoded {got}, want {want}"))
            }
        }
    }
}

/// The cell form of a value a host decode read.
fn read_param(read: Val) -> Param {
    match read {
        Val::Str(text) => Param::Str(text),
        Val::Bytes(bytes) => Param::Bytes(bytes),
        other => Param::Str(format!("{other:?}")),
    }
}

/// Compares the cell of an encode, a host decode or a blind index with a wrapper: bytes by bytes, a text cell by its UTF-8
/// bytes (FCV-4), and SQL NULL with null.
fn compare_cell(want: &Value, cell: &Param) -> Result<(), String> {
    let got: Vec<u8> = match cell {
        Param::Null if want.get("null").is_some() => return Ok(()),
        Param::Null => return Err(format!("no cell, want {want}")),
        Param::Str(text) => text.as_bytes().to_vec(),
        Param::Bytes(bytes) => bytes.clone(),
        other => return Err(format!("cell {other:?}")),
    };
    let expected = if let Some(hex) = want["bytes_hex"].as_str() {
        hex_bytes(hex)?
    } else if let Some(text) = want["text"].as_str() {
        text.as_bytes().to_vec()
    } else {
        return Err(format!("a cell compares with bytes_hex or text, not {want}"));
    };
    if got == expected {
        Ok(())
    } else {
        Err(format!("cell {}, want {}", hex_text(&got), hex_text(&expected)))
    }
}

fn hex_bytes(hex: &str) -> Result<Vec<u8>, String> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("x"), 16).map_err(|e| e.to_string())).collect()
}

fn hex_text(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn reference<'a>(name: &str, bound: &'a HashMap<String, Outcome>) -> Result<&'a Produced, String> {
    match bound.get(name) {
        None => Err(format!("ref {name} names no bound result")),
        Some(Err((_, message))) => Err(format!("ref {name} names a failed step: {message}")),
        Some(Ok(produced)) => Ok(produced),
    }
}

/// A stored cell: the cell a ref names, or a wrapper's text, bytes or SQL NULL.
fn cell(raw: &Value, bound: &HashMap<String, Outcome>) -> Result<Val, String> {
    if let Some(name) = raw["ref"].as_str() {
        return Ok(match reference(name, bound)? {
            Produced::Written(Param::Null) => Val::Null,
            Produced::Written(Param::Str(text)) => Val::Str(text.clone()),
            Produced::Written(Param::Bytes(bytes)) => Val::Bytes(bytes.clone()),
            Produced::Read(read) => read.clone(),
            Produced::Written(other) => return Err(format!("ref {name} is the cell {other:?}")),
        });
    }
    match kind(raw)? {
        ("null", _) => Ok(Val::Null),
        ("text", body) => Ok(Val::Str(body.as_str().unwrap_or_default().to_owned())),
        ("bytes_hex", body) => Ok(Val::Bytes(hex_bytes(body.as_str().unwrap_or_default())?)),
        (other, _) => Err(format!("a {other} wrapper is not a cell")),
    }
}

/// A bound value of a host encode or a blind index: text, bytes, an integer, a float, a bool or SQL NULL.
fn param(raw: &Value, bound: &HashMap<String, Outcome>) -> Result<Param, String> {
    if let Some(name) = raw["ref"].as_str() {
        return match reference(name, bound)? {
            Produced::Written(written) => Ok(written.clone()),
            Produced::Read(read) => Ok(read_param(read.clone())),
        };
    }
    match kind(raw)? {
        ("null", _) => Ok(Param::Null),
        ("text", body) => Ok(Param::Str(body.as_str().unwrap_or_default().to_owned())),
        ("bytes_hex", body) => Ok(Param::Bytes(hex_bytes(body.as_str().unwrap_or_default())?)),
        ("int", body) => body.as_str().unwrap_or_default().parse().map(Param::I64).map_err(|error| format!("int wrapper: {error}")),
        ("float", body) => body.as_str().unwrap_or_default().parse().map(Param::F64).map_err(|error| format!("float wrapper: {error}")),
        // Rust parses NaN, Infinity and -Infinity, the three non-finite values of the f64 wrapper.
        ("f64", body) => body.as_str().unwrap_or_default().parse().map(Param::F64).map_err(|error| format!("f64 wrapper: {error}")),
        ("bool", body) => body.as_bool().map(Param::Bool).ok_or_else(|| "a bool wrapper holds no boolean".to_owned()),
        (other, _) => Err(format!("a {other} wrapper is not a bound value")),
    }
}

/// An encode: SQL NULL for null, an ordered-json value for an ordered_json stage, so that its member order and number
/// text are those of the recipe, and the common value model otherwise.
fn encode(styles: &[String], raw: &Value, bound: &HashMap<String, Outcome>) -> Result<polyspec_orm::Result<Param>, String> {
    let stages: Vec<&str> = styles.iter().map(String::as_str).collect();
    if let Some(name) = raw["ref"].as_str() {
        return Ok(match reference(name, bound)? {
            Produced::Read(Val::Null) => Ok(Param::Null),
            Produced::Read(Val::Ordered(value)) => codec::encode_ordered(&stages, StyledValue::Value(value)),
            Produced::Read(Val::Json(value)) => codec::encode(&stages, StyledValue::Value(value)),
            Produced::Read(Val::Str(text)) => codec::encode(&stages, StyledValue::Value(&Value::String(text.clone()))),
            _ => return Err(format!("ref {name} is not a decoded value")),
        });
    }
    if raw.get("null").is_some() {
        return Ok(codec::encode(&stages, StyledValue::SqlNull));
    }
    // An ordered_json wrapper is the ordered-json value of its value, whatever the stages (FCV-4).
    if let Some(inner) = raw.get("ordered_json") {
        let value = ordered_json::parse(&json_text(inner)?).map_err(|e| e.to_string())?;
        return Ok(codec::encode_ordered(&stages, StyledValue::Value(&value)));
    }
    if styles.iter().any(|s| s == "ordered_json") {
        let value = ordered_json::parse(&json_text(raw)?).map_err(|e| e.to_string())?;
        return Ok(codec::encode_ordered(&stages, StyledValue::Value(&value)));
    }
    Ok(codec::encode(&stages, StyledValue::Value(&to_value(raw)?)))
}

fn kind(w: &Value) -> Result<(&str, &Value), String> {
    match w.as_object() {
        Some(map) if map.len() == 1 => map.iter().next().map(|(k, v)| (k.as_str(), v)).ok_or_else(|| format!("{w}")),
        _ => Err(format!("a value is a wrapper with one key: {w}")),
    }
}

/// A wrapper as JSON text with its members in order and its numbers as their recipe text.
fn json_text(w: &Value) -> Result<String, String> {
    Ok(match kind(w)? {
        ("nil", _) => "null".to_owned(),
        ("bool", body) => body.to_string(),
        ("int" | "float", body) => body.as_str().unwrap_or_default().to_owned(),
        ("text", body) => body.to_string(),
        ("array", body) => {
            let items: Result<Vec<String>, String> = body.as_array().into_iter().flatten().map(json_text).collect();
            format!("[{}]", items?.join(","))
        }
        ("object", body) => {
            let mut parts = Vec::new();
            for pair in body.as_array().into_iter().flatten() {
                parts.push(format!("{}:{}", pair[0], json_text(&pair[1])?));
            }
            format!("{{{}}}", parts.join(","))
        }
        (other, _) => return Err(format!("a {other} wrapper is not a codec value")),
    })
}

/// The serde_json value of a wrapper in the common value model of COD-16.
fn to_value(w: &Value) -> Result<Value, String> {
    Ok(match kind(w)? {
        ("nil", _) => Value::Null,
        ("bool", body) => body.clone(),
        ("int", body) => {
            let text = body.as_str().unwrap_or_default();
            match text.parse::<i64>() {
                Ok(i) => Value::from(i),
                Err(_) => Value::from(text.parse::<u64>().map_err(|e| e.to_string())?),
            }
        }
        ("float", body) => {
            let f: f64 = body.as_str().unwrap_or_default().parse().map_err(|e: std::num::ParseFloatError| e.to_string())?;
            Value::Number(Number::from_f64(f).ok_or("a float is finite")?)
        }
        ("text", body) => body.clone(),
        ("array", body) => Value::Array(body.as_array().into_iter().flatten().map(to_value).collect::<Result<_, _>>()?),
        ("object", body) => {
            let mut map = Map::new();
            for pair in body.as_array().into_iter().flatten() {
                map.insert(pair[0].as_str().unwrap_or_default().to_owned(), to_value(&pair[1])?);
            }
            Value::Object(map)
        }
        (other, _) => return Err(format!("a {other} wrapper is not a codec value")),
    })
}

/// The wrapper of a decoded value; an ordered-json value keeps its member order and number text.
fn from_val(read: &Val) -> Result<Value, String> {
    Ok(match read {
        Val::Ordered(value) => from_ordered(value)?,
        Val::Json(value) => from_json(value),
        Val::Str(text) => serde_json::json!({ "text": text }),
        Val::Bytes(bytes) => serde_json::json!({ "bytes_hex": hex_text(bytes) }),
        Val::I64(i) => serde_json::json!({ "int": i.to_string() }),
        Val::F64(f) => serde_json::json!({ "float": f.to_string() }),
        Val::Bool(b) => serde_json::json!({ "bool": b }),
        other => return Err(format!("decoded {other:?}")),
    })
}

fn from_json(value: &Value) -> Value {
    match value {
        Value::Null => serde_json::json!({ "nil": true }),
        Value::Bool(b) => serde_json::json!({ "bool": b }),
        Value::Number(n) if n.is_f64() => serde_json::json!({ "float": n.to_string() }),
        Value::Number(n) => serde_json::json!({ "int": n.to_string() }),
        Value::String(s) => serde_json::json!({ "text": s }),
        Value::Array(items) => serde_json::json!({ "array": items.iter().map(from_json).collect::<Vec<_>>() }),
        Value::Object(map) => serde_json::json!({ "object": map.iter().map(|(k, v)| serde_json::json!([k, from_json(v)])).collect::<Vec<_>>() }),
    }
}

fn from_ordered(value: &ordered_json::Value) -> Result<Value, String> {
    Ok(match value.kind() {
        Kind::Null => serde_json::json!({ "nil": true }),
        Kind::Boolean => serde_json::json!({ "bool": value.boolean_value() }),
        Kind::String => serde_json::json!({ "text": String::from_utf8(value.string_value().map_err(|e| e.to_string())?).map_err(|e| e.to_string())? }),
        Kind::Number => {
            let text = value.number_literal().unwrap_or_default();
            if text.contains(['.', 'e', 'E']) {
                serde_json::json!({ "float": text })
            } else {
                serde_json::json!({ "int": text })
            }
        }
        Kind::Array => serde_json::json!({ "array": value.items().unwrap_or_default().iter().map(from_ordered).collect::<Result<Vec<_>, _>>()? }),
        Kind::Object => {
            let mut pairs = Vec::new();
            for (k, v) in value.members().into_iter().flat_map(|m| m.iter()) {
                let name = String::from_utf8(k.string_value().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                pairs.push(serde_json::json!([name, from_ordered(v)?]));
            }
            serde_json::json!({ "object": pairs })
        }
    })
}

/// The number of a wrapper text; a text that is not a number is a fault of the recipe or the helper, which the schema refuses.
fn number<T: std::str::FromStr>(v: &Value) -> T
where
    T::Err: std::fmt::Display,
{
    match v.as_str().map(str::parse::<T>) {
        Some(Ok(n)) => n,
        Some(Err(error)) => panic!("the number text {v} does not parse: {error}"),
        None => panic!("the number {v} is not a text"),
    }
}

/// Compares a decoded wrapper with an expected one: an ordered-json value by its number text and member order (COD-16),
/// every other value by number value and with its object as a set of pairs (FCV-4).
fn equal(got: &Value, want: &Value, ordered: bool) -> bool {
    let (Ok((kind, a)), Ok((wanted, b))) = (self::kind(got), self::kind(want)) else { return false };
    if kind != wanted {
        return false;
    }
    match kind {
        "float" if !ordered => {
            let (x, y) = (number::<f64>(a), number::<f64>(b));
            x == y || x.is_nan() && y.is_nan()
        }
        "int" if !ordered => number::<i128>(a) == number::<i128>(b),
        "array" => {
            let (x, y) = (a.as_array().cloned().unwrap_or_default(), b.as_array().cloned().unwrap_or_default());
            x.len() == y.len() && x.iter().zip(&y).all(|(g, w)| equal(g, w, ordered))
        }
        "object" => {
            let (x, y) = (a.as_array().cloned().unwrap_or_default(), b.as_array().cloned().unwrap_or_default());
            if x.len() != y.len() {
                return false;
            }
            if ordered {
                x.iter().zip(&y).all(|(g, w)| g[0] == w[0] && equal(&g[1], &w[1], ordered))
            } else {
                y.iter().all(|w| x.iter().any(|g| g[0] == w[0] && equal(&g[1], &w[1], ordered)))
            }
        }
        _ => a == b,
    }
}

/// The database path (FCV-3 and FCV-4): each case runs on a case database of its own through the public catalog API.
pub use database::{database_trials, database_trials_with_models, ModelDispatcher, ModelFuture};

mod database {
    use std::collections::HashMap;
    use std::future::Future;
    use std::path::Path;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use polyspec_orm::db::{parse_dsn, ConnectOptions};
    use polyspec_orm::{dbspec, Config, Db, Schema, StatementEvent, Subscription, TransactionOnceError};
    use polyspec_orm_build::catalog::{CatalogConnection, MutationPhase, RowSnapshot, TableMetadata, TablePage, TableRef};
    use polyspec_orm_build::tool_db::{GridCell, GridQueryResult, ParamType, QueryLimits, Val, P};
    use polyspec_orm_case_database::CaseDatabase;
    use serde_json::{json, Map, Value};

    use super::hex_text;

    /// The databases of a recipe with a fixture (FCV-3).
    const DATABASES: [&str; 3] = ["mysql", "postgres", "sqlite"];
    /// The message of the error that a transaction callback returns when its op has fail: true.
    const CALLBACK_FAILED: &str = "statement events recipe callback failed";
    /// The expect code of that callback error; it is not an orm error code.
    const CALLBACK: &str = "CALLBACK";

    /// The publisher of the phases of a catalog mutation, as the catalog mutation methods take it.
    type Publish = Arc<dyn Fn(MutationPhase) + Send + Sync>;
    /// The permit of a catalog mutation, as the catalog mutation methods take it.
    type Permit = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

    /// A value that a step bound with `as`.
    enum Bound {
        /// A recipe wrapper: the case database name, a namespace or a count.
        Json(Value),
        Metadata(TableMetadata),
        Page(TablePage),
        Snapshot(RowSnapshot),
    }

    /// Why a step has no result: the error of the call, whose code an expect may name, or a fault of the step or the helper,
    /// which has no code and always fails the case.
    enum Failure {
        Call(String),
        Step(String),
    }

    /// The fields of a step result that its expect compares, and the value that `as` binds instead of `value`.
    struct Output {
        fields: Value,
        bind: Option<Bound>,
    }

    impl Output {
        fn fields(fields: Value) -> Output {
            Output { fields, bind: None }
        }
    }

    /// The boxed future of a model op or of model.connect: its fields, or the error text, which begins with its code (FCV-4).
    pub type ModelFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

    /// The generated models of a database case (FCV-4). model.connect opens the connection that its step names with `as`;
    /// each model op calls the generated model that its step names, on the connection that its `connection` field names; a
    /// model.update or model.delete with `row` (and no connection) runs on the connection of its bound row.
    /// The fields that a model op receives have their values resolved: a ref is its bound value, and a per-database object
    /// is its entry for the database. A trial binary implements it over the models of its fixture.
    pub trait ModelDispatcher: Send {
        /// model.connect: opens the connection `name` on `dsn` with `pool_size` connections.
        fn connect<'a>(&'a mut self, name: &'a str, dsn: &'a str, pool_size: u32) -> ModelFuture<'a>;
        /// A model op `op` on `connection`, with the resolved fields of its step.
        fn call<'a>(&'a mut self, op: &'a str, connection: &'a str, step: &'a Value) -> ModelFuture<'a>;
        /// Closes the connections that the case opened.
        fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
        /// The connection `name` that model.connect opened, for the events and transaction ops; none by default.
        fn db(&self, _name: &str) -> Option<Db> {
            None
        }
    }

    /// The dispatcher of a recipe without model ops: each model op fails its step.
    struct NoModels;

    impl ModelDispatcher for NoModels {
        fn connect<'a>(&'a mut self, _name: &'a str, _dsn: &'a str, _pool_size: u32) -> ModelFuture<'a> {
            Box::pin(async { Err("model.connect: this recipe binds no generated models".to_owned()) })
        }

        fn call<'a>(&'a mut self, op: &'a str, _connection: &'a str, _step: &'a Value) -> ModelFuture<'a> {
            Box::pin(async move { Err(format!("OP_UNKNOWN {op}: this recipe binds no generated models")) })
        }

        fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
            Box::pin(async {})
        }
    }

    fn no_models() -> Box<dyn ModelDispatcher> {
        Box::new(NoModels)
    }

    struct Context<'a> {
        namespace: String,
        database: &'a str,
        dsn: String,
        bound: HashMap<String, Bound>,
        db: &'a Db,
        dir: &'a Path,
        models: Box<dyn ModelDispatcher>,
        /// The fixture of the recipe with its external documents, which schema.install of a connection installs.
        schemas: Option<&'a (Schema, Vec<Schema>)>,
        /// The event subscriptions and the recordings of the events ops, by the names of `as`.
        subscriptions: HashMap<String, Subscription>,
        recordings: HashMap<String, Arc<Mutex<super::statement::Recorded>>>,
    }

    /// One trial for each case of the recipe at `path`, relative to the repository root, on `database` ("mysql",
    /// "postgres" or "sqlite"), named `<entry>::<case id>`. Each case runs on a case database of its own. A recipe with
    /// model ops uses database_trials_with_models.
    pub fn database_trials(entry: &str, path: &str, database: &str) -> Vec<polyspec_orm_testcase::Trial> {
        database_trials_with_models(entry, path, database, no_models)
    }

    /// database_trials with the generated models of the trial binary: model.connect opens connections, and the model ops
    /// call the models through the dispatcher that `models` builds for each case (FCV-4).
    pub fn database_trials_with_models(entry: &str, path: &str, database: &str, models: fn() -> Box<dyn ModelDispatcher>) -> Vec<polyspec_orm_testcase::Trial> {
        assert!(DATABASES.contains(&database), "recipe {path}: unknown database {database}");
        let root = polyspec_orm_testcase::manifest_dir().join("../../..");
        let (mut recipe, ordered) = read_recipe(&root.join(path));
        // serde_json sorts the keys of an object, so the order of the seed tables comes from the document (seed_order).
        recipe["seed_order"] = json!(seed_order(member(&ordered, "seed")));
        let recipe = Arc::new(recipe);
        let Some(fixture) = recipe["fixture"].as_str() else { panic!("recipe {path}: no fixture, so it has no database") };
        // A fixture of none runs every case on an empty case database; the helper never infers it (FCV-3).
        let schema = if fixture == "none" { None } else { Some(Arc::new(fixture_schema(&root.join(fixture)))) };
        let dir = Arc::new(root.join(path).parent().map(Path::to_path_buf).unwrap_or_default());
        let Some(cases) = recipe["cases"].as_array() else { panic!("recipe {path} has no cases") };
        let ordered_cases: Vec<Value> =
            member(&ordered, "cases").and_then(|cases| cases.items()).unwrap_or_default().iter().map(|case| json!(seed_order(member(case, "seed")))).collect();
        cases
            .iter()
            .enumerate()
            .map(|(index, case)| {
                let (recipe, schema, dir, models) = (recipe.clone(), schema.clone(), dir.clone(), models);
                let mut case = case.clone();
                case["seed_order"] = ordered_cases[index].clone();
                let (path, database) = (path.to_owned(), database.to_owned());
                let id = case["id"].as_str().unwrap_or_default().to_owned();
                polyspec_orm_testcase::async_trial(format!("{entry}::{id}"), polyspec_orm_testcase::DATABASE, move || async move {
                    run_case(&path, &recipe, &case, &database, schema.as_deref(), &dir, models).await;
                })
            })
            .collect()
    }

    /// The recipe as serde values, and the same text as ordered JSON, whose objects keep the order of the document.
    fn read_recipe(path: &Path) -> (Value, polyspec_orm::ordered_json::Value) {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) => panic!("{}: {error}", path.display()),
        };
        let value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(error) => panic!("{}: {error}", path.display()),
        };
        match polyspec_orm::ordered_json::parse(&text) {
            Ok(ordered) => (value, ordered),
            Err(error) => panic!("{}: {error}", path.display()),
        }
    }

    /// The member of an ordered JSON object whose key is `name`.
    fn member<'a>(object: &'a polyspec_orm::ordered_json::Value, name: &str) -> Option<&'a polyspec_orm::ordered_json::Value> {
        object.members()?.iter().find(|(key, _)| key.string_value().is_ok_and(|bytes| bytes == name.as_bytes())).map(|(_, value)| value)
    }

    /// The table names of the `rows` of a seed object, in the order the document writes them.
    fn seed_order(seed: Option<&polyspec_orm::ordered_json::Value>) -> Vec<String> {
        let Some(rows) = seed.and_then(|seed| member(seed, "rows")).and_then(|rows| rows.members()) else { return Vec::new() };
        rows.iter().map(|(key, _)| String::from_utf8(key.string_value().unwrap_or_default()).unwrap_or_default()).collect()
    }

    /// The Schema of a dbspec-set.json through the public dbspec API (docs/spec/dbspec.md "External documents"): the
    /// owned documents parsed with the external ones of the set, and the manifest of the owned documents with the external
    /// text. Each external document is also a schema of its own, which a case installs first, as the bench set does.
    fn fixture_schema(set_path: &Path) -> (Schema, Vec<Schema>) {
        let set = match dbspec::read_set(set_path) {
            Ok(set) => set,
            Err(errors) => panic!("{}: {errors:?}", set_path.display()),
        };
        let text = |file: &dbspec::SetFile| match dbspec::read_bytes(&file.path.display().to_string(), file.bytes.clone()) {
            Ok(text) => text,
            Err(diagnostics) => panic!("{}: {diagnostics:?}", file.path.display()),
        };
        let owned: Vec<String> = set.documents.iter().map(text).collect();
        let external: Vec<String> = set.external.iter().map(text).collect();
        let manifest_of = |owners: &[String], externals: &[String]| {
            let owners: Vec<&str> = owners.iter().map(String::as_str).collect();
            let externals: Vec<&str> = externals.iter().map(String::as_str).collect();
            let mut documents = Vec::new();
            for parsed in dbspec::parse_set(&owners, &externals) {
                match parsed.document {
                    Some(document) if parsed.diagnostics.is_empty() => documents.push(document),
                    _ => panic!("{}: {:?}: {:?}", set_path.display(), parsed.name, parsed.diagnostics),
                }
            }
            let references: Vec<&dbspec::Document> = documents.iter().collect();
            match dbspec::manifest(&references) {
                Ok(manifest) => manifest,
                Err(diagnostics) => panic!("{}: {diagnostics:?}", set_path.display()),
            }
        };
        // Schema takes &'static str, so the texts are leaked: one Schema per test process, built once by database_trials
        // before the trials run.
        let leak = |text: String| -> &'static str { Box::leak(text.into_boxed_str()) };
        let manifest = manifest_of(&owned, &external);
        let manifest = Schema::with_external(leak(manifest.manifest_text), leak(manifest.external_text), leak(manifest.manifest_hash));
        let install_first = external
            .iter()
            .map(|each| {
                let shared = manifest_of(std::slice::from_ref(each), &[]);
                Schema::new(leak(shared.manifest_text), leak(shared.manifest_hash))
            })
            .collect();
        (manifest, install_first)
    }

    /// Runs one case on a case database of its own and drops the database; a failure names the recipe, the case, the
    /// index of the step and the database.
    async fn run_case(path: &str, recipe: &Value, case: &Value, database: &str, schemas: Option<&(Schema, Vec<Schema>)>, dir: &Path, models: fn() -> Box<dyn ModelDispatcher>) {
        let id = case["id"].as_str().unwrap_or_default();
        let case_database = CaseDatabase::create(database).await;
        let result = case_body(recipe, case, database, schemas, dir, &case_database, models).await;
        case_database.drop().await;
        if let Err(failure) = result {
            panic!("recipe {path}, case {id}, {failure}");
        }
    }

    async fn case_body(recipe: &Value, case: &Value, database: &str, schemas: Option<&(Schema, Vec<Schema>)>, dir: &Path, case_database: &CaseDatabase, models: fn() -> Box<dyn ModelDispatcher>) -> Result<(), String> {
        let dsn = case_database.dsn().to_owned();
        let db = Db::connect(&dsn, 1, Config::default()).await.map_err(|e| format!("database {database}: connect: {e}"))?;
        let result = case_on(&db, recipe, case, database, schemas, dir, case_database, models).await;
        db.close().await;
        result
    }

#[expect(clippy::too_many_arguments, reason = "the case inputs are the recipe, the case, the database, the schema, the directory, the connection and the models, which each step reads")]
    async fn case_on(db: &Db, recipe: &Value, case: &Value, database: &str, schemas: Option<&(Schema, Vec<Schema>)>, dir: &Path, case_database: &CaseDatabase, models: fn() -> Box<dyn ModelDispatcher>) -> Result<(), String> {
        // A case with "install": false installs its fixture by its schema.install ops (FCV-9).
        if let Some(fixture) = schemas.filter(|_| case["install"].as_bool() != Some(false)) {
            install_fixture(db, fixture).await.map_err(|e| format!("database {database}: schema install: {e}"))?;
            polyspec_orm_testcase::step("schema installed");
        }
        let mut catalog = CatalogConnection::connect(case_database.dsn()).await.map_err(|e| format!("database {database}: catalog connection: {e}"))?;
        let result = run_steps(&mut catalog, db, dir, recipe, case, database, schemas, case_database, models).await;
        catalog.close().await;
        result
    }

#[expect(clippy::too_many_arguments, reason = "the case inputs are the recipe, the case, the database, the schema, the directory, the connection and the models, which each step reads")]
    async fn run_steps(catalog: &mut CatalogConnection, db: &Db, dir: &Path, recipe: &Value, case: &Value, database: &str, schemas: Option<&(Schema, Vec<Schema>)>, case_database: &CaseDatabase, models: fn() -> Box<dyn ModelDispatcher>) -> Result<(), String> {
        let namespace = catalog.current_namespace().await.map_err(|e| format!("database {database}: current namespace: {e}"))?;
        let bound = HashMap::from([("database".to_owned(), Bound::Json(json!({ "text": case_database.name() })))]);
        let dsn = case_database.dsn().to_owned();
        let mut context = Context {
            namespace,
            database,
            dsn,
            bound,
            db,
            dir,
            models: models(),
            schemas,
            subscriptions: HashMap::new(),
            recordings: HashMap::new(),
        };
        let outcome = seed_and_steps(catalog, recipe, case, &mut context).await;
        context.models.close().await;
        outcome
    }

    /// The seed rows of the recipe and then of the case, and the steps of the case in their order.
    async fn seed_and_steps(catalog: &mut CatalogConnection, recipe: &Value, case: &Value, context: &mut Context<'_>) -> Result<(), String> {
        let database = context.database;
        for (rows, order) in [(&recipe["seed"]["rows"], &recipe["seed_order"]), (&case["seed"]["rows"], &case["seed_order"])] {
            for table in order.as_array().into_iter().flatten().filter_map(Value::as_str) {
                let Some(values) = rows.get(table) else { continue };
                let seed = |e: String| format!("seed row of {table}, database {database}: {e}");
                let reference = TableRef { namespace: context.namespace.clone(), name: table.to_owned() };
                let metadata = catalog.describe_table(&reference).await.map_err(seed)?;
                for row in values.as_array().into_iter().flatten() {
                    let (cancellation, publish, permit) = mutation_hooks();
                    catalog.insert_row(&metadata, &assignments(row, context).map_err(seed)?, cancellation, publish, permit).await.map_err(seed)?;
                }
            }
        }
        polyspec_orm_testcase::step("seed rows inserted");
        for (index, current) in case["steps"].as_array().into_iter().flatten().enumerate() {
            let op = current["op"].as_str().unwrap_or_default();
            run_step(catalog, current, context).await.map_err(|failure| format!("step {index} ({op}), database {database}: {failure}"))?;
            polyspec_orm_testcase::step(format_args!("step {index} {op}"));
        }
        Ok(())
    }

    /// The value of an op that returns without error (FCV-4).
    fn ok_value() -> Value {
        json!({ "value": { "bool": true } })
    }

    /// The name that the `as` of a step binds.
    fn bound_name(step: &Value) -> Result<String, String> {
        step["as"].as_str().map(str::to_owned).ok_or_else(|| format!("{} binds no as", step["op"]))
    }

    /// The connection that the `connection` of a step names, as the dispatcher of the case holds it.
    fn connection_db(step: &Value, context: &Context<'_>) -> Result<Db, String> {
        let name = step["connection"].as_str().ok_or_else(|| format!("{} names no connection", step["op"]))?;
        context.models.db(name).ok_or_else(|| format!("no bound connection {name}"))
    }

    /// The fixture of a recipe on `db`: its external documents first, whose tables must exist before the set installs
    /// (as the bench set does), then the set.
    async fn install_fixture(db: &Db, fixture: &(Schema, Vec<Schema>)) -> polyspec_orm::Result<()> {
        let (schema, install_first) = fixture;
        for each in install_first.iter().chain(std::iter::once(schema)) {
            db.utils().schema().install(each).await?;
        }
        Ok(())
    }

    /// An ORM error of a schema or statement op: its message starts with its code, which an expect may name.
    fn orm(error: polyspec_orm::Error) -> Failure {
        Failure::Call(error.to_string())
    }

    /// The Schema argument of a schema op (FCV-4): the documents of the set and its external documents, read from the recipe's
    /// directory and parsed through the public dbspec API; manifest_replace changes the manifest text after building and keeps
    /// its hash, so that the text no longer hashes to it.
    fn schema_argument(step: &Value, context: &Context<'_>) -> Result<Schema, String> {
        let arg = &step["schema"];
        let read = |names: &Value| -> Result<Vec<String>, String> {
            names
                .as_array()
                .into_iter()
                .flatten()
                .map(|name| {
                    let path = context.dir.join(name.as_str().unwrap_or_default());
                    std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))
                })
                .collect()
        };
        let owned = read(&arg["documents"])?;
        let external = read(&arg["external"])?;
        let owned: Vec<&str> = owned.iter().map(String::as_str).collect();
        let external: Vec<&str> = external.iter().map(String::as_str).collect();
        let set = dbspec::parse_set(&owned, &external);
        let mut documents: Vec<&dbspec::Document> = Vec::new();
        for entry in &set {
            if !entry.diagnostics.is_empty() {
                return Err(format!("schema: {:?}", entry.diagnostics));
            }
            match entry.document.as_ref() {
                Some(document) => documents.push(document),
                None => return Err("schema: a document has no parse".to_owned()),
            }
        }
        let manifest = dbspec::manifest(&documents).map_err(|d| format!("schema: {d:?}"))?;
        let mut text = manifest.manifest_text;
        if let Some(replace) = arg.get("manifest_replace") {
            text = text.replace(replace["from"].as_str().unwrap_or_default(), replace["to"].as_str().unwrap_or_default());
        }
        let leak = |t: String| -> &'static str { Box::leak(t.into_boxed_str()) };
        Ok(Schema::with_external(leak(text), leak(manifest.external_text), leak(manifest.manifest_hash)))
    }

    /// A mutation that is never cancelled, whose phases are not observed and whose commit is permitted.
    fn mutation_hooks() -> (Arc<AtomicBool>, Publish, Permit) {
        (Arc::new(AtomicBool::new(false)), Arc::new(|_| {}), Arc::new(|| Ok(())))
    }

    async fn run_step(catalog: &mut CatalogConnection, step: &Value, context: &mut Context<'_>) -> Result<(), String> {
        let expected = match step.get("expect") {
            None => None,
            Some(expect) => Some(resolve_refs(&expect[context.database], context)?),
        };
        let want_error = expected.as_ref().and_then(|e| e.get("error")).and_then(Value::as_str).map(str::to_owned);
        let dispatched =
            if step["op"].as_str().is_some_and(|op| op.starts_with("model.")) { model_call(step, context).await } else { call(catalog, step, context).await };
        let output = match dispatched {
            Ok(output) => output,
            Err(Failure::Step(message)) => return Err(message),
            Err(Failure::Call(message)) => {
                let Some(want) = want_error else { return Err(format!("unexpected error {message}")) };
                return match error_code(&message) {
                    Some(code) if code == want.as_str() => Ok(()),
                    Some(code) => Err(format!("error code {code} ({message}), want {want}")),
                    None => Err(format!("error without a code ({message}), want {want}")),
                };
            }
        };
        if let Some(name) = step["as"].as_str() {
            let value = output.bind.unwrap_or_else(|| Bound::Json(output.fields.get("value").cloned().unwrap_or(Value::Null)));
            context.bound.insert(name.to_owned(), value);
        }
        let Some(expected) = expected else { return Ok(()) };
        if let Some(want) = want_error {
            return Err(format!("expected {want}, and the op succeeded"));
        }
        let Some(keys) = expected.as_object() else { return Err(format!("the expect {expected} is not an object")) };
        let compared: serde_json::Map<String, Value> = keys.keys().map(|key| (key.clone(), output.fields.get(key).cloned().unwrap_or(Value::Null))).collect();
        let (got, want) = (normalized(&Value::Object(compared)), normalized(&expected));
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got}, want {want}"))
        }
    }

    /// Maps the op of `step` to its call of the public API and returns the fields that its expect compares.
    async fn call(catalog: &mut CatalogConnection, step: &Value, context: &mut Context<'_>) -> Result<Output, Failure> {
        let fault = Failure::Step;
        Ok(match step["op"].as_str().unwrap_or_default() {
            // schema.install (FCV-4): {schema} installs the set of the step on the case database; {connection} installs the
            // recipe fixture on that connection.
            "schema.install" => {
                match step["connection"].as_str() {
                    Some(name) => {
                        let db = context.models.db(name).ok_or_else(|| fault(format!("no bound connection {name}")))?;
                        let fixture = context.schemas.ok_or_else(|| fault("schema.install names a connection, and the recipe has no fixture".into()))?;
                        install_fixture(&db, fixture).await.map_err(orm)?;
                    }
                    None => {
                        let schema = schema_argument(step, context).map_err(fault)?;
                        context.db.utils().schema().install(&schema).await.map_err(orm)?;
                    }
                }
                Output::fields(ok_value())
            }
            "schema.register" => {
                let schema = schema_argument(step, context).map_err(fault)?;
                context.db.utils().schema().register(&schema).map_err(orm)?;
                Output::fields(ok_value())
            }
            "schema.connect" => {
                let schema = schema_argument(step, context).map_err(fault)?;
                let connected = Db::connect_schema(&context.dsn, &schema, 1, Config::default()).await.map_err(orm)?;
                connected.close().await;
                Output::fields(ok_value())
            }
            "schema.add_tables_and_columns" => {
                let schema = schema_argument(step, context).map_err(fault)?;
                let added = context.db.utils().schema().add_tables_and_columns(&schema).await.map_err(orm)?;
                let names: Vec<Value> = added.iter().map(|name| json!({ "text": name })).collect();
                Output::fields(json!({ "value": { "array": names } }))
            }
            "statements.count" => {
                let count = Arc::new(AtomicU64::new(0));
                let seen = count.clone();
                let subscription = context
                    .db
                    .subscribe(move |_event: &StatementEvent<'_>| {
                        seen.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .map_err(orm)?;
                let mut outcome = Ok(());
                for nested in step["steps"].as_array().into_iter().flatten() {
                    if let Err(message) = Box::pin(run_step(catalog, nested, context)).await {
                        outcome = Err(message);
                        break;
                    }
                }
                subscription.unsubscribe();
                outcome.map_err(fault)?;
                Output::fields(json!({ "count": count.load(Ordering::SeqCst) }))
            }
            // transaction (FCV-4): {connection?, steps, fail?}; the connection defaults to the case connection, and fail makes
            // the callback return its own error after its steps, which the expect names as CALLBACK.
            "transaction" => {
                let db = match step["connection"].as_str() {
                    Some(_) => connection_db(step, context).map_err(fault)?,
                    None => context.db.clone(),
                };
                let steps: Vec<Value> = step["steps"].as_array().cloned().unwrap_or_default();
                let fail = step["fail"].as_bool().unwrap_or(false);
                db.transaction_once(|| async move {
                    for nested in &steps {
                        Box::pin(run_step(catalog, nested, context)).await?;
                    }
                    if fail {
                        return Err(CALLBACK_FAILED.to_owned());
                    }
                    Ok::<(), String>(())
                })
                .await
                .map_err(|e| match e {
                    TransactionOnceError::Callback(message) if message == CALLBACK_FAILED => Failure::Call(format!("{CALLBACK}: {message}")),
                    TransactionOnceError::Callback(message) => Failure::Step(message),
                    TransactionOnceError::Orm(error) => orm(error),
                    TransactionOnceError::Rollback { callback, rollback } => Failure::Step(format!("{callback}; rollback: {rollback}")),
                })?;
                Output::fields(ok_value())
            }
            // The events ops (FCV-4): a subscription on a connection, its recording, and the ops that stop or read them.
            "events.subscribe" => {
                let name = bound_name(step).map_err(fault)?;
                let db = connection_db(step, context).map_err(fault)?;
                let recorded = Arc::new(Mutex::new(super::statement::Recorded::default()));
                let sink = Arc::clone(&recorded);
                let subscription = db
                    .subscribe(move |event: &StatementEvent<'_>| {
                        super::statement::record(&sink, event);
                        Ok(())
                    })
                    .map_err(orm)?;
                context.recordings.insert(name.clone(), recorded);
                context.subscriptions.insert(name, subscription);
                Output::fields(json!({}))
            }
            "events.fail_subscriber" => {
                let name = bound_name(step).map_err(fault)?;
                let db = connection_db(step, context).map_err(fault)?;
                let kind = step["kind"].as_str().ok_or_else(|| fault("events.fail_subscriber names no kind".into()))?.to_owned();
                let subscription = db
                    .subscribe(move |event: &StatementEvent<'_>| {
                        if event.kind == kind {
                            return Err("subscriber refused the event".into());
                        }
                        Ok(())
                    })
                    .map_err(orm)?;
                context.subscriptions.insert(name, subscription);
                Output::fields(json!({}))
            }
            "events.stop_failing" | "events.unsubscribe" => {
                let name = step["ref"].as_str().ok_or_else(|| fault(format!("{} names no ref", step["op"])))?;
                let subscription = context.subscriptions.remove(name).ok_or_else(|| fault(format!("{}: no subscription {name}", step["op"])))?;
                subscription.unsubscribe();
                Output::fields(json!({}))
            }
            "events.captured" => {
                let name = step["ref"].as_str().ok_or_else(|| fault("events.captured names no ref".into()))?;
                let recorded = context.recordings.get(name).cloned().ok_or_else(|| fault(format!("no recording {name}")))?;
                let events = recorded.lock().unwrap().captured(step["compare"].as_str() == Some("tables"));
                Output::fields(json!({ "value": { "array": events } }))
            }
            "catalog.current_namespace" => {
                let namespace = catalog.current_namespace().await.map_err(Failure::Call)?;
                Output::fields(json!({ "value": { "text": namespace } }))
            }
            "catalog.describe_table" => {
                let metadata = catalog.describe_table(&table(step, context).map_err(fault)?).await.map_err(Failure::Call)?;
                let columns: Vec<&str> = metadata.columns.iter().map(|c| c.name.as_str()).collect();
                let fields = json!({ "columns": columns, "primary_key": metadata.primary_key, "reliable_row_identity": metadata.reliable_row_identity });
                Output { fields, bind: Some(Bound::Metadata(metadata)) }
            }
            "catalog.table_page" => {
                let limit = step["limit"].as_u64().ok_or_else(|| fault("limit is not a count".into()))?;
                let offset = step["offset"].as_u64().ok_or_else(|| fault("offset is not a count".into()))?;
                let limit = usize::try_from(limit).map_err(|e| fault(e.to_string()))?;
                let page = catalog.table_page(&table(step, context).map_err(fault)?, limit, offset).await.map_err(Failure::Call)?;
                let mut indexes = Vec::new();
                for column in step["columns"].as_array().into_iter().flatten() {
                    let name = column.as_str().unwrap_or_default();
                    let at = page.result.columns.iter().position(|c| c.name == name).ok_or_else(|| fault(format!("the page has no column {name}")))?;
                    indexes.push(at);
                }
                let mut rows = Vec::new();
                for row in &page.result.rows {
                    let cells: Result<Vec<Value>, String> =
                        indexes.iter().map(|&at| plain_cell(&row[at], Some(&page.result.columns[at].native_type))).collect();
                    rows.push(Value::Array(cells.map_err(fault)?));
                }
                let columns: Vec<&str> = page.result.columns.iter().map(|c| c.name.as_str()).collect();
                let fields = json!({ "columns": columns, "order_by": page.order_by, "has_more": page.has_more, "rows": rows });
                Output { fields, bind: Some(Bound::Page(page)) }
            }
            "catalog.read_only_query" => {
                let sql = sql_field(&step["sql"], context).map_err(fault)?;
                let result = catalog.read_only_query(sql, &[], limits(step).map_err(fault)?).await.map_err(Failure::Call)?;
                let rows: Vec<Vec<Value>> = result.rows.iter().map(|row| row.iter().map(plain_val).collect()).collect();
                Output::fields(json!({ "rows": rows }))
            }
            "catalog.read_only_grid_query" => {
                let sql = sql_field(&step["sql"], context).map_err(fault)?;
                let result = catalog.read_only_grid_query(sql, &[], limits(step).map_err(fault)?).await.map_err(Failure::Call)?;
                let columns: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
                let rows: Result<Vec<Vec<Value>>, String> = result.rows.iter().map(|row| row.iter().map(grid_cell).collect()).collect();
                Output::fields(json!({ "columns": columns, "rows": rows.map_err(fault)? }))
            }
            "catalog.row_snapshot" => {
                let Bound::Page(page) = bound(&step["page"], context).map_err(fault)? else { return Err(fault("page is not a bound page".into())) };
                let index = step["index"].as_u64().ok_or_else(|| fault("index is not a count".into()))?;
                let index = usize::try_from(index).map_err(|e| fault(format!("index {index}: {e}")))?;
                let snapshot = RowSnapshot::from_page(page, index).map_err(Failure::Call)?;
                Output { fields: json!({}), bind: Some(Bound::Snapshot(snapshot)) }
            }
            "catalog.insert_row" => {
                let Bound::Metadata(metadata) = bound(&step["metadata"], context).map_err(fault)? else {
                    return Err(fault("metadata is not bound metadata".into()));
                };
                let values = assignments(&step["values"], context).map_err(fault)?;
                let (cancellation, publish, permit) = mutation_hooks();
                let result = catalog.insert_row(metadata, &values, cancellation, publish, permit).await.map_err(Failure::Call)?;
                Output::fields(json!({ "rows": mutation(metadata, &result).map_err(fault)? }))
            }
            "catalog.update_row" => {
                let snapshot = snapshot(&step["snapshot"], context).map_err(fault)?;
                let set = assignments(&step["set"], context).map_err(fault)?;
                let (cancellation, publish, permit) = mutation_hooks();
                let result = catalog.update_row(snapshot, &set, cancellation, publish, permit).await.map_err(Failure::Call)?;
                Output::fields(json!({ "rows": mutation(snapshot.metadata(), &result).map_err(fault)? }))
            }
            "catalog.delete_row" => {
                let snapshot = snapshot(&step["snapshot"], context).map_err(fault)?;
                let (cancellation, publish, permit) = mutation_hooks();
                let deleted = catalog.delete_row(snapshot, cancellation, publish, permit).await.map_err(Failure::Call)?;
                Output::fields(json!({ "value": { "int": deleted.to_string() } }))
            }
            "sql.exec" => {
                let sql = sql_field(&step["sql"], context).map_err(fault)?;
                native_exec(&context.dsn, sql).await.map_err(Failure::Call)?;
                Output::fields(json!({}))
            }
            // dsn.connect (FCV-4): the DSN of the case database for "case", otherwise the text of the step.
            "dsn.connect" => {
                let dsn = match step["dsn"].as_str().unwrap_or_default() {
                    "case" => context.dsn.as_str(),
                    text => text,
                };
                let db = Db::connect(dsn, 1, Config::default()).await.map_err(|e| Failure::Call(e.to_string()))?;
                let driver = db.driver();
                db.close().await;
                Output::fields(json!({ "value": { "text": driver } }))
            }
            other => return Err(fault(format!("OP_UNKNOWN {other}"))),
        })
    }

    /// A model op or model.connect (FCV-4): model.connect opens the connection named by `as`; a model op resolves its fields
    /// and calls the dispatcher, whose fields the expect of the step compares as the fields of a catalog call.
    async fn model_call(step: &Value, context: &mut Context<'_>) -> Result<Output, Failure> {
        let op = step["op"].as_str().unwrap_or_default();
        if op == "model.connect" {
            let name = step["as"].as_str().ok_or_else(|| Failure::Step("model.connect names no as".into()))?;
            let pool_size = step["pool_size"].as_u64().and_then(|n| u32::try_from(n).ok()).ok_or_else(|| Failure::Step("pool_size is not a count".into()))?;
            let dsn = context.dsn.clone();
            context.models.connect(name, &dsn, pool_size).await.map_err(Failure::Call)?;
            return Ok(Output::fields(json!({})));
        }
        // A step with `row` and no connection is routed by its bound row, which records the connection it was bound on.
        let connection = match step["connection"].as_str() {
            Some(name) => name,
            None if step.get("row").is_some() => "",
            None => return Err(Failure::Step(format!("{op} names no connection and no row"))),
        };
        let resolved = resolve_model_step(step, context).map_err(Failure::Step)?;
        let fields = context.models.call(op, connection, &resolved).await.map_err(Failure::Call)?;
        Ok(Output::fields(fields))
    }

    /// The fields of a model op with its values resolved, as a catalog op resolves its arguments.
    fn resolve_model_step(step: &Value, context: &Context<'_>) -> Result<Value, String> {
        let mut resolved = step.clone();
        for key in ["values", "where", "key", "set", "duplication"] {
            if step.get(key).is_some() {
                resolved[key] = resolve_map(&step[key], context)?;
            }
        }
        if let Some(rows) = step["rows"].as_array() {
            resolved["rows"] = Value::Array(rows.iter().map(|row| resolve_map(row, context)).collect::<Result<_, _>>()?);
        }
        if step.get("amount").is_some() {
            resolved["amount"] = database_value(argument(&step["amount"], context)?, context);
        }
        Ok(resolved)
    }

    /// An object of columns whose values are resolved; see resolve_model_step.
    fn resolve_map(object: &Value, context: &Context<'_>) -> Result<Value, String> {
        let Some(map) = object.as_object() else { return Err(format!("{object} is not an object of columns")) };
        let resolved: Map<String, Value> =
            map.iter().map(|(name, value)| Ok((name.clone(), database_value(argument(value, context)?, context)))).collect::<Result<_, String>>()?;
        Ok(Value::Object(resolved))
    }

    /// The code of a catalog error, the text before its first colon when that text is a code: `CATALOG_LIMIT: ...`.
    fn error_code(message: &str) -> Option<&str> {
        let head = message.split(':').next().unwrap_or_default();
        let mut characters = head.chars();
        let first = characters.next()?;
        (first.is_ascii_uppercase() && characters.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')).then_some(head)
    }

    fn table(step: &Value, context: &Context<'_>) -> Result<TableRef, String> {
        let name = step["table"].as_str().ok_or("table is not a name")?;
        Ok(TableRef { namespace: context.namespace.clone(), name: name.to_owned() })
    }

    fn snapshot<'a>(field: &Value, context: &'a Context<'_>) -> Result<&'a RowSnapshot, String> {
        match bound(field, context)? {
            Bound::Snapshot(snapshot) => Ok(snapshot),
            _ => Err("snapshot is not a bound snapshot".into()),
        }
    }

    /// A field that holds SQL or a database-decided value: the string itself, or the entry of the database.
    fn sql_field<'a>(field: &'a Value, context: &Context<'_>) -> Result<&'a str, String> {
        field.as_str().or_else(|| field[context.database].as_str()).ok_or_else(|| format!("{field} is no SQL for {}", context.database))
    }

    /// The limits of a read; an absent one is the default of the runtime, and a present one that is no count fails the step.
    fn limits(step: &Value) -> Result<QueryLimits, String> {
        let default = QueryLimits::default();
        let count = |key: &str, otherwise: usize| match &step[key] {
            Value::Null => Ok(otherwise),
            value => {
                let n = value.as_u64().ok_or_else(|| format!("{key} is not a count: {value}"))?;
                usize::try_from(n).map_err(|e| format!("{key} {n}: {e}"))
            }
        };
        Ok(QueryLimits { max_rows: count("max_rows", default.max_rows)?, max_bytes: count("max_bytes", default.max_bytes)? })
    }

    /// The value that `{"ref": "<name>"}` names; a ref with a path names a member of a bound recipe value.
    fn bound<'a>(field: &Value, context: &'a Context<'_>) -> Result<&'a Bound, String> {
        let reference = field["ref"].as_str().ok_or_else(|| format!("{field} is not a ref"))?;
        if reference.contains('.') {
            return Err(format!("ref {reference} names a member, and only a bound recipe value has members"));
        }
        context.bound.get(reference).ok_or_else(|| format!("no bound value {reference}"))
    }

    /// The recipe value that `{"ref": "<name>"}` or `{"ref": "<name>.<path>"}` names.
    fn bound_value(reference: &str, context: &Context<'_>) -> Result<Value, String> {
        let mut path = reference.split('.');
        let head = path.next().unwrap_or_default();
        let Some(Bound::Json(value)) = context.bound.get(head) else { return Err(format!("no bound recipe value {head}")) };
        let mut value = value;
        for key in path {
            value = value.get(key).ok_or_else(|| format!("bound value {head} has no {reference}"))?;
        }
        Ok(value.clone())
    }

    /// A step argument: the bound value of a ref, or the field itself.
    fn argument(field: &Value, context: &Context<'_>) -> Result<Value, String> {
        match field["ref"].as_str() {
            Some(reference) if field.as_object().is_some_and(|map| map.len() == 1) => bound_value(reference, context),
            _ => Ok(field.clone()),
        }
    }

    fn resolve_refs(value: &Value, context: &Context<'_>) -> Result<Value, String> {
        Ok(match value {
            Value::Array(items) => Value::Array(items.iter().map(|item| resolve_refs(item, context)).collect::<Result<_, _>>()?),
            Value::Object(map) if map.len() == 1 && map.contains_key("ref") => {
                bound_value(map["ref"].as_str().ok_or_else(|| format!("{value} is not a ref"))?, context)?
            }
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| Ok((k.clone(), resolve_refs(v, context)?))).collect::<Result<_, String>>()?),
            other => other.clone(),
        })
    }

    /// The assignments of an object of column names whose values are recipe wrappers or per-database objects.
    fn assignments(values: &Value, context: &Context<'_>) -> Result<Vec<(String, P)>, String> {
        let Some(map) = values.as_object() else { return Err(format!("{values} is not an object of columns")) };
        map.iter().map(|(name, value)| Ok((name.clone(), native(&database_value(argument(value, context)?, context))?))).collect()
    }

    fn database_value(value: Value, context: &Context<'_>) -> Value {
        match value.as_object() {
            Some(map) if ["mysql", "postgres", "sqlite"].iter().all(|key| map.contains_key(*key)) => map[context.database].clone(),
            _ => value,
        }
    }

    /// The bound value of the Rust catalog API for a recipe wrapper.
    fn native(wrapper: &Value) -> Result<P, String> {
        let (kind, body) = super::kind(wrapper)?;
        let text = || body.as_str().map(str::to_owned).ok_or_else(|| format!("{wrapper} has no text"));
        Ok(match kind {
            "int" => {
                let digits = text()?;
                match digits.parse::<i64>() {
                    Ok(n) => P::I(n),
                    Err(_) => P::Unsigned(digits.parse::<u64>().map_err(|e| format!("{wrapper}: {e}"))?),
                }
            }
            "text" => P::S(text()?),
            "date" => P::Date(text()?),
            "time" => P::Time(text()?),
            "datetime" => P::DateTime(text()?),
            "decimal" => P::Decimal(text()?),
            "bytes_hex" => P::Binary(super::hex_bytes(&text()?)?),
            "bool" => P::Boolean(body.as_bool().ok_or_else(|| format!("{wrapper} is not a bool"))?),
            "null" => P::Null(match text()?.as_str() {
                "text" => ParamType::Text,
                "i64" => ParamType::Integer,
                "u64" => ParamType::Unsigned,
                "decimal" => ParamType::Decimal,
                "bool" => ParamType::Boolean,
                "bytes" => ParamType::Binary,
                "date" => ParamType::Date,
                "time" => ParamType::Time,
                "datetime" => ParamType::DateTime,
                other => return Err(format!("the null type {other} has no parameter type")),
            }),
            other => return Err(format!("unknown recipe wrapper {other}")),
        })
    }

    /// The recipe wrapper of a plain value of read_only_query, which carries no native type.
    fn plain_val(value: &Val) -> Value {
        match value {
            Val::Null => json!({ "null": true }),
            Val::Int(n) => json!({ "int": n.to_string() }),
            Val::Text(text) => json!({ "text": text }),
            Val::Bool(b) => json!({ "bool": b }),
        }
    }

    /// The recipe wrapper of a page or mutation cell: a text cell takes the wrapper of the native type of its column when
    /// that type is temporal or decimal, and every other cell maps by its kind.
    fn plain_cell(cell: &GridCell, native_type: Option<&str>) -> Result<Value, String> {
        match cell {
            GridCell::Text(text) => Ok(json!({ temporal_kind(native_type).unwrap_or("text"): text })),
            other => grid_cell(other),
        }
    }

    fn temporal_kind(native_type: Option<&str>) -> Option<&'static str> {
        let kind = native_type.unwrap_or_default().to_lowercase();
        if kind.starts_with("datetime") || kind.starts_with("timestamp") {
            Some("datetime")
        } else if kind.starts_with("time") {
            Some("time")
        } else if kind.starts_with("date") {
            Some("date")
        } else if kind.starts_with("decimal") || kind.starts_with("numeric") {
            Some("decimal")
        } else {
            None
        }
    }

    /// The recipe wrapper of a grid cell.
    fn grid_cell(cell: &GridCell) -> Result<Value, String> {
        Ok(match cell {
            GridCell::Null => json!({ "null": true }),
            GridCell::Integer(n) => json!({ "int": n.to_string() }),
            GridCell::Unsigned(n) => json!({ "int": n.to_string() }),
            GridCell::Decimal(text) => json!({ "decimal": text }),
            GridCell::Text(text) => json!({ "text": text }),
            GridCell::Date(text) => json!({ "date": text }),
            GridCell::Time(text) => json!({ "time": text }),
            GridCell::DateTime(text) => json!({ "datetime": text }),
            GridCell::Boolean(b) => json!({ "bool": b }),
            GridCell::Binary(bytes) => json!({ "bytes_hex": hex_text(bytes) }),
            other => return Err(format!("no recipe wrapper for the grid cell {other:?}")),
        })
    }

    /// The rows of a mutation result, each cell wrapped by the native type of its column in the metadata.
    fn mutation(metadata: &TableMetadata, result: &GridQueryResult) -> Result<Vec<Vec<Value>>, String> {
        let types: Vec<Option<&str>> =
            result.columns.iter().map(|column| metadata.columns.iter().find(|c| c.name == column.name).map(|c| c.native_type.as_str())).collect();
        result.rows.iter().map(|row| row.iter().zip(&types).map(|(cell, native_type)| plain_cell(cell, *native_type)).collect()).collect()
    }

    /// NULL compares by its nullness: an expect names the parameter type of NULL, and a result has none.
    fn normalized(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(normalized).collect()),
            Value::Object(map) if map.len() == 1 && map.contains_key("null") => json!({ "null": true }),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), normalized(v))).collect()),
            other => other.clone(),
        }
    }

    /// Runs DDL or DML through the native driver on one connection of its own.
    async fn native_exec(dsn: &str, sql: &str) -> Result<(), String> {
        use sqlx::ConnectOptions as _;
        match parse_dsn(dsn).map_err(|e| e.to_string())?.options {
            ConnectOptions::MySql(options) => exec_and_close(options.connect().await.map_err(|e| e.to_string())?, sql).await,
            ConnectOptions::Postgres(options) => exec_and_close(options.connect().await.map_err(|e| e.to_string())?, sql).await,
            ConnectOptions::Sqlite(options) => exec_and_close(options.connect().await.map_err(|e| e.to_string())?, sql).await,
            ConnectOptions::Markdown(_) => Err("a markdown corpus has no native SQL driver".into()),
        }
    }

    /// Runs sql on connection and closes it; a failed close fails the run before the result of sql.
    async fn exec_and_close<C>(mut connection: C, sql: &str) -> Result<(), String>
    where
        C: sqlx::Connection,
        for<'c> &'c mut C: sqlx::Executor<'c, Database = C::Database>,
    {
        let result = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned())).execute(&mut connection).await.map_err(|e| e.to_string());
        connection.close().await.map_err(|e| e.to_string())?;
        result.map(|_| ())
    }
}
/// The statement_events recipe (docs/spec/feature-coverage.md FCV-4): each case runs on a case database of its own, and
/// each op calls the public polyspec_orm API that the op names (model.*, schema.install, transaction, events.*). The events
/// ops and the schema and transaction ops are the arms of the one `call` dispatch; the EventProbe model ops are the
/// dispatcher of each case, which opens the connections that model.connect names.
pub use statement::statement_trials;

mod statement {
    use std::collections::{BTreeMap, HashMap};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex;

    use polyspec_orm::core::{Arg, ChainKey};
    use polyspec_orm::{Config, Core, Db, Entity, Model, Param, Schema, StatementEvent, Val};
    use serde_json::{json, Value};

    use super::{database_trials_with_models, ModelDispatcher, ModelFuture};

    /// The columns of the table event_probe of the fixture.
    const COLUMNS: [&str; 2] = ["seq", "label"];
    /// The key of the label column: the only `where` that the recipe names.
    const BY_LABEL: &[ChainKey] = &[ChainKey { conn: "", op: "", column: "label", columns: &[], compare: "" }];

    static STATEMENT_SCHEMA: Schema =
        Schema::new(include_str!("../../../../contracts/fixtures/statement_events/statement_events.dbs"), "sha256:0f576f8672d1b7c7ad72fa90e88dfcbcfeb41d35efd02cc7afe3ce6765f8b207");
    static EVENT_PROBE: Entity = Entity {
        name: "event_probe",
        schema: &STATEMENT_SCHEMA,
        new: polyspec_orm::model::new_boxed::<EventProbe>,
        collect: polyspec_orm::model::collect_boxed::<EventProbe>,
    };

    /// The row of event_probe: its core and the column values that were assigned.
    #[derive(Clone)]
    pub struct EventProbe {
        core: Core,
        values: BTreeMap<String, Val>,
    }

    impl Model for EventProbe {
        fn entity() -> &'static Entity {
            &EVENT_PROBE
        }
        fn core(&self) -> &Core {
            &self.core
        }
        fn core_mut(&mut self) -> &mut Core {
            &mut self.core
        }
        fn from_core(core: Core) -> Self {
            EventProbe { core, values: BTreeMap::new() }
        }
        fn into_core(self) -> Core {
            self.core
        }
        fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
            if !COLUMNS.contains(&name) {
                return Ok(false);
            }
            self.values.insert(name.to_owned(), v);
            Ok(true)
        }
        fn value(&self, name: &str) -> Option<Val> {
            self.values.get(name).cloned()
        }
    }

    /// The events that a recording subscriber received: each with whether it names a table, and its wrapper.
    #[derive(Default)]
    pub(super) struct Recorded {
        records: Vec<(bool, Value)>,
        numbers: HashMap<u64, u64>,
    }

    impl Recorded {
        /// The recorded events; with `tables_only`, the ones that name a table.
        pub(super) fn captured(&self, tables_only: bool) -> Vec<Value> {
            self.records.iter().filter(|(named, _)| !tables_only || *named).map(|(_, e)| e.clone()).collect()
        }
    }

    /// The statement_events recipe trials of `database` (FCV-3, FCV-4).
    pub fn statement_trials(entry: &str, path: &str, database: &str) -> Vec<polyspec_orm_testcase::Trial> {
        database_trials_with_models(entry, path, database, dispatcher)
    }

    /// The dispatcher of one case: its connections and the rows bound by `as`.
    fn dispatcher() -> Box<dyn ModelDispatcher> {
        Box::new(EventProbes::default())
    }

    /// The model ops of the statement recipe over the EventProbe model (FCV-4): model.connect opens a connection with the
    /// statement schema, and each model op calls the model on the connection that its step names.
    #[derive(Default)]
    struct EventProbes {
        connections: HashMap<String, Db>,
        rows: HashMap<String, EventProbe>,
    }

    impl EventProbes {
        fn connection(&self, name: &str) -> Result<Db, String> {
            self.connections.get(name).cloned().ok_or_else(|| format!("no bound connection {name}"))
        }

        fn bound_row(&self, step: &Value) -> Result<EventProbe, String> {
            let name = step["row"].as_str().ok_or_else(|| format!("{} names no row", step["op"]))?;
            self.rows.get(name).cloned().ok_or_else(|| format!("no bound row {name}"))
        }

        async fn run(&mut self, op: &str, connection: &str, step: &Value) -> Result<Value, String> {
            // model.update and model.delete with `row` run on the connection of the bound row, not on a named one.
            if matches!(op, "model.update" | "model.delete") && step.get("row").is_some() {
                let row = self.bound_row(step)?;
                return if op == "model.update" {
                    let mut row = row;
                    set_values(&mut row, &step["set"])?;
                    polyspec_orm::model::update(&mut row, false).await.map_err(|e| e.to_string())?;
                    Ok(json!({}))
                } else {
                    polyspec_orm::model::delete(&row, false).await.map_err(|e| e.to_string())?;
                    Ok(json!({}))
                };
            }
            let db = self.connection(connection)?;
            match op {
                "model.create" => {
                    let mut row = new_row(&db);
                    set_values(&mut row, &step["values"])?;
                    polyspec_orm::model::create(&mut row).await.map_err(|e| e.to_string())?;
                    Ok(json!({}))
                }
                "model.get_by" => {
                    // The statement cases name only the where form; the key form has no case here, so it fails by name.
                    if step.get("key").is_some() {
                        return Err("model.get_by key form is not served by the statement dispatcher: the statement cases use where only".into());
                    }
                    let filter = where_filter(&db, &step["where"])?;
                    let row = polyspec_orm::model::get_core::<EventProbe>(&filter)
                        .await
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| polyspec_orm::Error::NoRows.to_string())?;
                    // A get_by without `as` only checks that the row exists; it binds nothing.
                    if let Some(name) = step["as"].as_str() {
                        self.rows.insert(name.to_owned(), row);
                    }
                    Ok(json!({}))
                }
                "model.update" | "model.delete" => Err(format!("{op} names no row: the statement cases bind updates and deletes by row")),
                "model.count" => {
                    let mut core = Core::new(&EVENT_PROBE);
                    core.connect(&db);
                    let n = polyspec_orm::model::get_count(&core).await.map_err(|e| e.to_string())?;
                    Ok(json!({ "value": { "int": n.to_string() } }))
                }
                other => Err(format!("OP_UNKNOWN {other}: the statement recipe binds no such model op")),
            }
        }
    }

    impl ModelDispatcher for EventProbes {
        fn connect<'a>(&'a mut self, name: &'a str, dsn: &'a str, pool_size: u32) -> ModelFuture<'a> {
            Box::pin(async move {
                let db = Db::connect_schema(dsn, &STATEMENT_SCHEMA, pool_size, Config::default()).await.map_err(|e| e.to_string())?;
                self.connections.insert(name.to_owned(), db);
                Ok(json!({}))
            })
        }

        fn call<'a>(&'a mut self, op: &'a str, connection: &'a str, step: &'a Value) -> ModelFuture<'a> {
            Box::pin(async move { self.run(op, connection, step).await })
        }

        fn db(&self, name: &str) -> Option<Db> {
            self.connections.get(name).cloned()
        }

        fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
            Box::pin(async move {
                for (_, db) in self.connections.drain() {
                    db.close().await;
                }
            })
        }
    }

    fn new_row(db: &Db) -> EventProbe {
        let mut core = Core::new(&EVENT_PROBE);
        core.connect(db);
        EventProbe::from_core(core)
    }

    /// The filter of a `where` object: the label column, which the recipe names alone.
    fn where_filter(db: &Db, field: &Value) -> Result<Core, String> {
        let map = field.as_object().ok_or_else(|| format!("where {field} is not an object"))?;
        let [(column, value)] = map.iter().collect::<Vec<_>>()[..] else { return Err("where names one column".into()) };
        if column != "label" {
            return Err(format!("where column {column} has no key in the recipe helper"));
        }
        let mut core = Core::new(&EVENT_PROBE);
        core.connect(db);
        Ok(core.by(BY_LABEL, vec![Arg::Value(polyspec_orm::args::Value::One(param(value)?))]))
    }

    /// Assigns each column of an object of wrappers to the row.
    fn set_values(row: &mut EventProbe, values: &Value) -> Result<(), String> {
        let map = values.as_object().ok_or_else(|| format!("{values} is not an object of columns"))?;
        for (column, value) in map {
            row.core_mut().set(column, param(value)?);
        }
        Ok(())
    }

    /// The bound value of a text, int, bool or null wrapper of the recipe.
    fn param(wrapper: &Value) -> Result<Param, String> {
        let map = wrapper.as_object().filter(|m| m.len() == 1).ok_or_else(|| format!("{wrapper} is no wrapper"))?;
        let (kind, body) = map.iter().next().expect("one key");
        Ok(match kind.as_str() {
            "text" => Param::Str(body.as_str().unwrap_or_default().to_owned()),
            "int" => Param::I64(body.as_str().unwrap_or_default().parse().map_err(|e| format!("int {body}: {e}"))?),
            "bool" => Param::Bool(body.as_bool().ok_or_else(|| format!("bool {body}"))?),
            "null" => Param::Null,
            other => return Err(format!("a {other} wrapper is not a bound value")),
        })
    }

    /// The recipe wrapper of a bind value of a statement event.
    fn bind_wrapper(p: &Param) -> Value {
        match p {
            Param::Null => json!({ "null": "text" }),
            Param::Str(text) => json!({ "text": text }),
            Param::I64(n) => json!({ "int": n.to_string() }),
            Param::Bool(b) => json!({ "bool": b }),
            other => panic!("the statement recipe has no wrapper for the bind {other:?}"),
        }
    }

    /// Records one event as the six fields of the recipe, with the transaction renumbered from 1 in order of first
    /// appearance within the case.
    pub(super) fn record(recorded: &Mutex<Recorded>, e: &StatementEvent<'_>) {
        let mut guard = recorded.lock().unwrap();
        let r = &mut *guard;
        let transaction = e.transaction.map(|n| {
            let next = r.numbers.len() as u64 + 1;
            *r.numbers.entry(n).or_insert(next)
        });
        let binds: Vec<Value> = e.binds.iter().map(bind_wrapper).collect();
        let tables: Vec<Value> = e.tables.iter().map(|t| json!({ "text": t })).collect();
        let transaction = match transaction {
            Some(n) => json!({ "int": n.to_string() }),
            None => json!({ "null": "int" }),
        };
        let error = match e.error {
            Some(error) => json!({ "text": error.code() }),
            None => json!({ "null": "text" }),
        };
        let record = json!({ "object": [
            ["sql", { "text": e.sql }],
            ["binds", { "array": binds }],
            ["kind", { "text": e.kind }],
            ["tables", { "array": tables }],
            ["transaction", transaction],
            ["error", error],
        ] });
        r.records.push((!e.tables.is_empty(), record));
    }
}
