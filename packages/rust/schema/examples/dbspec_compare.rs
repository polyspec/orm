//! 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 Rust dbspec
//! 결과를 tests/dbspec/compare/check.mts의 줄 형식으로 출력한다. It then prints the positions cases of
//! cases.json and the analysis and format of each case of syntax.json.
//!
//! Usage: `cargo run --release -p polyspec-orm-schema --example dbspec_compare -- <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>`

use polyspec_orm_schema::dbspec::{self, Change, Diagnostic, Dialect, Document, Plan, PlanStep, ReadError, Unsupported};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::process::ExitCode;

#[path = "../tests/common/dbspec_cases.rs"]
mod dbspec_cases;

type Documents = BTreeMap<String, Vec<String>>;

struct TestCase {
    id: String,
    main: String,
    documents: Documents,
    crlf: bool,
    mixed: bool,
}

struct HashCase {
    id: String,
    documents: Documents,
}

struct SharedCases {
    canonical: Vec<TestCase>,
    normalize: Vec<TestCase>,
    invalid: Vec<TestCase>,
    hashes: Vec<HashCase>,
    files: Vec<FileCase>,
    sets: Vec<SetCase>,
    positions: Vec<PositionCase>,
}

/// A document of a sets case with the name of its header.
struct NamedDocument {
    name: String,
    lines: Vec<String>,
}

/// A sets case: its documents, the documents that its parse declares beside them, and its external documents.
struct SetCase {
    id: String,
    documents: Vec<NamedDocument>,
    parsing: Documents,
    external: Vec<NamedDocument>,
}

/// A positions case: a main document and the other documents of its set.
struct PositionCase {
    id: String,
    main: String,
    documents: Documents,
}

/// cases.json 기준 상대 경로로 파일을 이름 짓는 files case.
struct FileCase {
    id: String,
    path: String,
}

/// `source`가 `None`이면 빈 schema이다.
struct PlanCase {
    id: String,
    source: Option<Vec<String>>,
    plan: Vec<String>,
}

struct ChainCase {
    id: String,
    plans: Vec<Vec<String>>,
}

struct ParseCase {
    id: String,
    plan: Vec<String>,
}

/// plan 없이 비교하는 두 schema.
struct ComparisonCase {
    id: String,
    source: Vec<String>,
    target: Vec<String>,
}

struct PlanVectors {
    cases: Vec<PlanCase>,
    invalid: Vec<PlanCase>,
    chains: Vec<ChainCase>,
    parse: Vec<ParseCase>,
    comparisons: Vec<ComparisonCase>,
}

struct ExportCase {
    id: String,
    document: Vec<String>,
    documents: Documents,
}

struct ImportCase {
    id: String,
    mermaid: Vec<String>,
}

struct RoundTripCase {
    id: String,
    path: String,
}

struct MermaidVectors {
    export: Vec<ExportCase>,
    import: Vec<ImportCase>,
    invalid: Vec<ImportCase>,
    round_trip: Vec<RoundTripCase>,
}

/// The schemas declare every field that these readers take, so a value of another shape is a defect of the schema.
const DECLARED: &str = "the schema of the vector file declares this value";

/// Reads the vector file at `path` against the schema tests/dbspec/schema/`kind`.schema.json (tests/common/dbspec_cases.rs);
/// a refusal is an error holding one "<file>: <location> <problem>" line per problem.
fn open(path: &str, kind: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    if kind == "cases" {
        dbspec_cases::check_cases(&value, path)?;
    } else {
        dbspec_cases::check_vectors(&value, kind, path)?;
    }
    Ok(value)
}

fn fail(path: &str, location: &str, problem: &str) -> String {
    format!("{path}: {location} {problem}")
}

fn string(value: &Value) -> String {
    value.as_str().expect(DECLARED).to_string()
}

fn list(value: &Value) -> &Vec<Value> {
    value.as_array().expect(DECLARED)
}

fn lines(value: &Value) -> Vec<String> {
    list(value).iter().map(string).collect()
}

