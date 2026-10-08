//! 연결의 addTablesAndColumns가 실행할 step을 쓴다(docs/schema.md, "Adding tables and columns").

use super::model::{Name, Pos, Table};
use super::plan::plan_to;
use super::{compare_schemas, emit, manifest, plan_steps, Dialect, Document, Plan, PlanStep, Unsupported};
use std::collections::{BTreeMap, BTreeSet};

/// [`add_tables_and_columns_steps`]의 결과: 만드는 table과 더하는 column, step, 또는 차이다.
#[derive(Clone, Debug)]
pub struct AddTablesAndColumnsSteps {
    /// table 이름 순으로 만드는 table은 "table", 더하는 column은 column 순서로 "table.column".
    pub added: Vec<String>,
    pub steps: Vec<PlanStep>,
    /// create_table이나 add_column이 아닌 차이, "<kind> <table>[.<name>]".
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
        external: false,
    }
}

/// database에 있는 set의 table(source)이다. set의 table에 읽지 못한 객체가 있으면 그 table은
/// set과 같다고 할 수 없으므로 그 객체를 "unsupported_<kind> <table>[.<name>]: <reason>"로
/// 돌려준다.
fn set_source(live: &Document, unsupported: &[Unsupported], target: &Document) -> Result<Document, Vec<String>> {
    let declared: BTreeSet<&str> = target.tables.iter().map(|t| t.name.text.as_str()).collect();
    let differences: Vec<String> = unsupported
        .iter()
        .filter(|u| declared.contains(u.table.as_str()))
        .map(|u| format!("unsupported_{} {}: {}", u.kind, qualified(&u.table, &u.name), u.reason))
        .collect();
    if !differences.is_empty() {
        return Err(differences);
    }
    Ok(schema_document(live.tables.iter().filter(|t| declared.contains(t.name.text.as_str())).cloned().collect()))
}

/// database가 document set과 같은지 확인한다(docs/schema.md, "Schema installation"). `live`는
/// 연결의 database를 introspect한 문서, `unsupported`는 introspection이 읽지 못한 객체,
/// `target`은 document set의 schema text 문서다. set에 없는 database의 table은 비교하지 않는다.
/// set의 table에 읽지 못한 객체가 있으면 그 객체를 "unsupported_<kind> <table>[.<name>]: <reason>"로,
/// 아니면 database에 있는 set의 table에서 set까지의 모든 차이를 "<kind> <table>[.<name>]"로
/// 돌려준다. 빈 목록이면 같다.
pub fn installed_differences(live: &Document, unsupported: &[Unsupported], target: &Document) -> Vec<String> {
    let source = match set_source(live, unsupported, target) {
        Ok(source) => source,
        Err(differences) => return differences,
    };
    match compare_schemas(&source, target) {
        Err(diagnostics) => diagnostics.iter().map(|d| format!("{}: {}", d.rule, d.message)).collect(),
        Ok(found) => found.iter().map(|d| format!("{} {}", d.kind, qualified(&d.table, &d.name))).collect(),
    }
}

