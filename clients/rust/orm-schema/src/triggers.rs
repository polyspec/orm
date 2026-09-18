//! ORM-owned triggers (audit and immutable guards). Each table's triggers form
//! one object: DDL creates it after the tables, and diff replaces it when its
//! rendered form changes and drops it before any table change.

use std::collections::{BTreeMap, BTreeSet};

use crate::ddl::{ddl_base, ddl_table, ddl_type, quote_qualified, sql_quote};
use crate::schema::{Audit, AuditLog, Col, Entity, Manifest};

/// The comment prefix each trigger body carries, so import can rebuild the
/// directive from a live database.
pub const TRIGGER_MARKER: &str = "-- orm:";
const CONTEXT_MESSAGE: &str = "'audit operation context is required'";
const OPERATION_MESSAGE: &str = "'audit operation does not exist'";
/// The SQLite table that holds transaction-local settings.
pub const SQLITE_CONTEXT_TABLE: &str = r#"CREATE TABLE IF NOT EXISTS "orm__context" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL);"#;
const EVENTS: [&str; 3] = ["INSERT", "UPDATE", "DELETE"];

pub struct TriggerObject {
    pub table: String,
    pub kind: &'static str,
    pub drop: Vec<String>,
    pub create: Vec<String>,
}

impl TriggerObject {
    fn key(&self) -> (String, &'static str) {
        (self.table.clone(), self.kind)
    }

    pub fn text(&self) -> String {
        self.create.join("\n")
    }
}

pub fn audit_log_marker(l: &AuditLog) -> String {
    format!(
        "{TRIGGER_MARKER}audit_log operation={}({}) context={} change={}({})",
        l.operation.table,
        l.operation.columns.join(", "),
        l.context,
        l.change.table,
        l.change.columns.join(", ")
    )
}

pub fn audit_marker(table: &str, a: &Audit) -> String {
    let mut s = format!("{TRIGGER_MARKER}audit table={table} mode={}", a.mode);
    if !a.site.is_empty() {
        s += &format!(" site={}", a.site);
    }
    if !a.redact.is_empty() {
        s += &format!(" redact={}", a.redact.iter().map(|p| p.join(".")).collect::<Vec<_>>().join(","));
    }
    s
}

fn quote_for(dialect: &str) -> impl Fn(&str) -> String + '_ {
    move |s: &str| if dialect == "mysql" { quote_qualified("`", s) } else { quote_qualified("\"", &ddl_table(s, dialect)) }
}

fn literal(s: &str) -> String {
    format!("'{}'", sql_quote(s))
}

fn trigger_name(table: &str, suffix: &str, dialect: &str) -> String {
    if dialect == "sqlite" {
        format!("{}_{suffix}", ddl_table(table, dialect))
    } else {
        format!("{table}_{suffix}")
    }
}

fn audit_of<'a>(m: &'a Manifest, entity: &str) -> Option<&'a Audit> {
    m.audits.iter().find(|a| a.entity == entity)
}

pub fn trigger_objects(m: &Manifest, dialect: &str) -> Result<Vec<TriggerObject>, String> {
    let mut out = Vec::new();
    for name in &m.order {
        let e = &m.entities[name];
        if let Some(a) = audit_of(m, name) {
            let log = m.audit_log.as_ref().ok_or_else(|| "audit without an audit log".to_owned())?;
            let markers = format!("{}\n{}", audit_log_marker(log), audit_marker(&e.table, a));
            out.push(match dialect {
                "postgres" => postgres_audit(log, e, a, &markers),
                "mysql" => mysql_audit(log, e, a, &markers),
                "sqlite" => sqlite_audit(log, e, a, &markers),
                _ => return Err(format!("unknown dialect {}", crate::schema::go_quote(dialect))),
            });
        }
        if m.immutable.iter().any(|i| i == name) {
            out.push(immutable_object(e, dialect)?);
        }
    }
    Ok(out)
}