/// An object of line arrays by name.
fn documents(value: &Value) -> Documents {
    value.as_object().expect(DECLARED).iter().map(|(name, item)| (name.clone(), lines(item))).collect()
}

fn hash_case(case: &Value) -> HashCase {
    HashCase { id: string(&case["id"]), documents: documents(&case["documents"]) }
}

/// Names each document of a sets case by its header; a header that names no document is refused.
fn named_documents(path: &str, value: Option<&Value>, location: &str) -> Result<Vec<NamedDocument>, String> {
    let mut named = Vec::new();
    for (i, item) in value.map(list).into_iter().flatten().enumerate() {
        let lines = lines(item);
        let text = lines.join("\n");
        let name = dbspec::parse_set(&[&text], &[]).remove(0).name.ok_or_else(|| fail(path, &format!("{location}[{i}][0]"), "has no document name"))?;
        named.push(NamedDocument { name, lines });
    }
    Ok(named)
}

/// tests/dbspec/cases.json, read against its schema (tests/common/dbspec_cases.rs): a missing section or field, or one
/// that the format does not name, is refused.
fn read_cases(path: &str) -> Result<SharedCases, String> {
    let v = open(path, "cases")?;
    let test_case = |case: &Value| TestCase {
        id: string(&case["id"]),
        main: string(&case["main"]),
        documents: documents(&case["documents"]),
        crlf: case.get("crlf").is_some_and(|flag| flag.as_bool().expect(DECLARED)),
        mixed: case.get("mixed").is_some_and(|flag| flag.as_bool().expect(DECLARED)),
    };
    let mut sets = Vec::new();
    for (i, case) in list(&v["sets"]).iter().enumerate() {
        sets.push(SetCase {
            id: string(&case["id"]),
            documents: named_documents(path, case.get("documents"), &format!("sets[{i}].documents"))?,
            parsing: documents(&case["parsing"]),
            external: named_documents(path, case.get("external"), &format!("sets[{i}].external"))?,
        });
    }
    Ok(SharedCases {
        canonical: list(&v["canonical"]).iter().map(test_case).collect(),
        normalize: list(&v["normalize"]).iter().map(test_case).collect(),
        invalid: list(&v["invalid"]).iter().map(test_case).collect(),
        hashes: list(&v["hashes"]).iter().map(hash_case).collect(),
        files: list(&v["files"]).iter().map(|case| FileCase { id: string(&case["id"]), path: string(&case["path"]) }).collect(),
        sets,
        positions: list(&v["positions"])
            .iter()
            .map(|case| PositionCase { id: string(&case["id"]), main: string(&case["main"]), documents: documents(&case["documents"]) })
            .collect(),
    })
}

/// The case ids of tests/dbspec/syntax.json in file order. The expected
/// tokens are the runtime tests' to check; this runner compares what each client gives.
fn read_syntax(path: &str) -> Result<Vec<String>, String> {
    Ok(list(&open(path, "syntax")?["cases"]).iter().map(|case| string(&case["id"])).collect())
}

/// The input of every analysis that syntax.json names, by its id, as scripts/dbspec/syntax-vectors.mts derives it
/// from cases.json: the main document of each canonical, normalize and invalid case ("<section>/<id>"), each document
/// of a sets case with the parsing documents and the other documents of the case by header name ("sets/<id>/<place>",
/// 1-based), and each document of a hashes case with the others ("hashes/<id>/<name>").
fn syntax_inputs(cases: &SharedCases) -> BTreeMap<String, (String, BTreeMap<String, String>)> {
    let mut inputs = BTreeMap::new();
    for (kind, list) in [("canonical", &cases.canonical), ("normalize", &cases.normalize), ("invalid", &cases.invalid)] {
        for case in list {
            let set =
                case.documents.iter().filter(|(name, _)| **name != case.main).map(|(name, lines)| (name.clone(), join(lines, case.crlf, case.mixed))).collect();
            inputs.insert(format!("{kind}/{}", case.id), (join(&case.documents[&case.main], case.crlf, case.mixed), set));
        }
    }
    for case in &cases.sets {
        let every: Vec<&NamedDocument> = case.documents.iter().chain(&case.external).collect();
        for (i, document) in case.documents.iter().enumerate() {
            let mut set: BTreeMap<String, String> = case.parsing.iter().map(|(name, lines)| (name.clone(), join(lines, false, false))).collect();
            for (j, other) in every.iter().enumerate() {
                if j != i {
                    set.insert(other.name.clone(), join(&other.lines, false, false));
                }
            }
            inputs.insert(format!("sets/{}/{}", case.id, i + 1), (join(&document.lines, false, false), set));
        }
    }
    for case in &cases.hashes {
        for (name, lines) in &case.documents {
            let set = case.documents.iter().filter(|(other, _)| *other != name).map(|(other, l)| (other.clone(), join(l, false, false))).collect();
            inputs.insert(format!("hashes/{}/{name}", case.id), (join(lines, false, false), set));
        }
    }
    inputs
}

