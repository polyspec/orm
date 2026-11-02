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
pub use database::database_trials;

mod database {
    use std::collections::{BTreeMap, HashMap};
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    use polyspec_orm::db::{parse_dsn, ConnectOptions};
    use polyspec_orm::AesKeyring;
    use polyspec_orm::args::Value as ArgValue;
    use polyspec_orm::core::{Arg, ChainKey};
    use polyspec_orm::ir::{Assign, Group, Item, Pred, Query, Request};
    use polyspec_orm::model::{create, creates, delete, gets, gets_page, get_count, restore, update};
    use polyspec_orm::{dbspec, Config, Core, Db, Entity, Error as OrmError, Model, Param, RequestParams, Schema, TransactionOnceError, Val as OrmVal};
    use polyspec_orm_build::catalog::{CatalogConnection, MutationPhase, RowSnapshot, TableMetadata, TablePage, TableRef};
    use polyspec_orm_build::tool_db::{GridCell, GridQueryResult, ParamType, QueryLimits, Val, P};
    use polyspec_orm_case_database::CaseDatabase;
    use serde_json::{json, Map, Value};

    use super::hex_text;

    /// The databases of a recipe with a fixture (FCV-3).
    const DATABASES: [&str; 3] = ["mysql", "postgres", "sqlite"];

    /// The publisher of the phases of a catalog mutation, as the catalog mutation methods take it.
    type Publish = Arc<dyn Fn(MutationPhase) + Send + Sync>;
    /// The permit of a catalog mutation, as the catalog mutation methods take it.
    type Permit = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

    /// A value that a step bound with `as`.
    enum Bound {
        /// A recipe wrapper: the case database name, a namespace or a count.
        Json(Value),
        Metadata(TableMetadata),
        /// A table page with the JSON fields that its step returns, so that a ref names its rows (`page.rows.0.0`).
        Page(TablePage, Value),
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

    struct Context<'a> {
        namespace: String,
        database: &'a str,
        dsn: String,
        bound: HashMap<String, Bound>,
        schema: &'static Schema,
        requests: Requests,
    }

    /// One trial for each case of the recipe at `path`, relative to the repository root, on `database` ("mysql",
    /// "postgres" or "sqlite"), named `<entry>::<case id>`. Each case runs on a case database of its own.
    pub fn database_trials(entry: &str, path: &str, database: &str) -> Vec<polyspec_orm_testcase::Trial> {
        assert!(DATABASES.contains(&database), "recipe {path}: unknown database {database}");
        let root = polyspec_orm_testcase::manifest_dir().join("../../..");
        let recipe = Arc::new(read_json(&root.join(path)));
        let Some(fixture) = recipe["fixture"].as_str() else { panic!("recipe {path}: no fixture, so it has no database") };
        let schema: &'static Schema = Box::leak(Box::new(fixture_schema(&root.join(fixture))));
        let Some(cases) = recipe["cases"].as_array() else { panic!("recipe {path} has no cases") };
        cases
            .iter()
            .map(|case| {
                let (recipe, case) = (recipe.clone(), case.clone());
                let (path, database) = (path.to_owned(), database.to_owned());
                let id = case["id"].as_str().unwrap_or_default().to_owned();
                polyspec_orm_testcase::async_trial(format!("{entry}::{id}"), polyspec_orm_testcase::DATABASE, move || async move {
                    run_case(&path, &recipe, &case, &database, schema).await;
                })
            })
            .collect()
    }