fn immutable_object(e: &Entity, dialect: &str) -> Result<TriggerObject, String> {
    let q = quote_for(dialect);
    let mut o = TriggerObject { table: e.table.clone(), kind: "immutable", drop: Vec::new(), create: Vec::new() };
    let marker = format!("{TRIGGER_MARKER}immutable table={}", e.table);
    let message = literal(&format!("immutable table: {}", e.table));
    match dialect {
        "postgres" => {
            let function = q(&format!("{}_immutable_reject", e.table));
            let trigger = format!("\"{}_immutable\"", ddl_base(&e.table));
            o.drop = vec![format!("DROP TRIGGER IF EXISTS {trigger} ON {};", q(&e.table)), format!("DROP FUNCTION IF EXISTS {function}();")];
            o.create = vec![
                format!("CREATE OR REPLACE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$\n{marker}\nBEGIN RAISE EXCEPTION {message}; END;\n$$;"),
                format!("DROP TRIGGER IF EXISTS {trigger} ON {};", q(&e.table)),
                format!("CREATE TRIGGER {trigger} BEFORE UPDATE OR DELETE OR TRUNCATE ON {} FOR EACH STATEMENT EXECUTE FUNCTION {function}();", q(&e.table)),
            ];
        }
        "sqlite" | "mysql" => {
            for event in ["update", "delete"] {
                let trigger = q(&trigger_name(&e.table, &format!("immutable_{event}"), dialect));
                o.drop.push(format!("DROP TRIGGER IF EXISTS {trigger};"));
                o.create.push(format!("DROP TRIGGER IF EXISTS {trigger};"));
                o.create.push(if dialect == "sqlite" {
                    format!(
                        "CREATE TRIGGER {trigger} BEFORE {} ON {} FOR EACH ROW BEGIN\n{marker}\nSELECT RAISE(ABORT, {message});\nEND;",
                        event.to_uppercase(),
                        q(&e.table)
                    )
                } else {
                    format!(
                        "CREATE TRIGGER {trigger} BEFORE {} ON {} FOR EACH ROW\nBEGIN\n{marker}\n  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = {message};\nEND;",
                        event.to_uppercase(),
                        q(&e.table)
                    )
                });
            }
        }
        _ => return Err(format!("unknown dialect {}", crate::schema::go_quote(dialect))),
    }
    Ok(o)
}

fn change_columns(l: &AuditLog, q: &dyn Fn(&str) -> String) -> String {
    l.change.columns.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ")
}

