//! `orm_value`: the value of a column, of a condition and of a row as the contract passes it (docs/spec/core.md
//! CORE-60, CORE-62 to CORE-64). A language value enters by [`from_host`] and a value leaves by [`to_host`]; every rule
//! of what a language value is to orm is in these two functions and in [`OrmValue::of_column`], once.

use binding_core::{BytesOut, Failure, FloatOut, Handle, HostText, HostValue, HostValues, IntOut, MapOut, OutValue, OutValues, ValueType};
use indexmap::IndexMap;
use polyspec_orm_schema::dbspec::{Field, Type};

use crate::value::{Param, Val};
use crate::{Error, Kind, Result};

/// The levels of lists and maps that a value holds at most (CORE-63), the limit of the codec stages (COD-70).
const DEPTH_LIMIT: usize = 256;

/// The greatest integer that a number of a language with one number type holds exactly: 2^53 - 1 (CORE-63).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A value of the contract type `orm_value` (CORE-62).
#[derive(Debug, Clone, PartialEq)]
pub enum OrmValue {
    Null,
    Bool(bool),
    /// An integer of a column narrower than 64 bits, or a number without a fraction of a language with one number type.
    Int(i64),
    /// An integer of a 64-bit column, or an integer of a language.
    Int64(i64),
    Float(f64),
    /// A text; the canonical text of a date, a time or a date-time; the exact text of a decimal.
    Text(String),
    Bytes(Vec<u8>),
    /// The value of a column after the stage `json` (CORE-61). No string of it holds an unpaired surrogate (CORE-64).
    Json(JsonValue),
    List(Vec<OrmValue>),
    Map(IndexMap<String, OrmValue>),
}

/// A JSON value whose strings are sequences of Unicode scalar values, so that it has a description (CORE-64).
#[derive(Debug, Clone)]
pub struct JsonValue(polyspec_json::Value);

/// JSON values are equal when their compact texts are equal, as the cells of a row are.
impl PartialEq for JsonValue {
    fn eq(&self, other: &JsonValue) -> bool {
        self.0.to_string() == other.0.to_string()
    }
}

impl JsonValue {
    /// The JSON value `value`; one that holds a string with an unpaired surrogate is `codec_decode` (CORE-64).
    pub fn new(value: polyspec_json::Value) -> Result<JsonValue> {
        let mut pending = vec![&value];
        while let Some(next) = pending.pop() {
            match next.kind() {
                polyspec_json::Kind::String => {
                    next.string_value().map_err(no_scalar_text)?;
                }
                polyspec_json::Kind::Array => pending.extend(next.items().map_err(json_defect)?),
                polyspec_json::Kind::Object => {
                    for (key, member) in next.members().map_err(json_defect)?.iter() {
                        key.string_value().map_err(no_scalar_text)?;
                        pending.push(member);
                    }
                }
                polyspec_json::Kind::Null | polyspec_json::Kind::Boolean | polyspec_json::Kind::Number => {}
            }
        }
        Ok(JsonValue(value))
    }

    /// The JSON value.
    pub fn value(&self) -> &polyspec_json::Value {
        &self.0
    }
}

fn no_scalar_text(cause: polyspec_json::Error) -> Error {
    Error::with_source(Kind::CodecDecode, "the JSON value holds a string that is no sequence of Unicode scalar values", Box::new(cause))
}

/// A JSON value that does not answer for its own kind: a defect of the JSON library, never an input.
fn json_defect(cause: polyspec_json::Error) -> Error {
    Error::internal(format!("a JSON value did not give the content of its kind: {cause}"))
}

/// The refusal of a language value that is no `orm_value` (CORE-63). `what` names the reason and never the value.
fn no_value(what: &str) -> Failure<Error> {
    Failure::Kind(Error::new(Kind::CodecEncode, format!("the value is no value of a column: {what}")))
}

/// The refusal of an `orm_value` that a condition does not take (CORE-82).
fn no_condition_value(what: &str) -> Error {
    Error::new(Kind::CodecEncode, format!("the value of a condition is {what}"))
}

