//! dbspec introspection through `polyspec_orm::dbspec::introspect` on MySQL,
//! PostgreSQL and SQLite (docs/dialects.md, "Introspection"). Every vector of
//! tests/dbspec/ddl.json and every schema document is rendered, applied to an
//! empty database of each dialect and introspected into the schema text of
//! its source with no unsupported object and one query count per dialect;
//! every case of tests/dbspec/introspect.json yields its document and its
//! unsupported objects. A test fails when ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is unset.

#[path = "common/dbspec_probe.rs"]
mod dbspec_probe;

use dbspec_probe::{connection_rules, lines, repository, run_probe, strings, Servers, DIALECTS};
use polyspec_orm_schema::dbspec::{self, Document};
use polyspec_orm_testcase::Trial;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The number of catalog queries per dialect that Go asserts.
const QUERY_COUNTS: [(&str, usize); 3] = [("mysql", 9), ("postgres", 7), ("sqlite", 3)];

/// The document set applied together to one database.
struct RoundTripSet {
    id: String,
    documents: BTreeMap<String, String>,
}

/// The glob list, the same as schemaDocumentPatterns in packages/go/internal/dialects.
const SCHEMA_DOCUMENT_DIRECTORIES: [&str; 2] = ["contracts/fixtures/bench", "contracts/fixtures"];

fn schema_documents(directory: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(directory)
        .unwrap_or_else(|e| panic!("{}: {e}", directory.display()))
        .map(|entry| entry.expect("directory entry").path())
        .filter(|path| path.extension().is_some_and(|e| e == "dbs"))
        .collect();
    paths.sort();
    paths
}

/// All cases of tests/dbspec/ddl.json and all schema documents.
fn round_trip_sets() -> Vec<RoundTripSet> {
    let root = repository();
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(root.join("tests/dbspec/ddl.json")).expect("ddl.json")).expect("ddl.json");
    let mut out = Vec::new();
    for case in vectors["cases"].as_array().expect("ddl cases") {
        let id = format!("ddl_{}", case["id"].as_str().expect("id").replace('-', "_"));
        let documents = case["documents"].as_object().expect("documents").iter().map(|(name, l)| (name.clone(), lines(l))).collect();
        out.push(RoundTripSet { id, documents });
    }
    for directory in SCHEMA_DOCUMENT_DIRECTORIES {
        for path in schema_documents(&root.join(directory)) {
            let name = path.file_stem().expect("stem").to_string_lossy().into_owned();
            let text = dbspec::read_file(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            out.push(RoundTripSet { id: format!("schema_{name}"), documents: BTreeMap::from([(name, text)]) });
        }
    }
    out
}

/// Parses all documents of the set in name order. Each document receives the rest as its document set.
fn parse_set(id: &str, documents: &BTreeMap<String, String>) -> Vec<Document> {
    documents
        .iter()
        .map(|(name, text)| {
            let set: BTreeMap<String, String> = documents.iter().filter(|(other, _)| *other != name).map(|(o, t)| (o.clone(), t.clone())).collect();
            dbspec::parse(text, &set).map(|parsed| parsed.document).unwrap_or_else(|e| panic!("{id}/{name}: {e:?}"))
        })
        .collect()
}

/// The schema text of the introspected document, which holds all tables of the set in name order. Of the set's
/// schema text, it gathers the table blocks (from `table <name> {` to the `}` that is not indented)
/// and parses them as one document.
fn expected_schema_text(id: &str, documents: &[Document]) -> String {
    let refs: Vec<&Document> = documents.iter().collect();
    let schema = dbspec::manifest(&refs).unwrap_or_else(|e| panic!("{id}: {e:?}")).schema_text;
    let mut tables: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in schema.lines() {
        if let Some((_, block)) = current.as_mut() {
            block.push('\n');
            block.push_str(line);
            if line == "}" {
                tables.extend(current.take());
            }
        } else if let Some(rest) = line.strip_prefix("table ") {
            let name = rest.split(' ').next().unwrap_or_else(|| panic!("{id}: table line {line:?}"));
            current = Some((name.to_owned(), line.to_owned()));
        }
    }
    assert!(current.is_none(), "{id}: unclosed table block");
    tables.sort();
    let mut text = "dbspec 1 introspected\n".to_owned();
    for (_, block) in &tables {
        text.push('\n');
        text.push_str(block);
        text.push('\n');
    }
    let combined = dbspec::parse(&text, &BTreeMap::new()).map(|parsed| parsed.document).unwrap_or_else(|e| panic!("{id}: combined document: {e:?}\n{text}"));
    dbspec::manifest(&[&combined]).unwrap_or_else(|e| panic!("{id}: {e:?}")).schema_text
}

