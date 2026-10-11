//! 연결 handle의 request hook (docs/usage.md "Request hook"): `Db::with_request_hook`이 돌려준 handle은
//! 같은 연결을 쓰고, 그 hook은 handle의 request마다 plan 직전에 request와 `RequestParams`를 받는다.
//! contracts/fixtures/request_hook.dbs의 공유 case 다섯 개를 SQLite case database(polyspec-orm-case-database,
//! 끝나거나 panic하면 file을 지운다)에서 실행한다: without_hook, read_filter, insert_assign,
//! loaded_row_writes, invalid_param.
//!
//! `cargo test -p polyspec-orm --test request_hook`

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use polyspec_orm::ir::{Assign, Group, Item, Pred, Request};
use polyspec_orm::{Core, Db, Entity, Model, Param, RequestParams, Schema, Val};
use polyspec_orm_case_database::CaseDatabase;

static HOOK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/request_hook.dbs"), "sha256:7c6bde698909203534632b3a0c8c27c34f2f48068788710382bd739664ba4193");
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

/// db에 연결한 model이다.
fn item(db: &Db) -> HookItem {
    let mut core = Core::new(&HOOK_ITEM);
    core.connect(db);
    HookItem::from_core(core)
}

/// 연결 없이 transaction에서 실행하는 model이다.
fn unconnected() -> HookItem {
    HookItem::from_core(Core::new(&HOOK_ITEM))
}

/// values를 set한 model이다.
fn with_values(mut m: HookItem, values: &[(&str, &str)]) -> HookItem {
    for (column, value) in values {
        m.core_mut().set(column, Param::from(*value));
    }
    m
}

/// SQLite case database에 fixture를 설치한 연결이다.
async fn installed(database: &CaseDatabase) -> Db {
    let db = Db::connect(database.dsn(), 2, polyspec_orm::Config::default()).await.expect("connect");
    db.utils().schema().install(&HOOK_SCHEMA).await.expect("install");
    db
}

/// 연결로 행 a1, a2(part a)와 b1(part b)을 넣는다.
async fn seed(db: &Db) {
    for (part, label) in [("a", "a1"), ("a", "a2"), ("b", "b1")] {
        let mut m = with_values(item(db), &[("part", part), ("label", label)]);
        polyspec_orm::model::create(&mut m).await.expect("seed");
    }
}

/// request의 root where에 pred를 AND로 붙인다. 이미 있는 where는 group item 하나가 된다.
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

/// 읽기 request의 root where에 `part = value`를 붙이는 hook이다.
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

#[tokio::test]
async fn without_hook() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
    let db = installed(&database).await;
    seed(&db).await;
    assert_eq!(labels(&db).await, ["a1", "a2", "b1"]);
    assert_eq!(count(&db).await, 3);
    let hooked = db.with_request_hook(read_filter_hook("a"));
    assert_eq!(count(&hooked).await, 2, "the hooked handle filters");
    // hook이 있는 handle을 만든 뒤에도 연결과 그 clone은 hook 없이 모든 행을 읽는다.
    assert_eq!(labels(&db).await, ["a1", "a2", "b1"]);
    assert_eq!(count(&db).await, 3);
    assert_eq!(count(&db.clone()).await, 3);
    db.close().await;
    database.drop().await;
}

#[tokio::test]
async fn read_filter() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
    let db = installed(&database).await;
    seed(&db).await;
    let hooked = db.with_request_hook(read_filter_hook("a"));
    assert_eq!(labels(&hooked).await, ["a1", "a2"]);
    assert_eq!(count(&hooked).await, 2);
    let page = polyspec_orm::model::gets_page(&item(&hooked), 1, 10).await.expect("page");
    assert_eq!(page.total_count, 2);
    assert_eq!(page.items.len(), 2);
    // 같은 형태의 request는 hook이 더한 값이 달라도 한 plan을 쓴다.
    let other = db.with_request_hook(read_filter_hook("b"));
    assert_eq!(labels(&other).await, ["b1"]);
    assert_eq!(count(&other).await, 1);
    let statement = polyspec_orm::model::get_query(item(&hooked).core()).await.expect("get_query");
    assert!(statement.sql.contains("part"), "get_query passes the hook: {}", statement.sql);
    assert_eq!(statement.binds, vec![Param::from("a")]);
    db.close().await;
    database.drop().await;
}

#[tokio::test]
async fn insert_assign() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
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
    let n = polyspec_orm::model::creates(&item(&hooked), rows).await.expect("creates");
    assert_eq!(n, 2);
    assert_eq!(labels(&db).await, ["one", "three", "two"]);
    assert_eq!(parts(&db).await, ["h", "h", "h"]);
    db.close().await;
    database.drop().await;
}

#[tokio::test]
async fn loaded_row_writes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
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
    let mut row = rows.models().find(|m| m.value("label") == Some(Val::Str("a1".into()))).expect("a1").clone();
    row.core_mut().set("label", Param::from("changed"));
    polyspec_orm::model::update(&mut row, false).await.expect("update");
    assert_eq!(kinds.lock().unwrap().last().map(String::as_str), Some("update"), "the update of a loaded row passes the hook");
    assert_eq!(labels(&db).await, ["a1", "a2", "b1"], "the hook predicate kept the update from matching");
    polyspec_orm::model::delete(&row, false).await.expect("delete");
    assert_eq!(kinds.lock().unwrap().last().map(String::as_str), Some("delete"), "the delete of a loaded row passes the hook");
    assert_eq!(count(&db).await, 3, "the hook predicate kept the delete from matching");
    // hook이 있는 handle에서 시작한 transaction은 연결 없는 model에도 hook을 준다.
    kinds.lock().unwrap().clear();
    let n = hooked.transaction(async || polyspec_orm::model::get_count(unconnected().core()).await).await.expect("transaction");
    assert_eq!(n, 3);
    assert_eq!(*kinds.lock().unwrap(), ["count"], "the model of the transaction passes the hook");
    db.close().await;
    database.drop().await;
}

#[tokio::test]
async fn invalid_param() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
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
