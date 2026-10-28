//! model_generation: the model, manifest and external text made by orm-build from contracts/fixtures/bench/dbspec-set.json and the
//! source that build.rs scans are the same when generated twice, and the same as the OUT_DIR output that this crate built.
use polyspec_orm_testcase::OrPanic;

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
        .or_panic(|e| format!("generate: {e}"));
    let read = |path: &Path| std::fs::read_to_string(path).or_panic(|e| format!("{}: {e}", path.display()));
    (read(&model), read(&out.join(polyspec_orm_build::MANIFEST_FILE)), read(&out.join(polyspec_orm_build::EXTERNAL_FILE)))
}

#[test]
// Requirements: INT-100.
// Requirements: DBS-175.
// Requirements: SCH-1.
fn coverage_model_generation_check() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // The generator includes the output directory as a canonical path, so the paths compared are also made canonical.
    let temp = std::fs::canonicalize(std::env::temp_dir()).expect("canonical temp dir");
    let out = temp.join(format!("orm-rust-model-generation-{}", std::process::id()));
    let fresh = |dir: &Path| {
        if dir.exists() {
            std::fs::remove_dir_all(dir).or_panic(|e| format!("{}: {e}", dir.display()));
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
    let built = |file: &str| std::fs::read_to_string(built_dir.join(file)).or_panic(|e| format!("built {file}: {e}"));
    let built_lines: Vec<_> = built_model.lines().collect();
    let generated_lines: Vec<_> = first.0.lines().collect();
    let model_diff = built_lines.iter().zip(&generated_lines).enumerate().find(|(_, (built, generated))| built != generated);
    let diff_line = model_diff.map_or(built_lines.len().min(generated_lines.len()), |(line, _)| line);
    let context_start = diff_line.saturating_sub(2);
    let built_context = &built_lines[context_start..(context_start + 5).min(built_lines.len())];
    let generated_context = &generated_lines[context_start..(context_start + 5).min(generated_lines.len())];
    assert!(
        built_model == first.0,
        "the generated model differs from the model this crate builds with around line {} (built {} lines, generated {} lines, crate root {}): built {:?}; generated {:?}",
        diff_line + 1,
        built_lines.len(),
        generated_lines.len(),
        polyspec_orm_testcase::manifest_dir().display(),
        built_context,
        generated_context
    );
    assert!(built(polyspec_orm_build::MANIFEST_FILE) == first.1, "the generated manifest differs from the manifest this crate builds with");
    assert!(built(polyspec_orm_build::EXTERNAL_FILE) == first.2, "the generated external text differs from the one this crate builds with");
}
