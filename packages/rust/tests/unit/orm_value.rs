// orm_value (CORE-62 to CORE-64): the kind that the type of a column gives its value, the value of a language that
// enters by from_host and the description of a value that leaves by to_host.

use binding_core::{
    Failure, Handle, HostText, HostValue, HostValues, Native, NativeObject, OutValue, OutValues, Predicate, Prototype, Raised, ValueKind, ValueType,
};
use chrono::Timelike as _;
use indexmap::IndexMap;
use polyspec_orm_schema::dbspec::{Field, Type};

use super::{from_host, to_host, JsonValue, OrmValue};
use crate::value::Val;
use crate::Kind;

fn column(ty: Type) -> Field {
    Field {
        name: "c".into(),
        ty,
        nullable: true,
        identity: false,
        primary_key: false,
        foreign_key: false,
        default: None,
        select_explicit: false,
        codec: Vec::new(),
        blind_index: None,
    }
}

/// A language that holds the containers of a test by their handles.
#[derive(Default)]
struct Host {
    lists: Vec<Vec<HostValue>>,
    maps: Vec<Vec<(HostValue, HostValue)>>,
    values: Vec<HostValue>,
    read_failure: Option<Raised>,
}

impl Host {
    fn list(&mut self, items: Vec<HostValue>) -> HostValue {
        let len = items.len() as u64;
        self.lists.push(items);
        HostValue::List { handle: Handle::new(self.lists.len() as u64 - 1), len }
    }

    fn entries(&mut self, entries: Vec<(HostValue, HostValue)>) -> (Handle, u64) {
        let len = entries.len() as u64;
        self.maps.push(entries);
        (Handle::new(self.maps.len() as u64 - 1), len)
    }

    fn wrapped(&mut self, kind: ValueKind, value: HostValue) -> HostValue {
        self.values.push(value);
        HostValue::Value { kind, handle: Handle::new(self.values.len() as u64 - 1) }
    }
}

impl HostValues for Host {
    fn item(&mut self, list: Handle, index: u64) -> Result<HostValue, Raised> {
        Ok(self.lists[list.raw() as usize][index as usize].clone())
    }

    fn entry(&mut self, map: Handle, index: u64) -> Result<(HostValue, HostValue), Raised> {
        Ok(self.maps[map.raw() as usize][index as usize].clone())
    }

    fn read(&mut self, value: Handle) -> Result<HostValue, Raised> {
        match &self.read_failure {
            Some(error) => Err(error.clone()),
            None => Ok(self.values[value.raw() as usize].clone()),
        }
    }
}

fn utf8(text: &str) -> HostValue {
    HostValue::Text(HostText::Bytes(text.as_bytes().to_vec()))
}

fn taken(host: &mut Host, value: HostValue) -> OrmValue {
    match from_host(host, value) {
        Ok(value) => value,
        Err(error) => panic!("refused: {error}"),
    }
}

fn refusal(host: &mut Host, value: HostValue) -> String {
    match from_host(host, value) {
        Err(Failure::Kind(error)) => {
            assert_eq!(error.kind(), Kind::CodecEncode, "{error}");
            error.to_string()
        }
        Err(other) => panic!("the refusal is no kind: {other}"),
        Ok(value) => panic!("the value was taken as {value:?}"),
    }
}