/// Prints the declaration positions of the main document of each positions case, as
/// "| kind<TAB>line<TAB>column<TAB>path..." lines, or its diagnostics.
fn write_positions(out: &mut impl Write, cases: &[PositionCase]) -> std::io::Result<()> {
    for case in cases {
        writeln!(out, "positions/{}", case.id)?;
        let set = case.documents.iter().filter(|(name, _)| **name != case.main).map(|(name, lines)| (name.clone(), join(lines, false, false))).collect();
        match polyspec_orm_schema::dbspec::parse(&join(&case.documents[&case.main], false, false), &set) {
            Err(diagnostics) => write_diagnostics(out, &diagnostics)?,
            Ok(parsed) => {
                for p in &parsed.positions {
                    writeln!(out, "| {}\t{}\t{}\t{}", p.kind, p.line, p.column, p.path.join("\t"))?;
                }
            }
        }
    }
    Ok(())
}

/// Prints the analysis of one syntax case, its tokens ("| line start end class") and its diagnostics, then
/// "syntax/<id>/format" and the formatted text or the diagnostics of the refusal.
fn write_syntax(out: &mut impl Write, id: &str, text: &str, set: &BTreeMap<String, String>) -> std::io::Result<()> {
    writeln!(out, "syntax/{id}")?;
    let analysis = polyspec_orm_schema::dbspec::analyze(text, set);
    for t in &analysis.tokens {
        writeln!(out, "| {} {} {} {}", t.line, t.start, t.end, t.class)?;
    }
    write_diagnostics(out, &analysis.diagnostics)?;
    writeln!(out, "syntax/{id}/format")?;
    match polyspec_orm_schema::dbspec::format(text, set) {
        Err(diagnostics) => write_diagnostics(out, &diagnostics),
        Ok(formatted) => {
            for line in formatted.split('\n') {
                writeln!(out, "| {line}")?;
            }
            Ok(())
        }
    }
}

/// tests/dbspec/ddl.json의 cases를 읽는다.
fn read_ddl(path: &str) -> Result<Vec<HashCase>, String> {
    Ok(list(&open(path, "ddl")?["cases"]).iter().map(hash_case).collect())
}

/// tests/dbspec/plans.json을 읽는다. source는 빈 schema를 뜻하는 null이거나 line array이다.
fn read_plans(path: &str) -> Result<PlanVectors, String> {
    let v = open(path, "plans")?;
    let plan_case = |case: &Value| PlanCase {
        id: string(&case["id"]),
        source: if case["source"].is_null() { None } else { Some(lines(&case["source"])) },
        plan: lines(&case["plan"]),
    };
    Ok(PlanVectors {
        cases: list(&v["cases"]).iter().map(plan_case).collect(),
        invalid: list(&v["invalid"]).iter().map(plan_case).collect(),
        chains: list(&v["chains"]).iter().map(|case| ChainCase { id: string(&case["id"]), plans: list(&case["plans"]).iter().map(lines).collect() }).collect(),
        parse: list(&v["parse"]).iter().map(|case| ParseCase { id: string(&case["id"]), plan: lines(&case["plan"]) }).collect(),
        comparisons: list(&v["comparisons"])
            .iter()
            .map(|case| ComparisonCase { id: string(&case["id"]), source: lines(&case["source"]), target: lines(&case["target"]) })
            .collect(),
    })
}

