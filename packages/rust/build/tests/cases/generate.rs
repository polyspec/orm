//! Generation from scanned source: the methods the source calls are
//! generated, and a call the schema does not allow fails with its position.

use polyspec_orm_testcase::OrPanic;
use sha2::Digest;
use std::path::{Path, PathBuf};

fn schema() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/zone.dbs")
}

fn bench() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/bench/bench.dbs")
}

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Writes a set under `dir`: each of `documents` copied into `dir/set`, each of `external` into
/// `dir/external`, and the set file `dir/set/dbspec-set.json` listing them. Returns the set file.
fn set_file(dir: &Path, documents: &[PathBuf], external: &[PathBuf]) -> PathBuf {
    let copy = |into: &str, path: &PathBuf| {
        let name = path.file_name().expect("a document has a file name").to_str().expect("a UTF-8 name").to_owned();
        std::fs::create_dir_all(dir.join(into)).unwrap();
        std::fs::copy(path, dir.join(into).join(&name)).or_panic(|e| format!("{}: {e}", path.display()));
        name
    };
    let documents: Vec<String> = documents.iter().map(|p| copy("set", p)).collect();
    let external: Vec<String> = external.iter().map(|p| format!("../external/{}", copy("external", p))).collect();
    let set = dir.join("set/dbspec-set.json");
    std::fs::write(&set, serde_json::json!({"schema": 1, "documents": documents, "external": external}).to_string()).unwrap();
    set
}

fn generate(source: &str) -> Result<String, String> {
    generate_with_schema(schema(), source)
}

fn generate_with_schema(schema: PathBuf, source: &str) -> Result<String, String> {
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-test-{}-{n}", std::process::id()));
    let set = set_file(&dir, &[schema], &[]);
    generate_with_set(dir, source, set)
}

fn generate_with_document(document: &str, source: &str) -> Result<String, String> {
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-fulltext-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("fulltext.dbs");
    std::fs::write(&path, document).unwrap();
    let result = generate_with_schema(path, source);
    remove_test_dir(&dir);
    result
}

fn generate_with_set(dir: PathBuf, source: &str, set: PathBuf) -> Result<String, String> {
    let src = dir.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("main.rs"), source).unwrap();
    let out = polyspec_orm_build::Builder::set(set).scan(&src).out_dir(dir.join("out")).try_generate();
    let text = out.map(|p| std::fs::read_to_string(p).unwrap());
    remove_test_dir(&dir);
    text
}

// The test of DSL-38, DSL-41, DSL-117, DSL-156, INT-27, PLN-1, PLN-40 (docs/spec).
fn generates_called_methods() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate(
        r#"
        fn main() {
            let q = ZoneEvent::new().gt_start_dt(now).or_seq(vec![1, 2]).order_by_seq_desc_and_start_dt_asc();
            let n = ZoneEvent::new().get_count_by_seq_and_ne_start_dt(1, now);
            let r = ZoneEvent::new().add_column_start_dt_alias_total(polyspec_orm::year()).new_label("x");
            assert_eq!(r.get_total(), r.get_label());
        }
        "#,
    )
    .unwrap();
    for want in [
        "pub fn gt_start_dt<V0: polyspec_orm::args::CmpArg<polyspec_orm::args::kind::Time>>(mut self, v0: V0) -> Self",
        "pub fn or_seq<V0: polyspec_orm::args::EqArg<polyspec_orm::args::kind::Int>>(mut self, v0: V0) -> Self",
        "pub fn order_by_seq_desc_and_start_dt_asc(mut self) -> Self",
        "pub async fn get_count_by_seq_and_ne_start_dt<V0: polyspec_orm::args::EqArg<polyspec_orm::args::kind::Int>, V1: polyspec_orm::args::EqArg<polyspec_orm::args::kind::Time>>(&self, v0: V0, v1: V1) -> polyspec_orm::Result<i64>",
        "pub fn add_column_start_dt_alias_total(mut self, f: polyspec_orm::Func) -> Self",
        "pub fn get_total(&self) -> polyspec_orm::Result<Option<polyspec_orm::serde_json::Value>>",
        "pub fn get_label(&self) -> polyspec_orm::Result<Option<polyspec_orm::serde_json::Value>>",
        "pub static SCHEMA: polyspec_orm::Schema = polyspec_orm::Schema::new(include_str!(",
        "pub const MANIFEST_HASH: &str = \"sha256:c889e6d039d9245e5093d386a7c707419fddf5f9a303d39a5eb7cca4c8499891\";",
    ] {
        assert!(text.contains(want), "missing {want}");
    }
    assert!(!text.contains("pub fn and_seq("), "a method that is not called was generated");
}

