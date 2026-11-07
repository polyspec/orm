//! The array form of a model as the plain JSON that the test programs compare.

use polyspec_orm::{codes, ArrayValue, Error, Result};
use serde_json::{Map, Value};

/// The plain JSON of an array value: bytes are their `bytes_hex` wrapper (FCV-4), an ordered-json value is its document,
/// and a non-finite float, which JSON cannot hold, is CODEC_ENCODE.
pub trait Plain {
    fn plain(&self) -> Result<Value>;
}

impl Plain for ArrayValue {
    fn plain(&self) -> Result<Value> {
        let encode = |msg: String| Error::Engine { code: codes::CODEC_ENCODE.into(), msg };
        Ok(match self {
            ArrayValue::Null => Value::Null,
            ArrayValue::Bool(b) => Value::Bool(*b),
            ArrayValue::Int(i) => Value::from(*i),
            ArrayValue::Float(f) => serde_json::Number::from_f64(*f).map(Value::Number).ok_or_else(|| encode(format!("the float {f} has no JSON form")))?,
            ArrayValue::Text(s) => Value::String(s.clone()),
            ArrayValue::Bytes(b) => serde_json::json!({ "bytes_hex": b.iter().map(|byte| format!("{byte:02x}")).collect::<String>() }),
            ArrayValue::Json(v) => v.clone(),
            ArrayValue::Ordered(v) => serde_json::from_str(&v.compact()).map_err(|e| encode(format!("the document has no serde_json form: {e}")))?,
            ArrayValue::Map(values) => Value::Object(values.iter().map(|(k, v)| Ok((k.clone(), v.plain()?))).collect::<Result<Map<_, _>>>()?),
            ArrayValue::List(items) => Value::Array(items.iter().map(Plain::plain).collect::<Result<_>>()?),
        })
    }
}
