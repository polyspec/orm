//! 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 Rust dbspec
//! 결과를 tests/dbspec/compare/check.mjs의 줄 형식으로 출력한다.
//!
//! Usage: `cargo run --release -p orm-schema --example dbspec_compare -- <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>`

use orm_schema::dbspec::{Change, Diagnostic, Dialect, Document, Plan, Unsupported};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::{BufWriter, Write};
use std::process::ExitCode;

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

/// 한 vector file의 값을 위치를 밝히며 읽는다.
struct Reader<'p> {
    path: &'p str,
}

fn at(location: &str, key: &str) -> String {
    if location.is_empty() {
        key.to_string()
    } else {
        format!("{location}.{key}")
    }
}

impl<'p> Reader<'p> {
    /// vector file을 JSON object로 읽어 그 reader와 함께 돌려준다.
    fn open(path: &'p str) -> Result<(Self, Map<String, Value>), String> {
        let reader = Reader { path };
        let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
        match serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))? {
            Value::Object(object) => Ok((reader, object)),
            _ => Err(reader.fail("$", "is not an object")),
        }
    }

    fn fail(&self, location: &str, problem: &str) -> String {
        format!("{}: {location} {problem}", self.path)
    }

    /// `object`의 `key` 값을 돌려주고, 없으면 error를 돌려준다.
    fn field<'v>(&self, object: &'v Map<String, Value>, location: &str, key: &str) -> Result<&'v Value, String> {
        object.get(key).ok_or_else(|| self.fail(&at(location, key), "is missing"))
    }

    fn string(&self, object: &Map<String, Value>, location: &str, key: &str) -> Result<String, String> {
        self.field(object, location, key)?.as_str().map(str::to_string).ok_or_else(|| self.fail(&at(location, key), "is not a string"))
    }

    /// `key`가 없으면 false를, 있으면 boolean인지 확인한 값을 돌려준다.
    fn flag(&self, object: &Map<String, Value>, location: &str, key: &str) -> Result<bool, String> {
        match object.get(key) {
            None => Ok(false),
            Some(value) => value.as_bool().ok_or_else(|| self.fail(&at(location, key), "is not a boolean")),
        }
    }

    /// `value`가 string의 array인지 확인해 돌려준다.
    fn lines(&self, value: &Value, location: &str) -> Result<Vec<String>, String> {
        let items = value.as_array().ok_or_else(|| self.fail(location, "is not an array"))?;
        items
            .iter()
            .enumerate()
            .map(|(i, item)| item.as_str().map(str::to_string).ok_or_else(|| self.fail(&format!("{location}[{i}]"), "is not a string")))
            .collect()
    }

    fn lines_field(&self, object: &Map<String, Value>, location: &str, key: &str) -> Result<Vec<String>, String> {
        self.lines(self.field(object, location, key)?, &at(location, key))
    }

    /// 이름마다 line array를 가진 object를 돌려준다.
    fn documents(&self, object: &Map<String, Value>, location: &str, key: &str) -> Result<Documents, String> {
        let items = self.field(object, location, key)?.as_object().ok_or_else(|| self.fail(&at(location, key), "is not an object"))?;
        items.iter().map(|(name, item)| Ok((name.clone(), self.lines(item, &at(&at(location, key), name))?))).collect()
    }

    /// section `key`의 각 case가 object인지와 그 id를 확인하고 `read`로 case를 읽는다.
    fn cases<T>(
        &self,
        object: &Map<String, Value>,
        key: &str,
        read: impl Fn(&Map<String, Value>, &str, String) -> Result<T, String>,
    ) -> Result<Vec<T>, String> {
        let items = self.field(object, "", key)?.as_array().ok_or_else(|| self.fail(key, "is not an array"))?;
        let mut cases = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            let location = format!("{key}[{i}]");
            let case = item.as_object().ok_or_else(|| self.fail(&location, "is not an object"))?;
            let id = self.string(case, &location, "id")?;
            cases.push(read(case, &location, id)?);
        }
        Ok(cases)
    }

    fn hash_case(&self, case: &Map<String, Value>, location: &str, id: String) -> Result<HashCase, String> {
        Ok(HashCase { id, documents: self.documents(case, location, "documents")? })
    }
}

/// tests/dbspec/cases.json을 읽는다.
fn read_cases(path: &str) -> Result<SharedCases, String> {
    let (r, v) = Reader::open(path)?;
    let test_case = |case: &Map<String, Value>, location: &str, id: String| {
        let main = r.string(case, location, "main")?;
        let documents = r.documents(case, location, "documents")?;
        if !documents.contains_key(&main) {
            return Err(r.fail(&at(&at(location, "documents"), &main), "is missing"));
        }
        Ok(TestCase { id, main, documents, crlf: r.flag(case, location, "crlf")?, mixed: r.flag(case, location, "mixed")? })
    };
    Ok(SharedCases {
        canonical: r.cases(&v, "canonical", test_case)?,
        normalize: r.cases(&v, "normalize", test_case)?,
        invalid: r.cases(&v, "invalid", test_case)?,
        hashes: r.cases(&v, "hashes", |case, location, id| r.hash_case(case, location, id))?,
    })
}

