//! The request hook of a connection handle (docs/operations/usage.md "Request hook"): the handle returned by `Db::with_request_hook`
//! uses the same connection, and its hook receives the request and `RequestParams` for each request of the handle, just before planning.
//! Runs ten shared cases of contracts/fixtures/request_hook.dbs in a SQLite case database (polyspec-orm-case-database,
//! the file is deleted when it ends or panics): without_hook, read_filter, insert_assign,
//! loaded_row_writes, invalid_param, restore_key, restore_condition, restore_no_key, restore_rewritten_key,
//! restore_hook_set_key. `coverage_request_hook_<case>` runs the same case on the database that feature-check chose,
//! in that database's case database (docs/spec/feature-coverage.md).
//!
//! `cargo test -p polyspec-orm --test request_hook`

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use polyspec_orm::ir::{Assign, Group, Item, Pred, Request};
use polyspec_orm::{Core, Db, Entity, Model, Param, RequestParams, Schema, Val};
use polyspec_orm_case_database::CaseDatabase;

static HOOK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/request_hook.dbs"), "sha256:b9ee83943930e19f474fe2c98ef5f6facd4ad40551becbdcb81b74ab5f2167ea");
static HOOK_ITEM: Entity = Entity {
    name: "hook_item",
    schema: &HOOK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<HookItem>,
    collect: polyspec_orm::model::collect_boxed::<HookItem>,
};
const COLUMNS: [&str; 3] = ["id", "part", "label"];

#[derive(Clone)]
struct HookItem {
    core: Core,
    values: BTreeMap<String, Val>,
}

impl Model for HookItem {
    fn entity() -> &'static Entity {
        &HOOK_ITEM
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        HookItem { core, values: BTreeMap::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        if !COLUMNS.contains(&name) {
            return Ok(false);
        }
        self.values.insert(name.to_owned(), v);
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }
}

static HOOK_ENTRY: Entity = Entity {
    name: "hook_entry",
    schema: &HOOK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<HookEntry>,
    collect: polyspec_orm::model::collect_boxed::<HookEntry>,
};
const ENTRY_COLUMNS: [&str; 4] = ["id", "part", "label", "note"];

/// A row of the soft delete table hook_entry, whose unique key is (part, label).
#[derive(Clone)]
struct HookEntry {
    core: Core,
    values: BTreeMap<String, Val>,
}

impl Model for HookEntry {
    fn entity() -> &'static Entity {
        &HOOK_ENTRY
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        HookEntry { core, values: BTreeMap::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        if !ENTRY_COLUMNS.contains(&name) {
            return Ok(false);
        }
        self.values.insert(name.to_owned(), v);
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }
}

static HOOK_UPSERT: Entity = Entity {
    name: "hook_upsert",
    schema: &HOOK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<HookUpsert>,
    collect: polyspec_orm::model::collect_boxed::<HookUpsert>,
};
const UPSERT_COLUMNS: [&str; 4] = ["id", "scope_col", "name", "hits"];

/// A row of hook_upsert, whose unique key is (scope_col, name).
#[derive(Clone)]
struct HookUpsert {
    core: Core,
    values: BTreeMap<String, Val>,
}

impl Model for HookUpsert {
    fn entity() -> &'static Entity {
        &HOOK_UPSERT
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        HookUpsert { core, values: BTreeMap::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        if !UPSERT_COLUMNS.contains(&name) {
            return Ok(false);
        }
        self.values.insert(name.to_owned(), v);
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }
}

/// A hook_entry model connected to db with values set.
fn entry(db: &Db, values: &[(&str, Param)]) -> HookEntry {
    let mut core = Core::new(&HOOK_ENTRY);
    core.connect(db);
    let mut m = HookEntry::from_core(core);
    for (column, value) in values {
        m.core_mut().set(column, value.clone());
    }
    m
}

/// The text value of column in row.
fn text_of<M: Model>(row: &M, column: &str) -> String {
    row.value(column).unwrap_or_else(|| panic!("{column}")).as_string().unwrap_or_else(|e| panic!("{column}: {e}"))
}