impl OrmValue {
    /// The value of the cell `cell` of the column `field` (CORE-62): the type of the column decides the kind.
    pub fn of_column(field: &Field, cell: Val) -> Result<OrmValue> {
        Ok(match cell {
            Val::Null => OrmValue::Null,
            Val::I64(n) if matches!(field.ty, Type::I64) => OrmValue::Int64(n),
            Val::I64(n) => OrmValue::Int(n),
            Val::F64(x) => OrmValue::Float(x),
            Val::Bool(flag) => OrmValue::Bool(flag),
            Val::Str(text) => OrmValue::Text(text),
            Val::Bytes(bytes) => OrmValue::Bytes(bytes),
            Val::Date(day) => OrmValue::Text(day.to_string()),
            Val::DateTime(instant) => {
                let precision = match field.ty {
                    Type::DateTime(precision) => precision,
                    _ => return Err(Error::internal(format!("the column {} holds a date-time and is no datetime column", field.name))),
                };
                OrmValue::Text(crate::model::datetime_text(&instant, precision))
            }
            Val::Ordered(value) => OrmValue::Json(JsonValue::new(value)?),
            Val::Json(value) => styled(value)?,
        })
    }

    /// The parameter of a value that is one value of a statement, or `None` for a value that is none.
    pub(crate) fn scalar(self) -> std::result::Result<Param, OrmValue> {
        Ok(match self {
            OrmValue::Null => Param::Null,
            OrmValue::Bool(flag) => Param::Bool(flag),
            OrmValue::Int(n) | OrmValue::Int64(n) => Param::I64(n),
            OrmValue::Float(x) => Param::F64(x),
            OrmValue::Text(text) => Param::Str(text),
            OrmValue::Bytes(bytes) => Param::Bytes(bytes),
            other @ (OrmValue::Json(_) | OrmValue::List(_) | OrmValue::Map(_)) => return Err(other),
        })
    }

    /// The name of the kind of a value that a condition does not take.
    fn refused_kind(&self) -> &'static str {
        match self {
            OrmValue::Json(_) => "a JSON value",
            OrmValue::List(_) => "a list inside a list",
            OrmValue::Map(_) => "a map",
            _ => "no value of a condition",
        }
    }

    /// One value of a list of values.
    fn item(self) -> Result<Param> {
        self.scalar().map_err(|refused| no_condition_value(refused.refused_kind()))
    }

    /// The condition value of a key whose operator is `op` (CORE-82).
    pub(crate) fn into_arg(self, op: &str) -> Result<crate::core::Arg> {
        use crate::args::Value;
        use crate::core::Arg;
        match (op, self) {
            ("tuple" | "ne_tuple", OrmValue::List(groups)) => {
                let rows = groups
                    .into_iter()
                    .map(|group| match group {
                        OrmValue::List(values) => values.into_iter().map(OrmValue::item).collect::<Result<Vec<Param>>>(),
                        _ => Err(no_condition_value("no list of value groups")),
                    })
                    .collect::<Result<Vec<Vec<Param>>>>()?;
                Ok(Arg::Tuples(rows))
            }
            ("tuple" | "ne_tuple", _) => Err(no_condition_value("no list of value groups")),
            ("between", OrmValue::List(pair)) => {
                let mut pair = pair.into_iter();
                match (pair.next(), pair.next(), pair.next()) {
                    (Some(low), Some(high), None) => Ok(Arg::Value(Value::Pair(low.item()?, high.item()?))),
                    _ => Err(no_condition_value("no list of two values")),
                }
            }
            (_, OrmValue::Null) => Ok(Arg::Value(Value::Null)),
            (_, OrmValue::List(values)) => Ok(Arg::Value(Value::List(values.into_iter().map(OrmValue::item).collect::<Result<Vec<Param>>>()?))),
            (_, OrmValue::Json(_)) => Err(no_condition_value("a JSON value")),
            (_, OrmValue::Map(_)) => Err(no_condition_value("a map")),
            (_, value) => Ok(Arg::Value(Value::One(value.item()?))),
        }
    }
}