// Requirements: CORE-60, CORE-62. The type of a column decides the kind of its value, whatever the size of the value.
#[test]
fn the_type_of_a_column_decides_the_kind_of_its_value() {
    let _case = polyspec_orm_testcase::case!();
    let of = |ty: Type, cell: Val| OrmValue::of_column(&column(ty), cell).expect("a value of the column");
    assert_eq!(of(Type::I64, Val::I64(7)), OrmValue::Int64(7), "a small integer of a 64-bit column is int64");
    assert_eq!(of(Type::I32, Val::I64(7)), OrmValue::Int(7));
    assert_eq!(of(Type::I16, Val::I64(-7)), OrmValue::Int(-7));
    assert_eq!(of(Type::F64, Val::F64(1.5)), OrmValue::Float(1.5));
    assert_eq!(of(Type::Bool, Val::Bool(true)), OrmValue::Bool(true));
    assert_eq!(of(Type::Bytes, Val::Bytes(vec![0xff])), OrmValue::Bytes(vec![0xff]));
    assert_eq!(of(Type::Decimal(10, 4), Val::Str("48.0450".into())), OrmValue::Text("48.0450".into()), "a decimal is its exact text");
    assert_eq!(of(Type::Text, Val::Null), OrmValue::Null);
    let day = chrono::NaiveDate::from_ymd_opt(2026, 2, 3).expect("a day");
    assert_eq!(of(Type::Date, Val::Date(day)), OrmValue::Text("2026-02-03".into()));
    let instant = day.and_hms_micro_opt(4, 5, 6, 120_000).expect("an instant");
    assert_eq!(of(Type::DateTime(3), Val::DateTime(instant)), OrmValue::Text("2026-02-03 04:05:06.120".into()));
    assert_eq!(of(Type::DateTime(0), Val::DateTime(instant.with_nanosecond(0).expect("a second"))), OrmValue::Text("2026-02-03 04:05:06".into()));
    assert_eq!(of(Type::Time(0), Val::Str("04:05:06".into())), OrmValue::Text("04:05:06".into()));
    let error = OrmValue::of_column(&column(Type::Text), Val::DateTime(instant)).expect_err("a date-time of a text column");
    assert_eq!(error.kind(), Kind::Internal, "{error}");
}

// Requirements: CORE-122, CORE-62, CORE-64. A column after the stage json is a JSON value, a column after another style
// stage is its value in the kinds of orm_value, and a JSON string with an unpaired surrogate is codec_decode.
#[test]
fn a_styled_column_is_a_json_value_or_a_value_of_the_common_model() {
    let _case = polyspec_orm_testcase::case!();
    let json = polyspec_json::Value::number("1.50").expect("a number");
    let value = OrmValue::of_column(&column(Type::Text), Val::Ordered(json.clone())).expect("a JSON value");
    assert_eq!(value, OrmValue::Json(JsonValue::new(json).expect("a JSON value")));
    let styled = serde_json::json!({"n": 7, "x": 1.5, "big": 18446744073709551615u64, "list": [null, true, "t"]});
    let value = OrmValue::of_column(&column(Type::Text), Val::Json(styled)).expect("a styled value");
    let OrmValue::Map(members) = value else { panic!("a styled object is a map") };
    assert_eq!(members.get("n"), Some(&OrmValue::Int64(7)));
    assert_eq!(members.get("x"), Some(&OrmValue::Float(1.5)));
    assert_eq!(members.get("big"), Some(&OrmValue::Float(18_446_744_073_709_551_615.0)), "an integer past i64 is the float that holds it");
    assert_eq!(members.get("list"), Some(&OrmValue::List(vec![OrmValue::Null, OrmValue::Bool(true), OrmValue::Text("t".into())])));
    let lone = polyspec_json::Value::from_units(&[0xd800]).expect("a string of one unit");
    let array = polyspec_json::Value::array(&[lone]).expect("an array");
    let error = OrmValue::of_column(&column(Type::Text), Val::Ordered(array)).expect_err("an unpaired surrogate");
    assert_eq!(error.to_string(), "codec_decode: the JSON value holds a string that is no sequence of Unicode scalar values");
}

