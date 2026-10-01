//! The cases of tests/dbspec/mermaid.json through `export_mermaid` and
//! `import_mermaid` of `orm_schema::dbspec` (docs/mermaid.md): every export
//! case writes its Mermaid text and its dropped objects, every import case
//! reads its document and its dropped objects, and every invalid case
//! reports exactly its `[rule, line, column]` diagnostics.

use orm_schema::dbspec::{self, export_mermaid, import_mermaid, Unsupported};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

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

/// case 하나를 실행하고 시작, 결과, 경과 시간을 쓴다.
fn run(id: &str, failures: &mut Vec<String>, body: impl FnOnce() -> Result<(), String>) {
    let started = Instant::now();
    println!("RUN mermaid/{id} deadline={DEADLINE:?}");
    let mut result = body();
    let elapsed = started.elapsed();
    if result.is_ok() && elapsed > DEADLINE {
        result = Err(format!("exceeded {DEADLINE:?}"));
    }
    match result {
        Ok(()) => println!("PASS mermaid/{id} elapsed={elapsed:?}"),
        Err(e) => {
            println!("FAIL mermaid/{id} elapsed={elapsed:?}: {e}");
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
            let document = dbspec::parse(&lines(&case["document"]), &BTreeMap::new()).map_err(|e| format!("document: {e:?}"))?;
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
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    println!("PASS mermaid vectors: {count} cases");
}
