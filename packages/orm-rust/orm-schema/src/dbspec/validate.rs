//! Rules that relate lines to each other: names, keys, foreign keys, checks,
//! settings, `use` and diagrams.

use super::check_type::{type_check, CheckLiterals};
use super::model::*;
use super::parser::{name_problem, well_formed, DefaultToken, Diag, FailedKeys, Parsed, MAX_NAME_BYTES};
use std::collections::{BTreeSet, HashMap, HashSet};

const MAX_KEY_COLUMNS: usize = 16;
const MAX_KEY_VARCHAR: u32 = 640;
const BLIND_INDEX_LENGTH: u16 = 64;

fn err(pos: Pos, rule: &'static str, message: impl Into<String>) -> Diag {
    Diag { pos, rule, message: message.into() }
}

enum Lookup<'d> {
    Found(&'d Column),
    /// The column's line failed; its errors are already reported.
    Unresolved,
    Missing,
}

/// A table with the names of its columns whose lines failed.
#[derive(Clone, Copy)]
struct TableScope<'s, 'd> {
    table: &'d Table,
    unresolved: Option<&'s HashSet<&'d str>>,
    failed_keys: FailedKeys,
    /// 표 줄이 실패했다. Go의 failed table로서 이 표를 가리키는 참조와 이름 중복을 보고하지 않는다.
    header_failed: bool,
}

impl<'s, 'd> TableScope<'s, 'd> {
    /// A column whose line failed, which the rules that name it report nothing about.
    fn failed(&self, name: &str) -> bool {
        self.unresolved.is_some_and(|u| u.contains(name))
    }

    fn column(&self, name: &str) -> Lookup<'d> {
        match self.table.column(name) {
            Some(column) => Lookup::Found(column),
            None if !well_formed(name) || self.unresolved.is_some_and(|u| u.contains(name)) => Lookup::Unresolved,
            None => Lookup::Missing,
        }
    }
}

struct Scope<'d> {
    /// Tables of the document by name, as indexes into `document.tables`.
    tables: HashMap<&'d str, usize>,
    document: &'d Document,
    failed: Vec<HashSet<&'d str>>,
    failed_keys: &'d [FailedKeys],
    header_failed: &'d [bool],
    used: HashMap<&'d str, &'d Table>,
    /// Tables of `use` lines whose document or table failed; references to them report nothing more.
    unresolved: HashSet<&'d str>,
}

impl<'d> Scope<'d> {
    fn own(&self, index: usize) -> TableScope<'_, 'd> {
        TableScope {
            table: &self.document.tables[index],
            unresolved: Some(&self.failed[index]),
            failed_keys: self.failed_keys.get(index).copied().unwrap_or_default(),
            header_failed: self.header_failed.get(index).copied().unwrap_or(false),
        }
    }

    /// A table of the document or a used table.
    fn table(&self, name: &str) -> Option<TableScope<'_, 'd>> {
        if let Some(index) = self.tables.get(name) {
            return Some(self.own(*index));
        }
        self.used.get(name).map(|table| TableScope { table, unresolved: None, failed_keys: FailedKeys::default(), header_failed: false })
    }

    /// A malformed table name, already reported, or a table of a failed `use` line.
    fn unresolved(&self, name: &str) -> bool {
        !well_formed(name) || self.unresolved.contains(name)
    }
}

/// Validates the parse `parsed` of a document. `used` holds, for each `use` line, the used document
/// when it was found and is valid; a missing or invalid one is already reported.
/// `literals` receives the canonical literal texts of each check that types.
pub(crate) fn validate(parsed: &Parsed, used: &[Option<&Document>], diags: &mut Vec<Diag>, literals: &mut Vec<CheckLiterals>) {
    let Parsed { document, unresolved, failed_keys, header_failed, defaults, .. } = parsed;
    let failed = (0..document.tables.len()).map(|i| unresolved.get(i).map(|names| names.iter().map(String::as_str).collect()).unwrap_or_default()).collect();
    let mut scope = Scope { tables: HashMap::new(), document, failed, failed_keys, header_failed, used: HashMap::new(), unresolved: HashSet::new() };
    let mut used_documents: Vec<(&Name, &Document)> = Vec::new();
    let mut seen_documents = HashSet::new();
    for (line, found) in document.uses.iter().zip(used) {
        if !seen_documents.insert(line.document.text.as_str()) {
            diags.push(err(line.document.pos, "name.duplicate", format!("document '{}' is used twice", line.document.text)));
        }
        let Some(other) = found else {
            scope.unresolved.extend(line.tables.iter().map(|n| n.text.as_str()));
            continue;
        };
        used_documents.push((&line.document, other));
        for name in &line.tables {
            if !well_formed(&name.text) {
                scope.unresolved.insert(name.text.as_str());
                continue;
            }
            match other.tables.iter().find(|t| t.name.text == name.text) {
                None => {
                    scope.unresolved.insert(name.text.as_str());
                    diags.push(err(name.pos, "use", format!("document '{}' does not define table '{}'", line.document.text, name.text)));
                }
                Some(table) => {
                    if scope.used.insert(name.text.as_str(), table).is_some() {
                        diags.push(err(name.pos, "name.duplicate", format!("table '{}' is used twice", name.text)));
                    }
                }
            }
        }
    }
    for (index, table) in document.tables.iter().enumerate() {
        if table.name.text.is_empty() {
            continue;
        }
        if scope.tables.contains_key(table.name.text.as_str()) || scope.used.contains_key(table.name.text.as_str()) {
            // Go는 표 줄이 실패한 표의 이름 중복을 보고하지 않는다(validate.go의 failed table).
            if !header_failed.get(index).copied().unwrap_or(false) {
                diags.push(err(table.name.pos, "name.duplicate", format!("table '{}' is defined twice", table.name.text)));
            }
            continue;
        }
        scope.tables.insert(table.name.text.as_str(), index);
    }
    constraint_names(document, &used_documents, diags);
    for index in 0..document.tables.len() {
        let defaults = defaults.get(index).map_or(&[][..], Vec::as_slice);
        TableRules { scope: &scope, index, own: scope.own(index), defaults, diags: &mut *diags, literals: &mut *literals }.run();
    }
    diagrams(document, &scope, diags);
}

