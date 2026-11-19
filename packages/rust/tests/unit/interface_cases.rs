// The core runs the cases of its interface contract (CORE-70 to CORE-72): every group that `cases` of
// packages/rust/interface.json names in contracts/interface/core.json, in the case form of binding G-5. A member is
// called through `call`, the one table of this file from a member id to the core function that the contract names for
// it, so a member whose cases the contract names and that the table lacks fails the test. A value of orm_value is
// given as {kind, value} (binding GN-13) and enters through from_host, as it enters from a language.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use binding_core::{Failure, Handle, HostText, HostValue, HostValues, IntOut, OrderedMap, Raised, ValueKind};
use serde_json::{Map, Value};

use crate::or_panic::OrPanic as _;
use crate::test_support::Scratch;
use crate::{
    AesKeyring, AesUtils, BeforeTransaction, BeforeTransactionHook, BytesValue, Config, Connection, Db, Error, FloatValue, IntegerValue, Isolation, Manifest,
    MapValue, OrmValue, PrivilegeUtils, Query, RequestChange, Rows, Schema, SchemaUtils, StepRunner, TransactionOptions, Tx, Utils,
};

const CONTRACT: &str = include_str!("../../interface.json");
const CASES: &str = include_str!("../../../../contracts/interface/core.json");

/// An instance of a class unit that a case made.
enum Instance {
    Db(Db),
    Hook(BeforeTransactionHook),
    Tx(Tx),
    Utils(Utils),
    SchemaUtils(SchemaUtils),
    PrivilegeUtils(PrivilegeUtils),
    AesUtils(AesUtils),
    Runner(Box<StepRunner>),
    Keyring(AesKeyring),
    Schema(Schema),
    Query(Box<Query>),
    Page(Box<crate::QueryPage>),
    Rows(Box<Rows>),
    LookaheadPage(Box<crate::QueryLookaheadPage>),
    GroupPage(Box<crate::GroupLookaheadRows>),
    Model(Box<Manifest>),
    Integer(IntegerValue),
    Float(FloatValue),
    Bytes(BytesValue),
    Map(MapValue),
}

/// What a member returned: a value in its case form, an instance, or the instances of a list that is not empty.
enum Returned {
    Value(Value),
    Instance(Instance),
    Instances(Vec<Instance>),
}

fn field<'a>(args: &'a Map<String, Value>, name: &str, member: &str) -> &'a Value {
    args.get(name).unwrap_or_else(|| panic!("{member}: the case gives no {name}"))
}

thread_local! {
    /// The directory of the case that runs on this thread (binding GN-6y, GN-13i, GN-13l): the files of `@files`, a value
    /// of `path` and a part `case_path` of a composed text resolve in it.
    static ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    /// The databases that the case opened, which the case closes when it ends.
    static OPENED: RefCell<Vec<Db>> = const { RefCell::new(Vec::new()) };
    /// The named instances of the case (binding GN-13pa): the values of `with` and the arguments that `names` of a function
    /// fixture names, which a step calls with `"on": "<name>"` and gives as `{"bound": "<name>"}`.
    static NAMED: RefCell<BTreeMap<String, Instance>> = const { RefCell::new(BTreeMap::new()) };
    /// The arguments that a function fixture named and kept when it returned, which a call of `after` calls with
    /// `"on": "<name>"` (binding GN-13o).
    static KEPT: RefCell<BTreeMap<String, Instance>> = const { RefCell::new(BTreeMap::new()) };
    /// The functions that the core keeps and that the case gave by their rows (binding GN-6z), which the case reads when
    /// it ends.
    static KEPT_FUNCTIONS: RefCell<Vec<Arc<KeptFunction>>> = const { RefCell::new(Vec::new()) };
}

/// A row of a function that the core keeps: the arguments by their positions, whether it answers one call, and how many
/// calls it answered.
struct KeptRow {
    args: Value,
    once: bool,
    answered: u32,
}

/// A function of a case that the core keeps, `{"function": [<row>]}` (binding GN-6z, CK-22): a call takes the first row
/// that is left and whose arguments equal its own, and a row with `once` answers one call. A call that no row answers is
/// recorded and fails. The case fails when such a call is recorded, as a generated test requires, and also when a row
/// with `once` answered no call, which this runner requires so that a case shows that the core called the function
/// (CORE-143).
struct KeptFunction {
    what: String,
    rows: Mutex<Vec<KeptRow>>,
    unanswered: Mutex<Vec<String>>,
}

impl KeptFunction {
    /// The rows of the function value `value`, whose function returns none.
    fn new(value: &Value, what: &str) -> Arc<Self> {
        let rows = value
            .as_object()
            .filter(|fields| fields.len() == 1)
            .and_then(|fields| fields.get("function"))
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("{what}: a function that the core keeps is {{\"function\": [<row>]}}"));
        let rows = rows
            .iter()
            .map(|row| {
                let fields = row.as_object().unwrap_or_else(|| panic!("{what}: a row of a function is an object"));
                for key in fields.keys() {
                    assert!(["args", "result", "once"].contains(&key.as_str()), "{what}: a row of a function has no key {key}");
                }
                assert!(fields.get("result").is_none_or(Value::is_null), "{what}: the function returns none, so a row states no result");
                let args = fields.get("args").cloned().unwrap_or_else(|| Value::Object(Map::new()));
                KeptRow { args, once: fields.get("once") == Some(&Value::Bool(true)), answered: 0 }
            })
            .collect();
        let function = Arc::new(Self { what: what.to_owned(), rows: Mutex::new(rows), unanswered: Mutex::new(Vec::new()) });
        KEPT_FUNCTIONS.with_borrow_mut(|kept| kept.push(Arc::clone(&function)));
        function
    }

    /// Answers a call with the arguments `args`, or records it and fails.
    fn answer(&self, args: &Value) -> Result<(), Failure<Error>> {
        let mut rows = self.rows.lock().expect("the rows of a function of a case");
        if let Some(row) = rows.iter_mut().find(|row| &row.args == args && !(row.once && row.answered > 0)) {
            row.answered += 1;
            return Ok(());
        }
        self.unanswered.lock().expect("the calls that no row answers").push(args.to_string());
        Err(Failure::Kind(Error::config(format!("{}: no row of the function answers the call {args}", self.what))))
    }

    /// What the case did not expect of the function: each call that no row answered and each row with `once` that
    /// answered none.
    fn failures(&self) -> Vec<String> {
        let mut failures: Vec<String> = self
            .unanswered
            .lock()
            .expect("the calls that no row answers")
            .iter()
            .map(|call| format!("{}: no row of the function answers the call {call}", self.what))
            .collect();
        for row in self.rows.lock().expect("the rows of a function of a case").iter().filter(|row| row.once && row.answered == 0) {
            failures.push(format!("{}: the row {} with once answered no call", self.what, row.args));
        }
        failures
    }
}

/// The hook before a transaction of a case (CORE-143): the function of its rows, which gets `read_only` at the position 0.
fn before_transaction_hook(value: &Value, what: &str) -> BeforeTransaction {
    let function = KeptFunction::new(value, what);
    Box::new(move |read_only| function.answer(&serde_json::json!({"0": read_only})))
}

/// The request text hook of a case (CORE-70): the function of its rows, which gets the request text at the position 0 and
/// the parameters at the position 1, and returns the request and the parameters as it got them.
fn request_text_hook(value: &Value, what: &str) -> impl Fn(&str, &[OrmValue]) -> Result<RequestChange, Failure<Error>> + Send + Sync + 'static {
    let function = KeptFunction::new(value, what);
    let what = what.to_owned();
    move |request, params| {
        let values: Vec<Value> = params.iter().map(|param| case_value(param, &what)).collect();
        function.answer(&serde_json::json!({"0": request, "1": values}))?;
        Ok(RequestChange { request: request.to_owned(), params: params.to_vec() })
    }
}

/// Another handle of a named instance for an argument `{"bound"}`: a database and a transaction handle share their state, and
/// a query is copied.
fn share(instance: &Instance, what: &str) -> Instance {
    match instance {
        Instance::Db(db) => Instance::Db(db.clone()),
        Instance::Tx(tx) => Instance::Tx(tx.clone()),
        Instance::Query(query) => Instance::Query(query.clone()),
        _ => panic!("{what}: a named instance is a db, a tx or a query"),
    }
}

/// The instance that the name `name` holds (binding GN-13pa).
fn bound(name: &str, what: &str) -> Instance {
    NAMED.with_borrow(|named| named.get(name).map(|instance| share(instance, what))).unwrap_or_else(|| panic!("{what}: no instance is named {name}"))
}

/// Gives the name `name` to `instance`; a name is snake_case, never `receiver`, and given once (binding GN-13pa).
fn name(name: &str, instance: Instance, what: &str) {
    assert!(
        !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') && name != "receiver",
        "{what}: the name {name} is snake_case and not receiver"
    );
    let given = NAMED.with_borrow_mut(|named| named.insert(name.to_owned(), instance));
    assert!(given.is_none(), "{what}: the name {name} is given once");
}

