//! 연결의 addColumns가 실행할 step을 쓴다(docs/schema.md, "Adding columns").

use super::model::{Name, Pos, Table};
use super::{compare_schemas, emit, manifest, parse_plan, plan_steps, Dialect, Document, PlanStep, Unsupported};
use std::collections::{BTreeMap, BTreeSet};

/// [`add_column_steps`]의 결과: 더하는 column과 step, 또는 차이다.
#[derive(Clone, Debug)]
pub struct AddColumnSteps {
    /// 더하는 column, table 이름과 column 순서의 "table.column".
    pub added: Vec<String>,
    pub steps: Vec<PlanStep>,
    /// add_column이 아닌 차이, "<kind> <table>[.<name>]".
    pub differences: Vec<String>,
}

fn qualified(table: &str, name: &str) -> String {
    if name.is_empty() {
        table.to_owned()
    } else {
        format!("{table}.{name}")
    }
}

fn schema_document(tables: Vec<Table>) -> Document {
    Document {
        name: Name { text: "schema".to_owned(), pos: Pos { line: 1, column: 10 } },
        uses: Vec::new(),
        tables,
        diagrams: Vec::new(),
        trailing: Vec::new(),
    }
}

/// `live`는 연결의 database를 introspect한 문서, `unsupported`는 introspection이 읽지
/// 못한 객체, `target`은 document set의 schema text 문서다. 두 쪽에 다 있는 table만
/// 비교하므로 database에 없는 set의 table과 set에 없는 database의 table은 그대로 둔다.
/// 차이가 null이거나 default가 있는 column의 add_column뿐이면, 그 table들의 live
/// 문서에서 target까지의 plan step(docs/plans.md, "Steps")과 더하는 column을 table
/// 이름, column 순서로 "table.column"으로 돌려준다. 다른 차이는 step 없이
/// "<kind> <table>[.<name>]"로 돌려준다.
pub fn add_column_steps(live: &Document, unsupported: &[Unsupported], target: &Document, dialect: Dialect) -> AddColumnSteps {
    let declared: BTreeMap<&str, &Table> = target.tables.iter().map(|t| (t.name.text.as_str(), t)).collect();
    let mut differences = Vec::new();
    // set의 table에 읽지 못한 객체가 있으면 그 table은 set과 같다고 할 수 없다.
    for u in unsupported {
        if declared.contains_key(u.table.as_str()) {
            differences.push(format!("unsupported_{} {}: {}", u.kind, qualified(&u.table, &u.name), u.reason));
        }
    }
    let existing: BTreeSet<&str> = live.tables.iter().map(|t| t.name.text.as_str()).filter(|name| declared.contains_key(name)).collect();
    let source = schema_document(live.tables.iter().filter(|t| existing.contains(t.name.text.as_str())).cloned().collect());
    let part = schema_document(target.tables.iter().filter(|t| existing.contains(t.name.text.as_str())).cloned().collect());
    let none = |differences| AddColumnSteps { added: Vec::new(), steps: Vec::new(), differences };
    if !differences.is_empty() || part.tables.is_empty() {
        return none(differences);
    }
    let mut adding = BTreeSet::new();
    match compare_schemas(&source, &part) {
        Err(diagnostics) => differences.extend(diagnostics.iter().map(|d| format!("{}: {}", d.rule, d.message))),
        Ok(found) => {
            for d in found {
                if d.kind == "add_column" {
                    let column = declared[d.table.as_str()].columns.iter().find(|c| c.name.text == d.name);
                    match column {
                        Some(c) if c.identity.is_none() && (c.nullable || c.default.is_some()) => {
                            adding.insert(qualified(&d.table, &d.name));
                        }
                        _ => differences.push(format!("add_column {} without null or default", qualified(&d.table, &d.name))),
                    }
                    continue;
                }
                differences.push(format!("{} {}", d.kind, qualified(&d.table, &d.name)));
            }
        }
    }
    if !differences.is_empty() || adding.is_empty() {
        return none(differences);
    }
    // 더하는 column은 table 이름 순, table 안에서는 column 순서다.
    let added: Vec<String> =
        part.tables.iter().flat_map(|t| t.columns.iter().map(|c| qualified(&t.name.text, &c.name.text))).filter(|name| adding.contains(name)).collect();
    // 더하는 column은 plan 하나로 쓴다. plan은 source schema에서 시작하므로 step은
    // docs/plans.md의 순서와 rollback을 그대로 갖는다.
    let steps = manifest(&[&source])
        .and_then(|m| parse_plan(&format!("dbplan 1 add_columns\nfrom {}\n\n{}", m.schema_hash, emit(&part))))
        .and_then(|plan| plan_steps(Some(&source), &plan, dialect));
    match steps {
        Ok(steps) => AddColumnSteps { added, steps, differences: Vec::new() },
        Err(diagnostics) => none(diagnostics.iter().map(|d| format!("{}: {}", d.rule, d.message)).collect()),
    }
}