// Requirements: CORE-123. A value of a language is read alone: an integer is int64, a number of a language with one
// number type is int or float, a text that is bytes is text or bytes, and a PHP array is a list or a map.
#[test]
fn from_host_reads_a_value_of_a_language() {
    let _case = polyspec_orm_testcase::case!();
    let mut host = Host::default();
    let mut take = |value: HostValue| taken(&mut host, value);
    assert_eq!(take(HostValue::Null), OrmValue::Null);
    assert_eq!(take(HostValue::Bool(false)), OrmValue::Bool(false));
    assert_eq!(take(HostValue::Int(7)), OrmValue::Int64(7));
    assert_eq!(take(HostValue::Float(7.0)), OrmValue::Float(7.0), "a float of a language with integers stays a float");
    assert_eq!(take(HostValue::UntypedNumber(7.0)), OrmValue::Int(7));
    assert_eq!(take(HostValue::UntypedNumber(-9_007_199_254_740_991.0)), OrmValue::Int(-9_007_199_254_740_991));
    assert_eq!(take(HostValue::UntypedNumber(9_007_199_254_740_992.0)), OrmValue::Float(9_007_199_254_740_992.0));
    assert_eq!(take(HostValue::UntypedNumber(1.5)), OrmValue::Float(1.5));
    assert_eq!(take(utf8("café")), OrmValue::Text("café".into()));
    assert_eq!(take(HostValue::Text(HostText::Bytes(vec![0xff, 0x00]))), OrmValue::Bytes(vec![0xff, 0x00]));
    assert_eq!(take(HostValue::Text(HostText::Utf16(vec![0x61, 0xd83d, 0xde00]))), OrmValue::Text("a\u{1f600}".into()));
    assert_eq!(take(HostValue::Text(HostText::CodePoints(vec![0x61, 0x1f600]))), OrmValue::Text("a\u{1f600}".into()));
    assert_eq!(take(HostValue::Bytes(vec![1, 2])), OrmValue::Bytes(vec![1, 2]));
    let reference = HostValue::PhpReference { identity: Handle::new(9), target: Box::new(HostValue::Int(3)) };
    assert_eq!(take(reference), OrmValue::Int64(3), "a reference is the value that it holds");

    let mut host = Host::default();
    let inner = host.list(vec![HostValue::Int(1), HostValue::Null]);
    let (handle, len) = host.entries(vec![(utf8("a"), inner), (HostValue::Int(5), utf8("five"))]);
    let php = taken(&mut host, HostValue::PhpArray { handle, len, is_list: false });
    let expected: IndexMap<String, OrmValue> =
        [("a".to_owned(), OrmValue::List(vec![OrmValue::Int64(1), OrmValue::Null])), ("5".to_owned(), OrmValue::Text("five".into()))].into();
    assert_eq!(php, OrmValue::Map(expected), "an integer key of a PHP array is the text of the integer");
    let (handle, len) = host.entries(vec![(utf8("k"), HostValue::Bool(true))]);
    let map = taken(&mut host, HostValue::Map { handle, len });
    assert_eq!(map, OrmValue::Map([("k".to_owned(), OrmValue::Bool(true))].into()));
}

// Requirements: CORE-123, CORE-124. A gathered value keeps its declared kind instead of the kind of its native content.
#[test]
fn gathered_values_preserve_the_kind_of_ambiguous_native_content() {
    let _case = polyspec_orm_testcase::case!();
    let mut host = Host::default();
    for n in [i64::MIN, -7, 0, 7, i64::MAX] {
        let value = host.wrapped(ValueKind::Int, HostValue::Int(n));
        assert_eq!(taken(&mut host, value), OrmValue::Int(n));
        assert_eq!(taken(&mut host, HostValue::Int(n)), OrmValue::Int64(n));
    }
    for n in [-0.0, 0.0, 7.0, 1.5] {
        let value = host.wrapped(ValueKind::Float, HostValue::UntypedNumber(n));
        let OrmValue::Float(actual) = taken(&mut host, value) else { panic!("a gathered float stays a float") };
        assert_eq!(actual.to_bits(), n.to_bits(), "the sign of zero is retained");
    }
    for bytes in [Vec::new(), b"text".to_vec(), vec![0xff, 0]] {
        let value = host.wrapped(ValueKind::Bytes, HostValue::Text(HostText::Bytes(bytes.clone())));
        assert_eq!(taken(&mut host, value), OrmValue::Bytes(bytes));
    }
    let (handle, len) = host.entries(vec![(HostValue::Int(0), HostValue::Bool(true)), (HostValue::Int(1), HostValue::Null)]);
    let value = host.wrapped(ValueKind::Map, HostValue::PhpArray { handle, len, is_list: true });
    assert_eq!(taken(&mut host, value), OrmValue::Map([("0".to_owned(), OrmValue::Bool(true)), ("1".to_owned(), OrmValue::Null)].into()));
    let (handle, len) = host.entries(Vec::new());
    let value = host.wrapped(ValueKind::Map, HostValue::PhpArray { handle, len, is_list: true });
    assert_eq!(taken(&mut host, value), OrmValue::Map(IndexMap::new()));
}