/// Calls `member` on the named instance `on`. The instance leaves its name for the call and takes it again after it, so
/// what the call changes in it stays: a query is a value, while a database and a transaction handle share their state.
async fn call_on(on: &str, member: &str, args: &Map<String, Value>, what: &str) -> Result<Returned, Error> {
    let query = NAMED.with_borrow(|named| matches!(named.get(on), Some(Instance::Query(_))));
    if !query {
        // A database or a transaction handle stays named while it is called, so a callback of the call can call it again.
        return Box::pin(call(member, Some(&mut bound(on, what)), args)).await;
    }
    let mut target = NAMED.with_borrow_mut(|named| named.remove(on)).unwrap_or_else(|| panic!("{what}: no instance is named {on}"));
    let returned = Box::pin(call(member, Some(&mut target), args)).await;
    NAMED.with_borrow_mut(|named| named.insert(on.to_owned(), target));
    returned
}

/// Compares the kind that a step raised with the `raises` of the step, whose given fields the raise holds (binding GN-13o).
fn step_raised(step: &str, raises: &Value, error: &Error, what: &str) -> Option<String> {
    let raised = serde_json::json!({"kind": error.kind().as_str(), "category": error.category().as_str(), "message": error.to_string()});
    let expected = raises.as_object().unwrap_or_else(|| panic!("{what}: raises of the step {step} is an object"));
    (!expected.iter().all(|(key, value)| raised.get(key) == Some(value))).then(|| format!("{what}: the step {step} expects {raises}, and it raised {raised}"))
}

/// The directory of the case that runs.
fn root(what: &str) -> PathBuf {
    ROOT.with_borrow(|root| root.clone()).unwrap_or_else(|| panic!("{what}: no case directory is set"))
}

/// A relative path of a case (binding GN-6y) inside the directory of the case.
fn case_path(relative: &str, what: &str) -> PathBuf {
    assert!(
        !relative.is_empty() && !relative.starts_with('/') && relative.split('/').all(|part| !part.is_empty() && part != ".."),
        "{what}: {relative} is no relative path of a case"
    );
    if relative == "." {
        root(what)
    } else {
        root(what).join(relative)
    }
}

/// A text of a case: a plain text, or the composed form of binding GN-13l, `{"text": [<literal>, {"case_path": <relative>,
/// "as": "json-string"}, ..]}`, whose path parts resolve in the directory of the case.
fn case_text(value: &Value, what: &str) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let fields = value.as_object()?;
    let parts = fields.get("text").and_then(Value::as_array).filter(|parts| fields.len() == 1 && !parts.is_empty())?;
    let mut out = String::new();
    for part in parts {
        if let Some(literal) = part.as_str() {
            out.push_str(literal);
            continue;
        }
        let path = part.as_object().unwrap_or_else(|| panic!("{what}: a part of a composed text is a text or a path object"));
        let relative = path.get("case_path").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: a path object names case_path"));
        let resolved = case_path(relative, what);
        let resolved = resolved.to_str().unwrap_or_else(|| panic!("{what}: the directory of the case is no Unicode text")).to_owned();
        match path.get("as").map(|mode| mode.as_str()) {
            None => out.push_str(&resolved),
            Some(Some("json-string")) => out.push_str(&serde_json::to_string(&resolved).or_panic(|error| format!("{what}: {error}"))),
            Some(other) => panic!("{what}: a path object has no mode {other:?}"),
        }
    }
    Some(out)
}

fn text(args: &Map<String, Value>, name: &str, member: &str) -> String {
    case_text(field(args, name, member), member).unwrap_or_else(|| panic!("{member}: {name} is no text"))
}

fn uint(args: &Map<String, Value>, name: &str, member: &str) -> u32 {
    let n = field(args, name, member).as_u64().unwrap_or_else(|| panic!("{member}: {name} is no unsigned integer"));
    u32::try_from(n).or_panic(|error| format!("{member}: {name} {n} does not fit u32: {error}"))
}

fn int(value: &Value, what: &str) -> i32 {
    let n = value.as_i64().unwrap_or_else(|| panic!("{what} is no integer"));
    i32::try_from(n).or_panic(|error| format!("{what} {n} does not fit i32: {error}"))
}

/// A signed 64-bit case value: decimal text when it is outside the safe native-number range (binding G-5).
fn int64(value: &Value, what: &str) -> i64 {
    let Some(value) = value.as_i64() else { panic!("{what}: the value is no JSON integer of int64") };
    value
}

fn returned_integer(value: i64) -> Value {
    if IntOut::new(value).safe_integer() {
        Value::from(value)
    } else {
        Value::from(value.to_string())
    }
}

/// A list of texts.
fn texts(args: &Map<String, Value>, name: &str, member: &str) -> Vec<String> {
    let items = field(args, name, member).as_array().unwrap_or_else(|| panic!("{member}: {name} is no list"));
    items.iter().map(|item| item.as_str().unwrap_or_else(|| panic!("{member}: {name} holds an item that is no text")).to_owned()).collect()
}

/// Bytes, given as `{hex}`.
fn bytes(args: &Map<String, Value>, name: &str, member: &str) -> Vec<u8> {
    let hex = field(args, name, member).get("hex").and_then(Value::as_str).unwrap_or_else(|| panic!("{member}: {name} is no {{hex}}"));
    assert!(hex.len().is_multiple_of(2) && hex.is_ascii(), "{member}: {name} is pairs of digits");
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).or_panic(|error| format!("{member}: {name} holds no byte at {at}: {error}")))
        .collect()
}