/// The value of a column after a style stage other than `json`, in the kinds of CORE-62.
fn styled(value: serde_json::Value) -> Result<OrmValue> {
    Ok(match value {
        serde_json::Value::Null => OrmValue::Null,
        serde_json::Value::Bool(flag) => OrmValue::Bool(flag),
        serde_json::Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(n), _) => OrmValue::Int64(n),
            (None, Some(x)) if x.is_finite() => OrmValue::Float(x),
            _ => return Err(Error::new(Kind::CodecDecode, "a number of the value fits neither i64 nor a finite f64")),
        },
        serde_json::Value::String(text) => OrmValue::Text(text),
        serde_json::Value::Array(items) => OrmValue::List(items.into_iter().map(styled).collect::<Result<Vec<OrmValue>>>()?),
        serde_json::Value::Object(members) => {
            OrmValue::Map(members.into_iter().map(|(key, member)| Ok((key, styled(member)?))).collect::<Result<IndexMap<String, OrmValue>>>()?)
        }
    })
}

/// The `orm_value` of a value of a language (CORE-63).
///
/// # Errors
///
/// `codec_encode` for a value that is no value of a column, and the exception that the language raised while it
/// answered for a child.
pub fn from_host(host: &mut dyn HostValues, value: HostValue) -> std::result::Result<OrmValue, Failure<Error>> {
    read(host, value, 0)
}

fn text(text: HostText) -> std::result::Result<OrmValue, Failure<Error>> {
    let scalars = || no_value("a text that is no sequence of Unicode scalar values");
    Ok(match text {
        // A text of a language whose text is bytes: bytes that are no UTF-8 are bytes (CORE-63).
        HostText::Bytes(bytes) => match String::from_utf8(bytes) {
            Ok(text) => OrmValue::Text(text),
            Err(bytes) => OrmValue::Bytes(bytes.into_bytes()),
        },
        HostText::Utf16(units) => OrmValue::Text(String::from_utf16(&units).map_err(|_unpaired| scalars())?),
        HostText::CodePoints(points) => {
            OrmValue::Text(points.into_iter().map(|point| char::from_u32(point).ok_or_else(scalars)).collect::<std::result::Result<String, _>>()?)
        }
    })
}

/// The key of an entry of a map: a text, or an integer key of a PHP array as its text (CORE-63).
fn key(key: HostValue, php: bool) -> std::result::Result<String, Failure<Error>> {
    let not_text = || no_value("a map key that is no text");
    match key {
        HostValue::Text(host) => match text(host)? {
            OrmValue::Text(key) => Ok(key),
            _ => Err(not_text()),
        },
        HostValue::Int(n) if php => Ok(n.to_string()),
        _ => Err(not_text()),
    }
}