// Requirements: DSL-33, PRT-75.
fn generates_fulltext_boolean_methods_for_multiple_columns() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate_with_document(
        "dbspec 1 fulltext\ntable article {\n  seq i64 identity\n  name varchar(255)\n  description text\n  short_description text\n  content text\n  primary key (seq)\n}\n",
        "fn main() {\n    Article::new().fulltext_name_with_description(\"keyword\");\n    Article::new().fulltext_boolean_name_with_description(\"keyword\");\n    Article::new().fulltext_boolean_name_with_short_description_with_content(String::from(\"keyword\"));\n}\n",
    )
    .unwrap();
    assert!(text.contains("pub fn fulltext_boolean_name_with_description(mut self, v0: impl Into<String>) -> Self"), "{text}");
    assert!(text.contains("pub fn fulltext_boolean_name_with_short_description_with_content(mut self, v0: impl Into<String>) -> Self"), "{text}");
    assert!(text.contains("op: \"fulltext\", column: \"\", columns: &[\"name\", \"description\"]"), "{text}");
    assert!(text.contains("op: \"fulltext_boolean\", column: \"\", columns: &[\"name\", \"description\"]"), "{text}");
    assert!(text.contains("op: \"fulltext_boolean\", column: \"\", columns: &[\"name\", \"short_description\", \"content\"]"), "{text}");
}

// Requirements: INT-66.
fn generated_code_carries_no_allow_attribute() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // A consumer may deny allow attributes in its workspace lints, so the generated code
    // states only what it needs: a Default beside the no-argument new, and `mut v` only
    // where a conversion takes the value.
    for schema in [schema(), bench()] {
        let text = generate_with_schema(schema.clone(), "fn main() {}").unwrap();
        assert!(!text.contains("#[allow(") && !text.contains("#![allow("), "{}: the generated code carries an allow attribute", schema.display());
        assert!(text.contains("impl Default for "), "{}: a model has no Default", schema.display());
    }
}

// Requirements: DBS-114.
fn generated_rows_reject_unselected_fields_and_separate_group_results() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate("fn main() { let row = ZoneEvent::new(); let _ = row.get_start_dt(); let _ = row.gets_count(); }").unwrap();
    assert!(!text.contains("pub start_dt:"), "typed fields cannot bypass checked getters");
    assert!(text.contains("pub type ZoneEvent = zone_event::ZoneEvent;"), "generated model names remain public types");
    assert!(!text.contains("pub use zone_event::ZoneEvent;"), "generated model exports must not be unused imports");
    assert!(text.contains("pub fn get_start_dt(&self) -> polyspec_orm::Result<polyspec_orm::chrono::NaiveDateTime>"), "getter must report missing selection");
    // A date setter takes the text form, fallible because the text is parsed into the typed field (T189).
    assert!(text.contains("pub fn set_start_dt(mut self, v: impl Into<String>) -> polyspec_orm::Result<Self>"), "a date setter must take text");
    assert!(text.contains("pub async fn gets_count(&self) -> polyspec_orm::Result<polyspec_orm::GroupRows>"), "group rows must not be partial models");
}