fn postgres_audit(l: &AuditLog, e: &Entity, a: &Audit, markers: &str) -> TriggerObject {
    let q = quote_for("postgres");
    let function = q(&format!("{}_audit", e.table));
    let trigger = format!("\"{}_audit\"", ddl_base(&e.table));
    let truncate = format!("\"{}_audit_truncate\"", ddl_base(&e.table));
    let mut b = format!("CREATE OR REPLACE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$\n");
    b += &format!("{markers}\n");
    b += &format!("DECLARE\n  audit_operation_id text := current_setting({}, true);\n  audit_operation_seq bigint;\n", literal(&l.context));
    if a.mode == "changes" {
        b += "  audit_old jsonb := '{}'::jsonb;\n  audit_new jsonb := '{}'::jsonb;\n  audit_site text;\n  audit_key jsonb;\n";
    }
    b += "BEGIN\n";
    b += &format!("  IF audit_operation_id IS NULL OR audit_operation_id = '' THEN RAISE EXCEPTION {CONTEXT_MESSAGE}; END IF;\n");
    b += &format!(
        "  SELECT {} INTO audit_operation_seq FROM {} WHERE {}::text = audit_operation_id;\n",
        q(&l.operation.columns[0]),
        q(&l.operation.table),
        q(&l.operation.columns[1])
    );
    b += &format!("  IF audit_operation_seq IS NULL THEN RAISE EXCEPTION {OPERATION_MESSAGE}; END IF;\n");
    if a.mode == "changes" {
        b += "  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;\n";
        // An insert and a delete record every column. An update compares each
        // column's stored bytes and records only the changed columns, so an
        // unchanged large value is neither parsed nor compared under a collation.
        b += "  IF TG_OP = 'INSERT' THEN\n";
        b += &format!("    audit_new := {};\n", postgres_row_object(e, "NEW", &q));
        b += "  ELSIF TG_OP = 'DELETE' THEN\n";
        b += &format!("    audit_old := {};\n", postgres_row_object(e, "OLD", &q));
        b += "  ELSE\n";
        for c in audit_columns(e) {
            let name = literal(&c.name);
            let n = q(&c.name);
            b += &format!("    IF OLD.{n}::text IS DISTINCT FROM NEW.{n}::text THEN\n");
            b += &format!("      audit_old := audit_old || jsonb_build_object({name}, {});\n", postgres_value(c, &format!("OLD.{n}")));
            b += &format!("      audit_new := audit_new || jsonb_build_object({name}, {});\n", postgres_value(c, &format!("NEW.{n}")));
            b += "    END IF;\n";
        }
        b += "    IF audit_old::text = '{}' AND audit_new::text = '{}' THEN RETURN NULL; END IF;\n";
        b += "  END IF;\n";
        if !a.site.is_empty() {
            let site = q(&a.site);
            b += &format!("  audit_site := CASE TG_OP WHEN 'DELETE' THEN OLD.{site}::text ELSE NEW.{site}::text END;\n");
        }
        let keys: Vec<String> =
            e.pk.iter().flat_map(|k| [literal(k), format!("to_jsonb(CASE TG_OP WHEN 'DELETE' THEN OLD.{0} ELSE NEW.{0} END)", q(k))]).collect();
        b += &format!("  audit_key := jsonb_build_object({});\n", keys.join(", "));
        for path in &a.redact {
            let p = literal(&format!("{{{}}}", path.join(",")));
            for v in ["audit_new", "audit_old"] {
                b += &format!("  IF {v} #> {p} IS NOT NULL THEN {v} := jsonb_set({v}, {p}, '{{\"redacted\": true, \"present\": true}}'::jsonb); END IF;\n");
            }
        }
        b += &format!(
            "  INSERT INTO {} ({}) VALUES (audit_operation_seq, TG_OP, audit_site, {}, audit_key, audit_old, audit_new);\n",
            q(&l.change.table),
            change_columns(l, &q),
            literal(&e.table)
        );
    }
    b += "  RETURN NULL;\nEND\n$$;";
    let table = q(&e.table);
    TriggerObject {
        table: e.table.clone(),
        kind: "audit",
        drop: vec![
            format!("DROP TRIGGER IF EXISTS {trigger} ON {table};"),
            format!("DROP TRIGGER IF EXISTS {truncate} ON {table};"),
            format!("DROP FUNCTION IF EXISTS {function}();"),
        ],
        create: vec![
            b,
            format!("DROP TRIGGER IF EXISTS {trigger} ON {table};"),
            format!("CREATE TRIGGER {trigger} AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION {function}();"),
            format!("DROP TRIGGER IF EXISTS {truncate} ON {table};"),
            format!("CREATE TRIGGER {truncate} BEFORE TRUNCATE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION {function}();"),
        ],
    }
}

/// A PostgreSQL JSON value; a text column holding JSON is recorded as JSON.
fn postgres_value(c: &Col, r: &str) -> String {
    let t = ddl_type(c, "postgres").unwrap_or_default();
    if t == "text" || t.starts_with("varchar") {
        return format!("CASE WHEN {r} IS JSON THEN {r}::jsonb ELSE to_jsonb({r}) END");
    }
    format!("to_jsonb({r})")
}