/// tests/dbspec/ddl.json의 cases를 읽는다.
fn read_ddl(path: &str) -> Result<Vec<HashCase>, String> {
    let (r, v) = Reader::open(path)?;
    r.cases(&v, "cases", |case, location, id| r.hash_case(case, location, id))
}

/// tests/dbspec/plans.json을 읽는다. source는 빈 schema를 뜻하는 null이거나 line array이다.
fn read_plans(path: &str) -> Result<PlanVectors, String> {
    let (r, v) = Reader::open(path)?;
    let plan_case = |case: &Map<String, Value>, location: &str, id: String| {
        let source = match r.field(case, location, "source")? {
            Value::Null => None,
            lines => Some(r.lines(lines, &at(location, "source"))?),
        };
        Ok(PlanCase { id, source, plan: r.lines_field(case, location, "plan")? })
    };
    Ok(PlanVectors {
        cases: r.cases(&v, "cases", plan_case)?,
        invalid: r.cases(&v, "invalid", plan_case)?,
        chains: r.cases(&v, "chains", |case, location, id| {
            let items = r.field(case, location, "plans")?.as_array().ok_or_else(|| r.fail(&at(location, "plans"), "is not an array"))?;
            let plans = items.iter().enumerate().map(|(i, item)| r.lines(item, &format!("{}[{i}]", at(location, "plans")))).collect::<Result<_, _>>()?;
            Ok(ChainCase { id, plans })
        })?,
        parse: r.cases(&v, "parse", |case, location, id| Ok(ParseCase { id, plan: r.lines_field(case, location, "plan")? }))?,
        comparisons: r.cases(&v, "comparisons", |case, location, id| {
            Ok(ComparisonCase { id, source: r.lines_field(case, location, "source")?, target: r.lines_field(case, location, "target")? })
        })?,
    })
}

