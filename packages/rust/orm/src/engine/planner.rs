//! Turns a validated request into a plan: one statement per step, relations
//! as separate steps bound to the rows of their parent step.

use std::sync::Arc;

use super::dialect::Dialect;
use super::err;
use super::params::{function_type, interval_type};
use crate::codes;
use crate::ir;
use crate::plan::{Assemble, BindSlot, Child, IfParent, KeyRef, OutCol, ParentRef, Plan, Step};
use crate::schema::Manifest;
use crate::Result;
use polyspec_orm_schema::dbspec::{Entity, Field, FieldDefault, Type};

pub(crate) struct Planner<'m> {
    pub m: &'m Manifest,
    pub d: Dialect,
}

/// One entity occurrence in a statement (the root or a join) with its alias.
struct Scope<'a> {
    ent: &'a Entity,
    alias: String,
    q: &'a ir::Query,
    joins: Vec<(String, Scope<'a>)>,
    /// The query that owns a subquery root; "^" references resolve to it.
    outer: Option<&'a Scope<'a>>,
    /// Columns a relation step needs selected (its match columns, key_by).
    extra: Vec<String>,
}

impl<'a> Scope<'a> {
    fn join(&self, name: &str) -> Option<&Scope<'a>> {
        self.joins.iter().find(|(n, _)| n == name).map(|(_, s)| s)
    }
}

/// The relation a step loads.
struct RelCtx {
    parent_step: usize,
    parent_keys: Vec<KeyRef>,
    if_parent: Option<IfParent>,
    child_keys: Vec<String>,
    kind: String,
}

/// An assemble node under construction.
#[derive(Default)]
struct Asm {
    entity: String,
    alias: String,
    columns: Vec<OutCol>,
    children: Vec<Ch>,
    key: Vec<KeyRef>,
    aes_version: Option<usize>,
}

struct Ch {
    child: Child,
    asm: Option<Asm>,
}

impl Asm {
    fn index_of(&self, name: &str) -> Result<usize> {
        self.columns
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.index)
            .ok_or_else(|| err(codes::INTERNAL, format!("planner: column {name} is not projected in {}", self.entity)))
    }

    fn key_refs(&self, columns: &[String]) -> Result<Vec<KeyRef>> {
        columns.iter().map(|c| Ok(KeyRef { column: c.clone(), index: self.index_of(c)? })).collect()
    }

    fn finish(self) -> Assemble {
        Assemble {
            entity: self.entity,
            alias: self.alias,
            columns: self.columns,
            key: self.key,
            aes_version: self.aes_version,
            children: self.children.into_iter().map(|ch| Child { assemble: ch.asm.map(|a| Arc::new(a.finish())), ..ch.child }).collect(),
        }
    }
}

fn key_refs_of(a: &Assemble, columns: &[String]) -> Result<Vec<KeyRef>> {
    columns
        .iter()
        .map(|c| {
            a.index_of(c)
                .map(|index| KeyRef { column: c.clone(), index })
                .ok_or_else(|| err(codes::INTERNAL, format!("planner: column {c} is not projected in {}", a.entity)))
        })
        .collect()
}

struct Builder {
    d: Dialect,
    binds: Vec<BindSlot>,
    subs: usize,
    /// The table the statement uses by name.
    tables: std::collections::BTreeSet<String>,
    /// The first planner error raised while making a placeholder, such as a slot without a type. The place that makes the step checks it.
    error: Option<crate::Error>,
}

impl Builder {
    fn new(d: Dialect) -> Builder {
        Builder { d, binds: Vec::new(), subs: 0, tables: std::collections::BTreeSet::new(), error: None }
    }

    /// Returns the first error raised while making placeholders.
    fn checked(&mut self) -> Result<()> {
        match self.error.take() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Quotes the table name and records it as a table of the statement.
    fn table(&mut self, table: &str) -> String {
        self.tables.insert(table.to_string());
        self.d.quote(table)
    }

    /// Returns the tables the statement wrote, sorted.
    fn tables(&self) -> Vec<String> {
        self.tables.iter().cloned().collect()
    }

    fn push(&mut self, slot: BindSlot) -> String {
        self.binds.push(slot);
        self.d.placeholder(self.binds.len())
    }

    /// Adds a slot with a type. A slot without a type is a planner error.
    fn slot(&mut self, slot: BindSlot) -> String {
        if slot.col_type.is_empty() && self.error.is_none() {
            self.error = Some(err(codes::IR_INVALID, format!("bind slot {} ({}) has no declared type", self.binds.len(), slot.from)));
        }
        self.push(slot)
    }

    /// The placeholder for request value Params[i]. `ty` is that value's dbspec type.
    fn param(&mut self, i: usize, ty: &str) -> String {
        // A datetime or time compared with a function's argument or result is text of six fraction digits.
        let precision = if ty == "datetime" || ty == "time" { 6 } else { 0 };
        self.slot(BindSlot { from: "param".into(), param: i, col_type: ty.into(), precision, ..Default::default() })
    }

    /// The placeholder for value Params[i] bound through the value transform `transform`, with the text type of a full-text search.
    fn transformed(&mut self, i: usize, transform: &str) -> String {
        self.slot(BindSlot { from: "param".into(), param: i, transform: transform.into(), col_type: "text".into(), ..Default::default() })
    }

    /// The placeholder for value Params[i] compared with or assigned to column `col`. The type is the type of `col`
    /// and decimal, time, and datetime carry its digit counts.
    fn col_param(&mut self, i: usize, col: &Field, transform: &str) -> String {
        let (precision, scale) = col_digits(col);
        let length = if let Type::Varchar(n) = col.ty { n.into() } else { 0 };
        self.slot(BindSlot {
            from: "param".into(),
            param: i,
            transform: transform.into(),
            col_type: col.ty.name().into(),
            precision,
            scale,
            length,
            ..Default::default()
        })
    }

    /// An executor setting value. `ty` is the type of the column that writes the value.
    fn config(&mut self, name: &str, ty: &str) -> String {
        self.slot(BindSlot { from: "config".into(), name: name.into(), col_type: ty.into(), ..Default::default() })
    }

    /// The time the executor provides. `precision` is the slot's fractional digits (`clock_precision`).
    fn now(&mut self, precision: u8) -> String {
        self.slot(BindSlot { from: "now".into(), precision: precision.into(), col_type: "datetime".into(), ..Default::default() })
    }

    /// The audit record key of the transaction that the executor fills. name is the audit record entity, and the executor
    /// checks that the transaction's audit is a row of that entity. type is the type of the audit column.
    fn audit(&mut self, col: &Field, record: &str) -> String {
        let ph = self.slot(BindSlot { from: "audit".into(), name: record.to_owned(), col_type: col.ty.name().into(), ..Default::default() });
        self.d.write_expr(ph, col.ty, &[])
    }

    /// One placeholder the executor expands into parent values. `key_types` are the types of the key columns compared.
    fn parent_list(&mut self, step: usize, key_types: Vec<String>) -> String {
        self.push(BindSlot { from: "parent".into(), step: step as u32, key_types, ..Default::default() })
    }
}

fn cmp(op: &str) -> &'static str {
    match op {
        "eq" => "=",
        "not_eq" => "!=",
        "gt" => ">",
        "gte" => ">=",
        "lt" => "<",
        _ => "<=",
    }
}

/// The key version column written with AES values (`aes_version` setting).
fn aes_version_column(ent: &Entity) -> &str {
    ent.aes_version.as_deref().unwrap_or("")
}

/// The audit column to which the executor writes the transaction's audit record key.
fn audit_column(ent: &Entity) -> &str {
    ent.audit.as_ref().map(|a| a.column.as_str()).unwrap_or("")
}

/// The audit record entity that the audit column points to.
fn audit_record(ent: &Entity) -> &str {
    ent.audit.as_ref().map(|a| a.record.as_str()).unwrap_or("")
}