    fn read_json(path: &Path) -> Value {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) => panic!("{}: {error}", path.display()),
        };
        match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(error) => panic!("{}: {error}", path.display()),
        }
    }

    /// The Schema of a dbspec-set.json: the parse and the manifest of its documents through the public dbspec API.
    fn fixture_schema(set_path: &Path) -> Schema {
        let set = read_json(set_path);
        let directory = set_path.parent().unwrap_or(Path::new("."));
        let mut documents = Vec::new();
        for document in set["documents"].as_array().into_iter().flatten() {
            let path = directory.join(document.as_str().unwrap_or_default());
            let text = match dbspec::read_file(&path) {
                Ok(text) => text,
                Err(error) => panic!("{}: {error:?}", path.display()),
            };
            match dbspec::parse(&text, &BTreeMap::new()) {
                Ok(parsed) => documents.push(parsed.document),
                Err(diagnostics) => panic!("{}: {diagnostics:?}", path.display()),
            }
        }
        let references: Vec<&dbspec::Document> = documents.iter().collect();
        let manifest = match dbspec::manifest(&references) {
            Ok(manifest) => manifest,
            Err(diagnostics) => panic!("{}: {diagnostics:?}", set_path.display()),
        };
        // Schema takes &'static str, so the three texts are leaked: one Schema per test process, built once by
        // database_trials before the trials run.
        let leak = |text: String| -> &'static str { Box::leak(text.into_boxed_str()) };
        Schema::with_external(leak(manifest.manifest_text), leak(manifest.external_text), leak(manifest.manifest_hash))
    }

    /// Runs one case on a case database of its own and drops the database; a failure names the recipe, the case, the
    /// index of the step and the database.
    async fn run_case(path: &str, recipe: &Value, case: &Value, database: &str, schema: &'static Schema) {
        let id = case["id"].as_str().unwrap_or_default();
        let case_database = CaseDatabase::create(database).await;
        let result = case_body(recipe, case, database, schema, &case_database).await;
        case_database.drop().await;
        if let Err(failure) = result {
            panic!("recipe {path}, case {id}, {failure}");
        }
    }

    async fn case_body(recipe: &Value, case: &Value, database: &str, schema: &'static Schema, case_database: &CaseDatabase) -> Result<(), String> {
        let dsn = case_database.dsn().to_owned();
        let db = Db::connect(&dsn, 1, Config::default()).await.map_err(|e| format!("database {database}: connect: {e}"))?;
        let installed = db.utils().schema().install(schema).await;
        db.close().await;
        installed.map_err(|e| format!("database {database}: schema install: {e}"))?;
        polyspec_orm_testcase::step("schema installed");
        let mut catalog = CatalogConnection::connect(&dsn).await.map_err(|e| format!("database {database}: catalog connection: {e}"))?;
        let result = run_steps(&mut catalog, recipe, case, database, dsn, case_database.name(), schema).await;
        catalog.close().await;
        result
    }

    async fn run_steps(catalog: &mut CatalogConnection, recipe: &Value, case: &Value, database: &str, dsn: String, name: &str, schema: &'static Schema) -> Result<(), String> {
        let namespace = catalog.current_namespace().await.map_err(|e| format!("database {database}: current namespace: {e}"))?;
        let bound = HashMap::from([("database".to_owned(), Bound::Json(json!({ "text": name })))]);
        let mut context = Context { namespace, database, dsn, bound, schema, requests: Requests::default() };
        let result = run_context(catalog, recipe, case, &mut context).await;
        context.requests.close().await;
        result
    }

    async fn run_context(catalog: &mut CatalogConnection, recipe: &Value, case: &Value, context: &mut Context<'_>) -> Result<(), String> {
        let database = context.database;
        for rows in [&recipe["seed"]["rows"], &case["seed"]["rows"]] {
            for (table, values) in rows.as_object().into_iter().flatten() {
                let seed = |e: String| format!("seed row of {table}, database {database}: {e}");
                let reference = TableRef { namespace: context.namespace.clone(), name: table.clone() };
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
        let output = match call(catalog, step, context).await {
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
                Output { fields: fields.clone(), bind: Some(Bound::Page(page, fields)) }
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
                let Bound::Page(page, _) = bound(&step["page"], context).map_err(fault)? else { return Err(fault("page is not a bound page".into())) };
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
            op if REQUEST_OPS.contains(&op) => request_op(step, context).await?,
            other => return Err(fault(format!("OP_UNKNOWN {other}"))),
        })
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
        let mut value = match context.bound.get(head) {
            Some(Bound::Json(value) | Bound::Page(_, value)) => value,
            _ => return Err(format!("no bound recipe value {head}")),
        };
        for key in path {
            value = match value {
                Value::Array(items) => key.parse::<usize>().ok().and_then(|at| items.get(at)),
                _ => value.get(key),
            }
            .ok_or_else(|| format!("bound value {head} has no {reference}"))?;
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
                "i64" | "int" => ParamType::Integer,
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

    // ---- The request ops (docs/spec/feature-coverage.md FCV-4): the model ops, the request hook and the transaction. The Go
    // reference is packages/go/internal/recipe/requests.go; each op calls the public API of polyspec_orm.

    /// The ops that the request helper runs.
    const REQUEST_OPS: [&str; 14] = [
        "model.connect",
        "aes.status",
        "aes.rotate",
        "hook.install",
        "hook.records",
        "transaction",
        "model.create",
        "model.creates",
        "model.duplicate_create",
        "model.query",
        "model.count",
        "model.update",
        "model.delete",
        "model.restore",
    ];

    /// The kinds of the read requests (the hook kinds reads and reads+restore).
    const READS: [&str; 7] = ["one", "all", "count", "group_count", "sum", "avg", "paginate"];

    /// A request that a record action of the installed hook saw: its kind and its table (hook.records).
    type Record = (String, String);

    /// The request state of a case: the unhooked connection, the default connection with the installed hook, the named
    /// connections of model.connect, the entities of the tables and the records of the hook.
    #[derive(Default)]
    struct Requests {
        base: Option<Db>,
        hooked: Option<Db>,
        named: HashMap<String, Db>,
        entities: HashMap<String, &'static Entity>,
        records: Arc<Mutex<Vec<Record>>>,
        in_tx: bool,
    }

    impl Requests {
        fn default_db(&self) -> Result<&Db, Failure> {
            self.hooked.as_ref().or(self.base.as_ref()).ok_or_else(|| Failure::Step("the default connection is not open".into()))
        }

        fn connection(&self, on: &str) -> Result<&Db, Failure> {
            if on.is_empty() {
                return self.default_db();
            }
            self.named.get(on).ok_or_else(|| Failure::Step(format!("connection {on} is not connected by a model.connect step")))
        }

        async fn close(&self) {
            for db in self.named.values() {
                db.close().await;
            }
            if let Some(base) = &self.base {
                base.close().await;
            }
        }
    }

    /// The row of a recipe model. One type serves every table: the entity of its core names the table.
    #[derive(Clone)]
    struct RecipeRow {
        core: Core,
        values: BTreeMap<String, OrmVal>,
    }

    impl Model for RecipeRow {
        fn entity() -> &'static Entity {
            unreachable!("a recipe row has one entity per table, which its core names")
        }
        fn core(&self) -> &Core {
            &self.core
        }
        fn core_mut(&mut self) -> &mut Core {
            &mut self.core
        }
        fn from_core(core: Core) -> Self {
            RecipeRow { core, values: BTreeMap::new() }
        }
        fn into_core(self) -> Core {
            self.core
        }
        fn assign(&mut self, name: &str, value: OrmVal) -> polyspec_orm::Result<bool> {
            self.values.insert(name.to_owned(), value);
            Ok(true)
        }
        fn value(&self, name: &str) -> Option<OrmVal> {
            self.values.get(name).cloned()
        }
    }

    /// A failure of the orm call, named by its code: the message starts with the code, as the error check reads it.
    fn orm(error: OrmError) -> Failure {
        Failure::Call(format!("{}: {error}", error.code()))
    }

    /// A string that lives as long as the process, for the names that polyspec_orm takes as 'static.
    fn leaked(text: &str) -> &'static str {
        Box::leak(text.to_owned().into_boxed_str())
    }

    /// The entity of table name, leaked once per process and cached per case.
    fn entity_of(requests: &mut Requests, schema: &'static Schema, name: &str) -> &'static Entity {
        if let Some(&entity) = requests.entities.get(name) {
            return entity;
        }
        let entity: &'static Entity = Box::leak(Box::new(Entity {
            name: leaked(name),
            schema,
            new: polyspec_orm::model::new_boxed::<RecipeRow>,
            collect: polyspec_orm::model::collect_boxed::<RecipeRow>,
        }));
        requests.entities.insert(name.to_owned(), entity);
        entity
    }

    /// The core of a model of table name, connected to the connection of on unless the model runs in the transaction.
    fn model_core(requests: &mut Requests, schema: &'static Schema, name: &str, on: &str) -> Result<Core, Failure> {
        let entity = entity_of(requests, schema, name);
        let mut core = Core::new(entity);
        if !requests.in_tx {
            core.connect(requests.connection(on)?);
        }
        Ok(core)
    }

    /// A model of core with the values set.
    fn row_with(core: Core, values: &[(String, Param)]) -> RecipeRow {
        let mut row = RecipeRow::from_core(core);
        for (column, value) in values {
            row.core_mut().set(column, value.clone());
        }
        row
    }

    /// The equalities of a where object, ANDed.
    fn equal_where(core: &mut Core, pairs: &[(String, ArgValue)]) {
        for (i, (column, value)) in pairs.iter().enumerate() {
            let key = ChainKey { column: leaked(column), ..ChainKey::EMPTY };
            core.chain(if i == 0 { "" } else { "and" }, &[key], vec![Arg::Value(value.clone())]);
        }
    }

    /// The recipe value of a column: the wrapper of its kind, as the step's values are written.
    fn request_param(wrapper: &Value) -> Result<Param, Failure> {
        let (kind, body) = super::kind(wrapper).map_err(Failure::Step)?;
        Ok(match kind {
            "text" => Param::Str(body.as_str().ok_or_else(|| Failure::Step(format!("{wrapper} has no text")))?.to_owned()),
            "int" => Param::I64(
                body.as_str().and_then(|digits| digits.parse().ok()).ok_or_else(|| Failure::Step(format!("{wrapper} is no integer")))?,
            ),
            "bool" => Param::Bool(body.as_bool().ok_or_else(|| Failure::Step(format!("{wrapper} is not a bool")))?),
            "null" => Param::Null,
            other => return Err(Failure::Step(format!("a request op has no parameter of the wrapper {other}"))),
        })
    }

    /// The column values of an object, sorted by column name.
    fn pairs(raw: &Value) -> Result<Vec<(String, Param)>, Failure> {
        let Some(map) = raw.as_object() else { return Ok(Vec::new()) };
        let mut out = map
            .iter()
            .map(|(column, wrapper)| -> Result<(String, Param), Failure> { Ok((column.clone(), request_param(wrapper)?)) })
            .collect::<Result<Vec<_>, Failure>>()?;
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// The where values of an object, sorted by column name: one parameter, or a list for an array or a sequence (FCV-4).
    fn where_pairs(raw: &Value) -> Result<Vec<(String, ArgValue)>, Failure> {
        let Some(map) = raw.as_object() else { return Ok(Vec::new()) };
        let mut out = map
            .iter()
            .map(|(column, wrapper)| -> Result<(String, ArgValue), Failure> {
                let value = if wrapper.get("array").is_some() || wrapper.get("sequence").is_some() {
                    ArgValue::List(list_params(wrapper)?)
                } else {
                    ArgValue::One(request_param(wrapper)?)
                };
                Ok((column.clone(), value))
            })
            .collect::<Result<Vec<_>, Failure>>()?;
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// The parameters of an array or a sequence wrapper; an array item that is a sequence adds its integers in place (FCV-4).
    fn list_params(wrapper: &Value) -> Result<Vec<Param>, Failure> {
        if let Some(sequence) = wrapper.get("sequence") {
            return sequence_params(sequence);
        }
        let items = wrapper["array"].as_array().ok_or_else(|| Failure::Step(format!("{wrapper} is no array")))?;
        let mut out = Vec::new();
        for item in items {
            match item.get("sequence") {
                Some(sequence) => out.extend(sequence_params(sequence)?),
                None => out.push(request_param(item)?),
            }
        }
        Ok(out)
    }

    /// The integers from, from + 1, ... of a {"sequence": {"from", "count"}} wrapper (FCV-4).
    fn sequence_params(sequence: &Value) -> Result<Vec<Param>, Failure> {
        let from = sequence["from"].as_i64().ok_or_else(|| Failure::Step(format!("{sequence} has no from")))?;
        let count = sequence["count"].as_i64().ok_or_else(|| Failure::Step(format!("{sequence} has no count")))?;
        Ok((0..count).map(|i| Param::I64(from + i)).collect())
    }

    /// The names of a JSON array of strings.
    fn names(raw: &Value) -> Vec<String> {
        raw.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
    }

    /// The recipe wrapper of a column value that a read returns.
    fn cell_of(row: &RecipeRow, column: &str) -> Result<Value, Failure> {
        let value = row.value(column).ok_or_else(|| Failure::Step(format!("the row has no column {column}")))?;
        Ok(match value {
            OrmVal::Str(text) => json!({ "text": text }),
            OrmVal::I64(n) => json!({ "int": n.to_string() }),
            OrmVal::Bool(b) => json!({ "bool": b }),
            OrmVal::Null => json!({ "null": true }),
            _ => return Err(Failure::Step(format!("the value of {column} has no recipe wrapper in a request op"))),
        })
    }

    /// The cells of the columns of a row.
    fn project(row: &RecipeRow, columns: &[String]) -> Result<Vec<Value>, Failure> {
        columns.iter().map(|column| cell_of(row, column)).collect()
    }

    /// A relation of a model.query (FCV-4): the child model, its match pairs, whether it is many, and its columns.
    struct RelationSpec {
        model: String,
        matches: Vec<(String, String)>,
        many: bool,
        columns: Vec<String>,
    }

    fn relation_spec(raw: &Value) -> Result<RelationSpec, Failure> {
        let model = raw["model"].as_str().ok_or_else(|| Failure::Step("relation model is not a name".into()))?.to_owned();
        let mut matches = Vec::new();
        for pair in raw["match"].as_array().into_iter().flatten() {
            match (pair[0].as_str(), pair[1].as_str()) {
                (Some(left), Some(right)) => matches.push((left.to_owned(), right.to_owned())),
                _ => return Err(Failure::Step(format!("relation match {pair} is not a pair of names"))),
            }
        }
        Ok(RelationSpec { model, matches, many: raw["many"].as_bool().unwrap_or(false), columns: names(&raw["columns"]) })
    }

    /// The child rows that a relation read attached to a parent: each child of a many relation, or the one child.
    fn related<'a>(parent: &'a RecipeRow, relation: &RelationSpec) -> Result<Vec<&'a RecipeRow>, Failure> {
        if relation.many {
            let children = parent.core().related_many::<RecipeRow>(&format!("{}_models", relation.model)).map_err(orm)?;
            let children = children.ok_or_else(|| Failure::Step(format!("the children of {} were not loaded", relation.model)))?;
            Ok(children.models().collect())
        } else {
            let child = parent.core().related_one::<RecipeRow>(&format!("{}_model", relation.model)).map_err(orm)?;
            Ok(child.into_iter().collect())
        }
    }

    /// The rows of a where object that a write or a read selects, loaded with their state.
    async fn loaded(context: &mut Context<'_>, step: &Value) -> Result<Vec<RecipeRow>, Failure> {
        let name = model_name(step)?;
        let where_pairs = where_pairs(&step["where"])?;
        let core = model_core(&mut context.requests, context.schema, name, step_connection(step))?;
        let mut row = RecipeRow::from_core(core);
        equal_where(row.core_mut(), &where_pairs);
        let found = gets(&row).await.map_err(orm)?;
        Ok(found.models().cloned().collect())
    }

    fn model_name(step: &Value) -> Result<&str, Failure> {
        step["model"].as_str().ok_or_else(|| Failure::Step("model is not a name".into()))
    }

    fn step_connection(step: &Value) -> &str {
        step["connection"].as_str().unwrap_or_default()
    }

    /// The default connection, with a base connection opened on the first request op of the case.
    async fn ensure_base(context: &mut Context<'_>) -> Result<(), Failure> {
        if context.requests.base.is_none() {
            let db = Db::connect_schema(&context.dsn, context.schema, 2, Config::default()).await.map_err(orm)?;
            context.requests.base = Some(db);
        }
        Ok(())
    }

    /// One hook action of hook.install, with its values converted once.
    #[derive(Clone)]
    struct HookAction {
        action: String,
        kinds: Value,
        column: String,
        value: Option<Param>,
        nested: bool,
        code: String,
    }

    fn hook_actions(raw: &Value) -> Result<Vec<HookAction>, Failure> {
        let mut out = Vec::new();
        for hook in raw.as_array().into_iter().flatten() {
            let action = hook["action"].as_str().unwrap_or_default().to_owned();
            let value = match &hook["value"] {
                Value::Null => None,
                wrapper => Some(request_param(wrapper)?),
            };
            if matches!(action.as_str(), "scope" | "assign") && (value.is_none() || hook["column"].as_str().is_none()) {
                return Err(Failure::Step(format!("hook action {action} needs a column and a value")));
            }
            out.push(HookAction {
                action,
                kinds: hook["kinds"].clone(),
                column: hook["column"].as_str().unwrap_or_default().to_owned(),
                value,
                nested: hook["nested"].as_bool().unwrap_or(false),
                code: hook["error"].as_str().unwrap_or_default().to_owned(),
            });
        }
        Ok(out)
    }

    /// Whether a hook action's kinds (a name, a list of kinds, or one of the names reads, reads+restore and every) hold kind.
    fn kind_matches(kinds: &Value, kind: &str) -> bool {
        match kinds {
            Value::String(name) => match name.as_str() {
                "every" => true,
                "reads" => READS.contains(&kind),
                "reads+restore" => READS.contains(&kind) || kind == "restore",
                _ => false,
            },
            Value::Array(items) => items.iter().any(|item| item.as_str() == Some(kind)),
            _ => false,
        }
    }

    /// AND-s a predicate into the root where of a query.
    fn and_where(query: &mut Query, mut pred: Pred) {
        match query.where_.take() {
            None => query.where_ = Some(Group { items: vec![Item::Pred { pred: Box::new(pred) }], ..Default::default() }),
            Some(existing) => {
                pred.conn = "and".into();
                query.where_ = Some(Group { items: vec![Item::Group { group: existing }, Item::Pred { pred: Box::new(pred) }], ..Default::default() });
            }
        }
    }

    fn equal_pred(column: &str, p: usize) -> Pred {
        Pred { column: column.into(), op: "eq".into(), p: Some(p), ..Default::default() }
    }

    /// Scopes the where of a query and of each of its relation queries, nested ones included.
    fn scope_tree(query: &mut Query, column: &str, value: &Param, params: &mut RequestParams) {
        let p = params.add(value.clone());
        and_where(query, equal_pred(column, p));
        for relation in &mut query.relations {
            scope_tree(&mut relation.query, column, value, params);
        }
    }

    /// Runs the actions of the installed hook on one request, in order.
    fn run_hook(actions: &[HookAction], records: &Mutex<Vec<Record>>, request: &mut Request, params: &mut RequestParams) -> polyspec_orm::Result<()> {
        for action in actions {
            if !kind_matches(&action.kinds, &request.kind) {
                continue;
            }
            match action.action.as_str() {
                "scope" => {
                    let value = action.value.clone().unwrap_or(Param::Null);
                    if action.nested {
                        scope_tree(&mut request.query, &action.column, &value, params);
                    } else {
                        let p = params.add(value);
                        and_where(&mut request.query, equal_pred(&action.column, p));
                    }
                }
                "assign" => {
                    let value = action.value.clone().unwrap_or(Param::Null);
                    let p = params.add(value.clone());
                    request.set.push(Assign { column: action.column.clone(), p: Some(p), ..Default::default() });
                    for row in &mut request.rows {
                        let q = params.add(value.clone());
                        row.push(q);
                    }
                }
                "record" => records.lock().expect("the records").push((request.kind.clone(), request.query.entity.clone())),
                "fail" => return Err(OrmError::Engine { code: action.code.clone(), msg: format!("request hook refused {}", request.kind) }),
                _ => {}
            }
        }
        Ok(())
    }

    /// Runs a request op of FCV-4 and returns its outcome, or its failure.
    async fn request_op(step: &Value, context: &mut Context<'_>) -> Result<Output, Failure> {
        ensure_base(context).await?;
        if step["op"].as_str() == Some("transaction") {
            return transaction(step, context).await;
        }
        plain_op(step, context).await
    }

    /// The steps of a transaction run on the default connection; a model in it has no connection of its own, so it uses the
    /// transaction. A failed step keeps its own failure.
    async fn transaction(step: &Value, context: &mut Context<'_>) -> Result<Output, Failure> {
        let steps: Vec<Value> = step["steps"].as_array().cloned().unwrap_or_default();
        let db = context.requests.default_db()?.clone();
        let mut failure: Option<Failure> = None;
        let slot = &mut failure;
        let inner: &mut Context<'_> = &mut *context;
        let result = db
            .transaction_once(move || async move {
                inner.requests.in_tx = true;
                for sub in &steps {
                    if let Err(error) = plain_op(sub, inner).await {
                        *slot = Some(error);
                        return Err(OrmError::Engine { code: "STEP".into(), msg: "a transaction step failed".into() });
                    }
                }
                Ok(())
            })
            .await;
        context.requests.in_tx = false;
        match (result, failure) {
            (Ok(()), _) => Ok(Output::fields(json!({}))),
            (Err(_), Some(failure)) => Err(failure),
            (Err(TransactionOnceError::Orm(error)), None) => Err(orm(error)),
            (Err(other), None) => Err(Failure::Call(other.to_string())),
        }
    }

    /// The keyring of a recipe step (scripts/features/schema/recipe.schema.json, $defs/aesKeyring): the key text of each
    /// declared version, and the current version. The keys are returned as the public API takes them.
    fn keyring_spec(raw: &Value) -> Result<(BTreeMap<i32, String>, i32), Failure> {
        let keys = raw["keys"].as_object().ok_or_else(|| Failure::Step("a keyring has no keys".into()))?;
        let mut map = BTreeMap::new();
        for (text, key) in keys {
            let version: i32 = text.parse().map_err(|e: std::num::ParseIntError| Failure::Step(format!("aes key version {text}: {e}")))?;
            map.insert(version, key.as_str().unwrap_or_default().to_owned());
        }
        let current = raw["current"].as_i64().and_then(|n| i32::try_from(n).ok()).ok_or_else(|| Failure::Step("a keyring has no current version".into()))?;
        Ok((map, current))
    }

    /// The public keyring of a recipe step, which validates it as the API does.
    fn keyring_of(raw: &Value) -> Result<AesKeyring, Failure> {
        let (keys, current) = keyring_spec(raw)?;
        AesKeyring::new(keys, current).map_err(orm)
    }

    /// The model ops, the connect, the hook and the records (not the transaction, which runs them).
    async fn plain_op(step: &Value, context: &mut Context<'_>) -> Result<Output, Failure> {
        let schema = context.schema;
        let op = step["op"].as_str().unwrap_or_default();
        match op {
            "model.connect" => {
                let alias = step["as"].as_str().filter(|alias| !alias.is_empty());
                let alias = alias.ok_or_else(|| Failure::Step("model.connect of a second connection needs as".into()))?;
                if step.get("pool_size").is_some() {
                    return Err(Failure::Step("model.connect of a second connection takes no pool_size".into()));
                }
                let cfg = match &step["aes_keyring"] {
                    Value::Null => Config::default(),
                    raw => {
                        let (keys, current) = keyring_spec(raw)?;
                        Config { aes_version: current, aes_keys: keys, ..Config::default() }
                    }
                };
                let db = Db::connect_schema(&context.dsn, schema, 2, cfg).await.map_err(orm)?;
                context.requests.named.insert(alias.to_owned(), db);
                Ok(Output::fields(json!({})))
            }
            "aes.status" => {
                let keyring = keyring_of(&step["keyring"])?;
                let on = step_connection(step);
                let core = model_core(&mut context.requests, schema, model_name(step)?, on)?;
                let db = context.requests.connection(on)?;
                let row = RecipeRow::from_core(core);
                let status = db.utils().aes().status(&row, &keyring).await.map_err(orm)?;
                let versions: Vec<Value> = status.versions.iter().map(|(version, n)| json!([version.to_string(), { "int": n.to_string() }])).collect();
                let value = json!({ "object": [
                    ["current", { "int": status.current.to_string() }],
                    ["total", { "int": status.total.to_string() }],
                    ["pending", { "int": status.pending.to_string() }],
                    ["versions", { "object": versions }],
                ] });
                Ok(Output::fields(json!({ "value": value })))
            }
            "aes.rotate" => {
                let keyring = keyring_of(&step["keyring"])?;
                let on = step_connection(step);
                let core = model_core(&mut context.requests, schema, model_name(step)?, on)?;
                let db = context.requests.connection(on)?;
                let row = RecipeRow::from_core(core);
                let n = db.utils().aes().rotate(&row, &keyring).await.map_err(orm)?;
                Ok(Output::fields(json!({ "value": { "int": n.to_string() } })))
            }
            "hook.install" => {
                let actions = hook_actions(&step["hooks"])?;
                let base = context.requests.base.as_ref().ok_or_else(|| Failure::Step("the base connection is not open".into()))?;
                let records = context.requests.records.clone();
                records.lock().expect("the records").clear();
                context.requests.hooked = Some(base.with_request_hook(move |request: &mut Request, params: &mut RequestParams| {
                    run_hook(&actions, &records, request, params)
                }));
                Ok(Output::fields(json!({})))
            }
            "hook.records" => {
                let records = context.requests.records.lock().expect("the records").clone();
                let mut counts = Map::new();
                let mut list = Vec::new();
                for (kind, entity) in &records {
                    list.push(json!({ "object": [["kind", { "text": kind }], ["entity", { "text": entity }]] }));
                    let n = counts.get(entity).and_then(Value::as_u64).unwrap_or(0) + 1;
                    counts.insert(entity.clone(), json!(n));
                }
                Ok(Output::fields(json!({ "value": { "array": list }, "counts": counts })))
            }
            "model.create" => {
                let values = pairs(&step["values"])?;
                let core = model_core(&mut context.requests, schema, model_name(step)?, step_connection(step))?;
                let mut row = row_with(core, &values);
                create(&mut row).await.map_err(orm)?;
                Ok(Output::fields(json!({})))
            }
            "model.creates" => {
                let name = model_name(step)?;
                let on = step_connection(step);
                let mut all_core = Core::new(entity_of(&mut context.requests, schema, name));
                all_core.connect(context.requests.connection(on)?);
                let all = RecipeRow::from_core(all_core);
                let mut rows = Vec::new();
                for raw in step["rows"].as_array().into_iter().flatten() {
                    let values = pairs(raw)?;
                    let core = model_core(&mut context.requests, schema, name, on)?;
                    rows.push(row_with(core, &values));
                }
                let batch = usize::try_from(step["batch"].as_u64().unwrap_or(0)).map_err(|e| Failure::Step(e.to_string()))?;
                let n = creates(&all, rows, batch).await.map_err(orm)?;
                Ok(Output::fields(json!({ "value": { "int": n.to_string() } })))
            }
            "model.duplicate_create" => {
                let name = model_name(step)?;
                let values = pairs(&step["values"])?;
                let duplicate = pairs(&step["duplicate"])?;
                let core = model_core(&mut context.requests, schema, name, step_connection(step))?;
                let other = model_core(&mut context.requests, schema, name, "")?;
                let mut row = row_with(core, &values);
                row.core_mut().duplication(row_with(other, &duplicate).into_core());
                create(&mut row).await.map_err(orm)?;
                Ok(Output::fields(json!({})))
            }
            "model.query" => query(step, context).await,
            "model.count" => {
                let where_pairs = where_pairs(&step["where"])?;
                let core = model_core(&mut context.requests, schema, model_name(step)?, step_connection(step))?;
                let mut row = RecipeRow::from_core(core);
                equal_where(row.core_mut(), &where_pairs);
                let n = get_count(row.core()).await.map_err(orm)?;
                Ok(Output::fields(json!({ "value": { "int": n.to_string() } })))
            }
            "model.update" => {
                let set = pairs(&step["set"])?;
                for mut row in loaded(context, step).await? {
                    for (column, value) in &set {
                        row.core_mut().set(column, value.clone());
                    }
                    update(&mut row, false).await.map_err(orm)?;
                }
                Ok(Output::fields(json!({})))
            }
            "model.delete" => {
                for row in loaded(context, step).await? {
                    delete(&row, false).await.map_err(orm)?;
                }
                Ok(Output::fields(json!({})))
            }
            "model.restore" => {
                let values = pairs(&step["values"])?;
                let core = model_core(&mut context.requests, schema, model_name(step)?, step_connection(step))?;
                let row = row_with(core, &values);
                restore(&row).await.map_err(orm)?;
                Ok(Output::fields(json!({})))
            }
            other => Err(Failure::Step(format!("OP_UNKNOWN {other}"))),
        }
    }

    /// A model.query: the rows of the model, and with a relation the parent and child columns of each pair.
    async fn query(step: &Value, context: &mut Context<'_>) -> Result<Output, Failure> {
        let schema = context.schema;
        let on = step_connection(step);
        let where_pairs = where_pairs(&step["where"])?;
        let mut core = model_core(&mut context.requests, schema, model_name(step)?, on)?;
        equal_where(&mut core, &where_pairs);
        for column in names(&step["order"]) {
            core.order_by(&column, false, None);
        }
        let relation = match &step["relation"] {
            Value::Null => None,
            raw => Some(relation_spec(raw)?),
        };
        let mut root = RecipeRow::from_core(core);
        if let Some(spec) = &relation {
            let mut child = model_core(&mut context.requests, schema, &spec.model, on)?;
            for (left, right) in &spec.matches {
                child.add_match(leaked(left), leaked(right));
            }
            root.core_mut().relation(spec.many, child);
        }
        let limit = usize::try_from(step["limit"].as_u64().unwrap_or(0)).map_err(|e| Failure::Step(e.to_string()))?;
        let offset = usize::try_from(step["offset"].as_u64().unwrap_or(0)).map_err(|e| Failure::Step(e.to_string()))?;
        let paged = step["page"].as_bool() == Some(true);
        let (parents, total) = if paged {
            if limit == 0 {
                return Err(Failure::Step("a paged model.query needs limit above 0".into()));
            }
            let page = u32::try_from(offset / limit + 1).map_err(|e| Failure::Step(e.to_string()))?;
            let per_page = u32::try_from(limit).map_err(|e| Failure::Step(e.to_string()))?;
            let found = gets_page(&root, page, per_page).await.map_err(orm)?;
            (found.items.models().cloned().collect::<Vec<_>>(), Some(found.total_count))
        } else {
            // limit is the public limit of the statement (FCV-4), so a limit on a split IN list fails with IR_INVALID.
            if limit > 0 {
                root.core_mut().limit(u32::try_from(offset).map_err(|e| Failure::Step(e.to_string()))?, u32::try_from(limit).map_err(|e| Failure::Step(e.to_string()))?);
            }
            let found = gets(&root).await.map_err(orm)?;
            (found.models().cloned().collect::<Vec<RecipeRow>>(), None)
        };
        let columns = names(&step["columns"]);
        let mut rows = Vec::new();
        for parent in &parents {
            let own = project(parent, &columns)?;
            match &relation {
                None => rows.push(Value::Array(own)),
                Some(spec) => {
                    for child in related(parent, spec)? {
                        let mut row = own.clone();
                        row.extend(project(child, &spec.columns)?);
                        rows.push(Value::Array(row));
                    }
                }
            }
        }
        let mut fields = json!({ "rows": rows });
        if let Some(total) = total {
            fields["total"] = json!(total);
        }
        Ok(Output::fields(fields))
    }
}