/// The id value of row.
fn id_of<M: Model>(row: &M) -> i64 {
    row.value("id").expect("id").as_i64().expect("id integer")
}

/// Creates the hook_entry rows (a, x), (b, x) and (a, y) with note n0 through db, soft deletes each and returns
/// their ids by part and label.
async fn seed_deleted_entries(db: &Db) -> BTreeMap<String, i64> {
    let mut ids = BTreeMap::new();
    for (part, label) in [("a", "x"), ("b", "x"), ("a", "y")] {
        let mut m = entry(db, &[("part", Param::from(part)), ("label", Param::from(label)), ("note", Param::from("n0"))]);
        let row = polyspec_orm::model::create(&mut m).await.expect("create entry");
        ids.insert(format!("{part}{label}"), id_of(&row));
        polyspec_orm::model::delete(&row, false).await.expect("delete entry");
    }
    ids
}

/// The (id, note) of every hook_entry row that db reads, which are the rows not deleted.
async fn entry_rows(db: &Db) -> Vec<(i64, String)> {
    let rows = polyspec_orm::model::gets(&entry(db, &[])).await.expect("gets entries");
    rows.models().map(|m| (id_of(m), text_of(m, "note"))).collect()
}

/// Adds `part = value` to the where of every read and restore.
fn part_scope_hook(value: &'static str) -> impl Fn(&mut Request, &mut RequestParams) -> polyspec_orm::Result<()> + Send + Sync + 'static {
    move |request: &mut Request, params: &mut RequestParams| {
        if request.kind == "restore" || READS.contains(&request.kind.as_str()) {
            let p = params.add(value);
            and_where(request, part_eq(p));
        }
        Ok(())
    }
}

/// A model connected to db.
fn item(db: &Db) -> HookItem {
    let mut core = Core::new(&HOOK_ITEM);
    core.connect(db);
    HookItem::from_core(core)
}

/// A model that runs in a transaction without a connection.
fn unconnected() -> HookItem {
    HookItem::from_core(Core::new(&HOOK_ITEM))
}

/// A model with values set.
fn with_values(mut m: HookItem, values: &[(&str, &str)]) -> HookItem {
    for (column, value) in values {
        m.core_mut().set(column, Param::from(*value));
    }
    m
}

/// A connection on which the fixture is installed in the SQLite case database.
async fn installed(database: &CaseDatabase) -> Db {
    let db = Db::connect(database.dsn(), 2, polyspec_orm::Config::default()).await.expect("connect");
    db.utils().schema().install(&HOOK_SCHEMA).await.expect("install");
    db
}

/// Inserts rows a1, a2 (part a) and b1 (part b) through the connection.
async fn seed(db: &Db) {
    for (part, label) in [("a", "a1"), ("a", "a2"), ("b", "b1")] {
        let mut m = with_values(item(db), &[("part", part), ("label", label)]);
        polyspec_orm::model::create(&mut m).await.expect("seed");
    }
}

/// Attaches pred to the request's root where with AND. An existing where becomes one group item.
fn and_where(request: &mut Request, mut pred: Pred) {
    match request.query.where_.take() {
        None => request.query.where_ = Some(Group { items: vec![Item::Pred { pred: Box::new(pred) }], ..Default::default() }),
        Some(existing) => {
            pred.conn = "and".into();
            request.query.where_ = Some(Group { items: vec![Item::Group { group: existing }, Item::Pred { pred: Box::new(pred) }], ..Default::default() });
        }
    }
}

fn part_eq(p: usize) -> Pred {
    Pred { column: "part".into(), op: "eq".into(), p: Some(p), ..Default::default() }
}

const READS: [&str; 7] = ["one", "all", "count", "group_count", "sum", "avg", "paginate"];

/// A hook that attaches `part = value` to the root where of a read request.
fn read_filter_hook(value: &'static str) -> impl Fn(&mut Request, &mut RequestParams) -> polyspec_orm::Result<()> + Send + Sync + 'static {
    move |request: &mut Request, params: &mut RequestParams| {
        if READS.contains(&request.kind.as_str()) {
            let p = params.add(value);
            and_where(request, part_eq(p));
        }
        Ok(())
    }
}

async fn labels(db: &Db) -> Vec<String> {
    let rows = polyspec_orm::model::gets(&item(db)).await.expect("gets");
    let mut out: Vec<String> = rows.models().map(|m| m.value("label").expect("label").as_string().expect("label text")).collect();
    out.sort();
    out
}

async fn parts(db: &Db) -> Vec<String> {
    let rows = polyspec_orm::model::gets(&item(db)).await.expect("gets");
    let mut out: Vec<String> = rows.models().map(|m| m.value("part").expect("part").as_string().expect("part text")).collect();
    out.sort();
    out
}

async fn count(db: &Db) -> i64 {
    polyspec_orm::model::get_count(item(db).core()).await.expect("count")
}

async fn without_hook_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed(&db).await;
    assert_eq!(labels(&db).await, ["a1", "a2", "b1"]);
    assert_eq!(count(&db).await, 3);
    let hooked = db.with_request_hook(read_filter_hook("a"));
    assert_eq!(count(&hooked).await, 2, "the hooked handle filters");
    // Even after a handle with a hook is made, the connection and its clones read all rows without the hook.
    assert_eq!(labels(&db).await, ["a1", "a2", "b1"]);
    assert_eq!(count(&db).await, 3);
    assert_eq!(count(&db.clone()).await, 3);
    db.close().await;
    database.drop().await;
}

async fn read_filter_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed(&db).await;
    let hooked = db.with_request_hook(read_filter_hook("a"));
    assert_eq!(labels(&hooked).await, ["a1", "a2"]);
    assert_eq!(count(&hooked).await, 2);
    let page = polyspec_orm::model::gets_page(&item(&hooked), 1, 10).await.expect("page");
    assert_eq!(page.total_count, 2);
    assert_eq!(page.items.len(), 2);
    // Requests of the same shape use one plan, even if the values the hook adds differ.
    let other = db.with_request_hook(read_filter_hook("b"));
    assert_eq!(labels(&other).await, ["b1"]);
    assert_eq!(count(&other).await, 1);
    let statement = polyspec_orm::model::get_query(item(&hooked).core()).await.expect("get_query");
    assert!(statement.sql.contains("part"), "get_query passes the hook: {}", statement.sql);
    assert_eq!(statement.binds, vec![Param::from("a")]);
    db.close().await;
    database.drop().await;
}

