// The core runs the cases of its interface contract (CORE-70 to CORE-72): every group that `cases` of
// packages/rust/interface.json names in contracts/interface/core.json, in the case form of binding G-5. A member is
// called through `call`, the one table of this file from a member id to the core function that the contract names for
// it, so a member whose cases the contract names and that the table lacks fails the test. A value of orm_value is
// given as {kind, value} (binding GN-13) and enters through from_host, as it enters from a language.

use std::collections::BTreeMap;

use binding_core::{Failure, Handle, HostText, HostValue, HostValues, Raised};
use serde_json::{Map, Value};

use crate::or_panic::OrPanic as _;
use crate::{AesKeyring, Config, Db, Error, OrmValue, Query, Schema};

const CONTRACT: &str = include_str!("../../interface.json");
const CASES: &str = include_str!("../../../../contracts/interface/core.json");

/// An instance of a class unit that a case made.
enum Instance {
    Db(Db),
    Keyring(AesKeyring),
    Schema(Schema),
    Query(Box<Query>),
}

/// What a member returned: a value in its case form, or an instance.
enum Returned {
    Value(Value),
    Instance(Instance),
}

fn field<'a>(args: &'a Map<String, Value>, name: &str, member: &str) -> &'a Value {
    args.get(name).unwrap_or_else(|| panic!("{member}: the case gives no {name}"))
}

fn text(args: &Map<String, Value>, name: &str, member: &str) -> String {
    field(args, name, member).as_str().unwrap_or_else(|| panic!("{member}: {name} is no text")).to_owned()
}

fn uint(args: &Map<String, Value>, name: &str, member: &str) -> u32 {
    let n = field(args, name, member).as_u64().unwrap_or_else(|| panic!("{member}: {name} is no unsigned integer"));
    u32::try_from(n).or_panic(|error| format!("{member}: {name} {n} does not fit u32: {error}"))
}

fn int(value: &Value, what: &str) -> i32 {
    let n = value.as_i64().unwrap_or_else(|| panic!("{what} is no integer"));
    i32::try_from(n).or_panic(|error| format!("{what} {n} does not fit i32: {error}"))
}

/// A keyed map with the key kind `int` and text values: a list of `[{"int": n}, text]`.
fn keyed_texts(value: &Value, what: &str) -> BTreeMap<i32, String> {
    let rows = value.as_array().unwrap_or_else(|| panic!("{what} is no list of [key, value]"));
    rows.iter()
        .map(|row| {
            let pair = row.as_array().filter(|pair| pair.len() == 2).unwrap_or_else(|| panic!("{what} holds a row that is no [key, value]"));
            let key = pair[0].get("int").unwrap_or_else(|| panic!("{what} holds a key that is no {{int}}"));
            let value = pair[1].as_str().unwrap_or_else(|| panic!("{what} holds a value that is no text"));
            (int(key, what), value.to_owned())
        })
        .collect()
}

/// The record `config`: an absent field has the default of the contract.
fn config(value: &Value, member: &str) -> Config {
    let fields = value.as_object().unwrap_or_else(|| panic!("{member}: cfg is no record"));
    let mut cfg = Config::default();
    for (name, value) in fields {
        let what = format!("{member}: cfg.{name}");
        let size = || {
            usize::try_from(value.as_u64().unwrap_or_else(|| panic!("{what} is no unsigned integer")))
                .or_panic(|error| format!("{what} does not fit usize: {error}"))
        };
        let ms = || {
            u32::try_from(value.as_u64().unwrap_or_else(|| panic!("{what} is no unsigned integer")))
                .or_panic(|error| format!("{what} does not fit u32: {error}"))
        };
        match name.as_str() {
            "aes_key" => cfg.aes_key = value.as_str().unwrap_or_else(|| panic!("{what} is no text")).to_owned(),
            "blind_index_key" => cfg.blind_index_key = value.as_str().unwrap_or_else(|| panic!("{what} is no text")).to_owned(),
            "aes_version" => cfg.aes_version = int(value, &what),
            "aes_keys" => cfg.aes_keys = keyed_texts(value, &what),
            "plan_cache_size" => cfg.plan_cache_size = size(),
            "statement_cache_size" => cfg.statement_cache_size = size(),
            "statement_timeout_ms" => cfg.statement_timeout_ms = ms(),
            "pool_idle_size" => cfg.pool_idle_size = ms(),
            "pool_lifetime_ms" => cfg.pool_lifetime_ms = ms(),
            "pool_acquire_timeout_ms" => cfg.pool_acquire_timeout_ms = ms(),
            other => panic!("{member}: cfg has no field {other}"),
        }
    }
    cfg
}

