//! Rules that relate lines to each other: names, keys, foreign keys, checks,
//! settings, `use` and diagrams.

use super::model::*;
use super::parser::{name_problem, well_formed, Diag, FailedKeys};
use std::collections::{HashMap, HashSet};

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
}

impl<'s, 'd> TableScope<'s, 'd> {
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
        }
    }

    /// A table of the document or a used table.
    fn table(&self, name: &str) -> Option<TableScope<'_, 'd>> {
        if let Some(index) = self.tables.get(name) {
            return Some(self.own(*index));
        }
        self.used.get(name).map(|table| TableScope { table, unresolved: None, failed_keys: FailedKeys::default() })
    }

    /// A malformed table name, already reported, or a table of a failed `use` line.
    fn unresolved(&self, name: &str) -> bool {
        !well_formed(name) || self.unresolved.contains(name)
    }
}

/// Validates `document`. `used` holds, for each `use` line, the used document
/// when it was found and is valid; a missing or invalid one is already reported.
pub(crate) fn validate(document: &Document, unresolved: &[Vec<String>], failed_keys: &[FailedKeys], used: &[Option<&Document>], diags: &mut Vec<Diag>) {
    let failed = (0..document.tables.len()).map(|i| unresolved.get(i).map(|names| names.iter().map(String::as_str).collect()).unwrap_or_default()).collect();
    let mut scope = Scope { tables: HashMap::new(), document, failed, failed_keys, used: HashMap::new(), unresolved: HashSet::new() };
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
            diags.push(err(table.name.pos, "name.duplicate", format!("table '{}' is defined twice", table.name.text)));
            continue;
        }
        scope.tables.insert(table.name.text.as_str(), index);
    }
    constraint_names(document, &used_documents, diags);
    for index in 0..document.tables.len() {
        TableRules { scope: &scope, own: scope.own(index), diags: &mut *diags }.run();
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
    own: TableScope<'s, 'd>,
    diags: &'s mut Vec<Diag>,
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

    fn columns(&mut self) {
        let table = self.own.table;
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
            if identities > 1 {
                self.report(pos, "column", "a table has at most one identity column");
            } else if !sole_key && !self.own.failed_keys.primary {
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
        let mut complete = true;
        let mut seen = HashSet::new();
        let mut children = Vec::new();
        for name in &key.columns {
            if !seen.insert(name.text.as_str()) {
                self.report(name.pos, "foreign_key", format!("column '{}' is repeated", name.text));
                complete = false;
                continue;
            }
            match self.own.column(&name.text) {
                Lookup::Found(column) => children.push(column),
                Lookup::Unresolved => complete = false,
                Lookup::Missing => {
                    self.report(name.pos, "foreign_key", format!("unknown column '{}'", name.text));
                    complete = false;
                }
            }
        }
        let target = self.scope.table(&key.table.text);
        let mut parents = Vec::new();
        match &target {
            None => {
                if !self.scope.unresolved(&key.table.text) {
                    self.report(key.table.pos, "foreign_key", format!("unknown table '{}'", key.table.text));
                }
                complete = false;
            }
            Some(target) => {
                for name in &key.references {
                    match target.column(&name.text) {
                        Lookup::Found(column) => parents.push(column),
                        Lookup::Unresolved => complete = false,
                        Lookup::Missing => {
                            self.report(name.pos, "foreign_key", format!("table '{}' has no column '{}'", key.table.text, name.text));
                            complete = false;
                        }
                    }
                }
            }
        }
        if key.columns.len() != key.references.len() {
            self.report(key.name.pos, "foreign_key", "the foreign key lists a different number of columns and referenced columns");
            complete = false;
        }
        if let (true, Some(target)) = (complete, &target) {
            let references: Vec<&str> = key.references.iter().map(|n| n.text.as_str()).collect();
            let same = |names: &[Name]| names.iter().map(|n| n.text.as_str()).eq(references.iter().copied());
            let keyed = target.table.primary.first().is_some_and(|p| same(&p.columns)) || target.table.uniques.iter().any(|u| same(&u.columns));
            if !keyed && !target.failed_keys.any {
                self.report(key.name.pos, "foreign_key", format!("the referenced columns are not the primary key or a unique key of '{}'", key.table.text));
            }
            if children.iter().zip(&parents).any(|(c, p)| c.ty != p.ty) {
                self.report(key.name.pos, "foreign_key", "a column type differs from its referenced column type");
            }
        }
        if (key.on_delete == Action::SetNull || key.on_update == Action::SetNull) && children.iter().any(|c| !c.nullable) {
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
        if !indexed && !self.own.failed_keys.any {
            self.report(key.name.pos, "foreign_key", "no index or key of the table leads with the foreign key's columns");
        }
    }

    fn checks(&mut self) {
        let table = self.own.table;
        let changed: HashSet<&str> = table.foreign_keys.iter().filter(|k| k.changes_rows()).flat_map(|k| k.columns.iter().map(|n| n.text.as_str())).collect();
        for check in &table.checks {
            let mut columns = Vec::new();
            check.expr.columns(&mut columns);
            // A check expression reports only its first diagnostic.
            for name in columns {
                let problem = match (name_problem(&name.text), self.own.column(&name.text)) {
                    (Some(problem), _) => Some(problem),
                    (None, Lookup::Missing) => Some(("check", format!("unknown column '{}'", name.text))),
                    (None, Lookup::Found(_)) if changed.contains(name.text.as_str()) => {
                        Some(("check", format!("column '{}' belongs to a cascade or set_null foreign key", name.text)))
                    }
                    _ => None,
                };
                if let Some((rule, message)) = problem {
                    self.report(name.pos, rule, message);
                    break;
                }
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
        let has_soft_delete = settings.lines.iter().any(|l| matches!(l.setting, Setting::SoftDelete(_)));
        let changes_rows = table.foreign_keys.iter().any(ForeignKey::changes_rows);
        let mut kinds = HashSet::new();
        let mut codecs = HashSet::new();
        let mut navigations = HashSet::new();
        let mut blind_indexes = HashSet::new();
        for line in &settings.lines {
            let first = match &line.setting {
                Setting::Codec(column, _) => codecs.insert(column.text.as_str()),
                Setting::Navigation(key, _, _) => navigations.insert(key.text.as_str()),
                Setting::BlindIndex(aes, _) => blind_indexes.insert(aes.text.as_str()),
                other => kinds.insert(other.rank()),
            };
            if !first {
                self.report(line.pos, "setting", "the setting repeats");
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
                Setting::BlindIndex(aes, target) => self.blind_index(settings, aes, target),
                Setting::Navigation(key, _, _) => {
                    if !table.foreign_keys.iter().any(|k| k.name.text == key.text) {
                        self.report(key.pos, "setting", format!("table has no foreign key '{}'", key.text));
                    }
                }
                Setting::Immutable => {
                    if changes_rows {
                        self.report(line.pos, "setting", "immutable is rejected on a child of a cascade or set_null foreign key");
                    }
                }
                Setting::Audit { into, operation, action, previous } => {
                    if !has_soft_delete {
                        self.report(line.pos, "setting", "audit requires the soft_delete setting");
                    }
                    if changes_rows {
                        self.report(line.pos, "setting", "audit is rejected on a child of a cascade or set_null foreign key");
                    }
                    self.audit(into, operation, action, previous);
                }
            }
        }
    }

    fn blind_index(&mut self, settings: &Settings, aes: &Name, target: &Name) {
        let encrypted = |name: &str| {
            settings.lines.iter().any(|l| matches!(&l.setting, Setting::Codec(c, stages) if c.text == name && stages.iter().any(|s| s.text == "aes")))
        };
        let aes_column = self.setting_column(aes);
        if aes_column.is_some() && !encrypted(&aes.text) {
            self.report(aes.pos, "setting", format!("column '{}' has no codec with aes", aes.text));
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
        if !storage || !indexed || !nullability || encrypted(&target.text) {
            self.report(
                target.pos,
                "setting",
                format!(
                    "the blind_index column is varchar({BLIND_INDEX_LENGTH}) or longer, has the nullability of the aes column, is not aes-encoded and is the only column of an index or unique key"
                ),
            );
        }
    }

    fn audit(&mut self, into: &Name, operation: &Name, action: &Name, previous: &Name) {
        let table = self.own.table;
        let operation_column = self.setting_column(operation);
        if let Some(column) = operation_column {
            if !matches!(column.ty, Type::I64 | Type::Uuid) || column.nullable {
                self.report(operation.pos, "setting", "the operation column is a non-null i64 or uuid column");
            }
        }
        let Some(history) = self.scope.table(&into.text) else {
            if !self.scope.unresolved(&into.text) {
                self.report(into.pos, "setting", format!("unknown history table '{}'", into.text));
            }
            return;
        };
        let history = history.table;
        if history.name.text == table.name.text {
            self.report(into.pos, "setting", "a table is not its own history table");
            return;
        }
        let audited = history.settings.as_ref().is_some_and(|s| s.lines.iter().any(|l| matches!(l.setting, Setting::Audit { .. })));
        if audited {
            self.report(into.pos, "setting", format!("history table '{}' is audited itself", into.text));
        }
        match history.column(&action.text) {
            Some(column) if column.ty == Type::Varchar(8) && !column.nullable && table.column(&action.text).is_none() => {}
            _ => self.report(
                action.pos,
                "setting",
                format!("history table '{}' has no non-null varchar(8) action column '{}' of its own", into.text, action.text),
            ),
        }
        match history.column(&previous.text) {
            Some(column)
                if column.nullable
                    && operation_column.is_none_or(|o| o.ty == column.ty)
                    && table.column(&previous.text).is_none()
                    && previous.text != action.text => {}
            _ => self.report(
                previous.pos,
                "setting",
                format!("history table '{}' has no nullable previous column '{}' of the operation column type", into.text, previous.text),
            ),
        }
        let mut problems = Vec::new();
        let identity = history.primary.first().and_then(|key| match key.columns.as_slice() {
            [only] => history.column(&only.text).filter(|c| c.identity.is_some() && c.ty == Type::I64),
            _ => None,
        });
        match identity {
            Some(column) if table.column(&column.name.text).is_some() || column.name.text == action.text || column.name.text == previous.text => {
                problems.push(format!("identity column '{}' repeats another column", column.name.text))
            }
            Some(_) => {}
            None => problems.push("it has no i64 identity primary key".into()),
        }
        for column in &table.columns {
            match history.column(&column.name.text) {
                Some(copy) if copy.ty == column.ty => {}
                Some(_) => problems.push(format!("column '{}' has another type", column.name.text)),
                None => problems.push(format!("column '{}' is missing", column.name.text)),
            }
        }
        for column in &history.columns {
            let name = column.name.text.as_str();
            let known = table.column(name).is_some() || name == action.text || name == previous.text || identity.is_some_and(|c| c.name.text == name);
            if !known {
                problems.push(format!("column '{name}' is not part of the history"));
            }
        }
        if !problems.is_empty() {
            self.report(into.pos, "setting", format!("history table '{}': {}", into.text, problems.join("; ")));
        }
    }
}
