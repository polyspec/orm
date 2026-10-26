//! schema_definition: runs the cases of contracts/fixtures/schema_definition.json through dbspec parse, emit,
//! manifest, and render. The values are read from the fixture.
#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

#[path = "../../tests/tests/common/schema_coverage_case.rs"]
mod shared_case;

use polyspec_orm_schema::dbspec::{self, Dialect, Document};
use serde_json::Value;
use std::path::PathBuf;

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn repository() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../..")
}

/// Finds the case with `id` in the fixture, checks that its operation is `operation`, and returns its input and expected.
fn case(id: &str, operation: &str) -> (Value, Value) {
    let path = repository().join("contracts/fixtures/schema_definition.json");
    shared_case::case(&path, "schema_definition", id, operation)
}

/// The document path of the input and its text.
fn sources(input: &Value) -> Vec<(String, String)> {
    let paths = input["documents"].as_array().expect("input documents");
    assert!(!paths.is_empty(), "input names no document");
    paths
        .iter()
        .map(|path| {
            let path = path.as_str().expect("document path").to_owned();
            let file = repository().join(&path);
            let text = std::fs::read_to_string(&file).or_panic(|e| format!("{}: {e}", file.display()));
            (path, text)
        })
        .collect()
}

fn parse(path: &str, text: &str) -> Document {
    dbspec::parse(text, &Default::default()).map(|parsed| parsed.document).or_panic(|errors| format!("{path}: {errors:?}"))
}

/// Runs `body`, prints the start, success, and elapsed time, and checks the CPU time limit.
fn run(id: &str, body: impl FnOnce()) {
    shared_case::run(id, body);
}

/// The cases of the suite, one test `schema_definition::<case id>` per case.
mod schema_definition {
    use super::*;

    // Requirements: DBS-123.
    #[test]
    fn dbspec_emit_round_trip() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("dbspec_emit_round_trip", || {
            let (input, expected) = case("dbspec_emit_round_trip", "parse_emit");
            let identical = expected["identical"].as_bool().expect("expected.identical");
            for (path, text) in sources(&input) {
                assert_eq!(dbspec::emit(&parse(&path, &text)) == text, identical, "{path}: parse then emit reproduces the document");
            }
        });
    }

    // Requirements: DBS-103.
    #[test]
    fn dbspec_manifest_hash() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("dbspec_manifest_hash", || {
            let (input, expected) = case("dbspec_manifest_hash", "manifest");
            let documents: Vec<Document> = sources(&input).iter().map(|(path, text)| parse(path, text)).collect();
            let refs: Vec<&Document> = documents.iter().collect();
            let manifest = dbspec::manifest(&refs).or_panic(|errors| format!("manifest: {errors:?}"));
            assert_eq!(manifest.manifest_hash, expected["manifest_hash"].as_str().expect("expected.manifest_hash"));
        });
    }

    // Requirements: DBS-99.
    #[test]
    fn dbspec_render_ddl() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("dbspec_render_ddl", || {
            let (input, expected) = case("dbspec_render_ddl", "render");
            let documents: Vec<Document> = sources(&input).iter().map(|(path, text)| parse(path, text)).collect();
            let refs: Vec<&Document> = documents.iter().collect();
            assert_eq!(expected.as_object().expect("expected statements").len(), DIALECTS.len(), "expected dialects");
            for (name, dialect) in DIALECTS {
                let want: Vec<String> =
                    expected[name].as_array().unwrap_or_else(|| panic!("expected.{name}")).iter().map(|s| s.as_str().expect("statement").to_owned()).collect();
                assert_eq!(dbspec::render(&refs, dialect), Ok(want), "{name}");
            }
        });
    }

    /// The text of a format case: its lines joined with LF and a final line end.
    fn text(input: &Value) -> String {
        let lines: Vec<&str> = input["text"].as_array().expect("input text").iter().map(|line| line.as_str().expect("text line")).collect();
        assert!(!lines.is_empty(), "input has no text");
        format!("{}\n", lines.join("\n"))
    }

    // Requirements: DBS-134, DBS-135.
    #[test]
    fn dbspec_analyze_tokens() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("dbspec_analyze_tokens", || {
            let (input, expected) = case("dbspec_analyze_tokens", "analyze");
            let want = expected["tokens"].as_array().expect("expected.tokens");
            assert!(!want.is_empty(), "the fixture lists tokens");
            for (path, text) in sources(&input) {
                let analysis = dbspec::analyze(&text, &Default::default());
                let parsed = dbspec::parse(&text, &Default::default()).or_panic(|errors| format!("{path}: {errors:?}"));
                assert!(analysis.diagnostics.is_empty(), "{path}: {:?}", analysis.diagnostics);
                assert_eq!(
                    analysis.document.as_ref().map(dbspec::emit),
                    Some(dbspec::emit(&parsed.document)),
                    "{path}: the analysis holds the parsed document"
                );
                assert_eq!(analysis.positions, Some(parsed.positions), "{path}: the analysis holds the positions of the parse");
                let got: Vec<Value> = analysis.tokens.iter().map(|t| serde_json::json!([t.line, t.start, t.end, t.class])).collect();
                assert_eq!(&got, want, "{path} tokens");
            }
        });
    }

    // Requirements: DBS-141.
    #[test]
    fn dbspec_format() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("dbspec_format", || {
            let (input, expected) = case("dbspec_format", "format");
            let formatted = dbspec::format(&text(&input), &Default::default()).or_panic(|errors| format!("format: {errors:?}"));
            assert_eq!(formatted, text(&expected), "formatted text");
            assert_eq!(dbspec::format(&formatted, &Default::default()), Ok(formatted.clone()), "a formatted text is its own format");
        });
    }

    // Requirements: DBS-141, ORES-14.
    #[test]
    fn dbspec_format_refusal() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("dbspec_format_refusal", || {
            let (input, expected) = case("dbspec_format_refusal", "format");
            let want = expected["diagnostics"].as_array().expect("expected.diagnostics");
            assert!(!want.is_empty(), "the fixture lists diagnostics");
            let diagnostics = dbspec::format(&text(&input), &Default::default()).expect_err("a document with a diagnostic is not rewritten");
            let got: Vec<Value> = diagnostics.iter().map(|d| serde_json::json!({"rule": d.rule.to_string(), "line": d.line, "column": d.column})).collect();
            assert_eq!(&got, want, "diagnostics");
        });
    }

    // Requirements: DBS-142.
    #[test]
    fn dbspec_parse_positions() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("dbspec_parse_positions", || {
            let (input, expected) = case("dbspec_parse_positions", "parse_positions");
            let want = expected["positions"].as_array().expect("expected.positions");
            assert!(!want.is_empty(), "the fixture lists positions");
            for (path, text) in sources(&input) {
                let parsed = dbspec::parse(&text, &Default::default()).or_panic(|errors| format!("{path}: {errors:?}"));
                let got: Vec<Value> =
                    parsed.positions.iter().map(|p| serde_json::json!({"kind": p.kind, "path": p.path, "line": p.line, "column": p.column})).collect();
                assert_eq!(&got, want, "{path} positions");
            }
        });
    }
}