async fn insert_assign_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let hooked = db.with_request_hook(|request: &mut Request, params: &mut RequestParams| {
        if request.kind == "insert" {
            let p = params.add("h");
            request.set.push(Assign { column: "part".into(), p: Some(p), ..Default::default() });
            for row in &mut request.rows {
                let p = params.add("h");
                row.push(p);
            }
        }
        Ok(())
    });
    let mut single = with_values(item(&hooked), &[("label", "one")]);
    polyspec_orm::model::create(&mut single).await.expect("create");
    let rows = vec![with_values(unconnected(), &[("label", "two")]), with_values(unconnected(), &[("label", "three")])];
    let n = polyspec_orm::model::creates(&item(&hooked), rows, 2).await.expect("creates");
    assert_eq!(n, 2);
    assert_eq!(labels(&db).await, ["one", "three", "two"]);
    assert_eq!(parts(&db).await, ["h", "h", "h"]);
    db.close().await;
    database.drop().await;
}

async fn reads_params_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(None::<Param>));
    let record = seen.clone();
    let hooked = db.with_request_hook(move |request: &mut Request, params: &mut RequestParams| {
        if request.kind == "insert" {
            for assign in &request.set {
                if assign.column == "label" {
                    *record.lock().expect("seen") = assign.p.and_then(|p| params.get(p)).cloned();
                }
            }
        }
        Ok(())
    });
    let mut row = with_values(item(&hooked), &[("part", "r"), ("label", "read")]);
    polyspec_orm::model::create(&mut row).await.expect("create");
    assert_eq!(*seen.lock().expect("seen"), Some(Param::from("read")), "the hook reads the value bound to the assignment");
    db.close().await;
    database.drop().await;
}

