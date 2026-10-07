//! Generation from scanned source: the methods the source calls are
//! generated, and a call the schema does not allow fails with its position.

use std::path::PathBuf;

fn schema() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/zone.dbs")
}

fn bench() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../schema/bench.dbs")
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
    let out = polyspec_orm_build::Builder::new([schema]).scan(&src).out_dir(dir.join("out")).try_generate();
    let text = out.map(|p| std::fs::read_to_string(p).unwrap());
    let _ = std::fs::remove_dir_all(&dir);
    text
}

#[test]
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

#[test]
fn generated_rows_reject_unselected_fields_and_separate_group_results() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate("fn main() { let row = ZoneEvent::new(); let _ = row.get_start_dt(); let _ = row.gets_count(); }").unwrap();
    assert!(!text.contains("pub start_dt:"), "typed fields cannot bypass checked getters");
    assert!(text.contains("pub fn get_start_dt(&self) -> polyspec_orm::Result<polyspec_orm::chrono::NaiveDateTime>"), "getter must report missing selection");
    assert!(text.contains("pub async fn gets_count(&self) -> polyspec_orm::Result<polyspec_orm::GroupRows>"), "group rows must not be partial models");
}

#[test]
fn nullable_json_fields_keep_sql_null_separate_from_json_null() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    let text = generate_with_schema(
        root,
        "fn main() { let row = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::Value::null())); let _ = row.get_jsons_tags(); }",
    )
    .unwrap();
    assert!(text.contains("jsons_tags: Option<polyspec_orm::ordered_json::Value>"), "nullable ordered JSON must represent SQL NULL separately");
    assert!(text.contains("serialize_data: Option<polyspec_orm::serde_json::Value>"), "nullable styled JSON must represent SQL NULL separately");
    assert!(
        text.contains("pub fn set_jsons_tags(mut self, v: polyspec_orm::StyledValue<polyspec_orm::ordered_json::Value>) -> polyspec_orm::Result<Self>"),
        "styled setter requires an explicit state"
    );
    assert!(
        text.contains("pub fn get_jsons_tags(&self) -> polyspec_orm::Result<polyspec_orm::StyledValue<polyspec_orm::ordered_json::Value>>"),
        "styled getter reports a checked state"
    );
    assert!(text.contains("self.jsons_tags = Some(value);"), "setter retains a stored JSON value");
    assert!(text.contains("self.jsons_tags = if v.is_null() { None }"), "row assignment distinguishes SQL NULL");
    assert!(text.contains("self.__orm.require_field(\"jsons_tags\")?;"), "unselected field access must fail");
}

#[test]
fn column_function_order_takes_the_function() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate("fn main() { ZoneEvent::new().order_by_start_dt_asc(polyspec_orm::year()); }").unwrap();
    assert!(text.contains("pub fn order_by_start_dt_asc(mut self, f: polyspec_orm::Func) -> Self"));
    assert!(text.contains("pub fn order_by_seq_asc(mut self) -> Self"));
}

#[test]
fn rejects_unknown_names_of_a_known_model() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let err = generate("fn main() {\n    ZoneEvent::new().and_lk_start_dt(\"x\").name(\"y\");\n}\n").unwrap_err();
    assert!(err.contains("main.rs:2:22: ZoneEvent has no method and_lk_start_dt"), "{err}");
    assert!(err.contains("main.rs:2:43: ZoneEvent has no method name"), "{err}");
}

#[test]
fn rejects_argument_count() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let err = generate("fn main() { let x = ZoneEvent::new(); x.seq(1, 2); }").unwrap_err();
    assert!(err.contains("ZoneEvent::seq takes 1 values, not 2"), "{err}");
}

#[test]
fn ignores_calls_of_other_types() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let text = generate("fn main() { let v = vec![1]; v.len(); v.iter().map(|x| x + 1); }").unwrap();
    assert!(!text.contains("pub fn len"));
}