/// A text that a member may not return: `null` for none.
fn optional_text(text: Option<impl Into<String>>) -> Value {
    text.map_or(Value::Null, |text| Value::from(text.into()))
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
            "aes_key" => cfg.aes_key = Some(value.as_str().unwrap_or_else(|| panic!("{what} is no text")).to_owned()),
            "blind_index_key" => cfg.blind_index_key = Some(value.as_str().unwrap_or_else(|| panic!("{what} is no text")).to_owned()),
            "aes_version" => cfg.aes_version = Some(int(value, &what)),
            "aes_keys" => {
                let mut keys = binding_core::KeyedMap::new();
                for (version, key) in keyed_texts(value, &what) {
                    keys.insert(binding_core::Key::Int(i64::from(version)), key);
                }
                cfg.aes_keys = Some(keys);
            }
            "plan_cache_size" => cfg.plan_cache_size = Some(size()),
            "statement_cache_size" => cfg.statement_cache_size = Some(size()),
            "statement_timeout_ms" => cfg.statement_timeout_ms = Some(ms()),
            "pool_idle_size" => cfg.pool_idle_size = Some(ms()),
            "pool_lifetime_ms" => cfg.pool_lifetime_ms = Some(ms()),
            "pool_acquire_timeout_ms" => cfg.pool_acquire_timeout_ms = Some(ms()),
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
    values: Vec<HostValue>,
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

    fn read(&mut self, value: Handle) -> Result<HostValue, Raised> {
        Ok(self.values[position(value, 0).0].clone())
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
        "int" | "int64" => {
            let value = match (given().as_i64(), given().as_str()) {
                (Some(n), _) => HostValue::Int(n),
                (None, Some(digits)) => digits.parse().map_or_else(|_outside| HostValue::Number(digits.to_owned()), HostValue::Int),
                _ => panic!("{what}: the value of an integer is no integer and no decimal text"),
            };
            if kind == "int" && matches!(value, HostValue::Int(_)) {
                host.values.push(value);
                HostValue::Value { kind: ValueKind::Int, handle: handle(host.values.len() - 1) }
            } else {
                value
            }
        }
        "float" => HostValue::Float(given().as_f64().unwrap_or_else(|| panic!("{what}: the value of a float is no number"))),
        "text" => host_text(given().as_str().unwrap_or_else(|| panic!("{what}: the value of a text is no text"))),
        "bytes" => {
            let hex = given().get("hex").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: the value of bytes is {{hex}}"));
            assert!(hex.len().is_multiple_of(2) && hex.is_ascii(), "{what}: hex is pairs of digits");
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
            // The value of a map is a list of [key, value] pairs in order, a key being a text (binding GN-13).
            let pairs = given().as_array().unwrap_or_else(|| panic!("{what}: the value of a map is no list of [key, value] pairs"));
            let entries: Vec<(HostValue, HostValue)> = pairs
                .iter()
                .map(|pair| match pair.as_array().map(Vec::as_slice) {
                    Some([Value::String(key), member]) => (host_text(key), host_value(host, member, what)),
                    _ => panic!("{what}: an entry of a map is {pair}, not [key, value] with a text key"),
                })
                .collect();
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
        OrmValue::Int(n) => of("int", returned_integer(*n)),
        OrmValue::Int64(n) => of("int64", returned_integer(*n)),
        OrmValue::Float(x) => of("float", Value::from(*x)),
        OrmValue::Text(text) => of("text", Value::from(text.as_str())),
        OrmValue::Bytes(bytes) => of("bytes", serde_json::json!({"hex": bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()})),
        OrmValue::List(items) => of("list", items.iter().map(|item| case_value(item, what)).collect()),
        OrmValue::Map(entries) => of("map", entries.iter().map(|(key, entry)| serde_json::json!([key, case_value(entry, what)])).collect()),
        OrmValue::Json(_) => panic!("{what}: the case form has no value of json_value"),
    }
}

/// The case form of a map of `orm_value` that a member returned: an object of its entries.
fn case_map(entries: &OrderedMap<OrmValue>, what: &str) -> Value {
    entries.iter().map(|(key, value)| (key.to_owned(), case_value(value, what))).collect::<Map<String, Value>>().into()
}

/// A row that a member may not return: `null` for none.
fn optional_row(row: Option<Query>) -> Returned {
    row.map_or(Returned::Value(Value::Null), |row| Returned::Instance(Instance::Query(Box::new(row))))
}

/// A connection of a case: an instance value of `db`, or of `tx` (the interface `connection`).
async fn connection(value: &Value, what: &str) -> Connection {
    match Box::pin(instance(value, what)).await {
        Instance::Db(db) => Connection::Db(db),
        Instance::Tx(tx) => Connection::Tx(tx),
        _ => panic!("{what}: the connection is no db and no tx"),
    }
}

/// The record `transaction_options`: each field has a default and may be left out or null (CORE-20, INT-40 to INT-43), and
/// so may the record, which is then `None`.
fn transaction_options(value: Option<&Value>, member: &str) -> TransactionOptions {
    let Some(value) = value else { return TransactionOptions::default() };
    let fields = value.as_object().unwrap_or_else(|| panic!("{member}: options is no record"));
    for name in fields.keys() {
        assert!(["isolation", "read_only", "timeout_ms", "retry", "audit"].contains(&name.as_str()), "{member}: options has no field {name}");
    }
    let given = |name: &str| fields.get(name).cloned().unwrap_or(Value::Null);
    let isolation = match given("isolation").as_str() {
        None => None,
        Some("read_uncommitted") => Some(Isolation::ReadUncommitted),
        Some("read_committed") => Some(Isolation::ReadCommitted),
        Some("repeatable_read") => Some(Isolation::RepeatableRead),
        Some("serializable") => Some(Isolation::Serializable),
        Some(other) => panic!("{member}: {other} is no isolation"),
    };
    let ms = given("timeout_ms").as_u64();
    let retry = given("retry").as_u64().map(|n| u32::try_from(n).or_panic(|error| format!("{member}: retry {n} does not fit u32: {error}")));
    // The cases give no audit values (INT-44): an audit of a case is null.
    assert!(given("audit").is_null(), "{member}: options gives audit values, which no case of the core reads");
    TransactionOptions { isolation, read_only: given("read_only").as_bool(), timeout_ms: ms, retry, audit: None }
}

/// The message of the failure of a function fixture with `"raise": "exception"`, which the case expects by `raises: "callback"`.
const CALLBACK_RAISED: &str = "the function of the case raised";

/// Runs a function fixture of a case (binding GN-6z): each step on the argument at its position, then the result or the raise.
async fn run_function(fixture: Value, argument: Instance, what: String) -> Result<Value, Error> {
    let function = fixture.get("function").and_then(Value::as_object).unwrap_or_else(|| panic!("{what}: a function value is {{function}}"));
    let mut argument = argument;
    let empty = Map::new();
    // names gives the argument its name, which an inner function fixture calls (binding GN-13n); the name ends with the
    // function, which keeps the argument for the calls of after (GN-13o).
    let names: Vec<String> = function
        .get("names")
        .and_then(Value::as_array)
        .map_or(Vec::new(), |names| names.iter().map(|name| name.as_str().unwrap_or_else(|| panic!("{what}: a name of names is a text")).to_owned()).collect());
    assert!(names.len() <= 1, "{what}: names names the one argument of the function");
    for given in &names {
        name(given, share(&argument, &what), &what);
    }
    let ran = async {
        for step in function.get("calls").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
            let on = step.get("on").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: a step of a function names on"));
            let call_name = step.get("call").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: a step of a function names call"));
            let args = step.get("args").map_or(&empty, |args| args.as_object().unwrap_or_else(|| panic!("{what}: args of {call_name} is no object")));
            let returned = match on {
                "0" => Box::pin(call(call_name, Some(&mut argument), args)).await,
                other => call_on(other, call_name, args, &what).await,
            };
            // A step that raises the kind of its raises is followed by the next step (binding GN-13o).
            let returned = match (returned, step.get("raises")) {
                (Err(error), Some(raises)) => {
                    if let Some(failure) = step_raised(call_name, raises, &error, &what) {
                        panic!("{failure}");
                    }
                    continue;
                }
                (Ok(_), Some(raises)) => panic!("{what}: the step {call_name} succeeded, and it expects {raises}"),
                (returned, None) => returned?,
            };
            if let Some(expected) = step.get("result") {
                match returned {
                    Returned::Value(value) => assert_eq!(&value, expected, "{what}: the step {call_name} of the function"),
                    Returned::Instance(_) | Returned::Instances(_) => panic!("{what}: the step {call_name} of the function returns an instance"),
                }
            }
        }
        Ok::<(), Error>(())
    }
    .await;
    for given in &names {
        if let Some(kept) = NAMED.with_borrow_mut(|named| named.remove(given)) {
            // A function that runs again, as the callback of a retried transaction does, keeps its last argument.
            KEPT.with_borrow_mut(|all| all.insert(given.clone(), kept));
        }
    }
    ran?;
    match (function.get("result"), function.get("raise")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(raise)) if raise == "exception" => Err(Error::config(CALLBACK_RAISED)),
        _ => panic!("{what}: a function value has a result or the raise exception"),
    }
}

/// A cancellation of a case (binding GN-6aq): `{"cancel": "fired"}` or `{"cancel": "open"}`.
fn cancel(value: &Value, member: &str) -> binding_core::Cancel {
    let (trigger, cancel) = binding_core::cancel_pair();
    match value.get("cancel").and_then(Value::as_str) {
        Some("fired") => trigger.cancel(),
        // The trigger of a cancellation that never fires lives as long as the test process.
        Some("open") => std::mem::forget(trigger),
        _ => panic!("{member}: a cancellation is {{\"cancel\": \"fired\"}} or {{\"cancel\": \"open\"}}"),
    }
    cancel
}

/// The schema, the query and the key ring of a case of `utils` (CORE-180 to CORE-186), each an instance value.
async fn schema_argument(args: &Map<String, Value>, member: &str) -> Schema {
    match Box::pin(instance(field(args, "schema", member), member)).await {
        Instance::Schema(schema) => schema,
        _ => panic!("{member}: schema is no instance of schema"),
    }
}

async fn model_and_keyring(args: &Map<String, Value>, member: &str) -> (Query, AesKeyring) {
    let Instance::Query(model) = Box::pin(instance(field(args, "model", member), member)).await else { panic!("{member}: model is no query") };
    let Instance::Keyring(keyring) = Box::pin(instance(field(args, "keyring", member), member)).await else { panic!("{member}: keyring is no aes_keyring") };
    (*model, keyring)
}

/// The record `aes_rotation_status`: `versions` is a list of `[{"int": version}, rows]` (CORE-185).
fn rotation_status(status: &crate::AesRotationStatus, member: &str) -> Value {
    let versions: Vec<Value> = status
        .versions
        .iter()
        .map(|(version, rows)| match version {
            binding_core::Key::Int(version) => serde_json::json!([{"int": version}, rows]),
            other => panic!("{member}: the status holds the key {other:?}, which is no integer"),
        })
        .collect();
    serde_json::json!({"current": status.current, "total": status.total, "pending": status.pending, "versions": versions})
}

/// A database that the case opened: the case closes it when it ends.
fn opened(db: Db) -> Returned {
    OPENED.with_borrow_mut(|opened| opened.push(db.clone()));
    Returned::Instance(Instance::Db(db))
}

/// Calls the core function that the contract names for `member`. Each group of classes is its own async function whose
/// future is boxed, so no frame of a call holds the locals of every member.
async fn call(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    let class = member.split_once('.').map_or(member, |(class, _)| class);
    match class {
        "integer_value" | "float_value" | "bytes_value" | "map_value" => Box::pin(call_values(member, receiver, args)).await,
        "query" => Box::pin(call_query(member, receiver, args)).await,
        "page" | "lookahead_page" | "group_lookahead_page" | "rows" => Box::pin(call_pages(member, receiver, args)).await,
        "db" | "tx" | "before_transaction_hook" => Box::pin(call_db(member, receiver, args)).await,
        "utils" | "schema_utils" | "privilege_utils" | "aes_utils" | "aes_keyring" => Box::pin(call_utils(member, receiver, args)).await,
        "schema" | "step_runner" | "orm" | "runtime_model" => Box::pin(call_core(member, receiver, args)).await,
        "dbspec" | "codec" => Box::pin(call_codec(member, receiver, args)).await,
        _ => match receiver {
            Some(_) => panic!("the case runner calls no member {member} on that receiver"),
            None => panic!("the case runner calls no member {member} without a receiver"),
        },
    }
}

/// The members of `integer_value`, `float_value`, `bytes_value`, `map_value` (`call`).
async fn call_values(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
        ("integer_value.constructor", None) => {
            let value = int64(field(args, "value", member), member);
            Returned::Instance(Instance::Integer(IntegerValue::new(value)))
        }
        ("integer_value.value", Some(Instance::Integer(value))) => Returned::Value(Value::from(value.value())),
        ("float_value.constructor", None) => {
            let value = field(args, "value", member).as_f64().unwrap_or_else(|| panic!("{member}: value is no float"));
            Returned::Instance(Instance::Float(FloatValue::new(value)))
        }
        ("float_value.value", Some(Instance::Float(value))) => Returned::Value(Value::from(value.value())),
        ("bytes_value.constructor", None) => Returned::Instance(Instance::Bytes(BytesValue::new(&bytes(args, "value", member)))),
        ("bytes_value.value", Some(Instance::Bytes(value))) => {
            Returned::Value(serde_json::json!({"hex": value.value().iter().map(|byte| format!("{byte:02x}")).collect::<String>()}))
        }
        ("map_value.constructor", None) => {
            let entries = field(args, "entries", member).as_object().unwrap_or_else(|| panic!("{member}: entries is no map"));
            let mut values = OrderedMap::with_capacity(entries.len());
            for (key, value) in entries {
                assert!(values.insert(key.clone(), orm_value(value, member)?).is_none(), "{member}: repeated key {key}");
            }
            Returned::Instance(Instance::Map(MapValue::new(&values)))
        }
        ("map_value.entries", Some(Instance::Map(value))) => {
            Returned::Value(value.entries().iter().map(|(key, value)| (key.to_owned(), case_value(value, member))).collect::<Map<String, Value>>().into())
        }
        (other, Some(_)) => panic!("the case runner calls no member {other} on that receiver"),
        (other, None) => panic!("the case runner calls no member {other} without a receiver"),
    })
}

