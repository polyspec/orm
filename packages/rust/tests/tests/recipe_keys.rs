// The key checks of the Rust recipe loader, and the DSN of model.connect (FCV-2 to FCV-4).
#[test]
fn model_connect_opens_the_case_database_the_socket_or_the_text() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    use polyspec_orm_tests::recipe::connect_dsn;
    let case = "mysql://root@127.0.0.1:3306/orm_case_17";
    assert_eq!(connect_dsn(None, "mysql", case, None).unwrap(), case);
    assert_eq!(connect_dsn(Some("case"), "mysql", case, None).unwrap(), case);
    assert_eq!(connect_dsn(Some("sqlite://x"), "sqlite", case, None).unwrap(), "sqlite://x");
    assert_eq!(connect_dsn(Some("case-socket"), "mysql", case, Some("/s/mysql.sock")).unwrap(), "mysql://root@localhost/orm_case_17?socket=/s/mysql.sock");
    assert!(connect_dsn(Some("case-socket"), "postgres", case, Some("/s/mysql.sock")).unwrap_err().contains("needs mysql"));
    assert!(connect_dsn(Some("case-socket"), "mysql", case, Some("")).unwrap_err().contains("is unset"));
}

use polyspec_orm_tests::recipe_keys::check_keys;

// A recipe at a path whose $schema is the recipe schema of this checkout, so the key table beside it is read.
const PATH: &str = "contracts/fixtures/model_writes/model_writes.json";
const SCHEMA: &str = "../../../scripts/features/schema/recipe.schema.json";
const STEP: &str = r#"{"op": "dsn.connect", "dsn": "case"}"#;

/// A recipe with the file keys `file`, the case keys `case` (each ending in a comma when not empty) and one step `step`.
fn recipe(file: &str, case: &str, step: &str) -> String {
    format!(r#"{{"$schema": "{SCHEMA}", {file}"cases": [{{"id": "case-under-test", {case}"steps": [{step}]}}]}}"#)
}

#[test]
fn a_recipe_whose_keys_the_table_holds_is_accepted() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    assert_eq!(check_keys(PATH, &recipe("", "", STEP)), Ok(()));
}

#[test]
fn an_unknown_file_key_is_refused_by_name() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = check_keys(PATH, &recipe(r#""bogus": 1, "#, "", STEP)).unwrap_err();
    assert_eq!(error, format!("recipe {PATH}: unknown key bogus"));
}

#[test]
fn an_unknown_case_key_is_refused_by_name_with_its_case() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = check_keys(PATH, &recipe("", r#""bogus": 1, "#, STEP)).unwrap_err();
    assert_eq!(error, format!("recipe {PATH} case case-under-test: unknown key bogus"));
}

#[test]
fn an_unknown_op_is_refused_by_name_with_its_step() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = check_keys(PATH, &recipe("", "", r#"{"op": "no.such.op"}"#)).unwrap_err();
    assert_eq!(error, format!("recipe {PATH} case case-under-test step 0: unknown op no.such.op"));
}

#[test]
fn a_step_key_another_op_holds_is_refused_on_the_op_that_does_not_hold_it() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let step = r#"{"op": "dsn.connect", "dsn": "case", "pool_size": 2}"#;
    let error = check_keys(PATH, &recipe("", "", step)).unwrap_err();
    assert_eq!(error, format!("recipe {PATH} case case-under-test step 0 (dsn.connect): unknown key pool_size"));
}

#[test]
fn a_recipe_with_no_schema_is_refused_since_it_names_no_key_table() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = check_keys(PATH, r#"{"cases": []}"#).unwrap_err();
    assert_eq!(error, format!("recipe {PATH}: no $schema names the recipe key table"));
}

#[test]
fn a_step_key_that_the_run_does_not_read_fails_by_name() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let step = serde_json::json!({"op": "dsn.connect", "dsn": "case", "reason": "for the reader", "bogus": 1});
    polyspec_orm_tests::recipe_reads::read(&step, "dsn");
    assert_eq!(polyspec_orm_tests::recipe_reads::check(&step).unwrap_err(), "the helper did not read bogus of dsn.connect");
    polyspec_orm_tests::recipe_reads::read(&step, "dsn");
    polyspec_orm_tests::recipe_reads::read(&step, "bogus");
    assert_eq!(polyspec_orm_tests::recipe_reads::check(&step), Ok(()));
}

#[test]
fn an_outcome_key_that_no_compare_takes_fails_by_name() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let expected = serde_json::json!({"error": "X", "bogus": 1});
    let error = polyspec_orm_tests::recipe_reads::check_outcome(Some(&expected), "dsn.connect", &["error"]).unwrap_err();
    assert_eq!(error, "the helper did not read expect.bogus of dsn.connect");
}
