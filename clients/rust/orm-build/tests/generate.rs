//! Generation from scanned source: the methods the source calls are
//! generated, and a call the schema does not allow fails with its position.

use std::path::PathBuf;

fn schema() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../orm/tests/testdata/zone_schema.json")
}

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn generate(source: &str) -> Result<String, String> {
    generate_with_schema(schema(), source)
}

fn generate_with_schema(schema: PathBuf, source: &str) -> Result<String, String> {
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-test-{}-{n}", std::process::id()));
    let src = dir.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("main.rs"), source).unwrap();
    let out = orm_build::Builder::new(schema).scan(&src).out_dir(dir.join("out")).try_generate();
    let text = out.map(|p| std::fs::read_to_string(p).unwrap());
    let _ = std::fs::remove_dir_all(&dir);
    text
}

#[test]
fn generates_called_methods() {
    let text = generate(
        r#"
        fn main() {
            let q = ZoneEvent::new().gt_start_dt(now).or_seq(vec![1, 2]).order_by_seq_desc_and_start_dt_asc();
            let n = ZoneEvent::new().get_count_by_seq_and_ne_start_dt(1, now);
            let r = ZoneEvent::new().add_raw_column_total("{seq} * ?", [2]).new_label("x");
            assert_eq!(r.get_total(), r.get_label());
        }
        "#,
    )
    .unwrap();
    for want in [
        "pub fn gt_start_dt<V0: orm::args::CmpArg<orm::args::kind::Time>>(mut self, v0: V0) -> Self",
        "pub fn or_seq<V0: orm::args::EqArg<orm::args::kind::Int>>(mut self, v0: V0) -> Self",
        "pub fn order_by_seq_desc_and_start_dt_asc(mut self) -> Self",
        "pub async fn get_count_by_seq_and_ne_start_dt<V0: orm::args::EqArg<orm::args::kind::Int>, V1: orm::args::EqArg<orm::args::kind::Time>>(&self, v0: V0, v1: V1) -> orm::Result<i64>",
        "pub fn add_raw_column_total(mut self, sql: &str, binds: impl orm::Binds) -> Self",
        "pub fn get_total(&self) -> orm::Result<Option<orm::serde_json::Value>>",
        "pub fn get_label(&self) -> orm::Result<Option<orm::serde_json::Value>>",
        "pub static SCHEMA: orm::Schema",
    ] {
        assert!(text.contains(want), "missing {want}");
    }
    assert!(!text.contains("pub fn and_seq("), "a method that is not called was generated");
}

#[test]
fn generated_rows_reject_unselected_fields_and_separate_group_results() {
    let text = generate("fn main() { let row = ZoneEvent::new(); let _ = row.get_start_dt(); let _ = row.gets_count(); }").unwrap();
    assert!(!text.contains("pub start_dt:"), "typed fields cannot bypass checked getters");
    assert!(text.contains("pub fn get_start_dt(&self) -> orm::Result<orm::chrono::NaiveDateTime>"), "getter must report missing selection");
    assert!(text.contains("pub async fn gets_count(&self) -> orm::Result<orm::GroupRows>"), "group rows must not be partial models");
}

#[test]
fn nullable_json_fields_keep_sql_null_separate_from_json_null() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../schema/schema.json");
    let text = generate_with_schema(
        root,
        "fn main() { let row = Battle::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())); let _ = row.get_jsons_tags(); }",
    )
    .unwrap();
    assert!(text.contains("jsons_tags: Option<orm::ordered_json::Value>"), "nullable ordered JSON must represent SQL NULL separately");
    assert!(text.contains("serialize_data: Option<orm::serde_json::Value>"), "nullable styled JSON must represent SQL NULL separately");
    assert!(
        text.contains("pub fn set_jsons_tags(mut self, v: orm::StyledValue<orm::ordered_json::Value>) -> orm::Result<Self>"),
        "styled setter requires an explicit state"
    );
    assert!(text.contains("pub fn get_jsons_tags(&self) -> orm::Result<orm::StyledValue<orm::ordered_json::Value>>"), "styled getter reports a checked state");
    assert!(text.contains("self.jsons_tags = Some(value);"), "setter retains a stored JSON value");
    assert!(text.contains("self.jsons_tags = if v.is_null() { None }"), "row assignment distinguishes SQL NULL");
    assert!(text.contains("self.__orm.require_field(\"jsons_tags\")?;"), "unselected field access must fail");
}

