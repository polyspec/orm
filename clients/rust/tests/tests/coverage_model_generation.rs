//! model_generation: orm-build가 schema/bench.dbs과 build.rs가 scan하는 source로 만든
//! model과 manifest는 두 번 생성해도 같고, 이 crate가 build한 OUT_DIR의 것과 같다.
use std::path::{Path, PathBuf};

/// build.rs와 같은 document와 scan 경로로 `out`에 생성하고 model과 manifest text를 읽는다.
fn generate(out: &Path) -> (String, String) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let model = orm_build::Builder::new([root.join("../../../schema/bench.dbs")])
        .scan(root.join("src"))
        .scan(root.join("../../../examples/complex/rust"))
        .scan(root.join("../../../examples/thin-slice/rust"))
        .out_dir(out)
        .try_generate()
        .unwrap_or_else(|e| panic!("generate: {e}"));
    let read = |path: &Path| std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    (read(&model), read(&out.join(orm_build::MANIFEST_FILE)))
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_model_generation_check() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    // 생성기는 output directory를 canonical path로 include하므로 비교할 path도 canonical path로 만든다.
    let temp = std::fs::canonicalize(std::env::temp_dir()).expect("canonical temp dir");
    let out = temp.join(format!("orm-rust-model-generation-{}", std::process::id()));
    let fresh = |dir: &Path| {
        if dir.exists() {
            std::fs::remove_dir_all(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
        }
    };
    fresh(&out);
    let first = generate(&out);
    fresh(&out);
    let second = generate(&out);
    fresh(&out);
    assert!(first == second, "two generations from the same input differ");

    // 생성된 model은 manifest file을 절대 경로로 include한다. build의 경로를 이 생성의 경로로 바꿔 비교한다.
    let built_dir = &std::fs::canonicalize(env!("OUT_DIR")).expect("canonical OUT_DIR");
    let built_model = std::fs::read_to_string(built_dir.join(orm_build::MODEL_FILE)).expect("built model");
    let built_manifest = std::fs::read_to_string(built_dir.join(orm_build::MANIFEST_FILE)).expect("built manifest");
    let built_path = built_dir.join(orm_build::MANIFEST_FILE).display().to_string();
    let generated_path = out.join(orm_build::MANIFEST_FILE).display().to_string();
    assert_eq!(built_model.matches(&built_path).count(), 1, "the built model includes its manifest file once");
    assert!(built_model.replace(&built_path, &generated_path) == first.0, "the generated model differs from the model this crate builds with");
    assert!(built_manifest == first.1, "the generated manifest differs from the manifest this crate builds with");
}
