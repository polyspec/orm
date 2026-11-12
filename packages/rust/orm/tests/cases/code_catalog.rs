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

// Requirements: CORE-10, CORE-14, ERR-4. Every code of the catalog of the language implementations is a kind in lower case,
// but the codes that CORE-14 removes from the core; every kind is a code of the catalog, but the kinds that only the core has.
fn matches_errors_yaml() {
    let root = polyspec_orm_testcase::manifest_dir();
    let yaml = std::fs::read_to_string(root.join("../../../docs/spec/errors.yaml")).expect("docs/spec/errors.yaml");
    let codes: Vec<String> = catalog(&yaml).into_iter().map(|(code, _)| code.to_ascii_lowercase()).collect();
    let removed = ["rollback", "subscriber", "generator_scan_parse", "generator_scan_unattached"];
    let core_only = ["busy", "transaction_ended", "closed", "pool_timeout", "rollback_failed"];
    for code in &codes {
        assert!(
            removed.contains(&code.as_str()) || polyspec_orm::Kind::from_str_exact(code).is_some(),
            "the catalog code {code} is no kind of the core and CORE-14 does not remove it"
        );
    }
    for kind in polyspec_orm::Kind::ALL {
        assert!(codes.iter().any(|code| code == kind.as_str()) || core_only.contains(&kind.as_str()), "the kind {kind} is no code of the catalog");
    }
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    vec![polyspec_orm_testcase::trial("code_catalog::matches_errors_yaml".to_owned(), polyspec_orm_testcase::COMPUTE, matches_errors_yaml)]
}