async fn introspect_round_trip() {
    let started = Instant::now();
    let mut servers = Servers::open("rt").await;
    let sets = round_trip_sets();
    assert!(!sets.is_empty(), "no round trip sets");
    let mut failures = Vec::new();
    let mut queries: BTreeMap<&str, BTreeMap<usize, Vec<String>>> = BTreeMap::new();
    let mut index = 0;
    for set in &sets {
        let documents = parse_set(&set.id, &set.documents);
        let refs: Vec<&Document> = documents.iter().collect();
        let want = expected_schema_text(&set.id, &documents);
        for (db, dialect) in DIALECTS {
            let statements = dbspec::render(&refs, dialect).unwrap_or_else(|e| panic!("{}: {e:?}", set.id));
            let id = format!("{db}.introspect.{}", set.id);
            index += 1;
            let want = want.clone();
            let result = run_probe(&mut servers, &id, db, index, |conn| {
                Box::pin(async move {
                    conn.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
                    conn.exec_all(&statements).await?;
                    let (introspection, count) = conn.introspect().await.map_err(|e| format!("introspect: {e}"))?;
                    if !introspection.unsupported.is_empty() {
                        return Err(format!("unsupported: {:?}", introspection.unsupported));
                    }
                    let got = dbspec::manifest(&[&introspection.document]).map_err(|e| format!("manifest: {e:?}"))?.schema_text;
                    if got != want {
                        return Err(format!("schema text differs\n--- want\n{want}--- got\n{got}"));
                    }
                    let tables = dbspec::emit(&introspection.document).lines().filter(|l| l.starts_with("table ")).count();
                    Ok((count, tables))
                })
            })
            .await;
            match result {
                Ok((count, tables)) => queries.entry(db).or_default().entry(count).or_default().push(format!("{} ({tables} tables)", set.id)),
                Err(e) => failures.push(format!("{id}: {e}")),
            }
        }
    }
    servers.close().await;
    for (db, want) in QUERY_COUNTS {
        let counts = queries.get(db).cloned().unwrap_or_default();
        let observed: BTreeSet<usize> = counts.keys().copied().collect();
        if observed != BTreeSet::from([want]) {
            failures.push(format!("{db}: introspection query counts {counts:?}, want {want} for every set"));
        } else {
            polyspec_orm_testcase::step(format_args!("{db}: {want} queries for every set"));
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    // The round trip for three databases finishes within 1 minute on the development machine (T27 measurement). Five minutes means it has stalled.
    if started.elapsed() >= Duration::from_secs(300) {
        polyspec_orm_testcase::warning(format_args!("round trip exceeded 300s"));
    }
    polyspec_orm_testcase::step(format_args!("dbspec introspect round trip: {} sets on three databases in {:?}", sets.len(), started.elapsed()));
}

/// Each case of tests/dbspec/introspect.json is the trial `introspect_unsupported::<id>`: it gives its document and its
/// unsupported objects on a database of its own.
fn introspect_unsupported() -> Vec<Trial> {
    let path = repository().join("tests/dbspec/introspect.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("introspect.json")).expect("introspect.json");
    let cases = vectors["cases"].as_array().expect("introspect cases");
    assert!(!cases.is_empty(), "tests/dbspec/introspect.json has no cases");
    cases
        .iter()
        .enumerate()
        .map(|(index, case)| {
            let id = case["id"].as_str().expect("id").to_owned();
            let case = case.clone();
            polyspec_orm_testcase::async_trial(format!("introspect_unsupported::{id}"), polyspec_orm_testcase::DATABASE, move || async move {
                introspect_unsupported_case(index, &case).await
            })
        })
        .collect()
}

async fn introspect_unsupported_case(index: usize, case: &Value) {
    let mut servers = Servers::open("iu").await;
    let case_id = case["id"].as_str().expect("id");
    let dialect_name = case["dialect"].as_str().expect("dialect");
    let (db, dialect) = *DIALECTS.iter().find(|(name, _)| *name == dialect_name).unwrap_or_else(|| panic!("{case_id}: unknown dialect {dialect_name}"));
    let documents_text = case["documents"].as_object().expect("documents").iter().map(|(name, l)| (name.clone(), lines(l))).collect();
    let documents = parse_set(case_id, &documents_text);
    let refs: Vec<&Document> = documents.iter().collect();
    let statements = dbspec::render(&refs, dialect).unwrap_or_else(|e| panic!("{case_id}: {e:?}"));
    // {schema} is this case's database or schema name.
    let schema = servers.name(index);
    let extra: Vec<String> = strings(&case["statements"]).iter().map(|s| s.replace("{schema}", &schema)).collect();
    let want_document = lines(&case["document"]);
    let want_unsupported: Vec<Vec<String>> = case["unsupported"].as_array().expect("unsupported").iter().map(strings).collect();
    let id = format!("{db}.introspect.{case_id}");
    let result = run_probe(&mut servers, &id, db, index, |conn| {
        Box::pin(async move {
            conn.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
            conn.exec_all(&statements).await?;
            conn.exec_all(&extra).await?;
            let (introspection, _) = conn.introspect().await.map_err(|e| format!("introspect: {e}"))?;
            let got_document = dbspec::emit(&introspection.document);
            if got_document != want_document {
                return Err(format!("document differs\n--- want\n{want_document}--- got\n{got_document}"));
            }
            let got: Vec<Vec<String>> = introspection.unsupported.iter().map(|u| vec![u.kind.clone(), u.table.clone(), u.name.clone()]).collect();
            let want_triples: Vec<Vec<String>> = want_unsupported.iter().map(|w| w.iter().take(3).cloned().collect()).collect();
            if got != want_triples {
                return Err(format!("unsupported differs\nwant {want_unsupported:?}\ngot  {:?}", introspection.unsupported));
            }
            // The fourth element is the rule the reason must include. If absent, the reason is not compared.
            for (w, u) in want_unsupported.iter().zip(&introspection.unsupported) {
                if let Some(rule) = w.get(3) {
                    if !u.reason.contains(rule.as_str()) {
                        return Err(format!("reason of {} {} {} differs\nwant rule {rule:?}\ngot  {:?}", u.kind, u.table, u.name, u.reason));
                    }
                }
            }
            Ok(())
        })
    })
    .await;
    servers.close().await;
    if let Err(e) = result {
        panic!("{id}: {e}");
    }
}

fn main() {
    let mut trials = vec![polyspec_orm_testcase::async_trial("introspect_round_trip", polyspec_orm_testcase::DATABASE, introspect_round_trip)];
    trials.extend(introspect_unsupported());
    polyspec_orm_testcase::run_in_order(trials);
}
