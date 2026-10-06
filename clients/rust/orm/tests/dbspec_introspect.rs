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
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Go가 단언하는 dialect별 catalog query 수.
const QUERY_COUNTS: [(&str, usize); 3] = [("mysql", 9), ("postgres", 7), ("sqlite", 3)];

/// 한 database에 함께 적용하는 문서 집합.
struct RoundTripSet {
    id: String,
    documents: BTreeMap<String, String>,
}

/// tests/dialects의 schemaDocumentPatterns와 같은 glob 목록.
const SCHEMA_DOCUMENT_DIRECTORIES: [&str; 2] = ["schema", "contracts/fixtures"];

fn schema_documents(directory: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(directory)
        .unwrap_or_else(|e| panic!("{}: {e}", directory.display()))
        .map(|entry| entry.expect("directory entry").path())
        .filter(|path| path.extension().is_some_and(|e| e == "dbs"))
        .collect();
    paths.sort();
    paths
}

/// tests/dbspec/ddl.json의 모든 case와 모든 schema 문서.
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

/// 집합의 모든 문서를 이름 순으로 parse한다. 각 문서는 나머지를 문서 집합으로 받는다.
fn parse_set(id: &str, documents: &BTreeMap<String, String>) -> Vec<Document> {
    documents
        .iter()
        .map(|(name, text)| {
            let set: BTreeMap<String, String> = documents.iter().filter(|(other, _)| *other != name).map(|(o, t)| (o.clone(), t.clone())).collect();
            dbspec::parse(text, &set).unwrap_or_else(|e| panic!("{id}/{name}: {e:?}"))
        })
        .collect()
}

/// 집합의 모든 table을 이름 순으로 담은 문서 introspected의 schema text. 집합의
/// schema text에서 table 블록(`table <name> {`부터 들여쓰지 않은 `}`까지)을 모아
/// 한 문서로 parse한다.
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
    let combined = dbspec::parse(&text, &BTreeMap::new()).unwrap_or_else(|e| panic!("{id}: combined document: {e:?}\n{text}"));
    dbspec::manifest(&[&combined]).unwrap_or_else(|e| panic!("{id}: {e:?}")).schema_text
}

#[tokio::test]
async fn introspect_round_trip() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
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
            orm_testcase::step(format_args!("{db}: {want} queries for every set"));
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    // 세 database의 round trip은 개발 machine에서 1분 안에 끝난다(T27 측정). 5분이 지나면 멈춘 것이다.
    if started.elapsed() >= Duration::from_secs(300) {
        orm_testcase::warning(format_args!("round trip exceeded 300s"));
    }
    orm_testcase::step(format_args!("dbspec introspect round trip: {} sets on three databases in {:?}", sets.len(), started.elapsed()));
}

#[tokio::test]
async fn introspect_unsupported() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let started = Instant::now();
    let path = repository().join("tests/dbspec/introspect.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("introspect.json")).expect("introspect.json");
    let cases = vectors["cases"].as_array().expect("introspect cases");
    assert!(!cases.is_empty(), "tests/dbspec/introspect.json has no cases");
    let mut servers = Servers::open("iu").await;
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let case_id = case["id"].as_str().expect("id");
        let dialect_name = case["dialect"].as_str().expect("dialect");
        let (db, dialect) = *DIALECTS.iter().find(|(name, _)| *name == dialect_name).unwrap_or_else(|| panic!("{case_id}: unknown dialect {dialect_name}"));
        let documents_text = case["documents"].as_object().expect("documents").iter().map(|(name, l)| (name.clone(), lines(l))).collect();
        let documents = parse_set(case_id, &documents_text);
        let refs: Vec<&Document> = documents.iter().collect();
        let statements = dbspec::render(&refs, dialect).unwrap_or_else(|e| panic!("{case_id}: {e:?}"));
        // {schema}는 이 case의 database 또는 schema 이름이다.
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
                if got != want_unsupported {
                    return Err(format!("unsupported differs\nwant {want_unsupported:?}\ngot  {:?}", introspection.unsupported));
                }
                Ok(())
            })
        })
        .await;
        if let Err(e) = result {
            failures.push(format!("{id}: {e}"));
        }
    }
    servers.close().await;
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    if started.elapsed() >= Duration::from_secs(300) {
        orm_testcase::warning(format_args!("unsupported cases exceeded 300s"));
    }
    orm_testcase::step(format_args!("dbspec introspect unsupported: {} cases in {:?}", cases.len(), started.elapsed()));
}