/// tests/dbspec/mermaid.json을 읽는다.
fn read_mermaid(path: &str) -> Result<MermaidVectors, String> {
    let v = open(path, "mermaid")?;
    let import_case = |case: &Value| ImportCase { id: string(&case["id"]), mermaid: lines(&case["mermaid"]) };
    Ok(MermaidVectors {
        export: list(&v["export"])
            .iter()
            .map(|case| ExportCase { id: string(&case["id"]), document: lines(&case["document"]), documents: documents(&case["documents"]) })
            .collect(),
        import: list(&v["import"]).iter().map(import_case).collect(),
        invalid: list(&v["invalid"]).iter().map(import_case).collect(),
        round_trip: list(&v["round_trip"]).iter().map(|case| RoundTripCase { id: string(&case["id"]), path: string(&case["path"]) }).collect(),
    })
}

/// 줄을 LF로, `crlf`이면 CRLF로, `mixed`이면 CRLF와 LF를 번갈아 마지막 줄 끝 없이 잇는다.
fn join(lines: &[String], crlf: bool, mixed: bool) -> String {
    let mut text = String::new();
    for (i, line) in lines.iter().enumerate() {
        text.push_str(line);
        if mixed {
            if i + 1 < lines.len() {
                text.push_str(if i % 2 == 0 { "\r\n" } else { "\n" });
            }
        } else {
            text.push_str(if crlf { "\r\n" } else { "\n" });
        }
    }
    text
}

/// `text`의 diagnostic을, 없으면 그 emission을 출력한다.
fn write(out: &mut impl Write, text: &str, set: &BTreeMap<String, String>, stress: bool) -> std::io::Result<()> {
    match polyspec_orm_schema::dbspec::parse(text, set).map(|parsed| parsed.document) {
        Err(diagnostics) => {
            for d in diagnostics {
                writeln!(out, "! {} {} {}", d.rule, d.line, d.column)?;
            }
        }
        Ok(document) => {
            let emitted = polyspec_orm_schema::dbspec::emit(&document);
            if stress {
                writeln!(out, "= {}", if emitted == text { "unchanged" } else { "changed" })?;
            } else {
                for line in emitted.split('\n') {
                    writeln!(out, "| {line}")?;
                }
            }
        }
    }
    Ok(())
}

fn write_diagnostics(out: &mut impl Write, diagnostics: &[polyspec_orm_schema::dbspec::Diagnostic]) -> std::io::Result<()> {
    for d in diagnostics {
        writeln!(out, "! {} {} {}", d.rule, d.line, d.column)?;
    }
    Ok(())
}

/// case 문서 집합의 hash와 text를, 또는 문서나 집합의 diagnostic을 출력한다.
fn write_manifest(out: &mut impl Write, case: &HashCase) -> std::io::Result<()> {
    let mut documents = Vec::new();
    for (name, lines) in &case.documents {
        let set = case.documents.iter().filter(|(other, _)| *other != name).map(|(other, l)| (other.clone(), join(l, false, false))).collect();
        match polyspec_orm_schema::dbspec::parse(&join(lines, false, false), &set).map(|parsed| parsed.document) {
            Ok(document) => documents.push(document),
            Err(diagnostics) => return write_diagnostics(out, &diagnostics),
        }
    }
    let refs: Vec<&polyspec_orm_schema::dbspec::Document> = documents.iter().collect();
    match polyspec_orm_schema::dbspec::manifest(&refs) {
        Err(diagnostics) => write_diagnostics(out, &diagnostics),
        Ok(m) => {
            writeln!(out, "= manifestHash {}\n= schemaHash {}\n= manifestText", m.manifest_hash, m.schema_hash)?;
            for line in m.manifest_text.split('\n') {
                writeln!(out, "| {line}")?;
            }
            writeln!(out, "= schemaText")?;
            for line in m.schema_text.split('\n') {
                writeln!(out, "| {line}")?;
            }
            Ok(())
        }
    }
}

