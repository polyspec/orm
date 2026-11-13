//! The values of the conformance runner that need no database: its command line and the form of a bound value.
use std::collections::HashSet;

use polyspec_orm::Param;
use serde_json::{json, Value};

fn time_text(t: &chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// Renders a bound value the way every runner does.
pub fn norm(v: &Value, seqs: &HashSet<i64>) -> Value {
    match v {
        Value::Number(n) => match n.as_i64() {
            Some(x) if seqs.contains(&x) => json!("$SEQ"),
            _ => v.clone(),
        },
        Value::String(s) => {
            if s.starts_with("ORM-AES2\0") {
                assert!(s.len() >= 9 + 12 + 16, "invalid AES ciphertext bind");
                json!("$AES")
            } else if s.starts_with("ORM-AES2") {
                panic!("invalid AES ciphertext bind")
            } else if s.to_ascii_lowercase().starts_with("4f524d2d41455332") {
                assert!(
                    s.to_ascii_lowercase().starts_with("4f524d2d4145533200")
                        && s.len() >= 2 * (9 + 12 + 16)
                        && s.len() % 2 == 0
                        && s.bytes().all(|b| b.is_ascii_hexdigit()),
                    "invalid hex AES ciphertext bind"
                );
                json!("$AES")
            } else {
                v.clone()
            }
        }
        _ => v.clone(),
    }
}

pub fn param_json(p: &Param) -> Result<Value, String> {
    Ok(match p {
        Param::Null => Value::Null,
        Param::Bool(b) => json!(b),
        Param::I64(x) => json!(x),
        Param::F64(x) => {
            if !x.is_finite() {
                return Err("non-finite float bind".into());
            }
            json!(x)
        }
        Param::Str(s) => json!(s),
        Param::Bytes(b) => {
            if b.starts_with(b"ORM-AES2\0") {
                if b.len() < 9 + 12 + 16 {
                    return Err("invalid AES ciphertext bind".into());
                }
                json!("$AES")
            } else {
                json!(String::from_utf8(b.clone()).map_err(|e| e.to_string())?)
            }
        }
        Param::DateTime(t) => json!(time_text(t)),
        Param::Date(d) => json!(d.to_string()),
    })
}

pub struct Args {
    pub dsn: String,
    /// The vector name to run. If empty, all vectors run.
    pub vectors: Vec<String>,
}

const USAGE: &str = "usage: conformance --dsn URI [--vector NAME]...";

impl Args {
    pub fn parse(args: &[String]) -> Result<Args, String> {
        let mut dsn = None;
        let mut vectors: Vec<String> = Vec::new();
        let mut rest = args.iter();
        while let Some(flag) = rest.next() {
            let value = rest.next().ok_or_else(|| format!("{flag} requires a value; {USAGE}"))?;
            match flag.as_str() {
                "--dsn" if dsn.is_none() => dsn = Some(value.clone()),
                "--dsn" => return Err(format!("--dsn is given twice; {USAGE}")),
                "--vector" if value.is_empty() => return Err(format!("--vector requires a nonempty name; {USAGE}")),
                "--vector" if vectors.contains(value) => return Err(format!("vector {value} is selected twice")),
                "--vector" => vectors.push(value.clone()),
                other => return Err(format!("unknown argument {other:?}; {USAGE}")),
            }
        }
        let dsn = dsn.ok_or_else(|| format!("--dsn is required; {USAGE}"))?;
        Ok(Args { dsn, vectors })
    }
}
