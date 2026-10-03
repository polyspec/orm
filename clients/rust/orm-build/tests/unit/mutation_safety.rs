use super::*;

#[tokio::test]
async fn borrowed_bind_validation_stops_at_its_count_budget() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let value = P::I(1);
        let error = tool_db::validate_param_refs(std::iter::repeat(&value), "postgres").unwrap_err();
        assert!(error.to_string().contains("TOOL_BIND_LIMIT"));
    })
    .await
    .expect("borrowed bind deadline");
}

#[tokio::test]
async fn absent_trigger_privilege_is_not_proof_of_absent_triggers() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
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