async fn loaded_row_writes_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed(&db).await;
    let kinds: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = kinds.clone();
    let hooked = db.with_request_hook(move |request: &mut Request, params: &mut RequestParams| {
        seen.lock().unwrap().push(request.kind.clone());
        if request.kind == "update" || request.kind == "delete" {
            let p = params.add("none");
            and_where(request, part_eq(p));
        }
        Ok(())
    });
    let rows = polyspec_orm::model::gets(&item(&hooked)).await.expect("gets");
    let mut row = rows.models().find(|m| m.value("label").and_then(|v| v.as_string().ok()).as_deref() == Some("a1")).expect("a1").clone();
    row.core_mut().set("label", Param::from("changed"));
    polyspec_orm::model::update(&mut row, false).await.expect("update");
    assert_eq!(kinds.lock().unwrap().last().map(String::as_str), Some("update"), "the update of a loaded row passes the hook");
    assert_eq!(labels(&db).await, ["a1", "a2", "b1"], "the hook predicate kept the update from matching");
    polyspec_orm::model::delete(&row, false).await.expect("delete");
    assert_eq!(kinds.lock().unwrap().last().map(String::as_str), Some("delete"), "the delete of a loaded row passes the hook");
    assert_eq!(count(&db).await, 3, "the hook predicate kept the delete from matching");
    // A transaction started on a handle with a hook also applies the hook to models without a connection.
    kinds.lock().unwrap().clear();
    let n = hooked.transaction(async || polyspec_orm::model::get_count(unconnected().core()).await).await.expect("transaction");
    assert_eq!(n, 3);
    assert_eq!(*kinds.lock().unwrap(), ["count"], "the model of the transaction passes the hook");
    db.close().await;
    database.drop().await;
}

/// A hook_upsert model connected to db (or to nothing when db is None) with values set.
fn upsert_row(db: Option<&Db>, values: &[(&str, Param)]) -> HookUpsert {
    let mut core = Core::new(&HOOK_UPSERT);
    if let Some(db) = db {
        core.connect(db);
    }
    let mut m = HookUpsert::from_core(core);
    for (column, value) in values {
        m.core_mut().set(column, value.clone());
    }
    m
}

/// The insert of the upsert sets scope_col through the hook, and the conflict key (scope_col, name) is checked after the hook.
/// The caller sets only name; the update sets hits. The first call inserts and the second updates the row.
async fn upsert_scope_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let hooked = db.with_request_hook(|request: &mut Request, params: &mut RequestParams| {
        if request.kind == "insert" {
            let p = params.add("a");
            request.set.push(Assign { column: "scope_col".into(), p: Some(p), ..Default::default() });
        }
        Ok(())
    });
    for call in 1..=2 {
        let mut m = upsert_row(Some(&hooked), &[("name", Param::from("k"))]);
        m.core_mut().duplication(upsert_row(None, &[("hits", Param::from(7_i64))]).into_core());
        polyspec_orm::model::create(&mut m).await.unwrap_or_else(|e| panic!("upsert call {call} = {e:?}, want the row inserted or updated"));
    }
    let rows = polyspec_orm::model::gets(&upsert_row(Some(&db), &[])).await.expect("gets");
    let stored: Vec<(String, String, Option<i64>)> =
        rows.models().map(|m| (text_of(m, "scope_col"), text_of(m, "name"), m.value("hits").and_then(|v| v.as_i64().ok()))).collect();
    assert_eq!(stored, [("a".to_owned(), "k".to_owned(), Some(7))]);
    db.close().await;
    database.drop().await;
}

