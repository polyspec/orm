//! Builds schema values from owned and external fixture documents for registration tests.

use crate::or_panic::OrPanic;
use polyspec_orm::Schema;
use polyspec_orm::dbspec::{self, Document};
use std::collections::BTreeMap;

/// The text of `contracts/fixtures/<name>.dbs`.
fn fixture(name: &str) -> String {
    let path = format!("{}/../../../contracts/fixtures/{name}.dbs", polyspec_orm_testcase::manifest_dir().display());
    dbspec::read_file(std::path::Path::new(&path)).or_panic(|e| format!("{path}: {e:?}"))
}

/// The schema values of owned and external documents, with their computed manifest text and hash.
pub fn set_schema(owned: &[&str], external: &[&str]) -> &'static Schema {
    let texts: Vec<(String, bool)> = owned.iter().map(|n| (fixture(n), false)).chain(external.iter().map(|n| (fixture(n), true))).collect();
    let name = |text: &str| text.lines().next().unwrap().trim_start_matches("dbspec 1 ").to_owned();
    let documents: Vec<Document> = texts
        .iter()
        .map(|(text, is_external)| {
            let set: BTreeMap<String, String> = texts.iter().filter(|(other, _)| other != text).map(|(other, _)| (name(other), other.clone())).collect();
            let mut document = dbspec::parse(text, &set).map(|parsed| parsed.document).or_panic(|e| format!("{e:?}"));
            document.external = *is_external;
            document
        })
        .collect();
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).or_panic(|e| format!("{e:?}"));
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    Box::leak(Box::new(Schema::with_external(leak(manifest.manifest_text), leak(manifest.external_text), leak(manifest.manifest_hash))))
}
