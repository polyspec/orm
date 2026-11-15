// The native machine boundary of compiled-step execution (CORE-127, FMS-42).

use binding_core::machine::{Machine, Step};
use std::sync::{Arc, Mutex};
use tokio::runtime::Runtime;

use crate::db::Pool;
use crate::test_support::Scratch;
use crate::{Config, Db, Error, Execute, Kind, OrmValue};

// Requirements: CORE-127. The async driver calls an owned machine constructor while the caller retains its Db.
#[test]
fn execute_machine_contract_names_the_owned_constructor() {
    let _case = polyspec_orm_testcase::case!();
    let contract: serde_json::Value = serde_json::from_str(include_str!("../../interface.json")).expect("interface contract");
    let execute = contract["units"]
        .as_array()
        .expect("units")
        .iter()
        .flat_map(|unit| unit["members"].as_array().into_iter().flatten())
        .find(|member| member["id"] == "db.execute")
        .expect("db.execute");
    assert_eq!(execute["core"]["machine"], true, "the async driver requires an owned machine");
    assert_eq!(execute["core"]["path"], "polyspec_orm::Db::execute_text_machine");
    assert_eq!(execute["core"]["receiver"], "&self", "the binding clones the receiver; it does not consume its instance");
}

/// A compiled insert from a committed model, with its own physical database and statement observer.
struct Fixture {
    db: Db,
    runtime: Runtime,
    step: String,
    statements: Arc<Mutex<Vec<String>>>,
    subscription: Option<crate::Subscription>,
    _scratch: Scratch,
}

impl Fixture {
    fn new() -> Self {
        let scratch = Scratch::new("orm-execute-machine");
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("runtime");
        let db = runtime.block_on(Db::connect(&format!("sqlite://{}", scratch.join("execute.sqlite").display()), 1, Config::default())).expect("connect");
        // Construct the owner before preparation so its Drop closes the database on a later preparation failure too.
        let mut fixture = Self { db, runtime, step: String::new(), statements: Arc::new(Mutex::new(Vec::new())), subscription: None, _scratch: scratch };
        let model = crate::testing::ir_request::schema("contracts/fixtures/conformance_verification/conformance_shared.dbs");
        let request = serde_json::json!({
            "ir_version": 1, "manifest_hash": model.manifest_hash,
            "kind": "insert", "entity": "shared_note",
            "set": [{"column": "seq", "p": 0}, {"column": "title", "p": 1}], "n_params": 2,
        });
        let plan: serde_json::Value =
            serde_json::from_str(&model.compile(&request.to_string(), "sqlite").expect("compile the insert")).expect("the compiled plan is JSON");
        fixture.step = plan["steps"][0].to_string();
        let Pool::Sqlite(pool) = fixture.db.pool() else { panic!("the fixture uses SQLite") };
        fixture.runtime.block_on(async {
            let mut connection = pool.acquire().await.expect("the fixture owns its setup connection");
            sqlx::query("CREATE TABLE shared_note (seq INTEGER PRIMARY KEY, title TEXT NOT NULL)")
                .execute(&mut *connection)
                .await
                .expect("create the fixture table");
            connection.return_to_pool().await;
        });
        let statements = Arc::clone(&fixture.statements);
        fixture.subscription = Some(
            fixture
                .db
                .subscribe(move |event: &crate::StatementEvent<'_>| {
                    statements.lock().expect("the statement observer is usable").push(event.sql.to_owned());
                    Ok(())
                })
                .expect("subscribe"),
        );
        fixture
    }

    fn values(id: i64) -> Vec<OrmValue> {
        vec![OrmValue::Int64(id), OrmValue::Text("owned λ\0text".into())]
    }

    fn drive(&self, mut machine: Execute) -> Result<(), Error> {
        let Step::Io(io) = machine.resume(None) else { panic!("execute gives exactly one Io, without Call or Await") };
        let result = self.runtime.block_on(io);
        let Step::Done(result) = machine.resume(Some(result)) else { panic!("execute gives Done immediately after its Io") };
        result
    }

    fn rows(&self) -> Vec<(i64, String)> {
        let Pool::Sqlite(pool) = self.db.pool() else { panic!("the fixture uses SQLite") };
        self.runtime.block_on(sqlx::query_as("SELECT seq, title FROM shared_note ORDER BY seq").fetch_all(pool)).expect("read the stored values")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(subscription) = self.subscription.take() {
            subscription.unsubscribe();
        }
        self.runtime.block_on(self.db.close_async());
    }
}