/// case 문서 집합의 statement를 dialect마다, 또는 문서나 집합의 diagnostic을 출력한다.
fn write_render(out: &mut impl Write, case: &HashCase) -> std::io::Result<()> {
    let id = &case.id;
    let mut documents = Vec::new();
    for (name, lines) in &case.documents {
        let set = case.documents.iter().filter(|(other, _)| *other != name).map(|(other, l)| (other.clone(), join(l, false, false))).collect();
        match polyspec_orm_schema::dbspec::parse(&join(lines, false, false), &set).map(|parsed| parsed.document) {
            Ok(document) => documents.push(document),
            Err(diagnostics) => {
                writeln!(out, "render/{id}")?;
                return write_diagnostics(out, &diagnostics);
            }
        }
    }
    let refs: Vec<&polyspec_orm_schema::dbspec::Document> = documents.iter().collect();
    for (name, dialect) in [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)] {
        writeln!(out, "render/{id}/{name}")?;
        match polyspec_orm_schema::dbspec::render(&refs, dialect) {
            Ok(statements) => {
                for statement in statements {
                    writeln!(out, "| {statement}")?;
                }
            }
            Err(diagnostics) => write_diagnostics(out, &diagnostics)?,
        }
    }
    Ok(())
}

/// diagnostic을 출력한다. plan, chain, compare diagnostic은 모든 client가 공유하는 message로
/// 끝나고, target이나 source의 schema diagnostic은 그렇지 않다.
fn write_plan_diagnostics(out: &mut impl Write, diagnostics: &[Diagnostic]) -> std::io::Result<()> {
    for d in diagnostics {
        if [polyspec_orm_schema::dbspec::RULE_PLAN, polyspec_orm_schema::dbspec::RULE_CHAIN, polyspec_orm_schema::dbspec::RULE_COMPARE]
            .contains(&d.rule.as_str())
        {
            writeln!(out, "! {} {} {} {}", d.rule, d.line, d.column, d.message)?;
        } else {
            writeln!(out, "! {} {} {}", d.rule, d.line, d.column)?;
        }
    }
    Ok(())
}

/// change를 `| kind table name`으로 출력한다.
fn write_changes(out: &mut impl Write, changes: &[Change]) -> std::io::Result<()> {
    for c in changes {
        writeln!(out, "| {} {} {}", c.kind, c.table, c.name)?;
    }
    Ok(())
}

fn write_emitted_plan(out: &mut impl Write, plan: &Plan) -> std::io::Result<()> {
    for line in polyspec_orm_schema::dbspec::emit_plan(plan).split('\n') {
        writeln!(out, "| {line}")?;
    }
    Ok(())
}

/// plan case의 source schema이며, 빈 schema이면 `None`, diagnostic을 출력했으면 `Err`다.
fn plan_source(out: &mut impl Write, lines: &Option<Vec<String>>) -> std::io::Result<Result<Option<Document>, ()>> {
    let Some(lines) = lines else {
        return Ok(Ok(None));
    };
    match polyspec_orm_schema::dbspec::parse(&join(lines, false, false), &BTreeMap::new()).map(|parsed| parsed.document) {
        Ok(document) => Ok(Ok(Some(document))),
        Err(diagnostics) => {
            write_plan_diagnostics(out, &diagnostics)?;
            Ok(Err(()))
        }
    }
}

