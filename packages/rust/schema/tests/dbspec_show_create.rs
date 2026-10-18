//! The cases of tests/dbspec/show-create.json through the public MySQL
//! introspection of `polyspec_orm_schema::dbspec` (docs/dialects.md,
//! "Introspection"): `catalog_queries`, `catalog_followups` and `read_catalog`
//! read the canned catalog of the file with the SHOW CREATE TABLE of each case,
//! and give the check lines and the unsupported objects that the case expects,
//! or its error. The reader of SHOW CREATE TABLE stays private to the
//! introspection; this public path states every case under its id (T148-2-1).

use polyspec_orm_schema::dbspec::{self, catalog_followups, catalog_queries, read_catalog, CatalogValue, Dialect};
use polyspec_orm_testcase::Trial;
use serde_json::Value;
use std::time::Duration;

/// The deadline of one case.
const DEADLINE: Duration = Duration::from_secs(5);

fn text(value: &Value) -> CatalogValue {
    CatalogValue::Text(value.as_str().expect("catalog text").to_owned())
}

fn texts(value: &Value) -> Vec<String> {
    value.as_array().map(|list| list.iter().map(|v| v.as_str().expect("text").to_owned()).collect()).unwrap_or_default()
}

/// The rows that the catalog of the file answers to `query`; an unknown query is an error.
fn answer(catalog: &Value, name: &str, create: &str, query: &str) -> Result<Vec<Vec<CatalogValue>>, String> {
    let t = || text(&catalog["table"]);
    let s = |v: &str| CatalogValue::Text(v.to_owned());
    Ok(if query.contains("information_schema.TABLES") {
        vec![vec![t(), s("BASE TABLE"), s("")]]
    } else if query.contains("information_schema.COLUMNS") {
        let columns = catalog["columns"].as_array().expect("catalog columns");
        columns
            .iter()
            .map(|c| {
                vec![
                    t(),
                    text(&c["name"]),
                    text(&c["type"]),
                    text(&c["nullable"]),
                    CatalogValue::Null,
                    s(""),
                    text(&c["charset"]),
                    text(&c["collation"]),
                    s(""),
                ]
            })
            .collect()
    } else if query.contains("information_schema.STATISTICS") {
        vec![vec![t(), s("PRIMARY"), CatalogValue::Int(0), text(&catalog["primary_key"]), s("A"), CatalogValue::Int(0), CatalogValue::Int(0), s("BTREE")]]
    } else if query.contains("REFERENTIAL_CONSTRAINTS") {
        Vec::new()
    } else if query.contains("CHECK_CONSTRAINTS") {
        vec![vec![s(name), text(&catalog["stored_clause"])]]
    } else if query.contains("TABLE_CONSTRAINTS") {
        vec![vec![t(), s(name), s("YES")]]
    } else if query.contains("information_schema.TRIGGERS") || query.contains("information_schema.ROUTINES") || query.contains("information_schema.EVENTS") {
        Vec::new()
    } else if query.contains("SHOW CREATE TABLE") {
        vec![vec![t(), s(create)]]
    } else {
        return Err(format!("the catalog has no answer for the query {query:?}"));
    })
}

fn run_case(catalog: &Value, case: &Value) -> Result<(), String> {
    let name = case["name"].as_str().expect("case name");
    let create = format!("{}\n", texts(&case["create"]).join("\n"));
    let table = catalog["table"].as_str().expect("catalog table");
    let mut results = Vec::new();
    for query in catalog_queries(Dialect::MySql) {
        results.push(answer(catalog, name, &create, query)?);
    }
    for query in catalog_followups(Dialect::MySql, &results)? {
        results.push(answer(catalog, name, &create, &query)?);
    }
    let read = read_catalog(Dialect::MySql, &results, table);
    if let Some(want) = case["error"].as_str() {
        return match read {
            Err(got) if got == want => Ok(()),
            Err(got) => Err(format!("error\nwant {want:?}\ngot  {got:?}")),
            Ok(_) => Err(format!("read the catalog, want the error {want:?}")),
        };
    }
    let introspection = read?;
    let checks: Vec<String> =
        dbspec::emit(&introspection.document).lines().map(str::trim).filter(|line| line.starts_with("check ")).map(str::to_owned).collect();
    // The reason text differs between the clients; the rule before the first ": " is compared.
    let unsupported: Vec<String> = introspection
        .unsupported
        .iter()
        .map(|u| format!("{} {}: {}", u.kind, u.name, u.reason.split_once(": ").map_or(u.reason.as_str(), |(rule, _)| rule)))
        .collect();
    if checks != texts(&case["checks"]) {
        return Err(format!("checks\nwant {:?}\ngot  {checks:?}", texts(&case["checks"])));
    }
    if unsupported != texts(&case["unsupported"]) {
        return Err(format!("unsupported\nwant {:?}\ngot  {unsupported:?}", texts(&case["unsupported"])));
    }
    Ok(())
}

fn show_create_vectors() -> Vec<Trial> {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/show-create.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("show-create.json");
    let cases = vectors["cases"].as_array().expect("show-create.json cases").clone();
    assert!(!cases.is_empty(), "tests/dbspec/show-create.json has no cases");
    cases
        .into_iter()
        .map(|case| {
            let catalog = vectors["catalog"].clone();
            let id = case["id"].as_str().expect("case id").to_owned();
            polyspec_orm_testcase::trial(format!("show_create_vectors::{id}"), polyspec_orm_testcase::wall_for_cpu(DEADLINE), move || {
                if let Err(e) = run_case(&catalog, &case) {
                    panic!("case {id}: {e}");
                }
            })
        })
        .collect()
}

fn main() {
    polyspec_orm_testcase::run(show_create_vectors());
}
