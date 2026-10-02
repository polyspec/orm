//! Generation from scanned source: the methods the source calls are
//! generated, and a call the schema does not allow fails with its position.

use std::path::PathBuf;

fn schema() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/fixtures/zone.dbs")
}

fn bench() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../schema/bench.dbs")
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
    let out = orm_build::Builder::new([schema]).scan(&src).out_dir(dir.join("out")).try_generate();
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
        "pub static SCHEMA: orm::Schema = orm::Schema::new(include_str!(",
        "pub const MANIFEST_HASH: &str = \"sha256:c889e6d039d9245e5093d386a7c707419fddf5f9a303d39a5eb7cca4c8499891\";",
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
    let root = bench();
    let text = generate_with_schema(
        root,
        "fn main() { let row = Author::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())); let _ = row.get_jsons_tags(); }",
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
fn rejects_an_invalid_document() {
    let dir = std::env::temp_dir().join(format!("orm-build-invalid-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let text = std::fs::read_to_string(schema()).unwrap().replace("start_dt datetime(6)", "start_dt datetime(9)");
    std::fs::write(dir.join("zone.dbs"), text).unwrap();
    let err = orm_build::Builder::new([dir.join("zone.dbs")]).out_dir(dir.join("out")).try_generate().unwrap_err();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(err.contains("zone.dbs: SCHEMA_INVALID 5:"), "{err}");
}

/// dbspec::read_file이 parse 전에 DbSchema project XML과 빈 파일을 signature로 거부한다.
#[test]
fn rejects_a_file_without_the_signature() {
    for name in ["dbschema.dbs", "empty.dbs"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/dbspec/files").join(name);
        let out = std::env::temp_dir().join(format!("orm-build-signature-{}-{name}", std::process::id()));
        let err = orm_build::Builder::new([path.clone()]).out_dir(out.clone()).try_generate().unwrap_err();
        assert!(!out.exists(), "{name}: generation wrote {}", out.display());
        let display = path.display();
        assert_eq!(err, format!("{display}: SCHEMA_INVALID 1:1 signature: {display} is not a dbspec document"), "{name}");
    }
}

#[test]
fn manifest_text_is_embedded_with_its_hash() {
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-manifest-{}-{n}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
    let audit = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/fixtures/audit.dbs");
    orm_build::Builder::new([schema(), audit.clone()]).scan(dir.join("src")).out_dir(dir.join("out")).try_generate().unwrap();
    let embedded = std::fs::read_to_string(dir.join("out").join(orm_build::MANIFEST_FILE)).unwrap();
    let zone = std::fs::read_to_string(schema()).unwrap();
    let audit = std::fs::read_to_string(audit).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(embedded, format!("{audit}{zone}"), "the manifest text holds the documents in name order");
}

#[test]
fn generated_field_types_follow_the_runtime_model() {
    let text = generate_with_schema(
        bench(),
        "fn main() { let row = Author::new(); let _ = row.get_gz_extend(); let _ = row.get_base64_extra(); let _ = row.get_ip(); let _ = row.get_aes_hex_email(); }",
    )
    .unwrap();
    assert!(text.contains("pub fn get_gz_extend(&self) -> orm::Result<orm::StyledValue<orm::serde_json::Value>>"), "gz is a styled value");
    assert!(text.contains("pub fn get_base64_extra(&self) -> orm::Result<orm::StyledValue<orm::serde_json::Value>>"), "base64 is a styled value");
    assert!(
        text.contains("pub fn set_gz_extend(mut self, v: orm::StyledValue<orm::serde_json::Value>) -> orm::Result<Self>"),
        "gz setter takes a styled value"
    );
    assert!(text.contains("pub fn get_ip(&self) -> orm::Result<Option<&str>>"), "ip is the address text");
    assert!(text.contains("pub fn get_aes_hex_email(&self) -> orm::Result<Option<&str>>"), "aes hex is a string");
    assert!(text.contains("pub fn force_index_uq_author_uuid(mut self) -> Self"), "a unique key takes an index hint");
}

#[test]
fn styled_setter_result_handling_preserves_model_calls() {
    let root = bench();
    for handler in ["expect(\"assigned config\")", "unwrap()"] {
        let source = format!("fn main() {{ let row = Author::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())).{handler}; let _ = row.get_jsons_tags(); }}");
        let text = generate_with_schema(root.clone(), &source).expect("Result handling must not be a column call");
        assert!(text.contains("pub fn get_jsons_tags"));
        assert!(!text.contains("pub fn expect"));
        assert!(!text.contains("pub fn unwrap"));
    }
}

#[test]
fn unknown_model_call_after_setter_result_handling_still_fails() {
    let root = bench();
    let error = generate_with_schema(
        root,
        "fn main() { let _ = Author::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())).expect(\"config\").missing_method(); }",
    )
    .expect_err("unknown model call must fail");
    assert!(error.contains("missing_method"), "{error}");
}

#[test]
fn styled_setter_result_transformations_are_not_column_calls() {
    let root = bench();
    for handling in ["map_err(|error| error)?", "map_err(|error| error).map(Some)"] {
        let source = format!("fn main() {{ let row = Author::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())).{handling}; }}");
        let text = generate_with_schema(root.clone(), &source).expect("Result transformations are not columns");
        assert!(!text.contains("pub fn map_err"));
        assert!(!text.contains("pub fn map("));
    }
}

#[test]
fn unknown_model_after_result_error_mapping_still_fails() {
    let root = bench();
    for handling in ["map_err(|error| error)?", "map_err(|error| error).unwrap()"] {
        let source = format!("fn main() {{ let row = Author::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())).{handling}; row.missing_method(); }}");
        let error = generate_with_schema(root.clone(), &source).expect_err("unknown model call must fail");
        assert!(error.contains("missing_method"), "{error}");
        assert!(!error.contains("MapErr"), "{error}");
    }
}

#[test]
fn infallible_setter_does_not_accept_result_methods() {
    let root = bench();
    let error = generate_with_schema(root, "fn main() { Author::new().set_seq(1).map_err(|error| error); }")
        .expect_err("infallible model setter does not return Result");
    assert!(error.contains("map_err"), "{error}");
}

#[test]
fn bound_setter_results_preserve_model_calls_after_extraction() {
    let root = bench();
    let source = "fn main() { let result = Author::new().set_jsons_tags(orm::StyledValue::Value(orm::ordered_json::Value::null())); let row = result.map_err(|error| error).unwrap(); row.missing_method(); }";
    let error = generate_with_schema(root, source).expect_err("bound Result must retain its model after extraction");
    assert!(error.contains("missing_method"), "{error}");
    assert!(!error.contains("MapErr"), "{error}");
}
