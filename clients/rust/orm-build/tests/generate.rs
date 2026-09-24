//! Generation from scanned source: the methods the source calls are
//! generated, and a call the schema does not allow fails with its position.

use std::path::PathBuf;

fn schema() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../orm/tests/testdata/zone_schema.json")
}

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn generate(source: &str) -> Result<String, String> {
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("orm-build-test-{}-{n}", std::process::id()));
    let src = dir.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("main.rs"), source).unwrap();
    let out = orm_build::Builder::new(schema()).scan(&src).out_dir(dir.join("out")).try_generate();
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