fn constraint_names_of(table: &Table) -> impl Iterator<Item = &Name> {
    let uniques = table.uniques.iter().map(|u| &u.name);
    let indexes = table.indexes.iter().map(|i| &i.name);
    let keys = table.foreign_keys.iter().map(|f| &f.name);
    let checks = table.checks.iter().map(|c| &c.name);
    uniques.chain(indexes).chain(keys).chain(checks)
}

/// Index, unique key, foreign key and check names are unique across the
/// document and the documents it uses directly, and differ from every table
/// name. Two used documents that repeat a name report it at the later
/// document name.
fn constraint_names(document: &Document, used: &[(&Name, &Document)], diags: &mut Vec<Diag>) {
    let mut tables: HashSet<&str> = document.tables.iter().map(|t| t.name.text.as_str()).collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut documents = HashSet::new();
    for (name, other) in used {
        if !documents.insert(name.text.as_str()) {
            continue;
        }
        tables.extend(other.tables.iter().map(|t| t.name.text.as_str()));
        let mut repeated = None;
        for table in &other.tables {
            for constraint in constraint_names_of(table) {
                if !seen.insert(constraint.text.as_str()) && repeated.is_none() {
                    repeated = Some(constraint.text.as_str());
                }
            }
        }
        if let Some(repeated) = repeated {
            diags.push(err(name.pos, "name.duplicate", format!("document '{}' repeats the constraint name '{repeated}' of another used document", name.text)));
        }
    }
    let mut own: Vec<&Name> = document.tables.iter().flat_map(constraint_names_of).collect();
    own.sort_by_key(|n| n.pos);
    for name in own {
        if tables.contains(name.text.as_str()) {
            diags.push(err(name.pos, "name.duplicate", format!("constraint name '{}' is a table name", name.text)));
        } else if !seen.insert(name.text.as_str()) {
            diags.push(err(name.pos, "name.duplicate", format!("constraint name '{}' is already used in the schema", name.text)));
        }
    }
}

/// Whether a primary key, unique key, index, foreign key or check of `table` names `column`.
fn in_key_or_check(table: &Table, column: &str) -> bool {
    table.primary.iter().any(|k| k.columns.iter().any(|c| c.text == column))
        || table.uniques.iter().any(|u| u.columns.iter().any(|c| c.text == column))
        || table.indexes.iter().any(|i| i.columns.iter().any(|(c, _)| c.text == column))
        || table.foreign_keys.iter().any(|f| f.columns.iter().any(|c| c.text == column))
        || table.checks.iter().any(|ch| {
            let mut refs = Vec::new();
            ch.expr.columns(&mut refs);
            refs.iter().any(|c| c.text == column)
        })
}

fn diagrams(document: &Document, scope: &Scope, diags: &mut Vec<Diag>) {
    let mut names = HashSet::new();
    for diagram in &document.diagrams {
        if !diagram.name.text.is_empty() && !names.insert(diagram.name.text.as_str()) {
            diags.push(err(diagram.name.pos, "name.duplicate", format!("diagram '{}' is defined twice", diagram.name.text)));
        }
        let mut placed = HashSet::new();
        for placement in &diagram.placements {
            let name = placement.table.text.as_str();
            if scope.table(name).is_none() && !scope.unresolved(name) {
                diags.push(err(placement.table.pos, "diagram", format!("diagram places unknown table '{name}'")));
            } else if !placed.insert(name) {
                diags.push(err(placement.table.pos, "diagram", format!("diagram places table '{name}' twice")));
            }
        }
    }
}

struct TableRules<'s, 'd> {
    scope: &'s Scope<'d>,
    index: usize,
    own: TableScope<'s, 'd>,
    /// The `default` value tokens of this table's columns.
    defaults: &'s [DefaultToken],
    diags: &'s mut Vec<Diag>,
    literals: &'s mut Vec<CheckLiterals>,
}

impl<'s, 'd> TableRules<'s, 'd> {
    fn report(&mut self, pos: Pos, rule: &'static str, message: impl Into<String>) {
        self.diags.push(err(pos, rule, message));
    }

    fn run(&mut self) {
        self.columns();
        self.keys();
        for key in &self.own.table.foreign_keys {
            self.foreign_key(key);
        }
        self.checks();
        self.settings();
    }

    /// Reports `<table>$<suffix>`, a name that the renderer generates, when it
    /// exceeds the name limit (docs/dbspec.md, "Names"). A malformed or too
    /// long table name, or column name when the suffix is a column, is
    /// already reported at that name.
    fn generated_name(&mut self, at: Pos, suffix: &str, suffix_is_column: bool) {
        let table = &self.own.table.name.text;
        if !well_formed(table) || (suffix_is_column && !well_formed(suffix)) {
            return;
        }
        let name = format!("{table}${suffix}");
        if name.len() > MAX_NAME_BYTES {
            self.report(at, "name.length", format!("the generated name {name} has {} bytes; the limit is {MAX_NAME_BYTES}", name.len()));
        }
    }

    fn columns(&mut self) {
        let table = self.own.table;
        // The renderer writes a type CHECK for every column other than an
        // identity, text or bytes column.
        for column in &table.columns {
            if column.identity.is_none() && !matches!(column.ty, Type::Text | Type::Bytes) {
                self.generated_name(column.name.pos, &column.name.text, true);
            }
        }
        let mut names = HashSet::new();
        for column in &table.columns {
            if !names.insert(column.name.text.as_str()) {
                self.report(column.name.pos, "name.duplicate", format!("column '{}' is defined twice", column.name.text));
            }
        }
        if table.columns.is_empty() && self.own.unresolved.is_none_or(HashSet::is_empty) {
            self.report(table.name.pos, "column", format!("table '{}' has no column", table.name.text));
        }
        let mut identities = 0;
        for column in &table.columns {
            let Some(pos) = column.identity else { continue };
            identities += 1;
            let sole_key = table.primary.first().is_some_and(|key| key.columns.len() == 1 && key.columns[0].text == column.name.text);
            // The identity column is checked only when every primary key column resolves.
            let resolved = table
                .primary
                .first()
                .is_none_or(|key| key.columns.iter().all(|c| well_formed(&c.text) && !self.own.unresolved.is_some_and(|u| u.contains(c.text.as_str()))));
            if identities > 1 {
                self.report(pos, "column", "a table has at most one identity column");
            } else if resolved && !sole_key && !self.own.failed_keys.primary {
                self.report(pos, "column", "an identity column is the only primary key column");
            }
        }
    }