/// The language of a case: it holds the lists and the maps of a case value by their handles.
#[derive(Default)]
struct CaseHost {
    lists: Vec<Vec<HostValue>>,
    maps: Vec<Vec<(HostValue, HostValue)>>,
}

fn handle(position: usize) -> Handle {
    Handle::new(u64::try_from(position).or_panic(|error| format!("a handle of a case value does not fit u64: {error}")))
}

fn position(handle: Handle, index: u64) -> (usize, usize) {
    let fits = |n: u64| usize::try_from(n).or_panic(|error| format!("a handle or an index of a case value does not fit usize: {error}"));
    (fits(handle.raw()), fits(index))
}

impl HostValues for CaseHost {
    fn item(&mut self, list: Handle, index: u64) -> Result<HostValue, Raised> {
        let (list, index) = position(list, index);
        Ok(self.lists[list][index].clone())
    }

    fn entry(&mut self, map: Handle, index: u64) -> Result<(HostValue, HostValue), Raised> {
        let (map, index) = position(map, index);
        Ok(self.maps[map][index].clone())
    }

    fn read(&mut self, _value: Handle) -> Result<HostValue, Raised> {
        panic!("a case value holds no object")
    }
}

fn host_text(text: &str) -> HostValue {
    HostValue::Text(HostText::CodePoints(text.chars().map(u32::from).collect()))
}

/// The language value of a case value `{kind, value}` (binding GN-13): each kind as the value that its built-in form
/// makes, an integer outside `i64` as its decimal text.
fn host_value(host: &mut CaseHost, case: &Value, what: &str) -> HostValue {
    let kind = case.get("kind").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: a value of orm_value states its kind"));
    let value = case.get("value");
    let given = || value.unwrap_or_else(|| panic!("{what}: a value of the kind {kind} states its value"));
    match kind {
        "null" => HostValue::Null,
        "bool" => HostValue::Bool(given().as_bool().unwrap_or_else(|| panic!("{what}: the value of a bool is no boolean"))),
        "int" => match (given().as_i64(), given().as_str()) {
            (Some(n), _) => HostValue::Int(n),
            (None, Some(digits)) => digits.parse().map_or_else(|_outside| HostValue::Number(digits.to_owned()), HostValue::Int),
            _ => panic!("{what}: the value of an int is no integer and no decimal text"),
        },
        "float" => HostValue::Float(given().as_f64().unwrap_or_else(|| panic!("{what}: the value of a float is no number"))),
        "text" => host_text(given().as_str().unwrap_or_else(|| panic!("{what}: the value of a text is no text"))),
        "bytes" => {
            let hex = given().get("hex").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: the value of bytes is {{hex}}"));
            assert!(hex.len() % 2 == 0 && hex.is_ascii(), "{what}: hex is pairs of digits");
            let byte = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).or_panic(|error| format!("{what}: hex holds no byte at {at}: {error}"));
            HostValue::Bytes((0..hex.len()).step_by(2).map(byte).collect())
        }
        "list" => {
            let items = given().as_array().unwrap_or_else(|| panic!("{what}: the value of a list is no list"));
            let items: Vec<HostValue> = items.iter().map(|item| host_value(host, item, what)).collect();
            let len = u64::try_from(items.len()).or_panic(|error| format!("{what}: the length of a list does not fit u64: {error}"));
            host.lists.push(items);
            HostValue::List { handle: handle(host.lists.len() - 1), len }
        }
        "map" => {
            let members = given().as_object().unwrap_or_else(|| panic!("{what}: the value of a map is no object"));
            let entries: Vec<(HostValue, HostValue)> = members.iter().map(|(key, member)| (host_text(key), host_value(host, member, what))).collect();
            let len = u64::try_from(entries.len()).or_panic(|error| format!("{what}: the length of a map does not fit u64: {error}"));
            host.maps.push(entries);
            HostValue::Map { handle: handle(host.maps.len() - 1), len }
        }
        other => panic!("{what}: the case runner makes no value of the kind {other}"),
    }
}