fn assigned(set: &[ir::Assign], col: &str) -> bool {
    set.iter().any(|a| a.column == col)
}

fn assigns_aes(ent: &Entity, set: &[ir::Assign]) -> bool {
    set.iter().any(|a| ent.field(&a.column).map(Field::aes).unwrap_or(false))
}

/// A request that writes an audit column only the executor writes is rejected.
fn validate_audit_assignment(ent: &Entity, set: &[ir::Assign]) -> Result<()> {
    let audited = audit_column(ent);
    if !audited.is_empty() && assigned(set, audited) {
        return Err(err(codes::IR_INVALID, format!("{}.{audited} is written by the executor from the audit of the transaction", ent.name)));
    }
    Ok(())
}

/// The p of a `datetime(p)` column.
fn datetime_precision(col: &Field) -> u8 {
    match col.ty {
        Type::DateTime(p) => p,
        _ => 0,
    }
}

/// The fractional digits of the `now` slot written to a column: p for a `datetime(p)` column, and 6 for other columns.
/// The executor truncates a statement's clock to these digits for each slot. A compared clock has six digits.
fn clock_precision(col: &Field) -> u8 {
    match col.ty {
        Type::DateTime(p) => p,
        _ => 6,
    }
}

/// Keeps the row-level key-version invariant: the version is managed by the
/// planner, and an update of encrypted data replaces every AES column.
fn validate_aes_assignments(ent: &Entity, set: &[ir::Assign], require_complete: bool) -> Result<()> {
    let version = aes_version_column(ent);
    if version.is_empty() {
        return Ok(());
    }
    if assigned(set, version) {
        return Err(err(codes::IR_INVALID, format!("{version} is managed by the AES writer")));
    }
    if !require_complete || !assigns_aes(ent, set) {
        return Ok(());
    }
    for col in &ent.fields {
        if col.aes() && !assigned(set, &col.name) {
            return Err(err(codes::IR_INVALID, format!("AES update must assign every AES column; missing {}", col.name)));
        }
    }
    Ok(())
}

/// An insert writes all the columns it needs: NOT NULL columns without a default, other than the identity,
/// the AES key version the planner writes, and the audit columns the executor writes.
/// Columns that have a default are left out, so the database default is used.
fn validate_required_assignments(ent: &Entity, set: &[ir::Assign]) -> Result<()> {
    let version = aes_version_column(ent);
    let audited = audit_column(ent);
    for col in &ent.fields {
        if col.nullable || col.default.is_some() || col.identity || col.name == version || col.name == audited || assigned(set, &col.name) {
            continue;
        }
        return Err(err(codes::IR_INVALID, format!("required column {}.{} is not set", ent.name, col.name)));
    }
    Ok(())
}

fn add_blind_index_assignments(ent: &Entity, mut set: Vec<ir::Assign>) -> Result<Vec<ir::Assign>> {
    let mut sources = std::collections::BTreeMap::<String, String>::new();
    for a in &set {
        let Some(col) = ent.field(&a.column) else { continue };
        let Some(index) = col.blind_index.as_ref().filter(|_| col.aes()) else { continue };
        if assigned(&set, index) {
            continue;
        }
        if let Some(previous) = sources.insert(index.clone(), col.name.clone()) {
            if previous != col.name {
                return Err(err(
                    codes::IR_INVALID,
                    format!("blind index {index} is derived from both {previous} and {}", col.name),
                ));
            }
        }
    }
    let derived: Vec<_> = set
        .iter()
        .filter_map(|a| {
            let col = ent.field(&a.column)?;
            let index = col.blind_index.as_ref().filter(|_| col.aes())?;
            (!assigned(&set, index)).then(|| ir::Assign { column: index.clone(), p: a.p, null: a.null, ..Default::default() })
        })
        .collect();
    set.extend(derived);
    Ok(set)
}

fn assigned_blind_index_source<'e>(ent: &'e Entity, target: &str, assignments: &[ir::Assign]) -> Option<&'e Field> {
    ent.fields.iter().find(|field| {
        field.aes() && field.blind_index.as_deref() == Some(target) && assigned(assignments, &field.name)
    })
}

fn blind_index_source<'e>(ent: &'e Entity, target: &str) -> Option<&'e Field> {
    ent.fields.iter().find(|c| c.blind_index.as_deref() == Some(target))
}

/// The columns of the one key an upsert conflicts on, which the validator has checked.
fn conflict_target(ent: &Entity, set: &[ir::Assign]) -> Result<Vec<String>> {
    super::validate::conflict_key(ent, set)
}

/// The precision and scale a column value slot carries: decimal(p,s), time(p), datetime(p).
fn col_digits(col: &Field) -> (i64, i64) {
    match col.ty {
        Type::Decimal(p, s) => (p.into(), s.into()),
        Type::Time(p) | Type::DateTime(p) => (p.into(), 0),
        _ => (0, 0),
    }
}

/// The type of the value that a SQL-side style function takes from the placeholder. hex takes bytes, and ip takes IP address text.
fn style_input_type(style: &str) -> &'static str {
    if style == "ip" {
        "text"
    } else {
        "bytes"
    }
}

/// Marks the param slots from b's start as assignments to col and returns the sql: a slot of a non-null column carries that column,
/// and the executor rejects NULL values.
fn mark_assigned(b: &mut Builder, start: usize, col: &Field, sql: String) -> String {
    if !col.nullable {
        for s in b.binds[start..].iter_mut().filter(|s| s.from == "param") {
            s.not_null = true;
            s.column = col.name.clone();
        }
    }
    sql
}

fn placed_joins(g: &ir::Group, out: &mut Vec<String>) {
    for it in &g.items {
        match it {
            ir::Item::Joined { joined } => out.push(joined.join.clone()),
            ir::Item::Group { group } => placed_joins(group, out),
            ir::Item::Pred { .. } => {}
        }
    }
}

fn has_where(g: &Option<ir::Group>) -> bool {
    g.as_ref().map(|g| !g.items.is_empty()).unwrap_or(false)
}