/// Every column of a row as one JSON object, built in parts of 50 pairs.
fn postgres_row_object(e: &Entity, row: &str, q: &dyn Fn(&str) -> String) -> String {
    let parts: Vec<String> = audit_columns(e)
        .chunks(50)
        .map(|chunk| {
            let args: Vec<String> = chunk.iter().flat_map(|c| [literal(&c.name), postgres_value(c, &format!("{row}.{}", q(&c.name)))]).collect();
            format!("jsonb_build_object({})", args.join(", "))
        })
        .collect();
    if parts.is_empty() { "'{}'::jsonb".into() } else { parts.join(" || ") }
}

/// A column value for a JSON object on MySQL and SQLite. Binary values use
/// PostgreSQL's hex text form. SQLite stores JSON as text, so valid JSON text
/// in a text column becomes a JSON value; the rule uses the storage type,
/// which a live schema reports.
fn audit_value(c: &Col, r: &str, dialect: &str) -> String {
    if dialect == "sqlite" {
        return match ddl_type(c, "sqlite").as_deref() {
            Ok("BLOB") => format!("CASE WHEN {r} IS NULL THEN NULL ELSE '\\x' || lower(hex({r})) END"),
            Ok("TEXT") => format!("CASE WHEN json_valid({r}) THEN json({r}) ELSE {r} END"),
            _ => r.to_owned(),
        };
    }
    match c.typ.as_str() {
        "bytes" | "inet" => return format!("CASE WHEN {r} IS NULL THEN NULL ELSE CONCAT(CHAR(92 USING utf8mb4), 'x', LOWER(HEX({r}))) END"),
        "point" => return format!("ST_AsText({r})"),
        _ => {}
    }
    let t = ddl_type(c, "mysql").unwrap_or_default().to_lowercase();
    if t.contains("char") || t.contains("text") {
        return format!("CAST(IF(JSON_VALID({r}), {r}, JSON_QUOTE({r})) AS JSON)");
    }
    r.to_owned()
}

/// The columns by name: a column added by a migration sits at the end of the
/// live table, and the trigger must not depend on that.
fn audit_columns(e: &Entity) -> Vec<&Col> {
    let mut columns: Vec<&Col> = e.columns.iter().collect();
    columns.sort_by(|a, b| a.name.cmp(&b.name));
    columns
}

fn row_object(e: &Entity, row: &str, dialect: &str, q: &dyn Fn(&str) -> String) -> String {
    let parts: Vec<String> = audit_columns(e).into_iter().flat_map(|c| [literal(&c.name), audit_value(c, &format!("{row}.{}", q(&c.name)), dialect)]).collect();
    format!("{}{})", if dialect == "mysql" { "JSON_OBJECT(" } else { "json_object(" }, parts.join(", "))
}

/// Removes the SQLite columns whose stored bytes did not change.
fn unchanged(e: &Entity, object: &str, q: &dyn Fn(&str) -> String) -> String {
    let parts: Vec<String> = audit_columns(e)
        .into_iter()
        .map(|c| {
            let path = literal(&format!("$.\"{}\"", c.name));
            let n = q(&c.name);
            format!("CASE WHEN CAST(NEW.{n} AS BLOB) IS CAST(OLD.{n} AS BLOB) THEN {path} ELSE '$.\"__orm_unchanged\"' END")
        })
        .collect();
    format!("json_remove({object}, {})", parts.join(", "))
}

fn json_path(path: &[String]) -> String {
    literal(&format!("$.\"{}\"", path.join("\".\"")))
}

fn row_of(event: &str) -> &'static str {
    if event == "DELETE" {
        "OLD"
    } else {
        "NEW"
    }
}