/// The `orm_value` of a case value, as `from_host` reads it.
fn orm_value(case: &Value, what: &str) -> Result<OrmValue, Error> {
    let mut host = CaseHost::default();
    let value = host_value(&mut host, case, what);
    match crate::orm_value::from_host(&mut host, value) {
        Ok(value) => Ok(value),
        Err(Failure::Kind(error)) => Err(error),
        Err(other) => panic!("{what}: from_host failed with no kind: {other}"),
    }
}

/// A list of `orm_value`.
fn orm_values(args: &Map<String, Value>, name: &str, member: &str) -> Result<Vec<OrmValue>, Error> {
    let values = field(args, name, member).as_array().unwrap_or_else(|| panic!("{member}: {name} is no list"));
    values.iter().map(|value| orm_value(value, member)).collect()
}

/// The case form `{kind, value}` of a value that a member returned.
fn case_value(value: &OrmValue, what: &str) -> Value {
    let of = |kind: &str, value: Value| serde_json::json!({"kind": kind, "value": value});
    match value {
        OrmValue::Null => serde_json::json!({"kind": "null"}),
        OrmValue::Bool(flag) => of("bool", Value::from(*flag)),
        OrmValue::Int(n) => of("int", Value::from(*n)),
        OrmValue::Int64(n) => of("int64", Value::from(*n)),
        OrmValue::Float(x) => of("float", Value::from(*x)),
        OrmValue::Text(text) => of("text", Value::from(text.as_str())),
        OrmValue::Bytes(bytes) => of("bytes", serde_json::json!({"hex": bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()})),
        OrmValue::List(items) => of("list", items.iter().map(|item| case_value(item, what)).collect()),
        OrmValue::Map(entries) => of("map", entries.iter().map(|(key, entry)| (key.clone(), case_value(entry, what))).collect::<Map<String, Value>>().into()),
        OrmValue::Json(_) => panic!("{what}: the case form has no value of json_value"),
    }
}