/// The members of `query` (`call`).
async fn call_query(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
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
            query.set(&text(args, "column", member), &orm_value(field(args, "value", member), member)?);
            Returned::Value(Value::Null)
        }
        ("query.plus", Some(Instance::Query(query))) => {
            query.plus(&text(args, "column", member), &orm_value(field(args, "value", member), member)?);
            Returned::Value(Value::Null)
        }
        ("query.minus", Some(Instance::Query(query))) => {
            query.minus(&text(args, "column", member), &orm_value(field(args, "value", member), member)?);
            Returned::Value(Value::Null)
        }
        ("query.expect_revision", Some(Instance::Query(query))) => {
            let revision = field(args, "revision", member).as_i64().unwrap_or_else(|| panic!("{member}: revision is no integer"));
            query.expect_revision(&text(args, "column", member), revision);
            Returned::Value(Value::Null)
        }
        ("query.require_match", Some(Instance::Query(query))) => {
            query.require_match();
            Returned::Value(Value::Null)
        }
        ("query.create", Some(Instance::Query(query))) => Returned::Instance(Instance::Query(Box::new(query.create().await?))),
        ("query.creates", Some(Instance::Query(query))) => {
            let given = field(args, "rows", member).as_array().unwrap_or_else(|| panic!("{member}: rows is no list"));
            let mut rows = Vec::with_capacity(given.len());
            for row in given {
                match Box::pin(instance(row, member)).await {
                    Instance::Query(row) => rows.push(*row),
                    _ => panic!("{member}: a row is no query"),
                }
            }
            Returned::Value(returned_integer(query.creates(&rows, uint(args, "batch", member)).await?))
        }
        ("query.save", Some(Instance::Query(query))) => Returned::Instance(Instance::Query(Box::new(query.save().await?))),
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
        ("query.gets_page", Some(Instance::Query(query))) => {
            Returned::Instance(Instance::Page(Box::new(query.gets_page(uint(args, "page", member), uint(args, "per_page", member)).await?)))
        }
        ("query.where_group", Some(Instance::Query(query))) => match Box::pin(instance(field(args, "query", member), member)).await {
            Instance::Query(group) => {
                query.where_group(&text(args, "connector", member), *group);
                Returned::Value(Value::Null)
            }
            _ => panic!("{member}: query is no query"),
        },
        ("query.duplication", Some(Instance::Query(query))) => match Box::pin(instance(field(args, "query", member), member)).await {
            Instance::Query(other) => {
                query.duplication(*other);
                Returned::Value(Value::Null)
            }
            _ => panic!("{member}: query is no query"),
        },
        ("query.sum", Some(Instance::Query(query))) => {
            query.sum(&text(args, "column", member));
            Returned::Value(Value::Null)
        }
        ("query.get_sum", Some(Instance::Query(query))) => Returned::Value(Value::from(query.get_sum().await?)),
        ("query.avg", Some(Instance::Query(query))) => {
            query.avg(&text(args, "column", member));
            Returned::Value(Value::Null)
        }
        ("query.get_avg", Some(Instance::Query(query))) => Returned::Value(query.get_avg().await?.map_or(Value::Null, Value::from)),
        ("query.force_index", Some(Instance::Query(query))) => {
            query.force_index(&text(args, "name", member));
            Returned::Value(Value::Null)
        }
        ("query.group_limit", Some(Instance::Query(query))) => {
            query.group_limit(uint(args, "count", member));
            Returned::Value(Value::Null)
        }
        ("query.gets_lookahead_page", Some(Instance::Query(query))) => {
            Returned::Instance(Instance::LookaheadPage(Box::new(query.gets_lookahead_page(uint(args, "page", member), uint(args, "per_page", member)).await?)))
        }
        ("query.gets_count_lookahead_page", Some(Instance::Query(query))) => Returned::Instance(Instance::GroupPage(Box::new(
            query.gets_count_lookahead_page(uint(args, "page", member), uint(args, "per_page", member)).await?,
        ))),
        ("query.group_by", Some(Instance::Query(query))) => {
            query.group_by(&text(args, "column", member));
            Returned::Value(Value::Null)
        }
        ("query.gets_count", Some(Instance::Query(query))) => Returned::Value(query.gets_count().await?.iter().map(|row| case_map(row, member)).collect()),
        ("query.get_count", Some(Instance::Query(query))) => Returned::Value(Value::from(query.get_count().await?)),
        ("query.where", Some(Instance::Query(query))) => {
            query.where_chain(&text(args, "chain", member), &orm_values(args, "values", member)?);
            Returned::Value(Value::Null)
        }
        ("query.where_none", Some(Instance::Query(query))) => {
            query.where_none(&text(args, "connector", member));
            Returned::Value(Value::Null)
        }
        ("query.value", Some(Instance::Query(query))) => Returned::Value(case_value(&query.value(&text(args, "column", member))?, member)),
        ("query.get_by", Some(Instance::Query(query))) => match query.get_by(&text(args, "chain", member), &orm_values(args, "values", member)?).await? {
            Some(row) => Returned::Instance(Instance::Query(Box::new(row))),
            None => Returned::Value(Value::Null),
        },
        ("query.get", Some(Instance::Query(query))) => optional_row(query.get().await?),
        ("query.gets", Some(Instance::Query(query))) => Returned::Instance(Instance::Rows(Box::new(query.gets_rows().await?))),
        ("query.gets_by", Some(Instance::Query(query))) => {
            Returned::Instance(Instance::Rows(Box::new(query.gets_rows_by(&text(args, "chain", member), &orm_values(args, "values", member)?).await?)))
        }
        ("query.to_array", Some(Instance::Query(query))) => Returned::Value(case_map(&query.to_array()?, member)),
        ("query.get_count_by", Some(Instance::Query(query))) => {
            Returned::Value(Value::from(query.get_count_by(&text(args, "chain", member), &orm_values(args, "values", member)?).await?))
        }
        ("query.connect", Some(Instance::Query(query))) => {
            query.connect(connection(field(args, "connection", member), member).await);
            Returned::Value(Value::Null)
        }
        (other, Some(_)) => panic!("the case runner calls no member {other} on that receiver"),
        (other, None) => panic!("the case runner calls no member {other} without a receiver"),
    })
}

/// The members of `page`, `lookahead_page`, `group_lookahead_page`, `rows` (`call`).
async fn call_pages(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
        ("page.total_count", Some(Instance::Page(page))) => Returned::Value(Value::from(page.total_count())),
        ("page.total_pages", Some(Instance::Page(page))) => Returned::Value(Value::from(page.total_pages())),
        ("page.page", Some(Instance::Page(page))) => Returned::Value(Value::from(page.page())),
        ("page.per_page", Some(Instance::Page(page))) => Returned::Value(Value::from(page.per_page())),
        ("page.rows", Some(Instance::Page(page))) => Returned::Instance(Instance::Rows(Box::new(page.rows()))),
        ("lookahead_page.page", Some(Instance::LookaheadPage(page))) => Returned::Value(Value::from(page.page())),
        ("lookahead_page.per_page", Some(Instance::LookaheadPage(page))) => Returned::Value(Value::from(page.per_page())),
        ("lookahead_page.has_next", Some(Instance::LookaheadPage(page))) => Returned::Value(Value::from(page.has_next())),
        ("lookahead_page.rows", Some(Instance::LookaheadPage(page))) => Returned::Instance(Instance::Rows(Box::new(page.rows()))),
        ("group_lookahead_page.page", Some(Instance::GroupPage(page))) => Returned::Value(Value::from(page.page())),
        ("group_lookahead_page.per_page", Some(Instance::GroupPage(page))) => Returned::Value(Value::from(page.per_page())),
        ("group_lookahead_page.has_next", Some(Instance::GroupPage(page))) => Returned::Value(Value::from(page.has_next())),
        ("group_lookahead_page.rows", Some(Instance::GroupPage(page))) => Returned::Value(page.rows().iter().map(|row| case_map(row, member)).collect()),
        ("rows.len", Some(Instance::Rows(rows))) => Returned::Value(Value::from(rows.len())),
        ("rows.first", Some(Instance::Rows(rows))) => optional_row(rows.first()),
        ("rows.get", Some(Instance::Rows(rows))) => optional_row(rows.get(&orm_value(field(args, "key", member), member)?)),
        ("rows.keys", Some(Instance::Rows(rows))) => Returned::Value(rows.keys().iter().map(|key| case_value(key, member)).collect()),
        // A list of rows, an empty one too, is a list of instances: a class has no case value form (binding GN-13e), so a
        // row is observed through an instance value that picks it (GN-13f) and the length by rows.len.
        ("rows.values", Some(Instance::Rows(rows))) => Returned::Instances(rows.values().into_iter().map(|row| Instance::Query(Box::new(row))).collect()),
        ("rows.to_array", Some(Instance::Rows(rows))) => Returned::Value(rows.to_array()?.iter().map(|row| case_map(row, member)).collect()),
        (other, Some(_)) => panic!("the case runner calls no member {other} on that receiver"),
        (other, None) => panic!("the case runner calls no member {other} without a receiver"),
    })
}