fn audit_key(e: &Entity, event: &str, dialect: &str, q: &dyn Fn(&str) -> String) -> String {
    let parts: Vec<String> = e
        .pk
        .iter()
        .flat_map(|k| {
            let c = e.column(k).expect("primary key column");
            let value = if event == "UPDATE" {
                format!("COALESCE({}, {})", audit_value(c, &format!("NEW.{}", q(k)), dialect), audit_value(c, &format!("OLD.{}", q(k)), dialect))
            } else {
                audit_value(c, &format!("{}.{}", row_of(event), q(k)), dialect)
            };
            [literal(k), value]
        })
        .collect();
    format!("{}{})", if dialect == "mysql" { "JSON_OBJECT(" } else { "json_object(" }, parts.join(", "))
}

fn audit_site(a: &Audit, event: &str, q: &dyn Fn(&str) -> String) -> String {
    if a.site.is_empty() {
        return "NULL".into();
    }
    if event == "UPDATE" {
        return format!("COALESCE(NEW.{}, OLD.{})", q(&a.site), q(&a.site));
    }
    format!("{}.{}", row_of(event), q(&a.site))
}

fn mysql_audit(l: &AuditLog, e: &Entity, a: &Audit, markers: &str) -> TriggerObject {
    let q = quote_for("mysql");
    let context = format!("@`orm.{}`", l.context.replace('`', "``"));
    let mut o = TriggerObject { table: e.table.clone(), kind: "audit", drop: Vec::new(), create: Vec::new() };
    for event in EVENTS {
        let trigger = q(&trigger_name(&e.table, &format!("audit_{}", event.to_lowercase()), "mysql"));
        let mut b = format!("CREATE TRIGGER {trigger} AFTER {event} ON {} FOR EACH ROW\nBEGIN\n", q(&e.table));
        b += &format!("{markers}\n");
        b += "  DECLARE audit_operation_id VARCHAR(255);\n  DECLARE audit_operation_seq BIGINT;\n";
        if a.mode == "changes" {
            b += "  DECLARE audit_old JSON;\n  DECLARE audit_new JSON;\n";
        }
        // The local variable takes the database collation, as the tables do;
        // the user variable has the connection collation.
        b += &format!("  SET audit_operation_id = {context};\n");
        b += &format!("  IF COALESCE(audit_operation_id, '') = '' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = {CONTEXT_MESSAGE}; END IF;\n");
        b += &format!(
            "  SET audit_operation_seq = (SELECT {} FROM {} WHERE {} = audit_operation_id LIMIT 1);\n",
            q(&l.operation.columns[0]),
            q(&l.operation.table),
            q(&l.operation.columns[1])
        );
        b += &format!("  IF audit_operation_seq IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = {OPERATION_MESSAGE}; END IF;\n");
        if a.mode == "changes" {
            if event == "INSERT" {
                b += "  SET audit_old = JSON_OBJECT();\n";
                b += &format!("  SET audit_new = {};\n", row_object(e, "NEW", "mysql", &q));
            } else if event == "DELETE" {
                b += &format!("  SET audit_old = {};\n", row_object(e, "OLD", "mysql", &q));
                b += "  SET audit_new = JSON_OBJECT();\n";
            } else {
                // Only the changed columns are rendered, and stored bytes decide
                // a change; the column collation would treat values that differ
                // only in case or accents as equal.
                b += "  SET audit_old = JSON_OBJECT();\n  SET audit_new = JSON_OBJECT();\n";
                for c in audit_columns(e) {
                    let path = literal(&format!("$.\"{}\"", c.name));
                    let n = q(&c.name);
                    b += &format!("  IF NOT (CAST(NEW.{n} AS BINARY) <=> CAST(OLD.{n} AS BINARY)) THEN\n");
                    b += &format!("    SET audit_old = JSON_SET(audit_old, {path}, {});\n", audit_value(c, &format!("OLD.{n}"), "mysql"));
                    b += &format!("    SET audit_new = JSON_SET(audit_new, {path}, {});\n", audit_value(c, &format!("NEW.{n}"), "mysql"));
                    b += "  END IF;\n";
                }
            }
            for path in &a.redact {
                let p = json_path(path);
                for v in ["audit_new", "audit_old"] {
                    b += &format!(
                        "  SET {v} = IF(JSON_CONTAINS_PATH({v}, 'one', {p}), JSON_SET({v}, {p}, JSON_OBJECT('redacted', CAST('true' AS JSON), 'present', CAST('true' AS JSON))), {v});\n"
                    );
                }
            }
            let insert = format!(
                "INSERT INTO {} ({}) VALUES (audit_operation_seq, '{event}', {}, {}, {}, audit_old, audit_new);",
                q(&l.change.table),
                change_columns(l, &q),
                audit_site(a, event, &q),
                literal(&e.table),
                audit_key(e, event, "mysql", &q)
            );
            if event == "UPDATE" {
                b += &format!("  IF JSON_LENGTH(audit_old) > 0 OR JSON_LENGTH(audit_new) > 0 THEN\n    {insert}\n  END IF;\n");
            } else {
                b += &format!("  {insert}\n");
            }
        }
        b += "END;";
        o.drop.push(format!("DROP TRIGGER IF EXISTS {trigger};"));
        o.create.push(format!("DROP TRIGGER IF EXISTS {trigger};"));
        o.create.push(b);
    }
    o
}

