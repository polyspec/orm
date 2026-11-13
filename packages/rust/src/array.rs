//! The array form of a model, a collection and a group row (COD-27).

use crate::value::Val;
use indexmap::IndexMap;

/// A value of the array form (COD-27). It holds every value that the array form of Go, PHP, the PHP extension,
/// TypeScript and Python holds: the bytes of a bytes column, a non-finite float, and an ordered-json document whose
/// numbers have no binary64 form, such as `1e400`.
#[derive(Debug, Clone)]
pub enum ArrayValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
    /// A serde_json value: a styled value that a codec reads, or a value added to the row.
    Json(serde_json::Value),
    /// An ordered-json value, with its member order and number text as stored.
    Ordered(polyspec_json::Value),
    /// A row: its values by name, in row order.
    Map(IndexMap<String, ArrayValue>),
    /// The rows of a collection, in collection order.
    List(Vec<ArrayValue>),
}

static NULL: ArrayValue = ArrayValue::Null;

impl ArrayValue {
    /// The value of a column: a date or datetime is its text in the form of the value model, as in every runtime.
    pub(crate) fn of(value: &Val) -> ArrayValue {
        match value {
            Val::Null => ArrayValue::Null,
            Val::I64(x) => ArrayValue::Int(*x),
            Val::F64(x) => ArrayValue::Float(*x),
            Val::Str(s) => ArrayValue::Text(s.clone()),
            Val::Bytes(b) => ArrayValue::Bytes(b.clone()),
            Val::DateTime(t) => ArrayValue::Text(t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
            Val::Date(d) => ArrayValue::Text(d.to_string()),
            Val::Bool(b) => ArrayValue::Bool(*b),
            Val::Json(v) => ArrayValue::Json(v.clone()),
            Val::Ordered(v) => ArrayValue::Ordered(v.clone()),
        }
    }

    /// The member `name` of a row; None for a missing member or a value that is not a row.
    pub fn get(&self, name: &str) -> Option<&ArrayValue> {
        match self {
            ArrayValue::Map(values) => values.get(name),
            _ => None,
        }
    }

    /// The text of a text value.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            ArrayValue::Text(s) => Some(s),
            _ => None,
        }
    }

    /// The bytes of a bytes value.
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            ArrayValue::Bytes(b) => Some(b),
            _ => None,
        }
    }

    /// The values of a row by name.
    pub fn as_map(&self) -> Option<&IndexMap<String, ArrayValue>> {
        match self {
            ArrayValue::Map(values) => Some(values),
            _ => None,
        }
    }

    /// The rows of a collection.
    pub fn as_list(&self) -> Option<&[ArrayValue]> {
        match self {
            ArrayValue::List(items) => Some(items),
            _ => None,
        }
    }
}

/// `value["name"]` is the member of a row, and Null when the row has no such member.
impl std::ops::Index<&str> for ArrayValue {
    type Output = ArrayValue;
    fn index(&self, name: &str) -> &ArrayValue {
        self.get(name).unwrap_or(&NULL)
    }
}

/// `value[i]` is the row `i` of a collection, and Null past its end.
impl std::ops::Index<usize> for ArrayValue {
    type Output = ArrayValue;
    fn index(&self, i: usize) -> &ArrayValue {
        self.as_list().and_then(|items| items.get(i)).unwrap_or(&NULL)
    }
}

/// Ordered-json values are equal when their compact texts are equal, as for `Val`; a float equals by its bits, so a
/// NaN equals itself.
impl PartialEq for ArrayValue {
    fn eq(&self, other: &ArrayValue) -> bool {
        match (self, other) {
            (ArrayValue::Null, ArrayValue::Null) => true,
            (ArrayValue::Bool(a), ArrayValue::Bool(b)) => a == b,
            (ArrayValue::Int(a), ArrayValue::Int(b)) => a == b,
            (ArrayValue::Float(a), ArrayValue::Float(b)) => a.to_bits() == b.to_bits(),
            (ArrayValue::Text(a), ArrayValue::Text(b)) => a == b,
            (ArrayValue::Bytes(a), ArrayValue::Bytes(b)) => a == b,
            (ArrayValue::Json(a), ArrayValue::Json(b)) => a == b,
            (ArrayValue::Ordered(a), ArrayValue::Ordered(b)) => a.to_string() == b.to_string(),
            (ArrayValue::Map(a), ArrayValue::Map(b)) => a.len() == b.len() && a.iter().zip(b).all(|((ka, va), (kb, vb))| ka == kb && va == vb),
            (ArrayValue::List(a), ArrayValue::List(b)) => a == b,
            _ => false,
        }
    }
}