// Requirements: CORE-127, FMS-42. The native constructor owns compiled parameters, stores their exact value through
// one Io and returns its result without a callback. The existing native future API remains usable on the same Db.
#[test]
fn execute_machine_stores_compiled_parameters_and_preserves_the_native_api() {
    let _case = polyspec_orm_testcase::case!();
    let fixture = Fixture::new();
    fixture.drive(fixture.db.clone().execute_text_machine(fixture.step.clone(), Fixture::values(7))).expect("the machine executes its compiled insert");
    assert_eq!(fixture.db.stats().in_use, 0);
    assert_eq!(fixture.statements.lock().expect("statements").len(), 1, "the single Io sends one compiled statement");
    let rows = fixture.rows();
    assert_eq!(rows.len(), 1, "the single statement stores exactly one row");
    assert_eq!(rows[0].0, 7);
    assert_eq!(rows[0].1.as_bytes(), b"owned \xce\xbb\0text", "the owned text preserves UTF-8 and its embedded zero byte");
    fixture.runtime.block_on(fixture.db.execute_text(&fixture.step, Fixture::values(8))).expect("the native future API still executes");
    assert_eq!(fixture.rows().iter().map(|row| row.0).collect::<Vec<_>>(), [7, 8]);
    let native = fixture.runtime.block_on(fixture.db.execute_text(&fixture.step, Fixture::values(7))).expect_err("the native call reports a duplicate");
    let machine = fixture
        .drive(fixture.db.clone().execute_text_machine(fixture.step.clone(), Fixture::values(7)))
        .expect_err("the machine reports the same storage failure");
    assert_eq!(native.kind(), Kind::DuplicateKey, "{native}");
    assert_eq!(machine.kind(), native.kind());
    assert_eq!(machine.to_string(), native.to_string());
}

// Requirements: CORE-127, FMS-42. Delegation preserves parse, step validation and scalar conversion order, including
// their exact native errors. A refused call sends no statement and changes no stored row.
#[test]
fn execute_machine_preserves_native_refusals_and_validation_order() {
    let _case = polyspec_orm_testcase::case!();
    let fixture = Fixture::new();
    let cases = [
        ("not JSON".to_owned(), vec![OrmValue::List(Vec::new())], Kind::Config),
        ("{}".to_owned(), vec![OrmValue::List(Vec::new())], Kind::Config),
        (fixture.step.clone(), vec![OrmValue::List(Vec::new()), OrmValue::Null], Kind::CodecEncode),
        (fixture.step.clone(), vec![OrmValue::Int64(7)], Kind::IrInvalid),
    ];
    for (step, params, expected) in cases {
        let native = fixture.runtime.block_on(fixture.db.execute_text(&step, params.clone())).expect_err("the native operation refuses the input");
        let machine = fixture.drive(fixture.db.clone().execute_text_machine(step, params)).expect_err("the machine refuses the input");
        assert_eq!(native.kind(), expected, "{native}");
        assert_eq!(machine.kind(), native.kind());
        assert_eq!(machine.to_string(), native.to_string());
    }
    assert!(fixture.statements.lock().expect("statements").is_empty(), "validation refuses before sending any statement");
    assert!(fixture.rows().is_empty());
}

// Requirements: CORE-127. Before admission, dropping the owner and its unpolled Io sends nothing. A returned future
// owns its Db, step and parameters independently; after owner Drop it can complete on the runtime's worker thread.
#[test]
fn execute_machine_io_owns_its_inputs_independently_of_its_driver() {
    let _case = polyspec_orm_testcase::case!();
    for stage in 0..3 {
        let fixture = Fixture::new();
        let mut machine = fixture.db.clone().execute_text_machine(fixture.step.clone(), Fixture::values(7));
        assert!(fixture.statements.lock().expect("statements").is_empty());
        if stage == 0 {
            drop(machine);
        } else {
            let Step::Io(io) = machine.resume(None) else { panic!("the machine yields its owned future") };
            assert!(fixture.statements.lock().expect("statements").is_empty(), "advancement makes no I/O");
            drop(machine);
            if stage == 1 {
                drop(io);
            } else {
                fixture.runtime.block_on(fixture.runtime.spawn(io)).expect("the independent owned future is Send and static").expect("execute");
            }
        }
        assert_eq!(fixture.db.stats().in_use, 0);
        assert_eq!(fixture.statements.lock().expect("statements").len(), usize::from(stage == 2));
        assert_eq!(fixture.rows().len(), usize::from(stage == 2));
    }
}
