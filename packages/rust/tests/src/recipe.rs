//! The recipe helper of Rust (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit, the
//! libtest-mimic program `<recipe>_<database>`, passes the trials of [`trials`] for the recipe and the database to the
//! runner, and each case of the recipe is the trial `<recipe>_<database>::<case id>`, whose steps call the public API of
//! `polyspec_orm` that each op names. It has no command line and no output of its own.

use std::collections::HashMap;

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

/// A bound value of a host encode or a blind index: text, bytes, an integer or SQL NULL.
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