// Requirements: DBS-112, DBS-116.
fn nullable_json_fields_keep_sql_null_separate_from_json_null() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    let text = generate_with_schema(
        root,
        "fn main() { let row = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::polyspec_json::Value::null())); let _ = row.get_jsons_tags(); }",
    )
    .unwrap();
    assert!(text.contains("jsons_tags: Option<polyspec_orm::polyspec_json::Value>"), "nullable ordered JSON must represent SQL NULL separately");
    assert!(text.contains("serialize_data: Option<polyspec_orm::serde_json::Value>"), "nullable styled JSON must represent SQL NULL separately");
    assert!(
        text.contains("pub fn set_jsons_tags(mut self, v: polyspec_orm::StyledValue<polyspec_orm::polyspec_json::Value>) -> polyspec_orm::Result<Self>"),
        "styled setter requires an explicit state"
    );
    assert!(
        text.contains("pub fn get_jsons_tags(&self) -> polyspec_orm::Result<polyspec_orm::StyledValue<polyspec_orm::polyspec_json::Value>>"),
        "styled getter reports a checked state"
    );
    assert!(text.contains("self.jsons_tags = Some(value);"), "setter retains a stored JSON value");
    assert!(text.contains("self.jsons_tags = if v.is_null() { None }"), "row assignment distinguishes SQL NULL");
    assert!(text.contains("self.__orm.require_field(\"jsons_tags\")?;"), "unselected field access must fail");
}

fn column_function_order_takes_the_function() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate("fn main() { ZoneEvent::new().order_by_start_dt_asc(polyspec_orm::year()); }").unwrap();
    assert!(text.contains("pub fn order_by_start_dt_asc(mut self, f: polyspec_orm::Func) -> Self"));
    assert!(text.contains("pub fn order_by_seq_asc(mut self) -> Self"));
}

// The test of DSL-37 (docs/spec).
fn rejects_unknown_names_of_a_known_model() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let err = generate("fn main() {\n    ZoneEvent::new().and_lk_start_dt(\"x\").name(\"y\");\n}\n").unwrap_err();
    assert!(err.contains("main.rs:2:22: ZoneEvent has no method and_lk_start_dt"), "{err}");
    assert!(err.contains("main.rs:2:43: ZoneEvent has no method name"), "{err}");
}

fn ignores_calls_of_other_types() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate("fn main() { let v = vec![1]; v.len(); v.iter().map(|x| x + 1); }").unwrap();
    assert!(!text.contains("pub fn len"));
}

// Requirements: DBS-100, DBS-104, DBS-111, DBS-120.
fn manifest_text_is_embedded_with_its_hash() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-manifest-{}-{n}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
    let audit = polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/audit.dbs");
    polyspec_orm_build::Builder::set(set_file(&dir, &[schema(), audit.clone()], &[])).scan(dir.join("src")).out_dir(dir.join("out")).try_generate().unwrap();
    let embedded = std::fs::read_to_string(dir.join("out").join(polyspec_orm_build::MANIFEST_FILE)).unwrap();
    let generated = std::fs::read_to_string(dir.join("out").join(polyspec_orm_build::MODEL_FILE)).unwrap();
    let zone = std::fs::read_to_string(schema()).unwrap();
    let audit = std::fs::read_to_string(audit).unwrap();
    remove_test_dir(&dir);
    assert_eq!(embedded, format!("{audit}{zone}"), "the manifest text holds the documents in name order");
    let digest = sha2::Sha256::digest(embedded.as_bytes());
    let hash = format!("sha256:{digest:x}");
    assert!(generated.contains(&format!("pub const MANIFEST_HASH: &str = {hash:?};")), "generated hash does not match embedded manifest text");
    let audit_position = generated.find("pub struct Audit").expect("the manifest audit entity is generated");
    let zone_position = generated.find("pub struct ZoneEvent").expect("the manifest zone entity is generated");
    assert!(audit_position < zone_position, "generated entities follow manifest document order");
}

