// The native machine boundary of compiled-step execution (CORE-127, FMS-42).

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