/// Calls the core function that the contract names for `member`.
async fn call(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
        ("schema.load", None) => Returned::Instance(Instance::Schema(Schema::load(
            &text(args, "manifest_text", member),
            &text(args, "external_text", member),
            &text(args, "manifest_hash", member),
        )?)),
        ("schema.hash", Some(Instance::Schema(schema))) => Returned::Value(Value::from(schema.hash())),
        ("query.new", None) => {
            let Instance::Schema(schema) = Box::pin(instance(field(args, "schema", member), member)).await else {
                panic!("{member}: schema is no instance of schema")
            };
            Returned::Instance(Instance::Query(Box::new(Query::new(&schema, &text(args, "entity", member))?)))
        }
        ("query.entity", Some(Instance::Query(query))) => Returned::Value(Value::from(query.entity())),
        ("query.order_by", Some(Instance::Query(query))) => {
            query.order_by(&text(args, "spec", member));
            Returned::Value(Value::Null)
        }
        ("query.for_update", Some(Instance::Query(query))) => {
            query.for_update();
            Returned::Value(Value::Null)
        }
        ("query.for_share", Some(Instance::Query(query))) => {
            query.for_share();
            Returned::Value(Value::Null)
        }
        ("query.for_update_no_wait", Some(Instance::Query(query))) => {
            query.for_update_no_wait();
            Returned::Value(Value::Null)
        }
        ("query.for_share_no_wait", Some(Instance::Query(query))) => {
            query.for_share_no_wait();
            Returned::Value(Value::Null)
        }
        ("query.add_all_columns", Some(Instance::Query(query))) => {
            query.add_all_columns();
            Returned::Value(Value::Null)
        }
        ("query.remove_all_columns", Some(Instance::Query(query))) => {
            query.remove_all_columns();
            Returned::Value(Value::Null)
        }
        ("query.add_column", Some(Instance::Query(query))) => {
            query.add_column(&text(args, "column", member));
            Returned::Value(Value::Null)
        }
        ("query.remove_column", Some(Instance::Query(query))) => {
            query.remove_column(&text(args, "column", member));
            Returned::Value(Value::Null)
        }
        ("query.match_pair", Some(Instance::Query(query))) => {
            query.match_pair(&text(args, "pair", member));
            Returned::Value(Value::Null)
        }
        ("query.alias", Some(Instance::Query(query))) => {
            query.alias(&text(args, "name", member));
            Returned::Value(Value::Null)
        }
        ("query.relation", Some(Instance::Query(query))) => match Box::pin(instance(field(args, "child", member), member)).await {
            Instance::Query(child) => {
                query.relation(*child);
                Returned::Value(Value::Null)
            }
            _ => panic!("{member}: child is no query"),
        },
        ("query.relations", Some(Instance::Query(query))) => match Box::pin(instance(field(args, "child", member), member)).await {
            Instance::Query(child) => {
                query.relations(*child);
                Returned::Value(Value::Null)
            }
            _ => panic!("{member}: child is no query"),
        },
        ("query.related", Some(Instance::Query(query))) => match query.related(&text(args, "name", member))? {
            Some(row) => Returned::Instance(Instance::Query(Box::new(row))),
            None => Returned::Value(Value::Null),
        },
        ("query.related_rows", Some(Instance::Query(query))) => match query.related_rows(&text(args, "name", member))? {
            Some(rows) => panic!("{member}: the case runner observes no list of {} rows", rows.len()),
            None => Returned::Value(Value::Null),
        },
        ("query.key_name", Some(Instance::Query(query))) => {
            query.key_name(&text(args, "column", member));
            Returned::Value(Value::Null)
        }
        ("query.where_in", Some(Instance::Query(query))) => match Box::pin(instance(field(args, "query", member), member)).await {
            Instance::Query(sub) => {
                query.where_in(&text(args, "chain", member), *sub);
                Returned::Value(Value::Null)
            }
            _ => panic!("{member}: query is no query"),
        },
        ("query.set", Some(Instance::Query(query))) => {
            query.set(&text(args, "column", member), orm_value(field(args, "value", member), member)?);
            Returned::Value(Value::Null)
        }
        ("query.expect_revision", Some(Instance::Query(query))) => {
            let revision = field(args, "revision", member).as_i64().unwrap_or_else(|| panic!("{member}: revision is no integer"));
            query.expect_revision(&text(args, "column", member), revision);
            Returned::Value(Value::Null)
        }
        ("query.create", Some(Instance::Query(query))) => Returned::Instance(Instance::Query(Box::new(query.create().await?))),
        ("query.restore", Some(Instance::Query(query))) => Returned::Instance(Instance::Query(Box::new(query.restore().await?))),
        ("query.restore_or_create", Some(Instance::Query(query))) => Returned::Instance(Instance::Query(Box::new(query.restore_or_create().await?))),
        ("query.update", Some(Instance::Query(query))) => {
            query.update().await?;
            Returned::Value(Value::Null)
        }
        ("query.delete", Some(Instance::Query(query))) => {
            query.delete().await?;
            Returned::Value(Value::Null)
        }
        ("query.limit", Some(Instance::Query(query))) => {
            query.limit(uint(args, "offset", member), uint(args, "count", member));
            Returned::Value(Value::Null)
        }
        ("query.get_count", Some(Instance::Query(query))) => Returned::Value(Value::from(query.get_count().await?)),
        ("query.where", Some(Instance::Query(query))) => {
            query.where_chain(&text(args, "chain", member), orm_values(args, "values", member)?);
            Returned::Value(Value::Null)
        }
        ("query.value", Some(Instance::Query(query))) => Returned::Value(case_value(&query.value(&text(args, "column", member))?, member)),
        ("query.get_by", Some(Instance::Query(query))) => match query.get_by(&text(args, "chain", member), orm_values(args, "values", member)?).await? {
            Some(row) => Returned::Instance(Instance::Query(Box::new(row))),
            None => Returned::Value(Value::Null),
        },
        ("query.get_count_by", Some(Instance::Query(query))) => {
            Returned::Value(Value::from(query.get_count_by(&text(args, "chain", member), orm_values(args, "values", member)?).await?))
        }
        ("db.connect", None) => Returned::Instance(Instance::Db(
            Db::connect(&text(args, "dsn", member), uint(args, "pool_size", member), config(field(args, "cfg", member), member)).await?,
        )),
        ("aes_keyring.constructor", None) => Returned::Instance(Instance::Keyring(AesKeyring::new(
            keyed_texts(field(args, "keys", member), member),
            int(field(args, "current", member), member),
        )?)),
        ("aes_keyring.current", Some(Instance::Keyring(keyring))) => Returned::Value(Value::from(keyring.current())),
        ("aes_keyring.versions", Some(Instance::Keyring(keyring))) => Returned::Value(Value::from(keyring.versions())),
        (other, Some(_)) => panic!("the case runner calls no member {other} on that receiver"),
        (other, None) => panic!("the case runner calls no member {other} without a receiver"),
    })
}