/// tests/dbspec/mermaid.json을 읽는다.
fn read_mermaid(path: &str) -> Result<MermaidVectors, String> {
    let (r, v) = Reader::open(path)?;
    let import_case = |case: &Map<String, Value>, location: &str, id: String| Ok(ImportCase { id, mermaid: r.lines_field(case, location, "mermaid")? });
    Ok(MermaidVectors {
        export: r.cases(&v, "export", |case, location, id| {
            Ok(ExportCase { id, document: r.lines_field(case, location, "document")?, documents: r.documents(case, location, "documents")? })
        })?,
        import: r.cases(&v, "import", import_case)?,
        invalid: r.cases(&v, "invalid", import_case)?,
        round_trip: r.cases(&v, "round_trip", |case, location, id| Ok(RoundTripCase { id, path: r.string(case, location, "path")? }))?,
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
    match orm_schema::dbspec::parse(text, set) {
        Err(diagnostics) => {
            for d in diagnostics {
                writeln!(out, "! {} {} {}", d.rule, d.line, d.column)?;
            }
        }
        Ok(document) => {
            let emitted = orm_schema::dbspec::emit(&document);
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

fn write_diagnostics(out: &mut impl Write, diagnostics: &[orm_schema::dbspec::Diagnostic]) -> std::io::Result<()> {
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
        match orm_schema::dbspec::parse(&join(lines, false, false), &set) {
            Ok(document) => documents.push(document),
            Err(diagnostics) => return write_diagnostics(out, &diagnostics),
        }
    }
    let refs: Vec<&orm_schema::dbspec::Document> = documents.iter().collect();
    match orm_schema::dbspec::manifest(&refs) {
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
        match orm_schema::dbspec::parse(&join(lines, false, false), &set) {
            Ok(document) => documents.push(document),
            Err(diagnostics) => {
                writeln!(out, "render/{id}")?;
                return write_diagnostics(out, &diagnostics);
            }
        }
    }
    let refs: Vec<&orm_schema::dbspec::Document> = documents.iter().collect();
    for (name, dialect) in [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)] {
        writeln!(out, "render/{id}/{name}")?;
        match orm_schema::dbspec::render(&refs, dialect) {
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
        if [orm_schema::dbspec::RULE_PLAN, orm_schema::dbspec::RULE_CHAIN, orm_schema::dbspec::RULE_COMPARE].contains(&d.rule.as_str()) {
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
    for line in orm_schema::dbspec::emit_plan(plan).split('\n') {
        writeln!(out, "| {line}")?;
    }
    Ok(())
}

/// plan case의 source schema이며, 빈 schema이면 `None`, diagnostic을 출력했으면 `Err`다.
fn plan_source(out: &mut impl Write, lines: &Option<Vec<String>>) -> std::io::Result<Result<Option<Document>, ()>> {
    let Some(lines) = lines else {
        return Ok(Ok(None));
    };
    match orm_schema::dbspec::parse(&join(lines, false, false), &BTreeMap::new()) {
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
fn write_plans(out: &mut impl Write, plans: &PlanVectors) -> std::io::Result<()> {
    for case in &plans.cases {
        let id = &case.id;
        writeln!(out, "plans/cases/{id}")?;
        let Ok(source) = plan_source(out, &case.source)? else { continue };
        let plan = match orm_schema::dbspec::parse_plan(&join(&case.plan, false, false)) {
            Ok(plan) => plan,
            Err(diagnostics) => {
                write_plan_diagnostics(out, &diagnostics)?;
                continue;
            }
        };
        write_emitted_plan(out, &plan)?;
        writeln!(out, "plans/cases/{id}/changes")?;
        match orm_schema::dbspec::diff(source.as_ref(), &plan) {
            Ok(changes) => write_changes(out, &changes)?,
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
        for (name, dialect) in [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)] {
            writeln!(out, "plans/cases/{id}/{name}")?;
            match orm_schema::dbspec::plan_statements(source.as_ref(), &plan, dialect) {
                Ok(statements) => {
                    for statement in statements {
                        writeln!(out, "| {statement}")?;
                    }
                }
                Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
            }
        }
    }
    for case in &plans.invalid {
        writeln!(out, "plans/invalid/{}", case.id)?;
        let Ok(source) = plan_source(out, &case.source)? else { continue };
        match orm_schema::dbspec::parse_plan(&join(&case.plan, false, false)) {
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
            Ok(plan) => match orm_schema::dbspec::diff(source.as_ref(), &plan) {
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
            match orm_schema::dbspec::parse_plan(&join(lines, false, false)) {
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
        match orm_schema::dbspec::chain(&parsed) {
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
        match orm_schema::dbspec::parse_plan(&join(&case.plan, false, false)) {
            Ok(plan) => write_emitted_plan(out, &plan)?,
            Err(diagnostics) => write_plan_diagnostics(out, &diagnostics)?,
        }
    }
    for case in &plans.comparisons {
        writeln!(out, "plans/comparisons/{}", case.id)?;
        let source = orm_schema::dbspec::parse(&join(&case.source, false, false), &BTreeMap::new());
        if let Err(diagnostics) = &source {
            write_plan_diagnostics(out, diagnostics)?;
        }
        let target = orm_schema::dbspec::parse(&join(&case.target, false, false), &BTreeMap::new());
        if let Err(diagnostics) = &target {
            write_plan_diagnostics(out, diagnostics)?;
        }
        let (Ok(source), Ok(target)) = (source, target) else { continue };
        match orm_schema::dbspec::compare_schemas(&source, &target) {
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
    let (text, dropped) = orm_schema::dbspec::export_mermaid(document);
    for line in text.split('\n') {
        writeln!(out, "| {line}")?;
    }
    write_dropped(out, &dropped)?;
    Ok(text)
}

/// import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다.
fn write_import(out: &mut impl Write, text: &str) -> std::io::Result<()> {
    match orm_schema::dbspec::import_mermaid(text, "imported") {
        Err(diagnostics) => write_plan_diagnostics(out, &diagnostics),
        Ok((document, dropped)) => {
            for line in orm_schema::dbspec::emit(&document).split('\n') {
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
        match orm_schema::dbspec::parse(&join(&case.document, false, false), &set) {
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
        let source = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
        match orm_schema::dbspec::parse(&source, &BTreeMap::new()) {
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

fn run(cases_path: &str, stress_path: &str, ddl_path: &str, plans_path: &str, mermaid_path: &str) -> Result<(), String> {
    let cases = read_cases(cases_path)?;
    let stress = std::fs::read_to_string(stress_path).map_err(|e| format!("{stress_path}: {e}"))?;
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
    for case in &cases.hashes {
        writeln!(out, "hashes/{}", case.id).map_err(io)?;
        write_manifest(&mut out, case).map_err(io)?;
    }
    for case in &read_ddl(ddl_path)? {
        write_render(&mut out, case).map_err(io)?;
    }
    write_plans(&mut out, &read_plans(plans_path)?).map_err(io)?;
    write_mermaid(&mut out, &read_mermaid(mermaid_path)?)?;
    out.flush().map_err(io)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [cases, stress, ddl, plans, mermaid] = args.as_slice() else {
        eprintln!("usage: dbspec_compare <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>");
        return ExitCode::from(2);
    };
    match run(cases, stress, ddl, plans, mermaid) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