async fn invalid_param_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed(&db).await;
    let statements = Arc::new(Mutex::new(0usize));
    let counted = statements.clone();
    let _subscription = db
        .subscribe(move |_: &polyspec_orm::StatementEvent<'_>| {
            *counted.lock().unwrap() += 1;
            Ok(())
        })
        .expect("subscribe");
    let hooked = db.with_request_hook(|request: &mut Request, _: &mut RequestParams| {
        let p = request.n_params + 5;
        and_where(request, part_eq(p));
        Ok(())
    });
    let error = polyspec_orm::model::get_count(item(&hooked).core()).await.expect_err("an index outside the parameters");
    assert_eq!(error.code(), polyspec_orm::codes::IR_INVALID, "{error}");
    assert_eq!(*statements.lock().unwrap(), 0, "no statement runs");
    db.close().await;
    database.drop().await;
}

/// The set names label and the hook's condition names part: together they cover the unique key.
async fn restore_key_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let ids = seed_deleted_entries(&db).await;
    let hooked = db.with_request_hook(part_scope_hook("a"));
    let row = polyspec_orm::model::restore(&entry(&hooked, &[("label", Param::from("x")), ("note", Param::from("n1"))])).await.expect("restore");
    assert_eq!((id_of(&row), text_of(&row, "part"), text_of(&row, "label"), text_of(&row, "note")), (ids["ax"], "a".into(), "x".into(), "n1".into()));
    assert_eq!(entry_rows(&db).await, vec![(ids["ax"], "n1".to_owned())], "the connection reads only (a, x)");
    db.close().await;
    database.drop().await;
}

/// The set names the primary key; the hook's condition narrows the restore to the rows of its part.
async fn restore_condition_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let ids = seed_deleted_entries(&db).await;
    let values = [("id", Param::I64(ids["ay"])), ("note", Param::from("n2"))];
    let outside = db.with_request_hook(part_scope_hook("b"));
    let error = polyspec_orm::model::restore(&entry(&outside, &values)).await.err().expect("a restore outside the hook condition");
    assert_eq!(error.code(), polyspec_orm::codes::NO_ROWS, "{error}");
    assert_eq!(entry_rows(&db).await, vec![], "the restore outside the hook condition restores no row");
    let inside = db.with_request_hook(part_scope_hook("a"));
    let row = polyspec_orm::model::restore(&entry(&inside, &values)).await.expect("restore");
    assert_eq!((id_of(&row), text_of(&row, "label"), text_of(&row, "note")), (ids["ay"], "y".into(), "n2".into()));
    db.close().await;
    database.drop().await;
}

/// Part from the hook and no label cover no key: IR_INVALID before any statement.
async fn restore_no_key_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed_deleted_entries(&db).await;
    let statements = Arc::new(Mutex::new(0usize));
    let counted = statements.clone();
    let _subscription = db
        .subscribe(move |_: &polyspec_orm::StatementEvent<'_>| {
            *counted.lock().unwrap() += 1;
            Ok(())
        })
        .expect("subscribe");
    let hooked = db.with_request_hook(part_scope_hook("a"));
    let error = polyspec_orm::model::restore(&entry(&hooked, &[("note", Param::from("n3"))])).await.err().expect("a restore without a key");
    assert_eq!(error.code(), polyspec_orm::codes::IR_INVALID, "{error}");
    assert_eq!(*statements.lock().unwrap(), 0, "no statement runs");
    db.close().await;
    database.drop().await;
}

/// The hook scopes the restore to part a and gives the model's label its own value y.
async fn restore_rewritten_key_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let ids = seed_deleted_entries(&db).await;
    let scope = part_scope_hook("a");
    let hooked = db.with_request_hook(move |request: &mut Request, params: &mut RequestParams| {
        if request.kind == "restore" {
            for a in request.set.iter_mut().filter(|a| a.column == "label") {
                a.p = Some(params.add("y"));
            }
        }
        scope(request, params)
    });
    let row = polyspec_orm::model::restore(&entry(&hooked, &[("label", Param::from("x")), ("note", Param::from("n4"))])).await.expect("restore");
    assert_eq!((id_of(&row), text_of(&row, "label"), text_of(&row, "note")), (ids["ay"], "y".into(), "n4".into()));
    assert_eq!(entry_rows(&db).await, vec![(ids["ay"], "n4".to_owned())], "the connection reads only (a, y)");
    db.close().await;
    database.drop().await;
}

