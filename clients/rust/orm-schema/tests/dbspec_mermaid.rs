//! The cases of tests/dbspec/mermaid.json through `export_mermaid` and
//! `import_mermaid` of `orm_schema::dbspec` (docs/mermaid.md): every export
//! case writes its Mermaid text and its dropped objects, every import case
//! reads its document and its dropped objects, every invalid case reports
//! exactly its `[rule, line, column]` diagnostics, and every round trip case
//! exports its document and imports the export with exactly its dropped
//! objects and gets back its tables, columns, primary keys and foreign keys.

use orm_case_clock::CaseClock;
use orm_schema::dbspec::model::{DefaultValue, Document};
use orm_schema::dbspec::{self, export_mermaid, import_mermaid, Unsupported};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

/// case 하나의 기한.
const DEADLINE: Duration = Duration::from_secs(5);

fn vectors() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/dbspec/mermaid.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("mermaid.json");
    assert_eq!(vectors["version"], 1, "tests/dbspec/mermaid.json version");
    vectors
}

fn lines(value: &Value) -> String {
    value.as_array().expect("lines").iter().map(|l| format!("{}\n", l.as_str().expect("line"))).collect()
}

fn cases<'v>(vectors: &'v Value, group: &str) -> &'v [Value] {
    let cases = vectors[group].as_array().unwrap_or_else(|| panic!("mermaid.json has no {group} cases"));
    assert!(!cases.is_empty(), "mermaid.json has no {group} cases");
    cases
}

/// 뺀 객체의 `[kind, table, name]` 목록.
fn drops(dropped: &[Unsupported]) -> Value {
    Value::Array(dropped.iter().map(|u| json!([u.kind, u.table, u.name])).collect())
}

/// Mermaid가 옮기는 table, column, primary key, foreign key를 table 이름 순서의
/// 줄로 쓴다. foreign key action은 Mermaid가 옮기지 않으므로 뺀다.
fn skeleton(document: &Document) -> Vec<String> {
    let names = |list: &[orm_schema::dbspec::model::Name]| list.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join(", ");
    let mut tables: Vec<_> = document.tables.iter().collect();
    tables.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    let mut out = Vec::new();
    for t in tables {
        out.push(format!("table {}", t.name.text));
        for c in &t.columns {
            let default = match &c.default {
                None => "-".to_owned(),
                Some(DefaultValue::Now) => "now".to_owned(),
                Some(DefaultValue::Literal(text)) => text.clone(),
            };
            out.push(format!("column {} {:?} null={} identity={} default={default}", c.name.text, c.ty, c.nullable, c.identity.is_some()));
        }
        for p in &t.primary {
            out.push(format!("primary key {}", names(&p.columns)));
        }
        let mut keys: Vec<_> = t.foreign_keys.iter().collect();
        keys.sort_by(|a, b| a.name.text.cmp(&b.name.text));
        for f in keys {
            out.push(format!("foreign key {} ({}) references {} ({})", f.name.text, names(&f.columns), f.table.text, names(&f.references)));
        }
    }
    out
}

/// case 하나를 실행하고 시작, 결과, 경과 시간을 쓴다.
fn run(id: &str, failures: &mut Vec<String>, body: impl FnOnce() -> Result<(), String>) {
    let clock = CaseClock::start();
    println!("RUN mermaid/{id} deadline={DEADLINE:?}");
    let mut result = body();
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if result.is_ok() && cpu > DEADLINE {
        result = Err(format!("cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})"));
    }
    match result {
        Ok(()) => println!("PASS mermaid/{id} cpu={cpu:?} wall={wall:?}"),
        Err(e) => {
            println!("FAIL mermaid/{id} cpu={cpu:?} wall={wall:?}: {e}");
            failures.push(format!("{id}: {e}"));
        }
    }
}

#[test]
fn mermaid_vectors() {
    let vectors = vectors();
    let mut failures = Vec::new();
    let mut count = 0;
    for case in cases(&vectors, "export") {
        let id = format!("export/{}", case["id"].as_str().expect("id"));
        count += 1;
        run(&id, &mut failures, || {
            let set: BTreeMap<String, String> =
                case["documents"].as_object().expect("documents").iter().map(|(name, text)| (name.clone(), lines(text))).collect();
            let document = dbspec::parse(&lines(&case["document"]), &set).map_err(|e| format!("document: {e:?}"))?;
            let (text, dropped) = export_mermaid(&document);
            let want = lines(&case["mermaid"]);
            if text != want {
                return Err(format!("mermaid\n--- want\n{want}--- got\n{text}"));
            }
            if drops(&dropped) != case["dropped"] {
                return Err(format!("dropped\nwant {}\ngot  {}", case["dropped"], drops(&dropped)));
            }
            Ok(())
        });
    }
    for case in cases(&vectors, "import") {
        let id = format!("import/{}", case["id"].as_str().expect("id"));
        count += 1;
        run(&id, &mut failures, || {
            let (document, dropped) = import_mermaid(&lines(&case["mermaid"]), "imported").map_err(|e| format!("diagnostics: {e:?}"))?;
            let (got, want) = (dbspec::emit(&document), lines(&case["document"]));
            if got != want {
                return Err(format!("document\n--- want\n{want}--- got\n{got}"));
            }
            if drops(&dropped) != case["dropped"] {
                return Err(format!("dropped\nwant {}\ngot  {}", case["dropped"], drops(&dropped)));
            }
            Ok(())
        });
    }
    for case in cases(&vectors, "invalid") {
        let id = format!("invalid/{}", case["id"].as_str().expect("id"));
        count += 1;
        run(&id, &mut failures, || {
            let diagnostics = match import_mermaid(&lines(&case["mermaid"]), "imported") {
                Ok(_) => Vec::new(),
                Err(diagnostics) => diagnostics,
            };
            let got = Value::Array(diagnostics.iter().map(|d| json!([d.rule, d.line, d.column])).collect());
            if got != case["errors"] {
                return Err(format!("errors\nwant {}\ngot  {}", case["errors"], got));
            }
            Ok(())
        });
    }
    for case in cases(&vectors, "round_trip") {
        let id = format!("round_trip/{}", case["id"].as_str().expect("id"));
        count += 1;
        run(&id, &mut failures, || {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(case["path"].as_str().expect("path"));
            let source = dbspec::read_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let document = dbspec::parse(&source, &BTreeMap::new()).map_err(|e| format!("document: {e:?}"))?;
            let (text, dropped) = export_mermaid(&document);
            if drops(&dropped) != case["dropped"] {
                return Err(format!("export dropped {}\nwant {}\ngot  {}", dropped.len(), case["dropped"], drops(&dropped)));
            }
            let (imported, reported) = import_mermaid(&text, &document.name.text).map_err(|e| format!("diagnostics: {e:?}"))?;
            if drops(&reported) != case["imported"] {
                return Err(format!("import dropped {}\nwant {}\ngot  {}", reported.len(), case["imported"], drops(&reported)));
            }
            let (want, got) = (skeleton(&document), skeleton(&imported));
            if got != want {
                return Err(format!("tables, columns, primary keys and foreign keys\n--- want\n{}\n--- got\n{}", want.join("\n"), got.join("\n")));
            }
            println!("round_trip exported={} imported={}", dropped.len(), reported.len());
            Ok(())
        });
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    println!("PASS mermaid vectors: {count} cases");
}
