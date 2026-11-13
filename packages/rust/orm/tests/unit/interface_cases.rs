// The core runs the cases of its interface contract (CORE-70 to CORE-72): every group that `cases` of
// packages/rust/interface.json names in contracts/interface/core.json, in the case form of binding G-5. A member is
// called through `call`, the one table of this file from a member id to the core function that the contract names for
// it, so a member whose cases the contract names and that the table lacks fails the test.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::{AesKeyring, Config, Db, Error};

const CONTRACT: &str = include_str!("../../../interface.json");
const CASES: &str = include_str!("../../../../../contracts/interface/core.json");

/// An instance of a class unit that a case made.
enum Instance {
    Db(Db),
    Keyring(AesKeyring),
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
    u32::try_from(n).unwrap_or_else(|_| panic!("{member}: {name} {n} does not fit u32"))
}

fn int(value: &Value, what: &str) -> i32 {
    let n = value.as_i64().unwrap_or_else(|| panic!("{what} is no integer"));
    i32::try_from(n).unwrap_or_else(|_| panic!("{what} {n} does not fit i32"))
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
            usize::try_from(value.as_u64().unwrap_or_else(|| panic!("{what} is no unsigned integer"))).unwrap_or_else(|_| panic!("{what} does not fit usize"))
        };
        let ms =
            || u32::try_from(value.as_u64().unwrap_or_else(|| panic!("{what} is no unsigned integer"))).unwrap_or_else(|_| panic!("{what} does not fit u32"));
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

/// Calls the core function that the contract names for `member`.
async fn call(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
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

// Requirements: CORE-70, CORE-71, CORE-72.
#[tokio::test]
async fn the_core_passes_the_cases_of_its_contract() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let contract: Value = serde_json::from_str(CONTRACT).expect("packages/rust/interface.json is JSON");
    let cases: Value = serde_json::from_str(CASES).expect("contracts/interface/core.json is JSON");
    let rows = contract["cases"].as_array().expect("the contract has cases");
    assert!(!rows.is_empty(), "the contract names no cases");
    let mut ran = 0usize;
    for row in rows {
        let member = row["member"].as_str().expect("a row of cases names its member");
        assert_eq!(row["file"].as_str(), Some("contracts/interface/core.json"), "{member}: the case file that this test reads");
        let group = row["group"].as_str().expect("a row of cases names its group");
        let group = cases[group].as_array().unwrap_or_else(|| panic!("{member}: contracts/interface/core.json has no group {group}"));
        assert!(!group.is_empty(), "{member}: its group holds no case");
        for case in group {
            run_case(member, case).await;
            ran += 1;
        }
    }
    polyspec_orm_testcase::step(format_args!("ran {ran} cases of {} members", rows.len()));
}