/// The hook puts part a first in the set; the model's label completes the unique key.
async fn restore_hook_set_key_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let ids = seed_deleted_entries(&db).await;
    let hooked = db.with_request_hook(|request: &mut Request, params: &mut RequestParams| {
        if request.kind == "restore" {
            let p = params.add("a");
            request.set.insert(0, Assign { column: "part".into(), p: Some(p), ..Default::default() });
        }
        Ok(())
    });
    let row = polyspec_orm::model::restore(&entry(&hooked, &[("label", Param::from("x")), ("note", Param::from("n5"))])).await.expect("restore");
    assert_eq!((id_of(&row), text_of(&row, "part"), text_of(&row, "note")), (ids["ax"], "a".into(), "n5".into()));
    assert_eq!(entry_rows(&db).await, vec![(ids["ax"], "n5".to_owned())], "the connection reads only (a, x)");
    db.close().await;
    database.drop().await;
}

/// The hook gives the model's label its own value y and sets part a after it, with no where parameter.
async fn restore_rewritten_key_set_scope_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let ids = seed_deleted_entries(&db).await;
    let hooked = db.with_request_hook(|request: &mut Request, params: &mut RequestParams| {
        if request.kind == "restore" {
            for a in request.set.iter_mut().filter(|a| a.column == "label") {
                a.p = Some(params.add("y"));
            }
            let p = params.add("a");
            request.set.push(Assign { column: "part".into(), p: Some(p), ..Default::default() });
        }
        Ok(())
    });
    let row = polyspec_orm::model::restore(&entry(&hooked, &[("label", Param::from("x")), ("note", Param::from("n6"))])).await.expect("restore");
    assert_eq!((id_of(&row), text_of(&row, "label"), text_of(&row, "note")), (ids["ay"], "y".into(), "n6".into()));
    assert_eq!(entry_rows(&db).await, vec![(ids["ay"], "n6".to_owned())], "the connection reads only (a, y)");
    db.close().await;
    database.drop().await;
}

#[tokio::test]
async fn restore_rewritten_key_set_scope() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_rewritten_key_set_scope_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_restore_rewritten_key_set_scope() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_rewritten_key_set_scope_case(feature_database()).await;
}

/// The database feature-check chose (ORM_FEATURE_DATABASE). The coverage case creates and drops its own case database on that database,
/// and does not read or write the database of ORM_FEATURE_DSN.
fn feature_database() -> &'static str {
    match std::env::var("ORM_FEATURE_DATABASE").as_deref() {
        Ok("mysql") => "mysql",
        Ok("postgres") => "postgres",
        Ok("sqlite") => "sqlite",
        _ => panic!("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case"),
    }
}

#[tokio::test]
async fn without_hook() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    without_hook_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_without_hook() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    without_hook_case(feature_database()).await;
}

#[tokio::test]
async fn read_filter() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    read_filter_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_read_filter() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    read_filter_case(feature_database()).await;
}

#[tokio::test]
async fn reads_params() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    reads_params_case("sqlite").await;
}

#[tokio::test]
async fn insert_assign() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    insert_assign_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_insert_assign() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    insert_assign_case(feature_database()).await;
}

#[tokio::test]
async fn loaded_row_writes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    loaded_row_writes_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_loaded_row_writes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    loaded_row_writes_case(feature_database()).await;
}

#[tokio::test]
async fn upsert_scope() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    upsert_scope_case("sqlite").await;
}

#[tokio::test]
async fn invalid_param() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    invalid_param_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_invalid_param() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    invalid_param_case(feature_database()).await;
}

#[tokio::test]
async fn restore_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_key_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_restore_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_key_case(feature_database()).await;
}

#[tokio::test]
async fn restore_condition() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_condition_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_restore_condition() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_condition_case(feature_database()).await;
}

#[tokio::test]
async fn restore_no_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_no_key_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_restore_no_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_no_key_case(feature_database()).await;
}