#[test]
fn rejects_an_invalid_document() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let dir = std::env::temp_dir().join(format!("orm-build-invalid-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let text = std::fs::read_to_string(schema()).unwrap().replace("start_dt datetime(6)", "start_dt datetime(9)");
    std::fs::write(dir.join("zone.dbs"), text).unwrap();
    let err = polyspec_orm_build::Builder::new([dir.join("zone.dbs")]).out_dir(dir.join("out")).try_generate().unwrap_err();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(err.contains("zone.dbs: SCHEMA_INVALID 5:"), "{err}");
}

/// dbspec::read_file이 parse 전에 DbSchema project XML과 빈 파일을 signature로 거부한다.
#[test]
fn rejects_a_file_without_the_signature() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for name in ["dbschema.dbs", "empty.dbs"] {
        let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/files").join(name);
        let out = std::env::temp_dir().join(format!("orm-build-signature-{}-{name}", std::process::id()));
        let err = polyspec_orm_build::Builder::new([path.clone()]).out_dir(out.clone()).try_generate().unwrap_err();
        assert!(!out.exists(), "{name}: generation wrote {}", out.display());
        let display = path.display();
        assert_eq!(err, format!("{display}: SCHEMA_INVALID 1:1 signature: {display} is not a dbspec document"), "{name}");
    }
}

#[test]
fn manifest_text_is_embedded_with_its_hash() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-manifest-{}-{n}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
    let audit = polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/audit.dbs");
    polyspec_orm_build::Builder::new([schema(), audit.clone()]).scan(dir.join("src")).out_dir(dir.join("out")).try_generate().unwrap();
    let embedded = std::fs::read_to_string(dir.join("out").join(polyspec_orm_build::MANIFEST_FILE)).unwrap();
    let zone = std::fs::read_to_string(schema()).unwrap();
    let audit = std::fs::read_to_string(audit).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(embedded, format!("{audit}{zone}"), "the manifest text holds the documents in name order");
}

#[test]
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
}

#[test]
fn styled_setter_result_handling_preserves_model_calls() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    for handler in ["expect(\"assigned config\")", "unwrap()"] {
        let source = format!("fn main() {{ let row = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::Value::null())).{handler}; let _ = row.get_jsons_tags(); }}");
        let text = generate_with_schema(root.clone(), &source).expect("Result handling must not be a column call");
        assert!(text.contains("pub fn get_jsons_tags"));
        assert!(!text.contains("pub fn expect"));
        assert!(!text.contains("pub fn unwrap"));
    }
}

#[test]
fn unknown_model_call_after_setter_result_handling_still_fails() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    let error = generate_with_schema(
        root,
        "fn main() { let _ = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::Value::null())).expect(\"config\").missing_method(); }",
    )
    .expect_err("unknown model call must fail");
    assert!(error.contains("missing_method"), "{error}");
}

#[test]
fn styled_setter_result_transformations_are_not_column_calls() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    for handling in ["map_err(|error| error)?", "map_err(|error| error).map(Some)"] {
        let source = format!(
            "fn main() {{ let row = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::Value::null())).{handling}; }}"
        );
        let text = generate_with_schema(root.clone(), &source).expect("Result transformations are not columns");
        assert!(!text.contains("pub fn map_err"));
        assert!(!text.contains("pub fn map("));
    }
}

#[test]
fn unknown_model_after_result_error_mapping_still_fails() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    for handling in ["map_err(|error| error)?", "map_err(|error| error).unwrap()"] {
        let source = format!("fn main() {{ let row = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::Value::null())).{handling}; row.missing_method(); }}");
        let error = generate_with_schema(root.clone(), &source).expect_err("unknown model call must fail");
        assert!(error.contains("missing_method"), "{error}");
        assert!(!error.contains("MapErr"), "{error}");
    }
}

#[test]
fn infallible_setter_does_not_accept_result_methods() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    let error = generate_with_schema(root, "fn main() { Author::new().set_seq(1).map_err(|error| error); }")
        .expect_err("infallible model setter does not return Result");
    assert!(error.contains("map_err"), "{error}");
}

#[test]
fn bound_setter_results_preserve_model_calls_after_extraction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let root = bench();
    let source = "fn main() { let result = Author::new().set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::Value::null())); let row = result.map_err(|error| error).unwrap(); row.missing_method(); }";
    let error = generate_with_schema(root, source).expect_err("bound Result must retain its model after extraction");
    assert!(error.contains("missing_method"), "{error}");
    assert!(!error.contains("MapErr"), "{error}");
}