// Requirements: DBS-112, DBS-116, DBS-121, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7, INT-8, COD-2.
fn generated_field_types_follow_the_runtime_model() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate_with_schema(
        bench(),
        "fn main() { let row = Author::new(); let _ = row.get_gz_extend(); let _ = row.get_base64_extra(); let _ = row.get_ip(); let _ = row.get_aes_hex_email(); }",
    )
    .unwrap();
    assert!(
        text.contains("pub fn get_gz_extend(&self) -> polyspec_orm::Result<polyspec_orm::StyledValue<polyspec_orm::serde_json::Value>>"),
        "gz is a styled value"
    );
    assert!(
        text.contains("pub fn get_base64_extra(&self) -> polyspec_orm::Result<polyspec_orm::StyledValue<polyspec_orm::serde_json::Value>>"),
        "base64 is a styled value"
    );
    assert!(
        text.contains("pub fn set_gz_extend(mut self, v: polyspec_orm::StyledValue<polyspec_orm::serde_json::Value>) -> polyspec_orm::Result<Self>"),
        "gz setter takes a styled value"
    );
    assert!(text.contains("pub fn get_ip(&self) -> polyspec_orm::Result<Option<&str>>"), "ip is the address text");
    assert!(text.contains("pub fn get_aes_hex_email(&self) -> polyspec_orm::Result<Option<&str>>"), "aes hex is a string");
    assert!(text.contains("pub fn force_index_uq_author_uuid(mut self) -> Self"), "a unique key takes an index hint");

    let document = "dbspec 1 typed\n\ntable typed {\n  seq i64 identity\n  amount decimal(10,2) null\n  ratio f64\n  enabled bool\n  body text\n  payload bytes null\n  day date\n  clock time(3)\n  moment datetime(3) null\n  json_value text null\n  primary key (seq)\n  settings {\n    codec json_value ordered_json\n  }\n}\n";
    let types = generate_with_document(
        document,
        "fn main() { let row = Typed::new(); let _ = row.get_ratio(); let _ = row.get_enabled(); let _ = row.get_body(); let _ = row.get_payload(); let _ = row.get_day(); let _ = row.get_clock(); let _ = row.get_moment(); let _ = row.get_json_value(); }",
    )
    .expect("the typed field schema generates");
    for declaration in [
        "get_amount(&self) -> polyspec_orm::Result<Option<&str>>",
        "set_amount(mut self, v: impl polyspec_orm::IntoNullable<String>) -> polyspec_orm::Result<Self>",
        "get_ratio(&self) -> polyspec_orm::Result<f64>",
        "get_enabled(&self) -> polyspec_orm::Result<bool>",
        "get_body(&self) -> polyspec_orm::Result<&str>",
        "get_payload(&self) -> polyspec_orm::Result<Option<&[u8]>>",
        "get_day(&self) -> polyspec_orm::Result<polyspec_orm::chrono::NaiveDate>",
        "get_clock(&self) -> polyspec_orm::Result<&str>",
        "get_moment(&self) -> polyspec_orm::Result<Option<polyspec_orm::chrono::NaiveDateTime>>",
        "get_json_value(&self) -> polyspec_orm::Result<polyspec_orm::StyledValue<polyspec_orm::polyspec_json::Value>>",
        "pub fn set_day(mut self, v: impl Into<String>) -> polyspec_orm::Result<Self>",
        "pub fn set_moment(mut self, v: impl polyspec_orm::IntoNullable<String>) -> polyspec_orm::Result<Self>",
    ] {
        assert!(types.contains(declaration), "missing generated field type: {declaration}");
    }
}

fn styled_setter_result_handling_preserves_model_calls() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    for handler in ["expect(\"assigned config\")", "unwrap()"] {
        let source = format!("fn main() {{ let row = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::polyspec_json::Value::null())).{handler}; let _ = row.get_jsons_tags(); }}");
        let text = generate_with_schema(root.clone(), &source).expect("Result handling must not be a column call");
        assert!(text.contains("pub fn get_jsons_tags"));
        assert!(!text.contains("pub fn expect("), "Result handling is not a model method");
        assert!(!text.contains("pub fn unwrap"));
    }
}

fn unknown_model_call_after_setter_result_handling_still_fails() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    let error = generate_with_schema(
        root,
        "fn main() { let _ = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::polyspec_json::Value::null())).expect(\"config\").missing_method(); }",
    )
    .expect_err("unknown model call must fail");
    assert!(error.contains("missing_method"), "{error}");
}

fn styled_setter_result_transformations_are_not_column_calls() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    for handling in ["map_err(|error| error)?", "map_err(|error| error).map(Some)"] {
        let source = format!(
            "fn main() {{ let row = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::polyspec_json::Value::null())).{handling}; }}"
        );
        let text = generate_with_schema(root.clone(), &source).expect("Result transformations are not columns");
        assert!(!text.contains("pub fn map_err"));
        assert!(!text.contains("pub fn map("));
    }
}

