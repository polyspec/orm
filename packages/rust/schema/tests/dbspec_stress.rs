//! Exact correctness check for the shared stress document, separate from the timed example.

use polyspec_orm_schema::dbspec;
use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

// Requirements: DBS-123.
#[test]
fn stress_document_round_trips_canonically() {
    let case = polyspec_orm_testcase::start("stress document canonical round trip", Duration::from_secs(60));
    // Discover the checkout from tracked markers instead of assuming a package-relative layout.
    let working_directory = std::env::current_dir().expect("read the test working directory");
    let root = match working_directory.ancestors().find(|directory| directory.join("go.work").is_file() && directory.join("tests/dbspec/stress.mts").is_file())
    {
        Some(root) => root,
        None => panic!("could not find the repository root from the test working directory"),
    };
    let generator = root.join("tests/dbspec/stress.mts");
    let generated = match Command::new("node").arg(&generator).current_dir(root).output() {
        Ok(generated) => generated,
        Err(error) => panic!("node {} could not start: {error}", generator.display()),
    };
    assert!(generated.status.success(), "node tests/dbspec/stress.mts failed with {}: {}", generated.status, String::from_utf8_lossy(&generated.stderr));
    let text = String::from_utf8(generated.stdout).expect("stress generator writes UTF-8");
    case.step(format_args!("generated {} bytes", text.len()));

    let parsed = match dbspec::parse(&text, &BTreeMap::new()) {
        Ok(parsed) => parsed,
        Err(errors) => panic!("stress document parse failed: {errors:#?}"),
    };
    let document = parsed.document;
    assert_eq!(2000, document.tables.len(), "stress document table count");
    assert_eq!(60000, document.tables.iter().map(|table| table.columns.len()).sum::<usize>(), "stress document column count");
    assert_eq!(10000, document.tables.iter().map(|table| table.foreign_keys.len()).sum::<usize>(), "stress document foreign key count");

    let first = dbspec::emit(&document);
    let second = dbspec::emit(&document);
    assert_eq!(text, first, "emit(parse(stress)) reproduces the generated canonical document");
    assert_eq!(first, second, "two emissions of the parsed stress document are identical");
}