fn read(host: &mut dyn HostValues, value: HostValue, depth: usize) -> std::result::Result<OrmValue, Failure<Error>> {
    let nested = |depth: usize| if depth >= DEPTH_LIMIT { Err(no_value("a list or map nested deeper than 256 levels")) } else { Ok(depth + 1) };
    let list = |host: &mut dyn HostValues, handle: Handle, len: u64, depth: usize| {
        let mut items = Vec::new();
        for index in 0..len {
            let item = host.item(handle, index)?;
            items.push(read(host, item, depth)?);
        }
        Ok::<OrmValue, Failure<Error>>(OrmValue::List(items))
    };
    let map = |host: &mut dyn HostValues, handle: Handle, len: u64, depth: usize, php: bool| {
        let mut entries = IndexMap::new();
        for index in 0..len {
            let (name, member) = host.entry(handle, index)?;
            entries.insert(key(name, php)?, read(host, member, depth)?);
        }
        Ok::<OrmValue, Failure<Error>>(OrmValue::Map(entries))
    };
    match value {
        HostValue::Null => Ok(OrmValue::Null),
        HostValue::Bool(flag) => Ok(OrmValue::Bool(flag)),
        HostValue::Int(n) => Ok(OrmValue::Int64(n)),
        HostValue::Number(_) => Err(no_value("an integer outside i64")),
        HostValue::Float(x) | HostValue::UntypedNumber(x) if !x.is_finite() => Err(no_value("a float that is not finite")),
        HostValue::Float(x) => Ok(OrmValue::Float(x)),
        HostValue::UntypedNumber(x) => Ok(match safe_integer(x) {
            Some(n) => OrmValue::Int(n),
            None => OrmValue::Float(x),
        }),
        HostValue::Text(host) => text(host),
        HostValue::Bytes(bytes) => Ok(OrmValue::Bytes(bytes)),
        HostValue::List { handle, len } | HostValue::PhpArray { handle, len, is_list: true } => list(host, handle, len, nested(depth)?),
        HostValue::PhpArray { handle, len, is_list: false } => map(host, handle, len, nested(depth)?, true),
        HostValue::Map { handle, len } => map(host, handle, len, nested(depth)?, false),
        HostValue::PhpReference { target, .. } => read(host, *target, depth),
        HostValue::Undefined => Err(no_value("an undefined value")),
        HostValue::Date(_) => Err(no_value("a date of the language")),
        HostValue::Callable(_) => Err(no_value("a function")),
        // The alias has an `in` row for the map type of each language and for no object (CORE-63).
        HostValue::PlainObject { .. } | HostValue::StdClass { .. } | HostValue::Object { .. } | HostValue::Value { .. } | HostValue::Other { .. } => {
            Err(no_value("an object of the language"))
        }
    }
}

/// The integer of a number without a fraction in the range of -(2^53 - 1) to 2^53 - 1, or `None` (CORE-63).
fn safe_integer(x: f64) -> Option<i64> {
    if x.fract() != 0.0 || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&x) {
        return None;
    }
    // The number has no fraction and is inside the range in which every integer is an f64, so the cast is exact.
    Some(x as i64)
}

/// The top level of `value` as a language takes it, and the children of its handles (CORE-64).
#[must_use]
pub fn to_host(value: &OrmValue) -> (OutValue, Children<'_>) {
    let mut children = Children { parts: Vec::new() };
    (children.describe(value), children)
}