/// The members of `db`, `tx`, `before_transaction_hook` (`call`).
async fn call_db(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
        ("db.connect", None) => {
            opened(Db::connect(&text(args, "dsn", member), uint(args, "pool_size", member), config(field(args, "cfg", member), member)).await?)
        }
        ("db.connect_schema", None) => {
            let Instance::Schema(schema) = Box::pin(instance(field(args, "schema", member), member)).await else {
                panic!("{member}: schema is no instance of schema")
            };
            opened(Db::connect_schema(&text(args, "dsn", member), &schema, uint(args, "pool_size", member), config(field(args, "cfg", member), member)).await?)
        }
        ("db.close", Some(Instance::Db(db))) => {
            db.close_async().await;
            Returned::Value(Value::Null)
        }
        ("db.stats", Some(Instance::Db(db))) => {
            let stats = db.stats();
            Returned::Value(serde_json::json!({
                "max_open_connections": stats.max_open_connections,
                "open_connections": stats.open_connections,
                "in_use": stats.in_use,
                "idle": stats.idle,
            }))
        }
        ("db.driver", Some(Instance::Db(db))) => Returned::Value(Value::from(db.driver())),
        ("db.transaction_active", Some(Instance::Db(db))) => Returned::Value(Value::from(db.transaction_active())),
        ("tx.transaction_active", Some(Instance::Tx(tx))) => Returned::Value(Value::from(tx.transaction_active())),
        ("db.sql_driver", Some(Instance::Db(db))) => Returned::Value(Value::from(db.sql_driver())),
        ("db.analyze_restore", Some(Instance::Db(db))) => Returned::Value(Value::from(db.analyze_restore(&text(args, "request", member))?)),
        ("db.with_cancel", Some(Instance::Db(db))) => Returned::Instance(Instance::Db(db.with_cancel(cancel(field(args, "cancel", member), member)))),
        ("db.with_request_log", Some(Instance::Db(db))) => Returned::Instance(Instance::Db(db.with_request_log())),
        ("db.observed_requests", Some(Instance::Db(db))) => {
            let record = |observed: &crate::ObservedRequest| {
                let params: Vec<Value> = observed.params.iter().map(|value| case_value(value, member)).collect();
                serde_json::json!({"request": observed.request, "params": params})
            };
            Returned::Value(db.observed_requests().iter().map(record).collect())
        }
        ("db.execute", Some(Instance::Db(db))) => {
            db.execute_text(&text(args, "step", member), orm_values(args, "params", member)?).await?;
            Returned::Value(Value::Null)
        }
        ("db.with_request_text_hook", Some(Instance::Db(db))) => {
            Returned::Instance(Instance::Db(db.with_request_text_hook(request_text_hook(field(args, "hook", member), &format!("{member}: hook")))))
        }
        ("db.before_transaction", Some(Instance::Db(db))) => {
            Returned::Instance(Instance::Hook(db.before_transaction(before_transaction_hook(field(args, "hook", member), &format!("{member}: hook")))))
        }
        ("before_transaction_hook.remove", Some(Instance::Hook(hook))) => {
            hook.remove();
            Returned::Value(Value::Null)
        }
        ("db.transaction", Some(Instance::Db(db))) => {
            let fixture = field(args, "callback", member).clone();
            let options = transaction_options(args.get("options"), member);
            let what = format!("{member}: callback");
            Returned::Value(db.transaction_async(|tx| run_function(fixture.clone(), Instance::Tx(tx), what.clone()), options).await?)
        }
        ("tx.execute", Some(Instance::Tx(tx))) => {
            tx.execute_text(&text(args, "step", member), orm_values(args, "params", member)?).await?;
            Returned::Value(Value::Null)
        }
        ("tx.savepoint", Some(Instance::Tx(tx))) => {
            let fixture = field(args, "callback", member).clone();
            let what = format!("{member}: callback");
            Returned::Value(tx.savepoint_async(|tx| run_function(fixture, Instance::Tx(tx), what)).await?)
        }
        ("db.utils", Some(Instance::Db(db))) => Returned::Instance(Instance::Utils(db.utils())),
        ("tx.utils", Some(Instance::Tx(tx))) => Returned::Instance(Instance::Utils(tx.utils())),
        (other, Some(_)) => panic!("the case runner calls no member {other} on that receiver"),
        (other, None) => panic!("the case runner calls no member {other} without a receiver"),
    })
}

/// The members of `utils`, `schema_utils`, `privilege_utils`, `aes_utils`, `aes_keyring` (`call`).
async fn call_utils(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
        ("utils.stats", Some(Instance::Utils(utils))) => {
            let stats = utils.stats();
            Returned::Value(serde_json::json!({
                "max_open_connections": stats.max_open_connections,
                "open_connections": stats.open_connections,
                "in_use": stats.in_use,
                "idle": stats.idle,
            }))
        }
        ("utils.lock", Some(Instance::Utils(utils))) => {
            utils.lock(&text(args, "key", member)).await?;
            Returned::Value(Value::Null)
        }
        ("utils.set_local", Some(Instance::Utils(utils))) => {
            utils.set_local(&text(args, "key", member), &text(args, "value", member)).await?;
            Returned::Value(Value::Null)
        }
        ("utils.backend_waiting_for_lock", Some(Instance::Utils(utils))) => Returned::Value(Value::from(utils.backend_waiting_for_lock().await?)),
        ("utils.schema", Some(Instance::Utils(utils))) => Returned::Instance(Instance::SchemaUtils(utils.schema())),
        ("utils.privileges", Some(Instance::Utils(utils))) => Returned::Instance(Instance::PrivilegeUtils(utils.privileges())),
        ("utils.aes", Some(Instance::Utils(utils))) => Returned::Instance(Instance::AesUtils(utils.aes())),
        ("schema_utils.register", Some(Instance::SchemaUtils(schema))) => {
            schema.register(&schema_argument(args, member).await)?;
            Returned::Value(Value::Null)
        }
        ("schema_utils.install", Some(Instance::SchemaUtils(schema))) => {
            schema.install(&schema_argument(args, member).await).await?;
            Returned::Value(Value::Null)
        }
        ("schema_utils.add_tables_and_columns", Some(Instance::SchemaUtils(schema))) => {
            Returned::Value(Value::from(schema.add_tables_and_columns(&schema_argument(args, member).await).await?))
        }
        ("schema_utils.exists", Some(Instance::SchemaUtils(schema))) => Returned::Value(Value::from(schema.exists(&text(args, "name", member)).await?)),
        ("schema_utils.installed", Some(Instance::SchemaUtils(schema))) => {
            Returned::Value(Value::from(schema.installed(&text(args, "name", member), &text(args, "table", member)).await?))
        }
        ("schema_utils.empty", Some(Instance::SchemaUtils(schema))) => Returned::Value(Value::from(schema.empty().await?)),
        ("privilege_utils.grant_table", Some(Instance::PrivilegeUtils(privileges))) => {
            privileges.grant_table(&text(args, "table", member), &text(args, "role", member)).await?;
            Returned::Value(Value::Null)
        }
        ("privilege_utils.revoke_table", Some(Instance::PrivilegeUtils(privileges))) => {
            privileges.revoke_table(&text(args, "table", member), &text(args, "privilege", member), &text(args, "role", member)).await?;
            Returned::Value(Value::Null)
        }
        ("privilege_utils.inspect_table", Some(Instance::PrivilegeUtils(privileges))) => {
            let held = privileges.inspect_table(&text(args, "table", member)).await?;
            Returned::Value(serde_json::json!({
                "insert": held.insert,
                "select": held.select,
                "update": held.update,
                "delete": held.delete,
                "truncate": held.truncate,
            }))
        }
        ("aes_utils.status", Some(Instance::AesUtils(aes))) => {
            let (model, keyring) = model_and_keyring(args, member).await;
            Returned::Value(rotation_status(&aes.status_query(&model, &keyring).await?, member))
        }
        ("aes_utils.rotate", Some(Instance::AesUtils(aes))) => {
            let (model, keyring) = model_and_keyring(args, member).await;
            Returned::Value(Value::from(aes.rotate_query(&model, &keyring).await?))
        }
        ("aes_keyring.constructor", None) => Returned::Instance(Instance::Keyring(AesKeyring::new(
            &{
                let mut keys = binding_core::KeyedMap::new();
                for (version, key) in keyed_texts(field(args, "keys", member), member) {
                    keys.insert(binding_core::Key::Int(i64::from(version)), key);
                }
                keys
            },
            int(field(args, "current", member), member),
        )?)),
        ("aes_keyring.current", Some(Instance::Keyring(keyring))) => Returned::Value(Value::from(keyring.current())),
        ("aes_keyring.versions", Some(Instance::Keyring(keyring))) => Returned::Value(Value::from(keyring.versions())),
        (other, Some(_)) => panic!("the case runner calls no member {other} on that receiver"),
        (other, None) => panic!("the case runner calls no member {other} without a receiver"),
    })
}