fn sqlite_audit(l: &AuditLog, e: &Entity, a: &Audit, markers: &str) -> TriggerObject {
    let q = quote_for("sqlite");
    let context = format!("(SELECT \"value\" FROM \"orm__context\" WHERE \"key\" = {})", literal(&l.context));
    let operation = format!("(SELECT {} FROM {} WHERE {} = {context})", q(&l.operation.columns[0]), q(&l.operation.table), q(&l.operation.columns[1]));
    let mut o = TriggerObject { table: e.table.clone(), kind: "audit", drop: Vec::new(), create: vec![SQLITE_CONTEXT_TABLE.to_owned()] };
    for event in EVENTS {
        let trigger = q(&trigger_name(&e.table, &format!("audit_{}", event.to_lowercase()), "sqlite"));
        let mut b = format!("CREATE TRIGGER {trigger} AFTER {event} ON {} FOR EACH ROW BEGIN\n", q(&e.table));
        b += &format!("{markers}\n");
        b += &format!("SELECT RAISE(ABORT, {CONTEXT_MESSAGE}) WHERE COALESCE({context}, '') = '';\n");
        b += &format!("SELECT RAISE(ABORT, {OPERATION_MESSAGE}) WHERE {operation} IS NULL;\n");
        if a.mode == "changes" {
            let mut old_value = if event != "INSERT" { row_object(e, "OLD", "sqlite", &q) } else { "json_object()".into() };
            let mut new_value = if event != "DELETE" { row_object(e, "NEW", "sqlite", &q) } else { "json_object()".into() };
            if event == "UPDATE" {
                old_value = unchanged(e, &old_value, &q);
                new_value = unchanged(e, &new_value, &q);
            }
            let mut source = format!("SELECT {new_value} AS n, {old_value} AS o");
            for path in &a.redact {
                let p = json_path(path);
                let redacted = |v: &str| {
                    format!("CASE WHEN json_type(r.{v}, {p}) IS NOT NULL THEN json_set(r.{v}, {p}, json_object('redacted', json('true'), 'present', json('true'))) ELSE r.{v} END")
                };
                source = format!("SELECT {} AS n, {} AS o FROM ({source}) AS r", redacted("n"), redacted("o"));
            }
            b += &format!(
                "INSERT INTO {} ({}) SELECT {operation}, '{event}', {}, {}, {}, v.o, v.n FROM ({source}) AS v",
                q(&l.change.table),
                change_columns(l, &q),
                audit_site(a, event, &q),
                literal(&e.table),
                audit_key(e, event, "sqlite", &q)
            );
            if event == "UPDATE" {
                b += " WHERE v.o <> '{}' OR v.n <> '{}'";
            }
            b += ";\n";
        }
        b += "END;";
        o.drop.push(format!("DROP TRIGGER IF EXISTS {trigger};"));
        o.create.push(format!("DROP TRIGGER IF EXISTS {trigger};"));
        o.create.push(b);
    }
    o
}