/// relation getter는 실패한 downcast를 None으로 버리지 않고 `polyspec_orm::Result`로 보고한다.
#[test]
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

/// 외부 문서(`uses`)를 쓰는 set은 소유한 table의 model만 만들고, 외부 문서에서 쓰는 table의 text를 schema 값에
/// 싣는다.
#[test]
fn generation_leaves_external_tables_out() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let fixtures = polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/external");
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-test-{}-{n}", std::process::id()));
    let out = polyspec_orm_build::Builder::new([fixtures.join("member.dbs")]).uses([fixtures.join("core.dbs")]).out_dir(dir.join("out")).try_generate();
    let text = out.map(|p| std::fs::read_to_string(p).unwrap());
    let external = std::fs::read_to_string(dir.join("out").join("orm_external.dbs"));
    let _ = std::fs::remove_dir_all(&dir);
    let text = text.unwrap_or_else(|e| panic!("generate: {e}"));
    assert!(text.contains("pub struct ExtPost ") && text.contains("pub struct ExtPostHistory "), "the owned tables have models");
    assert!(!text.contains("pub struct ExtAccount ") && !text.contains("pub struct ExtAudit "), "the external tables have no model");
    assert!(text.contains("polyspec_orm::Schema::with_external("), "the schema value carries the external text:\n{text}");
    let external = external.unwrap_or_else(|e| panic!("orm_external.dbs: {e}"));
    assert!(external.starts_with("dbspec 1 ext_core\n"), "external text: {external}");
    assert!(!external.contains("ext_session"), "the external text carries ext_session, which the set does not use");
}

/// 같은 source와 schema는 scan과 output path를 어떻게 쓰든(package directory 기준 상대 path, 절대 path,
/// `./`를 넣은 path, 끝에 `/`를 붙인 path) 같은 generated source를 만든다.
#[test]
fn scan_path_spelling_keeps_the_generated_source() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::create_dir_all(dir.join("tests")).unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() { let _ = ZoneEvent::new().gt_start_dt(now); }").unwrap();
    std::fs::write(dir.join("tests/case.rs"), "fn case() { let _ = ZoneEvent::new().or_seq(vec![1, 2]); }").unwrap();
    // 상대 path는 package directory(CARGO_MANIFEST_DIR) 기준이므로 그 directory에서 root까지 올라간 뒤 dir로 내려간다.
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
    let mut texts = Vec::new();
    for (name, [src, tests, out]) in &spellings {
        let _ = std::fs::remove_dir_all(dir.join("out"));
        let text = polyspec_orm_build::Builder::new([schema()]).scan(src).scan(tests).out_dir(out).try_generate().map(|p| std::fs::read_to_string(p).unwrap());
        texts.push((*name, text.unwrap_or_else(|e| panic!("generate {name}: {e}"))));
    }
    let _ = std::fs::remove_dir_all(&dir);
    let first = &texts[0].1;
    assert!(first.contains("pub fn gt_start_dt<") && first.contains("pub fn or_seq<"), "the calls of src and tests are generated");
    for (name, text) in &texts {
        assert!(text == first, "the generated source of the {name} paths differs from the relative paths");
    }
}

#[test]
fn a_table_named_like_the_runtime_crate_gets_a_model_module_of_its_own() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let schema = dir.join("crate_name.dbs");
    std::fs::write(&schema, "dbspec 1 crate_name\n\ntable polyspec_orm {\n  seq i64 identity\n  primary key (seq)\n}\n").unwrap();
    let text = generate_with_schema(schema, "fn main() { let _ = PolyspecOrm::new(); }");
    let _ = std::fs::remove_dir_all(&dir);
    let text = text.unwrap();
    // 생성된 code는 runtime crate를 polyspec_orm::으로 부르므로, 같은 이름의 model module은 그 path를 가린다.
    assert!(text.contains("pub mod polyspec_orm_model {"), "the model module of table polyspec_orm is polyspec_orm_model");
    assert!(!text.contains("pub mod polyspec_orm {"), "a model module named polyspec_orm shadows the runtime crate");
}
