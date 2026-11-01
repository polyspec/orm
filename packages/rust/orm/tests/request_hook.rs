//! The request hook of a connection handle (docs/operations/usage.md "Request hook"): the handle returned by `Db::with_request_hook`
//! uses the same connection, and its hook receives the request and `RequestParams` for each request of the handle, just before planning.
//! The recipe contracts/fixtures/request_hook/request_hook.json (tests/request_hook_<database>.rs in polyspec-orm-tests) runs the
//! cases that a declarative step can observe. This file keeps the sub-assertions that a step cannot observe, under their case IDs
//! (without_hook, read_filter, relation_scope, restore_no_key), and the cases that stay native (reads_params, invalid_param,
//! restore_rewritten_key, restore_hook_set_key, restore_rewritten_key_set_scope). Each runs in a SQLite case database
//! (polyspec-orm-case-database, the file is deleted when it ends or panics). `coverage_request_hook_<case>` runs the same case
//! on the database that feature-check chose, in that database's case database (docs/spec/feature-coverage.md).
//!
//! `cargo test -p polyspec-orm --test request_hook -- --exact <case>` runs a SQLite case; a coverage case needs the
//! database of make feature-check, which runs it by its exact name.

#[macro_use]
#[path = "common/model_row.rs"]
mod model_row;

#[path = "common/feature_database.rs"]
mod feature_database;

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use polyspec_orm::core::{Arg, ChainKey};
use polyspec_orm::ir::{Assign, Group, Item, Pred, Query, Request};
use polyspec_orm::{Core, Db, Entity, Model, Param, RequestParams, Schema};
use polyspec_orm_case_database::CaseDatabase;

static HOOK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/request_hook/request_hook.dbs"), "sha256:b9ee83943930e19f474fe2c98ef5f6facd4ad40551becbdcb81b74ab5f2167ea");
static HOOK_ITEM: Entity = Entity {
    name: "hook_item",
    schema: &HOOK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<HookItem>,
    collect: polyspec_orm::model::collect_boxed::<HookItem>,
};
const COLUMNS: [&str; 3] = ["id", "part", "label"];

model_row!(HookItem, HOOK_ITEM, COLUMNS);

static HOOK_ENTRY: Entity = Entity {
    name: "hook_entry",
    schema: &HOOK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<HookEntry>,
    collect: polyspec_orm::model::collect_boxed::<HookEntry>,
};
const ENTRY_COLUMNS: [&str; 4] = ["id", "part", "label", "note"];

// A row of the soft delete table hook_entry, whose unique key is (part, label).
model_row!(HookEntry, HOOK_ENTRY, ENTRY_COLUMNS);

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
    row.value(column).unwrap_or_else(|| panic!("column {column} has no value")).as_string().or_panic(|e| format!("{column}: {e}"))
}

/// The id value of row.
fn id_of<M: Model>(row: &M) -> i64 {
    row.value("id").expect("id").as_i64().expect("id integer")
}

/// Asserts that an invalid request is rejected before a statement runs.
fn assert_invalid_before_statement(error: &polyspec_orm::Error, statements: &Arc<Mutex<usize>>) {
    assert_eq!(error.code(), polyspec_orm::codes::IR_INVALID, "{error}");
    assert_eq!(*statements.lock().unwrap(), 0, "no statement runs");
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

/// A service scope: adds `part = value` to the where of the root of every read and of each of its relation queries,
/// nested relations included, as an application scopes every table of a request.
fn service_scope_hook(value: &'static str) -> impl Fn(&mut Request, &mut RequestParams) -> polyspec_orm::Result<()> + Send + Sync + 'static {
    fn scope(query: &mut Query, params: &mut RequestParams, value: &'static str) {
        let mut pred = part_eq(params.add(value));
        query.where_ = Some(match query.where_.take() {
            None => Group { items: vec![Item::Pred { pred: Box::new(pred) }], ..Default::default() },
            Some(existing) => {
                pred.conn = "and".into();
                Group { items: vec![Item::Group { group: existing }, Item::Pred { pred: Box::new(pred) }], ..Default::default() }
            }
        });
        for relation in &mut query.relations {
            scope(&mut relation.query, params, value);
        }
    }
    move |request: &mut Request, params: &mut RequestParams| {
        if READS.contains(&request.kind.as_str()) {
            scope(&mut request.query, params, value);
        }
        Ok(())
    }
}

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

async fn count(db: &Db) -> i64 {
    polyspec_orm::model::get_count(item(db).core()).await.expect("count")
}

/// The root of the hooked handle is the connection in Go; Rust exposes no root, so this checks that a clone of the connection
/// still reads every row after a handle with a hook is made, which a step cannot observe.
async fn without_hook_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed(&db).await;
    let _hooked = db.with_request_hook(read_filter_hook("a"));
    assert_eq!(count(&db.clone()).await, 3, "a clone of the connection reads all rows without the hook");
    db.close().await;
    database.drop().await;
}

/// The recipe checks the rows of the hooked reads; this checks that the planned get_query binds the hook's value, which a
/// step cannot observe.
async fn read_filter_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed(&db).await;
    let hooked = db.with_request_hook(read_filter_hook("a"));
    let statement = polyspec_orm::model::get_query(item(&hooked).core()).await.expect("get_query");
    assert!(statement.binds.contains(&Param::from("a")), "hooked get_query binds {:?} carry no a", statement.binds);
    db.close().await;
    database.drop().await;
}