/// The statements that drop changed trigger objects before the table changes
/// and create them after. A rebuilt SQLite table loses its triggers, so its
/// objects are always created again.
pub fn diff_triggers(from: &Manifest, to: &Manifest, dialect: &str, rebuilt: &BTreeSet<String>) -> Result<(Vec<String>, Vec<String>), String> {
    let next_objects = trigger_objects(to, dialect)?;
    let next: BTreeMap<_, &TriggerObject> = next_objects.iter().map(|o| (o.key(), o)).collect();
    let mut previous = BTreeMap::new();
    let mut drops = Vec::new();
    let from_objects = trigger_objects(from, dialect)?;
    for o in &from_objects {
        previous.insert(o.key(), o);
        if let Some(n) = next.get(&o.key()) {
            if n.text() == o.text() && !rebuilt.contains(&o.table) {
                continue;
            }
        }
        drops.extend(o.drop.iter().cloned());
    }
    let mut creates = Vec::new();
    for o in &next_objects {
        if let Some(p) = previous.get(&o.key()) {
            if p.text() == o.text() && !rebuilt.contains(&o.table) {
                continue;
            }
        }
        creates.push(o.create.join("\n"));
    }
    Ok((drops, creates))
}

/// Whether a live schema has the declared trigger objects, compared by table
/// so live entity names may differ.
pub fn same_triggers(want: &Manifest, live: &Manifest) -> bool {
    fn describe(m: &Manifest) -> Vec<String> {
        let mut out = Vec::new();
        for name in &m.immutable {
            out.push(format!("immutable {}", m.entities[name].table));
        }
        for a in &m.audits {
            out.push(audit_marker(&m.entities[&a.entity].table, a));
        }
        if let Some(l) = &m.audit_log {
            out.push(audit_log_marker(l));
        }
        out.sort();
        out
    }
    describe(want) == describe(live)
}

/// Mermaid directives for the marker lines of live triggers on the imported
/// tables. Entity names are table names.
pub fn trigger_directives(bodies: &[String], tables: &BTreeSet<String>) -> Vec<String> {
    let mut audits = Vec::new();
    let mut immutables = Vec::new();
    let mut audit_log = String::new();
    let mut seen = BTreeSet::new();
    for body in bodies {
        for line in body.split('\n') {
            let line = line.trim();
            if !line.starts_with(TRIGGER_MARKER) || !seen.insert(line.to_owned()) {
                continue;
            }
            let directive = &line[TRIGGER_MARKER.len()..];
            let (kind, rest) = directive.split_once(' ').unwrap_or((directive, ""));
            match kind {
                "audit_log" => audit_log = format!("%% orm:{directive}"),
                "audit" | "immutable" => {
                    let rest = rest.strip_prefix("table=").unwrap_or(rest);
                    let (table, options) = rest.split_once(' ').unwrap_or((rest, ""));
                    if !tables.contains(table) {
                        continue;
                    }
                    let mut out = format!("%% orm:{kind} entity={table}");
                    if !options.is_empty() {
                        out += " ";
                        out += options;
                    }
                    if kind == "audit" {
                        audits.push(out);
                    } else {
                        immutables.push(out);
                    }
                }
                _ => {}
            }
        }
    }
    audits.sort();
    immutables.sort();
    let mut out = immutables;
    if !audits.is_empty() && !audit_log.is_empty() {
        out.push(audit_log);
        out.extend(audits);
    }
    out
}

/// The query that returns the trigger bodies of the current schema.
pub fn trigger_bodies_query(dialect: &str) -> &'static str {
    match dialect {
        "postgres" => "SELECT p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = current_schema() ORDER BY c.relname, t.tgname",
        "mysql" => "SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME",
        _ => "SELECT sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name",
    }
}