// Requirements: CORE-123, CORE-124. Invalid class content is refused and a getter's exception is returned unchanged.
#[test]
fn gathered_values_refuse_invalid_content_and_preserve_getter_exceptions() {
    let _case = polyspec_orm_testcase::case!();
    let mut host = Host::default();
    for (kind, value) in
        [(ValueKind::Int, HostValue::Null), (ValueKind::Float, HostValue::Null), (ValueKind::Bytes, HostValue::Null), (ValueKind::Map, HostValue::Null)]
    {
        let value = host.wrapped(kind, value);
        let message = refusal(&mut host, value);
        assert!(message.starts_with("codec_encode: the value is no value of a column:"), "{message}");
    }
    let raised = Raised::from_generated(Native::new(Kept));
    host.read_failure = Some(raised.clone());
    let value = host.wrapped(ValueKind::Int, HostValue::Int(7));
    match from_host(&mut host, value) {
        Err(Failure::Raised(actual)) => assert_eq!(actual, raised),
        other => panic!("the getter's exception was not preserved: {other:?}"),
    }
}

// Requirements: CORE-124. PHP map output selects a wrapper exactly when its keys form a list, including no keys.
#[test]
fn map_output_declares_sequence_keys_from_its_ordered_text_keys() {
    let _case = polyspec_orm_testcase::case!();
    for (keys, sequence) in [(vec![], true), (vec!["0", "1"], true), (vec!["1", "0"], false), (vec!["00"], false), (vec!["1"], false), (vec!["name"], false)] {
        let entries = keys.iter().map(|key| ((*key).to_owned(), OrmValue::Null)).collect();
        let value = OrmValue::Map(entries);
        let OutValue::Map(map) = to_host(&value).0 else { panic!("a map stays a map") };
        assert_eq!(map.sequence_keys(), sequence, "keys {keys:?}");
    }
}

// Requirements: CORE-124. Numeric output keeps a native representation exactly when it preserves the kind and value.
#[test]
fn outgoing_numeric_predicates_distinguish_safe_and_large_integral_values() {
    let _case = polyspec_orm_testcase::case!();
    for (value, safe) in [
        (OrmValue::Int(7), true),
        (OrmValue::Int(i64::MAX), false),
        (OrmValue::Float(-0.0), true),
        (OrmValue::Float(7.0), true),
        (OrmValue::Float(9_007_199_254_740_991.0), true),
        (OrmValue::Float(1e16), false),
        (OrmValue::Float(1.5), false),
    ] {
        let (out, _) = to_host(&value);
        assert_eq!(out.predicate(Predicate::SafeInteger), Some(safe), "value {value:?}");
    }
}

// Requirements: CORE-123. A value that is no value of a column is codec_encode, and its message names no value.
/// A language object that a binding keeps (binding_core::Native), which a test makes without a language.
#[derive(Debug)]
struct Kept;

impl NativeObject for Kept {}