impl<'m> Planner<'m> {
    fn entity(&self, name: &str) -> Result<&'m Entity> {
        self.m.entity(name)
    }

    pub fn compile(&self, r: &ir::Request) -> Result<Plan> {
        let mut steps = Vec::new();
        match r.kind.as_str() {
            "one" | "all" | "count" | "group_count" | "sum" | "avg" => {
                self.select_step(&mut steps, &r.query, &r.kind, &r.agg, None)?;
            }
            "paginate" => {
                self.select_step(&mut steps, &r.query, "all", "", None)?;
                self.select_step(&mut steps, &r.query, "count", "", None)?;
            }
            "insert" => steps.push(self.insert_step(r)?),
            "update" => steps.push(self.update_step(r)?),
            "delete" => steps.push(self.delete_step(r)?),
            "restore" => steps.push(self.restore_step(r)?),
            "restart_identity" => steps.push(self.restart_identity_step(r)?),
            other => return Err(err(codes::IR_INVALID, format!("unknown kind {other:?}"))),
        }
        for (i, st) in steps.iter_mut().enumerate() {
            st.id = i as u32;
        }
        Ok(Plan { manifest_hash: self.m.manifest_hash.clone(), kind: r.kind.clone(), steps })
    }

    /// Assigns aliases: root "a", joins by result name, nested joins and the
    /// joins of other roots prefixed by their parent's alias.
    fn scopes<'a>(&self, q: &'a ir::Query, alias: String, nested: bool) -> Result<Scope<'a>>
    where
        'm: 'a,
    {
        let mut joins = Vec::with_capacity(q.joins.len());
        for j in &q.joins {
            let ja = if nested || alias != "a" { format!("{alias}__{}", j.rel) } else { j.rel.clone() };
            joins.push((j.rel.clone(), self.scopes(&j.query, ja, true)?));
        }
        Ok(Scope { ent: self.entity(&q.entity)?, alias, q, joins, outer: None, extra: Vec::new() })
    }

    fn qcol(&self, s: &Scope<'_>, col: &str) -> String {
        format!("{}.{}", self.d.quote(&s.alias), self.d.quote(col))
    }

    fn qualified(&self, s: &Scope<'_>, cols: &[String]) -> Vec<String> {
        cols.iter().map(|c| self.qcol(s, c)).collect()
    }

    fn sql_styles<'c>(&self, styles: &'c [String]) -> Vec<&'c str> {
        styles.iter().map(String::as_str).filter(|s| self.d.handles_style(s)).collect()
    }

    /// The stage the dialect decodes in SQL on reads. `client_styles` leaves the rest to the executor.
    fn read_sql_styles<'c>(&self, styles: &'c [String]) -> Vec<&'c str> {
        styles.iter().map(String::as_str).filter(|s| self.d.decodes_style(s)).collect()
    }

    fn client_styles(&self, styles: &[String]) -> Vec<String> {
        styles.iter().filter(|s| !self.d.decodes_style(s)).cloned().collect()
    }

    fn select_step(&self, steps: &mut Vec<Step>, q: &ir::Query, kind: &str, agg: &str, rc: Option<&RelCtx>) -> Result<usize> {
        let mut b = Builder::new(self.d);
        let mut root = self.scopes(q, "a".into(), false)?;
        if let Some(rc) = rc {
            root.extra.extend(rc.child_keys.iter().cloned());
            if !q.key_by.is_empty() {
                root.extra.push(q.key_by.clone());
            }
        }
        let root = &root;
        let mut sb = String::from("SELECT ");
        let mut asm = Asm { entity: root.ent.name.clone(), alias: root.alias.clone(), ..Default::default() };
        let mut out_names = Vec::new();
        let grouped = !q.group_by.is_empty();
        let group_count = kind == "count" && grouped;
        match kind {
            "count" => sb.push_str(if group_count { "1" } else { "COUNT(*)" }),
            "sum" => sb.push_str(&format!("COALESCE(SUM({}), 0)", self.qcol(root, agg))),
            "avg" => sb.push_str(&format!("AVG({})", self.qcol(root, agg))),
            "group_count" => {
                self.select_group_count_list(root, &mut sb, &mut asm, &mut out_names)?;
                asm.key = asm.key_refs(&q.group_by)?;
            }
            _ => {
                self.select_list(&mut b, root, &mut sb, &mut asm, &mut out_names)?;
                asm.key = asm.key_refs(&root.ent.primary_key)?;
            }
        }
        // Rows per parent: ROW_NUMBER() over the match columns. A one-relation
        // with an order keeps the first row by that order.
        let mut per_parent = 0;
        if let Some(rc) = rc {
            per_parent = q.limit_per_parent;
            if per_parent == 0 && rc.kind == "one" && !q.order.is_empty() {
                per_parent = 1;
            }
        }
        if let (true, Some(rc)) = (per_parent > 0, rc) {
            let mut order = self.render_order(root, q)?;
            if order.is_empty() {
                order = format!(" ORDER BY {} ASC", self.qcol(root, &root.ent.primary_key[0]));
            }
            sb.push_str(&format!(
                ", ROW_NUMBER() OVER (PARTITION BY {}{order}) AS {}",
                self.qualified(root, &rc.child_keys).join(", "),
                self.d.quote("orm_rn")
            ));
        }
        sb.push_str(&format!(" FROM {} AS {}", b.table(&root.ent.table), self.d.quote(&root.alias)));
        if !q.force_index.is_empty() {
            sb.push_str(&self.d.force_index(&q.force_index));
        }
        self.render_joins(&mut b, root, root, &mut sb)?;
        let mut where_ = Vec::new();
        if let Some(rc) = rc {
            let key_types = rc.child_keys.iter().map(|k| self.column_of(root.ent, k).map(|f| f.ty.name().to_owned())).collect::<Result<Vec<_>>>()?;
            let list = b.parent_list(rc.parent_step, key_types);
            if rc.child_keys.len() == 1 {
                where_.push(format!("{} IN ({list})", self.qcol(root, &rc.child_keys[0])));
            } else {
                where_.push(format!("({}) IN (({list}))", self.qualified(root, &rc.child_keys).join(", ")));
            }
        }
        if let Some(soft_delete) = &root.ent.soft_delete {
            where_.push(format!("{} IS NULL", self.qcol(root, soft_delete)));
        }
        if let Some(g) = q.where_.as_ref().filter(|g| !g.items.is_empty()) {
            where_.push(self.render_group(&mut b, root, root, g, rc.is_none())?);
        }
        self.collect_join_where(&mut b, root, root, &mut where_)?;
        if !where_.is_empty() {
            sb.push_str(" WHERE ");
            sb.push_str(&where_.join(" AND "));
        }
        // The validator admits group_by only on count and group_count.
        if grouped {
            sb.push_str(" GROUP BY ");
            sb.push_str(&self.render_group_by(root, q)?);
        }
        if group_count {
            sb = format!("SELECT COUNT(*) FROM ({sb}) AS {}", self.d.quote("orm_g"));
        }
        let rows = matches!(kind, "one" | "all" | "group_count");
        if rows {
            if let (true, Some(rc)) = (per_parent > 0, rc) {
                let w = self.d.quote("orm_w");
                let cols: Vec<String> = out_names.iter().map(|n| format!("{w}.{}", self.d.quote(n))).collect();
                let keys: Vec<String> = rc.child_keys.iter().map(|k| format!("{w}.{}", self.d.quote(&format!("{}__{k}", root.alias)))).collect();
                let rn = self.d.quote("orm_rn");
                sb = format!("SELECT {} FROM ({sb}) AS {w} WHERE {w}.{rn} <= {per_parent} ORDER BY {}, {w}.{rn}", cols.join(", "), keys.join(", "));
            } else {
                sb.push_str(&self.render_order(root, q)?);
                if kind == "one" && rc.is_none() {
                    sb.push_str(&self.d.limit(0, 1));
                } else if let Some(l) = &q.limit {
                    sb.push_str(&self.d.limit(l.offset, l.count));
                }
                if !q.lock.is_empty() {
                    let lock = self
                        .d
                        .row_lock(&q.lock)
                        .ok_or_else(|| err(codes::CAPABILITY_UNSUPPORTED, format!("{} row lock {:?} is not supported", self.d.name(), q.lock)))?;
                    sb.push_str(lock);
                }
            }
        }
        b.checked()?;
        let mut st = Step { role: "main".into(), sql: sb, tables: b.tables(), lock: q.lock.clone(), bind_slots: b.binds, ..Default::default() };
        if kind == "count" && !steps.is_empty() {
            st.role = "count".into();
        } else if let Some(rc) = rc {
            st.role = "relation".into();
            st.parent = Some(ParentRef { step: rc.parent_step as u32, keys: rc.parent_keys.clone(), if_parent: rc.if_parent.clone() });
        }
        let id = steps.len();
        steps.push(st);
        if rows {
            self.relation_steps(steps, root, &mut asm, id)?;
            steps[id].assemble = Some(Arc::new(asm.finish()));
        }
        Ok(id)
    }

    /// Builds a step per relation of s and of its joins, and records how the
    /// rows attach.
    fn relation_steps(&self, steps: &mut Vec<Step>, s: &Scope<'_>, asm: &mut Asm, step_id: usize) -> Result<()> {
        for r in &s.q.relations {
            let parent_keys: Vec<String> = r.keys.iter().map(|k| k.left.clone()).collect();
            let child_keys: Vec<String> = r.keys.iter().map(|k| k.right.clone()).collect();
            let (kind, target) = (r.kind.clone(), self.entity(&r.query.entity)?);
            let if_parent = match &r.query.if_parent {
                Some(ip) => Some(IfParent { column: ip.column.clone(), index: asm.index_of(&ip.column)?, param: ip.p }),
                None => None,
            };
            let rc = RelCtx { parent_step: step_id, parent_keys: asm.key_refs(&parent_keys)?, if_parent, child_keys: child_keys.clone(), kind: kind.clone() };
            let id = self.select_step(steps, &r.query, "all", "", Some(&rc))?;
            let child_asm = steps[id].assemble.clone().ok_or_else(|| err(codes::INTERNAL, "relation step without assembly"))?;
            let key = if !r.query.key_by.is_empty() {
                key_refs_of(&child_asm, std::slice::from_ref(&r.query.key_by))?
            } else {
                key_refs_of(&child_asm, &self.entity(&child_asm.entity)?.primary_key)?
            };
            asm.children.push(Ch {
                child: Child {
                    rel: r.rel.clone(),
                    kind,
                    step: id as u32,
                    parent_keys: rc.parent_keys,
                    child_keys: key_refs_of(&child_asm, &child_keys)?,
                    key,
                    flatten: r.query.flatten,
                    // owned when the target holds the foreign key
                    cascade: !r.query.no_cascade_delete && parent_keys == s.ent.primary_key && child_keys != target.primary_key,
                    assemble: None,
                },
                asm: None,
            });
        }
        for j in &s.q.joins {
            let js = s.join(&j.rel).expect("scoped join");
            for ch in asm.children.iter_mut() {
                if ch.child.kind == "join" && ch.child.rel == j.rel {
                    if let Some(child) = ch.asm.as_mut() {
                        self.relation_steps(steps, js, child, step_id)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn render_order(&self, s: &Scope<'_>, q: &ir::Query) -> Result<String> {
        if q.order.is_empty() {
            return Ok(String::new());
        }
        let mut parts = Vec::with_capacity(q.order.len());
        for o in &q.order {
            if o.random {
                parts.push(self.d.random().to_owned());
                continue;
            }
            let col = match &o.r#fn {
                Some(f) => self.column_function(s, &o.column, f)?,
                None => self.qcol(s, &o.column),
            };
            // A NOT NULL column keeps its btree order; one that can be NULL sorts NULL first ascending and last descending.
            let nulls = if s.ent.field(&o.column).is_some_and(|f| f.nullable) { self.d.nulls_order(o.desc) } else { "" };
            parts.push(format!("{col} {}{nulls}", if o.desc { "DESC" } else { "ASC" }));
        }
        Ok(format!(" ORDER BY {}", parts.join(", ")))
    }

    fn render_group_by(&self, s: &Scope<'_>, q: &ir::Query) -> Result<String> {
        Ok(q.group_by.iter().map(|g| self.qcol(s, g)).collect::<Vec<_>>().join(", "))
    }

    /// The grouped columns and row_count of a grouped count.
    fn select_group_count_list(&self, s: &Scope<'_>, sb: &mut String, asm: &mut Asm, out_names: &mut Vec<String>) -> Result<()> {
        let mut push = |sb: &mut String, expr: String, name: &str, col: OutCol, asm: &mut Asm| {
            if !asm.columns.is_empty() {
                sb.push_str(", ");
            }
            let out = format!("{}__{name}", s.alias);
            sb.push_str(&format!("{expr} AS {}", self.d.quote(&out)));
            out_names.push(out);
            asm.columns.push(OutCol { index: asm.columns.len(), ..col });
        };
        for name in &s.q.group_by {
            let col = s.ent.field(name).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{name}", s.ent.name)))?;
            let expr = self.d.read_expr(&self.qcol(s, name), col.ty, &self.read_sql_styles(&col.codec));
            let out =
                OutCol { name: name.clone(), column: name.clone(), typ: col.ty.name().into(), styles: self.client_styles(&col.codec), ..Default::default() };
            push(sb, expr, name, out, asm);
        }
        push(sb, "COUNT(*)".into(), "row_count", OutCol { name: "row_count".into(), typ: "i64".into(), ..Default::default() }, asm);
        Ok(())
    }

    /// The projection of a scope and its joins; join columns become join children.
    fn select_list(&self, b: &mut Builder, s: &Scope<'_>, sb: &mut String, asm: &mut Asm, out_names: &mut Vec<String>) -> Result<()> {
        let cols = self.projection(s)?;
        let mut has_aes = false;
        let mut first = out_names.is_empty();
        let mut sep = |sb: &mut String| {
            if !first {
                sb.push_str(", ");
            }
            first = false;
        };
        for c in cols {
            let mut col = s.ent.field(&c.column);
            if col.map(Field::aes).unwrap_or(false) {
                has_aes = true;
            }
            sep(sb);
            let mut styles = Vec::new();
            let mut typ = "varchar".to_owned();
            let expr = match c.kind {
                OutKind::Fn(f) => {
                    let e = self.column_function(s, &c.column, f)?;
                    typ = function_type(&f.name, col);
                    col = None;
                    e
                }
                OutKind::Sub(sub) => {
                    let e = self.sub_select(b, s, sub)?;
                    typ = self.sub_type(sub)?;
                    format!("({e})")
                }
                OutKind::Column => {
                    let col = col.ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{}", s.ent.name, c.column)))?;
                    styles = self.client_styles(&col.codec);
                    self.d.read_expr(&self.qcol(s, &c.column), col.ty, &self.read_sql_styles(&col.codec))
                }
            };
            let out = format!("{}__{}", s.alias, c.name);
            sb.push_str(&format!("{expr} AS {}", self.d.quote(&out)));
            out_names.push(out);
            if let Some(col) = col {
                typ = col.ty.name().to_owned();
            }
            asm.columns.push(OutCol { index: out_names.len() - 1, name: c.name, column: c.column, typ, styles, hidden: false });
        }
        if has_aes {
            let version = s
                .ent
                .aes_version
                .as_deref()
                .and_then(|name| s.ent.field(name))
                .ok_or_else(|| err(codes::SCHEMA_INVALID, format!("{}: AES column requires the aes_version setting", s.ent.name)))?;
            // If there is a selected version column, it is used; only when there is none is a hidden one read.
            asm.aes_version = asm.columns.iter().position(|c| c.column == version.name && c.styles.is_empty());
            if asm.aes_version.is_none() {
                sep(sb);
                let out = format!("{}__{}", s.alias, version.name);
                sb.push_str(&format!("{} AS {}", self.qcol(s, &version.name), self.d.quote(&out)));
                out_names.push(out);
                asm.aes_version = Some(asm.columns.len());
                asm.columns.push(OutCol {
                    index: out_names.len() - 1,
                    name: version.name.clone(),
                    column: version.name.clone(),
                    typ: version.ty.name().into(),
                    styles: Vec::new(),
                    hidden: true,
                });
            }
        }
        for j in &s.q.joins {
            let js = s.join(&j.rel).expect("scoped join");
            let mut child = Asm { entity: js.ent.name.clone(), alias: js.alias.clone(), ..Default::default() };
            self.select_list(b, js, sb, &mut child, out_names)?;
            asm.children.push(Ch { child: Child { rel: j.rel.clone(), kind: "join".into(), ..Default::default() }, asm: Some(child) });
        }
        asm.key = asm.key_refs(&s.ent.primary_key)?;
        Ok(())
    }

    /// Resolves the column mode, additions, and removals into an ordered list.
    fn projection<'q>(&self, s: &Scope<'q>) -> Result<Vec<OutItem<'q>>> {
        let c = s.q.columns.as_ref();
        let mode = c.map(|c| c.mode.as_str()).unwrap_or("");
        let mut base: Vec<String> = s
            .ent
            .fields
            .iter()
            .filter(|col| match mode {
                "all" => true,
                "none" => col.primary_key || col.foreign_key,
                _ => !col.select_explicit,
            })
            .map(|col| col.name.clone())
            .collect();
        fn add(base: &mut Vec<String>, x: &str) {
            if !base.iter().any(|b| b == x) {
                base.push(x.to_owned());
            }
        }
        if let Some(c) = c {
            for a in &c.add {
                add(&mut base, a);
            }
            if !c.remove.is_empty() {
                base.retain(|x| !c.remove.contains(x) || s.ent.field(x).map(|col| col.primary_key).unwrap_or(false));
            }
        }
        for x in &s.extra {
            add(&mut base, x);
        }
        for r in &s.q.relations {
            for k in &r.keys {
                add(&mut base, &k.left);
            }
            if let Some(ip) = &r.query.if_parent {
                add(&mut base, &ip.column);
            }
        }
        for pk in &s.ent.primary_key {
            if !base.contains(pk) {
                base.insert(0, pk.clone());
            }
        }
        let mut out: Vec<OutItem<'q>> = base.into_iter().map(|x| OutItem { name: x.clone(), column: x, kind: OutKind::Column }).collect();
        if let Some(c) = c {
            for (name, f) in &c.r#fn {
                out.push(OutItem { name: name.clone(), column: f.column.clone(), kind: OutKind::Fn(&f.r#fn) });
            }
            for (name, sub) in &c.sub {
                out.push(OutItem { name: name.clone(), column: String::new(), kind: OutKind::Sub(sub) });
            }
        }
        Ok(out)
    }

    fn render_joins(&self, b: &mut Builder, root: &Scope<'_>, s: &Scope<'_>, sb: &mut String) -> Result<()> {
        for j in &s.q.joins {
            let js = s.join(&j.rel).expect("scoped join");
            let kw = if j.kind == "left" { " LEFT JOIN " } else { " INNER JOIN " };
            let mut condition = format!("{} = {}", self.qcol(s, &j.left), self.qcol(js, &j.right));
            // A joined entity's soft-deleted rows never meet the parent: the condition sits in ON, so a left join gives null.
            if let Some(soft_delete) = &js.ent.soft_delete {
                condition.push_str(&format!(" AND {} IS NULL", self.qcol(js, soft_delete)));
            }
            sb.push_str(&format!("{kw}{} AS {} ON {condition}", b.table(&js.ent.table), self.d.quote(&js.alias)));
            if let Some(on) = j.query.on.as_ref().filter(|g| !g.items.is_empty()) {
                let on = self.render_group(b, root, js, on, true)?;
                sb.push_str(" AND ");
                sb.push_str(&on);
            }
            self.render_joins(b, root, js, sb)?;
        }
        Ok(())
    }

    /// Appends the where group of each join child that no group places.
    fn collect_join_where(&self, b: &mut Builder, root: &Scope<'_>, s: &Scope<'_>, where_: &mut Vec<String>) -> Result<()> {
        let mut placed = Vec::new();
        if let Some(w) = &s.q.where_ {
            placed_joins(w, &mut placed);
        }
        for j in &s.q.joins {
            let js = s.join(&j.rel).expect("scoped join");
            if has_where(&j.query.where_) && !placed.contains(&j.rel) {
                where_.push(self.render_group(b, root, js, j.query.where_.as_ref().unwrap(), false)?);
            }
            self.collect_join_where(b, root, js, where_)?;
        }
        Ok(())
    }

    /// Renders a group; `top` omits the outer parentheses.
    fn render_group(&self, b: &mut Builder, root: &Scope<'_>, s: &Scope<'_>, g: &ir::Group, top: bool) -> Result<String> {
        let mut parts = Vec::new();
        for (i, it) in g.items.iter().enumerate() {
            let (conn, text) = match it {
                ir::Item::Pred { pred } => (&pred.conn, self.render_pred(b, root, s, pred)?),
                ir::Item::Group { group } => (&group.conn, self.render_group(b, root, s, group, false)?),
                ir::Item::Joined { joined } => {
                    let js = s.join(&joined.join).ok_or_else(|| err(codes::ENTITY_NOT_JOINED, format!("{} is not joined in this statement", joined.join)))?;
                    let w = js.q.where_.as_ref().ok_or_else(|| err(codes::IR_INVALID, format!("joined {} has no conditions", joined.join)))?;
                    (&joined.conn, self.render_group(b, root, js, w, false)?)
                }
            };
            if i > 0 {
                parts.push(if conn == "or" { "OR".to_owned() } else { "AND".to_owned() });
            }
            parts.push(text);
        }
        let out = parts.join(" ");
        let grouped = if top { out } else { format!("({out})") };
        Ok(if g.not { format!("NOT {grouped}") } else { grouped })
    }

    fn render_pred(&self, b: &mut Builder, root: &Scope<'_>, s: &Scope<'_>, pr: &ir::Pred) -> Result<String> {
        let p = || pr.p.ok_or_else(|| err(codes::IR_INVALID, format!("{} {}.{} needs a value (p)", pr.op, s.ent.name, pr.column)));
        match pr.op.as_str() {
            "tuple_in" | "tuple_not_in" => {
                let cols = self.qualified(s, &pr.cols);
                let mut rows = Vec::new();
                for chunk in pr.ps.chunks(pr.cols.len()) {
                    let mut row = Vec::with_capacity(chunk.len());
                    for (k, name) in pr.cols.iter().enumerate() {
                        let col = s.ent.field(name).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{name}", s.ent.name)))?;
                        row.push(self.render_value(b, col, chunk[k]));
                    }
                    rows.push(row);
                }
                return Ok(self.d.tuple_in(&cols, &rows, pr.op == "tuple_not_in"));
            }
            "fulltext" | "fulltext_boolean" => {
                let cols = self.qualified(s, &pr.cols);
                let i = p()?;
                let sql = self.d.fulltext(&cols, &mut |t| b.transformed(i, t), pr.op == "fulltext_boolean");
                return sql.ok_or_else(|| err(codes::OPERATOR_NOT_ALLOWED, format!("{} on {}", pr.op, s.ent.name)));
            }
            _ => {}
        }
        let col = s.ent.field(&pr.column).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{}", s.ent.name, pr.column)))?;
        let mut lhs = self.qcol(s, &pr.column);
        if let Some(sub) = &pr.sub {
            let inner = self.sub_select(b, s, sub)?;
            let op = if pr.op == "not_in" { " NOT IN " } else { " IN " };
            return Ok(format!("{lhs}{op}({inner})"));
        }
        if let Some(v) = &pr.value {
            let first = v.ps.first().copied();
            let cell = std::cell::RefCell::new(&mut *b);
            let mut arg = || match first {
                Some(i) => cell.borrow_mut().param(i, interval_type(&v.name)),
                None => String::new(),
            };
            // A clock that the ORM compares keeps six fraction digits; a datetime(p < 6) column
            // compares as its value extended to six digits (docs/spec/protocol.md "Clock").
            let mut now = || cell.borrow_mut().now(6);
            let value = self
                .d
                .value_function(&v.name, &mut arg, &mut now)
                .ok_or_else(|| err(codes::CAPABILITY_UNSUPPORTED, format!("{} is not available on {}", v.name, self.d.name())))?;
            if let (Type::DateTime(p), false) = (col.ty, v.name == "today") {
                lhs = self.d.clock_operand(&lhs, p);
            }
            return Ok(format!("{lhs} {} {value}", cmp(&pr.op)));
        }
        if let Some(f) = &pr.r#fn {
            let fcol = self.column_function(s, &pr.column, f)?;
            let ty = function_type(&f.name, Some(col));
            return Ok(match pr.op.as_str() {
                "in" | "not_in" => {
                    let phs: Vec<String> = pr.ps.iter().map(|i| b.param(*i, &ty)).collect();
                    let op = if pr.op == "not_in" { " NOT IN " } else { " IN " };
                    format!("{fcol}{op}({})", phs.join(", "))
                }
                "between" => {
                    let lo = b.param(pr.ps[0], &ty);
                    let hi = b.param(pr.ps[1], &ty);
                    format!("{fcol} BETWEEN {lo} AND {hi}")
                }
                _ => format!("{fcol} {} {}", cmp(&pr.op), b.param(p()?, &ty)),
            });
        }
        let op = pr.op.as_str();
        Ok(match op {
            "eq" | "not_eq" | "gt" | "gte" | "lt" | "lte" => {
                if col.aes() {
                    if op != "eq" && op != "not_eq" {
                        return Err(err(codes::OPERATOR_NOT_ALLOWED, "AES columns support only equality through a declared blind index"));
                    }
                    lhs = self.blind_lhs(s, col)?;
                    let rhs = self.blind_value(b, self.blind_index(s, col)?, p()?);
                    return Ok(format!("{lhs} {} {rhs}", cmp(op)));
                }
                let rhs = self.render_value(b, col, p()?);
                format!("{lhs} {} {rhs}", cmp(op))
            }
            "eq_col" | "not_eq_col" | "gt_col" | "gte_col" | "lt_col" | "lte_col" => {
                let r = pr.r#ref.as_ref().ok_or_else(|| err(codes::IR_INVALID, format!("{op} needs ref")))?;
                let rs = self.resolve_path(root, &r.path)?;
                if rs.ent.field(&r.column).is_none() {
                    return Err(err(codes::COLUMN_UNKNOWN, format!("{}.{}", rs.ent.name, r.column)));
                }
                format!("{lhs} {} {}", cmp(op.trim_end_matches("_col")), self.qcol(rs, &r.column))
            }
            "in" | "not_in" => {
                let index = if col.aes() {
                    lhs = self.blind_lhs(s, col)?;
                    Some(self.blind_index(s, col)?)
                } else {
                    None
                };
                let phs: Vec<String> = pr
                    .ps
                    .iter()
                    .map(|i| match index {
                        Some(index) => self.blind_value(b, index, *i),
                        None => self.render_value(b, col, *i),
                    })
                    .collect();
                format!("{lhs} {} ({})", if op == "not_in" { "NOT IN" } else { "IN" }, phs.join(", "))
            }
            "between" => {
                let lo = self.render_value(b, col, pr.ps[0]);
                let hi = self.render_value(b, col, pr.ps[1]);
                format!("{lhs} BETWEEN {lo} AND {hi}")
            }
            "is_null" => format!("{lhs} IS NULL"),
            "is_not_null" => format!("{lhs} IS NOT NULL"),
            "contains" => {
                let ph = b.col_param(p()?, col, "like_contains");
                self.d.like(&lhs, &ph)
            }
            "contains_binary" => {
                let i = p()?;
                self.d.contains_binary(&lhs, &mut |t| b.col_param(i, col, t))
            }
            _ => return Err(err(codes::OPERATOR_UNKNOWN, op.to_owned())),
        })
    }

    fn blind_lhs(&self, s: &Scope<'_>, col: &Field) -> Result<String> {
        let index = col
            .blind_index
            .as_ref()
            .ok_or_else(|| err(codes::IR_INVALID, format!("{}.{} requires a declared blind index for equality search", s.ent.name, col.name)))?;
        Ok(self.qcol(s, index))
    }

    /// The blind index column of the AES column `col`.
    fn blind_index<'e>(&self, s: &Scope<'e>, col: &Field) -> Result<&'e Field> {
        let index = col
            .blind_index
            .as_ref()
            .ok_or_else(|| err(codes::IR_INVALID, format!("{}.{} requires a declared blind index for equality search", s.ent.name, col.name)))?;
        self.column_of(s.ent, index)
    }

    /// Binds plaintext for executor-side keyed hashing; the type is the blind index column's.
    fn blind_value(&self, b: &mut Builder, index: &Field, i: usize) -> String {
        b.slot(BindSlot { from: "param".into(), param: i, host_styles: vec!["blind_index".into()], col_type: index.ty.name().into(), ..Default::default() })
    }

    /// Binds one value, wrapped in the SQL-side stages of the column; the
    /// stages the dialect leaves to the executor are recorded on the slot.
    fn render_value(&self, b: &mut Builder, col: &Field, i: usize) -> String {
        let styles = self.sql_styles(&col.codec);
        let host: Vec<String> = col.codec.iter().filter(|s| matches!(s.as_str(), "aes" | "hex" | "ip") && !self.d.handles_style(s)).cloned().collect();
        // The type of the value a SQL-side style function wraps is the type of that function's input.
        let ph = match styles.first() {
            None => b.col_param(i, col, ""),
            Some(style) => b.param(i, style_input_type(style)),
        };
        b.binds.last_mut().expect("the slot just added").host_styles = host;
        self.d.write_expr(ph, col.ty, &styles)
    }

    fn resolve_path<'s>(&self, root: &'s Scope<'s>, path: &str) -> Result<&'s Scope<'s>> {
        if path == "^" {
            return root.outer.ok_or_else(|| err(codes::IR_INVALID, "^ reference outside a subquery"));
        }
        let mut cur = root;
        if path.is_empty() {
            return Ok(cur);
        }
        for seg in path.split('/') {
            cur = cur.join(seg).ok_or_else(|| err(codes::ENTITY_NOT_JOINED, format!("{}.{seg}", cur.ent.name)))?;
        }
        Ok(cur)
    }

    fn column_function(&self, s: &Scope<'_>, column: &str, f: &ir::Func) -> Result<String> {
        self.d
            .column_function(&f.name, &self.qcol(s, column))
            .ok_or_else(|| err(codes::CAPABILITY_UNSUPPORTED, format!("{} is not available on {}", f.name, self.d.name())))
    }

    /// A subquery for an IN list or a scalar column; its root gets its own
    /// alias and resolves "^" against `outer`.
    fn sub_select(&self, b: &mut Builder, outer: &Scope<'_>, sub: &ir::Sub) -> Result<String> {
        b.subs += 1;
        let mut root = self.scopes(&sub.query, format!("s{}", b.subs), false)?;
        // Scope is covariant in its lifetime, so the subquery root and `outer` meet at the shorter of their lifetimes.
        root.outer = Some(outer);
        let root = &root;
        let mut sb = String::from("SELECT ");
        match sub.agg.as_str() {
            "sum" => sb.push_str(&format!("COALESCE(SUM({}), 0)", self.qcol(root, &sub.column))),
            "avg" => sb.push_str(&format!("AVG({})", self.qcol(root, &sub.column))),
            "count" => sb.push_str("COUNT(*)"),
            _ => sb.push_str(&self.qcol(root, &sub.column)),
        }
        sb.push_str(&format!(" FROM {} AS {}", b.table(&root.ent.table), self.d.quote(&root.alias)));
        self.render_joins(b, root, root, &mut sb)?;
        let mut where_ = Vec::new();
        if let Some(soft_delete) = &root.ent.soft_delete {
            where_.push(format!("{} IS NULL", self.qcol(root, soft_delete)));
        }
        if let Some(w) = sub.query.where_.as_ref().filter(|g| !g.items.is_empty()) {
            where_.push(self.render_group(b, root, root, w, true)?);
        }
        self.collect_join_where(b, root, root, &mut where_)?;
        if !where_.is_empty() {
            sb.push_str(" WHERE ");
            sb.push_str(&where_.join(" AND "));
        }
        // A scalar column subquery is ordered and limited to one row, which the validator has checked.
        if sub.agg.is_empty() {
            if let Some(l) = &sub.query.limit {
                sb.push_str(&self.render_order(root, &sub.query)?);
                sb.push_str(&self.d.limit(l.offset, l.count));
            }
        }
        Ok(sb)
    }

    fn sub_type(&self, sub: &ir::Sub) -> Result<String> {
        Ok(match sub.agg.as_str() {
            "count" => "i64".into(),
            "avg" => "f64".into(),
            _ => self.entity(&sub.query.entity)?.field(&sub.column).map(|c| c.ty.name().to_owned()).unwrap_or_else(|| "varchar".into()),
        })
    }

    fn table_scope<'a>(&self, ent: &'a Entity, q: &'a ir::Query) -> Result<Scope<'a>>
    where
        'm: 'a,
    {
        self.scopes(q, ent.table.clone(), false)
    }

    fn render_assign(&self, b: &mut Builder, ent: &Entity, col: &Field, a: &ir::Assign) -> Result<String> {
        if blind_index_source(ent, &col.name).is_some() {
            if a.plus_p.is_some() || a.minus_p.is_some() {
                return Err(err(codes::IR_INVALID, "blind index assignment must use its AES source value"));
            }
            if a.null {
                return Ok("NULL".into());
            }
            let start = b.binds.len();
            let sql = self.blind_value(b, col, a.p.unwrap_or_default());
            return Ok(mark_assigned(b, start, col, sql));
        }
        let qualified = || format!("{}.{}", self.d.quote(&ent.table), self.d.quote(&col.name));
        if let Some(i) = a.plus_p {
            // table-qualified: inside ON CONFLICT DO UPDATE a bare name is ambiguous
            return Ok(format!("{} + {}", qualified(), b.col_param(i, col, "")));
        }
        if let Some(i) = a.minus_p {
            let q = qualified();
            let first = b.col_param(i, col, "");
            let second = b.col_param(i, col, "");
            return Ok(format!("CASE WHEN {q} > {first} THEN {q} - {second} ELSE 0 END"));
        }
        if a.null {
            return Ok("NULL".into());
        }
        let p = a.p.ok_or_else(|| err(codes::IR_INVALID, format!("set {}: exactly one of p/null/plus_p/minus_p", a.column)))?;
        let start = b.binds.len();
        let sql = self.render_value(b, col, p);
        Ok(mark_assigned(b, start, col, sql))
    }

    fn column_of<'e>(&self, ent: &'e Entity, name: &str) -> Result<&'e Field> {
        ent.field(name).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{name}", ent.name)))
    }

    fn insert_step(&self, r: &ir::Request) -> Result<Step> {
        let mut b = Builder::new(self.d);
        let ent = self.entity(&r.query.entity)?;
        let set = add_blind_index_assignments(ent, r.set.clone())?;
        validate_aes_assignments(ent, &set, false)?;
        validate_audit_assignment(ent, &set)?;
        validate_required_assignments(ent, &set)?;
        // load writes the row with its stored key as is, so it accepts and requires the identity column value.
        if let Some(identity) = ent.identity.as_deref().filter(|_| r.load) {
            if !set.iter().any(|a| a.column == identity && a.p.is_some()) {
                return Err(err(codes::IR_INVALID, format!("load of {} needs a value for the identity column {identity}", ent.name)));
            }
        }
        let version = aes_version_column(ent);
        let audited = audit_column(ent);
        let mut cols = Vec::new();
        let mut vals = Vec::new();
        for a in &set {
            let col = self.column_of(ent, &a.column)?;
            if col.identity && !r.load {
                return Err(err(codes::IR_INVALID, format!("cannot set identity column {}", a.column)));
            }
            cols.push(self.d.quote(&a.column));
            vals.push(self.render_assign(&mut b, ent, col, a)?);
        }
        // The columns the executor manages are written after the user's assignments, in the order AES key version, audit column,
        // then `default now`.
        let managed = self.managed_insert_columns(ent, &set)?;
        for c in &managed {
            cols.push(self.d.quote(c.column()));
            vals.push(c.value(&mut b));
        }
        let mut sql = format!("INSERT INTO {} ({}) VALUES ({})", b.table(&ent.table), cols.join(", "), vals.join(", "));
        if !r.rows.is_empty() {
            // The rendered columns correspond to the values of r.set. A derived blind index uses the value of the AES source column.
            let mut source = Vec::with_capacity(set.len());
            for (i, a) in set.iter().enumerate() {
                if i < r.set.len() {
                    source.push(i);
                } else {
                    let src = assigned_blind_index_source(ent, &a.column, &r.set)
                        .ok_or_else(|| err(codes::IR_INVALID, format!("no assigned AES source for blind index {}", a.column)))?;
                    let source_index = r.set.iter().position(|x| x.column == src.name).ok_or_else(|| {
                        err(codes::IR_INVALID, format!("assigned AES source {} is missing from insert set", src.name))
                    })?;
                    source.push(source_index);
                }
            }
            for row in &r.rows {
                let mut more = Vec::with_capacity(set.len() + 2);
                for (i, a) in set.iter().enumerate() {
                    let assign = ir::Assign { column: a.column.clone(), p: Some(row[source[i]]), ..Default::default() };
                    more.push(self.render_assign(&mut b, ent, self.column_of(ent, &a.column)?, &assign)?);
                }
                for c in &managed {
                    more.push(c.value(&mut b));
                }
                sql.push_str(&format!(", ({})", more.join(", ")));
            }
            b.checked()?;
            return Ok(Step { role: "main".into(), sql, tables: b.tables(), bind_slots: b.binds, ..Default::default() });
        }
        if !r.on_duplicate.is_empty() {
            let duplicate = add_blind_index_assignments(ent, r.on_duplicate.clone())?;
            validate_aes_assignments(ent, &duplicate, true)?;
            validate_audit_assignment(ent, &duplicate)?;
            let mut sets = Vec::new();
            for a in &duplicate {
                let v = self.render_assign(&mut b, ent, self.column_of(ent, &a.column)?, a)?;
                sets.push(format!("{} = {v}", self.d.quote(&a.column)));
            }
            if !version.is_empty() && assigns_aes(ent, &duplicate) && !assigned(&duplicate, version) {
                sets.push(format!("{} = {}", self.d.quote(version), b.config("aes_version", self.column_of(ent, version)?.ty.name())));
            }
            if !audited.is_empty() {
                sets.push(format!("{} = {}", self.d.quote(audited), b.audit(self.column_of(ent, audited)?, audit_record(ent))));
            }
            if let Some(identity) = ent.identity.as_deref().filter(|_| !self.d.insert_returning_id()) {
                // MySQL: makes the last insert id point to the row that already exists
                let identity = self.d.quote(identity);
                sets.push(format!("{identity} = LAST_INSERT_ID({identity})"));
            }
            sql.push_str(&self.d.upsert(&conflict_target(ent, &set)?, &sets.join(", ")));
        }
        if let Some(identity) = ent.identity.as_deref().filter(|_| self.d.insert_returning_id()) {
            sql.push_str(&format!(" RETURNING {}", self.d.quote(identity)));
        }
        b.checked()?;
        Ok(Step { role: "main".into(), sql, tables: b.tables(), bind_slots: b.binds, ..Default::default() })
    }

    /// Columns an insert writes besides the user's assignments: AES key version, audit column,
    /// and `default now` columns not assigned in a dialect that uses the executor clock (host_now), in field order.
    fn managed_insert_columns<'e>(&self, ent: &'e Entity, set: &[ir::Assign]) -> Result<Vec<Managed<'e>>> {
        let mut out = Vec::new();
        let version = aes_version_column(ent);
        if !version.is_empty() && !assigned(set, version) {
            out.push(Managed::AesVersion(self.column_of(ent, version)?));
        }
        let audited = audit_column(ent);
        if !audited.is_empty() {
            out.push(Managed::Audit(self.column_of(ent, audited)?, audit_record(ent)));
        }
        // The SQLite database clock has only millisecond precision, so for a `default now` column the executor's
        // microsecond clock is used. MySQL and PostgreSQL leave it to the database default.
        if self.d.host_now() {
            for f in &ent.fields {
                if matches!(f.default, Some(FieldDefault::Now)) && !assigned(set, &f.name) {
                    out.push(Managed::Now(f));
                }
            }
        }
        Ok(out)
    }

    /// The statement time that updated and soft delete write to a `datetime(p)` column.
    /// A dialect that uses the executor clock (host_now) binds the clock truncated to the column's fractional digits,
    /// and MySQL uses the database clock via CURRENT_TIMESTAMP(p).
    fn statement_time(&self, b: &mut Builder, col: &Field) -> String {
        if self.d.host_now() {
            b.now(clock_precision(col))
        } else {
            self.d.now(datetime_precision(col).into())
        }
    }

    fn update_step(&self, r: &ir::Request) -> Result<Step> {
        let mut b = Builder::new(self.d);
        let ent = self.entity(&r.query.entity)?;
        let set = add_blind_index_assignments(ent, r.set.clone())?;
        validate_aes_assignments(ent, &set, true)?;
        validate_audit_assignment(ent, &set)?;
        let root = self.table_scope(ent, &r.query)?;
        let mut sets = Vec::new();
        for a in &set {
            let col = self.column_of(ent, &a.column)?;
            let v = self.render_assign(&mut b, ent, col, a)?;
            sets.push(format!("{} = {v}", self.d.quote(&a.column)));
        }
        let version = aes_version_column(ent);
        if !version.is_empty() && assigns_aes(ent, &set) && !assigned(&set, version) {
            sets.push(format!("{} = {}", self.d.quote(version), b.config("aes_version", self.column_of(ent, version)?.ty.name())));
        }
        // The updated time is always written explicitly, so every dialect and optimistic locking behave the same.
        if let Some(updated) = ent.updated.as_deref().filter(|u| !assigned(&r.set, u)) {
            let now = self.statement_time(&mut b, self.column_of(ent, updated)?);
            sets.push(format!("{} = {now}", self.d.quote(updated)));
        }
        let audited = audit_column(ent);
        if !audited.is_empty() {
            sets.push(format!("{} = {}", self.d.quote(audited), b.audit(self.column_of(ent, audited)?, audit_record(ent))));
        }
        let w = r.query.where_.as_ref().filter(|g| !g.items.is_empty()).ok_or_else(|| err(codes::IR_INVALID, "update without where"))?;
        let mut where_ = self.render_group(&mut b, &root, &root, w, true)?;
        if let Some(o) = &r.optimistic {
            let ph = b.col_param(o.p, self.column_of(ent, &o.column)?, "");
            where_.push_str(&format!(" AND {} = {ph}", self.qcol(&root, &o.column)));
        }
        if let Some(soft_delete) = &ent.soft_delete {
            where_.push_str(&format!(" AND {} IS NULL", self.qcol(&root, soft_delete)));
        }
        let sql = format!("UPDATE {} SET {} WHERE {where_}", b.table(&ent.table), sets.join(", "));
        b.checked()?;
        Ok(Step { role: "main".into(), sql, tables: b.tables(), bind_slots: b.binds, ..Default::default() })
    }

    /// If there is a soft delete column, delete is an update that writes that column with the statement time.
    /// A soft delete on an audit target table also writes the audit column.
    fn delete_step(&self, r: &ir::Request) -> Result<Step> {
        let mut b = Builder::new(self.d);
        let ent = self.entity(&r.query.entity)?;
        let root = self.table_scope(ent, &r.query)?;
        let mut sets = Vec::new();
        if let Some(soft_delete) = &ent.soft_delete {
            let now = self.statement_time(&mut b, self.column_of(ent, soft_delete)?);
            sets.push(format!("{} = {now}", self.d.quote(soft_delete)));
            let audited = audit_column(ent);
            if !audited.is_empty() {
                sets.push(format!("{} = {}", self.d.quote(audited), b.audit(self.column_of(ent, audited)?, audit_record(ent))));
            }
        }
        let w = r.query.where_.as_ref().filter(|g| !g.items.is_empty()).ok_or_else(|| err(codes::IR_INVALID, "delete without where"))?;
        let mut where_ = self.render_group(&mut b, &root, &root, w, true)?;
        let sql = match &ent.soft_delete {
            Some(soft_delete) => {
                where_.push_str(&format!(" AND {} IS NULL", self.qcol(&root, soft_delete)));
                format!("UPDATE {} SET {} WHERE {where_}", b.table(&ent.table), sets.join(", "))
            }
            None => format!("DELETE FROM {} WHERE {where_}", b.table(&ent.table)),
        };
        b.checked()?;
        Ok(Step { role: "main".into(), sql, tables: b.tables(), bind_slots: b.binds, ..Default::default() })
    }

    /// An update that reverts one soft-deleted row. restore_key takes a primary key or unique
    /// key from the request's set and where; that key column's set value becomes a condition, and other set values are written to the restored row as new values,
    /// written like an update. Other where conditions narrow the restore. Since only deleted rows are changed, a row that is not deleted and a row that does not exist
    /// change nothing. After that, it writes the AES key version, NULL in the soft delete column, and, for an audit table, the audit
    /// column. It does not write the updated column.
    fn restore_step(&self, r: &ir::Request) -> Result<Step> {
        let ent = self.entity(&r.query.entity)?;
        let parts = super::validate::restore_key(ent, r)?;
        let soft_delete = &parts.soft_delete;
        let set = add_blind_index_assignments(ent, parts.set)?;
        validate_aes_assignments(ent, &set, true)?;
        validate_audit_assignment(ent, &set)?;
        let mut b = Builder::new(self.d);
        let root = self.table_scope(ent, &r.query)?;
        let mut sets = Vec::new();
        for a in &set {
            let col = self.column_of(ent, &a.column)?;
            let v = self.render_assign(&mut b, ent, col, a)?;
            sets.push(format!("{} = {v}", self.d.quote(&a.column)));
        }
        let version = aes_version_column(ent);
        if !version.is_empty() && assigns_aes(ent, &set) {
            sets.push(format!("{} = {}", self.d.quote(version), b.config("aes_version", self.column_of(ent, version)?.ty.name())));
        }
        sets.push(format!("{} = NULL", self.d.quote(soft_delete)));
        let audited = audit_column(ent);
        if !audited.is_empty() {
            sets.push(format!("{} = {}", self.d.quote(audited), b.audit(self.column_of(ent, audited)?, audit_record(ent))));
        }
        let mut where_ = self.render_group(&mut b, &root, &root, &parts.where_, true)?;
        where_.push_str(&format!(" AND {} IS NOT NULL", self.qcol(&root, soft_delete)));
        let sql = format!("UPDATE {} SET {} WHERE {where_}", b.table(&ent.table), sets.join(", "));
        b.checked()?;
        Ok(Step { role: "main".into(), sql, tables: b.tables(), bind_slots: b.binds, ..Default::default() })
    }

    /// The statement that restarts an entity's identity from the value after the table's largest key: the next generated
    /// key is the largest key plus 1, or 1 for an empty table. It runs after rows are loaded with explicit keys via load.
    fn restart_identity_step(&self, r: &ir::Request) -> Result<Step> {
        let ent = self.entity(&r.query.entity)?;
        let Some(identity) = ent.identity.as_deref() else {
            return Err(err(codes::IR_INVALID, format!("restart_identity of {}, which has no identity column", ent.name)));
        };
        let mut b = Builder::new(self.d);
        b.table(&ent.table);
        Ok(Step { role: "main".into(), sql: self.d.restart_identity(&ent.table, identity), tables: b.tables(), ..Default::default() })
    }
}

/// For each insert, the columns the executor supplies values for, and their bind slots.
enum Managed<'e> {
    AesVersion(&'e Field),
    /// The audit column and its audit record entity.
    Audit(&'e Field, &'e str),
    Now(&'e Field),
}

impl Managed<'_> {
    fn column(&self) -> &str {
        match self {
            Managed::AesVersion(f) | Managed::Audit(f, _) | Managed::Now(f) => &f.name,
        }
    }

    fn value(&self, b: &mut Builder) -> String {
        match self {
            Managed::AesVersion(f) => b.config("aes_version", f.ty.name()),
            Managed::Audit(f, record) => b.audit(f, record),
            Managed::Now(f) => b.now(clock_precision(f)),
        }
    }
}

enum OutKind<'q> {
    Column,
    Fn(&'q ir::Func),
    Sub(&'q ir::Sub),
}

struct OutItem<'q> {
    name: String,
    column: String,
    kind: OutKind<'q>,
}