/// The `part/label` of each row, sorted.
fn part_labels<'a>(rows: impl Iterator<Item = &'a HookItem>) -> Vec<String> {
    let mut out: Vec<String> = rows.map(|row| format!("{}/{}", text_of(row, "part"), text_of(row, "label"))).collect();
    out.sort();
    out
}

/// The hook_entry rows that handle reads, with label when it is given, and their relation (many or one) to child
/// matched by label.
async fn entries_with_items(handle: &Db, many: bool, mut child: HookItem, label: Option<&str>) -> polyspec_orm::Collection<HookEntry> {
    const BY_LABEL: &[ChainKey] = &[ChainKey { conn: "", op: "", column: "label", columns: &[], compare: "" }];
    let mut parent = entry(handle, &[]);
    if let Some(label) = label {
        parent = HookEntry::from_core(parent.core().by(BY_LABEL, vec![Arg::Value(polyspec_orm::args::Value::One(Param::from(label)))]));
    }
    child.core_mut().add_match("label", "label");
    parent.core_mut().relation(many, child.into_core());
    polyspec_orm::model::gets(&parent).await.or_panic(|e| format!("gets with the relation: {e}"))
}

/// relation() and relations() run under a service scope. The recipe checks the scoped relation with the child read on the hooked
/// connection; this checks the child read on the unhooked connection (a model without a connection of its own), which a step
/// cannot observe. The parent a1 of part a matches the items labeled a1 of parts a and b by label, and under the scope of part
/// a it attaches only the item of part a.
async fn relation_scope_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed(&db).await;
    let mut extra = with_values(item(&db), &[("part", "b"), ("label", "a1")]);
    polyspec_orm::model::create(&mut extra).await.expect("create the item a1 of part b");
    for (part, label) in [("a", "a1"), ("b", "b1")] {
        let mut parent = entry(&db, &[("part", Param::from(part)), ("label", Param::from(label))]);
        polyspec_orm::model::create(&mut parent).await.expect("create entry");
    }
    let scoped = db.with_request_hook(service_scope_hook("a"));
    let many = entries_with_items(&scoped, true, unconnected(), None).await;
    let got: Vec<(String, Vec<String>)> = many
        .models()
        .map(|row| {
            let children = row.core().related_many::<HookItem>("hook_item_models").expect("hook_item_models").expect("a relation result");
            (text_of(row, "label"), part_labels(children.models()))
        })
        .collect();
    assert_eq!(got, [("a1".to_owned(), vec!["a/a1".to_owned()])], "{driver}: relations() under the scope of part a (child unconnected)");
    let one = entries_with_items(&scoped, false, unconnected(), None).await;
    let got: Vec<(String, Option<String>)> = one
        .models()
        .map(|row| {
            let attached = row.core().related_one::<HookItem>("hook_item_model").expect("hook_item_model");
            (text_of(row, "label"), attached.map(|child| text_of(child, "part")))
        })
        .collect();
    assert_eq!(got, [("a1".to_owned(), Some("a".to_owned()))], "{driver}: relation() under the scope of part a (child unconnected)");
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
    assert_eq!(labels(&db).await, ["read"], "the hook cannot change the bound value");
    db.close().await;
    database.drop().await;
}

async fn invalid_param_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed(&db).await;
    let (statements, _subscription) = count_statements(&db);
    let hooked = db.with_request_hook(|request: &mut Request, _: &mut RequestParams| {
        let p = request.n_params + 5;
        and_where(request, part_eq(p));
        Ok(())
    });
    let error = polyspec_orm::model::get_count(item(&hooked).core()).await.expect_err("an index outside the parameters");
    assert_invalid_before_statement(&error, &statements);
    db.close().await;
    database.drop().await;
}

/// Part from the hook and no label cover no key: IR_INVALID before any statement.
async fn restore_no_key_case(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    seed_deleted_entries(&db).await;
    let (statements, _subscription) = count_statements(&db);
    let hooked = db.with_request_hook(part_scope_hook("a"));
    let error = polyspec_orm::model::restore(&entry(&hooked, &[("note", Param::from("n3"))])).await.err().expect("a restore without a key");
    assert_invalid_before_statement(&error, &statements);
    db.close().await;
    database.drop().await;
}

/// The hook scopes the restore to part a and gives the model's label its own value y.
async fn restore_rewritten_key_case(driver: &str) {
    let scope = part_scope_hook("a");
    restore_scoped_entry_case(driver, "n4", "ay", "label", "y", "the connection reads only (a, y)", move |request, params| {
        if request.kind == "restore" {
            rewrite_label(request, params, "y");
        }
        scope(request, params)
    })
    .await;
}