fn unknown_model_after_result_error_mapping_still_fails() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    for handling in ["map_err(|error| error)?", "map_err(|error| error).unwrap()"] {
        let source = format!("fn main() {{ let row = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::polyspec_json::Value::null())).{handling}; row.missing_method(); }}");
        let error = generate_with_schema(root.clone(), &source).expect_err("unknown model call must fail");
        assert!(error.contains("missing_method"), "{error}");
        assert!(!error.contains("MapErr"), "{error}");
    }
}

fn infallible_setter_does_not_accept_result_methods() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    let error = generate_with_schema(root, "fn main() { Author::new().set_seq(1).map_err(|error| error); }")
        .expect_err("infallible model setter does not return Result");
    assert!(error.contains("map_err"), "{error}");
}

fn bound_setter_results_preserve_model_calls_after_extraction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    let source = "fn main() { let result = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::polyspec_json::Value::null())); let row = result.map_err(|error| error).unwrap(); row.missing_method(); }";
    let error = generate_with_schema(root, source).expect_err("bound Result must retain its model after extraction");
    assert!(error.contains("missing_method"), "{error}");
    assert!(!error.contains("MapErr"), "{error}");
}

/// The relation getter reports a failed downcast as `polyspec_orm::Result` instead of discarding it as None.
fn relation_getters_report_a_mismatched_relation_value() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate_with_schema(
        bench(),
        "fn main() { let b = Author::new().relation(User::new().match_user_seq_with_seq().alias_owner()).relations(ServiceMember::new().match_service_seq_with_service_seq().alias_members()); let _ = b.get_owner(); let _ = b.get_members(); }",
    )
    .unwrap();
    for want in [
        "pub fn get_owner(&self) -> polyspec_orm::Result<Option<&super::user::User>> {\n        self.__orm.related_one::<super::user::User>(\"owner\")\n    }",
        "pub fn get_members(&self) -> polyspec_orm::Result<Option<&polyspec_orm::Collection<super::service_member::ServiceMember>>> {\n        self.__orm.related_many::<super::service_member::ServiceMember>(\"members\")\n    }",
    ] {
        assert!(text.contains(want), "generated source lacks\n{want}");
    }
}

/// The same source and schema give the same generated source however the scan and output path are written (relative to the package directory, absolute,
/// a path with `./`, or a path with a trailing `/`).
fn scan_path_spelling_keeps_the_generated_source() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::create_dir_all(dir.join("tests")).unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() { let _ = ZoneEvent::new().gt_start_dt(now); }").unwrap();
    std::fs::write(dir.join("tests/case.rs"), "fn case() { let _ = ZoneEvent::new().or_seq(vec![1, 2]); }").unwrap();
    // A relative path is relative to the package directory (CARGO_MANIFEST_DIR), so it goes up from that directory to the root and then down into dir.
    let base = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let up: PathBuf = base.components().skip(1).map(|_| "..").collect();
    let relative = up.join(dir.strip_prefix("/").expect("absolute temp dir"));
    let dot = |name: &str| PathBuf::from(format!("{}/./{name}", dir.display()));
    let slash = |name: &str| PathBuf::from(format!("{}/{name}/", dir.display()));
    let spellings: [(&str, [PathBuf; 3]); 4] = [
        ("relative", [relative.join("src"), relative.join("tests"), relative.join("out")]),
        ("absolute", [dir.join("src"), dir.join("tests"), dir.join("out")]),
        ("dot", [dot("src"), dot("tests"), dot("out")]),
        ("trailing_slash", [slash("src"), slash("tests"), slash("out")]),
    ];
    let set = set_file(&dir, &[schema()], &[]);
    let mut texts = Vec::new();
    for (name, [src, tests, out]) in &spellings {
        remove_test_dir(&dir.join("out"));
        let text = polyspec_orm_build::Builder::set(&set).scan(src).scan(tests).out_dir(out).try_generate().map(|p| std::fs::read_to_string(p).unwrap());
        texts.push((*name, text.or_panic(|e| format!("generate {name}: {e}"))));
    }
    remove_test_dir(&dir);
    let first = &texts[0].1;
    assert!(first.contains("pub fn gt_start_dt<") && first.contains("pub fn or_seq<"), "the calls of src and tests are generated");
    for (name, text) in &texts {
        assert!(text == first, "the generated source of the {name} paths differs from the relative paths");
    }
}