/// A part of a value that has children: the handle of a part is its position in [`Children::parts`].
#[derive(Clone, Copy)]
enum Part<'a> {
    List(&'a [OrmValue]),
    Map(&'a IndexMap<String, OrmValue>),
    JsonList(&'a [polyspec_json::Value]),
    JsonMap(&'a polyspec_json::OrderedMap),
}

/// The children of the handles of one `orm_value`, which a binding asks for (CORE-64).
pub struct Children<'a> {
    parts: Vec<Part<'a>>,
}

/// A question about a part that the value does not hold, or a JSON value that does not answer for its own kind: a
/// defect of the binding or of this crate, never an answer.
#[allow(clippy::panic, reason = "CORE-64: OutValues has no failure and a defect is no value; a binding makes the panic the kind internal")]
fn defect(what: &str, handle: Handle, index: u64) -> ! {
    panic!("CORE-64: {what}: handle {}, index {index}", handle.raw())
}

fn count(len: usize) -> u64 {
    // A count of the parts of a value in memory fits u64 on every target of the core.
    len as u64
}

impl<'a> Children<'a> {
    fn part(&mut self, part: Part<'a>) -> Handle {
        self.parts.push(part);
        Handle::new(count(self.parts.len() - 1))
    }

    fn describe(&mut self, value: &'a OrmValue) -> OutValue {
        match value {
            OrmValue::Null => OutValue::Null,
            OrmValue::Bool(flag) => OutValue::Bool(*flag),
            OrmValue::Int(n) => OutValue::Int(IntOut::new(*n)),
            OrmValue::Int64(n) => OutValue::Int64(*n),
            OrmValue::Float(x) => OutValue::Float(FloatOut::new(*x)),
            OrmValue::Text(text) => OutValue::Text(text.clone()),
            OrmValue::Bytes(bytes) => OutValue::Bytes(BytesOut::new(bytes.clone())),
            OrmValue::Json(json) => OutValue::Nested { value_type: ValueType::Json, value: Box::new(self.describe_json(json.value())) },
            OrmValue::List(items) => OutValue::List { handle: self.part(Part::List(items)), len: count(items.len()) },
            OrmValue::Map(entries) => OutValue::Map(MapOut::new(self.part(Part::Map(entries)), count(entries.len()), false)),
        }
    }

    /// One level of a JSON value in the kinds of the `out` table of `json_value` (CORE-64).
    fn describe_json(&mut self, value: &'a polyspec_json::Value) -> OutValue {
        let at = Handle::new(count(self.parts.len()));
        match value.kind() {
            polyspec_json::Kind::Null => OutValue::Null,
            polyspec_json::Kind::Boolean => match value.boolean_value() {
                Ok(flag) => OutValue::Bool(flag),
                Err(_) => defect("a JSON boolean gives no boolean", at, 0),
            },
            polyspec_json::Kind::Number => match value.number_literal() {
                Ok(literal) => OutValue::Number(literal.to_owned()),
                Err(_) => defect("a JSON number gives no literal", at, 0),
            },
            polyspec_json::Kind::String => match value.string_value() {
                Ok(text) => OutValue::Text(text),
                Err(_) => defect("a JSON string of a checked value is no text", at, 0),
            },
            polyspec_json::Kind::Array => match value.items() {
                Ok(items) => OutValue::List { handle: self.part(Part::JsonList(items)), len: count(items.len()) },
                Err(_) => defect("a JSON array gives no items", at, 0),
            },
            polyspec_json::Kind::Object => match value.members() {
                Ok(members) => OutValue::Map(MapOut::new(self.part(Part::JsonMap(members)), members.len(), false)),
                Err(_) => defect("a JSON object gives no members", at, 0),
            },
        }
    }
}

impl<'a> Children<'a> {
    /// The part of the handle `handle` and the position `index` in it; a handle or an index that the value did not
    /// give is a defect.
    fn at(&self, handle: Handle, index: u64, what: &str) -> (Part<'a>, usize) {
        let (Ok(at), Ok(position)) = (usize::try_from(handle.raw()), usize::try_from(index)) else { defect(what, handle, index) };
        match self.parts.get(at) {
            Some(part) => (*part, position),
            None => defect(what, handle, index),
        }
    }
}

impl OutValues for Children<'_> {
    fn item(&mut self, list: Handle, index: u64) -> OutValue {
        let what = "no list of the value has this handle and index";
        match self.at(list, index, what) {
            (Part::List(items), position) => match items.get(position) {
                Some(item) => self.describe(item),
                None => defect(what, list, index),
            },
            (Part::JsonList(items), position) => match items.get(position) {
                Some(item) => self.describe_json(item),
                None => defect(what, list, index),
            },
            (Part::Map(_) | Part::JsonMap(_), _) => defect(what, list, index),
        }
    }

    fn entry(&mut self, map: Handle, index: u64) -> (OutValue, OutValue) {
        let what = "no map of the value has this handle and index";
        match self.at(map, index, what) {
            (Part::Map(entries), position) => match entries.get_index(position) {
                Some((key, value)) => (OutValue::Text(key.clone()), self.describe(value)),
                None => defect(what, map, index),
            },
            (Part::JsonMap(members), position) => match members.iter().nth(position) {
                Some((key, value)) => (self.describe_json(key), self.describe_json(value)),
                None => defect(what, map, index),
            },
            (Part::List(_) | Part::JsonList(_), _) => defect(what, map, index),
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/orm_value.rs"]
mod orm_value_tests;