/// The hook puts part a first in the set; the model's label completes the unique key.
async fn restore_hook_set_key_case(driver: &str) {
    restore_scoped_entry_case(driver, "n5", "ax", "part", "a", "the connection reads only (a, x)", |request, params| {
        if request.kind == "restore" {
            assign_part(request, params, "a", AssignmentPosition::First);
        }
        Ok(())
    })
    .await;
}

/// The hook gives the model's label its own value y and sets part a after it, with no where parameter.
async fn restore_rewritten_key_set_scope_case(driver: &str) {
    restore_scoped_entry_case(driver, "n6", "ay", "label", "y", "the connection reads only (a, y)", |request, params| {
        if request.kind == "restore" {
            rewrite_label(request, params, "y");
            assign_part(request, params, "a", AssignmentPosition::Last);
        }
        Ok(())
    })
    .await;
}

async fn restore_scoped_entry_case<F>(driver: &str, note: &str, key: &str, column: &str, value: &str, expected_read: &str, configure: F)
where
    F: Fn(&mut Request, &mut RequestParams) -> polyspec_orm::Result<()> + Send + Sync + 'static,
{
    let database = CaseDatabase::create(driver).await;
    let db = installed(&database).await;
    let ids = seed_deleted_entries(&db).await;
    let hooked = db.with_request_hook(configure);
    let row = polyspec_orm::model::restore(&entry(&hooked, &[("label", Param::from("x")), ("note", Param::from(note))])).await.expect("restore");
    assert_eq!((id_of(&row), text_of(&row, column), text_of(&row, "note")), (ids[key], value.into(), note.into()));
    assert_eq!(entry_rows(&db).await, vec![(ids[key], note.to_owned())], "{expected_read}");
    db.close().await;
    database.drop().await;
}

#[tokio::test]
async fn restore_rewritten_key_set_scope() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_rewritten_key_set_scope_case("sqlite").await;
}

// Requirements: DIA-161.
#[tokio::test]
async fn coverage_request_hook_restore_rewritten_key_set_scope() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_rewritten_key_set_scope_case(feature_database::selected()).await;
}

/// The database feature-check chose (ORM_FEATURE_DATABASE). The coverage case creates and drops its own case database on that database,
/// and does not read or write the database of ORM_FEATURE_DSN.
fn rewrite_label(request: &mut Request, params: &mut RequestParams, value: &str) {
    for assignment in request.set.iter_mut().filter(|assignment| assignment.column == "label") {
        assignment.p = Some(params.add(value));
    }
}

enum AssignmentPosition {
    First,
    Last,
}

fn assign_part(request: &mut Request, params: &mut RequestParams, value: &str, position: AssignmentPosition) {
    let assignment = Assign { column: "part".into(), p: Some(params.add(value)), ..Default::default() };
    match position {
        AssignmentPosition::First => request.set.insert(0, assignment),
        AssignmentPosition::Last => request.set.push(assignment),
    }
}

fn count_statements(db: &Db) -> (Arc<Mutex<usize>>, polyspec_orm::Subscription) {
    let statements = Arc::new(Mutex::new(0usize));
    let counted = statements.clone();
    let subscription = db
        .subscribe(move |_: &polyspec_orm::StatementEvent<'_>| {
            *counted.lock().unwrap() += 1;
            Ok(())
        })
        .expect("subscribe");
    (statements, subscription)
}

#[tokio::test]
async fn without_hook() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    without_hook_case("sqlite").await;
}

// Requirements: INT-78.
#[tokio::test]
async fn coverage_request_hook_without_hook() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    without_hook_case(feature_database::selected()).await;
}

#[tokio::test]
async fn read_filter() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    read_filter_case("sqlite").await;
}

// Requirements: INT-78.
#[tokio::test]
async fn relation_scope() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    relation_scope_case("sqlite").await;
}

// Requirements: INT-78.
#[tokio::test]
async fn coverage_request_hook_relation_scope() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    relation_scope_case(feature_database::selected()).await;
}

// Requirements: INT-78, PRT-2.
#[tokio::test]
async fn coverage_request_hook_read_filter() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    read_filter_case(feature_database::selected()).await;
}

// Requirements: INT-78.
#[tokio::test]
async fn reads_params() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    reads_params_case("sqlite").await;
}

#[tokio::test]
async fn invalid_param() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    invalid_param_case("sqlite").await;
}

// Requirements: PRT-65.
#[tokio::test]
async fn coverage_request_hook_invalid_param() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    invalid_param_case(feature_database::selected()).await;
}

#[tokio::test]
async fn restore_no_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_no_key_case("sqlite").await;
}

// Requirements: DIA-161.
#[tokio::test]
async fn coverage_request_hook_restore_no_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_no_key_case(feature_database::selected()).await;
}

#[tokio::test]
async fn restore_rewritten_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_rewritten_key_case("sqlite").await;
}

// Requirements: DIA-161.
#[tokio::test]
async fn coverage_request_hook_restore_rewritten_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_rewritten_key_case(feature_database::selected()).await;
}

#[tokio::test]
async fn restore_hook_set_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_hook_set_key_case("sqlite").await;
}

// Requirements: DIA-161.
#[tokio::test]
async fn coverage_request_hook_restore_hook_set_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    restore_hook_set_key_case(feature_database::selected()).await;
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