/// plan case마다 emit한 plan, change, dialect별 statement를, invalid case마다 diagnostic을,
/// chain case마다 chain 순서나 diagnostic을, parse case마다 diagnostic이나 emit한 plan을,
/// comparison마다 차이나 diagnostic을 출력한다.
/// step 하나를 statement 줄과 그 속성 줄로 쓴다(tests/dbspec/compare/check.mts).
fn write_step(out: &mut impl Write, s: &PlanStep) -> std::io::Result<()> {
    writeln!(out, "| {}", s.statement)?;
    if s.finalize {
        writeln!(out, "  finalize")?;
    } else if !s.rollback.is_empty() {
        writeln!(out, "  rollback: {}", s.rollback)?;
    } else {
        writeln!(out, "  irreversible: {}", s.irreversible)?;
    }
    writeln!(out, "  effect: {}", s.effect)?;
    if !s.restore.is_empty() {
        writeln!(out, "  restore: {}", s.restore)?;
    }
    if !s.rollback_restore.is_empty() {
        writeln!(out, "  rollback_restore: {}", s.rollback_restore)?;
    }
    if let Some(e) = s.restore_if.as_ref().filter(|_| !s.restore.is_empty() || !s.rollback_restore.is_empty()) {
        writeln!(out, "  restore_if: {e}")?;
    }
    for c in &s.null_checks {
        writeln!(out, "  null_check: {} {} {}", c.table, c.column, c.default.as_deref().unwrap_or("none"))?;
    }
    Ok(())
}

