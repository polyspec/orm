use super::*;
use crate::tool_db::GridCell;

#[tokio::test]
// Requirements: INT-120.
async fn borrowed_bind_validation_stops_at_its_count_budget() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let value = P::I(1);
        let error = tool_db::validate_param_refs(std::iter::repeat(&value), "postgres").unwrap_err();
        assert!(error.to_string().contains("TOOL_BIND_LIMIT"));
    })
    .await
    .expect("borrowed bind deadline");
}

#[tokio::test]
// Requirements: INT-119.
async fn absent_trigger_privilege_is_not_proof_of_absent_triggers() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut result = GridQueryResult { columns: vec![], rows: vec![] };
        assert!(require_trigger_privilege(&result).unwrap_err().starts_with("ROW_MUTATION_UNSUPPORTED"));
        result.rows = vec![vec![GridCell::Text("TRIGGER".into())]];
        require_trigger_privilege(&result).unwrap();
        result.rows = vec![vec![GridCell::Text("SELECT".into())]];
        assert!(require_trigger_privilege(&result).is_err());
    })
    .await
    .expect("trigger visibility deadline");
}

#[tokio::test]
async fn rust_duplicate_row_mutations_choose_the_declared_dialect_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        assert_eq!(write_transaction_statement("mysql"), "START TRANSACTION");
        assert_eq!(write_transaction_statement("postgres"), "BEGIN");
        assert_eq!(write_transaction_statement("sqlite"), "BEGIN IMMEDIATE");
    })
    .await
    .expect("transaction statement deadline");
}

#[tokio::test]
async fn rust_duplicate_row_mutations_share_cancellation_and_key_preflight() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let original = crate::catalog::test_fixtures::row_snapshot("fixture", "value", "INTEGER");
        let phases = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let phases_for_publish = phases.clone();
        let publish: Publisher = std::sync::Arc::new(move |phase| phases_for_publish.lock().unwrap().push(phase));

        let keys = prepare_mutation(&original, "sqlite", &AtomicBool::new(false), &publish).unwrap();
        assert!(matches!(keys.as_slice(), [P::I(1)]));
        assert_eq!(*phases.lock().unwrap(), [MutationPhase::Validated]);

        phases.lock().unwrap().clear();
        let error = match prepare_mutation(&original, "sqlite", &AtomicBool::new(true), &publish) {
            Err(error) => error,
            Ok(_) => panic!("cancelled mutation must fail preflight"),
        };
        assert!(error.starts_with("JOB_CANCELLED:"));
        assert!(phases.lock().unwrap().is_empty(), "a cancelled mutation is not published as validated");
    })
    .await
    .expect("mutation preflight deadline");
}