/// The members of `schema`, `step_runner`, `orm`, `runtime_model` (`call`).
async fn call_core(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
        ("schema.load", None) => Returned::Instance(Instance::Schema(Schema::load(
            &text(args, "manifest_text", member),
            &text(args, "external_text", member),
            &text(args, "manifest_hash", member),
        )?)),
        ("schema.hash", Some(Instance::Schema(schema))) => Returned::Value(Value::from(schema.hash())),
        ("step_runner.new", None) => {
            let Instance::Schema(schema) = Box::pin(instance(field(args, "schema", member), member)).await else {
                panic!("{member}: schema is no instance of schema")
            };
            Returned::Instance(Instance::Runner(Box::new(StepRunner::new(&schema, connection(field(args, "connection", member), member).await))))
        }
        ("step_runner.run", Some(Instance::Runner(runner))) => Returned::Value(Value::from(runner.run(&text(args, "step", member)).await)),
        ("step_runner.close", Some(Instance::Runner(runner))) => Returned::Value(Value::from(runner.close().await)),
        ("orm.value_function_unit", None) => Returned::Value(optional_text(crate::engine::value_function_unit(&text(args, "name", member)))),
        ("orm.transaction_conflict", None) => {
            crate::tx::fail_transaction_conflict(&text(args, "message", member))?;
            Returned::Value(Value::Null)
        }
        ("orm.fulltext_boolean", None) => Returned::Value(Value::from(crate::value::fulltext_boolean(&text(args, "value", member)))),
        ("runtime_model.load", None) => Returned::Instance(Instance::Model(Box::new(Manifest::from_json(&text(args, "model", member))?))),
        ("runtime_model.validate", Some(Instance::Model(model))) => {
            model.validate(&text(args, "request", member))?;
            Returned::Value(Value::Null)
        }
        ("runtime_model.param_uses", Some(Instance::Model(model))) => Returned::Value(Value::from(model.param_uses(&text(args, "request", member))?)),
        ("runtime_model.restore_key", Some(Instance::Model(model))) => Returned::Value(Value::from(model.restore_key(&text(args, "request", member))?)),
        ("runtime_model.compile", Some(Instance::Model(model))) => {
            Returned::Value(Value::from(model.compile(&text(args, "request", member), &text(args, "dialect", member))?))
        }
        ("runtime_model.operator_allowed", Some(Instance::Model(model))) => Returned::Value(Value::from(model.operator_allowed(
            &text(args, "entity", member),
            &text(args, "column", member),
            &text(args, "operator", member),
        )?)),
        (other, Some(_)) => panic!("the case runner calls no member {other} on that receiver"),
        (other, None) => panic!("the case runner calls no member {other} without a receiver"),
    })
}

/// The members of `dbspec`, `codec` (`call`).
async fn call_codec(member: &str, receiver: Option<&mut Instance>, args: &Map<String, Value>) -> Result<Returned, Error> {
    Ok(match (member, receiver) {
        ("dbspec.read_set", None) => {
            let path = case_path(&text(args, "path", member), member);
            Returned::Value(Value::from(crate::dbspec_json::read_set(binding_core::Io::for_generated_call(), &path)?))
        }
        ("dbspec.read_bytes", None) => Returned::Value(Value::from(crate::dbspec_json::read_bytes(&text(args, "name", member), &bytes(args, "bytes", member)))),
        ("dbspec.parse_set", None) => {
            Returned::Value(Value::from(crate::dbspec_json::parse_set(&texts(args, "owned", member), &texts(args, "external", member))?))
        }
        ("dbspec.manifest", None) => Returned::Value(Value::from(crate::dbspec_json::manifest(&text(args, "documents", member))?)),
        ("dbspec.emit", None) => Returned::Value(Value::from(crate::dbspec_json::emit(&text(args, "document", member))?)),
        ("dbspec.render_statements", None) => {
            Returned::Value(Value::from(crate::dbspec_json::render_statements(&text(args, "documents", member), &text(args, "dialect", member))?))
        }
        ("dbspec.canonical_literal", None) => {
            Returned::Value(optional_text(crate::dbspec_json::canonical_literal(&text(args, "column_type", member), &text(args, "literal", member))?))
        }
        ("dbspec.runtime_model", None) => Returned::Value(Value::from(crate::dbspec_json::runtime_model(&text(args, "documents", member))?)),
        ("codec.decode", None) => {
            let cell = orm_value(field(args, "cell", member), member)?;
            Returned::Value(case_value(&crate::orm_value::decode(&texts(args, "stages", member), &cell)?, member))
        }
        ("codec.host_encode", None) => {
            let value = orm_value(field(args, "value", member), member)?;
            Returned::Value(case_value(&crate::orm_value::host_encode(&value, &texts(args, "stages", member), &text(args, "key", member))?, member))
        }
        ("codec.host_decode", None) => {
            let cell = orm_value(field(args, "cell", member), member)?;
            Returned::Value(case_value(&crate::orm_value::host_decode(&cell, &texts(args, "stages", member), &text(args, "key", member))?, member))
        }
        ("codec.blind_index", None) => {
            Returned::Value(Value::from(crate::orm_value::blind_index(&orm_value(field(args, "value", member), member)?, &text(args, "key", member))?))
        }
        (other, Some(_)) => panic!("the case runner calls no member {other} on that receiver"),
        (other, None) => panic!("the case runner calls no member {other} without a receiver"),
    })
}

/// The instance that the steps of `pick` reach in what the member of `from` returned (binding GN-13f): `"?"` takes the
/// value of an optional, which is present, and `{"index": n}` the item `n` of a list.
fn picked(returned: Returned, pick: Option<&Value>, member: &str, what: &str) -> Result<Instance, String> {
    let steps = pick.and_then(Value::as_array).unwrap_or_else(|| panic!("{what}: from of {member} names its pick, a list of steps"));
    let mut at = returned;
    for step in steps {
        at = match (at, step.as_str(), step.get("index").and_then(Value::as_u64)) {
            (Returned::Instance(instance), Some("?"), _) => Returned::Instance(instance),
            (Returned::Value(Value::Null), Some("?"), _) => {
                return Err(format!("{what}: {member} returned no value, and the pick takes the value of its optional"));
            }
            (Returned::Instances(mut items), None, Some(index)) => {
                let index = usize::try_from(index).or_panic(|error| format!("{what}: the index {index} of a pick does not fit usize: {error}"));
                if index >= items.len() {
                    return Err(format!("{what}: {member} returned {} instances, and the pick takes the item {index}", items.len()));
                }
                Returned::Instance(items.swap_remove(index))
            }
            _ => panic!("{what}: the case runner takes no step {step} of a pick at what {member} returned"),
        };
    }
    match at {
        Returned::Instance(instance) => Ok(instance),
        Returned::Value(_) | Returned::Instances(_) => Err(format!("{what}: the pick of {member} reaches no instance")),
    }
}

/// An instance value of a case: `{new, receiver, args, then}` or `{from, receiver, args, pick, then}` (binding G-5,
/// GN-13f). A value that cannot be made fails the test of the case.
async fn instance(value: &Value, what: &str) -> Instance {
    match made(value, what).await {
        Ok(instance) => instance,
        Err(failure) => panic!("{failure}"),
    }
}

/// Makes an instance value, or names the call of its preparation that failed.
async fn made(value: &Value, what: &str) -> Result<Instance, String> {
    let made = value.as_object().unwrap_or_else(|| panic!("{what}: an instance value is an object"));
    if let Some(name) = made.get("bound") {
        assert_eq!(made.len(), 1, "{what}: a bound value is {{bound}} alone");
        return Ok(bound(name.as_str().unwrap_or_else(|| panic!("{what}: bound names a name")), what));
    }
    let (member, pick) = match (made.get("new").and_then(Value::as_str), made.get("from").and_then(Value::as_str)) {
        (Some(member), None) => (member, false),
        (None, Some(member)) => (member, true),
        _ => panic!("{what}: an instance value names its member in new or in from"),
    };
    let empty = Map::new();
    let args = made.get("args").map_or(&empty, |args| args.as_object().unwrap_or_else(|| panic!("{what}: args is no object")));
    let mut receiver = match made.get("receiver") {
        Some(value) => Some(Box::pin(self::made(value, what)).await?),
        None => None,
    };
    let mut out = match (call(member, receiver.as_mut(), args).await, pick) {
        (Err(error), _) => return Err(format!("{what}: the preparation {member} failed: {error}")),
        (Ok(returned), true) => picked(returned, made.get("pick"), member, what)?,
        (Ok(Returned::Instance(instance)), false) => instance,
        (Ok(Returned::Value(_) | Returned::Instances(_)), false) => return Err(format!("{what}: {member} returns no instance")),
    };
    for step in made.get("then").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
        let name = step.get("call").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: a then step names its member in call"));
        let args = step.get("args").map_or(&empty, |args| args.as_object().unwrap_or_else(|| panic!("{what}: args of {name} is no object")));
        if let Err(error) = call(name, Some(&mut out), args).await {
            return Err(format!("{what}: the preparation {name} failed: {error}"));
        }
    }
    Ok(out)
}

/// The call of a member under the arming of its case: the arming is installed on the thread around each poll of the
/// call, as the generated entry point of a member installs it (binding G-5, GN-8a), so a point that the call reaches
/// after an await reads it too.
struct Faulted<F> {
    armed: binding_core::fault::Armed,
    call: Pin<Box<F>>,
}

impl<F: Future> Future for Faulted<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<F::Output> {
        let this = self.get_mut();
        this.armed.run(|| this.call.as_mut().poll(context))
    }
}