fn write_plans(out: &mut impl Write, plans: &PlanVectors) -> std::io::Result<()> {
    for case in &plans.cases {
        let id = &case.id;
        writeln!(out, "plans/cases/{id}")?;
        let Ok(source) = plan_source(out, &case.source)? else { continue };
        let plan = match polyspec_orm_schema::dbspec::parse_plan(&join(&case.plan, false, false)) {
            Ok(plan) => plan,
            Err(diagnostics) => {
                write_plan_diagnostics(out, &diagnostics)?;
                continue;
            }
        };
        write_emitted_plan(out, &plan)?;
        writeln!(out, "plans/cases/{id}/changes")?;
        match polyspec_orm_schema::dbspec::diff(source.as_ref(), &plan) {
            Ok(changes) => write_changes(out, &changes)?,
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
        for (name, dialect) in [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)] {
            writeln!(out, "plans/cases/{id}/{name}")?;
            match polyspec_orm_schema::dbspec::plan_steps(source.as_ref(), &plan, dialect) {
                Ok(steps) => {
                    for step in &steps {
                        write_step(out, step)?;
                    }
                }
                Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
            }
        }
    }
    for case in &plans.invalid {
        writeln!(out, "plans/invalid/{}", case.id)?;
        let Ok(source) = plan_source(out, &case.source)? else { continue };
        match polyspec_orm_schema::dbspec::parse_plan(&join(&case.plan, false, false)) {
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
            Ok(plan) => match polyspec_orm_schema::dbspec::diff(source.as_ref(), &plan) {
                Ok(changes) => write_changes(out, &changes)?,
                Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
            },
        }
    }
    for case in &plans.chains {
        writeln!(out, "plans/chains/{}", case.id)?;
        let mut parsed = Vec::new();
        let mut failed = false;
        for lines in &case.plans {
            match polyspec_orm_schema::dbspec::parse_plan(&join(lines, false, false)) {
                Ok(plan) => parsed.push(plan),
                Err(diagnostics) => {
                    write_plan_diagnostics(out, &diagnostics)?;
                    failed = true;
                }
            }
        }
        if failed {
            continue;
        }
        match polyspec_orm_schema::dbspec::chain(&parsed) {
            Ok(chain) => {
                for plan in chain {
                    writeln!(out, "| {}", plan.name())?;
                }
            }
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
    }
    for case in &plans.parse {
        writeln!(out, "plans/parse/{}", case.id)?;
        match polyspec_orm_schema::dbspec::parse_plan(&join(&case.plan, false, false)) {
            Ok(plan) => write_emitted_plan(out, &plan)?,
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
    }
    for case in &plans.comparisons {
        writeln!(out, "plans/comparisons/{}", case.id)?;
        let source = polyspec_orm_schema::dbspec::parse(&join(&case.source, false, false), &BTreeMap::new()).map(|parsed| parsed.document);
        if let Err(diagnostics) = &source {
            write_plan_diagnostics(out, diagnostics)?;
        }
        let target = polyspec_orm_schema::dbspec::parse(&join(&case.target, false, false), &BTreeMap::new()).map(|parsed| parsed.document);
        if let Err(diagnostics) = &target {
            write_plan_diagnostics(out, diagnostics)?;
        }
        let (Ok(source), Ok(target)) = (source, target) else { continue };
        match polyspec_orm_schema::dbspec::compare_schemas(&source, &target) {
            Ok(differences) => {
                for d in differences {
                    writeln!(out, "| {} {} {}", d.kind, d.table, d.name)?;
                }
            }
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
    }
    Ok(())
}

/// export나 import가 뺀 것을 `= kind<TAB>table<TAB>name`으로 출력하며 이유는 비교하지 않는다.
fn write_dropped(out: &mut impl Write, dropped: &[Unsupported]) -> std::io::Result<()> {
    for u in dropped {
        writeln!(out, "= {}\t{}\t{}", u.kind, u.table, u.name)?;
    }
    Ok(())
}

/// 문서의 Mermaid text와 빠진 객체를 출력하고 text를 돌려준다.
fn write_export(out: &mut impl Write, document: &Document) -> std::io::Result<String> {
    let (text, dropped) = polyspec_orm_schema::dbspec::export_mermaid(document);
    for line in text.split('\n') {
        writeln!(out, "| {line}")?;
    }
    write_dropped(out, &dropped)?;
    Ok(text)
}

/// import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다.
fn write_import(out: &mut impl Write, text: &str) -> std::io::Result<()> {
    match polyspec_orm_schema::dbspec::import_mermaid(text, "imported") {
        Err(diagnostics) => write_plan_diagnostics(out, &diagnostics),
        Ok((document, dropped)) => {
            for line in polyspec_orm_schema::dbspec::emit(&document).split('\n') {
                writeln!(out, "| {line}")?;
            }
            write_dropped(out, &dropped)
        }
    }
}

/// 모든 export case, import와 invalid case, round trip case를 출력한다. round trip case는
/// 문서의 export, 그다음 `<case>/import`와 그 export의 import다.
fn write_mermaid(out: &mut impl Write, mermaid: &MermaidVectors) -> Result<(), String> {
    let io = |e: std::io::Error| e.to_string();
    for case in &mermaid.export {
        writeln!(out, "mermaid/export/{}", case.id).map_err(io)?;
        let set = case.documents.iter().map(|(name, lines)| (name.clone(), join(lines, false, false))).collect();
        match polyspec_orm_schema::dbspec::parse(&join(&case.document, false, false), &set).map(|parsed| parsed.document) {
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics).map_err(io)?,
            Ok(document) => {
                write_export(out, &document).map_err(io)?;
            }
        }
    }
    for (kind, cases) in [("import", &mermaid.import), ("invalid", &mermaid.invalid)] {
        for case in cases {
            writeln!(out, "mermaid/{kind}/{}", case.id).map_err(io)?;
            write_import(out, &join(&case.mermaid, false, false)).map_err(io)?;
        }
    }
    for case in &mermaid.round_trip {
        let id = &case.id;
        writeln!(out, "mermaid/round_trip/{id}").map_err(io)?;
        let path = &case.path;
        let source = match polyspec_orm_schema::dbspec::read_file(Path::new(path)) {
            Ok(source) => source,
            Err(ReadError::Io(e)) => return Err(format!("{path}: {e}")),
            Err(ReadError::Diagnostics(diagnostics)) => {
                write_plan_diagnostics(out, &diagnostics).map_err(io)?;
                continue;
            }
        };
        match polyspec_orm_schema::dbspec::parse(&source, &BTreeMap::new()).map(|parsed| parsed.document) {
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics).map_err(io)?,
            Ok(document) => {
                let text = write_export(out, &document).map_err(io)?;
                writeln!(out, "mermaid/round_trip/{id}/import").map_err(io)?;
                write_import(out, &text).map_err(io)?;
            }
        }
    }
    Ok(())
}

fn run(cases_path: &str, stress_path: &str, ddl_path: &str, plans_path: &str, mermaid_path: &str, syntax_path: &str) -> Result<(), String> {
    let cases = read_cases(cases_path)?;
    let stress = match polyspec_orm_schema::dbspec::read_file(Path::new(stress_path)) {
        Ok(text) => text,
        Err(ReadError::Io(e)) => return Err(format!("{stress_path}: {e}")),
        Err(ReadError::Diagnostics(diagnostics)) => return Err(diagnostics[0].message.clone()),
    };
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let io = |e: std::io::Error| e.to_string();
    for (kind, cases) in [("canonical", &cases.canonical), ("normalize", &cases.normalize), ("invalid", &cases.invalid)] {
        for case in cases {
            let mut set = BTreeMap::new();
            for (name, lines) in &case.documents {
                if *name != case.main {
                    set.insert(name.clone(), join(lines, case.crlf, case.mixed));
                }
            }
            writeln!(out, "{kind}/{}", case.id).map_err(io)?;
            write(&mut out, &join(&case.documents[&case.main], case.crlf, case.mixed), &set, false).map_err(io)?;
        }
    }
    writeln!(out, "stress").map_err(io)?;
    write(&mut out, &stress, &BTreeMap::new(), true).map_err(io)?;
    // files case는 read_file에 path를 주어 "files/<id>"로, read_bytes에 파일 byte와 case path를
    // 이름으로 주어 "files/<id>/bytes"로 읽어 diagnostic과 그 message를, 없으면 emission을
    // 출력한다. message 앞의 이름은 "<name>"으로 쓴다.
    let directory = Path::new(cases_path).parent().unwrap_or(Path::new(""));
    for case in &cases.files {
        let path = directory.join(&case.path);
        let shown = path.display().to_string();
        let raw = std::fs::read(&path).map_err(|e| format!("{shown}: {e}"))?;
        let reads = [
            (format!("files/{}", case.id), shown.as_str(), polyspec_orm_schema::dbspec::read_file(&path)),
            (format!("files/{}/bytes", case.id), case.path.as_str(), polyspec_orm_schema::dbspec::read_bytes(&case.path, raw).map_err(ReadError::Diagnostics)),
        ];
        for (label, name, read) in reads {
            writeln!(out, "{label}").map_err(io)?;
            match read {
                Ok(text) => write(&mut out, &text, &BTreeMap::new(), false).map_err(io)?,
                Err(ReadError::Io(e)) => return Err(format!("{shown}: {e}")),
                Err(ReadError::Diagnostics(diagnostics)) => {
                    for d in &diagnostics {
                        writeln!(out, "! {} {} {}", d.rule, d.line, d.column).map_err(io)?;
                        match d.message.strip_prefix(name) {
                            Some(rest) => writeln!(out, "= <name>{rest}").map_err(io)?,
                            None => writeln!(out, "= {}", d.message).map_err(io)?,
                        }
                    }
                }
            }
        }
    }
    for case in &cases.hashes {
        writeln!(out, "hashes/{}", case.id).map_err(io)?;
        write_manifest(&mut out, case).map_err(io)?;
    }
    for case in &read_ddl(ddl_path)? {
        write_render(&mut out, case).map_err(io)?;
    }
    write_plans(&mut out, &read_plans(plans_path)?).map_err(io)?;
    write_mermaid(&mut out, &read_mermaid(mermaid_path)?)?;
    write_positions(&mut out, &cases.positions).map_err(io)?;
    let ids = read_syntax(syntax_path)?;
    let inputs = syntax_inputs(&cases);
    for (i, id) in ids.iter().enumerate() {
        let (text, set) = inputs.get(id).ok_or_else(|| fail(syntax_path, &format!("cases[{i}].id"), "names no input of the shared cases"))?;
        write_syntax(&mut out, id, text, set).map_err(io)?;
    }
    out.flush().map_err(io)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [cases, stress, ddl, plans, mermaid, syntax] = args.as_slice() else {
        eprintln!("usage: dbspec_compare <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>");
        return ExitCode::from(2);
    };
    match run(cases, stress, ddl, plans, mermaid, syntax) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