    fn keys(&mut self) {
        let table = self.own.table;
        match table.primary.split_first() {
            None if self.own.failed_keys.primary => {}
            None => self.report(table.name.pos, "key", format!("table '{}' has no primary key", table.name.text)),
            Some((first, rest)) => {
                self.key_columns(first.columns.iter().map(|n| (n, false)), first.pos, true);
                for extra in rest {
                    self.report(extra.pos, "key", "a table has exactly one primary key");
                }
            }
        }
        for unique in &table.uniques {
            self.key_columns(unique.columns.iter().map(|n| (n, false)), unique.name.pos, false);
        }
        for index in &table.indexes {
            self.key_columns(index.columns.iter().map(|(n, d)| (n, *d)), index.name.pos, false);
        }
    }

    fn key_columns<'n>(&mut self, columns: impl Iterator<Item = (&'n Name, bool)>, at: Pos, primary: bool) {
        let mut seen = HashSet::new();
        let mut varchar = 0u32;
        for (index, (name, _)) in columns.enumerate() {
            if index == MAX_KEY_COLUMNS {
                self.report(at, "key", format!("a key or index lists at most {MAX_KEY_COLUMNS} columns"));
            }
            if !seen.insert(name.text.as_str()) {
                self.report(name.pos, "key", format!("column '{}' is repeated", name.text));
                continue;
            }
            match self.own.column(&name.text) {
                Lookup::Missing => self.report(name.pos, "key", format!("unknown column '{}'", name.text)),
                Lookup::Unresolved => {}
                Lookup::Found(column) => match column.ty {
                    Type::Text | Type::Bytes => self.report(name.pos, "key", format!("a {} column cannot be part of a key or index", column.ty.render())),
                    _ if primary && column.nullable => self.report(name.pos, "key", format!("primary key column '{}' is null", name.text)),
                    Type::Varchar(n) => varchar += n as u32,
                    _ => {}
                },
            }
        }
        if varchar > MAX_KEY_VARCHAR {
            self.report(at, "key", format!("varchar columns total {varchar} characters; the limit is {MAX_KEY_VARCHAR}"));
        }
    }

    fn foreign_key(&mut self, key: &ForeignKey) {
        // Go는 자식 열이 모두 알려지고 겹치지 않을 때만 색인 검사를 한다(validate.go의 foreignKey, known).
        // 짝과 type 검사는 자식 열과 관계없이 하므로, 알려지지 않은 자식은 None으로 자리를 지켜 참조 열과 짝을 맞춘다.
        let mut children_known = true;
        let mut seen = HashSet::new();
        let mut children: Vec<Option<&Column>> = Vec::new();
        for name in &key.columns {
            let repeated = !seen.insert(name.text.as_str());
            match self.own.column(&name.text) {
                Lookup::Found(column) => {
                    if repeated {
                        self.report(name.pos, "foreign_key", format!("column '{}' is repeated", name.text));
                        children_known = false;
                    }
                    children.push(Some(column));
                }
                Lookup::Unresolved => {
                    children_known = false;
                    children.push(None);
                }
                Lookup::Missing => {
                    self.report(name.pos, "foreign_key", format!("unknown column '{}'", name.text));
                    children_known = false;
                    children.push(None);
                }
            }
        }
        let target = self.scope.table(&key.table.text);
        // Go는 표 줄이 실패한 target의 열, 개수, key와 type을 검사하지 않는다.
        let failed_target = target.is_some_and(|t| t.header_failed);
        // 참조 열이 모두 알려졌는지만 짝과 type 검사를 정한다(Go의 referencesKnown).
        let mut references_known = true;
        let mut parents: Vec<Option<&Column>> = Vec::new();
        match &target {
            None => {
                if !self.scope.unresolved(&key.table.text) {
                    self.report(key.table.pos, "foreign_key", format!("unknown table '{}'", key.table.text));
                }
                references_known = false;
            }
            Some(_) if failed_target => {}
            Some(target) => {
                for name in &key.references {
                    match target.column(&name.text) {
                        Lookup::Found(column) => parents.push(Some(column)),
                        Lookup::Unresolved => {
                            references_known = false;
                            parents.push(None);
                        }
                        Lookup::Missing => {
                            self.report(name.pos, "foreign_key", format!("table '{}' has no column '{}'", key.table.text, name.text));
                            references_known = false;
                            parents.push(None);
                        }
                    }
                }
            }
        }
        let same_length = key.columns.len() == key.references.len();
        if !failed_target && !same_length {
            self.report(key.name.pos, "foreign_key", "the foreign key lists a different number of columns and referenced columns");
        }
        // Go의 foreignKey와 같다: 개수가 같고 참조 열이 모두 알려졌을 때만 짝과 type 검사를 한다.
        if let (true, true, Some(target), false) = (same_length, references_known, &target, failed_target) {
            let references: Vec<&str> = key.references.iter().map(|n| n.text.as_str()).collect();
            let same = |names: &[Name]| names.iter().map(|n| n.text.as_str()).eq(references.iter().copied());
            let keyed = target.table.primary.first().is_some_and(|p| same(&p.columns)) || target.table.uniques.iter().any(|u| same(&u.columns));
            if !keyed && !target.failed_keys.any && !target.failed_keys.primary {
                self.report(key.name.pos, "foreign_key", format!("the referenced columns are not the primary key or a unique key of '{}'", key.table.text));
            }
            // 알려진 자식 열만 type을 본다. 참조 열은 위에서 모두 알려졌음을 확인했다.
            if children.iter().zip(&parents).any(|(c, p)| matches!((c, p), (Some(c), Some(p)) if c.ty != p.ty)) {
                self.report(key.name.pos, "foreign_key", "a column type differs from its referenced column type");
            }
        }
        if (key.on_delete == Action::SetNull || key.on_update == Action::SetNull) && children.iter().flatten().any(|c| !c.nullable) {
            self.report(key.name.pos, "foreign_key", "set_null requires every column to be null");
        }
        let names: Vec<&str> = key.columns.iter().map(|n| n.text.as_str()).collect();
        let leads = |columns: &mut dyn Iterator<Item = &str>| {
            let columns: Vec<&str> = columns.collect();
            columns.len() >= names.len() && columns[..names.len()] == names[..]
        };
        let table = self.own.table;
        let indexed = table.primary.iter().any(|p| leads(&mut p.columns.iter().map(|n| n.text.as_str())))
            || table.uniques.iter().any(|u| leads(&mut u.columns.iter().map(|n| n.text.as_str())))
            || table.indexes.iter().any(|i| leads(&mut i.columns.iter().map(|(n, _)| n.text.as_str())));
        if children_known && !indexed && !self.own.failed_keys.any && !self.own.failed_keys.primary {
            self.report(key.name.pos, "foreign_key", "no index or key of the table leads with the foreign key's columns");
        }
    }

    /// The column rules of each check, then its types; a check expression
    /// reports only its first diagnostic in source order.
    fn checks(&mut self) {
        let table = self.own.table;
        let own = self.own;
        let changed: HashSet<&str> = table.foreign_keys.iter().filter(|k| k.changes_rows()).flat_map(|k| k.columns.iter().map(|n| n.text.as_str())).collect();
        for (index, check) in table.checks.iter().enumerate() {
            let mut columns = Vec::new();
            check.expr.columns(&mut columns);
            let mut first = None;
            for name in columns {
                let problem = match (name_problem(&name.text), own.column(&name.text)) {
                    (Some(problem), _) => Some(problem),
                    (None, Lookup::Missing) => Some(("check", format!("unknown column '{}'", name.text))),
                    (None, Lookup::Found(_)) if changed.contains(name.text.as_str()) => {
                        Some(("check", format!("column '{}' belongs to a cascade or set_null foreign key", name.text)))
                    }
                    _ => None,
                };
                if let Some((rule, message)) = problem {
                    first = Some((name.pos, rule, message));
                    break;
                }
            }
            let column_type = |name: &Name| match (name_problem(&name.text), own.column(&name.text)) {
                (None, Lookup::Found(column)) => Some(column.ty),
                _ => None,
            };
            match type_check(&check.expr, &column_type) {
                Err((pos, message)) if first.as_ref().is_none_or(|(at, _, _)| pos < *at) => first = Some((pos, "check", message)),
                Ok(texts) if first.is_none() => self.literals.push(CheckLiterals { table: self.index, check: index, texts }),
                _ => {}
            }
            if let Some((pos, rule, message)) = first {
                self.report(pos, rule, message);
            }
        }
    }

    /// The column of a setting, reporting a missing one. `None` when it is missing or unresolved.
    fn setting_column(&mut self, name: &Name) -> Option<&'d Column> {
        match self.own.column(&name.text) {
            Lookup::Found(column) => Some(column),
            Lookup::Unresolved => None,
            Lookup::Missing => {
                self.report(name.pos, "setting", format!("unknown column '{}'", name.text));
                None
            }
        }
    }

    fn settings(&mut self) {
        let table = self.own.table;
        let Some(settings) = &table.settings else { return };
        let has_aes_version = settings.lines.iter().any(|l| matches!(l.setting, Setting::AesVersion(_)));
        let has_aes = settings.lines.iter().any(|l| matches!(&l.setting, Setting::Codec(_, stages) if stages.iter().any(|s| s.text == "aes")));
        let changes_rows = table.foreign_keys.iter().any(ForeignKey::changes_rows);
        let mut kinds = HashSet::new();
        let mut codecs = HashSet::new();
        let mut navigations = HashSet::new();
        let mut blind_indexes = HashSet::new();
        let mut markdowns = HashSet::new();
        for line in &settings.lines {
            let first = match &line.setting {
                Setting::Codec(column, _) => codecs.insert(column.text.as_str()),
                Setting::Navigation(key, _, _) => navigations.insert(key.text.as_str()),
                Setting::BlindIndex(aes, _) => blind_indexes.insert(aes.text.as_str()),
                Setting::Markdown(column) => markdowns.insert(column.text.as_str()),
                // state_machine and checkbox lines repeat by design; their consistency is checked per table.
                Setting::StateMachine { .. } | Setting::Checkbox { .. } => true,
                other => kinds.insert(other.rank()),
            };
            if !first {
                // A repeated line is not checked, as the reference does.
                self.report(line.pos, "setting", "the setting repeats");
                continue;
            }
            match &line.setting {
                Setting::Entity(_) => {}
                Setting::Updated(name) => {
                    if let Some(column) = self.setting_column(name) {
                        if !matches!(column.ty, Type::DateTime(_)) {
                            self.report(name.pos, "setting", "updated names a datetime column");
                        }
                    }
                }
                Setting::SoftDelete(name) => {
                    if let Some(column) = self.setting_column(name) {
                        if !matches!(column.ty, Type::DateTime(_)) || !column.nullable {
                            self.report(name.pos, "setting", "soft_delete names a nullable datetime column");
                        }
                    }
                }
                Setting::SelectExplicit(names) => {
                    let mut seen = HashSet::new();
                    for name in names {
                        if !seen.insert(name.text.as_str()) {
                            self.report(name.pos, "setting", format!("column '{}' is repeated", name.text));
                        } else {
                            self.setting_column(name);
                        }
                    }
                }
                Setting::Codec(name, stages) => {
                    // The storage type follows the last stage.
                    let last = stages.last().map_or("", |s| s.text.as_str());
                    let storage = match last {
                        "hex" | "base64" | "ordered_json" | "yaml" | "serialize" => Some("text, in a varchar or text column"),
                        "aes" | "gz" | "ip" => Some("bytes, in a bytes column"),
                        _ => None,
                    };
                    if let (Some(column), Some(storage)) = (self.setting_column(name), storage) {
                        let text = matches!(column.ty, Type::Varchar(_) | Type::Text);
                        if text != storage.starts_with("text") || (!text && column.ty != Type::Bytes) {
                            self.report(name.pos, "setting", format!("codec stage '{last}' stores {storage}"));
                        }
                    }
                    if stages.iter().any(|s| s.text == "aes") && !has_aes_version {
                        self.report(line.pos, "setting", "a codec with aes requires the aes_version setting");
                    }
                }
                Setting::AesVersion(name) => {
                    if !has_aes {
                        self.report(line.pos, "setting", "aes_version requires a column with the aes codec stage");
                    }
                    if let Some(column) = self.setting_column(name) {
                        if !matches!(column.ty, Type::I16 | Type::I32 | Type::I64) || column.nullable {
                            self.report(name.pos, "setting", "aes_version names a non-null integer column");
                        }
                    }
                }
                Setting::BlindIndex(aes, target) => self.blind_index(settings, line.pos, aes, target),
                Setting::Navigation(key, _, _) => {
                    if !table.foreign_keys.iter().any(|k| k.name.text == key.text) && !self.own.unresolved.is_some_and(|u| u.contains(key.text.as_str())) {
                        self.report(key.pos, "setting", format!("table has no foreign key '{}'", key.text));
                    }
                }
                Setting::Markdown(name) => {
                    if let Some(column) = self.setting_column(name) {
                        if !matches!(column.ty, Type::Varchar(_) | Type::Text) {
                            self.report(name.pos, "setting", "markdown needs a varchar or text column");
                        }
                    }
                }
                Setting::Store { kind, foreign: Some(foreign), .. } if kind.text == "block" => self.foreign_key_name(foreign),
                Setting::Store { .. } => {}
                Setting::KeyPrefix(_) => self.key_prefix(line.pos),
                Setting::Title(name) | Setting::Body(name) => self.text_column(name),
                Setting::Order(name) => self.order(name),
                Setting::Checkbox { .. } => {}
                Setting::StateMachine { column, line: state } => {
                    let requires: &[Name] = match state {
                        StateLine::Terminal(_, requires) | StateLine::Transition { requires, .. } => requires,
                        StateLine::Initial(_) | StateLine::History(_) | StateLine::Limit { .. } => &[],
                    };
                    self.state_machine_column(column, requires);
                }
                Setting::Immutable => {
                    if changes_rows {
                        self.report(line.pos, "setting", "immutable is rejected on a child of a cascade or set_null foreign key");
                    }
                    // The longest of the immutable trigger names stands for both.
                    self.generated_name(line.pos, "immutable_update", false);
                }
                Setting::Audit { into, column, references, action, previous, lists } => {
                    if changes_rows {
                        self.report(line.pos, "setting", "audit is rejected on a child of a cascade or set_null foreign key");
                    }
                    self.audit(&line.setting, into, column, references, action, previous, lists);
                    // The longest of the audit trigger names stands for all three.
                    self.generated_name(line.pos, "audit_insert", false);
                }
            }
        }
        self.state_machine_consistency(settings);
    }

    /// The `default` value token of a column of this table, when its line parsed.
    fn default_of(&self, column: &str) -> Option<&'s DefaultToken> {
        let defaults: &'s [DefaultToken] = self.defaults;
        defaults.iter().find(|d| d.column == column)
    }

    /// A name that must be a foreign key of this table. A malformed name is reported by the parser.
    fn foreign_key_name(&mut self, name: &Name) {
        if well_formed(&name.text)
            && !self.own.table.foreign_keys.iter().any(|k| k.name.text == name.text)
            && !self.own.unresolved.is_some_and(|u| u.contains(name.text.as_str()))
        {
            self.report(name.pos, "setting", format!("foreign key '{}' is not a foreign key of the table", name.text));
        }
    }

    /// `key_prefix` needs a varchar primary key of one column; a failed primary key line reports nothing.
    fn key_prefix(&mut self, at: Pos) {
        let table = self.own.table;
        if self.own.failed_keys.primary {
            return;
        }
        let single = match table.primary.as_slice() {
            [key] => match key.columns.as_slice() {
                [column] => Some(column),
                _ => None,
            },
            _ => None,
        };
        let Some(column) = single else {
            self.report(at, "setting", "key_prefix needs a single-column primary key");
            return;
        };
        if let Some(c) = table.column(&column.text) {
            if !matches!(c.ty, Type::Varchar(_)) {
                self.report(at, "setting", format!("key_prefix needs a varchar primary key, not {}", c.ty.render()));
            }
        }
    }

    /// `title` and `body` name a non-null varchar or text column.
    fn text_column(&mut self, name: &Name) {
        if let Some(column) = self.setting_column(name) {
            if !matches!(column.ty, Type::Varchar(_) | Type::Text) || column.nullable {
                self.report(name.pos, "setting", "needs a non-null varchar or text column");
            }
        }
    }

    /// `order` names a non-null i32 or i64 column with no default that no key, index, foreign key or check names.
    fn order(&mut self, name: &Name) {
        let Some(column) = self.setting_column(name) else { return };
        if !matches!(column.ty, Type::I32 | Type::I64) || column.nullable || self.default_of(&name.text).is_some() {
            self.report(name.pos, "setting", "order needs a non-null i32 or i64 column with no default");
        } else if in_key_or_check(self.own.table, &name.text) {
            self.report(name.pos, "setting", format!("order column '{}' is in a key, index or check", name.text));
        }
    }

    /// The column of a `state_machine` line is a non-null varchar or text column, and its `require`
    /// columns exist.
    fn state_machine_column(&mut self, column: &Name, requires: &[Name]) {
        if let Some(c) = self.setting_column(column) {
            if !matches!(c.ty, Type::Varchar(_) | Type::Text) || c.nullable {
                self.report(column.pos, "setting", "state_machine needs a non-null varchar or text column");
            }
        }
        for name in requires {
            self.setting_column(name);
        }
    }

    /// Checks the `state_machine` and `checkbox` lines of the table between them (docs/dbspec.md,
    /// "Settings"): one column, the initial and terminal states, the transition lines, history and
    /// limit lines, the default of the state column and the checkboxes.
    fn state_machine_consistency(&mut self, settings: &Settings) {
        let table = self.own.table;
        let mut column: Option<&str> = None;
        let mut states = BTreeSet::new();
        let mut initials = HashSet::new();
        let mut terminals = HashSet::new();
        let mut lines: Vec<(Pos, &StateLine)> = Vec::new();
        let mut limits: Vec<(&Name, &Name)> = Vec::new();
        let mut requires: Vec<&Name> = Vec::new();
        let mut history: Option<&History> = None;
        for line in &settings.lines {
            let Setting::StateMachine { column: name, line: state } = &line.setting else { continue };
            match column {
                None => column = Some(name.text.as_str()),
                Some(first) if first != name.text => {
                    self.report(name.pos, "setting", format!("state_machine repeats for '{}'; a table holds one machine", name.text));
                }
                Some(_) => {}
            }
            match state {
                StateLine::History(h) => match history {
                    Some(_) => self.report(line.pos, "setting", "state_machine repeats history"),
                    None => history = Some(h),
                },
                StateLine::Limit { state, count } => limits.push((state, count)),
                StateLine::Initial(s) => {
                    initials.insert(s.text.as_str());
                    states.insert(s.text.as_str());
                    lines.push((line.pos, state));
                }
                StateLine::Terminal(s, list) => {
                    terminals.insert(s.text.as_str());
                    states.insert(s.text.as_str());
                    requires.extend(list);
                    lines.push((line.pos, state));
                }
                StateLine::Transition { from, to, requires: list } => {
                    states.insert(from.text.as_str());
                    states.insert(to.text.as_str());
                    requires.extend(list);
                    lines.push((line.pos, state));
                }
            }
        }
        for (pos, state) in &lines {
            match state {
                StateLine::Initial(s) if terminals.contains(s.text.as_str()) => {
                    self.report(*pos, "setting", format!("an initial state '{}' is also terminal", s.text));
                }
                StateLine::Transition { from, .. } if terminals.contains(from.text.as_str()) => {
                    self.report(*pos, "setting", format!("a transition leaves the terminal state '{}'", from.text));
                }
                _ => {}
            }
        }
        self.limits(&limits, &states);
        let state_column = column.and_then(|name| table.column(name));
        if let Some(h) = history {
            self.history(h, state_column, &requires);
        }
        if let (Some(name), Some(_)) = (column, state_column) {
            if let Some(default) = self.default_of(name) {
                if !initials.contains(default.text.as_str()) {
                    self.report(default.pos, "setting", format!("the default '{}' of the state column is not an initial state", default.text));
                }
            }
        }
        self.checkboxes(column, &states, settings);
    }

    /// Each `limit` line names a state of the state set once and a positive row count.
    fn limits(&mut self, limits: &[(&Name, &Name)], states: &BTreeSet<&str>) {
        let mut seen = HashSet::new();
        for (state, count) in limits {
            if !states.contains(state.text.as_str()) {
                self.report(state.pos, "setting", format!("limit names state '{}' outside the state set", state.text));
            } else if seen.contains(state.text.as_str()) {
                self.report(state.pos, "setting", format!("limit repeats for state '{}'", state.text));
            }
            seen.insert(state.text.as_str());
            if count.text.parse::<i64>().map_or(true, |n| n < 1) {
                self.report(count.pos, "setting", format!("limit needs a positive row count, not {}", count.text));
            }
        }
    }

    /// The `history` line: its table is a table of this document or a used one, with a foreign key of
    /// `row` to this table, the state type for `from` and `to`, datetime(6) for `at`, and a nullable
    /// column of the type of each required column. The table has no other column and declares no
    /// title or body. Every mismatch is reported at the history table name.
    fn history(&mut self, history: &History, state: Option<&Column>, requires: &[&Name]) {
        let name = &history.table;
        if !well_formed(&name.text) {
            return;
        }
        let scope = self.scope;
        let Some(other) = scope.table(&name.text) else {
            self.report(name.pos, "setting", format!("history table '{}' is not a table of this document or a used table", name.text));
            return;
        };
        let Some(state) = state else { return };
        let owner = self.own.table.name.text.as_str();
        let row = history.row.text.as_str();
        let linked = other.table.foreign_keys.iter().any(|f| f.columns.len() == 1 && f.columns[0].text == row && f.table.text == owner);
        if !linked {
            self.report(name.pos, "setting", format!("history table '{}' has no foreign key of '{row}' to table '{owner}'", name.text));
        }
        let mut named: HashSet<&str> = HashSet::from([row]);
        for (column, want) in [(&history.from, state.ty), (&history.to, state.ty), (&history.at, Type::DateTime(6))] {
            named.insert(column.text.as_str());
            match other.table.column(&column.text) {
                Some(c) if c.ty != want => {
                    self.report(name.pos, "setting", format!("history column '{}' has type {}, not {}", column.text, c.ty.render(), want.render()));
                }
                Some(_) => {}
                None if !other.failed(&column.text) => {
                    self.report(name.pos, "setting", format!("history table '{}' has no column '{}'", name.text, column.text));
                }
                None => {}
            }
        }
        for required in requires {
            named.insert(required.text.as_str());
            let Some(c) = self.own.table.column(&required.text) else { continue };
            match other.table.column(&required.text) {
                None if !other.failed(&required.text) => {
                    self.report(name.pos, "setting", format!("history table '{}' has no column '{}' of the required column", name.text, required.text));
                }
                Some(hc) if !hc.nullable || hc.ty != c.ty => {
                    self.report(name.pos, "setting", format!("history column '{}' is not a nullable {} column", required.text, c.ty.render()));
                }
                _ => {}
            }
        }
        for key in &other.table.primary {
            named.extend(key.columns.iter().map(|c| c.text.as_str()));
        }
        for column in &other.table.columns {
            if !named.contains(column.name.text.as_str()) {
                self.report(
                    name.pos,
                    "setting",
                    format!("history table '{}' has column '{}', which the history line does not name", name.text, column.name.text),
                );
            }
        }
        if let Some(settings) = &other.table.settings {
            for line in &settings.lines {
                if matches!(line.setting, Setting::Title(_) | Setting::Body(_)) {
                    self.report(name.pos, "setting", format!("history table '{}' declares a title or body, which a history table does not", name.text));
                }
            }
        }
    }

    /// The `checkbox` lines name the column of the machine, one of its states each, once per state, with one
    /// character glyphs that differ, and every state of the machine has one.
    fn checkboxes(&mut self, column: Option<&str>, states: &BTreeSet<&str>, settings: &Settings) {
        let boxes: Vec<(Pos, &Name, &Name, &Name)> = settings
            .lines
            .iter()
            .filter_map(|l| match &l.setting {
                Setting::Checkbox { column, state, glyph } => Some((l.pos, column, state, glyph)),
                _ => None,
            })
            .collect();
        let Some(&(first_pos, first_column, _, _)) = boxes.first() else { return };
        let Some(column) = column else {
            self.report(first_column.pos, "setting", format!("checkbox needs a state_machine on column '{}'", first_column.text));
            return;
        };
        let mut covered = HashSet::new();
        let mut glyphs = HashSet::new();
        for &(_, name, state, glyph) in &boxes {
            if self.setting_column(name).is_none() {
                continue;
            }
            if name.text != column {
                self.report(name.pos, "setting", format!("checkbox names column '{}', but the state_machine column is '{column}'", name.text));
                continue;
            }
            if !states.contains(state.text.as_str()) {
                self.report(state.pos, "setting", format!("checkbox names state '{}' outside the state set", state.text));
            } else if covered.contains(state.text.as_str()) {
                self.report(state.pos, "setting", format!("checkbox repeats for state '{}'", state.text));
            }
            covered.insert(state.text.as_str());
            if glyph.text.chars().count() != 1 {
                self.report(glyph.pos, "setting", "a checkbox glyph is one character");
            } else if glyphs.contains(glyph.text.as_str()) {
                self.report(glyph.pos, "setting", format!("checkbox glyph '{}' repeats", glyph.text));
            }
            glyphs.insert(glyph.text.as_str());
        }
        for state in states {
            if !covered.contains(state) {
                self.report(first_pos, "setting", format!("checkbox does not cover state '{state}'"));
            }
        }
    }

    fn blind_index(&mut self, settings: &Settings, keyword: Pos, aes: &Name, target: &Name) {
        let encrypted = |name: &str| {
            settings.lines.iter().any(|l| matches!(&l.setting, Setting::Codec(c, stages) if c.text == name && stages.iter().any(|s| s.text == "aes")))
        };
        let aes_column = self.setting_column(aes);
        if aes_column.is_some() && !encrypted(&aes.text) {
            self.report(keyword, "setting", format!("column '{}' has no codec with aes", aes.text));
        }
        let Some(column) = self.setting_column(target) else { return };
        let table = self.own.table;
        let only = |names: &mut dyn Iterator<Item = &str>| {
            let names: Vec<&str> = names.collect();
            names == [target.text.as_str()]
        };
        let indexed = table.uniques.iter().any(|u| only(&mut u.columns.iter().map(|n| n.text.as_str())))
            || table.indexes.iter().any(|i| only(&mut i.columns.iter().map(|(n, _)| n.text.as_str())));
        let storage = matches!(column.ty, Type::Varchar(n) if n >= BLIND_INDEX_LENGTH);
        let nullability = aes_column.is_none_or(|a| a.nullable == column.nullable);
        if !storage || (!indexed && !self.own.failed_keys.any) || !nullability || encrypted(&target.text) {
            self.report(
                target.pos,
                "setting",
                format!(
                    "the blind_index column is varchar({BLIND_INDEX_LENGTH}) or longer, has the nullability of the aes column, is not aes-encoded and is the only column of an index or unique key"
                ),
            );
        }
    }

    /// audit setting, audit 기록 table과 그 foreign key, history table의 모양을 검사한다(docs/dbspec.md
    /// "Audit"). history table은 i64 identity primary key, action과 previous column, 기록하는 column과
    /// 같은 이름과 type의 column만 가지며, 어긋난 곳마다 하나씩 보고한다.
    #[allow(clippy::too_many_arguments)]
    fn audit(&mut self, setting: &Setting, into: &Name, column: &Name, references: &Name, action: &Name, previous: &Name, lists: &[AuditList]) {
        let table = self.own.table;
        let audit_column = self.setting_column(column);
        if audit_column.is_some_and(|c| c.nullable) {
            self.report(column.pos, "setting", "the audit column is a non-null column");
        }
        let listed = self.audit_lists(column, lists);
        self.audit_record(audit_column, column, references, into);
        if !well_formed(&into.text) {
            return;
        }
        let Some(history) = self.scope.table(&into.text) else {
            if !self.scope.unresolved(&into.text) {
                self.report(into.pos, "setting", format!("unknown history table '{}'", into.text));
            }
            return;
        };
        // Go는 표 줄이 실패한 history table의 열을 검사하지 않는다.
        if history.header_failed {
            return;
        }
        let history = history.table;
        if history.name.text == table.name.text {
            self.report(into.pos, "setting", "a table is not its own history table");
            return;
        }
        let audited = history.settings.as_ref().is_some_and(|s| s.lines.iter().any(|l| matches!(l.setting, Setting::Audit { .. })));
        if audited {
            self.report(into.pos, "setting", format!("history table '{}' is audited itself", into.text));
        }
        let identity = history.primary.first().and_then(|key| match key.columns.as_slice() {
            [only] => history.column(&only.text).filter(|c| c.identity.is_some() && c.ty == Type::I64),
            _ => None,
        });
        let mut reserved: HashSet<&str> = HashSet::new();
        match identity {
            Some(column) => {
                reserved.insert(&column.name.text);
            }
            None => self.report(into.pos, "setting", format!("history table '{}' needs an i64 identity primary key", into.text)),
        }
        if well_formed(&action.text) {
            match history.column(&action.text) {
                None => self.report(action.pos, "setting", format!("column '{}' is not a column of history table '{}'", action.text, into.text)),
                Some(_) if reserved.contains(action.text.as_str()) => {
                    self.report(action.pos, "setting", "the action column is a separate column of the history table")
                }
                Some(column) if column.ty != Type::Varchar(8) || column.nullable => {
                    self.report(action.pos, "setting", "the action column is a non-null varchar(8)")
                }
                Some(_) => {}
            }
            reserved.insert(&action.text);
        }
        if well_formed(&previous.text) {
            match history.column(&previous.text) {
                None => self.report(previous.pos, "setting", format!("column '{}' is not a column of history table '{}'", previous.text, into.text)),
                Some(_) if reserved.contains(previous.text.as_str()) => {
                    self.report(previous.pos, "setting", "the previous column is a separate column of the history table")
                }
                Some(column) if !column.nullable => self.report(previous.pos, "setting", "the previous column is nullable"),
                Some(column) if audit_column.is_some_and(|o| o.ty != column.ty) => {
                    self.report(previous.pos, "setting", "the previous column has the audit column type")
                }
                Some(_) => {}
            }
            reserved.insert(&previous.text);
        }
        // 두 목록을 다 쓴 setting은 기록하는 column이 정해지지 않으므로 history table의 column을 맞추어 보지 않는다.
        if !listed {
            return;
        }
        for column in &table.columns {
            if !setting.records(&column.name.text) {
                continue;
            }
            match history.column(&column.name.text) {
                Some(copy) if !reserved.contains(column.name.text.as_str()) => {
                    if copy.ty != column.ty {
                        self.report(
                            into.pos,
                            "setting",
                            format!("history column '{}' has another type than the column of '{}'", column.name.text, table.name.text),
                        );
                    }
                }
                _ => self.report(into.pos, "setting", format!("history table '{}' has no copy of column '{}'", into.text, column.name.text)),
            }
        }
        for column in &history.columns {
            let name = column.name.text.as_str();
            if reserved.contains(name) {
                continue;
            }
            if table.column(name).is_none() {
                self.report(into.pos, "setting", format!("history table '{}' has column '{name}', which is not a column of '{}'", into.text, table.name.text));
            } else if !setting.records(name) {
                self.report(into.pos, "setting", format!("history table '{}' has column '{name}', which '{}' does not record", into.text, table.name.text));
            }
        }
    }

    /// audit 기록 table을 검사한다. 그 table은 이 문서나 사용한 문서의 다른 table이며 history table이
    /// 아니고, 자신은 audit 대상이 아니며, column 하나의 primary key를 가지고 그 type이 audit column의
    /// type이다. audit column은 그 primary key를 restrict로 가리키는 선언한 foreign key의 유일한
    /// column이다. 그래서 audit 기록 행이 없는 audit column 값은 database가 거부한다.
    fn audit_record(&mut self, audit_column: Option<&Column>, column: &Name, references: &Name, into: &Name) {
        if !well_formed(&references.text) {
            return;
        }
        let table = self.own.table;
        let Some(record) = self.scope.table(&references.text) else {
            if !self.scope.unresolved(&references.text) {
                self.report(references.pos, "setting", format!("audit record table '{}' is not a table of this document or a used table", references.text));
            }
            return;
        };
        // Go는 표 줄이 실패한 audit 기록 table의 key를 검사하지 않는다.
        if record.header_failed {
            return;
        }
        if record.table.name.text == table.name.text {
            self.report(references.pos, "setting", "a table cannot record its audits in itself");
            return;
        }
        if references.text == into.text {
            self.report(references.pos, "setting", "the audit record table is another table than the history table");
            return;
        }
        if record.table.settings.as_ref().is_some_and(|s| s.lines.iter().any(|l| matches!(l.setting, Setting::Audit { .. }))) {
            self.report(references.pos, "setting", format!("audit record table '{}' is audited itself", references.text));
        }
        let key = match record.table.primary.as_slice() {
            [only] if only.columns.len() == 1 => &only.columns[0].text,
            _ => {
                if !record.failed_keys.primary {
                    self.report(references.pos, "setting", format!("audit record table '{}' needs a primary key of one column", references.text));
                }
                return;
            }
        };
        let (Some(audit_column), Some(pk)) = (audit_column, record.table.column(key)) else { return };
        if pk.ty != audit_column.ty {
            self.report(
                column.pos,
                "setting",
                format!("the audit column has type {}, not the type {} of the primary key of '{}'", audit_column.ty.render(), pk.ty.render(), references.text),
            );
            return;
        }
        let declared = table.foreign_keys.iter().any(|f| {
            matches!(f.columns.as_slice(), [only] if only.text == column.text)
                && f.table.text == references.text
                && matches!(f.references.as_slice(), [only] if &only.text == key)
                && f.on_delete == Action::Restrict
                && f.on_update == Action::Restrict
        });
        if !declared && !self.own.failed_keys.any {
            self.report(
                column.pos,
                "setting",
                format!(
                    "the audit column needs the foreign key ({}) references {} ({key}) on delete restrict on update restrict",
                    column.text, references.text
                ),
            );
        }
    }

    /// audit의 exclude나 include 목록을 검사하고, 기록하는 column이 정해지는지 알린다. 두 목록을
    /// 다 쓰면 둘째 목록의 keyword에서 거부하고 false다. 목록의 column은 table의 column이고, 한
    /// 번만 나오며, audit column이 아니다. audit column은 언제나 기록하므로 어느 목록에도 쓰지
    /// 않는다.
    fn audit_lists(&mut self, audited: &Name, lists: &[AuditList]) -> bool {
        if let [_, second, ..] = lists {
            self.report(second.keyword.pos, "setting", "audit names its recorded columns by exclude or by include, not both");
            return false;
        }
        let mut listed = HashSet::new();
        for list in lists {
            for column in &list.columns {
                if !listed.insert(column.text.as_str()) {
                    self.report(column.pos, "setting", format!("column '{}' repeats in audit {}", column.text, list.keyword.text));
                } else if column.text == audited.text {
                    self.report(
                        column.pos,
                        "setting",
                        format!("the audit column '{}' is always recorded and is not listed in exclude or include", column.text),
                    );
                } else {
                    self.setting_column(column);
                }
            }
        }
        true
    }
}