fn a_table_named_like_the_runtime_crate_gets_a_model_module_of_its_own() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let schema = dir.join("crate_name.dbs");
    std::fs::write(&schema, "dbspec 1 crate_name\n\ntable polyspec_orm {\n  seq i64 identity\n  primary key (seq)\n}\n").unwrap();
    let text = generate_with_schema(schema, "fn main() { let _ = PolyspecOrm::new(); }");
    remove_test_dir(&dir);
    let text = text.unwrap();
    // Generated code calls the runtime crate as polyspec_orm::, so a model module of the same name shadows that path.
    assert!(text.contains("pub mod polyspec_orm_model {"), "the model module of table polyspec_orm is polyspec_orm_model");
    assert!(!text.contains("pub mod polyspec_orm {"), "a model module named polyspec_orm shadows the runtime crate");
}

fn a_restore_or_create_call_is_a_fixed_method() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // restore_or_create is a method of every generated model (fixed.rs.txt), so a scanned call to it is accepted and the
    // model keeps its own method, not a generated one.
    let text = generate("async fn main() { let _ = ZoneEvent::new().restore_or_create().await; }").unwrap();
    assert!(text.contains("pub async fn restore_or_create(&self) -> polyspec_orm::Result<Self>"), "the fixed method is missing");
}

/// The builder takes its documents only from the set file: a document beside the set file that the set does not list
/// generates no model.
// Requirements: ORES-21, DBS-5, DBS-98.
fn the_builder_takes_the_documents_only_from_the_set_file() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-set-only-{}-{n}", std::process::id()));
    let set = set_file(&dir, &[schema()], &[]);
    let beside = dir.join("set/bench.dbs");
    std::fs::copy(bench(), &beside).or_panic(|e| format!("{}: {e}", beside.display()));
    let text = generate_with_set(dir, "fn main() {}", set).unwrap();
    assert!(text.contains("pub struct ZoneEvent "), "the listed document has no model");
    assert!(!text.contains("pub struct Author "), "a document that the set does not list has a model");
}

/// A setter of a datetime column takes the text form, so the type check refuses a native date or time value.
// Requirements: DBS-121.
fn a_time_setter_takes_the_text_form() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate("fn main() {}").unwrap();
    assert!(text.contains("pub fn set_start_dt(mut self, v: impl Into<String>) -> polyspec_orm::Result<Self>"), "start_dt does not take its text form");
}

/// Removes a test directory. One that is already gone is the state the test wants; any other failure panics with its path.
fn remove_test_dir(path: &std::path::Path) {
    if let Err(error) = std::fs::remove_dir_all(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            panic!("remove {}: {error}", path.display());
        }
    }
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("generate": generates_called_methods, generates_fulltext_boolean_methods_for_multiple_columns, generated_code_carries_no_allow_attribute, generated_rows_reject_unselected_fields_and_separate_group_results, nullable_json_fields_keep_sql_null_separate_from_json_null, column_function_order_takes_the_function, rejects_unknown_names_of_a_known_model, ignores_calls_of_other_types, manifest_text_is_embedded_with_its_hash, generated_field_types_follow_the_runtime_model, styled_setter_result_handling_preserves_model_calls, unknown_model_call_after_setter_result_handling_still_fails, styled_setter_result_transformations_are_not_column_calls, unknown_model_after_result_error_mapping_still_fails, infallible_setter_does_not_accept_result_methods, bound_setter_results_preserve_model_calls_after_extraction, relation_getters_report_a_mismatched_relation_value, scan_path_spelling_keeps_the_generated_source, a_table_named_like_the_runtime_crate_gets_a_model_module_of_its_own, a_restore_or_create_call_is_a_fixed_method, the_builder_takes_the_documents_only_from_the_set_file, a_time_setter_takes_the_text_form)
}