#[test]
fn from_host_refuses_a_value_that_is_no_value_of_a_column() {
    let _case = polyspec_orm_testcase::case!();
    let mut host = Host::default();
    let message = |what: &str| format!("codec_encode: the value is no value of a column: {what}");
    assert_eq!(refusal(&mut host, HostValue::Number("9223372036854775808".into())), message("an integer outside i64"));
    assert_eq!(refusal(&mut host, HostValue::Float(f64::NAN)), message("a float that is not finite"));
    assert_eq!(refusal(&mut host, HostValue::UntypedNumber(f64::INFINITY)), message("a float that is not finite"));
    assert_eq!(refusal(&mut host, HostValue::Text(HostText::Utf16(vec![0xd800]))), message("a text that is no sequence of Unicode scalar values"));
    assert_eq!(refusal(&mut host, HostValue::Text(HostText::CodePoints(vec![0xd800]))), message("a text that is no sequence of Unicode scalar values"));
    assert_eq!(refusal(&mut host, HostValue::Undefined), message("an undefined value"));
    assert_eq!(refusal(&mut host, HostValue::Date(Handle::new(1))), message("a date of the language"));
    assert_eq!(refusal(&mut host, HostValue::Callable(Native::new(Kept))), message("a function"));
    let object = HostValue::Object { native: Native::new(Kept), type_name: "App\\Money".into(), json_serializable: false };
    assert_eq!(refusal(&mut host, object), message("an object of the language"));
    let plain = HostValue::PlainObject { handle: Handle::new(1), len: 0, prototype: Prototype::Object };
    assert_eq!(refusal(&mut host, plain), message("an object of the language"), "the map of a language is its map type");
    let json = HostValue::Value { kind: ValueKind::Nested(ValueType::Json), handle: Handle::new(1) };
    assert_eq!(refusal(&mut host, json), message("an object of the language"), "a json_value that enters is not implemented");
    let (handle, len) = host.entries(vec![(HostValue::Int(5), HostValue::Null)]);
    assert_eq!(refusal(&mut host, HostValue::Map { handle, len }), message("a map key that is no text"), "only a PHP array has integer keys");
    let (handle, len) = host.entries(vec![(HostValue::Text(HostText::Bytes(vec![0xff])), HostValue::Null)]);
    assert_eq!(refusal(&mut host, HostValue::PhpArray { handle, len, is_list: false }), message("a map key that is no text"));

    // 256 levels of lists are a value, and the list of level 257 is refused.
    let mut host = Host::default();
    let mut value = HostValue::Null;
    for _ in 0..256 {
        value = host.list(vec![value]);
    }
    assert!(from_host(&mut host, value.clone()).is_ok(), "256 levels");
    let deeper = host.list(vec![value]);
    assert_eq!(refusal(&mut host, deeper), message("a list or map nested deeper than 256 levels"));
}