#[tokio::test]
async fn restore_rewritten_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_rewritten_key_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_restore_rewritten_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_rewritten_key_case(feature_database()).await;
}

#[tokio::test]
async fn restore_hook_set_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_hook_set_key_case("sqlite").await;
}

#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_request_hook_restore_hook_set_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_hook_set_key_case(feature_database()).await;
}

// Parts of a multi-row insert (docs/spec/protocol.md §2.1, contracts/fixtures/insert_parts.json): creates take rows in the given order
// and split them into batches of the given size, each one INSERT, run in one transaction. Checked on a connection without a hook.

/// A subscription that collects the INSERT statement SQL of db in execution order.
fn insert_statements(db: &Db) -> (Arc<Mutex<Vec<String>>>, polyspec_orm::Subscription) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let subscription = db
        .subscribe(move |event: &polyspec_orm::StatementEvent<'_>| {
            if event.sql.starts_with("INSERT") {
                sink.lock().unwrap().push(event.sql.to_owned());
            }
            Ok(())
        })
        .expect("subscribe");
    (seen, subscription)
}

fn labelled(labels: &[String]) -> Vec<HookItem> {
    labels.iter().map(|label| with_values(unconnected(), &[("part", "p"), ("label", label)])).collect()
}

/// A batch of 0 is CONFIG and a batch over the bind limit is BATCH_TOO_LARGE, both before any statement.
#[tokio::test]
async fn creates_parts_shapes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
    let db = installed(&database).await;
    let (seen, subscription) = insert_statements(&db);
    let rows = |n: usize| labelled(&(0..n).map(|i| format!("s{i}")).collect::<Vec<_>>());
    let error = polyspec_orm::model::creates(&item(&db), rows(3), 0).await.expect_err("batch 0");
    assert_eq!(error.code(), polyspec_orm::codes::CONFIG, "{error}");
    let error = polyspec_orm::model::creates(&item(&db), rows(500), 500).await.expect_err("500 rows of two columns");
    assert_eq!(error.code(), polyspec_orm::codes::BATCH_TOO_LARGE, "{error}");
    drop(subscription);
    assert!(seen.lock().unwrap().is_empty(), "refused creates ran no INSERT");
    assert_eq!(count(&db).await, 0, "no row was written");
    db.close().await;
    database.drop().await;
}

/// 13 rows in batches of 6 are inserted as INSERTs of 6, 6, and 1 rows in the given order, and the keys rise in that order.
#[tokio::test]
async fn creates_parts_order() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
    let db = installed(&database).await;
    let (seen, subscription) = insert_statements(&db);
    let given: Vec<String> = (0..13).map(|i| format!("r{:02}", 12 - i)).collect();
    assert_eq!(polyspec_orm::model::creates(&item(&db), labelled(&given), 6).await.expect("creates"), 13);
    drop(subscription);
    let sizes: Vec<usize> = seen.lock().unwrap().iter().map(|sql| sql.matches("(?").count()).collect();
    assert_eq!(sizes, [6, 6, 1], "INSERT batches in order");
    let rows = polyspec_orm::model::gets(&item(&db)).await.expect("gets");
    let mut stored: Vec<(i64, String)> = rows.models().map(|m| (id_of(m), text_of(m, "label"))).collect();
    stored.sort();
    assert_eq!(stored.iter().map(|(_, label)| label.clone()).collect::<Vec<_>>(), given, "rows in the given order");
    db.close().await;
    database.drop().await;
}

/// If the third batch fails, the first batches are is also rolled back, and no rows remain.
#[tokio::test]
async fn creates_parts_rollback() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
    let db = installed(&database).await;
    let mut rows = labelled(&(0..8).map(|i| format!("ok{i}")).collect::<Vec<_>>());
    let mut failing = with_values(unconnected(), &[("part", "p")]);
    failing.core_mut().set("label", Param::Null);
    rows.push(failing);
    polyspec_orm::model::creates(&item(&db), rows, 4).await.expect_err("the third batch fails");
    assert_eq!(count(&db).await, 0, "no row of the call remains");
    db.close().await;
    database.drop().await;
}
