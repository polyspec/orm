//! model_generation: the model, manifest and external text made by orm-build from contracts/fixtures/bench/dbspec-set.json and the
//! source that build.rs scans are the same when generated twice, and the same as the OUT_DIR output that this crate built.
use std::path::Path;

/// Generates into `out` with the same set and scan paths as build.rs, and reads the model, manifest and external text.
fn generate(out: &Path) -> (String, String, String) {
    let root = polyspec_orm_testcase::manifest_dir();
    let model = polyspec_orm_build::Builder::set(root.join("../../../contracts/fixtures/bench/dbspec-set.json"))
        .scan(root.join("src"))
        .scan(root.join("tests/integration"))
        .scan(root.join("../../../examples/complex/rust"))
        .scan(root.join("../../../examples/thin-slice/rust"))
        .out_dir(out)
        .try_generate()
        .unwrap_or_else(|e| panic!("generate: {e}"));
    let read = |path: &Path| std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    (read(&model), read(&out.join(polyspec_orm_build::MANIFEST_FILE)), read(&out.join(polyspec_orm_build::EXTERNAL_FILE)))
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_model_generation_check() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // The generator includes the output directory as a canonical path, so the paths compared are also made canonical.
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

    // The generated model includes the manifest file and the external file as absolute paths. The build's paths are replaced with this
    // generation's paths before comparing.
    let built_dir = &std::fs::canonicalize(env!("OUT_DIR")).expect("canonical OUT_DIR");
    let mut built_model = std::fs::read_to_string(built_dir.join(polyspec_orm_build::MODEL_FILE)).expect("built model");
    for file in [polyspec_orm_build::MANIFEST_FILE, polyspec_orm_build::EXTERNAL_FILE] {
        let built_path = built_dir.join(file).display().to_string();
        assert_eq!(built_model.matches(&built_path).count(), 1, "the built model includes {file} once");
        built_model = built_model.replace(&built_path, &out.join(file).display().to_string());
    }
    let built = |file: &str| std::fs::read_to_string(built_dir.join(file)).unwrap_or_else(|e| panic!("built {file}: {e}"));
    assert!(built_model == first.0, "the generated model differs from the model this crate builds with");
    assert!(built(polyspec_orm_build::MANIFEST_FILE) == first.1, "the generated manifest differs from the manifest this crate builds with");
    assert!(built(polyspec_orm_build::EXTERNAL_FILE) == first.2, "the generated external text differs from the one this crate builds with");
}