/// The keys of a case that are no parameter of its member (binding G-5).
const RESERVED: [&str; 10] = ["id", "note", "rule", "raises", "result", "receiver", "with", "after", "faults", "@files"];

/// Runs one case of `member` and adds to `failures` each difference between what the case states and what the member did:
/// the test runs every case to its end and then names every case that failed (HR-86 of the checks, CORE-71).
pub(crate) async fn run_case(member: &str, case: &Value, failures: &mut Vec<String>) {
    let fields = case.as_object().unwrap_or_else(|| panic!("{member}: a case is an object"));
    let id = fields.get("id").and_then(Value::as_str).unwrap_or_else(|| panic!("{member}: a case has an id"));
    let what = format!("{member} {id}");
    // The directory of the case (binding GN-6y): the files of the case are written into it before any value of the case
    // is made (GN-13i), and it is removed with the case, after the databases of the case are closed.
    let scratch = Scratch::new("orm-rust-interface-case");
    ROOT.with_borrow_mut(|root| *root = Some(scratch.path().to_path_buf()));
    if let Some(files) = fields.get("@files") {
        let files = files.as_object().unwrap_or_else(|| panic!("{what}: @files is an object"));
        for (relative, content) in files {
            let path = case_path(relative, &what);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).or_panic(|error| format!("{what}: create {}: {error}", parent.display()));
            }
            let bytes = match content.as_str() {
                Some(text) => text.as_bytes().to_vec(),
                None => {
                    let mut holder = Map::new();
                    holder.insert("file".to_owned(), content.clone());
                    bytes(&holder, "file", &what)
                }
            };
            std::fs::write(&path, bytes).or_panic(|error| format!("{what}: write {}: {error}", path.display()));
        }
    }
    run_case_in(member, fields, &what, failures).await;
    NAMED.with_borrow_mut(BTreeMap::clear);
    KEPT.with_borrow_mut(BTreeMap::clear);
    // The functions that the core kept are read after the case: a call without a row and a row with once that answered
    // no call fail it (binding GN-6z, CORE-143).
    for function in KEPT_FUNCTIONS.with_borrow_mut(std::mem::take) {
        failures.extend(function.failures().into_iter().map(|failure| format!("{what}: {failure}")));
    }
    for db in OPENED.with_borrow_mut(std::mem::take) {
        db.close_async().await;
    }
    ROOT.with_borrow_mut(|root| *root = None);
    drop(scratch);
}