/// An instance value of a case: `{new, args, then}` (binding G-5).
async fn instance(value: &Value, what: &str) -> Instance {
    let made = value.as_object().unwrap_or_else(|| panic!("{what}: an instance value is an object"));
    let member = made.get("new").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: an instance value names its member in new"));
    let empty = Map::new();
    let args = made.get("args").map_or(&empty, |args| args.as_object().unwrap_or_else(|| panic!("{what}: args is no object")));
    let mut out = match call(member, None, args).await {
        Ok(Returned::Instance(instance)) => instance,
        Ok(Returned::Value(_)) => panic!("{what}: {member} returns no instance"),
        Err(error) => panic!("{what}: the preparation {member} failed: {error}"),
    };
    for step in made.get("then").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
        let name = step.get("call").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: a then step names its member in call"));
        let args = step.get("args").map_or(&empty, |args| args.as_object().unwrap_or_else(|| panic!("{what}: args of {name} is no object")));
        if let Err(error) = call(name, Some(&mut out), args).await {
            panic!("{what}: the preparation {name} failed: {error}");
        }
    }
    out
}

/// The keys of a case that are no parameter of its member (binding G-5).
const RESERVED: [&str; 8] = ["id", "note", "rule", "raises", "result", "receiver", "after", "faults"];

async fn run_case(member: &str, case: &Value) {
    let fields = case.as_object().unwrap_or_else(|| panic!("{member}: a case is an object"));
    let id = fields.get("id").and_then(Value::as_str).unwrap_or_else(|| panic!("{member}: a case has an id"));
    let what = format!("{member} {id}");
    assert!(fields.get("rule").and_then(Value::as_str).is_some_and(|rule| !rule.is_empty()), "{what}: the case names its rule");
    let args: Map<String, Value> =
        fields.iter().filter(|(name, _)| !RESERVED.contains(&name.as_str())).map(|(name, value)| (name.clone(), value.clone())).collect();
    let mut receiver = match fields.get("receiver") {
        Some(value) => Some(instance(value, &what).await),
        None => None,
    };
    let outcome = call(member, receiver.as_mut(), &args).await;
    let mut result = None;
    match (outcome, fields.get("raises")) {
        (Err(error), Some(raises)) => {
            assert_eq!(raises.get("kind").and_then(Value::as_str), Some(error.kind().as_str()), "{what}: kind of {error}");
            assert_eq!(raises.get("category").and_then(Value::as_str), Some(error.category().as_str()), "{what}: category of {error}");
            assert_eq!(raises.get("message").and_then(Value::as_str), Some(error.to_string().as_str()), "{what}: message");
        }
        (Err(error), None) => panic!("{what}: failed with {error}"),
        (Ok(_), Some(raises)) => panic!("{what}: succeeded, and the case expects {raises}"),
        (Ok(Returned::Value(value)), None) => {
            let expected = fields.get("result").unwrap_or_else(|| panic!("{what}: the case states no result"));
            assert_eq!(&value, expected, "{what}: result");
        }
        (Ok(Returned::Instance(instance)), None) => {
            assert!(fields.get("result").is_none(), "{what}: a class result is observed by after, not by result");
            result = Some(instance);
        }
    }
    let after = fields.get("after").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    assert!(result.is_none() || !after.is_empty(), "{what}: the case observes nothing of the instance it made");
    let empty = Map::new();
    for step in after {
        let on = step.get("on").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: an after step names on"));
        let name = step.get("call").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: an after step names call"));
        let args = step.get("args").map_or(&empty, |args| args.as_object().unwrap_or_else(|| panic!("{what}: args of {name} is no object")));
        let target = match on {
            "receiver" => receiver.as_mut(),
            "result" => result.as_mut(),
            other => panic!("{what}: the case runner observes no {other}"),
        };
        let target = target.unwrap_or_else(|| panic!("{what}: the case has no {on} to observe"));
        match call(name, Some(target), args).await {
            Ok(Returned::Value(value)) => assert_eq!(Some(&value), step.get("result"), "{what}: after {name}"),
            Ok(Returned::Instance(_)) => panic!("{what}: after {name} returns an instance"),
            Err(error) => panic!("{what}: after {name} failed: {error}"),
        }
    }
    for made in [receiver, result].into_iter().flatten() {
        if let Instance::Db(db) = made {
            db.close().await;
        }
    }
}