// Requirements: CORE-60, CORE-64. A value leaves one level at a time: the integer kinds stay apart, and a JSON value
// is nested in the kinds of json_value, a number as its text and an object in member order.
#[test]
fn to_host_describes_a_value_one_level_at_a_time() {
    let _case = polyspec_orm_testcase::case!();
    assert_eq!(to_host(&OrmValue::Int(7)).0.kind(), ValueKind::Int);
    assert_eq!(to_host(&OrmValue::Int64(7)).0, OutValue::Int64(7));
    assert_eq!(to_host(&OrmValue::Text("t".into())).0, OutValue::Text("t".into()));
    assert_eq!(to_host(&OrmValue::Bytes(vec![0xff])).0.kind(), ValueKind::Bytes);
    assert_eq!(to_host(&OrmValue::Null).0, OutValue::Null);

    let value = OrmValue::Map([("row".to_owned(), OrmValue::List(vec![OrmValue::Int64(1), OrmValue::Float(0.5)]))].into());
    let (top, mut children) = to_host(&value);
    let OutValue::Map(map) = top else { panic!("a map") };
    assert_eq!((map.len(), map.sequence_keys()), (1, false));
    let (key, row) = children.entry(map.handle(), 0);
    assert_eq!(key, OutValue::Text("row".into()));
    let OutValue::List { handle, len } = row else { panic!("a list") };
    assert_eq!(len, 2);
    assert_eq!(children.item(handle, 0), OutValue::Int64(1));
    assert_eq!(children.item(handle, 1).kind(), ValueKind::Float);

    let json = polyspec_json::parse(br#"{"b": 1.50, "a": [true, null, "s"]}"#, &polyspec_json::ParseOptions::default()).expect("JSON");
    let value = OrmValue::Json(JsonValue::new(json).expect("a JSON value"));
    let (top, mut children) = to_host(&value);
    let OutValue::Nested { value_type: ValueType::Json, value: inner } = top else { panic!("a nested JSON value") };
    let OutValue::Map(map) = *inner else { panic!("a JSON object is a map") };
    assert_eq!(map.len(), 2);
    assert_eq!(children.entry(map.handle(), 0), (OutValue::Text("b".into()), OutValue::Number("1.50".into())), "member order and number text");
    let (key, array) = children.entry(map.handle(), 1);
    assert_eq!(key, OutValue::Text("a".into()));
    let OutValue::List { handle, len } = array else { panic!("a JSON array is a list") };
    assert_eq!(len, 3);
    assert_eq!(children.item(handle, 0), OutValue::Bool(true));
    assert_eq!(children.item(handle, 1), OutValue::Null);
    assert_eq!(children.item(handle, 2), OutValue::Text("s".into()));
}

// Requirements: CORE-82. The value of a condition is one value, the null of a condition, a list of values, the pair of
// a Between key or the value groups of a tuple key; any other value is codec_encode.
#[test]
fn a_condition_takes_a_value_by_its_operator() {
    let _case = polyspec_orm_testcase::case!();
    use crate::args::Value;
    use crate::core::Arg;
    use crate::value::Param;
    let one = |value: OrmValue, op: &str| value.into_arg(op).expect("a condition value");
    assert!(matches!(one(OrmValue::Int64(7), ""), Arg::Value(Value::One(Param::I64(7)))));
    assert!(matches!(one(OrmValue::Int(7), "gt"), Arg::Value(Value::One(Param::I64(7)))));
    assert!(matches!(one(OrmValue::Null, ""), Arg::Value(Value::Null)));
    let pair = OrmValue::List(vec![OrmValue::Int(1), OrmValue::Int(9)]);
    assert!(matches!(one(pair.clone(), "between"), Arg::Value(Value::Pair(Param::I64(1), Param::I64(9)))));
    assert!(matches!(one(pair.clone(), "ne"), Arg::Value(Value::List(list)) if list == [Param::I64(1), Param::I64(9)]));
    let groups = OrmValue::List(vec![pair.clone()]);
    assert!(matches!(one(groups.clone(), "tuple"), Arg::Tuples(rows) if rows == [vec![Param::I64(1), Param::I64(9)]]));
    let message = |value: OrmValue, op: &str| value.into_arg(op).err().expect("a refused condition value").to_string();
    assert_eq!(message(OrmValue::Map(IndexMap::new()), ""), "codec_encode: the value of a condition is a map");
    assert_eq!(message(groups, ""), "codec_encode: the value of a condition is a list inside a list");
    assert_eq!(message(OrmValue::List(vec![OrmValue::Int(1)]), "between"), "codec_encode: the value of a condition is no list of two values");
    assert_eq!(message(OrmValue::Int(1), "tuple"), "codec_encode: the value of a condition is no list of value groups");
    assert_eq!(message(pair, "tuple"), "codec_encode: the value of a condition is no list of value groups");
    let json = OrmValue::Json(JsonValue::new(polyspec_json::Value::null()).expect("a JSON value"));
    assert_eq!(message(json, ""), "codec_encode: the value of a condition is a JSON value");
}