/// `live`는 연결의 database를 introspect한 문서, `unsupported`는 introspection이 읽지
/// 못한 객체, `target`은 document set의 schema text 문서다. set에 없는 database의 table은
/// 비교하지도 바꾸지도 않는다. database에 있는 set의 table과 set의 차이가 database에 없는
/// table의 create_table, null이거나 default가 있는 column의 add_column, unique가 아닌 index의
/// add_index뿐이면, database에 있는 set의 table에서 set까지의 plan step(docs/plans.md,
/// "Steps")과, table 이름 순으로 만드는 table은 "table", 더하는 column은 column 순서로
/// "table.column", 그 뒤 더하는 index는 index 순서로 "table.index"인 목록을 돌려준다. 다른
/// 차이는 step 없이 "<kind> <table>[.<name>]"로 돌려주며, 빠진 unique key는 있는 행에서 실패할
/// 수 있으므로 그 이유와 함께 돌려준다.
pub fn add_tables_and_columns_steps(live: &Document, unsupported: &[Unsupported], target: &Document, dialect: Dialect) -> AddTablesAndColumnsSteps {
    let declared: BTreeMap<&str, &Table> = target.tables.iter().map(|t| (t.name.text.as_str(), t)).collect();
    let mut differences = Vec::new();
    let none = |differences| AddTablesAndColumnsSteps { added: Vec::new(), steps: Vec::new(), differences };
    let source = match set_source(live, unsupported, target) {
        Ok(source) => source,
        Err(differences) => return none(differences),
    };
    let mut adding = BTreeSet::new();
    match compare_schemas(&source, target) {
        Err(diagnostics) => differences.extend(diagnostics.iter().map(|d| format!("{}: {}", d.rule, d.message))),
        Ok(found) => {
            for d in found {
                match d.kind.as_str() {
                    "create_table" => {
                        adding.insert(d.table.clone());
                    }
                    "add_column" => {
                        let column = declared[d.table.as_str()].columns.iter().find(|c| c.name.text == d.name);
                        match column {
                            Some(c) if c.identity.is_none() && (c.nullable || c.default.is_some()) => {
                                adding.insert(qualified(&d.table, &d.name));
                            }
                            _ => differences.push(format!("add_column {} without null or default", qualified(&d.table, &d.name))),
                        }
                    }
                    // index는 행을 거부하지 않으므로 있는 table에도 더한다.
                    "add_index" => {
                        adding.insert(qualified(&d.table, &d.name));
                    }
                    // unique key는 있는 행이 겹치면 실패하므로 plan과 apply가 다룬다.
                    "add_unique" => differences
                        .push(format!("add_unique {}: a missing unique key can fail on the existing rows; add it with a plan", qualified(&d.table, &d.name))),
                    _ => differences.push(format!("{} {}", d.kind, qualified(&d.table, &d.name))),
                }
            }
        }
    }
    if !differences.is_empty() || adding.is_empty() {
        return none(differences);
    }
    // 만드는 table과 더하는 column과 index는 table 이름 순, table 안에서는 column 순서 뒤 index 순서다.
    let added: Vec<String> = target
        .tables
        .iter()
        .flat_map(|t| {
            if adding.contains(&t.name.text) {
                vec![t.name.text.clone()]
            } else {
                t.columns
                    .iter()
                    .map(|c| qualified(&t.name.text, &c.name.text))
                    .chain(t.indexes.iter().map(|i| qualified(&t.name.text, &i.name.text)))
                    .filter(|name| adding.contains(name))
                    .collect()
            }
        })
        .collect();
    // 더하는 table과 column은 plan 하나로 쓴다. plan은 database에 있는 set의 table에서
    // 시작하므로(하나도 없으면 빈 database) step은 docs/plans.md의 순서와 rollback을 그대로
    // 갖는다.
    let start = (!source.tables.is_empty()).then_some(&source);
    let from = match start {
        Some(source) => manifest(&[source]).map(|m| Some(m.schema_hash)),
        None => Ok(None),
    };
    // target은 외부 문서를 쓰는 set의 schema text일 수 있으므로 plan 문서를 parse하지 않고 target으로 plan을
    // 만든다.
    let steps = from
        .and_then(|from| {
            plan_to(Plan {
                name: "add_tables_and_columns".to_owned(),
                from,
                rename_tables: Vec::new(),
                rename_columns: Vec::new(),
                drop_tables: Vec::new(),
                drop_columns: Vec::new(),
                schema: target.clone(),
                schema_text: emit(target),
                to: String::new(),
            })
        })
        .and_then(|plan| plan_steps(start, &plan, dialect));
    match steps {
        Ok(steps) => AddTablesAndColumnsSteps { added, steps, differences: Vec::new() },
        Err(diagnostics) => none(diagnostics.iter().map(|d| format!("{}: {}", d.rule, d.message)).collect()),
    }
}