/// A case of the alias `orm_value` (binding CK-22, U-7): `{id, value, raises}`, a value that `from_host` refuses.
fn run_alias_case(case: &Value) {
    let fields = case.as_object().unwrap_or_else(|| panic!("orm_value: a case is an object"));
    let id = fields.get("id").and_then(Value::as_str).unwrap_or_else(|| panic!("orm_value: a case has an id"));
    let what = format!("orm_value {id}");
    assert!(fields.get("rule").and_then(Value::as_str).is_some_and(|rule| !rule.is_empty()), "{what}: the case names its rule");
    for key in fields.keys() {
        assert!(["id", "note", "rule", "value", "raises"].contains(&key.as_str()), "{what}: a case of an alias has no key {key}");
    }
    let value = fields.get("value").unwrap_or_else(|| panic!("{what}: the case gives its value"));
    let raises = fields.get("raises").unwrap_or_else(|| panic!("{what}: the case raises a kind"));
    match orm_value(value, &what) {
        Ok(value) => panic!("{what}: from_host took the value as {value:?}"),
        Err(error) => {
            assert_eq!(raises.get("kind").and_then(Value::as_str), Some(error.kind().as_str()), "{what}: kind of {error}");
            assert_eq!(raises.get("category").and_then(Value::as_str), Some(error.category().as_str()), "{what}: category of {error}");
            assert_eq!(raises.get("message").and_then(Value::as_str), Some(error.to_string().as_str()), "{what}: message");
        }
    }
}

// Requirements: CORE-62, CORE-63, CORE-70, CORE-71, CORE-72.
#[tokio::test]
async fn the_core_passes_the_cases_of_its_contract() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let contract: Value = serde_json::from_str(CONTRACT).expect("packages/rust/interface.json is JSON");
    let cases: Value = serde_json::from_str(CASES).expect("contracts/interface/core.json is JSON");
    let rows = contract["cases"].as_array().expect("the contract has cases");
    assert!(!rows.is_empty(), "the contract names no cases");
    let mut ran = 0usize;
    let mut members = 0usize;
    for row in rows {
        assert_eq!(row["file"].as_str(), Some("contracts/interface/core.json"), "{row}: the case file that this test reads");
        let name = row["group"].as_str().expect("a row of cases names its group");
        let group = cases[name].as_array().unwrap_or_else(|| panic!("contracts/interface/core.json has no group {name}"));
        assert!(!group.is_empty(), "the group {name} holds no case");
        match (row["member"].as_str(), row["alias"].as_str()) {
            (Some(member), None) => {
                members += 1;
                for case in group {
                    run_case(member, case).await;
                    ran += 1;
                }
            }
            (None, Some("orm_value")) => {
                for case in group {
                    run_alias_case(case);
                    ran += 1;
                }
            }
            _ => panic!("{row}: a row of cases names a member, or the alias orm_value"),
        }
    }
    polyspec_orm_testcase::step(format_args!("ran {ran} cases of {members} members and the alias orm_value"));
}