/// Runs the case `what` of `member` in its directory.
async fn run_case_in(member: &str, fields: &Map<String, Value>, what: &str, failures: &mut Vec<String>) {
    let what = what.to_owned();
    assert!(fields.get("rule").and_then(Value::as_str).is_some_and(|rule| !rule.is_empty()), "{what}: the case names its rule");
    let args: Map<String, Value> =
        fields.iter().filter(|(name, _)| !RESERVED.contains(&name.as_str())).map(|(name, value)| (name.clone(), value.clone())).collect();
    let mut receiver = match fields.get("receiver") {
        Some(value) => match made(value, &what).await {
            Ok(receiver) => Some(receiver),
            Err(failure) => {
                failures.push(failure);
                return;
            }
        },
        None => None,
    };
    // A database that is the receiver of the case has the name receiver, which a step of a function fixture calls while
    // the call of the case runs (binding GN-13p). A database shares its state, so the name is the receiver itself.
    if let Some(Instance::Db(db)) = &receiver {
        NAMED.with_borrow_mut(|named| named.insert("receiver".to_owned(), Instance::Db(db.clone())));
    }
    // with names the instances of the case after its receiver (binding GN-13pa). The JSON of the core keeps no key order, so
    // no value of with names another: then their order is not observable.
    if let Some(with) = fields.get("with") {
        assert!(receiver.is_some(), "{what}: the member has no receiver, so the case names no with");
        for (given, value) in with.as_object().unwrap_or_else(|| panic!("{what}: with is an object")) {
            assert!(!value.to_string().contains("\"bound\""), "{what}: the value {given} of with names no other value");
            match made(value, &what).await {
                Ok(instance) => name(given, instance, &what),
                Err(failure) => {
                    failures.push(failure);
                    NAMED.with_borrow_mut(BTreeMap::clear);
                    return;
                }
            }
        }
    }
    let outcome = match fields.get("faults") {
        Some(faults) => {
            // The faults of a case are armed for the call of its member alone, as a generated binding test arms them
            // (binding G-5, X-1, CORE-121): the receiver is made before the arming, and a fault that did not fire fails.
            let id = binding_core::fault::arm(member, &faults.to_string()).or_panic(|error| format!("{what}: {error}"));
            let armed = binding_core::fault::take(member);
            let outcome = Faulted { armed, call: Box::pin(call(member, receiver.as_mut(), &args)) }.await;
            let left = binding_core::fault::left(id).or_panic(|error| format!("{what}: {error}"));
            if !left.is_empty() {
                failures.push(format!("{what}: the faults of {} did not fire", left.join(", ")));
            }
            outcome
        }
        None => call(member, receiver.as_mut(), &args).await,
    };
    let mut result = None;
    match (outcome, fields.get("raises")) {
        (Err(error), Some(raises)) if raises == "callback" => {
            if error.text() != CALLBACK_RAISED {
                failures.push(format!("{what}: the case expects the failure of its function, and the member raised {error}"));
                return;
            }
        }
        (Err(error), Some(raises)) => {
            let raised = serde_json::json!({"kind": error.kind().as_str(), "category": error.category().as_str(), "message": error.to_string()});
            if raises != &raised {
                failures.push(format!("{what}: the case expects {raises}, and the member raised {raised}"));
                return;
            }
        }
        (Err(error), None) => {
            failures.push(format!("{what}: failed with {error} ({})", error.kind().as_str()));
            return;
        }
        (Ok(_), Some(raises)) => {
            failures.push(format!("{what}: succeeded, and the case expects {raises}"));
            return;
        }
        (Ok(Returned::Value(value)), None) => {
            // A call that returns nothing gives null: its case writes `"result": null` or leaves the key out, and the
            // two forms mean the same. A call that returns a value states its result.
            let nothing = Value::Null;
            let expected = match fields.get("result") {
                Some(expected) => expected,
                None if value == nothing => &nothing,
                None => panic!("{what}: the case states no result, and the call returned {value}"),
            };
            // An expected text may be composed with the paths of the case (binding GN-13l), compared as text.
            let expected = &match (expected.get("text"), case_text(expected, &what)) {
                (Some(_), Some(text)) => Value::from(text),
                _ => expected.clone(),
            };
            if &value != expected {
                failures.push(format!("{what}: the case expects the result {expected}, and the member returned {value}"));
            }
        }
        (Ok(Returned::Instance(instance)), None) => {
            assert!(fields.get("result").is_none(), "{what}: a class result is observed by the cases of its methods, not by result");
            result = Some(vec![instance]);
        }
        (Ok(Returned::Instances(instances)), None) => {
            assert!(fields.get("result").is_none(), "{what}: the instances of a list are observed by the cases of their methods, not by result");
            result = Some(instances);
        }
    }
    // The calls of after observe the receiver of a method after its call (binding G-5, GN-6ae), also after a call that
    // raised what the case expects: a member without a receiver names none, and the instance that it returns is observed
    // by the cases of its methods, whose receiver it makes. A call of after takes the names that the functions kept (GN-13o).
    NAMED.with_borrow_mut(|named| named.append(&mut KEPT.with_borrow_mut(std::mem::take)));
    let after = fields.get("after").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    assert!(after.is_empty() || receiver.is_some(), "{what}: the member has no receiver, so the case names no after");
    let empty = Map::new();
    for step in after {
        let name = step.get("call").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: an after step names call"));
        for key in step.as_object().unwrap_or_else(|| panic!("{what}: an after step is an object")).keys() {
            assert!(["on", "call", "args", "result", "raises"].contains(&key.as_str()), "{what}: an after step has no key {key}");
        }
        let args = step.get("args").map_or(&empty, |args| args.as_object().unwrap_or_else(|| panic!("{what}: args of {name} is no object")));
        let returned = match step.get("on").and_then(Value::as_str) {
            Some(on) => call_on(on, name, args, &what).await,
            None => call(name, Some(receiver.as_mut().unwrap_or_else(|| panic!("{what}: the case has no receiver to observe"))), args).await,
        };
        match (returned, step.get("raises")) {
            (Err(error), Some(raises)) => {
                if let Some(failure) = step_raised(name, raises, &error, &what) {
                    failures.push(failure);
                }
            }
            (Ok(_), Some(raises)) => failures.push(format!("{what}: after {name} succeeded, and it expects {raises}")),
            (Ok(Returned::Value(value)), None) => assert_eq!(Some(&value), step.get("result"), "{what}: after {name}"),
            (Ok(Returned::Instance(_) | Returned::Instances(_)), None) => panic!("{what}: after {name} returns an instance"),
            (Err(error), None) => panic!("{what}: after {name} failed: {error}"),
        }
    }
    NAMED.with_borrow_mut(BTreeMap::clear);
    drop((receiver, result));
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

// Requirements: CORE-62, CORE-70, CORE-71, CORE-72, CORE-123, CORE-124.
#[tokio::test]
async fn the_core_passes_the_cases_of_its_contract() {
    let _case = polyspec_orm_testcase::case!();
    let contract: Value = serde_json::from_str(CONTRACT).expect("packages/rust/interface.json is JSON");
    let cases: Value = serde_json::from_str(CASES).expect("contracts/interface/core.json is JSON");
    let rows = contract["cases"].as_array().expect("the contract has cases");
    assert!(!rows.is_empty(), "the contract names no cases");
    let mut ran = 0usize;
    let mut members = 0usize;
    let mut failures = Vec::new();
    for row in rows {
        // The groups of contracts/interface/service.json need the servers of a run (docs/spec/service-state.md SVC-7).
        if row["file"].as_str() == Some("contracts/interface/service.json") {
            continue;
        }
        assert_eq!(row["file"].as_str(), Some("contracts/interface/core.json"), "{row}: the case file that this test reads");
        let name = row["group"].as_str().expect("a row of cases names its group");
        let group = cases[name].as_array().unwrap_or_else(|| panic!("contracts/interface/core.json has no group {name}"));
        assert!(!group.is_empty(), "the group {name} holds no case");
        match (row["member"].as_str(), row["alias"].as_str()) {
            (Some(member), None) => {
                members += 1;
                for case in group {
                    run_case(member, case, &mut failures).await;
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
    assert!(failures.is_empty(), "{} of {ran} cases failed:\n{}", failures.len(), failures.join("\n"));
}

/// The kinds of `raises` that no case of the case form can raise, each with its reason.
const KINDS_WITHOUT_A_CASE: [(&str, &str, &str); 1] =
    [("dbspec.read_set", "config", "the member raises it for a path that is no Unicode text, and a case gives a path as a text")];

// Requirements: FMS-7, CORE-71. Each member of the units `dbspec`, `runtime_model` and `codec`, which read no
// database, has a case that raises each kind of its `raises` (binding CK-22). A kind of the category internal needs no
// case, because no input raises it.
#[test]
fn a_member_of_the_json_surface_has_a_case_of_each_kind_that_it_raises() {
    let _case = polyspec_orm_testcase::case!();
    let contract: Value = serde_json::from_str(CONTRACT).expect("packages/rust/interface.json is JSON");
    let cases: Value = serde_json::from_str(CASES).expect("contracts/interface/core.json is JSON");
    let mut missing = Vec::new();
    let mut read = 0usize;
    for unit in contract["units"].as_array().expect("the contract has units") {
        if !["dbspec", "runtime_model", "codec"].contains(&unit["id"].as_str().expect("a unit has an id")) {
            continue;
        }
        for member in unit["members"].as_array().expect("a unit of the JSON surface has members") {
            let id = member["id"].as_str().expect("a member has an id");
            let group = cases[id].as_array().map_or(&[][..], Vec::as_slice);
            for path in member["raises"].as_array().expect("a member states its raises") {
                let path = path.as_str().expect("a row of raises is the path of a kind");
                let kind = crate::Kind::ALL
                    .into_iter()
                    .find(|kind| path == format!("polyspec_orm::Kind::{kind:?}"))
                    .unwrap_or_else(|| panic!("{id}: {path} is no kind of the core"));
                read += 1;
                if kind.category().as_str() == "internal" || KINDS_WITHOUT_A_CASE.iter().any(|(member, name, _)| *member == id && *name == kind.as_str()) {
                    continue;
                }
                if !group.iter().any(|case| case["raises"]["kind"].as_str() == Some(kind.as_str())) {
                    missing.push(format!("{id}: no case raises {}", kind.as_str()));
                }
            }
        }
    }
    assert!(read > 0, "the units of the JSON surface state no kind");
    assert!(missing.is_empty(), "{} kinds have no case:\n{}", missing.len(), missing.join("\n"));
}

/// The set `clock` of the cases of `utils`, and the SQLite database of a test in its own directory.
fn clock_schema() -> Schema {
    let text = "dbspec 1 clock\n\ntable clock_event {\n  seq i64 identity\n  label varchar(32)\n  created_ts datetime(6) default now\n  primary key (seq)\n}\n";
    Schema::load(text, "", "sha256:fab61fb83cfec00c4d7a4d257b610b87c6fdccd49e02a85848a41ba263bc1ffb").expect("the set clock loads")
}

async fn sqlite_database(scratch: &Scratch) -> Db {
    let dsn = format!("sqlite://{}", scratch.path().join("shop.db").display());
    Db::connect(&dsn, 1, Config::default()).await.expect("connect")
}

fn create_table(sql: &str) -> String {
    serde_json::json!({"id": 1, "role": "main", "sql": sql, "tables": [], "bind_slots": []}).to_string()
}

// Requirements: CORE-182. A connection plans only the sets that it registered: `register` adds a set to a connection
// that has none, a second set stays beside the first, and the same set again changes nothing. The case form reaches no
// query of the connection of a `schema_utils` receiver, so this stays a native test.
#[tokio::test]
async fn register_adds_a_set_to_the_sets_of_its_connection() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-utils-register");
    let db = sqlite_database(&scratch).await;
    let clock = clock_schema();
    let other_text = "dbspec 1 other\n\ntable other_row {\n  id i64 identity\n  primary key (id)\n}\n";
    let other = Schema::load(other_text, "", "sha256:3977a85e434a335ae10c9be3d9018afa28cf6250b88ebe9bae63795a2f79b0ff").expect("the set other loads");
    db.execute_text(
        &create_table("CREATE TABLE clock_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, created_ts TEXT NOT NULL)"),
        Vec::new(),
    )
    .await
    .expect("the table of clock");
    db.execute_text(&create_table("CREATE TABLE other_row (id INTEGER PRIMARY KEY AUTOINCREMENT)"), Vec::new()).await.expect("the table of other");
    let mut events = Query::new(&clock, "clock_event").expect("clock_event");
    events.connect(Connection::Db(db.clone()));
    let mut rows = Query::new(&other, "other_row").expect("other_row");
    rows.connect(Connection::Db(db.clone()));
    assert_eq!(events.get_count().await.expect_err("a set that is not registered").kind(), crate::Kind::SchemaHashMismatch);
    db.utils().schema().register(&clock).expect("register clock");
    assert_eq!(events.get_count().await.expect("a registered set"), 0);
    assert_eq!(rows.get_count().await.expect_err("the second set is not registered yet").kind(), crate::Kind::SchemaHashMismatch);
    db.utils().schema().register(&other).expect("register other");
    db.utils().schema().register(&clock).expect("register clock again");
    assert_eq!(rows.get_count().await.expect("the second set"), 0);
    assert_eq!(events.get_count().await.expect("the first set beside the second"), 0);
    db.close_async().await;
}

// Requirements: CORE-183. The utilities of a transaction handle: a local value is read back in its transaction and a
// missing one is `no_rows`, a lock is taken on SQLite, an inserted key is reported, and the utilities of a handle whose
// callback returned are `transaction_ended`. The case form calls no member on the result of a step, so the utilities
// of a `tx` have no case of the contract and these stay native tests.
#[tokio::test]
async fn the_utilities_of_a_tx_run_in_its_transaction() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-utils-tx");
    let db = sqlite_database(&scratch).await;
    let clock = clock_schema();
    db.utils().schema().install(&clock).await.expect("install");
    let schema = &clock;
    let kept = db
        .transaction_async(
            |tx: Tx| async move {
                let utils = tx.utils();
                utils.set_local("orm.actor", "ann").await?;
                assert_eq!(utils.local("orm.actor")?, "ann");
                assert_eq!(utils.local("orm.none").expect_err("a value that is not set").kind(), crate::Kind::NoRows);
                assert_eq!(utils.set_local("a b", "x").await.expect_err("a key that is no identifier").kind(), crate::Kind::Config);
                utils.lock("orm.case").await?;
                let mut event = Query::new(schema, "clock_event")?;
                event.connect(Connection::Tx(tx.clone()));
                event.set("label", &OrmValue::Text("first".to_owned()));
                let created = event.create().await?;
                let sequence = match created.value("seq")? {
                    OrmValue::Int(n) | OrmValue::Int64(n) => n,
                    other => panic!("the key of the created row is {other:?}"),
                };
                assert!(utils.was_inserted("clock_event", sequence)?);
                assert!(!utils.was_inserted("clock_event", sequence + 1)?);
                assert_eq!(utils.was_inserted("", 1).expect_err("an empty entity").kind(), crate::Kind::Config);
                Ok(utils)
            },
            TransactionOptions::default(),
        )
        .await
        .expect("the transaction");
    assert_eq!(kept.local("orm.actor").expect_err("after the callback").kind(), crate::Kind::TransactionEnded);
    assert_eq!(kept.lock("orm.case").await.expect_err("after the callback").kind(), crate::Kind::TransactionEnded);
    db.close_async().await;
}

// Requirements: CORE-181. The machine of a utility gives one `Io` step and ends with its unchanged result, and making it
// sends no statement.
#[tokio::test]
async fn the_machine_of_a_utility_gives_one_io_step() {
    use binding_core::machine::{Machine as _, Step};
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-utils-machine");
    let db = sqlite_database(&scratch).await;
    let mut machine = db.utils().schema().empty_machine();
    let Step::Io(io) = machine.resume(None) else { panic!("the first step of the machine is no Io") };
    let Step::Done(result) = machine.resume(Some(io.await)) else { panic!("the second step of the machine is no Done") };
    assert!(result.expect("empty"));
    let Step::Done(result) = machine.resume(None) else { panic!("a machine that ended gives Done") };
    assert_eq!(result.expect_err("out of order").kind(), crate::Kind::Internal);
    db.close_async().await;
}