#[test]
fn column_function_order_takes_the_function() {
    let text = generate("fn main() { ZoneEvent::new().order_by_start_dt_asc(orm::year()); }").unwrap();
    assert!(text.contains("pub fn order_by_start_dt_asc(mut self, f: orm::Func) -> Self"));
    assert!(text.contains("pub fn order_by_seq_asc(mut self) -> Self"));
}

#[test]
fn rejects_unknown_names_of_a_known_model() {
    let err = generate("fn main() {\n    ZoneEvent::new().and_lk_start_dt(\"x\").name(\"y\");\n}\n").unwrap_err();
    assert!(err.contains("main.rs:2:22: ZoneEvent has no method and_lk_start_dt"), "{err}");
    assert!(err.contains("main.rs:2:43: ZoneEvent has no method name"), "{err}");
}

#[test]
fn rejects_argument_count() {
    let err = generate("fn main() { let x = ZoneEvent::new(); x.seq(1, 2); }").unwrap_err();
    assert!(err.contains("ZoneEvent::seq takes 1 values, not 2"), "{err}");
}

#[test]
fn ignores_calls_of_other_types() {
    let text = generate("fn main() { let v = vec![1]; v.len(); v.iter().map(|x| x + 1); }").unwrap();
    assert!(!text.contains("pub fn len"));
}

#[test]
fn rejects_edited_schema() {
    let dir = std::env::temp_dir().join(format!("orm-build-edited-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let text = std::fs::read_to_string(schema()).unwrap().replace("start_dt", "begin_dt");
    std::fs::write(dir.join("schema.json"), text).unwrap();
    let err = orm_build::Builder::new(dir.join("schema.json")).out_dir(dir.join("out")).try_generate().unwrap_err();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(err.contains("edited by hand"), "{err}");
}

#[test]
fn styled_setter_result_handling_preserves_model_calls() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../schema/schema.json");
    for handler in ["expect(\"assigned config\")", "unwrap()"] {
        let source = format!("fn main() {{ let row = Battle::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())).{handler}; let _ = row.get_jsons_tags(); }}");
        let text = generate_with_schema(root.clone(), &source).expect("Result handling must not be a column call");
        assert!(text.contains("pub fn get_jsons_tags"));
        assert!(!text.contains("pub fn expect"));
        assert!(!text.contains("pub fn unwrap"));
    }
}

#[test]
fn unknown_model_call_after_setter_result_handling_still_fails() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../schema/schema.json");
    let error = generate_with_schema(
        root,
        "fn main() { let _ = Battle::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())).expect(\"config\").missing_method(); }",
    )
    .expect_err("unknown model call must fail");
    assert!(error.contains("missing_method"), "{error}");
}

#[test]
fn styled_setter_result_transformations_are_not_column_calls() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../schema/schema.json");
    for handling in ["map_err(|error| error)?", "map_err(|error| error).map(Some)"] {
        let source = format!("fn main() {{ let row = Battle::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())).{handling}; }}");
        let text = generate_with_schema(root.clone(), &source).expect("Result transformations are not columns");
        assert!(!text.contains("pub fn map_err"));
        assert!(!text.contains("pub fn map("));
    }
}

#[test]
fn unknown_model_after_result_error_mapping_still_fails() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../schema/schema.json");
    for handling in ["map_err(|error| error)?", "map_err(|error| error).unwrap()"] {
        let source = format!("fn main() {{ let row = Battle::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())).{handling}; row.missing_method(); }}");
        let error = generate_with_schema(root.clone(), &source).expect_err("unknown model call must fail");
        assert!(error.contains("missing_method"), "{error}");
        assert!(!error.contains("MapErr"), "{error}");
    }
}

#[test]
fn infallible_setter_does_not_accept_result_methods() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../schema/schema.json");
    let error = generate_with_schema(root, "fn main() { Battle::new().set_seq(1).map_err(|error| error); }")
        .expect_err("infallible model setter does not return Result");
    assert!(error.contains("map_err"), "{error}");
}

#[test]
fn bound_setter_results_preserve_model_calls_after_extraction() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../schema/schema.json");
    let source = "fn main() { let result = Battle::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())); let row = result.map_err(|error| error).unwrap(); row.missing_method(); }";
    let error = generate_with_schema(root, source).expect_err("bound Result must retain its model after extraction");
    assert!(error.contains("missing_method"), "{error}");
    assert!(!error.contains("MapErr"), "{error}");
}
