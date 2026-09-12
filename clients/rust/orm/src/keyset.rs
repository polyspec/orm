use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::ir::Order;
use crate::value::{Param, Val};
use crate::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeysetCursor {
    pub version: u32,
    pub order: Vec<Order>,
    pub values: Vec<EncodedValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum EncodedValue {
    #[serde(rename = "bool")]
    Bool(bool),
    #[serde(rename = "i64")]
    I64(String),
    #[serde(rename = "f64")]
    F64(f64),
    #[serde(rename = "string")]
    String(String),
    #[serde(rename = "datetime")]
    DateTime(String),
    #[serde(rename = "date")]
    Date(String),
}

pub const VERSION: u32 = 1;

pub fn encode(order: &[Order], values: &[Val]) -> Result<String> {
    if order.is_empty() || order.len() != values.len() {
        return invalid(format!(
            "cursor has {} values for {} order columns",
            values.len(),
            order.len()
        ));
    }
    let values = values
        .iter()
        .map(encode_value)
        .collect::<Result<Vec<_>>>()?;
    let body = serde_json::to_vec(&KeysetCursor {
        version: VERSION,
        order: order.to_vec(),
        values,
    })
    .map_err(|e| invalid_error(e.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(body))
}

pub fn decode(input: &str) -> Result<(Vec<Order>, Vec<Param>)> {
    let bytes = URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|_| invalid_error("cursor is not valid base64url"))?;
    let cursor: KeysetCursor =
        serde_json::from_slice(&bytes).map_err(|_| invalid_error("cursor JSON is invalid"))?;
    if cursor.version != VERSION
        || cursor.order.is_empty()
        || cursor.order.len() != cursor.values.len()
    {
        return invalid("cursor version, order, or values are invalid");
    }
    let values = cursor
        .values
        .into_iter()
        .map(decode_value)
        .collect::<Result<Vec<_>>>()?;
    Ok((cursor.order, values))
}

fn encode_value(value: &Val) -> Result<EncodedValue> {
    Ok(match value {
        Val::Bool(v) => EncodedValue::Bool(*v),
        Val::I64(v) => EncodedValue::I64(v.to_string()),
        Val::F64(v) if v.is_finite() => EncodedValue::F64(*v),
        Val::Str(v) => EncodedValue::String(v.clone()),
        Val::DateTime(v) => EncodedValue::DateTime(v.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
        Val::Date(v) => EncodedValue::Date(v.to_string()),
        _ => return invalid("null, bytes, JSON, or non-finite order values are not supported"),
    })
}

fn decode_value(value: EncodedValue) -> Result<Param> {
    Ok(match value {
        EncodedValue::Bool(v) => Param::Bool(v),
        EncodedValue::I64(v) => Param::I64(
            v.parse()
                .map_err(|_| invalid_error("i64 cursor value is invalid"))?,
        ),
        EncodedValue::F64(v) if v.is_finite() => Param::F64(v),
        EncodedValue::String(v) => Param::Str(v),
        EncodedValue::DateTime(v) => Param::DateTime(parse_datetime(&v)?),
        EncodedValue::Date(v) => Param::Date(
            v.parse()
                .map_err(|_| invalid_error("date cursor value is invalid"))?,
        ),
        _ => return invalid("cursor value is invalid"),
    })
}

fn parse_datetime(value: &str) -> Result<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .map_err(|_| invalid_error("datetime cursor value is invalid"))
}

fn invalid_error(message: impl Into<String>) -> Error {
    Error::Engine {
        code: crate::codes::CURSOR_INVALID.into(),
        msg: message.into(),
    }
}

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(invalid_error(message))
}

pub fn same_order(a: &[Order], b: &[Order]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.column == y.column && x.expr == y.expr && x.desc == y.desc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Val;
    use chrono::NaiveDateTime;

    #[test]
    fn cursor_round_trip_preserves_typed_values() {
        let order = vec![Order { column: "seq".into(), expr: String::new(), desc: false }];
        let value = NaiveDateTime::parse_from_str("2026-09-13 12:34:56.123456", "%Y-%m-%d %H:%M:%S%.f").unwrap();
        let encoded = encode(&order, &[Val::DateTime(value)]).unwrap();
        let (decoded_order, params) = decode(&encoded).unwrap();
        assert!(same_order(&order, &decoded_order));
        assert_eq!(params, vec![Param::DateTime(value)]);
    }

    #[test]
    fn cursor_rejects_invalid_payload() {
        assert_eq!(decode("invalid").unwrap_err().code(), crate::codes::CURSOR_INVALID);
        let order = vec![Order { column: "seq".into(), expr: String::new(), desc: false }];
        assert!(encode(&order, &[]).unwrap_err().code() == crate::codes::CURSOR_INVALID);
    }
}
