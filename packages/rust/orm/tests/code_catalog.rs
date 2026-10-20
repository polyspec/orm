//! codes.rs, which `orm-gen errors` generates, compared with docs/spec/errors.yaml (`code_catalog::matches_errors_yaml`):
//! every code is a constant whose doc comment is the note of the catalog (the origin, then ": " and the comment of the
//! code), and the file holds no other code.

/// Each code of docs/spec/errors.yaml with its note.
fn catalog(yaml: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut comment = String::new();
    for line in yaml.lines() {
        let text = line.trim();
        if let Some(rest) = text.strip_prefix("- code:") {
            let (code, rest) = rest.split_once('#').unwrap_or((rest, ""));
            out.push((code.trim().to_owned(), String::new()));
            comment = rest.trim().to_owned();
        } else if let (Some(origin), Some(last)) = (text.strip_prefix("origin:"), out.last_mut()) {
            let origin = origin.trim();
            last.1 = if comment.is_empty() { origin.to_owned() } else { format!("{origin}: {comment}") };
        }
    }
    assert!(!out.is_empty(), "docs/spec/errors.yaml lists no codes");
    out
}

// Requirements: INT-65.
fn matches_errors_yaml() {
    let root = polyspec_orm_testcase::manifest_dir();
    let yaml = std::fs::read_to_string(root.join("../../../docs/spec/errors.yaml")).expect("docs/spec/errors.yaml");
    let source = std::fs::read_to_string(root.join("src/codes.rs")).expect("src/codes.rs");
    let codes = catalog(&yaml);
    let lines: Vec<&str> = source.lines().collect();
    for (code, note) in &codes {
        let constant = format!("pub const {code}: &str = \"{code}\";");
        let at = lines.iter().position(|line| *line == constant).unwrap_or_else(|| panic!("codes.rs has no constant for {code}"));
        let doc = at.checked_sub(1).map(|i| lines[i]).unwrap_or_default();
        assert_eq!(doc, format!("/// {note}"), "codes.rs {code} differs from docs/spec/errors.yaml; run orm-gen errors --lang rust");
    }
    assert_eq!(lines.iter().filter(|line| line.starts_with("pub const ")).count(), codes.len(), "codes.rs holds other codes than docs/spec/errors.yaml");
}

fn main() {
    polyspec_orm_testcase::run(vec![polyspec_orm_testcase::trial(
        "code_catalog::matches_errors_yaml".to_owned(),
        polyspec_orm_testcase::COMPUTE,
        matches_errors_yaml,
    )]);
}
